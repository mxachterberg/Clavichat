/* ==========================================================================
   Clavichat — Updates für die Windows-App
   --------------------------------------------------------------------------
   Sucht beim Start (in den Einstellungen abschaltbar) und auf Knopfdruck
   nach einer neuen Fassung, lädt sie herunter und installiert sie.

   Sicherheit: Die Liste der Fassungen (update.json) ist mit Ed25519
   signiert. Den privaten Schlüssel hat nur der Herausgeber, nicht der
   Webserver – hier steht nur der öffentliche. Die Liste nennt Größe und
   SHA-256 jeder Datei; ausgeführt wird erst, wenn Signatur und Prüfsumme
   stimmen und die Fassung neuer ist. Ein übernommener Webserver kann so kein
   Programm unterschieben (nur Updates zurückhalten).

   Quellen: zuerst das neueste veröffentlichte GitHub-Release (die Liste
   signiert dort GitHub Actions mit eigenem Schlüssel, Secret
   CLAVICHAT_UPDATE_KEY), daneben clavichat.de (signiert beim Herausgeber;
   Spiegel für Apps bis 1.8.2, die nur diese Quelle kennen). Beide werden
   gefragt; es gilt die höchste Fassung, deren Signatur stimmt. Solange das
   Repository privat ist, antwortet GitHub mit 404 – dann zählt nur
   clavichat.de.

     installiert  neuen Installer still ausführen; er startet die App neu
     klein        installiert und gleiche Electron-Fassung: nur das neue
                  Programmpaket (resources/app.asar, gepackt rund 1 MB statt
                  über 100 MB). Nach dem Beenden tauscht ein Hilfsskript die
                  Datei und startet die App neu.
     portabel     neue Datei neben die alte laden. Nach dem Beenden ersetzt
                  ein kleines Hilfsskript die alte – gleicher Name, also
                  bleiben Verknüpfungen und Anheftungen gültig – und startet
   ========================================================================== */
'use strict';

const { app, ipcMain, session } = require('electron');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const zlib = require('node:zlib');

// Quellen der Update-Liste. `files` liefert den Ordner der Dateien zur
// geprüften Liste; ohne Angabe liegen sie neben update.json. Bei GitHub
// direkt beim Tag der Fassung (vX.Y.Z) – so passt der Download auch dann
// noch, wenn zwischen Suchen und Installieren ein neueres Release erscheint.
// GitHub leitet zweimal weiter (Tag, dann *.githubusercontent.com); die
// eigene Sitzung folgt dem, die Echtheit sichern Signatur und SHA-256.
const GITHUB = 'https://github.com/mxachterberg/Clavichat/releases';
const SOURCES = [
  { name: 'GitHub', url: GITHUB + '/latest/download/update.json', files: (m) => GITHUB + '/download/v' + m.version + '/', github: true },
  { name: 'clavichat.de', url: 'https://clavichat.de/downloads/clavichat/update.json' }
];
// Öffentliche Schlüssel (Ed25519, SPKI/DER, Base64) – eine Liste gilt, wenn
// einer davon passt. Die privaten erzeugt und zeigt scripts/update-key.js.
const PUBLIC_KEYS = [
  // Herausgeber, lokal (%USERPROFILE%\.securecom\update-key.pem) – clavichat.de
  'MCowBQYDK2VwAyEAlGx6CauvrfaZJAUtLpqsw19KVCrB2hk2vpfBkKCYnwI=',
  // GitHub Actions (Secret CLAVICHAT_UPDATE_KEY; Kopie beim Herausgeber in
  // %USERPROFILE%\.securecom\update-key-github.pem) – GitHub-Releases
  'MCowBQYDK2VwAyEArs/re0kPWxd1AtgeeTp3FlNNVLOIUh4xz4BqGrS2f28='
];
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;
const START_DELAY = 8000;           // erst einmal in Ruhe starten lassen
const STALL = 60000;                // so lange ohne Daten: Download abbrechen
const LIST_TIMEOUT = 20000;         // so lange darf eine Quelle für die Liste brauchen

