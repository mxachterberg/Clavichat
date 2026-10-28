/* ==========================================================================
   Clavichat — Oberfläche, Nachrichten, Räume und Anrufe
   --------------------------------------------------------------------------
   Aufbau wie bei Discord: links die Räume, daneben Unterhaltungen bzw.
   Kanäle, in der Mitte der Verlauf (mit Anruf darüber), rechts Mitglieder
   oder Profil. Die Verschlüsselung selbst steckt in securecom-core.js.

   Der Server ist ein Briefkasten: Der Browser fragt alle ein, zwei Sekunden
   nach (kein WebSocket auf dem Webhosting). Anrufe laufen per WebRTC direkt
   zwischen den Geräten – über den Server gehen nur die signierten und
   verschlüsselten Verbindungsangaben.
   ========================================================================== */

// Die Kryptografie (securecom-core.js samt OpenPGP.js) lädt boot() nach –
// ohne Import-Map, die nicht jeder Browser kennt. Alles, was C benutzt,
// läuft erst danach.
let C = null;

// Wo der Server steht und unter welcher Adresse Einladungslinks aufgehen.
// Die Website setzt nichts (Standard), ein eigener Server oder die
// Windows-App tragen beides am <script>-Tag ein (data-api, data-web).
const SCRIPT   = document.getElementById('sc-script');
const API_URL  = (SCRIPT && SCRIPT.dataset.api) || '/app/clavichat/api.php';
const WEB_URL  = (SCRIPT && SCRIPT.dataset.web) || (location.origin + '/app/clavichat/');
const DESKTOP  = window.securecomDesktop || null;   // nur in der Windows-App
// Wo ein temporärer Schlüssel lebt – im Browser-Tab oder in der laufenden App.
const KEY_HOME = DESKTOP ? 'solange die App läuft' : 'in diesem Tab';
// Wo Schlüssel entstehen und Passwörter bleiben.
const LOCAL    = DESKTOP ? 'in der App' : 'im Browser';
const SS_KEY   = 'securecom.session';
const JOIN_KEY = 'securecom.join';
// Gäste eines Einmal-Meetings: ihr Link (für „Erneut beitreten“) und der Hinweis nach dem Ende.
const GUEST_LINK_KEY = 'securecom.guest-link';
const GUEST_END_KEY  = 'securecom.guest-end';
const SLOTS    = ['mic', 'cam', 'screen', 'screenAudio'];
const SLOT_KIND = { mic: 'audio', cam: 'video', screen: 'video', screenAudio: 'audio' };

/* ==========================================================================
   Zustand
   ========================================================================== */
// Start der App (ms): Ereignisse im Verlauf danach sind „frisch“ (Meldungen nur dafür).
const APP_START = Date.now();

const S = {
  cfg: null,
  token: null,
  me: null,            // { id, kind, name, fp, priv, pub, armored, vis }
  mode: null,          // 'temp' | 'account'
  guest: false,        // Gast eines Einmal-Meetings (temporär): sieht nur sein Meeting
  meetOnly: false,     // Gastgeber eines Meetings von der Startseite: ebenfalls nur das Meeting (ohne Gast-Grenzen beim Server)
  meetRid: null,       // das eine Meeting von Gast bzw. Gastgeber
  guestWait: false,    // Gast wartet, bis der Gastgeber den Beitritt bestätigt
  closingMeeting: null, // Meeting, das man gerade selbst beendet (für den Hinweis danach)
  wrapKey: null,       // Konten: packt Schlüssel und Tresor ein
  username: null,
  vault: null,
  vv: 1,               // Tresor-Version beim Server
  ids: new Map(),      // Kennung -> Identität (Schlüssel geprüft, Karte signiert)
  keyringCache: null,
  online: [],          // temporäre Sitzungen, die gerade online und sichtbar sind
  fst: new Map(),      // Freunde: Kennung -> { status: 'on' | 'busy' | 'away' | 'off' }
  hiddenScreens: new Set(),   // Bildschirm-Übertragungen, die ich ausgeblendet habe (Kennung des Senders)
  pv: '',
  convs: new Map(),    // Gegenüber -> Unterhaltung
  rooms: new Map(),    // Raumkennung -> Raum
  roomKeys: new Map(), // "rid:epoch" -> CryptoKey
  cursor: { s: 0, o: 0, g: 0 },
  cursorLoaded: false,
  view: { kind: 'home' },
  call: null,          // Direktanruf
  voice: null,         // Sprachkanal eines Raums
  pendingJoin: null,
  polling: false,
  wake: null,
  fastUntil: 0,
  netFail: 0,
  offline: false,
  membersOpen: window.matchMedia('(min-width: 1180px)').matches,
  rotating: new Set()
};

/* ==========================================================================
   Kleine Helfer
   ========================================================================== */
const $ = (id) => document.getElementById(id);

function el(tag, attrs) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), v);
      else if (v === true) node.setAttribute(k, '');
      else node.setAttribute(k, v);
    }
  }
  for (let i = 2; i < arguments.length; i++) {
    const c = arguments[i];
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

const ICONS = {
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="1"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>',
  unlock: '<rect x="5" y="10.5" width="14" height="10" rx="1"/><path d="M8 10.5V7a4 4 0 0 1 7.7-1.5"/>',
  radio: '<path d="M9.5 9V2.5M15 9V7"/><path d="M9.5 3h3M9.5 6h2.2"/><rect x="6" y="9" width="12" height="13" rx="2"/><path d="M9.5 13h5M9.5 16h5M12 19h.01"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="1"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5L5 20"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>',
  video: '<rect x="3" y="6" width="13" height="12" rx="1"/><path d="M16 10l5-3v10l-5-3z"/>',
  // Meetings (Knopf MEET, Meeting-Karten, Startseite): eine Gruppe – die Kamera bleibt beim Video-Anruf
  group: '<circle cx="12" cy="8" r="3"/><path d="M6.5 19.5a5.5 5.5 0 0 1 11 0"/><circle cx="5.5" cy="10" r="2.2"/><path d="M1.8 18.5a3.9 3.9 0 0 1 3.7-3.4"/><circle cx="18.5" cy="10" r="2.2"/><path d="M22.2 18.5a3.9 3.9 0 0 0-3.7-3.4"/>',
  bolt: '<path d="M13 2.5L4.5 13.5h6.5l-1 8 8.5-11h-6.5z"/>',
  // API-Zugang (Beiträge per Skript)
  code: '<path d="M8 7l-5 5 5 5M16 7l5 5-5 5M13.5 4.5l-3 15"/>',
  videoOff: '<rect x="3" y="6" width="13" height="12" rx="1"/><path d="M16 10l5-3v10l-5-3z"/><path d="M2 2l20 20"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  micOff: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/><path d="M3 3l18 18"/>',
  head: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4" height="6" rx="1"/><rect x="17" y="14" width="4" height="6" rx="1"/>',
  headOff: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4" height="6" rx="1"/><rect x="17" y="14" width="4" height="6" rx="1"/><path d="M3 3l18 18"/>',
  screen: '<rect x="3" y="4" width="18" height="12" rx="1"/><path d="M8 20h8M12 16v4"/>',
  screenOff: '<rect x="3" y="4" width="18" height="12" rx="1"/><path d="M8 20h8M12 16v4"/><path d="M3 3l18 18"/>',
  hangup: '<path d="M3 15.5c5-4.7 13-4.7 18 0l-2.2 2.6-3.6-1.6.3-2.4a11 11 0 0 0-5 0l.3 2.4-3.6 1.6z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3M14 9l2 2"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7"/><path d="M18.5 14.5A6.5 6.5 0 0 1 21.5 20"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrowUp: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  arrowDown: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  hash: '<path d="M5 9h15M4 15h15M10 3L8 21M16 3l-2 18"/>',
  speaker: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="1"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
  shieldCheck: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  edit: '<path d="M4 20h4l11-11-4-4L4 16z"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  logout: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  crown: '<path d="M4 17l-1-10 5 4 4-6 4 6 5-4-1 10z"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>',
  moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16"/><path d="M20 20v-4h-4"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/>',
  leave: '<path d="M14 4H6v16h8M17 8l4 4-4 4M21 12H10"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path d="M3 3l18 18"/>',
  userPlus: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M19 8v6M16 11h6"/>',
  userMinus: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 11h6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  message: '<path d="M4 5h16v11H9l-5 4z"/>',
  mobile: '<rect x="7" y="3" width="10" height="18" rx="1.5"/><path d="M11 17.5h2"/>',
  clip: '<path d="M20 11.5l-8 8a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8"/>',
  file: '<path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5"/>',
  camSwitch: '<path d="M3 8h3.5L8 5.5h8L17.5 8H21v11H3z"/><path d="M8.6 12.6a3.5 3.5 0 0 1 6.2-1.4"/><path d="M15.4 14.4a3.5 3.5 0 0 1-6.2 1.4"/><path d="M15.2 9.4v2h-2M8.8 17.6v-2h2"/>',
  // Ränge (Raum-Menü)
  tag: '<path d="M3.5 12.5V4h8.5l9 9-8.5 8.5z"/><circle cx="8" cy="8.5" r="1.4"/>',
  // Reagieren: Gesicht mit Plus
  react: '<circle cx="10.5" cy="13.5" r="7.5"/><path d="M7.6 15.6a3.6 3.6 0 0 0 5.8 0M8 11.6v.4M13 11.6v.4"/><path d="M19.5 2.5v5M17 5h5"/>'
};

/* ---------- Logo ---------------------------------------------------------------
   Eine Quelle für alle Stellen: Knopf oben links (#sc-home), logoMark(), das
   Favicon im Browser-Tab und – in der Windows-App – Fenster-, Taskleisten- und
   Infobereich-Symbol. Wählbar je Gerät (localStorage sc-logo), Standard ist
   das Funkgerät (a). Das Programmsymbol (desktop/scripts/make-icon.js →
   build/icon.ico) und server/assets/securecom-icon.svg zeigen immer a.
   fit: Die klassische Fassung sitzt enger in ihrem viewBox und wird dafür etwas
   kleiner gezeichnet, damit alle Varianten gleich groß wirken. */
const LOGO_KEY = 'sc-logo';
const LOGO_DEFAULT = 'a';
const LOGOS = {
  a: { label: 'Funkgerät', viewBox: '0 0 64 64', svg: '<rect x="20" y="9" width="6" height="14" rx="3" fill="#3a3a40"/><rect x="35" y="2" width="6" height="21" fill="#c2410c"/><rect x="41" y="5" width="5" height="4" fill="#c2410c"/><rect x="41" y="12" width="3.5" height="4" fill="#c2410c"/><rect x="13" y="20" width="38" height="42" rx="6" fill="#2a2a2f"/><rect x="21" y="29" width="22" height="3.5" rx="1.75" fill="#121214"/><rect x="21" y="36" width="22" height="3.5" rx="1.75" fill="#121214"/><rect x="21" y="43" width="22" height="3.5" rx="1.75" fill="#121214"/><circle cx="32" cy="53.5" r="3.5" fill="#c2410c"/>' },
  b: { label: 'Kachel', viewBox: '0 0 64 64', svg: '<rect width="64" height="64" rx="12" fill="#18181b"/><rect x="21" y="25" width="22" height="31" rx="4" fill="#c2410c"/><rect x="33.5" y="7" width="5" height="19" fill="#c2410c"/><rect x="38.5" y="9.5" width="4" height="3.5" fill="#c2410c"/><rect x="38.5" y="15.5" width="3" height="3.5" fill="#c2410c"/><rect x="26" y="32" width="12" height="3" rx="1.5" fill="#18181b"/><rect x="26" y="38" width="12" height="3" rx="1.5" fill="#18181b"/><circle cx="32" cy="48" r="2.8" fill="#18181b"/>' },
  c: { label: 'Sprechblase', viewBox: '0 0 64 64', svg: '<path d="M10 6h44a6 6 0 0 1 6 6v32a6 6 0 0 1-6 6H26l-12 10v-10h-4a6 6 0 0 1-6-6V12a6 6 0 0 1 6-6z" fill="#2a2a2f"/><circle cx="32" cy="22" r="7" fill="#c2410c"/><path d="M28.5 26h7l2 14h-11z" fill="#c2410c"/>' },
  // C, das unten rechts in einen Schlüssel ausläuft
  d: { label: 'Monogramm', viewBox: '0 0 64 64', svg: '<rect width="64" height="64" rx="12" fill="#18181b"/><path d="M44 16.5A17.5 17.5 0 1 0 44 45.5H58" fill="none" stroke="#c2410c" stroke-width="8"/><rect x="47" y="49" width="4" height="6.5" fill="#c2410c"/><rect x="53.5" y="49" width="4" height="4.5" fill="#c2410c"/>' },
  // Bis Oktober 2026 der Standard: durchsichtig, Funkgerät innen dunkel, helle Linien mit dunklem Rand
  classic: { label: 'Klassisch', viewBox: '7.3 5.5 49.4 49.4', fit: 0.94, svg: '<path d="M27 26V8.5M38 26V21.5" fill="none" stroke="#0b0b0d" stroke-width="5.8" stroke-linecap="round"/><rect x="20" y="26" width="24" height="26" rx="4" fill="#0b0b0d" stroke="#0b0b0d" stroke-width="5.8"/><rect x="27.4" y="6.8" width="9" height="13.4" rx="1.2" fill="#0b0b0d"/><path d="M28.6 8h6.6v4h-2.6v3h2.6v4h-6.6z" fill="#f97316"/><path d="M27 26V8.5M38 26V21.5" fill="none" stroke="#ededec" stroke-width="3.4" stroke-linecap="round"/><rect x="20" y="26" width="24" height="26" rx="4" fill="none" stroke="#ededec" stroke-width="3.4"/><path d="M26.5 33.5h11M26.5 39h11" fill="none" stroke="#ededec" stroke-width="3" stroke-linecap="round"/><circle cx="32" cy="46" r="2.6" fill="#f97316"/>' }
};
const HOME_LOGO = 34;   // Größe im Knopf oben links (44 × 44)

function logoChoice() {
  let id = null;
  try { id = localStorage.getItem(LOGO_KEY); } catch (e) { /* privater Modus */ }
  return id && Object.prototype.hasOwnProperty.call(LOGOS, id) ? id : LOGO_DEFAULT;
}

function logoSvg(id, size) {
  const logo = LOGOS[id] || LOGOS[LOGO_DEFAULT];
  const px = Math.round(size * (logo.fit || 1));
  return '<svg width="' + px + '" height="' + px + '" viewBox="' + logo.viewBox + '" aria-hidden="true">' + logo.svg + '</svg>';
}

/** Das Logo als eigenständige SVG-Datei (Favicon, Symbol der Windows-App). */
function logoDataUrl(id, size) {
  const logo = LOGOS[id] || LOGOS[LOGO_DEFAULT];
  return 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"' +
    (size ? ' width="' + size + '" height="' + size + '"' : '') + ' viewBox="' + logo.viewBox + '">' + logo.svg + '</svg>');
}

/** Logo als Symbol im Text; mit id immer diese Variante (Vorschau in den Einstellungen). */
function logoMark(size, id) {
  const span = document.createElement('span');
  span.className = 'sc-ic sc-logo';
  span.setAttribute('aria-hidden', 'true');
  span.dataset.size = size;
  if (id) span.dataset.logo = id;
  span.innerHTML = logoSvg(id || logoChoice(), size);
  return span;
}

/** Zeichnet die SVG per Canvas als PNG (für Fenster und Infobereich der Windows-App). */
function logoPng(id, size) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        canvas.getContext('2d').drawImage(img, 0, 0, size, size);
        resolve(canvas.toDataURL('image/png'));
      } catch (e) { reject(e); }
    };
    img.onerror = () => reject(new Error('Logo ließ sich nicht zeichnen.'));
    img.src = logoDataUrl(id, size);
  });
}

let logoShown = LOGO_DEFAULT;   // was Favicon und App-Symbol gerade zeigen

/** Gewähltes Logo überall einsetzen. Beim Start mit dem Standard bleiben Favicon und App-Symbol, wie sie sind. */
function applyLogo(id) {
  const home = $('sc-home');
  if (home) {
    const box = document.createElement('span');
    box.innerHTML = logoSvg(id, HOME_LOGO);
    const old = home.querySelector('svg');
    if (old) old.replaceWith(box.firstChild); else home.prepend(box.firstChild);
  }
  document.querySelectorAll('.sc-logo:not([data-logo])').forEach((span) => {
    span.innerHTML = logoSvg(id, Number(span.dataset.size) || 18);
  });
  if (id === logoShown) return;
  logoShown = id;
  let link = document.querySelector('link[rel~="icon"]');
  if (!link) link = document.head.appendChild(el('link', { rel: 'icon' }));
  link.type = 'image/svg+xml';
  link.href = logoDataUrl(id);
  // Windows-App: Fenster, Taskleiste und Infobereich (Programmdatei und Installer bleiben beim Funkgerät)
  if (DESKTOP && DESKTOP.window && DESKTOP.window.setIcon) {
    (id === LOGO_DEFAULT ? DESKTOP.window.setIcon(null) : logoPng(id, 256).then((png) => DESKTOP.window.setIcon(png))).catch(() => {});
  }
}

function setLogo(id) {
  if (!Object.prototype.hasOwnProperty.call(LOGOS, id)) return;
  try { localStorage.setItem(LOGO_KEY, id); } catch (e) { /* gilt bis zum Neuladen */ }
  applyLogo(id);
}

applyLogo(logoChoice());

function icon(name, size) {
  const s = size || 18;
  const span = document.createElement('span');
  span.className = 'sc-ic';
  span.setAttribute('aria-hidden', 'true');
  // Nur feste, eigene Zeichen – nie Daten von außen.
  span.innerHTML = '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + ICONS[name] + '</svg>';
  return span;
}

/* ---------- Reaktionen ---------------------------------------------------------
   Eigene Symbole im Strichstil der App (24er-Raster wie ICONS), jedes mit
   einer dezenten eigenen Farbe (--rx-<id> in securecom.css, hell und dunkel).
   Eine Reaktion ist ein verschlüsselter Eintrag wie Bearbeiten/Löschen:
   { t: 'react', ref: Nachricht, r: Symbol, on: true|false }. Ältere Apps
   (bis 1.8.8) kennen t 'react' nicht und übergehen ihn still. Die Kennungen
   nie ändern – sie stehen in den Nachrichten. */
const REACTIONS = [
  { id: 'up', label: 'Daumen hoch', svg: '<path d="M7 10.5V20H3.5v-9.5z"/><path class="f" d="M7 11l3.4-7a1.8 1.8 0 0 1 3.3 1.5L12.8 9.5h5.7a2 2 0 0 1 2 2.4l-1.3 6.4a2 2 0 0 1-2 1.7H7z"/>' },
  { id: 'down', label: 'Daumen runter', svg: '<g transform="rotate(180 12 12)"><path d="M7 10.5V20H3.5v-9.5z"/><path class="f" d="M7 11l3.4-7a1.8 1.8 0 0 1 3.3 1.5L12.8 9.5h5.7a2 2 0 0 1 2 2.4l-1.3 6.4a2 2 0 0 1-2 1.7H7z"/></g>' },
  { id: 'heart', label: 'Herz', svg: '<path class="f" d="M12 20s-8-4.6-8-10.3A4.4 4.4 0 0 1 12 7a4.4 4.4 0 0 1 8 2.7C20 15.4 12 20 12 20z"/>' },
  { id: 'laugh', label: 'Lachen', svg: '<circle class="f" cx="12" cy="12" r="9"/><path d="M7.6 10.3c.7-1.2 2-1.2 2.7 0M13.7 10.3c.7-1.2 2-1.2 2.7 0"/><path d="M7.5 13.4h9a4.5 4.5 0 0 1-9 0z"/>' },
  { id: 'wow', label: 'Staunen', svg: '<circle class="f" cx="12" cy="12" r="9"/><path d="M7.8 7.4c.8-.7 1.9-.7 2.7 0M13.5 7.4c.8-.7 1.9-.7 2.7 0"/><path d="M9.2 10.2v.6M14.8 10.2v.6"/><circle cx="12" cy="15.4" r="2.1"/>' },
  { id: 'sad', label: 'Traurig', svg: '<circle class="f" cx="12" cy="12" r="9"/><path d="M9 9.8v.6M15 9.8v.6"/><path d="M8.6 16.6a4.4 4.4 0 0 1 6.8 0"/><path d="M16.6 12.2c-.7 1-1 1.6-1 2a1 1 0 0 0 2 0c0-.4-.3-1-1-2z"/>' },
  { id: 'fire', label: 'Feuer', svg: '<path class="f" d="M12 21.5c-3.9 0-7-2.7-7-6.6 0-3.6 2.7-5.8 3.9-9.4 1.7 1.5 2.4 3.2 2.4 5 1-.8 1.6-2 1.6-3.4 3 2.1 5.1 5 5.1 7.8 0 3.9-2.9 6.6-6 6.6z"/><path d="M12 21.5c-1.7 0-3-1.2-3-2.9 0-1.7 1.4-2.6 2.2-4.3 1.6 1.2 3.8 2.6 3.8 4.4 0 1.6-1.3 2.8-3 2.8z"/>' },
  { id: 'check', label: 'Erledigt', svg: '<circle class="f" cx="12" cy="12" r="9"/><path d="M7.8 12.3l2.9 2.9 5.6-6"/>' },
  { id: 'rocket', label: 'Rakete', svg: '<path class="f" d="M12 2.5c3.5 2.5 5 6.5 4.5 11.5h-9C7 9 8.5 5 12 2.5z"/><circle cx="12" cy="9" r="1.8"/><path d="M7.5 14L5 17.5h3.5M16.5 14l2.5 3.5h-3.5M10 17.5l2 3.5 2-3.5"/>' },
  { id: 'eyes', label: 'Augen', svg: '<ellipse class="f" cx="8" cy="12" rx="3.6" ry="5.4"/><ellipse class="f" cx="16" cy="12" rx="3.6" ry="5.4"/><circle class="p" cx="9.2" cy="13.2" r="1.3"/><circle class="p" cx="17.2" cy="13.2" r="1.3"/>' },
  { id: 'party', label: 'Party', svg: '<path class="f" d="M3.5 20.5l4.3-11.4 7.1 7.1z"/><path d="M6 14l4 4M12.6 4.4c.7 1.3.3 2.6-.8 3.4M19.6 11.4c-1.3-.7-2.6-.3-3.4.8"/><path d="M15.6 3.6v.01M20.4 8.4v.01M17.6 6.4l2-2M9.6 3.8l-.5-1.4M21.6 14.2l-1.4-.5"/>' },
  { id: 'star', label: 'Stark', svg: '<path class="f" d="M12 3l2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 16.8l-5.4 2.9 1.1-6.1-4.5-4.2 6.1-.8z"/>' }
];
const REACT_IDS = new Set(REACTIONS.map((r) => r.id));
const REACT_MAX = 20;   // verschiedene Reaktionen je Nachricht (mehr zeigt die App nicht an)

/** Reaktionssymbol in seiner Farbe (nur eigene, feste Zeichen). */
function reactIcon(id, size) {
  const r = REACTIONS.find((x) => x.id === id);
  const s = size || 18;
  const span = document.createElement('span');
  span.className = 'sc-ic sc-rx';
  span.dataset.rx = id;
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + (r ? r.svg : '') + '</svg>';
  return span;
}

/** Wie append(), überspringt aber null (append() würde "null" schreiben). */
function appendAll(parent) {
  for (let i = 1; i < arguments.length; i++) {
    const c = arguments[i];
    if (c !== null && c !== undefined && c !== false) parent.append(c);
  }
  return parent;
}

function iconBtn(name, title, onclick, extra) {
  return el('button', Object.assign({ type: 'button', class: 'sc-ibtn', title: title, 'aria-label': title, onclick: onclick }, extra || {}), icon(name));
}

function pad2(n) { return String(n).padStart(2, '0'); }

function fmtTime(ts) {
  const d = new Date(ts);
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

function dayKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
}

function fmtDay(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (dayKey(ts) === dayKey(today.getTime())) return 'Heute';
  if (dayKey(ts) === dayKey(yesterday.getTime())) return 'Gestern';
  return pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) + '.' + d.getFullYear();
}

function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return (h ? h + ':' + pad2(m) : m) + ':' + pad2(s % 60);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function cleanText(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, max || 8000);
}

/**
 * Namen (Anzeige-, Raum-, Kanal-, Rang-, Zugangsnamen): ohne Steuerzeichen,
 * ohne Bidi-Steuerzeichen (U+200E/F, U+202A–202E, U+2066–2069 – sie drehen
 * die Leserichtung und lassen einen Namen wie einen anderen aussehen) und
 * ohne unsichtbare Zeichen (U+200B–200D, U+2060, U+FEFF – zwei gleich
 * aussehende Namen).
 */
const NAME_INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;
function cleanName(value) {
  return cleanText(value, 200).replace(NAME_INVISIBLE, '').slice(0, 40).replace(/\s+/g, ' ').trim();
}

/** Name für temporäre Sitzungen ohne eigenen Alias, etwa „Nebelluchs“. */
const NAME_A = ['Nacht', 'Nebel', 'Sturm', 'Stern', 'Wald', 'Berg', 'Fluss', 'Schatten', 'Funken', 'Eis',
  'Mond', 'Sonnen', 'Wind', 'Regen', 'Feuer', 'Moor', 'Fels', 'Silber', 'Kupfer', 'Morgen'];
const NAME_B = ['falke', 'fuchs', 'luchs', 'rabe', 'wolf', 'otter', 'kauz', 'dachs', 'igel', 'hirsch',
  'marder', 'biber', 'adler', 'specht', 'reiher', 'bär', 'kranich', 'uhu', 'hase', 'elch'];
function randomAlias() {
  const r = crypto.getRandomValues(new Uint32Array(2));
  return NAME_A[r[0] % NAME_A.length] + NAME_B[r[1] % NAME_B.length];
}

/** Text mit anklickbaren Links – ohne HTML, nur Textknoten und <a>. */
function linkify(text) {
  const frag = document.createDocumentFragment();
  const re = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/gi;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
    frag.appendChild(el('a', { href: m[0], target: '_blank', rel: 'noopener noreferrer nofollow', text: m[0] }));
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  return frag;
}

/* ---------- Meldungen ---------------------------------------------------- */
function toast(message, kind, ms) {
  const box = el('div', { class: 'sc-toast' + (kind ? ' sc-toast--' + kind : ''), text: message });
  $('sc-toasts').appendChild(box);
  const life = ms || (kind === 'error' ? 6000 : 3800);
  setTimeout(() => box.classList.add('is-out'), life);
  setTimeout(() => box.remove(), life + 600);
}

/* ---------- Dialoge ------------------------------------------------------ */
let modalClose = null;

/**
 * Einfacher Dialog. build(body, close) füllt den Inhalt; actions: Knöpfe
 * unten ({ label, primary, danger, onClick(close) }).
 */
function openModal(opts) {
  closeModal();
  const panel = $('sc-modal-panel');
  panel.textContent = '';
  panel.className = 'sc-modal-panel tickbox' + (opts.wide ? ' sc-modal-panel--wide' : '');
  const head = el('div', { class: 'sc-modal-head' },
    el('p', { class: 'section-head' }, el('span', { class: 'sq' }), el('span', { class: 'label', text: opts.title }), el('span', { class: 'rule' })),
    iconBtn('x', 'Schließen', () => close()));
  const body = el('div', { class: 'sc-modal-body' });
  panel.append(head, body);
  function close() {
    if (modalClose !== close) return;
    modalClose = null;
    $('sc-modal').hidden = true;
    panel.textContent = '';
    if (opts.onClose) opts.onClose();
  }
  modalClose = close;
  if (opts.build) opts.build(body, close);
  if (opts.actions && opts.actions.length) {
    const foot = el('div', { class: 'sc-modal-foot' });
    for (const a of opts.actions) {
      const b = el('button', {
        type: 'button',
        class: 'btn' + (a.primary ? ' btn--primary' : '') + (a.danger ? ' sc-btn--danger' : ''),
        text: a.label
      });
      b.addEventListener('click', () => a.onClick(close, b));
      foot.appendChild(b);
    }
    panel.appendChild(foot);
  }
  $('sc-modal').hidden = false;
  const first = panel.querySelector('input, textarea, select, .btn--primary');
  if (first && opts.focus !== false) setTimeout(() => first.focus(), 30);
  return close;
}

function closeModal() {
  if (modalClose) modalClose();
}

function confirmBox(title, text, okLabel, danger) {
  return new Promise((resolve) => {
    let done = false;
    openModal({
      title: title,
      build: (body) => body.appendChild(el('p', { class: 'sc-p', text: text })),
      onClose: () => { if (!done) resolve(false); },
      actions: [
        { label: 'Abbrechen', onClick: (close) => close() },
        { label: okLabel || 'OK', primary: !danger, danger: !!danger, onClick: (close) => { done = true; close(); resolve(true); } }
      ]
    });
  });
}

function field(label, input, note, extra) {
  return el('label', { class: 'field' },
    el('span', { class: 'field-label', text: label }),
    input,
    extra || null,
    note ? el('span', { class: 'sc-field-note', text: note }) : null);
}

/* ---------- Passwortstärke ----------------------------------------------------
   Aus dem Passwort entsteht der Schlüssel, der den privaten Schlüssel
   einpackt. Wer die Daten des Servers stiehlt, kann offline raten – deshalb
   muss ein neues Passwort mindestens „okay“ sein (C.passwordStrength). */
const PW_LABELS = ['sehr schwach', 'schwach', 'okay', 'stark', 'sehr stark'];
const PW_MIN_SCORE = 2;

/* ---------- Schutz vor Bildschirmfotos (nur Windows-App) --------------------
   Je Gerät gemerkt; die App setzt dafür die Anzeige-Sperre von Windows. */
const PROTECT_KEY = 'sc-protect';

function protectingContent() {
  try { return localStorage.getItem(PROTECT_KEY) === '1'; } catch (e) { return false; }
}

function setProtectContent(on) {
  try { localStorage.setItem(PROTECT_KEY, on ? '1' : '0'); } catch (e) { /* gilt bis zum Neustart */ }
  if (DESKTOP && DESKTOP.protect) DESKTOP.protect(on);
}

if (DESKTOP && DESKTOP.protect && protectingContent()) DESKTOP.protect(true);

function strengthMeter(input, hints) {
  const bar = el('span', { class: 'sc-pw-bar', 'aria-hidden': 'true' }, el('span'), el('span'), el('span'), el('span'));
  const label = el('span', { class: 'sc-pw-label' });
  const tip = el('span', { class: 'sc-pw-tip' });
  const box = el('span', { class: 'sc-pw' }, el('span', { class: 'sc-pw-row' }, bar, label), tip);
  const update = () => {
    const r = C.passwordStrength(input.value, hints ? hints() : []);
    box.dataset.score = input.value ? String(r.score) : '';
    label.textContent = input.value ? 'Stärke: ' + PW_LABELS[r.score] : '';
    tip.textContent = input.value && r.score < 3 ? r.tip : '';
  };
  input.addEventListener('input', update);
  update();
  return box;
}

/** Fehlertext, wenn ein neues Passwort zu schwach ist – sonst ''. */
function passwordProblem(pw, hints, what) {
  if (pw.length < 10) return (what || 'Das Passwort') + ' braucht mindestens 10 Zeichen.';
  const r = C.passwordStrength(pw, hints || []);
  if (r.score >= PW_MIN_SCORE) return '';
  return (what || 'Das Passwort') + ' ist zu leicht zu erraten (' + PW_LABELS[r.score] + '). ' + (r.tip || 'Nimm zum Beispiel vier zufällige Wörter.');
}

/* ---------- Auswahl im Stil der App ----------------------------------------
   Statt <select>: Dessen aufgeklappte Liste zeichnet das Betriebssystem, sie
   passt weder zu Farben noch zur Schrift. items: [{ id, name, info, note }];
   onChange(id) nur bei echter Änderung. Bedienung wie eine Auswahlliste:
   Klick oder Pfeiltasten, Pos1/Ende, Enter, Escape. Gibt { el, setItems }. */
function choice(items, value, onChange) {
  const box = el('div', { class: 'sc-choice' });
  const button = el('button', { type: 'button', class: 'sc-choice-btn', 'aria-haspopup': 'listbox', 'aria-expanded': 'false' });
  const list = el('div', { class: 'sc-choice-list', role: 'listbox', hidden: true });
  const hint = el('span', { class: 'sc-field-note' });
  box.append(button, list, hint);
  let options = [];
  let current = value;

  const label = (item) => [el('span', { class: 'sc-choice-name', text: item.name }),
    item.info ? el('span', { class: 'sc-choice-info', text: item.info }) : null];

  function draw() {
    const item = options.find((o) => o.id === current) || options[0];
    button.textContent = '';
    if (item) appendAll(button, ...label(item));
    button.appendChild(icon('chevron', 14));
    hint.textContent = item && item.note ? item.note : '';
    hint.hidden = !hint.textContent;
    list.textContent = '';
    for (const o of options) {
      const opt = el('button', {
        type: 'button', class: 'sc-choice-opt', role: 'option', 'aria-selected': o.id === current ? 'true' : 'false',
        onclick: () => pick(o.id)
      }, el('span', { class: 'sc-choice-head' }, ...label(o)), o.id === current ? icon('check', 14) : null);
      if (o.note) opt.appendChild(el('span', { class: 'sc-choice-note', text: o.note }));
      list.appendChild(opt);
    }
  }
  function open() {
    list.hidden = false;
    box.classList.add('is-open');
    button.setAttribute('aria-expanded', 'true');
    const sel = list.querySelector('[aria-selected="true"]') || list.firstChild;
    if (sel) sel.focus();
  }
  function close(refocus) {
    if (list.hidden) return;
    list.hidden = true;
    box.classList.remove('is-open');
    button.setAttribute('aria-expanded', 'false');
    if (refocus) button.focus();
  }
  function pick(id) {
    const changed = id !== current;
    current = id;
    draw();
    close(true);
    if (changed) onChange(id);
  }
  box.closeChoice = close;
  button.addEventListener('click', () => (list.hidden ? open() : close(false)));
  button.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(); }
  });
  list.addEventListener('keydown', (e) => {
    const opts = [...list.querySelectorAll('.sc-choice-opt')];
    const i = opts.indexOf(document.activeElement);
    const go = (n) => { e.preventDefault(); if (opts[n]) opts[n].focus(); };
    if (e.key === 'ArrowDown') go(i < opts.length - 1 ? i + 1 : 0);
    else if (e.key === 'ArrowUp') go(i > 0 ? i - 1 : opts.length - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(opts.length - 1);
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === 'Tab') close(false);
  });
  const api = { el: box, setItems(next) { options = next; draw(); } };
  api.setItems(items);
  return api;
}

// Klick neben eine offene Auswahl schließt sie.
document.addEventListener('pointerdown', (e) => {
  for (const box of document.querySelectorAll('.sc-choice.is-open')) {
    if (!box.contains(e.target)) box.closeChoice(false);
  }
});

async function copyText(text, what) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const ta = el('textarea', { class: 'sc-offscreen' });
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e2) { /* nichts zu machen */ }
    ta.remove();
  }
  toast((what || 'Text') + ' kopiert.', 'ok');
}

function downloadText(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/pgp-keys' }));
  const a = el('a', { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ==========================================================================
   Server
   ========================================================================== */
function apiError(message, status, data) {
  const e = new Error(message);
  e.status = status;
  e.data = data || {};
  return e;
}

async function api(a, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (S.token) headers['X-SC-Token'] = S.token;
  // Antwortet der Server nicht, nicht ewig warten.
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), 20000) : 0;
  let res;
  try {
    // Ohne Cookies: Clavichat braucht keine, und so geht auch die
    // Dashboard-Sitzung nie mit.
    res = await fetch(API_URL, {
      method: 'POST', headers: headers, credentials: 'omit', cache: 'no-store',
      body: JSON.stringify(Object.assign({ a: a }, body || {})),
      signal: ctrl ? ctrl.signal : undefined
    });
  } catch (e) {
    throw apiError(e && e.name === 'AbortError' ? 'Der Server antwortet nicht.' : 'Keine Verbindung zum Server.', 0);
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try { data = await res.json(); } catch (e) { /* keine JSON-Antwort */ }
  if (!res.ok || !data || data.ok === false) {
    const err = apiError((data && data.error) || ('Serverfehler (' + res.status + ')'), res.status, data);
    if (res.status === 401 && S.entered && a !== 'login' && a !== 'logout') sessionLost(data);
    throw err;
  }
  return data;
}

/** Serverzeit in ms (für Vergleiche mit Zeitstempeln vom Server). */
function serverNow() {
  return Date.now() + (S.skew || 0);
}

/* ==========================================================================
   Ablage im Browser
   ========================================================================== */
function ssGet(key) {
  try { return JSON.parse(sessionStorage.getItem(key) || 'null'); } catch (e) { return null; }
}

function ssSet(key, value) {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch (e) { /* privater Modus */ }
}

/** Höchstens ms warten – manche Browser-Einstellungen lassen IndexedDB hängen. */
function withTimeout(promise, ms, fallback) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(fallback); });
  });
}

function idb() {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open('securecom', 1); } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB blockiert'));
  });
}

function idbGet(key) {
  return withTimeout(idb().then((db) => new Promise((resolve) => {
    const r = db.transaction('kv').objectStore('kv').get(key);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => resolve(null);
  })), 3000, null);
}

function idbSet(key, value) {
  return withTimeout(idb().then((db) => new Promise((resolve) => {
    const tx = db.transaction('kv', 'readwrite');
    if (value === null) tx.objectStore('kv').delete(key);
    else tx.objectStore('kv').put(value, key);
    tx.oncomplete = resolve;
    tx.onerror = resolve;
  })), 3000, undefined);
}

/* ==========================================================================
   Tresor: Kontakte, Raumschlüssel, Gelesen-Stand, Einstellungen
   ========================================================================== */
function emptyVault() {
  return { v: 1, contacts: {}, rooms: {}, blocked: {}, reads: {}, cleared: {}, friends: {}, ttl: {}, reqs: {}, ik: null, settings: { hideIp: false, sound: true, mic: '', status: 'on' } };
}

function mergeVault(a, b) {
  const out = emptyVault();
  for (const src of [a, b]) {
    if (!src || typeof src !== 'object') continue;
    Object.assign(out.settings, src.settings || {});
    for (const [id, c] of Object.entries(src.contacts || {})) {
      const prev = out.contacts[id];
      if (!prev || (c.fp === prev.fp && c.v && !prev.v)) out.contacts[id] = c;
    }
    for (const [rid, r] of Object.entries(src.rooms || {})) {
      const t = out.rooms[rid] || (out.rooms[rid] = { k: {}, rot: 0 });
      Object.assign(t.k, (r && r.k) || {});
      t.rot = Math.max(t.rot || 0, (r && r.rot) || 0);
      // Forward Secrecy: wann eine Schlüsselgeneration dazukam (die früheste
      // Angabe gilt) und bis zu welcher alte Schlüssel gelöscht sind.
      if (r && r.et && typeof r.et === 'object') {
        t.et = t.et || {};
        for (const [e, ts] of Object.entries(r.et)) t.et[e] = t.et[e] ? Math.min(t.et[e], Number(ts) || 0) : Number(ts) || 0;
      }
      if (r && r.gone) t.gone = Math.max(t.gone || 0, Number(r.gone) || 0);
      if (r) mergeRoomMetaState(t, r);
    }
    // Eigener Schlüssel mit gewechselten Unterschlüsseln: der jüngste Stand gilt.
    if (src.ik && typeof src.ik === 'object' && typeof src.ik.k === 'string' &&
        (!out.ik || (Number(src.ik.t) || 0) >= (Number(out.ik.t) || 0))) out.ik = src.ik;
    Object.assign(out.blocked, src.blocked || {});
    for (const [k, t] of Object.entries(src.reads || {})) out.reads[k] = Math.max(out.reads[k] || 0, t || 0);
    for (const [k, t] of Object.entries(src.cleared || {})) out.cleared[k] = Math.max(out.cleared[k] || 0, t || 0);
    // Freunde, Aufbewahrung und Anfragen: je Person gilt der jüngste Stand.
    for (const key of ['friends', 'ttl', 'reqs']) {
      for (const [id, f] of Object.entries(src[key] || {})) {
        if (!f || typeof f !== 'object') continue;
        const prev = out[key][id];
        if (!prev || (Number(f.t) || 0) >= (Number(prev.t) || 0)) out[key][id] = f;
      }
    }
  }
  // Gelöschte Raumschlüssel bleiben gelöscht, auch wenn ein anderes Gerät sie noch hatte.
  for (const r of Object.values(out.rooms)) {
    if (!r.gone) continue;
    for (const e of Object.keys(r.k)) if (Number(e) <= r.gone) delete r.k[e];
    if (r.et) for (const e of Object.keys(r.et)) if (Number(e) <= r.gone) delete r.et[e];
  }
  return out;
}

/**
 * Je Raum im Tresor (seit 1.9.3, siehe decryptMeta und roomHistoryDialog):
 *   hs {on, t}  „Neue Mitglieder sehen den Verlauf“ – nur die eigene Einstellung
 *               des Besitzers, nie aus den Raumdaten abgeleitet (jüngstes t gilt)
 *   mx, mt, mh  zuletzt angenommene Raumdaten: Generation, signierter Zeitpunkt,
 *               Hash – ältere lehnt die App ab (Rollback-Schutz)
 *   mg          Mitglieder, deren Raumdaten schon angenommen wurden (frühere
 *               Verwalter): ihre Raumdaten gelten auch, nachdem sie gegangen sind
 */
function mergeRoomMetaState(t, r) {
  if (r.hs && typeof r.hs === 'object' && (!t.hs || (Number(r.hs.t) || 0) >= (Number(t.hs.t) || 0))) {
    t.hs = { on: r.hs.on ? 1 : 0, t: Number(r.hs.t) || 0 };
  }
  const rx = Number(r.mx) || 0, rt = Number(r.mt) || 0;
  if (rx > (Number(t.mx) || 0) || (rx === (Number(t.mx) || 0) && rt > (Number(t.mt) || 0))) {
    t.mx = rx;
    t.mt = rt;
    if (typeof r.mh === 'string') t.mh = r.mh;
  }
  if (Array.isArray(r.mg)) {
    t.mg = [...new Set((Array.isArray(t.mg) ? t.mg : []).concat(r.mg.filter((id) => typeof id === 'string')))].slice(-MG_MAX);
  }
}

let vaultTimer = 0;

function saveVault(immediate) {
  clearTimeout(vaultTimer);
  if (S.mode === 'temp') {
    const ss = ssGet(SS_KEY);
    if (ss) { ss.vault = S.vault; ssSet(SS_KEY, ss); }
    return Promise.resolve();
  }
  if (immediate) return pushVault();
  vaultTimer = setTimeout(() => { pushVault().catch(() => {}); }, 1500);
  return Promise.resolve();
}

async function pushVault(retry) {
  if (S.mode !== 'account' || !S.wrapKey) return;
  const data = await C.sealText(S.wrapKey, JSON.stringify(S.vault), vaultAad());
  try {
    const r = await api('vault', { vault: data, vv: S.vv });
    S.vv = r.vv;
  } catch (e) {
    if (e.status === 409 && !retry) {
      // Auf einem anderen Gerät geändert: zusammenführen, dann nochmal.
      S.vv = e.data.vv;
      if (e.data.vault) {
        try { S.vault = mergeVault(JSON.parse(await C.openText(S.wrapKey, e.data.vault, vaultAad())), S.vault); } catch (e2) { /* unlesbar */ }
        adoptVaultKey().catch(() => {});   // ein anderes Gerät hat den Schlüssel gewechselt?
      }
      return pushVault(true);
    }
    throw e;
  }
}

function vaultAad() { return 'sc-vault|' + String(S.username || '').toLowerCase(); }
function keyAad(username) { return 'sc-key|' + String(username).toLowerCase(); }

/* ==========================================================================
   Identitäten: Schlüssel prüfen, Karte prüfen, Kontakte merken
   ========================================================================== */
async function resolveIdentity(raw) {
  if (!raw || typeof raw.id !== 'string') return null;
  const cur = S.ids.get(raw.id);
  if (cur && cur.cv === raw.cv && cur.armored === raw.pub) {
    if ('on' in raw) cur.on = raw.on;
    cur.at = Date.now();   // Schlüsselstand frisch (für freshIds)
    return cur;
  }
  let key;
  try { key = await C.readPublicKey(raw.pub); } catch (e) { return null; }
  // Der Server könnte einen Fingerabdruck behaupten, der nicht zum
  // Schlüssel passt – hier zählt nur, was der Schlüssel selbst sagt.
  if (key.getFingerprint() !== raw.fp) return null;
  const card = await C.verifyCard(key, raw.card);
  if (!card || card.id !== raw.id) return null;
  const ident = {
    id: raw.id,
    kind: raw.k === 'account' ? 'account' : 'temp',
    guest: raw.k !== 'account' && raw.g === true,   // Gast eines Meetings: keine DMs, keine Anrufe
    fp: raw.fp,
    key: key,
    armored: raw.pub,
    cv: raw.cv,
    name: cleanName(card.name),
    // Profilbild: nur Konten; die signierte Karte nennt seinen SHA-256-Wert.
    av: raw.k === 'account' && /^[0-9a-f]{64}$/.test(card.av || '') ? card.av : null,
    on: 'on' in raw ? raw.on : (cur ? cur.on : null),
    at: Date.now(),
    changed: false
  };
  const c = S.vault && S.vault.contacts[ident.id];
  if (c && c.fp !== ident.fp) ident.changed = true;
  S.ids.set(ident.id, ident);
  S.keyringCache = null;
  wantAvatar(ident);
  return ident;
}

async function ensureIds(ids) {
  const missing = [...new Set(ids)].filter((id) => typeof id === 'string' && !S.ids.has(id));
  for (let i = 0; i < missing.length; i += 100) {
    try {
      const r = await api('ids', { ids: missing.slice(i, i + 100) });
      for (const raw of r.list) await resolveIdentity(raw);
    } catch (e) { /* später nochmal */ }
  }
  return ids.map((id) => S.ids.get(id)).filter(Boolean);
}

function keyring() {
  if (!S.keyringCache) S.keyringCache = [...S.ids.values()].map((i) => i.key);
  return S.keyringCache;
}

/** Kontakt merken (Schlüssel beim ersten Kontakt, "Trust on first use"). */
function noteContact(ident) {
  if (!ident || ident.id === S.me.id) return;
  const c = S.vault.contacts[ident.id];
  if (!c) {
    S.vault.contacts[ident.id] = { fp: ident.fp, n: ident.name, t: Date.now(), v: false };
    saveVault();
  } else if (c.fp !== ident.fp) {
    ident.changed = true;
  } else if (c.n !== ident.name) {
    c.n = ident.name;
    saveVault();
  }
}

/* ---------- Nachrichtenanfragen ---------------------------------------------
   Wer schreibt oder anruft, ohne bekannt zu sein, landet erst unter
   NACHRICHTENANFRAGEN: kein Ton, in der Benachrichtigung kein Name, Links
   nicht anklickbar, Einladungen gesperrt. Bekannt ist, wer schon Kontakt ist
   (auch alle bisherigen), Freund oder Mitglied eines gemeinsamen Raums – oder
   wem du selbst geschrieben hast. Annehmen oder Antworten macht daraus eine
   normale Unterhaltung. Tresor: reqs[peer] = { s: 'req' | 'ok', t } – wie bei
   den Freunden gilt geräteübergreifend der jüngste Stand. */
function isRequest(peer) {
  const r = S.vault && S.vault.reqs && S.vault.reqs[peer];
  if (!r || r.s !== 'req') return false;
  const f = S.vault.friends && S.vault.friends[peer];
  return !(f && f.st === 'yes');   // Freunde sind keine Anfrage mehr
}

function setRequest(peer, state, t) {
  if (!S.vault.reqs) S.vault.reqs = {};
  S.vault.reqs[peer] = { s: state, t: t || serverNow() };
  saveVault();
}

function knownPeer(id) {
  if (S.vault.contacts[id] && !isRequest(id)) return true;
  const f = S.vault.friends && S.vault.friends[id];
  if (f && f.st === 'yes') return true;
  for (const room of S.rooms.values()) if (room.members.some((m) => m.id === id)) return true;
  return false;
}

/** Erste Nachricht oder erster Anruf einer unbekannten Person: als Anfrage merken. */
function noteRequest(peer, ts) {
  if (isRequest(peer) || knownPeer(peer)) return;
  const conv = S.convs.get(peer);
  if (conv && conv.msgs.some((m) => m.from === S.me.id)) return;   // du hast selbst geschrieben
  const r = S.vault.reqs && S.vault.reqs[peer];
  if (r && r.s === 'ok') return;   // schon einmal angenommen
  setRequest(peer, 'req', ts);
}

function acceptRequest(peer, quiet) {
  if (!isRequest(peer)) return;
  setRequest(peer, 'ok');
  if (!quiet) toast('Angenommen – ihr könnt jetzt ganz normal schreiben und telefonieren.', 'ok');
  renderAll();
}

/** Ablehnen: Verlauf hier weg, Kontakt vergessen. Schreibt die Person wieder, kommt eine neue Anfrage. */
function declineRequest(peer) {
  const conv = S.convs.get(peer);
  let last = serverNow();
  if (conv) for (const m of conv.msgs) last = Math.max(last, m.ts || 0);
  S.vault.cleared[peer] = last;
  delete S.vault.contacts[peer];
  setRequest(peer, 'req');
  S.convs.delete(peer);
  if (S.view.kind === 'dm' && S.view.peer === peer) setView({ kind: 'home' });
  renderAll();
}

/* Anrufe von Unbekannten: bei temporären Sitzungen klingeln sie (dafür ist die
   Online-Liste da), bei Konten landen sie als Anfrage. Temporär je Gerät,
   bei Konten im Tresor. */
const UNKNOWN_CALLS_KEY = 'sc-unknown-calls';

function unknownCallsAllowed() {
  if (S.mode !== 'temp') return S.vault.settings.unknownCalls === true;
  try { const v = localStorage.getItem(UNKNOWN_CALLS_KEY); if (v === '0' || v === '1') return v === '1'; } catch (e) { /* privater Modus */ }
  return true;
}

function setUnknownCalls(on) {
  if (S.mode !== 'temp') { S.vault.settings.unknownCalls = !!on; saveVault(); return; }
  try { localStorage.setItem(UNKNOWN_CALLS_KEY, on ? '1' : '0'); } catch (e) { /* gilt bis zum Neuladen */ }
}

/** Anruf einer unbekannten Person, der nicht klingeln soll: still als Anfrage vermerken. */
function noteRequestCall(from, ts, obj) {
  noteRequest(from.id, ts);
  noteContact(from);
  const conv = convOf(from.id);
  const id = 'call-' + String(obj.call);
  if (!conv.byId.has(id)) {
    const m = { id: id, sys: (obj.video ? 'Videoanruf' : 'Anruf') + ' – nicht durchgestellt, weil ihr euch noch nicht kennt', icon: 'phone', ts: ts, from: '' };
    insertSorted(conv.msgs, m);
    conv.byId.set(id, m);
    conv.last = Math.max(conv.last, ts);
    conv.unread++;
    notify('Clavichat', 'Neue Nachrichtenanfrage', 'req');
  }
  scheduleRender();
}

function isVerified(ident) {
  const c = ident && S.vault.contacts[ident.id];
  return !!(c && c.v && c.fp === ident.fp);
}

function isBlocked(ident) {
  return !!(ident && S.vault.blocked[ident.fp]);
}

function displayName(ident) {
  if (!ident) return 'Unbekannt';
  if (ident.id === (S.me && S.me.id)) return S.me.name || 'Ich';
  return ident.name || 'Anonym';
}

function fpTail(fp) {
  const f = String(fp || '').toUpperCase();
  return f.slice(-8, -4) + ' ' + f.slice(-4);
}

function hueOf(fp) {
  return parseInt(String(fp || '0').slice(-6), 16) % 360;
}

function avatar(ident, size) {
  // Ohne Namen (temporär, kein Alias): die letzten Zeichen des Fingerabdrucks.
  const own = ident && S.me && ident.id === S.me.id;
  const name = ident ? (own ? S.me.name : ident.name) || '' : '?';
  const letters = (name.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2) || String(ident && ident.fp || '??').slice(-2)).toUpperCase();
  const url = avatarUrl(ident);
  const a = el('span', { class: 'sc-av' + (size ? ' sc-av--' + size : '') + (url ? ' has-img' : ''), text: url ? null : letters, 'aria-hidden': 'true' },
    url ? el('img', { src: url, alt: '', draggable: 'false' }) : null);
  if (ident) a.style.setProperty('--hue', hueOf(ident.fp));
  return a;
}

/* ---------- Profilbilder (nur Konten) -------------------------------------- */
/**
 * Öffentlich wie der Name. Die signierte Karte nennt den SHA-256-Wert des
 * Bildes; gezeigt wird ein geladenes Bild nur, wenn es genau dazu passt –
 * der Server kann es also nicht unbemerkt austauschen.
 */
const AV = new Map();         // SHA-256 -> Objekt-URL ('' = fehlt oder passt nicht)
const avWanted = new Map();   // Kennung -> erwarteter SHA-256-Wert
let avTimer = 0;

function avatarUrl(ident) {
  return ident && ident.av ? AV.get(ident.av) || null : null;
}

function wantAvatar(ident) {
  if (!ident || !ident.av || AV.has(ident.av)) return;
  avWanted.set(ident.id, ident.av);
  if (!avTimer) avTimer = setTimeout(loadAvatars, 60);
}

async function sha256Hex(bytes) {
  return C.toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

function imageType(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes[0] === 0x52 && bytes[8] === 0x57) return 'image/webp';
  return 'image/jpeg';
}

async function loadAvatars() {
  avTimer = 0;
  const batch = [...avWanted.entries()].slice(0, 50);
  for (const [id] of batch) avWanted.delete(id);
  if (!batch.length || !S.token) return;
  try {
    const r = await api('avatars', { ids: batch.map((b) => b[0]) });
    const got = new Map(r.list.map((item) => [item.id, item.d]));
    for (const [id, want] of batch) {
      if (AV.has(want)) continue;
      const data = got.get(id);
      const bytes = data ? C.unb64(data) : null;
      const ok = bytes && (await sha256Hex(bytes)) === want;
      AV.set(want, ok ? URL.createObjectURL(new Blob([bytes], { type: imageType(bytes) })) : '');
    }
    scheduleRender();
  } catch (e) {
    for (const [id, want] of batch) if (!avWanted.has(id)) avWanted.set(id, want);
    if (!avTimer) avTimer = setTimeout(loadAvatars, 8000);
    return;
  }
  if (avWanted.size && !avTimer) avTimer = setTimeout(loadAvatars, 60);
}

/** Datei wählen lassen. Ergebnis: die Datei oder null (abgebrochen). */
function pickImage() {
  return new Promise((resolve) => {
    const input = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif' });
    input.addEventListener('change', () => resolve((input.files && input.files[0]) || null));
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/**
 * Quadratischer Ausschnitt aus der Mitte, verkleinert und als JPEG neu
 * kodiert. Dabei fallen alle Metadaten weg (Ort, Kamera, Datum).
 */
async function squareImage(file, size, quality) {
  if (file.size > 15 * 1024 * 1024) throw new Error('Das Bild ist zu groß (höchstens 15 MB).');
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch (e) { throw new Error('Dieses Bild kann der Browser nicht lesen.'); }
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0b0b0d';               // durchsichtige Bilder: dunkler Grund
  ctx.fillRect(0, 0, size, size);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
  if (bitmap.close) bitmap.close();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob) throw new Error('Das Bild ließ sich nicht umwandeln.');
  return new Uint8Array(await blob.arrayBuffer());
}

/** Eigenes Profilbild setzen (oder mit remove entfernen): Bild + neu signierte Karte. */
async function setProfilePicture(remove) {
  try {
    let bytes = null;
    if (!remove) {
      const file = await pickImage();
      if (!file) return false;
      bytes = await squareImage(file, 192, 0.86);
    }
    const hash = bytes ? await sha256Hex(bytes) : null;
    const fields = { v: 1, id: S.me.id, kind: 'account', name: S.me.name, ts: Date.now() };
    if (hash) fields.av = hash;
    const card = await C.signCard(S.me.priv, fields);
    await api('avatar', { d: bytes ? C.b64(bytes) : '', card: card });
    if (hash && !AV.get(hash)) AV.set(hash, URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' })));
    S.me.av = hash;
    const me = S.ids.get(S.me.id);
    if (me) me.av = hash;
    renderAll();
    toast(hash ? 'Profilbild gespeichert.' : 'Profilbild entfernt.', 'ok');
    return true;
  } catch (e) {
    toast(e.message, 'error');
    return false;
  }
}

/** Eigene Karte (nach Anmeldung oder Neuladen): Name und Profilbild übernehmen. */
async function applyOwnCard(raw) {
  const card = raw ? await C.verifyCard(S.me.pub, raw) : null;
  if (!card || card.id !== S.me.id) return;
  S.me.name = cleanName(card.name);
  S.me.av = S.mode === 'account' && /^[0-9a-f]{64}$/.test(card.av || '') ? card.av : null;
  const me = S.ids.get(S.me.id);
  if (me) { me.name = S.me.name; me.av = S.me.av; wantAvatar(me); }
}

function kindBadge(ident) {
  if (!ident) return null;
  if (ident.guest) return el('span', { class: 'sc-kind sc-kind--guest', text: 'GAST', title: 'Gast eines Meetings – nur im Meeting erreichbar' });
  return el('span', { class: 'sc-kind', text: ident.kind === 'temp' ? 'TEMP' : 'KONTO', title: ident.kind === 'temp' ? 'Temporäre Sitzung' : 'Konto' });
}

/* ==========================================================================
   Anmeldung: temporär, Konto, Konto erstellen
   ========================================================================== */
function gateCard() { return $('sc-gate-card'); }

function showGate(message, tab) {
  $('sc').hidden = true;
  $('sc-gate').hidden = false;
  renderGate(tab || (gateAccountsOnly() ? 'register' : 'temp'), message);
  bootDone();
}

/** Offene Einladung zu einem Raum nur für Konten: keine temporäre Sitzung anbieten. */
function gateAccountsOnly() {
  return !!(S.pendingJoin && S.pendingJoin.ao && !S.pendingJoin.meet);
}

function renderGate(tab, message) {
  const card = gateCard();
  const ao = gateAccountsOnly();
  if (ao && tab === 'temp') tab = 'register';
  card.textContent = '';
  card.classList.remove('is-guest');
  card.append(
    el('p', { class: 'section-head' }, el('span', { class: 'sq' }), el('span', { class: 'label', text: 'CLAVICHAT' }), el('span', { class: 'rule' })),
    el('h1', { class: 'sc-gate-title', text: 'Sicher schreiben & telefonieren' }),
    el('p', { class: 'sc-gate-sub', text: 'Ende-zu-Ende verschlüsselt: Deine Schlüssel entstehen ' + (DESKTOP ? 'in dieser App' : 'in diesem Browser') + '. Der Server leitet nur Verschlüsseltes weiter – auch der Hoster kann nicht mitlesen oder mithören.' })
  );
  // Wohin die Einladung führt: Raumbild, Name, Mitglieder (sofern der Server es liefert).
  if (S.pendingJoin) card.appendChild(invitePreviewSlot(S.pendingJoin, 'is-gate'));
  if (ao) {
    // Ohne Einladung weiter: dann wieder mit temporärer Sitzung.
    const drop = el('a', { href: '#', text: 'Ohne Einladung fortfahren', onclick: (ev) => {
      ev.preventDefault();
      S.pendingJoin = null;
      ssSet(JOIN_KEY, null);
      renderGate('temp');
    } });
    card.appendChild(el('p', { class: 'sc-gate-invite sc-gate-invite--ao', id: 'sc-gate-ao' }, icon('users', 15),
      el('span', {}, el('strong', { text: 'Dieser Raum ist nur für Mitglieder mit Konto.' }),
        ' Erstelle ein Konto – oder melde dich an, wenn du schon eins hast. Danach trittst du dem Raum bei. ', drop)));
  } else if (S.pendingJoin) {
    card.appendChild(el('p', { class: 'sc-gate-invite' }, icon(S.pendingJoin.meet ? 'group' : 'link', 15), S.pendingJoin.meet
      ? 'Du wurdest in einen Meeting-Raum eingeladen. Starte eine temporäre Sitzung (oder melde dich an) – danach bist du mit einem Klick drin.'
      : 'Du wurdest in einen Raum eingeladen. Melde dich an oder starte eine temporäre Sitzung – danach trittst du bei.'));
  }
  const tabs = el('div', { class: 'sc-tabs', role: 'tablist' });
  const panel = el('div', { class: 'sc-gate-panel' });
  (ao ? [['register', 'Konto erstellen'], ['login', 'Anmelden']]
    : [['temp', 'Temporär'], ['login', 'Anmelden'], ['register', 'Konto erstellen']]).forEach(([key, label]) => {
    tabs.appendChild(el('button', {
      type: 'button', role: 'tab', class: 'sc-tab', 'aria-selected': key === tab ? 'true' : 'false', text: label,
      onclick: () => renderGate(key)
    }));
  });
  card.append(tabs, panel);
  if (message) panel.appendChild(el('p', { class: 'sc-error', text: message }));
  if (tab === 'temp') gateTemp(panel);
  if (tab === 'login') gateLogin(panel);
  if (tab === 'register') gateRegister(panel);
}

function accessField() {
  if (!S.cfg || S.cfg.access !== 'code') return null;
  const input = el('input', { type: 'password', name: 'code', autocomplete: 'off', placeholder: 'Zugangscode' });
  return field('Zugangscode', input, 'Clavichat ist hier nur mit Code offen.');
}

function gateBusy(button, text) {
  button.disabled = true;
  button.dataset.label = button.textContent;
  button.textContent = text;
}

function gateIdle(button) {
  button.disabled = false;
  if (button.dataset.label) button.textContent = button.dataset.label;
}

function gateTemp(panel) {
  const suggestion = randomAlias();
  const alias = el('input', { type: 'text', maxlength: '40', placeholder: suggestion, autocomplete: 'off' });
  const code = accessField();
  const go = el('button', { type: 'submit', class: 'btn btn--primary btn--block', text: 'Temporäre Sitzung starten' });
  const form = el('form', { class: 'sc-gate-form' },
    field('Alias (optional)', alias, 'So sehen dich andere. Ohne Eingabe heißt du „' + suggestion + '“ – ändern geht auch später.'),
    code, go,
    el('p', { class: 'sc-gate-note', text: 'Ohne Konto: Ein neues PGP-Schlüsselpaar entsteht jetzt ' + (DESKTOP ? 'in der App' : 'in deinem Browser') + ' und lebt nur ' + KEY_HOME + '. Nach ' + (S.cfg ? S.cfg.temp_hours : 24) + ' Stunden ohne Nutzung – oder wenn du die Sitzung beendest – löscht der Server alles, was dazugehört.' }));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    gateBusy(go, 'Schlüssel wird ' + LOCAL + ' erzeugt …');
    try {
      await startTemp(cleanName(alias.value) || suggestion, code ? code.querySelector('input').value : '');
    } catch (e) {
      gateIdle(go);
      toast(e.message, 'error');
    }
  });
  // Zweiter Weg: gleich ein Meeting eröffnen – nur mit Namen, danach mit Link zum Teilen.
  const meet = el('button', { type: 'button', class: 'btn btn--block sc-gate-meet', id: 'sc-gate-meet',
    onclick: () => showMeetingStart(cleanName(alias.value), code ? code.querySelector('input').value : '') },
  icon('group', 16), 'Meeting erstellen');
  panel.append(form,
    el('p', { class: 'sc-gate-or', text: 'oder' }),
    meet,
    el('p', { class: 'sc-gate-note', text: 'Ein Meeting mit Link zum Teilen: Wer ihn öffnet, braucht nur einen Namen. Chat und Call mit Ton, Kamera und Bildschirm – ohne Kontakte und Räume drumherum.' }));
}

function gateLogin(panel) {
  const user = el('input', { type: 'text', autocomplete: 'username', maxlength: '24', spellcheck: 'false', required: true });
  const pass = el('input', { type: 'password', autocomplete: 'current-password', required: true });
  const remember = el('input', { type: 'checkbox', checked: true });
  const go = el('button', { type: 'submit', class: 'btn btn--primary btn--block', text: 'Anmelden' });
  if (ssoAvailable()) panel.appendChild(mailboxBox('login', user, pass));
  const form = el('form', { class: 'sc-gate-form' },
    field('Name', user), field('Passwort oder Wiederherstellungscode', pass),
    el('label', { class: 'sc-check' }, remember, el('span', { text: 'Auf diesem Gerät angemeldet bleiben' })),
    go,
    el('p', { class: 'sc-gate-note', text: 'Passwort und Code verlassen den Browser nicht. Aus ihnen entstehen hier ein Anmeldeschlüssel und ein Schlüssel, der deinen privaten PGP-Schlüssel auspackt.' }));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    gateBusy(go, 'Passwort wird geprüft …');
    try {
      await loginAccount(user.value.trim(), pass.value, remember.checked);
      // Bestehende Konten mit schwachem Passwort: nur ein Hinweis, kein Zwang.
      if (!C.isRecoveryCode(pass.value) && C.passwordStrength(pass.value, [user.value.trim()]).score < PW_MIN_SCORE) {
        toast('Dein Passwort ist leicht zu erraten. Ändere es unter Einstellungen → KONTO → „Passwort ändern“.', 'error', 12000);
      }
    } catch (e) {
      gateIdle(go);
      toast(e.message, 'error');
    }
  });
  panel.appendChild(form);
}

function gateRegister(panel) {
  const user = el('input', { type: 'text', autocomplete: 'username', maxlength: '24', spellcheck: 'false', required: true });
  const pass = el('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: '10' });
  const pass2 = el('input', { type: 'password', autocomplete: 'new-password', required: true });
  const keyNew = el('input', { type: 'radio', name: 'keymode', value: 'new', checked: true });
  const keyOwn = el('input', { type: 'radio', name: 'keymode', value: 'own' });
  const armored = el('textarea', { rows: '5', spellcheck: 'false', placeholder: '-----BEGIN PGP PRIVATE KEY BLOCK-----' });
  const passphrase = el('input', { type: 'password', autocomplete: 'off', placeholder: 'Passphrase des Schlüssels (falls gesetzt)' });
  const ownBox = el('div', { class: 'sc-own-key', hidden: true },
    field('Dein privater Schlüssel', armored, 'Aus GnuPG oder Kleopatra exportiert. Damit dein Browser Nachrichten an dich lesen kann, braucht er den privaten Schlüssel – der öffentliche allein reicht dafür nicht. Er wird hier mit deinem Passwort verschlüsselt und nur so gespeichert.'),
    field('Passphrase', passphrase));
  const code = accessField();
  const remember = el('input', { type: 'checkbox', checked: true });
  const go = el('button', { type: 'submit', class: 'btn btn--primary btn--block', text: 'Konto erstellen' });
  [keyNew, keyOwn].forEach((r) => r.addEventListener('change', () => { ownBox.hidden = !keyOwn.checked; }));
  if (ssoAvailable()) panel.appendChild(mailboxBox('register'));

  const form = el('form', { class: 'sc-gate-form' },
    field('Name', user, '3–24 Zeichen. Andere sehen dich unter diesem Namen. Keine E-Mail nötig.'),
    field('Passwort', pass, 'Mindestens „okay“. Lang schlägt kompliziert – am einfachsten vier zufällige Wörter.',
      strengthMeter(pass, () => [user.value.trim()])),
    field('Passwort wiederholen', pass2),
    el('fieldset', { class: 'sc-fieldset' },
      el('legend', { class: 'field-label', text: 'Dein PGP-Schlüssel' }),
      el('label', { class: 'sc-check' }, keyNew, el('span', { text: 'Neues Schlüsselpaar ' + LOCAL + ' erzeugen (empfohlen)' })),
      el('label', { class: 'sc-check' }, keyOwn, el('span', { text: 'Eigenen PGP-Schlüssel verwenden' })),
      ownBox),
    code,
    el('label', { class: 'sc-check' }, remember, el('span', { text: 'Auf diesem Gerät angemeldet bleiben' })),
    go,
    el('p', { class: 'sc-gate-note sc-gate-note--warn', text: 'Ohne E-Mail gibt es kein „Passwort vergessen“: Wer das Passwort verliert, verliert das Konto. Sichere nach dem Erstellen deinen Schlüssel.' }));

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const weak = passwordProblem(pass.value, [user.value.trim()]);
    if (weak) { toast(weak, 'error', 9000); return; }
    if (pass.value !== pass2.value) { toast('Die Passwörter stimmen nicht überein.', 'error'); return; }
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{2,23}$/.test(user.value.trim())) {
      toast('Der Name braucht 3–24 Zeichen: Buchstaben, Ziffern, Punkt, Strich, Unterstrich.', 'error');
      return;
    }
    gateBusy(go, keyOwn.checked ? 'Schlüssel wird geprüft …' : 'Schlüssel wird ' + LOCAL + ' erzeugt …');
    try {
      const identity = keyOwn.checked
        ? await C.importPrivateKey(armored.value, passphrase.value)
        : await C.generateIdentity();
      go.textContent = 'Passwort wird gehärtet …';
      await registerAccount(user.value.trim(), pass.value, identity, remember.checked, code ? code.querySelector('input').value : '');
    } catch (e) {
      gateIdle(go);
      toast(e.message, 'error');
    }
  });
  panel.appendChild(form);
}

/* ---------- Mit dem Postfach (offizieller Server) --------------------------------
   Nur auf dem offiziellen Server (S.cfg.sso), nicht in der Windows-App. Wer im
   Dashboard angemeldet ist, bekommt dort ein signiertes Ticket, das sein
   Postfach bestätigt (fünf Minuten, nur einmal). Das ist der einzige Aufruf,
   der ein Cookie mitschickt – das der Dashboard-Sitzung; die Schnittstelle
   von Clavichat selbst kommt weiter ohne aus. Den Schlüssel des Kontos
   schützt dann ein Wiederherstellungscode statt eines Passworts. */
function ssoAvailable() {
  return !DESKTOP && !!(S.cfg && typeof S.cfg.sso === 'string' && /^\/[A-Za-z0-9_./-]+$/.test(S.cfg.sso));
}

async function mailboxTicket() {
  let res = null;
  let data = null;
  try {
    res = await fetch(S.cfg.sso, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    data = await res.json();
  } catch (e) { /* unten */ }
  if (res && res.status === 401) {
    const err = new Error('Melde dich zuerst bei achterberg.dev an.');
    err.login = true;
    throw err;
  }
  if (!data || !data.ok || typeof data.ticket !== 'string') throw new Error((data && data.error) || 'achterberg.dev ist gerade nicht erreichbar.');
  return data;   // { ticket, mailbox, name }
}

function mailboxNotice(notice, content) {
  notice.textContent = '';
  appendAll(notice, ...content);
  notice.hidden = false;
}

function mailboxError(notice, e) {
  if (!e.login) { mailboxNotice(notice, [e.message]); return; }
  const back = location.pathname + location.search;
  mailboxNotice(notice, ['Melde dich zuerst bei achterberg.dev an – ',
    el('a', { href: '/app/login.php?next=' + encodeURIComponent(back), text: 'zur Anmeldung' }), '. Danach geht es hier weiter.']);
}

function mailboxBox(kind, user, pass) {
  const notice = el('p', { class: 'sc-gate-note sc-sso-notice', hidden: true });
  const button = el('button', { type: 'button', class: 'btn btn--block sc-sso-btn' }, icon('key', 14),
    kind === 'login' ? 'Mit achterberg.dev anmelden' : 'Konto mit achterberg.dev erstellen');
  button.addEventListener('click', () => (kind === 'login' ? loginWithMailbox(notice, button, user, pass) : registerWithMailbox(notice, button)));
  return el('div', { class: 'sc-sso' },
    el('p', { class: 'sc-sso-text', text: kind === 'login'
      ? 'Bei achterberg.dev angemeldet? Dann findet Clavichat dein Konto selbst.'
      : 'Bei achterberg.dev angemeldet? Dann geht es ohne Passwort: Dein Postfach bestätigt dich, deinen Schlüssel schützt ein Wiederherstellungscode.' }),
    button, notice,
    el('p', { class: 'sc-sso-or', text: kind === 'login' ? 'oder mit Name und Passwort bzw. Code' : 'oder mit Name und Passwort' }));
}

async function loginWithMailbox(notice, button, user, pass) {
  notice.hidden = true;
  gateBusy(button, 'achterberg.dev wird gefragt …');
  try {
    const t = await mailboxTicket();
    const r = await api('sso.who', { sso: t.ticket });
    gateIdle(button);
    if (r.username) {
      user.value = r.username;
      pass.focus();
      mailboxNotice(notice, ['Dein Konto heißt „' + r.username + '“. Gib unten deinen Wiederherstellungscode ein – auf Geräten, die angemeldet bleiben, fragt Clavichat danach nicht mehr.']);
    } else {
      mailboxNotice(notice, ['Zu ' + t.mailbox + ' gibt es noch kein Clavichat-Konto. ',
        el('a', { href: '#', text: 'Jetzt eins anlegen', onclick: (ev) => { ev.preventDefault(); renderGate('register'); } }), '.']);
    }
  } catch (e) {
    gateIdle(button);
    mailboxError(notice, e);
  }
}

async function registerWithMailbox(notice, button) {
  notice.hidden = true;
  gateBusy(button, 'achterberg.dev wird gefragt …');
  let first;
  try {
    first = await mailboxTicket();
  } catch (e) {
    gateIdle(button);
    mailboxError(notice, e);
    return;
  }
  gateIdle(button);
  openModal({
    title: 'KONTO MIT ACHTERBERG.DEV',
    build: (body) => {
      const name = el('input', { type: 'text', maxlength: '24', spellcheck: 'false', autocomplete: 'username', value: first.name || '' });
      const go = el('button', { type: 'button', class: 'btn btn--primary btn--block', text: 'Konto erstellen' });
      go.addEventListener('click', async () => {
        const username = name.value.trim();
        if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{2,23}$/.test(username)) {
          toast('Der Name braucht 3–24 Zeichen: Buchstaben, Ziffern, Punkt, Strich, Unterstrich.', 'error');
          return;
        }
        gateBusy(go, 'Schlüssel wird ' + LOCAL + ' erzeugt …');
        try {
          const identity = await C.generateIdentity();
          const ticket = await mailboxTicket();   // jedes Ticket gilt nur einmal
          await registerAccount(username, C.newRecoveryCode(), identity, true, '', ticket.ticket);
        } catch (e) {
          gateIdle(go);
          toast(e.message, 'error');
        }
      });
      body.append(
        el('p', { class: 'sc-p', text: 'Postfach ' + first.mailbox + ' – bestätigt.' }),
        field('Name', name, 'So sehen dich andere. 3–24 Zeichen: Buchstaben, Ziffern, Punkt, Strich, Unterstrich.'),
        el('p', { class: 'sc-note', text: 'Kein Passwort: Dein Schlüssel entsteht ' + LOCAL + ' und wird mit einem Wiederherstellungscode geschützt, den gleich nur du siehst. Der Server sieht weder Code noch Schlüssel. Dieses Gerät bleibt angemeldet.' }),
        go);
    }
  });
}

/** Den Wiederherstellungscode genau einmal zeigen – nach dem Anlegen oder Erneuern. */
function showRecoveryCode(username, code, fresh) {
  openModal({
    title: 'WIEDERHERSTELLUNGSCODE',
    build: (body, close) => {
      const done = el('button', { type: 'button', class: 'btn btn--primary btn--block', text: 'Fertig', disabled: true, onclick: () => close() });
      const ok = el('input', { type: 'checkbox' });
      ok.addEventListener('change', () => { done.disabled = !ok.checked; });
      const file = 'Clavichat – Wiederherstellungscode\r\n\r\nName: ' + username + '\r\nCode: ' + code + '\r\n\r\n' +
        'Der Code ersetzt dein Passwort. Auf einem neuen Gerät: anmelden mit Name und Code\r\n' +
        '(oder „Mit achterberg.dev anmelden“ und dann den Code).\r\n' +
        'Wer Name und Code hat, kommt in dein Konto – sicher aufbewahren, nie weitergeben.\r\n';
      appendAll(body,
        fresh ? el('p', { class: 'sc-p', text: 'Willkommen, ' + username + '! Dein Konto steht – ganz ohne Passwort. Dieses Gerät bleibt angemeldet.' }) : null,
        el('p', { class: 'sc-p', text: 'Für neue Geräte brauchst du diesen Code, er ersetzt das Passwort. Er erscheint nur jetzt.' }),
        el('p', { class: 'sc-recovery', text: code }),
        el('div', { class: 'sc-card-actions' },
          el('button', { type: 'button', class: 'btn', onclick: () => copyText(code, 'Wiederherstellungscode') }, icon('copy', 14), 'Kopieren'),
          el('button', { type: 'button', class: 'btn', onclick: () => downloadText('clavichat-wiederherstellung-' + username + '.txt', file) }, icon('download', 14), 'Als Datei speichern')),
        el('p', { class: 'sc-gate-note sc-gate-note--warn', text: 'Niemand kann den Code wiederherstellen, auch der Server nicht. Geht er verloren, erzeugst du auf einem angemeldeten Gerät in den Einstellungen einen neuen.' }),
        el('label', { class: 'sc-check' }, ok, el('span', { text: 'Ich habe den Code sicher aufbewahrt.' })),
        done);
    }
  });
}

/** Neuen Code erzeugen (nur auf einem Gerät, das sich das Konto mit Code gemerkt hat). */
async function renewRecoveryCode() {
  const ok = await confirmBox('Neuer Wiederherstellungscode', 'Der bisherige Code wird ungültig, andere Geräte werden abgemeldet und brauchen dann den neuen Code.', 'Neuen Code erzeugen');
  if (!ok) return;
  try {
    const saved = await loadSession();
    if (!saved || !saved.authSealed) throw new Error('Dieses Gerät kennt den bisherigen Code nicht.');
    const oldAuth = await C.openText(S.wrapKey, saved.authSealed, authAad(S.username));
    const code = C.newRecoveryCode();
    const keys = await C.deriveCodeKeys(S.username, code);
    const wrapKey = await C.importWrapKey(keys.wrapRaw, false);
    const wrapped = await C.sealText(wrapKey, C.armorPrivate(S.me.priv), keyAad(S.username));
    const vault = await C.sealText(wrapKey, JSON.stringify(S.vault), vaultAad());
    const r = await api('password', { old_auth: oldAuth, auth: keys.auth, wrapped: wrapped, vault: vault });
    S.wrapKey = wrapKey;
    S.vv = r.vv;
    S.deviceLabeled = false;
    labelDevice();
    await rememberAccount(true, S.username, S.me.id, S.token, wrapped, keys.wrapRaw, await C.sealText(wrapKey, keys.auth, authAad(S.username)));
    showRecoveryCode(S.username, code, false);
  } catch (e) {
    toast(e.message, 'error');
  }
}

/* ---------- Sitzung anlegen ---------------------------------------------- */
async function startTemp(alias, code) {
  const identity = await C.generateIdentity();
  const id = C.randomId();
  const card = await C.signCard(identity.privateKey, { v: 1, id: id, kind: 'temp', name: alias, ts: Date.now() });
  const r = await api('temp', { id: id, pub: identity.armoredPublic, fp: identity.fingerprint, card: card, code: code });
  S.token = r.token;
  S.mode = 'temp';
  S.vault = emptyVault();
  setMe(identity, id, 'temp', alias, true);
  S.me.published = identity.armoredPublic;
  ssSet(SS_KEY, { mode: 'temp', id: id, token: r.token, priv: C.armorPrivate(identity.privateKey), vault: S.vault });
  await enterApp();
  toast('Temporäre Sitzung läuft. Dein Schlüssel lebt nur ' + KEY_HOME + '.', 'ok');
}

/* ---------- Meeting von der Startseite -------------------------------------
   „Meeting erstellen“ auf der Startseite: Name eingeben, dann entsteht eine
   temporäre Sitzung, die nur dieses eine Meeting kennt (S.meetOnly – dieselbe
   schlanke Oberfläche wie für Gäste, aber ohne deren Grenzen beim Server:
   Der Gastgeber legt das Meeting an und lädt ein). Nicht in der Online-Liste.
   Verlässt oder beendet er das Meeting, endet auch die Sitzung. */
function showMeetingStart(prefill, codeValue, message) {
  const card = guestCard();
  const name = el('input', { type: 'text', maxlength: '40', required: true, autocomplete: 'nickname', spellcheck: 'false', placeholder: 'z. B. Alex', value: prefill || '' });
  const code = accessField();
  if (code && codeValue) code.querySelector('input').value = codeValue;
  const go = el('button', { type: 'submit', class: 'btn btn--primary btn--block', text: 'Meeting erstellen' });
  const error = el('p', { class: 'sc-error', text: message || '', hidden: !message });
  const form = el('form', { class: 'sc-gate-form' },
    field('Dein Name', name, 'So sehen dich die anderen im Meeting – höchstens 40 Zeichen.'), code, go);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const n = cleanName(name.value);
    if (!n) { name.value = ''; name.focus(); return; }
    error.hidden = true;
    gateBusy(go, 'Schlüssel wird ' + LOCAL + ' erzeugt …');
    try {
      await startMeetingSession(n, code ? code.querySelector('input').value : '');
    } catch (e) {
      gateIdle(go);
      error.textContent = e.message;
      error.hidden = false;
    }
  });
  card.append(
    el('span', { class: 'sc-guest-emblem' }, icon('group', 30)),
    el('h1', { class: 'sc-gate-title sc-guest-title', text: 'Meeting erstellen' }),
    el('p', { class: 'sc-gate-sub', text: 'Mit welchem Namen möchtest du das Meeting eröffnen?' }),
    error, form,
    el('p', { class: 'sc-gate-note', text: 'Kein Konto nötig. Danach bekommst du den Link zum Teilen – wer ihn öffnet, braucht nur einen Namen. Ende-zu-Ende verschlüsselt: Dein Schlüssel entsteht jetzt ' + LOCAL + ' und lebt nur ' + KEY_HOME + '. Verlässt oder beendest du das Meeting, löscht der Server deine Sitzung.' }),
    el('button', { type: 'button', class: 'btn btn--block sc-guest-more', onclick: () => showGate() }, 'Zurück'));
  bootDone();
  setTimeout(() => { if (name.value) go.focus(); else name.focus(); }, 30);
}

async function startMeetingSession(name, code) {
  const identity = await C.generateIdentity();
  const id = C.randomId();
  const card = await C.signCard(identity.privateKey, { v: 1, id: id, kind: 'temp', name: name, ts: Date.now() });
  const r = await api('temp', { id: id, pub: identity.armoredPublic, fp: identity.fingerprint, card: card, code: code });
  S.token = r.token;
  S.mode = 'temp';
  S.meetOnly = true;
  S.vault = emptyVault();
  S.vault.settings.listed = false;   // nur im Meeting zu sehen, nicht in der Online-Liste
  setMe(identity, id, 'temp', name, false);
  S.me.published = identity.armoredPublic;
  ssSet(SS_KEY, { mode: 'temp', meet: 1, id: id, token: r.token, priv: C.armorPrivate(identity.privateKey), vault: S.vault });
  try {
    await api('card', { vis: false });
    const rid = await createRoomOnly(meetingName(), { meet: true, once: true });
    S.meetRid = rid;
    const ss = ssGet(SS_KEY);
    if (ss) { ss.room = rid; ssSet(SS_KEY, ss); }
  } catch (e) {
    // Meeting nicht angelegt: die eben begonnene Sitzung gleich wieder löschen.
    try { await api('end'); } catch (e2) { /* verfällt von selbst */ }
    ssSet(SS_KEY, null);
    S.token = null;
    S.me = null;
    S.meetOnly = false;
    S.meetRid = null;
    throw e;
  }
  await enterApp();
  const room = S.rooms.get(S.meetRid);
  if (room) meetingDialog(room);
}

/* ---------- Gäste eines Einmal-Meetings ------------------------------------
   Wer einen Link #once=… ohne Sitzung öffnet, sieht statt der Anmeldung nur
   die Frage nach dem Namen. Mit der Einladung aus dem Link legt der Server
   eine Gast-Identität an – auch wenn er sonst einen Zugangscode verlangt:
   temporär, nur in diesem einen Meeting, ohne Online-Liste,
   Direktnachrichten und Freunde. Verlässt der Gast das Meeting oder endet
   es, endet auch die Gast-Sitzung. */
function guestCard() {
  $('sc').hidden = true;
  $('sc-gate').hidden = false;
  const card = gateCard();
  card.textContent = '';
  card.classList.add('is-guest');
  card.appendChild(el('p', { class: 'section-head' }, el('span', { class: 'sq' }), el('span', { class: 'label', text: 'CLAVICHAT' }), el('span', { class: 'rule' })));
  return card;
}

function showGuestJoin(message) {
  const join = S.pendingJoin;
  if (!join || !join.once) { showGate(message); return; }
  const card = guestCard();
  const name = el('input', { type: 'text', maxlength: '40', required: true, autocomplete: 'nickname', spellcheck: 'false', placeholder: 'z. B. Alex' });
  const go = el('button', { type: 'submit', class: 'btn btn--primary btn--block', text: 'Meeting beitreten' });
  const error = el('p', { class: 'sc-error', text: message || '', hidden: !message });
  const form = el('form', { class: 'sc-gate-form' }, field('Dein Name', name, 'So sehen dich die anderen im Meeting – höchstens 40 Zeichen.'), go);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const n = cleanName(name.value);
    if (!n) { name.value = ''; name.focus(); return; }
    error.hidden = true;
    gateBusy(go, 'Schlüssel wird ' + LOCAL + ' erzeugt …');
    try {
      await joinAsGuest(join, n);
    } catch (e) {
      gateIdle(go);
      error.textContent = e.message;
      error.hidden = false;
    }
  });
  card.append(
    el('span', { class: 'sc-guest-emblem' }, icon('group', 30)),
    el('h1', { class: 'sc-gate-title sc-guest-title', text: 'Meeting beitreten' }),
    el('p', { class: 'sc-gate-sub', text: 'Mit welchem Namen möchtest du dem Meeting beitreten?' }),
    invitePreviewSlot(join, 'is-gate'),
    error, form,
    el('p', { class: 'sc-gate-note', text: 'Kein Konto nötig. Ende-zu-Ende verschlüsselt: Dein Schlüssel entsteht jetzt ' + LOCAL + ' und lebt nur ' + KEY_HOME + '. Verlässt du das Meeting, löscht der Server deine Gast-Sitzung.' }));
  bootDone();
  setTimeout(() => name.focus(), 30);
}

async function joinAsGuest(join, name) {
  const identity = await C.generateIdentity();
  const id = C.randomId();
  const card = await C.signCard(identity.privateKey, { v: 1, id: id, kind: 'temp', guest: 1, name: name, ts: Date.now() });
  // Die Einladung aus dem Link ist der Zugang (statt eines Zugangscodes).
  const r = await api('temp', { id: id, pub: identity.armoredPublic, fp: identity.fingerprint, card: card, guest: 1, room: join.rid, code: join.code });
  S.token = r.token;
  S.mode = 'temp';
  S.guest = true;
  S.meetRid = join.rid;
  S.vault = emptyVault();
  setMe(identity, id, 'temp', name, false);
  S.me.published = identity.armoredPublic;
  storeRoomKey(join.rid, join.epoch, join.key);
  ssSet(SS_KEY, { mode: 'temp', guest: 1, room: join.rid, id: id, token: r.token, priv: C.armorPrivate(identity.privateKey), vault: S.vault });
  let res;
  try {
    res = await api('room.join', { id: join.rid, code: join.code });
  } catch (e) {
    // Beitritt gescheitert (etwa gerade voll geworden): Gast-Sitzung gleich wieder löschen.
    try { await api('end'); } catch (e2) { /* verfällt von selbst */ }
    ssSet(SS_KEY, null);
    S.token = null;
    S.me = null;
    S.guest = false;
    throw e;
  }
  S.pendingJoin = null;
  ssSet(JOIN_KEY, null);
  ssSet(GUEST_LINK_KEY, join);   // für „Erneut beitreten“ nach dem Verlassen
  // Link eines anderen Teilnehmers: erst warten, bis der Gastgeber zulässt.
  if (res && res.room && res.room.pending) {
    S.guestWait = true;
    const ss = ssGet(SS_KEY);
    if (ss) { ss.wait = 1; ssSet(SS_KEY, ss); }
    showGuestWait();
    return;
  }
  await enterApp();
}

/**
 * Nach dem Ende einer Gast- oder Gastgeber-Sitzung (nach dem Neuladen):
 * verlassen, beendet (vom Gastgeber selbst: 'closed') oder abgelaufen.
 */
function showGuestEnd(note) {
  const card = guestCard();
  const host = !!note.host;
  const kind = ['left', 'expired', 'closed', 'denied', 'noanswer', 'cancelled'].includes(note.kind) ? note.kind : 'ended';
  const text = host ? {
    left: ['Du hast das Meeting verlassen.', 'Deine Sitzung ist beendet – der Server hat deinen Schlüssel gelöscht. War noch jemand mit Sitzung oder Konto drin, läuft das Meeting ohne dich weiter.'],
    closed: ['Du hast das Meeting beendet.', 'Chat und Teilnehmerliste sind gelöscht, der Link gilt nicht mehr. Deine Sitzung ist ebenfalls beendet.'],
    ended: ['Das Meeting ist zu Ende.', 'Das Meeting gibt es nicht mehr, oder du wurdest daraus entfernt. Deine Sitzung ist damit ebenfalls beendet und gelöscht.'],
    expired: ['Deine Sitzung ist abgelaufen.', 'Nach längerer Pause löscht der Server temporäre Sitzungen. Ein neues Meeting ist schnell erstellt.']
  }[kind] : {
    left: ['Du hast das Meeting verlassen.', 'Deine Gast-Sitzung ist beendet – der Server hat deinen Schlüssel und deine Teilnahme gelöscht.'],
    closed: ['Das Meeting wurde beendet.', 'Das Meeting gibt es nicht mehr. Deine Gast-Sitzung ist damit ebenfalls beendet und gelöscht.'],
    ended: ['Das Meeting wurde beendet.', 'Das Meeting gibt es nicht mehr, oder du wurdest daraus entfernt. Deine Gast-Sitzung ist damit ebenfalls beendet und gelöscht.'],
    expired: ['Deine Gast-Sitzung ist abgelaufen.', 'Nach längerer Pause löscht der Server Gast-Sitzungen. Mit dem Link kommst du wieder hinein, solange das Meeting läuft.'],
    denied: ['Beitritt abgelehnt.', 'Der Gastgeber hat deinen Beitritt abgelehnt. Deine Gast-Sitzung ist beendet und gelöscht.'],
    noanswer: ['Keine Antwort vom Gastgeber.', 'Keine Antwort vom Gastgeber – versuche es später noch einmal. Deine Gast-Sitzung ist beendet und gelöscht.'],
    cancelled: ['Beitritt abgebrochen.', 'Du hast nicht länger auf den Gastgeber gewartet. Deine Gast-Sitzung ist beendet und gelöscht.']
  }[kind] || ['Das Meeting ist zu Ende.', ''];
  const link = !host && kind !== 'denied' && note.link && /^[A-Za-z0-9_-]{22}$/.test(note.link.rid || '') ? note.link : null;
  appendAll(card,
    el('span', { class: 'sc-guest-emblem' + (kind === 'left' ? '' : ' is-ended') }, icon(kind === 'left' ? 'leave' : 'group', 30)),
    el('h1', { class: 'sc-gate-title sc-guest-title', text: text[0] }),
    el('p', { class: 'sc-gate-sub', text: text[1] }),
    link ? el('button', { type: 'button', class: 'btn btn--primary btn--block', onclick: () => {
      S.pendingJoin = Object.assign({}, link, { once: true, meet: true });
      showGuestJoin();
    } }, icon('group', 15), 'Erneut beitreten') : null,
    host ? el('button', { type: 'button', class: 'btn btn--primary btn--block', onclick: () => showMeetingStart(note.name || '') }, icon('group', 15), 'Neues Meeting erstellen') : null,
    el('button', { type: 'button', class: 'btn btn--block sc-guest-more', onclick: () => showGate() }, host ? 'Zur Startseite' : 'Zu Clavichat'));
  bootDone();
}

/**
 * Sitzung im Meeting-Modus beenden – Gast oder Gastgeber von der
 * Startseite (Server löscht Identität, Mitgliedschaft und Dateien) – und
 * neu laden; danach steht der Hinweis da. kind: 'left' (selbst verlassen),
 * 'closed' (Gastgeber hat es beendet), 'ended' (Meeting weg), 'expired'
 * (Sitzung weg).
 */
let guestEnding = false;
async function guestEnded(kind) {
  if (guestEnding) return;
  guestEnding = true;
  const host = !S.guest;
  const link = !host && kind !== 'ended' && kind !== 'closed' ? ssGet(GUEST_LINK_KEY) : null;
  const name = S.me ? S.me.name : '';
  teardownMedia();
  if (kind !== 'expired') {
    try { await api('end'); } catch (e) { /* schon weg */ }
  }
  ssSet(GUEST_LINK_KEY, null);
  ssSet(GUEST_END_KEY, host ? { kind: kind, host: 1, name: name } : { kind: kind, link: link });
  await clearStoredSession();
  S.token = null;
  S.me = null;
  location.reload();
}

/** „Meeting verlassen“ im Meeting-Modus: Damit endet auch die Sitzung. */
async function guestLeave() {
  const room = S.rooms.get(S.meetRid);
  const handOver = !S.guest && room && room.owner === S.me.id
    ? ' Ein anderer Teilnehmer mit Sitzung oder Konto übernimmt das Meeting; sind nur noch Gäste da, endet es für alle. Für alle beenden: „Meeting beenden“.' : '';
  const ok = await confirmBox('Meeting verlassen', S.guest
    ? 'Du verlässt das Meeting. Damit endet deine Gast-Sitzung: Der Server löscht deinen Schlüssel und deine Teilnahme. Zurück kommst du über den Link, solange er gilt.'
    : 'Du verlässt das Meeting. Damit endet deine temporäre Sitzung: Der Server löscht deinen Schlüssel und deine Teilnahme.' + handOver, 'Verlassen', true);
  if (ok) guestEnded('left');
}

/** Gast oder Gastgeber von der Startseite: Es gibt nur das eine Meeting. */
function inMeetingMode() {
  return !!(S.guest || S.meetOnly);
}

/**
 * secret: Passwort oder – beim Konto mit dem Postfach (offizieller Server)
 * (sso = Ticket) – ein Wiederherstellungscode. Solche Konten bleiben auf
 * diesem Gerät immer angemeldet.
 */
async function registerAccount(username, secret, identity, remember, code, sso) {
  const keys = await C.accountKeys(username, secret);
  const wrapKey = await C.importWrapKey(keys.wrapRaw, false);
  const id = C.randomId();
  const card = await C.signCard(identity.privateKey, { v: 1, id: id, kind: 'account', name: username, ts: Date.now() });
  const wrapped = await C.sealText(wrapKey, C.armorPrivate(identity.privateKey), keyAad(username));
  S.username = username;
  S.wrapKey = wrapKey;
  S.vault = emptyVault();
  const vault = await C.sealText(wrapKey, JSON.stringify(S.vault), vaultAad());
  const r = await api('register', {
    username: username, auth: keys.auth, id: id, pub: identity.armoredPublic, fp: identity.fingerprint,
    card: card, wrapped: wrapped, vault: vault, code: code, sso: sso || undefined, dev: deviceId()
  });
  rememberLoginCount(id, r.tv);
  const name = r.username || username;
  S.token = r.token;
  S.mode = 'account';
  S.vv = r.vv || 1;
  setMe(identity, id, 'account', name, true);
  S.me.published = identity.armoredPublic;
  const authSealed = sso ? await C.sealText(wrapKey, keys.auth, authAad(name)) : null;
  await rememberAccount(sso ? true : remember, name, id, r.token, wrapped, keys.wrapRaw, authSealed);
  await enterApp();
  if (sso) showRecoveryCode(name, secret, true);
  else showKeyBackup(secret, true);
}

/** Zusatzdaten beim Versiegeln des Anmeldeschlüssels (getrennt von Schlüssel und Tresor). */
function authAad(username) { return 'sc-auth|' + String(username).toLowerCase(); }

/* ---------- Geräte (nur Konten) -------------------------------------------
   Jedes Gerät hat eine zufällige Kennung (bleibt in localStorage). Der Server
   merkt sie sich zur Sitzung: So lässt sich ein Gerät aus der Ferne abmelden,
   ohne dass es sich still wieder anmeldet. Den Gerätenamen sieht er nur
   verschlüsselt. "tv" zählt Anmeldungen neuer Geräte – steigt er, sagen die
   anderen Geräte Bescheid. */
const DEVICE_KEY = 'sc-device';
const LOGINS_KEY = 'sc-logins:';
const GATE_NOTE_KEY = 'securecom.gate-note';
const REVOKED_NOTE = 'Dieses Gerät wurde aus deinem Konto abgemeldet. Melde dich neu an, wenn du es weiter benutzen willst.';

function deviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY) || '';
    if (!/^[A-Za-z0-9_-]{22}$/.test(id)) {
      id = C.randomId();
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch (e) {
    return '';   // ohne localStorage: Sitzung ohne Geräte-Kennung
  }
}

/** Zuletzt gesehener Anmeldezähler des Kontos (null = auf diesem Gerät noch nie). */
function seenLogins(id) {
  try {
    const v = localStorage.getItem(LOGINS_KEY + id);
    return v === null ? null : parseInt(v, 10) || 0;
  } catch (e) { return null; }
}

function rememberLoginCount(id, tv) {
  if (!id || typeof tv !== 'number') return;
  try { localStorage.setItem(LOGINS_KEY + id, String(tv)); } catch (e) { /* egal */ }
}

/** Aus dem Abruf: Hat sich ein neues Gerät angemeldet? */
function checkLogins(tv) {
  if (S.mode !== 'account' || typeof tv !== 'number') return;
  const seen = seenLogins(S.me.id);
  if (seen === tv) return;
  rememberLoginCount(S.me.id, tv);
  if (seen === null || tv < seen) return;   // erstes Mal auf diesem Gerät: nur merken
  toast('Neue Anmeldung bei deinem Konto auf einem anderen Gerät. Warst du das nicht? Melde es unter Einstellungen → Geräte ab und ändere dein Passwort.', 'warn', 20000);
  notify('Neue Anmeldung', 'Ein neues Gerät hat sich bei deinem Konto angemeldet.', 'sc-login');
}

/** „Firefox · Windows“ bzw. „Windows-App“ – nur zum Wiedererkennen in der Liste. */
function deviceName() {
  if (DESKTOP) return 'Windows-App';
  const ua = navigator.userAgent || '';
  const os = /Windows/.test(ua) ? 'Windows'
    : /Android/.test(ua) ? 'Android'
    : /iPhone|iPod/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iPad'
    : /Macintosh|Mac OS X/.test(ua) ? 'macOS'
    : /CrOS/.test(ua) ? 'ChromeOS'
    : /Linux/.test(ua) ? 'Linux' : '';
  const browser = /Edg(e|A|iOS)?\//.test(ua) ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
    : /Firefox\/|FxiOS/.test(ua) ? 'Firefox'
    : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
    : /Chrome\/|CriOS/.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return browser + (os ? ' · ' + os : '');
}

function deviceAad() { return 'sc-device|' + S.me.id; }

/** Gerätenamen verschlüsselt zur Sitzung legen – einmal je Sitzung. */
async function labelDevice() {
  if (S.mode !== 'account' || !S.wrapKey || S.deviceLabeled) return;
  S.deviceLabeled = true;
  try {
    await api('device.label', { n: await C.sealText(S.wrapKey, deviceName(), deviceAad()) });
  } catch (e) { /* ältere Server kennen das nicht */ }
}

/* ==========================================================================
   App-Sperre (PIN) – je Gerät, gehört zur laufenden Anmeldung
   ==========================================================================
   Sperrt beim Start, nach Leerlauf, beim Sperren von Windows (App) und auf
   Knopfdruck. Die gespeicherte Anmeldung (Token, eingepackter Schlüssel,
   versiegelter Anmeldeschlüssel) liegt dann nur mit der PIN verschlüsselt in
   IndexedDB. In der Windows-App ist sie zusätzlich – auch ohne PIN – an das
   Windows-Konto gebunden (DPAPI über Electron safeStorage).
   Die Sperre verdeckt die Oberfläche; im Speicher bleiben die Schlüssel,
   Nachrichten und Anrufe kommen weiter an. Abmelden entfernt sie. */
const LOCK_KEY = 'sc-lock';
const LOCK_FAILS_KEY = 'sc-lock-fails';
const LOCK_MAX_FAILS = 10;
const LOCK_WAIT = [0, 0, 0, 5, 10, 30, 60, 120, 300, 600];   // Pause in Sekunden nach n Fehlversuchen
const LOCK_IDLE = [
  { id: '60', name: 'Nach 1 Minute' },
  { id: '300', name: 'Nach 5 Minuten' },
  { id: '900', name: 'Nach 15 Minuten' },
  { id: '1800', name: 'Nach 30 Minuten' },
  { id: '3600', name: 'Nach 1 Stunde' },
  { id: '0', name: 'Nicht nach Leerlauf' }
];
const LOCK_FORGOT_NOTE = 'Die App-Sperre wurde zurückgesetzt und dieses Gerät abgemeldet. Melde dich neu an.';
const LOCK_FAILED_NOTE = 'Zu viele falsche PINs: Die gespeicherte Anmeldung auf diesem Gerät wurde gelöscht. Melde dich neu an.';
const SESSION_SECRETS = ['token', 'wrapped', 'authSealed'];
const L = { cfg: null, key: null, locked: false, box: null, hidden: [], resolve: null, pending: null, timer: 0, waitTimer: 0 };

function lockCfg() {
  try {
    const c = JSON.parse(localStorage.getItem(LOCK_KEY) || 'null');
    return c && c.v === 1 && c.salt && c.chk ? c : null;
  } catch (e) { return null; }
}

function saveLockCfg(cfg) {
  try {
    if (cfg) localStorage.setItem(LOCK_KEY, JSON.stringify(cfg));
    else localStorage.removeItem(LOCK_KEY);
  } catch (e) { /* ohne localStorage keine Sperre */ }
}

function lockFails() {
  try { return JSON.parse(localStorage.getItem(LOCK_FAILS_KEY) || 'null') || { n: 0, t: 0 }; } catch (e) { return { n: 0, t: 0 }; }
}

function setLockFails(f) {
  try {
    if (f && f.n) localStorage.setItem(LOCK_FAILS_KEY, JSON.stringify(f));
    else localStorage.removeItem(LOCK_FAILS_KEY);
  } catch (e) { /* egal */ }
}

/** Millisekunden, die nach Fehlversuchen noch zu warten sind. */
function lockWaitLeft() {
  const f = lockFails();
  const wait = LOCK_WAIT[Math.min(f.n, LOCK_WAIT.length - 1)] * 1000;
  return Math.max(0, f.t + wait - Date.now());
}

function lockAad(what) { return 'sc-lock|' + what; }

/** PIN prüfen: Schlüssel oder null. */
async function tryPin(cfg, pin) {
  if (!cfg || !pin) return null;
  try {
    const key = await C.derivePinKey(pin, C.unb64(cfg.salt), cfg.it);
    await C.openText(key, cfg.chk, lockAad('check'));
    return key;
  } catch (e) { return null; }
}

async function makeLockCfg(pin, idle) {
  const salt = C.randomBytes(16);
  const key = await C.derivePinKey(pin, salt, C.KDF_ITERATIONS);
  const cfg = { v: 1, salt: C.b64(salt), it: C.KDF_ITERATIONS, chk: await C.sealText(key, 'clavichat', lockAad('check')), idle: idle };
  if (/^\d+$/.test(pin)) cfg.num = 1;
  return { key: key, cfg: cfg };
}

/** Sperre aus: beim Abmelden oder nach dem Zurücksetzen. */
function removeLock() {
  saveLockCfg(null);
  setLockFails(null);
  L.cfg = null;
  L.key = null;
}

/* ---------- Gespeicherte Anmeldung versiegeln ------------------------------ */
async function desktopSeal(text) {
  if (!DESKTOP || !DESKTOP.secure) return null;
  try {
    const r = await DESKTOP.secure.seal(text);
    return typeof r === 'string' && r ? r : null;
  } catch (e) { return null; }
}

async function desktopOpen(text) {
  if (!DESKTOP || !DESKTOP.secure) return null;
  try {
    const r = await DESKTOP.secure.open(text);
    return typeof r === 'string' ? r : null;
  } catch (e) { return null; }
}

/** Ablegen: Geheimes mit PIN und (App) DPAPI versiegelt, sonst wie bisher. */
async function storeSession(rec) {
  if (!rec) return idbSet('session', null);
  // Sperre eingerichtet, aber ihr Schlüssel fehlt (PIN in einem anderen Tab
  // geändert): lieber nichts schreiben als ohne PIN.
  if (!L.key && lockCfg()) return undefined;
  const secret = {};
  const out = {};
  for (const k of Object.keys(rec)) {
    if (k.charAt(0) === '_') continue;
    if (SESSION_SECRETS.includes(k)) secret[k] = rec[k];
    else out[k] = rec[k];
  }
  let d = JSON.stringify(secret);
  const box = { v: 1 };
  if (L.key) {
    d = await C.sealText(L.key, d, lockAad('session|' + rec.id));
    box.pin = 1;
  }
  const sealed = await desktopSeal(d);
  if (sealed) { d = sealed; box.dp = 1; }
  if (!box.pin && !box.dp) return idbSet('session', Object.assign(out, secret));
  box.d = d;
  out.box = box;
  return idbSet('session', out);
}

/** Öffnen: null, wenn nichts gespeichert ist; wirft, wenn es sich nicht öffnen lässt. */
async function loadSession() {
  const rec = await idbGet('session');
  if (!rec) return null;
  if (!rec.box) return Object.assign({}, rec, { _plain: true });
  let d = rec.box.d;
  if (rec.box.dp) {
    d = await desktopOpen(d);
    if (d === null) throw new Error('Die gespeicherte Anmeldung gehört zu einem anderen Windows-Konto.');
  }
  if (rec.box.pin) {
    if (!L.key) throw new Error('Clavichat ist gesperrt.');
    d = await C.openText(L.key, d, lockAad('session|' + rec.id));
  }
  const out = Object.assign({}, rec, JSON.parse(d));
  delete out.box;
  return out;
}

/** Läuft auf diesem Gerät eine Anmeldung (ohne sie zu öffnen)? */
async function hasStoredSession() {
  return !!ssGet(SS_KEY) || !!(await idbGet('session'));
}

/* ---------- Sperrbildschirm --------------------------------------------- */
/** Sperren. atStart: beim Start, bevor die gespeicherte Anmeldung offen ist. */
function showLock(atStart) {
  if (L.locked) return L.pending || Promise.resolve(true);
  L.locked = true;
  document.documentElement.classList.add('sc-is-locked');
  for (const n of document.body.children) {
    if (!n.inert) { n.inert = true; L.hidden.push(n); }
  }
  closeContextMenu();
  const card = el('div', { class: 'sc-lockscreen-card tickbox' });
  const box = el('div', { id: 'sc-lockscreen', class: 'sc-lockscreen', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Clavichat ist gesperrt' }, card);
  document.body.appendChild(box);
  L.box = box;
  drawLockForm(card, atStart);
  L.pending = new Promise((resolve) => { L.resolve = resolve; });
  return L.pending;
}

function lockHead(text) {
  return el('p', { class: 'section-head' }, el('span', { class: 'sq' }), el('span', { class: 'label', text: text }), el('span', { class: 'rule' }));
}

function drawLockForm(card, atStart) {
  clearTimeout(L.waitTimer);
  const input = el('input', { type: 'password', autocomplete: 'off', maxlength: '32', 'aria-label': 'PIN', placeholder: 'PIN', inputmode: L.cfg && L.cfg.num ? 'numeric' : null });
  const go = el('button', { type: 'submit', class: 'btn btn--primary btn--block', text: 'Entsperren' });
  const msg = el('p', { class: 'sc-lockscreen-msg', role: 'alert' });
  const call = el('p', { class: 'sc-lockscreen-call', hidden: true }, icon('phone', 14), 'Eingehender Anruf – entsperre, um ihn anzunehmen.');
  const form = el('form', { class: 'sc-lockscreen-form' }, input, go);
  const forgot = el('button', { type: 'button', class: 'sc-lockscreen-forgot', text: 'PIN vergessen?', onclick: () => drawLockForgot(card, atStart) });
  card.replaceChildren(lockHead('CLAVICHAT GESPERRT'),
    el('div', { class: 'sc-lockscreen-icon' }, icon('lock', 30)),
    el('p', { class: 'sc-lockscreen-who', text: S.me && S.me.name ? 'Angemeldet als ' + S.me.name : 'PIN eingeben, um Clavichat zu öffnen.' }),
    form, msg, call, forgot);

  const waitTick = () => {
    clearTimeout(L.waitTimer);
    const left = lockWaitLeft();
    input.disabled = go.disabled = left > 0;
    if (left > 0) {
      msg.textContent = 'Zu viele falsche Versuche – warte noch ' + Math.ceil(left / 1000) + ' s.';
      L.waitTimer = setTimeout(waitTick, 1000);
    } else if (/warte noch/.test(msg.textContent)) {
      msg.textContent = '';
      input.focus();
    }
  };
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (lockWaitLeft() > 0 || go.disabled || !input.value) return;
    go.disabled = true;
    go.textContent = 'Wird geprüft …';
    const key = await tryPin(L.cfg, input.value);
    go.textContent = 'Entsperren';
    go.disabled = false;
    if (!key) {
      const n = lockFails().n + 1;
      setLockFails({ n: n, t: Date.now() });
      input.value = '';
      if (n >= LOCK_MAX_FAILS) { resetLock(LOCK_FAILED_NOTE); return; }
      const left = LOCK_MAX_FAILS - n;
      msg.textContent = 'Falsche PIN.' + (left <= 5 ? ' Noch ' + left + (left === 1 ? ' Versuch' : ' Versuche') + ', dann wird die gespeicherte Anmeldung gelöscht.' : '');
      waitTick();
      if (!input.disabled) input.focus();
      return;
    }
    setLockFails(null);
    L.key = key;
    unlockNow();
  });
  renderLockCall();
  waitTick();
  setTimeout(() => { if (!input.disabled) input.focus(); }, 30);
}

function drawLockForgot(card, atStart) {
  clearTimeout(L.waitTimer);
  const go = el('button', { type: 'button', class: 'btn sc-btn--danger', text: 'Abmelden & zurücksetzen' });
  go.addEventListener('click', () => { go.disabled = true; resetLock(LOCK_FORGOT_NOTE); });
  card.replaceChildren(lockHead('PIN VERGESSEN'),
    el('p', { class: 'sc-p', text: 'Ohne PIN lässt sich die gespeicherte Anmeldung nicht öffnen. Zurücksetzen meldet dieses Gerät ab – danach meldest du dich mit Passwort oder Wiederherstellungscode neu an. Eine temporäre Sitzung endet dabei.' }),
    el('div', { class: 'sc-card-actions' },
      el('button', { type: 'button', class: 'btn', text: 'Zurück', onclick: () => drawLockForm(card, atStart) }),
      go));
}

function restoreInert() {
  for (const n of L.hidden) n.inert = false;
  L.hidden = [];
}

function unlockNow() {
  if (!L.locked) return;
  L.locked = false;
  clearTimeout(L.waitTimer);
  document.documentElement.classList.remove('sc-is-locked');
  restoreInert();
  if (L.box) L.box.remove();
  L.box = null;
  P.lastInput = Date.now();   // nicht gleich wieder sperren
  const done = L.resolve;
  L.resolve = null;
  L.pending = null;
  if (done) done(true);
  if (S.entered) { renderAll(); markRead(); }
}

/** Eingehender Anruf, während gesperrt ist: Hinweis auf dem Sperrbildschirm. */
function renderLockCall() {
  if (!L.box) return;
  const line = L.box.querySelector('.sc-lockscreen-call');
  if (line) line.hidden = !(S.call && S.call.state === 'incoming');
}

/** PIN vergessen oder zu viele Fehlversuche: abmelden, Sperre weg, neu laden. */
async function resetLock(note) {
  try {
    const ss = ssGet(SS_KEY);
    if (S.token) {
      // Läuft schon: Sitzung beim Server beenden.
      if (S.mode === 'temp') await api('end');
      else await api('logout');
    } else if (ss && ss.mode === 'temp' && ss.token) {
      S.token = ss.token;
      await api('end');
    }
  } catch (e) { /* Server nicht erreichbar – lokal trotzdem zurücksetzen */ }
  teardownMedia();
  await clearStoredSession();
  ssSet(GATE_NOTE_KEY, note);
  location.reload();
}

function lockNow() {
  if (!L.cfg || L.locked || !S.entered) return;
  showLock(false);
}

/** Leerlauf prüfen (alle 10 Sekunden). Nicht mitten in einem Gespräch. */
async function lockTick() {
  if (!L.cfg || !L.cfg.idle || L.locked || !S.entered || S.call || S.voice) return;
  if (await idleSeconds() >= L.cfg.idle) lockNow();
}

function startLockTimer() {
  if (L.timer) return;
  L.timer = setInterval(lockTick, 10000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) lockTick(); });
  if (DESKTOP && typeof DESKTOP.onLock === 'function') DESKTOP.onLock(lockNow);
  // PIN in einem anderen Tab geändert oder entfernt: hier neu entsperren.
  window.addEventListener('storage', (ev) => {
    if (ev.key !== LOCK_KEY) return;
    const cfg = lockCfg();
    if (!cfg) { L.cfg = null; L.key = null; renderUser(); return; }
    L.cfg = cfg;
    L.key = null;
    if (!L.locked) showLock(false);
  });
}

/* ==========================================================================
   Forward Secrecy
   ==========================================================================
   Direktnachrichten: Jede Woche hängt ein Gerät einen neuen Verschlüsselungs-
   Unterschlüssel an den eigenen PGP-Schlüssel (Absender nehmen den jüngsten)
   und löscht alte, sobald ihr Nachfolger länger da ist als die höchste
   Aufbewahrung plus zwei Tage – alles, was an sie ging, ist dann beim Server
   abgelaufen. Konten legen den aktuellen Schlüssel in den Tresor (`ik`),
   damit alle Geräte ihn haben; es wechselt immer nur eins (key.lease). Der
   beim Server eingepackte Schlüssel wird ersetzt, sobald Passwort oder Code
   zur Hand sind (Anmelden; Konten mit Code jederzeit).
   Räume: Der Besitzer wechselt den Raumschlüssel jede Woche (nicht, solange
   Einladungslinks offen sind); jedes Mitglied löscht alte Generationen nach
   der Aufbewahrung des Raums. */
const KEY_ROTATE = 7 * 86400000;     // neuer Unterschlüssel bzw. Raumschlüssel
const KEY_GRACE = 2 * 86400000;      // Puffer für Absender mit älterem Stand
const KEY_CHECK = 6 * 3600000;       // so oft nachsehen
const IDENT_FRESH = 6 * 3600000;     // Schlüssel anderer vor dem Senden höchstens so alt
const FS = { timer: 0, busy: false, lastRefresh: 0 };

/** Was an alte Unterschlüssel ging, ist nach dieser Zeit sicher abgelaufen. */
function keyKeep() {
  return maxTtl() * 1000 + KEY_GRACE;
}

function samePub(a, b) {
  const norm = (s) => String(s || '').replace(/\r\n/g, '\n').trim();
  return norm(a) === norm(b);
}

/** Eigenen Schlüssel übernehmen (nach einem Wechsel hier oder auf einem anderen Gerät). */
function applyOwnKey(ident) {
  S.me.priv = ident.privateKey;
  S.me.pub = ident.publicKey;
  S.me.armored = ident.armoredPublic;
  const me = S.ids.get(S.me.id);
  if (me) { me.key = ident.publicKey; me.armored = ident.armoredPublic; }
  S.keyringCache = null;
}

/** Der Schlüssel aus dem Tresor, wenn er zu dieser Identität gehört – sonst null. */
async function vaultKey(fp) {
  const ik = S.vault && S.vault.ik;
  if (!ik || typeof ik.k !== 'string') return null;
  try {
    const ident = await C.readPrivateIdentity(ik.k);
    return ident.fingerprint === fp ? ident : null;
  } catch (e) {
    return null;
  }
}

/** Steht im Tresor ein neuerer Stand (ein anderes Gerät hat gewechselt)? Dann übernehmen. */
async function adoptVaultKey() {
  if (S.mode !== 'account' || !S.me) return false;
  const ident = await vaultKey(S.me.fp);
  if (!ident || samePub(ident.armoredPublic, S.me.armored)) return false;
  if (C.newestEncryptionSubkey(ident.privateKey) < C.newestEncryptionSubkey(S.me.priv)) return false;
  applyOwnKey(ident);
  await storeWrapped().catch(() => {});
  return true;
}

/** Tresor neu holen und einen neueren eigenen Schlüssel übernehmen (höchstens alle 30 s). */
async function refreshOwnKey(force) {
  if (S.mode !== 'account' || !S.wrapKey) return false;
  if (!force && Date.now() - FS.lastRefresh < 30000) return false;
  FS.lastRefresh = Date.now();
  try {
    const v = await api('vault.get');
    if (v.vault) {
      S.vault = mergeVault(JSON.parse(await C.openText(S.wrapKey, v.vault, vaultAad())), S.vault);
      S.vv = v.vv;
    }
  } catch (e) {
    return false;
  }
  return adoptVaultKey();
}

/** Für mich verschlüsselt (PGP): öffnen – fehlt ein frischer Unterschlüssel, ihn holen und nochmal. */
async function openForMe(data, ring) {
  try {
    return await C.openSealed(data, S.me.priv, ring);
  } catch (err) {
    if (!(await refreshOwnKey())) throw err;
    return C.openSealed(data, S.me.priv, ring);
  }
}

/** Die gespeicherte Anmeldung dieses Geräts mit dem aktuellen Schlüssel (alte Unterschlüssel weg). */
async function storeWrapped() {
  if (S.mode !== 'account' || !S.wrapKey) return null;
  const wrapped = await C.sealText(S.wrapKey, C.armorPrivate(S.me.priv), keyAad(S.username));
  const ss = ssGet(SS_KEY);
  if (ss && ss.mode === 'account') {
    ss.wrapped = wrapped;
    ssSet(SS_KEY, ss);
  } else {
    const rec = await loadSession().catch(() => null);
    if (rec && rec.mode === 'account') { rec.wrapped = wrapped; await storeSession(rec); }
  }
  return wrapped;
}

/** Auch beim Server den eingepackten Schlüssel ersetzen – braucht Passwort oder Code (hier: Konten mit Code). */
async function rewrapOnServer(wrapped) {
  try {
    const rec = await loadSession();
    if (!rec || !rec.authSealed) return;
    const auth = await C.openText(S.wrapKey, rec.authSealed, authAad(S.username));
    await api('key.wrap', { auth: auth, wrapped: wrapped });
  } catch (e) { /* beim nächsten Mal */ }
}

/** Schlüssel anderer auffrischen, wenn der Stand älter als IDENT_FRESH ist (neue Unterschlüssel). */
async function freshIds(ids) {
  const old = [...new Set(ids)].filter((id) => {
    const i = S.ids.get(id);
    return typeof id === 'string' && id !== S.me.id && (!i || Date.now() - (i.at || 0) > IDENT_FRESH);
  });
  for (let i = 0; i < old.length; i += 100) {
    try {
      const r = await api('ids', { ids: old.slice(i, i + 100) });
      for (const raw of r.list) await resolveIdentity(raw);
    } catch (e) { /* der bisherige Stand tut es auch */ }
  }
}

/** Nach dem Start und alle 6 Stunden. */
function startKeyCare() {
  if (FS.timer) return;
  FS.timer = setInterval(maintainKeys, KEY_CHECK);
  setTimeout(maintainKeys, 8000);
}

async function maintainKeys() {
  if (!S.me || !S.token || FS.busy) return;
  FS.busy = true;
  try {
    await maintainOwnKey();
  } catch (e) { /* ältere Server kennen das nicht – oder nächstes Mal */ }
  try {
    await maintainRoomKeys();
  } catch (e) { /* nächstes Mal */ }
  FS.busy = false;
}

async function maintainOwnKey() {
  const now = serverNow();
  const due = () => {
    const list = C.encryptionSubkeys(S.me.priv);
    return {
      rotate: now - C.newestEncryptionSubkey(S.me.priv) > KEY_ROTATE,
      prune: list.some((s, i) => i < list.length - 1 && now - list[i + 1].created > keyKeep()),
      // Beim Server liegt noch ein älterer öffentlicher Schlüssel (Veröffentlichen ging schief).
      publish: typeof S.me.published === 'string' && !samePub(S.me.published, S.me.armored)
    };
  };
  let need = due();
  if (!need.rotate && !need.prune && !need.publish) return;
  if (S.mode === 'account') {
    await refreshOwnKey(true);   // vielleicht war ein anderes Gerät schneller
    need = due();
    if (!need.rotate && !need.prune && !need.publish) return;
  }
  const lease = await api('key.lease');
  if (lease.lease !== true) return;   // ein anderes Gerät ist gerade dran
  let key = S.me.priv;
  if (need.rotate) key = await C.addEncryptionSubkey(key);
  key = (await C.pruneEncryptionSubkeys(key, keyKeep(), now)).key;
  const ident = await C.identityFromPrivate(key);
  // Erst die private Seite sichern (Tresor bzw. Tab), dann veröffentlichen –
  // sonst gingen Nachrichten an einen Unterschlüssel, den kein Gerät hat.
  if (S.mode === 'account') {
    S.vault.ik = { k: C.armorPrivate(ident.privateKey), t: serverNow() };
    await saveVault(true);
  } else {
    const ss = ssGet(SS_KEY);
    if (ss) { ss.priv = C.armorPrivate(ident.privateKey); ssSet(SS_KEY, ss); }
  }
  await api('key.pub', { pub: ident.armoredPublic, fp: ident.fingerprint });
  applyOwnKey(ident);
  S.me.published = ident.armoredPublic;
  if (S.mode === 'account') {
    const wrapped = await storeWrapped();
    if (wrapped) await rewrapOnServer(wrapped);
  }
}

async function maintainRoomKeys() {
  const now = serverNow();
  let changed = false;
  for (const room of S.rooms.values()) {
    const r = S.vault.rooms[room.id];
    if (!r || !r.k) continue;
    r.et = r.et || {};
    if (!r.et[room.epoch] && r.k[room.epoch]) { r.et[room.epoch] = now; changed = true; }   // ältere Räume: ab jetzt zählen
    // „Permanent“: alle Generationen behalten (sonst wären ältere Nachrichten
    // nach einem Schlüsselwechsel unlesbar) und kein Wechsel jede Woche – er
    // brächte ohne Löschen keine Forward Secrecy, nur mehr Schlüssel.
    // Nach Entfernen/Verlassen wechselt der Besitzer weiter (roomSys).
    // Maßgeblich ist die längste Aufbewahrung im Raum: Ein permanenter (oder
    // längerer) Textkanal braucht die alten Generationen auch in einem Raum
    // mit kürzerer Frist.
    if (keepsPermanent(room)) continue;
    // Alte Generationen löschen, sobald ihr Nachfolger länger da ist als die längste Aufbewahrung im Raum.
    const keep = roomKeepTtl(room) * 1000 + KEY_GRACE;
    for (const e of Object.keys(r.k).map(Number).sort((a, b) => a - b)) {
      if (e >= room.epoch) break;
      const next = r.et[e + 1];
      if (!next || now - next <= keep) break;
      delete r.k[e];
      delete r.et[e];
      S.roomKeys.delete(room.id + ':' + e);
      r.gone = Math.max(r.gone || 0, e);
      changed = true;
    }
    // Besitzer: jede Woche ein neuer Raumschlüssel – nicht, solange Einladungslinks offen sind.
    if (room.owner === S.me.id && room.iv === 0 && r.et[room.epoch] && now - r.et[room.epoch] > KEY_ROTATE) {
      rotateRoom(room.id, false, true);
    }
  }
  if (changed) await saveVault(true);
  // Verlauf für neue Mitglieder: gelöschte Generationen auch aus dem Archiv nehmen.
  for (const room of S.rooms.values()) if (histOk(room) && (histOn(room) || room.meta.hist) && !S.rotating.has(room.id)) await refreshKeyArchive(room);
}

async function loginAccount(username, password, remember) {
  if (!username || !password) throw new Error('Bitte Name und Passwort oder Wiederherstellungscode angeben.');
  const keys = await C.accountKeys(username, password);
  S.token = null;
  const r = await api('login', { username: username, auth: keys.auth, dev: deviceId() });
  rememberLoginCount(r.id, r.tv);   // die eigene Anmeldung ist keine „neue Anmeldung“
  const wrapKey = await C.importWrapKey(keys.wrapRaw, false);
  let identity;
  try {
    identity = await C.readPrivateIdentity(await C.openText(wrapKey, r.wrapped, keyAad(r.username)));
  } catch (e) {
    throw new Error('Der Schlüssel ließ sich nicht auspacken.');
  }
  S.token = r.token;
  S.mode = 'account';
  S.username = r.username;
  S.wrapKey = wrapKey;
  S.vv = r.vv || 1;
  S.vault = emptyVault();
  if (r.vault) {
    try { S.vault = mergeVault(emptyVault(), JSON.parse(await C.openText(wrapKey, r.vault, vaultAad()))); } catch (e) { /* leer */ }
  }
  // Forward Secrecy: Hat ein Gerät den Unterschlüssel gewechselt, steht der
  // aktuelle Schlüssel im Tresor. Mit dem Passwort zur Hand gleich auch den
  // beim Server eingepackten ersetzen – ohne die gelöschten Unterschlüssel.
  let wrapped = r.wrapped;
  const current = await vaultKey(identity.fingerprint);
  if (current && !samePub(current.armoredPublic, identity.armoredPublic) &&
      C.newestEncryptionSubkey(current.privateKey) >= C.newestEncryptionSubkey(identity.privateKey)) {
    identity = current;
    wrapped = await C.sealText(wrapKey, C.armorPrivate(identity.privateKey), keyAad(r.username));
    api('key.wrap', { auth: keys.auth, wrapped: wrapped }).catch(() => {});
  }
  setMe(identity, r.id, 'account', r.username, r.vis !== false);
  S.me.published = r.pub;
  await applyOwnCard(r.card);
  // Mit Wiederherstellungscode angemeldet: Das Gerät soll nie wieder danach fragen.
  const authSealed = remember && C.isRecoveryCode(password) ? await C.sealText(wrapKey, keys.auth, authAad(r.username)) : null;
  await rememberAccount(remember, r.username, r.id, r.token, wrapped, keys.wrapRaw, authSealed);
  await enterApp();
}

/**
 * Angemeldet bleiben: in IndexedDB mit einem nicht auslesbaren
 * Schlüssel-Objekt. Sonst nur für diesen Tab (sessionStorage).
 * authSealed (nur Konten mit Wiederherstellungscode): der Anmeldeschlüssel,
 * mit eben diesem Schlüssel-Objekt versiegelt. Läuft die Sitzung ab, meldet
 * sich das Gerät damit still neu an – ohne den Code. Neue Angriffsfläche
 * entsteht so nicht: Wer an das Schlüssel-Objekt kommt, packt damit ohnehin
 * schon den privaten Schlüssel aus.
 */
async function rememberAccount(remember, username, id, token, wrapped, wrapRaw, authSealed) {
  S.codeAccount = !!authSealed;
  if (remember) {
    const key = await C.importWrapKey(wrapRaw, false);
    const rec = { mode: 'account', username: username, id: id, token: token, wrapped: wrapped, wrapKey: key };
    if (authSealed) rec.authSealed = authSealed;
    await storeSession(rec);   // mit PIN bzw. (App) an das Windows-Konto gebunden
    ssSet(SS_KEY, null);
  } else {
    await idbSet('session', null);
    ssSet(SS_KEY, { mode: 'account', username: username, id: id, token: token, wrapped: wrapped, wrap: C.b64(wrapRaw) });
  }
}

function setMe(identity, id, kind, name, vis) {
  S.me = {
    id: id,
    kind: kind,
    name: cleanName(name),
    fp: identity.fingerprint,
    priv: identity.privateKey,
    pub: identity.publicKey,
    armored: identity.armoredPublic,
    vis: kind === 'temp' && vis !== false   // Konten stehen nie in der Online-Liste
  };
  S.ids.set(id, { id: id, kind: kind, guest: kind === 'temp' && !!S.guest, fp: identity.fingerprint, key: identity.publicKey, armored: identity.armoredPublic, cv: 0, name: S.me.name, on: true, changed: false });
  S.keyringCache = null;
}

/** Nach dem Neuladen: Sitzung aus dem Tab oder aus IndexedDB. */
async function restoreSession() {
  const ss = ssGet(SS_KEY);
  let saved = null;
  try {
    if (ss && ss.mode === 'temp') {
      const identity = await C.readPrivateIdentity(ss.priv);
      S.token = ss.token;
      S.mode = 'temp';
      S.guest = !!ss.guest;
      S.meetOnly = !S.guest && !!ss.meet;   // Gastgeber eines Meetings von der Startseite
      S.meetRid = typeof ss.room === 'string' ? ss.room : null;
      S.guestWait = S.guest && !!ss.wait && !!S.meetRid;   // Gast wartet noch auf den Gastgeber
      S.vault = mergeVault(emptyVault(), ss.vault || {});
      setMe(identity, ss.id, 'temp', '', !inMeetingMode());
    } else {
      saved = ss && ss.mode === 'account' ? ss : await loadSession();
      if (!saved || saved.mode !== 'account') return false;
      const wrapKey = saved.wrapKey || await C.importWrapKey(C.unb64(saved.wrap), false);
      const identity = await C.readPrivateIdentity(await C.openText(wrapKey, saved.wrapped, keyAad(saved.username)));
      S.token = saved.token;
      S.mode = 'account';
      S.username = saved.username;
      S.wrapKey = wrapKey;
      S.codeAccount = !!saved.authSealed;
      S.vault = emptyVault();
      setMe(identity, saved.id, 'account', saved.username, true);
    }
  } catch (e) {
    await clearStoredSession();
    return false;
  }

  const loadOwn = async () => {
    const me = await api('me');
    S.me.vis = S.mode === 'temp' && me.vis !== false;
    if (me.guest === true) { S.guest = true; S.meetOnly = false; }   // der Server weiß es sicher
    S.me.published = me.pub;
    S.deviceLabeled = me.dl === true;
    await applyOwnCard(me.card);
    if (S.mode === 'account') {
      const v = await api('vault.get');
      S.vv = v.vv;
      if (v.vault) S.vault = mergeVault(emptyVault(), JSON.parse(await C.openText(S.wrapKey, v.vault, vaultAad())));
      await adoptVaultKey();   // Forward Secrecy: Unterschlüssel eines anderen Geräts übernehmen
    }
  };
  try {
    await loadOwn();
  } catch (e) {
    if (e.status !== 401) return true;   // ohne Netz: trotzdem öffnen, der Abruf versucht es weiter
    // Sitzung abgelaufen – Konten mit Wiederherstellungscode melden sich still neu an.
    try {
      if (!saved || !saved.authSealed) throw e;
      const r = await api('login', { username: saved.username, auth: await C.openText(S.wrapKey, saved.authSealed, authAad(saved.username)), dev: deviceId(), silent: 1 });
      rememberLoginCount(r.id, r.tv);
      S.token = r.token;
      saved = Object.assign({}, saved, { token: r.token });
      await storeSession(saved);
      await loadOwn();
    } catch (again) {
      if ([again, e].some((x) => x && x.data && x.data.revoked)) S.gateNote = REVOKED_NOTE;
      if (S.guest) ssSet(GUEST_END_KEY, { kind: 'expired', link: ssGet(GUEST_LINK_KEY) });
      else if (S.meetOnly) ssSet(GUEST_END_KEY, { kind: 'expired', host: 1 });
      await clearStoredSession();
      S.token = null;
      S.me = null;
      return false;
    }
  }
  // Noch offen gespeichert (ältere Version): jetzt versiegeln – mit PIN bzw.
  // an das Windows-Konto gebunden. Frisch gelesen: adoptVaultKey kann den
  // eingepackten Schlüssel inzwischen erneuert haben.
  if (saved && saved._plain && (L.key || (DESKTOP && DESKTOP.secure))) {
    loadSession().then((rec) => (rec ? storeSession(rec) : null)).catch(() => {});
  }
  return true;
}

/** Gespeicherte Anmeldung weg – und mit ihr die App-Sperre, die zu ihr gehört. */
async function clearStoredSession() {
  removeLock();
  ssSet(SS_KEY, null);
  await idbSet('session', null);
}

let lost = false;
function sessionLost(data) {
  if (lost) return;
  lost = true;
  // Gäste und Gastgeber im Meeting-Modus: Sitzung weg (lange Pause) – Hinweis statt Anmeldung.
  if (inMeetingMode()) { guestEnded('expired'); return; }
  // Konten mit Wiederherstellungscode behalten das Gespeicherte: Beim
  // Neuladen meldet sich das Gerät still neu an (restoreSession). Klappt das
  // nicht – etwa weil der Code auf einem anderen Gerät erneuert wurde –,
  // räumt restoreSession selbst auf. Aus der Ferne abgemeldet: nie still.
  const revoked = !!(data && data.revoked);
  if (revoked) ssSet(GATE_NOTE_KEY, REVOKED_NOTE);
  (S.codeAccount && !revoked ? Promise.resolve() : clearStoredSession()).then(() => {
    teardownMedia();
    S.token = null;
    S.me = null;
    location.reload();
  });
}

async function logout() {
  if (S.mode === 'temp') {
    const ok = await confirmBox('Sitzung beenden', 'Die temporäre Sitzung wird beendet. Der Server löscht deine Identität, deinen Briefkasten und deine Raummitgliedschaften. Dein Schlüssel ist danach weg.', 'Beenden', true);
    if (!ok) return;
    await clearPresence();
    try { await api('end'); } catch (e) { /* trotzdem lokal beenden */ }
  } else {
    await clearPresence();
    try { await api('logout'); } catch (e) { /* Token ist ohnehin weg */ }
  }
  teardownMedia();
  await clearStoredSession();
  location.reload();
}

/* ==========================================================================
   Start der Anwendung
   ========================================================================== */
async function enterApp() {
  S.entered = true;
  // Gäste (und Gastgeber eines Meetings von der Startseite) sehen nur ihr
  // Meeting: keine Raumleiste, keine Startseite.
  document.body.classList.toggle('sc-guest', inMeetingMode());
  $('sc-gate').hidden = true;
  $('sc').hidden = false;
  S.convs.clear();
  const saved = ssGet('securecom.view');
  if (saved && saved.kind) S.view = saved;
  if (inMeetingMode()) {
    const loaded = await loadRooms().then(() => true, () => false);
    if (!S.meetRid || !S.rooms.has(S.meetRid)) S.meetRid = [...S.rooms.keys()][0] || S.meetRid;
    // Meeting inzwischen beendet (oder entfernt): Hinweis statt leerer Oberfläche.
    if (loaded && !S.rooms.has(S.meetRid)) { guestEnded('ended'); return; }
    const room = S.rooms.get(S.meetRid);
    if (room) S.view = { kind: 'room', rid: room.id, ch: room.meta.ch[0].id };
  }
  renderAll();
  bootDone();
  refreshOnline();
  loadIce();
  startIceRefresh();
  labelDevice();
  startLockTimer();
  startKeyCare();   // Forward Secrecy: Unter- und Raumschlüssel wechseln, alte löschen
  await loadRooms().catch(() => {});
  if (S.view.kind === 'room' && !S.rooms.has(S.view.rid)) S.view = { kind: 'home' };
  if (S.view.kind === 'dm') await ensureIds([S.view.peer]);
  renderAll();
  pollLoop();
  // Freunde: Identitäten nachschlagen, dann Status austauschen.
  ensureIds(Object.keys(S.vault.friends || {})).then(() => { scheduleRender(); presenceSoon(); });
  startPresence();
  // Aufbewahrung: jede Minute Abgelaufenes aus der Ansicht und vom Server.
  if (!TRIM.purge) TRIM.purge = setInterval(purgeExpired, 60000);
  if (S.pendingJoin) setTimeout(offerPendingJoin, 400);
}

function parseJoinFragment() {
  // #join= tritt einem Raum bei, #meet= einem (festen) Meeting, #once= einem
  // Einmal-Meeting – dorthin auch ohne Sitzung, als Gast mit Namen.
  const m = /^#(join|meet|once)=([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})\.(\d{1,6})$/.exec(location.hash || '');
  if (m) {
    S.pendingJoin = { rid: m[2], code: m[3], key: m[4], epoch: parseInt(m[5], 10), meet: m[1] !== 'join', once: m[1] === 'once' };
    ssSet(JOIN_KEY, S.pendingJoin);
    // Den Schlüssel sofort aus der Adresszeile (und dem Verlauf) nehmen.
    history.replaceState(null, '', location.pathname + location.search);
  } else {
    S.pendingJoin = ssGet(JOIN_KEY);
  }
}

async function offerPendingJoin() {
  if (!S.pendingJoin) return;
  // Erst den offenen Dialog fertig werden lassen (etwa „Schlüssel sichern“ gleich nach dem Erstellen eines Kontos).
  while (modalClose && S.token) await sleep(400);
  const join = S.pendingJoin;
  if (!join || !S.token) return;
  S.pendingJoin = null;
  ssSet(JOIN_KEY, null);
  if (inMeetingMode()) {
    // Gäste und Gastgeber im Meeting-Modus sind nur in ihrem einen Meeting.
    if (join.rid === S.meetRid) openRoom(join.rid);
    else toast((S.guest ? 'Als Gast bist du' : 'Du bist') + ' nur in diesem Meeting. Verlasse es, um einem anderen beizutreten.', 'error', 7000);
    return;
  }
  if (join.meet) {
    if (S.rooms.has(join.rid)) { openRoom(join.rid); return; }
    // #meet= stammt von älteren (festen) Meetings – sie funktionieren weiter.
    const ok = await inviteConfirm('MEETING', join, join.once
      ? 'Du wurdest zu einem Meeting eingeladen. Mit ' + (S.mode === 'account' ? 'deinem Konto' : 'deiner Sitzung') + ' beitreten? Dort könnt ihr schreiben und bei Bedarf einen Call starten – die anderen sehen dich in der Teilnehmerliste.'
      : 'Du wurdest in einen Meeting-Raum eingeladen. Beitreten? Dort könnt ihr schreiben und bei Bedarf einen Call starten – die anderen sehen dich in der Mitgliederliste.', 'Meeting beitreten');
    if (ok) joinRoom(join);
    return;
  }
  if (S.rooms.has(join.rid)) { openRoom(join.rid); return; }
  // Temporäre Sitzung, Raum nur für Konten: gleich zur Kontoerstellung anbieten.
  if (S.mode === 'temp' && await inviteAccountsOnly(join)) { accountOnlyDialog(join); return; }
  const ok = await inviteConfirm('EINLADUNG', join, 'Du wurdest in einen Raum eingeladen. Beitreten? Alle Mitglieder sehen dich danach in der Mitgliederliste.', 'Beitreten');
  if (ok) joinRoom(join);
}

/** Wie confirmBox, oben mit der Karte „Du wirst eingeladen in …“ (sofern es eine Vorschau gibt). */
async function inviteConfirm(title, inv, text, okLabel) {
  await Promise.race([inviteInfo(inv), sleep(2500)]);
  return new Promise((resolve) => {
    let done = false;
    openModal({
      title: title,
      build: (body) => appendAll(body, invitePreviewSlot(inv), el('p', { class: 'sc-p', text: text })),
      onClose: () => { if (!done) resolve(false); },
      actions: [
        { label: 'Abbrechen', onClick: (close) => close() },
        { label: okLabel, primary: true, onClick: (close) => { done = true; close(); resolve(true); } }
      ]
    });
  });
}

/* ---------- Ladebalken (steuert das kleine Skript in index.php) ---------- */
function progress(share, text) {
  if (window.scBoot) window.scBoot.step(share, text);
}

function bootDone() {
  if (window.scBoot) window.scBoot.done();
}

function bootFail(message) {
  if (window.scBoot) window.scBoot.fail(message);
}

async function boot() {
  parseJoinFragment();
  syncTheme();
  unlockAudio();   // Handys: Ton beim ersten Tippen freischalten, sonst klingelt nichts
  initUpdates();   // nur Windows-App: Popup, sobald die Oberfläche steht

  progress(0.3, 'VERSCHLÜSSELUNG WIRD GELADEN');
  // Als volle Adresse: import() hielte "assets/…" sonst für einen Paketnamen.
  const core = SCRIPT && SCRIPT.dataset.core
    ? new URL(SCRIPT.dataset.core, document.baseURI).href
    : new URL('securecom-core.js', import.meta.url).href;
  C = await import(core);

  progress(0.62, 'VERBINDUNG ZUM SERVER');
  try {
    S.cfg = await api('config');
  } catch (e) {
    bootFail('Der Server ist gerade nicht erreichbar (' + e.message + ') Bitte später erneut laden.');
    return;
  }

  progress(0.82, 'SCHLÜSSEL WERDEN GEPRÜFT');
  // App-Sperre: zuerst die PIN – sie öffnet die gespeicherte Anmeldung. Ohne
  // Anmeldung auf diesem Gerät ist die Sperre übrig geblieben und fällt weg.
  L.cfg = lockCfg();
  if (L.cfg && !(await hasStoredSession())) removeLock();
  if (L.cfg) {
    bootDone();
    await showLock(true);
  }
  const restored = await restoreSession();
  const gateNote = ssGet(GATE_NOTE_KEY) || S.gateNote;
  ssSet(GATE_NOTE_KEY, null);
  const guestEnd = ssGet(GUEST_END_KEY);
  ssSet(GUEST_END_KEY, null);
  if (restored && S.guestWait) {
    showGuestWait();
  } else if (restored) {
    await enterApp();
  } else if (S.pendingJoin && S.pendingJoin.once) {
    // Link zu einem Einmal-Meeting ohne Sitzung: nur nach dem Namen fragen
    // (die Vorschau des Meetings kurz abwarten, sonst springt die Karte nach).
    await Promise.race([inviteInfo(S.pendingJoin), sleep(2500)]);
    showGuestJoin();
  } else if (guestEnd && typeof guestEnd === 'object') {
    showGuestEnd(guestEnd);
  } else {
    // Link zu einem Raum nur für Konten: Kontoerstellung statt temporärer
    // Sitzung. Dieselbe Abfrage bringt die Vorschau mit (Name, Bild).
    if (S.pendingJoin) {
      const info = await inviteInfo(S.pendingJoin);
      if (!S.pendingJoin.meet) {
        S.pendingJoin.ao = info.ao;
        ssSet(JOIN_KEY, S.pendingJoin);
      }
    }
    showGate(gateNote || undefined, gateNote ? 'login' : undefined);
  }
  bootDone();
}

/* ==========================================================================
   Darstellung
   ========================================================================== */
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  const run = () => { if (!renderQueued) return; renderQueued = false; renderAll(); };
  // In einem Hintergrund-Tab ruft der Browser requestAnimationFrame nicht
  // auf – dann per Zeitgeber, damit Titel (ungelesen) und Klingeln stimmen.
  // Auch sonst ein Zeitgeber als Rückfall: Manche Fenster zeichnen gerade
  // nicht, obwohl sie nicht als verborgen gelten. Es läuft nur das Erste.
  if (document.hidden) {
    setTimeout(run, 60);
  } else {
    requestAnimationFrame(run);
    setTimeout(run, 250);
  }
}

function renderAll() {
  if (!S.me) return;
  renderRail();
  renderSide();
  renderMainHead();
  renderBanner();
  renderStage();
  renderThread();
  renderTyping();
  renderCompose();
  renderMembers();
  renderVoicebar();
  renderUser();
  renderTitle();
  $('sc').classList.toggle('members-open', S.membersOpen && S.view.kind !== 'home');
}

/** Schublade (schmale Fenster): Räume + Seitenleiste mit Abdunklung daneben. */
function toggleSide(force) {
  const open = force === undefined ? !$('sc').classList.contains('side-open') : !!force;
  $('sc').classList.toggle('side-open', open);
  $('sc-scrim').hidden = !open;
}

function setView(view) {
  // Meeting-Modus: immer das eine Meeting (Startseite und Direktnachrichten gibt es dort nicht).
  const gr = inMeetingMode() ? S.rooms.get(S.meetRid) : null;
  if (gr && (view.kind !== 'room' || view.rid !== gr.id)) view = { kind: 'room', rid: gr.id, ch: gr.meta.ch[0].id };
  S.view = view;
  ssSet('securecom.view', view);
  toggleSide(false);
  S.forceBottom = true;
  markRead();
  renderAll();
  if (window.matchMedia('(min-width: 700px)').matches) {
    const input = $('sc-input');
    if (!$('sc-compose').hidden) setTimeout(() => input.focus(), 20);
  }
}

function openDm(peerId) {
  const ident = S.ids.get(peerId);
  if (inMeetingMode() || (ident && ident.guest)) {
    toast(S.guest ? 'Als Gast schreibst du nur im Meeting.' : S.meetOnly ? 'Hier schreibst du nur im Meeting-Chat.' : 'Gäste eines Meetings sind nur im Meeting erreichbar.', 'error');
    return;
  }
  if (ident) noteContact(ident);
  if (!S.convs.has(peerId)) S.convs.set(peerId, newConv(peerId));
  setView({ kind: 'dm', peer: peerId });
}

function openRoom(rid, ch) {
  const room = S.rooms.get(rid);
  if (!room) return;
  const channel = ch || (room.lastCh && room.meta.ch.some((c) => c.id === room.lastCh) ? room.lastCh : (room.meta.ch[0] && room.meta.ch[0].id));
  room.lastCh = channel;
  setView({ kind: 'room', rid: rid, ch: channel });
}

function renderTitle() {
  let n = 0;
  for (const c of S.convs.values()) n += c.unread;
  for (const r of S.rooms.values()) for (const u of r.unread.values()) n += u;
  const ringing = S.call && S.call.state === 'incoming';
  document.title = (ringing ? '📞 ' : '') + (n ? '(' + n + ') ' : '') + 'Clavichat';
  renderLockCall();
}

/* ---------- Leiste links --------------------------------------------------- */
function renderRail() {
  const home = $('sc-home');
  home.setAttribute('aria-current', S.view.kind === 'room' ? 'false' : 'true');
  let unread = 0;
  for (const c of S.convs.values()) unread += c.unread;
  const badge = $('sc-home-badge');
  badge.hidden = !unread;
  badge.textContent = unread > 99 ? '99+' : String(unread);

  const box = $('sc-rail-rooms');
  box.textContent = '';
  const all = [...S.rooms.values()];
  const rooms = all.filter((r) => !r.meta.meet).sort((a, b) => a.meta.name.localeCompare(b.meta.name, 'de'));
  // Meetings unter einem Strich, das neueste zuerst
  const meets = all.filter((r) => r.meta.meet).sort((a, b) => (b.created || 0) - (a.created || 0) || b.meta.name.localeCompare(a.meta.name, 'de'));
  const list = meets.length ? rooms.concat([null], meets) : rooms;
  for (const room of list) {
    if (!room) { box.appendChild(el('span', { class: 'sc-rail-sep', 'aria-hidden': 'true' })); continue; }
    let u = 0;
    for (const n of room.unread.values()) u += n;
    const b = el('button', {
      type: 'button',
      class: 'sc-rail-btn sc-rail-room' + (u ? ' has-unread' : '') + (room.vc.length ? ' has-voice' : '') + (room.meta.img ? ' has-img' : '') + (room.meta.meet ? ' is-meeting' : ''),
      title: room.meta.meet ? room.meta.name + (room.vc.length ? ' – Call läuft' : '') : room.meta.name,
      'aria-current': S.view.kind === 'room' && S.view.rid === room.id ? 'true' : 'false',
      onclick: () => openRoom(room.id)
    }, room.meta.img
      ? el('span', { class: 'sc-rail-initials sc-rail-pic' }, el('img', { src: room.meta.img, alt: '', draggable: 'false' }))
      : room.meta.meet
        ? el('span', { class: 'sc-rail-initials' }, icon('group', 19))
        : el('span', { class: 'sc-rail-initials', text: initials(room.meta.name) }));
    b.style.setProperty('--hue', hueOf(C.toHex(C.unb64url(room.id)).slice(-6)));
    box.appendChild(b);
  }
}

function initials(name) {
  const words = String(name || '?').trim().split(/\s+/);
  const s = words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2);
  return s.toUpperCase();
}

/* ---------- Seitenleiste --------------------------------------------------- */
function sectionHead(label, extra) {
  return el('div', { class: 'sc-sec' },
    el('p', { class: 'section-head' }, el('span', { class: 'sq' }), el('span', { class: 'label', text: label }), el('span', { class: 'rule' })),
    extra || null);
}

function renderSide() {
  const head = $('sc-side-head');
  const body = $('sc-side-body');
  head.textContent = '';
  body.textContent = '';
  if (isMeetingView()) renderMeetingSide(head, body, S.rooms.get(S.view.rid));
  else if (inMeetingMode()) return;   // Meeting-Modus: nur das Meeting (gleich geladen)
  else if (S.view.kind === 'room' && S.rooms.has(S.view.rid)) renderRoomSide(head, body, S.rooms.get(S.view.rid));
  else renderHomeSide(head, body);
}

function renderHomeSide(head, body) {
  head.append(el('span', { class: 'sc-side-title', text: 'Direktnachrichten' }),
    iconBtn('userPlus', 'Freund hinzufügen', connectByKey));

  body.appendChild(el('button', { type: 'button', class: 'sc-entry tickbox', onclick: connectByKey },
    el('span', { class: 'sc-entry-icon' }, icon('userPlus', 19)),
    el('span', { class: 'sc-entry-text' },
      el('span', { class: 'sc-entry-name', text: 'Freund hinzufügen' }),
      el('span', { class: 'sc-entry-sub', text: 'Mit PGP-Schlüssel oder Fingerabdruck' }))));

  renderFriendsSide(body);

  const online = S.online.map((id) => S.ids.get(id)).filter((i) => i && !isBlocked(i) && !isFriend(i.id));
  body.appendChild(sectionHead('ONLINE — ' + online.length));
  const list = el('div', { class: 'sc-list' });
  if (!online.length) list.appendChild(el('p', { class: 'sc-empty-note', text: 'Gerade ist sonst niemand sichtbar online. Hier stehen nur temporäre Sitzungen – Konten zeigen ihren Status nur Freunden.' }));
  for (const ident of online) list.appendChild(personRow(ident, () => openDm(ident.id)));
  body.appendChild(list);

  const all = [...S.convs.values()].filter((c) => c.msgs.length || (S.view.kind === 'dm' && S.view.peer === c.peer))
    .sort((a, b) => b.last - a.last);
  const reqs = all.filter((c) => isRequest(c.peer) && c.msgs.length);
  const convs = all.filter((c) => !reqs.includes(c));
  if (reqs.length) {
    body.appendChild(sectionHead('NACHRICHTENANFRAGEN — ' + reqs.length));
    const rl = el('div', { class: 'sc-list' });
    for (const conv of reqs) {
      const ident = S.ids.get(conv.peer);
      const lastMsg = conv.msgs.filter((m) => !m.deleted).slice(-1)[0];
      const row = personRow(ident, () => openDm(conv.peer), {
        current: S.view.kind === 'dm' && S.view.peer === conv.peer,
        sub: 'Anfrage · ' + (lastMsg ? (lastMsg.sys || lastMsg.body).replace(/\s+/g, ' ').slice(0, 50) : ''),
        unread: conv.unread
      });
      withMenu(row, () => requestMenuItems(conv.peer));
      rl.appendChild(row);
    }
    body.appendChild(rl);
  }
  body.appendChild(sectionHead('UNTERHALTUNGEN'));
  const cl = el('div', { class: 'sc-list' });
  if (!convs.length) cl.appendChild(el('p', { class: 'sc-empty-note', text: 'Noch keine Unterhaltungen.' }));
  for (const conv of convs) {
    const ident = S.ids.get(conv.peer);
    const lastMsg = conv.msgs.filter((m) => !m.sys && !m.deleted).slice(-1)[0];
    const row = personRow(ident, () => openDm(conv.peer), {
      current: S.view.kind === 'dm' && S.view.peer === conv.peer,
      sub: lastMsg ? (lastMsg.from === S.me.id ? 'Du: ' : '') + lastMsg.body.replace(/\s+/g, ' ').slice(0, 60) : null,
      unread: conv.unread
    });
    withMenu(row, () => convMenuItems(conv));
    cl.appendChild(row);
  }
  body.appendChild(cl);
}

/* ---------- Kontextmenü: Rechtsklick, auf dem Handy langes Drücken -------- */
let ctxMenu = null;
let ctxOpened = 0;

function closeContextMenu() {
  if (ctxMenu) { ctxMenu.remove(); ctxMenu = null; }
}

/**
 * Einträge: { icon | dot | swatch (Farbe), label, note?, checked?, danger?, disabled?, run },
 * { sep: true } oder { bar: Element }. opts.above: über dem Punkt öffnen (Menü unten links).
 */
function openContextMenu(x, y, items, opts) {
  closeContextMenu();
  const menu = el('div', { class: 'sc-ctx', role: 'menu' });
  for (const it of items) {
    if (!it) continue;
    if (it.sep) { menu.appendChild(el('div', { class: 'sc-ctx-sep', role: 'separator' })); continue; }
    if (it.bar) { menu.appendChild(it.bar); continue; }   // eigener Baustein, z. B. die Reaktionsleiste
    const radio = it.checked !== undefined;
    menu.appendChild(el('button', {
      type: 'button', role: radio ? (it.swatch ? 'menuitemcheckbox' : 'menuitemradio') : 'menuitem', 'aria-checked': radio ? String(!!it.checked) : null,
      class: 'sc-ctx-item' + (it.danger ? ' is-danger' : ''), disabled: !!it.disabled,
      onclick: () => { closeContextMenu(); it.run(); }
    }, it.swatch ? el('span', { class: 'sc-ctx-dot' }, el('span', { class: 'sc-role-dot', style: '--role:' + it.swatch }))
      : it.dot ? el('span', { class: 'sc-ctx-dot' }, el('span', { class: 'sc-on' + STATUS[it.dot].cls })) : icon(it.icon, 15),
    el('span', { class: 'sc-ctx-text' }, el('span', { text: it.label }), it.note ? el('span', { class: 'sc-ctx-note', text: it.note }) : null),
    it.checked ? icon('check', 14) : null));
  }
  document.body.appendChild(menu);
  const top = opts && opts.above ? y - menu.offsetHeight : y;
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(top, window.innerHeight - menu.offsetHeight - 8)) + 'px';
  ctxMenu = menu;
  ctxOpened = Date.now();
}

/** Menü an ein Element hängen: Rechtsklick, Taste "Kontextmenü" oder langes Drücken. */
function withMenu(node, items) {
  let timer = 0;
  let start = null;
  node.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    clearTimeout(timer);
    timer = 0;
    if (Date.now() - ctxOpened < 700) return;   // schon per langem Drücken geöffnet
    const r = node.getBoundingClientRect();
    const list = items();
    if (list.some(Boolean)) openContextMenu(ev.clientX || r.left + 24, ev.clientY || r.bottom, list);
  });
  node.addEventListener('pointerdown', (ev) => {
    if (ev.pointerType !== 'touch') return;
    start = { x: ev.clientX, y: ev.clientY };
    timer = setTimeout(() => { timer = 0; const list = items(); if (list.some(Boolean)) openContextMenu(start.x, start.y, list); }, 550);
  });
  const cancel = () => { clearTimeout(timer); timer = 0; };
  node.addEventListener('pointerup', cancel);
  node.addEventListener('pointercancel', cancel);
  node.addEventListener('pointermove', (ev) => { if (start && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 10) cancel(); });
  // Nach langem Drücken nicht auch noch öffnen.
  node.addEventListener('click', (ev) => { if (Date.now() - ctxOpened < 700) { ev.preventDefault(); ev.stopImmediatePropagation(); } }, true);
}

function requestMenuItems(peer) {
  const ident = S.ids.get(peer);
  return [
    { icon: 'check', label: 'Annehmen', run: () => acceptRequest(peer) },
    { icon: 'x', label: 'Ablehnen', note: 'Verlauf weg; schreibt die Person wieder, kommt eine neue Anfrage', run: () => declineRequest(peer) },
    ident ? { icon: 'shield', label: 'Blockieren', danger: true, run: () => { toggleBlock(ident); declineRequest(peer); } } : null
  ];
}

function convMenuItems(conv) {
  if (isRequest(conv.peer)) return requestMenuItems(conv.peer);
  return [
    { icon: 'check', label: 'Als gelesen markieren', disabled: !conv.unread, run: () => markConvRead(conv) },
    { icon: 'users', label: 'Profil anzeigen', run: () => showProfile(conv.peer) },
    friendMenuItem(S.ids.get(conv.peer)),
    { icon: 'trash', label: 'Unterhaltung löschen', danger: true, run: () => deleteConversation(conv) }
  ];
}

function markConvRead(conv) {
  conv.unread = 0;
  S.vault.reads['dm:' + conv.peer] = serverNow();
  saveVault();
  renderAll();
}

/**
 * Löscht den Verlauf nur bei dir (bei Konten auf allen Geräten, über den
 * Tresor). Beim Gegenüber bleibt er; neue Nachrichten erscheinen wieder.
 */
async function deleteConversation(conv) {
  const who = displayName(S.ids.get(conv.peer));
  const ok = await confirmBox('Unterhaltung löschen',
    'Der Verlauf mit ' + who + ' verschwindet ' + (S.mode === 'account' ? 'auf all deinen Geräten' : 'hier') +
    '. Bei ' + who + ' bleibt er erhalten, neue Nachrichten erscheinen wieder.', 'Löschen', true);
  if (!ok) return;
  let last = serverNow();
  for (const m of conv.msgs) last = Math.max(last, m.ts || 0);
  S.vault.cleared[conv.peer] = last;
  saveVault();
  S.convs.delete(conv.peer);
  if (S.view.kind === 'dm' && S.view.peer === conv.peer) setView({ kind: 'home' });
  renderAll();
}

function personRow(ident, onclick, opts) {
  const o = opts || {};
  const inCall = S.call && S.call.peerId === (ident && ident.id);
  const row = el('button', {
    type: 'button',
    class: 'sc-row' + (o.unread ? ' has-unread' : ''),
    'aria-current': o.current ? 'true' : 'false',
    onclick: onclick
  },
    el('span', { class: 'sc-row-av' }, avatar(ident), statusDot(ident)),
    el('span', { class: 'sc-row-text' },
      el('span', { class: 'sc-row-name' }, el('span', { class: 'sc-row-label', text: displayName(ident), style: o.color ? 'color:' + o.color : null }),
        isVerified(ident) ? icon('shieldCheck', 13) : null,
        ident && ident.kind === 'temp' ? (ident.guest ? kindBadge(ident) : el('span', { class: 'sc-kind', text: 'TEMP' })) : null),
      el('span', { class: 'sc-row-sub', text: o.sub || (ident ? fpTail(ident.fp) : '') })),
    inCall ? icon('phone', 14) : null,
    o.unread ? el('span', { class: 'sc-count', text: o.unread > 99 ? '99+' : String(o.unread) }) : null);
  return row;
}

function renderRoomSide(head, body, room) {
  const isOwner = can(room, RIGHT.CHANNELS);   // Kanäle anlegen/verschieben: Besitzer oder Recht „Kanäle verwalten“
  appendAll(head, room.meta.img ? el('img', { class: 'sc-side-pic', src: room.meta.img, alt: '' }) : null,
    // Name in voller Breite, Merkmale klein in einer zweiten Zeile darunter
    el('span', { class: 'sc-side-name' },
      el('span', { class: 'sc-side-title', text: room.meta.name, title: room.meta.name }),
      room.tmp || room.ao ? el('span', { class: 'sc-side-tags' },
        room.ao ? el('span', { class: 'sc-side-tag sc-side-tag--ao', title: AO_NOTE }, icon('users', 11), 'NUR KONTEN') : null,
        room.tmp ? el('span', { class: 'sc-side-tag', title: tempRoomNote(room) }, icon('clock', 11), 'TEMP') : null) : null),
    iconBtn('more', 'Raum-Menü', () => roomMenu(room)));

  body.appendChild(sectionHead('TEXTKANÄLE', isOwner ? iconBtn('plus', 'Kanal anlegen', () => addChannel(room), { class: 'sc-ibtn sc-ibtn--tiny' }) : null));
  const chl = el('div', { class: 'sc-list' });
  for (const ch of room.meta.ch) {
    const u = room.unread.get(ch.id) || 0;
    const btn = el('button', {
      type: 'button',
      class: 'sc-chan' + (u ? ' has-unread' : ''),
      'aria-current': S.view.ch === ch.id ? 'true' : 'false',
      onclick: () => openRoom(room.id, ch.id)
    }, icon('hash', 15), el('span', { class: 'sc-chan-name', text: ch.name }),
    room.cw[ch.id] && rolesOk(room) ? chanLock('Schreiben: ' + channelWho(room, room.cw[ch.id].r), canWriteIn(room, S.me.id, ch.id), 'du darfst schreiben', 'du darfst hier nicht schreiben') : null,
    u ? el('span', { class: 'sc-count', text: String(u) }) : null);
    withMenu(btn, () => textChannelMenu(room, ch));
    if (isOwner) { sortable(btn, room, 'ch', ch.id); dropTarget(btn, room, 'ch', ch.id); }
    chl.appendChild(btn);
  }
  body.appendChild(chl);

  body.appendChild(sectionHead('SPRACHKANÄLE', isOwner ? iconBtn('plus', 'Sprachkanal anlegen', () => addVoiceChannel(room), { class: 'sc-ibtn sc-ibtn--tiny' }) : null));
  const vbox = el('div', { class: 'sc-list' });
  for (const vch of room.meta.vch) {
    const inHere = !!(S.voice && S.voice.rid === room.id && S.voice.ch === vch.id);
    const people = voiceMembers(room, vch.id);
    const vbtn = el('button', {
      type: 'button',
      class: 'sc-chan sc-chan--voice' + (inHere ? ' is-joined' : ''),
      title: inHere ? 'Du bist in diesem Sprachkanal' : 'Sprachkanal betreten',
      onclick: () => (inHere ? setView({ kind: 'room', rid: room.id, ch: S.view.ch }) : joinVoice(room.id, vch.id))
    }, icon('speaker', 15), el('span', { class: 'sc-chan-name', text: vch.name }),
    room.vw[vch.id] && rolesOk(room) ? chanLock('Betreten: ' + channelWho(room, room.vw[vch.id]), canEnterVoice(room, S.me.id, vch.id), 'du darfst ihn betreten', 'du darfst ihn nicht betreten') : null,
    el('span', { class: 'sc-chan-meta', text: people.length ? people.length + '/' + (S.cfg.limits.voice || 8) : '' }));
    withMenu(vbtn, () => voiceChannelMenu(room, vch));
    if (isOwner) { sortable(vbtn, room, 'vch', vch.id); dropTarget(vbtn, room, 'vch', vch.id); }
    vbox.appendChild(vbtn);
    for (const id of people) {
      const ident = S.ids.get(id);
      const peer = inHere && S.voice.peers.get(id);
      const muted = id === S.me.id ? !(M.micOn && !M.deaf) : (peer && !peer.remoteState.mic);
      vbox.appendChild(el('div', { class: 'sc-vmember', dataset: { speak: id } },
        avatar(ident, 'xs'), el('span', { class: 'sc-vmember-name', text: displayName(ident) }),
        muted ? icon('micOff', 13) : null));
    }
  }
  body.appendChild(vbox);

  if (room.pendingKey) {
    body.appendChild(el('p', { class: 'sc-empty-note', text: 'Warte auf den neuen Raumschlüssel vom Besitzer …' }));
  }
}

/* ---------- Leiste unten links: laufender Anruf ----------------------------- */
function renderVoicebar() {
  const bar = $('sc-voicebar');
  bar.textContent = '';
  let title = '', sub = '', onOpen = null, onEnd = null, stateClass = '';
  if (S.call) {
    const ident = S.ids.get(S.call.peerId);
    title = S.call.state === 'active' ? 'Im Gespräch' : S.call.state === 'incoming' ? 'Eingehender Anruf' : S.call.state === 'ringing' ? 'Klingelt …' : 'Verbindet …';
    sub = displayName(ident);
    stateClass = S.call.state === 'active' ? ' is-live' : '';
    onOpen = () => openDm(S.call.peerId);
    onEnd = () => (S.call.state === 'incoming' ? declineCall() : endCall());
  } else if (S.voice) {
    const room = S.rooms.get(S.voice.rid);
    const connected = [...S.voice.peers.values()].some((p) => p.pc.connectionState === 'connected');
    title = connected || !S.voice.peers.size ? (room && room.meta.meet ? 'Call verbunden' : 'Sprache verbunden') : 'Verbindet …';
    const vch = room && room.meta.vch.find((c) => c.id === S.voice.ch);
    sub = room ? room.meta.name + (vch && room.meta.vch.length > 1 ? ' · ' + vch.name : '') : '';
    stateClass = ' is-live';
    onOpen = () => openRoom(S.voice.rid);
    onEnd = () => leaveVoice();
  }
  bar.hidden = !onEnd;
  if (!onEnd) return;
  bar.append(
    el('button', { type: 'button', class: 'sc-voicebar-info' + stateClass, onclick: onOpen },
      el('span', { class: 'sc-voicebar-title' }, icon('lock', 12), title),
      el('span', { class: 'sc-voicebar-sub', text: sub })),
    iconBtn('hangup', 'Auflegen', onEnd, { class: 'sc-ibtn sc-ibtn--danger' }));
}

/* ---------- Eigenes Profil unten links ------------------------------------ */
function renderUser() {
  const box = $('sc-user');
  const me = S.ids.get(S.me.id);
  const st = myStatus();
  const sig = [S.me.name, avatarUrl(me) || '', S.me.vis, S.mode, S.guest ? 1 : S.meetOnly ? 2 : 0, S.me.fp, S.offline, M.micOn, M.deaf, st, chosenStatus(), L.cfg ? 1 : 0].join('|');
  if (box.dataset.sig === sig && box.firstChild) return;
  box.dataset.sig = sig;
  box.textContent = '';
  const micBtn = iconBtn(M.micOn ? 'mic' : 'micOff', M.micOn ? 'Stummschalten' : 'Mikrofon an', toggleMic, { class: 'sc-ibtn' + (M.micOn ? '' : ' is-off') });
  const deafBtn = iconBtn(M.deaf ? 'headOff' : 'head', M.deaf ? 'Ton an' : 'Nichts hören', toggleDeaf, { class: 'sc-ibtn' + (M.deaf ? ' is-off' : '') });
  if (inMeetingMode()) {
    // Gast bzw. Gastgeber im Meeting-Modus: Name, Mikrofon, Kopfhörer,
    // Einstellungen – kein Status (Freunde gibt es hier nicht).
    appendAll(box,
      el('button', { type: 'button', class: 'sc-user-info', title: 'Einstellungen', onclick: showSettings },
        el('span', { class: 'sc-row-av' }, avatar(me)),
        el('span', { class: 'sc-row-text' },
          el('span', { class: 'sc-row-name' }, el('span', { class: 'sc-row-label', text: S.me.name || 'Gast' })),
          el('span', { class: 'sc-row-sub', text: (S.guest ? 'GAST' : 'TEMP') + ' · im Meeting' + (S.offline ? ' · keine Verbindung' : '') }))),
      micBtn, deafBtn,
      iconBtn('settings', 'Einstellungen', showSettings));
    return;
  }
  const label = chosenStatus() === 'off' ? 'Unsichtbar' : st === 'away' && chosenStatus() === 'on' ? 'Abwesend (inaktiv)' : STATUS[st].label;
  appendAll(box,
    el('button', { type: 'button', class: 'sc-user-info', title: 'Status und Profil', 'aria-haspopup': 'menu', onclick: (ev) => openStatusMenu(ev.currentTarget) },
      el('span', { class: 'sc-row-av' }, avatar(me), el('span', { class: 'sc-on' + STATUS[st].cls, title: label })),
      el('span', { class: 'sc-row-text' },
        el('span', { class: 'sc-row-name' }, el('span', { class: 'sc-row-label', text: S.me.name || (S.mode === 'temp' ? 'Temporär' : 'Ich') })),
        el('span', { class: 'sc-row-sub', text: (S.mode === 'temp' ? 'TEMP · ' : '') + label + (S.offline ? ' · keine Verbindung' : '') }))),
    micBtn, deafBtn,
    L.cfg ? iconBtn('lock', 'Sperren (Strg+L)', lockNow) : null,
    iconBtn('settings', 'Einstellungen', showSettings));
}

/* ---------- Kopf des Hauptbereichs ---------------------------------------- */
function renderMainHead() {
  const head = $('sc-main-head');
  head.textContent = '';
  head.appendChild(iconBtn('menu', 'Menü', () => toggleSide(), { class: 'sc-ibtn sc-only-mobile' }));

  if (S.view.kind === 'dm') {
    const ident = S.ids.get(S.view.peer);
    head.append(
      el('button', { type: 'button', class: 'sc-head-who', onclick: () => showProfile(S.view.peer) },
        el('span', { class: 'sc-row-av' }, avatar(ident, 'sm'), statusDot(ident)),
        el('span', { class: 'sc-head-text' },
          el('span', { class: 'sc-head-title' }, displayName(ident), isVerified(ident) ? icon('shieldCheck', 14) : null, kindBadge(ident)),
          el('span', { class: 'sc-head-sub', text: (ident ? C.shortFingerprint(ident.fp) + ' · ' : '') + 'bleibt ' + ttlLabel(convTtl(S.view.peer)) }))),
      el('span', { class: 'sc-head-spacer' }),
      iconBtn('clock', 'Nachrichten bleiben ' + ttlLabel(convTtl(S.view.peer)) + ' – ändern', () => convTtlDialog(S.view.peer)),
      iconBtn('phone', 'Anrufen', () => startCall(S.view.peer, false)),
      iconBtn('video', 'Videoanruf', () => startCall(S.view.peer, true)),
      iconBtn('users', 'Profil', () => { S.membersOpen = !S.membersOpen; renderAll(); }, { 'aria-pressed': S.membersOpen ? 'true' : 'false' }));
  } else if (isMeetingView()) {
    const room = S.rooms.get(S.view.rid);
    appendAll(head,
      el('span', { class: 'sc-head-text' },
        el('span', { class: 'sc-head-title' }, icon('group', 16), 'Meeting-Chat'),
        el('span', { class: 'sc-head-sub', text: room.meta.name + ' · ' + room.members.length + ' Teilnehmer · Ende-zu-Ende verschlüsselt' })),
      el('span', { class: 'sc-head-spacer' }),
      meetingCallButton(room, 'icon'),
      canShareLink(room) ? iconBtn('link', 'Meeting-Link teilen', () => meetingDialog(room)) : null,
      iconBtn('users', 'Teilnehmer', () => { S.membersOpen = !S.membersOpen; renderAll(); }, { 'aria-pressed': S.membersOpen ? 'true' : 'false' }));
  } else if (S.view.kind === 'room' && S.rooms.has(S.view.rid)) {
    const room = S.rooms.get(S.view.rid);
    const ch = room.meta.ch.find((c) => c.id === S.view.ch);
    appendAll(head,
      el('span', { class: 'sc-head-text' },
        el('span', { class: 'sc-head-title' }, icon('hash', 16), ch ? ch.name : '—'),
        el('span', { class: 'sc-head-sub', text: room.meta.name + ' · ' + room.members.length + ' Mitglieder · ' + keepText(chanTtl(room, S.view.ch)) +
          (hasChanTtl(room, S.view.ch) ? ' (Kanal)' : '') +
          (rolesOk(room) && room.cw[S.view.ch] ? ' · ' + channelWho(room, room.cw[S.view.ch].r) + ' schreiben' : '') })),
      el('span', { class: 'sc-head-spacer' }),
      iconBtn(room.meta.meet ? 'phone' : 'speaker', S.voice && S.voice.rid === room.id
        ? (room.meta.meet ? 'Call verlassen' : 'Sprachkanal verlassen')
        : (room.meta.meet ? (room.vc.length ? 'Call beitreten (' + room.vc.length + ' drin)' : 'Call starten') : 'Sprachkanal „' + room.meta.vch[0].name + '“ betreten'),
        () => (S.voice && S.voice.rid === room.id ? leaveVoice() : joinVoice(room.id)),
        room.meta.meet && room.vc.length && !(S.voice && S.voice.rid === room.id) ? { class: 'sc-ibtn is-live' } : undefined),
      room.meta.meet ? iconBtn('link', 'Meeting-Link teilen', () => meetingDialog(room)) : canInvite(room) ? iconBtn('userPlus', 'Einladen', () => inviteDialog(room)) : null,
      iconBtn('users', 'Mitglieder', () => { S.membersOpen = !S.membersOpen; renderAll(); }, { 'aria-pressed': S.membersOpen ? 'true' : 'false' }));
  } else {
    head.append(el('span', { class: 'sc-head-text' },
      el('span', { class: 'sc-head-title', text: 'Clavichat' }),
      el('span', { class: 'sc-head-sub', text: 'Ende-zu-Ende verschlüsselt' })),
      el('span', { class: 'sc-head-spacer' }),
      iconBtn('info', 'So funktioniert Clavichat', showSecurityInfo));
  }
  $('sc-main').classList.toggle('is-meeting', isMeetingView());
  renderMeetingLobby();
  // Eigene Domain (clavichat.de) ohne Seitenleiste oben: Hell/Dunkel hier.
  if (document.body.classList.contains('sc-standalone')) {
    const dark = document.documentElement.getAttribute('data-theme') !== 'light';
    head.appendChild(iconBtn(dark ? 'sun' : 'moon', dark ? 'Zu hell wechseln' : 'Zu dunkel wechseln', () => {
      setTheme(dark ? 'light' : 'dark');
      renderMainHead();
    }));
  }
}

/* ---------- Warnhinweise über dem Verlauf --------------------------------- */
function renderBanner() {
  const box = $('sc-banner');
  box.textContent = '';
  let show = false;
  if (S.view.kind === 'dm') {
    const ident = S.ids.get(S.view.peer);
    if (ident && ident.changed) {
      show = true;
      box.className = 'sc-banner sc-banner--danger';
      box.append(icon('alert', 16),
        el('span', { text: 'Der Schlüssel von ' + displayName(ident) + ' ist ein anderer als beim letzten Mal. Das kann ein Angriff sein – oder ein neues Gerät/Konto. Vergleiche den Fingerabdruck, bevor du weiterschreibst.' }),
        el('button', { type: 'button', class: 'btn', text: 'Neuen Schlüssel annehmen', onclick: () => acceptNewKey(ident) }));
    } else if (ident && isBlocked(ident)) {
      show = true;
      box.className = 'sc-banner';
      box.append(icon('eyeOff', 16), el('span', { text: 'Du hast diese Person blockiert.' }),
        el('button', { type: 'button', class: 'btn', text: 'Entblocken', onclick: () => toggleBlock(ident) }));
    }
  }
  if (S.offline) {
    show = true;
    box.className = 'sc-banner';
    box.textContent = '';
    box.append(icon('alert', 16), el('span', { text: 'Keine Verbindung zum Server – neue Nachrichten kommen an, sobald sie wieder steht.' }));
  }
  box.hidden = !show;
}

function acceptNewKey(ident) {
  S.vault.contacts[ident.id] = { fp: ident.fp, n: ident.name, t: Date.now(), v: false };
  ident.changed = false;
  saveVault();
  renderAll();
}

/* ---------- Verlauf ------------------------------------------------------- */
function currentMessages() {
  if (S.view.kind === 'dm') {
    const conv = S.convs.get(S.view.peer);
    return conv ? conv.msgs : [];
  }
  if (S.view.kind === 'room') {
    const room = S.rooms.get(S.view.rid);
    return room ? (room.msgs.get(S.view.ch) || []) : [];
  }
  return null;
}

function renderThread() {
  const thread = $('sc-thread');
  // Während eine Nachricht bearbeitet wird, den Verlauf nicht neu bauen –
  // sonst wäre das Eingabefeld weg.
  if (S.editing && document.body.contains(S.editing)) return;
  S.editing = null;
  const atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
  const keep = thread.scrollTop;
  thread.textContent = '';
  const list = currentMessages();
  if (list === null) {
    thread.appendChild(homeScreen());
    return;
  }
  if (!list.length) {
    thread.appendChild(emptyThread());
  } else {
    let prev = null;
    let prevDay = '';
    for (const m of list) {
      const day = dayKey(m.ts);
      if (day !== prevDay) {
        thread.appendChild(el('div', { class: 'sc-day' }, el('span', { text: fmtDay(m.ts) })));
        prevDay = day;
        prev = null;
      }
      if (m.sys) {
        thread.appendChild(el('div', { class: 'sc-sys' }, icon(m.icon || 'info', 13), el('span', { text: m.sys }), el('time', { text: fmtTime(m.ts) })));
        prev = null;
        continue;
      }
      const grouped = prev && prev.from === m.from && m.ts - prev.ts < 5 * 60000;
      thread.appendChild(messageNode(m, grouped));
      prev = m;
    }
  }
  if (S.view.kind === 'dm' && isRequest(S.view.peer)) thread.appendChild(requestBar(S.view.peer));
  if (S.forceBottom || atBottom) thread.scrollTop = thread.scrollHeight;
  else thread.scrollTop = keep;
  S.forceBottom = false;
}

/** Beitrag eines API-Zugangs: Name des Zugangs, Zeichen „API“, kein Profil, kein Bearbeiten. */
function hookNode(m, grouped) {
  const node = el('div', { class: 'sc-msg sc-msg--hook' + (grouped ? ' is-grouped' : ''), dataset: { id: m.id } });
  node.appendChild(grouped
    ? el('time', { class: 'sc-msg-gtime', text: fmtTime(m.ts) })
    : el('span', { class: 'sc-msg-av sc-hook-av', title: 'Beitrag über einen API-Zugang' }, icon('bolt', 18)));
  const body = el('div', { class: 'sc-msg-body' });
  if (!grouped) {
    body.appendChild(el('div', { class: 'sc-msg-head' },
      el('span', { class: 'sc-msg-name sc-hook-name', text: m.hook.name }),
      el('span', { class: 'sc-hook-tag', title: 'Gepostet über einen API-Zugang des Raums – der Zugang kann nur posten, nichts lesen.', text: 'API' }),
      el('time', { text: fmtTime(m.ts), title: new Date(m.ts).toLocaleString('de-DE') })));
  }
  body.appendChild(el('div', { class: 'sc-msg-text' }, linkify(m.body)));
  appendAll(body, reactChips(m));
  node.appendChild(body);
  withMenu(node, () => messageMenu(m, node));
  return node;
}

/**
 * Rechtsklick (Handy: lange drücken) auf eine Nachricht: kopieren, eigene
 * bearbeiten/löschen. Besitzer eines Raums: jede Nachricht und jeden
 * API-Beitrag beim Server entfernen (room.del).
 */
function messageMenu(m, node) {
  const own = m.from === S.me.id;
  const room = S.view.kind === 'room' ? S.rooms.get(S.view.rid) : null;
  const admin = !!(room && can(room, RIGHT.MESSAGES) && S.cfg && S.cfg.rdel);
  const ready = !m.deleted && m.state !== 'pending';
  const react = canReact(m);
  return [
    react ? { bar: reactBar(m) } : null,
    react ? { sep: true } : null,
    m.body && !m.deleted && !m.file ? { icon: 'copy', label: 'Text kopieren', run: () => copyText(m.body, 'Text') } : null,
    own && ready && !m.file && !m.invite && !m.hook ? { icon: 'edit', label: 'Bearbeiten', run: () => editMessage(m, node) } : null,
    own && ready && !m.invite && !admin ? { icon: 'trash', label: 'Löschen', danger: true, run: () => deleteMessage(m) } : null,
    admin && !m.sys ? {
      icon: 'trash', label: m.hook ? 'Beitrag löschen' : 'Nachricht löschen', danger: true, disabled: !m.seq,
      note: own ? null : room.owner === S.me.id ? 'Als Besitzer – für alle' : 'Moderation – für alle', run: () => ownerDeleteMessage(room, m)
    } : null
  ];
}

/** Besitzer: Nachricht (samt ihren Änderungen und der Datei) beim Server entfernen – für alle. */
async function ownerDeleteMessage(room, m) {
  if (!m.seq) return;
  const who = m.hook ? m.hook.name + ' (API)' : m.from === S.me.id ? '' : displayName(S.ids.get(m.from));
  const ok = await confirmBox(m.hook ? 'Beitrag löschen' : 'Nachricht löschen',
    (who ? 'Die Nachricht von ' + who : 'Deine Nachricht') + ' verschwindet für alle aus dem Raum und wird beim Server gelöscht' +
      (m.file ? ', samt Datei' : '') + '. Wer sie schon gesehen hat, kann sie kopiert haben.', 'Löschen', true);
  if (!ok) return;
  const seqs = [m.seq].concat(m.xs || []);
  try {
    await api('room.del', { id: room.id, s: seqs, f: m.file ? [m.file.id] : [] });
    dropRoomEntries(room, seqs);
    toast(m.hook ? 'Beitrag gelöscht.' : 'Nachricht gelöscht.', 'ok');
  } catch (e) { toast(e.message, 'error'); }
}

/** Einträge (nach Nummer) aus der Ansicht nehmen – nach room.del oder dem Hinweis k "del". */
function dropRoomEntries(room, seqs) {
  const gone = new Set(seqs.map(Number));
  let changed = false;
  for (const [ch, list] of room.msgs) {
    if (!list.some((m) => gone.has(m.seq))) continue;
    room.msgs.set(ch, list.filter((m) => {
      if (!gone.has(m.seq)) return true;
      room.byId.delete(m.id);
      return false;
    }));
    changed = true;
  }
  room.pending = room.pending.filter((p) => !gone.has(p.s));
  if (changed) scheduleRender();
}

function roomDelNote(room, e) {
  if (!Array.isArray(e.n)) return;
  dropRoomEntries(room, e.n.filter((s) => Number.isInteger(s) && s > 0).slice(0, 200));
}

function messageNode(m, grouped) {
  if (m.hook) return hookNode(m, grouped);
  const ident = S.ids.get(m.from);
  const own = m.from === S.me.id;
  const node = el('div', {
    class: 'sc-msg' + (grouped ? ' is-grouped' : '') + (own ? ' is-own' : '') + (m.state ? ' is-' + m.state : ''),
    dataset: { id: m.id }
  });
  node.appendChild(grouped
    ? el('time', { class: 'sc-msg-gtime', text: fmtTime(m.ts) })
    : el('button', { type: 'button', class: 'sc-msg-av', onclick: () => showProfile(m.from), 'aria-label': displayName(ident) }, avatar(ident)));
  const body = el('div', { class: 'sc-msg-body' });
  if (!grouped) {
    const room = S.view.kind === 'room' ? S.rooms.get(S.view.rid) : null;
    const color = room ? memberColor(room, m.from) : null;   // Farbe des höchsten Rangs
    body.appendChild(el('div', { class: 'sc-msg-head' },
      el('button', { type: 'button', class: 'sc-msg-name', text: displayName(ident), style: color ? 'color:' + color : null, onclick: () => showProfile(m.from, room) }),
      ident && ident.kind === 'temp' ? el('span', { class: 'sc-msg-fp', text: fpTail(ident.fp) }) : null,
      el('time', { text: fmtTime(m.ts), title: new Date(m.ts).toLocaleString('de-DE') })));
  }
  const text = el('div', { class: 'sc-msg-text' });
  if (m.deleted) {
    text.classList.add('is-deleted');
    text.textContent = 'Nachricht gelöscht';
    body.appendChild(text);
  } else if (m.file) {
    body.appendChild(fileCard(m));   // der Text ist nur der Ersatz für ältere Apps
  } else {
    // In einer Anfrage sind Links nur Text – erst nach dem Annehmen anklickbar.
    const locked = !own && S.view.kind === 'dm' && isRequest(S.view.peer);
    text.appendChild(locked ? document.createTextNode(m.body) : linkify(m.body));
    if (m.edited) text.appendChild(el('span', { class: 'sc-edited', text: ' (bearbeitet)' }));
    body.appendChild(text);
  }
  if (m.invite && !m.deleted) body.appendChild(inviteCard(m));
  if (m.state === 'failed') body.appendChild(el('span', { class: 'sc-msg-state', text: 'Nicht gesendet' }));
  appendAll(body, reactChips(m));
  node.appendChild(body);
  withMenu(node, () => messageMenu(m, node));

  // Reagieren sitzt unten links an der Nachricht (reactChips), hier nur Bearbeiten/Löschen.
  const mine = own && !m.deleted && !m.invite && m.state !== 'pending';
  if (mine) {
    node.appendChild(el('div', { class: 'sc-msg-actions' },
      !m.file ? iconBtn('edit', 'Bearbeiten', () => editMessage(m, node)) : null,
      mine ? iconBtn('trash', 'Löschen', () => deleteMessage(m)) : null));
  }
  return node;
}

/* ---------- Reaktionen: Leiste, Chips, Senden ---------------------------------- */
/** Darf ich auf diese Nachricht reagieren? (Raum oder angenommene Unterhaltung, nicht gelöscht, schon gesendet) */
function canReact(m) {
  if (!m || m.sys || m.deleted || m.state === 'pending' || m.state === 'failed' || m.invite) return false;
  if (S.view.kind === 'dm') {
    const ident = S.ids.get(S.view.peer);
    return !!ident && !ident.changed && !isBlocked(ident) && !isRequest(S.view.peer);
  }
  if (S.view.kind !== 'room') return false;
  const room = S.rooms.get(S.view.rid);
  return !!room && !!roomKeyRaw(room.id, room.epoch) && can(room, RIGHT.REACT);
}

function hasMyReaction(m, id) {
  const set = m.rx && m.rx.get(id);
  return !!(set && set.has(S.me.id));
}

/** Alle Symbole zum Antippen (Kontextmenü und Knopf „Reagieren“). */
function reactBar(m) {
  const bar = el('div', { class: 'sc-rx-bar', role: 'group', 'aria-label': 'Reagieren' });
  for (const r of REACTIONS) {
    const mine = hasMyReaction(m, r.id);
    bar.appendChild(el('button', {
      type: 'button', class: 'sc-rx-pick' + (mine ? ' is-mine' : ''), title: r.label + (mine ? ' (entfernen)' : ''),
      'aria-label': r.label, 'aria-pressed': mine ? 'true' : 'false',
      onclick: () => { closeContextMenu(); toggleReaction(m, r.id); }
    }, reactIcon(r.id, 22)));
  }
  return bar;
}

function openReactPicker(m, anchor) {
  const r = anchor.getBoundingClientRect();
  openContextMenu(r.left, r.bottom + 6, [{ bar: reactBar(m) }]);
}

/**
 * Unter der Nachricht, links beginnend: Symbol + Anzahl; eigene hervorgehoben,
 * Klick schaltet um, Namen im Hinweis. Dahinter der Knopf „Reagieren“. Ohne
 * Reaktionen schwebt nur dieser Knopf unten links an der Nachricht (beim
 * Überfahren, nimmt keinen Platz ein – nichts springt); auf Touch-Geräten
 * reagiert man wie bisher per langem Drücken.
 */
function reactChips(m) {
  if (m.deleted) return null;
  const can = canReact(m);
  const add = () => el('button', { type: 'button', class: 'sc-rx-chip sc-rx-add', title: 'Reagieren', 'aria-label': 'Reagieren',
    onclick: (ev) => openReactPicker(m, ev.currentTarget) }, icon('react', 15));
  if (!m.rx || !m.rx.size) return can ? el('div', { class: 'sc-rx-chips is-float' }, add()) : null;
  const box = el('div', { class: 'sc-rx-chips' });
  for (const [id, set] of m.rx) {
    const r = REACTIONS.find((x) => x.id === id);
    if (!r || !set.size) continue;
    const names = [...set].map((who) => (who === S.me.id ? 'Du' : displayName(S.ids.get(who))));
    const mine = set.has(S.me.id);
    box.appendChild(el('button', {
      type: 'button', class: 'sc-rx-chip' + (mine ? ' is-mine' : ''), disabled: !can,
      title: r.label + ': ' + (names.length > 12 ? names.slice(0, 12).join(', ') + ' und ' + (names.length - 12) + ' weitere' : names.join(', ')),
      'aria-pressed': mine ? 'true' : 'false',
      onclick: () => toggleReaction(m, id)
    }, reactIcon(id, 16), el('span', { class: 'sc-rx-n', text: String(set.size) })));
  }
  if (!box.childNodes.length) return can ? el('div', { class: 'sc-rx-chips is-float' }, add()) : null;
  if (can) box.appendChild(add());
  return box;
}

/** Reaktion setzen (on) oder zurücknehmen – unabhängig von der Reihenfolge, gleiche Meldung zweimal schadet nicht. */
function setReaction(m, id, who, on) {
  if (!REACT_IDS.has(id) || typeof who !== 'string') return;
  const rx = m.rx || (m.rx = new Map());
  let set = rx.get(id);
  if (on) {
    if (!set) {
      if (rx.size >= REACT_MAX) return;
      set = new Set();
      rx.set(id, set);
    }
    set.add(who);
  } else if (set) {
    set.delete(who);
    if (!set.size) rx.delete(id);
  }
}

/**
 * Reaktion aus dem Verlauf: Ziel-Nachricht da → anwenden, sonst merken (die
 * Nachricht kann noch auf ihren Schlüssel warten). holder: Raum oder Unterhaltung.
 */
function noteReaction(holder, obj, who) {
  if (typeof obj.ref !== 'string' || obj.ref.length > 64 || !REACT_IDS.has(obj.r)) return;
  const on = obj.on !== false && obj.on !== 0;
  const m = holder.byId.get(obj.ref);
  if (m) { setReaction(m, obj.r, who, on); scheduleRender(); return; }
  const wait = holder.rxWait || (holder.rxWait = new Map());
  if (!wait.has(obj.ref) && wait.size >= 500) return;
  if (!wait.has(obj.ref)) wait.set(obj.ref, []);
  const list = wait.get(obj.ref);
  if (list.length < 200) list.push([obj.r, who, on]);
}

/** Gemerkte Reaktionen an eine gerade angekommene Nachricht hängen. */
function takeReactions(holder, m) {
  const list = holder.rxWait && holder.rxWait.get(m.id);
  if (!list) return;
  holder.rxWait.delete(m.id);
  for (const [id, who, on] of list) setReaction(m, id, who, on);
}

async function toggleReaction(m, id) {
  if (!REACT_IDS.has(id)) return;
  const view = Object.assign({}, S.view);
  const on = !hasMyReaction(m, id);
  if (on && m.rx && !m.rx.has(id) && m.rx.size >= REACT_MAX) { toast('Mehr als ' + REACT_MAX + ' verschiedene Reaktionen gehen nicht.', 'error'); return; }
  setReaction(m, id, S.me.id, on);   // gleich zeigen, der Server bestätigt
  scheduleRender();
  try {
    const obj = { t: 'react', ref: m.id, r: id, on: on };
    if (view.kind === 'dm') await sendDmEvent(view.peer, obj);
    else {
      const room = S.rooms.get(view.rid);
      if (!room) throw new Error('Raum nicht gefunden.');
      // Darf ich hier nicht schreiben, geht die Reaktion als solche (rx) – der Server prüft dann „reagieren“.
      await postRoom(room, Object.assign(obj, { ch: view.ch }), rolesOk(room) && !canWriteIn(room, S.me.id, view.ch) ? { rx: 1 } : null);
    }
  } catch (e) {
    setReaction(m, id, S.me.id, !on);
    scheduleRender();
    toast(e.message, 'error');
  }
}

function inviteCard(m) {
  const inv = m.invite;
  const mine = m.from === S.me.id;
  const joined = S.rooms.has(inv.rid);
  const locked = !mine && S.view.kind === 'dm' && isRequest(S.view.peer);   // erst nach dem Annehmen
  return el('div', { class: 'sc-invite tickbox' },
    el('span', { class: 'sc-invite-icon' }, icon('userPlus', 18)),
    el('span', { class: 'sc-invite-text' },
      el('span', { class: 'sc-invite-title', text: mine ? 'Einladung verschickt' : 'Einladung in einen Raum' }),
      el('span', { class: 'sc-invite-name', text: inv.name || 'Raum' })),
    mine ? null : el('button', {
      type: 'button', class: 'btn btn--primary', text: joined ? 'Öffnen' : 'Beitreten', disabled: locked,
      title: locked ? 'Erst die Anfrage annehmen' : null,
      onclick: () => (joined ? openRoom(inv.rid) : joinRoom(inv))
    }));
}

/** Unter einer Anfrage: wer das ist und was du tun kannst. */
function requestBar(peer) {
  const ident = S.ids.get(peer);
  return el('div', { class: 'sc-request tickbox' },
    el('p', { class: 'section-head' }, el('span', { class: 'sq' }), el('span', { class: 'label', text: 'NACHRICHTENANFRAGE' }), el('span', { class: 'rule' })),
    el('p', { class: 'sc-p', text: displayName(ident) + ' ist noch nicht in deinen Kontakten. Bis du annimmst, klingeln keine Anrufe' +
      (unknownCallsAllowed() ? ' (außer du lässt Anrufe von Unbekannten zu)' : '') + ', Links sind nur Text und Einladungen gesperrt. Antworten nimmt die Anfrage auch an.' }),
    ident ? el('p', { class: 'sc-mono sc-request-fp', text: C.formatFingerprint(ident.fp) }) : null,
    el('div', { class: 'sc-card-actions' },
      el('button', { type: 'button', class: 'btn btn--primary', onclick: () => acceptRequest(peer) }, icon('check', 14), 'Annehmen'),
      el('button', { type: 'button', class: 'btn', onclick: () => declineRequest(peer) }, icon('x', 14), 'Ablehnen'),
      ident ? el('button', { type: 'button', class: 'btn sc-btn--danger', onclick: () => { toggleBlock(ident); declineRequest(peer); } }, icon('shield', 14), 'Blockieren') : null));
}

/* ==========================================================================
   Dateien und Bilder – Ende-zu-Ende verschlüsselt
   ==========================================================================
   Jede Datei: eigener Zufallsschlüssel, in 512-KB-Stücken verschlüsselt
   hochgeladen (securecom-core.js). Schlüssel, Name, Typ und – bei Bildern –
   eine kleine Vorschau stehen nur in der verschlüsselten Nachricht. Bilder
   gehen ohne Metadaten (etwa den Aufnahmeort) raus: Sie werden hier neu
   gezeichnet. Die Datei verschwindet mit der Aufbewahrung der Unterhaltung. */
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const RISKY_FILE = /\.(exe|msi|msix|appx|bat|cmd|com|scr|pif|cpl|dll|ps1|psm1|vbs|vbe|js|jse|mjs|wsf|wsh|hta|lnk|url|jar|reg|iso|img|vhd|vhdx|sh|apk|app|dmg|pkg)$/i;
const IMAGE_MAX_SIDE = 4096;   // längere Seite beim Senden
const THUMB_SIDE = 360;        // Vorschau in der Nachricht
const THUMB_MAX_B64 = 20000;
const FILE_CACHE = new Map();  // id → { bytes, url } – zuletzt geöffnete Dateien

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(bytes < 10240 ? 1 : 0).replace('.', ',') + ' KB';
  return (bytes / 1048576).toFixed(1).replace('.', ',') + ' MB';
}

/** Dateiname ohne Pfad und Steuerzeichen, höchstens 120 Zeichen. */
function cleanFileName(name) {
  const base = String(name || '').split(/[\\/]/).pop()
    .replace(/[\u0000-\u001F\u007F<>:"|?*‪-‮⁦-⁩]/g, '').replace(/^[.\s]+/, '').trim();
  return (base || 'Datei').slice(0, 120);
}

function filesSupported() {
  return !!(S.cfg && S.cfg.file_max);
}

/** Angaben zur Datei aus einer Nachricht prüfen – oder null. */
function parseFileMeta(f) {
  if (!f || typeof f !== 'object') return null;
  if (!/^[A-Za-z0-9_-]{22}$/.test(f.id || '') || !/^[A-Za-z0-9_-]{43}$/.test(f.k || '')) return null;
  const s = parseInt(f.s, 10);
  const c = parseInt(f.c, 10);
  if (!(s >= 0) || s > 104857600 || c !== C.fileChunks(s)) return null;
  const out = { id: f.id, k: f.k, s: s, c: c, n: cleanFileName(f.n), m: typeof f.m === 'string' ? f.m.slice(0, 100).toLowerCase() : '' };
  if (IMAGE_TYPES.includes(out.m) && typeof f.th === 'string' && f.th.length <= 40000 && /^[A-Za-z0-9+/]+={0,2}$/.test(f.th)) {
    out.th = f.th;
    out.w = Math.max(0, Math.min(20000, parseInt(f.w, 10) || 0));
    out.h = Math.max(0, Math.min(20000, parseInt(f.h, 10) || 0));
  }
  return out;
}

/* ---------- Senden --------------------------------------------------------- */
function canvasBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function drawScaled(bmp, maxSide, background) {
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(bmp.width * scale));
  cv.height = Math.max(1, Math.round(bmp.height * scale));
  const ctx = cv.getContext('2d');
  if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, cv.width, cv.height); }
  ctx.drawImage(bmp, 0, 0, cv.width, cv.height);
  return cv;
}

/** Kleine Vorschau (JPEG, Base64) – sie reist in der verschlüsselten Nachricht. */
async function makeThumb(bmp) {
  let side = THUMB_SIDE;
  for (let i = 0; i < 6; i++) {
    const blob = await canvasBlob(drawScaled(bmp, side, '#16161a'), 'image/jpeg', i < 3 ? 0.72 : 0.55);
    if (blob) {
      const b64 = C.b64(new Uint8Array(await blob.arrayBuffer()));
      if (b64.length <= THUMB_MAX_B64) return b64;
    }
    side = Math.round(side * 0.8);
  }
  return '';
}

/**
 * Bild neu zeichnen: ohne Metadaten (EXIF mit Ort, Kamera …), längere Seite
 * höchstens IMAGE_MAX_SIDE, dazu eine Vorschau. GIFs bleiben, wie sie sind
 * (Animation) – nur die Vorschau entsteht aus dem ersten Bild.
 */
async function prepareImage(file) {
  let bmp;
  try { bmp = await createImageBitmap(file); } catch (e) { return null; }
  try {
    if (!bmp.width || !bmp.height) return null;
    let out = null;
    if (file.type !== 'image/gif') {
      const png = file.type === 'image/png';
      const cv = drawScaled(bmp, IMAGE_MAX_SIDE, png ? null : '#ffffff');
      let blob = await canvasBlob(cv, png ? 'image/png' : 'image/jpeg', png ? undefined : 0.9);
      let mime = png ? 'image/png' : 'image/jpeg';
      // Durchsichtiges PNG zu groß für den Server: dann eben als JPEG.
      if (blob && png && blob.size > S.cfg.file_max) {
        blob = await canvasBlob(drawScaled(bmp, IMAGE_MAX_SIDE, '#ffffff'), 'image/jpeg', 0.88);
        mime = 'image/jpeg';
      }
      if (blob) out = { blob: blob, mime: mime, w: cv.width, h: cv.height };
    }
    if (!out) out = { blob: file, mime: file.type, w: bmp.width, h: bmp.height };
    out.thumb = await makeThumb(bmp);
    return out;
  } finally {
    if (bmp.close) bmp.close();
  }
}

/**
 * Verschlüsseln und hochladen; onProgress(0…1). Gibt { id, k, c } zurück.
 * rid: Raum, für den die Datei ist – nur dort darf „Nachrichten verwalten“
 * sie mit room.del löschen (ältere Server ignorieren r).
 */
async function uploadEncrypted(bytes, ttl, onProgress, cancelled, rid) {
  const id = C.randomId();
  const raw = C.newFileKey();
  const key = await C.importFileKey(raw);
  const total = C.fileChunks(bytes.length);
  for (let n = 0; n < total; n++) {
    if (cancelled && cancelled()) {
      if (n > 0) api('file.del', { id: id }).catch(() => {});
      throw new Error('Abgebrochen.');
    }
    const part = bytes.subarray(n * C.FILE_CHUNK, Math.min(bytes.length, (n + 1) * C.FILE_CHUNK));
    const body = { id: id, n: n, of: total, size: bytes.length, ttl: ttl, d: C.b64(await C.sealChunk(key, id, n, total, part)) };
    if (rid && n === 0) body.r = rid;
    for (let tries = 1; ; tries++) {
      try {
        await api('file.put', body);
        break;
      } catch (e) {
        // Netz weg oder Server kurz überlastet: noch zweimal versuchen.
        if (tries >= 3 || (e.status && e.status < 500 && e.status !== 429)) throw e;
        await sleep(1500 * tries);
      }
    }
    if (onProgress) onProgress((n + 1) / total);
  }
  return { id: id, k: C.b64url(raw), c: total };
}

/** Zeile über dem Eingabefeld: Name, Fortschritt, Abbrechen. */
function uploadRow(name, size, where) {
  let box = $('sc-uploads');
  if (!box) {
    box = el('div', { id: 'sc-uploads', class: 'sc-uploads', 'aria-live': 'polite' });
    $('sc-compose').before(box);
  }
  let stop = false;
  const fill = el('span', { class: 'sc-upload-fill' });
  const pct = el('span', { class: 'sc-upload-pct', text: 'verschlüsselt …' });
  const row = el('div', { class: 'sc-upload' },
    icon('lock', 13),
    el('span', { class: 'sc-upload-name', text: name, title: name + (where ? ' – an ' + where : '') }),
    el('span', { class: 'sc-upload-size', text: fmtSize(size) }),
    el('span', { class: 'sc-upload-bar' }, fill), pct,
    iconBtn('x', 'Abbrechen', () => { stop = true; pct.textContent = 'wird abgebrochen …'; }));
  box.appendChild(row);
  const gone = () => { row.remove(); if (!box.children.length) box.remove(); };
  return {
    cancelled: () => stop,
    progress: (p) => { fill.style.width = Math.round(p * 100) + '%'; pct.textContent = Math.round(p * 100) + ' %'; },
    done: gone,
    fail: () => { row.classList.add('is-failed'); pct.textContent = stop ? 'abgebrochen' : 'nicht gesendet'; setTimeout(gone, 4000); }
  };
}

/** Wohin gerade geschrieben wird – oder null (Startseite). */
function sendTarget() {
  if (S.view.kind === 'dm') return { kind: 'dm', peer: S.view.peer, name: displayName(S.ids.get(S.view.peer)) };
  if (S.view.kind === 'room' && S.rooms.has(S.view.rid)) {
    const room = S.rooms.get(S.view.rid);
    return { kind: 'room', rid: room.id, ch: S.view.ch, name: room.meta.name };
  }
  return null;
}

async function sendFiles(files) {
  if (!filesSupported()) { toast('Dieser Server nimmt noch keine Dateien an.', 'error'); return; }
  const target = sendTarget();
  if (!target) return;
  for (const file of files) await sendOneFile(file, target);
}

async function sendOneFile(file, target) {
  let blob = file;
  let name = cleanFileName(file.name);
  let mime = IMAGE_TYPES.includes(file.type) ? file.type : 'application/octet-stream';
  let extra = {};
  if (IMAGE_TYPES.includes(file.type)) {
    const img = await prepareImage(file);
    if (img) {
      blob = img.blob;
      mime = img.mime;
      extra = { w: img.w, h: img.h, th: img.thumb };
      if (mime === 'image/jpeg' && !/\.jpe?g$/i.test(name)) name = name.replace(/\.[A-Za-z0-9]{1,5}$/, '') + '.jpg';
      if (!extra.th) delete extra.th;
    }
  }
  if (blob.size > S.cfg.file_max) {
    toast('„' + name + '“ ist zu groß – höchstens ' + fmtSize(S.cfg.file_max) + '.', 'error', 7000);
    return;
  }
  const row = uploadRow(name, blob.size, target.name);
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const ttl = target.kind === 'dm' ? convTtl(target.peer) : chanTtl(S.rooms.get(target.rid), target.ch);
    const up = await uploadEncrypted(bytes, ttl, row.progress, row.cancelled, target.kind === 'room' ? target.rid : '');
    const meta = Object.assign({ id: up.id, k: up.k, s: bytes.length, c: up.c, n: name, m: mime }, extra);
    // Ältere Apps zeigen nur den Text.
    const body = '📎 ' + name + ' (' + fmtSize(bytes.length) + ')';
    if (target.kind === 'dm') await sendDm(target.peer, body, meta);
    else if (S.rooms.has(target.rid)) await sendRoomMessage(S.rooms.get(target.rid), target.ch, body, meta);
    row.done();
  } catch (e) {
    row.fail();
    if (!row.cancelled()) toast(e.message, 'error');
  }
}

/** Eingefügt oder hereingezogen: lieber einmal nachfragen (Bildschirmfotos!). */
function confirmFiles(files) {
  const target = sendTarget();
  if (!target || !files.length) return;
  if (!filesSupported()) { toast('Dieser Server nimmt noch keine Dateien an.', 'error'); return; }
  openModal({
    title: files.length === 1 ? 'DATEI SENDEN' : files.length + ' DATEIEN SENDEN',
    build: (body) => {
      const list = el('ul', { class: 'sc-file-list' });
      for (const f of files) list.appendChild(el('li', {}, el('span', { class: 'sc-file-name', text: cleanFileName(f.name) }), el('span', { class: 'sc-file-size', text: fmtSize(f.size) })));
      const first = files.find((f) => IMAGE_TYPES.includes(f.type));
      if (first) {
        const url = URL.createObjectURL(first);
        const img = el('img', { class: 'sc-file-preview', alt: '', src: url });
        img.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
        body.appendChild(img);
      }
      body.append(list, el('p', { class: 'sc-note', text: 'An ' + target.name + ' – Ende-zu-Ende verschlüsselt. Bilder gehen ohne Metadaten (etwa den Aufnahmeort) raus.' }));
    },
    actions: [
      { label: 'Abbrechen', onClick: (close) => close() },
      { label: 'Senden', primary: true, onClick: (close) => { close(); sendFiles(files); } }
    ]
  });
}

/* ---------- Empfangen ------------------------------------------------------ */
function cacheFile(id, bytes) {
  FILE_CACHE.set(id, { bytes: bytes, url: '' });
  while (FILE_CACHE.size > 12) {
    const [oldId, old] = FILE_CACHE.entries().next().value;
    if (old.url) URL.revokeObjectURL(old.url);
    FILE_CACHE.delete(oldId);
  }
}

/** Ganze Datei holen und entschlüsseln; onProgress(0…1). */
async function fetchFile(f, onProgress) {
  const hit = FILE_CACHE.get(f.id);
  if (hit) return hit.bytes;
  const key = await C.importFileKey(C.unb64url(f.k));
  const out = new Uint8Array(f.s);
  let off = 0;
  for (let n = 0; n < f.c; n++) {
    const r = await api('file.get', { id: f.id, n: n });
    let plain;
    try {
      plain = await C.openChunk(key, f.id, n, f.c, C.unb64(r.d));
    } catch (e) {
      throw new Error('Die Datei ließ sich nicht entschlüsseln – sie wurde unterwegs verändert.');
    }
    if (off + plain.length > f.s) throw new Error('Die Datei passt nicht zur Nachricht.');
    out.set(plain, off);
    off += plain.length;
    if (onProgress) onProgress((n + 1) / f.c);
  }
  if (off !== f.s) throw new Error('Die Datei ist unvollständig.');
  cacheFile(f.id, out);
  return out;
}

function saveBytes(name, bytes) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const a = el('a', { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}

async function downloadFile(f, btn) {
  if (RISKY_FILE.test(f.n)) {
    const ok = await confirmBox('Programm herunterladen?', '„' + f.n + '“ ist ein Programm oder Skript. Öffne es nur, wenn du die Datei erwartet hast und dem Absender vertraust – Schadsoftware kommt oft genau so.', 'Trotzdem herunterladen', true);
    if (!ok) return;
  }
  if (btn) btn.disabled = true;
  try {
    const bytes = await fetchFile(f, (p) => { if (btn) btn.textContent = Math.round(p * 100) + ' %'; });
    saveBytes(f.n, bytes);
  } catch (e) {
    toast(e.message, 'error');
  }
  if (btn) {
    btn.disabled = false;
    btn.replaceChildren(icon('download', 14), 'Herunterladen');
  }
}

/** Bild groß: erst die Vorschau, dann das ganze Bild (entschlüsselt hier). */
function openImage(f) {
  openModal({
    title: 'BILD',
    wide: true,
    build: (body) => {
      const img = el('img', { class: 'sc-viewer-img is-preview', alt: f.n, src: 'data:image/jpeg;base64,' + f.th });
      const status = el('span', { class: 'sc-viewer-status', text: 'wird geladen …' });
      const save = el('button', { type: 'button', class: 'btn', disabled: true }, icon('download', 14), 'Herunterladen');
      body.append(el('div', { class: 'sc-viewer' }, img),
        el('div', { class: 'sc-viewer-bar' }, el('span', { class: 'sc-viewer-name', text: f.n + ' · ' + fmtSize(f.s) }), status, save));
      fetchFile(f, (p) => { status.textContent = 'wird geladen … ' + Math.round(p * 100) + ' %'; }).then((bytes) => {
        const hit = FILE_CACHE.get(f.id);
        if (hit && !hit.url) hit.url = URL.createObjectURL(new Blob([bytes], { type: f.m }));
        img.src = hit ? hit.url : URL.createObjectURL(new Blob([bytes], { type: f.m }));
        img.classList.remove('is-preview');
        status.remove();
        save.disabled = false;
        save.addEventListener('click', () => saveBytes(f.n, bytes));
      }).catch((e) => { status.textContent = e.message; });
    }
  });
}

/** In der Nachricht: Bild-Vorschau oder Datei mit Knopf. */
function fileCard(m) {
  const f = m.file;
  const own = m.from === S.me.id;
  const locked = !own && S.view.kind === 'dm' && isRequest(S.view.peer);   // erst nach dem Annehmen
  if (f.th) {
    if (locked) {
      return el('div', { class: 'sc-file tickbox is-locked' }, el('span', { class: 'sc-file-icon' }, icon('image', 18)),
        el('span', { class: 'sc-file-text' }, el('span', { class: 'sc-file-name', text: 'Bild' }),
          el('span', { class: 'sc-file-size', text: 'sichtbar, sobald du die Anfrage annimmst' })));
    }
    const card = el('button', { type: 'button', class: 'sc-file-image', title: f.n + ' – groß ansehen', onclick: () => openImage(f) },
      el('img', { alt: f.n, src: 'data:image/jpeg;base64,' + f.th }));
    card.style.aspectRatio = String(f.w && f.h ? Math.max(0.25, Math.min(4, f.w / f.h)) : 4 / 3);   // kein Springen beim Laden
    return card;
  }
  const btn = el('button', { type: 'button', class: 'btn', disabled: locked, title: locked ? 'Erst die Anfrage annehmen' : null }, icon('download', 14), 'Herunterladen');
  btn.addEventListener('click', () => downloadFile(f, btn));
  return el('div', { class: 'sc-file tickbox' + (RISKY_FILE.test(f.n) ? ' is-risky' : '') },
    el('span', { class: 'sc-file-icon' }, icon('file', 18)),
    el('span', { class: 'sc-file-text' },
      el('span', { class: 'sc-file-name', text: f.n, title: f.n }),
      el('span', { class: 'sc-file-size', text: fmtSize(f.s) + ' · verschlüsselt' + (RISKY_FILE.test(f.n) ? ' · Programm – Vorsicht' : '') })),
    btn);
}

function emptyThread() {
  if (S.view.kind === 'dm') {
    const ident = S.ids.get(S.view.peer);
    return el('div', { class: 'sc-empty' },
      avatar(ident, 'lg'),
      el('h2', { text: displayName(ident) }),
      el('p', { text: 'Hier beginnt eure Unterhaltung. Alles ist Ende-zu-Ende verschlüsselt – nur ihr beide könnt es lesen.' }),
      el('p', { class: 'sc-mono', text: ident ? C.formatFingerprint(ident.fp) : '' }));
  }
  return el('div', { class: 'sc-empty' },
    el('h2', { text: 'Noch still hier' }),
    el('p', { text: 'Nachrichten in diesem Kanal sind mit dem Raumschlüssel verschlüsselt, den nur die Mitglieder kennen.' }));
}

function homeScreen() {
  const box = el('div', { class: 'sc-home' });
  box.appendChild(el('h1', { class: 'sc-home-title', text: S.me.name ? 'Hallo, ' + S.me.name : 'Willkommen' }));
  box.appendChild(el('p', { class: 'sc-p', text: S.mode === 'temp'
    ? 'Du nutzt eine temporäre Sitzung. Dein Schlüssel lebt nur ' + KEY_HOME + '; nach ' + S.cfg.temp_hours + ' Stunden ohne Nutzung löscht der Server alles.'
    : 'Du bist mit deinem Konto angemeldet. Dein privater Schlüssel liegt nur verschlüsselt auf dem Server.' }));

  const keyCard = el('div', { class: 'sc-card tickbox' },
    el('p', { class: 'section-head' }, el('span', { class: 'sq' }), el('span', { class: 'label', text: 'DEIN SCHLÜSSEL' }), el('span', { class: 'rule' })),
    el('p', { class: 'sc-fp-big', text: C.formatFingerprint(S.me.fp) }),
    el('p', { class: 'sc-note', text: 'Das ist dein Fingerabdruck. Wer dich anrufen will, braucht deinen öffentlichen Schlüssel oder diesen Fingerabdruck.' }),
    el('div', { class: 'sc-card-actions' },
      el('button', { type: 'button', class: 'btn', onclick: () => copyText(S.me.armored, 'Öffentlicher Schlüssel') }, icon('copy', 14), 'Schlüssel kopieren'),
      el('button', { type: 'button', class: 'btn', onclick: () => copyText(C.formatFingerprint(S.me.fp), 'Fingerabdruck') }, icon('copy', 14), 'Fingerabdruck kopieren'),
      S.mode === 'temp' && !S.me.name ? el('button', { type: 'button', class: 'btn', onclick: editAlias }, icon('edit', 14), 'Alias festlegen') : null));

  const how = el('div', { class: 'sc-card tickbox' },
    el('p', { class: 'section-head' }, el('span', { class: 'sq' }), el('span', { class: 'label', text: 'SO GEHT’S' }), el('span', { class: 'rule' })),
    el('ol', { class: 'sc-steps' },
      el('li', { text: 'Jemand ist online? Links in der Liste anklicken – schreiben, anrufen, Video, Bildschirm teilen.' }),
      el('li', { text: 'Du hast einen öffentlichen PGP-Schlüssel oder Fingerabdruck? „Freund hinzufügen“ – nimmt die Person an, seht ihr gegenseitig, ob ihr online seid.' }),
      el('li', { text: 'Für Gruppen: Mit + einen Raum erstellen und den Einladungslink teilen.' })),
    el('div', { class: 'sc-card-actions' },
      el('button', { type: 'button', class: 'btn btn--primary', onclick: connectByKey }, icon('userPlus', 14), 'Freund hinzufügen'),
      el('button', { type: 'button', class: 'btn', onclick: roomDialog }, icon('plus', 14), 'Raum erstellen'),
      el('button', { type: 'button', class: 'btn', onclick: showSecurityInfo }, icon('shield', 14), 'So funktioniert’s')));
  box.append(keyCard, how);
  return box;
}

/* ---------- Eingabe ------------------------------------------------------- */
function renderCompose() {
  const form = $('sc-compose');
  const input = $('sc-input');
  let show = false;
  let placeholder = 'Nachricht';
  let blocked = false;
  if (S.view.kind === 'dm') {
    const ident = S.ids.get(S.view.peer);
    show = true;
    placeholder = 'Nachricht an ' + displayName(ident);
    blocked = !ident || ident.changed || isBlocked(ident);
  } else if (S.view.kind === 'room' && S.rooms.has(S.view.rid)) {
    const room = S.rooms.get(S.view.rid);
    const ch = room.meta.ch.find((c) => c.id === S.view.ch);
    show = true;
    placeholder = room && room.meta.meet ? 'Nachricht an alle im Meeting' : 'Nachricht in #' + (ch ? ch.name : '');
    blocked = !roomKeyRaw(room.id, room.epoch);
    // Rechte: kein Schreibrecht im Raum oder nur bestimmte Ränge in diesem Kanal
    if (!blocked && rolesOk(room) && !canWriteIn(room, S.me.id, S.view.ch)) {
      blocked = true;
      const w = room.cw[S.view.ch];
      placeholder = !(permsOf(room, S.me.id) & RIGHT.SEND) ? 'Du darfst in diesem Raum nicht schreiben'
        : 'Hier dürfen ' + (w.r.length ? 'nur ' + w.r.map((r) => roleName(room, r)).join(', ') : 'nur der Besitzer') + ' schreiben';
    }
  }
  form.hidden = !show;
  input.placeholder = placeholder;
  input.disabled = blocked;
  $('sc-send').disabled = blocked;
  // Büroklammer nur, wenn der Server Dateien annimmt.
  const attach = $('sc-attach');
  if (attach) {
    attach.hidden = !filesSupported();
    attach.disabled = blocked;
    form.classList.toggle('has-attach', !attach.hidden);
  }
}

function autoGrow() {
  const input = $('sc-input');
  input.style.height = 'auto';
  // + 2: der Rahmen zählt bei border-box mit, scrollHeight kennt ihn nicht.
  const full = input.scrollHeight + 2;
  input.style.height = Math.min(full, 220) + 'px';
  input.style.overflowY = full > 220 ? 'auto' : 'hidden';
}

/* ---------- Rechts: Mitglieder oder Profil -------------------------------- */
function renderMembers() {
  const box = $('sc-members');
  box.textContent = '';
  const show = S.view.kind !== 'home';
  box.hidden = !show;
  $('sc-scrim').hidden = !$('sc').classList.contains('side-open');
  if (!show) return;

  if (S.view.kind === 'dm') {
    const ident = S.ids.get(S.view.peer);
    if (!ident) return;
    box.appendChild(profileCard(ident, true));
    return;
  }
  const room = S.rooms.get(S.view.rid);
  if (!room) return;
  const members = room.members.map((m) => S.ids.get(m.id) || { id: m.id, fp: '', name: '…', kind: 'temp', on: null });
  // Online: man selbst, sichtbare temporäre Sitzungen, Freunde und wer im
  // Sprachkanal ist (das sehen Mitglieder ohnehin). Andere Konten verraten
  // ihren Status nicht.
  const here = (i) => i.id === S.me.id || isHere(i) || room.vc.includes(i.id);
  // Wie Discord: zuerst nach höchstem Rang gruppiert (Online zuerst), der Rest nach Status
  const ranked = rolesOk(room) ? rolesSorted(room).map((rid) => [rid, members.filter((i) => memberRoles(room, i.id)[0] === rid)]).filter((g) => g[1].length) : [];
  const grouped = new Set(ranked.flatMap((g) => g[1].map((i) => i.id)));
  const rest = members.filter((i) => !grouped.has(i.id));
  const on = rest.filter(here);
  const hidden = rest.filter((i) => !here(i) && presenceOf(i) === null);
  const off = rest.filter((i) => !here(i) && presenceOf(i) === 'off');
  box.appendChild(el('div', { class: 'sc-members-head' },
    el('span', { class: 'sc-side-title', text: 'Mitglieder' }),
    iconBtn('x', 'Schließen', () => { S.membersOpen = false; renderAll(); }, { class: 'sc-ibtn sc-only-narrow' })));
  const groups = ranked.map(([rid, list]) => [roleName(room, rid).toUpperCase() + ' — ' + list.length, list.slice().sort((a, b) => Number(here(b)) - Number(here(a))), roleColor(room, rid)]);
  for (const [label, list, color] of groups.concat([
    ['ONLINE — ' + on.length, on], ['STATUS VERBORGEN — ' + hidden.length, hidden], ['OFFLINE — ' + off.length, off]])) {
    if (!list.length) continue;
    const head = sectionHead(label);
    if (color) {   // Rang-Gruppe: Quadrat in der Rangfarbe
      head.classList.add('sc-role-head-sec');
      head.style.setProperty('--role', color);
    }
    box.appendChild(head);
    const l = el('div', { class: 'sc-list' });
    for (const ident of list) {
      const row = personRow(ident, () => showProfile(ident.id, room), { color: memberColor(room, ident.id) });
      if (room.owner === ident.id) row.querySelector('.sc-row-name').appendChild(el('span', { class: 'sc-owner', title: 'Besitzer' }, icon('crown', 12)));
      if (room.vc.includes(ident.id)) row.appendChild(icon('speaker', 13));
      if (!room.meta.meet) withMenu(row, () => memberMenu(room, ident));
      l.appendChild(row);
    }
    box.appendChild(l);
  }
}

function profileCard(ident, inPanel) {
  const me = ident.id === S.me.id;
  const card = el('div', { class: 'sc-profile' + (inPanel ? ' sc-profile--panel' : '') });
  const p = presenceOf(ident);
  const f = me ? null : friendOf(ident.id);
  const rel = f && f.st === 'yes' ? ' · Freund' : f && f.st === 'in' ? ' · möchte befreundet sein' : f && f.st === 'out' ? ' · Anfrage gesendet' : '';
  card.append(
    avatar(ident, 'lg'),
    el('h3', { class: 'sc-profile-name' }, displayName(ident), isVerified(ident) ? icon('shieldCheck', 16) : null),
    el('p', { class: 'sc-profile-kind', text: (ident.guest || (me && S.guest) ? 'Gast im Meeting' : ident.kind === 'temp' ? 'Temporäre Sitzung' : 'Konto') + (p ? ' · ' + STATUS[p].label : '') + rel }),
    el('p', { class: 'field-label', text: 'Fingerabdruck' }),
    el('p', { class: 'sc-fp', text: C.formatFingerprint(ident.fp) }));
  if (!me) {
    card.appendChild(el('p', { class: 'sc-note', text: isVerified(ident)
      ? 'Verifiziert: Du hast diesen Fingerabdruck bestätigt.'
      : 'Nicht verifiziert. Vergleiche den Fingerabdruck über einen zweiten Weg (persönlich, Telefon, Signal …). Stimmt er, bist du sicher, dass niemand dazwischensitzt.' }));
    if (ident.guest && !S.guest) card.appendChild(el('p', { class: 'sc-note', text: 'Gast eines Meetings: nur hier im Meeting erreichbar – keine Direktnachrichten, Anrufe oder Freundschaftsanfragen.' }));
  }
  // Gäste (auf beiden Seiten) und der Meeting-Modus: nur Chat und Call im Meeting.
  const direct = !me && !inMeetingMode() && !ident.guest;
  const actions = el('div', { class: 'sc-profile-actions' });
  if (!me) {
    if (!inPanel && direct) actions.appendChild(el('button', { type: 'button', class: 'btn btn--primary', onclick: () => { closeModal(); openDm(ident.id); } }, 'Nachricht'));
    if (direct) {
      actions.append(friendButton(ident),
        el('button', { type: 'button', class: 'btn', onclick: () => { closeModal(); startCall(ident.id, false); } }, icon('phone', 14), 'Anrufen'),
        el('button', { type: 'button', class: 'btn', onclick: () => { closeModal(); startCall(ident.id, true); } }, icon('video', 14), 'Video'));
    }
    actions.append(
      el('button', { type: 'button', class: 'btn', onclick: () => toggleVerified(ident) }, icon(isVerified(ident) ? 'x' : 'shieldCheck', 14), isVerified(ident) ? 'Verifizierung aufheben' : 'Als verifiziert markieren'));
  }
  actions.appendChild(el('button', { type: 'button', class: 'btn', onclick: () => copyText(ident.armored, 'Öffentlicher Schlüssel') }, icon('copy', 14), 'Schlüssel kopieren'));
  if (!me) actions.appendChild(el('button', { type: 'button', class: 'btn sc-btn--danger', onclick: () => toggleBlock(ident) }, icon('eyeOff', 14), isBlocked(ident) ? 'Entblocken' : 'Blockieren'));
  card.appendChild(actions);
  return card;
}

function showProfile(id, room) {
  const ident = S.ids.get(id);
  if (!ident) return;
  openModal({
    title: id === S.me.id ? 'DEIN PROFIL' : 'PROFIL',
    build: (body, close) => {
      body.appendChild(profileCard(ident, false));
      // Ränge im Raum (Abzeichen); wer Ränge vergibt, ändert sie per Rechtsklick in der Mitgliederliste
      const badges = room && room.members.some((m) => m.id === id) ? roleBadges(room, id) : null;
      if (badges) {
        const card = body.querySelector('.sc-profile-kind');
        if (card) card.after(badges); else body.appendChild(badges);
      }
      if (room && rolesOk(room) && can(room, RIGHT.ROLES) && room.members.some((m) => m.id === id) && rolesSorted(room).some((rid) => roleManageable(room, rid))) {
        body.appendChild(el('button', { type: 'button', class: 'btn btn--block', onclick: (ev) => {
          const r = ev.currentTarget.getBoundingClientRect();
          openContextMenu(r.left, r.bottom + 4, memberMenu(room, ident).filter((it) => it.swatch || it.bar));
        } }, icon('tag', 14), 'Ränge vergeben'));
      }
      if (room && room.members.some((m) => m.id === id) && canKick(room, id)) {
        body.appendChild(el('button', { type: 'button', class: 'btn sc-btn--danger btn--block', onclick: () => { close(); kickMember(room, ident); } }, icon('leave', 14), 'Aus dem Raum entfernen'));
      }
      if (id === S.me.id) {
        body.appendChild(el('button', { type: 'button', class: 'btn btn--block', onclick: () => { closeModal(); showSettings(); } }, icon('settings', 14), 'Einstellungen'));
      }
    }
  });
}

function toggleVerified(ident) {
  const c = S.vault.contacts[ident.id] || { fp: ident.fp, n: ident.name, t: Date.now(), v: false };
  c.v = !(c.v && c.fp === ident.fp);
  c.fp = ident.fp;
  S.vault.contacts[ident.id] = c;
  saveVault();
  toast(c.v ? displayName(ident) + ' ist verifiziert.' : 'Verifizierung aufgehoben.', 'ok');
  closeModal();
  renderAll();
}

function toggleBlock(ident) {
  if (S.vault.blocked[ident.fp]) delete S.vault.blocked[ident.fp];
  else {
    S.vault.blocked[ident.fp] = 1;
    if (friendOf(ident.id)) endFriend(ident, false);   // Blockieren beendet die Freundschaft
  }
  saveVault();
  closeModal();
  renderAll();
}

/* ==========================================================================
   Direktnachrichten
   ========================================================================== */
function newConv(peer) {
  return { peer: peer, msgs: [], byId: new Map(), unread: 0, last: 0, typingUntil: 0 };
}

function convOf(peer) {
  let conv = S.convs.get(peer);
  if (!conv) { conv = newConv(peer); S.convs.set(peer, conv); }
  return conv;
}

function insertSorted(list, msg) {
  let i = list.length;
  while (i > 0 && list[i - 1].ts > msg.ts) i--;
  list.splice(i, 0, msg);
}

function isViewing(kind, id, ch) {
  if (document.hidden) return false;
  if (kind === 'dm') return S.view.kind === 'dm' && S.view.peer === id;
  return S.view.kind === 'room' && S.view.rid === id && S.view.ch === ch;
}

/**
 * Neue Nachricht von jemand anderem: Ist die Unterhaltung gerade offen,
 * gilt sie als gelesen (Stand merken), sonst zählt sie als ungelesen.
 */
function noteArrival(key, ts, viewing, countUnread, notice, quiet) {
  if (viewing) {
    S.vault.reads[key] = Math.max(S.vault.reads[key] || 0, ts);
    saveVault();
  } else {
    countUnread();
    if (S.cursorLoaded) {
      if (!quiet) notifySound();
      if (notice) notify('Clavichat', notice, key);
    }
  }
}

/* ---------- Systembenachrichtigungen -------------------------------------- */
/**
 * Nur wenn das Fenster nicht im Blick ist – und nur, wer schreibt oder
 * anruft, nie der Inhalt: Was im Benachrichtigungscenter des Systems
 * landet, liegt dort unverschlüsselt. In der Windows-App standardmäßig an,
 * im Browser erst nach Einschalten in den Einstellungen.
 */
function notifyAllowed() {
  if (typeof Notification !== 'function' || Notification.permission !== 'granted') return false;
  return DESKTOP ? S.vault.settings.notify !== false : !!S.vault.settings.notify;
}

function notify(title, body, tag) {
  if (!notifyAllowed() || (!document.hidden && document.hasFocus())) return;
  // Gesperrt: nicht verraten, wer schreibt oder anruft.
  if (L.locked) {
    title = 'Clavichat';
    body = tag === 'call' ? 'Eingehender Anruf – entsperren, um ihn anzunehmen.' : 'Neue Aktivität – entsperren, um sie zu sehen.';
  }
  try {
    const n = new Notification(title, { body: body, tag: tag || 'securecom', silent: true });
    n.onclick = () => {
      if (DESKTOP) DESKTOP.focus();
      else window.focus();
      n.close();
    };
  } catch (e) { /* hier nicht verfügbar */ }
}

function markRead() {
  // Serverzeit: Die Zeitstempel der Nachrichten stammen vom Server.
  const now = serverNow();
  if (S.view.kind === 'dm') {
    const conv = S.convs.get(S.view.peer);
    if (conv && conv.unread) { conv.unread = 0; S.vault.reads['dm:' + conv.peer] = now; saveVault(); }
  } else if (S.view.kind === 'room') {
    const room = S.rooms.get(S.view.rid);
    if (room && room.unread.get(S.view.ch)) {
      room.unread.set(S.view.ch, 0);
      S.vault.reads['room:' + room.id + ':' + S.view.ch] = now;
      saveVault();
    }
  }
}

/* ---------- Aufbewahrung ---------------------------------------------------
   Wie lange Nachrichten liegen bleiben: je Unterhaltung, mit dem Gegenüber
   abgestimmt (Nachricht t: 'ttl'), Standard 7 Tage. Jeder Eintrag bringt
   seine Dauer zum Server mit. Wird sie kürzer, löscht jede Seite ihre
   älteren Einträge beim Server (inbox.trim) – welche Einträge zu welcher
   Unterhaltung gehören, weiß nur der Browser. Räume: der Besitzer. */
const TTL_CHOICES = [
  { s: 3600, label: '1 Stunde' },
  { s: 86400, label: '24 Stunden' },
  { s: 604800, label: '7 Tage' },
  { s: 2592000, label: '30 Tage' }
];
const TRIM = { pending: new Set(), timer: 0, purge: 0 };

function maxTtl() { return ((S.cfg && S.cfg.retention_days) || 30) * 86400; }
function defaultTtl() { return Math.min((S.cfg && S.cfg.default_ttl) || 604800, maxTtl()); }
function ttlChoices() { return TTL_CHOICES.filter((c) => c.s <= maxTtl()); }

/**
 * Räume „Permanent“ (seit 1.8.9): Der Server meldet dafür einen sehr großen
 * ttl-Wert (100 Jahre) – ältere Apps rechnen damit wie mit ihrer Höchstgrenze.
 * 0: Der Server kennt „Permanent“ nicht.
 */
function permTtl() { return (S.cfg && Number(S.cfg.permanent)) || 0; }
function isPermanentRoom(room) { return !!(room && permTtl() && room.ttl >= permTtl()); }
/** „Permanent“ anbieten: Besitzer mit Konto, bleibender Raum, Server kennt es. */
function permanentOk(room) { return !!(permTtl() && (can(room, RIGHT.ROOM) || can(room, RIGHT.CHANNELS)) && S.mode === 'account' && !room.tmp && !room.meta.meet); }

function ttlLabel(s) {
  if (permTtl() && s >= permTtl()) return 'Permanent';
  const c = TTL_CHOICES.find((x) => x.s === s);
  if (c) return c.label;
  if (s >= 86400) { const d = Math.round(s / 86400); return d + (d === 1 ? ' Tag' : ' Tage'); }
  return Math.max(1, Math.round(s / 3600)) + ' Std.';
}

function convTtl(peer) {
  const t = S.vault && S.vault.ttl && S.vault.ttl[peer];
  return Math.min(t && t.s ? Number(t.s) : defaultTtl(), maxTtl());
}

function roomTtl(room) {
  if (isPermanentRoom(room)) return permTtl();   // nichts verfällt nach Zeit
  return Math.min(room && room.ttl ? room.ttl : defaultTtl(), maxTtl());
}

/**
 * Aufbewahrung je Textkanal (seit 1.8.9, Server meldet cttl): room.ct =
 * { Kanal: Sekunden } nur für Kanäle mit eigener – sonst gilt die des Raums.
 * Ältere Apps kennen ct nicht und zeigen nur die Raum-Aufbewahrung.
 */
function chanTtlOk(room) { return !!(S.cfg && S.cfg.cttl) && can(room, RIGHT.CHANNELS); }
function hasChanTtl(room, ch) { return !!(room && room.ct && ch && room.ct[ch]); }
function chanTtl(room, ch) {
  if (!hasChanTtl(room, ch)) return roomTtl(room);
  const t = room.ct[ch];
  if (permTtl() && t >= permTtl()) return permTtl();
  return Math.min(t, maxTtl());
}
/** Textkanäle mit eigener Aufbewahrung (nur bekannte Kanäle). */
function ownTtlChannels(room) { return room.meta.ch.filter((c) => hasChanTtl(room, c.id)); }
/** Längste Aufbewahrung im Raum (Raum oder irgendein Kanal) – danach richten sich die Raumschlüssel. */
function roomKeepTtl(room) {
  let t = roomTtl(room);
  for (const ch of Object.keys(room.ct || {})) t = Math.max(t, chanTtl(room, ch));
  return t;
}
/** Bleibt irgendetwas im Raum dauerhaft (Raum oder ein Kanal „Permanent“)? */
function keepsPermanent(room) { return !!(permTtl() && roomKeepTtl(room) >= permTtl()); }
function keepText(s) { return permTtl() && s >= permTtl() ? 'bleibt dauerhaft' : 'bleibt ' + ttlLabel(s); }
/** Für room.post: Kanal nur mitschicken, wenn er eine eigene Aufbewahrung oder eigene Schreibrechte hat. */
function chanParam(room, ch) { return hasChanTtl(room, ch) || (room && room.cw && ch && room.cw[ch]) ? { c: ch } : {}; }

/** Abgelaufene Einträge des eigenen Briefkastens beim Server löschen (gesammelt). */
function noteExpired(seq) {
  if (!seq) return;
  TRIM.pending.add(seq);
  clearTimeout(TRIM.timer);
  TRIM.timer = setTimeout(flushTrim, 2000);
}

async function flushTrim() {
  const list = [...TRIM.pending].slice(0, 5000);
  if (!list.length || !S.token) return;
  try {
    await api('inbox.trim', { s: list });
    for (const s of list) TRIM.pending.delete(s);
  } catch (e) { /* beim nächsten Durchgang */ }
}

/** Was älter ist als die Aufbewahrung, verschwindet – aus der Ansicht und beim Server. */
function purgeExpired() {
  if (!S.vault) return;
  const now = serverNow();
  let changed = false;
  for (const conv of S.convs.values()) {
    const limit = now - convTtl(conv.peer) * 1000;
    if (!conv.msgs.some((m) => m.ts < limit && m.state !== 'pending')) continue;
    conv.msgs = conv.msgs.filter((m) => {
      if (m.ts >= limit || m.state === 'pending') return true;
      if (m.seq) TRIM.pending.add(m.seq);
      conv.byId.delete(m.id);
      return false;
    });
    changed = true;
  }
  for (const room of S.rooms.values()) {
    for (const [ch, list] of room.msgs) {
      const limit = now - chanTtl(room, ch) * 1000;
      if (!list.some((m) => m.ts < limit && m.state !== 'pending')) continue;
      room.msgs.set(ch, list.filter((m) => {
        if (m.ts >= limit || m.state === 'pending') return true;
        room.byId.delete(m.id);
        return false;
      }));
      changed = true;
    }
  }
  if (TRIM.pending.size) { clearTimeout(TRIM.timer); TRIM.timer = setTimeout(flushTrim, 500); }
  if (changed) scheduleRender();
}

/**
 * Auswahl der Aufbewahrung – für Unterhaltungen, (Besitzer) Räume und
 * Textkanäle. opt.before: Einträge vor der Liste (Kanal: „Wie der Raum“),
 * opt.std: false blendet „(Standard)“ aus, opt.foot: Hinweise darunter.
 */
function ttlDialog(title, current, note, onPick, extra, opt) {
  opt = opt || {};
  openModal({
    title: title,
    build: (body, close) => {
      const list = el('div', { class: 'sc-quality' });
      for (const c of (opt.before || []).concat(ttlChoices(), extra ? [extra] : [])) {
        list.appendChild(el('button', {
          type: 'button', class: 'sc-quality-opt', 'aria-pressed': c.s === current ? 'true' : 'false',
          onclick: () => { close(); onPick(c.s); }
        },
        el('span', { class: 'sc-quality-name', text: c.label + (opt.std !== false && c.s === defaultTtl() ? ' (Standard)' : '') }),
        el('span', { class: 'sc-quality-info', text: c.info || (c.s <= 86400 ? 'verschwindet schnell' : c.s <= 604800 ? 'eine Woche' : 'so lange es geht') }),
        c.note ? el('span', { class: 'sc-quality-note', text: c.note }) : null));
      }
      body.append(el('p', { class: 'sc-p', text: note }), list,
        ...(opt.foot || []).map((t) => el('p', { class: 'sc-note', text: t })),
        el('p', { class: 'sc-note', text: 'Danach löscht der Server die verschlüsselten Einträge, und sie verschwinden aus der Ansicht. Wer eine Nachricht vorher kopiert oder abfotografiert, behält sie natürlich.' }));
    }
  });
}

function convTtlDialog(peer) {
  const ident = S.ids.get(peer);
  ttlDialog('NACHRICHTEN AUFBEWAHREN', convTtl(peer),
    'Wie lange bleiben die Nachrichten mit ' + displayName(ident) + '? Gilt für euch beide – ' + displayName(ident) + ' sieht die Änderung im Verlauf.',
    (s) => setConvTtl(peer, s));
}

/** Auswahl „Permanent“: Abwägung kurz und ehrlich – kein Löschen nach Zeit heißt auch: keine Forward Secrecy im Raum. */
function permChoice(room, info) {
  if (!permanentOk(room)) return null;
  return {
    s: permTtl(), label: 'Permanent', info: info,
    note: 'Kein Löschen nach Zeit (über ' + ((S.cfg && S.cfg.permanent_mb) || 16) + ' MB fallen die ältesten weg, Dateien nach ' + Math.round(maxTtl() / 86400) +
      ' Tagen). Alte Raumschlüssel bleiben: Entfernte lesen nichts Neues – was sie früher lesen konnten, bleibt für sie lesbar.'
  };
}

/** Kurz: welche Textkanäle eine eigene Aufbewahrung haben (Raum-Menü, Raum-Dialog). */
function ownTtlSummary(room) {
  const own = ownTtlChannels(room);
  if (!own.length) return '';
  if (own.length > 2) return own.length + ' Kanäle mit eigener Aufbewahrung';
  return 'Eigene: ' + own.map((c) => '#' + c.name + ' ' + ttlLabel(chanTtl(room, c.id))).join(', ');
}

function roomTtlDialog(room) {
  const own = ownTtlChannels(room);
  ttlDialog('NACHRICHTEN AUFBEWAHREN', roomTtl(room),
    'Wie lange bleiben die Nachrichten in „' + room.meta.name + '“? Gilt für alle Mitglieder – ältere Nachrichten verschwinden sofort.' +
      (own.length ? ' Kanäle mit eigener Aufbewahrung (' + own.map((c) => '#' + c.name).join(', ') + ') behalten ihre.' : ''),
    async (s) => {
      try {
        await api('room.ttl', { id: room.id, ttl: s });
        await loadRooms();
        purgeExpired();
        toast('Nachrichten in „' + room.meta.name + '“ bleiben jetzt ' + (isPermanentRoom(room) ? 'dauerhaft' : ttlLabel(s)) + '.', 'ok');
      } catch (e) { toast(e.message, 'error'); }
    }, permChoice(room, 'bis der Raum gelöscht wird'),
    { foot: chanTtlOk(room) && room.meta.ch.length > 1 ? ['Einzelne Kanäle stellst du im Kanal-Menü (Rechtsklick auf den Kanal) anders ein.'] : [] });
}

/**
 * Besitzer: eigene Aufbewahrung für einen Textkanal. Dafür erfährt der
 * Server, welche Einträge zu diesem Kanal gehören (Kennung c, nie Name oder
 * Inhalt): Neue Nachrichten bringen sie mit, die schon vorhandenen ordnet
 * dieses Gerät mit ihren Nummern zu, API-Zugänge des Kanals mit ihrer
 * Kennung. „Wie der Raum“ nimmt die Zuordnung beim Server wieder zurück.
 */
function channelTtlDialog(room, ch) {
  const own = hasChanTtl(room, ch.id);
  const hooks = Object.keys(room.meta.hooks || {}).length;
  ttlDialog('KANAL #' + ch.name.toUpperCase() + ' AUFBEWAHREN', own ? chanTtl(room, ch.id) : 0,
    'Wie lange bleiben die Nachrichten in #' + ch.name + '? Gilt für alle Mitglieder – ältere Nachrichten verschwinden sofort, andere Kanäle bleiben unberührt.',
    (s) => setChannelTtl(room, ch, s),
    permChoice(room, 'nur dieser Kanal'),
    {
      std: false,
      before: [{ s: 0, label: 'Wie der Raum (' + ttlLabel(roomTtl(room)) + ')', info: 'Standard', note: 'Folgt der Aufbewahrung des Raums, auch wenn sie sich ändert.' }],
      foot: ['Der Server erfährt dafür, welche Nachrichten zu diesem Kanal gehören – nicht Name oder Inhalt.' +
        (hooks ? ' Beiträge von API-Zugängen in diesen Kanal gelten mit.' : '') +
        ' Apps bis 1.8.8 kennen das noch nicht: Was sie senden, behält der Server so lange wie im Raum.']
    });
}

async function setChannelTtl(room, ch, s) {
  if (s === (hasChanTtl(room, ch.id) ? chanTtl(room, ch.id) : 0)) return;
  try {
    // Bisherige Einträge dieses Kanals (Nachrichten samt Änderungen) und seine API-Zugänge zuordnen.
    const seqs = [];
    const hids = [];
    if (s) {
      for (const m of room.msgs.get(ch.id) || []) {
        if (m.seq) seqs.push(m.seq);
        if (m.xs) seqs.push(...m.xs);
      }
      const first = room.meta.ch[0] && room.meta.ch[0].id;
      for (const [hid, h] of Object.entries(room.meta.hooks || {})) {
        const target = room.meta.ch.some((c) => c.id === h.ch) ? h.ch : first;
        if (target === ch.id) hids.push(hid);
      }
    }
    await api('room.cttl', { id: room.id, c: ch.id, ttl: s, s: seqs, h: hids });
    // Aufräumen: Einträge gelöschter Kanäle (z. B. von einer älteren App gelöscht)
    for (const old of Object.keys(room.ct || {})) {
      if (old !== ch.id && !room.meta.ch.some((c) => c.id === old)) await api('room.cttl', { id: room.id, c: old, ttl: 0 }).catch(() => {});
    }
    await loadRooms();
    purgeExpired();
    renderAll();
    toast(s ? 'Nachrichten in #' + ch.name + ' bleiben jetzt ' + (permTtl() && s >= permTtl() ? 'dauerhaft' : ttlLabel(s)) + '.'
      : '#' + ch.name + ' folgt wieder dem Raum (' + ttlLabel(roomTtl(S.rooms.get(room.id) || room)) + ').', 'ok');
  } catch (e) { toast(e.message, 'error'); }
}

async function setConvTtl(peer, s) {
  if (s === convTtl(peer)) return;
  const ident = S.ids.get(peer);
  try {
    await sendDmEvent(peer, { t: 'ttl', s: s }, maxTtl());   // muss auch Abwesende erreichen
  } catch (e) { toast(e.message, 'error'); return; }
  S.vault.ttl[peer] = { s: s, t: serverNow() };
  saveVault();
  purgeExpired();
  renderAll();
  toast('Nachrichten mit ' + displayName(ident) + ' bleiben jetzt ' + ttlLabel(s) + '.', 'ok');
}

/** Aufbewahrung vom Gegenüber (oder von einem eigenen Gerät) geändert. */
function handleTtl(obj, from, peer, ts, e) {
  const s = Number(obj.s);
  if (!(s >= 3600 && s <= maxTtl())) return;
  const cur = S.vault.ttl[peer];
  if (!cur || (Number(cur.t) || 0) < ts) {
    S.vault.ttl[peer] = { s: s, t: ts };
    saveVault();
  }
  const conv = convOf(peer);
  const id = 'ttl-' + String(obj.id || ts);
  if (!conv.byId.has(id)) {
    const who = from.id === S.me.id ? 'Du hast' : displayName(from) + ' hat';
    const m = { id: id, sys: who + ' die Aufbewahrung auf ' + ttlLabel(s) + ' gestellt.', icon: 'clock', ts: ts, from: '', seq: e.s };
    insertSorted(conv.msgs, m);
    conv.byId.set(id, m);
    conv.last = Math.max(conv.last, ts);
  }
  purgeExpired();
  scheduleRender();
}

async function sendDm(peerId, body, file) {
  const ident = S.ids.get(peerId);
  if (!ident) return;
  const msg = { v: 1, t: 'msg', id: C.randomId(), from: S.me.id, to: peerId, ts: Date.now(), body: body };
  const local = { id: msg.id, from: S.me.id, ts: msg.ts, body: body, state: 'pending' };
  if (file) { msg.file = file; local.file = parseFileMeta(file); }
  const conv = convOf(peerId);
  insertSorted(conv.msgs, local);
  conv.byId.set(local.id, local);
  conv.last = local.ts;
  noteContact(ident);
  if (isRequest(peerId)) acceptRequest(peerId, true);   // Antworten heißt Annehmen
  S.forceBottom = true;
  scheduleRender();
  try {
    await freshIds([peerId]);   // Forward Secrecy: den jüngsten Unterschlüssel des Gegenübers nehmen
    const d = await C.sealFor(msg, [(S.ids.get(peerId) || ident).key, S.me.pub], S.me.priv);
    await api('send', { to: peerId, k: 'dm', d: d, self: true, ttl: convTtl(peerId) });
    local.state = null;
  } catch (e) {
    local.state = 'failed';
    toast(e.message, 'error');
  }
  scheduleRender();
}

/** ttl: wie lange beim Server – Standard die Aufbewahrung der Unterhaltung. */
async function sendDmEvent(peerId, obj, ttl) {
  if (!S.ids.get(peerId)) throw new Error('Unbekannte Person.');
  await freshIds([peerId]);
  const ident = S.ids.get(peerId);
  const msg = Object.assign({ v: 1, id: C.randomId(), from: S.me.id, to: peerId, ts: Date.now() }, obj);
  const d = await C.sealFor(msg, [ident.key, S.me.pub], S.me.priv);
  await api('send', { to: peerId, k: 'dm', d: d, self: true, ttl: ttl || convTtl(peerId) });
  return msg;
}

/** Signal (Anruf, Tippen): nur an den Empfänger, kurzlebig. */
async function sealSignal(toId, obj) {
  const ident = toId === S.me.id ? S.ids.get(S.me.id) : S.ids.get(toId);
  if (!ident) throw new Error('Unbekannte Person.');
  const msg = Object.assign({ v: 1, from: S.me.id, to: toId, ts: Date.now() }, obj);
  return C.sealFor(msg, [ident.key], S.me.priv);
}

async function sendSignal(toId, obj) {
  const d = await sealSignal(toId, obj);
  await api('send', { to: toId, k: 'sig', d: d });
  fastPoll(15000);
}

/**
 * Ein Eintrag aus dem Briefkasten: entschlüsseln, Absender prüfen. Kennen
 * wir den Absender noch nicht, schlagen wir ihn nach und prüfen erneut.
 */
async function handleInboxEntry(e) {
  let res;
  try {
    res = await openForMe(e.d, keyring());
    if (!res.signer && res.obj && typeof res.obj.from === 'string') {
      const [ident] = await ensureIds([res.obj.from]);
      if (ident) res = await C.openSealed(e.d, S.me.priv, [ident.key]);
    }
  } catch (err) {
    return;   // nicht für uns oder beschädigt
  }
  const obj = res.obj;
  if (!res.signer || !obj || typeof obj.from !== 'string') return;
  const from = S.ids.get(obj.from);
  // Die Signatur muss vom Schlüssel der angegebenen Kennung stammen.
  if (!from || from.fp !== res.signer) return;
  if (from.id !== S.me.id && obj.to !== S.me.id) return;
  if (from.id !== S.me.id && isBlocked(from)) return;
  if (e.k === 'dm' && obj.t === 'friend') handleFriend(obj, from, e.t * 1000);
  else if (e.k === 'dm') handleDm(obj, from, e);
  else if (e.k === 'sig') await handleSignal(obj, from, e);
}

function handleDm(obj, from, e) {
  const peer = from.id === S.me.id ? obj.to : from.id;
  if (typeof peer !== 'string') return;
  const ts = e.t * 1000;
  if (obj.t === 'ttl') { handleTtl(obj, from, peer, ts, e); return; }
  // Älter als die Aufbewahrung der Unterhaltung: nicht zeigen, beim Server löschen.
  if (ts + convTtl(peer) * 1000 < serverNow()) { noteExpired(e.s); return; }
  if ((S.vault.cleared[peer] || 0) >= ts) return;   // Unterhaltung hier gelöscht
  // Reaktion: nur an eine vorhandene Unterhaltung (legt keine neue an, ist keine Anfrage)
  if (obj.t === 'react') { const c = S.convs.get(peer); if (c) noteReaction(c, obj, from.id); return; }
  const conv = convOf(peer);
  if (from.id !== S.me.id) {
    if (obj.t === 'msg' || obj.t === 'invite') noteRequest(peer, ts);
    noteContact(from);
  } else if (obj.t === 'msg' && isRequest(peer)) {
    acceptRequest(peer, true);   // deine Antwort – auch von einem anderen Gerät – nimmt an
  }
  const ref = typeof obj.ref === 'string' ? conv.byId.get(obj.ref) : null;

  switch (obj.t) {
    case 'msg':
    case 'invite': {
      const existing = conv.byId.get(obj.id);
      if (existing) {
        // Eigene Nachricht kommt als Kopie zurück: jetzt mit Serverzeit.
        // Gleiche Kennung von jemand anderem: verwerfen.
        if (existing.from !== from.id) break;
        existing.state = null;
        existing.seq = e.s;
        if (existing.ts !== ts) { existing.ts = ts; conv.msgs.sort((a, b) => a.ts - b.ts); }
        break;
      }
      const m = { id: String(obj.id), from: from.id, ts: ts, body: cleanText(obj.body), seq: e.s };
      if (obj.t === 'msg' && obj.file) {
        const f = parseFileMeta(obj.file);
        if (f) m.file = f;
      }
      if (obj.t === 'invite') {
        const inv = obj.invite || {};
        if (!/^[A-Za-z0-9_-]{22}$/.test(inv.rid || '') || !/^[A-Za-z0-9_-]{43}$/.test(inv.key || '')) return;
        m.invite = { rid: inv.rid, code: String(inv.code || ''), key: inv.key, epoch: parseInt(inv.epoch, 10) || 1, name: cleanName(inv.name) };
        m.body = from.id === S.me.id ? 'Einladung in „' + m.invite.name + '“' : 'lädt dich in „' + m.invite.name + '“ ein';
      }
      insertSorted(conv.msgs, m);
      conv.byId.set(m.id, m);
      takeReactions(conv, m);
      conv.last = Math.max(conv.last, ts);
      if (from.id !== S.me.id && ts > (S.vault.reads['dm:' + peer] || 0)) {
        const req = isRequest(peer);   // Anfrage: ohne Ton, ohne Namen
        noteArrival('dm:' + peer, ts, isViewing('dm', peer), () => { conv.unread++; },
          req ? 'Neue Nachrichtenanfrage' : 'Neue Nachricht von ' + displayName(from), req);
      }
      break;
    }
    case 'edit':
      if (ref && ref.from === from.id) { ref.body = cleanText(obj.body); ref.edited = true; }
      break;
    case 'del':
      if (ref && ref.from === from.id) ref.deleted = true;
      break;
  }
  scheduleRender();
}

async function editMessage(m, node) {
  const text = node.querySelector('.sc-msg-text');
  const ta = el('textarea', { class: 'sc-edit', rows: '2' });
  ta.value = m.body;
  S.editing = ta;
  const save = async () => {
    S.editing = null;
    const body = cleanText(ta.value).trim();
    if (!body || body === m.body) { scheduleRender(); return; }
    try {
      if (S.view.kind === 'dm') {
        await sendDmEvent(S.view.peer, { t: 'edit', ref: m.id, body: body });
      } else {
        await postRoom(S.rooms.get(S.view.rid), { t: 'edit', ref: m.id, ch: S.view.ch, body: body });
      }
      m.body = body;
      m.edited = true;
    } catch (e) { toast(e.message, 'error'); }
    scheduleRender();
  };
  ta.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); save(); }
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); S.editing = null; scheduleRender(); }
  });
  text.replaceWith(el('div', { class: 'sc-edit-box' }, ta,
    el('span', { class: 'sc-edit-hint', text: 'Enter speichern · Esc abbrechen' })));
  ta.focus();
}

async function deleteMessage(m) {
  const keep = S.view.kind === 'dm' ? convTtl(S.view.peer) : chanTtl(S.rooms.get(S.view.rid), S.view.ch);
  const ok = await confirmBox('Nachricht löschen', 'Die Nachricht wird bei allen als gelöscht angezeigt. ' +
    (m.file ? 'Die Datei verschwindet sofort vom Server, der' : 'Der') + ' verschlüsselte Eintrag spätestens nach ' + ttlLabel(keep) + '.', 'Löschen', true);
  if (!ok) return;
  try {
    if (S.view.kind === 'dm') await sendDmEvent(S.view.peer, { t: 'del', ref: m.id });
    else await postRoom(S.rooms.get(S.view.rid), { t: 'del', ref: m.id, ch: S.view.ch });
    m.deleted = true;
    if (m.file) api('file.del', { id: m.file.id }).catch(() => {});
  } catch (e) { toast(e.message, 'error'); }
  scheduleRender();
}

/* ---------- Tippen -------------------------------------------------------- */
let lastTyping = 0;
function typingPing() {
  if (S.view.kind !== 'dm') return;
  const now = Date.now();
  if (now - lastTyping < 4000) return;
  lastTyping = now;
  const peer = S.view.peer;
  const ident = S.ids.get(peer);
  if (!ident || ident.on === false) return;   // Konten: Status unbekannt, trotzdem senden
  sealSignal(peer, { t: 'typing' }).then((d) => api('send', { to: peer, k: 'sig', d: d })).catch(() => {});
}

function renderTyping() {
  const box = $('sc-typing');
  box.textContent = '';
  if (S.view.kind !== 'dm') return;
  const conv = S.convs.get(S.view.peer);
  if (conv && conv.typingUntil > Date.now()) {
    box.append(el('span', { class: 'sc-dots' }, el('i'), el('i'), el('i')),
      el('span', { text: displayName(S.ids.get(S.view.peer)) + ' schreibt …' }));
  }
}

/* ==========================================================================
   Freunde: Anfrage, Annahme und gegenseitiger Status
   Die Anfrage ist eine Direktnachricht (PGP-verschlüsselt, signiert) mit
   einem gemeinsamen Geheimnis. Nimmt die andere Seite an, legt jeder seinen
   Status verschlüsselt in sein Fach beim Server und liest das des anderen
   (friendPresence in securecom-core.js). Fremde sehen bei Konten nichts.
   Im Tresor: friends[Kennung] = { st, s, t } mit st 'out' (angefragt),
   'in' (Anfrage bekommen), 'yes' (befreundet), 'no' (abgelehnt/beendet).
   ========================================================================== */
const STATUS = {
  on:   { label: 'Online',      cls: '',         menu: 'Online',              note: 'Nach 10 Minuten ohne Eingabe: abwesend' },
  busy: { label: 'Beschäftigt', cls: ' is-busy', menu: 'Beschäftigt',         note: 'Freunde sehen, dass du beschäftigt bist' },
  away: { label: 'Abwesend',    cls: ' is-away', menu: 'Abwesend',            note: 'Freunde sehen dich als abwesend' },
  off:  { label: 'Offline',     cls: ' is-off',  menu: 'Als offline anzeigen', note: 'Du siehst Freunde weiter, sie dich nicht' }
};
const STATUS_ORDER = ['on', 'busy', 'away', 'off'];
const PRES_READ  = 20000;   // Freunde abfragen
const PRES_BEAT  = 60000;   // eigenen Stand erneuern – der Server vergisst ihn nach 150 s
const PRES_TTL   = 150;     // wie beim Server (SecureCom::PRES_TTL)
const AWAY_AFTER = 600;     // Sekunden ohne Eingabe, dann „abwesend“
const P = {
  idle: false, lastInput: Date.now(), timer: 0, soon: 0, busy: false, again: false,
  lastGet: 0, lastPut: 0, putSig: '', published: new Set(), keys: new Map()
};

function friendOf(id) {
  const f = S.vault && S.vault.friends[id];
  return f && f.st !== 'no' ? f : null;
}

function isFriend(id) {
  const f = friendOf(id);
  return !!(f && f.st === 'yes');
}

/** Die eigene Wahl im Menü unten links. */
function chosenStatus() {
  const s = S.vault && S.vault.settings.status;
  return STATUS[s] ? s : 'on';
}

/** Was Freunde sehen: „Online“ wird ohne Eingabe nach 10 Minuten „Abwesend“. */
function myStatus() {
  const s = chosenStatus();
  return s === 'on' && P.idle ? 'away' : s;
}

/** 'on' | 'busy' | 'away' | 'off' – oder null, wenn unbekannt (Konto, kein Freund). */
function presenceOf(ident) {
  if (!ident) return null;
  if (S.me && ident.id === S.me.id) return myStatus();
  if (isFriend(ident.id)) {
    const p = S.fst.get(ident.id);
    return p ? p.status : 'off';
  }
  return ident.on === true ? 'on' : ident.on === false ? 'off' : null;
}

function isHere(ident) {
  const p = presenceOf(ident);
  return p === 'on' || p === 'busy' || p === 'away';
}

/** Punkt am Profilbild. Grau („offline“) nur bei Freunden – sonst wissen wir es nicht. */
function statusDot(ident) {
  const p = presenceOf(ident);
  if (!p || (p === 'off' && !isFriend(ident.id))) return null;
  return el('span', { class: 'sc-on' + STATUS[p].cls, title: STATUS[p].label });
}

function friendsWith(st) {
  return Object.keys((S.vault && S.vault.friends) || {}).filter((id) => S.vault.friends[id].st === st)
    .map((id) => S.ids.get(id)).filter((i) => i && !isBlocked(i));
}

async function addFriend(ident) {
  if (!ident || ident.id === S.me.id) return;
  const cur = friendOf(ident.id);
  if (cur && cur.st === 'in') { await acceptFriend(ident); return; }
  if (cur) return;   // schon befreundet oder angefragt
  const s = C.newFriendSecret();
  try {
    await sendDmEvent(ident.id, { t: 'friend', op: 'req', s: s }, maxTtl());
  } catch (e) { toast(e.message, 'error'); return; }
  noteContact(ident);
  S.vault.friends[ident.id] = { st: 'out', s: s, t: serverNow() };
  saveVault();
  toast('Anfrage an ' + displayName(ident) + ' geschickt. Sobald sie angenommen ist, seht ihr gegenseitig euren Status.', 'ok', 6000);
  renderAll();
}

async function acceptFriend(ident) {
  const cur = friendOf(ident.id);
  if (!cur || cur.st !== 'in') return;
  try {
    await sendDmEvent(ident.id, { t: 'friend', op: 'yes', s: cur.s }, maxTtl());
  } catch (e) { toast(e.message, 'error'); return; }
  S.vault.friends[ident.id] = { st: 'yes', s: cur.s, t: serverNow() };
  saveVault();
  toast(displayName(ident) + ' ist jetzt dein Freund.', 'ok');
  presenceSoon();
  renderAll();
}

/** Ablehnen, zurückziehen oder entfernen. Die andere Seite erfährt es und räumt auch auf. */
async function endFriend(ident, ask) {
  const cur = friendOf(ident.id);
  if (!cur) return;
  if (ask) {
    const ok = await confirmBox('Freund entfernen', displayName(ident) + ' und du seht danach nicht mehr, ob der andere online ist. Die Unterhaltung bleibt.', 'Entfernen', true);
    if (!ok) return;
  }
  sendDmEvent(ident.id, { t: 'friend', op: 'no', s: cur.s }, maxTtl()).catch(() => { /* bei uns trotzdem beendet */ });
  S.vault.friends[ident.id] = { st: 'no', s: cur.s, t: serverNow() };
  S.fst.delete(ident.id);
  saveVault();
  presenceSoon();
  renderAll();
}

/**
 * Freundschafts-Nachricht vom Gegenüber. Beim Neuladen kommen ältere noch
 * einmal vorbei; die erkennt der Abgleich mit Geheimnis und Zeitpunkt.
 */
function handleFriend(obj, from, ts) {
  if (!S.vault || from.id === S.me.id) return;   // eigene Kopie: der Tresor kennt den Stand
  const cur = S.vault.friends[from.id];
  const s = typeof obj.s === 'string' && /^[A-Za-z0-9_-]{43}$/.test(obj.s) ? obj.s : '';
  if (obj.op === 'req') {
    if (!s || (cur && (cur.s === s || (Number(cur.t) || 0) > ts))) return;
    noteContact(from);
    if (cur && cur.st === 'out') {
      // Beide haben gleichzeitig angefragt: befreundet. Es gilt das Geheimnis
      // der kleineren Kennung – so entscheiden beide Seiten gleich.
      const shared = from.id < S.me.id ? s : cur.s;
      S.vault.friends[from.id] = { st: 'yes', s: shared, t: ts };
      sendDmEvent(from.id, { t: 'friend', op: 'yes', s: shared }, maxTtl()).catch(() => {});
      friendNotice(from, 'ist jetzt dein Freund.');
    } else {
      S.vault.friends[from.id] = { st: 'in', s: s, t: ts };
      friendNotice(from, 'möchte mit dir befreundet sein.');
    }
  } else if (obj.op === 'yes') {
    if (!cur || cur.st !== 'out' || cur.s !== s) return;
    S.vault.friends[from.id] = { st: 'yes', s: s, t: ts };
    friendNotice(from, 'hat deine Anfrage angenommen.');
  } else if (obj.op === 'no') {
    if (!cur || cur.st === 'no' || (s && cur.s !== s)) return;
    S.vault.friends[from.id] = { st: 'no', s: cur.s, t: ts };
    S.fst.delete(from.id);
  } else {
    return;
  }
  saveVault();
  presenceSoon();
  scheduleRender();
}

function friendNotice(from, text) {
  if (!S.cursorLoaded) return;   // beim Start Nachgeholtes nicht melden – es steht in der Liste
  const msg = displayName(from) + ' ' + text;
  if (document.hidden) { notifySound(); notify('Clavichat', msg, 'friend:' + from.id); }
  else toast(msg, 'ok', 6000);
}

/* ---------- Status in den Fächern ----------------------------------------- */
function startPresence() {
  if (P.timer) return;
  const mark = () => { P.lastInput = Date.now(); };
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) window.addEventListener(ev, mark, { capture: true, passive: true });
  let moved = 0;
  window.addEventListener('pointermove', () => { const n = Date.now(); if (n - moved > 5000) { moved = n; mark(); } }, { passive: true });
  P.timer = setInterval(() => presenceTick(false), 5000);
  presenceSoon();
}

function presenceSoon() {
  clearTimeout(P.soon);
  P.soon = setTimeout(() => presenceTick(true), 300);
}

/** Sekunden ohne Eingabe: In der Windows-App zählt der ganze Rechner, im Browser dieses Fenster. */
async function idleSeconds() {
  let idle = (Date.now() - P.lastInput) / 1000;
  if (DESKTOP && typeof DESKTOP.idleSeconds === 'function') {
    try {
      const sys = await DESKTOP.idleSeconds();
      if (typeof sys === 'number' && sys >= 0) idle = sys;
    } catch (e) { /* dann zählen die Eingaben im Fenster */ }
  }
  return idle;
}

/** Abwesend? (für den Status bei Freunden) */
async function checkIdle() {
  const away = await idleSeconds() >= AWAY_AFTER;
  if (away === P.idle) return;
  P.idle = away;
  renderUser();
  scheduleRender();
}

/** Fächer und Schlüssel je Freund (aus dem Geheimnis, einmal berechnet). */
async function presenceKeys(id) {
  const f = friendOf(id);
  if (!f || f.st !== 'yes' || !f.s) return null;
  const hit = P.keys.get(id);
  if (hit && hit.s === f.s) return hit;
  try {
    const k = Object.assign({ id: id, s: f.s }, await C.friendPresence(f.s, S.me.id, id));
    P.keys.set(id, k);
    return k;
  } catch (e) { return null; }
}

/**
 * Ein Takt: eigenen Status in die Fächer legen (jede Minute und bei jeder
 * Änderung), die der Freunde lesen (alle 20 s). „Als offline anzeigen“
 * leert die eigenen Fächer sofort.
 */
async function presenceTick(force) {
  if (!S.me || !S.token || !S.vault) return;
  if (P.busy) { if (force) P.again = true; return; }
  P.busy = true;
  try {
    await checkIdle();
    const ids = Object.keys(S.vault.friends).filter((id) => isFriend(id) && !isBlocked(S.ids.get(id)));
    const keys = (await Promise.all(ids.map(presenceKeys))).filter(Boolean);
    const now = Date.now();
    const status = myStatus();
    const mine = new Set(status === 'off' ? [] : keys.map((k) => k.mine));
    const sig = status + '|' + [...mine].sort().join(',');
    const body = {};
    if (mine.size && (sig !== P.putSig || now - P.lastPut >= PRES_BEAT)) {
      body.put = await Promise.all(keys.map(async (k) => ({ i: k.mine, d: await C.sealPresence(k.key, k.mine, status) })));
    }
    const gone = [...P.published].filter((slot) => !mine.has(slot));
    if (gone.length) body.del = gone;
    if (keys.length && (force || now - P.lastGet >= PRES_READ)) body.get = keys.map((k) => k.theirs);
    if (!body.put && !body.del && !body.get) return;

    const r = await api('pres', body);
    if (body.put) { P.lastPut = now; P.putSig = sig; P.published = new Set(mine); }
    else for (const slot of gone) P.published.delete(slot);
    if (!mine.size) P.putSig = sig;
    if (body.get) {
      P.lastGet = now;
      let changed = false;
      for (const k of keys) {
        const got = r.got && r.got[k.theirs];
        let st = 'off';
        if (got && r.now - got.t <= PRES_TTL) {
          try { st = (await C.openPresence(k.key, k.theirs, got.d)).status; } catch (e) { st = 'off'; }
        }
        const prev = S.fst.get(k.id);
        if (!prev || prev.status !== st) { S.fst.set(k.id, { status: st }); changed = true; }
      }
      if (changed) scheduleRender();
    }
  } catch (e) {
    /* beim nächsten Takt wieder */
  } finally {
    P.busy = false;
    if (P.again) { P.again = false; presenceSoon(); }
  }
}

/** Beim Abmelden: eigene Fächer gleich leeren, statt sie verfallen zu lassen. */
async function clearPresence() {
  if (!P.published.size) return;
  try { await api('pres', { del: [...P.published] }); } catch (e) { /* verfällt nach 150 s */ }
  P.published.clear();
}

async function setStatus(s) {
  if (!STATUS[s] || !S.vault) return;
  // Temporär: Wer „offline“ wählt, verschwindet auch aus der Online-Liste.
  if (S.mode === 'temp' && S.vault.settings.listed === undefined) S.vault.settings.listed = !!S.me.vis;
  S.vault.settings.status = s;
  saveVault();
  await syncListed();
  presenceSoon();
  renderAll();
}

/** Temporäre Sitzungen: in der Online-Liste nur, wenn gewünscht und nicht „offline“. */
async function syncListed() {
  if (S.mode !== 'temp' || inMeetingMode()) return;
  const want = S.vault.settings.listed !== false && chosenStatus() !== 'off';
  if (want === !!S.me.vis) return;
  try {
    await api('card', { vis: want });
    S.me.vis = want;
  } catch (e) { toast(e.message, 'error'); }
}

function openStatusMenu(anchor) {
  const r = anchor.getBoundingClientRect();
  const cur = chosenStatus();
  openContextMenu(r.left, r.top - 6, STATUS_ORDER.map((s) => ({
    dot: s, label: STATUS[s].menu, note: STATUS[s].note, checked: s === cur, run: () => setStatus(s)
  })).concat([{ sep: true }, { icon: 'users', label: 'Profil anzeigen', run: () => showProfile(S.me.id) }]), { above: true });
}

/* ---------- Freunde in Listen, Menüs und Profil ---------------------------- */
function friendMenuItem(ident) {
  if (!ident || ident.id === S.me.id) return null;
  const f = friendOf(ident.id);
  if (!f) return { icon: 'userPlus', label: 'Als Freund hinzufügen', run: () => addFriend(ident) };
  if (f.st === 'in') return { icon: 'userPlus', label: 'Freundschaftsanfrage annehmen', run: () => acceptFriend(ident) };
  if (f.st === 'out') return { icon: 'x', label: 'Anfrage zurückziehen', run: () => endFriend(ident, false) };
  return { icon: 'userMinus', label: 'Freund entfernen', danger: true, run: () => endFriend(ident, true) };
}

function friendMenuItems(ident) {
  return [
    { icon: 'message', label: 'Nachricht', run: () => openDm(ident.id) },
    { icon: 'phone', label: 'Anrufen', run: () => startCall(ident.id, false) },
    { icon: 'users', label: 'Profil anzeigen', run: () => showProfile(ident.id) },
    friendMenuItem(ident)
  ];
}

function friendButton(ident) {
  const f = friendOf(ident.id);
  const act = (fn) => () => { closeModal(); fn(); };
  if (!f) return el('button', { type: 'button', class: 'btn', onclick: act(() => addFriend(ident)) }, icon('userPlus', 14), 'Als Freund hinzufügen');
  if (f.st === 'in') return el('button', { type: 'button', class: 'btn btn--primary', onclick: act(() => acceptFriend(ident)) }, icon('userPlus', 14), 'Anfrage annehmen');
  if (f.st === 'out') return el('button', { type: 'button', class: 'btn', onclick: act(() => endFriend(ident, false)) }, icon('x', 14), 'Anfrage zurückziehen');
  return el('button', { type: 'button', class: 'btn', onclick: act(() => endFriend(ident, true)) }, icon('userMinus', 14), 'Freund entfernen');
}

function renderFriendsSide(body) {
  const incoming = friendsWith('in');
  const outgoing = friendsWith('out');
  if (incoming.length || outgoing.length) {
    body.appendChild(sectionHead('ANFRAGEN — ' + (incoming.length + outgoing.length)));
    const rl = el('div', { class: 'sc-list' });
    for (const ident of incoming) {
      rl.appendChild(el('div', { class: 'sc-req' },
        personRow(ident, () => showProfile(ident.id), { sub: 'möchte befreundet sein' }),
        iconBtn('check', 'Annehmen', () => acceptFriend(ident), { class: 'sc-ibtn sc-ibtn--ok' }),
        iconBtn('x', 'Ablehnen', () => endFriend(ident, false))));
    }
    for (const ident of outgoing) {
      rl.appendChild(el('div', { class: 'sc-req' },
        personRow(ident, () => openDm(ident.id), { sub: 'Anfrage gesendet' }),
        iconBtn('x', 'Anfrage zurückziehen', () => endFriend(ident, false))));
    }
    body.appendChild(rl);
  }

  const rank = (i) => STATUS_ORDER.indexOf(presenceOf(i) || 'off');
  const friends = friendsWith('yes').sort((a, b) => (rank(a) - rank(b)) || displayName(a).localeCompare(displayName(b), 'de'));
  body.appendChild(sectionHead('FREUNDE — ' + friends.filter(isHere).length + ' / ' + friends.length));
  const fl = el('div', { class: 'sc-list' });
  if (!friends.length) {
    fl.appendChild(el('p', { class: 'sc-empty-note', text: 'Noch keine Freunde. Füge jemanden per Schlüssel oder Fingerabdruck hinzu – nimmt er an, seht ihr gegenseitig, ob ihr online seid.' }));
  }
  for (const ident of friends) {
    const row = personRow(ident, () => openDm(ident.id), {
      current: S.view.kind === 'dm' && S.view.peer === ident.id,
      sub: STATUS[presenceOf(ident) || 'off'].label
    });
    withMenu(row, () => friendMenuItems(ident));
    fl.appendChild(row);
  }
  body.appendChild(fl);
}

/* ==========================================================================
   Räume
   ========================================================================== */
function roomKeyRaw(rid, epoch) {
  const r = S.vault.rooms[rid];
  return r && r.k ? r.k[epoch] || null : null;
}

async function roomKey(rid, epoch) {
  const cacheKey = rid + ':' + epoch;
  if (S.roomKeys.has(cacheKey)) return S.roomKeys.get(cacheKey);
  const raw = roomKeyRaw(rid, epoch);
  if (!raw) return null;
  const key = await C.importRoomKey(raw);
  S.roomKeys.set(cacheKey, key);
  return key;
}

function storeRoomKey(rid, epoch, raw, since) {
  const r = S.vault.rooms[rid] || (S.vault.rooms[rid] = { k: {}, rot: 0 });
  if (r.gone && epoch <= r.gone) return;   // schon gelöscht (Forward Secrecy)
  r.k[epoch] = raw;
  r.et = r.et || {};
  if (!r.et[epoch]) r.et[epoch] = since || serverNow();   // seit wann es diese Generation gibt
}

// Der erste Sprachkanal hat die leere Kennung – so kennen ihn auch ältere Fassungen.
const FIRST_VOICE = { id: '', name: 'Sprache' };

function newRoomState(raw) {
  return {
    id: raw.id, owner: raw.owner, epoch: raw.epoch, metaRaw: null, metaEpoch: 0,
    meta: { name: 'Raum', ch: [{ id: 'main', name: 'allgemein' }], vch: [FIRST_VOICE], img: '', roles: {} },
    perm: raw.owner === S.me.id ? P_ALL : P_BASE, dp: P_BASE, rl: {}, mr: {}, cw: {}, vw: {},
    members: [], vc: [], vcs: {}, rev: -1, cursor: null, msgs: new Map(), byId: new Map(),
    unread: new Map(), pending: [], pendingKey: false, lastCh: null
  };
}

/**
 * Wer in welchem Sprachkanal ist (vom Server: Kanal -> Kennungen). vc ist
 * die Gesamtliste. Ein Server ohne Kanäle liefert nur vc – dann ist das
 * der erste Kanal.
 */
function setVoiceState(room, vcs, vc) {
  const src = vcs && typeof vcs === 'object' && !Array.isArray(vcs) ? vcs : { '': Array.isArray(vc) ? vc : [] };
  const map = {};
  for (const ch of Object.keys(src)) {
    const ids = Array.isArray(src[ch]) ? src[ch].filter((id) => typeof id === 'string') : [];
    if (ids.length) map[ch] = ids;
  }
  room.vcs = map;
  room.vc = [...new Set(Object.values(map).flat())];
}

function voiceMembers(room, ch) {
  return (room && room.vcs && room.vcs[ch || '']) || [];
}

/** Raumdaten zum Verschlüsseln: alles Bisherige, dazu die Änderungen. */
function metaOf(room, changes) {
  const m = Object.assign({ name: room.meta.name, ch: room.meta.ch, vch: room.meta.vch, img: room.meta.img || '', aq: room.meta.aq || '', meet: room.meta.meet ? 1 : 0, once: room.meta.once ? 1 : 0,
    hooks: room.meta.hooks || {}, roles: room.meta.roles || {}, hist: room.meta.hist ? 1 : 0, ka: room.meta.ka || {}, ks: room.meta.ks || '' }, changes || {});
  if (!m.img) delete m.img;
  // Verlauf für neue Mitglieder: ältere Raumschlüssel, vom Besitzer signiert
  // (ks). hist/ka daneben nur für ältere Apps; sealMeta setzt alles drei.
  if (!m.hist || !m.ka || !Object.keys(m.ka).length) delete m.ka;
  if (!m.hist) delete m.hist;
  if (!m.hist || !m.ks) delete m.ks;
  if (!m.roles || !Object.keys(m.roles).length) delete m.roles;   // Ränge: { Kennung: { n: Name, c: Farbe } } – Rechte kennt der Server
  if (!m.hooks || !Object.keys(m.hooks).length) delete m.hooks;   // API-Zugänge: { hid: { n, ch, k, c } }
  if (!m.aq) delete m.aq;   // Sprachqualität des Raums (leer: jeder nach eigener Einstellung)
  if (!m.meet) delete m.meet;   // Meeting: Link führt gleich in den Meeting-Raum
  if (!m.once || !m.meet) delete m.once;   // Einmal-Meeting: Gäste nur mit Namen
  return m;
}

async function loadRooms() {
  const r = await api('rooms');
  const seen = new Set();
  for (const raw of r.rooms) {
    seen.add(raw.id);
    let room = S.rooms.get(raw.id);
    if (!room) { room = newRoomState(raw); S.rooms.set(raw.id, room); }
    room.owner = raw.owner;
    room.epoch = raw.epoch;
    room.members = raw.members;
    room.ttl = Number(raw.ttl) || 0;   // Aufbewahrung (Sekunden), legt der Besitzer fest
    // Textkanäle mit eigener Aufbewahrung: { Kanal: Sekunden } (ältere Server: keine)
    room.ct = {};
    if (raw.ct && typeof raw.ct === 'object' && !Array.isArray(raw.ct)) {
      for (const [ch, t] of Object.entries(raw.ct).slice(0, 30)) {
        if (/^[A-Za-z0-9_-]{1,22}$/.test(ch) && Number(t) >= 3600) room.ct[ch] = Number(t);
      }
    }
    room.tmp = !!raw.tmp;              // aus einer temporären Sitzung: verfällt ohne Aktivität
    room.exp = Number(raw.exp) || 0;   // dann weg (Unix-Zeit), wenn bis dahin nichts passiert
    room.ot = !!raw.ot;                // Einmal-Meeting (der Server lässt Gäste mit Link hinein)
    room.ao = !!raw.ao;                // nur Mitglieder mit Konto treten bei (setzt der Besitzer)
    room.iv = typeof raw.iv === 'number' ? raw.iv : null;   // offene Einladungen (ältere Server: unbekannt)
    applyRoleState(room, raw);                                // Ränge, eigene Rechte, Kanal-Rechte
    // Beitrittsanfragen (nur der Besitzer bekommt sie): [{ id, t, x }]
    room.knocks = Array.isArray(raw.pend) ? raw.pend.filter((k) => k && typeof k.id === 'string' && /^[A-Za-z0-9_-]{22}$/.test(k.id)) : [];
    if (room.knocks.length) await ensureIds(room.knocks.map((k) => k.id));
    setVoiceState(room, raw.vcs, raw.vc);
    room.rev = raw.rev;
    room.pendingKey = !roomKeyRaw(room.id, room.epoch);
    await ensureIds(raw.members.map((m) => m.id));
    if (raw.meta !== room.metaRaw) {
      room.metaRaw = raw.meta;
      room.metaEpoch = raw.me;
      await decryptMeta(room);
    }
  }
  for (const rid of [...S.rooms.keys()]) if (!seen.has(rid)) dropRoomLocal(rid);
  if (S.voice) reconcileVoice();
  syncKnocks();
  scheduleRender();
}

async function decryptMeta(room) {
  const key = await roomKey(room.id, room.metaEpoch);
  if (!key || !room.metaRaw) return;
  try {
    let res = await C.openRoom(room.metaRaw, key, room.id, keyring());
    // Seit es Ränge gibt, schreiben auch Mitglieder mit Verwaltungsrechten die
    // Raumdaten – geht so jemand, gelten seine schon angenommenen Raumdaten
    // weiter (mh, mg unten), bis der Besitzer den Schlüssel wechselt.
    if (!res.signer && res.obj && typeof res.obj.from === 'string') {
      const [ident] = await ensureIds([res.obj.from]);
      if (ident) res = await C.openRoom(room.metaRaw, key, room.id, [ident.key]);
    }
    const signer = [...S.ids.values()].find((i) => i.fp === res.signer);
    if (!signer || res.obj.t !== 'meta') return;
    // Annehmen nur von Mitgliedern – Nicht-Mitglieder (Ehemalige, Inhaber
    // eines Links) haben womöglich den Schlüssel, unterschreiben aber keine
    // Raumdaten. Ausnahmen: genau die Raumdaten, die diese App schon
    // angenommen hat (mh), und frühere Verwalter (mg, Raumdaten vor ihrem
    // Gehen). Dazu kein Rückschritt: ältere Generation oder älterer
    // signierter Zeitpunkt als zuletzt angenommen → ablehnen.
    const vr = S.vault.rooms[room.id] || (S.vault.rooms[room.id] = { k: {}, rot: 0 });
    const hash = await metaHash(room.metaRaw);
    const member = room.members.some((m) => m.id === signer.id);
    if (vr.mh !== hash) {
      if (!member && !(Array.isArray(vr.mg) && vr.mg.includes(signer.id))) return;
      const ts = Number(res.obj.ts) || 0, mx = Number(vr.mx) || 0, mt = Number(vr.mt) || 0;
      if (res.epoch < mx || (res.epoch === mx && ts + (Number(res.obj.mv) >= 2 ? META_SKEW_NEW : META_SKEW) < mt)) return;
      if (res.epoch > mx) { vr.mx = res.epoch; vr.mt = ts; } else vr.mt = Math.max(mt, ts);
      vr.mh = hash;
      if (member && !(vr.mg || []).includes(signer.id)) vr.mg = (vr.mg || []).concat(signer.id).slice(-MG_MAX);
      saveVault();
    }
    const ch = Array.isArray(res.obj.ch) ? res.obj.ch
      .filter((c) => c && /^[A-Za-z0-9_-]{1,22}$/.test(c.id)).slice(0, 30)
      .map((c) => ({ id: c.id, name: cleanName(c.name).replace(/\s+/g, '-').slice(0, 30) || 'kanal' })) : [];
    // Sprachkanäle: der erste ("") immer, weitere aus den Raumdaten.
    const vch = Array.isArray(res.obj.vch) ? res.obj.vch
      .filter((c) => c && typeof c.id === 'string' && (c.id === '' || /^[A-Za-z0-9_-]{1,22}$/.test(c.id))).slice(0, 20)
      .map((c) => ({ id: c.id, name: cleanName(c.name).slice(0, 30) || 'Sprache' })) : [];
    if (!vch.some((c) => c.id === '')) vch.unshift(FIRST_VOICE);
    const img = safeRoomImage(res.obj.img);
    const aq = AUDIO_QUALITY.some((q) => q.id === res.obj.aq) ? res.obj.aq : '';
    const aqChanged = !!room.meta && (room.meta.aq || '') !== aq;
    // API-Zugänge: Name, Ziel-Kanal und privater Schlüssel (liest die Beiträge)
    const hooks = {};
    if (res.obj.hooks && typeof res.obj.hooks === 'object' && !Array.isArray(res.obj.hooks)) {
      for (const [hid, h] of Object.entries(res.obj.hooks).slice(0, 5)) {
        if (!/^[A-Za-z0-9_-]{22}$/.test(hid) || !h || typeof h.k !== 'string' || !/^[A-Za-z0-9_-]{100,400}$/.test(h.k)) continue;
        hooks[hid] = { n: cleanName(h.n) || 'API', ch: typeof h.ch === 'string' && /^[A-Za-z0-9_-]{1,22}$/.test(h.ch) ? h.ch : '', k: h.k, c: Number(h.c) || 0 };
      }
    }
    // Ränge: nur Name und Farbe (verschlüsselt); Rechte und Reihenfolge kommen vom Server
    const roles = {};
    if (res.obj.roles && typeof res.obj.roles === 'object' && !Array.isArray(res.obj.roles)) {
      for (const [rid, v] of Object.entries(res.obj.roles).slice(0, 40)) {
        if (!/^[A-Za-z0-9_-]{6,22}$/.test(rid) || !v || typeof v !== 'object') continue;
        roles[rid] = { n: cleanName(v.n).slice(0, 30) || 'Rang', c: ROLE_COLORS.some((x) => x.id === v.c) ? v.c : ROLE_COLORS[0].id };
      }
    }
    // Verlauf für neue Mitglieder: ältere Generationen des Raumschlüssels –
    // nur aus dem vom Besitzer signierten Archiv (ks) dieser Generation.
    // hist/ka ohne gültiges ks (Apps bis 1.9.2, Ränge, Fälschungen) zählen nicht.
    const arch = await keyArchiveOf(room, res.obj.ks, res.epoch);
    const hist = arch ? 1 : 0;
    const ka = arch ? arch.ka : {};
    room.meta = { name: cleanName(res.obj.name) || 'Raum', ch: ch.length ? ch : [{ id: 'main', name: 'allgemein' }], vch: vch, img: img, aq: aq, meet: res.obj.meet === 1 ? 1 : 0,
      once: res.obj.meet === 1 && res.obj.once === 1 ? 1 : 0, hooks: hooks, roles: roles, hist: hist, ka: ka, ks: arch ? res.obj.ks : '', ksE: arch ? res.epoch : 0,
      histLegacy: !arch && res.obj.hist === 1 ? 1 : 0 };
    room.metaOk = true;
    await takeKeyArchive(room, ka);
    // Widerrufene Zugänge: ihre Beiträge verschwinden aus der Ansicht.
    for (const [chId, list] of room.msgs) {
      if (!list.some((m) => m.hook && !hooks[m.hook.id])) continue;
      room.msgs.set(chId, list.filter((m) => !(m.hook && !hooks[m.hook.id])));
    }
    // Beiträge von API-Zugängen, die auf die Raumdaten gewartet haben
    const early = room.pending.filter((p) => p.k === 'hook');
    if (early.length) {
      room.pending = room.pending.filter((p) => p.k !== 'hook');
      for (const p of early) roomHook(room, p).catch(() => {});
    }
    for (const c of room.meta.ch) if (!room.msgs.has(c.id)) room.msgs.set(c.id, []);
    // Sprachqualität des Raums geändert, während man drin ist: sofort übernehmen.
    if (aqChanged && S.voice && S.voice.rid === room.id) applyAudioQuality();
  } catch (e) { /* bleibt beim Platzhalter */ }
}

/* ==========================================================================
   Ränge und Rechte (an Discord angelehnt)
   Der Server setzt die Rechte durch und kennt dafür Rang-Kennungen, Rechte
   (Bits), Reihenfolge und wer welchen Rang hat – Namen und Farben stehen
   nur verschlüsselt in den Raumdaten (meta.roles). Der Besitzer hat immer
   alles; Raumschlüssel, „Nur Konten“, Beitrittsanfragen und „Raum löschen“
   bleiben bei ihm allein.
   ========================================================================== */
const RIGHT = { SEND: 1, REACT: 2, VOICE: 4, INVITE: 8, CHANNELS: 16, ROOM: 32, MESSAGES: 64, KICK: 128, HOOKS: 256, ROLES: 512, ADMIN: 1024 };
const P_ALL = 2047;
const P_BASE = 15;   // „@alle“ ohne eigene Einstellung (so verhalten sich auch Räume älterer Server)
// „Einladen“ (Bit 8) steht nicht mehr zur Wahl: In Räume laden nur der
// Besitzer und Ränge mit „Administrator“ ein (der Server prüft es, auch für
// ältere Links). Gespeicherte Bits bleiben unverändert – der Editor ändert
// nur die Schalter unten, Bit 8 wirkt nur noch in Meetings.
const PERMS = [
  { bit: RIGHT.SEND, label: 'Nachrichten schreiben', note: 'In Textkanälen schreiben – einzelne Kanäle können das weiter einschränken.' },
  { bit: RIGHT.REACT, label: 'Reagieren', note: 'Mit Symbolen auf Nachrichten reagieren.' },
  { bit: RIGHT.VOICE, label: 'Sprachkanäle betreten', note: 'Sprechen, Video und Bildschirm teilen.' },
  { bit: RIGHT.CHANNELS, label: 'Kanäle verwalten', note: 'Anlegen, umbenennen, löschen, verschieben; Aufbewahrung und Rechte je Kanal.' },
  { bit: RIGHT.ROOM, label: 'Raum verwalten', note: 'Name, Raumbild, Aufbewahrung und Sprachqualität.' },
  { bit: RIGHT.MESSAGES, label: 'Nachrichten verwalten', note: 'Nachrichten anderer für alle löschen.' },
  { bit: RIGHT.KICK, label: 'Mitglieder entfernen', note: 'Nur mit niedrigerem Rang. Den neuen Raumschlüssel verteilt der Besitzer, sobald er online ist.' },
  { bit: RIGHT.HOOKS, label: 'API-Zugänge', note: 'Zugänge für Skripte anlegen und widerrufen (nur Konten).' },
  { bit: RIGHT.ROLES, label: 'Ränge verwalten', note: 'Ränge unter dem eigenen anlegen, ändern und vergeben – nur mit Rechten, die man selbst hat.' },
  { bit: RIGHT.ADMIN, label: 'Administrator', note: 'Alle Rechte, Kanal-Beschränkungen gelten nicht. Schlüssel, „Nur Konten“ und Raum löschen bleiben beim Besitzer.', danger: true }
];
const ROLE_COLORS = [
  { id: 'orange', label: 'Orange', hex: '#f97316' },
  { id: 'red', label: 'Rot', hex: '#ef4444' },
  { id: 'pink', label: 'Rosa', hex: '#ec4899' },
  { id: 'violet', label: 'Violett', hex: '#a855f7' },
  { id: 'blue', label: 'Blau', hex: '#3b82f6' },
  { id: 'cyan', label: 'Türkis', hex: '#06b6d4' },
  { id: 'green', label: 'Grün', hex: '#22c55e' },
  { id: 'yellow', label: 'Gelb', hex: '#ca8a04' },
  { id: 'sand', label: 'Sand', hex: '#a8a29e' },
  { id: 'gray', label: 'Grau', hex: '#71717a' }
];
// Vorlagen beim Anlegen (nur Rechte, die man selbst vergeben darf, werden übernommen)
const ROLE_TEMPLATES = [
  { n: 'Moderator', c: 'blue', p: RIGHT.SEND | RIGHT.REACT | RIGHT.VOICE | RIGHT.MESSAGES | RIGHT.KICK, note: 'Löscht Nachrichten, entfernt Störer' },
  { n: 'Redaktion', c: 'orange', p: RIGHT.SEND | RIGHT.REACT | RIGHT.VOICE, note: 'Für Ankündigungs-Kanäle: dort schreibt nur sie' },
  { n: 'Admin', c: 'red', p: RIGHT.ADMIN | RIGHT.SEND | RIGHT.REACT | RIGHT.VOICE | RIGHT.CHANNELS | RIGHT.ROOM | RIGHT.MESSAGES | RIGHT.KICK | RIGHT.HOOKS | RIGHT.ROLES, note: 'Alle Rechte außer den Schlüsseln – lädt auch ein' }
];

/** Ränge-Stand vom Server übernehmen (ältere Server: nichts davon – Besitzer alles, sonst „@alle“). */
function applyRoleState(room, raw) {
  const okId = (x) => typeof x === 'string' && /^[A-Za-z0-9_-]{6,22}$/.test(x);
  room.perm = typeof raw.perm === 'number' ? raw.perm & P_ALL : (raw.owner === S.me.id ? P_ALL : P_BASE);
  room.dp = typeof raw.dp === 'number' ? raw.dp & P_ALL : P_BASE;
  room.rl = {};
  if (raw.rl && typeof raw.rl === 'object' && !Array.isArray(raw.rl)) {
    for (const [rid, v] of Object.entries(raw.rl).slice(0, 40)) {
      if (okId(rid) && v && typeof v === 'object') room.rl[rid] = { p: Number(v.p) & P_ALL, o: Number(v.o) || 0 };
    }
  }
  room.mr = {};
  if (raw.mr && typeof raw.mr === 'object' && !Array.isArray(raw.mr)) {
    for (const [id, list] of Object.entries(raw.mr)) {
      if (Array.isArray(list)) room.mr[id] = list.filter((r) => okId(r) && room.rl[r]);
    }
  }
  room.cw = {};
  if (raw.cw && typeof raw.cw === 'object' && !Array.isArray(raw.cw)) {
    for (const [c, v] of Object.entries(raw.cw)) {
      if (/^[A-Za-z0-9_-]{1,22}$/.test(c) && v && Array.isArray(v.r)) room.cw[c] = { r: v.r.filter((r) => room.rl[r]), t: Number(v.t) || 0 };
    }
  }
  room.vw = {};
  if (raw.vw && typeof raw.vw === 'object' && !Array.isArray(raw.vw)) {
    for (const [c, v] of Object.entries(raw.vw)) {
      if ((c === '' || /^[A-Za-z0-9_-]{1,22}$/.test(c)) && Array.isArray(v)) room.vw[c] = v.filter((r) => room.rl[r]);
    }
  }
}

/** Gibt der Server Ränge her (und ist das kein Meeting)? */
function rolesOk(room) { return !!(S.cfg && S.cfg.roles) && !!room && !room.meta.meet && !room.ot; }
/** Eigenes Recht im Raum (Besitzer: immer). */
function can(room, bit) { return !!room && (room.owner === S.me.id || !!(room.perm & bit)); }
/** In den Raum einladen (Link oder direkt): nur Besitzer und Administratoren. Meetings: siehe canShareLink. */
function canInvite(room) { return !!room && (room.owner === S.me.id || !!(room.perm & RIGHT.ADMIN)); }
const INVITE_NOTE = 'Einladungen erstellt der Besitzer oder ein Admin.';
/** Ränge eines Mitglieds, höchster zuerst. */
function memberRoles(room, id) { return (room.mr[id] || []).filter((r) => room.rl[r]).sort((a, b) => room.rl[b].o - room.rl[a].o); }
/** Wirksame Rechte eines Mitglieds (wie beim Server). */
function permsOf(room, id) {
  if (room.owner === id) return P_ALL;
  let p = room.dp;
  for (const r of memberRoles(room, id)) p |= room.rl[r].p;
  return p & RIGHT.ADMIN ? P_ALL : p;
}
/** Höchster Rang (Reihenfolge); Besitzer über allen, ohne Rang 0. */
function topOf(room, id) {
  if (room.owner === id) return Infinity;
  return memberRoles(room, id).reduce((t, r) => Math.max(t, room.rl[r].o), 0);
}
/** Darf $id in Textkanal ch schreiben (aktueller Stand)? */
function canWriteIn(room, id, ch) {
  const p = permsOf(room, id);
  if (room.owner === id || p & RIGHT.ADMIN) return true;
  if (!(p & RIGHT.SEND)) return false;
  const w = room.cw[ch];
  return !w || memberRoles(room, id).some((r) => w.r.includes(r));
}
function canEnterVoice(room, id, ch) {
  const p = permsOf(room, id);
  if (room.owner === id || p & RIGHT.ADMIN) return true;
  if (!(p & RIGHT.VOICE)) return false;
  const w = room.vw[ch || ''];
  return !w || memberRoles(room, id).some((r) => w.includes(r));
}
/** Darf ich diesen Rang ändern/vergeben (unter meinem höchsten)? */
function roleManageable(room, rid) { return can(room, RIGHT.ROLES) && (room.owner === S.me.id || (room.rl[rid] && room.rl[rid].o < topOf(room, S.me.id))); }
function roleName(room, rid) { return (room.meta.roles && room.meta.roles[rid] && room.meta.roles[rid].n) || 'Rang ' + rid.slice(0, 4); }
function roleColor(room, rid) {
  const c = room.meta.roles && room.meta.roles[rid] && room.meta.roles[rid].c;
  return (ROLE_COLORS.find((x) => x.id === c) || ROLE_COLORS[9]).hex;
}
/** Farbe des höchsten Rangs mit Farbe (für Namen in Liste und Verlauf), sonst null. */
function memberColor(room, id) {
  if (!room || !rolesOk(room)) return null;
  const top = memberRoles(room, id)[0];
  return top ? roleColor(room, top) : null;
}
/** Ränge von oben nach unten. */
function rolesSorted(room) { return Object.keys(room.rl).sort((a, b) => room.rl[b].o - room.rl[a].o); }
function bitCount(p) { let n = 0; for (const x of PERMS) if (p & x.bit) n++; return n; }

/** Wer darf hier schreiben/betreten – kurz, für Kopfzeile und Eingabefeld. */
/**
 * Kanal mit Beschränkung (Seitenleiste): immer ein Schloss. Darf man selbst,
 * ist es offen und gedämpft, sonst geschlossen und kräftiger.
 */
function chanLock(rule, mine, yes, no) {
  const text = rule + ' – ' + (mine ? yes : no);
  return el('span', { class: 'sc-chan-lock' + (mine ? ' is-mine' : ''), title: text, 'aria-label': text, role: 'img' }, icon(mine ? 'unlock' : 'lock', 12));
}

function channelWho(room, list) {
  if (!list.length) return 'nur der Besitzer';
  const names = list.map((r) => roleName(room, r));
  return 'nur ' + (names.length > 3 ? names.slice(0, 3).join(', ') + ' …' : names.join(', '));
}

/**
 * Raum-Eintrag in einem Kanal mit Schreibrecht nur für bestimmte Ränge
 * anzeigen? Der Server prüft das Recht nur, wenn die App den Kanal (c)
 * mitschickt – eine ältere oder manipulierte App lässt ihn weg. Gezeigt
 * wird deshalb: was der Server geprüft hat (c = Kanal, keine Reaktion r),
 * was vor der Beschränkung kam, und was ein laut aktuellen Rängen
 * Berechtigter (signiert) geschrieben hat. Reaktionen: wer reagieren darf.
 */
function roomPostAllowed(room, who, ch, e, obj) {
  if (!rolesOk(room)) return true;
  if (obj.t === 'react') return e.r === 1 || !!(permsOf(room, who) & RIGHT.REACT);
  if (e.r === 1) return false;   // als Reaktion geprüft, kein Text
  const w = room.cw[ch];
  if (!w) return true;
  if (e.c === ch) return true;
  if (w.t && e.t < w.t) return true;
  return canWriteIn(room, who, ch);
}

/* ---------- Raum-Menü → Ränge ------------------------------------------------ */
async function roleCall(room, a, body) {
  const r = await api(a, Object.assign({ id: room.id }, body));
  await loadRooms();
  return r;
}

/** Name/Farbe in die Raumdaten (verschlüsselt). null = Eintrag entfernen. */
async function saveRoleMeta(room, rid, entry) {
  const cur = S.rooms.get(room.id) || room;
  const roles = Object.assign({}, cur.meta.roles || {});
  if (entry) roles[rid] = entry; else delete roles[rid];
  // Ränge, die es beim Server nicht mehr gibt, bei der Gelegenheit vergessen
  for (const k of Object.keys(roles)) if (!cur.rl[k]) delete roles[k];
  await updateMeta(cur, metaOf(cur, { roles: roles }));
}

function rolesDialog(room) {
  openModal({
    title: 'RÄNGE',
    build: (body, close) => {
      room = S.rooms.get(room.id) || room;
      const owner = room.owner === S.me.id;
      appendAll(body, el('p', { class: 'sc-p', text: 'Ränge bündeln Rechte – wie bei Discord. Höher steht über niedriger: Wer Ränge verwaltet, ändert und vergibt nur Ränge unter seinem eigenen und nur Rechte, die er selbst hat. ' +
        (owner ? 'Du bist Besitzer und stehst über allen.' : 'Der Besitzer steht über allen.') }));
      const ids = rolesSorted(room);
      const list = el('div', { class: 'sc-roles' });
      const count = (rid) => room.members.filter((m) => (room.mr[m.id] || []).includes(rid)).length;
      const move = async (rid, dir) => {
        const up = ids.slice().reverse();   // unten → oben
        const i = up.indexOf(rid);
        const j = i + dir;
        if (j < 0 || j >= up.length) return;
        [up[i], up[j]] = [up[j], up[i]];
        try { await roleCall(room, 'role.order', { ids: up }); close(); rolesDialog(room); } catch (e) { toast(e.message, 'error'); }
      };
      let drag = null;
      ids.forEach((rid, idx) => {
        const ok = roleManageable(room, rid);
        const n = count(rid);
        const below = ids[idx + 1];
        const above = ids[idx - 1];
        const row = el('div', { class: 'sc-role-row' + (ok ? '' : ' is-locked'), dataset: { role: rid } },
          el('span', { class: 'sc-role-dot', style: '--role:' + roleColor(room, rid) }),
          el('button', { type: 'button', class: 'sc-role-main', onclick: () => { close(); roleEditor(room, rid); } },
            el('span', { class: 'sc-role-name', text: roleName(room, rid), style: 'color:' + roleColor(room, rid) }),
            el('span', { class: 'sc-role-sub', text: (n === 1 ? '1 MITGLIED' : n + ' MITGLIEDER') + ' · ' + (room.rl[rid].p & RIGHT.ADMIN ? 'ADMINISTRATOR' : bitCount(room.rl[rid].p) + ' RECHTE') })),
          ok ? null : el('span', { class: 'sc-role-lock', title: 'Steht nicht unter deinem Rang' }, icon('lock', 13)),
          ok ? iconBtn('arrowUp', 'Nach oben', () => move(rid, 1), { class: 'sc-ibtn sc-ibtn--tiny', disabled: !above || !roleManageable(room, above) }) : null,
          ok ? iconBtn('arrowDown', 'Nach unten', () => move(rid, -1), { class: 'sc-ibtn sc-ibtn--tiny', disabled: !below }) : null);
        if (ok) {
          // Ziehen wie bei den Kanälen
          row.draggable = true;
          row.addEventListener('dragstart', (ev) => { drag = rid; ev.dataTransfer.effectAllowed = 'move'; try { ev.dataTransfer.setData('text/plain', rid); } catch (e) { /* egal */ } row.classList.add('is-dragging'); });
          row.addEventListener('dragend', () => { drag = null; row.classList.remove('is-dragging'); list.querySelectorAll('.drop-before, .drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after')); });
          row.addEventListener('dragover', (ev) => {
            if (!drag || drag === rid) return;
            ev.preventDefault();
            const r = row.getBoundingClientRect();
            list.querySelectorAll('.drop-before, .drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
            row.classList.add(ev.clientY > r.top + r.height / 2 ? 'drop-after' : 'drop-before');
          });
          row.addEventListener('drop', async (ev) => {
            if (!drag || drag === rid) return;
            ev.preventDefault();
            const after = row.classList.contains('drop-after');
            const order = ids.filter((x) => x !== drag);   // oben → unten
            order.splice(order.indexOf(rid) + (after ? 1 : 0), 0, drag);
            drag = null;
            try { await roleCall(room, 'role.order', { ids: order.slice().reverse() }); close(); rolesDialog(room); } catch (e) { toast(e.message, 'error'); close(); rolesDialog(room); }
          });
        }
        list.appendChild(row);
      });
      // „@alle“ ganz unten
      list.appendChild(el('div', { class: 'sc-role-row is-base' },
        el('span', { class: 'sc-role-dot is-base' }),
        el('button', { type: 'button', class: 'sc-role-main', onclick: () => { close(); roleEditor(room, ''); } },
          el('span', { class: 'sc-role-name', text: '@alle' }),
          el('span', { class: 'sc-role-sub', text: 'JEDES MITGLIED · ' + bitCount(room.dp) + ' RECHTE' }))));
      appendAll(body, sectionHead('RANGORDNUNG — ' + ids.length + ' / ' + ((S.cfg && S.cfg.roles) || 20)), list,
        ids.length ? el('p', { class: 'sc-note', text: 'Ziehen oder Pfeile ändern die Reihenfolge. Mitglieder erscheinen in der Farbe ihres höchsten Rangs.' }) : null);

      if (ids.length < ((S.cfg && S.cfg.roles) || 20)) {
        const tpl = el('div', { class: 'sc-role-tpls' });
        for (const t of ROLE_TEMPLATES) {
          tpl.appendChild(el('button', { type: 'button', class: 'sc-role-tpl', title: t.note, onclick: () => { close(); roleEditor(room, null, t); } },
            el('span', { class: 'sc-role-dot', style: '--role:' + ROLE_COLORS.find((c) => c.id === t.c).hex }),
            el('span', { class: 'sc-role-tpl-text' }, el('span', { text: t.n }), el('span', { class: 'sc-role-sub', text: t.note }))));
        }
        appendAll(body, sectionHead('NEUER RANG'), tpl,
          el('button', { type: 'button', class: 'btn btn--primary btn--block', onclick: () => { close(); roleEditor(room, null); } }, icon('plus', 14), 'Eigenen Rang anlegen'));
      }
      appendAll(body, el('p', { class: 'sc-note sc-hook-foot', text: 'Der Server kennt nur zufällige Kennungen, Rechte und Reihenfolge der Ränge und wer welchen hat – Namen und Farben stehen verschlüsselt in den Raumdaten. Apps bis 1.8.8 zeigen keine Ränge; die Rechte gelten trotzdem.' }));
    }
  });
}

/** Rang bearbeiten (rid) oder anlegen (rid null, optional aus Vorlage); rid '' = „@alle“. */
function roleEditor(room, rid, tpl) {
  room = S.rooms.get(room.id) || room;
  const base = rid === '';
  const fresh = rid === null;
  const myPerms = room.owner === S.me.id ? P_ALL : room.perm;
  const editable = base ? can(room, RIGHT.ROLES) : fresh ? can(room, RIGHT.ROLES) : roleManageable(room, rid);
  let p = base ? room.dp : fresh ? ((tpl ? tpl.p : RIGHT.SEND | RIGHT.REACT | RIGHT.VOICE) & myPerms) : room.rl[rid].p;
  let color = fresh ? (tpl ? tpl.c : ROLE_COLORS[4].id) : base ? '' : ((room.meta.roles[rid] && room.meta.roles[rid].c) || ROLE_COLORS[9].id);
  openModal({
    title: base ? 'RANG @ALLE' : fresh ? 'RANG ANLEGEN' : 'RANG BEARBEITEN',
    build: (body, close) => {
      const name = base ? null : el('input', { type: 'text', maxlength: '30', placeholder: 'z. B. Moderator', value: fresh ? (tpl ? tpl.n : '') : roleName(room, rid), disabled: !editable });
      const preview = el('span', { class: 'sc-role-preview' });
      const drawPreview = () => {
        if (base) return;
        preview.textContent = '';
        const hex = (ROLE_COLORS.find((c) => c.id === color) || ROLE_COLORS[9]).hex;
        preview.append(el('span', { class: 'sc-role-dot', style: '--role:' + hex }), el('span', { text: cleanName(name.value) || 'Rang', style: 'color:' + hex }));
      };
      if (!base) {
        const sw = el('div', { class: 'sc-role-colors', role: 'listbox', 'aria-label': 'Farbe' });
        const drawSw = () => {
          sw.textContent = '';
          for (const c of ROLE_COLORS) {
            sw.appendChild(el('button', { type: 'button', class: 'sc-role-color', role: 'option', title: c.label, 'aria-label': c.label, 'aria-selected': c.id === color ? 'true' : 'false', disabled: !editable,
              style: 'background:' + c.hex, onclick: () => { color = c.id; drawSw(); drawPreview(); } }));
          }
        };
        drawSw();
        name.addEventListener('input', drawPreview);
        drawPreview();
        appendAll(body, el('div', { class: 'sc-role-head' }, preview), field('Name', name), field('Farbe', sw));
      } else {
        appendAll(body, el('p', { class: 'sc-p', text: 'Rechte jedes Mitglieds – auch ohne Rang. Ränge geben nur zusätzliche Rechte dazu.' }));
      }
      if (!editable) appendAll(body, el('p', { class: 'sc-note', text: 'Dieser Rang steht nicht unter deinem eigenen – nur ansehen.' }));
      // Rechte als Schalter
      const box = el('div', { class: 'sc-rm-rows sc-role-perms' });
      const drawPerms = () => {
        box.textContent = '';
        for (const x of PERMS) {
          const on = !!(p & x.bit);
          const mayToggle = editable && !!(myPerms & x.bit);
          const b = el('button', { type: 'button', class: 'sc-menu-item sc-rm-row' + (x.danger ? ' is-danger' : ''), role: 'switch', 'aria-checked': on ? 'true' : 'false', disabled: !mayToggle,
            title: mayToggle ? null : editable ? 'Dieses Recht hast du selbst nicht' : null,
            onclick: () => { p ^= x.bit; drawPerms(); } },
          el('span', { class: 'sc-rm-text' }, el('span', { text: x.label }), el('span', { class: 'sc-rm-note', text: x.note })),
          el('span', { class: 'sc-rm-switch' }, el('span', { class: 'sc-rm-switch-text', text: on ? 'AN' : 'AUS' }), el('span', { class: 'sc-rm-knob' })));
          box.appendChild(b);
        }
      };
      drawPerms();
      appendAll(body, sectionHead('RECHTE'), box,
        el('p', { class: 'sc-note sc-role-invite-note' }, icon('userPlus', 13), 'Einladen: nur der Besitzer und Ränge mit „Administrator“.'));

      // Mitglieder mit diesem Rang (nur bestehende Ränge)
      if (!base && !fresh) {
        const mem = el('div', { class: 'sc-list sc-role-members' });
        const drawMem = () => {
          mem.textContent = '';
          const cur = S.rooms.get(room.id) || room;
          for (const m of cur.members) {
            const ident = S.ids.get(m.id);
            const has = (cur.mr[m.id] || []).includes(rid);
            const allowed = editable && (cur.owner === S.me.id || m.id === S.me.id || topOf(cur, m.id) < topOf(cur, S.me.id));
            mem.appendChild(el('button', { type: 'button', class: 'sc-role-member', role: 'checkbox', 'aria-checked': has ? 'true' : 'false', disabled: !allowed,
              onclick: async () => {
                try { await roleCall(cur, 'role.assign', { r: rid, member: m.id, on: !has }); drawMem(); } catch (e) { toast(e.message, 'error'); }
              } },
            avatar(ident, 'xs'), el('span', { class: 'sc-role-member-name', text: displayName(ident) }), has ? icon('check', 14) : null));
          }
        };
        drawMem();
        appendAll(body, sectionHead('MITGLIEDER'), mem);
      }

      if (editable) {
        const go = el('button', { type: 'button', class: 'btn btn--primary btn--block' }, icon('check', 14), fresh ? 'Rang anlegen' : 'Speichern');
        go.addEventListener('click', async () => {
          const n = base ? '' : cleanName(name.value).slice(0, 30);
          if (!base && !n) { name.focus(); return; }
          go.disabled = true;
          try {
            const id = fresh ? C.randomId().slice(0, 12) : rid;
            const cur = S.rooms.get(room.id) || room;
            if (fresh || base || cur.rl[id].p !== p) await roleCall(cur, 'role.set', { r: id, p: p });
            if (!base) {
              const old = cur.meta.roles[id];
              if (fresh || !old || old.n !== n || old.c !== color) await saveRoleMeta(S.rooms.get(room.id) || cur, id, { n: n, c: color });
            }
            close();
            toast(base ? 'Rechte von @alle gespeichert.' : fresh ? 'Rang „' + n + '“ angelegt.' : 'Rang gespeichert.', 'ok');
            if (fresh) roleEditor(S.rooms.get(room.id) || room, id); else rolesDialog(S.rooms.get(room.id) || room);
          } catch (e) { go.disabled = false; toast(e.message, 'error'); }
        });
        appendAll(body, go);
        if (!base && !fresh) {
          appendAll(body, el('button', { type: 'button', class: 'btn sc-btn--danger btn--block', onclick: async () => {
            const ok = await confirmBox('Rang löschen', '„' + roleName(room, rid) + '“ verschwindet bei allen Mitgliedern und aus den Kanal-Rechten. Kanäle, in denen nur dieser Rang schreiben durfte, bleiben beschränkt.', 'Löschen', true);
            if (!ok) { roleEditor(room, rid); return; }
            try {
              await roleCall(room, 'role.del', { r: rid });
              await saveRoleMeta(S.rooms.get(room.id) || room, rid, null).catch(() => {});
              toast('Rang gelöscht.', 'ok');
            } catch (e) { toast(e.message, 'error'); }
            rolesDialog(S.rooms.get(room.id) || room);
          } }, icon('trash', 14), 'Rang löschen'));
        }
      }
      appendAll(body, el('button', { type: 'button', class: 'btn btn--block', onclick: () => { close(); rolesDialog(S.rooms.get(room.id) || room); } }, icon('back', 14), 'Alle Ränge'));
      if (name && fresh) setTimeout(() => name.focus(), 60);
    }
  });
}

/* ---------- Kanal → Berechtigungen ------------------------------------------ */
function channelPermDialog(room, kind, c) {
  room = S.rooms.get(room.id) || room;
  const voice = kind === 'vch';
  const cur = voice ? room.vw[c.id] : (room.cw[c.id] && room.cw[c.id].r);
  let mode = !cur ? 'all' : cur.length ? 'roles' : 'owner';
  let picked = new Set(cur || []);
  const ids = rolesSorted(room);
  openModal({
    title: 'BERECHTIGUNGEN · ' + (voice ? c.name.toUpperCase() : '#' + c.name.toUpperCase()),
    build: (body, close) => {
      appendAll(body, el('p', { class: 'sc-p', text: voice ? 'Wer darf „' + c.name + '“ betreten?' : 'Wer darf in #' + c.name + ' schreiben?' }));
      const opts = el('div', { class: 'sc-quality' });
      const roles = el('div', { class: 'sc-list sc-role-pick' });
      const draw = () => {
        opts.textContent = '';
        for (const o of [
          { id: 'all', name: 'Alle Mitglieder', info: 'Standard', note: voice ? 'Jeder, der Sprachkanäle betreten darf.' : 'Jeder, der schreiben darf.' },
          { id: 'roles', name: 'Nur bestimmte Ränge', info: ids.length ? '' : 'NOCH KEINE', note: ids.length ? 'Auswahl unten. Besitzer und Administratoren immer.' : 'Lege zuerst Ränge an (Raum-Menü → Ränge).' },
          { id: 'owner', name: 'Nur Besitzer', info: '', note: 'Und Ränge mit „Administrator“.' }
        ]) {
          opts.appendChild(el('button', { type: 'button', class: 'sc-quality-opt', 'aria-pressed': mode === o.id ? 'true' : 'false', disabled: o.id === 'roles' && !ids.length,
            onclick: () => { mode = o.id; draw(); } },
          el('span', { class: 'sc-quality-name', text: o.name }), el('span', { class: 'sc-quality-info', text: o.info }), el('span', { class: 'sc-quality-note', text: o.note })));
        }
        roles.textContent = '';
        roles.hidden = mode !== 'roles';
        for (const rid of ids) {
          const has = picked.has(rid);
          roles.appendChild(el('button', { type: 'button', class: 'sc-role-member', role: 'checkbox', 'aria-checked': has ? 'true' : 'false',
            onclick: () => { if (has) picked.delete(rid); else picked.add(rid); draw(); } },
          el('span', { class: 'sc-role-dot', style: '--role:' + roleColor(room, rid) }), el('span', { class: 'sc-role-member-name', text: roleName(room, rid), style: 'color:' + roleColor(room, rid) }), has ? icon('check', 14) : null));
        }
      };
      draw();
      const go = el('button', { type: 'button', class: 'btn btn--primary btn--block' }, icon('check', 14), 'Speichern');
      go.addEventListener('click', async () => {
        const w = mode === 'all' ? null : mode === 'owner' ? [] : [...picked].filter((r) => room.rl[r]);
        if (mode === 'roles' && !w.length) { toast('Wähle mindestens einen Rang – oder „Nur Besitzer“.', 'error'); return; }
        go.disabled = true;
        try {
          await roleCall(room, 'room.cperm', { c: c.id, v: voice ? 1 : 0, w: w });
          close();
          toast(w === null ? (voice ? 'Alle dürfen „' + c.name + '“ betreten.' : 'Alle dürfen in #' + c.name + ' schreiben.')
            : (voice ? '„' + c.name + '“ betreten jetzt ' : 'In #' + c.name + ' schreiben jetzt ') + channelWho(S.rooms.get(room.id) || room, w) + '.', 'ok');
        } catch (e) { go.disabled = false; toast(e.message, 'error'); }
      });
      appendAll(body, opts, roles,
        el('p', { class: 'sc-note', text: voice ? 'Zuhören heißt hier betreten – wer drin ist, hört und spricht.'
          : 'Lesen können alle Mitglieder des Raums: Die Ende-zu-Ende-Verschlüsselung gilt für den ganzen Raum, nicht je Kanal. Reagieren bleibt allen erlaubt, die reagieren dürfen.' }),
        voice ? null : el('p', { class: 'sc-note', text: 'Der Server prüft das Schreibrecht, wenn die App den Kanal nennt – er erfährt dafür, welche Beiträge zu diesem Kanal gehören (nicht Name oder Inhalt). Apps bis 1.8.8 kennen das nicht: Was sie ohne Recht hier schreiben, blenden neuere Apps aus.' }),
        go);
    }
  });
}

/* ---------- Mitglied: Rechtsklick ------------------------------------------- */
function canKick(room, id) {
  return id !== S.me.id && room.owner !== id && can(room, RIGHT.KICK) && (room.owner === S.me.id || topOf(room, id) < topOf(room, S.me.id));
}

function memberMenu(room, ident) {
  const items = [{ icon: 'users', label: 'Profil anzeigen', run: () => showProfile(ident.id, room) }];
  if (rolesOk(room) && can(room, RIGHT.ROLES)) {
    const list = rolesSorted(room).filter((rid) => roleManageable(room, rid));
    const allowed = room.owner === S.me.id || ident.id === S.me.id || topOf(room, ident.id) < topOf(room, S.me.id);
    if (list.length) {
      items.push({ sep: true }, { bar: el('div', { class: 'sc-ctx-head', text: 'RÄNGE' }) });
      for (const rid of list) {
        const has = (room.mr[ident.id] || []).includes(rid);
        items.push({ swatch: roleColor(room, rid), label: roleName(room, rid), checked: has, disabled: !allowed,
          run: () => roleCall(room, 'role.assign', { r: rid, member: ident.id, on: !has }).catch((e) => toast(e.message, 'error')) });
      }
    }
  }
  if (canKick(room, ident.id)) items.push({ sep: true }, { icon: 'leave', label: 'Aus dem Raum entfernen', danger: true, run: () => kickMember(room, ident) });
  return items;
}

/** Rang-Abzeichen (Profil). */
function roleBadges(room, id) {
  if (!rolesOk(room)) return null;
  const list = memberRoles(room, id);
  if (!list.length && room.owner !== id) return null;
  return el('div', { class: 'sc-role-badges' },
    room.owner === id ? el('span', { class: 'sc-role-badge is-owner' }, icon('crown', 11), 'Besitzer') : null,
    ...list.map((rid) => el('span', { class: 'sc-role-badge', style: '--role:' + roleColor(room, rid) }, el('span', { class: 'sc-role-dot' }), roleName(room, rid))));
}

/** Räume aus temporären Sitzungen löscht der Server nach so vielen Tagen ohne Aktivität. */
function tempRoomDays() {
  const d = S.cfg && Number(S.cfg.temp_room_days);
  return d > 0 ? d : 7;
}

function tempRoomNote(room) {
  const d = tempRoomDays();
  const when = room.exp ? new Date(room.exp * 1000).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '';
  return 'Aus einer temporären Sitzung erstellt: Der Server löscht den Raum samt Verlauf nach ' + (d === 1 ? '1 Tag' : d + ' Tagen') +
    ' ohne Aktivität' + (when ? ' – ohne neue Nachricht, Sprachkanal oder Beitritt am ' + when : '') + '.';
}

function dropRoomLocal(rid) {
  // Meeting-Modus: Das Meeting ist weg (beendet, abgelaufen, entfernt) – damit endet die Sitzung.
  if (inMeetingMode() && rid === S.meetRid) { guestEnded(S.closingMeeting === rid ? 'closed' : 'ended'); return; }
  if (S.voice && S.voice.rid === rid) leaveVoice(true);
  S.rooms.delete(rid);
  if (S.view.kind === 'room' && S.view.rid === rid) setView({ kind: 'home' });
}

function roomDialog() {
  let tab = 'create';
  openModal({
    title: 'RAUM',
    build: (body, close) => {
      const tabs = el('div', { class: 'sc-tabs' });
      const panel = el('div');
      body.append(tabs, panel);
      const draw = () => {
        tabs.textContent = '';
        panel.textContent = '';
        [['create', 'Erstellen'], ['join', 'Beitreten']].forEach(([k, l]) => tabs.appendChild(el('button', {
          type: 'button', class: 'sc-tab', 'aria-selected': k === tab ? 'true' : 'false', text: l, onclick: () => { tab = k; draw(); }
        })));
        if (tab === 'create') {
          const name = el('input', { type: 'text', maxlength: '40', placeholder: 'z. B. Projekt Nordlicht' });
          const go = el('button', { type: 'button', class: 'btn btn--primary btn--block', text: 'Raum erstellen' });
          // Nur Konten: Räume temporärer Sitzungen verfallen ohnehin.
          const ao = S.mode === 'account' ? el('input', { type: 'checkbox', id: 'sc-room-ao' }) : null;
          go.addEventListener('click', async () => {
            const n = cleanName(name.value);
            if (!n) { name.focus(); return; }
            go.disabled = true;
            try { await createRoom(n, ao && ao.checked ? { ao: true } : undefined); close(); } catch (e) { go.disabled = false; toast(e.message, 'error'); }
          });
          name.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go.click(); });
          panel.append(field('Name des Raums', name, 'Name und Kanäle sind verschlüsselt – der Server sieht nur eine zufällige Kennung.'));
          if (ao) {
            panel.append(el('label', { class: 'sc-check sc-ao-check' }, ao,
              el('span', {}, el('strong', { text: 'Nur Mitglieder mit Konto' }),
                el('span', { class: 'sc-field-note', text: 'Wer einen Einladungslink ohne Konto öffnet, wird zur Kontoerstellung geführt – temporäre Sitzungen können nicht beitreten. Später im Raum-Menü änderbar.' }))));
          }
          if (S.mode === 'temp') {
            const d = tempRoomDays();
            panel.append(el('p', { class: 'sc-note', text: 'Du bist temporär angemeldet: Diesen Raum löscht der Server nach ' + (d === 1 ? '1 Tag' : d + ' Tagen') + ' ohne Aktivität – auch wenn andere drin sind.' }));
          }
          panel.append(go);
        } else {
          const link = el('input', { type: 'text', placeholder: WEB_URL + '#join=…' });
          const go = el('button', { type: 'button', class: 'btn btn--primary btn--block', text: 'Beitreten' });
          const parse = () => {
            const m = /#(join|meet|once)=([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})\.(\d{1,6})/.exec(link.value.trim());
            return m ? { rid: m[2], code: m[3], key: m[4], epoch: parseInt(m[5], 10), meet: m[1] !== 'join', once: m[1] === 'once' } : null;
          };
          // Vorschau, sobald ein gültiger Link drinsteht: wohin er führt.
          const preview = el('div', { class: 'sc-inv-paste' });
          let shown = '';
          const showPreview = () => {
            const inv = parse();
            const k = inv ? inv.rid + '.' + inv.code + '.' + inv.key : '';
            if (k === shown) return;
            shown = k;
            preview.textContent = '';
            if (inv) preview.appendChild(invitePreviewSlot(inv));
          };
          link.addEventListener('input', showPreview);
          go.addEventListener('click', () => {
            const inv = parse();
            if (!inv) { toast('Das ist kein gültiger Einladungslink.', 'error'); return; }
            close();
            joinRoom({ rid: inv.rid, code: inv.code, key: inv.key, epoch: inv.epoch });
          });
          panel.append(field('Einladungslink', link, 'Der Teil nach „#“ enthält den Raumschlüssel. Er wird nie an den Server geschickt.'), preview, go);
        }
      };
      draw();
    }
  });
}

async function createRoom(name, opts) {
  const rid = await createRoomOnly(name, opts);
  await loadRooms();
  openRoom(rid);
  return rid;
}

/** Raum (oder Meeting) beim Server anlegen, ohne ihn zu öffnen. */
async function createRoomOnly(name, opts) {
  const meet = !!(opts && opts.meet);
  const once = meet && !!opts.once;
  const rid = C.randomId();
  const raw = C.newRoomKey();
  const key = await C.importRoomKey(raw);
  const ch = [{ id: C.randomId().slice(0, 10), name: meet ? 'chat' : 'allgemein' }];
  const obj = { v: 1, t: 'meta', mv: 2, room: rid, name: name, ch: ch, vch: [FIRST_VOICE], from: S.me.id, ts: serverNow() };
  if (meet) obj.meet = 1;
  if (once) obj.once = 1;
  const meta = await C.sealRoom(obj, key, 1, rid, S.me.priv);
  // Schlüssel zuerst sichern – ohne ihn wäre der Raum unlesbar.
  storeRoomKey(rid, 1, raw);
  await saveVault(true);
  // Meetings verfallen nach onceHours() Ruhe. Räume von Konten bleiben, aus
  // temporären Sitzungen verfallen sie (setzt der Server).
  // „Nur Mitglieder mit Konto“ (ao) gibt es nur für Räume von Konten, nie für Meetings.
  const ao = !meet && !!(opts && opts.ao) && S.mode === 'account';
  await api('room.create', once ? { id: rid, meta: meta, once: 1 } : ao ? { id: rid, meta: meta, ao: 1 } : { id: rid, meta: meta });
  return rid;
}

/* ---------- Nur Mitglieder mit Konto ----------------------------------------
   Der Besitzer kann einen Raum (nicht Meetings) auf Konten beschränken. Das
   Merkmal steht offen beim Server ("ao"), der es beim Beitritt durchsetzt:
   Temporäre Sitzungen und Gäste lehnt er ab (Antwortfeld "account"). Damit
   die App zu einem Link gleich die Kontoerstellung zeigt statt der
   temporären Sitzung, fragt sie vorher nach (invite.info – ohne Anmeldung,
   nur mit gültiger Einladung). Der Link selbst bleibt unverändert, so
   verstehen ihn auch ältere Apps. Wer schon im Raum ist, bleibt. */
const AO_NOTE = 'Nur Mitglieder mit Konto: Neue Mitglieder brauchen ein Konto – temporäre Sitzungen können nicht beitreten. Wer schon drin ist, bleibt.';

/** Lässt der Raum hinter dieser Einladung nur Konten zu? Ältere Server kennen die Frage nicht: dann nein. */
async function inviteAccountsOnly(inv) {
  return (await inviteInfo(inv)).ao;
}

/* ---------- Vorschau einer Einladung ----------------------------------------
   invite.info liefert mit gültiger Einladung auch die verschlüsselten
   Raumdaten (m, Generation me) und die Mitgliederzahl (n). Entschlüsselt
   wird hier mit dem Schlüssel aus dem Link – der Server sieht Name und Bild
   nie. AES-GCM mit dem Raumschlüssel (gebunden an Raum und Generation)
   genügt für die Vorschau; die Unterschrift prüft erst decryptMeta nach dem
   Beitritt. Passt die Generation nicht zum Link, gibt es keine Vorschau.
   Fehlt etwas (alter Server, Netz, ungültig): Seite wie ohne Vorschau. */
const INVITE_INFO = new Map();   // "rid.code" → Promise<{ ao, preview }>

function inviteInfo(inv) {
  if (!inv || !inv.rid || !inv.code) return Promise.resolve({ ao: false, preview: null });
  const k = inv.rid + '.' + inv.code;
  let p = INVITE_INFO.get(k);
  if (!p) {
    p = (async () => {
      let r;
      try {
        r = await api('invite.info', { id: inv.rid, code: inv.code });
      } catch (e) {
        INVITE_INFO.delete(k);   // Netz o. Ä.: beim nächsten Mal erneut fragen
        return { ao: false, preview: null };
      }
      return { ao: !inv.meet && r.ao === true, preview: await invitePreview(inv, r) };
    })();
    INVITE_INFO.set(k, p);
  }
  return p;
}

/** Raumbild: nur ein eingebettetes Bild, nie eine Adresse. */
function safeRoomImage(v) {
  return typeof v === 'string' && v.length <= 60000 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(v) ? v : '';
}

async function invitePreview(inv, r) {
  if (!r || typeof r.m !== 'string' || !r.m || Number(r.me) !== inv.epoch || !C) return null;
  try {
    if (C.roomEpoch(r.m) !== inv.epoch) return null;
    const res = await C.openRoom(r.m, await C.importRoomKey(inv.key), inv.rid, []);
    const o = res.obj;
    if (!o || o.t !== 'meta') return null;
    const meet = o.meet === 1;
    const n = Number(r.n);
    return {
      name: cleanName(o.name) || (meet ? 'Meeting' : 'Raum'),
      img: safeRoomImage(o.img),
      meet: meet,
      members: Number.isInteger(n) && n >= 0 && n <= 100000 ? n : null
    };
  } catch (e) {
    return null;
  }
}

/** Karte „Du wirst eingeladen in …“ (Bild bzw. Kürzel mit Farbstrich, Name, Mitglieder, NUR KONTEN). */
function invitePreviewCard(inv, p, ao, cls) {
  const pic = el('span', { class: 'sc-rm-pic' + (p.meet ? ' is-meeting' : '') },
    p.img ? el('img', { src: p.img, alt: '' }) : p.meet ? icon('group', 20) : el('span', { text: initials(p.name) }));
  pic.style.setProperty('--hue', hueOf(C.toHex(C.unb64url(inv.rid)).slice(-6)));
  const n = p.members;
  const count = n === null ? null : p.meet
    ? n + ' TEILNEHMER'
    : n + (n === 1 ? ' MITGLIED' : ' MITGLIEDER');
  return el('div', { class: 'sc-inv-card' + (cls ? ' ' + cls : '') }, pic,
    el('span', { class: 'sc-rm-id' },
      el('span', { class: 'sc-inv-label', text: p.meet ? 'DU WIRST EINGELADEN ZUM MEETING' : 'DU WIRST EINGELADEN IN' }),
      el('span', { class: 'sc-inv-name', text: p.name, title: p.name }),
      count || ao ? el('span', { class: 'sc-inv-facts' },
        count ? el('span', { text: count }) : null,
        ao ? el('span', { class: 'sc-side-tag sc-side-tag--ao', title: AO_NOTE }, icon('users', 11), 'NUR KONTEN') : null) : null));
}

/**
 * Platz für die Karte: leer, bis die Vorschau da ist (aus dem Zwischenspeicher
 * sofort). Ohne Vorschau bleibt er leer. onInfo bekommt das Ergebnis mit.
 */
function invitePreviewSlot(inv, cls, onInfo) {
  const slot = el('div', { class: 'sc-inv-slot', hidden: true });
  inviteInfo(inv).then((info) => {
    if (info.preview) {
      slot.appendChild(invitePreviewCard(inv, info.preview, info.ao, cls));
      slot.hidden = false;
    }
    if (onInfo) onInfo(info, slot);
  });
  return slot;
}

/**
 * Temporäre Sitzung mit einem Link zu einem Raum nur für Konten: Sitzung
 * beenden und zur Kontoerstellung – die Einladung bleibt (sessionStorage)
 * und wird nach Registrierung oder Anmeldung eingelöst (offerPendingJoin).
 */
function accountOnlyDialog(inv) {
  openModal({
    title: 'NUR MIT KONTO',
    build: (body) => appendAll(body,
      invitePreviewSlot(inv),
      el('p', { class: 'sc-p', text: 'Diesem Raum treten nur Mitglieder mit Konto bei – mit einer temporären Sitzung geht es nicht.' }),
      el('p', { class: 'sc-note', text: '„Konto erstellen“ beendet deine temporäre Sitzung: Der Server löscht sie samt Unterhaltungen und Raummitgliedschaften. Danach erstellst du ein Konto – oder meldest dich an, wenn du schon eins hast. Die Einladung bleibt erhalten und wird gleich danach eingelöst.' })),
    actions: [
      { label: 'Abbrechen', onClick: (close) => close() },
      { label: 'Konto erstellen', primary: true, onClick: (close) => { close(); switchToAccount(inv); } }
    ]
  });
}

async function switchToAccount(inv) {
  ssSet(JOIN_KEY, { rid: inv.rid, code: inv.code, key: inv.key, epoch: inv.epoch, meet: false, once: false, ao: true });
  await clearPresence();
  try { await api('end'); } catch (e) { /* trotzdem lokal beenden */ }
  teardownMedia();
  await clearStoredSession();
  location.reload();
}

/** Raum-Menü: „Nur Mitglieder mit Konto“ an- oder ausschalten (nur der Besitzer). */
async function roomAccountsDialog(room) {
  const on = !room.ao;
  const ok = await confirmBox('NUR MITGLIEDER MIT KONTO', on
    ? 'Neue Mitglieder brauchen dann ein Konto: Wer einen Einladungslink ohne Konto öffnet, wird zur Kontoerstellung geführt, temporäre Sitzungen können nicht beitreten. Wer schon im Raum ist, bleibt – auch mit temporärer Sitzung.'
    : 'Dann können auch temporäre Sitzungen mit einem Einladungslink beitreten.', on ? 'Einschalten' : 'Ausschalten');
  if (!ok) return;
  try {
    await api('room.ao', { id: room.id, on: on ? 1 : 0 });
    await loadRooms();
    toast(on ? 'Nur noch Mitglieder mit Konto können beitreten.' : 'Auch temporäre Sitzungen können wieder beitreten.', 'ok');
  } catch (e) {
    toast(e.message, 'error');
  }
}

/* ---------- Meetings ------------------------------------------------------------
   Ein Meeting ist ein Raum mit Merkmal „meet“ und „once“ (beim Server „ot“):
   Wer den Link #once=… öffnet, kommt in den Meeting-Raum mit Chat – ohne
   Sitzung braucht er nur einen Namen (Gast, kein Konto). Einen Call startet
   dort, wer will (Sprachkanal: Ton, Kamera und Bildschirm wie bei einem
   Anruf, bis zu cfg.limits.voice Personen). Das Meeting endet, wenn der
   Besitzer es beendet oder es onceHours() ruht.
   Ältere Meetings ohne „once“ (früher „Festes Meeting“, Link #meet=…)
   funktionieren weiter: Teilnehmer kommen mit Konto oder temporärer
   Sitzung, das Meeting bleibt bestehen. Neu angelegt werden sie nicht mehr. */
function onceHours() {
  const h = S.cfg && Number(S.cfg.once_hours);
  return h > 0 ? h : 12;
}

function isOnceMeeting(room) {
  return !!(room && room.meta && room.meta.meet && (room.ot || room.meta.once));
}

/** Wann verschwindet das Meeting? (für Hinweise) */
function meetingExpiryNote(room) {
  if (isOnceMeeting(room)) {
    return 'Das Meeting endet, wenn der Besitzer es beendet – oder nach ' + onceHours() + ' Stunden ohne Aktivität. Dann löscht der Server es samt Chat.';
  }
  return room.tmp ? 'Ruht das Meeting ' + tempRoomDays() + ' Tage, löscht der Server es samt Chat.' : '';
}

/** Knopf „MEET“: erst kurz nachfragen (ein Klick aus Versehen legte sonst gleich ein Meeting an). */
function confirmMeeting() {
  if (inMeetingMode() || meetStarting) return;
  openModal({
    title: 'MEETING',
    build: (body) => body.appendChild(el('p', { class: 'sc-p', text: 'Ein neues Meeting erstellen? Du bekommst einen Link, über den andere beitreten.' })),
    actions: [
      { label: 'Abbrechen', onClick: (close) => close() },
      // Fokus liegt auf dem primären Knopf: Enter bestätigt.
      { label: 'Meeting erstellen', primary: true, onClick: (close) => { close(); startMeeting(); } }
    ]
  });
}

/** Meeting anlegen und den Link zeigen. */
let meetStarting = false;
async function startMeeting() {
  if (inMeetingMode() || meetStarting) return;
  if (S.call || S.voice) { toast(S.call ? 'Beende zuerst den Anruf.' : 'Verlasse zuerst den Sprachkanal.', 'error'); return; }
  meetStarting = true;
  const btn = $('sc-add-meet');
  if (btn) btn.classList.add('is-busy');
  try {
    const rid = await createMeeting();
    meetingDialog(S.rooms.get(rid));
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    meetStarting = false;
    if (btn) btn.classList.remove('is-busy');
  }
}

function meetingName() {
  const d = new Date();
  return 'Meeting ' + String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0') + '. ' +
    String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

async function createMeeting() {
  return createRoom(meetingName(), { meet: true, once: true });
}

function isMeetingView() {
  if (S.view.kind !== 'room') return false;
  const room = S.rooms.get(S.view.rid);
  return !!(room && room.meta.meet);
}

/** Call im Meeting: starten, beitreten oder verlassen – als Symbol (Kopfzeile) oder großer Knopf. */
function meetingCallButton(room, kind) {
  const inCall = !!(S.voice && S.voice.rid === room.id);
  const n = room.vc.length;
  const label = inCall ? 'Call verlassen' : n ? 'Call beitreten' : 'Call starten';
  const act = () => (inCall ? leaveVoice() : joinVoice(room.id));
  if (kind === 'icon') {
    return iconBtn(inCall ? 'leave' : 'phone', label + (n && !inCall ? ' (' + n + ' drin)' : ''), act,
      { class: 'sc-ibtn' + (n && !inCall ? ' is-live' : '') });
  }
  return el('button', { type: 'button', class: 'btn btn--block ' + (inCall ? 'sc-btn--danger' : 'btn--primary'), onclick: act },
    icon(inCall ? 'leave' : 'phone', 15), label + (n && !inCall ? ' · ' + n + ' drin' : ''));
}

async function copyMeetingLink(room) {
  try {
    copyText(await meetingLink(room), 'Meeting-Link');
    if (linkNeedsApproval(room)) toast('Wer über deinen Link kommt, wartet, bis der Gastgeber den Beitritt bestätigt.', 'ok', 6000);
  } catch (e) { toast(e.message, 'error'); }
}

/** Gäste teilen nur Links zu ihrem Einmal-Meeting (der Server prüft es). */
function canShareLink(room) {
  return !S.guest || !!(room && room.ot);
}

/**
 * Beitritt mit Bestätigung: In Einmal-Meetings führen nur Links des
 * Gastgebers (Besitzers) direkt hinein. Wer über den Link eines anderen
 * Teilnehmers – etwa eines Gasts – kommt, wartet, bis der Gastgeber zulässt.
 */
function linkNeedsApproval(room) {
  return !!(room && room.ot && room.owner !== S.me.id);
}

/* ---------- Beitrittsanfragen ----------------------------------------------
   Kommt jemand über den Link eines anderen Teilnehmers (etwa eines Gasts),
   tritt er nicht gleich bei: Der Server merkt die Anfrage vor, und der
   Gastgeber bekommt oben rechts ein Kärtchen je Anfrage (Zulassen /
   Ablehnen) – zusätzlich steht sie in der Meeting-Karte unter WARTET.
   Unbeantwortet verfällt sie nach zehn Minuten. Wer wartet, fragt per
   Abruf (poll mit "w") alle drei Sekunden nach. */
const KNOCK = { shown: new Map(), closed: new Set(), busy: new Set(), box: null };

function knockKey(rid, id) { return rid + ':' + id; }

/** Offene Anfragen eines Raums, die noch gelten (nur für den Besitzer). */
function liveKnocks(room) {
  if (!room || !S.me || room.owner !== S.me.id || !Array.isArray(room.knocks)) return [];
  const now = serverNow();
  return room.knocks.filter((k) => Number(k.x) * 1000 > now);
}

function syncKnocks() {
  const want = new Map();
  if (S.me) for (const room of S.rooms.values()) for (const k of liveKnocks(room)) want.set(knockKey(room.id, k.id), { room: room, k: k });
  let gone = false;
  // Entschieden, verfallen oder zurückgezogen: Kärtchen weg.
  for (const [key, box] of KNOCK.shown) if (!want.has(key)) { box.remove(); KNOCK.shown.delete(key); gone = true; }
  for (const key of [...KNOCK.closed]) if (!want.has(key)) { KNOCK.closed.delete(key); gone = true; }
  let first = null;
  for (const [key, v] of want) {
    if (KNOCK.shown.has(key) || KNOCK.closed.has(key)) continue;
    KNOCK.shown.set(key, knockCard(v.room, v.k, key));
    if (!first) first = v;
  }
  if (first) {
    if (S.vault && S.vault.settings && S.vault.settings.sound) { beep(660, 0.12, 0, 0.06); beep(880, 0.16, 0.14, 0.06); }
    notify('Beitrittsanfrage', displayName(S.ids.get(first.k.id)) + ' möchte dem Meeting beitreten.', 'knock');
  }
  if (gone) scheduleRender();
}

function knockBox() {
  if (!KNOCK.box || !KNOCK.box.isConnected) {
    KNOCK.box = el('div', { class: 'sc-knocks', id: 'sc-knocks', 'aria-live': 'polite' });
    document.body.appendChild(KNOCK.box);
  }
  return KNOCK.box;
}

function knockCard(room, k, key) {
  const ident = S.ids.get(k.id);
  const where = room.meta.meet ? 'dem Meeting' + (inMeetingMode() ? '' : ' „' + room.meta.name + '“') : 'dem Raum „' + room.meta.name + '“';
  const close = () => { KNOCK.closed.add(key); box.remove(); KNOCK.shown.delete(key); };
  const yes = el('button', { type: 'button', class: 'btn btn--primary', onclick: () => decideKnock(room.id, k.id, true, box) }, icon('check', 14), 'Zulassen');
  const no = el('button', { type: 'button', class: 'btn', onclick: () => decideKnock(room.id, k.id, false, box) }, icon('x', 14), 'Ablehnen');
  const box = el('div', { class: 'sc-knock', role: 'alertdialog', 'aria-label': 'Beitrittsanfrage' },
    el('div', { class: 'sc-knock-head' },
      avatar(ident, 'sm'),
      el('span', { class: 'sc-knock-text' },
        el('strong', { text: ident ? displayName(ident) : 'Jemand' }),
        el('span', { text: ' möchte ' + where + ' beitreten.' })),
      iconBtn('x', 'Später entscheiden (steht weiter in der Meeting-Karte unter WARTET)', close)),
    el('p', { class: 'sc-knock-note', text: (ident && ident.guest ? 'Gast ohne Konto' : ident && ident.kind === 'account' ? 'Konto' : 'Temporäre Sitzung') +
      (ident ? ' · Fingerabdruck ' + fpTail(ident.fp) : '') + ' · kommt über den Link eines Teilnehmers' }),
    el('div', { class: 'sc-knock-acts' }, no, yes));
  knockBox().appendChild(box);
  return box;
}

/** Gastgeber: Anfrage zulassen oder ablehnen (beim Server: room.kick mit "pend"). */
async function decideKnock(rid, id, yes, box) {
  const key = knockKey(rid, id);
  if (KNOCK.busy.has(key)) return;
  KNOCK.busy.add(key);
  if (box) box.classList.add('is-busy');
  const ident = S.ids.get(id);
  try {
    await api('room.kick', { id: rid, member: id, pend: yes ? 'yes' : 'no' });
    toast(yes ? displayName(ident) + ' ist jetzt im Meeting.' : 'Beitritt von ' + displayName(ident) + ' abgelehnt.', 'ok');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    KNOCK.busy.delete(key);
    if (box) box.classList.remove('is-busy');
  }
  await loadRooms().catch(() => {});
}

/** Warteliste in der Meeting-Karte (nur für den Gastgeber). */
function knockList(room) {
  const knocks = liveKnocks(room);
  if (!knocks.length) return null;
  const list = el('div', { class: 'sc-list sc-knock-list' });
  for (const k of knocks) {
    const ident = S.ids.get(k.id);
    list.appendChild(el('div', { class: 'sc-meet-person is-waiting' },
      avatar(ident, 'xs'),
      el('span', { class: 'sc-meet-person-name', text: ident ? displayName(ident) : 'Unbekannt' }),
      ident && ident.guest ? kindBadge(ident) : null,
      iconBtn('x', 'Ablehnen', () => decideKnock(room.id, k.id, false), { class: 'sc-ibtn sc-knock-no' }),
      iconBtn('check', 'Zulassen', () => decideKnock(room.id, k.id, true), { class: 'sc-ibtn sc-knock-yes' })));
  }
  const frag = document.createDocumentFragment();
  frag.append(sectionHead('WARTET – ' + knocks.length), list);
  return frag;
}

/**
 * Wer wartet: alle drei Sekunden nachfragen. Ergebnis 'in' (zugelassen),
 * 'no' (abgelehnt), 'gone' (verfallen, Meeting oder Sitzung weg) oder
 * 'cancel' (selbst abgebrochen, stopWaiting()).
 */
const WAIT = { cur: null };
async function waitForHost(rid) {
  const token = {};
  WAIT.cur = token;
  while (WAIT.cur === token && S.token) {
    try {
      const r = await api('poll', { w: rid, i: S.cursor || { s: 0, o: 0, g: 0 }, r: {} });
      if (WAIT.cur !== token) break;
      if (r.w && r.w !== 'wait') { WAIT.cur = null; return r.w; }
    } catch (e) {
      if (e.status === 401) { if (WAIT.cur === token) WAIT.cur = null; return 'gone'; }
    }
    await sleep(3000);
  }
  return 'cancel';
}

function stopWaiting() { WAIT.cur = null; }

/** Gast wartet auf den Gastgeber (statt der Meeting-Ansicht). */
function showGuestWait() {
  const card = guestCard();
  card.append(
    el('span', { class: 'sc-guest-emblem is-waiting' }, icon('group', 30)),
    el('h1', { class: 'sc-gate-title sc-guest-title is-long', text: 'Warte auf den Gastgeber …' }),
    el('p', { class: 'sc-gate-sub', text: 'Der Gastgeber muss deinen Beitritt bestätigen.' }),
    el('div', { class: 'sc-wait-spin', role: 'progressbar', 'aria-label': 'Warte auf den Gastgeber' }),
    el('p', { class: 'sc-gate-note', text: 'Du bist über den Link eines anderen Teilnehmers gekommen. Sobald der Gastgeber zustimmt, bist du im Meeting. Ohne Antwort verfällt die Anfrage nach zehn Minuten.' }),
    el('button', { type: 'button', class: 'btn btn--block sc-guest-more', onclick: () => { stopWaiting(); guestEnded('cancelled'); } }, 'Abbrechen'));
  bootDone();
  waitForHost(S.meetRid).then(async (st) => {
    if (st === 'in') {
      S.guestWait = false;
      const ss = ssGet(SS_KEY);
      if (ss) { delete ss.wait; ssSet(SS_KEY, ss); }
      await enterApp();
      toast('Der Gastgeber hat dich hereingelassen.', 'ok');
    } else if (st === 'no') {
      guestEnded('denied');
    } else if (st === 'gone') {
      guestEnded('noanswer');
    }
  });
}

/** Mit Sitzung oder Konto: Warten im Dialog – schließen geht, die Anfrage bleibt. */
function waitDialog(inv) {
  let settled = false;
  const drop = () => { if (!S.rooms.has(inv.rid) && S.vault.rooms[inv.rid]) { delete S.vault.rooms[inv.rid]; saveVault(); } };
  const closeWait = openModal({
    title: 'MEETING',
    build: (body) => body.append(el('div', { class: 'sc-wait' },
      el('div', { class: 'sc-wait-spin', role: 'progressbar', 'aria-label': 'Warte auf den Gastgeber' }),
      el('p', { class: 'sc-wait-title', text: 'Warte auf den Gastgeber …' }),
      el('p', { class: 'sc-p', text: 'Der Gastgeber muss deinen Beitritt bestätigen. Du kannst dieses Fenster schließen – sobald er zustimmt, öffnet sich das Meeting.' }))),
    actions: [{ label: 'Anfrage zurückziehen', danger: true, onClick: async (close) => {
      settled = true;
      stopWaiting();
      close();
      try { await api('room.leave', { id: inv.rid }); } catch (e) { /* verfällt von selbst */ }
      drop();
      toast('Beitrittsanfrage zurückgezogen.', 'ok');
    } }]
  });
  waitForHost(inv.rid).then(async (st) => {
    if (settled || st === 'cancel') return;
    settled = true;
    const current = modalClose === closeWait;
    if (st === 'in') {
      if (current) closeWait();
      await loadRooms().catch(() => {});
      if (S.rooms.has(inv.rid)) openRoom(inv.rid);
      toast('Der Gastgeber hat dich hereingelassen.', 'ok');
      return;
    }
    drop();
    const msg = st === 'no' ? 'Der Gastgeber hat deinen Beitritt abgelehnt.' : 'Keine Antwort vom Gastgeber – versuche es später noch einmal.';
    if (current) {
      openModal({ title: 'MEETING', build: (body) => body.append(el('p', { class: 'sc-p', text: msg })),
        actions: [{ label: 'OK', primary: true, onClick: (close) => close() }] });
    } else {
      toast(msg, 'error', 9000);
    }
  });
}

function renderMeetingSide(head, body, room) {
  const once = isOnceMeeting(room);
  const owner = room.owner === S.me.id;
  appendAll(head, el('span', { class: 'sc-side-title sc-meet-title' }, icon('group', 16), 'Meeting'),
    S.guest ? null : iconBtn('more', 'Meeting-Menü', () => roomMenu(room)));
  const inCall = !!(S.voice && S.voice.rid === room.id);
  const n = room.vc.length;
  const card = el('div', { class: 'sc-meet-card tickbox' + (n ? ' is-live' : '') });
  appendAll(card,
    el('span', { class: 'sc-meet-emblem' }, icon('group', 26)),
    el('span', { class: 'sc-meet-name', text: room.meta.name }),
    el('span', { class: 'sc-meet-state', text: inCall ? 'Du bist im Call' : n ? 'Call läuft · ' + n + (n === 1 ? ' Person' : ' Personen') : 'Noch kein Call' }),
    meetingCallButton(room),
    // Gäste teilen einen eigenen Link – wer damit kommt, lässt der Gastgeber erst zu.
    canShareLink(room) ? el('button', { type: 'button', class: 'btn btn--block', onclick: () => copyMeetingLink(room) }, icon('link', 14), 'Link kopieren') : null,
    // Meeting-Modus (Gast oder Gastgeber von der Startseite): Verlassen beendet die Sitzung.
    inMeetingMode() ? el('button', { type: 'button', class: 'btn btn--block', onclick: guestLeave }, icon('leave', 14), 'Meeting verlassen') : null,
    once && owner ? el('button', { type: 'button', class: 'btn btn--block sc-btn--danger', onclick: () => deleteRoom(room) }, icon('x', 14), 'Meeting beenden') : null);
  body.appendChild(card);

  const ids = room.members.map((m) => m.id);
  ids.sort((a, b) => (room.vc.includes(b) ? 1 : 0) - (room.vc.includes(a) ? 1 : 0));
  body.appendChild(sectionHead('TEILNEHMER – ' + ids.length));
  const list = el('div', { class: 'sc-list' });
  for (const id of ids) {
    const ident = S.ids.get(id);
    const live = room.vc.includes(id);
    list.appendChild(el('div', { class: 'sc-meet-person' + (live ? ' is-live' : '') },
      avatar(ident, 'xs'),
      el('span', { class: 'sc-meet-person-name', text: displayName(ident) + (id === S.me.id ? ' (du)' : '') }),
      ident && ident.guest ? kindBadge(ident) : null,
      id === room.owner ? el('span', { class: 'sc-owner', title: 'Startet und beendet das Meeting' }, icon('crown', 12)) : null,
      live ? el('span', { class: 'sc-meet-badge', text: 'IM CALL' }) : null));
  }
  body.appendChild(list);
  const waiting = knockList(room);
  if (waiting) body.appendChild(waiting);
  if (S.guest) body.appendChild(el('p', { class: 'sc-empty-note', text: 'Du bist als Gast hier – ohne Konto, nur in diesem Meeting. Verlässt du es, endet deine Gast-Sitzung.' }));
  else if (S.meetOnly) body.appendChild(el('p', { class: 'sc-empty-note', text: 'Du bist mit einer temporären Sitzung nur in diesem Meeting. Verlässt oder beendest du es, endet auch die Sitzung.' }));
  const note = meetingExpiryNote(room);
  if (note) body.appendChild(el('p', { class: 'sc-empty-note', text: note }));
}

/** Lobby über dem Chat: ob ein Call läuft, wer drin ist – und ein großer Knopf. */
function renderMeetingLobby() {
  let lobby = $('sc-meet-lobby');
  const room = isMeetingView() ? S.rooms.get(S.view.rid) : null;
  const inCall = !!(room && S.voice && S.voice.rid === room.id);
  if (!room || inCall) { if (lobby) lobby.remove(); return; }
  if (!lobby) {
    lobby = el('div', { class: 'sc-meet-lobby', id: 'sc-meet-lobby' });
    $('sc-main').insertBefore(lobby, $('sc-stage'));
  }
  lobby.textContent = '';
  const n = room.vc.length;
  const faces = el('span', { class: 'sc-meet-faces' });
  for (const id of room.vc.slice(0, 5)) faces.appendChild(avatar(S.ids.get(id), 'sm'));
  const names = room.vc.slice(0, 3).map((id) => displayName(S.ids.get(id))).join(', ') + (n > 3 ? ' und ' + (n - 3) + ' weitere' : '');
  lobby.classList.toggle('is-live', n > 0);
  appendAll(lobby,
    el('span', { class: 'sc-meet-lobby-emblem' }, icon('group', 30)),
    el('span', { class: 'sc-meet-lobby-text' },
      el('span', { class: 'sc-meet-lobby-title', text: n ? 'Call läuft' : 'Noch kein Call' }),
      el('span', { class: 'sc-meet-lobby-sub', text: n ? names + (n === 1 ? ' ist drin.' : ' sind drin.') : 'Schreibt hier im Chat – oder startet einen Call mit Ton, Kamera und Bildschirm. Alle im Meeting sehen es sofort.' })),
    n ? faces : null,
    appendAll(el('span', { class: 'sc-meet-lobby-acts' }), meetingCallButton(room),
      canShareLink(room) ? el('button', { type: 'button', class: 'btn', onclick: () => copyMeetingLink(room) }, icon('link', 14), 'Link kopieren') : null));
}

/** Neuer Link (Einladung für bis zu 100 Beitritte): 1 Tag, ältere feste Meetings 7 Tage. */
async function meetingLink(room) {
  const once = isOnceMeeting(room);
  const r = await api('room.invite', { id: room.id, max: 100, days: once ? 1 : 7 });
  const raw = roomKeyRaw(room.id, r.epoch);
  if (!raw) throw new Error('Der aktuelle Raumschlüssel fehlt noch.');
  return WEB_URL + (once ? '#once=' : '#meet=') + room.id + '.' + r.code + '.' + raw + '.' + r.epoch;
}

function meetingDialog(room) {
  if (!room || !canShareLink(room)) return;
  const once = isOnceMeeting(room);
  const approve = linkNeedsApproval(room);
  openModal({
    title: 'MEETING',
    build: (body) => {
      const out = el('div', { class: 'sc-invite-out' }, el('p', { class: 'sc-note', text: 'Link wird erstellt …' }));
      const max = (S.cfg && S.cfg.limits && S.cfg.limits.voice) || 8;
      const keyNote = 'den Schlüssel enthält nur der Teil hinter „#“ – er geht nie an den Server.';
      body.append(
        el('p', { class: 'sc-p', text: approve
          ? 'Teile diesen Link. Wer ihn öffnet, gibt nur einen Namen ein – und wartet dann, bis der Gastgeber den Beitritt bestätigt. Gäste sehen nur dieses Meeting: Chat, Teilnehmer und Call. Alles ist Ende-zu-Ende verschlüsselt.'
          : once
          ? 'Teile diesen Link. Wer ihn öffnet, gibt nur einen Namen ein und ist im Meeting – ohne Konto, ohne Anmeldung. Gäste sehen nur dieses Meeting: Chat, Teilnehmer und Call. Alles ist Ende-zu-Ende verschlüsselt.'
          : 'Teile diesen Link. Wer ihn öffnet, ist mit einem Klick im Meeting-Raum – auch ohne Konto, mit einer temporären Sitzung. Dort könnt ihr schreiben; einen Call startet ihr oben mit dem Hörer. Alles ist Ende-zu-Ende verschlüsselt.' }),
        out,
        el('p', { class: 'sc-note', text: once
          ? 'Im Call bis zu ' + max + ' Personen gleichzeitig, im Meeting bis zu 50. Der Link gilt 24 Stunden für bis zu 100 Beitritte; ' + keyNote +
            (approve ? ' Der Gastgeber muss jeden Beitritt über deinen Link bestätigen.'
              : ' Das Meeting endet, wenn du es beendest (Knopf „Meeting beenden“) oder es ' + onceHours() + ' Stunden ruht.')
          : 'Im Call bis zu ' + max + ' Personen gleichzeitig, im Raum bis zu 50. Der Link gilt 7 Tage für bis zu 100 Beitritte; ' + keyNote +
            (room.tmp ? ' Ruht das Meeting ' + tempRoomDays() + ' Tage, wird es gelöscht.' : '') }));
      meetingLink(room).then((link) => {
        const input = el('input', { type: 'text', readonly: true, value: link });
        out.textContent = '';
        out.append(input, el('button', { type: 'button', class: 'btn btn--primary', onclick: () => copyText(link, 'Meeting-Link') }, icon('copy', 14), 'Link kopieren'));
        input.select();
      }).catch((e) => { out.textContent = ''; out.append(el('p', { class: 'sc-note sc-update-error', text: e.message })); });
    }
  });
}

async function joinRoom(inv) {
  try {
    storeRoomKey(inv.rid, inv.epoch, inv.key);
    await saveVault(true);
    const res = await api('room.join', { id: inv.rid, code: inv.code });
    if (res.room && res.room.pending) { waitDialog(inv); return; }
    await loadRooms();
    openRoom(inv.rid);
    toast('Du bist dem Raum beigetreten.', 'ok');
  } catch (e) {
    if (!S.rooms.has(inv.rid)) { delete S.vault.rooms[inv.rid]; saveVault(); }
    // Raum nur für Konten (alter Link oder Merkmal erst später gesetzt): zur Kontoerstellung anbieten.
    if (e.data && e.data.account && S.mode === 'temp' && !inMeetingMode()) { accountOnlyDialog(inv); return; }
    toast(e.message, 'error');
  }
}

/**
 * Raum-Menü: oben eine Karte (Bild, Name, Merkmale, Mitglieder, Besitzer,
 * Schlüsselgeneration), darunter Gruppen mit Abschnittsköpfen wie in den
 * Einstellungen, ganz unten abgesetzt Verlassen und Löschen. Nicht-Besitzer
 * sehen nur, was sie dürfen.
 */
function roomMenu(room) {
  if (S.guest) return;   // Gäste: nur Call und „Meeting verlassen“ in der Meeting-Karte
  const owner = room.owner === S.me.id;
  const meet = !!room.meta.meet;
  const once = isOnceMeeting(room);
  openModal({
    title: meet ? 'MEETING' : 'RAUM',
    build: (body, close) => {
      const run = (fn) => () => { close(); fn(); };
      // Kachel (Paare nebeneinander) und Zeile (mit Wert rechts oder Schalter)
      const tile = (ic, label, fn, cls) => el('button', { type: 'button', class: 'sc-rm-tile' + (cls ? ' ' + cls : ''), onclick: run(fn) },
        icon(ic, 16), el('span', { text: label }));
      const row = (ic, label, fn, value, note) => el('button', { type: 'button', class: 'sc-menu-item sc-rm-row', onclick: run(fn) },
        icon(ic, 16),
        el('span', { class: 'sc-rm-text' }, el('span', { text: label }), note ? el('span', { class: 'sc-rm-note', text: note }) : null),
        value ? el('span', { class: 'sc-rm-val', text: value }) : null);
      const toggle = (ic, label, on, fn, note) => {
        const b = row(ic, label, fn, null, note);
        b.setAttribute('role', 'switch');
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        b.appendChild(el('span', { class: 'sc-rm-switch' }, el('span', { class: 'sc-rm-switch-text', text: on ? 'AN' : 'AUS' }), el('span', { class: 'sc-rm-knob' })));
        return b;
      };
      const pair = (a, b) => el('div', { class: 'sc-rm-pair' }, a, b);

      // Karte
      const n = room.members.length;
      const pic = el('span', { class: 'sc-rm-pic' + (meet ? ' is-meeting' : '') },
        room.meta.img ? el('img', { src: room.meta.img, alt: '' }) : meet ? icon('group', 20) : el('span', { text: initials(room.meta.name) }));
      pic.style.setProperty('--hue', hueOf(C.toHex(C.unb64url(room.id)).slice(-6)));
      const expiry = meet ? meetingExpiryNote(room) : room.tmp ? tempRoomNote(room) : '';
      const card = el('div', { class: 'sc-rm-card' }, pic,
        el('span', { class: 'sc-rm-id' },
          el('span', { class: 'sc-rm-name', text: room.meta.name, title: room.meta.name }),
          room.tmp || room.ao ? el('span', { class: 'sc-side-tags' },
            room.ao ? el('span', { class: 'sc-side-tag sc-side-tag--ao', title: AO_NOTE }, icon('users', 11), 'NUR KONTEN') : null,
            room.tmp ? el('span', { class: 'sc-side-tag', title: tempRoomNote(room) }, icon('clock', 11), 'TEMP') : null) : null,
          el('span', { class: 'sc-rm-facts' },
            el('span', { text: n + (n === 1 ? ' MITGLIED' : ' MITGLIEDER') }),
            el('span', { text: 'BESITZER: ' + displayName(S.ids.get(room.owner)) + (owner ? ' (DU)' : '') }),
            el('span', { text: 'SCHLÜSSEL GEN. ' + room.epoch }))));

      const inVoice = S.voice && S.voice.rid === room.id;
      const aq = AUDIO_QUALITY.find((q) => q.id === room.meta.aq);
      // Nur Mitglieder mit Konto: nicht für Meetings und verfallende Räume; einschalten nur als Konto.
      const aoOk = owner && !meet && !room.tmp && (room.ao || S.mode === 'account');
      // Was ich verwalten darf: Besitzer alles, sonst nach Rang (Schlüssel bleiben beim Besitzer)
      const mRoom = can(room, RIGHT.ROOM);
      const mChan = can(room, RIGHT.CHANNELS);
      const mRoles = rolesOk(room) && can(room, RIGHT.ROLES);
      const nRoles = Object.keys(room.rl).length;
      const settings = mRoom || aoOk || hooksOk(room) || mRoles;
      const invite = meet || canInvite(room);
      const voiceOk = inVoice || canEnterVoice(room, S.me.id, '');
      const myRoles = rolesOk(room) && !owner ? memberRoles(room, S.me.id) : [];
      appendAll(body, el('div', { class: 'sc-rm' },
        card,
        myRoles.length ? el('p', { class: 'sc-rm-hint sc-rm-myroles' }, 'DEIN RANG', ...myRoles.slice(0, 3).map((rid) => el('span', { class: 'sc-role-badge', style: '--role:' + roleColor(room, rid) }, el('span', { class: 'sc-role-dot' }), roleName(room, rid)))) : null,
        expiry ? el('p', { class: 'sc-rm-hint', text: expiry }) : null,
        sectionHead(meet ? 'TEILNEHMER & CALL' : 'MITGLIEDER & SPRACHE'),
        invite ? null : el('p', { class: 'sc-rm-hint sc-invite-note' }, icon('userPlus', 13), INVITE_NOTE),
        invite || voiceOk ? pair(invite ? (meet ? tile('link', 'Meeting-Link teilen', () => meetingDialog(room), 'is-accent') : tile('userPlus', 'Einladen', () => inviteDialog(room), 'is-accent')) : null,
          inVoice ? tile('leave', 'Sprachkanal verlassen', () => leaveVoice()) : voiceOk ? tile(meet ? 'phone' : 'speaker', meet ? 'Call beitreten' : 'Sprachkanal betreten', () => joinVoice(room.id)) : null) : null,
        mChan ? sectionHead('KANÄLE') : null,
        mChan ? pair(tile('hash', 'Textkanal anlegen', () => addChannel(room)), tile('speaker', 'Sprachkanal anlegen', () => addVoiceChannel(room))) : null,
        settings ? sectionHead('EINSTELLUNGEN') : null,
        settings ? el('div', { class: 'sc-rm-rows' },
          mRoom ? row('edit', 'Raum umbenennen', () => renameRoom(room)) : null,
          mRoom ? row('image', room.meta.img ? 'Raumbild ändern' : 'Raumbild festlegen', () => roomPicture(room), room.meta.img ? 'GESETZT' : 'KEINS') : null,
          mRoom ? row('clock', 'Nachrichten aufbewahren', () => roomTtlDialog(room), ttlLabel(roomTtl(room)).toUpperCase(), ownTtlSummary(room)) : null,
          mRoom ? row('sliders', 'Sprachqualität im Raum', () => roomAudioDialog(room), aq ? aq.name.toUpperCase() : 'JEDER NACH WAHL') : null,
          // Ränge: Rechte bündeln und vergeben (an Discord angelehnt)
          mRoles ? row('tag', 'Ränge', () => rolesDialog(room), nRoles ? String(nRoles) : 'KEINE', 'Wer was darf: Kanäle, Nachrichten, Mitglieder …') : null,
          aoOk ? toggle('users', 'Nur Mitglieder mit Konto', room.ao, () => roomAccountsDialog(room), 'Neue Mitglieder brauchen ein Konto.') : null,
          histOk(room) ? toggle('message', 'Neue Mitglieder sehen den Verlauf', histOn(room), () => roomHistoryDialog(room),
            !histOn(room) && room.meta.histLegacy ? 'Mit einer älteren App eingeschaltet – bitte neu einschalten.' : 'Ältere Nachrichten, soweit noch aufbewahrt.') : null,
          // API-Zugang: nur Konten, nicht für Meetings und verfallende Räume
          hooksOk(room) ? row('code', 'API-Zugang', () => hooksDialog(room), hookCount(room) ? hookCount(room) + ' / ' + HOOK_LIMIT : 'KEINER', 'Skripte posten in einen Kanal – nur posten.') : null) : null,
        owner ? sectionHead('SICHERHEIT') : null,
        owner ? el('div', { class: 'sc-rm-rows' },
          row('key', 'Raumschlüssel erneuern', () => rotateRoom(room.id, true), 'GEN. ' + room.epoch + ' → ' + (room.epoch + 1), 'Alte Einladungslinks werden ungültig.')) : null,
        el('div', { class: 'sc-rm-danger' + (owner ? '' : ' is-single') },
          tile('leave', meet ? 'Meeting verlassen' : 'Raum verlassen', () => leaveRoom(room), 'is-danger'),
          owner ? tile(once ? 'x' : 'trash', once ? 'Meeting beenden' : meet ? 'Meeting löschen' : 'Raum löschen', () => deleteRoom(room), 'is-danger') : null)));
    }
  });
}

/* ---------- API-Zugänge (Raum-Menü → EINSTELLUNGEN) --------------------------
   Ein Skript (oder Claude) postet damit in einen Textkanal – nur posten. Der
   Zugang besteht aus Server-Adresse, Raum, Kennung, Token und öffentlichem
   Schlüssel; angezeigt wird er genau einmal. Der Server kennt nur den Hash
   des Tokens, der private Schlüssel steht in den Raumdaten (alle Mitglieder
   lesen damit die Beiträge). Siehe securecom-core.js und
   tools/clavichat-post.mjs. */
const HOOK_LIMIT = 5;

function hooksOk(room) {
  return can(room, RIGHT.HOOKS) && S.mode === 'account' && !room.meta.meet && !room.tmp;
}

function hookCount(room) {
  return Object.keys(room.meta.hooks || {}).length;
}

function hookApiUrl() {
  try { return new URL(API_URL, location.href).href; } catch (e) { return API_URL; }
}

/**
 * fresh: { access, name, ch } direkt nach dem Anlegen – oder eine Liste
 * davon nach „Zugänge erneuern“. Ein Zugang erscheint nur dieses eine Mal.
 */
function hooksDialog(room, fresh) {
  const freshList = Array.isArray(fresh) ? fresh : fresh ? [fresh] : [];
  openModal({
    title: 'API-ZUGANG',
    build: (body, close) => {
      const chName = (id) => { const c = room.meta.ch.find((x) => x.id === id) || room.meta.ch[0]; return c ? c.name : ''; };
      appendAll(body, el('p', { class: 'sc-p', text: 'Skripte oder Claude posten über einen Zugang in einen Textkanal. Der Zugang kann nur posten: Er liest nichts, sieht keine Mitglieder und kennt den Raumschlüssel nicht. Beiträge sind Ende-zu-Ende verschlüsselt.' }));

      freshList.forEach((f, i) => {
        const input = el('textarea', { class: 'sc-hook-secret', rows: '6', readonly: true, spellcheck: 'false' });
        input.value = f.access;
        appendAll(body, el('div', { class: 'sc-hook-new tickbox' },
          el('p', { class: 'sc-hook-new-head' }, icon('check', 14), 'Zugang „' + f.name + '“ für #' + chName(f.ch) + (f.renewed ? ' erneuert' : ' angelegt')),
          input,
          el('div', { class: 'sc-card-actions' },
            el('button', { type: 'button', class: 'btn btn--primary', onclick: () => copyText(f.access, 'Zugang') }, icon('copy', 14), 'Kopieren')),
          i ? null : el('p', { class: 'sc-note', text: 'Wird nur jetzt angezeigt – danach nie wieder (nur widerrufen und neu anlegen). Wer ihn hat, kann in #' + chName(f.ch) + ' posten: Aufbewahren wie ein Passwort, nicht in Code oder Protokolle schreiben.' +
            (f.renewed ? ' Der bisherige Zugang postet nicht mehr – trage den neuen in deinen Skripten ein.' : '') }),
          i ? null : el('p', { class: 'sc-note', text: 'So nutzt du ihn: Zugang in die Umgebungsvariable CLAVICHAT_HOOK legen und mit dem Werkzeug aus dem Clavichat-Repository posten (Node 18 oder neuer, keine Installation):' }),
          i ? null : hookCodeLine('echo "Hallo" | CLAVICHAT_HOOK="<zugang>" node tools/clavichat-post.mjs')));
        if (!i) setTimeout(() => input.select(), 60);
      });
      // Seit dem Anlegen hat jemand den Raum verlassen: Er kennt die Leseschlüssel weiterhin.
      if (room.hookStale && hookCount(room) && !freshList.length) {
        appendAll(body, el('p', { class: 'sc-gate-invite sc-hook-stale' }, icon('alert', 15),
          'Seit dem Anlegen hat jemand den Raum verlassen oder wurde entfernt. Die Leseschlüssel der Zugänge kennt er weiterhin – „Zugänge erneuern“ gibt allen neue.'));
      }

      // Liste: Namen aus den Raumdaten, angelegt/zuletzt benutzt vom Server
      const list = el('div', { class: 'sc-hooks' }, el('p', { class: 'sc-empty-note', text: 'Lädt …' }));
      appendAll(body, sectionHead('ZUGÄNGE'), list);
      const drawList = (server) => {
        list.textContent = '';
        const seen = new Map((server || []).map((h) => [h.id, h]));
        const ids = [...new Set(Object.keys(room.meta.hooks || {}).concat([...seen.keys()]))];
        if (!ids.length) { list.appendChild(el('p', { class: 'sc-empty-note', text: 'Noch kein Zugang.' })); return; }
        for (const hid of ids) {
          const h = (room.meta.hooks || {})[hid];
          const sv = seen.get(hid);
          const gone = server && !sv;   // in den Raumdaten, beim Server schon widerrufen
          const sub = h ? ['#' + chName(h.ch), gone ? 'WIDERRUFEN' : sv && sv.u ? 'ZULETZT ' + fmtWhen(sv.u).toUpperCase() : 'NOCH NICHT BENUTZT'] : ['UNBEKANNT (FEHLT IN DEN RAUMDATEN)'];
          list.appendChild(el('div', { class: 'sc-hook-row' },
            icon('code', 16),
            el('span', { class: 'sc-hook-text' },
              el('span', { class: 'sc-hook-title' }, el('span', { text: h ? h.n : 'Zugang ' + hid.slice(0, 6) }), el('span', { class: 'sc-hook-tag', text: 'API' })),
              el('span', { class: 'sc-hook-sub', text: sub.join(' · ') })),
            iconBtn('trash', 'Widerrufen', () => revokeHook(room, hid, h ? h.n : ''))));
        }
      };
      api('hook.list', { id: room.id }).then((r) => drawList(r.list)).catch(() => drawList(null));

      // Neuer Zugang
      if (hookCount(room) < HOOK_LIMIT) {
        const name = el('input', { type: 'text', maxlength: '30', placeholder: 'z. B. Claude' });
        let ch = (room.meta.ch.find((c) => /news/i.test(c.name)) || room.meta.ch[0]).id;
        const pick = choice(room.meta.ch.map((c) => ({ id: c.id, name: '#' + c.name })), ch, (id) => { ch = id; });
        const go = el('button', { type: 'button', class: 'btn btn--primary btn--block' }, icon('plus', 14), 'Zugang anlegen');
        go.addEventListener('click', async () => {
          const n = cleanName(name.value).slice(0, 30);
          if (!n) { name.focus(); return; }
          go.disabled = true;
          try {
            const access = await createHook(room, n, ch);
            close();
            hooksDialog(S.rooms.get(room.id) || room, { access: access, name: n, ch: ch });
          } catch (e) { go.disabled = false; toast(e.message, 'error'); }
        });
        name.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go.click(); });
        appendAll(body, sectionHead('NEUER ZUGANG'), field('Name', name), field('Kanal', pick.el), go);
      } else {
        appendAll(body, el('p', { class: 'sc-note', text: 'Mehr als ' + HOOK_LIMIT + ' Zugänge je Raum gehen nicht – widerrufe einen, um einen neuen anzulegen.' }));
      }
      if (hookCount(room)) {
        appendAll(body, el('button', { type: 'button', class: 'btn btn--block sc-hook-renew', onclick: () => { close(); renewHooks(room); } },
          icon('refresh', 14), hookCount(room) === 1 ? 'Zugang erneuern' : 'Zugänge erneuern'));
      }
      appendAll(body, hookGuide(!hookCount(room) && !freshList.length),
        el('p', { class: 'sc-note sc-hook-foot', text: 'Den Leseschlüssel eines Zugangs kennen alle Mitglieder – auch ehemalige – und alle mit einem gültigen Einladungslink. Nach dem Entfernen von Mitgliedern: „Zugänge erneuern“ (neue Schlüssel und Tokens, die alten posten nicht mehr).' }));
    }
  });
}

/** README-Abschnitt „Beiträge per API (nur posten)“ (GitHub-Anker). */
const HOOK_DOCS_ANCHOR = '#beitr%C3%A4ge-per-api-nur-posten';

/** Befehlszeile mit Kopier-Knopf. */
function hookCodeLine(code) {
  return el('div', { class: 'sc-hook-code' },
    el('code', { text: code }),
    iconBtn('copy', 'Befehl kopieren', () => copyText(code, 'Befehl')));
}

/**
 * Anleitung im Dialog „API-Zugang“: aufklappbar, offen solange es noch
 * keinen Zugang gibt. Grenzen wie beim Server (MAX_HOOKS, MAX_HOOK,
 * hook.post in api.php: 20 je Minute, 300 je Stunde).
 */
function hookGuide(open) {
  const step = (n, title, ...rest) => el('li', { class: 'sc-hook-step' },
    el('span', { class: 'sc-hook-step-n', text: String(n) }),
    el('div', { class: 'sc-hook-step-body' }, el('span', { class: 'sc-hook-step-title', text: title }), ...rest));
  const text = (t) => el('p', { class: 'sc-hook-step-text', text: t });
  const det = el('details', { class: 'sc-hook-guide' },
    el('summary', { class: 'sc-hook-guide-head' },
      el('span', { class: 'sq' }), el('span', { class: 'label', text: 'SO FUNKTIONIERT’S' }), el('span', { class: 'rule' }), icon('chevron', 14)),
    el('ol', { class: 'sc-hook-steps' },
      step(1, 'Was ist ein API-Zugang?',
        text('Skripte oder Bots – etwa ein Server-Status oder ein KI-Assistent – posten damit in einen Kanal. Nur posten, nie lesen. Der Server sieht nur Chiffretext, die Beiträge tragen das Zeichen API.')),
      step(2, 'Anlegen',
        text('Unter NEUER ZUGANG Name und Kanal wählen. Der Zugang wird genau einmal angezeigt: kopieren und sicher aufbewahren – wer ihn hat, kann posten. Verloren? Hier widerrufen und neu anlegen.')),
      step(3, 'Posten',
        text('Mit dem Werkzeug tools/clavichat-post.mjs aus dem Clavichat-Repository – Node 18 oder neuer genügt, keine Installation:'),
        hookCodeLine('node tools/clavichat-post.mjs "<zugang>" "Wartung um 22 Uhr"'),
        text('Ohne Zugang in Befehlszeile und Shell-Verlauf – über die Umgebungsvariable, Text von stdin:'),
        hookCodeLine('echo "Backup fertig" | CLAVICHAT_HOOK="<zugang>" node tools/clavichat-post.mjs'),
        el('a', { class: 'sc-update-link', href: REPO_URL + HOOK_DOCS_ANCHOR, target: '_blank', rel: 'noopener noreferrer', text: 'Anleitung auf GitHub ↗' })),
      step(4, 'Grenzen',
        text('Höchstens ' + HOOK_LIMIT + ' Zugänge je Raum, je Zugang 20 Beiträge pro Minute und 300 pro Stunde, etwa 16 KB Text je Beitrag. Widerrufen geht jederzeit hier.'))));
  if (open) det.open = true;
  return det;
}

/** Zugang anlegen: erst beim Server (prüft Besitzer, Konto, Grenze), dann in die Raumdaten. Gibt den Zugang (Text) zurück. */
async function createHook(room, name, ch) {
  const keys = await C.newHookKeys();
  const token = C.newHookToken();
  const hid = C.randomId();
  // Kanal nur nennen, wenn er eine eigene Aufbewahrung hat (dann gilt sie auch für die Beiträge).
  await api('hook.create', Object.assign({ id: room.id, hid: hid, th: await C.hookTokenHash(token) }, chanParam(room, ch)));
  try {
    const hooks = Object.assign({}, room.meta.hooks || {});
    hooks[hid] = { n: name, ch: ch, k: keys.priv, c: Date.now() };
    await updateMeta(room, metaOf(room, { hooks: hooks }));
  } catch (e) {
    await api('hook.del', { id: room.id, hid: hid }).catch(() => {});   // ohne Leseschlüssel nutzlos: zurücknehmen
    throw e;
  }
  return C.hookAccess({ u: hookApiUrl(), r: room.id, h: hid, t: token, k: keys.pub });
}

/**
 * Alle Zugänge erneuern: je Zugang neues Schlüsselpaar und Token (gleicher
 * Name und Kanal), der alte wird beim Server widerrufen. Ehemalige
 * Mitglieder kennen die neuen Leseschlüssel nicht (sie bekommen die neuen
 * Raumdaten nicht mehr). Erst den alten widerrufen, dann neu anlegen – der
 * Server erlaubt höchstens fünf je Raum.
 */
async function renewHooks(room) {
  room = S.rooms.get(room.id) || room;
  const list = Object.entries(room.meta.hooks || {});
  if (!list.length) { hooksDialog(room); return; }
  const ok = await confirmBox(list.length === 1 ? 'ZUGANG ERNEUERN' : 'ZUGÄNGE ERNEUERN',
    (list.length === 1 ? 'Der Zugang bekommt' : 'Alle ' + list.length + ' Zugänge bekommen') + ' einen neuen Schlüssel und ein neues Token – der bisherige postet ab sofort nicht mehr. ' +
    'Ehemalige Mitglieder kennen die neuen Leseschlüssel nicht. Die neuen Zugänge erscheinen nur jetzt: danach in deinen Skripten eintragen. Bisherige Beiträge der Zugänge verschwinden aus der Ansicht.', 'Erneuern', true);
  if (!ok) { hooksDialog(room); return; }
  const hooks = Object.assign({}, room.meta.hooks);
  const made = [];
  const fresh = [];
  try {
    for (const [hid, h] of list) {
      await api('hook.del', { id: room.id, hid: hid });
      delete hooks[hid];
      const keys = await C.newHookKeys();
      const token = C.newHookToken();
      const nid = C.randomId();
      await api('hook.create', Object.assign({ id: room.id, hid: nid, th: await C.hookTokenHash(token) }, chanParam(room, h.ch)));
      made.push(nid);
      hooks[nid] = { n: h.n, ch: h.ch, k: keys.priv, c: Date.now() };
      fresh.push({ access: C.hookAccess({ u: hookApiUrl(), r: room.id, h: nid, t: token, k: keys.pub }), name: h.n, ch: h.ch, renewed: true });
    }
    await updateMeta(room, metaOf(room, { hooks: hooks }));
  } catch (e) {
    // Neue ohne Leseschlüssel sind nutzlos: zurücknehmen; widerrufene alte aus den Raumdaten nehmen.
    for (const nid of made) { await api('hook.del', { id: room.id, hid: nid }).catch(() => {}); delete hooks[nid]; }
    await updateMeta(S.rooms.get(room.id) || room, metaOf(S.rooms.get(room.id) || room, { hooks: hooks })).catch(() => {});
    toast(e.message, 'error');
    hooksDialog(S.rooms.get(room.id) || room);
    return;
  }
  const cur = S.rooms.get(room.id) || room;
  cur.hookStale = false;
  toast(fresh.length === 1 ? 'Zugang erneuert.' : fresh.length + ' Zugänge erneuert.', 'ok');
  hooksDialog(cur, fresh);
}

async function revokeHook(room, hid, name) {
  const ok = await confirmBox('ZUGANG WIDERRUFEN', (name ? '„' + name + '“' : 'Dieser Zugang') + ' kann danach nicht mehr posten. Bisherige Beiträge verschwinden aus der Ansicht.', 'Widerrufen', true);
  if (!ok) { hooksDialog(room); return; }
  try {
    await api('hook.del', { id: room.id, hid: hid });
    if (room.meta.hooks && room.meta.hooks[hid]) {
      const hooks = Object.assign({}, room.meta.hooks);
      delete hooks[hid];
      await updateMeta(room, metaOf(room, { hooks: hooks }));
    }
    toast('Zugang widerrufen.', 'ok');
  } catch (e) { toast(e.message, 'error'); }
  hooksDialog(S.rooms.get(room.id) || room);
}

function inviteDialog(room) {
  if (!canInvite(room)) { toast(INVITE_NOTE, 'error'); return; }
  openModal({
    title: 'EINLADEN',
    build: (body) => {
      const out = el('div', { class: 'sc-invite-out' });
      // Gültigkeit des Links (je Gerät gemerkt); der Server erlaubt 1–90 Tage.
      let days = 7;
      try { days = [1, 7, 30, 90].includes(+localStorage.getItem('sc-invite-days')) ? +localStorage.getItem('sc-invite-days') : 7; } catch (e) { /* Standard */ }
      const valid = choice([
        { id: '1', name: '1 Tag' },
        { id: '7', name: '7 Tage', info: 'Standard' },
        { id: '30', name: '30 Tage' },
        { id: '90', name: '90 Tage' }
      ], String(days), (id) => {
        days = +id;
        try { localStorage.setItem('sc-invite-days', id); } catch (e) { /* egal */ }
      });
      const mk = el('button', { type: 'button', class: 'btn btn--primary btn--block' }, icon('link', 14), 'Einladungslink erstellen');
      mk.addEventListener('click', async () => {
        mk.disabled = true;
        try {
          const r = await api('room.invite', { id: room.id, days: days });
          const raw = roomKeyRaw(room.id, r.epoch);
          if (!raw) throw new Error('Der aktuelle Raumschlüssel fehlt noch.');
          const until = new Date((r.x || 0) * 1000).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
          const link = WEB_URL + '#join=' + room.id + '.' + r.code + '.' + raw + '.' + r.epoch;
          const input = el('input', { type: 'text', readonly: true, value: link });
          out.textContent = '';
          out.append(input,
            el('button', { type: 'button', class: 'btn', onclick: () => copyText(link, 'Link') }, icon('copy', 14), 'Kopieren'),
            el('p', { class: 'sc-note', text: 'Gilt bis ' + until + ' (' + (days === 1 ? '1 Tag' : days + ' Tage') + '), höchstens 25-mal. Wer den Link hat, kann beitreten und mitlesen – teile ihn nur über einen sicheren Weg. Nach „Raumschlüssel erneuern“ ist er ungültig.' +
              (days > 7 ? ' Solange Einladungslinks offen sind, wechselt der Raumschlüssel nicht wöchentlich.' : '') +
              (room.ao ? ' Nur mit Konto: Wer den Link ohne Konto öffnet, wird zur Kontoerstellung geführt.' : '') }));
          input.select();
        } catch (e) { toast(e.message, 'error'); }
        mk.disabled = false;
      });

      // Nur Mitglieder mit Konto: temporäre Sitzungen gar nicht erst anbieten (der Server lehnte sie ab).
      const people = [...new Set([...S.online, ...S.convs.keys()])]
        .map((id) => S.ids.get(id)).filter((i) => i && i.id !== S.me.id && !room.members.some((m) => m.id === i.id) && !(room.ao && i.kind !== 'account'));
      const list = el('div', { class: 'sc-list' });
      for (const ident of people) {
        list.appendChild(personRow(ident, async () => {
          try {
            const r = await api('room.invite', { id: room.id, max: 1 });
            const raw = roomKeyRaw(room.id, r.epoch);
            await sendDmEvent(ident.id, { t: 'invite', invite: { rid: room.id, code: r.code, key: raw, epoch: r.epoch, name: room.meta.name } });
            toast('Einladung an ' + displayName(ident) + ' verschickt – verschlüsselt mit deren Schlüssel.', 'ok');
          } catch (e) { toast(e.message, 'error'); }
        }));
      }
      appendAll(body,
        el('p', { class: 'sc-p', text: 'Per Link oder direkt an eine Person – dann geht die Einladung samt Raumschlüssel PGP-verschlüsselt an genau sie.' }),
        room.ao ? el('p', { class: 'sc-gate-invite sc-ao-invite' }, icon('users', 15), 'Nur Mitglieder mit Konto: Der Link gilt nur für Konten. Wer ihn ohne Konto öffnet, wird zur Kontoerstellung geführt.') : null,
        field('Gültig', valid.el), mk, out,
        sectionHead('DIREKT EINLADEN'),
        people.length ? list : el('p', { class: 'sc-empty-note', text: 'Niemand in Reichweite. Per Schlüssel verbundene oder online sichtbare Personen erscheinen hier.' }));
    }
  });
}

async function updateMeta(room, meta) {
  const key = await roomKey(room.id, room.epoch);
  if (!key) throw new Error('Der aktuelle Raumschlüssel fehlt.');
  const data = await sealMeta(room, meta, key, room.epoch);
  await api('room.meta', { id: room.id, meta: data, e: room.epoch });
  await loadRooms();
}

/**
 * Raumdaten verschlüsseln. ts: signierter Zeitpunkt, immer später als die
 * zuletzt angenommenen (Rollback-Schutz, mv: 2). Schlüsselarchiv: Der
 * Besitzer legt es nur an, wenn er „Verlauf für Neue“ selbst eingeschaltet
 * hat (Tresor hs), und unterschreibt es (ks); andere geben ein gültiges
 * Archiv dieser Generation unverändert weiter. Passt es nicht hinein, fallen
 * die ältesten Generationen weg.
 */
async function sealMeta(room, meta, key, epoch) {
  const vr = S.vault.rooms[room.id] || {};
  const ts = Math.max(serverNow(), (Number(vr.mt) || 0) + 1);
  const m = Object.assign({ v: 1, t: 'meta', mv: 2, room: room.id, from: S.me.id, ts: ts }, meta);
  const owner = room.owner === S.me.id;
  const dropArchive = () => { delete m.hist; delete m.ka; delete m.ks; };
  if (owner) {
    delete m.ks;
    if (histOn(room)) { m.hist = 1; m.ka = keyArchive(room, epoch); } else dropArchive();
  } else if (!(m.hist && typeof m.ks === 'string' && m.ks && room.meta.ksE === epoch)) {
    dropArchive();
  }
  for (;;) {
    if (owner && m.hist) {
      m.ks = await C.signCard(S.me.priv, { t: 'karch', rid: room.id, e: epoch, hist: 1, ka: m.ka || {}, ts: ts });
    }
    const data = await C.sealRoom(m, key, epoch, room.id, S.me.priv);
    const gens = m.ka ? Object.keys(m.ka).map(Number).sort((a, b) => a - b) : [];
    if (data.length <= META_MAX || !m.hist) return data;
    // Fremdes (signiertes) Archiv lässt sich nicht kürzen: dann ganz weg – der Besitzer legt es neu an.
    if (!owner || !gens.length) { dropArchive(); continue; }
    const keep = gens.slice(Math.ceil(gens.length / 2));
    m.ka = Object.fromEntries(keep.map((e) => [e, m.ka[e]]));
  }
}

/** Kurzer Hash der verschlüsselten Raumdaten (Tresor mh: „schon angenommen“). */
async function metaHash(raw) {
  return C.toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', C.te.encode(String(raw || ''))))).slice(0, 32);
}

/**
 * Signiertes Schlüsselarchiv (ks) prüfen: Unterschrift des Besitzers, dieser
 * Raum, dieselbe Generation wie die Raumdaten. Gibt { ka } oder null zurück.
 */
async function keyArchiveOf(room, ks, metaEpoch) {
  if (typeof ks !== 'string' || !ks || ks.length > META_MAX) return null;
  let owner = S.ids.get(room.owner);
  if (!owner) [owner] = await ensureIds([room.owner]);
  if (!owner || !owner.key) return null;
  const arch = await C.verifyCard(owner.key, ks);
  if (!arch || arch.t !== 'karch' || arch.rid !== room.id || arch.e !== metaEpoch || arch.hist !== 1) return null;
  return { ka: parseKeyArchive(arch.ka, metaEpoch) };
}

/* ---------- Verlauf für neue Mitglieder ---------------------------------------
   Neue Mitglieder bekommen mit dem Link nur den aktuellen Raumschlüssel –
   Nachrichten aus älteren Generationen (vor einem Schlüsselwechsel) können
   sie nicht lesen. Schaltet der Besitzer „Neue Mitglieder sehen den
   Verlauf“ ein (gemerkt nur in seinem Tresor: hs), legt seine App die
   älteren Generationen, die sie selbst noch hat, in die Raumdaten – als von
   ihm signiertes Archiv ks = { t: 'karch', rid, e, hist: 1, ka: { Generation:
   { k, t } }, ts }. Andere Apps übernehmen Schlüssel nur aus einem ks mit
   seiner Unterschrift, für diesen Raum und dieselbe Generation wie die
   Raumdaten; Ränge mit Verwaltungsrechten können es weder einschalten noch
   ändern, nur unverändert weitergeben. hist/ka stehen daneben weiter im
   Klartext der Raumdaten – nur für Apps bis 1.9.2. Das Archiv ist mit dem
   aktuellen Schlüssel verschlüsselt: Lesen kann es, wer im Raum ist oder
   einen gültigen Link hat; der Server sieht nur Chiffretext. Es enthält nur
   Generationen, deren Nachrichten noch aufbewahrt werden können
   (maintainRoomKeys löscht ältere und nimmt sie hier mit heraus), höchstens
   KA_MAX. Ausschalten nimmt das Archiv heraus und wechselt den
   Raumschlüssel (sonst könnte ein Rang das alte ks dieser Generation erneut
   einstellen); wer es schon hat, behält die Schlüssel. */
const KA_MAX = 64;
const MG_MAX = 20;          // gemerkte frühere Verwalter je Raum (Tresor mg)
const META_SKEW = 600000;      // Raumdaten älterer Apps (ohne mv: 2, Zeit vom Gerät): so viel älter darf ihr ts sein
const META_SKEW_NEW = 60000;   // neuere (Serverzeit): Spielraum für Uhren und zwei Verwalter gleichzeitig
const META_MAX = 65536;   // Obergrenze des Servers für Raumdaten (verschlüsselt, Base64)

function histOk(room) { return !!room && room.owner === S.me.id && !room.meta.meet && !room.ot; }
/** Hat der Besitzer (ich) „Verlauf für Neue“ selbst eingeschaltet? Nur der Tresor zählt. */
function histOn(room) {
  const r = histOk(room) && S.vault.rooms[room.id];
  return !!(r && r.hs && r.hs.on);
}

/** Archiv aus dem eigenen Tresor: alle Generationen vor `epoch`, die ich noch habe (die jüngsten KA_MAX). */
function keyArchive(room, epoch) {
  const r = S.vault.rooms[room.id];
  if (!r || !r.k) return {};
  const es = Object.keys(r.k).map(Number).filter((e) => e >= 1 && e < epoch && r.k[e]).sort((a, b) => a - b).slice(-KA_MAX);
  const out = {};
  for (const e of es) out[e] = { k: r.k[e], t: Number((r.et || {})[e]) || 0 };
  return out;
}

function parseKeyArchive(raw, metaEpoch) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [e, v] of Object.entries(raw).slice(0, KA_MAX)) {
    const n = Number(e);
    if (!/^\d{1,6}$/.test(e) || n < 1 || n >= metaEpoch || !v || typeof v.k !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(v.k)) continue;
    // Zeitpunkt höchstens „jetzt“ (er steuert, wann alte Generationen gelöscht werden)
    out[n] = { k: v.k, t: Number.isFinite(Number(v.t)) && Number(v.t) > 0 ? Math.min(Number(v.t), serverNow()) : 0 };
  }
  return out;
}

/** Schlüssel aus dem Archiv übernehmen und wartende (bisher unlesbare) Nachrichten nachholen. */
async function takeKeyArchive(room, ka) {
  let added = false;
  for (const [e, v] of Object.entries(ka)) {
    if (roomKeyRaw(room.id, Number(e))) continue;
    storeRoomKey(room.id, Number(e), v.k, v.t || 0);
    if (roomKeyRaw(room.id, Number(e))) added = true;   // nicht, wenn hier schon gelöscht (Forward Secrecy)
  }
  if (!added) return;
  await saveVault(true).catch(() => {});
  const ready = room.pending.filter((p) => p.k === 'msg' && typeof p.d === 'string' && roomKeyRaw(room.id, C.roomEpoch(p.d)));
  if (!ready.length) return;
  room.pending = room.pending.filter((p) => !ready.includes(p));
  for (const p of ready) await handleFeedEntry(room, p).catch(() => {});
  scheduleRender();
}

/**
 * Raum-Menü: „Neue Mitglieder sehen den Verlauf“ (nur der Besitzer – er
 * verwaltet die Schlüssel). Einschalten: Tresor hs an, signiertes Archiv in
 * die Raumdaten. Ausschalten: Tresor hs aus, neuer Raumschlüssel ohne Archiv.
 */
async function roomHistoryDialog(room) {
  const on = !histOn(room);
  const legacy = on && room.meta.histLegacy;   // unter 1.9.1/1.9.2 eingeschaltet – gilt erst nach erneutem Einschalten
  const ok = await confirmBox('VERLAUF FÜR NEUE MITGLIEDER', on
    ? (legacy ? 'Mit einer älteren App eingeschaltet – seit diesem Update zählt nur noch ein von dir unterschriebenes Archiv. Bitte einmal neu einschalten. ' : '') +
      'Neue Mitglieder können ältere Nachrichten lesen (soweit sie noch aufbewahrt werden). Gilt für alle Kanäle des Raums. Dafür legt deine App die älteren Raumschlüssel verschlüsselt und von dir unterschrieben in die Raumdaten – höchstens ' + KA_MAX + ' Generationen. Wer einen gültigen Einladungslink hat, kann sie damit lesen.'
    : 'Neue Mitglieder sehen dann nur noch Nachrichten ab jetzt. Dafür wechselt der Raumschlüssel – offene Einladungslinks werden ungültig. Wer die älteren Schlüssel schon bekommen hat, behält sie.', on ? 'Einschalten' : 'Ausschalten');
  if (!ok) return;
  const vr = S.vault.rooms[room.id] || (S.vault.rooms[room.id] = { k: {}, rot: 0 });
  const before = vr.hs;
  vr.hs = { on: on ? 1 : 0, t: serverNow() };
  try {
    await saveVault(true);
    if (on) {
      await updateMeta(room, metaOf(room));
      toast('Neue Mitglieder sehen jetzt den Verlauf.', 'ok');
    } else {
      // Neuer Schlüssel: Das alte, signierte Archiv gehört zur alten Generation und gilt nicht mehr.
      await rotateRoom(room.id, false);
      const cur = S.rooms.get(room.id);
      if (cur && cur.meta.hist) throw new Error('Der Schlüsselwechsel hat nicht geklappt – die App versucht es später erneut.');
      toast('Neue Mitglieder sehen den Verlauf nicht mehr (neuer Raumschlüssel).', 'ok');
    }
  } catch (e) {
    if (on) { vr.hs = before || { on: 0, t: serverNow() }; saveVault().catch(() => {}); }
    toast(e.message, 'error');
  }
}

/**
 * Besitzer: Archiv auf den Stand des Tresors bringen – nach dem Löschen
 * alter Generationen, wenn eine ältere App oder ein Rang es beim
 * Neu-Verschlüsseln verloren hat, oder wenn es ausgeschaltet ist, aber
 * noch ein gültiges Archiv in den Raumdaten steht (dann neuer Schlüssel).
 */
async function refreshKeyArchive(room) {
  if (!histOk(room) || !room.metaOk || room.metaEpoch !== room.epoch || S.rotating.has(room.id)) return;
  if (!histOn(room)) {
    if (room.meta.hist) await rotateRoom(room.id, false, false);
    return;
  }
  const want = keyArchive(room, room.epoch);
  const have = room.meta.ka || {};
  const same = room.meta.hist && Object.keys(want).length === Object.keys(have).length && Object.keys(want).every((e) => have[e] && have[e].k === want[e].k);
  if (same) return;
  // Automatisch neu anlegen nur mit frischem Tresor (ein anderes Gerät könnte es gerade ausgeschaltet haben).
  if (!room.meta.hist && S.mode === 'account') {
    await refreshOwnKey(true).catch(() => {});
    if (!histOn(room)) return;
  }
  try { await updateMeta(room, metaOf(room)); } catch (e) { /* beim nächsten Mal */ }
}

function addChannel(room) {
  openModal({
    title: 'KANAL ANLEGEN',
    build: (body, close) => {
      const name = el('input', { type: 'text', maxlength: '30', placeholder: 'z. B. planung' });
      const go = el('button', { type: 'button', class: 'btn btn--primary btn--block', text: 'Anlegen' });
      go.addEventListener('click', async () => {
        const n = cleanName(name.value).replace(/\s+/g, '-');   // Groß-/Kleinschreibung bleibt
        if (!n) return;
        go.disabled = true;
        try {
          const ch = room.meta.ch.concat([{ id: C.randomId().slice(0, 10), name: n }]);
          await updateMeta(room, metaOf(room, { ch: ch }));
          close();
          openRoom(room.id, ch[ch.length - 1].id);
        } catch (e) { go.disabled = false; toast(e.message, 'error'); }
      });
      name.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go.click(); });
      body.append(field('Name', name), go);
    }
  });
}

function addVoiceChannel(room) {
  openModal({
    title: 'SPRACHKANAL ANLEGEN',
    build: (body, close) => {
      const name = el('input', { type: 'text', maxlength: '30', placeholder: 'z. B. Besprechung' });
      const go = el('button', { type: 'button', class: 'btn btn--primary btn--block', text: 'Anlegen' });
      go.addEventListener('click', async () => {
        const n = cleanName(name.value).slice(0, 30);
        if (!n) { name.focus(); return; }
        if (room.meta.vch.length >= 20) { toast('Mehr als 20 Sprachkanäle gehen nicht.', 'error'); return; }
        go.disabled = true;
        try {
          await updateMeta(room, metaOf(room, { vch: room.meta.vch.concat([{ id: C.randomId().slice(0, 10), name: n }]) }));
          close();
        } catch (e) { go.disabled = false; toast(e.message, 'error'); }
      });
      name.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go.click(); });
      body.append(field('Name', name, 'Der Name ist wie alles im Raum verschlüsselt. Jeder Sprachkanal fasst bis zu ' + (S.cfg.limits.voice || 8) + ' Personen.'), go);
    }
  });
}

/* ---------- Kanäle: Rechtsklick-Menüs, umbenennen, löschen ------------------ */
/* ---------- Kanäle verschieben (nur Besitzer) -------------------------------
   Per Drag & Drop in der Seitenleiste oder über das Kanal-Menü (Handys kennen
   kein Ziehen). Die Reihenfolge steht in den verschlüsselten Raumdaten und
   gilt für alle. Der erste Sprachkanal ("") bleibt oben – ältere Apps
   erwarten ihn dort. */
let DRAG = null;

async function moveChannel(room, kind, id, toIndex) {
  const list = room.meta[kind].slice();
  const from = list.findIndex((c) => c.id === id);
  if (from < 0) return;
  const [item] = list.splice(from, 1);
  const to = Math.max(kind === 'vch' ? 1 : 0, Math.min(list.length, toIndex));
  list.splice(to, 0, item);
  if (list.every((c, i) => c.id === room.meta[kind][i].id)) return;
  try {
    await updateMeta(room, metaOf(room, { [kind]: list }));
  } catch (e) { toast(e.message, 'error'); }
}

function moveItems(room, kind, id) {
  if (!can(room, RIGHT.CHANNELS) || (kind === 'vch' && id === '')) return [];
  const list = room.meta[kind];
  const i = list.findIndex((c) => c.id === id);
  const min = kind === 'vch' ? 1 : 0;
  if (list.length - min < 2) return [];
  return [
    { icon: 'arrowUp', label: 'Nach oben', disabled: i <= min, run: () => moveChannel(room, kind, id, i - 1) },
    { icon: 'arrowDown', label: 'Nach unten', disabled: i >= list.length - 1, run: () => moveChannel(room, kind, id, i + 1) }
  ];
}

function clearDrop() {
  document.querySelectorAll('.sc-chan.drop-before, .sc-chan.drop-after')
    .forEach((b) => b.classList.remove('drop-before', 'drop-after'));
}

function sortable(btn, room, kind, id) {
  if (kind === 'vch' && id === '') return;
  btn.draggable = true;
  btn.classList.add('is-sortable');
  btn.addEventListener('dragstart', (ev) => {
    DRAG = { rid: room.id, kind: kind, id: id };
    ev.dataTransfer.effectAllowed = 'move';
    try { ev.dataTransfer.setData('text/plain', id || 'sprache'); } catch (e) { /* egal */ }
    btn.classList.add('is-dragging');
  });
  btn.addEventListener('dragend', () => {
    DRAG = null;
    btn.classList.remove('is-dragging');
    clearDrop();
  });
}

function dropTarget(btn, room, kind, id) {
  const ok = () => DRAG && DRAG.rid === room.id && DRAG.kind === kind && DRAG.id !== id;
  btn.addEventListener('dragover', (ev) => {
    if (!ok()) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    const r = btn.getBoundingClientRect();
    const after = (kind === 'vch' && id === '') || ev.clientY > r.top + r.height / 2;
    clearDrop();
    btn.classList.add(after ? 'drop-after' : 'drop-before');
  });
  btn.addEventListener('dragleave', (ev) => {
    if (!btn.contains(ev.relatedTarget)) btn.classList.remove('drop-before', 'drop-after');
  });
  btn.addEventListener('drop', (ev) => {
    if (!ok()) return;
    ev.preventDefault();
    const after = btn.classList.contains('drop-after');
    clearDrop();
    const list = room.meta[kind];
    const from = list.findIndex((c) => c.id === DRAG.id);
    let to = list.findIndex((c) => c.id === id) + (after ? 1 : 0);
    if (from < to) to--;
    const moving = DRAG.id;
    DRAG = null;
    moveChannel(room, kind, moving, to);
  });
}

function textChannelMenu(room, ch) {
  const owner = can(room, RIGHT.CHANNELS);   // Besitzer oder Recht „Kanäle verwalten“
  const w = room.cw[ch.id];
  return [
    { icon: 'check', label: 'Als gelesen markieren', disabled: !(room.unread.get(ch.id) || 0), run: () => markChannelRead(room, ch.id) },
    owner ? { icon: 'edit', label: 'Kanal umbenennen', run: () => renameChannel(room, 'ch', ch) } : null,
    ...moveItems(room, 'ch', ch.id),
    owner && rolesOk(room) ? { icon: 'lock', label: 'Berechtigungen', note: 'Schreiben: ' + (w ? channelWho(room, w.r) : 'alle'), run: () => channelPermDialog(room, 'ch', ch) } : null,
    owner ? { icon: 'clock', label: 'Nachrichten aufbewahren: ' + ttlLabel(chanTtl(room, ch.id)) + (chanTtlOk(room) && !hasChanTtl(room, ch.id) ? ' (wie Raum)' : ''),
      run: () => (chanTtlOk(room) ? channelTtlDialog(room, ch) : roomTtlDialog(room)) } : null,
    owner ? { icon: 'trash', label: 'Kanal löschen', danger: true, disabled: room.meta.ch.length <= 1, run: () => deleteChannel(room, 'ch', ch) } : null
  ];
}

function voiceChannelMenu(room, vch) {
  const owner = can(room, RIGHT.CHANNELS);
  const w = room.vw[vch.id];
  const inHere = !!(S.voice && S.voice.rid === room.id && S.voice.ch === vch.id);
  const aq = AUDIO_QUALITY.find((q) => q.id === room.meta.aq);
  return [
    inHere ? { icon: 'leave', label: 'Sprachkanal verlassen', run: () => leaveVoice() } : { icon: 'speaker', label: 'Beitreten', run: () => joinVoice(room.id, vch.id) },
    owner ? { icon: 'edit', label: 'Sprachkanal umbenennen', run: () => renameChannel(room, 'vch', vch) } : null,
    ...moveItems(room, 'vch', vch.id),
    owner && rolesOk(room) ? { icon: 'lock', label: 'Berechtigungen', note: 'Betreten: ' + (w ? channelWho(room, w) : 'alle'), run: () => channelPermDialog(room, 'vch', vch) } : null,
    can(room, RIGHT.ROOM) ? { icon: 'sliders', label: 'Sprachqualität im Raum: ' + (aq ? aq.name : 'jeder nach Wahl'), run: () => roomAudioDialog(room) } : null,
    owner ? { icon: 'trash', label: 'Sprachkanal löschen', danger: true, disabled: vch.id === '', run: () => deleteChannel(room, 'vch', vch) } : null
  ];
}

function markChannelRead(room, chId) {
  room.unread.set(chId, 0);
  S.vault.reads['room:' + room.id + ':' + chId] = serverNow();
  saveVault();
  renderAll();
}

function renameChannel(room, kind, c) {
  const voice = kind === 'vch';
  openModal({
    title: voice ? 'SPRACHKANAL UMBENENNEN' : 'KANAL UMBENENNEN',
    build: (body, close) => {
      const name = el('input', { type: 'text', maxlength: '30', value: c.name });
      const go = el('button', { type: 'button', class: 'btn btn--primary btn--block', text: 'Speichern' });
      go.addEventListener('click', async () => {
        const n = voice ? cleanName(name.value).slice(0, 30) : cleanName(name.value).replace(/\s+/g, '-').slice(0, 30);
        if (!n) { name.focus(); return; }
        go.disabled = true;
        try {
          const list = room.meta[kind].map((x) => (x.id === c.id ? { id: x.id, name: n } : x));
          await updateMeta(room, metaOf(room, voice ? { vch: list } : { ch: list }));
          close();
        } catch (e) { go.disabled = false; toast(e.message, 'error'); }
      });
      name.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go.click(); });
      body.append(field('Name', name, 'Der Name ist wie alles im Raum verschlüsselt.'), go);
      setTimeout(() => { name.focus(); name.select(); }, 50);
    }
  });
}

async function deleteChannel(room, kind, c) {
  const voice = kind === 'vch';
  if (voice ? c.id === '' : room.meta.ch.length <= 1) return;   // der erste Sprachkanal und der letzte Textkanal bleiben
  const ok = await confirmBox(voice ? 'Sprachkanal löschen' : 'Kanal löschen',
    voice ? '„' + c.name + '“ verschwindet für alle. Wer gerade drin ist, bleibt verbunden, bis er geht.'
      : '„#' + c.name + '“ verschwindet für alle, samt seinen Nachrichten in der Ansicht.', 'Löschen', true);
  if (!ok) return;
  try {
    const list = room.meta[kind].filter((x) => x.id !== c.id);
    await updateMeta(room, metaOf(room, voice ? { vch: list } : { ch: list }));
    // Eigene Aufbewahrung des Kanals beim Server wieder vergessen.
    if (!voice && hasChanTtl(room, c.id)) await api('room.cttl', { id: room.id, c: c.id, ttl: 0 }).then(loadRooms).catch(() => {});
    // Eigene Rechte des Kanals ebenso
    if (voice ? room.vw[c.id] : room.cw[c.id]) await api('room.cperm', { id: room.id, c: c.id, v: voice ? 1 : 0, w: null }).then(loadRooms).catch(() => {});
    if (!voice && S.view.kind === 'room' && S.view.rid === room.id && S.view.ch === c.id) openRoom(room.id, room.meta.ch[0].id);
  } catch (e) { toast(e.message, 'error'); }
}

/** Besitzer: eine Sprachqualität für alle im Raum (überschreibt die eigene Wahl, solange man drin ist). */
function roomAudioDialog(room) {
  openModal({
    title: 'SPRACHQUALITÄT IM RAUM',
    build: (body, close) => {
      const list = el('div', { class: 'sc-quality' });
      const opts = [{ id: '', name: 'Jeder nach eigener Wahl', info: 'Standard', note: 'Jeder nutzt die Tonqualität aus seinen Einstellungen.' }].concat(AUDIO_QUALITY);
      for (const q of opts) {
        list.appendChild(el('button', {
          type: 'button', class: 'sc-quality-opt', 'aria-pressed': (room.meta.aq || '') === q.id ? 'true' : 'false',
          onclick: async () => {
            close();
            try {
              await updateMeta(room, metaOf(room, { aq: q.id }));
              toast(q.id ? 'Im Raum gilt jetzt „' + q.name + '“ für alle.' : 'Im Raum gilt wieder die eigene Wahl.', 'ok');
            } catch (e) { toast(e.message, 'error'); }
          }
        },
        el('span', { class: 'sc-quality-name', text: q.name }),
        el('span', { class: 'sc-quality-info', text: q.info }),
        el('span', { class: 'sc-quality-note', text: q.note })));
      }
      body.append(el('p', { class: 'sc-p', text: 'Gilt in allen Sprachkanälen von „' + room.meta.name + '“ und überschreibt die Einstellung der Mitglieder, solange sie drin sind. Stereo („Musik“) greift, sobald sich die Verbindungen neu aufbauen.' }), list);
    }
  });
}

/** Raumbild: klein (128 × 128) und verschlüsselt in den Raumdaten – der Server sieht es nicht. */
function roomPicture(room) {
  openModal({
    title: 'RAUMBILD',
    build: (body, close) => {
      const set = async (remove) => {
        try {
          let img = '';
          if (!remove) {
            const file = await pickImage();
            if (!file) return;
            // Klein halten: Die Raumdaten haben eine feste Obergrenze.
            for (const [size, quality] of [[128, 0.84], [112, 0.72], [96, 0.6]]) {
              img = 'data:image/jpeg;base64,' + C.b64(await squareImage(file, size, quality));
              if (img.length <= 22000) break;
            }
            if (img.length > 22000) throw new Error('Das Bild lässt sich nicht klein genug machen.');
          }
          await updateMeta(room, metaOf(room, { img: img }));
          close();
          toast(img ? 'Raumbild gespeichert.' : 'Raumbild entfernt.', 'ok');
        } catch (e) { toast(e.message, 'error'); }
      };
      body.append(
        el('div', { class: 'sc-pic-row' },
          room.meta.img ? el('img', { class: 'sc-pic-big', src: room.meta.img, alt: '' }) : el('span', { class: 'sc-pic-big sc-pic-empty', text: initials(room.meta.name) }),
          el('p', { class: 'sc-note', text: 'Sehen nur Mitglieder: Das Bild steckt verschlüsselt in den Raumdaten. Es wird quadratisch zugeschnitten und verkleinert, Ortsangaben und andere Bilddaten fallen weg.' })),
        el('div', { class: 'sc-card-actions' },
          el('button', { type: 'button', class: 'btn btn--primary', onclick: () => set(false) }, icon('image', 14), 'Bild wählen'),
          room.meta.img ? el('button', { type: 'button', class: 'btn sc-btn--danger', onclick: () => set(true) }, icon('trash', 14), 'Entfernen') : null));
      symbolPicker(body, room, close);
    }
  });
}

/* ---------- Vorgefertigte Raumsymbole ---------------------------------------
   Statt eines Fotos: ein Symbol im Strichstil der App auf einer Farbfläche.
   Gespeichert wird es wie ein hochgeladenes Bild – als kleines PNG
   (128 × 128) in meta.img. So zeigen es auch ältere Apps, und es geht beim
   Neu-Verschlüsseln (metaOf) nicht verloren. Alles eigene Zeichnungen
   (24er-Raster, Linien wie ICONS); nie Daten von außen. */
const ROOM_SYMBOLS = [
  { id: 'gamepad', label: 'Controller', svg: '<path d="M6.5 8h11a4 4 0 0 1 3.9 3.1l1 4.6a2.4 2.4 0 0 1-4.1 2.1L16 15.5H8l-2.3 2.3a2.4 2.4 0 0 1-4.1-2.1l1-4.6A4 4 0 0 1 6.5 8z"/><path d="M7.5 10.3v3.4M5.8 12h3.4"/><path d="M15.5 10.8h.01M17.6 13.2h.01"/>' },
  { id: 'block', label: 'Block', svg: '<path d="M12 2.8l8.5 4.7v9L12 21.2l-8.5-4.7v-9z"/><path d="M3.5 7.5L12 12.2l8.5-4.7M12 12.2v9"/><path d="M3.5 10.6l2.3 1.3 1.6-.5 1.8 1.6 2.8 1.6M20.5 10.6l-2.3 1.3-1.6-.5-1.8 1.6-2.8 1.6"/>' },
  { id: 'sword', label: 'Schwert', svg: '<path d="M20.5 3.5l-.6 4.1-9.1 9.1-3.5-3.5 9.1-9.1z"/><path d="M5.3 12.3l6.4 6.4M8.5 15.5L4 20M3.3 18.7l2 2"/>' },
  { id: 'music', label: 'Musik', svg: '<path d="M9 18V5.5l11-2v12"/><path d="M9 9.5l11-2"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="15.5" r="2.5"/>' },
  { id: 'headphones', label: 'Kopfhörer', svg: ICONS.head },
  { id: 'code', label: 'Code', svg: ICONS.code },
  { id: 'terminal', label: 'Terminal', svg: '<rect x="2.5" y="4" width="19" height="16" rx="1"/><path d="M6.5 9.5l3 2.5-3 2.5M12 15h5"/>' },
  { id: 'film', label: 'Film', svg: '<path d="M3 9.5h18V20H3z"/><path d="M3 9.5l-.5-3.7 17-2.6.5 3.7z"/><path d="M7.2 5.6l2.4 3M11.6 4.9l2.4 3M16 4.2l2.4 3"/>' },
  { id: 'camera', label: 'Kamera', svg: '<path d="M3 8h3.5L8 5.5h8L17.5 8H21v11H3z"/><circle cx="12" cy="13.2" r="3.5"/>' },
  { id: 'book', label: 'Buch', svg: '<path d="M12 6.5C10 5 7 4.5 3 5v13.5c4-.5 7 0 9 1.5 2-1.5 5-2 9-1.5V5c-4-.5-7 0-9 1.5z"/><path d="M12 6.5V20"/>' },
  { id: 'school', label: 'Schule', svg: '<path d="M2 9l10-4.5L22 9l-10 4.5z"/><path d="M6 11v4.5c3.5 2.5 8.5 2.5 12 0V11"/><path d="M22 9v5"/>' },
  { id: 'rocket', label: 'Rakete', svg: '<path d="M12 2.5c3.5 2.5 5 6.5 4.5 11.5h-9C7 9 8.5 5 12 2.5z"/><circle cx="12" cy="9" r="1.8"/><path d="M7.5 14L5 17.5h3.5M16.5 14l2.5 3.5h-3.5M10 17.5l2 3.5 2-3.5"/>' },
  { id: 'heart', label: 'Herz', svg: '<path d="M12 20s-8-4.6-8-10.3A4.4 4.4 0 0 1 12 7a4.4 4.4 0 0 1 8 2.7C20 15.4 12 20 12 20z"/>' },
  { id: 'star', label: 'Stern', svg: '<path d="M12 3l2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 16.8l-5.4 2.9 1.1-6.1-4.5-4.2 6.1-.8z"/>' },
  { id: 'crown', label: 'Krone', svg: '<path d="M4 16l-1-9 5 4 4-6 4 6 5-4-1 9z"/><path d="M4 19.5h16"/>' },
  { id: 'bolt', label: 'Blitz', svg: ICONS.bolt },
  { id: 'ball', label: 'Ball', svg: '<circle cx="12" cy="12" r="9"/><path d="M12 7.6l3.7 2.7-1.4 4.4H9.7l-1.4-4.4z"/><path d="M12 3v4.6M15.7 10.3l4.6-1.5M14.3 14.7l2.8 3.9M9.7 14.7l-2.8 3.9M8.3 10.3L3.7 8.8"/>' },
  { id: 'coffee', label: 'Kaffee', svg: '<path d="M4 9h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M17 10.5h1.5a2.5 2.5 0 0 1 0 5H17"/><path d="M8 3.5c-1 1.2 1 2 0 3.5M12 3.5c-1 1.2 1 2 0 3.5"/><path d="M3.5 21.5h14"/>' },
  { id: 'pizza', label: 'Pizza', svg: '<path d="M12 21L3.5 6.5C8.5 3.5 15.5 3.5 20.5 6.5z"/><path d="M4.8 8.8c4.5-2.3 9.9-2.3 14.4 0"/><circle cx="10" cy="11.2" r="1.2"/><circle cx="14.2" cy="12.4" r="1.2"/><circle cx="12" cy="16" r="1"/>' },
  { id: 'wrench', label: 'Werkzeug', svg: '<path d="M14.5 3.5a5 5 0 0 0-4.6 6.9L3.5 16.8a1.9 1.9 0 0 0 2.7 2.7l6.4-6.4a5 5 0 0 0 6.9-4.6l-2.8 2.8-2.9-.7-.7-2.9z"/>' },
  { id: 'palette', label: 'Kunst', svg: '<path d="M12 3a9 9 0 0 0 0 18c1.4 0 2-1 1.5-2.2-.6-1.4.3-2.8 1.8-2.8H17a4 4 0 0 0 4-4c0-5-4-9-9-9z"/><circle cx="7.5" cy="11.5" r="1.2"/><circle cx="10" cy="7.3" r="1.2"/><circle cx="14.5" cy="7.3" r="1.2"/>' },
  { id: 'globe', label: 'Welt', svg: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3z"/>' },
  { id: 'home', label: 'Zuhause', svg: '<path d="M3.5 11L12 4l8.5 7"/><path d="M5.5 9.5V20h13V9.5"/><path d="M10 20v-5.5h4V20"/>' },
  { id: 'chat', label: 'Plaudern', svg: '<path d="M4 5h16v11H9l-5 4z"/><path d="M8.5 10.5h.01M12 10.5h.01M15.5 10.5h.01"/>' }
];
const ROOM_COLORS = [
  { id: 'orange', label: 'Orange', bg: '#c2410c', fg: '#fff7ed' },
  { id: 'glow', label: 'Hellorange', bg: '#f97316', fg: '#1c1917' },
  { id: 'graphite', label: 'Graphit', bg: '#27272a', fg: '#f97316' },
  { id: 'blue', label: 'Blau', bg: '#35557f', fg: '#eef4fb' },
  { id: 'green', label: 'Grün', bg: '#2f6f4f', fg: '#effaf3' },
  { id: 'violet', label: 'Violett', bg: '#5b4a8b', fg: '#f3f0fb' },
  { id: 'red', label: 'Rot', bg: '#a3302a', fg: '#fdf0ef' },
  { id: 'sand', label: 'Sand', bg: '#d6c7a8', fg: '#292524' }
];

/** Symbol auf Farbfläche als SVG (nur eigene, feste Zeichen). */
function roomSymbolSvg(sym, color, size) {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '" viewBox="0 0 24 24">' +
    '<rect width="24" height="24" fill="' + color.bg + '"/>' +
    '<g transform="translate(4.8 4.8) scale(.6)" fill="none" stroke="' + color.fg + '" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' + sym.svg + '</g></svg>';
}

/** Als Raumbild: PNG 128 × 128 (wie hochgeladene Bilder, gleiche Grenze). */
function roomSymbolImage(sym, color) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 128;
        canvas.getContext('2d').drawImage(img, 0, 0, 128, 128);
        let url = canvas.toDataURL('image/png');
        if (url.length > 22000) url = canvas.toDataURL('image/jpeg', 0.84);
        resolve(url);
      } catch (e) { reject(e); }
    };
    img.onerror = () => reject(new Error('Das Symbol ließ sich nicht zeichnen.'));
    img.src = 'data:image/svg+xml,' + encodeURIComponent(roomSymbolSvg(sym, color, 128));
  });
}

/** Im Dialog „Raumbild“: Symbol und Farbe wählen, Vorschau groß, dann als Raumbild speichern. */
function symbolPicker(body, room, close) {
  let sym = ROOM_SYMBOLS[0];
  let color = ROOM_COLORS[0];
  const preview = el('span', { class: 'sc-sym-preview' });
  const grid = el('div', { class: 'sc-sym-grid', role: 'listbox', 'aria-label': 'Symbol' });
  const colors = el('div', { class: 'sc-sym-colors', role: 'listbox', 'aria-label': 'Farbe' });
  const name = el('span', { class: 'sc-sym-name' });
  const draw = () => {
    preview.innerHTML = roomSymbolSvg(sym, color, 72);
    name.textContent = (sym.label + ' · ' + color.label).toUpperCase();
    grid.textContent = '';
    for (const s of ROOM_SYMBOLS) {
      const b = el('button', { type: 'button', class: 'sc-sym', role: 'option', title: s.label, 'aria-label': s.label, 'aria-selected': s === sym ? 'true' : 'false', onclick: () => { sym = s; draw(); } });
      b.innerHTML = roomSymbolSvg(s, color, 34);
      grid.appendChild(b);
    }
    colors.textContent = '';
    for (const c of ROOM_COLORS) {
      const b = el('button', { type: 'button', class: 'sc-sym-color', role: 'option', title: c.label, 'aria-label': c.label, 'aria-selected': c === color ? 'true' : 'false', onclick: () => { color = c; draw(); } });
      b.style.background = c.bg;
      colors.appendChild(b);
    }
  };
  const go = el('button', { type: 'button', class: 'btn btn--primary btn--block' }, icon('check', 14), 'Symbol übernehmen');
  go.addEventListener('click', async () => {
    go.disabled = true;
    try {
      const img = await roomSymbolImage(sym, color);
      await updateMeta(room, metaOf(room, { img: img }));
      close();
      toast('Raumbild gespeichert.', 'ok');
    } catch (e) { go.disabled = false; toast(e.message, 'error'); }
  });
  draw();
  appendAll(body, sectionHead('ODER EIN SYMBOL'),
    el('div', { class: 'sc-sym-head' }, preview, el('span', { class: 'sc-sym-side' }, name, colors)),
    grid, go);
}

function renameRoom(room) {
  openModal({
    title: 'RAUM UMBENENNEN',
    build: (body, close) => {
      const name = el('input', { type: 'text', maxlength: '40', value: room.meta.name });
      const go = el('button', { type: 'button', class: 'btn btn--primary btn--block', text: 'Speichern' });
      go.addEventListener('click', async () => {
        const n = cleanName(name.value);
        if (!n) return;
        go.disabled = true;
        try { await updateMeta(room, metaOf(room, { name: n })); close(); } catch (e) { go.disabled = false; toast(e.message, 'error'); }
      });
      body.append(field('Name', name), go);
    }
  });
}

async function leaveRoom(room) {
  // Meeting-Modus: Wer das Meeting verlässt, beendet auch die Sitzung.
  if (inMeetingMode() && room.id === S.meetRid) { guestLeave(); return; }
  const meet = !!room.meta.meet;
  const handOver = isOnceMeeting(room) && room.owner === S.me.id
    ? ' Ein anderer Teilnehmer mit Konto oder Sitzung übernimmt das Meeting; sind nur noch Gäste da, endet es für alle.' : '';
  const ok = await confirmBox(meet ? 'Meeting verlassen' : 'Raum verlassen', 'Du verlässt „' + room.meta.name + '“. Zurück kommst du nur mit einer neuen Einladung.' + handOver, 'Verlassen', true);
  if (!ok) return;
  try {
    if (S.voice && S.voice.rid === room.id) await leaveVoice();
    await api('room.leave', { id: room.id });
    delete S.vault.rooms[room.id];
    saveVault();
    dropRoomLocal(room.id);
  } catch (e) { toast(e.message, 'error'); }
}

async function deleteRoom(room) {
  const once = isOnceMeeting(room);
  const meet = !!room.meta.meet;
  const focus = inMeetingMode() && room.id === S.meetRid;
  const ok = await confirmBox(once ? 'Meeting beenden' : meet ? 'Meeting löschen' : 'Raum löschen', once
    ? 'Das Meeting endet für alle: Chat und Teilnehmerliste werden gelöscht, Gäste verlassen es automatisch, der Link gilt nicht mehr.' + (focus ? ' Deine Sitzung endet damit ebenfalls.' : '')
    : meet ? 'Das Meeting und sein Chat werden für alle gelöscht. Der Link gilt danach nicht mehr.'
      : 'Der Raum und sein gesamter Verlauf werden für alle gelöscht.', once ? 'Beenden' : 'Löschen', true);
  if (!ok) return;
  try {
    if (S.voice && S.voice.rid === room.id) await leaveVoice();
    S.closingMeeting = room.id;   // Meeting-Modus: danach „Du hast das Meeting beendet.“
    await api('room.delete', { id: room.id });
    delete S.vault.rooms[room.id];
    saveVault();
    dropRoomLocal(room.id);
  } catch (e) { S.closingMeeting = null; toast(e.message, 'error'); }
}

async function kickMember(room, ident) {
  const ok = await confirmBox('Entfernen', displayName(ident) + ' wird aus dem Raum entfernt. Danach bekommt der Raum einen neuen Schlüssel, damit spätere Nachrichten für ' + displayName(ident) + ' unlesbar bleiben' +
    (room.owner === S.me.id ? '.' : ' – den verteilt der Besitzer, sobald seine App online ist.'), 'Entfernen', true);
  if (!ok) return;
  try {
    await api('room.kick', { id: room.id, member: ident.id });
    if (room.owner !== S.me.id) {
      // Schlüssel verteilt nur der Besitzer – seine App erneuert ihn, sobald sie den Hinweis sieht.
      await loadRooms();
      toast(displayName(ident) + ' entfernt. Den neuen Raumschlüssel verteilt der Besitzer, sobald er online ist.', 'ok', 7000);
      return;
    }
    await rotateRoom(room.id);
    toast(displayName(ident) + ' entfernt, Raumschlüssel erneuert.' + (room.meta.meet ? ' Bisherige Meeting-Links gelten nicht mehr – teile bei Bedarf einen neuen.' : ''), 'ok', room.meta.meet ? 7000 : undefined);
  } catch (e) { toast(e.message, 'error'); }
}

/**
 * Neuer Raumschlüssel: zufällig im Browser erzeugt, dann PGP-verschlüsselt
 * an alle verbliebenen Mitglieder. Wer den Raum verlassen hat, kann ab
 * jetzt nichts mehr lesen.
 */
/** quiet: der wöchentliche Wechsel – Fehler (etwa ein zweites Gerät war schneller) nicht melden. */
async function rotateRoom(rid, manual, quiet) {
  if (S.rotating.has(rid)) return;
  S.rotating.add(rid);
  try {
    await loadRooms();
    const room = S.rooms.get(rid);
    if (!room || room.owner !== S.me.id) return;
    // Wöchentlicher Wechsel: frisch prüfen – eine gerade erstellte Einladung bliebe sonst nicht gültig.
    if (quiet && room.iv !== 0) return;
    const members = await ensureIds(room.members.map((m) => m.id));
    if (members.length !== room.members.length) throw new Error('Nicht alle Mitglieder ließen sich laden.');
    const raw = C.newRoomKey();
    const epoch = room.epoch + 1;
    const key = await C.importRoomKey(raw);
    const env = await C.sealFor({ v: 1, t: 'roomkey', room: rid, epoch: epoch, key: raw, from: S.me.id, ts: Date.now() }, members.map((m) => m.key), S.me.priv);
    // Verlauf für neue Mitglieder: die bisherige Generation kommt ins Archiv.
    const meta = await sealMeta(room, metaOf(room), key, epoch);   // Archiv nur mit eigener Einstellung (histOn)
    // Erst beim Server wechseln, dann speichern: Wechselt ein zweites Gerät
    // gleichzeitig, scheitert eins (409) – und hat dann keinen falschen
    // Schlüssel im Tresor. Geht das Speichern schief, steht der Schlüssel
    // noch im Paket für alle Mitglieder (auch für uns).
    await api('room.rotate', { id: rid, e: epoch, env: env, meta: meta });
    storeRoomKey(rid, epoch, raw);
    S.vault.rooms[rid].rot = serverNow();
    await saveVault(true);
    await loadRooms();
    if (manual) toast('Neuer Raumschlüssel (Generation ' + epoch + '). Alte Einladungslinks gelten nicht mehr.', 'ok');
  } catch (e) {
    if (!quiet) toast('Schlüsselwechsel: ' + e.message, 'error');
  } finally {
    S.rotating.delete(rid);
  }
}

async function postRoom(room, obj, extra) {
  const key = await roomKey(room.id, room.epoch);
  if (!key) throw new Error('Der aktuelle Raumschlüssel fehlt noch.');
  const msg = Object.assign({ v: 1, id: C.randomId(), from: S.me.id, room: room.id, ts: Date.now() }, obj);
  const d = await C.sealRoom(msg, key, room.epoch, room.id, S.me.priv);
  // Änderungen/Löschungen verfallen mit der Frist ihres Kanals (sonst käme der alte Text zurück).
  await api('room.post', Object.assign({ id: room.id, k: 'msg', d: d }, chanParam(room, obj.ch), extra || {}));
  return msg;
}

async function sendRoomMessage(room, ch, body, file) {
  const local = { id: C.randomId(), from: S.me.id, ts: Date.now(), body: body, state: 'pending' };
  if (file) local.file = parseFileMeta(file);
  const list = room.msgs.get(ch) || [];
  room.msgs.set(ch, list);
  insertSorted(list, local);
  room.byId.set(local.id, local);
  S.forceBottom = true;
  scheduleRender();
  try {
    const key = await roomKey(room.id, room.epoch);
    if (!key) throw new Error('Der aktuelle Raumschlüssel fehlt noch.');
    const msg = { v: 1, t: 'msg', id: local.id, from: S.me.id, room: room.id, ch: ch, ts: local.ts, body: body };
    if (file) msg.file = file;
    const d = await C.sealRoom(msg, key, room.epoch, room.id, S.me.priv);
    await api('room.post', Object.assign({ id: room.id, k: 'msg', d: d }, chanParam(room, ch)));
    local.state = null;
  } catch (e) {
    local.state = 'failed';
    toast(e.message, 'error');
  }
  scheduleRender();
}

async function handleFeedEntry(room, e) {
  if (e.k === 'sys') return roomSys(room, e);
  if (e.k === 'key') return roomKeyEnvelope(room, e);
  if (e.k === 'hook') return roomHook(room, e);
  if (e.k === 'del') return roomDelNote(room, e);   // Besitzer hat Einträge entfernt
  if (e.k !== 'msg' && e.k !== 'sig') return;
  const epoch = C.roomEpoch(e.d);
  const key = await roomKey(room.id, epoch);
  if (!key) {
    if (e.k === 'msg') room.pending.push(e);
    return;
  }
  let res;
  try {
    res = await C.openRoom(e.d, key, room.id, keyring());
    if (!res.signer && res.obj && typeof res.obj.from === 'string') {
      const [ident] = await ensureIds([res.obj.from]);
      if (ident) res = await C.openRoom(e.d, key, room.id, [ident.key]);
    }
  } catch (err) { return; }
  const obj = res.obj;
  const from = obj && S.ids.get(obj.from);
  if (!from || from.fp !== res.signer || obj.room !== room.id) return;
  if (e.k === 'msg') roomMessage(room, obj, from, e);
  else await roomSignal(room, obj, from, e);
}

function roomMessage(room, obj, from, e) {
  const ts = e.t * 1000;
  // Kanal steht nur verschlüsselt in der Nachricht. Unbekannte Kanäle
  // (Raumdaten noch nicht entschlüsselt) behalten ihre Kennung und
  // erscheinen, sobald der Kanal bekannt ist.
  const ch = typeof obj.ch === 'string' && /^[A-Za-z0-9_-]{1,22}$/.test(obj.ch) ? obj.ch : room.meta.ch[0].id;
  if (ts + chanTtl(room, ch) * 1000 < serverNow()) return;   // älter als die Aufbewahrung des Kanals
  // Kanal mit Schreibrecht nur für bestimmte Ränge: nur Berechtigtes zeigen (siehe roomPostAllowed)
  if (!roomPostAllowed(room, from.id, ch, e, obj)) return;
  const ref = typeof obj.ref === 'string' ? room.byId.get(obj.ref) : null;
  // Nummern von Änderungen merken: Bekommt der Kanal eine eigene Aufbewahrung, ordnet der Besitzer sie mit zu.
  // Reaktionen anderer zählen mit (Löschen der Nachricht nimmt sie mit).
  if ((((obj.t === 'edit' || obj.t === 'del') && ref && ref.from === from.id) || (obj.t === 'react' && ref)) && e.s) (ref.xs || (ref.xs = [])).push(e.s);
  if (obj.t === 'edit') { if (ref && ref.from === from.id) { ref.body = cleanText(obj.body); ref.edited = true; } scheduleRender(); return; }
  if (obj.t === 'del') { if (ref && ref.from === from.id) ref.deleted = true; scheduleRender(); return; }
  if (obj.t === 'react') { noteReaction(room, obj, from.id); return; }
  if (obj.t !== 'msg') return;
  const existing = room.byId.get(obj.id);
  if (existing) {
    // Gleiche Kennung: nur das Echo der eigenen ausstehenden Nachricht oder
    // dieselbe Nachricht desselben Absenders noch einmal. Fremde Duplikate
    // verwerfen – sonst übernähme ein anderer Nummer und Zeit der Nachricht
    // („Nachricht löschen“ träfe dann seinen Eintrag statt des echten).
    if (existing.from !== from.id) return;
    existing.state = null;
    if (e.s && existing.seq && existing.seq !== e.s) {
      // Mehrere Einträge derselben Nachricht: alle Nummern merken (room.del löscht sie mit).
      if (!(existing.xs || (existing.xs = [])).includes(e.s)) existing.xs.push(e.s);
    } else if (e.s && !existing.seq) {
      existing.seq = e.s;
      if (existing.ts !== ts) {
        existing.ts = ts;
        const list = room.msgs.get(ch);
        if (list) list.sort((a, b) => a.ts - b.ts);
      }
    }
    scheduleRender();
    return;
  }
  const m = { id: String(obj.id), from: from.id, ts: ts, body: cleanText(obj.body), seq: e.s || 0 };
  if (obj.file) {
    const f = parseFileMeta(obj.file);
    if (f) m.file = f;
  }
  const list = room.msgs.get(ch) || [];
  room.msgs.set(ch, list);
  insertSorted(list, m);
  room.byId.set(m.id, m);
  takeReactions(room, m);
  if (from.id !== S.me.id && ts > (S.vault.reads['room:' + room.id + ':' + ch] || 0)) {
    noteArrival('room:' + room.id + ':' + ch, ts, isViewing('room', room.id, ch), () => {
      room.unread.set(ch, (room.unread.get(ch) || 0) + 1);
    }, displayName(from) + ' in „' + room.meta.name + '“');
  }
  scheduleRender();
}

/* ---------- Beiträge von API-Zugängen ----------------------------------------
   Verschlüsselt mit dem öffentlichen Schlüssel des Zugangs; den privaten
   haben alle Mitglieder in den Raumdaten. Keine Signatur einer Identität:
   Der Absender ist „der Zugang“ (Name und Ziel-Kanal legt der Besitzer fest).
   Unbekannte oder widerrufene Zugänge: still ignorieren. */
const HOOK_KEYS = new Map();   // "hid:priv" -> Promise<{ key, pub }>

function hookKey(hid, priv) {
  const id = hid + ':' + priv;
  if (!HOOK_KEYS.has(id)) HOOK_KEYS.set(id, C.importHookKey(priv).catch(() => null));
  return HOOK_KEYS.get(id);
}

async function roomHook(room, e) {
  if (typeof e.h !== 'string' || typeof e.d !== 'string') return;
  // Raumdaten noch nicht entschlüsselt (Raumschlüssel kommt noch): später.
  if (!room.metaOk) { room.pending.push(e); return; }
  const hook = room.meta.hooks && room.meta.hooks[e.h];
  if (!hook) return;
  const ts = e.t * 1000;
  const ch = room.meta.ch.some((c) => c.id === hook.ch) ? hook.ch : room.meta.ch[0].id;
  if (ts + chanTtl(room, ch) * 1000 < serverNow()) return;
  // Ohne „Verlauf für Neue“: Beiträge von vor dem eigenen Beitritt ausblenden – wie Nachrichten
  // älterer Generationen. Nur die Ansicht: Den Leseschlüssel des Zugangs hat man trotzdem.
  if (!room.meta.hist) {
    const mine = room.members.find((m) => m.id === S.me.id);
    if (mine && mine.j && e.t < mine.j) return;
  }
  const k = await hookKey(e.h, hook.k);
  if (!k) return;
  let obj;
  try { obj = await C.openHook(e.d, k, room.id, e.h); } catch (err) { return; }
  if (!obj || obj.t !== 'hook') return;
  const id = 'hook:' + (typeof obj.id === 'string' && /^[A-Za-z0-9_-]{8,40}$/.test(obj.id) ? obj.id : String(e.s));
  if (room.byId.has(id)) return;   // derselbe Beitrag noch einmal (vom Server wiederholt)
  const m = { id: id, from: 'hook:' + e.h, hook: { id: e.h, name: hook.n }, ts: ts, body: cleanText(obj.body), seq: e.s || 0 };
  const list = room.msgs.get(ch) || [];
  room.msgs.set(ch, list);
  insertSorted(list, m);
  room.byId.set(id, m);
  takeReactions(room, m);
  if (ts > (S.vault.reads['room:' + room.id + ':' + ch] || 0)) {
    noteArrival('room:' + room.id + ':' + ch, ts, isViewing('room', room.id, ch), () => {
      room.unread.set(ch, (room.unread.get(ch) || 0) + 1);
    }, hook.n + ' (API) in „' + room.meta.name + '“');
  }
  scheduleRender();
}

function roomSys(room, e) {
  if (typeof e.id !== 'string') return;
  const ts = e.t * 1000;
  const ident = S.ids.get(e.id);
  const who = displayName(ident);
  const where = room.meta.meet ? 'Meeting' : 'Raum';
  const text = e.ev === 'join' ? who + ' ist dem ' + where + ' beigetreten.'
    : e.ev === 'kick' ? who + ' wurde aus dem ' + where + ' entfernt.'
      : who + (room.meta.meet ? ' hat das Meeting verlassen.' : ' hat den Raum verlassen.');
  const ch = room.meta.ch[0].id;
  const list = room.msgs.get(ch) || [];
  room.msgs.set(ch, list);
  insertSorted(list, { id: 'sys' + e.s, sys: text, icon: e.ev === 'join' ? 'userPlus' : 'leave', ts: ts, from: '' });
  if (e.ev === 'join') ensureIds([e.id]).then(scheduleRender);
  // Wer geht, soll spätere Nachrichten nicht mehr lesen können: Der
  // Besitzer erneuert den Schlüssel (einmal je Ereignis).
  // Ausnahme Meetings: Wer selbst geht, hat den Link und damit den Schlüssel
  // – solange Links offen sind, käme er damit ohnehin wieder hinein. Ein
  // neuer Schlüssel machte nur alle geteilten Links ungültig (Gäste kämen
  // nicht mehr hinein). Entfernen erneuert ihn weiterhin.
  // API-Zugänge: Wer geht, kennt ihre Leseschlüssel weiter (stehen in den Raumdaten). Hinweis an
  // alle, die Zugänge verwalten – im Dialog immer, als Meldung nur bei frischen Ereignissen.
  if ((e.ev === 'leave' || e.ev === 'kick') && e.id !== S.me.id && hooksOk(room)) {
    const hooks = Object.values(room.meta.hooks || {});
    if (hooks.some((h) => !h.c || h.c < ts)) {
      room.hookStale = true;
      if (ts > APP_START + (S.skew || 0) - 10000) {
        toast(who + (e.ev === 'kick' ? ' wurde entfernt' : ' ist gegangen') + ' und kennt die Leseschlüssel der API-Zugänge von „' + room.meta.name +
          '“ weiterhin. Raum-Menü → API-Zugang → „Zugänge erneuern“.', 'ok', 9000);
      }
    }
  }
  const keepLinks = e.ev === 'leave' && room.meta.meet && room.iv;
  if ((e.ev === 'leave' || e.ev === 'kick') && room.owner === S.me.id && e.id !== S.me.id && !keepLinks) {
    const rot = (S.vault.rooms[room.id] && S.vault.rooms[room.id].rot) || 0;
    if (ts > rot) setTimeout(() => rotateRoom(room.id), 1200);
  }
  scheduleRender();
}

async function roomKeyEnvelope(room, e) {
  if (roomKeyRaw(room.id, e.e)) return;
  let res;
  try { res = await openForMe(e.d, keyring()); } catch (err) { return; }
  const obj = res.obj;
  const signer = [...S.ids.values()].find((i) => i.fp === res.signer);
  // Nur der Besitzer verteilt Schlüssel.
  if (!signer || signer.id !== room.owner || obj.t !== 'roomkey' || obj.room !== room.id || obj.epoch !== e.e) return;
  if (!/^[A-Za-z0-9_-]{43}$/.test(obj.key || '')) return;
  storeRoomKey(room.id, obj.epoch, obj.key);
  await saveVault(true).catch(() => {});
  room.pendingKey = !roomKeyRaw(room.id, room.epoch);
  // Erst die Raumdaten (Kanäle, API-Zugänge), dann die wartenden Einträge.
  if (room.metaEpoch === obj.epoch) await decryptMeta(room);
  const waiting = room.pending;
  room.pending = [];
  for (const p of waiting) await handleFeedEntry(room, p);
  scheduleRender();
}

/* ==========================================================================
   Abruf (alle ein, zwei Sekunden)
   ========================================================================== */
function fastPoll(ms) {
  S.fastUntil = Math.max(S.fastUntil, Date.now() + ms);
  if (S.wake) S.wake();
}

function nextDelay() {
  if (S.netFail) return Math.min(15000, 1000 * Math.pow(2, S.netFail));
  if (Date.now() < S.fastUntil) return 700;
  const busy = S.call || S.voice;
  if (document.hidden) return busy ? 1500 : 6000;
  return busy ? 1200 : 2000;
}

async function pollLoop() {
  if (S.polling) return;
  S.polling = true;
  while (S.me && S.token) {
    let more = false;
    try {
      more = await pollOnce();
      if (S.netFail || S.offline) { S.netFail = 0; S.offline = false; scheduleRender(); }
    } catch (e) {
      if (e.status === 401) break;
      S.netFail = Math.min(S.netFail + 1, 5);
      if (!S.offline && S.netFail >= 2) { S.offline = true; scheduleRender(); }
    }
    if (more) continue;
    await new Promise((resolve) => {
      const t = setTimeout(done, nextDelay());
      function done() { clearTimeout(t); S.wake = null; resolve(); }
      S.wake = done;
    });
  }
  S.polling = false;
}

async function pollOnce() {
  const body = { i: S.cursor, r: {}, v: S.voice ? [S.voice.rid] : [] };
  if (!S.cursorLoaded) body.tail = 300;
  for (const room of S.rooms.values()) {
    body.r[room.id] = room.cursor || { s: 0, o: 0, g: 0, tail: 200 };
  }
  const r = await api('poll', body);
  S.skew = r.now * 1000 - Date.now();
  let more = !!r.i.more;
  // Nur neu zeichnen, wenn sich etwas getan hat.
  let changed = r.i.e.length > 0;

  for (const e of r.i.e) await handleInboxEntry(e);
  S.cursor = { s: r.i.s, o: r.i.o, g: r.i.g };
  const first = !S.cursorLoaded;
  S.cursorLoaded = true;

  // Räume: neu, weg, geändert?
  let reload = false;
  for (const rid of Object.keys(r.rooms)) {
    const room = S.rooms.get(rid);
    if (!room || room.rev !== r.rooms[rid].rev) { reload = true; continue; }
    const before = JSON.stringify(room.vcs);
    setVoiceState(room, r.rooms[rid].vcs, r.rooms[rid].vc);
    if (JSON.stringify(room.vcs) !== before) changed = true;
  }
  for (const rid of S.rooms.keys()) if (!r.rooms[rid]) reload = true;
  if (reload) { await loadRooms(); changed = true; }

  for (const rid of Object.keys(r.r)) {
    const room = S.rooms.get(rid);
    if (!room) continue;
    const f = r.r[rid];
    if (f.e.length) changed = true;
    for (const e of f.e) await handleFeedEntry(room, e);
    room.cursor = { s: f.s, o: f.o, g: f.g };
    if (f.more) more = true;
  }

  if (S.voice) reconcileVoice();
  if (KNOCK.shown.size) syncKnocks();
  if (r.pv !== S.pv) { S.pv = r.pv; refreshOnline(); }
  checkLogins(r.tv);
  if (first) { S.forceBottom = true; changed = true; }
  if (changed) scheduleRender();
  return more;
}

async function refreshOnline() {
  if (inMeetingMode()) return;   // Meeting-Modus: keine Online-Liste
  try {
    const r = await api('online');
    const ids = [];
    for (const raw of r.list) {
      const ident = await resolveIdentity(raw);
      if (ident) { ident.on = true; ids.push(ident.id); }
    }
    for (const ident of S.ids.values()) if (ident.id !== S.me.id && !ids.includes(ident.id) && ident.on) ident.on = false;
    S.online = ids.sort((a, b) => displayName(S.ids.get(a)).localeCompare(displayName(S.ids.get(b)), 'de'));
    scheduleRender();
  } catch (e) { /* nächstes Mal */ }
}

/* ==========================================================================
   Medien: Mikrofon, Kamera, Bildschirm
   ========================================================================== */
const M = {
  mic: null, silent: null, cam: null, screen: null, screenAudio: null,
  micOn: true, deaf: false, ctx: null, meters: new Map(),
  camCount: 0, camBack: false, camBusy: false   // Kameras am Gerät, Rückkamera aktiv (nicht spiegeln), Wechsel läuft
};

function audioCtx() {
  if (!M.ctx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) M.ctx = new Ctx();
  }
  // "interrupted": Safari nach Sperrbildschirm oder Anruf auf dem Handy.
  if (M.ctx && (M.ctx.state === 'suspended' || M.ctx.state === 'interrupted')) M.ctx.resume().catch(() => {});
  return M.ctx;
}

/**
 * Handys geben Ton erst nach einem Tippen frei – ein eingehender Anruf kommt
 * aber ohne. Deshalb beim ersten Tippen irgendwo auf der Seite den Ton
 * freischalten (mit einem unhörbar kurzen Ton), damit es später klingelt.
 */
function unlockAudio() {
  const events = ['pointerdown', 'touchend', 'keydown'];
  const done = () => { for (const ev of events) document.removeEventListener(ev, unlock, true); };
  function unlock() {
    const ctx = audioCtx();
    if (!ctx) { done(); return; }
    try {
      const src = ctx.createBufferSource();
      src.buffer = ctx.createBuffer(1, 1, 22050);
      src.connect(ctx.destination);
      src.start(0);
    } catch (e) { /* egal */ }
    if (ctx.state === 'running') done();
    else ctx.resume().then(() => { if (ctx.state === 'running') done(); }).catch(() => {});
  }
  for (const ev of events) document.addEventListener(ev, unlock, true);
}

async function ensureMic() {
  if (M.mic && M.mic.readyState === 'live') return M.mic;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints() });
    M.mic = stream.getAudioTracks()[0];
    M.mic.enabled = M.micOn && !M.deaf;
    meter('local', new MediaStream([M.mic]));
    return M.mic;
  } catch (e) {
    toast(micError(e), 'error', 10000);
    M.micOn = false;
    return silentTrack();
  }
}

/** Warum es kein Mikrofon gibt – mit dem, was hilft. */
function micError(e) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return 'Dieser Browser gibt hier kein Mikrofon frei. Öffne Clavichat direkt in Chrome, Safari, Firefox oder Edge – nicht im Browser einer anderen App.';
  }
  const name = e && e.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Das Mikrofon ist für diese Seite gesperrt. Erlaube es in den Seiteneinstellungen des Browsers (Schloss neben der Adresse) und tippe dann auf das Mikrofon.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'Kein Mikrofon gefunden – du bist dabei, aber stumm.';
  if (name === 'NotReadableError') return 'Das Mikrofon benutzt gerade eine andere App. Schließ sie und tippe dann auf das Mikrofon.';
  return 'Kein Zugriff aufs Mikrofon – du bist dabei, aber stumm.';
}

/** Handys spielen Ton erst nach einem Tippen ab: dann einmal nachholen. */
let audioWaiting = false;
function audioBlocked() {
  if (audioWaiting) return;
  audioWaiting = true;
  toast('Tippe einmal irgendwohin, damit du die anderen hörst.', null, 8000);
  document.addEventListener('pointerdown', () => {
    audioWaiting = false;
    audioCtx();
    for (const a of $('sc-audio').querySelectorAll('audio')) a.play().catch(() => {});
  }, { once: true, capture: true });
}

function silentTrack() {
  if (M.silent && M.silent.readyState === 'live') return M.silent;
  const ctx = audioCtx();
  if (!ctx) return null;
  const dest = ctx.createMediaStreamDestination();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  gain.gain.value = 0;
  osc.connect(gain).connect(dest);
  osc.start();
  M.silent = dest.stream.getAudioTracks()[0];
  return M.silent;
}

function localTrack(slot) {
  if (slot === 'mic') return (M.mic && M.mic.readyState === 'live') ? M.mic : silentTrack();
  if (slot === 'cam') return M.cam;
  if (slot === 'screen') return M.screen;
  return M.screenAudio;
}

function activePeers() {
  const list = [];
  if (S.call && S.call.peer) list.push(S.call.peer);
  if (S.voice) for (const p of S.voice.peers.values()) list.push(p);
  return list;
}

async function pushTrack(slot) {
  for (const p of activePeers()) {
    const tx = p.tx[slot];
    if (tx) { try { await tx.sender.replaceTrack(p.localFor(slot)); } catch (e) { /* Verbindung schon zu */ } }
    p.sendState();
    p.tune();
  }
  renderStage();
  renderUser();
}

async function toggleMic() {
  M.micOn = !M.micOn;
  if (M.micOn && M.deaf) M.deaf = false;
  // Noch kein Mikrofon (abgelehnt oder nie gefragt): jetzt holen – auf dem
  // Handy erscheint die Rückfrage nur nach einem Tippen.
  if (M.micOn && (S.call || S.voice) && !(M.mic && M.mic.readyState === 'live')) {
    audioCtx();
    await ensureMic();
    if (!M.micOn) { renderAll(); return; }
  }
  if (M.mic) M.mic.enabled = M.micOn && !M.deaf;
  applyDeaf();
  pushTrack('mic');
  renderSide();
}

function toggleDeaf() {
  M.deaf = !M.deaf;
  if (M.mic) M.mic.enabled = M.micOn && !M.deaf;
  applyDeaf();
  pushTrack('mic');
  renderSide();
}

function applyDeaf() {
  for (const a of $('sc-audio').querySelectorAll('audio')) a.muted = M.deaf;
}

async function toggleCam() {
  if (M.cam) {
    M.cam.stop();
    setCamTrack(null);
  } else {
    try {
      setCamTrack(await openCamTrack(savedCamera()));
    } catch (e) {
      toast('Kein Zugriff auf die Kamera.', 'error');
      return;
    }
    countCameras();
  }
  pushTrack('cam');
}

/* ---------- Kamera wechseln ------------------------------------------------
   Handy: vorne ↔ hinten (facingMode), sonst reihum durch alle Kameras. Die
   neue Spur ersetzt die alte bei allen Gegenübern ohne neue Aushandlung
   (replaceTrack über pushTrack). Gewählt wird je Gerät (localStorage
   sc-camera: d = Geräte-Kennung, f = 'user'/'environment') und beim
   nächsten Einschalten wieder genommen. Gespiegelt wird nur die Kamera,
   die zu einem zeigt – die Rückkamera nicht. */
const CAM_KEY = 'sc-camera';

function savedCamera() {
  try {
    const v = JSON.parse(localStorage.getItem(CAM_KEY) || 'null');
    if (!v || typeof v !== 'object') return {};
    return {
      d: typeof v.d === 'string' && v.d.length <= 200 ? v.d : '',
      f: v.f === 'user' || v.f === 'environment' ? v.f : ''
    };
  } catch (e) { return {}; }
}

function saveCamera(pick) {
  try {
    if (!pick || (!pick.d && !pick.f)) localStorage.removeItem(CAM_KEY);
    else localStorage.setItem(CAM_KEY, JSON.stringify({ d: pick.d || '', f: pick.f || '' }));
  } catch (e) { /* gilt dann nur bis zum Neuladen */ }
}

function camConstraints(pick, exact) {
  const c = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24 } };
  if (pick && pick.d) c.deviceId = exact ? { exact: pick.d } : { ideal: pick.d };
  else if (pick && pick.f) c.facingMode = exact ? { exact: pick.f } : { ideal: pick.f };
  return c;
}

/** Kamera öffnen – erst genau die gewünschte, sonst die nächstbeste. */
async function openCamTrack(pick) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: camConstraints(pick, true) });
  } catch (e) {
    // Gewählte Kamera fehlt (abgesteckt, anderes Gerät): dann eben eine andere.
    if (!pick || (!pick.d && !pick.f) || (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError'))) throw e;
    stream = await navigator.mediaDevices.getUserMedia({ video: camConstraints(pick, false) });
  }
  return stream.getVideoTracks()[0];
}

/** Zeigt die Kamera zu einem (Front, Webcam) oder weg (Rückkamera)? */
function camFacing(track) {
  if (!track) return '';
  const s = track.getSettings ? track.getSettings() : {};
  if (s.facingMode === 'environment' || s.facingMode === 'user') return s.facingMode;
  if (/back|rear|environment|rück/i.test(track.label || '')) return 'environment';
  return 'user';
}

function setCamTrack(track) {
  M.cam = track || null;
  M.camBack = !!track && camFacing(track) === 'environment';
  if (track) track.addEventListener('ended', () => { if (M.cam === track) { setCamTrack(null); pushTrack('cam'); } });
}

async function videoInputs() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
  try { return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput'); } catch (e) { return []; }
}

/** Wie viele Kameras gibt es? Ab zwei erscheint „Kamera wechseln“. */
async function countCameras() {
  const n = (await videoInputs()).length;
  if (n !== M.camCount) { M.camCount = n; renderControls(); }
  return n;
}
if (typeof navigator !== 'undefined' && navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
  navigator.mediaDevices.addEventListener('devicechange', () => { if (M.cam) countCameras(); });
}

/** Knopf „Kamera wechseln“: Handy vorne/hinten, sonst die nächste Kamera. */
async function switchCamera() {
  if (!M.cam || M.camBusy) return;
  const cams = await videoInputs();
  let pick;
  if (IS_MOBILE) {
    pick = { f: camFacing(M.cam) === 'environment' ? 'user' : 'environment' };
  } else {
    if (cams.length < 2) { toast('Es gibt nur eine Kamera.', 'error'); return; }
    const cur = (M.cam.getSettings && M.cam.getSettings().deviceId) || '';
    const i = cams.findIndex((d) => d.deviceId === cur);
    pick = { d: cams[(i + 1) % cams.length].deviceId };
  }
  await useCamera(pick, true);
}

/**
 * Laufende Kamera gegen eine andere tauschen (pick wie in sc-camera).
 * Handys öffnen meist nur eine Kamera zur Zeit: dort erst die alte
 * schließen, sonst erst die neue öffnen (kein schwarzes Bild dazwischen).
 */
async function useCamera(pick, remember) {
  if (!M.cam || M.camBusy) { if (remember) saveCamera(pick); return; }
  M.camBusy = true;
  const old = M.cam;
  const before = { f: camFacing(old), d: (old.getSettings && old.getSettings().deviceId) || '' };
  let track = null;
  try {
    if (IS_MOBILE) old.stop();
    try {
      track = pick && !pick.d && !pick.f ? await openCamTrack({}) : await openCamTrackExact(pick);
    } catch (e) {
      toast(IS_MOBILE && pick.f ? (pick.f === 'environment' ? 'Die Rückkamera' : 'Die Frontkamera') + ' ließ sich nicht öffnen.' : 'Diese Kamera ließ sich nicht öffnen.', 'error');
      if (!IS_MOBILE) return;   // die alte läuft weiter
      try { track = await openCamTrack(before.d ? { d: before.d } : { f: before.f }); } catch (e2) { track = null; }
    }
    if (!IS_MOBILE && track) old.stop();
    setCamTrack(track);
    if (track && remember) {
      const s = track.getSettings ? track.getSettings() : {};
      saveCamera(IS_MOBILE ? { f: camFacing(track) } : { d: s.deviceId || pick.d || '', f: s.facingMode || '' });
    }
    await pushTrack('cam');
  } finally {
    M.camBusy = false;
  }
}

/** Beim Wechseln genau diese Kamera – sonst merkt man den Knopfdruck nicht. */
async function openCamTrackExact(pick) {
  const stream = await navigator.mediaDevices.getUserMedia({ video: camConstraints(pick, true) });
  return stream.getVideoTracks()[0];
}

/** Auswahl für die Einstellungen: Handy vorne/hinten, dazu alle Kameras. */
async function cameraChoices() {
  const items = [{ id: '', name: 'Standard-Kamera' }];
  if (IS_MOBILE) items.push({ id: 'f:user', name: 'Frontkamera' }, { id: 'f:environment', name: 'Rückkamera' });
  let n = 0;
  for (const d of await videoInputs()) {
    n++;
    if (!d.deviceId || d.deviceId === 'default') continue;
    items.push({ id: 'd:' + d.deviceId, name: d.label || 'Kamera ' + n });
  }
  return items;
}

function cameraChoiceId() {
  const c = savedCamera();
  return c.d ? 'd:' + c.d : c.f ? 'f:' + c.f : '';
}

function setCameraChoice(id) {
  const pick = id.startsWith('d:') ? { d: id.slice(2) } : id.startsWith('f:') ? { f: id.slice(2) } : {};
  saveCamera(pick);
  if (M.cam) useCamera(pick, false);   // läuft gerade: gleich umschalten
}

/* ---------- Bildschirm teilen: Qualität ----------------------------------- */
/**
 * rate gilt je Gegenüber im Anruf, mesh im Sprachkanal: Dort geht der
 * Stream an jeden einzeln, also mal Zahl der Leute. Die Kennungen stehen
 * genauso in desktop/picker.js (Auswahlfenster der Windows-App).
 */
// Aufsteigend nach Datenrate (rate: Höchstwert im Zweiergespräch). Dieselben
// Kennungen und dieselbe Reihenfolge stehen in desktop/picker.js.
const SCREEN_QUALITY = [
  { id: 'low', name: 'Sparsam', info: '720p · 10 fps · bis 0,8 Mbit/s', note: 'Für schwache Leitungen und Mobilfunk.', w: 1280, h: 720, fps: 10, rate: 800000, mesh: 500000, hint: 'detail' },
  { id: 'normal', name: 'Ausgewogen', info: '1080p · 30 fps · bis 3 Mbit/s', note: 'Für das meiste genau richtig.', w: 1920, h: 1080, fps: 30, rate: 3000000, mesh: 1500000, hint: 'detail' },
  { id: 'text', name: 'Text & Code', info: 'Originalauflösung · 15 fps · bis 4 Mbit/s', note: 'Gestochen scharf für Code, Dokumente und Tabellen.', w: 0, h: 0, fps: 15, rate: 4000000, mesh: 2000000, hint: 'text' },
  { id: 'smooth', name: 'Flüssig', info: '720p · 60 fps · bis 4 Mbit/s', note: 'Für Videos und Spiele: Bewegung vor Schärfe.', w: 1280, h: 720, fps: 60, rate: 4000000, mesh: 2000000, hint: 'motion' },
  { id: 'max', name: 'Hoch', info: '1440p · 60 fps · bis 10 Mbit/s', note: 'Scharf und flüssig, braucht einen schnellen Upload.', w: 2560, h: 1440, fps: 60, rate: 10000000, mesh: 4000000, hint: 'motion' },
  { id: 'source', name: 'Quelle', info: 'Originalauflösung · 60 fps · bis 16 Mbit/s', note: 'Der Bildschirm 1:1 und flüssig – braucht den meisten Upload.', w: 0, h: 0, fps: 60, rate: 16000000, mesh: 6000000, hint: 'motion' }
];
const SQ_KEY = 'sc-screen-quality';   // je Gerät, nicht im Tresor: der Upload hängt am Anschluss
const SQ_DEFAULT = 'normal';
let screenQualityId = null;           // falls localStorage gesperrt ist

function screenQuality() {
  let id = screenQualityId;
  try { id = localStorage.getItem(SQ_KEY) || id; } catch (e) { /* privater Modus */ }
  return SCREEN_QUALITY.find((q) => q.id === id) || SCREEN_QUALITY.find((q) => q.id === SQ_DEFAULT);
}

/**
 * Aufgenommen wird immer in voller Auflösung und mit bis zu 60 Bildern pro
 * Sekunde. Die gewählte Qualität setzt erst der Encoder um (Peer.tune):
 * verkleinern, Bildrate, Datenrate. So lässt sie sich während der
 * Übertragung ändern, ohne die Aufnahme anzufassen – applyConstraints auf
 * der laufenden Spur ließ bei Zuschauern auf dem Handy das Bild stehen.
 */
function screenConstraints() {
  return { frameRate: { ideal: 60, max: 60 } };
}

/** Zuschauer auf Handy oder Tablet: Das sagt die Gegenseite (Peer.sendState). */
const IS_MOBILE = !DESKTOP && typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
const MOBILE_CAP = { long: 1920, short: 1080, fps: 30, rate: 5000000 };

function setScreenQuality(id) {
  if (!SCREEN_QUALITY.some((q) => q.id === id)) return;
  screenQualityId = id;
  try { localStorage.setItem(SQ_KEY, id); } catch (e) { /* gilt dann nur bis zum Neuladen */ }
  applyScreenQuality();
}

/** Läuft gerade eine Übertragung, gilt die gewählte Qualität sofort – über den Encoder. */
async function applyScreenQuality() {
  const q = screenQuality();
  if (M.screen && M.screen.readyState === 'live') M.screen.contentHint = q.hint;
  for (const p of activePeers()) p.tune();
  if ($('sc-controls')) renderControls();
}

// Geändert in einem anderen Fenster – in der Windows-App im Auswahlfenster.
window.addEventListener('storage', (ev) => { if (ev.key === SQ_KEY) applyScreenQuality(); });

function showScreenQuality() {
  openModal({
    title: 'QUALITÄT DER ÜBERTRAGUNG',
    build: (body, close) => {
      const cur = screenQuality();
      const list = el('div', { class: 'sc-quality' });
      for (const q of SCREEN_QUALITY) {
        list.appendChild(el('button', {
          type: 'button', class: 'sc-quality-opt', 'aria-pressed': q.id === cur.id ? 'true' : 'false',
          onclick: () => { setScreenQuality(q.id); close(); }
        },
        el('span', { class: 'sc-quality-name', text: q.name }),
        el('span', { class: 'sc-quality-info', text: q.info }),
        el('span', { class: 'sc-quality-note', text: q.note })));
      }
      body.append(list, el('p', { class: 'sc-note', text: 'Gilt sofort und für alle weiteren Übertragungen auf diesem Gerät. Im Sprachkanal bekommt jeder einen eigenen Stream, deshalb mit kleinerer Datenrate.' }));
    }
  });
}

/* ---------- Anrufe: Tonqualität ------------------------------------------- */
/**
 * rate: Datenrate des Opus-Kodierers je Gegenüber. clean: Echo- und
 * Rauschunterdrückung samt automatischer Lautstärke – für Musik aus, dann
 * aber mit Kopfhörer, sonst hört das Gegenüber sich selbst. Stereo wird
 * beim Verbindungsaufbau ausgehandelt und gilt deshalb ab dem nächsten
 * Anruf; Datenrate und Filter wechseln sofort. Je Gerät gespeichert.
 */
const AUDIO_QUALITY = [   // aufsteigend nach Datenrate
  { id: 'low', name: 'Sparsam', info: '16 kbit/s', note: 'Für schwache Leitungen und Mobilfunk.', rate: 16000, stereo: false, clean: true },
  { id: 'voice', name: 'Sprache', info: '32 kbit/s', note: 'Klar und sparsam, mit Echo- und Rauschunterdrückung.', rate: 32000, stereo: false, clean: true },
  { id: 'high', name: 'Hoch', info: '64 kbit/s', note: 'Mehr Klangdetails, die Unterdrückung bleibt an.', rate: 64000, stereo: false, clean: true },
  { id: 'music', name: 'Musik', info: '128 kbit/s · Stereo', note: 'Für Musik und Instrumente, ohne Filter – nur mit Kopfhörer.', rate: 128000, stereo: true, clean: false }
];
const AQ_KEY = 'sc-audio-quality';
const AQ_DEFAULT = 'voice';
let audioQualityId = null;   // falls localStorage gesperrt ist

/** Eigene Wahl auf diesem Gerät. */
function ownAudioQuality() {
  let id = audioQualityId;
  try { id = localStorage.getItem(AQ_KEY) || id; } catch (e) { /* privater Modus */ }
  return AUDIO_QUALITY.find((q) => q.id === id) || AUDIO_QUALITY.find((q) => q.id === AQ_DEFAULT);
}

/** Raum mit eigener Sprachqualität, in dessen Sprachkanal man gerade ist (oder geht) – sonst null. */
function roomAudioQuality() {
  const rid = S.voice ? S.voice.rid : S.joiningVoice;
  const room = rid && S.rooms.get(rid);
  const id = room && room.meta && room.meta.aq;
  return id ? AUDIO_QUALITY.find((q) => q.id === id) || null : null;
}

/** Was gilt: im Sprachkanal eines Raums mit eigener Einstellung die des Raums, sonst die eigene. */
function audioQuality() {
  return roomAudioQuality() || ownAudioQuality();
}

function micConstraints() {
  const q = audioQuality();
  const c = {
    echoCancellation: q.clean, noiseSuppression: q.clean, autoGainControl: q.clean,
    channelCount: { ideal: q.stereo ? 2 : 1 }, sampleRate: { ideal: 48000 }
  };
  if (S.vault.settings.mic) c.deviceId = { ideal: S.vault.settings.mic };
  return c;
}

async function setAudioQuality(id) {
  if (!AUDIO_QUALITY.some((q) => q.id === id)) return;
  audioQualityId = id;
  try { localStorage.setItem(AQ_KEY, id); } catch (e) { /* gilt dann nur bis zum Neuladen */ }
  await applyAudioQuality();
}

/** Geltende Tonqualität anwenden – nach eigener Wahl oder wenn der Raum sie vorgibt. */
async function applyAudioQuality() {
  // Im Gespräch: Mikrofon mit den neuen Filtern neu holen und tauschen.
  if (M.mic && M.mic.readyState === 'live') {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints() });
      const old = M.mic;
      M.mic = stream.getAudioTracks()[0];
      M.mic.enabled = M.micOn && !M.deaf;
      meter('local', new MediaStream([M.mic]));
      old.stop();
      await pushTrack('mic');
    } catch (e) { toast('Das Mikrofon ließ sich nicht neu einstellen.', 'error'); }
  }
  for (const p of activePeers()) p.tune();
}

/**
 * Stereo für Opus: Was ein Gerät empfangen möchte, steht in seinen
 * Verbindungsangaben. Vor dem Übernehmen der Angaben des Gegenübers kommt
 * dort "stereo=1" hinzu – für den Bildschirmton immer, fürs Mikrofon bei
 * „Musik“. Der Sicherheitscode rechnet weiter mit den unveränderten Angaben.
 */
function opusSdp(sdp) {
  const stereoMic = audioQuality().stereo;
  let audio = 0;
  return String(sdp).split(/(?=^m=)/m).map((section) => {
    if (!/^m=audio /.test(section)) return section;
    if (!(audio++ === 0 ? stereoMic : true)) return section;
    for (const m of section.matchAll(/^a=rtpmap:(\d+) opus\/48000/gim)) {
      section = section.replace(new RegExp('^(a=fmtp:' + m[1] + ' )([^\\r\\n]*)', 'm'), (line, head, params) =>
        head + params.split(';').map((s) => s.trim()).filter((s) => s && !/^(stereo|sprop-stereo)=/i.test(s))
          .concat(['stereo=1', 'sprop-stereo=1']).join(';'));
    }
    return section;
  }).join('');
}

async function toggleScreen() {
  if (M.screen) {
    stopScreen();
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    toast('Dieser Browser kann den Bildschirm nicht teilen.', 'error');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: screenConstraints(), audio: true });
    M.screen = stream.getVideoTracks()[0];
    M.screenAudio = stream.getAudioTracks()[0] || null;
    M.screen.addEventListener('ended', stopScreen);
  } catch (e) {
    if (e && e.name !== 'NotAllowedError') toast('Bildschirm teilen ging nicht: ' + e.message, 'error');
    return;
  }
  // In der Windows-App kann das Auswahlfenster die Qualität eben noch geändert haben.
  await applyScreenQuality();
  pushTrack('screen');
  pushTrack('screenAudio');
}

function stopScreen() {
  if (M.screen) M.screen.stop();
  if (M.screenAudio) M.screenAudio.stop();
  M.screen = null;
  M.screenAudio = null;
  pushTrack('screen');
  pushTrack('screenAudio');
}

function stopLocalMedia() {
  for (const t of [M.mic, M.cam, M.screen, M.screenAudio]) if (t) t.stop();
  M.mic = M.cam = M.screen = M.screenAudio = null;
  M.camBack = false;
  unmeter('local');
}

function teardownMedia() {
  try {
    if (S.call) endCall(null, true);
    if (S.voice) leaveVoice(true);
  } catch (e) { /* beim Verlassen egal */ }
  stopLocalMedia();
}

/* ---------- Pegel: wer spricht gerade? ------------------------------------ */
function meter(key, stream) {
  const ctx = audioCtx();
  if (!ctx || !stream || !stream.getAudioTracks().length) return;
  unmeter(key);
  try {
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    M.meters.set(key, { src: src, an: an, buf: new Uint8Array(an.fftSize), level: 0 });
  } catch (e) { /* kein Pegel */ }
  if (!meterTimer) meterTimer = setInterval(readMeters, 160);
}

function unmeter(key) {
  const m = M.meters.get(key);
  if (!m) return;
  try { m.src.disconnect(); } catch (e) { /* schon getrennt */ }
  M.meters.delete(key);
}

let meterTimer = 0;
function readMeters() {
  if (!M.meters.size) { clearInterval(meterTimer); meterTimer = 0; return; }
  for (const [key, m] of M.meters) {
    m.an.getByteTimeDomainData(m.buf);
    let sum = 0;
    for (let i = 0; i < m.buf.length; i++) { const v = (m.buf[i] - 128) / 128; sum += v * v; }
    const rms = Math.sqrt(sum / m.buf.length);
    const speaking = rms > 0.035 && !(key === 'local' && (!M.micOn || M.deaf));
    const id = key === 'local' ? S.me.id : key;
    for (const node of document.querySelectorAll('[data-speak="' + id + '"]')) node.classList.toggle('is-speaking', speaking);
  }
}

/* ---------- Wiedergabe der Gegenseite ------------------------------------- */
function attachAudio(peer, slot, stream) {
  const box = $('sc-audio');
  const key = peer.remoteId + ':' + slot;
  let a = box.querySelector('audio[data-key="' + key + '"]');
  if (!a) {
    a = el('audio', { autoplay: true, dataset: { key: key } });
    box.appendChild(a);
  }
  a.srcObject = stream;
  a.muted = M.deaf;
  a.play().catch(audioBlocked);
  if (slot === 'mic') meter(peer.remoteId, stream);
}

function detachAudio(peer) {
  for (const a of $('sc-audio').querySelectorAll('audio[data-key^="' + peer.remoteId + ':"]')) {
    a.srcObject = null;
    a.remove();
  }
  unmeter(peer.remoteId);
}

/* ==========================================================================
   WebRTC: eine Verbindung zu einem Gegenüber
   --------------------------------------------------------------------------
   Vier feste Spuren (Mikrofon, Kamera, Bildschirm, Bildschirm-Ton), von
   Anfang an ausgehandelt. Kamera und Bildschirm an/aus heißt nur "Spur
   tauschen" – ohne erneutes Aushandeln über den Server. Ein Datenkanal
   (ebenfalls DTLS-verschlüsselt) meldet, was gerade an ist.
   ========================================================================== */
/**
 * Verbindungsserver nach der Anmeldung: Erst hier gibt der Server die
 * Zugangsdaten eines Relay-Servers (TURN) heraus. Vorher – und bei älteren
 * Servern – bleibt es bei den öffentlichen aus "config".
 */
async function loadIce() {
  try {
    const r = await api('ice');
    if (Array.isArray(r.ice)) S.cfg.ice = r.ice;
    S.cfg.relay = !!r.relay;
  } catch (e) { /* bleibt bei STUN */ }
}

/**
 * Die Zugangsdaten des Relays gelten nur einen Tag, die Windows-App läuft
 * aber oft tagelang: alle sechs Stunden neu holen. Sonst scheitern Anrufe
 * über das Relay – mit „IP verbergen“ also jeder Anruf.
 */
const ICE_REFRESH = 6 * 3600 * 1000;
let iceTimer = null;

function startIceRefresh() {
  if (!iceTimer) iceTimer = setInterval(() => { if (S.entered) loadIce(); }, ICE_REFRESH);
}

/** Die Relay-Server (TURN) unter den Verbindungsservern. */
function turnServers() {
  return (S.cfg.ice || []).filter((s) => [].concat(s.urls).some((u) => /^turns?:/i.test(String(u))));
}

/* ---------- IP-Adresse verbergen ------------------------------------------
   Nur über das Relay verbinden: Dann stehen im Verbindungsangebot keine
   eigenen Adressen, das Gegenüber sieht nur die des Relays – auch beim
   Klingeln, auch wenn es nie abnimmt. Konten speichern die Wahl im Tresor
   (gilt auf allen Geräten), temporäre Sitzungen je Gerät. Dort ist sie von
   Haus aus an: Wer Fremde aus der Online-Liste anruft, gäbe sonst seine IP
   preis. */
const HIDE_KEY = 'sc-hide-ip';
let hideIpTemp = null;   // falls localStorage gesperrt ist

function hidingIp() {
  if (!S.cfg || !S.cfg.relay) return false;
  if (S.mode !== 'temp') return !!S.vault.settings.hideIp;
  let on = hideIpTemp;
  try {
    const v = localStorage.getItem(HIDE_KEY);
    if (v === '1' || v === '0') on = v === '1';
  } catch (e) { /* privater Modus */ }
  return on === null ? true : on;
}

function setHideIp(on) {
  if (S.mode !== 'temp') { S.vault.settings.hideIp = !!on; saveVault(); return; }
  hideIpTemp = !!on;
  try { localStorage.setItem(HIDE_KEY, on ? '1' : '0'); } catch (e) { /* gilt dann nur bis zum Neuladen */ }
}

/**
 * Vor einem Anruf: Soll die IP verborgen bleiben, muss ein Relay da sein.
 * Fehlen die Zugangsdaten, einmal nachladen – klappt das nicht, lieber kein
 * Anruf als einer, der die IP preisgibt.
 */
async function relayReady() {
  if (!hidingIp()) return true;
  if (!turnServers().length) await loadIce();
  if (turnServers().length) return true;
  toast('„IP verbergen“ ist an, aber der Relay-Server ist gerade nicht erreichbar – ohne ihn wäre deine IP sichtbar. ' +
    'Versuch es gleich noch einmal oder schalte „IP verbergen“ in den Einstellungen aus.', 'error', 12000);
  return false;
}

/** Einmal je Sitzung erklären, warum eine Verbindung nicht zustande kommt. */
let routeHint = false;
function noDirectRoute(id) {
  if (routeHint || (S.cfg && S.cfg.relay)) return;
  routeHint = true;
  toast('Zu ' + displayName(S.ids.get(id)) + ' kommt keine direkte Verbindung zustande. Das ist typisch für Mobilfunk und strenge Netze – ' +
    'dafür braucht Clavichat einen Relay-Server (TURN), der hier noch nicht eingerichtet ist.', 'error', 14000);
}

/** Wie läuft eine Verbindung? Direkt im Netz, übers Internet oder über das Relay. */
async function routeOf(pc) {
  try {
    const stats = await pc.getStats();
    let pair = null;
    stats.forEach((s) => { if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId); });
    if (!pair) stats.forEach((s) => { if (!pair && s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s; });
    if (!pair) return null;
    const types = [stats.get(pair.localCandidateId), stats.get(pair.remoteCandidateId)].map((c) => c && c.candidateType);
    if (types.includes('relay')) return 'verbunden über den Relay-Server';
    if (types.every((t) => t === 'host')) return 'direkt verbunden (selbes Netz)';
    return 'direkt verbunden (übers Internet)';
  } catch (e) { return null; }
}

/**
 * Erreicht dieses Gerät den Relay-Server? Eine Probe ohne Gegenüber: Gibt der
 * TURN-Server eine Relay-Adresse heraus, funktioniert er. Ergebnis 'ok',
 * 'fail' oder 'none' (keiner eingerichtet). Dabei sieht der Relay-Betreiber
 * die IP-Adresse dieses Geräts – wie bei jedem Anruf über das Relay.
 */
const RELAY = { state: null, at: 0 };

async function probeRelay(ms) {
  if (!S.cfg.relay) return 'none';
  if (!turnServers().length) await loadIce();
  const servers = turnServers();
  if (!servers.length || typeof RTCPeerConnection !== 'function') return 'fail';
  let pc = null;
  try {
    pc = new RTCPeerConnection({ iceServers: servers, iceTransportPolicy: 'relay' });
    pc.createDataChannel('probe');
    const found = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms || 6000);
      pc.onicecandidate = (ev) => {
        const c = ev.candidate;
        if (c && / typ relay( |$)/.test(c.candidate)) { clearTimeout(timer); resolve(true); }
        else if (!c) { clearTimeout(timer); resolve(false); }   // fertig gesammelt, nichts gefunden
      };
    });
    await pc.setLocalDescription(await pc.createOffer());
    return (await found) ? 'ok' : 'fail';
  } catch (e) {
    return 'fail';
  } finally {
    if (pc) pc.close();
  }
}

/** Zeile in den Einstellungen: ist der Relay-Server da und erreichbar? */
function relayStatusRow() {
  const row = el('div', { class: 'sc-set-row sc-relay' });
  const texts = {
    none: ['nicht eingerichtet', 'Über Mobilfunk und in strengen Netzen kommen Anrufe dann oft nicht zustande.'],
    test: ['wird geprüft …', 'Clavichat baut eine Probe-Verbindung zum Relay auf.'],
    ok:   ['verbunden', 'Anrufe klappen auch mit Handys im Mobilfunk und hinter strengen Firewalls. Kommt keine direkte Verbindung zustande, läuft das Gespräch verschlüsselt über das Relay.'],
    fail: ['nicht erreichbar', 'Der Relay-Server ist eingetragen, von diesem Gerät aus aber gerade nicht erreichbar. Anrufe übers Handy können scheitern.']
  };
  const draw = (state) => {
    row.textContent = '';
    row.className = 'sc-set-row sc-relay is-' + state;
    appendAll(row, el('span', { class: 'sc-relay-dot', 'aria-hidden': 'true' }),
      el('span', { class: 'sc-set-text' }, el('strong', { text: 'Relay-Server (TURN): ' + texts[state][0] }), el('span', { text: texts[state][1] })),
      state === 'ok' || state === 'fail' ? el('button', { type: 'button', class: 'btn', text: 'Erneut prüfen', onclick: () => run(true) }) : null);
  };
  const run = async (fresh) => {
    if (!S.cfg.relay) { draw('none'); return; }
    if (!fresh && RELAY.state && Date.now() - RELAY.at < 600000) { draw(RELAY.state); return; }
    draw('test');
    RELAY.state = await probeRelay(6000);
    RELAY.at = Date.now();
    if (row.isConnected) draw(RELAY.state);
  };
  draw(S.cfg.relay ? (RELAY.state || 'test') : 'none');
  setTimeout(() => run(false), 0);
  return row;
}

function rtcConfig() {
  return { iceServers: S.cfg.ice || [], iceTransportPolicy: hidingIp() ? 'relay' : 'all', bundlePolicy: 'max-bundle' };
}

class Peer {
  constructor(remoteId, opts) {
    this.remoteId = remoteId;
    this.opts = opts;
    this.initiator = !!opts.initiator;
    this.created = Date.now();
    this.tx = {};
    this.remote = {};
    this.remoteState = { mic: true, cam: false, screen: false, deaf: false, mobile: false, noscreen: false };
    this.stats = null;      // Messwerte (readStats), alle zwei Sekunden neu
    this.statsRaw = null;
    this.localSdp = null;
    this.remoteSdp = null;
    this.code = null;
    this.closed = false;
    this.pc = new RTCPeerConnection(rtcConfig());
    this.dc = this.pc.createDataChannel('ctl', { negotiated: true, id: 0 });
    this.dc.onopen = () => this.sendState();
    this.dc.onmessage = (ev) => this.onData(ev.data);
    this.pc.ontrack = (ev) => this.onTrack(ev);
    this.pc.onconnectionstatechange = () => this.onConn();
  }

  static waitIce(pc) {
    return new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') { resolve(); return; }
      const t = setTimeout(done, 2500);
      function check() { if (pc.iceGatheringState === 'complete') done(); }
      function done() { clearTimeout(t); pc.removeEventListener('icegatheringstatechange', check); resolve(); }
      pc.addEventListener('icegatheringstatechange', check);
    });
  }

  async attachLocal() {
    await Promise.all(SLOTS.map((slot) => this.tx[slot] ? this.tx[slot].sender.replaceTrack(this.localFor(slot)) : null));
  }

  /** Was dieses Gegenüber bekommt: Hat es die Übertragung ausgeblendet, nichts vom Bildschirm. */
  localFor(slot) {
    if ((slot === 'screen' || slot === 'screenAudio') && this.remoteState.noscreen) return null;
    return localTrack(slot);
  }

  async offer() {
    for (const slot of SLOTS) this.tx[slot] = this.pc.addTransceiver(SLOT_KIND[slot], { direction: 'sendrecv' });
    await this.attachLocal();
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await Peer.waitIce(this.pc);
    this.localSdp = this.pc.localDescription.sdp;
    return this.localSdp;
  }

  async answer(sdp) {
    this.remoteSdp = sdp;
    await this.pc.setRemoteDescription({ type: 'offer', sdp: opusSdp(sdp) });
    const list = this.pc.getTransceivers();
    SLOTS.forEach((slot, i) => {
      if (list[i]) { this.tx[slot] = list[i]; list[i].direction = 'sendrecv'; }
    });
    await this.attachLocal();
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await Peer.waitIce(this.pc);
    this.localSdp = this.pc.localDescription.sdp;
    this.computeCode();
    return this.localSdp;
  }

  async accept(sdp) {
    this.remoteSdp = sdp;
    await this.pc.setRemoteDescription({ type: 'answer', sdp: opusSdp(sdp) });
    this.computeCode();
  }

  async restartOffer() {
    await this.pc.setLocalDescription(await this.pc.createOffer({ iceRestart: true }));
    await Peer.waitIce(this.pc);
    this.localSdp = this.pc.localDescription.sdp;
    return this.localSdp;
  }

  async restartAnswer(sdp) {
    this.remoteSdp = sdp;
    await this.pc.setRemoteDescription({ type: 'offer', sdp: opusSdp(sdp) });
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await Peer.waitIce(this.pc);
    this.localSdp = this.pc.localDescription.sdp;
    this.computeCode();
    return this.localSdp;
  }

  computeCode() {
    C.safetyCode(this.localSdp, this.remoteSdp).then((code) => { this.code = code; this.changed(); });
  }

  onTrack(ev) {
    const index = this.pc.getTransceivers().indexOf(ev.transceiver);
    const slot = SLOTS[index] || 'mic';
    const stream = new MediaStream([ev.track]);
    this.remote[slot] = stream;
    ev.track.addEventListener('unmute', () => this.changed());
    ev.track.addEventListener('mute', () => this.changed());
    if (slot === 'mic' || slot === 'screenAudio') attachAudio(this, slot, stream);
    this.changed();
  }

  sendState() {
    if (this.dc.readyState !== 'open') return;
    try {
      this.dc.send(JSON.stringify({ t: 'state', mic: M.micOn && !M.deaf, cam: !!M.cam, screen: !!M.screen, deaf: M.deaf, mobile: IS_MOBILE,
        noscreen: S.hiddenScreens.has(this.remoteId) }));
    } catch (e) { /* Kanal zu */ }
  }

  onData(raw) {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.t === 'state') {
      const was = this.remoteState;
      this.remoteState = { mic: !!m.mic, cam: !!m.cam, screen: !!m.screen, deaf: !!m.deaf, mobile: !!m.mobile, noscreen: !!m.noscreen };
      if (this.remoteState.mobile !== was.mobile) this.tune();   // Zuschauer am Handy: Stream anpassen
      // Ausgeblendet: an dieses Gegenüber nichts mehr vom Bildschirm senden (spart Bandbreite).
      if (this.remoteState.noscreen !== was.noscreen) {
        for (const slot of ['screen', 'screenAudio']) {
          if (this.tx[slot]) this.tx[slot].sender.replaceTrack(this.localFor(slot)).then(() => this.tune()).catch(() => {});
        }
      }
      this.changed();
    } else if (m.t === 'bye' && this.opts.onBye) {
      this.opts.onBye(this);
    }
  }

  onConn() {
    const st = this.pc.connectionState;
    if (st === 'connected') { this.restarting = false; this.failed = false; this.tune(); }
    if (st === 'failed') { this.failed = true; noDirectRoute(this.remoteId); }
    if (st === 'failed' && this.initiator && !this.restarting && this.opts.onRestart) {
      this.restarting = true;
      this.opts.onRestart(this);
    }
    this.changed();
  }

  /**
   * Datenraten deckeln – im Sprachkanal (jeder mit jedem) knapper. Für den
   * Bildschirm gelten Datenrate und Bildrate der gewählten Qualität, fürs
   * Mikrofon die der Tonqualität; Bildschirmton immer mit 128 kbit/s.
   */
  tune() {
    const mesh = this.opts.mesh;
    const q = screenQuality();
    const a = audioQuality();
    for (const slot of ['mic', 'screenAudio']) {
      const tx = this.tx[slot];
      if (!tx || !tx.sender.track) continue;
      const p = tx.sender.getParameters();
      if (!p.encodings || !p.encodings.length) continue;
      p.encodings[0].maxBitrate = slot === 'mic' ? a.rate : 128000;
      tx.sender.setParameters(p).catch(() => {});
    }
    for (const slot of ['cam', 'screen']) {
      const tx = this.tx[slot];
      if (!tx || !tx.sender.track) continue;
      const p = tx.sender.getParameters();
      if (!p.encodings || !p.encodings.length) continue;   // ohne Verhandlung nichts zu setzen
      const enc = p.encodings[0];
      if (slot === 'cam') {
        enc.maxBitrate = mesh ? 500000 : 900000;
      } else {
        // Auflösung per Verkleinern im Encoder, nicht an der Aufnahme. Schaut
        // jemand am Handy zu, höchstens 1080p mit 30 Bildern pro Sekunde –
        // mehr können viele Handys nicht flüssig entschlüsseln.
        const mob = this.remoteState.mobile;
        const set = tx.sender.track.getSettings ? tx.sender.track.getSettings() : {};
        const w = set.width || 0;
        const h = set.height || 0;
        let capLong = q.w ? Math.max(q.w, q.h) : Infinity;
        let capShort = q.w ? Math.min(q.w, q.h) : Infinity;
        if (mob) { capLong = Math.min(capLong, MOBILE_CAP.long); capShort = Math.min(capShort, MOBILE_CAP.short); }
        const scale = w && h ? Math.max(1, Math.max(w, h) / capLong, Math.min(w, h) / capShort) : 1;
        enc.scaleResolutionDownBy = Math.round(scale * 1000) / 1000;
        enc.maxFramerate = mob ? Math.min(q.fps, MOBILE_CAP.fps) : q.fps;
        enc.maxBitrate = Math.min(mesh ? q.mesh : q.rate, mob ? MOBILE_CAP.rate : Infinity);
      }
      tx.sender.setParameters(p).catch(() => {});
    }
  }

  changed() {
    if (this.opts.onChange) this.opts.onChange(this);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { if (this.dc.readyState === 'open') this.dc.send(JSON.stringify({ t: 'bye' })); } catch (e) { /* egal */ }
    try { this.pc.close(); } catch (e) { /* egal */ }
    detachAudio(this);
  }
}

/* ==========================================================================
   Direktanruf
   ========================================================================== */
function callPeerOpts(call, initiator) {
  return {
    initiator: initiator,
    mesh: false,
    onChange: (p) => {
      if (S.call !== call) return;
      if (p.pc.connectionState === 'connected' && call.state !== 'active') {
        call.state = 'active';
        call.started = Date.now();
        stopTones();
        renderAll();
        return;
      }
      if (p.pc.connectionState === 'failed' && !initiator) {
        call.failTimer = call.failTimer || setTimeout(() => { if (S.call === call && p.pc.connectionState === 'failed') endCall('Verbindung abgebrochen.'); }, 20000);
      }
      renderStage();
      renderVoicebar();
    },
    onBye: () => { if (S.call === call) endCall('Aufgelegt.', true); },
    onRestart: async (p) => {
      try {
        const sdp = await p.restartOffer();
        await sendSignal(call.peerId, { t: 'reoffer', call: call.id, sdp: sdp });
      } catch (e) { /* nächster Versuch beim nächsten Fehler */ }
    }
  };
}

async function startCall(peerId, video) {
  if (S.call || S.voice) { toast('Du bist schon in einem Gespräch.', 'error'); return; }
  const ident = S.ids.get(peerId);
  if (!ident) return;
  if (ident.changed) { toast('Erst den geänderten Schlüssel prüfen.', 'error'); return; }
  if (isBlocked(ident)) { toast('Diese Person ist blockiert.', 'error'); return; }
  if (inMeetingMode() || ident.guest) { toast(S.meetOnly && !ident.guest ? 'Hier gibt es nur den Call des Meetings.' : 'Gäste telefonieren nur im Call des Meetings.', 'error'); return; }
  audioCtx();
  if (!(await relayReady()) || S.call || S.voice) return;
  const call = S.call = { id: C.randomId(), peerId: peerId, dir: 'out', state: 'ringing', video: !!video, started: 0, peer: null, bye: null };
  if (!(S.view.kind === 'dm' && S.view.peer === peerId)) openDm(peerId);
  renderAll();
  try {
    await ensureMic();
    if (video && !M.cam) await toggleCam();
    call.peer = new Peer(peerId, callPeerOpts(call, true));
    const sdp = await call.peer.offer();
    if (S.call !== call) return;
    call.bye = await sealSignal(peerId, { t: 'end', call: call.id });
    await sendSignal(peerId, { t: 'call', call: call.id, video: !!video, sdp: sdp });
    playRingback();
    call.ringTimer = setTimeout(() => {
      if (S.call === call && call.state === 'ringing') {
        sendSignal(peerId, { t: 'cancel', call: call.id }).catch(() => {});
        endCall('Niemand hat abgenommen.', true);
      }
    }, 45000);
  } catch (e) {
    if (S.call === call) endCall('Anruf ging nicht: ' + e.message, true);
  }
}

function showIncoming(call) {
  const ident = S.ids.get(call.peerId);
  openModal({
    title: call.video ? 'VIDEOANRUF' : 'ANRUF',
    focus: false,
    onClose: () => { if (S.call === call && call.state === 'incoming') declineCall(); },
    build: (body) => {
      body.append(el('div', { class: 'sc-incoming' },
        el('span', { class: 'sc-incoming-av', dataset: { speak: '' } }, avatar(ident, 'lg')),
        el('h2', { text: displayName(ident) }),
        el('p', { class: 'sc-mono', text: C.shortFingerprint(ident.fp) }),
        el('p', { class: 'sc-note', text: isVerified(ident) ? 'Verifizierter Kontakt.' : 'Nicht verifiziert – im Gespräch könnt ihr den Sicherheitscode vergleichen.' })));
    },
    actions: [
      { label: 'Ablehnen', danger: true, onClick: (close) => { close(); } },
      { label: 'Nur Ton', onClick: (close) => { call.state = 'accepting'; close(); acceptCall(false); } },
      { label: call.video ? 'Mit Video' : 'Annehmen', primary: true, onClick: (close) => { call.state = 'accepting'; close(); acceptCall(call.video); } }
    ]
  });
}

async function acceptCall(video) {
  const call = S.call;
  if (!call) return;
  stopTones();
  audioCtx();
  call.state = 'connecting';
  openDm(call.peerId);
  // Ohne Relay nicht annehmen, solange die IP verborgen bleiben soll.
  if (!(await relayReady())) { if (S.call === call) declineCall(); return; }
  try {
    await ensureMic();
    if (video && !M.cam) await toggleCam();
    call.peer = new Peer(call.peerId, callPeerOpts(call, false));
    const sdp = await call.peer.answer(call.offer);
    if (S.call !== call) return;
    await sendSignal(call.peerId, { t: 'answer', call: call.id, sdp: sdp });
    call.bye = await sealSignal(call.peerId, { t: 'end', call: call.id });
    // Andere eigene Geräte hören auf zu klingeln.
    sendSignal(S.me.id, { t: 'handled', call: call.id }).catch(() => {});
  } catch (e) {
    endCall('Annehmen ging nicht: ' + e.message);
  }
  renderAll();
}

function declineCall() {
  const call = S.call;
  if (!call || call.dir !== 'in') return;
  sendSignal(call.peerId, { t: 'decline', call: call.id }).catch(() => {});
  sendSignal(S.me.id, { t: 'handled', call: call.id }).catch(() => {});
  logCall(call, 'Anruf abgelehnt');
  S.call = null;
  stopTones();
  closeModal();
  renderAll();
}

function endCall(reason, remote) {
  const call = S.call;
  if (!call) return;
  S.call = null;
  clearTimeout(call.ringTimer);
  clearTimeout(call.failTimer);
  if (!remote && call.peer) sendSignal(call.peerId, { t: 'end', call: call.id }).catch(() => {});
  if (call.peer) call.peer.close();
  stopTones();
  if (!S.voice) stopLocalMedia();
  if (call.state === 'incoming') closeModal();
  const dur = call.started ? fmtDuration(Date.now() - call.started) : null;
  logCall(call, dur ? 'Anruf beendet · Dauer ' + dur : (reason || 'Anruf beendet'));
  if (dur) toast('Anruf beendet · Dauer ' + dur, 'ok');
  else if (reason) toast(reason);
  renderAll();
}

function logCall(call, text) {
  const conv = convOf(call.peerId);
  const m = { id: 'call-' + call.id, sys: text, icon: 'phone', ts: Date.now(), from: '' };
  if (conv.byId.has(m.id)) return;
  insertSorted(conv.msgs, m);
  conv.byId.set(m.id, m);
  conv.last = Math.max(conv.last, m.ts);
}

async function handleSignal(obj, from, e) {
  const age = Date.now() - e.t * 1000;
  const call = S.call;
  switch (obj.t) {
    case 'typing': {
      if (serverNow() - e.t * 1000 > 10000) return;   // kam an, während man weg war
      const conv = convOf(from.id);
      conv.typingUntil = Date.now() + 6000;
      renderTyping();
      setTimeout(renderTyping, 6200);
      return;
    }
    case 'call': {
      if (from.id === S.me.id || age > 45000) return;
      // Unbekannt oder offene Anfrage, und Anrufe von Unbekannten sind aus: still
      // als Anfrage vermerken – auch kein „besetzt“, das verriete, dass du da bist.
      if ((isRequest(from.id) || !knownPeer(from.id)) && !unknownCallsAllowed()) {
        if (typeof obj.sdp === 'string') noteRequestCall(from, e.t * 1000, obj);
        return;
      }
      if (call || S.voice) {
        if (!call || call.id !== obj.call) sendSignal(from.id, { t: 'busy', call: obj.call }).catch(() => {});
        return;
      }
      if (typeof obj.sdp !== 'string') return;
      noteContact(from);
      S.call = { id: String(obj.call), peerId: from.id, dir: 'in', state: 'incoming', video: !!obj.video, offer: obj.sdp, started: 0, peer: null };
      S.call.ringTimer = setTimeout(() => {
        if (S.call && S.call.id === obj.call && S.call.state === 'incoming') {
          logCall(S.call, 'Verpasster Anruf');
          S.call = null;
          stopTones();
          closeModal();
          renderAll();
        }
      }, 45000);
      playRing();
      showIncoming(S.call);
      notify('Anruf', displayName(from) + (obj.video ? ' ruft per Video an' : ' ruft an'), 'call');
      if (DESKTOP) DESKTOP.attention();
      fastPoll(45000);
      renderAll();
      return;
    }
    case 'handled':
      if (from.id === S.me.id && call && call.id === obj.call && call.state === 'incoming') {
        clearTimeout(call.ringTimer);
        S.call = null;
        stopTones();
        closeModal();
        renderAll();
      }
      return;
  }
  if (!call || call.id !== obj.call || call.peerId !== from.id) return;
  switch (obj.t) {
    case 'answer':
      if (call.dir === 'out' && call.state === 'ringing' && typeof obj.sdp === 'string') {
        call.state = 'connecting';
        clearTimeout(call.ringTimer);
        stopTones();
        try { await call.peer.accept(obj.sdp); } catch (err) { endCall('Verbindung ging nicht.'); }
        renderAll();
      }
      break;
    case 'decline': endCall('Abgelehnt.', true); break;
    case 'busy': endCall('Besetzt.', true); break;
    case 'cancel':
      if (call.state === 'incoming') {
        clearTimeout(call.ringTimer);
        logCall(call, 'Verpasster Anruf');
        S.call = null;
        stopTones();
        closeModal();
        renderAll();
      }
      break;
    case 'end': endCall('Aufgelegt.', true); break;
    case 'reoffer':
      if (call.peer && typeof obj.sdp === 'string') {
        try {
          const sdp = await call.peer.restartAnswer(obj.sdp);
          await sendSignal(call.peerId, { t: 'reanswer', call: call.id, sdp: sdp });
        } catch (err) { /* nächster Versuch */ }
      }
      break;
    case 'reanswer':
      if (call.peer && typeof obj.sdp === 'string') {
        try { await call.peer.accept(obj.sdp); } catch (err) { /* nächster Versuch */ }
      }
      break;
  }
}

/* ==========================================================================
   Sprachkanal im Raum: jeder mit jedem (bis zu 8 Personen)
   --------------------------------------------------------------------------
   Wer die kleinere Kennung hat, ruft an – so gibt es nie zwei Anrufe
   gleichzeitig zwischen denselben beiden.
   ========================================================================== */
/** Sprachkanal betreten; ohne ch den ersten des Raums. Wechselt aus einem anderen Kanal. */
async function joinVoice(rid, ch) {
  if (S.call) { toast('Beende zuerst den Anruf.', 'error'); return; }
  const room = S.rooms.get(rid);
  if (!room) return;
  const chan = typeof ch === 'string' ? ch : room.meta.vch[0].id;
  if (S.voice && S.voice.rid === rid && S.voice.ch === chan) return;
  if (rolesOk(room) && !canEnterVoice(room, S.me.id, chan)) {
    const w = room.vw[chan];
    toast(w ? 'Diesen Sprachkanal betreten ' + channelWho(room, w) + '.' : 'Du darfst in diesem Raum keine Sprachkanäle betreten.', 'error');
    return;
  }
  if (S.voice) await leaveVoice(S.voice.rid === rid);
  if (!roomKeyRaw(rid, room.epoch)) { toast('Der aktuelle Raumschlüssel fehlt noch.', 'error'); return; }
  audioCtx();
  if (!(await relayReady())) return;
  S.joiningVoice = rid;   // gibt der Raum die Sprachqualität vor, gilt sie schon fürs Mikrofon
  try {
    await ensureMic();
    const r = await api('room.voice', { id: rid, on: true, ch: chan });
    setVoiceState(room, r.vcs, r.vc);
    S.voice = { rid: rid, ch: chan, peers: new Map(), since: Date.now() };
    reconcileVoice();
    fastPoll(20000);
    playJoinTone(true);
    if (!(S.view.kind === 'room' && S.view.rid === rid)) openRoom(rid);
  } catch (e) {
    toast(e.message, 'error');
    if (!S.call) stopLocalMedia();
  }
  S.joiningVoice = null;
  renderAll();
}

async function leaveVoice(silent) {
  const v = S.voice;
  if (!v) return;
  S.voice = null;
  for (const p of v.peers.values()) p.close();
  const room = S.rooms.get(v.rid);
  if (room) {
    const left = {};
    for (const ch of Object.keys(room.vcs)) left[ch] = room.vcs[ch].filter((id) => id !== S.me.id);
    setVoiceState(room, left);
  }
  if (!S.call) stopLocalMedia();
  if (!silent) {
    playJoinTone(false);
    toast('Sprachkanal verlassen · Dauer ' + fmtDuration(Date.now() - v.since), 'ok');
  }
  renderAll();
  try { await api('room.voice', { id: v.rid, on: false, ch: v.ch }); } catch (e) { /* läuft ohnehin ab */ }
}

function voicePeerOpts(rid, initiator) {
  return {
    initiator: initiator,
    mesh: true,
    onChange: () => { renderStage(); renderSideSoon(); renderVoicebar(); },
    onBye: (p) => {
      if (!S.voice || S.voice.rid !== rid) return;
      p.close();
      S.voice.peers.delete(p.remoteId);
      renderAll();
    },
    onRestart: async (p) => {
      try {
        const room = S.rooms.get(rid);
        const sdp = await p.restartOffer();
        await postRoomSignal(room, p.remoteId, { t: 'rtc', kind: 'offer', restart: true, ch: S.voice ? S.voice.ch : '', sdp: sdp });
      } catch (e) { /* nächster Versuch */ }
    }
  };
}

let sideSoon = 0;
function renderSideSoon() {
  if (sideSoon) return;
  sideSoon = setTimeout(() => { sideSoon = 0; renderSide(); }, 300);
}

async function postRoomSignal(room, toId, obj) {
  const key = await roomKey(room.id, room.epoch);
  if (!key) throw new Error('Raumschlüssel fehlt');
  const msg = Object.assign({ v: 1, from: S.me.id, to: toId, room: room.id, ts: Date.now() }, obj);
  const d = await C.sealRoom(msg, key, room.epoch, room.id, S.me.priv);
  await api('room.post', { id: room.id, k: 'sig', to: toId, d: d });
  fastPoll(15000);
}

function reconcileVoice() {
  const v = S.voice;
  if (!v) return;
  const room = S.rooms.get(v.rid);
  if (!room) { leaveVoice(true); return; }
  const present = new Set(voiceMembers(room, v.ch));
  if (!present.has(S.me.id) && Date.now() - v.since > 5000) {
    // Der Server hat uns vergessen (zu lange kein Abruf): wieder melden.
    api('room.voice', { id: v.rid, on: true, ch: v.ch }).then((r) => setVoiceState(room, r.vcs, r.vc)).catch(() => {});
  }
  for (const id of present) {
    if (id === S.me.id) continue;
    let p = v.peers.get(id);
    if (p && p.initiator && p.pc.connectionState !== 'connected' && !p.remoteSdp && Date.now() - p.created > 20000) {
      p.close();
      v.peers.delete(id);
      p = null;
    }
    if (!p && S.me.id < id) startVoicePeer(room, id);
  }
  for (const [id, p] of v.peers) {
    if (present.has(id)) { p.gone = 0; continue; }
    p.gone = p.gone || Date.now();
    if (Date.now() - p.gone > 8000) { p.close(); v.peers.delete(id); }
  }
  renderStage();
}

async function startVoicePeer(room, id) {
  const v = S.voice;
  const ident = (await ensureIds([id]))[0];
  if (!ident || S.voice !== v || v.peers.has(id)) return;
  const p = new Peer(id, voicePeerOpts(room.id, true));
  v.peers.set(id, p);
  try {
    const sdp = await p.offer();
    if (S.voice !== v || p.closed) return;
    await postRoomSignal(room, id, { t: 'rtc', kind: 'offer', ch: v.ch, sdp: sdp });
  } catch (e) {
    p.close();
    v.peers.delete(id);
  }
}

async function roomSignal(room, obj, from, e) {
  const v = S.voice;
  if (!v || v.rid !== room.id || obj.t !== 'rtc' || obj.to !== S.me.id || from.id === S.me.id) return;
  // Nur Verbindungen im selben Sprachkanal (ältere Fassungen kennen nur den ersten).
  if ((typeof obj.ch === 'string' ? obj.ch : '') !== v.ch) return;
  if (Date.now() - e.t * 1000 > 60000 || typeof obj.sdp !== 'string') return;
  let p = v.peers.get(from.id);
  try {
    if (obj.kind === 'offer') {
      if (p && !obj.restart) { p.close(); v.peers.delete(from.id); p = null; }
      if (!p) { p = new Peer(from.id, voicePeerOpts(room.id, false)); v.peers.set(from.id, p); }
      const sdp = obj.restart ? await p.restartAnswer(obj.sdp) : await p.answer(obj.sdp);
      await postRoomSignal(room, from.id, { t: 'rtc', kind: 'answer', restart: !!obj.restart, ch: v.ch, sdp: sdp });
    } else if (obj.kind === 'answer' && p) {
      await p.accept(obj.sdp);
    }
  } catch (err) {
    if (p && !obj.restart) { p.close(); v.peers.delete(from.id); }
  }
  renderAll();
}

/* ==========================================================================
   Bühne: Kacheln für Personen und geteilte Bildschirme
   ========================================================================== */
const tiles = new Map();   // Schlüssel -> Kachel (bleibt bestehen, damit Videos nicht neu starten)
let focusKey = null;

function stagePeople() {
  if (S.call && S.view.kind === 'dm' && S.view.peer === S.call.peerId) {
    return { kind: 'call', peers: S.call.peer ? [S.call.peer] : [], waiting: S.call.peer ? [] : [S.call.peerId] };
  }
  if (S.voice && S.view.kind === 'room' && S.view.rid === S.voice.rid) {
    const room = S.rooms.get(S.voice.rid);
    const waiting = room ? voiceMembers(room, S.voice.ch).filter((id) => id !== S.me.id && !S.voice.peers.has(id)) : [];
    return { kind: 'voice', peers: [...S.voice.peers.values()], waiting: waiting };
  }
  return null;
}

function renderStage() {
  const stage = $('sc-stage');
  const people = stagePeople();
  if (!people) {
    stage.hidden = true;
    for (const t of tiles.values()) detachTile(t);
    tiles.clear();
    stage.textContent = '';
    return;
  }
  stage.hidden = false;
  if (!stage.firstChild) {
    stage.append(el('div', { class: 'sc-stage-top', id: 'sc-stage-top' }), el('div', { class: 'sc-tiles', id: 'sc-tiles' }), el('div', { class: 'sc-controls', id: 'sc-controls' }));
  }
  const top = $('sc-stage-top');
  top.textContent = '';
  const want = [];

  // Eigene Kacheln
  want.push({ key: 'me:cam', ident: S.ids.get(S.me.id), track: M.cam, video: !!M.cam, self: true, back: M.camBack, muted: !(M.micOn && !M.deaf), speak: S.me.id });
  if (M.screen) want.push({ key: 'me:screen', ident: S.ids.get(S.me.id), track: M.screen, video: true, screen: true, self: true, label: 'Dein Bildschirm' });

  for (const p of people.peers) {
    const ident = S.ids.get(p.remoteId);
    const conn = p.failed && p.pc.connectionState !== 'connected' ? 'nodirect' : p.pc.connectionState;
    want.push({
      key: p.remoteId + ':cam', ident: ident, stream: p.remote.cam, video: p.remoteState.cam && !!p.remote.cam,
      muted: !p.remoteState.mic, speak: p.remoteId, conn: conn, code: p.code, peer: p
    });
    if (p.remoteState.screen && p.remote.screen) {
      const hidden = S.hiddenScreens.has(p.remoteId);
      want.push({ key: p.remoteId + ':screen', ident: ident, stream: hidden ? null : p.remote.screen, video: !hidden, screen: true, peer: p,
        hiddenScreen: hidden, label: 'Bildschirm von ' + displayName(ident) + (hidden ? ' · ausgeblendet' : '') });
    }
  }
  ensureStats();
  for (const id of people.waiting) {
    const conn = people.kind === 'call' ? (S.call.state === 'incoming' ? 'eingehend' : 'klingelt') : 'connecting';
    want.push({ key: id + ':cam', ident: S.ids.get(id), video: false, conn: conn });
  }

  // Kopfzeile: Zustand und Sicherheitscode
  if (people.kind === 'call') {
    const call = S.call;
    const state = call.state === 'active' ? fmtDuration(Date.now() - call.started)
      : call.state === 'ringing' ? 'Klingelt …' : call.state === 'incoming' ? 'Eingehender Anruf' : 'Verbindet …';
    const code = call.peer && call.peer.code;
    top.append(el('span', { class: 'sc-stage-state', id: 'sc-call-timer', text: state }),
      el('span', { class: 'sc-stage-right' }, netQualityBadge(),
        el('button', { type: 'button', class: 'sc-code', title: 'Sicherheitscode vergleichen', onclick: showCodeInfo },
          icon('lock', 13), code ? 'Ende-zu-Ende verschlüsselt · Code ' + code : 'Ende-zu-Ende verschlüsselt')));
  } else {
    const room = S.rooms.get(S.voice.rid);
    const meet = !!(room && room.meta.meet);
    top.append(el('span', { class: 'sc-stage-state', text: meet ? room.meta.name + ' · Call · ' + (S.voice.peers.size + 1) + ' Personen' : (room ? room.meta.name : '') + ' · Sprache' }),
      el('span', { class: 'sc-stage-right' }, netQualityBadge(),
        meet && canShareLink(room) ? el('button', { type: 'button', class: 'sc-code', title: 'Meeting-Link teilen', onclick: () => meetingDialog(room) }, icon('link', 13), 'Link teilen') : null,
        el('button', { type: 'button', class: 'sc-code', title: 'Sicherheitscodes vergleichen', onclick: showCodeInfo },
          icon('lock', 13), 'Ende-zu-Ende verschlüsselt · Codes an den Kacheln')));
  }

  const grid = $('sc-tiles');
  const keys = new Set(want.map((w) => w.key));
  for (const [key, t] of tiles) {
    if (!keys.has(key)) { detachTile(t); t.node.remove(); tiles.delete(key); }
  }
  if (focusKey && !keys.has(focusKey)) focusKey = null;
  if (!focusKey) {
    const sc = want.find((w) => w.screen && !w.self);
    if (sc) focusKey = sc.key;
  }
  grid.classList.toggle('has-focus', !!focusKey);
  stage.classList.toggle('has-focus', !!focusKey);
  grid.dataset.count = String(want.length);
  // Mit Mittelpunkt: die übrigen Kacheln in eine Leiste daneben (Handy: darunter).
  let side = grid.querySelector(':scope > .sc-tiles-side');
  if (focusKey && !side) side = el('div', { class: 'sc-tiles-side' });
  for (const w of want) {
    let t = tiles.get(w.key);
    if (!t) {
      t = makeTile(w.key);
      tiles.set(w.key, t);
    }
    updateTile(t, w);
    const box = focusKey && w.key !== focusKey ? side : grid;
    if (t.node.parentNode !== box || box.lastElementChild !== t.node) box.appendChild(t.node);
  }
  if (side) {
    if (focusKey && side.firstChild) { if (grid.lastElementChild !== side) grid.appendChild(side); } else side.remove();
  }
  renderControls();
}

/**
 * Vollbild für ein Video. Handys: wenn möglich quer drehen (Bildschirme sind
 * meist breiter als hoch); iPhones kennen nur das eigene Vollbild für Videos.
 */
function fullscreenVideo(video) {
  if (video.requestFullscreen) {
    video.requestFullscreen().then(() => {
      if (video.videoWidth > video.videoHeight && screen.orientation && screen.orientation.lock) {
        screen.orientation.lock('landscape').catch(() => { /* Desktop: geht nicht, egal */ });
      }
    }, () => {});
  } else if (video.webkitEnterFullscreen) {
    try { video.webkitEnterFullscreen(); } catch (e) { /* nicht möglich */ }
  }
}

/**
 * Vollbild für die ganze Kachel – so gehen Zoom, Rädchen und Ausblenden auch
 * dort. iPhones kennen nur das eigene Vollbild für Videos (ohne Zoom).
 */
function fullscreenTile(t) {
  if (document.fullscreenElement === t.node) { document.exitFullscreen().catch(() => {}); return; }
  if (t.node.requestFullscreen) {
    t.node.requestFullscreen().then(() => {
      const v = t.video;
      if (v.videoWidth > v.videoHeight && screen.orientation && screen.orientation.lock) {
        screen.orientation.lock('landscape').catch(() => { /* Desktop: geht nicht, egal */ });
      }
    }, () => fullscreenVideo(t.video));
  } else {
    fullscreenVideo(t.video);
  }
}

/* ---------- Zoom in eine Übertragung ---------------------------------------
   Mausrad (im Mittelpunkt oder Vollbild), Ziehen zum Verschieben, zwei
   Finger zum Zoomen, Doppelklick: hinein oder zurück. Bis zehnfach. */
const ZOOM_MAX = 10;

function zoomable(t) {
  return t.node.classList.contains('is-screen') && t.node.classList.contains('has-video')
    && (t.node.classList.contains('is-focus') || document.fullscreenElement === t.node);
}

function applyZoom(t) {
  const z = t.zoom;
  t.video.style.transform = z.s > 1 ? 'translate(' + z.x + 'px,' + z.y + 'px) scale(' + z.s + ')' : '';
  t.frame.classList.toggle('is-zoomed', z.s > 1);
  t.zoomBox.hidden = z.s <= 1;
  t.zoomLabel.textContent = Math.round(z.s * 100) + ' %';
}

/** Zoomen um einen Punkt (Bildschirmkoordinaten), der dabei an Ort und Stelle bleibt. */
function zoomAt(t, factor, cx, cy) {
  const r = t.frame.getBoundingClientRect();
  const z = t.zoom;
  const s = Math.min(ZOOM_MAX, Math.max(1, z.s * factor));
  const px = cx - r.left;
  const py = cy - r.top;
  z.x = px - (px - z.x) * (s / z.s);
  z.y = py - (py - z.y) * (s / z.s);
  z.s = s;
  clampZoom(t, r);
  applyZoom(t);
}

function panBy(t, dx, dy) {
  t.zoom.x += dx;
  t.zoom.y += dy;
  clampZoom(t, t.frame.getBoundingClientRect());
  applyZoom(t);
}

function clampZoom(t, r) {
  const z = t.zoom;
  if (z.s <= 1) { z.s = 1; z.x = 0; z.y = 0; return; }
  z.x = Math.min(0, Math.max(r.width - r.width * z.s, z.x));
  z.y = Math.min(0, Math.max(r.height - r.height * z.s, z.y));
}

function resetZoom(t) {
  t.zoom = { s: 1, x: 0, y: 0 };
  applyZoom(t);
}

function wireZoom(t) {
  const f = t.frame;
  const pts = new Map();
  let pinch = null;
  let moved = 0;
  f.addEventListener('wheel', (ev) => {
    if (!zoomable(t)) return;
    ev.preventDefault();
    zoomAt(t, Math.exp(-ev.deltaY * (ev.deltaMode === 1 ? 0.05 : 0.0015)), ev.clientX, ev.clientY);
  }, { passive: false });
  f.addEventListener('dblclick', (ev) => {
    if (!zoomable(t) || ev.target.closest('button')) return;
    ev.preventDefault();
    if (t.zoom.s > 1) resetZoom(t); else zoomAt(t, 2.5, ev.clientX, ev.clientY);
  });
  f.addEventListener('pointerdown', (ev) => {
    if (!zoomable(t) || ev.target.closest('button') || ev.target.closest('.sc-tile-stats')) return;
    pts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    moved = 0;
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    }
    try { f.setPointerCapture(ev.pointerId); } catch (e) { /* egal */ }
  });
  f.addEventListener('pointermove', (ev) => {
    const prev = pts.get(ev.pointerId);
    if (!prev) return;
    const cur = { x: ev.clientX, y: ev.clientY };
    pts.set(ev.pointerId, cur);
    if (pts.size >= 2 && pinch) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      if (pinch.d > 0) zoomAt(t, d / pinch.d, mx, my);
      panBy(t, mx - pinch.mx, my - pinch.my);
      pinch = { d: d, mx: mx, my: my };
      moved += 10;
    } else if (t.zoom.s > 1) {
      panBy(t, cur.x - prev.x, cur.y - prev.y);
      moved += Math.abs(cur.x - prev.x) + Math.abs(cur.y - prev.y);
    }
  });
  const end = (ev) => {
    pts.delete(ev.pointerId);
    if (pts.size < 2) pinch = null;
    if (moved > 4) t.dragged = Date.now();   // danach keinen Klick auslösen
  };
  f.addEventListener('pointerup', end);
  f.addEventListener('pointercancel', end);
}

function toggleHideScreen(peerId) {
  if (S.hiddenScreens.has(peerId)) S.hiddenScreens.delete(peerId);
  else S.hiddenScreens.add(peerId);
  const p = activePeers().find((x) => x.remoteId === peerId);
  if (p) p.sendState();   // der Sender schickt dann nichts mehr an uns
  renderStage();
}

/**
 * Kachel: außen der Platz im Raster, innen ein Rahmen. Bei Bildschirmen hat
 * der Rahmen das Seitenverhältnis der Übertragung – so gibt es keine
 * schwarzen Ränder, und Name und Vollbild-Knopf sitzen auf dem Bild.
 */
function makeTile(key) {
  const video = el('video', { autoplay: true, playsinline: true, muted: true });
  video.muted = true;
  const node = el('div', { class: 'sc-tile', dataset: { key: key } });
  const frame = el('div', { class: 'sc-tile-frame' });
  const face = el('div', { class: 'sc-tile-face' });
  const label = el('div', { class: 'sc-tile-label' });
  const t = { key: key, node: node, frame: frame, video: video, face: face, label: label, src: null, w: null,
    zoom: { s: 1, x: 0, y: 0 }, statsOpen: false, dragged: 0 };
  // Oben rechts auf Bildschirm-Kacheln: Werte (Rädchen), Ausblenden, Vollbild.
  t.tools = el('div', { class: 'sc-tile-tools' },
    iconBtn('settings', 'Übertragungsqualität', () => { t.statsOpen = !t.statsOpen; renderTileStats(t); }, { class: 'sc-ibtn sc-tile-gear' }),
    t.hideBtn = iconBtn('eyeOff', 'Übertragung ausblenden', () => { if (t.w && t.w.peer) toggleHideScreen(t.w.peer.remoteId); }, { class: 'sc-ibtn sc-tile-hide' }),
    iconBtn('expand', 'Vollbild', () => fullscreenTile(t), { class: 'sc-ibtn sc-tile-full' }));
  t.panel = el('div', { class: 'sc-tile-stats', hidden: true });
  t.zoomLabel = el('span', { text: '100 %' });
  t.zoomBox = el('div', { class: 'sc-tile-zoom', hidden: true }, t.zoomLabel,
    el('button', { type: 'button', class: 'sc-tile-zoom-reset', title: 'Zoom zurücksetzen', onclick: () => resetZoom(t) }, icon('x', 12)));
  frame.append(video, label, t.tools, t.panel, t.zoomBox);
  node.append(frame, face);
  const ratio = () => {
    if (video.videoWidth && video.videoHeight) node.style.setProperty('--ar', String(video.videoWidth / video.videoHeight));
  };
  video.addEventListener('loadedmetadata', ratio);
  video.addEventListener('resize', ratio);
  wireZoom(t);
  node.addEventListener('click', (ev) => {
    if (ev.target.closest('button') || ev.target.closest('.sc-tile-stats')) return;
    if (Date.now() - t.dragged < 400) return;   // war ein Verschieben, kein Klick
    // Die Übertragung im Mittelpunkt bleibt dort (Doppelklick zoomt, Vollbild per Knopf).
    if (node.classList.contains('is-screen') && node.classList.contains('has-video') && focusKey === key) return;
    focusKey = focusKey === key ? null : key;
    resetZoom(t);
    renderStage();
  });
  return t;
}

function updateTile(t, w) {
  t.w = w;
  t.node.className = 'sc-tile' + (w.screen ? ' is-screen' : '') + (w.video ? ' has-video' : '') + (focusKey === t.key ? ' is-focus' : '') + (w.self ? ' is-self' : '')
    + (w.conn && w.conn !== 'connected' ? ' is-waiting' : '') + (w.hiddenScreen ? ' is-hidden-screen' : '');
  if (w.speak) t.node.dataset.speak = w.speak; else delete t.node.dataset.speak;
  const src = w.video ? (w.track || w.stream || null) : null;
  if (src !== t.src) {
    t.src = src;
    t.video.srcObject = src ? (src instanceof MediaStream ? src : new MediaStream([src])) : null;
    if (src) t.video.play().catch(() => {});
    resetZoom(t);
  }
  if (!zoomable(t) && t.zoom.s > 1) resetZoom(t);
  // Spiegeln wie ein Spiegel – nur die Kamera, die zu einem zeigt, nicht die Rückkamera.
  t.video.classList.toggle('is-mirror', !!(w.self && !w.screen && !w.back));
  t.hideBtn.hidden = !w.screen || !!w.self;
  t.face.textContent = '';
  if (w.hiddenScreen) {
    t.face.append(el('p', { class: 'sc-tile-hidden-note', text: 'Übertragung ausgeblendet – du bekommst sie nicht, das spart Bandbreite.' }),
      el('button', { type: 'button', class: 'btn', onclick: () => toggleHideScreen(w.peer.remoteId) }, icon('eye', 14), 'Wieder anzeigen'));
  } else if (!w.video) t.face.appendChild(avatar(w.ident, 'xl'));
  if (t.statsOpen) renderTileStats(t);
  t.label.textContent = '';
  appendAll(t.label,
    w.muted ? icon('micOff', 13) : null,
    el('span', { text: w.label || (w.self ? displayName(w.ident) + ' (du)' : displayName(w.ident)) }),
    w.conn && w.conn !== 'connected' ? el('span', { class: 'sc-tile-conn', text: connText(w.conn) }) : null,
    w.code && S.voice ? el('span', { class: 'sc-tile-code', title: 'Sicherheitscode', text: w.code }) : null);
}

function connText(st) {
  return { new: 'verbindet …', connecting: 'verbindet …', disconnected: 'Verbindung wackelt …', failed: 'keine Verbindung', nodirect: S.cfg && S.cfg.relay ? 'keine Verbindung' : 'keine direkte Verbindung', closed: 'getrennt', klingelt: 'klingelt …', eingehend: 'ruft an …' }[st] || st;
}

function detachTile(t) {
  t.video.srcObject = null;
}

function renderControls() {
  const box = $('sc-controls');
  if (!box) return;
  const canScreen = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  // Nur bei Änderungen neu bauen – sonst flackert auf dem Handy der eben
  // getippte Knopf bei jedem Abruf.
  const canSwitch = !!M.cam && (M.camCount || 0) > 1;
  const sig = [M.micOn, M.deaf, !!M.cam, canSwitch, M.camBack, !!M.screen, canScreen, screenQuality().id, !!S.voice].join('|');
  if (box.dataset.sig === sig && box.firstChild) return;
  box.dataset.sig = sig;
  box.textContent = '';
  const ctl = (name, title, on, fn, extra) => el('button', {
    type: 'button', class: 'sc-ctl' + (on ? '' : ' is-off') + (extra ? ' ' + extra : ''), title: title, 'aria-label': title, onclick: fn
  }, icon(name, 20));
  const q = screenQuality();
  appendAll(box,
    ctl(M.micOn ? 'mic' : 'micOff', M.micOn ? 'Stummschalten' : 'Mikrofon an', M.micOn && !M.deaf, toggleMic),
    ctl(M.cam ? 'video' : 'videoOff', M.cam ? 'Kamera aus' : 'Kamera an', !!M.cam, toggleCam),
    canSwitch ? ctl('camSwitch', IS_MOBILE ? (M.camBack ? 'Zur Frontkamera wechseln' : 'Zur Rückkamera wechseln') : 'Kamera wechseln', true, switchCamera, 'sc-ctl--switch') : null,
    canScreen ? ctl(M.screen ? 'screen' : 'screenOff', M.screen ? 'Teilen beenden' : 'Bildschirm teilen', !!M.screen, toggleScreen) : null,
    canScreen && M.screen ? ctl('sliders', 'Qualität: ' + q.name + ' (' + q.info + ')', true, showScreenQuality) : null,
    ctl(M.deaf ? 'headOff' : 'head', M.deaf ? 'Ton an' : 'Nichts hören', !M.deaf, toggleDeaf),
    ctl('hangup', S.voice ? (S.rooms.get(S.voice.rid) && S.rooms.get(S.voice.rid).meta.meet ? 'Call verlassen' : 'Sprachkanal verlassen') : 'Auflegen', true, () => (S.voice ? leaveVoice() : endCall()), 'sc-ctl--hangup'));
}

setInterval(() => {
  const t = $('sc-call-timer');
  if (t && S.call && S.call.state === 'active') t.textContent = fmtDuration(Date.now() - S.call.started);
}, 1000);

/* ==========================================================================
   Verbindungsqualität und Stream-Werte
   Alle zwei Sekunden getStats() je Verbindung: Ping, Paketverlust, Weg
   (direkt oder Relay), für Bildschirm und Kamera Auflösung, Bilder pro
   Sekunde, Datenrate und Codec. Daraus „Verbindung gut/mittel/schlecht“
   oben rechts und das Panel hinter dem Rädchen auf Bildschirm-Kacheln.
   ========================================================================== */
const NETQ = {
  good: { label: 'gut', bars: 3 },
  fair: { label: 'mittel', bars: 2 },
  poor: { label: 'schlecht', bars: 1 }
};
const NETQ_ORDER = ['good', 'fair', 'poor'];
let statsTimer = 0;

function ensureStats() {
  if (statsTimer) return;
  statsTimer = setInterval(async () => {
    const peers = activePeers();
    if (!peers.length) { clearInterval(statsTimer); statsTimer = 0; return; }
    await Promise.all(peers.map(readStats));
    refreshStatsUi();
  }, 2000);
}

function codecName(report, id) {
  const c = id && report.get(id);
  return c && c.mimeType ? c.mimeType.split('/')[1] : '';
}

async function readStats(p) {
  if (p.closed || !p.pc || p.pc.connectionState === 'closed') return;
  let report;
  try { report = await p.pc.getStats(); } catch (e) { return; }
  const now = performance.now();
  const prev = p.statsRaw || {};
  const raw = { t: now };
  const dt = prev.t ? (now - prev.t) / 1000 : 0;
  // Welche Messung gehört zu welchem Platz (Ton, Kamera, Bildschirm …)?
  const bySlot = {};
  p.pc.getTransceivers().forEach((tr, i) => {
    const slot = SLOTS[i];
    if (!slot) return;
    if (tr.mid != null) bySlot['mid:' + tr.mid] = slot;
    if (tr.receiver && tr.receiver.track) bySlot['in:' + tr.receiver.track.id] = slot;
    if (tr.sender && tr.sender.track) bySlot['out:' + tr.sender.track.id] = slot;
  });
  const sources = {};
  report.forEach((s) => { if (s.type === 'media-source') sources[s.id] = s; });
  const outSlot = (s) => {
    const src = s.mediaSourceId ? sources[s.mediaSourceId] : null;
    return bySlot['mid:' + s.mid] || (src ? bySlot['out:' + src.trackIdentifier] : null);
  };

  const st = { rtt: null, relay: false, loss: 0, in: {}, out: {} };
  let pair = null;
  report.forEach((s) => { if (s.type === 'transport' && s.selectedCandidatePairId) pair = report.get(s.selectedCandidatePairId); });
  if (!pair) report.forEach((s) => { if (!pair && s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s; });
  if (pair) {
    if (typeof pair.currentRoundTripTime === 'number') st.rtt = Math.round(pair.currentRoundTripTime * 1000);
    st.relay = [report.get(pair.localCandidateId), report.get(pair.remoteCandidateId)].some((c) => c && c.candidateType === 'relay');
  }
  report.forEach((s) => {
    if (s.type === 'inbound-rtp') {
      const slot = bySlot['mid:' + s.mid] || bySlot['in:' + s.trackIdentifier];
      if (!slot) return;
      const cur = { b: s.bytesReceived || 0, rcv: s.packetsReceived || 0, lost: Math.max(0, s.packetsLost || 0) };
      raw['in:' + slot] = cur;
      const pv = prev['in:' + slot];
      const dr = pv ? cur.rcv - pv.rcv : 0;
      const dl = pv ? Math.max(0, cur.lost - pv.lost) : 0;
      st.in[slot] = {
        w: s.frameWidth || 0, h: s.frameHeight || 0, fps: Math.round(s.framesPerSecond || 0),
        kbps: pv && dt > 0 ? Math.round((cur.b - pv.b) * 8 / dt / 1000) : 0,
        loss: dr + dl > 0 ? dl / (dr + dl) * 100 : 0,
        freezes: s.freezeCount || 0, codec: codecName(report, s.codecId)
      };
    } else if (s.type === 'outbound-rtp') {
      const slot = outSlot(s);
      if (!slot) return;
      const cur = { b: s.bytesSent || 0 };
      raw['out:' + slot] = cur;
      const pv = prev['out:' + slot];
      st.out[slot] = {
        w: s.frameWidth || 0, h: s.frameHeight || 0, fps: Math.round(s.framesPerSecond || 0),
        kbps: pv && dt > 0 ? Math.round((cur.b - pv.b) * 8 / dt / 1000) : 0,
        limit: s.qualityLimitationReason || 'none', codec: codecName(report, s.codecId), loss: 0
      };
    }
  });
  // Was beim Gegenüber von uns ankommt (Verlust in Senderichtung).
  report.forEach((s) => {
    if (s.type !== 'remote-inbound-rtp') return;
    const ob = report.get(s.localId);
    const slot = ob ? outSlot(ob) : null;
    if (slot && st.out[slot]) st.out[slot].loss = (s.fractionLost || 0) * 100;
  });
  const losses = Object.values(st.in).map((x) => x.loss).concat(Object.values(st.out).map((x) => x.loss));
  st.loss = losses.length ? Math.max.apply(null, losses) : 0;
  st.quality = !pair || p.pc.connectionState !== 'connected' ? 'poor'
    : (st.rtt > 400 || st.loss > 8) ? 'poor' : (st.rtt > 200 || st.loss > 2) ? 'fair' : 'good';
  p.statsRaw = raw;
  p.stats = st;
}

function fmtLoss(x) { return (Math.round(x * 10) / 10).toLocaleString('de-DE') + ' %'; }
function fmtRate(kbps) { return kbps >= 1000 ? (Math.round(kbps / 100) / 10).toLocaleString('de-DE') + ' Mbit/s' : kbps + ' kbit/s'; }

/** Oben rechts: Balken und „Verbindung gut/mittel/schlecht“ (bei mehreren: die schwächste). */
function netQualityBadge() {
  const peers = activePeers().filter((p) => p.stats);
  const box = el('span', { class: 'sc-netq', id: 'sc-netq', hidden: !peers.length });
  if (!peers.length) return box;
  const worst = peers.reduce((w, p) => (NETQ_ORDER.indexOf(p.stats.quality) > NETQ_ORDER.indexOf(w.stats.quality) ? p : w));
  const q = worst.stats.quality;
  box.className = 'sc-netq is-' + q;
  box.title = peers.map((p) => displayName(S.ids.get(p.remoteId)) + ': ' + NETQ[p.stats.quality].label
    + (p.stats.rtt !== null ? ' · Ping ' + p.stats.rtt + ' ms' : '') + ' · Verlust ' + fmtLoss(p.stats.loss)
    + ' · ' + (p.stats.relay ? 'über Relay' : 'direkt')).join('\n');
  const bars = el('span', { class: 'sc-netq-bars', 'aria-hidden': 'true' });
  for (let i = 1; i <= 3; i++) bars.appendChild(el('i', { class: i <= NETQ[q].bars ? 'is-on' : '' }));
  box.append(bars, el('span', { text: 'Verbindung ' + NETQ[q].label }));
  return box;
}

function refreshStatsUi() {
  const old = $('sc-netq');
  if (old) old.replaceWith(netQualityBadge());
  for (const t of tiles.values()) if (t.statsOpen) renderTileStats(t);
}

/** Panel hinter dem Rädchen: was bei dieser Übertragung gerade ankommt (oder rausgeht). */
function renderTileStats(t) {
  const panel = t.panel;
  panel.hidden = !t.statsOpen || !t.w || !t.w.screen;
  if (panel.hidden) return;
  panel.textContent = '';
  const row = (k, v, cls) => panel.appendChild(el('div', { class: 'sc-tile-stats-row' + (cls ? ' ' + cls : '') }, el('span', { text: k }), el('strong', { text: v })));
  const w = t.w;
  if (w.self) {
    const q = screenQuality();
    panel.appendChild(el('p', { class: 'sc-tile-stats-head', text: 'DU SENDEST · ' + q.name.toUpperCase() }));
    const hiddenBy = activePeers().filter((p) => p.remoteState.noscreen).map((p) => displayName(S.ids.get(p.remoteId)));
    const peers = activePeers().filter((p) => !p.remoteState.noscreen && p.stats && p.stats.out.screen && p.tx.screen && p.tx.screen.sender.track);
    if (hiddenBy.length) panel.appendChild(el('p', { class: 'sc-tile-stats-note', text: 'Ausgeblendet bei ' + hiddenBy.join(', ') + ' – dorthin geht gerade nichts.' }));
    if (!peers.length) { if (!hiddenBy.length) panel.appendChild(el('p', { class: 'sc-tile-stats-note', text: 'Noch keine Messwerte …' })); return; }
    for (const p of peers) {
      const o = p.stats.out.screen;
      if (peers.length > 1) panel.appendChild(el('p', { class: 'sc-tile-stats-sub', text: 'an ' + displayName(S.ids.get(p.remoteId)) }));
      row('Auflösung', o.w && o.h ? o.w + ' × ' + o.h : '–');
      row('Bilder/s', String(o.fps));
      row('Datenrate', fmtRate(o.kbps));
      row('Verlust beim Zuschauer', fmtLoss(o.loss), o.loss > 5 ? 'is-bad' : '');
      if (o.limit === 'bandwidth') row('Begrenzt durch', 'Bandbreite', 'is-warn');
      else if (o.limit === 'cpu') row('Begrenzt durch', 'Prozessor', 'is-warn');
    }
    return;
  }
  const p = w.peer;
  const s = p && p.stats;
  const i = s && s.in.screen;
  panel.appendChild(el('p', { class: 'sc-tile-stats-head', text: 'EMPFANG' }));
  if (!i) { panel.appendChild(el('p', { class: 'sc-tile-stats-note', text: 'Noch keine Messwerte …' })); return; }
  row('Auflösung', i.w && i.h ? i.w + ' × ' + i.h : '–');
  row('Bilder/s', String(i.fps), i.fps === 0 ? 'is-bad' : '');
  row('Datenrate', fmtRate(i.kbps));
  row('Paketverlust', fmtLoss(i.loss), i.loss > 5 ? 'is-bad' : i.loss > 2 ? 'is-warn' : '');
  if (s.rtt !== null) row('Ping', s.rtt + ' ms', s.rtt > 400 ? 'is-bad' : s.rtt > 200 ? 'is-warn' : '');
  row('Weg', s.relay ? 'über Relay' : 'direkt');
  if (i.codec) row('Codec', i.codec.toUpperCase());
  let hint = '';
  if (i.fps === 0 && i.kbps < 20) hint = 'Kein neues Bild – entweder ändert sich auf dem Bildschirm gerade nichts, oder die Verbindung ist abgerissen.';
  else if (i.loss > 5 || s.quality === 'poor') hint = 'Die Verbindung ist zu schlecht für diese Qualität – das Bild kann ruckeln oder kurz stehen.';
  if (hint) panel.appendChild(el('p', { class: 'sc-tile-stats-note is-bad', text: hint }));
}

function showCodeInfo() {
  openModal({
    title: 'SICHERHEITSCODE',
    build: (body) => {
      body.append(
        el('p', { class: 'sc-p', text: 'Ton, Bild und Bildschirm laufen direkt zwischen euren Geräten und sind mit Schlüsseln verschlüsselt, die nur eure beiden Browser kennen (DTLS-SRTP).' }),
        el('p', { class: 'sc-p', text: 'Aus den Zertifikaten beider Seiten entsteht der Sicherheitscode. Lest ihn euch gegenseitig vor: Seht ihr dieselbe Zahl, sitzt niemand dazwischen – auch nicht der Server.' }));
      const peers = S.call && S.call.peer ? [S.call.peer] : S.voice ? [...S.voice.peers.values()] : [];
      for (const p of peers) {
        const route = el('span', { class: 'sc-code-route', text: connText(p.failed && p.pc.connectionState !== 'connected' ? 'nodirect' : p.pc.connectionState) });
        body.appendChild(el('div', { class: 'sc-code-row' },
          avatar(S.ids.get(p.remoteId), 'sm'),
          el('span', { class: 'sc-code-who' }, el('span', { text: displayName(S.ids.get(p.remoteId)) }), route),
          el('span', { class: 'sc-code-big', text: p.code || '…' })));
        if (p.pc.connectionState === 'connected') routeOf(p.pc).then((text) => { if (text) route.textContent = text; });
      }
      if (peers.some((p) => p.failed) && !S.cfg.relay) {
        body.appendChild(el('p', { class: 'sc-note', text: 'Ohne direkte Verbindung hilft nur ein Relay-Server (TURN). Er leitet die weiterhin verschlüsselten Daten weiter; eingerichtet wird er in der config.php des Servers.' }));
      }
    }
  });
}

/* ---------- Töne (ohne Audiodateien, per WebAudio) ------------------------- */
let toneTimer = 0;
function beep(freq, dur, when, vol) {
  const ctx = audioCtx();
  if (!ctx) return;
  const t0 = ctx.currentTime + (when || 0);
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol || 0.08, t0 + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

/* Klingeln, Freiton und Nachrichtenton synthetisiert C.sound() (securecom-core.js)
   – derselbe Code rendert auch die Hörproben offline. */
let toneOuts = [];
function synth(name) {
  const ctx = audioCtx();
  if (!ctx || !C || !C.sound) return;
  try {
    const s = C.sound(ctx, ctx.destination, name);
    toneOuts.push(s.out);
    // Verklungen: Knoten freigeben
    setTimeout(() => { s.out.disconnect(); toneOuts = toneOuts.filter((o) => o !== s.out); }, Math.max(0, (s.end - ctx.currentTime) * 1000) + 300);
  } catch (e) { /* ohne Ton weiter */ }
}

/** Eingehender Anruf: klassisches Telefon – 1 s Klingeln, 4 s Pause. */
function playRing() {
  stopTones();
  if (!S.vault.settings.sound) return;
  const ring = () => {
    synth('ring');
    // Android vibriert dazu (iPhones kennen das im Browser nicht).
    if (IS_MOBILE && navigator.vibrate && !document.hidden) { try { navigator.vibrate([1000]); } catch (e) { /* egal */ } }
  };
  ring();
  toneTimer = setInterval(ring, C.RING_CYCLE * 1000);
}

/** Ausgehender Anruf: Freiton 425 Hz, 1 s an, 4 s aus. */
function playRingback() {
  stopTones();
  synth('ringback');
  toneTimer = setInterval(() => synth('ringback'), C.RINGBACK_CYCLE * 1000);
}

function stopTones() {
  clearInterval(toneTimer);
  toneTimer = 0;
  // Klingelt es gerade noch (Annehmen mitten im Klingeln): kurz ausblenden statt abreißen.
  if (toneOuts.length && M.ctx) for (const o of toneOuts) C.fadeOut(M.ctx, o, 0.08);
  toneOuts = [];
  if (IS_MOBILE && navigator.vibrate) { try { navigator.vibrate(0); } catch (e) { /* egal */ } }
}

function playJoinTone(on) {
  if (!S.vault.settings.sound) return;
  beep(on ? 520 : 700, 0.12, 0, 0.05);
  beep(on ? 700 : 520, 0.14, 0.12, 0.05);
}

let lastBlip = 0;
function notifySound() {
  if (!S.vault.settings.sound || Date.now() - lastBlip < 1500) return;
  lastBlip = Date.now();
  if (M.ctx && M.ctx.state === 'running') synth('message');
}

/* ==========================================================================
   Freund hinzufügen (per PGP-Schlüssel oder Fingerabdruck)
   ========================================================================== */
function connectByKey() {
  openModal({
    title: 'FREUND HINZUFÜGEN',
    build: (body, close) => {
      const input = el('textarea', { rows: '6', spellcheck: 'false', placeholder: '-----BEGIN PGP PUBLIC KEY BLOCK-----\n…\n\noder Fingerabdruck: 4F2A 91C0 …' });
      const go = el('button', { type: 'button', class: 'btn btn--primary btn--block', text: 'Suchen' });
      const out = el('div', { class: 'sc-list' });
      body.append(
        el('p', { class: 'sc-p', text: 'Füge den öffentlichen PGP-Schlüssel oder den Fingerabdruck der Person ein. Nimmt sie deine Anfrage an, seht ihr gegenseitig, ob ihr online seid. Schreiben und anrufen geht auch ohne. Hast du den Schlüssel auf einem sicheren Weg bekommen, gilt der Kontakt als verifiziert.' }),
        field('Öffentlicher Schlüssel oder Fingerabdruck', input), go, out);
      go.addEventListener('click', async () => {
        out.textContent = '';
        const text = input.value.trim();
        let fp = null;
        let pasted = null;
        try {
          if (C.looksLikeArmoredKey(text)) {
            if (/PRIVATE KEY/.test(text)) throw new Error('Das ist ein privater Schlüssel – bitte nur den öffentlichen einfügen und den privaten niemandem geben.');
            pasted = await C.readPublicKey(text);
            fp = pasted.getFingerprint();
          } else {
            fp = C.normalizeFingerprint(text);
          }
          if (!fp) throw new Error('Das ist weder ein öffentlicher Schlüssel noch ein Fingerabdruck.');
          if (fp === S.me.fp) throw new Error('Das ist dein eigener Schlüssel.');
          go.disabled = true;
          const r = await api('find', { fp: fp });
          const found = [];
          for (const raw of r.list) {
            const ident = await resolveIdentity(raw);
            if (ident && ident.fp === fp) found.push(ident);
          }
          if (!found.length) {
            out.appendChild(el('p', { class: 'sc-empty-note', text: 'Mit diesem Schlüssel ist gerade niemand bei Clavichat. Die Person muss Clavichat mit genau diesem Schlüssel benutzen (Konto mit eigenem Schlüssel oder ihre temporäre Sitzung).' }));
          }
          for (const ident of found) {
            // Wer den Schlüssel selbst eingefügt hat, hat ihn außerhalb von
            // Clavichat bekommen – das gilt als Verifikation.
            noteContact(ident);
            if (!ident.changed) {
              S.vault.contacts[ident.id].v = true;
              saveVault();
            }
            const f = friendOf(ident.id);
            const befriend = el('button', { type: 'button', class: 'btn btn--primary', disabled: !!(f && f.st !== 'in') },
              icon('userPlus', 14), !f ? 'Freund hinzufügen' : f.st === 'in' ? 'Anfrage annehmen' : f.st === 'out' ? 'Anfrage gesendet' : 'Schon befreundet');
            befriend.addEventListener('click', async () => {
              befriend.disabled = true;
              await addFriend(ident);
              close();
              openDm(ident.id);
            });
            const row = el('div', { class: 'sc-found' },
              personRow(ident, () => { close(); openDm(ident.id); }, { sub: C.shortFingerprint(ident.fp) + (ident.on ? ' · online' : ident.on === false ? ' · offline' : '') }),
              el('div', { class: 'sc-found-actions' },
                befriend,
                el('button', { type: 'button', class: 'btn', onclick: () => { close(); openDm(ident.id); } }, 'Schreiben'),
                el('button', { type: 'button', class: 'btn', onclick: () => { close(); startCall(ident.id, false); } }, icon('phone', 14), 'Anrufen'),
                el('button', { type: 'button', class: 'btn', onclick: () => { close(); startCall(ident.id, true); } }, icon('video', 14), 'Video')));
            out.appendChild(row);
          }
          renderAll();
        } catch (e) {
          out.appendChild(el('p', { class: 'sc-error', text: e.message }));
        }
        go.disabled = false;
      });
    }
  });
}

/* ==========================================================================
   Updates (nur Windows-App)
   Suchen, Laden und Installieren macht die App selbst (desktop/updater.js)
   und nimmt nur Fassungen, die mit dem Schlüssel des Herausgebers signiert
   sind. Hier: das Popup beim Start und der Bereich in den Einstellungen.
   ========================================================================== */
const UPDATES = DESKTOP && DESKTOP.updates ? DESKTOP.updates : null;
const UPD = { state: null, watchers: new Set(), prompted: false, timer: null, news: false, newsTimer: null };
const REPO_URL = 'https://github.com/mxachterberg/Clavichat';
const SEEN_VERSION = 'sc-app-version';

function newerVersion(a, b) {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

/** Link zu den Code-Änderungen zwischen zwei Fassungen (ohne alte Fassung: das Release). */
function changesLink(from, to, text) {
  const href = from ? REPO_URL + '/compare/v' + from + '...v' + to : REPO_URL + '/releases/tag/v' + to;
  return el('a', { class: 'sc-update-link', href, target: '_blank', rel: 'noopener noreferrer', text: text || 'Code-Änderungen auf GitHub ansehen ↗' });
}

function initUpdates() {
  if (!UPDATES) return;
  UPDATES.onState((s) => {
    UPD.state = s;
    for (const fn of UPD.watchers) fn(s);
    promptUpdate();
    showWhatsNew();
  });
  UPDATES.get().then((s) => {
    if (!UPD.state) UPD.state = s;
    promptUpdate();
    showWhatsNew();
  }).catch(() => {});
}

/**
 * Nach einem Update einmal zeigen, was neu ist: die Stichpunkte dieser Fassung
 * (aus der signierten Update-Liste) und der Link zu den Code-Änderungen.
 * Die zuletzt gesehene Fassung steht je Gerät in localStorage.
 */
function showWhatsNew() {
  const s = UPD.state;
  if (!s || !s.version || UPD.news) return;
  let last = null;
  try { last = localStorage.getItem(SEEN_VERSION); } catch (e) { return; }
  const remember = () => { try { localStorage.setItem(SEEN_VERSION, s.version); } catch (e) { /* egal */ } };
  if (last === s.version) return;
  // Erste Fassung mit dieser Anzeige: Wer die App schon benutzt hat, kommt von einer älteren.
  let used = false;
  try { used = !!localStorage.getItem('sc-device'); } catch (e) { /* egal */ }
  if (last ? !newerVersion(s.version, last) : !used) { remember(); return; }
  // Die Stichpunkte kommen mit der ersten Suche nach Updates (8 s nach dem
  // Start). Bis zu 30 s darauf warten, sonst nur mit dem Link zeigen.
  if (!UPD.newsSince) UPD.newsSince = Date.now();
  const haveNotes = !!(s.release && s.release.version === s.version);
  const notesComing = !haveNotes && s.mode && s.auto !== false && ['idle', 'checking'].includes(s.status);
  const boot = $('sc-boot');
  if ((notesComing && Date.now() - UPD.newsSince < 30000) ||
      (boot && !boot.classList.contains('is-done')) || !$('sc-modal').hidden) {
    clearTimeout(UPD.newsTimer);
    UPD.newsTimer = setTimeout(showWhatsNew, 2500);
    return;
  }
  clearTimeout(UPD.newsTimer);
  UPD.news = true;
  remember();
  const notes = haveNotes ? s.release.notes || [] : [];
  openModal({
    title: 'NEU IN ' + s.version,
    build: (body, close) => {
      body.appendChild(el('p', { class: 'sc-p', text: last ? 'Clavichat ist von ' + last + ' auf ' + s.version + ' aktualisiert.' : 'Clavichat ist auf ' + s.version + ' aktualisiert.' }));
      if (notes.length) {
        const list = el('ul', { class: 'sc-update-notes' });
        for (const n of notes) list.appendChild(el('li', { text: n }));
        body.appendChild(list);
      }
      body.appendChild(el('p', { class: 'sc-p' }, changesLink(last, s.version)));
      body.appendChild(el('div', { class: 'sc-card-actions' }, el('button', { type: 'button', class: 'btn btn--primary', text: 'OK', onclick: close })));
    }
  });
}

function watchUpdates(fn) {
  UPD.watchers.add(fn);
  return () => UPD.watchers.delete(fn);
}

/** Beim Start gefunden: einmal fragen – sobald die Oberfläche steht und kein anderer Dialog offen ist. */
function promptUpdate() {
  const s = UPD.state;
  if (!s || !s.prompt || s.status !== 'available' || UPD.prompted) return;
  const boot = $('sc-boot');
  if ((boot && !boot.classList.contains('is-done')) || !$('sc-modal').hidden) {
    clearTimeout(UPD.timer);
    UPD.timer = setTimeout(promptUpdate, 2500);
    return;
  }
  UPD.prompted = true;
  UPDATES.seen().catch(() => {});
  let off = null;
  openModal({
    title: 'UPDATE',
    build: (body, close) => {
      const box = el('div');
      const draw = (st) => { box.textContent = ''; box.appendChild(updatePanel(st, close)); };
      draw(UPD.state);
      off = watchUpdates(draw);
      body.appendChild(box);
    },
    onClose: () => { if (off) off(); }
  });
}

/** Stand, Neuerungen, Fortschritt und Knöpfe – im Popup (later = schließen) und in den Einstellungen. */
function updatePanel(s, later) {
  s = s || { status: 'idle', version: '' };
  const wrap = el('div', { class: 'sc-update' });
  const line = (text, cls) => wrap.appendChild(el('p', { class: cls || 'sc-p', text: text }));
  const latest = s.latest;
  const busy = ['checking', 'downloading', 'installing'].includes(s.status);
  const when = (ts) => (fmtDay(ts) === 'Heute' ? '' : fmtDay(ts) + ' ') + fmtTime(ts);
  if (s.status === 'available') line('Clavichat ' + latest.version + ' ist da – du hast ' + s.version + '.' + (latest.light ? ' Kleines Update: Nur das Programmpaket wird geladen.' : ''));
  else if (s.status === 'downloading') line('Clavichat ' + (latest ? latest.version + ' ' : '') + 'wird geladen … ' + Math.floor((s.progress || 0) * 100) + ' %');
  else if (s.status === 'installing') line('Wird installiert – Clavichat startet gleich neu.');
  else if (s.status === 'checking') line('Suche nach Updates …', 'sc-note');
  else if (s.status === 'current') line('Du hast die neueste Version.' + (s.checked ? ' Zuletzt gesucht: ' + when(s.checked) + '.' : ''), 'sc-note');
  else if (s.status === 'error') line(s.error || 'Die Suche nach Updates ist fehlgeschlagen.', 'sc-note sc-update-error');
  else if (s.status === 'unsupported') line('Diese Fassung aktualisiert sich nicht selbst (Entwicklung oder entpackter Build) – Installer und portable Fassung können es.', 'sc-note');
  else line('Noch nicht gesucht.', 'sc-note');

  if (latest && latest.notes && latest.notes.length && ['available', 'downloading', 'error'].includes(s.status)) {
    const list = el('ul', { class: 'sc-update-notes' });
    for (const n of latest.notes) list.appendChild(el('li', { text: n }));
    wrap.appendChild(list);
  }
  if (s.status === 'downloading' || s.status === 'installing') {
    const fill = el('span');
    fill.style.width = Math.round((s.status === 'installing' ? 1 : s.progress || 0) * 100) + '%';
    wrap.appendChild(el('div', { class: 'sc-progress' }, fill));
  }
  if (latest && ['available', 'downloading', 'error'].includes(s.status)) {
    wrap.appendChild(el('p', { class: 'sc-note' }, changesLink(s.version, latest.version)));
  }
  if (s.status === 'available' && (S.call || S.voice)) line('Ein laufendes Gespräch endet dabei.', 'sc-note');

  const acts = el('div', { class: 'sc-card-actions' });
  if (latest && (s.status === 'available' || s.status === 'error')) {
    acts.appendChild(el('button', { type: 'button', class: 'btn btn--primary', onclick: () => UPDATES.install().catch((e) => toast(e.message, 'error')) },
      icon('download', 14), 'Jetzt aktualisieren' + (latest.size ? ' (' + fmtSize(latest.size) + ')' : '')));
  }
  if (later) {
    if (!busy) acts.appendChild(el('button', { type: 'button', class: 'btn', text: 'Später', onclick: later }));
  } else if (s.status !== 'unsupported') {
    acts.appendChild(el('button', { type: 'button', class: 'btn', disabled: busy, onclick: () => UPDATES.check().catch((e) => toast(e.message, 'error')) },
      icon('refresh', 14), 'Nach Updates suchen'));
  }
  if (acts.childNodes.length) wrap.appendChild(acts);
  return wrap;
}

/* ==========================================================================
   Einstellungen, Profil, Schlüssel
   ========================================================================== */
/* ---------- Geräte-Liste (Einstellungen) ---------------------------------- */
function fmtWhen(sec) { return fmtDay(sec * 1000) + ', ' + fmtTime(sec * 1000); }

/** Zweimal klicken statt Rückfrage: Ein Dialog würde die Einstellungen schließen. */
function confirmButton(label, armedLabel, run) {
  const b = el('button', { type: 'button', class: 'btn', text: label });
  let timer = 0;
  const reset = () => { timer = 0; b.textContent = label; b.classList.remove('sc-btn--danger'); };
  b.addEventListener('click', async () => {
    if (!timer) {
      b.textContent = armedLabel;
      b.classList.add('sc-btn--danger');
      timer = setTimeout(reset, 4000);
      return;
    }
    clearTimeout(timer);
    b.disabled = true;
    try { await run(); } catch (e) { toast(e.message, 'error'); }
    b.disabled = false;
    reset();
  });
  return b;
}

async function renderDevices(box, data) {
  try {
    if (!data) data = await api('devices');
  } catch (e) {
    box.textContent = '';
    box.appendChild(el('p', { class: 'sc-note', text: e.status === 404
      ? 'Dieser Server zeigt noch keine Geräte an – er läuft mit einer älteren Clavichat-Version.'
      : 'Die Geräte ließen sich nicht laden: ' + e.message }));
    return;
  }
  rememberLoginCount(S.me.id, data.tv);   // wer hinschaut, braucht keinen Hinweis mehr
  // Dieses Gerät zuerst, die anderen nach letzter Aktivität (so liefert sie der Server).
  const list = (data.list || []).slice().sort((a, b) => (b.cur ? 1 : 0) - (a.cur ? 1 : 0));
  const rows = [];
  for (const d of list) {
    let name = d.cur ? deviceName() : 'Gerät ohne Namen';
    if (d.n) {
      try { name = cleanName(await C.openText(S.wrapKey, d.n, deviceAad())) || name; } catch (e) { /* mit altem Passwort benannt */ }
    }
    const mobile = /Android|iPhone|iPad/.test(name);
    rows.push(el('div', { class: 'sc-set-row sc-device' + (d.cur ? ' is-current' : '') },
      icon(mobile ? 'mobile' : 'screen', 18),
      el('span', { class: 'sc-set-text' },
        el('strong', {}, name, d.cur ? el('span', { class: 'sc-device-cur', text: 'DIESES GERÄT' }) : null),
        el('span', { text: 'Angemeldet ' + fmtWhen(d.c) + (d.cur ? '' : ' · zuletzt aktiv: ' + fmtDay(d.s * 1000)) })),
      d.cur ? null : confirmButton('Abmelden', 'Wirklich abmelden?', async () => {
        const r = await api('device.revoke', { h: d.h });
        toast(r.n ? 'Gerät abgemeldet.' : 'Das Gerät war schon abgemeldet.', 'ok');
        renderDevices(box, r);
      })));
  }
  const others = list.filter((d) => !d.cur).length;
  box.textContent = '';
  rows.forEach((row) => box.appendChild(row));
  appendAll(box,
    others > 1 ? el('div', { class: 'sc-card-actions' }, confirmButton('Alle anderen Geräte abmelden', 'Wirklich alle ' + others + ' abmelden?', async () => {
      const r = await api('device.revoke', { others: 1 });
      toast(r.n === 1 ? '1 Gerät abgemeldet.' : r.n + ' Geräte abgemeldet.', 'ok');
      renderDevices(box, r);
    })) : null,
    el('p', { class: 'sc-note', text: 'Meldet sich ein neues Gerät an, sagen deine anderen Geräte Bescheid. Abgemeldete Geräte kommen nur mit Passwort oder Wiederherstellungscode wieder hinein – ist eins in fremden Händen, ändere deshalb zusätzlich dein Passwort bzw. erzeuge einen neuen Wiederherstellungscode.' }));
}

function showSettings() {
  let offUpdates = null;
  openModal({
    title: 'EINSTELLUNGEN',
    wide: true,
    onClose: () => { if (offUpdates) offUpdates(); },
    build: (body, close) => {
      // Profil
      body.appendChild(sectionHead('PROFIL'));
      // Temporär: Wunsch für die Online-Liste. „Als offline anzeigen“ blendet
      // trotzdem aus (syncListed).
      const vis = el('input', { type: 'checkbox', checked: S.vault.settings.listed !== undefined ? S.vault.settings.listed !== false : S.me.vis });
      vis.addEventListener('change', async () => {
        S.vault.settings.listed = vis.checked;
        saveVault();
        await syncListed();
        renderAll();
      });
      const picRow = inMeetingMode() ? null : S.mode === 'account'
        ? el('div', { class: 'sc-set-row' },
          avatar(S.ids.get(S.me.id), 'sm'),
          el('span', { class: 'sc-set-text' }, el('strong', { text: 'Profilbild' }),
            el('span', { text: S.me.av ? 'Für alle sichtbar, die deinen Namen sehen.' : 'Noch keins – zu sehen sind deine Anfangsbuchstaben.' })),
          el('button', { type: 'button', class: 'btn', text: S.me.av ? 'Ändern' : 'Wählen', onclick: async () => { if (await setProfilePicture(false)) { close(); showSettings(); } } }),
          S.me.av ? el('button', { type: 'button', class: 'btn sc-btn--danger', text: 'Entfernen', onclick: async () => { if (await setProfilePicture(true)) { close(); showSettings(); } } }) : null)
        : el('p', { class: 'sc-note', text: 'Profilbilder gibt es für Konten.' });
      appendAll(body,
        el('div', { class: 'sc-set-row' },
          el('span', { class: 'sc-set-text' }, el('strong', { text: S.mode === 'temp' && !inMeetingMode() ? 'Alias' : 'Name' }),
            el('span', { text: S.me.name || '(kein Alias)' })),
          S.mode === 'temp' ? el('button', { type: 'button', class: 'btn', text: 'Ändern', onclick: () => { close(); editAlias(); } }) : null),
        picRow,
        // Konten stehen nie in der Online-Liste (mehr Anonymität), nur temporäre Sitzungen – Gäste auch nicht.
        inMeetingMode()
          ? el('p', { class: 'sc-note', text: (S.guest ? 'Als Gast stehst du' : 'Im Meeting stehst du') + ' in keiner Online-Liste und bist nur in diesem Meeting zu sehen – für die anderen Teilnehmer, mit Namen und Fingerabdruck.' })
          : S.mode === 'temp'
          ? el('label', { class: 'sc-check' }, vis, el('span', { text: 'In der Online-Liste sichtbar sein. Aus: Nur wer deinen Schlüssel oder Fingerabdruck hat, erreicht dich.' +
            (chosenStatus() === 'off' ? ' Solange du als offline angezeigt wirst, stehst du ohnehin nicht darin.' : '') }))
          : el('p', { class: 'sc-note', text: 'Konten stehen nicht in der Online-Liste. Ob du online bist, sehen nur deine Freunde – den Status stellst du unten links mit einem Klick auf dein Profil ein. Erreichbar bist du über deinen Schlüssel, deinen Fingerabdruck, gemeinsame Räume und bestehende Unterhaltungen.' }));

      // Schlüssel (Gäste: nur der Fingerabdruck – sichern lohnt sich für eine Gast-Sitzung nicht)
      body.appendChild(sectionHead('SCHLÜSSEL'));
      if (inMeetingMode()) {
        body.append(el('p', { class: 'sc-fp', text: C.formatFingerprint(S.me.fp) }),
          el('p', { class: 'sc-note', text: 'Dein Schlüssel lebt nur ' + KEY_HOME + ' und verschwindet mit deiner ' + (S.guest ? 'Gast-Sitzung' : 'Sitzung') + '.' }));
      } else body.append(
        el('p', { class: 'sc-fp', text: C.formatFingerprint(S.me.fp) }),
        el('p', { class: 'sc-note', text: 'Forward Secrecy: Der Schlüssel für Nachrichten an dich wechselt jede Woche (der jetzige ist vom ' +
          new Date(C.newestEncryptionSubkey(S.me.priv)).toLocaleDateString('de-DE') + '), alte werden nach ' + Math.round(keyKeep() / 86400000) + ' Tagen gelöscht – dann sind auch mitgeschnittene ältere Nachrichten nicht mehr zu entschlüsseln. Räume: Der Besitzer wechselt den Raumschlüssel wöchentlich.' }),
        el('div', { class: 'sc-card-actions' },
          el('button', { type: 'button', class: 'btn', onclick: () => copyText(S.me.armored, 'Öffentlicher Schlüssel') }, icon('copy', 14), 'Öffentlichen Schlüssel kopieren'),
          el('button', { type: 'button', class: 'btn', onclick: () => downloadText('securecom-' + (S.me.name || 'schluessel') + '-public.asc', S.me.armored) }, icon('download', 14), 'Herunterladen'),
          el('button', { type: 'button', class: 'btn', onclick: () => { close(); showKeyBackup(null, false); } }, icon('key', 14), 'Privaten Schlüssel sichern')));

      // Anrufe
      body.appendChild(sectionHead('ANRUFE'));
      const hide = el('input', { type: 'checkbox', checked: hidingIp(), disabled: !S.cfg.relay });
      hide.addEventListener('change', () => setHideIp(hide.checked));
      const sound = el('input', { type: 'checkbox', checked: S.vault.settings.sound !== false });
      sound.addEventListener('change', () => { S.vault.settings.sound = sound.checked; saveVault(); });
      const unknown = el('input', { type: 'checkbox', checked: unknownCallsAllowed() });
      unknown.addEventListener('change', () => setUnknownCalls(unknown.checked));
      // Auswahlfelder in einem schlichten Container statt <label>: Ein Klick
      // auf den Hinweistext soll die Liste nicht aufklappen.
      const pickField = (label, picker, note) => el('div', { class: 'field' },
        el('span', { class: 'field-label', text: label }), picker.el,
        note ? el('span', { class: 'sc-field-note', text: note }) : null);
      const mic = choice([{ id: '', name: 'Standard-Mikrofon' }], S.vault.settings.mic || '', (id) => { S.vault.settings.mic = id; saveVault(); });
      if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
        navigator.mediaDevices.enumerateDevices().then((list) => {
          const items = [{ id: '', name: 'Standard-Mikrofon' }];
          for (const d of list) {
            if (d.kind !== 'audioinput' || !d.deviceId || d.deviceId === 'default') continue;
            items.push({ id: d.deviceId, name: d.label || 'Mikrofon ' + items.length });
          }
          mic.setItems(items);
        }).catch(() => {});
      }
      const camPick = choice([{ id: '', name: 'Standard-Kamera' }], cameraChoiceId(), setCameraChoice);
      cameraChoices().then((items) => camPick.setItems(items)).catch(() => {});
      const audio = choice(AUDIO_QUALITY, ownAudioQuality().id, setAudioQuality);
      const roomAq = roomAudioQuality();
      const roomAqName = roomAq && S.voice ? (S.rooms.get(S.voice.rid) || { meta: { name: '' } }).meta.name : '';
      const screenPick = choice(SCREEN_QUALITY, screenQuality().id, setScreenQuality);
      appendAll(body,
        relayStatusRow(),
        pickField('Mikrofon', mic, 'Namen erscheinen, sobald du einmal das Mikrofon erlaubt hast.'),
        pickField('Kamera', camPick, 'Gilt für dieses Gerät. Im Call wechselst du mit dem Knopf neben der Kamera' + (IS_MOBILE ? ' zwischen vorne und hinten.' : ' zur nächsten Kamera.') + ' Namen erscheinen, sobald du die Kamera einmal erlaubt hast.'),
        pickField('Tonqualität', audio, 'Gilt für dieses Gerät, Datenrate und Filter sofort, Stereo ab dem nächsten Anruf.' +
          (roomAq ? ' Im Sprachkanal von „' + roomAqName + '“ gilt gerade die Einstellung des Raums: ' + roomAq.name + '.' : '')),
        pickField('Bildschirm teilen', screenPick, 'Gilt für dieses Gerät. Während einer Übertragung lässt sie sich über den Regler-Knopf neben „Bildschirm teilen“ ändern.'),
        el('label', { class: 'sc-check' + (S.cfg.relay ? '' : ' is-disabled') }, hide, el('span', { text: S.cfg.relay
          ? 'IP-Adresse verbergen: Anrufe laufen nur über den Relay-Server. Dein Gegenüber sieht deine IP nicht – auch nicht beim Klingeln –, der Betreiber des Relays schon. ' +
            (S.mode === 'temp' ? 'Bei temporären Sitzungen von Haus aus an, gilt für dieses Gerät.' : 'Gilt auf all deinen Geräten.') + ' Ab dem nächsten Anruf.'
          : 'IP-Adresse verbergen – braucht einen Relay-Server (TURN), der auf diesem Server noch nicht eingerichtet ist.' })),
        inMeetingMode() ? null : el('label', { class: 'sc-check' }, unknown, el('span', { text:
          'Anrufe von Unbekannten klingeln lassen. Sonst landen sie still unter Nachrichtenanfragen. Bekannt sind Kontakte, Freunde und Mitglieder gemeinsamer Räume. ' +
          (S.mode === 'temp' ? 'Bei temporären Sitzungen von Haus aus an, gilt für dieses Gerät.' : 'Bei Konten von Haus aus aus; gilt auf all deinen Geräten.') })),
        el('label', { class: 'sc-check' }, sound, el('span', { text: 'Töne (Klingeln, neue Nachricht)' })));

      // Benachrichtigungen und Darstellung
      body.appendChild(sectionHead('ANZEIGE'));
      const canNotify = typeof Notification === 'function';
      const note = el('input', { type: 'checkbox', checked: notifyAllowed(), disabled: !canNotify });
      note.addEventListener('change', async () => {
        if (!note.checked) { S.vault.settings.notify = false; saveVault(); return; }
        let perm = Notification.permission;
        if (perm === 'default') perm = await Notification.requestPermission();
        if (perm !== 'granted') {
          note.checked = false;
          toast('Benachrichtigungen sind für diese Seite im Browser gesperrt.', 'error');
          return;
        }
        S.vault.settings.notify = true;
        saveVault();
      });
      const dark = document.documentElement.getAttribute('data-theme') !== 'light';
      const themeRow = el('div', { class: 'sc-set-row' },
        el('span', { class: 'sc-set-text' }, el('strong', { text: 'Darstellung' }), el('span', { text: dark ? 'Dunkel' : 'Hell' })),
        el('button', { type: 'button', class: 'btn', text: dark ? 'Hell' : 'Dunkel', onclick: () => {
          setTheme(dark ? 'light' : 'dark');
          close();
          showSettings();
        } }));
      body.append(themeRow,
        el('label', { class: 'sc-check' + (canNotify ? '' : ' is-disabled') }, note, el('span', { text:
          'Benachrichtigungen, wenn Clavichat nicht im Blick ist – nur wer schreibt oder anruft, nie der Inhalt.' })));
      if (DESKTOP && DESKTOP.protect) {
        const shield = el('input', { type: 'checkbox', checked: protectingContent() });
        shield.addEventListener('change', () => setProtectContent(shield.checked));
        body.append(el('label', { class: 'sc-check' }, shield, el('span', { text:
          'Bildschirmfotos und Aufnahmen verhindern: Andere Programme, Screenshots und Bildschirmübertragungen sehen dieses Fenster schwarz. Gilt für dieses Gerät.' })));
      }

      // Logo (je Gerät)
      body.appendChild(sectionHead('LOGO'));
      const logoNow = logoChoice();
      const logoPick = el('div', { class: 'sc-logo-pick', role: 'group', 'aria-label': 'Logo wählen' });
      for (const id of Object.keys(LOGOS)) {
        logoPick.appendChild(el('button', { type: 'button', class: 'sc-logo-tile', 'aria-pressed': id === logoNow ? 'true' : 'false', onclick: (ev) => {
          setLogo(id);
          logoPick.querySelectorAll('.sc-logo-tile').forEach((b) => b.setAttribute('aria-pressed', b === ev.currentTarget ? 'true' : 'false'));
        } }, logoMark(44, id), el('span', { class: 'sc-logo-name', text: LOGOS[id].label })));
      }
      body.append(logoPick, el('p', { class: 'sc-note', text: 'Gilt für dieses Gerät: oben links und im Browser-Tab' + (DESKTOP
        ? ', in der App auch für Fenster, Taskleiste und Infobereich. Programmdatei, Verknüpfungen und Installer zeigen weiter das Funkgerät – sie lassen sich im laufenden Betrieb nicht ändern.'
        : '.') }));

      // App-Sperre (je Gerät) – nicht im Meeting-Modus: Die Sitzung lebt nur so lange wie das Meeting.
      if (!inMeetingMode()) {
        body.appendChild(sectionHead('APP-SPERRE'));
        if (!L.cfg) {
          body.append(
            el('p', { class: 'sc-note', text: 'Sperrt Clavichat mit einer PIN – beim Start, nach Leerlauf' + (DESKTOP ? ', beim Sperren von Windows' : '') +
              ' und auf Knopfdruck. Die gespeicherte Anmeldung liegt dann nur mit der PIN verschlüsselt auf diesem Gerät.' }),
            el('div', { class: 'sc-card-actions' },
              el('button', { type: 'button', class: 'btn', onclick: () => { close(); pinDialog('set'); } }, icon('lock', 14), 'PIN festlegen')));
        } else {
          const idlePick = choice(LOCK_IDLE, String(L.cfg.idle || 0), (id) => { L.cfg.idle = parseInt(id, 10) || 0; saveLockCfg(L.cfg); });
          body.append(
            pickField('Automatisch sperren', idlePick, 'Gilt für dieses Gerät. Während eines Gesprächs sperrt Clavichat nicht von selbst' +
              (DESKTOP ? ', beim Sperren von Windows dagegen immer.' : '.')),
            el('div', { class: 'sc-card-actions' },
              el('button', { type: 'button', class: 'btn', onclick: () => { close(); lockNow(); } }, icon('lock', 14), 'Jetzt sperren'),
              el('button', { type: 'button', class: 'btn', text: 'PIN ändern', onclick: () => { close(); pinDialog('change'); } }),
              el('button', { type: 'button', class: 'btn sc-btn--danger', text: 'Sperre entfernen', onclick: () => { close(); pinDialog('remove'); } })),
            el('p', { class: 'sc-note', text: 'Sperren geht auch mit Strg+L oder dem Schloss unten links. PIN vergessen? Auf dem Sperrbildschirm zurücksetzen – danach meldest du dich neu an.' }));
        }
        if (DESKTOP && DESKTOP.secure) {
          body.append(el('p', { class: 'sc-note', text: 'In der Windows-App ist die gespeicherte Anmeldung außerdem an dein Windows-Konto gebunden: Auf einem anderen Rechner oder unter einem anderen Windows-Konto lässt sie sich nicht öffnen.' }));
        }
      }

      // Fenster (nur Windows-App): beim Schließen in den Infobereich
      if (DESKTOP && DESKTOP.window) {
        body.appendChild(sectionHead('FENSTER'));
        const tray = el('input', { type: 'checkbox' });
        tray.addEventListener('change', () => { DESKTOP.window.setTray(tray.checked).catch(() => {}); });
        DESKTOP.window.get().then((w) => { tray.checked = !!(w && w.tray); }).catch(() => {});
        body.append(
          el('label', { class: 'sc-check' }, tray, el('span', { text: 'Beim Schließen in den Infobereich minimieren – Clavichat läuft weiter, Nachrichten und Anrufe kommen an' })),
          el('p', { class: 'sc-note', text: 'Zurück per Klick auf das Clavichat-Symbol unten rechts bei der Uhr; beenden mit Rechtsklick darauf → „Beenden“.' }));
      }

      // Updates (nur Windows-App)
      if (UPDATES) {
        body.appendChild(sectionHead('UPDATES'));
        const auto = el('input', { type: 'checkbox', checked: !UPD.state || UPD.state.auto !== false });
        auto.addEventListener('change', () => { UPDATES.setAuto(auto.checked).catch(() => {}); });
        const ver = el('p', { class: 'sc-mono sc-update-version' });
        const box = el('div');
        const draw = (s) => {
          s = s || {};
          ver.textContent = 'CLAVICHAT ' + (s.version || '') + (s.mode === 'portable' ? ' · PORTABEL' : s.mode === 'installed' ? ' · INSTALLIERT' : '');
          auto.checked = s.auto !== false;
          auto.disabled = s.status === 'unsupported';
          box.textContent = '';
          box.appendChild(updatePanel(s, null));
        };
        body.append(ver,
          el('label', { class: 'sc-check' }, auto, el('span', { text: 'Beim Start im Hintergrund nach Updates suchen und Bescheid geben' })),
          box);
        draw(UPD.state);
        offUpdates = watchUpdates(draw);
        if (!UPD.state) UPDATES.get().then((s) => { UPD.state = s; draw(s); }).catch(() => {});
      }

      // Geräte (nur Konten)
      if (S.mode === 'account') {
        body.appendChild(sectionHead('GERÄTE'));
        const devBox = el('div', { class: 'sc-devices' }, el('p', { class: 'sc-note', text: 'Wird geladen …' }));
        body.appendChild(devBox);
        renderDevices(devBox);
      }

      // Sitzung / Konto
      body.appendChild(sectionHead(S.mode === 'temp' ? 'SITZUNG' : 'KONTO'));
      const acts = el('div', { class: 'sc-card-actions' });
      if (inMeetingMode()) {
        acts.append(el('button', { type: 'button', class: 'btn sc-btn--danger', onclick: () => { close(); guestLeave(); } }, icon('leave', 14), 'Meeting verlassen & Sitzung beenden'));
      } else if (S.mode === 'account') {
        // Konto mit Wiederherstellungscode: neuen erzeugen, falls der alte weg ist.
        if (S.codeAccount) acts.appendChild(el('button', { type: 'button', class: 'btn', onclick: () => { close(); renewRecoveryCode(); } }, icon('key', 14), 'Neuer Wiederherstellungscode'));
        acts.append(
          el('button', { type: 'button', class: 'btn', onclick: () => { close(); changePassword(); } }, S.codeAccount ? 'Stattdessen Passwort festlegen' : 'Passwort ändern'),
          el('button', { type: 'button', class: 'btn', onclick: () => { close(); logout(); } }, icon('logout', 14), 'Abmelden'),
          el('button', { type: 'button', class: 'btn sc-btn--danger', onclick: () => { close(); deleteAccount(); } }, icon('trash', 14), 'Konto löschen'));
      } else {
        acts.append(el('button', { type: 'button', class: 'btn sc-btn--danger', onclick: () => { close(); logout(); } }, icon('logout', 14), 'Sitzung beenden & alles löschen'));
      }
      body.append(acts,
        el('button', { type: 'button', class: 'btn btn--block', onclick: () => { close(); showSecurityInfo(); } }, icon('shield', 14), 'Wie Clavichat dich schützt'));
    }
  });
}

/** PIN festlegen ('set'), ändern ('change') oder die Sperre entfernen ('remove'). */
function pinDialog(mode) {
  const labels = { set: 'Festlegen', change: 'Ändern', remove: 'Sperre entfernen' };
  openModal({
    title: mode === 'set' ? 'PIN FESTLEGEN' : mode === 'change' ? 'PIN ÄNDERN' : 'APP-SPERRE ENTFERNEN',
    build: (body, close) => {
      const pinInput = () => el('input', { type: 'password', autocomplete: 'off', maxlength: '32', inputmode: L.cfg && L.cfg.num && mode !== 'set' ? 'numeric' : null });
      const old = mode !== 'set' ? pinInput() : null;
      const p1 = mode !== 'remove' ? pinInput() : null;
      const p2 = mode !== 'remove' ? pinInput() : null;
      const go = el('button', { type: 'button', class: 'btn btn--primary btn--block' + (mode === 'remove' ? ' sc-btn--danger' : ''), text: labels[mode] });
      go.addEventListener('click', async () => {
        if (p1) {
          if (C.weakPin(p1.value)) { toast('Die PIN ist zu einfach: mindestens 4 Zeichen, keine Reihen oder Wiederholungen wie 1234, 0000 oder 1212.', 'error', 8000); return; }
          if (p1.value !== p2.value) { toast('Die PINs stimmen nicht überein.', 'error'); return; }
        }
        go.disabled = true;
        go.textContent = 'Wird gehärtet …';
        try {
          if (old && !(await tryPin(L.cfg, old.value))) throw new Error('Die bisherige PIN stimmt nicht.');
          // Gespeicherte Anmeldung mit dem bisherigen Schlüssel öffnen, mit dem neuen schließen.
          const rec = await loadSession().catch(() => null);
          if (mode === 'remove') {
            removeLock();
          } else {
            const made = await makeLockCfg(p1.value, L.cfg ? L.cfg.idle : 300);
            L.key = made.key;
            L.cfg = made.cfg;
            saveLockCfg(made.cfg);
            setLockFails(null);
          }
          if (rec) await storeSession(rec);
          close();
          renderUser();
          toast(mode === 'set' ? 'PIN festgelegt. Sperren mit Strg+L oder dem Schloss unten links.' : mode === 'change' ? 'PIN geändert.' : 'Die App-Sperre ist aus.', 'ok', 7000);
        } catch (e) {
          go.disabled = false;
          go.textContent = labels[mode];
          toast(e.message, 'error');
        }
      });
      for (const input of [old, p1, p2]) if (input) input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go.click(); });
      appendAll(body,
        el('p', { class: 'sc-p', text: mode === 'remove'
          ? 'Clavichat öffnet sich auf diesem Gerät dann wieder ohne PIN.'
          : 'Die PIN gilt nur für dieses Gerät und verlässt es nie. Mit ihr ist die gespeicherte Anmeldung verschlüsselt – nach 10 falschen Versuchen wird sie gelöscht.' }),
        old ? field(mode === 'remove' ? 'PIN' : 'Bisherige PIN', old) : null,
        p1 ? field(mode === 'change' ? 'Neue PIN' : 'PIN', p1, 'Mindestens 4 Zeichen, besser 6 oder mehr. Buchstaben gehen auch.') : null,
        p2 ? field('PIN wiederholen', p2) : null,
        go);
    }
  });
}

function editAlias() {
  openModal({
    title: inMeetingMode() ? 'NAME' : 'ALIAS',
    build: (body, close) => {
      const suggestion = randomAlias();
      const input = el('input', { type: 'text', maxlength: '40', value: S.me.name || '', placeholder: suggestion });
      const go = el('button', { type: 'button', class: 'btn btn--primary btn--block', text: 'Speichern' });
      go.addEventListener('click', async () => {
        const name = cleanName(input.value) || suggestion;
        go.disabled = true;
        try {
          const obj = { v: 1, id: S.me.id, kind: 'temp', name: name, ts: Date.now() };
          if (S.guest) obj.guest = 1;
          const card = await C.signCard(S.me.priv, obj);
          await api('card', { card: card });
          S.me.name = name;
          S.ids.get(S.me.id).name = name;
          close();
          renderAll();
        } catch (e) { go.disabled = false; toast(e.message, 'error'); }
      });
      input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go.click(); });
      body.append(field('Wie sollen andere dich sehen?', input, 'Der Alias steht auf deiner signierten Karte. Zur Unterscheidung zeigt Clavichat immer auch das Ende deines Fingerabdrucks.'), go);
    }
  });
}

function showKeyBackup(password, fresh) {
  openModal({
    title: fresh ? 'KONTO ERSTELLT' : 'SCHLÜSSEL SICHERN',
    build: (body, close) => {
      const pass = el('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Passphrase für die Sicherung' });
      if (password) pass.value = password;
      const go = el('button', { type: 'button', class: 'btn btn--primary btn--block' }, icon('download', 14), 'Privaten Schlüssel herunterladen');
      go.addEventListener('click', async () => {
        const weak = passwordProblem(pass.value, [S.me.name], 'Die Passphrase');
        if (weak) { toast(weak, 'error', 9000); return; }
        go.disabled = true;
        try {
          const armored = await C.exportProtectedKey(S.me.priv, pass.value);
          downloadText('securecom-' + (S.me.name || 'schluessel') + '-private.asc', armored);
          toast('Gesichert. Bewahre die Datei getrennt vom Passwort auf.', 'ok');
        } catch (e) { toast(e.message, 'error'); }
        go.disabled = false;
      });
      appendAll(body,
        fresh ? el('p', { class: 'sc-p', text: 'Willkommen, ' + S.me.name + '! Dein Konto steht. Weil es keine E-Mail gibt, kann niemand es zurücksetzen – sichere deshalb jetzt deinen privaten Schlüssel.' }) : null,
        el('p', { class: 'field-label', text: 'Dein Fingerabdruck' }),
        el('p', { class: 'sc-fp', text: C.formatFingerprint(S.me.fp) }),
        field('Passphrase', pass, fresh ? 'Vorbelegt mit deinem Kontopasswort. Die Datei ist damit geschützt und lässt sich auch in GnuPG oder Kleopatra importieren.' : 'Schützt die Datei. Lässt sich auch in GnuPG oder Kleopatra importieren.',
          strengthMeter(pass, () => [S.me.name])),
        go,
        el('div', { class: 'sc-card-actions' },
          el('button', { type: 'button', class: 'btn', onclick: () => copyText(S.me.armored, 'Öffentlicher Schlüssel') }, icon('copy', 14), 'Öffentlichen Schlüssel kopieren'),
          fresh ? el('button', { type: 'button', class: 'btn', text: 'Später', onclick: () => close() }) : null));
    }
  });
}

function changePassword() {
  openModal({
    title: 'PASSWORT ÄNDERN',
    build: (body, close) => {
      const old = el('input', { type: 'password', autocomplete: 'current-password' });
      const p1 = el('input', { type: 'password', autocomplete: 'new-password' });
      const p2 = el('input', { type: 'password', autocomplete: 'new-password' });
      const go = el('button', { type: 'button', class: 'btn btn--primary btn--block', text: 'Ändern' });
      go.addEventListener('click', async () => {
        const weak = passwordProblem(p1.value, [S.username], 'Das neue Passwort');
        if (weak) { toast(weak, 'error', 9000); return; }
        if (p1.value !== p2.value) { toast('Die neuen Passwörter stimmen nicht überein.', 'error'); return; }
        go.disabled = true;
        go.textContent = 'Wird gehärtet …';
        try {
          const oldKeys = await C.accountKeys(S.username, old.value);   // Passwort oder Code
          const keys = await C.deriveAccountKeys(S.username, p1.value);
          const wrapKey = await C.importWrapKey(keys.wrapRaw, false);
          const wrapped = await C.sealText(wrapKey, C.armorPrivate(S.me.priv), keyAad(S.username));
          const vault = await C.sealText(wrapKey, JSON.stringify(S.vault), vaultAad());
          const r = await api('password', { old_auth: oldKeys.auth, auth: keys.auth, wrapped: wrapped, vault: vault });
          S.wrapKey = wrapKey;
          S.vv = r.vv;
          S.deviceLabeled = false;   // Gerätename war mit dem alten Schlüssel versiegelt
          labelDevice();
          const remembered = !!(await idbGet('session'));
          await rememberAccount(remembered, S.username, S.me.id, S.token, wrapped, keys.wrapRaw);
          close();
          toast('Passwort geändert. Andere Geräte sind abgemeldet.', 'ok');
        } catch (e) {
          go.disabled = false;
          go.textContent = 'Ändern';
          toast(e.message, 'error');
        }
      });
      body.append(field('Bisheriges Passwort oder Wiederherstellungscode', old),
        field('Neues Passwort', p1, 'Mindestens „okay“ – am einfachsten vier zufällige Wörter.', strengthMeter(p1, () => [S.username])),
        field('Neues Passwort wiederholen', p2), go);
    }
  });
}

function deleteAccount() {
  openModal({
    title: 'KONTO LÖSCHEN',
    build: (body, close) => {
      const pass = el('input', { type: 'password', autocomplete: 'current-password' });
      const go = el('button', { type: 'button', class: 'btn sc-btn--danger btn--block', text: 'Endgültig löschen' });
      go.addEventListener('click', async () => {
        go.disabled = true;
        try {
          const keys = await C.accountKeys(S.username, pass.value);
          await api('delete', { auth: keys.auth });
          teardownMedia();
          await clearStoredSession();
          location.reload();
        } catch (e) { go.disabled = false; toast(e.message, 'error'); }
      });
      body.append(el('p', { class: 'sc-p', text: 'Löscht dein Konto, deinen Briefkasten, deinen eingepackten Schlüssel und deine Raummitgliedschaften vom Server. Räume, die dir gehören, übernimmt das älteste Mitglied.' }),
        field('Passwort oder Wiederherstellungscode zur Bestätigung', pass), go);
    }
  });
}

/* ---------- Erklär-Grafiken („So funktioniert Clavichat“) --------------------
   Im Stil der Seite: dünne Rahmen, orange Kreuze an den Ecken, Beschriftung in
   Monospace. Die Farben kommen aus dem Stylesheet (hell und dunkel). */
const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const k of Object.keys(attrs || {})) {
    const v = attrs[k];
    if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
  }
  for (let i = 2; i < arguments.length; i++) {
    const c = arguments[i];
    if (c !== null && c !== undefined && c !== false) node.append(c);
  }
  return node;
}

function dgText(x, y, cls, text) {
  return svgEl('text', { x: x, y: y, class: cls, 'text-anchor': 'middle', 'dominant-baseline': 'central' }, text || '');
}

/** Kasten wie auf der Seite; gibt Titel und Untertitel zurück, damit sie sich ändern lassen. */
function dgBox(parent, x, y, w, h, title, sub) {
  const t = dgText(x + w / 2, y + h / 2 - 9, 'sc-dg-title', title);
  const s = dgText(x + w / 2, y + h / 2 + 11, 'sc-dg-sub', sub);
  parent.append(
    svgEl('rect', { x: x, y: y, width: w, height: h, class: 'sc-dg-box' }),
    svgEl('path', { d: 'M' + (x - 4.5) + ' ' + y + 'h9M' + x + ' ' + (y - 4.5) + 'v9', class: 'sc-dg-tick' }),
    svgEl('path', { d: 'M' + (x + w - 4.5) + ' ' + (y + h) + 'h9M' + (x + w) + ' ' + (y + h - 4.5) + 'v9', class: 'sc-dg-tick' }),
    t, s);
  return { title: t, sub: s };
}

/** Schloss: zu (verschlüsselt) oder offen (entschlüsselt). */
function dgLock(x, y, open) {
  return svgEl('g', { class: 'sc-dg-lock' },
    svgEl('path', { d: open
      ? 'M' + (x - 3.5) + ' ' + (y - 3) + 'v-6a3.5 3.5 0 0 1 7 0v1'
      : 'M' + (x - 3.5) + ' ' + (y - 3) + 'v-3.5a3.5 3.5 0 0 1 7 0v3.5' }),
    svgEl('rect', { x: x - 6, y: y - 3, width: 12, height: 9 }));
}

function serverHost() {
  try { return new URL(API_URL, location.href).host; } catch (e) { return location.host; }
}

function relayHost() {
  for (const s of turnServers()) {
    for (const u of [].concat(s.urls)) {
      const m = /^turns?:([^:?]+)/i.exec(String(u));
      if (m) return m[1];
    }
  }
  return '';
}

/**
 * So läuft ein Anruf – mit und ohne „IP verbergen“. Nur zum Zeigen, die
 * Einstellung bleibt. own: so sähe es auf einem selbst betriebenen Server
 * mit eigenem Relay aus.
 */
function callDiagram(own) {
  const relayOk = own || !!(S.cfg && S.cfg.relay);
  const host = serverHost();
  const root = svgEl('svg', { viewBox: '0 0 616 306', role: 'img' });
  const direct = svgEl('path', { d: 'M162 156H454' });
  const relL = svgEl('path', { d: 'M83 190V268H229' });
  const relR = svgEl('path', { d: 'M387 268H533V190' });
  const d1 = dgText(308, 140, 'sc-dg-label');
  const d2 = dgText(308, 173, 'sc-dg-label');
  const rl = dgText(156, 255, 'sc-dg-label');
  const rr = dgText(460, 255, 'sc-dg-label');
  root.append(
    svgEl('path', { d: 'M83 122V44H229', class: 'sc-dg-line' }),
    svgEl('path', { d: 'M387 44H533V122', class: 'sc-dg-line' }),
    direct, relL, relR,
    dgText(156, 30, 'sc-dg-label', 'ANGEBOT · ANTWORT'),
    dgText(460, 30, 'sc-dg-label', 'PGP-VERSCHLÜSSELT'),
    d1, d2, rl, rr);
  dgBox(root, 8, 126, 150, 60, 'DU', 'dein Gerät');
  dgBox(root, 233, 14, 150, 60, own ? 'DEIN SERVER' : host.length <= 18 ? host : 'SERVER', 'nur Vermittlung');
  dgBox(root, 458, 126, 150, 60, 'GEGENÜBER', 'sein Gerät');
  dgBox(root, 233, 238, 150, 60, own ? 'DEIN RELAY' : 'RELAY (TURN)',
    own ? 'coturn oder Cloudflare' : relayOk ? (relayHost() || 'eingerichtet') : 'nicht eingerichtet');

  const offer = el('span', { class: 'sc-dg-fact-value' });
  const seen = el('span', { class: 'sc-dg-fact-value' });
  const operator = el('span', { class: 'sc-dg-fact-value' });
  const box = el('input', { type: 'checkbox', disabled: !relayOk });
  const draw = (on) => {
    direct.setAttribute('class', 'sc-dg-flow' + (on ? ' is-faint' : ''));
    relL.setAttribute('class', 'sc-dg-flow ' + (on ? 'is-safe' : 'is-faint'));
    relR.setAttribute('class', 'sc-dg-flow is-safe' + (on ? '' : ' is-gone'));
    d1.textContent = on ? 'KEIN DIREKTER WEG' : 'TON · BILD · BILDSCHIRM';
    d2.textContent = on ? 'DEINE IP BLEIBT VERBORGEN' : 'DIREKT – ABSENDER: DEINE IP';
    d2.setAttribute('class', 'sc-dg-label ' + (on ? 'is-safe' : 'is-accent'));
    rl.textContent = on ? 'RELAY' : 'STUN-ABFRAGE';
    rr.textContent = on ? 'RELAY' : '';
    offer.textContent = on ? 'nur Adressen des Relays' : 'deine Heimnetz-Adresse und deine öffentliche IP' + (relayOk ? ', dazu das Relay' : '');
    seen.textContent = on ? 'nur das Relay' + (!own && relayHost() ? ' (' + relayHost() + ')' : '') : 'deine IP-Adresse';
    seen.className = 'sc-dg-fact-value ' + (on ? 'is-safe' : 'is-accent');
    operator.textContent = own
      ? 'nur du als Betreiber (und dein Hoster): IP-Adressen und Zeitpunkte – keine Inhalte' + (on ? '; das Relay auch nur verschlüsselte Pakete' : '')
      : (host + ': IP-Adressen und Zeitpunkte – keine Inhalte') + (on ? '; das Relay' + (relayHost() ? ' (' + relayHost() + ')' : '') + ' ebenso' : '');
    root.setAttribute('aria-label', 'Anruf: Das Verbindungsangebot läuft PGP-verschlüsselt über ' + host + '. ' + (on
      ? 'Ton und Bild laufen über das Relay; das Gegenüber sieht nur das Relay.'
      : 'Ton und Bild laufen direkt; das Gegenüber sieht deine IP-Adresse.'));
  };
  box.checked = own || hidingIp();
  box.addEventListener('change', () => draw(box.checked));
  draw(box.checked);
  return el('div', { class: 'sc-dg' },
    el('div', { class: 'sc-dg-scroll' }, root),
    el('div', { class: 'sc-dg-facts' },
      el('div', { class: 'sc-dg-fact' }, el('span', { class: 'sc-dg-fact-label', text: 'Im Angebot – schon beim Klingeln' }), offer),
      el('div', { class: 'sc-dg-fact' }, el('span', { class: 'sc-dg-fact-label', text: 'Das Gegenüber sieht' }), seen),
      el('div', { class: 'sc-dg-fact' }, el('span', { class: 'sc-dg-fact-label', text: 'Der Betreiber sieht' }), operator)),
    el('label', { class: 'sc-check' + (relayOk ? '' : ' is-disabled') }, box, el('span', { text: own
      ? 'Mit „IP verbergen“ zeigen. Auf dem eigenen Server braucht das ein Relay (TURN): ein eigenes mit coturn oder Cloudflare mit eigenem Schlüssel.'
      : relayOk
        ? 'Mit „IP verbergen“ zeigen. Bei dir ist es gerade ' + (hidingIp() ? 'an' : 'aus') + ' – einstellen unter Einstellungen → ANRUFE.'
        : '„IP verbergen“ braucht einen Relay-Server (TURN), der auf diesem Server nicht eingerichtet ist.' })),
    own ? el('p', { class: 'sc-note', text: 'Zu Hause betrieben und aus dem Internet erreichbar, sehen alle Nutzer deine Heim-IP – für Nutzung übers Internet besser einen Webspace oder gemieteten Server nehmen.' }) : null);
}

/* Wo und wie verschlüsselt wird – je Art: auf deinem Gerät, beim Server, beim Empfänger. */
const SEAL = [
  { id: 'dm', tab: 'Direkt', right: 'GEGENÜBER', rightSub: 'sein privater Schlüssel', where: 'BEIM GEGENÜBER',
    algo: 'OPENPGP · AES-256 · X25519 · ED25519',
    me: 'Für jede Nachricht ein neuer AES-256-Schlüssel. OpenPGP packt ihn für den Empfänger und für dich ein (X25519) und signiert die Nachricht (Ed25519). Vorher wird sie auf eine feste Größe aufgefüllt.',
    server: 'Legt nur den Chiffretext in den Briefkasten des Empfängers – ohne Absender, mit Ablaufdatum. Unterwegs schützt zusätzlich TLS.',
    peer: 'Packt den Schlüssel mit seinem privaten Schlüssel aus, entschlüsselt und prüft deine Signatur.' },
  { id: 'room', tab: 'Raum', right: 'MITGLIEDER', rightSub: 'kennen den Raumschlüssel', where: 'BEI DEN MITGLIEDERN',
    algo: 'AES-256-GCM · RAUMSCHLÜSSEL · PGP-SIGNATUR',
    me: 'Verschlüsselt mit dem Raumschlüssel (AES-256-GCM) und signiert mit deinem PGP-Schlüssel. Den Raumschlüssel kennen nur Mitglieder – im Einladungslink steht er hinter „#“ und geht nie an den Server.',
    server: 'Speichert den Chiffretext im Raumverlauf. Auch Raumname, Kanäle und Raumbild sind verschlüsselt; er kennt nur eine zufällige Kennung.',
    peer: 'Jedes Mitglied entschlüsselt mit dem Raumschlüssel und prüft die Signatur. Wer den Raum verlässt, bekommt den nächsten Schlüssel nicht mehr.' },
  { id: 'call', tab: 'Anruf', right: 'GEGENÜBER', rightSub: 'sein privater Schlüssel', where: 'BEIM GEGENÜBER',
    algo: 'OPENPGP · NUR DAS VERBINDUNGSANGEBOT', media: 'TON · BILD: DTLS-SRTP – NICHT ÜBER DEN SERVER',
    me: 'Das Verbindungsangebot wird wie eine Direktnachricht verschlüsselt und signiert. Ton, Bild und Bildschirm verschlüsselt WebRTC mit DTLS-SRTP – die Schlüssel dafür handeln nur die beiden Geräte aus.',
    server: 'Reicht nur das verschlüsselte Angebot weiter. Ton und Bild laufen nicht über ihn, sondern direkt oder über das Relay, das nur verschlüsselte Pakete sieht.',
    peer: 'Entschlüsselt das Angebot und prüft die Signatur. Der Sicherheitscode aus beiden DTLS-Fingerabdrücken zeigt, dass niemand dazwischensitzt.' },
  { id: 'status', tab: 'Status', right: 'FREUNDE', rightSub: 'kennen euer Geheimnis', where: 'BEI DEINEN FREUNDEN',
    algo: 'AES-256-GCM · SCHLÜSSEL PER HKDF',
    me: 'Aus eurem gemeinsamen Geheimnis – es kam PGP-verschlüsselt mit der Freundschaftsanfrage – entstehen per HKDF zwei zufällige Fächer und ein Schlüssel. Dein Status geht AES-256-GCM-verschlüsselt in dein Fach.',
    server: 'Sieht nur ein zufälliges Fach mit Chiffretext; nach 150 Sekunden ist es weg. Wem es gehört und wer mit wem befreundet ist, weiß er nicht.',
    peer: 'Dein Freund kennt das Geheimnis, liest dein Fach und entschlüsselt deinen Status.' },
  { id: 'vault', tab: 'Tresor', right: 'DEINE GERÄTE', rightSub: 'nach der Anmeldung', where: 'AUF DEINEN GERÄTEN',
    algo: 'AES-256-GCM · PBKDF2 → HKDF',
    me: 'Kontakte, Raumschlüssel und Einstellungen liegen im Tresor. Ihn und deinen privaten Schlüssel verschlüsselt ein Schlüssel aus deinem Passwort (PBKDF2 mit 600.000 Runden, dann HKDF) oder Wiederherstellungscode – AES-256-GCM.',
    server: 'Bewahrt beides nur verschlüsselt auf. Vom Passwort kennt er nur den bcrypt-Hash eines daraus abgeleiteten Anmeldeschlüssels.',
    peer: 'Nach der Anmeldung entschlüsseln deine anderen Geräte den Tresor. Das Passwort verlässt nie ein Gerät. Temporäre Sitzungen haben keinen Tresor beim Server.' }
];

function sealDiagram(own) {
  const host = serverHost();
  const root = svgEl('svg', { viewBox: '0 0 616 166', role: 'img' });
  const algo = dgText(308, 122, 'sc-dg-label is-accent');
  const media = svgEl('path', { d: 'M83 144H533', class: 'sc-dg-flow is-safe' });
  const mediaText = dgText(308, 158, 'sc-dg-label is-safe');
  root.append(
    svgEl('path', { d: 'M158 44H233M383 44H458', class: 'sc-dg-wire' }),
    dgText(195.5, 32, 'sc-dg-label', 'TLS'),
    dgText(420.5, 32, 'sc-dg-label', 'TLS'),
    svgEl('path', { d: 'M83 74V104M308 74V104M533 74V104', class: 'sc-dg-line' }),
    svgEl('path', { d: 'M83 104H533', class: 'sc-dg-seal' }),
    dgLock(83, 104, false), dgLock(533, 104, true),
    algo, media, mediaText);
  dgBox(root, 8, 14, 150, 60, 'DEIN GERÄT', 'privater Schlüssel');
  dgBox(root, 233, 14, 150, 60, own ? 'DEIN SERVER' : host.length <= 18 ? host : 'SERVER', 'sieht nur Chiffretext');
  const right = dgBox(root, 458, 14, 150, 60, '', '');

  const cols = el('div', { class: 'sc-dg-cols' });
  const col = (label) => {
    const l = el('span', { class: 'sc-dg-col-label', text: label });
    const p = el('p');
    cols.appendChild(el('div', { class: 'sc-dg-col' }, l, p));
    return { label: l, text: p };
  };
  const me = col('AUF DEINEM GERÄT');
  const server = col('BEIM SERVER');
  const peer = col('');
  const tabs = el('div', { class: 'sc-tabs sc-dg-tabs', role: 'tablist' });
  const show = (kind) => {
    const k = SEAL.find((s) => s.id === kind) || SEAL[0];
    for (const b of tabs.children) b.setAttribute('aria-selected', b.dataset.kind === k.id ? 'true' : 'false');
    right.title.textContent = k.right;
    right.sub.textContent = k.rightSub;
    root.setAttribute('viewBox', '0 0 616 ' + (k.media ? 166 : 134));   // Ton/Bild-Zeile nur beim Anruf
    algo.textContent = k.algo;
    media.setAttribute('class', 'sc-dg-flow is-safe' + (k.media ? '' : ' is-gone'));
    mediaText.textContent = k.media || '';
    me.text.textContent = k.me;
    server.text.textContent = k.server;
    peer.label.textContent = k.where;
    peer.text.textContent = k.peer;
    root.setAttribute('aria-label', k.tab + ': ' + k.me + ' ' + k.server + ' ' + k.peer);
  };
  for (const k of SEAL) {
    tabs.appendChild(el('button', { type: 'button', class: 'sc-tab', role: 'tab', dataset: { kind: k.id }, text: k.tab, onclick: () => show(k.id) }));
  }
  show('dm');
  return el('div', { class: 'sc-dg' }, tabs, el('div', { class: 'sc-dg-scroll' }, root), cols);
}

function showSecurityInfo() {
  openModal({
    title: 'SO FUNKTIONIERT CLAVICHAT',
    wide: true,
    build: (body) => {
      const block = (title, lines) => {
        body.appendChild(sectionHead(title));
        const ul = el('ul', { class: 'sc-info' });
        for (const l of lines) ul.appendChild(el('li', { text: l }));
        body.appendChild(ul);
      };
      // Ansicht: dieser Server oder selbst betrieben (eigener Server, eigenes Relay)
      const callBox = el('div');
      const sealBox = el('div');
      const view = el('div', { class: 'sc-tabs sc-dg-tabs sc-dg-view', role: 'tablist', 'aria-label': 'Ansicht' });
      const setView = (own) => {
        for (const b of view.children) b.setAttribute('aria-selected', String(b.dataset.own === String(own)));
        callBox.replaceChildren(callDiagram(own));
        sealBox.replaceChildren(sealDiagram(own));
      };
      for (const [own, label] of [[false, 'Dieser Server (' + serverHost() + ')'], [true, 'Selbst betrieben']]) {
        view.appendChild(el('button', { type: 'button', class: 'sc-tab', role: 'tab', dataset: { own: String(own) }, text: label, onclick: () => setView(own) }));
      }
      setView(false);
      body.append(
        el('p', { class: 'sc-p sc-dg-intro', text: 'Ende-zu-Ende verschlüsselt heißt: Ver- und entschlüsselt wird nur auf den Geräten. Der Server vermittelt und speichert – aber nur Chiffretext. Das gilt genauso, wenn du Server und Relay selbst betreibst.' }),
        view,
        sectionHead('SO LÄUFT EIN ANRUF'), callBox,
        sectionHead('WO VERSCHLÜSSELT WIRD'), sealBox);
      block('VERSCHLÜSSELUNG', [
        'Deine Identität ist ein OpenPGP-Schlüsselpaar (Curve25519: Ed25519 signiert, X25519 verschlüsselt). Es entsteht ' + (DESKTOP ? 'in der App' : 'in deinem Browser') + '.',
        'Direktnachrichten: Für jede Nachricht ein neuer, zufälliger AES-256-Schlüssel, der mit den öffentlichen Schlüsseln von Empfänger und Absender eingepackt wird. Dazu deine Signatur.',
        'Räume: ein gemeinsamer Raumschlüssel (AES-256-GCM). Er steht im Einladungslink hinter dem „#“ – dieser Teil einer Adresse geht nie an einen Server – oder kommt PGP-verschlüsselt vom Besitzer. Verlässt jemand den Raum, gibt es einen neuen.',
        'Anrufe und Bildschirm: WebRTC direkt zwischen den Geräten, verschlüsselt mit DTLS-SRTP. Die Schlüssel dafür handeln nur die beiden Browser aus; die Verbindungsangaben sind signiert und verschlüsselt, der Sicherheitscode zeigt, dass niemand dazwischensitzt.',
        'Konten: Aus deinem Passwort entstehen ' + LOCAL + ' (PBKDF2, 600.000 Runden, dann HKDF) ein Anmeldeschlüssel – beim Server nur als Hash – und ein Schlüssel, der deinen privaten Schlüssel einpackt. Das Passwort selbst verlässt ' + (DESKTOP ? 'die App' : 'den Browser') + ' nie.',
        'Konto mit achterberg.dev: Das Postfach bestätigt nur, wer du bist – mit einem signierten Ticket, das fünf Minuten und nur einmal gilt. Deinen Schlüssel schützt statt eines Passworts ein Wiederherstellungscode aus 160 Zufallsbits (HKDF-SHA-256). Ihn kennst nur du; der Server sieht ihn nie.',
        'Freunde: Die Anfrage bringt ein gemeinsames Geheimnis mit (PGP-verschlüsselt). Daraus entstehen zwei zufällige Fächer beim Server und ein Schlüssel; dein Status liegt dort verschlüsselt (AES-256-GCM). Der Server weiß nicht, wer mit wem befreundet ist.',
        'Forward Secrecy: Der Schlüssel für Nachrichten an dich wechselt jede Woche; alte werden gelöscht, sobald alles damit Verschlüsselte abgelaufen ist. Raumschlüssel wechselt der Besitzer ebenfalls wöchentlich.',
        'Dateien und Bilder: Jede Datei bekommt einen eigenen Zufallsschlüssel (AES-256-GCM); Schlüssel, Name und Vorschau stehen nur in der verschlüsselten Nachricht. Bilder gehen ohne Metadaten wie den Aufnahmeort raus.',
        'Auf dem Gerät: Mit App-Sperre ist die gespeicherte Anmeldung nur mit deiner PIN verschlüsselt (PBKDF2, 600.000 Runden)' + (DESKTOP ? ' und zusätzlich an dein Windows-Konto gebunden.' : '.')
      ]);
      block('VERSCHLEIERUNG', [
        'Alle Klartexte werden vor dem Verschlüsseln auf feste Größen aufgefüllt – „ok“ und ein langer Absatz sind gleich groß.',
        'Beim Server steht an keiner Nachricht ein Absender; wer schreibt, steht nur verschlüsselt und signiert im Inneren.',
        'Raumnamen, Raumbilder, Kanäle und Kontakte sind verschlüsselt. Der Server kennt nur zufällige Kennungen.',
        'Konten stehen nie in der Online-Liste; ob sie online sind, sehen nur ihre Freunde. In der Liste erscheinen nur temporäre Sitzungen – und auch die nur, solange sie es wollen.',
        'Alle Anfragen gehen per POST an dieselbe Adresse. In den Protokollen des Webservers steht nicht, was passiert ist.',
        'Keine Cookies (einzige Ausnahme: „Mit achterberg.dev“ fragt auf deinen Klick das Dashboard nach deinem Postfach), keine fremden Server auf dieser Seite (auch keine Schriften von Google), strenge Content-Security-Policy.',
        'Anruf-Signale verfallen nach zwei Minuten. Nachrichten bleiben so lange, wie es für die Unterhaltung eingestellt ist (Standard ' + ttlLabel(defaultTtl()) + ', höchstens ' + S.cfg.retention_days + ' Tage) – dann löscht sie der Server. Temporäre Sitzungen verschwinden nach ' + S.cfg.temp_hours + ' Stunden ohne Nutzung, Räume aus temporären Sitzungen nach ' + tempRoomDays() + ' Tagen ohne Aktivität.'
      ]);
      block('WAS DER SERVER TROTZDEM SIEHT', [
        'IP-Adressen und Zeitpunkte der Anfragen (der Webserver des Hosters protokolliert sie).',
        'Wer gerade online ist, welche öffentlichen Schlüssel, Namen/Aliasse und Profilbilder (nur Konten) es gibt, wer in welchem Raum ist und wer in welchem Sprachkanal.',
        'Welcher Briefkasten wann wie viele Einträge bekommt; bei Dateien Größe und Zeitpunkt.',
        'Dass ein Status-Fach beschrieben oder gelesen wird – nicht, wem es gehört, und nicht den Status selbst. Im Moment der Anfrage sieht er, wer fragt; gespeichert wird das nicht.',
        'Ohne „IP verbergen“ sehen sich die Gesprächspartner gegenseitig die IP-Adresse – sie steht schon im Verbindungsangebot, das beim Klingeln ankommt. Mit „IP verbergen“ (bei temporären Sitzungen von Haus aus an) läuft alles über den Relay-Server; dessen Betreiber sieht die IP-Adressen, aber keine Inhalte.'
      ]);
      block('GRENZEN', [
        DESKTOP
          ? 'Die Windows-App bringt ihren Programmcode selbst mit. Der Server kann ihn nicht austauschen, er reicht nur Chiffretext weiter. Neuer Code kommt nur mit einer neuen Fassung der App.'
          : 'Wie jede Web-App lädt Clavichat seinen Programmcode vom Server. Ein Hoster, der gezielt manipulierten Code ausliefert, könnte das umgehen. Gegen Mitlesen auf dem Server, gestohlene Datenbanken und Lauscher im Netz schützt Clavichat vollständig. Die Windows-App bringt ihren Code selbst mit.',
        'Forward Secrecy gibt es wochenweise, nicht für jede einzelne Nachricht: Wer an deinen privaten Schlüssel kommt, kann Nachrichten lesen, deren Schlüssel noch nicht gelöscht ist (etwa die letzten fünf Wochen). Anrufe sind davon nicht betroffen, ihre Schlüssel gelten nur für das eine Gespräch.',
        'Die Sicherheit steht und fällt mit der Prüfung der Fingerabdrücke. Verifiziere wichtige Kontakte über einen zweiten Weg.'
      ]);
      const ext = (href, text) => el('a', { href, target: '_blank', rel: 'noopener noreferrer', text });
      body.append(sectionHead('OPEN SOURCE'),
        el('p', { class: 'sc-p sc-about' }, 'Clavichat ist Open Source (MIT): Web-App, Server und Windows-App – zum Nachprüfen und selbst Betreiben. ',
          ext('https://github.com/mxachterberg/Clavichat', 'Quellcode auf GitHub ↗')),
        el('p', { class: 'sc-p sc-about sc-by' }, 'Ein Projekt von ', ext('https://achterberg.dev/projects.html', 'Max Achterberg ↗')));
    }
  });
}

/* ==========================================================================
   Eingaben und Ereignisse
   ========================================================================== */
function bind() {
  $('sc-home').addEventListener('click', () => setView({ kind: 'home' }));
  $('sc-add-room').addEventListener('click', roomDialog);
  // Meeting starten: eigener Knopf unter „Raum erstellen“, deutlich als Meeting erkennbar.
  const meetBtn = el('button', { type: 'button', class: 'sc-rail-btn sc-rail-meet', id: 'sc-add-meet', title: 'Meeting starten', 'aria-label': 'Meeting starten', onclick: () => confirmMeeting() },
    icon('group', 19), el('span', { class: 'sc-rail-meet-label', text: 'MEET' }));
  $('sc-add-room').insertAdjacentElement('afterend', meetBtn);
  $('sc-scrim').addEventListener('click', () => toggleSide(false));
  $('sc-modal').addEventListener('mousedown', (ev) => { if (ev.target === $('sc-modal')) closeModal(); });

  const input = $('sc-input');
  input.addEventListener('input', () => { autoGrow(); typingPing(); });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      $('sc-compose').requestSubmit();
    }
  });
  // Dateien: Büroklammer, Hereinziehen, Einfügen aus der Zwischenablage.
  const picker = el('input', { type: 'file', multiple: true, hidden: true, tabindex: '-1' });
  picker.addEventListener('change', () => {
    const files = [...picker.files];
    picker.value = '';
    if (files.length) sendFiles(files);
  });
  $('sc-compose').prepend(el('button', { type: 'button', class: 'sc-attach', id: 'sc-attach', title: 'Datei oder Bild senden', 'aria-label': 'Datei oder Bild senden', onclick: () => picker.click() }, icon('clip', 18)), picker);
  input.addEventListener('paste', (ev) => {
    const files = [...((ev.clipboardData && ev.clipboardData.files) || [])];
    if (!files.length || !filesSupported()) return;
    ev.preventDefault();
    confirmFiles(files);
  });
  const stage = $('sc-compose').parentElement;
  let dragDepth = 0;
  const hasFiles = (ev) => ev.dataTransfer && [...ev.dataTransfer.types].includes('Files') && filesSupported() && !!sendTarget();
  stage.addEventListener('dragenter', (ev) => { if (!hasFiles(ev)) return; ev.preventDefault(); dragDepth++; stage.classList.add('is-drop'); });
  stage.addEventListener('dragover', (ev) => { if (hasFiles(ev)) { ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy'; } });
  stage.addEventListener('dragleave', () => { if (dragDepth && !--dragDepth) stage.classList.remove('is-drop'); });
  stage.addEventListener('drop', (ev) => {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    dragDepth = 0;
    stage.classList.remove('is-drop');
    confirmFiles([...ev.dataTransfer.files]);
  });

  $('sc-compose').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const body = cleanText(input.value).trim();
    if (!body) return;
    input.value = '';
    autoGrow();
    if (S.view.kind === 'dm') sendDm(S.view.peer, body);
    else if (S.view.kind === 'room') sendRoomMessage(S.rooms.get(S.view.rid), S.view.ch, body);
  });

  document.addEventListener('keydown', (ev) => {
    if (L.locked) return;
    // Strg+L: App sperren (nur mit PIN).
    if (L.cfg && S.entered && (ev.ctrlKey || ev.metaKey) && !ev.altKey && !ev.shiftKey && (ev.key === 'l' || ev.key === 'L')) {
      ev.preventDefault();
      lockNow();
      return;
    }
    if (ev.key === 'Escape' && ctxMenu) { ev.preventDefault(); closeContextMenu(); return; }
    if (ev.key === 'Escape' && modalClose) { ev.preventDefault(); closeModal(); }
  });
  document.addEventListener('pointerdown', (ev) => { if (ctxMenu && !ctxMenu.contains(ev.target)) closeContextMenu(); }, true);
  document.addEventListener('scroll', closeContextMenu, true);
  window.addEventListener('resize', closeContextMenu);
  window.addEventListener('blur', closeContextMenu);
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && screen.orientation && screen.orientation.unlock) {
      try { screen.orientation.unlock(); } catch (e) { /* nicht gesperrt */ }
    }
  });
  // Einladungslink in einen schon offenen Clavichat-Tab eingefügt: Die Seite
  // lädt dann nicht neu, nur der Teil hinter "#" ändert sich.
  window.addEventListener('hashchange', () => {
    if (!/^#(join|meet|once)=/.test(location.hash)) return;
    parseJoinFragment();
    if (S.entered) offerPendingJoin();
    else if (!$('sc-gate').hidden) {
      if (S.pendingJoin && S.pendingJoin.once) showGuestJoin();
      else {
        // Raum nur für Konten? Dann gleich die Kontoerstellung.
        const join = S.pendingJoin;
        inviteAccountsOnly(join).then((ao) => {
          if (join && S.pendingJoin === join) { join.ao = ao; ssSet(JOIN_KEY, join); }
          if (!S.entered) renderGate(ao ? 'register' : 'temp');
        });
      }
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { markRead(); scheduleRender(); if (S.wake) S.wake(); return; }
    // Wartet noch ein Zeichnen auf requestAnimationFrame, das jetzt ruht:
    // per Zeitgeber nachholen.
    if (renderQueued) { renderQueued = false; scheduleRender(); }
  });
  $('sc-thread').addEventListener('scroll', () => {
    const t = $('sc-thread');
    if (t.scrollHeight - t.scrollTop - t.clientHeight < 40) markRead();
  });

  // Beim Verlassen der Seite: Gegenüber Bescheid geben (vorbereitetes Signal).
  window.addEventListener('pagehide', () => {
    const headers = { 'Content-Type': 'application/json', 'X-SC-Token': S.token || '' };
    try {
      if (S.call && S.call.bye) {
        fetch(API_URL, { method: 'POST', keepalive: true, credentials: 'omit', headers: headers, body: JSON.stringify({ a: 'send', to: S.call.peerId, k: 'sig', d: S.call.bye }) });
      }
      if (S.voice) {
        fetch(API_URL, { method: 'POST', keepalive: true, credentials: 'omit', headers: headers, body: JSON.stringify({ a: 'room.voice', id: S.voice.rid, on: false }) });
      }
      // Freunde sehen sofort „offline“, nicht erst nach 150 Sekunden.
      if (P.published.size) {
        fetch(API_URL, { method: 'POST', keepalive: true, credentials: 'omit', headers: headers, body: JSON.stringify({ a: 'pres', del: [...P.published] }) });
        P.putSig = '';   // kommt die Seite zurück (Zurück-Taste), gleich neu schreiben
      }
    } catch (e) { /* Seite ist weg */ }
  });
}

/** Hell/Dunkel – derselbe Schlüssel wie auf der übrigen Website. */
function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem('theme', theme); } catch (e) { /* privater Modus */ }
  const btn = document.querySelector('.theme-btn');
  if (btn) btn.setAttribute('aria-label', theme === 'dark' ? 'Zu hell wechseln' : 'Zu dunkel wechseln');
}

/** Im Dashboard eingebettet: Hell/Dunkel folgt der Übersicht. */
function syncTheme() {
  window.addEventListener('storage', (ev) => {
    if (ev.key === 'theme' && (ev.newValue === 'light' || ev.newValue === 'dark')) {
      document.documentElement.setAttribute('data-theme', ev.newValue);
    }
  });
}

bind();
boot().catch((e) => {
  console.error(e);
  bootFail('Start fehlgeschlagen: ' + (e && e.message ? e.message : String(e)));
});
