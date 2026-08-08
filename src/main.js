/* ============================================================
   Agentline — boot: store, nav, router, shell wiring, console agent.
   ============================================================ */

import { h, qs, icon, createStore, router, toast, confirmDialog, modal } from '../lib/ui.js';
import { STORE_KEY, seedState } from './data.js';
import { buildConsoleBot } from './agent.js';

import * as viewAgents from './views/agents.js';
import * as viewPlayground from './views/playground.js';
import * as viewWorkflows from './views/workflows.js';
import * as viewRuns from './views/runs.js';
import * as viewTools from './views/tools.js';
import * as viewGuardrails from './views/guardrails.js';
import * as viewSettings from './views/settings.js';

const store = createStore(STORE_KEY, seedState);

const NAV = [
  { group: 'Build', items: [
    { id: 'agents', label: 'Agents', icon: 'spark', key: 'a', sub: 'agents', view: viewAgents, count: (s) => s.agents.length },
    { id: 'playground', label: 'Playground', icon: 'bolt', key: 'p', sub: 'talk to an agent', view: viewPlayground },
    { id: 'workflows', label: 'Workflows', icon: 'flow', key: 'w', sub: 'pipelines', view: viewWorkflows, count: (s) => s.workflows.length },
  ] },
  { group: 'Operate', items: [
    { id: 'runs', label: 'Runs', icon: 'clock', key: 'r', sub: 'history and traces', view: viewRuns, count: (s) => s.runs.length },
    { id: 'tools', label: 'Tools & connections', icon: 'grid', key: 't', sub: 'integrations', view: viewTools, count: (s) => s.tools.filter((t) => t.connected).length },
    { id: 'guardrails', label: 'Guardrails', icon: 'shield', key: 'd', sub: 'policy', view: viewGuardrails, count: (s) => s.guardrails.filter((g) => g.enabled).length },
  ] },
  { group: 'Workspace', items: [
    { id: 'settings', label: 'Settings', icon: 'cog', key: 's', sub: 'workspace', view: viewSettings },
  ] },
];

const ALL = NAV.flatMap((g) => g.items);
const byId = (id) => ALL.find((x) => x.id === id) || ALL[0];

const routes = Object.fromEntries(ALL.map((i) => [i.id, i]));

/* ---------- shell ---------- */
const navEl = qs('#nav');
const viewEl = qs('#view');
const sideEl = qs('#side');
const scrimEl = qs('#sidescrim');
let current = 'agents';

function paintNav() {
  const s = store.state;
  navEl.innerHTML = '';
  NAV.forEach((g) => {
    const grp = h('div', { class: 'navgroup' }, h('div', { class: 'navgroup__label' }, g.group));
    g.items.forEach((it) => {
      const link = h('a', {
        class: `navlink${current === it.id ? ' is-active' : ''}`,
        href: `#/${it.id}`,
        'aria-current': current === it.id ? 'page' : null,
      },
      h('span', { html: icon(it.icon) }),
      h('span', {}, it.label),
      it.count ? h('span', { class: 'navlink__count' }, String(it.count(s))) : null);
      grp.appendChild(link);
    });
    navEl.appendChild(grp);
  });
}

function paintFoot() {
  const foot = qs('#sidefoot');
  foot.innerHTML = '';
  foot.appendChild(h('button', {
    class: 'btn btn--block btn--sm', onclick: resetDemo,
    html: `${icon('refresh')}<span>Reset demo data</span>`,
  }));
  foot.appendChild(h('button', {
    class: 'btn btn--block btn--sm', onclick: showAbout,
    html: `${icon('alert')}<span>About this demo</span>`,
  }));
  foot.appendChild(h('button', {
    class: 'btn btn--block btn--sm', onclick: showShortcuts,
    html: `${icon('key')}<span>Keyboard shortcuts</span>`,
  }));
  foot.appendChild(h('div', { class: 'side__ver' }, 'demo build · local data only'));
}

async function resetDemo() {
  const ok = await confirmDialog(
    'This clears every change you have made — connections, guardrail settings, workflow steps, agents you created and the run history — and rebuilds the sample workspace from the seed.',
    { title: 'Reset demo data', okLabel: 'Reset', danger: true },
  );
  if (!ok) return;
  store.reset();
  toast('Demo data reset', 'ok');
  render(current, [], new URLSearchParams());
}

