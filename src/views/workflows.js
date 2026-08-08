/* Workflows — trigger, steps, outputs. Steps can be added, removed,
   reordered and disabled, and "Run" streams a live step-by-step log
   that writes a real run into the Runs screen. */

import { h, icon, num, ago, toast, modal, confirmDialog } from '../../lib/ui.js';
import { workflowById, toolById, agentById, newRunId, estimateCost, rupees } from '../data.js';

const KIND_LABEL = { tool: 'Tool call', agent: 'Agent', condition: 'Condition', output: 'Output' };
const KIND_ICON = { tool: 'grid', agent: 'spark', condition: 'filter', output: 'download' };

/* ---------- planning a run ---------- */
function planRun(state, wf) {
  const steps = [];
  for (const st of wf.steps) {
    if (!st.enabled) {
      steps.push({ ...st, result: 'skipped', reason: 'step disabled' });
      continue;
    }
    if (st.kind === 'tool') {
      const tool = toolById(state, st.ref);
      if (tool && !tool.connected) {
        steps.push({ ...st, result: 'failed', reason: `${tool.name} is disconnected` });
        continue;
      }
      steps.push({ ...st, result: 'ok', reason: `${tool ? tool.name : st.ref} responded` });
      continue;
    }
    if (st.kind === 'agent') {
      const a = agentById(state, st.ref);
      if (a && a.status !== 'live') {
        steps.push({ ...st, result: 'skipped', reason: `${a.name} is ${a.status}` });
        continue;
      }
      steps.push({ ...st, result: 'ok', reason: `${a ? a.name : st.ref} finished` });
      continue;
    }
    steps.push({ ...st, result: 'ok', reason: st.detail || 'evaluated true' });
  }
  const failed = steps.some((s) => s.result === 'failed');
  const skipped = steps.some((s) => s.result === 'skipped');
  return { steps, status: failed ? 'failed' : skipped ? 'blocked' : 'success' };
}

