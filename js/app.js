/**
 * My Wallet — application principale : démarrage, verrouillage, navigation,
 * écrans et formulaires.
 *
 * Flux de données : chaque action modifie S.state (journal des opérations),
 * qui est chiffré puis écrit dans IndexedDB, puis l'écran est recalculé
 * entièrement depuis calculations.js. Aucune valeur dérivée n'est stockée.
 */

import {
  OP_TYPES, ACCOUNT_TYPES, STATUS_LABELS, toISODate, monthKey, addMonths, parseAmount, amountToInput,
  computeSummary, computeBalances, computeLoans, groupByPerson, expensesByCategory, monthlySeries,
  availableSeries, filterOps, validateOp, computeEuro, validateEuroItem, cascadeIds, opsForAccount, pctChange, normalizeName, byDateDesc,
} from './calculations.js';
import { db, uid, emptyState, migrateState, requestPersistence } from './database.js';
import {
  createVaultKey, unwrapWithPin, wrapWithPin, importDataKey, encryptState, decryptState,
  biometricSupport, enrollBiometric, unlockWithBiometric, lockoutDelay, WrongSecretError,
} from './security.js';
import { createBackup, readBackup, opsToCSV, downloadBlob } from './backup.js';
import {
  view, money, pct, monthLabel, dateLabel, dayHeader, esc, icon, OP_ICON, ACCOUNT_ICON, CURRENCIES,
  toast, openSheet, closeAllSheets, confirmDialog, askPassword, busy,
} from './ui.js';
import { lineChart, barChart, meterList, attachCharts, resetCharts } from './charts.js';

/* ================================================================ état */

const S = {
  state: null,        // données déchiffrées (en mémoire uniquement si déverrouillé)
  key: null,          // CryptoKey AES-GCM non exportable
  raw: null,          // DEK brute (pour enrôler la biométrie / changer le PIN)
  unlocked: false,
  prefs: { theme: 'dark', masked: false },
  filters: {},
  historyLimit: 150,
  peopleTab: 'loan',
  euroTab: 'receive',
  euroShowDone: false,
  showSettled: false,
  revealSavings: false,
  installPrompt: null,
  lastActivity: Date.now(),
  hiddenAt: null,
  pauseAutoLock: false,
};

const $app = () => document.getElementById('app');
const today = () => toISODate(new Date());

/* ============================================================ démarrage */

async function boot() {
  try {
    S.prefs = { ...S.prefs, ...((await db.get('prefs')) || {}) };
  } catch (e) {
    $app().innerHTML = `<div class="fatal"><h1>Stockage indisponible</h1><p>${esc(e.message)}</p>
      <p>Désactivez la navigation privée ou autorisez le stockage pour ce site.</p></div>`;
    hideSplash();
    return;
  }
  applyTheme();
  view.masked = !!S.prefs.masked;
  setupGlobalListeners();
  registerServiceWorker();
  const keymeta = await db.get('keymeta');
  if (!keymeta) renderWelcome();
  else await renderLock({ autoBio: true });
  hideSplash();
}

function hideSplash() {
  const s = document.getElementById('splash');
  if (!s) return;
  s.classList.add('hide');
  setTimeout(() => s.remove(), 400);
}

function applyTheme() {
  const root = document.documentElement;
  if (S.prefs.theme === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', S.prefs.theme);
  const dark = S.prefs.theme === 'dark' || (S.prefs.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]').setAttribute('content', dark ? '#0b0b0d' : '#f4f4f2');
}

async function savePrefs() { await db.set('prefs', S.prefs); }

/* ============================================================ stockage */

let saveChain = Promise.resolve();
function persist() {
  const snapshot = S.state;
  const key = S.key;
  saveChain = saveChain
    .then(async () => { await db.set('vault', await encryptState(key, snapshot)); })
    .catch((e) => { console.error(e); toast("Erreur d'enregistrement : " + e.message, { type: 'error' }); });
  return saveChain;
}

async function commit(mutate, message) {
  mutate(S.state);
  await persist();
  render();
  if (message) toast(message, { type: 'success' });
}

/* ============================================================ verrouillage */

async function unlockWithRaw(raw) {
  const key = await importDataKey(raw);
  const blob = await db.get('vault');
  const state = blob ? migrateState(await decryptState(key, blob)) : emptyState();
  S.raw = raw;
  S.key = key;
  S.state = state;
  S.unlocked = true;
  S.lastActivity = Date.now();
  view.currency = state.settings.currency;
  await db.set('lockout', { failures: 0, until: 0 });
  requestPersistence();
  renderShell();
}

function lock(reason) {
  if (!S.unlocked) return;
  S.raw?.fill(0);
  S.raw = null;
  S.key = null;
  S.state = null;
  S.unlocked = false;
  S.revealSavings = false;
  closeAllSheets();
  resetCharts();
  renderLock({ autoBio: false, reason });
}

function setupGlobalListeners() {
  const touch = () => { S.lastActivity = Date.now(); };
  ['pointerdown', 'keydown', 'scroll', 'touchstart'].forEach((ev) => document.addEventListener(ev, touch, { passive: true, capture: true }));
  setInterval(() => {
    if (!S.unlocked || S.pauseAutoLock) return;
    const min = S.state.settings.autoLockMinutes;
    const limit = Math.max(1, min) * 60_000;
    if (Date.now() - S.lastActivity > limit) lock('Verrouillé après inactivité.');
  }, 10_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { S.hiddenAt = Date.now(); return; }
    if (!S.unlocked || S.pauseAutoLock || !S.hiddenAt) return;
    const min = S.state.settings.autoLockMinutes;
    if (Date.now() - S.hiddenAt >= min * 60_000) lock('Verrouillé en arrière-plan.');
    S.hiddenAt = null;
  });
  window.addEventListener('hashchange', () => { if (S.unlocked) render(); });
  document.addEventListener('click', onAction);
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    S.installPrompt = e;
    if (S.unlocked && route() === 'install') render();
  });
  window.addEventListener('appinstalled', () => {
    S.installPrompt = null;
    toast('My Wallet est installée sur votre appareil.', { type: 'success' });
    if (S.unlocked && route() === 'install') render();
  });
}

/** Suspend le verrouillage automatique pendant une action système (fichier, empreinte). */
async function withAutoLockPaused(fn) {
  S.pauseAutoLock = true;
  try { return await fn(); } finally { S.pauseAutoLock = false; S.lastActivity = Date.now(); S.hiddenAt = null; }
}

/* ---------------------------------------------------------- clavier PIN */

function keypadHTML({ title, subtitle, bio = false, logo = true }) {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'ok'];
  return `
    <div class="pin-screen">
      ${logo ? `<div class="brand-mark">${icon('wallet')}</div>` : ''}
      <h1 class="pin-title">${esc(title)}</h1>
      <p class="pin-sub" data-msg>${esc(subtitle)}</p>
      <div class="pin-dots" data-dots aria-live="polite"></div>
      <div class="keypad">
        ${keys.map((k) => k === 'del'
          ? `<button class="key key-fn" data-k="del" aria-label="Effacer">${icon('back')}</button>`
          : k === 'ok'
            ? `<button class="key key-ok" data-k="ok" aria-label="Valider">${icon('check')}</button>`
            : `<button class="key" data-k="${k}">${k}</button>`).join('')}
      </div>
      ${bio ? `<button class="btn btn-ghost bio-btn" data-bio>${icon('fingerprint')} Utiliser l'empreinte</button>` : ''}
    </div>`;
}

function bindKeypad(root, { onSubmit, min = 4, max = 12 }) {
  let value = '';
  let busyFlag = false;
  const dots = root.querySelector('[data-dots]');
  const msg = root.querySelector('[data-msg]');
  const draw = () => {
    const n = Math.max(min, value.length);
    dots.innerHTML = Array.from({ length: n }, (_, i) => `<i class="${i < value.length ? 'on' : ''}"></i>`).join('');
  };
  const api = {
    clear() { value = ''; draw(); },
    error(text) {
      msg.textContent = text;
      msg.classList.add('err');
      dots.classList.remove('shake');
      void dots.offsetWidth;
      dots.classList.add('shake');
      navigator.vibrate?.(80);
      api.clear();
    },
    message(text) { msg.textContent = text; msg.classList.remove('err'); },
    setBusy(b) { busyFlag = b; root.classList.toggle('is-busy', b); },
  };
  const press = async (k) => {
    if (busyFlag) return;
    if (k === 'del') value = value.slice(0, -1);
    else if (k === 'ok') {
      if (value.length < min) { api.error(`Le code doit contenir au moins ${min} chiffres.`); return; }
      const v = value;
      await onSubmit(v, api);
      return;
    } else if (/^\d$/.test(k) && value.length < max) value += k;
    draw();
  };
  root.querySelectorAll('[data-k]').forEach((b) => b.addEventListener('click', () => press(b.dataset.k)));
  const onKey = (e) => {
    if (!root.isConnected) { document.removeEventListener('keydown', onKey); return; }
    if (document.querySelector('.sheet-backdrop')) return;
    if (/^\d$/.test(e.key)) press(e.key);
    else if (e.key === 'Backspace') press('del');
    else if (e.key === 'Enter') press('ok');
  };
  document.addEventListener('keydown', onKey);
  draw();
  return api;
}

/* ----------------------------------------------------------- écran verrou */

let lockTimer = null;

async function renderLock({ autoBio = false, reason = '' } = {}) {
  const bio = await db.get('bio');
  $app().innerHTML = `<div class="screen screen-lock">${keypadHTML({
    title: 'My Wallet',
    subtitle: reason || 'Entrez votre code PIN',
    bio: !!bio,
  })}</div>`;
  const root = $app().querySelector('.pin-screen');
  const keymeta = await db.get('keymeta');
  const pad = bindKeypad(root, {
    async onSubmit(pin, k) {
      const lo = (await db.get('lockout')) || { failures: 0, until: 0 };
      if (lo.until > Date.now()) { k.error(waitMessage(lo.until)); return; }
      k.setBusy(true);
      k.message('Vérification…');
      try {
        const raw = await unwrapWithPin(pin, keymeta);
        clearInterval(lockTimer);
        await unlockWithRaw(raw);
      } catch (e) {
        k.setBusy(false);
        if (e instanceof WrongSecretError) {
          lo.failures += 1;
          const delay = lockoutDelay(lo.failures);
          lo.until = delay ? Date.now() + delay : 0;
          await db.set('lockout', lo);
          k.error(delay ? waitMessage(lo.until) : `Code incorrect (${lo.failures} essai${lo.failures > 1 ? 's' : ''}).`);
          if (delay) startLockCountdown(k, lo.until);
        } else {
          k.error('Erreur : ' + e.message);
        }
      }
    },
  });
  const lo = (await db.get('lockout')) || { until: 0 };
  if (lo.until > Date.now()) startLockCountdown(pad, lo.until);

  const bioBtn = root.querySelector('[data-bio]');
  const tryBio = async () => {
    try {
      const raw = await withAutoLockPaused(() => unlockWithBiometric(bio));
      clearInterval(lockTimer);
      await unlockWithRaw(raw);
    } catch (e) {
      if (e?.name !== 'NotAllowedError' && e?.name !== 'AbortError') pad.message("Empreinte indisponible. Utilisez votre PIN.");
    }
  };
  if (bioBtn) {
    bioBtn.addEventListener('click', tryBio);
    if (autoBio && document.visibilityState === 'visible') setTimeout(tryBio, 300);
  }
}

function waitMessage(until) {
  const s = Math.ceil((until - Date.now()) / 1000);
  return `Trop d'essais. Réessayez dans ${s >= 60 ? Math.ceil(s / 60) + ' min' : s + ' s'}.`;
}

function startLockCountdown(pad, until) {
  clearInterval(lockTimer);
  lockTimer = setInterval(() => {
    if (Date.now() >= until) { clearInterval(lockTimer); pad.message('Entrez votre code PIN'); return; }
    pad.message(waitMessage(until));
  }, 1000);
}

/* ============================================================ première utilisation */

const onboarding = { pin: null, restored: null };

function renderWelcome() {
  onboarding.pin = null;
  onboarding.restored = null;
  $app().innerHTML = `
  <div class="screen screen-welcome">
    <div class="welcome-top">
      <div class="brand-mark big">${icon('wallet')}</div>
      <h1>My Wallet</h1>
      <p class="lead">Votre portefeuille personnel, simple et privé.</p>
    </div>
    <ul class="promise">
      <li>${icon('shield')}<div><b>100 % sur votre téléphone</b><span>Aucun compte, aucun serveur, aucune synchronisation.</span></div></li>
      <li>${icon('lock')}<div><b>Données chiffrées</b><span>AES-256 avec une clé protégée par votre code PIN.</span></div></li>
      <li>${icon('phone')}<div><b>Fonctionne hors ligne</b><span>Installable comme une application Android.</span></div></li>
    </ul>
    <div class="welcome-actions">
      <button class="btn btn-primary btn-lg" id="start">Créer mon portefeuille</button>
      <button class="btn btn-ghost" id="restore">${icon('upload')} Restaurer une sauvegarde</button>
    </div>
  </div>`;
  document.getElementById('start').onclick = () => renderCreatePin();
  document.getElementById('restore').onclick = () => pickBackupFile(async (state) => {
    onboarding.restored = state;
    toast('Sauvegarde vérifiée. Choisissez maintenant votre code PIN.', { type: 'success' });
    renderCreatePin();
  });
}

