/* ============================================================
   Agentline — action intents.

   An intent in `agent.js` reads the workspace and answers. An intent in
   this file reads the workspace, says what it understood, and offers to
   *change* it. The contract, enforced by lib/assistant.js:

     answer(q, ctx) -> { text, table?, actions:[{ label, doingLabel?, run }] }
     run()          -> { text, table?, meta?, suggestions?, actions? }

   Two rules hold everywhere below:

     1. Nothing is written until the reader presses the button. The
        answer names the exact records it would touch first.
     2. Every applied action reports before → after and lands in a screen
        you can open — Runs, Workflows, Guardrails, Tools or Agents.

   There is still no model. The "understanding" is a regular expression
   plus a lookup against the demo records.
   ============================================================ */

import { num, pct, ago, money, fmtDate } from '../lib/ui.js';
import {
  toolById, guardById, agentById, workflowById, rupees, ONBOARD_STEPS,
} from './data.js';
import {
  refreshApp, goTo, requestWorkflowRun, writeActionRun, jit,
} from './runner.js';

const T = (head, rows) => ({ head, rows });
const lower = (s) => String(s || '').toLowerCase();
const sortDesc = (arr, f) => [...arr].sort((a, b) => f(b) - f(a));
const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);

/* ---------- resolving what the reader named ---------- */
function bestByName(list, q, nameOf) {
  const t = lower(q);
  let best = null; let score = 0;
  list.forEach((x) => {
    const words = lower(nameOf(x)).split(/\W+/).filter((w) => w.length > 3);
    const n = words.filter((w) => t.includes(w)).length;
    if (n > score) { score = n; best = x; }
  });
  return best;
}

const findWorkflow = (s, q) => bestByName(s.workflows, q, (w) => w.name)
  || s.workflows.find((w) => w.enabled) || s.workflows[0];

const findAgent = (s, q) => bestByName(s.agents, q, (a) => a.name);

function findTool(s, q) {
  const t = lower(q);
  return s.tools.find((x) => t.includes(lower(x.name))) || bestByName(s.tools, q, (x) => `${x.name} ${x.kind}`) || null;
}

const GUARD_WORDS = [
  ['pii', /\b(pii|redact|redaction|mask|contact details)\b/i],
  ['topics', /\b(topic|topics|allowed topics|off-?topic|subject)\b/i],
  ['escalate', /\b(escalat\w*|handover|hand-?over|human|tier 2)\b/i],
  ['cost', /\b(cost|ceiling|budget|spend cap|limit)\b/i],
];
function findGuard(s, q) {
  const hit = GUARD_WORDS.find(([, re]) => re.test(q));
  return guardById(s, hit ? hit[0] : 'pii');
}

/* on / off / toggle, read out of the wording */
function direction(q) {
  if (/\b(off|disable|deactivate|stop|remove|switch off|turn off|unplug|disconnect|pause|mute)\b/i.test(q)) return false;
  if (/\b(on|enable|re-?enable|activate|reactivate|start|switch on|turn on|connect|reconnect|resume)\b/i.test(q)) return true;
  return null;
}

const ticketFrom = (s, q) => {
  const m = q.match(/tck-?(\d+)/i);
  return (m && s.tickets.find((x) => lower(x.id) === `tck-${m[1]}`))
    || sortDesc(s.tickets.filter((x) => x.status === 'open'), (x) => x.ageH)[0]
    || s.tickets[0];
};
const invoiceFrom = (s, q) => {
  const m = q.match(/inv-?(\d+)/i);
  return (m && s.invoices.find((x) => lower(x.id) === `inv-${m[1]}`))
    || sortDesc(s.invoices.filter((x) => !x.postedToSheet && x.status === 'extracted'), (x) => x.confidence)[0]
    || sortDesc(s.invoices.filter((x) => !x.postedToSheet), (x) => x.confidence)[0]
    || s.invoices[0];
};
const accountFrom = (s, q) => {
  const m = q.match(/acc-?(\d+)/i);
  return (m && s.accounts.find((x) => lower(x.id) === `acc-${m[1]}`))
    || bestByName(s.accounts, q, (a) => a.name)
    || sortDesc(s.accounts.filter((a) => a.stepIdx < 5), (a) => a.stuckDays)[0]
    || s.accounts[0];
};

/* a "nothing has happened yet" line, repeated deliberately */
const PENDING = '\n\nNothing has changed yet — press the button and I will apply it, then tell you what moved.';

/* ============================================================
   The catalogue. One row per thing an agent can actually do, with the
   phrasing that reaches it. Used by the "What can you do?" answers, the
   About modal and the self-test, so those three can never drift from
   what is really wired up.
   ============================================================ */
export const ACTION_CATALOGUE = {
  console: [
    { id: 'wfrun', ask: 'Run the invoice intake workflow', does: 'Runs it now, streams every step into the Workflows run log, and writes the run into Runs with its trace.' },
    { id: 'wfstep', ask: 'Add a step to the invoice intake workflow', does: 'Appends a named step to the pipeline and shows the step count before and after.' },
    { id: 'wfstep', ask: 'Remove the Notify downstream step', does: 'Takes that step out of the pipeline, so the next run skips it entirely.' },
    { id: 'toolconn', ask: 'Disconnect the Ticketing connection', does: 'Flips the connection off and lists the agents and workflow steps that stop working because of it.' },
    { id: 'agentstate', ask: 'Pause the Report Writer', does: 'Moves the agent between live and paused; workflow steps that call it are skipped while it is paused.' },
    { id: 'rerun', ask: 'Re-run the last failed run', does: 'Re-checks the connections it needs, runs it again and opens the new trace.' },
    { id: 'guardtoggle', ask: 'Turn off PII redaction', does: 'Toggles the rule for the whole workspace and reports which agents it changes.' },
  ],
  shared: [
    { id: 'guardtoggle', ask: 'Turn off PII redaction and ask that again', does: 'Toggles the rule, then re-asks your previous question so you can see the difference in the reply.' },
    { id: 'toolconn', ask: 'Reconnect the CRM', does: 'Connects or disconnects one of my tools; the questions that need it start working, or start being refused.' },
  ],
  triage: [
    { id: 'ticketaction', ask: 'Escalate the oldest ticket', does: 'Raises an ESC reference in the Tier 2 queue, marks the ticket escalated and writes an escalated run you can open in Runs.' },
    { id: 'ticketaction', ask: 'Assign TCK-2041 to the lightest desk', does: 'Moves the ticket to the person with the fewest open items and records the change as a run.' },
  ],
  invoice: [
    { id: 'postinvoice', ask: 'Post the next clean invoice for approval', does: 'Appends the invoice to Payables Q3, marks it pending approval, and writes the run with the sheet call in the trace.' },
  ],
  onboard: [
    { id: 'advance', ask: 'Advance the most stuck account', does: 'Moves that account to the next checklist step, resets its days-on-step, and records the change as a run.' },
  ],
  report: [
    { id: 'genreport', ask: 'Generate and store this week\'s report', does: 'Writes the weekly summary from the metrics, stores it under Settings and records the run.' },
  ],
};

