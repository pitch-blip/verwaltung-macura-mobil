"use strict";
/**
 * Zuordnungsregeln fuer Bankumsaetze.
 *
 * Ein Teil der Umsaetze wiederholt sich Monat fuer Monat: Miete, Telefon,
 * Stadtwerke, Kontofuehrung, Versicherungen. Dabei ist jedes Mal dieselbe
 * Entscheidung zu treffen, und jedes Mal kann sie anders ausfallen - mal
 * landet die Miete auf 6310, mal auf 6300, und am Jahresende passt die
 * Auswertung nicht mehr zusammen.
 *
 * Eine Regel haelt diese Entscheidung fest: Woran der Umsatz zu erkennen ist,
 * und was dann gebucht werden soll. Angelegt wird sie am besten dort, wo die
 * Entscheidung ohnehin faellt - beim ersten Zuordnen.
 *
 * Zwei Grundsaetze:
 *
 *   Eine Regel schlaegt vor, sie bucht nicht.  Vorausgewaehlt wird, bestaetigt
 *   wird von Hand. Nur wo ausdruecklich "ohne Rueckfrage" gesetzt ist, darf
 *   die Sammelfunktion buchen - und auch das ist ein eigener Knopf, kein
 *   stilles Mitlaufen beim Einlesen.
 *
 *   Jede Regel begruendet sich.  Es steht dabei, warum sie greift. Ein
 *   Vorschlag ohne Begruendung waere ein Orakel, und wer ihm folgt, ohne ihn
 *   zu verstehen, bucht irgendwann falsch.
 */

const { db } = require("./db");
const R = require("./rechte");
const B = require("./buchhaltung");

const Verweigert = R.Verweigert;
const json = (status, koerper) => ({ status, koerper });

db.exec(`
CREATE TABLE IF NOT EXISTS buch_regeln (
  id             INTEGER PRIMARY KEY,
  firma_id       INTEGER NOT NULL REFERENCES firmen(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  -- Woran der Umsatz erkannt wird. Was leer bleibt, wird nicht geprueft;
  -- angegebene Merkmale muessen alle zutreffen.
  richtung       TEXT,
  iban           TEXT,
  name_enthaelt  TEXT,
  zweck_enthaelt TEXT,
  betrag_cent    INTEGER,
  -- Was dann gebucht wird.
  gegenkonto     TEXT,
  partner_id     INTEGER REFERENCES buch_partner(id) ON DELETE SET NULL,
  art            TEXT,
  steuersatz     INTEGER NOT NULL DEFAULT 0,
  bu             TEXT,
  buchungstext   TEXT,
  automatisch    INTEGER NOT NULL DEFAULT 0,
  sortierung     INTEGER NOT NULL DEFAULT 99,
  aktiv          INTEGER NOT NULL DEFAULT 1,
  treffer        INTEGER NOT NULL DEFAULT 0,
  zuletzt_am     TEXT,
  angelegt_am    TEXT NOT NULL DEFAULT (datetime('now')),
  angelegt_von   TEXT
);
CREATE INDEX IF NOT EXISTS ix_buch_regeln ON buch_regeln(firma_id, aktiv, sortierung);
`);

/**
 * Auf das Wesentliche gekuerzt, damit "Karl Muster GmbH und Co. KG" und
 * "Fa. Muster GmbH & Co. KG" als derselbe Zahlungsbeteiligte gelten -
 * Banken schreiben denselben Namen selten zweimal gleich.
 */
function normal(text) {
  return String(text || "").toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .replace(/\b(gmbh|ag|kg|ohg|ug|mbh|e\.?v\.?|co|und|the|fa)\b/g, " ")
    .replace(/[^a-z0-9]/g, "");
}

const w = (v) => {
  const s = String(v === undefined || v === null ? "" : v).trim();
  return s === "" ? null : s;
};

/* --------------------------------------------------------------- Auswahl */

