/**
 * My Wallet — moteur de calcul centralisé.
 *
 * Toutes les valeurs affichées sont recalculées à partir de :
 *   - le solde initial de chaque compte,
 *   - le journal des opérations.
 * Aucune statistique n'est stockée : modifier ou supprimer une opération
 * suffit pour que tous les indicateurs soient à jour.
 *
 * Les montants sont des entiers en centimes (pas d'erreurs d'arrondi).
 * Les dates sont des chaînes locales « AAAA-MM-JJ ».
 *
 * Module pur (aucun accès au DOM ni au stockage) : testable sous Node.
 */

/** Types d'opérations et leur effet comptable. */
export const OP_TYPES = {
  expense:    { label: 'Dépense',               short: 'Dépense' },
  income:     { label: 'Revenu',                short: 'Revenu' },
  transfer:   { label: 'Transfert',             short: 'Transfert' },
  loan:       { label: 'Prêt accordé',          short: 'Prêt' },
  loan_repay: { label: 'Remboursement reçu',    short: 'Remb. reçu' },
  debt:       { label: 'Dette enregistrée',     short: 'Dette' },
  debt_repay: { label: 'Remboursement effectué', short: 'Remb. effectué' },
};

export const ACCOUNT_TYPES = {
  cash: 'Espèces',
  bank: 'Compte courant',
  savings: 'Épargne',
  other: 'Autre',
};

/* ---------------------------------------------------------------- dates */

export function pad(n) { return String(n).padStart(2, '0'); }

export function toISODate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseISODate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function monthKey(dateStr) { return dateStr.slice(0, 7); }

export function addMonths(key, delta) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

export function addDays(dateStr, delta) {
  const d = parseISODate(dateStr);
  d.setDate(d.getDate() + delta);
  return toISODate(d);
}

/** Lundi de la semaine contenant la date. */
export function weekStart(dateStr) {
  const d = parseISODate(dateStr);
  const day = (d.getDay() + 6) % 7; // lundi = 0
  d.setDate(d.getDate() - day);
  return toISODate(d);
}

export function isValidISODate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = parseISODate(s);
  return toISODate(d) === s;
}

/* -------------------------------------------------------------- montants */

/** « 10 000,50 » → 1000050 centimes. Retourne NaN si invalide. */
export function parseAmount(input) {
  if (typeof input === 'number') return Math.round(input * 100);
  const s = String(input ?? '')
    .replace(/[\s  ]/g, '')
    .replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
  return Math.round(parseFloat(s) * 100);
}

/** Centimes → chaîne éditable (« 10000 » ou « 10000,5 »). */
export function amountToInput(cents) {
  const v = cents / 100;
  return Number.isInteger(v) ? String(v) : String(v).replace('.', ',');
}

/* ------------------------------------------------- effets sur les comptes */

/**
 * Effet d'une opération sur les comptes : liste de [accountId, delta].
 * C'est la SEULE règle qui touche à l'argent disponible.
 */
export function opDeltas(op) {
  const a = op.amount;
  switch (op.type) {
    case 'income':
    case 'loan_repay':          // l'argent revient : +disponible, −créance
      return [[op.accountId, a]];
    case 'expense':
    case 'loan':                // l'argent sort : −disponible, +créance
    case 'debt_repay':          // −disponible, −dette
      return [[op.accountId, -a]];
    case 'transfer':            // neutre pour le patrimoine
      return [[op.accountId, -a], [op.toAccountId, a]];
    case 'debt':                // emprunt : +disponible seulement si encaissé
      return op.accountId ? [[op.accountId, a]] : [];
    default:
      return [];
  }
}

export function computeBalances(state, untilDate = null) {
  const balances = new Map();
  // Le solde de départ sert de base sur toute la période : les courbes ne montrent
  // ainsi que l'effet réel des opérations (pas de « saut » le jour de création du compte).
  for (const acc of state.accounts) balances.set(acc.id, acc.initial || 0);
  for (const op of state.ops) {
    if (untilDate && op.date > untilDate) continue;
    for (const [id, d] of opDeltas(op)) {
      if (balances.has(id)) balances.set(id, balances.get(id) + d);
    }
  }
  return balances;
}

export function totalAvailable(state, untilDate = null) {
  let t = 0;
  for (const v of computeBalances(state, untilDate).values()) t += v;
  return t;
}

