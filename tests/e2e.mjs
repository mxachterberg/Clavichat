// Clavichat — Ende-zu-Ende-Test: Kryptografie-Modul und Server zusammen.
//
//   php -S 127.0.0.1:8130 -t server        (in einem zweiten Fenster)
//   node tests/e2e.mjs
//
// Anderer Server: SECURECOM_API=https://example.com/securecom/api.php node tests/e2e.mjs
// Server mit Zugangscode: zusätzlich SECURECOM_CODE=<code> (Gäste von
// Einmal-Meetings kommen auch dann ohne Code hinein – das prüft der Test).
// Achtung: Der Test legt Identitäten an und löscht sie am Ende wieder.
import * as C from '../server/assets/securecom-core.js';

const API = process.env.SECURECOM_API || 'http://127.0.0.1:8130/api.php';
const ACCESS = process.env.SECURECOM_CODE || '';
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
  const r = await call('temp', { id, pub: idn.armoredPublic, fp: idn.fingerprint, card, code: ACCESS });
  return Object.assign({ id, token: r.token, res: r }, idn);
}

// Gast eines Einmal-Meetings: statt Zugangscode die Einladung aus dem Link.
async function makeGuest(alias, room, code) {
  const idn = await C.generateIdentity();
  const id = C.randomId();
  const card = await C.signCard(idn.privateKey, { v: 1, id, kind: 'temp', guest: 1, name: alias, ts: Date.now() });
  const r = await call('temp', { id, pub: idn.armoredPublic, fp: idn.fingerprint, card, guest: 1, room, code });
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
// Die Signatur (Ed25519 an v4-Schlüsseln, im MPI-Format) ist selten ein Byte
// kürzer – unabhängig vom Inhalt. Ohne Auffüllen wären es ~150 Byte Unterschied.
ok(Math.abs(short - longer) <= 2, 'Auffüllen: 2 und 150 Zeichen ergeben gleich große Pakete (' + short + ' / ' + longer + ' B)');

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
const tempRoomDays = r.temp_room_days;
ok(Number.isInteger(tempRoomDays) && tempRoomDays >= 1, 'Frist für Räume aus temporären Sitzungen: ' + tempRoomDays + ' Tage');
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
r = await call('register', { username: uname, auth: keys.auth, id: accId, pub: acc.armoredPublic, fp: acc.fingerprint, card: accCard, wrapped: accWrapped, code: ACCESS });
ok(r.ok && r.token && r.kind === 'account', 'Konto angelegt (ohne E-Mail)');
r = await call('register', { username: uname.toUpperCase(), auth: keys.auth, id: C.randomId(), pub: acc.armoredPublic, fp: acc.fingerprint, card: accCard, wrapped: accWrapped, code: ACCESS });
ok(!r.ok && r._status === 409, 'Name doppelt (andere Schreibweise) wird abgelehnt');
r = await call('login', { username: uname, auth: (await C.deriveAccountKeys(uname, 'falsch')).auth });
ok(!r.ok && r._status === 401, 'falsches Passwort → 401');
r = await call('login', { username: uname.toLowerCase(), auth: keys.auth });
ok(r.ok && r.wrapped === accWrapped, 'Anmelden: Server liefert den eingepackten Schlüssel');
const accToken = r.token;
const unwrapped = await C.readPrivateIdentity(await C.openText(wkey, r.wrapped, 'sc-key|' + uname.toLowerCase()));
ok(unwrapped.fingerprint === acc.fingerprint, 'Anmelden: privater Schlüssel im Browser ausgepackt');

// Konten stehen nie in der Online-Liste und verraten ihren Status niemandem.
ok(r.vis === false, 'Konto: Anmeldeantwort meldet „nicht in der Online-Liste“');
await call('poll', { i: { s: 0, o: 0, g: 0 } }, accToken);   // jetzt ist das Konto online
r = await call('card', { vis: true }, accToken);
ok(r.ok && r.vis === false, 'Konto kann sich nicht in die Online-Liste stellen');
r = await call('online', {}, TA.token);
ok(r.ok && !r.list.find(x => x.id === accId) && !!r.list.find(x => x.id === TB.id), 'Online-Liste: Konto fehlt, temporäre Sitzung steht drin');
r = await call('ids', { ids: [accId] }, TA.token);
ok(r.ok && r.list.length === 1 && r.list[0].on === null, 'Status eines Kontos per Kennung: unbekannt');
r = await call('find', { fp: acc.fingerprint }, TA.token);
ok(r.ok && r.list.length === 1 && r.list[0].on === null, 'Status eines Kontos per Fingerabdruck: unbekannt');
r = await call('me', {}, accToken);
ok(r.ok && r.vis === false && r.kind === 'account', 'Konto sieht bei sich selbst: nicht sichtbar');
r = await call('vault', { vault: C.b64(C.te.encode('x')), vv: 1 }, accToken);
ok(r.ok && r.vv === 2, 'Tresor gespeichert (Version 2)');
r = await call('vault', { vault: C.b64(C.te.encode('y')), vv: 1 }, accToken);
ok(!r.ok && r._status === 409 && r.vv === 2, 'Tresor: veraltete Version → Konflikt mit aktuellem Stand');

console.log('\n== Server: Geräte');
const devB = C.randomId();
const label = C.b64(C.te.encode('Gerätename (im Browser verschlüsselt)'));
r = await call('me', {}, accToken);
ok(r.ok && r.dl === false, 'neue Sitzung hat noch keinen Gerätenamen');
r = await call('device.label', { n: label }, accToken);
ok(r.ok, 'Gerätename abgelegt (der Server sieht nur Chiffretext)');
r = await call('me', {}, accToken);
ok(r.dl === true, 'me meldet: Gerätename vorhanden');
const tv0 = (await call('poll', { i: { s: 0, o: 0, g: 0 } }, accToken)).tv;
ok(typeof tv0 === 'number' && tv0 >= 1, 'Abruf liefert den Anmeldezähler des Kontos');
r = await call('login', { username: uname, auth: keys.auth, dev: devB });
const tokB1 = r.token;
ok(r.ok && r.tv === tv0 + 1, 'neues Gerät: Anmeldezähler steigt');
r = await call('poll', { i: { s: 0, o: 0, g: 0 } }, accToken);
ok(r.tv === tv0 + 1, 'die anderen Geräte sehen den neuen Zähler im Abruf');
r = await call('login', { username: uname, auth: keys.auth, dev: devB });
ok(r.ok && r.tv === tv0 + 1, 'erneut auf demselben Gerät angemeldet: Zähler bleibt');
r = await call('devices', {}, accToken);
const own = r.list && r.list.find(d => d.cur);
// Sitzungen: Registrieren, Anmelden, zweimal Gerät B.
ok(r.ok && r.list.length === 4 && r.list.filter(d => d.cur).length === 1, 'Geräteliste: vier Sitzungen, genau eine ist diese');
ok(own && own.n === label, 'Geräteliste: Name kommt so zurück, wie er abgelegt wurde');
ok(r.list.every(d => /^[0-9a-f]{16}$/.test(d.h) && !('d' in d)), 'Geräteliste: nur Kurzkennung, nie die Geräte-Kennung');
r = await call('device.revoke', { h: own.h }, accToken);
ok(r.ok && r.n === 0, 'die eigene Sitzung lässt sich so nicht abmelden');
r = await call('device.revoke', { others: 1 }, accToken);
ok(r.ok && r.n === 3 && r.list.length === 1, 'alle anderen Geräte abgemeldet');
r = await call('poll', { i: { s: 0, o: 0, g: 0 } }, tokB1);
ok(!r.ok && r._status === 401 && r.revoked === true, 'abgemeldetes Gerät erfährt es beim nächsten Abruf');
r = await call('login', { username: uname, auth: keys.auth, dev: devB, silent: 1 });
ok(!r.ok && r._status === 403 && r.revoked === true, 'stilles Wiederanmelden des abgemeldeten Geräts → 403');
r = await call('login', { username: uname, auth: keys.auth, dev: devB });
ok(r.ok && r.tv === tv0 + 2, 'mit Passwort kommt es wieder hinein – als neue Anmeldung gezählt');
r = await call('login', { username: uname, auth: keys.auth, dev: devB, silent: 1 });
ok(r.ok && r.tv === tv0 + 2, 'danach klappt auch das stille Anmelden wieder');
r = await call('devices', {}, TA.token);
ok(!r.ok, 'temporäre Sitzungen haben keine Geräteliste');

console.log('\n== Server: Forward Secrecy');
r = await call('key.lease', {}, accToken);
ok(r.ok && r.lease === true, 'Schlüsselwechsel: Sperre bekommen');
r = await call('key.lease', {}, accToken);
ok(r.ok && r.lease === false, 'ein zweites Gerät bekommt sie nicht gleichzeitig');
const rotated = await C.addEncryptionSubkey(acc.privateKey);
const rotatedId = await C.identityFromPrivate(rotated);
r = await call('key.pub', { pub: rotatedId.armoredPublic, fp: TA.fingerprint }, accToken);
ok(!r.ok && r._status === 409, 'anderer Hauptschlüssel → 409');
r = await call('key.pub', { pub: rotatedId.armoredPublic, fp: rotatedId.fingerprint }, accToken);
ok(r.ok && r.kv >= 2, 'neuer öffentlicher Schlüssel (gleicher Hauptschlüssel)');
r = await call('ids', { ids: [accId] }, TA.token);
const seenKey = await C.readPublicKey(r.list[0].pub);
ok(C.encryptionSubkeys(seenKey).length === 2 && seenKey.getFingerprint() === acc.fingerprint, 'andere sehen den neuen Unterschlüssel, Fingerabdruck gleich');
const toNew = await C.sealFor({ t: 'msg', body: 'an den neuen' }, [seenKey], TA.privateKey);
const pruned = (await C.pruneEncryptionSubkeys(rotated, 1, Date.now() + 5000)).key;
ok((await C.openSealed(toNew, pruned, [TA.publicKey])).obj.body === 'an den neuen', 'Absender nehmen den neuen Unterschlüssel – lesbar auch ohne den alten');
r = await call('key.lease', {}, accToken);
ok(r.lease === true, 'nach dem Veröffentlichen ist die Sperre wieder frei');
const newWrapped = await C.sealText(wkey, C.armorPrivate(rotated), 'sc-key|' + uname.toLowerCase());
r = await call('key.wrap', { auth: (await C.deriveAccountKeys(uname, 'falsch')).auth, wrapped: newWrapped }, accToken);
ok(!r.ok && r._status === 403, 'eingepackten Schlüssel ersetzen nur mit Passwort');
r = await call('key.wrap', { auth: keys.auth, wrapped: newWrapped }, accToken);
ok(r.ok, 'mit Passwort: eingepackter Schlüssel ersetzt');
r = await call('login', { username: uname, auth: keys.auth, dev: devB });
const relogged = r.ok ? await C.readPrivateIdentity(await C.openText(wkey, r.wrapped, 'sc-key|' + uname.toLowerCase())) : null;
ok(relogged && C.encryptionSubkeys(relogged.privateKey).length === 2, 'Anmelden liefert den neuen eingepackten Schlüssel');
r = await call('key.lease', {}, TA.token);
ok(r.ok && r.lease === true, 'temporäre Sitzungen wechseln auch');

console.log('\n== Server: Dateien');
const fid = C.randomId();
const fkey = await C.importFileKey(C.newFileKey());
const fdata = new Uint8Array(C.FILE_CHUNK + 1000).fill(7);
const ftotal = C.fileChunks(fdata.length);
const fpart = (n) => fdata.subarray(n * C.FILE_CHUNK, Math.min(fdata.length, (n + 1) * C.FILE_CHUNK));
const fsealed = [await C.sealChunk(fkey, fid, 0, ftotal, fpart(0)), await C.sealChunk(fkey, fid, 1, ftotal, fpart(1))];
const fput = (n, token, extra) => call('file.put', Object.assign({ id: fid, n, of: ftotal, size: fdata.length, d: C.b64(fsealed[n]), ttl: 3600 }, extra || {}), token);
r = await call('config');
ok(r.file_max >= 1048576 && r.file_chunk === C.FILE_CHUNK, 'config nennt größte Datei und Stückgröße');
r = await fput(1, TA.token);
ok(!r.ok && r._status === 404, 'Stück 1 ohne Anfang → 404');
r = await fput(0, TA.token, { d: C.b64(fsealed[1]) });
ok(!r.ok && r._status === 422, 'falsche Stücklänge → 422');
r = await fput(0, TA.token);
ok(r.ok && !r.done, 'Stück 0 hochgeladen');
r = await fput(0, TA.token);
ok(r.ok, 'Stück 0 noch einmal (Antwort ging verloren) geht');
r = await fput(1, TB.token);
ok(!r.ok && r._status === 404, 'eine andere Identität kann nicht weiterschreiben');
r = await call('file.get', { id: fid, n: 0 }, TB.token);
ok(!r.ok && r._status === 404, 'halb hochgeladene Datei gibt es noch nicht');
r = await fput(1, TA.token);
ok(r.ok && r.done, 'letztes Stück – Datei fertig');
r = await call('file.get', { id: fid, n: 1 }, TB.token);
const fback = r.ok ? await C.openChunk(fkey, fid, 1, ftotal, C.unb64(r.d)) : new Uint8Array(0);
ok(r.ok && fback.length === 1000 && fback[0] === 7, 'Bob holt Stück 1 und entschlüsselt es');
r = await call('file.get', { id: fid, n: 0 });
ok(!r.ok && r._status === 401, 'ohne Anmeldung kein Abruf');
r = await call('file.del', { id: fid }, TB.token);
r = await call('file.get', { id: fid, n: 0 }, TB.token);
ok(r.ok, 'fremdes Löschen ändert nichts');
r = await call('file.del', { id: fid }, TA.token);
r = await call('file.get', { id: fid, n: 0 }, TB.token);
ok(!r.ok && r._status === 404, 'die Besitzerin löscht – Datei weg');
r = await call('file.put', { id: C.randomId(), n: 0, of: 1, size: 200 * 1048576, d: 'AAAA' }, TA.token);
ok(!r.ok && r._status === 413, 'zu große Datei → 413');
// Bobs Datei verschwindet mit seiner Sitzung (siehe Aufräumen).
const bobFile = C.randomId();
const bobFileKey = await C.importFileKey(C.newFileKey());
r = await call('file.put', { id: bobFile, n: 0, of: 1, size: 5, d: C.b64(await C.sealChunk(bobFileKey, bobFile, 0, 1, new Uint8Array(5))) }, TB.token);
ok(r.ok && r.done, 'kleine Datei in einem Stück');

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
ok(r.room.tmp === true && Math.abs(r.room.exp - (Math.floor(Date.now() / 1000) + tempRoomDays * 86400)) < 120,
  'Raum einer temporären Sitzung verfällt nach ' + tempRoomDays + ' Tagen ohne Aktivität');
const accRoom = C.randomId();
const accMeta = await C.sealRoom({ t: 'meta', name: 'Konto', ch: [{ id: 'c1', name: 'allgemein' }] }, rkey, 1, accRoom, acc.privateKey);
r = await call('room.create', { id: accRoom, meta: accMeta }, accToken);
ok(r.ok && r.room.tmp === false && r.room.exp === 0, 'Raum eines Kontos verfällt nicht');
r = await call('room.delete', { id: accRoom }, accToken);
ok(r.ok, 'Konto löscht seinen Raum wieder');
r = await call('room.invite', { id: roomId }, TA.token);
ok(r.ok && r.code && r.epoch === 1, 'Einladung erstellt');
const code = r.code;
r = await call('rooms', {}, TA.token);
ok(r.ok && r.rooms.find(x => x.id === roomId).iv === 1, 'Raum nennt offene Einladungen (dann kein automatischer Schlüsselwechsel)');
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
r = await call('rooms', {}, TA.token);
ok(r.ok && r.rooms.find(x => x.id === roomId).iv === 0, 'nach dem Wechsel keine offenen Einladungen mehr');

console.log('\n== Verlauf für neue Mitglieder (Schlüsselarchiv in den Raumdaten)');
{
  // Nachricht in Generation 2, dann Wechsel auf 3 – einmal ohne, einmal mit Archiv.
  const key2 = await C.importRoomKey(newKey);
  const old = await C.sealRoom({ t: 'msg', id: C.randomId(), ch: 'c1', body: 'Aus Generation 2', from: TA.id, room: roomId }, key2, 2, roomId, TA.privateKey);
  r = await call('room.post', { id: roomId, k: 'msg', d: old }, TA.token);
  ok(r.ok, 'Anna schreibt in Generation 2');
  const raw3 = C.newRoomKey();
  const key3 = await C.importRoomKey(raw3);
  const env3 = await C.sealFor({ t: 'roomkey', room: roomId, epoch: 3, key: raw3 }, [TA.publicKey], TA.privateKey);
  r = await call('room.rotate', { id: roomId, e: 3, env: env3, meta: await C.sealRoom({ t: 'meta', name: 'Test', ch: [{ id: 'c1', name: 'allgemein' }] }, key3, 3, roomId, TA.privateKey) }, TA.token);
  ok(r.ok && r.room.epoch === 3, 'Wechsel auf Generation 3 (ohne Archiv)');
  const joinWith = async (alias) => {
    const inv = await call('room.invite', { id: roomId }, TA.token);
    const T = await makeTemp(alias);
    const j = await call('room.join', { id: roomId, code: inv.code }, T.token);
    const p = await call('poll', { i: { s: 0, o: 0, g: 0 }, r: { [roomId]: { s: 0, o: 0, g: 0, tail: 200 } } }, T.token);
    const rs = await call('rooms', {}, T.token);
    return { T, joined: j.ok && inv.epoch === 3, feed: p.r[roomId].e, room: rs.rooms.find(x => x.id === roomId) };
  };
  const readOld = async (feed, keys) => {
    const e = feed.find(x => x.k === 'msg' && C.roomEpoch(x.d) === 2);
    if (!e || !keys[2]) return null;
    try { return (await C.openRoom(e.d, await C.importRoomKey(keys[2]), roomId, [TA.publicKey])).obj.body; } catch (err) { return null; }
  };
  let J = await joinWith('Ohne Verlauf');
  ok(J.joined && J.feed.some(x => x.k === 'msg' && C.roomEpoch(x.d) === 2), 'neues Mitglied bekommt den alten Eintrag (Generation 2) vom Server');
  let mobj = (await C.openRoom(J.room.meta, key3, roomId, [TA.publicKey])).obj;
  ok(!mobj.ka && !mobj.hist && (await readOld(J.feed, {})) === null, 'ohne Einstellung: kein Archiv, alte Nachricht unlesbar');
  await call('end', {}, J.T.token);
  // Besitzer schaltet „Neue Mitglieder sehen den Verlauf“ ein: Archiv mit Generation 1 und 2.
  const ka = { 1: { k: rk, t: Date.now() - 86400000 }, 2: { k: newKey, t: Date.now() - 3600000 } };
  const metaH = await C.sealRoom({ t: 'meta', name: 'Test', ch: [{ id: 'c1', name: 'allgemein' }], hist: 1, ka }, key3, 3, roomId, TA.privateKey);
  r = await call('room.meta', { id: roomId, meta: metaH, e: 3 }, TA.token);
  ok(r.ok, 'Raumdaten mit Schlüsselarchiv gespeichert');
  r = await call('rooms', {}, TA.token);
  const stored = r.rooms.find(x => x.id === roomId).meta;
  ok(stored === metaH && !stored.includes(newKey) && !stored.includes(rk), 'Server hat nur Chiffretext (keine Schlüssel im Klartext)');
  J = await joinWith('Mit Verlauf');
  mobj = (await C.openRoom(J.room.meta, key3, roomId, [TA.publicKey])).obj;
  ok(mobj.hist === 1 && mobj.ka && mobj.ka[2].k === newKey, 'neues Mitglied entschlüsselt das Archiv mit dem Link-Schlüssel');
  ok((await readOld(J.feed, { 2: mobj.ka[2].k })) === 'Aus Generation 2', 'neues Mitglied liest die Nachricht aus Generation 2');
  await call('end', {}, J.T.token);
}

console.log('\n== Server: Meetings und Gäste');
r = await call('config');
const onceHours = r.once_hours;
ok(onceHours === 12, 'config nennt die Ruhezeit von Einmal-Meetings: ' + onceHours + ' Stunden');
if (ACCESS) {
  const idn = await C.generateIdentity();
  const nid = C.randomId();
  r = await call('temp', { id: nid, pub: idn.armoredPublic, fp: idn.fingerprint, card: await C.signCard(idn.privateKey, { v: 1, id: nid, kind: 'temp', name: 'X', ts: Date.now() }) });
  ok(!r.ok && r._status === 403, 'Server mit Zugangscode: temporäre Sitzung ohne Code → 403');
}
const onceId = C.randomId();
const onceKey = await C.importRoomKey(C.newRoomKey());
const onceMeta = await C.sealRoom({ t: 'meta', name: 'Schnell', ch: [{ id: 'c1', name: 'chat' }], meet: 1, once: 1 }, onceKey, 1, onceId, TA.privateKey);
r = await call('room.create', { id: onceId, meta: onceMeta, once: 1 }, TA.token);
ok(r.ok && r.room.ot === true && r.room.tmp === true, 'Anna startet ein schnelles Meeting (einmalig, verfällt)');
ok(r.ok && Math.abs(r.room.exp - (Math.floor(Date.now() / 1000) + onceHours * 3600)) < 120, 'Einmal-Meeting verfällt nach ' + onceHours + ' Stunden ohne Aktivität');
r = await call('room.invite', { id: onceId, max: 100, days: 1 }, TA.token);
ok(r.ok && r.code, 'Meeting-Link (Einladung) erstellt');
const onceCode = r.code;
const plainId = C.randomId();
const plainMeta = await C.sealRoom({ t: 'meta', name: 'Normal', ch: [{ id: 'c1', name: 'allgemein' }] }, onceKey, 1, plainId, TA.privateKey);
r = await call('room.create', { id: plainId, meta: plainMeta }, TA.token);
ok(r.ok && r.room.ot === false, 'normaler Raum ist kein Einmal-Meeting');
r = await call('room.invite', { id: plainId }, TA.token);
const plainCode = r.code;

let G = await makeGuest('Gast', onceId, 'falsch' + onceCode.slice(6));
ok(!G.res.ok && G.res._status === 403 && /ungültig oder abgelaufen/.test(G.res.error || ''), 'Gast mit falschem Code → 403 „Meeting-Link ungültig oder abgelaufen“');
G = await makeGuest('Gast', plainId, plainCode);
ok(!G.res.ok && G.res._status === 403, 'Gast mit gültiger Einladung eines normalen Raums → 403');
G = await makeGuest('Gast', C.randomId(), onceCode);
ok(!G.res.ok && G.res._status === 403, 'Gast für ein unbekanntes Meeting → 403');
const TG = await makeGuest('Gast Gustav', onceId, onceCode);
ok(TG.res.ok && TG.token && TG.res.guest === true && TG.res.kind === 'temp', 'Gast mit gültigem Meeting-Link' + (ACCESS ? ' (ohne Zugangscode)' : '') + ' bekommt eine Sitzung');
r = await call('me', {}, TG.token);
ok(r.ok && r.guest === true && r.vis === false, 'me: Gast, nicht sichtbar');
r = await call('me', {}, TA.token);
ok(r.ok && r.guest === false, 'me: normale temporäre Sitzung ist kein Gast');
r = await call('room.join', { id: plainId, code: plainCode }, TG.token);
ok(!r.ok && r._status === 403, 'Gast kann keinem normalen Raum beitreten');
r = await call('room.join', { id: onceId, code: onceCode }, TG.token);
ok(r.ok && r.room.members.length === 2 && r.room.ot === true, 'Gast tritt dem Einmal-Meeting bei');
r = await call('room.create', { id: C.randomId(), meta: onceMeta }, TG.token);
ok(!r.ok && r._status === 403, 'Gast kann keinen Raum anlegen');
r = await call('room.create', { id: C.randomId(), meta: onceMeta, once: 1 }, TG.token);
ok(!r.ok && r._status === 403, 'Gast kann kein Meeting anlegen');
r = await call('room.invite', { id: plainId }, TG.token);
ok(!r.ok && r._status === 403, 'Gast kann keine Einladung für einen normalen Raum erstellen');
r = await call('room.invite', { id: onceId, max: 100, days: 1 }, TA.token);
ok(r.ok && r.ap === false, 'Link der Gastgeberin: Beitritt ohne Bestätigung');

console.log('\n== Server: Beitritt mit Bestätigung (Links von Teilnehmern)');
r = await call('room.invite', { id: onceId, max: 100, days: 1 }, TG.token);
ok(r.ok && r.code && r.ap === true, 'Gast erstellt einen Link zu seinem Meeting (Beitritt braucht Zustimmung)');
const gCode = r.code;
r = await call('invite.info', { id: onceId, code: onceCode });
ok(r.ok && r.ao === false && r.m === onceMeta && r.n === 2, 'invite.info zum Meeting-Link der Gastgeberin: Raumdaten für die Vorschau');
ok((await C.openRoom(r.m, onceKey, onceId, [])).obj.name === 'Schnell', 'Meeting-Vorschau: Name mit dem Link-Schlüssel lesbar');
r = await call('invite.info', { id: onceId, code: gCode });
ok(r.ok && r.ao === false && Object.keys(r).filter(k => k !== '_status').sort().join() === 'ao,ok', 'invite.info zum Link eines Teilnehmers (Zustimmung nötig): keine Raumdaten');
r = await call('room.invite', { id: onceId, max: 100, days: 1 }, TG.token);
ok(r.ok && r.code === gCode, 'Gast bekommt wieder denselben Link (keine Flut offener Einladungen)');
const TW = await makeGuest('Gast Wanda', onceId, gCode);
ok(TW.res.ok && TW.res.guest === true, 'Gast-Sitzung mit dem Link eines Gasts');
const wmsg = await C.sealRoom({ t: 'msg', ch: 'c1', body: 'Hallo von Wanda', from: TW.id }, onceKey, 1, onceId, TW.privateKey);
r = await call('room.join', { id: onceId, code: gCode }, TW.token);
ok(r.ok && r.room.pending === true && !r.room.members && r.room.x > Date.now() / 1000, 'Beitritt über den Gast-Link: wartet auf die Gastgeberin');
r = await call('rooms', {}, TW.token);
ok(r.ok && r.rooms.length === 0, 'Wartende ist noch kein Mitglied');
r = await call('room.post', { id: onceId, k: 'msg', d: wmsg }, TW.token);
ok(!r.ok && r._status === 403, 'Wartende kann nicht schreiben');
r = await call('room.voice', { id: onceId, on: true }, TW.token);
ok(!r.ok && r._status === 403, 'Wartende kann den Call nicht betreten');
r = await call('poll', { w: onceId, i: { s: 0, o: 0, g: 0 }, r: { [onceId]: { s: 0, o: 0, g: 0, tail: 50 } } }, TW.token);
ok(r.ok && r.w === 'wait' && !r.r[onceId], 'poll: Anfrage offen, Verlauf bleibt verschlossen');
r = await call('room.join', { id: onceId, code: gCode }, TW.token);
ok(r.ok && r.room.pending === true, 'erneutes Nachfragen per room.join: wartet weiter');
r = await call('rooms', {}, TA.token);
let annaOnce = r.rooms.find(x => x.id === onceId);
ok(r.ok && annaOnce.pend.length === 1 && annaOnce.pend[0].id === TW.id && annaOnce.pend[0].x > annaOnce.pend[0].t, 'Gastgeberin sieht die Anfrage (rooms/pend)');
r = await call('rooms', {}, TG.token);
ok(r.ok && r.rooms[0].pend.length === 0, 'andere Teilnehmer sehen keine Anfragen');
r = await call('room.kick', { id: onceId, member: TW.id, pend: 'yes' }, TG.token);
ok(!r.ok && r._status === 403, 'nur die Gastgeberin entscheidet');
r = await call('room.kick', { id: onceId, member: TW.id, pend: 'yes' }, TA.token);
ok(r.ok, 'Gastgeberin lässt zu');
r = await call('poll', { w: onceId, i: { s: 0, o: 0, g: 0 } }, TW.token);
ok(r.ok && r.w === 'in', 'poll: zugelassen');
r = await call('rooms', {}, TW.token);
ok(r.ok && r.rooms.length === 1 && r.rooms[0].members.length === 3 && r.rooms[0].pend.length === 0, 'Wanda ist jetzt im Meeting');
r = await call('room.post', { id: onceId, k: 'msg', d: wmsg }, TW.token);
ok(r.ok, 'Wanda schreibt im Meeting-Chat');
r = await call('room.kick', { id: onceId, member: TW.id, pend: 'yes' }, TA.token);
ok(r.ok, 'doppeltes Zulassen stört nicht');
// Ablehnen
const TX = await makeGuest('Gast Xaver', onceId, gCode);
r = await call('room.join', { id: onceId, code: gCode }, TX.token);
ok(r.ok && r.room.pending === true, 'Xaver wartet');
r = await call('room.kick', { id: onceId, member: TX.id, pend: 'no' }, TA.token);
ok(r.ok, 'Gastgeberin lehnt ab');
r = await call('poll', { w: onceId, i: { s: 0, o: 0, g: 0 } }, TX.token);
ok(r.ok && r.w === 'no', 'poll: abgelehnt');
r = await call('room.join', { id: onceId, code: gCode }, TX.token);
ok(!r.ok && r._status === 403 && r.denied === true, 'mit demselben Link gleich wieder: abgelehnt');
r = await call('rooms', {}, TA.token);
ok(r.ok && r.rooms.find(x => x.id === onceId).members.length === 3, 'Xaver ist nicht im Meeting');
r = await call('room.kick', { id: onceId, member: TX.id, pend: 'yes' }, TA.token);
ok(!r.ok && r._status === 404, 'entschiedene Anfrage gibt es nicht mehr');
await call('end', {}, TX.token);
// Zurückziehen, Sitzung beenden
const TY = await makeGuest('Gast Yuki', onceId, gCode);
r = await call('room.join', { id: onceId, code: gCode }, TY.token);
ok(r.ok && r.room.pending === true, 'Yuki wartet');
r = await call('room.leave', { id: onceId }, TY.token);
ok(r.ok, 'Yuki zieht die Anfrage zurück');
r = await call('rooms', {}, TA.token);
ok(r.ok && r.rooms.find(x => x.id === onceId).pend.length === 0, 'Anfrage ist weg');
r = await call('poll', { w: onceId, i: { s: 0, o: 0, g: 0 } }, TY.token);
ok(r.ok && r.w === 'gone', 'poll: Anfrage weg');
r = await call('room.join', { id: onceId, code: gCode }, TY.token);
await call('end', {}, TY.token);
r = await call('rooms', {}, TA.token);
ok(r.ok && r.rooms.find(x => x.id === onceId).pend.length === 0, 'Gast beendet seine Sitzung: Anfrage verschwindet mit');
// Mit Sitzung (kein Gast) über den Link eines Teilnehmers – dann doch mit dem Link der Gastgeberin.
r = await call('room.join', { id: onceId, code: gCode }, TB.token);
ok(r.ok && r.room.pending === true, 'auch eine normale Sitzung wartet beim Link eines Teilnehmers');
r = await call('room.join', { id: onceId, code: onceCode }, TB.token);
ok(r.ok && r.room.members && r.room.members.some(m => m.id === TB.id), 'Link der Gastgeberin führt trotzdem direkt hinein');
r = await call('rooms', {}, TA.token);
ok(r.ok && r.rooms.find(x => x.id === onceId).pend.length === 0, 'damit ist auch die Anfrage erledigt');
r = await call('room.leave', { id: onceId }, TB.token);
r = await call('room.leave', { id: onceId }, TW.token);
await call('end', {}, TW.token);
if (process.env.SECURECOM_PEND_TTL) {
  // Nur gegen eine Testkopie mit verkürztem PEND_TTL (Sekunden).
  const ttl = parseInt(process.env.SECURECOM_PEND_TTL, 10);
  const TZ = await makeGuest('Gast Zoe', onceId, gCode);
  r = await call('room.join', { id: onceId, code: gCode }, TZ.token);
  ok(r.ok && r.room.pending === true, 'Zoe wartet (verkürzte Frist ' + ttl + ' s)');
  await new Promise((res) => setTimeout(res, (ttl + 2) * 1000));
  r = await call('poll', { w: onceId, i: { s: 0, o: 0, g: 0 } }, TZ.token);
  ok(r.ok && r.w === 'gone', 'ohne Antwort verfällt die Anfrage');
  r = await call('rooms', {}, TA.token);
  ok(r.ok && r.rooms.find(x => x.id === onceId).pend.length === 0, 'Gastgeberin sieht sie nicht mehr');
  r = await call('room.kick', { id: onceId, member: TZ.id, pend: 'yes' }, TA.token);
  ok(!r.ok && r._status === 404, 'verfallene Anfrage lässt sich nicht mehr annehmen');
  await call('end', {}, TZ.token);
}
console.log('\n== Server: Meetings und Gäste (Fortsetzung)');
await call('poll', { i: { s: 0, o: 0, g: 0 } }, TG.token);   // jetzt ist der Gast online
r = await call('online', {}, TA.token);
ok(r.ok && !r.list.find(x => x.id === TG.id) && !!r.list.find(x => x.id === TB.id), 'Gast steht nicht in der Online-Liste');
r = await call('card', { vis: true }, TG.token);
ok(r.ok && r.vis === false, 'Gast kann sich nicht in die Online-Liste stellen');
r = await call('online', {}, TG.token);
ok(!r.ok && r._status === 403, 'Gast sieht keine Online-Liste');
r = await call('find', { fp: TA.fingerprint }, TG.token);
ok(!r.ok && r._status === 403, 'Gast kann nicht per Fingerabdruck suchen');
r = await call('pres', { get: ['0'.repeat(64)] }, TG.token);
ok(!r.ok && r._status === 403, 'Gast hat keine Freunde-Fächer');
const gdm = await C.sealFor({ v: 1, t: 'msg', body: 'hi' }, [TA.publicKey, TG.publicKey], TG.privateKey);
r = await call('send', { to: TA.id, k: 'dm', d: gdm }, TG.token);
ok(!r.ok && r._status === 403, 'Gast kann keine Direktnachricht senden');
r = await call('send', { to: TA.id, k: 'sig', d: gdm }, TG.token);
ok(!r.ok && r._status === 403, 'Gast kann niemanden direkt anrufen');
r = await call('send', { to: TG.id, k: 'dm', d: gdm }, TA.token);
ok(!r.ok && r._status === 403, 'Direktnachrichten an Gäste gehen nicht');
r = await call('ids', { ids: [TG.id, TA.id] }, TA.token);
ok(r.ok && r.list.find(x => x.id === TG.id)?.g === true && !r.list.find(x => x.id === TA.id)?.g, 'Mitglieder sehen: Gast');
const gmsg = await C.sealRoom({ t: 'msg', ch: 'c1', body: 'Hallo vom Gast', from: TG.id }, onceKey, 1, onceId, TG.privateKey);
r = await call('room.post', { id: onceId, k: 'msg', d: gmsg }, TG.token);
ok(r.ok, 'Gast schreibt im Meeting-Chat');
r = await call('room.voice', { id: onceId, on: true }, TG.token);
ok(r.ok && r.vc.includes(TG.id), 'Gast betritt den Call');
r = await call('room.post', { id: onceId, k: 'sig', to: TA.id, d: gmsg }, TG.token);
ok(r.ok, 'Gast schickt Call-Signale im Meeting');
r = await call('ice', {}, TG.token);
ok(r.ok, 'Gast bekommt die Verbindungsserver');
r = await call('room.voice', { id: onceId, on: false }, TG.token);
// Ein Konto kommt dazu; die Besitzerin geht: Das Konto übernimmt, nicht der Gast.
r = await call('room.join', { id: onceId, code: onceCode }, accToken);
ok(r.ok && r.room.members.length === 3, 'Konto tritt dem Einmal-Meeting mit demselben Link bei');
r = await call('room.leave', { id: onceId }, TA.token);
r = await call('rooms', {}, TG.token);
ok(r.ok && r.rooms.length === 1 && r.rooms[0].owner === accId, 'Besitzerin geht: Das Konto übernimmt, nicht der Gast');
r = await call('room.join', { id: onceId, code: onceCode }, TG.token);
ok(r.ok, 'erneuter Beitritt ins eigene Meeting stört nicht');
r = await call('room.leave', { id: onceId }, accToken);
r = await call('rooms', {}, TG.token);
ok(r.ok && r.rooms.length === 0, 'nur noch Gäste übrig: Das Meeting endet');
r = await call('room.post', { id: onceId, k: 'msg', d: gmsg }, TG.token);
ok(!r.ok && r._status === 404, 'beendetes Meeting: Schreiben geht nicht mehr');
r = await call('end', {}, TG.token);
ok(r.ok, 'Gast beendet seine Sitzung');
r = await call('me', {}, TG.token);
ok(!r.ok && r._status === 401, 'Gast-Token ist ungültig');
// Die Besitzerin beendet ein Meeting für alle (room.delete).
const once2 = C.randomId();
r = await call('room.create', { id: once2, meta: await C.sealRoom({ t: 'meta', name: 'Zwei', ch: [], meet: 1, once: 1 }, onceKey, 1, once2, TA.privateKey), once: 1 }, TA.token);
const once2Code = (await call('room.invite', { id: once2, max: 100, days: 1 }, TA.token)).code;
const TG2 = await makeGuest('Gast Greta', once2, once2Code);
r = await call('room.join', { id: once2, code: once2Code }, TG2.token);
ok(r.ok, 'zweiter Gast in einem zweiten Meeting');
r = await call('room.join', { id: onceId, code: onceCode }, TG2.token);
ok(!r.ok && (r._status === 403 || r._status === 404), 'Gast ist höchstens in einem Meeting');
r = await call('room.delete', { id: once2 }, TG2.token);
ok(!r.ok && r._status === 403, 'Gast kann das Meeting nicht beenden');
r = await call('room.delete', { id: once2 }, TA.token);
ok(r.ok, 'Besitzerin beendet das Meeting');
r = await call('rooms', {}, TG2.token);
ok(r.ok && r.rooms.length === 0, 'der Gast sieht: Meeting weg');
G = await makeGuest('Nachzügler', once2, once2Code);
ok(!G.res.ok && G.res._status === 403, 'Link eines beendeten Meetings → 403');
await call('end', {}, TG2.token);
await call('room.delete', { id: plainId }, TA.token);
// Ein festes Meeting eines Kontos verfällt nicht (die App schickt dafür kein tmp).
const fixId = C.randomId();
r = await call('room.create', { id: fixId, meta: await C.sealRoom({ t: 'meta', name: 'Fest', ch: [], meet: 1 }, onceKey, 1, fixId, acc.privateKey) }, accToken);
ok(r.ok && r.room.tmp === false && r.room.ot === false && r.room.exp === 0, 'festes Meeting eines Kontos: bleibt bestehen');
await call('room.delete', { id: fixId }, accToken);

console.log('\n== Server: Räume nur für Mitglieder mit Konto');
// Zweites Konto, das per Link beitritt.
const uname2 = 'Zweite' + Math.floor(Math.random() * 1e6);
const keys2 = await C.deriveAccountKeys(uname2, 'Noch ein langes Passwort 42');
const acc2 = await C.generateIdentity();
const acc2Id = C.randomId();
const wkey2 = await C.importWrapKey(keys2.wrapRaw);
r = await call('register', { username: uname2, auth: keys2.auth, id: acc2Id, pub: acc2.armoredPublic, fp: acc2.fingerprint,
  card: await C.signCard(acc2.privateKey, { v: 1, id: acc2Id, kind: 'account', name: uname2, ts: Date.now() }),
  wrapped: await C.sealText(wkey2, C.armorPrivate(acc2.privateKey), 'sc-key|' + uname2.toLowerCase()), code: ACCESS });
ok(r.ok && r.kind === 'account', 'zweites Konto angelegt');
const acc2Token = r.token;
const aoId = C.randomId();
const aoMeta = await C.sealRoom({ t: 'meta', name: 'Nur Konten', ch: [{ id: 'c1', name: 'allgemein' }] }, rkey, 1, aoId, acc.privateKey);
r = await call('room.create', { id: aoId, meta: aoMeta, ao: 1 }, accToken);
ok(r.ok && r.room.ao === true && r.room.tmp === false, 'Konto erstellt einen Raum „nur Mitglieder mit Konto“ (ao)');
r = await call('room.create', { id: C.randomId(), meta: aoMeta, ao: 1 }, TA.token);
ok(!r.ok && r._status === 422, 'temporäre Sitzung kann keinen Raum nur für Konten anlegen → 422');
r = await call('room.create', { id: C.randomId(), meta: onceMeta, once: 1, ao: 1 }, accToken);
ok(!r.ok && r._status === 422, 'Einmal-Meeting mit ao → 422');
r = await call('room.create', { id: C.randomId(), meta: onceMeta, tmp: 1, ao: 1 }, accToken);
ok(!r.ok && r._status === 422, 'verfallender Raum (Meeting) mit ao → 422');
r = await call('room.create', { id: C.randomId(), meta: aoMeta }, accToken);
ok(r.ok && r.room.ao === false, 'ohne Angabe: Raum für alle');
await call('room.delete', { id: r.room.id }, accToken);
r = await call('room.invite', { id: aoId }, accToken);
ok(r.ok && r.code, 'Einladung zum Raum nur für Konten');
const aoCode = r.code;
r = await call('invite.info', { id: aoId, code: aoCode });
ok(r.ok && r.ao === true, 'invite.info ohne Anmeldung: Raum lässt nur Konten zu');
ok(r.ok && Object.keys(r).filter(k => k !== '_status').sort().join() === 'ao,m,me,n,ok', 'invite.info mit gültiger Einladung: nur Merkmal, verschlüsselte Raumdaten, Generation, Mitgliederzahl');
ok(r.m === aoMeta && r.me === 1 && r.n === 1, 'invite.info: Raumdaten unverändert verschlüsselt (Generation 1, 1 Mitglied)');
{
  // Vorschau wie in der App: nur mit dem Schlüssel aus dem Link (ohne Unterschriftsprüfung).
  const res = await C.openRoom(r.m, await C.importRoomKey(rk), aoId, []);
  ok(res.obj.t === 'meta' && res.obj.name === 'Nur Konten' && C.roomEpoch(r.m) === 1, 'Vorschau: Raumdaten mit dem Link-Schlüssel entschlüsselbar');
  let fail = false;
  try { await C.openRoom(r.m, await C.importRoomKey(C.newRoomKey()), aoId, []); } catch (e) { fail = true; }
  ok(fail, 'Vorschau: mit falschem Schlüssel nicht lesbar');
  fail = false;
  try { await C.openRoom(r.m, await C.importRoomKey(rk), C.randomId(), []); } catch (e) { fail = true; }
  ok(fail, 'Vorschau: an den Raum gebunden (andere Kennung → nicht lesbar)');
}
r = await call('invite.info', { id: aoId, code: 'falsch' + aoCode.slice(6) });
ok(r.ok && r.ao === false, 'invite.info mit falschem Code: nein (kein Hinweis auf das Merkmal)');
ok(Object.keys(r).filter(k => k !== '_status').sort().join() === 'ao,ok', 'invite.info mit falschem Code: keine Raumdaten');
r = await call('invite.info', { id: C.randomId(), code: aoCode });
ok(r.ok && r.ao === false && !('m' in r), 'invite.info zu unbekanntem Raum: nein, keine Raumdaten');
r = await call('invite.info', { id: 'kaputt', code: 'x' });
ok(r.ok && r.ao === false && !('m' in r), 'invite.info mit ungültigen Angaben: nein');
r = await call('room.join', { id: aoId, code: aoCode }, TB.token);
ok(!r.ok && r._status === 403 && r.account === true, 'temporäre Sitzung wird abgelehnt (403, Kennzeichen „account“)');
r = await call('room.join', { id: aoId, code: 'falsch' + aoCode.slice(6) }, TB.token);
ok(!r.ok && r._status === 403 && !r.account, 'falscher Code: „ungültig“, nicht „nur Konten“');
r = await call('room.join', { id: aoId, code: aoCode }, acc2Token);
ok(r.ok && r.room.members.length === 2 && r.room.ao === true, 'Konto tritt mit dem Link bei');
r = await call('room.ao', { id: aoId, on: 0 }, acc2Token);
ok(!r.ok && r._status === 403, 'Mitglied (nicht Besitzer) kann das Merkmal nicht umschalten');
r = await call('room.ao', { id: aoId, on: 0 }, TB.token);
ok(!r.ok && r._status === 403, 'Fremde temporäre Sitzung kann es auch nicht');
r = await call('room.ao', { id: aoId, on: 0 }, accToken);
ok(r.ok && r.room.ao === false, 'Besitzer schaltet „nur Konten“ aus');
r = await call('invite.info', { id: aoId, code: aoCode });
ok(r.ok && r.ao === false, 'invite.info: jetzt für alle');
r = await call('room.join', { id: aoId, code: aoCode }, TB.token);
ok(r.ok && r.room.members.length === 3, 'temporäre Sitzung tritt jetzt bei');
r = await call('room.ao', { id: aoId, on: 1 }, accToken);
ok(r.ok && r.room.ao === true, 'Besitzer schaltet „nur Konten“ wieder ein');
r = await call('rooms', {}, TB.token);
ok(r.ok && r.rooms.some(x => x.id === aoId && x.ao === true), 'wer schon drin ist, bleibt (auch temporär)');
const TC = await makeTemp('Carla');
r = await call('room.join', { id: aoId, code: aoCode }, TC.token);
ok(!r.ok && r._status === 403 && r.account === true, 'neue temporäre Sitzung wird wieder abgelehnt');
await call('end', {}, TC.token);
r = await call('room.ao', { id: roomId, on: 1 }, TA.token);
ok(!r.ok && r._status === 403, 'temporäre Sitzung kann „nur Konten“ nicht einschalten (eigener Raum)');
const aoOnce = C.randomId();
r = await call('room.create', { id: aoOnce, meta: await C.sealRoom({ t: 'meta', name: 'M', ch: [], meet: 1, once: 1 }, onceKey, 1, aoOnce, acc.privateKey), once: 1 }, accToken);
r = await call('room.ao', { id: aoOnce, on: 1 }, accToken);
ok(!r.ok && r._status === 422, 'Meeting: „nur Konten“ lässt sich nicht einschalten → 422');
await call('room.delete', { id: aoOnce }, accToken);
await call('room.leave', { id: aoId }, TB.token);
r = await call('room.delete', { id: aoId }, accToken);
ok(r.ok, 'Raum nur für Konten gelöscht');
console.log('\n== Server: API-Zugänge (nur posten)');
const hookRoom = C.randomId();
const hookRk = await C.importRoomKey(C.newRoomKey());
const hk = await C.newHookKeys();
const hid = C.randomId();
const hookToken = C.newHookToken();
r = await call('room.create', { id: hookRoom, meta: await C.sealRoom({ t: 'meta', name: 'News', ch: [{ id: 'c1', name: 'allgemein' }, { id: 'news', name: 'servernews' }] }, hookRk, 1, hookRoom, acc.privateKey) }, accToken);
ok(r.ok, 'Konto legt einen Raum für API-Beiträge an');
r = await call('room.invite', { id: hookRoom }, accToken);
r = await call('room.join', { id: hookRoom, code: r.code }, acc2Token);
ok(r.ok && r.room.members.length === 2, 'zweites Konto ist Mitglied');
r = await call('hook.create', { id: hookRoom, hid, th: await C.hookTokenHash(hookToken) }, acc2Token);
ok(!r.ok && r._status === 403, 'hook.create: Mitglied (nicht Besitzer) → 403');
r = await call('hook.create', { id: roomId, hid, th: await C.hookTokenHash(hookToken) }, TA.token);
ok(!r.ok && r._status === 403, 'hook.create: temporäre Sitzung (eigener Raum) → 403');
const hookMeet = C.randomId();
await call('room.create', { id: hookMeet, meta: await C.sealRoom({ t: 'meta', name: 'M', ch: [], meet: 1, once: 1 }, onceKey, 1, hookMeet, acc.privateKey), once: 1 }, accToken);
r = await call('hook.create', { id: hookMeet, hid, th: await C.hookTokenHash(hookToken) }, accToken);
ok(!r.ok && r._status === 422, 'hook.create: Meeting → 422');
await call('room.delete', { id: hookMeet }, accToken);
const hookTmp = C.randomId();
await call('room.create', { id: hookTmp, meta: await C.sealRoom({ t: 'meta', name: 'T', ch: [], meet: 1 }, onceKey, 1, hookTmp, acc.privateKey), tmp: 1 }, accToken);
r = await call('hook.create', { id: hookTmp, hid, th: await C.hookTokenHash(hookToken) }, accToken);
ok(!r.ok && r._status === 422, 'hook.create: verfallender Raum → 422');
await call('room.delete', { id: hookTmp }, accToken);
r = await call('hook.create', { id: hookRoom, hid, th: 'kein-hash' }, accToken);
ok(!r.ok && r._status === 422, 'hook.create: Token-Hash im falschen Format → 422');
r = await call('hook.create', { id: hookRoom, hid, th: await C.hookTokenHash(hookToken) }, accToken);
ok(r.ok && r.hid === hid && Object.keys(r).filter(k => k !== '_status').sort().join() === 'hid,ok', 'hook.create: Besitzer (Konto) legt einen Zugang an');
// Privater Schlüssel in die (verschlüsselten) Raumdaten
r = await call('room.meta', { id: hookRoom, e: 1, meta: await C.sealRoom({ t: 'meta', name: 'News', ch: [{ id: 'c1', name: 'allgemein' }, { id: 'news', name: 'servernews' }],
  hooks: { [hid]: { n: 'Claude', ch: 'news', k: hk.priv, c: Date.now() } } }, hookRk, 1, hookRoom, acc.privateKey) }, accToken);
ok(r.ok, 'Leseschlüssel des Zugangs steht in den Raumdaten');
const access = C.hookAccess({ u: API, r: hookRoom, h: hid, t: hookToken, k: hk.pub });
const parsed = C.parseHookAccess(access);
ok(parsed.r === hookRoom && parsed.h === hid && parsed.t === hookToken && parsed.k === hk.pub && !access.includes(hk.priv.slice(0, 20)), 'Zugang: Server, Raum, Kennung, Token, öffentlicher Schlüssel – kein privater');
const hookPlain = 'Server-Neuigkeit: Wartung um 22 Uhr';
const hookData = await C.sealHook({ v: 1, t: 'hook', id: C.randomId(), ts: Date.now(), body: hookPlain }, parsed.k, hookRoom, hid);
r = await call('hook.post', { r: hookRoom, h: hid, t: C.newHookToken(), d: hookData });
ok(!r.ok && r._status === 403, 'hook.post mit falschem Token → 403');
r = await call('hook.post', { r: roomId, h: hid, t: hookToken, d: hookData });
ok(!r.ok && r._status === 403 && r.error === 'Zugang ungültig oder widerrufen.', 'hook.post in einen anderen Raum → 403 (gleiche Meldung)');
r = await call('hook.post', { r: hookRoom, h: hid, t: hookToken, d: hookData });
ok(r.ok && Object.keys(r).filter(k => k !== '_status').join() === 'ok', 'hook.post: angenommen, Antwort nur „ok“');
r = await call('hook.post', { r: hookRoom, h: hid, t: hookToken, d: 'A'.repeat(22004) });
ok(!r.ok && r._status === 413, 'hook.post: Größenlimit (22 000 Zeichen Base64, 16 KB Klartext) → 413');
let tooLong = false;
try { await C.sealHook({ v: 1, t: 'hook', body: 'x'.repeat(16400) }, parsed.k, hookRoom, hid); } catch (e) { tooLong = true; }
ok(tooLong, 'sealHook: mehr als 16 KB Klartext wird abgelehnt');
r = await call('poll', { i: { s: 0, o: 0, g: 0 }, r: { [hookRoom]: { s: 0, o: 0, g: 0 } } }, acc2Token);
const hookEntry = r.ok && r.r[hookRoom].e.find(e => e.k === 'hook');
ok(hookEntry && hookEntry.h === hid && !('to' in hookEntry) && !hookEntry.d.includes(C.b64(C.te.encode('Server'))) && C.unb64(hookEntry.d)[0] === 1, 'Beitrag liegt als Chiffretext im Verlauf (k „hook“)');
r = await call('rooms', {}, acc2Token);
const memberMeta = await C.openRoom(r.rooms.find(x => x.id === hookRoom).meta, hookRk, hookRoom, [acc.publicKey]);
const hookOpened = await C.openHook(hookEntry.d, await C.importHookKey(memberMeta.obj.hooks[hid].k), hookRoom, hid);
ok(hookOpened.t === 'hook' && hookOpened.body === hookPlain && memberMeta.obj.hooks[hid].ch === 'news', 'Mitglied entschlüsselt den Beitrag mit dem Schlüssel aus den Raumdaten');
let rehung = false;
try { await C.openHook(hookEntry.d, await C.importHookKey(memberMeta.obj.hooks[hid].k), roomId, hid); } catch (e) { rehung = true; }
ok(rehung, 'umgehängt (anderer Raum) lässt sich der Beitrag nicht öffnen');
for (const a of ['rooms', 'poll', 'me', 'vault.get']) {
  r = await call(a, { i: { s: 0, o: 0, g: 0 }, r: { [hookRoom]: { s: 0, o: 0, g: 0 } } }, hookToken);
  ok(!r.ok && r._status === 401, 'Zugang kann nichts lesen: „' + a + '“ mit dem Token → 401');
}
r = await call('hook.list', { id: hookRoom }, accToken);
ok(r.ok && r.list.length === 1 && r.list[0].id === hid && r.list[0].u > 0 && !('h' in r.list[0]), 'hook.list (Besitzer): Kennung, angelegt, zuletzt benutzt – kein Hash');
r = await call('hook.list', { id: hookRoom }, acc2Token);
ok(!r.ok && r._status === 403, 'hook.list: Mitglied → 403');
r = await call('rooms', {}, acc2Token);
ok(r.ok && !JSON.stringify(r).includes('"hk"') && !JSON.stringify(r).includes(await C.hookTokenHash(hookToken)), 'Raumliste der Mitglieder: keine Token-Hashes');
// Zweiter Zugang: widerrufen → keine Beiträge mehr
const hid2 = C.randomId();
const tok2 = C.newHookToken();
r = await call('hook.create', { id: hookRoom, hid: hid2, th: await C.hookTokenHash(tok2) }, accToken);
ok(r.ok, 'zweiter Zugang angelegt');
const data2 = await C.sealHook({ v: 1, t: 'hook', id: C.randomId(), body: 'zwei' }, hk.pub, hookRoom, hid2);
r = await call('hook.post', { r: hookRoom, h: hid2, t: tok2, d: data2 });
ok(r.ok, 'zweiter Zugang postet');
r = await call('hook.del', { id: hookRoom, hid: hid2 }, acc2Token);
ok(!r.ok && r._status === 403, 'hook.del: Mitglied → 403');
r = await call('hook.del', { id: hookRoom, hid: hid2 }, accToken);
ok(r.ok && r.n === 1, 'hook.del: Besitzer widerruft');
r = await call('hook.post', { r: hookRoom, h: hid2, t: tok2, d: data2 });
ok(!r.ok && r._status === 403, 'widerrufener Zugang → 403');
// Höchstens fünf je Raum
for (let i = 0; i < 4; i++) await call('hook.create', { id: hookRoom, hid: C.randomId(), th: await C.hookTokenHash(C.newHookToken()) }, accToken);
r = await call('hook.create', { id: hookRoom, hid: C.randomId(), th: await C.hookTokenHash(C.newHookToken()) }, accToken);
ok(!r.ok && r._status === 409, 'höchstens 5 Zugänge je Raum → 409');
// Ratenbegrenzung je Zugang (20 je Minute)
let limited = 0;
for (let i = 0; i < 22; i++) {
  r = await call('hook.post', { r: hookRoom, h: hid, t: hookToken, d: hookData });
  if (!r.ok && r._status === 429) { limited = i; break; }
}
ok(limited > 0, 'Ratenbegrenzung: nach ' + limited + ' weiteren Beiträgen → 429');
r = await call('room.delete', { id: hookRoom }, accToken);
r = await call('hook.post', { r: hookRoom, h: hid, t: hookToken, d: hookData });
ok(!r.ok && (r._status === 403 || r._status === 429), 'Raum gelöscht → Zugang wirkungslos');

console.log('\n== Server: Aufbewahrung „Permanent“');
r = await call('config');
const PERM = r.permanent;
ok(r.ok && PERM >= 3153600000 && r.permanent_mb > 0, 'config nennt „Permanent“ (' + PERM + ' s) und die Grenze des Verlaufs (' + r.permanent_mb + ' MB)');
const permRoom = C.randomId();
const permKey = await C.importRoomKey(C.newRoomKey());
r = await call('room.create', { id: permRoom, meta: await C.sealRoom({ t: 'meta', name: 'Archiv', ch: [{ id: 'c1', name: 'allgemein' }] }, permKey, 1, permRoom, acc.privateKey) }, accToken);
r = await call('room.invite', { id: permRoom }, accToken);
await call('room.join', { id: permRoom, code: r.code }, acc2Token);
r = await call('room.ttl', { id: permRoom, ttl: 3600 }, accToken);
ok(r.ok && r.room.ttl === 3600, 'Aufbewahrung zuerst 1 Stunde');
r = await call('room.post', { id: permRoom, k: 'msg', d: await C.sealRoom({ t: 'msg', ch: 'c1', body: 'bleibt', from: accId }, permKey, 1, permRoom, acc.privateKey) }, accToken);
ok(r.ok, 'Nachricht im Raum');
r = await call('room.ttl', { id: permRoom, ttl: PERM }, acc2Token);
ok(!r.ok && r._status === 403, '„Permanent“: Mitglied (nicht Besitzer) → 403');
r = await call('room.ttl', { id: roomId, ttl: PERM }, TA.token);
ok(!r.ok && r._status === 403, '„Permanent“: temporäre Sitzung → 403');
const permMeet = C.randomId();
await call('room.create', { id: permMeet, meta: await C.sealRoom({ t: 'meta', name: 'M', ch: [], meet: 1, once: 1 }, onceKey, 1, permMeet, acc.privateKey), once: 1 }, accToken);
r = await call('room.ttl', { id: permMeet, ttl: PERM }, accToken);
ok(!r.ok && r._status === 422, '„Permanent“: Einmal-Meeting → 422');
await call('room.delete', { id: permMeet }, accToken);
const permTmp = C.randomId();
await call('room.create', { id: permTmp, meta: await C.sealRoom({ t: 'meta', name: 'T', ch: [], meet: 1 }, onceKey, 1, permTmp, acc.privateKey), tmp: 1 }, accToken);
r = await call('room.ttl', { id: permTmp, ttl: PERM }, accToken);
ok(!r.ok && r._status === 422, '„Permanent“: verfallender Raum → 422');
await call('room.delete', { id: permTmp }, accToken);
r = await call('room.ttl', { id: permRoom, ttl: PERM }, accToken);
ok(r.ok && r.room.ttl === PERM, 'Besitzer (Konto) stellt „Permanent“ ein – der Raum meldet ttl = ' + PERM);
r = await call('rooms', {}, acc2Token);
ok(r.ok && r.rooms.find(x => x.id === permRoom).ttl === PERM, 'Mitglieder sehen denselben Wert (ältere Apps: begrenzt auf ihre Höchstgrenze)');
r = await call('poll', { i: { s: 0, o: 0, g: 0 }, r: { [permRoom]: { s: 0, o: 0, g: 0 } } }, acc2Token);
ok(r.ok && r.r[permRoom].e.some(e => e.k === 'msg'), 'vorhandene Nachricht bleibt (neue Frist gilt auch für sie)');
r = await call('room.ttl', { id: permRoom, ttl: PERM * 5 }, accToken);
ok(r.ok && r.room.ttl === PERM, 'größere Werte gelten als „Permanent“');
r = await call('room.ttl', { id: permRoom, ttl: 86400 }, accToken);
ok(r.ok && r.room.ttl === 86400, 'zurück auf 24 Stunden');
r = await call('poll', { i: { s: 0, o: 0, g: 0 }, r: { [permRoom]: { s: 0, o: 0, g: 0 } } }, acc2Token);
ok(r.ok && r.r[permRoom].e.some(e => e.k === 'msg'), 'die junge Nachricht bleibt auch bei 24 Stunden');
await call('room.delete', { id: permRoom }, accToken);

console.log('\n== Server: Aufbewahrung je Textkanal');
// Ablaufzeiten (x) liefert der Server nicht aus – mit SECURECOM_STORAGE=<Ablage
// des Testservers> liest der Test sie direkt aus dem Verlauf.
const STORE = process.env.SECURECOM_STORAGE || '';
const fs = STORE ? await import('node:fs') : null;
const feedOf = (id) => {
  const out = new Map();
  for (const line of fs.readFileSync(STORE + '/securecom/feeds/' + id + '.jsonl', 'utf8').split('\n')) {
    if (line) { const e = JSON.parse(line); out.set(e.s, e); }
  }
  return out;
};
const roomJson = (id) => JSON.parse(fs.readFileSync(STORE + '/securecom/rooms/' + id + '.json', 'utf8'));
if (!STORE) console.log('  (ohne SECURECOM_STORAGE: Ablaufzeiten im Verlauf werden nicht geprüft)');
r = await call('config');
ok(r.ok && r.cttl === 30, 'config nennt die Aufbewahrung je Kanal (höchstens ' + r.cttl + ' Kanäle)');
const ctRoom = C.randomId();
const ctKey = await C.importRoomKey(C.newRoomKey());
const ctMsg = async (ch, body) => C.sealRoom({ t: 'msg', ch, body, from: accId }, ctKey, 1, ctRoom, acc.privateKey);
r = await call('room.create', { id: ctRoom, meta: await C.sealRoom({ t: 'meta', name: 'Kanäle', ch: [{ id: 'c1', name: 'allgemein' }, { id: 'arch', name: 'archiv' }, { id: 'c3', name: 'kurz' }] }, ctKey, 1, ctRoom, acc.privateKey) }, accToken);
ok(r.ok && r.room.ct && Object.keys(r.room.ct).length === 0, 'neuer Raum: keine Kanäle mit eigener Aufbewahrung (ct leer)');
r = await call('room.invite', { id: ctRoom }, accToken);
await call('room.join', { id: ctRoom, code: r.code }, acc2Token);
r = await call('room.ttl', { id: ctRoom, ttl: 604800 }, accToken);
ok(r.ok && r.room.ttl === 604800, 'Raum: 7 Tage');
// Ein API-Zugang, der in #archiv postet – angelegt, bevor der Kanal eine eigene Aufbewahrung hat
const ctHid = C.randomId();
const ctTok = C.newHookToken();
const ctHk = await C.newHookKeys();
r = await call('hook.create', { id: ctRoom, hid: ctHid, th: await C.hookTokenHash(ctTok), c: 'arch' }, accToken);
ok(r.ok, 'API-Zugang für #archiv angelegt (Kanal ohne eigene Aufbewahrung: Server merkt ihn sich nicht)');
if (STORE) ok(!('ch' in roomJson(ctRoom).hk[ctHid]), 'Zugang ohne Kanal-Zuordnung beim Server');
r = await call('room.post', { id: ctRoom, k: 'msg', d: await ctMsg('arch', 'alt im Archiv'), c: 'arch' }, accToken);
const sOld = r.s;
ok(r.ok, 'ältere Nachricht in #archiv (c ohne eigene Aufbewahrung wird ignoriert)');
if (STORE) ok(!('c' in feedOf(ctRoom).get(sOld)), 'Eintrag ohne Kanal-Kennung');
r = await call('room.post', { id: ctRoom, k: 'msg', d: await ctMsg('c1', 'alt allgemein') }, accToken);
const sOther = r.s;
r = await call('hook.post', { r: ctRoom, h: ctHid, t: ctTok, d: await C.sealHook({ v: 1, t: 'hook', id: C.randomId(), body: 'vorher' }, ctHk.pub, ctRoom, ctHid) });
ok(r.ok, 'API-Beitrag vor der Kanal-Aufbewahrung');
// Rechte und Werte
r = await call('room.cttl', { id: ctRoom, c: 'arch', ttl: 86400 }, acc2Token);
ok(!r.ok && r._status === 403, 'room.cttl: Mitglied (nicht Besitzer) → 403');
r = await call('room.cttl', { id: ctRoom, c: 'arch', ttl: 60 }, accToken);
ok(!r.ok && r._status === 422, 'room.cttl: weniger als 1 Stunde → 422');
r = await call('room.cttl', { id: ctRoom, c: 'arch', ttl: 'bald' }, accToken);
ok(!r.ok && r._status === 422, 'room.cttl: kein Zahlenwert → 422');
r = await call('room.cttl', { id: ctRoom, c: 'kein kanal!', ttl: 86400 }, accToken);
ok(!r.ok && r._status === 422, 'room.cttl: ungültige Kanal-Kennung → 422');
r = await call('room.cttl', { id: roomId, c: 'c1', ttl: PERM }, TA.token);
ok(!r.ok && r._status === 403, 'room.cttl „Permanent“: temporäre Sitzung → 403');
const ctTmp = C.randomId();
await call('room.create', { id: ctTmp, meta: await C.sealRoom({ t: 'meta', name: 'T', ch: [{ id: 'c1', name: 'chat' }], meet: 1 }, onceKey, 1, ctTmp, acc.privateKey), tmp: 1 }, accToken);
r = await call('room.cttl', { id: ctTmp, c: 'c1', ttl: PERM }, accToken);
ok(!r.ok && r._status === 422, 'room.cttl „Permanent“: verfallender Raum → 422');
r = await call('room.cttl', { id: ctTmp, c: 'c1', ttl: 3600 }, accToken);
ok(r.ok && r.room.ct.c1 === 3600 && r.room.tmp, 'verfallender Raum: eigene Aufbewahrung (1 Stunde) geht');
await call('room.delete', { id: ctTmp }, accToken);
r = await call('room.cttl', { id: roomId, c: 'c1', ttl: 7200 }, TA.token);
ok(r.ok && r.room.ct.c1 === 7200, 'temporäre Sitzung als Besitzer: Kanal 2 Stunden');
await call('room.cttl', { id: roomId, c: 'c1', ttl: 0 }, TA.token);
// #archiv „Permanent“ in einem 7-Tage-Raum; ältere Einträge per Nummer, der Zugang per Kennung
r = await call('room.cttl', { id: ctRoom, c: 'arch', ttl: PERM, s: [sOld], h: [ctHid] }, accToken);
ok(r.ok && r.room.ct.arch === PERM && r.room.ttl === 604800, 'Besitzer: #archiv „Permanent“, Raum bleibt bei 7 Tagen');
r = await call('rooms', {}, acc2Token);
ok(r.ok && r.rooms.find(x => x.id === ctRoom).ct.arch === PERM, 'Mitglieder sehen ct = { arch: Permanent }');
let f;
if (STORE) {
  f = feedOf(ctRoom);
  const e = f.get(sOld);
  ok(e.c === 'arch' && e.x === e.t + PERM, 'ältere Nachricht nachträglich #archiv zugeordnet, Ablauf = Zeitpunkt + Permanent');
  ok(!('c' in f.get(sOther)) && f.get(sOther).x === f.get(sOther).t + 604800, 'Nachricht in #allgemein: weiter 7 Tage, ohne Kanal');
  const he = [...f.values()].find(x => x.k === 'hook');
  ok(he.c === 'arch' && he.x === he.t + PERM, 'älterer API-Beitrag des Zugangs ebenfalls zugeordnet');
  ok(roomJson(ctRoom).hk[ctHid].ch === 'arch', 'Zugang beim Server jetzt mit Ziel-Kanal');
}
r = await call('room.post', { id: ctRoom, k: 'msg', d: await ctMsg('arch', 'neu im Archiv'), c: 'arch' }, acc2Token);
const sNew = r.s;
r = await call('room.post', { id: ctRoom, k: 'msg', d: await ctMsg('c1', 'neu allgemein') }, acc2Token);
const sPlain = r.s;
r = await call('room.post', { id: ctRoom, k: 'msg', d: await ctMsg('c3', 'kurz'), c: 'c3' }, acc2Token);
const sC3 = r.s;
r = await call('hook.post', { r: ctRoom, h: ctHid, t: ctTok, d: await C.sealHook({ v: 1, t: 'hook', id: C.randomId(), body: 'nachher' }, ctHk.pub, ctRoom, ctHid) });
ok(r.ok, 'neue Nachrichten (mit und ohne c) und ein API-Beitrag');
if (STORE) {
  f = feedOf(ctRoom);
  ok(f.get(sNew).c === 'arch' && f.get(sNew).x === f.get(sNew).t + PERM, 'Nachricht mit c = arch: Ablauf nach Kanal (Permanent)');
  ok(!('c' in f.get(sPlain)) && f.get(sPlain).x === f.get(sPlain).t + 604800, 'Nachricht ohne c: Ablauf nach Raum (7 Tage)');
  ok(!('c' in f.get(sC3)) && f.get(sC3).x === f.get(sC3).t + 604800, 'c für einen Kanal ohne eigene Aufbewahrung: nicht gespeichert, Raum-Frist');
  const hs = [...f.values()].filter(x => x.k === 'hook');
  ok(hs.length === 2 && hs.every(x => x.c === 'arch' && x.x === x.t + PERM), 'API-Beitrag: Kanal-Frist über die Zuordnung des Zugangs');
}
r = await call('poll', { i: { s: 0, o: 0, g: 0 }, r: { [ctRoom]: { s: 0, o: 0, g: 0 } } }, acc2Token);
ok(r.ok && r.r[ctRoom].e.filter(e => e.k === 'msg').length === 5 && !r.r[ctRoom].e.some(e => 'x' in e), 'Mitglied liest alle Einträge (ohne Ablaufzeit)');
// Raum-Aufbewahrung ändern: Kanäle mit eigener behalten ihre
r = await call('room.ttl', { id: ctRoom, ttl: 3600 }, accToken);
ok(r.ok && r.room.ttl === 3600 && r.room.ct.arch === PERM, 'Raum auf 1 Stunde, #archiv bleibt „Permanent“');
if (STORE) {
  f = feedOf(ctRoom);
  ok(f.get(sPlain).x === f.get(sPlain).t + 3600 && f.get(sOther).x === f.get(sOther).t + 3600, 'Raum-Einträge: neue Frist (1 Stunde)');
  ok(f.get(sNew).x === f.get(sNew).t + PERM && f.get(sOld).x === f.get(sOld).t + PERM, '#archiv-Einträge: unverändert');
}
// Kanal-Aufbewahrung ändern: nur seine Einträge
r = await call('room.cttl', { id: ctRoom, c: 'arch', ttl: 86400, h: [ctHid] }, accToken);
ok(r.ok && r.room.ct.arch === 86400, '#archiv auf 24 Stunden');
if (STORE) {
  f = feedOf(ctRoom);
  ok(f.get(sNew).x === f.get(sNew).t + 86400 && f.get(sOld).x === f.get(sOld).t + 86400, '#archiv-Einträge: neue Frist (24 Stunden)');
  ok(f.get(sPlain).x === f.get(sPlain).t + 3600, 'Raum-Einträge: unverändert');
}
r = await call('room.cttl', { id: ctRoom, c: 'arch', ttl: PERM * 3 }, accToken);
ok(r.ok && r.room.ct.arch === PERM, 'größere Werte gelten als „Permanent“');
// Zurücksetzen: Zuordnung beim Server wieder weg
r = await call('room.cttl', { id: ctRoom, c: 'arch', ttl: 0 }, accToken);
ok(r.ok && Object.keys(r.room.ct).length === 0, 'zurück auf „wie der Raum“ (ct leer)');
if (STORE) {
  f = feedOf(ctRoom);
  ok([...f.values()].every(x => !('c' in x)), 'Verlauf ohne Kanal-Kennungen');
  ok(f.get(sNew).x === f.get(sNew).t + 3600, '#archiv-Einträge: wieder Raum-Frist');
  ok(!('ch' in roomJson(ctRoom).hk[ctHid]) && !('ct' in roomJson(ctRoom)), 'Zugang und Raum ohne Kanal-Zuordnung');
}
r = await call('room.post', { id: ctRoom, k: 'msg', d: await ctMsg('arch', 'danach'), c: 'arch' }, acc2Token);
if (STORE) ok(!('c' in feedOf(ctRoom).get(r.s)), 'nach dem Zurücksetzen: c wird nicht mehr gespeichert');
// Höchstens 30 Kanäle mit eigener Aufbewahrung
let ctLimit = 0;
for (let i = 0; i < 31; i++) {
  r = await call('room.cttl', { id: ctRoom, c: 'k' + i, ttl: 7200 }, accToken);
  if (!r.ok) { ctLimit = i; break; }
}
ok(ctLimit === 30 && r._status === 409, 'höchstens 30 Kanäle mit eigener Aufbewahrung → 409');
r = await call('room.cttl', { id: ctRoom, c: 'k0', ttl: 3600 }, accToken);
ok(r.ok && r.room.ct.k0 === 3600, 'vorhandenen Eintrag ändern geht auch an der Grenze');

console.log('\n== Server: Besitzer entfernt Nachrichten (room.del)');
r = await call('config');
ok(r.ok && r.rdel > 0, 'config nennt room.del (höchstens ' + r.rdel + ' Einträge je Aufruf)');
const pollCt = async (token) => (await call('poll', { i: { s: 0, o: 0, g: 0 }, r: { [ctRoom]: { s: 0, o: 0, g: 0 } } }, token)).r[ctRoom].e;
// Datei des Mitglieds, die an der Nachricht hängt
const delFile = C.randomId();
const delFileKey = await C.importFileKey(C.newFileKey());
const delBytes = new Uint8Array(1000).fill(3);
r = await call('file.put', { id: delFile, n: 0, of: 1, size: delBytes.length, d: C.b64(await C.sealChunk(delFileKey, delFile, 0, 1, delBytes)), ttl: 3600 }, acc2Token);
ok(r.ok, 'Mitglied lädt eine Datei hoch');
r = await call('room.post', { id: ctRoom, k: 'msg', d: await C.sealRoom({ t: 'msg', ch: 'c1', body: '📎 datei', file: { id: delFile }, from: acc2Id }, ctKey, 1, ctRoom, acc2.privateKey) }, acc2Token);
const sMemberMsg = r.s;
r = await call('room.post', { id: ctRoom, k: 'msg', d: await C.sealRoom({ t: 'edit', ref: 'x', ch: 'c1', body: 'geändert', from: acc2Id }, ctKey, 1, ctRoom, acc2.privateKey) }, acc2Token);
const sMemberEdit = r.s;
r = await call('room.post', { id: ctRoom, k: 'msg', d: await ctMsg('c1', 'vom Besitzer') }, accToken);
const sOwnerMsg = r.s;
r = await call('hook.post', { r: ctRoom, h: ctHid, t: ctTok, d: await C.sealHook({ v: 1, t: 'hook', id: C.randomId(), body: 'weg damit' }, ctHk.pub, ctRoom, ctHid) });
let entries = await pollCt(acc2Token);
const sHookPost = entries.filter(e => e.k === 'hook').map(e => e.s).pop();
ok(sMemberMsg && sMemberEdit && sOwnerMsg && sHookPost, 'Nachricht des Mitglieds (mit Datei und Änderung), des Besitzers und ein API-Beitrag liegen im Verlauf');
r = await call('room.del', { id: ctRoom, s: [sOwnerMsg] }, acc2Token);
ok(!r.ok && r._status === 403, 'room.del: Mitglied (nicht Besitzer) → 403, auch für fremde Nachrichten');
r = await call('room.del', { id: ctRoom, s: [sMemberMsg] }, acc2Token);
ok(!r.ok && r._status === 403, 'room.del: Mitglied, eigene Nachricht → 403 (der Server kennt den Absender nicht; eigene löscht man verschlüsselt mit t „del“)');
r = await call('room.del', { id: ctRoom, s: [] }, accToken);
ok(!r.ok && r._status === 422, 'room.del ohne Nummer → 422');
r = await call('room.del', { id: ctRoom, s: [sMemberMsg, sMemberEdit], f: [delFile] }, accToken);
ok(r.ok && r.n === 2 && r.files === 1, 'Besitzer löscht fremde Nachricht samt Änderung und Datei');
r = await call('file.get', { id: delFile, n: 0 }, acc2Token);
ok(!r.ok && r._status === 404, 'Datei ist beim Server weg');
r = await call('room.del', { id: ctRoom, s: sHookPost }, accToken);
ok(r.ok && r.n === 1, 'Besitzer löscht einen API-Beitrag (einzelne Nummer)');
entries = await pollCt(acc2Token);
ok(![sMemberMsg, sMemberEdit, sHookPost].some(s => entries.some(e => e.s === s)) && entries.some(e => e.s === sOwnerMsg), 'gelöschte Einträge werden nicht mehr ausgeliefert, andere schon');
const notes = entries.filter(e => e.k === 'del');
ok(notes.length === 2 && notes[0].n.join() === [sMemberMsg, sMemberEdit].join() && notes[1].n.join() === String(sHookPost) && !('d' in notes[0]), 'Hinweis-Einträge k „del“ nennen nur die Nummern');
r = await call('room.del', { id: ctRoom, s: [sMemberMsg] }, accToken);
ok(r.ok && r.n === 0 && (await pollCt(acc2Token)).filter(e => e.k === 'del').length === 2, 'schon gelöscht: n = 0, kein weiterer Hinweis');
const sysSeq = entries.find(e => e.k === 'sys');
if (sysSeq) {
  r = await call('room.del', { id: ctRoom, s: [sysSeq.s] }, accToken);
  ok(r.ok && r.n === 0, 'Hinweise (Beitritt) und Schlüssel lassen sich so nicht löschen');
}
r = await call('room.del', { id: ctRoom, s: [sOwnerMsg], f: [bobFile] }, accToken);
ok(r.ok && r.n === 1 && r.files === 0, 'fremde Datei (Hochlader nicht im Raum) bleibt');
await call('room.delete', { id: ctRoom }, accToken);

console.log('\n== Reaktionen (verschlüsselte Einträge t „react“)');
const rxRoom = C.randomId();
const rxKey = await C.importRoomKey(C.newRoomKey());
r = await call('room.create', { id: rxRoom, meta: await C.sealRoom({ t: 'meta', name: 'Reaktionen', ch: [{ id: 'c1', name: 'allgemein' }] }, rxKey, 1, rxRoom, acc.privateKey) }, accToken);
r = await call('room.invite', { id: rxRoom }, accToken);
r = await call('room.join', { id: rxRoom, code: r.code }, acc2Token);
ok(r.ok, 'Raum für Reaktionen, zweites Konto ist Mitglied');
const rxMsgId = C.randomId();
r = await call('room.post', { id: rxRoom, k: 'msg', d: await C.sealRoom({ v: 1, t: 'msg', id: rxMsgId, from: acc2Id, room: rxRoom, ch: 'c1', ts: Date.now(), body: 'Wer kommt mit?' }, rxKey, 1, rxRoom, acc2.privateKey) }, acc2Token);
const rxTarget = r.s;
r = await call('room.post', { id: rxRoom, k: 'msg', d: await C.sealRoom({ v: 1, t: 'react', id: C.randomId(), from: accId, room: rxRoom, ch: 'c1', ts: Date.now(), ref: rxMsgId, r: 'rocket', on: true }, rxKey, 1, rxRoom, acc.privateKey) }, accToken);
ok(r.ok && r.s > rxTarget, 'Besitzer reagiert (Rakete) – ein gewöhnlicher Raum-Eintrag');
const rxSeq = r.s;
let rxFeed = (await call('poll', { r: { [rxRoom]: { s: 0, o: 0, g: 0 } } }, acc2Token)).r[rxRoom].e;
const rxEntry = rxFeed.find((e) => e.s === rxSeq);
ok(rxEntry && rxEntry.k === 'msg' && Object.keys(rxEntry).sort().join() === 'd,k,s,t' && !/react|rocket/.test(JSON.stringify(rxEntry)),
  'beim Server nur Chiffretext: k „msg“, keine Art, kein Symbol, kein Ziel');
const rxOpen = await C.openRoom(rxEntry.d, rxKey, rxRoom, [acc.publicKey, acc2.publicKey]);
ok(rxOpen.signer === acc.fingerprint && rxOpen.obj.t === 'react' && rxOpen.obj.ref === rxMsgId && rxOpen.obj.r === 'rocket' && rxOpen.obj.on === true,
  'Mitglied entschlüsselt die Reaktion, Besitzer als Absender bestätigt');
r = await call('room.post', { id: rxRoom, k: 'msg', d: await C.sealRoom({ v: 1, t: 'react', id: C.randomId(), from: accId, room: rxRoom, ch: 'c1', ts: Date.now(), ref: rxMsgId, r: 'rocket', on: false }, rxKey, 1, rxRoom, acc.privateKey) }, accToken);
const rxOff = r.s;
rxFeed = (await call('poll', { r: { [rxRoom]: { s: rxSeq, o: 0, g: 0 } } }, acc2Token)).r[rxRoom].e;
ok((await C.openRoom(rxFeed.find((e) => e.s === rxOff).d, rxKey, rxRoom, [acc.publicKey])).obj.on === false, 'Zurücknehmen: on false');
r = await call('room.del', { id: rxRoom, s: [rxTarget, rxSeq, rxOff] }, accToken);
ok(r.ok && r.n === 3, 'Besitzer löscht die Nachricht samt ihren Reaktionen');
await call('room.delete', { id: rxRoom }, accToken);
// Direktnachricht: dasselbe Muster, PGP an beide
const dmRx = await C.sealFor({ v: 1, t: 'react', id: C.randomId(), from: accId, to: acc2Id, ts: Date.now(), ref: 'x'.repeat(22), r: 'heart', on: true }, [acc2.publicKey, acc.publicKey], acc.privateKey);
r = await call('send', { to: acc2Id, k: 'dm', d: dmRx, self: true }, accToken);
ok(r.ok, 'Reaktion als Direktnachricht verschickt');
r = await call('poll', { i: { s: 0, o: 0, g: 0 }, tail: 300 }, acc2Token);
const dmRxEntry = r.i.e.filter((e) => e.k === 'dm').pop();
const dmRxOpen = await C.openSealed(dmRxEntry.d, acc2.privateKey, [acc.publicKey]);
ok(dmRxOpen.obj.t === 'react' && dmRxOpen.obj.r === 'heart' && dmRxOpen.signer === acc.fingerprint && !/heart/.test(JSON.stringify(dmRxEntry)), 'Empfänger entschlüsselt die Reaktion (Server sieht nur Chiffretext)');

console.log('\n== Ränge und Rechte');
r = await call('config');
ok(r.ok && r.roles > 0, 'config nennt Ränge (höchstens ' + r.roles + ' je Raum)');
const P = { SEND: 1, REACT: 2, VOICE: 4, INVITE: 8, CHANNELS: 16, ROOM: 32, MESSAGES: 64, KICK: 128, HOOKS: 256, ROLES: 512, ADMIN: 1024 };
const rlRoom = C.randomId();
const rlKey = await C.importRoomKey(C.newRoomKey());
const rlMeta = (who, name) => C.sealRoom({ t: 'meta', name, ch: [{ id: 'c1', name: 'allgemein' }, { id: 'news', name: 'ankuendigungen' }] }, rlKey, 1, rlRoom, who.privateKey);
const rlMsg = async (who, whoId, ch, body, t = 'msg') => C.sealRoom({ v: 1, t, id: C.randomId(), from: whoId, room: rlRoom, ch, ts: Date.now(), body }, rlKey, 1, rlRoom, who.privateKey);
r = await call('room.create', { id: rlRoom, meta: await rlMeta(acc, 'Verein') }, accToken);
ok(r.ok && r.room.perm === 2047 && r.room.dp === 15 && Object.keys(r.room.rl).length === 0, 'Besitzer hat alle Rechte, „@alle“ ohne Einstellung: schreiben, reagieren, Sprache, einladen (15)');
const rlInv = (await call('room.invite', { id: rlRoom, max: 10 }, accToken)).code;
r = await call('room.join', { id: rlRoom, code: rlInv }, acc2Token);
ok(r.ok && r.room.perm === 15, 'Mitglied (Konto 2) tritt bei, Rechte 15');
const TR = await makeTemp('Rita');
r = await call('room.join', { id: rlRoom, code: rlInv }, TR.token);
ok(r.ok, 'Rita (temporär) tritt bei');
// Ohne Rang: nichts verwalten
r = await call('role.set', { id: rlRoom, r: 'modRang01', p: P.SEND }, acc2Token);
ok(!r.ok && r._status === 403, 'Mitglied ohne Recht legt keinen Rang an → 403');
r = await call('room.meta', { id: rlRoom, meta: await rlMeta(acc2, 'Gekapert'), e: 1 }, acc2Token);
ok(!r.ok && r._status === 403, 'Mitglied ohne Recht ändert keine Raumdaten → 403');
r = await call('role.set', { id: rlRoom, r: 'x', p: 1 }, accToken);
ok(!r.ok && r._status === 422, 'ungültige Rang-Kennung → 422');
// Besitzer: Moderator und Helfer
const MOD = 'modRang01', HELP = 'helfer0001', LOW = 'gastRang01', VIP = 'vipRang001';
const modPerms = P.SEND | P.REACT | P.VOICE | P.INVITE | P.CHANNELS | P.ROOM | P.MESSAGES | P.KICK | P.ROLES;
r = await call('role.set', { id: rlRoom, r: MOD, p: modPerms }, accToken);
ok(r.ok && r.room.rl[MOD].p === modPerms && r.room.rl[MOD].o === 1, 'Besitzer legt „Moderator“ an (unten, Reihenfolge 1)');
r = await call('role.set', { id: rlRoom, r: HELP, p: P.MESSAGES }, accToken);
ok(r.ok && r.room.rl[HELP].o === 1 && r.room.rl[MOD].o === 2, 'neuer Rang „Helfer“ kommt nach unten, Moderator rückt auf');
r = await call('role.assign', { id: rlRoom, r: MOD, member: acc2Id, on: 1 }, accToken);
ok(r.ok && r.room.mr[acc2Id].join() === MOD, 'Besitzer vergibt „Moderator“ an Konto 2');
r = await call('rooms', {}, acc2Token);
const rl2 = r.rooms.find((x) => x.id === rlRoom);
ok(rl2.perm === (modPerms | 15) && rl2.mr[acc2Id][0] === MOD && !('n' in rl2.rl[MOD]), 'Moderator sieht seine Rechte; der Server kennt keine Rang-Namen');
// Rechte wirken
r = await call('room.meta', { id: rlRoom, meta: await rlMeta(acc2, 'Verein (neu)'), e: 1 }, acc2Token);
ok(r.ok, 'Moderator ändert die Raumdaten (Kanäle/Raum verwalten)');
r = await call('room.ttl', { id: rlRoom, ttl: 86400 }, acc2Token);
ok(r.ok && r.room.ttl === 86400, 'Moderator ändert die Aufbewahrung (Raum verwalten)');
r = await call('room.ttl', { id: rlRoom, ttl: 86400 }, TR.token);
ok(!r.ok && r._status === 403, 'Rita (ohne Rang) nicht → 403');
r = await call('room.post', { id: rlRoom, k: 'msg', d: await rlMsg(TR, TR.id, 'c1', 'Spam!') }, TR.token);
const spamSeq = r.s;
r = await call('room.del', { id: rlRoom, s: [spamSeq] }, TR.token);
ok(!r.ok && r._status === 403, 'room.del ohne Recht → 403');
r = await call('room.del', { id: rlRoom, s: [spamSeq] }, acc2Token);
ok(r.ok && r.n === 1, 'Moderator löscht fremde Nachricht (Nachrichten verwalten)');
r = await call('hook.list', { id: rlRoom }, acc2Token);
ok(!r.ok && r._status === 403, 'API-Zugänge ohne Recht → 403');
r = await call('room.ao', { id: rlRoom, on: 1 }, acc2Token);
ok(!r.ok && r._status === 403, '„Nur Konten“ bleibt beim Besitzer → 403');
r = await call('room.rotate', { id: rlRoom, e: 2, env: 'eA', meta: 'eA' }, acc2Token);
ok(!r.ok && r._status === 403, 'Raumschlüssel erneuern bleibt beim Besitzer → 403');
r = await call('room.delete', { id: rlRoom }, acc2Token);
ok(!r.ok && r._status === 403, 'Raum löschen bleibt beim Besitzer → 403');
// Hierarchie
r = await call('room.kick', { id: rlRoom, member: accId }, acc2Token);
ok(!r.ok && r._status === 403, 'Moderator entfernt den Besitzer nicht → 403');
r = await call('role.set', { id: rlRoom, r: LOW, p: P.SEND | P.REACT }, acc2Token);
ok(r.ok && r.room.rl[LOW].o === 1 && r.room.rl[MOD].o === 3, 'Moderator legt einen Rang unter sich an');
r = await call('role.set', { id: rlRoom, r: 'adminVersuch', p: P.ADMIN }, acc2Token);
ok(!r.ok && r._status === 403, 'Rechte, die man nicht hat (Administrator), lassen sich nicht vergeben → 403');
r = await call('role.set', { id: rlRoom, r: LOW, p: P.SEND | P.HOOKS }, acc2Token);
ok(!r.ok && r._status === 403, 'auch nicht beim Ändern (API-Zugänge) → 403');
r = await call('role.set', { id: rlRoom, r: MOD, p: modPerms | P.HOOKS }, acc2Token);
ok(!r.ok && r._status === 403, 'eigenen Rang ändern → 403');
r = await call('role.del', { id: rlRoom, r: MOD }, acc2Token);
ok(!r.ok && r._status === 403, 'eigenen Rang löschen → 403');
r = await call('role.assign', { id: rlRoom, r: MOD, member: TR.id, on: 1 }, acc2Token);
ok(!r.ok && r._status === 403, 'eigenen (gleich hohen) Rang vergeben → 403');
r = await call('role.assign', { id: rlRoom, r: HELP, member: TR.id, on: 1 }, acc2Token);
ok(r.ok && r.room.mr[TR.id].join() === HELP, 'Moderator gibt Rita „Helfer“ (darunter)');
r = await call('role.assign', { id: rlRoom, r: HELP, member: accId, on: 1 }, acc2Token);
ok(!r.ok && r._status === 403, 'dem Besitzer nichts vergeben → 403');
r = await call('role.set', { id: rlRoom, r: VIP, p: P.SEND }, accToken);
r = await call('role.order', { id: rlRoom, ids: [LOW, HELP, MOD, VIP] }, accToken);
ok(r.ok && r.room.rl[VIP].o === 4 && r.room.rl[MOD].o === 3, 'Besitzer schiebt „VIP“ über den Moderator');
r = await call('role.order', { id: rlRoom, ids: [LOW, HELP, VIP, MOD] }, acc2Token);
ok(!r.ok && r._status === 403, 'Moderator schiebt sich nicht über „VIP“ → 403');
r = await call('role.order', { id: rlRoom, ids: [HELP, LOW, MOD, VIP] }, acc2Token);
ok(r.ok && r.room.rl[HELP].o === 1 && r.room.rl[LOW].o === 2, 'Moderator ordnet Ränge unter sich um');
r = await call('role.order', { id: rlRoom, ids: [HELP, LOW, MOD] }, accToken);
ok(!r.ok && r._status === 409, 'unvollständige Reihenfolge → 409');
r = await call('role.assign', { id: rlRoom, r: VIP, member: TR.id, on: 1 }, accToken);
r = await call('room.kick', { id: rlRoom, member: TR.id }, acc2Token);
ok(!r.ok && r._status === 403, 'Rita hat jetzt „VIP“ (über dem Moderator) – entfernen → 403');
r = await call('role.assign', { id: rlRoom, r: VIP, member: TR.id, on: 0 }, accToken);
ok(r.ok && r.room.mr[TR.id].join() === HELP, 'Besitzer nimmt „VIP“ wieder weg');
// Einladen über „@alle“
r = await call('role.set', { id: rlRoom, r: '', p: P.SEND | P.REACT | P.VOICE }, acc2Token);
ok(r.ok && r.room.dp === 7, 'Moderator nimmt „@alle“ das Einladen');
r = await call('room.invite', { id: rlRoom }, TR.token);
ok(!r.ok && r._status === 403, 'Rita lädt nicht mehr ein → 403');
r = await call('room.invite', { id: rlRoom }, acc2Token);
ok(r.ok && r.code, 'Moderator schon (eigenes Recht)');
// Kanal-Schreibrechte
r = await call('room.cperm', { id: rlRoom, c: 'news', w: [MOD] }, TR.token);
ok(!r.ok && r._status === 403, 'Kanal-Rechte ohne „Kanäle verwalten“ → 403');
r = await call('room.cperm', { id: rlRoom, c: 'news', w: [MOD, 'gibtsNicht1'] }, acc2Token);
ok(r.ok && r.room.cw.news.r.join() === MOD && r.room.cw.news.t > 0, '#ankuendigungen: nur Moderatoren schreiben (Unbekanntes fällt weg)');
r = await call('room.post', { id: rlRoom, k: 'msg', c: 'news', d: await rlMsg(TR, TR.id, 'news', 'Darf ich?') }, TR.token);
ok(!r.ok && r._status === 403, 'Rita postet mit Kanal c in #ankuendigungen → 403');
r = await call('room.post', { id: rlRoom, k: 'msg', c: 'news', d: await rlMsg(acc2, acc2Id, 'news', 'Treffen am Freitag') }, acc2Token);
const newsSeq = r.s;
ok(r.ok, 'Moderator postet dort');
r = await call('room.post', { id: rlRoom, k: 'msg', c: 'news', d: await rlMsg(acc, accId, 'news', 'Danke!') }, accToken);
ok(r.ok, 'Besitzer auch (immer)');
r = await call('room.post', { id: rlRoom, k: 'msg', d: await rlMsg(TR, TR.id, 'news', 'ohne c') }, TR.token);
const sneakSeq = r.s;
ok(r.ok, 'ohne c weiß der Server den Kanal nicht – nimmt an (die Apps blenden es aus)');
r = await call('room.post', { id: rlRoom, k: 'msg', c: 'news', rx: 1, d: await rlMsg(TR, TR.id, 'news', '', 'react') }, TR.token);
const rxNewsSeq = r.s;
ok(r.ok, 'Reaktion (rx) in #ankuendigungen geht mit „reagieren“');
r = await call('poll', { r: { [rlRoom]: { s: 0, o: 0, g: 0 } } }, acc2Token);
let rlFeed = r.r[rlRoom].e;
ok(rlFeed.find((e) => e.s === newsSeq).c === 'news' && !('c' in rlFeed.find((e) => e.s === sneakSeq)) && rlFeed.find((e) => e.s === rxNewsSeq).r === 1 && !('r' in rlFeed.find((e) => e.s === newsSeq)),
  'Verlauf: geprüfte Beiträge tragen c, Reaktionen r – woran die Apps erkennen, was der Server geprüft hat');
r = await call('role.set', { id: rlRoom, r: '', p: P.VOICE }, accToken);
ok(r.ok && r.room.dp === 4, '„@alle“: nur noch Sprache');
r = await call('room.post', { id: rlRoom, k: 'msg', c: 'news', rx: 1, d: await rlMsg(TR, TR.id, 'news', '', 'react') }, TR.token);
ok(!r.ok && r._status === 403, 'ohne „reagieren“ (weder „@alle“ noch Rang) → Reaktion (rx) 403');
r = await call('room.post', { id: rlRoom, k: 'msg', d: await rlMsg(TR, TR.id, 'c1', 'Hallo?') }, TR.token);
ok(!r.ok && r._status === 403, 'ohne „schreiben“ (weder „@alle“ noch Rang) → 403, auch ohne c');
r = await call('room.voice', { id: rlRoom, on: true }, TR.token);
ok(r.ok, 'Sprache geht weiter');
await call('room.voice', { id: rlRoom, on: false }, TR.token);
r = await call('room.cperm', { id: rlRoom, c: '', v: 1, w: [MOD] }, acc2Token);
ok(r.ok && r.room.vw[''].join() === MOD, 'erster Sprachkanal: nur Moderatoren');
r = await call('room.voice', { id: rlRoom, on: true }, TR.token);
ok(!r.ok && r._status === 403, 'Rita betritt ihn nicht → 403');
r = await call('room.voice', { id: rlRoom, on: true, ch: 'zwei' }, TR.token);
ok(r.ok, 'einen anderen Sprachkanal schon');
await call('room.voice', { id: rlRoom, on: false }, TR.token);
r = await call('room.voice', { id: rlRoom, on: true }, acc2Token);
ok(r.ok, 'Moderator betritt den beschränkten Sprachkanal');
await call('room.voice', { id: rlRoom, on: false }, acc2Token);
r = await call('role.set', { id: rlRoom, r: '', p: P.SEND | P.VOICE }, accToken);
r = await call('room.post', { id: rlRoom, k: 'msg', c: 'news', rx: 1, d: await rlMsg(TR, TR.id, 'news', '', 'react') }, TR.token);
ok(!r.ok && r._status === 403, 'ohne „reagieren“ → Reaktion (rx) 403');
r = await call('room.cperm', { id: rlRoom, c: 'news', w: [] }, accToken);
ok(r.ok && r.room.cw.news.r.length === 0, '#ankuendigungen: nur Besitzer (leere Liste)');
r = await call('room.post', { id: rlRoom, k: 'msg', c: 'news', d: await rlMsg(acc2, acc2Id, 'news', 'noch da?') }, acc2Token);
ok(!r.ok && r._status === 403, 'jetzt auch der Moderator nicht → 403');
r = await call('role.set', { id: rlRoom, r: MOD, p: modPerms | P.ADMIN }, accToken);
r = await call('room.post', { id: rlRoom, k: 'msg', c: 'news', d: await rlMsg(acc2, acc2Id, 'news', 'als Admin') }, acc2Token);
ok(r.ok, 'Administrator: Kanal-Beschränkungen gelten nicht');
r = await call('hook.list', { id: rlRoom }, acc2Token);
ok(r.ok, 'Administrator: API-Zugänge (alle Rechte)');
r = await call('room.rotate', { id: rlRoom, e: 2, env: 'eA', meta: 'eA' }, acc2Token);
ok(!r.ok && r._status === 403, 'Administrator: Raumschlüssel bleibt trotzdem beim Besitzer → 403');
r = await call('room.cperm', { id: rlRoom, c: 'news', w: null }, accToken);
ok(r.ok && !r.room.cw.news, 'Kanal-Rechte zurücksetzen: wieder alle');
// Nicht-Mitglieder, Gäste
r = await call('role.set', { id: rlRoom, r: 'fremdRang1', p: 1 }, TB.token);
ok(!r.ok && r._status === 403, 'Nicht-Mitglied: role.set → 403');
r = await call('room.cperm', { id: rlRoom, c: 'c1', w: [] }, TB.token);
ok(!r.ok && r._status === 403, 'Nicht-Mitglied: room.cperm → 403');
const rlOnce = C.randomId();
r = await call('room.create', { id: rlOnce, meta: await C.sealRoom({ t: 'meta', name: 'M', ch: [], meet: 1, once: 1 }, rlKey, 1, rlOnce, acc.privateKey), once: 1 }, accToken);
r = await call('role.set', { id: rlOnce, r: MOD, p: 1 }, accToken);
ok(!r.ok && r._status === 422, 'Meeting mit Gästen: keine Ränge → 422');
await call('room.delete', { id: rlOnce }, accToken);
// Löschen, Entfernen, Verlassen
r = await call('room.cperm', { id: rlRoom, c: 'news', w: [HELP, MOD] }, accToken);
r = await call('role.del', { id: rlRoom, r: HELP }, accToken);
ok(r.ok && !r.room.rl[HELP] && !r.room.mr[TR.id] && r.room.cw.news.r.join() === MOD && r.room.rl[LOW].o === 1, 'Rang löschen: weg bei Rita und im Kanal, Reihenfolge ohne Lücke');
r = await call('role.assign', { id: rlRoom, r: LOW, member: TR.id, on: 1 }, accToken);
r = await call('room.kick', { id: rlRoom, member: TR.id }, acc2Token);
ok(r.ok, 'Moderator entfernt Rita (Rang darunter)');
r = await call('poll', { r: { [rlRoom]: { s: 0, o: 0, g: 0 } } }, accToken);
ok(r.r[rlRoom].e.some((e) => e.k === 'sys' && e.ev === 'kick' && e.id === TR.id), 'Hinweis „kick“ im Verlauf – die App des Besitzers erneuert daraufhin den Raumschlüssel');
r = await call('rooms', {}, accToken);
ok(!r.rooms.find((x) => x.id === rlRoom).mr[TR.id], 'Ränge der Entfernten sind weg');
await call('end', {}, TR.token);
r = await call('room.leave', { id: rlRoom }, acc2Token);
r = await call('rooms', {}, accToken);
ok(Object.keys(r.rooms.find((x) => x.id === rlRoom).mr).length === 0, 'wer geht, verliert seine Ränge');
await call('room.delete', { id: rlRoom }, accToken);

r = await call('delete', { auth: keys2.auth }, acc2Token);
ok(r.ok, 'zweites Konto gelöscht');

console.log('\n== Aufräumen');
r = await call('end', {}, TB.token);
ok(r.ok, 'Bob beendet seine temporäre Sitzung');
r = await call('me', {}, TB.token);
ok(!r.ok && r._status === 401, 'Bobs Token ist ungültig');
r = await call('ids', { ids: [TB.id] }, TA.token);
ok(r.ok && r.list.length === 0, 'Bobs Identität ist gelöscht');
r = await call('file.get', { id: bobFile, n: 0 }, TA.token);
ok(!r.ok && r._status === 404, 'Bobs Datei ist mit ihm verschwunden');
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
