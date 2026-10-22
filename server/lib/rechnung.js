"use strict";
/**
 * Ausgangsrechnungen schreiben.
 *
 * Bisher wurden Rechnungen nur erfasst - geschrieben wurden sie woanders.
 * Hier entstehen sie: mit Positionen, Steueraufteilung, Pflichtangaben und
 * einem Bogen, der auf Firmenbriefpapier passt.
 *
 * Vier Festlegungen:
 *
 * 1. Ein Entwurf ist keine Rechnung. Er hat keine Nummer, taucht in keiner
 *    Auswertung auf und aendert keinen Saldo. Erst das Festschreiben vergibt
 *    die Nummer und bucht - und ab da ist nichts mehr zu aendern. So entstehen
 *    keine Luecken im Nummernkreis, wenn ein Entwurf verworfen wird.
 *
 * 2. Vor dem Festschreiben werden die Pflichtangaben nach § 14 UStG geprueft.
 *    Was fehlt, wird einzeln benannt. Eine formal unvollstaendige Rechnung
 *    kostet den Empfaenger den Vorsteuerabzug und kommt zurueck - beim
 *    zweiten Mal dann mit Verzug.
 *
 * 3. Gebucht wird je Erloeskonto und Steuersatz eine eigene Zeile. Eine
 *    Buchung traegt genau einen Steuersatz; alles andere waere geschummelt.
 *
 * 4. Der Steuerhinweis wird nicht geraten. Ob eine Leistung steuerfrei ist
 *    (§ 4 Nr. 16 oder Nr. 17 b UStG), ermaessigt (§ 12 Abs. 2 Nr. 10 UStG)
 *    oder voll steuerpflichtig, haengt an der Leistung und an der Anerkennung
 *    des Betriebes. Die Anwendung bietet die Formulierungen an und besteht
 *    darauf, dass eine dasteht - welche, entscheidet die Kanzlei.
 */

const { db } = require("./db");
const R = require("./rechte");
const B = require("./buchhaltung");

const Verweigert = R.Verweigert;
const json = (status, koerper) => ({ status, koerper });
const w = (v) => (v === undefined || v === "" ? null : v);
const heute = () => new Date().toISOString().slice(0, 10);
const istDatum = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));

/* ---------------------------------------------------------------- Tabellen */

db.exec(`
CREATE TABLE IF NOT EXISTS buch_rechnungen (
  id              INTEGER PRIMARY KEY,
  firma_id        INTEGER NOT NULL REFERENCES firmen(id) ON DELETE CASCADE,
  -- Erst beim Festschreiben vergeben. Ein Entwurf verbraucht keine Nummer.
  nummer          TEXT,
  partner_id      INTEGER REFERENCES buch_partner(id) ON DELETE SET NULL,
  datum           TEXT NOT NULL,
  leistung_von    TEXT,
  leistung_bis    TEXT,
  betreff         TEXT,
  einleitung      TEXT,
  schluss         TEXT,
  zahlungsziel    INTEGER NOT NULL DEFAULT 14,
  faellig_am      TEXT,
  steuerhinweis   TEXT,
  bestellnummer   TEXT,
  -- Selbst vergebene Rechnungsnummer. Wer seine Rechnungen anderswo schreibt
  -- und hier nur erfasst, bringt die Nummer mit; leer heisst: die Anwendung
  -- vergibt sie beim Festschreiben.
  wunschnummer    TEXT,
  -- Text der Buchung. Ohne eigene Angabe wird der Betreff genommen.
  buchungstext    TEXT,
  -- Sind die Einzelpreise brutto gemeint? Beim Abtippen einer fertigen
  -- Rechnung stehen dort meist Bruttobetraege.
  preise_brutto   INTEGER NOT NULL DEFAULT 0,
  -- Fuer die Abrechnung mit einer Pflegekasse: auf welcher Grundlage die
  -- Leistung erbracht wurde und fuer wen. Der Zahler ist die Kasse, die
  -- Leistung bekommt der Versicherte - ohne beides ist die Rechnung nicht
  -- zuzuordnen.
  grundlage       TEXT,
  versicherter    TEXT,
  netto_cent      INTEGER NOT NULL DEFAULT 0,
  steuer_cent     INTEGER NOT NULL DEFAULT 0,
  brutto_cent     INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'Entwurf',
  festgeschrieben_am TEXT,
  festgeschrieben_von TEXT,
  storniert_am    TEXT,
  storno_grund    TEXT,
  notiz           TEXT,
  angelegt_am     TEXT NOT NULL DEFAULT (datetime('now')),
  angelegt_von    TEXT,
  UNIQUE (firma_id, nummer)
);

CREATE TABLE IF NOT EXISTS buch_rechnungspositionen (
  id            INTEGER PRIMARY KEY,
  firma_id      INTEGER NOT NULL REFERENCES firmen(id) ON DELETE CASCADE,
  rechnung_id   INTEGER NOT NULL REFERENCES buch_rechnungen(id) ON DELETE CASCADE,
  pos           INTEGER NOT NULL,
  -- Menge in Tausendsteln: 24,5 km sind 24500. Kilometer und Stunden gehen
  -- selten glatt auf, und ein gerundeter Faktor ergibt einen falschen Preis.
  menge_mille   INTEGER NOT NULL DEFAULT 1000,
  einheit       TEXT,
  datum         TEXT,
  bezeichnung   TEXT NOT NULL,
  einzel_cent   INTEGER NOT NULL DEFAULT 0,
  steuersatz    INTEGER NOT NULL DEFAULT 0,
  konto         TEXT NOT NULL,
  -- Zeilenbetrag, so wie er eingegeben wurde: netto oder brutto, je nach
  -- Einstellung der Rechnung. Was davon gilt, steht an der Rechnung - nicht
  -- an jeder Zeile, sonst liesse sich eine Rechnung mischen und niemand
  -- wuesste hinterher, was gemeint war.
  zeile_cent    INTEGER NOT NULL DEFAULT 0
);

-- Welche Buchung zu welcher Rechnung gehoert. Je Erloeskonto und Steuersatz
-- eine; ohne diese Zuordnung liesse sich eine Rechnung nicht als Ganzes
-- stornieren.
CREATE TABLE IF NOT EXISTS buch_rechnungsbelege (
  id          INTEGER PRIMARY KEY,
  firma_id    INTEGER NOT NULL REFERENCES firmen(id) ON DELETE CASCADE,
  rechnung_id INTEGER NOT NULL REFERENCES buch_rechnungen(id) ON DELETE CASCADE,
  beleg_id    INTEGER NOT NULL REFERENCES buch_belege(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ix_rechnungen_firma ON buch_rechnungen(firma_id, status);
CREATE INDEX IF NOT EXISTS ix_rechnungspos     ON buch_rechnungspositionen(rechnung_id);
`);