export const catalogueFor = (agentId) => [
  ...(ACTION_CATALOGUE[agentId] || []),
  ...ACTION_CATALOGUE.shared,
];

/* ============================================================
   Console actions
   ============================================================ */
export function consoleActions(store) {
  const S = () => store.state;

  return [
    /* ---------- run a workflow now ---------- */
    {
      id: 'wfrun',
      match: [/\brun\b[^?]*\b(workflow|pipeline|intake|triage|report)\b/i, /^\s*run the /i, /\b(kick off|trigger|start)\b[^?]*\b(workflow|pipeline)\b/i],
      trace: 'read the workflow definition and the connection registry',
      answer: (q) => {
        const s = S();
        const wf = findWorkflow(s, q);
        const on = wf.steps.filter((x) => x.enabled);
        return {
          text: `You mean **${wf.name}**. Here is what running it now would do — ${on.length} enabled step${on.length === 1 ? '' : 's'} of ${wf.steps.length}, triggered manually rather than by "${wf.trigger.label.toLowerCase()}".\n\nIt writes one run into **Runs**, stamps the last-run time on the workflow, and produces: ${wf.outputs.join(', ')}.${PENDING}`,
          table: T(['#', 'Step', 'Runs against'], on.map((st, i) => [
            String(i + 1), st.name,
            st.kind === 'tool' ? `${(toolById(s, st.ref) || {}).name || st.ref}${(toolById(s, st.ref) || {}).connected ? '' : ' — **disconnected**'}`
              : st.kind === 'agent' ? `${(agentById(s, st.ref) || {}).name || st.ref}` : st.kind,
          ])),
          actions: [{
            label: `Run ${wf.name} now`,
            doingLabel: 'Running the workflow…',
            run: async () => {
              const before = S().runs.length;
              const r = await requestWorkflowRun(store, wf);
              const after = S().runs.length;
              const w = workflowById(S(), wf.id) || wf;
              return {
                text: `**${wf.name}** finished **${r.status}** in ${num(r.durationMs)} ms.\n\nThe steps streamed into the run log on the Workflows screen, and the full trace is in Runs under \`${r.runId}\`.`,
                table: T(['', 'Before', 'After'], [
                  ['Runs held', String(before), String(after)],
                  ['Last run', 'not run here yet', ago(w.lastRunAt || new Date().toISOString())],
                  ['Steps clean', '—', `${r.ok} of ${r.steps.length}`],
                  ['Cost', '—', rupees(r.costPaise)],
                ]),
                meta: `run ${r.runId} written to this browser`,
                actions: [{ label: 'Open the trace', run: () => { goTo(`runs/${r.runId}`); return { text: `Opened \`${r.runId}\`. Every step, its duration and its status are on that screen.` }; } }],
                suggestions: ['What failed?', 'Re-run the last failed run', 'How is the workspace doing?'],
              };
            },
          }, {
            label: 'Open the pipeline',
            run: () => { goTo(`workflows/${wf.id}`); return { text: `Opened **${wf.name}**. Nothing was run.` }; },
          }],
        };
      },
    },

    /* ---------- add or remove a step ---------- */
    {
      id: 'wfstep',
      match: [/\b(add|append|insert)\b[^?]*\bstep\b/i, /\b(remove|delete|drop|take out)\b[^?]*\bstep\b/i],
      trace: 'read the pipeline and worked out where the step goes',
      answer: (q) => {
        const s = S();
        const wf = findWorkflow(s, q);
        const removing = /\b(remove|delete|drop|take out)\b/i.test(q);

        if (removing) {
          const named = bestByName(wf.steps, q, (st) => st.name) || wf.steps[wf.steps.length - 1];
          if (!named) return { text: `**${wf.name}** has no steps left to remove.` };
          return {
            text: `You want a step out of **${wf.name}**. The closest match in that pipeline is **${named.name}**.${PENDING}`,
            table: T(['Field', 'Value'], [
              ['Workflow', wf.name],
              ['Step', named.name],
              ['Position', `${wf.steps.indexOf(named) + 1} of ${wf.steps.length}`],
              ['Kind', named.kind],
              ['Effect', 'the next run skips it — outputs that depend on it stop being produced'],
            ]),
            actions: [{
              label: `Remove "${named.name}"`,
              doingLabel: 'Removing the step…',
              run: () => {
                const before = (workflowById(S(), wf.id) || wf).steps.length;
                store.update((st) => {
                  const w = st.workflows.find((x) => x.id === wf.id);
                  w.steps = w.steps.filter((x) => x.id !== named.id);
                });
                const after = (workflowById(S(), wf.id) || wf).steps.length;
                refreshApp();
                return {
                  text: `Removed **${named.name}** from **${wf.name}**.`,
                  table: T(['', 'Before', 'After'], [
                    ['Steps', String(before), String(after)],
                    ['Pipeline', '—', (workflowById(S(), wf.id) || wf).steps.map((x) => x.name).join(' → ') || 'empty'],
                  ]),
                  meta: 'workflow updated in this browser',
                  actions: [{ label: 'Open the pipeline', run: () => { goTo(`workflows/${wf.id}`); return { text: 'The step is gone from the node list.' }; } }],
                };
              },
            }],
          };
        }

        const quoted = q.match(/["“](.+?)["”]/) || q.match(/\b(?:called|named)\s+(.+?)(?:\s+to\b|\s+in\b|$)/i);
        const name = (quoted ? quoted[1] : 'Notify the owner').trim();
        return {
          text: `You want a new step on **${wf.name}**. I would append it at the end, as a tool call on the shared mailbox, enabled from the start.\n\nName it yourself by putting it in quotes — "add a step called Check credit limit" — otherwise I use the default below.${PENDING}`,
          table: T(['Field', 'Value'], [
            ['Workflow', wf.name],
            ['Step name', name],
            ['Kind', 'Tool call · Email'],
            ['Position', `${wf.steps.length + 1} of ${wf.steps.length + 1}`],
            ['Typical duration', '280 ms'],
          ]),
          actions: [{
            label: `Add "${name}"`,
            doingLabel: 'Adding the step…',
            run: () => {
              const before = (workflowById(S(), wf.id) || wf).steps.length;
              store.update((st) => {
                const w = st.workflows.find((x) => x.id === wf.id);
                w.steps.push({
                  id: `s${Date.now().toString(36)}`,
                  name, kind: 'tool', ref: 'email',
                  detail: 'mail.send to the workflow owner',
                  avgMs: 280, enabled: true,
                });
              });
              const w = workflowById(S(), wf.id) || wf;
              refreshApp();
              return {
                text: `Added **${name}** to **${wf.name}** as step ${w.steps.length}.`,
                table: T(['', 'Before', 'After'], [
                  ['Steps', String(before), String(w.steps.length)],
                  ['Pipeline', '—', w.steps.map((x) => x.name).join(' → ')],
                ]),
                meta: 'workflow updated in this browser',
                actions: [
                  { label: 'Open the pipeline', run: () => { goTo(`workflows/${wf.id}`); return { text: 'The new node is at the bottom of the list, above Outputs.' }; } },
                  { label: `Run ${wf.name} now`, doingLabel: 'Running…', run: async () => { const r = await requestWorkflowRun(store, workflowById(S(), wf.id) || wf); return { text: `Ran it with the new step in place — finished **${r.status}** in ${num(r.durationMs)} ms as \`${r.runId}\`.` }; } },
                ],
              };
            },
          }],
        };
      },
    },

    /* ---------- connect / disconnect a tool ---------- */
    {
      id: 'toolconn',
      match: [/\b(disconnect|reconnect|unplug|plug in|connect)\b/i, /\b(turn|switch)\s+(the\s+)?\w*\s*(crm|email|sheets|ticketing|webhook)\b/i],
      trace: 'read the connection registry and everything bound to it',
      answer: (q) => {
        const s = S();
        const tool = findTool(s, q) || s.tools.find((t) => !t.connected) || s.tools[0];
        const want = direction(q);
        const target = want === null ? !tool.connected : want;
        const users = s.agents.filter((a) => a.tools.includes(tool.id));
        const steps = s.workflows.flatMap((w) => w.steps.filter((st) => st.kind === 'tool' && st.ref === tool.id).map((st) => `${w.name} · ${st.name}`));
        if (target === tool.connected) {
          return {
            text: `**${tool.name}** is already ${tool.connected ? 'connected' : 'disconnected'}, so there is nothing to change.\n\n${tool.description}`,
            actions: [{
              label: tool.connected ? `Disconnect ${tool.name} instead` : `Connect ${tool.name} instead`,
              run: () => applyTool(store, tool.id, !tool.connected),
            }],
          };
        }
        return {
          text: `You want **${tool.name}** ${target ? 'connected' : 'disconnected'}. That is one switch, and it changes what ${users.length} agent${users.length === 1 ? '' : 's'} and ${steps.length} workflow step${steps.length === 1 ? '' : 's'} can do.${PENDING}`,
          table: T(['Touched', 'Detail'], [
            ['Connection', `${tool.name} — ${tool.account}`],
            ['State', `${tool.connected ? 'connected' : 'disconnected'} → ${target ? 'connected' : 'disconnected'}`],
            ['Agents', users.map((a) => a.name).join(', ') || 'none'],
            ['Workflow steps', steps.join(', ') || 'none'],
          ]),
          actions: [{
            label: target ? `Connect ${tool.name}` : `Disconnect ${tool.name}`,
            doingLabel: 'Applying…',
            run: () => applyTool(store, tool.id, target),
          }],
        };
      },
    },

    /* ---------- pause / activate an agent ---------- */
    {
      id: 'agentstate',
      match: [/\b(pause|unpause|resume|activate|reactivate|deactivate)\b/i, /\b(take|bring)\b[^?]*\b(offline|online)\b/i],
      trace: 'read the agent record and the workflow steps that call it',
      answer: (q) => {
        const s = S();
        const agent = findAgent(s, q) || s.agents.find((a) => a.status !== 'live') || s.agents[0];
        const want = direction(q);
        const target = want === null ? (agent.status === 'live' ? 'paused' : 'live') : (want ? 'live' : 'paused');
        const steps = s.workflows.flatMap((w) => w.steps.filter((st) => st.kind === 'agent' && st.ref === agent.id).map((st) => `${w.name} · ${st.name}`));
        if (target === agent.status) {
          const other = agent.status === 'live' ? 'paused' : 'live';
          return {
            text: `**${agent.name}** is already **${agent.status}** — ${agent.purpose}\n\nThere is nothing to apply, but I can move it the other way.`,
            actions: [{
              label: other === 'live' ? `Activate ${agent.name}` : `Pause ${agent.name}`,
              doingLabel: 'Applying…',
              run: () => applyAgentStatus(store, agent.id, other),
            }],
          };
        }
        return {
          text: `You want **${agent.name}** set to **${target}**. A paused agent is still readable and still answers in the Playground — what changes is the workflow: a step that calls a paused agent is skipped, which turns the whole run **blocked**.${PENDING}`,
          table: T(['Touched', 'Detail'], [
            ['Agent', `${agent.name} · ${agent.model}`],
            ['Status', `${agent.status} → ${target}`],
            ['Workflow steps', steps.join(', ') || 'none'],
            ['Runs held', String(s.runs.filter((r) => r.agentId === agent.id).length)],
          ]),
          actions: [{
            label: target === 'live' ? `Activate ${agent.name}` : `Pause ${agent.name}`,
            doingLabel: 'Applying…',
            run: () => applyAgentStatus(store, agent.id, target),
          }],
        };
      },
    },

    /* ---------- re-run a failed run ---------- */
    {
      id: 'rerun',
      match: [/\bre-?run\b/i, /\bretry\b/i, /\b(run|try)\s+(it|that)\s+again\b/i, /\bfailed run\b/i],
      trace: 'read the failed runs and re-checked their connections',
      answer: (q) => {
        const s = S();
        const m = q.match(/\b(run_[a-z0-9]+)\b/i);
        const run = (m && s.runs.find((r) => lower(r.id) === lower(m[1])))
          || s.runs.find((r) => r.status === 'failed')
          || s.runs.find((r) => r.status !== 'success')
          || s.runs[0];
        if (!run) return { text: 'There are no runs held in this workspace yet.' };
        const agent = agentById(s, run.agentId) || {};
        const bad = (run.trace || []).find((t) => t.status === 'failed' || t.status === 'blocked') || {};
        const offNow = (agent.tools || []).filter((t) => !(toolById(s, t) || {}).connected);
        return {
          text: `The one I would re-run is \`${run.id}\` — ${agent.name || run.agentId}, ${run.status}, ${ago(run.startedAt)}.\n\nIt stopped at **${bad.label || 'the last step'}**${bad.detail ? ` — ${bad.detail}` : ''}. A re-run re-checks the connections before it starts, so it only succeeds if the cause is gone. Right now ${offNow.length ? `**${offNow.map((t) => (toolById(s, t) || {}).name).join(', ')}** ${offNow.length === 1 ? 'is' : 'are'} still disconnected` : 'every connection that run needs is up'}.${PENDING}`,
          table: T(['Field', 'Value'], [
            ['Run', run.id],
            ['Agent', agent.name || run.agentId],
            ['Status', run.status],
            ['Failed at', bad.label || '—'],
            ['Would now', offNow.length ? 'fail again' : 'succeed'],
          ]),
          actions: [{
            label: 'Re-run it',
            doingLabel: 'Re-running…',
            run: () => {
              const s2 = S();
              const a = agentById(s2, run.agentId) || {};
              const stillOff = (a.tools || []).filter((t) => !(toolById(s2, t) || {}).connected);
              const status = stillOff.length ? 'failed' : 'success';
              const trace = (run.trace || []).map((ev) => ({
                ...ev,
                ms: Math.max(1, Math.round(ev.ms * (0.7 + Math.random() * 0.7))),
                status: (ev.status === 'failed' || ev.status === 'blocked') && status === 'success' ? 'ok' : ev.status,
                detail: (ev.status === 'failed' || ev.status === 'blocked') && status === 'success' ? 'cleared on the re-run' : ev.detail,
              }));
              trace.push({
                label: 'Re-run accepted', kind: 'system', status: status === 'success' ? 'ok' : 'failed', ms: jit(6, 22),
                detail: `re-run of ${run.id}${stillOff.length ? ` · ${stillOff.map((t) => (toolById(s2, t) || {}).name).join(', ')} still down` : ' · connections verified first'}`,
              });
              const before = s2.runs.length;
              const w = writeActionRun(store, {
                agentId: run.agentId, workflowId: run.workflowId, trigger: 'Manual re-run',
                status, trace, tokensIn: run.tokensIn, tokensOut: run.tokensOut,
                question: `re-run of ${run.id}`,
                guardrails: run.guardrails || [],
              });
              refreshApp();
              return {
                text: `Re-ran \`${run.id}\` as \`${w.id}\` — finished **${status}**.${stillOff.length ? `\n\nSame failure, same cause: ${stillOff.map((t) => (toolById(S(), t) || {}).name).join(', ')} ${stillOff.length === 1 ? 'is' : 'are'} disconnected. Reconnect and ask me to re-run it again.` : ''}`,
                table: T(['', 'Before', 'After'], [
                  ['Runs held', String(before), String(S().runs.length)],
                  ['Status', run.status, status],
                  ['Duration', `${num(run.durationMs)} ms`, `${num(w.durationMs)} ms`],
                ]),
                meta: `run ${w.id} written to this browser`,
                actions: [
                  { label: 'Open the new trace', run: () => { goTo(`runs/${w.id}`); return { text: 'That is the full trace, step by step.' }; } },
                  ...(stillOff.length ? [{ label: `Connect ${(toolById(S(), stillOff[0]) || {}).name}`, run: () => applyTool(store, stillOff[0], true) }] : []),
                ],
              };
            },
          }],
        };
      },
    },

    /* ---------- toggle a guardrail (workspace view) ---------- */
    guardToggleIntent(store, null, null),
  ];
}

