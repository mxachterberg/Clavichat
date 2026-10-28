/* ==========================================================================
   Clavichat — Windows-App (Electron)
   --------------------------------------------------------------------------
   Dieselbe Oberfläche wie im Browser, mit einem Unterschied, der für die
   Sicherheit zählt: Der Programmcode steckt in der App. Vom Server kommen
   nur noch verschlüsselte Daten, nie Code – er kann der App also auch
   keinen veränderten Code unterschieben.

     app://securecom/        Oberfläche (aus der App, nicht vom Server)
     app://securecom/api     wird hier an den Clavichat-Server weitergereicht
   (Intern heißt die Oberfläche weiter securecom – daran hängen gespeicherte
   Anmeldungen und Einstellungen aus der Zeit, als die App SecureCom hieß.)

   Server einstellen (optional): %APPDATA%\Clavichat\config.json
   (wer schon SecureCom benutzt hat: %APPDATA%\SecureCom\config.json)
     { "server": "https://example.com" }   oder genauer
     { "api": "https://example.com/clavichat/api.php",
       "web": "https://example.com/clavichat/" }
   ========================================================================== */
'use strict';

const { app, BrowserWindow, Menu, Tray, desktopCapturer, ipcMain, nativeImage, net, powerMonitor, protocol, safeStorage, session, shell } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const updater = require('./updater');

const ORIGIN = 'app://securecom';
// Offizieller Server. Einladungs- und Meeting-Links zeigen auf die Startseite
// (https://clavichat.de/#…), die API liegt unter /app/clavichat/.
const DEFAULT_SERVER = 'https://clavichat.de';
const SMOKE = process.argv.includes('--smoke');

// Der Selbsttest bekommt ein eigenes Profil: Er stört keine laufende App
// (eigene Einzelinstanz-Sperre) und lässt die echten Einstellungen in Ruhe.
// Verdeckt ihn ein Vollbildfenster (etwa ein Video), soll er trotzdem
// zeichnen – sonst sind Bildschirmfotos veraltet.
if (SMOKE) {
  app.setPath('userData', path.join(app.getPath('temp'), 'Clavichat-Selbsttest'));
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
}

// Bis Oktober 2026 hieß die App SecureCom. Wer sie schon benutzt, behält
// Anmeldung und Einstellungen: Gibt es den alten Profilordner und noch
// keinen neuen, bleibt es beim alten.
if (!SMOKE && !app.commandLine.hasSwitch('user-data-dir')) {
  const legacy = path.join(app.getPath('appData'), 'SecureCom');
  if (fs.existsSync(legacy) && !fs.existsSync(app.getPath('userData'))) app.setPath('userData', legacy);
}

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

// Die portable Fassung entpackt sich bei jedem Start in einen Temp-Ordner,
// der beim Beenden verschwindet. Taskleiste und Anheften sollen auf die
// Datei zeigen, die bleibt.
const PORTABLE = process.env.PORTABLE_EXECUTABLE_FILE || '';
const EXE = PORTABLE || process.execPath;
// Kennung für Taskleiste und Benachrichtigungen. Nur die installierte App
// nimmt appId aus package.json – die schreibt der Installer an seine
// Verknüpfungen. Gibt es eine Verknüpfung mit derselben Kennung, nimmt
// Windows deren Symbol, auch für die portable Fassung; ist sie kaputt (etwa
// nach dem Deinstallieren), zeigt die Taskleiste ein leeres Blatt. Deshalb
// bekommen portable Fassung, Selbsttest und Entwicklung je eine eigene.
const APP_ID = 'dev.achterberg.clavichat' +
  (SMOKE ? '.selbsttest' : !app.isPackaged ? '.dev' : PORTABLE ? '.portable' : '');
const ICON = path.join(__dirname, 'build', 'icon.ico');

app.setAppUserModelId(APP_ID);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');   // Klingeln ohne vorherigen Klick

let win = null;
let config = null;

/* Beim Schließen in den Infobereich (Einstellung je Gerät): Das X versteckt
   das Fenster, Clavichat läuft weiter – Nachrichten und Anrufe kommen an.
   Zurück per Klick auf das Symbol, beenden über dessen Menü. */