/* --------------------------------------------------- prêts et dettes */

export function normalizeName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('fr');
}

/**
 * Liste des prêts (kind 'loan') et dettes (kind 'debt') avec remboursements,
 * reste dû et statut.
 */
export function computeLoans(state, today = null) {
  const map = new Map();
  for (const op of state.ops) {
    if (op.type === 'loan' || op.type === 'debt') {
      map.set(op.id, {
        id: op.id,
        op,
        kind: op.type,
        person: op.person,
        personKey: normalizeName(op.person),
        amount: op.amount,
        date: op.date,
        dueDate: op.dueDate || null,
        repaid: 0,
        repayments: [],
      });
    }
  }
  for (const op of state.ops) {
    if (op.type === 'loan_repay' || op.type === 'debt_repay') {
      const l = map.get(op.refId);
      if (!l) continue;
      l.repaid += op.amount;
      l.repayments.push(op);
    }
  }
  const list = [...map.values()];
  for (const l of list) {
    l.remaining = Math.max(0, l.amount - l.repaid);
    l.status = l.remaining === 0 ? 'repaid' : l.repaid > 0 ? 'partial' : 'open';
    l.overdue = !!(today && l.dueDate && l.remaining > 0 && l.dueDate < today);
    l.repayments.sort(byDateDesc);
  }
  list.sort(byDateDesc);
  return list;
}

export const STATUS_LABELS = {
  open: 'En cours',
  partial: 'Partiellement remboursé',
  repaid: 'Remboursé',
};

/** Regroupe prêts/dettes par personne. */
export function groupByPerson(loans) {
  const people = new Map();
  for (const l of loans) {
    let p = people.get(l.personKey);
    if (!p) {
      p = { key: l.personKey, name: l.person, lent: 0, borrowed: 0, items: [], lastDate: l.date };
      people.set(l.personKey, p);
    }
    if (l.kind === 'loan') p.lent += l.remaining; else p.borrowed += l.remaining;
    p.items.push(l);
    if (l.date > p.lastDate) p.lastDate = l.date;
  }
  return [...people.values()];
}

/* ------------------------------------------------------- statistiques */

function sumWhere(ops, pred) {
  let t = 0;
  for (const op of ops) if (pred(op)) t += op.amount;
  return t;
}

/**
 * Tous les indicateurs du tableau de bord.
 * @param {string} today date de référence AAAA-MM-JJ
 */
export function computeSummary(state, today) {
  const balances = computeBalances(state);
  let available = 0;
  for (const v of balances.values()) available += v;

  // Répartition du disponible : argent utilisable au quotidien / épargne.
  let reserved = 0;
  for (const acc of state.accounts) if (acc.type === 'savings') reserved += balances.get(acc.id) || 0;
  const spendable = available - reserved;

  const loans = computeLoans(state, today);
  let receivables = 0, debts = 0;
  for (const l of loans) {
    if (l.kind === 'loan') receivables += l.remaining; else debts += l.remaining;
  }
  const otherAssets = (state.assets || []).reduce((t, a) => t + (a.value || 0), 0);

  // Fortune totale = tout ce que je possède (sans retirer les dettes).
  const totalWealth = available + receivables + otherAssets;
  // Patrimoine net = disponible + créances (+ autres actifs) − dettes.
  const net = totalWealth - debts;

  const month = monthKey(today);
  const prevMonth = addMonths(month, -1);
  const inMonth = (m) => (op) => monthKey(op.date) === m;

  const incomeMonth = sumWhere(state.ops, (o) => o.type === 'income' && inMonth(month)(o));
  const expenseMonth = sumWhere(state.ops, (o) => o.type === 'expense' && inMonth(month)(o));
  const incomePrev = sumWhere(state.ops, (o) => o.type === 'income' && inMonth(prevMonth)(o));
  const expensePrev = sumWhere(state.ops, (o) => o.type === 'expense' && inMonth(prevMonth)(o));

  const ws = weekStart(today);
  const we = addDays(ws, 6);
  const expenseWeek = sumWhere(state.ops, (o) => o.type === 'expense' && o.date >= ws && o.date <= we);

  const savings = incomeMonth - expenseMonth;
  const savingsRate = incomeMonth > 0 ? savings / incomeMonth : null;

  const repaidReceived = sumWhere(state.ops, (o) => o.type === 'loan_repay');
  const repaidMade = sumWhere(state.ops, (o) => o.type === 'debt_repay');

  // Évolution du disponible sur le mois en cours.
  const endPrevMonth = addDays(`${month}-01`, -1);
  const availableStartMonth = totalAvailable(state, endPrevMonth);

  return {
    balances,
    available,
    spendable,
    reserved,
    receivables,
    debts,
    otherAssets,
    totalWealth,
    net,
    month,
    prevMonth,
    incomeMonth,
    expenseMonth,
    incomePrev,
    expensePrev,
    savings,
    savingsRate,
    expenseWeek,
    repaidReceived,
    repaidMade,
    availableStartMonth,
    availableChangeMonth: available - availableStartMonth,
    loans,
  };
}

