/* ==========================================================================
   SecureCom Server — der SecureCom-Server als Windows-Programm
   --------------------------------------------------------------------------
   Startet das mitgelieferte PHP mit dem eigenständigen Server (server/) und
   setzt HTTPS davor – Browser geben Verschlüsselung (WebCrypto) und
   Mikrofon nur über HTTPS frei.

     Browser ──HTTPS──▶ dieses Programm (Port 8443, Heimnetz)
                          └──HTTP──▶ php -S 127.0.0.1:<frei> (nur lokal)

   Das Zertifikat entsteht beim ersten Start (cert.js). Wer aus Versehen
   http:// tippt, wird auf demselben Port zu https:// umgeleitet.

   Alles Veränderliche liegt in %APPDATA%\SecureCom Server:
     data\          Ablage (Konten, Räume, Briefkästen – verschlüsselt)
     config.php     Einstellungen (Zugangscode, Relay-Server …)
     settings.json  Port, Heimnetz, Autostart
     server.crt/key Zertifikat
   ========================================================================== */
'use strict';

const { app, BrowserWindow, Menu, Tray, clipboard, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { makeCertificate } = require('./cert');

const SMOKE = process.argv.includes('--smoke');
const PACKED = app.isPackaged;
const PHP_DIR = PACKED ? path.join(process.resourcesPath, 'php') : path.join(__dirname, 'php');
const SERVER_DIR = PACKED ? path.join(process.resourcesPath, 'server') : path.join(__dirname, '..', '..', 'server');
// Mehrere Größen in einer Datei: Windows nimmt für Fenster, Taskleiste und
// Infobereich jeweils die passende.
const ICON = path.join(__dirname, '..', 'build', 'icon.ico');
// Wie appId in host/builder.json (steht so an den Verknüpfungen des Installers).
const APP_ID = 'dev.achterberg.securecom.server' + (SMOKE ? '.selbsttest' : PACKED ? '' : '.dev');
// Die portable Fassung läuft aus einem Temp-Ordner – für die Taskleiste zählt die Originaldatei.
const EXE = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;

// Eigener Ordner, auch beim Entwickeln (sonst teilte er sich den der App).
app.setName('SecureCom Server');
app.setAppUserModelId(APP_ID);
// SECURECOM_SERVER_HOME: anderer Ordner für Daten und Einstellungen (Tests, mehrere Server).
app.setPath('userData', process.env.SECURECOM_SERVER_HOME || (SMOKE
  ? path.join(app.getPath('temp'), 'SecureCom-Server-Selbsttest')
  : path.join(app.getPath('appData'), 'SecureCom Server')));
if (SMOKE) {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
}

const HOME = app.getPath('userData');
const FILES = {
  settings: path.join(HOME, 'settings.json'),
  config: path.join(HOME, 'config.php'),
  data: path.join(HOME, 'data'),
  cert: path.join(HOME, 'server.crt'),
  key: path.join(HOME, 'server.key'),
  phpLog: path.join(HOME, 'php-fehler.log')
};

const S = {
  settings: { port: 8443, lan: true, autostart: false },
  status: 'start',          // start | läuft | fehler | gestoppt
  error: null,
  tls: null,                // { key, cert, fingerprint }
  phpPort: 0,
  php: null,
  front: null,
  stopping: false,
  crashes: 0,
  log: []
};
let win = null;
let tray = null;
let quitting = false;

/* ---------- Protokoll -------------------------------------------------------- */
function log(text) {
  const line = new Date().toLocaleTimeString('de-DE') + '  ' + text;
  S.log.push(line);
  if (S.log.length > 200) S.log.splice(0, S.log.length - 200);
  push();
}

/* ---------- Einstellungen, config.php, Zertifikat ----------------------------- */
function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(FILES.settings, 'utf8'));
    const port = parseInt(saved.port, 10);
    if (port >= 1024 && port <= 65535) S.settings.port = port;
    S.settings.lan = saved.lan !== false;
    S.settings.autostart = !!saved.autostart;
  } catch (e) { /* erster Start */ }
}

function saveSettings() {
  fs.writeFileSync(FILES.settings, JSON.stringify(S.settings, null, 2));
}

