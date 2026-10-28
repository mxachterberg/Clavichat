# Änderungen

Was sich von Version zu Version ändert. Beim Veröffentlichen wird der
Abschnitt einer Version zum Text des GitHub-Releases
(`.github/workflows/windows.yml`).

## 1.9.3 – 28.10.2026

Sicherheits-Update nach einer Prüfung der neuen Funktionen. Für installierte
Apps ein kleines Update – bitte zügig aktualisieren.

- **Einladungen nur durch Besitzer und Admins:** Links und
  Direkt-Einladungen erstellen nur noch der Besitzer und Ränge mit
  Administrator. Offene Links anderer Mitglieder gelten nicht mehr. In
  Einmal-Meetings teilen Teilnehmer weiter Links, der Gastgeber bestätigt.
- **Ränge:** Wer Ränge verwaltet, kann sich keine Rechte mehr verschaffen,
  die er selbst nicht hat (z. B. Administrator).
- **„Neue Mitglieder sehen den Verlauf“ nur vom Besitzer:** Das
  Schlüsselarchiv trägt jetzt die Unterschrift des Besitzers; Ränge können
  es nicht mehr einschalten oder fälschen. Ausschalten wechselt den
  Raumschlüssel. Wer es unter 1.9.1/1.9.2 eingeschaltet hatte, schaltet es
  einmal neu ein.
- **Raumdaten:** werden nur noch von Mitgliedern angenommen; ältere,
  zurückgespielte Stände lehnt die App ab.
- **Schutz vor Fluten:** Signale nur im Sprachkanal, Grenzen je Mitglied für
  „Permanent“-Verläufe, kleine Reaktionen ohne Schreibrecht.
- **Moderation:** Kanal-Aufbewahrung kann fremde Nachrichten nicht mehr
  vorzeitig löschen; doppelte Nachrichten-Kennungen hebeln das Löschen nicht
  mehr aus.
- **API-Zugänge:** Falsche Tokens sperren einen echten Zugang nicht mehr;
  neuer Knopf „Zugänge erneuern“ und Hinweis, wenn jemand den Raum verlässt.
- **Releases:** Der Signierschlüssel für Updates läuft in GitHub Actions in
  einem eigenen, abgeschotteten Schritt.
- **SECURITY.md** beschreibt API-Zugänge, Archiv, Verwaltungsrechte und
  was der Server sieht ausführlicher.

## 1.9.2 – 27.10.2026

Einladungslinks länger gültig. Für installierte Apps ein kleines Update.

- **Gültigkeit wählbar:** Im Einladen-Dialog legst du fest, wie lange ein
  Link gilt – 1 Tag, 7 Tage (Standard), 30 oder 90 Tage. Der Hinweis nennt
  das Ablaufdatum. Solange Einladungslinks offen sind, wechselt der
  Raumschlüssel nicht wöchentlich.

## 1.9.1 – 27.10.2026

Einladungs-Vorschau, Verlauf für neue Mitglieder und neue Töne. Für
installierte Apps ein kleines Update.

- **Einladungs-Vorschau:** Wer einen Einladungslink öffnet, sieht „Du wirst
  eingeladen in …“ mit Raumbild, Name und Mitgliederzahl – auf der
  Startseite, im Beitreten-Dialog und bei Meetings. Name und Bild bleiben
  verschlüsselt; die App entschlüsselt sie mit dem Schlüssel aus dem Link.
- **Neue Mitglieder sehen den Verlauf:** Neuer Schalter im Raum-Menü. Ist er
  an, können Neue auch ältere Nachrichten lesen (soweit sie noch aufbewahrt
  werden); die älteren Raumschlüssel liegen dafür verschlüsselt in den
  Raumdaten. Gilt für alle Kanäle des Raums.
- **Neue Töne:** Anrufe klingeln wie ein klassisches Telefon, neue
  Nachrichten mit einem kurzen, warmen Zwei-Ton.
- **Reagieren** sitzt jetzt unten links an der Nachricht, neben den
  Reaktionen.
- **Eingeschränkte Kanäle** zeigen in der Seitenleiste immer ein Schloss
  (offen, wenn du schreiben darfst).

## 1.9.0 – 27.10.2026

Ränge und Rechte, Reaktionen, API-Zugänge zum Posten, Aufbewahrung je Kanal
und ein neues Raum-Menü. Für installierte Apps ein kleines Update.

