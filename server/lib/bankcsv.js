"use strict";
/**
 * Kontoauszuege als CSV einlesen.
 *
 * Jede Bank liefert ein eigenes Format. Sparkasse, Volksbank, DKB, Commerzbank
 * und ING nennen dieselben Dinge verschieden, verwenden mal Semikolon und mal
 * Komma als Trennzeichen, schreiben Betraege mit Komma oder Punkt und
 * speichern wahlweise in UTF-8 oder Windows-1252. Ein fest verdrahteter Leser
 * fuer ein Format waere beim naechsten Bankwechsel wertlos.
 *
 * Deshalb wird die Datei gelesen und die Bedeutung der Spalten aus den
 * Ueberschriften erschlossen. Was sich nicht erschliessen laesst, ordnet der
 * Benutzer von Hand zu - die Zuordnung kommt mit derselben Anfrage zurueck.
 *
 * Bewusst nicht geraten wird beim Vorzeichen: Ob ein Betrag Eingang oder
 * Ausgang ist, entscheidet das Vorzeichen in der Datei oder eine eigene
 * Soll/Haben-Spalte - niemals eine Vermutung. Ein falsches Vorzeichen drehte
 * eine Einnahme in eine Ausgabe, und das faellt in der Summe nicht auf.
 */

const crypto = require("crypto");

/* ------------------------------------------------------------ Zeichensatz */

/**
 * Kontoauszuege kommen in UTF-8 oder Windows-1252. Verwechselt man beides,
 * wird aus "Müller" entweder "MÃ¼ller" oder "M?ller" - und der Name taugt
 * dann nicht mehr zum Zuordnen.
 */
function textLesen(daten) {
  const roh = Buffer.isBuffer(daten) ? daten : Buffer.from(String(daten), "utf8");
  if (roh.length >= 3 && roh[0] === 0xef && roh[1] === 0xbb && roh[2] === 0xbf) {
    return roh.subarray(3).toString("utf8");
  }
  // Strenges UTF-8 meldet ungueltige Folgen; gelingt es, war es UTF-8.
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(roh);
  } catch {
    return new TextDecoder("windows-1252").decode(roh);
  }
}

/* -------------------------------------------------------------- CSV lesen */

/** Haeufigstes Trennzeichen ausserhalb von Anfuehrungszeichen. */
function trennzeichenRaten(text) {
  const zaehler = { ";": 0, ",": 0, "\t": 0, "|": 0 };
  let inText = false;
  for (let i = 0; i < text.length && i < 20000; i++) {
    const c = text[i];
    if (c === '"') inText = !inText;
    else if (!inText && zaehler[c] !== undefined) zaehler[c]++;
  }
  return Object.keys(zaehler).reduce((a, b) => (zaehler[b] > zaehler[a] ? b : a), ";");
}

/** Zerlegt den gesamten Text in Zeilen und Felder, Anfuehrungszeichen beachtet. */
function zerlegen(text, trenner) {
  const zeilen = [];
  let feld = "", zeile = [], inText = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inText) {
      if (c === '"' && text[i + 1] === '"') { feld += '"'; i++; }
      else if (c === '"') inText = false;
      else feld += c;
    } else if (c === '"') inText = true;
    else if (c === trenner) { zeile.push(feld); feld = ""; }
    else if (c === "\n") { zeile.push(feld); zeilen.push(zeile); zeile = []; feld = ""; }
    else if (c === "\r") { /* wird vom folgenden \n erledigt */ }
    else feld += c;
  }
  if (feld !== "" || zeile.length) { zeile.push(feld); zeilen.push(zeile); }
  return zeilen.map((z) => z.map((f) => f.trim()));
}

/* ------------------------------------------------------- Spalten erkennen */

/*
 * Bezeichnungen, unter denen die Banken dieselbe Sache fuehren. Verglichen
 * wird kleingeschrieben und ohne Sonderzeichen, damit "Waehrung", "Währung"
 * und "WAEHRUNG" zusammenfallen.
 */
