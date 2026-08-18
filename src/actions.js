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
  toolName, toolKind, toolDesc, toolAccount, agentName, agentPurpose, agentStatusLabel,
  guardName, guardSummary, guardDetail, guardQueue, workflowName, triggerLabel,
  outputLabel, stepName, statusLabel, kindLabel, onboardStepLabel, planLabel,
  regionLabel, priorityLabel, ticketStatusLabel, subjectLabel, invStatusLabel,
  traceLabel, traceDetail,
} from './data.js';
import {
  refreshApp, goTo, requestWorkflowRun, writeActionRun, jit,
} from './runner.js';
import { t } from './main.js';

const T = (head, rows) => ({ head, rows });
const lower = (s) => String(s || '').toLowerCase();
const SEP = () => t('common.listSep');
const joinList = (xs) => xs.join(SEP());
const NONE = () => t('common.none');
const arrow = (a, b) => `${a}${t('common.arrow')}${b}`;
const sortDesc = (arr, f) => [...arr].sort((a, b) => f(b) - f(a));
const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);

/* ---------- resolving what the reader named ---------- */
/* The reader names a workflow, an agent or a tool in whichever language
   they are reading, so both spellings are searched — the stored English
   name and the label the interface is showing them. */
function bestByName(list, q, nameOf) {
  const low = lower(q);
  let best = null; let score = 0;
  list.forEach((x) => {
    const words = lower(nameOf(x)).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3);
    const n = words.filter((w) => low.includes(w)).length;
    if (n > score) { score = n; best = x; }
  });
  return best;
}

const findWorkflow = (s, q) => bestByName(s.workflows, q, (w) => `${w.name} ${workflowName(w)}`)
  || s.workflows.find((w) => w.enabled) || s.workflows[0];

const findAgent = (s, q) => bestByName(s.agents, q, (a) => `${a.name} ${agentName(a)}`);

function findTool(s, q) {
  const low = lower(q);
  return s.tools.find((x) => low.includes(lower(x.name)) || low.includes(lower(toolName(x))))
    || bestByName(s.tools, q, (x) => `${x.name} ${toolName(x)} ${x.kind} ${toolKind(x)}`) || null;
}

const GUARD_WORDS = [
  ['pii', /\b(pii|redact|redaction|mask|contact details)\b|حجب|البيانات الشخصية|إخفاء/i],
  ['topics', /\b(topic|topics|allowed topics|off-?topic|subject)\b|المواضيع|موضوع/i],
  ['escalate', /\b(escalat\w*|handover|hand-?over|human|tier 2)\b|تصعيد|التصعيد|تسليم|إنسان/i],
  ['cost', /\b(cost|ceiling|budget|spend cap|limit)\b|التكلفة|تكلفة|سقف|ميزانية/i],
];
function findGuard(s, q) {
  const hit = GUARD_WORDS.find(([, re]) => re.test(q));
  return guardById(s, hit ? hit[0] : 'pii');
}

