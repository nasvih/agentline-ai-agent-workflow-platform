/* Agents — the four demo agents plus anything created here. */

import { h, esc, icon, num, pct, fmtDate, ago, toast, modal, confirmDialog, meter } from '../../lib/ui.js';
import {
  toolById, guardById, AGENT_PILL, MODELS, rupees,
  toolName, agentName, agentPurpose, agentDesc, agentStatusLabel,
  guardName, modelNote, statusLabel,
} from '../data.js';
import { t } from '../main.js';

const initialsOf = (name) => String(name).split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || 'AG';

function toolTags(state, agent) {
  /* the parameter is a tool id, not the translator — naming it `t` shadowed
     the import and threw `t is not a function` two lines down */
  return h('div', { class: 'chiprow' }, agent.tools.map((toolId) => {
    const tool = toolById(state, toolId);
    if (!tool) return null;
    return h('span', {
      class: `tagm${tool.connected ? '' : ' tagm--off'}`,
      title: tool.connected ? t('agentsView.toolConnected', { name: toolName(tool) }) : t('agentsView.toolDisconnected', { name: toolName(tool) }),
      html: `${icon(tool.icon)}<span>${esc(toolName(tool))}</span>`,
    });
  }));
}

function guardTags(state, agent) {
  return h('div', { class: 'chiprow' }, agent.guardrails.map((g) => {
    const gr = guardById(state, g);
    if (!gr) return null;
    return h('span', {
      class: `tagm${gr.enabled ? ' tagm--on' : ' tagm--off'}`,
      title: gr.enabled ? t('agentsView.guardEnabled', { name: guardName(gr) }) : t('agentsView.guardDisabled', { name: guardName(gr) }),
    }, guardName(gr));
  }));
}