let getWindow = () => null;
let ses = null;
let settingsFile = '';
let manifest = null;                // geprüfte Angaben der neuesten Fassung
let job = null;                     // laufende Suche oder Installation
let sentAt = 0;
let sendTimer = null;

const state = {
  version: app.getVersion(),
  mode: '',                         // 'portable' | 'installed' | '' (aktualisiert sich nicht selbst)
  auto: true,
  status: 'idle',                   // idle checking current available downloading installing error unsupported
  latest: null,                     // { version, notes, size, light }
  release: null,                    // { version, notes } der laufenden Fassung – für „Neu in …“ nach einem Update
  progress: 0,
  error: '',
  checked: 0,
  prompt: false                     // beim Start gefunden: Oberfläche zeigt einmal das Popup
};

/* ---------- Einrichtung ------------------------------------------------------ */
function init(opts) {
  getWindow = opts.getWindow;
  settingsFile = path.join(app.getPath('userData'), 'updates.json');
  state.mode = detectMode();
  state.auto = readSettings().auto !== false;
  state.status = state.mode ? 'idle' : 'unsupported';
  // Eigene Sitzung nur im Speicher: kein Zertifikats-Pinning des
  // Clavichat-Servers, keine Cookies, kein Zwischenspeicher.
  ses = session.fromPartition('securecom-updates');
  removeLeftovers();
  ipcMain.handle('securecom:update', handle);
  if (state.mode && state.auto && !opts.smoke) setTimeout(() => check(true), START_DELAY);
}

function detectMode() {
  if (!app.isPackaged) return '';
  if (process.env.PORTABLE_EXECUTABLE_FILE) return 'portable';
  // Vom Installer eingerichtet: Neben der Programmdatei liegt sein Deinstallationsprogramm.
  const uninstaller = path.join(path.dirname(process.execPath), 'Uninstall ' + app.getName() + '.exe');
  return fs.existsSync(uninstaller) ? 'installed' : '';
}

function sources() {
  const custom = process.env.SECURECOM_UPDATE_URL || '';
  // Nur zum Testen: eigene Quelle (statt aller anderen), unverschlüsselt nur
  // auf diesem Rechner. Die Signatur gilt trotzdem – fremde Fassungen
  // installiert die App nie.
  if (custom && /^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)[:/])/i.test(custom)) return [{ name: 'Test', url: custom }];
  return SOURCES;
}

function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')) || {}; } catch (e) { return {}; }
}

function saveSettings() {
  fs.promises.writeFile(settingsFile, JSON.stringify({ auto: state.auto })).catch(() => { /* nächstes Mal */ });
}

/** Reste eines abgebrochenen Updates wegräumen. */
function removeLeftovers() {
  try {
    if (state.mode === 'portable') {
      for (const f of [portableTarget(), portableTarget() + '.part']) fs.rmSync(f, { force: true });
    }
    if (state.mode === 'installed') {
      for (const f of [asarFile() + '.new', asarFile() + '.old']) fs.rmSync(f, { force: true });
    }
    if (state.mode) fs.rmSync(installerDir(), { recursive: true, force: true });
  } catch (e) { /* egal */ }
}

/* ---------- Oberfläche ------------------------------------------------------- */
async function handle(event, action, value) {
  const win = getWindow();
  if (!win || event.sender !== win.webContents) throw new Error('Nicht erlaubt.');
  switch (action) {
    case 'get': break;
    case 'check': await check(false); break;
    case 'auto': state.auto = !!value; saveSettings(); send(true); break;
    case 'seen': state.prompt = false; break;
    case 'install': install(); break;            // Fortschritt kommt per Nachricht
    default: throw new Error('Unbekannte Aktion.');
  }
  return snapshot();
}

function snapshot() {
  return Object.assign({}, state, {
    latest: state.latest && Object.assign({}, state.latest),
    release: state.release && Object.assign({}, state.release)
  });
}

function set(changes) {
  Object.assign(state, changes);
  send(!('progress' in changes) || 'status' in changes);
}