/* on / off / toggle, read out of the wording */
function direction(q) {
  if (/أعد الوصل|أعد وصل|أعد تفعيل|أعد تشغيل/.test(q)) return true;
  if (/\b(off|disable|deactivate|stop|remove|switch off|turn off|unplug|disconnect|pause|mute)\b/i.test(q)
    || /افصل|أوقف|اوقف|عطّل|عطل|أطفئ|اطفئ|اقطع|إيقاف|ايقاف|تعطيل/.test(q)) return false;
  if (/\b(on|enable|re-?enable|activate|reactivate|start|switch on|turn on|connect|reconnect|resume)\b/i.test(q)
    || /صِل|أوصل|فعّل|فعل|استأنف|تفعيل|توصيل|شغّل/.test(q)) return true;
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
const PENDING = () => t('act.pending');

/* ============================================================
   The catalogue. One row per thing an agent can actually do, with the
   phrasing that reaches it. Used by the "What can you do?" answers, the
   About modal and the self-test, so those three can never drift from
   what is really wired up.
   ============================================================ */
/* The wording lives in `act.catalogue`, in the reader's language; the
   intent each row has to reach lives here, in the same order, because an
   intent id is not a sentence anybody reads. */
const CATALOGUE_IDS = {
  console: ['wfrun', 'wfstep', 'wfstep', 'toolconn', 'agentstate', 'rerun', 'guardtoggle'],
  shared: ['guardtoggle', 'toolconn'],
  triage: ['ticketaction', 'ticketaction'],
  invoice: ['postinvoice'],
  onboard: ['advance'],
  report: ['genreport'],
};

export const catalogue = () => {
  const rows = t('act.catalogue') || {};
  const out = {};
  Object.keys(CATALOGUE_IDS).forEach((scope) => {
    out[scope] = (rows[scope] || []).map((r, i) => ({ id: CATALOGUE_IDS[scope][i], ask: r.ask, does: r.does }));
  });
  return out;
};

export const catalogueFor = (agentId) => {
  const c = catalogue();
  return [...(c[agentId] || []), ...c.shared];
};

/* ============================================================
   Console actions
   ============================================================ */
export function consoleActions(store) {
  const S = () => store.state;

  return [
    /* ---------- run a workflow now ---------- */
    {
      id: 'wfrun',
      match: [
        /\brun\b[^?]*\b(workflow|pipeline|intake|triage|report)\b/i, /^\s*run the /i,
        /\b(kick off|trigger|start)\b[^?]*\b(workflow|pipeline)\b/i,
        /(شغّل|شغل|أطلق|ابدأ)[^؟]*(مسار|المسار|خط المعالجة|استقبال|فرز|تقرير)/,
      ],
      trace: t('act.wfrun.trace'),
      answer: (q) => {
        const s = S();
        const wf = findWorkflow(s, q);
        const on = wf.steps.filter((x) => x.enabled);
        const name = workflowName(wf);
        return {
          text: t('act.wfrun.text', {
            name, on: on.length, all: wf.steps.length,
            trigger: String(triggerLabel(wf)).toLowerCase(),
            outputs: joinList((wf.outputs || []).map(outputLabel)),
          }) + PENDING(),
          table: T(t('act.wfrun.head'), on.map((st, i) => [
            String(i + 1), stepName(st.name),
            st.kind === 'tool' ? `${toolName(toolById(s, st.ref)) || st.ref}${(toolById(s, st.ref) || {}).connected ? '' : t('act.wfrun.disconnected')}`
              : st.kind === 'agent' ? `${agentName(agentById(s, st.ref)) || st.ref}` : kindLabel(st.kind),
          ])),
          actions: [{
            label: t('act.wfrun.runNow', { name }),
            doingLabel: t('act.wfrun.running'),
            run: async () => {
              const before = S().runs.length;
              const r = await requestWorkflowRun(store, wf);
              const after = S().runs.length;
              const w = workflowById(S(), wf.id) || wf;
              const rows = t('act.wfrun.rows');
              return {
                text: t('act.wfrun.done', { name, status: statusLabel(r.status), ms: num(r.durationMs), run: r.runId }),
                table: T(t('act.beforeAfter'), [
                  [rows.runsHeld, String(before), String(after)],
                  [rows.lastRun, t('act.wfrun.notRunYet'), ago(w.lastRunAt || new Date().toISOString())],
                  [rows.clean, t('common.dash'), t('act.wfrun.cleanOf', { ok: r.ok, n: r.steps.length })],
                  [rows.cost, t('common.dash'), rupees(r.costPaise)],
                ]),
                meta: t('act.runWritten', { id: r.runId }),
                actions: [{ label: t('act.openTrace'), run: () => { goTo(`runs/${r.runId}`); return { text: t('act.wfrun.opened', { run: r.runId }) }; } }],
                suggestions: t('act.wfrun.afterSuggestions'),
              };
            },
          }, {
            label: t('act.openPipeline'),
            run: () => { goTo(`workflows/${wf.id}`); return { text: t('act.wfrun.openedWf', { name }) }; },
          }],
        };
      },
    },

    /* ---------- add or remove a step ---------- */
    {
      id: 'wfstep',
      match: [
        /\b(add|append|insert)\b[^?]*\bstep\b/i, /\b(remove|delete|drop|take out)\b[^?]*\bstep\b/i,
        /(أضف|اضف|ألحق)[^؟]*(خطوة|الخطوة)/, /(أزل|ازل|احذف)[^؟]*(خطوة|الخطوة)/,
      ],
      trace: t('act.wfstep.trace'),
      answer: (q) => {
        const s = S();
        const wf = findWorkflow(s, q);
        const wfLabel = workflowName(wf);
        const removing = /\b(remove|delete|drop|take out)\b/i.test(q) || /أزل|احذف|اسحب|إزالة/.test(q);

        if (removing) {
          const named = bestByName(wf.steps, q, (st) => `${st.name} ${stepName(st.name)}`) || wf.steps[wf.steps.length - 1];
          if (!named) return { text: t('act.wfstep.noneLeft', { name: wfLabel }) };
          const stepLabel = stepName(named.name);
          const rows = t('act.wfstep.removeRows');
          return {
            text: t('act.wfstep.removeText', { wf: wfLabel, step: stepLabel }) + PENDING(),
            table: T(t('act.field'), [
              [rows.workflow, wfLabel],
              [rows.step, stepLabel],
              [rows.position, t('act.wfstep.positionOf', { i: wf.steps.indexOf(named) + 1, n: wf.steps.length })],
              [rows.kind, kindLabel(named.kind)],
              [rows.effect, t('act.wfstep.removeEffect')],
            ]),
            actions: [{
              label: t('act.wfstep.removeBtn', { name: stepLabel }),
              doingLabel: t('act.wfstep.removing'),
              run: () => {
                const before = (workflowById(S(), wf.id) || wf).steps.length;
                store.update((st) => {
                  const w = st.workflows.find((x) => x.id === wf.id);
                  w.steps = w.steps.filter((x) => x.id !== named.id);
                });
                const after = (workflowById(S(), wf.id) || wf).steps.length;
                refreshApp();
                return {
                  text: t('act.wfstep.removed', { step: stepLabel, wf: wfLabel }),
                  table: T(t('act.beforeAfter'), [
                    [t('act.wfstep.stepsRow'), String(before), String(after)],
                    [t('act.wfstep.pipelineRow'), t('common.dash'),
                      (workflowById(S(), wf.id) || wf).steps.map((x) => stepName(x.name)).join(t('common.arrow')) || t('act.wfstep.emptyPipeline')],
                  ]),
                  meta: t('act.wfstep.wfUpdated'),
                  actions: [{ label: t('act.openPipeline'), run: () => { goTo(`workflows/${wf.id}`); return { text: t('act.wfstep.removedNote') }; } }],
                };
              },
            }],
          };
        }

        const quoted = q.match(/["“«](.+?)["”»]/) || q.match(/\b(?:called|named)\s+(.+?)(?:\s+to\b|\s+in\b|$)/i)
          || q.match(/(?:اسمها|باسم|تسمّى|تسمى)\s+(.+?)$/);
        const name = (quoted ? quoted[1] : t('act.wfstep.defaultName')).trim();
        const rows = t('act.wfstep.addRows');
        return {
          text: t('act.wfstep.addText', { wf: wfLabel }) + PENDING(),
          table: T(t('act.field'), [
            [rows.workflow, wfLabel],
            [rows.name, name],
            [rows.kind, t('act.wfstep.addKind')],
            [rows.position, t('act.wfstep.positionOf', { i: wf.steps.length + 1, n: wf.steps.length + 1 })],
            [rows.duration, t('act.wfstep.addDuration')],
          ]),
          actions: [{
            label: t('act.wfstep.addBtn', { name }),
            doingLabel: t('act.wfstep.adding'),
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
                text: t('act.wfstep.added', { name, wf: wfLabel, n: w.steps.length }),
                table: T(t('act.beforeAfter'), [
                  [t('act.wfstep.stepsRow'), String(before), String(w.steps.length)],
                  [t('act.wfstep.pipelineRow'), t('common.dash'), w.steps.map((x) => stepName(x.name)).join(t('common.arrow'))],
                ]),
                meta: t('act.wfstep.wfUpdated'),
                actions: [
                  { label: t('act.openPipeline'), run: () => { goTo(`workflows/${wf.id}`); return { text: t('act.wfstep.addedNote') }; } },
                  {
                    label: t('act.wfstep.runNow', { name: wfLabel }),
                    doingLabel: t('act.wfstep.runningShort'),
                    run: async () => {
                      const r = await requestWorkflowRun(store, workflowById(S(), wf.id) || wf);
                      return { text: t('act.wfstep.ranWith', { status: statusLabel(r.status), ms: num(r.durationMs), run: r.runId }) };
                    },
                  },
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
      match: [
        /\b(disconnect|reconnect|unplug|plug in|connect)\b/i,
        /\b(turn|switch)\s+(the\s+)?\w*\s*(crm|email|sheets|ticketing|webhook)\b/i,
        /(افصل|اقطع|أعد وصل|أوصل|صِل)[^؟]*(اتصال|أداة|البريد|إدارة العملاء|الجداول|التذاكر|خطّاف)/,
      ],
      trace: t('act.toolconn.trace'),
      answer: (q) => {
        const s = S();
        const tool = findTool(s, q) || s.tools.find((x) => !x.connected) || s.tools[0];
        const want = direction(q);
        const target = want === null ? !tool.connected : want;
        const users = s.agents.filter((a) => a.tools.includes(tool.id));
        const steps = s.workflows.flatMap((w) => w.steps.filter((st) => st.kind === 'tool' && st.ref === tool.id)
          .map((st) => `${workflowName(w)} · ${stepName(st.name)}`));
        const name = toolName(tool);
        if (target === tool.connected) {
          return {
            text: t('act.toolconn.already', {
              name, state: tool.connected ? t('common.connected') : t('common.disconnected'), description: toolDesc(tool),
            }),
            actions: [{
              label: t(tool.connected ? 'act.toolconn.insteadOff' : 'act.toolconn.insteadOn', { name }),
              run: () => applyTool(store, tool.id, !tool.connected),
            }],
          };
        }
        const rows = t('act.toolconn.rows');
        return {
          text: t('act.toolconn.text', {
            name, target: target ? t('common.connected') : t('common.disconnected'),
            agents: t('act.toolconn.nAgents', { n: users.length }),
            steps: t('act.toolconn.nSteps', { n: steps.length }),
          }) + PENDING(),
          table: T(t('act.touched'), [
            [rows.connection, `${name} — ${toolAccount(tool)}`],
            [rows.state, arrow(tool.connected ? t('common.connected') : t('common.disconnected'), target ? t('common.connected') : t('common.disconnected'))],
            [rows.agents, joinList(users.map(agentName)) || NONE()],
            [rows.steps, joinList(steps) || NONE()],
          ]),
          actions: [{
            label: t(target ? 'act.toolconn.connect' : 'act.toolconn.disconnect', { name }),
            doingLabel: t('act.applying'),
            run: () => applyTool(store, tool.id, target),
          }],
        };
      },
    },

    /* ---------- pause / activate an agent ---------- */
    {
      id: 'agentstate',
      match: [
        /\b(pause|unpause|resume|activate|reactivate|deactivate)\b/i,
        /\b(take|bring)\b[^?]*\b(offline|online)\b/i,
        /(أوقف|اوقف|استأنف|فعّل|شغّل)[^؟]*(وكيل|الوكيل|فرز|قارئ|مساعد|كاتب)/,
      ],
      trace: t('act.agentstate.trace'),
      answer: (q) => {
        const s = S();
        const agent = findAgent(s, q) || s.agents.find((a) => a.status !== 'live') || s.agents[0];
        const want = direction(q);
        const target = want === null ? (agent.status === 'live' ? 'paused' : 'live') : (want ? 'live' : 'paused');
        const steps = s.workflows.flatMap((w) => w.steps.filter((st) => st.kind === 'agent' && st.ref === agent.id)
          .map((st) => `${workflowName(w)} · ${stepName(st.name)}`));
        const name = agentName(agent);
        if (target === agent.status) {
          const other = agent.status === 'live' ? 'paused' : 'live';
          return {
            text: t('act.agentstate.already', { name, status: agentStatusLabel(agent.status), purpose: agentPurpose(agent) }),
            actions: [{
              label: t(other === 'live' ? 'act.agentstate.activate' : 'act.agentstate.pause', { name }),
              doingLabel: t('act.applying'),
              run: () => applyAgentStatus(store, agent.id, other),
            }],
          };
        }
        const rows = t('act.agentstate.rows');
        return {
          text: t('act.agentstate.text', { name, target: agentStatusLabel(target) }) + PENDING(),
          table: T(t('act.touched'), [
            [rows.agent, `${name} · ${agent.model}`],
            [rows.status, arrow(agentStatusLabel(agent.status), agentStatusLabel(target))],
            [rows.steps, joinList(steps) || NONE()],
            [rows.runs, String(s.runs.filter((r) => r.agentId === agent.id).length)],
          ]),
          actions: [{
            label: t(target === 'live' ? 'act.agentstate.activate' : 'act.agentstate.pause', { name }),
            doingLabel: t('act.applying'),
            run: () => applyAgentStatus(store, agent.id, target),
          }],
        };
      },
    },

    /* ---------- re-run a failed run ---------- */
    {
      id: 'rerun',
      match: [
        /\bre-?run\b/i, /\bretry\b/i, /\b(run|try)\s+(it|that)\s+again\b/i, /\bfailed run\b/i,
        /أعد تشغيل/, /(تشغيلة|التشغيلة)[^؟]*(أخفقت|فاشلة)/,
      ],
      trace: t('act.rerun.trace'),
      answer: (q) => {
        const s = S();
        const m = q.match(/\b(run_[a-z0-9]+)\b/i);
        const run = (m && s.runs.find((r) => lower(r.id) === lower(m[1])))
          || s.runs.find((r) => r.status === 'failed')
          || s.runs.find((r) => r.status !== 'success')
          || s.runs[0];
        if (!run) return { text: t('act.rerun.noRuns') };
        const agent = agentById(s, run.agentId) || {};
        const bad = (run.trace || []).find((ev) => ev.status === 'failed' || ev.status === 'blocked') || {};
        const offNow = (agent.tools || []).filter((id) => !(toolById(s, id) || {}).connected);
        const rows = t('act.rerun.rows');
        return {
          text: t('act.rerun.text', {
            run: run.id, agent: agentName(agent) || run.agentId, status: statusLabel(run.status),
            when: ago(run.startedAt), at: traceLabel(bad.label) || t('act.rerun.lastStep'),
            detail: bad.detail ? ` — ${traceDetail(bad.detail)}` : '',
            conns: offNow.length
              ? t('act.rerun.stillOff', { names: joinList(offNow.map((id) => toolName(toolById(s, id)))) })
              : t('act.rerun.allUp'),
          }) + PENDING(),
          table: T(t('act.field'), [
            [rows.run, run.id],
            [rows.agent, agentName(agent) || run.agentId],
            [rows.status, statusLabel(run.status)],
            [rows.failedAt, traceLabel(bad.label) || t('common.dash')],
            [rows.wouldNow, offNow.length ? t('act.rerun.wouldFail') : t('act.rerun.wouldSucceed')],
          ]),
          actions: [{
            label: t('act.rerun.btn'),
            doingLabel: t('act.rerun.doing'),
            run: () => {
              const s2 = S();
              const a = agentById(s2, run.agentId) || {};
              const stillOff = (a.tools || []).filter((id) => !(toolById(s2, id) || {}).connected);
              const status = stillOff.length ? 'failed' : 'success';
              const trace = (run.trace || []).map((ev) => ({
                ...ev,
                ms: Math.max(1, Math.round(ev.ms * (0.7 + Math.random() * 0.7))),
                status: (ev.status === 'failed' || ev.status === 'blocked') && status === 'success' ? 'ok' : ev.status,
                detail: (ev.status === 'failed' || ev.status === 'blocked') && status === 'success' ? t('act.rerun.clearedOn') : ev.detail,
              }));
              trace.push({
                label: t('act.rerun.accepted'), kind: 'system', status: status === 'success' ? 'ok' : 'failed', ms: jit(6, 22),
                detail: t('act.rerun.acceptedDetail', {
                  run: run.id,
                  note: stillOff.length
                    ? t('act.rerun.stillDown', { names: joinList(stillOff.map((id) => toolName(toolById(s2, id)))) })
                    : t('act.rerun.verified'),
                }),
              });
              const before = s2.runs.length;
              const w = writeActionRun(store, {
                agentId: run.agentId, workflowId: run.workflowId, trigger: 'Manual re-run',
                status, trace, tokensIn: run.tokensIn, tokensOut: run.tokensOut,
                question: `re-run of ${run.id}`,
                guardrails: run.guardrails || [],
              });
              refreshApp();
              const applied = t('act.rerun.appliedRows');
              return {
                text: t('act.rerun.done', {
                  old: run.id, id: w.id, status: statusLabel(status),
                  note: stillOff.length
                    ? t('act.rerun.sameFailure', { names: joinList(stillOff.map((id) => toolName(toolById(S(), id)))) })
                    : '',
                }),
                table: T(t('act.beforeAfter'), [
                  [applied.runs, String(before), String(S().runs.length)],
                  [applied.status, statusLabel(run.status), statusLabel(status)],
                  [applied.duration, t('common.ms', { n: num(run.durationMs) }), t('common.ms', { n: num(w.durationMs) })],
                ]),
                meta: t('act.runWritten', { id: w.id }),
                actions: [
                  { label: t('act.openNewTrace'), run: () => { goTo(`runs/${w.id}`); return { text: t('act.rerun.traceNote') }; } },
                  ...(stillOff.length ? [{
                    label: t('act.rerun.connectFirst', { name: toolName(toolById(S(), stillOff[0])) }),
                    run: () => applyTool(store, stillOff[0], true),
                  }] : []),
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
  const steps = s0.workflows.flatMap((w) => w.steps.filter((st) => st.kind === 'agent' && st.ref === agentId)
    .map((st) => `${workflowName(w)} · ${stepName(st.name)}`));
  store.update((st) => { const a = st.agents.find((x) => x.id === agentId); a.status = target; });
  const s = store.state;
  refreshApp();
  const name = agentName(a0);
  const rows = t('act.agentstate.appliedRows');
  return {
    text: t('act.agentstate.applied', {
      name, target: agentStatusLabel(target),
      note: steps.length ? t(target === 'live' ? 'act.agentstate.noteLive' : 'act.agentstate.notePaused') : '',
    }),
    table: T(t('act.beforeAfter'), [
      [rows.status, agentStatusLabel(before), agentStatusLabel(target)],
      [rows.live, String(liveBefore), String(s.agents.filter((x) => x.status === 'live').length)],
      [rows.steps, joinList(steps) || NONE(), steps.length ? t(target === 'live' ? 'act.agentstate.willRun' : 'act.agentstate.willSkip') : NONE()],
    ]),
    meta: t('act.agentstate.recordUpdated'),
    actions: [{ label: t('act.openAgents'), run: () => { goTo('agents'); return { text: t('act.agentstate.cardReads', { name, target: agentStatusLabel(target) }) }; } }],
  };
}

/* ---------- shared: apply a connection change ---------- */
function applyTool(store, toolId, target) {
  const before = toolById(store.state, toolId) || {};
  const wasConnected = before.connected;
  store.update((st) => {
    const rec = st.tools.find((x) => x.id === toolId);
    rec.connected = target;
    if (target) rec.connectedAt = new Date().toISOString();
  });
  const s = store.state;
  const tool = toolById(s, toolId);
  const users = s.agents.filter((a) => a.tools.includes(toolId));
  const steps = s.workflows.flatMap((w) => w.steps.filter((st) => st.kind === 'tool' && st.ref === toolId));
  refreshApp();
  const name = toolName(tool);
  const rows = t('act.toolconn.appliedRows');
  const up = s.tools.filter((x) => x.connected).length;
  return {
    text: t('act.toolconn.applied', {
      name, state: target ? t('common.connected') : t('common.disconnected'),
      effect: t(target ? 'act.toolconn.effectOn' : 'act.toolconn.effectOff'),
    }),
    table: T(t('act.beforeAfter'), [
      [rows.connection, wasConnected ? t('common.connected') : t('common.disconnected'), target ? t('common.connected') : t('common.disconnected')],
      [rows.up, String(up - (target ? 1 : -1)), t('act.toolconn.upOf', { n: up, total: s.tools.length })],
      [rows.agents, String(users.length), joinList(users.map(agentName)) || NONE()],
      [rows.steps, String(steps.length), t(target ? 'act.toolconn.willRun' : 'act.toolconn.willFail')],
    ]),
    meta: t('act.toolconn.registryUpdated'),
    actions: [{
      label: t('act.openTools'),
      run: () => { goTo('tools'); return { text: t('act.toolconn.cardReads', { name, state: target ? t('common.connected') : t('common.off') }) }; },
    }],
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
  const demoQ = (id) => (t('act.guardtoggle.demoQ') || {})[id];
  return {
    id: 'guardtoggle',
    operator: true,
    match: [
      /\b(turn|switch|toggle|flip|set)\b[^?]*\b(redact\w*|pii|topics?|escalation|escalate|ceiling|cost|guardrail|rule)\b/i,
      /\b(disable|enable|re-?enable|deactivate|reactivate)\b[^?]*\b(redact\w*|pii|topics?|escalation|escalate|ceiling|cost|guardrail|rule)\b/i,
      /\bguardrails? (on|off)\b/i,
      /(بدّل|بدل|شغّل|أوقف|اوقف|فعّل|عطّل|أطفئ)[^؟]*(حجب|المواضيع|التصعيد|السقف|تكلفة|ضابط|قاعدة)/,
    ],
    trace: t('act.guardtoggle.trace'),
    answer: (q) => {
      const s = store.state;
      const g = findGuard(s, q);
      const want = direction(q);
      const target = want === null ? !g.enabled : want;
      const bound = s.agents.filter((a) => a.guardrails.includes(g.id));
      const prev = (session && session.lastQ) || demoQ(g.id);
      const mine = agent ? agent.guardrails.includes(g.id) : null;
      const name = guardName(g);

      if (target === g.enabled) {
        return {
          text: t('act.guardtoggle.already', {
            name, state: g.enabled ? t('common.on') : t('common.off'), summary: guardSummary(g),
          }),
          actions: [{
            label: t('act.guardtoggle.instead', { state: g.enabled ? t('common.off') : t('common.on') }),
            run: () => applyGuard(store, g.id, !g.enabled, agent, session, prev),
          }],
        };
      }

      const rows = t('act.guardtoggle.rows');
      const state = target ? t('common.on') : t('common.off');
      return {
        text: t('act.guardtoggle.text', {
          name, target: state,
          who: agent ? t('act.guardtoggle.me') : t('act.guardtoggle.oneAgent'),
          bound: t('act.guardtoggle.boundCount', { n: bound.length }),
          mine: agent ? t(mine ? 'act.guardtoggle.iAmOne' : 'act.guardtoggle.iAmNot') : '',
          detail: guardDetail(g),
          reask: agent ? t('act.guardtoggle.reaskAgent', { q: prev }) : t('act.guardtoggle.reaskConsole'),
        }) + PENDING(),
        table: T(t('act.touched'), [
          [rows.guardrail, name],
          [rows.state, arrow(g.enabled ? t('common.on') : t('common.off'), state)],
          [rows.bound, joinList(bound.map(agentName)) || NONE()],
          [rows.visible, t('act.guardtoggle.visibleIn')],
        ]),
        actions: [{
          label: t(agent ? 'act.guardtoggle.btnReask' : 'act.guardtoggle.btn', { name, state }),
          doingLabel: t('act.applying'),
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
  const name = guardName(g);
  const state = target ? t('common.on') : t('common.off');
  const rows = t('act.guardtoggle.appliedRows');
  const on = s.guardrails.filter((x) => x.enabled).length;
  return {
    text: t('act.guardtoggle.applied', {
      name, state, note: willAsk ? t('act.guardtoggle.reasking', { q: prev }) : '',
    }),
    table: T(t('act.beforeAfter'), [
      [rows.rule, before ? t('common.on') : t('common.off'), state],
      [rows.on, String(on - (target ? 1 : -1)), t('act.guardtoggle.onOf', { n: on, total: s.guardrails.length })],
      [rows.agents, String(bound.length), joinList(bound.map(agentName)) || NONE()],
    ]),
    meta: t('act.guardtoggle.updated'),
    actions: willAsk ? null : [{
      label: t('act.openGuardrails'),
      run: () => { goTo('guardrails'); return { text: t('act.guardtoggle.cardReads', { name, state }) }; },
    }],
    then: willAsk ? () => { setTimeout(() => session.bot.ask(prev), 260); } : null,
  };
}

/* Connect or disconnect one of this agent's own tools. */
export function toolConnIntent(store, agent) {
  return {
    id: 'toolconn',
    operator: true,
    match: [
      /\b(disconnect|reconnect|unplug|plug in|connect)\b/i,
      /\b(turn|switch)\s+(the\s+)?\w*\s*(crm|email|sheets|ticketing|webhook)\b/i,
      /(افصل|اقطع|أعد وصل|أوصل|صِل)[^؟]*(اتصال|أداة|البريد|إدارة العملاء|الجداول|التذاكر|خطّاف)/,
    ],
    trace: t('act.toolconn.trace'),
    answer: (q) => {
      const s = store.state;
      const mine = agent.tools.map((id) => toolById(s, id)).filter(Boolean);
      const tool = findTool(s, q) || mine.find((x) => !x.connected) || mine[0] || s.tools[0];
      const want = direction(q);
      const target = want === null ? !tool.connected : want;
      const isMine = agent.tools.includes(tool.id);
      const name = toolName(tool);
      if (target === tool.connected) {
        return {
          text: t('act.toolconn.alreadyShort', { name, state: tool.connected ? t('common.connected') : t('common.disconnected') }),
          actions: [{
            label: t('act.toolconn.insteadGeneric', { state: tool.connected ? t('common.off') : t('common.on') }),
            run: () => applyTool(store, tool.id, !tool.connected),
          }],
        };
      }
      const rows = t('act.toolconn.rows');
      return {
        text: t('act.toolconn.mineText', {
          name, target: target ? t('common.connected') : t('common.disconnected'),
          mine: t(isMine ? 'act.toolconn.isMine' : 'act.toolconn.notMine'),
          description: toolDesc(tool),
        }) + PENDING(),
        table: T(t('act.touched'), [
          [rows.connection, `${name} — ${toolAccount(tool)}`],
          [rows.state, arrow(tool.connected ? t('common.connected') : t('common.disconnected'), target ? t('common.connected') : t('common.disconnected'))],
          [rows.mine, isMine ? t('common.yes') : t('common.no')],
          [rows.myTools, joinList(agent.tools.map((id) => toolName(toolById(s, id))).filter(Boolean))],
        ]),
        actions: [{
          label: t(target ? 'act.toolconn.connect' : 'act.toolconn.disconnect', { name }),
          doingLabel: t('act.applying'),
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
    match: [
      /\b(escalate|escalation)\b[^?]*\b(ticket|tck-?\d+|it|this|oldest)\b/i, /^\s*escalate\b/i,
      /\b(assign|reassign|hand)\b[^?]*\b(ticket|tck-?\d+|it|this|to)\b/i,
      /(صعّد|صعد|رفّع)[^؟]*(تذكرة|التذكرة|tck-?\d+|أقدم)/, /^\s*(صعّد|صعد)\b/,
      /(أسنِد|أسند|اسند|أعد إسناد|حوّل)[^؟]*(تذكرة|التذكرة|tck-?\d+|مكتب)/,
    ],
    tools: ['ticketing'],
    trace: t('act.ticketaction.trace'),
    answer: (q) => {
      const s = store.state;
      const tk = ticketFrom(s, q);
      const load = s.tickets.filter((x) => x.status !== 'resolved')
        .reduce((m, x) => { m[x.assignee] = (m[x.assignee] || 0) + 1; return m; }, {});
      const gEsc = guardById(s, 'escalate');
      if (!tk) return { text: t('act.ticketaction.none') };
      const lightest = Object.entries(load).sort((a, b) => a[1] - b[1])[0] || [tk.assignee, 0];
      const rows = t('act.ticketaction.rows');
      const ev = t('act.ticketaction.ev');

      return {
        text: t('act.ticketaction.text', {
          id: tk.id, subject: subjectLabel(tk.subject), customer: tk.customer, age: tk.ageH,
          priority: priorityLabel(tk.priority), assignee: tk.assignee, queue: guardQueue(gEsc),
          lightest: lightest[0], n: lightest[1],
        }) + PENDING(),
        table: T(t('act.ticketaction.head'), [
          [rows.status, ticketStatusLabel(tk.status), ticketStatusLabel('escalated')],
          [rows.priority, priorityLabel(tk.priority), priorityLabel('Urgent')],
          [rows.owner, tk.assignee, guardQueue(gEsc)],
          [rows.reference, t('common.dash'), `ESC-${s.counters.escalationSeq + 1}`],
        ]),
        actions: [
          {
            label: t('act.ticketaction.escalateBtn', { id: tk.id }),
            doingLabel: t('act.ticketaction.escalating'),
            run: () => {
              const s1 = store.state;
              const ref = `ESC-${s1.counters.escalationSeq + 1}`;
              const before = { status: tk.status, priority: tk.priority, assignee: tk.assignee };
              store.update((st) => {
                const x = st.tickets.find((y) => y.id === tk.id);
                x.status = 'escalated'; x.priority = 'Urgent'; x.escalationRef = ref; x.assignee = gEsc.queue;
                st.counters.escalationSeq += 1;
              });
              const trace = [
                { label: t('eng.ev.accepted'), kind: 'system', status: 'ok', ms: jit(4, 14), detail: t('act.ticketaction.ev.operator', { model: agent.model }) },
                { label: ev.search, kind: 'tool', status: 'ok', ms: jit(90, 260), detail: t('act.ticketaction.ev.searchDetail', { id: tk.id }) },
                { label: ev.lookup, kind: 'tool', status: 'ok', ms: jit(80, 240), detail: `${tk.customer} · ${tk.contact}` },
                { label: ev.guard, kind: 'guardrail', status: 'escalated', ms: jit(3, 11), detail: t('act.ticketaction.ev.guardDetail', { queue: guardQueue(gEsc), ref }) },
                { label: ev.update, kind: 'tool', status: 'ok', ms: jit(120, 320), detail: t('act.ticketaction.ev.updateDetail') },
                { label: ev.note, kind: 'agent', status: 'ok', ms: jit(200, 520), detail: t('act.ticketaction.ev.noteDetail', { subject: subjectLabel(tk.subject), age: tk.ageH }) },
              ];
              const w = writeActionRun(store, {
                agentId: agent.id, status: 'escalated', trace, question: `escalate ${tk.id}`,
                tokensIn: jit(700, 1400), tokensOut: jit(120, 300),
                guardrails: agent.guardrails.map((g) => ({ id: g, verdict: g === 'escalate' ? 'escalated' : 'passed' })),
              });
              refreshApp();
              const x = store.state.tickets.find((y) => y.id === tk.id);
              return {
                text: t('act.ticketaction.escalated', { id: tk.id, ref, queue: guardQueue(gEsc) }),
                table: T(t('act.beforeAfter'), [
                  [rows.status, ticketStatusLabel(before.status), ticketStatusLabel(x.status)],
                  [rows.priority, priorityLabel(before.priority), priorityLabel(x.priority)],
                  [rows.owner, before.assignee, x.assignee],
                  [t('act.ticketaction.raisedHere'), String(s1.counters.escalationSeq - 4180), String(store.state.counters.escalationSeq - 4180)],
                ]),
                meta: t('act.ticketaction.escMeta', { id: w.id }),
                actions: [
                  { label: t('act.openTrace'), run: () => { goTo(`runs/${w.id}`); return { text: t('act.ticketaction.escTraceNote') }; } },
                  { label: t('act.openGuardrails'), run: () => { goTo('guardrails'); return { text: t('act.ticketaction.guardLogNote') }; } },
                ],
              };
            },
          },
          {
            label: t('act.ticketaction.assignBtn', { name: lightest[0] }),
            doingLabel: t('act.ticketaction.assigning'),
            run: () => {
              const before = tk.assignee;
              store.update((st) => {
                const x = st.tickets.find((y) => y.id === tk.id);
                x.assignee = lightest[0];
              });
              const trace = [
                { label: t('eng.ev.accepted'), kind: 'system', status: 'ok', ms: jit(4, 14), detail: t('eng.ev.skipChecksDetail') },
                { label: ev.search, kind: 'tool', status: 'ok', ms: jit(90, 260), detail: t('act.ticketaction.ev.searchDetail', { id: tk.id }) },
                { label: ev.load, kind: 'agent', status: 'ok', ms: jit(120, 380), detail: t('act.ticketaction.ev.loadDetail', { name: lightest[0] }) },
                { label: ev.update, kind: 'tool', status: 'ok', ms: jit(120, 300), detail: t('act.ticketaction.ev.owner', { from: before, to: lightest[0] }) },
              ];
              const w = writeActionRun(store, {
                agentId: agent.id, status: 'success', trace, question: `assign ${tk.id}`,
                tokensIn: jit(600, 1100), tokensOut: jit(90, 220),
                guardrails: agent.guardrails.map((g) => ({ id: g, verdict: 'passed' })),
              });
              refreshApp();
              const arows = t('act.ticketaction.assignRows');
              return {
                text: t('act.ticketaction.assigned', { id: tk.id, name: lightest[0] }),
                table: T(t('act.beforeAfter'), [
                  [arows.owner, before, lightest[0]],
                  [arows.theirItems, String(lightest[1]), String(lightest[1] + 1)],
                  [arows.runs, String(store.state.runs.length - 1), String(store.state.runs.length)],
                ]),
                meta: t('act.runWritten', { id: w.id }),
                actions: [{ label: t('act.openTrace'), run: () => { goTo(`runs/${w.id}`); return { text: t('act.ticketaction.assignTraceNote') }; } }],
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
      /(رحّل|رحل|رحّلي|اعتمد|أرسل للاعتماد|سجّل)[^؟]*(فاتورة|الفاتورة|inv-?\d+|للاعتماد|المصنّف)/,
    ],
    trace: t('act.postinvoice.trace'),
    answer: (q) => {
      const s = store.state;
      const inv = invoiceFrom(s, q);
      const sheets = toolById(s, 'sheets');
      const held = s.invoices.filter((x) => !x.postedToSheet);
      if (!inv) return { text: t('act.postinvoice.nothing') };
      const tax = Math.round(inv.amount * inv.taxPct / 100);
      const ev = t('act.postinvoice.ev');

      const post = () => {
        const before = {
          posted: store.state.invoices.filter((x) => x.postedToSheet).length,
          state: inv.postedToSheet ? t('act.postinvoice.statePosted') : t('act.postinvoice.stateHeld'),
        };
        store.update((st) => {
          const x = st.invoices.find((y) => y.id === inv.id);
          x.postedToSheet = true;
          x.approvalState = 'pending approval';
          x.postedAt = new Date().toISOString();
        });
        const trace = [
          { label: t('eng.ev.accepted'), kind: 'system', status: 'ok', ms: jit(4, 14), detail: t('act.ticketaction.ev.operator', { model: agent.model }) },
          { label: ev.search, kind: 'tool', status: 'ok', ms: jit(120, 300), detail: t('act.postinvoice.ev.searchDetail', { id: inv.id }) },
          { label: ev.fields, kind: 'agent', status: 'ok', ms: jit(700, 1800), detail: t('act.postinvoice.ev.fieldsDetail', { c: inv.confidence, n: inv.lines }) },
          { label: ev.po, kind: 'condition', status: inv.variance === 0 ? 'ok' : 'blocked', ms: jit(40, 120), detail: inv.variance === 0 ? t('act.postinvoice.ev.poOk', { po: inv.po }) : t('act.postinvoice.ev.poBad', { po: inv.po, amount: money(inv.variance) }) },
          { label: ev.append, kind: 'tool', status: 'ok', ms: jit(180, 420), detail: t('act.postinvoice.ev.appendDetail') },
          { label: ev.hook, kind: 'tool', status: toolById(store.state, 'webhook').connected ? 'ok' : 'skipped', ms: jit(60, 180), detail: 'invoice.posted' },
        ];
        const w = writeActionRun(store, {
          agentId: agent.id, status: 'success', trace, question: `post ${inv.id} for approval`,
          tokensIn: jit(1400, 2600), tokensOut: jit(90, 240),
          guardrails: agent.guardrails.map((g) => ({ id: g, verdict: 'passed' })),
        });
        refreshApp();
        const after = store.state.invoices.filter((x) => x.postedToSheet).length;
        const drows = t('act.postinvoice.doneRows');
        return {
          text: t('act.postinvoice.done', { id: inv.id }),
          table: T(t('act.beforeAfter'), [
            [drows.invoice, before.state, t('act.postinvoice.statePending')],
            [drows.rows, String(before.posted), String(after)],
            [drows.held, String(s.invoices.length - before.posted), String(s.invoices.length - after)],
            [drows.value, money(sum(held, (x) => x.amount)), money(sum(store.state.invoices.filter((x) => !x.postedToSheet), (x) => x.amount))],
          ]),
          meta: t('act.runWritten', { id: w.id }),
          actions: [{ label: t('act.openTrace'), run: () => { goTo(`runs/${w.id}`); return { text: t('act.postinvoice.traceNote') }; } }],
        };
      };

      const rows = t('act.postinvoice.rows');
      return {
        text: t('act.postinvoice.text', {
          id: inv.id, vendor: inv.vendor, amount: money(inv.amount), date: fmtDate(inv.dateIso),
          confidence: inv.confidence, sheets: sheets.connected ? '' : t('act.postinvoice.sheetsOff'),
        }) + PENDING(),
        table: T(t('act.field'), [
          [rows.invoice, `${inv.id} · ${inv.vendor}`],
          [rows.total, t('act.postinvoice.totalWithTax', { amount: money(inv.amount), pct: inv.taxPct, tax: money(tax) })],
          [rows.po, inv.variance ? t('act.postinvoice.poOut', { po: inv.po, amount: money(inv.variance) }) : t('act.postinvoice.poTies', { po: inv.po })],
          [rows.destination, t('act.postinvoice.destination')],
          [rows.after, t('act.postinvoice.afterPosting')],
        ]),
        actions: sheets.connected
          ? [{ label: t('act.postinvoice.btn', { id: inv.id }), doingLabel: t('act.postinvoice.doing'), run: post }]
          : [{
            label: t('act.postinvoice.connectFirst'),
            doingLabel: t('act.postinvoice.connecting'),
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
      /(حرّك|حرك|قدّم|قدم|انقل|رقِّ)[^؟]*(حساب|الحساب|acc-?\d+|خطوة|الخطوة|متعثّر)/,
    ],
    tools: ['crm'],
    trace: t('act.advance.trace'),
    answer: (q) => {
      const s = store.state;
      const a = accountFrom(s, q);
      if (!a) return { text: t('act.advance.noAccounts') };
      if (a.stepIdx >= ONBOARD_STEPS.length - 1) {
        return { text: t('act.advance.last', { name: a.name, step: onboardStepLabel(a.step) }) };
      }
      const next = ONBOARD_STEPS[a.stepIdx + 1];
      const rows = t('act.advance.rows');
      const ev = t('act.advance.ev');
      return {
        text: t('act.advance.text', {
          name: a.name, id: a.id, plan: planLabel(a.plan), region: regionLabel(a.region),
          days: a.stuckDays, step: onboardStepLabel(a.step), next: onboardStepLabel(next),
        }) + PENDING(),
        table: T(t('act.advance.head'), [
          [rows.step,
            t('act.advance.stepOf', { i: a.stepIdx + 1, name: onboardStepLabel(a.step) }),
            t('act.advance.stepOf', { i: a.stepIdx + 2, name: onboardStepLabel(next) })],
          [rows.days, String(a.stuckDays), '0'],
          [rows.owner, a.owner, a.owner],
          [rows.contact, a.contact, a.contact],
        ]),
        actions: [{
          label: t('act.advance.btn', { name: a.name }),
          doingLabel: t('act.advance.doing'),
          run: () => {
            const before = { step: a.step, idx: a.stepIdx, days: a.stuckDays };
            const stuckBefore = store.state.accounts.filter((x) => x.stuckDays >= 5).length;
            store.update((st) => {
              const x = st.accounts.find((y) => y.id === a.id);
              x.stepIdx += 1; x.step = ONBOARD_STEPS[x.stepIdx]; x.stuckDays = 0;
            });
            const trace = [
              { label: t('eng.ev.accepted'), kind: 'system', status: 'ok', ms: jit(4, 14), detail: t('act.ticketaction.ev.operator', { model: agent.model }) },
              { label: ev.read, kind: 'tool', status: 'ok', ms: jit(90, 260), detail: t('act.advance.ev.readDetail', { id: a.id, name: a.name }) },
              { label: ev.checklist, kind: 'agent', status: 'ok', ms: jit(150, 420), detail: t('act.advance.ev.checklistDetail', { from: onboardStepLabel(before.step), to: onboardStepLabel(next) }) },
              { label: ev.note, kind: 'tool', status: 'ok', ms: jit(110, 280), detail: t('act.advance.ev.noteDetail') },
              { label: ev.nudge, kind: 'agent', status: 'ok', ms: jit(200, 600), detail: t('act.advance.ev.nudgeDetail', { contact: a.contact }) },
            ];
            const w = writeActionRun(store, {
              agentId: agent.id, status: 'success', trace, question: `advance ${a.id}`,
              tokensIn: jit(500, 900), tokensOut: jit(140, 380),
              guardrails: agent.guardrails.map((g) => ({ id: g, verdict: 'passed' })),
            });
            refreshApp();
            const x = store.state.accounts.find((y) => y.id === a.id);
            const drows = t('act.advance.doneRows');
            return {
              text: t('act.advance.done', { name: a.name, i: x.stepIdx + 1, step: onboardStepLabel(x.step), contact: a.contact }),
              table: T(t('act.beforeAfter'), [
                [drows.step,
                  t('act.advance.stepShort', { i: before.idx + 1, name: onboardStepLabel(before.step) }),
                  t('act.advance.stepShort', { i: x.stepIdx + 1, name: onboardStepLabel(x.step) })],
                [drows.days, String(before.days), String(x.stuckDays)],
                [drows.stuck, String(stuckBefore), String(store.state.accounts.filter((y) => y.stuckDays >= 5).length)],
              ]),
              meta: t('act.runWritten', { id: w.id }),
              actions: [{ label: t('act.openTrace'), run: () => { goTo(`runs/${w.id}`); return { text: t('act.advance.traceNote') }; } }],
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
      /(أنشئ|انشئ|ولّد|أصدر|احفظ|خزّن)[^؟]*(تقرير|التقرير|ملخّص|الملخّص)/,
      /(اكتب)[^؟]*(تقرير|التقرير)[^؟]*(واحفظ|وخزّن)/,
    ],
    tools: ['sheets'],
    trace: t('act.genreport.trace'),
    answer: () => {
      const s = store.state;
      const m = s.metrics;
      const cur = m[m.length - 1]; const prev = m[m.length - 2];
      const stored = (s.reports || []).length;
      const delta = prev.runs ? ((cur.runs - prev.runs) / prev.runs) * 100 : 0;
      const rows = t('act.genreport.rows');
      const ev = t('act.genreport.ev');
      return {
        text: t('act.genreport.text', {
          week: m.length,
          stored: stored ? t('act.genreport.storedSome', { n: stored }) : t('act.genreport.storedNone'),
        }) + PENDING(),
        table: T(t('act.genreport.head'), [
          [rows.runs, num(cur.runs), num(prev.runs)],
          [rows.clean, num(cur.success), num(prev.success)],
          [rows.escalations, String(cur.escalations), String(prev.escalations)],
          [rows.cost, rupees(cur.costPaise), rupees(prev.costPaise)],
        ]),
        actions: [{
          label: t('act.genreport.btn'),
          doingLabel: t('act.genreport.doing'),
          run: () => {
            const s1 = store.state;
            const rate = cur.runs ? (cur.success / cur.runs) * 100 : 0;
            const body = t('act.genreport.body', {
              week: m.length, runs: num(cur.runs),
              dir: delta >= 0 ? t('act.genreport.up') : t('act.genreport.down'),
              delta: pct(Math.abs(delta), 1), clean: num(cur.success), rate: pct(rate, 1),
              escalations: cur.escalations, tokens: num(cur.tokens), cost: rupees(cur.costPaise),
              each: rupees(Math.round(cur.costPaise / cur.runs)), agent: agentName(agent),
              date: fmtDate(new Date()), held: s1.runs.length,
            });
            const id = `RPT-${1200 + (s1.reports || []).length + 1}`;
            store.update((st) => {
              if (!Array.isArray(st.reports)) st.reports = [];
              st.reports.unshift({
                id, title: t('act.genreport.title', { n: m.length }),
                createdAt: new Date().toISOString(), agentId: agent.id, body,
                metrics: { runs: cur.runs, clean: cur.success, escalations: cur.escalations, costPaise: cur.costPaise },
              });
              st.reports = st.reports.slice(0, 20);
            });
            const trace = [
              { label: t('eng.ev.accepted'), kind: 'system', status: 'ok', ms: jit(4, 14), detail: t('act.ticketaction.ev.operator', { model: agent.model }) },
              { label: ev.read, kind: 'tool', status: 'ok', ms: jit(280, 620), detail: 'Ops!A1:H60' },
              { label: ev.compared, kind: 'agent', status: 'ok', ms: jit(600, 1400), detail: t('act.genreport.ev.comparedDetail', { delta: `${delta >= 0 ? '+' : ''}${pct(delta, 1)}` }) },
              { label: ev.written, kind: 'agent', status: 'ok', ms: jit(900, 2200), detail: t('act.genreport.ev.writtenDetail', { n: body.length }) },
              { label: ev.append, kind: 'tool', status: 'ok', ms: jit(160, 380), detail: t('act.genreport.ev.appendDetail', { id }) },
              { label: ev.held, kind: 'output', status: 'ok', ms: jit(20, 60), detail: t('act.genreport.ev.heldDetail', { list: s1.settings.distribution }) },
            ];
            const w = writeActionRun(store, {
              agentId: agent.id, status: 'success', trace, question: 'generate and store the weekly report',
              tokensIn: jit(2400, 3800), tokensOut: jit(400, 800),
              guardrails: agent.guardrails.map((g) => ({ id: g, verdict: 'passed' })),
            });
            refreshApp();
            const drows = t('act.genreport.doneRows');
            return {
              text: t('act.genreport.done', { id, extract: body.split('\n\n').slice(1, 3).join('\n\n') }),
              table: T(t('act.beforeAfter'), [
                [drows.reports, String(stored), String((store.state.reports || []).length)],
                [drows.runs, String(s1.runs.length), String(store.state.runs.length)],
                [drows.latest, stored ? (s1.reports[0] || {}).id || t('common.dash') : t('act.genreport.noneYet'), id],
              ]),
              meta: t('act.runWritten', { id: w.id }),
              actions: [
                { label: t('act.openSettings'), run: () => { goTo('settings'); return { text: t('act.genreport.settingsNote', { id }) }; } },
                { label: t('act.openTrace'), run: () => { goTo(`runs/${w.id}`); return { text: t('act.genreport.traceNote') }; } },
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
