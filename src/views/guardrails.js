/* Guardrails — the four rules, their configuration, and a live
   redaction preview. Toggling any of these changes what the agents
   say in the Playground on the very next question. */

import { h, icon, num, ago, toast } from '../../lib/ui.js';
import { agentById, guardById, rupees } from '../data.js';
import { redactText } from '../agent.js';

const SAMPLE = 'Meera Raghavan at meera@keralacoast.example, +91 903214567, account 4417290355, is asking about invoice INV-8821.';

function chipList(items, onRemove) {
  return h('div', { class: 'chiprow' }, items.map((t) =>
    h('span', { class: 'topicchip' }, t,
      h('button', { type: 'button', 'aria-label': `Remove ${t}`, onclick: () => onRemove(t), html: icon('x') }))));
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
    h('button', { class: 'btn btn--sm', onclick: submit, html: `${icon('plus')}<span>Add</span>` }));
}

function config(ctx, g) {
  const patch = (fn) => {
    ctx.store.update((st) => { fn(st.guardrails.find((x) => x.id === g.id)); });
    ctx.refresh();
  };

  if (g.kind === 'redact') {
    const out = h('div', { class: 'tryout__out' });
    const input = h('input', { class: 'input', value: SAMPLE });
    const paint = () => {
      const r = g.enabled ? redactText(input.value) : { out: input.value, n: 0 };
      out.textContent = r.out;
      note.textContent = g.enabled
        ? `${r.n} value${r.n === 1 ? '' : 's'} masked with the rule on.`
        : 'Rule is off — the agent would send this through untouched.';
    };
    const note = h('div', { class: 'hint' });
    input.addEventListener('input', paint);
    const box = h('div', { class: 'tryout' },
      h('div', { class: 'label', style: 'margin-bottom:8px' }, 'Try it'),
      input, out, note);
    paint();
    return h('div', {},
      h('div', { class: 'chiprow' }, g.masks.map((m) => h('span', { class: 'tagm tagm--on' }, m))),
      box);
  }

  if (g.kind === 'topics') {
    return h('div', {},
      h('div', { class: 'label', style: 'margin-bottom:8px' }, 'Allowed topics'),
      chipList(g.topics, (t) => { patch((x) => { x.topics = x.topics.filter((y) => y !== t); }); toast('Topic removed', 'ok'); }),
      adder('add a topic', (v) => { patch((x) => { if (!x.topics.includes(v)) x.topics.push(v); }); toast('Topic added', 'ok'); }),
      h('div', { class: 'label', style: 'margin:14px 0 8px' }, 'Blocked terms'),
      chipList(g.blocked, (t) => { patch((x) => { x.blocked = x.blocked.filter((y) => y !== t); }); toast('Term removed', 'ok'); }),
      adder('add a blocked term', (v) => { patch((x) => { if (!x.blocked.includes(v)) x.blocked.push(v); }); toast('Term added', 'ok'); }),
      h('p', { class: 'hint' }, 'A question containing a blocked term is refused before the agent reads a single record. Try "what are the salary bands here?" in the Playground.'));
  }

  if (g.kind === 'escalate') {
    return h('div', {},
      h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Handover queue'),
        h('input', {
          class: 'input', value: g.queue,
          onchange: (e) => { patch((x) => { x.queue = e.target.value.trim() || x.queue; }); toast('Queue updated', 'ok'); },
        })),
      h('div', { class: 'label', style: 'margin:14px 0 8px' }, 'Trigger words'),
      chipList(g.triggers, (t) => { patch((x) => { x.triggers = x.triggers.filter((y) => y !== t); }); toast('Trigger removed', 'ok'); }),
      adder('add a trigger word', (v) => { patch((x) => { if (!x.triggers.includes(v)) x.triggers.push(v); }); toast('Trigger added', 'ok'); }),
      h('p', { class: 'hint' }, 'With the rule on, the agent stops and raises a reference instead of answering. With it off, it answers and says so.'));
  }

  /* cost */
  return h('div', {},
    h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Ceiling per run (₹)'),
      h('input', {
        class: 'input', type: 'number', min: '0.05', max: '50', step: '0.05',
        value: (g.limitPaise / 100).toFixed(2), style: 'max-width:160px',
        onchange: (e) => {
          const v = Math.max(5, Math.round(Number(e.target.value) * 100) || 200);
          patch((x) => { x.limitPaise = v; });
          toast(`Ceiling set to ${rupees(v)}`, 'ok');
        },
      })),
    h('p', { class: 'hint' }, `Currently ${rupees(g.limitPaise)}. A typical playground turn lands between ₹0.15 and ₹0.45 — set the ceiling to ₹0.20 and watch answers get cut off mid-way with the reason attached.`));
}