function ensureConfig() {
  fs.mkdirSync(FILES.data, { recursive: true });
  if (fs.existsSync(FILES.config)) return;
  fs.writeFileSync(FILES.config, [
    '<?php',
    '/**',
    ' * SecureCom Server – Einstellungen. Nach Änderungen im Fenster',
    ' * „Neu starten“ wählen. Alle Möglichkeiten zeigt config.sample.php',
    ' * im Programmordner (resources\\server).',
    ' */',
    'return [',
    "    'storage_dir'     => __DIR__ . DIRECTORY_SEPARATOR . 'data',",
    '    // Der HTTPS-Teil dieses Programms reicht die Adresse der Besucher weiter.',
    "    'trusted_proxies' => ['127.0.0.1'],",
    '',
    '    // Konto anlegen und temporäre Sitzungen nur mit diesem Code:',
    "    // 'securecom_access_code' => '',",
    '',
    '    // Relay-Server für Anrufe übers Handy (Mobilfunk), etwa Cloudflare Realtime TURN:',
    "    // 'securecom_cf_turn' => ['key_id' => '…', 'api_token' => '…'],",
    '];',
    ''
  ].join('\r\n'));
}

/** Adressen im Heimnetz (IPv4, ohne Selbstzuweisung 169.254.x.x). */
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address);
    }
  }
  return [...new Set(out)];
}

/** Vorhandenes Zertifikat nehmen; neu, wenn es fehlt oder bald abläuft. */
function ensureCertificate() {
  try {
    const cert = fs.readFileSync(FILES.cert, 'utf8');
    const key = fs.readFileSync(FILES.key, 'utf8');
    const x509 = new crypto.X509Certificate(cert);
    if (new Date(x509.validTo).getTime() - Date.now() > 30 * 86400000) {
      S.tls = { cert, key, fingerprint: x509.fingerprint256 };
      return;
    }
    log('Zertifikat läuft bald ab – ein neues entsteht.');
  } catch (e) { /* noch keins */ }
  const host = os.hostname();
  const made = makeCertificate(['localhost', host, host + '.local', '127.0.0.1', '::1', ...lanAddresses()],
    'SecureCom Server (' + host + ')');
  fs.writeFileSync(FILES.cert, made.cert);
  fs.writeFileSync(FILES.key, made.key, { mode: 0o600 });
  S.tls = { cert: made.cert, key: made.key, fingerprint: made.fingerprint };
  log('Neues Zertifikat erstellt.');
}

/* ---------- PHP ------------------------------------------------------------------ */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

function waitForPort(port, ms) {
  const until = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(); });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > until) reject(new Error('PHP startet nicht.'));
        else setTimeout(attempt, 120);
      });
    };
    attempt();
  });
}

async function startPhp() {
  S.phpPort = await freePort();
  const args = ['-n',
    '-d', 'extension_dir=' + path.join(PHP_DIR, 'ext'),
    '-d', 'extension=curl', '-d', 'extension=mbstring', '-d', 'extension=openssl',
    '-d', 'display_errors=0', '-d', 'log_errors=1', '-d', 'error_log=' + FILES.phpLog,
    '-d', 'memory_limit=256M', '-d', 'post_max_size=8M', '-d', 'max_execution_time=30', '-d', 'expose_php=0',
    '-S', '127.0.0.1:' + S.phpPort, '-t', SERVER_DIR, path.join(SERVER_DIR, 'router.php')];
  const php = spawn(path.join(PHP_DIR, 'php.exe'), args, {
    cwd: SERVER_DIR,
    windowsHide: true,
    env: Object.assign({}, process.env, { SECURECOM_CONFIG: FILES.config })
  });
  S.php = php;
  // Der eingebaute Server schreibt jede Anfrage ins Protokoll – nur Fehler zeigen.
  let rest = '';
  const read = (chunk) => {
    const lines = (rest + chunk.toString()).split(/\r?\n/);
    rest = lines.pop();
    for (const line of lines) {
      if (/\bPHP (Fatal|Parse|Warning)|\[5\d\d\]|Failed to listen/i.test(line)) log('PHP: ' + line.replace(/^\[[^\]]*\]\s*/, ''));
    }
  };
  php.stdout.on('data', read);
  php.stderr.on('data', read);
  php.once('exit', (code) => {
    if (S.php !== php) return;
    S.php = null;
    if (S.stopping) return;
    S.crashes++;
    log('PHP beendet (Code ' + code + ').');
    if (S.crashes <= 3) {
      setTimeout(() => restart().catch(() => {}), 1500);
    } else {
      fail('PHP stürzt immer wieder ab – siehe php-fehler.log im Datenordner.');
    }
  });
  php.once('error', (e) => fail('PHP lässt sich nicht starten: ' + e.message));
  await waitForPort(S.phpPort, 8000);
}

