/* ============================================================
   Agentline — boot: store, nav, router, shell wiring, console agent.
   ============================================================ */

import { h, qs, esc, icon, createStore, router, toast, confirmDialog, modal } from '../lib/ui.js';
import { initPWA } from '../lib/pwa.js';
import { STORE_KEY, seedState } from './data.js';
import { buildConsoleBot, ACTION_PROBES, SCOPE_LABEL } from './agent.js';
import { selfTest } from './selftest.js';
import { initTopbar } from './topbar.js';
import { onAppRefresh } from './runner.js';

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
const shellEl = qs('#shell');
const scrimEl = qs('#sidescrim');
let current = 'agents';

/* ---------- sidebar preferences (rail + colour), persisted ----------
   Brand yellow is the default navigation. Plain white is the alternative,
   kept one click away in the sidebar footer and remembered per browser. */
const UI_KEY = 'agentline.ui.v1';
const readUI = () => { try { return JSON.parse(localStorage.getItem(UI_KEY)) || {}; } catch (_) { return {}; } };
/* rail + sidebar colour, plus the theme and the notifications that have
   been read. All of it is per browser and survives a reload. */
const ui = { rail: false, amber: true, theme: null, readNotes: [], ...readUI() };
const saveUI = () => { try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch (_) {} };

/* The framed copy of the app inside the phone preview: same code, one
   flag, so it does not offer the frame again from inside the frame. */
const FRAMED = new URLSearchParams(location.search).get('frame') === '1';
if (FRAMED) document.body.classList.add('is-framed');

/* where this application's source is published */
const REPO_URL = 'https://github.com/nasvih/agentline-ai-agent-workflow-platform';

/* five local glyphs, same inline-stroke style as the shared set. The two
   chrome controls on the brand row carry no visible text, so their glyphs have
   to say what they do: a panel whose chevron points at the edge the sidebar is
   about to move to, and a circle half filled for the colour. */
const ICON_RAIL = {
  collapse: '<svg viewBox="0 0 20 20"><rect x="3" y="4" width="14" height="12" rx="2"/><path d="M8.5 4v12"/><path d="M13.6 8.1L11.6 10l2 1.9"/></svg>',
  expand: '<svg viewBox="0 0 20 20"><rect x="3" y="4" width="14" height="12" rx="2"/><path d="M8.5 4v12"/><path d="M11.6 8.1l2 1.9-2 1.9"/></svg>',
};
const ICON_TONE = '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7"/><path d="M10 3a7 7 0 0 1 0 14z" fill="currentColor" stroke="none"/></svg>';
/* the colour control names no colour anywhere — the glyph carries it, and
   aria-pressed is what reports whether the yellow tone is on */
const TONE_LABEL = 'Sidebar colour';
const railLabel = (railed) => (railed ? 'Expand sidebar' : 'Collapse sidebar');
const ICON_OUT = '<svg viewBox="0 0 20 20"><path d="M11.5 3.5H16v4.5"/><path d="M16 3.5L9.5 10"/><path d="M14 11.5V15a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 15V7.5A1.5 1.5 0 0 1 5 6h3.5"/></svg>';
const ICON_CODE = '<svg viewBox="0 0 20 20"><path d="M7.1 5.8L2.9 10l4.2 4.2"/><path d="M12.9 5.8L17.1 10l-4.2 4.2"/><path d="M11.4 4.1L8.6 15.9"/></svg>';

function paintNav() {
  const s = store.state;
  navEl.innerHTML = '';
  NAV.forEach((g) => {
    const grp = h('div', { class: 'navgroup' }, h('div', { class: 'navgroup__label' }, g.group));
    g.items.forEach((it) => {
      /* the icon is a direct child, not wrapped in a span: rail mode hides
         every span inside a navlink, and the glyph has to survive that */
      const count = it.count ? `<span class="navlink__count">${it.count(s)}</span>` : '';
      grp.appendChild(h('a', {
        class: `navlink${current === it.id ? ' is-active' : ''}`,
        href: `#/${it.id}`,
        'aria-current': current === it.id ? 'page' : null,
        title: ui.rail ? it.label : null,
        'aria-label': ui.rail ? it.label : null,
        html: `${icon(it.icon)}<span>${esc(it.label)}</span>${count}`,
      }));
    });
    navEl.appendChild(grp);
  });
}

/* The two chrome controls sit on the brand row, right of the app name, and are
   icon-only — the kit clips their span and sizes them to 30x30. They are built
   once, since the brand row is not repainted. */
const brandBtns = qs('#brandbtns');
const railBtn = h('button', {
  class: 'btn btn--sm', type: 'button', dataset: { chrome: 'rail' },
  'aria-pressed': 'false', 'aria-controls': 'side',
  title: railLabel(false), 'aria-label': railLabel(false),
  html: `${ICON_RAIL.collapse}<span>${railLabel(false)}</span>`,
  onclick: () => { ui.rail = !ui.rail; saveUI(); applyUI(); },
});
const toneBtn = h('button', {
  class: 'btn btn--sm', type: 'button', dataset: { chrome: 'tone' },
  'aria-pressed': 'false', 'aria-controls': 'side',
  title: TONE_LABEL, 'aria-label': TONE_LABEL,
  html: `${ICON_TONE}<span>${esc(TONE_LABEL)}</span>`,
  onclick: () => { ui.amber = !ui.amber; saveUI(); applyUI(); },
});
brandBtns.append(railBtn, toneBtn);