- **Ränge und Rechte (wie bei Discord):** Raum-Menü → Ränge: Name, Farbe,
  Reihenfolge und Rechte – Nachrichten schreiben, reagieren, Sprachkanäle,
  einladen, Kanäle verwalten, Raum verwalten, Nachrichten verwalten,
  Mitglieder entfernen, API-Zugänge, Ränge verwalten, Administrator. Man
  vergibt nur Ränge unterhalb des eigenen. Die Mitgliederliste ist nach Rang
  gruppiert und farbig, Ränge vergibt man per Rechtsklick auf ein Mitglied.
  Rangnamen und Farben sind verschlüsselt; der Server kennt nur zufällige
  Kennungen und Rechte. Raumschlüssel, „Nur Konten“, Permanent und Löschen
  des Raums bleiben beim Besitzer.
- **Wer darf wo schreiben:** Rechtsklick auf einen Kanal → Berechtigungen,
  z. B. „nur Moderatoren schreiben“. Lesen können weiter alle Mitglieder.
  Server und Apps setzen das durch.
- **Reaktionen:** zwölf eigene Symbole, per Rechtsklick oder Knopf an der
  Nachricht; Ende-zu-Ende verschlüsselt.
- **API-Zugänge – nur posten, nie lesen:** Der Besitzer legt für einen
  Textkanal einen Zugang an und bekommt ihn einmalig angezeigt. Skripte
  posten damit verschlüsselt (`node tools/clavichat-post.mjs`), lesen
  können sie nichts. Beiträge tragen das Zeichen API, Anleitung im Dialog.
- **Aufbewahrung:** neu „Permanent“ und eigene Aufbewahrung je Textkanal.
- **Nachrichten löschen:** Besitzer (bzw. „Nachrichten verwalten“) löschen
  per Rechtsklick jede Nachricht für alle.
- **Kanäle verschieben:** per Drag & Drop oder „Nach oben/unten“.
- **Raum-Menü neu** mit Raum-Karte und Gruppen; **24 Raum-Symbole** in
  8 Farben; **MEET** mit Gruppen-Symbol und Rückfrage.
- **Kleinigkeiten:** Kanalnamen behalten Groß- und Kleinschreibung;
  Raumbilder in der Leiste werden nicht mehr gestaucht.

## 1.8.8 – 27.10.2026

Kleinigkeit. Für installierte Apps ein kleines Update.

- **Kopfzeile:** Vor „Clavichat“ steht kein Logo mehr – es bleibt oben links.

## 1.8.7 – 27.10.2026

Das Logo kommt jetzt auch in der Windows-Taskleiste an. Für installierte
Apps ein kleines Update.

- **Taskleiste:** Windows zeigte dort das Symbol der Programmdatei bzw. der
  Startmenü-Verknüpfung – nach kleinen Updates noch das alte Logo, und eine
  Logo-Wahl kam nie an. Jetzt legt die App ihr Symbol als eigene Datei ab und
  stellt Taskleiste sowie ihre Verknüpfungen (Startmenü, Desktop,
  angeheftet) darauf um.
- **Monogramm:** Das Logo „Monogramm“ ist jetzt ein C, das unten rechts in
  einen Schlüssel ausläuft.

## 1.8.6 – 27.10.2026

Neues Logo. Für installierte Apps ein kleines Update – das neue Symbol der
Programmdatei und Verknüpfungen kommt mit dem nächsten vollständigen Update
oder einer Neuinstallation.

- **Neues Logo:** ein flaches, dunkles Funkgerät mit Schlüssel als Antenne –
  ruhiger als das alte mit hellen Umrissen. Oben links füllt es den Knopf
  jetzt besser aus.
- **Logo wählen:** Einstellungen → LOGO bietet Funkgerät, Kachel,
  Sprechblase, Monogramm und das klassische Logo. Die Wahl gilt je Gerät
  oben links, im Browser-Tab und in der Windows-App auch für Fenster,
  Taskleiste und Infobereich.

## 1.8.5 – 27.10.2026

Kleine Verbesserung der Raumansicht. Für installierte Apps ein kleines Update.

- **Raumname oben links:** Der Name steht in voller Breite; die Merkmale
  NUR KONTEN und TEMP stehen klein mit Symbol darunter, statt den Namen als
  Kasten daneben abzuschneiden.