function card(ctx, g) {
  const s = ctx.state;
  const users = s.agents.filter((a) => a.guardrails.includes(g.id));
  const toggle = () => {
    ctx.store.update((st) => { const x = st.guardrails.find((y) => y.id === g.id); x.enabled = !x.enabled; });
    toast(`${g.name} ${g.enabled ? 'disabled' : 'enabled'}`, g.enabled ? 'bad' : 'ok');
    ctx.refresh();
  };

  return h('section', { class: `grcard${g.enabled ? '' : ' is-off'}` },
    h('div', { class: 'grcard__top' },
      h('span', { html: icon('shield') }),
      h('div', { style: 'flex:1;min-width:0' },
        h('h3', {}, g.name),
        h('div', { class: 'label' }, `${users.length} agent${users.length === 1 ? '' : 's'}`)),
      h('label', { class: 'switch' },
        h('input', { type: 'checkbox', checked: g.enabled, onchange: toggle, 'aria-label': `${g.enabled ? 'Disable' : 'Enable'} ${g.name}` }),
        h('span', { class: 'switch__track' }))),
    h('p', {}, g.summary),
    h('p', { class: 'hint' }, g.detail),
    h('div', { class: 'chiprow', style: 'margin-top:10px' }, users.map((a) => h('span', { class: 'tagm' }, a.name))),
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
        h('h1', {}, 'Guardrails'),
        h('p', {}, 'Rules the agents cannot argue with. They run in order — topic check, escalation check, tool gate, then redaction and the cost ceiling on the way out. Every toggle here changes the next reply in the Playground.')),
      h('div', { class: 'btnrow' },
        h('button', { class: 'btn btn--sm btn--primary', onclick: () => ctx.navigate('playground'), html: `${icon('bolt')}<span>Try in Playground</span>` }))),

    h('div', { class: 'grid g4', style: 'margin-bottom:20px' }, s.guardrails.map((g) =>
      h('div', { class: `stat${g.enabled ? ' stat--accent' : ''}` },
        h('div', { class: 'stat__label' }, g.name),
        h('div', { class: 'stat__value' }, g.enabled ? 'on' : 'off'),
        h('div', { class: 'stat__delta' }, `${s.agents.filter((a) => a.guardrails.includes(g.id)).length} agents bound`)))),

    h('div', { class: 'grid g2' }, s.guardrails.map((g) => card(ctx, g))),

    h('div', { class: 'card', style: 'margin-top:20px' },
      h('div', { class: 'card__head' }, h('h3', {}, 'Recent guardrail events'), h('span', { class: 'label' }, `${events.length} shown`)),
      events.length
        ? h('div', { class: 'tablewrap tablewrap--scroll' },
          h('table', { class: 'data' },
            h('thead', {}, h('tr', {}, h('th', {}, 'Run'), h('th', {}, 'Agent'), h('th', {}, 'Guardrail'), h('th', {}, 'Verdict'), h('th', {}, 'When'))),
            h('tbody', {}, events.map((e) => h('tr', {},
              h('td', {}, h('span', { class: 'runid linkish', onclick: () => ctx.navigate(`runs/${e.run.id}`) }, e.run.id)),
              h('td', {}, (agentById(s, e.run.agentId) || {}).name || e.run.agentId),
              h('td', {}, (guardById(s, e.id) || {}).name || e.id),
              h('td', {}, h('span', { class: `pill ${{ blocked: 'pill--bad', escalated: 'pill--warn', redacted: 'pill--info', off: '' }[e.verdict] || ''}` }, e.verdict)),
              h('td', { class: 'small muted' }, ago(e.run.startedAt)))))))
        : h('p', { class: 'muted small' }, 'Nothing has been blocked, escalated or redacted in the runs held here. Ask an agent something that trips a rule and it shows up in this table.')),

    h('p', { class: 'small faint', style: 'margin-top:12px' },
      `${num(s.runs.length)} runs held · guardrail verdicts are recorded on every one of them.`));
}
