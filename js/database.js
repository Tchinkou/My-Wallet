/**
 * My Wallet — stockage local IndexedDB.
 *
 * Une base « mywallet », un magasin clé/valeur « kv » :
 *   keymeta  : paramètres de dérivation + clé de données enveloppée par le PIN
 *   bio      : configuration biométrique (clé de données enveloppée par WebAuthn)
 *   vault    : TOUTES les données financières, chiffrées (AES-GCM)
 *   prefs    : préférences non sensibles (thème) pour l'écran de verrouillage
 *   lockout  : compteur d'essais de PIN
 *
 * Aucune donnée financière n'est jamais écrite en clair.
 */

const DB_NAME = 'mywallet';
const DB_VERSION = 1;
const STORE = 'kv';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Base de données bloquée par un autre onglet.'));
  });
  return dbPromise;
}

function tx(mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    const r = fn(store);
    if (r) r.onsuccess = () => { result = r.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaction annulée'));
  }));
}

export const db = {
  get: (key) => tx('readonly', (s) => s.get(key)),
  set: (key, value) => tx('readwrite', (s) => s.put(value, key)),
  del: (key) => tx('readwrite', (s) => s.delete(key)),
  clear: () => tx('readwrite', (s) => s.clear()),
};

/** Demande au navigateur de ne pas effacer les données en cas de manque d'espace. */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persisted && await navigator.storage.persisted()) return true;
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch { /* non supporté */ }
  return false;
}

/* ----------------------------------------------------- état par défaut */

export function uid() {
  const b = crypto.getRandomValues(new Uint8Array(9));
  return Array.from(b, (x) => x.toString(36).padStart(2, '0')).join('').slice(0, 14);
}

const EXPENSE_CATEGORIES = [
  'Alimentation', 'Transport', 'Carburant', 'Voiture et entretien', 'Logement', 'Santé',
  'Études', 'Shopping', 'Loisirs', 'Restaurants', 'Abonnements', 'Autres',
];
const INCOME_CATEGORIES = ['Salaire', 'Freelance', 'Business', 'Cadeau', 'Remboursement reçu', 'Autres'];

export function defaultCategories() {
  return [
    ...EXPENSE_CATEGORIES.map((name, i) => ({ id: `e${i + 1}`, name, kind: 'expense' })),
    ...INCOME_CATEGORIES.map((name, i) => ({ id: `i${i + 1}`, name, kind: 'income' })),
  ];
}

export function emptyState() {
  return {
    schema: 1,
    settings: {
      currency: 'DZD',
      autoLockMinutes: 2,
      backupReminderDays: 7,
    },
    accounts: [],
    categories: defaultCategories(),
    ops: [],
    assets: [],
    euro: { initial: 0, items: [] },
    meta: { createdAt: Date.now(), lastBackupAt: null },
  };
}

/** Complète un état ancien/importé avec les champs manquants. */
export function migrateState(s) {
  const base = emptyState();
  return {
    ...base,
    ...s,
    settings: { ...base.settings, ...(s.settings || {}) },
    meta: { ...base.meta, ...(s.meta || {}) },
    assets: Array.isArray(s.assets) ? s.assets : [],
    euro: { initial: s.euro?.initial || 0, items: Array.isArray(s.euro?.items) ? s.euro.items : [] },
    categories: Array.isArray(s.categories) && s.categories.length ? s.categories : base.categories,
  };
}
