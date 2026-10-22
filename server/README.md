# Verwaltung maCura Mobil — eigenständige Anwendung

Verwaltet Anmeldedaten, Rechte, Akten und Dateien vollständig selbst.
**Keine Cloud, kein Verzeichnisdienst, keine Abfrage bei einer anderen Stelle.**
Alles liegt im Ordner `daten/`.

```
Browser ──Anmeldename+Passwort──> dieser Server ──> daten/verwaltung.db
                                        │                daten/dateien/
                                  prüft Passwort,
                                  Rolle und Rechte
```

## Voraussetzung

Node.js **ab Version 22.5** — SQLite ist dort eingebaut, es muss nichts
kompiliert werden. Sonst nichts: kein Datenbankserver, kein Webserver davor,
kein Konto bei irgendeinem Anbieter. Einzige Fremdbibliothek ist `nodemailer`
für den E-Mail-Versand.

Prüfen: `node --version`. Auf diesem Rechner ist 24.19.0 bereits installiert
(über `winget install OpenJS.NodeJS.LTS`).

## Betriebsart

Eingestellt in `konfiguration.js`:

| `anmeldung` | Bedeutung |
|---|---|
| `"keine"` | **Einzelplatz** (derzeit eingestellt). Ohne Anmeldung, sofort einsatzbereit. Nur auf diesem Rechner erreichbar. |
| `"passwort"` | **Mehrbenutzerbetrieb.** Anmeldename und Passwort je Benutzer. Nötig, sobald mehrere Personen damit arbeiten oder die Anwendung ins Netz soll. |

### Einzelplatz (`"keine"`)

```bash
cd server
npm install
npm start
```

Fertig — `http://localhost:8082` öffnen, die Anwendung startet direkt in die
Firma. Beim ersten Start werden Firma und Zugang selbst angelegt.

**Was das bedeutet:** Wer an diesem Laptop arbeitet, sieht alle Akten. Der
Schutz sind die Windows-Anmeldung und die Festplattenverschlüsselung — die
Anwendung selbst fragt nichts mehr ab. Für einen Einzelplatz ist das
vertretbar, so wie eine Datei auf der Festplatte auch niemanden zusätzlich
fragt.

Zwei Sicherungen bleiben trotzdem eingebaut:

- **Herkunftsprüfung.** Ein Dienst auf `localhost` ist grundsätzlich von jeder
  Webseite ansprechbar, die Sie im Browser öffnen. Ohne Anmeldung fehlte sonst
  jede Hürde — eine beliebige Seite könnte im Hintergrund Daten anlegen oder
  ändern. Anfragen fremder Herkunft werden abgewiesen.
- **Kein Netzbetrieb.** Der Server verweigert den Start, wenn ohne Anmeldung
  mit `OFFEN=1` ins Netz geöffnet werden soll.

### Mehrbenutzerbetrieb (`"passwort"`)

In `konfiguration.js` auf `"passwort"` umstellen, dann:

```bash
npm run erstadmin      # legt erste Firma + ersten Administrator an
npm start
```

`npm run erstadmin` läuft bewusst nur auf der Kommandozeile: Wer an diesem
Rechner sitzt, kommt ohnehin an die Datenbankdatei. Über das Netz gibt es
keinen Weg, sich selbst zum Administrator zu machen.

Ein bereits im Einzelplatzbetrieb angelegter Bestand bleibt erhalten; der
Zugang `einzelplatz` bekommt dann über *Benutzer → Passwort* ein richtiges
Passwort.

## Betrieb im Netz

Standardmäßig ist der Server **nur auf dem eigenen Rechner** erreichbar. Das ist
Absicht — es soll eine bewusste Entscheidung sein, ihn zu öffnen.

| Umgebung | Bedeutung |
|---|---|
| `PORT` | Port, Standard 8082 |
| `OFFEN=1` | im gesamten Netz erreichbar statt nur lokal |
| `TLS=1` | sagt dem Server, dass ein HTTPS-Proxy davorsteht (setzt das `Secure`-Merkmal am Sitzungscookie) |

```bash
# Beispiel: im Hausnetz erreichbar, hinter einem HTTPS-Proxy
OFFEN=1 TLS=1 PORT=8082 npm start
```

**Ohne HTTPS keine Öffnung ins Netz.** Passwörter gingen sonst unverschlüsselt
über die Leitung und ließen sich im selben Netz mitlesen. Der Server warnt beim
Start, wenn `OFFEN=1` ohne `TLS=1` gesetzt ist. Für HTTPS genügt ein
Reverse-Proxy (Caddy, nginx, IIS) auf demselben Rechner.

Soll die Anwendung auch von unterwegs erreichbar sein, gehört sie hinter ein
VPN oder zumindest hinter einen Proxy mit gültigem Zertifikat — nicht
ungeschützt ins Internet.

## Was mit Passwörtern geschieht

- Gespeichert wird **nie das Passwort**, sondern ein scrypt-Abdruck mit eigenem
  Zufallssalz je Benutzer. Aus dem Abdruck lässt sich das Passwort nicht
  zurückrechnen; auch ein Administrator kann es nicht anzeigen.
- Vergleiche laufen zeitkonstant, damit sich der Abdruck nicht über die
  Antwortdauer erraten lässt.
- Falsche Eingaben sperren ab dem fünften Versuch zunehmend länger, bis
  30 Minuten. Ohne diese Bremse ließe sich ein schwaches Passwort in Minuten
  durchprobieren.
- Neue Benutzer bekommen ein Startpasswort und müssen beim ersten Anmelden ein
  eigenes vergeben. Bis dahin lässt der Server nichts anderes zu.
- Beim Ändern oder Zurücksetzen werden alle offenen Sitzungen des Benutzers
  beendet — wichtig, wenn ein Passwort in fremde Hände geraten ist.
- Die Sitzungskennung liegt in einem `httpOnly`-Cookie: Skripte im Browser
  kommen nicht daran.

## Rollen

| Rolle | Zugriff |
|---|---|
| `Administrator` | alles, inklusive Benutzer, Rechte, Firmen, Erscheinungsbild |
| `Geschaeftsfuehrung` | liest alles einschließlich Buchhaltung, ändert nichts |
| `Verwaltung` | Personen, Organisationen, Dokumente lesen und ändern; Buchhaltung führen |
| `Einsatzleitung` | Personen, Kategorien, freigegebene Dokumente lesen |
| `Mitarbeiter` | eigene Akte und ausdrücklich freigegebene Kategorien |
| `Extern` | ausschließlich freigegebene Kategorien |

Zusätzlich wird je Kategorie freigegeben. Ein Recht auf „Vertragsunterlagen"
gilt automatisch für „Arbeitsvertrag" darunter. Weil ausschließlich dieser
Server an die Daten kommt, ist diese Prüfung die tatsächliche Sperre — es gibt
keinen zweiten Weg an die Dateien.

## Mehrere Firmen

Jede Firma ist eine eigene Einheit in derselben Installation: gleiche Struktur,
getrennte Daten, eigene Benutzer, eigene Rechte, eigenes Erscheinungsbild. Nur
Administratoren können zwischen Firmen wechseln.

Anlegen über *Firmen → Firma anlegen* oder ein weiteres `npm run erstadmin`.
Umbenennen über *Firmen → Umbenennen*; der Name ändert nur die Beschriftung,
die Daten hängen an der Firma selbst.

### Eine Marke ist keine Firma — eine Gesellschaft schon

Der Unterschied entscheidet, ob etwas eine eigene Firma wird:

- Arbeitet ein Betrieb unter einer **Marke** oder als **Franchisenehmer**, ist
  das eine Firma. Die Marke gehört in den Briefkopf, nicht in die
  Firmenauswahl — es gibt eine Buchführung, einen Jahresabschluss, eine
  Steuernummer.
- Kommt eine **weitere Gesellschaft** dazu, ist das eine zweite Firma. Zwei
  Gesellschaften sind zwei Buchführungen, zwei Jahresabschlüsse und zwei
  Mandantennummern bei der Kanzlei. Sie als Kostenstelle in die erste zu
  hängen, wäre falsch und ließe sich später nicht mehr auseinandersortieren.

### Was in der Buchhaltung getrennt läuft