function showAbout() {
  modal({
    title: 'About this demo',
    width: '560px',
    body: `
      <section class="aboutblock">
        <h4>You can actually use it</h4>
        <p>Build workflows, add and remove steps, run them, toggle tools and guardrails, create agents, talk to them. Nothing here is read-only and nothing is a screenshot.</p>
      </section>
      <section class="aboutblock">
        <h4>Your data stays on your machine</h4>
        <p>Everything you enter is saved in this browser's local storage. Nothing is sent to a server, there is no account and no backend. Clear your browser data, or use <strong>Reset demo data</strong>, and it is all gone. It does not sync between browsers or devices.</p>
      </section>
      <section class="aboutblock">
        <h4>The agents are simulated</h4>
        <p>Every reply, tool call, token count and latency figure is generated locally from this app's demo data to show how the product behaves. No AI model is connected and no request leaves your browser. What this demonstrates is the interface, the traces and the guardrail behaviour — not model quality.</p>
      </section>`,
    actions: [{ label: 'Got it', class: 'btn--primary' }],
  });
}

function showShortcuts() {
  modal({
    title: 'Keyboard shortcuts',
    body: `<dl class="kv">
      <dt>Cmd K</dt><dd>Open or close the Agentline Console</dd>
      <dt>Esc</dt><dd>Close the console, a dialog or the mobile navigation</dd>
      <dt>g then a</dt><dd>Agents</dd>
      <dt>g then p</dt><dd>Playground</dd>
      <dt>g then w</dt><dd>Workflows</dd>
      <dt>g then r</dt><dd>Runs</dd>
      <dt>g then t</dt><dd>Tools and connections</dd>
      <dt>g then d</dt><dd>Guardrails</dd>
      <dt>g then s</dt><dd>Settings</dd>
      <dt>?</dt><dd>This list</dd>
    </dl>`,
    actions: [{ label: 'Close', class: 'btn--primary' }],
  });
}

/* ---------- sidebar on small screens ---------- */
function setSide(open) {
  sideEl.classList.toggle('is-open', open);
  scrimEl.hidden = !open;
  qs('#menubtn').setAttribute('aria-expanded', String(open));
}
qs('#menubtn').innerHTML = icon('menu');
qs('#menubtn').addEventListener('click', () => setSide(!sideEl.classList.contains('is-open')));
scrimEl.addEventListener('click', () => setSide(false));
qs('#resetbtn').addEventListener('click', resetDemo);
qs('#demopill').addEventListener('click', showAbout);

/* ---------- rendering ---------- */
const ctxBase = {
  store,
  get state() { return store.state; },
  navigate: (p) => { location.hash = `#/${p}`; },
};

function render(route, params, query) {
  current = route;
  const item = byId(route);
  qs('#crumb').textContent = item.label;
  qs('#crumbsub').textContent = item.sub || 'workspace';
  document.title = `${item.label} — Agentline`;
  paintNav();
  setSide(false);

  const ctx = {
    ...ctxBase,
    route, params: params || [], query: query || new URLSearchParams(),
    refresh: () => render(current, params, query),
  };

  viewEl.innerHTML = '';
  let node;
  try {
    node = item.view.render(ctx);
  } catch (err) {
    node = h('div', { class: 'empty' },
      h('h3', {}, 'This screen could not be drawn'),
      h('p', {}, String(err && err.message ? err.message : err)));
  }
  viewEl.appendChild(node);
  if (route !== lastRoute) { window.scrollTo(0, 0); lastRoute = route; }
}
let lastRoute = null;

const nav = router(routes, render);

/* ---------- console agent ---------- */
const consoleBot = buildConsoleBot(store);
consoleBot.mount(document.body);

/* ---------- go-to shortcuts ---------- */
let pending = false;
let pendingTimer = null;
document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === '?') { e.preventDefault(); showShortcuts(); return; }
  if (pending) {
    const hit = ALL.find((i) => i.key === e.key.toLowerCase());
    pending = false;
    clearTimeout(pendingTimer);
    if (hit) { e.preventDefault(); nav.navigate(hit.id); }
    return;
  }
  if (e.key.toLowerCase() === 'g') {
    pending = true;
    pendingTimer = setTimeout(() => { pending = false; }, 1400);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && sideEl.classList.contains('is-open')) setSide(false);
});

/* ---------- go ---------- */
paintFoot();
nav.go();