/* ---------- the run log ---------- */
function runWorkflow(ctx, wf, logHost, headerHost) {
  const state = ctx.state;
  const plan = planRun(state, wf);
  const agentStep = wf.steps.find((s) => s.kind === 'agent');
  const agent = agentStep ? agentById(state, agentStep.ref) : null;
  const runId = newRunId();

  logHost.innerHTML = '';
  logHost.hidden = false;
  headerHost.textContent = 'running';
  headerHost.className = 'pill pill--amber';

  const line = (t, msg, status) => h('div', { class: 'runlog__line' },
    h('span', { class: 'runlog__t' }, t),
    h('span', { class: 'runlog__msg' }, msg),
    h('span', { class: `runlog__st runlog__st--${status}` }, status));

  let clock = 0;
  const trace = [{ label: 'Trigger fired', kind: 'system', status: 'ok', ms: 12, detail: wf.trigger.label }];
  logHost.appendChild(line('0.00s', `trigger — ${wf.trigger.label}`, 'ok'));

  let i = 0;
  const tick = () => {
    if (i >= plan.steps.length) return done();
    const st = plan.steps[i++];
    const ms = st.result === 'skipped' ? 0 : Math.round(st.avgMs * (0.6 + Math.random() * 0.9));
    clock += ms;
    logHost.appendChild(line(`${(clock / 1000).toFixed(2)}s`, `${st.name} — ${st.reason}`, st.result === 'ok' ? 'ok' : st.result));
    logHost.scrollTop = logHost.scrollHeight;
    trace.push({ label: st.name, kind: st.kind, status: st.result === 'ok' ? 'ok' : st.result, ms, detail: st.reason });
    setTimeout(tick, 260 + Math.random() * 320);
  };

  function done() {
    const tokensIn = agent ? Math.round(agent.avgTokens.in * (0.8 + Math.random() * 0.5)) : 640;
    const tokensOut = agent ? Math.round(agent.avgTokens.out * (0.8 + Math.random() * 0.5)) : 180;
    const costPaise = estimateCost(tokensIn, tokensOut);
    clock += 40;
    trace.push({ label: 'Outputs written', kind: 'output', status: plan.status === 'success' ? 'ok' : plan.status, ms: 40, detail: wf.outputs.join(' · ') });
    logHost.appendChild(line(`${(clock / 1000).toFixed(2)}s`, `outputs — ${wf.outputs.join(', ')}`, plan.status === 'success' ? 'ok' : plan.status));
    logHost.appendChild(line(`${(clock / 1000).toFixed(2)}s`, `run ${runId} finished ${plan.status} · ${num(tokensIn + tokensOut)} tokens · ${rupees(costPaise)}`, plan.status === 'success' ? 'ok' : plan.status));
    logHost.scrollTop = logHost.scrollHeight;

    headerHost.textContent = plan.status;
    headerHost.className = `pill ${plan.status === 'success' ? 'pill--ok' : plan.status === 'failed' ? 'pill--bad' : 'pill--info'}`;

    ctx.store.update((s) => {
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

    toast(`Run ${plan.status} — open it in Runs`, plan.status === 'success' ? 'ok' : 'bad');
    logHost.appendChild(h('div', { class: 'runlog__line' },
      h('span', { class: 'runlog__t' }, ''),
      h('span', { class: 'runlog__msg' },
        h('button', { class: 'btn btn--sm', onclick: () => ctx.navigate(`runs/${runId}`) }, 'Open the trace')),
      h('span', { class: 'runlog__st' }, '')));
  }

  setTimeout(tick, 320);
}

/* ---------- add step ---------- */
function addStepForm(ctx, wf) {
  const s = ctx.state;
  const refWrap = h('div', { class: 'field' });
  const kindSel = h('select', { class: 'select', name: 'kind' },
    Object.entries(KIND_LABEL).map(([k, v]) => h('option', { value: k }, v)));

  const paintRef = () => {
    const kind = kindSel.value;
    refWrap.innerHTML = '';
    refWrap.appendChild(h('span', { class: 'field__label' }, kind === 'tool' ? 'Tool' : kind === 'agent' ? 'Agent' : 'Reference'));
    if (kind === 'tool') {
      refWrap.appendChild(h('select', { class: 'select', name: 'ref' }, s.tools.map((t) => h('option', { value: t.id }, t.name))));
    } else if (kind === 'agent') {
      refWrap.appendChild(h('select', { class: 'select', name: 'ref' }, s.agents.map((a) => h('option', { value: a.id }, a.name))));
    } else {
      refWrap.appendChild(h('input', { class: 'input', name: 'ref', placeholder: 'optional', value: '' }));
    }
  };
  kindSel.addEventListener('change', paintRef);

  const body = h('div', {},
    h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Step name'),
      h('input', { class: 'input', name: 'name', placeholder: 'Check credit limit' })),
    h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Kind'), kindSel),
    refWrap,
    h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'What it does'),
      h('input', { class: 'input', name: 'detail', placeholder: 'reads the account limit and compares' })),
    h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Typical duration (ms)'),
      h('input', { class: 'input', name: 'avgMs', type: 'number', min: '20', max: '9000', value: '320' })));
  paintRef();

  modal({
    title: `Add a step to ${wf.name}`,
    body,
    actions: [
      { label: 'Cancel' },
      {
        label: 'Add step',
        class: 'btn--primary',
        onClick: (bodyEl) => {
          const val = (n) => (bodyEl.querySelector(`[name="${n}"]`) || {}).value || '';
          const name = val('name').trim();
          if (!name) { toast('Name the step', 'bad'); return true; }
          ctx.store.update((st) => {
            const w = st.workflows.find((x) => x.id === wf.id);
            w.steps.push({
              id: `s${Date.now().toString(36)}`,
              name, kind: val('kind'), ref: val('ref') || null,
              detail: val('detail').trim() || 'added in the demo',
              avgMs: Math.max(20, Number(val('avgMs')) || 320),
              enabled: true,
            });
          });
          toast('Step added', 'ok');
          ctx.refresh();
          return false;
        },
      },
    ],
  });
}