Eigener Kontenrahmen, eigene Debitoren und Kreditoren, eigener Journal-,
Rechnungs- und Mahnnummernkreis, eigene Berater- und Mandantennummer, eigene
umsatzsteuerliche Stellung, eigene Bankkonten und Kontoauszüge, eigene offene
Posten, eigene Übergabepakete. Beide Firmen dürfen dieselben Kontonummern,
dieselben Belegnummern und denselben Kunden führen, ohne sich zu berühren; ein
Zugriff über die Firmengrenze wird abgewiesen.

Gemeinsam ist nur, was ohnehin für alle gilt: der Basiszinssatz nach § 247 BGB.

Geprüft ist das nicht nur behauptet — die Selbstprüfung legt zwei Gesellschaften
nebeneinander an, gibt beiden dieselben Konto- und Belegnummern und denselben
Kunden und weist nach, dass nichts durchschlägt.

## Sicherung

```bash
npm run sicherung                    # Standardziel
npm run sicherung -- E:\Sicherungen  # anderer Ort, z. B. externe Platte
```

Das läuft **bei laufendem Server**. Die Datenbank wird nicht einfach kopiert:
Bei laufendem Betrieb stehen Änderungen zum Teil noch in einer Begleitdatei
daneben, eine bloße Kopie wäre unvollständig. Stattdessen wird eine in sich
stimmige Momentaufnahme erzeugt.

Jeder Lauf legt einen eigenen Ordner mit Datum an und enthält:

| | |
|---|---|
| `verwaltung.db` | alle Datensätze |
| `dateien/` | die hochgeladenen Dokumente, jede Version einzeln |
| `schluessel.bin` | falls vorhanden — sonst ließe sich das Postfach-Passwort nach einer Wiederherstellung nicht mehr entschlüsseln |
| `LIESMICH.txt` | Stand und Anleitung zum Wiederherstellen |

Nach dem Schreiben wird die Sicherung geöffnet und gegengezählt; die Zahlen
stehen in der Ausgabe. Das Werkzeug warnt außerdem, wenn das Ziel auf demselben
Laufwerk liegt oder innerhalb von OneDrive.

**Standardziel** ist `Verwaltung-Sicherungen` im Benutzerordner. Sobald eine
externe Festplatte fest dafür vorgesehen ist, deren Pfad in
`konfiguration.js` unter `sicherungsziel` eintragen.

### Wiederherstellen

1. Anwendung beenden.
2. `server/daten` umbenennen — nicht löschen, falls doch noch etwas gebraucht wird.
3. `server/daten` neu anlegen, Inhalt der Sicherung hineinkopieren.
4. Starten und stichprobenartig prüfen.

Geprüft: Eine Sicherung wurde in einen leeren Ordner zurückgespielt, die
Anwendung daraus gestartet, Akte und Dateiinhalt waren vollständig lesbar
(`integrity_check: ok`, keine Fremdschlüsselverletzungen).

**Eine Sicherung, die nie zurückgespielt wurde, ist keine Sicherung.** Den
Ablauf gelegentlich selbst durchspielen — nicht erst, wenn es darauf ankommt.

Sicherungen enthalten Personal- und Kundendaten. Datenträger möglichst
verschlüsseln und alte Stände vernichten statt nur zu löschen.

## E-Mail-Versand

Fester Bestandteil: Bei jedem Dokument steht *E-Mail* zur Verfügung — Empfänger,
Betreff und Text eingeben, das Dokument geht als Anhang mit, der Versand landet
in der Historie.

Einzurichten unter *Einstellungen → Postfach für den Versand* (nur
Administratoren). Die Angaben gelten **je Firma**, damit jeder Standort unter
eigener Adresse versendet. Benötigt werden Server, Port, Anmeldename, Passwort
und Absenderadresse des Postfachs — also ein gewöhnliches Postfach bei Ihrem
Anbieter, kein besonderer Dienst.

*Verbindung prüfen* meldet ohne Versand zurück, ob Anmeldung und Verschlüsselung
funktionieren.

**Zum Postfach-Passwort:** Es lässt sich nicht wie ein Anmeldepasswort als
Prüfsumme ablegen, weil es zum Versenden im Klartext gebraucht wird. Deshalb
liegt es verschlüsselt (AES-256-GCM) in der Datenbank, der Schlüssel in
`daten/schluessel.bin` daneben. Das bedeutet: eine Kopie der Datenbank allein —
etwa aus einer Sicherung oder versehentlich weitergegeben — gibt es nicht preis.
Gegen jemanden mit Zugriff auf den ganzen Server schützt es nicht. Wer den
Schlüssel lieber außerhalb hält, setzt die Umgebungsvariable `SCHLUESSEL`; dann
wird die Datei nicht verwendet.

Unverschlüsselt wird nie gesendet: Ohne SMTPS erzwingt der Server STARTTLS.

## Buchhaltung

Erfasst die laufenden Geschäftsvorfälle und übergibt sie **gebündelt an den
Steuerberater** — in dem Dateiformat, das dessen DATEV-Software einlesen kann.

**Kein Zugang nach außen.** Es gibt keine Verbindung zu DATEV Unternehmen
online, keine Übermittlung an ELSTER, keine Anmeldung bei irgendeinem Dienst.
Herauskommt eine Datei, die Sie weitergeben — per USB-Stick, über Ihr
Kanzleiportal oder als E-Mail-Anhang. Das ist bewusst so: Es braucht keine
Online-Berechtigung, und nichts verlässt den Rechner ohne Ihr Zutun.

**Was die Anwendung nicht macht:** keinen Jahresabschluss, keine Bilanz, keine
Umsatzsteuer-Voranmeldung. Das bleibt Aufgabe der Kanzlei. Hier wird erfasst,
geprüft und übergeben.

### Rechtsform GmbH

Eine GmbH ist Kaufmann kraft Rechtsform und bilanziert (§ 238 HGB,
§ 264 HGB) — eine Einnahmen-Überschuss-Rechnung kommt nicht in Betracht.
Gebucht wird deshalb durchgehend doppelt: jeder Vorfall Soll an Haben.
Voreingestellt ist **SKR04**, der Kontenrahmen nach Bilanzgliederung, den DATEV
für Kapitalgesellschaften vorsieht. Führt die Kanzlei SKR03, lässt sich das
unter *Steuerberater → Einrichtung* umstellen.

### Einrichten

Drei Dinge, einmalig:

1. **Berater- und Mandantennummer** eintragen (*Steuerberater → Einrichtung*).
   Beide vergibt die Kanzlei und beide stehen auf jedem Schreiben von dort.
   Ohne sie kann DATEV die Datei keinem Mandanten zuordnen — deshalb verweigert
   die Anwendung ohne sie die Übergabe.
