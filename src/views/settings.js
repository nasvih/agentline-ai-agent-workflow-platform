/* Settings — workspace level configuration, and the reset. */

import { h, icon, num, fmtDate, fmtTime, ago, toast, modal, confirmDialog, downloadCSV } from '../../lib/ui.js';
import { MODELS, rupees, agentById } from '../data.js';

const ENVIRONMENTS = ['sandbox', 'staging', 'production'];
const REGIONS = ['ap-south · Mumbai', 'ap-southeast · Singapore', 'me-central · Dammam', 'eu-west · Dublin'];
const NOTIFY = ['failed and escalated runs', 'failed runs only', 'every run', 'nothing'];

export function render(ctx) {
  const s = ctx.state;
  const st = s.settings;
  const form = h('div', {});

  const field = (label, control, hint) => h('label', { class: 'field' },
    h('span', { class: 'field__label' }, label), control, hint ? h('span', { class: 'hint' }, hint) : null);

  const nameInput = h('input', { class: 'input', value: st.workspace });
  const envSel = h('select', { class: 'select' }, ENVIRONMENTS.map((e) => h('option', { value: e, selected: e === st.environment }, e)));
  const modelSel = h('select', { class: 'select' }, MODELS.map((m) => h('option', { value: m.id, selected: m.id === st.defaultModel }, `${m.label} — ${m.note}`)));
  const regionSel = h('select', { class: 'select' }, REGIONS.map((r) => h('option', { value: r, selected: r === st.region }, r)));
  const notifySel = h('select', { class: 'select' }, NOTIFY.map((n) => h('option', { value: n, selected: n === st.notifyOn }, n)));
  const retention = h('input', { class: 'input', type: 'number', min: '1', max: '365', value: String(st.retentionDays) });
  const sampling = h('input', { class: 'input', type: 'number', min: '1', max: '100', value: String(st.traceSampling) });
  const dist = h('input', { class: 'input', value: st.distribution });
  const streamIn = h('input', { type: 'checkbox', checked: st.streaming, 'aria-label': 'Stream replies word by word' });

  form.append(
    h('div', { class: 'grid g2' },
      field('Workspace name', nameInput),
      field('Environment', envSel, 'Cosmetic in the demo — it only labels the workspace.'),
      field('Default model for new agents', modelSel),
      field('Region', regionSel, 'Where runs would execute.'),
      field('Run retention (days)', retention, 'History in this demo is also capped at 90 entries.'),
      field('Trace sampling (%)', sampling, 'Share of runs that keep a full trace.'),
      field('Notify on', notifySel),
      field('Report distribution list', dist)),
    h('div', { class: 'field' },
      h('label', { class: 'switch' }, streamIn, h('span', { class: 'switch__track' }),
        h('span', {}, 'Stream replies word by word')),
      h('span', { class: 'hint' }, 'Turn this off and the agent still answers — the flag is written into every run trace.')),
    h('div', { class: 'btnrow', style: 'margin-top:16px' },
      h('button', {
        class: 'btn btn--primary',
        onclick: () => {
          ctx.store.update((state) => {
            Object.assign(state.settings, {
              workspace: nameInput.value.trim() || state.settings.workspace,
              environment: envSel.value,
              defaultModel: modelSel.value,
              region: regionSel.value,
              retentionDays: Math.min(365, Math.max(1, Number(retention.value) || 30)),
              traceSampling: Math.min(100, Math.max(1, Number(sampling.value) || 100)),
              notifyOn: notifySel.value,
              distribution: dist.value.trim() || state.settings.distribution,
              streaming: streamIn.checked,
            });
          });
          toast('Settings saved', 'ok');
          ctx.refresh();
        },
        html: `${icon('check')}<span>Save settings</span>`,
      }),
      h('button', { class: 'btn', onclick: () => ctx.refresh() }, 'Discard changes')),
  );

  const exportAll = () => {
    downloadCSV('agentline-agents.csv', [
      ['agent', 'model', 'status', 'tools', 'guardrails', 'runs_30d', 'success_rate'],
      ...s.agents.map((a) => [a.name, a.model, a.status, a.tools.join(' '), a.guardrails.join(' '), a.runs30d, a.successRate]),
    ]);
    toast('Agent list downloaded', 'ok');
  };

  const wipe = async () => {
    const ok = await confirmDialog(
      'This rebuilds the whole sample workspace from the seed and drops every change you have made here.',
      { title: 'Reset demo data', danger: true, okLabel: 'Reset everything' },
    );
    if (!ok) return;
    ctx.store.reset();
    toast('Demo data reset', 'ok');
    ctx.refresh();
  };

  return h('div', {},
    h('div', { class: 'page-head' },
      h('div', { style: 'flex:1;min-width:240px' },
        h('h1', {}, 'Settings'),
        h('p', {}, 'Workspace level configuration. Everything is stored in this browser under one localStorage key — there is no account and no server.'))),

    h('div', { class: 'grid g-side' },
      h('div', { class: 'card' },
        h('div', { class: 'card__head' }, h('h3', {}, 'Workspace')),
        form),

      h('div', { class: 'stack' },
        h('div', { class: 'card' },
          h('div', { class: 'card__head' }, h('h3', {}, 'What is in here')),
          h('dl', { class: 'kv' },
            h('dt', {}, 'Agents'), h('dd', {}, String(s.agents.length)),
            h('dt', {}, 'Workflows'), h('dd', {}, String(s.workflows.length)),
            h('dt', {}, 'Connections'), h('dd', {}, `${s.tools.filter((t) => t.connected).length} of ${s.tools.length} up`),
            h('dt', {}, 'Guardrails'), h('dd', {}, `${s.guardrails.filter((g) => g.enabled).length} of ${s.guardrails.length} on`),
            h('dt', {}, 'Runs held'), h('dd', {}, num(s.runs.length)),
            h('dt', {}, 'Spend'), h('dd', {}, rupees(s.runs.reduce((t, r) => t + r.costPaise, 0))),
            h('dt', {}, 'Records'), h('dd', {}, `${s.tickets.length} tickets · ${s.invoices.length} invoices · ${s.accounts.length} accounts`),
            h('dt', {}, 'Seeded'), h('dd', {}, fmtDate(s.createdAt))),
          h('div', { class: 'btnrow', style: 'margin-top:14px' },
            h('button', { class: 'btn btn--sm', onclick: exportAll, html: `${icon('download')}<span>Export agents CSV</span>` }))),

        h('div', { class: 'card' },
          h('div', { class: 'card__head' },
            h('h3', {}, 'Stored reports'),
            h('span', { class: 'label' }, `${(s.reports || []).length} held`)),
          (s.reports || []).length
            ? h('div', { class: 'stack' }, (s.reports || []).map((r) => h('div', { class: 'stored' },
              h('div', { style: 'flex:1;min-width:0' },
                h('div', { class: 'stored__title' }, r.title),
                h('div', { class: 'small muted' }, `${r.id} · ${(agentById(s, r.agentId) || {}).name || r.agentId} · ${ago(r.createdAt)}`)),
              h('button', {
                class: 'btn btn--sm',
                onclick: () => modal({
                  title: r.title,
                  width: '560px',
                  body: h('div', {},
                    h('div', { class: 'label', style: 'margin-bottom:8px' }, `${r.id} · written ${fmtDate(r.createdAt)} ${fmtTime(r.createdAt)}`),
                    h('div', { class: 'stored__body' }, r.body),
                    h('p', { class: 'hint', style: 'margin-top:12px' }, 'Composed locally from the workbook figures in this demo. No model wrote it and nothing was mailed.')),
                  actions: [{ label: 'Close', class: 'btn--primary' }],
                }),
              }, 'Read'))))
            : h('p', { class: 'muted small' }, 'Nothing stored yet. Open the Report Writer in the Playground and ask it to generate and store this week\'s report — it lands here with a run in the history.')),

        h('div', { class: 'card' },
          h('div', { class: 'card__head' }, h('h3', {}, 'How the answers are made')),
          h('p', { class: 'muted small' }, 'No model is involved anywhere in this application. A question is matched against a list of regular expressions, the winning intent reads the sample records held in this page, and the reply is composed from them. The word-by-word streaming, the tool calls in the inspector and the run traces are simulated so the product reads the way it would with a model behind it.'),
          h('p', { class: 'muted small', style: 'margin-top:8px' }, 'Nothing is fetched from any host. The only external request the page makes is the font stylesheet in the document head.')),

        h('div', { class: 'card' },
          h('div', { class: 'card__head' }, h('h3', {}, 'Danger zone')),
          h('p', { class: 'muted small' }, 'Resets connections, guardrail configuration, workflow steps, agents you created and the whole run history.'),
          h('div', { class: 'btnrow', style: 'margin-top:12px' },
            h('button', { class: 'btn btn--danger', onclick: wipe, html: `${icon('refresh')}<span>Reset demo data</span>` }))))));
}