/* ---------- HTTPS davor --------------------------------------------------------- */
function clientAddress(socket) {
  return String(socket.remoteAddress || '').replace(/^::ffff:/, '');
}

/** Anfrage an PHP weiterreichen – mit der echten Adresse des Besuchers. */
function proxy(req, res) {
  const headers = Object.assign({}, req.headers, {
    'x-forwarded-for': clientAddress(req.socket),
    'x-forwarded-proto': 'https',
    'x-forwarded-host': req.headers.host || ''
  });
  const upstream = http.request({
    host: '127.0.0.1', port: S.phpPort, method: req.method, path: req.url, headers: headers, agent: false
  }, (answer) => {
    res.writeHead(answer.statusCode || 502, answer.headers);
    answer.pipe(res);
  });
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('SecureCom Server: PHP antwortet gerade nicht.');
  });
  req.pipe(upstream);
}

/** Ein Port für beides: TLS-Anfragen an HTTPS, alles andere bekommt eine Umleitung. */
function startFront() {
  return new Promise((resolve, reject) => {
    const secure = https.createServer({ key: S.tls.key, cert: S.tls.cert, minVersion: 'TLSv1.2' }, proxy);
    secure.on('tlsClientError', () => { /* abgebrochene Handschläge (Zertifikatswarnung) */ });
    const plain = http.createServer((req, res) => {
      const host = req.headers.host || ('localhost:' + S.settings.port);
      res.writeHead(301, { Location: 'https://' + host + (req.url || '/'), 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('SecureCom läuft nur über https://');
    });
    const front = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.setTimeout(15000, () => socket.destroy());   // verbindet und schweigt
      socket.once('data', (first) => {
        socket.setTimeout(0);
        socket.pause();
        socket.unshift(first);
        (first[0] === 0x16 ? secure : plain).emit('connection', socket);
        process.nextTick(() => socket.resume());
      });
    });
    front.once('error', (e) => reject(e.code === 'EADDRINUSE'
      ? new Error('Port ' + S.settings.port + ' ist schon belegt – in den Einstellungen einen anderen wählen.')
      : e));
    front.listen(S.settings.port, S.settings.lan ? '0.0.0.0' : '127.0.0.1', () => { S.front = front; resolve(); });
  });
}

/* ---------- Starten, Stoppen ---------------------------------------------------- */
async function start() {
  S.status = 'start';
  S.error = null;
  S.stopping = false;
  push();
  try {
    ensureConfig();
    ensureCertificate();
    await startPhp();
    await startFront();
    S.status = 'läuft';
    S.crashes = 0;
    log('Läuft auf Port ' + S.settings.port + (S.settings.lan ? ' (im Heimnetz erreichbar).' : ' (nur dieser Rechner).'));
  } catch (e) {
    fail(e.message);
  }
  push();
}

function stop() {
  S.stopping = true;
  if (S.front) { S.front.close(); S.front = null; }
  if (S.php) { S.php.kill(); S.php = null; }
}

async function restart() {
  stop();
  await new Promise((r) => setTimeout(r, 300));
  await start();
}

function fail(message) {
  S.status = 'fehler';
  S.error = message;
  log('Fehler: ' + message);
  stop();
  push();
}

