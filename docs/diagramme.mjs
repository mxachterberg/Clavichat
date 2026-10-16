// Erzeugt die Grafiken für README.md und SECURITY.md im Stil von
// clavichat.de – je in Hell und Dunkel. GitHub wählt per <picture> die
// passende Fassung zum eigenen Design.
//
//   node docs/diagramme.mjs
//
// Die Fassung in der App (interaktiv) baut securecom.js selbst: callDiagram()
// und sealDiagram(). Texte und Aufbau hier gleich halten.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));

// Farben wie --bg, --grid, --border … in assets/style.css der Seite.
const THEMES = {
  dunkel: { bg: '#0b0b0d', grid: 'rgba(255,255,255,.035)', border: '#242427', soft: '#1b1b1e', panel: '#101013',
    text: '#ededec', body: '#a2a2a7', muted: '#6f6f77', accent: '#f97316', green: '#4ade80' },
  hell: { bg: '#f6f6f4', grid: 'rgba(0,0,0,.045)', border: '#dedcd7', soft: '#e7e5e0', panel: '#fbfbfa',
    text: '#17171a', body: '#55555c', muted: '#83838c', accent: '#d1580c', green: '#2f9e52' }
};
const MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const SANS = "Inter, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function style(c) {
  return `<style>
.bg{fill:${c.bg}}
.grid{fill:none;stroke:${c.grid};stroke-width:1}
.box{fill:${c.panel};stroke:${c.border};stroke-width:1}
.tick{fill:none;stroke:${c.accent};stroke-width:1}
.t{font:500 12px ${MONO};letter-spacing:.14em;fill:${c.text}}
.s{font:400 12.5px ${SANS};fill:${c.muted}}
.l{font:400 10.5px ${MONO};letter-spacing:.1em;fill:${c.muted}}
.la{fill:${c.accent}}
.lg{fill:${c.green}}
.head{font:400 12px ${MONO};letter-spacing:.16em;fill:${c.muted}}
.sq{fill:${c.accent}}
.rule{stroke:${c.border};stroke-width:1}
.sep{stroke:${c.soft};stroke-width:1}
.row{font:500 11px ${MONO};letter-spacing:.12em;fill:${c.text}}
.cell{font:400 13px ${SANS};fill:${c.body}}
.note{font:400 12.5px ${SANS};fill:${c.muted}}
.sig{fill:none;stroke:${c.muted};stroke-width:1;stroke-dasharray:3 4}
.dir{fill:none;stroke:${c.accent};stroke-width:1.6;stroke-dasharray:6 5}
.rel{fill:none;stroke:${c.green};stroke-width:1.6;stroke-dasharray:6 5}
.seal{fill:none;stroke:${c.accent};stroke-width:2}
.lock path{fill:none;stroke:${c.accent};stroke-width:1.4}
.lock rect{fill:${c.panel};stroke:${c.accent};stroke-width:1.4}
.lock.g path,.lock.g rect{stroke:${c.green}}
</style>`;
}

