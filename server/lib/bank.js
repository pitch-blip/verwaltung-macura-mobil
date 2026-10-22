"use strict";
/**
 * Bankumsaetze: einlesen, zuordnen, buchen.
 *
 * Ein eingelesener Umsatz ist zunaechst nur eine Beobachtung - die Bank sagt,
 * dass Geld geflossen ist. Eine Buchung wird daraus erst, wenn feststeht,
 * wogegen. Beides wird deshalb getrennt gehalten: Der Umsatz bleibt als
 * Nachweis stehen, auch nachdem er gebucht wurde, und traegt die Verbindung
 * zum Beleg.
 *
 * Automatisch gebucht wird nichts. Vorgeschlagen ja - entschieden wird von
 * Hand. Eine falsch zugeordnete Zahlung faellt sonst erst beim Mahnen auf,
 * und dann beim Kunden.
 */

const { db } = require("./db");
const R = require("./rechte");
const B = require("./buchhaltung");
const OP = require("./offeneposten");
const csv = require("./bankcsv");
const SZ = require("./sammelzahlung");
const REG = require("./regeln");

const Verweigert = R.Verweigert;
const json = (status, koerper) => ({ status, koerper });

/* ------------------------------------------------------------- Einlesen */

function geldkonto(firmaId, nummer) {
  const k = db.prepare("SELECT * FROM buch_konten WHERE firma_id = ? AND nummer = ?").get(firmaId, String(nummer));
  if (!k) throw new Verweigert("Das Konto " + nummer + " gibt es nicht.", 404);
  if (k.geld !== "Bank") {
    // Auch hier und nicht nur in der Oberflaeche: Ein Kontoauszug auf dem
    // Kassenkonto verfaelscht Kassenbuch und Abstimmung gleichermassen, und
    // zurueckdrehen liesse sich das nur ueber Stornobuchungen.
    throw new Verweigert("Konto " + nummer + " ist kein Bankkonto. Kontoauszüge lassen sich nur auf " +
      "Konten einlesen, die unter „Konten“ die Art „Bank“ tragen — ein Kassenbuch entsteht aus Belegen, " +
      "nicht aus einer Datei.", 400);
  }
  return k;
}

/**
 * Liest eine Datei ein und legt die neuen Umsaetze an.
 *
 * Ueberlappende Zeitraeume sind der Normalfall - wer jede Woche herunterlaedt,
 * hat dieselben Umsaetze mehrfach in der Hand. Bereits Vorhandenes wird
 * deshalb erkannt und uebergangen, nicht ein zweites Mal angelegt.
 */
function importieren(sitzung, d) {
  R.fordereSchreiben(sitzung, "buchhaltung");
  const firmaId = sitzung.firmaId;
  const konto = geldkonto(firmaId, d.konto);

  const gelesen = csv.lesen(d.daten, d.zuordnung);
  if (gelesen.fehlerhaft) {
    // Nicht raten: Der Benutzer bekommt die Kopfzeile zurueck und ordnet zu.
    return json(409, { spaltenFehlen: true, fehlt: gelesen.fehlt, kopf: gelesen.kopf,
      beispiel: gelesen.beispiel, erkannt: gelesen.erkannt });
  }
  if (!gelesen.umsaetze.length) {
    throw new Verweigert("In der Datei steht kein einziger Umsatz.", 400);
  }
  if (gelesen.fremdwaehrung) {
    throw new Verweigert("Die Datei enthält " + gelesen.fremdwaehrung + " Umsätze in fremder Währung. " +
      "Die werden nicht eingelesen — Umrechnungskurse gehören in die Hand des Steuerberaters.", 400);
  }

  /*
   * Laufende Nummer gleicher Umsaetze. Zwei am selben Tag wirklich gleiche
   * Buchungen - etwa zweimal dieselbe Gebuehr - muessen beide bleiben; beim
   * zweiten Einlesen ergeben sich dieselben Nummern und damit dieselben
   * Kennungen, sodass nichts doppelt entsteht.
   */
  const zaehler = new Map();
  const mitKennung = gelesen.umsaetze.map((u) => {
    const basis = [u.datum, u.centBetrag, u.iban, u.beteiligter, u.zweck].join("|");
    const n = (zaehler.get(basis) || 0) + 1;
    zaehler.set(basis, n);
    return Object.assign({}, u, { kennung: csv.kennung(konto.nummer, u, n) });
  });

  const datumsListe = mitKennung.map((u) => u.datum).sort();
  const salden = gelesen.salden || { vorhanden: false };
  const importId = db.prepare(`INSERT INTO buch_bankimporte
    (firma_id, konto, dateiname, zeilen, von, bis, endsaldo_cent, endsaldo_datum, saldo_luecken,
     anfangsaldo_cent, anfang_datum, erstellt_von)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(firmaId, konto.nummer, String(d.dateiname || "Kontoauszug.csv").slice(0, 120),
      mitKennung.length, datumsListe[0], datumsListe[datumsListe.length - 1],
      salden.vorhanden && salden.stimmt ? salden.endeCent : null,
      salden.vorhanden && salden.stimmt ? salden.endeDatum : null,
      salden.vorhanden ? salden.luecken : null,
      salden.vorhanden && salden.stimmt ? salden.anfangCent : null,
      salden.vorhanden && salden.stimmt ? salden.anfangDatum : null,
      sitzung.anmeldename).lastInsertRowid;

  const vorhanden = db.prepare("SELECT 1 FROM buch_bankumsaetze WHERE firma_id = ? AND kennung = ?");
  const einfuegen = db.prepare(`INSERT INTO buch_bankumsaetze
    (firma_id, import_id, konto, datum, valuta, betrag_cent, waehrung, beteiligter, iban, bic,
     zweck, buchungstext, referenz, kennung) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  let neu = 0, doppelt = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const u of mitKennung) {
      if (vorhanden.get(firmaId, u.kennung)) { doppelt++; continue; }
      einfuegen.run(firmaId, importId, konto.nummer, u.datum, u.valuta, u.centBetrag, u.waehrung,
        u.beteiligter || null, u.iban || null, u.bic || null, u.zweck || null,
        u.buchungstext || null, u.referenz || null, u.kennung);
      neu++;
    }
    db.prepare("UPDATE buch_bankimporte SET neu = ?, doppelt = ?, uebersprungen = ? WHERE id = ?")
      .run(neu, doppelt, gelesen.uebersprungen.length, importId);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }

  B.protokoll(sitzung, konto.nummer, "Kontoauszug eingelesen",
    `${d.dateiname || "Datei"}: ${neu} neue Umsätze, ${doppelt} bereits vorhanden, ` +
    `Zeitraum ${datumsListe[0]} bis ${datumsListe[datumsListe.length - 1]}` +
    (salden.vorhanden
      ? `, Endsaldo ${(salden.endeCent / 100).toFixed(2)} EUR (Gegenprobe ` +
        (salden.stimmt ? "stimmt" : "WEICHT AB") + (salden.luecken ? `, ${salden.luecken} Lücken` : "") + ")."
      : "."));

  return json(201, { importId, konto: konto.nummer, gelesen: mitKennung.length, neu, doppelt,
    uebersprungen: gelesen.uebersprungen, von: datumsListe[0], bis: datumsListe[datumsListe.length - 1],
    erkannt: gelesen.erkannt, kopf: gelesen.kopf, salden });
}

