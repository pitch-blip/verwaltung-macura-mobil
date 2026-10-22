"use strict";
/**
 * Grundeinstellungen der Installation.
 *
 * Diese Datei bewusst hier und nicht in der Oberflaeche: Wer die Anmeldung
 * abschaltet, soll das an einer Stelle tun, die man sieht - nicht ueber ein
 * Haekchen, das versehentlich umgelegt wird.
 */

module.exports = {
  /**
   * "keine"    - Einzelplatz. Ohne Anmeldung, sofort einsatzbereit.
   *              Nur vertretbar, solange die Anwendung ausschliesslich auf
   *              diesem Rechner laeuft und nur eine Person daran arbeitet.
   *              Wer den Rechner bedient, sieht alle Akten. Der Schutz ist
   *              damit die Windows-Anmeldung und die Festplattenverschluesselung.
   *
   * "passwort" - Mehrbenutzerbetrieb. Anmeldename und Passwort je Benutzer,
   *              Rollen und Rechte greifen wie vorgesehen.
   *              Zwingend, sobald mehrere Personen damit arbeiten oder die
   *              Anwendung ueber das Netz erreichbar ist.
   */
  anmeldung: "keine",

  /** Nur fuer "keine": Name der Firma, die beim ersten Start angelegt wird. */
  firmenname: "maCura Mobil",

  /** Nur fuer "keine": unter diesem Namen erscheinen Eintraege in der Historie. */
  benutzername: "einzelplatz",

  /**
   * Wohin "npm run sicherung" schreibt.
   *
   * Leer lassen fuer den Standard (Verwaltung-Sicherungen im Benutzerordner).
   * Sobald eine externe Festplatte oder ein Stick fest dafuer vorgesehen ist,
   * hier deren Pfad eintragen, z. B. "E:/Sicherungen".
   *
   * Nicht innerhalb von OneDrive ablegen - die Akten wuerden sonst in die
   * Cloud synchronisiert. Das Werkzeug warnt in dem Fall.
   */
  sicherungsziel: "",
};
