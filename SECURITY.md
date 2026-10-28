# Sicherheit

## Lücke gefunden?

Bitte nicht als öffentliches Issue melden, sondern vertraulich über
**Security → Report a vulnerability** in diesem Repository. Ich melde mich so
schnell wie möglich.

## Wovor Clavichat schützt

Clavichat geht davon aus, dass der Server mitliest, Daten herausgibt oder
gestohlen wird. Dagegen hilft die Ende-zu-Ende-Verschlüsselung: Alles
Verschlüsseln und Entschlüsseln passiert auf den Geräten
(`server/assets/securecom-core.js`). Der Server bekommt nur Chiffretext,
öffentliche Schlüssel und Signaturen. Auch wer den Netzverkehr belauscht, sieht
nur TLS und darin wieder Chiffretext.

## Bausteine

Alle Verfahren stammen aus [OpenPGP.js](https://github.com/openpgpjs/openpgpjs)
6.3.2 und der WebCrypto-Schnittstelle des Browsers. Nichts davon ist selbst
erfunden. Im Überblick – wo verschlüsselt wird und was der Server davon sieht:

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/verschluesselung-dunkel.svg">
  <img alt="Wo verschlüsselt wird: Direktnachrichten mit OpenPGP, Räume mit AES-256-GCM, Anrufe mit DTLS-SRTP, Status und Tresor mit AES-256-GCM – der Server sieht jeweils nur Chiffretext." src="docs/verschluesselung-hell.svg" width="100%">
</picture>

### Identität

- OpenPGP-Schlüssel (v4): Ed25519 zum Signieren, X25519 zum Verschlüsseln.
  Er entsteht im Browser, Fingerabdruck und Format sind mit GnuPG verträglich.
- Eine signierte Visitenkarte bindet Kennung, Art (Konto oder temporär) und
  Namen an den Schlüssel. Ändert der Server einen Namen, passt die Signatur
  nicht mehr.
- Kontakte werden beim ersten Kontakt gemerkt (Trust on first use). Taucht
  später ein anderer Schlüssel auf, warnt Clavichat deutlich und sperrt das
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
- **Nachrichtenanfragen:** Wer zum ersten Mal schreibt (kein Kontakt, kein
  Freund, kein gemeinsamer Raum), landet unter „Nachrichtenanfragen“: ohne
  Ton, Links nur als Text, Einladungen und Dateien gesperrt. Anrufe von
  Unbekannten klingeln bei Konten nicht (einstellbar; bei temporären
  Sitzungen von Haus aus an) – auch kein „besetzt“, das verriete, dass man
  da ist. Angenommen oder abgelehnt wird im verschlüsselten Tresor.

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
- Einladungen (Link oder direkt) erstellen nur der Besitzer und Ränge mit
  „Administrator“. Ein Link gilt nur, solange sein Ersteller das beim
  Einlösen noch darf – Herabstufen oder Gehen macht seine Links ungültig,
  der Server entfernt sie beim nächsten Schreibzugriff. Ausnahme
  Einmal-Meetings: Dort teilen Teilnehmer Links, der Gastgeber bestätigt
  jeden Beitritt. Wer den Schlüssel aus einem Link hat, kann alles lesen,
  was mit diesem Schlüssel verschlüsselt ist (siehe Vorschau) – Links nur
  über sichere Wege teilen.
- Raumname, Text- und Sprachkanäle und das Raumbild sind mit dem Raumschlüssel
  verschlüsselt. Der Server kennt von Sprachkanälen nur zufällige Kennungen.
- Zusätzlich wechselt der Besitzer den Schlüssel jede Woche – nicht, solange
  Einladungslinks offen sind (sie würden sonst ungültig). Siehe Forward
  Secrecy.
- Vorschau einer Einladung: Mit gültigem Einladungscode liefert der Server
  ohne Anmeldung die verschlüsselten Raumdaten und die Mitgliederzahl
  (`invite.info`) – dieselben Daten, die man beim Beitritt bekäme. Name und
  Bild entschlüsselt erst die App mit dem Schlüssel aus dem Link. Links von
  Teilnehmern eines Einmal-Meetings (Beitritt nach Zustimmung) liefern nichts
  davon. Folge: Wer einen gültigen Link hat, liest die ganzen Raumdaten –
  samt Leseschlüsseln der API-Zugänge und Schlüsselarchiv –, auch ohne
  beizutreten. Und schon das Öffnen eines Links (die Vorschau) verrät dem
  Server die IP-Adresse, bevor man „Beitreten“ wählt.
- „Neue Mitglieder sehen den Verlauf“ (Einstellung des Besitzers, aus): Neue
  bekommen mit dem Link nur den aktuellen Schlüssel. Ist die Einstellung an,
  legt die App des Besitzers die älteren Generationen, die sie noch hat, in
  die Raumdaten – als von ihm signiertes Archiv (`ks`: Raum, Generation der
  Raumdaten, Schlüssel, Zeitpunkt), mit dem aktuellen Schlüssel
  verschlüsselt; der Server sieht es nicht. Apps übernehmen alte Schlüssel
  nur aus einem Archiv mit Unterschrift des Besitzers für diesen Raum und
  diese Generation. Ob archiviert wird, steht nur im Tresor des Besitzers –
  Ränge mit Verwaltungsrechten können das Archiv weder einschalten noch
  ändern, nur unverändert weitergeben. Wer den aktuellen Schlüssel hat
  (Mitglied oder Inhaber eines gültigen Links), bekommt damit alle
  archivierten Generationen. Archiviert werden nur Generationen, deren
  Nachrichten noch aufbewahrt werden können (höchstens 64). Ausschalten nimmt
  das Archiv heraus und wechselt den Raumschlüssel; wer die Schlüssel schon
  hat, behält sie. Für Apps bis 1.9.2 steht das Archiv zusätzlich
  unsigniert in den Raumdaten; neuere lesen nur das signierte. Wer die
  Einstellung mit 1.9.1/1.9.2 eingeschaltet hat, muss sie nach dem Update
  einmal neu einschalten.
- Raumdaten nimmt eine App nur von Mitgliedern an – von Nicht-Mitgliedern
  (Ehemalige, die den Schlüssel noch haben, oder Inhaber eines Links) nur,
  wenn es genau die schon angenommenen sind oder sie als Verwalter schon
  Raumdaten geschrieben haben, solange sie Mitglied waren. Raumdaten tragen
  einen signierten Zeitpunkt; ältere als die zuletzt angenommenen (ältere
  Generation oder mehr als eine Minute früher, bei Apps bis 1.9.2 zehn
  Minuten) lehnt die App ab – der Server kann keine alten Raumdaten
  unterschieben. Eine App ohne gemerkten Stand (neues Gerät, neues
  Mitglied) nimmt, was der Server als aktuell liefert.
- Reaktionen sind Raum-Einträge wie Nachrichten (`t: 'react'`, verschlüsselt
  und signiert); der Server unterscheidet sie nicht von Nachrichten – außer
  in Kanälen, in denen der Reagierende nicht schreiben darf (siehe Ränge).

### Ränge und Rechte

- Wie bei Discord: Ränge bündeln Rechte (schreiben, reagieren, Sprachkanäle,
  Kanäle/Raum/Nachrichten/API-Zugänge/Ränge verwalten, Mitglieder
  entfernen, Administrator). Einladen dürfen nur Besitzer und
  Administratoren (das frühere Recht „Einladen“, Bit 8, wirkt nur noch in
  Meetings). Der Server setzt sie durch und kennt dafür je
  Rang eine zufällige Kennung, die Rechte (Bits), die Reihenfolge und wer
  welchen Rang hat. Namen und Farben der Ränge stehen nur verschlüsselt in
  den Raumdaten.
- Rangordnung: Wer Ränge verwaltet oder Mitglieder entfernt, wirkt nur auf
  Ränge und Mitglieder unter seinem höchsten Rang und gibt nur Rechte
  weiter, die er selbst hat. Der Besitzer steht über allen.
- Beim Besitzer bleiben immer: Raumschlüssel (Wechsel, Wochenwechsel,
  Schlüsselpakete), „Nur Mitglieder mit Konto“, Beitrittsanfragen in
  Meetings, „Permanent“ nur als Konto, Raum löschen. Entfernt ein Rang ein
  Mitglied, erneuert die App des Besitzers den Raumschlüssel, sobald sie den
  Hinweis im Verlauf sieht – bis dahin kennt der Entfernte den aktuellen
  Schlüssel noch, bekommt aber keine Einträge mehr vom Server.
- Raumdaten (Kanäle, Name, Bild, API-Zugänge, Rang-Namen) darf neu
  verschlüsseln, wer eines der Verwaltungsrechte hat (Kanäle, Raum,
  API-Zugänge, Ränge, Administrator). Was genau sich darin ändert, sieht der
  Server nicht: Jeder solche Rang kann technisch alles darin ändern – Name,
  Bild, Sprachqualität, Kanäle (auch löschen, dann sind deren Nachrichten
  nicht mehr zu sehen), Rang-Namen und -Farben und die Leseschlüssel der
  API-Zugänge (austauschen oder entfernen macht deren Beiträge unlesbar).
  Nicht ändern kann er Rechte und Rangordnung (setzt der Server durch), das
  Schlüsselarchiv (signiert der Besitzer) und den Raumschlüssel.
- Schreibrecht je Textkanal („nur bestimmte Ränge“): Lesen können weiter
  alle Mitglieder – der Raumschlüssel gilt für den ganzen Raum, nicht je
  Kanal. Neue Apps nennen dem Server bei solchen Kanälen die Kanal-Kennung
  (`c`); er lehnt Beiträge ohne Recht ab und erfährt dafür, welche
  Einträge zu diesem Kanal gehören. Weil eine ältere oder veränderte App die
  Kennung weglassen kann, zeigen die Apps in beschränkten Kanälen nur, was
  der Server geprüft hat (`c` passt), was vor der Beschränkung kam oder was
  ein laut aktuellen Rängen Berechtigter signiert hat. Reaktionen von
  Mitgliedern ohne Schreibrecht gehen mit `rx` (der Server prüft dann
  „reagieren“ und vermerkt `r` am Eintrag – er erfährt damit, dass es eine
  Reaktion ist).
- Sprachkanäle lassen sich ebenso auf Ränge beschränken (betreten).
- Gegen einen böswilligen Server schützen Kanal-Beschränkungen nicht: Er
  liefert Rechte, Ränge und Mitgliederliste selbst und könnte Beiträge ohne
  Prüfung annehmen oder als geprüft markieren. Geschützt bleibt nur, was
  die Kryptografie sichert – wer schreibt (Signatur) und wer lesen kann
  (Raumschlüssel).

### API-Zugänge

- Ein Zugang ist ein Schlüsselpaar (ECDH P-256) und ein zufälliges Token.
  Beiträge verschlüsselt das Skript selbst: frischer ECDH-Schlüssel je
  Beitrag, HKDF-SHA-256, AES-256-GCM, an Raum und Zugang gebunden. Der
  private Schlüssel (zum Lesen) steht in den verschlüsselten Raumdaten, der
  Server kennt nur den SHA-256-Wert des Tokens.
- Absender ist „der Zugang“: Beiträge tragen keine Signatur einer Person.
  Wer das Token hat, postet; einen weiteren Nachweis gibt es nicht. Wer den
  öffentlichen Schlüssel kennt, kann Beiträge bauen, aber ohne Token nicht
  einstellen (außer der Server selbst).
- Den privaten Schlüssel haben alle Mitglieder, auch ehemalige, und alle
  mit einem gültigen Einladungslink (über `invite.info`, ohne Beitritt).
  Er wechselt nicht mit dem Raumschlüssel: keine Forward Secrecy, keine
  automatische Erneuerung. Nach dem Gehen eines Mitglieds weist die App
  darauf hin; „Zugänge erneuern“ legt neue Schlüssel und Tokens an und
  widerruft die alten. Ohne „Verlauf für Neue“ blendet die App Beiträge von
  vor dem eigenen Beitritt aus – nur die Ansicht, lesen könnte man sie.
- Der Server sieht: dass es Zugänge gibt und wie viele, wann sie angelegt
  und zuletzt benutzt wurden, je Beitrag Zeitpunkt, Größe (auf 16 KB
  aufgefüllt) und IP-Adresse, und den Zielkanal – nur bei Kanälen mit
  eigener Aufbewahrung.

### Forward Secrecy

- **Direktnachrichten:** Jede Woche hängt ein Gerät einen neuen
  X25519-Verschlüsselungs-Unterschlüssel an den eigenen PGP-Schlüssel;
  Absender nehmen immer den jüngsten (vor dem Senden frischt Clavichat den
  Schlüssel des Gegenübers auf, wenn er älter als sechs Stunden ist). Der
  Hauptschlüssel und damit der Fingerabdruck bleiben gleich.
- Alte Unterschlüssel werden gelöscht, sobald ihr Nachfolger länger da ist
  als die höchste Aufbewahrung plus zwei Tage – alles, was an sie ging, ist
  dann beim Server abgelaufen. Wer danach an den privaten Schlüssel kommt,
  kann zuvor mitgeschnittene Nachrichten damit nicht mehr öffnen.
- Konten: Der aktuelle Schlüssel liegt im verschlüsselten Tresor, damit alle
  Geräte ihn haben. Es wechselt immer nur ein Gerät (Sperre beim Server für
  zwei Minuten); die anderen übernehmen den neuen Stand – spätestens, wenn
  sie eine Nachricht an den neuen Unterschlüssel nicht öffnen können. Die
  gespeicherte Anmeldung auf dem Gerät wird gleich mit erneuert. Den beim
  Server eingepackten Schlüssel ersetzt Clavichat nur mit Passwort oder Code
  (beim Anmelden; Konten mit Code jederzeit) – eine gestohlene Sitzung allein
  kann ihn nicht überschreiben. Einen neuen öffentlichen Schlüssel nimmt der
  Server nur mit demselben Fingerabdruck an; ob er wirklich dazu passt,
  prüfen die anderen Geräte selbst.
- **Räume:** Jedes Mitglied löscht alte Schlüsselgenerationen, sobald ihre
  Nachfolgerin länger da ist als die längste Aufbewahrung im Raum (Raum
  oder ein Textkanal mit eigener) plus zwei Tage.
  Gelöscht bleibt gelöscht, auch auf den anderen Geräten (Tresor).
- **Anrufe** haben ohnehin eigene Schlüssel je Gespräch (DTLS-SRTP).

### Dateien und Bilder

- Jede Datei bekommt im Browser einen eigenen Zufallsschlüssel (AES-256-GCM)
  und wird in Stücken zu 512 KiB verschlüsselt. Der IV ist die Stücknummer
  (jeder Schlüssel verschlüsselt jede Nummer nur einmal), die zusätzlichen
  Daten binden Datei, Nummer und Anzahl der Stücke: Stücke lassen sich weder
  vertauschen noch weglassen noch aus einer anderen Datei einschmuggeln.
- Schlüssel, Name, Typ und bei Bildern eine kleine Vorschau stehen nur in der
  Ende-zu-Ende verschlüsselten Nachricht. Der Server bekommt Chiffretext und
  liefert ihn nur an Angemeldete aus.
- Bilder (JPEG, PNG, WebP) zeichnet der Browser vor dem Senden neu – EXIF und
  andere Metadaten wie der Aufnahmeort fallen weg. GIFs gehen unverändert raus.
- Eine Datei läuft mit ihrer Nachricht ab, verschwindet beim Löschen der
  Nachricht und mit der Identität, die sie hochgeladen hat. Höchstens 25 MB je
  Datei, 100 MB je Identität (einstellbar).
- Vor Programmen und Skripten (.exe, .bat, .ps1, .js …) warnt Clavichat beim
  Herunterladen. In Nachrichtenanfragen lassen sich Dateien erst nach dem
  Annehmen öffnen.

### Anrufe und Bildschirm

- WebRTC, Ton und Bild direkt zwischen den Geräten, verschlüsselt mit
  DTLS-SRTP. Die Schlüssel dafür handeln nur die beiden Geräte aus, sie gelten
  nur für dieses eine Gespräch.
- Die Verbindungsangaben (SDP) laufen als signierte und verschlüsselte Signale
  über den Server und verfallen nach zwei Minuten.
- Sicherheitscode: SHA-256 über die beiden DTLS-Fingerabdrücke, daraus sechs
  Ziffern. Sehen beide dieselbe Zahl, sitzt niemand dazwischen.
- Für Stereo-Ton ergänzt Clavichat vor dem Übernehmen der Verbindungsangaben
  des Gegenübers `stereo=1`. Der Sicherheitscode rechnet weiter mit den
  unveränderten, signierten Angaben.
- In einem Sprachkanal ist jeder mit jedem verbunden (bis 8 Personen), es gibt
  keinen Server, der Ton oder Bild mischt.
- Über einen Relay-Server (TURN) laufen dieselben DTLS-SRTP-Pakete; der
  Betreiber sieht IP-Adressen, Zeit und Datenmenge, aber keinen Inhalt.
- Blendet ein Zuschauer eine Bildschirmübertragung aus, meldet er das über
  den verschlüsselten Datenkanal; der Sender schickt ihm dann nichts mehr
  davon.

### Freunde und Status

- Die Freundschaftsanfrage ist eine Direktnachricht (OpenPGP, signiert) mit
  einem gemeinsamen Geheimnis aus 32 Zufallsbytes. Erst nach der Annahme
  tauschen beide ihren Status aus.
- Aus dem Geheimnis entstehen per HKDF-SHA-256 zwei Fächer beim Server (je
  Person eins, 256-Bit-Kennungen) und ein gemeinsamer AES-256-GCM-Schlüssel.
  Jeder legt seinen Status dort verschlüsselt und immer gleich lang ab;
  lesen kann ihn nur der Freund. „Als offline anzeigen“ leert die eigenen
  Fächer.
- Der Server kennt das Geheimnis nicht, weiß nicht, wem ein Fach gehört,
  und hebt nur den jüngsten Stand auf – nach 150 Sekunden ist er weg.
- Beenden oder Blockieren löscht die eigenen Fächer; ohne Geheimnis kann die
  andere Seite nichts mehr lesen.

### Aufbewahrung

- Jede Direktnachricht trägt beim Server ein Ablaufdatum, das die
  Unterhaltung festlegt (1 Stunde bis 30 Tage, Standard 7 Tage). Beide
  Seiten stimmen sich per verschlüsselter Nachricht ab.
- Wird die Dauer kürzer, löscht jede Seite ihre älteren Einträge beim Server
  (nur im eigenen Briefkasten – welche zu welcher Unterhaltung gehören, weiß
  nur der Browser). In Räumen setzt der Server die Dauer des Besitzers
  selbst durch.
- Der Besitzer kann einzelnen Textkanälen eine eigene Dauer geben. Dafür
  erfährt der Server, welche Einträge zu diesem Kanal gehören (eine
  zufällige Kanal-Kennung, nie Name oder Inhalt) – aber nur für solche
  Kanäle: Nachrichten anderer Kanäle gehen weiter ohne Kennung. Zurück auf
  „wie der Raum“ entfernt die Zuordnung wieder aus dem Verlauf.
- Der Besitzer eines Raums (oder ein Rang mit „Nachrichten verwalten“) kann
  einzelne Nachrichten und API-Beiträge beim Server löschen (`room.del`, nach
  Eintragsnummer). Wer etwas geschrieben hat, weiß der Server nicht –
  deshalb nur mit diesem Recht; andere löschen eigene Nachrichten
  verschlüsselt. Zurück bleibt ein Hinweis-Eintrag mit
  den Nummern, damit verbundene Apps sie sofort ausblenden. Dabei lernt der
  Server, welche Einträge zusammengehören (eine Nachricht samt Änderungen
  und Reaktionen) – ebenso beim Zuordnen zu einem Kanal mit eigener
  Aufbewahrung.
- Abgelaufenes wird nicht mehr ausgeliefert und stündlich aus den Dateien
  gelöscht.
- Räume, die eine temporäre Sitzung angelegt hat, löscht der Server nach
  7 Tagen ohne Aktivität (keine Nachricht, kein Beitritt, niemand im
  Sprachkanal, keine Änderung) samt Verlauf – auch wenn noch Konten darin
  sind. Dafür merkt er sich pro Raum den Zeitpunkt der letzten Aktivität
  (höchstens stündlich aktualisiert), nicht wer aktiv war.

### Konten

- Aus Name und Passwort entsteht im Browser mit PBKDF2-SHA-256 (600.000 Runden)
  ein Hauptschlüssel. Per HKDF-SHA-256 werden daraus zwei unabhängige Werte:
  - ein Anmeldeschlüssel, den der Server nur als bcrypt-Hash (Kosten 12)
    speichert,
  - ein AES-256-GCM-Schlüssel, der den privaten PGP-Schlüssel und den Tresor
    (Kontakte, Raumschlüssel, Sperrliste, Einstellungen, Lesestand) einpackt.
- Das Passwort selbst verlässt den Browser nie. Der Server kann den privaten
  Schlüssel nicht auspacken.
- Mindestens 10 Zeichen und eine geschätzte Stärke von „okay“ (rund 40 Bit):
  Die Schätzung erkennt häufige Passwörter und Wörter, Tastaturfolgen,
  Wiederholungen, Jahreszahlen und Leetspeak und nimmt zu schwache Passwörter
  nicht an. Wer die Daten des Servers stiehlt, kann offline Passwörter raten;
  jeder Versuch kostet 600.000 PBKDF2-Runden. Ein langes Passwort ist deshalb
  der beste Schutz.

### Geräte

- Jedes Gerät hat eine zufällige Kennung; der Server merkt sie sich zur
  Sitzung. In den Einstellungen stehen alle angemeldeten Geräte – ihre Namen
  (etwa „Firefox · Windows“) liegen beim Server nur verschlüsselt.
- Ein Gerät (oder alle anderen) lässt sich aus der Ferne abmelden. Es
  erfährt beim nächsten Abruf davon und kommt still – mit gespeichertem
  Wiederherstellungscode – nicht wieder hinein, nur mit Passwort oder Code.
- Meldet sich ein Gerät an, das das Konto noch nicht kennt, sagen die anderen
  Geräte Bescheid („Neue Anmeldung bei deinem Konto“).

### Konto mit dem Postfach (nur offizieller Server)

- Wer im Dashboard der Website angemeldet ist (echte Anmeldung am
  Postfach), bekommt dort ein Ticket: Postfach, Ablauf nach fünf Minuten und
  ein Zufallswert, signiert mit HMAC-SHA-256. Den Schlüssel dafür leitet der
  Server aus seinem geheimen Server-Schlüssel ab, er verlässt den Server nie.
  Jedes Ticket gilt nur einmal.
- Das Ticket holt die Seite mit dem Cookie der Dashboard-Sitzung, nur von der
  eigenen Seite aus (`Sec-Fetch-Site`). Das ist der einzige Aufruf mit Cookie;
  die Schnittstelle von Clavichat selbst bleibt ohne.
- Ein Postfach, ein Konto. Am Konto steht das Postfach nur als SHA-256-Hash.
- Statt eines Passworts schützt ein Wiederherstellungscode den Schlüssel:
  160 Zufallsbits aus `crypto.getRandomValues`, geschrieben in
  Crockford-Base32 (8 Gruppen à 4 Zeichen). Aus ihm entstehen per
  HKDF-SHA-256 (RFC 5869, Salz mit dem Kontonamen) dieselben zwei Werte wie
  aus einem Passwort: Anmeldeschlüssel und Einpackschlüssel. PBKDF2 braucht
  es dafür nicht – 160 Zufallsbits lassen sich nicht erraten. Der Server
  sieht weder den Code noch die Schlüssel.
- Das Postfach bestätigt nur, wer man ist. Wer das Postfach übernimmt, kann
  damit den Kontonamen erfragen, aber ohne Code oder angemeldetes Gerät
  weder anmelden noch den privaten Schlüssel auspacken.
- Ein neuer Code (Einstellungen) packt Schlüssel und Tresor neu ein, macht
  den alten Code ungültig und meldet alle anderen Geräte ab.

### Updates der Windows-App

- Die App lädt eine Update-Liste vom neuesten veröffentlichten GitHub-Release
  und vom offiziellen Server (clavichat.de) und nimmt die höchste Fassung mit
  gültiger Signatur. Die Listen sind mit Ed25519 signiert; die öffentlichen
  Schlüssel bringt die App mit (`desktop/updater.js`, `PUBLIC_KEYS`). Es gibt
  zwei: Den einen hat nur der Herausgeber (für clavichat.de), den anderen
  GitHub Actions als verschlüsseltes Secret (für die Releases). Keiner liegt im
  Repository oder auf dem Webserver.
- GitHub Actions signiert nur beim Bauen eines Versions-Tags und legt einen
  Entwurf an. Zum Update wird er erst, wenn der Herausgeber ihn veröffentlicht.
- Die Liste nennt Größe und SHA-256 jeder Datei. Passt eine heruntergeladene
  Datei nicht genau, wird sie verworfen. Ein übernommener Webserver oder ein
  fremdes Release-Asset kann so keine fremde Fassung unterschieben. Als Update
  gilt nur eine höhere Versionsnummer.
- Die Suche beim Start lässt sich abschalten. GitHub und der Server sehen
  dabei nur IP-Adresse und Zeitpunkt.

### Auf dem Gerät

- Temporäre Sitzung: Der private Schlüssel liegt nur im Speicher dieses Tabs
  (`sessionStorage`) und ist weg, wenn der Tab zu ist.
- Konto mit „Angemeldet bleiben“: in IndexedDB der eingepackte private
  Schlüssel und ein WebCrypto-Schlüsselobjekt, das sich nicht auslesen lässt.
  Ohne das Häkchen gilt die Anmeldung nur für den Tab.
- Konto mit Wiederherstellungscode: Dazu kommt der Anmeldeschlüssel,
  versiegelt mit eben diesem Schlüsselobjekt (AES-256-GCM, eigene
  Zusatzdaten). Läuft die Sitzung ab, meldet sich das Gerät damit still neu
  an. Neue Angriffsfläche entsteht so nicht: Wer an das Schlüsselobjekt
  kommt, packt damit ohnehin den privaten Schlüssel aus.
- **App-Sperre (PIN):** Aus der PIN entsteht mit PBKDF2-SHA-256 (600.000
  Runden, eigenes Salz je Gerät) ein AES-256-GCM-Schlüssel. Er versiegelt die
  gespeicherte Anmeldung (Sitzungs-Token, eingepackter Schlüssel, versiegelter
  Anmeldeschlüssel) – ohne PIN ist sie auf der Festplatte wertlos. Clavichat
  sperrt beim Start, nach Leerlauf, beim Sperren von Windows bzw. vor dem
  Ruhezustand und auf Knopfdruck; ab dem dritten Fehlversuch mit wachsender
  Pause, nach zehn wird die gespeicherte Anmeldung gelöscht. Gesperrt nennen
  Benachrichtigungen niemanden. Zu einfache PINs (1234, 0000, 1212 …) nimmt
  Clavichat nicht an.
- **Windows-App:** Die gespeicherte Anmeldung ist zusätzlich – auch ohne PIN –
  an das Windows-Konto gebunden (Electron `safeStorage`, also DPAPI). Eine
  Kopie des Profils lässt sich auf einem anderen Rechner oder unter einem
  anderen Windows-Konto nicht öffnen. Auf Wunsch sieht Windows das Fenster für
  Bildschirmfotos, Aufnahmen und Bildschirmübertragungen schwarz
  (`SetWindowDisplayAffinity`).

### Eigener Server (Windows, Docker)

- **Clavichat Server für Windows** erzeugt beim ersten Start ein eigenes
  Zertifikat (EC P-256, 800 Tage). Browser warnen beim ersten Aufruf; ob es
  das richtige ist, zeigt der Fingerabdruck im Fenster des Servers. Die
  Windows-App vertraut dem Zertifikat nur mit passendem Fingerabdruck in der
  `config.json` – ein anderes, selbst erstelltes Zertifikat lehnt sie ab.
- Der HTTPS-Teil lauscht auf dem eingestellten Port, PHP nur auf `127.0.0.1`.
  Programmteile, Einstellungen und Daten liefert der eingebaute PHP-Server über
  `router.php` nie aus; die Daten liegen ohnehin außerhalb des Programmordners.
- **Im Container** spricht Clavichat nur HTTP; HTTPS übernimmt der Proxy davor
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
  mit Uhrzeiten verknüpfen. Freunde sehen ihn über die verschlüsselten
  Fächer (siehe oben). In der Liste erscheinen nur temporäre Sitzungen,
  solange sie sichtbar sein wollen. Wer in einem Sprachkanal ist, sehen
  weiterhin die Mitglieder dieses Raums.
- Kennungen sind zufällig. Sitzungs-Token liegen beim Server nur als
  SHA-256-Hash, die Ratenbegrenzung arbeitet mit einem HMAC der IP-Adresse statt
  mit der Adresse selbst.
- Zugangsdaten eines Relay-Servers (TURN) gibt der Server nur angemeldeten
  Sitzungen heraus, nicht der öffentlichen Seite.
- Keine Cookies, keine Anfragen an fremde Server (Schriften liegen bei), strenge
  Content-Security-Policy ohne Inline-Skripte.
- Anruf-Signale verfallen nach zwei Minuten, Nachrichten nach der für die
  Unterhaltung gewählten Zeit (Standard 7 Tage, höchstens 30 Tage),
  temporäre Sitzungen nach 24 Stunden ohne Nutzung, Räume aus temporären
  Sitzungen nach 7 Tagen ohne Aktivität (alle drei Fristen lassen sich in
  `config.php` einstellen).

## Was der Server trotzdem sieht

- IP-Adressen und Zeitpunkte der Anfragen (der Webserver protokolliert sie).
- Wer gerade online ist (auch bei Konten – er zeigt es nur niemandem),
  welche öffentlichen Schlüssel, Namen und Profilbilder
  (nur Konten) es gibt, wer in welchem Raum ist und wer in welchem Sprachkanal
  (ohne dessen Namen).
- In Räumen mit Rängen: welche Rechte welcher Rang hat, wer welchen Rang hat
  und welche Kanäle (nur Kennung) auf welche Ränge beschränkt sind – nicht
  die Namen der Ränge oder Kanäle.
- Ob ein Raum nur Mitglieder mit Konto zulässt (`ao`), wer welche Einladung
  erstellt hat, wie lange sie gilt und wie oft sie benutzt wurde.
- Bei API-Zugängen: siehe API-Zugänge.
- Wer einen Einladungslink öffnet, zeigt dem Server seine IP-Adresse schon
  für die Vorschau – vor dem Beitritt.
- Welcher Briefkasten wann wie viele Einträge bekommt. Wer eine Nachricht
  abschickt, sieht er im Moment der Anfrage, speichert es aber nicht.
- Dass Status-Fächer beschrieben und gelesen werden – im Moment der Anfrage
  auch von wem, gespeichert wird das nicht. Den Status selbst und wem ein
  Fach gehört, kennt er nicht.
- Bei Konten mit dem Postfach (offizieller Server) den SHA-256-Hash des
  Postfachs. Wer die Adresse kennt, kann sie damit dem Konto zuordnen.
- Bei Dateien: Größe, Zeitpunkt, Ablauf und wer sie hochgeladen hat; wer
  sie abruft, im Moment der Anfrage (gespeichert wird das nicht).
- Bei Konten: wann welche Sitzung entstand und ungefähr zuletzt genutzt wurde
  (auf einen Tag genau) – die Gerätenamen nur verschlüsselt.
- Die Entstehungszeit der Unterschlüssel steht im öffentlichen Schlüssel.
  Daran lässt sich grob ablesen, wann ein Gerät der Identität aktiv war (auf
  eine Woche genau).
- Bei Anrufen ohne Relay sehen sich die Gesprächspartner gegenseitig die
  IP-Adresse, der STUN-Server sieht die eigene. Sie steht schon im
  Verbindungsangebot, das beim Klingeln ankommt – auch wenn niemand abnimmt.
  „IP-Adresse verbergen“ leitet alles über TURN, sofern einer eingerichtet
  ist: Im Angebot stehen dann nur Adressen des Relays. Bei temporären
  Sitzungen ist das von Haus aus an (je Gerät gemerkt), bei Konten eine
  Einstellung im Tresor. Ist kein Relay erreichbar, kommt der Anruf nicht
  zustande, statt die IP doch zu zeigen. Die Zugangsdaten des Relays holt die
  App alle sechs Stunden neu (sie gelten einen Tag).

## Grenzen

- **Web-Fassung:** Wie jede Web-App lädt Clavichat seinen Programmcode vom
  Server. Ein Betreiber, der gezielt veränderten Code ausliefert, könnte
  Schlüssel abgreifen. Die Windows-App bringt ihren Code selbst mit (Protokoll
  `app://securecom`, Content-Security-Policy nur für eigene Dateien). Der
  Server kann ihn nicht austauschen.
- **Forward Secrecy nur wochenweise:** Kein Double Ratchet wie bei Signal.
  Wer an einen privaten Schlüssel kommt, kann Nachrichten lesen, deren
  Unterschlüssel noch nicht gelöscht ist – also etwa die letzten fünf Wochen
  (Wechsel jede Woche, Löschen nach Aufbewahrung plus zwei Tage). Wechsel und
  Löschen passieren nur, wenn ein Gerät der Identität online ist. Bei Konten
  mit Passwort bleibt der beim Server eingepackte Schlüssel mit den alten
  Unterschlüsseln liegen, bis das nächste Mal jemand das Passwort eingibt.
  Selbst angelegte Sicherungen („Privaten Schlüssel sichern“) enthalten die
  Unterschlüssel vom Zeitpunkt der Sicherung.
- **Raumschlüssel:** Wer einen Raumschlüssel kennt, kann alle Nachrichten
  dieser Generation lesen. Nach dem Entfernen eines Mitglieds sind erst die
  folgenden Nachrichten vor ihm sicher. Solange Einladungslinks offen sind,
  wechselt der Schlüssel nicht von selbst.
- **App-Sperre:** Sie verdeckt die Oberfläche; während Clavichat läuft,
  liegen die Schlüssel im Speicher. Der Zähler für Fehlversuche liegt auf dem
  Gerät – gegen jemanden, der die Dateien kopiert, schützt die Stärke der PIN
  (und in der Windows-App DPAPI), nicht der Zähler.
- **Flutschutz:** Grenzen gegen Missbrauch durch Mitglieder schützen die
  Verfügbarkeit, nicht vollständig: Anruf-Signale höchstens 1,5 MB je
  Absender und 6 MB je Raum in zwei Minuten (nur mit Recht „Sprache“ und im
  Sprachkanal), Reaktionen ohne Schreibrecht höchstens 4 KB, in
  „Permanent“-Verläufen je Mitglied oder Zugang 2 MB je Stunde (ältere
  Nachrichten fallen dort sonst weg), API-Zugänge 20 Beiträge je Minute und
  300 je Stunde, dazu Grenzen je Adresse (Beitritte, Vorschau, temporäre
  Sitzungen). Ein Mitglied mit Schreibrecht kann einen Raum mit kürzerer
  Aufbewahrung trotzdem bis zur Obergrenze (16 MB) füllen.
- **Fingerabdrücke:** Die Sicherheit hängt daran, dass wichtige Kontakte über
  einen zweiten Weg geprüft werden. Ohne Prüfung schützt nur Trust on first use.
- **Gerät:** Gegen Schadsoftware oder Browser-Erweiterungen mit Zugriff auf die
  Seite hilft keine Verschlüsselung.
- **Prüfung:** Clavichat hat kein externes Sicherheitsaudit hinter sich.
