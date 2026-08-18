/* Installable app plumbing.

   Registers the service worker, captures the install prompt, and drives an
   "Install app" control that only appears when installing is actually
   possible. On iOS there is no prompt event, so the control explains the
   Share → Add to Home Screen route instead.

   Usage in main.js:
     import { initPWA } from '../lib/pwa.js';
     initPWA({ mount: document.querySelector('.side__foot'), appName: 'Opsboard' });
*/

const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

const isIOS = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const ICON = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3v9M6.5 8.5L10 12l3.5-3.5"/><path d="M3.5 15.5h13"/></svg>';

export function initPWA({ mount, appName = 'this app', swPath = './sw.js', onNote, strings } = {}) {
  /* Shared file, no dictionary of its own: the app passes its wording in
     and the English below is what shows until it does. */
  const S = Object.assign({
    install: 'Install app',
    title: (app) => `Install ${app} on this device`,
    installed: (app) => `${app} installed. It opens in its own window from now on.`,
    dismissed: 'Install dismissed — the button stays here if you change your mind.',
    iosHow: 'On iPhone and iPad: tap Share, then "Add to Home Screen".',
    browserHow: 'Use your browser menu and choose "Install app" or "Add to Home screen".',
  }, strings || {});
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register(swPath).catch(() => {/* offline support is optional */});
    });
  }
  if (!mount || isStandalone()) return null;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn--block btn--sm pwa-install';
  btn.innerHTML = `${ICON}<span>${S.install}</span>`;
  btn.hidden = !isIOS();               // shown at once on iOS, on prompt elsewhere
  btn.title = S.title(appName);
  btn.setAttribute('aria-label', S.title(appName));
  mount.appendChild(btn);

  let deferred = null;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    btn.hidden = false;
  });

  window.addEventListener('appinstalled', () => {
    deferred = null;
    btn.hidden = true;
    if (onNote) onNote(S.installed(appName));
  });

  btn.addEventListener('click', async () => {
    if (deferred) {
      deferred.prompt();
      const { outcome } = await deferred.userChoice;
      if (outcome !== 'accepted' && onNote) onNote(S.dismissed);
      deferred = null;
      return;
    }
    if (onNote) {
      onNote(isIOS() ? S.iosHow : S.browserHow);
    }
  });

  return btn;
}