const SPALTEN = {
  datum: ["buchungstag", "buchungsdatum", "datum", "belegdatum", "buchung",
    "date", "bookingdate", "transactiondate", "completeddate", "starteddate"],
  valuta: ["valutadatum", "wertstellung", "valuta", "wertstellungstag", "valuedate"],
  betrag: ["betrag", "betrageur", "umsatz", "betragin eur", "betrag in eur", "umsatzin eur",
    "amount", "amounteur", "value"],
  soll: ["soll", "belastung", "auszahlung", "ausgang", "debit", "paidout"],
  haben: ["haben", "gutschrift", "einzahlung", "eingang", "credit", "paidin"],
  vorzeichen: ["sollhaben", "soll haben", "shkennzeichen", "sh", "debitcredit"],
  waehrung: ["waehrung", "wahrung", "currency"],
  beteiligter: ["beguenstigterzahlungspflichtiger", "begunstigterzahlungspflichtiger",
    "auftraggeberbeguenstigter", "auftraggeberbegunstigter", "namezahlungsbeteiligter",
    "zahlungsbeteiligter", "empfaengerzahlungspflichtiger", "empfaenger", "name",
    "auftraggeber", "beguenstigter", "zahlungsempfaenger",
    "payee", "counterparty", "beneficiary", "partnername"],
  iban: ["kontonummeriban", "ibanzahlungsbeteiligter", "iban", "kontonummer", "kontoauftraggeber",
    "partneriban", "counterpartyaccount"],
  bic: ["bicswiftcode", "bic", "swiftcode", "blz", "bankleitzahl"],
  zweck: ["verwendungszweck", "vorgangverwendungszweck", "verwendungszweckzahlungsbeteiligter",
    "beschreibung", "referenz", "description", "paymentreference", "reference", "details"],
  buchungstext: ["buchungstext", "vorgang", "umsatzart", "transaktionstyp", "art", "type"],
  referenz: ["kundenreferenzendtoend", "endtoendreferenz", "mandatsreferenz", "kundenreferenz"],
  /*
   * Der Kontostand nach jeder Buchung. Viele Banken liefern ihn mit, und er
   * ist mehr wert als er aussieht: Aus ihm laesst sich nachrechnen, ob jeder
   * Betrag richtig gelesen wurde - und er erspart es, den Endsaldo fuer die
   * Abstimmung von Hand abzutippen.
   */
  saldo: ["saldonachbuchung", "saldo", "kontostand", "balance", "saldoineur", "neuersaldo"],
};

