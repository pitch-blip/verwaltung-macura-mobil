"use strict";
/**
 * DATEV-Format: Buchungsstapel und Kontenbeschriftungen.
 *
 * Der Steuerberater arbeitet mit DATEV. Damit er die Buchungen nicht abtippen
 * muss, werden sie in dem Dateiformat uebergeben, das seine Kanzleisoftware
 * einlesen kann - "DATEV-Format", frueher ASCII-Schnittstelle.
 *
 * Aufbau einer solchen Datei:
 *
 *   Zeile 1  Kopfsatz - sagt, was drinsteht: Berater, Mandant, Zeitraum,
 *            Kontenrahmen, Wirtschaftsjahr, ob festgeschrieben.
 *   Zeile 2  Spaltenueberschriften - fest vorgegeben, Anzahl und Reihenfolge
 *            duerfen nicht abweichen.
 *   ab 3     je Zeile eine Buchung.
 *
 * Das Format ist streng: Trennzeichen ist das Semikolon, Textfelder stehen in
 * Anfuehrungszeichen, Zahlenfelder nicht, Dezimaltrennzeichen ist das Komma,
 * und die Datei ist in Windows-1252 kodiert. Weicht eines davon ab, weist die
 * Kanzleisoftware die Datei beim Einlesen ab.
 */

/* ------------------------------------------------------- Zeichenkodierung */

/**
 * Windows-1252 belegt den Bereich 128-159 anders als die sonst naheliegende
 * Kodierung Latin-1. Betroffen sind unter anderem das Eurozeichen und die
 * typografischen Anfuehrungszeichen - genau das, was aus Textverarbeitungen in
 * einen Buchungstext geraet.
 */
const SONDERZEICHEN = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85,
  "†": 0x86, "‡": 0x87, "ˆ": 0x88, "‰": 0x89, "Š": 0x8a,
  "‹": 0x8b, "Œ": 0x8c, "Ž": 0x8e, "‘": 0x91, "’": 0x92,
  "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97,
  "˜": 0x98, "™": 0x99, "š": 0x9a, "›": 0x9b, "œ": 0x9c,
  "ž": 0x9e, "Ÿ": 0x9f,
};

/** Was sich nicht darstellen laesst, wird lesbar ersetzt statt zu verschwinden. */
const ERSATZ = {
  "→": "->", "←": "<-", "−": "-", " ": " ",
  "⁄": "/", "­": "", "​": "",
};

function nachWindows1252(text) {
  const zeichen = [];
  for (const z of String(text)) {
    const ersetzt = ERSATZ[z];
    if (ersetzt !== undefined) { for (const e of ersetzt) zeichen.push(e.charCodeAt(0)); continue; }
    const code = z.codePointAt(0);
    if (code <= 0x7f || (code >= 0xa0 && code <= 0xff)) { zeichen.push(code); continue; }
    const sonder = SONDERZEICHEN[z];
    // Unbekanntes wird zum Fragezeichen. Eine Buchung soll daran nicht
    // scheitern - aber sichtbar bleiben, dass dort etwas stand.
    zeichen.push(sonder !== undefined ? sonder : 0x3f);
  }
  return Buffer.from(zeichen);
}

/* --------------------------------------------------------- Felder und CSV */

