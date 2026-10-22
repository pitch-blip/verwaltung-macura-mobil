"use strict";
/**
 * Uebergabe an den Steuerberater.
 *
 * Ergebnis ist eine einzige Datei - ein ZIP-Paket, das alles enthaelt, was die
 * Kanzlei fuer den Zeitraum braucht:
 *
 *   EXTF_Buchungsstapel_*.csv       die Buchungen im DATEV-Format
 *   EXTF_Kontenbeschriftungen_*.csv die Namen der Personenkonten dazu
 *   Buchungsliste.csv               dieselben Buchungen zum Nachlesen
 *   Kontenrahmen.csv                welche Konten hier verwendet werden
 *   Umsatzsteuer.txt                Summen zum Abgleich mit der Voranmeldung
 *   Belege/                         die Rechnungen und Quittungen als Datei
 *   LIESMICH.txt                    was das ist und wie es eingelesen wird
 *
 * Warum als Paket und nicht als einzelne Dateien: Buchungen ohne die
 * zugehoerigen Belege sind fuer die Kanzlei wenig wert, und getrennt
 * verschickt kommt erfahrungsgemaess eine Haelfte nicht an.
 *
 * Es gibt zwei Arten der Uebergabe:
 *
 *   Probelauf   Zum Ansehen und Abstimmen. Aendert nichts, kann beliebig oft
 *               wiederholt werden.
 *   Endgueltig  Die Buchungen werden festgeschrieben und lassen sich danach
 *               nicht mehr aendern; in den Zeitraum kann nicht mehr gebucht
 *               werden. Das ist keine Strenge um ihrer selbst willen: eine
 *               Buchfuehrung, die sich nachtraeglich aendern laesst, gilt als
 *               nicht ordnungsgemaess.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { db, DATEN, DATEIEN } = require("./db");
const R = require("./rechte");
const datev = require("./datev");
const zip = require("./zip");
const B = require("./buchhaltung");

const Verweigert = R.Verweigert;
const json = (status, koerper) => ({ status, koerper });
const PAKETE = path.join(DATEN, "buchhaltung");

const euro = (cent) => (Math.round(cent) / 100).toFixed(2).replace(".", ",");
const deDatum = (iso) => (iso ? String(iso).slice(8, 10) + "." + String(iso).slice(5, 7) + "." + String(iso).slice(0, 4) : "");

/** Dateinamen aus fremden Angaben: alles heraus, was Ordner wechseln koennte. */
function sicher(name) {
  return String(name || "Datei").replace(/[\\/:*?"<>|\r\n\t]/g, "_").replace(/^\.+/, "").trim().slice(0, 120) || "Datei";
}

function exporte(sitzung) {
  R.fordereLesen(sitzung, "buchhaltung");
  return db.prepare(`SELECT * FROM buch_exporte WHERE firma_id = ? ORDER BY id DESC`).all(sitzung.firmaId)
    .map((e) => ({ id: e.id, kennung: e.kennung, von: e.von, bis: e.bis, endgueltig: !!e.endgueltig,
      anzahl: e.anzahl, summeCent: e.summe_cent, dateiname: e.dateiname, groesse: e.groesse,
      pruefsumme: e.pruefsumme, erstelltAm: e.erstellt_am, erstelltVon: e.erstellt_von,
      gesendetAm: e.gesendet_am, gesendetAn: e.gesendet_an }));
}

/* ---------------------------------------------------------- Bestandteile */

/** Die Buchungen des Zeitraums, ohne die, die schon endgueltig uebergeben wurden. */
function belegeFuer(firmaId, von, bis) {
  return db.prepare(`${B.BELEG_ABFRAGE}
     WHERE b.firma_id = ? AND b.datum BETWEEN ? AND ? AND b.festgeschrieben = 0
     ORDER BY b.datum, b.journal_nr`).all(firmaId, von, bis);
}

/** Belegdatei je Buchung: Ablage auf dem Datentraeger und Name im Paket. */
function belegdateien(firmaId, zeilen) {
  const nachBeleg = new Map();
  const eintraege = [];
  const vergeben = new Set();

  for (const b of zeilen) {
    if (!b.dokument_id) continue;
    const v = db.prepare(`SELECT * FROM dokument_versionen WHERE dokument_id = ? ORDER BY id DESC LIMIT 1`)
      .get(b.dokument_id);
    if (!v) continue;
    const voll = path.resolve(DATEIEN, v.ablage);
    // Der Pfad stammt aus der eigenen Datenbank - und wird trotzdem geprueft.
    if (!voll.startsWith(path.resolve(DATEIEN) + path.sep) || !fs.existsSync(voll)) continue;

    const endung = path.extname(v.dateiname || b.dokument_name || "") || "";
    let name = "Belege/" + String(b.journal_nr).padStart(4, "0") + "_" +
      sicher(b.belegnummer).replace(/\s+/g, "-") + endung;
    let n = 2;
    while (vergeben.has(name.toLowerCase())) {
      name = name.replace(/(\.[^.]*)?$/, "_" + n++ + "$1");
    }
    vergeben.add(name.toLowerCase());
    nachBeleg.set(b.id, name);
    eintraege.push({ name, daten: fs.readFileSync(voll), zeit: new Date(b.angelegt_am + "Z") });
  }
  return { nachBeleg, eintraege };
}

/** Die Buchungen im DATEV-Format. */
function buchungsstapel(firmaId, zeilen, dateien, kopf) {
  return datev.buchungsstapel(kopf, zeilen.map((b) => ({
    cent: b.brutto_cent,
    // Gebucht wird "Soll an Haben". Im DATEV-Format steht das Sollkonto im
    // Feld "Konto", das Habenkonto im Gegenkonto, Richtung "S".
    sollHaben: "S",
    konto: b.soll_konto,
    gegenkonto: b.haben_konto,
    buSchluessel: b.bu || "",
    datum: b.datum,
    belegfeld1: b.belegnummer,
    buchungstext: b.buchungstext,
    beleginfo: dateien.nachBeleg.has(b.id) ? { art: "Belegdatei", inhalt: dateien.nachBeleg.get(b.id) } : null,
    kost1: b.kost1, kost2: b.kost2,
    leistungsdatum: b.leistungsdatum,
    faellig: b.faellig_am,
    festschreibung: kopf.festschreibung,
  })));
}

/** Namen der Personenkonten - sonst stehen dort nur Nummern. */
function kontenbeschriftungen(firmaId, zeilen, kopf) {
  const benutzt = new Set();
  for (const b of zeilen) { benutzt.add(b.soll_konto); benutzt.add(b.haben_konto); }
  const partner = db.prepare("SELECT konto, name FROM buch_partner WHERE firma_id = ? ORDER BY konto").all(firmaId)
    .filter((p) => benutzt.has(p.konto));
  if (!partner.length) return null;
  return datev.kontenbeschriftungen(kopf, partner.map((p) => ({ nummer: p.konto, bezeichnung: p.name })));
}

/**
 * Dieselben Buchungen zum Nachlesen - fuer Menschen, nicht fuer die Software.
 * Mit Byte-Marke am Anfang, damit Excel die Umlaute richtig anzeigt.
 */
function buchungsliste(zeilen, dateien) {
  const kopf = ["Nr.", "Belegdatum", "Belegnummer", "Art", "Soll", "Haben", "Brutto", "Steuersatz",
    "Steuer", "Netto", "Steuerschlüssel", "Buchungstext", "Geschäftspartner", "Belegdatei", "Storno zu"];
  const feld = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
  const zeilenText = zeilen.map((b) => [
    b.journal_nr, deDatum(b.datum), b.belegnummer, b.art,
    b.soll_konto + (b.soll_text ? " " + b.soll_text : ""),
    b.haben_konto + (b.haben_text ? " " + b.haben_text : ""),
    euro(b.brutto_cent), b.steuersatz ? b.steuersatz + " %" : "–",
    euro(b.steuer_cent), euro(b.netto_cent), b.bu || "", b.buchungstext, b.partner_name || "",
    dateien.nachBeleg.get(b.id) || "", b.storno_von || "",
  ].map(feld).join(";"));
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from([kopf.map(feld).join(";"), ...zeilenText].join("\r\n") + "\r\n", "utf8")]);
}

