/* ==========================================================================
   Clavichat — Kryptografie
   --------------------------------------------------------------------------
   Alles, was ver- und entschlüsselt, läuft hier im Browser. Der Server sieht
   nur, was diese Funktionen herausgeben: Chiffretext, öffentliche Schlüssel
   und Signaturen.

   - Identität: OpenPGP-Schlüsselpaar mit Curve25519 (Ed25519 zum
     Signieren, X25519 zum Verschlüsseln), im Format, das auch GnuPG liest.
   - Direktnachrichten und Anruf-Signale: OpenPGP – ein zufälliger
     Sitzungsschlüssel pro Nachricht (AES-256), eingepackt für Empfänger
     und Absender, dazu eine Signatur des Absenders.
   - Räume: ein gemeinsamer Raumschlüssel, AES-256-GCM (WebCrypto). Jede
     Nachricht ist zusätzlich mit dem PGP-Schlüssel des Absenders signiert.
   - Konten: PBKDF2-SHA-256 (600.000 Runden) aus dem Passwort, daraus per
     HKDF ein Anmeldeschlüssel und ein Schlüssel, der den privaten
     PGP-Schlüssel und den Tresor mit AES-256-GCM einpackt.
   - Alle Klartexte werden vor dem Verschlüsseln auf feste Größen
     aufgefüllt, damit die Länge nichts verrät.

   Kein DOM in dieser Datei – sie läuft genauso unter Node (Tests).
   ========================================================================== */

import * as openpgp from './vendor/openpgp-6.3.2.min.js';

const subtle = globalThis.crypto.subtle;
export const te = new TextEncoder();
export const td = new TextDecoder();

// Keine Kompression (sie würde das Auffüllen zunichtemachen), keine
// Programmversion oder Kommentare in Schlüsseln und Nachrichten.
const PGP = {
  preferredCompressionAlgorithm: openpgp.enums.compression.uncompressed,
  showVersion: false,
  showComment: false
};
const ARMOR = Object.assign({}, openpgp.config, PGP);

export const KDF_ITERATIONS = 600000;

/* ---------- Kodierung ---------------------------------------------------- */
export function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function unb64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64url(bytes) {
  return b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64url(str) {
  let s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return unb64(s);
}

export function randomBytes(n) {
  const a = new Uint8Array(n);
  globalThis.crypto.getRandomValues(a);
  return a;
}

/** Zufällige Kennung: 128 Bit, 22 Zeichen. */
export function randomId() {
  return b64url(randomBytes(16));
}

export function toHex(bytes) {
  return Array.from(bytes, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
}

/* ---------- Fingerabdrücke ----------------------------------------------- */
export function normalizeFingerprint(input) {
  const s = String(input || '').replace(/[\s:]/g, '').toLowerCase();
  return /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(s) ? s : null;
}

/** "4F2A 91C0 …" – in Vierergruppen, wie GnuPG und Kleopatra ihn zeigen. */
export function formatFingerprint(fp) {
  return String(fp || '').toUpperCase().match(/.{1,4}/g).join(' ');
}

/** Die letzten 16 Zeichen (die Schlüssel-ID) – für Listen. */
export function shortFingerprint(fp) {
  return formatFingerprint(String(fp || '').slice(-16));
}

export function looksLikeArmoredKey(text) {
  return /-----BEGIN PGP (PUBLIC|PRIVATE) KEY BLOCK-----/.test(String(text || ''));
}

/* ---------- Schlüssel ---------------------------------------------------- */
const publicKeys = new Map();   // Text -> Promise<PublicKey>

export function readPublicKey(armored) {
  let p = publicKeys.get(armored);
  if (!p) {
    p = openpgp.readKey({ armoredKey: armored }).then(function (key) {
      return key.isPrivate() ? key.toPublic() : key;
    });
    publicKeys.set(armored, p);
    p.catch(function () { publicKeys.delete(armored); });
  }
  return p;
}

/** Neues Schlüsselpaar – entsteht hier im Browser, nie auf dem Server. */
export async function generateIdentity() {
  const pair = await openpgp.generateKey({
    type: 'ecc',
    curve: 'curve25519Legacy',
    userIDs: [{ name: 'Clavichat' }],
    format: 'object',
    config: Object.assign({}, PGP, { aeadProtect: true })
  });
  return identityFromPrivate(pair.privateKey);
}

/** Prüft, dass der Schlüssel signieren und entschlüsseln kann. */
export async function identityFromPrivate(privateKey) {
  if (!privateKey.isDecrypted()) throw new Error('Der private Schlüssel ist noch gesperrt.');
  await privateKey.getSigningKey();
  await privateKey.getEncryptionKey();
  const publicKey = privateKey.toPublic();
  return {
    privateKey: privateKey,
    publicKey: publicKey,
    armoredPublic: publicKey.armor(ARMOR),
    fingerprint: privateKey.getFingerprint()
  };
}

/** Eigenen Schlüssel übernehmen (etwa aus GnuPG oder Kleopatra exportiert). */
export async function importPrivateKey(armored, passphrase) {
  let key;
  try {
    key = await openpgp.readPrivateKey({ armoredKey: String(armored).trim() });
  } catch (e) {
    throw new Error('Das ist kein privater PGP-Schlüssel. Gebraucht wird der Block „BEGIN PGP PRIVATE KEY BLOCK“.');
  }
  if (!key.isDecrypted()) {
    if (!passphrase) throw new Error('Der Schlüssel ist mit einer Passphrase geschützt – bitte angeben.');
    try {
      key = await openpgp.decryptKey({ privateKey: key, passphrase: passphrase });
    } catch (e) {
      throw new Error('Die Passphrase des Schlüssels stimmt nicht.');
    }
  }
  try {
    return await identityFromPrivate(key);
  } catch (e) {
    throw new Error('Der Schlüssel muss signieren und entschlüsseln können (Hauptschlüssel mit Verschlüsselungs-Unterschlüssel).');
  }
}

/** Entsperrter privater Schlüssel aus der eigenen Ablage. */
export async function readPrivateIdentity(armored) {
  const key = await openpgp.readPrivateKey({ armoredKey: armored });
  return identityFromPrivate(key);
}

export function armorPrivate(privateKey) {
  return privateKey.armor(ARMOR);
}

/** Export zum Sichern: mit Passphrase geschützt, für GnuPG lesbar. */
export async function exportProtectedKey(privateKey, passphrase) {
  const locked = await openpgp.encryptKey({ privateKey: privateKey, passphrase: passphrase });
  return locked.armor(ARMOR);
}

/* ---------- Passwort → Schlüssel (Konten) -------------------------------- */
/**
 * Aus Name + Passwort zwei unabhängige Werte:
 *   auth  – geht an den Server, der nur einen Hash davon speichert
 *   wrap  – bleibt im Browser und packt den privaten Schlüssel ein
 */
export async function deriveAccountKeys(username, password) {
  const salt = te.encode('achterberg.dev/securecom/v1/' + String(username).trim().toLowerCase());
  const base = await subtle.importKey('raw', te.encode(String(password).normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  const master = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt, iterations: KDF_ITERATIONS }, base, 256);
  const hkdf = await subtle.importKey('raw', master, 'HKDF', false, ['deriveBits']);
  const empty = new Uint8Array(0);
  const auth = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: empty, info: te.encode('securecom auth') }, hkdf, 256);
  const wrap = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: empty, info: te.encode('securecom wrap') }, hkdf, 256);
  return { auth: toHex(new Uint8Array(auth)), wrapRaw: new Uint8Array(wrap) };
}