function nachAussen(r) {
  return { id: r.id, name: r.name, richtung: r.richtung, iban: r.iban,
    nameEnthaelt: r.name_enthaelt, zweckEnthaelt: r.zweck_enthaelt, betragCent: r.betrag_cent,
    gegenkonto: r.gegenkonto, partnerId: r.partner_id, art: r.art,
    steuersatz: r.steuersatz, bu: r.bu, buchungstext: r.buchungstext,
    ziel: r.gegenkonto ? "Sachkonto" : "Zahler",
    automatisch: !!r.automatisch, sortierung: r.sortierung, aktiv: !!r.aktiv,
    treffer: r.treffer, zuletztAm: r.zuletzt_am,
    kontoBezeichnung: r.konto_bezeichnung || null, partner: r.partner_name || null };
}

function liste(sitzung) {
  R.fordereLesen(sitzung, "buchhaltung");
  return db.prepare(`
    SELECT r.*, k.bezeichnung AS konto_bezeichnung, p.name AS partner_name
      FROM buch_regeln r
      LEFT JOIN buch_konten k ON k.firma_id = r.firma_id AND k.nummer = r.gegenkonto
      LEFT JOIN buch_partner p ON p.id = r.partner_id
     WHERE r.firma_id = ? ORDER BY r.sortierung, r.id`).all(sitzung.firmaId).map(nachAussen);
}

/* --------------------------------------------------------------- Pruefung */

/**
 * Trifft eine Regel auf einen Umsatz zu?
 *
 * Angegebene Merkmale muessen alle zutreffen; leere werden uebergangen. Die
 * Begruendungen werden mitgefuehrt, damit spaeter dasteht, warum die Regel
 * gegriffen hat.
 */
function trifft(regel, umsatz) {
  const gruende = [];
  const eingang = umsatz.betrag_cent > 0;

  if (regel.richtung) {
    if (regel.richtung === "Eingang" && !eingang) return null;
    if (regel.richtung === "Ausgang" && eingang) return null;
  }
  if (regel.iban) {
    const a = String(umsatz.iban || "").replace(/\s/g, "").toUpperCase();
    if (!a || a !== String(regel.iban).replace(/\s/g, "").toUpperCase()) return null;
    gruende.push("IBAN stimmt überein");
  }
  if (regel.name_enthaelt) {
    const gesucht = normal(regel.name_enthaelt);
    if (!gesucht || !normal(umsatz.beteiligter).includes(gesucht)) return null;
    gruende.push("Name enthält „" + regel.name_enthaelt + "“");
  }
  if (regel.zweck_enthaelt) {
    const gesucht = normal(regel.zweck_enthaelt);
    if (!gesucht || !normal(umsatz.zweck).includes(gesucht)) return null;
    gruende.push("Verwendungszweck enthält „" + regel.zweck_enthaelt + "“");
  }
  if (regel.betrag_cent !== null && regel.betrag_cent !== undefined) {
    if (Math.abs(umsatz.betrag_cent) !== Math.abs(regel.betrag_cent)) return null;
    gruende.push("Betrag stimmt genau");
  }
  // Eine Regel ohne jedes Merkmal traefe alles - die gibt es nicht (siehe
  // speichern), aber lieber hier noch einmal abfangen.
  if (!gruende.length) return null;
  return gruende;
}

/** Die erste passende Regel in der festgelegten Reihenfolge. */
function passend(firmaId, umsatz) {
  const regeln = db.prepare(`
    SELECT r.*, k.bezeichnung AS konto_bezeichnung, p.name AS partner_name
      FROM buch_regeln r
      LEFT JOIN buch_konten k ON k.firma_id = r.firma_id AND k.nummer = r.gegenkonto
      LEFT JOIN buch_partner p ON p.id = r.partner_id
     WHERE r.firma_id = ? AND r.aktiv = 1 ORDER BY r.sortierung, r.id`).all(firmaId);
  for (const r of regeln) {
    const gruende = trifft(r, umsatz);
    if (gruende) return Object.assign(nachAussen(r), { gruende });
  }
  return null;
}

/** Zaehlt mit, wie oft eine Regel tatsaechlich verwendet wurde. */
function verwendet(regelId) {
  db.prepare("UPDATE buch_regeln SET treffer = treffer + 1, zuletzt_am = datetime('now') WHERE id = ?")
    .run(regelId);
}

/* ---------------------------------------------------------------- Pflege */