/** Der verwendete Kontenrahmen - damit die Kanzlei ihn gegenlesen kann. */
function kontenliste(firmaId) {
  const feld = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
  const konten = db.prepare("SELECT * FROM buch_konten WHERE firma_id = ? ORDER BY nummer").all(firmaId);
  const zeilen = konten.map((k) => [k.nummer, k.bezeichnung, k.art,
    k.steuersatz ? k.steuersatz + " %" : "", k.automatik ? "Automatik" : "", k.bu || "",
    k.aktiv ? "" : "stillgelegt"].map(feld).join(";"));
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from([["Konto", "Bezeichnung", "Art", "Steuersatz", "Automatik", "Steuerschlüssel", "Status"]
      .map(feld).join(";"), ...zeilen].join("\r\n") + "\r\n", "utf8")]);
}

function umsatzsteuerBlatt(sitzung, von, bis) {
  const u = B.umsatzsteuer(sitzung, von, bis);
  const zeile = (l, w) => l.padEnd(52) + String(w).padStart(14);
  return [
    "Umsatzsteuer - Summen des Zeitraums",
    "Zeitraum: " + deDatum(von) + " bis " + deDatum(bis),
    "",
    "Diese Aufstellung ist eine Hilfe zum Abgleich, KEINE Voranmeldung.",
    "Die Umsatzsteuer-Voranmeldung erstellt und uebermittelt die Kanzlei.",
    "",
    "Erloese",
    zeile("  zum Steuersatz 19 % (Kz 81, Bemessungsgrundlage)", euro(u.kennzahlen[81])),
    zeile("    darauf entfallende Umsatzsteuer", euro(u.erloese[19].steuer)),
    zeile("  zum Steuersatz 7 % (Kz 86, Bemessungsgrundlage)", euro(u.kennzahlen[86])),
    zeile("    darauf entfallende Umsatzsteuer", euro(u.erloese[7].steuer)),
    zeile("  ohne Umsatzsteuer (Kz 48)", euro(u.kennzahlen[48])),
    "",
    "Vorsteuer",
    zeile("  aus Eingangsrechnungen 19 %", euro(u.vorsteuer[19].steuer)),
    zeile("  aus Eingangsrechnungen 7 %", euro(u.vorsteuer[7].steuer)),
    zeile("  Summe Vorsteuer (Kz 66)", euro(u.kennzahlen[66])),
    "",
    zeile("Umsatzsteuer abzueglich Vorsteuer (Kz 83)", euro(u.kennzahlen[83])),
    "",
    u.kennzahlen[83] >= 0
      ? "Ein positiver Betrag ist eine Zahllast an das Finanzamt."
      : "Ein negativer Betrag ist ein Erstattungsanspruch gegen das Finanzamt.",
    "",
  ].join("\r\n");
}

