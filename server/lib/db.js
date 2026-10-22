"use strict";
/**
 * Datenhaltung: eine einzelne SQLite-Datei unter daten/verwaltung.db.
 *
 * Bewusst kein Datenbankserver: Die Anwendung soll auf einem gewoehnlichen
 * Rechner laufen, ohne Fremddienst und ohne Netzabhaengigkeit. Eine Sicherung
 * ist damit das Kopieren des Ordners daten/.
 */

// SQLite ist ab Node 22.5 eingebaut. Bewusst keine Fremdbibliothek: die haette
// beim Einrichten kompiliert werden muessen und dafuer Build-Werkzeuge verlangt.
const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");
const path = require("path");

const WURZEL = path.join(__dirname, "..");
/*
 * Wo die Daten liegen. Standard ist daten/ neben der Anwendung.
 *
 * Ueber DATEN_ORDNER laesst sich ein anderer Ort waehlen - etwa ein
 * verschluesseltes Laufwerk, oder ein Wegwerfordner fuer die Selbstpruefung
 * (npm run pruefung), damit die dort angelegten Beispieldaten nicht im
 * echten Bestand landen.
 */
const DATEN = process.env.DATEN_ORDNER ? path.resolve(process.env.DATEN_ORDNER) : path.join(WURZEL, "daten");
const DATEIEN = path.join(DATEN, "dateien");

fs.mkdirSync(DATEIEN, { recursive: true });