/* ---------- shared: apply an agent status change ---------- */
function applyAgentStatus(store, agentId, target) {
  const s0 = store.state;
  const a0 = agentById(s0, agentId) || {};
  const before = a0.status;
  const liveBefore = s0.agents.filter((a) => a.status === 'live').length;
  const steps = s0.workflows.flatMap((w) => w.steps.filter((st) => st.kind === 'agent' && st.ref === agentId).map((st) => `${w.name} · ${st.name}`));
  store.update((st) => { const a = st.agents.find((x) => x.id === agentId); a.status = target; });
  const s = store.state;
  refreshApp();
  return {
    text: `**${a0.name}** is now **${target}**.${steps.length ? `\n\n${target === 'live' ? 'The workflow steps that call it run again.' : 'The workflow steps that call it are skipped from now on, which turns those runs **blocked** rather than **success**.'}` : ''}`,
    table: T(['', 'Before', 'After'], [
      ['Status', before, target],
      ['Live agents', String(liveBefore), String(s.agents.filter((x) => x.status === 'live').length)],
      ['Workflow steps', steps.join(', ') || 'none', steps.length ? (target === 'live' ? 'will run' : 'will be skipped') : 'none'],
    ]),
    meta: 'agent record updated in this browser',
    actions: [{ label: 'Open Agents', run: () => { goTo('agents'); return { text: `The card for ${a0.name} reads **${target}**.` }; } }],
  };
}

