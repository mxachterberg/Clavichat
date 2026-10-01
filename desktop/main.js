/* ==========================================================================
   SecureCom — Windows-App (Electron)
   --------------------------------------------------------------------------
   Dieselbe Oberfläche wie im Browser, mit einem Unterschied, der für die
   Sicherheit zählt: Der Programmcode steckt in der App. Vom Server kommen
   nur noch verschlüsselte Daten, nie Code – er kann der App also auch
   keinen veränderten Code unterschieben.

     app://securecom/        Oberfläche (aus der App, nicht vom Server)
     app://securecom/api     wird hier an den SecureCom-Server weitergereicht

   Server einstellen (optional): %APPDATA%\SecureCom\config.json
     { "server": "https://example.com" }   oder genauer
     { "api": "https://example.com/securecom/api.php",
       "web": "https://example.com/securecom/" }
   ========================================================================== */
'use strict';

const { app, BrowserWindow, Menu, desktopCapturer, ipcMain, net, protocol, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ORIGIN = 'app://securecom';
const DEFAULT_SERVER = 'https://achterberg.dev';
const SMOKE = process.argv.includes('--smoke');

// Im Paket liegen die Dateien unter assets/, beim Entwickeln in ../server.
const ASSETS = fs.existsSync(path.join(__dirname, 'assets'))
  ? path.join(__dirname, 'assets')
  : path.join(__dirname, '..', 'server', 'assets');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8'
};

// Nur eigene Skripte, keine fremden Server, nichts einbetten.
const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; " +
  "worker-src 'self' blob:; frame-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'";

protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true }
}]);

app.setAppUserModelId('dev.achterberg.securecom');   // Name in Windows-Benachrichtigungen
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');   // Klingeln ohne vorherigen Klick

let win = null;
let config = null;

/* ==========================================================================
   Einstellungen
   ========================================================================== */
function loadConfig() {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'config.json'), 'utf8'));
  } catch (e) { /* keine Datei: Standard */ }
  const server = String(process.env.SECURECOM_SERVER || file.server || DEFAULT_SERVER).replace(/\/+$/, '');
  const api = String(process.env.SECURECOM_API || file.api || server + '/app/securecom/api.php');
  const web = String(process.env.SECURECOM_WEB || file.web || server + '/app/securecom/').replace(/\/?$/, '/');
  for (const value of [api, web]) {
    const u = new URL(value);
    // Unverschlüsselt nur zum Testen auf dem eigenen Rechner.
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname))) {
      throw new Error('Der SecureCom-Server muss per https erreichbar sein: ' + value);
    }
  }
  return { api: api, web: web };
}

/* ==========================================================================
   app://securecom – Oberfläche ausliefern, API weiterreichen
   ========================================================================== */
function respond(body, status, headers) {
  return new Response(body, { status: status || 200, headers: Object.assign({ 'X-Content-Type-Options': 'nosniff' }, headers || {}) });
}

function json(data, status) {
  return respond(JSON.stringify(data), status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
}

function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function serveFile(file, base, extraHeaders) {
  // Nie aus dem eigenen Ordner heraus.
  const resolved = path.resolve(file);
  if (!resolved.startsWith(path.resolve(base) + path.sep)) return respond('Nicht gefunden', 404);
  try {
    let data = await fs.promises.readFile(resolved);
    const type = MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream';
    const headers = Object.assign({ 'Content-Type': type, 'Cache-Control': 'no-cache' }, extraHeaders || {});
    if (type.indexOf('text/html') === 0) {
      headers['Content-Security-Policy'] = CSP;
      headers['Referrer-Policy'] = 'no-referrer';
      data = data.toString('utf8').replace(/\{\{WEB_URL\}\}/g, escapeAttr(config.web));
    }
    return respond(data, 200, headers);
  } catch (e) {
    return respond('Nicht gefunden', 404);
  }
}

/** Die Oberfläche spricht nur mit app://securecom/api – hier geht es weiter zum Server. */
async function proxyApi(request) {
  if (request.method !== 'POST') return json({ ok: false, error: 'Nur POST.' }, 405);
  const headers = { 'Content-Type': 'application/json' };
  const token = request.headers.get('x-sc-token');
  if (token) headers['X-SC-Token'] = token;
  let body = '';
  try { body = await request.text(); } catch (e) { /* leer */ }
  try {
    const res = await net.fetch(config.api, { method: 'POST', headers: headers, body: body, redirect: 'error', cache: 'no-store' });
    return respond(await res.text(), res.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  } catch (e) {
    return json({ ok: false, error: 'Keine Verbindung zum SecureCom-Server.' }, 502);
  }
}

async function handleApp(request) {
  const url = new URL(request.url);
  if (url.host !== 'securecom') return respond('Nicht gefunden', 404);
  const p = decodeURIComponent(url.pathname);
  if (p === '/api') return proxyApi(request);
  if (p === '/' || p === '/index.html') return serveFile(path.join(__dirname, 'app.html'), __dirname);
  if (['/picker.html', '/picker.js', '/picker.css'].includes(p)) return serveFile(path.join(__dirname, p.slice(1)), __dirname);
  if (p.indexOf('/assets/') === 0) return serveFile(path.join(ASSETS, p.slice(8)), ASSETS, { 'Cache-Control': 'max-age=31536000' });
  return respond('Nicht gefunden', 404);
}

/* ==========================================================================
   Rechte: Mikrofon, Kamera, Bildschirm, Benachrichtigungen – nur für uns
   ========================================================================== */
const ALLOWED = new Set(['media', 'display-capture', 'notifications', 'clipboard-sanitized-write', 'fullscreen']);

function isOurs(url) {
  return typeof url === 'string' && (url === ORIGIN || url.indexOf(ORIGIN + '/') === 0);
}

function setupSession() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(ALLOWED.has(permission) && isOurs((details && details.requestingUrl) || wc.getURL()));
  });
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin) => ALLOWED.has(permission) && isOurs(requestingOrigin));

  // Bildschirm teilen: eigene Auswahl (Windows hat keine eingebaute).
  ses.setDisplayMediaRequestHandler((request, callback) => {
    if (!isOurs(request.securityOrigin)) { callback({}); return; }
    chooseSource(request.audioRequested).then((choice) => callback(choice || {}), () => callback({}));
  });
}