## 1.8.4 – 27.10.2026

Räume nur für Mitglieder mit Konto. Für installierte Apps ein kleines Update.

- **Nur Mitglieder mit Konto:** Beim Erstellen eines Raums (als Konto) lässt
  sich festlegen, dass nur Mitglieder mit Konto beitreten; der Besitzer
  schaltet das später im Raum-Menü um. Der Raum zeigt dann NUR KONTEN.
- **Einladungslink führt zur Kontoerstellung:** Wer einen Link zu so einem
  Raum ohne Sitzung öffnet, landet direkt bei „Konto erstellen“ (oder
  Anmelden) statt bei der temporären Sitzung und tritt danach bei. In einer
  temporären Sitzung erklärt ein Dialog, warum es nicht geht, und führt zur
  Kontoerstellung – die Einladung bleibt erhalten. Der Server lehnt
  temporäre Sitzungen und Gäste in solchen Räumen ab; wer schon drin ist,
  bleibt.

## 1.8.3 – 22.10.2026

Updates künftig über GitHub. Für installierte Apps ein kleines Update.

- **Updates über GitHub:** Die Windows-App holt neue Fassungen vom neuesten
  veröffentlichten GitHub-Release; clavichat.de bleibt als Ersatz. Die
  Update-Liste signiert GitHub Actions beim Release mit einem eigenen
  Schlüssel, den die App zusätzlich kennt.

## 1.8.2 – 16.10.2026

Mehr Leute ins Meeting holen und die Kamera wechseln. Für installierte Apps
ein kleines Update.

- **Gäste laden ein:** Auch Gäste können den Meeting-Link teilen. Wer über
  den Link eines Gastes kommt, wartet kurz – der Gastgeber bekommt ein
  Fenster „… möchte dem Meeting beitreten“ mit Zulassen und Ablehnen (dazu
  die Liste WARTET in der Meeting-Karte). Ohne Antwort verfällt die Anfrage
  nach zehn Minuten. Der Link des Gastgebers führt weiter direkt hinein.
- **Kamera wechseln:** Im Call neben dem Kamera-Knopf – auf Handys zwischen
  Front- und Rückkamera, am PC durch alle Kameras. Ohne Unterbrechung; die
  Wahl merkt sich das Gerät (auch unter Einstellungen → ANRUFE → Kamera).

## 1.8.1 – 16.10.2026

Meetings vereinfacht. Für installierte Apps ein kleines Update.

- **Nur noch eine Art Meeting:** Der MEET-Knopf erstellt sofort ein Meeting
  und zeigt den Link – ohne Auswahl. Gäste brauchen nur einen Namen.
  Bestehende feste Meetings funktionieren weiter.
- **Meeting erstellen auf der Startseite:** Unter „Temporäre Sitzung
  starten“ eröffnet man mit einem Namen direkt ein Meeting. Der Gastgeber
  sieht wie die Gäste nur das Meeting; verlässt oder beendet er es, endet
  seine Sitzung.

## 1.8.0 – 16.10.2026

Zwei Arten von Meetings. Für installierte Apps ein kleines Update.

- **Schnelles Meeting (einmalig):** Wer den Link öffnet und nicht angemeldet
  ist, gibt nur einen Namen ein und ist im Meeting – als Gast, der nur dieses
  Meeting sieht: Chat, Call und Teilnehmer, sonst nichts. Der Server setzt die
  Grenzen selbst durch. Das Meeting endet, wenn der Besitzer es beendet oder
  es 12 Stunden ruht; verlässt ein Gast es, endet seine Sitzung. Für
  temporäre Sitzungen die Standardwahl.
- **Festes Meeting:** wie bisher – Teilnehmer kommen mit Konto oder
  temporärer Sitzung; mit einem Konto erstellt, bleibt es bestehen.
- **Meeting starten:** Der MEET-Knopf fragt jetzt, welche Art.
- Verlässt jemand ein Meeting, bleiben geteilte Links gültig.

## 1.7.1 – 16.10.2026

Meetings im eigenen Design und clavichat.de als Zuhause. Für installierte
Apps das erste kleine Update (rund 1 MB).