/* ---------- shared: apply a connection change ---------- */
function applyTool(store, toolId, target) {
  const before = toolById(store.state, toolId) || {};
  const wasConnected = before.connected;
  store.update((st) => {
    const t = st.tools.find((x) => x.id === toolId);
    t.connected = target;
    if (target) t.connectedAt = new Date().toISOString();
  });
  const s = store.state;
  const tool = toolById(s, toolId);
  const users = s.agents.filter((a) => a.tools.includes(toolId));
  const steps = s.workflows.flatMap((w) => w.steps.filter((st) => st.kind === 'tool' && st.ref === toolId));
  refreshApp();
  return {
    text: `**${tool.name}** is now **${target ? 'connected' : 'disconnected'}**.\n\n${target
      ? `Every question and every workflow step that needs it works again from the next call onwards.`
      : `Anything that needs it is refused from the next call onwards, with the reason written into the trace rather than a blank error.`}`,
    table: T(['', 'Before', 'After'], [
      ['Connection', wasConnected ? 'connected' : 'disconnected', target ? 'connected' : 'disconnected'],
      ['Connections up', String(s.tools.filter((t) => t.connected).length - (target ? 1 : -1)), `${s.tools.filter((t) => t.connected).length} of ${s.tools.length}`],
      ['Agents affected', String(users.length), users.map((a) => a.name).join(', ') || 'none'],
      ['Workflow steps', String(steps.length), target ? 'will run' : 'will fail'],
    ]),
    meta: 'connection registry updated in this browser',
    actions: [{ label: 'Open Tools & connections', run: () => { goTo('tools'); return { text: `The card for ${tool.name} reads **${target ? 'connected' : 'off'}**.` }; } }],
  };
}

/* ============================================================
   Shared agent actions — every agent gets these two
   ============================================================ */

/* Toggle a guardrail, then ask the previous question again so the
   difference is in the log rather than in a description of it.
   `session` carries the bot and the last question; the console passes
   null for both and gets the workspace-level version. */
