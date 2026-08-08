/* ============================================================
   Agentline — intent packs and the guardrail engine.

   There is no model anywhere in this file. Every reply is produced by
   matching the question against a list of regular expressions and then
   reading the app's own demo records. The guardrail engine wraps each
   intent so that toggling a rule in the Guardrails screen visibly
   changes what comes back.

   Pipeline for one turn:
     topic check -> escalation check -> tool availability ->
     intent answer -> PII redaction -> cost ceiling -> telemetry + run
   ============================================================ */

import { Assistant } from '../lib/assistant.js';
import { num, pct, ago, fmtDate, money } from '../lib/ui.js';
import {
  guardActive, toolById, guardById, agentById,
  estimateCost, rupees, newRunId, ONBOARD_STEPS,
} from './data.js';

/* ---------- small helpers ---------- */
const T = (head, rows) => ({ head, rows });
const byId = (arr, id) => arr.find((x) => x.id === id);
const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
const sortDesc = (arr, f) => [...arr].sort((a, b) => f(b) - f(a));
const countBy = (arr, f) => arr.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});
const pctOf = (a, b) => (b ? (a / b) * 100 : 0);

/* ---------- redaction ---------- */
const RE_EMAIL = /([a-z0-9._%+-]{1,64})@([a-z0-9.-]+)\.([a-z]{2,12})/gi;
const RE_PHONE = /(\+\d{1,3}\s?\d{2})(\d{4,10})/g;
const RE_ACCT = /\b(\d{4})(\d{5,})\b/g;

export function redactText(str) {
  let n = 0;
  const out = String(str ?? '')
    .replace(RE_EMAIL, (m, a, b, c) => { n++; return `${a.slice(0, 2)}•••@•••.${c}`; })
    .replace(RE_PHONE, (m, a, b) => { n++; return `${a}${'•'.repeat(Math.min(8, b.length))}`; })
    .replace(RE_ACCT, (m, a, b) => { n++; return `${a}${'•'.repeat(b.length)}`; });
  return { out, n };
}

function redactOut(out) {
  let n = 0;
  const text = redactText(out.text || '');
  n += text.n;
  const res = { ...out, text: text.out };
  if (out.table) {
    res.table = {
      head: out.table.head,
      rows: out.table.rows.map((r) => r.map((c) => { const g = redactText(c); n += g.n; return g.out; })),
    };
  }
  return { out: res, n };
}

/* ---------- token + cost estimate for one turn ---------- */
function estimateTurn(agent, question, answerText, toolCalls) {
  const tokensIn = Math.round(320 + question.length * 1.6 + toolCalls * (agent.avgTokens.in / 3));
  const tokensOut = Math.round(40 + String(answerText || '').length / 3.4);
  return { tokensIn, tokensOut, costPaise: estimateCost(tokensIn, tokensOut) };
}

/* ============================================================
   Guardrail wrapper
   ============================================================ */
function wrapIntent(intent, agent, store, emit) {
  const baseAnswer = intent.answer;
  const answer = (q, ctx) => {
      const s = store.state;
      const events = [];
      const verdicts = [];
      const ev = (label, kind, status, ms, detail) => { events.push({ label, kind, status, ms, detail }); };
      const jitter = (a, b) => a + Math.round(Math.random() * (b - a));

      ev('Request accepted', 'system', 'ok', jitter(3, 12), `model ${agent.model} · streaming ${s.settings.streaming ? 'on' : 'off'}`);

      const needTools = intent.tools || [];
      let out = null;
      let status = 'success';
      let toolCalls = 0;

      /* 1 — allowed topics */
      const gTopics = guardById(s, 'topics');
      if (guardActive(s, agent, 'topics')) {
        const hit = (gTopics.blocked || []).find((w) => q.toLowerCase().includes(w));
        if (hit) {
          ev('Guardrail: allowed topics', 'guardrail', 'blocked', jitter(2, 8), `term "${hit}" is outside the topic list`);
          verdicts.push({ id: 'topics', verdict: 'blocked', detail: `blocked term "${hit}"` });
          status = 'blocked';
          out = {
            text: `I can't take that one. **Allowed topics** is on for this agent and "${hit}" is outside the approved list.\n\nThe list is currently: ${gTopics.topics.join(', ')}. Ask me anything inside it and I will pull the live records.\n\nIf you want to see what I would have said, switch the rule off in **Guardrails**.`,
          };
        } else {
          ev('Guardrail: allowed topics', 'guardrail', 'ok', jitter(2, 8), 'question is on-topic');
          verdicts.push({ id: 'topics', verdict: 'passed', detail: 'on-topic' });
        }
      } else if (agent.guardrails.includes('topics')) {
        verdicts.push({ id: 'topics', verdict: 'off', detail: 'rule disabled' });
      }

      /* 2 — escalation to a human */
      const gEsc = guardById(s, 'escalate');
      let escalatedNote = '';
      if (!out && agent.guardrails.includes('escalate')) {
        const trigger = (gEsc.triggers || []).find((w) => q.toLowerCase().includes(w));
        if (trigger && guardActive(s, agent, 'escalate')) {
          const ref = `ESC-${s.counters.escalationSeq + 1}`;
          ev('Guardrail: escalation', 'guardrail', 'escalated', jitter(4, 14), `trigger "${trigger}" → ${gEsc.queue}`);
          verdicts.push({ id: 'escalate', verdict: 'escalated', detail: `trigger "${trigger}"` });
          status = 'escalated';
          out = {
            text: `I'm handing this to a person. The word **"${trigger}"** matches an escalation trigger, so I stop rather than answer.\n\n- Queue: ${gEsc.queue}\n- Reference: \`${ref}\`\n- Handover note: the full question, the agent used (${agent.name}) and the records I had already opened.\n\nTurn **Escalation to human** off in Guardrails if you want me to attempt it myself.`,
          };
        } else if (trigger) {
          escalatedNote = '\n\n_Escalation to human is switched off, so I answered this myself instead of passing it to the desk._';
          verdicts.push({ id: 'escalate', verdict: 'off', detail: `trigger "${trigger}" ignored` });
          ev('Guardrail: escalation', 'guardrail', 'skipped', jitter(2, 6), 'rule disabled — answering directly');
        } else {
          verdicts.push({ id: 'escalate', verdict: 'passed', detail: 'no trigger words' });
        }
      }

      /* 3 — tool availability */
      if (!out && needTools.length) {
        for (const tid of needTools) {
          const tool = toolById(s, tid);
          if (!tool) continue;
          if (!tool.connected) {
            ev(`${tid}.call`, 'tool', 'failed', jitter(8, 30), 'connection is off');
            status = 'failed';
            out = {
              text: `I need the **${tool.name}** connection for that and it is disconnected right now.\n\n${tool.description}\n\nTurn it back on in **Tools & connections** and ask me again. Without it I can still answer anything that only needs ${agent.tools.filter((x) => x !== tid).map((x) => (toolById(s, x) || {}).name).filter(Boolean).join(' or ') || 'my own run history'}.`,
              };
            break;
          }
          toolCalls++;
          ev(`${tool.id}.${(tool.ops[0] || 'read')}`, 'tool', 'ok', jitter(Math.round(tool.latencyMs * 0.6), Math.round(tool.latencyMs * 1.4)), `${tool.name} responded`);
        }
      }

      /* 4 — the intent itself */
      if (!out) {
        ev('Plan', 'agent', 'ok', jitter(40, 160), `matched intent ${intent.id}`);
        try {
          out = baseAnswer(q, { ...ctx, state: s, agent });
        } catch (err) {
          status = 'failed';
          out = { text: 'That question walked off the edge of the demo data set. Try one of the suggestions below.' };
        }
        if (typeof out === 'string') out = { text: out };
        out = out || { text: 'I have nothing for that one.' };
        if (escalatedNote) out = { ...out, text: (out.text || '') + escalatedNote };
        ev('Compose answer', 'agent', 'ok', jitter(180, 620), `${String(out.text || '').length} characters`);
      }

      /* 5 — PII redaction */
      if (agent.guardrails.includes('pii')) {
        if (guardActive(s, agent, 'pii')) {
          const r = redactOut(out);
          out = r.out;
          ev('Guardrail: PII redaction', 'guardrail', r.n ? 'redacted' : 'ok', jitter(2, 9),
            r.n ? `${r.n} value${r.n === 1 ? '' : 's'} masked` : 'nothing to mask');
          verdicts.push({ id: 'pii', verdict: r.n ? 'redacted' : 'passed', detail: r.n ? `${r.n} masked` : 'clean' });
        } else {
          verdicts.push({ id: 'pii', verdict: 'off', detail: 'contact details shown in full' });
          ev('Guardrail: PII redaction', 'guardrail', 'skipped', jitter(1, 4), 'rule disabled');
        }
      }

      /* 6 — cost ceiling */
      const est = estimateTurn(agent, q, out.text, toolCalls);
      const gCost = guardById(s, 'cost');
      if (agent.guardrails.includes('cost')) {
        if (guardActive(s, agent, 'cost')) {
          if (est.costPaise > gCost.limitPaise) {
            const first = String(out.text || '').split(/\n{2,}/)[0];
            out = {
              ...out,
              table: null,
              text: `${first}\n\n**Stopped here.** This run was estimated at ${rupees(est.costPaise)} and the ceiling is ${rupees(gCost.limitPaise)} — the rest of the answer was not composed. Raise the limit in **Guardrails** to see the whole thing.`,
            };
            status = 'blocked';
            ev('Guardrail: cost ceiling', 'guardrail', 'blocked', jitter(2, 6), `${rupees(est.costPaise)} over ${rupees(gCost.limitPaise)}`);
            verdicts.push({ id: 'cost', verdict: 'blocked', detail: `${rupees(est.costPaise)} > ${rupees(gCost.limitPaise)}` });
          } else {
            ev('Guardrail: cost ceiling', 'guardrail', 'ok', jitter(1, 5), `${rupees(est.costPaise)} of ${rupees(gCost.limitPaise)}`);
            verdicts.push({ id: 'cost', verdict: 'passed', detail: `${rupees(est.costPaise)} of ${rupees(gCost.limitPaise)}` });
          }
        } else {
          verdicts.push({ id: 'cost', verdict: 'off', detail: 'no ceiling applied' });
        }
      }

      const latencyMs = events.reduce((a, e) => a + e.ms, 0);
      ev('Response streamed', 'system', status === 'success' ? 'ok' : status, jitter(20, 90), `${est.tokensOut} tokens out`);

      const tel = {
        runId: newRunId(),
        agentId: agent.id, agentName: agent.name, model: agent.model,
        question: q, intent: intent.id,
        events, verdicts, status,
        tokensIn: est.tokensIn, tokensOut: est.tokensOut, costPaise: est.costPaise,
        latencyMs, toolCalls,
        startedAt: new Date().toISOString(),
      };
      if (emit) emit(tel);

      const meta = `${intent.trace || 'read the workspace records'} · ${num(est.tokensIn)} in / ${num(est.tokensOut)} out · ${rupees(est.costPaise)}`;
      return {
        ...out,
        meta,
        then: () => {
          store.update((st) => {
            st.runs.unshift({
              id: tel.runId, agentId: agent.id, workflowId: null, trigger: 'Playground',
              status, startedAt: tel.startedAt, durationMs: latencyMs,
              tokensIn: est.tokensIn, tokensOut: est.tokensOut, costPaise: est.costPaise,
              question: q,
              guardrails: verdicts.map((v) => ({ id: v.id, verdict: v.verdict })),
              trace: events,
            });
            st.runs = st.runs.slice(0, 90);
            if (status === 'escalated') st.counters.escalationSeq += 1;
          });
        },
      };
  };
  /* copy descriptors so a getter-backed `match` stays dynamic */
  const wrapped = Object.create(Object.getPrototypeOf(intent), Object.getOwnPropertyDescriptors(intent));
  wrapped.answer = answer;
  return wrapped;
}