// CREATE TABLE IF NOT EXISTS ruehrt eine bestehende Tabelle nicht an.
const spalten = (t) => db.prepare("PRAGMA table_info(" + t + ")").all().map((x) => x.name);

// Aus netto_cent wurde zeile_cent: Der Betrag kann jetzt auch brutto gemeint
// sein, und ein Feldname, der etwas anderes behauptet, waere die naechste
// Fehlerquelle.
if (spalten("buch_rechnungspositionen").includes("netto_cent") &&
    !spalten("buch_rechnungspositionen").includes("zeile_cent")) {
  db.exec("ALTER TABLE buch_rechnungspositionen RENAME COLUMN netto_cent TO zeile_cent");
}

for (const [tabelle, spalte, art] of [
  ["buch_rechnungen", "grundlage", "TEXT"],
  ["buch_rechnungen", "versicherter", "TEXT"],
  ["buch_rechnungen", "wunschnummer", "TEXT"],
  ["buch_rechnungen", "buchungstext", "TEXT"],
  ["buch_rechnungen", "preise_brutto", "INTEGER NOT NULL DEFAULT 0"],
]) {
  if (!spalten(tabelle).includes(spalte)) {
    db.exec("ALTER TABLE " + tabelle + " ADD COLUMN " + spalte + " " + art);
  }
}

/* ------------------------------------------------------- Steuerhinweise */

/*
 * Vorschlaege, keine Festlegung.
 *
 * Welche Befreiung greift, haengt an der Leistung und an der Anerkennung des
 * Betriebes: Ein nach § 45a SGB XI anerkanntes Angebot zur Unterstuetzung im
 * Alltag steht anders da als ein Pflegedienst und anders als ein
 * Krankenfahrdienst. Den genauen Buchstaben in § 4 Nr. 16 UStG traegt die
 * Kanzlei nach - die Aufzaehlung dort ist mehrfach umnummeriert worden, und
 * ein falscher Buchstabe im Brieftext waere schlimmer als keiner.
 */
const STEUERHINWEISE = [
  { satz: 0, kurz: "Betreuung und Hauswirtschaft (§ 45a SGB XI)",
    text: "Umsatzsteuerfrei nach § 4 Nr. 16 UStG — eng mit der Betreuung hilfsbedürftiger Personen " +
      "verbundene Leistungen eines nach § 45a SGB XI anerkannten Angebots zur Unterstützung im Alltag." },
  { satz: 0, kurz: "Pflegeleistungen (§ 4 Nr. 16 UStG)",
    text: "Umsatzsteuerfrei nach § 4 Nr. 16 UStG — eng mit der Pflege hilfsbedürftiger Personen " +
      "verbundene Leistungen." },
  { satz: 0, kurz: "Krankenbeförderung (§ 4 Nr. 17 b UStG)",
    text: "Umsatzsteuerfrei nach § 4 Nr. 17 Buchst. b UStG — Beförderung kranker und verletzter " +
      "Personen mit besonders eingerichteten Fahrzeugen." },
  { satz: 0, kurz: "Kleinunternehmer (§ 19 UStG)",
    text: "Kein Ausweis von Umsatzsteuer, da Kleinunternehmer nach § 19 Abs. 1 UStG." },
  { satz: 7, kurz: "Personenbeförderung (§ 12 Abs. 2 Nr. 10 UStG)",
    text: "Ermäßigter Steuersatz nach § 12 Abs. 2 Nr. 10 UStG — Personenbeförderung innerhalb einer " +
      "Gemeinde oder auf einer Strecke bis 50 Kilometer." },
];

/*
 * Leistungsgrundlage.
 *
 * Wer gegenueber einer Pflegekasse abrechnet, muss auf der Rechnung erkennen
 * lassen, welche Leistung der Versicherte in Anspruch genommen hat - sonst
 * kommt sie zurueck. Bei einem Betreuungs- und Hauswirtschaftsdienst sind das
 * in der Regel der Entlastungsbetrag und die Verhinderungspflege.
 *
 * Die Betraege stehen hier bewusst nicht: Sie aendern sich durch Gesetz, und
 * eine veraltete Zahl im Brieftext waere schlimmer als keine.
 */
