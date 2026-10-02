# Änderungen

Was sich von Version zu Version ändert. Beim Veröffentlichen wird der
Abschnitt einer Version zum Text des GitHub-Releases
(`.github/workflows/windows.yml`).

## Unveröffentlicht

- **Neuer Name: Clavichat** (von lateinisch *clavis*, „der Schlüssel“) –
  vorher SecureCom. Die Web-App liegt jetzt unter `/app/clavichat/`; alte
  Adressen und Einladungslinks leiten weiter, ältere Windows-Apps sprechen
  weiter mit dem Server. Anmeldung, Einstellungen und Server-Daten bleiben
  erhalten.
- **Automatische Updates (Windows-App):** Sucht beim Start im Hintergrund
  nach einer neuen Fassung und fragt per Popup, ob sie installiert werden
  soll. In den Einstellungen unter „UPDATES“ lässt sich das abschalten,
  von Hand suchen und aktualisieren. Installiert wird nur, was mit dem
  Schlüssel des Herausgebers signiert ist (Ed25519) und zur angekündigten
  Prüfsumme passt. Die portable Fassung ersetzt sich an derselben Stelle,
  Verknüpfungen bleiben gültig.
- **Portable Fassung** heißt jetzt ohne Versionsnummer `Clavichat-portable.exe`.
- **Taskleiste:** Die portable Fassung hat eine eigene App-Kennung. Bisher
  teilte sie sich die Kennung mit der installierten Fassung. Gab es von
  dieser eine Verknüpfung – oder nach dem Deinstallieren eine verwaiste –,
  zeigte Windows deren Symbol, im schlechten Fall ein weißes Blatt.
- **Bauen:** In `desktop/dist` und `desktop/dist-server` bleibt nur die
  aktuelle Version liegen (`npm run build`, `npm run build:server`).

## 1.3.1 – 02.10.2026

- **Online-Liste nur noch mit temporären Sitzungen.** Konten stehen nie
  darin und zeigen niemandem, ob sie online sind. In Räumen erscheinen sie
  unter „STATUS VERBORGEN“, im Sprachkanal unter ONLINE.
- „schreibt …“ auch an Konten; veraltete Tipp-Hinweise werden verworfen.
- Windows-App und Server: Symbol in allen Größen (16–256 Pixel), feste
  App-Kennung, „erneut starten“ der Taskleiste zeigt auf die bleibende
  Programmdatei.

## 1.3.0 – 02.10.2026

Erste Version auf GitHub.

- Ende-zu-Ende verschlüsselte Direktnachrichten und Räume mit Text- und
  mehreren Sprachkanälen; Anrufe mit Ton, Kamera und Bildschirm.
- Profilbilder für Konten, Raumbilder, wählbare Ton- und
  Bildschirmqualität (bis „Quelle“ mit 60 fps).
- Windows-App mit Titelleiste im App-Stil, Auswahl von Bildschirm oder
  Fenster samt Computerton.
- SecureCom Server für Windows (PHP und HTTPS als Programm) und Docker fürs
  Homelab.
