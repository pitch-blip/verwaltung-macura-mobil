"use strict";
/**
 * E-Mail-Versand aus der Anwendung heraus.
 *
 * Die Zugangsdaten des Postfachs gehoeren jeder Firma einzeln - jeder Standort
 * versendet unter eigener Adresse. Das Postfach-Passwort laesst sich nicht wie
 * ein Anmeldepasswort als Abdruck ablegen: zum Versenden wird es im Klartext
 * gebraucht. Deshalb wird es verschluesselt gespeichert.
 *
 * Was das leistet und was nicht: Eine Kopie der Datenbank allein - etwa aus
 * einer Sicherung oder versehentlich weitergegeben - gibt das Passwort nicht
 * preis, denn der Schluessel liegt in einer eigenen Datei daneben. Gegen
 * jemanden, der Zugriff auf den ganzen Server hat, schuetzt das nicht.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");
const { db, DATEN } = require("./db");

const SCHLUESSEL_DATEI = path.join(DATEN, "schluessel.bin");

/** Holt den Schluessel; legt ihn beim ersten Mal an. */
function schluessel() {
  if (process.env.SCHLUESSEL) {
    return crypto.createHash("sha256").update(process.env.SCHLUESSEL).digest();
  }
  if (!fs.existsSync(SCHLUESSEL_DATEI)) {
    fs.writeFileSync(SCHLUESSEL_DATEI, crypto.randomBytes(32), { mode: 0o600 });
  }
  return fs.readFileSync(SCHLUESSEL_DATEI);
}

function verschluesseln(klartext) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", schluessel(), iv);
  const daten = Buffer.concat([c.update(String(klartext), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), daten]).toString("base64");
}

function entschluesseln(gespeichert) {
  try {
    const roh = Buffer.from(String(gespeichert), "base64");
    const d = crypto.createDecipheriv("aes-256-gcm", schluessel(), roh.subarray(0, 12));
    d.setAuthTag(roh.subarray(12, 28));
    return Buffer.concat([d.update(roh.subarray(28)), d.final()]).toString("utf8");
  } catch {
    // Falscher Schluessel oder veraenderte Daten - dann gibt es kein Passwort.
    return null;
  }
}

const FELDER = ["host", "port", "sicher", "benutzer", "absender", "absenderName"];

function einstellungenLesen(firmaId, mitPasswort = false) {
  const zeilen = db.prepare("SELECT schluessel, wert FROM design WHERE firma_id = ? AND schluessel LIKE 'mail.%'")
    .all(firmaId);
  const e = {};
  for (const z of zeilen) e[z.schluessel.slice(5)] = z.wert;
  const ergebnis = {};
  for (const f of FELDER) ergebnis[f] = e[f] || "";
  ergebnis.port = Number(ergebnis.port) || 587;
  ergebnis.sicher = e.sicher === "1";
  ergebnis.passwortGesetzt = !!e.passwort;
  if (mitPasswort) ergebnis.passwort = e.passwort ? entschluesseln(e.passwort) : null;
  return ergebnis;
}

function einstellungenSchreiben(firmaId, d) {
  const setzen = db.prepare(`INSERT INTO design (firma_id, schluessel, wert) VALUES (?,?,?)
    ON CONFLICT(firma_id, schluessel) DO UPDATE SET wert = excluded.wert`);
  setzen.run(firmaId, "mail.host", String(d.host || "").trim());
  setzen.run(firmaId, "mail.port", String(Number(d.port) || 587));
  setzen.run(firmaId, "mail.sicher", d.sicher ? "1" : "0");
  setzen.run(firmaId, "mail.benutzer", String(d.benutzer || "").trim());
  setzen.run(firmaId, "mail.absender", String(d.absender || "").trim());
  setzen.run(firmaId, "mail.absenderName", String(d.absenderName || "").trim());
  // Leeres Passwortfeld heisst "unveraendert lassen", nicht "loeschen".
  if (d.passwort) setzen.run(firmaId, "mail.passwort", verschluesseln(d.passwort));
}

function istEingerichtet(firmaId) {
  const e = einstellungenLesen(firmaId);
  return !!(e.host && e.absender);
}

function verbindung(firmaId) {
  const e = einstellungenLesen(firmaId, true);
  if (!e.host || !e.absender) {
    throw Object.assign(new Error("Für diese Firma ist noch kein Postfach hinterlegt."), { status: 503 });
  }
  return {
    absender: e.absenderName ? `"${e.absenderName}" <${e.absender}>` : e.absender,
    versand: nodemailer.createTransport({
      host: e.host,
      port: e.port,
      secure: e.sicher,                 // true = SMTPS (meist Port 465)
      requireTLS: !e.sicher,            // sonst STARTTLS erzwingen, nie unverschluesselt
      auth: e.benutzer ? { user: e.benutzer, pass: e.passwort || "" } : undefined,
    }),
  };
}

/** Prueft die Zugangsdaten, ohne etwas zu versenden. */
async function pruefen(firmaId) {
  const { versand } = verbindung(firmaId);
  await versand.verify();
  return true;
}

async function senden(firmaId, { an, betreff, text, anhang }) {
  const { versand, absender } = verbindung(firmaId);
  const empfaenger = String(an || "").split(/[;,]/).map((a) => a.trim()).filter(Boolean);
  if (!empfaenger.length) {
    throw Object.assign(new Error("Kein Empfänger angegeben."), { status: 400 });
  }
  await versand.sendMail({
    from: absender,
    to: empfaenger,
    subject: betreff || "",
    text: text || "",
    // contentType mitgeben, damit ein PDF beim Empfaenger auch als PDF ankommt
    // und nicht als unbekannter Anhang.
    attachments: anhang
      ? [{ filename: anhang.name, content: anhang.daten, contentType: anhang.typ || undefined }]
      : [],
  });
  return empfaenger;
}

module.exports = { einstellungenLesen, einstellungenSchreiben, istEingerichtet, pruefen, senden };
