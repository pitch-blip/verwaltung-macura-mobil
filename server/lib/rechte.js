"use strict";
/**
 * Rechtepruefung. Einzige Stelle, an der entschieden wird, wer was sieht -
 * es gibt keine zweite Sperre dahinter. Im Zweifel wird verweigert.
 */

const { db } = require("./db");

const APP_ROLLEN = ["Administrator", "Geschaeftsfuehrung", "Verwaltung", "Einsatzleitung", "Mitarbeiter", "Extern"];

/*
 * "buchhaltung" steht bewusst nur drei Rollen offen. In den Belegen stehen
 * Umsaetze, Gehaelter und Bankverbindungen des Unternehmens - das geht weder
 * die Einsatzleitung noch einzelne Mitarbeiter etwas an. Wer erfassen darf,
 * darf auch an den Steuerberater uebergeben: Beides gehoert zum selben Vorgang.
 */
const MATRIX = {
  Administrator:      { lesen: "*", schreiben: "*", alleDokumente: true, verwaltet: true, versendet: true },
  // "menuepunkte" darf jede Rolle lesen - es sind nur Beschriftungen der
  // Seitenleiste. Was dahinter sichtbar wird, entscheidet weiterhin die
  // Rechtepruefung an den Dokumenten selbst.
  Geschaeftsfuehrung: { lesen: ["personen","organisationen","kategorien","dokumente","historie","zugriffsrechte","design","benutzer","menuepunkte","buchhaltung"],
                        schreiben: [], alleDokumente: true, versendet: true },
  Verwaltung:         { lesen: ["personen","organisationen","kategorien","dokumente","historie","design","menuepunkte","buchhaltung"],
                        schreiben: ["personen","organisationen","dokumente","buchhaltung"], alleDokumente: true, versendet: true },
  Einsatzleitung:     { lesen: ["personen","kategorien","dokumente","design","menuepunkte"],
                        schreiben: [], alleDokumente: false, versendet: false },
  // "personen" ist noetig, damit die eigene Akte ueberhaupt angezeigt werden
  // kann; sichtbarePersonen() beschraenkt die Liste auf die eigene Person.
  Mitarbeiter:        { lesen: ["personen","kategorien","dokumente","design","menuepunkte"],
                        schreiben: [], alleDokumente: false, versendet: false, nurEigeneAkte: true },
  Extern:             { lesen: ["personen","dokumente","design","menuepunkte"],
                        schreiben: [], alleDokumente: false, versendet: false, nurEigeneAkte: true },
};

class Verweigert extends Error {
  constructor(nachricht, status = 403) { super(nachricht); this.status = status; }
}

function regeln(rolle) { return MATRIX[rolle] || null; }
function darfLesen(s, was) { return s.regeln.lesen === "*" || s.regeln.lesen.includes(was); }
function darfSchreiben(s, was) { return s.regeln.schreiben === "*" || s.regeln.schreiben.includes(was); }
function fordereLesen(s, was) { if (!darfLesen(s, was)) throw new Verweigert(`Kein Leserecht fuer "${was}".`); }
function fordereSchreiben(s, was) { if (!darfSchreiben(s, was)) throw new Verweigert(`Kein Schreibrecht fuer "${was}".`); }
function fordereAdmin(s) { if (s.appRolle !== "Administrator") throw new Verweigert("Nur Administratoren duerfen das."); }

/**
 * Kategorien, die dieser Benutzer lesen darf - samt aller untergeordneten.
 * Ein Recht auf "Vertragsunterlagen" gilt damit auch fuer "Arbeitsvertrag",
 * ohne dass es dort einzeln eingetragen werden muss.
 * Rueckgabe null bedeutet: keine Einschraenkung.
 */
function erlaubteKategorien(sitzung) {
  if (sitzung.regeln.alleDokumente) return null;

  const heute = new Date().toISOString().slice(0, 10);
  const direkt = db.prepare(`
    SELECT kategorie_id, rechte FROM zugriffsrechte
     WHERE benutzer_id = ? AND status = 'aktiv'
       AND (gueltig_bis IS NULL OR gueltig_bis >= ?)`).all(sitzung.benutzerId, heute);

  const start = [];
  for (const r of direkt) {
    let rechte = [];
    try { rechte = JSON.parse(r.rechte); } catch { rechte = []; }
    if (rechte.includes("Lesen") || rechte.includes("Bearbeiten")) start.push(String(r.kategorie_id));
  }

  const kinder = new Map();
  for (const k of db.prepare("SELECT id, eltern_id FROM kategorien WHERE firma_id = ?").all(sitzung.firmaId)) {
    if (!k.eltern_id) continue;
    const schluessel = String(k.eltern_id);
    if (!kinder.has(schluessel)) kinder.set(schluessel, []);
    kinder.get(schluessel).push(String(k.id));
  }

  const erlaubt = new Set();
  const stapel = start.slice();
  while (stapel.length) {
    const id = stapel.pop();
    if (erlaubt.has(id)) continue;
    erlaubt.add(id);
    for (const kind of kinder.get(id) || []) stapel.push(kind);
  }
  return erlaubt;
}

/** Filtert eine Dokumentliste auf das, was der Benutzer sehen darf. */
function sichtbareDokumente(sitzung, zeilen) {
  const erlaubt = erlaubteKategorien(sitzung);
  if (erlaubt === null) return zeilen;
  return zeilen.filter((d) => {
    if (sitzung.regeln.nurEigeneAkte && sitzung.personId && d.person_id === sitzung.personId) return true;
    return erlaubt.has(String(d.kategorie_id));
  });
}

function fordereDokumentZugriff(sitzung, dokument) {
  const erlaubt = erlaubteKategorien(sitzung);
  if (erlaubt === null) return;
  if (sitzung.regeln.nurEigeneAkte && sitzung.personId && dokument.person_id === sitzung.personId) return;
  if (erlaubt.has(String(dokument.kategorie_id))) return;
  throw new Verweigert("Kein Zugriff auf dieses Dokument.");
}

/** Sichtbare Personen: wer nur die eigene Akte sehen darf, sieht auch nur sich. */
function sichtbarePersonen(sitzung, zeilen) {
  if (!sitzung.regeln.nurEigeneAkte) return zeilen;
  return zeilen.filter((p) => p.id === sitzung.personId);
}

module.exports = {
  APP_ROLLEN, MATRIX, Verweigert, regeln,
  darfLesen, darfSchreiben, fordereLesen, fordereSchreiben, fordereAdmin,
  erlaubteKategorien, sichtbareDokumente, sichtbarePersonen, fordereDokumentZugriff,
};