function speichern(sitzung, id, d) {
  R.fordereSchreiben(sitzung, "buchhaltung");
  const firmaId = sitzung.firmaId;

  const iban = d.iban ? String(d.iban).replace(/\s/g, "").toUpperCase().slice(0, 34) : null;
  const nameEnthaelt = w(d.nameEnthaelt);
  const zweckEnthaelt = w(d.zweckEnthaelt);
  const betrag = d.betragCent === "" || d.betragCent === null || d.betragCent === undefined
    ? null : Math.abs(Math.round(Number(d.betragCent)));
  if (betrag !== null && !Number.isFinite(betrag)) throw new Verweigert("Ungültiger Betrag.", 400);

  /*
   * Ohne Merkmal keine Regel. Eine Regel, die auf alles passt, buchte jeden
   * Umsatz auf dasselbe Konto - der sicherste Weg zu einer unbrauchbaren
   * Buchfuehrung.
   */
  if (!iban && !nameEnthaelt && !zweckEnthaelt && betrag === null) {
    throw new Verweigert("Eine Regel braucht mindestens ein Erkennungsmerkmal — IBAN, Name, " +
      "Verwendungszweck oder Betrag. Ohne das würde sie auf jeden Umsatz passen.", 400);
  }

  /*
   * Eine Regel fuehrt entweder auf ein Sachkonto oder auf einen Zahler.
   *
   * Auf ein Sachkonto: Gebuehren, Miete, Telefon - alles ohne Rechnung.
   * Auf einen Zahler: Krankenkassen und andere, die Rechnungen begleichen.
   * Dort waere ein festes Gegenkonto falsch; was gebucht wird, entscheidet
   * die Rechnung, die dahintersteht. Die Regel sagt nur, von wem das Geld
   * kommt - den Rest erledigt die Zuordnung der offenen Posten.
   */
  const gegenkonto = w(d.gegenkonto);
  const partnerId = d.partnerId ? Number(d.partnerId) : null;
  if (!gegenkonto && !partnerId) {
    throw new Verweigert("Eine Regel muss entweder ein Gegenkonto nennen (für Gebühren, Miete und " +
      "Ähnliches) oder einen Zahler (für Kostenträger, die Rechnungen begleichen).", 400);
  }
  if (gegenkonto && partnerId && d.ziel !== "Sachkonto") {
    throw new Verweigert("Entweder Gegenkonto oder Zahler — beides zugleich ergibt keinen Vorgang.", 400);
  }
  const konto = gegenkonto ? B.kontoAufloesen(firmaId, gegenkonto) : null;
  if (gegenkonto && !konto) throw new Verweigert("Das Gegenkonto " + gegenkonto + " gibt es nicht.", 404);
  if (partnerId && !db.prepare("SELECT 1 FROM buch_partner WHERE id = ? AND firma_id = ?").get(partnerId, firmaId)) {
    throw new Verweigert("Unbekannter Geschäftspartner.", 404);
  }
  const satz = [0, 7, 19].includes(Number(d.steuersatz)) ? Number(d.steuersatz) : 0;
  const richtung = ["Eingang", "Ausgang"].includes(d.richtung) ? d.richtung : null;
  const art = B.ZAHLARTEN.includes(d.art) ? d.art : null;
  const name = String(d.name || "").trim() ||
    (nameEnthaelt || (iban ? "IBAN " + iban.slice(0, 12) : zweckEnthaelt) || "Regel");

  const felder = [name.slice(0, 80), richtung, iban, nameEnthaelt, zweckEnthaelt, betrag,
    konto ? konto.nummer : null, partnerId, art, satz, w(d.bu), w(d.buchungstext),
    d.automatisch ? 1 : 0, Number(d.sortierung) || 99, d.aktiv === false ? 0 : 1];

  if (id) {
    const alt = db.prepare("SELECT * FROM buch_regeln WHERE id = ? AND firma_id = ?").get(id, firmaId);
    if (!alt) throw new Verweigert("Regel nicht gefunden.", 404);
    db.prepare(`UPDATE buch_regeln SET name=?, richtung=?, iban=?, name_enthaelt=?, zweck_enthaelt=?,
        betrag_cent=?, gegenkonto=?, partner_id=?, art=?, steuersatz=?, bu=?, buchungstext=?,
        automatisch=?, sortierung=?, aktiv=? WHERE id=? AND firma_id=?`)
      .run(...felder, id, firmaId);
    B.protokoll(sitzung, id, "Zuordnungsregel geändert",
      name + " → " + (konto ? "Konto " + konto.nummer : "Zahler " + partnerId));
    return json(200, { id });
  }
  const neu = db.prepare(`INSERT INTO buch_regeln
    (name, richtung, iban, name_enthaelt, zweck_enthaelt, betrag_cent, gegenkonto, partner_id, art,
     steuersatz, bu, buchungstext, automatisch, sortierung, aktiv, firma_id, angelegt_von)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(...felder, firmaId, sitzung.anmeldename).lastInsertRowid;
  B.protokoll(sitzung, neu, "Zuordnungsregel angelegt",
    name + " → " + (konto ? "Konto " + konto.nummer : "Zahler " + partnerId) +
    (d.automatisch ? " (ohne Rückfrage)" : ""));
  return json(201, { id: neu });
}

function entfernen(sitzung, id) {
  R.fordereSchreiben(sitzung, "buchhaltung");
  const r = db.prepare("SELECT * FROM buch_regeln WHERE id = ? AND firma_id = ?").get(id, sitzung.firmaId);
  if (!r) throw new Verweigert("Regel nicht gefunden.", 404);
  db.prepare("DELETE FROM buch_regeln WHERE id = ?").run(id);
  B.protokoll(sitzung, id, "Zuordnungsregel gelöscht", r.name);
  return json(200, { ok: true });
}

/**
 * Legt aus einer soeben getroffenen Zuordnung eine Regel an.
 *
 * Das ist der Weg, auf dem Regeln entstehen sollen: nicht am Reissbrett,
 * sondern in dem Augenblick, in dem die Entscheidung ohnehin faellt. Erkannt
 * wird am IBAN, wenn es einen gibt - der ist bestaendiger als ein Name.
 */
function ausUmsatz(sitzung, umsatz, d) {
  const merkmale = umsatz.iban
    ? { iban: umsatz.iban }
    : { nameEnthaelt: String(umsatz.beteiligter || "").trim() };
  if (!merkmale.iban && !merkmale.nameEnthaelt) {
    throw new Verweigert("Dieser Umsatz nennt weder IBAN noch Namen — daraus lässt sich keine Regel " +
      "ableiten. Bitte unter „Regeln“ von Hand anlegen.", 400);
  }
  return speichern(sitzung, null, Object.assign({
    name: String(umsatz.beteiligter || "").trim().slice(0, 80) || "Regel",
    richtung: umsatz.betrag_cent > 0 ? "Eingang" : "Ausgang",
  }, merkmale, d));
}

/** Probelauf: Auf welche noch offenen Umsaetze wuerde eine Regel passen? */
function probe(sitzung, d) {
  R.fordereLesen(sitzung, "buchhaltung");
  const offene = db.prepare(
    "SELECT * FROM buch_bankumsaetze WHERE firma_id = ? AND status = 'offen' ORDER BY datum DESC LIMIT 500")
    .all(sitzung.firmaId);
  const entwurf = {
    richtung: ["Eingang", "Ausgang"].includes(d.richtung) ? d.richtung : null,
    iban: d.iban ? String(d.iban).replace(/\s/g, "").toUpperCase() : null,
    name_enthaelt: w(d.nameEnthaelt), zweck_enthaelt: w(d.zweckEnthaelt),
    betrag_cent: d.betragCent === "" || d.betragCent === null || d.betragCent === undefined
      ? null : Math.abs(Math.round(Number(d.betragCent))),
  };
  const treffer = offene.filter((u) => trifft(entwurf, u));
  return json(200, {
    anzahl: treffer.length,
    beispiele: treffer.slice(0, 8).map((u) => ({ id: u.id, datum: u.datum, centBetrag: u.betrag_cent,
      beteiligter: u.beteiligter, zweck: (u.zweck || "").slice(0, 70) })),
  });
}

module.exports = { liste, speichern, entfernen, passend, trifft, verwendet, ausUmsatz, probe, normal };