- **Meetings im eigenen Design:** Knopf „MEET“ links in der Raumleiste,
  Meetings stehen getrennt von den Räumen. Statt Kanälen gibt es eine
  Meeting-Karte mit Teilnehmern (wer im Call ist), über dem Chat eine Lobby
  („Noch kein Call“ / „Call läuft“) mit großem Knopf; im Call wird die
  Kachelansicht größer.
- **clavichat.de als Zuhause:** Die Windows-App spricht mit clavichat.de,
  Einladungs- und Meeting-Links zeigen immer auf https://clavichat.de/, und
  auch die Updates kommen von dort. Die Anmeldung mit dem Postfach gibt es nur
  noch auf achterberg.dev.
- **Beim Schließen in den Infobereich:** Neue Einstellung unter FENSTER –
  das X versteckt das Fenster, Clavichat läuft weiter (Nachrichten und
  Anrufe kommen an). Zurück per Klick auf das Symbol, beenden per Rechtsklick.

## 1.7.0 – 16.10.2026

Meetings, kleinere Updates und mehr Durchblick. Die Windows-App 1.6.7 holt
sich diese Version von selbst.

- **Meetings:** Der neue Knopf oben rechts legt einen Meeting-Raum an und
  zeigt einen Link. Wer ihn öffnet, ist mit einem Klick im Meeting – auch
  ohne Konto, mit einer temporären Sitzung. Im Raum könnt ihr schreiben;
  einen Call startet, wer will, oben mit dem Hörer: Ton, Kamera und
  Bildschirm wie bei einem Anruf, bis zu 8 Personen. Ruhende Meetings löscht
  der Server nach einer Woche.
- **Kleine Updates:** Die installierte App lädt künftig nur noch das
  Programmpaket (rund 1 MB statt über 100 MB), solange sich die eingebaute
  Browser-Engine nicht ändert. Signiert und geprüft wie bisher. Die portable
  Fassung bekommt weiter das volle Update.
- **So funktioniert Clavichat:** Neuer Umschalter „Dieser Server | Selbst
  betrieben“ – zeigt, wie es mit eigenem Server und eigenem Relay aussieht,
  und wer dann was sieht.
- **Titelleiste:** Ganz oben links steht nur noch „CLAVICHAT“.
- **Sicherheit:** Electron 44.7.0 mit aktuellen Chromium-Korrekturen.

## 1.6.7 – 16.10.2026

Aufgeräumte Titelleiste. Die Windows-App 1.6.6 holt sich diese Version von
selbst.

- **Titelleiste:** Ganz oben links steht nur noch „CLAVICHAT“ – das Logo
  sitzt direkt darunter im Knopf der Raumleiste, doppelt war es zu viel.

## 1.6.6 – 16.10.2026

Das Logo, wie es bleiben soll. Die Windows-App 1.6.5 holt sich diese
Version von selbst.

- **Logo ohne Kachel:** Das App-Symbol in Taskleiste und Infobereich ist
  jetzt durchsichtig – nur noch das Funkgerät, innen dunkel, die hellen
  Linien mit schmalem dunklem Rand. So ist es auf heller wie dunkler
  Taskleiste gut zu erkennen und füllt die Fläche fast ganz aus.
- **Überall dasselbe Logo:** im Favicon (größer als bisher), oben links in
  der Titelleiste, im Kopf der App und im Knopf oben links in der
  Raumleiste (dort stand noch das alte Funkgerät).

## 1.6.5 – 16.10.2026

Besser erkennbares App-Symbol. Die Windows-App 1.6.4 holt sich diese
Version von selbst.

- **App-Symbol in der Taskleiste:** Das Funkgerät füllt die Kachel jetzt
  weiter aus und hat in kleinen Größen kräftigere Linien. Im Infobereich
  (16 px) entfällt das Lautsprechergitter – Antenne mit Schlüsselbart,
  Gehäuse und Lämpchen bleiben klar erkennbar.

## 1.6.4 – 16.10.2026

Neues Logo und mehr Transparenz. Die Windows-App 1.6.3 holt sich diese
Version von selbst.

- **Neues Logo:** Das Funkgerät trägt jetzt einen Schlüssel als Antenne –
  Clavichat kommt von lateinisch *clavis*, Schlüssel. Neu im App-Symbol,
  in der Taskleiste, im Infobereich, im Favicon und oben links in der App.
- **Open Source:** „So funktioniert Clavichat“ (das i oben) endet jetzt mit
  einem Link zum Quellcode auf GitHub und „Ein Projekt von Max Achterberg“.
  Links öffnen im normalen Browser.