/** Stand an die Oberfläche; Fortschritt höchstens fünfmal je Sekunde. */
function send(now) {
  const win = getWindow();
  if (!win || win.isDestroyed()) return;
  clearTimeout(sendTimer);
  const wait = now ? 0 : Math.max(0, 200 - (Date.now() - sentAt));
  sendTimer = setTimeout(() => {
    sentAt = Date.now();
    if (!win.isDestroyed()) win.webContents.send('securecom:update-state', snapshot());
  }, wait);
}

/* ---------- Suchen ----------------------------------------------------------- */
function check(auto) {
  if (!state.mode || state.status === 'installing') return Promise.resolve();
  if (job) return job;
  job = (async () => {
    set({ status: 'checking', error: '' });
    try {
      manifest = await fetchManifest();
      const available = newer(manifest.version, state.version);
      const light = available && lightUpdate(manifest);
      set({
        status: available ? 'available' : 'current',
        latest: available ? { version: manifest.version, notes: manifest.notes, size: light ? manifest.asar.size : manifest.file.size, light } : null,
        release: manifest.version === state.version ? { version: manifest.version, notes: manifest.notes } : state.release,
        prompt: available && (auto || state.prompt),
        checked: Date.now()
      });
    } catch (e) {
      set({ status: 'error', error: messageOf(e), checked: Date.now() });
    }
  })().finally(() => { job = null; });
  return job;
}

/**
 * Alle Quellen gleichzeitig fragen und die höchste geprüfte Fassung nehmen;
 * bei gleicher Nummer gewinnt die frühere Quelle (GitHub). Scheitern alle,
 * zählt der aussagekräftigste Fehler – ein 404 (z. B. GitHub, solange das
 * Repository privat ist) nur, wenn es nichts anderes gibt.
 */
async function fetchManifest() {
  const list = sources();
  const results = await Promise.allSettled(list.map(fetchFrom));
  let best = null;
  const errors = [];
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      errors.push(r.reason);
      if (!(r.reason && r.reason.notFound)) writeLog('Update-Liste von ' + list[i].name + ': ' + messageOf(r.reason));
      return;
    }
    if (!best || newer(r.value.version, best.version)) best = r.value;
  });
  if (best) return best;
  throw errors.find((e) => !(e && e.notFound)) || errors[0] || new Error('Keine Update-Quelle.');
}

async function fetchFrom(src) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LIST_TIMEOUT);
  try {
    // Bei GitHub ohne angehängte Zeit: Die Weiterleitung führt auf signierte
    // Adressen, und dort ist nichts zwischengespeichert.
    const url = src.github ? src.url : src.url + '?t=' + Date.now();
    const res = await ses.fetch(url, { cache: 'no-store', redirect: 'follow', signal: ctrl.signal });
    if (res.status === 404) throw Object.assign(new Error('Auf dem Server liegt noch keine Update-Liste.'), { notFound: true });
    if (!res.ok) throw new Error('Der Update-Server antwortet mit ' + res.status + '.');
    const text = await res.text();
    if (text.length > 65536) throw new Error('Die Update-Liste ist ungültig.');
    const m = verifyManifest(text);
    m.base = src.files ? src.files(m) : src.url;
    m.cacheBust = !src.github;
    m.source = src.name;
    return m;
  } finally {
    clearTimeout(timer);
  }
}

/** Passt die Signatur zu einem der öffentlichen Schlüssel? */
function signedByUs(data, sig) {
  return PUBLIC_KEYS.some((k) => {
    try {
      const key = crypto.createPublicKey({ key: Buffer.from(k, 'base64'), format: 'der', type: 'spki' });
      return crypto.verify(null, Buffer.from(data, 'utf8'), key, Buffer.from(sig, 'base64'));
    } catch (e) { return false; }
  });
}

