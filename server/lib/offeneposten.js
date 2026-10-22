"use strict";
/**
 * Offene Posten und Saldenabgleich.
 *
 * Eine Rechnung ist erst erledigt, wenn sie bezahlt ist. Die Buchhaltung weiss
 * bis dahin nur, dass ein Kunde insgesamt einen bestimmten Betrag schuldet -
 * welche Rechnung davon noch offen ist, steht nirgends. Genau danach wird aber
 * gefragt: beim Mahnen, beim Abstimmen mit dem Kontoauszug und beim
 * Jahresabschluss.
 *
 * Deshalb wird festgehalten, welche Zahlung welche Rechnung ausgleicht
 * (Tabelle buch_ausgleich). Die Zuordnung aendert keine Buchung - sie
 * beschreibt nur, was zusammengehoert. Sie geht auch nicht an den
 * Steuerberater mit; dort zaehlen die Buchungen.
 *
 * Der Saldenabgleich stellt drei Dinge nebeneinander, die uebereinstimmen
 * muessen:
 *
 *   1. Was das Bankkonto laut Buchfuehrung ausweist - gegen den Kontoauszug.
 *   2. Was die Personenkonten ausweisen - gegen die Summe der offenen Posten.
 *   3. Welche Zahlungen noch keiner Rechnung zugeordnet sind.
 *
 * Weicht etwas ab, steht die Ursache daneben. Eine Abstimmung, die nur "passt
 * nicht" sagt, hilft niemandem.
 */

const { db } = require("./db");
const R = require("./rechte");
const B = require("./buchhaltung");

const Verweigert = R.Verweigert;
const json = (status, koerper) => ({ status, koerper });

const RECHNUNGSARTEN = ["Ausgangsrechnung", "Eingangsrechnung"];
const heute = () => new Date().toISOString().slice(0, 10);

/* ------------------------------------------------------------ Grundlagen */

/**
 * Alle Rechnungen mit ihrem noch offenen Betrag.
 *
 * Storniertes und Stornobuchungen bleiben aussen vor: Eine stornierte Rechnung
 * ist keine Forderung mehr, und die Stornobuchung selbst ist keine.
 */
function rechnungen(firmaId, stichtag) {
  const bis = stichtag || heute();
  return db.prepare(`
    SELECT b.*, p.name AS partner_name, p.typ AS partner_typ, p.konto AS partner_konto,
           COALESCE((SELECT SUM(a.betrag_cent) FROM buch_ausgleich a WHERE a.rechnung_id = b.id), 0) AS ausgeglichen
      FROM buch_belege b
      LEFT JOIN buch_partner p ON p.id = b.partner_id
     WHERE b.firma_id = ? AND b.datum <= ?
       AND b.art IN ('Ausgangsrechnung', 'Eingangsrechnung')
       AND b.storno_von IS NULL AND b.storniert_durch IS NULL
     ORDER BY b.datum, b.journal_nr`).all(firmaId, bis)
    .map((b) => {
      const offen = b.brutto_cent - b.ausgeglichen;
      const faellig = b.faellig_am || b.datum;
      return {
        id: b.id, journalNr: b.journal_nr, belegnummer: b.belegnummer, art: b.art,
        datum: b.datum, faelligAm: b.faellig_am,
        partnerId: b.partner_id, partner: b.partner_name, partnerKonto: b.partner_konto,
        partnerTyp: b.partner_typ,
        buchungstext: b.buchungstext,
        bruttoCent: b.brutto_cent, ausgeglichenCent: b.ausgeglichen, offenCent: offen,
        bezahlt: offen === 0,
        ueberzahlt: offen < 0,
        tageOffen: offen !== 0 ? Math.floor((new Date(bis) - new Date(faellig)) / 86400000) : 0,
      };
    });
}

