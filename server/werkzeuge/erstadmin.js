"use strict";
/**
 * Erstinbetriebnahme: legt die erste Firma und den ersten Administrator an.
 *
 * Laeuft bewusst nur auf der Kommandozeile - wer diesen Rechner bedient, hat
 * ohnehin Zugriff auf die Datenbankdatei. Ueber das Netz gibt es keinen Weg,
 * sich selbst zum Administrator zu machen.
 *
 * Alle Eingaben laufen ueber dieselbe readline-Schnittstelle. Ein zweiter,
 * eigener Empfaenger auf stdin waere fatal: readline haelt die Eingabe, der
 * zweite Empfaenger bekaeme nie etwas und das Skript bliebe stumm stehen.
 * Das Passwort wird stattdessen durch Stummschalten der Ausgabe verborgen.
 */

const readline = require("readline");
const { Writable } = require("stream");
const { db, firmaAnlegen } = require("../lib/db");
const auth = require("../lib/auth");

const zustand = { stumm: false };

// Ausgabekanal, der sich voruebergehend stummschalten laesst.
const ausgabe = new Writable({
  write(stueck, kodierung, fertig) {
    if (!zustand.stumm) process.stdout.write(stueck, kodierung);
    fertig();
  },
});

// terminal nur bei echter Tastatureingabe. Bei umgeleiteter Eingabe (Skript,
// Pipe) wuerde readline sonst alle Zeilen auf einmal verschlucken - und es gibt
// dort auch nichts zu verbergen, weil nichts angezeigt wird.
const amTerminal = process.stdin.isTTY === true;
const rl = readline.createInterface({
  input: process.stdin,
  output: amTerminal ? ausgabe : undefined,
  terminal: amTerminal,
});

/*
 * Zeilen werden gepuffert, statt sie mit rl.question() einzeln abzuholen:
 * question() faengt nur die naechste Zeile, und bei umgeleiteter Eingabe treffen
 * alle Zeilen praktisch gleichzeitig ein - die spaeteren gingen dabei verloren.
 */
const gepuffert = [];
const wartende = [];
let eingabeZuEnde = false;

rl.on("line", (zeile) => {
  if (wartende.length) wartende.shift()(zeile);
  else gepuffert.push(zeile);
});
rl.on("close", () => {
  eingabeZuEnde = true;
  while (wartende.length) wartende.shift()(null);
});

function naechsteZeile() {
  return new Promise((fertig) => {
    if (gepuffert.length) return fertig(gepuffert.shift());
    if (eingabeZuEnde) return fertig(null);
    wartende.push(fertig);
  });
}

async function frage(text) {
  process.stdout.write(text);
  const zeile = await naechsteZeile();
  if (zeile === null) abbruch("Eingabe unerwartet beendet. Es wurde nichts angelegt.");
  return String(zeile).trim();
}

/** Wie frage(), nur dass die Eingabe am Terminal nicht sichtbar wird. */
async function fragePasswort(text) {
  process.stdout.write(text);
  zustand.stumm = amTerminal;
  const zeile = await naechsteZeile();
  zustand.stumm = false;
  if (amTerminal) process.stdout.write("\n");
  if (zeile === null) abbruch("Eingabe unerwartet beendet. Es wurde nichts angelegt.");
  return String(zeile);
}

function abbruch(nachricht) {
  console.error("\n" + nachricht + "\n");
  rl.close();
  process.exit(1);
}

(async () => {
  console.log("\nVerwaltung - Erstinbetriebnahme\n");

  const vorhandene = db.prepare("SELECT COUNT(*) n FROM benutzer").get().n;
  if (vorhandene > 0) {
    console.log("Es sind bereits Benutzer angelegt.");
    const weiter = await frage("Trotzdem eine weitere Firma mit Administrator anlegen? (j/n) ");
    if (weiter.toLowerCase() !== "j") { console.log("Abgebrochen.\n"); rl.close(); return; }
  }

  const firmenName = await frage("Name der Firma: ");
  if (!firmenName) abbruch("Ohne Namen der Firma geht es nicht.");

  const anmeldename = await frage("Anmeldename des Administrators: ");
  if (!anmeldename) abbruch("Ohne Anmeldenamen geht es nicht.");

  let passwort = null;
  for (let versuch = 1; versuch <= 5; versuch++) {
    const eingabe = await fragePasswort("Passwort (mind. 10 Zeichen, 3 von 4 Zeichenarten): ");
    const fehler = auth.passwortPruefen(eingabe);
    if (fehler) { console.log("  " + fehler); continue; }
    const wiederholung = await fragePasswort("Passwort wiederholen: ");
    if (eingabe !== wiederholung) { console.log("  Die Eingaben stimmen nicht ueberein."); continue; }
    passwort = eingabe;
    break;
  }
  if (!passwort) abbruch("Zu viele Fehlversuche. Es wurde nichts angelegt.");

  const firmaId = firmaAnlegen(firmenName);
  auth.benutzerAnlegen({ firmaId, anmeldename, passwort, appRolle: "Administrator", wechseln: false });

  console.log(`\nFirma "${firmenName}" angelegt.`);
  console.log(`Administrator "${anmeldename}" eingerichtet.`);
  console.log('\nJetzt "npm start" ausfuehren und http://localhost:8082 aufrufen.\n');
  rl.close();
})().catch((e) => {
  console.error("\nFehlgeschlagen: " + (e && e.message ? e.message : e) + "\n");
  rl.close();
  process.exit(1);
});
