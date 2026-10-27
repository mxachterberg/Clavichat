/* ==========================================================================
   Clavichat — Update veröffentlichen (nur beim Release)
   Signiert die Update-Liste mit dem privaten Schlüssel (update-key.js) und
   legt sie samt Installer und portabler Fassung in den Zielordner, der dann
   auf den Webserver kommt. Ältere Fassungen dort werden entfernt.
   Dazu das kleine Update: nur das Programmpaket (resources/app.asar, mit
   gzip gepackt). Installierte Apps mit derselben Electron-Fassung laden nur
   das (rund 1 MB statt über 100 MB).
   Die Neuerungen im Popup stammen aus dem Abschnitt der Version in
   CHANGELOG.md (anderer Ort: SECURECOM_CHANGELOG).

     npm run build
     node scripts/publish-update.js "<Webroot>\downloads\clavichat"

   Danach hochladen – zuerst die .exe-Dateien, zuletzt update.json; ältere
   Fassungen auf dem Server löscht es gleich mit:
     powershell -ExecutionPolicy Bypass -File scripts\upload-update.ps1 -Dir "<Webroot>\downloads\clavichat"

   GitHub Actions ruft dasselbe Skript mit dem Schlüssel aus dem Secret
   CLAVICHAT_UPDATE_KEY (PEM-Text statt Datei) auf und hängt den Zielordner
   an den Release-Entwurf (.github/workflows/windows.yml).
   ========================================================================== */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { KEY_FILE, publicKeyOf } = require('./update-key');
const { version } = require('../package.json');

function fail(message) {
  console.error('Abbruch: ' + message);
  process.exit(1);
}

// Electron-Fassung des Builds: aus node_modules, ohne node_modules (Signier-
// Job in GitHub Actions, dort läuft bewusst kein npm ci) aus package-lock.json
// – npm ci installiert genau diese Fassung.
function electronVersion() {
  try {
    return require('../node_modules/electron/package.json').version;
  } catch (e) {
    const entry = (require('../package-lock.json').packages || {})['node_modules/electron'];
    if (!entry || !entry.version) fail('Electron-Fassung weder in node_modules noch in package-lock.json gefunden.');
    return entry.version;
  }
}
const electron = electronVersion();

// Die App zeigt höchstens 12 Stichpunkte zu je 400 Zeichen und schneidet
// hart ab (updater.js) – deshalb hier vorher an einer Wortgrenze kürzen.
// Der Text des GitHub-Releases behält den vollen Wortlaut.
const MAX_NOTES = 12;
const MAX_NOTE = 400;

