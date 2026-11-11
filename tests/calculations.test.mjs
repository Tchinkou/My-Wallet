// Tests du moteur de calcul : node --test tests/calculations.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSummary, computeLoans, validateOp, cascadeIds, parseAmount, availableSeries, monthlySeries, filterOps, checkIntegrity,
} from '../js/calculations.js';

const DA = (n) => n * 100;
const T = '2026-11-11';

function scenario() {
  const st = {
    accounts: [{ id: 'cash', name: 'Espèces', type: 'cash', initial: DA(50000), createdAt: '2026-11-01' }],
    categories: [{ id: 'e1', name: 'Alimentation', kind: 'expense' }, { id: 'i1', name: 'Salaire', kind: 'income' }],
    ops: [], assets: [],
  };
  const add = (op) => {
    const full = { id: `op${st.ops.length + 1}`, date: '2026-11-05', createdAt: st.ops.length, ...op };
    const err = validateOp(st, full);
    assert.equal(err, null, `${op.type}: ${err}`);
    st.ops.push(full);
    return full;
  };
  add({ type: 'expense', amount: DA(5000), accountId: 'cash', categoryId: 'e1' });
  add({ type: 'income', amount: DA(20000), accountId: 'cash', categoryId: 'i1' });
  const loan = add({ type: 'loan', amount: DA(10000), accountId: 'cash', person: 'Ahmed' });
  add({ type: 'loan_repay', amount: DA(3000), accountId: 'cash', refId: loan.id });
  const debt = add({ type: 'debt', amount: DA(15000), person: 'Karim' });
  add({ type: 'debt_repay', amount: DA(5000), accountId: 'cash', refId: debt.id });
  return { st, loan, debt, add };
}

test('scénario obligatoire', () => {
  const { st } = scenario();
  const s = computeSummary(st, T);
  assert.equal(s.available, DA(53000));
  assert.equal(s.receivables, DA(7000));
  assert.equal(s.debts, DA(10000));
  assert.equal(s.net, DA(50000));
  // Les prêts, dettes et remboursements ne sont ni revenus ni dépenses
  assert.equal(s.incomeMonth, DA(20000));
  assert.equal(s.expenseMonth, DA(5000));
  assert.equal(s.savings, DA(15000));
  assert.equal(s.savingsRate, 0.75);
  assert.equal(s.repaidReceived, DA(3000));
  assert.equal(s.repaidMade, DA(5000));
  const loans = computeLoans(st, T);
  const ahmed = loans.find((l) => l.person === 'Ahmed');
  assert.equal(ahmed.remaining, DA(7000));
  assert.equal(ahmed.status, 'partial');
  const karim = loans.find((l) => l.person === 'Karim');
  assert.equal(karim.remaining, DA(10000));
  assert.deepEqual(checkIntegrity(st), []);
});

test('modification d’une ancienne opération : tout est recalculé', () => {
  const { st } = scenario();
  st.ops.find((o) => o.type === 'expense').amount = DA(8000);
  const s = computeSummary(st, T);
  assert.equal(s.available, DA(50000));
  assert.equal(s.net, DA(47000));
  assert.equal(s.expenseMonth, DA(8000));
});

test('suppression d’un remboursement : la créance remonte', () => {
  const { st } = scenario();
  st.ops = st.ops.filter((o) => o.type !== 'loan_repay');
  const s = computeSummary(st, T);
  assert.equal(s.available, DA(50000));
  assert.equal(s.receivables, DA(10000));
  assert.equal(s.net, DA(50000)); // patrimoine inchangé : l'argent était déjà compté en créance
});

test('suppression d’un prêt supprime aussi ses remboursements', () => {
  const { st, loan } = scenario();
  const ids = cascadeIds(st, loan.id);
  assert.equal(ids.size, 2);
  st.ops = st.ops.filter((o) => !ids.has(o.id));
  const s = computeSummary(st, T);
  assert.equal(s.available, DA(60000));
  assert.equal(s.receivables, 0);
  assert.equal(s.net, DA(50000));
});

test('remboursement supérieur au reste dû refusé', () => {
  const { st, loan, debt } = scenario();
  assert.match(validateOp(st, { type: 'loan_repay', amount: DA(7001), accountId: 'cash', refId: loan.id, date: T }), /dépasse/);
  assert.equal(validateOp(st, { type: 'loan_repay', amount: DA(7000), accountId: 'cash', refId: loan.id, date: T }), null);
  assert.match(validateOp(st, { type: 'debt_repay', amount: DA(10001), accountId: 'cash', refId: debt.id, date: T }), /dépasse/);
  // modification d'un remboursement existant : son propre montant est exclu
  const rep = st.ops.find((o) => o.type === 'loan_repay');
  assert.equal(validateOp(st, { ...rep, amount: DA(10000) }), null);
  // le montant d'un prêt ne peut pas descendre sous le déjà-remboursé
  assert.match(validateOp(st, { ...loan, amount: DA(2000) }), /inférieur/);
});

test('emprunt encaissé : disponible +, dette +, patrimoine inchangé', () => {
  const { st } = scenario();
  const before = computeSummary(st, T).net;
  st.ops.push({ id: 'x', type: 'debt', amount: DA(30000), person: 'Banque', accountId: 'cash', date: T });
  const s = computeSummary(st, T);
  assert.equal(s.available, DA(83000));
  assert.equal(s.debts, DA(40000));
  assert.equal(s.net, before);
  assert.equal(s.incomeMonth, DA(20000));
});

test('transfert entre comptes neutre', () => {
  const { st } = scenario();
  st.accounts.push({ id: 'sav', name: 'Épargne', type: 'savings', initial: 0, createdAt: '2026-11-01' });
  st.ops.push({ id: 't', type: 'transfer', amount: DA(20000), accountId: 'cash', toAccountId: 'sav', date: T });
  const s = computeSummary(st, T);
  assert.equal(s.available, DA(53000));
  assert.equal(s.reserved, DA(20000));
  assert.equal(s.spendable, DA(33000));
  assert.equal(s.net, DA(50000));
  assert.equal(s.expenseMonth, DA(5000));
  assert.match(validateOp(st, { type: 'transfer', amount: 1, accountId: 'cash', toAccountId: 'cash', date: T }), /différents/);
});

test('séries pour graphiques', () => {
  const { st } = scenario();
  const series = availableSeries(st, T, 30);
  assert.equal(series.length, 30);
  assert.equal(series.at(-1).value, DA(53000));
  const m = monthlySeries(st, T, 6);
  assert.equal(m.at(-1).income, DA(20000));
  assert.equal(m.at(-1).expense, DA(5000));
});

test('filtres et recherche', () => {
  const { st } = scenario();
  assert.equal(filterOps(st, { type: 'expense' }).length, 1);
  assert.equal(filterOps(st, { query: 'ahmed' }).length, 2);
  assert.equal(filterOps(st, { month: '2026-10' }).length, 0);
  assert.equal(filterOps(st, { year: '2026' }).length, 6);
});

test('saisie des montants', () => {
  assert.equal(parseAmount('10 000'), 1000000);
  assert.equal(parseAmount('1 234,5'), 123450);
  assert.ok(Number.isNaN(parseAmount('12,345')));
  assert.ok(Number.isNaN(parseAmount('abc')));
});