export function guardToggleIntent(store, agent, session) {
  const DEMO_Q = {
    pii: 'who do I contact about the oldest open item?',
    topics: 'what are the salary bands here?',
    escalate: 'the customer is angry and wants a refund',
    cost: 'what does a run cost?',
  };
  return {
    id: 'guardtoggle',
    operator: true,
    match: [
      /\b(turn|switch|toggle|flip|set)\b[^?]*\b(redact\w*|pii|topics?|escalation|escalate|ceiling|cost|guardrail|rule)\b/i,
      /\b(disable|enable|re-?enable|deactivate|reactivate)\b[^?]*\b(redact\w*|pii|topics?|escalation|escalate|ceiling|cost|guardrail|rule)\b/i,
      /\bguardrails? (on|off)\b/i,
    ],
    trace: 'read the guardrail record and everything bound to it',
    answer: (q) => {
      const s = store.state;
      const g = findGuard(s, q);
      const want = direction(q);
      const target = want === null ? !g.enabled : want;
      const bound = s.agents.filter((a) => a.guardrails.includes(g.id));
      const prev = (session && session.lastQ) || DEMO_Q[g.id];
      const mine = agent ? agent.guardrails.includes(g.id) : null;

      if (target === g.enabled) {
        return {
          text: `**${g.name}** is already ${g.enabled ? 'on' : 'off'}. ${g.summary}`,
          actions: [{ label: `Turn it ${g.enabled ? 'off' : 'on'} instead`, run: () => applyGuard(store, g.id, !g.enabled, agent, session, prev) }],
        };
      }

      return {
        text: `You want **${g.name}** turned **${target ? 'on' : 'off'}**. It applies to the whole workspace, not just ${agent ? 'me' : 'one agent'} — ${bound.length} agent${bound.length === 1 ? '' : 's'} ${bound.length === 1 ? 'has' : 'have'} it bound.${agent ? (mine ? ' I am one of them.' : ' I am not one of them, so my own replies will not change.') : ''}\n\n${g.detail}\n\n${agent ? `Straight after applying it I will ask **"${prev}"** again, so the difference lands in this conversation instead of being described.` : 'Ask an agent the matching question in the Playground afterwards and the reply changes.'}${PENDING}`,
        table: T(['Touched', 'Detail'], [
          ['Guardrail', g.name],
          ['State', `${g.enabled ? 'on' : 'off'} → ${target ? 'on' : 'off'}`],
          ['Agents bound', bound.map((a) => a.name).join(', ') || 'none'],
          ['Visible in', 'Guardrails, and the verdict column of every run after this'],
        ]),
        actions: [{
          label: agent ? `Turn ${g.name} ${target ? 'on' : 'off'} and re-ask` : `Turn ${g.name} ${target ? 'on' : 'off'}`,
          doingLabel: 'Applying…',
          run: () => applyGuard(store, g.id, target, agent, session, prev),
        }],
      };
    },
  };
}

function applyGuard(store, guardId, target, agent, session, prev) {
  const s0 = store.state;
  const before = guardById(s0, guardId).enabled;
  store.update((st) => { const g = st.guardrails.find((x) => x.id === guardId); g.enabled = target; });
  const s = store.state;
  const g = guardById(s, guardId);
  const bound = s.agents.filter((a) => a.guardrails.includes(guardId));
  refreshApp();
  const willAsk = agent && session && session.bot;
  return {
    text: `**${g.name}** is now **${target ? 'on' : 'off'}**.${willAsk ? `\n\nRe-asking **"${prev}"** now — compare it with the answer above.` : ''}`,
    table: T(['', 'Before', 'After'], [
      ['Rule', before ? 'on' : 'off', target ? 'on' : 'off'],
      ['Rules on', String(s.guardrails.filter((x) => x.enabled).length - (target ? 1 : -1)), `${s.guardrails.filter((x) => x.enabled).length} of ${s.guardrails.length}`],
      ['Agents affected', String(bound.length), bound.map((a) => a.name).join(', ') || 'none'],
    ]),
    meta: 'guardrail updated in this browser',
    actions: willAsk ? null : [{ label: 'Open Guardrails', run: () => { goTo('guardrails'); return { text: `The card for ${g.name} reads **${target ? 'on' : 'off'}**.` }; } }],
    then: willAsk ? () => { setTimeout(() => session.bot.ask(prev), 260); } : null,
  };
}

/* Connect or disconnect one of this agent's own tools. */
export function toolConnIntent(store, agent) {
  return {
    id: 'toolconn',
    operator: true,
    match: [/\b(disconnect|reconnect|unplug|plug in|connect)\b/i, /\b(turn|switch)\s+(the\s+)?\w*\s*(crm|email|sheets|ticketing|webhook)\b/i],
    trace: 'read the connection registry',
    answer: (q) => {
      const s = store.state;
      const mine = agent.tools.map((t) => toolById(s, t)).filter(Boolean);
      const tool = findTool(s, q) || mine.find((t) => !t.connected) || mine[0] || s.tools[0];
      const want = direction(q);
      const target = want === null ? !tool.connected : want;
      const isMine = agent.tools.includes(tool.id);
      if (target === tool.connected) {
        return {
          text: `**${tool.name}** is already ${tool.connected ? 'connected' : 'disconnected'}.`,
          actions: [{ label: `Turn it ${tool.connected ? 'off' : 'on'} instead`, run: () => applyTool(store, tool.id, !tool.connected) }],
        };
      }
      return {
        text: `You want **${tool.name}** ${target ? 'connected' : 'disconnected'}. ${isMine ? 'That is one of my own tools' : 'That one is not wired to me, but I can still flip it'} — ${tool.description}${PENDING}`,
        table: T(['Touched', 'Detail'], [
          ['Connection', `${tool.name} — ${tool.account}`],
          ['State', `${tool.connected ? 'connected' : 'disconnected'} → ${target ? 'connected' : 'disconnected'}`],
          ['Wired to me', isMine ? 'yes' : 'no'],
          ['My tools', agent.tools.map((t) => (toolById(s, t) || {}).name).join(', ')],
        ]),
        actions: [{
          label: target ? `Connect ${tool.name}` : `Disconnect ${tool.name}`,
          doingLabel: 'Applying…',
          run: () => applyTool(store, tool.id, target),
        }],
      };
    },
  };
}

/* ============================================================
   Domain actions — one per demo agent
   ============================================================ */

