"use strict";
/**
 * Mahnwesen.
 *
 * Offene Posten sagen, welche Rechnung nicht bezahlt ist. Das Mahnwesen sagt,
 * was daraufhin geschieht - und haelt fest, was geschehen ist. Ohne diesen
 * Nachweis steht spaeter Aussage gegen Aussage: wann gemahnt wurde, mit
 * welcher Frist, ueber welchen Betrag.
 *
 * Drei Entscheidungen praegen dieses Modul:
 *
 * 1. Eine Mahnung ist keine Buchung. Mahngebuehren und Verzugszinsen werden
 *    nicht gebucht, wenn der Brief hinausgeht, sondern erst, wenn das Geld
 *    kommt. Wer die Nebenforderung gleich einbucht, hat Forderungen in der
 *    Bilanz, die zum grossen Teil nie bezahlt werden - und muss sie am
 *    Jahresende wieder ausbuchen.
 *
 * 2. Gerechnet wird nachvollziehbar oder gar nicht. Verzugszinsen haengen am
 *    Basiszinssatz nach § 247 BGB, und der aendert sich zum 1. Januar und
 *    1. Juli. Was nicht hinterlegt ist, wird nicht erfunden: Dann steht am
 *    Vorschlag, dass der Satz fortgeschrieben wurde und nachzutragen ist.
 *
 * 3. Gemahnt wird je Zahler und Stufe. Ein Zahler mit Rechnungen in zwei
 *    Stufen bekommt zwei Briefe. Alles in einen Brief zu ziehen hiesse, eine
 *    Rechnung stillschweigend hoeherzustufen, die das noch nicht verdient hat.
 *
 * Was hier NICHT geschieht: das gerichtliche Mahnverfahren. Der Mahnbescheid
 * geht ueber das Mahngericht (online unter mahngericht.de), nicht ueber diese
 * Anwendung. Was sie liefert, ist der Nachweis des Verzugs, den man dafuer
 * braucht.
 */

const { db } = require("./db");
const R = require("./rechte");
const B = require("./buchhaltung");
const OP = require("./offeneposten");

const Verweigert = R.Verweigert;
const json = (status, koerper) => ({ status, koerper });
const w = (v) => (v === undefined || v === "" ? null : v);
const heute = () => new Date().toISOString().slice(0, 10);

/* ---------------------------------------------------------------- Tabellen */

db.exec(`
CREATE TABLE IF NOT EXISTS buch_mahnstufen (
  id           INTEGER PRIMARY KEY,
  firma_id     INTEGER NOT NULL REFERENCES firmen(id) ON DELETE CASCADE,
  stufe        INTEGER NOT NULL,
  bezeichnung  TEXT NOT NULL,
  -- Tage nach Faelligkeit, ab denen diese Stufe faellig wird.
  ab_tagen     INTEGER NOT NULL DEFAULT 0,
  -- Neue Zahlungsfrist im Brief, in Tagen ab Mahndatum.
  frist_tage   INTEGER NOT NULL DEFAULT 10,
  gebuehr_cent INTEGER NOT NULL DEFAULT 0,
  zinsen       INTEGER NOT NULL DEFAULT 0,
  betreff      TEXT NOT NULL,
  text         TEXT NOT NULL,
  schluss      TEXT,
  aktiv        INTEGER NOT NULL DEFAULT 1,
  UNIQUE (firma_id, stufe)
);

-- Basiszinssatz nach § 247 BGB. Er wird zum 1. Januar und 1. Juli von der
-- Deutschen Bundesbank bekanntgegeben. Gespeichert in Hundertstel Prozent:
-- 3,62 % sind 362. Negative Werte kommen vor (2016 bis 2022: -0,88 %).
CREATE TABLE IF NOT EXISTS buch_basiszins (
  gueltig_ab TEXT PRIMARY KEY,
  satz_bp    INTEGER NOT NULL,
  quelle     TEXT,
  erfasst_am TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS buch_mahnungen (
  id             INTEGER PRIMARY KEY,
  firma_id       INTEGER NOT NULL REFERENCES firmen(id) ON DELETE CASCADE,
  nummer         TEXT NOT NULL,
  partner_id     INTEGER NOT NULL REFERENCES buch_partner(id) ON DELETE CASCADE,
  stufe          INTEGER NOT NULL,
  datum          TEXT NOT NULL,
  frist_am       TEXT NOT NULL,
  forderung_cent INTEGER NOT NULL DEFAULT 0,
  gebuehr_cent   INTEGER NOT NULL DEFAULT 0,
  zinsen_cent    INTEGER NOT NULL DEFAULT 0,
  summe_cent     INTEGER NOT NULL DEFAULT 0,
  -- Wurde mit einem fortgeschriebenen Basiszinssatz gerechnet? Dann steht das
  -- auch spaeter noch an der Mahnung, nicht nur im Vorschlag.
  zins_unsicher  INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'offen',
  erledigt_am    TEXT,
  notiz          TEXT,
  angelegt_am    TEXT NOT NULL DEFAULT (datetime('now')),
  angelegt_von   TEXT,
  UNIQUE (firma_id, nummer)
);

CREATE TABLE IF NOT EXISTS buch_mahnpositionen (
  id          INTEGER PRIMARY KEY,
  firma_id    INTEGER NOT NULL REFERENCES firmen(id) ON DELETE CASCADE,
  mahnung_id  INTEGER NOT NULL REFERENCES buch_mahnungen(id) ON DELETE CASCADE,
  rechnung_id INTEGER NOT NULL REFERENCES buch_belege(id) ON DELETE CASCADE,
  offen_cent  INTEGER NOT NULL,
  zins_cent   INTEGER NOT NULL DEFAULT 0,
  zins_tage   INTEGER NOT NULL DEFAULT 0,
  verzug_ab   TEXT
);

CREATE INDEX IF NOT EXISTS ix_mahnungen_firma ON buch_mahnungen(firma_id, status);
CREATE INDEX IF NOT EXISTS ix_mahnpos_rg      ON buch_mahnpositionen(rechnung_id);
`);

