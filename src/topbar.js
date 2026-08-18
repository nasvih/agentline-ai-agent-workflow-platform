/* ============================================================
   Agentline — the three topbar controls.

     1. Notifications — read out of the live workspace, not a canned
        list: failed runs, escalations waiting for a person, guardrail
        blocks, runs over the cost ceiling and disconnected tools.
        Read state persists per browser.
     2. Device preview — renders the real application inside a phone
        frame using an iframe, so the actual breakpoints apply rather
        than a scaled screenshot of the desktop layout.
     3. Dark mode — `data-theme="dark"` on <html>, persisted, and
        following the operating system on a first visit.

   All three are icon-only, labelled for assistive tech, and reachable
   from the keyboard.
   ============================================================ */

import { h, ago } from '../lib/ui.js';
import { guardById, agentById, rupees, guardName, agentName, toolName } from './data.js';
import { t } from './main.js';
import { dataLabel } from './strings.js';

const G = {
  bell: '<svg viewBox="0 0 20 20"><path d="M6 8a4 4 0 0 1 8 0c0 4 1.5 5 1.5 5h-11S6 12 6 8z"/><path d="M8.5 16a1.6 1.6 0 0 0 3 0"/></svg>',
  phone: '<svg viewBox="0 0 20 20"><rect x="6" y="2.5" width="8" height="15" rx="2"/><path d="M9 15.2h2"/></svg>',
  desktop: '<svg viewBox="0 0 20 20"><rect x="2.5" y="4" width="15" height="9.5" rx="1.6"/><path d="M7 17h6M10 13.5V17"/></svg>',
  moon: '<svg viewBox="0 0 20 20"><path d="M16.2 11.7A6.7 6.7 0 0 1 8.3 3.8a6.7 6.7 0 1 0 7.9 7.9z"/></svg>',
  sun: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="3.4"/><path d="M10 2.4v2M10 15.6v2M17.6 10h-2M4.4 10h-2M15.4 4.6l-1.4 1.4M6 14l-1.4 1.4M15.4 15.4L14 14M6 6L4.6 4.6"/></svg>',
  check: '<svg viewBox="0 0 20 20"><path d="M4 10.5l4 4 8-9"/></svg>',
  close: '<svg viewBox="0 0 20 20"><path d="M5 5l10 10M15 5L5 15"/></svg>',
};

/* ============================================================
   1. Notifications
   ============================================================ */

/* Everything in this list is derived from the store on every open, so a
   run you make now shows up without a reload, and a tool you reconnect
   drops off. Ids are stable, which is what makes "read" stick. */
