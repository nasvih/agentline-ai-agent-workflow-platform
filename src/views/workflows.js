/* Workflows — trigger, steps, outputs. Steps can be added, removed,
   reordered and disabled, and "Run" streams a live step-by-step log
   that writes a real run into the Runs screen. */

import { h, esc, icon, num, ago, toast, modal, confirmDialog } from '../../lib/ui.js';
import {
  workflowById, toolById, agentById, rupees,
  workflowName, workflowDesc, triggerLabel, triggerDetail, outputLabel,
  stepName, stepDetail, toolName, agentName, agentStatusLabel, statusLabel,
} from '../data.js';
import { executeWorkflow, consumeWorkflowRun } from '../runner.js';
import { t } from '../main.js';

/* A function, not a constant: the labels have to be read after the language
   is resolved, not once at module load. The keys stay `tool`/`agent`/… — they
   are what gets stored on the step; only the painted label changes. */
const KIND_LABEL = () => ({
  tool: t('workflowsView.kind.tool'),
  agent: t('workflowsView.kind.agent'),
  condition: t('workflowsView.kind.condition'),
  output: t('workflowsView.kind.output'),
});
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
  headerHost.textContent = t('playgroundView.running');
  headerHost.className = 'pill pill--amber';

  /* the first parameter is the elapsed-time stamp, not the translator —
     naming it `t` would shadow the import and throw `t is not a function` */
  const line = (ts, msg, status) => h('div', { class: 'runlog__line' },
    h('span', { class: 'runlog__t' }, ts),
    h('span', { class: 'runlog__msg' }, msg),
    h('span', { class: `runlog__st runlog__st--${status}` }, status));

  const onLine = (ts, msg, status) => {
    logHost.appendChild(line(ts, msg, status));
    logHost.scrollTop = logHost.scrollHeight;
  };

  const started = starter ? starter({ onLine }) : executeWorkflow(ctx.store, wf, { onLine });

  return started.then((r) => {
    headerHost.textContent = statusLabel(r.status);
    headerHost.className = `pill ${r.status === 'success' ? 'pill--ok' : r.status === 'failed' ? 'pill--bad' : 'pill--info'}`;
    onLine('', t('workflowsView.logTokens', { tokens: num(r.tokensIn + r.tokensOut), cost: rupees(r.costPaise) }), r.status === 'success' ? 'ok' : r.status);
    toast(t('workflowsView.runToast', { status: statusLabel(r.status) }), r.status === 'success' ? 'ok' : 'bad');
    logHost.appendChild(h('div', { class: 'runlog__line' },
      h('span', { class: 'runlog__t' }, ''),
      h('span', { class: 'runlog__msg' },
        h('button', { class: 'btn btn--sm', onclick: () => ctx.navigate(`runs/${r.runId}`) }, t('common.openTrace'))),
      h('span', { class: 'runlog__st' }, '')));
    return r;
  });
}