/** Textfeld: in Anfuehrungszeichen, enthaltene Anfuehrungszeichen verdoppelt. */
function text(wert, maxLaenge) {
  let s = String(wert == null ? "" : wert).replace(/[\r\n\t]+/g, " ").trim();
  if (maxLaenge) s = s.slice(0, maxLaenge);
  return '"' + s.replace(/"/g, '""') + '"';
}

/** Zahlenfeld: ohne Anfuehrungszeichen, Komma als Dezimaltrennzeichen. */
function zahl(wert) {
  if (wert === null || wert === undefined || wert === "") return "";
  return String(wert).replace(".", ",");
}

/**
 * Betrag aus Cent. Immer ohne Vorzeichen - die Richtung steht im
 * Soll/Haben-Kennzeichen, nicht im Betrag.
 */
function betrag(cent) {
  const c = Math.abs(Math.round(Number(cent) || 0));
  return String(Math.floor(c / 100)) + "," + String(c % 100).padStart(2, "0");
}

/** Belegdatum: Tag und Monat, vierstellig. Das Jahr steht im Kopfsatz. */
function tagMonat(iso) {
  const d = String(iso || "");
  return d.slice(8, 10) + d.slice(5, 7);
}
/** Leistungsdatum und Faelligkeit dagegen mit Jahr: TTMMJJJJ. */
function tagMonatJahr(iso) {
  const d = String(iso || "");
  if (!/^\d{4}-\d{2}-\d{2}/.test(d)) return "";
  return d.slice(8, 10) + d.slice(5, 7) + d.slice(0, 4);
}
function jahrMonatTag(iso) {
  return String(iso || "").slice(0, 10).replace(/-/g, "");
}

function zeile(felder) { return felder.join(";"); }

/* ------------------------------------------------------------- Kopfsatz */

/**
 * Erste Zeile jeder Datei. Die Reihenfolge ist vorgegeben; Felder, die nur
 * DATEV selbst setzt, bleiben leer.
 */
function kopfsatz(k) {
  const erzeugt = k.erzeugtAm || new Date();
  const zeitstempel =
    String(erzeugt.getFullYear()) +
    String(erzeugt.getMonth() + 1).padStart(2, "0") +
    String(erzeugt.getDate()).padStart(2, "0") +
    String(erzeugt.getHours()).padStart(2, "0") +
    String(erzeugt.getMinutes()).padStart(2, "0") +
    String(erzeugt.getSeconds()).padStart(2, "0") +
    String(erzeugt.getMilliseconds()).padStart(3, "0");

  return zeile([
    text("EXTF"),                       //  1 Kennzeichen: von einem Fremdprogramm erzeugt
    "700",                              //  2 Versionsnummer des Formats
    String(k.kategorie),                //  3 Formatkategorie
    text(k.formatName),                 //  4 Formatname
    String(k.formatVersion),            //  5 Version des Formats
    zeitstempel,                        //  6 erzeugt am
    "",                                 //  7 importiert am - setzt DATEV
    text(k.herkunft || "SV", 2),        //  8 Herkunftskennzeichen
    text(k.exportiertVon, 25),          //  9 exportiert von
    "",                                 // 10 importiert von - setzt DATEV
    String(k.berater),                  // 11 Beraternummer
    String(k.mandant),                  // 12 Mandantennummer
    jahrMonatTag(k.wirtschaftsjahrBeginn), // 13 Beginn des Wirtschaftsjahres
    String(k.sachkontenlaenge || 4),    // 14 Laenge der Sachkontonummern
    k.von ? jahrMonatTag(k.von) : "",   // 15 Beginn des Zeitraums
    k.bis ? jahrMonatTag(k.bis) : "",   // 16 Ende des Zeitraums
    text(k.bezeichnung || "", 30),      // 17 Bezeichnung des Stapels
    text(k.diktatkuerzel || "", 2),     // 18 Diktatkuerzel
    k.buchungstyp ? String(k.buchungstyp) : "",   // 19 1 = Finanzbuchfuehrung
    k.rechnungslegungszweck ? String(k.rechnungslegungszweck) : "", // 20
    k.festschreibung ? "1" : "0",       // 21 festgeschrieben ja/nein
    text(k.waehrung || "EUR", 3),       // 22 Waehrungskennzeichen
    "",                                 // 23 reserviert
    "",                                 // 24 Derivatskennzeichen
    "",                                 // 25 reserviert
    "",                                 // 26 reserviert
    text(k.skr || "", 2),               // 27 Kontenrahmen (SKR)
    "",                                 // 28 Branchenloesung
    "",                                 // 29 reserviert
    "",                                 // 30 reserviert
    text(k.anwendung || "", 16),        // 31 Anwendungsinformation
  ]);
}

/* ------------------------------------------------- Buchungsstapel (21/13) */

/**
 * Die Spalten des Buchungsstapels. Anzahl und Reihenfolge sind vom Format
 * vorgegeben - deshalb wird die Liste nicht von Hand gepflegt, sondern aus
 * ihren Bestandteilen aufgebaut und danach gezaehlt.
 */
const BUCHUNG_SPALTEN = (() => {
  const s = [
    "Umsatz (ohne Soll/Haben-Kz)", "Soll/Haben-Kennzeichen", "WKZ Umsatz", "Kurs",
    "Basis-Umsatz", "WKZ Basis-Umsatz", "Konto", "Gegenkonto (ohne BU-Schlüssel)",
    "BU-Schlüssel", "Belegdatum", "Belegfeld 1", "Belegfeld 2", "Skonto", "Buchungstext",
    "Postensperre", "Diverse Adressnummer", "Geschäftspartnerbank", "Sachverhalt",
    "Zinssperre", "Beleglink",
  ];
  for (let i = 1; i <= 8; i++) s.push("Beleginfo - Art " + i, "Beleginfo - Inhalt " + i);
  s.push("KOST1 - Kostenstelle", "KOST2 - Kostenstelle", "KOST-Menge",
    "EU-Land u. UStID (Bestimmung)", "EU-Steuersatz (Bestimmung)", "Abw. Versteuerungsart",
    "Sachverhalt L+L", "Funktionsergänzung L+L", "BU 49 Hauptfunktionstyp",
    "BU 49 Hauptfunktionsnummer", "BU 49 Funktionsergänzung");
  for (let i = 1; i <= 20; i++) s.push("Zusatzinformation - Art " + i, "Zusatzinformation- Inhalt " + i);
  s.push("Stück", "Gewicht", "Zahlweise", "Forderungsart", "Veranlagungsjahr",
    "Zugeordnete Fälligkeit", "Skontotyp", "Auftragsnummer", "Buchungstyp",
    "USt-Schlüssel (Anzahlungen)", "EU-Land (Anzahlungen)", "Sachverhalt L+L (Anzahlungen)",
    "EU-Steuersatz (Anzahlungen)", "Erlöskonto (Anzahlungen)", "Herkunft-Kz",
    "Buchungs GUID", "KOST-Datum", "SEPA-Mandatsreferenz", "Skontosperre",
    "Gesellschaftername", "Beteiligtennummer", "Identifikationsnummer", "Zeichnernummer",
    "Postensperre bis", "Bezeichnung SoBil-Sachverhalt", "Kennzeichen SoBil-Buchung",
    "Festschreibung", "Leistungsdatum", "Datum Zuord. Steuerperiode", "Fälligkeit",
    "Generalumkehr (GU)", "Steuersatz", "Land", "Abrechnungsreferenz", "BVV-Position",
    "EU-Land u. UStID (Ursprung)", "EU-Steuersatz (Ursprung)", "Abw. Skontokonto");
  return s;
})();

const SPALTEN_ANZAHL = 125;
if (BUCHUNG_SPALTEN.length !== SPALTEN_ANZAHL) {
  // Faellt sofort beim Start auf statt erst beim Steuerberater.
  throw new Error("Buchungsstapel: " + BUCHUNG_SPALTEN.length + " Spalten statt " + SPALTEN_ANZAHL + ".");
}

/**
 * Eine Buchungszeile.
 *
 * b: { cent, sollHaben, konto, gegenkonto, buSchluessel, datum, belegfeld1,
 *      belegfeld2, buchungstext, beleginfo, kost1, kost2, leistungsdatum,
 *      faellig, festschreibung }
 */
function buchungszeile(b) {
  const f = new Array(SPALTEN_ANZAHL).fill("");
  f[0] = betrag(b.cent);                       //  1 Umsatz, immer ohne Vorzeichen
  f[1] = text(b.sollHaben === "H" ? "H" : "S");//  2 Richtung, bezogen auf "Konto"
  f[2] = text("EUR");                          //  3 Waehrung
  f[6] = zahl(b.konto);                        //  7 Konto
  f[7] = zahl(b.gegenkonto);                   //  8 Gegenkonto
  f[8] = b.buSchluessel ? text(b.buSchluessel) : ""; //  9 Steuerschluessel
  f[9] = tagMonat(b.datum);                    // 10 Belegdatum TTMM
  f[10] = text(b.belegfeld1 || "", 36);        // 11 Rechnungs- bzw. Belegnummer
  f[11] = text(b.belegfeld2 || "", 12);        // 12
  f[13] = text(b.buchungstext || "", 60);      // 14 Buchungstext
  if (b.beleginfo && b.beleginfo.inhalt) {
    f[20] = text(b.beleginfo.art || "Belegdatei", 20);  // 21 Beleginfo-Art 1
    f[21] = text(b.beleginfo.inhalt, 210);              // 22 Beleginfo-Inhalt 1
  }
  f[36] = text(b.kost1 || "", 36);             // 37 Kostenstelle
  f[37] = text(b.kost2 || "", 36);             // 38
  f[113] = b.festschreibung ? "1" : "0";       // 114 Festschreibung
  f[114] = tagMonatJahr(b.leistungsdatum);     // 115 Leistungsdatum TTMMJJJJ
  f[116] = tagMonatJahr(b.faellig);            // 117 Faelligkeit TTMMJJJJ
  return zeile(f);
}

/** Baut die vollstaendige Datei; Rueckgabe ist bereits Windows-1252. */
function buchungsstapel(kopf, buchungen) {
  const zeilen = [
    kopfsatz(Object.assign({ kategorie: 21, formatName: "Buchungsstapel", formatVersion: 13,
      buchungstyp: 1 }, kopf)),
    zeile(BUCHUNG_SPALTEN.map((s) => text(s))),
    ...buchungen.map(buchungszeile),
  ];
  // Zeilenende ist CR LF - das erwartet die Kanzleisoftware.
  return nachWindows1252(zeilen.join("\r\n") + "\r\n");
}

/* -------------------------------------------- Kontenbeschriftungen (20/3) */

/**
 * Damit beim Steuerberater nicht nur nackte Kontonummern ankommen, gehen die
 * Bezeichnungen der Personenkonten in einer zweiten Datei mit. Das Format ist
 * denkbar einfach: Nummer, Beschriftung, Sprache.
 */
function kontenbeschriftungen(kopf, konten) {
  const zeilen = [
    kopfsatz(Object.assign({ kategorie: 20, formatName: "Kontenbeschriftungen", formatVersion: 3 }, kopf)),
    zeile([text("Konto"), text("Kontenbeschriftung"), text("Sprach-ID")]),
    ...konten.map((k) => zeile([zahl(k.nummer), text(k.bezeichnung, 40), text("de-DE")])),
  ];
  return nachWindows1252(zeilen.join("\r\n") + "\r\n");
}

module.exports = {
  buchungsstapel, kontenbeschriftungen, kopfsatz, buchungszeile,
  nachWindows1252, betrag, tagMonat, tagMonatJahr, text, zahl,
  BUCHUNG_SPALTEN, SPALTEN_ANZAHL,
};
