/* ============================================================
   Agentline — the execution layer the whole app shares.

   Three things live here so that a workflow started from the
   Workflows screen and a workflow started by an agent are the same
   thing, not two implementations that drift apart:

     1. the run engine (plan a workflow, execute it, write the run)
     2. a refresh bus, so a change an agent applies shows up on
        whatever screen is currently open
     3. a small hand-off, so an agent can ask the Workflows screen to
        stream the steps into its run log rather than run it silently

   No network, no timers beyond the ones that pace the log.
   ============================================================ */

import {
  toolById, agentById, newRunId, estimateCost,
  toolName, agentName, agentStatusLabel, statusLabel, triggerLabel, stepName, stepDetail, outputLabel,
} from './data.js';
import { t } from './main.js';

/* ---------- refresh bus ---------- */
const subs = new Set();
export function onAppRefresh(fn) { subs.add(fn); return () => subs.delete(fn); }
export function refreshApp() { subs.forEach((f) => { try { f(); } catch (_) { /* a dead view must not break an action */ } }); }
export function goTo(path) { location.hash = `#/${path}`; }

/* ---------- planning ----------
   A step is decided before anything runs: a disabled step is skipped, a
   tool step whose connection is off fails, an agent step whose agent is
   not live is skipped. That is the whole reason the toggles elsewhere in
   the app matter. */
export function planRun(state, wf) {
  const steps = [];
  for (const st of wf.steps) {
    if (!st.enabled) {
      steps.push({ ...st, result: 'skipped', reason: t('run.stepDisabled') });
      continue;
    }
    if (st.kind === 'tool') {
      const tool = toolById(state, st.ref);
      if (tool && !tool.connected) {
        steps.push({ ...st, result: 'failed', reason: t('run.toolDown', { name: toolName(tool) }) });
        continue;
      }
      steps.push({ ...st, result: 'ok', reason: t('run.toolOk', { name: toolName(tool) || st.ref }) });
      continue;
    }
    if (st.kind === 'agent') {
      const a = agentById(state, st.ref);
      if (a && a.status !== 'live') {
        steps.push({ ...st, result: 'skipped', reason: t('run.agentNotLive', { name: agentName(a), status: agentStatusLabel(a.status) }) });
        continue;
      }
      steps.push({ ...st, result: 'ok', reason: t('run.agentOk', { name: agentName(a) || st.ref }) });
      continue;
    }
    steps.push({ ...st, result: 'ok', reason: stepDetail(st.detail) || t('run.evaluated') });
  }
  const failed = steps.some((s) => s.result === 'failed');
  const skipped = steps.some((s) => s.result === 'skipped');
  return { steps, status: failed ? 'failed' : skipped ? 'blocked' : 'success' };
}

/* ---------- execution ----------
   Resolves with a summary once the last line is written. `onLine` is how
   the Workflows screen paints the run log; without it the run is silent
   but writes exactly the same record. */
