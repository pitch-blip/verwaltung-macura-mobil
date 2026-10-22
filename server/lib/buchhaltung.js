"use strict";
/**
 * Buchhaltung.
 *
 * Zweck ist nicht, den Jahresabschluss selbst zu erstellen - das macht der
 * Steuerberater. Zweck ist, die Geschaeftsvorfaelle waehrend des Jahres so zu
 * erfassen, dass sie vollstaendig, nachvollziehbar und in einem Stueck an die
 * Kanzlei uebergeben werden koennen.
 *
 * Drei Dinge sind dabei nicht verhandelbar, weil daran die Ordnungsmaessigkeit
 * der Buchfuehrung haengt (§ 239 HGB, § 146 AO, GoBD):
 *
 *   Vollstaendig    Jeder Beleg bekommt eine fortlaufende Journalnummer ohne
 *                   Luecken. Geloescht wird nie - falsch Erfasstes wird
 *                   storniert, beides bleibt stehen.
 *   Unveraenderbar  Was an den Steuerberater uebergeben wurde, ist
 *                   festgeschrieben und laesst sich nicht mehr aendern.
 *                   In einen abgeschlossenen Zeitraum kann auch nicht
 *                   nachtraeglich hineingebucht werden.
 *   Nachvollziehbar Jede Erfassung, Aenderung, Stornierung und Uebergabe steht
 *                   mit Zeitpunkt und Benutzer in der Historie.
 *
 * Betraege werden durchgaengig in Cent als ganze Zahl gefuehrt. Kommazahlen
 * waeren hier falsch: 0,1 + 0,2 ergibt im Rechner nicht 0,3, und in einer
 * Buchhaltung darf sich so etwas nicht ansammeln.
 */

const { db } = require("./db");
const R = require("./rechte");
const { VORLAGEN, STEUERSCHLUESSEL, personenkonten } = require("./kontenrahmen");

const Verweigert = R.Verweigert;
const json = (status, koerper) => ({ status, koerper });

/* ------------------------------------------------------------- Datenbank */

db.exec(`
CREATE TABLE IF NOT EXISTS buch_einstellungen (
  firma_id              INTEGER PRIMARY KEY REFERENCES firmen(id) ON DELETE CASCADE,
  berater               TEXT,
  mandant               TEXT,
  skr                   TEXT NOT NULL DEFAULT '04',
  sachkontenlaenge      INTEGER NOT NULL DEFAULT 4,
  wj_beginn             TEXT NOT NULL DEFAULT '01-01',
  steuerberater_name    TEXT,
  steuerberater_email   TEXT,
  herkunft              TEXT NOT NULL DEFAULT 'SV',
  konten_bestaetigt_am  TEXT,
  konten_bestaetigt_von TEXT,
  geaendert_am          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS buch_konten (
  id          INTEGER PRIMARY KEY,
  firma_id    INTEGER NOT NULL REFERENCES firmen(id) ON DELETE CASCADE,
  nummer      TEXT NOT NULL,
  bezeichnung TEXT NOT NULL,
  art         TEXT NOT NULL,
  steuersatz  INTEGER NOT NULL DEFAULT 0,
  automatik   INTEGER NOT NULL DEFAULT 0,
  bu          TEXT,
  geld        TEXT,
  aktiv       INTEGER NOT NULL DEFAULT 1,
  notiz       TEXT,
  UNIQUE (firma_id, nummer)
);

-- Debitoren (Kunden) und Kreditoren (Lieferanten). Getrennt von "personen"
-- und "organisationen": dieselbe Krankenkasse kann dort als Organisation
-- stehen und hier ein Konto haben, aber nicht jede Organisation braucht eines.
CREATE TABLE IF NOT EXISTS buch_partner (
  id              INTEGER PRIMARY KEY,
  firma_id        INTEGER NOT NULL REFERENCES firmen(id) ON DELETE CASCADE,
  typ             TEXT NOT NULL,
  konto           TEXT NOT NULL,
  name            TEXT NOT NULL,
  person_id       INTEGER REFERENCES personen(id) ON DELETE SET NULL,
  organisation_id INTEGER REFERENCES organisationen(id) ON DELETE SET NULL,
  ustid           TEXT, steuernummer TEXT,
  strasse         TEXT, plz TEXT, ort TEXT, land TEXT,
  iban            TEXT, notiz TEXT,
  aktiv           INTEGER NOT NULL DEFAULT 1,
  angelegt_am     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (firma_id, konto)
);

CREATE TABLE IF NOT EXISTS buch_exporte (
  id           INTEGER PRIMARY KEY,
  firma_id     INTEGER NOT NULL REFERENCES firmen(id) ON DELETE CASCADE,
  kennung      TEXT NOT NULL,
  von          TEXT NOT NULL,
  bis          TEXT NOT NULL,
  endgueltig   INTEGER NOT NULL DEFAULT 0,
  anzahl       INTEGER NOT NULL DEFAULT 0,
  summe_cent   INTEGER NOT NULL DEFAULT 0,
  dateiname    TEXT NOT NULL,
  ablage       TEXT NOT NULL,
  groesse      INTEGER NOT NULL DEFAULT 0,
  pruefsumme   TEXT,
  erstellt_am  TEXT NOT NULL DEFAULT (datetime('now')),
  erstellt_von TEXT,
  gesendet_am  TEXT,
  gesendet_an  TEXT
);

CREATE TABLE IF NOT EXISTS buch_belege (
  id              INTEGER PRIMARY KEY,
  firma_id        INTEGER NOT NULL REFERENCES firmen(id) ON DELETE CASCADE,
  journal_nr      INTEGER NOT NULL,
  belegnummer     TEXT NOT NULL,
  art             TEXT NOT NULL,
  datum           TEXT NOT NULL,
  leistungsdatum  TEXT,
  faellig_am      TEXT,
  partner_id      INTEGER REFERENCES buch_partner(id) ON DELETE SET NULL,
  soll_konto      TEXT NOT NULL,
  haben_konto     TEXT NOT NULL,
  brutto_cent     INTEGER NOT NULL,
  steuersatz      INTEGER NOT NULL DEFAULT 0,
  steuer_cent     INTEGER NOT NULL DEFAULT 0,
  netto_cent      INTEGER NOT NULL DEFAULT 0,
  bu              TEXT,
  buchungstext    TEXT NOT NULL,
  kost1           TEXT, kost2 TEXT,
  dokument_id     INTEGER REFERENCES dokumente(id) ON DELETE SET NULL,
  storno_von      INTEGER REFERENCES buch_belege(id) ON DELETE SET NULL,
  storniert_durch INTEGER REFERENCES buch_belege(id) ON DELETE SET NULL,
  export_id       INTEGER REFERENCES buch_exporte(id) ON DELETE SET NULL,
  festgeschrieben INTEGER NOT NULL DEFAULT 0,
  notiz           TEXT,
  angelegt_am     TEXT NOT NULL DEFAULT (datetime('now')),
  angelegt_von    TEXT,
  geaendert_am    TEXT,
  UNIQUE (firma_id, journal_nr)
);

-- Kontoauszuege. Ein Umsatz ist zunaechst nur eine Beobachtung: die Bank sagt,
-- dass Geld geflossen ist. Erst durch das Buchen wird ein Beleg daraus.
CREATE TABLE IF NOT EXISTS buch_bankimporte (
  id            INTEGER PRIMARY KEY,
  firma_id      INTEGER NOT NULL REFERENCES firmen(id) ON DELETE CASCADE,
  konto         TEXT NOT NULL,
  dateiname     TEXT NOT NULL,
  zeilen        INTEGER NOT NULL DEFAULT 0,
  neu           INTEGER NOT NULL DEFAULT 0,
  doppelt       INTEGER NOT NULL DEFAULT 0,
  uebersprungen INTEGER NOT NULL DEFAULT 0,
  von           TEXT, bis TEXT,
  -- Kontostand nach dem neuesten Umsatz der Datei, sofern die Bank ihn
  -- mitliefert. Damit muss er fuer die Abstimmung nicht abgetippt werden.
  endsaldo_cent   INTEGER,
  endsaldo_datum  TEXT,
  -- Kontostand vor dem aeltesten Umsatz der Datei. Damit laesst sich eine
  -- Abweichung als fehlender Anfangsbestand erkennen statt als fehlender Umsatz.
  anfangsaldo_cent INTEGER,
  anfang_datum     TEXT,
  saldo_luecken   INTEGER,
  erstellt_am   TEXT NOT NULL DEFAULT (datetime('now')),
  erstellt_von  TEXT
);

CREATE TABLE IF NOT EXISTS buch_bankumsaetze (
  id           INTEGER PRIMARY KEY,
  firma_id     INTEGER NOT NULL REFERENCES firmen(id) ON DELETE CASCADE,
  import_id    INTEGER REFERENCES buch_bankimporte(id) ON DELETE SET NULL,
  konto        TEXT NOT NULL,
  datum        TEXT NOT NULL,
  valuta       TEXT,
  betrag_cent  INTEGER NOT NULL,
  waehrung     TEXT NOT NULL DEFAULT 'EUR',
  beteiligter  TEXT, iban TEXT, bic TEXT,
  zweck        TEXT, buchungstext TEXT, referenz TEXT,
  kennung      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'offen',
  beleg_id     INTEGER REFERENCES buch_belege(id) ON DELETE SET NULL,
  notiz        TEXT,
  angelegt_am  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (firma_id, kennung)
);

-- Welche Zahlung welche Rechnung ausgleicht. Ohne diese Zuordnung waere nur
-- der Saldo eines Kunden bekannt, nicht aber, welche Rechnung noch offen ist -
-- und genau danach wird beim Mahnen und beim Abstimmen gefragt.
-- Teilzahlungen sind vorgesehen: mehrere Zeilen je Rechnung.
CREATE TABLE IF NOT EXISTS buch_ausgleich (
  id           INTEGER PRIMARY KEY,
  firma_id     INTEGER NOT NULL REFERENCES firmen(id) ON DELETE CASCADE,
  rechnung_id  INTEGER NOT NULL REFERENCES buch_belege(id) ON DELETE CASCADE,
  zahlung_id   INTEGER NOT NULL REFERENCES buch_belege(id) ON DELETE CASCADE,
  betrag_cent  INTEGER NOT NULL,
  angelegt_am  TEXT NOT NULL DEFAULT (datetime('now')),
  angelegt_von TEXT,
  UNIQUE (rechnung_id, zahlung_id)
);

CREATE INDEX IF NOT EXISTS ix_bankumsaetze  ON buch_bankumsaetze(firma_id, status, datum);
CREATE INDEX IF NOT EXISTS ix_ausgleich_rg  ON buch_ausgleich(rechnung_id);
CREATE INDEX IF NOT EXISTS ix_ausgleich_zlg ON buch_ausgleich(zahlung_id);
CREATE INDEX IF NOT EXISTS ix_buch_belege_firma  ON buch_belege(firma_id, datum);
CREATE INDEX IF NOT EXISTS ix_buch_belege_export ON buch_belege(export_id);
CREATE INDEX IF NOT EXISTS ix_buch_konten_firma  ON buch_konten(firma_id, nummer);
CREATE INDEX IF NOT EXISTS ix_buch_partner_firma ON buch_partner(firma_id, typ);
`);

