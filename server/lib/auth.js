"use strict";
/**
 * Anmeldung und Sitzungen - vollstaendig in dieser Anwendung.
 *
 * Grundsaetze:
 *  - Das Passwort wird nie gespeichert und nie protokolliert. Abgelegt wird ein
 *    scrypt-Abdruck mit eigenem Zufallssalz je Benutzer.
 *  - Vergleiche laufen zeitkonstant, damit sich ein Abdruck nicht ueber die
 *    Antwortdauer erraten laesst.
 *  - Falsche Anmeldeversuche sperren den Zugang zunehmend laenger. Ohne Bremse
 *    liesse sich ein schwaches Passwort in Minuten durchprobieren.
 *  - Die Sitzungskennung liegt in einem httpOnly-Cookie: JavaScript im Browser
 *    kommt nicht daran, ein eingeschleustes Skript kann sie also nicht auslesen.
 */

const crypto = require("crypto");
const { db } = require("./db");

const SCRYPT = { N: 16384, r: 8, p: 1, laenge: 64 };
const SITZUNG_STUNDEN = 12;
const MAX_FEHLVERSUCHE = 5;

function salzErzeugen() { return crypto.randomBytes(16).toString("hex"); }

function abdruck(passwort, salz) {
  return crypto.scryptSync(passwort.normalize("NFKC"), salz, SCRYPT.laenge,
    { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }).toString("hex");
}

function passwortSetzen(passwort) {
  const salz = salzErzeugen();
  return { salz, passwort_abdruck: abdruck(passwort, salz) };
}