/* ------------------------------------------------------------ Basiszinssatz */

/*
 * Vorbelegung. Diese Saetze sind veroeffentlicht und liegen fest - aber sie
 * sind hier abgeschrieben, und abgeschrieben wird falsch. Deshalb stehen sie
 * in einer Tabelle, die man sieht und aendern kann, statt im Programmtext.
 *
 * Neue Halbjahre kommen nicht von selbst dazu: Was fehlt, meldet die
 * Anwendung, statt den letzten Satz stillschweigend weiterzuverwenden.
 */
const BASISZINS_VORLAGE = [
  ["2016-07-01", -88], ["2023-01-01", 162], ["2023-07-01", 312],
  ["2024-01-01", 362], ["2024-07-01", 337], ["2025-01-01", 227],
  ["2025-07-01", 127],
];

if (!db.prepare("SELECT 1 FROM buch_basiszins LIMIT 1").get()) {
  const einf = db.prepare("INSERT INTO buch_basiszins (gueltig_ab, satz_bp, quelle) VALUES (?,?,?)");
  for (const [ab, bp] of BASISZINS_VORLAGE) einf.run(ab, bp, "voreingetragen");
}

function basiszinsListe() {
  return db.prepare("SELECT * FROM buch_basiszins ORDER BY gueltig_ab")
    .all().map((z) => ({ gueltigAb: z.gueltig_ab, satzBp: z.satz_bp, quelle: z.quelle }));
}

/** Beginn des Halbjahres, in dem ein Datum liegt. */
function halbjahrAb(iso) {
  const jahr = iso.slice(0, 4);
  return Number(iso.slice(5, 7)) <= 6 ? jahr + "-01-01" : jahr + "-07-01";
}

/**
 * Basiszinssatz zu einem Datum.
 *
 * Fehlt das Halbjahr, wird der letzte bekannte Satz genommen - aber als
 * fortgeschrieben gekennzeichnet. Rechnen und schweigen waere hier das
 * Schlimmste: Der Zins stuende im Brief, und niemand wuesste, dass er auf
 * einem veralteten Wert beruht.
 */
function satzAm(iso, liste) {
  const alle = liste || basiszinsListe();
  let treffer = null;
  for (const z of alle) if (z.gueltigAb <= iso) treffer = z;
  if (!treffer) {
    return { satzBp: null, gueltigAb: null, fortgeschrieben: true, fehlt: halbjahrAb(iso) };
  }
  const hj = halbjahrAb(iso);
  return { satzBp: treffer.satzBp, gueltigAb: treffer.gueltigAb,
    fortgeschrieben: treffer.gueltigAb < hj, fehlt: treffer.gueltigAb < hj ? hj : null };
}

function basiszinsSetzen(sitzung, d) {
  R.fordereSchreiben(sitzung, "buchhaltung");
  const ab = String(d.gueltigAb || "");
  if (!/^\d{4}-(01-01|07-01)$/.test(ab)) {
    throw new Verweigert("Der Basiszinssatz gilt ab dem 1. Januar oder dem 1. Juli eines Jahres.", 400);
  }
  const satz = Number(d.satzProzent);
  if (!Number.isFinite(satz) || satz < -10 || satz > 25) {
    throw new Verweigert("Bitte den Satz in Prozent angeben, z. B. 3,62.", 400);
  }
  const bp = Math.round(satz * 100);
  db.prepare(`INSERT INTO buch_basiszins (gueltig_ab, satz_bp, quelle) VALUES (?,?,?)
              ON CONFLICT(gueltig_ab) DO UPDATE SET satz_bp = excluded.satz_bp, quelle = excluded.quelle`)
    .run(ab, bp, "eingetragen von " + sitzung.anmeldename);
  B.protokoll(sitzung, ab, "Basiszinssatz eingetragen", ab + ": " + (bp / 100).toFixed(2) + " %");
  return json(200, { gueltigAb: ab, satzBp: bp });
}

/* ------------------------------------------------------------ Zeitrechnung */

const TAG = 86400000;
const alsZahl = (iso) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
const alsText = (ms) => new Date(ms).toISOString().slice(0, 10);
const tageZwischen = (a, b) => Math.round((alsZahl(b) - alsZahl(a)) / TAG);
const plusTage = (iso, n) => alsText(alsZahl(iso) + n * TAG);
const tageImJahr = (jahr) => ((jahr % 4 === 0 && jahr % 100 !== 0) || jahr % 400 === 0 ? 366 : 365);

/* -------------------------------------------------------------- Verzug */