const GRUNDLAGEN = [
  "Entlastungsbetrag nach § 45b SGB XI",
  "Verhinderungspflege nach § 39 SGB XI",
  "Angebot zur Unterstützung im Alltag nach § 45a SGB XI",
  "Pflegesachleistung nach § 36 SGB XI",
  "Selbstzahler (privat)",
];

/* ------------------------------------------------------------ Nummernkreis */

/**
 * Naechste Rechnungsnummer.
 *
 * Sie muss fortlaufend und einmalig sein (§ 14 Abs. 4 Nr. 4 UStG). Vergeben
 * wird sie erst beim Festschreiben - deshalb reisst ein verworfener Entwurf
 * keine Luecke, die man dem Pruefer spaeter erklaeren muesste.
 */
function naechsteNummer(firmaId, datum) {
  const e = B.einstellungen(firmaId);
  const stellen = Math.min(12, Math.max(1, Number(e.rechnung_stellen) || 8));
  const muster = String(e.rechnung_praefix || "{JJ}")
    .replace(/\{JJJJ\}/g, datum.slice(0, 4))
    .replace(/\{JJ\}/g, datum.slice(2, 4))
    .replace(/\{MM\}/g, datum.slice(5, 7));

  /*
   * Fortgezaehlt wird nur, was zum Muster passt und hinten aus Ziffern
   * besteht. Selbst vergebene Nummern koennen anders aussehen - sie duerfen
   * die Zaehlung nicht zum Stehen bringen, aber auch nicht mitgezaehlt
   * werden, wenn sie nicht ins Schema passen.
   */
  const passende = db.prepare(`SELECT nummer FROM buch_rechnungen
                               WHERE firma_id = ? AND nummer LIKE ? ORDER BY nummer DESC`)
    .all(firmaId, muster + "%")
    .map((x) => String(x.nummer).slice(muster.length))
    .filter((rest) => /^\d+$/.test(rest))
    .map(Number);
  const lauf = passende.length ? Math.max(...passende) + 1 : 1;
  const nummer = muster + String(lauf).padStart(stellen, "0");
  if (String(lauf).length > stellen) {
    throw new Verweigert("Der Nummernkreis " + muster + " ist erschöpft. Bitte mehr Stellen einstellen.", 409);
  }
  return nummer;
}

/**
 * Prueft eine selbst vergebene Rechnungsnummer.
 *
 * Sie landet als Belegnummer in der Buchhaltung und spaeter im
 * Buchungsstapel der Kanzlei. Deshalb die Beschraenkung auf Zeichen, die
 * DATEV im Belegfeld annimmt - ein Umlaut oder ein Semikolon dort faellt
 * erst beim Einlesen auf, und dann bei der Kanzlei.
 */
function nummerPruefen(firmaId, roh, eigeneId) {
  const nummer = String(roh || "").trim();
  if (!nummer) return null;
  if (nummer.length > 30) throw new Verweigert("Die Rechnungsnummer ist höchstens 30 Zeichen lang.", 400);
  if (!/^[A-Za-z0-9][A-Za-z0-9\-_.\/ ]*$/.test(nummer)) {
    throw new Verweigert("In der Rechnungsnummer sind Buchstaben, Ziffern und - _ . / erlaubt. " +
      "Umlaute und Sonderzeichen nimmt DATEV im Belegfeld nicht an.", 400);
  }
  const vergeben = db.prepare(`SELECT id, status FROM buch_rechnungen
                               WHERE firma_id = ? AND (nummer = ? OR wunschnummer = ?) AND id <> ?`)
    .get(firmaId, nummer, nummer, eigeneId || 0);
  if (vergeben) {
    throw new Verweigert("Die Rechnungsnummer " + nummer + " ist in dieser Firma bereits vergeben. " +
      "Eine Nummer darf nur einen Vorgang bezeichnen (§ 14 Abs. 4 Nr. 4 UStG).", 409);
  }
  return nummer;
}

/* ------------------------------------------------------------- Rechnen */

/** Positionsbetrag: Menge mal Einzelpreis, kaufmaennisch gerundet. */
function positionNetto(mengeMille, einzelCent) {
  return Math.round((Number(mengeMille) * Number(einzelCent)) / 1000);
}

/**
 * Summen einer Rechnung.
 *
 * Aufgeschluesselt nach Steuersaetzen, wie § 14 Abs. 4 Nr. 8 UStG es
 * verlangt. Die Steuer wird je Satz aus der Summe gerechnet, nicht je
 * Position - sonst summierten sich die Rundungen.
 */
function summen(positionen, preiseBrutto) {
  const nachSatz = new Map();
  for (const p of positionen) {
    const zeile = p.zeileCent !== undefined ? p.zeileCent : positionNetto(p.mengeMille, p.einzelCent);
    const s = Number(p.steuersatz) || 0;
    nachSatz.set(s, (nachSatz.get(s) || 0) + zeile);
  }
  const saetze = Array.from(nachSatz.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([satz, summe]) => {
      // Netto herauf oder Brutto herunter - beides fuehrt zum selben
      // Steuerbetrag, solange je Satz aus der Summe gerechnet wird.
      const steuer = preiseBrutto
        ? Math.round((summe * satz) / (100 + satz))
        : Math.round((summe * satz) / 100);
      return { satz, nettoCent: preiseBrutto ? summe - steuer : summe, steuerCent: steuer };
    });
  const nettoCent = saetze.reduce((s, x) => s + x.nettoCent, 0);
  const steuerCent = saetze.reduce((s, x) => s + x.steuerCent, 0);
  return { saetze, nettoCent, steuerCent, bruttoCent: nettoCent + steuerCent };
}