/* ---------- Zustand fürs Fenster ------------------------------------------------ */
function state() {
  const port = S.settings.port;
  const hosts = S.settings.lan ? lanAddresses() : [];
  const urls = [...hosts, 'localhost'].map((h) => 'https://' + h + ':' + port + '/');
  const main = urls[0];
  return {
    status: S.status,
    error: S.error,
    settings: S.settings,
    urls: urls,
    fingerprint: S.tls ? S.tls.fingerprint : '',
    data: FILES.data,
    config: FILES.config,
    version: app.getVersion(),
    // Zum Einfügen in %APPDATA%\SecureCom\config.json der Windows-App
    client: JSON.stringify({ api: main + 'api.php', web: main, fingerprint: S.tls ? S.tls.fingerprint : '' }, null, 2),
    log: S.log
  };
}

function push() {
  if (win && !win.isDestroyed()) win.webContents.send('host:state', state());
  if (tray) tray.setToolTip('SecureCom Server – ' + (S.status === 'läuft' ? 'läuft' : S.status === 'fehler' ? 'Fehler' : 'startet'));
}

ipcMain.handle('host:state', () => state());
ipcMain.handle('host:restart', () => restart());
ipcMain.handle('host:apply', async (event, wanted) => {
  const port = parseInt(wanted && wanted.port, 10);
  if (!(port >= 1024 && port <= 65535)) throw new Error('Port zwischen 1024 und 65535 wählen.');
  S.settings.port = port;
  S.settings.lan = !!(wanted && wanted.lan);
  S.settings.autostart = !!(wanted && wanted.autostart);
  saveSettings();
  applyAutostart();
  await restart();
  return state();
});
ipcMain.handle('host:copy', (event, text) => { clipboard.writeText(String(text || '')); });
ipcMain.handle('host:open', (event, what) => {
  if (what === 'data') return shell.openPath(FILES.data);
  if (what === 'config') return shell.openPath(FILES.config);
  if (what === 'client') return shell.openPath(path.join(app.getPath('appData'), 'SecureCom'));
  if (typeof what === 'string' && /^https:\/\/[^\s]+$/.test(what)) return shell.openExternal(what);
  return null;
});
ipcMain.handle('host:quit', () => { quitting = true; app.quit(); });

/* ---------- Autostart --------------------------------------------------------- */
function applyAutostart() {
  if (SMOKE || !PACKED) return;
  // Die portable Fassung entpackt sich bei jedem Start neu – dann zählt die Originaldatei.
  app.setLoginItemSettings({
    openAtLogin: S.settings.autostart,
    path: EXE,
    args: ['--hidden']
  });
}

/* ---------- Fenster und Infobereich ------------------------------------------- */
function createWindow(show) {
  win = new BrowserWindow({
    width: 780,
    height: 760,
    minWidth: 560,
    minHeight: 520,
    title: 'SecureCom Server',
    backgroundColor: '#0b0b0d',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0b0b0d', symbolColor: '#a2a2a7', height: 35 },
    icon: ICON,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      devTools: !PACKED
    }
  });
  // Symbol und „erneut starten“ der Taskleiste aus der bleibenden Programmdatei.
  if (process.platform === 'win32' && PACKED) {
    win.setAppDetails({
      appId: APP_ID,
      appIconPath: EXE,
      appIconIndex: 0,
      relaunchCommand: '"' + EXE + '"',
      relaunchDisplayName: 'SecureCom Server'
    });
  }
  win.once('ready-to-show', () => { if (SMOKE) win.showInactive(); else if (show) win.show(); });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  // Schließen heißt: im Hintergrund weiterlaufen. Beenden geht über den Infobereich.
  win.on('close', (event) => {
    if (quitting || SMOKE) return;
    event.preventDefault();
    win.hide();
    if (!S.hinted && tray) {
      S.hinted = true;
      tray.displayBalloon({ title: 'SecureCom Server läuft weiter', content: 'Beenden über das Symbol im Infobereich.', iconType: 'info' });
    }
  });
  win.loadFile(path.join(__dirname, 'window.html'));
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow(true);
  else { win.show(); win.focus(); }
}

