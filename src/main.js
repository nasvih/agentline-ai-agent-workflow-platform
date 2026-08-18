/* ============================================================
   Agentline — boot: store, nav, router, shell wiring, console agent.
   ============================================================ */

import { h, qs, esc, icon, createStore, router, toast, confirmDialog, modal, setRelativeStrings, setDialogStrings } from '../lib/ui.js';
import { initPWA } from '../lib/pwa.js';
import { createI18n } from '../lib/i18n.js';
import { STRINGS } from './strings.js';
import { STORE_KEY, seedState } from './data.js';
import { buildConsoleBot, actionProbes, scopeLabel } from './agent.js';
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

/* ---------- language ----------
   One instance for the whole app. It is built before anything else runs so
   that every module below can import `t` and use it the moment it is
   called. Switching language reloads the page — see lib/i18n.js. */
const i18n = createI18n({ key: 'agentline', dict: STRINGS });
export const t = i18n.t;

/* lib/ui.js and lib/pwa.js are shared between the demo apps and hold no
   strings of their own, so this app hands them its own. */
setRelativeStrings({
  justNow: t('ago.justNow'),
  m: (n) => t('ago.m', { n }),
  h: (n) => t('ago.h', { n }),
  d: (n) => t('ago.d', { n }),
});
setDialogStrings({ confirm: t('common.confirm'), cancel: t('common.cancel') });

const store = createStore(STORE_KEY, seedState);

const NAV = [
  { group: t('nav.group.build'), items: [
    { id: 'agents', label: t('nav.agents'), icon: 'spark', key: 'a', sub: t('nav.sub.agents'), view: viewAgents, count: (s) => s.agents.length },
    { id: 'playground', label: t('nav.playground'), icon: 'bolt', key: 'p', sub: t('nav.sub.playground'), view: viewPlayground },
    { id: 'workflows', label: t('nav.workflows'), icon: 'flow', key: 'w', sub: t('nav.sub.workflows'), view: viewWorkflows, count: (s) => s.workflows.length },
  ] },
  { group: t('nav.group.operate'), items: [
    { id: 'runs', label: t('nav.runs'), icon: 'clock', key: 'r', sub: t('nav.sub.runs'), view: viewRuns, count: (s) => s.runs.length },
    { id: 'tools', label: t('nav.tools'), icon: 'grid', key: 't', sub: t('nav.sub.tools'), view: viewTools, count: (s) => s.tools.filter((x) => x.connected).length },
    { id: 'guardrails', label: t('nav.guardrails'), icon: 'shield', key: 'd', sub: t('nav.sub.guardrails'), view: viewGuardrails, count: (s) => s.guardrails.filter((g) => g.enabled).length },
  ] },
  { group: t('nav.group.workspace'), items: [
    { id: 'settings', label: t('nav.settings'), icon: 'cog', key: 's', sub: t('nav.sub.settings'), view: viewSettings },
  ] },
];

/* the strings that ship in index.html so the shell is readable before the
   module loads; English is the markup default, this repaints it */
qs('#side').setAttribute('aria-label', t('nav.group.workspace'));
qs('#nav').setAttribute('aria-label', t('nav.group.build'));
qs('.side__tag').textContent = t('shell.brandTag');
qs('#menubtn').setAttribute('aria-label', t('shell.openNav'));
qs('#aboutbtn').title = t('shell.aboutTitle');
qs('#aboutbtn').innerHTML = `${esc(t('shell.about'))}<span class="aboutbtn__rest">&nbsp;${esc(t('shell.aboutRest').trim())}</span>`;
qs('#resetbtn').textContent = t('shell.reset');
qs('.appfoot span').textContent = t('shell.footNote');

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
const TONE_LABEL = t('side.tone');
const railLabel = (railed) => (railed ? t('side.expand') : t('side.collapse'));
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
  appName: t('shell.brand'),
  onNote: (msg) => toast(msg),
  strings: {
    install: t('side.install'),
    title: (app) => t('side.installTitle', { app }),
    installed: (app) => t('side.installed', { app }),
    dismissed: t('side.dismissed'),
    iosHow: t('side.iosHow'),
    browserHow: t('side.browserHow'),
  },
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
    title: t('side.newTab', { label }),
    'aria-label': t('side.newTab', { label }),
    html: `${glyph}<span>${esc(label)}</span>`,
  });

  /* "About this demo" is not here any more — it is the button in the
     topbar, where a first-time reader looks for it. */

  /* nasvih.in is the only dark element in the sidebar, so it reads as a link
     out of the product whichever tone the navigation is set to. The repository
     shares its row as an ordinary outline control — one inverted element in
     the footer is the point of the inverted element. */
  foot.appendChild(h('div', { class: 'side__pair' },
    footLink(t('side.site'), ICON_OUT, 'https://www.nasvih.in', 'side__site'),
    footLink(t('side.github'), ICON_CODE, REPO_URL)));

  /* built outside this function so the install control survives the repaint */
  installRow.replaceChildren(footBtn(t('shell.reset'), icon('refresh'), resetDemo));
  if (installBtn) installRow.insertBefore(installBtn, installRow.firstChild);
  foot.appendChild(installRow);

  foot.appendChild(footBtn(t('side.shortcuts'), icon('key'), showShortcuts));
  foot.appendChild(h('div', { class: 'side__ver' }, t('side.ver')));
}

