/* Guardrails — the four rules, their configuration, and a live
   redaction preview. Toggling any of these changes what the agents
   say in the Playground on the very next question. */

import { h, esc, icon, ago, toast } from '../../lib/ui.js';
import {
  agentById, guardById, rupees,
  guardName, guardSummary, guardDetail, guardQueue,
  termLabel, maskLabel, agentName, verdictLabel,
} from '../data.js';
import { redactText } from '../agent.js';
import { t } from '../main.js';

/* read at call time, not at import time — `t` is defined in main.js after
   the views are imported, so a module-level t() would hit the dead zone */
const SAMPLE = () => t('guardrailsView.sample');

function chipList(items, onRemove) {
  /* the chip carries the record's own English word; only the painted text
     and the label are translated, so what is removed stays the stored value */
  return h('div', { class: 'chiprow' }, items.map((word) =>
    h('span', { class: 'topicchip' }, termLabel(word),
      h('button', { type: 'button', 'aria-label': t('guardrailsView.removeChip', { name: termLabel(word) }), onclick: () => onRemove(word), html: icon('x') }))));
}

function adder(placeholder, onAdd) {
  const input = h('input', { class: 'input', placeholder, style: 'max-width:220px' });
  const submit = () => {
    const v = input.value.trim().toLowerCase();
    if (!v) return;
    input.value = '';
    onAdd(v);
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  return h('div', { class: 'row', style: 'margin-top:10px' }, input,
    h('button', { class: 'btn btn--sm', onclick: submit, html: `${icon('plus')}<span>${esc(t('common.add'))}</span>` }));
}

function config(ctx, g) {
  const patch = (fn) => {
    ctx.store.update((st) => { fn(st.guardrails.find((x) => x.id === g.id)); });
    ctx.refresh();
  };

  if (g.kind === 'redact') {
    const out = h('div', { class: 'tryout__out' });
    const input = h('input', { class: 'input', value: SAMPLE() });
    const paint = () => {
      const r = g.enabled ? redactText(input.value) : { out: input.value, n: 0 };
      out.textContent = r.out;
      note.textContent = g.enabled
        ? t('guardrailsView.maskedN', { n: r.n })
        : t('guardrailsView.ruleOff');
    };
    const note = h('div', { class: 'hint' });
    input.addEventListener('input', paint);
    const box = h('div', { class: 'tryout' },
      h('div', { class: 'label', style: 'margin-bottom:8px' }, t('guardrailsView.tryIt')),
      input, out, note);
    paint();
    return h('div', {},
      h('div', { class: 'chiprow' }, g.masks.map((m) => h('span', { class: 'tagm tagm--on' }, maskLabel(m)))),
      box);
  }

  if (g.kind === 'topics') {
    return h('div', {},
      h('div', { class: 'label', style: 'margin-bottom:8px' }, t('guardrailsView.allowedTopics')),
      chipList(g.topics, (word) => { patch((x) => { x.topics = x.topics.filter((y) => y !== word); }); toast(t('guardrailsView.topicRemoved'), 'ok'); }),
      adder(t('guardrailsView.addTopic'), (v) => { patch((x) => { if (!x.topics.includes(v)) x.topics.push(v); }); toast(t('guardrailsView.topicAdded'), 'ok'); }),
      h('div', { class: 'label', style: 'margin:14px 0 8px' }, t('guardrailsView.blockedTerms')),
      chipList(g.blocked, (word) => { patch((x) => { x.blocked = x.blocked.filter((y) => y !== word); }); toast(t('guardrailsView.termRemoved'), 'ok'); }),
      adder(t('guardrailsView.addBlocked'), (v) => { patch((x) => { if (!x.blocked.includes(v)) x.blocked.push(v); }); toast(t('guardrailsView.termAdded'), 'ok'); }),
      h('p', { class: 'hint' }, t('guardrailsView.topicsHint')));
  }

  if (g.kind === 'escalate') {
    return h('div', {},
      h('label', { class: 'field' }, h('span', { class: 'field__label' }, t('guardrailsView.queue')),
        h('input', {
          class: 'input', value: guardQueue(g),
          onchange: (e) => { patch((x) => { x.queue = e.target.value.trim() || x.queue; }); toast(t('guardrailsView.queueUpdated'), 'ok'); },
        })),
      h('div', { class: 'label', style: 'margin:14px 0 8px' }, t('guardrailsView.triggerWords')),
      chipList(g.triggers, (word) => { patch((x) => { x.triggers = x.triggers.filter((y) => y !== word); }); toast(t('guardrailsView.triggerRemoved'), 'ok'); }),
      adder(t('guardrailsView.addTrigger'), (v) => { patch((x) => { if (!x.triggers.includes(v)) x.triggers.push(v); }); toast(t('guardrailsView.triggerAdded'), 'ok'); }),
      h('p', { class: 'hint' }, t('guardrailsView.escHint')));
  }

  /* cost */
  return h('div', {},
    h('label', { class: 'field' }, h('span', { class: 'field__label' }, t('guardrailsView.ceiling')),
      h('input', {
        class: 'input', type: 'number', min: '0.05', max: '50', step: '0.05',
        value: (g.limitPaise / 100).toFixed(2), style: 'max-width:160px',
        onchange: (e) => {
          const v = Math.max(5, Math.round(Number(e.target.value) * 100) || 200);
          patch((x) => { x.limitPaise = v; });
          toast(t('guardrailsView.ceilingSet', { amount: rupees(v) }), 'ok');
        },
      })),
    h('p', { class: 'hint' }, t('guardrailsView.costHint', { amount: rupees(g.limitPaise) })));
}

function card(ctx, g) {
  const s = ctx.state;
  const users = s.agents.filter((a) => a.guardrails.includes(g.id));
  const toggle = () => {
    ctx.store.update((st) => { const x = st.guardrails.find((y) => y.id === g.id); x.enabled = !x.enabled; });
    toast(t('guardrailsView.toggled', { name: guardName(g), state: g.enabled ? t('common.disabled') : t('common.enabled') }), g.enabled ? 'bad' : 'ok');
    ctx.refresh();
  };

  return h('section', { class: `grcard${g.enabled ? '' : ' is-off'}` },
    h('div', { class: 'grcard__top' },
      h('span', { html: icon('shield') }),
      h('div', { style: 'flex:1;min-width:0' },
        h('h3', {}, guardName(g)),
        h('div', { class: 'label' }, t('guardrailsView.agentsShort', { n: users.length }))),
      h('label', { class: 'switch' },
        h('input', { type: 'checkbox', checked: g.enabled, onchange: toggle, 'aria-label': g.enabled ? t('guardrailsView.toggleAria', { name: guardName(g) }) : t('guardrailsView.toggleAriaOn', { name: guardName(g) }) }),
        h('span', { class: 'switch__track' }))),
    h('p', {}, guardSummary(g)),
    h('p', { class: 'hint' }, guardDetail(g)),
    h('div', { class: 'chiprow', style: 'margin-top:10px' }, users.map((a) => h('span', { class: 'tagm' }, agentName(a)))),
    h('div', { class: 'grcard__cfg' }, config(ctx, g)));
}

export function render(ctx) {
  const s = ctx.state;
  const events = s.runs
    .flatMap((r) => (r.guardrails || []).map((g) => ({ ...g, run: r })))
    .filter((g) => g.verdict !== 'passed')
    .slice(0, 10);

  return h('div', {},
    h('div', { class: 'page-head' },
      h('div', { style: 'flex:1;min-width:240px' },
        h('h1', {}, t('guardrailsView.title')),
        h('p', {}, t('guardrailsView.lede'))),
      h('div', { class: 'btnrow' },
        h('button', { class: 'btn btn--sm btn--primary', onclick: () => ctx.navigate('playground'), html: `${icon('bolt')}<span>${esc(t('guardrailsView.tryInPlayground'))}</span>` }))),

    h('div', { class: 'grid g4', style: 'margin-bottom:20px' }, s.guardrails.map((g) =>
      h('div', { class: `stat${g.enabled ? ' stat--accent' : ''}` },
        h('div', { class: 'stat__label' }, guardName(g)),
        h('div', { class: 'stat__value' }, g.enabled ? t('common.on') : t('common.off')),
        h('div', { class: 'stat__delta' }, t('guardrailsView.agentsBound', { n: s.agents.filter((a) => a.guardrails.includes(g.id)).length }))))),

    h('div', { class: 'grid g2' }, s.guardrails.map((g) => card(ctx, g))),

    h('div', { class: 'card', style: 'margin-top:20px' },
      h('div', { class: 'card__head' }, h('h3', {}, t('guardrailsView.recent')), h('span', { class: 'label' }, t('guardrailsView.shown', { n: events.length }))),
      events.length
        ? h('div', { class: 'tablewrap tablewrap--scroll' },
          h('table', { class: 'data' },
            h('thead', {}, h('tr', {}, h('th', {}, t('guardrailsView.thRun')), h('th', {}, t('guardrailsView.thAgent')), h('th', {}, t('guardrailsView.thGuardrail')), h('th', {}, t('guardrailsView.thVerdict')), h('th', {}, t('guardrailsView.thWhen')))),
            h('tbody', {}, events.map((e) => h('tr', {},
              h('td', {}, h('span', { class: 'runid linkish', onclick: () => ctx.navigate(`runs/${e.run.id}`) }, e.run.id)),
              h('td', {}, agentName(agentById(s, e.run.agentId)) || e.run.agentId),
              h('td', {}, guardName(guardById(s, e.id)) || e.id),
              h('td', {}, h('span', { class: `pill ${{ blocked: 'pill--bad', escalated: 'pill--warn', redacted: 'pill--info', off: '' }[e.verdict] || ''}` }, verdictLabel(e.verdict))),
              h('td', { class: 'small muted' }, ago(e.run.startedAt)))))))
        : h('p', { class: 'muted small' }, t('guardrailsView.noEvents'))),

    h('p', { class: 'small faint', style: 'margin-top:12px' },
      t('guardrailsView.foot', { n: s.runs.length })));
}
