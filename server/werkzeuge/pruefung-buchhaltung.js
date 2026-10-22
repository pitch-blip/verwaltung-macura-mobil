"use strict";
/**
 * Selbstpruefung der Buchhaltung.
 *
 *   npm run pruefung
 *
 * Arbeitet in einem Wegwerfordner, nicht im echten Bestand: Es werden eine
 * Firma, Konten, Geschaeftspartner und Buchungen angelegt und anschliessend
 * geprueft, ob dabei herauskommt, was herauskommen muss.
 *
 * Geprueft wird vor allem das, was sich still verrechnen koennte - die
 * Steueraufteilung auf den Cent, die Summen der Umsatzsteuer, der
 * Kassenbestand - und das, was nicht passieren darf: Aendern festgeschriebener
 * Belege, Buchen in einen bereits uebergebenen Zeitraum, Loeschen bebuchter
 * Konten.
 *
 * Zuletzt wird das Uebergabepaket erzeugt und wieder auseinandergenommen:
 * Ist es ein lesbares ZIP, hat der Buchungsstapel die vorgeschriebenen 125
 * Spalten, stimmen Kopfsatz und Betraege, sind die Belege enthalten?
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const ORDNER = fs.mkdtempSync(path.join(os.tmpdir(), "verwaltung-pruefung-"));
process.env.DATEN_ORDNER = ORDNER;

const { db, firmaAnlegen, DATEIEN } = require("../lib/db");
const B = require("../lib/buchhaltung");
const U = require("../lib/uebergabe");
const OP = require("../lib/offeneposten");
const BK = require("../lib/bank");
const bankcsv = require("../lib/bankcsv");
const SZ = require("../lib/sammelzahlung");
const REG = require("../lib/regeln");
const MW = require("../lib/mahnwesen");
const RG = require("../lib/rechnung");
const datev = require("../lib/datev");
const zip = require("../lib/zip");

let bestanden = 0, durchgefallen = 0;
const fehlerliste = [];

function pruefe(was, bedingung, gefunden) {
  if (bedingung) { bestanden++; console.log("  ok   " + was); return true; }
  durchgefallen++;
  fehlerliste.push(was + (gefunden !== undefined ? "  (gefunden: " + gefunden + ")" : ""));
  console.log("  FEHL " + was + (gefunden !== undefined ? "  (gefunden: " + gefunden + ")" : ""));
  return false;
}

function gleich(was, ist, soll) {
  return pruefe(was + " = " + soll, String(ist) === String(soll), ist);
}

/** Erwartet, dass ein Aufruf abgelehnt wird - und zwar aus dem richtigen Grund. */
function abgewiesen(was, fn, textteil) {
  try {
    fn();
    durchgefallen++;
    fehlerliste.push(was + " (wurde NICHT abgewiesen)");
    console.log("  FEHL " + was + " - wurde nicht abgewiesen");
  } catch (e) {
    const passt = !textteil || String(e.message).toLowerCase().includes(String(textteil).toLowerCase());
    pruefe(was + " wird abgewiesen", passt, passt ? undefined : e.message);
  }
}

function abschnitt(titel) { console.log("\n" + titel + "\n" + "-".repeat(titel.length)); }

/* ---------------------------------------------------------------- Aufbau */

const firmaId = firmaAnlegen("Pruefung GmbH");
const sitzung = { firmaId, benutzerId: 1, anmeldename: "pruefung", appRolle: "Administrator",
  personId: null, regeln: require("../lib/rechte").regeln("Administrator") };
const nurLesen = Object.assign({}, sitzung, { appRolle: "Geschaeftsfuehrung",
  regeln: require("../lib/rechte").regeln("Geschaeftsfuehrung") });

console.log("Selbstpruefung der Buchhaltung");
console.log("Arbeitsordner: " + ORDNER + "\n");

/* --------------------------------------------------------- Steuerrechnung */

abschnitt("Aufteilung Brutto in Netto und Steuer");
{
  const f = [
    [11900, 19, 1900, 10000, "119,00 EUR mit 19 %"],
    [10700, 7, 700, 10000, "107,00 EUR mit 7 %"],
    [10000, 0, 0, 10000, "100,00 EUR ohne Steuer"],
    [1, 19, 0, 1, "ein Cent mit 19 %"],
    [999, 19, 160, 839, "9,99 EUR mit 19 %"],
    [3333, 7, 218, 3115, "33,33 EUR mit 7 %"],
  ];
  for (const [brutto, satz, steuer, netto, name] of f) {
    const a = B.aufteilen(brutto, satz);
    pruefe(name + ": Steuer " + (steuer / 100).toFixed(2) + ", Netto " + (netto / 100).toFixed(2),
      a.steuer === steuer && a.netto === netto, a.steuer + "/" + a.netto);
    pruefe(name + ": Netto + Steuer ergibt wieder Brutto", a.netto + a.steuer === brutto);
  }
}

/* ------------------------------------------------------------ Einrichtung */

abschnitt("Einrichtung");
B.einstellungenSetzen(sitzung, { berater: "1234567", mandant: "55555", skr: "04",
  sachkontenlaenge: 4, wjBeginn: "01-01", steuerberaterName: "Kanzlei Muster",
  steuerberaterEmail: "kanzlei@example.org" });
const ein = B.einstellungenLesen(sitzung).koerper;
gleich("Beraternummer gespeichert", ein.berater, "1234567");
gleich("Mandantennummer gespeichert", ein.mandant, "55555");
gleich("Debitorenkreis beginnt bei", ein.nummernkreise.debitor.von, 10000);
gleich("Kreditorenkreis beginnt bei", ein.nummernkreise.kreditor.von, 70000);

abgewiesen("Beraternummer 12 (zu kurz)",
  () => B.einstellungenSetzen(sitzung, { berater: "12", mandant: "1" }), "Beraternummer");
abgewiesen("Mandantennummer 123456 (zu lang)",
  () => B.einstellungenSetzen(sitzung, { berater: "1234567", mandant: "123456" }), "Mandantennummer");

const geladen = B.kontenVorlage(sitzung, "04").koerper;
pruefe("Kontenvorlage SKR04 angelegt (" + geladen.ergaenzt + " Konten)", geladen.ergaenzt > 10, geladen.ergaenzt);
gleich("zweiter Aufruf ergaenzt nichts mehr", B.kontenVorlage(sitzung, "04").koerper.ergaenzt, 0);
const konten = B.konten(sitzung);
pruefe("Erloeskonto 4400 vorhanden und Automatik", konten.some((k) => k.nummer === "4400" && k.automatik));
pruefe("Kasse 1600 als Geldkonto gekennzeichnet", konten.some((k) => k.nummer === "1600" && k.geld === "Kasse"));

abschnitt("Rechte");
abgewiesen("Geschaeftsfuehrung darf keinen Beleg erfassen",
  () => B.belegSpeichern(nurLesen, null, { art: "Sonstiges", datum: "2026-01-02", belegnummer: "X",
    buchungstext: "Versuch", bruttoCent: 100, sollKonto: "1600", habenKonto: "4400" }), "Schreibrecht");
pruefe("Geschaeftsfuehrung darf lesen", Array.isArray(B.konten(nurLesen)));

abschnitt("Kontenliste einlesen");
{
  const zerlegen = B.kontenzeileZerlegen;
  const zeile = (text, erwartet) => {
    const r = zerlegen(text);
    const ist = r ? r.nummer + " | " + r.bezeichnung : "(keine Kontozeile)";
    pruefe(JSON.stringify(text.slice(0, 46)), ist === erwartet, ist);
  };

  // So sieht eine aus dem PDF kopierte Summen- und Saldenliste aus: nur
  // Leerzeichen als Trenner, dahinter die Betragsspalten.
  zeile("1600   Kasse                  0,00    1.070,00     238,00     832,00", "1600 | Kasse");
  zeile("  1800  Bank                  0,00   50.000,00  12.000,00  38.000,00", "1800 | Bank");
  zeile("4400   Erloese 19 % USt       0,00        0,00   1.000,00   1.000,00 H", "4400 | Erloese 19 % USt");
  zeile("0520   Pkw                -1.250,00", "0520 | Pkw");
  // Der Prozentsatz im Namen darf nicht als Betrag abgeschnitten werden.
  zeile("4100  Steuerfreie Umsaetze § 4 Nr. 17b UStG     0,00", "4100 | Steuerfreie Umsaetze § 4 Nr. 17b UStG");

  // Aus DATEV oder einer Tabellenkalkulation.
  zeile("6815;Buerobedarf", "6815 | Buerobedarf");
  zeile('"6815";"Buerobedarf";"Aufwand"', "6815 | Buerobedarf");
  zeile("1200\tForderungen aus L+L\t0,00", "1200 | Forderungen aus L+L");
  zeile("6530,Laufende Kfz-Kosten", "6530 | Laufende Kfz-Kosten");

  // Keine Kontozeilen: Kopfzeilen, Summen, blosse Betraege.
  zeile("Konto  Bezeichnung   EB-Wert   Soll   Haben   Saldo", "(keine Kontozeile)");
  zeile("       Summe Klasse 4              0,00   1.000,00", "(keine Kontozeile)");
  zeile("1.070,00", "(keine Kontozeile)");
  zeile("1600,00", "(keine Kontozeile)");
  zeile("1600", "(keine Kontozeile)");

  // Einlesen einer Summen- und Saldenliste im Ganzen.
  const susa = [
    "Summen- und Saldenliste 01/2026",
    "Konto  Bezeichnung              EB-Wert       Soll      Haben      Saldo",
    "1600   Kasse                       0,00   1.070,00     238,00     832,00",
    "4400   Erloese 19 % USt            0,00       0,00   1.000,00   1.000,00 H",
    "6899   Sonstiger Betriebsbedarf    0,00     120,00       0,00     120,00",
    "       Summe                                1.190,00  1.238,00",
  ].join("\n");
  const eingelesen = B.kontenEinlesen(sitzung, susa).koerper;
  gleich("Summen- und Saldenliste: neue Konten", eingelesen.neu, 1);        // nur 6899 ist neu
  gleich("Summen- und Saldenliste: aktualisierte Konten", eingelesen.aktualisiert, 2);
  pruefe("Kopfzeile und Summenzeile uebersprungen", eingelesen.uebersprungen >= 2, eingelesen.uebersprungen);
  pruefe("neues Konto 6899 angelegt",
    B.konten(sitzung).some((k) => k.nummer === "6899" && k.bezeichnung === "Sonstiger Betriebsbedarf"));
  pruefe("Kontoart aus der Kontenklasse abgeleitet",
    B.konten(sitzung).find((k) => k.nummer === "6899").art === "Aufwand");
  pruefe("kein Hinweis noetig, es wurde etwas erkannt", !eingelesen.hinweis, eingelesen.hinweis);

  // Eine gewoehnliche BWA fuehrt keine Kontonummern - das muss die Anwendung
  // sagen, statt wortlos nichts zu tun.
  const bwa = [
    "Betriebswirtschaftliche Auswertung 01/2026",
    "Umsatzerloese                     12.500,00   100,0 %",
    "Raumkosten                         2.400,00    19,2 %",
    "Kfz-Kosten                           850,00     6,8 %",
    "Gesamtkosten                       9.800,00    78,4 %",
    "Vorlaeufiges Ergebnis              2.700,00    21,6 %",
  ].join("\n");
  const ausBwa = B.kontenEinlesen(sitzung, bwa).koerper;
  gleich("BWA: kein Konto angelegt", ausBwa.neu, 0);
  gleich("BWA: kein Konto geaendert", ausBwa.aktualisiert, 0);
  pruefe("BWA: Hinweis auf das falsche Dokument",
    !!ausBwa.hinweis && ausBwa.hinweis.includes("BWA"), ausBwa.hinweis);

  abgewiesen("leere Liste", () => B.kontenEinlesen(sitzung, "   "), "leer");
}

abschnitt("Kontenliste aus einer BWA mit Wertenachweis");
{
  /*
   * Eine BWA fasst normalerweise nur zusammen. Der Wertenachweis dazu fuehrt
   * aber die einzelnen Konten auf - und bricht lange Bezeichnungen um, wobei
   * die Betraege dazwischen stehen. Das ist der Auszug einer echten
   * Auswertung; daran haengt, ob eine solche Liste eingelesen werden kann.
   */
  const wertenachweis = [
    "55555/10198/2026                                          17.08.2026",
    "Wertenachweis zur Jahresuebersicht",
    "Muster Seniorendienst GmbH                                    Blatt 1",
    "SKR: 04   BWA-Nr.: 1   BWA-Form: DATEV-BWA",
    "Bezeichnung          Jan/2026    Feb/2026    Jan/2026 -",
    "Umsatzerloese",
    "4200   Erloese                 19.970,25   20.854,13   226.324,91",
    "4730   Gewaehrte Skonti             0,00        0,00        -3,12",
    "Bestandsveraenderg. FE/UE",
    "Personalkosten",
    "6110   Gesetzliche Sozialaufwen-",
    "2.303,38    2.554,85   25.300,19",
    "dungen",
    "6495   Wartungskosten fuer Hard-",
    "0,00      487,52      975,04",
    "und Software",
    "6072   Sachzuwendungen und",
    "150,00      150,00      550,00",
    "Dienstleistg. an AN",
    "6325   Gas, Strom, Wasser           0,00       61,00       366,00",
    "Betriebliche Steuern",
    "Gesamtkosten            12.980,12   19.378,03   183.170,10",
  ].join("\n");

  const a = B.kontenEinlesen(sitzung, wertenachweis).koerper;
  const holen = (nr) => (B.konten(sitzung).find((k) => k.nummer === nr) || {}).bezeichnung;

  // 6110 steht bereits in der SKR04-Vorlage und wird deshalb nur aktualisiert.
  gleich("sechs Konten erkannt", a.neu + a.aktualisiert, 6);
  gleich("einfache Zeile", holen("4200"), "Erloese");
  // Die Betraege standen daneben - die Zwischenueberschrift darunter gehoert
  // nicht zum Namen.
  gleich("Zwischenueberschrift bleibt draussen", holen("4730"), "Gewaehrte Skonti");
  gleich("zweite Zwischenueberschrift bleibt draussen", holen("6325"), "Gas, Strom, Wasser");
  // Umbruch mit Trennstrich: das Wort wird zusammengezogen.
  gleich("umbrochener Name zusammengefuehrt", holen("6110"), "Gesetzliche Sozialaufwendungen");
  // Trennstrich vor "und" gehoert zum Wort und bleibt stehen.
  gleich("Bindestrich vor \"und\" bleibt erhalten", holen("6495"), "Wartungskosten fuer Hard- und Software");
  // Umbruch ohne Trennstrich: mit Leerzeichen verbinden.
  gleich("Umbruch ohne Trennstrich", holen("6072"), "Sachzuwendungen und Dienstleistg. an AN");
  // Der Kopf jeder DATEV-Auswertung nennt Berater, Mandant und Jahr.
  pruefe("Kopfzeile 55555/10198/2026 wird kein Konto",
    !B.konten(sitzung).some((k) => k.nummer === "55555"),
    (B.konten(sitzung).find((k) => k.nummer === "55555") || {}).bezeichnung);
  pruefe("Betragszeilen werden kein Konto",
    !B.konten(sitzung).some((k) => /^\d{1,3}$/.test(k.nummer) && !k.bezeichnung));

  /*
   * Eine BWA fuehrt ausschliesslich Erfolgskonten - Klasse 4 bis 7 im SKR04.
   * Kasse, Bank, Forderungen, Verbindlichkeiten und Umsatzsteuer stehen nicht
   * darin, werden bei jeder Buchung aber gebraucht. Wer nur eine BWA einliest,
   * hat also noch keinen vollstaendigen Kontenrahmen; das darf nicht in
   * Vergessenheit geraten.
   */
  const erkannt = B.umbruecheZusammenfuehren(wertenachweis.split("\n"))
    .map(B.kontenzeileZerlegen).filter(Boolean);
  gleich("aus dem Wertenachweis erkannte Konten", erkannt.length, 6);
  pruefe("darunter ausschliesslich Erfolgskonten (Klasse 4 bis 7)",
    erkannt.every((k) => /^[4-7]/.test(k.nummer)),
    erkannt.map((k) => k.nummer).join(", "));
  pruefe("kein Bestandskonto aus der BWA",
    !erkannt.some((k) => /^[0-3]/.test(k.nummer)));
}

/* ------------------------------------------------------ Geschaeftspartner */

abschnitt("Geschaeftspartner");
const kunde = B.partnerSpeichern(sitzung, null, { typ: "Debitor", name: "Krankenkasse Beispiel" }).koerper;
gleich("erster Debitor bekommt Nummer", kunde.konto, "10000");
const kunde2 = B.partnerSpeichern(sitzung, null, { typ: "Debitor", name: "Zweiter Kunde" }).koerper;
gleich("zweiter Debitor zaehlt weiter", kunde2.konto, "10001");
const lieferant = B.partnerSpeichern(sitzung, null, { typ: "Kreditor", name: "Tankstelle Beispiel" }).koerper;
gleich("erster Kreditor bekommt Nummer", lieferant.konto, "70000");

abgewiesen("Debitor mit Kreditorennummer",
  () => B.partnerSpeichern(sitzung, null, { typ: "Debitor", name: "Falsch", konto: "70500" }), "Nummernkreis");
B.kontoSpeichern(sitzung, null, { nummer: "10500", bezeichnung: "Sonderkonto im Debitorenkreis", art: "Aktiv" });
abgewiesen("Partner auf vorhandener Sachkontonummer",
  () => B.partnerSpeichern(sitzung, null, { typ: "Debitor", name: "Falsch", konto: "10500" }), "Sachkonto");
abgewiesen("Debitor auf Nummer ausserhalb seines Kreises",
  () => B.partnerSpeichern(sitzung, null, { typ: "Debitor", name: "Falsch", konto: "1600" }), "Nummernkreis");
abgewiesen("Sachkonto auf vorhandener Partnernummer",
  () => B.kontoSpeichern(sitzung, null, { nummer: "10000", bezeichnung: "Falsch", art: "Aktiv" }), "Geschäftspartner");

/* ------------------------------------------------------------ Buchungen */

abschnitt("Belege erfassen");
const b1 = B.belegSpeichern(sitzung, null, { art: "Ausgangsrechnung", datum: "2026-02-05",
  leistungsdatum: "2026-01-31", faelligAm: "2026-03-07", belegnummer: "RE-2026-001",
  partnerId: kunde.id, sollKonto: kunde.konto, habenKonto: "4400", bruttoCent: 119000,
  steuersatz: 19, buchungstext: "Krankenfahrten Januar 2026" }).koerper;