/* ============================================================
   Shared intents — every agent gets these five
   ============================================================ */
function sharedIntents(agent) {
  return [
    {
      id: 'self', match: [/what (can|do) you do|who are you|capabilit|your job|introduce/i, 'about you'],
      trace: 'read the agent definition',
      answer: (q, { state }) => ({
        text: `I am **${agent.name}**, running on \`${agent.model}\`.\n\n${agent.description}\n\n- Tools: ${agent.tools.map((t) => (toolById(state, t) || {}).name).join(', ') || 'none wired yet'}\n- Guardrails: ${agent.guardrails.map((g) => (guardById(state, g) || {}).name).join(', ') || 'none bound yet'}\n- Owner: ${agent.owner} · created ${fmtDate(agent.createdAt)}`,
      }),
    },
    {
      id: 'stats', match: [/success rate|how are you doing|your (stats|numbers|performance)|how many runs|reliab/i],
      trace: 'aggregated this agent\'s runs',
      answer: (q, { state }) => {
        const mine = state.runs.filter((r) => r.agentId === agent.id);
        const ok = mine.filter((r) => r.status === 'success').length;
        const avg = mine.length ? Math.round(sum(mine, (r) => r.durationMs) / mine.length) : agent.avgLatencyMs;
        return {
          text: `Over the last 30 days I ran **${num(agent.runs30d)}** times with a **${pct(agent.successRate, 1)}** success rate.\n\nIn the run history held in this workspace I have ${mine.length} runs, ${ok} of them clean, average duration ${num(avg)} ms.`,
          table: T(['Status', 'Runs'], Object.entries(countBy(mine, (r) => r.status)).map(([k, v]) => [k, String(v)])),
        };
      },
    },
    {
      id: 'toolstate', match: [/what tools|which tools|connections?|integrat|what are you connected/i],
      trace: 'checked the connection registry',
      answer: (q, { state }) => ({
        text: `These are the connections wired to me. Disconnect one in **Tools & connections** and the questions that need it start failing straight away.`,
        table: T(['Tool', 'State', 'Calls 30d'], agent.tools.map((t) => {
          const tool = toolById(state, t);
          return [tool.name, tool.connected ? 'connected' : '**disconnected**', num(tool.calls30d)];
        })),
      }),
    },
    {
      id: 'guardstate', match: [/guardrail|what are you not allowed|restrict|rules|policy|safe/i],
      trace: 'read the guardrail set',
      answer: (q, { state }) => ({
        text: `Four rules exist in the workspace. These are the ones attached to me — the rest do not apply to this agent.`,
        table: T(['Guardrail', 'On this agent', 'State'], state.guardrails.map((g) => [
          g.name,
          agent.guardrails.includes(g.id) ? 'yes' : 'no',
          g.enabled ? 'enabled' : '**disabled**',
        ])),
      }),
    },
    {
      id: 'contact', tools: agent.tools.includes('crm') ? ['crm'] : [],
      match: [/contact|email address|phone number|reach (them|him|her)|get in touch|who do i (call|write)/i],
      trace: 'pulled the contact off the record',
      answer: (q, { state }) => {
        let who; let where; let email; let phone = null; let note;
        if (agent.id === 'onboard') {
          const a = state.accounts.find((x) => x.stuckDays >= 5) || state.accounts[0];
          who = a.contact; where = a.name; email = a.email; note = `${a.id}, step ${a.stepIdx + 1} of 6`;
        } else {
          const t = sortDesc(state.tickets.filter((x) => x.status === 'open'), (x) => x.ageH)[0] || state.tickets[0];
          who = t.contact; where = t.customer; email = t.email; phone = t.phone; note = `${t.id}, ${t.ageH}h old`;
        }
        return {
          text: `**${who}** at ${where} — ${email}${phone ? ` · ${phone}` : ''}\n\nSource record: ${note}.\n\nWith **PII redaction** on for this agent those values come back masked. Switch the rule off in Guardrails and ask again to see them in full.`,
        };
      },
    },
    {
      id: 'spend', match: [/cost|spend|token|how much (does|do)|budget|price/i],
      trace: 'summed tokens across my runs',
      answer: (q, { state }) => {
        const mine = state.runs.filter((r) => r.agentId === agent.id);
        const paise = sum(mine, (r) => r.costPaise);
        const tokens = sum(mine, (r) => r.tokensIn + r.tokensOut);
        const cap = guardById(state, 'cost');
        return {
          text: `My ${mine.length} runs in this workspace cost **${rupees(paise)}** in total — ${num(tokens)} tokens, about ${rupees(mine.length ? Math.round(paise / mine.length) : 0)} a run.\n\nThe ceiling rule is ${cap.enabled ? `on at ${rupees(cap.limitPaise)} per run` : 'switched off'}.`,
        };
      },
    },
  ];
}

