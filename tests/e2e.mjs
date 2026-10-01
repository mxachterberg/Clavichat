// SecureCom — Ende-zu-Ende-Test: Kryptografie-Modul und Server zusammen.
//
//   php -S 127.0.0.1:8130 -t server        (in einem zweiten Fenster)
//   node tests/e2e.mjs
//
// Anderer Server: SECURECOM_API=https://example.com/securecom/api.php node tests/e2e.mjs
// Achtung: Der Test legt Identitäten an und löscht sie am Ende wieder.
import * as C from '../server/assets/securecom-core.js';

const API = process.env.SECURECOM_API || 'http://127.0.0.1:8130/api.php';
let failures = 0;
function ok(cond, label) {
  if (cond) console.log('  ok   ' + label);
  else { failures++; console.log('  FAIL ' + label); }
}
async function call(a, body = {}, token = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-SC-Token'] = token;
  const res = await fetch(API, { method: 'POST', headers, body: JSON.stringify(Object.assign({ a }, body)) });
  const json = await res.json().catch(() => ({ ok: false, error: 'kein JSON (' + res.status + ')' }));
  json._status = res.status;
  return json;
}

async function makeTemp(alias) {
  const idn = await C.generateIdentity();
  const id = C.randomId();
  const card = await C.signCard(idn.privateKey, { v: 1, id, kind: 'temp', name: alias, ts: Date.now() });
  const r = await call('temp', { id, pub: idn.armoredPublic, fp: idn.fingerprint, card });
  return Object.assign({ id, token: r.token, res: r }, idn);
}

console.log('== Kryptografie');
const t0 = Date.now();
const A = await C.generateIdentity();
console.log('  Schlüsselpaar erzeugt in ' + (Date.now() - t0) + ' ms, Fingerabdruck ' + C.formatFingerprint(A.fingerprint));
ok(/^[0-9a-f]{40}$/.test(A.fingerprint), 'v4-Fingerabdruck (40 Hex, GnuPG-kompatibel)');
ok(A.armoredPublic.startsWith('-----BEGIN PGP PUBLIC KEY BLOCK-----'), 'öffentlicher Schlüssel im ASCII-Format');
ok(!/Version:|Comment:/.test(A.armoredPublic), 'keine Versions-/Kommentarzeilen im Schlüssel');
const B = await C.generateIdentity();

const card = await C.signCard(A.privateKey, { v: 1, id: 'x', name: 'Anna' });
ok((await C.verifyCard(A.publicKey, card))?.name === 'Anna', 'Karte: gültige Signatur wird erkannt');
ok((await C.verifyCard(B.publicKey, card)) === null, 'Karte: fremder Schlüssel wird abgelehnt');

const sealed = await C.sealFor({ t: 'msg', body: 'Hallo Bob' }, [B.publicKey, A.publicKey], A.privateKey);
const opened = await C.openSealed(sealed, B.privateKey, [A.publicKey]);
ok(opened.obj.body === 'Hallo Bob' && opened.signer === A.fingerprint, 'DM: Bob entschlüsselt, Signatur von Anna geprüft');
const ownCopy = await C.openSealed(sealed, A.privateKey, [A.publicKey]);
ok(ownCopy.obj.body === 'Hallo Bob', 'DM: Anna kann ihre eigene Kopie lesen');
const unknown = await C.openSealed(sealed, B.privateKey, []);
ok(unknown.obj.body === 'Hallo Bob' && unknown.signer === null && unknown.keyId, 'DM: unbekannter Absender → signer null, keyId zum Nachschlagen');
const Eve = await C.generateIdentity();
let eveFailed = false;
try { await C.openSealed(sealed, Eve.privateKey, []); } catch (e) { eveFailed = true; }
ok(eveFailed, 'DM: Dritte können nicht entschlüsseln');

const short = C.unb64(await C.sealFor({ t: 'msg', body: 'hi' }, [B.publicKey], A.privateKey)).length;
const longer = C.unb64(await C.sealFor({ t: 'msg', body: 'x'.repeat(150) }, [B.publicKey], A.privateKey)).length;
ok(short === longer, 'Auffüllen: 2 und 150 Zeichen ergeben gleich große Pakete (' + short + ' B)');

