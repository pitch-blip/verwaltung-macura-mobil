"use strict";
/**
 * Der Server der Verwaltungsplattform.
 *
 * Liefert die Oberflaeche aus und beantwortet deren Anfragen. Es gibt keine
 * Verbindung nach aussen: keine Cloud, kein Verzeichnisdienst, keine Abfrage
 * bei einer anderen Stelle. Alles liegt in daten/.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { db, firmaAnlegen } = require("./lib/db");
const auth = require("./lib/auth");
const R = require("./lib/rechte");
const api = require("./lib/api");
const buch = require("./lib/buchhaltung");
const mahn = require("./lib/mahnwesen");
const rg = require("./lib/rechnung");
const uebergabe = require("./lib/uebergabe");
const bank = require("./lib/bank");
const op = require("./lib/offeneposten");
const regeln = require("./lib/regeln");

const konf = require("./konfiguration");

// 8082: So kann diese Verwaltung auf demselben Rechner neben den anderen
// (8080, 8081) laufen, ohne dass sie sich in die Quere kommen.
const PORT = Number(process.env.PORT || 8082);
const NUR_LOKAL = process.env.OFFEN !== "1";
const HINTER_TLS = process.env.TLS === "1";
const OBERFLAECHE = path.resolve(__dirname, "..");
// Eingescannte Unterlagen werden schnell gross - mehrseitige Farbscans liegen
// oft ueber 25 MB. Bei Ueberschreitung antwortet der Server mit 413.
const MAX_UPLOAD = 50 * 1024 * 1024;
const OHNE_ANMELDUNG = konf.anmeldung === "keine";
// Browser trennen Cookies nicht nach Port. Mit einem eigenen Namen ueberschreibt
// die Anmeldung hier nicht die einer anderen Verwaltung auf demselben Rechner.
const SITZUNGS_COOKIE = "sitzung_mobil";

// Ohne Anmeldung darf die Anwendung den Rechner nicht verlassen. Sonst haette
// jeder im Netz vollen Zugriff auf Personal- und Kundenakten - eine Kombination,
// die es gar nicht erst geben soll.
if (OHNE_ANMELDUNG && !NUR_LOKAL) {
  console.error("\nAbbruch: In der Betriebsart \"keine\" (ohne Anmeldung) darf OFFEN=1 nicht gesetzt sein.");
  console.error("Entweder in konfiguration.js auf \"passwort\" umstellen, oder OFFEN weglassen.\n");
  process.exit(1);
}

const TYPEN = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".ico": "image/x-icon", ".json": "application/json; charset=utf-8" };

/* ------------------------------------------------------------------ Hilfen */

function antwort(res, status, koerper, kopf = {}) {
  const daten = Buffer.isBuffer(koerper) ? koerper : Buffer.from(JSON.stringify(koerper ?? null), "utf8");
  res.writeHead(status, Object.assign({
    "Content-Type": Buffer.isBuffer(koerper) ? "application/octet-stream" : "application/json; charset=utf-8",
    "Content-Length": daten.length,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
  }, kopf));
  res.end(daten);
}

