/* Settings — workspace level configuration, and the reset. */

import { h, esc, icon, num, fmtDate, fmtTime, ago, toast, modal, confirmDialog, downloadCSV } from '../../lib/ui.js';
import {
  MODELS, rupees, agentById,
  agentName, modelNote, envLabel, settingsRegionLabel, notifyLabel,
} from '../data.js';
import { t } from '../main.js';

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
  const envSel = h('select', { class: 'select' }, ENVIRONMENTS.map((e) => h('option', { value: e, selected: e === st.environment }, envLabel(e))));
  const modelSel = h('select', { class: 'select' }, MODELS.map((m) => h('option', { value: m.id, selected: m.id === st.defaultModel }, `${m.label} — ${modelNote(m.note)}`)));
  const regionSel = h('select', { class: 'select' }, REGIONS.map((r) => h('option', { value: r, selected: r === st.region }, settingsRegionLabel(r))));
  const notifySel = h('select', { class: 'select' }, NOTIFY.map((n) => h('option', { value: n, selected: n === st.notifyOn }, notifyLabel(n))));
  const retention = h('input', { class: 'input', type: 'number', min: '1', max: '365', value: String(st.retentionDays) });
  const sampling = h('input', { class: 'input', type: 'number', min: '1', max: '100', value: String(st.traceSampling) });
  const dist = h('input', { class: 'input', value: st.distribution });
  const streamIn = h('input', { type: 'checkbox', checked: st.streaming, 'aria-label': t('settingsView.stream') });

  form.append(
    h('div', { class: 'grid g2' },
      field(t('settingsView.fName'), nameInput),
      field(t('settingsView.fEnv'), envSel, t('settingsView.envHint')),
      field(t('settingsView.fModel'), modelSel),
      field(t('settingsView.fRegion'), regionSel, t('settingsView.regionHint')),
      field(t('settingsView.fRetention'), retention, t('settingsView.retentionHint')),
      field(t('settingsView.fSampling'), sampling, t('settingsView.samplingHint')),
      field(t('settingsView.fNotify'), notifySel),
      field(t('settingsView.fDist'), dist)),
    h('div', { class: 'field' },
      h('label', { class: 'switch' }, streamIn, h('span', { class: 'switch__track' }),
        h('span', {}, t('settingsView.stream'))),
      h('span', { class: 'hint' }, t('settingsView.streamHint'))),
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
          toast(t('settingsView.saved'), 'ok');
          ctx.refresh();
        },
        html: `${icon('check')}<span>${esc(t('settingsView.saveBtn'))}</span>`,
      }),
      h('button', { class: 'btn', onclick: () => ctx.refresh() }, t('settingsView.discard'))),
  );

  const exportAll = () => {
    downloadCSV('agentline-agents.csv', [
      ['agent', 'model', 'status', 'tools', 'guardrails', 'runs_30d', 'success_rate'],
      ...s.agents.map((a) => [a.name, a.model, a.status, a.tools.join(' '), a.guardrails.join(' '), a.runs30d, a.successRate]),
    ]);
    toast(t('settingsView.exported'), 'ok');
  };

  const wipe = async () => {
    const ok = await confirmDialog(
      t('settingsView.wipeBody'),
      { title: t('reset.title'), danger: true, okLabel: t('settingsView.wipeOk') },
    );
    if (!ok) return;
    ctx.store.reset();
    toast(t('reset.done'), 'ok');
    ctx.refresh();
  };

  return h('div', {},
    h('div', { class: 'page-head' },
      h('div', { style: 'flex:1;min-width:240px' },
        h('h1', {}, t('settingsView.title')),
        h('p', {}, t('settingsView.lede')))),

    h('div', { class: 'grid g-side' },
      h('div', { class: 'card' },
        h('div', { class: 'card__head' }, h('h3', {}, t('settingsView.workspace'))),
        form),

      h('div', { class: 'stack' },
        h('div', { class: 'card' },
          h('div', { class: 'card__head' }, h('h3', {}, t('settingsView.whatsHere'))),
          h('dl', { class: 'kv' },
            h('dt', {}, t('settingsView.kAgents')), h('dd', {}, String(s.agents.length)),
            h('dt', {}, t('settingsView.kWorkflows')), h('dd', {}, String(s.workflows.length)),
            h('dt', {}, t('settingsView.kConnections')), h('dd', {}, t('settingsView.connectionsUp', { n: s.tools.filter((x) => x.connected).length, total: s.tools.length })),
            h('dt', {}, t('settingsView.kGuardrails')), h('dd', {}, t('settingsView.guardsOn', { n: s.guardrails.filter((g) => g.enabled).length, total: s.guardrails.length })),
            h('dt', {}, t('settingsView.kRuns')), h('dd', {}, num(s.runs.length)),
            h('dt', {}, t('settingsView.kSpend')), h('dd', {}, rupees(s.runs.reduce((sum, r) => sum + r.costPaise, 0))),
            h('dt', {}, t('settingsView.kRecords')), h('dd', {}, t('settingsView.records', { t: s.tickets.length, i: s.invoices.length, a: s.accounts.length })),
            h('dt', {}, t('settingsView.kSeeded')), h('dd', {}, fmtDate(s.createdAt))),
          h('div', { class: 'btnrow', style: 'margin-top:14px' },
            h('button', { class: 'btn btn--sm', onclick: exportAll, html: `${icon('download')}<span>${esc(t('settingsView.exportAgents'))}</span>` }))),

        h('div', { class: 'card' },
          h('div', { class: 'card__head' },
            h('h3', {}, t('settingsView.stored')),
            h('span', { class: 'label' }, t('settingsView.heldN', { n: (s.reports || []).length }))),
          (s.reports || []).length
            ? h('div', { class: 'stack' }, (s.reports || []).map((r) => h('div', { class: 'stored' },
              h('div', { style: 'flex:1;min-width:0' },
                h('div', { class: 'stored__title' }, r.title),
                h('div', { class: 'small muted' }, t('settingsView.reportSub', { id: r.id, agent: agentName(agentById(s, r.agentId)) || r.agentId, when: ago(r.createdAt) }))),
              h('button', {
                class: 'btn btn--sm',
                onclick: () => modal({
                  title: r.title,
                  width: '560px',
                  body: h('div', {},
                    h('div', { class: 'label', style: 'margin-bottom:8px' }, t('settingsView.writtenAt', { id: r.id, date: fmtDate(r.createdAt), time: fmtTime(r.createdAt) })),
                    h('div', { class: 'stored__body' }, r.body),
                    h('p', { class: 'hint', style: 'margin-top:12px' }, t('settingsView.reportNote'))),
                  actions: [{ label: t('common.close'), class: 'btn--primary' }],
                }),
              }, t('common.read')))))
            : h('p', { class: 'muted small' }, t('settingsView.noReports'))),

        h('div', { class: 'card' },
          h('div', { class: 'card__head' }, h('h3', {}, t('settingsView.howAnswers'))),
          h('p', { class: 'muted small' }, t('settingsView.howA')),
          h('p', { class: 'muted small', style: 'margin-top:8px' }, t('settingsView.howB'))),

        h('div', { class: 'card' },
          h('div', { class: 'card__head' }, h('h3', {}, t('settingsView.danger'))),
          h('p', { class: 'muted small' }, t('settingsView.dangerBody')),
          h('div', { class: 'btnrow', style: 'margin-top:12px' },
            h('button', { class: 'btn btn--danger', onclick: wipe, html: `${icon('refresh')}<span>${esc(t('shell.reset'))}</span>` }))))));
}
