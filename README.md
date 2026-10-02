# SecureCom

Ende-zu-Ende verschlüsselt schreiben, telefonieren und den Bildschirm teilen –
im Browser oder als Windows-App. Der Server speichert und verteilt nur
Chiffretext, öffentliche Schlüssel und Signaturen.

**Ausprobieren:** <https://achterberg.dev/app/securecom/> ·
**Windows-App:** [Releases](https://github.com/mxachterberg/securecom/releases)

> **English:** SecureCom is an end-to-end encrypted messenger with voice and
> video calls and screen sharing, built on OpenPGP.js, WebCrypto and WebRTC.
> The PHP server needs no database and only ever handles ciphertext. The
> Windows app (Electron) ships the client code itself, so the server cannot
> swap it. Documentation is in German; the crypto design is in
> [SECURITY.md](SECURITY.md).

## Was es kann

- **Ohne E-Mail:** Konto mit Name und Passwort – oder eine temporäre Sitzung,
  für die der Browser ein frisches PGP-Schlüsselpaar erzeugt. Wahlweise mit
  Alias. Eigene PGP-Schlüssel (GnuPG, Kleopatra) lassen sich übernehmen und mit
  Passphrase gesichert exportieren. Konten können ein Profilbild festlegen.
- **Wer ist da:** Online-Liste mit Alias und Fingerabdruck – nur für
  temporäre Sitzungen. Konten zeigen niemandem, ob sie online sind.
  Verbinden per öffentlichem Schlüssel oder Fingerabdruck.
- **Schreiben:** Direktnachrichten und Räume mit Textkanälen und Raumbild.
  Einladung per Link oder direkt; wer den Raum verlässt oder entfernt wird,
  löst einen neuen Raumschlüssel aus.
- **Sprechen und zeigen:** Sprach- und Videoanrufe in wählbarer Tonqualität
  (bis 128 kbit/s in Stereo), mehrere Sprachkanäle je Raum (je bis 8 Personen),
  Bildschirm teilen in wählbarer Qualität (von „Sparsam“ bis „Quelle“:
  Originalauflösung mit 60 fps, auch während der Übertragung) – in der
  Windows-App auch mit dem Ton des Computers. Ein Sicherheitscode zeigt, dass
  niemand dazwischensitzt.
- **Benachrichtigungen** nennen nur Absender oder Anrufer, nie den Inhalt.
- **Kleinigkeiten:** Unterhaltungen per Rechtsklick (Handy: lange drücken) als
  gelesen markieren oder löschen; temporäre Sitzungen ohne Alias bekommen einen
  Zufallsnamen; nach einem Anruf steht die Dauer im Verlauf.

## So schützt SecureCom

| Was | Wie |
|---|---|
| Identität | OpenPGP-Schlüsselpaar (Ed25519 signiert, X25519 verschlüsselt), entsteht im Browser |
| Direktnachrichten, Anruf-Signale | OpenPGP (RFC 9580): neuer AES-256-Schlüssel pro Nachricht, für Empfänger und Absender eingepackt, AEAD (OCB), signiert |
| Räume | gemeinsamer Raumschlüssel, AES-256-GCM, jede Nachricht zusätzlich signiert; Name, Kanäle und Raumbild ebenfalls verschlüsselt. Im Einladungslink steht der Schlüssel hinter dem `#` und geht nie an einen Server |
| Profilbilder | nur Konten, öffentlich wie der Name; die signierte Karte nennt den SHA-256-Wert, angezeigt wird nur ein passendes Bild |
| Anrufe, Bildschirm | WebRTC direkt zwischen den Geräten (DTLS-SRTP). Verbindungsangaben signiert und verschlüsselt, Sicherheitscode aus den DTLS-Fingerabdrücken |
| Konten | PBKDF2-SHA-256 (600.000 Runden) → HKDF → Anmeldeschlüssel (beim Server nur als bcrypt-Hash) und ein Schlüssel, der den privaten PGP-Schlüssel einpackt |
| Länge | jeder Klartext wird vor dem Verschlüsseln auf feste Größen aufgefüllt |

Details, Grenzen und was der Server trotzdem sieht: [SECURITY.md](SECURITY.md).

## Aufbau

```
server/            PHP-Server ohne Datenbank, dazu die Web-Oberfläche
  index.php        die Seite
  api.php          einzige Schnittstelle (nur POST, JSON)
  lib/             Server-Logik (SecureCom.php, util.php)
  assets/          Oberfläche: securecom.js, Kryptografie in securecom-core.js,
                   OpenPGP.js unter vendor/, Schriften unter fonts/
  router.php       Weiche für den eingebauten PHP-Server (php -S)
desktop/           Windows-App (Electron), nimmt die Oberfläche aus server/assets
  host/            SecureCom Server für Windows: PHP + HTTPS als Programm
Dockerfile         Server als Container (Apache + PHP)
compose.yaml       Container samt Caddy für HTTPS – fürs Homelab
docker/            Einstellungen für den Container
tests/e2e.mjs      Ende-zu-Ende-Test gegen einen laufenden Server
```

Kein Build-Schritt für die Web-Fassung: Die Oberfläche ist reines JavaScript
(ES-Module), der Server reines PHP.

## Eigenen Server einrichten

Gebraucht wird ein Webspace mit **PHP 8** (getestet mit 8.3), **HTTPS** und
Apache. Keine Datenbank, kein Composer; die PHP-Erweiterung `curl` nur für
Cloudflare-TURN.

1. Den Inhalt von `server/` hochladen, zum Beispiel nach `/securecom/`.
2. Optional `config.sample.php` als `config.php` speichern und anpassen. Am
   wichtigsten: `storage_dir` **außerhalb** des Webroots.
3. Ohne `storage_dir` legt SecureCom `storage/` neben `api.php` an und sperrt
   den Ordner per `.htaccess`. PHP muss dort schreiben dürfen (Ordner 755,
   Dateien 644, nie 777).
4. `https://example.com/securecom/` aufrufen.

**nginx** liest keine `.htaccess`. Dann selbst sperren: `lib/`, `storage/`,
`config.php` und Dateien mit den Endungen `.json`, `.jsonl`, `.key`, `.md`,
`.log`.

**Anrufe über Mobilfunk** brauchen oft einen Relay-Server (TURN), weil sich
die Geräte sonst nicht direkt erreichen. In `config.php` entweder einen eigenen
eintragen (`securecom_turn`) oder Cloudflare Realtime TURN (`securecom_cf_turn`).
Mit TURN funktioniert auch die Einstellung „IP-Adresse verbergen“. Die
Zugangsdaten bekommen nur angemeldete Sitzungen, damit niemand Fremdes das
TURN-Kontingent nutzt.

Außerdem in `config.sample.php`: Zugangscode für neue Konten, wie lange
Nachrichten liegen bleiben, Lebensdauer temporärer Sitzungen, Obergrenze der
Identitäten. Hinter einem Reverse-Proxy dessen Adresse unter `trusted_proxies`
eintragen – sonst teilen sich alle Besucher eine Adresse und damit die
Rate-Limits.

## Server unter Windows

Ohne Webspace, etwa für das Heimnetz: **SecureCom Server** startet den Server
per Doppelklick (Installer oder portable Fassung unter
[Releases](https://github.com/mxachterberg/securecom/releases)). PHP ist dabei,
einrichten muss man nichts.

- Das Fenster zeigt die Adressen, etwa `https://192.168.1.10:8443/`. Andere
  Geräte im Heimnetz öffnen sie im Browser; Windows fragt beim ersten Start
  nach der Firewall („Private Netzwerke“ erlauben).
- HTTPS mit einem selbst erstellten Zertifikat – Browser geben Verschlüsselung
  und Mikrofon nur über HTTPS frei. Beim ersten Aufruf warnt der Browser
  einmal; der Fingerabdruck im Fenster zeigt, ob es das richtige Zertifikat ist.
- Läuft im Hintergrund weiter (Symbol im Infobereich), auf Wunsch mit Windows.
- Daten und Einstellungen liegen in `%APPDATA%\SecureCom Server`: `data` und
  `config.php` (Zugangscode, Relay-Server). Ein Update ändert daran nichts.
- Aus dem Internet erreichbar machen geht auch (Portweiterleitung), dann aber
  besser mit eigener Domain und Docker – siehe unten.

## Docker / Homelab

```
docker compose up -d
```

`compose.yaml` startet SecureCom (Apache + PHP) und davor Caddy, das sich um
HTTPS kümmert. Die Adresse steht in `SECURECOM_SITE` (in einer `.env`-Datei
daneben oder in der Shell):

| `SECURECOM_SITE` | HTTPS |
|---|---|
| `chat.example.com` | Zertifikat von Let's Encrypt (Ports 80/443 müssen von außen erreichbar sein) |
| `192.168.1.10` | eigenes Zertifikat von Caddy – Browser warnen einmal |
| leer | `localhost` |

Schon ein Reverse-Proxy im Einsatz (Traefik, Nginx Proxy Manager …)? Dann nur
den Dienst `securecom` nehmen, einen Port freigeben (`"8080:80"`) und den Proxy
dorthin zeigen lassen. Ab dem ersten Release gibt es das Image fertig (amd64
und arm64, also auch für den Raspberry Pi): `ghcr.io/mxachterberg/securecom`.

Einstellungen über Umgebungsvariablen, alle optional (Liste in
`docker/config.php`): `SECURECOM_PUBLIC_URL`, `SECURECOM_ACCESS_CODE`,
`SECURECOM_RETENTION_DAYS`, `SECURECOM_TEMP_HOURS`, `SECURECOM_STUN`,
`SECURECOM_TURN_URLS` mit `_USERNAME` und `_CREDENTIAL`,
`SECURECOM_CF_TURN_KEY_ID` mit `_API_TOKEN`, `SECURECOM_TRUSTED_PROXIES`.
Die Daten liegen im Volume `/data` – das ist alles, was gesichert werden muss.

### Lokal testen

```
php -S 127.0.0.1:8130 -t server server/router.php
node tests/e2e.mjs
```

Der Test (Node 20 oder neuer) legt Identitäten, ein Konto und einen Raum an,
prüft Verschlüsselung, Signaturen, Rechte und Schlüsselwechsel und löscht am
Ende alles wieder. Gegen einen anderen Server:
`SECURECOM_API=https://example.com/securecom/api.php node tests/e2e.mjs`.

## Windows-App

Installer und portable Fassung liegen unter
[Releases](https://github.com/mxachterberg/securecom/releases). Die App ist
nicht signiert; Windows SmartScreen fragt deshalb beim ersten Start nach
(„Weitere Informationen“ → „Trotzdem ausführen“).

Unterschiede zur Web-Fassung:

- Die Oberfläche steckt in der App. Der Server kann den Programmcode nicht
  austauschen, er reicht nur Chiffretext weiter.
- Bildschirm teilen mit Auswahl von Bildschirm oder Fenster, Qualität und auf
  Wunsch dem Ton des Computers.
- Eigene Titelleiste im Stil der App; die Fensterknöpfe folgen Hell und Dunkel.
- Benachrichtigungen sind von Anfang an an, eingehende Anrufe lassen das
  Fenster in der Taskleiste blinken.

Die App verbindet sich mit `https://achterberg.dev`. Für einen eigenen Server
`%APPDATA%\SecureCom\config.json` anlegen:

```json
{
  "api": "https://example.com/securecom/api.php",
  "web": "https://example.com/securecom/"
}
```

`web` ist die Adresse für Einladungslinks. Liegt SecureCom wie auf
achterberg.dev unter `/app/securecom/`, reicht `{ "server": "https://example.com" }`.
Für den **SecureCom Server** (selbst erstelltes Zertifikat) kommt
`"fingerprint"` dazu – den fertigen Text zeigt dessen Fenster. Die App vertraut
dann genau diesem Zertifikat und keinem anderen.
Dieselben Angaben gehen auch über die Umgebungsvariablen `SECURECOM_SERVER`,
`SECURECOM_API` und `SECURECOM_WEB`. Unverschlüsseltes `http` akzeptiert die App
nur für `localhost` und `127.0.0.1`.

### Selbst bauen

```
cd desktop
npm ci
npm start
npm run build
```

`npm start` öffnet die App direkt aus dem Quelltext, `npm run build` legt
Installer und portable Fassung in `desktop/dist/` ab. Der Windows-Server:
`npm run php` (lädt PHP von php.net und prüft die SHA-256), dann
`npm run server` zum Ausprobieren oder `npm run build:server`
(nach `desktop/dist-server/`). Startet Electron nicht,
weil npm das Installationsskript übersprungen hat:
`node node_modules/electron/install.js`.

Ein Tag wie `v1.3.0` baut über GitHub Actions App und Server und legt beide als
Entwurf unter Releases ab; dasselbe Tag baut das Docker-Image
(`.github/workflows/`).

## Lizenz

MIT, siehe [LICENSE](LICENSE). Mitgelieferte fremde Teile (OpenPGP.js unter
LGPL-3.0-or-later, Schriften unter SIL OFL) behalten ihre Lizenzen, siehe
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