export function buildNotes(s) {
  const out = [];
  const cap = guardById(s, 'cost');
  const nameOf = (id) => agentName(agentById(s, id)) || id;

  (s.runs || []).forEach((r) => {
    if (r.status === 'failed') {
      const bad = (r.trace || []).find((ev) => ev.status === 'failed');
      out.push({
        id: `fail:${r.id}`, kind: t('topbar.kind.failed'), tone: 'bad', at: r.startedAt, href: `runs/${r.id}`,
        title: `${nameOf(r.agentId)} — ${r.id}`,
        detail: bad ? `${traceLabel(bad.label)} · ${traceDetail(bad.detail) || t('topbar.noDetail')}` : t('topbar.stoppedEarly'),
      });
    }
    if (r.status === 'escalated') {
      out.push({
        id: `esc:${r.id}`, kind: t('topbar.kind.waiting'), tone: 'warn', at: r.startedAt, href: `runs/${r.id}`,
        title: t('topbar.handedOver', { agent: nameOf(r.agentId) }),
        detail: t('topbar.nobodyPicked', { queue: queueName(guardById(s, 'escalate')) || t('topbar.handoverQueue') }),
      });
    }
    const blocked = (r.guardrails || []).filter((g) => g.verdict === 'blocked');
    if (blocked.length || r.status === 'blocked') {
      out.push({
        id: `block:${r.id}`, kind: t('topbar.kind.block'), tone: 'info', at: r.startedAt, href: `runs/${r.id}`,
        title: t('topbar.guardStopped', { names: blocked.map((g) => guardName(guardById(s, g.id)) || g.id).join(t('common.listSep')) || t('topbar.aGuardrail'), run: r.id }),
        detail: t('topbar.cutShort', { agent: nameOf(r.agentId) }),
      });
    }
    if (cap && cap.enabled && r.costPaise > cap.limitPaise) {
      out.push({
        id: `cost:${r.id}`, kind: t('topbar.kind.cost'), tone: 'warn', at: r.startedAt, href: `runs/${r.id}`,
        title: t('topbar.runCost', { run: r.id, amount: rupees(r.costPaise) }),
        detail: t('topbar.ceilingIs', { amount: rupees(cap.limitPaise) }),
      });
    }
  });

  (s.tickets || []).filter((x) => x.status === 'escalated').forEach((x) => {
    out.push({
      id: `tick:${x.id}`, kind: t('topbar.kind.waiting'), tone: 'warn', at: null, href: 'guardrails',
      title: t('topbar.ticketEsc', { id: x.id, subject: ticketSubject(x.subject) }),
      detail: `${x.customer} · ${x.escalationRef || t('topbar.noRef')} · ${x.assignee}`,
    });
  });

  (s.tools || []).filter((x) => !x.connected).forEach((x) => {
    const users = (s.agents || []).filter((a) => a.tools.includes(x.id));
    out.push({
      id: `tool:${x.id}`, kind: t('topbar.kind.conn'), tone: 'bad', at: null, href: 'tools',
      title: t('topbar.toolDown', { name: toolName(x) }),
      detail: users.length ? t('topbar.cannotUse', { names: users.map((a) => agentName(a)).join(t('common.listSep')) }) : t('topbar.noDependents'),
    });
  });

  return out
    .sort((a, b) => (b.at ? new Date(b.at).getTime() : Infinity) - (a.at ? new Date(a.at).getTime() : Infinity))
    .slice(0, 40);
}

const TONE = { bad: 'pill--bad', warn: 'pill--warn', info: 'pill--info', ok: 'pill--ok' };

/* the record-side labels this file reads straight out of the store */
const traceLabel = (v) => dataLabel(t, 'traceLabel', v);
const traceDetail = (v) => dataLabel(t, 'traceDetail', v);
const ticketSubject = (v) => dataLabel(t, 'subject', v);
const queueName = (g) => dataLabel(t, 'queue', (g || {}).queue);

