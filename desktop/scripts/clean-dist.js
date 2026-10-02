/* ==========================================================================
   SecureCom — nach dem Bauen aufräumen
   In dist/ bzw. dist-server/ bleibt nur die aktuelle Version aus
   package.json liegen; ältere Installer und portable Fassungen kommen weg.
   Läuft von selbst nach npm run build und npm run build:server.
   Aufruf: node scripts/clean-dist.js dist
   ========================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { version } = require('../package.json');

const dir = path.join(__dirname, '..', process.argv[2] || 'dist');
// SecureCom-1.3.0-portable.exe, SecureCom-Setup-1.3.0.exe(.blockmap),
// SecureCom-Server-1.3.0-portable.exe, SecureCom-Server-Setup-1.3.0.exe …
const ARTIFACT = /^SecureCom(?:-Server)?(?:-Setup)?-(\d+\.\d+\.\d+)(?:-portable)?\.exe(?:\.blockmap)?$/;

if (!fs.existsSync(dir)) process.exit(0);
for (const name of fs.readdirSync(dir)) {
  const m = ARTIFACT.exec(name);
  if (!m || m[1] === version) continue;
  try {
    fs.rmSync(path.join(dir, name), { force: true });
    console.log('entfernt:', name);
  } catch (e) {
    // Läuft die alte portable Fassung noch, ist ihre Datei gesperrt.
    console.warn('nicht entfernt (läuft sie noch?):', name, '–', e.code || e.message);
  }
}