export function importWrapKey(raw, extractable) {
  return subtle.importKey('raw', raw, { name: 'AES-GCM' }, !!extractable, ['encrypt', 'decrypt']);
}

/** AES-256-GCM: Ergebnis = Base64(IV ‖ Chiffretext). */
export async function aesSeal(key, bytes, aad) {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: te.encode(aad) }, key, bytes));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv, 0);
  out.set(ct, 12);
  return b64(out);
}

export async function aesOpen(key, data, aad) {
  const bytes = unb64(data);
  const iv = bytes.subarray(0, 12);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: iv, additionalData: te.encode(aad) }, key, bytes.subarray(12));
  return new Uint8Array(pt);
}

export async function sealText(key, text, aad) {
  return aesSeal(key, te.encode(text), aad);
}

export async function openText(key, data, aad) {
  return td.decode(await aesOpen(key, data, aad));
}

/* ---------- Auffüllen ---------------------------------------------------- */
const BUCKETS = [256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];

/**
 * JSON auf die nächste feste Größe auffüllen. Ob "Hallo" oder ein langer
 * Absatz: Beim Server kommen gleich große Pakete an.
 */
export function padJson(obj) {
  const probe = JSON.stringify(Object.assign({}, obj, { pad: '' }));
  const len = te.encode(probe).length;
  let target = BUCKETS.find(function (b) { return b >= len; });
  if (!target) target = Math.ceil(len / 65536) * 65536;
  return JSON.stringify(Object.assign({}, obj, { pad: '.'.repeat(target - len) }));
}

function unpad(text) {
  const obj = JSON.parse(text);
  if (!obj || typeof obj !== 'object') throw new Error('Leere Nachricht');
  delete obj.pad;
  return obj;
}

/* ---------- Visitenkarte ------------------------------------------------- */
/**
 * Die Karte bindet Kennung, Art und Namen an den Schlüssel. Der Server kann
 * sie nicht fälschen – ein anderer Name ohne passende Signatur fällt auf.
 */
export async function signCard(privateKey, card) {
  const message = await openpgp.createMessage({ text: JSON.stringify(card) });
  const signed = await openpgp.sign({ message: message, signingKeys: privateKey, format: 'binary', config: PGP });
  return b64(signed);
}

export async function verifyCard(publicKey, data) {
  try {
    const message = await openpgp.readMessage({ binaryMessage: unb64(data) });
    const res = await openpgp.verify({ message: message, verificationKeys: publicKey, expectSigned: true, config: PGP });
    const card = JSON.parse(res.data);
    return card && typeof card === 'object' ? card : null;
  } catch (e) {
    return null;
  }
}