/* ============================================================
   Per-agent packs
   ============================================================ */

/* ---- Support Triage ---- */
function triagePack() {
  return [
    {
      id: 'queue', tools: ['ticketing'], match: [/queue|backlog|open tickets|how many tickets|inbox|waiting/i],
      trace: 'scanned the inbound queue',
      answer: (q, { state }) => {
        const t = state.tickets;
        const open = t.filter((x) => x.status === 'open');
        const waiting = t.filter((x) => x.status === 'waiting');
        const oldest = sortDesc(open, (x) => x.ageH).slice(0, 5);
        return {
          text: `**${open.length} open**, ${waiting.length} waiting on the customer, ${t.length - open.length - waiting.length} resolved. Oldest five below, sorted by age.`,
          table: T(['Ticket', 'Customer', 'Priority', 'Age'], oldest.map((x) => [x.id, x.customer, x.priority, `${x.ageH}h`])),
        };
      },
    },
    {
      id: 'ticket', tools: ['ticketing', 'crm'], match: [/tck-\d+|ticket \d+|show me a ticket|open a ticket|details of/i],
      trace: 'opened the ticket and the matching CRM record',
      answer: (q, { state }) => {
        const m = q.match(/tck-?(\d+)/i);
        const t = (m && state.tickets.find((x) => x.id.toLowerCase() === `tck-${m[1]}`)) || sortDesc(state.tickets.filter((x) => x.status === 'open'), (x) => x.ageH)[0];
        if (!t) return { text: 'No ticket matched that reference.' };
        return {
          text: `**${t.id} — ${t.subject}**\n\n- Customer: ${t.customer} (${t.contact})\n- Contact: ${t.email} · ${t.phone}\n- Channel: ${t.channel} · category ${t.category}\n- Priority ${t.priority}, sentiment ${t.sentiment}, ${t.ageH}h old\n- Currently with ${t.assignee}\n\nMy read: category **${t.category}**, priority **${t.priority}**, route to the ${t.category.toLowerCase()} desk.`,
        };
      },
    },
    {
      id: 'priority', tools: ['ticketing'], match: [/priorit|urgent|critical|most important|what should i do first/i],
      trace: 'recomputed priority across the queue',
      answer: (q, { state }) => {
        const c = countBy(state.tickets, (x) => x.priority);
        const urgent = state.tickets.filter((x) => x.priority === 'Urgent' || x.priority === 'High');
        return {
          text: `${urgent.length} of ${state.tickets.length} tickets sit at High or Urgent. Priority comes from the wording, the account plan and the age — anything past 60 hours gets pushed up automatically.`,
          table: T(['Priority', 'Tickets'], ['Urgent', 'High', 'Normal', 'Low'].filter((k) => c[k]).map((k) => [k, String(c[k])])),
        };
      },
    },
    {
      id: 'route', tools: ['ticketing', 'crm'], match: [/route|assign|who should|which desk|hand (it )?to|owner/i],
      trace: 'checked desk load and routing rules',
      answer: (q, { state }) => {
        const load = countBy(state.tickets.filter((x) => x.status !== 'resolved'), (x) => x.assignee);
        const rows = sortDesc(Object.entries(load).map(([k, v]) => ({ k, v })), (x) => x.v).slice(0, 5);
        const lightest = rows[rows.length - 1];
        return {
          text: `Routing rule is category first, then load. Billing goes to accounts, Delivery to the depot desk, Account and Product to tier 1, Reporting to the data desk.\n\nLightest queue right now is **${lightest ? lightest.k : 'unassigned'}** with ${lightest ? lightest.v : 0} open items, so that is where I would put the next one.`,
          table: T(['Assignee', 'Open items'], rows.map((r) => [r.k, String(r.v)])),
        };
      },
    },
    {
      id: 'draft', tools: ['ticketing', 'email'], match: [/draft|reply|respond|write (a )?(response|message)|answer the customer/i],
      trace: 'drafted a reply from the ticket and the account record',
      answer: (q, { state }) => {
        const t = sortDesc(state.tickets.filter((x) => x.status === 'open'), (x) => x.ageH)[0];
        return {
          text: `Draft for **${t.id}** (${t.customer}), to ${t.email}. Nothing is sent until a person approves it.\n\n---\n\nHello ${t.contact.split(' ')[0]},\n\nThanks for writing in about "${t.subject.toLowerCase()}". I have your account open in front of me and the request is now with our ${t.category.toLowerCase()} desk at ${t.priority} priority.\n\nWe will come back to you today with a firm answer. Your reference is ${t.id}.\n\n${t.assignee}\nSupport, Anvaya Systems`,
        };
      },
    },
    {
      id: 'themes', tools: ['ticketing'], match: [/theme|common (issue|problem)|what are people (asking|complaining)|categor|pattern/i],
      trace: 'grouped the queue by category',
      answer: (q, { state }) => {
        const c = countBy(state.tickets, (x) => x.category);
        const rows = sortDesc(Object.entries(c).map(([k, v]) => ({ k, v })), (x) => x.v);
        const top = rows[0];
        return {
          text: `**${top.k}** is the biggest theme with ${top.v} of ${state.tickets.length} tickets (${pct(pctOf(top.v, state.tickets.length), 0)}). The wording repeats — most of it is the same three complaints written differently.`,
          table: T(['Category', 'Tickets', 'Share'], rows.map((r) => [r.k, String(r.v), pct(pctOf(r.v, state.tickets.length), 0)])),
        };
      },
    },
    {
      id: 'sla', tools: ['ticketing'], match: [/sla|response time|how fast|first reply|breach|late/i],
      trace: 'measured first reply against the SLA',
      answer: (q, { state }) => {
        const t = state.tickets;
        const avg = Math.round(sum(t, (x) => x.firstReplyMins) / t.length);
        const late = t.filter((x) => x.firstReplyMins > 120);
        return {
          text: `Average first reply is **${avg} minutes**. ${late.length} tickets went past the two hour target, and they are concentrated in ${Object.keys(countBy(late, (x) => x.category)).slice(0, 2).join(' and ') || 'no single category'}.`,
          table: T(['Ticket', 'Category', 'First reply'], sortDesc(late, (x) => x.firstReplyMins).slice(0, 5).map((x) => [x.id, x.category, `${x.firstReplyMins}m`])),
        };
      },
    },
    {
      id: 'customer', tools: ['crm'], match: [/customer|account|who is|which client|worst affected/i],
      trace: 'looked the customer up in the CRM',
      answer: (q, { state }) => {
        const c = countBy(state.tickets, (x) => x.customer);
        const rows = sortDesc(Object.entries(c).map(([k, v]) => ({ k, v })), (x) => x.v).slice(0, 5);
        const worst = rows[0];
        const sample = state.tickets.find((x) => x.customer === worst.k);
        return {
          text: `**${worst.k}** has the most open contact with us — ${worst.v} tickets in the current window. Named contact is ${sample.contact}, ${sample.email}.`,
          table: T(['Customer', 'Tickets'], rows.map((r) => [r.k, String(r.v)])),
        };
      },
    },
  ];
}