const roomKeyRaw = C.newRoomKey();
const roomKey = await C.importRoomKey(roomKeyRaw);
const rid = C.randomId();
const rmsg = await C.sealRoom({ t: 'msg', ch: 'c1', body: 'Moin Raum' }, roomKey, 3, rid, A.privateKey);
ok(C.roomEpoch(rmsg) === 3, 'Raum: Schlüsselgeneration im Kopf lesbar');
const ropen = await C.openRoom(rmsg, roomKey, rid, [A.publicKey, B.publicKey]);
ok(ropen.obj.body === 'Moin Raum' && ropen.signer === A.fingerprint, 'Raum: entschlüsselt + Signatur geprüft');
let wrongRoom = false;
try { await C.openRoom(rmsg, roomKey, C.randomId(), [A.publicKey]); } catch (e) { wrongRoom = true; }
ok(wrongRoom, 'Raum: Paket lässt sich nicht in einen anderen Raum umleiten (AAD)');

const t1 = Date.now();
const k1 = await C.deriveAccountKeys('Max', 'ein langes Passwort 123');
console.log('  PBKDF2 (600.000 Runden) in ' + (Date.now() - t1) + ' ms');
const k2 = await C.deriveAccountKeys('max', 'ein langes Passwort 123');
ok(k1.auth === k2.auth && /^[0-9a-f]{64}$/.test(k1.auth), 'Konto: Anmeldeschlüssel stabil, Name ohne Groß/Klein');
ok(C.toHex(k1.wrapRaw) !== k1.auth, 'Konto: Einpack-Schlüssel ≠ Anmeldeschlüssel');
const wk = await C.importWrapKey(k1.wrapRaw);
const wrapped = await C.sealText(wk, C.armorPrivate(A.privateKey), 'sc-key|max');
const back = await C.readPrivateIdentity(await C.openText(wk, wrapped, 'sc-key|max'));
ok(back.fingerprint === A.fingerprint, 'Konto: privater Schlüssel ein- und ausgepackt');

const exported = await C.exportProtectedKey(A.privateKey, 'geheim');
ok(exported.includes('BEGIN PGP PRIVATE KEY BLOCK'), 'Export: geschützter privater Schlüssel');
const imported = await C.importPrivateKey(exported, 'geheim');
ok(imported.fingerprint === A.fingerprint, 'Import: mit Passphrase entsperrt');
let badPass = false;
try { await C.importPrivateKey(exported, 'falsch'); } catch (e) { badPass = /Passphrase/.test(e.message); }
ok(badPass, 'Import: falsche Passphrase wird klar gemeldet');

const sdp1 = 'v=0\r\na=fingerprint:sha-256 AA:BB:CC\r\n', sdp2 = 'v=0\r\na=fingerprint:sha-256 11:22:33\r\n';
ok((await C.safetyCode(sdp1, sdp2)) === (await C.safetyCode(sdp2, sdp1)), 'Sicherheitscode: auf beiden Seiten gleich');

console.log('\n== Server: temporäre Sitzungen');
const TA = await makeTemp('Anna');
const TB = await makeTemp('Bob');
ok(TA.res.ok && TA.token && TA.res.kind === 'temp', 'Anna: temporäre Sitzung (' + TA.res._status + ')');
ok(TB.res.ok && TB.token, 'Bob: temporäre Sitzung');

let r = await call('config');
ok(r.ok && Array.isArray(r.ice) && !r.ice.some((s) => s.credential), 'öffentliche Angaben: keine Relay-Zugangsdaten');
r = await call('ice');
ok(!r.ok && r._status === 401, 'Relay-Zugangsdaten nur nach Anmeldung');
r = await call('ice', {}, TA.token);
ok(r.ok && Array.isArray(r.ice) && typeof r.relay === 'boolean', 'angemeldet: Verbindungsserver abrufbar');

r = await call('poll', { i: { s: 0, o: 0, g: 0 }, tail: 300 }, TA.token);
ok(r.ok && Array.isArray(r.i.e) && r.pv, 'Anna: erster Abruf');
r = await call('online', {}, TA.token);
const bobOnline = r.list && r.list.find(x => x.id === TB.id);
ok(!!bobOnline, 'Anna sieht Bob in der Online-Liste');
const bobKey = await C.readPublicKey(bobOnline.pub);
ok(bobKey.getFingerprint() === bobOnline.fp, 'Bobs Schlüssel passt zum gemeldeten Fingerabdruck');
ok((await C.verifyCard(bobKey, bobOnline.card))?.name === 'Bob', 'Bobs Karte ist von Bob signiert');

const dm = await C.sealFor({ v: 1, t: 'msg', id: C.randomId(), from: TA.id, to: TB.id, ts: Date.now(), body: 'Geheim!' },
  [TB.publicKey, TA.publicKey], TA.privateKey);
