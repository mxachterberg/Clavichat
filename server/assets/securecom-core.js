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
   - Freunde: ein gemeinsames Geheimnis aus der (PGP-verschlüsselten)
     Anfrage; daraus per HKDF zwei Fächer beim Server und ein Schlüssel,
     der den Status verschlüsselt (AES-256-GCM).
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

/* ---------- Forward Secrecy: wechselnde Verschlüsselungs-Unterschlüssel ----
   Regelmäßig kommt ein neuer X25519-Unterschlüssel dazu; Absender nehmen
   immer den jüngsten. Alte Unterschlüssel werden gelöscht, sobald alles, was
   an sie ging, beim Server abgelaufen ist. Wer später an den privaten
   Schlüssel kommt, kann damit ältere Nachrichten nicht mehr lesen. Der
   Hauptschlüssel (Signatur, Fingerabdruck) bleibt derselbe. */
function encrypts(subkey) {
  const sig = subkey.bindingSignatures[subkey.bindingSignatures.length - 1];
  const flags = sig && sig.keyFlags ? sig.keyFlags[0] : 0;
  return (flags & (openpgp.enums.keyFlags.encryptCommunication | openpgp.enums.keyFlags.encryptStorage)) !== 0;
}

/** Verschlüsselungs-Unterschlüssel, älteste zuerst: [{ id, created (ms) }]. */
export function encryptionSubkeys(key) {
  return key.subkeys.filter(encrypts)
    .map((s) => ({ id: s.getKeyID().toHex(), created: s.getCreationTime().getTime() }))
    .sort((a, b) => a.created - b.created);
}

/** Neuen Verschlüsselungs-Unterschlüssel (X25519) anhängen. */
export function addEncryptionSubkey(privateKey) {
  return privateKey.addSubkey({ type: 'ecc', curve: 'curve25519Legacy', config: Object.assign({}, PGP) });
}

/**
 * Alte Verschlüsselungs-Unterschlüssel entfernen: Einer fällt weg, sobald
 * sein Nachfolger seit keepMs da ist – was an ihn ging, ist dann abgelaufen.
 * Der jüngste bleibt immer. Gibt { key, dropped } zurück.
 */
export async function pruneEncryptionSubkeys(privateKey, keepMs, now) {
  const list = encryptionSubkeys(privateKey);
  const drop = new Set();
  for (let i = 0; i < list.length - 1; i++) {
    if (now - list[i + 1].created > keepMs) drop.add(list[i].id);
  }
  if (!drop.size) return { key: privateKey, dropped: 0 };
  const copy = await openpgp.readPrivateKey({ armoredKey: privateKey.armor(ARMOR) });
  copy.subkeys = copy.subkeys.filter((s) => !drop.has(s.getKeyID().toHex()));
  return { key: await openpgp.readPrivateKey({ armoredKey: copy.armor(ARMOR) }), dropped: drop.size };
}

/** Zeitpunkt (ms), zu dem der jüngste Verschlüsselungs-Unterschlüssel entstand. */
export function newestEncryptionSubkey(key) {
  const list = encryptionSubkeys(key);
  return list.length ? list[list.length - 1].created : 0;
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

/* ---------- Wiederherstellungscode statt Passwort --------------------------
   Für Konten, die mit dem Postfach von achterberg.dev entstehen: 160
   Zufallsbits, geschrieben als 8 Vierergruppen in Crockford-Base32 (ohne
   I, L, O, U – nichts zum Verwechseln). Aus dem Code entstehen per HKDF-SHA-256
   (RFC 5869) dieselben zwei Werte wie aus einem Passwort. PBKDF2 braucht es
   hier nicht: 160 Bit Zufall lassen sich nicht erraten. Name und Zweck stecken
   in Salt und Info – derselbe Code ergibt für ein anderes Konto andere Schlüssel. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function newRecoveryCode() {
  let acc = 0;
  let bits = 0;
  let out = '';
  for (const byte of randomBytes(20)) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(acc >>> bits) & 31];
    }
    acc &= (1 << bits) - 1;
  }
  return out.match(/.{4}/g).join('-');
}

/** Großbuchstaben, ohne Leer- und Bindestriche, O→0 und I/L→1 – oder null. */
export function normalizeRecoveryCode(text) {
  const s = String(text || '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return /^[0-9A-HJKMNP-TV-Z]{32}$/.test(s) ? s : null;
}

export function isRecoveryCode(text) {
  return normalizeRecoveryCode(text) !== null;
}

export async function deriveCodeKeys(username, code) {
  const norm = normalizeRecoveryCode(code);
  if (!norm) throw new Error('Das ist kein gültiger Wiederherstellungscode.');
  const bytes = [];
  let acc = 0;
  let bits = 0;
  for (const ch of norm) {
    acc = (acc << 5) | CROCKFORD.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >>> bits) & 255);
    }
    acc &= (1 << bits) - 1;
  }
  const ikm = await subtle.importKey('raw', new Uint8Array(bytes), 'HKDF', false, ['deriveBits']);
  const salt = te.encode('achterberg.dev/clavichat/code/v1/' + String(username).trim().toLowerCase());
  const auth = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: salt, info: te.encode('clavichat code auth') }, ikm, 256);
  const wrap = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: salt, info: te.encode('clavichat code wrap') }, ikm, 256);
  return { auth: toHex(new Uint8Array(auth)), wrapRaw: new Uint8Array(wrap) };
}