/** Zahlungen auf Personenkonten samt bereits zugeordnetem Anteil. */
function zahlungen(firmaId, stichtag) {
  const bis = stichtag || heute();
  return db.prepare(`
    SELECT b.*, p.name AS partner_name, p.typ AS partner_typ, p.konto AS partner_konto,
           COALESCE((SELECT SUM(a.betrag_cent) FROM buch_ausgleich a WHERE a.zahlung_id = b.id), 0) AS zugeordnet
      FROM buch_belege b
      LEFT JOIN buch_partner p ON p.id = b.partner_id
     WHERE b.firma_id = ? AND b.datum <= ?
       AND b.art IN ('Zahlungseingang', 'Zahlungsausgang')
       AND b.storno_von IS NULL AND b.storniert_durch IS NULL
     ORDER BY b.datum, b.journal_nr`).all(firmaId, bis)
    .map((b) => ({
      id: b.id, journalNr: b.journal_nr, belegnummer: b.belegnummer, art: b.art,
      datum: b.datum, partnerId: b.partner_id, partner: b.partner_name,
      partnerKonto: b.partner_konto, partnerTyp: b.partner_typ,
      buchungstext: b.buchungstext, bruttoCent: b.brutto_cent,
      zugeordnetCent: b.zugeordnet, offenCent: b.brutto_cent - b.zugeordnet,
    }));
}

/**
 * Saldo eines Kontos aus den Buchungen - die belastbare Zahl.
 *
 * Alles andere (offene Posten, Zuordnungen) ist Beiwerk, das damit
 * uebereinstimmen muss. Positiv heisst: im Soll, also eine Forderung.
 */
