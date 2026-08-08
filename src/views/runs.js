/* Runs — history table with filters, and the full trace for one run. */

import { h, icon, num, ago, fmtDate, fmtTime, toast, downloadCSV } from '../../lib/ui.js';
import { agentById, workflowById, guardById, rupees, STATUS_PILL, newRunId } from '../data.js';

const STATUSES = ['all', 'success', 'failed', 'escalated', 'blocked'];

const pill = (status) => h('span', { class: `pill ${STATUS_PILL[status] || ''}` }, status);

/* ---------- one run ---------- */
function detail(ctx, run) {
  const s = ctx.state;
  const agent = agentById(s, run.agentId);
  const wf = run.workflowId ? workflowById(s, run.workflowId) : null;

  const rerun = () => {
    const id = newRunId();
    ctx.store.update((st) => {
      st.runs.unshift({ ...run, id, startedAt: new Date().toISOString(), trigger: 'Manual re-run' });
      st.runs = st.runs.slice(0, 90);
    });
    toast('Re-run recorded', 'ok');
    ctx.navigate(`runs/${id}`);
  };

  return h('div', {},
    h('button', { class: 'backlink', onclick: () => ctx.navigate('runs'), html: `${icon('arrowRight')}<span>All runs</span>` }),
    h('div', { class: 'page-head' },
      h('div', { style: 'flex:1;min-width:240px' },
        h('h1', { class: 'runid', style: 'font-size:20px' }, run.id),
        h('p', {}, `${agent ? agent.name : run.agentId} · ${run.trigger}${wf ? ` · ${wf.name}` : ''} · started ${fmtDate(run.startedAt)} ${fmtTime(run.startedAt)}`)),
      h('div', { class: 'btnrow' },
        pill(run.status),
        h('button', { class: 'btn btn--sm', onclick: rerun, html: `${icon('refresh')}<span>Re-run</span>` }),
        agent ? h('button', { class: 'btn btn--sm', onclick: () => ctx.navigate(`playground/${agent.id}`) }, 'Open agent') : null)),

    h('div', { class: 'runsum', style: 'margin-bottom:20px' },
      h('div', { class: 'stat' }, h('div', { class: 'stat__label' }, 'Duration'), h('div', { class: 'stat__value' }, `${num(run.durationMs)}`), h('div', { class: 'stat__delta' }, 'milliseconds, wall clock')),
      h('div', { class: 'stat' }, h('div', { class: 'stat__label' }, 'Tokens'), h('div', { class: 'stat__value' }, num(run.tokensIn + run.tokensOut)), h('div', { class: 'stat__delta' }, `${num(run.tokensIn)} in · ${num(run.tokensOut)} out`)),
      h('div', { class: 'stat' }, h('div', { class: 'stat__label' }, 'Cost'), h('div', { class: 'stat__value' }, rupees(run.costPaise)), h('div', { class: 'stat__delta' }, 'demo rate on tokens')),
      h('div', { class: 'stat stat--accent' }, h('div', { class: 'stat__label' }, 'Steps'), h('div', { class: 'stat__value' }, String(run.trace.length)), h('div', { class: 'stat__delta' }, `${run.trace.filter((t) => t.status === 'ok').length} clean`))),

    run.question ? h('div', { class: 'card', style: 'margin-bottom:20px' },
      h('div', { class: 'label', style: 'margin-bottom:6px' }, 'Question asked'),
      h('p', {}, run.question)) : null,

    h('div', { class: 'grid g-side' },
      h('div', { class: 'card' },
        h('div', { class: 'card__head' }, h('h3', {}, 'Trace'), h('span', { class: 'label' }, `${run.trace.length} events`)),
        h('div', { class: 'trace' }, run.trace.map((t) => h('div', { class: `trace__item trace__item--${t.status}` },
          h('div', { class: 'trace__head' },
            h('span', { class: 'trace__name' }, t.label),
            h('span', { class: 'label' }, t.kind),
            h('span', { class: 'mono small faint' }, `${num(t.ms)} ms`),
            h('span', { class: `pill ${STATUS_PILL[t.status === 'ok' ? 'success' : t.status] || ''}` }, t.status)),
          t.detail ? h('div', { class: 'trace__detail' }, t.detail) : null)))),

      h('div', { class: 'stack' },
        h('div', { class: 'card' },
          h('div', { class: 'card__head' }, h('h3', {}, 'Guardrails')),
          (run.guardrails || []).length
            ? h('div', {}, run.guardrails.map((g) => h('div', { class: 'between', style: 'padding:5px 0' },
              h('span', { class: 'small' }, (guardById(s, g.id) || {}).name || g.id),
              h('span', { class: `pill ${{ passed: 'pill--ok', blocked: 'pill--bad', escalated: 'pill--warn', redacted: 'pill--info' }[g.verdict] || ''}` }, g.verdict))))
            : h('p', { class: 'muted small' }, 'No guardrails were attached to this agent at run time.')),
        h('div', { class: 'card' },
          h('div', { class: 'card__head' }, h('h3', {}, 'Context')),
          h('dl', { class: 'kv' },
            h('dt', {}, 'Agent'), h('dd', {}, agent ? agent.name : run.agentId),
            h('dt', {}, 'Model'), h('dd', {}, agent ? agent.model : 'unknown'),
            h('dt', {}, 'Trigger'), h('dd', {}, run.trigger),
            h('dt', {}, 'Workflow'), h('dd', {}, wf ? wf.name : 'none'),
            h('dt', {}, 'Started'), h('dd', {}, `${fmtDate(run.startedAt)} ${fmtTime(run.startedAt)}`),
            h('dt', {}, 'Age'), h('dd', {}, ago(run.startedAt)))))));
}

