/* ==========================================================================
   Clavichat — nach dem Bauen aufräumen
   In dist/ bzw. dist-server/ bleibt nur, was der eben gelaufene Build
   erzeugt: Installer (samt .blockmap) und portable Fassung der aktuellen
   Version. Alles andere an .exe/.blockmap kommt weg – ältere Versionen und
   Dateien aus der Zeit, als die App SecureCom hieß.
   Läuft von selbst nach npm run build und npm run build:server.
   Aufruf: node scripts/clean-dist.js dist | dist-server
   ========================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const pkg = require('../package.json');

const which = process.argv[2] || 'dist';
const conf = which === 'dist-server' ? require('../host/builder.json') : pkg.build;
const dir = path.join(__dirname, '..', which);
const named = (pattern) => pattern.replaceAll('${version}', pkg.version).replaceAll('${ext}', 'exe');
const setup = named(conf.nsis.artifactName);
const keep = new Set([setup, setup + '.blockmap', named(conf.portable.artifactName)]);

if (!fs.existsSync(dir)) process.exit(0);
for (const name of fs.readdirSync(dir)) {
  if (!/\.(exe|blockmap)$/i.test(name) || keep.has(name)) continue;
  try {
    fs.rmSync(path.join(dir, name), { force: true });
    console.log('entfernt:', name);
  } catch (e) {
    // Läuft die alte portable Fassung noch, ist ihre Datei gesperrt.
    console.warn('nicht entfernt (läuft sie noch?):', name, '–', e.code || e.message);
  }
}