function notifications({ store, prefs, savePrefs, navigate }) {
  if (!Array.isArray(prefs.readNotes)) prefs.readNotes = [];

  const badge = h('span', { class: 'notif__badge', hidden: true });
  const btn = h('button', {
    class: 'btn btn--ghost btn--icon', type: 'button', id: 'notifbtn',
    'aria-label': t('topbar.notifications'), title: t('topbar.notifications'),
    'aria-expanded': 'false', 'aria-haspopup': 'dialog',
    html: G.bell,
  });
  btn.appendChild(badge);

  const panel = h('div', { class: 'notifpanel', role: 'dialog', 'aria-label': t('topbar.notifications'), hidden: true });
  const wrap = h('div', { class: 'notifwrap' }, btn, panel);

  let open = false;

  const unreadOf = (list) => list.filter((n) => !prefs.readNotes.includes(n.id));

  function markRead(ids) {
    const set = new Set(prefs.readNotes);
    ids.forEach((i) => set.add(i));
    /* keep only ids that still exist, so the list cannot grow forever */
    const live = new Set(buildNotes(store.state).map((n) => n.id));
    prefs.readNotes = [...set].filter((i) => live.has(i));
    savePrefs();
    paint();
  }

  function paintBadge() {
    const n = unreadOf(buildNotes(store.state)).length;
    badge.hidden = n === 0;
    badge.textContent = n > 9 ? '9+' : String(n);
    btn.setAttribute('aria-label', n ? t('topbar.unreadN', { n }) : t('topbar.noneUnread'));
    btn.title = btn.getAttribute('aria-label');
  }

  function paint() {
    paintBadge();
    if (!open) return;
    const list = buildNotes(store.state);
    const unread = unreadOf(list);

    panel.innerHTML = '';
    panel.appendChild(h('div', { class: 'notifpanel__head' },
      h('h3', {}, t('topbar.notifications')),
      h('span', { class: 'label' }, unread.length ? t('topbar.unreadCount', { n: unread.length }) : t('topbar.allRead')),
      unread.length
        ? h('button', {
          class: 'btn btn--sm', type: 'button',
          onclick: () => markRead(list.map((n) => n.id)),
          html: `${G.check}<span>${t('topbar.markAllRead')}</span>`,
        })
        : null,
      h('button', {
        class: 'btn btn--ghost btn--icon', type: 'button', 'aria-label': t('topbar.closeNotifs'), title: t('topbar.closeNotifs'),
        onclick: () => toggle(false), html: G.close,
      })));

    const body = h('div', { class: 'notifpanel__body' });
    if (!list.length) {
      body.appendChild(h('div', { class: 'notifempty' },
        h('h4', {}, t('topbar.emptyTitle')),
        h('p', {}, t('topbar.emptyBody')),
        h('p', { class: 'small faint' }, t('topbar.emptyHint'))));
    } else {
      list.forEach((n) => {
        const isRead = prefs.readNotes.includes(n.id);
        const row = h('div', { class: `note${isRead ? ' is-read' : ''}` },
          h('button', {
            class: 'note__main', type: 'button',
            onclick: () => { markRead([n.id]); toggle(false); navigate(n.href); },
          },
          h('span', { class: 'note__top' },
            h('span', { class: `pill ${TONE[n.tone] || ''}` }, n.kind),
            h('span', { class: 'note__when mono' }, n.at ? ago(n.at) : t('common.now'))),
          h('span', { class: 'note__title' }, n.title),
          h('span', { class: 'note__detail' }, n.detail)),
          isRead
            ? h('span', { class: 'note__read label' }, t('topbar.readMark'))
            : h('button', {
              class: 'btn btn--ghost btn--icon note__mark', type: 'button',
              'aria-label': t('topbar.markOne', { title: n.title }), title: t('topbar.markShort'),
              onclick: () => markRead([n.id]), html: G.check,
            }));
        body.appendChild(row);
      });
    }
    panel.appendChild(body);
    panel.appendChild(h('div', { class: 'notifpanel__foot' },
      t('topbar.foot')));
  }

  function toggle(force) {
    open = force === undefined ? !open : force;
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open) { paint(); panel.querySelector('button') && panel.querySelector('button').focus(); }
  }

  btn.addEventListener('click', () => toggle());
  /* Close on a click outside. Marking one item read repaints the list,
     so by the time this runs the clicked node may already be detached —
     that is not an outside click and must not close the panel. */
  document.addEventListener('click', (e) => {
    if (!open || !e.target.isConnected || wrap.contains(e.target)) return;
    toggle(false);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) { toggle(false); btn.focus(); } });

  paintBadge();
  return { el: wrap, refresh: paint };
}

/* ============================================================
   2. Device preview
   ============================================================ */