/* ---- Invoice Reader ---- */
function invoicePack() {
  return [
    {
      id: 'extract', tools: ['email'], match: [/extract|read (the )?invoice|fields|inv-?\d+|parse/i],
      trace: 'read the attachment and pulled the fields',
      answer: (q, { state }) => {
        const m = q.match(/inv-?(\d+)/i);
        const inv = (m && state.invoices.find((x) => x.id.toLowerCase() === `inv-${m[1]}`)) || state.invoices[0];
        const tax = Math.round(inv.amount * inv.taxPct / 100);
        return {
          text: `**${inv.id}** from ${inv.vendor}, dated ${fmtDate(inv.dateIso)}. Confidence ${inv.confidence}%, status ${inv.status}.`,
          table: T(['Field', 'Value'], [
            ['Vendor', inv.vendor], ['Invoice number', inv.id], ['Date', fmtDate(inv.dateIso)],
            ['Purchase order', inv.po], ['Lines', String(inv.lines)],
            ['Tax', `${inv.taxPct}% · ${money(tax)}`],
            ['Total', money(inv.amount)],
            ['Posted to workbook', inv.postedToSheet ? 'yes' : 'no'],
          ]),
        };
      },
    },
    {
      id: 'review', match: [/review|low confidence|failed|exception|parked|problem|reject/i],
      trace: 'filtered by confidence floor',
      answer: (q, { state }) => {
        const bad = state.invoices.filter((x) => x.status !== 'extracted');
        return {
          text: `**${bad.length}** invoices are not clean. Anything under 85% confidence is parked instead of posted — the usual cause is a scanned page with the total in a stamp rather than the table.`,
          table: T(['Invoice', 'Vendor', 'Confidence', 'Status'], sortDesc(bad, (x) => -x.confidence).slice(0, 6).map((x) => [x.id, x.vendor, `${x.confidence}%`, x.status])),
        };
      },
    },
    {
      id: 'totals', tools: ['sheets'], match: [/total|how much|payable|value|sum|this month/i],
      trace: 'summed the payables range in the workbook',
      answer: (q, { state }) => {
        const all = state.invoices;
        const posted = all.filter((x) => x.postedToSheet);
        return {
          text: `**${money(sum(all, (x) => x.amount))}** across ${all.length} invoices. ${money(sum(posted, (x) => x.amount))} of that is posted to Payables Q3; the rest is held pending review.`,
          table: T(['State', 'Invoices', 'Value'], [
            ['Posted', String(posted.length), money(sum(posted, (x) => x.amount))],
            ['Held', String(all.length - posted.length), money(sum(all.filter((x) => !x.postedToSheet), (x) => x.amount))],
          ]),
        };
      },
    },
    {
      id: 'vendor', match: [/vendor|supplier|who (are we|do we) (paying|pay)|biggest/i],
      trace: 'grouped invoices by vendor',
      answer: (q, { state }) => {
        const g = {};
        state.invoices.forEach((i) => { g[i.vendor] = (g[i.vendor] || 0) + i.amount; });
        const rows = sortDesc(Object.entries(g).map(([k, v]) => ({ k, v })), (x) => x.v);
        return {
          text: `${rows.length} vendors in the current set. **${rows[0].k}** is the largest at ${money(rows[0].v)}.`,
          table: T(['Vendor', 'Value'], rows.slice(0, 6).map((r) => [r.k, money(r.v)])),
        };
      },
    },
    {
      id: 'tax', match: [/tax|gst|vat|duty/i],
      trace: 'recomputed tax per line',
      answer: (q, { state }) => {
        const bands = {};
        state.invoices.forEach((i) => {
          const t = Math.round(i.amount * i.taxPct / 100);
          bands[i.taxPct] = (bands[i.taxPct] || 0) + t;
        });
        const total = sum(Object.values(bands), (x) => x);
        return {
          text: `Tax across the set is **${money(total)}**. I recompute it from the line values rather than trusting the printed figure, which is how the mismatches get caught.`,
          table: T(['Rate', 'Tax value'], Object.entries(bands).sort((a, b) => a[0] - b[0]).map(([k, v]) => [`${k}%`, money(v)])),
        };
      },
    },
    {
      id: 'duplicate', match: [/duplicate|double|twice|same invoice|repeat/i],
      trace: 'compared vendor, value and date across the set',
      answer: (q, { state }) => {
        const seen = {}; const dupes = [];
        state.invoices.forEach((i) => {
          const k = `${i.vendor}|${Math.round(i.amount / 1000)}`;
          if (seen[k]) dupes.push([seen[k].id, i.id, i.vendor, money(i.amount)]);
          else seen[k] = i;
        });
        return {
          text: dupes.length
            ? `**${dupes.length}** possible duplicates — same vendor, same value to the nearest thousand. Worth a human look before payment.`
            : 'No duplicates in the current set. I compare vendor, value to the nearest thousand and the date window.',
          table: dupes.length ? T(['First', 'Second', 'Vendor', 'Value'], dupes.slice(0, 5)) : null,
        };
      },
    },
    {
      id: 'po', match: [/po\b|purchase order|variance|mismatch|does not match|difference/i],
      trace: 'matched invoice totals to purchase orders',
      answer: (q, { state }) => {
        const off = state.invoices.filter((x) => x.variance !== 0);
        return {
          text: `${off.length} invoices do not tie to their purchase order. The tolerance is ₹5 — anything wider is held and flagged, never posted.`,
          table: T(['Invoice', 'PO', 'Variance'], sortDesc(off, (x) => Math.abs(x.variance)).slice(0, 6).map((x) => [x.id, x.po, money(x.variance)])),
        };
      },
    },
    {
      id: 'post', tools: ['sheets'], match: [/post|append|sheet|workbook|where does it go|output/i],
      trace: 'read the last rows appended to the workbook',
      answer: (q, { state }) => {
        const posted = state.invoices.filter((x) => x.postedToSheet);
        return {
          text: `${posted.length} rows are in **Payables Q3**. Each row carries invoice number, vendor, date, PO, net, tax, total and my confidence, so finance can sort by confidence and check only what is worth checking.`,
          table: T(['Invoice', 'Vendor', 'Total', 'Confidence'], posted.slice(0, 6).map((x) => [x.id, x.vendor, money(x.amount), `${x.confidence}%`])),
        };
      },
    },
  ];
}

