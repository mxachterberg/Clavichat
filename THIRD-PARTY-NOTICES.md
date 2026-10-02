# Fremde Bestandteile

SecureCom selbst steht unter der MIT-Lizenz (siehe `LICENSE`). Diese Teile
stammen von anderen und behalten ihre eigenen Lizenzen:

| Bestandteil | Wo | Lizenz |
|---|---|---|
| [OpenPGP.js](https://github.com/openpgpjs/openpgpjs) 6.3.2 (Proton AG und Mitwirkende) | `server/assets/vendor/openpgp-6.3.2.min.js` | LGPL-3.0-or-later, Text in `server/assets/vendor/openpgp-6.3.2.LICENSE.txt` |
| [Inter](https://github.com/rsms/inter) | `server/assets/fonts/Inter-*.ttf` | SIL Open Font License 1.1 |
| [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) | `server/assets/fonts/JetBrainsMono-*.ttf` | SIL Open Font License 1.1 |
| [Electron](https://github.com/electron/electron) (Windows-App und -Server) | wird beim Bauen geladen | MIT |
| [electron-builder](https://github.com/electron-userland/electron-builder) (nur zum Bauen) | `desktop/node_modules` | MIT |
| [PHP](https://www.php.net/) 8.3 (nur SecureCom Server für Windows) | wird beim Bauen geladen (`npm run php`), im Programm unter `resources\php` | PHP License 3.01, Text in `resources\php\license.txt` |
| OpenSSL, libcurl, libssh2, nghttp2, Brotli (Teil des PHP-Pakets) | `resources\php` | Apache-2.0, curl-Lizenz, BSD-3-Clause, MIT, MIT |
| Microsoft Visual C++ Runtime (`vcruntime140.dll`) | `resources\php` | weitergegeben nach den Bedingungen von Microsoft für „Redistributable Code“ |
| Docker-Images [`php:8.3-apache`](https://hub.docker.com/_/php) und [`caddy:2`](https://hub.docker.com/_/caddy) (nur Container) | werden beim Bauen bzw. Starten geladen | PHP License, Apache-2.0 und die Lizenzen der Debian-Pakete |

**OpenPGP.js** liegt unverändert als einzelne Datei bei, genau so, wie sie im
npm-Paket `openpgp@6.3.2` steht (Prüfsumme des Pakets aus der npm-Registry
geprüft). Den Quelltext gibt es dort und auf GitHub; die Datei lässt sich
jederzeit gegen eine eigene Fassung austauschen.
