/* ==========================================================================
   Clavichat — Update veröffentlichen (nur beim Release)
   Signiert die Update-Liste mit dem privaten Schlüssel (update-key.js) und
   legt sie samt Installer und portabler Fassung in den Zielordner, der dann
   auf den Webserver kommt. Ältere Fassungen dort werden entfernt.
   Die Neuerungen im Popup stammen aus dem Abschnitt der Version in
   CHANGELOG.md (anderer Ort: SECURECOM_CHANGELOG).

     npm run build
     node scripts/publish-update.js "<Webroot>\downloads\clavichat"

   Danach zuerst die .exe-Dateien hochladen, zuletzt update.json.
   ========================================================================== */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { KEY_FILE, publicKeyOf } = require('./update-key');
const { version } = require('../package.json');

function fail(message) {
  console.error('Abbruch: ' + message);
  process.exit(1);
}

/** Stichpunkte der Version aus CHANGELOG.md, ohne Markdown. */
function changelogNotes(v) {
  const file = process.env.SECURECOM_CHANGELOG || path.join(__dirname, '..', '..', 'CHANGELOG.md');
  const lines = fs.readFileSync(file, 'utf8').replace(/\r/g, '').split('\n');
  const start = lines.findIndex((l) => l === '## ' + v || l.indexOf('## ' + v + ' ') === 0);
  if (start < 0) fail('In ' + file + ' fehlt der Abschnitt „## ' + v + '“.');
  const notes = [];
  for (let i = start + 1; i < lines.length && lines[i].indexOf('## ') !== 0; i++) {
    const l = lines[i];
    if (/^- /.test(l)) notes.push(l.slice(2).trim());
    else if (/^\s+\S/.test(l) && notes.length) notes[notes.length - 1] += ' ' + l.trim();
  }
  if (!notes.length) fail('Der Abschnitt „## ' + v + '“ in CHANGELOG.md hat keine Stichpunkte.');
  return notes.map((n) => n.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'));
}

const target = process.argv[2];
if (!target) fail('Zielordner fehlt: node scripts/publish-update.js <Ordner>');

const dist = path.join(__dirname, '..', 'dist');
const files = {
  setup: { src: path.join(dist, 'Clavichat-Setup-' + version + '.exe'), name: 'Clavichat-Setup-' + version + '.exe' },
  portable: { src: path.join(dist, 'Clavichat-portable.exe'), name: 'Clavichat-' + version + '-portable.exe' }
};
for (const f of Object.values(files)) {
  if (!fs.existsSync(f.src)) fail('Es fehlt ' + f.src + ' – erst npm run build.');
}
if (Math.abs(fs.statSync(files.setup.src).mtimeMs - fs.statSync(files.portable.src).mtimeMs) > 15 * 60 * 1000) {
  fail('Installer und portable Fassung stammen nicht aus demselben Build.');
}
if (!fs.existsSync(KEY_FILE)) fail('Kein privater Schlüssel unter ' + KEY_FILE + ' (node scripts/update-key.js).');
const pem = fs.readFileSync(KEY_FILE, 'utf8');
if (!fs.readFileSync(path.join(__dirname, '..', 'updater.js'), 'utf8').includes(publicKeyOf(pem))) {
  fail('Der öffentliche Schlüssel in updater.js passt nicht zu ' + KEY_FILE + '.');
}

const manifest = { app: 'clavichat', version: version, date: new Date().toISOString().slice(0, 10), notes: changelogNotes(version), files: {} };
for (const [kind, f] of Object.entries(files)) {
  const bytes = fs.readFileSync(f.src);
  manifest.files[kind] = { name: f.name, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}
const data = JSON.stringify(manifest);
const sig = crypto.sign(null, Buffer.from(data, 'utf8'), crypto.createPrivateKey(pem)).toString('base64');
if (!crypto.verify(null, Buffer.from(data, 'utf8'), crypto.createPublicKey(pem), Buffer.from(sig, 'base64'))) fail('Signatur lässt sich nicht prüfen.');

fs.mkdirSync(target, { recursive: true });
for (const f of Object.values(files)) fs.copyFileSync(f.src, path.join(target, f.name));
fs.writeFileSync(path.join(target, 'update.json'), JSON.stringify({ data: data, sig: sig }, null, 1) + '\n');
const keep = new Set(Object.values(files).map((f) => f.name));
for (const name of fs.readdirSync(target)) {
  if (/^Clavichat-.*\.exe$/.test(name) && !keep.has(name)) {
    fs.rmSync(path.join(target, name), { force: true });
    console.log('entfernt:', name);
  }
}
console.log('Clavichat ' + version + ' signiert und abgelegt in ' + target);
for (const [kind, f] of Object.entries(manifest.files)) console.log('  ' + kind + ': ' + f.name + ' (' + Math.round(f.size / 1048576) + ' MB)');
console.log('Neuerungen: ' + manifest.notes.length + ' Stichpunkte');
