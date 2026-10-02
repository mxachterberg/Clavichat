/* ==========================================================================
   SecureCom — Oberfläche, Nachrichten, Räume und Anrufe
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
const API_URL  = (SCRIPT && SCRIPT.dataset.api) || '/app/securecom/api.php';
const WEB_URL  = (SCRIPT && SCRIPT.dataset.web) || (location.origin + '/app/securecom/');
const DESKTOP  = window.securecomDesktop || null;   // nur in der Windows-App
// Wo ein temporärer Schlüssel lebt – im Browser-Tab oder in der laufenden App.
const KEY_HOME = DESKTOP ? 'solange die App läuft' : 'in diesem Tab';
// Wo Schlüssel entstehen und Passwörter bleiben.
const LOCAL    = DESKTOP ? 'in der App' : 'im Browser';
const SS_KEY   = 'securecom.session';
const JOIN_KEY = 'securecom.join';
const SLOTS    = ['mic', 'cam', 'screen', 'screenAudio'];
const SLOT_KIND = { mic: 'audio', cam: 'video', screen: 'video', screenAudio: 'audio' };

/* ==========================================================================
   Zustand
   ========================================================================== */
const S = {
  cfg: null,
  token: null,
  me: null,            // { id, kind, name, fp, priv, pub, armored, vis }
  mode: null,          // 'temp' | 'account'
  wrapKey: null,       // Konten: packt Schlüssel und Tresor ein
  username: null,
  vault: null,
  vv: 1,               // Tresor-Version beim Server
  ids: new Map(),      // Kennung -> Identität (Schlüssel geprüft, Karte signiert)
  keyringCache: null,
  online: [],          // temporäre Sitzungen, die gerade online und sichtbar sind
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
  radio: '<path d="M9 8V3M15 8V6"/><rect x="6" y="8" width="12" height="14" rx="2"/><path d="M9.5 12h5M9.5 15h5M12 18.5h.01"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="1"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5L5 20"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>',
  video: '<rect x="3" y="6" width="13" height="12" rx="1"/><path d="M16 10l5-3v10l-5-3z"/>',
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
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16"/><path d="M20 20v-4h-4"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/>',
  leave: '<path d="M14 4H6v16h8M17 8l4 4-4 4M21 12H10"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path d="M3 3l18 18"/>',
  userPlus: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M19 8v6M16 11h6"/>'
};

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

/** Wie append(), überspringt aber null (append() würde "null" schreiben). */
function appendAll(parent) {
  for (let i = 1; i < arguments.length; i++) {
    const c = arguments[i];
    if (c !== null && c !== undefined && c !== false) parent.append(c);
  }
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

function cleanName(value) {
  return cleanText(value, 40).replace(/\s+/g, ' ').trim();
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

function field(label, input, note) {
  return el('label', { class: 'field' },
    el('span', { class: 'field-label', text: label }),
    input,
    note ? el('span', { class: 'sc-field-note', text: note }) : null);
}

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
    // Ohne Cookies: SecureCom braucht keine, und so geht auch die
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
    if (res.status === 401 && S.entered && a !== 'login' && a !== 'logout') sessionLost();
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
  return { v: 1, contacts: {}, rooms: {}, blocked: {}, reads: {}, cleared: {}, settings: { hideIp: false, sound: true, mic: '' } };
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
    }
    Object.assign(out.blocked, src.blocked || {});
    for (const [k, t] of Object.entries(src.reads || {})) out.reads[k] = Math.max(out.reads[k] || 0, t || 0);
    for (const [k, t] of Object.entries(src.cleared || {})) out.cleared[k] = Math.max(out.cleared[k] || 0, t || 0);
  }
  return out;
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
    fp: raw.fp,
    key: key,
    armored: raw.pub,
    cv: raw.cv,
    name: cleanName(card.name),
    // Profilbild: nur Konten; die signierte Karte nennt seinen SHA-256-Wert.
    av: raw.k === 'account' && /^[0-9a-f]{64}$/.test(card.av || '') ? card.av : null,
    on: 'on' in raw ? raw.on : (cur ? cur.on : null),
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
  return el('span', { class: 'sc-kind', text: ident.kind === 'temp' ? 'TEMP' : 'KONTO', title: ident.kind === 'temp' ? 'Temporäre Sitzung' : 'Konto' });
}

/* ==========================================================================
   Anmeldung: temporär, Konto, Konto erstellen
   ========================================================================== */
function gateCard() { return $('sc-gate-card'); }

function showGate(message) {
  $('sc').hidden = true;
  $('sc-gate').hidden = false;
  renderGate('temp', message);
  bootDone();
}

