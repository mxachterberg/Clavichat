# Änderungen

Was sich von Version zu Version ändert. Beim Veröffentlichen wird der
Abschnitt einer Version zum Text des GitHub-Releases
(`.github/workflows/windows.yml`).

## Unveröffentlicht

- **Freunde:** „Freund hinzufügen“ per PGP-Schlüssel oder Fingerabdruck,
  mit Anfrage und Annahme. Freunde sehen gegenseitig ihren Status –
  verschlüsselt, der Server weiß nicht, wer mit wem befreundet ist.
- **Status** per Klick auf das eigene Profil unten links: Online,
  Beschäftigt, Abwesend, Als offline anzeigen. Nach 10 Minuten ohne
  Eingabe automatisch abwesend (Windows-App: am ganzen Rechner).
- **Aufbewahrung pro Unterhaltung:** 1 Stunde, 24 Stunden, 7 Tage
  (Standard) oder 30 Tage, für beide Seiten; in Räumen legt sie der
  Besitzer fest. Danach löscht der Server die Nachrichten wirklich.
- **Bildschirm teilen:** Rädchen mit Auflösung, Bildrate, Datenrate und
  Paketverlust; Zoom bis zehnfach (auch im Vollbild); Übertragung
  ausblenden – der Sender schickt dann nichts mehr.
- **Verbindungsqualität** oben rechts in Anrufen und Sprachkanälen.
- **Räume:** Rechtsklick-Menüs für Text- und Sprachkanäle; der Besitzer
  kann eine Sprachqualität für den ganzen Raum festlegen.
- **Relay-Server (TURN)** in den Einstellungen: zeigt, ob er da und
  erreichbar ist (mit Probe-Verbindung).
- Behoben: Nach einem Qualitätswechsel beim Bildschirmteilen blieb bei
  Zuschauern am Handy das Bild stehen. Die Qualität setzt jetzt der
  Encoder um; Handys bekommen höchstens 1080p mit 30 Bildern pro Sekunde.
- Behoben: Auf dem Handy klingelte ein eingehender Anruf nicht. Der Ton
  wird beim ersten Tippen freigeschaltet; Android vibriert.
- Kästchen im Stil der Seite.

## 1.4.0 – 02.10.2026

Erste Version unter neuem Namen und die erste, die sich selbst
aktualisiert. Auf sie steigt man einmal von Hand um: Installer über die
alte Fassung installieren (er ersetzt SecureCom) oder die neue portable
Fassung nehmen. Ab dann kommen Updates von selbst.

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
- **Konto mit dem Postfach von achterberg.dev** (nur auf achterberg.dev):
  Wer dort angemeldet ist, legt ein Konto ohne Passwort an. Das Postfach
  bestätigt ein signiertes Ticket (fünf Minuten, nur einmal), den Schlüssel
  schützt ein Wiederherstellungscode mit 160 Zufallsbits. Das Gerät bleibt
  angemeldet und meldet sich nach Ablauf der Sitzung still neu an. Auf einem
  neuen Gerät findet „Mit achterberg.dev anmelden“ den Kontonamen, dazu kommt
  der Code. In den Einstellungen lässt sich ein neuer Code erzeugen.
- **Qualitätsmenüs:** Ton- und Bildschirmqualität stehen nach Datenrate
  geordnet, von sparsam bis bestmöglich. Die Auswahlmenüs – auch im
  Freigabefenster der Windows-App – passen jetzt zum Stil der App.
- **Installer:** Ersetzt eine vorhandene SecureCom-Installation, statt
  daneben zu installieren; die Verknüpfungen heißen danach Clavichat.
- Meldungen bei falscher Anmeldung nennen Passwort oder Code.
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
