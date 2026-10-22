# Verwaltung – maCura Mobil

Eigenständige Akten-, Dokumenten- und Buchhaltungsverwaltung der **maCura Mobil**.

Diese Anwendung ist bewusst vollständig von anderen Firmen getrennt: eigene Datenbank,
eigene Sicherungen, eigener Port. Sie teilt keine Daten mit der Verwaltung der
maCura Seniorendienst GmbH oder anderer Gesellschaften. Die Software selbst ist dieselbe
wie dort; Änderungen daran werden in beiden Verwaltungen gleich nachgezogen.

## Inhalt

| Datei | Zweck |
|---|---|
| `verwaltung.html` | Oberfläche der Verwaltung (Kunden, Mitarbeiter, Dokumente, Kategorien, Buchhaltung, Benutzer, Rechte, Historie) |
| `server/` | Server mit eigener SQLite-Datenbank unter `server/daten/` – Einrichtung und Betrieb siehe [`server/README.md`](server/README.md) |

## Start

**Windows, per Doppelklick:** `Verwaltung starten.cmd` im Hauptordner öffnen. Die Datei
prüft Node.js (ab 22.5), installiert beim ersten Mal die Pakete, startet den Server und
öffnet den Browser unter `http://127.0.0.1:8082`. Das Fenster offen lassen, solange mit
der Verwaltung gearbeitet wird – Schließen beendet sie.

**Von Hand:**

```bash
cd server
npm install
npm start
```

Dann `http://127.0.0.1:8082` öffnen. Der Port ist absichtlich 8082, damit die Anwendung auf
demselben Rechner neben den anderen Verwaltungen (8080, 8081) laufen kann.

## Buchhaltung

Unter **Buchhaltung** im Menü: Belege, Rechnungen (mit selbst vergebener Rechnungsnummer),
Bank, offene Posten, Mahnwesen, Kassenbuch mit fortlaufendem Bestand, Umsatzsteuer und
Übergabe an den Steuerberater (DATEV). Selbstprüfung: `cd server && npm run pruefung`.