let tray = null;
let quitting = false;
const windowPrefs = { tray: false };
function prefsFile() { return path.join(app.getPath('userData'), 'window.json'); }
function loadWindowPrefs() {
  try { windowPrefs.tray = JSON.parse(fs.readFileSync(prefsFile(), 'utf8')).tray === true; } catch (e) { /* Standard: aus */ }
}
/* window.json hält beides: tray (hier) und die Farben der Titelleiste (chrome,
   unten). Jede Änderung liest die Datei, setzt ihre eigenen Felder und
   schreibt sie zurück – nacheinander, damit sich zwei Änderungen nicht
   gegenseitig überschreiben (früher ging dabei tray oder die Farbe verloren). */
let prefsWrite = Promise.resolve();
function saveWindowJson(fields) {
  prefsWrite = prefsWrite.then(async () => {
    let saved = {};
    try { saved = JSON.parse(await fs.promises.readFile(prefsFile(), 'utf8')); } catch (e) { /* noch keine Datei */ }
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {};
    await fs.promises.writeFile(prefsFile(), JSON.stringify(Object.assign(saved, fields)));
  }).catch(() => { /* nächstes Mal */ });
  return prefsWrite;
}
function saveWindowPrefs() {
  saveWindowJson({ tray: windowPrefs.tray });
}
function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
/* Logo aus den Einstellungen der Oberfläche (LOGO, je Gerät): Fenster,
   Taskleiste und Infobereich zeigen es, solange die App läuft – die
   Oberfläche schickt es bei jedem Start neu (nur wenn nicht der Standard).
   null = wieder das eingebaute Symbol. Programmdatei und Installer behalten
   build/icon.ico; die eigenen Verknüpfungen der installierten App zeigen
   dagegen auf die .ico im Datenordner (setTaskbarIcon → updateShortcuts),
   also auch auf das gewählte Logo. */
let customIcon = null;

/* Taskleiste: Windows nimmt das Symbol aus appIconPath (setAppDetails), nicht
   aus win.setIcon – und die Programmdatei behält nach kleinen Updates ihr
   altes Symbol. Deshalb liegt das Symbol als eigene .ico im Datenordner:
   beim Start das eingebaute aus dieser App-Fassung, nach einer Logo-Wahl
   das gewählte. Der Dateiname enthält eine Prüfsumme, weil Windows Symbole
   je Pfad zwischenspeichert. */
function icoFromImage(img) {
  // Klassisches ICO: kleine Größen als 32-Bit-Bitmap (liest jeder Teil von
  // Windows), 256 px als PNG wie in build/icon.ico.
  const sizes = [16, 20, 24, 32, 40, 48, 64, 256];
  const parts = sizes.map((px) => {
    const small = img.resize({ width: px, height: px, quality: 'best' });
    if (px >= 256) return small.toPNG();
    const bgra = small.toBitmap();                    // BGRA, Zeilen von oben
    const row = px * 4;
    const maskRow = Math.ceil(px / 32) * 4;            // 1-Bit-Maske, auf 32 Bit aufgefüllt
    const out = Buffer.alloc(40 + row * px + maskRow * px);
    out.writeUInt32LE(40, 0);                          // BITMAPINFOHEADER
    out.writeInt32LE(px, 4);
    out.writeInt32LE(px * 2, 8);                       // Höhe doppelt: Bild + Maske
    out.writeUInt16LE(1, 12);
    out.writeUInt16LE(32, 14);
    out.writeUInt32LE(row * px + maskRow * px, 20);
    for (let y = 0; y < px; y++) {                     // Bitmaps stehen auf dem Kopf
      bgra.copy(out, 40 + (px - 1 - y) * row, y * row, (y + 1) * row);
    }
    return out;                                        // Maske bleibt 0 – der Alphakanal zählt
  });
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(sizes.length, 4);
  let off = head.length;
  sizes.forEach((px, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(px >= 256 ? 0 : px, e);
    head.writeUInt8(px >= 256 ? 0 : px, e + 1);
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(parts[i].length, e + 8);
    head.writeUInt32LE(off, e + 12);
    off += parts[i].length;
  });
  return Buffer.concat([head].concat(parts));
}
function writeTaskbarIco(data) {
  try {
    const dir = app.getPath('userData');
    const name = 'taskbar-' + require('crypto').createHash('sha256').update(data).digest('hex').slice(0, 12) + '.ico';
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) fs.writeFileSync(file, data);
    // Ältere Fassungen wegräumen
    for (const f of fs.readdirSync(dir)) {
      if (/^taskbar-[0-9a-f]{12}\.ico$/.test(f) && f !== name) fs.rmSync(path.join(dir, f), { force: true });
    }
    return file;
  } catch (e) {
    return null;     // dann eben das Symbol der Programmdatei
  }
}
/* Windows zeigt in der Taskleiste das Symbol der Startmenü-Verknüpfung, die
   zur App gehört – nicht das Fenstersymbol. Nach kleinen Updates zeigt die
   aber noch auf das alte Symbol in der Programmdatei. Darum die eigenen
   Verknüpfungen (Startmenü, Desktop, angeheftet) auf die .ico umstellen –
   nur die, die genau auf diese Programmdatei zeigen. */
