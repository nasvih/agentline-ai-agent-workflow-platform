/* Agents — the four demo agents plus anything created here. */

import { h, icon, num, pct, fmtDate, ago, toast, modal, confirmDialog, meter } from '../../lib/ui.js';
import { toolById, guardById, AGENT_PILL, MODELS, rupees } from '../data.js';

const initialsOf = (name) => String(name).split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || 'AG';

function toolTags(state, agent) {
  return h('div', { class: 'chiprow' }, agent.tools.map((t) => {
    const tool = toolById(state, t);
    if (!tool) return null;
    return h('span', {
      class: `tagm${tool.connected ? '' : ' tagm--off'}`,
      title: tool.connected ? `${tool.name} — connected` : `${tool.name} — disconnected, calls will fail`,
      html: `${icon(tool.icon)}<span>${tool.name}</span>`,
    });
  }));
}

function guardTags(state, agent) {
  return h('div', { class: 'chiprow' }, agent.guardrails.map((g) => {
    const gr = guardById(state, g);
    if (!gr) return null;
    return h('span', {
      class: `tagm${gr.enabled ? ' tagm--on' : ' tagm--off'}`,
      title: gr.enabled ? `${gr.name} — enabled` : `${gr.name} — disabled workspace wide`,
    }, gr.name);
  }));
}

/* ---------- detail drawer ---------- */
function openDrawer(ctx, agent) {
  const s = ctx.state;
  const runs = s.runs.filter((r) => r.agentId === agent.id).slice(0, 6);
  const close = () => { drawer.remove(); scrim.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };

  const drawer = h('aside', { class: 'drawer', role: 'dialog', 'aria-label': `${agent.name} detail` },
    h('div', { class: 'drawer__head' },
      h('span', { class: 'tile' }, agent.initials),
      h('div', { style: 'flex:1;min-width:0' },
        h('h3', { class: 'truncate' }, agent.name),
        h('div', { class: 'label' }, agent.model)),
      h('button', { class: 'btn btn--ghost btn--icon', 'aria-label': 'Close detail', onclick: close, html: icon('x') })),
    h('div', { class: 'drawer__body stack' },
      h('p', { class: 'muted' }, agent.description),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Status'), h('dd', {}, agent.status),
        h('dt', {}, 'Owner'), h('dd', {}, agent.owner),
        h('dt', {}, 'Created'), h('dd', {}, fmtDate(agent.createdAt)),
        h('dt', {}, 'Runs 30d'), h('dd', {}, num(agent.runs30d)),
        h('dt', {}, 'Success'), h('dd', {}, pct(agent.successRate, 1)),
        h('dt', {}, 'Latency'), h('dd', {}, `${num(agent.avgLatencyMs)} ms average`),
        h('dt', {}, 'Tokens'), h('dd', {}, `${num(agent.avgTokens.in)} in / ${num(agent.avgTokens.out)} out`)),
      h('hr', { class: 'hr' }),
      h('div', { class: 'label' }, 'Tools'), toolTags(s, agent),
      h('div', { class: 'label', style: 'margin-top:12px' }, 'Guardrails'), guardTags(s, agent),
      h('hr', { class: 'hr' }),
      h('div', { class: 'label' }, 'Recent runs'),
      runs.length
        ? h('div', { class: 'tablewrap', style: 'margin-top:8px' },
          h('table', { class: 'data' }, h('tbody', {}, runs.map((r) => h('tr', {},
            h('td', {}, h('span', { class: 'runid linkish', onclick: () => { close(); ctx.navigate(`runs/${r.id}`); } }, r.id)),
            h('td', {}, h('span', { class: `pill ${{ success: 'pill--ok', failed: 'pill--bad', escalated: 'pill--warn', blocked: 'pill--info' }[r.status] || ''}` }, r.status)),
            h('td', { class: 'right mono small' }, ago(r.startedAt)))))))
        : h('p', { class: 'muted small' }, 'No runs held for this agent yet.'),
      h('div', { class: 'btnrow', style: 'margin-top:16px' },
        h('button', { class: 'btn btn--primary', onclick: () => { close(); ctx.navigate(`playground/${agent.id}`); }, html: `${icon('bolt')}<span>Open in Playground</span>` }),
        h('button', { class: 'btn', onclick: () => { close(); ctx.navigate(`runs?agent=${agent.id}`); } }, 'See all runs'))));

  const scrim = h('div', { class: 'scrim', style: 'z-index:66;background:rgba(23,24,26,.42)', onclick: close });
  document.body.appendChild(scrim);
  document.body.appendChild(drawer);
  document.addEventListener('keydown', onKey);
}