function devicePreview({ onChange }) {
  const mk = (name, glyph, label) => h('button', {
    class: 'btn btn--ghost btn--icon', type: 'button', dataset: { dev: name },
    'aria-label': label, title: label, 'aria-pressed': String(name === 'desktop'),
    html: glyph,
  });
  const phoneBtn = mk('phone', G.phone, t('topbar.phone'));
  const deskBtn = mk('desktop', G.desktop, t('topbar.desktop'));
  const group = h('div', { class: 'devgroup', role: 'group', 'aria-label': t('topbar.devicePreview') }, deskBtn, phoneBtn);

  let frame = null;
  let mode = 'desktop';

  function fit() {
    if (!frame) return;
    const stage = frame.querySelector('.devframe__stage');
    const slot = frame.querySelector('.devframe__slot');
    const phone = frame.querySelector('.devframe__phone');
    const scale = Math.min(1, (stage.clientWidth - 16) / 414, (stage.clientHeight - 16) / 892);
    phone.style.transform = `scale(${scale})`;
    slot.style.width = `${414 * scale}px`;
    slot.style.height = `${892 * scale}px`;
  }

  function enter() {
    const hash = location.hash || '#/agents';
    frame = h('div', { class: 'devframe' },
      h('div', { class: 'devframe__bar' },
        h('div', { style: 'min-width:0' },
          h('div', { class: 'devframe__name' }, t('shell.brand')),
          h('div', { class: 'devframe__sub label', dir: 'auto' }, t('topbar.frameSub'))),
        h('button', {
          class: 'btn btn--dark', type: 'button', onclick: () => set('desktop'),
          html: `${G.desktop}<span>${t('topbar.backToDesktop')}</span>`,
        })),
      h('div', { class: 'devframe__stage' },
        h('div', { class: 'devframe__slot' },
          h('div', { class: 'devframe__phone' },
            h('iframe', {
              class: 'devframe__view', title: t('topbar.frameTitle'),
              src: `./index.html?frame=1${hash}`,
            })))),
      h('p', { class: 'devframe__note' }, t('topbar.frameNote')));
    document.body.appendChild(frame);
    window.addEventListener('resize', fit);
    fit();
  }

  function leave() {
    window.removeEventListener('resize', fit);
    if (frame) frame.remove();
    frame = null;
  }

  function set(next) {
    if (next === mode) return;
    mode = next;
    phoneBtn.setAttribute('aria-pressed', String(mode === 'phone'));
    deskBtn.setAttribute('aria-pressed', String(mode === 'desktop'));
    document.body.classList.toggle('is-phoneframe', mode === 'phone');
    if (mode === 'phone') enter(); else leave();
    onChange(mode === 'phone');
  }

  phoneBtn.addEventListener('click', () => set('phone'));
  deskBtn.addEventListener('click', () => set('desktop'));
  return { el: group };
}

/* ============================================================
   3. Dark mode
   ============================================================ */
function theme({ prefs, savePrefs }) {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const btn = h('button', {
    class: 'btn btn--ghost btn--icon', type: 'button', id: 'themebtn',
    'aria-label': t('topbar.darkMode'), title: t('topbar.darkMode'), 'aria-pressed': 'false', html: G.moon,
  });

  const current = () => (prefs.theme === 'dark' ? 'dark' : 'light');

  function apply() {
    const cur = current();
    document.documentElement.setAttribute('data-theme', cur);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', cur === 'dark' ? '#141517' : '#EAC81C');
    btn.innerHTML = cur === 'dark' ? G.sun : G.moon;
    btn.setAttribute('aria-pressed', String(cur === 'dark'));
    const label = cur === 'dark' ? t('topbar.toLight') : t('topbar.toDark');
    btn.setAttribute('aria-label', label);
    btn.title = label;
  }

  btn.addEventListener('click', () => {
    prefs.theme = current() === 'dark' ? 'light' : 'dark';
    savePrefs();
    apply();
  });
  /* only while the reader has not chosen for themselves */
  media.addEventListener('change', () => { if (prefs.theme !== 'dark' && prefs.theme !== 'light') apply(); });

  apply();
  return { el: btn, apply };
}

/* ============================================================
   mount
   ============================================================ */
export function initTopbar({ mount, store, prefs, savePrefs, navigate, onPhoneMode, framed, langToggle }) {
  const notif = notifications({ store, prefs, savePrefs, navigate });
  const th = theme({ prefs, savePrefs });
  mount.appendChild(notif.el);
  /* language, then theme, then the device frame — the two that change how
     the whole page reads sit together, ahead of the preview toy */
  if (langToggle) mount.appendChild(langToggle());
  mount.appendChild(th.el);
  if (!framed) {
    /* the framed copy must not offer the frame again */
    mount.appendChild(devicePreview({ onChange: onPhoneMode }).el);
  }
  return { refresh: notif.refresh };
}