/* ---------- Auswahl: welcher Bildschirm, welches Fenster? ------------------- */
let pendingPick = null;

ipcMain.on('picker:choose', (event, choice) => {
  if (!pendingPick || event.sender !== pendingPick.window.webContents) return;
  pendingPick.finish(choice && typeof choice.id === 'string' ? choice : null);
});

async function chooseSource(audioRequested) {
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } });
  const list = describeSources(sources);
  const choice = await openPicker(list, audioRequested);
  if (!choice) return null;
  const source = sources.find((s) => s.id === choice.id);
  if (!source) return null;
  const streams = { video: source };
  // Systemton (nur Windows): wenn gewünscht und vom Gegenüber angefragt.
  if (audioRequested && choice.audio && process.platform === 'win32') streams.audio = 'loopback';
  return streams;
}

/** Für die Auswahl: Bildschirme auf Deutsch benennen ("Entire screen" kommt von Windows). */
function describeSources(sources) {
  const screens = sources.filter((s) => s.id.indexOf('screen:') === 0);
  return sources.map((s) => {
    const isScreen = s.id.indexOf('screen:') === 0;
    return {
      id: s.id,
      name: isScreen ? (screens.length > 1 ? 'Bildschirm ' + (screens.indexOf(s) + 1) : 'Ganzer Bildschirm') : s.name,
      screen: isScreen,
      thumb: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : ''
    };
  });
}

function openPicker(list, audioRequested) {
  if (pendingPick) pendingPick.finish(null);
  return new Promise((resolve) => {
    const picker = new BrowserWindow({
      parent: win || undefined,
      modal: !!win,
      width: 820,
      height: 600,
      minWidth: 520,
      minHeight: 420,
      title: 'Bildschirm teilen',
      backgroundColor: '#0b0b0d',
      autoHideMenuBar: true,
      show: false,
      webPreferences: { preload: path.join(__dirname, 'picker-preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false }
    });
    let done = false;
    const finish = (choice) => {
      if (done) return;
      done = true;
      pendingPick = null;
      resolve(choice);
      if (!picker.isDestroyed()) picker.close();
    };
    pendingPick = { window: picker, finish: finish };
    picker.on('closed', () => finish(null));
    picker.webContents.once('did-finish-load', () => picker.webContents.send('picker:sources', { list: list, audio: !!audioRequested }));
    picker.once('ready-to-show', () => picker.show());
    picker.loadURL(ORIGIN + '/picker.html');
  });
}

/* ==========================================================================
   Hauptfenster
   ========================================================================== */
function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 380,
    minHeight: 560,
    title: 'SecureCom',
    backgroundColor: '#0b0b0d',
    autoHideMenuBar: true,
    show: false,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
      devTools: !app.isPackaged
    }
  });
  // Beim Selbsttest ohne Fokus anzeigen – Bildschirmfotos brauchen ein gezeichnetes Fenster.
  win.once('ready-to-show', () => { if (SMOKE) win.showInactive(); else win.show(); });
  win.on('focus', () => win.flashFrame(false));
  win.on('closed', () => { win = null; });

  // Links öffnen im Standardbrowser, nie in der App.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isOurs(url)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  // Rechtsklick: Ausschneiden, Kopieren, Einfügen, Rechtschreibung.
  win.webContents.on('context-menu', (event, params) => {
    const items = [];
    for (const word of params.dictionarySuggestions || []) {
      items.push({ label: word, click: () => win.webContents.replaceMisspelling(word) });
    }
    if (items.length) items.push({ type: 'separator' });
    if (params.isEditable) {
      items.push({ label: 'Ausschneiden', role: 'cut', enabled: params.editFlags.canCut });
      items.push({ label: 'Kopieren', role: 'copy', enabled: params.editFlags.canCopy });
      items.push({ label: 'Einfügen', role: 'paste', enabled: params.editFlags.canPaste });
      items.push({ type: 'separator' });
      items.push({ label: 'Alles auswählen', role: 'selectAll' });
    } else if (params.selectionText) {
      items.push({ label: 'Kopieren', role: 'copy' });
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });

  win.loadURL(ORIGIN + '/');
  if (SMOKE) smoke().catch((e) => { console.error(e); app.exit(1); });
}