/*
 * Nachtraegliche Spalten. CREATE TABLE IF NOT EXISTS ruehrt eine bestehende
 * Tabelle nicht an - bei einer schon laufenden Installation muessen neue
 * Spalten deshalb einzeln ergaenzt werden.
 */
for (const [tabelle, spalte, art] of [
  ["buch_bankimporte", "endsaldo_cent", "INTEGER"],
  ["buch_bankimporte", "endsaldo_datum", "TEXT"],
  ["buch_bankimporte", "saldo_luecken", "INTEGER"],
  ["buch_bankimporte", "anfangsaldo_cent", "INTEGER"],
  ["buch_bankimporte", "anfang_datum", "TEXT"],
  // Fuer das Mahnwesen: Verbraucher oder nicht (§ 288 BGB, verschiedene
  // Zinssaetze), und die Angaben, die im Mahnbrief stehen muessen.
  ["buch_partner", "verbraucher", "INTEGER NOT NULL DEFAULT 0"],
  ["buch_einstellungen", "absender", "TEXT"],
  ["buch_einstellungen", "zahlungsdaten", "TEXT"],
  ["buch_einstellungen", "unterzeichner", "TEXT"],
  // Fuer den Rechnungsdruck: eigene Steuernummer (Pflichtangabe nach § 14
  // UStG) und der Nummernkreis der Ausgangsrechnungen.
  ["buch_einstellungen", "steuernummer", "TEXT"],
  ["buch_einstellungen", "ustid", "TEXT"],
  ["buch_einstellungen", "rechnung_praefix", "TEXT"],
  ["buch_einstellungen", "rechnung_stellen", "INTEGER"],
  // Umsatzsteuerliche Stellung des Unternehmens. Sie entscheidet ueber den
  // Steuersatz der Vorgaben, ueber den Vorsteuerabzug und darueber, was auf
  // der Rechnung stehen muss - und kann nicht erraten werden.
  ["buch_einstellungen", "ust_art", "TEXT"],
  ["buch_einstellungen", "steuerhinweis", "TEXT"],
]) {
  const da = db.prepare("PRAGMA table_info(" + tabelle + ")").all().some((x) => x.name === spalte);
  if (!da) db.exec("ALTER TABLE " + tabelle + " ADD COLUMN " + spalte + " " + art);
}

/* --------------------------------------------------------------- Hilfen */

const w = (v) => (v === undefined || v === "" ? null : v);
const ZAHLARTEN = ["Ausgangsrechnung", "Eingangsrechnung", "Zahlungseingang", "Zahlungsausgang",
  "Kasseneinnahme", "Kassenausgabe", "Sonstiges"];
const KONTOARTEN = ["Aktiv", "Passiv", "Ertrag", "Aufwand"];

/*
 * Umsatzsteuerliche Stellung.
 *
 *   steuerpflichtig  - der Normalfall.
 *   steuerfrei       - die Umsaetze sind nach § 4 UStG befreit. Bei einem
 *                      Pflegedienst oder Krankenfahrdienst der Regelfall
 *                      (§ 4 Nr. 16 und Nr. 17 b). Folge: keine Umsatzsteuer
 *                      auf den Rechnungen - und, was leicht uebersehen wird,
 *                      auch kein Vorsteuerabzug aus Eingangsrechnungen
 *                      (§ 15 Abs. 2 UStG).
 *   kleinunternehmer - § 19 UStG. Hier darf ueberhaupt keine Steuer
 *                      ausgewiesen werden; ausgewiesene wird geschuldet
 *                      (§ 14c Abs. 2 UStG).
 */
const UST_ARTEN = ["steuerpflichtig", "steuerfrei", "kleinunternehmer"];

function protokoll(sitzung, bezugId, aktion, details) {
  db.prepare(`INSERT INTO historie (firma_id, bezug_typ, bezug_id, aktion, benutzer, details)
              VALUES (?,?,?,?,?,?)`)
    .run(sitzung.firmaId, "Buchhaltung", String(bezugId ?? ""), aktion, sitzung.anmeldename, details || "");
}

/** Lesen darf, wer die Buchhaltung sehen darf; schreiben nur mit Schreibrecht. */
function fordereLesen(s) { R.fordereLesen(s, "buchhaltung"); }
function fordereSchreiben(s) { R.fordereSchreiben(s, "buchhaltung"); }

function istDatum(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || "")); }

/**
 * Aufteilung eines Bruttobetrages.
 *
 * Gerechnet wird in Cent mit kaufmaennischer Rundung. Der Steuerbetrag wird
 * gerundet, der Nettobetrag ergibt sich als Rest - so stimmt die Summe immer
 * genau, statt um einen Cent danebenzuliegen.
 */
function aufteilen(bruttoCent, satz) {
  const brutto = Math.round(Number(bruttoCent) || 0);
  const s = Number(satz) || 0;
  if (!s) return { brutto, steuer: 0, netto: brutto };
  const steuer = Math.round((brutto * s) / (100 + s));
  return { brutto, steuer, netto: brutto - steuer };
}

function einstellungen(firmaId) {
  let e = db.prepare("SELECT * FROM buch_einstellungen WHERE firma_id = ?").get(firmaId);
  if (!e) {
    db.prepare("INSERT INTO buch_einstellungen (firma_id) VALUES (?)").run(firmaId);
    e = db.prepare("SELECT * FROM buch_einstellungen WHERE firma_id = ?").get(firmaId);
  }
  return e;
}

/** Beginn des Wirtschaftsjahres, in dem ein Datum liegt. */
function wirtschaftsjahr(firmaId, datum) {
  const e = einstellungen(firmaId);
  const [monat, tag] = String(e.wj_beginn || "01-01").split("-");
  const jahr = Number(String(datum).slice(0, 4));
  const beginnImJahr = jahr + "-" + monat + "-" + tag;
  const beginn = String(datum) >= beginnImJahr ? beginnImJahr : (jahr - 1) + "-" + monat + "-" + tag;
  const ende = new Date(Date.UTC(Number(beginn.slice(0, 4)) + 1, Number(monat) - 1, Number(tag)));
  ende.setUTCDate(ende.getUTCDate() - 1);
  return { beginn, ende: ende.toISOString().slice(0, 10) };
}

/**
 * Bis zu welchem Tag ist alles abgeschlossen? Bis dahin darf nichts mehr
 * erfasst, geaendert oder storniert werden - der Steuerberater hat den
 * Zeitraum bereits verbucht.
 */
function abgeschlossenBis(firmaId) {
  const r = db.prepare("SELECT MAX(bis) AS bis FROM buch_exporte WHERE firma_id = ? AND endgueltig = 1")
    .get(firmaId);
  return r && r.bis ? r.bis : null;
}

function kontoLesen(firmaId, nummer) {
  return db.prepare("SELECT * FROM buch_konten WHERE firma_id = ? AND nummer = ?")
    .get(firmaId, String(nummer).trim());
}
function partnerNachKonto(firmaId, nummer) {
  return db.prepare("SELECT * FROM buch_partner WHERE firma_id = ? AND konto = ?")
    .get(firmaId, String(nummer).trim());
}

/**
 * Ein Konto auf der Buchungszeile: entweder ein Sachkonto aus dem
 * Kontenrahmen oder ein Personenkonto (Debitor/Kreditor).
 */
function kontoAufloesen(firmaId, nummer) {
  const n = String(nummer == null ? "" : nummer).trim();
  if (!/^\d{3,9}$/.test(n)) return null;
  const sach = kontoLesen(firmaId, n);
  if (sach) return { nummer: n, bezeichnung: sach.bezeichnung, art: sach.art,
    steuersatz: sach.steuersatz, automatik: !!sach.automatik, bu: sach.bu, geld: sach.geld, sach: true };
  const partner = partnerNachKonto(firmaId, n);
  if (partner) return { nummer: n, bezeichnung: partner.name, art: partner.typ === "Debitor" ? "Aktiv" : "Passiv",
    steuersatz: 0, automatik: false, bu: null, geld: null, sach: false, partner };
  return null;
}

/* ----------------------------------------------------------- Kontenrahmen */

/** Legt die Vorlage an, soweit die Nummern noch frei sind. Wiederholbar. */
function kontenVorlageAnlegen(firmaId, skr) {
  const vorlage = VORLAGEN[skr] || VORLAGEN["04"];
  const einfuegen = db.prepare(`INSERT INTO buch_konten
    (firma_id, nummer, bezeichnung, art, steuersatz, automatik, bu, geld) VALUES (?,?,?,?,?,?,?,?)`);
  let n = 0;
  for (const k of vorlage) {
    if (kontoLesen(firmaId, k.nummer)) continue;
    einfuegen.run(firmaId, k.nummer, k.bezeichnung, k.art, k.steuersatz || 0,
      k.automatik ? 1 : 0, k.bu || null, k.geld || null);
    n++;
  }
  return n;
}