/* ---- Onboarding Assistant ---- */
function onboardPack() {
  const KB = [
    [/catalogue|import|products|upload/i, 'Import the catalogue', 'Settings → Data → Import. A CSV with name, SKU, unit and price. Rows that fail validation come back as a file you can fix and re-upload; nothing partial is written.'],
    [/invite|team|user|seat|colleague/i, 'Invite the team', 'Team → Invite. Pick a role first — viewer, member, admin — because the invite mail carries the role and cannot be changed after it is accepted without a re-invite.'],
    [/payment|card|billing|pay/i, 'Set up payment', 'Billing → Payment method. Card or bank mandate. The first charge only happens after the trial ends, and the plan can still be changed until then.'],
    [/report|schedule|weekly|summary/i, 'Schedule a report', 'Reports → Schedule. Pick the day, the hour and the distribution list. The first run goes out the following week, not immediately.'],
    [/order|first order|place/i, 'Place the first order', 'Orders → New. This is the step most accounts stall on because it needs the catalogue imported first.'],
  ];
  return [
    {
      id: 'checklist', match: [/checklist|steps|setup|onboard|what.*next|getting started/i],
      trace: 'read the setup checklist across all accounts',
      answer: (q, { state }) => {
        const rows = ONBOARD_STEPS.map((s, i) => [s, String(state.accounts.filter((a) => a.stepIdx === i).length)]);
        return {
          text: `Six steps. An account is counted at the step it is currently sitting on, so the last row is everyone who finished.`,
          table: T(['Step', 'Accounts here'], rows),
        };
      },
    },
    {
      id: 'stuck', tools: ['crm'], match: [/stuck|blocked|behind|not moving|drop|slow|at risk/i],
      trace: 'compared step age against the five day threshold',
      answer: (q, { state }) => {
        const stuck = state.accounts.filter((a) => a.stuckDays >= 5);
        return {
          text: `**${stuck.length}** accounts have been on the same step for five days or more. The common stall is *Catalogue imported* — the CSV usually fails on the price column.`,
          table: T(['Account', 'Step', 'Days', 'Owner'], sortDesc(stuck, (x) => x.stuckDays).slice(0, 6).map((a) => [a.name, a.step, String(a.stuckDays), a.owner])),
        };
      },
    },
    {
      id: 'account', tools: ['crm'], match: [/acc-\d+|status of|where is|progress|how is .* doing/i],
      trace: 'opened the account record',
      answer: (q, { state }) => {
        const m = q.match(/acc-?(\d+)/i);
        const named = state.accounts.find((a) => q.toLowerCase().includes(a.name.toLowerCase().split(' ')[0]));
        const a = (m && state.accounts.find((x) => x.id.toLowerCase() === `acc-${m[1]}`)) || named || sortDesc(state.accounts, (x) => x.stuckDays)[0];
        return {
          text: `**${a.name}** (${a.id}) — ${a.plan} plan, ${a.seats} seats, ${a.region}.\n\n- Step ${a.stepIdx + 1} of 6: ${a.step}\n- ${a.stuckDays} days on this step\n- Owner ${a.owner}, contact ${a.contact} at ${a.email}\n\n${a.stuckDays >= 5 ? 'Past the threshold. I would send the nudge mail and copy the owner.' : 'Moving at a normal pace, no nudge needed.'}`,
        };
      },
    },
    {
      id: 'howto', match: [/how do i|how to|where do i|can i|explain|walk me through/i],
      trace: 'matched the product notes',
      answer: (q) => {
        const hit = KB.find(([re]) => re.test(q));
        if (!hit) {
          return { text: `I have notes on the six setup steps: importing the catalogue, inviting the team, setting up payment, placing the first order, scheduling a report and changing the plan. Name one and I will walk through it.` };
        }
        return { text: `**${hit[1]}**\n\n${hit[2]}` };
      },
    },
    {
      id: 'book', tools: ['crm', 'email'], match: [/book|call|meeting|demo|talk to someone|schedule a/i],
      trace: 'checked owner availability and wrote the invite',
      answer: (q, { state }) => {
        const a = sortDesc(state.accounts, (x) => x.stuckDays)[0];
        return {
          text: `I can put a call in with **${a.owner}**, who owns ${a.name}. Next three open slots on their calendar are Tuesday 10:30, Tuesday 15:00 and Thursday 11:15 IST.\n\nThe invite goes to ${a.email} with a short agenda pulled from where the account is stuck: ${a.step}. Say which slot and I will draft it.`,
        };
      },
    },
    {
      id: 'welcome', tools: ['email'], match: [/welcome|draft|write to|email them|nudge|follow up/i],
      trace: 'drafted from the account record',
      answer: (q, { state }) => {
        const a = state.accounts.find((x) => x.stuckDays >= 5) || state.accounts[0];
        return {
          text: `Draft for **${a.name}**, to ${a.contact} at ${a.email}.\n\n---\n\nHello ${a.contact.split(' ')[0]},\n\nYou are at step ${a.stepIdx + 1} of 6 — ${a.step}. Most accounts clear this one in a single sitting, and the usual snag is the price column in the import file.\n\nI have attached a template that matches the expected format. If it is easier, ${a.owner} can do the import with you on a call.\n\nDevika Nair\nOnboarding, Anvaya Systems`,
        };
      },
    },
    {
      id: 'ttfv', match: [/how long|time to|first value|average|typical|days to/i],
      trace: 'measured step age across accounts',
      answer: (q, { state }) => {
        const done = state.accounts.filter((a) => a.stepIdx >= 4);
        const avgStuck = Math.round(sum(state.accounts, (a) => a.stuckDays) / state.accounts.length);
        return {
          text: `**${done.length} of ${state.accounts.length}** accounts have reached the first order, which is the point we treat as first value. Average time sitting on the current step across the whole book is ${avgStuck} days.\n\nThe two steps that cost the most days are *Catalogue imported* and *Payment set up*.`,
          table: T(['Plan', 'Accounts', 'At first order'], ['Starter', 'Growth', 'Scale'].map((p) => {
            const set = state.accounts.filter((a) => a.plan === p);
            return [p, String(set.length), String(set.filter((a) => a.stepIdx >= 4).length)];
          })),
        };
      },
    },
    {
      id: 'region', match: [/region|where are|kerala|riyadh|jeddah|location|geograph/i],
      trace: 'grouped accounts by region',
      answer: (q, { state }) => {
        const c = countBy(state.accounts, (a) => a.region);
        return {
          text: `Accounts are spread across ${Object.keys(c).length} regions. The Gulf accounts run a week behind on average because the setup call has to land inside their working week.`,
          table: T(['Region', 'Accounts'], sortDesc(Object.entries(c).map(([k, v]) => ({ k, v })), (x) => x.v).map((r) => [r.k, String(r.v)])),
        };
      },
    },
  ];
}