function updateShortcuts(ico) {
  // Selbsttest: nie echte Verknüpfungen des Nutzers anfassen.
  if (!ico || PORTABLE || SMOKE) return;
  const exe = path.resolve(EXE).toLowerCase();
  const places = [
    path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Clavichat.lnk'),
    path.join(app.getPath('desktop'), 'Clavichat.lnk'),
    path.join(app.getPath('appData'), 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar', 'Clavichat.lnk')
  ];
  for (const lnk of places) {
    try {
      if (!fs.existsSync(lnk)) continue;
      const cur = shell.readShortcutLink(lnk);
      if (!cur.target || path.resolve(cur.target).toLowerCase() !== exe) continue;
      if (cur.icon && path.resolve(cur.icon).toLowerCase() === path.resolve(ico).toLowerCase()) continue;
      shell.writeShortcutLink(lnk, 'update', { icon: ico, iconIndex: 0 });
    } catch (e) { /* Verknüpfung bleibt, wie sie ist */ }
  }
}

function setTaskbarIcon() {
  if (!win || process.platform !== 'win32' || !app.isPackaged) return;
  let file = null;
  try {
    file = writeTaskbarIco(customIcon ? icoFromImage(customIcon) : fs.readFileSync(ICON));
  } catch (e) { /* Programmdatei */ }
  // Symbol und „erneut starten“ für die Taskleiste. Ohne feste Angaben merkt
  // sich Windows den Temp-Ordner der portablen Fassung, und ein angehefteter
  // Knopf zeigt nach dem Beenden nur ein leeres Blatt.
  updateShortcuts(file);
  win.setAppDetails({
    appId: APP_ID,
    appIconPath: file || EXE,
    appIconIndex: 0,
    relaunchCommand: '"' + EXE + '"',
    relaunchDisplayName: 'Clavichat'
  });
}

function trayImage() {
  if (!customIcon) return ICON;
  const img = nativeImage.createEmpty();
  for (const [scaleFactor, px] of [[1, 16], [1.25, 20], [1.5, 24], [2, 32]]) {
    img.addRepresentation({ scaleFactor: scaleFactor, buffer: customIcon.resize({ width: px, height: px, quality: 'best' }).toPNG() });
  }
  return img;
}
function updateTray() {
  if (windowPrefs.tray && !tray && !SMOKE) {
    tray = new Tray(trayImage());
    tray.setToolTip('Clavichat');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Clavichat öffnen', click: showWindow },
      { type: 'separator' },
      { label: 'Beenden', click: () => { quitting = true; app.quit(); } }
    ]));
    tray.on('click', showWindow);
  } else if (!windowPrefs.tray && tray) {
    tray.destroy();
    tray = null;
  }
}

/* ---------- Titelleiste in den Farben der Oberfläche ------------------------
   Die Leiste selbst ist Teil der Seite (window.css), Windows zeichnet nur
   noch die drei Knöpfe. preload.js meldet die Farben, sobald Hell/Dunkel
   feststeht oder wechselt. Gemerkt für den nächsten Start. */