/* ---- Support Triage: escalate or reassign a ticket ---- */
function triageActions(store, agent) {
  return [{
    id: 'ticketaction',
    operator: true,
    match: [/\b(escalate|escalation)\b[^?]*\b(ticket|tck-?\d+|it|this|oldest)\b/i, /^\s*escalate\b/i, /\b(assign|reassign|hand)\b[^?]*\b(ticket|tck-?\d+|it|this|to)\b/i],
    tools: ['ticketing'],
    trace: 'opened the ticket and the desk load',
    answer: (q) => {
      const s = store.state;
      const t = ticketFrom(s, q);
      const load = s.tickets.filter((x) => x.status !== 'resolved')
        .reduce((m, x) => { m[x.assignee] = (m[x.assignee] || 0) + 1; return m; }, {});
      const lightest = Object.entries(load).sort((a, b) => a[1] - b[1])[0] || [t.assignee, 0];
      const gEsc = guardById(s, 'escalate');
      if (!t) return { text: 'There are no tickets in the queue right now.' };

      return {
        text: `The ticket I would act on is **${t.id} — ${t.subject}** (${t.customer}, ${t.ageH}h old, ${t.priority} priority, currently with ${t.assignee}).\n\nTwo things I can do to it. Escalating raises a reference in ${gEsc.queue} and takes it off the desk. Reassigning moves it to the lightest queue, which is **${lightest[0]}** with ${lightest[1]} open item${lightest[1] === 1 ? '' : 's'}.${PENDING}`,
        table: T(['Field', 'Now', 'After escalating'], [
          ['Status', t.status, 'escalated'],
          ['Priority', t.priority, 'Urgent'],
          ['Owner', t.assignee, gEsc.queue],
          ['Reference', '—', `ESC-${s.counters.escalationSeq + 1}`],
        ]),
        actions: [
          {
            label: `Escalate ${t.id}`,
            doingLabel: 'Escalating…',
            run: () => {
              const s1 = store.state;
              const ref = `ESC-${s1.counters.escalationSeq + 1}`;
              const before = { status: t.status, priority: t.priority, assignee: t.assignee };
              store.update((st) => {
                const x = st.tickets.find((y) => y.id === t.id);
                x.status = 'escalated'; x.priority = 'Urgent'; x.escalationRef = ref; x.assignee = gEsc.queue;
                st.counters.escalationSeq += 1;
              });
              const trace = [
                { label: 'Request accepted', kind: 'system', status: 'ok', ms: jit(4, 14), detail: `operator instruction · model ${agent.model}` },
                { label: 'ticketing.ticket.search', kind: 'tool', status: 'ok', ms: jit(90, 260), detail: `${t.id} opened` },
                { label: 'crm.contact.lookup', kind: 'tool', status: 'ok', ms: jit(80, 240), detail: `${t.customer} · ${t.contact}` },
                { label: 'Guardrail: escalation', kind: 'guardrail', status: 'escalated', ms: jit(3, 11), detail: `handover to ${gEsc.queue} · ${ref}` },
                { label: 'ticketing.ticket.update', kind: 'tool', status: 'ok', ms: jit(120, 320), detail: 'status escalated, priority Urgent' },
                { label: 'Handover note written', kind: 'agent', status: 'ok', ms: jit(200, 520), detail: `${t.subject} · ${t.ageH}h old` },
              ];
              const w = writeActionRun(store, {
                agentId: agent.id, status: 'escalated', trace, question: `escalate ${t.id}`,
                tokensIn: jit(700, 1400), tokensOut: jit(120, 300),
                guardrails: agent.guardrails.map((g) => ({ id: g, verdict: g === 'escalate' ? 'escalated' : 'passed' })),
              });
              refreshApp();
              const x = store.state.tickets.find((y) => y.id === t.id);
              return {
                text: `**${t.id}** is escalated. Reference **${ref}**, sitting in ${gEsc.queue} with the handover note attached.`,
                table: T(['', 'Before', 'After'], [
                  ['Status', before.status, x.status],
                  ['Priority', before.priority, x.priority],
                  ['Owner', before.assignee, x.assignee],
                  ['Escalations raised here', String(s1.counters.escalationSeq - 4180), String(store.state.counters.escalationSeq - 4180)],
                ]),
                meta: `run ${w.id} written · verdict escalated`,
                actions: [
                  { label: 'Open the trace', run: () => { goTo(`runs/${w.id}`); return { text: 'The escalation verdict is on the guardrail card of that run.' }; } },
                  { label: 'Open Guardrails', run: () => { goTo('guardrails'); return { text: 'It is the newest row in the guardrail event log.' }; } },
                ],
              };
            },
          },
          {
            label: `Assign to ${lightest[0]}`,
            doingLabel: 'Reassigning…',
            run: () => {
              const before = t.assignee;
              store.update((st) => {
                const x = st.tickets.find((y) => y.id === t.id);
                x.assignee = lightest[0];
              });
              const trace = [
                { label: 'Request accepted', kind: 'system', status: 'ok', ms: jit(4, 14), detail: 'operator instruction' },
                { label: 'ticketing.ticket.search', kind: 'tool', status: 'ok', ms: jit(90, 260), detail: `${t.id} opened` },
                { label: 'Desk load compared', kind: 'agent', status: 'ok', ms: jit(120, 380), detail: `${lightest[0]} has the fewest open items` },
                { label: 'ticketing.ticket.update', kind: 'tool', status: 'ok', ms: jit(120, 300), detail: `owner ${before} → ${lightest[0]}` },
              ];
              const w = writeActionRun(store, {
                agentId: agent.id, status: 'success', trace, question: `assign ${t.id}`,
                tokensIn: jit(600, 1100), tokensOut: jit(90, 220),
                guardrails: agent.guardrails.map((g) => ({ id: g, verdict: 'passed' })),
              });
              refreshApp();
              return {
                text: `**${t.id}** is now with **${lightest[0]}**.`,
                table: T(['', 'Before', 'After'], [
                  ['Owner', before, lightest[0]],
                  ['Their open items', String(lightest[1]), String(lightest[1] + 1)],
                  ['Runs held', String(store.state.runs.length - 1), String(store.state.runs.length)],
                ]),
                meta: `run ${w.id} written to this browser`,
                actions: [{ label: 'Open the trace', run: () => { goTo(`runs/${w.id}`); return { text: 'Four events, including the ticket update.' }; } }],
              };
            },
          },
        ],
      };
    },
  }];
}