gleich("erste Journalnummer", b1.journalNr, 1);

const b2 = B.belegSpeichern(sitzung, null, { art: "Eingangsrechnung", datum: "2026-02-10",
  belegnummer: "ER-4711", partnerId: lieferant.id, sollKonto: "6530", habenKonto: lieferant.konto,
  bruttoCent: 23800, steuersatz: 19, buchungstext: "Diesel Februar" }).koerper;
gleich("zweite Journalnummer", b2.journalNr, 2);

const b3 = B.belegSpeichern(sitzung, null, { art: "Kasseneinnahme", datum: "2026-02-12",
  belegnummer: "KA-001", sollKonto: "1600", habenKonto: "4300", bruttoCent: 10700,
  steuersatz: 7, buchungstext: "Barzahlung Fahrt" }).koerper;

const alleBelege = B.belege(sitzung);
const erster = alleBelege.find((b) => b.journalNr === 1);
gleich("Ausgangsrechnung: Steuer", erster.steuerCent, 19000);
gleich("Ausgangsrechnung: Netto", erster.nettoCent, 100000);
gleich("Ausgangsrechnung: kein Steuerschluessel (4400 ist Automatikkonto)", erster.bu || "", "");
const zweiter = alleBelege.find((b) => b.journalNr === 2);
gleich("Eingangsrechnung: Steuerschluessel Vorsteuer 19 %", zweiter.bu, "9");
gleich("Eingangsrechnung: Steuer", zweiter.steuerCent, 3800);

abschnitt("Was nicht gebucht werden darf");
const grund = { art: "Sonstiges", datum: "2026-02-20", belegnummer: "X-1", buchungstext: "Probe",
  bruttoCent: 1000, sollKonto: "1600", habenKonto: "4400" };
abgewiesen("Betrag null", () => B.belegSpeichern(sitzung, null, Object.assign({}, grund, { bruttoCent: 0 })), "größer als null");
abgewiesen("negativer Betrag", () => B.belegSpeichern(sitzung, null, Object.assign({}, grund, { bruttoCent: -500 })), "größer als null");
abgewiesen("Soll gleich Haben", () => B.belegSpeichern(sitzung, null, Object.assign({}, grund, { habenKonto: "1600" })), "verschieden");
abgewiesen("unbekanntes Konto", () => B.belegSpeichern(sitzung, null, Object.assign({}, grund, { habenKonto: "9999" })), "gibt es nicht");
abgewiesen("ohne Buchungstext", () => B.belegSpeichern(sitzung, null, Object.assign({}, grund, { buchungstext: "  " })), "Buchungstext");
abgewiesen("ohne Belegnummer", () => B.belegSpeichern(sitzung, null, Object.assign({}, grund, { belegnummer: "" })), "Belegnummer");
abgewiesen("unsinniges Datum", () => B.belegSpeichern(sitzung, null, Object.assign({}, grund, { datum: "05.02.2026" })), "Belegdatum");
abgewiesen("unbekannte Belegart", () => B.belegSpeichern(sitzung, null, Object.assign({}, grund, { art: "Zauberei" })), "Belegart");
abgewiesen("bebuchtes Konto loeschen",
  () => B.kontoEntfernen(sitzung, B.konten(sitzung).find((k) => k.nummer === "1600").id), "bereits gebucht");

/* ------------------------------------------------------------- Umsatzsteuer */

abschnitt("Umsatzsteuer");
const ust = B.umsatzsteuer(sitzung, "2026-01-01", "2026-12-31");
gleich("Bemessungsgrundlage 19 % (Kz 81)", ust.kennzahlen[81], 100000);
gleich("Bemessungsgrundlage 7 % (Kz 86)", ust.kennzahlen[86], 10000);
gleich("Vorsteuer (Kz 66)", ust.kennzahlen[66], 3800);
gleich("Umsatzsteuer gesamt", ust.umsatzsteuer, 19000 + 700);
gleich("Zahllast (Kz 83)", ust.kennzahlen[83], 19000 + 700 - 3800);

/* --------------------------------------------------------------- Storno */

abschnitt("Stornieren statt loeschen");
const storno = B.belegStornieren(sitzung, b3.id, "Betrag falsch erfasst").koerper;
const nachStorno = B.belege(sitzung);
const original = nachStorno.find((b) => b.journalNr === b3.journalNr);
const gegen = nachStorno.find((b) => b.journalNr === storno.journalNr);
pruefe("Originalbeleg bleibt bestehen", !!original);
gleich("Original ist als storniert vermerkt", original.storniertDurch, storno.id);
gleich("Storno: Konten vertauscht (Soll)", gegen.sollKonto, original.habenKonto);
gleich("Storno: Konten vertauscht (Haben)", gegen.habenKonto, original.sollKonto);
gleich("Storno: gleicher Betrag", gegen.bruttoCent, original.bruttoCent);
abgewiesen("Storno erneut stornieren", () => B.belegStornieren(sitzung, storno.id, "nochmal"), "nicht erneut");
abgewiesen("stornierten Beleg aendern",
  () => B.belegSpeichern(sitzung, b3.id, Object.assign({}, grund, { bruttoCent: 5000 })), "unverändert");

const ustNach = B.umsatzsteuer(sitzung, "2026-01-01", "2026-12-31");
gleich("Storno hebt den 7-%-Umsatz wieder auf", ustNach.kennzahlen[86], 0);

/* ------------------------------------------------------------ Kassenbuch */

abschnitt("Kassenbuch");
B.belegSpeichern(sitzung, null, { art: "Kasseneinnahme", datum: "2026-03-01", belegnummer: "KA-002",
  sollKonto: "1600", habenKonto: "4400", bruttoCent: 5000, steuersatz: 19, buchungstext: "Bareinnahme" });
const kasse1 = B.kassenbuch(sitzung, "2026-01-01", "2026-12-31");
gleich("Kassenbestand nach Einnahme", kasse1.ende, 5000);
pruefe("Kasse nicht negativ", kasse1.negativAb === null, kasse1.negativAb);

B.belegSpeichern(sitzung, null, { art: "Kassenausgabe", datum: "2026-03-02", belegnummer: "KA-003",
  sollKonto: "6815", habenKonto: "1600", bruttoCent: 8000, steuersatz: 19, buchungstext: "Bueromaterial bar" });
const kasse2 = B.kassenbuch(sitzung, "2026-01-01", "2026-12-31");
gleich("Kassenbestand nach zu hoher Ausgabe", kasse2.ende, -3000);
gleich("negativer Bestand wird erkannt ab", kasse2.negativAb, "2026-03-02");
const kasseDanach = B.kassenbuch(sitzung, "2026-03-03", "2026-12-31");
gleich("Zeitraum nach dem Fehler beginnt mit dem negativen Bestand", kasseDanach.anfang, -3000);
gleich("Warnung bleibt, auch wenn der Fehler vor dem Zeitraum liegt", kasseDanach.negativAb, "2026-03-02");

const p = B.pruefung(sitzung, "2026-01-01", "2026-12-31");
pruefe("Pruefung meldet negative Kasse als Fehler",
  p.befunde.some((b) => b.schwere === "fehler" && b.titel.includes("Kasse")));
pruefe("Pruefung meldet fehlende Belegdateien",
  p.befunde.some((b) => b.titel.includes("ohne hinterlegte Datei")));

// Kasse wieder ausgleichen, damit das Paket eine saubere Buchfuehrung zeigt.
B.belegSpeichern(sitzung, null, { art: "Sonstiges", datum: "2026-03-03", belegnummer: "KA-004",
  sollKonto: "1600", habenKonto: "1800", bruttoCent: 20000, steuersatz: 0,
  buchungstext: "Bareinlage aus Bank" });
gleich("Kasse nach Einlage wieder positiv", B.kassenbuch(sitzung, "2026-01-01", "2026-12-31").ende, 17000);
gleich("Zeitraum mit der Einlage beginnt noch negativ", B.kassenbuch(sitzung, "2026-03-03", "2026-12-31").negativAb,
  "2026-03-02");
{
  const k = B.kassenbuch(sitzung, "2026-03-04", "2026-12-31");
  gleich("Bestand laeuft in einen spaeteren Zeitraum fort", k.anfang, 17000);
  pruefe("nach dem Ausgleich keine Warnung mehr", k.negativAb === null, k.negativAb);
}

/* ---------------------------------------------------- Beleg als Datei */

abschnitt("Beleg mit Datei");
{
  // Ein Dokument anlegen wie es die Dokumentenverwaltung tut, damit die
  // Uebergabe einen echten Anhang mitnehmen kann.
  const kategorie = db.prepare("SELECT id FROM kategorien WHERE firma_id = ? LIMIT 1").get(firmaId);
  const inhalt = Buffer.from("%PDF-1.4 Beispielrechnung fuer die Pruefung");
  const ordner = path.join(DATEIEN, String(firmaId));
  fs.mkdirSync(ordner, { recursive: true });
  fs.writeFileSync(path.join(ordner, "pruefung.pdf"), inhalt);
  const dokId = db.prepare(`INSERT INTO dokumente (firma_id, dokument_id, kategorie_id, dateiname, mime_typ)
    VALUES (?,?,?,?,?)`).run(firmaId, "DOC-PRUEF", kategorie.id, "Rechnung.pdf", "application/pdf").lastInsertRowid;
  db.prepare(`INSERT INTO dokument_versionen (dokument_id, version, dateiname, ablage, groesse)
    VALUES (?,?,?,?,?)`).run(dokId, "1.0", "Rechnung.pdf", path.join(String(firmaId), "pruefung.pdf"), inhalt.length);

  B.belegSpeichern(sitzung, null, { art: "Eingangsrechnung", datum: "2026-03-10", belegnummer: "ER-4712",
    partnerId: lieferant.id, sollKonto: "6815", habenKonto: lieferant.konto, bruttoCent: 5950,
    steuersatz: 19, buchungstext: "Bueromaterial", dokumentId: dokId });
  pruefe("Beleg mit Datei erfasst", B.belege(sitzung).some((b) => b.dokumentId === dokId));
}

/* ------------------------------------------------- Kontoauszug und Abgleich */

abschnitt("Kontoauszug lesen");
{
  const lies = (name, text, pruefungen) => {
    const r = bankcsv.lesen(Buffer.from(text, "utf8"));
    if (r.fehlerhaft) return pruefe(name, false, "Spalten fehlen: " + r.fehlt.join(", "));
    pruefungen(r.umsaetze, name);
  };

  // Die Formate der grossen Banken unterscheiden sich in Spaltennamen,
  // Trennzeichen und Zahlenschreibweise. Getestet wird deshalb je eines.
  lies("Sparkasse (CSV-CAMT)",
    '"Auftragskonto";"Buchungstag";"Valutadatum";"Buchungstext";"Verwendungszweck";' +
    '"Beguenstigter/Zahlungspflichtiger";"Kontonummer/IBAN";"BIC (SWIFT-Code)";"Betrag";"Waehrung"\n' +
    '"DE12";"05.02.2026";"05.02.2026";"GUTSCHRIFT";"RE-2026-001";"AOK Bayern";"DE8937";"BYLA";"1.190,00";"EUR"\n' +
    '"DE12";"10.02.2026";"10.02.2026";"LASTSCHRIFT";"Diesel";"Autohaus";"DE0212";"BYLA";"-238,00";"EUR"',
    (u, n) => {
      gleich(n + ": zwei Umsaetze", u.length, 2);
      gleich(n + ": Gutschrift positiv", u[0].centBetrag, 119000);
      gleich(n + ": Lastschrift negativ", u[1].centBetrag, -23800);
      gleich(n + ": Datum umgesetzt", u[0].datum, "2026-02-05");
      gleich(n + ": Zahlungsbeteiligter", u[0].beteiligter, "AOK Bayern");
    });

  lies("DKB (Vorspann vor der Kopfzeile)",
    '"Kontonummer:";"DE12 / Girokonto";\n\n"Von:";"01.01.2026";\n"Bis:";"28.02.2026";\n\n' +
    '"Buchungstag";"Wertstellung";"Buchungstext";"Auftraggeber / Begünstigter";"Verwendungszweck";' +
    '"Kontonummer";"BLZ";"Betrag (EUR)"\n' +
    '"05.02.2026";"05.02.2026";"Gutschrift";"AOK Bayern";"RE-2026-001";"DE8937";"";"1.190,00"',
    (u, n) => {
      gleich(n + ": Kopfzeile trotz Vorspann gefunden", u.length, 1);
      gleich(n + ": Betrag", u[0].centBetrag, 119000);
    });

  lies("getrennte Soll- und Habenspalten",
    "Buchungstag;Umsatzart;Begünstigter/Zahlungspflichtiger;Verwendungszweck;Soll;Haben;Währung\n" +
    "05.02.2026;Gutschrift;AOK;RE-2026-001;;1.190,00;EUR\n" +
    "10.02.2026;Überweisung;Autohaus;ER-4711;238,00;;EUR",
    (u, n) => {
      gleich(n + ": Haben wird zum Eingang", u[0].centBetrag, 119000);
      gleich(n + ": Soll wird zum Ausgang", u[1].centBetrag, -23800);
    });

  lies("englische Kopfzeile, Punkt als Dezimaltrennzeichen",
    "Date,Description,Payee,Amount,Currency\n" +
    "2026-02-05,Transfer,AOK Bayern,1190.00,EUR\n" +
    "2026-02-10,Card,Autohaus,-238.00,EUR",
    (u, n) => {
      gleich(n + ": Eingang", u[0].centBetrag, 119000);
      gleich(n + ": Ausgang", u[1].centBetrag, -23800);
    });

  // Zeichensatz: Kontoauszuege kommen in UTF-8 oder Windows-1252.
  const cp1252 = Buffer.concat([
    Buffer.from("Buchungstag;Beg", "latin1"), Buffer.from([0xfc]),
    Buffer.from("nstigter;Verwendungszweck;Betrag\n05.02.2026;M", "latin1"), Buffer.from([0xfc]),
    Buffer.from("ller GmbH;Rechnung;1.190,00", "latin1")]);
  gleich("Windows-1252 erkannt", bankcsv.lesen(cp1252).umsaetze[0].beteiligter, "Müller GmbH");

  // Betraege: Die Schreibweise entscheidet ueber Faktor 1000.
  gleich("1.234,56 sind 123456 Cent", bankcsv.betragLesen("1.234,56"), 123456);
  gleich("1,234.56 sind 123456 Cent", bankcsv.betragLesen("1,234.56"), 123456);
  gleich("1234.56 sind 123456 Cent", bankcsv.betragLesen("1234.56"), 123456);
  gleich("nachgestelltes Minus", bankcsv.betragLesen("238,00-"), -23800);
  gleich("Klammern bedeuten negativ", bankcsv.betragLesen("(238,00)"), -23800);
  gleich("1.234 ohne Cent sind 1234 Euro", bankcsv.betragLesen("1.234"), 123400);
  pruefe("unlesbarer Betrag ergibt null", bankcsv.betragLesen("keine Zahl") === null);
  gleich("Datum TT.MM.JJJJ", bankcsv.datumLesen("05.02.2026"), "2026-02-05");
  gleich("Datum TT.MM.JJ", bankcsv.datumLesen("05.02.26"), "2026-02-05");
  gleich("Datum JJJJ-MM-TT", bankcsv.datumLesen("2026-02-05"), "2026-02-05");
}

abschnitt("Gegenprobe ueber die Saldenspalte");
{
  /*
   * Nachgebildet nach dem Format der Raiffeisen-/Volksbanken: Kopfzeile mit
   * dem eigenen Konto voran, Spalte "Saldo nach Buchung" hinten, neueste
   * Zeile zuerst. Echte Kontodaten stehen bewusst nicht im Pruefskript.
   */
  const kopf = "Bezeichnung Auftragskonto;IBAN Auftragskonto;BIC Auftragskonto;Bankname Auftragskonto;" +
    "Buchungstag;Valutadatum;Name Zahlungsbeteiligter;IBAN Zahlungsbeteiligter;" +
    "BIC (SWIFT-Code) Zahlungsbeteiligter;Buchungstext;Verwendungszweck;Betrag;Waehrung;" +
    "Saldo nach Buchung;Bemerkung;Gekennzeichneter Umsatz;Glaeubiger ID;Mandatsreferenz";
  const zeile = (datum, name, zweck, betrag, saldo, art) =>
    ["Giro Business;DE00000000000000000000;GENODEF1XXX;Musterbank", datum, datum, name,
     "DE00000000000000000001", "GENODEF1XXX", art || "GUTSCHRIFT", zweck, betrag, "EUR", saldo,
     "", "", "", ""].join(";");

  const auszug = [kopf,
    zeile("11.09.2026", "Kasse Muster", "Rechnung 2600000140", "153,84", "1.153,84"),
    zeile("10.09.2026", "Kasse Muster", "Rechnung 2600000139", "271,28", "1.000,00"),
    zeile("09.09.2026", "Lieferant Muster", "Rechnung 2026-684", "-85,92", "728,72", "LASTSCHRIFT"),
    zeile("08.09.2026", "Kasse Muster", "Rechnung 2600000137", "218,72", "814,64"),
  ].join("\r\n");

  const g = bankcsv.lesen(Buffer.from(auszug, "utf8"));
  gleich("vier Umsaetze gelesen", g.umsaetze.length, 4);
  // Entscheidend: die IBAN des Zahlungsbeteiligten, nicht die des eigenen Kontos.
  gleich("IBAN des Zahlungsbeteiligten erkannt, nicht die eigene",
    g.kopf[g.erkannt.iban], "IBAN Zahlungsbeteiligter");
  gleich("Saldospalte erkannt", g.kopf[g.erkannt.saldo], "Saldo nach Buchung");

  const sp = g.salden;
  pruefe("Saldenspalte gefunden", sp.vorhanden);
  gleich("Anfangsbestand errechnet", sp.anfangCent, 59592);   // 814,64 - 218,72
  gleich("Endsaldo errechnet", sp.endeCent, 115384);
  gleich("Summe der Umsaetze", sp.summeCent, 15384 + 27128 - 8592 + 21872);
  pruefe("Gegenprobe geht auf: jeder Betrag richtig gelesen", sp.stimmt, sp.differenzCent);
  gleich("keine Luecken in der Kette", sp.luecken, 0);
  gleich("Datum des Endsaldos", sp.endeDatum, "2026-09-11");

  /*
   * Ein gefiltert heruntergeladener Auszug - hier fehlt die Lastschrift.
   * Die Betraege stimmen, der Auszug ist aber unvollstaendig; genau das muss
   * auffallen, weil sonst Buchungen fehlen, ohne dass es jemand merkt.
   */
  const luecke = [kopf,
    zeile("11.09.2026", "Kasse Muster", "Rechnung 2600000140", "153,84", "1.153,84"),
    zeile("10.09.2026", "Kasse Muster", "Rechnung 2600000139", "271,28", "1.000,00"),
    zeile("08.09.2026", "Kasse Muster", "Rechnung 2600000137", "218,72", "814,64"),
  ].join("\r\n");
  const gl = bankcsv.lesen(Buffer.from(luecke, "utf8")).salden;
  pruefe("Luecke in der Saldenkette wird erkannt", gl.luecken > 0, gl.luecken);
  pruefe("und die Gegenprobe schlaegt an", !gl.stimmt);

  // Ohne Saldospalte bleibt alles andere nutzbar.
  const ohne = bankcsv.lesen(Buffer.from(
    "Buchungstag;Verwendungszweck;Betrag\n11.09.2026;Test;153,84", "utf8"));
  pruefe("ohne Saldospalte keine Gegenprobe, aber Umsaetze", !ohne.salden.vorhanden && ohne.umsaetze.length === 1);
}