function liesmich(firma, e, kopf, zeilen, dateien, endgueltig, dateinamen) {
  const summe = zeilen.reduce((s, b) => s + b.brutto_cent, 0);
  return [
    "Buchfuehrungsunterlagen " + firma.name,
    "=".repeat(60),
    "",
    "Zeitraum:            " + deDatum(kopf.von) + " bis " + deDatum(kopf.bis),
    "Buchungen:           " + zeilen.length + " (Summe " + euro(summe) + " EUR)",
    "Belege als Datei:    " + dateien.eintraege.length,
    "Berater / Mandant:   " + (e.berater || "nicht hinterlegt") + " / " + (e.mandant || "nicht hinterlegt"),
    "Kontenrahmen:        SKR" + e.skr,
    "Wirtschaftsjahr ab:  " + deDatum(kopf.wirtschaftsjahrBeginn),
    "Erstellt am:         " + new Date().toLocaleString("de-DE"),
    "Erstellt von:        " + kopf.exportiertVon,
    "Status:              " + (endgueltig
      ? "ENDGUELTIG - die Buchungen sind festgeschrieben (Kennzeichen 1 im Stapel)."
      : "PROBELAUF - nicht festgeschrieben (Kennzeichen 0 im Stapel)."),
    "",
    "Inhalt",
    "-".repeat(60),
    dateinamen.stapel + "",
    "    Buchungsstapel im DATEV-Format (EXTF, Version 700, Buchungsstapel 13).",
    "    Einlesen ueber Bestand > Buchfuehrung > Buchungen importieren.",
    "    Zeichensatz Windows-1252, Trennzeichen Semikolon.",
    dateinamen.konten ? dateinamen.konten + "\r\n    Bezeichnungen der Debitoren- und Kreditorenkonten (Format Kontenbeschriftungen 3)." : "",
    "Buchungsliste.csv",
    "    Dieselben Buchungen als lesbare Liste (UTF-8, fuer Excel).",
    "Kontenrahmen.csv",
    "    Die hier verwendeten Sachkonten - bitte gegen die Kanzleiliste halten.",
    "Umsatzsteuer.txt",
    "    Summen des Zeitraums zum Abgleich.",
    dateien.eintraege.length ? "Belege/\r\n    Die Rechnungen und Quittungen, benannt nach der Journalnummer.\r\n" +
      "    Im Buchungsstapel steht der Dateiname in der Beleginfo der jeweiligen Zeile." : "Belege/ - keine Dateien hinterlegt.",
    "",
    "Hinweise",
    "-".repeat(60),
    "- Gebucht wird Soll an Haben: im Stapel steht das Sollkonto im Feld",
    "  \"Konto\", das Habenkonto im Feld \"Gegenkonto\", Richtung durchgehend \"S\".",
    "- Betraege sind Bruttobetraege. Wo ein Automatikkonto die Steuer selbst",
    "  ermittelt, ist kein Steuerschluessel gesetzt.",
    "- Belegdatum ist im Format des Stapels TTMM; das Jahr ergibt sich aus dem",
    "  Zeitraum im Kopfsatz.",
    "- Stornierungen stehen als eigene Buchung mit vertauschten Konten darin;",
    "  in der Buchungsliste ist in der letzten Spalte vermerkt, wozu.",
    "",
    "Rueckfragen zu einzelnen Buchungen bitte unter Angabe der Journalnummer -",
    "sie steht in der Buchungsliste in der ersten Spalte und im Dateinamen des",
    "jeweiligen Belegs.",
    "",
  ].filter((z) => z !== "").join("\r\n");
}