/* ---------- node ---------- */
function stepNode(ctx, wf, st, idx) {
  const s = ctx.state;
  const refName = st.kind === 'tool' ? (toolById(s, st.ref) || {}).name
    : st.kind === 'agent' ? (agentById(s, st.ref) || {}).name : null;
  const tool = st.kind === 'tool' ? toolById(s, st.ref) : null;
  const agent = st.kind === 'agent' ? agentById(s, st.ref) : null;
  const warn = (tool && !tool.connected) ? `${tool.name} disconnected`
    : (agent && agent.status !== 'live') ? `${agent.name} is ${agent.status}` : null;

  const move = (dir) => {
    ctx.store.update((state) => {
      const w = state.workflows.find((x) => x.id === wf.id);
      const j = idx + dir;
      if (j < 0 || j >= w.steps.length) return;
      const [it] = w.steps.splice(idx, 1);
      w.steps.splice(j, 0, it);
    });
    ctx.refresh();
  };
  const toggle = () => {
    ctx.store.update((state) => {
      const w = state.workflows.find((x) => x.id === wf.id);
      const t = w.steps.find((x) => x.id === st.id);
      t.enabled = !t.enabled;
    });
    ctx.refresh();
  };
  const remove = async () => {
    const ok = await confirmDialog(`Remove "${st.name}" from ${wf.name}?`, { title: 'Remove step', danger: true, okLabel: 'Remove' });
    if (!ok) return;
    ctx.store.update((state) => {
      const w = state.workflows.find((x) => x.id === wf.id);
      w.steps = w.steps.filter((x) => x.id !== st.id);
    });
    toast('Step removed', 'ok');
    ctx.refresh();
  };

  return h('div', { class: `node${st.enabled ? '' : ' node--off'}` },
    h('span', { class: 'node__idx' }, String(idx + 1)),
    h('div', { class: 'node__main' },
      h('div', { class: 'node__name' }, st.name),
      h('div', { class: 'node__detail' },
        `${KIND_LABEL[st.kind] || st.kind}${refName ? ` · ${refName}` : ''} · ${st.detail} · ~${num(st.avgMs)} ms`),
      warn ? h('span', { class: 'pill pill--warn', style: 'margin-top:6px' }, warn) : null),
    h('div', { class: 'node__acts' },
      h('label', { class: 'switch', title: st.enabled ? 'Disable step' : 'Enable step' },
        h('input', { type: 'checkbox', checked: st.enabled, onchange: toggle, 'aria-label': `${st.enabled ? 'Disable' : 'Enable'} ${st.name}` }),
        h('span', { class: 'switch__track' })),
      h('button', { class: 'btn btn--ghost btn--icon', 'aria-label': `Move ${st.name} up`, onclick: () => move(-1), disabled: idx === 0, html: icon('arrowRight'), style: 'transform:rotate(-90deg)' }),
      h('button', { class: 'btn btn--ghost btn--icon', 'aria-label': `Move ${st.name} down`, onclick: () => move(1), disabled: idx === wf.steps.length - 1, html: icon('arrowRight'), style: 'transform:rotate(90deg)' }),
      h('button', { class: 'btn btn--ghost btn--icon', 'aria-label': `Remove ${st.name}`, onclick: remove, html: icon('x') })));
}

