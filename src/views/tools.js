/* Tools & connections — the switches that gate what agents can do. */

import { h, icon, num, fmtDate, toast, confirmDialog } from '../../lib/ui.js';
import { toolName, toolKind, toolAccount, toolDesc, agentName } from '../data.js';
import { t } from '../main.js';

function toolCard(ctx, tool) {
  const s = ctx.state;
  const users = s.agents.filter((a) => a.tools.includes(tool.id));
  const steps = s.workflows.flatMap((w) => w.steps.filter((st) => st.kind === 'tool' && st.ref === tool.id).map((st) => ({ w, st })));

  const setConnected = (on) => {
    ctx.store.update((st) => {
      /* was `const t` — that shadowed the imported translator */
      const rec = st.tools.find((x) => x.id === tool.id);
      rec.connected = on;
      if (on) rec.connectedAt = new Date().toISOString();
    });
    toast(t('toolsView.toggled', { name: toolName(tool), state: on ? t('common.connected') : t('common.disconnected') }), on ? 'ok' : 'bad');
    ctx.refresh();
  };

  const onToggle = async (e) => {
    const wants = e.target.checked;
    if (!wants && users.length) {
      e.target.checked = true;
      const ok = await confirmDialog(
        t('toolsView.confirmBody', {
          agents: t('toolsView.nAgents', { n: users.length }),
          name: toolName(tool),
          names: users.map((a) => agentName(a)).join(t('common.listSep')),
          steps: t('toolsView.nSteps', { n: steps.length }),
        }),
        { title: t('toolsView.confirmTitle', { name: toolName(tool) }), danger: true, okLabel: t('toolsView.confirmOk') },
      );
      if (!ok) return;
    }
    setConnected(wants);
  };

  return h('article', { class: `toolcard${tool.connected ? ' is-on' : ''}` },
    h('div', { class: 'toolcard__top' },
      h('span', { class: 'toolcard__icon', html: icon(tool.icon) }),
      h('div', { style: 'flex:1;min-width:0' },
        h('h3', {}, toolName(tool)),
        h('div', { class: 'label' }, toolKind(tool))),
      h('span', { class: `pill ${tool.connected ? 'pill--ok' : 'pill--bad'}` }, tool.connected ? t('common.connected') : t('toolsView.pillOff'))),
    h('p', {}, toolDesc(tool)),
    h('div', { class: 'toolcard__ops' }, tool.ops.map((op) => h('span', { class: 'tagm' }, op))),
    h('dl', { class: 'kv' },
      h('dt', {}, t('toolsView.account')), h('dd', {}, toolAccount(tool)),
      h('dt', {}, t('toolsView.calls30d')), h('dd', {}, num(tool.calls30d)),
      h('dt', {}, t('toolsView.latency')), h('dd', {}, t('toolsView.msTypical', { n: num(tool.latencyMs) })),
      h('dt', {}, t('toolsView.since')), h('dd', {}, fmtDate(tool.connectedAt)),
      h('dt', {}, t('toolsView.usedBy')), h('dd', {}, users.length ? users.map((a) => agentName(a)).join(t('common.listSep')) : t('toolsView.noAgents'))),
    h('div', { class: 'toolcard__foot' },
      h('label', { class: 'switch' },
        h('input', { type: 'checkbox', checked: tool.connected, onchange: onToggle, 'aria-label': tool.connected ? t('toolsView.disconnectAria', { name: toolName(tool) }) : t('toolsView.connectAria', { name: toolName(tool) }) }),
        h('span', { class: 'switch__track' }),
        h('span', {}, tool.connected ? t('toolsView.swConnected') : t('toolsView.swDisconnected'))),
      h('span', { class: 'label' }, t('toolsView.wfSteps', { n: steps.length }))));
}

export function render(ctx) {
  const s = ctx.state;
  const on = s.tools.filter((x) => x.connected);
  const off = s.tools.filter((x) => !x.connected);

  return h('div', {},
    h('div', { class: 'page-head' },
      h('div', { style: 'flex:1;min-width:240px' },
        h('h1', {}, t('toolsView.title')),
        h('p', {}, t('toolsView.lede')))),

    h('div', { class: 'grid g4', style: 'margin-bottom:20px' },
      h('div', { class: 'stat stat--accent' }, h('div', { class: 'stat__label' }, t('toolsView.connected')),
        h('div', { class: 'stat__value' }, `${on.length}/${s.tools.length}`),
        h('div', { class: 'stat__delta' }, off.length ? t('toolsView.someOff', { names: off.map((x) => toolName(x)).join(t('common.listSep')) }) : t('toolsView.everythingUp'))),
      h('div', { class: 'stat' }, h('div', { class: 'stat__label' }, t('toolsView.calls30')),
        h('div', { class: 'stat__value' }, num(s.tools.reduce((acc, x) => acc + x.calls30d, 0))),
        h('div', { class: 'stat__delta' }, t('toolsView.acrossEvery'))),
      h('div', { class: 'stat' }, h('div', { class: 'stat__label' }, t('toolsView.slowest')),
        h('div', { class: 'stat__value' }, `${num(Math.max(...s.tools.map((x) => x.latencyMs)))}`),
        h('div', { class: 'stat__delta' }, t('toolsView.msName', { name: toolName(s.tools.slice().sort((a, b) => b.latencyMs - a.latencyMs)[0]) }))),
      h('div', { class: 'stat' }, h('div', { class: 'stat__label' }, t('toolsView.gated')),
        h('div', { class: 'stat__value' }, String(s.agents.filter((a) => a.tools.some((id) => off.some((o) => o.id === id))).length)),
        h('div', { class: 'stat__delta' }, t('toolsView.gatedSub')))),

    off.length
      ? h('div', { class: 'banner', style: 'margin-bottom:20px' },
        h('span', { html: icon('alert') }),
        h('span', {}, t('toolsView.banner', { names: off.map((x) => toolName(x)).join(t('common.and')) })))
      : null,

    h('div', { class: 'grid g3' }, s.tools.map((x) => toolCard(ctx, x))),

    h('div', { class: 'card', style: 'margin-top:20px' },
      h('div', { class: 'card__head' }, h('h3', {}, t('toolsView.matrix'))),
      h('div', { class: 'tablewrap tablewrap--scroll' },
        h('table', { class: 'data' },
          h('thead', {}, h('tr', {}, h('th', {}, t('toolsView.thAgent')), s.tools.map((x) => h('th', {}, toolName(x))))),
          h('tbody', {}, s.agents.map((a) => h('tr', {},
            h('td', {}, agentName(a)),
            s.tools.map((x) => h('td', {},
              a.tools.includes(x.id)
                ? h('span', { class: `pill ${x.connected ? 'pill--ok' : 'pill--bad'}` }, x.connected ? t('toolsView.ready') : t('toolsView.blocked'))
                : h('span', { class: 'faint mono small' }, t('common.dash')))))))))));
}