function applyUI() {
  shellEl.classList.toggle('is-rail', ui.rail);
  if (ui.amber) sideEl.setAttribute('data-tone', 'amber');
  else sideEl.removeAttribute('data-tone');
  const label = railLabel(ui.rail);
  railBtn.setAttribute('aria-pressed', String(ui.rail));
  railBtn.setAttribute('aria-label', label);
  railBtn.title = label;
  railBtn.innerHTML = `${ui.rail ? ICON_RAIL.expand : ICON_RAIL.collapse}<span>${label}</span>`;
  toneBtn.setAttribute('aria-pressed', String(ui.amber));
  paintNav();
  paintFoot();
}

/* ---------- installable app ----------
   The install control shares the last footer row with "Reset demo data". That
   row keeps its own element across repaints, so the prompt the control
   captured and its listeners survive a sidebar redraw. initPWA appends, so the
   control is moved to the head of the row; while it is hidden it leaves the
   flex row entirely and Reset spans the row on its own. */
const installRow = h('div', { class: 'side__pair' });
const installBtn = initPWA({
  mount: installRow,
  appName: 'Agentline',
  onNote: (msg) => toast(msg),
});

function paintFoot() {
  const foot = qs('#sidefoot');
  foot.innerHTML = '';

  const footBtn = (label, glyph, onclick, extra) => h('button', Object.assign({
    class: 'btn btn--block btn--sm', type: 'button', title: label, 'aria-label': label,
    onclick, html: `${glyph}<span>${esc(label)}</span>`,
  }, extra || {}));

  const footLink = (label, glyph, href, cls) => h('a', {
    class: `btn btn--block btn--sm${cls ? ` ${cls}` : ''}`,
    href, target: '_blank', rel: 'noopener noreferrer',
    title: `${label} — opens in a new tab`,
    'aria-label': `${label} — opens in a new tab`,
    html: `${glyph}<span>${esc(label)}</span>`,
  });

  /* "About this demo" is not here any more — it is the button in the
     topbar, where a first-time reader looks for it. */

  /* nasvih.in is the only dark element in the sidebar, so it reads as a link
     out of the product whichever tone the navigation is set to. The repository
     shares its row as an ordinary outline control — one inverted element in
     the footer is the point of the inverted element. */
  foot.appendChild(h('div', { class: 'side__pair' },
    footLink('nasvih.in', ICON_OUT, 'https://www.nasvih.in', 'side__site'),
    footLink('GitHub', ICON_CODE, REPO_URL)));

  /* built outside this function so the install control survives the repaint */
  installRow.replaceChildren(footBtn('Reset demo data', icon('refresh'), resetDemo));
  if (installBtn) installRow.insertBefore(installBtn, installRow.firstChild);
  foot.appendChild(installRow);

  foot.appendChild(footBtn('Keyboard shortcuts', icon('key'), showShortcuts));
  foot.appendChild(h('div', { class: 'side__ver' }, 'demo build · local data only'));
}

async function resetDemo() {
  const ok = await confirmDialog(
    'This clears every change you have made — connections, guardrail settings, workflow steps, agents you created and the run history — and rebuilds the sample workspace from the seed.',
    { title: 'Reset demo data', okLabel: 'Reset', danger: true },
  );
  if (!ok) return;
  store.reset();
  /* the seed is deterministic, so the rebuilt runs carry the same ids —
     without this, everything you had already read stays read */
  ui.readNotes = [];
  saveUI();
  toast('Demo data reset', 'ok');
  render(current, [], new URLSearchParams());
}

