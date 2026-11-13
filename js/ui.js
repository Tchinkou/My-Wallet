/**
 * My Wallet — utilitaires d'interface : formatage, icônes, feuilles modales,
 * confirmations, notifications.
 */

/* ------------------------------------------------------------ formatage */

export const CURRENCIES = {
  DZD: { label: 'Dinar algérien', symbol: 'DA' },
  EUR: { label: 'Euro', symbol: '€' },
  USD: { label: 'Dollar américain', symbol: '$' },
  GBP: { label: 'Livre sterling', symbol: '£' },
  CAD: { label: 'Dollar canadien', symbol: '$ CA' },
  CHF: { label: 'Franc suisse', symbol: 'CHF' },
  MAD: { label: 'Dirham marocain', symbol: 'DH' },
  TND: { label: 'Dinar tunisien', symbol: 'DT' },
  SAR: { label: 'Riyal saoudien', symbol: 'SAR' },
  AED: { label: 'Dirham émirati', symbol: 'AED' },
  TRY: { label: 'Livre turque', symbol: '₺' },
};

const fmtCache = new Map();
function nf(decimals) {
  if (!fmtCache.has(decimals)) {
    fmtCache.set(decimals, new Intl.NumberFormat('fr-FR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }));
  }
  return fmtCache.get(decimals);
}

export const view = { currency: 'DZD', masked: false };

/** Montant en centimes → « 10 000 DA ». Masqué si le mode discrétion est actif. */
export function money(cents, { sign = false, force = false, currency = null } = {}) {
  const cur = currency || view.currency;
  const sym = CURRENCIES[cur]?.symbol || cur;
  if (view.masked && !force) return `••••• ${sym}`;
  const abs = Math.abs(cents);
  const decimals = abs % 100 === 0 ? 0 : 2;
  const s = nf(decimals).format(abs / 100);
  const prefix = cents < 0 ? '−' : sign && cents > 0 ? '+' : '';
  return `${prefix}${s} ${sym}`;
}

/** Version courte pour les axes : 12,5 k */
export function moneyShort(cents) {
  if (view.masked) return '•••';
  const v = Math.abs(cents / 100);
  const s = cents < 0 ? '−' : '';
  if (v >= 1e6) return `${s}${nf(1).format(v / 1e6).replace(/,0$/, '')} M`;
  if (v >= 1e3) return `${s}${nf(1).format(v / 1e3).replace(/,0$/, '')} k`;
  return `${s}${nf(0).format(v)}`;
}

export function pct(x) {
  if (x === null || x === undefined || !isFinite(x)) return '—';
  return `${nf(0).format(x * 100)} %`;
}

const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const MONTHS_SHORT = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

export function monthLabel(key, short = false) {
  const [y, m] = key.split('-').map(Number);
  return short ? MONTHS_SHORT[m - 1] : `${MONTHS[m - 1]} ${y}`;
}

export function dateLabel(iso, { withYear = true } = {}) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS_SHORT[m - 1]}${withYear ? ' ' + y : ''}`;
}

export function dayHeader(iso, todayIso) {
  if (iso === todayIso) return "Aujourd'hui";
  const t = new Date(todayIso); t.setDate(t.getDate() - 1);
  const y = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  if (iso === y) return 'Hier';
  const date = new Date(iso + 'T12:00:00');
  const wd = date.toLocaleDateString('fr-FR', { weekday: 'long' });
  return `${wd.charAt(0).toUpperCase() + wd.slice(1)} ${dateLabel(iso)}`;
}

/** Échappement HTML de tout texte saisi par l'utilisateur. */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* --------------------------------------------------------------- icônes */

const P = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  wallet: '<rect x="3" y="6" width="18" height="14" rx="3"/><path d="M3 10h18M7 6V4.5A1.5 1.5 0 0 1 8.5 3H17"/><circle cx="16.5" cy="15" r="1.2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2A6.5 6.5 0 0 1 21.5 20"/>',
  list: '<path d="M9 6h12M9 12h12M9 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
  settings: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2.5"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M2 12s3.6-7 10-7c2 0 3.7.7 5.1 1.6M22 12s-3.6 7-10 7c-2 0-3.7-.7-5.1-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2M3 3l18 18"/>',
  expense: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  income: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  transfer: '<path d="M4 8h15l-4-4M20 16H5l4 4"/>',
  loan: '<path d="M7 17 17 7M9 7h8v8"/>',
  debt: '<path d="M17 7 7 17M7 9v8h8"/>',
  repay: '<path d="M3 12a9 9 0 1 0 2.6-6.4L3 8"/><path d="M3 3v5h5"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 16V5M7 10l5-5 5 5M5 20h14"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  filter: '<path d="M4 5h16l-6 7.5V19l-4 1v-7.5z"/>',
  fingerprint: '<path d="M12 11v2.5a9 9 0 0 1-2 5.7"/><path d="M8.2 9.5A4 4 0 0 1 16 11v2a13 13 0 0 1-1 5"/><path d="M5.3 7.5A8 8 0 0 1 20 11v1.5"/><path d="M4.2 11a8 8 0 0 0 .3 4.5M8 13a12 12 0 0 1-1.6 5.5M18.6 16.5a17 17 0 0 0 .3-2"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  back: '<path d="m15 6-6 6 6 6"/>',
  shield: '<path d="M12 3 4.5 6v6c0 4.5 3.2 7.8 7.5 9 4.3-1.2 7.5-4.5 7.5-9V6z"/><path d="m9 12 2 2 4-4"/>',
  tag: '<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  phone: '<rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  coins: '<circle cx="9" cy="9" r="6"/><path d="M15.5 9.3A6 6 0 1 1 9.3 15.5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4.5M12 17.5v.5"/>',
  cash: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 9v.01M18 15v.01"/>',
  bank: '<path d="M3 10 12 4l9 6M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18"/>',
  piggy: '<path d="M5 11a7 6 0 0 1 12-3.5l3-1-.6 3.4A6 6 0 0 1 20 12v2h-2l-1.5 3.5H14V16h-4v1.5H7.5L6 14a5 5 0 0 1-1-3z"/><circle cx="15" cy="10.5" r=".6"/>',
  box: '<path d="M3 8l9-5 9 5v8l-9 5-9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  refresh: '<path d="M20 11A8 8 0 0 0 5.6 6.6L3 9M4 13a8 8 0 0 0 14.4 4.4L21 15"/><path d="M3 4v5h5M21 20v-5h-5"/>',
  share: '<circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="m8.2 10.8 7.6-3.6M8.2 13.2l7.6 3.6"/>',
  euro: '<path d="M18 7.5A7 7 0 1 0 18 16.5"/><path d="M4 10.5h9M4 13.5h9"/>',
  file: '<path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
};

export function icon(name, cls = '') {
  return `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
}

