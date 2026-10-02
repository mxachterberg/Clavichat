/* ==========================================================================
   SecureCom Server — PHP bereitstellen (host/php)
   --------------------------------------------------------------------------
   Der Windows-Server bringt PHP mit. Dieses Skript holt das offizielle
   Paket von php.net, prüft es gegen die festgelegte SHA-256-Prüfsumme und
   legt nur die nötigen Teile ab (~18 MB statt ~90 MB):
   php.exe, php8.dll, curl/openssl/mbstring samt Bibliotheken, Lizenz.
   Dazu die Laufzeit VCRUNTIME140.dll aus Windows, damit PHP auch auf
   Rechnern ohne „Visual C++ Redistributable“ startet.

     npm run php                         lädt von downloads.php.net
     node scripts/fetch-php.js --from D  nimmt ein entpacktes, bereits
                                         geprüftes PHP aus Ordner D
   ========================================================================== */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const VERSION = '8.3.35';
const ZIP = 'php-' + VERSION + '-nts-Win32-vs16-x64.zip';
const URL = 'https://downloads.php.net/~windows/releases/archives/' + ZIP;
// Aus https://downloads.php.net/~windows/releases/sha256sum.txt
const SHA256 = '25a8e2ac9ff30f1d768d1447c09a600617fa6e6082729f6e95f008b59c91fe45';

const KEEP = [
  'php.exe', 'php8.dll', 'license.txt',
  'libcrypto-3-x64.dll', 'libssl-3-x64.dll', 'libssh2.dll', 'nghttp2.dll', 'brotlicommon.dll', 'brotlidec.dll',
  'ext/php_curl.dll', 'ext/php_openssl.dll', 'ext/php_mbstring.dll'
];
const RUNTIME = ['vcruntime140.dll'];
const OUT = path.join(__dirname, '..', 'host', 'php');

async function download() {
  console.log('lade ' + URL);
  const res = await fetch(URL, { redirect: 'follow' });
  if (!res.ok) throw new Error('Download fehlgeschlagen: HTTP ' + res.status);
  const zip = Buffer.from(await res.arrayBuffer());
  const sum = crypto.createHash('sha256').update(zip).digest('hex');
  if (sum !== SHA256) throw new Error('Prüfsumme falsch: ' + sum + ' statt ' + SHA256);
  console.log('Prüfsumme stimmt (' + (zip.length / 1048576).toFixed(1) + ' MB)');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'securecom-php-'));
  const file = path.join(tmp, ZIP);
  fs.writeFileSync(file, zip);
  const dir = path.join(tmp, 'php');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Expand-Archive -LiteralPath $env:ZIP_FILE -DestinationPath $env:ZIP_DEST -Force'],
  { env: Object.assign({}, process.env, { ZIP_FILE: file, ZIP_DEST: dir }), stdio: 'inherit' });
  return dir;
}

function versionOf(dir) {
  return execFileSync(path.join(dir, 'php.exe'), ['-n', '-r', 'echo PHP_VERSION;']).toString().trim();
}

async function main() {
  const i = process.argv.indexOf('--from');
  const src = i > 0 ? path.resolve(process.argv[i + 1]) : await download();
  const found = versionOf(src);
  if (found !== VERSION) throw new Error('PHP ' + found + ' gefunden, erwartet ' + VERSION);

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'ext'), { recursive: true });
  for (const f of KEEP) fs.copyFileSync(path.join(src, f), path.join(OUT, f));
  const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  for (const f of RUNTIME) fs.copyFileSync(path.join(system, f), path.join(OUT, f));
  fs.writeFileSync(path.join(OUT, 'VERSION.txt'),
    'PHP ' + VERSION + ' (NTS, x64) von ' + URL + '\nSHA-256 des Pakets: ' + SHA256 + '\n' +
    'Dazu ' + RUNTIME.join(', ') + ' (Microsoft Visual C++ Runtime, weitergegeben nach deren Lizenz).\n');
  console.log('PHP ' + versionOf(OUT) + ' liegt in ' + OUT);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