function renderCreatePin() {
  $app().innerHTML = `<div class="screen screen-lock">${keypadHTML({
    title: 'Créez votre code PIN',
    subtitle: 'De 4 à 12 chiffres. 6 chiffres ou plus recommandés.',
  })}<button class="btn btn-ghost back-link" id="back">${icon('back')} Retour</button></div>`;
  document.getElementById('back').onclick = renderWelcome;
  bindKeypad($app().querySelector('.pin-screen'), {
    onSubmit(pin, k) {
      if (/^(\d)\1+$/.test(pin) || '01234567890123'.includes(pin) || '9876543210'.includes(pin)) {
        k.error('Code trop simple. Évitez les suites et répétitions.');
        return;
      }
      onboarding.pin = pin;
      renderConfirmPin();
    },
  });
}

function renderConfirmPin() {
  $app().innerHTML = `<div class="screen screen-lock">${keypadHTML({
    title: 'Confirmez le code',
    subtitle: 'Saisissez le même code une seconde fois.',
  })}<button class="btn btn-ghost back-link" id="back">${icon('back')} Recommencer</button></div>`;
  document.getElementById('back').onclick = renderCreatePin;
  bindKeypad($app().querySelector('.pin-screen'), {
    async onSubmit(pin, k) {
      if (pin !== onboarding.pin) { k.error('Les codes ne correspondent pas.'); return; }
      if (onboarding.restored) await finishOnboarding(onboarding.restored);
      else renderSetup();
    },
  });
}

function renderSetup() {
  const opts = Object.entries(CURRENCIES).map(([c, v]) => `<option value="${c}" ${c === 'DZD' ? 'selected' : ''}>${c} — ${esc(v.label)}</option>`).join('');
  $app().innerHTML = `
  <div class="screen screen-setup">
    <h1>Votre argent aujourd'hui</h1>
    <p class="lead">Indiquez ce que vous possédez actuellement. Vous pourrez ajouter, renommer ou supprimer des comptes plus tard.</p>
    <form class="form" id="setup" autocomplete="off">
      <label class="field"><span>Devise</span><select name="currency">${opts}</select></label>
      <div class="setup-acc">
        <div class="setup-ic">${icon('cash')}</div>
        <label class="field grow"><span>Espèces (argent liquide)</span><input name="cash" inputmode="decimal" placeholder="0"></label>
      </div>
      <div class="setup-acc">
        <div class="setup-ic">${icon('bank')}</div>
        <label class="field grow"><span>Compte courant</span><input name="bank" inputmode="decimal" placeholder="0"></label>
      </div>
      <div class="setup-acc">
        <div class="setup-ic">${icon('piggy')}</div>
        <label class="field grow"><span>Compte épargne <small>(masqué par défaut)</small></span><input name="savings" inputmode="decimal" placeholder="0"></label>
      </div>
      <div id="extra"></div>
      <button type="button" class="btn btn-ghost" id="addRes">${icon('plus')} Ajouter une autre réserve</button>
      <p class="form-error" id="err"></p>
      <button class="btn btn-primary btn-lg" type="submit">Terminer</button>
    </form>
  </div>`;
  let n = 0;
  document.getElementById('addRes').onclick = () => {
    n++;
    const div = document.createElement('div');
    div.className = 'setup-extra';
    div.innerHTML = `<label class="field grow"><span>Nom de la réserve</span><input name="xname${n}" placeholder="Ex. : Coffre, Devises…" maxlength="40"></label>
      <label class="field"><span>Montant</span><input name="xamt${n}" inputmode="decimal" placeholder="0"></label>`;
    document.getElementById('extra').appendChild(div);
  };
  document.getElementById('setup').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const err = document.getElementById('err');
    const read = (v) => (String(v).trim() === '' ? 0 : parseAmount(v));
    const state = emptyState();
    state.settings.currency = f.currency.value;
    const d = today();
    const rows = [
      ['Espèces', 'cash', read(f.cash.value), false],
      ['Compte courant', 'bank', read(f.bank.value), false],
      ['Épargne', 'savings', read(f.savings.value), true],
    ];
    for (let i = 1; i <= n; i++) {
      const name = f[`xname${i}`].value.trim();
      if (name) rows.push([name, 'other', read(f[`xamt${i}`].value), false]);
    }
    if (rows.some((r) => Number.isNaN(r[2]))) { err.textContent = 'Un des montants est invalide.'; return; }
    state.accounts = rows.map(([name, type, initial, hidden]) => ({ id: uid(), name, type, initial, hidden, createdAt: d }));
    await finishOnboarding(state);
  };
}

async function finishOnboarding(state) {
  busy(true, 'Création du coffre chiffré…');
  try {
    const { raw, keymeta } = await createVaultKey(onboarding.pin);
    const key = await importDataKey(raw);
    await db.set('vault', await encryptState(key, state));
    await db.set('keymeta', keymeta);
    await db.set('lockout', { failures: 0, until: 0 });
    onboarding.pin = null;
    onboarding.restored = null;
    location.hash = '#home';
    await unlockWithRaw(raw);
    const bio = await biometricSupport();
    if (bio.ok) {
      toast("Astuce : activez l'empreinte digitale dans Réglages › Sécurité.", { duration: 6000 });
    }
  } catch (e) {
    toast('Erreur : ' + e.message, { type: 'error' });
  } finally {
    busy(false);
  }
}

/* ============================================================ coquille */

const TABS = [
  ['home', 'home', 'Accueil'],
  ['accounts', 'wallet', 'Comptes'],
  ['add', 'plus', ''],
  ['people', 'users', 'Prêts'],
  ['history', 'list', 'Historique'],
];

function route() {
  const r = (location.hash || '#home').slice(1);
  return ['home', 'accounts', 'people', 'history', 'settings', 'install', 'security', 'backup', 'categories', 'euro'].includes(r) ? r : 'home';
}

function renderShell() {
  $app().innerHTML = `
  <div class="shell">
    <header class="topbar">
      <div class="topbar-title" id="title"></div>
      <div class="topbar-actions">
        <button class="icon-btn" data-action="toggle-mask" aria-label="Masquer les montants" id="maskBtn"></button>
        <button class="icon-btn" data-action="lock" aria-label="Verrouiller">${icon('lock')}</button>
        <a class="icon-btn" href="#settings" aria-label="Réglages">${icon('settings')}</a>
      </div>
    </header>
    <main id="view" class="view"></main>
    <nav class="tabbar" aria-label="Navigation principale">
      ${TABS.map(([r, ic, label]) => r === 'add'
        ? `<button class="tab-add" data-action="add-menu" aria-label="Ajouter une opération">${icon('plus')}</button>`
        : `<a class="tab" href="#${r}" data-tab="${r}">${icon(ic)}<span>${label}</span></a>`).join('')}
    </nav>
  </div>`;
  render();
}

const TITLES = {
  home: 'My Wallet', accounts: 'Mes comptes', people: 'Prêts et dettes', history: 'Historique',
  euro: 'Euro', settings: 'Réglages', install: "Installer l'application", security: 'Sécurité', backup: 'Sauvegarde', categories: 'Catégories',
};

function render() {
  if (!S.unlocked) return;
  const r = route();
  const v = document.getElementById('view');
  if (!v) return;
  resetCharts();
  document.getElementById('title').innerHTML = r === 'home'
    ? `<span class="logo-dot">${icon('wallet')}</span>My Wallet`
    : (['settings', 'install', 'security', 'backup', 'categories'].includes(r) && r !== 'settings'
      ? `<a class="back" href="#settings" aria-label="Retour">${icon('back')}</a>${TITLES[r]}`
      : TITLES[r]);
  document.getElementById('maskBtn').innerHTML = icon(view.masked ? 'eyeOff' : 'eye');
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === r));
  const renderers = {
    home: viewHome, accounts: viewAccounts, people: viewPeople, history: viewHistory, settings: viewSettings,
    euro: viewEuro, install: viewInstall, security: viewSecurity, backup: viewBackup, categories: viewCategories,
  };
  const sameRoute = v.dataset.route === r;
  v.innerHTML = renderers[r]();
  v.dataset.route = r;
  if (!sameRoute) window.scrollTo(0, 0);
  attachCharts(v);
  afterRender[r]?.(v);
}

const afterRender = {};

/* ============================================================ helpers */

const accById = (id) => S.state.accounts.find((a) => a.id === id);
const catById = (id) => S.state.categories.find((c) => c.id === id);
const opById = (id) => S.state.ops.find((o) => o.id === id);

function opFlow(op, accountId = null) {
  if (op.type === 'transfer') {
    if (accountId) return op.toAccountId === accountId ? 'in' : 'out';
    return 'neutral';
  }
  if (op.type === 'income' || op.type === 'loan_repay') return 'in';
  if (op.type === 'debt') return op.accountId ? 'in' : 'neutral';
  return 'out';
}

function opTitle(op) {
  switch (op.type) {
    case 'expense':
    case 'income': return catById(op.categoryId)?.name || OP_TYPES[op.type].label;
    case 'transfer': return `${accById(op.accountId)?.name || '?'} → ${accById(op.toAccountId)?.name || '?'}`;
    case 'loan': return `Prêt à ${op.person}`;
    case 'debt': return `Dette envers ${op.person}`;
    case 'loan_repay': return `Remboursement de ${opById(op.refId)?.person || '?'}`;
    case 'debt_repay': return `Remboursement à ${opById(op.refId)?.person || '?'}`;
    default: return OP_TYPES[op.type]?.label || '';
  }
}

function opSub(op) {
  const parts = [OP_TYPES[op.type].short];
  if (op.type !== 'transfer' && op.accountId) parts.push(accById(op.accountId)?.name);
  if (op.type === 'debt' && !op.accountId) parts.push('non encaissée');
  if (op.note) parts.push(op.note);
  return parts.filter(Boolean).join(' · ');
}

function opRow(op, { accountId = null } = {}) {
  const flow = opFlow(op, accountId);
  const signed = flow === 'in' ? op.amount : flow === 'out' ? -op.amount : op.amount;
  return `
  <button class="op-row" data-action="op-detail" data-id="${op.id}">
    <span class="op-ic op-${op.type}">${icon(OP_ICON[op.type])}</span>
    <span class="op-main"><span class="op-title">${esc(opTitle(op))}</span><span class="op-sub">${esc(opSub(op))}</span></span>
    <span class="op-amt amt-${flow}">${money(signed, { sign: flow === 'in' })}</span>
  </button>`;
}

function opsGrouped(ops, opts) {
  const t = today();
  let html = '';
  let cur = null;
  for (const op of ops) {
    if (op.date !== cur) {
      if (cur) html += '</div>';
      cur = op.date;
      html += `<div class="day-group"><div class="day-head">${esc(dayHeader(op.date, t))}</div>`;
    }
    html += opRow(op, opts);
  }
  if (cur) html += '</div>';
  return html;
}

function isSavingsHidden(acc) { return acc.type === 'savings' && acc.hidden && !S.revealSavings; }

function hiddenMoney(cents, hidden) {
  return hidden ? `<span class="masked">••••• ${esc(CURRENCIES[view.currency]?.symbol || '')}</span>` : money(cents);
}

function deltaBadge(cur, prev, { goodWhenUp = true } = {}) {
  const p = pctChange(cur, prev);
  if (p === null) return '<span class="delta">— vs mois dernier</span>';
  const up = p > 0;
  const good = p === 0 ? null : up === goodWhenUp;
  return `<span class="delta ${good === null ? '' : good ? 'good' : 'bad'}">${up ? '▲' : p < 0 ? '▼' : '='} ${pct(Math.abs(p))} vs ${esc(monthLabel(addMonths(monthKey(today()), -1), true))}</span>`;
}

/* ============================================================ accueil */