export const OP_ICON = {
  expense: 'expense', income: 'income', transfer: 'transfer',
  loan: 'loan', loan_repay: 'repay', debt: 'debt', debt_repay: 'repay', euro_in: 'euro', euro_out: 'euro',
};
export const ACCOUNT_ICON = { cash: 'cash', bank: 'bank', savings: 'piggy', other: 'box' };

/* ---------------------------------------------------------- notifications */

export function toast(message, { type = 'info', action = null, duration = 3200 } = {}) {
  const host = document.getElementById('toasts');
  // Une seule action « Annuler » visible à la fois.
  if (action) host.querySelectorAll('.toast.has-action').forEach((t) => t.remove());
  while (host.children.length >= 2) host.firstElementChild.remove();
  const el = document.createElement('div');
  el.className = `toast toast-${type}${action ? ' has-action' : ''}`;
  el.setAttribute('role', 'status');
  const span = document.createElement('span');
  span.textContent = message;
  el.appendChild(span);
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.label;
    b.onclick = () => { action.run(); el.remove(); };
    el.appendChild(b);
  }
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, action ? 8000 : duration);
}

/* -------------------------------------------------------- feuilles modales */

const sheetStack = [];

/**
 * Ouvre une feuille modale glissant du bas.
 * @param {object} o { title, body (html), onMount(el), wide }
 * @returns {{el:HTMLElement, close:Function}}
 */