function cookieLesen(req, name) {
  const roh = req.headers.cookie || "";
  for (const teil of roh.split(";")) {
    const [k, ...rest] = teil.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function cookieSetzen(name, wert, sekunden) {
  const teile = [`${name}=${encodeURIComponent(wert)}`, "Path=/", "HttpOnly", "SameSite=Strict",
    `Max-Age=${sekunden}`];
  if (HINTER_TLS) teile.push("Secure");
  return teile.join("; ");
}

function koerperLesen(req, grenze = MAX_UPLOAD) {
  return new Promise((fertig, fehler) => {
    const stuecke = [];
    let laenge = 0;
    req.on("data", (s) => {
      laenge += s.length;
      if (laenge > grenze) { fehler(Object.assign(new Error("Die Datei ist zu gross."), { status: 413 })); req.destroy(); return; }
      stuecke.push(s);
    });
    req.on("end", () => fertig(Buffer.concat(stuecke)));
    req.on("error", fehler);
  });
}

async function jsonLesen(req) {
  const roh = await koerperLesen(req, 8 * 1024 * 1024);
  if (!roh.length) return {};
  try { return JSON.parse(roh.toString("utf8")); }
  catch { throw Object.assign(new Error("Ungueltige Anfrage."), { status: 400 }); }
}

/**
 * Herkunftspruefung.
 *
 * Ein Dienst auf localhost ist von jeder Webseite aus ansprechbar, die im
 * Browser geoeffnet wird. Ohne Anmeldung fehlt sonst jede Huerde: eine
 * beliebige Seite koennte im Hintergrund Daten anlegen oder aendern.
 * Deshalb werden Anfragen abgewiesen, die erkennbar von anderswo kommen.
 */
function herkunftInOrdnung(req) {
  const ziel = req.headers["sec-fetch-site"];
  if (ziel && ziel !== "same-origin" && ziel !== "none") return false;

  const herkunft = req.headers.origin;
  if (herkunft) {
    let h;
    try { h = new URL(herkunft); } catch { return false; }
    const erlaubt = ["localhost", "127.0.0.1", "[::1]", "::1"];
    if (!erlaubt.includes(h.hostname) || (h.port && Number(h.port) !== PORT)) return false;
  }
  return true;
}

/** Baut aus der Sitzung das Objekt, mit dem die Rechtepruefung arbeitet. */
function sitzungAufbauen(req) {
  // Einzelplatzbetrieb: es gibt keinen Anmeldevorgang, der Zugriff ist dem
  // hinterlegten Benutzer fest zugeordnet.
  if (OHNE_ANMELDUNG) {
    const b = db.prepare("SELECT * FROM benutzer WHERE anmeldename = ? ORDER BY id LIMIT 1").get(konf.benutzername);
    if (!b) return null;
    return { sitzungId: null, benutzerId: b.id, firmaId: b.firma_id,
      anmeldename: b.anmeldename, appRolle: b.app_rolle, personId: b.person_id,
      passwortWechseln: 0, regeln: R.regeln(b.app_rolle) };
  }

  const s = auth.sitzungLesen(cookieLesen(req, SITZUNGS_COOKIE));
  if (!s) return null;
  const regeln = R.regeln(s.app_rolle);
  if (!regeln) return null;
  return { sitzungId: s.id, benutzerId: s.benutzer_id, firmaId: s.firma_id,
    anmeldename: s.anmeldename, appRolle: s.app_rolle, personId: s.person_id,
    passwortWechseln: s.passwort_wechseln, regeln };
}

/* -------------------------------------------------- Statische Oberflaeche */

function dateiAusliefern(res, pfad) {
  const voll = path.resolve(OBERFLAECHE, pfad);
  if (!voll.startsWith(OBERFLAECHE + path.sep) && voll !== OBERFLAECHE) return antwort(res, 403, { fehler: "Verboten." });
  if (!fs.existsSync(voll) || !fs.statSync(voll).isFile()) return antwort(res, 404, { fehler: "Nicht gefunden." });
  const typ = TYPEN[path.extname(voll).toLowerCase()] || "application/octet-stream";
  const daten = fs.readFileSync(voll);
  res.writeHead(200, { "Content-Type": typ, "Content-Length": daten.length, "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff" });
  res.end(daten);
}

/* ------------------------------------------------------------------ Routen */

async function api_route(req, res, teile, url) {
  const m = req.method;

  /* -- ohne Sitzung erreichbar -- */
  if (teile[0] === "anmelden" && m === "POST") {
    const d = await jsonLesen(req);
    const e = auth.anmelden(d.anmeldename, d.passwort);
    if (e.fehler) return antwort(res, 401, { fehler: e.fehler });
    api.protokoll({ firmaId: e.benutzer.firma_id, anmeldename: e.benutzer.anmeldename },
      "Zugriffsrecht", e.benutzer.anmeldename, "angemeldet", "");
    return antwort(res, 200, { ok: true },
      { "Set-Cookie": cookieSetzen(SITZUNGS_COOKIE, e.sitzung, auth.SITZUNG_STUNDEN * 3600) });
  }

  if (teile[0] === "abmelden" && m === "POST") {
    auth.sitzungBeenden(cookieLesen(req, SITZUNGS_COOKIE));
    return antwort(res, 200, { ok: true }, { "Set-Cookie": cookieSetzen(SITZUNGS_COOKIE, "", 0) });
  }

  /* -- ab hier ist eine Sitzung Pflicht -- */
  const s = sitzungAufbauen(req);
  if (!s) return antwort(res, 401, { fehler: "Nicht angemeldet." });

  // Solange ein Passwortwechsel aussteht, ist nur genau das erlaubt.
  const wechselErlaubt = teile[0] === "me" || (teile[0] === "passwort" && teile[1] === "eigen");
  if (s.passwortWechseln && !wechselErlaubt) {
    return antwort(res, 428, { fehler: "Bitte zuerst ein eigenes Passwort vergeben.", passwortWechseln: true });
  }

  if (teile[0] === "me" && m === "GET") { const a = api.ich(s); return antwort(res, a.status, a.koerper); }

  if (teile[0] === "passwort" && teile[1] === "eigen" && m === "POST") {
    const d = await jsonLesen(req);
    const a = api.eigenesPasswortAendern(s, d.alt, d.neu);
    // Passwortwechsel beendet alle Sitzungen - also gleich eine neue ausstellen.
    return antwort(res, a.status, a.koerper,
      { "Set-Cookie": cookieSetzen(SITZUNGS_COOKIE, auth.sitzungAnlegen(s.benutzerId), auth.SITZUNG_STUNDEN * 3600) });
  }

  // Firmenwechsel: nur Administratoren, und nur auf bestehende Firmen.
  if (teile[0] === "firma" && teile[1] === "wechseln" && m === "POST") {
    R.fordereAdmin(s);
    const d = await jsonLesen(req);
    const f = db.prepare("SELECT id FROM firmen WHERE id = ? AND aktiv = 1").get(d.firmaId);
    if (!f) return antwort(res, 404, { fehler: "Unbekannte Firma." });
    db.prepare("UPDATE benutzer SET firma_id = ? WHERE id = ?").run(f.id, s.benutzerId);
    return antwort(res, 200, { ok: true });
  }
  if (teile[0] === "firma" && teile[1] === "neu" && m === "POST") {
    const d = await jsonLesen(req);
    const a = api.firmaNeu(s, d.name); return antwort(res, a.status, a.koerper);
  }
  if (teile[0] === "firma" && teile[1] && /^\d+$/.test(teile[1]) && teile[2] === "name" && m === "POST") {
    const d = await jsonLesen(req);
    const a = api.firmaUmbenennen(s, teile[1], d.name); return antwort(res, a.status, a.koerper);
  }
  if (teile[0] === "firma" && teile[1] === "struktur" && m === "POST") {
    const a = api.strukturPruefen(s); return antwort(res, a.status, a.koerper);
  }

  if (teile[0] === "liste" && teile[1] && m === "GET") {
    const a = api.liste(s, teile[1]); return antwort(res, a.status, a.koerper);
  }

  if (teile[0] === "personen" && m === "POST") {
    const a = api.personSpeichern(s, teile[1] || null, await jsonLesen(req)); return antwort(res, a.status, a.koerper);
  }
  if (teile[0] === "organisationen" && m === "POST") {
    const a = api.organisationSpeichern(s, teile[1] || null, await jsonLesen(req)); return antwort(res, a.status, a.koerper);
  }
  if (teile[0] === "kategorien" && m === "POST") {
    const a = api.kategorieSpeichern(s, teile[1] || null, await jsonLesen(req)); return antwort(res, a.status, a.koerper);
  }

  if (teile[0] === "dokumente" && !teile[1] && m === "POST") {
    const felder = {
      kategorieId: req.headers["x-kategorie"], personId: req.headers["x-person"] || null,
      status: req.headers["x-status"] || "gueltig",
      gueltigAb: req.headers["x-gueltig-ab"] || null, gueltigBis: req.headers["x-gueltig-bis"] || null,
    };
    const name = decodeURIComponent(req.headers["x-dateiname"] || "Datei");
    const typ = req.headers["content-type"] || null;
    const a = api.dokumentHochladen(s, felder, { name, typ, daten: await koerperLesen(req) });
    return antwort(res, a.status, a.koerper);
  }
  if (teile[0] === "dokumente" && teile[1] && teile[2] === "version" && m === "POST") {
    const name = decodeURIComponent(req.headers["x-dateiname"] || "Datei");
    const typ = req.headers["content-type"] || null;
    const a = api.neueVersion(s, teile[1], req.headers["x-hauptversion"] === "1",
      { name, typ, daten: await koerperLesen(req) });
    return antwort(res, a.status, a.koerper);
  }
  if (teile[0] === "dokumente" && teile[1] && teile[2] === "inhalt" && m === "GET") {
    const e = api.dokumentInhalt(s, teile[1]);
    // Echter Dateityp, damit ein PDF im Betrachter oeffnet statt als
    // unbekannter Download zu landen.
    return antwort(res, 200, e.datei.daten, {
      "Content-Type": e.datei.typ || "application/octet-stream",
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(e.datei.name)}`,
      "Cache-Control": "no-store",
    });
  }
  if (teile[0] === "dokumente" && teile[1] && !teile[2] && m === "PATCH") {
    const a = api.dokumentAendern(s, teile[1], await jsonLesen(req)); return antwort(res, a.status, a.koerper);
  }

  // Wichtig: erst die spezielleren Pfade, sonst faengt diese Regel /benutzer/1/rechte mit ab.
  if (teile[0] === "benutzer" && !teile[2] && m === "POST") {
    const a = api.benutzerSpeichern(s, teile[1] || null, await jsonLesen(req)); return antwort(res, a.status, a.koerper);
  }
  if (teile[0] === "benutzer" && teile[1] && teile[2] === "passwort" && m === "POST") {
    const d = await jsonLesen(req);
    const a = api.passwortZuruecksetzen(s, teile[1], d.neu); return antwort(res, a.status, a.koerper);
  }
  if (teile[0] === "benutzer" && teile[1] && teile[2] === "rechte" && m === "POST") {
    const d = await jsonLesen(req);
    const a = api.rechteSetzen(s, teile[1], d.rechte || {}); return antwort(res, a.status, a.koerper);
  }

  if (teile[0] === "mail" && teile[1] === "einstellungen") {
    if (m === "GET") { const a = api.mailEinstellungen(s); return antwort(res, a.status, a.koerper); }
    if (m === "POST") { const a = api.mailEinstellungenSetzen(s, await jsonLesen(req)); return antwort(res, a.status, a.koerper); }
  }
  if (teile[0] === "mail" && teile[1] === "pruefen" && m === "POST") {
    const a = await api.mailPruefen(s); return antwort(res, a.status, a.koerper);
  }
  if (teile[0] === "dokumente" && teile[1] && teile[2] === "senden" && m === "POST") {
    const a = await api.dokumentSenden(s, teile[1], await jsonLesen(req)); return antwort(res, a.status, a.koerper);
  }

  if (teile[0] === "menuepunkte" && !teile[1] && m === "POST") {
    const a = api.menuepunktAnlegen(s, await jsonLesen(req)); return antwort(res, a.status, a.koerper);
  }
  if (teile[0] === "menuepunkte" && teile[1] && teile[2] === "verschieben" && m === "POST") {
    const d = await jsonLesen(req);
    const a = api.menuepunktVerschieben(s, teile[1], d.richtung); return antwort(res, a.status, a.koerper);
  }
  if (teile[0] === "menuepunkte" && teile[1] && !teile[2] && m === "DELETE") {
    const a = api.menuepunktEntfernen(s, teile[1]); return antwort(res, a.status, a.koerper);
  }

  if (teile[0] === "design" && m === "POST") {
    const d = await jsonLesen(req);
    const a = api.designSpeichern(s, d.schluessel, d.wert); return antwort(res, a.status, a.koerper);
  }

  /* ---------------------------------------------------------- Buchhaltung */

  if (teile[0] === "buchhaltung") {
    const t = teile[1], u = teile[2];

    if (t === "einstellungen" && m === "GET") {
      const a = buch.einstellungenLesen(s); return antwort(res, a.status, a.koerper);
    }
    if (t === "einstellungen" && m === "POST") {
      const a = buch.einstellungenSetzen(s, await jsonLesen(req)); return antwort(res, a.status, a.koerper);
    }

    if (t === "konten" && !u && m === "GET") return antwort(res, 200, { wert: buch.konten(s) });
    if (t === "konten" && m === "POST" && u !== "vorlage" && u !== "einlesen") {
      const a = buch.kontoSpeichern(s, u || null, await jsonLesen(req)); return antwort(res, a.status, a.koerper);
    }
    if (t === "konten" && u === "vorlage" && m === "POST") {
      const d = await jsonLesen(req);
      const a = buch.kontenVorlage(s, d.skr); return antwort(res, a.status, a.koerper);
    }
    if (t === "konten" && u === "einlesen" && m === "POST") {
      const d = await jsonLesen(req);
      const a = buch.kontenEinlesen(s, d.text); return antwort(res, a.status, a.koerper);
    }
    if (t === "konten" && u && m === "DELETE") {
      const a = buch.kontoEntfernen(s, u); return antwort(res, a.status, a.koerper);
    }

    if (t === "partner" && !u && m === "GET") return antwort(res, 200, { wert: buch.partner(s) });
    if (t === "partner" && m === "POST" && u !== "naechste") {
      const a = buch.partnerSpeichern(s, u || null, await jsonLesen(req)); return antwort(res, a.status, a.koerper);
    }
    if (t === "partner" && u === "naechste" && m === "GET") {
      R.fordereLesen(s, "buchhaltung");
      return antwort(res, 200, { konto: buch.naechsteKontonummer(s.firmaId, url.searchParams.get("typ")) });
    }

    if (t === "belege" && !u && m === "GET") {
      return antwort(res, 200, { wert: buch.belege(s, url.searchParams.get("von"), url.searchParams.get("bis")) });
    }
    // Wichtig: erst die spezielleren Pfade. Sonst faengt die Regel fuer
    // "belege/<id>" auch "belege/<id>/datei" mit ab und versucht, die
    // hochgeladene Datei als JSON zu lesen.
    if (t === "belege" && u && teile[3] === "datei" && m === "POST") {
      const name = decodeURIComponent(req.headers["x-dateiname"] || "Beleg");
      const a = buch.belegDatei(s, u, { name, typ: req.headers["content-type"] || null,
        daten: await koerperLesen(req) });
      return antwort(res, a.status, a.koerper);
    }
    if (t === "belege" && u && teile[3] === "storno" && m === "POST") {
      const d = await jsonLesen(req);
      const a = buch.belegStornieren(s, u, d.grund); return antwort(res, a.status, a.koerper);
    }
    if (t === "belege" && m === "POST" && !teile[3] && (!u || /^\d+$/.test(u))) {
      const a = buch.belegSpeichern(s, u || null, await jsonLesen(req)); return antwort(res, a.status, a.koerper);
    }

    if (t === "uebersicht" && m === "GET") {
      return antwort(res, 200, buch.uebersicht(s, url.searchParams.get("von"), url.searchParams.get("bis")));
    }
    if (t === "umsatzsteuer" && m === "GET") {
      return antwort(res, 200, buch.umsatzsteuer(s, url.searchParams.get("von"), url.searchParams.get("bis")));
    }
    if (t === "kassenbuch" && m === "GET") {
      return antwort(res, 200, buch.kassenbuch(s, url.searchParams.get("von"), url.searchParams.get("bis")));
    }
    if (t === "pruefung" && m === "GET") {
      return antwort(res, 200, buch.pruefung(s, url.searchParams.get("von"), url.searchParams.get("bis")));
    }

    /* -- Bankumsaetze -- */
    if (t === "bank" && u === "import" && m === "POST") {
      // Die Datei kommt roh; Kontonummer und Spaltenzuordnung stehen im Kopf,
      // damit der Koerper nichts als die CSV enthaelt.
      let zuordnung = null;
      try { zuordnung = JSON.parse(decodeURIComponent(req.headers["x-zuordnung"] || "null")); } catch { zuordnung = null; }
      const a = bank.importieren(s, {
        konto: req.headers["x-konto"],
        dateiname: decodeURIComponent(req.headers["x-dateiname"] || "Kontoauszug.csv"),
        zuordnung, daten: await koerperLesen(req),
      });
      return antwort(res, a.status, a.koerper);
    }
    // Wichtig: ohne !teile[3] finge diese Regel auch "/umsaetze/5/vorschlaege"
    // mit ab und lieferte statt der Vorschlaege die ganze Liste.
    if (t === "bank" && u === "umsaetze" && !teile[3] && m === "GET") {
      return antwort(res, 200, { wert: bank.umsaetze(s, {
        von: url.searchParams.get("von"), bis: url.searchParams.get("bis"),
        status: url.searchParams.get("status"), konto: url.searchParams.get("konto") }) });
    }
    if (t === "bank" && u === "beteiligte" && m === "GET") {
      return antwort(res, 200, { wert: bank.beteiligte(s) });
    }
    if (t === "bank" && u === "beteiligte" && m === "POST") {
      const d = await jsonLesen(req);
      const a = bank.beteiligteUebernehmen(s, d.liste); return antwort(res, a.status, a.koerper);
    }
    if (t === "bank" && u === "importe" && m === "GET") {
      return antwort(res, 200, { wert: bank.importe(s) });
    }
    if (t === "bank" && u === "umsaetze" && teile[3] && teile[4] === "vorschlaege" && m === "GET") {
      const a = bank.vorschlaege(s, teile[3], url.searchParams.get("partner"));
      return antwort(res, a.status, a.koerper);
    }
    if (t === "bank" && u === "umsaetze" && teile[3] && teile[4] === "buchen" && m === "POST") {
      const a = bank.buchen(s, teile[3], await jsonLesen(req)); return antwort(res, a.status, a.koerper);
    }
    if (t === "bank" && u === "umsaetze" && teile[3] && teile[4] === "ignorieren" && m === "POST") {
      const d = await jsonLesen(req);
      const a = bank.ignorieren(s, teile[3], d.grund); return antwort(res, a.status, a.koerper);
    }
    if (t === "bank" && u === "umsaetze" && teile[3] && teile[4] === "zurueck" && m === "POST") {
      const a = bank.zuruecknehmen(s, teile[3]); return antwort(res, a.status, a.koerper);
    }

    /* -- Zuordnungsregeln -- */
    if (t === "regeln" && !u && m === "GET") return antwort(res, 200, { wert: regeln.liste(s) });
    if (t === "regeln" && u === "probe" && m === "POST") {
      const a = regeln.probe(s, await jsonLesen(req)); return antwort(res, a.status, a.koerper);
    }
    if (t === "regeln" && u === "anwenden" && m === "POST") {
      const a = bank.regelnAnwenden(s); return antwort(res, a.status, a.koerper);
    }
    if (t === "regeln" && m === "POST" && u !== "probe" && u !== "anwenden") {
      const a = regeln.speichern(s, u || null, await jsonLesen(req)); return antwort(res, a.status, a.koerper);
    }
    if (t === "regeln" && u && m === "DELETE") {
      const a = regeln.entfernen(s, u); return antwort(res, a.status, a.koerper);
    }

    /* -- Offene Posten und Abstimmung -- */
    if (t === "offeneposten" && m === "GET") {
      const a = op.offenePosten(s, { stichtag: url.searchParams.get("stichtag"),
        typ: url.searchParams.get("typ") });
      return antwort(res, a.status, a.koerper);
    }
    if (t === "ausgleich" && m === "POST") {
      const a = op.ausgleichen(s, await jsonLesen(req)); return antwort(res, a.status, a.koerper);
    }
    if (t === "ausgleich" && m === "DELETE") {
      const a = op.ausgleichLoesen(s, url.searchParams.get("rechnung"), url.searchParams.get("zahlung"));
      return antwort(res, a.status, a.koerper);
    }
    if (t === "saldenabgleich" && m === "GET") {
      const a = op.saldenabgleich(s, { stichtag: url.searchParams.get("stichtag"),
        bankKonto: url.searchParams.get("konto"),
        auszugSaldoCent: url.searchParams.get("saldo") });
      return antwort(res, a.status, a.koerper);
    }

    /* -- Ausgangsrechnungen schreiben -- */
    if (t === "rechnungen" && u === "vorlagen" && m === "GET") {
      const a = rg.vorlagen(s); return antwort(res, a.status, a.koerper);
    }
    if (t === "rechnungen" && !u && m === "GET") {
      const a = rg.liste(s, { status: url.searchParams.get("status") });
      return antwort(res, a.status, a.koerper);
    }
    // Wichtig: erst die spezielleren Pfade, sonst faengt "rechnungen/<id>"
    // auch "rechnungen/<id>/bogen" mit ab.
    if (t === "rechnungen" && u && teile[3] === "bogen" && m === "GET") {
      const a = rg.bogen(s, u); return antwort(res, a.status, a.koerper);
    }
    if (t === "rechnungen" && u && teile[3] === "festschreiben" && m === "POST") {
      const a = rg.festschreiben(s, u); return antwort(res, a.status, a.koerper);
    }
    if (t === "rechnungen" && u && teile[3] === "storno" && m === "POST") {
      const d = await jsonLesen(req);
      const a = rg.stornieren(s, u, d.grund); return antwort(res, a.status, a.koerper);
    }
    if (t === "rechnungen" && u && !teile[3] && m === "GET") {
      const a = rg.einzeln(s, u); return antwort(res, a.status, a.koerper);
    }
    if (t === "rechnungen" && !teile[3] && m === "POST" && (!u || /^\d+$/.test(u))) {
      const a = rg.speichern(s, u || null, await jsonLesen(req)); return antwort(res, a.status, a.koerper);
    }
    if (t === "rechnungen" && u && m === "DELETE") {
      const a = rg.entfernen(s, u); return antwort(res, a.status, a.koerper);
    }

    /* -- Mahnwesen -- */
    if (t === "mahnwesen" && u === "vorschlaege" && m === "GET") {
      const a = mahn.vorschlaege(s, { stichtag: url.searchParams.get("stichtag") });
      return antwort(res, a.status, a.koerper);
    }
    if (t === "mahnwesen" && u === "erstellen" && m === "POST") {
      const a = mahn.erstellen(s, await jsonLesen(req)); return antwort(res, a.status, a.koerper);
    }
    if (t === "mahnwesen" && u === "stufen" && !teile[3] && m === "GET") {
      const a = mahn.stufen(s); return antwort(res, a.status, a.koerper);
    }
    if (t === "mahnwesen" && u === "stufen" && teile[3] && m === "POST") {
      const a = mahn.stufeSpeichern(s, teile[3], await jsonLesen(req)); return antwort(res, a.status, a.koerper);
    }
    if (t === "mahnwesen" && u === "basiszins" && m === "POST") {
      const a = mahn.basiszinsSetzen(s, await jsonLesen(req)); return antwort(res, a.status, a.koerper);
    }
    // Wichtig: erst die spezielleren Pfade, sonst faengt "mahnungen/<id>"
    // auch "mahnungen/<id>/brief" mit ab.
    if (t === "mahnungen" && u && teile[3] === "brief" && m === "GET") {
      const a = mahn.brief(s, u); return antwort(res, a.status, a.koerper);
    }
    if (t === "mahnungen" && u && teile[3] === "erledigt" && m === "POST") {
      const a = mahn.erledigen(s, u, await jsonLesen(req)); return antwort(res, a.status, a.koerper);
    }
    if (t === "mahnungen" && u && teile[3] === "zurueck" && m === "POST") {
      const a = mahn.zuruecknehmen(s, u, await jsonLesen(req)); return antwort(res, a.status, a.koerper);
    }
    if (t === "mahnungen" && !u && m === "GET") {
      const a = mahn.liste(s, { status: url.searchParams.get("status") });
      return antwort(res, a.status, a.koerper);
    }

    if (t === "uebergaben" && !u && m === "GET") return antwort(res, 200, { wert: uebergabe.exporte(s) });
    if (t === "uebergaben" && !u && m === "POST") {
      const a = uebergabe.erzeugen(s, await jsonLesen(req)); return antwort(res, a.status, a.koerper);
    }
    if (t === "uebergaben" && u && teile[3] === "datei" && m === "GET") {
      const p = uebergabe.paketLesen(s, u);
      // Als Download anbieten: die Datei geht weiter an die Kanzlei, sie soll
      // nicht im Browser landen.
      return antwort(res, 200, p.daten, {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(p.name)}`,
        "Cache-Control": "no-store",
      });
    }
    if (t === "uebergaben" && u && teile[3] === "senden" && m === "POST") {
      const a = await uebergabe.paketSenden(s, u, await jsonLesen(req)); return antwort(res, a.status, a.koerper);
    }
  }

  return antwort(res, 404, { fehler: "Unbekannter Aufruf." });
}