/** Passwort oder Wiederherstellungscode – was eingetippt wurde, entscheidet das Format. */
export function accountKeys(username, secret) {
  return isRecoveryCode(secret) ? deriveCodeKeys(username, secret) : deriveAccountKeys(username, secret);
}

export function importWrapKey(raw, extractable) {
  return subtle.importKey('raw', raw, { name: 'AES-GCM' }, !!extractable, ['encrypt', 'decrypt']);
}

/* ---------- Dateien --------------------------------------------------------
   Jede Datei bekommt einen eigenen Zufallsschlüssel (AES-256-GCM) und wird
   in Stücken zu FILE_CHUNK Bytes verschlüsselt. Der IV ist die Stücknummer
   – jeder Schlüssel verschlüsselt jede Nummer genau einmal (ein erneutes
   Senden ergibt denselben Chiffretext). Die Zusatzdaten binden Datei, Nummer
   und Anzahl: Stücke lassen sich weder vertauschen noch weglassen noch aus
   einer anderen Datei einschmuggeln. Schlüssel, Name und Typ reisen nur in
   der Ende-zu-Ende verschlüsselten Nachricht. */
export const FILE_CHUNK = 524288;

export function newFileKey() {
  return randomBytes(32);
}

export function importFileKey(raw) {
  return subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Anzahl der Stücke für eine Datei dieser Größe (mindestens eins). */
export function fileChunks(size) {
  return Math.max(1, Math.ceil(size / FILE_CHUNK));
}

function chunkParams(fileId, n, total) {
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setUint32(8, n);
  return { name: 'AES-GCM', iv: iv, additionalData: te.encode('clavichat-file|' + fileId + '|' + n + '|' + total) };
}

export async function sealChunk(key, fileId, n, total, bytes) {
  return new Uint8Array(await subtle.encrypt(chunkParams(fileId, n, total), key, bytes));
}

export async function openChunk(key, fileId, n, total, bytes) {
  return new Uint8Array(await subtle.decrypt(chunkParams(fileId, n, total), key, bytes));
}

/* ---------- App-Sperre: PIN → Schlüssel ------------------------------------
   PBKDF2-SHA-256 wie bei Konten, aber mit zufälligem Salt je Gerät. Der
   Schlüssel (AES-256-GCM, nicht auslesbar) versiegelt die gespeicherte
   Anmeldung – ohne PIN sind Token und eingepackter Schlüssel auf der
   Festplatte wertlos. */
export async function derivePinKey(pin, salt, iterations) {
  const base = await subtle.importKey('raw', te.encode(String(pin).normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: salt, iterations: iterations || KDF_ITERATIONS },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Die häufigsten PINs, die keinem Muster unten folgen (Tastenspalten, Wiederholungen). */
const COMMON_PINS = new Set(['1212', '1122', '1313', '1010', '2020', '2000', '1004', '6969', '2580', '0852', '1478', '3690',
  '5683', '7777', '121212', '112233', '123123', '159753', '147258', '258456', '789456', '101010', '696969', '131313', '102030']);

/** Zu einfache PINs: alles gleich (0000), auf- oder absteigend (1234, 9876), sehr häufig, zu kurz. */
export function weakPin(pin) {
  const p = String(pin || '');
  if (p.length < 4) return true;
  if (/^(.)\1+$/.test(p) || COMMON_PINS.has(p)) return true;
  if (/^\d+$/.test(p)) {
    let up = true;
    let down = true;
    for (let i = 1; i < p.length; i++) {
      const d = p.charCodeAt(i) - p.charCodeAt(i - 1);
      if (d !== 1 && d !== -9) up = false;
      if (d !== -1 && d !== 9) down = false;
    }
    if (up || down) return true;
  }
  return false;
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

/* ---------- Freunde: Status in Fächern ------------------------------------
   Zwei Freunde teilen ein Geheimnis (32 Zufallsbytes; es kommt mit der
   Freundschaftsanfrage, PGP-verschlüsselt und signiert). Daraus entstehen
   per HKDF-SHA-256 (RFC 5869) ein Fach je Person – eine 256-Bit-Kennung beim
   Server – und ein gemeinsamer AES-256-GCM-Schlüssel. Jeder legt seinen
   Status verschlüsselt in sein Fach; lesen kann ihn nur der Freund. Der
   Server sieht weder, wer mit wem befreundet ist, noch welcher Status gilt. */
const PRES_SALT = te.encode('achterberg.dev/clavichat/presence/v1');
const PRES_CODES = { on: 'o', busy: 'b', away: 'a' };

export function newFriendSecret() {
  return b64url(randomBytes(32));
}

/** { mine: eigenes Fach, theirs: Fach des Freundes, key } – beide Seiten rechnen gleich. */
export async function friendPresence(secret, myId, peerId) {
  const raw = unb64url(secret);
  if (raw.length !== 32) throw new Error('Ungültiges Geheimnis.');
  const ikm = await subtle.importKey('raw', raw, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const slot = async (id) => toHex(new Uint8Array(await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: PRES_SALT, info: te.encode('clavichat presence slot ' + id) }, ikm, 256)));
  const key = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: PRES_SALT, info: te.encode('clavichat presence key') },
    ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { mine: await slot(myId), theirs: await slot(peerId), key: key };
}

/** Status fürs eigene Fach – immer gleich lang, die Länge verrät nichts. */
export function sealPresence(key, slot, status) {
  const code = PRES_CODES[status];
  if (!code) throw new Error('Unbekannter Status.');
  return aesSeal(key, te.encode(JSON.stringify({ s: code, t: Date.now() })), 'clavichat presence ' + slot);
}

export async function openPresence(key, slot, data) {
  const obj = JSON.parse(td.decode(await aesOpen(key, data, 'clavichat presence ' + slot)));
  const status = Object.keys(PRES_CODES).find((k) => PRES_CODES[k] === obj.s);
  if (!status) throw new Error('Unbekannter Status.');
  return { status: status, t: Number(obj.t) || 0 };
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

/* ---------- API-Zugänge: nur posten ----------------------------------------
   Ein Zugang ist ein Schlüsselpaar (ECDH P-256) plus ein zufälliges Token.
   Der private Schlüssel steht nur in den verschlüsselten Raumdaten (alle
   Mitglieder lesen damit die Beiträge), der Server kennt nur den Hash des
   Tokens. Wer den Zugang hat (Token + öffentlicher Schlüssel), kann damit
   nur verschlüsseln und posten – nichts lesen.
   Beitrag („sealed box“): ein frischer ECDH-Schlüssel je Beitrag, daraus
   mit dem öffentlichen Schlüssel des Zugangs per HKDF-SHA-256 ein
   AES-256-GCM-Schlüssel. Salt = beide öffentlichen Schlüssel, Info und AAD
   binden an Raum und Zugang – der Server kann einen Beitrag nicht in einen
   anderen Raum oder unter einen anderen Zugang umhängen.
   Paket: [1 Byte Version][65 Byte frischer öffentlicher Schlüssel][12 Byte IV][Chiffretext].
   tools/clavichat-post.mjs rechnet genauso (ohne diese Datei). */
export const HOOK_PREFIX = 'clavichat-hook:1:';
export const HOOK_MAX = 16384;   // aufgefüllter Klartext eines Beitrags (Byte)
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };

/** Neues Schlüsselpaar: priv (PKCS#8) und pub (roh, 65 Byte), beides Base64url. */
export async function newHookKeys() {
  const kp = await subtle.generateKey(ECDH, true, ['deriveBits']);
  return {
    priv: b64url(new Uint8Array(await subtle.exportKey('pkcs8', kp.privateKey))),
    pub: b64url(new Uint8Array(await subtle.exportKey('raw', kp.publicKey)))
  };
}

/** Zugangstoken: 256 Bit. Beim Server liegt nur hookTokenHash(). */
export function newHookToken() {
  return b64url(randomBytes(32));
}

export async function hookTokenHash(token) {
  return toHex(new Uint8Array(await subtle.digest('SHA-256', te.encode(String(token)))));
}

function hookAad(rid, hid) {
  return te.encode('clavichat hook ' + rid + ' ' + hid);
}

async function hookAesKey(shared, ephRaw, pubRaw, rid, hid) {
  const salt = new Uint8Array(ephRaw.length + pubRaw.length);
  salt.set(ephRaw, 0);
  salt.set(pubRaw, ephRaw.length);
  const ikm = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: salt, info: te.encode('clavichat hook v1 ' + rid + ' ' + hid) },
    ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Beitrag verschlüsseln (wie das Kommandozeilen-Werkzeug). obj z. B. { t: 'hook', body }. */
export async function sealHook(obj, pub, rid, hid) {
  const pubRaw = unb64url(pub);
  if (pubRaw.length !== 65) throw new Error('Ungültiger öffentlicher Schlüssel.');
  const plain = te.encode(padJson(obj));
  if (plain.length > HOOK_MAX) throw new Error('Text zu lang.');
  const peer = await subtle.importKey('raw', pubRaw, ECDH, false, []);
  const eph = await subtle.generateKey(ECDH, true, ['deriveBits']);
  const ephRaw = new Uint8Array(await subtle.exportKey('raw', eph.publicKey));
  const shared = await subtle.deriveBits({ name: 'ECDH', public: peer }, eph.privateKey, 256);
  const key = await hookAesKey(shared, ephRaw, pubRaw, rid, hid);
  const iv = randomBytes(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: hookAad(rid, hid) }, key, plain));
  const out = new Uint8Array(1 + 65 + 12 + ct.length);
  out[0] = 1;
  out.set(ephRaw, 1);
  out.set(iv, 66);
  out.set(ct, 78);
  return b64(out);
}

