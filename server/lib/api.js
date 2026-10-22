"use strict";
/**
 * Fachliche Schnittstelle. Jede Anfrage hat zu diesem Zeitpunkt bereits eine
 * gepruefte Sitzung; hier wird nur noch entschieden, ob die Rolle die jeweilige
 * Handlung ausfuehren darf.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { db, DATEIEN, firmaAnlegen, kategorienAnlegen } = require("./db");
const auth = require("./auth");
const R = require("./rechte");

const json = (status, koerper) => ({ status, koerper });
const Verweigert = R.Verweigert;

function neueKennung(praefix) {
  return praefix + "-" + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString("hex").toUpperCase();
}
function jsonFeld(text, fallback) {
  try { const w = JSON.parse(text); return w === null ? fallback : w; } catch { return fallback; }
}

/**
 * SQLite nimmt kein undefined entgegen. Nicht ausgefuellte Felder kommen aus
 * dem Browser aber genau so an, deshalb wird hier einmal sauber umgesetzt.
 */
function w(wert) {
  return wert === undefined || wert === "" ? null : wert;
}
/** Fremdschluessel: nur echte Zahlen durchlassen, sonst null. */
function fk(wert) {
  const n = Number(wert);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function protokoll(sitzung, bezugTyp, bezugId, aktion, details) {
  db.prepare(`INSERT INTO historie (firma_id, bezug_typ, bezug_id, aktion, benutzer, details)
              VALUES (?,?,?,?,?,?)`)
    .run(sitzung.firmaId, bezugTyp, String(bezugId ?? ""), aktion, sitzung.anmeldename, details || "");
}

/* ----------------------------------------------------------------- Umformen */

function personNachAussen(p) {
  return { id: p.id, personenId: p.personen_id, name: p.name, rollen: jsonFeld(p.rollen, []),
    email: p.email, telefon: p.telefon, strasse: p.strasse, plz: p.plz, ort: p.ort,
    geburtsdatum: p.geburtsdatum, eintrittsdatum: p.eintrittsdatum, notiz: p.notiz, aktiv: !!p.aktiv };
}
function dokumentNachAussen(d) {
  return { id: d.id, dokumentId: d.dokument_id, personId: d.person_id, person: d.person_name || null,
    kategorieId: d.kategorie_id, name: d.dateiname, mimeTyp: d.mime_typ,
    version: d.version, status: d.status,
    gueltigAb: d.gueltig_ab, gueltigBis: d.gueltig_bis, notiz: d.notiz,
    verantwortlich: d.verantwortlich, geaendert: d.geaendert_am,
    gesendetAm: d.gesendet_am, gesendetAn: d.gesendet_an };
}
function kategorieNachAussen(k) {
  return { id: k.id, elternId: k.eltern_id, titel: k.titel, bereich: k.bereich,
    pfad: k.pfad, sortierung: k.sortierung, aktiv: !!k.aktiv };
}

/* --------------------------------------------------------------------- Wer */

function ich(sitzung) {
  const firma = db.prepare("SELECT id, name FROM firmen WHERE id = ?").get(sitzung.firmaId);
  const person = sitzung.personId
    ? db.prepare("SELECT id, name, personen_id FROM personen WHERE id = ?").get(sitzung.personId) : null;
  // Nur Administratoren duerfen zwischen Firmen wechseln; alle anderen sind an
  // ihre eigene gebunden.
  const firmen = sitzung.appRolle === "Administrator"
    ? db.prepare("SELECT id, name FROM firmen WHERE aktiv = 1 ORDER BY name").all()
    : [firma];
  return json(200, {
    anmeldename: sitzung.anmeldename,
    appRolle: sitzung.appRolle,
    passwortWechseln: !!sitzung.passwortWechseln,
    // Die Oberflaeche blendet Anmelden/Abmelden und Passwortfunktionen aus,
    // wenn es gar keine Anmeldung gibt.
    ohneAnmeldung: require("../konfiguration").anmeldung === "keine",
    person: person ? { id: person.id, name: person.name, personenId: person.personen_id } : null,
    firmaId: firma.id,
    firmen: firmen.map((f) => ({ id: f.id, name: f.name, appRolle: sitzung.appRolle })),
  });
}

/* ----------------------------------------------------------------- Listen */

function liste(sitzung, was) {
  R.fordereLesen(sitzung, was);
  const f = sitzung.firmaId;
  switch (was) {
    case "personen": {
      const zeilen = db.prepare("SELECT * FROM personen WHERE firma_id = ? ORDER BY name").all(f);
      return json(200, { wert: R.sichtbarePersonen(sitzung, zeilen).map(personNachAussen) });
    }
    case "organisationen":
      return json(200, { wert: db.prepare("SELECT * FROM organisationen WHERE firma_id = ? ORDER BY name").all(f) });
    case "kategorien":
      return json(200, { wert: db.prepare("SELECT * FROM kategorien WHERE firma_id = ? ORDER BY sortierung, titel").all(f).map(kategorieNachAussen) });
    case "dokumente": {
      const zeilen = db.prepare(`
        SELECT d.*, p.name AS person_name FROM dokumente d
          LEFT JOIN personen p ON p.id = d.person_id
         WHERE d.firma_id = ? ORDER BY d.geaendert_am DESC`).all(f);
      return json(200, { wert: R.sichtbareDokumente(sitzung, zeilen).map(dokumentNachAussen) });
    }
    case "zugriffsrechte": {
      const alle = db.prepare(`
        SELECT z.*, b.anmeldename FROM zugriffsrechte z
          JOIN benutzer b ON b.id = z.benutzer_id
         WHERE z.firma_id = ?`).all(f);
      const sichtbar = sitzung.appRolle === "Administrator" ? alle : alle.filter((z) => z.benutzer_id === sitzung.benutzerId);
      return json(200, { wert: sichtbar.map((z) => ({ id: z.id, benutzerId: z.benutzer_id,
        anmeldename: z.anmeldename, kategorieId: z.kategorie_id, rechte: jsonFeld(z.rechte, []),
        erteiltVon: z.erteilt_von, gueltigBis: z.gueltig_bis, status: z.status })) });
    }
    case "historie":
      return json(200, { wert: db.prepare(
        "SELECT * FROM historie WHERE firma_id = ? ORDER BY zeitpunkt DESC LIMIT 500").all(f) });
    case "design":
      return json(200, { wert: db.prepare("SELECT schluessel, wert FROM design WHERE firma_id = ?").all(f) });
    case "menuepunkte":
      return json(200, { wert: db.prepare(`
        SELECT m.id, m.titel, m.kategorie_id, m.sortierung, k.pfad AS kategorie_pfad
          FROM menuepunkte m JOIN kategorien k ON k.id = m.kategorie_id
         WHERE m.firma_id = ? ORDER BY m.sortierung, m.titel`).all(f)
        .map((m) => ({ id: m.id, titel: m.titel, kategorieId: m.kategorie_id,
          kategoriePfad: m.kategorie_pfad, sortierung: m.sortierung })) });
    case "benutzer": {
      R.fordereAdmin(sitzung);
      return json(200, { wert: db.prepare(`
        SELECT b.id, b.anmeldename, b.app_rolle, b.aktiv, b.passwort_wechseln, b.letzte_anmeldung,
               b.gesperrt_bis, b.person_id, p.name AS person_name
          FROM benutzer b LEFT JOIN personen p ON p.id = b.person_id
         WHERE b.firma_id = ? ORDER BY b.anmeldename`).all(f).map((b) => ({
        id: b.id, anmeldename: b.anmeldename, appRolle: b.app_rolle, aktiv: !!b.aktiv,
        passwortWechseln: !!b.passwort_wechseln, letzteAnmeldung: b.letzte_anmeldung,
        gesperrtBis: b.gesperrt_bis, personId: b.person_id, person: b.person_name })) });
    }
    default:
      throw new Verweigert("Unbekannte Liste.", 404);
  }
}

/* ---------------------------------------------------------------- Personen */

function personSpeichern(sitzung, id, d) {
  R.fordereSchreiben(sitzung, "personen");
  const rollen = JSON.stringify(Array.isArray(d.rollen) ? d.rollen : []);
  if (id) {
    const alt = db.prepare("SELECT * FROM personen WHERE id = ? AND firma_id = ?").get(id, sitzung.firmaId);
    if (!alt) throw new Verweigert("Person nicht gefunden.", 404);
    db.prepare(`UPDATE personen SET name=?, rollen=?, email=?, telefon=?, strasse=?, plz=?, ort=?,
      geburtsdatum=?, eintrittsdatum=?, notiz=?, aktiv=? WHERE id=?`)
      .run(d.name, rollen, w(d.email), w(d.telefon), w(d.strasse), w(d.plz), w(d.ort),
        w(d.geburtsdatum), w(d.eintrittsdatum), w(d.notiz), d.aktiv === false ? 0 : 1, id);
    protokoll(sitzung, "Person", alt.personen_id, "geaendert", `Person "${d.name}".`);
    return json(200, { id });
  }
  const personenId = d.personenId || neueKennung(
    (d.rollen || []).includes("Kunde") ? "KD" : (d.rollen || []).includes("Bewerber") ? "BW" : "MA");
  const neu = db.prepare(`INSERT INTO personen
    (firma_id, personen_id, name, rollen, email, telefon, strasse, plz, ort, geburtsdatum, eintrittsdatum, notiz)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(sitzung.firmaId, personenId, d.name, rollen, w(d.email), w(d.telefon), w(d.strasse), w(d.plz), w(d.ort),
      w(d.geburtsdatum), w(d.eintrittsdatum), w(d.notiz)).lastInsertRowid;
  protokoll(sitzung, "Person", personenId, "erstellt", `Person "${d.name}" (${(d.rollen || []).join(", ")}).`);
  return json(201, { id: neu, personenId });
}

/* ----------------------------------------------------------- Organisationen */

function organisationSpeichern(sitzung, id, d) {
  R.fordereSchreiben(sitzung, "organisationen");
  if (id) {
    db.prepare("UPDATE organisationen SET name=?, typ=?, strasse=?, plz=?, ort=?, telefon=?, email=?, notiz=? WHERE id=? AND firma_id=?")
      .run(d.name, w(d.typ), w(d.strasse), w(d.plz), w(d.ort), w(d.telefon), w(d.email), w(d.notiz), id, sitzung.firmaId);
    protokoll(sitzung, "Firma", id, "Organisation geaendert", `${d.name}${d.typ ? " (" + d.typ + ")" : ""}.`);
    return json(200, { id });
  }
  const neu = db.prepare(`INSERT INTO organisationen (firma_id, name, typ, strasse, plz, ort, telefon, email, notiz)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(sitzung.firmaId, d.name, w(d.typ), w(d.strasse), w(d.plz), w(d.ort),
      w(d.telefon), w(d.email), w(d.notiz)).lastInsertRowid;
  protokoll(sitzung, "Firma", neu, "Organisation angelegt", `${d.name}${d.typ ? " (" + d.typ + ")" : ""}.`);
  return json(201, { id: neu });
}

/* -------------------------------------------------------------- Kategorien */

function kategorieSpeichern(sitzung, id, d) {
  R.fordereAdmin(sitzung);
  const eltern = d.elternId
    ? db.prepare("SELECT * FROM kategorien WHERE id = ? AND firma_id = ?").get(d.elternId, sitzung.firmaId) : null;
  if (d.elternId && !eltern) throw new Verweigert("Uebergeordnete Kategorie nicht gefunden.", 404);
  if (id && eltern && String(eltern.id) === String(id)) throw new Verweigert("Eine Kategorie kann sich nicht selbst untergeordnet werden.", 400);
  const pfad = (eltern ? eltern.pfad + "/" : "") + d.titel;

  if (id) {
    db.prepare("UPDATE kategorien SET titel=?, bereich=?, eltern_id=?, pfad=?, sortierung=?, aktiv=? WHERE id=? AND firma_id=?")
      .run(d.titel, d.bereich, d.elternId || null, pfad, d.sortierung || 99, d.aktiv === false ? 0 : 1, id, sitzung.firmaId);
    // Pfade der untergeordneten Kategorien nachziehen
    const nachziehen = (elternId, elternPfad) => {
      for (const k of db.prepare("SELECT * FROM kategorien WHERE eltern_id = ?").all(elternId)) {
        const neuerPfad = elternPfad + "/" + k.titel;
        db.prepare("UPDATE kategorien SET pfad = ? WHERE id = ?").run(neuerPfad, k.id);
        nachziehen(k.id, neuerPfad);
      }
    };
    nachziehen(id, pfad);
    protokoll(sitzung, "Firma", pfad, "Kategorie geaendert", pfad);
    return json(200, { id });
  }
  const neu = db.prepare("INSERT INTO kategorien (firma_id, eltern_id, titel, bereich, pfad, sortierung) VALUES (?,?,?,?,?,?)")
    .run(sitzung.firmaId, d.elternId || null, d.titel, d.bereich, pfad, d.sortierung || 99).lastInsertRowid;
  protokoll(sitzung, "Firma", pfad, "Kategorie angelegt", pfad);
  return json(201, { id: neu });
}

/* --------------------------------------------------------------- Dokumente */

function sichereDatei(name) {
  return String(name || "Datei").replace(/[\\/:*?"<>|]/g, "_").replace(/^\.+/, "").trim().slice(0, 180) || "Datei";
}

/**
 * Dateityp fuer die Auslieferung. Der Browser braucht ihn, damit ein PDF im
 * Betrachter oeffnet statt als unbekannter Download zu landen. Was der Browser
 * beim Hochladen mitschickt, ist nicht immer gesetzt - dann anhand der Endung.
 */
const TYP_NACH_ENDUNG = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
  ".tif": "image/tiff", ".tiff": "image/tiff", ".heic": "image/heic",
  ".txt": "text/plain; charset=utf-8", ".csv": "text/csv; charset=utf-8",
  ".rtf": "application/rtf", ".xml": "application/xml",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".msg": "application/vnd.ms-outlook", ".eml": "message/rfc822",
  ".zip": "application/zip", ".7z": "application/x-7z-compressed",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".mp4": "video/mp4",
};

function dateiTyp(dateiname, gemeldet) {
  const sauber = String(gemeldet || "").split(";")[0].trim().toLowerCase();
  if (sauber && sauber !== "application/octet-stream") return gemeldet;
  return TYP_NACH_ENDUNG[path.extname(dateiname).toLowerCase()] || "application/octet-stream";
}

function dokumentHochladen(sitzung, felder, datei) {
  R.fordereSchreiben(sitzung, "dokumente");
  const kategorie = db.prepare("SELECT * FROM kategorien WHERE id = ? AND firma_id = ?")
    .get(felder.kategorieId, sitzung.firmaId);
  if (!kategorie) throw new Verweigert("Unbekannte Kategorie.", 404);

  const ablageName = crypto.randomUUID() + path.extname(sichereDatei(datei.name));
  const ordner = path.join(DATEIEN, String(sitzung.firmaId));
  fs.mkdirSync(ordner, { recursive: true });
  fs.writeFileSync(path.join(ordner, ablageName), datei.daten);

  const personId = fk(felder.personId);
  if (felder.personId && personId === null) throw new Verweigert("Ungueltige Personen-Kennung.", 400);
  if (personId !== null) {
    const p = db.prepare("SELECT id FROM personen WHERE id = ? AND firma_id = ?").get(personId, sitzung.firmaId);
    if (!p) throw new Verweigert("Unbekannte Person.", 404);
  }

  const name = sichereDatei(datei.name);
  const typ = dateiTyp(name, datei.typ);
  const dokumentKennung = neueKennung("DOC");
  const id = db.prepare(`INSERT INTO dokumente
    (firma_id, dokument_id, person_id, kategorie_id, dateiname, mime_typ, version, status, gueltig_ab, gueltig_bis, notiz, verantwortlich)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(sitzung.firmaId, dokumentKennung, personId, kategorie.id, name, typ,
      "1.0", felder.status || "gueltig", w(felder.gueltigAb), w(felder.gueltigBis),
      w(felder.notiz), sitzung.anmeldename).lastInsertRowid;

  db.prepare(`INSERT INTO dokument_versionen (dokument_id, version, dateiname, ablage, groesse, erstellt_von)
    VALUES (?,?,?,?,?,?)`).run(id, "1.0", sichereDatei(datei.name), path.join(String(sitzung.firmaId), ablageName),
      datei.daten.length, sitzung.anmeldename);

  protokoll(sitzung, "Dokument", dokumentKennung, "erstellt",
    `Datei "${sichereDatei(datei.name)}" in "${kategorie.pfad}".`);
  return json(201, { id, dokumentId: dokumentKennung });
}

function neueVersion(sitzung, id, hauptversion, datei) {
  R.fordereSchreiben(sitzung, "dokumente");
  const d = db.prepare("SELECT * FROM dokumente WHERE id = ? AND firma_id = ?").get(id, sitzung.firmaId);
  if (!d) throw new Verweigert("Dokument nicht gefunden.", 404);
  R.fordereDokumentZugriff(sitzung, d);

  const teile = String(d.version).split(".");
  const naechste = hauptversion
    ? (parseInt(teile[0], 10) + 1) + ".0"
    : teile[0] + "." + (parseInt(teile[1] || "0", 10) + 1);

  const ablageName = crypto.randomUUID() + path.extname(sichereDatei(datei.name));
  const ordner = path.join(DATEIEN, String(sitzung.firmaId));
  fs.mkdirSync(ordner, { recursive: true });
  fs.writeFileSync(path.join(ordner, ablageName), datei.daten);

  const name = sichereDatei(datei.name);
  const typ = dateiTyp(name, datei.typ);
  db.prepare(`INSERT INTO dokument_versionen (dokument_id, version, dateiname, mime_typ, ablage, groesse, erstellt_von)
    VALUES (?,?,?,?,?,?,?)`).run(id, naechste, name, typ,
      path.join(String(sitzung.firmaId), ablageName), datei.daten.length, sitzung.anmeldename);
  // Eine neue Fassung gilt als noch nicht versendet - sonst stuende sie
  // faelschlich als "gesendet" da, obwohl der Empfaenger die alte Fassung hat.
  db.prepare(`UPDATE dokumente SET version = ?, dateiname = ?, mime_typ = ?,
      gesendet_am = NULL, gesendet_an = NULL, geaendert_am = datetime('now') WHERE id = ?`)
    .run(naechste, name, typ, id);

  protokoll(sitzung, "Dokument", d.dokument_id, "neue Version", `Version ${d.version} -> ${naechste}.`);
  return json(200, { version: naechste });
}

function dokumentInhalt(sitzung, id) {
  R.fordereLesen(sitzung, "dokumente");
  const d = db.prepare("SELECT * FROM dokumente WHERE id = ? AND firma_id = ?").get(id, sitzung.firmaId);
  if (!d) throw new Verweigert("Dokument nicht gefunden.", 404);
  R.fordereDokumentZugriff(sitzung, d);
  const v = db.prepare("SELECT * FROM dokument_versionen WHERE dokument_id = ? ORDER BY id DESC LIMIT 1").get(id);
  if (!v) throw new Verweigert("Zu diesem Dokument liegt keine Datei vor.", 404);

  // Der Pfad kommt aus der Datenbank, nie aus der Anfrage - und wird trotzdem
  // geprueft, damit ein manipulierter Eintrag nicht aus dem Ordner ausbricht.
  const voll = path.resolve(DATEIEN, v.ablage);
  if (!voll.startsWith(path.resolve(DATEIEN) + path.sep)) throw new Verweigert("Ungueltige Ablage.", 500);
  if (!fs.existsSync(voll)) throw new Verweigert("Die Datei fehlt auf dem Datentraeger.", 410);

  protokoll(sitzung, "Dokument", d.dokument_id, "geoeffnet", d.dateiname);
  return { datei: {
    daten: fs.readFileSync(voll),
    name: d.dateiname,
    typ: dateiTyp(d.dateiname, d.mime_typ),
  }};
}

function dokumentAendern(sitzung, id, d) {
  R.fordereSchreiben(sitzung, "dokumente");
  const alt = db.prepare("SELECT * FROM dokumente WHERE id = ? AND firma_id = ?").get(id, sitzung.firmaId);
  if (!alt) throw new Verweigert("Dokument nicht gefunden.", 404);
  R.fordereDokumentZugriff(sitzung, alt);
  db.prepare("UPDATE dokumente SET status = COALESCE(?,status), gueltig_bis = COALESCE(?,gueltig_bis), notiz = COALESCE(?,notiz) WHERE id = ?")
    .run(d.status ?? null, d.gueltigBis ?? null, d.notiz ?? null, id);
  if (d.status) protokoll(sitzung, "Dokument", alt.dokument_id, d.status === "archiviert" ? "archiviert" : "geaendert", `Status: ${d.status}.`);
  return json(200, { id });
}

/* ---------------------------------------------------------- Zugriffsrechte */

function rechteSetzen(sitzung, benutzerId, wunsch) {
  R.fordereAdmin(sitzung);
  const ziel = db.prepare("SELECT * FROM benutzer WHERE id = ? AND firma_id = ?").get(benutzerId, sitzung.firmaId);
  if (!ziel) throw new Verweigert("Benutzer nicht gefunden.", 404);

  const bilanz = { erteilt: 0, geaendert: 0, entzogen: 0 };
  const jetzt = db.prepare("SELECT * FROM zugriffsrechte WHERE benutzer_id = ?").all(benutzerId);
  const nachKategorie = new Map(jetzt.map((z) => [String(z.kategorie_id), z]));

  for (const [katId, rechte] of Object.entries(wunsch)) {
    const kategorie = db.prepare("SELECT * FROM kategorien WHERE id = ? AND firma_id = ?").get(katId, sitzung.firmaId);
    if (!kategorie) continue;
    const vorhanden = nachKategorie.get(String(katId));
    const vorher = vorhanden && vorhanden.status === "aktiv" ? jsonFeld(vorhanden.rechte, []) : [];
    const gleich = vorher.length === rechte.length && vorher.every((x) => rechte.includes(x));
    if (gleich) continue;

    if (rechte.length === 0) {
      if (vorhanden && vorhanden.status === "aktiv") {
        db.prepare("UPDATE zugriffsrechte SET status='entzogen', rechte='[]', geaendert_am=datetime('now') WHERE id=?").run(vorhanden.id);
        protokoll(sitzung, "Zugriffsrecht", katId, "entzogen",
          `Kategorie "${kategorie.pfad}" fuer ${ziel.anmeldename} entzogen.`);
        bilanz.entzogen++;
      }
      continue;
    }
    if (vorhanden) {
      db.prepare("UPDATE zugriffsrechte SET rechte=?, status='aktiv', erteilt_von=?, geaendert_am=datetime('now') WHERE id=?")
        .run(JSON.stringify(rechte), sitzung.anmeldename, vorhanden.id);
      bilanz.geaendert++;
    } else {
      db.prepare(`INSERT INTO zugriffsrechte (firma_id, benutzer_id, kategorie_id, rechte, erteilt_von)
        VALUES (?,?,?,?,?)`).run(sitzung.firmaId, benutzerId, katId, JSON.stringify(rechte), sitzung.anmeldename);
      bilanz.erteilt++;
    }
    protokoll(sitzung, "Zugriffsrecht", katId, vorhanden ? "geaendert" : "erteilt",
      `Kategorie "${kategorie.pfad}" fuer ${ziel.anmeldename}: ${rechte.join(", ")}.`);
  }
  return json(200, bilanz);
}

/* --------------------------------------------------------------- Benutzer */

function benutzerSpeichern(sitzung, id, d) {
  R.fordereAdmin(sitzung);
  if (!R.APP_ROLLEN.includes(d.appRolle)) throw new Verweigert("Unbekannte Zugriffsrolle.", 400);

  if (id) {
    const alt = db.prepare("SELECT * FROM benutzer WHERE id = ? AND firma_id = ?").get(id, sitzung.firmaId);
    if (!alt) throw new Verweigert("Benutzer nicht gefunden.", 404);
    // Der letzte aktive Administrator darf sich nicht selbst entmachten oder sperren.
    const andereAdmins = db.prepare(
      "SELECT COUNT(*) n FROM benutzer WHERE firma_id=? AND app_rolle='Administrator' AND aktiv=1 AND id<>?")
      .get(sitzung.firmaId, id).n;
    if (alt.app_rolle === "Administrator" && andereAdmins === 0 &&
        (d.appRolle !== "Administrator" || d.aktiv === false)) {
      throw new Verweigert("Das ist der letzte Administrator dieser Firma. Bitte zuerst einen weiteren einrichten.", 409);
    }
    db.prepare("UPDATE benutzer SET app_rolle=?, aktiv=?, person_id=? WHERE id=?")
      .run(d.appRolle, d.aktiv === false ? 0 : 1, d.personId || null, id);
    if (d.aktiv === false) auth.sitzungenBeendenFuer(id);
    protokoll(sitzung, "Zugriffsrecht", alt.anmeldename, "Benutzer geaendert",
      `Rolle: ${d.appRolle}${d.aktiv === false ? ", gesperrt" : ""}.`);
    return json(200, { id });
  }

  const neu = auth.benutzerAnlegen({
    firmaId: sitzung.firmaId, anmeldename: d.anmeldename, passwort: d.passwort,
    appRolle: d.appRolle, personId: d.personId || null, wechseln: true,
  });
  protokoll(sitzung, "Zugriffsrecht", d.anmeldename, "Benutzer angelegt", `Rolle: ${d.appRolle}.`);
  return json(201, { id: neu });
}

function passwortZuruecksetzen(sitzung, id, neuesPasswort) {
  R.fordereAdmin(sitzung);
  const b = db.prepare("SELECT * FROM benutzer WHERE id = ? AND firma_id = ?").get(id, sitzung.firmaId);
  if (!b) throw new Verweigert("Benutzer nicht gefunden.", 404);
  auth.passwortAendern(id, neuesPasswort, true);
  protokoll(sitzung, "Zugriffsrecht", b.anmeldename, "Passwort zurueckgesetzt",
    "Der Benutzer muss beim naechsten Anmelden ein eigenes Passwort vergeben.");
  return json(200, { ok: true });
}

function eigenesPasswortAendern(sitzung, altesPasswort, neuesPasswort) {
  const b = db.prepare("SELECT * FROM benutzer WHERE id = ?").get(sitzung.benutzerId);
  if (!auth.passwortStimmt(String(altesPasswort || ""), b.salz, b.passwort_abdruck)) {
    throw new Verweigert("Das bisherige Passwort ist falsch.", 400);
  }
  auth.passwortAendern(sitzung.benutzerId, neuesPasswort, false);
  protokoll(sitzung, "Zugriffsrecht", b.anmeldename, "Passwort geaendert", "Durch den Benutzer selbst.");
  return json(200, { ok: true });
}

/* ------------------------------------------------------------------ Design */

function designSpeichern(sitzung, schluessel, wert) {
  R.fordereAdmin(sitzung);
  db.prepare(`INSERT INTO design (firma_id, schluessel, wert) VALUES (?,?,?)
    ON CONFLICT(firma_id, schluessel) DO UPDATE SET wert = excluded.wert`)
    .run(sitzung.firmaId, schluessel, wert);
  return json(200, { ok: true });
}

/* ------------------------------------------------------------------ Firmen */

function firmaNeu(sitzung, name) {
  R.fordereAdmin(sitzung);
  if (!name || !String(name).trim()) throw new Verweigert("Bitte einen Namen angeben.", 400);
  const id = firmaAnlegen(String(name).trim());
  protokoll(sitzung, "Firma", id, "Firma angelegt", String(name).trim());
  return json(201, { id });
}

/**
 * Benennt eine Firma um.
 *
 * Der Name aendert nur die Beschriftung, nicht die Zugehoerigkeit: Buchungen,
 * Belege und Dokumente haengen an der Kennung. Gebraucht wird es trotzdem -
 * eine Firma heisst beim Einrichten oft nach der Marke und spaeter nach der
 * Gesellschaft, und im Briefkopf einer Rechnung soll die Gesellschaft stehen.
 */
function firmaUmbenennen(sitzung, id, name) {
  R.fordereAdmin(sitzung);
  const neu = String(name || "").trim();
  if (!neu) throw new Verweigert("Bitte einen Namen angeben.", 400);
  const f = db.prepare("SELECT id, name FROM firmen WHERE id = ?").get(id);
  if (!f) throw new Verweigert("Unbekannte Firma.", 404);
  db.prepare("UPDATE firmen SET name = ? WHERE id = ?").run(neu.slice(0, 120), f.id);
  protokoll(sitzung, "Firma", f.id, "Firma umbenannt", f.name + " → " + neu);
  return json(200, { id: f.id, name: neu });
}

function strukturPruefen(sitzung) {
  R.fordereAdmin(sitzung);
  kategorienAnlegen(sitzung.firmaId);
  return json(200, { protokoll: ["Kategorien geprueft.", "Fertig."] });
}

/* -------------------------------------------------------------- Menuepunkte */

function menuepunktAnlegen(sitzung, d) {
  R.fordereAdmin(sitzung);
  const titel = String(d.titel || "").trim();
  if (!titel) throw new Verweigert("Bitte eine Bezeichnung angeben.", 400);
  const kategorie = db.prepare("SELECT * FROM kategorien WHERE id = ? AND firma_id = ?")
    .get(fk(d.kategorieId), sitzung.firmaId);
  if (!kategorie) throw new Verweigert("Unbekannte Kategorie.", 404);

  const naechste = db.prepare("SELECT COALESCE(MAX(sortierung), 0) + 1 AS n FROM menuepunkte WHERE firma_id = ?")
    .get(sitzung.firmaId).n;
  const id = db.prepare("INSERT INTO menuepunkte (firma_id, titel, kategorie_id, sortierung) VALUES (?,?,?,?)")
    .run(sitzung.firmaId, titel, kategorie.id, naechste).lastInsertRowid;
  protokoll(sitzung, "Firma", id, "Menuepunkt angelegt", `"${titel}" zeigt auf "${kategorie.pfad}".`);
  return json(201, { id });
}

function menuepunktEntfernen(sitzung, id) {
  R.fordereAdmin(sitzung);
  const m = db.prepare("SELECT * FROM menuepunkte WHERE id = ? AND firma_id = ?").get(id, sitzung.firmaId);
  if (!m) throw new Verweigert("Menuepunkt nicht gefunden.", 404);
  db.prepare("DELETE FROM menuepunkte WHERE id = ?").run(id);
  protokoll(sitzung, "Firma", id, "Menuepunkt entfernt", `"${m.titel}".`);
  return json(200, { ok: true });
}

/** Verschiebt einen Eintrag um eine Stelle nach oben oder unten. */
function menuepunktVerschieben(sitzung, id, richtung) {
  R.fordereAdmin(sitzung);
  const alle = db.prepare("SELECT * FROM menuepunkte WHERE firma_id = ? ORDER BY sortierung, titel")
    .all(sitzung.firmaId);
  const i = alle.findIndex((m) => String(m.id) === String(id));
  if (i < 0) throw new Verweigert("Menuepunkt nicht gefunden.", 404);
  const j = richtung === "hoch" ? i - 1 : i + 1;
  if (j < 0 || j >= alle.length) return json(200, { ok: true });   // schon ganz oben bzw. unten

  // Reihenfolge neu durchnummerieren, damit sie auch bei gleichen Werten stimmt.
  const neu = alle.slice();
  neu[i] = alle[j]; neu[j] = alle[i];
  const setzen = db.prepare("UPDATE menuepunkte SET sortierung = ? WHERE id = ?");
  neu.forEach((m, n) => setzen.run(n + 1, m.id));
  return json(200, { ok: true });
}

/* ------------------------------------------------------------------- E-Mail */

const mail = require("./mail");

function mailEinstellungen(sitzung) {
  R.fordereAdmin(sitzung);
  return json(200, mail.einstellungenLesen(sitzung.firmaId));
}

function mailEinstellungenSetzen(sitzung, d) {
  R.fordereAdmin(sitzung);
  mail.einstellungenSchreiben(sitzung.firmaId, d);
  protokoll(sitzung, "Firma", sitzung.firmaId, "Postfach geaendert",
    `Versand über ${d.host || "-"} als ${d.absender || "-"}.`);
  return json(200, mail.einstellungenLesen(sitzung.firmaId));
}

async function mailPruefen(sitzung) {
  R.fordereAdmin(sitzung);
  await mail.pruefen(sitzung.firmaId);
  return json(200, { ok: true });
}

/** Versendet ein Dokument. Setzt Leserecht am Dokument und Versandrecht voraus. */
async function dokumentSenden(sitzung, id, d) {
  if (!sitzung.regeln.versendet) throw new Verweigert("Kein Recht zum Versenden.");
  const dok = db.prepare("SELECT * FROM dokumente WHERE id = ? AND firma_id = ?").get(id, sitzung.firmaId);
  if (!dok) throw new Verweigert("Dokument nicht gefunden.", 404);
  R.fordereDokumentZugriff(sitzung, dok);

  const v = db.prepare("SELECT * FROM dokument_versionen WHERE dokument_id = ? ORDER BY id DESC LIMIT 1").get(id);
  if (!v) throw new Verweigert("Zu diesem Dokument liegt keine Datei vor.", 404);
  const voll = path.resolve(DATEIEN, v.ablage);
  if (!voll.startsWith(path.resolve(DATEIEN) + path.sep)) throw new Verweigert("Ungueltige Ablage.", 500);
  if (!fs.existsSync(voll)) throw new Verweigert("Die Datei fehlt auf dem Datentraeger.", 410);

  const empfaenger = await mail.senden(sitzung.firmaId, {
    an: d.an, betreff: d.betreff, text: d.text,
    anhang: {
      name: dok.dateiname,
      daten: fs.readFileSync(voll),
      typ: dateiTyp(dok.dateiname, dok.mime_typ),
    },
  });

  // Versandstatus am Dokument festhalten - nicht nur in der Historie, damit in
  // der Uebersicht auf einen Blick zu sehen ist, was noch offen ist.
  const zeitpunkt = new Date().toISOString();
  db.prepare("UPDATE dokumente SET gesendet_am = ?, gesendet_an = ? WHERE id = ?")
    .run(zeitpunkt, empfaenger.join(", "), dok.id);

  protokoll(sitzung, "Dokument", dok.dokument_id, "versendet",
    `Per E-Mail an ${empfaenger.join(", ")} versendet.`);
  return json(200, { gesendet: empfaenger, gesendetAm: zeitpunkt });
}

module.exports = {
  ich, liste, personSpeichern, organisationSpeichern, kategorieSpeichern,
  mailEinstellungen, mailEinstellungenSetzen, mailPruefen, dokumentSenden,
  menuepunktAnlegen, menuepunktEntfernen, menuepunktVerschieben,
  dokumentHochladen, neueVersion, dokumentInhalt, dokumentAendern,
  rechteSetzen, benutzerSpeichern, passwortZuruecksetzen, eigenesPasswortAendern,
  designSpeichern, firmaNeu, firmaUmbenennen, strukturPruefen, protokoll,
};