/* ---- Invoice Reader: post an invoice for approval ---- */
function invoiceActions(store, agent) {
  return [{
    id: 'postinvoice',
    operator: true,
    match: [
      /\b(post|approve|file|push|submit)\b[^?]*\b(invoice|inv-?\d+|for approval|workbook|payables)\b/i,
      /^\s*(post|approve|submit)\b[^?]*\b(it|this|the next|that one)\b/i,
    ],
    trace: 'read the invoice and the workbook state',
    answer: (q) => {
      const s = store.state;
      const inv = invoiceFrom(s, q);
      const sheets = toolById(s, 'sheets');
      const held = s.invoices.filter((x) => !x.postedToSheet);
      if (!inv) return { text: 'Nothing is waiting to be posted — every invoice in the set is already in the workbook.' };
      const tax = Math.round(inv.amount * inv.taxPct / 100);

      const post = () => {
        const before = { posted: store.state.invoices.filter((x) => x.postedToSheet).length, state: inv.postedToSheet ? 'posted' : 'held' };
        store.update((st) => {
          const x = st.invoices.find((y) => y.id === inv.id);
          x.postedToSheet = true;
          x.approvalState = 'pending approval';
          x.postedAt = new Date().toISOString();
        });
        const trace = [
          { label: 'Request accepted', kind: 'system', status: 'ok', ms: jit(4, 14), detail: `operator instruction · model ${agent.model}` },
          { label: 'email.inbox.search', kind: 'tool', status: 'ok', ms: jit(120, 300), detail: `attachment for ${inv.id}` },
          { label: 'Fields re-checked', kind: 'agent', status: 'ok', ms: jit(700, 1800), detail: `confidence ${inv.confidence}% · ${inv.lines} lines` },
          { label: 'PO match', kind: 'condition', status: inv.variance === 0 ? 'ok' : 'blocked', ms: jit(40, 120), detail: inv.variance === 0 ? `${inv.po} ties to the total` : `${inv.po} out by ${money(inv.variance)}` },
          { label: 'sheets.row.append', kind: 'tool', status: 'ok', ms: jit(180, 420), detail: 'Payables Q3 · one row' },
          { label: 'webhook.hook.post', kind: 'tool', status: toolById(store.state, 'webhook').connected ? 'ok' : 'skipped', ms: jit(60, 180), detail: 'invoice.posted' },
        ];
        const w = writeActionRun(store, {
          agentId: agent.id, status: 'success', trace, question: `post ${inv.id} for approval`,
          tokensIn: jit(1400, 2600), tokensOut: jit(90, 240),
          guardrails: agent.guardrails.map((g) => ({ id: g, verdict: 'passed' })),
        });
        refreshApp();
        const after = store.state.invoices.filter((x) => x.postedToSheet).length;
        return {
          text: `**${inv.id}** is in **Payables Q3**, marked **pending approval**. It is one row: number, vendor, date, PO, net, tax, total and my confidence, so whoever approves it can sort by confidence and check only what is worth checking.`,
          table: T(['', 'Before', 'After'], [
            ['This invoice', before.state, 'posted · pending approval'],
            ['Rows in Payables Q3', String(before.posted), String(after)],
            ['Held for review', String(s.invoices.length - before.posted), String(s.invoices.length - after)],
            ['Held value', money(sum(held, (x) => x.amount)), money(sum(store.state.invoices.filter((x) => !x.postedToSheet), (x) => x.amount))],
          ]),
          meta: `run ${w.id} written to this browser`,
          actions: [{ label: 'Open the trace', run: () => { goTo(`runs/${w.id}`); return { text: 'The sheet call is the fifth event.' }; } }],
        };
      };

      return {
        text: `The one I would post is **${inv.id}** from ${inv.vendor}, ${money(inv.amount)} dated ${fmtDate(inv.dateIso)}, confidence ${inv.confidence}%.\n\nPosting appends one row to **Payables Q3** and marks it **pending approval** — it is not paid, it is queued for a person.${sheets.connected ? '' : `\n\n**Sheets is disconnected**, so I cannot append anything. I can connect it first if you want.`}${PENDING}`,
        table: T(['Field', 'Value'], [
          ['Invoice', `${inv.id} · ${inv.vendor}`],
          ['Total', `${money(inv.amount)} (tax ${inv.taxPct}% · ${money(tax)})`],
          ['Purchase order', `${inv.po}${inv.variance ? ` — out by ${money(inv.variance)}` : ' — ties'}`],
          ['Destination', 'Payables Q3, one appended row'],
          ['After posting', 'pending approval — nothing is paid'],
        ]),
        actions: sheets.connected
          ? [{ label: `Post ${inv.id} for approval`, doingLabel: 'Posting…', run: post }]
          : [{
            label: 'Connect Sheets, then post',
            doingLabel: 'Connecting…',
            run: () => {
              const c = applyTool(store, 'sheets', true);
              const p = post();
              return {
                text: `${c.text}\n\n${p.text}`,
                table: p.table,
                meta: p.meta,
                actions: p.actions,
              };
            },
          }],
      };
    },
  }];
}

/* ---- Onboarding Assistant: advance a checklist step ---- */
function onboardActions(store, agent) {
  return [{
    id: 'advance',
    operator: true,
    match: [
      /\b(advance|progress|move|bump|push|complete|tick off|mark)\b[^?]*\b(account|acc-?\d+|step|checklist|forward|on|off)\b/i,
      /^\s*advance\b/i,
    ],
    tools: ['crm'],
    trace: 'opened the account and the checklist',
    answer: (q) => {
      const s = store.state;
      const a = accountFrom(s, q);
      if (!a) return { text: 'There are no accounts in the book.' };
      if (a.stepIdx >= ONBOARD_STEPS.length - 1) {
        return { text: `**${a.name}** is already on the last step (${a.step}). There is nothing left to advance.` };
      }
      const next = ONBOARD_STEPS[a.stepIdx + 1];
      return {
        text: `The account I would move is **${a.name}** (${a.id}) — ${a.plan} plan, ${a.region}, ${a.stuckDays} days sitting on **${a.step}**.\n\nAdvancing marks the current step done, moves it to **${next}** and resets the days-on-step counter. It also appends a note to the CRM record and writes the change as a run.${PENDING}`,
        table: T(['Field', 'Now', 'After'], [
          ['Step', `${a.stepIdx + 1} of 6 — ${a.step}`, `${a.stepIdx + 2} of 6 — ${next}`],
          ['Days on step', String(a.stuckDays), '0'],
          ['Owner', a.owner, a.owner],
          ['Contact', a.contact, a.contact],
        ]),
        actions: [{
          label: `Advance ${a.name}`,
          doingLabel: 'Advancing…',
          run: () => {
            const before = { step: a.step, idx: a.stepIdx, days: a.stuckDays };
            const stuckBefore = store.state.accounts.filter((x) => x.stuckDays >= 5).length;
            store.update((st) => {
              const x = st.accounts.find((y) => y.id === a.id);
              x.stepIdx += 1; x.step = ONBOARD_STEPS[x.stepIdx]; x.stuckDays = 0;
            });
            const trace = [
              { label: 'Request accepted', kind: 'system', status: 'ok', ms: jit(4, 14), detail: `operator instruction · model ${agent.model}` },
              { label: 'crm.account.read', kind: 'tool', status: 'ok', ms: jit(90, 260), detail: `${a.id} · ${a.name}` },
              { label: 'Checklist evaluated', kind: 'agent', status: 'ok', ms: jit(150, 420), detail: `${before.step} → ${next}` },
              { label: 'crm.note.append', kind: 'tool', status: 'ok', ms: jit(110, 280), detail: 'step marked done by the onboarding agent' },
              { label: 'Nudge drafted', kind: 'agent', status: 'ok', ms: jit(200, 600), detail: `for ${a.contact}, held for approval` },
            ];
            const w = writeActionRun(store, {
              agentId: agent.id, status: 'success', trace, question: `advance ${a.id}`,
              tokensIn: jit(500, 900), tokensOut: jit(140, 380),
              guardrails: agent.guardrails.map((g) => ({ id: g, verdict: 'passed' })),
            });
            refreshApp();
            const x = store.state.accounts.find((y) => y.id === a.id);
            return {
              text: `**${a.name}** is on step ${x.stepIdx + 1} of 6 — **${x.step}**. The nudge mail for ${a.contact} is drafted and waiting for a person, not sent.`,
              table: T(['', 'Before', 'After'], [
                ['Step', `${before.idx + 1} — ${before.step}`, `${x.stepIdx + 1} — ${x.step}`],
                ['Days on step', String(before.days), String(x.stuckDays)],
                ['Accounts stuck 5+ days', String(stuckBefore), String(store.state.accounts.filter((y) => y.stuckDays >= 5).length)],
              ]),
              meta: `run ${w.id} written to this browser`,
              actions: [{ label: 'Open the trace', run: () => { goTo(`runs/${w.id}`); return { text: 'Five events, including the CRM note.' }; } }],
            };
          },
        }],
      };
    },
  }];
}

