"use strict";
/**
 * Erzeugt ZIP-Archive - ohne Fremdbibliothek.
 *
 * Gebraucht wird das fuer das Uebergabepaket an den Steuerberater: mehrere
 * Dateien (Buchungsstapel, Belege, Liesmich) muessen als ein Stueck
 * weitergereicht werden koennen, sonst geht unterwegs etwas verloren.
 *
 * Bewusst selbst geschrieben statt einer Fremdbibliothek: Das Format ist an
 * dieser Stelle uebersichtlich, die Anwendung soll ohne Einrichtungsaufwand
 * laufen, und ein Paket mit Buchfuehrungsdaten soll durch nichts hindurch,
 * dessen Inhalt wir nicht kennen. Die Komprimierung uebernimmt zlib, das in
 * Node eingebaut ist.
 */

const zlib = require("zlib");

/*
 * Pruefsumme nach CRC-32 (IEEE), wie sie das ZIP-Format je Datei verlangt.
 * Die Tabelle wird einmal berechnet - byteweise Rechnen waere bei mehreren
 * Megabyte Beleganhang spuerbar langsamer.
 */
const CRC_TABELLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(daten) {
  let c = 0xffffffff;
  for (let i = 0; i < daten.length; i++) c = CRC_TABELLE[(c ^ daten[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Datum und Uhrzeit im Format von MS-DOS - das ZIP-Verzeichnis kennt kein
 * anderes. Sekunden werden dabei auf zwei gerundet, das ist dem Format so
 * eigen. Vor 1980 gibt es keine Darstellung; dann wird auf 1980 gesetzt.
 */
function dosZeit(datum) {
  const jahr = Math.max(1980, datum.getFullYear());
  return {
    zeit: (datum.getHours() << 11) | (datum.getMinutes() << 5) | (datum.getSeconds() >> 1),
    datum: ((jahr - 1980) << 9) | ((datum.getMonth() + 1) << 5) | datum.getDate(),
  };
}

/**
 * Namen im Archiv.
 *
 * Rueckwaertsschraegstriche und ".." koennten beim Entpacken aus dem Zielordner
 * ausbrechen. Der Name wird deshalb auf gerade Bahnen gebracht, bevor er ins
 * Archiv geht - auch wenn er aus der eigenen Datenbank stammt.
 */
function sichererName(name) {
  return String(name)
    .replace(/\\/g, "/")
    .split("/")
    .filter((teil) => teil && teil !== "." && teil !== "..")
    .join("/");
}

/**
 * Baut ein ZIP-Archiv aus einer Liste von Eintraegen.
 *
 * eintraege: [{ name, daten, zeit }]  - daten als Buffer oder Zeichenkette
 * Rueckgabe: Buffer mit dem fertigen Archiv.
 */
function archiv(eintraege, zeitpunkt) {
  const jetzt = zeitpunkt || new Date();
  const stuecke = [];        // lokale Dateikoepfe samt Inhalt
  const verzeichnis = [];    // zentrales Verzeichnis am Ende der Datei
  let versatz = 0;

  for (const e of eintraege) {
    const name = sichererName(e.name);
    if (!name) continue;
    const nameRoh = Buffer.from(name, "utf8");
    const inhalt = Buffer.isBuffer(e.daten) ? e.daten : Buffer.from(String(e.daten), "utf8");
    const pruefsumme = crc32(inhalt);
    const gepackt = zlib.deflateRawSync(inhalt, { level: 9 });
    // Wenn das Packen nichts bringt - bei PDF oder JPEG ist das die Regel -
    // wird der Inhalt unveraendert abgelegt. Das spart Platz statt ihn zu kosten.
    const packen = gepackt.length < inhalt.length;
    const koerper = packen ? gepackt : inhalt;
    const verfahren = packen ? 8 : 0;
    const z = dosZeit(e.zeit || jetzt);

    const kopf = Buffer.alloc(30);
    kopf.writeUInt32LE(0x04034b50, 0);        // Kennung lokaler Dateikopf
    kopf.writeUInt16LE(20, 4);                // benoetigte Version 2.0
    kopf.writeUInt16LE(0x0800, 6);            // Namen sind UTF-8 kodiert
    kopf.writeUInt16LE(verfahren, 8);
    kopf.writeUInt16LE(z.zeit, 10);
    kopf.writeUInt16LE(z.datum, 12);
    kopf.writeUInt32LE(pruefsumme, 14);
    kopf.writeUInt32LE(koerper.length, 18);
    kopf.writeUInt32LE(inhalt.length, 22);
    kopf.writeUInt16LE(nameRoh.length, 26);
    kopf.writeUInt16LE(0, 28);                // kein Zusatzfeld
    stuecke.push(kopf, nameRoh, koerper);

    const eintrag = Buffer.alloc(46);
    eintrag.writeUInt32LE(0x02014b50, 0);     // Kennung Verzeichniseintrag
    eintrag.writeUInt16LE(20, 4);             // erzeugt von Version 2.0
    eintrag.writeUInt16LE(20, 6);
    eintrag.writeUInt16LE(0x0800, 8);
    eintrag.writeUInt16LE(verfahren, 10);
    eintrag.writeUInt16LE(z.zeit, 12);
    eintrag.writeUInt16LE(z.datum, 14);
    eintrag.writeUInt32LE(pruefsumme, 16);
    eintrag.writeUInt32LE(koerper.length, 20);
    eintrag.writeUInt32LE(inhalt.length, 24);
    eintrag.writeUInt16LE(nameRoh.length, 28);
    eintrag.writeUInt16LE(0, 30);             // kein Zusatzfeld
    eintrag.writeUInt16LE(0, 32);             // kein Kommentar
    eintrag.writeUInt16LE(0, 34);             // Datentraeger 0
    eintrag.writeUInt16LE(0, 36);             // interne Merkmale
    eintrag.writeUInt32LE(0, 38);             // externe Merkmale
    eintrag.writeUInt32LE(versatz, 42);
    verzeichnis.push(eintrag, nameRoh);

    versatz += kopf.length + nameRoh.length + koerper.length;
  }

  const verzeichnisTeile = Buffer.concat(verzeichnis);
  const abschluss = Buffer.alloc(22);
  abschluss.writeUInt32LE(0x06054b50, 0);     // Kennung Abschlusssatz
  abschluss.writeUInt16LE(0, 4);
  abschluss.writeUInt16LE(0, 6);
  abschluss.writeUInt16LE(verzeichnis.length / 2, 8);
  abschluss.writeUInt16LE(verzeichnis.length / 2, 10);
  abschluss.writeUInt32LE(verzeichnisTeile.length, 12);
  abschluss.writeUInt32LE(versatz, 16);
  abschluss.writeUInt16LE(0, 20);             // kein Archivkommentar

  return Buffer.concat([Buffer.concat(stuecke), verzeichnisTeile, abschluss]);
}

module.exports = { archiv, crc32 };