function renderGate(tab, message) {
  const card = gateCard();
  card.textContent = '';
  card.append(
    el('p', { class: 'section-head' }, el('span', { class: 'sq' }), el('span', { class: 'label', text: 'SECURECOM' }), el('span', { class: 'rule' })),
    el('h1', { class: 'sc-gate-title', text: 'Sicher schreiben & telefonieren' }),
    el('p', { class: 'sc-gate-sub', text: 'Ende-zu-Ende verschlüsselt: Deine Schlüssel entstehen ' + (DESKTOP ? 'in dieser App' : 'in diesem Browser') + '. Der Server leitet nur Verschlüsseltes weiter – auch der Hoster kann nicht mitlesen oder mithören.' })
  );
  if (S.pendingJoin) {
    card.appendChild(el('p', { class: 'sc-gate-invite' }, icon('link', 15), 'Du wurdest in einen Raum eingeladen. Melde dich an oder starte eine temporäre Sitzung – danach trittst du bei.'));
  }
  const tabs = el('div', { class: 'sc-tabs', role: 'tablist' });
  const panel = el('div', { class: 'sc-gate-panel' });
  [['temp', 'Temporär'], ['login', 'Anmelden'], ['register', 'Konto erstellen']].forEach(([key, label]) => {
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
  return field('Zugangscode', input, 'SecureCom ist hier nur mit Code offen.');
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
  panel.appendChild(form);
}

function gateLogin(panel) {
  const user = el('input', { type: 'text', autocomplete: 'username', maxlength: '24', spellcheck: 'false', required: true });
  const pass = el('input', { type: 'password', autocomplete: 'current-password', required: true });
  const remember = el('input', { type: 'checkbox', checked: true });
  const go = el('button', { type: 'submit', class: 'btn btn--primary btn--block', text: 'Anmelden' });
  const form = el('form', { class: 'sc-gate-form' },
    field('Name', user), field('Passwort', pass),
    el('label', { class: 'sc-check' }, remember, el('span', { text: 'Auf diesem Gerät angemeldet bleiben' })),
    go,
    el('p', { class: 'sc-gate-note', text: 'Dein Passwort verlässt den Browser nicht. Aus ihm entsteht hier ein Anmeldeschlüssel und ein Schlüssel, der deinen privaten PGP-Schlüssel auspackt.' }));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    gateBusy(go, 'Passwort wird geprüft …');
    try {
      await loginAccount(user.value.trim(), pass.value, remember.checked);
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

  const form = el('form', { class: 'sc-gate-form' },
    field('Name', user, '3–24 Zeichen. Andere sehen dich unter diesem Namen. Keine E-Mail nötig.'),
    field('Passwort', pass, 'Mindestens 10 Zeichen. Lang ist besser als kompliziert.'),
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
    if (pass.value.length < 10) { toast('Das Passwort braucht mindestens 10 Zeichen.', 'error'); return; }
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
  ssSet(SS_KEY, { mode: 'temp', id: id, token: r.token, priv: C.armorPrivate(identity.privateKey), vault: S.vault });
  await enterApp();
  toast('Temporäre Sitzung läuft. Dein Schlüssel lebt nur ' + KEY_HOME + '.', 'ok');
}

async function registerAccount(username, password, identity, remember, code) {
  const keys = await C.deriveAccountKeys(username, password);
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
    card: card, wrapped: wrapped, vault: vault, code: code
  });
  S.token = r.token;
  S.mode = 'account';
  S.vv = r.vv || 1;
  setMe(identity, id, 'account', r.username || username, true);
  await rememberAccount(remember, r.username || username, id, r.token, wrapped, keys.wrapRaw);
  await enterApp();
  showKeyBackup(password, true);
}

async function loginAccount(username, password, remember) {
  if (!username || !password) throw new Error('Bitte Name und Passwort angeben.');
  const keys = await C.deriveAccountKeys(username, password);
  S.token = null;
  const r = await api('login', { username: username, auth: keys.auth });
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
  setMe(identity, r.id, 'account', r.username, r.vis !== false);
  await applyOwnCard(r.card);
  await rememberAccount(remember, r.username, r.id, r.token, r.wrapped, keys.wrapRaw);
  await enterApp();
}

/**
 * Angemeldet bleiben: in IndexedDB mit einem nicht auslesbaren
 * Schlüssel-Objekt. Sonst nur für diesen Tab (sessionStorage).
 */
async function rememberAccount(remember, username, id, token, wrapped, wrapRaw) {
  if (remember) {
    const key = await C.importWrapKey(wrapRaw, false);
    await idbSet('session', { mode: 'account', username: username, id: id, token: token, wrapped: wrapped, wrapKey: key });
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
  S.ids.set(id, { id: id, kind: kind, fp: identity.fingerprint, key: identity.publicKey, armored: identity.armoredPublic, cv: 0, name: S.me.name, on: true, changed: false });
  S.keyringCache = null;
}

/** Nach dem Neuladen: Sitzung aus dem Tab oder aus IndexedDB. */
async function restoreSession() {
  const ss = ssGet(SS_KEY);
  try {
    if (ss && ss.mode === 'temp') {
      const identity = await C.readPrivateIdentity(ss.priv);
      S.token = ss.token;
      S.mode = 'temp';
      S.vault = mergeVault(emptyVault(), ss.vault || {});
      setMe(identity, ss.id, 'temp', '', true);
    } else {
      const saved = ss && ss.mode === 'account' ? ss : await idbGet('session');
      if (!saved || saved.mode !== 'account') return false;
      const wrapKey = saved.wrapKey || await C.importWrapKey(C.unb64(saved.wrap), false);
      const identity = await C.readPrivateIdentity(await C.openText(wrapKey, saved.wrapped, keyAad(saved.username)));
      S.token = saved.token;
      S.mode = 'account';
      S.username = saved.username;
      S.wrapKey = wrapKey;
      S.vault = emptyVault();
      setMe(identity, saved.id, 'account', saved.username, true);
    }
  } catch (e) {
    await clearStoredSession();
    return false;
  }

  try {
    const me = await api('me');
    S.me.vis = S.mode === 'temp' && me.vis !== false;
    await applyOwnCard(me.card);
    if (S.mode === 'account') {
      const v = await api('vault.get');
      S.vv = v.vv;
      if (v.vault) S.vault = mergeVault(emptyVault(), JSON.parse(await C.openText(S.wrapKey, v.vault, vaultAad())));
    }
  } catch (e) {
    if (e.status === 401) { await clearStoredSession(); S.token = null; S.me = null; return false; }
    // Ohne Netz: trotzdem öffnen, der Abruf versucht es weiter.
  }
  return true;
}

async function clearStoredSession() {
  ssSet(SS_KEY, null);
  await idbSet('session', null);
}

let lost = false;
function sessionLost() {
  if (lost) return;
  lost = true;
  clearStoredSession().then(() => {
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
    try { await api('end'); } catch (e) { /* trotzdem lokal beenden */ }
  } else {
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
  $('sc-gate').hidden = true;
  $('sc').hidden = false;
  S.convs.clear();
  const saved = ssGet('securecom.view');
  if (saved && saved.kind) S.view = saved;
  renderAll();
  bootDone();
  refreshOnline();
  loadIce();
  await loadRooms().catch(() => {});
  if (S.view.kind === 'room' && !S.rooms.has(S.view.rid)) S.view = { kind: 'home' };
  if (S.view.kind === 'dm') await ensureIds([S.view.peer]);
  renderAll();
  pollLoop();
  if (S.pendingJoin) setTimeout(offerPendingJoin, 400);
}

function parseJoinFragment() {
  const m = /^#join=([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})\.(\d{1,6})$/.exec(location.hash || '');
  if (m) {
    S.pendingJoin = { rid: m[1], code: m[2], key: m[3], epoch: parseInt(m[4], 10) };
    ssSet(JOIN_KEY, S.pendingJoin);
    // Den Schlüssel sofort aus der Adresszeile (und dem Verlauf) nehmen.
    history.replaceState(null, '', location.pathname + location.search);
  } else {
    S.pendingJoin = ssGet(JOIN_KEY);
  }
}

async function offerPendingJoin() {
  const join = S.pendingJoin;
  if (!join) return;
  S.pendingJoin = null;
  ssSet(JOIN_KEY, null);
  if (S.rooms.has(join.rid)) { openRoom(join.rid); return; }
  const ok = await confirmBox('Einladung', 'Du wurdest in einen Raum eingeladen. Beitreten? Alle Mitglieder sehen dich danach in der Mitgliederliste.', 'Beitreten');
  if (ok) joinRoom(join);
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
  if (await restoreSession()) {
    await enterApp();
  } else {
    showGate();
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
  document.title = (ringing ? '📞 ' : '') + (n ? '(' + n + ') ' : '') + 'SecureCom';
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
  const rooms = [...S.rooms.values()].sort((a, b) => a.meta.name.localeCompare(b.meta.name, 'de'));
  for (const room of rooms) {
    let u = 0;
    for (const n of room.unread.values()) u += n;
    const b = el('button', {
      type: 'button',
      class: 'sc-rail-btn sc-rail-room' + (u ? ' has-unread' : '') + (room.vc.length ? ' has-voice' : '') + (room.meta.img ? ' has-img' : ''),
      title: room.meta.name,
      'aria-current': S.view.kind === 'room' && S.view.rid === room.id ? 'true' : 'false',
      onclick: () => openRoom(room.id)
    }, room.meta.img
      ? el('span', { class: 'sc-rail-initials sc-rail-pic' }, el('img', { src: room.meta.img, alt: '', draggable: 'false' }))
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
  if (S.view.kind === 'room' && S.rooms.has(S.view.rid)) renderRoomSide(head, body, S.rooms.get(S.view.rid));
  else renderHomeSide(head, body);
}

function renderHomeSide(head, body) {
  head.append(el('span', { class: 'sc-side-title', text: 'Direktnachrichten' }),
    iconBtn('key', 'Per Schlüssel anrufen oder schreiben', connectByKey));

  body.appendChild(el('button', { type: 'button', class: 'sc-entry tickbox', onclick: connectByKey },
    el('span', { class: 'sc-entry-icon' }, icon('key', 19)),
    el('span', { class: 'sc-entry-text' },
      el('span', { class: 'sc-entry-name', text: 'Per Schlüssel verbinden' }),
      el('span', { class: 'sc-entry-sub', text: 'Anrufen oder schreiben mit PGP-Schlüssel' }))));

  const online = S.online.map((id) => S.ids.get(id)).filter((i) => i && !isBlocked(i));
  body.appendChild(sectionHead('ONLINE — ' + online.length));
  const list = el('div', { class: 'sc-list' });
  if (!online.length) list.appendChild(el('p', { class: 'sc-empty-note', text: 'Gerade ist sonst niemand sichtbar online. Hier stehen nur temporäre Sitzungen – Konten zeigen nicht, ob sie online sind.' }));
  for (const ident of online) list.appendChild(personRow(ident, () => openDm(ident.id)));
  body.appendChild(list);

  const convs = [...S.convs.values()].filter((c) => c.msgs.length || (S.view.kind === 'dm' && S.view.peer === c.peer))
    .sort((a, b) => b.last - a.last);
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

function openContextMenu(x, y, items) {
  closeContextMenu();
  const menu = el('div', { class: 'sc-ctx', role: 'menu' });
  for (const it of items) {
    if (!it) continue;
    menu.appendChild(el('button', {
      type: 'button', role: 'menuitem', class: 'sc-ctx-item' + (it.danger ? ' is-danger' : ''), disabled: !!it.disabled,
      onclick: () => { closeContextMenu(); it.run(); }
    }, icon(it.icon, 15), el('span', { text: it.label })));
  }
  document.body.appendChild(menu);
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8)) + 'px';
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
    openContextMenu(ev.clientX || r.left + 24, ev.clientY || r.bottom, items());
  });
  node.addEventListener('pointerdown', (ev) => {
    if (ev.pointerType !== 'touch') return;
    start = { x: ev.clientX, y: ev.clientY };
    timer = setTimeout(() => { timer = 0; openContextMenu(start.x, start.y, items()); }, 550);
  });
  const cancel = () => { clearTimeout(timer); timer = 0; };
  node.addEventListener('pointerup', cancel);
  node.addEventListener('pointercancel', cancel);
  node.addEventListener('pointermove', (ev) => { if (start && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 10) cancel(); });
  // Nach langem Drücken nicht auch noch öffnen.
  node.addEventListener('click', (ev) => { if (Date.now() - ctxOpened < 700) { ev.preventDefault(); ev.stopImmediatePropagation(); } }, true);
}

function convMenuItems(conv) {
  return [
    { icon: 'check', label: 'Als gelesen markieren', disabled: !conv.unread, run: () => markConvRead(conv) },
    { icon: 'users', label: 'Profil anzeigen', run: () => showProfile(conv.peer) },
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
    el('span', { class: 'sc-row-av' }, avatar(ident), ident && ident.on ? el('span', { class: 'sc-on', title: 'online' }) : null),
    el('span', { class: 'sc-row-text' },
      el('span', { class: 'sc-row-name' }, el('span', { class: 'sc-row-label', text: displayName(ident) }),
        isVerified(ident) ? icon('shieldCheck', 13) : null,
        ident && ident.kind === 'temp' ? el('span', { class: 'sc-kind', text: 'TEMP' }) : null),
      el('span', { class: 'sc-row-sub', text: o.sub || (ident ? fpTail(ident.fp) : '') })),
    inCall ? icon('phone', 14) : null,
    o.unread ? el('span', { class: 'sc-count', text: o.unread > 99 ? '99+' : String(o.unread) }) : null);
  return row;
}

function renderRoomSide(head, body, room) {
  const isOwner = room.owner === S.me.id;
  appendAll(head, room.meta.img ? el('img', { class: 'sc-side-pic', src: room.meta.img, alt: '' }) : null,
    el('span', { class: 'sc-side-title', text: room.meta.name, title: room.meta.name }),
    iconBtn('more', 'Raum-Menü', () => roomMenu(room)));

  body.appendChild(sectionHead('TEXTKANÄLE', isOwner ? iconBtn('plus', 'Kanal anlegen', () => addChannel(room), { class: 'sc-ibtn sc-ibtn--tiny' }) : null));
  const chl = el('div', { class: 'sc-list' });
  for (const ch of room.meta.ch) {
    const u = room.unread.get(ch.id) || 0;
    chl.appendChild(el('button', {
      type: 'button',
      class: 'sc-chan' + (u ? ' has-unread' : ''),
      'aria-current': S.view.ch === ch.id ? 'true' : 'false',
      onclick: () => openRoom(room.id, ch.id)
    }, icon('hash', 15), el('span', { class: 'sc-chan-name', text: ch.name }),
    u ? el('span', { class: 'sc-count', text: String(u) }) : null));
  }
  body.appendChild(chl);

  body.appendChild(sectionHead('SPRACHKANÄLE', isOwner ? iconBtn('plus', 'Sprachkanal anlegen', () => addVoiceChannel(room), { class: 'sc-ibtn sc-ibtn--tiny' }) : null));
  const vbox = el('div', { class: 'sc-list' });
  for (const vch of room.meta.vch) {
    const inHere = !!(S.voice && S.voice.rid === room.id && S.voice.ch === vch.id);
    const people = voiceMembers(room, vch.id);
    vbox.appendChild(el('button', {
      type: 'button',
      class: 'sc-chan sc-chan--voice' + (inHere ? ' is-joined' : ''),
      title: inHere ? 'Du bist in diesem Sprachkanal' : 'Sprachkanal betreten',
      onclick: () => (inHere ? setView({ kind: 'room', rid: room.id, ch: S.view.ch }) : joinVoice(room.id, vch.id))
    }, icon('speaker', 15), el('span', { class: 'sc-chan-name', text: vch.name }),
    el('span', { class: 'sc-chan-meta', text: people.length ? people.length + '/' + (S.cfg.limits.voice || 8) : '' })));
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
    title = connected || !S.voice.peers.size ? 'Sprache verbunden' : 'Verbindet …';
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
  const sig = [S.me.name, avatarUrl(me) || '', S.me.vis, S.mode, S.me.fp, S.offline, M.micOn, M.deaf].join('|');
  if (box.dataset.sig === sig && box.firstChild) return;
  box.dataset.sig = sig;
  box.textContent = '';
  box.append(
    el('button', { type: 'button', class: 'sc-user-info', title: 'Dein Profil', onclick: () => showProfile(S.me.id) },
      el('span', { class: 'sc-row-av' }, avatar(me), el('span', { class: 'sc-on' + (S.me.vis ? '' : ' is-hidden'),
        title: S.me.vis ? 'sichtbar' : S.mode === 'account' ? 'Online-Status verborgen (Konto)' : 'unsichtbar' })),
      el('span', { class: 'sc-row-text' },
        el('span', { class: 'sc-row-name' }, el('span', { class: 'sc-row-label', text: S.me.name || (S.mode === 'temp' ? 'Temporär' : 'Ich') })),
        el('span', { class: 'sc-row-sub', text: (S.mode === 'temp' ? 'TEMP · ' : '') + fpTail(S.me.fp) + (S.offline ? ' · offline' : '') }))),
    iconBtn(M.micOn ? 'mic' : 'micOff', M.micOn ? 'Stummschalten' : 'Mikrofon an', toggleMic, { class: 'sc-ibtn' + (M.micOn ? '' : ' is-off') }),
    iconBtn(M.deaf ? 'headOff' : 'head', M.deaf ? 'Ton an' : 'Nichts hören', toggleDeaf, { class: 'sc-ibtn' + (M.deaf ? ' is-off' : '') }),
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
        el('span', { class: 'sc-row-av' }, avatar(ident, 'sm'), ident && ident.on ? el('span', { class: 'sc-on' }) : null),
        el('span', { class: 'sc-head-text' },
          el('span', { class: 'sc-head-title' }, displayName(ident), isVerified(ident) ? icon('shieldCheck', 14) : null, kindBadge(ident)),
          el('span', { class: 'sc-head-sub', text: ident ? C.shortFingerprint(ident.fp) : '' }))),
      el('span', { class: 'sc-head-spacer' }),
      iconBtn('phone', 'Anrufen', () => startCall(S.view.peer, false)),
      iconBtn('video', 'Videoanruf', () => startCall(S.view.peer, true)),
      iconBtn('users', 'Profil', () => { S.membersOpen = !S.membersOpen; renderAll(); }, { 'aria-pressed': S.membersOpen ? 'true' : 'false' }));
  } else if (S.view.kind === 'room' && S.rooms.has(S.view.rid)) {
    const room = S.rooms.get(S.view.rid);
    const ch = room.meta.ch.find((c) => c.id === S.view.ch);
    head.append(
      el('span', { class: 'sc-head-text' },
        el('span', { class: 'sc-head-title' }, icon('hash', 16), ch ? ch.name : '—'),
        el('span', { class: 'sc-head-sub', text: room.meta.name + ' · ' + room.members.length + ' Mitglieder' })),
      el('span', { class: 'sc-head-spacer' }),
      iconBtn('speaker', S.voice && S.voice.rid === room.id ? 'Sprachkanal verlassen' : 'Sprachkanal „' + room.meta.vch[0].name + '“ betreten',
        () => (S.voice && S.voice.rid === room.id ? leaveVoice() : joinVoice(room.id))),
      iconBtn('userPlus', 'Einladen', () => inviteDialog(room)),
      iconBtn('users', 'Mitglieder', () => { S.membersOpen = !S.membersOpen; renderAll(); }, { 'aria-pressed': S.membersOpen ? 'true' : 'false' }));
  } else {
    head.append(el('span', { class: 'sc-head-text' },
      el('span', { class: 'sc-head-title' }, icon('radio', 15), 'SecureCom'),
      el('span', { class: 'sc-head-sub', text: 'Ende-zu-Ende verschlüsselt' })),
      el('span', { class: 'sc-head-spacer' }),
      iconBtn('info', 'Wie SecureCom schützt', showSecurityInfo));
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
  if (S.forceBottom || atBottom) thread.scrollTop = thread.scrollHeight;
  else thread.scrollTop = keep;
  S.forceBottom = false;
}

function messageNode(m, grouped) {
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
    body.appendChild(el('div', { class: 'sc-msg-head' },
      el('button', { type: 'button', class: 'sc-msg-name', text: displayName(ident), onclick: () => showProfile(m.from) }),
      ident && ident.kind === 'temp' ? el('span', { class: 'sc-msg-fp', text: fpTail(ident.fp) }) : null,
      el('time', { text: fmtTime(m.ts), title: new Date(m.ts).toLocaleString('de-DE') })));
  }
  const text = el('div', { class: 'sc-msg-text' });
  if (m.deleted) {
    text.classList.add('is-deleted');
    text.textContent = 'Nachricht gelöscht';
  } else {
    text.appendChild(linkify(m.body));
    if (m.edited) text.appendChild(el('span', { class: 'sc-edited', text: ' (bearbeitet)' }));
  }
  body.appendChild(text);
  if (m.invite && !m.deleted) body.appendChild(inviteCard(m));
  if (m.state === 'failed') body.appendChild(el('span', { class: 'sc-msg-state', text: 'Nicht gesendet' }));
  node.appendChild(body);

  if (own && !m.deleted && !m.invite && m.state !== 'pending') {
    node.appendChild(el('div', { class: 'sc-msg-actions' },
      iconBtn('edit', 'Bearbeiten', () => editMessage(m, node)),
      iconBtn('trash', 'Löschen', () => deleteMessage(m))));
  }
  return node;
}

function inviteCard(m) {
  const inv = m.invite;
  const mine = m.from === S.me.id;
  const joined = S.rooms.has(inv.rid);
  return el('div', { class: 'sc-invite tickbox' },
    el('span', { class: 'sc-invite-icon' }, icon('userPlus', 18)),
    el('span', { class: 'sc-invite-text' },
      el('span', { class: 'sc-invite-title', text: mine ? 'Einladung verschickt' : 'Einladung in einen Raum' }),
      el('span', { class: 'sc-invite-name', text: inv.name || 'Raum' })),
    mine ? null : el('button', {
      type: 'button', class: 'btn btn--primary', text: joined ? 'Öffnen' : 'Beitreten',
      onclick: () => (joined ? openRoom(inv.rid) : joinRoom(inv))
    }));
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
      el('li', { text: 'Du hast einen öffentlichen PGP-Schlüssel oder Fingerabdruck? „Per Schlüssel verbinden“.' }),
      el('li', { text: 'Für Gruppen: Mit + einen Raum erstellen und den Einladungslink teilen.' })),
    el('div', { class: 'sc-card-actions' },
      el('button', { type: 'button', class: 'btn btn--primary', onclick: connectByKey }, icon('key', 14), 'Per Schlüssel verbinden'),
      el('button', { type: 'button', class: 'btn', onclick: roomDialog }, icon('plus', 14), 'Raum erstellen'),
      el('button', { type: 'button', class: 'btn', onclick: showSecurityInfo }, icon('shield', 14), 'Was sieht der Server?')));
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
    placeholder = 'Nachricht in #' + (ch ? ch.name : '');
    blocked = !roomKeyRaw(room.id, room.epoch);
  }
  form.hidden = !show;
  input.placeholder = placeholder;
  input.disabled = blocked;
  $('sc-send').disabled = blocked;
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
  // Online: man selbst, sichtbare temporäre Sitzungen und wer im Sprachkanal
  // ist (das sehen Mitglieder ohnehin). Konten verraten ihren Status sonst nicht.
  const here = (i) => i.id === S.me.id || i.on === true || room.vc.includes(i.id);
  const on = members.filter(here);
  const hidden = members.filter((i) => !here(i) && i.on !== false);
  const off = members.filter((i) => !here(i) && i.on === false);
  box.appendChild(el('div', { class: 'sc-members-head' },
    el('span', { class: 'sc-side-title', text: 'Mitglieder' }),
    iconBtn('x', 'Schließen', () => { S.membersOpen = false; renderAll(); }, { class: 'sc-ibtn sc-only-narrow' })));
  for (const [label, list] of [['ONLINE — ' + on.length, on], ['STATUS VERBORGEN — ' + hidden.length, hidden], ['OFFLINE — ' + off.length, off]]) {
    if (!list.length) continue;
    box.appendChild(sectionHead(label));
    const l = el('div', { class: 'sc-list' });
    for (const ident of list) {
      const row = personRow(ident, () => showProfile(ident.id, room));
      if (room.owner === ident.id) row.querySelector('.sc-row-name').appendChild(el('span', { class: 'sc-owner', title: 'Besitzer' }, icon('crown', 12)));
      if (room.vc.includes(ident.id)) row.appendChild(icon('speaker', 13));
      l.appendChild(row);
    }
    box.appendChild(l);
  }
}

function profileCard(ident, inPanel) {
  const me = ident.id === S.me.id;
  const card = el('div', { class: 'sc-profile' + (inPanel ? ' sc-profile--panel' : '') });
  card.append(
    avatar(ident, 'lg'),
    el('h3', { class: 'sc-profile-name' }, displayName(ident), isVerified(ident) ? icon('shieldCheck', 16) : null),
    el('p', { class: 'sc-profile-kind', text: (ident.kind === 'temp' ? 'Temporäre Sitzung' : 'Konto') + (ident.on ? ' · online' : ident.on === false ? ' · offline' : '') }),
    el('p', { class: 'field-label', text: 'Fingerabdruck' }),
    el('p', { class: 'sc-fp', text: C.formatFingerprint(ident.fp) }));
  if (!me) {
    card.appendChild(el('p', { class: 'sc-note', text: isVerified(ident)
      ? 'Verifiziert: Du hast diesen Fingerabdruck bestätigt.'
      : 'Nicht verifiziert. Vergleiche den Fingerabdruck über einen zweiten Weg (persönlich, Telefon, Signal …). Stimmt er, bist du sicher, dass niemand dazwischensitzt.' }));
  }
  const actions = el('div', { class: 'sc-profile-actions' });
  if (!me) {
    if (!inPanel) actions.appendChild(el('button', { type: 'button', class: 'btn btn--primary', onclick: () => { closeModal(); openDm(ident.id); } }, 'Nachricht'));
    actions.append(
      el('button', { type: 'button', class: 'btn', onclick: () => { closeModal(); startCall(ident.id, false); } }, icon('phone', 14), 'Anrufen'),
      el('button', { type: 'button', class: 'btn', onclick: () => { closeModal(); startCall(ident.id, true); } }, icon('video', 14), 'Video'),
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
    build: (body) => {
      body.appendChild(profileCard(ident, false));
      if (room && room.owner === S.me.id && id !== S.me.id) {
        body.appendChild(el('button', { type: 'button', class: 'btn sc-btn--danger btn--block', onclick: () => kickMember(room, ident) }, icon('leave', 14), 'Aus dem Raum entfernen'));
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
  else S.vault.blocked[ident.fp] = 1;
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
function noteArrival(key, ts, viewing, countUnread, notice) {
  if (viewing) {
    S.vault.reads[key] = Math.max(S.vault.reads[key] || 0, ts);
    saveVault();
  } else {
    countUnread();
    if (S.cursorLoaded) {
      notifySound();
      if (notice) notify('SecureCom', notice, key);
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

async function sendDm(peerId, body) {
  const ident = S.ids.get(peerId);
  if (!ident) return;
  const msg = { v: 1, t: 'msg', id: C.randomId(), from: S.me.id, to: peerId, ts: Date.now(), body: body };
  const local = { id: msg.id, from: S.me.id, ts: msg.ts, body: body, state: 'pending' };
  const conv = convOf(peerId);
  insertSorted(conv.msgs, local);
  conv.byId.set(local.id, local);
  conv.last = local.ts;
  noteContact(ident);
  S.forceBottom = true;
  scheduleRender();
  try {
    const d = await C.sealFor(msg, [ident.key, S.me.pub], S.me.priv);
    await api('send', { to: peerId, k: 'dm', d: d, self: true });
    local.state = null;
  } catch (e) {
    local.state = 'failed';
    toast(e.message, 'error');
  }
  scheduleRender();
}

async function sendDmEvent(peerId, obj) {
  const ident = S.ids.get(peerId);
  if (!ident) throw new Error('Unbekannte Person.');
  const msg = Object.assign({ v: 1, id: C.randomId(), from: S.me.id, to: peerId, ts: Date.now() }, obj);
  const d = await C.sealFor(msg, [ident.key, S.me.pub], S.me.priv);
  await api('send', { to: peerId, k: 'dm', d: d, self: true });
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
    res = await C.openSealed(e.d, S.me.priv, keyring());
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
  if (e.k === 'dm') handleDm(obj, from, e);
  else if (e.k === 'sig') await handleSignal(obj, from, e);
}

function handleDm(obj, from, e) {
  const peer = from.id === S.me.id ? obj.to : from.id;
  if (typeof peer !== 'string') return;
  const ts = e.t * 1000;
  if ((S.vault.cleared[peer] || 0) >= ts) return;   // Unterhaltung hier gelöscht
  const conv = convOf(peer);
  if (from.id !== S.me.id) noteContact(from);
  const ref = typeof obj.ref === 'string' ? conv.byId.get(obj.ref) : null;

  switch (obj.t) {
    case 'msg':
    case 'invite': {
      const existing = conv.byId.get(obj.id);
      if (existing) {
        // Eigene Nachricht kommt als Kopie zurück: jetzt mit Serverzeit.
        existing.state = null;
        if (existing.ts !== ts) { existing.ts = ts; conv.msgs.sort((a, b) => a.ts - b.ts); }
        break;
      }
      const m = { id: String(obj.id), from: from.id, ts: ts, body: cleanText(obj.body) };
      if (obj.t === 'invite') {
        const inv = obj.invite || {};
        if (!/^[A-Za-z0-9_-]{22}$/.test(inv.rid || '') || !/^[A-Za-z0-9_-]{43}$/.test(inv.key || '')) return;
        m.invite = { rid: inv.rid, code: String(inv.code || ''), key: inv.key, epoch: parseInt(inv.epoch, 10) || 1, name: cleanName(inv.name) };
        m.body = from.id === S.me.id ? 'Einladung in „' + m.invite.name + '“' : 'lädt dich in „' + m.invite.name + '“ ein';
      }
      insertSorted(conv.msgs, m);
      conv.byId.set(m.id, m);
      conv.last = Math.max(conv.last, ts);
      if (from.id !== S.me.id && ts > (S.vault.reads['dm:' + peer] || 0)) {
        noteArrival('dm:' + peer, ts, isViewing('dm', peer), () => { conv.unread++; },
          'Neue Nachricht von ' + displayName(from));
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
  const ok = await confirmBox('Nachricht löschen', 'Die Nachricht wird bei allen als gelöscht angezeigt. Der verschlüsselte Eintrag verschwindet spätestens nach ' + S.cfg.retention_days + ' Tagen vom Server.', 'Löschen', true);
  if (!ok) return;
  try {
    if (S.view.kind === 'dm') await sendDmEvent(S.view.peer, { t: 'del', ref: m.id });
    else await postRoom(S.rooms.get(S.view.rid), { t: 'del', ref: m.id, ch: S.view.ch });
    m.deleted = true;
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

function storeRoomKey(rid, epoch, raw) {
  const r = S.vault.rooms[rid] || (S.vault.rooms[rid] = { k: {}, rot: 0 });
  r.k[epoch] = raw;
}

// Der erste Sprachkanal hat die leere Kennung – so kennen ihn auch ältere Fassungen.
const FIRST_VOICE = { id: '', name: 'Sprache' };

function newRoomState(raw) {
  return {
    id: raw.id, owner: raw.owner, epoch: raw.epoch, metaRaw: null, metaEpoch: 0,
    meta: { name: 'Raum', ch: [{ id: 'main', name: 'allgemein' }], vch: [FIRST_VOICE], img: '' },
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
  const m = Object.assign({ name: room.meta.name, ch: room.meta.ch, vch: room.meta.vch, img: room.meta.img || '' }, changes || {});
  if (!m.img) delete m.img;
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
  scheduleRender();
}

async function decryptMeta(room) {
  const key = await roomKey(room.id, room.metaEpoch);
  if (!key || !room.metaRaw) return;
  try {
    const res = await C.openRoom(room.metaRaw, key, room.id, keyring());
    const signer = [...S.ids.values()].find((i) => i.fp === res.signer);
    if (!signer || !room.members.some((m) => m.id === signer.id) || res.obj.t !== 'meta') return;
    const ch = Array.isArray(res.obj.ch) ? res.obj.ch
      .filter((c) => c && /^[A-Za-z0-9_-]{1,22}$/.test(c.id)).slice(0, 30)
      .map((c) => ({ id: c.id, name: cleanName(c.name).toLowerCase().replace(/\s+/g, '-').slice(0, 30) || 'kanal' })) : [];
    // Sprachkanäle: der erste ("") immer, weitere aus den Raumdaten.
    const vch = Array.isArray(res.obj.vch) ? res.obj.vch
      .filter((c) => c && typeof c.id === 'string' && (c.id === '' || /^[A-Za-z0-9_-]{1,22}$/.test(c.id))).slice(0, 20)
      .map((c) => ({ id: c.id, name: cleanName(c.name).slice(0, 30) || 'Sprache' })) : [];
    if (!vch.some((c) => c.id === '')) vch.unshift(FIRST_VOICE);
    // Raumbild: nur ein eingebettetes Bild, nie eine Adresse.
    const img = typeof res.obj.img === 'string' && res.obj.img.length <= 60000
      && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(res.obj.img) ? res.obj.img : '';
    room.meta = { name: cleanName(res.obj.name) || 'Raum', ch: ch.length ? ch : [{ id: 'main', name: 'allgemein' }], vch: vch, img: img };
    for (const c of room.meta.ch) if (!room.msgs.has(c.id)) room.msgs.set(c.id, []);
  } catch (e) { /* bleibt beim Platzhalter */ }
}

function dropRoomLocal(rid) {
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
          go.addEventListener('click', async () => {
            const n = cleanName(name.value);
            if (!n) { name.focus(); return; }
            go.disabled = true;
            try { await createRoom(n); close(); } catch (e) { go.disabled = false; toast(e.message, 'error'); }
          });
          name.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go.click(); });
          panel.append(field('Name des Raums', name, 'Name und Kanäle sind verschlüsselt – der Server sieht nur eine zufällige Kennung.'), go);
        } else {
          const link = el('input', { type: 'text', placeholder: WEB_URL + '#join=…' });
          const go = el('button', { type: 'button', class: 'btn btn--primary btn--block', text: 'Beitreten' });
          go.addEventListener('click', () => {
            const m = /#join=([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})\.(\d{1,6})/.exec(link.value.trim());
            if (!m) { toast('Das ist kein gültiger Einladungslink.', 'error'); return; }
            close();
            joinRoom({ rid: m[1], code: m[2], key: m[3], epoch: parseInt(m[4], 10) });
          });
          panel.append(field('Einladungslink', link, 'Der Teil nach „#“ enthält den Raumschlüssel. Er wird nie an den Server geschickt.'), go);
        }
      };
      draw();
    }
  });
}

async function createRoom(name) {
  const rid = C.randomId();
  const raw = C.newRoomKey();
  const key = await C.importRoomKey(raw);
  const ch = [{ id: C.randomId().slice(0, 10), name: 'allgemein' }];
  const meta = await C.sealRoom({ v: 1, t: 'meta', room: rid, name: name, ch: ch, vch: [FIRST_VOICE], from: S.me.id, ts: Date.now() }, key, 1, rid, S.me.priv);
  // Schlüssel zuerst sichern – ohne ihn wäre der Raum unlesbar.
  storeRoomKey(rid, 1, raw);
  await saveVault(true);
  await api('room.create', { id: rid, meta: meta });
  await loadRooms();
  openRoom(rid);
}

async function joinRoom(inv) {
  try {
    storeRoomKey(inv.rid, inv.epoch, inv.key);
    await saveVault(true);
    await api('room.join', { id: inv.rid, code: inv.code });
    await loadRooms();
    openRoom(inv.rid);
    toast('Du bist dem Raum beigetreten.', 'ok');
  } catch (e) {
    if (!S.rooms.has(inv.rid)) { delete S.vault.rooms[inv.rid]; saveVault(); }
    toast(e.message, 'error');
  }
}

function roomMenu(room) {
  const owner = room.owner === S.me.id;
  openModal({
    title: room.meta.name.toUpperCase(),
    build: (body, close) => {
      const item = (ic, label, fn, danger) => el('button', { type: 'button', class: 'sc-menu-item' + (danger ? ' is-danger' : ''), onclick: () => { close(); fn(); } }, icon(ic, 16), el('span', { text: label }));
      appendAll(body,
        item('userPlus', 'Einladen', () => inviteDialog(room)),
        S.voice && S.voice.rid === room.id ? item('leave', 'Sprachkanal verlassen', () => leaveVoice()) : item('speaker', 'Sprachkanal betreten', () => joinVoice(room.id)),
        owner ? item('hash', 'Textkanal anlegen', () => addChannel(room)) : null,
        owner ? item('speaker', 'Sprachkanal anlegen', () => addVoiceChannel(room)) : null,
        owner ? item('edit', 'Raum umbenennen', () => renameRoom(room)) : null,
        owner ? item('image', room.meta.img ? 'Raumbild ändern' : 'Raumbild festlegen', () => roomPicture(room)) : null,
        owner ? item('key', 'Raumschlüssel erneuern', () => rotateRoom(room.id, true)) : null,
        item('leave', 'Raum verlassen', () => leaveRoom(room), true),
        owner ? item('trash', 'Raum löschen', () => deleteRoom(room), true) : null,
        el('p', { class: 'sc-note', text: 'Schlüsselgeneration ' + room.epoch + ' · ' + room.members.length + ' Mitglieder · Besitzer: ' + displayName(S.ids.get(room.owner)) }));
    }
  });
}

function inviteDialog(room) {
  openModal({
    title: 'EINLADEN',
    build: (body) => {
      const out = el('div', { class: 'sc-invite-out' });
      const mk = el('button', { type: 'button', class: 'btn btn--primary btn--block' }, icon('link', 14), 'Einladungslink erstellen');
      mk.addEventListener('click', async () => {
        mk.disabled = true;
        try {
          const r = await api('room.invite', { id: room.id });
          const raw = roomKeyRaw(room.id, r.epoch);
          if (!raw) throw new Error('Der aktuelle Raumschlüssel fehlt noch.');
          const link = WEB_URL + '#join=' + room.id + '.' + r.code + '.' + raw + '.' + r.epoch;
          const input = el('input', { type: 'text', readonly: true, value: link });
          out.textContent = '';
          out.append(input,
            el('button', { type: 'button', class: 'btn', onclick: () => copyText(link, 'Link') }, icon('copy', 14), 'Kopieren'),
            el('p', { class: 'sc-note', text: 'Gilt 7 Tage, höchstens 25-mal. Wer den Link hat, kann beitreten und mitlesen – teile ihn nur über einen sicheren Weg. Nach „Raumschlüssel erneuern“ ist er ungültig.' }));
          input.select();
        } catch (e) { toast(e.message, 'error'); }
        mk.disabled = false;
      });

      const people = [...new Set([...S.online, ...S.convs.keys()])]
        .map((id) => S.ids.get(id)).filter((i) => i && i.id !== S.me.id && !room.members.some((m) => m.id === i.id));
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
      body.append(
        el('p', { class: 'sc-p', text: 'Per Link oder direkt an eine Person – dann geht die Einladung samt Raumschlüssel PGP-verschlüsselt an genau sie.' }),
        mk, out,
        sectionHead('DIREKT EINLADEN'),
        people.length ? list : el('p', { class: 'sc-empty-note', text: 'Niemand in Reichweite. Per Schlüssel verbundene oder online sichtbare Personen erscheinen hier.' }));
    }
  });
}

async function updateMeta(room, meta) {
  const key = await roomKey(room.id, room.epoch);
  if (!key) throw new Error('Der aktuelle Raumschlüssel fehlt.');
  const data = await C.sealRoom(Object.assign({ v: 1, t: 'meta', room: room.id, from: S.me.id, ts: Date.now() }, meta), key, room.epoch, room.id, S.me.priv);
  await api('room.meta', { id: room.id, meta: data, e: room.epoch });
  await loadRooms();
}

function addChannel(room) {
  openModal({
    title: 'KANAL ANLEGEN',
    build: (body, close) => {
      const name = el('input', { type: 'text', maxlength: '30', placeholder: 'z. B. planung' });
      const go = el('button', { type: 'button', class: 'btn btn--primary btn--block', text: 'Anlegen' });
      go.addEventListener('click', async () => {
        const n = cleanName(name.value).toLowerCase().replace(/\s+/g, '-');
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
    }
  });
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
  const ok = await confirmBox('Raum verlassen', 'Du verlässt „' + room.meta.name + '“. Zurück kommst du nur mit einer neuen Einladung.', 'Verlassen', true);
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
  const ok = await confirmBox('Raum löschen', 'Der Raum und sein gesamter Verlauf werden für alle gelöscht.', 'Löschen', true);
  if (!ok) return;
  try {
    if (S.voice && S.voice.rid === room.id) await leaveVoice();
    await api('room.delete', { id: room.id });
    delete S.vault.rooms[room.id];
    saveVault();
    dropRoomLocal(room.id);
  } catch (e) { toast(e.message, 'error'); }
}

async function kickMember(room, ident) {
  const ok = await confirmBox('Entfernen', displayName(ident) + ' wird aus dem Raum entfernt. Danach bekommt der Raum einen neuen Schlüssel, damit spätere Nachrichten für ' + displayName(ident) + ' unlesbar bleiben.', 'Entfernen', true);
  if (!ok) return;
  try {
    await api('room.kick', { id: room.id, member: ident.id });
    await rotateRoom(room.id);
    toast(displayName(ident) + ' entfernt, Raumschlüssel erneuert.', 'ok');
  } catch (e) { toast(e.message, 'error'); }
}

/**
 * Neuer Raumschlüssel: zufällig im Browser erzeugt, dann PGP-verschlüsselt
 * an alle verbliebenen Mitglieder. Wer den Raum verlassen hat, kann ab
 * jetzt nichts mehr lesen.
 */
async function rotateRoom(rid, manual) {
  if (S.rotating.has(rid)) return;
  S.rotating.add(rid);
  try {
    await loadRooms();
    const room = S.rooms.get(rid);
    if (!room || room.owner !== S.me.id) return;
    const members = await ensureIds(room.members.map((m) => m.id));
    if (members.length !== room.members.length) throw new Error('Nicht alle Mitglieder ließen sich laden.');
    const raw = C.newRoomKey();
    const epoch = room.epoch + 1;
    const key = await C.importRoomKey(raw);
    const env = await C.sealFor({ v: 1, t: 'roomkey', room: rid, epoch: epoch, key: raw, from: S.me.id, ts: Date.now() }, members.map((m) => m.key), S.me.priv);
    const meta = await C.sealRoom(Object.assign({ v: 1, t: 'meta', room: rid, from: S.me.id, ts: Date.now() }, metaOf(room)), key, epoch, rid, S.me.priv);
    storeRoomKey(rid, epoch, raw);
    S.vault.rooms[rid].rot = serverNow();
    await saveVault(true);
    await api('room.rotate', { id: rid, e: epoch, env: env, meta: meta });
    await loadRooms();
    if (manual) toast('Neuer Raumschlüssel (Generation ' + epoch + '). Alte Einladungslinks gelten nicht mehr.', 'ok');
  } catch (e) {
    toast('Schlüsselwechsel: ' + e.message, 'error');
  } finally {
    S.rotating.delete(rid);
  }
}

async function postRoom(room, obj) {
  const key = await roomKey(room.id, room.epoch);
  if (!key) throw new Error('Der aktuelle Raumschlüssel fehlt noch.');
  const msg = Object.assign({ v: 1, id: C.randomId(), from: S.me.id, room: room.id, ts: Date.now() }, obj);
  const d = await C.sealRoom(msg, key, room.epoch, room.id, S.me.priv);
  await api('room.post', { id: room.id, k: 'msg', d: d });
  return msg;
}

async function sendRoomMessage(room, ch, body) {
  const local = { id: C.randomId(), from: S.me.id, ts: Date.now(), body: body, state: 'pending' };
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
    const d = await C.sealRoom(msg, key, room.epoch, room.id, S.me.priv);
    await api('room.post', { id: room.id, k: 'msg', d: d });
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
  const ref = typeof obj.ref === 'string' ? room.byId.get(obj.ref) : null;
  if (obj.t === 'edit') { if (ref && ref.from === from.id) { ref.body = cleanText(obj.body); ref.edited = true; } scheduleRender(); return; }
  if (obj.t === 'del') { if (ref && ref.from === from.id) ref.deleted = true; scheduleRender(); return; }
  if (obj.t !== 'msg') return;
  // Kanal steht nur verschlüsselt in der Nachricht. Unbekannte Kanäle
  // (Raumdaten noch nicht entschlüsselt) behalten ihre Kennung und
  // erscheinen, sobald der Kanal bekannt ist.
  const ch = typeof obj.ch === 'string' && /^[A-Za-z0-9_-]{1,22}$/.test(obj.ch) ? obj.ch : room.meta.ch[0].id;
  const existing = room.byId.get(obj.id);
  if (existing) {
    existing.state = null;
    if (existing.ts !== ts) {
      existing.ts = ts;
      const list = room.msgs.get(ch);
      if (list) list.sort((a, b) => a.ts - b.ts);
    }
    scheduleRender();
    return;
  }
  const m = { id: String(obj.id), from: from.id, ts: ts, body: cleanText(obj.body) };
  const list = room.msgs.get(ch) || [];
  room.msgs.set(ch, list);
  insertSorted(list, m);
  room.byId.set(m.id, m);
  if (from.id !== S.me.id && ts > (S.vault.reads['room:' + room.id + ':' + ch] || 0)) {
    noteArrival('room:' + room.id + ':' + ch, ts, isViewing('room', room.id, ch), () => {
      room.unread.set(ch, (room.unread.get(ch) || 0) + 1);
    }, displayName(from) + ' in „' + room.meta.name + '“');
  }
  scheduleRender();
}

function roomSys(room, e) {
  if (typeof e.id !== 'string') return;
  const ts = e.t * 1000;
  const ident = S.ids.get(e.id);
  const who = displayName(ident);
  const text = e.ev === 'join' ? who + ' ist dem Raum beigetreten.'
    : e.ev === 'kick' ? who + ' wurde aus dem Raum entfernt.'
      : who + ' hat den Raum verlassen.';
  const ch = room.meta.ch[0].id;
  const list = room.msgs.get(ch) || [];
  room.msgs.set(ch, list);
  insertSorted(list, { id: 'sys' + e.s, sys: text, icon: e.ev === 'join' ? 'userPlus' : 'leave', ts: ts, from: '' });
  if (e.ev === 'join') ensureIds([e.id]).then(scheduleRender);
  // Wer geht, soll spätere Nachrichten nicht mehr lesen können: Der
  // Besitzer erneuert den Schlüssel (einmal je Ereignis).
  if ((e.ev === 'leave' || e.ev === 'kick') && room.owner === S.me.id && e.id !== S.me.id) {
    const rot = (S.vault.rooms[room.id] && S.vault.rooms[room.id].rot) || 0;
    if (ts > rot) setTimeout(() => rotateRoom(room.id), 1200);
  }
  scheduleRender();
}

async function roomKeyEnvelope(room, e) {
  if (roomKeyRaw(room.id, e.e)) return;
  let res;
  try { res = await C.openSealed(e.d, S.me.priv, keyring()); } catch (err) { return; }
  const obj = res.obj;
  const signer = [...S.ids.values()].find((i) => i.fp === res.signer);
  // Nur der Besitzer verteilt Schlüssel.
  if (!signer || signer.id !== room.owner || obj.t !== 'roomkey' || obj.room !== room.id || obj.epoch !== e.e) return;
  if (!/^[A-Za-z0-9_-]{43}$/.test(obj.key || '')) return;
  storeRoomKey(room.id, obj.epoch, obj.key);
  await saveVault(true).catch(() => {});
  room.pendingKey = !roomKeyRaw(room.id, room.epoch);
  const waiting = room.pending;
  room.pending = [];
  for (const p of waiting) await handleFeedEntry(room, p);
  if (room.metaEpoch === obj.epoch) await decryptMeta(room);
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
  if (r.pv !== S.pv) { S.pv = r.pv; refreshOnline(); }
  if (first) { S.forceBottom = true; changed = true; }
  if (changed) scheduleRender();
  return more;
}

async function refreshOnline() {
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
  micOn: true, deaf: false, ctx: null, meters: new Map()
};

function audioCtx() {
  if (!M.ctx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) M.ctx = new Ctx();
  }
  if (M.ctx && M.ctx.state === 'suspended') M.ctx.resume().catch(() => {});
  return M.ctx;
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
    return 'Dieser Browser gibt hier kein Mikrofon frei. Öffne SecureCom direkt in Chrome, Safari, Firefox oder Edge – nicht im Browser einer anderen App.';
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
    if (tx) { try { await tx.sender.replaceTrack(localTrack(slot)); } catch (e) { /* Verbindung schon zu */ } }
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
    M.cam = null;
  } else {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24 } } });
      M.cam = stream.getVideoTracks()[0];
      M.cam.addEventListener('ended', () => { M.cam = null; pushTrack('cam'); });
    } catch (e) {
      toast('Kein Zugriff auf die Kamera.', 'error');
      return;
    }
  }
  pushTrack('cam');
}

/* ---------- Bildschirm teilen: Qualität ----------------------------------- */
/**
 * rate gilt je Gegenüber im Anruf, mesh im Sprachkanal: Dort geht der
 * Stream an jeden einzeln, also mal Zahl der Leute. Die Kennungen stehen
 * genauso in desktop/picker.js (Auswahlfenster der Windows-App).
 */
const SCREEN_QUALITY = [
  { id: 'normal', name: 'Ausgewogen', info: '1080p · 30 fps', note: 'Für das meiste genau richtig.', w: 1920, h: 1080, fps: 30, rate: 3000000, mesh: 1500000, hint: 'detail' },
  { id: 'text', name: 'Text & Code', info: 'Originalauflösung · 15 fps', note: 'Gestochen scharf für Code, Dokumente und Tabellen.', w: 0, h: 0, fps: 15, rate: 4000000, mesh: 2000000, hint: 'text' },
  { id: 'smooth', name: 'Flüssig', info: '720p · 60 fps', note: 'Für Videos und Spiele: Bewegung vor Schärfe.', w: 1280, h: 720, fps: 60, rate: 4000000, mesh: 2000000, hint: 'motion' },
  { id: 'max', name: 'Hoch', info: '1440p · 60 fps', note: 'Scharf und flüssig, braucht einen schnellen Upload.', w: 2560, h: 1440, fps: 60, rate: 10000000, mesh: 4000000, hint: 'motion' },
  { id: 'source', name: 'Quelle', info: 'Originalauflösung · 60 fps', note: 'Der Bildschirm 1:1 und flüssig – braucht den meisten Upload.', w: 0, h: 0, fps: 60, rate: 16000000, mesh: 6000000, hint: 'motion' },
  { id: 'low', name: 'Sparsam', info: '720p · 10 fps', note: 'Für schwache Leitungen und Mobilfunk.', w: 1280, h: 720, fps: 10, rate: 800000, mesh: 500000, hint: 'detail' }
];
const SQ_KEY = 'sc-screen-quality';   // je Gerät, nicht im Tresor: der Upload hängt am Anschluss
let screenQualityId = null;           // falls localStorage gesperrt ist

function screenQuality() {
  let id = screenQualityId;
  try { id = localStorage.getItem(SQ_KEY) || id; } catch (e) { /* privater Modus */ }
  return SCREEN_QUALITY.find((q) => q.id === id) || SCREEN_QUALITY[0];
}

/** w = 0: keine Obergrenze, also die Auflösung des Bildschirms selbst. */
function screenConstraints(q) {
  const c = { frameRate: { ideal: q.fps, max: q.fps } };
  if (q.w) { c.width = { max: q.w }; c.height = { max: q.h }; }
  return c;
}

function setScreenQuality(id) {
  if (!SCREEN_QUALITY.some((q) => q.id === id)) return;
  screenQualityId = id;
  try { localStorage.setItem(SQ_KEY, id); } catch (e) { /* gilt dann nur bis zum Neuladen */ }
  applyScreenQuality();
}

/** Läuft gerade eine Übertragung, gilt die gewählte Qualität sofort. */
async function applyScreenQuality() {
  const q = screenQuality();
  if (M.screen && M.screen.readyState === 'live') {
    M.screen.contentHint = q.hint;
    try { await M.screen.applyConstraints(screenConstraints(q)); } catch (e) { /* der Browser bleibt bei der alten */ }
  }
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
const AUDIO_QUALITY = [
  { id: 'voice', name: 'Sprache', info: '32 kbit/s', note: 'Klar und sparsam, mit Echo- und Rauschunterdrückung.', rate: 32000, stereo: false, clean: true },
  { id: 'high', name: 'Hoch', info: '64 kbit/s', note: 'Mehr Klangdetails, die Unterdrückung bleibt an.', rate: 64000, stereo: false, clean: true },
  { id: 'music', name: 'Musik', info: '128 kbit/s · Stereo', note: 'Für Musik und Instrumente, ohne Filter – nur mit Kopfhörer.', rate: 128000, stereo: true, clean: false },
  { id: 'low', name: 'Sparsam', info: '16 kbit/s', note: 'Für schwache Leitungen und Mobilfunk.', rate: 16000, stereo: false, clean: true }
];
const AQ_KEY = 'sc-audio-quality';
let audioQualityId = null;   // falls localStorage gesperrt ist

function audioQuality() {
  let id = audioQualityId;
  try { id = localStorage.getItem(AQ_KEY) || id; } catch (e) { /* privater Modus */ }
  return AUDIO_QUALITY.find((q) => q.id === id) || AUDIO_QUALITY[0];
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
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: screenConstraints(screenQuality()), audio: true });
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

/** Einmal je Sitzung erklären, warum eine Verbindung nicht zustande kommt. */
let routeHint = false;
function noDirectRoute(id) {
  if (routeHint || (S.cfg && S.cfg.relay)) return;
  routeHint = true;
  toast('Zu ' + displayName(S.ids.get(id)) + ' kommt keine direkte Verbindung zustande. Das ist typisch für Mobilfunk und strenge Netze – ' +
    'dafür braucht SecureCom einen Relay-Server (TURN), der hier noch nicht eingerichtet ist.', 'error', 14000);
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

function rtcConfig() {
  const relayOnly = S.vault.settings.hideIp && S.cfg.relay;
  return { iceServers: S.cfg.ice || [], iceTransportPolicy: relayOnly ? 'relay' : 'all', bundlePolicy: 'max-bundle' };
}

class Peer {
  constructor(remoteId, opts) {
    this.remoteId = remoteId;
    this.opts = opts;
    this.initiator = !!opts.initiator;
    this.created = Date.now();
    this.tx = {};
    this.remote = {};
    this.remoteState = { mic: true, cam: false, screen: false, deaf: false };
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
    await Promise.all(SLOTS.map((slot) => this.tx[slot] ? this.tx[slot].sender.replaceTrack(localTrack(slot)) : null));
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
      this.dc.send(JSON.stringify({ t: 'state', mic: M.micOn && !M.deaf, cam: !!M.cam, screen: !!M.screen, deaf: M.deaf }));
    } catch (e) { /* Kanal zu */ }
  }

  onData(raw) {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.t === 'state') {
      this.remoteState = { mic: !!m.mic, cam: !!m.cam, screen: !!m.screen, deaf: !!m.deaf };
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
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      if (slot === 'cam') {
        p.encodings[0].maxBitrate = mesh ? 500000 : 900000;
      } else {
        p.encodings[0].maxBitrate = mesh ? q.mesh : q.rate;
        p.encodings[0].maxFramerate = q.fps;
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
  audioCtx();
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
  if (S.voice) await leaveVoice(S.voice.rid === rid);
  if (!roomKeyRaw(rid, room.epoch)) { toast('Der aktuelle Raumschlüssel fehlt noch.', 'error'); return; }
  audioCtx();
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
  want.push({ key: 'me:cam', ident: S.ids.get(S.me.id), track: M.cam, video: !!M.cam, self: true, muted: !(M.micOn && !M.deaf), speak: S.me.id });
  if (M.screen) want.push({ key: 'me:screen', ident: S.ids.get(S.me.id), track: M.screen, video: true, screen: true, self: true, label: 'Dein Bildschirm' });

  for (const p of people.peers) {
    const ident = S.ids.get(p.remoteId);
    const conn = p.failed && p.pc.connectionState !== 'connected' ? 'nodirect' : p.pc.connectionState;
    want.push({
      key: p.remoteId + ':cam', ident: ident, stream: p.remote.cam, video: p.remoteState.cam && !!p.remote.cam,
      muted: !p.remoteState.mic, speak: p.remoteId, conn: conn, code: p.code
    });
    if (p.remoteState.screen && p.remote.screen) {
      want.push({ key: p.remoteId + ':screen', ident: ident, stream: p.remote.screen, video: true, screen: true, label: 'Bildschirm von ' + displayName(ident) });
    }
  }
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
      el('button', { type: 'button', class: 'sc-code', title: 'Sicherheitscode vergleichen', onclick: showCodeInfo },
        icon('lock', 13), code ? 'Ende-zu-Ende verschlüsselt · Code ' + code : 'Ende-zu-Ende verschlüsselt'));
  } else {
    const room = S.rooms.get(S.voice.rid);
    top.append(el('span', { class: 'sc-stage-state', text: (room ? room.meta.name : '') + ' · Sprache' }),
      el('button', { type: 'button', class: 'sc-code', title: 'Sicherheitscodes vergleichen', onclick: showCodeInfo },
        icon('lock', 13), 'Ende-zu-Ende verschlüsselt · Codes an den Kacheln'));
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
  const full = iconBtn('expand', 'Vollbild', () => fullscreenVideo(video), { class: 'sc-ibtn sc-tile-full' });
  frame.append(video, label, full);
  node.append(frame, face);
  const ratio = () => {
    if (video.videoWidth && video.videoHeight) node.style.setProperty('--ar', String(video.videoWidth / video.videoHeight));
  };
  video.addEventListener('loadedmetadata', ratio);
  video.addEventListener('resize', ratio);
  node.addEventListener('click', (ev) => {
    if (ev.target.closest('button')) return;
    // Die Übertragung im Mittelpunkt: direkt Vollbild. Sonst in den Mittelpunkt holen – oder zurück.
    if (node.classList.contains('is-screen') && node.classList.contains('has-video') && focusKey === key) {
      fullscreenVideo(video);
      return;
    }
    focusKey = focusKey === key ? null : key;
    renderStage();
  });
  return { key: key, node: node, video: video, face: face, label: label, src: null };
}

function updateTile(t, w) {
  t.node.className = 'sc-tile' + (w.screen ? ' is-screen' : '') + (w.video ? ' has-video' : '') + (focusKey === t.key ? ' is-focus' : '') + (w.self ? ' is-self' : '')
    + (w.conn && w.conn !== 'connected' ? ' is-waiting' : '');
  if (w.speak) t.node.dataset.speak = w.speak; else delete t.node.dataset.speak;
  const src = w.video ? (w.track || w.stream || null) : null;
  if (src !== t.src) {
    t.src = src;
    t.video.srcObject = src ? (src instanceof MediaStream ? src : new MediaStream([src])) : null;
    if (src) t.video.play().catch(() => {});
  }
  t.video.classList.toggle('is-mirror', !!(w.self && !w.screen));
  t.face.textContent = '';
  if (!w.video) t.face.appendChild(avatar(w.ident, 'xl'));
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
  const sig = [M.micOn, M.deaf, !!M.cam, !!M.screen, canScreen, screenQuality().id, !!S.voice].join('|');
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
    canScreen ? ctl(M.screen ? 'screen' : 'screenOff', M.screen ? 'Teilen beenden' : 'Bildschirm teilen', !!M.screen, toggleScreen) : null,
    canScreen && M.screen ? ctl('sliders', 'Qualität: ' + q.name + ' (' + q.info + ')', true, showScreenQuality) : null,
    ctl(M.deaf ? 'headOff' : 'head', M.deaf ? 'Ton an' : 'Nichts hören', !M.deaf, toggleDeaf),
    ctl('hangup', S.voice ? 'Sprachkanal verlassen' : 'Auflegen', true, () => (S.voice ? leaveVoice() : endCall()), 'sc-ctl--hangup'));
}

setInterval(() => {
  const t = $('sc-call-timer');
  if (t && S.call && S.call.state === 'active') t.textContent = fmtDuration(Date.now() - S.call.started);
}, 1000);

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

function playRing() {
  stopTones();
  if (!S.vault.settings.sound) return;
  const ring = () => { beep(880, 0.35, 0, 0.09); beep(660, 0.35, 0.4, 0.09); };
  ring();
  toneTimer = setInterval(ring, 2600);
}

function playRingback() {
  stopTones();
  const tone = () => beep(440, 0.9, 0, 0.04);
  tone();
  toneTimer = setInterval(tone, 3500);
}

function stopTones() {
  clearInterval(toneTimer);
  toneTimer = 0;
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
  if (M.ctx && M.ctx.state === 'running') beep(760, 0.09, 0, 0.04);
}

/* ==========================================================================
   Per Schlüssel verbinden
   ========================================================================== */
function connectByKey() {
  openModal({
    title: 'PER SCHLÜSSEL VERBINDEN',
    build: (body, close) => {
      const input = el('textarea', { rows: '6', spellcheck: 'false', placeholder: '-----BEGIN PGP PUBLIC KEY BLOCK-----\n…\n\noder Fingerabdruck: 4F2A 91C0 …' });
      const go = el('button', { type: 'button', class: 'btn btn--primary btn--block', text: 'Suchen' });
      const out = el('div', { class: 'sc-list' });
      body.append(
        el('p', { class: 'sc-p', text: 'Füge den öffentlichen PGP-Schlüssel oder den Fingerabdruck der Person ein. Hast du ihn auf einem sicheren Weg bekommen, markiert SecureCom den Kontakt als verifiziert.' }),
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
            out.appendChild(el('p', { class: 'sc-empty-note', text: 'Mit diesem Schlüssel ist gerade niemand bei SecureCom. Die Person muss SecureCom mit genau diesem Schlüssel benutzen (Konto mit eigenem Schlüssel oder ihre temporäre Sitzung).' }));
          }
          for (const ident of found) {
            // Wer den Schlüssel selbst eingefügt hat, hat ihn außerhalb von
            // SecureCom bekommen – das gilt als Verifikation.
            noteContact(ident);
            if (!ident.changed) {
              S.vault.contacts[ident.id].v = true;
              saveVault();
            }
            const row = el('div', { class: 'sc-found' },
              personRow(ident, () => { close(); openDm(ident.id); }, { sub: C.shortFingerprint(ident.fp) + (ident.on ? ' · online' : ident.on === false ? ' · offline' : '') }),
              el('div', { class: 'sc-found-actions' },
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
const UPD = { state: null, watchers: new Set(), prompted: false, timer: null };

function initUpdates() {
  if (!UPDATES) return;
  UPDATES.onState((s) => {
    UPD.state = s;
    for (const fn of UPD.watchers) fn(s);
    promptUpdate();
  });
  UPDATES.get().then((s) => {
    if (!UPD.state) UPD.state = s;
    promptUpdate();
  }).catch(() => {});
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
  if (s.status === 'available') line('SecureCom ' + latest.version + ' ist da – du hast ' + s.version + '.');
  else if (s.status === 'downloading') line('SecureCom ' + (latest ? latest.version + ' ' : '') + 'wird geladen … ' + Math.floor((s.progress || 0) * 100) + ' %');
  else if (s.status === 'installing') line('Wird installiert – SecureCom startet gleich neu.');
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
  if (s.status === 'available' && (S.call || S.voice)) line('Ein laufendes Gespräch endet dabei.', 'sc-note');

  const acts = el('div', { class: 'sc-card-actions' });
  if (latest && (s.status === 'available' || s.status === 'error')) {
    acts.appendChild(el('button', { type: 'button', class: 'btn btn--primary', onclick: () => UPDATES.install().catch((e) => toast(e.message, 'error')) },
      icon('download', 14), 'Jetzt aktualisieren' + (latest.size ? ' (' + Math.round(latest.size / 1048576) + ' MB)' : '')));
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
function showSettings() {
  let offUpdates = null;
  openModal({
    title: 'EINSTELLUNGEN',
    wide: true,
    onClose: () => { if (offUpdates) offUpdates(); },
    build: (body, close) => {
      // Profil
      body.appendChild(sectionHead('PROFIL'));
      const vis = el('input', { type: 'checkbox', checked: S.me.vis });
      vis.addEventListener('change', async () => {
        try {
          await api('card', { vis: vis.checked });
          S.me.vis = vis.checked;
          renderAll();
        } catch (e) { vis.checked = !vis.checked; toast(e.message, 'error'); }
      });
      const picRow = S.mode === 'account'
        ? el('div', { class: 'sc-set-row' },
          avatar(S.ids.get(S.me.id), 'sm'),
          el('span', { class: 'sc-set-text' }, el('strong', { text: 'Profilbild' }),
            el('span', { text: S.me.av ? 'Für alle sichtbar, die deinen Namen sehen.' : 'Noch keins – zu sehen sind deine Anfangsbuchstaben.' })),
          el('button', { type: 'button', class: 'btn', text: S.me.av ? 'Ändern' : 'Wählen', onclick: async () => { if (await setProfilePicture(false)) { close(); showSettings(); } } }),
          S.me.av ? el('button', { type: 'button', class: 'btn sc-btn--danger', text: 'Entfernen', onclick: async () => { if (await setProfilePicture(true)) { close(); showSettings(); } } }) : null)
        : el('p', { class: 'sc-note', text: 'Profilbilder gibt es für Konten.' });
      body.append(
        el('div', { class: 'sc-set-row' },
          el('span', { class: 'sc-set-text' }, el('strong', { text: S.mode === 'temp' ? 'Alias' : 'Name' }),
            el('span', { text: S.me.name || '(kein Alias)' })),
          S.mode === 'temp' ? el('button', { type: 'button', class: 'btn', text: 'Ändern', onclick: () => { close(); editAlias(); } }) : null),
        picRow,
        // Konten stehen nie in der Online-Liste (mehr Anonymität), nur temporäre Sitzungen.
        S.mode === 'temp'
          ? el('label', { class: 'sc-check' }, vis, el('span', { text: 'In der Online-Liste sichtbar sein. Aus: Nur wer deinen Schlüssel oder Fingerabdruck hat, erreicht dich.' }))
          : el('p', { class: 'sc-note', text: 'Konten stehen nicht in der Online-Liste und zeigen niemandem, ob sie online sind. Erreichbar bist du über deinen Schlüssel, deinen Fingerabdruck, gemeinsame Räume und bestehende Unterhaltungen.' }));

      // Schlüssel
      body.appendChild(sectionHead('SCHLÜSSEL'));
      body.append(
        el('p', { class: 'sc-fp', text: C.formatFingerprint(S.me.fp) }),
        el('div', { class: 'sc-card-actions' },
          el('button', { type: 'button', class: 'btn', onclick: () => copyText(S.me.armored, 'Öffentlicher Schlüssel') }, icon('copy', 14), 'Öffentlichen Schlüssel kopieren'),
          el('button', { type: 'button', class: 'btn', onclick: () => downloadText('securecom-' + (S.me.name || 'schluessel') + '-public.asc', S.me.armored) }, icon('download', 14), 'Herunterladen'),
          el('button', { type: 'button', class: 'btn', onclick: () => { close(); showKeyBackup(null, false); } }, icon('key', 14), 'Privaten Schlüssel sichern')));

      // Anrufe
      body.appendChild(sectionHead('ANRUFE'));
      const hide = el('input', { type: 'checkbox', checked: !!S.vault.settings.hideIp, disabled: !S.cfg.relay });
      hide.addEventListener('change', () => { S.vault.settings.hideIp = hide.checked; saveVault(); });
      const sound = el('input', { type: 'checkbox', checked: S.vault.settings.sound !== false });
      sound.addEventListener('change', () => { S.vault.settings.sound = sound.checked; saveVault(); });
      const micSel = el('select');
      micSel.appendChild(el('option', { value: '', text: 'Standard-Mikrofon' }));
      if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
        navigator.mediaDevices.enumerateDevices().then((list) => {
          for (const d of list) {
            if (d.kind !== 'audioinput' || !d.deviceId || d.deviceId === 'default') continue;
            micSel.appendChild(el('option', { value: d.deviceId, text: d.label || 'Mikrofon', selected: d.deviceId === S.vault.settings.mic }));
          }
        }).catch(() => {});
      }
      micSel.addEventListener('change', () => { S.vault.settings.mic = micSel.value; saveVault(); });
      const qualSel = el('select');
      const curQ = screenQuality();
      for (const q of SCREEN_QUALITY) qualSel.appendChild(el('option', { value: q.id, text: q.name + ' – ' + q.info, selected: q.id === curQ.id }));
      qualSel.addEventListener('change', () => setScreenQuality(qualSel.value));
      const audioSel = el('select');
      const curA = audioQuality();
      for (const q of AUDIO_QUALITY) audioSel.appendChild(el('option', { value: q.id, text: q.name + ' – ' + q.info, selected: q.id === curA.id }));
      const audioNote = el('span', { class: 'sc-field-note', text: curA.note });
      audioSel.addEventListener('change', () => {
        setAudioQuality(audioSel.value);
        audioNote.textContent = audioQuality().note;
      });
      const audioField = field('Tonqualität', audioSel);
      audioField.appendChild(audioNote);
      audioField.appendChild(el('span', { class: 'sc-field-note', text: 'Gilt für dieses Gerät, Datenrate und Filter sofort, Stereo ab dem nächsten Anruf.' }));
      body.append(
        field('Mikrofon', micSel, 'Namen erscheinen, sobald du einmal das Mikrofon erlaubt hast.'),
        audioField,
        field('Bildschirm teilen', qualSel, 'Gilt für dieses Gerät. Während einer Übertragung lässt sie sich über den Regler-Knopf neben „Bildschirm teilen“ ändern.'),
        el('label', { class: 'sc-check' + (S.cfg.relay ? '' : ' is-disabled') }, hide, el('span', { text: S.cfg.relay
          ? 'IP-Adresse verbergen: Anrufe nur über den Relay-Server. Dein Gegenüber sieht deine IP dann nicht.'
          : 'IP-Adresse verbergen – braucht einen Relay-Server (TURN), der auf diesem Server noch nicht eingerichtet ist.' })),
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
          'Benachrichtigungen, wenn SecureCom nicht im Blick ist – nur wer schreibt oder anruft, nie der Inhalt.' })));

      // Updates (nur Windows-App)
      if (UPDATES) {
        body.appendChild(sectionHead('UPDATES'));
        const auto = el('input', { type: 'checkbox', checked: !UPD.state || UPD.state.auto !== false });
        auto.addEventListener('change', () => { UPDATES.setAuto(auto.checked).catch(() => {}); });
        const ver = el('p', { class: 'sc-mono sc-update-version' });
        const box = el('div');
        const draw = (s) => {
          s = s || {};
          ver.textContent = 'SECURECOM ' + (s.version || '') + (s.mode === 'portable' ? ' · PORTABEL' : s.mode === 'installed' ? ' · INSTALLIERT' : '');
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

      // Sitzung / Konto
      body.appendChild(sectionHead(S.mode === 'temp' ? 'SITZUNG' : 'KONTO'));
      const acts = el('div', { class: 'sc-card-actions' });
      if (S.mode === 'account') {
        acts.append(
          el('button', { type: 'button', class: 'btn', onclick: () => { close(); changePassword(); } }, 'Passwort ändern'),
          el('button', { type: 'button', class: 'btn', onclick: () => { close(); logout(); } }, icon('logout', 14), 'Abmelden'),
          el('button', { type: 'button', class: 'btn sc-btn--danger', onclick: () => { close(); deleteAccount(); } }, icon('trash', 14), 'Konto löschen'));
      } else {
        acts.append(el('button', { type: 'button', class: 'btn sc-btn--danger', onclick: () => { close(); logout(); } }, icon('logout', 14), 'Sitzung beenden & alles löschen'));
      }
      body.append(acts,
        el('button', { type: 'button', class: 'btn btn--block', onclick: () => { close(); showSecurityInfo(); } }, icon('shield', 14), 'Wie SecureCom dich schützt'));
    }
  });
}

function editAlias() {
  openModal({
    title: 'ALIAS',
    build: (body, close) => {
      const suggestion = randomAlias();
      const input = el('input', { type: 'text', maxlength: '40', value: S.me.name || '', placeholder: suggestion });
      const go = el('button', { type: 'button', class: 'btn btn--primary btn--block', text: 'Speichern' });
      go.addEventListener('click', async () => {
        const name = cleanName(input.value) || suggestion;
        go.disabled = true;
        try {
          const card = await C.signCard(S.me.priv, { v: 1, id: S.me.id, kind: 'temp', name: name, ts: Date.now() });
          await api('card', { card: card });
          S.me.name = name;
          S.ids.get(S.me.id).name = name;
          close();
          renderAll();
        } catch (e) { go.disabled = false; toast(e.message, 'error'); }
      });
      input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go.click(); });
      body.append(field('Wie sollen andere dich sehen?', input, 'Der Alias steht auf deiner signierten Karte. Zur Unterscheidung zeigt SecureCom immer auch das Ende deines Fingerabdrucks.'), go);
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
        if (pass.value.length < 10) { toast('Die Passphrase braucht mindestens 10 Zeichen.', 'error'); return; }
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
        field('Passphrase', pass, fresh ? 'Vorbelegt mit deinem Kontopasswort. Die Datei ist damit geschützt und lässt sich auch in GnuPG oder Kleopatra importieren.' : 'Schützt die Datei. Lässt sich auch in GnuPG oder Kleopatra importieren.'),
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
        if (p1.value.length < 10) { toast('Das neue Passwort braucht mindestens 10 Zeichen.', 'error'); return; }
        if (p1.value !== p2.value) { toast('Die neuen Passwörter stimmen nicht überein.', 'error'); return; }
        go.disabled = true;
        go.textContent = 'Wird gehärtet …';
        try {
          const oldKeys = await C.deriveAccountKeys(S.username, old.value);
          const keys = await C.deriveAccountKeys(S.username, p1.value);
          const wrapKey = await C.importWrapKey(keys.wrapRaw, false);
          const wrapped = await C.sealText(wrapKey, C.armorPrivate(S.me.priv), keyAad(S.username));
          const vault = await C.sealText(wrapKey, JSON.stringify(S.vault), vaultAad());
          const r = await api('password', { old_auth: oldKeys.auth, auth: keys.auth, wrapped: wrapped, vault: vault });
          S.wrapKey = wrapKey;
          S.vv = r.vv;
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
      body.append(field('Bisheriges Passwort', old), field('Neues Passwort', p1), field('Neues Passwort wiederholen', p2), go);
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
          const keys = await C.deriveAccountKeys(S.username, pass.value);
          await api('delete', { auth: keys.auth });
          teardownMedia();
          await clearStoredSession();
          location.reload();
        } catch (e) { go.disabled = false; toast(e.message, 'error'); }
      });
      body.append(el('p', { class: 'sc-p', text: 'Löscht dein Konto, deinen Briefkasten, deinen eingepackten Schlüssel und deine Raummitgliedschaften vom Server. Räume, die dir gehören, übernimmt das älteste Mitglied.' }),
        field('Passwort zur Bestätigung', pass), go);
    }
  });
}

function showSecurityInfo() {
  openModal({
    title: 'WIE SECURECOM SCHÜTZT',
    wide: true,
    build: (body) => {
      const block = (title, lines) => {
        body.appendChild(sectionHead(title));
        const ul = el('ul', { class: 'sc-info' });
        for (const l of lines) ul.appendChild(el('li', { text: l }));
        body.appendChild(ul);
      };
      block('VERSCHLÜSSELUNG', [
        'Deine Identität ist ein OpenPGP-Schlüsselpaar (Curve25519: Ed25519 signiert, X25519 verschlüsselt). Es entsteht ' + (DESKTOP ? 'in der App' : 'in deinem Browser') + '.',
        'Direktnachrichten: Für jede Nachricht ein neuer, zufälliger AES-256-Schlüssel, der mit den öffentlichen Schlüsseln von Empfänger und Absender eingepackt wird. Dazu deine Signatur.',
        'Räume: ein gemeinsamer Raumschlüssel (AES-256-GCM). Er steht im Einladungslink hinter dem „#“ – dieser Teil einer Adresse geht nie an einen Server – oder kommt PGP-verschlüsselt vom Besitzer. Verlässt jemand den Raum, gibt es einen neuen.',
        'Anrufe und Bildschirm: WebRTC direkt zwischen den Geräten, verschlüsselt mit DTLS-SRTP. Die Schlüssel dafür handeln nur die beiden Browser aus; die Verbindungsangaben sind signiert und verschlüsselt, der Sicherheitscode zeigt, dass niemand dazwischensitzt.',
        'Konten: Aus deinem Passwort entstehen ' + LOCAL + ' (PBKDF2, 600.000 Runden, dann HKDF) ein Anmeldeschlüssel – beim Server nur als Hash – und ein Schlüssel, der deinen privaten Schlüssel einpackt. Das Passwort selbst verlässt ' + (DESKTOP ? 'die App' : 'den Browser') + ' nie.'
      ]);
      block('VERSCHLEIERUNG', [
        'Alle Klartexte werden vor dem Verschlüsseln auf feste Größen aufgefüllt – „ok“ und ein langer Absatz sind gleich groß.',
        'Beim Server steht an keiner Nachricht ein Absender; wer schreibt, steht nur verschlüsselt und signiert im Inneren.',
        'Raumnamen, Raumbilder, Kanäle und Kontakte sind verschlüsselt. Der Server kennt nur zufällige Kennungen.',
        'Konten stehen nie in der Online-Liste und zeigen niemandem, ob sie online sind. Dort erscheinen nur temporäre Sitzungen – und auch die nur, solange sie es wollen.',
        'Alle Anfragen gehen per POST an dieselbe Adresse. In den Protokollen des Webservers steht nicht, was passiert ist.',
        'Keine Cookies, keine fremden Server auf dieser Seite (auch keine Schriften von Google), strenge Content-Security-Policy.',
        'Anruf-Signale verfallen nach zwei Minuten, Nachrichten nach ' + S.cfg.retention_days + ' Tagen, temporäre Sitzungen nach ' + S.cfg.temp_hours + ' Stunden ohne Nutzung.'
      ]);
      block('WAS DER SERVER TROTZDEM SIEHT', [
        'IP-Adressen und Zeitpunkte der Anfragen (der Webserver des Hosters protokolliert sie).',
        'Wer gerade online ist, welche öffentlichen Schlüssel, Namen/Aliasse und Profilbilder (nur Konten) es gibt, wer in welchem Raum ist und wer in welchem Sprachkanal.',
        'Welcher Briefkasten wann wie viele Einträge bekommt.',
        'Bei Anrufen ohne Relay sehen sich die beiden Gesprächspartner gegenseitig die IP-Adresse.'
      ]);
      block('GRENZEN', [
        DESKTOP
          ? 'Die Windows-App bringt ihren Programmcode selbst mit. Der Server kann ihn nicht austauschen, er reicht nur Chiffretext weiter. Neuer Code kommt nur mit einer neuen Fassung der App.'
          : 'Wie jede Web-App lädt SecureCom seinen Programmcode vom Server. Ein Hoster, der gezielt manipulierten Code ausliefert, könnte das umgehen. Gegen Mitlesen auf dem Server, gestohlene Datenbanken und Lauscher im Netz schützt SecureCom vollständig. Die Windows-App bringt ihren Code selbst mit.',
        'Nachrichten sind mit deinem langfristigen Schlüssel verschlüsselt. Wer später an deinen privaten Schlüssel und alte Nachrichten kommt, kann diese lesen. Anrufe sind davon nicht betroffen, ihre Schlüssel gelten nur für das eine Gespräch.',
        'Die Sicherheit steht und fällt mit der Prüfung der Fingerabdrücke. Verifiziere wichtige Kontakte über einen zweiten Weg.'
      ]);
    }
  });
}

/* ==========================================================================
   Eingaben und Ereignisse
   ========================================================================== */
function bind() {
  $('sc-home').addEventListener('click', () => setView({ kind: 'home' }));
  $('sc-add-room').addEventListener('click', roomDialog);
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
  // Einladungslink in einen schon offenen SecureCom-Tab eingefügt: Die Seite
  // lädt dann nicht neu, nur der Teil hinter "#" ändert sich.
  window.addEventListener('hashchange', () => {
    if (!/^#join=/.test(location.hash)) return;
    parseJoinFragment();
    if (S.entered) offerPendingJoin();
    else if (!$('sc-gate').hidden) renderGate('temp');
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