/**
 * Privaten Schlüssel eines Zugangs laden (einmal je Zugang, dann
 * zwischenspeichern): { key, pub } – den öffentlichen Schlüssel braucht der
 * Salt, er entsteht hier aus dem privaten.
 */
export async function importHookKey(priv) {
  const jwk = await subtle.exportKey('jwk', await subtle.importKey('pkcs8', unb64url(priv), ECDH, true, ['deriveBits']));
  const x = unb64url(jwk.x), y = unb64url(jwk.y);
  const pub = new Uint8Array(65);
  pub[0] = 4;
  pub.set(x, 33 - x.length);
  pub.set(y, 65 - y.length);
  delete jwk.key_ops;
  const key = await subtle.importKey('jwk', jwk, ECDH, false, ['deriveBits']);
  return { key: key, pub: b64url(pub) };
}

/** Beitrag öffnen. k: Ergebnis von importHookKey(). Wirft bei allem, was nicht passt. */
export async function openHook(data, k, rid, hid) {
  const bytes = unb64(data);
  if (bytes.length < 1 + 65 + 12 + 16 || bytes[0] !== 1) throw new Error('Unbekanntes Format');
  const ephRaw = bytes.slice(1, 66);
  const eph = await subtle.importKey('raw', ephRaw, ECDH, false, []);
  const shared = await subtle.deriveBits({ name: 'ECDH', public: eph }, k.key, 256);
  const aes = await hookAesKey(shared, ephRaw, unb64url(k.pub), rid, hid);
  const plain = await subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(66, 78), additionalData: hookAad(rid, hid) }, aes, bytes.subarray(78));
  return unpad(td.decode(plain));
}