function shorten(text) {
  if (text.length <= MAX_NOTE) return text;
  const cut = text.slice(0, MAX_NOTE - 1);
  // Am liebsten nach einem ganzen Satz, sonst an einem Wortende mit „…“.
  const sentence = cut.lastIndexOf('. ');
  if (sentence > MAX_NOTE * 0.6) return cut.slice(0, sentence + 1);
  const space = cut.lastIndexOf(' ');
  return (space > MAX_NOTE / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:–(„"-]+$/, '') + '…';
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
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
  if (notes.length > MAX_NOTES) console.warn('Hinweis: Das Popup zeigt nur die ersten ' + MAX_NOTES + ' von ' + notes.length + ' Stichpunkten.');
  return notes.slice(0, MAX_NOTES)
    .map((n) => n.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*([^*\s][^*]*)\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'))
    .map(shorten);
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
// Schlüssel: aus CLAVICHAT_UPDATE_KEY (der PEM-Text selbst – so in GitHub
// Actions aus dem Secret), sonst aus der Datei. Der Text wird nie ausgegeben.
const fromEnv = !!(process.env.CLAVICHAT_UPDATE_KEY || '').trim();
const keySource = fromEnv ? 'CLAVICHAT_UPDATE_KEY' : KEY_FILE;
let pem = '';
if (fromEnv) {
  // Manche Oberflächen machen aus Zeilenumbrüchen ein wörtliches \n.
  pem = process.env.CLAVICHAT_UPDATE_KEY.replace(/\\n/g, '\n').replace(/\r/g, '').trim() + '\n';
} else {
  if (!fs.existsSync(KEY_FILE)) fail('Kein privater Schlüssel unter ' + KEY_FILE + ' (node scripts/update-key.js).');
  pem = fs.readFileSync(KEY_FILE, 'utf8');
}
let publicKey = '';
try {
  if (crypto.createPrivateKey(pem).asymmetricKeyType !== 'ed25519') throw new Error('kein Ed25519');
  publicKey = publicKeyOf(pem);
} catch (e) {
  fail('In ' + keySource + ' steht kein gültiger privater Ed25519-Schlüssel (PEM, „-----BEGIN PRIVATE KEY-----“).');
}
// updater.js kann mehrere Schlüssel nennen (PUBLIC_KEYS) – einer davon muss passen.
if (!fs.readFileSync(path.join(__dirname, '..', 'updater.js'), 'utf8').includes("'" + publicKey + "'")) {
  fail('Der öffentliche Schlüssel zu ' + keySource + ' steht nicht in updater.js (PUBLIC_KEYS).');
}

const manifest = { app: 'clavichat', version: version, date: new Date().toISOString().slice(0, 10), notes: changelogNotes(version), files: {} };
for (const [kind, f] of Object.entries(files)) {
  const bytes = fs.readFileSync(f.src);
  manifest.files[kind] = { name: f.name, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

// Kleines Update: das Programmpaket aus demselben Build. Gibt es daneben
// entpackte Teile (app.asar.unpacked), reicht es nicht – dann nur das volle.
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const asarSrc = path.join(dist, 'win-unpacked', 'resources', 'app.asar');
let asarGz = null;
if (!fs.existsSync(asarSrc)) {
  console.warn('Hinweis: ' + asarSrc + ' fehlt – kein kleines Update.');
} else if (fs.existsSync(asarSrc + '.unpacked')) {
  console.warn('Hinweis: app.asar.unpacked vorhanden – kein kleines Update, nur das volle.');
} else if (Math.abs(fs.statSync(asarSrc).mtimeMs - fs.statSync(files.setup.src).mtimeMs) > 15 * 60 * 1000) {
  fail('app.asar und Installer stammen nicht aus demselben Build.');
} else {
  const raw = fs.readFileSync(asarSrc);
  asarGz = zlib.gzipSync(raw, { level: 9 });
  if (!zlib.gunzipSync(asarGz).equals(raw)) fail('Das gepackte Programmpaket lässt sich nicht prüfen.');
  manifest.electron = electron;
  manifest.files.asar = {
    name: 'Clavichat-' + version + '-app.asar.gz', size: asarGz.length, sha256: sha(asarGz),
    raw: { size: raw.length, sha256: sha(raw) }
  };
}
const data = JSON.stringify(manifest);
const sig = crypto.sign(null, Buffer.from(data, 'utf8'), crypto.createPrivateKey(pem)).toString('base64');
if (!crypto.verify(null, Buffer.from(data, 'utf8'), crypto.createPublicKey(pem), Buffer.from(sig, 'base64'))) fail('Signatur lässt sich nicht prüfen.');

fs.mkdirSync(target, { recursive: true });
if (asarGz) {
  const dest = path.join(target, manifest.files.asar.name);
  if (!(fs.existsSync(dest) && sha256File(dest) === manifest.files.asar.sha256)) fs.writeFileSync(dest, asarGz);
}
for (const [kind, f] of Object.entries(files)) {
  // Unveränderte Dateien nicht neu schreiben: Das Hochladen nach
  // Änderungszeit würde sie sonst ein zweites Mal übertragen.
  const dest = path.join(target, f.name);
  const same = fs.existsSync(dest) && fs.statSync(dest).size === manifest.files[kind].size && sha256File(dest) === manifest.files[kind].sha256;
  if (!same) fs.copyFileSync(f.src, dest);
}
fs.writeFileSync(path.join(target, 'update.json'), JSON.stringify({ data: data, sig: sig }, null, 1) + '\n');
const keep = new Set(Object.values(manifest.files).map((f) => f.name));
for (const name of fs.readdirSync(target)) {
  if (/^Clavichat-.*\.(exe|asar\.gz)$/.test(name) && !keep.has(name)) {
    fs.rmSync(path.join(target, name), { force: true });
    console.log('entfernt:', name);
  }
}
console.log('Clavichat ' + version + ' signiert und abgelegt in ' + target);
for (const [kind, f] of Object.entries(manifest.files)) console.log('  ' + kind + ': ' + f.name + ' (' + (f.size / 1048576).toFixed(1) + ' MB)');
if (manifest.electron) console.log('Kleines Update für installierte Apps mit Electron ' + manifest.electron);
console.log('Neuerungen: ' + manifest.notes.length + ' Stichpunkte');