/* ---------- view ---------- */
export function render(ctx) {
  const s = ctx.state;
  const wanted = ctx.params[0] || ctx.query.get('w');
  const wf = workflowById(s, wanted) || s.workflows[0];

  if (!wf) return h('div', { class: 'empty' }, h('h3', {}, 'No workflows'), h('p', {}, 'Reset the demo data to bring the samples back.'));

  const logHost = h('div', { class: 'runlog', hidden: true, 'aria-live': 'polite' });
  const statusPill = h('span', { class: 'pill' }, wf.lastRunAt ? `last run ${ago(wf.lastRunAt)}` : 'not run here yet');

  const toggleWf = () => {
    ctx.store.update((st) => { const w = st.workflows.find((x) => x.id === wf.id); w.enabled = !w.enabled; });
    toast(`${wf.name} ${wf.enabled ? 'disabled' : 'enabled'}`, 'ok');
    ctx.refresh();
  };

  const list = h('div', { class: 'wflist' }, s.workflows.map((w) =>
    h('button', { class: `wflist__item${w.id === wf.id ? ' is-on' : ''}`, onclick: () => ctx.navigate(`workflows/${w.id}`) },
      h('strong', {}, w.name),
      h('span', {}, `${w.steps.filter((x) => x.enabled).length} steps · ${w.enabled ? 'enabled' : 'disabled'}`))));

  const flow = h('div', { class: 'flow' });
  flow.appendChild(h('div', { class: 'node node--trigger' },
    h('span', { class: 'node__idx', html: icon('bolt') }),
    h('div', { class: 'node__main' },
      h('div', { class: 'node__name' }, wf.trigger.label),
      h('div', { class: 'node__detail' }, `${wf.trigger.kind === 'schedule' ? 'Schedule' : 'Event'} trigger · ${wf.trigger.detail}`))));
  wf.steps.forEach((st, i) => {
    flow.appendChild(h('div', { class: 'flowline' }));
    flow.appendChild(stepNode(ctx, wf, st, i));
  });
  flow.appendChild(h('div', { class: 'flowline' }));
  flow.appendChild(h('div', { class: 'node node--output' },
    h('span', { class: 'node__idx', html: icon('download') }),
    h('div', { class: 'node__main' },
      h('div', { class: 'node__name' }, 'Outputs'),
      h('div', { class: 'node__detail' }, wf.outputs.join(' · ')))));

  return h('div', {},
    h('div', { class: 'page-head' },
      h('div', { style: 'flex:1;min-width:240px' },
        h('h1', {}, 'Workflows'),
        h('p', {}, 'A workflow is a trigger, an ordered list of steps and the outputs it writes. Disable a step or disconnect a tool and the next run reflects it immediately.'))),

    h('div', { class: 'wf' },
      list,
      h('div', { class: 'stack' },
        h('div', { class: 'card' },
          h('div', { class: 'between', style: 'margin-bottom:10px' },
            h('div', { style: 'min-width:0' },
              h('h2', {}, wf.name),
              h('p', { class: 'muted small' }, wf.description)),
            statusPill),
          h('div', { class: 'btnrow' },
            h('button', {
              class: 'btn btn--primary',
              onclick: () => runWorkflow(ctx, wf, logHost, statusPill),
              html: `${icon('bolt')}<span>Run workflow</span>`,
            }),
            h('button', { class: 'btn', onclick: () => addStepForm(ctx, wf), html: `${icon('plus')}<span>Add step</span>` }),
            h('button', { class: 'btn', onclick: toggleWf }, wf.enabled ? 'Disable workflow' : 'Enable workflow'),
            h('button', { class: 'btn', onclick: () => ctx.navigate(`runs?workflow=${wf.id}`) }, 'Runs from this workflow'),
            h('span', { class: `pill ${wf.enabled ? 'pill--ok' : 'pill--warn'}` }, wf.enabled ? 'enabled' : 'disabled')),
          h('div', { style: 'margin-top:14px' }, logHost)),
        h('div', { class: 'card' },
          h('div', { class: 'card__head' }, h('h3', {}, 'Pipeline'), h('span', { class: 'label' }, `${wf.steps.length} steps`)),
          flow))));
}
