#!/usr/bin/env node
// Clavichat — Beitrag über einen API-Zugang posten (nur posten, nie lesen).
//
//   node tools/clavichat-post.mjs --access-file <datei> "Text"
//   echo "Text" | node tools/clavichat-post.mjs --access-file <datei>
//   node tools/clavichat-post.mjs "<zugang>" "Text"
//   CLAVICHAT_HOOK="<zugang>" node tools/clavichat-post.mjs "Text"
//
// Den Zugang legt der Besitzer eines Raums an (Raum-Menü → EINSTELLUNGEN →
// API-Zugang). Er enthält Server-Adresse, Raum, Kennung, Token und den
// öffentlichen Schlüssel des Zugangs. Dieses Werkzeug verschlüsselt den Text
// selbst (ECDH P-256 + HKDF-SHA-256 + AES-256-GCM, genau wie sealHook() in
// server/assets/securecom-core.js) – der Server bekommt nur Chiffretext und
// das Token. Lesen kann der Zugang nichts: Der private Schlüssel steht nur
// in den verschlüsselten Raumdaten der Mitglieder.
//
// Node 18 oder neuer, ohne Abhängigkeiten. Der Zugang wird nie ausgegeben.
// Am besten liegt er in einer Datei (--access-file, nur für dich lesbar): Dann
// steht er weder in der Prozessliste noch im Verlauf der Shell. Über die
// Umgebungsvariable CLAVICHAT_HOOK fehlt er in der Prozessliste – wer sie
// aber in derselben Zeile setzt (CLAVICHAT_HOOK="…" node …), hat ihn im
// Verlauf der Shell. Die Uhr des Rechners muss ungefähr stimmen (±10 min),
// sonst halten die Apps den Beitrag für eine Wiederholung und blenden ihn aus.

import { webcrypto } from 'node:crypto';

const subtle = webcrypto.subtle;
const PREFIX = 'clavichat-hook:1:';
const MAX = 16384;   // aufgefüllter Klartext (wie HOOK_MAX)
const BUCKETS = [256, 512, 1024, 2048, 4096, 8192, 16384];
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const te = new TextEncoder();
const LOCAL = ['127.0.0.1', 'localhost', '[::1]'];

function fail(msg, code) {
  process.stderr.write('clavichat-post: ' + msg + '\n');
  process.exit(code || 1);
}

/** Text vom Server: ohne Steuerzeichen (Terminal-Escapes, Bidi, unsichtbare Zeichen), gekürzt. */
function safeText(s) {
  return String(s).replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, '').slice(0, 300);
}

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
const unb64url = (s) => new Uint8Array(Buffer.from(String(s), 'base64url'));

function parseAccess(text) {
  const s = String(text || '').trim();
  if (s.indexOf(PREFIX) !== 0) fail('Das ist kein Clavichat-Zugang (er beginnt mit „' + PREFIX + '“).');
  let o;
  try { o = JSON.parse(Buffer.from(s.slice(PREFIX.length), 'base64url').toString('utf8')); } catch (e) { o = null; }
  const id = /^[A-Za-z0-9_-]{22}$/;
  if (!o || typeof o.u !== 'string' || !/^https?:\/\//.test(o.u) || !id.test(o.r) || !id.test(o.h)
      || !/^[A-Za-z0-9_-]{43}$/.test(o.t) || !/^[A-Za-z0-9_-]{87}$/.test(o.k)) {
    fail('Der Zugang ist unvollständig oder beschädigt – bitte vollständig kopieren.');
  }
  // Token nur verschlüsselt verschicken: http:// nur an diesen Rechner (Testserver).
  let url;
  try { url = new URL(o.u); } catch (e) { fail('Die Server-Adresse im Zugang ist ungültig.'); }
  if (url.username || url.password) fail('Die Server-Adresse im Zugang ist ungültig.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL.includes(url.hostname))) {
    fail('Der Zugang nennt eine unverschlüsselte Adresse (http://) – erlaubt ist das nur für localhost.');
  }
  return o;
}

/** Wie padJson() in securecom-core.js: feste Größen, die Länge verrät nichts. */
function padJson(obj) {
  const probe = JSON.stringify(Object.assign({}, obj, { pad: '' }));
  const len = te.encode(probe).length;
  const target = BUCKETS.find((b) => b >= len);
  if (!target) return null;
  return JSON.stringify(Object.assign({}, obj, { pad: '.'.repeat(target - len) }));
}