/**
 * Ab wann ist der Schuldner in Verzug?
 *
 * Zwei Wege, § 286 BGB:
 *   - Steht ein Faelligkeitsdatum fest, tritt Verzug mit dessen Ablauf ein -
 *     Zinsen laufen ab dem Folgetag (Abs. 2 Nr. 1).
 *   - Sonst 30 Tage nach Zugang der Rechnung (Abs. 3). Als Zugang gilt hier
 *     das Rechnungsdatum; wer es genauer weiss, traegt eine Faelligkeit ein.
 *
 * Bei Verbrauchern gilt der 30-Tage-Automatismus nur, wenn in der Rechnung
 * darauf hingewiesen wurde. Das kann die Anwendung nicht wissen - deshalb
 * steht der Hinweis am Vorschlag, statt die Frage zu uebergehen.
 */
function verzugsbeginn(rechnung) {
  if (rechnung.faelligAm) {
    return { ab: plusTage(rechnung.faelligAm, 1),
      grund: "Fälligkeit am " + rechnung.faelligAm + " (§ 286 Abs. 2 Nr. 1 BGB)" };
  }
  return { ab: plusTage(rechnung.datum, 31),
    grund: "30 Tage nach Rechnungsdatum " + rechnung.datum + " (§ 286 Abs. 3 BGB)" };
}

/**
 * Verzugszinsen, taggenau und nach Halbjahren zerlegt.
 *
 * Der Zinssatz ist der Basiszinssatz zuzueglich 9 Prozentpunkten bei
 * Rechtsgeschaeften ohne Verbraucherbeteiligung (§ 288 Abs. 2 BGB) und
 * zuzueglich 5 Prozentpunkten sonst (Abs. 1). Weil der Basiszinssatz sich
 * halbjaehrlich aendert, wird abschnittsweise gerechnet - ein Jahresdurch-
 * schnitt waere schlicht falsch.
 *
 * Der erste Tag zaehlt nicht mit, der letzte schon. Das ist die fuer den
 * Schuldner guenstigere Lesart; bei einem Streit um einen Tag Zins hat noch
 * niemand gewonnen, bei einer zu hohen Forderung dagegen schon verloren.
 */
function zinsen(centBetrag, verzugAb, bis, verbraucher, liste) {
  const aufschlagBp = verbraucher ? 500 : 900;
  if (!centBetrag || tageZwischen(verzugAb, bis) <= 0) {
    return { centZins: 0, tage: 0, abschnitte: [], unsicher: false, fehlend: [], aufschlagBp };
  }
  const alle = liste || basiszinsListe();
  const abschnitte = [];
  const fehlend = [];
  let zeiger = verzugAb;
  let summe = 0;

  while (tageZwischen(zeiger, bis) > 0) {
    const s = satzAm(zeiger, alle);
    // Ende des Halbjahres, in dem der Zeiger steht.
    const hj = halbjahrAb(zeiger);
    const naechstesHj = hj.slice(5) === "01-01" ? hj.slice(0, 4) + "-07-01" : (Number(hj.slice(0, 4)) + 1) + "-01-01";
    const ende = naechstesHj < bis ? naechstesHj : bis;
    const tage = tageZwischen(zeiger, ende);
    const jahr = Number(zeiger.slice(0, 4));
    const satzBp = (s.satzBp === null ? 0 : s.satzBp) + aufschlagBp;
    const betrag = (centBetrag * (satzBp / 10000) * tage) / tageImJahr(jahr);
    summe += betrag;
    abschnitte.push({ von: zeiger, bis: ende, tage, basisBp: s.satzBp, satzBp,
      centZins: Math.round(betrag), fortgeschrieben: s.fortgeschrieben });
    if (s.fortgeschrieben && !fehlend.includes(s.fehlt)) fehlend.push(s.fehlt);
    zeiger = ende;
  }

  return { centZins: Math.round(summe), tage: tageZwischen(verzugAb, bis),
    abschnitte, unsicher: fehlend.length > 0, fehlend, aufschlagBp };
}

/* ----------------------------------------------------------- Mahnstufen */

/*
 * Vorlage der Mahnstufen.
 *
 * Die Gebuehr steht bewusst auf null. Ersatzfaehig ist nur der tatsaechliche
 * Verzugsschaden - Porto und Papier, also etwa ein Euro. Wer pauschal fuenf
 * oder zehn Euro ansetzt, hat bei Verbrauchern eine angreifbare Forderung und
 * bei Krankenkassen ohnehin eine, die nicht bezahlt wird. Wer es anders
 * haelt, traegt es ein; vorgegeben wird es nicht.
 *
 * Drei Mahnungen sind uebrigens nirgends vorgeschrieben. Eine genuegt, um in
 * Verzug zu setzen, und bei einem festen Faelligkeitstag braucht es nicht
 * einmal die. Die drei Stufen sind Gepflogenheit, kein Recht.
 */