r = await call('send', { to: TB.id, k: 'dm', d: dm, self: true }, TA.token);
ok(r.ok && r.s === 1 && r.own === 1, 'Anna schickt Bob eine DM (+ eigene Kopie)');

r = await call('poll', { i: { s: 0, o: 0, g: 0 }, tail: 300 }, TB.token);
ok(r.i.e.length === 1 && r.i.e[0].k === 'dm' && !('from' in r.i.e[0]), 'Bob holt die DM ab – ohne Absenderfeld beim Server');
const got = await C.openSealed(r.i.e[0].d, TB.privateKey, [TA.publicKey]);
ok(got.obj.body === 'Geheim!' && got.signer === TA.fingerprint, 'Bob entschlüsselt und prüft Annas Signatur');
const cursorB = { s: r.i.s, o: r.i.o, g: r.i.g };
r = await call('poll', { i: cursorB }, TB.token);
ok(r.i.e.length === 0 && r.i.s === cursorB.s, 'zweiter Abruf ab Lesezeiger: nichts Neues');

r = await call('find', { fp: C.formatFingerprint(TB.fingerprint) }, TA.token);
ok(r.ok && r.list.length === 1 && r.list[0].id === TB.id, 'Suche per Fingerabdruck (mit Leerzeichen) findet Bob');

r = await call('card', { vis: false }, TB.token);
ok(r.ok && r.vis === false, 'Bob macht sich unsichtbar');
r = await call('online', {}, TA.token);
ok(!r.list.find(x => x.id === TB.id), 'Bob steht nicht mehr in der Online-Liste');
r = await call('find', { fp: TB.fingerprint }, TA.token);
ok(r.list.length === 1 && r.list[0].on === null, 'Per Schlüssel bleibt Bob erreichbar, Status "unbekannt"');
await call('card', { vis: true }, TB.token);

console.log('\n== Server: Konten');
const uname = 'Tester' + Math.floor(Math.random() * 1e6);
const keys = await C.deriveAccountKeys(uname, 'Korrekt Pferd Batterie');
const acc = await C.generateIdentity();
const accId = C.randomId();
const wkey = await C.importWrapKey(keys.wrapRaw);
const accWrapped = await C.sealText(wkey, C.armorPrivate(acc.privateKey), 'sc-key|' + uname.toLowerCase());
const accCard = await C.signCard(acc.privateKey, { v: 1, id: accId, kind: 'account', name: uname, ts: Date.now() });
r = await call('register', { username: uname, auth: keys.auth, id: accId, pub: acc.armoredPublic, fp: acc.fingerprint, card: accCard, wrapped: accWrapped });
ok(r.ok && r.token && r.kind === 'account', 'Konto angelegt (ohne E-Mail)');
r = await call('register', { username: uname.toUpperCase(), auth: keys.auth, id: C.randomId(), pub: acc.armoredPublic, fp: acc.fingerprint, card: accCard, wrapped: accWrapped });
ok(!r.ok && r._status === 409, 'Name doppelt (andere Schreibweise) wird abgelehnt');
r = await call('login', { username: uname, auth: (await C.deriveAccountKeys(uname, 'falsch')).auth });
ok(!r.ok && r._status === 401, 'falsches Passwort → 401');
r = await call('login', { username: uname.toLowerCase(), auth: keys.auth });
ok(r.ok && r.wrapped === accWrapped, 'Anmelden: Server liefert den eingepackten Schlüssel');
const accToken = r.token;
const unwrapped = await C.readPrivateIdentity(await C.openText(wkey, r.wrapped, 'sc-key|' + uname.toLowerCase()));
ok(unwrapped.fingerprint === acc.fingerprint, 'Anmelden: privater Schlüssel im Browser ausgepackt');
r = await call('vault', { vault: C.b64(C.te.encode('x')), vv: 1 }, accToken);
ok(r.ok && r.vv === 2, 'Tresor gespeichert (Version 2)');
r = await call('vault', { vault: C.b64(C.te.encode('y')), vv: 1 }, accToken);
ok(!r.ok && r._status === 409 && r.vv === 2, 'Tresor: veraltete Version → Konflikt mit aktuellem Stand');