function viewHome() {
  const st = S.state;
  const t = today();
  const s = computeSummary(st, t);
  const eu = computeEuro(st);
  const daysSinceBackup = st.meta.lastBackupAt ? (Date.now() - st.meta.lastBackupAt) / 86_400_000 : Infinity;
  const remind = st.settings.backupReminderDays > 0 && st.ops.length > 0 && daysSinceBackup > st.settings.backupReminderDays;
  const cats = expensesByCategory(st, s.month);
  const firstDay = st.accounts.reduce((m, a) => (a.createdAt && a.createdAt < m ? a.createdAt : m), t);
  const firstOp = st.ops.reduce((m, o) => (o.date < m ? o.date : m), firstDay);
  // Courbe à partir du premier jour utile (au plus 30 jours), au moins 2 points.
  const series = availableSeries(st, t, 30, { spendableOnly: true }).filter((p, i, a) => p.date >= firstOp || i === a.length - 2);
  const months = monthlySeries(st, t, 6);
  const recent = [...st.ops].sort(byDateDesc).slice(0, 5);

  return `
  ${remind ? `<a class="banner banner-warn" href="#backup">${icon('alert')}<span>${
    st.meta.lastBackupAt ? `Dernière sauvegarde il y a ${Math.floor(daysSinceBackup)} jours.` : 'Aucune sauvegarde effectuée.'
  } Pensez à sauvegarder vos données.</span>${icon('chevron')}</a>` : ''}

  <section class="hero">
    <a href="#accounts" class="hero-main">
      <div class="hero-label">Argent utilisable</div>
      <div class="hero-value" data-testid="spendable">${money(s.spendable)}</div>
      <div class="hero-sub">Espèces et comptes courants, hors épargne</div>
    </a>
    <div class="hero-grid">
      <a href="#people" data-action="people-tab" data-tab="loan" class="hero-cell">
        <span class="lbl">${icon('loan')} On me doit</span>
        <b class="gold" data-testid="receivables">${money(s.receivables)}</b>
      </a>
      <a href="#people" data-action="people-tab" data-tab="debt" class="hero-cell">
        <span class="lbl">${icon('debt')} Je dois</span>
        <b class="neg" data-testid="debts">${money(s.debts)}</b>
      </a>
      <a href="#euro" class="hero-cell hero-wide">
        <span class="lbl">${icon('euro')} Euro</span>
        <b data-testid="euro-balance">${money(eu.balance, { currency: 'EUR' })}</b>
        <small>À recevoir ${money(eu.toReceive, { currency: 'EUR' })} · À payer ${money(eu.toPay, { currency: 'EUR' })}</small>
      </a>
    </div>
  </section>

  <section class="quick">
    <button data-action="new-op" data-type="expense"><span class="q-ic q-exp">${icon('expense')}</span>Dépense</button>
    <button data-action="new-op" data-type="income"><span class="q-ic q-inc">${icon('income')}</span>Revenu</button>
    <button data-action="new-op" data-type="loan"><span class="q-ic q-loan">${icon('loan')}</span>Prêt</button>
    <button data-action="new-op" data-type="repay"><span class="q-ic q-rep">${icon('repay')}</span>Rembour&shy;sement</button>
  </section>

  <section class="card">
    <header class="card-head"><h3>${esc(monthLabel(s.month).replace(/^./, (c) => c.toUpperCase()))}</h3></header>
    <div class="stats">
      <div class="stat"><span>Revenus</span><b class="pos">${money(s.incomeMonth)}</b>${deltaBadge(s.incomeMonth, s.incomePrev)}</div>
      <div class="stat"><span>Dépenses</span><b class="neg">${money(s.expenseMonth)}</b>${deltaBadge(s.expenseMonth, s.expensePrev, { goodWhenUp: false })}</div>
      <div class="stat"><span>Épargne du mois</span><b class="${s.savings >= 0 ? 'pos' : 'neg'}">${money(s.savings, { sign: true })}</b>
        <span class="delta">Taux d'épargne ${pct(s.savingsRate)}</span></div>
      <div class="stat"><span>Dépenses semaine</span><b>${money(s.expenseWeek)}</b><span class="delta">depuis lundi</span></div>
    </div>
  </section>

  <section class="card">
    <header class="card-head"><h3>Argent utilisable</h3>
      <span class="chip ${s.spendableChangeMonth >= 0 ? 'chip-pos' : 'chip-neg'}">${money(s.spendableChangeMonth, { sign: true })} ce mois</span></header>
    ${series.length >= 2 ? lineChart(series, { label: 'Utilisable' })
      : '<p class="empty-sm">La courbe apparaîtra après quelques jours d\u2019utilisation.</p>'}
  </section>

  <section class="card">
    <header class="card-head"><h3>Dépenses par catégorie</h3><span class="muted">${esc(monthLabel(s.month, true))}</span></header>
    ${meterList(cats, s.expenseMonth)}
  </section>

  <section class="card">
    <header class="card-head"><h3>Revenus vs dépenses</h3><span class="muted">6 mois</span></header>
    ${barChart(months)}
  </section>

  <details class="card details">
    <summary><h3>Tous les indicateurs</h3>${icon('chevron')}</summary>
    <dl class="kv">
      <dt>Argent utilisable</dt><dd>${money(s.spendable)}</dd>
      <dt>Total des créances</dt><dd>${money(s.receivables)}</dd>
      <dt>Total des dettes</dt><dd>${money(s.debts)}</dd>
      <dt>Revenus du mois</dt><dd>${money(s.incomeMonth)}</dd>
      <dt>Dépenses du mois</dt><dd>${money(s.expenseMonth)}</dd>
      <dt>Épargne mensuelle</dt><dd>${money(s.savings, { sign: true })}</dd>
      <dt>Taux d'épargne</dt><dd>${pct(s.savingsRate)}</dd>
      <dt>Remboursements reçus (total)</dt><dd>${money(s.repaidReceived)}</dd>
      <dt>Remboursements effectués (total)</dt><dd>${money(s.repaidMade)}</dd>
    </dl>
    <p class="hint">${icon('info')} Le total (disponible, patrimoine net) est visible dans Comptes.</p>
  </details>

  <section class="card">
    <header class="card-head"><h3>Dernières opérations</h3><a href="#history" class="link">Tout voir</a></header>
    ${recent.length ? `<div class="op-list">${recent.map((o) => opRow(o)).join('')}</div>`
      : '<p class="empty-sm">Aucune opération pour le moment. Utilisez les boutons ci-dessus pour commencer.</p>'}
  </section>`;
}

/* ============================================================ comptes */

function viewAccounts() {
  const st = S.state;
  const bal = computeBalances(st);
  const s = computeSummary(st, today());
  const anyHidden = st.accounts.some(isSavingsHidden);
  const hasHiddenSavings = st.accounts.some((a) => a.type === 'savings' && a.hidden);
  return `
  <section class="total-card">
    <span>Argent disponible</span>
    <b data-testid="available">${anyHidden ? `${money(s.spendable)} <small class="muted">+ épargne</small>` : money(s.available)}</b>
    <div class="split">
      <span>Utilisable <b>${money(s.spendable)}</b></span>
      <span>Épargne <b>${hiddenMoney(s.reserved, anyHidden)}</b></span>
      <span>Patrimoine net <b data-testid="net">${hiddenMoney(s.net, anyHidden)}</b></span>
      ${hasHiddenSavings ? `<button class="mini-btn" data-action="reveal-savings">${icon(S.revealSavings ? 'eyeOff' : 'eye')}${S.revealSavings ? 'Cacher' : 'Afficher'}</button>` : ''}
    </div>
  </section>
  <div class="btn-row">
    <button class="btn btn-soft" data-action="new-op" data-type="transfer">${icon('transfer')} Transfert</button>
    <button class="btn btn-soft" data-action="account-form">${icon('plus')} Nouveau compte</button>
  </div>
  <section class="list-card">
    ${st.accounts.length ? st.accounts.map((a) => `
      <button class="acc-row" data-action="account-detail" data-id="${a.id}">
        <span class="acc-ic acc-${a.type}">${icon(ACCOUNT_ICON[a.type] || 'box')}</span>
        <span class="op-main"><span class="op-title">${esc(a.name)}</span><span class="op-sub">${esc(ACCOUNT_TYPES[a.type])}${a.hidden && a.type === 'savings' ? ' · masqué' : ''}</span></span>
        <span class="op-amt ${bal.get(a.id) < 0 ? 'amt-out' : ''}">${hiddenMoney(bal.get(a.id), isSavingsHidden(a))}</span>
      </button>`).join('') : '<p class="empty-sm">Aucun compte. Créez-en un pour commencer.</p>'}
  </section>

  <section class="card">
    <header class="card-head"><h3>Autres actifs <small class="muted">(facultatif)</small></h3>
      <button class="link" data-action="asset-form">${icon('plus')} Ajouter</button></header>
    <p class="hint">Biens que vous souhaitez inclure dans votre fortune (voiture, or, etc.). Ils ne font pas partie de l'argent disponible.</p>
    ${st.assets.length ? `<div class="op-list">${st.assets.map((a) => `
      <button class="acc-row" data-action="asset-form" data-id="${a.id}">
        <span class="acc-ic acc-other">${icon('box')}</span>
        <span class="op-main"><span class="op-title">${esc(a.name)}</span></span>
        <span class="op-amt">${money(a.value)}</span>
      </button>`).join('')}</div>` : ''}
  </section>`;
}

function openAccountDetail(id) {
  const a = accById(id);
  if (!a) return;
  const bal = computeBalances(S.state).get(id);
  const ops = filterOps(S.state, { accountId: id }).slice(0, 30);
  openSheet({
    title: a.name,
    body: `
      <div class="detail-amount">${hiddenMoney(bal, isSavingsHidden(a))}</div>
      <p class="center muted">${esc(ACCOUNT_TYPES[a.type])}</p>
      <div class="btn-row">
        <button class="btn btn-soft" data-action="account-form" data-id="${a.id}">${icon('edit')} Modifier</button>
        <button class="btn btn-soft" data-action="filter-account" data-id="${a.id}">${icon('list')} Historique</button>
      </div>
      <h4 class="section-title">Opérations récentes</h4>
      ${ops.length ? `<div class="op-list">${isSavingsHidden(a) ? '<p class="empty-sm">Montants masqués.</p>' : opsGrouped(ops, { accountId: id })}</div>` : '<p class="empty-sm">Aucune opération sur ce compte.</p>'}`,
  });
}

function openAccountForm(id) {
  const a = id ? accById(id) : null;
  const bal = a ? computeBalances(S.state).get(a.id) : 0;
  openSheet({
    title: a ? 'Modifier le compte' : 'Nouveau compte',
    body: `
    <form class="form" autocomplete="off">
      <label class="field"><span>Nom</span><input name="name" required maxlength="40" value="${esc(a?.name || '')}" placeholder="Ex. : CCP, Banque, Coffre…"></label>
      <label class="field"><span>Type</span><select name="type">
        ${Object.entries(ACCOUNT_TYPES).map(([k, v]) => `<option value="${k}" ${(a?.type || 'bank') === k ? 'selected' : ''}>${v}</option>`).join('')}
      </select></label>
      <label class="field"><span>${a ? 'Solde actuel' : 'Solde de départ'}</span>
        <div class="amount-wrap"><input name="balance" inputmode="decimal" value="${a ? amountToInput(bal) : ''}" placeholder="0"><em>${esc(CURRENCIES[view.currency].symbol)}</em></div></label>
      ${a ? '<p class="hint">Modifier le solde actuel corrige le solde de départ du compte. Pour un mouvement réel, utilisez plutôt une opération.</p>' : ''}
      <label class="switch-row" data-hidden-row><span>Masquer le solde (épargne cachée)</span>
        <input type="checkbox" name="hidden" ${a ? (a.hidden ? 'checked' : '') : 'checked'}><i></i></label>
      <p class="form-error" data-err></p>
      <button class="btn btn-primary btn-lg" type="submit">Enregistrer</button>
      ${a ? `<button type="button" class="btn btn-danger-ghost" data-del>${icon('trash')} Supprimer le compte</button>` : ''}
    </form>`,
    onMount(el, close) {
      const f = el.querySelector('form');
      const row = el.querySelector('[data-hidden-row]');
      const sync = () => { row.hidden = f.type.value !== 'savings'; };
      f.type.onchange = sync; sync();
      f.onsubmit = async (e) => {
        e.preventDefault();
        const name = f.name.value.trim();
        const val = f.balance.value.trim() === '' ? 0 : parseAmount(f.balance.value.trim().replace(/^-/, ''));
        const neg = f.balance.value.trim().startsWith('-');
        if (!name) return showErr(el, 'Indiquez un nom.');
        if (Number.isNaN(val)) return showErr(el, 'Montant invalide.');
        const target = neg ? -val : val;
        await commit((st) => {
          if (a) {
            const acc = st.accounts.find((x) => x.id === a.id);
            acc.name = name; acc.type = f.type.value; acc.hidden = f.type.value === 'savings' && f.hidden.checked;
            acc.initial += target - bal;
          } else {
            st.accounts.push({ id: uid(), name, type: f.type.value, initial: target, hidden: f.type.value === 'savings' && f.hidden.checked, createdAt: today() });
          }
        }, a ? 'Compte modifié.' : 'Compte créé.');
        closeAllSheets();
      };
      el.querySelector('[data-del]')?.addEventListener('click', async () => {
        const ids = opsForAccount(S.state, a.id);
        const ok = await confirmDialog({
          title: 'Supprimer le compte ?',
          message: ids.size
            ? `« ${a.name} » est utilisé par ${ids.size} opération(s). Elles seront aussi supprimées et tous les soldes recalculés.`
            : `« ${a.name} » sera supprimé.`,
          confirmLabel: 'Supprimer', danger: true, requireText: ids.size ? 'SUPPRIMER' : null,
        });
        if (!ok) return;
        await commit((st) => {
          st.accounts = st.accounts.filter((x) => x.id !== a.id);
          st.ops = st.ops.filter((o) => !ids.has(o.id));
        }, 'Compte supprimé.');
        closeAllSheets();
        close();
      });
    },
  });
}

