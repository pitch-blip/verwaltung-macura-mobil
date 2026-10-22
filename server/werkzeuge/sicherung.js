"use strict";
/**
 * Sicherung des gesamten Bestands.
 *
 * Die Datenbank wird nicht einfach kopiert: Bei laufendem Server stehen
 * Aenderungen zum Teil noch in der WAL-Datei daneben, eine blosse Kopie waere
 * unvollstaendig. "VACUUM INTO" erzeugt stattdessen eine in sich stimmige
 * Momentaufnahme - ohne den Server anzuhalten.
 *
 * Aufruf:  npm run sicherung
 *          npm run sicherung -- E:\Sicherungen      (anderer Zielort)
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const WURZEL = path.join(__dirname, "..");
const DATEN = path.join(WURZEL, "daten");
const DB = path.join(DATEN, "verwaltung.db");
const DATEIEN = path.join(DATEN, "dateien");
const SCHLUESSEL = path.join(DATEN, "schluessel.bin");
const BUCHHALTUNG = path.join(DATEN, "buchhaltung");

const konf = (() => { try { return require("../konfiguration"); } catch { return {}; } })();

/** Zielort: Aufrufparameter vor Konfiguration vor Standard. */
function zielOrdner() {
  const ausAufruf = process.argv[2];
  if (ausAufruf) return path.resolve(ausAufruf);
  if (konf.sicherungsziel) return path.resolve(konf.sicherungsziel);
  return path.join(os.homedir(), "Verwaltung-Mobil-Sicherungen");
}