console.log('\n== Server: Profilbilder');
// Der Server prüft nur die Kennung am Anfang – ein JPEG-Gerüst genügt.
const jpeg = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0, 16, 0x4A, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xFF, 0xD9]);
const sha = async (bytes) => C.toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
const avHash = await sha(jpeg);
const avCard = await C.signCard(acc.privateKey, { v: 1, id: accId, kind: 'account', name: uname, av: avHash, ts: Date.now() });
r = await call('avatar', { d: C.b64(jpeg), card: avCard }, TA.token);
ok(!r.ok && r._status === 403, 'temporäre Sitzung: kein Profilbild');
r = await call('avatar', { d: C.b64(C.te.encode('<svg onload="alert(1)"></svg>')), card: avCard }, accToken);
ok(!r.ok && r._status === 422, 'kein Bild (etwa SVG mit Skript) → 422');
r = await call('avatar', { d: C.b64(jpeg), card: avCard }, accToken);
ok(r.ok && r.cv === 2, 'Konto setzt ein Profilbild, Karte in Version 2');
r = await call('avatars', { ids: [accId, TA.id] }, TA.token);
ok(r.ok && r.list.length === 1 && r.list[0].id === accId, 'Profilbild abrufbar – nur für wen es eins gibt');
ok(r.ok && (await sha(C.unb64(r.list[0].d))) === avHash, 'Bild passt zum SHA-256-Wert auf der signierten Karte');
r = await call('ids', { ids: [accId] }, TA.token);
ok(r.list[0].cv === 2 && (await C.verifyCard(acc.publicKey, r.list[0].card)).av === avHash, 'Andere sehen die neue Karte samt Bildwert');
r = await call('avatar', { d: '', card: accCard }, accToken);
ok(r.ok, 'Profilbild entfernt');
r = await call('avatars', { ids: [accId] }, TA.token);
ok(r.ok && r.list.length === 0, 'danach kein Bild mehr beim Server');

console.log('\n== Server: Räume');
const roomId = C.randomId();
const rk = C.newRoomKey();
const rkey = await C.importRoomKey(rk);
const meta = await C.sealRoom({ t: 'meta', name: 'Test', ch: [{ id: 'c1', name: 'allgemein' }] }, rkey, 1, roomId, TA.privateKey);
r = await call('room.create', { id: roomId, meta }, TA.token);
ok(r.ok && r.room.owner === TA.id && r.room.epoch === 1, 'Anna erstellt einen Raum');
r = await call('room.invite', { id: roomId }, TA.token);
ok(r.ok && r.code && r.epoch === 1, 'Einladung erstellt');
const code = r.code;
r = await call('room.join', { id: roomId, code: 'falsch' + code.slice(6) }, TB.token);
ok(!r.ok && r._status === 403, 'falscher Einladungscode → 403');
r = await call('room.join', { id: roomId, code }, TB.token);
ok(r.ok && r.room.members.length === 2, 'Bob tritt mit der Einladung bei');
const m1 = await C.sealRoom({ t: 'msg', ch: 'c1', body: 'Hallo zusammen', from: TB.id }, rkey, 1, roomId, TB.privateKey);
r = await call('room.post', { id: roomId, k: 'msg', d: m1 }, TB.token);
ok(r.ok && r.s >= 1, 'Bob schreibt in den Raum');
r = await call('poll', { i: { s: 0, o: 0, g: 0 }, r: { [roomId]: { s: 0, o: 0, g: 0, tail: 200 } } }, TA.token);
const feed = r.r[roomId].e;
ok(feed.some(e => e.k === 'sys' && e.ev === 'join') && feed.some(e => e.k === 'msg'), 'Anna sieht Beitritt und Nachricht');
const msgEntry = feed.find(e => e.k === 'msg');
const readRoom = await C.openRoom(msgEntry.d, rkey, roomId, [TA.publicKey, TB.publicKey]);
ok(readRoom.obj.body === 'Hallo zusammen' && readRoom.signer === TB.fingerprint, 'Raumnachricht entschlüsselt, Bob als Absender bestätigt');
const bigMeta = await C.sealRoom({ t: 'meta', name: 'Test', ch: [{ id: 'c1', name: 'allgemein' }], vch: [{ id: '', name: 'Sprache' }, { id: 'zwei', name: 'Zwei' }],
  img: 'data:image/jpeg;base64,' + 'A'.repeat(20000) }, rkey, 1, roomId, TA.privateKey);
r = await call('room.meta', { id: roomId, meta: bigMeta, e: 1 }, TA.token);
ok(r.ok && bigMeta.length > 16384, 'Raumdaten mit Raumbild (' + Math.round(bigMeta.length / 1024) + ' KB, verschlüsselt) passen');