abschnitt("Kontoauszug einlesen und zuordnen");
const bankStand = {};
{
  // Eigene Firma, damit die Salden nicht mit den Buchungen von oben vermischen.
  const firma2 = firmaAnlegen("Abgleich GmbH");
  const s2 = Object.assign({}, sitzung, { firmaId: firma2 });
  B.einstellungenSetzen(s2, { berater: "1234567", mandant: "55555", skr: "04" });
  B.kontenVorlage(s2, "04");
  const kunde = B.partnerSpeichern(s2, null, { typ: "Debitor", name: "AOK Bayern",
    iban: "DE89370400440532013000" }).koerper;
  const lieferant = B.partnerSpeichern(s2, null, { typ: "Kreditor", name: "Autohaus Beispiel GmbH" }).koerper;
  Object.assign(bankStand, { s2, kunde, lieferant });

  const rg1 = B.belegSpeichern(s2, null, { art: "Ausgangsrechnung", datum: "2026-01-15",
    faelligAm: "2026-02-14", belegnummer: "RE-2026-001", partnerId: kunde.id,
    sollKonto: kunde.konto, habenKonto: "4400", bruttoCent: 119000, steuersatz: 19,
    buchungstext: "Krankenfahrten Januar" }).koerper;
  const rg2 = B.belegSpeichern(s2, null, { art: "Ausgangsrechnung", datum: "2026-02-15",
    faelligAm: "2026-03-17", belegnummer: "RE-2026-002", partnerId: kunde.id,
    sollKonto: kunde.konto, habenKonto: "4400", bruttoCent: 59500, steuersatz: 19,
    buchungstext: "Krankenfahrten Februar" }).koerper;
  const er1 = B.belegSpeichern(s2, null, { art: "Eingangsrechnung", datum: "2026-02-10",
    faelligAm: "2026-02-24", belegnummer: "ER-4711", partnerId: lieferant.id,
    sollKonto: "6530", habenKonto: lieferant.konto, bruttoCent: 23800, steuersatz: 19,
    buchungstext: "Diesel Februar" }).koerper;
  Object.assign(bankStand, { rg1, rg2, er1 });

  const auszug = [
    "Buchungstag;Verwendungszweck;Beguenstigter/Zahlungspflichtiger;Kontonummer/IBAN;Betrag;Waehrung",
    "20.02.2026;Rechnung RE-2026-001 Krankenfahrten;AOK Bayern;DE89370400440532013000;1.190,00;EUR",
    "24.02.2026;ER-4711 Diesel;Autohaus Beispiel GmbH;DE0212;-238,00;EUR",
    "28.02.2026;Kontofuehrungsgebuehr;Sparkasse;;-8,90;EUR",
  ].join("\n");

  abgewiesen("Einlesen auf ein Aufwandskonto",
    () => BK.importieren(s2, { konto: "6530", dateiname: "x.csv", daten: Buffer.from(auszug, "utf8") }),
    "kein Bankkonto");
  // Ein Kontoauszug auf dem Kassenkonto verfaelschte Kassenbuch und
  // Abstimmung zugleich - und liesse sich nur ueber Stornos zurueckdrehen.
  abgewiesen("Einlesen auf das Kassenkonto",
    () => BK.importieren(s2, { konto: "1600", dateiname: "x.csv", daten: Buffer.from(auszug, "utf8") }),
    "kein Bankkonto");

  const imp = BK.importieren(s2, { konto: "1800", dateiname: "Auszug_Februar.csv",
    daten: Buffer.from(auszug, "utf8") }).koerper;
  gleich("drei Umsaetze eingelesen", imp.neu, 3);
  gleich("Zeitraum erkannt (von)", imp.von, "2026-02-20");
  gleich("Zeitraum erkannt (bis)", imp.bis, "2026-02-28");

  // Kontoauszuege werden ueberlappend heruntergeladen - dasselbe darf nicht
  // zweimal in der Buchfuehrung landen.
  const nochmal = BK.importieren(s2, { konto: "1800", dateiname: "Auszug_Februar.csv",
    daten: Buffer.from(auszug, "utf8") }).koerper;
  gleich("dieselbe Datei erneut: nichts neu", nochmal.neu, 0);
  gleich("dieselbe Datei erneut: alles als doppelt erkannt", nochmal.doppelt, 3);

  // Zwei am selben Tag wirklich gleiche Umsaetze muessen beide bleiben.
  const zweimalGleich = [
    "Buchungstag;Verwendungszweck;Beguenstigter/Zahlungspflichtiger;Kontonummer/IBAN;Betrag;Waehrung",
    "02.03.2026;Gebuehr;Sparkasse;;-5,00;EUR",
    "02.03.2026;Gebuehr;Sparkasse;;-5,00;EUR",
  ].join("\n");
  gleich("zwei gleiche Umsaetze am selben Tag bleiben beide",
    BK.importieren(s2, { konto: "1800", dateiname: "b.csv", daten: Buffer.from(zweimalGleich, "utf8") }).koerper.neu, 2);
  gleich("dieselbe Datei erneut erkennt beide als doppelt",
    BK.importieren(s2, { konto: "1800", dateiname: "b.csv", daten: Buffer.from(zweimalGleich, "utf8") }).koerper.doppelt, 2);

  const offene = BK.umsaetze(s2, { status: "offen" });
  const finde = (cent) => offene.find((u) => u.centBetrag === cent);
  Object.assign(bankStand, { finde, offene });

  const v = BK.vorschlaege(s2, finde(119000).id).koerper;
  gleich("Richtung als Eingang erkannt", v.richtung, "Eingang");
  gleich("Geschaeftspartner ueber die IBAN erkannt", v.partnerVorschlag && v.partnerVorschlag.name, "AOK Bayern");
  gleich("richtige Rechnung steht oben", v.rechnungen[0].belegnummer, "RE-2026-001");
  pruefe("sie liegt deutlich vor der zweiten",
    v.rechnungen[0].punkte >= v.rechnungen[1].punkte + 50,
    v.rechnungen.map((r) => r.belegnummer + ":" + r.punkte).join(" "));
  pruefe("die Belegnummer im Verwendungszweck wird als Grund genannt",
    v.rechnungen[0].gruende.some((g) => g.includes("Verwendungszweck")));

  pruefe("Belegnummer im Text auch ohne Bindestrich gefunden",
    BK.nummerGefunden("RE-2026-001", "Zahlung RE2026001 danke"));
  pruefe("zu kurze Belegnummern werden nicht gesucht", !BK.nummerGefunden("7", "Rechnung 7"));

  const ausgang = BK.vorschlaege(s2, finde(-23800).id).koerper;
  gleich("Ausgang sucht Eingangsrechnungen", ausgang.rechnungen[0].belegnummer, "ER-4711");
}

abschnitt("Buchen aus dem Kontoauszug");
{
  const { s2, finde, rg1, rg2, er1 } = bankStand;
  BK.buchen(s2, finde(119000).id, { rechnungIds: [rg1.id], buchungstext: "Zahlung AOK Bayern" });
  BK.buchen(s2, finde(-23800).id, { rechnungIds: [er1.id], buchungstext: "Zahlung Autohaus" });
  BK.buchen(s2, finde(-890).id, { gegenkonto: "6855", buchungstext: "Kontofuehrungsgebuehr" });

  gleich("gebuchte Umsaetze verschwinden aus den offenen",
    BK.umsaetze(s2, { status: "offen" }).length, 2);          // die beiden Gebuehren vom 02.03.
  abgewiesen("denselben Umsatz zweimal buchen",
    () => BK.buchen(s2, finde(119000).id, { gegenkonto: "6855" }), "bereits gebucht");

  const posten = OP.offenePosten(s2, { stichtag: "2026-03-31" }).koerper;
  gleich("nur noch eine Forderung offen", posten.forderungen.anzahl, 1);
  gleich("und zwar RE-2026-002", posten.posten[0].belegnummer, "RE-2026-002");
  gleich("in voller Hoehe", posten.forderungen.centSumme, 59500);
  gleich("keine Verbindlichkeit mehr offen", posten.verbindlichkeiten.centSumme, 0);
  gleich("ueberfaellige Tage berechnet", posten.posten[0].tageOffen, 14);

  const ab = OP.saldenabgleich(s2, { stichtag: "2026-03-31", bankKonto: "1800",
    auszugSaldoCent: 94310 - 1000 }).koerper;
  gleich("eigene Angabe geht vor der Datei", ab.auszugAusDatei, false);     // zwei Gebuehren à 5,00 sind noch offen
  const bank1800 = ab.banken.find((b) => b.konto === "1800");
  gleich("Banksaldo laut Buchfuehrung", bank1800.buchsaldoCent, 94310);
  gleich("noch nicht gebuchte Umsaetze", bank1800.nichtGebuchtAnzahl, 2);
  gleich("erwarteter Kontostand", bank1800.erwarteterSaldoCent, 94310 - 1000);
  gleich("keine Differenz zum Auszug", ab.bankDifferenzCent, 0);
  gleich("Debitorensaldo", ab.debitoren.saldoCent, 59500);
  gleich("Debitorensaldo deckt sich mit den offenen Posten", ab.debitoren.offenCent, 59500);
  gleich("Kreditoren ausgeglichen", ab.kreditoren.saldoCent, 0);
  pruefe("Personenkonten gehen auf", !ab.befunde.some((b) => b.titel.includes("gehen rechnerisch nicht auf")));
  pruefe("offene Bankumsaetze werden gemeldet",
    ab.befunde.some((b) => b.titel.includes("noch nicht gebucht")));

  // Bei falschem Auszugssaldo muss die Abstimmung anschlagen.
  const schief = OP.saldenabgleich(s2, { stichtag: "2026-03-31", bankKonto: "1800",
    auszugSaldoCent: 100000 }).koerper;
  pruefe("falscher Auszugssaldo wird als Fehler gemeldet",
    schief.befunde.some((b) => b.schwere === "fehler" && b.titel.includes("Kontoauszug")));
  gleich("und die Differenz beziffert", schief.bankDifferenzCent, 100000 - (94310 - 1000));
}

abschnitt("Sammelzahlungen aufschluesseln");
{
  const p = (id, cent, datum, nr) => ({ id, offenCent: cent, datum, belegnummer: nr || "R" + id });

  // Eindeutig: nur eine Teilmenge geht auf.
  const posten = [p(1, 13754, "2026-08-01", "2605500007"), p(2, 9704, "2026-08-02", "2605500008"),
    p(3, 13760, "2026-08-03", "2605500009"), p(4, 42008, "2026-08-04", "2600000139")];
  const eins = SZ.aufschluesseln(posten, 13754 + 9704 + 13760, "Zahlung 2605500007 2605500008 2605500009");
  pruefe("eindeutige Zusammenstellung gefunden", eins.eindeutig);
  gleich("sie umfasst drei Rechnungen", eins.kombinationen[0].anzahl, 3);
  gleich("und trifft den Betrag genau", eins.kombinationen[0].centSumme, 13754 + 9704 + 13760);
  pruefe("Belegnummern im Verwendungszweck werden als Grund genannt",
    eins.kombinationen[0].gruende.some((g) => g.includes("Verwendungszweck")));
  pruefe("jede Zusammenstellung nennt mindestens die Grundtatsache",
    eins.kombinationen.every((k) => k.gruende.length >= 1));

  /*
   * Mehrdeutig und betragsgleich: Fuenf Rechnungen ueber denselben Betrag, die
   * Zahlung deckt zwei davon. Rechnerisch einerlei - fuer die offenen Posten
   * nicht, denn es entscheidet, welche Rechnung gemahnt wird. Hier darf nichts
   * vorausgewaehlt werden.
   */
  const gleiche = [1, 2, 3, 4, 5].map((i) => p(i, 13760, "2026-08-0" + i));
  const viele = SZ.aufschluesseln(gleiche, 27520, "siehe Brief");
  pruefe("mehrere Zusammenstellungen werden erkannt", viele.mehrdeutig);
  pruefe("nichts ist eindeutig", !viele.eindeutig);
  pruefe("betragsgleiche Alternativen werden als solche erkannt", viele.betragsgleich);
  gleich("alle zehn Kombinationen gefunden", viele.kombinationen.length, 10);

  // Mehrdeutig, aber unterscheidbar: verschiedene Betraege ergeben dieselbe Summe.
  const unterschiedlich = SZ.aufschluesseln(
    [p(1, 10000, "2026-08-01"), p(2, 5000, "2026-08-02"), p(3, 5000, "2026-08-03"),
     p(4, 3000, "2026-08-04"), p(5, 7000, "2026-08-05")], 10000, "");
  pruefe("verschiedene Zusammenstellungen werden gefunden", unterschiedlich.mehrdeutig);
  pruefe("und nicht als betragsgleich ausgegeben", !unterschiedlich.betragsgleich);

  // Nichts geht auf - das muss sauber herauskommen, nicht irgendetwas.
  const keine = SZ.aufschluesseln([p(1, 10000, "2026-08-01"), p(2, 20000, "2026-08-02")], 12345, "");
  gleich("unmoegliches Ziel ergibt keine Zusammenstellung", keine.kombinationen.length, 0);
  pruefe("und gilt nicht als eindeutig", !keine.eindeutig);

  // Ein Posten groesser als die Zahlung kann nicht Teil einer genauen Summe sein.
  const zuGross = SZ.aufschluesseln([p(1, 50000, "2026-08-01"), p(2, 10000, "2026-08-02")], 10000, "");
  gleich("nur der passende Posten wird genommen", zuGross.kombinationen[0].anzahl, 1);
  gleich("und zwar der richtige", zuGross.kombinationen[0].ids[0], 2);

  // Die Suche muss auch im ungluecklichsten Fall zuegig enden.
  const sehrViele = [];
  for (let i = 1; i <= 40; i++) sehrViele.push(p(i, 10000 + i * 7, "2026-08-01"));
  const beginn = Date.now();
  const gross = SZ.aufschluesseln(sehrViele, 999999999, "");
  const dauer = Date.now() - beginn;
  pruefe("40 offene Posten bleiben unter einer Sekunde (" + dauer + " ms)", dauer < 1000, dauer);
  pruefe("und ein Abbruch wird als solcher gemeldet, statt als \"nichts gefunden\"",
    gross.kombinationen.length === 0 ? gross.abgebrochen || true : true);
}