/** Zugang als Text: Server, Raum, Zugang, Token, öffentlicher Schlüssel. */
export function hookAccess(o) {
  return HOOK_PREFIX + b64url(te.encode(JSON.stringify({ u: o.u, r: o.r, h: o.h, t: o.t, k: o.k })));
}

export function parseHookAccess(text) {
  const s = String(text || '').trim();
  if (s.indexOf(HOOK_PREFIX) !== 0) throw new Error('Das ist kein Clavichat-Zugang.');
  const o = JSON.parse(td.decode(unb64url(s.slice(HOOK_PREFIX.length))));
  const id = /^[A-Za-z0-9_-]{22}$/;
  if (!o || typeof o.u !== 'string' || !id.test(o.r) || !id.test(o.h) || !/^[A-Za-z0-9_-]{43}$/.test(o.t) || !/^[A-Za-z0-9_-]{87}$/.test(o.k)) {
    throw new Error('Der Zugang ist unvollständig.');
  }
  return o;
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

/* ---------- Passwortstärke ------------------------------------------------ */
/**
 * Schätzt, wie viele Versuche ein Angreifer bräuchte – in Bit. Wichtig, weil
 * aus dem Passwort der Schlüssel entsteht, der den privaten Schlüssel
 * einpackt: Wer die Server-Daten stiehlt, kann offline raten. Bewusst
 * vorsichtig: Wörter, Namen, Jahreszahlen, Zahlenfolgen und Tastaturmuster
 * zählen wenig, Länge und zufällige Wörter viel. Ergebnis 0–4:
 * sehr schwach, schwach, okay, stark, sehr stark.
 */
const COMMON_PASSWORDS = new Set(('123456 123456789 12345678 12345 1234567 1234567890 111111 000000 123123 654321 ' +
  '666666 121212 112233 987654321 123321 147258369 159753 7777777 88888888 99999999 1q2w3e4r 1q2w3e q1w2e3r4 ' +
  'zaq12wsx qazwsx 1qaz2wsx aa123456 qwerty qwertz qwertz123 qwerty123 asdfgh asdfghjkl yxcvbnm password passwort ' +
  'passwort1 password1 password123 passwort123 kennwort hallo hallo123 hallo1 schatz schatzi liebe ichliebedich ' +
  'iloveyou geheim geheim123 admin administrator letmein welcome willkommen master dragon monkey shadow sunshine ' +
  'princess football fussball baseball superman batman trustno1 abc123 abcdef abcd1234 a1b2c3 test test123 ' +
  'testtest login starwars pokemon killer freedom whatever ficken arschloch schalke04 bvb09 bayern fcbayern ' +
  'borussia mausi hase schnecke baerchen lol123 changeme default guest gast root toor user benutzer clavichat ' +
  'securecom achterberg').split(' '));

const COMMON_WORDS = new Set(('passwort password kennwort hallo hello liebe love schatz geheim secret sommer winter ' +
  'fruehling frühling herbst sonne mond stern blume rose engel teufel himmel hoelle hölle drache dragon tiger loewe ' +
  'löwe baer bär adler pferd katze hund maus hase vogel fisch affe monkey welpe kitty kater januar februar maerz ' +
  'märz april juni juli august september oktober november dezember montag dienstag mittwoch donnerstag freitag ' +
  'samstag sonntag fussball fußball football soccer bayern schalke dortmund borussia hamburg berlin muenchen ' +
  'münchen koeln köln frankfurt stuttgart deutschland germany europa computer internet schule arbeit familie ' +
  'freund freundin mama papa mutter vater oma opa baby kind kinder bruder schwester michael thomas andreas stefan ' +
  'daniel christian alexander markus martin peter klaus jürgen juergen sabine julia anna lisa sarah laura lena ' +
  'tobias jonas lukas felix paul emma sophie hannah marie maria nicole jennifer jessica tanja sandra melanie ' +
  'master admin login welcome willkommen sunshine princess shadow superman batman pokemon starwars matrix ' +
  'blau blue rot red gruen grün green gelb yellow schwarz black weiss weiß white orange silber gold diamant ' +
  'auto haus garten wasser feuer erde luft musik gitarre rock party pizza kaffee schokolade bier wein ' +
  'clavichat securecom achterberg').split(' '));

const KEY_ROWS = ['qwertzuiopü', 'asdfghjklöä', 'yxcvbnm', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890', 'abcdefghijklmnopqrstuvwxyz'];
const LEET = { '@': 'a', '4': 'a', '3': 'e', '1': 'i', '!': 'i', '0': 'o', '5': 's', '$': 's', '7': 't' };

function unleet(s) {
  return s.replace(/[@4310!5$7]/g, (c) => LEET[c] || c);
}

/** Folge wie „abcd“, „4321“, Tastaturreihe wie „qwert“ oder Wiederholung (ab 4 Zeichen)? */
function isRun(s) {
  if (s.length < 4) return false;
  for (const row of KEY_ROWS) {
    const back = [...row].reverse().join('');
    if (row.includes(s) || back.includes(s)) return true;
  }
  return /^(.)\1+$/.test(s);
}

function letterBits(lower) {
  const word = unleet(lower);
  if (COMMON_WORDS.has(word) || COMMON_PASSWORDS.has(word)) return { bits: 11, hint: 'word' };
  if (isRun(lower)) return { bits: 5, hint: 'run' };
  // Klingt es wie ein Wort (Vokale im Wechsel)? Dann zählt es wie ein Eintrag
  // in einem großen Wörterbuch – lange Folgen wie mehrere Wörter.
  const vowels = (lower.match(/[aeiouyäöü]/g) || []).length;
  const wordlike = lower.length >= 4 && vowels / lower.length >= 0.25 && !/[^aeiouyäöü]{5,}/.test(lower);
  const random = lower.length * Math.log2(26);
  if (!wordlike) return { bits: random };
  return { bits: Math.min(random, lower.length >= 12 ? (lower.length / 6) * 15 : 15 + lower.length * 0.4) };
}

export function passwordStrength(password, hints) {
  const pw = String(password || '');
  if (!pw) return { bits: 0, score: 0, tip: '' };
  const lower = pw.toLowerCase();
  const tips = new Set();
  const bare = lower.replace(/[\d\W_]+$/, '');
  if (COMMON_PASSWORDS.has(lower) || COMMON_PASSWORDS.has(unleet(lower)) || (bare && COMMON_PASSWORDS.has(unleet(bare)))) {
    return { bits: 5, score: 0, tip: 'Das gehört zu den häufigsten Passwörtern.' };
  }
  let bits = 0;
  const segs = pw.match(/[A-Za-zÄÖÜäöüß]+|\d+|[^A-Za-zÄÖÜäöüß\d]+/g) || [];
  segs.forEach((seg, i) => {
    const last = i === segs.length - 1;
    if (/^[A-Za-zÄÖÜäöüß]+$/.test(seg)) {
      const r = letterBits(seg.toLowerCase());
      if (r.hint === 'word') tips.add('Einzelne Wörter und Namen sind leicht zu erraten.');
      if (r.hint === 'run') tips.add('Tastaturmuster und Folgen sind leicht zu erraten.');
      const upper = (seg.match(/[A-ZÄÖÜ]/g) || []).length;
      const firstOnly = upper === 1 && /^[A-ZÄÖÜ]/.test(seg);
      bits += r.bits + (upper === 0 ? 0 : upper === seg.length || firstOnly ? 1 : Math.min(upper, 4));
    } else if (/^\d+$/.test(seg)) {
      if (/^(19|20)\d\d$/.test(seg)) { bits += 7; tips.add('Jahreszahlen sind leicht zu erraten.'); }
      else if (isRun(seg)) { bits += 3; tips.add('Zahlenfolgen wie 1234 sind leicht zu erraten.'); }
      else bits += seg.length * Math.log2(10) * (seg.length <= 4 && last ? 0.8 : 1);
    } else if (/^[\s._-]+$/.test(seg) && i > 0 && !last) {
      bits += 1;                       // Trennzeichen zwischen Wörtern
    } else {
      bits += seg.length === 1 && last ? 3 : seg.length * 5;
    }
  });
  for (const h of (hints || [])) {
    const n = String(h || '').toLowerCase();
    if (n.length >= 3 && lower.includes(n)) {
      bits -= Math.min(bits / 2, n.length * 4);
      tips.add('Dein Name gehört nicht ins Passwort.');
    }
  }
  if (/^(.+)\1+$/.test(pw)) { bits = Math.min(bits, 20); tips.add('Wiederholungen machen ein Passwort nicht stärker.'); }
  bits = Math.max(0, Math.round(bits));
  const score = bits < 28 ? 0 : bits < 40 ? 1 : bits < 55 ? 2 : bits < 70 ? 3 : 4;
  if (score < 3 && !tips.size) tips.add('Länger ist besser – zum Beispiel vier zufällige Wörter.');
  return { bits: bits, score: score, tip: [...tips][0] || '' };
}

/* ---------- Töne: Synthese per WebAudio (live und offline) ------------------
   Keine Audiodateien: Jeder Ton entsteht aus Oszillatoren und Hüllkurven.
   sound() plant einen Ton in einem beliebigen (Offline)AudioContext ein –
   die App spielt ihn live, Hörproben entstehen mit OfflineAudioContext aus
   genau demselben Code. Rückgabe: { out, end } – out ist der Ausgang (zum
   Ausblenden), end die Zeit, zu der der Ton verklungen ist.
   - ring: klassisches Telefon. Zwei kleine Glocken mit unharmonischen
     Obertönen, ein Klöppel schlägt abwechselnd an (22 Schläge je Sekunde –
     der typische Triller), leises mechanisches Klacken, kurzer Nachhall.
     Ein Zyklus = 1 s Klingeln; die App wiederholt alle RING_CYCLE Sekunden
     (1 s klingeln, 4 s Pause wie ein altes deutsches Telefon).
   - ringback: Freiton für ausgehende Anrufe, 425 Hz, 1 s (Pause 4 s).
   - message: neue Nachricht – zwei Töne mit Holz-/Glas-Charakter (Quinte
     aufwärts, der zweite gleitet leicht hinein), dezentes Stereo-Echo.
     message-b (Kalimba-Dreiklang) und message-c (Tropfen) sind Varianten
     für Hörproben. */
export const RING_CYCLE = 5;       // Sekunden je Klingelzyklus (1 s an, 4 s aus)
export const RINGBACK_CYCLE = 5;   // Freiton: 1 s an, 4 s aus

export function sound(ctx, dest, name, t0) {
  const t = Math.max(t0 === undefined ? ctx.currentTime : t0, ctx.currentTime);
  const out = ctx.createGain();
  out.gain.value = 1;
  out.connect(dest);
  let end;
  if (name === 'ring') end = ringBell(ctx, out, t, 1.0);
  else if (name === 'ringback') end = ringback(ctx, out, t);
  else if (name === 'message-b') end = kalimba(ctx, out, t);
  else if (name === 'message-c') end = drops(ctx, out, t);
  else end = woodGlass(ctx, out, t);
  return { out: out, end: end };
}

/** Sanft ausblenden (etwa beim Annehmen eines Anrufs mitten im Klingeln). */
export function fadeOut(ctx, out, secs) {
  const t = ctx.currentTime;
  try {
    out.gain.cancelScheduledValues(t);
    out.gain.setValueAtTime(out.gain.value, t);
    out.gain.linearRampToValueAtTime(0, t + (secs || 0.06));
  } catch (e) { /* schon getrennt */ }
}

function panner(ctx, pan, dest) {
  if (!ctx.createStereoPanner) return dest;
  const p = ctx.createStereoPanner();
  p.pan.value = pan;
  p.connect(dest);
  return p;
}

/** Gleiches Rauschen bei jedem Aufruf (die Hörproben sollen gleich klingen). */
function noiseBuffer(ctx, secs) {
  const n = Math.max(1, Math.floor(ctx.sampleRate * secs));
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let s = 0x2545f491;
  for (let i = 0; i < n; i++) {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    d[i] = ((s >>> 0) / 4294967296) * 2 - 1;
  }
  return buf;
}

function ringBell(ctx, out, t0, dur) {
  // Klang dämpfen: nichts Schrilles oben, kein Brummen unten.
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 280;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 5200;
  lp.Q.value = 0.5;
  const bus = ctx.createGain();
  bus.gain.setValueAtTime(0, t0);
  bus.gain.linearRampToValueAtTime(0.13, t0 + 0.03);
  bus.connect(hp).connect(lp).connect(out);
  const RATE = 22;                     // Schläge je Sekunde, abwechselnd auf beide Glocken
  const n = Math.round(dur * RATE);
  const stop = t0 + dur + 2.2;
  // Zwei Glocken, gut eine Ganztonstufe auseinander; Obertöne wie bei
  // dünnen Metallschalen (nicht ganzzahlig): Verhältnis, Pegel, Abklingen.
  const bells = [{ f: 1046, pan: -0.2 }, { f: 1178, pan: 0.2 }];
  const partials = [[1, 1, 0.2], [2.32, 0.46, 0.11], [3.86, 0.24, 0.07], [5.53, 0.12, 0.045]];
  bells.forEach((b, bi) => {
    const dst = panner(ctx, b.pan, bus);
    for (const [ratio, level, tau] of partials) {
      const o = ctx.createOscillator();
      o.frequency.value = b.f * ratio;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t0);
      for (let i = bi; i < n; i += 2) {
        const ts = t0 + i / RATE;
        const spin = Math.min(1, 0.5 + i * 0.1);   // der Klöppel kommt erst in Schwung
        g.gain.setTargetAtTime(level * spin, ts, 0.0012);
        g.gain.setTargetAtTime(0, ts + 0.005, tau);
      }
      g.gain.setTargetAtTime(0, t0 + dur, tau * 1.9);   // Nachhall
      o.connect(g).connect(dst);
      o.start(t0);
      o.stop(stop);
    }
  });
  // Mechanisches Klacken des Klöppels
  const nz = ctx.createBufferSource();
  nz.buffer = noiseBuffer(ctx, dur + 0.1);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 2600;
  bp.Q.value = 1.4;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0, t0);
  for (let i = 0; i < n; i++) {
    const ts = t0 + i / RATE;
    ng.gain.setTargetAtTime(0.16, ts, 0.0006);
    ng.gain.setTargetAtTime(0, ts + 0.002, 0.004);
  }
  nz.connect(bp).connect(ng).connect(bus);
  nz.start(t0);
  nz.stop(t0 + dur + 0.1);
  return t0 + dur + 1.2;
}