function kontosaldo(firmaId, konto, stichtag) {
  const r = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN soll_konto = ? THEN brutto_cent ELSE 0 END), 0)
         - COALESCE(SUM(CASE WHEN haben_konto = ? THEN brutto_cent ELSE 0 END), 0) AS saldo
      FROM buch_belege
     WHERE firma_id = ? AND datum <= ? AND (soll_konto = ? OR haben_konto = ?)`)
    .get(konto, konto, firmaId, stichtag || heute(), konto, konto);
  return r ? r.saldo : 0;
}

/* --------------------------------------------------------- Offene Posten */

function offenePosten(sitzung, d) {
  R.fordereLesen(sitzung, "buchhaltung");
  const stichtag = /^\d{4}-\d{2}-\d{2}$/.test(d && d.stichtag) ? d.stichtag : heute();
  const alle = rechnungen(sitzung.firmaId, stichtag);
  const offen = alle.filter((r) => r.offenCent !== 0);
  const nurTyp = d && d.typ;

  const gefiltert = nurTyp
    ? offen.filter((r) => (nurTyp === "Forderung" ? r.art === "Ausgangsrechnung" : r.art === "Eingangsrechnung"))
    : offen;

  const forderungen = offen.filter((r) => r.art === "Ausgangsrechnung");
  const verbindlichkeiten = offen.filter((r) => r.art === "Eingangsrechnung");
  const summe = (liste) => liste.reduce((s, r) => s + r.offenCent, 0);

  /*
   * Altersgliederung. Nicht Selbstzweck: Was laenger als 90 Tage offen ist,
   * wird erfahrungsgemaess selten noch freiwillig bezahlt, und zum
   * Jahresabschluss stellt sich die Frage nach einer Wertberichtigung.
   */
  const stufen = [
    { l: "nicht fällig", pruefe: (r) => r.tageOffen < 0 },
    { l: "bis 30 Tage", pruefe: (r) => r.tageOffen >= 0 && r.tageOffen <= 30 },
    { l: "31 bis 60 Tage", pruefe: (r) => r.tageOffen > 30 && r.tageOffen <= 60 },
    { l: "61 bis 90 Tage", pruefe: (r) => r.tageOffen > 60 && r.tageOffen <= 90 },
    { l: "über 90 Tage", pruefe: (r) => r.tageOffen > 90 },
  ];
  const gliederung = (liste) => stufen.map((s) => {
    const treffer = liste.filter(s.pruefe);
    return { stufe: s.l, anzahl: treffer.length, centSumme: summe(treffer) };
  });

  return json(200, {
    stichtag,
    posten: gefiltert,
    forderungen: { anzahl: forderungen.length, centSumme: summe(forderungen),
      gliederung: gliederung(forderungen) },
    verbindlichkeiten: { anzahl: verbindlichkeiten.length, centSumme: summe(verbindlichkeiten),
      gliederung: gliederung(verbindlichkeiten) },
    nichtZugeordnet: zahlungen(sitzung.firmaId, stichtag).filter((z) => z.offenCent !== 0),
  });
}

/* ------------------------------------------------------------ Zuordnung */

/**
 * Ordnet eine Zahlung einer Rechnung zu.
 *
 * Geprueft wird dreierlei: dass beides zusammenpasst (gleicher
 * Geschaeftspartner, passende Richtung), dass nicht mehr zugeordnet wird als
 * die Rechnung ausmacht, und dass die Zahlung nicht mehrfach verplant wird.
 * Ohne diese Schranken entstuenden Salden, die es in Wirklichkeit nicht gibt.
 */
function ausgleichen(sitzung, d) {
  R.fordereSchreiben(sitzung, "buchhaltung");
  const firmaId = sitzung.firmaId;
  const rechnung = db.prepare("SELECT * FROM buch_belege WHERE id = ? AND firma_id = ?")
    .get(d.rechnungId, firmaId);
  const zahlung = db.prepare("SELECT * FROM buch_belege WHERE id = ? AND firma_id = ?")
    .get(d.zahlungId, firmaId);
  if (!rechnung) throw new Verweigert("Rechnung nicht gefunden.", 404);
  if (!zahlung) throw new Verweigert("Zahlung nicht gefunden.", 404);
  if (!RECHNUNGSARTEN.includes(rechnung.art)) {
    throw new Verweigert("Ausgeglichen werden können nur Ein- und Ausgangsrechnungen.", 400);
  }
  if (!["Zahlungseingang", "Zahlungsausgang"].includes(zahlung.art)) {
    throw new Verweigert("Ausgleichen kann nur eine Zahlung.", 400);
  }
  if (rechnung.art === "Ausgangsrechnung" && zahlung.art !== "Zahlungseingang") {
    throw new Verweigert("Eine Ausgangsrechnung wird durch einen Zahlungseingang ausgeglichen.", 400);
  }
  if (rechnung.art === "Eingangsrechnung" && zahlung.art !== "Zahlungsausgang") {
    throw new Verweigert("Eine Eingangsrechnung wird durch einen Zahlungsausgang ausgeglichen.", 400);
  }
  if (rechnung.partner_id && zahlung.partner_id && rechnung.partner_id !== zahlung.partner_id) {
    throw new Verweigert("Rechnung und Zahlung gehören zu verschiedenen Geschäftspartnern.", 400);
  }
  if (rechnung.storniert_durch || zahlung.storniert_durch) {
    throw new Verweigert("Stornierte Belege lassen sich nicht ausgleichen.", 409);
  }

  const schonRechnung = db.prepare(
    "SELECT COALESCE(SUM(betrag_cent),0) n FROM buch_ausgleich WHERE rechnung_id = ? AND zahlung_id <> ?")
    .get(rechnung.id, zahlung.id).n;
  const schonZahlung = db.prepare(
    "SELECT COALESCE(SUM(betrag_cent),0) n FROM buch_ausgleich WHERE zahlung_id = ? AND rechnung_id <> ?")
    .get(zahlung.id, rechnung.id).n;

  const offenRechnung = rechnung.brutto_cent - schonRechnung;
  const offenZahlung = zahlung.brutto_cent - schonZahlung;
  // Ohne Angabe wird so viel zugeordnet, wie beide Seiten hergeben.
  const betrag = d.betragCent === undefined || d.betragCent === null || d.betragCent === ""
    ? Math.min(offenRechnung, offenZahlung)
    : Math.round(Number(d.betragCent));

  if (!Number.isFinite(betrag) || betrag <= 0) throw new Verweigert("Der Betrag muss größer als null sein.", 400);
  if (betrag > offenRechnung) {
    throw new Verweigert("Die Rechnung ist nur noch mit " + (offenRechnung / 100).toFixed(2) +
      " EUR offen.", 400);
  }
  if (betrag > offenZahlung) {
    throw new Verweigert("Von der Zahlung sind nur noch " + (offenZahlung / 100).toFixed(2) +
      " EUR nicht zugeordnet.", 400);
  }

  db.prepare(`INSERT INTO buch_ausgleich (firma_id, rechnung_id, zahlung_id, betrag_cent, angelegt_von)
              VALUES (?,?,?,?,?)
              ON CONFLICT(rechnung_id, zahlung_id) DO UPDATE SET betrag_cent = excluded.betrag_cent`)
    .run(firmaId, rechnung.id, zahlung.id, betrag, sitzung.anmeldename);

  B.protokoll(sitzung, rechnung.journal_nr, "Zahlung zugeordnet",
    "Nr. " + zahlung.journal_nr + " (" + zahlung.belegnummer + ") gleicht Nr. " + rechnung.journal_nr +
    " (" + rechnung.belegnummer + ") mit " + (betrag / 100).toFixed(2) + " EUR aus.");
  return json(200, { betragCent: betrag, restRechnung: offenRechnung - betrag, restZahlung: offenZahlung - betrag });
}

function ausgleichLoesen(sitzung, rechnungId, zahlungId) {
  R.fordereSchreiben(sitzung, "buchhaltung");
  const a = db.prepare(`SELECT a.*, r.journal_nr AS rnr, z.journal_nr AS znr
      FROM buch_ausgleich a
      JOIN buch_belege r ON r.id = a.rechnung_id
      JOIN buch_belege z ON z.id = a.zahlung_id
     WHERE a.firma_id = ? AND a.rechnung_id = ? AND a.zahlung_id = ?`)
    .get(sitzung.firmaId, rechnungId, zahlungId);
  if (!a) throw new Verweigert("Diese Zuordnung gibt es nicht.", 404);
  db.prepare("DELETE FROM buch_ausgleich WHERE id = ?").run(a.id);
  B.protokoll(sitzung, a.rnr, "Zuordnung gelöst",
    "Nr. " + a.znr + " ist Nr. " + a.rnr + " nicht mehr zugeordnet.");
  return json(200, { ok: true });
}

/* -------------------------------------------------------- Saldenabgleich */

/**
 * Die Abstimmung.
 *
 * bankKonto und auszugSaldoCent sind freiwillig: Ohne Endsaldo vom
 * Kontoauszug laesst sich der Banksaldo nicht gegenpruefen - dann bleibt der
 * Rest der Abstimmung trotzdem nutzbar.
 */
function saldenabgleich(sitzung, d) {
  R.fordereLesen(sitzung, "buchhaltung");
  const firmaId = sitzung.firmaId;
  const stichtag = /^\d{4}-\d{2}-\d{2}$/.test(d && d.stichtag) ? d.stichtag : heute();

  /* --- Bank --- */
  const geldkonten = db.prepare("SELECT nummer, bezeichnung, geld FROM buch_konten WHERE firma_id = ? AND geld IS NOT NULL")
    .all(firmaId);
  const banken = geldkonten.map((k) => {
    const buchsaldo = kontosaldo(firmaId, k.nummer, stichtag);
    const offeneUmsaetze = db.prepare(`
      SELECT COALESCE(SUM(betrag_cent),0) AS summe, COUNT(*) AS anzahl
        FROM buch_bankumsaetze
       WHERE firma_id = ? AND konto = ? AND status = 'offen' AND datum <= ?`)
      .get(firmaId, k.nummer, stichtag);
    const letzter = db.prepare(`
      SELECT datum FROM buch_bankumsaetze WHERE firma_id = ? AND konto = ?
       ORDER BY datum DESC LIMIT 1`).get(firmaId, k.nummer);
    /*
     * Endsaldo aus dem Kontoauszug. Viele Banken liefern den Kontostand nach
     * jeder Buchung mit; dann muss er fuer die Abstimmung nicht abgetippt
     * werden. Genommen wird der juengste, der zum Stichtag passt.
     */
    const ausAuszug = db.prepare(`
      SELECT endsaldo_cent, endsaldo_datum FROM buch_bankimporte
       WHERE firma_id = ? AND konto = ? AND endsaldo_cent IS NOT NULL AND endsaldo_datum <= ?
       ORDER BY endsaldo_datum DESC, id DESC LIMIT 1`).get(firmaId, k.nummer, stichtag);
    return {
      konto: k.nummer, bezeichnung: k.bezeichnung, art: k.geld,
      buchsaldoCent: buchsaldo,
      nichtGebuchtCent: offeneUmsaetze.summe, nichtGebuchtAnzahl: offeneUmsaetze.anzahl,
      // Was auf dem Konto stehen muesste, wenn alles Eingelesene gebucht waere.
      erwarteterSaldoCent: buchsaldo + offeneUmsaetze.summe,
      letzterUmsatz: letzter ? letzter.datum : null,
      auszugSaldoCent: ausAuszug ? ausAuszug.endsaldo_cent : null,
      auszugDatum: ausAuszug ? ausAuszug.endsaldo_datum : null,
    };
  });

  /*
   * Geprueft wird von selbst, sobald ein Auszug einen Endsaldo mitgebracht
   * hat. Eine eigene Angabe geht vor - wer den Auszug vor sich hat, weiss es
   * besser als die zuletzt eingelesene Datei.
   */
  const vonHandKonto = d && d.bankKonto ? String(d.bankKonto) : null;
  const vonHandSaldo = d && d.auszugSaldoCent !== undefined && d.auszugSaldoCent !== null && d.auszugSaldoCent !== ""
    ? Math.round(Number(d.auszugSaldoCent)) : null;

  const ausDatei = banken.find((b) => b.auszugSaldoCent !== null);
  const auszugKonto = vonHandKonto || (ausDatei ? ausDatei.konto : null);
  const gepruefteBank = auszugKonto ? banken.find((b) => b.konto === auszugKonto) : null;
  const auszugSaldo = vonHandSaldo !== null ? vonHandSaldo
    : (gepruefteBank ? gepruefteBank.auszugSaldoCent : null);
  const auszugAusDatei = vonHandSaldo === null && auszugSaldo !== null;
  const bankDifferenz = gepruefteBank && auszugSaldo !== null && auszugSaldo !== undefined
    ? auszugSaldo - gepruefteBank.erwarteterSaldoCent : null;

  /* --- Personenkonten --- */
  const rg = rechnungen(firmaId, stichtag).filter((r) => r.offenCent !== 0);
  const zlg = zahlungen(firmaId, stichtag).filter((z) => z.offenCent !== 0);

  const partner = db.prepare("SELECT * FROM buch_partner WHERE firma_id = ? ORDER BY typ, konto").all(firmaId);
  const konten = partner.map((p) => {
    const saldo = kontosaldo(firmaId, p.konto, stichtag);
    const meineRg = rg.filter((r) => r.partnerId === p.id);
    const meineZlg = zlg.filter((z) => z.partnerId === p.id);
    const offenSumme = meineRg.reduce((s, r) => s + r.offenCent, 0);
    const nichtZugeordnet = meineZlg.reduce((s, z) => s + z.offenCent, 0);
    /*
     * Fuer einen Debitor ist ein Sollsaldo eine Forderung, fuer einen Kreditor
     * ein Habensaldo eine Schuld. Damit beide Seiten vergleichbar sind, wird
     * der Kreditorensaldo umgedreht.
     */
    const vorzeichen = p.typ === "Kreditor" ? -1 : 1;
    const saldoOffen = saldo * vorzeichen;
    return {
      id: p.id, typ: p.typ, konto: p.konto, name: p.name,
      saldoCent: saldoOffen,
      offeneRechnungenCent: offenSumme,
      nichtZugeordneteZahlungenCent: nichtZugeordnet,
      // Muss aufgehen: Saldo = offene Rechnungen - noch nicht zugeordnete Zahlungen
      differenzCent: saldoOffen - (offenSumme - nichtZugeordnet),
      anzahlOffen: meineRg.length,
    };
  }).filter((k) => k.saldoCent !== 0 || k.offeneRechnungenCent !== 0 || k.nichtZugeordneteZahlungenCent !== 0);

  const summe = (liste, feld) => liste.reduce((s, x) => s + x[feld], 0);
  const debitoren = konten.filter((k) => k.typ === "Debitor");
  const kreditoren = konten.filter((k) => k.typ === "Kreditor");

  /* --- Befunde --- */
  const befunde = [];
  if (bankDifferenz !== null && bankDifferenz !== 0) {
    /*
     * Bevor eine Abweichung als Fehler durchgeht, wird der haeufigste Grund
     * geprueft: der Anfangsbestand. Wer mitten im Jahr anfaengt zu buchen, hat
     * den Kontostand vom Vortag nirgends stehen - die Differenz ist dann genau
     * dieser Betrag und kein Fehler, sondern eine fehlende Eroeffnungsbuchung.
     * Das steht im Kontoauszug selbst und laesst sich deshalb ausrechnen.
     */
    const anfang = db.prepare(`
      SELECT anfangsaldo_cent, anfang_datum FROM buch_bankimporte
       WHERE firma_id = ? AND konto = ? AND anfangsaldo_cent IS NOT NULL
       ORDER BY anfang_datum ASC, id ASC LIMIT 1`).get(firmaId, gepruefteBank.konto);

    if (anfang && bankDifferenz === anfang.anfangsaldo_cent) {
      befunde.push({ schwere: "hinweis", titel: "Es fehlt der Anfangsbestand des Bankkontos",
        text: "Der Unterschied von " + (bankDifferenz / 100).toFixed(2) + " EUR ist genau der Kontostand " +
          "vor dem ersten eingelesenen Umsatz (" + anfang.anfang_datum + "). Das ist kein Fehler: Die " +
          "Buchführung beginnt später als das Konto. Sobald der Eröffnungswert gebucht ist — die Zahlen " +
          "dafür kommen aus der Eröffnungsbilanz der Kanzlei — geht die Abstimmung auf." });
    } else {
      befunde.push({ schwere: "fehler", titel: "Banksaldo stimmt nicht mit dem Kontoauszug überein",
        text: "Laut " + (auszugAusDatei ? "Kontoauszug (aus der eingelesenen Datei)" : "Auszug") + " " +
          (auszugSaldo / 100).toFixed(2) + " EUR, nach Buchführung und eingelesenen " +
          "Umsätzen " + (gepruefteBank.erwarteterSaldoCent / 100).toFixed(2) + " EUR — Unterschied " +
          (bankDifferenz / 100).toFixed(2) + " EUR." +
          (anfang ? " Der Anfangsbestand am " + anfang.anfang_datum + " betrug " +
            (anfang.anfangsaldo_cent / 100).toFixed(2) + " EUR; ist der noch nicht gebucht, erklärt er " +
            "einen Teil davon." : " Meist fehlen Umsätze im Import oder der Auszug endet woanders.") });
    }
  } else if (bankDifferenz === 0) {
    befunde.push({ schwere: "ok", titel: "Bankkonto stimmt",
      text: "Der Kontoauszug und die Buchführung kommen zum Stichtag auf denselben Betrag." });
  }

  const mitLuecken = db.prepare(`
    SELECT konto, dateiname, saldo_luecken FROM buch_bankimporte
     WHERE firma_id = ? AND saldo_luecken > 0 ORDER BY id DESC LIMIT 3`).all(firmaId);
  if (mitLuecken.length) {
    befunde.push({ schwere: "warnung", titel: "Ein eingelesener Auszug ist nicht lückenlos",
      text: "In " + mitLuecken.map((m) => "„" + m.dateiname + "“ (" + m.saldo_luecken + ")").join(", ") +
        " passt die Saldenkette nicht durchgehend zusammen. Das heißt: Der Auszug enthält nicht alle " +
        "Umsätze des Zeitraums — meist, weil beim Herunterladen gefiltert wurde. Bitte vollständig " +
        "erneut herunterladen; fehlende Umsätze fehlen sonst auch in der Buchführung." });
  }

  const nichtGebucht = banken.reduce((s, b) => s + b.nichtGebuchtAnzahl, 0);
  if (nichtGebucht) {
    befunde.push({ schwere: "warnung", titel: nichtGebucht + " eingelesene Umsätze sind noch nicht gebucht",
      text: "Sie stehen im Kontoauszug, aber noch nicht in der Buchführung. Bis dahin fehlen sie in " +
        "jeder Auswertung und im Paket für den Steuerberater." });
  }

  const zuordnungsfehler = konten.filter((k) => k.differenzCent !== 0);
  if (zuordnungsfehler.length) {
    befunde.push({ schwere: "fehler", titel: "Personenkonten gehen rechnerisch nicht auf",
      text: "Bei " + zuordnungsfehler.length + " Geschäftspartner(n) passt der Kontosaldo nicht zur Summe " +
        "der offenen Posten. Das deutet auf eine Buchung, die zwar auf dem Personenkonto steht, aber " +
        "weder Rechnung noch Zahlung ist.",
      konten: zuordnungsfehler.map((k) => k.konto + " " + k.name).slice(0, 10) });
  }

  const offeneZahlungen = zlg.length;
  if (offeneZahlungen) {
    befunde.push({ schwere: "warnung", titel: offeneZahlungen + " Zahlung(en) ohne zugeordnete Rechnung",
      text: "Das Geld ist gebucht, aber es steht nicht fest, welche Rechnung damit bezahlt wurde. " +
        "Solange das offen ist, stimmt die Liste der offenen Posten nicht." });
  }

  const ueberfaellig = rg.filter((r) => r.art === "Ausgangsrechnung" && r.tageOffen > 30);
  if (ueberfaellig.length) {
    befunde.push({ schwere: "hinweis", titel: ueberfaellig.length + " Forderung(en) über 30 Tage überfällig",
      text: "Zusammen " + (ueberfaellig.reduce((s, r) => s + r.offenCent, 0) / 100).toFixed(2) + " EUR." });
  }
  if (!befunde.some((b) => b.schwere === "fehler" || b.schwere === "warnung")) {
    befunde.unshift({ schwere: "ok", titel: "Nichts zu beanstanden",
      text: "Offene Posten und Kontensalden stimmen überein." });
  }

  return json(200, {
    stichtag,
    banken, auszugKonto: auszugKonto || null, auszugSaldoCent: auszugSaldo,
    auszugAusDatei, bankDifferenzCent: bankDifferenz,
    debitoren: { konten: debitoren, saldoCent: summe(debitoren, "saldoCent"),
      offenCent: summe(debitoren, "offeneRechnungenCent"),
      nichtZugeordnetCent: summe(debitoren, "nichtZugeordneteZahlungenCent") },
    kreditoren: { konten: kreditoren, saldoCent: summe(kreditoren, "saldoCent"),
      offenCent: summe(kreditoren, "offeneRechnungenCent"),
      nichtZugeordnetCent: summe(kreditoren, "nichtZugeordneteZahlungenCent") },
    offeneZahlungen: zlg,
    befunde,
  });
}

module.exports = { offenePosten, ausgleichen, ausgleichLoesen, saldenabgleich,
  rechnungen, zahlungen, kontosaldo };