function schluessel(text) {
  return String(text || "").toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Findet die Kopfzeile.
 *
 * Manche Banken stellen dem eigentlichen Auszug noch Zeilen mit Kontonummer
 * und Zeitraum voran. Als Kopfzeile gilt deshalb die erste Zeile, in der sich
 * sowohl ein Datums- als auch ein Betragsfeld wiedererkennen laesst.
 */
function kopfzeileFinden(zeilen) {
  for (let i = 0; i < Math.min(zeilen.length, 20); i++) {
    const namen = zeilen[i].map(schluessel);
    const hatDatum = namen.some((n) => SPALTEN.datum.includes(n) || SPALTEN.valuta.includes(n));
    const hatBetrag = namen.some((n) => SPALTEN.betrag.includes(n) ||
      SPALTEN.soll.includes(n) || SPALTEN.haben.includes(n));
    if (hatDatum && hatBetrag && zeilen[i].length >= 3) return i;
  }
  return -1;
}

/** Ordnet jeder bekannten Bedeutung die Spaltennummer zu, soweit erkennbar. */
function spaltenZuordnen(kopf) {
  const namen = kopf.map(schluessel);
  const zuordnung = {};
  for (const [bedeutung, kandidaten] of Object.entries(SPALTEN)) {
    // Erst genaue Treffer, dann Spalten, die den Namen enthalten - damit
    // "Betrag (EUR)" auch dann gefunden wird, wenn es nicht genau passt.
    let i = namen.findIndex((n) => kandidaten.includes(n));
    if (i < 0) i = namen.findIndex((n) => n && kandidaten.some((k) => k.length > 4 && n.startsWith(k)));
    if (i >= 0) zuordnung[bedeutung] = i;
  }
  return zuordnung;
}

/* ---------------------------------------------------------- Werte deuten */

/** Datum in den Schreibweisen, die auf Kontoauszuegen vorkommen. */
function datumLesen(wert) {
  const s = String(wert || "").trim();
  let m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{2})$/.exec(s);
  if (m) {
    // Zweistellige Jahre: alles unter 70 ist dieses Jahrhundert. Kontoauszuege
    // aus den Sechzigern wird niemand einlesen.
    const jahr = Number(m[3]) < 70 ? 2000 + Number(m[3]) : 1900 + Number(m[3]);
    return `${jahr}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return null;
}

/**
 * Betrag in Cent.
 *
 * Deutsche Auszuege schreiben "1.234,56", englische "1234.56". Unterschieden
 * wird am letzten Trennzeichen: Was danach zwei Stellen hat, sind die Cent.
 * Rueckgabe null heisst: nicht lesbar - dann wird die Zeile nicht uebernommen,
 * statt mit einem falschen Betrag weiterzurechnen.
 */
function betragLesen(wert) {
  let s = String(wert == null ? "" : wert).trim().replace(/\s|€|EUR/gi, "");
  if (!s) return null;
  let negativ = false;
  if (/^\(.*\)$/.test(s)) { negativ = true; s = s.slice(1, -1); }      // (123,45)
  if (s.endsWith("-")) { negativ = true; s = s.slice(0, -1); }          // 123,45-
  if (s.startsWith("-")) { negativ = true; s = s.slice(1); }
  if (s.startsWith("+")) s = s.slice(1);
  if (!/^[\d.,]+$/.test(s)) return null;

  const letztesKomma = s.lastIndexOf(","), letzterPunkt = s.lastIndexOf(".");
  let zahl;
  if (letztesKomma >= 0 && letzterPunkt >= 0) {
    zahl = letztesKomma > letzterPunkt
      ? s.replace(/\./g, "").replace(",", ".")     // 1.234,56
      : s.replace(/,/g, "");                        // 1,234.56
  } else if (letztesKomma >= 0) {
    zahl = s.length - letztesKomma - 1 === 3 && !/,\d{3}$/.test(s.slice(0, letztesKomma + 4))
      ? s.replace(",", ".") : s.replace(",", ".");
    // "1,234" ist zweideutig. Drei Nachkommastellen gibt es bei Geld nicht -
    // dann war es ein Tausendertrennzeichen.
    if (s.length - letztesKomma - 1 === 3) zahl = s.replace(",", "");
  } else if (letzterPunkt >= 0) {
    zahl = s.length - letzterPunkt - 1 === 3 ? s.replace(".", "") : s;
  } else zahl = s;

  const n = Number(zahl);
  if (!isFinite(n)) return null;
  return Math.round(n * 100) * (negativ ? -1 : 1);
}

/* ------------------------------------------------------------- Einlesen */

/**
 * Liest die Datei und gibt die Umsaetze zurueck.
 *
 * zuordnung: {datum: 1, betrag: 14, ...} - ueberschreibt die Erkennung, wenn
 * der Benutzer die Spalten von Hand zugeordnet hat.
 */
function lesen(daten, zuordnung) {
  const text = textLesen(daten);
  if (!text.trim()) throw Object.assign(new Error("Die Datei ist leer."), { status: 400 });

  const trenner = trennzeichenRaten(text);
  const zeilen = zerlegen(text, trenner).filter((z) => z.some((f) => f !== ""));
  if (!zeilen.length) throw Object.assign(new Error("Die Datei enthält keine Zeilen."), { status: 400 });

  const kopfZeile = kopfzeileFinden(zeilen);
  const kopf = kopfZeile >= 0 ? zeilen[kopfZeile] : [];
  const erkannt = kopfZeile >= 0 ? spaltenZuordnen(kopf) : {};
  const s = Object.assign({}, erkannt, zuordnung || {});

  const fehlt = [];
  if (s.datum === undefined && s.valuta === undefined) fehlt.push("Buchungstag");
  if (s.betrag === undefined && s.soll === undefined && s.haben === undefined) fehlt.push("Betrag");
  if (fehlt.length) {
    return { fehlerhaft: true, fehlt, kopf, trenner,
      erkannt: s, beispiel: zeilen.slice(kopfZeile + 1, kopfZeile + 4) };
  }

  const umsaetze = [];
  const uebersprungen = [];
  for (let i = kopfZeile + 1; i < zeilen.length; i++) {
    const z = zeilen[i];
    const hole = (name) => (s[name] !== undefined && z[s[name]] !== undefined ? z[s[name]] : "");

    const datum = datumLesen(hole("datum")) || datumLesen(hole("valuta"));
    if (!datum) {
      // Schlusszeilen wie "Anfangssaldo" oder "Endsaldo" haben kein Datum.
      if (z.join("").trim()) uebersprungen.push({ zeile: i + 1, text: z.join(" ").slice(0, 80) });
      continue;
    }

    let cent = null;
    if (s.betrag !== undefined) cent = betragLesen(hole("betrag"));
    if (cent === null && (s.soll !== undefined || s.haben !== undefined)) {
      const soll = betragLesen(hole("soll")), haben = betragLesen(hole("haben"));
      if (soll) cent = -Math.abs(soll);
      else if (haben) cent = Math.abs(haben);
    }
    if (cent === null) { uebersprungen.push({ zeile: i + 1, text: z.join(" ").slice(0, 80) }); continue; }

    // Eigene Soll/Haben-Spalte hat Vorrang vor dem Vorzeichen im Betrag.
    const sh = String(hole("vorzeichen") || "").trim().toUpperCase();
    if (sh === "S") cent = -Math.abs(cent);
    else if (sh === "H") cent = Math.abs(cent);

    if (cent === 0) { uebersprungen.push({ zeile: i + 1, text: "Betrag 0,00" }); continue; }

    umsaetze.push({
      datum,
      valuta: datumLesen(hole("valuta")) || datum,
      centBetrag: cent,
      waehrung: (hole("waehrung") || "EUR").toUpperCase().slice(0, 3) || "EUR",
      beteiligter: hole("beteiligter").slice(0, 120),
      iban: hole("iban").replace(/\s/g, "").toUpperCase().slice(0, 34),
      bic: hole("bic").replace(/\s/g, "").toUpperCase().slice(0, 15),
      zweck: hole("zweck").replace(/\s+/g, " ").slice(0, 500),
      buchungstext: hole("buchungstext").slice(0, 80),
      referenz: hole("referenz").slice(0, 80),
      saldoCent: s.saldo !== undefined ? betragLesen(hole("saldo")) : null,
    });
  }

  return { umsaetze, kopf, trenner, erkannt: s, uebersprungen,
    fremdwaehrung: umsaetze.filter((u) => u.waehrung && u.waehrung !== "EUR").length,
    salden: saldenPruefen(umsaetze) };
}

/**
 * Gegenprobe ueber die Saldenspalte.
 *
 * Liefert die Bank den Kontostand nach jeder Buchung mit, laesst sich die
 * ganze Datei nachrechnen: Anfangsbestand plus die Summe aller Umsaetze muss
 * den Endsaldo ergeben. Stimmt das nicht, wurde eine Spalte falsch gedeutet -
 * und das faellt sonst erst beim Abstimmen auf, wenn es niemand mehr dem
 * Import zuordnet.
 *
 * Zusaetzlich wird die Kette selbst geprueft: Ist der Auszug gefiltert
 * heruntergeladen worden (etwa nur Gutschriften), klaffen darin Luecken. Die
 * Umsaetze sind dann zwar richtig, aber unvollstaendig - was fuer eine
 * Buchfuehrung ein Unterschied ums Ganze ist.
 */
function saldenPruefen(umsaetze) {
  const mitSaldo = umsaetze.filter((u) => u.saldoCent !== null && u.saldoCent !== undefined);
  if (mitSaldo.length < 2 || mitSaldo.length !== umsaetze.length) {
    return { vorhanden: false };
  }

  // Die Dateien kommen mal neueste, mal aelteste Zeile zuerst.
  const neuesteZuerst = umsaetze[0].datum >= umsaetze[umsaetze.length - 1].datum;
  const geordnet = neuesteZuerst ? umsaetze.slice().reverse() : umsaetze.slice();

  const anfang = geordnet[0].saldoCent - geordnet[0].centBetrag;
  const ende = geordnet[geordnet.length - 1].saldoCent;
  const summe = geordnet.reduce((s, u) => s + u.centBetrag, 0);

  let luecken = 0;
  for (let i = 1; i < geordnet.length; i++) {
    if (geordnet[i - 1].saldoCent + geordnet[i].centBetrag !== geordnet[i].saldoCent) luecken++;
  }

  return {
    vorhanden: true,
    anfangCent: anfang, endeCent: ende, summeCent: summe,
    differenzCent: anfang + summe - ende,
    stimmt: anfang + summe === ende,
    luecken,
    anfangDatum: geordnet[0].datum,
    endeDatum: geordnet[geordnet.length - 1].datum,
  };
}

/**
 * Kennung eines Umsatzes, um dieselbe Buchung beim naechsten Einlesen
 * wiederzuerkennen.
 *
 * Kontoauszuege werden ueberlappend heruntergeladen - derselbe Umsatz steht
 * dann in zwei Dateien und duerfte nicht zweimal erscheinen. Zwei am selben
 * Tag wirklich gleiche Umsaetze (etwa zwei gleiche Gebuehren) muessen aber
 * beide bleiben. Deshalb wird die laufende Nummer gleicher Umsaetze
 * mitgezaehlt: Beim zweiten Einlesen ergeben sich dieselben Nummern, ein
 * echter dritter Umsatz bekaeme dagegen eine neue.
 */
function kennung(konto, u, lfd) {
  const basis = [konto, u.datum, u.centBetrag, u.iban, u.beteiligter, u.zweck].join("|");
  return crypto.createHash("sha256").update(basis).digest("hex").slice(0, 24) + "-" + lfd;
}

module.exports = { lesen, kennung, betragLesen, datumLesen, textLesen, zerlegen, saldenPruefen,
  trennzeichenRaten, spaltenZuordnen, kopfzeileFinden, SPALTEN };