- **Was ist neu?** Nach einem Update zeigt die Windows-App einmal, was sich
  zur Vorgängerversion geändert hat – mit Link zu den Code-Änderungen auf
  GitHub. Auch das Update-Fenster verlinkt sie vor dem Installieren.
- **clavichat.de:** Auf der eigenen Domain gibt es oben einen Knopf für Hell
  und Dunkel.
- Anleitung: Den Server zu Hause ins Internet zu stellen, wird nicht mehr
  empfohlen – alle Nutzer sähen sonst die IP-Adresse des Anschlusses. Im
  Heimnetz bleibt es unproblematisch.

## 1.6.3 – 03.10.2026

Feinschliff an der Oberfläche. Die Windows-App 1.6.2 holt sich diese
Version von selbst.

- **Scrollleisten im Stil der Seite:** In den Einstellungen und allen anderen
  Scrollbereichen (Dialoge, Auswahllisten, Verlauf, Seitenleiste,
  Mitgliederliste) eine haarfeine Spur mit schmalem, eckigem Griff – beim
  Darüberfahren und Ziehen orange. Hell und dunkel.
- **Eigener Name unten links:** Die Seitenleiste ist etwas breiter, die
  Knöpfe daneben schmaler – der Name hat jetzt Platz für mindestens 12
  Zeichen, auch mit dem Schloss der App-Sperre (vorher teils nur 4).
- Behoben: In den Einstellungen stand in der Zeile „Relay-Server (TURN)“
  kurz „null“, solange die Verbindung geprüft wurde.
- Repository: `scripts/upload-update.ps1` lädt ein Update hoch (Programme
  zuerst, Update-Liste zuletzt) und löscht ältere Fassungen auf dem Server.

## 1.6.2 – 03.10.2026

Mehr Sicherheit in vielen Ecken: Forward Secrecy, verschlüsselte Dateien und
Bilder, App-Sperre mit PIN, Geräte verwalten und Nachrichtenanfragen. Die
Windows-App 1.6.1 holt sich diese Version von selbst.

- **Forward Secrecy:** Der Schlüssel für Nachrichten an dich wechselt jede
  Woche; alte werden gelöscht, sobald alles damit Verschlüsselte beim Server
  abgelaufen ist. Wer später an deinen privaten Schlüssel kommt, kann
  mitgeschnittene ältere Nachrichten damit nicht mehr öffnen. In Räumen
  wechselt der Besitzer den Raumschlüssel wöchentlich (nicht, solange
  Einladungslinks offen sind); alte Generationen löscht jedes Mitglied nach
  der Aufbewahrung des Raums.
- **Dateien und Bilder:** über die Büroklammer, per Hereinziehen oder
  Einfügen (mit Rückfrage). Ende-zu-Ende verschlüsselt mit eigenem Schlüssel
  je Datei, bis 25 MB, sie verschwinden mit ihrer Nachricht. Bilder gehen ohne
  Metadaten raus (etwa ohne den Aufnahmeort), mit Vorschau und Großansicht.
  Vor Programmen (.exe, .bat …) warnt Clavichat.
- **App-Sperre mit PIN:** sperrt beim Start, nach Leerlauf (1 Minute bis
  1 Stunde), beim Sperren von Windows und mit Strg+L oder dem Schloss unten
  links. Die gespeicherte Anmeldung liegt dann nur mit der PIN verschlüsselt
  auf dem Gerät; zehn falsche PINs löschen sie. Gesperrt nennen
  Benachrichtigungen keine Namen.
- **Windows-App:** Die gespeicherte Anmeldung ist jetzt an dein Windows-Konto
  gebunden (DPAPI) – eine Kopie des Profils lässt sich anderswo nicht öffnen.
  Neu ist auch der Schutz vor Bildschirmfotos (Einstellungen → Anzeige).
- **Geräte verwalten:** Einstellungen → Geräte zeigt, wo dein Konto
  angemeldet ist; einzelne Geräte oder alle anderen lassen sich aus der Ferne
  abmelden – sie kommen nur mit Passwort oder Code wieder hinein. Meldet sich
  ein neues Gerät an, sagen die anderen Bescheid.