/* ---- Report Writer ---- */
function reportPack() {
  return [
    {
      id: 'weekly', tools: ['sheets'], match: [/weekly|summary|monday|write the report|report for/i],
      trace: 'read Ops!A1:H60 and wrote the summary',
      answer: (q, { state }) => {
        const m = state.metrics;
        const cur = m[m.length - 1]; const prev = m[m.length - 2];
        const d = pctOf(cur.runs - prev.runs, prev.runs);
        return {
          text: `**Week ${m.length} summary**\n\nAgents ran ${num(cur.runs)} times, ${d >= 0 ? 'up' : 'down'} ${pct(Math.abs(d), 1)} on the week before. ${num(cur.success)} of those finished clean, a ${pct(pctOf(cur.success, cur.runs), 1)} success rate. ${cur.escalations} conversations went to a person.\n\nToken use was ${num(cur.tokens)} at a cost of ${rupees(cur.costPaise)}. Nothing in the set moved far enough to need a call-out beyond the run volume itself.`,
          table: T(['Metric', 'This week', 'Last week'], [
            ['Runs', num(cur.runs), num(prev.runs)],
            ['Clean', num(cur.success), num(prev.success)],
            ['Escalations', String(cur.escalations), String(prev.escalations)],
            ['Cost', rupees(cur.costPaise), rupees(prev.costPaise)],
          ]),
        };
      },
    },
    {
      id: 'compare', tools: ['sheets'], match: [/compare|last week|change|delta|trend|versus|vs\b/i],
      trace: 'diffed the last two weeks',
      answer: (q, { state }) => {
        const m = state.metrics;
        const cur = m[m.length - 1]; const prev = m[m.length - 2];
        const line = (k, a, b) => [k, num(a), num(b), `${a - b >= 0 ? '+' : ''}${pct(pctOf(a - b, b || 1), 1)}`];
        return {
          text: `Week on week. Anything past ten per cent gets a sentence in the written summary; the rest is left in the table.`,
          table: T(['Metric', 'This week', 'Last week', 'Change'], [
            line('Runs', cur.runs, prev.runs),
            line('Clean', cur.success, prev.success),
            line('Escalations', cur.escalations, prev.escalations),
            line('Tokens', cur.tokens, prev.tokens),
          ]),
        };
      },
    },
    {
      id: 'numbers', tools: ['sheets'], match: [/runs|volume|throughput|how many|series|history/i],
      trace: 'read the eight week range',
      answer: (q, { state }) => ({
        text: `Eight weeks of run volume out of the workbook. The dip in the middle is the week the ticketing connection was down for two days.`,
        table: T(['Week', 'Runs', 'Clean', 'Escalated'], state.metrics.map((w) => [w.label, num(w.runs), num(w.success), String(w.escalations)])),
      }),
    },
    {
      id: 'anomaly', tools: ['sheets'], match: [/anomal|spike|unusual|outlier|what moved|jump|drop/i],
      trace: 'scanned for week-on-week moves over ten per cent',
      answer: (q, { state }) => {
        const m = state.metrics;
        const moves = [];
        for (let i = 1; i < m.length; i++) {
          const d = pctOf(m[i].runs - m[i - 1].runs, m[i - 1].runs);
          if (Math.abs(d) >= 10) moves.push([m[i].label, num(m[i].runs), `${d >= 0 ? '+' : ''}${pct(d, 1)}`]);
        }
        return {
          text: moves.length
            ? `**${moves.length}** weeks moved more than ten per cent on run volume. Those are the ones the written summary explains.`
            : 'Nothing moved more than ten per cent this run. The summary will be a short one.',
          table: moves.length ? T(['Week', 'Runs', 'Change'], moves) : null,
        };
      },
    },
    {
      id: 'exec', match: [/exec|paragraph|prose|write|plain english|for the board/i],
      trace: 'composed the executive paragraph',
      answer: (q, { state }) => {
        const m = state.metrics; const cur = m[m.length - 1];
        const rate = pctOf(cur.success, cur.runs);
        return {
          text: `**For the Monday note**\n\nAutomation handled ${num(cur.runs)} pieces of work last week and finished ${pct(rate, 1)} of them without a person. ${cur.escalations} were handed over, which is what the escalation rule exists to do. Cost was ${rupees(cur.costPaise)}, or roughly ${rupees(Math.round(cur.costPaise / cur.runs))} per piece of work.\n\nThe number worth watching is the held invoice pile, not the run count.`,
        };
      },
    },
    {
      id: 'distribution', tools: ['email'], match: [/distribution|who gets|recipients|send to|list|mailing/i],
      trace: 'read the distribution list',
      answer: (q, { state }) => ({
        text: `The summary goes to **${state.settings.distribution}** every Monday at 08:00 IST, from the shared mailbox. Five people are on the list: the two desk leads, finance, the account owner group and an archive address that files a copy in the workbook.\n\nThe workflow is currently ${(state.workflows.find((w) => w.id === 'wf-report') || {}).enabled ? 'enabled' : '**disabled**'}.`,
      }),
    },
    {
      id: 'source', tools: ['sheets'], match: [/source|where.*data|fresh|stale|workbook|trust|accurate/i],
      trace: 'checked range freshness',
      answer: (q, { state }) => ({
        text: `Everything comes from one range: **Ops!A1:H60** in the operations workbook, plus the run history held in this workspace.\n\n- Workbook last written: ${ago(new Date(Date.now() - 5400000))}\n- Run history: ${state.runs.length} runs, newest ${ago(state.runs[0].startedAt)}\n- Retention: ${state.settings.retentionDays} days\n\nIf a column moves in the workbook I stop rather than guess, which is why this agent is ${state.agents.find((a) => a.id === 'report').status}.`,
      }),
    },
    {
      id: 'quality', match: [/quality|accuracy|wrong|mistake|hallucin|make (things )?up/i],
      trace: 'read the review log',
      answer: (q, { state }) => {
        const a = state.agents.find((x) => x.id === 'report');
        return {
          text: `Success rate is ${pct(a.successRate, 1)}, and every summary is written to the workbook before it is mailed so there is a copy to compare against.\n\nThe failure mode here is not invention, it is a moved column: if a heading changes, the numbers land in the wrong sentence. That is why the run stops on a schema mismatch instead of writing something plausible.`,
        };
      },
    },
  ];
}

/* ---- generic pack for agents created in the UI ---- */
function genericPack() {
  return [
    {
      id: 'workspace', match: [/workspace|overview|what.*here|summary|status/i],
      trace: 'read the workspace state',
      answer: (q, { state }) => ({
        text: `The workspace holds ${state.agents.length} agents, ${state.workflows.length} workflows, ${state.tools.filter((t) => t.connected).length} live connections and ${state.runs.length} runs of history.\n\nI am a new agent, so my own pack is thin — I answer about my definition, my runs, my tools and my guardrails. Wire a pack in \`src/agent.js\` to give me real work.`,
      }),
    },
    {
      id: 'runsmine', match: [/run|history|did i|last time/i],
      trace: 'read my own run history',
      answer: (q, { state, agent }) => {
        const mine = state.runs.filter((r) => r.agentId === agent.id);
        return {
          text: mine.length
            ? `I have ${mine.length} runs. Newest was ${ago(mine[0].startedAt)} and finished ${mine[0].status}.`
            : 'No runs yet. Ask me something and this becomes the first one — it will show up in the Runs screen straight after.',
        };
      },
    },
    {
      id: 'help', match: [/help|what can i ask|examples|suggest/i],
      trace: 'listed the matchable shapes',
      answer: () => ({
        text: `Try: what can you do · what tools do you have · what guardrails apply · how many runs have you done · what does a run cost.`,
      }),
    },
  ];
}

const PACK_BUILDERS = {
  triage: triagePack,
  invoice: invoicePack,
  onboard: onboardPack,
  report: reportPack,
};