function openAssetForm(id) {
  const a = id ? S.state.assets.find((x) => x.id === id) : null;
  openSheet({
    title: a ? "Modifier l'actif" : 'Nouvel actif',
    body: `
    <form class="form" autocomplete="off">
      <label class="field"><span>Nom</span><input name="name" required maxlength="40" value="${esc(a?.name || '')}" placeholder="Ex. : Voiture, Or…"></label>
      <label class="field"><span>Valeur estimée</span><div class="amount-wrap"><input name="value" inputmode="decimal" value="${a ? amountToInput(a.value) : ''}" placeholder="0"><em>${esc(CURRENCIES[view.currency].symbol)}</em></div></label>
      <p class="form-error" data-err></p>
      <button class="btn btn-primary btn-lg" type="submit">Enregistrer</button>
      ${a ? `<button type="button" class="btn btn-danger-ghost" data-del>${icon('trash')} Supprimer</button>` : ''}
    </form>`,
    onMount(el, close) {
      const f = el.querySelector('form');
      f.onsubmit = async (e) => {
        e.preventDefault();
        const v = parseAmount(f.value.value);
        if (!f.name.value.trim()) return showErr(el, 'Indiquez un nom.');
        if (Number.isNaN(v)) return showErr(el, 'Valeur invalide.');
        await commit((st) => {
          if (a) Object.assign(st.assets.find((x) => x.id === a.id), { name: f.name.value.trim(), value: v });
          else st.assets.push({ id: uid(), name: f.name.value.trim(), value: v });
        }, 'Actif enregistré.');
        close();
      };
      el.querySelector('[data-del]')?.addEventListener('click', async () => {
        if (!await confirmDialog({ title: 'Supprimer cet actif ?', message: a.name, confirmLabel: 'Supprimer', danger: true })) return;
        await commit((st) => { st.assets = st.assets.filter((x) => x.id !== a.id); }, 'Actif supprimé.');
        close();
      });
    },
  });
}

/* ============================================================ section Euro */

const eur = (c, o = {}) => money(c, { ...o, currency: 'EUR' });

function viewEuro() {
  const st = S.state;
  const e = computeEuro(st);
  const kind = S.euroTab;
  const items = st.euro.items.filter((i) => i.kind === kind);
  const pending = items.filter((i) => i.status !== 'done').sort((a, b) => a.date.localeCompare(b.date));
  const done = items.filter((i) => i.status === 'done').sort((a, b) => (b.doneDate || '').localeCompare(a.doneDate || ''));
  const row = (i) => `
    <div class="euro-row ${i.status === 'done' ? 'is-done' : ''}">
      <button class="euro-main" data-action="euro-form" data-id="${i.id}">
        <span class="avatar">${esc(i.client.trim().charAt(0).toUpperCase() || '?')}</span>
        <span class="op-main"><span class="op-title">${esc(i.client)}</span>
          <span class="op-sub">${i.status === 'done' ? `Payé le ${esc(dateLabel(i.doneDate))}` : `Depuis le ${esc(dateLabel(i.date))}`}${i.note ? ' · ' + esc(i.note) : ''}</span></span>
        <span class="op-amt ${kind === 'receive' ? 'pos' : 'neg'}">${eur(i.amount)}</span>
      </button>
      ${i.status === 'done'
        ? `<button class="btn btn-ghost sm" data-action="euro-undo" data-id="${i.id}">Annuler le paiement</button>`
        : `<button class="btn btn-primary sm" data-action="euro-done" data-id="${i.id}">${icon('check')} ${kind === 'receive' ? 'Client m\u2019a payé' : 'Client payé'}</button>`}
    </div>`;
  return `
  <section class="total-card">
    <span>Portefeuille euro</span>
    <b data-testid="euro-total">${eur(e.balance)}</b>
    <div class="split">
      <span>À recevoir <b class="pos-light">${eur(e.toReceive)}</b></span>
      <span>À payer <b class="neg-light">${eur(e.toPay)}</b></span>
      <button class="mini-btn" data-action="euro-balance">${icon('edit')}Solde</button>
    </div>
  </section>
  <p class="hint euro-hint">${icon('info')} Les montants en attente ne changent pas le solde. Ils s'ajoutent (ou se retirent) seulement quand vous les marquez comme payés. Les euros sont suivis à part, sans conversion en ${esc(st.settings.currency)}.</p>
  <div class="segmented">
    <button class="${kind === 'receive' ? 'on' : ''}" data-action="euro-tab" data-tab="receive">Clients qui me doivent</button>
    <button class="${kind === 'pay' ? 'on' : ''}" data-action="euro-tab" data-tab="pay">Clients à payer</button>
  </div>
  <button class="btn btn-soft btn-full" data-action="euro-form" data-kind="${kind}">${icon('plus')} ${kind === 'receive' ? 'Ajouter un client qui me doit' : 'Ajouter un client à payer'}</button>
  <section class="list-card">
    ${pending.length ? pending.map(row).join('') : `<p class="empty-sm">${kind === 'receive' ? 'Aucun client en attente de paiement.' : 'Aucun client à payer.'}</p>`}
  </section>
  ${done.length ? `
    <button class="link center-block" data-action="euro-settled">${S.euroShowDone ? 'Masquer' : 'Afficher'} les paiements réglés (${done.length})</button>
    ${S.euroShowDone ? `<section class="list-card">${done.map(row).join('')}</section>` : ''}` : ''}`;
}

function openEuroForm(kind, id) {
  const item = id ? S.state.euro.items.find((i) => i.id === id) : null;
  const k = item?.kind || kind;
  const names = [...new Set(S.state.euro.items.map((i) => i.client))];
  openSheet({
    title: item ? 'Modifier' : k === 'receive' ? 'Client qui me doit' : 'Client à payer',
    className: 'sheet-form',
    body: `
    <form class="form" autocomplete="off" novalidate>
      <div class="amount-big"><input name="amount" inputmode="decimal" placeholder="0" value="${item ? amountToInput(item.amount) : ''}" aria-label="Montant"><em>€</em></div>
      <label class="field"><span>Client</span><input name="client" list="eclients" required maxlength="60" value="${esc(item?.client || '')}"></label>
      <datalist id="eclients">${names.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
      <label class="field"><span>Date</span><input type="date" name="date" value="${item?.date || today()}"></label>
      ${item?.status === 'done' ? `<label class="field"><span>Payé le</span><input type="date" name="doneDate" value="${item.doneDate}"></label>` : ''}
      <label class="field"><span>Description (facultatif)</span><input name="note" maxlength="120" value="${esc(item?.note || '')}"></label>
      <p class="form-error" data-err></p>
      <button class="btn btn-primary btn-lg" type="submit" data-submit>${item ? 'Enregistrer' : 'Ajouter'}</button>
      ${item ? `<button type="button" class="btn btn-danger-ghost" data-del>${icon('trash')} Supprimer</button>` : ''}
    </form>`,
    onMount(el, close) {
      const f = el.querySelector('form');
      if (!item) setTimeout(() => f.amount.focus(), 280);
      f.onsubmit = async (e) => {
        e.preventDefault();
        const draft = {
          id: item?.id || uid(), kind: k, client: f.client.value.trim().replace(/\s+/g, ' '),
          amount: parseAmount(f.amount.value), date: f.date.value, note: f.note.value.trim() || undefined,
          status: item?.status || 'pending', doneDate: f.doneDate ? f.doneDate.value : item?.doneDate,
          createdAt: item?.createdAt || Date.now(),
        };
        if (Number.isNaN(draft.amount)) return showErr(el, 'Montant invalide.');
        const err = validateEuroItem(draft);
        if (err) return showErr(el, err);
        if (!draft.note) delete draft.note;
        if (draft.status !== 'done') delete draft.doneDate;
        await commit((st) => {
          const i = st.euro.items.findIndex((x) => x.id === draft.id);
          if (i >= 0) st.euro.items[i] = draft; else st.euro.items.push(draft);
        }, item ? 'Modifié.' : 'Ajouté (le solde euro change seulement au paiement).');
        close();
      };
      el.querySelector('[data-del]')?.addEventListener('click', async () => {
        const ok = await confirmDialog({
          title: 'Supprimer ?',
          message: item.status === 'done' ? 'Ce paiement est déjà réglé : le solde euro sera recalculé.' : `${item.client} — ${eur(item.amount, { force: true })}`,
          confirmLabel: 'Supprimer', danger: true,
        });
        if (!ok) return;
        await commit((st) => { st.euro.items = st.euro.items.filter((x) => x.id !== item.id); }, 'Supprimé.');
        closeAllSheets();
      });
    },
  });
}

async function markEuro(id, paid) {
  const it = S.state.euro.items.find((i) => i.id === id);
  if (!it) return;
  if (paid) {
    const ok = await confirmDialog({
      title: it.kind === 'receive' ? 'Le client vous a payé ?' : 'Vous avez payé le client ?',
      message: `${it.client} : ${eur(it.amount, { force: true })} ${it.kind === 'receive' ? 'seront ajoutés au' : 'seront retirés du'} portefeuille euro.`,
      confirmLabel: 'Confirmer',
    });
    if (!ok) return;
  }
  await commit((st) => {
    const x = st.euro.items.find((i) => i.id === id);
    x.status = paid ? 'done' : 'pending';
    if (paid) x.doneDate = today(); else delete x.doneDate;
  }, paid ? (it.kind === 'receive' ? 'Ajouté au portefeuille euro.' : 'Retiré du portefeuille euro.') : 'Paiement annulé : remis en attente.');
}

function openEuroBalance() {
  const e = computeEuro(S.state);
  openSheet({
    title: 'Solde euro actuel',
    className: 'sheet-dialog',
    body: `<form class="form" autocomplete="off">
      <p class="dialog-msg">Indiquez combien d'euros vous avez réellement aujourd'hui. Les paiements clients réglés s'ajoutent ou se retirent ensuite automatiquement.</p>
      <label class="field"><span>Solde actuel</span><div class="amount-wrap"><input name="v" inputmode="decimal" value="${amountToInput(e.balance)}"><em>€</em></div></label>
      <p class="form-error" data-err></p>
      <button class="btn btn-primary btn-lg" type="submit">Enregistrer</button></form>`,
    onMount(el, close) {
      const f = el.querySelector('form');
      f.onsubmit = async (ev) => {
        ev.preventDefault();
        const raw = f.v.value.trim();
        const neg = raw.startsWith('-');
        const v = raw === '' ? 0 : parseAmount(raw.replace(/^-/, ''));
        if (Number.isNaN(v)) return showErr(el, 'Montant invalide.');
        const target = neg ? -v : v;
        await commit((st) => { st.euro.initial += target - e.balance; }, 'Solde euro mis à jour.');
        close();
      };
    },
  });
}

/* ============================================================ prêts / dettes */

function viewPeople() {
  const st = S.state;
  const loans = computeLoans(st, today());
  const s = computeSummary(st, today());
  const kind = S.peopleTab;
  const people = groupByPerson(loans.filter((l) => l.kind === kind))
    .map((p) => ({ ...p, remaining: kind === 'loan' ? p.lent : p.borrowed }))
    .sort((a, b) => (b.remaining > 0) - (a.remaining > 0) || b.lastDate.localeCompare(a.lastDate));
  const active = people.filter((p) => p.remaining > 0);
  const settled = people.filter((p) => p.remaining === 0);
  const personCard = (p) => {
    const overdue = p.items.some((l) => l.overdue);
    const open = p.items.filter((l) => l.remaining > 0).length;
    return `
    <button class="person-row" data-action="person" data-key="${esc(p.key)}">
      <span class="avatar">${esc(p.name.trim().charAt(0).toUpperCase() || '?')}</span>
      <span class="op-main"><span class="op-title">${esc(p.name)}</span>
        <span class="op-sub">${p.remaining > 0 ? `${open} en cours` : 'Tout est remboursé'}${overdue ? ' · <em class="neg">en retard</em>' : ''}</span></span>
      <span class="op-amt ${kind === 'loan' ? 'gold' : 'neg'}">${money(p.remaining)}</span>
    </button>`;
  };
  return `
  <div class="segmented">
    <button class="${kind === 'loan' ? 'on' : ''}" data-action="people-tab" data-tab="loan">On me doit</button>
    <button class="${kind === 'debt' ? 'on' : ''}" data-action="people-tab" data-tab="debt">Je dois</button>
  </div>
  <section class="total-card ${kind === 'loan' ? 'tc-gold' : 'tc-red'}">
    <span>${kind === 'loan' ? 'Total à récupérer' : 'Total à rembourser'}</span>
    <b>${money(kind === 'loan' ? s.receivables : s.debts)}</b>
    <div class="split"><span>${kind === 'loan' ? 'Déjà reçu' : 'Déjà remboursé'} <b>${money(kind === 'loan' ? s.repaidReceived : s.repaidMade)}</b></span></div>
  </section>
  <div class="btn-row">
    <button class="btn btn-soft" data-action="new-op" data-type="${kind}">${icon(kind)} ${kind === 'loan' ? 'Nouveau prêt' : 'Nouvelle dette'}</button>
    <button class="btn btn-soft" data-action="new-op" data-type="repay" data-dir="${kind === 'loan' ? 'loan_repay' : 'debt_repay'}">${icon('repay')} Remboursement</button>
  </div>
  <section class="list-card">
    ${active.length ? active.map(personCard).join('') : `<p class="empty-sm">${kind === 'loan' ? 'Personne ne vous doit d’argent.' : 'Vous n’avez aucune dette en cours.'}</p>`}
  </section>
  ${settled.length ? `
    <button class="link center-block" data-action="toggle-settled">${S.showSettled ? 'Masquer' : 'Afficher'} les personnes soldées (${settled.length})</button>
    ${S.showSettled ? `<section class="list-card">${settled.map(personCard).join('')}</section>` : ''}` : ''}`;
}