/** Variation relative (null si pas de base). */
export function pctChange(current, previous) {
  if (!previous) return null;
  return (current - previous) / previous;
}

/** Dépenses d'un mois par catégorie, triées décroissantes. */
export function expensesByCategory(state, month) {
  const map = new Map();
  for (const op of state.ops) {
    if (op.type !== 'expense' || monthKey(op.date) !== month) continue;
    map.set(op.categoryId, (map.get(op.categoryId) || 0) + op.amount);
  }
  const cats = new Map(state.categories.map((c) => [c.id, c]));
  return [...map.entries()]
    .map(([id, amount]) => ({ id, name: cats.get(id)?.name || 'Sans catégorie', amount }))
    .sort((a, b) => b.amount - a.amount);
}

/** Revenus et dépenses sur les n derniers mois (le plus ancien d'abord). */
export function monthlySeries(state, today, n = 6) {
  const cur = monthKey(today);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const m = addMonths(cur, -i);
    out.push({
      month: m,
      income: sumWhere(state.ops, (o) => o.type === 'income' && monthKey(o.date) === m),
      expense: sumWhere(state.ops, (o) => o.type === 'expense' && monthKey(o.date) === m),
    });
  }
  return out;
}

/** Argent disponible en fin de journée sur les n derniers jours. */
export function availableSeries(state, today, days = 30) {
  const start = addDays(today, -(days - 1));
  // Solde à la veille du début, puis on applique les deltas jour par jour.
  const dayDelta = new Map();
  for (const op of state.ops) {
    if (op.date < start || op.date > today) continue;
    let t = 0;
    for (const [, v] of opDeltas(op)) t += v;
    dayDelta.set(op.date, (dayDelta.get(op.date) || 0) + t);
  }
  let running = totalAvailable(state, addDays(start, -1));
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(start, i);
    running += dayDelta.get(d) || 0;
    out.push({ date: d, value: running });
  }
  return out;
}

/* ----------------------------------------------------------- tri, filtres */

export function byDateDesc(a, b) {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  return (b.createdAt || 0) - (a.createdAt || 0);
}

/**
 * Filtre l'historique.
 * filters: { type, categoryId, month 'AAAA-MM', year 'AAAA', from, to, accountId, query }
 */
