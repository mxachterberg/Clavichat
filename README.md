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
  Passphrase gesichert exportieren.
- **Wer ist da:** Online-Liste mit Alias, Kontoname und Fingerabdruck.
  Verbinden per öffentlichem Schlüssel oder Fingerabdruck.
- **Schreiben:** Direktnachrichten und Räume mit Textkanälen. Einladung per
  Link oder direkt; wer den Raum verlässt oder entfernt wird, löst einen neuen
  Raumschlüssel aus.
- **Sprechen und zeigen:** Sprach- und Videoanrufe, Sprachkanal in Räumen (bis
  8 Personen), Bildschirm teilen in wählbarer Qualität (von „Sparsam“ bis
  1440p mit 60 fps, auch während der Übertragung) – in der Windows-App auch mit
  dem Ton des Computers. Ein Sicherheitscode zeigt, dass niemand
  dazwischensitzt.
- **Benachrichtigungen** nennen nur Absender oder Anrufer, nie den Inhalt.

## So schützt SecureCom

| Was | Wie |
|---|---|
| Identität | OpenPGP-Schlüsselpaar (Ed25519 signiert, X25519 verschlüsselt), entsteht im Browser |
| Direktnachrichten, Anruf-Signale | OpenPGP (RFC 9580): neuer AES-256-Schlüssel pro Nachricht, für Empfänger und Absender eingepackt, AEAD (OCB), signiert |
| Räume | gemeinsamer Raumschlüssel, AES-256-GCM, jede Nachricht zusätzlich signiert. Im Einladungslink steht er hinter dem `#` und geht nie an einen Server |
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
desktop/           Windows-App (Electron), nimmt die Oberfläche aus server/assets
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
Mit TURN funktioniert auch die Einstellung „IP-Adresse verbergen“.

Außerdem in `config.sample.php`: Zugangscode für neue Konten, wie lange
Nachrichten liegen bleiben, Lebensdauer temporärer Sitzungen, Obergrenze der
Identitäten.

### Lokal testen

```
php -S 127.0.0.1:8130 -t server
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
Installer und portable Fassung in `desktop/dist/` ab. Startet Electron nicht,
weil npm das Installationsskript übersprungen hat:
`node node_modules/electron/install.js`.

Ein Tag wie `v1.0.1` baut die App über GitHub Actions und legt sie als Entwurf
unter Releases ab (`.github/workflows/windows.yml`).

## Lizenz

MIT, siehe [LICENSE](LICENSE). Mitgelieferte fremde Teile (OpenPGP.js unter
LGPL-3.0-or-later, Schriften unter SIL OFL) behalten ihre Lizenzen, siehe
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