function openPerson(key) {
  const loans = computeLoans(S.state, today()).filter((l) => l.personKey === key);
  if (!loans.length) return;
  const name = loans[0].person;
  const lent = loans.filter((l) => l.kind === 'loan').reduce((t, l) => t + l.remaining, 0);
  const owed = loans.filter((l) => l.kind === 'debt').reduce((t, l) => t + l.remaining, 0);
  const card = (l) => {
    const p = l.amount ? Math.round((l.repaid / l.amount) * 100) : 0;
    return `
    <div class="loan-card ${l.kind}">
      <div class="loan-top">
        <div><b>${l.kind === 'loan' ? 'Prêt' : 'Dette'} du ${esc(dateLabel(l.date))}</b>
          ${l.op.note ? `<span class="muted">${esc(l.op.note)}</span>` : ''}</div>
        <span class="status st-${l.status}">${STATUS_LABELS[l.status]}</span>
      </div>
      <div class="loan-nums">
        <div><span>Montant</span><b>${money(l.amount)}</b></div>
        <div><span>Remboursé</span><b>${money(l.repaid)}</b></div>
        <div><span>Restant</span><b class="${l.kind === 'loan' ? 'gold' : 'neg'}">${money(l.remaining)}</b></div>
      </div>
      <div class="progress"><i style="width:${p}%"></i></div>
      ${l.dueDate ? `<p class="due ${l.overdue ? 'neg' : 'muted'}">${icon('calendar')} Échéance : ${esc(dateLabel(l.dueDate))}${l.overdue ? ' (dépassée)' : ''}</p>` : ''}
      ${l.repayments.length ? `<div class="repay-list">${l.repayments.map((r) => `
        <button class="repay-row" data-action="op-detail" data-id="${r.id}">
          <span>${esc(dateLabel(r.date))} · ${esc(accById(r.accountId)?.name || '')}</span><b>${money(r.amount)}</b></button>`).join('')}</div>` : ''}
      <div class="loan-actions">
        ${l.remaining > 0 ? `<button class="btn btn-soft sm" data-action="new-op" data-type="repay" data-dir="${l.kind === 'loan' ? 'loan_repay' : 'debt_repay'}" data-ref="${l.id}">${icon('repay')} Remboursement</button>` : ''}
        <button class="btn btn-ghost sm" data-action="edit-op" data-id="${l.id}">${icon('edit')} Modifier</button>
      </div>
      <div class="loan-actions">
        ${l.repayments.length ? '' : `<button class="btn btn-ghost sm" data-action="convert-loan" data-id="${l.id}">${icon('transfer')} ${l.kind === 'loan' ? 'Convertir en dette' : 'Convertir en prêt'}</button>`}
        <button class="btn btn-danger-ghost sm" data-action="delete-op" data-id="${l.id}">${icon('trash')} Supprimer</button>
      </div>
    </div>`;
  };
  openSheet({
    title: name,
    body: `
      <div class="person-sum">
        ${lent || loans.some((l) => l.kind === 'loan') ? `<div><span>Me doit</span><b class="gold">${money(lent)}</b></div>` : ''}
        ${owed || loans.some((l) => l.kind === 'debt') ? `<div><span>Je lui dois</span><b class="neg">${money(owed)}</b></div>` : ''}
      </div>
      <div class="btn-row">
        <button class="btn btn-soft sm" data-action="new-op" data-type="loan" data-person="${esc(name)}">${icon('loan')} Nouveau prêt</button>
        <button class="btn btn-soft sm" data-action="new-op" data-type="debt" data-person="${esc(name)}">${icon('debt')} Nouvelle dette</button>
      </div>
      <h4 class="section-title">Historique</h4>
      ${loans.map(card).join('')}`,
  });
}

/* ============================================================ historique */

function activeFilterChips() {
  const f = S.filters;
  const chips = [];
  if (f.type) chips.push(['type', OP_TYPES[f.type].label]);
  if (f.categoryId) chips.push(['categoryId', catById(f.categoryId)?.name || '?']);
  if (f.accountId) chips.push(['accountId', accById(f.accountId)?.name || '?']);
  if (f.month) chips.push(['month', monthLabel(f.month)]);
  if (f.year) chips.push(['year', f.year]);
  if (f.from || f.to) chips.push(['range', `${f.from ? dateLabel(f.from) : '…'} → ${f.to ? dateLabel(f.to) : '…'}`]);
  return chips;
}

function viewHistory() {
  const chips = activeFilterChips();
  return `
  <div class="search-bar">
    <label class="search">${icon('search')}<input type="search" id="q" placeholder="Rechercher (note, personne, montant…)" value="${esc(S.filters.query || '')}" autocomplete="off"></label>
    <button class="icon-btn filled ${chips.length ? 'has-dot' : ''}" data-action="filters" aria-label="Filtres">${icon('filter')}</button>
  </div>
  <div class="chips" id="chips">
    ${chips.map(([k, label]) => `<button class="chip chip-x" data-action="clear-filter" data-k="${k}">${esc(label)} ${icon('x')}</button>`).join('')}
    ${['month', 'type'].every((k) => !S.filters[k]) ? `
      <button class="chip" data-action="quick-filter" data-k="month" data-v="${monthKey(today())}">Ce mois</button>
      <button class="chip" data-action="quick-filter" data-k="type" data-v="expense">Dépenses</button>
      <button class="chip" data-action="quick-filter" data-k="type" data-v="income">Revenus</button>` : ''}
  </div>
  <div id="hist"></div>`;
}

afterRender.history = (v) => {
  const q = v.querySelector('#q');
  let t;
  q.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => { S.filters.query = q.value; S.historyLimit = 150; drawHistoryList(); }, 150);
  });
  drawHistoryList();
};

function drawHistoryList() {
  const host = document.getElementById('hist');
  if (!host) return;
  const ops = filterOps(S.state, S.filters);
  let tin = 0, tout = 0;
  for (const op of ops) {
    const fl = opFlow(op);
    if (fl === 'in') tin += op.amount; else if (fl === 'out') tout += op.amount;
  }
  const shown = ops.slice(0, S.historyLimit);
  host.innerHTML = `
    <div class="hist-sum">
      <span>${ops.length} opération${ops.length > 1 ? 's' : ''}</span>
      <span class="pos">${money(tin, { sign: true })}</span>
      <span class="neg">${money(-tout)}</span>
      ${ops.length ? `<button class="link" data-action="export-csv-filtered">${icon('download')} CSV</button>` : ''}
    </div>
    ${shown.length ? `<div class="op-list">${opsGrouped(shown)}</div>` : '<p class="empty">Aucune opération ne correspond.</p>'}
    ${ops.length > shown.length ? `<button class="btn btn-ghost center-block" data-action="more-history">Afficher plus (${ops.length - shown.length})</button>` : ''}`;
}