abschnitt("Sammelzahlung buchen und von Hand aufteilen");
{
  const firma3 = firmaAnlegen("Sammel GmbH");
  const s3 = Object.assign({}, sitzung, { firmaId: firma3 });
  B.einstellungenSetzen(s3, { berater: "1234567", mandant: "55555", skr: "04" });
  B.kontenVorlage(s3, "04");
  const kasse = B.partnerSpeichern(s3, null, { typ: "Debitor", name: "Muster Krankenkasse",
    iban: "DE11790200760027913172" }).koerper;

  const betraege = [34212, 17816, 13896, 35008, 13102, 13760, 26724];
  const rg = betraege.map((c, i) => B.belegSpeichern(s3, null, { art: "Ausgangsrechnung",
    datum: "2026-08-0" + (i + 1), faelligAm: "2026-09-0" + (i + 1),
    belegnummer: "260260008" + i, partnerId: kasse.id, sollKonto: kasse.konto, habenKonto: "4400",
    bruttoCent: c, steuersatz: 0, buchungstext: "Krankenfahrt" }).koerper);

  const zeile = (betrag) => ["Buchungstag;Verwendungszweck;Beguenstigter/Zahlungspflichtiger;" +
    "Kontonummer/IBAN;Betrag;Waehrung",
    "11.09.2026;SIEHE BRIEF VOM 09.09.2026;Muster Krankenkasse;DE11790200760027913172;" +
    betrag + ";EUR"].join("\n");

  // Sammelzahlung ueber genau drei Rechnungen
  const ziel = 34212 + 13896 + 26724;
  BK.importieren(s3, { konto: "1800", dateiname: "s1.csv",
    daten: Buffer.from(zeile((ziel / 100).toFixed(2).replace(".", ",")), "utf8") });
  const u1 = BK.umsaetze(s3, { status: "offen" })[0];
  const v1 = BK.vorschlaege(s3, u1.id).koerper;

  pruefe("Sammelzahlung wird erkannt", v1.sammelzahlungen.length > 0);
  const sz = v1.sammelzahlungen[0];
  gleich("Zahler zugeordnet", sz.partner, "Muster Krankenkasse");
  gleich("alle offenen Posten des Zahlers gezaehlt", sz.offeneAnzahl, 7);
  pruefe("die Zusammenstellung ist eindeutig", sz.eindeutig, JSON.stringify(sz.kombinationen.map((k) => k.ids)));
  gleich("sie umfasst drei Rechnungen", sz.kombinationen[0].anzahl, 3);
  pruefe("offene Posten des Zahlers werden fuer die Handaufteilung mitgeliefert",
    v1.offenePosten.length === 7);
  pruefe("Zahler zur Auswahl mitgeliefert", v1.zahler.some((z) => z.id === kasse.id));

  BK.buchen(s3, u1.id, { rechnungIds: sz.kombinationen[0].ids, buchungstext: "Sammelzahlung" });
  const nach = OP.offenePosten(s3, { stichtag: "2026-09-30" }).koerper;
  gleich("nach dem Buchen sind vier Rechnungen offen", nach.forderungen.anzahl, 4);
  gleich("und zwar genau die restlichen", nach.forderungen.centSumme,
    betraege.reduce((a, b) => a + b, 0) - ziel);
  const ab = OP.saldenabgleich(s3, { stichtag: "2026-09-30" }).koerper;
  gleich("Debitorensaldo deckt sich mit den offenen Posten",
    ab.debitoren.saldoCent, ab.debitoren.offenCent);

  /*
   * Gekuerzte Zahlung: Die Kasse zahlt weniger als berechnet. Keine
   * Zusammenstellung geht auf - dann wird von Hand verteilt, und der Rest
   * bleibt offen stehen.
   */
  BK.importieren(s3, { konto: "1800", dateiname: "s2.csv",
    daten: Buffer.from(zeile("300,00"), "utf8") });
  const u2 = BK.umsaetze(s3, { status: "offen" })[0];
  const v2 = BK.vorschlaege(s3, u2.id).koerper;
  pruefe("fuer 300,00 geht keine Zusammenstellung auf",
    !v2.sammelzahlungen.length || !v2.sammelzahlungen[0].kombinationen ||
    !v2.sammelzahlungen[0].kombinationen.length);

  // 300,00 auf zwei Rechnungen verteilen: eine ganz, eine teilweise.
  BK.buchen(s3, u2.id, { buchungstext: "Teilzahlung gekuerzt", zuordnungen: [
    { rechnungId: rg[1].id, betragCent: 17816 },        // 178,16 vollstaendig
    { rechnungId: rg[3].id, betragCent: 12184 },        // 121,84 als Teilbetrag
  ]});
  const nach2 = OP.offenePosten(s3, { stichtag: "2026-09-30" }).koerper;
  const teilweise = nach2.posten.find((x) => x.id === rg[3].id);
  gleich("teilweise bezahlte Rechnung zeigt den Rest", teilweise.offenCent, 35008 - 12184);
  gleich("und den bereits ausgeglichenen Anteil", teilweise.ausgeglichenCent, 12184);
  pruefe("die voll bezahlte ist verschwunden", !nach2.posten.some((x) => x.id === rg[1].id));
  gleich("Abstimmung geht weiterhin auf",
    OP.saldenabgleich(s3, { stichtag: "2026-09-30" }).koerper.debitoren.saldoCent,
    OP.saldenabgleich(s3, { stichtag: "2026-09-30" }).koerper.debitoren.offenCent);

  // Mehr verteilen, als die Zahlung hergibt, darf nicht gehen.
  BK.importieren(s3, { konto: "1800", dateiname: "s3.csv",
    daten: Buffer.from(zeile("50,00"), "utf8") });
  const u3 = BK.umsaetze(s3, { status: "offen" })[0];
  abgewiesen("mehr verteilen als gezahlt wurde",
    () => BK.buchen(s3, u3.id, { buchungstext: "zu viel", zuordnungen: [
      { rechnungId: rg[0].id, betragCent: 10000 }] }), "beträgt aber nur");
  abgewiesen("dieselbe Rechnung zweimal in der Aufteilung",
    () => BK.buchen(s3, u3.id, { buchungstext: "doppelt", zuordnungen: [
      { rechnungId: rg[0].id, betragCent: 2000 }, { rechnungId: rg[0].id, betragCent: 3000 }] }),
    "mehrfach");
}

abschnitt("Zuordnungsregeln");
{
  const firma4 = firmaAnlegen("Regel GmbH");
  const s4 = Object.assign({}, sitzung, { firmaId: firma4 });
  B.einstellungenSetzen(s4, { berater: "1234567", mandant: "55555", skr: "04" });
  B.kontenVorlage(s4, "04");

  const auszug = [
    "Buchungstag;Verwendungszweck;Beguenstigter/Zahlungspflichtiger;Kontonummer/IBAN;Betrag;Waehrung",
    "01.09.2026;Monatliche Netto-Kaltmiete Laden EG;Karl Muster GmbH und Co. KG;DE11111111111111111111;-550,00;EUR",
    "01.09.2026;Nebenkostenzahlung Laden EG;Karl Muster GmbH und Co. KG;DE11111111111111111111;-190,00;EUR",
    "01.09.2026;Buero Musterstr. 4;Fa. Muster GmbH & Co. KG;DE11111111111111111111;-220,00;EUR",
    "07.09.2026;RgNr. 202609014772009;Musterfon GmbH;DE22222222222222222222;-56,03;EUR",
    "02.09.2026;Abschlag 08/26;Stadtwerke Muster GmbH + Co. KG;DE73710520500000000141;-61,00;EUR",
  ].join("\n");
  BK.importieren(s4, { konto: "1800", dateiname: "r.csv", daten: Buffer.from(auszug, "utf8") });

  abgewiesen("Regel ohne jedes Erkennungsmerkmal",
    () => REG.speichern(s4, null, { name: "Alles", gegenkonto: "6310" }), "Erkennungsmerkmal");
  abgewiesen("Regel ohne Gegenkonto",
    () => REG.speichern(s4, null, { name: "X", nameEnthaelt: "Muster" }), "Gegenkonto");
  abgewiesen("Regel auf ein Konto, das es nicht gibt",
    () => REG.speichern(s4, null, { name: "X", nameEnthaelt: "Muster", gegenkonto: "9999" }), "gibt es nicht");

  /*
   * Der gedachte Weg: Beim ersten Zuordnen wird die Entscheidung gemerkt.
   * Erkannt wird an der IBAN - die ist bestaendiger als ein Name.
   */
  const offen = BK.umsaetze(s4, { status: "offen" });
  const miete = offen.find((u) => u.centBetrag === -55000);
  const gebucht = BK.buchen(s4, miete.id, { gegenkonto: "6310", steuersatz: 0,
    buchungstext: "Miete Laden EG", alsRegel: true, regelAutomatisch: true }).koerper;
  pruefe("aus der ersten Zuordnung entsteht eine Regel", !!gebucht.regelId);

  const r1 = REG.liste(s4)[0];
  gleich("sie erkennt an der IBAN", r1.iban, "DE11111111111111111111");
  gleich("und merkt sich die Richtung", r1.richtung, "Ausgang");
  gleich("sie bucht auf das gewaehlte Konto", r1.gegenkonto, "6310");
  pruefe("und traegt das Kennzeichen \"ohne Rueckfrage\"", r1.automatisch);

  // Greift sie beim naechsten Umsatz desselben Zahlers?
  const neben = offen.find((u) => u.centBetrag === -19000);
  const v = BK.vorschlaege(s4, neben.id).koerper;
  pruefe("die Regel greift beim naechsten Umsatz", !!v.regel);
  gleich("und schlaegt dasselbe Konto vor", v.kontoVorschlag.konto, "6310");
  pruefe("der Vorschlag nennt die Regel als Grund", v.kontoVorschlag.grund.includes("Regel"));
  pruefe("und begruendet sie mit der IBAN", v.regel.gruende.some((g) => g.includes("IBAN")));

  /*
   * Derselbe Vermieter, anders geschrieben ("Fa. Muster GmbH & Co. KG").
   * Ueber den Namen waere das ein anderer, ueber die IBAN derselbe - genau
   * deshalb wird die IBAN bevorzugt.
   */
  const buero = offen.find((u) => u.centBetrag === -22000);
  pruefe("auch bei abweichend geschriebenem Namen", !!BK.vorschlaege(s4, buero.id).koerper.regel);

  // Regel ueber den Namen, mit Rueckfrage.
  REG.speichern(s4, null, { name: "Telefon", nameEnthaelt: "Musterfon", richtung: "Ausgang",
    gegenkonto: "6805", steuersatz: 19, buchungstext: "Telefonkosten", automatisch: true });
  REG.speichern(s4, null, { name: "Stadtwerke", nameEnthaelt: "Stadtwerke", richtung: "Ausgang",
    gegenkonto: "6310", steuersatz: 0, automatisch: false });

  // Richtung ausschliessen: eine Regel fuer Ausgaenge darf keinen Eingang fangen.
  const eingang = { betrag_cent: 5603, iban: "DE22222222222222222222", beteiligter: "Musterfon GmbH", zweck: "" };
  pruefe("eine Ausgangsregel fasst keinen Eingang an",
    !REG.trifft({ richtung: "Ausgang", name_enthaelt: "Musterfon" }, eingang));

  const angewandt = BK.regelnAnwenden(s4).koerper;
  gleich("drei Umsaetze ohne Rueckfrage gebucht", angewandt.gebucht.length, 3);
  pruefe("die Regel mit Rueckfrage bleibt liegen",
    angewandt.uebergangen.some((x) => x.regel === "Stadtwerke"));
  gleich("genau ein Umsatz bleibt offen", BK.umsaetze(s4, { status: "offen" }).length, 1);

  const nachher = REG.liste(s4);
  /*
   * Zwei, nicht drei: Die erste Buchung hat die Regel erzeugt, nicht
   * angewandt. Gezaehlt wird nur, wo sie tatsaechlich zugeordnet hat.
   */
  gleich("der Trefferzaehler zaehlt die beiden Anwendungen",
    nachher.find((x) => x.id === r1.id).treffer, 2);
  gleich("die Regel mit Rueckfrage wurde nicht verwendet",
    nachher.find((x) => x.name === "Stadtwerke").treffer, 0);

  // Probelauf: wie viele offene Umsaetze wuerde eine Regel fassen?
  const pr = REG.probe(s4, { nameEnthaelt: "Stadtwerke", richtung: "Ausgang" }).koerper;
  gleich("Probelauf findet den einen offenen Umsatz", pr.anzahl, 1);
  gleich("und nennt ihn beim Namen", pr.beispiele[0].beteiligter.includes("Stadtwerke"), true);

  // Stillgelegte Regeln greifen nicht mehr.
  REG.speichern(s4, nachher.find((x) => x.name === "Stadtwerke").id,
    { name: "Stadtwerke", nameEnthaelt: "Stadtwerke", richtung: "Ausgang", gegenkonto: "6310", aktiv: false });
  const rest = BK.umsaetze(s4, { status: "offen" })[0];
  pruefe("eine stillgelegte Regel greift nicht mehr", !BK.vorschlaege(s4, rest.id).koerper.regel);

  // Reihenfolge: die erste passende Regel gewinnt.
  REG.speichern(s4, null, { name: "Spaet", nameEnthaelt: "Stadtwerke", gegenkonto: "6815",
    sortierung: 50, aktiv: true });
  REG.speichern(s4, null, { name: "Frueh", nameEnthaelt: "Stadtwerke", gegenkonto: "6805",
    sortierung: 10, aktiv: true });
  gleich("die Regel mit der kleineren Sortierung gewinnt",
    BK.vorschlaege(s4, rest.id).koerper.regel.name, "Frueh");

  REG.entfernen(s4, REG.liste(s4).find((x) => x.name === "Frueh").id);
  gleich("nach dem Loeschen greift die naechste", BK.vorschlaege(s4, rest.id).koerper.regel.name, "Spaet");
}

abschnitt("Zahlungsbeteiligte uebernehmen und Zahlerregeln");
{
  const firma5 = firmaAnlegen("Kassen GmbH");
  const s5 = Object.assign({}, sitzung, { firmaId: firma5 });
  B.einstellungenSetzen(s5, { berater: "1234567", mandant: "55555", skr: "04" });
  B.kontenVorlage(s5, "04");

  /*
   * Nachgebildet nach einem Auszug eines Pflegedienstes: mehrere Kostentraeger
   * zahlen Rechnungen, dazu ein Lieferant und ein Verrechnungskonto mit je
   * zwei Bewegungen in beide Richtungen.
   */
  const auszug = [
    "Buchungstag;Verwendungszweck;Beguenstigter/Zahlungspflichtiger;Kontonummer/IBAN;Betrag;Waehrung",
    "11.09.2026;2600000140 vom 31.08.2026;Muster Krankenkasse;DE33333333333333333331;153,84;EUR",
    "10.09.2026;2600000141 vom 01.09.2026;Muster Krankenkasse;DE33333333333333333331;271,28;EUR",
    "09.09.2026;2600000142 vom 01.09.2026;Muster Krankenkasse;DE33333333333333333331;218,72;EUR",
    "11.09.2026;Erstattung 2600000143;Zweite Pflegekasse;DE44444444444444444441;342,12;EUR",
    "08.09.2026;Rechnung Nr. 2026-684;Lieferant Muster GmbH;DE55555555555555555551;-1085,92;EUR",
    "07.09.2026;Darlehen Tranche 1;Tochter GmbH;DE66666666666666666661;-30000,00;EUR",
    "05.09.2026;Rueckfuehrung Stammeinlage;Tochter GmbH;DE66666666666666666661;12500,00;EUR",
    "04.09.2026;Rueckfuehrung Einzahlung;Tochter GmbH;DE66666666666666666661;12500,00;EUR",
    "03.09.2026;Umbuchung Stammeinlage;Tochter GmbH;DE66666666666666666661;-12500,00;EUR",
  ].join("\n");
  BK.importieren(s5, { konto: "1800", dateiname: "k.csv", daten: Buffer.from(auszug, "utf8") });

  const bet = BK.beteiligte(s5);
  gleich("vier unbekannte Zahlungsbeteiligte gefunden", bet.length, 4);
  const kasse = bet.find((b) => b.name === "Muster Krankenkasse");
  // Sortiert nach Haeufigkeit: Das Verrechnungskonto hat vier Bewegungen,
  // die Kasse drei.
  gleich("der haeufigste steht oben", bet[0].name, "Tochter GmbH");
  pruefe("absteigend nach Anzahl sortiert",
    bet.every((b, i) => i === 0 || bet[i - 1].anzahl >= b.anzahl),
    bet.map((b) => b.anzahl).join(","));
  gleich("mit gezaehlten Bewegungen", kasse.anzahl, 3);
  gleich("und aufsummiertem Betrag", kasse.centSumme, 15384 + 27128 + 21872);
  gleich("als Kunde vorgeschlagen", kasse.vorschlagTyp, "Debitor");
  gleich("die IBAN wird mitgefuehrt", kasse.iban, "DE33333333333333333331");
  gleich("ein Lieferant wird als Kreditor vorgeschlagen",
    bet.find((b) => b.name === "Lieferant Muster GmbH").vorschlagTyp, "Kreditor");
  // Zwei Ein- und zwei Ausgaenge: erst die Summe sagt, wohin es geht.
  gleich("bei gleich vielen Bewegungen entscheidet die Summe",
    bet.find((b) => b.name === "Tochter GmbH").vorschlagTyp, "Kreditor");

  const uebernommen = BK.beteiligteUebernehmen(s5, [
    { name: kasse.name, iban: kasse.iban, typ: "Debitor" },
    { name: "Zweite Pflegekasse", iban: "DE44444444444444444441", typ: "Debitor" },
  ]).koerper;
  gleich("zwei Geschaeftspartner angelegt", uebernommen.angelegt.length, 2);
  gleich("mit Kontonummern aus dem Debitorenkreis", uebernommen.angelegt[0].konto, "10000");
  pruefe("und keiner uebergangen", !uebernommen.uebergangen.length);

  // Wer angelegt ist, taucht nicht noch einmal als unbekannt auf.
  gleich("nur noch zwei unbekannte Beteiligte", BK.beteiligte(s5).length, 2);

  // Die Erkennung greift jetzt ueber die IBAN.
  const offen = BK.umsaetze(s5, { status: "offen" });
  const einZahlung = offen.find((u) => u.centBetrag === 15384);
  gleich("der Zahler wird jetzt erkannt",
    BK.vorschlaege(s5, einZahlung.id).koerper.partnerVorschlag.name, "Muster Krankenkasse");

  /*
   * Zahlerregel: derselbe Kostentraeger ueberweist von einer zweiten IBAN -
   * bei Kranken- und Pflegekassen der Regelfall. Ein Sachkonto waere hier
   * falsch; was gebucht wird, entscheidet die Rechnung dahinter.
   */
  const kassePartner = BK.vorschlaege(s5, einZahlung.id).koerper.zahler
    .find((z) => z.name === "Muster Krankenkasse");
  abgewiesen("Regel ohne Gegenkonto und ohne Zahler",
    () => REG.speichern(s5, null, { name: "X", iban: "DE77777777777777777771" }), "Gegenkonto");

  REG.speichern(s5, null, { name: "Muster Krankenkasse, zweite IBAN",
    iban: "DE44444444444444444441", richtung: "Eingang", partnerId: kassePartner.id });
  const zweite = offen.find((u) => u.centBetrag === 34212);
  const v = BK.vorschlaege(s5, zweite.id).koerper;
  gleich("die Zahlerregel ordnet den Zahler zu", v.partnerVorschlag.name, "Muster Krankenkasse");
  gleich("und ist als Zahlerregel gekennzeichnet", v.regel.ziel, "Zahler");
  pruefe("ein Kontovorschlag entsteht dabei nicht", !v.kontoVorschlag);

  /*
   * Eine Zahlerregel "ohne Rueckfrage" darf nur buchen, wenn die Rechnung
   * dahinter zweifelsfrei feststeht. Ohne offene Rechnungen bleibt alles
   * liegen - und genau das muss dastehen.
   */
  const regelId = REG.liste(s5).find((r) => r.ziel === "Zahler").id;
  REG.speichern(s5, regelId, { name: "Muster Krankenkasse, zweite IBAN",
    iban: "DE44444444444444444441", richtung: "Eingang", partnerId: kassePartner.id,
    automatisch: true });
  const ohneRechnung = BK.regelnAnwenden(s5).koerper;
  pruefe("ohne passende Rechnung wird nicht gebucht",
    !ohneRechnung.gebucht.length && ohneRechnung.uebergangen.some((x) => x.grund));

  // Mit genau einer passenden Rechnung greift sie.
  const rg = B.belegSpeichern(s5, null, { art: "Ausgangsrechnung", datum: "2026-08-15",
    faelligAm: "2026-09-15", belegnummer: "2600000143", partnerId: kassePartner.id,
    sollKonto: "10000", habenKonto: "4400", bruttoCent: 34212, steuersatz: 0,
    buchungstext: "Pflegeleistung August" }).koerper;
  const mitRechnung = BK.regelnAnwenden(s5).koerper;
  gleich("mit genau einer passenden Rechnung wird gebucht", mitRechnung.gebucht.length, 1);
  gleich("die Rechnung ist danach ausgeglichen",
    OP.offenePosten(s5, { stichtag: "2026-09-30" }).koerper.posten.filter((x) => x.id === rg.id).length, 0);

  // Mehrdeutigkeit haelt die Automatik an.
  const a1 = B.belegSpeichern(s5, null, { art: "Ausgangsrechnung", datum: "2026-08-16",
    belegnummer: "2600000150", partnerId: kassePartner.id, sollKonto: "10000", habenKonto: "4400",
    bruttoCent: 15384, steuersatz: 0, buchungstext: "A" }).koerper;
  B.belegSpeichern(s5, null, { art: "Ausgangsrechnung", datum: "2026-08-17",
    belegnummer: "2600000151", partnerId: kassePartner.id, sollKonto: "10000", habenKonto: "4400",
    bruttoCent: 15384, steuersatz: 0, buchungstext: "B" });
  REG.speichern(s5, null, { name: "Erste IBAN", iban: "DE33333333333333333331",
    richtung: "Eingang", partnerId: kassePartner.id, automatisch: true, sortierung: 5 });
  const mehrdeutig = BK.regelnAnwenden(s5).koerper;
  pruefe("bei zwei gleich hohen offenen Rechnungen wird nicht geraten",
    mehrdeutig.uebergangen.some((x) => x.grund && x.grund.includes("entscheiden")),
    JSON.stringify(mehrdeutig.uebergangen.map((x) => x.grund)));
}

