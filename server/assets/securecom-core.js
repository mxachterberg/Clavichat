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