- **Nachrichtenanfragen:** Wer dir zum ersten Mal schreibt, landet unter
  „Nachrichtenanfragen“ – ohne Ton, Links nur als Text, Einladungen und
  Dateien gesperrt. Anrufe von Unbekannten klingeln bei Konten nicht
  (einstellbar). Annehmen, Ablehnen oder Blockieren; Antworten nimmt an.
- **Passwörter:** Eine Anzeige schätzt die Stärke; zu schwache und häufige
  Passwörter nimmt Clavichat nicht mehr an.
- Repository: Dependabot und eine wöchentliche Prüfung melden neue
  Versionen von Electron, OpenPGP.js und PHP.
- Server: neue Einstellungen `securecom_file_max_mb`,
  `securecom_file_quota_mb` und `securecom_files_total_mb` (Docker:
  `SECURECOM_FILE_MAX_MB` …), neue Aktionen für Geräte, Dateien und den
  Schlüsselwechsel. Ältere Apps zeigen statt einer Datei „📎 Name (Größe)“.

## 1.6.1 – 03.10.2026

Erklärt, wie Clavichat funktioniert: zwei neue Grafiken. Die Windows-App
1.6.0 holt sich diese Version von selbst.

- **So funktioniert’s:** Das Erklärfenster (Info-Symbol oben, Knopf auf der
  Startseite) zeigt jetzt zwei Grafiken im Stil der Seite. „So läuft ein
  Anruf“ – mit Schalter, was mit und ohne „IP verbergen“ im Angebot steht
  und was das Gegenüber sieht. „Wo verschlüsselt wird“ – je für
  Direktnachricht, Raum, Anruf, Status und Tresor: was auf dem Gerät
  passiert, was der Server sieht und wo entschlüsselt wird.
- README und SECURITY.md haben dieselben Grafiken (hell und dunkel, erzeugt
  mit `node docs/diagramme.mjs`).

## 1.6.0 – 03.10.2026

Mehr Schutz für die eigene IP-Adresse bei Anrufen und Aufräumen bei Räumen
aus temporären Sitzungen. Die Windows-App 1.5.0 holt sich diese Version von
selbst.

- **IP-Adresse verbergen** ist bei temporären Sitzungen jetzt von Haus aus
  an und wird je Gerät gemerkt. Ohne den Schalter stand die eigene IP schon
  beim Klingeln im Verbindungsangebot – auch wenn das Gegenüber nie abnahm.
  Mit ihm stehen dort nur Adressen des Relays. Ist kein Relay erreichbar,
  kommt der Anruf nicht zustande, statt die IP doch preiszugeben.
- **Räume aus temporären Sitzungen** löscht der Server nach 7 Tagen ohne
  Aktivität samt Verlauf – auch wenn noch Konten drin sind. Aktivität:
  Nachricht, Beitritt, Sprachkanal, Einladung oder Änderung am Raum. Solche
  Räume tragen ein TEMP-Zeichen; das Raum-Menü nennt das Datum, und beim
  Erstellen als temporäre Sitzung steht ein Hinweis. Einstellbar mit
  `securecom_temp_room_days` (Docker: `SECURECOM_TEMP_ROOM_DAYS`).
- Behoben: Die Zugangsdaten des Relays gelten einen Tag, die App holte sie
  aber nur beim Start. Lief die Windows-App länger, scheiterten Anrufe über
  das Relay. Jetzt holt sie sie alle sechs Stunden neu.
- Server: Reste ohne Bezug (Verläufe ohne Raum, Briefkästen ohne
  Identität) räumt das stündliche Aufräumen mit weg.

## 1.5.0 – 02.10.2026

Freunde mit Status, Aufbewahrung pro Unterhaltung und mehr Kontrolle beim
Bildschirmteilen. Die Windows-App 1.4.0 holt sich diese Version von selbst.

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
- **Konto mit dem Postfach** (nur auf dem offiziellen Server):
  Wer dort angemeldet ist, legt ein Konto ohne Passwort an. Das Postfach
  bestätigt ein signiertes Ticket (fünf Minuten, nur einmal), den Schlüssel
  schützt ein Wiederherstellungscode mit 160 Zufallsbits. Das Gerät bleibt
  angemeldet und meldet sich nach Ablauf der Sitzung still neu an. Auf einem
  neuen Gerät findet die Anmeldung über das Postfach den Kontonamen, dazu kommt
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