/* ---- Report Writer: generate and store the weekly report ---- */
function reportActions(store, agent) {
  return [{
    id: 'genreport',
    operator: true,
    match: [
      /\b(generate|store|save|produce|create|file|publish)\b[^?]*\b(report|summary|write-?up)\b/i,
      /\bwrite and (store|save|file)\b/i,
    ],
    tools: ['sheets'],
    trace: 'read Ops!A1:H60 and the run history',
    answer: () => {
      const s = store.state;
      const m = s.metrics;
      const cur = m[m.length - 1]; const prev = m[m.length - 2];
      const stored = (s.reports || []).length;
      const delta = prev.runs ? ((cur.runs - prev.runs) / prev.runs) * 100 : 0;
      return {
        text: `I would write the week ${m.length} summary from the workbook range and the run history held here, then store it in the workspace so it can be read back later.\n\nThe numbers it would be built on are below. ${stored ? `${stored} report${stored === 1 ? ' is' : 's are'} already stored.` : 'Nothing is stored yet.'}${PENDING}`,
        table: T(['Metric', 'This week', 'Last week'], [
          ['Runs', num(cur.runs), num(prev.runs)],
          ['Clean', num(cur.success), num(prev.success)],
          ['Escalations', String(cur.escalations), String(prev.escalations)],
          ['Cost', rupees(cur.costPaise), rupees(prev.costPaise)],
        ]),
        actions: [{
          label: 'Generate and store it',
          doingLabel: 'Writing the report…',
          run: () => {
            const s1 = store.state;
            const rate = cur.runs ? (cur.success / cur.runs) * 100 : 0;
            const body = `Week ${m.length} summary\n\nAgents ran ${num(cur.runs)} times, ${delta >= 0 ? 'up' : 'down'} ${pct(Math.abs(delta), 1)} on the week before. ${num(cur.success)} finished clean, a ${pct(rate, 1)} success rate. ${cur.escalations} conversations went to a person, which is what the escalation rule exists to do.\n\nToken use was ${num(cur.tokens)} at ${rupees(cur.costPaise)}, about ${rupees(Math.round(cur.costPaise / cur.runs))} per piece of work. The number worth watching is the held invoice pile, not the run count.\n\nWritten by ${agent.name} on ${fmtDate(new Date())} from Ops!A1:H60 and the ${s1.runs.length} runs held in this workspace.`;
            const id = `RPT-${1200 + (s1.reports || []).length + 1}`;
            store.update((st) => {
              if (!Array.isArray(st.reports)) st.reports = [];
              st.reports.unshift({
                id, title: `Week ${m.length} operations summary`,
                createdAt: new Date().toISOString(), agentId: agent.id, body,
                metrics: { runs: cur.runs, clean: cur.success, escalations: cur.escalations, costPaise: cur.costPaise },
              });
              st.reports = st.reports.slice(0, 20);
            });
            const trace = [
              { label: 'Request accepted', kind: 'system', status: 'ok', ms: jit(4, 14), detail: `operator instruction · model ${agent.model}` },
              { label: 'sheets.sheet.read', kind: 'tool', status: 'ok', ms: jit(280, 620), detail: 'Ops!A1:H60' },
              { label: 'Week compared', kind: 'agent', status: 'ok', ms: jit(600, 1400), detail: `${delta >= 0 ? '+' : ''}${pct(delta, 1)} on run volume` },
              { label: 'Summary written', kind: 'agent', status: 'ok', ms: jit(900, 2200), detail: `${body.length} characters, plain language` },
              { label: 'sheets.row.append', kind: 'tool', status: 'ok', ms: jit(160, 380), detail: `archived as ${id}` },
              { label: 'Held for the distribution list', kind: 'output', status: 'ok', ms: jit(20, 60), detail: `${s1.settings.distribution} — not sent in the demo` },
            ];
            const w = writeActionRun(store, {
              agentId: agent.id, status: 'success', trace, question: 'generate and store the weekly report',
              tokensIn: jit(2400, 3800), tokensOut: jit(400, 800),
              guardrails: agent.guardrails.map((g) => ({ id: g, verdict: 'passed' })),
            });
            refreshApp();
            return {
              text: `Stored as **${id}**.\n\n${body.split('\n\n').slice(1, 3).join('\n\n')}\n\nIt is kept in the workspace under **Settings → Stored reports**, and the run is in Runs. Nothing was mailed — the distribution list is a label in this demo.`,
              table: T(['', 'Before', 'After'], [
                ['Reports stored', String(stored), String((store.state.reports || []).length)],
                ['Runs held', String(s1.runs.length), String(store.state.runs.length)],
                ['Latest report', stored ? (s1.reports[0] || {}).id || '—' : 'none', id],
              ]),
              meta: `run ${w.id} written to this browser`,
              actions: [
                { label: 'Open Settings', run: () => { goTo('settings'); return { text: `**${id}** is in the stored reports card — open it to read the whole thing.` }; } },
                { label: 'Open the trace', run: () => { goTo(`runs/${w.id}`); return { text: 'Six events, ending with the archive append.' }; } },
              ],
            };
          },
        }],
      };
    },
  }];
}

const DOMAIN = {
  triage: triageActions,
  invoice: invoiceActions,
  onboard: onboardActions,
  report: reportActions,
};

/* Every action intent bound to one agent: its own domain actions first,
   then the two every agent shares. */
export function agentActions(store, agent, session) {
  const domain = DOMAIN[agent.id] ? DOMAIN[agent.id](store, agent) : [];
  return [...domain, guardToggleIntent(store, agent, session), toolConnIntent(store, agent)];
}