/* -------------------------------------------------------------- Erzeugen */

function erzeugen(sitzung, d) {
  R.fordereSchreiben(sitzung, "buchhaltung");
  const firmaId = sitzung.firmaId;
  const von = String(d.von || ""), bis = String(d.bis || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(von) || !/^\d{4}-\d{2}-\d{2}$/.test(bis)) {
    throw new Verweigert("Bitte Anfang und Ende des Zeitraums angeben.", 400);
  }
  if (von > bis) throw new Verweigert("Das Ende des Zeitraums liegt vor seinem Anfang.", 400);

  const e = B.einstellungen(firmaId);
  if (!e.berater || !e.mandant) {
    throw new Verweigert("Berater- und Mandantennummer fehlen. Ohne sie kann die Kanzlei die Datei nicht zuordnen " +
      "— beide stehen auf jedem Schreiben des Steuerberaters.", 400);
  }

  /*
   * Ein Stapel darf nicht ueber das Wirtschaftsjahr hinausreichen: Das
   * Belegdatum steht im DATEV-Format nur mit Tag und Monat darin, das Jahr
   * kommt aus dem Kopfsatz. Ein Zeitraum ueber den Jahreswechsel wuerde die
   * Haelfte der Buchungen ins falsche Jahr legen.
   */
  const wjVon = B.wirtschaftsjahr(firmaId, von);
  const wjBis = B.wirtschaftsjahr(firmaId, bis);
  if (wjVon.beginn !== wjBis.beginn) {
    throw new Verweigert("Der Zeitraum reicht über das Wirtschaftsjahr hinaus (" + wjVon.beginn +
      " bzw. " + wjBis.beginn + "). Bitte je Wirtschaftsjahr getrennt übergeben.", 400);
  }

  const endgueltig = d.endgueltig === true;
  const grenze = B.abgeschlossenBis(firmaId);
  if (endgueltig && grenze && von <= grenze) {
    throw new Verweigert("Bis " + grenze + " wurde bereits endgültig übergeben. " +
      "Bitte den Zeitraum später beginnen lassen.", 409);
  }

  const zeilen = belegeFuer(firmaId, von, bis);
  if (!zeilen.length) throw new Verweigert("In diesem Zeitraum gibt es keine noch nicht übergebenen Buchungen.", 400);

  const firma = db.prepare("SELECT * FROM firmen WHERE id = ?").get(firmaId);
  const kennung = von.replace(/-/g, "") + "-" + bis.replace(/-/g, "") +
    (endgueltig ? "" : "-Probe") + "-" + new Date().toISOString().slice(11, 16).replace(":", "");
  const kopf = {
    berater: e.berater, mandant: e.mandant, skr: e.skr,
    sachkontenlaenge: e.sachkontenlaenge, herkunft: e.herkunft || "SV",
    wirtschaftsjahrBeginn: wjVon.beginn, von, bis,
    bezeichnung: (endgueltig ? "" : "Probe ") + deDatum(von) + "-" + deDatum(bis),
    exportiertVon: sitzung.anmeldename, festschreibung: endgueltig,
    anwendung: "Verwaltung",
  };

  const dateien = belegdateien(firmaId, zeilen);
  const dateinamen = {
    stapel: "EXTF_Buchungsstapel_" + kennung + ".csv",
    konten: "EXTF_Kontenbeschriftungen_" + kennung + ".csv",
  };
  const beschriftungen = kontenbeschriftungen(firmaId, zeilen, kopf);
  if (!beschriftungen) dateinamen.konten = null;

  const eintraege = [
    { name: "LIESMICH.txt", daten: datev.nachWindows1252(
        liesmich(firma, e, kopf, zeilen, dateien, endgueltig, dateinamen)) },
    { name: dateinamen.stapel, daten: buchungsstapel(firmaId, zeilen, dateien, kopf) },
    { name: "Buchungsliste.csv", daten: buchungsliste(zeilen, dateien) },
    { name: "Kontenrahmen.csv", daten: kontenliste(firmaId) },
    { name: "Umsatzsteuer.txt", daten: datev.nachWindows1252(umsatzsteuerBlatt(sitzung, von, bis)) },
    ...dateien.eintraege,
  ];
  if (beschriftungen) eintraege.splice(2, 0, { name: dateinamen.konten, daten: beschriftungen });

  const paket = zip.archiv(eintraege);
  const dateiname = "Buchfuehrung_" + sicher(firma.name).replace(/\s+/g, "-") + "_" + kennung + ".zip";
  const ordner = path.join(PAKETE, String(firmaId));
  fs.mkdirSync(ordner, { recursive: true });
  const ablage = path.join(String(firmaId), dateiname);
  fs.writeFileSync(path.join(PAKETE, ablage), paket);

  const summe = zeilen.reduce((s, b) => s + b.brutto_cent, 0);
  const pruefsumme = crypto.createHash("sha256").update(paket).digest("hex").slice(0, 16);

  const exportId = db.prepare(`INSERT INTO buch_exporte
    (firma_id, kennung, von, bis, endgueltig, anzahl, summe_cent, dateiname, ablage, groesse, pruefsumme, erstellt_von)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(firmaId, kennung, von, bis, endgueltig ? 1 : 0, zeilen.length, summe,
      dateiname, ablage, paket.length, pruefsumme, sitzung.anmeldename).lastInsertRowid;

  /*
   * Erst jetzt festschreiben - wenn die Datei wirklich auf dem Datentraeger
   * liegt. Andersherum waeren die Buchungen gesperrt, ohne dass es ein Paket
   * dazu gaebe.
   */
  if (endgueltig) {
    const ids = zeilen.map((b) => b.id);
    db.exec("BEGIN IMMEDIATE");
    try {
      const setzen = db.prepare("UPDATE buch_belege SET festgeschrieben = 1, export_id = ? WHERE id = ? AND firma_id = ?");
      for (const id of ids) setzen.run(exportId, id, firmaId);
      db.exec("COMMIT");
    } catch (err) { db.exec("ROLLBACK"); throw err; }
  } else {
    db.prepare("UPDATE buch_belege SET export_id = ? WHERE id IN (" + zeilen.map(() => "?").join(",") + ")")
      .run(exportId, ...zeilen.map((b) => b.id));
  }

  B.protokoll(sitzung, kennung, endgueltig ? "Buchhaltung endgültig übergeben" : "Buchhaltung als Probelauf erzeugt",
    zeilen.length + " Buchungen, " + euro(summe) + " EUR, " + deDatum(von) + " bis " + deDatum(bis) +
    ", Datei " + dateiname + " (Prüfsumme " + pruefsumme + ").");

  return json(201, { id: exportId, kennung, dateiname, groesse: paket.length, anzahl: zeilen.length,
    summeCent: summe, pruefsumme, endgueltig, belege: dateien.eintraege.length });
}

/** Liefert ein bereits erzeugtes Paket erneut aus. */
function paketLesen(sitzung, id) {
  R.fordereLesen(sitzung, "buchhaltung");
  const e = db.prepare("SELECT * FROM buch_exporte WHERE id = ? AND firma_id = ?").get(id, sitzung.firmaId);
  if (!e) throw new Verweigert("Übergabe nicht gefunden.", 404);
  const voll = path.resolve(PAKETE, e.ablage);
  if (!voll.startsWith(path.resolve(PAKETE) + path.sep)) throw new Verweigert("Ungültige Ablage.", 500);
  if (!fs.existsSync(voll)) throw new Verweigert("Die Datei fehlt auf dem Datenträger.", 410);
  B.protokoll(sitzung, e.kennung, "Übergabepaket geöffnet", e.dateiname);
  return { name: e.dateiname, daten: fs.readFileSync(voll) };
}

/** Versendet ein Paket per E-Mail an die Kanzlei. */
async function paketSenden(sitzung, id, d) {
  if (!sitzung.regeln.versendet) throw new Verweigert("Kein Recht zum Versenden.");
  R.fordereLesen(sitzung, "buchhaltung");
  const mail = require("./mail");
  const e = db.prepare("SELECT * FROM buch_exporte WHERE id = ? AND firma_id = ?").get(id, sitzung.firmaId);
  if (!e) throw new Verweigert("Übergabe nicht gefunden.", 404);
  const datei = paketLesen(sitzung, id);
  const ein = B.einstellungen(sitzung.firmaId);

  const empfaenger = await mail.senden(sitzung.firmaId, {
    an: d.an || ein.steuerberater_email,
    betreff: d.betreff || ("Buchführung " + deDatum(e.von) + " bis " + deDatum(e.bis) +
      (e.endgueltig ? "" : " (Probelauf)")),
    text: d.text || ["Guten Tag,",
      "",
      "anbei die Buchführungsunterlagen für den Zeitraum " + deDatum(e.von) + " bis " + deDatum(e.bis) + ".",
      "Das Paket enthält den Buchungsstapel im DATEV-Format, die Belege als Datei",
      "und eine Buchungsliste zum Nachlesen. Einzelheiten stehen in der LIESMICH.txt.",
      "",
      e.endgueltig ? "Die Buchungen sind festgeschrieben." : "Es handelt sich um einen Probelauf; die Buchungen sind noch nicht festgeschrieben.",
      "",
      "Mit freundlichen Grüßen"].join("\n"),
    anhang: { name: datei.name, daten: datei.daten, typ: "application/zip" },
  });

  const zeitpunkt = new Date().toISOString();
  db.prepare("UPDATE buch_exporte SET gesendet_am = ?, gesendet_an = ? WHERE id = ?")
    .run(zeitpunkt, empfaenger.join(", "), id);
  B.protokoll(sitzung, e.kennung, "Übergabe versendet", "Per E-Mail an " + empfaenger.join(", ") + ".");
  return json(200, { gesendet: empfaenger, gesendetAm: zeitpunkt });
}

module.exports = { erzeugen, exporte, paketLesen, paketSenden, PAKETE };
