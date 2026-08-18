/* Runs — history table with filters, and the full trace for one run. */

import { h, icon, num, ago, fmtDate, fmtTime, toast, downloadCSV } from '../../lib/ui.js';
import {
  agentById, workflowById, guardById, rupees, STATUS_PILL, newRunId,
  agentName, statusLabel, triggerName, workflowName,
  traceLabel, traceDetail, traceStatusLabel, kindLabel,
  guardName, verdictLabel,
} from '../data.js';
import { t } from '../main.js';

/* Filter values stay English — they are the query-string keys and the
   record values. Only the painted chip label is translated. */
const STATUSES = ['all', 'success', 'failed', 'escalated', 'blocked'];

const pill = (status) => h('span', { class: `pill ${STATUS_PILL[status] || ''}` }, statusLabel(status));

/* ---------- one run ---------- */
function detail(ctx, run) {
  const s = ctx.state;
  const agent = agentById(s, run.agentId);
  const wf = run.workflowId ? workflowById(s, run.workflowId) : null;

  const rerun = () => {
    const id = newRunId();
    ctx.store.update((st) => {
      /* stored English — the record is the key, triggerName() paints it */
      st.runs.unshift({ ...run, id, startedAt: new Date().toISOString(), trigger: 'Manual re-run' });
      st.runs = st.runs.slice(0, 90);
    });
    toast(t('runsView.rerunDone'), 'ok');
    ctx.navigate(`runs/${id}`);
  };

  return h('div', {},
    h('button', { class: 'backlink', onclick: () => ctx.navigate('runs'), html: `${icon('arrowRight')}<span>${t('runsView.allRuns')}</span>` }),
    h('div', { class: 'page-head' },
      h('div', { style: 'flex:1;min-width:240px' },
        h('h1', { class: 'runid', style: 'font-size:20px' }, run.id),
        h('p', {}, t('runsView.head', {
          agent: agent ? agentName(agent) : run.agentId,
          trigger: triggerName(run.trigger),
          wf: wf ? ` · ${workflowName(wf)}` : '',
          date: fmtDate(run.startedAt),
          time: fmtTime(run.startedAt),
        }))),
      h('div', { class: 'btnrow' },
        pill(run.status),
        h('button', { class: 'btn btn--sm', onclick: rerun, html: `${icon('refresh')}<span>${t('runsView.rerun')}</span>` }),
        agent ? h('button', { class: 'btn btn--sm', onclick: () => ctx.navigate(`playground/${agent.id}`) }, t('runsView.openAgent')) : null)),

    h('div', { class: 'runsum', style: 'margin-bottom:20px' },
      h('div', { class: 'stat' }, h('div', { class: 'stat__label' }, t('runsView.duration')), h('div', { class: 'stat__value' }, `${num(run.durationMs)}`), h('div', { class: 'stat__delta' }, t('runsView.durationSub'))),
      h('div', { class: 'stat' }, h('div', { class: 'stat__label' }, t('runsView.tokens')), h('div', { class: 'stat__value' }, num(run.tokensIn + run.tokensOut)), h('div', { class: 'stat__delta' }, t('runsView.tokensSub', { in: num(run.tokensIn), out: num(run.tokensOut) }))),
      h('div', { class: 'stat' }, h('div', { class: 'stat__label' }, t('runsView.cost')), h('div', { class: 'stat__value' }, rupees(run.costPaise)), h('div', { class: 'stat__delta' }, t('runsView.costSub'))),
      h('div', { class: 'stat stat--accent' }, h('div', { class: 'stat__label' }, t('runsView.steps')), h('div', { class: 'stat__value' }, String(run.trace.length)), h('div', { class: 'stat__delta' }, t('runsView.stepsSub', { n: run.trace.filter((ev) => ev.status === 'ok').length })))),

    run.question ? h('div', { class: 'card', style: 'margin-bottom:20px' },
      h('div', { class: 'label', style: 'margin-bottom:6px' }, t('runsView.question')),
      h('p', {}, run.question)) : null,

    h('div', { class: 'grid g-side' },
      h('div', { class: 'card' },
        h('div', { class: 'card__head' }, h('h3', {}, t('runsView.trace')), h('span', { class: 'label' }, t('runsView.events', { n: run.trace.length }))),
        /* the loop parameter must NOT be named `t` — that shadows the translator */
        h('div', { class: 'trace' }, run.trace.map((ev) => h('div', { class: `trace__item trace__item--${ev.status}` },
          h('div', { class: 'trace__head' },
            h('span', { class: 'trace__name' }, traceLabel(ev.label)),
            h('span', { class: 'label' }, kindLabel(ev.kind)),
            h('span', { class: 'mono small faint' }, t('common.ms', { n: num(ev.ms) })),
            h('span', { class: `pill ${STATUS_PILL[ev.status === 'ok' ? 'success' : ev.status] || ''}` }, traceStatusLabel(ev.status))),
          ev.detail ? h('div', { class: 'trace__detail' }, traceDetail(ev.detail)) : null)))),

      h('div', { class: 'stack' },
        h('div', { class: 'card' },
          h('div', { class: 'card__head' }, h('h3', {}, t('runsView.guardrails'))),
          (run.guardrails || []).length
            ? h('div', {}, run.guardrails.map((g) => h('div', { class: 'between', style: 'padding:5px 0' },
              h('span', { class: 'small' }, guardName(guardById(s, g.id)) || g.id),
              h('span', { class: `pill ${{ passed: 'pill--ok', blocked: 'pill--bad', escalated: 'pill--warn', redacted: 'pill--info' }[g.verdict] || ''}` }, verdictLabel(g.verdict)))))
            : h('p', { class: 'muted small' }, t('runsView.noGuardrails'))),
        h('div', { class: 'card' },
          h('div', { class: 'card__head' }, h('h3', {}, t('runsView.context'))),
          h('dl', { class: 'kv' },
            h('dt', {}, t('runsView.cAgent')), h('dd', {}, agent ? agentName(agent) : run.agentId),
            h('dt', {}, t('runsView.cModel')), h('dd', {}, agent ? agent.model : t('common.unknown')),
            h('dt', {}, t('runsView.cTrigger')), h('dd', {}, triggerName(run.trigger)),
            h('dt', {}, t('runsView.cWorkflow')), h('dd', {}, wf ? workflowName(wf) : t('common.none')),
            h('dt', {}, t('runsView.cStarted')), h('dd', {}, `${fmtDate(run.startedAt)} ${fmtTime(run.startedAt)}`),
            h('dt', {}, t('runsView.cAge')), h('dd', {}, ago(run.startedAt)))))));
}