export function filterOps(state, filters = {}) {
  const cats = new Map(state.categories.map((c) => [c.id, c.name]));
  const accs = new Map(state.accounts.map((a) => [a.id, a.name]));
  const q = normalizeName(filters.query || '');
  const parents = q ? new Map(state.ops.map((o) => [o.id, o])) : null;
  return state.ops
    .filter((op) => {
      if (filters.type && op.type !== filters.type) return false;
      if (filters.categoryId && op.categoryId !== filters.categoryId) return false;
      if (filters.accountId && op.accountId !== filters.accountId && op.toAccountId !== filters.accountId) return false;
      if (filters.month && monthKey(op.date) !== filters.month) return false;
      if (filters.year && op.date.slice(0, 4) !== filters.year) return false;
      if (filters.from && op.date < filters.from) return false;
      if (filters.to && op.date > filters.to) return false;
      if (q) {
        const hay = normalizeName([
          op.note, op.person, op.refId && parents.get(op.refId)?.person, cats.get(op.categoryId), accs.get(op.accountId),
          accs.get(op.toAccountId), OP_TYPES[op.type]?.label, String(op.amount / 100),
        ].filter(Boolean).join(' '));
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .sort(byDateDesc);
}

/* ------------------------------------------------------------ validation */

const NEEDS_ACCOUNT = new Set(['expense', 'income', 'transfer', 'loan', 'loan_repay', 'debt_repay']);

/**
 * Vérifie qu'une opération est cohérente avec l'état actuel.
 * @param {object} op opération candidate (op.id présent si modification)
 * @returns {string|null} message d'erreur ou null
 */
export function validateOp(state, op) {
  if (!OP_TYPES[op.type]) return "Type d'opération inconnu.";
  if (!Number.isInteger(op.amount) || op.amount <= 0) return 'Le montant doit être supérieur à zéro.';
  if (!isValidISODate(op.date)) return 'Date invalide.';
  const accIds = new Set(state.accounts.map((a) => a.id));
  if (NEEDS_ACCOUNT.has(op.type) && !accIds.has(op.accountId)) return 'Choisissez un compte.';
  if (op.type === 'debt' && op.accountId && !accIds.has(op.accountId)) return 'Compte inconnu.';
  if (op.type === 'transfer') {
    if (!accIds.has(op.toAccountId)) return 'Choisissez le compte de destination.';
    if (op.toAccountId === op.accountId) return 'Les deux comptes doivent être différents.';
  }
  if (op.type === 'expense' || op.type === 'income') {
    const cat = state.categories.find((c) => c.id === op.categoryId);
    if (!cat || cat.kind !== op.type) return 'Choisissez une catégorie.';
  }
  if (op.type === 'loan' || op.type === 'debt') {
    if (!String(op.person || '').trim()) return 'Indiquez le nom de la personne.';
    if (op.dueDate && !isValidISODate(op.dueDate)) return 'Date de remboursement invalide.';
    if (op.id) {
      const repaid = sumWhere(state.ops, (o) => o.refId === op.id && o.id !== op.id);
      if (op.amount < repaid) return `Le montant ne peut pas être inférieur au total déjà remboursé.`;
    }
  }
  if (op.type === 'loan_repay' || op.type === 'debt_repay') {
    const parentType = op.type === 'loan_repay' ? 'loan' : 'debt';
    const parent = state.ops.find((o) => o.id === op.refId);
    if (!parent || parent.type !== parentType) {
      return op.type === 'loan_repay' ? 'Choisissez le prêt concerné.' : 'Choisissez la dette concernée.';
    }
    const repaidOthers = sumWhere(state.ops, (o) => o.refId === parent.id && o.id !== op.id);
    const remaining = parent.amount - repaidOthers;
    if (op.amount > remaining) return 'Le remboursement dépasse le montant restant dû.';
  }
  return null;
}

/** Identifiants des opérations à supprimer avec op (remboursements liés). */
export function cascadeIds(state, opId) {
  const ids = new Set([opId]);
  for (const o of state.ops) if (o.refId === opId) ids.add(o.id);
  return ids;
}

/** Opérations qui touchent un compte (pour suppression de compte). */
export function opsForAccount(state, accountId) {
  const direct = state.ops.filter((o) => o.accountId === accountId || o.toAccountId === accountId);
  const ids = new Set();
  for (const o of direct) for (const id of cascadeIds(state, o.id)) ids.add(id);
  return ids;
}

/** Contrôle de cohérence global (après restauration d'une sauvegarde). */
export function checkIntegrity(state) {
  const errors = [];
  if (!state || !Array.isArray(state.accounts) || !Array.isArray(state.ops) || !Array.isArray(state.categories)) {
    return ['Structure de données invalide.'];
  }
  const ids = new Set();
  for (const a of state.accounts) {
    if (!a.id || typeof a.name !== 'string' || !Number.isInteger(a.initial)) errors.push('Compte invalide.');
  }
  for (const op of state.ops) {
    if (ids.has(op.id)) errors.push('Identifiant en double.');
    ids.add(op.id);
  }
  // Validation de chaque opération dans un état sans ses remboursements postérieurs n'est
  // pas nécessaire : on vérifie la cohérence finale.
  for (const op of state.ops) {
    const err = validateOp(state, op);
    if (err) errors.push(`${OP_TYPES[op.type]?.label || 'Opération'} du ${op.date} : ${err}`);
  }
  return errors;
}
