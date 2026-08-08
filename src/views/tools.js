/* Tools & connections — the switches that gate what agents can do. */

import { h, icon, num, fmtDate, toast, confirmDialog } from '../../lib/ui.js';

function toolCard(ctx, tool) {
  const s = ctx.state;
  const users = s.agents.filter((a) => a.tools.includes(tool.id));
  const steps = s.workflows.flatMap((w) => w.steps.filter((st) => st.kind === 'tool' && st.ref === tool.id).map((st) => ({ w, st })));

  const setConnected = (on) => {
    ctx.store.update((st) => {
      const t = st.tools.find((x) => x.id === tool.id);
      t.connected = on;
      if (on) t.connectedAt = new Date().toISOString();
    });
    toast(`${tool.name} ${on ? 'connected' : 'disconnected'}`, on ? 'ok' : 'bad');
    ctx.refresh();
  };

  const onToggle = async (e) => {
    const wants = e.target.checked;
    if (!wants && users.length) {
      e.target.checked = true;
      const ok = await confirmDialog(
        `${users.length} agent${users.length === 1 ? '' : 's'} depend on ${tool.name}: ${users.map((a) => a.name).join(', ')}. Any question that needs it will be refused until you reconnect, and ${steps.length} workflow step${steps.length === 1 ? '' : 's'} will fail.`,
        { title: `Disconnect ${tool.name}?`, danger: true, okLabel: 'Disconnect' },
      );
      if (!ok) return;
    }
    setConnected(wants);
  };

  return h('article', { class: `toolcard${tool.connected ? ' is-on' : ''}` },
    h('div', { class: 'toolcard__top' },
      h('span', { class: 'toolcard__icon', html: icon(tool.icon) }),
      h('div', { style: 'flex:1;min-width:0' },
        h('h3', {}, tool.name),
        h('div', { class: 'label' }, tool.kind)),
      h('span', { class: `pill ${tool.connected ? 'pill--ok' : 'pill--bad'}` }, tool.connected ? 'connected' : 'off')),
    h('p', {}, tool.description),
    h('div', { class: 'toolcard__ops' }, tool.ops.map((op) => h('span', { class: 'tagm' }, op))),
    h('dl', { class: 'kv' },
      h('dt', {}, 'Account'), h('dd', {}, tool.account),
      h('dt', {}, 'Calls 30d'), h('dd', {}, num(tool.calls30d)),
      h('dt', {}, 'Latency'), h('dd', {}, `${num(tool.latencyMs)} ms typical`),
      h('dt', {}, 'Since'), h('dd', {}, fmtDate(tool.connectedAt)),
      h('dt', {}, 'Used by'), h('dd', {}, users.length ? users.map((a) => a.name).join(', ') : 'no agents')),
    h('div', { class: 'toolcard__foot' },
      h('label', { class: 'switch' },
        h('input', { type: 'checkbox', checked: tool.connected, onchange: onToggle, 'aria-label': `${tool.connected ? 'Disconnect' : 'Connect'} ${tool.name}` }),
        h('span', { class: 'switch__track' }),
        h('span', {}, tool.connected ? 'Connected' : 'Disconnected')),
      h('span', { class: 'label' }, `${steps.length} workflow step${steps.length === 1 ? '' : 's'}`)));
}

export function render(ctx) {
  const s = ctx.state;
  const on = s.tools.filter((t) => t.connected);
  const off = s.tools.filter((t) => !t.connected);

  return h('div', {},
    h('div', { class: 'page-head' },
      h('div', { style: 'flex:1;min-width:240px' },
        h('h1', {}, 'Tools & connections'),
        h('p', {}, 'A tool is a capability an agent may call. These switches are real: disconnect one and every question or workflow step that depends on it starts failing, with the reason written into the trace.'))),

    h('div', { class: 'grid g4', style: 'margin-bottom:20px' },
      h('div', { class: 'stat stat--accent' }, h('div', { class: 'stat__label' }, 'Connected'),
        h('div', { class: 'stat__value' }, `${on.length}/${s.tools.length}`),
        h('div', { class: 'stat__delta' }, off.length ? `${off.map((t) => t.name).join(', ')} off` : 'everything is up')),
      h('div', { class: 'stat' }, h('div', { class: 'stat__label' }, 'Calls, 30 days'),
        h('div', { class: 'stat__value' }, num(s.tools.reduce((t, x) => t + x.calls30d, 0))),
        h('div', { class: 'stat__delta' }, 'across every connection')),
      h('div', { class: 'stat' }, h('div', { class: 'stat__label' }, 'Slowest'),
        h('div', { class: 'stat__value' }, `${num(Math.max(...s.tools.map((t) => t.latencyMs)))}`),
        h('div', { class: 'stat__delta' }, 'ms — ' + s.tools.slice().sort((a, b) => b.latencyMs - a.latencyMs)[0].name)),
      h('div', { class: 'stat' }, h('div', { class: 'stat__label' }, 'Agents gated'),
        h('div', { class: 'stat__value' }, String(s.agents.filter((a) => a.tools.some((t) => off.some((o) => o.id === t))).length)),
        h('div', { class: 'stat__delta' }, 'missing at least one tool'))),

    off.length
      ? h('div', { class: 'banner', style: 'margin-bottom:20px' },
        h('span', { html: icon('alert') }),
        h('span', {}, `${off.map((t) => t.name).join(' and ')} disconnected. Ask an affected agent something in the Playground and watch the inspector record the failed tool call.`))
      : null,

    h('div', { class: 'grid g3' }, s.tools.map((t) => toolCard(ctx, t))),

    h('div', { class: 'card', style: 'margin-top:20px' },
      h('div', { class: 'card__head' }, h('h3', {}, 'Which agent needs what')),
      h('div', { class: 'tablewrap tablewrap--scroll' },
        h('table', { class: 'data' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Agent'), s.tools.map((t) => h('th', {}, t.name)))),
          h('tbody', {}, s.agents.map((a) => h('tr', {},
            h('td', {}, a.name),
            s.tools.map((t) => h('td', {},
              a.tools.includes(t.id)
                ? h('span', { class: `pill ${t.connected ? 'pill--ok' : 'pill--bad'}` }, t.connected ? 'ready' : 'blocked')
                : h('span', { class: 'faint mono small' }, '—'))))))))));
}