/* ---------- edit / create ---------- */
function agentForm(ctx, agent) {
  const s = ctx.state;
  const isNew = !agent;
  const a = agent || { name: '', purpose: '', description: '', model: s.settings.defaultModel, tools: [], guardrails: [], owner: 'Meera Raghavan' };
  const body = h('div', {},
    h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Name'),
      h('input', { class: 'input', name: 'name', value: a.name, placeholder: 'Contract Checker' })),
    h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'What it does'),
      h('input', { class: 'input', name: 'purpose', value: a.purpose, placeholder: 'Reads supplier contracts and flags the clauses that changed.' })),
    h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Description'),
      h('textarea', { class: 'textarea', name: 'description' }, a.description)),
    h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Model'),
      h('select', { class: 'select', name: 'model' }, MODELS.map((m) =>
        h('option', { value: m.id, selected: m.id === a.model }, `${m.label} — ${m.note}`)))),
    h('div', { class: 'field' }, h('span', { class: 'field__label' }, 'Tools'),
      h('div', { class: 'chiprow' }, s.tools.map((t) =>
        h('label', { class: 'switch' },
          h('input', { type: 'checkbox', name: 'tool', value: t.id, checked: a.tools.includes(t.id) }),
          h('span', { class: 'switch__track' }), h('span', {}, t.name))))),
    h('div', { class: 'field' }, h('span', { class: 'field__label' }, 'Guardrails'),
      h('div', { class: 'chiprow' }, s.guardrails.map((g) =>
        h('label', { class: 'switch' },
          h('input', { type: 'checkbox', name: 'guard', value: g.id, checked: a.guardrails.includes(g.id) }),
          h('span', { class: 'switch__track' }), h('span', {}, g.name))))));

  modal({
    title: isNew ? 'New agent' : `Edit ${agent.name}`,
    width: '560px',
    body,
    actions: [
      { label: 'Cancel' },
      {
        label: isNew ? 'Create agent' : 'Save',
        class: 'btn--primary',
        onClick: (bodyEl) => {
          const val = (n) => (bodyEl.querySelector(`[name="${n}"]`) || {}).value || '';
          const checked = (n) => [...bodyEl.querySelectorAll(`[name="${n}"]:checked`)].map((x) => x.value);
          const name = val('name').trim();
          if (!name) { toast('Give the agent a name', 'bad'); return true; }
          const tools = checked('tool');
          const guards = checked('guard');
          ctx.store.update((st) => {
            if (isNew) {
              st.counters.agentSeq += 1;
              st.agents.push({
                id: `agent-${st.counters.agentSeq}`,
                name, initials: initialsOf(name), status: 'draft',
                purpose: val('purpose').trim() || 'Newly created agent, no pack wired yet.',
                description: val('description').trim() || 'Created in the demo. It answers about its own definition, runs, tools and guardrails until a pack is written for it in src/agent.js.',
                model: val('model'), owner: 'You',
                tools, guardrails: guards,
                successRate: 0, runs30d: 0, avgLatencyMs: 900, avgTokens: { in: 620, out: 210 },
                createdAt: new Date().toISOString().slice(0, 10),
                custom: true,
              });
            } else {
              const t = st.agents.find((x) => x.id === agent.id);
              t.name = name; t.initials = initialsOf(name);
              t.purpose = val('purpose').trim(); t.description = val('description').trim();
              t.model = val('model'); t.tools = tools; t.guardrails = guards;
            }
          });
          toast(isNew ? 'Agent created' : 'Agent saved', 'ok');
          ctx.refresh();
          return false;
        },
      },
    ],
  });
}