function svg(w, h, c, title, desc, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img">
<title>${esc(title)}</title>
<desc>${esc(desc)}</desc>
${style(c)}
<defs><pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path class="grid" d="M40 0H0V40"/></pattern></defs>
<rect class="bg" width="${w}" height="${h}"/>
<rect width="${w}" height="${h}" fill="url(#grid)"/>
${body}
</svg>
`;
}

const text = (x, y, cls, s, anchor = 'middle') =>
  `<text x="${x}" y="${y}" class="${cls}" text-anchor="${anchor}" dominant-baseline="central">${esc(s)}</text>`;

/** Kasten wie .tickbox auf der Seite: Rahmen, orange Kreuze oben links und unten rechts. */
function box(x, y, w, h, title, sub) {
  return `<rect class="box" x="${x}" y="${y}" width="${w}" height="${h}"/>
<path class="tick" d="M${x - 4.5} ${y}h9M${x} ${y - 4.5}v9"/>
<path class="tick" d="M${x + w - 4.5} ${y + h}h9M${x + w} ${y + h - 4.5}v9"/>
${text(x + w / 2, y + h / 2 - 10, 't', title)}
${text(x + w / 2, y + h / 2 + 12, 's', sub)}`;
}

/** Abschnittskopf der Seite: ■ TITEL ──────── */
function head(x, y, w, label) {
  const end = x + 22 + label.length * 9.2 + 14;
  return `<rect class="sq" x="${x}" y="${y - 4}" width="8" height="8"/>
${text(x + 22, y, 'head', label, 'start')}
<path class="rule" d="M${end} ${y}H${x + w}"/>`;
}

function lock(x, y, open, green) {
  const d = open ? `M${x - 3.5} ${y - 3}v-6a3.5 3.5 0 0 1 7 0v1` : `M${x - 3.5} ${y - 3}v-3.5a3.5 3.5 0 0 1 7 0v3.5`;
  return `<g class="lock${green ? ' g' : ''}"><path d="${d}"/><rect x="${x - 6}" y="${y - 3}" width="12" height="9"/></g>`;
}

/* ---------- So läuft ein Anruf ------------------------------------------ */
function anruf(c, own) {
  const W = 880, H = own ? 530 : 470;
  const body = [
    head(40, 36, W - 80, own ? 'SELBST BETRIEBEN: EIGENER SERVER, EIGENES RELAY' : 'SO LÄUFT EIN ANRUF'),
    // Vermittlung über den Server (Angebot und Antwort, PGP-verschlüsselt)
    `<path class="sig" d="M135 196V112H341"/>`,
    `<path class="sig" d="M539 112H745V196"/>`,
    text(238, 98, 'l', 'ANGEBOT · ANTWORT'),
    text(642, 98, 'l', 'PGP-VERSCHLÜSSELT'),
    // Ton und Bild: direkt …
    `<path class="dir" d="M234 232H646"/>`,
    text(440, 214, 'l la', 'OHNE „IP VERBERGEN“: DIREKT'),
    text(440, 250, 'l la', 'DAS GEGENÜBER SIEHT DEINE IP'),
    // … oder über das Relay
    `<path class="rel" d="M135 268V352H341"/>`,
    `<path class="rel" d="M539 352H745V268"/>`,
    text(238, 338, 'l lg', 'MIT „IP VERBERGEN“'),
    text(642, 338, 'l lg', 'SIEHT NUR DAS RELAY'),
    box(40, 200, 190, 64, 'DU', 'dein Gerät'),
    box(345, 80, 190, 64, own ? 'DEIN SERVER' : 'SERVER', own ? 'Webspace · Docker · Windows' : 'nur Vermittlung'),
    box(650, 200, 190, 64, 'GEGENÜBER', 'sein Gerät'),
    box(345, 320, 190, 64, own ? 'DEIN RELAY' : 'RELAY (TURN)', own ? 'coturn oder Cloudflare' : 'z. B. Cloudflare'),
    // Legende
    `<path class="dir" d="M40 430H66"/>`, text(76, 430, 'note', 'direkt – das Gegenüber sieht deine IP', 'start'),
    `<path class="rel" d="M335 430H361"/>`, text(371, 430, 'note', 'über das Relay – es sieht nur das Relay', 'start'),
    `<path class="sig" d="M640 430H666"/>`, text(676, 430, 'note', 'Vermittlung (verschlüsselt)', 'start'),
    own ? text(40, 466, 'note', 'Server und Relay betreibst du: IP-Adressen und Zeitpunkte sehen nur du und dein Hoster – Inhalte niemand.', 'start') : '',
    own ? text(40, 492, 'note la', 'Zu Hause betrieben und aus dem Internet erreichbar, sehen alle Nutzer deine Heim-IP.', 'start') : ''
  ].join('\n');
  if (own) {
    return svg(W, H, c, 'Clavichat selbst betrieben',
      'Mit eigenem Server und eigenem Relay (coturn oder Cloudflare mit eigenem Schlüssel) läuft alles wie beim offiziellen Server: Das Angebot geht PGP-verschlüsselt über deinen Server, Ton und Bild direkt oder über dein Relay. IP-Adressen sehen nur du und dein Hoster.', body);
  }
  return svg(W, H, c, 'So läuft ein Anruf bei Clavichat',
    'Das Verbindungsangebot läuft PGP-verschlüsselt über den Server. Ton und Bild laufen direkt zwischen den Geräten – dann sieht das Gegenüber deine IP – oder mit „IP verbergen“ über das Relay, das nur verschlüsselte Pakete sieht.', body);
}

/* ---------- Wo verschlüsselt wird --------------------------------------- */
const ROWS = [
  ['DIREKTNACHRICHT',
    ['OpenPGP: AES-256 je Nachricht,', 'für dich + Empfänger, signiert'],
    ['nur Chiffretext, ohne Absender,', 'mit Ablaufdatum'],
    ['packt mit privatem Schlüssel', 'aus, prüft die Signatur']],
  ['RAUMNACHRICHT',
    ['AES-256-GCM mit dem', 'Raumschlüssel, PGP-signiert'],
    ['Chiffretext im Raumverlauf;', 'Name und Kanäle verschlüsselt'],
    ['Mitglieder: Raumschlüssel', 'aus dem Link (hinter #)']],
  ['ANRUF: ANGEBOT',
    ['wie eine Direktnachricht:', 'PGP-verschlüsselt, signiert'],
    ['reicht es nur weiter,', 'verfällt nach 2 Minuten'],
    ['entschlüsselt, prüft Signatur', 'und Sicherheitscode']],
  ['TON · BILD',
    ['WebRTC: DTLS-SRTP, Schlüssel', 'nur in den beiden Geräten'],
    ['läuft nicht über den Server –', 'direkt oder über das Relay'],
    ['entschlüsselt; Sicherheitscode', 'aus den DTLS-Fingerabdrücken'], true],
  ['STATUS (FREUNDE)',
    ['AES-256-GCM, Schlüssel und', 'Fächer per HKDF aus Geheimnis'],
    ['zufälliges Fach, Chiffretext,', 'nach 150 Sekunden weg'],
    ['Freunde kennen das Geheimnis', 'und entschlüsseln']],
  ['TRESOR (KONTO)',
    ['AES-256-GCM, Schlüssel aus', 'Passwort: PBKDF2 → HKDF'],
    ['nur eingepackt; vom Passwort', 'nur ein bcrypt-Hash'],
    ['deine anderen Geräte,', 'nach der Anmeldung']]
];

function verschluesselung(c) {
  const W = 980, TOP = 104, RH = 88;
  const H = TOP + ROWS.length * RH + 90;
  const COLS = [{ x: 220, label: 'AUF DEINEM GERÄT' }, { x: 480, label: 'BEIM SERVER' }, { x: 740, label: 'BEIM EMPFÄNGER' }];
  const out = [head(40, 36, W - 80, 'WO VERSCHLÜSSELT WIRD')];
  for (const col of COLS) out.push(text(col.x, 78, 'l', col.label, 'start'));
  out.push(`<path class="rule" d="M40 92H${W - 40}"/>`);
  ROWS.forEach(([label, a, b, d, media], i) => {
    const top = TOP + i * RH;
    out.push(text(40, top + 20, 'row', label, 'start'));
    [a, b, d].forEach((lines, k) => lines.forEach((l, j) => out.push(text(COLS[k].x, top + 20 + j * 19, 'cell', l, 'start'))));
    const y = top + 66;
    out.push(`<path class="${media ? 'rel' : 'seal'}" d="M330 ${y}H850"/>`, lock(330, y, false, media), lock(850, y, true, media));
    if (i < ROWS.length - 1) out.push(`<path class="sep" d="M40 ${top + RH - 5}H${W - 40}"/>`);
  });
  const fy = TOP + ROWS.length * RH + 20;
  out.push(`<path class="rule" d="M40 ${fy - 14}H${W - 40}"/>`,
    lock(46, fy + 6, false), text(62, fy + 6, 'note', 'verschlüsselt auf dem Gerät', 'start'),
    lock(276, fy + 6, true), text(292, fy + 6, 'note', 'entschlüsselt beim Empfänger', 'start'),
    text(40, fy + 34, 'note', 'Unterwegs schützt zusätzlich TLS (HTTPS). Der private Schlüssel verlässt nie das Gerät.', 'start'));
  return svg(W, H, c, 'Wo Clavichat verschlüsselt',
    'Für Direktnachrichten, Räume, Anrufe, Status und Tresor: was auf deinem Gerät verschlüsselt wird, was der Server davon sieht und wo entschlüsselt wird.', out.join('\n'));
}

for (const [name, theme] of Object.entries(THEMES)) {
  fs.writeFileSync(path.join(DIR, `anruf-${name}.svg`), anruf(theme));
  fs.writeFileSync(path.join(DIR, `anruf-selbst-${name}.svg`), anruf(theme, true));
  fs.writeFileSync(path.join(DIR, `verschluesselung-${name}.svg`), verschluesselung(theme));
}
console.log('Grafiken geschrieben: docs/anruf-*.svg, docs/anruf-selbst-*.svg, docs/verschluesselung-*.svg');