/* --------------------------------------------------------------- Listen */

function umsatzNachAussen(u) {
  return { id: u.id, konto: u.konto, datum: u.datum, valuta: u.valuta,
    centBetrag: u.betrag_cent, waehrung: u.waehrung,
    beteiligter: u.beteiligter, iban: u.iban, zweck: u.zweck,
    buchungstext: u.buchungstext, referenz: u.referenz,
    status: u.status, belegId: u.beleg_id, journalNr: u.journal_nr || null,
    notiz: u.notiz, angelegtAm: u.angelegt_am };
}

function umsaetze(sitzung, filter) {
  R.fordereLesen(sitzung, "buchhaltung");
  const bedingungen = ["u.firma_id = ?"];
  const werte = [sitzung.firmaId];
  if (filter && /^\d{4}-\d{2}-\d{2}$/.test(filter.von)) { bedingungen.push("u.datum >= ?"); werte.push(filter.von); }
  if (filter && /^\d{4}-\d{2}-\d{2}$/.test(filter.bis)) { bedingungen.push("u.datum <= ?"); werte.push(filter.bis); }
  if (filter && ["offen", "gebucht", "ignoriert"].includes(filter.status)) {
    bedingungen.push("u.status = ?"); werte.push(filter.status);
  }
  if (filter && filter.konto) { bedingungen.push("u.konto = ?"); werte.push(String(filter.konto)); }

  return db.prepare(`SELECT u.*, b.journal_nr FROM buch_bankumsaetze u
      LEFT JOIN buch_belege b ON b.id = u.beleg_id
     WHERE ${bedingungen.join(" AND ")} ORDER BY u.datum DESC, u.id DESC`)
    .all(...werte).map(umsatzNachAussen);
}

function importe(sitzung) {
  R.fordereLesen(sitzung, "buchhaltung");
  return db.prepare("SELECT * FROM buch_bankimporte WHERE firma_id = ? ORDER BY id DESC LIMIT 50")
    .all(sitzung.firmaId).map((i) => ({ id: i.id, konto: i.konto, dateiname: i.dateiname,
      zeilen: i.zeilen, neu: i.neu, doppelt: i.doppelt, von: i.von, bis: i.bis,
      endsaldoCent: i.endsaldo_cent, endsaldoDatum: i.endsaldo_datum, luecken: i.saldo_luecken,
      erstelltAm: i.erstellt_am, erstelltVon: i.erstellt_von }));
}

/* ------------------------------------------------- Zahlungsbeteiligte */