/* ---------- Direktnachrichten und Signale (OpenPGP) ---------------------- */
/** Verschlüsselt für alle Empfänger (sich selbst eingeschlossen) und signiert. */
export async function sealFor(obj, recipients, signer) {
  const message = await openpgp.createMessage({ text: padJson(obj) });
  const bin = await openpgp.encrypt({
    message: message,
    encryptionKeys: recipients,
    signingKeys: signer,
    format: 'binary',
    config: PGP
  });
  return b64(bin);
}

/**
 * Entschlüsseln und die Signatur prüfen. signer ist der Fingerabdruck des
 * Schlüssels aus dem Schlüsselbund, der gültig unterschrieben hat – oder
 * null (unbekannt oder ungültig). keyId hilft beim Nachschlagen.
 */
export async function openSealed(data, myKey, keyring) {
  const message = await openpgp.readMessage({ binaryMessage: unb64(data) });
  const res = await openpgp.decrypt({
    message: message,
    decryptionKeys: myKey,
    verificationKeys: keyring && keyring.length ? keyring : undefined,
    config: PGP
  });
  const obj = unpad(res.data);
  return Object.assign({ obj: obj }, await signerOf(res.signatures, keyring));
}

async function signerOf(signatures, keyring) {
  const sig = signatures && signatures[0];
  if (!sig) return { signer: null, keyId: null };
  const keyId = sig.keyID.toHex();
  try {
    await sig.verified;
    const key = (keyring || []).find(function (k) { return k.getKeys(sig.keyID).length > 0; });
    return { signer: key ? key.getFingerprint() : null, keyId: keyId };
  } catch (e) {
    return { signer: null, keyId: keyId };
  }
}

/* ---------- Räume (AES-256-GCM + Signatur) ------------------------------- */
export function newRoomKey() {
  return b64url(randomBytes(32));
}

export function importRoomKey(raw) {
  return subtle.importKey('raw', unb64url(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function roomAad(rid, epoch) {
  return te.encode('securecom room ' + rid + ' ' + epoch);
}

/**
 * Paket: [1 Byte Version][4 Byte Schlüsselgeneration][12 Byte IV][Chiffretext].
 * Drinnen: die signierte (PGP) und aufgefüllte Nachricht.
 */
export async function sealRoom(obj, roomKey, epoch, rid, signer) {
  const message = await openpgp.createMessage({ text: padJson(obj) });
  const signed = await openpgp.sign({ message: message, signingKeys: signer, format: 'binary', config: PGP });
  const iv = randomBytes(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: roomAad(rid, epoch) }, roomKey, signed));
  const out = new Uint8Array(17 + ct.length);
  out[0] = 1;
  new DataView(out.buffer).setUint32(1, epoch);
  out.set(iv, 5);
  out.set(ct, 17);
  return b64(out);
}

export function roomEpoch(data) {
  const head = unb64(String(data).slice(0, 24));
  if (head[0] !== 1) return 0;
  return new DataView(head.buffer).getUint32(1);
}

export async function openRoom(data, roomKey, rid, keyring) {
  const bytes = unb64(data);
  if (bytes[0] !== 1) throw new Error('Unbekanntes Format');
  const epoch = new DataView(bytes.buffer, bytes.byteOffset).getUint32(1);
  const signed = new Uint8Array(await subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.subarray(5, 17), additionalData: roomAad(rid, epoch) },
    roomKey, bytes.subarray(17)));
  const message = await openpgp.readMessage({ binaryMessage: signed });
  const res = await openpgp.verify({ message: message, verificationKeys: keyring || [], config: PGP });
  const obj = unpad(res.data);
  return Object.assign({ obj: obj, epoch: epoch }, await signerOf(res.signatures, keyring));
}

/* ---------- Sicherheitscode für Anrufe ----------------------------------- */
/**
 * WebRTC verschlüsselt Ton und Bild mit Schlüsseln, die die beiden Geräte
 * per DTLS aushandeln. Jedes Gerät hat dafür ein Zertifikat, dessen
 * Fingerabdruck in den (signierten) Verbindungsangaben steht. Aus beiden
 * Fingerabdrücken entsteht ein sechsstelliger Code: Sehen beide Seiten
 * dieselbe Zahl, sitzt niemand dazwischen.
 */
export function dtlsFingerprint(sdp) {
  const m = /a=fingerprint:(\S+) ([0-9A-Fa-f:]+)/.exec(String(sdp || ''));
  return m ? m[1].toLowerCase() + ' ' + m[2].toUpperCase() : null;
}

export async function safetyCode(sdpA, sdpB) {
  const a = dtlsFingerprint(sdpA);
  const b = dtlsFingerprint(sdpB);
  if (!a || !b) return null;
  const h = new Uint8Array(await subtle.digest('SHA-256', te.encode([a, b].sort().join('|'))));
  const n = ((h[0] << 16) | (h[1] << 8) | h[2]) % 1000000;
  const s = String(n).padStart(6, '0');
  return s.slice(0, 3) + ' ' + s.slice(3);
}