/* --------------------------------------------------------------- Lesen */

function positionenLesen(rechnungId) {
  return db.prepare("SELECT * FROM buch_rechnungspositionen WHERE rechnung_id = ? ORDER BY pos")
    .all(rechnungId)
    .map((p) => ({ id: p.id, pos: p.pos, mengeMille: p.menge_mille, einheit: p.einheit,
      datum: p.datum, bezeichnung: p.bezeichnung, einzelCent: p.einzel_cent,
      steuersatz: p.steuersatz, konto: p.konto, zeileCent: p.zeile_cent }));
}

function nachAussen(r, positionen) {
  return {
    id: r.id, nummer: r.nummer, status: r.status,
    partnerId: r.partner_id, partner: r.partner_name || null, partnerKonto: r.partner_konto || null,
    anschrift: { strasse: r.strasse, plz: r.plz, ort: r.ort, land: r.land },
    ustid: r.partner_ustid || null,
    datum: r.datum, leistungVon: r.leistung_von, leistungBis: r.leistung_bis,
    betreff: r.betreff, einleitung: r.einleitung, schluss: r.schluss,
    grundlage: r.grundlage, versicherter: r.versicherter,
    zahlungsziel: r.zahlungsziel, faelligAm: r.faellig_am,
    steuerhinweis: r.steuerhinweis, bestellnummer: r.bestellnummer,
    wunschnummer: r.wunschnummer, buchungstext: r.buchungstext,
    preiseBrutto: !!r.preise_brutto,
    nettoCent: r.netto_cent, steuerCent: r.steuer_cent, bruttoCent: r.brutto_cent,
    festgeschriebenAm: r.festgeschrieben_am, festgeschriebenVon: r.festgeschrieben_von,
    storniertAm: r.storniert_am, stornoGrund: r.storno_grund, notiz: r.notiz,
    angelegtAm: r.angelegt_am,
    positionen: positionen || [],
  };
}

const ABFRAGE = `
  SELECT r.*, p.name AS partner_name, p.konto AS partner_konto, p.strasse, p.plz, p.ort, p.land,
         p.ustid AS partner_ustid
    FROM buch_rechnungen r LEFT JOIN buch_partner p ON p.id = r.partner_id`;

function rechnungLesen(firmaId, id) {
  const r = db.prepare(ABFRAGE + " WHERE r.id = ? AND r.firma_id = ?").get(id, firmaId);
  if (!r) throw new Verweigert("Rechnung nicht gefunden.", 404);
  return r;
}

function liste(sitzung, d) {
  R.fordereLesen(sitzung, "buchhaltung");
  const status = d && d.status;
  const rows = db.prepare(ABFRAGE + " WHERE r.firma_id = ?" + (status ? " AND r.status = ?" : "") +
    " ORDER BY COALESCE(r.nummer, 'zzz') DESC, r.id DESC LIMIT 500")
    .all(...(status ? [sitzung.firmaId, status] : [sitzung.firmaId]));

  /*
   * An jeder festgeschriebenen Rechnung steht, wie viel davon bezahlt ist.
   * Das steht zwar auch unter "Offene Posten" - aber wer eine Rechnung
   * heraussucht, will es hier sehen und nicht erst umschalten.
   */
  return json(200, { wert: rows.map((r) => {
    const pos = positionenLesen(r.id);
    const offen = db.prepare(`
      SELECT COALESCE(SUM(b.brutto_cent), 0) AS summe,
             COALESCE(SUM((SELECT COALESCE(SUM(a.betrag_cent),0) FROM buch_ausgleich a
                            WHERE a.rechnung_id = b.id)), 0) AS bezahlt
        FROM buch_rechnungsbelege rb JOIN buch_belege b ON b.id = rb.beleg_id
       WHERE rb.rechnung_id = ? AND b.storniert_durch IS NULL`).get(r.id);
    return Object.assign(nachAussen(r, pos), {
      bezahltCent: offen.bezahlt, offenCent: offen.summe - offen.bezahlt,
      gebuchtCent: offen.summe,
    });
  }) });
}

function einzeln(sitzung, id) {
  R.fordereLesen(sitzung, "buchhaltung");
  const r = rechnungLesen(sitzung.firmaId, id);
  return json(200, nachAussen(r, positionenLesen(r.id)));
}

function vorlagen(sitzung) {
  R.fordereLesen(sitzung, "buchhaltung");
  const e = B.einstellungen(sitzung.firmaId);
  return json(200, {
    steuerhinweise: STEUERHINWEISE, grundlagen: GRUNDLAGEN,
    naechsteNummer: naechsteNummer(sitzung.firmaId, heute()),
    praefix: e.rechnung_praefix || "{JJ}", stellen: e.rechnung_stellen || 8,
    ustArt: e.ust_art || "steuerpflichtig",
    // Die Vorgabe fuer neue Rechnungen. Wer immer dieselbe Befreiung hat,
    // soll sie nicht jedes Mal von Hand heraussuchen.
    steuerhinweisVorgabe: e.steuerhinweis || null,
    absender: e.absender || null, steuernummer: e.steuernummer || null, ustid: e.ustid || null,
    zahlungsdaten: e.zahlungsdaten || null, unterzeichner: e.unterzeichner || null,
  });
}