/** Signatur prüfen, dann die Angaben – erst danach wird irgendetwas davon benutzt. */
function verifyManifest(text) {
  let env = null;
  try { env = JSON.parse(text); } catch (e) { /* unten */ }
  if (!env || typeof env.data !== 'string' || typeof env.sig !== 'string') throw new Error('Die Update-Liste ist ungültig.');
  if (!signedByUs(env.data, env.sig)) throw new Error('Die Signatur der Update-Liste stimmt nicht – es wird nichts installiert.');

  const m = JSON.parse(env.data);
  if (!m || m.app !== 'clavichat' || !VERSION.test(String(m.version))) throw new Error('Die Update-Liste gehört nicht zu Clavichat.');
  const f = m.files && m.files[state.mode === 'portable' ? 'portable' : 'setup'];
  if (!f || !/^[A-Za-z0-9._-]{1,100}\.exe$/.test(String(f.name)) || !/^[0-9a-f]{64}$/.test(String(f.sha256)) ||
      !Number.isSafeInteger(f.size) || f.size <= 0 || f.size > 1e9) {
    throw new Error('Für diese Fassung der App gibt es keine passende Datei.');
  }
  const notes = Array.isArray(m.notes) ? m.notes.filter((n) => typeof n === 'string').slice(0, 12).map((n) => n.slice(0, 400)) : [];
  // Kleines Update (nur das Programmpaket) – fehlt es oder passt etwas nicht,
  // bleibt es beim vollen.
  const a = m.files.asar;
  const okFile = (x) => x && /^[0-9a-f]{64}$/.test(String(x.sha256)) && Number.isSafeInteger(x.size) && x.size > 0 && x.size <= 2e8;
  const asar = okFile(a) && /^[A-Za-z0-9._-]{1,100}\.asar\.gz$/.test(String(a.name)) && okFile(a.raw) &&
    typeof m.electron === 'string' && /^[\d.]{1,20}$/.test(m.electron)
    ? { name: a.name, size: a.size, sha256: a.sha256, raw: { size: a.raw.size, sha256: a.raw.sha256 } } : null;
  return { version: m.version, notes: notes, file: { name: f.name, size: f.size, sha256: f.sha256 }, asar: asar, electron: asar ? m.electron : '' };
}

/** Nur installiert und mit derselben Electron-Fassung – sonst der volle Installer. */
function lightUpdate(m) {
  return !!(m && m.asar && state.mode === 'installed' && m.electron === process.versions.electron &&
    fs.existsSync(asarFile()) && !fs.existsSync(asarFile() + '.unpacked'));
}

function asarFile() {
  return path.join(process.resourcesPath, 'app.asar');
}

function newer(a, b) {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
}

function messageOf(e) {
  const text = String((e && e.message) || e || '');
  if (/net::|fetch failed|ENOTFOUND|ECONN|ETIMEDOUT|aborted/i.test(text)) return 'Keine Verbindung zum Update-Server.';
  if (/EACCES|EPERM|EROFS/i.test(text)) return 'Der Ordner der App ist schreibgeschützt – die neue Fassung lässt sich dort nicht ablegen.';
  if (/ENOSPC/.test(text)) return 'Nicht genug Speicherplatz für die neue Fassung.';
  return text || 'Unbekannter Fehler.';
}

/* ---------- Herunterladen und installieren ----------------------------------- */
function install() {
  if (job || !state.mode || state.status === 'installing') return;
  job = (async () => {
    try {
      if (!manifest || !newer(manifest.version, state.version)) {
        manifest = await fetchManifest();
        if (!newer(manifest.version, state.version)) { set({ status: 'current', latest: null }); return; }
      }
      const light = lightUpdate(manifest);
      const file = await download(light ? manifest.asar : manifest.file);
      set({ status: 'installing', progress: 1 });
      await new Promise((r) => setTimeout(r, 600));   // Oberfläche zeigt „wird installiert“
      const started = light ? await swapAsar(await unpackAsar(file))
        : state.mode === 'installed' ? await runInstaller(file) : await swapPortable(file);
      if (!started) throw new Error('Das Update ließ sich nicht starten (Details in update.log im Profilordner).');
      app.quit();
    } catch (e) {
      set({ status: 'error', error: messageOf(e) });
    }
  })().finally(() => { if (state.status !== 'installing') job = null; });
}

function portableTarget() {
  return process.env.PORTABLE_EXECUTABLE_FILE + '.update';
}