function konten(sitzung) {
  fordereLesen(sitzung);
  return db.prepare("SELECT * FROM buch_konten WHERE firma_id = ? ORDER BY nummer").all(sitzung.firmaId)
    .map((k) => ({ id: k.id, nummer: k.nummer, bezeichnung: k.bezeichnung, art: k.art,
      steuersatz: k.steuersatz, automatik: !!k.automatik, bu: k.bu, geld: k.geld,
      aktiv: !!k.aktiv, notiz: k.notiz }));
}

function kontoSpeichern(sitzung, id, d) {
  fordereSchreiben(sitzung);
  const nummer = String(d.nummer || "").trim();
  if (!/^\d{3,9}$/.test(nummer)) throw new Verweigert("Die Kontonummer besteht nur aus Ziffern.", 400);
  if (!String(d.bezeichnung || "").trim()) throw new Verweigert("Bitte eine Bezeichnung angeben.", 400);
  if (!KONTOARTEN.includes(d.art)) throw new Verweigert("Unbekannte Kontoart.", 400);
  const satz = [0, 7, 19].includes(Number(d.steuersatz)) ? Number(d.steuersatz) : 0;

  const belegt = kontoLesen(sitzung.firmaId, nummer);
  if (belegt && (!id || String(belegt.id) !== String(id))) {
    throw new Verweigert("Die Kontonummer " + nummer + " ist bereits vergeben.", 409);
  }
  if (partnerNachKonto(sitzung.firmaId, nummer)) {
    throw new Verweigert("Die Nummer " + nummer + " gehört bereits zu einem Geschäftspartner.", 409);
  }

  if (id) {
    const alt = db.prepare("SELECT * FROM buch_konten WHERE id = ? AND firma_id = ?").get(id, sitzung.firmaId);
    if (!alt) throw new Verweigert("Konto nicht gefunden.", 404);
    // Eine bereits bebuchte Nummer darf sich nicht aendern - sonst zeigten
    // festgeschriebene Buchungen ins Leere.
    if (alt.nummer !== nummer && kontoBebucht(sitzung.firmaId, alt.nummer)) {
      throw new Verweigert("Auf " + alt.nummer + " wurde bereits gebucht. Die Nummer lässt sich nicht mehr ändern; " +
        "bitte das Konto stilllegen und ein neues anlegen.", 409);
    }
    db.prepare(`UPDATE buch_konten SET nummer=?, bezeichnung=?, art=?, steuersatz=?, automatik=?, bu=?, geld=?, aktiv=?, notiz=?
                WHERE id=? AND firma_id=?`)
      .run(nummer, String(d.bezeichnung).trim(), d.art, satz, d.automatik ? 1 : 0,
        w(d.bu), w(d.geld), d.aktiv === false ? 0 : 1, w(d.notiz), id, sitzung.firmaId);
    protokoll(sitzung, nummer, "Konto geändert", nummer + " " + d.bezeichnung);
    return json(200, { id });
  }
  const neu = db.prepare(`INSERT INTO buch_konten
    (firma_id, nummer, bezeichnung, art, steuersatz, automatik, bu, geld, notiz) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(sitzung.firmaId, nummer, String(d.bezeichnung).trim(), d.art, satz,
      d.automatik ? 1 : 0, w(d.bu), w(d.geld), w(d.notiz)).lastInsertRowid;
  protokoll(sitzung, nummer, "Konto angelegt", nummer + " " + d.bezeichnung);
  return json(201, { id: neu });
}

function kontoBebucht(firmaId, nummer) {
  return db.prepare("SELECT 1 FROM buch_belege WHERE firma_id = ? AND (soll_konto = ? OR haben_konto = ?) LIMIT 1")
    .get(firmaId, nummer, nummer) ? true : false;
}

function kontoEntfernen(sitzung, id) {
  fordereSchreiben(sitzung);
  const k = db.prepare("SELECT * FROM buch_konten WHERE id = ? AND firma_id = ?").get(id, sitzung.firmaId);
  if (!k) throw new Verweigert("Konto nicht gefunden.", 404);
  if (kontoBebucht(sitzung.firmaId, k.nummer)) {
    throw new Verweigert("Auf dieses Konto wurde bereits gebucht. Es lässt sich stilllegen, aber nicht löschen.", 409);
  }
  db.prepare("DELETE FROM buch_konten WHERE id = ?").run(id);
  protokoll(sitzung, k.nummer, "Konto gelöscht", k.nummer + " " + k.bezeichnung);
  return json(200, { ok: true });
}

/**
 * Eine Zeile einer Kontenliste zerlegen.
 *
 * Was hier tatsaechlich eingefuegt wird, kommt aus sehr verschiedenen Quellen:
 * einer CSV aus DATEV (Semikolon), einer Tabellenkalkulation (Tabulator) oder
 * einer aus einem PDF kopierten Summen- und Saldenliste. Im letzten Fall
 * trennen nur Leerzeichen, und hinter der Bezeichnung stehen noch die
 * Betragsspalten:
 *
 *   1600   Kasse                     0,00    1.070,00      238,00     832,00
 *
 * Deshalb wird nicht stur an einem Trennzeichen geschnitten, sondern von vorn
 * gelesen: eine Kontonummer am Zeilenanfang, dahinter die Bezeichnung, und was
 * am Ende wie ein Betrag aussieht, faellt weg. "Erloese 19 % USt" bleibt dabei
 * unversehrt - abgeschnitten wird nur, was ein Dezimalkomma mit zwei Stellen
 * hat.
 *
 * Rueckgabe null heisst: keine Kontozeile (Kopfzeile, Zwischensumme, Leerzeile).
 */
function kontenzeileZerlegen(zeile) {
  const roh = String(zeile).trim().replace(/^"|"$/g, "").trim();
  /*
   * Eine Kontonummer am Zeilenanfang - aber nur, wenn keine Zahl weitergeht.
   * Sonst laese "1.070,00" als Konto 1. Ein Komma ist dabei erlaubt, wenn es
   * trennt statt zu rechnen: "6530,Bueromaterial" ja, "1600,00" nein.
   *
   * Der Schraegstrich schliesst aus: Im Kopf jeder DATEV-Auswertung steht
   * "55555/10198/2026" - Berater, Mandant, Jahr. Ohne diese Ausnahme wuerde
   * daraus ein Konto 55555 namens "/10198/2026".
   */
  const beginn = /^(\d{3,9})(?![\d.\/]|,\d)/.exec(roh);
  if (!beginn) return null;
  const nummer = beginn[1];

  // Klare Trennzeichen: dann ist die Bezeichnung schlicht das zweite Feld.
  if (/[;\t]/.test(roh)) {
    const felder = roh.split(/[;\t]/).map((t) => t.trim().replace(/^"|"$/g, ""));
    const bezeichnung = (felder[1] || "").trim();
    if (!/\p{L}/u.test(bezeichnung)) return null;
    return { nummer, bezeichnung, art: KONTOARTEN.includes(felder[2]) ? felder[2] : null };
  }

  let rest = betraegeAbschneiden(roh.slice(nummer.length).replace(/^[\s,:|.\-]+/, ""));
  // Komma-getrennte Liste: dann endet die Bezeichnung am naechsten Komma,
  // sofern dahinter kein Betrag steht.
  if (!/\s/.test(roh.slice(nummer.length, nummer.length + 1)) && rest.includes(",") &&
      !/,\d{2}(\D|$)/.test(rest)) {
    rest = rest.split(",")[0].trim();
  }
  // Eine Kontobezeichnung enthaelt immer Buchstaben. Bleibt nur Satzzeichen
  // oder eine Zahl uebrig, war es keine Kontozeile.
  return /\p{L}/u.test(rest) ? { nummer, bezeichnung: rest, art: null } : null;
}

/** Betragsspalten am Zeilenende abraeumen, samt Soll-/Haben-Kennzeichen. */
function betraegeAbschneiden(text) {
  let rest = String(text), vorher;
  do {
    vorher = rest;
    rest = rest.replace(/[\s|]+-?\d{1,3}(?:\.\d{3})*,\d{2}\s*-?\s*[SH]?$/i, "").trim();
  } while (rest !== vorher);
  return rest.replace(/[\s|]+$/, "").trim();
}

/** Eine Zeile, die mit einem Betrag beginnt - also eine reine Wertezeile. */
const BETRAGSZEILE = /^\s*-?\d{1,3}(?:\.\d{3})*,\d{2}/;

/**
 * Ueber zwei Zeilen umbrochene Kontobezeichnungen zusammenfuehren.
 *
 * In einer BWA mit Wertenachweis ist die Namensspalte schmal. Passt eine
 * Bezeichnung nicht hinein, bricht sie um - und die Betraege stehen dann
 * dazwischen, weil sie senkrecht mittig sitzen:
 *
 *   6110  Gesetzliche Sozialaufwen-
 *         2.303,38   2.554,85   2.903,10   ...
 *   dungen
 *
 * Zeile fuer Zeile gelesen entstuende daraus "Gesetzliche Sozialaufwen-".
 * Deshalb wird vorher zusammengesetzt. Ein Trennstrich verschwindet dabei
 * ("Sozialaufwen-" + "dungen"), ausser die Fortsetzung beginnt mit "und" oder
 * "oder" - dann gehoert er zum Wort ("Hard-" + "und Software").
 *
 * Standen die Betraege dagegen schon auf der Kontozeile, ist die Bezeichnung
 * vollstaendig. Was darunter folgt, ist eine Zwischenueberschrift der
 * Auswertung ("Raumkosten", "Betriebliche Steuern") und gehoert nicht dazu.
 */
function umbruecheZusammenfuehren(zeilen) {
  const raus = [];
  for (let i = 0; i < zeilen.length; i++) {
    const zeile = String(zeilen[i]).trim();
    const m = /^(\d{3,9})\s+(.+)$/.exec(zeile);
    if (!m) { raus.push(zeile); continue; }

    const rest = m[2].trim();
    const ohneBetraege = betraegeAbschneiden(rest);
    const naechste = (zeilen[i + 1] || "").trim();
    const uebernaechste = (zeilen[i + 2] || "").trim();
    if (ohneBetraege !== rest || !BETRAGSZEILE.test(naechste) ||
        !uebernaechste || /^\d{3,9}\s/.test(uebernaechste) || BETRAGSZEILE.test(uebernaechste)) {
      raus.push(zeile);
      continue;
    }
    const bezeichnung = ohneBetraege.endsWith("-") && !/^(und|oder|bzw)\b/i.test(uebernaechste)
      ? ohneBetraege.slice(0, -1) + uebernaechste
      : ohneBetraege + " " + uebernaechste;
    raus.push(m[1] + " " + bezeichnung);
    i += 2;   // Betragszeile und Fortsetzung sind damit erledigt
  }
  return raus;
}

/**
 * Kontenliste des Steuerberaters einlesen.
 *
 * Geeignet ist alles, worin je Zeile eine Kontonummer mit ihrer Bezeichnung
 * steht - am besten die Summen- und Saldenliste oder die Sachkontenliste der
 * Kanzlei. Eine gewoehnliche BWA taugt dafuer nicht: Sie fasst zu Positionen
 * wie "Raumkosten" zusammen und nennt gar keine Kontonummern. Erkennt die
 * Funktion deshalb keine einzige Zeile, sagt sie das ausdruecklich, statt
 * wortlos nichts zu tun.
 *
 * Vorhandene Konten werden in der Bezeichnung aktualisiert, nie geloescht.
 */
function kontenEinlesen(sitzung, text) {
  fordereSchreiben(sitzung);
  const roh = String(text || "").split(/\r?\n/).filter((z) => z.trim());
  if (!roh.length) throw new Verweigert("Die Liste ist leer.", 400);
  const zeilen = umbruecheZusammenfuehren(roh);

  const bilanz = { neu: 0, aktualisiert: 0, uebersprungen: 0, meldungen: [] };
  const einfuegen = db.prepare(`INSERT INTO buch_konten (firma_id, nummer, bezeichnung, art, steuersatz)
                                VALUES (?,?,?,?,?)`);
  const aendern = db.prepare("UPDATE buch_konten SET bezeichnung = ? WHERE firma_id = ? AND nummer = ?");

  db.exec("BEGIN");
  try {
    for (const [n, zeile] of zeilen.entries()) {
      const gelesen = kontenzeileZerlegen(zeile);
      if (!gelesen) {
        // Kopfzeilen und Zwischensummen stillschweigend uebergehen, alles
        // andere benennen - damit niemand glaubt, es sei alles drin.
        if (n > 0 && zeile.trim()) bilanz.meldungen.push("Zeile " + (n + 1) + " übersprungen: " + zeile.trim().slice(0, 60));
        bilanz.uebersprungen++;
        continue;
      }
      const { nummer, bezeichnung } = gelesen;
      // Eine Nummer, die bereits zu einem Kunden oder Lieferanten gehoert,
      // darf nicht zum Sachkonto werden.
      if (partnerNachKonto(sitzung.firmaId, nummer)) { bilanz.uebersprungen++; continue; }
      const art = gelesen.art || artRaten(nummer, einstellungen(sitzung.firmaId).skr);
      if (kontoLesen(sitzung.firmaId, nummer)) {
        aendern.run(bezeichnung.slice(0, 80), sitzung.firmaId, nummer);
        bilanz.aktualisiert++;
      } else {
        einfuegen.run(sitzung.firmaId, nummer, bezeichnung.slice(0, 80), art, 0);
        bilanz.neu++;
      }
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }

  protokoll(sitzung, "Kontenrahmen", "Kontenliste eingelesen",
    bilanz.neu + " neu, " + bilanz.aktualisiert + " aktualisiert, " + bilanz.uebersprungen + " übersprungen.");
  if (bilanz.meldungen.length > 12) {
    bilanz.meldungen = bilanz.meldungen.slice(0, 12).concat(["… weitere Zeilen übersprungen."]);
  }
  // Nichts erkannt heisst fast immer: das falsche Dokument. Am haeufigsten
  // eine BWA - die fasst zu Positionen zusammen und fuehrt keine Konten.
  if (!bilanz.neu && !bilanz.aktualisiert) {
    bilanz.hinweis = "Keine einzige Zeile begann mit einer Kontonummer. Eine BWA enthält keine " +
      "Kontonummern — sie fasst zu Positionen wie „Raumkosten“ zusammen. Geeignet sind die " +
      "Summen- und Saldenliste oder die Sachkontenliste der Kanzlei; beide führen jedes Konto " +
      "einzeln mit Nummer auf.";
  }
  return json(200, bilanz);
}

/**
 * Kontoart aus der Nummer ableiten. Nur ein Vorschlag fuer eingelesene
 * Listen - die Kontenklasse sagt im Kontenrahmen, worum es sich handelt.
 */
function artRaten(nummer, skr) {
  const k = Number(String(nummer)[0]);
  if (skr === "03") {
    if (k === 0) return "Aktiv";
    if (k === 1) return "Aktiv";
    if (k === 2) return "Aufwand";
    if (k === 3) return "Aufwand";
    if (k === 4) return "Aufwand";
    if (k === 8) return "Ertrag";
    return "Aktiv";
  }
  if (k === 0 || k === 1) return "Aktiv";
  if (k === 2 || k === 3) return "Passiv";
  if (k === 4) return "Ertrag";
  if (k === 5 || k === 6) return "Aufwand";
  if (k === 7) return "Aufwand";
  return "Aktiv";
}

/* ------------------------------------------------------ Geschäftspartner */

function partner(sitzung) {
  fordereLesen(sitzung);
  return db.prepare(`SELECT p.*, o.name AS org_name, pe.name AS person_name
                       FROM buch_partner p
                       LEFT JOIN organisationen o ON o.id = p.organisation_id
                       LEFT JOIN personen pe ON pe.id = p.person_id
                      WHERE p.firma_id = ? ORDER BY p.typ, p.konto`).all(sitzung.firmaId)
    .map((p) => ({ id: p.id, typ: p.typ, konto: p.konto, name: p.name,
      personId: p.person_id, organisationId: p.organisation_id, verknuepft: p.org_name || p.person_name || null,
      ustid: p.ustid, steuernummer: p.steuernummer, strasse: p.strasse, plz: p.plz, ort: p.ort,
      land: p.land, iban: p.iban, notiz: p.notiz, verbraucher: !!p.verbraucher, aktiv: !!p.aktiv }));
}

/** Naechste freie Nummer im Kreis des jeweiligen Typs. */
function naechsteKontonummer(firmaId, typ) {
  const kreis = personenkonten(einstellungen(firmaId).sachkontenlaenge)[typ === "Kreditor" ? "kreditor" : "debitor"];
  const belegt = db.prepare(`SELECT konto FROM buch_partner
                              WHERE firma_id = ? AND CAST(konto AS INTEGER) BETWEEN ? AND ?
                              ORDER BY CAST(konto AS INTEGER) DESC LIMIT 1`)
    .get(firmaId, kreis.von, kreis.bis);
  const naechste = belegt ? Number(belegt.konto) + 1 : kreis.von;
  return naechste > kreis.bis ? null : String(naechste);
}

function partnerSpeichern(sitzung, id, d) {
  fordereSchreiben(sitzung);
  const typ = d.typ === "Kreditor" ? "Kreditor" : "Debitor";
  const name = String(d.name || "").trim();
  if (!name) throw new Verweigert("Bitte einen Namen angeben.", 400);

  const konto = String(d.konto || "").trim() || naechsteKontonummer(sitzung.firmaId, typ);
  if (!konto) throw new Verweigert("Der Nummernkreis für " + typ + "en ist erschöpft.", 409);
  if (!/^\d{3,9}$/.test(konto)) throw new Verweigert("Die Kontonummer besteht nur aus Ziffern.", 400);

  const kreis = personenkonten(einstellungen(sitzung.firmaId).sachkontenlaenge)[typ === "Kreditor" ? "kreditor" : "debitor"];
  const zahl = Number(konto);
  if (zahl < kreis.von || zahl > kreis.bis) {
    throw new Verweigert(typ + "en liegen im Nummernkreis " + kreis.von + " bis " + kreis.bis + ".", 400);
  }
  if (kontoLesen(sitzung.firmaId, konto)) {
    throw new Verweigert("Die Nummer " + konto + " ist bereits ein Sachkonto.", 409);
  }
  const belegt = partnerNachKonto(sitzung.firmaId, konto);
  if (belegt && (!id || String(belegt.id) !== String(id))) {
    throw new Verweigert("Die Kontonummer " + konto + " ist bereits vergeben.", 409);
  }

  /*
   * Verbraucher oder nicht. Das entscheidet im Mahnwesen ueber den
   * Verzugszinssatz (§ 288 BGB: fuenf oder neun Punkte ueber dem
   * Basiszinssatz). Krankenkassen und Firmen sind keine Verbraucher,
   * Selbstzahler schon - deshalb ist es ein Feld und keine Annahme.
   */
  const felder = [name, typ, konto, w(d.personId) || null, w(d.organisationId) || null, w(d.ustid),
    w(d.steuernummer), w(d.strasse), w(d.plz), w(d.ort), w(d.land), w(d.iban), w(d.notiz),
    d.verbraucher ? 1 : 0, d.aktiv === false ? 0 : 1];

  if (id) {
    const alt = db.prepare("SELECT * FROM buch_partner WHERE id = ? AND firma_id = ?").get(id, sitzung.firmaId);
    if (!alt) throw new Verweigert("Geschäftspartner nicht gefunden.", 404);
    if (alt.konto !== konto && kontoBebucht(sitzung.firmaId, alt.konto)) {
      throw new Verweigert("Auf " + alt.konto + " wurde bereits gebucht. Die Nummer lässt sich nicht mehr ändern.", 409);
    }
    db.prepare(`UPDATE buch_partner SET name=?, typ=?, konto=?, person_id=?, organisation_id=?, ustid=?,
                steuernummer=?, strasse=?, plz=?, ort=?, land=?, iban=?, notiz=?, verbraucher=?, aktiv=?
                WHERE id=? AND firma_id=?`)
      .run(...felder, id, sitzung.firmaId);
    protokoll(sitzung, konto, "Geschäftspartner geändert", konto + " " + name);
    return json(200, { id, konto });
  }
  const neu = db.prepare(`INSERT INTO buch_partner
    (name, typ, konto, person_id, organisation_id, ustid, steuernummer, strasse, plz, ort, land, iban, notiz,
     verbraucher, aktiv, firma_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...felder, sitzung.firmaId).lastInsertRowid;
  protokoll(sitzung, konto, "Geschäftspartner angelegt", typ + " " + konto + " " + name);
  return json(201, { id: neu, konto });
}

/* ---------------------------------------------------------------- Belege */

function belegNachAussen(b) {
  return { id: b.id, journalNr: b.journal_nr, belegnummer: b.belegnummer, art: b.art,
    datum: b.datum, leistungsdatum: b.leistungsdatum, faelligAm: b.faellig_am,
    partnerId: b.partner_id, partner: b.partner_name || null,
    sollKonto: b.soll_konto, habenKonto: b.haben_konto,
    sollText: b.soll_text || null, habenText: b.haben_text || null,
    bruttoCent: b.brutto_cent, steuersatz: b.steuersatz, steuerCent: b.steuer_cent, nettoCent: b.netto_cent,
    bu: b.bu, buchungstext: b.buchungstext, kost1: b.kost1, kost2: b.kost2,
    dokumentId: b.dokument_id, dokument: b.dokument_name || null,
    stornoVon: b.storno_von, storniertDurch: b.storniert_durch,
    exportId: b.export_id, festgeschrieben: !!b.festgeschrieben,
    notiz: b.notiz, angelegtAm: b.angelegt_am, angelegtVon: b.angelegt_von, geaendertAm: b.geaendert_am };
}

const BELEG_ABFRAGE = `
  SELECT b.*, p.name AS partner_name, d.dateiname AS dokument_name,
         ks.bezeichnung AS soll_text, kh.bezeichnung AS haben_text
    FROM buch_belege b
    LEFT JOIN buch_partner p ON p.id = b.partner_id
    LEFT JOIN dokumente d    ON d.id = b.dokument_id
    LEFT JOIN buch_konten ks ON ks.firma_id = b.firma_id AND ks.nummer = b.soll_konto
    LEFT JOIN buch_konten kh ON kh.firma_id = b.firma_id AND kh.nummer = b.haben_konto`;

function belege(sitzung, von, bis) {
  fordereLesen(sitzung);
  const bedingungen = ["b.firma_id = ?"];
  const werte = [sitzung.firmaId];
  if (istDatum(von)) { bedingungen.push("b.datum >= ?"); werte.push(von); }
  if (istDatum(bis)) { bedingungen.push("b.datum <= ?"); werte.push(bis); }
  return db.prepare(BELEG_ABFRAGE + " WHERE " + bedingungen.join(" AND ") + " ORDER BY b.datum DESC, b.journal_nr DESC")
    .all(...werte).map(belegNachAussen);
}

/** Prueft die Angaben eines Beleges und rechnet die Steuer aus. */
function belegPruefenUndRechnen(sitzung, d) {
  const firmaId = sitzung.firmaId;
  if (!ZAHLARTEN.includes(d.art)) throw new Verweigert("Unbekannte Belegart.", 400);
  if (!istDatum(d.datum)) throw new Verweigert("Bitte ein gültiges Belegdatum angeben.", 400);
  if (d.leistungsdatum && !istDatum(d.leistungsdatum)) throw new Verweigert("Ungültiges Leistungsdatum.", 400);
  if (d.faelligAm && !istDatum(d.faelligAm)) throw new Verweigert("Ungültiges Fälligkeitsdatum.", 400);

  const belegnummer = String(d.belegnummer || "").trim();
  if (!belegnummer) throw new Verweigert("Bitte eine Belegnummer angeben.", 400);
  const buchungstext = String(d.buchungstext || "").trim();
  if (!buchungstext) throw new Verweigert("Bitte einen Buchungstext angeben — er erklärt dem Steuerberater den Vorgang.", 400);

  const brutto = Math.round(Number(d.bruttoCent));
  if (!Number.isFinite(brutto) || brutto <= 0) throw new Verweigert("Der Betrag muss größer als null sein.", 400);
  if (brutto > 99999999999) throw new Verweigert("Der Betrag ist unplausibel hoch.", 400);

  const soll = kontoAufloesen(firmaId, d.sollKonto);
  const haben = kontoAufloesen(firmaId, d.habenKonto);
  if (!soll) throw new Verweigert("Das Sollkonto " + (d.sollKonto || "") + " gibt es nicht.", 400);
  if (!haben) throw new Verweigert("Das Habenkonto " + (d.habenKonto || "") + " gibt es nicht.", 400);
  if (soll.nummer === haben.nummer) throw new Verweigert("Soll- und Habenkonto müssen verschieden sein.", 400);

  const satz = [0, 7, 19].includes(Number(d.steuersatz)) ? Number(d.steuersatz) : 0;
  const teile = aufteilen(brutto, satz);

  /*
   * Steuerschluessel. Rechnet eines der beiden Konten in DATEV die Steuer
   * selbst (Automatikkonto), darf keiner mitgegeben werden - DATEV meldete
   * sonst einen ueberschriebenen Automatikwert und der Steuerberater muesste
   * jede Zeile einzeln pruefen.
   */
  const automatik = (soll.automatik && soll.steuersatz === satz) || (haben.automatik && haben.steuersatz === satz);
  let bu = String(d.bu == null ? "" : d.bu).trim();
  if (automatik) bu = "";
  else if (!bu && satz) bu = (soll.art === "Aufwand" || haben.art === "Aufwand")
    ? (satz === 7 ? "8" : "9") : (satz === 7 ? "2" : "3");
  if (bu && !/^\d{1,4}$/.test(bu)) throw new Verweigert("Der Steuerschlüssel besteht nur aus Ziffern.", 400);

  const partnerId = d.partnerId ? Number(d.partnerId) : null;
  if (partnerId) {
    const p = db.prepare("SELECT id FROM buch_partner WHERE id = ? AND firma_id = ?").get(partnerId, firmaId);
    if (!p) throw new Verweigert("Unbekannter Geschäftspartner.", 404);
  }
  const dokumentId = d.dokumentId ? Number(d.dokumentId) : null;
  if (dokumentId) {
    const dok = db.prepare("SELECT id FROM dokumente WHERE id = ? AND firma_id = ?").get(dokumentId, firmaId);
    if (!dok) throw new Verweigert("Das angehängte Dokument gibt es nicht.", 404);
  }

  return { belegnummer, buchungstext, brutto, satz, teile, bu, soll, haben, partnerId, dokumentId,
    art: d.art, datum: d.datum, leistungsdatum: w(d.leistungsdatum), faelligAm: w(d.faelligAm),
    kost1: w(d.kost1), kost2: w(d.kost2), notiz: w(d.notiz), automatik };
}

/** Weist zurueck, was in einen bereits uebergebenen Zeitraum fallen wuerde. */
function fordereOffen(firmaId, datum) {
  const grenze = abgeschlossenBis(firmaId);
  if (grenze && String(datum) <= grenze) {
    throw new Verweigert("Der Zeitraum bis " + grenze + " wurde bereits endgültig an den Steuerberater übergeben " +
      "und ist festgeschrieben. Bitte den Beleg mit aktuellem Datum erfassen oder mit der Kanzlei klären.", 409);
  }
}

function belegSpeichern(sitzung, id, d) {
  fordereSchreiben(sitzung);
  const g = belegPruefenUndRechnen(sitzung, d);

  if (id) {
    const alt = db.prepare("SELECT * FROM buch_belege WHERE id = ? AND firma_id = ?").get(id, sitzung.firmaId);
    if (!alt) throw new Verweigert("Beleg nicht gefunden.", 404);
    if (alt.festgeschrieben) {
      throw new Verweigert("Dieser Beleg ist festgeschrieben und lässt sich nicht mehr ändern. " +
        "Er kann nur storniert und neu erfasst werden.", 409);
    }
    if (alt.storno_von || alt.storniert_durch) {
      throw new Verweigert("Stornobuchungen und stornierte Belege bleiben unverändert stehen.", 409);
    }
    fordereOffen(sitzung.firmaId, alt.datum);
    fordereOffen(sitzung.firmaId, g.datum);
    db.prepare(`UPDATE buch_belege SET belegnummer=?, art=?, datum=?, leistungsdatum=?, faellig_am=?,
        partner_id=?, soll_konto=?, haben_konto=?, brutto_cent=?, steuersatz=?, steuer_cent=?, netto_cent=?,
        bu=?, buchungstext=?, kost1=?, kost2=?, dokument_id=?, notiz=?, geaendert_am=datetime('now')
      WHERE id=? AND firma_id=?`)
      .run(g.belegnummer, g.art, g.datum, g.leistungsdatum, g.faelligAm, g.partnerId,
        g.soll.nummer, g.haben.nummer, g.brutto, g.satz, g.teile.steuer, g.teile.netto,
        g.bu || null, g.buchungstext, g.kost1, g.kost2, g.dokumentId, g.notiz, id, sitzung.firmaId);
    protokoll(sitzung, alt.journal_nr, "Beleg geändert",
      "Nr. " + alt.journal_nr + ", " + g.belegnummer + ", " + (g.brutto / 100).toFixed(2) + " EUR.");
    return json(200, { id, journalNr: alt.journal_nr });
  }

  fordereOffen(sitzung.firmaId, g.datum);
  const neu = belegEinfuegen(sitzung, g, {});
  protokoll(sitzung, neu.journalNr, "Beleg erfasst",
    "Nr. " + neu.journalNr + ", " + g.belegnummer + ", " + (g.brutto / 100).toFixed(2) + " EUR, " +
    g.soll.nummer + " an " + g.haben.nummer + ".");
  return json(201, neu);
}

/**
 * Schreibt einen Beleg mit der naechsten Journalnummer.
 *
 * Nummernvergabe und Einfuegen laufen in einem Zug, damit keine Nummer
 * doppelt vergeben wird und keine Luecke entsteht.
 */
function belegEinfuegen(sitzung, g, zusatz) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const max = db.prepare("SELECT COALESCE(MAX(journal_nr), 0) AS n FROM buch_belege WHERE firma_id = ?")
      .get(sitzung.firmaId).n;
    const nr = max + 1;
    const id = db.prepare(`INSERT INTO buch_belege
      (firma_id, journal_nr, belegnummer, art, datum, leistungsdatum, faellig_am, partner_id,
       soll_konto, haben_konto, brutto_cent, steuersatz, steuer_cent, netto_cent, bu, buchungstext,
       kost1, kost2, dokument_id, storno_von, notiz, angelegt_von)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(sitzung.firmaId, nr, g.belegnummer, g.art, g.datum, g.leistungsdatum, g.faelligAm, g.partnerId,
        g.soll.nummer, g.haben.nummer, g.brutto, g.satz, g.teile.steuer, g.teile.netto, g.bu || null,
        g.buchungstext, g.kost1, g.kost2, g.dokumentId, zusatz.stornoVon || null, g.notiz,
        sitzung.anmeldename).lastInsertRowid;
    db.exec("COMMIT");
    return { id, journalNr: nr };
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}

/**
 * Stornieren statt loeschen.
 *
 * Eine einmal erfasste Buchung verschwindet nicht mehr - das verlangt die
 * Nachvollziehbarkeit. Stattdessen entsteht eine zweite Buchung mit
 * vertauschten Konten, die die erste aufhebt. Beide bleiben sichtbar, und der
 * Steuerberater sieht, was geschehen ist.
 */
function belegStornieren(sitzung, id, grund) {
  fordereSchreiben(sitzung);
  const alt = db.prepare("SELECT * FROM buch_belege WHERE id = ? AND firma_id = ?").get(id, sitzung.firmaId);
  if (!alt) throw new Verweigert("Beleg nicht gefunden.", 404);
  if (alt.storniert_durch) throw new Verweigert("Dieser Beleg wurde bereits storniert.", 409);
  if (alt.storno_von) throw new Verweigert("Eine Stornobuchung lässt sich nicht erneut stornieren.", 409);

  // Das Storno bekommt das heutige Datum, wenn der ursprüngliche Zeitraum
  // bereits übergeben ist - rückwirkend zu buchen wäre dort nicht zulässig.
  const grenze = abgeschlossenBis(sitzung.firmaId);
  const heute = new Date().toISOString().slice(0, 10);
  const datum = grenze && alt.datum <= grenze ? heute : alt.datum;
  if (grenze && datum <= grenze) {
    throw new Verweigert("Auch heute liegt noch im festgeschriebenen Zeitraum. Bitte mit der Kanzlei klären.", 409);
  }

  const g = {
    belegnummer: String(alt.belegnummer).slice(0, 30), art: alt.art, datum,
    leistungsdatum: alt.leistungsdatum, faelligAm: null, partnerId: alt.partner_id,
    // Vertauschte Konten heben die urspruengliche Buchung auf.
    soll: { nummer: alt.haben_konto }, haben: { nummer: alt.soll_konto },
    brutto: alt.brutto_cent, satz: alt.steuersatz,
    teile: { steuer: alt.steuer_cent, netto: alt.netto_cent },
    bu: alt.bu, kost1: alt.kost1, kost2: alt.kost2, dokumentId: alt.dokument_id,
    buchungstext: ("Storno Nr. " + alt.journal_nr + ": " + (grund || alt.buchungstext)).slice(0, 60),
    notiz: grund ? "Stornogrund: " + grund : null,
  };
  const neu = belegEinfuegen(sitzung, g, { stornoVon: alt.id });
  db.prepare("UPDATE buch_belege SET storniert_durch = ? WHERE id = ?").run(neu.id, alt.id);

  protokoll(sitzung, alt.journal_nr, "Beleg storniert",
    "Nr. " + alt.journal_nr + " durch Nr. " + neu.journalNr + (grund ? ". Grund: " + grund : "."));
  return json(201, neu);
}

/**
 * Ablage der Belegdateien.
 *
 * Der Scan einer Rechnung gehoert in dieselbe Dokumentenverwaltung wie alles
 * andere - dieselbe Versionierung, dieselben Zugriffsrechte, dieselbe
 * Sicherung. Die Buchhaltung legt dafuer nur die passende Kategorie an und
 * merkt sich, welches Dokument zu welcher Buchung gehoert.
 */
const BELEG_ORDNER = {
  Ausgangsrechnung: "Ausgangsrechnungen",
  Eingangsrechnung: "Eingangsrechnungen",
  Kasseneinnahme: "Kassenbelege",
  Kassenausgabe: "Kassenbelege",
  Zahlungseingang: "Bankunterlagen",
  Zahlungsausgang: "Bankunterlagen",
  Sonstiges: "Steuerunterlagen",
};

function belegKategorie(firmaId, art) {
  const pfad = "Buchhaltung/" + (BELEG_ORDNER[art] || "Steuerunterlagen");
  const vorhanden = db.prepare("SELECT * FROM kategorien WHERE firma_id = ? AND pfad = ?").get(firmaId, pfad);
  if (vorhanden) return vorhanden;

  let eltern = db.prepare("SELECT * FROM kategorien WHERE firma_id = ? AND pfad = 'Buchhaltung'").get(firmaId);
  if (!eltern) {
    const id = db.prepare(`INSERT INTO kategorien (firma_id, eltern_id, titel, bereich, pfad, sortierung)
                           VALUES (?,?,?,?,?,?)`).run(firmaId, null, "Buchhaltung", "Buchhaltung", "Buchhaltung", 50).lastInsertRowid;
    eltern = db.prepare("SELECT * FROM kategorien WHERE id = ?").get(id);
  }
  const titel = pfad.split("/")[1];
  const id = db.prepare(`INSERT INTO kategorien (firma_id, eltern_id, titel, bereich, pfad, sortierung)
                         VALUES (?,?,?,?,?,?)`).run(firmaId, eltern.id, titel, "Buchhaltung", pfad, 50).lastInsertRowid;
  return db.prepare("SELECT * FROM kategorien WHERE id = ?").get(id);
}

/** Haengt eine hochgeladene Datei als Beleg an eine Buchung. */
function belegDatei(sitzung, belegId, datei) {
  fordereSchreiben(sitzung);
  const b = db.prepare("SELECT * FROM buch_belege WHERE id = ? AND firma_id = ?").get(belegId, sitzung.firmaId);
  if (!b) throw new Verweigert("Beleg nicht gefunden.", 404);
  if (b.festgeschrieben) {
    throw new Verweigert("Dieser Beleg wurde bereits übergeben und festgeschrieben. Die Datei lässt sich " +
      "nicht mehr nachtragen — bitte der Kanzlei gesondert zusenden.", 409);
  }
  const kategorie = belegKategorie(sitzung.firmaId, b.art);
  // Der Weg geht bewusst ueber die Dokumentenverwaltung und nicht an ihr
  // vorbei: sonst faenden sich Belege nicht dort, wo alle Unterlagen liegen.
  const api = require("./api");
  const ergebnis = api.dokumentHochladen(sitzung, {
    kategorieId: kategorie.id,
    notiz: "Beleg zu Buchung Nr. " + b.journal_nr + " (" + b.belegnummer + ")",
    gueltigAb: b.datum,
  }, datei);
  db.prepare("UPDATE buch_belege SET dokument_id = ?, geaendert_am = datetime('now') WHERE id = ?")
    .run(ergebnis.koerper.id, belegId);
  protokoll(sitzung, b.journal_nr, "Beleg hinterlegt",
    "Datei \"" + datei.name + "\" zu Buchung Nr. " + b.journal_nr + ".");
  return json(201, { dokumentId: ergebnis.koerper.id, kategorie: kategorie.pfad });
}

/* ----------------------------------------------------------- Auswertungen */

/** Summen eines Zeitraums, aufgeteilt nach Steuersaetzen. */
function umsatzsteuer(sitzung, von, bis) {
  fordereLesen(sitzung);
  const zeilen = db.prepare(`
    SELECT b.*, ks.art AS soll_art, kh.art AS haben_art
      FROM buch_belege b
      LEFT JOIN buch_konten ks ON ks.firma_id = b.firma_id AND ks.nummer = b.soll_konto
      LEFT JOIN buch_konten kh ON kh.firma_id = b.firma_id AND kh.nummer = b.haben_konto
     WHERE b.firma_id = ? AND b.datum BETWEEN ? AND ?`).all(sitzung.firmaId, von, bis);

  const leer = () => ({ netto: 0, steuer: 0, brutto: 0, anzahl: 0 });
  const e = { erloese: { 19: leer(), 7: leer(), 0: leer() }, vorsteuer: { 19: leer(), 7: leer(), 0: leer() },
    sonstige: leer() };

  for (const b of zeilen) {
    // Ein Storno zieht denselben Betrag wieder ab.
    const richtung = b.storno_von ? -1 : 1;
    const ertrag = b.soll_art === "Ertrag" || b.haben_art === "Ertrag";
    const aufwand = b.soll_art === "Aufwand" || b.haben_art === "Aufwand";
    const ziel = ertrag ? e.erloese[b.steuersatz] : aufwand ? e.vorsteuer[b.steuersatz] : e.sonstige;
    if (!ziel) continue;
    ziel.netto += richtung * b.netto_cent;
    ziel.steuer += richtung * b.steuer_cent;
    ziel.brutto += richtung * b.brutto_cent;
    ziel.anzahl += richtung;
  }

  const ust = e.erloese[19].steuer + e.erloese[7].steuer;
  const vst = e.vorsteuer[19].steuer + e.vorsteuer[7].steuer;
  return {
    von, bis, erloese: e.erloese, vorsteuer: e.vorsteuer, sonstige: e.sonstige,
    // Die Kennzahlen der Umsatzsteuer-Voranmeldung, damit sich die Zahlen mit
    // der Anmeldung der Kanzlei vergleichen lassen.
    kennzahlen: { 81: e.erloese[19].netto, 86: e.erloese[7].netto, 48: e.erloese[0].netto,
      66: vst, 83: ust - vst },
    umsatzsteuer: ust, vorsteuerSumme: vst, zahllast: ust - vst,
    ustArt: einstellungen(sitzung.firmaId).ust_art || "steuerpflichtig",
  };
}

/**
 * Kassenbuch mit fortlaufendem Bestand.
 *
 * Der Bestand darf nie negativ werden - man kann nicht mehr Bargeld ausgeben,
 * als in der Kasse liegt. Ein negativer Bestand ist deshalb kein Schoenheits-
 * fehler, sondern ein Hinweis auf eine fehlende oder falsche Buchung, den die
 * Betriebspruefung zuerst sucht.
 */
function kassenbuch(sitzung, von, bis) {
  fordereLesen(sitzung);
  const kassen = db.prepare("SELECT nummer FROM buch_konten WHERE firma_id = ? AND geld = 'Kasse'")
    .all(sitzung.firmaId).map((k) => k.nummer);
  if (!kassen.length) return { konten: [], zeilen: [], anfang: 0, ende: 0, negativAb: null };

  const platzhalter = kassen.map(() => "?").join(",");
  const alle = db.prepare(`${BELEG_ABFRAGE}
     WHERE b.firma_id = ? AND (b.soll_konto IN (${platzhalter}) OR b.haben_konto IN (${platzhalter}))
     ORDER BY b.datum, b.journal_nr`).all(sitzung.firmaId, ...kassen, ...kassen);

  // negativSeit merkt sich, seit wann der Bestand ununterbrochen unter null
  // liegt. Beginnt der Zeitraum schon mit negativem Bestand, gilt die Warnung
  // auch hier - sonst verschwaende sie, sobald man den Zeitraum hinter den
  // Fehler legt.
  let bestand = 0, anfang = 0, negativSeit = null, vorherNegativSeit = null, negativAb = null;
  const zeilen = [];
  for (const b of alle) {
    if (istDatum(bis) && b.datum > bis) break;
    const ein = kassen.includes(b.soll_konto);
    const betrag = ein ? b.brutto_cent : -b.brutto_cent;
    bestand += betrag;
    if (bestand < 0) negativSeit = negativSeit || b.datum; else negativSeit = null;
    if (istDatum(von) && b.datum < von) { anfang = bestand; vorherNegativSeit = negativSeit; continue; }
    if (bestand < 0 && !negativAb) negativAb = negativSeit;
    zeilen.push(Object.assign(belegNachAussen(b), { einaus: betrag, bestand }));
  }
  if (anfang < 0) negativAb = vorherNegativSeit;
  return { konten: kassen, zeilen, anfang, ende: bestand, negativAb };
}

/** Kennzahlen fuer die Uebersicht. */
function uebersicht(sitzung, von, bis) {
  fordereLesen(sitzung);
  const f = sitzung.firmaId;
  const z = db.prepare(`
    SELECT COUNT(*) AS anzahl,
           SUM(CASE WHEN dokument_id IS NULL AND storno_von IS NULL THEN 1 ELSE 0 END) AS ohne_beleg,
           SUM(CASE WHEN festgeschrieben = 1 THEN 1 ELSE 0 END) AS festgeschrieben,
           SUM(CASE WHEN export_id IS NULL AND storniert_durch IS NULL THEN 1 ELSE 0 END) AS offen
      FROM buch_belege WHERE firma_id = ? AND datum BETWEEN ? AND ?`).get(f, von, bis);
  const st = umsatzsteuer(sitzung, von, bis);
  const kasse = kassenbuch(sitzung, von, bis);
  const e = einstellungen(f);
  return {
    von, bis,
    anzahl: z.anzahl || 0, ohneBeleg: z.ohne_beleg || 0,
    festgeschrieben: z.festgeschrieben || 0, offen: z.offen || 0,
    erloese: st.erloese[19].netto + st.erloese[7].netto + st.erloese[0].netto,
    aufwand: st.vorsteuer[19].netto + st.vorsteuer[7].netto + st.vorsteuer[0].netto,
    umsatzsteuer: st.umsatzsteuer, vorsteuer: st.vorsteuerSumme, zahllast: st.zahllast,
    kassenbestand: kasse.ende, kasseNegativAb: kasse.negativAb,
    abgeschlossenBis: abgeschlossenBis(f),
    kontenBestaetigtAm: e.konten_bestaetigt_am,
    kontenAnzahl: db.prepare("SELECT COUNT(*) n FROM buch_konten WHERE firma_id = ?").get(f).n,
    letzterExport: db.prepare(`SELECT kennung, bis, erstellt_am, endgueltig FROM buch_exporte
                                WHERE firma_id = ? ORDER BY id DESC LIMIT 1`).get(f) || null,
  };
}

/**
 * Plausibilitaetspruefung vor der Uebergabe.
 *
 * Findet, was dem Steuerberater sonst als Rueckfrage zurueckkaeme - und was
 * eine Betriebspruefung als Erstes ansieht.
 */
function pruefung(sitzung, von, bis) {
  fordereLesen(sitzung);
  const liste = db.prepare(`${BELEG_ABFRAGE}
     WHERE b.firma_id = ? AND b.datum BETWEEN ? AND ? ORDER BY b.journal_nr`)
    .all(sitzung.firmaId, von, bis);
  const befunde = [];

  const ohneBeleg = liste.filter((b) => !b.dokument_id && !b.storno_von);
  if (ohneBeleg.length) {
    befunde.push({ schwere: "hinweis", titel: "Belege ohne hinterlegte Datei",
      text: ohneBeleg.length + " Buchung(en) ohne Rechnung oder Quittung. Ohne Beleg keine Buchung — " +
        "die Unterlagen sollten spätestens bei der Übergabe vorliegen.",
      nummern: ohneBeleg.map((b) => b.journal_nr).slice(0, 30) });
  }

  const doppelt = new Map();
  for (const b of liste) {
    if (b.storno_von) continue;
    const s = b.belegnummer.toLowerCase();
    doppelt.set(s, (doppelt.get(s) || 0) + 1);
  }
  const mehrfach = [...doppelt.entries()].filter(([, n]) => n > 1).map(([s]) => s);
  if (mehrfach.length) {
    befunde.push({ schwere: "warnung", titel: "Belegnummern mehrfach vergeben",
      text: "Dieselbe Belegnummer kommt mehrfach vor: " + mehrfach.slice(0, 10).join(", ") +
        (mehrfach.length > 10 ? " …" : "") + ". Das führt beim Einlesen zu Rückfragen." });
  }

  const kasse = kassenbuch(sitzung, von, bis);
  if (kasse.negativAb) {
    befunde.push({ schwere: "fehler", titel: "Kassenbestand rechnerisch negativ",
      text: "Ab dem " + kasse.negativAb + " weist die Kasse einen negativen Bestand aus. " +
        "Bar kann nicht ausgegeben werden, was nicht da ist — es fehlt eine Einlage oder eine Einnahme." });
  }

  const kuenftig = liste.filter((b) => b.datum > new Date().toISOString().slice(0, 10));
  if (kuenftig.length) {
    befunde.push({ schwere: "hinweis", titel: "Belege mit künftigem Datum",
      text: kuenftig.length + " Buchung(en) liegen in der Zukunft.",
      nummern: kuenftig.map((b) => b.journal_nr).slice(0, 30) });
  }

  const ohneText = liste.filter((b) => String(b.buchungstext || "").trim().length < 5);
  if (ohneText.length) {
    befunde.push({ schwere: "hinweis", titel: "Sehr kurze Buchungstexte",
      text: ohneText.length + " Buchung(en) haben kaum einen Text. Der Steuerberater erkennt daran " +
        "sonst nicht, worum es ging.", nummern: ohneText.map((b) => b.journal_nr).slice(0, 30) });
  }

  // Erloese ohne Steuer auf einem Konto, das eigentlich Steuer traegt.
  const satzKonflikt = liste.filter((b) => {
    const soll = kontoAufloesen(sitzung.firmaId, b.soll_konto);
    const haben = kontoAufloesen(sitzung.firmaId, b.haben_konto);
    const k = [soll, haben].find((x) => x && (x.art === "Ertrag" || x.art === "Aufwand"));
    return k && k.steuersatz !== b.steuersatz;
  });
  if (satzKonflikt.length) {
    befunde.push({ schwere: "hinweis", titel: "Steuersatz weicht vom Konto ab",
      text: satzKonflikt.length + " Buchung(en) haben einen anderen Steuersatz als am Konto hinterlegt. " +
        "Das kann richtig sein — bitte kurz ansehen.",
      nummern: satzKonflikt.map((b) => b.journal_nr).slice(0, 30) });
  }

  const e = einstellungen(sitzung.firmaId);

  /*
   * Ist das Unternehmen von der Umsatzsteuer befreit, sind zwei Dinge falsch,
   * die sonst richtig waeren - und beide fallen sonst erst der Kanzlei auf.
   */
  if (e.ust_art && e.ust_art !== "steuerpflichtig") {
    const kleinunternehmer = e.ust_art === "kleinunternehmer";
    const mitSteuer = liste.filter((b) => b.steuersatz && !b.storno_von);
    const erloese = mitSteuer.filter((b) => {
      const soll = kontoAufloesen(sitzung.firmaId, b.soll_konto);
      const haben = kontoAufloesen(sitzung.firmaId, b.haben_konto);
      return (soll && soll.art === "Ertrag") || (haben && haben.art === "Ertrag");
    });
    const aufwand = mitSteuer.filter((b) => {
      const soll = kontoAufloesen(sitzung.firmaId, b.soll_konto);
      const haben = kontoAufloesen(sitzung.firmaId, b.haben_konto);
      return (soll && soll.art === "Aufwand") || (haben && haben.art === "Aufwand");
    });

    if (erloese.length) {
      befunde.push({ schwere: kleinunternehmer ? "fehler" : "warnung",
        titel: "Erlöse mit Umsatzsteuer trotz Befreiung",
        text: erloese.length + " Erlösbuchung(en) weisen Umsatzsteuer aus, obwohl die Umsätze " +
          (kleinunternehmer
            ? "nach § 19 UStG nicht besteuert werden. Ausgewiesene Steuer wird trotzdem geschuldet " +
              "(§ 14c Abs. 2 UStG) — das gehört berichtigt."
            : "nach § 4 UStG steuerfrei sind. Bei einem steuerpflichtigen Nebengeschäft kann das " +
              "richtig sein; sonst gehört es korrigiert."),
        nummern: erloese.map((b) => b.journal_nr).slice(0, 30) });
    }
    if (aufwand.length) {
      const summe = aufwand.reduce((n, b) => n + b.steuer_cent, 0);
      befunde.push({ schwere: "warnung", titel: "Vorsteuer gebucht, obwohl nicht abziehbar",
        text: aufwand.length + " Aufwandsbuchung(en) trennen Vorsteuer ab (zusammen " +
          (summe / 100).toFixed(2).replace(".", ",") + " €). Wer steuerfreie Umsätze nach § 4 UStG " +
          "ausführt, darf die Vorsteuer nicht abziehen (§ 15 Abs. 2 UStG) — der volle Rechnungsbetrag " +
          "gehört auf das Aufwandskonto, mit Steuersatz 0.",
        nummern: aufwand.map((b) => b.journal_nr).slice(0, 30) });
    }
  }

  if (!e.berater || !e.mandant) {
    befunde.push({ schwere: "fehler", titel: "Berater- und Mandantennummer fehlen",
      text: "Ohne diese beiden Nummern kann die Kanzlei die Datei nicht zuordnen. " +
        "Beide stehen auf jedem Schreiben des Steuerberaters; sonst dort erfragen." });
  }
  if (!e.konten_bestaetigt_am) {
    befunde.push({ schwere: "hinweis", titel: "Kontenrahmen noch nicht abgestimmt",
      text: "Die Kontonummern sind ein Vorschlag. Einmal mit der Kanzlei abgleichen — " +
        "danach lässt sich das unter Einstellungen bestätigen." });
  }
  return { von, bis, anzahl: liste.length, befunde };
}

/* ----------------------------------------------------------- Einstellungen */

function einstellungenLesen(sitzung) {
  fordereLesen(sitzung);
  const e = einstellungen(sitzung.firmaId);
  const kreis = personenkonten(e.sachkontenlaenge);
  return json(200, {
    berater: e.berater, mandant: e.mandant, skr: e.skr, sachkontenlaenge: e.sachkontenlaenge,
    wjBeginn: e.wj_beginn, steuerberaterName: e.steuerberater_name, steuerberaterEmail: e.steuerberater_email,
    herkunft: e.herkunft, kontenBestaetigtAm: e.konten_bestaetigt_am, kontenBestaetigtVon: e.konten_bestaetigt_von,
    absender: e.absender, zahlungsdaten: e.zahlungsdaten, unterzeichner: e.unterzeichner,
    steuernummer: e.steuernummer, ustid: e.ustid,
    rechnungPraefix: e.rechnung_praefix || "{JJ}", rechnungStellen: e.rechnung_stellen || 8,
    ustArt: e.ust_art || "steuerpflichtig", steuerhinweis: e.steuerhinweis,
    abgeschlossenBis: abgeschlossenBis(sitzung.firmaId),
    nummernkreise: kreis, steuerschluessel: STEUERSCHLUESSEL,
  });
}

function einstellungenSetzen(sitzung, d) {
  fordereSchreiben(sitzung);
  const e = einstellungen(sitzung.firmaId);

  const berater = String(d.berater || "").replace(/\D/g, "");
  const mandant = String(d.mandant || "").replace(/\D/g, "");
  if (berater && !(Number(berater) >= 1000 && Number(berater) <= 9999999)) {
    throw new Verweigert("Die Beraternummer liegt zwischen 1000 und 9999999.", 400);
  }
  if (mandant && !(Number(mandant) >= 1 && Number(mandant) <= 99999)) {
    throw new Verweigert("Die Mandantennummer liegt zwischen 1 und 99999.", 400);
  }
  const skr = ["03", "04"].includes(d.skr) ? d.skr : e.skr;
  const laenge = [4, 5, 6, 7, 8].includes(Number(d.sachkontenlaenge)) ? Number(d.sachkontenlaenge) : e.sachkontenlaenge;
  const wj = /^\d{2}-\d{2}$/.test(String(d.wjBeginn || "")) ? d.wjBeginn : e.wj_beginn;
  const herkunft = String(d.herkunft || e.herkunft || "SV").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 2) || "SV";

  // Die Sachkontenlaenge verschiebt die Nummernkreise der Personenkonten -
  // nachtraeglich waeren vorhandene Debitoren auf einmal ausserhalb.
  if (laenge !== e.sachkontenlaenge &&
      db.prepare("SELECT 1 FROM buch_partner WHERE firma_id = ? LIMIT 1").get(sitzung.firmaId)) {
    throw new Verweigert("Es gibt bereits Geschäftspartner. Die Sachkontenlänge lässt sich dann nicht mehr ändern, " +
      "weil sich die Nummernkreise der Personenkonten daran ausrichten.", 409);
  }

  /*
   * Angaben fuer den Mahnbrief. Sie werden nur ersetzt, wenn sie mitkommen -
   * die Einstellungen werden von mehreren Masken aus gespeichert, und eine
   * Maske ohne diese Felder soll sie nicht leeren.
   */
  const behalten = (neu, alt) => (neu === undefined ? alt : w(neu));

  db.prepare(`UPDATE buch_einstellungen SET berater=?, mandant=?, skr=?, sachkontenlaenge=?, wj_beginn=?,
      steuerberater_name=?, steuerberater_email=?, herkunft=?, absender=?, zahlungsdaten=?, unterzeichner=?,
      steuernummer=?, ustid=?, rechnung_praefix=?, rechnung_stellen=?, ust_art=?, steuerhinweis=?,
      geaendert_am=datetime('now') WHERE firma_id=?`)
    .run(berater || null, mandant || null, skr, laenge, wj,
      w(d.steuerberaterName), w(d.steuerberaterEmail), herkunft,
      behalten(d.absender, e.absender), behalten(d.zahlungsdaten, e.zahlungsdaten),
      behalten(d.unterzeichner, e.unterzeichner),
      behalten(d.steuernummer, e.steuernummer), behalten(d.ustid, e.ustid),
      behalten(d.rechnungPraefix, e.rechnung_praefix),
      d.rechnungStellen === undefined ? e.rechnung_stellen
        : (Number(d.rechnungStellen) >= 1 && Number(d.rechnungStellen) <= 12
          ? Math.round(Number(d.rechnungStellen)) : e.rechnung_stellen),
      d.ustArt === undefined ? e.ust_art
        : (UST_ARTEN.includes(d.ustArt) ? d.ustArt : e.ust_art),
      behalten(d.steuerhinweis, e.steuerhinweis),
      sitzung.firmaId);

  if (d.kontenBestaetigt === true && !e.konten_bestaetigt_am) {
    db.prepare("UPDATE buch_einstellungen SET konten_bestaetigt_am = date('now'), konten_bestaetigt_von = ? WHERE firma_id = ?")
      .run(sitzung.anmeldename, sitzung.firmaId);
    protokoll(sitzung, "Kontenrahmen", "Kontenrahmen bestätigt", "Mit dem Steuerberater abgestimmt.");
  }
  if (d.kontenBestaetigt === false) {
    db.prepare("UPDATE buch_einstellungen SET konten_bestaetigt_am = NULL, konten_bestaetigt_von = NULL WHERE firma_id = ?")
      .run(sitzung.firmaId);
  }

  protokoll(sitzung, "Einstellungen", "Buchhaltung eingerichtet",
    "Berater " + (berater || "–") + ", Mandant " + (mandant || "–") + ", SKR" + skr + ".");
  return einstellungenLesen(sitzung);
}

/** Erstinbetriebnahme: Kontenvorlage anlegen. */
function kontenVorlage(sitzung, skr) {
  fordereSchreiben(sitzung);
  const gewaehlt = ["03", "04"].includes(skr) ? skr : einstellungen(sitzung.firmaId).skr;
  const n = kontenVorlageAnlegen(sitzung.firmaId, gewaehlt);
  protokoll(sitzung, "Kontenrahmen", "Kontenvorlage geladen", "SKR" + gewaehlt + ": " + n + " Konten ergänzt.");
  return json(200, { ergaenzt: n, skr: gewaehlt });
}

module.exports = {
  ZAHLARTEN, KONTOARTEN, UST_ARTEN, aufteilen, einstellungen, wirtschaftsjahr, abgeschlossenBis,
  kontoAufloesen, kontenVorlageAnlegen, protokoll,
  konten, kontoSpeichern, kontoEntfernen, kontenEinlesen, kontenzeileZerlegen,
  umbruecheZusammenfuehren, betraegeAbschneiden, kontenVorlage,
  partner, partnerSpeichern, naechsteKontonummer,
  belege, belegSpeichern, belegStornieren, belegNachAussen, belegDatei, belegKategorie, BELEG_ABFRAGE,
  umsatzsteuer, kassenbuch, uebersicht, pruefung,
  einstellungenLesen, einstellungenSetzen,
};
