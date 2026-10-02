# Sicherheit

## Lücke gefunden?

Bitte nicht als öffentliches Issue melden, sondern vertraulich über
**Security → Report a vulnerability** in diesem Repository. Ich melde mich so
schnell wie möglich.

## Wovor SecureCom schützt

SecureCom geht davon aus, dass der Server mitliest, Daten herausgibt oder
gestohlen wird. Dagegen hilft die Ende-zu-Ende-Verschlüsselung: Alles
Verschlüsseln und Entschlüsseln passiert auf den Geräten
(`server/assets/securecom-core.js`). Der Server bekommt nur Chiffretext,
öffentliche Schlüssel und Signaturen. Auch wer den Netzverkehr belauscht, sieht
nur TLS und darin wieder Chiffretext.

## Bausteine

Alle Verfahren stammen aus [OpenPGP.js](https://github.com/openpgpjs/openpgpjs)
6.3.2 und der WebCrypto-Schnittstelle des Browsers. Nichts davon ist selbst
erfunden.

### Identität

- OpenPGP-Schlüssel (v4): Ed25519 zum Signieren, X25519 zum Verschlüsseln.
  Er entsteht im Browser, Fingerabdruck und Format sind mit GnuPG verträglich.
- Eine signierte Visitenkarte bindet Kennung, Art (Konto oder temporär) und
  Namen an den Schlüssel. Ändert der Server einen Namen, passt die Signatur
  nicht mehr.
- Kontakte werden beim ersten Kontakt gemerkt (Trust on first use). Taucht
  später ein anderer Schlüssel auf, warnt SecureCom deutlich und sperrt das
  Schreiben, bis man den neuen Schlüssel annimmt. Wer den Fingerabdruck über
  einen zweiten Weg geprüft hat, markiert den Kontakt als verifiziert.
- Der Export zum Sichern ist mit einer Passphrase geschützt (Iterated+Salted
  S2K, AES-256) und lässt sich in GnuPG einlesen.
- Profilbilder gibt es nur für Konten. Sie sind öffentlich wie der Name und
  liegen unverschlüsselt beim Server. Die signierte Karte nennt den
  SHA-256-Wert des Bildes, Browser zeigen nur ein Bild, das genau dazu passt.
  Der Browser schneidet es zu und kodiert es neu (Metadaten wie Ort oder Kamera
  fallen weg); der Server nimmt nur JPEG, PNG und WebP an.

### Direktnachrichten und Anruf-Signale

- OpenPGP nach RFC 9580: Für jede Nachricht ein neuer AES-256-Schlüssel, per
  X25519 für Empfänger und Absender eingepackt. Der Inhalt ist mit AES-256-OCB
  verschlüsselt und damit gegen Veränderung geschützt (SEIPD v2), dazu eine
  Ed25519-Signatur des Absenders. Hat jemand einen älteren eigenen Schlüssel
  importiert, der SEIPD v2 nicht ankündigt, nimmt OpenPGP.js das ältere Format
  (SEIPD v1: AES mit Prüfsumme gegen Veränderung).
- Ohne Kompression: Sie würde das Auffüllen (siehe unten) zunichtemachen.
- Beim Server steht an keiner Nachricht ein Absender. Wer geschrieben hat,
  steht nur verschlüsselt und signiert im Inneren.

### Räume

- Ein gemeinsamer Raumschlüssel: 32 Zufallsbytes, AES-256-GCM. Die Raumkennung
  und die Schlüsselgeneration gehen als zusätzliche Daten in die
  Authentifizierung ein, eine Nachricht lässt sich also nicht in einen anderen
  Raum oder eine andere Generation verschieben.
- Jede Nachricht ist vor dem Verschlüsseln mit dem PGP-Schlüssel des Absenders
  signiert. Mitglieder können sich deshalb nicht gegenseitig nachahmen, obwohl
  sie denselben Raumschlüssel haben.
- Der Schlüssel kommt mit dem Einladungslink hinter dem `#` (dieser Teil einer
  Adresse geht nie an einen Server) oder PGP-verschlüsselt direkt vom
  Besitzer.
- Verlässt jemand den Raum oder wird entfernt, erzeugt der Besitzer einen neuen
  Schlüssel (nächste Generation) und verschlüsselt ihn per PGP für alle
  verbliebenen Mitglieder. Alte Einladungen werden ungültig.
- Raumname, Text- und Sprachkanäle und das Raumbild sind mit dem Raumschlüssel
  verschlüsselt. Der Server kennt von Sprachkanälen nur zufällige Kennungen.

### Anrufe und Bildschirm

- WebRTC, Ton und Bild direkt zwischen den Geräten, verschlüsselt mit
  DTLS-SRTP. Die Schlüssel dafür handeln nur die beiden Geräte aus, sie gelten
  nur für dieses eine Gespräch.
- Die Verbindungsangaben (SDP) laufen als signierte und verschlüsselte Signale
  über den Server und verfallen nach zwei Minuten.
- Sicherheitscode: SHA-256 über die beiden DTLS-Fingerabdrücke, daraus sechs
  Ziffern. Sehen beide dieselbe Zahl, sitzt niemand dazwischen.
- Für Stereo-Ton ergänzt SecureCom vor dem Übernehmen der Verbindungsangaben
  des Gegenübers `stereo=1`. Der Sicherheitscode rechnet weiter mit den
  unveränderten, signierten Angaben.
- In einem Sprachkanal ist jeder mit jedem verbunden (bis 8 Personen), es gibt
  keinen Server, der Ton oder Bild mischt.

### Konten

- Aus Name und Passwort entsteht im Browser mit PBKDF2-SHA-256 (600.000 Runden)
  ein Hauptschlüssel. Per HKDF-SHA-256 werden daraus zwei unabhängige Werte:
  - ein Anmeldeschlüssel, den der Server nur als bcrypt-Hash (Kosten 12)
    speichert,
  - ein AES-256-GCM-Schlüssel, der den privaten PGP-Schlüssel und den Tresor
    (Kontakte, Raumschlüssel, Sperrliste, Einstellungen, Lesestand) einpackt.
- Das Passwort selbst verlässt den Browser nie. Der Server kann den privaten
  Schlüssel nicht auspacken.
- Mindestens 10 Zeichen. Wer die Daten des Servers stiehlt, kann offline
  Passwörter raten; jeder Versuch kostet 600.000 PBKDF2-Runden. Ein langes
  Passwort ist deshalb der beste Schutz.

### Auf dem Gerät

- Temporäre Sitzung: Der private Schlüssel liegt nur im Speicher dieses Tabs
  (`sessionStorage`) und ist weg, wenn der Tab zu ist.
- Konto mit „Angemeldet bleiben“: in IndexedDB der eingepackte private
  Schlüssel und ein WebCrypto-Schlüsselobjekt, das sich nicht auslesen lässt.
  Ohne das Häkchen gilt die Anmeldung nur für den Tab.

### Eigener Server (Windows, Docker)

- **SecureCom Server für Windows** erzeugt beim ersten Start ein eigenes
  Zertifikat (EC P-256, 800 Tage). Browser warnen beim ersten Aufruf; ob es
  das richtige ist, zeigt der Fingerabdruck im Fenster des Servers. Die
  Windows-App vertraut dem Zertifikat nur mit passendem Fingerabdruck in der
  `config.json` – ein anderes, selbst erstelltes Zertifikat lehnt sie ab.
- Der HTTPS-Teil lauscht auf dem eingestellten Port, PHP nur auf `127.0.0.1`.
  Programmteile, Einstellungen und Daten liefert der eingebaute PHP-Server über
  `router.php` nie aus; die Daten liegen ohnehin außerhalb des Programmordners.
- **Im Container** spricht SecureCom nur HTTP; HTTPS übernimmt der Proxy davor
  (Caddy in `compose.yaml`). Die Daten liegen im Volume `/data`, außerhalb des
  Webroots.
- Hinter einem Proxy zählt für die Rate-Limits die Adresse aus
  `X-Forwarded-For` – aber nur, wenn die Anfrage von einem Proxy aus
  `trusted_proxies` kommt. Sonst könnte sich jeder eine Adresse ausdenken.

## Verschleierung

- Alle Klartexte werden vor dem Verschlüsseln auf feste Größen aufgefüllt (256,
  512, 1024 … 65.536 Bytes, darüber Vielfache von 64 KiB). „ok“ und ein langer
  Absatz sind gleich groß.
- Alle Anfragen gehen per POST an dieselbe Adresse. In den Protokollen des
  Webservers steht nicht, was passiert ist.
- Konten stehen nie in der Online-Liste, und der Server gibt ihren
  Online-Status an niemanden heraus – sonst ließe sich ein dauerhafter Name
  mit Uhrzeiten verknüpfen. In der Liste erscheinen nur temporäre Sitzungen,
  solange sie sichtbar sein wollen. Wer in einem Sprachkanal ist, sehen
  weiterhin die Mitglieder dieses Raums.
- Kennungen sind zufällig. Sitzungs-Token liegen beim Server nur als
  SHA-256-Hash, die Ratenbegrenzung arbeitet mit einem HMAC der IP-Adresse statt
  mit der Adresse selbst.
- Zugangsdaten eines Relay-Servers (TURN) gibt der Server nur angemeldeten
  Sitzungen heraus, nicht der öffentlichen Seite.
- Keine Cookies, keine Anfragen an fremde Server (Schriften liegen bei), strenge
  Content-Security-Policy ohne Inline-Skripte.
- Anruf-Signale verfallen nach zwei Minuten, Nachrichten nach 30 Tagen,
  temporäre Sitzungen nach 24 Stunden ohne Nutzung (die letzten beiden lassen
  sich in `config.php` einstellen).

## Was der Server trotzdem sieht

- IP-Adressen und Zeitpunkte der Anfragen (der Webserver protokolliert sie).
- Wer gerade online ist (auch bei Konten – er zeigt es nur niemandem),
  welche öffentlichen Schlüssel, Namen und Profilbilder
  (nur Konten) es gibt, wer in welchem Raum ist und wer in welchem Sprachkanal
  (ohne dessen Namen).
- Welcher Briefkasten wann wie viele Einträge bekommt. Wer eine Nachricht
  abschickt, sieht er im Moment der Anfrage, speichert es aber nicht.
- Bei Anrufen ohne Relay sehen sich die Gesprächspartner gegenseitig die
  IP-Adresse, der STUN-Server sieht die eigene. „IP-Adresse verbergen“ leitet
  alles über TURN, sofern einer eingerichtet ist.

## Grenzen

- **Web-Fassung:** Wie jede Web-App lädt SecureCom seinen Programmcode vom
  Server. Ein Betreiber, der gezielt veränderten Code ausliefert, könnte
  Schlüssel abgreifen. Die Windows-App bringt ihren Code selbst mit (Protokoll
  `app://securecom`, Content-Security-Policy nur für eigene Dateien). Der
  Server kann ihn nicht austauschen.
- **Keine Forward Secrecy für Nachrichten:** Nachrichten sind mit den
  langfristigen Schlüsseln verschlüsselt. Wer später an einen privaten Schlüssel
  und gespeicherte Chiffretexte kommt, kann alte Nachrichten lesen. Anrufe sind
  davon nicht betroffen.
- **Raumschlüssel:** Wer einen Raumschlüssel kennt, kann alle Nachrichten
  dieser Generation lesen. Nach dem Entfernen eines Mitglieds sind erst die
  folgenden Nachrichten vor ihm sicher.
- **Fingerabdrücke:** Die Sicherheit hängt daran, dass wichtige Kontakte über
  einen zweiten Weg geprüft werden. Ohne Prüfung schützt nur Trust on first use.
- **Gerät:** Gegen Schadsoftware oder Browser-Erweiterungen mit Zugriff auf die
  Seite hilft keine Verschlüsselung.
- **Prüfung:** SecureCom hat kein externes Sicherheitsaudit hinter sich.