function zeitstempel() {
  const d = new Date();
  const z = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}-${z(d.getMinutes())}`;
}

function groesse(p) {
  let summe = 0;
  const gehe = (o) => {
    for (const e of fs.readdirSync(o, { withFileTypes: true })) {
      const v = path.join(o, e.name);
      if (e.isDirectory()) gehe(v); else summe += fs.statSync(v).size;
    }
  };
  if (fs.existsSync(p)) gehe(p);
  return summe;
}
const mb = (bytes) => (bytes / 1048576).toFixed(1) + " MB";

/** Warnt, wenn der Zielort die Sicherung wertlos machen wuerde. */
function zielPruefen(ziel) {
  const hinweise = [];
  const quelleLaufwerk = path.parse(path.resolve(DATEN)).root.toLowerCase();
  const zielLaufwerk = path.parse(ziel).root.toLowerCase();

  if (zielLaufwerk === quelleLaufwerk) {
    hinweise.push(
      "Ziel liegt auf demselben Laufwerk wie die Anwendung. Gegen versehentliches\n" +
      "  Loeschen hilft das, gegen Festplattenschaden, Diebstahl oder Verschluesselungs-\n" +
      "  trojaner nicht. Bitte regelmaessig auf ein externes Medium kopieren.");
  }
  const wolke = [process.env.OneDrive, process.env.OneDriveCommercial, process.env.OneDriveConsumer]
    .filter(Boolean).map((p) => path.resolve(p).toLowerCase());
  if (wolke.some((w) => ziel.toLowerCase().startsWith(w))) {
    hinweise.push(
      "Ziel liegt innerhalb von OneDrive. Die Akten wuerden damit in die Cloud\n" +
      "  synchronisiert - das war ausdruecklich nicht gewollt. Bitte anderen Ort waehlen.");
  }
  return hinweise;
}

function sichern() {
  if (!fs.existsSync(DB)) {
    console.error("\nEs gibt noch keine Datenbank. Zuerst die Anwendung starten.\n");
    process.exit(1);
  }

  const ziel = zielOrdner();
  const ordner = path.join(ziel, "verwaltung_" + zeitstempel());
  fs.mkdirSync(ordner, { recursive: true });

  console.log("\nSicherung");
  console.log("  Ziel: " + ordner + "\n");

  // 1 - Datenbank als stimmige Momentaufnahme
  const zielDb = path.join(ordner, "verwaltung.db");
  const db = new DatabaseSync(DB, { readOnly: true });
  try {
    db.exec("VACUUM INTO '" + zielDb.split(path.sep).join("/") + "'");
  } finally {
    db.close();
  }
  console.log("  Datenbank gesichert (" + mb(fs.statSync(zielDb).size) + ")");

  // 2 - hochgeladene Dokumente
  let anzahlDateien = 0;
  if (fs.existsSync(DATEIEN)) {
    fs.cpSync(DATEIEN, path.join(ordner, "dateien"), { recursive: true });
    const zaehle = (o) => fs.readdirSync(o, { withFileTypes: true })
      .reduce((n, e) => n + (e.isDirectory() ? zaehle(path.join(o, e.name)) : 1), 0);
    anzahlDateien = zaehle(DATEIEN);
  }
  console.log("  Dokumente gesichert: " + anzahlDateien + " Datei(en), " + mb(groesse(DATEIEN)));

  // 3 - Uebergabepakete an den Steuerberater. Sie gehoeren zu den
  //     Buchfuehrungsunterlagen und sind aufzubewahren: Aus ihnen laesst sich
  //     belegen, was wann in welcher Fassung an die Kanzlei ging.
  let anzahlPakete = 0;
  if (fs.existsSync(BUCHHALTUNG)) {
    fs.cpSync(BUCHHALTUNG, path.join(ordner, "buchhaltung"), { recursive: true });
    const zaehle = (o) => fs.readdirSync(o, { withFileTypes: true })
      .reduce((n, e) => n + (e.isDirectory() ? zaehle(path.join(o, e.name)) : 1), 0);
    anzahlPakete = zaehle(BUCHHALTUNG);
    console.log("  Uebergabepakete gesichert: " + anzahlPakete + " Datei(en), " + mb(groesse(BUCHHALTUNG)));
  }

  // 4 - Schluessel. Ohne ihn liesse sich das Postfach-Passwort nach einer
  //     Wiederherstellung nicht mehr entschluesseln.
  if (fs.existsSync(SCHLUESSEL)) {
    fs.copyFileSync(SCHLUESSEL, path.join(ordner, "schluessel.bin"));
    console.log("  Schluesseldatei gesichert");
  }

  // 5 - Gegenprobe: laesst sich die Sicherung oeffnen und stimmen die Zahlen?
  const p = new DatabaseSync(zielDb, { readOnly: true });
  let zahlen;
  try {
    const z = (t) => p.prepare("SELECT COUNT(*) n FROM " + t).get().n;
    // Mahnungen gibt es erst, seit das Mahnwesen dazugehoert - eine
    // Sicherung aelterer Staende soll daran nicht scheitern.
    const zFalls = (t) => { try { return z(t); } catch (e) { return 0; } };
    zahlen = { firmen: z("firmen"), personen: z("personen"), dokumente: z("dokumente"),
      benutzer: z("benutzer"), historie: z("historie"),
      belege: z("buch_belege"), uebergaben: z("buch_exporte"),
      mahnungen: zFalls("buch_mahnungen"), rechnungen: zFalls("buch_rechnungen") };
  } finally {
    p.close();
  }
  console.log("\n  Gegengeprueft: " + zahlen.firmen + " Firma/Firmen, " + zahlen.personen + " Personen, " +
    zahlen.dokumente + " Dokumente, " + zahlen.benutzer + " Benutzer, " + zahlen.historie + " Historieneintraege, " +
    zahlen.belege + " Buchungen, " + zahlen.uebergaben + " Uebergaben, " +
    zahlen.mahnungen + " Mahnungen, " + zahlen.rechnungen + " Rechnungen");

  // 6 - Beipackzettel, damit auch in einem Jahr klar ist, was das hier ist
  fs.writeFileSync(path.join(ordner, "LIESMICH.txt"),
    "Sicherung der Verwaltungsanwendung\n" +
    "erstellt am " + new Date().toLocaleString("de-DE") + "\n\n" +
    "Inhalt\n" +
    "  verwaltung.db    alle Datensaetze (Personen, Dokumente, Rechte, Historie)\n" +
    "  dateien/         die hochgeladenen Dokumente\n" +
    (anzahlPakete ? "  buchhaltung/     die Uebergabepakete an den Steuerberater\n" : "") +
    (fs.existsSync(SCHLUESSEL) ? "  schluessel.bin   entschluesselt das gespeicherte Postfach-Passwort\n" : "") +
    "\nStand\n" +
    "  " + zahlen.firmen + " Firma/Firmen, " + zahlen.personen + " Personen, " +
    zahlen.dokumente + " Dokumente, " + zahlen.benutzer + " Benutzer\n" +
    "  " + zahlen.belege + " Buchungen, " + zahlen.uebergaben + " Uebergaben an den Steuerberater\n" +
    "  " + zahlen.mahnungen + " Mahnungen, " + zahlen.rechnungen + " Rechnungen\n\n" +
    "Wiederherstellen\n" +
    "  1. Anwendung beenden.\n" +
    "  2. Den Ordner server/daten der Anwendung umbenennen (nicht loeschen -\n" +
    "     falls doch noch etwas daraus gebraucht wird).\n" +
    "  3. server/daten neu anlegen und den Inhalt dieser Sicherung hineinkopieren:\n" +
    "     verwaltung.db, die Ordner dateien und buchhaltung und gegebenenfalls\n" +
    "     schluessel.bin.\n" +
    "  4. Anwendung starten und stichprobenartig pruefen, ob die Akten da sind.\n\n" +
    "Diese Sicherung enthaelt Personal- und Kundendaten.\n" +
    "Entsprechend aufbewahren: nicht offen herumliegen lassen, Datentraeger moeglichst\n" +
    "verschluesseln, und alte Staende vernichten statt nur zu loeschen.\n", "utf8");

  // 6 - Hinweise zum Zielort
  const hinweise = zielPruefen(ziel);
  if (hinweise.length) {
    console.log("");
    for (const h of hinweise) console.log("  Hinweis: " + h);
  }

  // 7 - Uebersicht der vorhandenen Staende
  const staende = fs.readdirSync(ziel, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith("verwaltung_"))
    .map((e) => e.name).sort();
  const ohnePraefix = (name) => name.replace(/^verwaltung_/, "");
  console.log("\n  Vorhandene Staende: " + staende.length +
    (staende.length > 1 ? "  (aeltester: " + ohnePraefix(staende[0]) + ")" : ""));
  if (staende.length >= 20) {
    console.log("  Es sammeln sich viele Staende an - aeltere gelegentlich entfernen.");
  }

  console.log("\nFertig.\n");
}

try {
  sichern();
} catch (e) {
  console.error("\nSicherung fehlgeschlagen: " + (e && e.message ? e.message : e));
  console.error("Es wurde moeglicherweise ein unvollstaendiger Ordner angelegt - bitte pruefen.\n");
  process.exit(1);
}