const db = new DatabaseSync(path.join(DATEN, "verwaltung.db"));
db.exec("PRAGMA journal_mode = WAL");   // vertraegt Lesen waehrend Schreibvorgaengen
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS firmen (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  aktiv         INTEGER NOT NULL DEFAULT 1,
  angelegt_am   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Anmeldedaten liegen ausschliesslich hier. Das Passwort selbst wird nie
-- gespeichert, nur ein scrypt-Abdruck mit eigenem Zufallssalz je Benutzer.
CREATE TABLE IF NOT EXISTS benutzer (
  id                INTEGER PRIMARY KEY,
  firma_id          INTEGER NOT NULL REFERENCES firmen(id) ON DELETE CASCADE,
  anmeldename       TEXT NOT NULL,
  passwort_abdruck  TEXT NOT NULL,
  salz              TEXT NOT NULL,
  person_id         INTEGER REFERENCES personen(id) ON DELETE SET NULL,
  app_rolle         TEXT NOT NULL,
  aktiv             INTEGER NOT NULL DEFAULT 1,
  passwort_wechseln INTEGER NOT NULL DEFAULT 1,
  fehlversuche      INTEGER NOT NULL DEFAULT 0,
  gesperrt_bis      TEXT,
  letzte_anmeldung  TEXT,
  angelegt_am       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (firma_id, anmeldename)
);

CREATE TABLE IF NOT EXISTS sitzungen (
  id            TEXT PRIMARY KEY,
  benutzer_id   INTEGER NOT NULL REFERENCES benutzer(id) ON DELETE CASCADE,
  erstellt_am   TEXT NOT NULL DEFAULT (datetime('now')),
  laeuft_ab     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS personen (
  id            INTEGER PRIMARY KEY,
  firma_id      INTEGER NOT NULL REFERENCES firmen(id) ON DELETE CASCADE,
  personen_id   TEXT NOT NULL,
  name          TEXT NOT NULL,
  rollen        TEXT NOT NULL DEFAULT '[]',
  email         TEXT, telefon TEXT, strasse TEXT, plz TEXT, ort TEXT,
  geburtsdatum  TEXT, eintrittsdatum TEXT,
  notiz         TEXT,
  aktiv         INTEGER NOT NULL DEFAULT 1,
  angelegt_am   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS organisationen (
  id        INTEGER PRIMARY KEY,
  firma_id  INTEGER NOT NULL REFERENCES firmen(id) ON DELETE CASCADE,
  name      TEXT NOT NULL, typ TEXT,
  strasse   TEXT, plz TEXT, ort TEXT, telefon TEXT, email TEXT, notiz TEXT
);

CREATE TABLE IF NOT EXISTS kategorien (
  id          INTEGER PRIMARY KEY,
  firma_id    INTEGER NOT NULL REFERENCES firmen(id) ON DELETE CASCADE,
  eltern_id   INTEGER REFERENCES kategorien(id) ON DELETE CASCADE,
  titel       TEXT NOT NULL,
  bereich     TEXT NOT NULL,
  pfad        TEXT NOT NULL,
  sortierung  INTEGER NOT NULL DEFAULT 99,
  aktiv       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS dokumente (
  id            INTEGER PRIMARY KEY,
  firma_id      INTEGER NOT NULL REFERENCES firmen(id) ON DELETE CASCADE,
  dokument_id   TEXT NOT NULL,
  person_id     INTEGER REFERENCES personen(id) ON DELETE SET NULL,
  kategorie_id  INTEGER NOT NULL REFERENCES kategorien(id) ON DELETE RESTRICT,
  dateiname     TEXT NOT NULL,
  mime_typ      TEXT,
  version       TEXT NOT NULL DEFAULT '1.0',
  status        TEXT NOT NULL DEFAULT 'gueltig',
  gueltig_ab    TEXT, gueltig_bis TEXT,
  notiz         TEXT,
  verantwortlich TEXT,
  gesendet_am   TEXT,
  gesendet_an   TEXT,
  geaendert_am  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Jede Fassung bleibt erhalten; das Dokument behaelt seine Identitaet.
CREATE TABLE IF NOT EXISTS dokument_versionen (
  id            INTEGER PRIMARY KEY,
  dokument_id   INTEGER NOT NULL REFERENCES dokumente(id) ON DELETE CASCADE,
  version       TEXT NOT NULL,
  dateiname     TEXT NOT NULL,
  ablage        TEXT NOT NULL,
  groesse       INTEGER NOT NULL DEFAULT 0,
  erstellt_am   TEXT NOT NULL DEFAULT (datetime('now')),
  erstellt_von  TEXT
);

CREATE TABLE IF NOT EXISTS zugriffsrechte (
  id            INTEGER PRIMARY KEY,
  firma_id      INTEGER NOT NULL REFERENCES firmen(id) ON DELETE CASCADE,
  benutzer_id   INTEGER NOT NULL REFERENCES benutzer(id) ON DELETE CASCADE,
  kategorie_id  INTEGER NOT NULL REFERENCES kategorien(id) ON DELETE CASCADE,
  rechte        TEXT NOT NULL DEFAULT '[]',
  erteilt_von   TEXT,
  gueltig_bis   TEXT,
  status        TEXT NOT NULL DEFAULT 'aktiv',
  geaendert_am  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (benutzer_id, kategorie_id)
);

CREATE TABLE IF NOT EXISTS historie (
  id          INTEGER PRIMARY KEY,
  firma_id    INTEGER NOT NULL REFERENCES firmen(id) ON DELETE CASCADE,
  zeitpunkt   TEXT NOT NULL DEFAULT (datetime('now')),
  bezug_typ   TEXT, bezug_id TEXT, aktion TEXT NOT NULL,
  benutzer    TEXT, details TEXT
);

-- Frei konfigurierbare Eintraege in der Seitenleiste. Jeder zeigt auf eine
-- Kategorie und oeffnet deren Unterlagen - damit haeufig gebrauchte Bereiche
-- nicht jedes Mal ueber den Filter gesucht werden muessen.
CREATE TABLE IF NOT EXISTS menuepunkte (
  id            INTEGER PRIMARY KEY,
  firma_id      INTEGER NOT NULL REFERENCES firmen(id) ON DELETE CASCADE,
  titel         TEXT NOT NULL,
  kategorie_id  INTEGER NOT NULL REFERENCES kategorien(id) ON DELETE CASCADE,
  sortierung    INTEGER NOT NULL DEFAULT 99
);

CREATE TABLE IF NOT EXISTS design (
  firma_id    INTEGER NOT NULL REFERENCES firmen(id) ON DELETE CASCADE,
  schluessel  TEXT NOT NULL,
  wert        TEXT NOT NULL,
  PRIMARY KEY (firma_id, schluessel)
);

CREATE INDEX IF NOT EXISTS ix_personen_firma    ON personen(firma_id);
CREATE INDEX IF NOT EXISTS ix_dokumente_firma   ON dokumente(firma_id);
CREATE INDEX IF NOT EXISTS ix_dokumente_person  ON dokumente(person_id);
CREATE INDEX IF NOT EXISTS ix_dokumente_frist   ON dokumente(gueltig_bis);
CREATE INDEX IF NOT EXISTS ix_kategorien_firma  ON kategorien(firma_id);
CREATE INDEX IF NOT EXISTS ix_historie_firma    ON historie(firma_id, zeitpunkt);
CREATE INDEX IF NOT EXISTS ix_sitzungen_ablauf  ON sitzungen(laeuft_ab);
`);

/*
 * Nachtraegliche Spalten. CREATE TABLE IF NOT EXISTS ruehrt eine bestehende
 * Tabelle nicht an - bei einer bereits laufenden Installation muessen neue
 * Spalten deshalb einzeln ergaenzt werden.
 */
function spalteErgaenzen(tabelle, spalte, definition) {
  const vorhanden = db.prepare("PRAGMA table_info(" + tabelle + ")").all()
    .some((s) => s.name === spalte);
  if (vorhanden) return false;
  db.exec("ALTER TABLE " + tabelle + " ADD COLUMN " + spalte + " " + definition);
  return true;
}

const ergaenzt = [
  spalteErgaenzen("dokumente", "mime_typ", "TEXT"),
  spalteErgaenzen("dokumente", "gesendet_am", "TEXT"),
  spalteErgaenzen("dokumente", "gesendet_an", "TEXT"),
  spalteErgaenzen("dokument_versionen", "mime_typ", "TEXT"),
].filter(Boolean).length;
if (ergaenzt) console.log("Datenbank erweitert: " + ergaenzt + " Spalte(n) ergaenzt.");

/** Startstruktur der Untermenues - identisch fuer jede neue Firma. */
const KATEGORIE_VORLAGE = [
  { name: "Kundenakte", bereich: "Kunde", kinder: [
    { name: "Stammdaten" }, { name: "Vertraege" }, { name: "Leistungen" },
    { name: "Termine" }, { name: "Kommunikation" }, { name: "Abrechnung" },
  ]},
  { name: "Buchhaltung", bereich: "Buchhaltung", kinder: [
    { name: "Ausgangsrechnungen" }, { name: "Eingangsrechnungen" },
    { name: "Kassenbelege" }, { name: "Bankunterlagen" }, { name: "Steuerunterlagen" },
  ]},
  { name: "Mitarbeiterakte", bereich: "Mitarbeiter", kinder: [
    { name: "Stammdaten" },
    { name: "Bewerbung", kinder: [{ name: "Lebenslauf" }, { name: "Zeugnisse" }] },
    { name: "Vertragsunterlagen", kinder: [{ name: "Arbeitsvertrag" }, { name: "Zusatzvereinbarung" }] },
    { name: "Krankenkasse" }, { name: "Sozialversicherung" },
    { name: "Qualifikationen" }, { name: "Schulungen" },
    { name: "Abwesenheiten", kinder: [{ name: "Krankmeldungen" }, { name: "Urlaubsantraege" }] },
  ]},
];

/** Legt die Kategorien einer Firma an. Wiederholbar: Vorhandenes bleibt stehen. */
function kategorienAnlegen(firmaId) {
  const vorhanden = db.prepare("SELECT pfad FROM kategorien WHERE firma_id = ?").all(firmaId)
    .reduce((m, r) => (m[r.pfad] = true, m), {});
  const einfuegen = db.prepare(
    "INSERT INTO kategorien (firma_id, eltern_id, titel, bereich, pfad, sortierung) VALUES (?,?,?,?,?,?)");
  let n = 0;
  (function gehe(knoten, bereich, elternId, elternPfad) {
    for (const k of knoten) {
      const eigener = k.bereich || bereich;
      const pfad = elternPfad ? elternPfad + "/" + k.name : k.name;
      let id;
      if (vorhanden[pfad]) {
        id = db.prepare("SELECT id FROM kategorien WHERE firma_id = ? AND pfad = ?").get(firmaId, pfad).id;
      } else {
        id = einfuegen.run(firmaId, elternId, k.name, eigener, pfad, ++n).lastInsertRowid;
      }
      if (k.kinder) gehe(k.kinder, eigener, id, pfad);
    }
  })(KATEGORIE_VORLAGE, null, null, "");
}

/** Legt eine Firma samt Startstruktur an - der Vorgang fuer jeden Standort. */
function firmaAnlegen(name) {
  const id = db.prepare("INSERT INTO firmen (name) VALUES (?)").run(name).lastInsertRowid;
  kategorienAnlegen(id);
  return id;
}

module.exports = { db, DATEN, DATEIEN, firmaAnlegen, kategorienAnlegen, KATEGORIE_VORLAGE };