/* ---------- list ---------- */
export function render(ctx) {
  const s = ctx.state;
  if (ctx.params[0]) {
    const run = s.runs.find((r) => r.id === ctx.params[0]);
    if (run) return detail(ctx, run);
    return h('div', { class: 'empty' },
      h('h3', {}, 'That run is not here'),
      h('p', {}, 'Run history is capped at 90 entries and a reset clears it.'),
      h('button', { class: 'btn', style: 'margin-top:12px', onclick: () => ctx.navigate('runs') }, 'Back to runs'));
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
          h('th', {}, 'Run'), h('th', {}, 'Agent'), h('th', {}, 'Trigger'), h('th', {}, 'Workflow'),
          h('th', {}, 'Status'), h('th', {}, 'Started'), h('th', { class: 'right' }, 'Duration'),
          h('th', { class: 'right' }, 'Tokens'), h('th', { class: 'right' }, 'Cost'))),
        h('tbody', {}, rows.map((r) => {
          const a = agentById(s, r.agentId);
          const w = r.workflowId ? workflowById(s, r.workflowId) : null;
          return h('tr', {},
            h('td', {}, h('span', { class: 'runid linkish', onclick: () => ctx.navigate(`runs/${r.id}`) }, r.id)),
            h('td', {}, a ? a.name : r.agentId),
            h('td', { class: 'small muted' }, r.trigger),
            h('td', { class: 'small muted' }, w ? w.name : '—'),
            h('td', {}, pill(r.status)),
            h('td', { class: 'small muted' }, ago(r.startedAt)),
            h('td', { class: 'right mono small' }, `${num(r.durationMs)} ms`),
            h('td', { class: 'right mono small' }, num(r.tokensIn + r.tokensOut)),
            h('td', { class: 'right mono small' }, rupees(r.costPaise)));
        }))))
    : h('div', { class: 'empty' },
      h('h3', {}, 'No runs match'),
      h('p', {}, 'Clear the filter, or make a new run from the Playground or a workflow.'));

  const exportCSV = () => {
    downloadCSV('agentline-runs.csv', [
      ['run', 'agent', 'trigger', 'workflow', 'status', 'started', 'duration_ms', 'tokens_in', 'tokens_out', 'cost_inr'],
      ...rows.map((r) => [
        r.id, (agentById(s, r.agentId) || {}).name || r.agentId, r.trigger,
        r.workflowId ? (workflowById(s, r.workflowId) || {}).name : '',
        r.status, r.startedAt, r.durationMs, r.tokensIn, r.tokensOut, (r.costPaise / 100).toFixed(2),
      ]),
    ]);
    toast('CSV downloaded', 'ok');
  };

  return h('div', {},
    h('div', { class: 'page-head' },
      h('div', { style: 'flex:1;min-width:240px' },
        h('h1', {}, 'Runs'),
        h('p', {}, 'Every playground turn and every workflow run lands here with its full trace. Click a run id to see what the agent actually did, step by step.')),
      h('div', { class: 'btnrow' },
        h('button', { class: 'btn btn--sm', onclick: exportCSV, html: `${icon('download')}<span>Export CSV</span>` }))),

    h('div', { class: 'filters' },
      h('span', { class: 'label' }, 'Status'),
      STATUSES.map((st) => h('button', {
        class: `chip${status === st ? ' is-on' : ''}`,
        onclick: () => ctx.navigate(qs({ status: st })),
      }, st === 'all' ? `all ${s.runs.length}` : `${st} ${counts[st] || 0}`)),
      h('span', { class: 'label', style: 'margin-left:8px' }, 'Agent'),
      h('select', {
        class: 'select', style: 'width:auto;min-width:170px', 'aria-label': 'Filter by agent',
        onchange: (e) => ctx.navigate(qs({ agent: e.target.value })),
      },
      h('option', { value: 'all', selected: agentFilter === 'all' }, 'All agents'),
      s.agents.map((a) => h('option', { value: a.id, selected: agentFilter === a.id }, a.name))),
      wfFilter !== 'all'
        ? h('button', { class: 'chip is-on', onclick: () => ctx.navigate(qs({ workflow: 'all' })) },
          `${(workflowById(s, wfFilter) || {}).name || wfFilter} ×`)
        : null),

    table,

    h('p', { class: 'small faint', style: 'margin-top:12px' },
      `${rows.length} of ${s.runs.length} runs shown. History is capped at 90 entries in this demo.`));
}
