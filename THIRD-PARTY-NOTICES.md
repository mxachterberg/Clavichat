# Fremde Bestandteile

SecureCom selbst steht unter der MIT-Lizenz (siehe `LICENSE`). Diese Teile
stammen von anderen und behalten ihre eigenen Lizenzen:

| Bestandteil | Wo | Lizenz |
|---|---|---|
| [OpenPGP.js](https://github.com/openpgpjs/openpgpjs) 6.3.2 (Proton AG und Mitwirkende) | `server/assets/vendor/openpgp-6.3.2.min.js` | LGPL-3.0-or-later, Text in `server/assets/vendor/openpgp-6.3.2.LICENSE.txt` |
| [Inter](https://github.com/rsms/inter) | `server/assets/fonts/Inter-*.ttf` | SIL Open Font License 1.1 |
| [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) | `server/assets/fonts/JetBrainsMono-*.ttf` | SIL Open Font License 1.1 |
| [Electron](https://github.com/electron/electron) (nur Windows-App) | wird beim Bauen geladen | MIT |
| [electron-builder](https://github.com/electron-userland/electron-builder) (nur zum Bauen) | `desktop/node_modules` | MIT |

**OpenPGP.js** liegt unverändert als einzelne Datei bei, genau so, wie sie im
npm-Paket `openpgp@6.3.2` steht (Prüfsumme des Pakets aus der npm-Registry
geprüft). Den Quelltext gibt es dort und auf GitHub; die Datei lässt sich
jederzeit gegen eine eigene Fassung austauschen.
