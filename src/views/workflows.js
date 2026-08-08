/* Workflows — trigger, steps, outputs. Steps can be added, removed,
   reordered and disabled, and "Run" streams a live step-by-step log
   that writes a real run into the Runs screen. */

import { h, icon, num, ago, toast, modal, confirmDialog } from '../../lib/ui.js';
import { workflowById, toolById, agentById, rupees } from '../data.js';
import { executeWorkflow, consumeWorkflowRun } from '../runner.js';

const KIND_LABEL = { tool: 'Tool call', agent: 'Agent', condition: 'Condition', output: 'Output' };
const KIND_ICON = { tool: 'grid', agent: 'spark', condition: 'filter', output: 'download' };

/* ---------- the run log ----------
   The engine lives in src/runner.js so that the button here and an agent
   told to "run the invoice workflow" execute exactly the same thing.
   `starter` is passed when the agent asked for the run: it is the
   engine already bound to that request, so the agent's promise resolves
   with the same result the log shows. */
function runWorkflow(ctx, wf, logHost, headerHost, starter) {
  logHost.innerHTML = '';
  logHost.hidden = false;
  headerHost.textContent = 'running';
  headerHost.className = 'pill pill--amber';

  const line = (t, msg, status) => h('div', { class: 'runlog__line' },
    h('span', { class: 'runlog__t' }, t),
    h('span', { class: 'runlog__msg' }, msg),
    h('span', { class: `runlog__st runlog__st--${status}` }, status));

  const onLine = (t, msg, status) => {
    logHost.appendChild(line(t, msg, status));
    logHost.scrollTop = logHost.scrollHeight;
  };

  const started = starter ? starter({ onLine }) : executeWorkflow(ctx.store, wf, { onLine });

  return started.then((r) => {
    headerHost.textContent = r.status;
    headerHost.className = `pill ${r.status === 'success' ? 'pill--ok' : r.status === 'failed' ? 'pill--bad' : 'pill--info'}`;
    onLine('', `${num(r.tokensIn + r.tokensOut)} tokens · ${rupees(r.costPaise)} at the demo rate`, r.status === 'success' ? 'ok' : r.status);
    toast(`Run ${r.status} — open it in Runs`, r.status === 'success' ? 'ok' : 'bad');
    logHost.appendChild(h('div', { class: 'runlog__line' },
      h('span', { class: 'runlog__t' }, ''),
      h('span', { class: 'runlog__msg' },
        h('button', { class: 'btn btn--sm', onclick: () => ctx.navigate(`runs/${r.runId}`) }, 'Open the trace')),
      h('span', { class: 'runlog__st' }, '')));
    return r;
  });
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

  /* An agent may have asked for this workflow to be run. The request is
     picked up once the node is in the tree, so the log streams here
     instead of the run happening out of sight. */
  queueMicrotask(() => {
    const starter = consumeWorkflowRun(wf.id);
    if (starter) runWorkflow(ctx, wf, logHost, statusPill, starter);
  });

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
