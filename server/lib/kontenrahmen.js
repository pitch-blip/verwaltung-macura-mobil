"use strict";
/**
 * Kontenrahmen - der Vorrat an Konten, auf die gebucht wird.
 *
 * Hier steht bewusst nur ein kleiner Grundstock: die Konten, ohne die keine
 * Buchung moeglich waere (Kasse, Bank, Forderungen, Verbindlichkeiten,
 * Umsatzsteuer, Vorsteuer) und die haeufigsten Erloes- und Aufwandskonten.
 *
 * Warum nicht der vollstaendige Kontenrahmen mit ueber tausend Konten?
 *
 * Weil die verbindliche Liste beim Steuerberater liegt. Welche Konten seine
 * Kanzlei fuer diesen Mandanten angelegt hat und welche Nummern er erwartet,
 * entscheidet er - eine hier hinterlegte Liste waere bestenfalls dieselbe und
 * schlimmstenfalls falsch, ohne dass es jemand merkt. Deshalb: wenig
 * vorgeben, dafuer die Liste des Steuerberaters einlesen koennen
 * (Buchhaltung -> Konten -> Kontenliste einlesen).
 *
 * Bis das geschehen ist, weist die Anwendung darauf hin, dass der
 * Kontenrahmen noch nicht abgestimmt ist.
 *
 * Rechtsform GmbH: Es wird bilanziert, nicht eingenommen-ueberschuss-gerechnet.
 * Standard ist deshalb SKR04 - der Kontenrahmen, der der Bilanzgliederung
 * folgt und den DATEV fuer Kapitalgesellschaften vorschlaegt. SKR03 steht
 * daneben, falls die Kanzlei damit arbeitet.
 */

/*
 * art:        Aktiv | Passiv | Ertrag | Aufwand  - steuert die Auswertungen
 * steuersatz: Regelsteuersatz in Prozent (0, 7, 19)
 * automatik:  Konto ermittelt die Steuer in DATEV selbst; dann wird kein
 *             Steuerschluessel mitgegeben, sonst meldet DATEV einen
 *             ueberschriebenen Automatikwert.
 * bu:         Steuerschluessel, der ohne Automatik mitgegeben wird
 * geld:       Kasse | Bank - fuer Kassenbuch und Bestandsuebersicht
 */

const SKR04 = [
  { nummer: "0520", bezeichnung: "Pkw", art: "Aktiv", steuersatz: 0 },
  { nummer: "0650", bezeichnung: "Betriebs- und Geschäftsausstattung", art: "Aktiv", steuersatz: 0 },
  { nummer: "0670", bezeichnung: "Geringwertige Wirtschaftsgüter", art: "Aktiv", steuersatz: 0 },
  { nummer: "1200", bezeichnung: "Forderungen aus Lieferungen und Leistungen", art: "Aktiv", steuersatz: 0 },
  { nummer: "1401", bezeichnung: "Abziehbare Vorsteuer 7 %", art: "Aktiv", steuersatz: 0 },
  { nummer: "1406", bezeichnung: "Abziehbare Vorsteuer 19 %", art: "Aktiv", steuersatz: 0 },
  { nummer: "1600", bezeichnung: "Kasse", art: "Aktiv", steuersatz: 0, geld: "Kasse" },
  { nummer: "1800", bezeichnung: "Bank", art: "Aktiv", steuersatz: 0, geld: "Bank" },
  { nummer: "2000", bezeichnung: "Gezeichnetes Kapital", art: "Passiv", steuersatz: 0 },
  { nummer: "3300", bezeichnung: "Verbindlichkeiten aus Lieferungen und Leistungen", art: "Passiv", steuersatz: 0 },
  { nummer: "3801", bezeichnung: "Umsatzsteuer 7 %", art: "Passiv", steuersatz: 0 },
  { nummer: "3806", bezeichnung: "Umsatzsteuer 19 %", art: "Passiv", steuersatz: 0 },
  { nummer: "4100", bezeichnung: "Steuerfreie Umsätze § 4 UStG", art: "Ertrag", steuersatz: 0 },
  { nummer: "4300", bezeichnung: "Erlöse 7 % USt", art: "Ertrag", steuersatz: 7, automatik: true },
  { nummer: "4400", bezeichnung: "Erlöse 19 % USt", art: "Ertrag", steuersatz: 19, automatik: true },
  { nummer: "6020", bezeichnung: "Gehälter", art: "Aufwand", steuersatz: 0 },
  { nummer: "6110", bezeichnung: "Gesetzliche soziale Aufwendungen", art: "Aufwand", steuersatz: 0 },
  { nummer: "6310", bezeichnung: "Miete (unbewegliche Wirtschaftsgüter)", art: "Aufwand", steuersatz: 0 },
  { nummer: "6530", bezeichnung: "Laufende Kfz-Betriebskosten", art: "Aufwand", steuersatz: 19, bu: "9" },
  { nummer: "6805", bezeichnung: "Telefon", art: "Aufwand", steuersatz: 19, bu: "9" },
  { nummer: "6815", bezeichnung: "Bürobedarf", art: "Aufwand", steuersatz: 19, bu: "9" },
  { nummer: "6827", bezeichnung: "Rechts- und Beratungskosten", art: "Aufwand", steuersatz: 19, bu: "9" },
  // Kontofuehrungsgebuehren fallen bei jedem Bankkonto an und tauchen beim
  // ersten Einlesen eines Kontoauszugs sofort auf. Ohne Vorsteuer: Bank-
  // leistungen sind nach § 4 Nr. 8 UStG steuerfrei.
  { nummer: "6855", bezeichnung: "Nebenkosten des Geldverkehrs", art: "Aufwand", steuersatz: 0 },
];

