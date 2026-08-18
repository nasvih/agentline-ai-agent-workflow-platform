/* Playground — talk to one agent, watch the run inspector fill up.

   The chat is the shared Assistant mounted with mountInto(). The rail on
   the right replays the simulated tool calls, guardrail checks, token
   counts and cost that the guardrail engine produced for that turn. */

import { h, icon, num, toast } from '../../lib/ui.js';
import {
  agentById, guardById, toolById, rupees, STATUS_PILL,
  agentName, agentPurpose, agentStatusLabel,
  toolName, guardName, verdictLabel, statusLabel,
} from '../data.js';
import { buildAgentBot, guardrailProbes } from '../agent.js';
import { t } from '../main.js';

const VERDICT_PILL = {
  passed: 'pill--ok', blocked: 'pill--bad', escalated: 'pill--warn',
  redacted: 'pill--info', off: '', skipped: '',
};

function createRail() {
  const statusPill = h('span', { class: 'pill' }, t('playgroundView.idle'));
  const body = h('div', { class: 'rail__body' }, h('p', { class: 'rail__empty' }, t('playgroundView.railEmpty')));
  const stats = h('div', { class: 'rail__stats' });
  const verdicts = h('div', { class: 'probes' });
  let seq = 0;

  const el = h('section', { class: 'rail', 'aria-label': t('playgroundView.inspector') },
    h('div', { class: 'rail__head' }, h('span', { html: icon('eye') }), h('h3', {}, t('playgroundView.inspector')), statusPill),
    h('p', { class: 'simnote' }, t('playgroundView.simnote')),
    body, stats, verdicts);

  const stat = (label, value) => h('div', { class: 'rail__stat' },
    h('div', { class: 'label' }, label), h('div', { class: 'num' }, value));

  function run(tel) {
    const mine = ++seq;
    body.innerHTML = '';
    stats.innerHTML = '';
    verdicts.innerHTML = '';
    statusPill.className = 'pill pill--amber';
    statusPill.textContent = t('playgroundView.running');

    body.appendChild(h('div', { class: 'ev' },
      h('span', { class: 'ev__mark ev__mark--ok' }),
      h('div', {}, h('div', { class: 'ev__label' }, `${tel.agentName}`),
        h('div', { class: 'ev__detail' }, t('playgroundView.intentLine', { model: tel.model, intent: tel.intent, run: tel.runId }))),
      h('span', { class: 'ev__ms' }, '')));

    let i = 0;
    const step = () => {
      if (mine !== seq) return;
      if (i >= tel.events.length) return finish();
      const e = tel.events[i++];
      body.appendChild(h('div', { class: 'ev' },
        h('span', { class: `ev__mark ev__mark--${e.status}` }),
        h('div', {},
          h('div', { class: 'ev__label' }, e.label),
          e.detail ? h('div', { class: 'ev__detail' }, e.detail) : null),
        h('span', { class: 'ev__ms mono' }, t('common.ms', { n: e.ms }))));
      body.scrollTop = body.scrollHeight;
      setTimeout(step, 90 + Math.random() * 130);
    };

    function finish() {
      statusPill.className = `pill ${STATUS_PILL[tel.status] || ''}`;
      statusPill.textContent = statusLabel(tel.status);
      stats.append(
        stat(t('playgroundView.tokensIn'), num(tel.tokensIn)),
        stat(t('playgroundView.tokensOut'), num(tel.tokensOut)),
        stat(t('playgroundView.latency'), t('common.ms', { n: num(tel.latencyMs) })),
        stat(t('playgroundView.cost'), rupees(tel.costPaise)),
      );
      verdicts.appendChild(h('div', { class: 'label' }, t('playgroundView.guardrails')));
      if (!tel.verdicts.length) {
        verdicts.appendChild(h('p', { class: 'rail__empty' }, t('playgroundView.noGuardrails')));
      } else {
        tel.verdicts.forEach((v) => {
          verdicts.appendChild(h('div', { class: 'between', style: 'padding:4px 0' },
            h('span', { class: 'small' }, guardName(v) || v.id),
            h('span', { class: `pill ${VERDICT_PILL[v.verdict] || ''}`, title: v.detail || '' }, verdictLabel(v.verdict))));
        });
      }
    }

    setTimeout(step, 120);
  }

  return { el, run };
}