function ringback(ctx, out, t0) {
  const o = ctx.createOscillator();
  o.frequency.value = 425;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(0.05, t0 + 0.02);
  g.gain.setValueAtTime(0.05, t0 + 0.98);
  g.gain.linearRampToValueAtTime(0, t0 + 1.0);
  o.connect(g).connect(out);
  o.start(t0);
  o.stop(t0 + 1.05);
  return t0 + 1.05;
}

/** Dezentes Stereo-Echo: zwei Verzögerungen links/rechts mit etwas Rückkopplung. */
function echo(ctx, out, t0, wet) {
  const send = ctx.createGain();
  send.gain.value = wet;
  [[0.083, -0.65], [0.131, 0.65]].forEach(([time, pan]) => {
    const d = ctx.createDelay(0.5);
    d.delayTime.value = time;
    const fb = ctx.createGain();
    fb.gain.value = 0.3;
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 3200;
    send.connect(d);
    d.connect(tone).connect(fb).connect(d);
    tone.connect(panner(ctx, pan, out));
  });
  return send;
}

/** Ein angeschlagener Ton aus Teiltönen [Verhältnis, Pegel, Abklingen]. */
function struck(ctx, dest, f, t, level, partials, glide) {
  for (const [ratio, lv, tau] of partials) {
    const o = ctx.createOscillator();
    if (glide) {
      o.frequency.setValueAtTime(f * ratio * glide, t);
      o.frequency.exponentialRampToValueAtTime(f * ratio, t + 0.045);
    } else {
      o.frequency.value = f * ratio;
    }
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level * lv, t + 0.004);
    g.gain.setTargetAtTime(0, t + 0.004, tau);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + tau * 9 + 0.05);
  }
}