/* ---------- detail drawer ---------- */
function openDrawer(ctx, agent) {
  const s = ctx.state;
  const runs = s.runs.filter((r) => r.agentId === agent.id).slice(0, 6);
  const close = () => { drawer.remove(); scrim.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };

  const drawer = h('aside', { class: 'drawer', role: 'dialog', 'aria-label': t('agentsView.detailOf', { name: agentName(agent) }) },
    h('div', { class: 'drawer__head' },
      h('span', { class: 'tile' }, agent.initials),
      h('div', { style: 'flex:1;min-width:0' },
        h('h3', { class: 'truncate' }, agentName(agent)),
        h('div', { class: 'label', dir: 'ltr' }, agent.model)),
      h('button', { class: 'btn btn--ghost btn--icon', 'aria-label': t('agentsView.closeDetail'), onclick: close, html: icon('x') })),
    h('div', { class: 'drawer__body stack' },
      h('p', { class: 'muted' }, agentDesc(agent)),
      h('dl', { class: 'kv' },
        h('dt', {}, t('agentsView.status')), h('dd', {}, agentStatusLabel(agent.status)),
        h('dt', {}, t('agentsView.owner')), h('dd', {}, agent.owner),
        h('dt', {}, t('agentsView.created')), h('dd', {}, fmtDate(agent.createdAt)),
        h('dt', {}, t('agentsView.runs30d')), h('dd', {}, num(agent.runs30d)),
        h('dt', {}, t('agentsView.success')), h('dd', {}, pct(agent.successRate, 1)),
        h('dt', {}, t('agentsView.latency')), h('dd', {}, t('agentsView.msAverage', { n: num(agent.avgLatencyMs) })),
        h('dt', {}, t('agentsView.tokens')), h('dd', {}, t('agentsView.inOut', { in: num(agent.avgTokens.in), out: num(agent.avgTokens.out) }))),
      h('hr', { class: 'hr' }),
      h('div', { class: 'label' }, t('agentsView.tools')), toolTags(s, agent),
      h('div', { class: 'label', style: 'margin-top:12px' }, t('agentsView.guardrails')), guardTags(s, agent),
      h('hr', { class: 'hr' }),
      h('div', { class: 'label' }, t('agentsView.recentRuns')),
      runs.length
        ? h('div', { class: 'tablewrap', style: 'margin-top:8px' },
          h('table', { class: 'data' }, h('tbody', {}, runs.map((r) => h('tr', {},
            h('td', {}, h('span', { class: 'runid linkish', onclick: () => { close(); ctx.navigate(`runs/${r.id}`); } }, r.id)),
            h('td', {}, h('span', { class: `pill ${{ success: 'pill--ok', failed: 'pill--bad', escalated: 'pill--warn', blocked: 'pill--info' }[r.status] || ''}` }, statusLabel(r.status))),
            h('td', { class: 'right mono small' }, ago(r.startedAt)))))))
        : h('p', { class: 'muted small' }, t('agentsView.noRuns')),
      h('div', { class: 'btnrow', style: 'margin-top:16px' },
        h('button', { class: 'btn btn--primary', onclick: () => { close(); ctx.navigate(`playground/${agent.id}`); }, html: `${icon('bolt')}<span>${esc(t('agentsView.openInPlayground'))}</span>` }),
        h('button', { class: 'btn', onclick: () => { close(); ctx.navigate(`runs?agent=${agent.id}`); } }, t('agentsView.seeAllRuns')))));

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
    h('label', { class: 'field' }, h('span', { class: 'field__label' }, t('agentsView.fName')),
      h('input', { class: 'input', name: 'name', value: agent ? agentName(a) : '', placeholder: t('agentsView.phName') })),
    h('label', { class: 'field' }, h('span', { class: 'field__label' }, t('agentsView.fPurpose')),
      h('input', { class: 'input', name: 'purpose', value: agentPurpose(a) || '', placeholder: t('agentsView.phPurpose') })),
    h('label', { class: 'field' }, h('span', { class: 'field__label' }, t('agentsView.fDescription')),
      h('textarea', { class: 'textarea', name: 'description' }, agentDesc(a) || '')),
    h('label', { class: 'field' }, h('span', { class: 'field__label' }, t('agentsView.fModel')),
      h('select', { class: 'select', name: 'model' }, MODELS.map((m) =>
        h('option', { value: m.id, selected: m.id === a.model }, `${m.label} — ${modelNote(m.note)}`)))),
    h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('agentsView.fTools')),
      h('div', { class: 'chiprow' }, s.tools.map((x) =>
        h('label', { class: 'switch' },
          h('input', { type: 'checkbox', name: 'tool', value: x.id, checked: a.tools.includes(x.id) }),
          h('span', { class: 'switch__track' }), h('span', {}, toolName(x)))))),
    h('div', { class: 'field' }, h('span', { class: 'field__label' }, t('agentsView.fGuardrails')),
      h('div', { class: 'chiprow' }, s.guardrails.map((g) =>
        h('label', { class: 'switch' },
          h('input', { type: 'checkbox', name: 'guard', value: g.id, checked: a.guardrails.includes(g.id) }),
          h('span', { class: 'switch__track' }), h('span', {}, guardName(g)))))));

  modal({
    title: isNew ? t('agentsView.newTitle') : t('agentsView.editTitle', { name: agentName(agent) }),
    width: '560px',
    body,
    actions: [
      { label: t('common.cancel') },
      {
        label: isNew ? t('agentsView.create') : t('common.save'),
        class: 'btn--primary',
        onClick: (bodyEl) => {
          const val = (n) => (bodyEl.querySelector(`[name="${n}"]`) || {}).value || '';
          const checked = (n) => [...bodyEl.querySelectorAll(`[name="${n}"]:checked`)].map((x) => x.value);
          const name = val('name').trim();
          if (!name) { toast(t('agentsView.needName'), 'bad'); return true; }
          const tools = checked('tool');
          const guards = checked('guard');
          ctx.store.update((st) => {
            if (isNew) {
              st.counters.agentSeq += 1;
              st.agents.push({
                id: `agent-${st.counters.agentSeq}`,
                name, initials: initialsOf(name), status: 'draft',
                purpose: val('purpose').trim() || t('agentsView.defaultPurpose'),
                description: val('description').trim() || t('agentsView.defaultDescription'),
                model: val('model'), owner: t('agentsView.you'),
                tools, guardrails: guards,
                successRate: 0, runs30d: 0, avgLatencyMs: 900, avgTokens: { in: 620, out: 210 },
                createdAt: new Date().toISOString().slice(0, 10),
                custom: true,
              });
            } else {
              const rec = st.agents.find((x) => x.id === agent.id);
              rec.name = name; rec.initials = initialsOf(name);
              rec.purpose = val('purpose').trim(); rec.description = val('description').trim();
              rec.model = val('model'); rec.tools = tools; rec.guardrails = guards;
            }
          });
          toast(isNew ? t('agentsView.createdToast') : t('agentsView.savedToast'), 'ok');
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
      const rec = st.agents.find((x) => x.id === agent.id);
      rec.status = rec.status === 'live' ? 'paused' : 'live';
    });
    toast(t('agentsView.nowStatus', { name: agentName(agent), status: agentStatusLabel(agent.status === 'live' ? 'paused' : 'live') }), 'ok');
    ctx.refresh();
  };
  const remove = async () => {
    const ok = await confirmDialog(t('agentsView.deleteBody', { name: agentName(agent) }), { title: t('agentsView.deleteTitle'), danger: true, okLabel: t('common.del') });
    if (!ok) return;
    ctx.store.update((st) => { st.agents = st.agents.filter((x) => x.id !== agent.id); });
    toast(t('agentsView.deleted'), 'ok');
    ctx.refresh();
  };

  return h('article', { class: 'agentcard' },
    h('div', { class: 'agentcard__top' },
      h('span', { class: `tile${agent.status === 'live' ? '' : ' tile--muted'}` }, agent.initials),
      h('div', { style: 'flex:1;min-width:0' },
        h('h3', {}, agentName(agent)),
        h('div', { class: 'label', dir: 'ltr' }, agent.model)),
      h('span', { class: `pill ${AGENT_PILL[agent.status] || ''}` }, agentStatusLabel(agent.status))),
    h('p', { class: 'agentcard__purpose' }, agentPurpose(agent)),
    toolTags(s, agent),
    guardTags(s, agent),
    h('div', { class: 'agentcard__stats' },
      h('div', { class: 'agentcard__stat' }, h('div', { class: 'label' }, t('agentsView.runs30d')), h('div', { class: 'num' }, num(agent.runs30d))),
      h('div', { class: 'agentcard__stat' }, h('div', { class: 'label' }, t('agentsView.success')), h('div', { class: 'num' }, pct(agent.successRate, 1)), meter(agent.successRate, 100, agent.successRate > 92 ? 'ok' : '')),
      h('div', { class: 'agentcard__stat' }, h('div', { class: 'label' }, t('agentsView.latency')), h('div', { class: 'num' }, `${num(agent.avgLatencyMs)}ms`))),
    h('div', { class: 'agentcard__foot' },
      h('button', { class: 'btn btn--sm btn--primary', onclick: () => ctx.navigate(`playground/${agent.id}`), html: `${icon('bolt')}<span>${esc(t('agentsView.playground'))}</span>` }),
      h('button', { class: 'btn btn--sm', onclick: () => openDrawer(ctx, agent) }, t('common.details')),
      h('button', { class: 'btn btn--sm', onclick: () => agentForm(ctx, agent) }, t('common.edit')),
      h('button', { class: 'btn btn--sm', onclick: toggle }, agent.status === 'live' ? t('agentsView.pause') : t('agentsView.activate')),
      agent.custom ? h('button', { class: 'btn btn--sm btn--danger', onclick: remove }, t('common.del')) : null));
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
        h('h1', {}, t('agentsView.title')),
        h('p', {}, t('agentsView.lede'))),
      h('div', { class: 'btnrow' },
        h('button', { class: 'btn btn--primary', onclick: () => agentForm(ctx, null), html: `${icon('plus')}<span>${esc(t('agentsView.newAgent'))}</span>` }))),

    h('div', { class: 'grid g4', style: 'margin-bottom:20px' },
      h('div', { class: 'stat stat--accent' }, h('div', { class: 'stat__label' }, t('agentsView.liveAgents')),
        h('div', { class: 'stat__value' }, `${live.length}/${s.agents.length}`),
        h('div', { class: 'stat__delta' }, t('agentsView.pausedOrDraft', { n: s.agents.length - live.length }))),
      h('div', { class: 'stat' }, h('div', { class: 'stat__label' }, t('agentsView.runs30')),
        h('div', { class: 'stat__value' }, num(runs30)),
        h('div', { class: 'stat__delta' }, t('agentsView.tracesHeld', { n: s.runs.length }))),
      h('div', { class: 'stat' }, h('div', { class: 'stat__label' }, t('agentsView.avgSuccess')),
        h('div', { class: 'stat__value' }, pct(avgSuccess, 1)),
        h('div', { class: 'stat__delta' }, t('agentsView.acrossEvery'))),
      h('div', { class: 'stat' }, h('div', { class: 'stat__label' }, t('agentsView.spend')),
        h('div', { class: 'stat__value' }, rupees(spend)),
        h('div', { class: 'stat__delta' }, t('agentsView.demoRate')))),

    h('div', { class: 'agentgrid' }, s.agents.map((a) => card(ctx, a))),

    h('div', { class: 'banner', style: 'margin-top:20px' },
      h('span', { html: icon('alert') }),
      h('span', {}, t('agentsView.banner'))));
}