export function openSheet({ title, body, onMount, className = '' }) {
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  backdrop.innerHTML = `
    <section class="sheet ${className}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="sheet-grip"></div>
      <header class="sheet-head">
        <h2>${esc(title)}</h2>
        <button class="icon-btn" data-close aria-label="Fermer">${icon('x')}</button>
      </header>
      <div class="sheet-body">${body}</div>
    </section>`;
  document.getElementById('sheets').appendChild(backdrop);
  const el = backdrop.querySelector('.sheet');
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    backdrop.classList.remove('open');
    const i = sheetStack.indexOf(api);
    if (i >= 0) sheetStack.splice(i, 1);
    setTimeout(() => backdrop.remove(), 250);
  };
  const api = { el, close };
  sheetStack.push(api);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  el.querySelector('[data-close]').addEventListener('click', close);
  requestAnimationFrame(() => backdrop.classList.add('open'));
  onMount?.(el, close);
  return api;
}

export function closeAllSheets() {
  for (const s of [...sheetStack]) s.close();
}

export function topSheetOpen() { return sheetStack.length > 0; }
export function closeTopSheet() { sheetStack[sheetStack.length - 1]?.close(); }

/** Confirmation. Retourne une promesse booléenne. */
export function confirmDialog({ title, message, confirmLabel = 'Confirmer', danger = false, requireText = null }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const sheet = openSheet({
      title,
      className: 'sheet-dialog',
      body: `
        <p class="dialog-msg">${esc(message)}</p>
        ${requireText ? `<label class="field"><span>Tapez <b>${esc(requireText)}</b> pour confirmer</span>
          <input type="text" autocomplete="off" autocapitalize="characters" data-req></label>` : ''}
        <div class="btn-row">
          <button class="btn btn-ghost" data-no>Annuler</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-yes ${requireText ? 'disabled' : ''}>${esc(confirmLabel)}</button>
        </div>`,
      onMount(el, close) {
        const yes = el.querySelector('[data-yes]');
        el.querySelector('[data-no]').onclick = () => { finish(false); close(); };
        yes.onclick = () => { finish(true); close(); };
        const req = el.querySelector('[data-req]');
        if (req) req.oninput = () => { yes.disabled = req.value.trim().toUpperCase() !== requireText; };
      },
    });
    const obs = new MutationObserver(() => {
      if (!sheet.el.isConnected) { obs.disconnect(); finish(false); }
    });
    obs.observe(document.getElementById('sheets'), { childList: true });
  });
}

/** Demande un mot de passe. Retourne la chaîne ou null. */
export function askPassword({ title, message, confirm = false, label = 'Mot de passe', submitLabel = 'Valider' }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const sheet = openSheet({
      title,
      className: 'sheet-dialog',
      body: `
        <form class="form" data-pw autocomplete="off">
          ${message ? `<p class="dialog-msg">${esc(message)}</p>` : ''}
          <label class="field"><span>${esc(label)}</span>
            <input type="password" name="p1" required minlength="${confirm ? 8 : 1}" autocomplete="new-password"></label>
          ${confirm ? `<label class="field"><span>Confirmer le mot de passe</span>
            <input type="password" name="p2" required autocomplete="new-password"></label>` : ''}
          <p class="form-error" data-err></p>
          <div class="btn-row">
            <button type="button" class="btn btn-ghost" data-no>Annuler</button>
            <button type="submit" class="btn btn-primary">${esc(submitLabel)}</button>
          </div>
        </form>`,
      onMount(el, close) {
        const f = el.querySelector('form');
        el.querySelector('[data-no]').onclick = () => { finish(null); close(); };
        f.onsubmit = (e) => {
          e.preventDefault();
          const p1 = f.p1.value;
          if (confirm) {
            if (p1.length < 8) { el.querySelector('[data-err]').textContent = 'Au moins 8 caractères.'; return; }
            if (p1 !== f.p2.value) { el.querySelector('[data-err]').textContent = 'Les mots de passe ne correspondent pas.'; return; }
          }
          finish(p1); close();
        };
        setTimeout(() => f.p1.focus(), 250);
      },
    });
    const obs = new MutationObserver(() => {
      if (!sheet.el.isConnected) { obs.disconnect(); finish(null); }
    });
    obs.observe(document.getElementById('sheets'), { childList: true });
  });
}

/** Petit indicateur de travail (dérivation de clé, chiffrement). */
export function busy(on, label = 'Chiffrement…') {
  const el = document.getElementById('busy');
  el.querySelector('span').textContent = label;
  el.hidden = !on;
}
