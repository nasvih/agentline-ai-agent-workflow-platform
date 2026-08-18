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

   Some intents do not only answer: they offer to change the workspace.
   Those live in `actions.js` and are merged in at the front of every
   pack, so an instruction ("run the invoice workflow") beats the
   question that shares its words ("what workflows are there").
   ============================================================ */

import { Assistant } from '../lib/assistant.js';
import { num, pct, ago, fmtDate, money } from '../lib/ui.js';
import {
  guardActive, toolById, guardById, agentById,
  estimateCost, rupees, newRunId, ONBOARD_STEPS,
  toolName, toolDesc, agentName, agentDesc, agentPurpose, guardName, guardQueue, workflowName, triggerLabel,
  statusLabel, agentStatusLabel, priorityLabel, categoryLabel, channelLabel,
  sentimentLabel, ticketStatusLabel, subjectLabel, invStatusLabel, planLabel,
  onboardStepLabel, regionLabel, termLabel, triggerName,
} from './data.js';
import { agentActions, consoleActions, catalogueFor, catalogue } from './actions.js';
import { t } from './main.js';
import { dl } from './data.js';

/* ---------- small helpers ---------- */
const T = (head, rows) => ({ head, rows });
const byId = (arr, id) => arr.find((x) => x.id === id);
const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
const sortDesc = (arr, f) => [...arr].sort((a, b) => f(b) - f(a));
const countBy = (arr, f) => arr.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});
const pctOf = (a, b) => (b ? (a / b) * 100 : 0);
/* the reader's own list separators, so a joined list reads right in both */
const SEP = () => t('common.listSep');
const joinList = (xs) => xs.join(SEP());

/* A blocked term and an escalation trigger are stored in English — that
   string is the record — and the Arabic reader sees and types the alias
   held in `data.term`. Both spellings are tested and the stored English
   word comes back, so the guardrail record never changes shape. */
const aliases = (w) => { const a = termLabel(w); return a && a !== w ? [w, a] : [w]; };

/* The chat chrome. lib/assistant.js is shared between the demo apps and
   carries no dictionary of its own, so this app hands it its own. */