export const AGENT_SUGGESTIONS = {
  triage: ['How big is the queue?', 'Draft a reply for the oldest ticket', 'Who should take the next one?', 'What are people complaining about?'],
  invoice: ['What needs review?', 'Total payable this month', 'Any duplicates?', 'Extract INV-8820'],
  onboard: ['Which accounts are stuck?', 'Show the setup checklist', 'How do I import the catalogue?', 'Book a call'],
  report: ['Write the weekly summary', 'Compare against last week', 'What moved this week?', 'Where does the data come from?'],
};

export const CONSOLE_SUGGESTIONS = [
  'How is the workspace doing?',
  'What failed?',
  'Where is the cost going?',
  'Which connections are down?',
];

export const GUARDRAIL_PROBES = [
  { label: 'Off-topic question', q: 'what are the salary bands here?' },
  { label: 'Escalation trigger', q: 'the customer is angry and wants a refund' },
  { label: 'Contact details', q: 'who do I contact about the oldest open item?' },
];

const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* A blocked term must reach the guardrail engine even when no ordinary
   intent matches, otherwise an off-topic question would quietly fall
   through to the fallback line instead of being refused. `match` is a
   getter so it always reflects the current blocked-term list. */
function offTopicIntent(store) {
  return {
    id: 'offtopic',
    get match() {
      const g = guardById(store.state, 'topics');
      const words = (g && g.blocked) || [];
      return words.length ? [new RegExp(`(${words.map(reEsc).join('|')})`, 'i')] : [];
    },
    trace: 'checked the question against the topic list',
    answer: (q, { state, agent }) => {
      const g = guardById(state, 'topics');
      const bound = agent.guardrails.includes('topics');
      const why = bound
        ? '**Allowed topics** is switched off for the workspace, so I am not refusing you'
        : '**Allowed topics** is not bound to this agent, so nothing refused you';
      return {
        text: `I have no records on that. ${why} — I simply hold nothing that answers it.\n\nWhat I do hold sits under: ${g.topics.join(', ')}.\n\n${bound ? 'Switch the rule back on in Guardrails' : 'Bind the rule to this agent in the agent editor'} to see the refusal instead of this.`,
      };
    },
  };
}

/* Same reasoning as the off-topic catcher: an escalation trigger must
   always land somewhere, including on agents the rule is not bound to. */
function handoverIntent(store) {
  return {
    id: 'handover',
    get match() {
      const g = guardById(store.state, 'escalate');
      const words = (g && g.triggers) || [];
      return words.length ? [new RegExp(`(${words.map(reEsc).join('|')})`, 'i')] : [];
    },
    trace: 'checked the escalation rule',
    answer: (q, { state, agent }) => {
      const g = guardById(state, 'escalate');
      const bound = agent.guardrails.includes('escalate');
      return {
        text: `That reads like a handover. Here is the context a person would need:\n\n- Agent: ${agent.name} on \`${agent.model}\`\n- Queue configured on the rule: ${g.queue}\n- Trigger words: ${g.triggers.join(', ')}\n\n${bound
          ? '**Escalation to human** is bound to me but switched off, so nothing was raised.'
          : '**Escalation to human** is not bound to this agent, so nothing was raised.'} ${bound ? 'Switch it on in Guardrails' : 'Bind it to this agent in the agent editor'} and ask again to watch the handover happen.`,
      };
    },
  };
}

export function packFor(agent, store) {
  const build = PACK_BUILDERS[agent.id] || genericPack;
  const pack = [...build(), ...sharedIntents(agent)];
  /* Catchers go last so a real intent always outscores them. They exist so
     that no suggestion chip or guardrail probe can ever reach the fallback. */
  if (store) pack.push(offTopicIntent(store), handoverIntent(store));
  return pack;
}

/* ============================================================
   Assistant factories
   ============================================================ */
export const DEFAULT_AGENT_SUGGESTIONS = [
  'What can you do?', 'What tools do you have?', 'What guardrails apply?', 'How many runs have you done?',
];

export const suggestionsFor = (agent) => AGENT_SUGGESTIONS[agent.id] || DEFAULT_AGENT_SUGGESTIONS;

export function buildAgentBot(store, agent, { emit } = {}) {
  const intents = packFor(agent, store).map((i) => wrapIntent(i, agent, store, emit));
  const suggestions = suggestionsFor(agent);
  return new Assistant({
    name: agent.name,
    initials: agent.initials,
    tag: `${agent.model} · ${agent.status}`,
    greeting: `**${agent.name}.** ${agent.purpose}\n\nEvery answer below is assembled from this workspace's own sample records. Watch the inspector on the right — it shows the tool calls, the tokens and which guardrail fired.`,
    suggestions,
    intents,
    fallbacks: [
      `I did not match that to anything in my pack. Try "${suggestions[0]}" or "${suggestions[1]}".`,
      `No intent matched. I can answer "${suggestions[2]}" and "${suggestions[3]}", or anything about my tools, my guardrails and my run history.`,
      `That is outside my pack. ${agent.purpose} Start with "${suggestions[0]}".`,
      `I could not place that. Every answer I give comes from this workspace's records — try "${suggestions[1]}".`,
    ],
    note: 'Demo agent — replies are matched locally against sample data. No model, no network.',
    context: () => ({ state: store.state, agent }),
  });
}