const TITLEBAR_H = 36;   // wie --nav-h in window.css
let chrome = { color: '#0b0b0d', symbolColor: '#a2a2a7' };

function isColor(value) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}

function loadChrome() {
  try {
    const saved = JSON.parse(fs.readFileSync(prefsFile(), 'utf8'));
    if (isColor(saved.color) && isColor(saved.symbolColor)) chrome = { color: saved.color, symbolColor: saved.symbolColor };
  } catch (e) { /* erster Start: dunkel */ }
}

/** Ein Pixel niedriger als die Leiste: Ihre untere Linie läuft unter den Knöpfen weiter. */
function overlay() {
  return { color: chrome.color, symbolColor: chrome.symbolColor, height: TITLEBAR_H - 1 };
}

ipcMain.on('securecom:chrome', (event, colors) => {
  if (!event.senderFrame || !isOurs(event.senderFrame.url)) return;
  if (!colors || !isColor(colors.color) || !isColor(colors.symbolColor)) return;
  const next = { color: colors.color.toLowerCase(), symbolColor: colors.symbolColor.toLowerCase() };
  if (next.color === chrome.color && next.symbolColor === chrome.symbolColor) return;
  chrome = next;
  for (const w of BrowserWindow.getAllWindows()) {
    w.setTitleBarOverlay(overlay());
    w.setBackgroundColor(chrome.color);
  }
  saveWindowJson({ color: chrome.color, symbolColor: chrome.symbolColor });   // tray bleibt erhalten
});

/* ==========================================================================
   Einstellungen
   ========================================================================== */
function loadConfig() {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'config.json'), 'utf8'));
  } catch (e) { /* keine Datei: Standard */ }
  const server = String(process.env.SECURECOM_SERVER || file.server || DEFAULT_SERVER).replace(/\/+$/, '');
  const api = String(process.env.SECURECOM_API || file.api || server + '/app/clavichat/api.php');
  const web = String(process.env.SECURECOM_WEB || file.web || (server === DEFAULT_SERVER ? server + '/' : server + '/app/clavichat/')).replace(/\/?$/, '/');
  for (const value of [api, web]) {
    const u = new URL(value);
    // Unverschlüsselt nur zum Testen auf dem eigenen Rechner.
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname))) {
      throw new Error('Der Clavichat-Server muss per https erreichbar sein: ' + value);
    }
  }
  // Eigener Server mit selbst erstelltem Zertifikat (Clavichat Server):
  // genau diesem vertrauen – erkannt am SHA-256-Fingerabdruck.
  const pin = process.env.SECURECOM_FINGERPRINT || file.fingerprint || '';
  const fingerprint = normalizeFingerprint(pin);
  if (pin && !fingerprint) throw new Error('Der Fingerabdruck in der config.json ist ungültig (64 Hex-Zeichen, gern mit Doppelpunkten).');
  return { api: api, web: web, fingerprint: fingerprint };
}

function normalizeFingerprint(value) {
  const hex = String(value || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  return hex.length === 64 ? hex.match(/.{2}/g).join(':') : '';
}

/**
 * Zertifikat des eigenen Servers per Fingerabdruck annehmen. Alle anderen
 * Zertifikate prüft Chromium wie immer – auch beim selben Server: Passt
 * der Fingerabdruck nicht, gilt die normale Prüfung (und die scheitert bei
 * einem fremden, selbst erstellten Zertifikat).
 */
function pinCertificate() {
  if (!config.fingerprint) return;
  const host = new URL(config.api).hostname.replace(/^\[|\]$/g, '');
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    let fp = '';
    try { fp = new crypto.X509Certificate(request.certificate.data).fingerprint256; } catch (e) { /* unlesbar */ }
    callback(request.hostname === host && fp === config.fingerprint ? 0 : -3);
  });
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
    const why = String((e && e.message) || '') + ' ' + String((e && e.cause && e.cause.message) || '');
    if (/CERT|certificate/i.test(why)) {
      return json({ ok: false, error: config.fingerprint
        ? 'Das Zertifikat des Servers passt nicht zum Fingerabdruck in der config.json.'
        : 'Das Zertifikat des Servers ist ungültig. Bei einem eigenen Server den Fingerabdruck in die config.json eintragen.' }, 502);
    }
    return json({ ok: false, error: 'Keine Verbindung zum Clavichat-Server.' }, 502);
  }
}

