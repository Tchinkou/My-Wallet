/**
 * My Wallet — sauvegarde chiffrée, restauration et export CSV.
 *
 * Format du fichier de sauvegarde (.json) :
 * {
 *   "format": "mywallet-backup", "version": 1, "createdAt": "...",
 *   "kdf":    { "name": "PBKDF2", "hash": "SHA-256", "iterations": 600000, "salt": "<b64>" },
 *   "cipher": { "name": "AES-GCM", "iv": "<b64>" },
 *   "data":   "<b64>"      // chiffré : { state, sha256 }
 * }
 * Intégrité vérifiée trois fois : tag AES-GCM (toute altération est détectée),
 * empreinte SHA-256 interne, puis contrôle de cohérence des opérations.
 */

import { deriveKeyFromSecret, randomBytes, toB64, fromB64, sha256Hex, WrongSecretError } from './security.js';
import { checkIntegrity, OP_TYPES } from './calculations.js';
import { migrateState } from './database.js';

const FORMAT = 'mywallet-backup';
const ITERATIONS = 600000;
const AAD = new TextEncoder().encode('mywallet:backup:v1');

export async function createBackup(state, password) {
  const json = JSON.stringify(state);
  const payload = JSON.stringify({ state, sha256: await sha256Hex(json) });
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKeyFromSecret(password, salt, ITERATIONS);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key, new TextEncoder().encode(payload));
  const file = {
    format: FORMAT,
    version: 1,
    app: 'My Wallet',
    createdAt: new Date().toISOString(),
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt: toB64(salt) },
    cipher: { name: 'AES-GCM', iv: toB64(iv) },
    data: toB64(ct),
  };
  return new Blob([JSON.stringify(file, null, 1)], { type: 'application/json' });
}

/** Lit et vérifie une sauvegarde. Lève une erreur explicite en cas de problème. */
export async function readBackup(text, password) {
  let file;
  try { file = JSON.parse(text); } catch { throw new Error("Ce fichier n'est pas une sauvegarde My Wallet valide."); }
  if (file?.format !== FORMAT || !file.kdf?.salt || !file.cipher?.iv || !file.data) {
    throw new Error("Ce fichier n'est pas une sauvegarde My Wallet valide.");
  }
  if (file.version > 1) throw new Error('Cette sauvegarde provient d’une version plus récente de l’application.');
  const key = await deriveKeyFromSecret(password, fromB64(file.kdf.salt), file.kdf.iterations);
  let payload;
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(file.cipher.iv), additionalData: AAD }, key, fromB64(file.data),
    );
    payload = JSON.parse(new TextDecoder().decode(pt));
  } catch {
    throw new WrongSecretError('Mot de passe incorrect ou fichier endommagé.');
  }
  const json = JSON.stringify(payload.state);
  if (await sha256Hex(json) !== payload.sha256) throw new Error('Empreinte d’intégrité invalide : fichier altéré.');
  const state = migrateState(payload.state);
  const errors = checkIntegrity(state);
  if (errors.length) throw new Error(`Sauvegarde incohérente : ${errors[0]}`);
  return { state, createdAt: file.createdAt };
}

/* --------------------------------------------------------------- CSV */

function csvCell(v) {
  const s = String(v ?? '');
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV compatible Excel français (séparateur « ; », virgule décimale, BOM UTF-8). */
export function opsToCSV(state, ops) {
  const cats = new Map(state.categories.map((c) => [c.id, c.name]));
  const accs = new Map(state.accounts.map((a) => [a.id, a.name]));
  const parents = new Map(state.ops.map((o) => [o.id, o]));
  const header = ['Date', 'Type', 'Montant', 'Sens', 'Catégorie', 'Compte', 'Compte destination', 'Personne', 'Échéance', 'Description', 'Devise'];
  const rows = [header];
  for (const op of ops) {
    const incoming = op.type === 'income' || op.type === 'euro_in' || op.type === 'loan_repay' || (op.type === 'debt' && op.accountId);
    const outgoing = op.type === 'expense' || op.type === 'euro_out' || op.type === 'loan' || op.type === 'debt_repay';
    const person = op.person || parents.get(op.refId)?.person || state.euro?.items.find((i) => i.id === op.euroId)?.client || '';
    rows.push([
      op.date,
      OP_TYPES[op.type]?.label || op.type,
      (op.amount / 100).toFixed(2).replace('.', ','),
      incoming ? 'Entrée' : outgoing ? 'Sortie' : 'Neutre',
      cats.get(op.categoryId) || '',
      accs.get(op.accountId) || '',
      accs.get(op.toAccountId) || '',
      person,
      op.dueDate || '',
      op.note || '',
      state.settings.currency,
    ]);
  }
  return new Blob(['﻿' + rows.map((r) => r.map(csvCell).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
}

/** Déclenche le téléchargement (dossier « Téléchargements » sur Android). */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
