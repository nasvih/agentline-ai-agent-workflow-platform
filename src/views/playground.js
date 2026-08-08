/* Playground — talk to one agent, watch the run inspector fill up.

   The chat is the shared Assistant mounted with mountInto(). The rail on
   the right replays the simulated tool calls, guardrail checks, token
   counts and cost that the guardrail engine produced for that turn. */

import { h, icon, num, toast } from '../../lib/ui.js';
import { agentById, guardById, toolById, rupees, STATUS_PILL } from '../data.js';
import { buildAgentBot, GUARDRAIL_PROBES } from '../agent.js';

const VERDICT_PILL = {
  passed: 'pill--ok', blocked: 'pill--bad', escalated: 'pill--warn',
  redacted: 'pill--info', off: '', skipped: '',
};

function createRail() {
  const statusPill = h('span', { class: 'pill' }, 'idle');
  const body = h('div', { class: 'rail__body' }, h('p', { class: 'rail__empty' }, 'Ask the agent something. Every tool call, guardrail check and token count for that turn lands here.'));
  const stats = h('div', { class: 'rail__stats' });
  const verdicts = h('div', { class: 'probes' });
  let seq = 0;

  const el = h('section', { class: 'rail', 'aria-label': 'Run inspector' },
    h('div', { class: 'rail__head' }, h('span', { html: icon('eye') }), h('h3', {}, 'Run inspector'), statusPill),
    h('p', { class: 'simnote' }, 'Simulated run. Tool calls, tokens and latency are generated locally from this app\'s demo data — no model is connected.'),
    body, stats, verdicts);

  const stat = (label, value) => h('div', { class: 'rail__stat' },
    h('div', { class: 'label' }, label), h('div', { class: 'num' }, value));

  function run(tel) {
    const mine = ++seq;
    body.innerHTML = '';
    stats.innerHTML = '';
    verdicts.innerHTML = '';
    statusPill.className = 'pill pill--amber';
    statusPill.textContent = 'running';

    body.appendChild(h('div', { class: 'ev' },
      h('span', { class: 'ev__mark ev__mark--ok' }),
      h('div', {}, h('div', { class: 'ev__label' }, `${tel.agentName}`),
        h('div', { class: 'ev__detail' }, `${tel.model} · intent ${tel.intent} · ${tel.runId}`)),
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
        h('span', { class: 'ev__ms mono' }, `${e.ms} ms`)));
      body.scrollTop = body.scrollHeight;
      setTimeout(step, 90 + Math.random() * 130);
    };

    function finish() {
      statusPill.className = `pill ${STATUS_PILL[tel.status] || ''}`;
      statusPill.textContent = tel.status;
      stats.append(
        stat('Tokens in', num(tel.tokensIn)),
        stat('Tokens out', num(tel.tokensOut)),
        stat('Latency', `${num(tel.latencyMs)} ms`),
        stat('Cost', rupees(tel.costPaise)),
      );
      verdicts.appendChild(h('div', { class: 'label' }, 'Guardrails'));
      if (!tel.verdicts.length) {
        verdicts.appendChild(h('p', { class: 'rail__empty' }, 'No guardrails are attached to this agent.'));
      } else {
        tel.verdicts.forEach((v) => {
          verdicts.appendChild(h('div', { class: 'between', style: 'padding:4px 0' },
            h('span', { class: 'small' }, v.name || v.id),
            h('span', { class: `pill ${VERDICT_PILL[v.verdict] || ''}`, title: v.detail || '' }, v.verdict)));
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
    return h('div', { class: 'empty' }, h('h3', {}, 'No agents'), h('p', {}, 'Create one on the Agents screen first.'));
  }

  const rail = createRail();
  const chatHost = h('div', { class: 'pg__chat' });

  const bot = buildAgentBot(ctx.store, agent, {
    emit: (tel) => {
      tel.verdicts = tel.verdicts.map((v) => ({ ...v, name: (guardById(ctx.state, v.id) || {}).name || v.id }));
      rail.run(tel);
    },
  });

  const seg = h('div', { class: 'seg', role: 'tablist', 'aria-label': 'Choose an agent' },
    s.agents.map((a) => h('button', {
      class: `seg__btn${a.id === agent.id ? ' is-on' : ''}`,
      role: 'tab',
      'aria-selected': a.id === agent.id ? 'true' : 'false',
      onclick: () => ctx.navigate(`playground/${a.id}`),
    }, h('span', { class: 'seg__av' }, a.initials), h('span', {}, a.name))));

  const missing = agent.tools.filter((t) => !(toolById(s, t) || {}).connected);

  const probes = h('div', { class: 'card card--flat', style: 'margin-top:14px' },
    h('div', { class: 'label', style: 'margin-bottom:8px' }, 'Guardrail probes'),
    h('p', { class: 'small muted', style: 'margin-bottom:10px' }, 'Three questions written to hit a rule. Toggle the matching rule in Guardrails and ask again — the reply changes.'),
    h('div', { class: 'chiprow' }, GUARDRAIL_PROBES.map((p) =>
      h('button', { class: 'chip', onclick: () => bot.ask(p.q), title: p.q }, p.label))));

  const node = h('div', {},
    h('div', { class: 'page-head' },
      h('div', { style: 'flex:1;min-width:240px' },
        h('h1', {}, 'Playground'),
        h('p', {}, `Talking to ${agent.name}. Each agent carries its own intent pack, so the same question gets a different answer depending on who you ask.`)),
      h('div', { class: 'btnrow' },
        h('span', { class: `pill ${agent.status === 'live' ? 'pill--ok' : 'pill--warn'}` }, agent.status),
        h('span', { class: 'pill' }, agent.model),
        h('button', { class: 'btn btn--sm', onclick: () => ctx.navigate(`runs?agent=${agent.id}`) }, 'Runs for this agent'))),

    seg,

    missing.length
      ? h('div', { class: 'banner', style: 'margin-bottom:14px' },
        h('span', { html: icon('alert') }),
        h('span', {}, `${missing.map((t) => (toolById(s, t) || {}).name).join(' and ')} ${missing.length > 1 ? 'are' : 'is'} disconnected. Questions that need ${missing.length > 1 ? 'them' : 'it'} will fail — that refusal is the connection gate doing its job, not an error.`))
      : null,

    h('div', { class: 'pg' },
      h('div', {},
        h('p', { class: 'simnote simnote--top' }, `${agent.name} is simulated. Replies are matched locally against this app's demo records — no AI model is connected and nothing leaves your browser.`),
        chatHost, probes),
      h('div', {}, rail.el,
        h('div', { class: 'card card--flat', style: 'margin-top:14px' },
          h('div', { class: 'label', style: 'margin-bottom:8px' }, 'This agent reads'),
          h('div', { class: 'chiprow' }, agent.tools.map((t) => {
            const tool = toolById(s, t);
            return tool ? h('span', { class: `tagm${tool.connected ? ' tagm--on' : ' tagm--off'}`, html: `${icon(tool.icon)}<span>${tool.name}</span>` }) : null;
          })),
          h('p', { class: 'small muted', style: 'margin-top:10px' }, agent.purpose)))));

  /* mount after the host is in the tree so height:100% resolves */
  queueMicrotask(() => {
    bot.mountInto(chatHost);
    if (agent.status !== 'live') toast(`${agent.name} is ${agent.status} — you can still talk to it here`, '');
  });

  return node;
}