async function handleApp(request) {
  const url = new URL(request.url);
  if (url.host !== 'securecom') return respond('Nicht gefunden', 404);
  const p = decodeURIComponent(url.pathname);
  if (p === '/api') return proxyApi(request);
  if (p === '/' || p === '/index.html') return serveFile(path.join(__dirname, 'app.html'), __dirname);
  if (['/window.css', '/picker.html', '/picker.js', '/picker.css'].includes(p)) return serveFile(path.join(__dirname, p.slice(1)), __dirname);
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
      height: 640,
      minWidth: 560,
      minHeight: 460,
      title: 'Bildschirm teilen',
      backgroundColor: chrome.color,
      titleBarStyle: 'hidden',
      titleBarOverlay: overlay(),
      minimizable: false,
      maximizable: false,
      autoHideMenuBar: true,
      show: false,
      icon: ICON,
      webPreferences: { preload: path.join(__dirname, 'picker-preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, devTools: !app.isPackaged }
    });
    // Die Auswahl zeigt nur picker.html: keine anderen Seiten, keine neuen Fenster.
    picker.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    // (loadURL unten löst will-navigate nicht aus – jede andere Navigation ist fremd.)
    picker.webContents.on('will-navigate', (event) => event.preventDefault());
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
    // Im Selbsttest ohne Fokus – er soll niemanden aus dem Vordergrund holen.
    picker.once('ready-to-show', () => (SMOKE ? picker.showInactive() : picker.show()));
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
    title: 'Clavichat',
    backgroundColor: chrome.color,
    titleBarStyle: 'hidden',          // eigene Leiste aus window.css …
    titleBarOverlay: overlay(),       // … Windows zeichnet nur die Knöpfe
    autoHideMenuBar: true,
    show: false,
    icon: ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
      devTools: !app.isPackaged
    }
  });
  // Taskleiste: Symbol aus dieser App-Fassung, Neustart über die bleibende Programmdatei
  setTaskbarIcon();
  // Beim Selbsttest ohne Fokus anzeigen – Bildschirmfotos brauchen ein gezeichnetes Fenster.
  win.once('ready-to-show', () => { if (SMOKE) win.showInactive(); else win.show(); });
  win.on('focus', () => win.flashFrame(false));
  win.on('close', (event) => {
    if (quitting || !windowPrefs.tray || SMOKE) return;
    event.preventDefault();
    win.hide();
  });
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

// Einstellung „Beim Schließen in den Infobereich“
ipcMain.handle('securecom:window', (event, op, value) => {
  if (!win || event.sender !== win.webContents) return null;
  if (op === 'tray') {
    windowPrefs.tray = !!value;
    saveWindowPrefs();
    updateTray();
  }
  return { tray: windowPrefs.tray };
});