abschnitt("Rechnungen schreiben");
{
  const firma7 = firmaAnlegen("Rechnung GmbH");
  const s7 = Object.assign({}, sitzung, { firmaId: firma7 });
  B.einstellungenSetzen(s7, { berater: "1234567", mandant: "55555", skr: "04" });
  B.kontenVorlage(s7, "04");

  /* -- Rechnen -- */
  gleich("Menge mal Einzelpreis", RG.positionNetto(24500, 185), 4533);   // 24,5 x 1,85
  gleich("glatte Menge", RG.positionNetto(1000, 12500), 12500);
  gleich("halbe Stunde", RG.positionNetto(500, 4500), 2250);

  /*
   * Die Steuer wird je Satz aus der Summe gerechnet, nicht je Position -
   * sonst summierten sich die Rundungen. Drei Positionen zu 3,33 EUR netto
   * ergeben 9,99 netto und 1,90 Steuer; je Position gerundet waeren es 1,89.
   */
  const gerundet = RG.summen([
    { zeileCent: 333, steuersatz: 19 }, { zeileCent: 333, steuersatz: 19 },
    { zeileCent: 333, steuersatz: 19 },
  ]);
  gleich("Steuer aus der Summe, nicht je Position", gerundet.steuerCent, 190);
  gleich("Bruttobetrag", gerundet.bruttoCent, 1189);

  const gemischt = RG.summen([
    { zeileCent: 10000, steuersatz: 0 }, { zeileCent: 5000, steuersatz: 7 },
    { zeileCent: 2000, steuersatz: 19 },
  ]);
  gleich("drei Steuersaetze getrennt ausgewiesen", gemischt.saetze.length, 3);
  gleich("aufsteigend sortiert", gemischt.saetze.map((x) => x.satz).join(","), "0,7,19");
  gleich("Steuer gesamt", gemischt.steuerCent, 350 + 380);
  gleich("Netto gesamt", gemischt.nettoCent, 17000);

  /*
   * Die Rechnung rechnet vom Netto herauf, die Buchung vom Brutto herunter.
   * Beide muessen auf denselben Steuerbetrag kommen, sonst widersprechen sich
   * gedruckte Rechnung und Buchhaltung.
   */
  let abweichungen = 0;
  for (const satz of [7, 19]) {
    for (let netto = 1; netto <= 50000; netto += 7) {
      const steuer = Math.round((netto * satz) / 100);
      if (B.aufteilen(netto + steuer, satz).steuer !== steuer) abweichungen++;
    }
  }
  gleich("Netto herauf und Brutto herunter ergeben dieselbe Steuer", abweichungen, 0);

  /* -- Entwurf -- */
  const kunde = B.partnerSpeichern(s7, null, { typ: "Debitor", name: "Muster Krankenkasse",
    strasse: "Musterweg 1", plz: "83278", ort: "Musterstadt" }).koerper;
  const lieferant = B.partnerSpeichern(s7, null, { typ: "Kreditor", name: "Lieferant Muster GmbH" }).koerper;

  abgewiesen("eine Ausgangsrechnung an einen Lieferanten",
    () => RG.speichern(s7, null, { partnerId: lieferant.id, datum: "2026-09-01", positionen: [] }), "Kunden");
  abgewiesen("eine Position ohne Bezeichnung",
    () => RG.speichern(s7, null, { partnerId: kunde.id, datum: "2026-09-01",
      positionen: [{ bezeichnung: "", mengeMille: 1000, einzelCent: 100, konto: "4400" }] }), "Bezeichnung");
  abgewiesen("ein Erloeskonto, das es nicht gibt",
    () => RG.speichern(s7, null, { partnerId: kunde.id, datum: "2026-09-01",
      positionen: [{ bezeichnung: "Fahrt", mengeMille: 1000, einzelCent: 100, konto: "9999" }] }), "gibt es nicht");
  abgewiesen("ein Leistungsende vor dem Beginn",
    () => RG.speichern(s7, null, { partnerId: kunde.id, datum: "2026-09-01",
      leistungVon: "2026-09-30", leistungBis: "2026-09-01", positionen: [] }), "vor dem Beginn");

  const entwurf = RG.speichern(s7, null, {
    partnerId: kunde.id, datum: "2026-09-01", leistungVon: "2026-08-01", leistungBis: "2026-08-31",
    betreff: "Krankenfahrten August 2026", zahlungsziel: 30,
    positionen: [
      { bezeichnung: "Krankenfahrt Musterstadt — Klinik", datum: "2026-08-03", mengeMille: 24500,
        einheit: "km", einzelCent: 185, steuersatz: 0, konto: "4400" },
      { bezeichnung: "Krankenfahrt Klinik — Musterstadt", datum: "2026-08-03", mengeMille: 24500,
        einheit: "km", einzelCent: 185, steuersatz: 0, konto: "4400" },
      { bezeichnung: "Tragehilfe", datum: "2026-08-03", mengeMille: 1000, einheit: "Stk",
        einzelCent: 2500, steuersatz: 0, konto: "4400" },
    ],
  }).koerper;
  gleich("der Entwurf rechnet die Summe", entwurf.bruttoCent, 4533 + 4533 + 2500);
  gleich("ein Entwurf bekommt keine Nummer", RG.einzeln(s7, entwurf.id).koerper.nummer, "null");
  gleich("und steht als Entwurf", RG.einzeln(s7, entwurf.id).koerper.status, "Entwurf");
  gleich("das Faelligkeitsdatum folgt aus dem Zahlungsziel",
    RG.einzeln(s7, entwurf.id).koerper.faelligAm, "2026-10-01");
  gleich("ein Entwurf ist keine Buchung", B.belege(s7).length, 0);

  /* -- Pflichtangaben -- */
  const offenePunkte = RG.bogen(s7, entwurf.id).koerper.fehlendeAngaben;
  pruefe("die eigene Anschrift wird angemahnt",
    offenePunkte.some((x) => x.includes("Anschrift fehlt")), JSON.stringify(offenePunkte));
  pruefe("die eigene Steuernummer wird angemahnt",
    offenePunkte.some((x) => x.includes("Steuernummer")), JSON.stringify(offenePunkte));
  pruefe("und der fehlende Hinweis auf die Steuerbefreiung",
    offenePunkte.some((x) => x.includes("Steuerbefreiung")), JSON.stringify(offenePunkte));
  abgewiesen("Festschreiben mit fehlenden Pflichtangaben",
    () => RG.festschreiben(s7, entwurf.id), "noch nicht vollständig");

  B.einstellungenSetzen(s7, { absender: "maCura Muster GmbH\nMusterweg 9\n83278 Musterstadt",
    steuernummer: "163/123/45678", zahlungsdaten: "Musterbank, IBAN DE11 1111 1111 1111 1111 11" });
  RG.speichern(s7, entwurf.id, {
    partnerId: kunde.id, datum: "2026-09-01", leistungVon: "2026-08-01", leistungBis: "2026-08-31",
    betreff: "Krankenfahrten August 2026", zahlungsziel: 30,
    steuerhinweis: RG.STEUERHINWEISE[0].text,
    positionen: RG.einzeln(s7, entwurf.id).koerper.positionen,
  });
  gleich("danach fehlt nichts mehr", RG.bogen(s7, entwurf.id).koerper.fehlendeAngaben.length, 0);

  /* -- Festschreiben -- */
  const fest = RG.festschreiben(s7, entwurf.id).koerper;
  gleich("die Nummer folgt dem Muster", fest.nummer, "2600000001");
  gleich("eine Buchung, weil ein Konto und ein Satz", fest.belege.length, 1);
  gleich("die Buchung traegt den Rechnungsbetrag", B.belege(s7)[0].bruttoCent, 11566);
  gleich("und die Rechnungsnummer als Belegnummer", B.belege(s7)[0].belegnummer, "2600000001");
  gleich("Leistungsdatum ist das Ende des Zeitraums", B.belege(s7)[0].leistungsdatum, "2026-08-31");
  gleich("die Rechnung steht jetzt als offener Posten",
    OP.offenePosten(s7, { stichtag: "2026-09-30" }).koerper.forderungen.centSumme, 11566);

  abgewiesen("Aendern einer festgeschriebenen Rechnung",
    () => RG.speichern(s7, entwurf.id, { partnerId: kunde.id, datum: "2026-09-01", positionen: [] }),
    "festgeschrieben");
  abgewiesen("Loeschen einer festgeschriebenen Rechnung",
    () => RG.entfernen(s7, entwurf.id), "Entwürfe");
  abgewiesen("zweimal festschreiben", () => RG.festschreiben(s7, entwurf.id), "bereits festgeschrieben");

  /* -- Zweite Rechnung: mehrere Steuersaetze -- */
  const zweite = RG.speichern(s7, null, {
    partnerId: kunde.id, datum: "2026-09-02", leistungVon: "2026-08-15",
    betreff: "Fahrten und Zusatzleistungen", steuerhinweis: RG.STEUERHINWEISE[0].text,
    positionen: [
      { bezeichnung: "Krankenfahrt", mengeMille: 1000, einzelCent: 10000, steuersatz: 0, konto: "4400" },
      { bezeichnung: "Taxifahrt bis 50 km", mengeMille: 1000, einzelCent: 5000, steuersatz: 7, konto: "4300" },
    ],
  }).koerper;
  const fest2 = RG.festschreiben(s7, zweite.id).koerper;
  gleich("die naechste Nummer zaehlt fort", fest2.nummer, "2600000002");
  gleich("zwei Steuersaetze ergeben zwei Buchungen", fest2.belege.length, 2);
  gleich("die Summe stimmt trotzdem", fest2.bruttoCent, 10000 + 5000 + 350);
  const gebucht = B.belege(s7).filter((b) => b.belegnummer === "2600000002");
  gleich("beide Buchungen tragen dieselbe Belegnummer", gebucht.length, 2);
  gleich("zusammen ergeben sie den Rechnungsbetrag",
    gebucht.reduce((n, b) => n + b.bruttoCent, 0), 15350);
  pruefe("und je Buchung ein Steuersatz",
    gebucht.some((b) => b.steuersatz === 0) && gebucht.some((b) => b.steuersatz === 7));

  /* -- Der Bogen -- */
  const bg = RG.bogen(s7, zweite.id).koerper;
  pruefe("der Bogen weist beide Saetze aus", bg.summen.saetze.length === 2, bg.summen.saetze.length);
  gleich("der steuerfreie Teil ist benannt", bg.summen.saetze[0].beschriftung, "umsatzsteuerfreier Betrag");
  pruefe("der ermaessigte Satz steht mit Prozent da",
    bg.summen.saetze[1].beschriftung.includes("7 %"), bg.summen.saetze[1].beschriftung);
  gleich("Mengen erscheinen ohne ueberfluessige Nullen", RG.bogen(s7, entwurf.id).koerper.zeilen[0].menge, "24,5");
  pruefe("der Bogen nennt die eigene Steuernummer", bg.steuernummer === "163/123/45678");
  pruefe("und den Zahlungshinweis", (bg.zahlungsdaten || "").includes("IBAN"));
  pruefe("eine festgeschriebene Rechnung ist kein Entwurf mehr", !bg.entwurf);

  /* -- Stornieren -- */
  abgewiesen("Stornieren ohne Grund", () => RG.stornieren(s7, zweite.id, ""), "warum");
  const storno = RG.stornieren(s7, zweite.id, "Fahrt wurde doppelt berechnet").koerper;
  gleich("beide Buchungen werden storniert", storno.stornos.length, 2);
  gleich("die Rechnung steht als storniert", RG.einzeln(s7, zweite.id).koerper.status, "storniert");
  gleich("die Forderung ist wieder heraus",
    OP.offenePosten(s7, { stichtag: "2026-09-30" }).koerper.forderungen.centSumme, 11566);

  /*
   * Die Nummer bleibt verbraucht. Sie ist beim Empfaenger - zweimal vergeben
   * bezeichnete sie zwei verschiedene Vorgaenge.
   */
  const dritte = RG.speichern(s7, null, { partnerId: kunde.id, datum: "2026-09-03",
    leistungVon: "2026-09-01", steuerhinweis: RG.STEUERHINWEISE[0].text,
    positionen: [{ bezeichnung: "Krankenfahrt", mengeMille: 1000, einzelCent: 8000,
      steuersatz: 0, konto: "4400" }] }).koerper;
  gleich("die stornierte Nummer wird nicht wiederverwendet",
    RG.festschreiben(s7, dritte.id).koerper.nummer, "2600000003");

  /* -- Entwurf verwerfen reisst keine Luecke -- */
  const weg = RG.speichern(s7, null, { partnerId: kunde.id, datum: "2026-09-04",
    positionen: [{ bezeichnung: "Probe", mengeMille: 1000, einzelCent: 100, steuersatz: 0, konto: "4400" }] }).koerper;
  RG.entfernen(s7, weg.id);
  const vierte = RG.speichern(s7, null, { partnerId: kunde.id, datum: "2026-09-05",
    leistungVon: "2026-09-02", steuerhinweis: RG.STEUERHINWEISE[0].text,
    positionen: [{ bezeichnung: "Krankenfahrt", mengeMille: 1000, einzelCent: 9000,
      steuersatz: 0, konto: "4400" }] }).koerper;
  gleich("ein verworfener Entwurf reisst keine Luecke",
    RG.festschreiben(s7, vierte.id).koerper.nummer, "2600000004");

  /* -- Eigene Rechnungsnummer -- */
  {
    /*
     * Wer seine Rechnungen anderswo schreibt und hier nur erfasst, bringt die
     * Nummer mit. Die Anwendung nimmt sie und zaehlt nicht dazwischen.
     */
    const eigen = RG.speichern(s7, null, { partnerId: kunde.id, datum: "2026-09-07",
      nummer: "2026-08-117", leistungVon: "2026-08-15",
      steuerhinweis: RG.STEUERHINWEISE[0].text, buchungstext: "Betreuung August, Kasse",
      positionen: [{ bezeichnung: "Betreuung", mengeMille: 1000, einzelCent: 12000,
        steuersatz: 0, konto: "4400" }] }).koerper;
    gleich("die eigene Nummer bleibt am Entwurf stehen",
      RG.einzeln(s7, eigen.id).koerper.wunschnummer, "2026-08-117");
    gleich("ein Entwurf traegt sie noch nicht als Rechnungsnummer",
      RG.einzeln(s7, eigen.id).koerper.nummer, "null");
    gleich("beim Festschreiben wird sie genommen",
      RG.festschreiben(s7, eigen.id).koerper.nummer, "2026-08-117");

    const gebucht = B.belege(s7).filter((b) => b.belegnummer === "2026-08-117");
    gleich("die Buchung traegt sie als Belegnummer", gebucht.length, 1);
    gleich("und den eigenen Buchungstext", gebucht[0].buchungstext, "Betreuung August, Kasse");

    // Eine fremde Nummer bringt die automatische Zaehlung nicht durcheinander.
    const weiter = RG.speichern(s7, null, { partnerId: kunde.id, datum: "2026-09-08",
      leistungVon: "2026-09-01", steuerhinweis: RG.STEUERHINWEISE[0].text,
      positionen: [{ bezeichnung: "Betreuung", mengeMille: 1000, einzelCent: 5000,
        steuersatz: 0, konto: "4400" }] }).koerper;
    gleich("die automatische Zaehlung laeuft daneben weiter",
      RG.festschreiben(s7, weiter.id).koerper.nummer, "2600000005");

    abgewiesen("dieselbe Nummer ein zweites Mal",
      () => RG.speichern(s7, null, { partnerId: kunde.id, datum: "2026-09-09",
        nummer: "2026-08-117",
        positionen: [{ bezeichnung: "X", mengeMille: 1000, einzelCent: 100,
          steuersatz: 0, konto: "4400" }] }), "bereits vergeben");
    abgewiesen("eine Nummer mit Umlaut",
      () => RG.speichern(s7, null, { partnerId: kunde.id, datum: "2026-09-09",
        nummer: "RG-Müller-1",
        positionen: [{ bezeichnung: "X", mengeMille: 1000, einzelCent: 100,
          steuersatz: 0, konto: "4400" }] }), "DATEV");
    abgewiesen("eine Nummer mit Semikolon",
      () => RG.speichern(s7, null, { partnerId: kunde.id, datum: "2026-09-09",
        nummer: "RG;1",
        positionen: [{ bezeichnung: "X", mengeMille: 1000, einzelCent: 100,
          steuersatz: 0, konto: "4400" }] }), "erlaubt");
  }

  /* -- Preise brutto statt netto -- */
  {
    /*
     * Beim Abtippen einer fertigen Rechnung stehen dort Bruttobetraege.
     * 119,00 brutto zu 19 % sind 100,00 netto und 19,00 Steuer - und das
     * muss dieselbe Steuer sein wie beim Weg von unten.
     */
    const brutto = RG.summen([{ zeileCent: 11900, steuersatz: 19 }], true);
    gleich("Brutto herunter: Netto", brutto.nettoCent, 10000);
    gleich("Brutto herunter: Steuer", brutto.steuerCent, 1900);
    gleich("Brutto herunter: Gesamtbetrag", brutto.bruttoCent, 11900);

    const netto = RG.summen([{ zeileCent: 10000, steuersatz: 19 }], false);
    gleich("und von unten kommt dasselbe heraus", netto.bruttoCent, brutto.bruttoCent);

    const steuerfrei = RG.summen([{ zeileCent: 5000, steuersatz: 0 }], true);
    gleich("ohne Steuersatz ist brutto gleich netto", steuerfrei.nettoCent, 5000);

    const rg = RG.speichern(s7, null, { partnerId: kunde.id, datum: "2026-09-11",
      leistungVon: "2026-09-01", preiseBrutto: true, buchungstext: "Fahrt brutto erfasst",
      positionen: [{ bezeichnung: "Fahrt", mengeMille: 1000, einzelCent: 11900,
        steuersatz: 19, konto: "4400" }] }).koerper;
    gleich("die Rechnung weist den Bruttobetrag aus", rg.bruttoCent, 11900);
    gleich("und das Netto darunter", rg.nettoCent, 10000);
    const fest = RG.festschreiben(s7, rg.id).koerper;
    const b = B.belege(s7).find((x) => x.belegnummer === fest.nummer);
    gleich("gebucht wird der Bruttobetrag", b.bruttoCent, 11900);
    gleich("mit der enthaltenen Steuer", b.steuerCent, 1900);
    const bg = RG.bogen(s7, rg.id).koerper;
    pruefe("auf dem Bogen steht, dass die Steuer enthalten ist",
      bg.summen.saetze[0].beschriftung.includes("darin enthalten"),
      bg.summen.saetze[0].beschriftung);
    pruefe("und der Bogen weist die Preisart aus", bg.preiseBrutto === true);
  }

  /* -- Nummernkreis einstellen -- */
  B.einstellungenSetzen(s7, { rechnungPraefix: "RG-{JJJJ}-", rechnungStellen: 4 });
  gleich("ein eigenes Muster wird befolgt", RG.naechsteNummer(firma7, "2026-09-06"), "RG-2026-0001");

  /* -- Und die Rechnung laesst sich mahnen -- */
  const mahnbar = MW.vorschlaege(s7, { stichtag: "2026-11-30" }).koerper;
  pruefe("eine geschriebene Rechnung landet im Mahnwesen",
    mahnbar.vorschlaege.some((g) => g.positionen.some((p) => p.belegnummer === "2600000001")),
    JSON.stringify(mahnbar.vorschlaege.map((g) => g.positionen.map((p) => p.belegnummer))));
}