export function render(ctx) {
  const s = ctx.state;
  const wanted = ctx.params[0] || ctx.query.get('agent');
  const agent = agentById(s, wanted) || s.agents.find((a) => a.status === 'live') || s.agents[0];

  if (!agent) {
    return h('div', { class: 'empty' }, h('h3', {}, t('playgroundView.noAgents')), h('p', {}, t('playgroundView.noAgentsBody')));
  }

  const rail = createRail();
  const chatHost = h('div', { class: 'pg__chat' });

  const bot = buildAgentBot(ctx.store, agent, {
    emit: (tel) => {
      tel.verdicts = tel.verdicts.map((v) => ({ ...v, name: (guardById(ctx.state, v.id) || {}).name || v.id }));
      rail.run(tel);
    },
  });

  const seg = h('div', { class: 'seg', role: 'tablist', 'aria-label': t('playgroundView.chooseAgent') },
    s.agents.map((a) => h('button', {
      class: `seg__btn${a.id === agent.id ? ' is-on' : ''}`,
      role: 'tab',
      'aria-selected': a.id === agent.id ? 'true' : 'false',
      onclick: () => ctx.navigate(`playground/${a.id}`),
    }, h('span', { class: 'seg__av' }, a.initials), h('span', {}, agentName(a)))));

  const missing = agent.tools.filter((id) => !(toolById(s, id) || {}).connected);

  const probes = h('div', { class: 'card card--flat', style: 'margin-top:14px' },
    h('div', { class: 'label', style: 'margin-bottom:8px' }, t('playgroundView.probesLabel')),
    h('p', { class: 'small muted', style: 'margin-bottom:10px' }, t('playgroundView.probesHint')),
    h('div', { class: 'chiprow' }, guardrailProbes().map((p) =>
      h('button', { class: 'chip', onclick: () => bot.ask(p.q), title: p.q }, p.label))));

  const node = h('div', {},
    h('div', { class: 'page-head' },
      h('div', { style: 'flex:1;min-width:240px' },
        h('h1', {}, t('playgroundView.title')),
        h('p', {}, t('playgroundView.lede', { name: agentName(agent) }))),
      h('div', { class: 'btnrow' },
        h('span', { class: `pill ${agent.status === 'live' ? 'pill--ok' : 'pill--warn'}` }, agentStatusLabel(agent.status)),
        h('span', { class: 'pill' }, agent.model),
        h('button', { class: 'btn btn--sm', onclick: () => ctx.navigate(`runs?agent=${agent.id}`) }, t('playgroundView.runsForAgent')))),

    seg,

    missing.length
      ? h('div', { class: 'banner', style: 'margin-bottom:14px' },
        h('span', { html: icon('alert') }),
        h('span', {}, t(missing.length > 1 ? 'playgroundView.missingMany' : 'playgroundView.missingOne', {
          names: missing.map((id) => toolName(toolById(s, id)) || id).join(t('common.and')),
        })))
      : null,

    h('div', { class: 'pg' },
      h('div', {},
        h('p', { class: 'simnote simnote--top' }, t('playgroundView.simtop', { name: agentName(agent) })),
        chatHost, probes),
      h('div', {}, rail.el,
        h('div', { class: 'card card--flat', style: 'margin-top:14px' },
          h('div', { class: 'label', style: 'margin-bottom:8px' }, t('playgroundView.reads')),
          h('div', { class: 'chiprow' }, agent.tools.map((toolId) => {
            const tool = toolById(s, toolId);
            return tool ? h('span', { class: `tagm${tool.connected ? ' tagm--on' : ' tagm--off'}`, html: `${icon(tool.icon)}<span>${toolName(tool)}</span>` }) : null;
          })),
          h('p', { class: 'small muted', style: 'margin-top:10px' }, agentPurpose(agent))))));

  /* mount after the host is in the tree so height:100% resolves */
  queueMicrotask(() => {
    bot.mountInto(chatHost);
    if (agent.status !== 'live') toast(t('playgroundView.stillTalk', { name: agentName(agent), status: agentStatusLabel(agent.status) }), '');
  });

  return node;
}