/**
 * Wer taucht im Kontoauszug auf, ohne dass es ihn als Geschaeftspartner gibt?
 *
 * Beim ersten Einlesen sind das schnell vierzig Namen - Krankenkassen,
 * Privatzahler, Lieferanten. Jeden einzeln anzulegen waere eine halbe Stunde
 * Tipparbeit, und die IBAN dabei abzuschreiben eine Fehlerquelle. Deshalb
 * hier gesammelt, mit Anzahl und Summe, damit sich sehen laesst, wer sich
 * ueberhaupt lohnt.
 *
 * Angelegt wird nichts von selbst: Nicht jeder Zahlungsbeteiligte ist ein
 * Geschaeftspartner - die eigene Tochtergesellschaft, das Finanzamt und die
 * Bank selbst gehoeren nicht dazu.
 */
function beteiligte(sitzung) {
  R.fordereLesen(sitzung, "buchhaltung");
  const firmaId = sitzung.firmaId;
  const vorhanden = db.prepare("SELECT * FROM buch_partner WHERE firma_id = ?").all(firmaId);
  const nachIban = new Map(vorhanden.filter((p) => p.iban)
    .map((p) => [p.iban.replace(/\s/g, "").toUpperCase(), p]));
  const nachName = vorhanden.map((p) => ({ p, n: normal(p.name) })).filter((x) => x.n.length >= 4);

  const gruppen = new Map();
  const umsaetze = db.prepare(`SELECT * FROM buch_bankumsaetze
     WHERE firma_id = ? AND status = 'offen' ORDER BY datum DESC`).all(firmaId);

  for (const u of umsaetze) {
    const name = String(u.beteiligter || "").trim();
    const iban = String(u.iban || "").replace(/\s/g, "").toUpperCase();
    if (!name && !iban) continue;

    // Schon bekannt? Dann gehoert er nicht auf diese Liste.
    if (iban && nachIban.has(iban)) continue;
    const n = normal(name);
    if (n.length >= 4 && nachName.some((x) => x.n.includes(n) || n.includes(x.n))) continue;

    const schluessel = iban || "name:" + n;
    if (!gruppen.has(schluessel)) {
      gruppen.set(schluessel, { name, iban: iban || null, anzahl: 0, centSumme: 0,
        eingaenge: 0, ausgaenge: 0, von: u.datum, bis: u.datum });
    }
    const g = gruppen.get(schluessel);
    g.anzahl++;
    g.centSumme += u.betrag_cent;
    if (u.betrag_cent > 0) g.eingaenge++; else g.ausgaenge++;
    if (u.datum < g.von) g.von = u.datum;
    if (u.datum > g.bis) g.bis = u.datum;
    // Der laengere Name ist meist der vollstaendigere.
    if (name.length > g.name.length) g.name = name;
  }

  return [...gruppen.values()]
    .map((g) => Object.assign(g, {
      /*
       * Wer ueberwiegend zahlt, ist ein Kunde; wer ueberwiegend Geld bekommt,
       * ein Lieferant. Bei gleich vielen Bewegungen entscheidet die Summe -
       * bei einem Verrechnungskonto mit zwei Ein- und zwei Ausgaengen sagt
       * erst sie, in welche Richtung es ueberhaupt geht. Die Vorbelegung
       * laesst sich beim Uebernehmen aendern.
       */
      vorschlagTyp: g.eingaenge > g.ausgaenge ? "Debitor"
        : g.eingaenge < g.ausgaenge ? "Kreditor"
        : (g.centSumme >= 0 ? "Debitor" : "Kreditor"),
    }))
    .sort((a, b) => b.anzahl - a.anzahl || Math.abs(b.centSumme) - Math.abs(a.centSumme));
}

/** Legt aus der Liste Geschaeftspartner an - mit IBAN, damit die Erkennung greift. */
function beteiligteUebernehmen(sitzung, liste) {
  R.fordereSchreiben(sitzung, "buchhaltung");
  if (!Array.isArray(liste) || !liste.length) throw new Verweigert("Nichts ausgewählt.", 400);

  const angelegt = [];
  const uebergangen = [];
  for (const e of liste) {
    const name = String(e.name || "").trim();
    if (!name) { uebergangen.push({ name: e.name, grund: "ohne Namen" }); continue; }
    try {
      const a = B.partnerSpeichern(sitzung, null, {
        typ: e.typ === "Kreditor" ? "Kreditor" : "Debitor",
        name, iban: e.iban || null,
      }).koerper;
      angelegt.push({ name, konto: a.konto, typ: e.typ === "Kreditor" ? "Kreditor" : "Debitor" });
    } catch (err) {
      uebergangen.push({ name, grund: err.message });
    }
  }
  if (angelegt.length) {
    B.protokoll(sitzung, "Bank", "Zahlungsbeteiligte übernommen",
      angelegt.length + " Geschäftspartner aus dem Kontoauszug angelegt: " +
      angelegt.map((a) => a.konto + " " + a.name).slice(0, 8).join(", ") +
      (angelegt.length > 8 ? " …" : "") + ".");
  }
  return json(201, { angelegt, uebergangen });
}