const STUFEN_VORLAGE = [
  { stufe: 1, bezeichnung: "Zahlungserinnerung", abTagen: 3, fristTage: 10, gebuehrCent: 0, zinsen: 0,
    betreff: "Zahlungserinnerung",
    text: "sicher ist es Ihrer Aufmerksamkeit nur entgangen: Die folgenden Rechnungen sind noch offen. " +
      "Sollten Sie die Zahlung bereits veranlasst haben, betrachten Sie dieses Schreiben bitte als gegenstandslos.",
    schluss: "Wir bitten um Ausgleich bis zum {frist}." },
  { stufe: 2, bezeichnung: "1. Mahnung", abTagen: 14, fristTage: 10, gebuehrCent: 0, zinsen: 1,
    betreff: "1. Mahnung",
    text: "trotz unserer Zahlungserinnerung sind die folgenden Rechnungen bis heute nicht ausgeglichen. " +
      "Wir fordern Sie hiermit auf, den offenen Betrag zu begleichen.",
    schluss: "Bitte überweisen Sie den Gesamtbetrag bis zum {frist}." },
  { stufe: 3, bezeichnung: "2. Mahnung", abTagen: 30, fristTage: 7, gebuehrCent: 0, zinsen: 1,
    betreff: "2. und letzte Mahnung",
    text: "auf unsere bisherigen Schreiben haben Sie nicht reagiert. Die folgenden Rechnungen sind " +
      "weiterhin offen.",
    schluss: "Wir setzen Ihnen eine letzte Frist bis zum {frist}. Nach fruchtlosem Ablauf behalten wir " +
      "uns weitere Schritte vor." },
];