/* ------------------------------------------------------------------ Server */

async function bearbeiten(req, res) {
  const url = new URL(req.url, "http://localhost");
  const pfad = decodeURIComponent(url.pathname);

  try {
    if (pfad.startsWith("/api/")) {
      if (!herkunftInOrdnung(req)) {
        console.warn(new Date().toISOString(), "Anfrage fremder Herkunft abgewiesen:",
          req.headers.origin || req.headers["sec-fetch-site"]);
        return antwort(res, 403, { fehler: "Anfrage von fremder Herkunft." });
      }
      const teile = pfad.slice(5).split("/").filter(Boolean);
      return await api_route(req, res, teile, url);
    }
    if (req.method !== "GET") return antwort(res, 405, { fehler: "Methode nicht erlaubt." });
    return dateiAusliefern(res, pfad === "/" ? "verwaltung.html" : pfad.replace(/^\//, ""));
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(new Date().toISOString(), e);
    else console.warn(new Date().toISOString(), status, e.message);
    // Nur bei echten 500ern die Ursache verbergen. Absichtlich gesetzte Zustaende
    // wie 503 (Postfach fehlt) sind Hinweise, die der Benutzer braucht, um das
    // Problem selbst zu beheben - "Interner Fehler" waere dort nutzlos.
    if (!res.headersSent) {
      antwort(res, status, { fehler: status === 500 ? "Interner Fehler." : e.message });
    }
  }
}

// Standardmaessig nur ueber den eigenen Rechner erreichbar. Erst OFFEN=1 macht
// die Anwendung im Netz sichtbar - bewusst eine ausdrueckliche Entscheidung.
/**
 * Einzelplatz: beim ersten Start Firma und Zugang selbst anlegen. Ein Passwort
 * waere hier ohne Zweck - der Zugang haengt daran, wer den Rechner bedient.
 */
function einzelplatzEinrichten() {
  const vorhanden = db.prepare("SELECT id FROM benutzer WHERE anmeldename = ?").get(konf.benutzername);
  if (vorhanden) return false;

  const ersteFirma = db.prepare("SELECT id FROM firmen ORDER BY id LIMIT 1").get();
  const firmaId = ersteFirma ? ersteFirma.id : firmaAnlegen(konf.firmenname);
  // Zufaelliges, nirgends notiertes Passwort: es wird nie gebraucht, aber die
  // Spalte darf nicht leer bleiben. Beim Umstieg auf "passwort" wird es
  // ohnehin ueber "Passwort zuruecksetzen" neu vergeben.
  auth.benutzerAnlegen({
    firmaId, anmeldename: konf.benutzername,
    passwort: require("crypto").randomBytes(24).toString("base64") + "aA1!",
    appRolle: "Administrator", wechseln: false,
  });
  return true;
}

/*
 * Auf beiden Loopback-Adressen lauschen.
 *
 * Windows loest "localhost" bevorzugt nach ::1 (IPv6) auf. Wer nur an
 * 127.0.0.1 lauscht, ist fuer Browser, die IPv6 zuerst versuchen und nicht
 * stillschweigend auf IPv4 ausweichen, schlicht nicht da - Firefox meldet dann
 * "Verbindung fehlgeschlagen", waehrend Chrome funktioniert.
 */
const ADRESSEN = NUR_LOKAL ? ["127.0.0.1", "::1"] : ["0.0.0.0", "::"];

function starten() {
  const laufen = [];
  let offen = ADRESSEN.length;

  const fertig = () => {
    if (--offen > 0) return;
    if (!laufen.length) {
      console.error("\nAbbruch: Der Port " + PORT + " liess sich auf keiner Adresse belegen.");
      console.error("Laeuft die Anwendung bereits? Sonst mit PORT=8083 einen anderen Port waehlen.\n");
      process.exit(1);
    }
    meldungAusgeben(laufen);
  };

  for (const adresse of ADRESSEN) {
    const s = http.createServer(bearbeiten);
    s.on("error", (e) => {
      if (e.code === "EADDRINUSE") {
        console.error("Port " + PORT + " ist auf " + adresse + " bereits belegt.");
      } else if (e.code === "EAFNOSUPPORT" || e.code === "EADDRNOTAVAIL") {
        // Auf Rechnern ohne IPv6 ist das kein Fehler, nur eine Adresse weniger.
        console.log("Hinweis: " + adresse + " steht auf diesem Rechner nicht zur Verfuegung.");
      } else {
        console.error("Konnte auf " + adresse + " nicht lauschen: " + e.message);
      }
      fertig();
    });
    s.listen(PORT, adresse, () => { laufen.push(adresse); fertig(); });
  }
}

function meldungAusgeben(laufen) {
  const wo = NUR_LOKAL ? "nur auf diesem Rechner" : "im gesamten Netz";
  console.log(`Verwaltung laeuft auf http://localhost:${PORT}  (erreichbar ${wo})`);
  console.log("Adressen: " + laufen.map((a) => (a.includes(":") ? "[" + a + "]" : a)).join(", "));

  if (OHNE_ANMELDUNG) {
    const neu = einzelplatzEinrichten();
    console.log(neu
      ? `Einzelplatz eingerichtet: Firma "${konf.firmenname}". Ohne Anmeldung sofort nutzbar.`
      : "Betriebsart: Einzelplatz, ohne Anmeldung.");
    console.log("Alle Daten liegen in server/daten. Der Schutz ist die Anmeldung an diesem Rechner.");
    console.log("Fuer mehrere Benutzer: in konfiguration.js auf \"passwort\" umstellen.");
    return;
  }

  if (!NUR_LOKAL && !HINTER_TLS) {
    console.warn("WARNUNG: Im Netz erreichbar, aber ohne TLS. Passwoerter gehen unverschluesselt ueber die Leitung.");
    console.warn("         Bitte einen Reverse-Proxy mit HTTPS davorschalten und TLS=1 setzen.");
  }
  const firmen = db.prepare("SELECT COUNT(*) n FROM firmen").get().n;
  if (firmen === 0) console.log('Noch keine Firma vorhanden. Bitte "npm run erstadmin" ausfuehren.');
}

starten();