function passwortStimmt(passwort, salz, erwartet) {
  let berechnet;
  try { berechnet = abdruck(passwort, salz); } catch { return false; }
  const a = Buffer.from(berechnet, "hex");
  const b = Buffer.from(erwartet, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Mindestanforderungen. Bewusst schlicht gehalten, dafuer eine echte Laenge. */
function passwortPruefen(passwort) {
  if (typeof passwort !== "string" || passwort.length < 10) {
    return "Das Passwort muss mindestens 10 Zeichen lang sein.";
  }
  if (passwort.length > 200) return "Das Passwort ist zu lang.";
  const arten = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((r) => r.test(passwort)).length;
  if (arten < 3) {
    return "Bitte mindestens drei der vier Arten verwenden: Kleinbuchstaben, Grossbuchstaben, Ziffern, Sonderzeichen.";
  }
  return null;
}

/* --------------------------------------------------------------- Sitzungen */

function sitzungAnlegen(benutzerId) {
  const id = crypto.randomBytes(32).toString("base64url");
  const ab = new Date(Date.now() + SITZUNG_STUNDEN * 3600 * 1000).toISOString();
  db.prepare("INSERT INTO sitzungen (id, benutzer_id, laeuft_ab) VALUES (?,?,?)").run(id, benutzerId, ab);
  return id;
}

function sitzungLesen(id) {
  if (!id) return null;
  db.prepare("DELETE FROM sitzungen WHERE laeuft_ab < ?").run(new Date().toISOString());
  const s = db.prepare(`
    SELECT s.id, s.benutzer_id, b.firma_id, b.anmeldename, b.app_rolle, b.aktiv,
           b.passwort_wechseln, b.person_id
      FROM sitzungen s JOIN benutzer b ON b.id = s.benutzer_id
     WHERE s.id = ? AND s.laeuft_ab > ?`).get(id, new Date().toISOString());
  if (!s || !s.aktiv) return null;
  return s;
}

function sitzungBeenden(id) {
  if (id) db.prepare("DELETE FROM sitzungen WHERE id = ?").run(id);
}
function sitzungenBeendenFuer(benutzerId) {
  db.prepare("DELETE FROM sitzungen WHERE benutzer_id = ?").run(benutzerId);
}

/* --------------------------------------------------------------- Anmelden */

/**
 * Prueft Anmeldename und Passwort. Die Rueckmeldung unterscheidet bewusst nicht
 * zwischen "Benutzer unbekannt" und "Passwort falsch" - sonst liesse sich
 * herausfinden, welche Anmeldenamen existieren.
 */
function anmelden(anmeldename, passwort, firmaId) {
  const name = String(anmeldename || "").trim().toLowerCase();
  const b = firmaId
    ? db.prepare("SELECT * FROM benutzer WHERE lower(anmeldename) = ? AND firma_id = ?").get(name, firmaId)
    : db.prepare("SELECT * FROM benutzer WHERE lower(anmeldename) = ?").get(name);

  if (!b) {
    // Gleicher Zeitaufwand wie bei vorhandenem Benutzer, damit die Antwortdauer
    // nichts verraet.
    abdruck(String(passwort || ""), "platzhalter");
    return { fehler: "Anmeldename oder Passwort ist falsch." };
  }
  if (!b.aktiv) return { fehler: "Dieser Zugang ist gesperrt." };
  if (b.gesperrt_bis && b.gesperrt_bis > new Date().toISOString()) {
    return { fehler: "Zu viele Fehlversuche. Bitte spaeter erneut versuchen." };
  }
  if (!passwortStimmt(String(passwort || ""), b.salz, b.passwort_abdruck)) {
    const versuche = b.fehlversuche + 1;
    let bis = null;
    if (versuche >= MAX_FEHLVERSUCHE) {
      // 5 Fehlversuche -> 1 Minute, danach verdoppelnd bis maximal 30 Minuten.
      const minuten = Math.min(30, Math.pow(2, versuche - MAX_FEHLVERSUCHE));
      bis = new Date(Date.now() + minuten * 60000).toISOString();
    }
    db.prepare("UPDATE benutzer SET fehlversuche = ?, gesperrt_bis = ? WHERE id = ?").run(versuche, bis, b.id);
    return { fehler: "Anmeldename oder Passwort ist falsch." };
  }

  db.prepare("UPDATE benutzer SET fehlversuche = 0, gesperrt_bis = NULL, letzte_anmeldung = ? WHERE id = ?")
    .run(new Date().toISOString(), b.id);
  return { benutzer: b, sitzung: sitzungAnlegen(b.id) };
}

function benutzerAnlegen({ firmaId, anmeldename, passwort, appRolle, personId, wechseln = true }) {
  const fehler = passwortPruefen(passwort);
  if (fehler) throw Object.assign(new Error(fehler), { status: 400 });
  const { salz, passwort_abdruck } = passwortSetzen(passwort);
  try {
    return db.prepare(`INSERT INTO benutzer
      (firma_id, anmeldename, passwort_abdruck, salz, person_id, app_rolle, passwort_wechseln)
      VALUES (?,?,?,?,?,?,?)`)
      .run(firmaId, String(anmeldename).trim(), passwort_abdruck, salz, personId || null, appRolle, wechseln ? 1 : 0)
      .lastInsertRowid;
  } catch (e) {
    if (String(e.message).includes("UNIQUE")) {
      throw Object.assign(new Error("Dieser Anmeldename ist in dieser Firma bereits vergeben."), { status: 409 });
    }
    throw e;
  }
}

function passwortAendern(benutzerId, neuesPasswort, wechselnNoetig = false) {
  const fehler = passwortPruefen(neuesPasswort);
  if (fehler) throw Object.assign(new Error(fehler), { status: 400 });
  const { salz, passwort_abdruck } = passwortSetzen(neuesPasswort);
  db.prepare("UPDATE benutzer SET passwort_abdruck = ?, salz = ?, passwort_wechseln = ?, fehlversuche = 0, gesperrt_bis = NULL WHERE id = ?")
    .run(passwort_abdruck, salz, wechselnNoetig ? 1 : 0, benutzerId);
  // Andere Sitzungen desselben Benutzers werden ungueltig - wichtig, falls das
  // Passwort geaendert wird, weil es in fremde Haende geraten ist.
  sitzungenBeendenFuer(benutzerId);
}

module.exports = {
  anmelden, benutzerAnlegen, passwortAendern, passwortPruefen, passwortStimmt,
  sitzungAnlegen, sitzungLesen, sitzungBeenden, sitzungenBeendenFuer, SITZUNG_STUNDEN,
};
