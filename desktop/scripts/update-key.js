/* ==========================================================================
   Clavichat — Schlüssel für signierte Updates
   Legt beim ersten Aufruf ein Ed25519-Schlüsselpaar an und zeigt danach
   immer den öffentlichen Schlüssel (der gehört in updater.js, PUBLIC_KEYS).
   Zwei Schlüssel sind im Einsatz: update-key.pem (Herausgeber, clavichat.de)
   und update-key-github.pem (Inhalt als Secret CLAVICHAT_UPDATE_KEY in
   GitHub Actions); anzeigen lassen mit SECURECOM_UPDATE_KEY=<Datei>.

   Der private Schlüssel liegt in %USERPROFILE%\.securecom\update-key.pem
   (oder dort, wohin SECURECOM_UPDATE_KEY zeigt). Er gehört nie ins Repo und
   nie auf den Webserver: Wer ihn hat, kann Updates für alle ausliefern.
   Geht er verloren, müssen alle die nächste Fassung einmal von Hand holen.

   Aufruf: node scripts/update-key.js
   ========================================================================== */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const KEY_FILE = process.env.SECURECOM_UPDATE_KEY || path.join(os.homedir(), '.securecom', 'update-key.pem');

function publicKeyOf(privatePem) {
  return crypto.createPublicKey(privatePem).export({ type: 'spki', format: 'der' }).toString('base64');
}

if (require.main === module) {
  if (!fs.existsSync(KEY_FILE)) {
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
    fs.writeFileSync(KEY_FILE, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
    console.log('Neuer privater Schlüssel:', KEY_FILE);
    console.log('Bitte sicher aufbewahren (z. B. Passwortmanager oder USB-Stick).');
  } else {
    console.log('Privater Schlüssel:', KEY_FILE);
  }
  console.log('Öffentlicher Schlüssel für updater.js (PUBLIC_KEYS):');
  console.log(publicKeyOf(fs.readFileSync(KEY_FILE, 'utf8')));
}

module.exports = { KEY_FILE, publicKeyOf };