/* ---------- the global console assistant ---------- */
export function buildConsoleBot(store) {
  const S = () => store.state;
  const intents = [
    {
      id: 'health',
      match: [
        /how (is|are|'s) .*(doing|going|looking)|how are we|health|overview|dashboard|summar(y|ise)/i,
        /(workspace|things|everything|it all) (doing|going|ok|okay|alright)/i,
        'status',
      ],
      trace: 'aggregated every run in the workspace',
      answer: () => {
        const s = S();
        const ok = s.runs.filter((r) => r.status === 'success').length;
        return {
          text: `**${s.settings.workspace}** — ${s.agents.filter((a) => a.status === 'live').length} live agents, ${s.workflows.filter((w) => w.enabled).length} of ${s.workflows.length} workflows enabled, ${s.tools.filter((t) => t.connected).length} of ${s.tools.length} connections up.\n\nAcross ${s.runs.length} runs held here, ${ok} finished clean — ${pct(pctOf(ok, s.runs.length), 1)}.`,
          table: T(['Status', 'Runs'], Object.entries(countBy(s.runs, (r) => r.status)).map(([k, v]) => [k, String(v)])),
        };
      },
    },
    {
      id: 'failed', match: [/fail|error|broke|went wrong|red/i],
      trace: 'filtered runs by status',
      answer: () => {
        const s = S();
        const f = s.runs.filter((r) => r.status === 'failed');
        return {
          text: `**${f.length}** runs failed. The pattern is a tool call returning nothing, not the agent giving up — check the connection before the agent.`,
          table: T(['Run', 'Agent', 'When'], f.slice(0, 6).map((r) => [r.id, (agentById(s, r.agentId) || {}).name || r.agentId, ago(r.startedAt)])),
        };
      },
    },
    {
      id: 'escalations', match: [/escalat|handed over|human|tier 2/i],
      trace: 'read the escalation guardrail log',
      answer: () => {
        const s = S();
        const e = s.runs.filter((r) => r.status === 'escalated');
        const g = guardById(s, 'escalate');
        return {
          text: `**${e.length}** runs were handed to a person, all into ${g.queue}. The rule is ${g.enabled ? 'on' : '**off**'} and fires on: ${g.triggers.join(', ')}.`,
          table: T(['Run', 'Agent', 'When'], e.slice(0, 6).map((r) => [r.id, (agentById(s, r.agentId) || {}).name || r.agentId, ago(r.startedAt)])),
        };
      },
    },
    {
      id: 'cost', match: [/cost|spend|token|bill|budget|expensive/i],
      trace: 'summed tokens across every run',
      answer: () => {
        const s = S();
        const paise = sum(s.runs, (r) => r.costPaise);
        const rows = s.agents.map((a) => {
          const mine = s.runs.filter((r) => r.agentId === a.id);
          return { a, p: sum(mine, (r) => r.costPaise), n: mine.length };
        });
        return {
          text: `**${rupees(paise)}** across ${s.runs.length} runs, ${num(sum(s.runs, (r) => r.tokensIn + r.tokensOut))} tokens. The ceiling rule stops any single run over ${rupees(guardById(s, 'cost').limitPaise)}.`,
          table: T(['Agent', 'Runs', 'Cost'], sortDesc(rows, (r) => r.p).map((r) => [r.a.name, String(r.n), rupees(r.p)])),
        };
      },
    },
    {
      id: 'busiest', match: [/busiest|most used|which agent|top agent|workload/i],
      trace: 'ranked agents by 30 day volume',
      answer: () => {
        const s = S();
        return {
          text: `**${sortDesc(s.agents, (a) => a.runs30d)[0].name}** does the most work by a wide margin. Volume below is the 30 day figure on each agent record.`,
          table: T(['Agent', 'Runs 30d', 'Success', 'Status'], sortDesc(s.agents, (a) => a.runs30d).map((a) => [a.name, num(a.runs30d), pct(a.successRate, 1), a.status])),
        };
      },
    },
    {
      id: 'tools', match: [/tool|connection|integrat|disconnect|connected/i],
      trace: 'read the connection registry',
      answer: () => {
        const s = S();
        const off = s.tools.filter((t) => !t.connected);
        return {
          text: off.length
            ? `**${off.length} disconnected**: ${off.map((t) => t.name).join(', ')}. Anything an agent needs from those will fail until they are back on — try it in the Playground and watch the inspector.`
            : 'All five connections are up. Disconnect one in Tools & connections and the agents that depend on it start refusing straight away.',
          table: T(['Tool', 'State', 'Used by'], s.tools.map((t) => {
            const n = s.agents.filter((a) => a.tools.includes(t.id)).length;
            return [t.name, t.connected ? 'connected' : '**off**', `${n} agent${n === 1 ? '' : 's'}`];
          })),
        };
      },
    },
    {
      id: 'guardrails', match: [/guardrail|rule|redact|pii|policy|allowed topic|ceiling/i],
      trace: 'read the guardrail set',
      answer: () => {
        const s = S();
        return {
          text: `Four rules, applied per agent. Toggling one changes the replies immediately — PII redaction masks contact details, allowed topics refuses, escalation hands over, the ceiling truncates.`,
          table: T(['Guardrail', 'State', 'Agents'], s.guardrails.map((g) => [
            g.name, g.enabled ? 'enabled' : '**disabled**',
            String(s.agents.filter((a) => a.guardrails.includes(g.id)).length),
          ])),
        };
      },
    },
    {
      id: 'workflows', match: [/workflow|pipeline|steps|trigger|automation/i],
      trace: 'read the workflow definitions',
      answer: () => {
        const s = S();
        return {
          text: `${s.workflows.length} workflows. A workflow is a trigger, a list of steps and the outputs — steps can be a tool call, an agent, a condition or an output.`,
          table: T(['Workflow', 'Trigger', 'Steps', 'State'], s.workflows.map((w) => [
            w.name, w.trigger.label, String(w.steps.filter((x) => x.enabled).length), w.enabled ? 'on' : '**off**',
          ])),
        };
      },
    },
    {
      id: 'latency', match: [/slow|latency|fast|duration|how long/i],
      trace: 'sorted runs by duration',
      answer: () => {
        const s = S();
        const slow = sortDesc(s.runs, (r) => r.durationMs).slice(0, 5);
        const avg = Math.round(sum(s.runs, (r) => r.durationMs) / s.runs.length);
        return {
          text: `Average run is **${num(avg)} ms**. The slow tail is document work — extraction reads whole pages before it decides anything.`,
          table: T(['Run', 'Agent', 'Duration'], slow.map((r) => [r.id, (agentById(s, r.agentId) || {}).name || r.agentId, `${num(r.durationMs)} ms`])),
        };
      },
    },
    {
      id: 'agentlookup', match: [/support triage|invoice reader|onboarding assistant|report writer|tell me about the/i],
      trace: 'opened the agent record',
      answer: (q) => {
        const s = S();
        const a = s.agents.find((x) => q.toLowerCase().includes(x.name.toLowerCase())) || s.agents[0];
        return {
          text: `**${a.name}** · \`${a.model}\` · ${a.status}\n\n${a.description}\n\n- Tools: ${a.tools.map((t) => (toolById(s, t) || {}).name).join(', ')}\n- Guardrails: ${a.guardrails.map((g) => (guardById(s, g) || {}).name).join(', ')}\n- ${num(a.runs30d)} runs in 30 days at ${pct(a.successRate, 1)}\n\nOpen it in the Playground to talk to it directly.`,
        };
      },
    },
    {
      id: 'recent', match: [/recent|last|what happened|latest|activity|just now/i],
      trace: 'read the newest runs',
      answer: () => {
        const s = S();
        return {
          text: `Newest activity in the workspace.`,
          table: T(['When', 'Agent', 'Trigger', 'Status'], s.runs.slice(0, 6).map((r) => [
            ago(r.startedAt), (agentById(s, r.agentId) || {}).name || r.agentId, r.trigger, r.status,
          ])),
        };
      },
    },
    {
      id: 'howitworks', match: [/how does this work|is this real|demo|fake|model|offline/i],
      trace: 'read the build notes',
      answer: () => ({
        text: `This whole workspace is a demo. There is no model behind me — every reply is a regular expression matched against the sample records in this page, then formatted. Nothing is sent anywhere and nothing is fetched.\n\nThe streaming, the tool calls in the inspector and the run traces exist so the product reads the way the real thing would. State lives in \`localStorage\`; **Reset demo data** puts it back.`,
      }),
    },
  ];
  return new Assistant({
    name: 'Agentline Console',
    initials: 'AC',
    tag: 'Workspace console',
    greeting: 'I read the whole workspace rather than one agent: run health, what failed, what was escalated, where the cost goes, which connections are down, which agent is busiest, the workflows and any single agent by name.',
    suggestions: CONSOLE_SUGGESTIONS,
    intents,
    fallbacks: [
      `I could not place that. Try "${CONSOLE_SUGGESTIONS[0]}" or "${CONSOLE_SUGGESTIONS[1]}".`,
      `No match. I answer "${CONSOLE_SUGGESTIONS[2]}", "${CONSOLE_SUGGESTIONS[3]}", "Which agent is busiest?" and "What is slow?".`,
      'That is outside what the console reads. Ask about agents, runs, workflows, connections, guardrails or cost.',
      'Nothing matched. Ask "What happened recently?" or "How does this work?" and I will pull it from the workspace records.',
    ],
    note: 'Demo console — answers are matched locally against sample data. No model, no network.',
    context: () => ({ state: store.state }),
  });
}
