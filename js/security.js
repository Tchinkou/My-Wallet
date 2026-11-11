/**
 * My Wallet — sécurité (Web Crypto + WebAuthn).
 *
 * Schéma de clés :
 *   - Une clé de données (DEK) aléatoire de 256 bits chiffre le coffre (AES-GCM).
 *   - La DEK est « enveloppée » (chiffrée) par une clé dérivée du PIN :
 *       PBKDF2-SHA-256, 600 000 itérations, sel aléatoire de 16 octets.
 *     Le PIN n'est jamais stocké, ni en clair ni haché : un mauvais PIN
 *     échoue simplement à l'authentification AES-GCM.
 *   - Biométrie (facultative) : une seconde copie enveloppée de la DEK.
 *       Mode « prf »    : la clé d'enveloppe est dérivée du secret PRF renvoyé
 *                         par l'authentificateur après lecture de l'empreinte.
 *                         Sans empreinte, la DEK est inaccessible.
 *       Mode « device » : (si PRF absent) la DEK est enveloppée par une clé
 *                         non exportable propre au navigateur ; l'empreinte
 *                         sert alors de verrou d'interface. Moins robuste,
 *                         clairement signalé à l'utilisateur.
 */

export const PIN_ITERATIONS = 600000;
const enc = new TextEncoder();
const dec = new TextDecoder();

/* --------------------------------------------------------- utilitaires */

export function toB64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function randomBytes(n) { return crypto.getRandomValues(new Uint8Array(n)); }

export async function sha256Hex(text) {
  const h = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return Array.from(new Uint8Array(h), (b) => b.toString(16).padStart(2, '0')).join('');
}

export class WrongSecretError extends Error {
  constructor(msg = 'Code incorrect.') { super(msg); this.name = 'WrongSecretError'; }
}

/** Clé AES-GCM dérivée d'un secret texte (PIN ou mot de passe). */
export async function deriveKeyFromSecret(secret, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function aesEncrypt(key, data, aad) {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, data);
  return { iv: toB64(iv), ct: toB64(ct) };
}

async function aesDecrypt(key, blob, aad) {
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(blob.iv), additionalData: enc.encode(aad) },
      key,
      fromB64(blob.ct),
    );
    return new Uint8Array(pt);
  } catch {
    throw new WrongSecretError();
  }
}

/* ------------------------------------------------------ clé de données */

const DEK_AAD = 'mywallet:dek:v1';
const VAULT_AAD = 'mywallet:vault:v1';

/** Crée une nouvelle DEK protégée par le PIN. */
export async function createVaultKey(pin) {
  const raw = randomBytes(32);
  const keymeta = await wrapWithPin(raw, pin);
  return { raw, keymeta };
}

export async function wrapWithPin(raw, pin) {
  const salt = randomBytes(16);
  const kek = await deriveKeyFromSecret(pin, salt, PIN_ITERATIONS);
  const wrapped = await aesEncrypt(kek, raw, DEK_AAD);
  return { v: 1, kdf: 'PBKDF2-SHA256', iterations: PIN_ITERATIONS, salt: toB64(salt), wrapped };
}

/** Retourne la DEK brute ; lève WrongSecretError si le PIN est faux. */
export async function unwrapWithPin(pin, keymeta) {
  const kek = await deriveKeyFromSecret(pin, fromB64(keymeta.salt), keymeta.iterations);
  return aesDecrypt(kek, keymeta.wrapped, DEK_AAD);
}