function installerDir() {
  return path.join(app.getPath('temp'), 'Clavichat-Update');
}

async function download(f) {
  const target = state.mode === 'portable' && f.name.endsWith('.exe') ? portableTarget() : path.join(installerDir(), f.name);
  const part = target + '.part';
  fs.mkdirSync(path.dirname(target), { recursive: true });
  set({ status: 'downloading', progress: 0, error: '' });

  const ctrl = new AbortController();
  let stall = setTimeout(() => ctrl.abort(), STALL);
  const hash = crypto.createHash('sha256');
  let got = 0;
  let fh = null;
  try {
    const url = new URL(f.name, manifest.base).href + (manifest.cacheBust ? '?t=' + Date.now() : '');
    const res = await ses.fetch(url, { cache: 'no-store', redirect: 'follow', signal: ctrl.signal });
    if (!res.ok || !res.body) throw new Error('Die neue Fassung ließ sich nicht laden (' + res.status + ').');
    fh = await fs.promises.open(part, 'w');
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      clearTimeout(stall);
      stall = setTimeout(() => ctrl.abort(), STALL);
      got += value.length;
      if (got > f.size) throw new Error('Die Datei ist größer als angekündigt – abgebrochen.');
      hash.update(value);
      await fh.write(value);
      set({ progress: got / f.size });
    }
  } catch (e) {
    if (fh) await fh.close().catch(() => {});
    fh = null;
    fs.rmSync(part, { force: true });
    throw e;
  } finally {
    clearTimeout(stall);
    if (fh) await fh.close();
  }
  if (got !== f.size || hash.digest('hex') !== f.sha256) {
    fs.rmSync(part, { force: true });
    throw new Error('Die Prüfsumme der neuen Fassung stimmt nicht – sie wird nicht installiert.');
  }
  fs.renameSync(part, target);
  return target;
}

/** Installiert: der Installer schließt die App, aktualisiert und startet sie (--force-run). */
function runInstaller(file) {
  writeLog('Update auf ' + manifest.version + ': Installer startet');
  return new Promise((resolve) => {
    // Ein Fensterprogramm: „losgelöst“ gestartet überlebt es das Ende der App.
    const child = spawn(file, ['--updated', '/S', '--force-run'], { detached: true, stdio: 'ignore' });
    child.on('error', (e) => { writeLog('Installer ließ sich nicht starten: ' + e.message); resolve(false); });
    child.on('spawn', () => { child.unref(); resolve(true); });
  });
}

/**
 * Portabel: Die laufende Datei ist gesperrt, solange die App läuft. Ein
 * kleines PowerShell-Skript wartet, bis die portable Hülle (unser
 * Elternprozess) beendet ist, legt die neue Datei an die Stelle der alten
 * und startet sie mit denselben Argumenten.
 *
 * Gestartet über einen Zwischenschritt: „Losgelöst“ läuft PowerShell ohne
 * Konsole gar nicht an, und ein gewöhnliches Kind beendet Windows zusammen
 * mit der App. Start-Process im Zwischenschritt macht das Skript unabhängig;
 * die App endet erst, wenn der Zwischenschritt fertig ist.
 */
function swapPortable(file) {
  const exe = process.env.PORTABLE_EXECUTABLE_FILE;
  return swapFile(file, exe, process.ppid, exe, '');
}

/** Kleines Update: entpacken und gegen die angekündigte Größe und Prüfsumme prüfen. */
async function unpackAsar(gz) {
  const target = asarFile() + '.new';
  const want = manifest.asar.raw;
  const hash = crypto.createHash('sha256');
  let size = 0;
  const check = new Transform({
    transform(chunk, enc, done) {
      size += chunk.length;
      if (size > want.size) return done(new Error('Das Programmpaket ist größer als angekündigt – abgebrochen.'));
      hash.update(chunk);
      return done(null, chunk);
    }
  });
  try {
    await pipeline(fs.createReadStream(gz), zlib.createGunzip(), check, fs.createWriteStream(target));
  } catch (e) {
    fs.rmSync(target, { force: true });
    throw e;
  } finally {
    fs.rmSync(gz, { force: true });
  }
  if (size !== want.size || hash.digest('hex') !== want.sha256) {
    fs.rmSync(target, { force: true });
    throw new Error('Die Prüfsumme des Programmpakets stimmt nicht – es wird nicht installiert.');
  }
  return target;
}