/* ------------------------------------------------------------ Vorschlaege */

/*
 * Namen auf das Wesentliche kuerzen. Bewusst dieselbe Fassung wie bei den
 * Zuordnungsregeln: Was dort als derselbe Zahlungsbeteiligte gilt, muss auch
 * hier einer sein - sonst schlaegt die Regel an, wo der Partner nicht erkannt
 * wird, und umgekehrt.
 */
const normal = REG.normal;

/**
 * Belegnummer im Verwendungszweck suchen.
 *
 * Zahlungsavise schreiben die Rechnungsnummer unterschiedlich: mit und ohne
 * Bindestrich, mit Praefix, in Grossbuchstaben. Verglichen wird deshalb ohne
 * Trennzeichen. Sehr kurze Nummern werden ausgenommen - eine "7" fände sich
 * in jedem Verwendungszweck.
 */
function nummerGefunden(belegnummer, zweck) {
  const n = String(belegnummer || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (n.length < 4) return false;
  const z = String(zweck || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return z.includes(n);
}

/**
 * Vorschlaege fuer einen Umsatz.
 *
 * Bewertet wird in Punkten, und jeder Punkt wird begruendet - damit
 * nachvollziehbar bleibt, warum etwas oben steht. Entschieden wird von Hand.
 */
function vorschlaege(sitzung, umsatzId, gewuenschterPartner) {
  R.fordereLesen(sitzung, "buchhaltung");
  const firmaId = sitzung.firmaId;
  const u = db.prepare("SELECT * FROM buch_bankumsaetze WHERE id = ? AND firma_id = ?").get(umsatzId, firmaId);
  if (!u) throw new Verweigert("Umsatz nicht gefunden.", 404);

  const eingang = u.betrag_cent > 0;
  const betrag = Math.abs(u.betrag_cent);
  const gesucht = eingang ? "Ausgangsrechnung" : "Eingangsrechnung";

  const offen = OP.rechnungen(firmaId).filter((r) => r.offenCent > 0 && r.art === gesucht);
  const partner = db.prepare("SELECT * FROM buch_partner WHERE firma_id = ?").all(firmaId);

  /*
   * Zuordnungsregel. Sie geht allem anderen vor: Eine Regel ist eine bewusst
   * getroffene Festlegung, IBAN- und Namenserkennung sind nur Vermutungen.
   * Eine Zahlerregel bestimmt dabei nur, von wem das Geld kommt - was gebucht
   * wird, entscheidet die Rechnung dahinter.
   */
  const regel = REG.passend(firmaId, u);
  const regelZahler = regel && regel.ziel === "Zahler" && regel.partnerId ? regel.partnerId : null;

  const ibanTreffer = u.iban
    ? partner.filter((p) => p.iban && p.iban.replace(/\s/g, "").toUpperCase() === u.iban) : [];
  const nameNormal = normal(u.beteiligter);
  const nameTreffer = nameNormal.length >= 4
    ? partner.filter((p) => { const n = normal(p.name); return n.length >= 4 && (n.includes(nameNormal) || nameNormal.includes(n)); })
    : [];

  const bewertet = offen.map((r) => {
    let punkte = 0;
    const gruende = [];
    if (nummerGefunden(r.belegnummer, u.zweck)) {
      punkte += 60; gruende.push("Belegnummer " + r.belegnummer + " steht im Verwendungszweck");
    }
    if (r.offenCent === betrag) { punkte += 40; gruende.push("Betrag stimmt genau mit dem offenen Rest überein"); }
    else if (r.bruttoCent === betrag) { punkte += 35; gruende.push("Betrag stimmt mit der Rechnungssumme überein"); }
    else if (betrag < r.offenCent) { punkte += 5; gruende.push("wäre eine Teilzahlung"); }
    if (r.partnerId && regelZahler === r.partnerId) {
      punkte += 30; gruende.push("Regel „" + regel.name + "“ weist diesen Zahler zu");
    } else if (r.partnerId && ibanTreffer.some((p) => p.id === r.partnerId)) {
      punkte += 30; gruende.push("IBAN gehört zu diesem Geschäftspartner");
    } else if (r.partnerId && nameTreffer.some((p) => p.id === r.partnerId)) {
      punkte += 20; gruende.push("Name des Zahlungsbeteiligten passt");
    }
    if (u.datum >= r.datum) {
      punkte += 5;
      const tage = Math.floor((new Date(u.datum) - new Date(r.datum)) / 86400000);
      if (tage <= 90) { punkte += 5; gruende.push("Zahlung " + tage + " Tage nach dem Rechnungsdatum"); }
    } else {
      punkte -= 15; gruende.push("Zahlung liegt vor dem Rechnungsdatum");
    }
    return Object.assign({}, r, { punkte, gruende });
  }).filter((r) => r.punkte >= 30).sort((a, b) => b.punkte - a.punkte).slice(0, 8);

  /*
   * Sammelzahlung aufschluesseln.
   *
   * Grosszahler - Krankenkassen vor allem - begleichen mit einem Betrag
   * mehrere Rechnungen auf einmal. Gesucht wird deshalb die Teilmenge der
   * offenen Posten, die genau diesen Betrag ergibt. Gesucht wird immer nur
   * innerhalb eines Zahlers: Eine Kombination quer ueber mehrere
   * Geschaeftspartner waere zwar rechnerisch moeglich, fachlich aber Unsinn.
   */
  const sammel = [];
  const erzwungen = gewuenschterPartner ? [Number(gewuenschterPartner)]
    : (regelZahler ? [regelZahler] : []);
  const kandidatenPartner = [...new Set(
    erzwungen.concat([...ibanTreffer, ...nameTreffer].map((p) => p.id)))];

  for (const pid of kandidatenPartner) {
    const seine = offen.filter((r) => r.partnerId === pid);
    if (seine.length < 2) continue;
    const a = SZ.aufschluesseln(seine, betrag, u.zweck);
    if (!a.kombinationen.length) {
      // Nichts gefunden - aber nur dann eine Aussage, wenn wirklich alles
      // durchsucht wurde. Sonst hiesse "nichts gefunden" nur "nicht gesucht".
      if (a.abgebrochen) {
        sammel.push({ partnerId: pid, partner: (partner.find((p) => p.id === pid) || {}).name,
          abgebrochen: true, offeneAnzahl: seine.length });
      }
      continue;
    }
    sammel.push({
      partnerId: pid, partner: (partner.find((p) => p.id === pid) || {}).name,
      offeneAnzahl: seine.length,
      offeneSumme: seine.reduce((s, r) => s + r.offenCent, 0),
      kombinationen: a.kombinationen.slice(0, 6),
      weitere: Math.max(0, a.kombinationen.length - 6),
      eindeutig: a.eindeutig, mehrdeutig: a.mehrdeutig, betragsgleich: a.betragsgleich,
      abgebrochen: a.abgebrochen,
    });
  }

  /*
   * Zuordnungsregel. Sie geht dem Verlauf vor: Eine Regel ist eine bewusst
   * getroffene Festlegung, der Verlauf nur eine Beobachtung.
   */
  /*
   * Kein Rechnungsbezug - etwa Gebuehren, Loehne, Steuern. Dann hilft, was
   * beim selben Zahlungsbeteiligten zuletzt gebucht wurde.
   */
  let kontoVorschlag = null;
  if (regelZahler) {
    // kein Kontovorschlag: hier wird gegen offene Rechnungen gebucht
  } else if (regel && regel.gegenkonto) {
    const k = B.kontoAufloesen(firmaId, regel.gegenkonto);
    if (k) kontoVorschlag = { konto: k.nummer, bezeichnung: k.bezeichnung,
      buchungstext: regel.buchungstext, steuersatz: regel.steuersatz, bu: regel.bu,
      ausRegel: true, regelId: regel.id, regelName: regel.name,
      grund: "Regel „" + regel.name + "“: " + regel.gruende.join(", ") };
  } else if (u.beteiligter) {
    const frueher = db.prepare(`
      SELECT b.soll_konto, b.haben_konto, b.buchungstext, COUNT(*) AS n
        FROM buch_bankumsaetze v JOIN buch_belege b ON b.id = v.beleg_id
       WHERE v.firma_id = ? AND v.beteiligter = ? AND v.id <> ? AND v.beleg_id IS NOT NULL
       GROUP BY b.soll_konto, b.haben_konto ORDER BY n DESC LIMIT 1`)
      .get(firmaId, u.beteiligter, u.id);
    if (frueher) {
      const gegen = eingang ? frueher.haben_konto : frueher.soll_konto;
      const k = B.kontoAufloesen(firmaId, gegen);
      if (k) kontoVorschlag = { konto: k.nummer, bezeichnung: k.bezeichnung,
        buchungstext: frueher.buchungstext,
        grund: "Bei „" + u.beteiligter + "“ wurde zuletzt auf dieses Konto gebucht" };
    }
  }

  const partnerVorschlag = gewuenschterPartner
    ? partner.find((p) => String(p.id) === String(gewuenschterPartner))
    : (regelZahler ? partner.find((p) => p.id === regelZahler) : null)
      || ibanTreffer[0] || nameTreffer[0] || null;

  /*
   * Alle offenen Posten des erkannten Zahlers - damit sich von Hand aufteilen
   * laesst, wenn keine Kombination genau aufgeht. Das ist der haeufigste Fall
   * bei gekuerzten Zahlungen: Die Kasse zahlt weniger als berechnet, und dann
   * gibt es keine Teilmenge, die stimmt.
   */
  const seineOffenen = partnerVorschlag
    ? offen.filter((r) => r.partnerId === partnerVorschlag.id) : [];

  return json(200, {
    umsatz: umsatzNachAussen(u),
    richtung: eingang ? "Eingang" : "Ausgang",
    rechnungen: bewertet, sammelzahlungen: sammel,
    offenePosten: seineOffenen,
    zahler: partner.filter((p) => p.aktiv && p.typ === (eingang ? "Debitor" : "Kreditor"))
      .map((p) => ({ id: p.id, konto: p.konto, name: p.name })),
    kontoVorschlag, regel,
    partnerVorschlag: partnerVorschlag
      ? { id: partnerVorschlag.id, konto: partnerVorschlag.konto, name: partnerVorschlag.name,
          grund: regelZahler === partnerVorschlag.id ? "Regel „" + regel.name + "“ weist diesen Zahler zu"
            : ibanTreffer.some((p) => p.id === partnerVorschlag.id) ? "über die IBAN erkannt"
            : "über den Namen erkannt" }
      : null,
  });
}

/* ---------------------------------------------------------------- Buchen */

/**
 * Bucht einen Umsatz.
 *
 * Zwei Wege: gegen offene Rechnungen (dann entsteht eine Zahlung und die
 * Rechnungen werden ausgeglichen) oder gegen ein Sachkonto (Gebuehren, Loehne,
 * Steuern - alles ohne Rechnungsbezug).
 *
 * Die Buchung selbst legt buchhaltung.js an; damit gelten hier dieselben
 * Regeln wie bei jeder anderen Erfassung - Journalnummer, Festschreibung,
 * abgeschlossene Zeitraeume.
 */
function buchen(sitzung, umsatzId, d) {
  R.fordereSchreiben(sitzung, "buchhaltung");
  const firmaId = sitzung.firmaId;
  const u = db.prepare("SELECT * FROM buch_bankumsaetze WHERE id = ? AND firma_id = ?").get(umsatzId, firmaId);
  if (!u) throw new Verweigert("Umsatz nicht gefunden.", 404);
  if (u.status === "gebucht") throw new Verweigert("Dieser Umsatz ist bereits gebucht.", 409);

  const eingang = u.betrag_cent > 0;
  const betrag = Math.abs(u.betrag_cent);

  /*
   * Zwei Wege zur Aufteilung:
   *
   *   rechnungIds   Die Rechnungen sind genannt, die Betraege ergeben sich -
   *                 aelteste zuerst, bis die Zahlung aufgebraucht ist.
   *   zuordnungen   Zu jeder Rechnung steht der Betrag ausdruecklich dabei.
   *                 Das braucht es bei gekuerzten Zahlungen, wo keine
   *                 Zusammenstellung genau aufgeht und der Zahler selbst
   *                 entscheidet, welche Rechnung er wie weit begleicht.
   */
  const ausdruecklich = Array.isArray(d.zuordnungen)
    ? d.zuordnungen
        .map((z) => ({ id: Number(z.rechnungId), cent: Math.round(Number(z.betragCent)) }))
        .filter((z) => z.id && Number.isFinite(z.cent) && z.cent > 0)
    : [];
  const rechnungIds = ausdruecklich.length
    ? ausdruecklich.map((z) => z.id)
    : (Array.isArray(d.rechnungIds) ? d.rechnungIds.map(Number).filter(Boolean) : []);

  if (ausdruecklich.length) {
    const summe = ausdruecklich.reduce((s, z) => s + z.cent, 0);
    if (summe > betrag) {
      throw new Verweigert("Es sollen " + (summe / 100).toFixed(2) + " EUR zugeordnet werden, die Zahlung " +
        "beträgt aber nur " + (betrag / 100).toFixed(2) + " EUR.", 400);
    }
    const doppelt = rechnungIds.length !== new Set(rechnungIds).size;
    if (doppelt) throw new Verweigert("Dieselbe Rechnung steht mehrfach in der Aufteilung.", 400);
  }

  let beleg;
  if (rechnungIds.length) {
    /* -- gegen offene Rechnungen -- */
    const posten = rechnungIds.map((id) => {
      const r = db.prepare("SELECT * FROM buch_belege WHERE id = ? AND firma_id = ?").get(id, firmaId);
      if (!r) throw new Verweigert("Rechnung " + id + " nicht gefunden.", 404);
      return r;
    });
    const partnerIds = [...new Set(posten.map((r) => r.partner_id))];
    if (partnerIds.length !== 1 || !partnerIds[0]) {
      throw new Verweigert("Alle gewählten Rechnungen müssen zu demselben Geschäftspartner gehören.", 400);
    }
    const partner = db.prepare("SELECT * FROM buch_partner WHERE id = ? AND firma_id = ?")
      .get(partnerIds[0], firmaId);
    if (!partner) throw new Verweigert("Geschäftspartner nicht gefunden.", 404);

    const art = eingang ? "Zahlungseingang" : "Zahlungsausgang";
    beleg = B.belegSpeichern(sitzung, null, {
      art, datum: u.datum, belegnummer: String(d.belegnummer || u.referenz || u.datum).slice(0, 36),
      partnerId: partner.id,
      sollKonto: eingang ? u.konto : partner.konto,
      habenKonto: eingang ? partner.konto : u.konto,
      bruttoCent: betrag, steuersatz: 0,
      buchungstext: String(d.buchungstext || ("Zahlung " + partner.name)).slice(0, 60),
      notiz: u.zweck ? "Verwendungszweck: " + u.zweck : null,
    }).koerper;

    if (ausdruecklich.length) {
      // Genannte Betraege gelten, wie sie dastehen.
      for (const z of ausdruecklich) {
        OP.ausgleichen(sitzung, { rechnungId: z.id, zahlungId: beleg.id, betragCent: z.cent });
      }
    } else {
      // Ohne Angabe: aelteste Rechnung zuerst, so weit die Zahlung reicht.
      let rest = betrag;
      for (const r of posten.sort((a, b) => String(a.datum).localeCompare(String(b.datum)))) {
        if (rest <= 0) break;
        const schon = db.prepare("SELECT COALESCE(SUM(betrag_cent),0) n FROM buch_ausgleich WHERE rechnung_id = ?")
          .get(r.id).n;
        const offen = r.brutto_cent - schon;
        if (offen <= 0) continue;
        const teil = Math.min(offen, rest);
        OP.ausgleichen(sitzung, { rechnungId: r.id, zahlungId: beleg.id, betragCent: teil });
        rest -= teil;
      }
    }
  } else {
    /* -- gegen ein Sachkonto -- */
    const gegen = B.kontoAufloesen(firmaId, d.gegenkonto);
    if (!gegen) throw new Verweigert("Bitte ein Gegenkonto wählen.", 400);
    if (gegen.nummer === u.konto) throw new Verweigert("Das Gegenkonto darf nicht das Bankkonto selbst sein.", 400);
    beleg = B.belegSpeichern(sitzung, null, {
      art: d.art && B.ZAHLARTEN.includes(d.art) ? d.art : "Sonstiges",
      datum: u.datum,
      belegnummer: String(d.belegnummer || u.referenz || u.datum).slice(0, 36),
      partnerId: d.partnerId || null,
      sollKonto: eingang ? u.konto : gegen.nummer,
      habenKonto: eingang ? gegen.nummer : u.konto,
      bruttoCent: betrag,
      steuersatz: d.steuersatz === undefined ? 0 : d.steuersatz,
      bu: d.bu,
      buchungstext: String(d.buchungstext || u.zweck || u.buchungstext || "Bankumsatz").slice(0, 60),
      notiz: u.zweck ? "Verwendungszweck: " + u.zweck : null,
    }).koerper;
  }

  db.prepare("UPDATE buch_bankumsaetze SET status = 'gebucht', beleg_id = ? WHERE id = ?")
    .run(beleg.id, u.id);
  if (d.regelId) REG.verwendet(d.regelId);

  /*
   * Auf Wunsch wird aus dieser Zuordnung eine Regel. Das ist der Weg, auf dem
   * Regeln entstehen sollen - in dem Augenblick, in dem die Entscheidung
   * ohnehin faellt, nicht spaeter am Reissbrett.
   */
  let neueRegel = null;
  if (d.alsRegel && !rechnungIds.length && d.gegenkonto) {
    neueRegel = REG.ausUmsatz(sitzung, u, {
      gegenkonto: d.gegenkonto, steuersatz: d.steuersatz, bu: d.bu, art: d.art,
      buchungstext: String(d.buchungstext || "").slice(0, 60),
      automatisch: d.regelAutomatisch === true,
    }).koerper;
  }
  B.protokoll(sitzung, beleg.journalNr, "Bankumsatz gebucht",
    `${u.datum}, ${(u.betrag_cent / 100).toFixed(2)} EUR, ${u.beteiligter || "ohne Angabe"} ` +
    `als Buchung Nr. ${beleg.journalNr}` +
    (rechnungIds.length > 1 ? `, aufgeteilt auf ${rechnungIds.length} Rechnungen.` : "."));
  return json(201, { belegId: beleg.id, journalNr: beleg.journalNr,
    regelId: neueRegel ? neueRegel.id : null });
}

/**
 * Regeln auf die offenen Umsaetze anwenden.
 *
 * Nur Regeln, die ausdruecklich "ohne Rueckfrage" tragen, und nur auf Umsaetze
 * ohne Rechnungsbezug. Bewusst ein eigener Knopf und kein stilles Mitlaufen
 * beim Einlesen: Was gebucht wurde, soll jemand entschieden haben - und wer
 * hinterher wissen will, was geschehen ist, findet es in der Historie.
 */
function regelnAnwenden(sitzung) {
  R.fordereSchreiben(sitzung, "buchhaltung");
  const offene = db.prepare(
    "SELECT * FROM buch_bankumsaetze WHERE firma_id = ? AND status = 'offen' ORDER BY datum, id")
    .all(sitzung.firmaId);

  const gebucht = [];
  const uebergangen = [];
  for (const u of offene) {
    const regel = REG.passend(sitzung.firmaId, u);
    if (!regel) continue;
    if (!regel.automatisch) { uebergangen.push({ umsatzId: u.id, regel: regel.name }); continue; }

    /*
     * Zahlerregeln buchen nur, wenn die Rechnung dahinter zweifelsfrei
     * feststeht: genau eine offene Rechnung mit passendem Betrag oder genau
     * eine Zusammenstellung, die aufgeht. Alles andere bleibt liegen - eine
     * falsch ausgeglichene Rechnung faellt erst beim Mahnen auf, und dann
     * beim Kunden.
     */
    let auftrag = { gegenkonto: regel.gegenkonto, steuersatz: regel.steuersatz, bu: regel.bu,
      art: regel.art, partnerId: regel.partnerId,
      buchungstext: regel.buchungstext || u.zweck || u.buchungstext || regel.name,
      regelId: regel.id };

    if (regel.ziel === "Zahler") {
      const v = vorschlaege(sitzung, u.id).koerper;
      const genau = v.rechnungen.filter((r) => r.offenCent === Math.abs(u.betrag_cent));
      const eindeutigeSammel = v.sammelzahlungen.find((sz) => sz.eindeutig);
      if (genau.length === 1) {
        auftrag = { rechnungIds: [genau[0].id], regelId: regel.id,
          buchungstext: regel.buchungstext || ("Zahlung " + (v.partnerVorschlag || {}).name) };
      } else if (!genau.length && eindeutigeSammel) {
        auftrag = { rechnungIds: eindeutigeSammel.kombinationen[0].ids, regelId: regel.id,
          buchungstext: regel.buchungstext || ("Sammelzahlung " + eindeutigeSammel.partner) };
      } else {
        uebergangen.push({ umsatzId: u.id, regel: regel.name,
          grund: genau.length > 1
            ? genau.length + " offene Rechnungen passen zum Betrag — welche gemeint ist, muss jemand entscheiden"
            : "keine offene Rechnung und keine Zusammenstellung passt genau" });
        continue;
      }
    }

    try {
      const a = buchen(sitzung, u.id, auftrag).koerper;
      gebucht.push({ umsatzId: u.id, datum: u.datum, centBetrag: u.betrag_cent,
        beteiligter: u.beteiligter, regel: regel.name, journalNr: a.journalNr });
    } catch (e) {
      // Ein Umsatz, der sich nicht buchen laesst - etwa weil der Zeitraum
      // festgeschrieben ist -, darf die uebrigen nicht aufhalten.
      uebergangen.push({ umsatzId: u.id, regel: regel.name, fehler: e.message });
    }
  }

  if (gebucht.length) {
    B.protokoll(sitzung, "Regeln", "Zuordnungsregeln angewendet",
      gebucht.length + " Umsätze nach Regeln gebucht: " +
      [...new Set(gebucht.map((g) => g.regel))].join(", ") + ".");
  }
  return json(200, { gebucht, uebergangen });
}

/**
 * Umsatz beiseitelegen.
 *
 * Umbuchungen zwischen eigenen Konten tauchen auf beiden Auszuegen auf und
 * duerfen nur einmal gebucht werden. Geloescht wird trotzdem nichts - der
 * Umsatz bleibt mit Begruendung stehen.
 */
function ignorieren(sitzung, umsatzId, grund) {
  R.fordereSchreiben(sitzung, "buchhaltung");
  const u = db.prepare("SELECT * FROM buch_bankumsaetze WHERE id = ? AND firma_id = ?")
    .get(umsatzId, sitzung.firmaId);
  if (!u) throw new Verweigert("Umsatz nicht gefunden.", 404);
  if (u.status === "gebucht") throw new Verweigert("Ein gebuchter Umsatz lässt sich nicht beiseitelegen.", 409);
  const text = String(grund || "").trim();
  if (!text) throw new Verweigert("Bitte einen Grund angeben — sonst ist später nicht klar, warum der Umsatz fehlt.", 400);

  db.prepare("UPDATE buch_bankumsaetze SET status = 'ignoriert', notiz = ? WHERE id = ?").run(text, u.id);
  B.protokoll(sitzung, u.konto, "Bankumsatz beiseitegelegt",
    `${u.datum}, ${(u.betrag_cent / 100).toFixed(2)} EUR: ${text}`);
  return json(200, { ok: true });
}

/** Macht das Beiseitelegen rueckgaengig. */
function zuruecknehmen(sitzung, umsatzId) {
  R.fordereSchreiben(sitzung, "buchhaltung");
  const u = db.prepare("SELECT * FROM buch_bankumsaetze WHERE id = ? AND firma_id = ?")
    .get(umsatzId, sitzung.firmaId);
  if (!u) throw new Verweigert("Umsatz nicht gefunden.", 404);
  if (u.status !== "ignoriert") throw new Verweigert("Nur beiseitegelegte Umsätze lassen sich zurückholen.", 409);
  db.prepare("UPDATE buch_bankumsaetze SET status = 'offen', notiz = NULL WHERE id = ?").run(u.id);
  return json(200, { ok: true });
}

module.exports = { importieren, umsaetze, importe, vorschlaege, buchen, ignorieren, zuruecknehmen,
  regelnAnwenden, beteiligte, beteiligteUebernehmen,
  nummerGefunden, normal };