export function importDataKey(raw) {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptState(key, state) {
  return aesEncrypt(key, enc.encode(JSON.stringify(state)), VAULT_AAD);
}

export async function decryptState(key, blob) {
  const pt = await aesDecrypt(key, blob, VAULT_AAD);
  return JSON.parse(dec.decode(pt));
}

/* ---------------------------------------------------------- biométrie */

export async function biometricSupport() {
  if (!window.isSecureContext) return { ok: false, reason: 'Nécessite une connexion HTTPS.' };
  if (!window.PublicKeyCredential) return { ok: false, reason: "Ce navigateur ne prend pas en charge WebAuthn." };
  try {
    const ok = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    if (!ok) return { ok: false, reason: "Aucun capteur biométrique ou verrouillage d'écran disponible pour le navigateur." };
  } catch {
    return { ok: false, reason: 'Impossible de vérifier la disponibilité du capteur.' };
  }
  return { ok: true };
}

const BIO_AAD = 'mywallet:bio:v1';

async function kekFromPrf(prfOutput) {
  const base = await crypto.subtle.importKey('raw', prfOutput, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode('mywallet-bio-kek') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function prfFirst(cred) {
  const r = cred.getClientExtensionResults?.().prf?.results?.first;
  return r ? new Uint8Array(r) : null;
}

async function assert(credId, prfSalt) {
  const options = {
    challenge: randomBytes(32),
    rpId: location.hostname,
    allowCredentials: [{ type: 'public-key', id: fromB64(credId), transports: ['internal', 'hybrid'] }],
    userVerification: 'required',
    timeout: 60000,
  };
  if (prfSalt) options.extensions = { prf: { eval: { first: fromB64(prfSalt) } } };
  const cred = await navigator.credentials.get({ publicKey: options });
  if (!cred) throw new Error('Authentification annulée.');
  const flags = new Uint8Array(cred.response.authenticatorData)[32];
  if (!(flags & 0x04)) throw new Error("L'utilisateur n'a pas été vérifié.");
  return cred;
}

/**
 * Enregistre l'empreinte et crée une copie de la DEK protégée par elle.
 * @param {Uint8Array} raw DEK brute (disponible uniquement déverrouillé)
 */
export async function enrollBiometric(raw) {
  const prfSalt = randomBytes(32);
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: randomBytes(32),
      rp: { name: 'My Wallet', id: location.hostname },
      user: { id: randomBytes(16), name: 'My Wallet', displayName: 'My Wallet (déverrouillage local)' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'preferred',
      },
      timeout: 60000,
      attestation: 'none',
      extensions: { prf: { eval: { first: prfSalt } } },
    },
  });
  if (!cred) throw new Error('Enregistrement annulé.');
  const credId = toB64(cred.rawId);
  const prfEnabled = !!cred.getClientExtensionResults?.().prf?.enabled;
  let prfOut = prfFirst(cred);

  if (!prfOut && prfEnabled) {
    // Certains authentificateurs ne renvoient le secret PRF qu'à l'authentification.
    try { prfOut = prfFirst(await assert(credId, toB64(prfSalt))); } catch { prfOut = null; }
  }

  if (prfOut) {
    const kek = await kekFromPrf(prfOut);
    return { v: 1, mode: 'prf', credId, prfSalt: toB64(prfSalt), wrapped: await aesEncrypt(kek, raw, BIO_AAD) };
  }

  // Repli : clé non exportable conservée par le navigateur.
  const deviceKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { v: 1, mode: 'device', credId, deviceKey, wrapped: await aesEncrypt(deviceKey, raw, BIO_AAD) };
}

/** Lit l'empreinte et retourne la DEK brute. */
export async function unlockWithBiometric(bio) {
  const cred = await assert(bio.credId, bio.mode === 'prf' ? bio.prfSalt : null);
  if (bio.mode === 'prf') {
    const out = prfFirst(cred);
    if (!out) throw new Error("L'authentificateur n'a pas fourni la clé biométrique.");
    return aesDecrypt(await kekFromPrf(out), bio.wrapped, BIO_AAD);
  }
  return aesDecrypt(bio.deviceKey, bio.wrapped, BIO_AAD);
}

/* --------------------------------------------- limitation des essais PIN */

/** Délai d'attente (ms) après n échecs consécutifs. */
export function lockoutDelay(failures) {
  if (failures < 5) return 0;
  return Math.min(15 * 60_000, 30_000 * 2 ** (failures - 5));
}