/**
 * Kleines Update: Die laufende App hält app.asar offen. Das Hilfsskript
 * wartet auf ihr Ende, legt die alte Datei als .old zur Seite (beim nächsten
 * Start gelöscht; klappt das Einsetzen nicht, kommt sie zurück), setzt die
 * neue ein und startet die App.
 */
function swapAsar(file) {
  return swapFile(file, asarFile(), process.pid, process.execPath, asarFile() + '.old');
}

/** Datei tauschen, sobald Prozess waitPid beendet ist, dann exe neu starten. */
function swapFile(file, dest, waitPid, exe, backup) {
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const args = process.argv.slice(1).filter((a) => a !== '--smoke')
    .map((a) => (/[\s"]/.test(a) ? '"' + a.replace(/"/g, '\\"') + '"' : a)).join(' ');
  const log = (text) => 'Add-Content -Encoding UTF8 -LiteralPath ' + q(logFile()) + ' -Value ((Get-Date -Format s) + ' + q(' ' + text) + ')';
  const put = 'Move-Item -LiteralPath ' + q(file) + ' -Destination ' + q(dest) + ' -Force -ErrorAction Stop';
  const move = backup
    ? 'Move-Item -LiteralPath ' + q(dest) + ' -Destination ' + q(backup) + ' -Force -ErrorAction Stop; ' +
      'try { ' + put + ' } catch { Move-Item -LiteralPath ' + q(backup) + ' -Destination ' + q(dest) + ' -Force; throw }'
    : put;
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    log('Hilfsskript läuft, wartet auf Prozess ' + waitPid),
    'Wait-Process -Id ' + Number(waitPid) + ' -Timeout 120',
    '$ok = $false',
    'for ($i = 0; $i -lt 60; $i++) {',
    '  try { ' + move + '; $ok = $true; break }',
    '  catch { $err = $_.Exception.Message; Start-Sleep -Milliseconds 500 }',
    '}',
    'if ($ok) { ' + log('Datei ersetzt') + ' } else { Add-Content -Encoding UTF8 -LiteralPath ' + q(logFile()) + " -Value ((Get-Date -Format s) + ' Ersetzen fehlgeschlagen: ' + $err) }",
    'Start-Process -FilePath ' + q(exe) + (args ? ' -ArgumentList ' + q(args) : ''),
    log('neue Fassung gestartet')
  ].join('\r\n');
  const ps1 = path.join(installerDir(), 'tausch.ps1');
  fs.mkdirSync(installerDir(), { recursive: true });
  fs.writeFileSync(ps1, '﻿' + script, 'utf8');   // mit BOM, sonst liest PowerShell 5 Umlaute falsch
  writeLog('Update auf ' + manifest.version + (backup ? ' (klein, nur Programmpaket)' : '') + ': Hilfsskript startet');
  const launch = 'Start-Process -FilePath powershell.exe -WindowStyle Hidden -ArgumentList ' +
    q('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + ps1 + '"');
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', launch],
      { stdio: 'ignore', windowsHide: true });
    child.on('error', (e) => { writeLog('Hilfsskript ließ sich nicht starten: ' + e.message); resolve(false); });
    child.on('exit', (code) => { if (code) writeLog('Zwischenschritt endete mit Code ' + code); resolve(code === 0); });
  });
}

/** Protokoll im Profilordner – hilft, wenn ein Update einmal hängen bleibt. */
function logFile() {
  return path.join(app.getPath('userData'), 'update.log');
}

function writeLog(text) {
  // Ortszeit wie im Hilfsskript (Get-Date -Format s)
  const d = new Date();
  const stamp = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
  try { fs.appendFileSync(logFile(), stamp + ' ' + text + '\r\n'); } catch (e) { /* egal */ }
}

module.exports = { init };