/** Paket: [1 Byte Version][65 Byte frischer öffentlicher Schlüssel][12 Byte IV][AES-GCM-Chiffretext]. */
async function seal(obj, pub, rid, hid) {
  const plainText = padJson(obj);
  if (plainText === null) return null;
  const plain = te.encode(plainText);
  if (plain.length > MAX) return null;
  const pubRaw = unb64url(pub);
  const peer = await subtle.importKey('raw', pubRaw, ECDH, false, []);
  const eph = await subtle.generateKey(ECDH, true, ['deriveBits']);
  const ephRaw = new Uint8Array(await subtle.exportKey('raw', eph.publicKey));
  const shared = await subtle.deriveBits({ name: 'ECDH', public: peer }, eph.privateKey, 256);
  const salt = new Uint8Array(130);
  salt.set(ephRaw, 0);
  salt.set(pubRaw, 65);
  const ikm = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const key = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: salt, info: te.encode('clavichat hook v1 ' + rid + ' ' + hid) },
    ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: te.encode('clavichat hook ' + rid + ' ' + hid) }, key, plain));
  const out = new Uint8Array(78 + ct.length);
  out[0] = 1;
  out.set(ephRaw, 1);
  out.set(iv, 66);
  out.set(ct, 78);
  return b64(out);
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '-h' || args[0] === '--help') {
    process.stdout.write('Aufruf: node clavichat-post.mjs --access-file <datei> "Text"\n' +
      '        node clavichat-post.mjs "<zugang>" "Text"\n' +
      '(Text auch über stdin; Zugang auch über die Umgebungsvariable CLAVICHAT_HOOK)\n');
    return;
  }
  let access;
  const fileAt = args.findIndex((a) => a === '--access-file' || a.startsWith('--access-file='));
  if (fileAt >= 0) {
    const opt = args[fileAt];
    const file = opt.includes('=') ? opt.slice(opt.indexOf('=') + 1) : args[fileAt + 1];
    args.splice(fileAt, opt.includes('=') ? 1 : 2);
    if (!file) fail('--access-file braucht einen Dateinamen.', 2);
    try {
      const { readFileSync } = await import('node:fs');
      access = readFileSync(file, 'utf8').trim();
    } catch (e) {
      fail('Die Datei mit dem Zugang ließ sich nicht lesen (' + (e.code || 'Fehler') + ').', 2);
    }
  } else if (args[0] && args[0].trim().startsWith(PREFIX)) access = args.shift();
  else if (process.env.CLAVICHAT_HOOK) access = process.env.CLAVICHAT_HOOK;
  else fail('Zugang fehlt. Aufruf: node clavichat-post.mjs --access-file <datei> "Text" (oder "<zugang>" bzw. CLAVICHAT_HOOK).', 2);
  const hook = parseAccess(access);

  let text = args.length && args[0] !== '-' ? args.join(' ') : await readStdin();
  text = text.replace(/\r\n/g, '\n').replace(/\s+$/, '');
  if (!text.trim()) fail('Kein Text – als Argument angeben oder über stdin schicken.', 2);
  if (text.length > 8000) fail('Text zu lang: höchstens 8000 Zeichen (die App zeigt nicht mehr).', 2);

  const id = b64url(webcrypto.getRandomValues(new Uint8Array(16)));
  const d = await seal({ v: 1, t: 'hook', id: id, ts: Date.now(), body: text }, hook.k, hook.r, hook.h);
  if (!d) fail('Text zu lang: verschlüsselt höchstens 16 KB.', 2);

  let res;
  try {
    res = await fetch(hook.u, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ a: 'hook.post', r: hook.r, h: hook.h, t: hook.t, d: d })
    });
  } catch (e) {
    fail('Server nicht erreichbar (' + new URL(hook.u).host + '): ' + (e.cause && e.cause.code ? e.cause.code : e.message));
  }
  let json = null;
  try { json = await res.json(); } catch (e) { /* kein JSON */ }
  if (res.ok && json && json.ok) {
    process.stdout.write('Gepostet (verschlüsselt, ' + text.length + ' Zeichen).\n');
    return;
  }
  const why = json && typeof json.error === 'string' ? safeText(json.error) : 'HTTP ' + res.status;
  if (res.status === 403) fail('Abgelehnt: ' + why + ' Der Zugang wurde vielleicht widerrufen oder der Raum gelöscht.', 3);
  if (res.status === 429) fail('Zu viele Beiträge – kurz warten (je Zugang höchstens 20 pro Minute).', 4);
  if (res.status === 404 && json && /Unbekannte Aktion/.test(why)) fail('Der Server kennt API-Zugänge noch nicht (ältere Fassung).', 5);
  fail('Fehler: ' + why);
}

main().catch((e) => fail('Unerwarteter Fehler: ' + safeText(e && e.message ? e.message : e)));