2. **Kontenrahmen abstimmen.** Mitgeliefert wird ein kleiner Grundstock: die
   Konten, ohne die keine Buchung möglich wäre, und die häufigsten Erlös- und
   Aufwandskonten. Das ist ein **Vorschlag**, keine verbindliche Liste — welche
   Konten die Kanzlei für diesen Mandanten führt, entscheidet sie. Am
   einfachsten: dort die Kontenliste anfordern und unter
   *Konten → Kontenliste einlesen* einfügen. Danach die Abstimmung bestätigen;
   bis dahin weist die Anwendung bei jedem Blick darauf hin.

   **Welches Dokument?** Geeignet ist alles, worin je Zeile eine Kontonummer
   mit ihrer Bezeichnung steht — aus PDF, Excel oder CSV herauskopiert.
   Betragsspalten dahinter stören nicht, Kopf- und Summenzeilen werden
   übergangen.

   | Dokument | taugt? |
   |---|---|
   | **Summen- und Saldenliste (SuSa)** | **ja, am besten** — führt jedes Konto mit Nummer, Bezeichnung und Saldo; darin stehen genau die Konten, die für diesen Mandanten tatsächlich geführt werden |
   | **Sachkontenliste / Kontenbeschriftungen** | ja — die reine Liste ohne Zahlen |
   | Kontenblätter | ja, aber umständlich — je Konto eine eigene Seite |
   | **BWA** (die gewöhnliche) | **nein** — fasst zu Positionen wie „Raumkosten" zusammen und nennt keine Kontonummern |
   | **BWA mit Wertenachweis / Kontennachweis** | **teilweise** — führt die Konten einzeln auf und lässt sich einlesen, aber nur die **Erfolgskonten**. Kasse, Bank, Forderungen, Verbindlichkeiten und Umsatzsteuer fehlen darin, und genau die stehen bei jeder Buchung auf der Gegenseite |

   Der Wertenachweis bricht lange Bezeichnungen über zwei Zeilen um und schiebt
   die Betragsspalten dazwischen:

   ```
   6110  Gesetzliche Sozialaufwen-
         2.303,38   2.554,85   2.903,10   ...
   dungen
   ```

   Das wird beim Einlesen wieder zusammengesetzt („Gesetzliche
   Sozialaufwendungen"). Ein Trennstrich verschwindet dabei, außer die
   Fortsetzung beginnt mit „und" oder „oder" — dann gehört er zum Wort
   („Wartungskosten für Hard- und Software"). Zwischenüberschriften der
   Auswertung und die Kopfzeile mit Berater-, Mandanten- und Jahresnummer
   werden übergangen.

   Erkennt die Anwendung keine einzige Kontozeile, sagt sie das ausdrücklich
   und nennt die geeigneten Dokumente — statt wortlos nichts zu tun.

   Die BWA ist trotzdem nützlich, nur für etwas anderes: Sie eignet sich zum
   **Abgleich**. Die Erlös- und Aufwandssummen unter *Buchhaltung → Übersicht*
   sollten zu den entsprechenden BWA-Positionen passen. Weichen sie ab, fehlt
   auf einer der beiden Seiten etwas.
3. **Kunden und Lieferanten** anlegen. Jeder bekommt ein eigenes Personenkonto
   (Debitoren 10000–69999, Kreditoren 70000–99999). Erst dadurch sieht die
   Kanzlei, wer wem was schuldet.

### Erfassen

*Belege → Beleg erfassen.* Die Belegart bringt den Buchungssatz mit: Bei einer
Ausgangsrechnung steht der Kunde im Soll und das Erlöskonto im Haben, bei einer
Eingangsrechnung umgekehrt. Wer die Maske ausfüllt, muss keine Buchführung
können — sieht aber jederzeit, was gebucht wird:

```
1.190,00 € brutto = 1.000,00 € netto + 190,00 € Umsatzsteuer (19 %)
Gebucht wird: 10000 AOK Bayern an 4400 Erlöse 19 % USt
```

Die Rechnung oder Quittung wird gleich mit angehängt. Sie landet in der
normalen Dokumentenverwaltung — gleiche Versionierung, gleiche Zugriffsrechte,
gleiche Sicherung — und geht im Übergabepaket mit.

Beträge werden durchgehend in **Cent als ganze Zahl** geführt. Kommazahlen
wären hier falsch: 0,1 + 0,2 ergibt im Rechner nicht 0,3, und in einer
Buchhaltung darf sich so etwas nicht ansammeln.

### Was nicht geht — und warum

Drei Dinge verhindert die Anwendung; daran hängt die Ordnungsmäßigkeit der
Buchführung (§ 239 HGB, § 146 AO, GoBD):

| | |
|---|---|
| **Löschen** | Gibt es nicht. Falsch Erfasstes wird **storniert**: Es entsteht eine zweite Buchung mit vertauschten Konten, die die erste aufhebt. Beide bleiben stehen. |
| **Ändern nach der Übergabe** | Was endgültig an die Kanzlei ging, ist festgeschrieben und unveränderlich. |
| **Nachbuchen in einen abgeschlossenen Zeitraum** | Ist der Zeitraum bis 31.03. übergeben, nimmt die Anwendung keinen Beleg mehr mit einem Datum davor an. |
| **Ändern einer geschriebenen Rechnung** | Was festgeschrieben ist, ist beim Empfänger. Es wird storniert und neu geschrieben; die Rechnungsnummer bleibt verbraucht. |

Jede Erfassung, Änderung, Stornierung und Übergabe steht mit Zeitpunkt und
Benutzer in der **Historie** — nachlesbar unter *Verwaltung → Historie*.

Die Journalnummer läuft lückenlos fort. Eine Lücke wäre der erste Punkt, den
eine Betriebsprüfung anspricht.

### Kassenbuch

Buchungen auf das Kassenkonto ergeben von selbst das Kassenbuch mit
fortlaufendem Bestand. **Der Bestand kann nie negativ sein** — bar lässt sich
nicht ausgeben, was nicht da ist. Wird er es doch, fehlt eine Einnahme oder
eine Einlage; die Anwendung meldet das deutlich, weil eine Prüfung genau
danach sucht.

### Übergeben

*Steuerberater → Paket erzeugen.* Heraus kommt **eine** ZIP-Datei:

| Datei | Inhalt |
|---|---|
| `EXTF_Buchungsstapel_*.csv` | die Buchungen im DATEV-Format (EXTF, Version 700, Buchungsstapel 13) |
| `EXTF_Kontenbeschriftungen_*.csv` | die Namen der Debitoren- und Kreditorenkonten (Format 20, Version 3) |
| `Buchungsliste.csv` | dieselben Buchungen als lesbare Liste (UTF-8, für Excel) |
| `Kontenrahmen.csv` | die verwendeten Sachkonten, zum Gegenlesen |
| `Umsatzsteuer.txt` | Summen des Zeitraums zum Abgleich |
| `Belege/` | die Rechnungen und Quittungen, benannt nach der Journalnummer |
| `LIESMICH.txt` | was das ist und wie es eingelesen wird |

Warum als Paket: Buchungen ohne die zugehörigen Belege sind für die Kanzlei
wenig wert, und getrennt verschickt kommt erfahrungsgemäß eine Hälfte nicht an.
Im Buchungsstapel steht bei jeder Zeile in der Beleginfo der Dateiname des
zugehörigen Belegs — die Kanzlei findet ihn also ohne Suchen.

Zwei Arten:

- **Probelauf** — ändert nichts, beliebig wiederholbar. Zum Abstimmen.
- **Endgültig** — schreibt die Buchungen fest (Kennzeichen 1 im Stapel) und
  schließt den Zeitraum. Danach keine Änderung mehr.

Jedes Paket bleibt in `daten/buchhaltung/` liegen und lässt sich erneut
speichern — auch Jahre später, wenn die Kanzlei noch einmal danach fragt. Zu
jedem Paket wird eine Prüfsumme festgehalten, mit der sich belegen lässt, dass
die übergebene Datei genau diese war.

Versand per E-Mail geht über dasselbe Postfach wie beim Dokumentversand. **Ein
solches Paket enthält die vollständige Buchführung** — ob unverschlüsselte
E-Mail dafür der richtige Weg ist, entscheidet die Kanzlei; viele bieten ein
Portal an, in das die Datei stattdessen hochgeladen wird.

### Umsatzsteuerliche Stellung

Unter *Buchhaltung → Einrichten* steht, wie das Unternehmen umsatzsteuerlich
behandelt wird. Diese eine Angabe wirkt sich an vier Stellen aus, und sie lässt
sich nicht erraten:

| | |
|---|---|
| **steuerpflichtig** | Der Regelfall. Umsätze mit 19 % oder 7 %, Vorsteuer abziehbar. |
| **steuerfrei (§ 4 UStG)** | Bei Pflegediensten (§ 4 Nr. 16) und Krankenbeförderung (§ 4 Nr. 17 b) der Regelfall. |
| **Kleinunternehmer (§ 19 UStG)** | Keine Steuer, kein Ausweis. |

#### Was bei Steuerfreiheit folgt

- **Rechnungen** tragen 0 % und den **Hinweis auf den Grund der Befreiung** —
  ohne ihn sind sie formal unvollständig (§ 14 Abs. 4 Nr. 8 UStG). Der Satz
  lässt sich einmal hinterlegen und steht dann auf jeder neuen Rechnung.
- **Neue Belege** stehen auf 0 % statt auf 19 %.
- **Die Vorsteuer ist nicht abziehbar** (§ 15 Abs. 2 UStG). Das ist die Folge,
  die am häufigsten übersehen wird: Der *volle* Rechnungsbetrag einer
  Eingangsrechnung gehört auf das Aufwandskonto, mit Steuersatz 0. Wer sie
  trotzdem abtrennt, bucht einen Teil der Betriebsausgabe auf ein
  Vorsteuerkonto, das nie ausgeglichen wird.
- **Die Selbstprüfung** meldet beides: Erlöse mit Umsatzsteuer und gebuchte
  Vorsteuer, jeweils mit Journalnummern und Betrag.
- **Die Umsatzsteuerübersicht** weist die Umsätze in **Kennzahl 48** aus
  (steuerfreie Umsätze ohne Vorsteuerabzug) und erklärt, warum keine Zahllast
  entsteht.

Ein **steuerpflichtiges Nebengeschäft** bleibt möglich — der Verkauf eines alten
Fahrzeugs etwa. Die Anwendung verbietet es nicht, zeigt es aber an. Beim
Kleinunternehmer ist der Ausweis dagegen gesperrt: Ausgewiesene Steuer wird
geschuldet, auch wenn sie nicht anfällt (§ 14c Abs. 2 UStG).

**Welche Befreiung greift, sagt die Kanzlei.** Die Anwendung bietet die
Formulierungen an und besteht darauf, dass eine dasteht — sie entscheidet nicht,
welche.

### Rechnungen schreiben

Bisher wurden Ausgangsrechnungen nur **erfasst** — geschrieben wurden sie
woanders. Unter *Rechnungen* entstehen sie: mit Positionen, Steueraufteilung,
Pflichtangaben und einem Bogen, der auf Firmenbriefpapier passt.

#### Entwurf und Rechnung

Ein Entwurf ist keine Rechnung. Er hat **keine Nummer**, taucht in keiner
Auswertung auf, ändert keinen Saldo und lässt sich spurlos löschen. Erst das
Festschreiben vergibt die Nummer und bucht — und ab da ist nichts mehr zu
ändern.

Das ist kein Selbstzweck: Rechnungsnummern müssen fortlaufend und einmalig sein
(§ 14 Abs. 4 Nr. 4 UStG). Würde die Nummer schon beim Anlegen vergeben, risse
jeder verworfene Entwurf eine Lücke, die man dem Prüfer später erklären müsste.

Das Muster der automatischen Nummern ist einstellbar: `{JJ}` steht für das
zweistellige Jahr, `{JJJJ}` für das vierstellige, `{MM}` für den Monat. Aus
`{JJ}` und acht Stellen wird `2600000001`.

#### Eigene Rechnungsnummer

Wer seine Rechnungen anderswo schreibt und hier nur erfasst, trägt die Nummer
selbst ein — das Feld steht ganz vorn, und leer heißt „die Anwendung vergibt
sie". Beides nebeneinander geht: Eine eigene Nummer bringt die automatische
Zählung nicht durcheinander; fortgezählt wird nur, was zum eingestellten Muster
passt und hinten aus Ziffern besteht.

Geprüft wird zweierlei. Die Nummer darf in dieser Firma **nur einmal** vorkommen
(§ 14 Abs. 4 Nr. 4 UStG) — auch gegen noch nicht festgeschriebene Entwürfe. Und
sie darf nur Zeichen enthalten, die DATEV im Belegfeld annimmt: Buchstaben,
Ziffern und `- _ . /`. Ein Umlaut oder ein Semikolon dort fiele erst beim
Einlesen auf, und dann bei der Kanzlei.

#### Buchungstext

Was in der Buchhaltung steht, lässt sich getrennt vom Betreff eintragen (60
Zeichen, so viel nimmt DATEV). Ohne eigene Angabe wird der Betreff genommen.

#### Netto- oder Bruttopreise

Umschaltbar je Rechnung: Sind die Einzelpreise *Nettobeträge*, wird die
Umsatzsteuer aufgeschlagen; sind es *Bruttobeträge*, wird sie herausgerechnet.
Das zweite ist der Fall, wenn eine fertige Rechnung abgetippt wird — dort
stehen die Endbeträge.

Gerechnet wird in beiden Richtungen **je Steuersatz aus der Summe**, und beide
Wege führen zum selben Steuerbetrag. Auf dem gedruckten Blatt steht bei
Bruttopreisen der Rechnungsbetrag oben und die enthaltene Steuer darunter — ein
„Nettobetrag" über Zeilen, die brutto sind, ergäbe eine Summe, die sich nicht
nachrechnen lässt.

#### Pflichtangaben

Vor dem Festschreiben wird geprüft, was § 14 UStG verlangt: eigener Name mit
Anschrift, eigene Steuernummer oder USt-IdNr., vollständige Anschrift des
Kunden, Datum, Nummer, Art und Umfang der Leistung, der **Zeitpunkt der
Leistung** und die Aufschlüsselung nach Steuersätzen. Was fehlt, wird einzeln
benannt, und festschreiben lässt sich die Rechnung dann gar nicht erst.

Eine formal unvollständige Rechnung kostet den Empfänger den Vorsteuerabzug und
kommt zurück — beim zweiten Mal dann mit Verzug.

#### Umsatzsteuer

Steht auf der Rechnung keine Umsatzsteuer, muss dastehen **warum** (§ 14 Abs. 4
Nr. 8 UStG). Ohne diesen Hinweis lässt sich nicht festschreiben.

Angeboten werden die Formulierungen, die in diesem Umfeld in Frage kommen:

- **§ 4 Nr. 16 UStG, Angebot nach § 45a SGB XI** — eng mit der Betreuung
  hilfsbedürftiger Personen verbundene Leistungen eines anerkannten Angebots
  zur Unterstützung im Alltag (Begleitung, Betreuung, Hauswirtschaft).
- **§ 4 Nr. 16 UStG, Pflege** — eng mit der Pflege verbundene Leistungen.
- **§ 4 Nr. 17 Buchst. b UStG** — Beförderung kranker und verletzter Personen
  mit besonders eingerichteten Fahrzeugen.
- **§ 19 UStG** — Kleinunternehmer.
- **§ 12 Abs. 2 Nr. 10 UStG** — ermäßigter Satz für Personenbeförderung
  innerhalb einer Gemeinde oder bis 50 Kilometer.

Der **Buchstabe** in § 4 Nr. 16 UStG steht bewusst nicht dabei. Die Aufzählung
dort ist mehrfach umnummeriert worden; welcher Buchstabe für einen nach § 45a
SGB XI anerkannten Dienst gilt, trägt die Kanzlei nach. Ein falscher Buchstabe
im Brieftext wäre schlimmer als keiner.

Das sind **Vorschläge, keine Festlegung**. Welche Befreiung greift, hängt am
Fahrzeug und an der Leistung; das gehört einmal mit der Kanzlei geklärt und
steht dann dort. Wer Steuer ausweist, ohne sie zu schulden, schuldet sie
trotzdem (§ 14c UStG) — deshalb wird hier nichts geraten.

#### Abrechnung mit einer Pflegekasse

Zwei Felder gibt es nur dafür, und sie stehen oben auf dem Blatt:

- **Leistungsgrundlage** — auf welcher Grundlage abgerechnet wird. Vorgeschlagen
  werden der *Entlastungsbetrag nach § 45b SGB XI*, die *Verhinderungspflege
  nach § 39 SGB XI*, das *Angebot zur Unterstützung im Alltag nach § 45a
  SGB XI*, die *Pflegesachleistung nach § 36 SGB XI* und *Selbstzahler*; frei
  überschreibbar.
- **Versicherte(r)** — Name und Versichertennummer.

Der Grund ist einfach: Zahler ist die Kasse, die Leistung bekommt der
Versicherte. Ohne beides lässt sich die Rechnung dort nicht zuordnen und kommt
zurück. Bei Selbstzahlern bleiben die Felder leer.

Beträge und Budgets stehen bewusst **nicht** in der Anwendung — sie ändern sich
durch Gesetz, und eine veraltete Zahl im Brieftext wäre schlimmer als keine. Ob
das Budget eines Versicherten für den Monat reicht, wird an anderer Stelle
nachgehalten und hier nicht geprüft.

#### Rechnen

Positionen tragen eine Menge mit drei Nachkommastellen (Kilometer und Stunden
gehen selten glatt auf), einen Einzelpreis, einen Steuersatz und ein
Erlöskonto. Die Steuer wird **je Steuersatz aus der Summe** gerechnet, nicht je
Position — sonst summierten sich die Rundungen.

Gebucht wird je Erlöskonto und Steuersatz eine eigene Zeile: Eine Buchung trägt
genau einen Steuersatz. Alle Zeilen tragen dieselbe Rechnungsnummer als
Belegnummer, damit die Kanzlei einen Vorgang sieht.

Die Rechnung rechnet vom Netto herauf, die Buchung vom Brutto herunter. Dass
beide auf denselben Steuerbetrag kommen, ist geprüft — sonst widersprächen sich
gedrucktes Blatt und Buchführung.

#### Stornieren

Eine festgeschriebene Rechnung wird nicht geändert und nicht gelöscht, sondern
storniert: Jede Buchung bekommt ihr Storno mit vertauschten Konten. Die
**Nummer bleibt vergeben** — sie ist beim Empfänger, und ein zweites Mal
vergeben bezeichnete sie zwei verschiedene Vorgänge.

#### Drucken

Gedruckt wird auf Firmenbriefpapier; die Absenderzeile über dem Anschriftenfeld
steht trotzdem darauf, damit das Blatt auch auf weißem Papier vollständig ist.
Ein Entwurf lässt sich ansehen und drucken, trägt dann aber sichtbar den
Vermerk, dass er keine Rechnung ist.

Was danach kommt, kommt von selbst: Die Rechnung steht als offener Posten, wird
beim Bankimport zur Zahlung vorgeschlagen und landet nach Fälligkeit im
Mahnwesen.

### Bankumsätze und Saldenabgleich

Kontoauszüge werden als CSV eingelesen, den offenen Rechnungen zugeordnet und
gebucht. Auch hier ohne Online-Zugang: Die Datei laden Sie im Onlinebanking
herunter, die Anwendung liest sie — es gibt keine Bankschnittstelle, kein
HBCI, keine gespeicherten Zugangsdaten.

#### Einlesen

*Bank → Kontoauszug einlesen.* Die Spalten werden an den Überschriften
erkannt; Sparkasse, Volksbank, DKB, Commerzbank, ING und andere schreiben sie
verschieden. Erkannt werden auch englische Kopfzeilen, getrennte Soll- und
Habenspalten, ein Vorspann vor der eigentlichen Tabelle, Windows-1252 wie
UTF-8 und beide Zahlenschreibweisen (`1.234,56` und `1,234.56`). Lässt sich
eine Spalte nicht deuten, fragt die Anwendung nach, statt zu raten — ein
vertauschtes Vorzeichen drehte eine Einnahme in eine Ausgabe, und das fiele in
der Summe nicht auf.

Eingelesen wird nur auf Konten mit der Art **Bank**. Ein Kassenbuch entsteht
aus Belegen, nicht aus einer Datei.

**Überlappende Zeiträume sind unbedenklich.** Jeder Umsatz bekommt eine
Kennung aus Datum, Betrag, IBAN, Name und Verwendungszweck; bereits
Vorhandenes wird übergangen. Zwei am selben Tag wirklich gleiche Umsätze —
etwa zweimal dieselbe Gebühr — bleiben trotzdem beide erhalten.

#### Die Gegenprobe

Liefert die Bank den **Kontostand nach jeder Buchung** mit (viele tun das,
etwa als Spalte „Saldo nach Buchung"), wird die ganze Datei nachgerechnet:

```
Anfangsbestand + Summe aller Umsätze = Endsaldo
```

Geht das nicht auf, wurde eine Spalte falsch gedeutet — und das fiele sonst
erst Wochen später beim Abstimmen auf, wenn es niemand mehr dem Import
zuordnet. Die Anwendung sagt es deshalb sofort und beziffert den Unterschied.

Zusätzlich wird die Saldenkette selbst geprüft. Klaffen darin Lücken, ist der
Auszug **gefiltert** heruntergeladen worden — die Umsätze sind dann zwar
richtig, aber unvollständig, und das ist für eine Buchführung ein Unterschied
ums Ganze.

Zwei Dinge fallen dabei nebenbei ab: Der **Endsaldo** muss für die Abstimmung
nicht abgetippt werden, und der **Anfangsbestand** erlaubt eine genaue
Diagnose, wenn die Abstimmung nicht aufgeht (siehe unten).

#### Zuordnen

Ein eingelesener Umsatz ist zunächst nur eine Beobachtung: Die Bank sagt, dass
Geld geflossen ist. Eine Buchung wird daraus erst, wenn feststeht, wogegen.
**Automatisch gebucht wird nichts** — vorgeschlagen ja, entschieden von Hand.
Eine falsch zugeordnete Zahlung fällt sonst erst beim Mahnen auf, und dann
beim Kunden.

Vorgeschlagen wird nach Punkten, und jeder Punkt wird begründet:

| Merkmal | |
|---|---|
| Belegnummer steht im Verwendungszweck | am stärksten — auch ohne Bindestriche gefunden |
| Betrag stimmt mit dem offenen Rest überein | |
| IBAN gehört zu einem Geschäftspartner | |
| Name des Zahlungsbeteiligten passt | Rechtsformzusätze werden dabei übergangen |
| Zahlung liegt nach dem Rechnungsdatum | Zahlung *vor* der Rechnung zählt negativ |

#### Sammelzahlungen

Große Zahler — Krankenkassen vor allem — begleichen selten eine einzelne
Rechnung. Es kommt ein Betrag an, und dahinter stehen fünf, zehn oder zwanzig
Rechnungen; im Verwendungszweck steht bestenfalls „siehe Brief vom 09.09.".

Die Anwendung sucht deshalb die Zusammenstellung offener Posten, die **genau**
diesen Betrag ergibt. Gesucht wird immer nur innerhalb eines Zahlers: Eine
Kombination quer über mehrere Geschäftspartner wäre rechnerisch möglich und
fachlich Unsinn. Die Suche ist nach oben begrenzt und endet auch bei vierzig
offenen Posten in Millisekunden; reicht das nicht, sagt sie das, statt
„nichts gefunden" zu melden.

Entscheidend ist, was danach passiert:

| Ergebnis | |
|---|---|
| **genau eine** Zusammenstellung geht auf | wird vorausgewählt |
| **mehrere** Zusammenstellungen gehen auf | alle werden gezeigt, **keine** vorausgewählt |
| **keine** geht auf | Hinweis, dass von Hand aufzuteilen ist |

Der mittlere Fall ist häufiger, als er klingt: Fünf Rechnungen über je 137,60 €
und eine Zahlung über 275,20 € — dafür gibt es zehn Kombinationen aus
denselben Beträgen. Rechnerisch ist das einerlei, für die offenen Posten aber
nicht: Es entscheidet, welche Rechnung als bezahlt gilt und welche gemahnt
wird. Das kann keine Rechnung entscheiden, also entscheidet die Anwendung es
auch nicht — sie sagt, dass es mehrdeutig ist, und überlässt die Wahl dem
Zahlungsavis.

#### Von Hand aufteilen

Kassen zahlen oft **gekürzt**. Dann geht keine Zusammenstellung auf, und keine
Automatik hilft weiter. Unter *Von Hand aufteilen* stehen alle offenen
Rechnungen des Zahlers mit Ankreuzfeld und Betrag; darunter läuft mit, wie
viel verteilt ist und was übrig bleibt:

```
Verteilt: 300,00 € von 300,00 € — geht genau auf.
Verteilt: 678,16 € von 300,00 € — 378,16 € zu viel verteilt.
```

Wird weniger verteilt als gezahlt, bleibt der Rest der Zahlung ohne Zuordnung
und taucht im Saldenabgleich auf. Wird eine Rechnung nur teilweise bezahlt,
bleibt ihr Rest offen stehen. Mehr verteilen als gezahlt wurde, lässt sich
nicht — weder in der Oberfläche noch über die Schnittstelle.

Zu Gebühren, Löhnen und Steuern gibt es keine Rechnung; die werden gegen ein
Sachkonto gebucht. Dabei schlägt die Anwendung vor, was beim selben
Zahlungsbeteiligten zuletzt verwendet wurde.

Umbuchungen zwischen eigenen Konten stehen auf beiden Auszügen und dürfen nur
einmal gebucht werden. Dafür gibt es *Beiseitelegen* — mit Begründung, und der
Umsatz bleibt stehen.

#### Zuordnungsregeln

Ein Teil der Umsätze wiederholt sich Monat für Monat: Miete, Telefon,
Stadtwerke, Kontoführung, Versicherungen. Jedes Mal dieselbe Entscheidung —
und jedes Mal kann sie anders ausfallen. Mal landet die Miete auf 6310, mal
auf 6300, und am Jahresende passt die Auswertung nicht mehr zusammen.

Eine Regel hält die Entscheidung fest. Angelegt wird sie dort, wo sie ohnehin
fällt: **beim ersten Zuordnen.** Im Zuordnen-Fenster genügt ein Häkchen
(*Diese Zuordnung als Regel merken*), und beim nächsten Umsatz desselben
Zahlers steht das Konto bereits vorgeschlagen da.

Erkannt wird an IBAN, Name, Verwendungszweck, Betrag und Richtung — angegebene
Merkmale müssen **alle** zutreffen, leere werden übergangen. Eine Regel ohne
jedes Merkmal wird abgewiesen: Sie träfe auf jeden Umsatz zu, und das ist der
kürzeste Weg zu einer unbrauchbaren Buchführung.

Bevorzugt wird die **IBAN**. Banken schreiben denselben Namen selten zweimal
gleich — „Karl Muster GmbH und Co. KG" und „Fa. Muster GmbH & Co. KG" sind
derselbe Vermieter, über den Namen aber zwei. Über die IBAN greift die Regel
in beiden Fällen.

**Eine Regel schlägt vor, sie bucht nicht.** Vorausgewählt wird, bestätigt
wird von Hand. Nur wo ausdrücklich *ohne Rückfrage* gesetzt ist, bucht
*Regeln anwenden* in der Bankansicht selbst — und auch das ist ein eigener
Knopf und läuft nicht beim Einlesen mit. Was gebucht wurde, soll jemand
entschieden haben. Hinterher steht da, was geschehen ist und was liegen
blieb, weil die Regel nur vorschlägt.

Beim Anlegen läuft ein **Probelauf** mit: Auf wie viele der noch offenen
Umsätze passt die Regel, und auf welche? Eine Regel, die auf nichts passt,
nützt nichts — und eine, die auf alles passt, richtet Schaden an. Beides soll
man sehen, bevor gespeichert wird.

Greifen mehrere Regeln, gewinnt die mit der kleinsten Sortierung. Jede Regel
zählt mit, wie oft sie verwendet wurde und wann zuletzt.

#### Krankenkassen: Regeln auf den Zahler statt auf ein Konto

Bei einem Krankentransportunternehmen kommt der weitaus größte Teil des Geldes
von Kostenträgern — AOK, Barmer, TK, DAK, IKK, Knappschaft, Pflegekassen,
Berufsgenossenschaften, Sozialämter. Für diese Zahlungen ist eine gewöhnliche
Regel das falsche Werkzeug, und zwar aus einem inhaltlichen Grund: **Geld von
einer Kasse gehört auf deren offene Rechnungen, nicht auf ein festes Konto.**
Eine Regel, die „AOK → 4400" sagt, bucht den Erlös ein zweites Mal — die
Rechnung war ja schon gebucht — und lässt die Forderung offen stehen.

Eine Regel hat deshalb ein **Ziel**: entweder ein *Sachkonto* (Gebühren,
Miete, Strom — alles ohne Rechnungsbezug) oder einen *Zahler*. Eine
Zahlerregel legt nur fest, **von wem** das Geld kommt. Was damit ausgeglichen
wird, entscheidet die Rechnung dahinter: eine einzelne, eine Zusammenstellung
mehrerer (Sammelzahlung) oder eine Aufteilung von Hand.

Das ist der Fall, für den Namenserkennung nicht ausreicht. Ein Auszug aus dem
laufenden Betrieb zeigt es: Dieselbe AOK zahlt von **zwei verschiedenen IBANs**
— einmal als Krankenkasse, einmal als Pflegekasse. Unterschiedliche
Schreibweisen machen aus einem Zahler zwei oder aus zweien einen. Über die IBAN
ist die Zuordnung eindeutig: je eine Zahlerregel pro IBAN, beide auf dasselbe
Personenkonto oder eben auf zwei getrennte.

**Ohne Rückfrage** buchen darf auch eine Zahlerregel — aber nur, wenn die
Zuordnung eindeutig ist: genau eine offene Rechnung trifft den Betrag, oder
genau eine Zusammenstellung geht auf. Passen mehrere, bleibt der Umsatz stehen,
und in der Auswertung steht, warum („3 offene Rechnungen passen zum Betrag —
welche gemeint ist, muss jemand entscheiden"). Welche Rechnung als bezahlt gilt,
ist keine Rechenfrage: Mahnwesen, Verjährung und Zahlungsavis hängen daran.

Passt gar nichts, ist das bei Kassen meist eine **gekürzte Zahlung** — abgesetzte
Fahrten, gekürzte Kilometer, Rechnungsbeanstandung. Dann steht das Aufteilen von
Hand bereit, mit den offenen Posten dieses Zahlers und dem Zahler bereits
ausgewählt; der Rest bleibt offen stehen und taucht in der Altersgliederung
wieder auf. Auf ein Sachkonto zeigt in diesem Fall nichts — das wäre der Fehler,
den die Zahlerregel gerade verhindert.

#### Zahlungsbeteiligte übernehmen

Eine Zahlerregel setzt voraus, dass es den Zahler als Geschäftspartner gibt.
Fünfzehn Kostenträger von Hand mit Namen, IBAN und Personenkonto anzulegen ist
die Sorte Arbeit, bei der sich Zahlendreher einschleichen — und die IBAN steht
ohnehin schon im Auszug.

Nach dem Einlesen steht in der Bankansicht deshalb, welche Zahlungsbeteiligten
**noch keinem Geschäftspartner** zugeordnet sind: Name, IBAN, Anzahl und Summe
ihrer Umsätze. Angehakt werden sie einzeln; *Nur Zahlungseingänge* wählt in einem
Zug alle, von denen Geld kam — bei einem Fahrdienst sind das genau die
Kostenträger. Angelegt wird mit fortlaufender Personenkontonummer, Debitor oder
Kreditor je nach Richtung.

Ausdrücklich **nicht** vorausgewählt ist dabei alles. Ein Kontoauszug enthält
auch Finanzamt, Stadtwerke, Telefon und Tankstelle; die gehören nicht in die
Debitorenbuchhaltung, sondern auf ein Sachkonto. Wer alles anlegt, hat hinterher
vierzig Personenkonten, von denen dreißig nie eine Rechnung tragen. Darauf wird
im Fenster hingewiesen, bevor es geschieht.

#### Offene Posten

Eine Rechnung ist erst erledigt, wenn sie bezahlt ist. Festgehalten wird
deshalb, **welche Zahlung welche Rechnung ausgleicht**. Teilzahlungen sind
vorgesehen: Der Rest bleibt offen.

*Offene Posten* zeigt beide Seiten mit Altersgliederung (nicht fällig, bis 30,
31–60, 61–90, über 90 Tage). Das ist kein Selbstzweck: Was länger als 90 Tage
offen ist, wird selten noch freiwillig bezahlt, und zum Jahresabschluss stellt
sich die Frage nach einer Wertberichtigung.

Die Zuordnung ändert **keine** Buchung — sie hält nur fest, was zusammengehört,
und geht nicht an den Steuerberater mit. Dort zählen die Buchungen.

#### Saldenabgleich

*Saldenabgleich* stellt drei Dinge nebeneinander, die übereinstimmen müssen:

1. **Bankkonto gegen Kontoauszug.** Saldo laut Buchführung, zuzüglich der
   eingelesenen, aber noch nicht gebuchten Umsätze — das müsste auf dem Konto
   stehen. Der Endsaldo kommt aus dem zuletzt eingelesenen Auszug, sofern die
   Bank ihn mitliefert; sonst wird er eingetragen, eine eigene Angabe geht vor.

   Bei einer Abweichung wird zuerst der häufigste Grund geprüft: der
   **Anfangsbestand**. Wer mitten im Jahr anfängt zu buchen, hat den Kontostand
   vom Vortag nirgends stehen — die Differenz ist dann genau dieser Betrag und
   kein Fehler, sondern eine fehlende Eröffnungsbuchung. Weil der Anfangsbestand
   im Kontoauszug steht, lässt sich das ausrechnen und wird auch so benannt.
   Erst wenn das nicht passt, ist es eine echte Abweichung: zu wenig auf dem
   Konto heißt meist doppelt gebucht, zu viel meist fehlende Umsätze im Import.
2. **Personenkonten gegen offene Posten.** Der Saldo eines Kunden muss der
   Summe seiner offenen Rechnungen abzüglich nicht zugeordneter Zahlungen
   entsprechen. Geht das nicht auf, steht auf dem Personenkonto eine Buchung,
   die weder Rechnung noch Zahlung ist.
3. **Was noch offen ist.** Nicht gebuchte Bankumsätze, nicht zugeordnete
   Zahlungen, überfällige Forderungen.

Weicht etwas ab, steht die Ursache daneben. Eine Abstimmung, die nur „passt
nicht" sagt, hilft niemandem.

### Mahnwesen

Offene Posten sagen, welche Rechnung nicht bezahlt ist. Das Mahnwesen sagt, was
daraufhin geschieht — und hält fest, was geschehen ist. Ohne diesen Nachweis
steht später Aussage gegen Aussage: wann gemahnt wurde, mit welcher Frist, über
welchen Betrag.

*Mahnwesen* zeigt drei Dinge nebeneinander: was gemahnt werden kann, was gemahnt
wurde und was daraus geworden ist. Vorgeschlagen wird viel, verschickt wird
nichts von selbst.

#### Eine Mahnung ist keine Buchung

Das ist die wichtigste Festlegung. Mahnkosten und Verzugszinsen werden **nicht**
gebucht, wenn der Brief hinausgeht, sondern erst, wenn das Geld kommt. Wer die
Nebenforderung gleich einbucht, hat Forderungen in der Bilanz, die zum großen
Teil nie bezahlt werden — und muss sie zum Jahresende wieder ausbuchen. Im
Übergabepaket an die Kanzlei taucht deshalb keine Mahnung auf; dort zählen die
Buchungen.

#### Wann gemahnt wird

Eine Rechnung kommt in den Vorschlag, wenn drei Dinge zutreffen: Sie ist
überfällig, die Wartezeit der nächsten Mahnstufe ist erreicht, und die Frist der
letzten Mahnung ist abgelaufen. Das dritte ist das wichtigste — zweimal in einer
Woche zu mahnen macht keinen Eindruck, sondern Ärger.

Gemahnt wird **je Zahler und Stufe**: Wer Rechnungen in zwei Stufen hat, bekommt
zwei Briefe. Alles in einen zu ziehen hieße, eine Rechnung stillschweigend
höherzustufen, die das noch nicht verdient hat.

Vorbereitet sind drei Stufen — Zahlungserinnerung, 1. Mahnung, 2. Mahnung —, alle
in Wortlaut, Wartezeit, Frist und Kosten änderbar. **Drei Mahnungen sind
nirgends vorgeschrieben.** Eine genügt, um in Verzug zu setzen, und bei einem
festen Fälligkeitstag braucht es nicht einmal die (§ 286 Abs. 2 Nr. 1 BGB). Die
drei Stufen sind Gepflogenheit, kein Recht.

Die **Mahngebühr steht auf null**, bis Sie es ändern. Ersatzfähig ist nur der
tatsächliche Verzugsschaden — Porto und Papier, also etwa ein Euro. Wer pauschal
fünf oder zehn Euro ansetzt, hat bei Verbrauchern eine angreifbare Forderung und
bei Krankenkassen ohnehin eine, die nicht bezahlt wird. Mehr als 10,00 € nimmt
die Anwendung nicht an.

#### Verzugszinsen

Verzug beginnt am Tag nach der Fälligkeit, und ohne Fälligkeitsdatum 30 Tage nach
Rechnungsdatum (§ 286 Abs. 3 BGB). Der Zinssatz ist der **Basiszinssatz nach
§ 247 BGB zuzüglich neun Prozentpunkten**; bei Verbrauchern sind es fünf
(§ 288 Abs. 1 und 2 BGB). Deshalb steht am Geschäftspartner ein Schalter
*Verbraucher*: Krankenkassen, Behörden und Firmen sind keine, Selbstzahler schon.

Gerechnet wird taggenau und **abschnittsweise nach Halbjahren**, weil sich der
Basiszinssatz zum 1. Januar und 1. Juli ändert. Ein Jahresmittel wäre schlicht
falsch. Der erste Tag zählt nicht mit, der letzte schon — die für den Schuldner
günstigere Lesart.

Die bekannten Sätze sind vorbelegt, aber sie stehen in einer Tabelle, die man
sieht und ändert, nicht im Programmtext. **Neue Halbjahre kommen nicht von
selbst dazu.** Fehlt einer, rechnet die Anwendung mit dem letzten bekannten Satz
weiter — und sagt das: oben in der Ansicht, am betroffenen Vorschlag und
dauerhaft an der erstellten Mahnung. Rechnen und schweigen wäre hier das
Schlimmste: Der Zins stünde im Brief, und niemand wüsste, dass er auf einem
veralteten Wert beruht. Den aktuellen Satz veröffentlicht die Deutsche
Bundesbank.

#### Der Brief

Gedruckt wird auf Ihr Briefpapier — Absender, Logo und Fußzeile stehen dort
schon. Die Anwendung liefert den Inhalt: Anschrift, Betreff, Text, die Tabelle
der Rechnungen mit Fälligkeit und Zinsen, den Gesamtbetrag und den
Zahlungshinweis. Mehrere Mahnungen lassen sich in einem Zug drucken, eine je
Seite.

Zurückgenommen wird mit Begründung, gelöscht wird nichts. Sonst ließe sich später
nicht mehr erkennen, ob schon einmal gemahnt wurde, und die Stufenzählung finge
von vorn an.

#### Verjährung

Die Ansicht meldet Forderungen, deren Regelverjährung zum Jahresende abläuft:
drei Jahre ab dem Schluss des Jahres, in dem die Forderung entstanden ist
(§§ 195, 199 BGB). Eine Mahnung hemmt die Verjährung **nicht** — dafür braucht es
einen Mahnbescheid oder ein Anerkenntnis.

Das ist ein Hinweis und keine Berechnung: Für Forderungen gegen
Sozialleistungsträger gelten teils abweichende Fristen. Das gehört vor dem
Jahreswechsel mit der Kanzlei besprochen, nicht der Software überlassen.

#### Was hier nicht geschieht

Das **gerichtliche Mahnverfahren**. Der Mahnbescheid geht über das Mahngericht,
nicht über diese Anwendung. Was sie liefert, ist der Nachweis des Verzugs, den
man dafür braucht.

### Umsatzsteuer

*Umsatzsteuer* zeigt die Summen des Zeitraums mit den Kennzahlen der
Voranmeldung (81, 86, 48, 66, 83). Das ist eine **Hilfe zum Abgleich, keine
Voranmeldung** — angemeldet und übermittelt wird sie von der Kanzlei. Von hier
aus geht nichts an das Finanzamt.

### Wer darf was

| Rolle | Buchhaltung |
|---|---|
| `Administrator` | erfassen, Rechnungen schreiben, stornieren, übergeben, mahnen, einrichten |
| `Geschaeftsfuehrung` | ansehen |
| `Verwaltung` | erfassen, Rechnungen schreiben, stornieren, übergeben, mahnen |
| alle übrigen | kein Zugriff |

In den Belegen stehen Umsätze, Gehälter und Bankverbindungen des Unternehmens.
Das geht weder die Einsatzleitung noch einzelne Mitarbeiter etwas an, deshalb
ist die Buchhaltung nicht Teil der Kategorienfreigabe, sondern an die Rolle
gebunden.

### Selbstprüfung

```bash
npm run pruefung
```

Legt in einem Wegwerfordner — nicht im echten Bestand — eine Firma mit Konten,
Partnern und Buchungen an und prüft, was dabei herauskommen muss: die
Steueraufteilung auf den Cent, die Umsatzsteuersummen, den Kassenbestand, das
Stornoverfahren, die Sperren für festgeschriebene Belege. Anschließend wird ein
Übergabepaket erzeugt und wieder auseinandergenommen: 31 Felder im Kopfsatz,
125 Spalten je Buchungszeile, Beträge, Datumsformate, Zeichensatz.

313 Prüfungen, alle bestanden.

## Noch nicht enthalten

- **Automatische Sicherung.** Bisher von Hand bzw. über die Bordmittel des
  Betriebssystems.
- **Stammdaten der Debitoren und Kreditoren im DATEV-Format.** Übergeben werden
  die Kontonummern und ihre Bezeichnungen (Format „Kontenbeschriftungen"), nicht
  aber Anschrift, Bankverbindung und Zahlungsbedingungen im DATEV-Format
  „Debitoren/Kreditoren". Dieses Format hat 243 feststehende Spalten; eine
  Abweichung darin fiele erst beim Einlesen in der Kanzlei auf. Solange das
  nicht gegen eine echte DATEV-Installation geprüft werden konnte, wird es
  nicht angeboten — die Anschriften stehen in `Buchungsliste.csv` und unter
  *Organisationen*.
- **E-Rechnung (XRechnung, ZUGFeRD).** Seit 2025 müssen Unternehmen
  E-Rechnungen empfangen können; die Pflicht, sie zu *stellen*, greift für die
  meisten Betriebe ab 2028 (ab 2027 bei über 800.000 € Vorjahresumsatz).
  Öffentliche Auftraggeber verlangen sie teils schon heute. Gebaut ist das
  nicht: Das Format ist streng, und ohne Prüfung gegen einen echten Validator
  wäre eine erzeugte Datei eine Vermutung. Wenn es soweit ist, gehört es
  gebaut — bis dahin steht hier, dass es fehlt.
- **Budgetverwaltung nach SGB XI — bewusst nicht vorgesehen.** Der
  Entlastungsbetrag (§ 45b) ist ein monatliches Budget je Versichertem, die
  Verhinderungspflege (§ 39) ein jährliches. Die Anwendung schreibt die
  Rechnung und prüft die Budgets nicht; sie werden an anderer Stelle
  nachgehalten. Das ist eine Festlegung, keine Lücke — die Regeln ändern sich
  durch Gesetz, und eine Software, die sie veraltet nachrechnet, wäre
  schlechter als keine.
- **Wiederkehrende Buchungen und Anlagenverzeichnis.** Abschreibungen, Rück-
  stellungen und Abgrenzungen bucht die Kanzlei zum Jahresabschluss.

## Stand

**Getestet und lauffähig.** Die Erstinbetriebnahme wurde durchgespielt:
`npm run erstadmin` mit gültigen Angaben, mit zu schwachem Passwort, mit
abweichender Wiederholung, bei abgebrochener Eingabe (dann wird nichts angelegt)
und beim zweiten Aufruf mit bereits vorhandenen Benutzern. Anschließend
`npm start`, Anmeldung als Administrator im Browser — mit falschem Passwort
abgewiesen, mit richtigem angemeldet, Startstruktur der Kategorien vorhanden.

Der vollständige Ablauf wurde gegen den laufenden
Server geprüft (29 Prüfungen): Anmeldung mit falschem und richtigem Passwort,
Sitzungscookie, erzwungener Passwortwechsel, Person und Benutzer anlegen,
Dokument hochladen und unverändert zurücklesen, Rechte erteilen und entziehen,
Protokollierung — sowie mit einem Mitarbeiterkonto, dass Benutzerliste,
fremde Akten und Rechtevergabe verweigert werden. Dazu acht Prüfungen der
Postfach-Verschlüsselung.

Die Oberfläche wurde im Browser gegen denselben Server bedient: anmelden, alle
zwölf Ansichten, Kunde anlegen, Dokument hochladen und öffnen.

### Buchhaltung

`npm run pruefung` läuft mit **530 Prüfungen** durch: Steueraufteilung,
Umsatzsteuersummen, Kassenbestand, Storno, Nummernkreise, Sperren für
festgeschriebene Belege und abgeschlossene Zeiträume, Einlesen von Kontoauszügen
in den Formaten der großen Banken samt Gegenprobe über die Saldenspalte und
Erkennung doppelter Umsätze, Zuordnung
von Zahlungen zu Rechnungen einschließlich Teilzahlungen, Aufschlüsselung von
Sammelzahlungen samt Erkennung mehrdeutiger Zusammenstellungen, Zuordnungsregeln
einschließlich Reihenfolge, Stilllegung und Trefferzählung, Saldenabgleich,
Einlesen von Kontenlisten
in den Schreibweisen, in denen sie aus DATEV, Excel und PDF herauskommen —
einschließlich des Auszugs einer echten BWA mit Wertenachweis. Das erzeugte
Übergabepaket wird anschließend wieder auseinandergenommen und Feld für Feld
gegen die Vorgaben des DATEV-Formats gehalten: 31 Felder im Kopfsatz,
125 Spalten je Buchungszeile, Belegdatum als TTMM, Leistungsdatum als
TTMMJJJJ, Beträge mit Komma, Zeichensatz Windows-1252 einschließlich
Eurozeichen und typografischer Anführungszeichen.

Die Oberfläche wurde im Browser gegen den laufenden Server bedient: einrichten,
Kontenvorlage laden, Kunde und Lieferant anlegen, Ausgangsrechnung mit
angehängter Rechnung erfassen, Kassenbuch, Umsatzsteuerübersicht, Paket
erzeugen und herunterladen. Das heruntergeladene Paket wurde entpackt und
geprüft. Ebenso der Bankweg: eine Sparkassen-CSV eingelesen, dieselbe Datei ein
zweites Mal ohne Dubletten, einen Zahlungseingang gegen die vorgeschlagene
Rechnung gebucht, eine Bankgebühr gegen ein Sachkonto, und der Saldenabgleich
sowohl mit passendem als auch mit falschem Auszugssaldo. Dazu ein zweiter
Durchlauf für Sammelzahlungen: eine Zahlung über sieben offene Rechnungen
aufgeschlüsselt und gebucht, danach eine gekürzte Zahlung von Hand auf zwei
Rechnungen verteilt — eine ganz, eine teilweise — und geprüft, dass der Rest
offen bleibt und die Abstimmung weiterhin aufgeht. Und ein dritter für die
Zuordnungsregeln: aus der ersten Zuordnung eine Regel gemerkt, geprüft, dass
sie beim nächsten Umsatz greift — auch bei abweichend geschriebenem Namen —,
die übrigen über *Regeln anwenden* gebucht und eine weitere Regel mit
Probelauf angelegt. Ein vierter für die Krankenkassen: aus einem Auszug mit
zwei Kassen, einem Lieferanten und einem Darlehen die Zahlungseingänge als
Geschäftspartner übernommen, eine **Zahlerregel** auf die zweite IBAN angelegt
— mit Probelauf, der den betroffenen Umsatz findet — und geprüft, dass sie beim
Zuordnen greift, namentlich genannt wird, den Zahler setzt und **kein**
Sachkonto vorauswählt.

Ein Durchlauf für zwei Gesellschaften: die Firma umbenannt, eine zweite
angelegt, in der ersten gebucht, gewechselt und nachgesehen, dass drüben nichts
davon zu sehen ist — und nach dem Zurückwechseln alles wieder da.

Ein Durchlauf für die Umsatzsteuerbefreiung: die Stellung eingestellt und
geprüft, dass der Befreiungshinweis auf neuen Rechnungen steht, Positionen und
Belege auf 0 % voreingestellt sind, Umsatzsteuer auf einer Position angemahnt
wird, die Belegvorschau vor dem nicht abziehbaren Vorsteuerabzug warnt und die
Umsatzsteuerübersicht Kennzahl 48 erklärt.

Ein Durchlauf für den Rechnungsdruck: einen Entwurf mit zwei Positionen
geschrieben, am Festschreiben gehindert, solange Steuernummer und
Befreiungshinweis fehlen, geprüft, dass ein abgebrochener Versuch keinen zweiten
Entwurf hinterlässt, dann festgeschrieben, gedruckt, als offenen Posten
wiedergefunden und storniert — samt der Probe, dass die nächste Rechnung die
Folgenummer bekommt und nicht die verbrauchte.

Ein weiterer für das Mahnwesen: aus drei Rechnungen die beiden
überfälligen vorgeschlagen, den fehlenden Basiszinssatz gemeldet und
nachgetragen, die Mahnung erstellt, geprüft, dass innerhalb der Frist nicht
erneut gemahnt wird, dass nach Fristablauf die nächste Stufe mit Zinsen folgt,
dass eine Mahngebühr über zehn Euro abgewiesen wird, und der Brief samt
Druckbogen angesehen. Die Zinsrechnung selbst ist mit von Hand nachgerechneten
Beträgen geprüft — über die Halbjahresgrenze hinweg, für Verbraucher und
Nicht-Verbraucher getrennt.

Der CSV-Import wurde außerdem gegen einen **echten Kontoauszug** gehalten
(Raiffeisenbank, 81 Umsätze): alle Spalten richtig erkannt — auch dass die
IBAN des Zahlungsbeteiligten zählt und nicht die des eigenen Kontos —, kein
Umsatz übersprungen, und die Gegenprobe über die Saldenspalte stimmte auf den
Cent.

**Noch nicht geprüft ist der tatsächliche Import in DATEV** — dafür braucht es
eine Kanzleiinstallation. Der erste Schritt ist deshalb ein **Probelauf**: das
Paket erzeugen und die Kanzlei bitten, es einmal einzulesen, bevor ein Zeitraum
endgültig festgeschrieben wird. Genau dafür ist der Probelauf da.

Ungetestet bleibt ebenso der **tatsächliche E-Mail-Versand** — dafür braucht es ein
echtes Postfach. Die Verschlüsselung und Speicherung der Zugangsdaten ist
geprüft, das Zusammenspiel mit Ihrem Anbieter noch nicht. Erster Schritt:
Postfach eintragen und *Verbindung prüfen*.