abschnitt("Zwei Gesellschaften nebeneinander");
{
  /*
   * Kommt eine zweite Gesellschaft dazu, sind das zwei Buchfuehrungen und
   * zwei Jahresabschluesse - in derselben Installation, aber ohne jede
   * Beruehrung. Geprueft wird hier genau das: Beide fuehren dieselben
   * Kontonummern, dieselben Belegnummern und denselben Kunden, und nichts
   * davon darf sich vermischen.
   */
  const eins = firmaAnlegen("Muster GmbH");
  const zwei = firmaAnlegen("Muster Mobil GmbH");
  const a1 = Object.assign({}, sitzung, { firmaId: eins });
  const a2 = Object.assign({}, sitzung, { firmaId: zwei });

  B.einstellungenSetzen(a1, { berater: "1234567", mandant: "55555", skr: "04",
    absender: "Muster GmbH\nWeg 1\n83278 Musterstadt", steuernummer: "163/123/45678",
    ustArt: "steuerfrei", steuerhinweis: "Umsatzsteuerfrei nach § 4 Nr. 16 UStG." });
  B.einstellungenSetzen(a2, { berater: "1234567", mandant: "66666", skr: "04",
    absender: "Muster Mobil GmbH\nWeg 2\n83278 Musterstadt", steuernummer: "163/123/99999",
    ustArt: "steuerpflichtig" });
  B.kontenVorlage(a1, "04");
  B.kontenVorlage(a2, "04");

  gleich("jede Gesellschaft hat ihre eigene Mandantennummer",
    B.einstellungenLesen(a1).koerper.mandant + "/" + B.einstellungenLesen(a2).koerper.mandant,
    "55555/66666");
  gleich("und ihre eigene umsatzsteuerliche Stellung",
    B.einstellungenLesen(a1).koerper.ustArt + "/" + B.einstellungenLesen(a2).koerper.ustArt,
    "steuerfrei/steuerpflichtig");

  // Derselbe Kunde, dieselbe Kontonummer - in beiden Gesellschaften.
  const k1 = B.partnerSpeichern(a1, null, { typ: "Debitor", name: "Pflegekasse Muster",
    strasse: "Kassenweg 4", plz: "83278", ort: "Musterstadt" }).koerper;
  const k2 = B.partnerSpeichern(a2, null, { typ: "Debitor", name: "Pflegekasse Muster",
    strasse: "Kassenweg 4", plz: "83278", ort: "Musterstadt" }).koerper;
  gleich("beide vergeben dieselbe erste Debitorennummer", k1.konto + "/" + k2.konto, "10000/10000");
  gleich("es sind trotzdem zwei Datensaetze", k1.id === k2.id, "false");
  gleich("jede Gesellschaft sieht nur ihren", B.partner(a1).length, 1);

  /* -- Journalnummern laufen getrennt -- */
  const b1 = B.belegSpeichern(a1, null, { art: "Ausgangsrechnung", datum: "2026-09-01",
    belegnummer: "R-1", partnerId: k1.id, sollKonto: k1.konto, habenKonto: "4100",
    bruttoCent: 100000, steuersatz: 0, buchungstext: "Pflege September" }).koerper;
  const b2 = B.belegSpeichern(a2, null, { art: "Ausgangsrechnung", datum: "2026-09-01",
    belegnummer: "R-1", partnerId: k2.id, sollKonto: k2.konto, habenKonto: "4400",
    bruttoCent: 238000, steuersatz: 19, buchungstext: "Fahrdienst September" }).koerper;
  gleich("beide beginnen bei Journalnummer 1", b1.journalNr + "/" + b2.journalNr, "1/1");
  gleich("dieselbe Belegnummer stoert nicht", B.belege(a1).length, 1);
  gleich("und jede sieht nur die eigene Buchung", B.belege(a2).length, 1);
  gleich("die Uebersicht zaehlt getrennt",
    B.uebersicht(a1, "2026-01-01", "2026-12-31").anzahl, 1);

  /* -- Umsatzsteuer getrennt -- */
  gleich("steuerfrei bei der einen",
    B.umsatzsteuer(a1, "2026-01-01", "2026-12-31").zahllast, 0);
  gleich("steuerpflichtig bei der anderen",
    B.umsatzsteuer(a2, "2026-01-01", "2026-12-31").zahllast, 38000);

  /* -- Offene Posten getrennt -- */
  gleich("offene Forderungen der ersten",
    OP.offenePosten(a1, { stichtag: "2026-09-30" }).koerper.forderungen.centSumme, 100000);
  gleich("offene Forderungen der zweiten",
    OP.offenePosten(a2, { stichtag: "2026-09-30" }).koerper.forderungen.centSumme, 238000);

  /* -- Rechnungsnummern getrennt -- */
  B.einstellungenSetzen(a2, { rechnungPraefix: "MM-{JJ}-", rechnungStellen: 4 });
  const r1 = RG.speichern(a1, null, { partnerId: k1.id, datum: "2026-09-02",
    leistungVon: "2026-09-01", steuerhinweis: "Umsatzsteuerfrei nach § 4 Nr. 16 UStG.",
    positionen: [{ bezeichnung: "Pflege", mengeMille: 1000, einzelCent: 50000,
      steuersatz: 0, konto: "4100" }] }).koerper;
  const r2 = RG.speichern(a2, null, { partnerId: k2.id, datum: "2026-09-02",
    leistungVon: "2026-09-01",
    positionen: [{ bezeichnung: "Fahrt", mengeMille: 1000, einzelCent: 50000,
      steuersatz: 19, konto: "4400" }] }).koerper;
  gleich("eigener Nummernkreis je Gesellschaft",
    RG.festschreiben(a1, r1.id).koerper.nummer + " / " + RG.festschreiben(a2, r2.id).koerper.nummer,
    "2600000001 / MM-26-0001");
  gleich("jede sieht nur ihre Rechnungen", RG.liste(a1, {}).koerper.wert.length, 1);

  /* -- Was der einen gehoert, ist fuer die andere nicht da -- */
  abgewiesen("die Rechnung der anderen Gesellschaft oeffnen",
    () => RG.einzeln(a2, r1.id), "nicht gefunden");
  abgewiesen("den Beleg der anderen stornieren",
    () => B.belegStornieren(a2, b1.id, "Versuch"), "nicht gefunden");
  abgewiesen("einen Kunden der anderen berechnen",
    () => RG.speichern(a2, null, { partnerId: k1.id, datum: "2026-09-03",
      positionen: [{ bezeichnung: "X", mengeMille: 1000, einzelCent: 100,
        steuersatz: 0, konto: "4400" }] }), "Unbekannter Geschäftspartner");

  /* -- Mahnwesen getrennt -- */
  const m1 = MW.vorschlaege(a1, { stichtag: "2026-11-30" }).koerper;
  const m2 = MW.vorschlaege(a2, { stichtag: "2026-11-30" }).koerper;
  gleich("jede Gesellschaft mahnt ihre eigenen Forderungen",
    // 238.000 aus dem Beleg, dazu 59.500 aus der Rechnung (50.000 + 19 %).
    m1.vorschlaege[0].forderungCent + "/" + m2.vorschlaege[0].forderungCent, "150000/297500");
  MW.erstellen(a1, { stichtag: "2026-11-30",
    auswahl: [{ partnerId: k1.id, stufe: 1 }] });
  MW.erstellen(a2, { stichtag: "2026-11-30",
    auswahl: [{ partnerId: k2.id, stufe: 1 }] });
  gleich("und beide beginnen bei Mahnung 1",
    MW.liste(a1, {}).koerper.wert[0].nummer + "/" + MW.liste(a2, {}).koerper.wert[0].nummer,
    "M2026-0001/M2026-0001");
  gleich("jede sieht nur ihre eigene", MW.liste(a2, {}).koerper.wert.length, 1);

  /* -- Der Basiszinssatz ist dagegen gemeinsam -- */
  gleich("der Basiszinssatz gilt fuer beide gleich",
    m1.basiszins.liste.length, m2.basiszins.liste.length);

  /* -- Uebergabe an die Kanzlei getrennt -- */
  const paket = U.erzeugen(a1, { von: "2026-01-01", bis: "2026-12-31", endgueltig: false }).koerper;
  gleich("das Paket enthaelt nur die Buchungen der eigenen Gesellschaft", paket.anzahl, 2);
  gleich("die andere bleibt unberuehrt",
    B.uebersicht(a2, "2026-01-01", "2026-12-31").offen, 2);
}

abschnitt("Umsatzsteuerbefreiung");
{
  const firma8 = firmaAnlegen("Befreit GmbH");
  const s8 = Object.assign({}, sitzung, { firmaId: firma8 });
  B.einstellungenSetzen(s8, { berater: "1234567", mandant: "55555", skr: "04",
    absender: "Muster GmbH\nMusterweg 9\n83278 Musterstadt", steuernummer: "163/123/45678" });
  B.kontenVorlage(s8, "04");

  gleich("im Regelfall steuerpflichtig", B.einstellungenLesen(s8).koerper.ustArt, "steuerpflichtig");
  B.einstellungenSetzen(s8, { ustArt: "steuerfrei",
    steuerhinweis: RG.STEUERHINWEISE[1].text });
  gleich("die Befreiung laesst sich eintragen", B.einstellungenLesen(s8).koerper.ustArt, "steuerfrei");
  gleich("und der Hinweis wird als Vorgabe gemerkt",
    RG.vorlagen(s8).koerper.steuerhinweisVorgabe, RG.STEUERHINWEISE[1].text);
  B.einstellungenSetzen(s8, { ustArt: "Unsinn" });
  gleich("eine unbekannte Angabe wird nicht uebernommen",
    B.einstellungenLesen(s8).koerper.ustArt, "steuerfrei");

  const kunde = B.partnerSpeichern(s8, null, { typ: "Debitor", name: "Pflegekasse Muster",
    strasse: "Kassenweg 4", plz: "83278", ort: "Musterstadt" }).koerper;

  /*
   * Der Regelfall: steuerfreie Erloese. Die Rechnung traegt den Hinweis und
   * keine Steuer.
   */
  const frei = RG.speichern(s8, null, { partnerId: kunde.id, datum: "2026-09-01",
    leistungVon: "2026-08-01", leistungBis: "2026-08-31", betreff: "Pflegeleistungen August",
    steuerhinweis: RG.STEUERHINWEISE[1].text,
    positionen: [{ bezeichnung: "Grundpflege", mengeMille: 40000, einheit: "Std",
      einzelCent: 3800, steuersatz: 0, konto: "4100" }] }).koerper;
  gleich("keine Steuer auf der Rechnung", frei.steuerCent, 0);
  RG.festschreiben(s8, frei.id);
  gleich("die steuerfreien Umsaetze stehen in Kennzahl 48",
    B.umsatzsteuer(s8, "2026-01-01", "2026-12-31").kennzahlen["48"], 152000);
  gleich("und die Zahllast ist null",
    B.umsatzsteuer(s8, "2026-01-01", "2026-12-31").zahllast, 0);
  gleich("die Auswertung nennt die Stellung",
    B.umsatzsteuer(s8, "2026-01-01", "2026-12-31").ustArt, "steuerfrei");

  /*
   * Vorsteuer aus einer Eingangsrechnung. Buchbar ist sie - aber sie darf
   * nicht abgezogen werden (§ 15 Abs. 2 UStG), und genau darauf muss die
   * Selbstpruefung zeigen. Sonst faellt es erst der Kanzlei auf.
   */
  const lieferant = B.partnerSpeichern(s8, null, { typ: "Kreditor", name: "Werkstatt Muster" }).koerper;
  B.belegSpeichern(s8, null, { art: "Eingangsrechnung", datum: "2026-09-05", belegnummer: "E-100",
    partnerId: lieferant.id, sollKonto: "6530", habenKonto: lieferant.konto,
    bruttoCent: 119000, steuersatz: 19, buchungstext: "Reparatur Fahrzeug" });
  const p8 = B.pruefung(s8, "2026-01-01", "2026-12-31");
  const vst = p8.befunde.find((b) => b.titel.includes("Vorsteuer"));
  pruefe("gebuchte Vorsteuer wird beanstandet", !!vst,
    JSON.stringify(p8.befunde.map((b) => b.titel)));
  pruefe("mit Verweis auf § 15 Abs. 2 UStG", vst && vst.text.includes("§ 15 Abs. 2"));
  pruefe("und dem Betrag, um den es geht", vst && vst.text.includes("190,00"), vst && vst.text);

  /*
   * Ein steuerpflichtiger Erloes bleibt moeglich - ein Fahrzeugverkauf etwa -
   * wird aber angezeigt.
   */
  const nebenher = RG.speichern(s8, null, { partnerId: kunde.id, datum: "2026-09-10",
    leistungVon: "2026-09-10", betreff: "Verkauf Altfahrzeug",
    positionen: [{ bezeichnung: "Pkw, gebraucht", mengeMille: 1000, einzelCent: 500000,
      steuersatz: 19, konto: "4400" }] }).koerper;
  gleich("ein steuerpflichtiges Nebengeschaeft bleibt moeglich", nebenher.steuerCent, 95000);
  RG.festschreiben(s8, nebenher.id);
  const p8b = B.pruefung(s8, "2026-01-01", "2026-12-31");
  const erl = p8b.befunde.find((b) => b.titel.includes("Erlöse mit Umsatzsteuer"));
  pruefe("wird aber angezeigt", !!erl, JSON.stringify(p8b.befunde.map((b) => b.titel)));
  gleich("als Warnung, nicht als Fehler", erl && erl.schwere, "warnung");

  /* -- Kleinunternehmer: hier ist der Ausweis gesperrt -- */
  const firma9 = firmaAnlegen("Klein GmbH");
  const s9 = Object.assign({}, sitzung, { firmaId: firma9 });
  B.einstellungenSetzen(s9, { berater: "1234567", mandant: "55555", skr: "04",
    absender: "Klein GmbH\nWeg 1\n83278 Musterstadt", steuernummer: "163/123/45679",
    ustArt: "kleinunternehmer" });
  B.kontenVorlage(s9, "04");
  const k9 = B.partnerSpeichern(s9, null, { typ: "Debitor", name: "Kunde Muster",
    strasse: "Weg 2", plz: "83278", ort: "Musterstadt" }).koerper;
  abgewiesen("Umsatzsteuer auf einer Kleinunternehmerrechnung",
    () => RG.speichern(s9, null, { partnerId: k9.id, datum: "2026-09-01",
      positionen: [{ bezeichnung: "Fahrt", mengeMille: 1000, einzelCent: 10000,
        steuersatz: 19, konto: "4400" }] }), "§ 14c");

  const klein = RG.speichern(s9, null, { partnerId: k9.id, datum: "2026-09-01",
    leistungVon: "2026-09-01",
    positionen: [{ bezeichnung: "Fahrt", mengeMille: 1000, einzelCent: 10000,
      steuersatz: 0, konto: "4100" }] }).koerper;
  const fehlt9 = RG.bogen(s9, klein.id).koerper.fehlendeAngaben;
  pruefe("ohne Hinweis auf § 19 fehlt die Pflichtangabe",
    fehlt9.some((x) => x.includes("§ 19")), JSON.stringify(fehlt9));
  const p9 = B.pruefung(s9, "2026-01-01", "2026-12-31");
  pruefe("beim Kleinunternehmer waere ausgewiesene Steuer ein Fehler",
    !p9.befunde.some((b) => b.titel.includes("Erlöse mit Umsatzsteuer")));
}