/* ---------- add step ---------- */
function addStepForm(ctx, wf) {
  const s = ctx.state;
  const refWrap = h('div', { class: 'field' });
  const kindSel = h('select', { class: 'select', name: 'kind' },
    Object.entries(KIND_LABEL()).map(([k, v]) => h('option', { value: k }, v)));

  const paintRef = () => {
    const kind = kindSel.value;
    refWrap.innerHTML = '';
    refWrap.appendChild(h('span', { class: 'field__label' }, kind === 'tool' ? t('workflowsView.fTool') : kind === 'agent' ? t('workflowsView.fAgent') : t('workflowsView.fRef')));
    if (kind === 'tool') {
      refWrap.appendChild(h('select', { class: 'select', name: 'ref' }, s.tools.map((x) => h('option', { value: x.id }, toolName(x)))));
    } else if (kind === 'agent') {
      refWrap.appendChild(h('select', { class: 'select', name: 'ref' }, s.agents.map((a) => h('option', { value: a.id }, agentName(a)))));
    } else {
      refWrap.appendChild(h('input', { class: 'input', name: 'ref', placeholder: t('workflowsView.phOptional'), value: '' }));
    }
  };
  kindSel.addEventListener('change', paintRef);

  const body = h('div', {},
    h('label', { class: 'field' }, h('span', { class: 'field__label' }, t('workflowsView.stepName')),
      h('input', { class: 'input', name: 'name', placeholder: t('workflowsView.phStepName') })),
    h('label', { class: 'field' }, h('span', { class: 'field__label' }, t('workflowsView.fKind')), kindSel),
    refWrap,
    h('label', { class: 'field' }, h('span', { class: 'field__label' }, t('workflowsView.fDetail')),
      h('input', { class: 'input', name: 'detail', placeholder: t('workflowsView.phDetail') })),
    h('label', { class: 'field' }, h('span', { class: 'field__label' }, t('workflowsView.fDuration')),
      h('input', { class: 'input', name: 'avgMs', type: 'number', min: '20', max: '9000', value: '320' })));
  paintRef();

  modal({
    title: t('workflowsView.addTitle', { name: workflowName(wf) }),
    body,
    actions: [
      { label: t('common.cancel') },
      {
        label: t('workflowsView.addStepBtn'),
        class: 'btn--primary',
        onClick: (bodyEl) => {
          const val = (n) => (bodyEl.querySelector(`[name="${n}"]`) || {}).value || '';
          const name = val('name').trim();
          if (!name) { toast(t('workflowsView.nameTheStep'), 'bad'); return true; }
          ctx.store.update((st) => {
            const w = st.workflows.find((x) => x.id === wf.id);
            w.steps.push({
              id: `s${Date.now().toString(36)}`,
              name, kind: val('kind'), ref: val('ref') || null,
              detail: val('detail').trim() || t('workflowsView.addedInDemo'),
              avgMs: Math.max(20, Number(val('avgMs')) || 320),
              enabled: true,
            });
          });
          toast(t('workflowsView.stepAdded'), 'ok');
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
  const refName = st.kind === 'tool' ? toolName(toolById(s, st.ref))
    : st.kind === 'agent' ? agentName(agentById(s, st.ref)) : null;
  const tool = st.kind === 'tool' ? toolById(s, st.ref) : null;
  const agent = st.kind === 'agent' ? agentById(s, st.ref) : null;
  const warn = (tool && !tool.connected) ? t('workflowsView.warnDisconnected', { name: toolName(tool) })
    : (agent && agent.status !== 'live') ? t('workflowsView.warnAgent', { name: agentName(agent), status: agentStatusLabel(agent.status) }) : null;

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
      const step = w.steps.find((x) => x.id === st.id);
      step.enabled = !step.enabled;
    });
    ctx.refresh();
  };
  const remove = async () => {
    const ok = await confirmDialog(t('workflowsView.removeBody', { step: stepName(st.name), wf: workflowName(wf) }), { title: t('workflowsView.removeTitle'), danger: true, okLabel: t('common.remove') });
    if (!ok) return;
    ctx.store.update((state) => {
      const w = state.workflows.find((x) => x.id === wf.id);
      w.steps = w.steps.filter((x) => x.id !== st.id);
    });
    toast(t('workflowsView.removed'), 'ok');
    ctx.refresh();
  };

  return h('div', { class: `node${st.enabled ? '' : ' node--off'}` },
    h('span', { class: 'node__idx' }, String(idx + 1)),
    h('div', { class: 'node__main' },
      h('div', { class: 'node__name' }, stepName(st.name)),
      h('div', { class: 'node__detail' },
        t('workflowsView.nodeDetail', {
          kind: KIND_LABEL()[st.kind] || st.kind,
          ref: refName ? ` · ${refName}` : '',
          detail: stepDetail(st.detail),
          ms: num(st.avgMs),
        })),
      warn ? h('span', { class: 'pill pill--warn', style: 'margin-top:6px' }, warn) : null),
    h('div', { class: 'node__acts' },
      h('label', { class: 'switch', title: st.enabled ? t('workflowsView.disableStep') : t('workflowsView.enableStep') },
        h('input', { type: 'checkbox', checked: st.enabled, onchange: toggle, 'aria-label': st.enabled ? t('workflowsView.disableNamed', { name: stepName(st.name) }) : t('workflowsView.enableNamed', { name: stepName(st.name) }) }),
        h('span', { class: 'switch__track' })),
      h('button', { class: 'btn btn--ghost btn--icon', 'aria-label': t('workflowsView.moveUp', { name: stepName(st.name) }), onclick: () => move(-1), disabled: idx === 0, html: icon('arrowRight'), style: 'transform:rotate(-90deg)' }),
      h('button', { class: 'btn btn--ghost btn--icon', 'aria-label': t('workflowsView.moveDown', { name: stepName(st.name) }), onclick: () => move(1), disabled: idx === wf.steps.length - 1, html: icon('arrowRight'), style: 'transform:rotate(90deg)' }),
      h('button', { class: 'btn btn--ghost btn--icon', 'aria-label': t('workflowsView.removeNamed', { name: stepName(st.name) }), onclick: remove, html: icon('x') })));
}

/* ---------- view ---------- */
export function render(ctx) {
  const s = ctx.state;
  const wanted = ctx.params[0] || ctx.query.get('w');
  const wf = workflowById(s, wanted) || s.workflows[0];

  if (!wf) return h('div', { class: 'empty' }, h('h3', {}, t('workflowsView.none')), h('p', {}, t('workflowsView.noneBody')));

  const logHost = h('div', { class: 'runlog', hidden: true, 'aria-live': 'polite' });
  const statusPill = h('span', { class: 'pill' }, wf.lastRunAt ? t('workflowsView.lastRun', { when: ago(wf.lastRunAt) }) : t('workflowsView.notRunYet'));

  const toggleWf = () => {
    /* read the state before the update: `wf` points into the store, so it
       has already flipped by the time the toast is composed */
    const wasEnabled = wf.enabled;
    ctx.store.update((st) => { const w = st.workflows.find((x) => x.id === wf.id); w.enabled = !w.enabled; });
    toast(t('workflowsView.toggled', { name: workflowName(wf), state: wasEnabled ? t('common.disabled') : t('common.enabled') }), 'ok');
    ctx.refresh();
  };

  const list = h('div', { class: 'wflist' }, s.workflows.map((w) =>
    h('button', { class: `wflist__item${w.id === wf.id ? ' is-on' : ''}`, onclick: () => ctx.navigate(`workflows/${w.id}`) },
      h('strong', {}, workflowName(w)),
      h('span', {}, t('workflowsView.listSub', { n: w.steps.filter((x) => x.enabled).length, state: w.enabled ? t('common.enabled') : t('common.disabled') })))));

  const flow = h('div', { class: 'flow' });
  flow.appendChild(h('div', { class: 'node node--trigger' },
    h('span', { class: 'node__idx', html: icon('bolt') }),
    h('div', { class: 'node__main' },
      h('div', { class: 'node__name' }, triggerLabel(wf)),
      h('div', { class: 'node__detail' }, t('workflowsView.triggerLine', {
        kind: wf.trigger.kind === 'schedule' ? t('workflowsView.scheduleTrigger') : t('workflowsView.eventTrigger'),
        detail: triggerDetail(wf),
      })))));
  wf.steps.forEach((st, i) => {
    flow.appendChild(h('div', { class: 'flowline' }));
    flow.appendChild(stepNode(ctx, wf, st, i));
  });
  flow.appendChild(h('div', { class: 'flowline' }));
  flow.appendChild(h('div', { class: 'node node--output' },
    h('span', { class: 'node__idx', html: icon('download') }),
    h('div', { class: 'node__main' },
      h('div', { class: 'node__name' }, t('workflowsView.outputs')),
      h('div', { class: 'node__detail' }, wf.outputs.map((o) => outputLabel(o)).join(' · ')))));

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
        h('h1', {}, t('workflowsView.title')),
        h('p', {}, t('workflowsView.lede')))),

    h('div', { class: 'wf' },
      list,
      h('div', { class: 'stack' },
        h('div', { class: 'card' },
          h('div', { class: 'between', style: 'margin-bottom:10px' },
            h('div', { style: 'min-width:0' },
              h('h2', {}, workflowName(wf)),
              h('p', { class: 'muted small' }, workflowDesc(wf))),
            statusPill),
          h('div', { class: 'btnrow' },
            h('button', {
              class: 'btn btn--primary',
              onclick: () => runWorkflow(ctx, wf, logHost, statusPill),
              html: `${icon('bolt')}<span>${esc(t('workflowsView.runWorkflow'))}</span>`,
            }),
            h('button', { class: 'btn', onclick: () => addStepForm(ctx, wf), html: `${icon('plus')}<span>${esc(t('workflowsView.addStep'))}</span>` }),
            h('button', { class: 'btn', onclick: toggleWf }, wf.enabled ? t('workflowsView.disableWf') : t('workflowsView.enableWf')),
            h('button', { class: 'btn', onclick: () => ctx.navigate(`runs?workflow=${wf.id}`) }, t('workflowsView.runsFrom')),
            h('span', { class: `pill ${wf.enabled ? 'pill--ok' : 'pill--warn'}` }, wf.enabled ? t('common.enabled') : t('common.disabled'))),
          h('div', { style: 'margin-top:14px' }, logHost)),
        h('div', { class: 'card' },
          h('div', { class: 'card__head' }, h('h3', {}, t('workflowsView.pipeline')), h('span', { class: 'label' }, t('workflowsView.stepsCount', { n: wf.steps.length }))),
          flow))));
}