const SKR03 = [
  { nummer: "0320", bezeichnung: "Pkw", art: "Aktiv", steuersatz: 0 },
  { nummer: "0420", bezeichnung: "Betriebsausstattung", art: "Aktiv", steuersatz: 0 },
  { nummer: "0480", bezeichnung: "Geringwertige Wirtschaftsgüter", art: "Aktiv", steuersatz: 0 },
  { nummer: "1000", bezeichnung: "Kasse", art: "Aktiv", steuersatz: 0, geld: "Kasse" },
  { nummer: "1200", bezeichnung: "Bank", art: "Aktiv", steuersatz: 0, geld: "Bank" },
  { nummer: "1400", bezeichnung: "Forderungen aus Lieferungen und Leistungen", art: "Aktiv", steuersatz: 0 },
  { nummer: "1571", bezeichnung: "Abziehbare Vorsteuer 7 %", art: "Aktiv", steuersatz: 0 },
  { nummer: "1576", bezeichnung: "Abziehbare Vorsteuer 19 %", art: "Aktiv", steuersatz: 0 },
  { nummer: "1600", bezeichnung: "Verbindlichkeiten aus Lieferungen und Leistungen", art: "Passiv", steuersatz: 0 },
  { nummer: "1771", bezeichnung: "Umsatzsteuer 7 %", art: "Passiv", steuersatz: 0 },
  { nummer: "1776", bezeichnung: "Umsatzsteuer 19 %", art: "Passiv", steuersatz: 0 },
  { nummer: "2900", bezeichnung: "Gezeichnetes Kapital", art: "Passiv", steuersatz: 0 },
  { nummer: "4100", bezeichnung: "Löhne und Gehälter", art: "Aufwand", steuersatz: 0 },
  { nummer: "4130", bezeichnung: "Gesetzliche soziale Aufwendungen", art: "Aufwand", steuersatz: 0 },
  { nummer: "4210", bezeichnung: "Miete", art: "Aufwand", steuersatz: 0 },
  { nummer: "4530", bezeichnung: "Laufende Kfz-Betriebskosten", art: "Aufwand", steuersatz: 19, bu: "9" },
  { nummer: "4920", bezeichnung: "Telefon", art: "Aufwand", steuersatz: 19, bu: "9" },
  { nummer: "4930", bezeichnung: "Bürobedarf", art: "Aufwand", steuersatz: 19, bu: "9" },
  { nummer: "4950", bezeichnung: "Rechts- und Beratungskosten", art: "Aufwand", steuersatz: 19, bu: "9" },
  { nummer: "8120", bezeichnung: "Steuerfreie Umsätze § 4 UStG", art: "Ertrag", steuersatz: 0 },
  { nummer: "8300", bezeichnung: "Erlöse 7 % USt", art: "Ertrag", steuersatz: 7, automatik: true },
  { nummer: "8400", bezeichnung: "Erlöse 19 % USt", art: "Ertrag", steuersatz: 19, automatik: true },
  { nummer: "4970", bezeichnung: "Nebenkosten des Geldverkehrs", art: "Aufwand", steuersatz: 0 },
];

const VORLAGEN = { "04": SKR04, "03": SKR03 };

/**
 * Steuerschluessel ("BU-Schluessel") von DATEV. Nur die allgemeinen, die in
 * jedem Kontenrahmen gleich bedeuten. Alles Weitere - Reverse Charge,
 * innergemeinschaftlicher Erwerb, § 13b - traegt der Steuerberater nach; die
 * Faelle sind zu selten und zu folgenreich, um sie hier zu raten.
 */
const STEUERSCHLUESSEL = [
  { wert: "", bezeichnung: "kein Schlüssel (Konto rechnet selbst)" },
  { wert: "2", bezeichnung: "Umsatzsteuer 7 %" },
  { wert: "3", bezeichnung: "Umsatzsteuer 19 %" },
  { wert: "8", bezeichnung: "Vorsteuer 7 %" },
  { wert: "9", bezeichnung: "Vorsteuer 19 %" },
];

/**
 * Nummernkreise der Personenkonten.
 *
 * Bei vierstelligen Sachkonten sind Debitoren und Kreditoren fuenfstellig -
 * so trennt DATEV sie voneinander. Bei laengeren Sachkonten verschiebt sich
 * der Kreis entsprechend mit.
 */
function personenkonten(sachkontenlaenge) {
  const laenge = Math.max(4, Math.min(8, Number(sachkontenlaenge) || 4)) + 1;
  const zehn = Math.pow(10, laenge - 1);
  return {
    laenge,
    debitor: { von: zehn, bis: zehn * 7 - 1 },       // 10000 - 69999
    kreditor: { von: zehn * 7, bis: zehn * 10 - 1 }, // 70000 - 99999
  };
}

module.exports = { VORLAGEN, SKR03, SKR04, STEUERSCHLUESSEL, personenkonten };