ipcMain.on('securecom:focus', (event) => {
  if (!win || event.sender !== win.webContents) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

ipcMain.on('securecom:attention', (event) => {
  if (win && event.sender === win.webContents && !win.isFocused()) win.flashFrame(true);
});

/* ==========================================================================
   Start
   ========================================================================== */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    try {
      config = loadConfig();
    } catch (e) {
      const { dialog } = require('electron');
      dialog.showErrorBox('SecureCom', e.message);
      app.quit();
      return;
    }
    protocol.handle('app', handleApp);
    setupSession();
    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
}

/* ==========================================================================
   Selbsttest (npm run smoke): startet, legt eine temporäre Sitzung an,
   prüft die Bildschirmauswahl und macht Bildschirmfotos.
   SECURECOM_SMOKE_OUT bestimmt den Ordner für Ergebnis und Bilder.
   ========================================================================== */
async function smoke() {
  const out = process.env.SECURECOM_SMOKE_OUT || app.getPath('temp');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const run = (code) => win.webContents.executeJavaScript(code, true);
  const shot = async (wc, name) => fs.writeFileSync(path.join(out, name + '.png'), (await wc.capturePage()).toPNG());
  const lines = [];
  const check = (label, ok, detail) => lines.push((ok ? 'ok   ' : 'FAIL ') + label + (detail ? ' — ' + detail : ''));

  win.setSize(1280, 820);
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  await wait(3500);
  check('Ladebildschirm fertig', await run("document.getElementById('sc-boot').classList.contains('is-done')"));
  check('Anmeldung sichtbar', await run("!document.getElementById('sc-gate').hidden"));
  check('kein Inline-Skript', (await run("document.querySelectorAll('script:not([src])').length")) === 0);
  await shot(win.webContents, 'smoke-1-start');

  await run("document.querySelector('#sc-gate-card input[type=text]').value = 'Windows-App'; document.querySelector('#sc-gate-card button[type=submit]').click(); true");
  await wait(4500);
  check('temporäre Sitzung über den Server', await run("!document.getElementById('sc').hidden"),
    await run("document.getElementById('sc-user').innerText.replace(/\\n/g, ' | ')"));
  check('Brücke zur App vorhanden', await run("typeof window.securecomDesktop === 'object' && typeof window.securecomDesktop.focus === 'function'"));
  check('Benachrichtigungen erlaubt', (await run('Notification.permission')) === 'granted');
  await shot(win.webContents, 'smoke-2-app');

  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } });
  check('Bildschirmquellen gefunden', sources.length > 0, sources.length + ' Quellen');
  const picking = openPicker(describeSources(sources).slice(0, 6), true);
  await wait(2500);
  if (pendingPick) {
    await shot(pendingPick.window.webContents, 'smoke-3-auswahl');
    pendingPick.finish(null);
  }
  check('Auswahlfenster abbrechbar', (await picking) === null);

  // Aufräumen: temporäre Sitzung beenden (löscht sie auch auf dem Server).
  await run("(async () => { const b = [...document.querySelectorAll('#sc-user button')].find((x) => x.title === 'Einstellungen'); b.click(); await new Promise((r) => setTimeout(r, 300)); [...document.querySelectorAll('#sc-modal-panel button')].find((x) => x.textContent.includes('Sitzung beenden')).click(); await new Promise((r) => setTimeout(r, 300)); [...document.querySelectorAll('#sc-modal-panel button')].find((x) => x.textContent.trim() === 'Beenden').click(); return true; })()");
  await wait(2500);

  fs.writeFileSync(path.join(out, 'smoke.txt'), lines.join('\n') + '\n');
  app.exit(lines.some((l) => l.indexOf('FAIL') === 0) ? 1 : 0);
}