/* -------------------------------------------------------------- Schreiben */

function tage(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Legt einen Entwurf an oder aendert ihn.
 *
 * Festgeschriebene Rechnungen bleiben unberuehrt - sie sind heraus, und was
 * heraus ist, wird nicht nachtraeglich umgeschrieben. Dafuer gibt es das
 * Storno.
 */
function speichern(sitzung, id, d) {
  R.fordereSchreiben(sitzung, "buchhaltung");
  const firmaId = sitzung.firmaId;

  if (id) {
    const alt = rechnungLesen(firmaId, id);
    if (alt.status !== "Entwurf") {
      throw new Verweigert("Diese Rechnung ist festgeschrieben. Ändern lässt sie sich nicht mehr — " +
        "nur stornieren und neu schreiben.", 409);
    }
  }

  const datum = istDatum(d.datum) ? d.datum : heute();
  if (d.leistungVon && !istDatum(d.leistungVon)) throw new Verweigert("Ungültiger Leistungsbeginn.", 400);
  if (d.leistungBis && !istDatum(d.leistungBis)) throw new Verweigert("Ungültiges Leistungsende.", 400);
  if (d.leistungVon && d.leistungBis && d.leistungBis < d.leistungVon) {
    throw new Verweigert("Das Leistungsende liegt vor dem Beginn.", 400);
  }
  const partnerId = d.partnerId ? Number(d.partnerId) : null;
  if (partnerId) {
    const p = db.prepare("SELECT id, typ FROM buch_partner WHERE id = ? AND firma_id = ?").get(partnerId, firmaId);
    if (!p) throw new Verweigert("Unbekannter Geschäftspartner.", 404);
    if (p.typ !== "Debitor") throw new Verweigert("Eine Ausgangsrechnung geht an einen Kunden, nicht an einen Lieferanten.", 400);
  }
  const ziel = Number.isFinite(Number(d.zahlungsziel)) && Number(d.zahlungsziel) >= 0 &&
    Number(d.zahlungsziel) <= 365 ? Math.round(Number(d.zahlungsziel)) : 14;

  /* -- Positionen -- */
  const roh = Array.isArray(d.positionen) ? d.positionen : [];
  const positionen = roh.map((p, i) => {
    const bez = String(p.bezeichnung || "").trim();
    if (!bez) throw new Verweigert("Position " + (i + 1) + " hat keine Bezeichnung. " +
      "Art und Umfang der Leistung gehören auf die Rechnung (§ 14 Abs. 4 Nr. 5 UStG).", 400);
    const menge = Math.round(Number(p.mengeMille));
    if (!Number.isFinite(menge) || menge === 0) {
      throw new Verweigert("Position " + (i + 1) + ": Die Menge fehlt.", 400);
    }
    const einzel = Math.round(Number(p.einzelCent));
    if (!Number.isFinite(einzel)) throw new Verweigert("Position " + (i + 1) + ": Der Einzelpreis fehlt.", 400);
    const satz = [0, 7, 19].includes(Number(p.steuersatz)) ? Number(p.steuersatz) : 0;
    /*
     * Als Kleinunternehmer darf ueberhaupt keine Umsatzsteuer ausgewiesen
     * werden - ausgewiesene wird geschuldet, auch wenn sie nicht anfaellt
     * (§ 14c Abs. 2 UStG). Das ist kein Hinweis wert, sondern eine Sperre.
     *
     * Bei einer Befreiung nach § 4 UStG dagegen bleibt der Ausweis moeglich:
     * Ein steuerpflichtiges Nebengeschaeft - der Verkauf eines alten Fahrzeugs
     * etwa - kommt vor. Darauf weist die Selbstpruefung hin, statt es zu
     * verbieten.
     */
    if (satz && B.einstellungen(firmaId).ust_art === "kleinunternehmer") {
      throw new Verweigert("Position " + (i + 1) + ": Als Kleinunternehmer nach § 19 UStG darf keine " +
        "Umsatzsteuer ausgewiesen werden — ausgewiesene Steuer wird trotzdem geschuldet " +
        "(§ 14c Abs. 2 UStG).", 400);
    }
    const konto = B.kontoAufloesen(firmaId, p.konto);
    if (!konto) throw new Verweigert("Position " + (i + 1) + ": Das Erlöskonto " + (p.konto || "") +
      " gibt es nicht.", 400);
    if (p.datum && !istDatum(p.datum)) throw new Verweigert("Position " + (i + 1) + ": ungültiges Datum.", 400);
    return { pos: i + 1, mengeMille: menge, einheit: w(p.einheit), datum: w(p.datum),
      bezeichnung: bez.slice(0, 300), einzelCent: einzel, steuersatz: satz, konto: konto.nummer,
      zeileCent: positionNetto(menge, einzel) };
  });
  const preiseBrutto = d.preiseBrutto ? 1 : 0;
  const s = summen(positionen, !!preiseBrutto);
  const wunsch = nummerPruefen(firmaId, d.nummer, id);

  const felder = [w(d.partnerId) ? partnerId : null, datum, w(d.leistungVon), w(d.leistungBis),
    w(d.betreff), w(d.einleitung), w(d.schluss), ziel, tage(datum, ziel), w(d.steuerhinweis),
    w(d.bestellnummer), w(d.grundlage), w(d.versicherter),
    wunsch, w(d.buchungstext) ? String(d.buchungstext).slice(0, 60) : null, preiseBrutto,
    s.nettoCent, s.steuerCent, s.bruttoCent, w(d.notiz)];

  db.exec("BEGIN IMMEDIATE");
  try {
    let rid = id;
    if (id) {
      db.prepare(`UPDATE buch_rechnungen SET partner_id=?, datum=?, leistung_von=?, leistung_bis=?,
          betreff=?, einleitung=?, schluss=?, zahlungsziel=?, faellig_am=?, steuerhinweis=?,
          bestellnummer=?, grundlage=?, versicherter=?, wunschnummer=?, buchungstext=?, preise_brutto=?,
          netto_cent=?, steuer_cent=?, brutto_cent=?, notiz=?
        WHERE id=? AND firma_id=?`).run(...felder, id, firmaId);
      db.prepare("DELETE FROM buch_rechnungspositionen WHERE rechnung_id = ?").run(id);
    } else {
      rid = db.prepare(`INSERT INTO buch_rechnungen
        (partner_id, datum, leistung_von, leistung_bis, betreff, einleitung, schluss, zahlungsziel,
         faellig_am, steuerhinweis, bestellnummer, grundlage, versicherter,
         wunschnummer, buchungstext, preise_brutto,
         netto_cent, steuer_cent, brutto_cent, notiz, firma_id, angelegt_von)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(...felder, firmaId, sitzung.anmeldename).lastInsertRowid;
    }
    const einf = db.prepare(`INSERT INTO buch_rechnungspositionen
      (firma_id, rechnung_id, pos, menge_mille, einheit, datum, bezeichnung, einzel_cent,
       steuersatz, konto, zeile_cent) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    for (const p of positionen) {
      einf.run(firmaId, rid, p.pos, p.mengeMille, p.einheit, p.datum, p.bezeichnung,
        p.einzelCent, p.steuersatz, p.konto, p.zeileCent);
    }
    db.exec("COMMIT");
    B.protokoll(sitzung, rid, id ? "Rechnungsentwurf geändert" : "Rechnungsentwurf angelegt",
      (s.bruttoCent / 100).toFixed(2) + " EUR, " + positionen.length + " Position(en)");
    return json(id ? 200 : 201, { id: rid, nettoCent: s.nettoCent, steuerCent: s.steuerCent,
      bruttoCent: s.bruttoCent, saetze: s.saetze });
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

function entfernen(sitzung, id) {
  R.fordereSchreiben(sitzung, "buchhaltung");
  const r = rechnungLesen(sitzung.firmaId, id);
  if (r.status !== "Entwurf") {
    throw new Verweigert("Nur Entwürfe lassen sich löschen. Eine festgeschriebene Rechnung wird " +
      "storniert — sie ist beim Empfänger.", 409);
  }
  db.prepare("DELETE FROM buch_rechnungen WHERE id = ? AND firma_id = ?").run(id, sitzung.firmaId);
  B.protokoll(sitzung, id, "Rechnungsentwurf gelöscht", "");
  return json(200, { id });
}

/* --------------------------------------------------------- Pflichtangaben */

/**
 * Was nach § 14 UStG auf einer Rechnung stehen muss.
 *
 * Geprueft wird vor dem Festschreiben, und es wird einzeln benannt, was
 * fehlt. Eine Rechnung ohne Steuernummer oder ohne Leistungszeitpunkt sieht
 * vollstaendig aus und ist es nicht - auffallen wuerde es erst, wenn der
 * Empfaenger den Vorsteuerabzug verliert und die Rechnung zurueckschickt.
 */
function pflichtangaben(firmaId, r, positionen) {
  const e = B.einstellungen(firmaId);
  const fehlt = [];

  if (!e.absender) {
    fehlt.push("Der eigene Name mit Anschrift fehlt — unter Buchhaltung › Einrichten einzutragen.");
  }
  if (!e.steuernummer && !e.ustid) {
    fehlt.push("Die eigene Steuernummer oder Umsatzsteuer-Identifikationsnummer fehlt — " +
      "unter Buchhaltung › Einrichten einzutragen.");
  }
  if (!r.partner_id) fehlt.push("Es ist kein Kunde ausgewählt.");
  else if (!r.partner_name || !r.strasse || !r.plz || !r.ort) {
    fehlt.push("Die Anschrift des Kunden ist unvollständig — Name, Straße, PLZ und Ort gehören auf die Rechnung.");
  }
  if (!positionen.length) fehlt.push("Die Rechnung hat keine Position.");
  if (!r.leistung_von && !positionen.some((p) => p.datum)) {
    fehlt.push("Der Zeitpunkt der Leistung fehlt — entweder ein Leistungszeitraum oder ein Datum je Position.");
  }

  /*
   * Steuerhinweis. Steht auf der Rechnung keine Umsatzsteuer, muss dastehen,
   * warum - sonst ist sie formal unvollstaendig. Und wer Steuer ausweist,
   * ohne sie zu schulden, schuldet sie trotzdem (§ 14c UStG).
   */
  const ohneSteuer = positionen.every((p) => !p.steuersatz);
  if (ohneSteuer && !r.steuerhinweis) {
    fehlt.push(e.ust_art === "kleinunternehmer"
      ? "Der Hinweis auf die Kleinunternehmerregelung fehlt (§ 19 UStG)."
      : "Ohne Umsatzsteuer braucht die Rechnung einen Hinweis auf den Grund der Steuerbefreiung " +
        "(§ 14 Abs. 4 Nr. 8 UStG).");
  }
  if (positionen.some((p) => p.nettoCent < 0) && positionen.some((p) => p.nettoCent > 0)) {
    // Erlaubt, aber fast immer ein Versehen: Abzuege gehoeren als eigene
    // Position mit negativer Menge auf die Rechnung, nicht gemischt.
  }
  return fehlt;
}

/* ------------------------------------------------------------ Festschreiben */

/**
 * Schreibt die Rechnung fest: Nummer vergeben, buchen, sperren.
 *
 * Gebucht wird je Erloeskonto und Steuersatz eine Zeile - eine Buchung traegt
 * genau einen Steuersatz. Alle Zeilen tragen dieselbe Rechnungsnummer als
 * Belegnummer; der Steuerberater sieht sie damit als einen Vorgang.
 */
function festschreiben(sitzung, id) {
  R.fordereSchreiben(sitzung, "buchhaltung");
  const firmaId = sitzung.firmaId;
  const r = rechnungLesen(firmaId, id);
  if (r.status === "festgeschrieben") throw new Verweigert("Diese Rechnung ist bereits festgeschrieben.", 409);
  if (r.status === "storniert") throw new Verweigert("Eine stornierte Rechnung lässt sich nicht festschreiben.", 409);

  const positionen = positionenLesen(id);
  const fehlt = pflichtangaben(firmaId, r, positionen);
  if (fehlt.length) {
    throw new Verweigert("Die Rechnung ist noch nicht vollständig:\n• " + fehlt.join("\n• "), 400);
  }

  const partner = db.prepare("SELECT * FROM buch_partner WHERE id = ? AND firma_id = ?")
    .get(r.partner_id, firmaId);
  const s = summen(positionen, !!r.preise_brutto);
  if (s.bruttoCent <= 0) throw new Verweigert("Der Rechnungsbetrag muss größer als null sein.", 400);

  // Gruppiert nach Erloeskonto und Steuersatz - je Gruppe eine Buchung.
  const gruppen = new Map();
  for (const p of positionen) {
    const k = p.konto + "/" + p.steuersatz;
    if (!gruppen.has(k)) gruppen.set(k, { konto: p.konto, satz: p.steuersatz, zeileCent: 0 });
    gruppen.get(k).zeileCent += p.zeileCent;
  }

  /*
   * Die eigene Nummer geht vor. Geprueft wird sie hier noch einmal: Zwischen
   * Erfassen und Festschreiben kann jemand dieselbe Nummer an einer anderen
   * Rechnung vergeben haben.
   */
  const nummer = nummerPruefen(firmaId, r.wunschnummer, id) || naechsteNummer(firmaId, r.datum);
  const leistung = r.leistung_bis || r.leistung_von ||
    positionen.map((p) => p.datum).filter(Boolean).sort().pop() || null;

  db.exec("BEGIN IMMEDIATE");
  let belege = [];
  try {
    db.prepare("UPDATE buch_rechnungen SET nummer=?, status='festgeschrieben', " +
      "festgeschrieben_am=datetime('now'), festgeschrieben_von=?, netto_cent=?, steuer_cent=?, brutto_cent=? " +
      "WHERE id=? AND firma_id=?")
      .run(nummer, sitzung.anmeldename, s.nettoCent, s.steuerCent, s.bruttoCent, id, firmaId);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  /*
   * Gebucht wird ausserhalb der Transaktion: belegSpeichern fuehrt eine
   * eigene und vergibt die Journalnummer. Schlaegt eine Zeile fehl, wird die
   * Rechnung wieder zum Entwurf - sonst stuende eine Nummer vergeben da, zu
   * der keine Buchung gehoert.
   */
  try {
    for (const g of gruppen.values()) {
      const brutto = r.preise_brutto
        ? g.zeileCent
        : g.zeileCent + Math.round((g.zeileCent * g.satz) / 100);
      const a = B.belegSpeichern(sitzung, null, {
        art: "Ausgangsrechnung", datum: r.datum, leistungsdatum: leistung, faelligAm: r.faellig_am,
        belegnummer: nummer, partnerId: r.partner_id, sollKonto: partner.konto, habenKonto: g.konto,
        bruttoCent: brutto, steuersatz: g.satz,
        buchungstext: (r.buchungstext || r.betreff || ("Rechnung " + nummer)).slice(0, 60),
        notiz: gruppen.size > 1 ? "Teil der Rechnung " + nummer : null,
      }).koerper;
      db.prepare("INSERT INTO buch_rechnungsbelege (firma_id, rechnung_id, beleg_id) VALUES (?,?,?)")
        .run(firmaId, id, a.id);
      belege.push(a);
    }
  } catch (e) {
    for (const b of belege) {
      db.prepare("DELETE FROM buch_rechnungsbelege WHERE beleg_id = ?").run(b.id);
      db.prepare("DELETE FROM buch_belege WHERE id = ? AND firma_id = ?").run(b.id, firmaId);
    }
    db.prepare("UPDATE buch_rechnungen SET nummer=NULL, status='Entwurf', festgeschrieben_am=NULL, " +
      "festgeschrieben_von=NULL WHERE id=? AND firma_id=?").run(id, firmaId);
    throw e;
  }

  B.protokoll(sitzung, nummer, "Rechnung festgeschrieben",
    nummer + " an " + partner.name + " über " + (s.bruttoCent / 100).toFixed(2) + " EUR, " +
    belege.length + " Buchung(en)");
  return json(200, { id, nummer, belege, nettoCent: s.nettoCent, steuerCent: s.steuerCent,
    bruttoCent: s.bruttoCent });
}

/**
 * Storniert eine festgeschriebene Rechnung.
 *
 * Die Nummer bleibt vergeben - sie ist beim Empfaenger, und ein zweites Mal
 * vergeben wuerde sie zwei verschiedene Vorgaenge bezeichnen. Jede Buchung
 * bekommt ihr Storno mit vertauschten Konten.
 */
function stornieren(sitzung, id, grund) {
  R.fordereSchreiben(sitzung, "buchhaltung");
  const firmaId = sitzung.firmaId;
  const r = rechnungLesen(firmaId, id);
  if (r.status !== "festgeschrieben") {
    throw new Verweigert("Storniert wird, was festgeschrieben ist. Ein Entwurf wird gelöscht.", 409);
  }
  const text = String(grund || "").trim();
  if (!text) throw new Verweigert("Bitte angeben, warum storniert wird.", 400);

  const belege = db.prepare(`SELECT b.* FROM buch_rechnungsbelege rb JOIN buch_belege b ON b.id = rb.beleg_id
                             WHERE rb.rechnung_id = ? AND b.storniert_durch IS NULL`).all(id);
  const stornos = [];
  for (const b of belege) stornos.push(B.belegStornieren(sitzung, b.id, text).koerper);

  db.prepare("UPDATE buch_rechnungen SET status='storniert', storniert_am=date('now'), storno_grund=? " +
    "WHERE id=? AND firma_id=?").run(text, id, firmaId);
  B.protokoll(sitzung, r.nummer, "Rechnung storniert", r.nummer + ": " + text);
  return json(200, { id, nummer: r.nummer, stornos });
}

/* ------------------------------------------------------------------ Druck */

const euro = (cent) => (cent / 100).toFixed(2).replace(".", ",") + " €";
const tag = (iso) => (iso ? iso.slice(8, 10) + "." + iso.slice(5, 7) + "." + iso.slice(0, 4) : "");
const menge = (mille) => (mille / 1000).toFixed(3).replace(/[.,]?0+$/, "").replace(".", ",");

/**
 * Die Rechnung als Bogen.
 *
 * Erzeugt wird sie hier, damit Entwurfsvorschau, gedrucktes Blatt und Nachweis
 * denselben Wortlaut haben. Ein Entwurf darf angesehen werden - er traegt
 * dann aber sichtbar den Vermerk, dass er keine Rechnung ist.
 */
function bogen(sitzung, id) {
  R.fordereLesen(sitzung, "buchhaltung");
  const firmaId = sitzung.firmaId;
  const r = rechnungLesen(firmaId, id);
  const positionen = positionenLesen(id);
  const e = B.einstellungen(firmaId);
  const s = summen(positionen, !!r.preise_brutto);

  const anschrift = [r.partner_name, r.strasse, [r.plz, r.ort].filter(Boolean).join(" "),
    r.land && r.land !== "DE" ? r.land : null].filter(Boolean);

  const zeitraum = r.leistung_von && r.leistung_bis && r.leistung_von !== r.leistung_bis
    ? tag(r.leistung_von) + " bis " + tag(r.leistung_bis)
    : tag(r.leistung_bis || r.leistung_von) || null;

  return json(200, {
    rechnung: nachAussen(r, positionen),
    // Eine stornierte Rechnung ist kein Entwurf. Beide Vermerke auf einem
    // Blatt saehen aus, als wuesste das Programm selbst nicht, was es hat.
    entwurf: r.status === "Entwurf",
    storniert: r.status === "storniert",
    nummer: r.nummer,
    anschrift,
    absender: e.absender || null,
    steuernummer: e.steuernummer || null,
    ustid: e.ustid || null,
    zahlungsdaten: e.zahlungsdaten || null,
    unterzeichner: e.unterzeichner || null,
    leistungszeitraum: zeitraum,
    grundlage: r.grundlage || null,
    versicherter: r.versicherter || null,
    // Eine leere Spalte auf dem Papier wirft Fragen auf, die keine sind.
    mitDatum: positionen.some((p) => p.datum),
    zeilen: positionen.map((p) => ({
      pos: p.pos, datum: tag(p.datum), bezeichnung: p.bezeichnung,
      menge: menge(p.mengeMille), einheit: p.einheit || "",
      einzel: euro(p.einzelCent), netto: euro(p.zeileCent),
      steuersatz: p.steuersatz ? p.steuersatz + " %" : "–",
    })),
    // Steht in der Spaltenueberschrift: sonst waere nicht zu erkennen, ob die
    // Zeilenbetraege schon Umsatzsteuer enthalten.
    preiseBrutto: !!r.preise_brutto,
    summen: {
      netto: euro(s.nettoCent),
      saetze: s.saetze.map((x) => ({ satz: x.satz, netto: euro(x.nettoCent), steuer: euro(x.steuerCent),
        beschriftung: x.satz
          ? (r.preise_brutto ? "darin enthalten: " : "zzgl. ") + x.satz +
            " % Umsatzsteuer auf " + euro(x.nettoCent)
          : "umsatzsteuerfreier Betrag" })),
      brutto: euro(s.bruttoCent),
      nurSteuerfrei: s.steuerCent === 0,
    },
    fehlendeAngaben: pflichtangaben(firmaId, r, positionen),
  });
}

module.exports = {
  liste, einzeln, speichern, entfernen, festschreiben, stornieren, bogen, vorlagen,
  // fuer die Selbstpruefung
  summen, positionNetto, naechsteNummer, pflichtangaben, STEUERHINWEISE, GRUNDLAGEN,
};