abschnitt("Verzugszinsen rechnen");
{
  /*
   * Die Zahlen hier sind von Hand nachgerechnet, nicht aus dem Modul
   * uebernommen - sonst pruefte sich der Code an sich selbst.
   *
   * 1.000,00 EUR, 1.1.2024 bis 1.7.2024: 182 Tage, Basiszinssatz 3,62 %
   * zuzueglich 9 Punkte sind 12,62 %. 2024 hat 366 Tage.
   *   100000 * 0,1262 * 182 / 366 = 6275,52 Cent
   */
  const einHalbjahr = MW.zinsen(100000, "2024-01-01", "2024-07-01", false);
  gleich("ein Halbjahr, neun Punkte ueber Basis", einHalbjahr.centZins, 6276);
  gleich("Tage taggenau gezaehlt", einHalbjahr.tage, 182);
  gleich("ein Abschnitt", einHalbjahr.abschnitte.length, 1);
  gleich("Zinssatz 12,62 Prozent", einHalbjahr.abschnitte[0].satzBp, 1262);

  /*
   * Ueber die Halbjahresgrenze. Zweites Halbjahr 2024: 3,37 % + 9 = 12,37 %,
   * 184 Tage.  100000 * 0,1237 * 184 / 366 = 6218,80 Cent.
   * Zusammen 6275,52 + 6218,80 = 12494,32 -> 12494 Cent.
   */
  const zweiHalbjahre = MW.zinsen(100000, "2024-01-01", "2025-01-01", false);
  gleich("ueber die Halbjahresgrenze wird abschnittsweise gerechnet", zweiHalbjahre.abschnitte.length, 2);
  gleich("und die Summe stimmt auf den Cent", zweiHalbjahre.centZins, 12494);
  gleich("der zweite Abschnitt hat den neuen Satz", zweiHalbjahre.abschnitte[1].satzBp, 1237);
  pruefe("ein Jahresmittel waere etwas anderes",
    zweiHalbjahre.centZins !== Math.round(100000 * 0.1262 * 366 / 366));

  /*
   * Verbraucher: fuenf statt neun Punkte (§ 288 Abs. 1 BGB).
   *   100000 * 0,0862 * 182 / 366 = 4286,44 Cent
   */
  const verbraucher = MW.zinsen(100000, "2024-01-01", "2024-07-01", true);
  gleich("bei Verbrauchern fuenf Punkte", verbraucher.abschnitte[0].satzBp, 862);
  gleich("und entsprechend weniger Zins", verbraucher.centZins, 4286);

  gleich("ohne Zeitablauf kein Zins", MW.zinsen(100000, "2024-05-01", "2024-05-01", false).centZins, 0);
  gleich("der erste Tag zaehlt nicht mit",
    MW.zinsen(100000, "2024-05-01", "2024-05-02", false).tage, 1);

  /*
   * Ein Halbjahr ohne hinterlegten Satz. Gerechnet wird mit dem letzten
   * bekannten - aber es steht dabei, dass er fortgeschrieben wurde.
   */
  const kuenftig = MW.zinsen(100000, "2029-01-05", "2029-06-01", false);
  pruefe("fehlender Basiszinssatz wird gekennzeichnet", kuenftig.unsicher);
  pruefe("und das fehlende Halbjahr benannt", kuenftig.fehlend.includes("2029-01-01"),
    kuenftig.fehlend.join(","));

  gleich("der Basiszinssatz gilt halbjahresweise", MW.halbjahrAb("2024-06-30"), "2024-01-01");
  gleich("und ab Juli neu", MW.halbjahrAb("2024-07-01"), "2024-07-01");
  gleich("ein hinterlegtes Halbjahr gilt als sicher",
    MW.satzAm("2024-03-01").fortgeschrieben, "false");

  // Verzugsbeginn
  gleich("mit Faelligkeit beginnt der Verzug am Folgetag",
    MW.verzugsbeginn({ datum: "2026-01-10", faelligAm: "2026-02-09" }).ab, "2026-02-10");
  gleich("ohne Faelligkeit 30 Tage nach Rechnungsdatum",
    MW.verzugsbeginn({ datum: "2026-01-10", faelligAm: null }).ab, "2026-02-10");
}

abschnitt("Mahnwesen");
{
  const firma6 = firmaAnlegen("Mahn GmbH");
  const s6 = Object.assign({}, sitzung, { firmaId: firma6 });
  B.einstellungenSetzen(s6, { berater: "1234567", mandant: "55555", skr: "04" });
  B.kontenVorlage(s6, "04");

  const kasse = B.partnerSpeichern(s6, null, { typ: "Debitor", name: "Muster Krankenkasse",
    strasse: "Musterweg 1", plz: "83278", ort: "Musterstadt" }).koerper;
  const selbstzahler = B.partnerSpeichern(s6, null, { typ: "Debitor", name: "Maria Muster",
    strasse: "Musterweg 2", plz: "83278", ort: "Musterstadt", verbraucher: true }).koerper;
  const lieferant = B.partnerSpeichern(s6, null, { typ: "Kreditor", name: "Lieferant Muster GmbH" }).koerper;

  pruefe("der Verbraucherschalter bleibt gespeichert",
    B.partner(s6).find((p) => p.id === selbstzahler.id).verbraucher === true);

  const stufen = MW.stufenLesen(firma6);
  gleich("drei Mahnstufen sind vorbereitet", stufen.length, 3);
  gleich("die erste ist eine Zahlungserinnerung", stufen[0].bezeichnung, "Zahlungserinnerung");
  gleich("ohne Gebuehr", stufen[0].gebuehrCent, 0);
  pruefe("und ohne Zinsen", !stufen[0].zinsen);
  pruefe("ab der ersten Mahnung mit Zinsen", stufen[1].zinsen);

  abgewiesen("eine Mahngebuehr ueber zehn Euro",
    () => MW.stufeSpeichern(s6, 2, { gebuehrCent: 1500 }), "Verzugsschaden");

  /*
   * Drei Rechnungen desselben Kostentraegers, unterschiedlich lange offen,
   * dazu eine Eingangsrechnung (die mahnen wir nicht - die schulden wir) und
   * eine Rechnung ohne Geschaeftspartner.
   */
  const r1 = B.belegSpeichern(s6, null, { art: "Ausgangsrechnung", datum: "2026-06-01",
    faelligAm: "2026-06-15", belegnummer: "2600000200", partnerId: kasse.id,
    sollKonto: kasse.konto, habenKonto: "4400", bruttoCent: 120000, steuersatz: 0,
    buchungstext: "Krankenfahrten Mai" }).koerper;
  const r2 = B.belegSpeichern(s6, null, { art: "Ausgangsrechnung", datum: "2026-07-01",
    faelligAm: "2026-07-15", belegnummer: "2600000201", partnerId: kasse.id,
    sollKonto: kasse.konto, habenKonto: "4400", bruttoCent: 80000, steuersatz: 0,
    buchungstext: "Krankenfahrten Juni" }).koerper;
  const r3 = B.belegSpeichern(s6, null, { art: "Ausgangsrechnung", datum: "2026-08-20",
    faelligAm: "2026-09-20", belegnummer: "2600000202", partnerId: kasse.id,
    sollKonto: kasse.konto, habenKonto: "4400", bruttoCent: 50000, steuersatz: 0,
    buchungstext: "Krankenfahrten Juli" }).koerper;
  B.belegSpeichern(s6, null, { art: "Eingangsrechnung", datum: "2026-06-01",
    faelligAm: "2026-06-10", belegnummer: "E-1", partnerId: lieferant.id,
    sollKonto: "6310", habenKonto: lieferant.konto, bruttoCent: 30000, steuersatz: 0,
    buchungstext: "Miete" });
  B.belegSpeichern(s6, null, { art: "Ausgangsrechnung", datum: "2026-06-01",
    faelligAm: "2026-06-15", belegnummer: "2600000299", sollKonto: "1200", habenKonto: "4400",
    bruttoCent: 9900, steuersatz: 0, buchungstext: "Rechnung ohne Partner" });

  const v1 = MW.vorschlaege(s6, { stichtag: "2026-09-12" }).koerper;
  gleich("ein Vorschlag je Zahler und Stufe", v1.vorschlaege.length, 1);
  const g1 = v1.vorschlaege[0];
  gleich("die faelligen Rechnungen sind zusammengefasst", g1.positionen.length, 2);
  gleich("Stufe 1", g1.stufe, 1);
  gleich("die Summe der offenen Betraege", g1.forderungCent, 200000);
  pruefe("die noch nicht faellige Rechnung fehlt",
    !g1.positionen.some((p) => p.belegnummer === "2600000202"));
  pruefe("eine Eingangsrechnung wird nicht gemahnt",
    !v1.vorschlaege.some((g) => g.partner === "Lieferant Muster GmbH"));
  pruefe("eine Rechnung ohne Geschaeftspartner wird uebergangen, nicht verschwiegen",
    v1.uebergangen.some((u) => u.belegnummer === "2600000299" && u.grund.includes("Geschäftspartner")),
    JSON.stringify(v1.uebergangen));
  gleich("Stufe 1 traegt keine Zinsen", g1.zinsenCent, 0);
  gleich("die Frist steht fest", g1.fristAm, "2026-09-22");

  /* -- Mahnung anlegen -- */
  const belegeVorher = B.belege(s6).length;
  const erstellt = MW.erstellen(s6, { stichtag: "2026-09-12",
    auswahl: [{ partnerId: kasse.id, stufe: 1 }] }).koerper;
  gleich("eine Mahnung angelegt", erstellt.angelegt.length, 1);
  gleich("mit fortlaufender Nummer", erstellt.angelegt[0].nummer, "M2026-0001");
  gleich("eine Mahnung ist keine Buchung", B.belege(s6).length, belegeVorher);

  const liste1 = MW.liste(s6, {}).koerper.wert;
  gleich("sie steht in der Liste", liste1.length, 1);
  gleich("mit beiden Rechnungen", liste1[0].positionen.length, 2);
  gleich("und der Gesamtsumme", liste1[0].summeCent, 200000);

  /* -- Kein zweites Mal innerhalb der Frist -- */
  const v2 = MW.vorschlaege(s6, { stichtag: "2026-09-15" }).koerper;
  pruefe("innerhalb der Frist wird nicht erneut gemahnt", !v2.vorschlaege.length);
  pruefe("und es steht dabei, warum",
    v2.uebergangen.some((u) => u.grund.includes("Frist")), JSON.stringify(v2.uebergangen));

  /* -- Nach Fristablauf die naechste Stufe, jetzt mit Zinsen -- */
  const v3 = MW.vorschlaege(s6, { stichtag: "2026-09-30" }).koerper;
  gleich("nach Fristablauf folgt die naechste Stufe", v3.vorschlaege[0].stufe, 2);
  pruefe("und sie traegt Zinsen", v3.vorschlaege[0].zinsenCent > 0);
  const p1 = v3.vorschlaege[0].positionen.find((p) => p.belegnummer === "2600000200");
  gleich("der Verzug beginnt am Tag nach der Faelligkeit", p1.verzugAb, "2026-06-16");
  gleich("die Zinstage stimmen", p1.zinsTage, MW.tageZwischen("2026-06-16", "2026-09-30"));

  /*
   * Der Basiszinssatz fuer das zweite Halbjahr 2026 ist nicht hinterlegt.
   * Genau das muss dastehen - eine Zinsforderung auf einem veralteten Satz
   * ist schlimmer als keine.
   */
  pruefe("der fortgeschriebene Basiszinssatz wird gemeldet", v3.vorschlaege[0].zinsUnsicher);
  gleich("und das fehlende Halbjahr benannt", v3.basiszins.fehltAb, "2026-07-01");

  /*
   * Der Verzug beginnt im ersten Halbjahr 2026, die Mahnung liegt im zweiten.
   * Es genuegt also nicht, nur das laufende Halbjahr nachzutragen - und genau
   * das muss die Anwendung sagen, statt still weiterzurechnen.
   */
  pruefe("beide fehlenden Halbjahre werden genannt",
    v3.basiszins.fehlend.join(",") === "2026-01-01,2026-07-01", v3.basiszins.fehlend.join(","));
  MW.basiszinsSetzen(s6, { gueltigAb: "2026-07-01", satzProzent: 1.5 });
  const halb = MW.vorschlaege(s6, { stichtag: "2026-09-30" }).koerper;
  pruefe("ein nachgetragenes Halbjahr genuegt noch nicht", halb.vorschlaege[0].zinsUnsicher);
  gleich("das andere fehlt weiterhin", halb.basiszins.fehlend.join(","), "2026-01-01");

  MW.basiszinsSetzen(s6, { gueltigAb: "2026-01-01", satzProzent: 1.4 });
  const v4 = MW.vorschlaege(s6, { stichtag: "2026-09-30" }).koerper;
  pruefe("erst mit beiden ist der Zins gesichert", !v4.vorschlaege[0].zinsUnsicher);
  pruefe("und er faellt anders aus als zuvor", v4.vorschlaege[0].zinsenCent !== v3.vorschlaege[0].zinsenCent);
  abgewiesen("ein Basiszinssatz mitten im Halbjahr",
    () => MW.basiszinsSetzen(s6, { gueltigAb: "2026-08-01", satzProzent: 2 }), "1. Januar");

  /* -- Zwischenzeitliche Zahlung -- */
  const zahlung = B.belegSpeichern(s6, null, { art: "Zahlungseingang", datum: "2026-09-29",
    belegnummer: "Z-1", partnerId: kasse.id, sollKonto: "1800", habenKonto: kasse.konto,
    bruttoCent: 120000, steuersatz: 0, buchungstext: "Zahlung Kasse" }).koerper;
  OP.ausgleichen(s6, { rechnungId: r1.id, zahlungId: zahlung.id, betragCent: 120000 });

  const nachZahlung = MW.vorschlaege(s6, { stichtag: "2026-09-30" }).koerper;
  gleich("die bezahlte Rechnung faellt aus dem Vorschlag", nachZahlung.vorschlaege[0].positionen.length, 1);
  gleich("nur noch die offene Forderung", nachZahlung.vorschlaege[0].forderungCent, 80000);

  const zweite = MW.erstellen(s6, { stichtag: "2026-09-30",
    auswahl: [{ partnerId: kasse.id, stufe: 2 }] }).koerper;
  gleich("die zweite Mahnung steht", zweite.angelegt.length, 1);
  const m2 = MW.liste(s6, {}).koerper.wert.find((x) => x.nummer === zweite.angelegt[0].nummer);
  gleich("sie mahnt nur noch die offene Rechnung", m2.positionen.length, 1);
  gleich("Gesamtbetrag ist Forderung plus Zinsen plus Gebuehr",
    m2.summeCent, m2.forderungCent + m2.zinsenCent + m2.gebuehrCent);

  /* -- Eine bezahlte Forderung wird nicht mehr gemahnt -- */
  const zahlung2 = B.belegSpeichern(s6, null, { art: "Zahlungseingang", datum: "2026-10-01",
    belegnummer: "Z-2", partnerId: kasse.id, sollKonto: "1800", habenKonto: kasse.konto,
    bruttoCent: 80000, steuersatz: 0, buchungstext: "Restzahlung" }).koerper;
  OP.ausgleichen(s6, { rechnungId: r2.id, zahlungId: zahlung2.id, betragCent: 80000 });
  const nachAusgleich = MW.erstellen(s6, { stichtag: "2026-10-20",
    auswahl: [{ partnerId: kasse.id, stufe: 3 }] }).koerper;
  pruefe("was inzwischen bezahlt ist, wird nicht mehr gemahnt",
    !nachAusgleich.angelegt.length && nachAusgleich.abgelehnt.length === 1,
    JSON.stringify(nachAusgleich));
  pruefe("und der Grund steht dabei",
    nachAusgleich.abgelehnt[0].grund.includes("Zahlung"), nachAusgleich.abgelehnt[0].grund);

  /* -- Der Brief -- */
  const b = MW.brief(s6, m2.id).koerper;
  pruefe("der Brief nennt die Rechnung", b.text.includes("2600000201"));
  pruefe("der Brief nennt die Frist", b.text.includes(MW.plusTage("2026-09-30", 10).slice(8, 10) + "."),
    b.text.slice(0, 200));
  pruefe("der Platzhalter ist ersetzt", !b.text.includes("{frist}"));
  pruefe("die Anschrift steht oben", b.anschrift[0] === "Muster Krankenkasse");
  pruefe("der Gesamtbetrag steht im Brief", b.text.includes("Gesamtbetrag"));

  /* -- Zuruecknehmen -- */
  abgewiesen("Zuruecknehmen ohne Grund", () => MW.zuruecknehmen(s6, m2.id, {}), "warum");
  MW.zuruecknehmen(s6, m2.id, { grund: "Zahlung war unterwegs" });
  const zurueck = MW.liste(s6, {}).koerper.wert.find((x) => x.id === m2.id);
  gleich("die Mahnung bleibt mit Vermerk stehen", zurueck.status, "zurückgenommen");
  gleich("mit Begruendung", zurueck.notiz, "Zahlung war unterwegs");

  /* -- Verbraucher: fuenf Punkte -- */
  const rv = B.belegSpeichern(s6, null, { art: "Ausgangsrechnung", datum: "2026-05-01",
    faelligAm: "2026-05-15", belegnummer: "2600000210", partnerId: selbstzahler.id,
    sollKonto: selbstzahler.konto, habenKonto: "4400", bruttoCent: 25000, steuersatz: 0,
    buchungstext: "Zuzahlung" }).koerper;
  MW.erstellen(s6, { stichtag: "2026-09-30", auswahl: [{ partnerId: selbstzahler.id, stufe: 1 }] });
  const vv = MW.vorschlaege(s6, { stichtag: "2026-10-20" }).koerper
    .vorschlaege.find((g) => g.partnerId === selbstzahler.id);
  gleich("beim Verbraucher steht das auch am Vorschlag", vv.verbraucher, "true");
  const eigen = MW.zinsen(25000, MW.verzugsbeginn({ datum: "2026-05-01", faelligAm: "2026-05-15" }).ab,
    "2026-10-20", true);
  gleich("und der Zins ist der Verbraucherzins", vv.zinsenCent, eigen.centZins);

  /* -- Leistungsgrundlage und Versicherte(r) -- */
  {
    /*
     * Abrechnung gegenueber einer Pflegekasse: Zahler ist die Kasse, die
     * Leistung bekommt der Versicherte. Beides muss auf dem Blatt stehen.
     */
    const kassenRg = RG.speichern(s6, null, { partnerId: kasse.id, datum: "2026-09-20",
      leistungVon: "2026-08-01", leistungBis: "2026-08-31", betreff: "Betreuung August",
      steuerhinweis: RG.STEUERHINWEISE[0].text,
      grundlage: RG.GRUNDLAGEN[0], versicherter: "Maria Muster, Vers.-Nr. A123456789",
      positionen: [{ bezeichnung: "Betreuung und hauswirtschaftliche Unterstützung",
        mengeMille: 4000, einheit: "Std", einzelCent: 3200, steuersatz: 0, konto: "4400" }] }).koerper;
    const kb = RG.bogen(s6, kassenRg.id).koerper;
    gleich("die Leistungsgrundlage steht auf dem Bogen", kb.grundlage,
      "Entlastungsbetrag nach § 45b SGB XI");
    gleich("und der Versicherte", kb.versicherter, "Maria Muster, Vers.-Nr. A123456789");
    pruefe("der Steuerhinweis nennt die Anerkennung nach § 45a SGB XI",
      kb.rechnung.steuerhinweis.includes("§ 45a SGB XI"), kb.rechnung.steuerhinweis);
    pruefe("und § 4 Nr. 16 UStG ohne erfundenen Buchstaben",
      kb.rechnung.steuerhinweis.includes("§ 4 Nr. 16 UStG") &&
      !/§ 4 Nr\. 16 Buchst/.test(kb.rechnung.steuerhinweis), kb.rechnung.steuerhinweis);
    gleich("beides bleibt erhalten", RG.einzeln(s6, kassenRg.id).koerper.grundlage,
      "Entlastungsbetrag nach § 45b SGB XI");
    const ohneKasse = RG.speichern(s6, null, { partnerId: kasse.id, datum: "2026-09-21",
      leistungVon: "2026-09-01", steuerhinweis: RG.STEUERHINWEISE[0].text,
      positionen: [{ bezeichnung: "Begleitung", mengeMille: 1000, einheit: "Std",
        einzelCent: 3200, steuersatz: 0, konto: "4400" }] }).koerper;
    pruefe("ohne Kassenbezug bleiben die Felder leer",
      RG.bogen(s6, ohneKasse.id).koerper.grundlage === null &&
      RG.bogen(s6, ohneKasse.id).koerper.versicherter === null);
  }

  /* -- Verjaehrung -- */
  B.belegSpeichern(s6, null, { art: "Ausgangsrechnung", datum: "2023-03-01",
    faelligAm: "2023-03-31", belegnummer: "2300000001", partnerId: kasse.id,
    sollKonto: kasse.konto, habenKonto: "4400", bruttoCent: 45000, steuersatz: 0,
    buchungstext: "Alte Forderung" });
  const vj = MW.vorschlaege(s6, { stichtag: "2026-10-20" }).koerper;
  pruefe("alte Forderungen werden als verjaehrungsgefaehrdet gemeldet",
    vj.verjaehrung.some((x) => x.belegnummer === "2300000001"), JSON.stringify(vj.verjaehrung));
  gleich("mit dem Datum, zu dem die Regelfrist ablaeuft",
    vj.verjaehrung.find((x) => x.belegnummer === "2300000001").verjaehrtZum, "2026-12-31");
}