/* ---------- list ---------- */
export function render(ctx) {
  const s = ctx.state;
  if (ctx.params[0]) {
    const run = s.runs.find((r) => r.id === ctx.params[0]);
    if (run) return detail(ctx, run);
    return h('div', { class: 'empty' },
      h('h3', {}, t('runsView.notHere')),
      h('p', {}, t('runsView.notHereBody')),
      h('button', { class: 'btn', style: 'margin-top:12px', onclick: () => ctx.navigate('runs') }, t('runsView.backToRuns')));
  }

  const status = ctx.query.get('status') || 'all';
  const agentFilter = ctx.query.get('agent') || 'all';
  const wfFilter = ctx.query.get('workflow') || 'all';

  const qs = (over) => {
    const p = new URLSearchParams();
    const merged = { status, agent: agentFilter, workflow: wfFilter, ...over };
    Object.entries(merged).forEach(([k, v]) => { if (v && v !== 'all') p.set(k, v); });
    const str = p.toString();
    return `runs${str ? `?${str}` : ''}`;
  };

  let rows = s.runs;
  if (status !== 'all') rows = rows.filter((r) => r.status === status);
  if (agentFilter !== 'all') rows = rows.filter((r) => r.agentId === agentFilter);
  if (wfFilter !== 'all') rows = rows.filter((r) => r.workflowId === wfFilter);

  const counts = s.runs.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {});

  const table = rows.length
    ? h('div', { class: 'tablewrap tablewrap--scroll' },
      h('table', { class: 'data' },
        h('thead', {}, h('tr', {},
          h('th', {}, t('runsView.thRun')), h('th', {}, t('runsView.thAgent')), h('th', {}, t('runsView.thTrigger')), h('th', {}, t('runsView.thWorkflow')),
          h('th', {}, t('runsView.thStatus')), h('th', {}, t('runsView.thStarted')), h('th', { class: 'right' }, t('runsView.thDuration')),
          h('th', { class: 'right' }, t('runsView.thTokens')), h('th', { class: 'right' }, t('runsView.thCost')))),
        h('tbody', {}, rows.map((r) => {
          const a = agentById(s, r.agentId);
          const w = r.workflowId ? workflowById(s, r.workflowId) : null;
          return h('tr', {},
            h('td', {}, h('span', { class: 'runid linkish', onclick: () => ctx.navigate(`runs/${r.id}`) }, r.id)),
            h('td', {}, a ? agentName(a) : r.agentId),
            h('td', { class: 'small muted' }, triggerName(r.trigger)),
            h('td', { class: 'small muted' }, w ? workflowName(w) : t('common.dash')),
            h('td', {}, pill(r.status)),
            h('td', { class: 'small muted' }, ago(r.startedAt)),
            h('td', { class: 'right mono small' }, t('common.ms', { n: num(r.durationMs) })),
            h('td', { class: 'right mono small' }, num(r.tokensIn + r.tokensOut)),
            h('td', { class: 'right mono small' }, rupees(r.costPaise)));
        }))))
    : h('div', { class: 'empty' },
      h('h3', {}, t('runsView.noneMatch')),
      h('p', {}, t('runsView.noneMatchBody')));

  const exportCSV = () => {
    /* CSV stays English/Latin — column headers and record values alike */
    downloadCSV('agentline-runs.csv', [
      ['run', 'agent', 'trigger', 'workflow', 'status', 'started', 'duration_ms', 'tokens_in', 'tokens_out', 'cost_inr'],
      ...rows.map((r) => [
        r.id, (agentById(s, r.agentId) || {}).name || r.agentId, r.trigger,
        r.workflowId ? (workflowById(s, r.workflowId) || {}).name : '',
        r.status, r.startedAt, r.durationMs, r.tokensIn, r.tokensOut, (r.costPaise / 100).toFixed(2),
      ]),
    ]);
    toast(t('runsView.csvDone'), 'ok');
  };

  return h('div', {},
    h('div', { class: 'page-head' },
      h('div', { style: 'flex:1;min-width:240px' },
        h('h1', {}, t('runsView.title')),
        h('p', {}, t('runsView.lede'))),
      h('div', { class: 'btnrow' },
        h('button', { class: 'btn btn--sm', onclick: exportCSV, html: `${icon('download')}<span>${t('runsView.exportCSV')}</span>` }))),

    h('div', { class: 'filters' },
      h('span', { class: 'label' }, t('runsView.statusLabel')),
      STATUSES.map((st) => h('button', {
        class: `chip${status === st ? ' is-on' : ''}`,
        onclick: () => ctx.navigate(qs({ status: st })),
      }, st === 'all'
        ? t('runsView.allWith', { n: s.runs.length })
        : t('runsView.chip', { status: statusLabel(st), n: counts[st] || 0 }))),
      h('span', { class: 'label', style: 'margin-left:8px' }, t('runsView.agentLabel')),
      h('select', {
        class: 'select', style: 'width:auto;min-width:170px', 'aria-label': t('runsView.filterAgent'),
        onchange: (e) => ctx.navigate(qs({ agent: e.target.value })),
      },
      h('option', { value: 'all', selected: agentFilter === 'all' }, t('runsView.allAgents')),
      s.agents.map((a) => h('option', { value: a.id, selected: agentFilter === a.id }, agentName(a)))),
      wfFilter !== 'all'
        ? h('button', { class: 'chip is-on', onclick: () => ctx.navigate(qs({ workflow: 'all' })) },
          `${workflowName(workflowById(s, wfFilter)) || wfFilter} ×`)
        : null),

    table,

    h('p', { class: 'small faint', style: 'margin-top:12px' },
      t('runsView.shown', { shown: rows.length, total: s.runs.length })));
}