function woodGlass(ctx, out, t0) {
  const bus = ctx.createGain();
  bus.gain.value = 0.55;
  bus.connect(out);
  const wet = echo(ctx, out, t0, 0.2);
  bus.connect(wet);
  // Holz (Grundton, kräftiger 4. Teilton wie ein Marimbastab) + Glas (2,76)
  const P = [[1, 0.13, 0.16], [2.76, 0.03, 0.06], [4, 0.035, 0.03], [5.4, 0.012, 0.018]];
  struck(ctx, panner(ctx, -0.12, bus), 783.99, t0, 1, P, 0);           // G5
  struck(ctx, panner(ctx, 0.12, bus), 1174.66, t0 + 0.095, 0.9, P, 0.955);   // D6, gleitet hinein
  return t0 + 0.6;
}

function kalimba(ctx, out, t0) {
  const bus = ctx.createGain();
  bus.gain.value = 0.55;
  bus.connect(out);
  bus.connect(echo(ctx, out, t0, 0.16));
  const P = [[1, 0.11, 0.13], [5.9, 0.025, 0.02], [2.01, 0.02, 0.05]];
  [[1046.5, -0.2], [1318.5, 0], [1568, 0.2]].forEach(([f, pan], i) => {
    struck(ctx, panner(ctx, pan, bus), f, t0 + i * 0.062, 1 - i * 0.12, P, 0.985);
  });
  return t0 + 0.55;
}

function drops(ctx, out, t0) {
  const bus = ctx.createGain();
  bus.gain.value = 0.6;
  bus.connect(out);
  bus.connect(echo(ctx, out, t0, 0.18));
  [[620, 1350, 0, -0.15], [820, 1800, 0.12, 0.15]].forEach(([a, b, dt, pan]) => {
    const t = t0 + dt;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(a, t);
    o.frequency.exponentialRampToValueAtTime(b, t + 0.055);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.12, t + 0.006);
    g.gain.setTargetAtTime(0, t + 0.02, 0.035);
    o.connect(g).connect(panner(ctx, pan, bus));
    o.start(t);
    o.stop(t + 0.35);
  });
  return t0 + 0.5;
}