r = await call('room.voice', { id: roomId, on: true }, TA.token);
ok(r.ok && r.vc.includes(TA.id), 'Anna betritt den Sprachkanal');
const sig = await C.sealRoom({ t: 'rtc', kind: 'offer', sdp: 'v=0' }, rkey, 1, roomId, TA.privateKey);
r = await call('room.post', { id: roomId, k: 'sig', to: TB.id, d: sig }, TA.token);
ok(r.ok, 'Signal an Bob im Raum');
r = await call('poll', { r: { [roomId]: { s: 0, o: 0, g: 0 } }, v: [roomId] }, TB.token);
ok(r.r[roomId].e.some(e => e.k === 'sig' && e.to === TB.id), 'Bob bekommt das an ihn gerichtete Signal');
ok(r.rooms[roomId].vc.includes(TA.id), 'Bob sieht Anna im Sprachkanal');
r = await call('poll', { r: { [roomId]: { s: 0, o: 0, g: 0 } } }, TA.token);
ok(!r.r[roomId].e.some(e => e.k === 'sig'), 'Anna bekommt ihr eigenes Signal an Bob nicht zurück');

r = await call('room.voice', { id: roomId, on: true, ch: 'zwei' }, TB.token);
ok(r.ok && r.vcs.zwei?.includes(TB.id) && r.vcs['']?.includes(TA.id), 'Bob betritt einen zweiten Sprachkanal');
r = await call('poll', { v: [roomId] }, TA.token);
ok(r.rooms[roomId].vc.join() === TA.id && r.rooms[roomId].vcs.zwei?.join() === TB.id, 'Abruf: erster Kanal für ältere Apps, alle Kanäle getrennt');
r = await call('room.voice', { id: roomId, on: true, ch: '' }, TB.token);
ok(r.ok && !r.vcs.zwei && r.vcs[''].length === 2, 'Kanalwechsel: Bob ist nur noch im ersten Kanal');
r = await call('room.voice', { id: roomId, on: true, ch: 'nicht gültig!' }, TB.token);
ok(!r.ok && r._status === 422, 'ungültige Kanalkennung → 422');
r = await call('room.voice', { id: roomId, on: false }, TB.token);
ok(r.ok && !r.vcs[''].includes(TB.id), 'Bob verlässt die Sprache');

r = await call('room.kick', { id: roomId, member: TB.id }, TB.token);
ok(!r.ok && r._status === 403, 'Nur der Besitzer darf entfernen');
r = await call('room.kick', { id: roomId, member: TB.id }, TA.token);
ok(r.ok, 'Anna entfernt Bob');
r = await call('room.post', { id: roomId, k: 'msg', d: m1 }, TB.token);
ok(!r.ok && r._status === 403, 'Bob kann nicht mehr schreiben');
const newKey = C.newRoomKey();
const env = await C.sealFor({ t: 'roomkey', room: roomId, epoch: 2, key: newKey }, [TA.publicKey], TA.privateKey);
const meta2 = await C.sealRoom({ t: 'meta', name: 'Test', ch: [] }, await C.importRoomKey(newKey), 2, roomId, TA.privateKey);
r = await call('room.rotate', { id: roomId, e: 2, env, meta: meta2 }, TA.token);
ok(r.ok && r.room.epoch === 2, 'Neuer Raumschlüssel (Generation 2)');
r = await call('room.join', { id: roomId, code }, TB.token);
ok(!r.ok && r._status === 403, 'alte Einladung ist nach dem Schlüsselwechsel ungültig');

console.log('\n== Aufräumen');
r = await call('end', {}, TB.token);
ok(r.ok, 'Bob beendet seine temporäre Sitzung');
r = await call('me', {}, TB.token);
ok(!r.ok && r._status === 401, 'Bobs Token ist ungültig');
r = await call('ids', { ids: [TB.id] }, TA.token);
ok(r.ok && r.list.length === 0, 'Bobs Identität ist gelöscht');
r = await call('end', {}, TA.token);
ok(r.ok, 'Anna beendet ihre Sitzung (ihr Raum verschwindet mit)');
r = await call('me', {}, TA.token);
ok(!r.ok && r._status === 401, 'Annas Token ist ungültig');
r = await call('delete', { auth: keys.auth }, accToken);
ok(r.ok, 'Konto gelöscht');
r = await call('login', { username: uname, auth: keys.auth });
ok(!r.ok, 'Anmelden mit gelöschtem Konto scheitert');

console.log('\n' + (failures ? failures + ' FEHLER' : 'Alles bestanden.'));
process.exit(failures ? 1 : 0);