const assistUi = () => ({
  you: t('assist.you'),
  placeholder: t('assist.placeholder'),
  send: t('assist.send'),
  clear: t('assist.clear'),
  close: t('assist.close'),
  openName: (n) => t('assist.openName', { name: n }),
  fabTitle: (n) => t('assist.fabTitle', { name: n }),
  edgeOfData: t('assist.edgeOfData'),
  actionFailed: t('assist.actionFailed'),
  done: t('assist.done'),
  changeApplied: t('assist.changeApplied'),
  working: t('assist.working'),
  searchedIndex: t('assist.searchedIndex'),
});
const matchTerm = (q, words) => {
  const low = String(q || '').toLowerCase();
  return (words || []).find((w) => aliases(w).some((x) => low.includes(String(x).toLowerCase()))) || null;
};

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
function wrapIntent(intent, agent, store, emit, session) {
  const baseAnswer = intent.answer;
  const answer = (q, ctx) => {
      const s = store.state;
      const events = [];
      const verdicts = [];
      const ev = (label, kind, status, ms, detail) => { events.push({ label, kind, status, ms, detail }); };
      const jitter = (a, b) => a + Math.round(Math.random() * (b - a));

      /* Remember the last *question*, so "turn the rule off and ask that
         again" has something to re-ask. Instructions are not questions. */
      if (session && !intent.operator) session.lastQ = q;

      ev(t('eng.ev.accepted'), 'system', 'ok', jitter(3, 12),
        t('eng.ev.acceptedDetail', { model: agent.model, streaming: s.settings.streaming ? t('common.on') : t('common.off') }));

      const needTools = intent.tools || [];
      let out = null;
      let status = 'success';
      let toolCalls = 0;

      /* An operator instruction — "disconnect the CRM", "escalate this
         ticket" — is not customer text, so the topic and escalation
         checks that read customer wording are recorded as skipped rather
         than applied. Redaction and the cost ceiling still run. */
      const operator = !!intent.operator;
      if (operator) {
        ev(t('eng.ev.skipChecks'), 'guardrail', 'skipped', jitter(2, 7), t('eng.ev.skipChecksDetail'));
      }

      /* 1 — allowed topics */
      const gTopics = guardById(s, 'topics');
      if (!operator && guardActive(s, agent, 'topics')) {
        const hit = matchTerm(q, gTopics.blocked || []);
        if (hit) {
          const term = termLabel(hit);
          ev(t('eng.ev.topics'), 'guardrail', 'blocked', jitter(2, 8), t('eng.ev.topicsBlocked', { term }));
          verdicts.push({ id: 'topics', verdict: 'blocked', detail: t('eng.verdictDetail.blockedTerm', { term }) });
          status = 'blocked';
          out = {
            text: t('eng.blockedTopic', { term, topics: joinList((gTopics.topics || []).map(termLabel)) }),
          };
        } else {
          ev(t('eng.ev.topics'), 'guardrail', 'ok', jitter(2, 8), t('eng.ev.topicsOk'));
          verdicts.push({ id: 'topics', verdict: 'passed', detail: t('eng.verdictDetail.onTopic') });
        }
      } else if (!operator && agent.guardrails.includes('topics')) {
        verdicts.push({ id: 'topics', verdict: 'off', detail: t('eng.verdictDetail.ruleDisabled') });
      }

      /* 2 — escalation to a human */
      const gEsc = guardById(s, 'escalate');
      let escalatedNote = '';
      if (!operator && !out && agent.guardrails.includes('escalate')) {
        const raw = matchTerm(q, gEsc.triggers || []);
        const trigger = raw ? termLabel(raw) : null;
        if (raw && guardActive(s, agent, 'escalate')) {
          const ref = `ESC-${s.counters.escalationSeq + 1}`;
          ev(t('eng.ev.escalation'), 'guardrail', 'escalated', jitter(4, 14),
            t('eng.ev.escalationDetail', { trigger, queue: guardQueue(gEsc) }));
          verdicts.push({ id: 'escalate', verdict: 'escalated', detail: t('eng.verdictDetail.trigger', { term: trigger }) });
          status = 'escalated';
          out = {
            text: t('eng.escalated', { trigger, queue: guardQueue(gEsc), ref, agent: agentName(agent) }),
          };
        } else if (raw) {
          escalatedNote = t('eng.escalationOffNote');
          verdicts.push({ id: 'escalate', verdict: 'off', detail: t('eng.verdictDetail.triggerIgnored', { term: trigger }) });
          ev(t('eng.ev.escalation'), 'guardrail', 'skipped', jitter(2, 6), t('eng.ev.escalationOff'));
        } else {
          verdicts.push({ id: 'escalate', verdict: 'passed', detail: t('eng.verdictDetail.noTriggers') });
        }
      }

      /* 3 — tool availability */
      if (!out && needTools.length) {
        for (const tid of needTools) {
          const tool = toolById(s, tid);
          if (!tool) continue;
          if (!tool.connected) {
            ev(t('eng.ev.toolCall', { tool: tid }), 'tool', 'failed', jitter(8, 30), t('eng.ev.connectionOff'));
            status = 'failed';
            out = {
              text: t('eng.toolDown', {
                name: toolName(tool),
                description: toolDesc(tool),
                fallback: agent.tools.filter((x) => x !== tid).map((x) => toolName(toolById(s, x)))
                  .filter(Boolean).join(t('common.or')) || t('eng.ownHistory'),
              }),
            };
            break;
          }
          toolCalls++;
          ev(`${tool.id}.${(tool.ops[0] || 'read')}`, 'tool', 'ok', jitter(Math.round(tool.latencyMs * 0.6), Math.round(tool.latencyMs * 1.4)), t('eng.ev.toolResponded', { name: toolName(tool) }));
        }
      }

      /* 4 — the intent itself */
      if (!out) {
        ev(t('eng.ev.plan'), 'agent', 'ok', jitter(40, 160), t('eng.ev.planDetail', { intent: intent.id }));
        try {
          out = baseAnswer(q, { ...ctx, state: s, agent });
        } catch (err) {
          status = 'failed';
          out = { text: t('eng.edgeOfData') };
        }
        if (typeof out === 'string') out = { text: out };
        out = out || { text: t('eng.nothingForThat') };
        if (escalatedNote) out = { ...out, text: (out.text || '') + escalatedNote };
        ev(t('eng.ev.compose'), 'agent', 'ok', jitter(180, 620), t('eng.ev.composeDetail', { n: String(out.text || '').length }));
      }

      /* 5 — PII redaction */
      if (agent.guardrails.includes('pii')) {
        if (guardActive(s, agent, 'pii')) {
          const r = redactOut(out);
          out = r.out;
          ev(t('eng.ev.pii'), 'guardrail', r.n ? 'redacted' : 'ok', jitter(2, 9),
            r.n ? t('eng.ev.piiMasked', { n: r.n }) : t('eng.ev.piiClean'));
          verdicts.push({ id: 'pii', verdict: r.n ? 'redacted' : 'passed', detail: r.n ? t('eng.verdictDetail.masked', { n: r.n }) : t('eng.verdictDetail.clean') });
        } else {
          verdicts.push({ id: 'pii', verdict: 'off', detail: t('eng.verdictDetail.piiOff') });
          ev(t('eng.ev.pii'), 'guardrail', 'skipped', jitter(1, 4), t('eng.ev.piiOff'));
        }
      }

      /* 6 — cost ceiling */
      const est = estimateTurn(agent, q, out.text, toolCalls);
      const gCost = guardById(s, 'cost');
      if (agent.guardrails.includes('cost')) {
        if (guardActive(s, agent, 'cost')) {
          if (est.costPaise > gCost.limitPaise) {
            const first = String(out.text || '').split(/\n{2,}/)[0];
            const est$ = rupees(est.costPaise); const lim$ = rupees(gCost.limitPaise);
            out = {
              ...out,
              table: null,
              text: t('eng.costStop', { first, est: est$, limit: lim$ }),
            };
            status = 'blocked';
            ev(t('eng.ev.cost'), 'guardrail', 'blocked', jitter(2, 6), t('eng.ev.costOver', { est: est$, limit: lim$ }));
            verdicts.push({ id: 'cost', verdict: 'blocked', detail: t('eng.verdictDetail.costOver', { est: est$, limit: lim$ }) });
          } else {
            const est$ = rupees(est.costPaise); const lim$ = rupees(gCost.limitPaise);
            ev(t('eng.ev.cost'), 'guardrail', 'ok', jitter(1, 5), t('eng.ev.costUnder', { est: est$, limit: lim$ }));
            verdicts.push({ id: 'cost', verdict: 'passed', detail: t('eng.verdictDetail.costOf', { est: est$, limit: lim$ }) });
          }
        } else {
          verdicts.push({ id: 'cost', verdict: 'off', detail: t('eng.verdictDetail.noCeiling') });
        }
      }

      const latencyMs = events.reduce((a, e) => a + e.ms, 0);
      ev(t('eng.ev.streamed'), 'system', status === 'success' ? 'ok' : status, jitter(20, 90), t('eng.ev.streamedDetail', { n: est.tokensOut }));

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

      /* A turn that was refused, handed over or truncated does not get to
         offer buttons — the answer the reader sees is the guardrail's,
         not the intent's. */
      if (status !== 'success' && out.actions) out = { ...out, actions: null };

      const meta = t('eng.meta', {
        trace: intent.trace || t('eng.metaTrace'),
        tin: num(est.tokensIn), tout: num(est.tokensOut), cost: rupees(est.costPaise),
      });
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
      id: 'self', match: [/what (can|do) you do|who are you|capabilit|your job|introduce|what are you able/i, 'about you'],
      trace: t('bot.self.trace'),
      answer: (q, { state }) => {
        const rows = catalogueFor(agent.id);
        return {
          text: t('bot.self.text', {
            name: agentName(agent), model: agent.model, description: agentDesc(agent),
            tools: joinList(agent.tools.map((id) => toolName(toolById(state, id))).filter(Boolean)) || t('bot.self.noTools'),
            guards: joinList(agent.guardrails.map((id) => guardName(guardById(state, id))).filter(Boolean)) || t('bot.self.noGuards'),
            owner: agent.owner, created: fmtDate(agent.createdAt),
          }),
          table: T(t('bot.sayThis'), rows.map((r) => [r.ask, r.does])),
          suggestions: rows.slice(0, 3).map((r) => r.ask).concat(suggestionsFor(agent)[0]),
        };
      },
    },
    {
      id: 'stats', match: [/success rate|how are you doing|your (stats|numbers|performance)|how many runs|reliab/i],
      trace: t('bot.stats.trace'),
      answer: (q, { state }) => {
        const mine = state.runs.filter((r) => r.agentId === agent.id);
        const ok = mine.filter((r) => r.status === 'success').length;
        const avg = mine.length ? Math.round(sum(mine, (r) => r.durationMs) / mine.length) : agent.avgLatencyMs;
        return {
          text: t('bot.stats.text', {
            runs30d: num(agent.runs30d), rate: pct(agent.successRate, 1),
            held: mine.length, ok, avg: num(avg),
          }),
          table: T(t('bot.stats.head'), Object.entries(countBy(mine, (r) => r.status)).map(([k, v]) => [statusLabel(k), String(v)])),
        };
      },
    },
    {
      id: 'toolstate', match: [/what tools|which tools|connections?|integrat|what are you connected/i],
      trace: t('bot.toolstate.trace'),
      answer: (q, { state }) => ({
        text: t('bot.toolstate.text'),
        table: T(t('bot.toolstate.head'), agent.tools.map((id) => {
          const tool = toolById(state, id);
          return [toolName(tool), tool.connected ? t('common.connected') : t('bot.toolstate.offBold'), num(tool.calls30d)];
        })),
      }),
    },
    {
      id: 'guardstate', match: [/guardrail|what are you not allowed|restrict|rules|policy|safe/i],
      trace: t('bot.guardstate.trace'),
      answer: (q, { state }) => ({
        text: t('bot.guardstate.text'),
        table: T(t('bot.guardstate.head'), state.guardrails.map((g) => [
          guardName(g),
          agent.guardrails.includes(g.id) ? t('common.yes') : t('common.no'),
          g.enabled ? t('common.enabled') : t('bot.guardstate.offBold'),
        ])),
      }),
    },
    {
      id: 'contact', tools: agent.tools.includes('crm') ? ['crm'] : [],
      match: [/contact|email address|phone number|reach (them|him|her)|get in touch|who do i (call|write)/i],
      trace: t('bot.contact.trace'),
      answer: (q, { state }) => {
        let who; let where; let email; let phone = null; let note;
        if (agent.id === 'onboard') {
          const a = state.accounts.find((x) => x.stuckDays >= 5) || state.accounts[0];
          who = a.contact; where = a.name; email = a.email;
          note = t('bot.contact.accountNote', { id: a.id, n: a.stepIdx + 1 });
        } else {
          const tk = sortDesc(state.tickets.filter((x) => x.status === 'open'), (x) => x.ageH)[0] || state.tickets[0];
          who = tk.contact; where = tk.customer; email = tk.email; phone = tk.phone;
          note = t('bot.contact.ticketNote', { id: tk.id, h: tk.ageH });
        }
        return {
          text: t('bot.contact.text', {
            who, where, email, phone: phone ? ` · ${phone}` : '', note,
            masking: guardActive(state, agent, 'pii') ? t('bot.contact.maskingOn') : t('bot.contact.maskingOff'),
          }),
        };
      },
    },
    {
      id: 'spend', match: [/cost|spend|token|how much (does|do)|budget|price/i],
      trace: t('bot.spend.trace'),
      answer: (q, { state }) => {
        const mine = state.runs.filter((r) => r.agentId === agent.id);
        const paise = sum(mine, (r) => r.costPaise);
        const tokens = sum(mine, (r) => r.tokensIn + r.tokensOut);
        const cap = guardById(state, 'cost');
        return {
          text: t('bot.spend.text', {
            n: mine.length, total: rupees(paise), tokens: num(tokens),
            each: rupees(mine.length ? Math.round(paise / mine.length) : 0),
            ceiling: cap.enabled ? t('bot.spend.ceilingOn', { amount: rupees(cap.limitPaise) }) : t('bot.spend.ceilingOff'),
          }),
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
      trace: t('bot.queue.trace'),
      answer: (q, { state }) => {
        const all = state.tickets;
        const open = all.filter((x) => x.status === 'open');
        const waiting = all.filter((x) => x.status === 'waiting');
        const escalated = all.filter((x) => x.status === 'escalated');
        const oldest = sortDesc(open, (x) => x.ageH).slice(0, 5);
        return {
          text: t('bot.queue.text', {
            open: open.length, waiting: waiting.length, escalated: escalated.length,
            resolved: all.length - open.length - waiting.length - escalated.length,
          }),
          table: T(t('bot.queue.head'), oldest.map((x) => [x.id, x.customer, priorityLabel(x.priority), t('bot.queue.hours', { n: x.ageH })])),
        };
      },
    },
    {
      id: 'ticket', tools: ['ticketing', 'crm'], match: [/tck-\d+|ticket \d+|show me a ticket|open a ticket|details of/i],
      trace: t('bot.ticket.trace'),
      answer: (q, { state }) => {
        const m = q.match(/tck-?(\d+)/i);
        const tk = (m && state.tickets.find((x) => x.id.toLowerCase() === `tck-${m[1]}`)) || sortDesc(state.tickets.filter((x) => x.status === 'open'), (x) => x.ageH)[0];
        if (!tk) return { text: t('bot.ticket.none') };
        return {
          text: t('bot.ticket.text', {
            id: tk.id, subject: subjectLabel(tk.subject), customer: tk.customer, contact: tk.contact,
            email: tk.email, phone: tk.phone, channel: channelLabel(tk.channel),
            category: categoryLabel(tk.category), priority: priorityLabel(tk.priority),
            sentiment: sentimentLabel(tk.sentiment), age: tk.ageH, assignee: tk.assignee,
            desk: categoryLabel(tk.category).toLowerCase(),
          }),
        };
      },
    },
    {
      id: 'priority', tools: ['ticketing'], match: [/priorit|urgent|critical|most important|what should i do first/i],
      trace: t('bot.priority.trace'),
      answer: (q, { state }) => {
        const c = countBy(state.tickets, (x) => x.priority);
        const urgent = state.tickets.filter((x) => x.priority === 'Urgent' || x.priority === 'High');
        return {
          text: t('bot.priority.text', { urgent: urgent.length, total: state.tickets.length }),
          table: T(t('bot.priority.head'), ['Urgent', 'High', 'Normal', 'Low'].filter((k) => c[k]).map((k) => [priorityLabel(k), String(c[k])])),
        };
      },
    },
    {
      id: 'route', tools: ['ticketing', 'crm'], match: [/route|assign|who should|which desk|hand (it )?to|owner/i],
      trace: t('bot.route.trace'),
      answer: (q, { state }) => {
        const load = countBy(state.tickets.filter((x) => x.status !== 'resolved'), (x) => x.assignee);
        const rows = sortDesc(Object.entries(load).map(([k, v]) => ({ k, v })), (x) => x.v).slice(0, 5);
        const lightest = rows[rows.length - 1];
        return {
          text: t('bot.route.text', {
            lightest: lightest ? lightest.k : t('bot.route.unassigned'), n: lightest ? lightest.v : 0,
          }),
          table: T(t('bot.route.head'), rows.map((r) => [r.k, String(r.v)])),
        };
      },
    },
    {
      id: 'draft', tools: ['ticketing', 'email'], match: [/draft|reply|respond|write (a )?(response|message)|answer the customer/i],
      trace: t('bot.draft.trace'),
      answer: (q, { state }) => {
        const tk = sortDesc(state.tickets.filter((x) => x.status === 'open'), (x) => x.ageH)[0];
        return {
          text: t('bot.draft.text', {
            id: tk.id, customer: tk.customer, email: tk.email, first: tk.contact.split(' ')[0],
            subject: subjectLabel(tk.subject).toLowerCase(), desk: categoryLabel(tk.category).toLowerCase(),
            priority: priorityLabel(tk.priority), assignee: tk.assignee,
          }),
        };
      },
    },
    {
      id: 'themes', tools: ['ticketing'], match: [/theme|common (issue|problem)|what are people (asking|complaining)|categor|pattern/i],
      trace: t('bot.themes.trace'),
      answer: (q, { state }) => {
        const c = countBy(state.tickets, (x) => x.category);
        const rows = sortDesc(Object.entries(c).map(([k, v]) => ({ k, v })), (x) => x.v);
        const top = rows[0];
        return {
          text: t('bot.themes.text', {
            top: categoryLabel(top.k), n: top.v, total: state.tickets.length,
            share: pct(pctOf(top.v, state.tickets.length), 0),
          }),
          table: T(t('bot.themes.head'), rows.map((r) => [categoryLabel(r.k), String(r.v), pct(pctOf(r.v, state.tickets.length), 0)])),
        };
      },
    },
    {
      id: 'sla', tools: ['ticketing'], match: [/sla|response time|how fast|first reply|breach|late/i],
      trace: t('bot.sla.trace'),
      answer: (q, { state }) => {
        const all = state.tickets;
        const avg = Math.round(sum(all, (x) => x.firstReplyMins) / all.length);
        const late = all.filter((x) => x.firstReplyMins > 120);
        return {
          text: t('bot.sla.text', {
            avg, late: late.length,
            where: Object.keys(countBy(late, (x) => x.category)).slice(0, 2).map(categoryLabel).join(t('common.and')) || t('bot.sla.noCategory'),
          }),
          table: T(t('bot.sla.head'), sortDesc(late, (x) => x.firstReplyMins).slice(0, 5)
            .map((x) => [x.id, categoryLabel(x.category), t('bot.sla.mins', { n: x.firstReplyMins })])),
        };
      },
    },
    {
      id: 'customer', tools: ['crm'], match: [/customer|account|who is|which client|worst affected/i],
      trace: t('bot.customer.trace'),
      answer: (q, { state }) => {
        const c = countBy(state.tickets, (x) => x.customer);
        const rows = sortDesc(Object.entries(c).map(([k, v]) => ({ k, v })), (x) => x.v).slice(0, 5);
        const worst = rows[0];
        const sample = state.tickets.find((x) => x.customer === worst.k);
        return {
          text: t('bot.customer.text', { name: worst.k, n: worst.v, contact: sample.contact, email: sample.email }),
          table: T(t('bot.customer.head'), rows.map((r) => [r.k, String(r.v)])),
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
      trace: t('bot.extract.trace'),
      answer: (q, { state }) => {
        const m = q.match(/inv-?(\d+)/i);
        const inv = (m && state.invoices.find((x) => x.id.toLowerCase() === `inv-${m[1]}`)) || state.invoices[0];
        const tax = Math.round(inv.amount * inv.taxPct / 100);
        const rows = t('bot.extract.rows');
        return {
          text: t('bot.extract.text', {
            id: inv.id, vendor: inv.vendor, date: fmtDate(inv.dateIso),
            confidence: inv.confidence, status: invStatusLabel(inv.status),
          }),
          table: T(t('bot.extract.head'), [
            [rows.vendor, inv.vendor], [rows.number, inv.id], [rows.date, fmtDate(inv.dateIso)],
            [rows.po, inv.po], [rows.lines, String(inv.lines)],
            [rows.tax, `${inv.taxPct}% · ${money(tax)}`],
            [rows.total, money(inv.amount)],
            [rows.posted, inv.postedToSheet ? t('common.yes') : t('common.no')],
          ]),
        };
      },
    },
    {
      id: 'review', match: [/review|low confidence|failed|exception|parked|problem|reject/i],
      trace: t('bot.review.trace'),
      answer: (q, { state }) => {
        const bad = state.invoices.filter((x) => x.status !== 'extracted');
        return {
          text: t('bot.review.text', { n: bad.length }),
          table: T(t('bot.review.head'), sortDesc(bad, (x) => -x.confidence).slice(0, 6)
            .map((x) => [x.id, x.vendor, `${x.confidence}%`, invStatusLabel(x.status)])),
        };
      },
    },
    {
      id: 'totals', tools: ['sheets'], match: [/total|how much|payable|value|sum|this month/i],
      trace: t('bot.totals.trace'),
      answer: (q, { state }) => {
        const all = state.invoices;
        const posted = all.filter((x) => x.postedToSheet);
        return {
          text: t('bot.totals.text', {
            total: money(sum(all, (x) => x.amount)), n: all.length,
            posted: money(sum(posted, (x) => x.amount)),
          }),
          table: T(t('bot.totals.head'), [
            [t('bot.totals.posted'), String(posted.length), money(sum(posted, (x) => x.amount))],
            [t('bot.totals.held'), String(all.length - posted.length), money(sum(all.filter((x) => !x.postedToSheet), (x) => x.amount))],
          ]),
        };
      },
    },
    {
      id: 'vendor', match: [/vendor|supplier|who (are we|do we) (paying|pay)|biggest/i],
      trace: t('bot.vendor.trace'),
      answer: (q, { state }) => {
        const g = {};
        state.invoices.forEach((i) => { g[i.vendor] = (g[i.vendor] || 0) + i.amount; });
        const rows = sortDesc(Object.entries(g).map(([k, v]) => ({ k, v })), (x) => x.v);
        return {
          text: t('bot.vendor.text', { n: rows.length, top: rows[0].k, value: money(rows[0].v) }),
          table: T(t('bot.vendor.head'), rows.slice(0, 6).map((r) => [r.k, money(r.v)])),
        };
      },
    },
    {
      id: 'tax', match: [/tax|gst|vat|duty/i],
      trace: t('bot.tax.trace'),
      answer: (q, { state }) => {
        const bands = {};
        state.invoices.forEach((i) => {
          const v = Math.round(i.amount * i.taxPct / 100);
          bands[i.taxPct] = (bands[i.taxPct] || 0) + v;
        });
        const total = sum(Object.values(bands), (x) => x);
        return {
          text: t('bot.tax.text', { total: money(total) }),
          table: T(t('bot.tax.head'), Object.entries(bands).sort((a, b) => a[0] - b[0]).map(([k, v]) => [`${k}%`, money(v)])),
        };
      },
    },
    {
      id: 'duplicate', match: [/duplicate|double|twice|same invoice|repeat/i],
      trace: t('bot.duplicate.trace'),
      answer: (q, { state }) => {
        const seen = {}; const dupes = [];
        state.invoices.forEach((i) => {
          const k = `${i.vendor}|${Math.round(i.amount / 1000)}`;
          if (seen[k]) dupes.push([seen[k].id, i.id, i.vendor, money(i.amount)]);
          else seen[k] = i;
        });
        return {
          text: dupes.length ? t('bot.duplicate.some', { n: dupes.length }) : t('bot.duplicate.none'),
          table: dupes.length ? T(t('bot.duplicate.head'), dupes.slice(0, 5)) : null,
        };
      },
    },
    {
      id: 'po', match: [/po\b|purchase order|variance|mismatch|does not match|difference/i],
      trace: t('bot.po.trace'),
      answer: (q, { state }) => {
        const off = state.invoices.filter((x) => x.variance !== 0);
        return {
          text: t('bot.po.text', { n: off.length }),
          table: T(t('bot.po.head'), sortDesc(off, (x) => Math.abs(x.variance)).slice(0, 6).map((x) => [x.id, x.po, money(x.variance)])),
        };
      },
    },
    {
      id: 'post', tools: ['sheets'], match: [/post|append|sheet|workbook|where does it go|output/i],
      trace: t('bot.post.trace'),
      answer: (q, { state }) => {
        const posted = state.invoices.filter((x) => x.postedToSheet);
        return {
          text: t('bot.post.text', { n: posted.length }),
          table: T(t('bot.post.head'), posted.slice(0, 6).map((x) => [x.id, x.vendor, money(x.amount), `${x.confidence}%`])),
        };
      },
    },
  ];
}

/* ---- Onboarding Assistant ---- */
function onboardPack() {
  /* The five notes themselves live in `bot.howto.kb`, in the same order.
     Only the matching stays here, because a regular expression is not a
     sentence a reader ever sees. */
  const KB = [
    /catalogue|import|products|upload/i,
    /invite|team|user|seat|colleague/i,
    /payment|card|billing|pay/i,
    /report|schedule|weekly|summary/i,
    /order|first order|place/i,
  ];
  return [
    {
      id: 'checklist', match: [/checklist|steps|setup|onboard|what.*next|getting started/i],
      trace: t('bot.checklist.trace'),
      answer: (q, { state }) => {
        const rows = ONBOARD_STEPS.map((step, i) => [onboardStepLabel(step), String(state.accounts.filter((a) => a.stepIdx === i).length)]);
        return {
          text: t('bot.checklist.text'),
          table: T(t('bot.checklist.head'), rows),
        };
      },
    },
    {
      id: 'stuck', tools: ['crm'], match: [/stuck|blocked|behind|not moving|drop|slow|at risk/i],
      trace: t('bot.stuck.trace'),
      answer: (q, { state }) => {
        const stuck = state.accounts.filter((a) => a.stuckDays >= 5);
        return {
          text: t('bot.stuck.text', { n: stuck.length }),
          table: T(t('bot.stuck.head'), sortDesc(stuck, (x) => x.stuckDays).slice(0, 6)
            .map((a) => [a.name, onboardStepLabel(a.step), String(a.stuckDays), a.owner])),
        };
      },
    },
    {
      id: 'account', tools: ['crm'], match: [/acc-\d+|status of|where is|progress|how is .* doing/i],
      trace: t('bot.account.trace'),
      answer: (q, { state }) => {
        const m = q.match(/acc-?(\d+)/i);
        const named = state.accounts.find((a) => q.toLowerCase().includes(a.name.toLowerCase().split(' ')[0]));
        const a = (m && state.accounts.find((x) => x.id.toLowerCase() === `acc-${m[1]}`)) || named || sortDesc(state.accounts, (x) => x.stuckDays)[0];
        return {
          text: t('bot.account.text', {
            name: a.name, id: a.id, plan: planLabel(a.plan), seats: a.seats, region: regionLabel(a.region),
            n: a.stepIdx + 1, step: onboardStepLabel(a.step), days: a.stuckDays,
            owner: a.owner, contact: a.contact, email: a.email,
            verdict: a.stuckDays >= 5 ? t('bot.account.past') : t('bot.account.normal'),
          }),
        };
      },
    },
    {
      id: 'howto', match: [/how do i|how to|where do i|can i|explain|walk me through/i],
      trace: t('bot.howto.trace'),
      answer: (q) => {
        const i = KB.findIndex((re) => re.test(q));
        if (i < 0) return { text: t('bot.howto.miss') };
        const note = t('bot.howto.kb')[i];
        return { text: `**${note[0]}**\n\n${note[1]}` };
      },
    },
    {
      id: 'book', tools: ['crm', 'email'], match: [/book|call|meeting|demo|talk to someone|schedule a/i],
      trace: t('bot.book.trace'),
      answer: (q, { state }) => {
        const a = sortDesc(state.accounts, (x) => x.stuckDays)[0];
        return {
          text: t('bot.book.text', { owner: a.owner, name: a.name, email: a.email, step: onboardStepLabel(a.step) }),
        };
      },
    },
    {
      id: 'welcome', tools: ['email'], match: [/welcome|draft|write to|email them|nudge|follow up/i],
      trace: t('bot.welcome.trace'),
      answer: (q, { state }) => {
        const a = state.accounts.find((x) => x.stuckDays >= 5) || state.accounts[0];
        return {
          text: t('bot.welcome.text', {
            name: a.name, contact: a.contact, email: a.email, first: a.contact.split(' ')[0],
            n: a.stepIdx + 1, step: onboardStepLabel(a.step), owner: a.owner,
          }),
        };
      },
    },
    {
      id: 'ttfv', match: [/how long|time to|first value|average|typical|days to/i],
      trace: t('bot.ttfv.trace'),
      answer: (q, { state }) => {
        const done = state.accounts.filter((a) => a.stepIdx >= 4);
        const avgStuck = Math.round(sum(state.accounts, (a) => a.stuckDays) / state.accounts.length);
        return {
          text: t('bot.ttfv.text', { done: done.length, total: state.accounts.length, avg: avgStuck }),
          table: T(t('bot.ttfv.head'), ['Starter', 'Growth', 'Scale'].map((p) => {
            const set = state.accounts.filter((a) => a.plan === p);
            return [planLabel(p), String(set.length), String(set.filter((a) => a.stepIdx >= 4).length)];
          })),
        };
      },
    },
    {
      id: 'region', match: [/region|where are|kerala|riyadh|jeddah|location|geograph/i],
      trace: t('bot.region.trace'),
      answer: (q, { state }) => {
        const c = countBy(state.accounts, (a) => a.region);
        return {
          text: t('bot.region.text', { n: Object.keys(c).length }),
          table: T(t('bot.region.head'), sortDesc(Object.entries(c).map(([k, v]) => ({ k, v })), (x) => x.v)
            .map((r) => [regionLabel(r.k), String(r.v)])),
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
      trace: t('bot.weekly.trace'),
      answer: (q, { state }) => {
        const m = state.metrics;
        const cur = m[m.length - 1]; const prev = m[m.length - 2];
        const d = pctOf(cur.runs - prev.runs, prev.runs);
        const rows = t('bot.weekly.rows');
        return {
          text: t('bot.weekly.text', {
            week: m.length, runs: num(cur.runs), dir: d >= 0 ? t('bot.weekly.up') : t('bot.weekly.down'),
            delta: pct(Math.abs(d), 1), clean: num(cur.success), rate: pct(pctOf(cur.success, cur.runs), 1),
            escalations: cur.escalations, tokens: num(cur.tokens), cost: rupees(cur.costPaise),
          }),
          table: T(t('bot.weekly.head'), [
            [rows.runs, num(cur.runs), num(prev.runs)],
            [rows.clean, num(cur.success), num(prev.success)],
            [rows.escalations, String(cur.escalations), String(prev.escalations)],
            [rows.cost, rupees(cur.costPaise), rupees(prev.costPaise)],
          ]),
        };
      },
    },
    {
      id: 'compare', tools: ['sheets'], match: [/compare|last week|change|delta|trend|versus|vs\b/i],
      trace: t('bot.compare.trace'),
      answer: (q, { state }) => {
        const m = state.metrics;
        const cur = m[m.length - 1]; const prev = m[m.length - 2];
        const rows = t('bot.weekly.rows');
        const line = (k, a, b) => [k, num(a), num(b), `${a - b >= 0 ? '+' : ''}${pct(pctOf(a - b, b || 1), 1)}`];
        return {
          text: t('bot.compare.text'),
          table: T(t('bot.compare.head'), [
            line(rows.runs, cur.runs, prev.runs),
            line(rows.clean, cur.success, prev.success),
            line(rows.escalations, cur.escalations, prev.escalations),
            line(rows.tokens, cur.tokens, prev.tokens),
          ]),
        };
      },
    },
    {
      id: 'numbers', tools: ['sheets'], match: [/runs|volume|throughput|how many|series|history/i],
      trace: t('bot.numbers.trace'),
      answer: (q, { state }) => ({
        text: t('bot.numbers.text'),
        table: T(t('bot.numbers.head'), state.metrics.map((w) => [w.label, num(w.runs), num(w.success), String(w.escalations)])),
      }),
    },
    {
      id: 'anomaly', tools: ['sheets'], match: [/anomal|spike|unusual|outlier|what moved|jump|drop/i],
      trace: t('bot.anomaly.trace'),
      answer: (q, { state }) => {
        const m = state.metrics;
        const moves = [];
        for (let i = 1; i < m.length; i++) {
          const d = pctOf(m[i].runs - m[i - 1].runs, m[i - 1].runs);
          if (Math.abs(d) >= 10) moves.push([m[i].label, num(m[i].runs), `${d >= 0 ? '+' : ''}${pct(d, 1)}`]);
        }
        return {
          text: moves.length ? t('bot.anomaly.some', { n: moves.length }) : t('bot.anomaly.none'),
          table: moves.length ? T(t('bot.anomaly.head'), moves) : null,
        };
      },
    },
    {
      id: 'exec', match: [/exec|paragraph|prose|write|plain english|for the board/i],
      trace: t('bot.exec.trace'),
      answer: (q, { state }) => {
        const m = state.metrics; const cur = m[m.length - 1];
        const rate = pctOf(cur.success, cur.runs);
        return {
          text: t('bot.exec.text', {
            runs: num(cur.runs), rate: pct(rate, 1), escalations: cur.escalations,
            cost: rupees(cur.costPaise), each: rupees(Math.round(cur.costPaise / cur.runs)),
          }),
        };
      },
    },
    {
      id: 'distribution', tools: ['email'], match: [/distribution|who gets|recipients|send to|list|mailing/i],
      trace: t('bot.distribution.trace'),
      answer: (q, { state }) => ({
        text: t('bot.distribution.text', {
          list: state.settings.distribution,
          state: (state.workflows.find((w) => w.id === 'wf-report') || {}).enabled
            ? t('common.enabled') : t('bot.distribution.disabledBold'),
        }),
      }),
    },
    {
      id: 'source', tools: ['sheets'], match: [/source|where.*data|fresh|stale|workbook|trust|accurate/i],
      trace: t('bot.source.trace'),
      answer: (q, { state }) => ({
        text: t('bot.source.text', {
          written: ago(new Date(Date.now() - 5400000)), runs: state.runs.length,
          newest: ago(state.runs[0].startedAt), retention: state.settings.retentionDays,
          status: agentStatusLabel(state.agents.find((a) => a.id === 'report').status),
        }),
      }),
    },
    {
      id: 'quality', match: [/quality|accuracy|wrong|mistake|hallucin|make (things )?up/i],
      trace: t('bot.quality.trace'),
      answer: (q, { state }) => {
        const a = state.agents.find((x) => x.id === 'report');
        return { text: t('bot.quality.text', { rate: pct(a.successRate, 1) }) };
      },
    },
  ];
}

/* ---- generic pack for agents created in the UI ---- */
function genericPack() {
  return [
    {
      id: 'workspace', match: [/workspace|overview|what.*here|summary|status/i],
      trace: t('bot.generic.wsTrace'),
      answer: (q, { state }) => ({
        text: t('bot.generic.wsText', {
          agents: state.agents.length, workflows: state.workflows.length,
          tools: state.tools.filter((x) => x.connected).length, runs: state.runs.length,
        }),
      }),
    },
    {
      id: 'runsmine', match: [/run|history|did i|last time/i],
      trace: t('bot.generic.runsTrace'),
      answer: (q, { state, agent }) => {
        const mine = state.runs.filter((r) => r.agentId === agent.id);
        return {
          text: mine.length
            ? t('bot.generic.runsSome', { n: mine.length, when: ago(mine[0].startedAt), status: statusLabel(mine[0].status) })
            : t('bot.generic.runsNone'),
        };
      },
    },
    {
      id: 'help', match: [/help|what can i ask|examples|suggest/i],
      trace: t('bot.generic.helpTrace'),
      answer: () => ({ text: t('bot.generic.helpText') }),
    },
  ];
}

const PACK_BUILDERS = {
  triage: triagePack,
  invoice: invoicePack,
  onboard: onboardPack,
  report: reportPack,
};

/* Four chips per agent, because the panel shows four. One of them is
   always an instruction rather than a question, so the first thing a
   reader tries can be something the agent actually does. */
/* Suggestion chips and guardrail probes come from the dictionary, so they
   are asked in the language the reader is using. Built on demand rather than
   at module load: the dictionary is not resolved until the language has been
   chosen. */
export const agentSuggestions = () => t('bot.suggestions');
export const consoleSuggestions = () => t('bot.consoleSuggestions');

/* Every phrase that must reach an action intent, with the intent it has
   to land on. The self-test walks this list; the About modal prints it. */
/* Built on demand rather than at module load: the catalogue reads the
   dictionary, and the dictionary is not resolved until the language has
   been chosen. */
export const actionProbes = () => {
  const C = catalogue();
  return [
    ...C.console.map((r) => ({ scope: 'console', q: r.ask, expect: r.id, does: r.does })),
    ...['triage', 'invoice', 'onboard', 'report'].flatMap((id) =>
      (C[id] || []).map((r) => ({ scope: id, q: r.ask, expect: r.id, does: r.does }))),
    ...C.shared.map((r) => ({ scope: 'shared', q: r.ask, expect: r.id, does: r.does })),
  ];
};

export const scopeLabel = () => ({
  console: t('bot.consoleName'),
  shared: t('bot.everyAgent'),
  triage: dl('agentName', 'Support Triage'),
  invoice: dl('agentName', 'Invoice Reader'),
  onboard: dl('agentName', 'Onboarding Assistant'),
  report: dl('agentName', 'Report Writer'),
});

export const guardrailProbes = () => t('bot.guardProbes');

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
      const words = ((g && g.blocked) || []).flatMap(aliases);
      return words.length ? [new RegExp(`(${words.map(reEsc).join('|')})`, 'i')] : [];
    },
    get trace() { return t('bot.offtopic.trace'); },
    answer: (q, { state, agent }) => {
      const g = guardById(state, 'topics');
      const bound = agent.guardrails.includes('topics');
      return {
        text: t('bot.offtopic.text', {
          why: bound ? t('bot.offtopic.whyBound') : t('bot.offtopic.whyUnbound'),
          topics: joinList((g.topics || []).map(termLabel)),
          fix: bound ? t('bot.offtopic.fixBound') : t('bot.offtopic.fixUnbound'),
        }),
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
      const words = ((g && g.triggers) || []).flatMap(aliases);
      return words.length ? [new RegExp(`(${words.map(reEsc).join('|')})`, 'i')] : [];
    },
    get trace() { return t('bot.handover.trace'); },
    answer: (q, { state, agent }) => {
      const g = guardById(state, 'escalate');
      const bound = agent.guardrails.includes('escalate');
      return {
        text: t('bot.handover.text', {
          agent: agentName(agent), model: agent.model, queue: guardQueue(g),
          triggers: joinList((g.triggers || []).map(termLabel)),
          state: bound ? t('bot.handover.stateBound') : t('bot.handover.stateUnbound'),
          fix: bound ? t('bot.handover.fixBound') : t('bot.handover.fixUnbound'),
        }),
      };
    },
  };
}

/* Extra match patterns out of the dictionary, keyed by intent id. The
   English half is empty on purpose — the packs already carry English
   regular expressions — and the Arabic half is what lets a question asked
   in Arabic reach the same intent as its English twin. A `match` that is a
   getter stays a getter, so the blocked-term catchers keep tracking the
   current word list. */
function withExtra(pack) {
  const extra = t('bot.extra') || {};
  return pack.map((intent) => {
    const add = extra[intent.id];
    if (!add || !add.length) return intent;
    const patterns = add.map((p) => (p instanceof RegExp ? p : new RegExp(p, 'i')));
    const wrapped = Object.create(Object.getPrototypeOf(intent), Object.getOwnPropertyDescriptors(intent));
    const own = Object.getOwnPropertyDescriptor(intent, 'match');
    if (own && own.get) {
      Object.defineProperty(wrapped, 'match', {
        get() { return [...[].concat(own.get.call(intent) || []), ...patterns]; },
        configurable: true, enumerable: true,
      });
    } else {
      wrapped.match = [...[].concat(intent.match || []), ...patterns];
    }
    return wrapped;
  });
}

export function packFor(agent, store, session) {
  const build = PACK_BUILDERS[agent.id] || genericPack;
  /* Actions first: an instruction must outscore the question that shares
     its vocabulary, and `_route` keeps the earliest intent on a tie. */
  const pack = [
    ...(store ? agentActions(store, agent, session) : []),
    ...build(),
    ...sharedIntents(agent),
  ];
  /* Catchers go last so a real intent always outscores them. They exist so
     that no suggestion chip or guardrail probe can ever reach the fallback. */
  if (store) pack.push(offTopicIntent(store), handoverIntent(store));
  return withExtra(pack);
}

/* ============================================================
   Assistant factories
   ============================================================ */
export const defaultAgentSuggestions = () => t('bot.defaultSuggestions');

export const suggestionsFor = (agent) => agentSuggestions()[agent.id] || defaultAgentSuggestions();

export function buildAgentBot(store, agent, { emit } = {}) {
  /* The session is how an action reaches back into the conversation it
     was offered in: `bot` to ask something again, `lastQ` to know what. */
  const session = { bot: null, lastQ: '' };
  const intents = packFor(agent, store, session).map((i) => wrapIntent(i, agent, store, emit, session));
  const suggestions = suggestionsFor(agent);
  const bot = new Assistant({
    name: agentName(agent),
    initials: agent.initials,
    tag: t('bot.agentTag', { model: agent.model, status: agentStatusLabel(agent.status) }),
    greeting: t('bot.agentGreeting', { name: agentName(agent), purpose: agentPurpose(agent) }),
    suggestions,
    intents,
    fallbacks: t('bot.agentFallbacks', {
      s0: suggestions[0], s1: suggestions[1], s2: suggestions[2], s3: suggestions[3],
      purpose: agentPurpose(agent),
    }),
    note: t('bot.note'),
    ui: assistUi(),
    context: () => ({ state: store.state, agent }),
  });
  session.bot = bot;
  return bot;
}

/* ---------- the global console assistant ---------- */
export function buildConsoleBot(store) {
  const S = () => store.state;
  const intents = [
    /* instructions before questions — see packFor */
    ...consoleActions(store),
    {
      id: 'capabilities',
      match: [/what can you do|what can i ask|capabilit|what are you able|help me|what do you do/i, 'your abilities'],
      trace: t('bot.capabilities.trace'),
      answer: () => ({
        text: t('bot.capabilities.text'),
        table: T(t('bot.sayThis'), catalogue().console.map((r) => [r.ask, r.does])),
        suggestions: catalogue().console.slice(0, 3).map((r) => r.ask).concat(consoleSuggestions()[0]),
      }),
    },
    {
      id: 'health',
      match: [
        /how (is|are|'s) .*(doing|going|looking)|how are we|health|overview|dashboard|summar(y|ise)/i,
        /(workspace|things|everything|it all) (doing|going|ok|okay|alright)/i,
        'status',
      ],
      trace: t('bot.health.trace'),
      answer: () => {
        const s = S();
        const ok = s.runs.filter((r) => r.status === 'success').length;
        return {
          text: t('bot.health.text', {
            workspace: s.settings.workspace,
            live: s.agents.filter((a) => a.status === 'live').length,
            wfOn: s.workflows.filter((w) => w.enabled).length, wfAll: s.workflows.length,
            up: s.tools.filter((x) => x.connected).length, tools: s.tools.length,
            runs: s.runs.length, ok, rate: pct(pctOf(ok, s.runs.length), 1),
          }),
          table: T(t('bot.health.head'), Object.entries(countBy(s.runs, (r) => r.status)).map(([k, v]) => [statusLabel(k), String(v)])),
        };
      },
    },
    {
      id: 'failed', match: [/fail|error|broke|went wrong|red/i],
      trace: t('bot.failed.trace'),
      answer: () => {
        const s = S();
        const f = s.runs.filter((r) => r.status === 'failed');
        return {
          text: t('bot.failed.text', { n: f.length }),
          table: T(t('bot.failed.head'), f.slice(0, 6).map((r) => [r.id, agentName(agentById(s, r.agentId)) || r.agentId, ago(r.startedAt)])),
        };
      },
    },
    {
      id: 'escalations', match: [/escalat|handed over|human|tier 2/i],
      trace: t('bot.escalations.trace'),
      answer: () => {
        const s = S();
        const e = s.runs.filter((r) => r.status === 'escalated');
        const g = guardById(s, 'escalate');
        return {
          text: t('bot.escalations.text', {
            n: e.length, queue: guardQueue(g),
            state: g.enabled ? t('common.on') : t('bot.escalations.offBold'),
            triggers: joinList((g.triggers || []).map(termLabel)),
          }),
          table: T(t('bot.escalations.head'), e.slice(0, 6).map((r) => [r.id, agentName(agentById(s, r.agentId)) || r.agentId, ago(r.startedAt)])),
        };
      },
    },
    {
      id: 'cost', match: [/cost|spend|token|bill|budget|expensive/i],
      trace: t('bot.cost.trace'),
      answer: () => {
        const s = S();
        const paise = sum(s.runs, (r) => r.costPaise);
        const rows = s.agents.map((a) => {
          const mine = s.runs.filter((r) => r.agentId === a.id);
          return { a, p: sum(mine, (r) => r.costPaise), n: mine.length };
        });
        return {
          text: t('bot.cost.text', {
            total: rupees(paise), runs: s.runs.length,
            tokens: num(sum(s.runs, (r) => r.tokensIn + r.tokensOut)),
            ceiling: rupees(guardById(s, 'cost').limitPaise),
          }),
          table: T(t('bot.cost.head'), sortDesc(rows, (r) => r.p).map((r) => [agentName(r.a), String(r.n), rupees(r.p)])),
        };
      },
    },
    {
      id: 'busiest', match: [/busiest|most used|which agent|top agent|workload/i],
      trace: t('bot.busiest.trace'),
      answer: () => {
        const s = S();
        return {
          text: t('bot.busiest.text', { name: agentName(sortDesc(s.agents, (a) => a.runs30d)[0]) }),
          table: T(t('bot.busiest.head'), sortDesc(s.agents, (a) => a.runs30d)
            .map((a) => [agentName(a), num(a.runs30d), pct(a.successRate, 1), agentStatusLabel(a.status)])),
        };
      },
    },
    {
      id: 'tools', match: [/tool|connection|integrat|disconnect|connected/i],
      trace: t('bot.tools.trace'),
      answer: () => {
        const s = S();
        const off = s.tools.filter((x) => !x.connected);
        return {
          text: off.length
            ? t('bot.tools.some', { n: off.length, names: joinList(off.map(toolName)) })
            : t('bot.tools.none'),
          table: T(t('bot.tools.head'), s.tools.map((x) => {
            const n = s.agents.filter((a) => a.tools.includes(x.id)).length;
            return [toolName(x), x.connected ? t('common.connected') : t('bot.tools.offBold'), t('bot.tools.nAgents', { n })];
          })),
        };
      },
    },
    {
      id: 'guardrails', match: [/guardrail|rule|redact|pii|policy|allowed topic|ceiling/i],
      trace: t('bot.guardrails.trace'),
      answer: () => {
        const s = S();
        return {
          text: t('bot.guardrails.text'),
          table: T(t('bot.guardrails.head'), s.guardrails.map((g) => [
            guardName(g), g.enabled ? t('common.enabled') : t('bot.guardrails.offBold'),
            String(s.agents.filter((a) => a.guardrails.includes(g.id)).length),
          ])),
        };
      },
    },
    {
      id: 'workflows', match: [/workflow|pipeline|steps|trigger|automation/i],
      trace: t('bot.workflows.trace'),
      answer: () => {
        const s = S();
        return {
          text: t('bot.workflows.text', { n: s.workflows.length }),
          table: T(t('bot.workflows.head'), s.workflows.map((w) => [
            workflowName(w), triggerLabel(w), String(w.steps.filter((x) => x.enabled).length),
            w.enabled ? t('common.on') : t('bot.workflows.offBold'),
          ])),
        };
      },
    },
    {
      id: 'latency', match: [/slow|latency|fast|duration|how long/i],
      trace: t('bot.latency.trace'),
      answer: () => {
        const s = S();
        const slow = sortDesc(s.runs, (r) => r.durationMs).slice(0, 5);
        const avg = Math.round(sum(s.runs, (r) => r.durationMs) / s.runs.length);
        return {
          text: t('bot.latency.text', { avg: num(avg) }),
          table: T(t('bot.latency.head'), slow.map((r) => [
            r.id, agentName(agentById(s, r.agentId)) || r.agentId, t('common.ms', { n: num(r.durationMs) }),
          ])),
        };
      },
    },
    {
      id: 'agentlookup', match: [/support triage|invoice reader|onboarding assistant|report writer|tell me about the/i],
      trace: t('bot.agentlookup.trace'),
      answer: (q) => {
        const s = S();
        const low = q.toLowerCase();
        const a = s.agents.find((x) => low.includes(x.name.toLowerCase()) || low.includes(String(agentName(x)).toLowerCase())) || s.agents[0];
        return {
          text: t('bot.agentlookup.text', {
            name: agentName(a), model: a.model, status: agentStatusLabel(a.status), description: agentDesc(a),
            tools: joinList(a.tools.map((id) => toolName(toolById(s, id))).filter(Boolean)),
            guards: joinList(a.guardrails.map((id) => guardName(guardById(s, id))).filter(Boolean)),
            runs: num(a.runs30d), rate: pct(a.successRate, 1),
          }),
        };
      },
    },
    {
      id: 'recent', match: [/recent|last|what happened|latest|activity|just now/i],
      trace: t('bot.recent.trace'),
      answer: () => {
        const s = S();
        return {
          text: t('bot.recent.text'),
          table: T(t('bot.recent.head'), s.runs.slice(0, 6).map((r) => [
            ago(r.startedAt), agentName(agentById(s, r.agentId)) || r.agentId,
            triggerName(r.trigger), statusLabel(r.status),
          ])),
        };
      },
    },
    {
      id: 'howitworks', match: [/how does this work|is this real|demo|fake|model|offline/i],
      trace: t('bot.howitworks.trace'),
      answer: () => ({ text: t('bot.howitworks.text') }),
    },
  ];
  return new Assistant({
    name: t('bot.consoleName'),
    initials: 'AC',
    tag: t('bot.consoleTag'),
    greeting: t('bot.consoleGreeting'),
    suggestions: consoleSuggestions(),
    intents: withExtra(intents),
    fallbacks: t('bot.consoleFallbacks', { s0: consoleSuggestions()[0], s1: consoleSuggestions()[1] }),
    note: t('bot.consoleNote'),
    ui: assistUi(),
    context: () => ({ state: store.state }),
  });
}