async function resetDemo() {
  const ok = await confirmDialog(t('reset.body'), { title: t('reset.title'), okLabel: t('reset.ok'), danger: true });
  if (!ok) return;
  store.reset();
  /* the seed is deterministic, so the rebuilt runs carry the same ids —
     without this, everything you had already read stays read */
  ui.readNotes = [];
  saveUI();
  toast(t('reset.done'), 'ok');
  render(current, [], new URLSearchParams());
}

function showAbout() {
  modal({
    title: t('about.title'),
    width: '560px',
    body: `
      <section class="aboutblock">
        <h4>${esc(t('about.h1'))}</h4>
        <p>${esc(t('about.p1'))}</p>
      </section>
      <section class="aboutblock">
        <h4>${esc(t('about.h2'))}</h4>
        <ul class="aboutlist">
          ${t('about.li').map((x) => `<li>${esc(x)}</li>`).join('')}
        </ul>
      </section>
      <section class="aboutblock">
        <h4>${esc(t('about.h3'))}</h4>
        <p>${t('about.p3')}</p>
      </section>
      <section class="aboutblock">
        <h4>${esc(t('about.h4'))}</h4>
        <p>${t('about.p4a')}</p>
        <p>${t('about.p4b')}</p>
        <p>${t('about.p4c')}</p>
      </section>
      <section class="aboutblock">
        <h4>${esc(t('about.h5'))}</h4>
        <p>${esc(t('about.p5'))}</p>
        <div class="tablewrap tablewrap--scroll" style="margin-top:10px">
          <table class="data data--grid actiontable"><thead><tr>${t('about.th').map((x) => `<th>${esc(x)}</th>`).join('')}</tr></thead><tbody>
          ${actionProbes().map((p) => `<tr><td>${esc(p.q)}</td><td class="small muted">${esc(scopeLabel()[p.scope] || p.scope)}</td><td class="small muted">${esc(p.does)}</td></tr>`).join('')}
          </tbody></table>
        </div>
        <p style="margin-top:10px">${t('about.p5b')}</p>
      </section>
      <section class="aboutblock">
        <h4>${esc(t('about.h6'))}</h4>
        <p><a class="aboutsrc" href="${REPO_URL}" dir="ltr" target="_blank" rel="noopener noreferrer" aria-label="${esc(t('about.srcLabel'))}">${esc(REPO_URL.replace('https://', ''))}</a></p>
        <p>${esc(t('about.p6'))}</p>
      </section>`,
    actions: [{ label: t('common.gotIt'), class: 'btn--primary' }],
  });
}

function showShortcuts() {
  const row = (k, v) => `<dt dir="ltr">${esc(k)}</dt><dd>${esc(v)}</dd>`;
  modal({
    title: t('shortcuts.title'),
    body: `<dl class="kv">
      ${row('Cmd K', t('shortcuts.cmdk'))}
      ${row('Esc', t('shortcuts.esc'))}
      ${ALL.map((i) => row(t('shortcuts.then', { k: i.key }), i.label)).join('')}
      ${row('?', t('shortcuts.list'))}
    </dl>`,
    actions: [{ label: t('common.close'), class: 'btn--primary' }],
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
  langToggle: () => i18n.toggle(),
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
  qs('#crumbsub').textContent = item.sub || t('common.workspace');
  document.title = t('shell.docTitle', { page: item.label });
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
      h('h3', {}, t('shell.drawFailed')),
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