/* ---------- card ---------- */
function card(ctx, agent) {
  const s = ctx.state;
  const toggle = () => {
    ctx.store.update((st) => {
      const t = st.agents.find((x) => x.id === agent.id);
      t.status = t.status === 'live' ? 'paused' : 'live';
    });
    toast(`${agent.name} is now ${agent.status === 'live' ? 'paused' : 'live'}`, 'ok');
    ctx.refresh();
  };
  const remove = async () => {
    const ok = await confirmDialog(`Delete ${agent.name}? Its run history stays in the Runs screen.`, { title: 'Delete agent', danger: true, okLabel: 'Delete' });
    if (!ok) return;
    ctx.store.update((st) => { st.agents = st.agents.filter((x) => x.id !== agent.id); });
    toast('Agent deleted', 'ok');
    ctx.refresh();
  };

  return h('article', { class: 'agentcard' },
    h('div', { class: 'agentcard__top' },
      h('span', { class: `tile${agent.status === 'live' ? '' : ' tile--muted'}` }, agent.initials),
      h('div', { style: 'flex:1;min-width:0' },
        h('h3', {}, agent.name),
        h('div', { class: 'label' }, agent.model)),
      h('span', { class: `pill ${AGENT_PILL[agent.status] || ''}` }, agent.status)),
    h('p', { class: 'agentcard__purpose' }, agent.purpose),
    toolTags(s, agent),
    guardTags(s, agent),
    h('div', { class: 'agentcard__stats' },
      h('div', { class: 'agentcard__stat' }, h('div', { class: 'label' }, 'Runs 30d'), h('div', { class: 'num' }, num(agent.runs30d))),
      h('div', { class: 'agentcard__stat' }, h('div', { class: 'label' }, 'Success'), h('div', { class: 'num' }, pct(agent.successRate, 1)), meter(agent.successRate, 100, agent.successRate > 92 ? 'ok' : '')),
      h('div', { class: 'agentcard__stat' }, h('div', { class: 'label' }, 'Latency'), h('div', { class: 'num' }, `${num(agent.avgLatencyMs)}ms`))),
    h('div', { class: 'agentcard__foot' },
      h('button', { class: 'btn btn--sm btn--primary', onclick: () => ctx.navigate(`playground/${agent.id}`), html: `${icon('bolt')}<span>Playground</span>` }),
      h('button', { class: 'btn btn--sm', onclick: () => openDrawer(ctx, agent) }, 'Details'),
      h('button', { class: 'btn btn--sm', onclick: () => agentForm(ctx, agent) }, 'Edit'),
      h('button', { class: 'btn btn--sm', onclick: toggle }, agent.status === 'live' ? 'Pause' : 'Activate'),
      agent.custom ? h('button', { class: 'btn btn--sm btn--danger', onclick: remove }, 'Delete') : null));
}

export function render(ctx) {
  const s = ctx.state;
  const live = s.agents.filter((a) => a.status === 'live');
  const runs30 = s.agents.reduce((t, a) => t + a.runs30d, 0);
  const avgSuccess = s.agents.length ? s.agents.reduce((t, a) => t + a.successRate, 0) / s.agents.length : 0;
  const spend = s.runs.reduce((t, r) => t + r.costPaise, 0);

  return h('div', {},
    h('div', { class: 'page-head' },
      h('div', { style: 'flex:1;min-width:240px' },
        h('h1', {}, 'Agents'),
        h('p', {}, 'Each agent is a purpose, a model, a set of tools it may call and the guardrails it must obey. Open one in the Playground to talk to it — every agent answers from a different pack.')),
      h('div', { class: 'btnrow' },
        h('button', { class: 'btn btn--primary', onclick: () => agentForm(ctx, null), html: `${icon('plus')}<span>New agent</span>` }))),

    h('div', { class: 'grid g4', style: 'margin-bottom:20px' },
      h('div', { class: 'stat stat--accent' }, h('div', { class: 'stat__label' }, 'Live agents'),
        h('div', { class: 'stat__value' }, `${live.length}/${s.agents.length}`),
        h('div', { class: 'stat__delta' }, `${s.agents.length - live.length} paused or draft`)),
      h('div', { class: 'stat' }, h('div', { class: 'stat__label' }, 'Runs, 30 days'),
        h('div', { class: 'stat__value' }, num(runs30)),
        h('div', { class: 'stat__delta' }, `${s.runs.length} traces held here`)),
      h('div', { class: 'stat' }, h('div', { class: 'stat__label' }, 'Average success'),
        h('div', { class: 'stat__value' }, pct(avgSuccess, 1)),
        h('div', { class: 'stat__delta' }, 'across every agent record')),
      h('div', { class: 'stat' }, h('div', { class: 'stat__label' }, 'Spend on held runs'),
        h('div', { class: 'stat__value' }, rupees(spend)),
        h('div', { class: 'stat__delta' }, 'demo rate, tokens in and out'))),

    h('div', { class: 'agentgrid' }, s.agents.map((a) => card(ctx, a))),

    h('div', { class: 'banner', style: 'margin-top:20px' },
      h('span', { html: icon('alert') }),
      h('span', {}, 'Nothing here calls a model. Replies are matched locally against the sample records in this page, and the tool calls you see in the Playground inspector are simulated so the trace reads like the real thing.')));
}