function stufenSicherstellen(firmaId) {
  const da = db.prepare("SELECT COUNT(*) AS n FROM buch_mahnstufen WHERE firma_id = ?").get(firmaId).n;
  if (da) return;
  const einf = db.prepare(`INSERT INTO buch_mahnstufen
    (firma_id, stufe, bezeichnung, ab_tagen, frist_tage, gebuehr_cent, zinsen, betreff, text, schluss)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  for (const s of STUFEN_VORLAGE) {
    einf.run(firmaId, s.stufe, s.bezeichnung, s.abTagen, s.fristTage, s.gebuehrCent, s.zinsen,
      s.betreff, s.text, s.schluss);
  }
}

function stufenLesen(firmaId) {
  stufenSicherstellen(firmaId);
  return db.prepare("SELECT * FROM buch_mahnstufen WHERE firma_id = ? ORDER BY stufe").all(firmaId)
    .map((s) => ({ id: s.id, stufe: s.stufe, bezeichnung: s.bezeichnung, abTagen: s.ab_tagen,
      fristTage: s.frist_tage, gebuehrCent: s.gebuehr_cent, zinsen: !!s.zinsen,
      betreff: s.betreff, text: s.text, schluss: s.schluss, aktiv: !!s.aktiv }));
}

function stufen(sitzung) {
  R.fordereLesen(sitzung, "buchhaltung");
  return json(200, { stufen: stufenLesen(sitzung.firmaId), basiszins: basiszinsListe() });
}

function stufeSpeichern(sitzung, stufe, d) {
  R.fordereSchreiben(sitzung, "buchhaltung");
  const n = Number(stufe);
  const alt = db.prepare("SELECT * FROM buch_mahnstufen WHERE firma_id = ? AND stufe = ?")
    .get(sitzung.firmaId, n);
  if (!alt) throw new Verweigert("Diese Mahnstufe gibt es nicht.", 404);

  const zahl = (v, vorgabe, min, max) => {
    const x = Number(v);
    return Number.isFinite(x) && x >= min && x <= max ? Math.round(x) : vorgabe;
  };
  const gebuehr = zahl(d.gebuehrCent, alt.gebuehr_cent, 0, 100000);
  /*
   * Eine Mahngebuehr ueber dem tatsaechlichen Aufwand ist kein Ertrag, sondern
   * ein Streitpunkt. Zehn Euro sind dafuer die Schmerzgrenze; darueber wird
   * widersprochen, statt bezahlt.
   */
  if (gebuehr > 1000) {
    throw new Verweigert("Ersatzfähig ist nur der tatsächliche Verzugsschaden — Porto und Papier. " +
      "Mehr als 10,00 € sind kaum zu begründen.", 400);
  }
  db.prepare(`UPDATE buch_mahnstufen SET bezeichnung=?, ab_tagen=?, frist_tage=?, gebuehr_cent=?,
      zinsen=?, betreff=?, text=?, schluss=?, aktiv=? WHERE firma_id=? AND stufe=?`)
    .run(String(d.bezeichnung || alt.bezeichnung).slice(0, 60),
      zahl(d.abTagen, alt.ab_tagen, 0, 3650), zahl(d.fristTage, alt.frist_tage, 1, 90),
      gebuehr, d.zinsen ? 1 : 0,
      String(d.betreff || alt.betreff).slice(0, 120),
      String(d.text || alt.text).slice(0, 4000),
      w(d.schluss) === null ? alt.schluss : String(d.schluss).slice(0, 2000),
      d.aktiv === false ? 0 : 1, sitzung.firmaId, n);
  B.protokoll(sitzung, n, "Mahnstufe geändert", "Stufe " + n);
  return json(200, { stufe: n });
}

/* ----------------------------------------------------------- Vorschlaege */

/** Bisher hoechste Mahnstufe je Rechnung, und wann zuletzt gemahnt wurde. */
function bisherGemahnt(firmaId) {
  const rows = db.prepare(`
    SELECT p.rechnung_id AS rid, MAX(m.stufe) AS stufe, MAX(m.datum) AS datum, MAX(m.frist_am) AS frist
      FROM buch_mahnpositionen p
      JOIN buch_mahnungen m ON m.id = p.mahnung_id
     WHERE p.firma_id = ? AND m.status <> 'zurückgenommen'
     GROUP BY p.rechnung_id`).all(firmaId);
  const karte = new Map();
  for (const r of rows) karte.set(r.rid, { stufe: r.stufe, datum: r.datum, frist: r.frist });
  return karte;
}

/**
 * Was ist mahnfaellig?
 *
 * Eine Rechnung kommt in den Vorschlag, wenn drei Dinge zutreffen: Sie ist
 * ueberfaellig, die naechste Stufe ist nach ihrer Wartezeit erreicht, und die
 * Frist der letzten Mahnung ist abgelaufen. Das dritte ist das wichtigste -
 * zweimal in einer Woche zu mahnen macht keinen Eindruck, sondern Aerger.
 */
function vorschlaege(sitzung, d) {
  R.fordereLesen(sitzung, "buchhaltung");
  const firmaId = sitzung.firmaId;
  const stichtag = /^\d{4}-\d{2}-\d{2}$/.test(d && d.stichtag) ? d.stichtag : heute();
  const stufenliste = stufenLesen(firmaId).filter((s) => s.aktiv);
  const zinsliste = basiszinsListe();
  const gemahnt = bisherGemahnt(firmaId);
  const partner = new Map(db.prepare("SELECT * FROM buch_partner WHERE firma_id = ?").all(firmaId)
    .map((p) => [p.id, p]));

  const offen = OP.rechnungen(firmaId, stichtag)
    .filter((r) => r.art === "Ausgangsrechnung" && r.offenCent > 0);

  const gruppen = new Map();
  const uebergangen = [];

  for (const r of offen) {
    if (!r.partnerId) {
      uebergangen.push({ belegnummer: r.belegnummer, offenCent: r.offenCent,
        grund: "kein Geschäftspartner hinterlegt — ohne Anschrift lässt sich nicht mahnen" });
      continue;
    }
    const p = partner.get(r.partnerId);
    if (!p) continue;

    const bisher = gemahnt.get(r.id);
    const naechste = (bisher ? bisher.stufe : 0) + 1;
    const stufe = stufenliste.find((s) => s.stufe === naechste);
    if (!stufe) {
      if (bisher) {
        uebergangen.push({ belegnummer: r.belegnummer, partner: p.name, offenCent: r.offenCent,
          grund: "höchste Mahnstufe erreicht — hier hilft nur noch das gerichtliche Mahnverfahren " +
            "oder ein Inkassoauftrag" });
      }
      continue;
    }
    if (r.tageOffen < stufe.abTagen) continue;
    if (bisher && bisher.frist >= stichtag) {
      uebergangen.push({ belegnummer: r.belegnummer, partner: p.name, offenCent: r.offenCent,
        grund: "die Frist der letzten Mahnung läuft noch bis " + bisher.frist });
      continue;
    }

    const vb = verzugsbeginn(r);
    const z = stufe.zinsen
      ? zinsen(r.offenCent, vb.ab, stichtag, !!p.verbraucher, zinsliste)
      : { centZins: 0, tage: 0, abschnitte: [], unsicher: false, fehlend: [], aufschlagBp: 0 };

    const schluessel = p.id + "/" + stufe.stufe;
    if (!gruppen.has(schluessel)) {
      gruppen.set(schluessel, {
        partnerId: p.id, partner: p.name, partnerKonto: p.konto,
        anschriftVollstaendig: !!(p.strasse && p.plz && p.ort),
        verbraucher: !!p.verbraucher,
        stufe: stufe.stufe, stufeName: stufe.bezeichnung,
        gebuehrCent: stufe.gebuehrCent, fristTage: stufe.fristTage,
        fristAm: plusTage(stichtag, stufe.fristTage),
        positionen: [], forderungCent: 0, zinsenCent: 0, zinsUnsicher: false, fehlendeZinssaetze: [],
      });
    }
    const g = gruppen.get(schluessel);
    g.positionen.push({
      rechnungId: r.id, belegnummer: r.belegnummer, datum: r.datum, faelligAm: r.faelligAm,
      bruttoCent: r.bruttoCent, offenCent: r.offenCent, tageOffen: r.tageOffen,
      teilbezahlt: r.ausgeglichenCent > 0,
      verzugAb: vb.ab, verzugGrund: vb.grund,
      zinsTage: z.tage, zinsCent: z.centZins, zinsAbschnitte: z.abschnitte,
    });
    g.forderungCent += r.offenCent;
    g.zinsenCent += z.centZins;
    if (z.unsicher) {
      g.zinsUnsicher = true;
      for (const f of z.fehlend) if (!g.fehlendeZinssaetze.includes(f)) g.fehlendeZinssaetze.push(f);
    }
  }

  const liste = Array.from(gruppen.values())
    .map((g) => Object.assign(g, { summeCent: g.forderungCent + g.zinsenCent + g.gebuehrCent }))
    .sort((a, b) => b.stufe - a.stufe || b.summeCent - a.summeCent);

  /*
   * Verjaehrung. Der Regelfall: drei Jahre, gerechnet ab dem Schluss des
   * Jahres, in dem die Forderung entstanden ist (§§ 195, 199 BGB). Fuer
   * Forderungen gegen Sozialleistungstraeger gelten teils andere Fristen -
   * deshalb ist das ein Hinweis und keine Berechnung.
   */
  const jahr = Number(stichtag.slice(0, 4));
  const verjaehrung = offen.filter((r) => Number(r.datum.slice(0, 4)) <= jahr - 3)
    .map((r) => ({ belegnummer: r.belegnummer, datum: r.datum, partner: r.partner,
      offenCent: r.offenCent, verjaehrtZum: (Number(r.datum.slice(0, 4)) + 3) + "-12-31" }));

  const zinsLuecke = satzAm(stichtag, zinsliste);
  /*
   * Alle Halbjahre, fuer die ein Satz fehlt - nicht nur das laufende. Der
   * Verzug reicht bei alten Forderungen weit zurueck, und ein Halbjahr in der
   * Mitte genuegt, damit die ganze Zinsrechnung auf Sand steht.
   */
  const fehlendeHalbjahre = [];
  for (const g of liste) {
    for (const f of g.fehlendeZinssaetze) if (!fehlendeHalbjahre.includes(f)) fehlendeHalbjahre.push(f);
  }
  fehlendeHalbjahre.sort();

  /*
   * Und die Luecke insgesamt: jedes Halbjahr zwischen dem letzten
   * hinterlegten Satz und dem Stichtag. Auch wenn heute noch keine Mahnung
   * so weit zurueckreicht - nachtragen laesst sich das nur, wenn es dasteht.
   */
  const luecken = [];
  if (zinsliste.length) {
    let hj = zinsliste[zinsliste.length - 1].gueltigAb;
    const bisHj = halbjahrAb(stichtag);
    while (hj < bisHj) {
      hj = hj.slice(5) === "01-01" ? hj.slice(0, 4) + "-07-01" : (Number(hj.slice(0, 4)) + 1) + "-01-01";
      luecken.push(hj);
    }
  }

  return json(200, {
    stichtag,
    vorschlaege: liste,
    uebergangen,
    verjaehrung,
    summe: {
      anzahl: liste.length,
      forderungCent: liste.reduce((s, g) => s + g.forderungCent, 0),
      zinsenCent: liste.reduce((s, g) => s + g.zinsenCent, 0),
      gebuehrCent: liste.reduce((s, g) => s + g.gebuehrCent, 0),
    },
    basiszins: { liste: zinsliste, aktuell: zinsLuecke,
      fehltAb: zinsLuecke.fortgeschrieben ? zinsLuecke.fehlt : null,
      fehlend: fehlendeHalbjahre, luecken },
  });
}

/* -------------------------------------------------------------- Erstellen */

function naechsteNummer(firmaId, datum) {
  const jahr = datum.slice(0, 4);
  const letzte = db.prepare(`SELECT nummer FROM buch_mahnungen WHERE firma_id = ? AND nummer LIKE ?
                             ORDER BY nummer DESC LIMIT 1`).get(firmaId, "M" + jahr + "-%");
  const n = letzte ? Number(letzte.nummer.slice(6)) + 1 : 1;
  return "M" + jahr + "-" + String(n).padStart(4, "0");
}

/**
 * Legt die ausgewaehlten Mahnungen an.
 *
 * Gerechnet wird hier noch einmal von vorn, nicht aus dem Vorschlag
 * uebernommen: Zwischen Anzeigen und Anlegen kann eine Zahlung eingegangen
 * sein, und eine Mahnung ueber einen bereits bezahlten Betrag ist der
 * teuerste Fehler, den dieses Modul machen kann.
 */
function erstellen(sitzung, d) {
  R.fordereSchreiben(sitzung, "buchhaltung");
  const firmaId = sitzung.firmaId;
  const stichtag = /^\d{4}-\d{2}-\d{2}$/.test(d && d.stichtag) ? d.stichtag : heute();
  const auswahl = Array.isArray(d && d.auswahl) ? d.auswahl : [];
  if (!auswahl.length) throw new Verweigert("Es ist nichts ausgewählt.", 400);

  const frisch = vorschlaege(sitzung, { stichtag }).koerper.vorschlaege;
  const angelegt = [];
  const abgelehnt = [];

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const a of auswahl) {
      const g = frisch.find((x) => String(x.partnerId) === String(a.partnerId) &&
        Number(x.stufe) === Number(a.stufe));
      if (!g) {
        abgelehnt.push({ partnerId: a.partnerId, stufe: a.stufe,
          grund: "inzwischen nicht mehr mahnfähig — vermutlich ist die Zahlung eingegangen" });
        continue;
      }
      // Nur die tatsaechlich gewuenschten Rechnungen, aber keine, die im
      // frischen Vorschlag fehlt.
      const gewuenscht = Array.isArray(a.rechnungIds) && a.rechnungIds.length
        ? g.positionen.filter((p) => a.rechnungIds.map(String).includes(String(p.rechnungId)))
        : g.positionen;
      if (!gewuenscht.length) {
        abgelehnt.push({ partnerId: a.partnerId, stufe: a.stufe,
          grund: "keine der ausgewählten Rechnungen ist noch offen" });
        continue;
      }

      const forderung = gewuenscht.reduce((s, p) => s + p.offenCent, 0);
      const zins = gewuenscht.reduce((s, p) => s + p.zinsCent, 0);
      const gebuehr = g.gebuehrCent;
      const nummer = naechsteNummer(firmaId, stichtag);
      const id = db.prepare(`INSERT INTO buch_mahnungen
        (firma_id, nummer, partner_id, stufe, datum, frist_am, forderung_cent, gebuehr_cent,
         zinsen_cent, summe_cent, zins_unsicher, angelegt_von)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(firmaId, nummer, g.partnerId, g.stufe, stichtag, g.fristAm, forderung, gebuehr,
          zins, forderung + zins + gebuehr, g.zinsUnsicher ? 1 : 0, sitzung.anmeldename).lastInsertRowid;

      const einf = db.prepare(`INSERT INTO buch_mahnpositionen
        (firma_id, mahnung_id, rechnung_id, offen_cent, zins_cent, zins_tage, verzug_ab)
        VALUES (?,?,?,?,?,?,?)`);
      for (const p of gewuenscht) {
        einf.run(firmaId, id, p.rechnungId, p.offenCent, p.zinsCent, p.zinsTage, p.verzugAb);
      }
      B.protokoll(sitzung, nummer, "Mahnung erstellt",
        g.stufeName + " an " + g.partner + " über " + ((forderung + zins + gebuehr) / 100).toFixed(2) + " €");
      angelegt.push({ id, nummer, partner: g.partner, stufe: g.stufe,
        summeCent: forderung + zins + gebuehr });
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  return json(201, { angelegt, abgelehnt });
}

/* ------------------------------------------------------------------ Liste */

function mahnungLesen(firmaId, id) {
  const m = db.prepare(`
    SELECT m.*, p.name AS partner_name, p.konto AS partner_konto, p.strasse, p.plz, p.ort, p.land,
           p.verbraucher
      FROM buch_mahnungen m JOIN buch_partner p ON p.id = m.partner_id
     WHERE m.id = ? AND m.firma_id = ?`).get(id, firmaId);
  if (!m) throw new Verweigert("Mahnung nicht gefunden.", 404);
  const pos = db.prepare(`
    SELECT mp.*, b.belegnummer, b.datum, b.faellig_am, b.brutto_cent, b.buchungstext
      FROM buch_mahnpositionen mp JOIN buch_belege b ON b.id = mp.rechnung_id
     WHERE mp.mahnung_id = ? ORDER BY b.datum, b.belegnummer`).all(id);
  return { m, pos };
}

function nachAussen(m, pos) {
  return {
    id: m.id, nummer: m.nummer, stufe: m.stufe, datum: m.datum, fristAm: m.frist_am,
    partnerId: m.partner_id, partner: m.partner_name, partnerKonto: m.partner_konto,
    anschrift: { strasse: m.strasse, plz: m.plz, ort: m.ort, land: m.land },
    verbraucher: !!m.verbraucher,
    forderungCent: m.forderung_cent, gebuehrCent: m.gebuehr_cent, zinsenCent: m.zinsen_cent,
    summeCent: m.summe_cent, zinsUnsicher: !!m.zins_unsicher,
    status: m.status, erledigtAm: m.erledigt_am, notiz: m.notiz,
    angelegtAm: m.angelegt_am, angelegtVon: m.angelegt_von,
    positionen: (pos || []).map((p) => ({
      rechnungId: p.rechnung_id, belegnummer: p.belegnummer, datum: p.datum, faelligAm: p.faellig_am,
      bruttoCent: p.brutto_cent, offenCent: p.offen_cent, zinsCent: p.zins_cent,
      zinsTage: p.zins_tage, verzugAb: p.verzug_ab, buchungstext: p.buchungstext,
    })),
  };
}

function liste(sitzung, d) {
  R.fordereLesen(sitzung, "buchhaltung");
  const firmaId = sitzung.firmaId;
  const status = d && d.status;
  const wo = status ? " AND m.status = ?" : "";
  const rows = db.prepare(`
    SELECT m.*, p.name AS partner_name, p.konto AS partner_konto, p.strasse, p.plz, p.ort, p.land,
           p.verbraucher
      FROM buch_mahnungen m JOIN buch_partner p ON p.id = m.partner_id
     WHERE m.firma_id = ?` + wo + " ORDER BY m.datum DESC, m.id DESC LIMIT 500")
    .all(...(status ? [firmaId, status] : [firmaId]));

  /*
   * Was ist aus der Mahnung geworden? Eine Mahnung, die niemand nachhaelt, ist
   * nur Papier. Deshalb steht an jeder, wie viel von den gemahnten Rechnungen
   * inzwischen bezahlt ist - und ob die Frist abgelaufen ist.
   */
  const heuteIso = heute();
  return json(200, { wert: rows.map((m) => {
    const pos = db.prepare(`
      SELECT mp.*, b.belegnummer, b.datum, b.faellig_am, b.brutto_cent, b.buchungstext,
             COALESCE((SELECT SUM(a.betrag_cent) FROM buch_ausgleich a WHERE a.rechnung_id = mp.rechnung_id), 0) AS ausgeglichen
        FROM buch_mahnpositionen mp JOIN buch_belege b ON b.id = mp.rechnung_id
       WHERE mp.mahnung_id = ? ORDER BY b.datum`).all(m.id);
    const nochOffen = pos.reduce((s, p) => s + Math.max(0, p.brutto_cent - p.ausgeglichen), 0);
    return Object.assign(nachAussen(m, pos), {
      nochOffenCent: nochOffen,
      bezahltCent: m.forderung_cent - nochOffen,
      vollBezahlt: nochOffen === 0,
      fristAbgelaufen: m.status === "offen" && m.frist_am < heuteIso,
    });
  }) });
}

function erledigen(sitzung, id, d) {
  R.fordereSchreiben(sitzung, "buchhaltung");
  const { m } = mahnungLesen(sitzung.firmaId, id);
  if (m.status !== "offen") throw new Verweigert("Diese Mahnung ist bereits abgeschlossen.", 409);
  db.prepare("UPDATE buch_mahnungen SET status='erledigt', erledigt_am=date('now'), notiz=? WHERE id=?")
    .run(w(d && d.notiz), m.id);
  B.protokoll(sitzung, m.nummer, "Mahnung erledigt", (d && d.notiz) || "");
  return json(200, { id: m.id, status: "erledigt" });
}

/**
 * Nimmt eine Mahnung zurueck.
 *
 * Geloescht wird nichts - der Vorgang bleibt mit Begruendung stehen. Sonst
 * liesse sich hinterher nicht mehr erkennen, ob eine Rechnung schon einmal
 * gemahnt wurde, und die Stufenzaehlung finge von vorne an.
 */
function zuruecknehmen(sitzung, id, d) {
  R.fordereSchreiben(sitzung, "buchhaltung");
  const { m } = mahnungLesen(sitzung.firmaId, id);
  const grund = String((d && d.grund) || "").trim();
  if (!grund) throw new Verweigert("Bitte angeben, warum die Mahnung zurückgenommen wird.", 400);
  db.prepare("UPDATE buch_mahnungen SET status='zurückgenommen', erledigt_am=date('now'), notiz=? WHERE id=?")
    .run(grund, m.id);
  B.protokoll(sitzung, m.nummer, "Mahnung zurückgenommen", grund);
  return json(200, { id: m.id, status: "zurückgenommen" });
}

/* ------------------------------------------------------------------ Brief */

const euro = (cent) => (cent / 100).toFixed(2).replace(".", ",") + " €";
const tag = (iso) => (iso ? iso.slice(8, 10) + "." + iso.slice(5, 7) + "." + iso.slice(0, 4) : "");

/**
 * Der Mahnbrief als Text.
 *
 * Erzeugt wird er hier und nicht in der Oberflaeche, damit gedruckter Brief,
 * Vorschau und Nachweis denselben Wortlaut haben. Der Bogen ist fuer
 * Firmenbriefpapier gedacht: Absender, Logo und Fusszeile stehen dort schon.
 */
function brief(sitzung, id) {
  R.fordereLesen(sitzung, "buchhaltung");
  const { m, pos } = mahnungLesen(sitzung.firmaId, id);
  const e = B.einstellungen(sitzung.firmaId);
  const stufe = stufenLesen(sitzung.firmaId).find((s) => s.stufe === m.stufe) ||
    { betreff: "Mahnung", text: "", schluss: "", bezeichnung: "Mahnung" };

  const anschrift = [m.partner_name, m.strasse, [m.plz, m.ort].filter(Boolean).join(" "),
    m.land && m.land !== "DE" ? m.land : null].filter(Boolean);

  const zeilen = pos.map((p) => ({
    belegnummer: p.belegnummer, datum: tag(p.datum),
    faellig: tag(p.faellig_am || p.datum), offen: euro(p.offen_cent),
    zins: p.zins_cent ? euro(p.zins_cent) : "",
    zinsTage: p.zins_tage,
  }));

  const fuellen = (t) => String(t || "")
    .replace(/\{frist\}/g, tag(m.frist_am))
    .replace(/\{partner\}/g, m.partner_name)
    .replace(/\{summe\}/g, euro(m.summe_cent));

  const text = [
    anschrift.join("\n"),
    "",
    tag(m.datum),
    "",
    fuellen(stufe.betreff),
    "",
    "Sehr geehrte Damen und Herren,",
    "",
    fuellen(stufe.text),
    "",
    zeilen.map((z) => "  " + z.belegnummer + "  vom " + z.datum + "  fällig " + z.faellig +
      "  " + z.offen + (z.zins ? "  zzgl. Zinsen " + z.zins + " (" + z.zinsTage + " Tage)" : "")).join("\n"),
    "",
    "  Rechnungsbetrag offen: " + euro(m.forderung_cent),
    m.zinsen_cent ? "  Verzugszinsen:         " + euro(m.zinsen_cent) : null,
    m.gebuehr_cent ? "  Mahnkosten:            " + euro(m.gebuehr_cent) : null,
    "  Gesamtbetrag:          " + euro(m.summe_cent),
    "",
    fuellen(stufe.schluss),
    e.zahlungsdaten ? "\n" + e.zahlungsdaten : null,
    "",
    "Mit freundlichen Grüßen",
    e.unterzeichner || null,
  ].filter((z) => z !== null).join("\n");

  return json(200, {
    mahnung: nachAussen(m, pos),
    betreff: fuellen(stufe.betreff),
    einleitung: fuellen(stufe.text),
    schluss: fuellen(stufe.schluss),
    anschrift,
    absender: e.absender || null,
    zahlungsdaten: e.zahlungsdaten || null,
    unterzeichner: e.unterzeichner || null,
    zeilen,
    text,
  });
}

module.exports = {
  vorschlaege, erstellen, liste, erledigen, zuruecknehmen, brief,
  stufen, stufeSpeichern, basiszinsSetzen, basiszinsListe,
  // fuer die Selbstpruefung
  zinsen, satzAm, verzugsbeginn, halbjahrAb, plusTage, tageZwischen, stufenLesen,
};