function createTray() {
  tray = new Tray(ICON);   // .ico: Windows wählt die Größe passend zur Skalierung
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Fenster öffnen', click: showWindow },
    { label: 'Im Browser öffnen', click: () => shell.openExternal(state().urls.slice(-1)[0]) },
    { type: 'separator' },
    { label: 'Server beenden', click: () => { quitting = true; app.quit(); } }
  ]));
  tray.on('click', showWindow);
}

/* ---------- Start ------------------------------------------------------------ */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    loadSettings();
    if (SMOKE) {
      S.settings.port = await freePort();   // stört keinen laufenden Server
      S.settings.lan = false;               // nur lokal: keine Firewall-Rückfrage
    }
    if (!SMOKE) createTray();
    createWindow(!process.argv.includes('--hidden'));
    applyAutostart();
    await start();
    if (SMOKE) smoke().catch((e) => { console.error(e); app.exit(1); });
  });
  app.on('before-quit', () => { quitting = true; stop(); });
  app.on('window-all-closed', () => { /* läuft im Infobereich weiter */ });
}

/* ==========================================================================
   Selbsttest (npm run smoke:server): startet den Server mit eigenem Profil,
   prüft HTTPS, Sperren und Umleitung und macht ein Bild vom Fenster.
   SECURECOM_SMOKE_OUT bestimmt den Ordner für Ergebnis und Bild.
   ========================================================================== */
async function smoke() {
  const out = process.env.SECURECOM_SMOKE_OUT || app.getPath('temp');
  const lines = [];
  const check = (label, ok, detail) => lines.push((ok ? 'ok   ' : 'FAIL ') + label + (detail ? ' — ' + detail : ''));
  const port = S.settings.port;
  const ask = (opts, body) => new Promise((resolve) => {
    const mod = opts.plain ? http : https;
    // Wie die Windows-App: dem Zertifikat per Fingerabdruck vertrauen, nicht über eine Zertifizierungsstelle.
    const req = mod.request(Object.assign({ host: '127.0.0.1', port: port, rejectUnauthorized: false, servername: 'localhost' }, opts), (res) => {
      const peer = res.socket.getPeerCertificate ? res.socket.getPeerCertificate() : null;
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: text, fingerprint: peer && peer.fingerprint256 }));
    });
    req.on('error', (e) => resolve({ status: 0, text: e.message }));
    if (body) req.write(body);
    req.end();
  });

  check('Server läuft', S.status === 'läuft', S.error || '');
  const page = await ask({ path: '/' });
  check('Seite über HTTPS', page.status === 200 && page.text.includes('sc-boot'), 'HTTP ' + page.status + (page.status ? '' : ' ' + page.text));
  check('geliefertes Zertifikat = Fingerabdruck', page.fingerprint === S.tls.fingerprint);
  const api = await ask({ path: '/api.php', method: 'POST', headers: { 'Content-Type': 'application/json' } }, '{"a":"config"}');
  check('Schnittstelle antwortet', api.status === 200 && JSON.parse(api.text || '{}').ok === true);
  const lib = await ask({ path: '/lib/SecureCom.php' });
  check('lib/ gesperrt', lib.status === 404, 'HTTP ' + lib.status);
  const conf = await ask({ path: '/config.sample.php' });
  check('Einstellungen gesperrt', conf.status === 404, 'HTTP ' + conf.status);
  const redirect = await ask({ path: '/', plain: true, headers: { Host: 'localhost:' + port } });
  check('http:// leitet um', redirect.status === 301 && /^https:\/\/localhost:/.test(redirect.headers.location || ''), redirect.headers.location || '');
  check('Zertifikat mit Fingerabdruck', /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(S.tls.fingerprint));
  check('Daten außerhalb des Programms', fs.existsSync(path.join(FILES.data, 'app.key')) || fs.existsSync(path.join(FILES.data, 'ratelimit')));

  await new Promise((r) => setTimeout(r, 800));
  fs.writeFileSync(path.join(out, 'host-fenster.png'), (await win.webContents.capturePage()).toPNG());
  fs.writeFileSync(path.join(out, 'host-smoke.txt'), lines.join('\n') + '\n');
  quitting = true;
  stop();
  app.exit(lines.some((l) => l.startsWith('FAIL')) ? 1 : 0);
}