// Logo-Wahl (Einstellungen → LOGO): PNG als Data-URL, höchstens 512 × 512.
// Nur vom eigenen Fenster und nur PNG – alles andere wird ignoriert. Breite
// und Höhe stehen im PNG-Kopf (IHDR) und werden VOR dem Dekodieren geprüft:
// Ein kleines PNG kann sonst riesige Maße angeben (Speicher). Dasselbe Bild
// noch einmal: nichts tun. Höchstens ein neues Bild je Sekunde – schnellere
// Wechsel sammeln sich, das letzte gilt nach Ablauf der Sekunde.
const ICON_URL_MAX = 256 * 1024;
const ICON_MIN_GAP = 1000;
let iconLast = { hash: 'null', at: 0 };
let iconQueued = null;   // { hash, img } – wartet auf ICON_MIN_GAP
function pngSize(buf) {
  // Signatur, dann der erste Block: Länge 13, Typ IHDR, Breite, Höhe (Big Endian)
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  if (buf.readUInt32BE(8) !== 13 || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
function applyIcon(hash, img) {
  iconLast = { hash: hash, at: Date.now() };
  customIcon = img;
  if (!win || win.isDestroyed()) return;
  win.setIcon(customIcon || ICON);
  setTaskbarIcon();
  if (tray) tray.setImage(trayImage());
}
ipcMain.handle('securecom:icon', (event, dataUrl) => {
  if (!win || event.sender !== win.webContents || !event.senderFrame || !isOurs(event.senderFrame.url)) return false;
  if (dataUrl !== null && (typeof dataUrl !== 'string' || dataUrl.length > ICON_URL_MAX)) return false;
  const hash = dataUrl === null ? 'null' : require('crypto').createHash('sha256').update(dataUrl).digest('hex');
  if (hash === (iconQueued ? iconQueued.hash : iconLast.hash)) return true;   // schon gesetzt bzw. vorgemerkt
  let img = null;
  if (dataUrl !== null) {
    if (!/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(dataUrl)) return false;
    const head = pngSize(Buffer.from(dataUrl.slice(22, 22 + 64), 'base64'));
    if (!head || !head.width || head.width > 512 || head.height > 512 || head.width !== head.height) return false;
    img = nativeImage.createFromDataURL(dataUrl);
    const size = img.getSize();
    if (img.isEmpty() || size.width > 512 || size.height > 512 || size.width !== size.height) return false;
  }
  const wait = ICON_MIN_GAP - (Date.now() - iconLast.at);
  if (wait <= 0 && !iconQueued) { applyIcon(hash, img); return true; }
  if (!iconQueued) {
    setTimeout(() => { const q = iconQueued; iconQueued = null; if (q && q.hash !== iconLast.hash) applyIcon(q.hash, q.img); }, Math.max(wait, 0));
  }
  iconQueued = { hash: hash, img: img };
  return true;
});

ipcMain.on('securecom:attention', (event) => {
  if (win && event.sender === win.webContents && !win.isFocused()) win.flashFrame(true);
});

// Bildschirmfotos und Aufnahmen anderer Programme verhindern (Einstellung je
// Gerät): Windows zeigt das Fenster dann schwarz (SetWindowDisplayAffinity).
ipcMain.on('securecom:protect', (event, on) => {
  if (win && event.sender === win.webContents) win.setContentProtection(!!on);
});

// Für „abwesend“: zählt Maus und Tastatur am ganzen Rechner, nicht nur im
// Fenster – wer in einer anderen App arbeitet, ist nicht abwesend.
ipcMain.handle('securecom:idle', (event) => {
  if (!win || event.sender !== win.webContents) return -1;
  return powerMonitor.getSystemIdleTime();
});

// Gespeicherte Anmeldung an das Windows-Konto binden (safeStorage = DPAPI):
// Eine Kopie des Profils lässt sich auf einem anderen Rechner oder unter
// einem anderen Windows-Konto nicht öffnen. null = geht hier nicht.
ipcMain.handle('securecom:secure', (event, op, text) => {
  if (!win || event.sender !== win.webContents) return null;
  if (typeof text !== 'string' || text.length > 200000) return null;
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    if (op === 'seal') return safeStorage.encryptString(text).toString('base64');
    if (op === 'open') return safeStorage.decryptString(Buffer.from(text, 'base64'));
  } catch (e) { /* gehört zu einem anderen Windows-Konto oder ist beschädigt */ }
  return null;
});

/** App-Sperre: Windows wird gesperrt oder geht schlafen. */
function lockWindow() {
  if (win && !win.isDestroyed()) win.webContents.send('securecom:lock');
}

/* ==========================================================================
   Start
   ========================================================================== */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  // Updates und „Beenden“ im Infobereich schließen wirklich.
  app.on('before-quit', () => { quitting = true; });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    try {
      config = loadConfig();
    } catch (e) {
      const { dialog } = require('electron');
      dialog.showErrorBox('Clavichat', e.message);
      app.quit();
      return;
    }
    protocol.handle('app', handleApp);
    setupSession();
    pinCertificate();
    loadChrome();
    loadWindowPrefs();
    createWindow();
    updateTray();
    updater.init({ getWindow: () => win, smoke: SMOKE });
    powerMonitor.on('lock-screen', lockWindow);
    powerMonitor.on('suspend', lockWindow);
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
  // Warten, bis etwas eintritt – feste Zeiten reichen nicht, wenn Windows die
  // frisch gebaute Datei gerade prüft und alles langsamer läuft.
  const until = async (code, ms) => {
    for (let t = 0; t < ms; t += 250) {
      if (await run(code)) return true;
      await wait(250);
    }
    return false;
  };
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
  const started = await until("!document.getElementById('sc').hidden && !!document.querySelector('#sc-user button')", 20000);
  await wait(500);
  check('temporäre Sitzung über den Server', started,
    await run("document.getElementById('sc-user').innerText.replace(/\\n/g, ' | ')"));
  if (!started) {
    await shot(win.webContents, 'smoke-2-ohne-sitzung');
    fs.writeFileSync(path.join(out, 'smoke.txt'), lines.join('\n') + '\n');
    app.exit(1);
    return;
  }
  check('Brücke zur App vorhanden', await run("typeof window.securecomDesktop === 'object' && typeof window.securecomDesktop.focus === 'function'"));
  const upd = await run('window.securecomDesktop.updates.get()');
  check('Updates: Stand abrufbar', !!upd && upd.version === app.getVersion(), upd ? upd.version + ' · ' + (upd.mode || 'ohne Selbst-Update') + ' · ' + upd.status : '');
  check('Benachrichtigungen erlaubt', (await run('Notification.permission')) === 'granted');
  await shot(win.webContents, 'smoke-2-app');

  // Titelleiste: Foto des ganzen Fensters – capturePage sähe die Windows-Knöpfe nicht.
  const frame = async (w, name) => {
    const list = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1600, height: 1100 } });
    const own = list.find((s) => s.id === w.getMediaSourceId());
    if (own) fs.writeFileSync(path.join(out, name + '.png'), own.thumbnail.toPNG());
    return !!own;
  };
  check('Titelleiste im App-Stil', await run("!!document.querySelector('.sc-titlebar') && !!(navigator.windowControlsOverlay && navigator.windowControlsOverlay.visible)"));
  check('Fensterfoto mit Windows-Knöpfen', await frame(win, 'smoke-2b-fenster'));
  await run("document.documentElement.setAttribute('data-theme', 'light'); true");
  await wait(800);
  check('Knöpfe folgen Hell/Dunkel', chrome.color === '#f6f6f4', chrome.color);
  await frame(win, 'smoke-2c-hell');
  await run("document.documentElement.setAttribute('data-theme', 'dark'); true");
  await wait(500);
  check('Qualität in den Einstellungen', await run("(async () => { const b = [...document.querySelectorAll('#sc-user button')].find((x) => x.title === 'Einstellungen'); b.click(); await new Promise((r) => setTimeout(r, 300)); const names = [...document.querySelectorAll('#sc-modal-panel .sc-choice-opt .sc-choice-name')].map((n) => n.textContent); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return names.includes('Flüssig') && names.indexOf('Sparsam') < names.indexOf('Quelle'); })()"));

  // Bildschirmschutz: Der Schalter in den Einstellungen setzt die Anzeige-Sperre von Windows.
  const toggleShield = "(async () => { const b = [...document.querySelectorAll('#sc-user button')].find((x) => x.title === 'Einstellungen'); b.click(); await new Promise((r) => setTimeout(r, 300)); const box = [...document.querySelectorAll('#sc-modal-panel label.sc-check')].find((l) => l.textContent.includes('Bildschirmfotos')); if (box) box.querySelector('input').click(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return !!box; })()";
  const shieldFound = await run(toggleShield);
  await wait(300);
  const shieldOn = win.isContentProtected();
  await run(toggleShield);
  await wait(300);
  const shieldOff = win.isContentProtected();
  check('Bildschirmschutz umschaltbar', shieldFound && shieldOn && !shieldOff, String(shieldOn) + ' → ' + String(shieldOff));

  // Gespeicherte Anmeldung: an das Windows-Konto gebunden (DPAPI).
  check('Anmeldung an das Windows-Konto gebunden', (await run("window.securecomDesktop.secure.seal('clavichat').then((s) => s && window.securecomDesktop.secure.open(s))")) === 'clavichat');

  // App-Sperre: PIN festlegen, Sperren von Windows nachstellen, entsperren, wieder entfernen.
  const inSettings = (steps) => "(async () => { const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const btn = (t) => [...document.querySelectorAll('#sc-modal-panel button')].find((x) => x.textContent === t); [...document.querySelectorAll('#sc-user button')].find((x) => x.title === 'Einstellungen').click(); await sleep(300); " + steps + " })()";
  const pinSet = await run(inSettings("btn('PIN festlegen').click(); await sleep(300); const ins = document.querySelectorAll('#sc-modal-panel input[type=password]'); ins[0].value = ins[1].value = '4711'; btn('Festlegen').click(); for (let i = 0; i < 40 && !document.getElementById('sc-modal').hidden; i++) await sleep(250); return !!localStorage.getItem('sc-lock');"));
  lockWindow();
  const lockedUp = await until("!!document.getElementById('sc-lockscreen')", 3000);
  await shot(win.webContents, 'smoke-2d-gesperrt');
  const unlocked = lockedUp && await run("(async () => { const i = document.querySelector('#sc-lockscreen input'); i.value = '4711'; document.querySelector('#sc-lockscreen form').requestSubmit(); for (let n = 0; n < 40 && document.getElementById('sc-lockscreen'); n++) await new Promise((r) => setTimeout(r, 250)); return !document.getElementById('sc-lockscreen'); })()");
  check('App-Sperre beim Sperren von Windows', pinSet && lockedUp && unlocked, [pinSet, lockedUp, unlocked].join(' → '));
  const unset = await run(inSettings("btn('Sperre entfernen').click(); await sleep(300); document.querySelector('#sc-modal-panel input[type=password]').value = '4711'; btn('Sperre entfernen').click(); for (let i = 0; i < 40 && !document.getElementById('sc-modal').hidden; i++) await sleep(250); return !localStorage.getItem('sc-lock');"));
  check('App-Sperre wieder entfernt', unset);

  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } });
  check('Bildschirmquellen gefunden', sources.length > 0, sources.length + ' Quellen');
  const picking = openPicker(describeSources(sources).slice(0, 6), true);
  await wait(2500);
  if (pendingPick) {
    const pk = pendingPick.window;
    await shot(pk.webContents, 'smoke-3-auswahl');
    await frame(pk, 'smoke-3b-auswahl-fenster');
    // Das Auswahlfenster legt die Qualität dort ab, wo das Hauptfenster sie liest.
    check('Qualitätsauswahl im Auswahlfenster', (await pk.webContents.executeJavaScript("document.querySelectorAll('#pk-quality .pk-choice-opt').length", true)) === 6);
    const before = await run("localStorage.getItem('sc-screen-quality')");
    await pk.webContents.executeJavaScript("localStorage.setItem('sc-screen-quality', 'smooth'); true", true);
    await wait(500);
    check('Qualität kommt im Hauptfenster an', (await run("localStorage.getItem('sc-screen-quality')")) === 'smooth');
    await run(before === null ? "localStorage.removeItem('sc-screen-quality'); true" : 'localStorage.setItem(\'sc-screen-quality\', ' + JSON.stringify(before) + '); true');
    pendingPick.finish(null);
  }
  check('Auswahlfenster abbrechbar', (await picking) === null);

  // Aufräumen: temporäre Sitzung beenden (löscht sie auch auf dem Server).
  await run("(async () => { const b = [...document.querySelectorAll('#sc-user button')].find((x) => x.title === 'Einstellungen'); b.click(); await new Promise((r) => setTimeout(r, 300)); [...document.querySelectorAll('#sc-modal-panel button')].find((x) => x.textContent.includes('Sitzung beenden')).click(); await new Promise((r) => setTimeout(r, 300)); [...document.querySelectorAll('#sc-modal-panel button')].find((x) => x.textContent.trim() === 'Beenden').click(); return true; })()");
  await wait(2500);

  fs.writeFileSync(path.join(out, 'smoke.txt'), lines.join('\n') + '\n');
  app.exit(lines.some((l) => l.indexOf('FAIL') === 0) ? 1 : 0);
}