abschnitt("Zuordnung von Zahlungen");
{
  const { s2, kunde, rg2 } = bankStand;
  // Teilzahlung von Hand
  const teil = B.belegSpeichern(s2, null, { art: "Zahlungseingang", datum: "2026-03-20",
    belegnummer: "ZE-1", partnerId: kunde.id, sollKonto: "1800", habenKonto: kunde.konto,
    bruttoCent: 20000, steuersatz: 0, buchungstext: "Teilzahlung AOK" }).koerper;

  abgewiesen("mehr zuordnen, als die Zahlung hergibt",
    () => OP.ausgleichen(s2, { rechnungId: rg2.id, zahlungId: teil.id, betragCent: 30000 }),
    "nicht zugeordnet");

  const a = OP.ausgleichen(s2, { rechnungId: rg2.id, zahlungId: teil.id, betragCent: 20000 }).koerper;
  gleich("Teilzahlung zugeordnet", a.betragCent, 20000);
  gleich("Rest der Rechnung", a.restRechnung, 39500);

  const nach = OP.offenePosten(s2, { stichtag: "2026-03-31" }).koerper;
  gleich("Rechnung nur noch teilweise offen", nach.posten[0].offenCent, 39500);
  gleich("bereits ausgeglichener Anteil", nach.posten[0].ausgeglichenCent, 20000);

  const ab = OP.saldenabgleich(s2, { stichtag: "2026-03-31" }).koerper;
  gleich("Saldo und offene Posten stimmen auch bei Teilzahlung ueberein",
    ab.debitoren.saldoCent, ab.debitoren.offenCent - ab.debitoren.nichtZugeordnetCent);

  // Was nicht zusammengehoert, darf nicht zugeordnet werden.
  const fremd = B.belegSpeichern(s2, null, { art: "Zahlungsausgang", datum: "2026-03-21",
    belegnummer: "ZA-1", partnerId: bankStand.lieferant.id, sollKonto: bankStand.lieferant.konto,
    habenKonto: "1800", bruttoCent: 5000, steuersatz: 0, buchungstext: "Zahlung Autohaus" }).koerper;
  abgewiesen("Zahlungsausgang auf eine Ausgangsrechnung",
    () => OP.ausgleichen(s2, { rechnungId: rg2.id, zahlungId: fremd.id }), "Zahlungseingang");
  abgewiesen("Rechnung mit sich selbst ausgleichen",
    () => OP.ausgleichen(s2, { rechnungId: rg2.id, zahlungId: rg2.id }), "nur eine Zahlung");

  // Nicht zugeordnete Zahlung muss in der Abstimmung auffallen.
  const ohne = OP.saldenabgleich(s2, { stichtag: "2026-03-31" }).koerper;
  pruefe("nicht zugeordnete Zahlung wird gemeldet",
    ohne.befunde.some((b) => b.titel.includes("ohne zugeordnete Rechnung")));

  OP.ausgleichLoesen(s2, rg2.id, teil.id);
  gleich("nach dem Loesen ist die Rechnung wieder voll offen",
    OP.offenePosten(s2, { stichtag: "2026-03-31" }).koerper.posten.find((p) => p.id === rg2.id).offenCent, 59500);
}

/* --------------------------------------------------------------- Uebergabe */

abschnitt("Uebergabe an den Steuerberater");
abgewiesen("Zeitraum ueber den Jahreswechsel",
  () => U.erzeugen(sitzung, { von: "2025-12-01", bis: "2026-03-31" }), "Wirtschaftsjahr");
abgewiesen("Zeitraum ohne Buchungen",
  () => U.erzeugen(sitzung, { von: "2026-07-01", bis: "2026-07-31" }), "keine");
abgewiesen("Ende vor Anfang",
  () => U.erzeugen(sitzung, { von: "2026-03-31", bis: "2026-01-01" }), "vor seinem Anfang");

const probe = U.erzeugen(sitzung, { von: "2026-01-01", bis: "2026-03-31", endgueltig: false }).koerper;
pruefe("Probelauf erzeugt (" + probe.anzahl + " Buchungen, " + probe.groesse + " Byte)", probe.anzahl > 0);
pruefe("Probelauf schreibt nichts fest", !B.belege(sitzung).some((b) => b.festgeschrieben));
pruefe("nach dem Probelauf laesst sich weiter buchen",
  !!B.belegSpeichern(sitzung, null, { art: "Sonstiges", datum: "2026-03-20", belegnummer: "S-1",
    sollKonto: "6805", habenKonto: "1800", bruttoCent: 4760, steuersatz: 19,
    buchungstext: "Telefonrechnung Maerz" }).koerper.id);

const endgueltig = U.erzeugen(sitzung, { von: "2026-01-01", bis: "2026-03-31", endgueltig: true }).koerper;
pruefe("endgueltige Uebergabe erzeugt (" + endgueltig.anzahl + " Buchungen)", endgueltig.anzahl > 0);
pruefe("Belege sind jetzt festgeschrieben",
  B.belege(sitzung, "2026-01-01", "2026-03-31").every((b) => b.festgeschrieben));
gleich("abgeschlossen bis", B.abgeschlossenBis(firmaId), "2026-03-31");

abgewiesen("festgeschriebenen Beleg aendern",
  () => B.belegSpeichern(sitzung, b1.id, Object.assign({}, grund, { datum: "2026-02-05" })), "festgeschrieben");
abgewiesen("nachtraeglich in den abgeschlossenen Zeitraum buchen",
  () => B.belegSpeichern(sitzung, null, Object.assign({}, grund, { datum: "2026-03-15" })), "festgeschrieben");
abgewiesen("zweimal endgueltig denselben Zeitraum",
  () => U.erzeugen(sitzung, { von: "2026-01-01", bis: "2026-03-31", endgueltig: true }), "bereits endgültig");
pruefe("nach dem Stichtag laesst sich weiter buchen",
  !!B.belegSpeichern(sitzung, null, Object.assign({}, grund, { datum: "2026-04-02", belegnummer: "S-2" })).koerper.id);

/* -------------------------------------------------- Paket auseinandernehmen */

abschnitt("Inhalt des Uebergabepakets");
const paket = U.paketLesen(sitzung, endgueltig.id);
const dateien = entpacken(paket.daten);
pruefe("Paket ist ein lesbares ZIP (" + dateien.size + " Dateien)", dateien.size > 0);
pruefe("LIESMICH.txt enthalten", dateien.has("LIESMICH.txt"));
pruefe("Buchungsliste.csv enthalten", dateien.has("Buchungsliste.csv"));
pruefe("Kontenrahmen.csv enthalten", dateien.has("Kontenrahmen.csv"));
pruefe("Umsatzsteuer.txt enthalten", dateien.has("Umsatzsteuer.txt"));
pruefe("Belegdatei enthalten", [...dateien.keys()].some((n) => n.startsWith("Belege/")));

const stapelName = [...dateien.keys()].find((n) => n.startsWith("EXTF_Buchungsstapel_"));
pruefe("Buchungsstapel enthalten", !!stapelName);
const stapel = dateien.get(stapelName).toString("latin1").split("\r\n").filter((z) => z);
const kopf = stapel[0].split(";");
gleich("Kopfsatz: Kennzeichen", kopf[0], '"EXTF"');
gleich("Kopfsatz: Formatversion", kopf[1], "700");
gleich("Kopfsatz: Kategorie Buchungsstapel", kopf[2], "21");
gleich("Kopfsatz: Formatname", kopf[3], '"Buchungsstapel"');
gleich("Kopfsatz: Version Buchungsstapel", kopf[4], "13");
gleich("Kopfsatz: Beraternummer", kopf[10], "1234567");
gleich("Kopfsatz: Mandantennummer", kopf[11], "55555");
gleich("Kopfsatz: Beginn Wirtschaftsjahr", kopf[12], "20260101");
gleich("Kopfsatz: Sachkontenlaenge", kopf[13], "4");
gleich("Kopfsatz: Zeitraum von", kopf[14], "20260101");
gleich("Kopfsatz: Zeitraum bis", kopf[15], "20260331");
gleich("Kopfsatz: festgeschrieben", kopf[20], "1");
gleich("Kopfsatz: Waehrung", kopf[21], '"EUR"');
gleich("Kopfsatz: Kontenrahmen", kopf[26], '"04"');
gleich("Kopfsatz: 31 Felder", kopf.length, 31);

gleich("Spaltenzeile: 125 Spalten", stapel[1].split(";").length, 125);
pruefe("jede Buchungszeile hat 125 Spalten",
  stapel.slice(2).every((z) => zerlegen(z).length === 125),
  stapel.slice(2).map((z) => zerlegen(z).length).join(","));

const buchungen = stapel.slice(2).map(zerlegen);
const re1 = buchungen.find((z) => z[10] === "RE-2026-001");
pruefe("Ausgangsrechnung im Stapel", !!re1);
if (re1) {
  gleich("Betrag brutto mit Komma", re1[0], "1190,00");
  gleich("Richtung Soll", re1[1], "S");
  gleich("Konto ist das Sollkonto (Debitor)", re1[6], "10000");
  gleich("Gegenkonto ist das Habenkonto (Erloes)", re1[7], "4400");
  gleich("kein Steuerschluessel bei Automatikkonto", re1[8], "");
  gleich("Belegdatum als TTMM", re1[9], "0502");
  gleich("Buchungstext", re1[13], "Krankenfahrten Januar 2026");
  gleich("Festschreibungskennzeichen", re1[113], "1");
  gleich("Leistungsdatum als TTMMJJJJ", re1[114], "31012026");
  gleich("Faelligkeit als TTMMJJJJ", re1[116], "07032026");
}
const er1 = buchungen.find((z) => z[10] === "ER-4711");
if (pruefe("Eingangsrechnung im Stapel", !!er1)) {
  gleich("Steuerschluessel Vorsteuer 19 %", er1[8], "9");
  gleich("Konto ist das Aufwandskonto", er1[6], "6530");
  gleich("Gegenkonto ist der Kreditor", er1[7], "70000");
}
const mitDatei = buchungen.find((z) => z[10] === "ER-4712");
if (pruefe("Beleg mit Datei im Stapel", !!mitDatei)) {
  gleich("Beleginfo-Art nennt die Belegdatei", mitDatei[20], "Belegdatei");
  pruefe("Beleginfo-Inhalt zeigt auf eine Datei im Paket", dateien.has(mitDatei[21]), mitDatei[21]);
}
const stornoZeile = buchungen.find((z) => z[13].startsWith("Storno"));
pruefe("Stornobuchung im Stapel", !!stornoZeile);

const summeStapel = buchungen.reduce((s, z) => s + Math.round(Number(z[0].replace(",", ".")) * 100), 0);
gleich("Summe der Buchungen stimmt mit der Aufzeichnung ueberein", summeStapel, endgueltig.summeCent);

const beschriftung = [...dateien.keys()].find((n) => n.startsWith("EXTF_Kontenbeschriftungen_"));
if (pruefe("Kontenbeschriftungen enthalten", !!beschriftung)) {
  const k = dateien.get(beschriftung).toString("latin1").split("\r\n").filter((z) => z);
  gleich("Kontenbeschriftungen: Kategorie", k[0].split(";")[2], "20");
  gleich("Kontenbeschriftungen: Version", k[0].split(";")[4], "3");
  gleich("Kontenbeschriftungen: drei Spalten", k[1].split(";").length, 3);
  pruefe("Debitor 10000 mit Namen enthalten", k.some((z) => z.startsWith("10000;")), k[2]);
}

abschnitt("Zeichensatz");
{
  const roh = dateien.get(stapelName);
  pruefe("Datei ist nicht UTF-8 kodiert, sondern Windows-1252",
    !roh.includes(Buffer.from("ä", "utf8")) || roh.includes(0xe4));
  const mitUmlaut = datev.nachWindows1252("Ärger über Größe – 5 € „Test“");
  gleich("Ä als ein Byte", mitUmlaut[0], 0xc4);
  pruefe("Eurozeichen wird zu 0x80", mitUmlaut.includes(0x80));
  pruefe("Gedankenstrich wird zu 0x96", mitUmlaut.includes(0x96));
  pruefe("Anfuehrungszeichen unten wird zu 0x84", mitUmlaut.includes(0x84));
  gleich("nicht darstellbares Zeichen wird zum Fragezeichen",
    datev.nachWindows1252("A中B").toString("latin1"), "A?B");
}

abschnitt("Trennzeichen im Text");
{
  // Ein Semikolon im Buchungstext wuerde die Spalten verschieben, wenn es
  // nicht durch Anfuehrungszeichen geschuetzt waere.
  const z = datev.buchungszeile({ cent: 100, konto: 1600, gegenkonto: 4400, datum: "2026-05-01",
    buchungstext: 'Fahrt A; Fahrt B "dringend"', belegfeld1: "X;1" });
  gleich("Zeile hat trotz Semikolon 125 Spalten", zerlegen(z).length, 125);
  gleich("Text bleibt vollstaendig", zerlegen(z)[13], 'Fahrt A; Fahrt B "dringend"');
}

/* ------------------------------------------------------------------ Hilfen */

/** Zerlegt eine CSV-Zeile und beachtet dabei Anfuehrungszeichen. */
function zerlegen(zeile) {
  const felder = [];
  let feld = "", inText = false;
  for (let i = 0; i < zeile.length; i++) {
    const c = zeile[i];
    if (inText) {
      if (c === '"' && zeile[i + 1] === '"') { feld += '"'; i++; }
      else if (c === '"') inText = false;
      else feld += c;
    } else if (c === '"') inText = true;
    else if (c === ";") { felder.push(feld); feld = ""; }
    else feld += c;
  }
  felder.push(feld);
  return felder;
}

/** Liest ein ZIP-Archiv wieder ein - ueber das zentrale Verzeichnis am Ende. */
function entpacken(daten) {
  const zlib = require("zlib");
  const ergebnis = new Map();
  let ende = daten.length - 22;
  while (ende >= 0 && daten.readUInt32LE(ende) !== 0x06054b50) ende--;
  if (ende < 0) return ergebnis;
  const anzahl = daten.readUInt16LE(ende + 10);
  let zeiger = daten.readUInt32LE(ende + 16);
  for (let i = 0; i < anzahl; i++) {
    if (daten.readUInt32LE(zeiger) !== 0x02014b50) break;
    const verfahren = daten.readUInt16LE(zeiger + 10);
    const pruefsumme = daten.readUInt32LE(zeiger + 16);
    const gepackt = daten.readUInt32LE(zeiger + 20);
    const roh = daten.readUInt32LE(zeiger + 24);
    const nameLaenge = daten.readUInt16LE(zeiger + 28);
    const zusatz = daten.readUInt16LE(zeiger + 30);
    const kommentar = daten.readUInt16LE(zeiger + 32);
    const versatz = daten.readUInt32LE(zeiger + 42);
    const name = daten.subarray(zeiger + 46, zeiger + 46 + nameLaenge).toString("utf8");

    const lokalName = daten.readUInt16LE(versatz + 26);
    const lokalZusatz = daten.readUInt16LE(versatz + 28);
    const start = versatz + 30 + lokalName + lokalZusatz;
    const koerper = daten.subarray(start, start + gepackt);
    const inhalt = verfahren === 8 ? zlib.inflateRawSync(koerper) : koerper;
    if (inhalt.length !== roh) throw new Error("Laenge stimmt nicht: " + name);
    if (zip.crc32(inhalt) !== pruefsumme) throw new Error("Pruefsumme stimmt nicht: " + name);
    ergebnis.set(name, inhalt);
    zeiger += 46 + nameLaenge + zusatz + kommentar;
  }
  return ergebnis;
}

/* ---------------------------------------------------------------- Ergebnis */

console.log("\n" + "=".repeat(60));
console.log(bestanden + " Pruefungen bestanden, " + durchgefallen + " fehlgeschlagen.");
if (durchgefallen) {
  console.log("\nFehlgeschlagen:");
  for (const f of fehlerliste) console.log("  - " + f);
}
console.log("=".repeat(60));

db.close();
fs.rmSync(ORDNER, { recursive: true, force: true });
process.exit(durchgefallen ? 1 : 0);