function openFilters() {
  const f = S.filters;
  const st = S.state;
  const years = [...new Set(st.ops.map((o) => o.date.slice(0, 4)))].sort().reverse();
  const period = f.month ? 'month' : f.year ? 'year' : (f.from || f.to) ? 'range' : 'all';
  openSheet({
    title: 'Filtres',
    body: `
    <form class="form">
      <label class="field"><span>Type d'opération</span><select name="type"><option value="">Tous</option>
        ${Object.entries(OP_TYPES).map(([k, v]) => `<option value="${k}" ${f.type === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select></label>
      <label class="field"><span>Catégorie</span><select name="categoryId"><option value="">Toutes</option>
        <optgroup label="Dépenses">${st.categories.filter((c) => c.kind === 'expense').map((c) => `<option value="${c.id}" ${f.categoryId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</optgroup>
        <optgroup label="Revenus">${st.categories.filter((c) => c.kind === 'income').map((c) => `<option value="${c.id}" ${f.categoryId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</optgroup>
      </select></label>
      <label class="field"><span>Compte</span><select name="accountId"><option value="">Tous</option>
        ${st.accounts.map((a) => `<option value="${a.id}" ${f.accountId === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>
      <label class="field"><span>Période</span><select name="period">
        <option value="all" ${period === 'all' ? 'selected' : ''}>Toute la période</option>
        <option value="month" ${period === 'month' ? 'selected' : ''}>Un mois</option>
        <option value="year" ${period === 'year' ? 'selected' : ''}>Une année</option>
        <option value="range" ${period === 'range' ? 'selected' : ''}>Entre deux dates</option></select></label>
      <label class="field" data-p="month"><span>Mois</span><input type="month" name="month" value="${f.month || monthKey(today())}"></label>
      <label class="field" data-p="year"><span>Année</span><select name="year">${(years.length ? years : [today().slice(0, 4)]).map((y) => `<option ${f.year === y ? 'selected' : ''}>${y}</option>`).join('')}</select></label>
      <div class="two" data-p="range">
        <label class="field"><span>Du</span><input type="date" name="from" value="${f.from || ''}"></label>
        <label class="field"><span>Au</span><input type="date" name="to" value="${f.to || ''}"></label>
      </div>
      <div class="btn-row">
        <button type="button" class="btn btn-ghost" data-reset>Réinitialiser</button>
        <button type="submit" class="btn btn-primary">Appliquer</button>
      </div>
    </form>`,
    onMount(el, close) {
      const form = el.querySelector('form');
      const sync = () => el.querySelectorAll('[data-p]').forEach((n) => { n.hidden = n.dataset.p !== form.period.value; });
      form.period.onchange = sync; sync();
      el.querySelector('[data-reset]').onclick = () => { S.filters = {}; close(); render(); };
      form.onsubmit = (e) => {
        e.preventDefault();
        const p = form.period.value;
        S.filters = {
          query: S.filters.query || '',
          type: form.type.value || undefined,
          categoryId: form.categoryId.value || undefined,
          accountId: form.accountId.value || undefined,
          month: p === 'month' ? form.month.value || undefined : undefined,
          year: p === 'year' ? form.year.value || undefined : undefined,
          from: p === 'range' ? form.from.value || undefined : undefined,
          to: p === 'range' ? form.to.value || undefined : undefined,
        };
        S.historyLimit = 150;
        close();
        render();
      };
    },
  });
}

/* ============================================================ formulaires d'opération */

function accountOptions(selected, { none = null, exclude = null } = {}) {
  const bal = computeBalances(S.state);
  return (none !== null ? `<option value="">${esc(none)}</option>` : '') + S.state.accounts
    .filter((a) => a.id !== exclude)
    .map((a) => `<option value="${a.id}" ${a.id === selected ? 'selected' : ''}>${esc(a.name)} — ${isSavingsHidden(a) ? '•••' : esc(money(bal.get(a.id)))}</option>`)
    .join('');
}

function defaultAccount() {
  return S.state.accounts.find((a) => a.type === 'cash')?.id || S.state.accounts[0]?.id || '';
}

function categoryChips(kind, selected) {
  return `<div class="cat-grid">${S.state.categories.filter((c) => c.kind === kind).map((c) => `
    <label class="cat"><input type="radio" name="categoryId" value="${c.id}" ${c.id === selected ? 'checked' : ''}><span>${esc(c.name)}</span></label>`).join('')}
    <button type="button" class="cat cat-add" data-newcat="${kind}">${icon('plus')} Nouvelle</button></div>`;
}

function personList() {
  const names = new Map();
  for (const o of S.state.ops) if (o.person) names.set(normalizeName(o.person), o.person);
  return `<datalist id="people">${[...names.values()].map((n) => `<option value="${esc(n)}">`).join('')}</datalist>`;
}

const SAVED_MSG = {
  expense: 'Dépense enregistrée.', income: 'Revenu enregistré.', transfer: 'Transfert enregistré.',
  loan: 'Prêt enregistré.', debt: 'Dette enregistrée.',
  loan_repay: 'Remboursement reçu enregistré.', debt_repay: 'Remboursement effectué enregistré.',
};

const FORM_TITLES = {
  expense: 'Nouvelle dépense', income: 'Nouveau revenu', transfer: 'Transfert entre comptes',
  loan: "Prêt accordé", debt: 'Nouvelle dette', repay: 'Remboursement',
  loan_repay: 'Remboursement reçu', debt_repay: 'Remboursement effectué',
};

/**
 * Formulaire d'ajout / modification.
 * @param {string} type type d'opération ou 'repay'
 * @param {object|null} existing opération à modifier
 * @param {object} preset { person, ref, dir }
 */
function openOpForm(type, existing = null, preset = {}) {
  if (!S.state.accounts.length) { toast("Créez d'abord un compte."); location.hash = '#accounts'; return; }
  const op = existing || {};
  const editing = !!existing;
  let t = type;
  if (t === 'repay') t = preset.dir || 'loan_repay';
  const loans = computeLoans(S.state, today());

  const repayBlock = (dir) => {
    const kind = dir === 'loan_repay' ? 'loan' : 'debt';
    const open = loans.filter((l) => l.kind === kind && (l.remaining > 0 || l.id === op.refId));
    if (!open.length) {
      return `<p class="empty-sm">${kind === 'loan' ? 'Aucun prêt en cours à rembourser.' : 'Aucune dette en cours à rembourser.'}</p>`;
    }
    const sel = op.refId || preset.ref || open[0].id;
    return `<label class="field"><span>${kind === 'loan' ? 'Prêt concerné' : 'Dette concernée'}</span><select name="refId">
      ${open.map((l) => `<option value="${l.id}" ${l.id === sel ? 'selected' : ''} data-rem="${l.remaining + (l.id === op.refId ? op.amount : 0)}">${esc(l.person)} — reste ${esc(money(l.remaining + (l.id === op.refId ? op.amount : 0), { force: true }))} (${esc(dateLabel(l.date))})</option>`).join('')}
    </select></label>`;
  };

  const fieldsFor = (tp) => {
    const sym = esc(CURRENCIES[view.currency].symbol);
    const amount = `<div class="amount-big"><input name="amount" inputmode="decimal" placeholder="0" autocomplete="off" value="${op.amount ? amountToInput(op.amount) : ''}" aria-label="Montant"><em>${sym}</em></div>`;
    const date = `<label class="field"><span>Date</span><input type="date" name="date" required value="${op.date || today()}"></label>`;
    const note = (label = 'Description (facultatif)') => `<label class="field"><span>${label}</span><input name="note" maxlength="120" value="${esc(op.note || '')}"></label>`;
    const account = (label, sel = op.accountId || defaultAccount()) => `<label class="field"><span>${label}</span><select name="accountId">${accountOptions(sel)}</select></label>`;
    switch (tp) {
      case 'expense':
        return `${amount}<div class="field"><span>Catégorie</span>${categoryChips('expense', op.categoryId || '')}</div>${account('Payé depuis')}<div class="two">${date}</div>${note()}`;
      case 'income':
        return `${amount}<div class="field"><span>Source du revenu</span>${categoryChips('income', op.categoryId || '')}</div>
          <p class="hint" data-repay-hint hidden>${icon('info')} Pour l'argent qu'une personne vous rend après un prêt, utilisez plutôt « Remboursement » : cela réduit la créance au lieu de compter un nouveau revenu.</p>
          ${account('Versé sur')}${date}${note()}`;
      case 'transfer': {
        const from = op.accountId || defaultAccount();
        const to = op.toAccountId || S.state.accounts.find((a) => a.id !== from)?.id || '';
        return `${amount}<label class="field"><span>Depuis</span><select name="accountId">${accountOptions(from)}</select></label>
          <label class="field"><span>Vers</span><select name="toAccountId">${accountOptions(to)}</select></label>${date}${note()}
          <p class="hint">${icon('info')} Un transfert entre vos comptes n'est ni un revenu ni une dépense.</p>`;
      }
      case 'loan':
        return `${amount}<label class="field"><span>Nom de la personne</span><input name="person" list="people" required maxlength="50" value="${esc(op.person || preset.person || '')}" autocomplete="off"></label>${personList()}
          ${account("Argent sorti de")}<div class="two">${date}<label class="field"><span>Remboursement prévu</span><input type="date" name="dueDate" value="${op.dueDate || ''}"></label></div>${note('Motif (facultatif)')}
          <p class="hint">${icon('info')} Un prêt n'est pas une dépense : votre argent disponible baisse, votre créance augmente, votre patrimoine ne change pas.</p>`;
      case 'debt':
        return `${amount}<label class="field"><span>Nom du créancier</span><input name="person" list="people" required maxlength="50" value="${esc(op.person || preset.person || '')}" autocomplete="off"></label>${personList()}
          <label class="field"><span>Argent reçu sur un compte ?</span><select name="accountId">${accountOptions(op.accountId || '', { none: 'Non — dette sans encaissement' })}</select></label>
          <div class="two">${date}<label class="field"><span>Remboursement prévu</span><input type="date" name="dueDate" value="${op.dueDate || ''}"></label></div>${note('Motif (facultatif)')}
          <p class="hint">${icon('info')} Choisissez un compte seulement si l'argent emprunté vous a été remis. Un emprunt n'est jamais compté comme revenu.</p>`;
      case 'loan_repay':
      case 'debt_repay':
        return `${!editing ? `<div class="segmented sm" data-dir>
            <button type="button" class="${tp === 'loan_repay' ? 'on' : ''}" data-v="loan_repay">On me rembourse</button>
            <button type="button" class="${tp === 'debt_repay' ? 'on' : ''}" data-v="debt_repay">Je rembourse</button></div>` : ''}
          ${repayBlock(tp)}${amount}${account(tp === 'loan_repay' ? 'Reçu sur' : 'Payé depuis')}${date}${note()}`;
      default: return '';
    }
  };

  const sheet = openSheet({
    title: preset.converting ? (t === 'debt' ? 'Convertir en dette' : 'Convertir en prêt')
      : editing ? `Modifier : ${OP_TYPES[t].label.toLowerCase()}` : FORM_TITLES[t],
    className: 'sheet-form',
    body: `<form class="form" autocomplete="off" novalidate><div data-fields>${fieldsFor(t)}</div>
      <p class="form-error" data-err></p>
      <button class="btn btn-primary btn-lg" type="submit" data-submit>${editing ? 'Enregistrer' : 'Ajouter'}</button></form>`,
    onMount(el, close) {
      const form = el.querySelector('form');
      const wire = () => {
        // Bascule « on me rembourse / je rembourse »
        el.querySelectorAll('[data-dir] button').forEach((b) => b.addEventListener('click', () => {
          t = b.dataset.v;
          el.querySelector('.sheet-head h2').textContent = FORM_TITLES[t];
          el.querySelector('[data-fields]').innerHTML = fieldsFor(t);
          wire();
        }));
        // Pré-remplit le reste dû
        const ref = form.refId;
        const amt = form.amount;
        if (ref && amt && !editing) {
          const fill = () => { const rem = Number(ref.selectedOptions[0]?.dataset.rem || 0); amt.placeholder = amountToInput(rem); if (!amt.dataset.touched) amt.value = amountToInput(rem); };
          amt.addEventListener('input', () => { amt.dataset.touched = '1'; });
          ref.addEventListener('change', () => { delete amt.dataset.touched; fill(); });
          fill();
        }
        // Avertissement « Remboursement reçu » dans les revenus
        const hint = el.querySelector('[data-repay-hint]');
        if (hint) {
          const check = () => { const c = form.querySelector('input[name="categoryId"]:checked'); hint.hidden = !(c && catById(c.value)?.name === 'Remboursement reçu'); };
          form.addEventListener('change', check); check();
        }
        el.querySelectorAll('[data-newcat]').forEach((b) => b.addEventListener('click', () => promptCategory(b.dataset.newcat, (cat) => {
          const grid = b.closest('.cat-grid');
          const lab = document.createElement('label');
          lab.className = 'cat';
          lab.innerHTML = `<input type="radio" name="categoryId" value="${cat.id}" checked><span>${esc(cat.name)}</span>`;
          grid.insertBefore(lab, b);
        })));
        if (!editing && form.amount && !form.refId) setTimeout(() => form.amount.focus(), 280);
      };
      wire();

      form.onsubmit = async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const draft = {
          id: op.id,
          type: t,
          amount: parseAmount(fd.get('amount') || ''),
          date: fd.get('date'),
          note: String(fd.get('note') || '').trim() || undefined,
          accountId: fd.get('accountId') || undefined,
          toAccountId: fd.get('toAccountId') || undefined,
          categoryId: fd.get('categoryId') || undefined,
          person: fd.get('person') ? String(fd.get('person')).trim().replace(/\s+/g, ' ') : undefined,
          dueDate: fd.get('dueDate') || undefined,
          refId: fd.get('refId') || undefined,
          createdAt: op.createdAt || Date.now(),
        };
        if (Number.isNaN(draft.amount)) return showErr(el, 'Montant invalide.');
        const err = validateOp(S.state, draft);
        if (err) return showErr(el, err);
        Object.keys(draft).forEach((k) => draft[k] === undefined && delete draft[k]);
        if (!draft.id) draft.id = uid();
        draft.updatedAt = Date.now();
        await commit((st) => {
          const i = st.ops.findIndex((o) => o.id === draft.id);
          if (i >= 0) st.ops[i] = draft; else st.ops.push(draft);
        }, preset.converting ? `Converti en ${t === 'debt' ? 'dette' : 'prêt'}.` : editing ? 'Opération modifiée.' : SAVED_MSG[t]);
        closeAllSheets();
        if (preset.reopenPerson) openPerson(preset.reopenPerson);
      };
    },
  });
  return sheet;
}

function showErr(el, msg) {
  const e = el.querySelector('[data-err]');
  e.textContent = msg;
  e.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  navigator.vibrate?.(40);
}

/** Supprime une opération (et ses remboursements liés) avec confirmation et annulation. */
async function deleteOpWithUndo(id) {
  const op = opById(id);
  if (!op) return;
  const ids = cascadeIds(S.state, op.id);
  const extra = ids.size - 1;
  const ok = await confirmDialog({
    title: 'Supprimer cette opération ?',
    message: extra
      ? `${extra} remboursement(s) lié(s) seront aussi supprimés. Tous les soldes seront recalculés.`
      : 'Tous les soldes et statistiques seront recalculés.',
    confirmLabel: 'Supprimer', danger: true,
  });
  if (!ok) return;
  const removed = S.state.ops.filter((o) => ids.has(o.id));
  await commit((st) => { st.ops = st.ops.filter((o) => !ids.has(o.id)); });
  closeAllSheets();
  toast('Opération supprimée.', {
    action: {
      label: 'Annuler',
      run: () => {
        // Ne restaure pas un remboursement dont le prêt a été supprimé entre-temps.
        const keep = removed.filter((o) => !o.refId || removed.some((r) => r.id === o.refId) || opById(o.refId));
        if (keep.length < removed.length || !S.unlocked) { toast('Annulation impossible : des opérations liées ont changé.'); return; }
        if (keep.some((o) => !accById(o.accountId) && o.type !== 'debt')) { toast('Annulation impossible : compte supprimé.'); return; }
        commit((st) => { st.ops.push(...keep); }, 'Suppression annulée.');
      },
    },
  });
}

/** Transforme un prêt en dette (ou l'inverse) saisi dans le mauvais sens. */
function convertLoan(id) {
  const op = opById(id);
  if (!op) return;
  if (S.state.ops.some((o) => o.refId === id)) {
    toast('Ce prêt a déjà des remboursements : supprimez-les avant de le convertir.', { duration: 5000 });
    return;
  }
  const target = op.type === 'loan' ? 'debt' : 'loan';
  closeAllSheets();
  // On ouvre le formulaire du bon type, prérempli, avec le même identifiant.
  openOpForm(target, { ...op, type: target, accountId: target === 'debt' ? undefined : op.accountId }, { converting: true });
}

function openOpDetail(id) {
  const op = opById(id);
  if (!op) return;
  const flow = opFlow(op);
  const rows = [];
  rows.push(['Type', OP_TYPES[op.type].label]);
  rows.push(['Date', dateLabel(op.date)]);
  if (op.categoryId) rows.push([op.type === 'income' ? 'Source' : 'Catégorie', catById(op.categoryId)?.name]);
  if (op.type === 'transfer') { rows.push(['Depuis', accById(op.accountId)?.name]); rows.push(['Vers', accById(op.toAccountId)?.name]); }
  else if (op.accountId) rows.push(['Compte', accById(op.accountId)?.name]);
  else if (op.type === 'debt') rows.push(['Compte', 'Non encaissée']);
  if (op.person) rows.push(['Personne', op.person]);
  const parent = op.refId ? opById(op.refId) : null;
  if (parent) rows.push([op.type === 'loan_repay' ? 'Prêt' : 'Dette', `${parent.person} — ${money(parent.amount)} du ${dateLabel(parent.date)}`]);
  if (op.dueDate) rows.push(['Échéance', dateLabel(op.dueDate)]);
  if (op.note) rows.push(['Description', op.note]);
  let loanInfo = '';
  if (op.type === 'loan' || op.type === 'debt') {
    const l = computeLoans(S.state, today()).find((x) => x.id === op.id);
    loanInfo = `<dl class="kv"><dt>Remboursé</dt><dd>${money(l.repaid)}</dd><dt>Restant</dt><dd><b>${money(l.remaining)}</b></dd><dt>Statut</dt><dd>${STATUS_LABELS[l.status]}</dd></dl>`;
  }
  openSheet({
    title: opTitle(op),
    body: `
      <div class="detail-amount amt-${flow}">${money(flow === 'out' ? -op.amount : op.amount, { sign: flow === 'in' })}</div>
      <dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v || '—')}</dd>`).join('')}</dl>
      ${loanInfo}
      <div class="btn-row">
        <button class="btn btn-soft" data-edit>${icon('edit')} Modifier</button>
        <button class="btn btn-danger-ghost" data-del>${icon('trash')} Supprimer</button>
      </div>
      ${op.person || parent ? `<button class="btn btn-ghost center-block" data-action="person" data-key="${esc(normalizeName(op.person || parent.person))}">${icon('users')} Voir l'historique de la personne</button>` : ''}`,
    onMount(el, close) {
      el.querySelector('[data-edit]').onclick = () => { close(); openOpForm(op.type, op); };
      el.querySelector('[data-del]').onclick = () => deleteOpWithUndo(op.id);
    },
  });
}

/* ============================================================ catégories */

function promptCategory(kind, onCreated, existing = null) {
  openSheet({
    title: existing ? 'Renommer la catégorie' : 'Nouvelle catégorie',
    className: 'sheet-dialog',
    body: `<form class="form" autocomplete="off">
      <label class="field"><span>Nom</span><input name="name" required maxlength="30" value="${esc(existing?.name || '')}"></label>
      ${existing ? '' : `<label class="field"><span>Type</span><select name="kind">
        <option value="expense" ${kind === 'expense' ? 'selected' : ''}>Dépense</option>
        <option value="income" ${kind === 'income' ? 'selected' : ''}>Revenu</option></select></label>`}
      <p class="form-error" data-err></p>
      <button class="btn btn-primary btn-lg" type="submit">Enregistrer</button></form>`,
    onMount(el, close) {
      const f = el.querySelector('form');
      setTimeout(() => f.name.focus(), 250);
      f.onsubmit = async (e) => {
        e.preventDefault();
        const name = f.name.value.trim();
        const k = existing ? existing.kind : f.kind.value;
        if (!name) return showErr(el, 'Indiquez un nom.');
        if (S.state.categories.some((c) => c.kind === k && c.id !== existing?.id && normalizeName(c.name) === normalizeName(name))) {
          return showErr(el, 'Cette catégorie existe déjà.');
        }
        let created = null;
        await commit((st) => {
          if (existing) st.categories.find((c) => c.id === existing.id).name = name;
          else { created = { id: uid(), name, kind: k }; st.categories.push(created); }
        }, existing ? 'Catégorie renommée.' : 'Catégorie ajoutée.');
        close();
        if (created && created.kind === kind) onCreated?.(created);
      };
    },
  });
}

function viewCategories() {
  const used = new Map();
  for (const o of S.state.ops) if (o.categoryId) used.set(o.categoryId, (used.get(o.categoryId) || 0) + 1);
  const block = (kind, title) => `
    <section class="card">
      <header class="card-head"><h3>${title}</h3><button class="link" data-action="new-category" data-kind="${kind}">${icon('plus')} Ajouter</button></header>
      <div class="op-list">${S.state.categories.filter((c) => c.kind === kind).map((c) => `
        <div class="cat-row"><span class="op-main"><span class="op-title">${esc(c.name)}</span><span class="op-sub">${used.get(c.id) || 0} opération(s)</span></span>
          <button class="icon-btn" data-action="rename-category" data-id="${c.id}" aria-label="Renommer">${icon('edit')}</button>
          ${['e12', 'i6'].includes(c.id) ? '' : `<button class="icon-btn" data-action="delete-category" data-id="${c.id}" aria-label="Supprimer">${icon('trash')}</button>`}
        </div>`).join('')}</div>
    </section>`;
  return block('expense', 'Catégories de dépenses') + block('income', 'Sources de revenus');
}

async function deleteCategory(id) {
  const c = catById(id);
  const n = S.state.ops.filter((o) => o.categoryId === id).length;
  const fallback = c.kind === 'expense' ? 'e12' : 'i6';
  const ok = await confirmDialog({
    title: `Supprimer « ${c.name} » ?`,
    message: n ? `${n} opération(s) seront déplacées vers « Autres ».` : 'Cette catégorie n’est utilisée par aucune opération.',
    confirmLabel: 'Supprimer', danger: true,
  });
  if (!ok) return;
  await commit((st) => {
    if (!st.categories.some((x) => x.id === fallback)) st.categories.push({ id: fallback, name: 'Autres', kind: c.kind });
    for (const o of st.ops) if (o.categoryId === id) o.categoryId = fallback;
    st.categories = st.categories.filter((x) => x.id !== id);
  }, 'Catégorie supprimée.');
}

/* ============================================================ réglages */

function settingsItem({ href, action, ic, title, sub = '', right = '' }) {
  const tag = href ? `a href="${href}"` : `button data-action="${action}"`;
  const close = href ? 'a' : 'button';
  return `<${tag} class="set-row">${icon(ic)}<span class="op-main"><span class="op-title">${title}</span>${sub ? `<span class="op-sub">${sub}</span>` : ''}</span>${right || icon('chevron', 'chev')}</${close}>`;
}

function viewSettings() {
  const st = S.state;
  const cur = st.settings.currency;
  return `
  <h4 class="section-title">Général</h4>
  <section class="list-card">
    <label class="set-row">${icon('coins')}<span class="op-main"><span class="op-title">Devise</span></span>
      <select id="currency" class="inline-select">${Object.entries(CURRENCIES).map(([c, v]) => `<option value="${c}" ${c === cur ? 'selected' : ''}>${c} (${esc(v.symbol)})</option>`).join('')}</select></label>
    <div class="set-row">${icon('sun')}<span class="op-main"><span class="op-title">Thème</span></span>
      <div class="segmented sm inline">
        ${[['dark', 'Sombre'], ['light', 'Clair'], ['auto', 'Auto']].map(([k, l]) => `<button class="${S.prefs.theme === k ? 'on' : ''}" data-action="theme" data-v="${k}">${l}</button>`).join('')}
      </div></div>
  </section>

  <h4 class="section-title">Gestion</h4>
  <section class="list-card">
    ${settingsItem({ href: '#accounts', ic: 'wallet', title: 'Comptes et réserves', sub: `${st.accounts.length} compte(s)` })}
    ${settingsItem({ href: '#euro', ic: 'euro', title: 'Euro', sub: 'Clients qui me doivent / clients à payer' })}
    ${settingsItem({ href: '#categories', ic: 'tag', title: 'Catégories', sub: `${st.categories.length} catégories` })}
  </section>

  <h4 class="section-title">Protection</h4>
  <section class="list-card">
    ${settingsItem({ href: '#security', ic: 'shield', title: 'Sécurité et authentification', sub: 'PIN, empreinte, verrouillage automatique' })}
    ${settingsItem({ href: '#backup', ic: 'download', title: 'Sauvegarde et restauration', sub: st.meta.lastBackupAt ? `Dernière : ${dateLabel(toISODate(new Date(st.meta.lastBackupAt)))}` : 'Jamais sauvegardé' })}
    ${settingsItem({ href: '#install', ic: 'phone', title: "Installer l'application", sub: isStandalone() ? 'Installée' : 'Ajouter à l’écran d’accueil' })}
  </section>

  <h4 class="section-title">Confidentialité</h4>
  <section class="card privacy">
    <p>${icon('shield')} Vos données financières sont chiffrées et stockées uniquement sur cet appareil. My Wallet n'a ni serveur, ni compte, ni statistiques d'usage : le site sert seulement à télécharger les fichiers de l'application.</p>
  </section>

  <h4 class="section-title">Zone sensible</h4>
  <section class="list-card">
    ${settingsItem({ action: 'reset', ic: 'trash', title: '<span class="neg">Réinitialiser l’application</span>', sub: 'Efface définitivement toutes les données de cet appareil' })}
  </section>
  <p class="version">My Wallet · version ${APP_VERSION}</p>`;
}

afterRender.settings = (v) => {
  v.querySelector('#currency').onchange = async (e) => {
    const c = e.target.value;
    view.currency = c;
    await commit((st) => { st.settings.currency = c; }, `Devise : ${c}`);
  };
};

function viewSecurity() {
  const st = S.state;
  return `
  <section class="list-card">
    <div class="set-row" id="bioRow">${icon('fingerprint')}<span class="op-main"><span class="op-title">Empreinte digitale</span><span class="op-sub" id="bioSub">Vérification…</span></span>
      <span id="bioBtn"></span></div>
    ${settingsItem({ action: 'change-pin', ic: 'lock', title: 'Modifier le code PIN' })}
    <label class="set-row">${icon('refresh')}<span class="op-main"><span class="op-title">Verrouillage automatique</span><span class="op-sub">Après inactivité ou en arrière-plan</span></span>
      <select id="autolock" class="inline-select">
        ${[[0, 'Immédiat'], [1, '1 min'], [2, '2 min'], [5, '5 min'], [10, '10 min'], [30, '30 min']].map(([v, l]) => `<option value="${v}" ${st.settings.autoLockMinutes === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select></label>
    <label class="set-row">${icon('eyeOff')}<span class="op-main"><span class="op-title">Masquer les montants</span><span class="op-sub">Mode discrétion (icône œil en haut)</span></span>
      <span class="switch"><input type="checkbox" id="maskSw" ${view.masked ? 'checked' : ''}><i></i></span></label>
    ${settingsItem({ action: 'lock', ic: 'lock', title: 'Verrouiller maintenant' })}
  </section>

  <h4 class="section-title">Comment vos données sont protégées</h4>
  <section class="card prose">
    <p><b>Chiffrement.</b> Toutes vos données financières sont chiffrées avec AES-GCM 256 bits (Web Crypto API). La clé de chiffrement est elle-même chiffrée par une clé dérivée de votre code PIN (PBKDF2-SHA-256, 600 000 itérations, sel aléatoire). Le PIN n'est jamais enregistré. Une fois l'application verrouillée, la clé est effacée de la mémoire : les données stockées sont illisibles sans votre PIN ou votre empreinte.</p>
    <p><b>Empreinte digitale.</b> L'application utilise WebAuthn, le mécanisme standard du navigateur. Elle ne lit ni votre empreinte ni le code de verrouillage Android : c'est Android qui vérifie votre identité puis donne une réponse signée au navigateur.</p>
    <p><b>Mode « clé biométrique » (PRF)</b> : si votre navigateur le permet, l'empreinte débloque une clé secrète qui déchiffre réellement vos données. <b>Mode « verrou simple »</b> : si cette extension n'est pas disponible, la clé est conservée par le navigateur et l'empreinte n'est qu'un verrou d'interface ; quelqu'un ayant un accès technique avancé au téléphone déverrouillé pourrait contourner ce verrou. Le PIN reste alors la vraie protection.</p>
    <p><b>Limites.</b> Un PIN court peut être deviné par un attaquant qui copierait les fichiers du navigateur : préférez 6 chiffres ou plus. Une PWA ne peut pas empêcher les captures d'écran. Si vous effacez les données du navigateur ou désinstallez l'application, tout est perdu sans sauvegarde. Sans votre PIN, aucune récupération n'est possible : c'est le prix de la confidentialité.</p>
  </section>`;
}

afterRender.security = async (v) => {
  v.querySelector('#autolock').onchange = async (e) => {
    const m = Number(e.target.value);
    await commit((st) => { st.settings.autoLockMinutes = m; }, 'Verrouillage automatique mis à jour.');
  };
  v.querySelector('#maskSw').onchange = async (e) => { view.masked = e.target.checked; S.prefs.masked = view.masked; await savePrefs(); render(); };
  const sub = v.querySelector('#bioSub');
  const btn = v.querySelector('#bioBtn');
  const bio = await db.get('bio');
  const support = await biometricSupport();
  if (!sub.isConnected) return;
  if (bio) {
    sub.textContent = bio.mode === 'prf' ? 'Activée — clé biométrique (PRF)' : 'Activée — verrou simple (PRF non disponible)';
    btn.innerHTML = '<button class="btn btn-ghost sm" data-action="bio-off">Désactiver</button>';
  } else if (support.ok) {
    sub.textContent = 'Déverrouiller avec le capteur du téléphone';
    btn.innerHTML = '<button class="btn btn-primary sm" data-action="bio-on">Activer</button>';
  } else {
    sub.textContent = support.reason;
  }
};

async function enableBiometric() {
  try {
    const meta = await withAutoLockPaused(() => enrollBiometric(S.raw));
    await db.set('bio', meta);
    toast(meta.mode === 'prf'
      ? 'Empreinte activée : elle protège la clé de chiffrement.'
      : 'Empreinte activée en mode verrou simple (votre navigateur ne gère pas l’extension PRF).', { type: 'success', duration: 6000 });
  } catch (e) {
    if (e?.name === 'NotAllowedError') toast('Activation annulée.');
    else toast("Impossible d'activer l'empreinte : " + e.message, { type: 'error' });
  }
  render();
}

function openChangePin() {
  openSheet({
    title: 'Modifier le code PIN',
    className: 'sheet-dialog',
    body: `<form class="form" autocomplete="off">
      <label class="field"><span>Code actuel</span><input type="password" name="old" inputmode="numeric" pattern="\\d*" required autocomplete="current-password"></label>
      <label class="field"><span>Nouveau code (4 à 12 chiffres)</span><input type="password" name="n1" inputmode="numeric" pattern="\\d*" required autocomplete="new-password"></label>
      <label class="field"><span>Confirmer le nouveau code</span><input type="password" name="n2" inputmode="numeric" pattern="\\d*" required autocomplete="new-password"></label>
      <p class="form-error" data-err></p>
      <button class="btn btn-primary btn-lg" type="submit">Modifier</button></form>`,
    onMount(el, close) {
      const f = el.querySelector('form');
      f.onsubmit = async (e) => {
        e.preventDefault();
        if (!/^\d{4,12}$/.test(f.n1.value)) return showErr(el, 'Le code doit contenir 4 à 12 chiffres.');
        if (f.n1.value !== f.n2.value) return showErr(el, 'Les nouveaux codes ne correspondent pas.');
        busy(true, 'Vérification…');
        try {
          const keymeta = await db.get('keymeta');
          await unwrapWithPin(f.old.value, keymeta);
          await db.set('keymeta', await wrapWithPin(S.raw, f.n1.value));
          close();
          toast('Code PIN modifié.', { type: 'success' });
        } catch (err) {
          showErr(el, err instanceof WrongSecretError ? 'Code actuel incorrect.' : err.message);
        } finally { busy(false); }
      };
    },
  });
}

/* ------------------------------------------------------------ sauvegarde */

function viewBackup() {
  const st = S.state;
  const last = st.meta.lastBackupAt;
  const days = last ? Math.floor((Date.now() - last) / 86_400_000) : null;
  return `
  <section class="total-card ${last && days <= st.settings.backupReminderDays ? '' : 'tc-red'}">
    <span>Dernière sauvegarde</span>
    <b>${last ? (days === 0 ? "Aujourd'hui" : `Il y a ${days} jour${days > 1 ? 's' : ''}`) : 'Jamais'}</b>
    <div class="split"><span>${st.ops.length} opérations · ${st.accounts.length} comptes</span></div>
  </section>
  <section class="list-card">
    ${settingsItem({ action: 'export-backup', ic: 'download', title: 'Exporter une sauvegarde chiffrée', sub: 'Fichier .json protégé par un mot de passe' })}
    ${settingsItem({ action: 'import-backup', ic: 'upload', title: 'Restaurer une sauvegarde', sub: 'Remplace les données actuelles après confirmation' })}
    ${settingsItem({ action: 'export-csv', ic: 'file', title: "Exporter l'historique en CSV", sub: 'Pour Excel (non chiffré)' })}
    <label class="set-row">${icon('alert')}<span class="op-main"><span class="op-title">Rappel de sauvegarde</span></span>
      <select id="remind" class="inline-select">
        ${[[3, 'Tous les 3 jours'], [7, 'Chaque semaine'], [14, 'Toutes les 2 semaines'], [30, 'Chaque mois'], [0, 'Jamais']].map(([v, l]) => `<option value="${v}" ${st.settings.backupReminderDays === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select></label>
  </section>
  <section class="card prose">
    <p><b>Où est enregistré le fichier ?</b> Dans le dossier <i>Téléchargements</i> de votre Samsung (application <i>Mes fichiers</i>). Copiez-le régulièrement ailleurs (clé USB, ordinateur) : si le téléphone est perdu, la sauvegarde l'est aussi.</p>
    <p><b>Mot de passe.</b> Il est indépendant de votre PIN. Notez-le en lieu sûr : sans lui, la sauvegarde est indéchiffrable, même pour vous.</p>
    <p><b>Le fichier CSV n'est pas chiffré.</b> Ne le partagez pas et supprimez-le après consultation.</p>
  </section>`;
}

afterRender.backup = (v) => {
  v.querySelector('#remind').onchange = (e) => commit((st) => { st.settings.backupReminderDays = Number(e.target.value); }, 'Rappel mis à jour.');
};

async function exportBackup() {
  const pw = await askPassword({
    title: 'Mot de passe de sauvegarde',
    message: 'Choisissez un mot de passe (8 caractères minimum). Il sera demandé pour restaurer.',
    confirm: true,
    submitLabel: 'Exporter',
  });
  if (!pw) return;
  busy(true, 'Chiffrement de la sauvegarde…');
  try {
    S.state.meta.lastBackupAt = Date.now();
    const blob = await createBackup(S.state, pw);
    await withAutoLockPaused(async () => downloadBlob(blob, `my-wallet-sauvegarde-${today()}.json`));
    await persist();
    render();
    toast('Sauvegarde enregistrée dans Téléchargements.', { type: 'success' });
  } catch (e) {
    toast('Échec de la sauvegarde : ' + e.message, { type: 'error' });
  } finally { busy(false); }
}

/** Sélection d'un fichier puis vérification. Appelle onState(state). */
function pickBackupFile(onState) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json,text/plain,application/octet-stream';
  S.pauseAutoLock = true;
  input.onchange = async () => {
    S.pauseAutoLock = false;
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 50 * 1024 * 1024) { toast('Fichier trop volumineux.', { type: 'error' }); return; }
    const text = await file.text();
    const pw = await askPassword({ title: 'Mot de passe de la sauvegarde', message: file.name, submitLabel: 'Vérifier' });
    if (!pw) return;
    busy(true, 'Vérification de la sauvegarde…');
    try {
      const { state } = await readBackup(text, pw);
      busy(false);
      await onState(state);
    } catch (e) {
      busy(false);
      toast(e.message, { type: 'error', duration: 5000 });
    }
  };
  window.addEventListener('focus', () => setTimeout(() => { S.pauseAutoLock = false; }, 1000), { once: true });
  input.click();
}

function importBackup() {
  pickBackupFile(async (state) => {
    const ok = await confirmDialog({
      title: 'Remplacer vos données ?',
      message: `La sauvegarde contient ${state.ops.length} opération(s) et ${state.accounts.length} compte(s). Vos données actuelles (${S.state.ops.length} opérations) seront remplacées.`,
      confirmLabel: 'Restaurer', danger: true,
    });
    if (!ok) return;
    S.state = state;
    view.currency = state.settings.currency;
    await persist();
    location.hash = '#home';
    render();
    toast('Sauvegarde restaurée.', { type: 'success' });
  });
}

function exportCSV(ops) {
  if (!ops.length) { toast('Aucune opération à exporter.'); return; }
  withAutoLockPaused(async () => downloadBlob(opsToCSV(S.state, ops), `my-wallet-historique-${today()}.csv`));
  toast('Fichier CSV enregistré dans Téléchargements.', { type: 'success' });
}

/* ------------------------------------------------------------ installation */

function isStandalone() {
  return matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches || navigator.standalone === true;
}

function viewInstall() {
  const installed = isStandalone();
  const ua = navigator.userAgent;
  const samsung = /SamsungBrowser/i.test(ua);
  return `
  <section class="total-card ${installed ? 'tc-green' : ''}">
    <span>Statut</span>
    <b>${installed ? 'Application installée ✓' : S.installPrompt ? 'Prête à être installée' : 'Non installée'}</b>
    <div class="split"><span>${installed ? 'Vous utilisez My Wallet en mode application.' : samsung ? 'Navigateur détecté : Samsung Internet' : /Chrome/i.test(ua) ? 'Navigateur détecté : Chrome' : 'Navigateur web'}</span></div>
  </section>
  ${!installed && S.installPrompt ? `<button class="btn btn-primary btn-lg" data-action="install">${icon('download')} Installer l'application</button>` : ''}
  <section class="card prose">
    <h3>Une vraie application, pas un raccourci</h3>
    <p>Installée correctement, My Wallet devient une application Android à part entière : elle apparaît dans la liste de vos applications, s'ouvre en plein écran sans barre d'adresse, a sa propre fenêtre dans les applications récentes et figure dans Paramètres › Applications.</p>
    <p>Si l'icône sur votre écran d'accueil porte un <b>petit logo Chrome</b> dans un coin, c'est seulement un raccourci. Supprimez-le, puis suivez les étapes ci-dessous en choisissant bien <b>Installer l'application</b> (et non « Ajouter à l'écran d'accueil »). Vos données ne sont pas perdues : elles restent dans le navigateur.</p>
  </section>
  <section class="card prose">
    <h3>Google Chrome (Android)</h3>
    <ol>
      <li>Ouvrez l'adresse de My Wallet dans Chrome.</li>
      <li>Touchez le menu <b>⋮</b> en haut à droite.</li>
      <li>Choisissez <b>Installer l'application</b> (ou <b>Ajouter à l'écran d'accueil</b>).</li>
      <li>Confirmez avec <b>Installer</b>. L'icône My Wallet apparaît sur l'écran d'accueil.</li>
    </ol>
    <h3>Samsung Internet</h3>
    <ol>
      <li>Ouvrez l'adresse de My Wallet dans Samsung Internet.</li>
      <li>Touchez l'icône de téléchargement <b>⤓</b> dans la barre d'adresse si elle apparaît, ou le menu <b>≡</b> en bas à droite.</li>
      <li>Choisissez <b>Ajouter la page à</b> › <b>Écran d'accueil</b>.</li>
      <li>Confirmez avec <b>Ajouter</b>.</li>
    </ol>
    <p class="hint">${icon('info')} Après l'installation, My Wallet s'ouvre en plein écran et fonctionne sans Internet. Les données sont propres au navigateur utilisé pour l'installation : installez-la depuis le navigateur où vous l'utilisez déjà, ou restaurez une sauvegarde.</p>
  </section>`;
}

async function installApp() {
  const p = S.installPrompt;
  if (!p) return;
  p.prompt();
  const { outcome } = await p.userChoice;
  S.installPrompt = null;
  if (outcome === 'accepted') toast('Installation en cours…', { type: 'success' });
  render();
}

/* ------------------------------------------------------------ réinitialisation */

async function resetApp() {
  const a = await confirmDialog({
    title: 'Réinitialiser My Wallet ?',
    message: 'Toutes vos données (comptes, opérations, prêts, dettes, réglages) seront définitivement effacées de cet appareil. Pensez à faire une sauvegarde avant.',
    confirmLabel: 'Continuer', danger: true,
  });
  if (!a) return;
  const b = await confirmDialog({
    title: 'Dernière confirmation',
    message: 'Cette action est irréversible.',
    confirmLabel: 'Tout effacer', danger: true, requireText: 'SUPPRIMER',
  });
  if (!b) return;
  await db.clear();
  S.raw?.fill(0);
  S.unlocked = false;
  S.state = null;
  location.hash = '';
  location.reload();
}

/* ============================================================ actions */

function openAddMenu() {
  const items = [
    ['expense', 'Dépense', 'q-exp'], ['income', 'Revenu', 'q-inc'], ['transfer', 'Transfert', 'q-trf'],
    ['loan', 'Prêt accordé', 'q-loan'], ['debt', 'Dette', 'q-debt'], ['repay', 'Remboursement', 'q-rep'],
  ];
  openSheet({
    title: 'Ajouter',
    body: `<div class="add-grid">${items.map(([t, l, c]) => `
      <button data-action="new-op" data-type="${t}"><span class="q-ic ${c}">${icon(t === 'repay' ? 'repay' : t)}</span>${l}</button>`).join('')}</div>`,
  });
}

async function onAction(e) {
  const el = e.target.closest('[data-action]');
  if (!el || !S.unlocked) return;
  const d = el.dataset;
  switch (d.action) {
    case 'lock': lock(); break;
    case 'toggle-mask':
      view.masked = !view.masked;
      S.prefs.masked = view.masked;
      await savePrefs();
      render();
      break;
    case 'add-menu': openAddMenu(); break;
    case 'new-op':
      closeAllSheets();
      openOpForm(d.type, null, { person: d.person, ref: d.ref, dir: d.dir });
      break;
    case 'op-detail': closeAllSheets(); openOpDetail(d.id); break;
    case 'edit-op': { const o = opById(d.id); if (o) { closeAllSheets(); openOpForm(o.type, o); } break; }
    case 'delete-op': deleteOpWithUndo(d.id); break;
    case 'convert-loan': convertLoan(d.id); break;
    case 'euro-tab': S.euroTab = d.tab; render(); break;
    case 'euro-form': openEuroForm(d.kind || S.euroTab, d.id); break;
    case 'euro-done': markEuro(d.id, true); break;
    case 'euro-undo': markEuro(d.id, false); break;
    case 'euro-balance': openEuroBalance(); break;
    case 'euro-settled': S.euroShowDone = !S.euroShowDone; render(); break;
    case 'person': closeAllSheets(); openPerson(d.key); break;
    case 'account-detail': openAccountDetail(d.id); break;
    case 'account-form': closeAllSheets(); openAccountForm(d.id); break;
    case 'asset-form': openAssetForm(d.id); break;
    case 'reveal-savings': S.revealSavings = !S.revealSavings; render(); break;
    case 'filter-account':
      closeAllSheets();
      S.filters = { accountId: d.id };
      location.hash = '#history';
      break;
    case 'people-tab':
      S.peopleTab = d.tab;
      if (route() === 'people') render();
      break;
    case 'toggle-settled': S.showSettled = !S.showSettled; render(); break;
    case 'filters': openFilters(); break;
    case 'clear-filter':
      if (d.k === 'range') { delete S.filters.from; delete S.filters.to; } else delete S.filters[d.k];
      render();
      break;
    case 'quick-filter': S.filters[d.k] = d.v; render(); break;
    case 'more-history': S.historyLimit += 150; drawHistoryList(); break;
    case 'export-csv-filtered': exportCSV(filterOps(S.state, S.filters)); break;
    case 'export-csv': exportCSV(filterOps(S.state, {})); break;
    case 'export-backup': exportBackup(); break;
    case 'import-backup': importBackup(); break;
    case 'theme':
      S.prefs.theme = d.v;
      await savePrefs();
      applyTheme();
      render();
      break;
    case 'change-pin': openChangePin(); break;
    case 'bio-on': enableBiometric(); break;
    case 'bio-off':
      if (await confirmDialog({ title: "Désactiver l'empreinte ?", message: 'Seul le code PIN permettra de déverrouiller.', confirmLabel: 'Désactiver' })) {
        await db.del('bio');
        toast('Empreinte désactivée.');
        render();
      }
      break;
    case 'install': installApp(); break;
    case 'reset': resetApp(); break;
    case 'new-category': promptCategory(d.kind); break;
    case 'rename-category': promptCategory(null, null, catById(d.id)); break;
    case 'delete-category': deleteCategory(d.id); break;
    default: break;
  }
}

/* ============================================================ service worker */

const APP_VERSION = '1.1.0';

let updateRequested = false;

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./service-worker.js').then((reg) => {
    const notify = (w) => {
      toast('Une nouvelle version de My Wallet est disponible.', {
        action: { label: 'Mettre à jour', run: () => { updateRequested = true; w.postMessage('SKIP_WAITING'); } },
      });
    };
    if (reg.waiting && navigator.serviceWorker.controller) notify(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) notify(w);
      });
    });
  }).catch((e) => console.warn('Service worker non enregistré', e));
  let reloading = false;
  // Recharge uniquement après une mise à jour demandée (pas lors de la première installation).
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading || !updateRequested) return;
    reloading = true;
    location.reload();
  });
}

boot();