export function executeWorkflow(store, wf, { onLine, pace = 260 } = {}) {
  return new Promise((resolve) => {
    const state = store.state;
    const plan = planRun(state, wf);
    const agentStep = wf.steps.find((s) => s.kind === 'agent');
    const agent = agentStep ? agentById(state, agentStep.ref) : null;
    const runId = newRunId();
    const line = (clockLabel, msg, status) => { if (onLine) onLine(clockLabel, msg, status); };

    let clock = 0;
    const trace = [{ label: 'Trigger fired', kind: 'system', status: 'ok', ms: 12, detail: triggerLabel(wf) }];
    line('0.00s', t('run.logTrigger', { label: triggerLabel(wf) }), 'ok');

    let i = 0;
    const tick = () => {
      if (i >= plan.steps.length) { done(); return; }
      const st = plan.steps[i++];
      const ms = st.result === 'skipped' ? 0 : Math.round(st.avgMs * (0.6 + Math.random() * 0.9));
      clock += ms;
      line(`${(clock / 1000).toFixed(2)}s`, t('run.logStep', { name: stepName(st.name), reason: st.reason }), st.result);
      trace.push({ label: st.name, kind: st.kind, status: st.result, ms, detail: st.reason });
      setTimeout(tick, pace ? pace + Math.random() * 320 : 0);
    };

    function done() {
      const tokensIn = agent ? Math.round(agent.avgTokens.in * (0.8 + Math.random() * 0.5)) : 640;
      const tokensOut = agent ? Math.round(agent.avgTokens.out * (0.8 + Math.random() * 0.5)) : 180;
      const costPaise = estimateCost(tokensIn, tokensOut);
      clock += 40;
      trace.push({ label: 'Outputs written', kind: 'output', status: plan.status === 'success' ? 'ok' : plan.status, ms: 40, detail: wf.outputs.map(outputLabel).join(' · ') });
      line(`${(clock / 1000).toFixed(2)}s`, t('run.logOutputs', { list: wf.outputs.map(outputLabel).join(t('common.listSep')) }), plan.status === 'success' ? 'ok' : plan.status);
      line(`${(clock / 1000).toFixed(2)}s`, t('run.logDone', { id: runId, status: statusLabel(plan.status), tokens: tokensIn + tokensOut }), plan.status === 'success' ? 'ok' : plan.status);

      store.update((s) => {
        const w = s.workflows.find((x) => x.id === wf.id);
        if (w) w.lastRunAt = new Date().toISOString();
        s.runs.unshift({
          id: runId,
          agentId: agent ? agent.id : (s.agents[0] || {}).id,
          workflowId: wf.id,
          trigger: 'Workflow',
          status: plan.status,
          startedAt: new Date().toISOString(),
          durationMs: clock,
          tokensIn, tokensOut, costPaise,
          guardrails: (agent ? agent.guardrails : []).map((g) => ({ id: g, verdict: 'passed' })),
          trace,
        });
        s.runs = s.runs.slice(0, 90);
      });

      resolve({
        runId, status: plan.status, durationMs: clock, tokensIn, tokensOut, costPaise,
        steps: plan.steps, workflowId: wf.id, workflowName: wf.name,
        ok: plan.steps.filter((x) => x.result === 'ok').length,
      });
    }

    setTimeout(tick, pace ? 320 : 0);
  });
}

/* ---------- hand-off to the Workflows screen ----------
   An agent that is asked to run a workflow does not run it in a hidden
   corner: it points the app at the workflow and lets that screen stream
   the steps. If the screen never picks the request up (no view mounted,
   for instance) the run happens anyway, quietly, after a short wait. */
let pending = null;

export function requestWorkflowRun(store, wf) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; resolve(r); } };
    pending = { wfId: wf.id, start: (opts) => executeWorkflow(store, wf, opts).then((r) => { finish(r); return r; }) };
    goTo(`workflows/${wf.id}`);
    setTimeout(() => {
      if (pending && pending.wfId === wf.id) {
        pending = null;
        executeWorkflow(store, wf, { pace: 0 }).then((r) => { refreshApp(); finish(r); });
      }
    }, 1600);
  });
}

export function consumeWorkflowRun(wfId) {
  if (pending && pending.wfId === wfId) { const p = pending; pending = null; return p.start; }
  return null;
}

/* ---------- writing a run for a single agent action ----------
   Every action an agent applies leaves the same kind of record a
   conversation turn leaves, so it shows up in Runs with a real trace. */
export function writeActionRun(store, {
  agentId, question, status = 'success', trace, tokensIn = 640, tokensOut = 180,
  trigger = 'Agent action', guardrails = [], workflowId = null,
}) {
  const id = newRunId();
  const durationMs = trace.reduce((a, e) => a + (e.ms || 0), 0);
  const costPaise = estimateCost(tokensIn, tokensOut);
  const startedAt = new Date().toISOString();
  store.update((s) => {
    s.runs.unshift({
      id, agentId, workflowId, trigger, status, startedAt, durationMs,
      tokensIn, tokensOut, costPaise, question, guardrails, trace,
    });
    s.runs = s.runs.slice(0, 90);
  });
  return { id, durationMs, costPaise, startedAt };
}

/* jitter used by the action traces so two runs never read identically */
export const jit = (a, b) => a + Math.round(Math.random() * (b - a));