function showAbout() {
  modal({
    title: 'About this demo',
    width: '560px',
    body: `
      <section class="aboutblock">
        <h4>What this is</h4>
        <p>Agentline is a workspace for putting agents to work. You define an agent, give it the tools it is allowed to use and the guardrails it has to obey, then run it on its own or as a step inside a workflow. Every run is written down as a trace you can open afterwards and read line by line.</p>
      </section>
      <section class="aboutblock">
        <h4>Where it helps a business</h4>
        <ul class="aboutlist">
          <li>Repetitive desk work — triaging a ticket queue, reading invoices, drafting the weekly report — gets a first pass before anyone opens it.</li>
          <li>Every run leaves a trace, so an answer can be explained: which tool was called, on what, and what came back.</li>
          <li>Guardrails are configuration, not code. Redaction, allowed topics, escalation to a human and a cost ceiling are set by whoever owns the process.</li>
          <li>Connections are explicit. An agent cannot touch a system nobody granted it.</li>
          <li>When something goes wrong, the run history shows which step failed and why, instead of one blank error.</li>
        </ul>
      </section>
      <section class="aboutblock">
        <h4>How it would work for real</h4>
        <p>The same interface, with a real model provider behind the agents, real connections to the systems named on <strong>Tools</strong>, and the run history in a database rather than this browser. This demo simulates only that model layer, so the product itself can be judged: the interface, the traces, the guardrail behaviour and the shape of a workflow are real design decisions. The answers are not model output.</p>
      </section>
      <section class="aboutblock">
        <h4>How this demo works</h4>
        <p><strong>You can actually use it.</strong> Build workflows, add and remove steps, run them, toggle tools and guardrails, create agents, talk to them. Nothing here is read-only and nothing is a screenshot.</p>
        <p><strong>Your data stays on your machine.</strong> Everything you enter is saved in this browser's local storage. There is no account and no backend. Clear your browser data, or use <strong>Reset demo data</strong>, and it is all gone.</p>
        <p><strong>The agents are simulated.</strong> Every reply, tool call, token count and latency figure is generated locally from this app's demo data. No model is connected and no request leaves your browser.</p>
      </section>
      <section class="aboutblock">
        <h4>The agents do things, not only answer</h4>
        <p>Ask in plain language. The agent shows what it understood and what it would touch, and applies it only when you press the button — then reports what changed, before and after. These are the exact phrases that work, and what each one does:</p>
        <div class="tablewrap tablewrap--scroll" style="margin-top:10px">
          <table class="data data--grid actiontable"><thead><tr><th>Say this</th><th>Where</th><th>And it will</th></tr></thead><tbody>
          ${ACTION_PROBES.map((p) => `<tr><td>${esc(p.q)}</td><td class="small muted">${esc(SCOPE_LABEL[p.scope] || p.scope)}</td><td class="small muted">${esc(p.does)}</td></tr>`).join('')}
          </tbody></table>
        </div>
        <p style="margin-top:10px">Every one of those writes a real record into this browser and a real trace you can open in <strong>Runs</strong>. The trace, the token counts and the latency figures are simulated locally — there is no model behind any of it.</p>
      </section>
      <section class="aboutblock">
        <h4>The source</h4>
        <p><a class="aboutsrc" href="${REPO_URL}" target="_blank" rel="noopener noreferrer" aria-label="Source on GitHub — opens in a new tab">${esc(REPO_URL.replace('https://', ''))}</a></p>
        <p>The source is published so it can be read, run and evaluated — it is not open source, and copying, modifying, redistributing or using it in your own work needs the author's written permission.</p>
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
qs('#aboutbtn').addEventListener('click', showAbout);

/* ---------- topbar: notifications, device preview, dark mode ----------
   Phone mode replaces the desktop app with an iframe of the same app at
   390px. The outer copy is emptied first, so the Playground chat is
   never mounted twice at once. */
let phoneMode = false;
const topbar = initTopbar({
  mount: qs('#topbartools'),
  store,
  prefs: ui,
  savePrefs: saveUI,
  framed: FRAMED,
  navigate: (p) => { location.hash = `#/${p}`; },
  onPhoneMode: (on) => {
    phoneMode = on;
    shellEl.hidden = on;
    if (on) {
      viewEl.innerHTML = '';
      if (consoleBot && consoleBot.open) consoleBot.toggle(false);
    } else {
      render(current, [], new URLSearchParams());
    }
  },
});

/* ---------- rendering ---------- */
const ctxBase = {
  store,
  get state() { return store.state; },
  navigate: (p) => { location.hash = `#/${p}`; },
};

function render(route, params, query) {
  current = route;
  if (phoneMode) return;              // the frame owns the screen
  const item = byId(route);
  qs('#crumb').textContent = item.label;
  qs('#crumbsub').textContent = item.sub || 'workspace';
  document.title = `${item.label} — Agentline`;
  paintNav();
  setSide(false);

  /* One chat affordance at a time. The Playground is a product screen with
     its own docked composer, so the floating console launcher steps aside
     there — Cmd K still reaches the console from anywhere. */
  const onPlayground = route === 'playground';
  document.body.classList.toggle('is-playground', onPlayground);
  if (onPlayground && consoleBot && consoleBot.open) consoleBot.toggle(false);

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
  if (topbar) topbar.refresh();
  if (route !== lastRoute) { window.scrollTo(0, 0); lastRoute = route; }
}
let lastRoute = null;

const nav = router(routes, render);

/* ---------- when an agent changes something ----------
   Actions mutate the store and then ask the app to catch up. The one
   screen that must not be redrawn is the Playground: redrawing it would
   throw away the conversation the action button was pressed in. */
onAppRefresh(() => {
  if (topbar) topbar.refresh();
  if (phoneMode) return;
  if (current === 'playground') { paintNav(); return; }
  nav.go();                            // re-reads the hash, so params survive
});

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
applyUI();
nav.go();

/* Handle for the suggestion routing self-test:  await agentline.selfTest()
   Read only — it routes questions without composing answers or writing runs. */
window.agentline = {
  store,
  selfTest: (opts) => selfTest(store, opts),
};
