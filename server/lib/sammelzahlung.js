"use strict";
/**
 * Sammelzahlungen aufschluesseln.
 *
 * Krankenkassen und andere Grosszahler begleichen selten eine einzelne
 * Rechnung. Es kommt ein Betrag an, und dahinter stehen fuenf, zehn oder
 * zwanzig Rechnungen - im Verwendungszweck steht dann bestenfalls "siehe Brief
 * vom 09.09.". Von Hand herauszufinden, welche Rechnungen das waren, ist
 * Rechenarbeit, die niemand gern macht und bei der man sich verzaehlt.
 *
 * Die Frage lautet: Welche Teilmenge der offenen Posten ergibt zusammen genau
 * diesen Betrag? Das ist das Teilsummenproblem - im Allgemeinen aufwaendig,
 * hier aber gutmuetig, weil die Zahl offener Rechnungen je Zahler klein ist
 * und alle Betraege positiv sind. Gesucht wird mit Tiefensuche und drei
 * Abkuerzungen: absteigend sortiert, mit Restsummen abgeschnitten, was nicht
 * mehr erreichbar ist, und mit einem festen Schrittbudget, damit die Suche
 * auch im ungluecklichsten Fall nach Bruchteilen einer Sekunde endet.
 *
 * Das Entscheidende ist aber nicht das Finden, sondern die Ehrlichkeit
 * danach: Gibt es mehrere Zusammenstellungen, die denselben Betrag ergeben -
 * bei gleichartigen Rechnungen die Regel -, dann kann keine Rechnung
 * entscheiden, welche gemeint war. Dann werden alle gezeigt und keine
 * vorausgewaehlt. Eine falsch ausgeglichene Rechnung faellt sonst erst beim
 * Mahnen auf, und dann beim Kunden.
 */

/** Ziffern und Buchstaben, damit "RE-2026-001" und "RE2026001" zusammenfallen. */
function blank(text) {
  return String(text || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

/**
 * Sucht Teilmengen, die genau die Zielsumme ergeben.
 *
 * posten: [{ id, offenCent, datum, belegnummer }]
 * Rueckgabe: { treffer, mehrdeutig, abgebrochen, geprueft }
 */
function kombinationen(posten, zielCent, opt) {
  const o = opt || {};
  const maxTreffer = o.maxTreffer || 12;      // mehr braucht niemand zu sehen
  const maxTiefe = o.maxTiefe || 12;          // eine Zahlung ueber mehr Rechnungen ist selten
  // Schrittbudget. Gemessen bleibt die Suche damit auch im ungluecklichsten
  // Fall - viele Posten, kein Treffer - unter 30 Millisekunden.
  const maxSchritte = o.maxSchritte || 800000;

  const ziel = Math.round(zielCent);
  // Nur was hineinpasst: Ein Posten groesser als die Zahlung kann nicht Teil
  // einer Summe sein, die genau aufgeht.
  const brauchbar = (posten || [])
    .filter((p) => p.offenCent > 0 && p.offenCent <= ziel)
    .sort((a, b) => b.offenCent - a.offenCent || String(a.datum).localeCompare(String(b.datum)));

  if (!ziel || !brauchbar.length) {
    return { treffer: [], mehrdeutig: false, abgebrochen: false, geprueft: 0 };
  }

  // Restsummen: ab hier ist hoechstens noch so viel zu holen.
  const rest = new Array(brauchbar.length + 1).fill(0);
  for (let i = brauchbar.length - 1; i >= 0; i--) rest[i] = rest[i + 1] + brauchbar[i].offenCent;
  if (rest[0] < ziel) {
    return { treffer: [], mehrdeutig: false, abgebrochen: false, geprueft: 0 };
  }

  const treffer = [];
  let schritte = 0;
  let abgebrochen = false;

  (function suche(i, offenerBetrag, gewaehlt) {
    if (abgebrochen || treffer.length >= maxTreffer) return;
    if (offenerBetrag === 0) { treffer.push(gewaehlt.slice()); return; }
    if (i >= brauchbar.length || gewaehlt.length >= maxTiefe) return;
    if (rest[i] < offenerBetrag) return;                 // nicht mehr erreichbar
    if (++schritte > maxSchritte) { abgebrochen = true; return; }

    const p = brauchbar[i];
    if (p.offenCent <= offenerBetrag) {
      gewaehlt.push(p);
      suche(i + 1, offenerBetrag - p.offenCent, gewaehlt);
      gewaehlt.pop();
    }
    suche(i + 1, offenerBetrag, gewaehlt);
  })(0, ziel, []);

  return { treffer, mehrdeutig: treffer.length > 1, abgebrochen, geprueft: schritte };
}

/**
 * Bewertet die gefundenen Zusammenstellungen und begruendet die Reihenfolge.
 *
 * Gewichtet wird nach dem, was Zahler tatsaechlich tun: Wer eine Sammelzahlung
 * leistet, nennt die Rechnungsnummern oft im Verwendungszweck, begleicht eher
 * alles Offene als eine Auswahl daraus und bezahlt eher die aelteren Posten.
 */
function bewerten(treffer, alleOffenen, zweck) {
  const z = blank(zweck);
  const gesamtZahl = alleOffenen.length;

  return treffer.map((satz) => {
    const gruende = [];
    let punkte = 0;

    const genannt = satz.filter((p) => {
      const n = blank(p.belegnummer);
      return n.length >= 4 && z.includes(n);
    });
    if (genannt.length) {
      punkte += 40 * (genannt.length / satz.length);
      gruende.push(genannt.length === satz.length
        ? "alle Belegnummern stehen im Verwendungszweck"
        : genannt.length + " von " + satz.length + " Belegnummern stehen im Verwendungszweck");
    }

    if (satz.length === gesamtZahl) {
      punkte += 25;
      gruende.push("es sind alle offenen Rechnungen dieses Zahlers");
    }

    // Wenige Rechnungen sind wahrscheinlicher als viele.
    punkte += Math.max(0, 20 - (satz.length - 1) * 2);

    // Aelteste zuerst: Wird genau der aelteste Block beglichen, spricht das dafuer.
    const sortiert = alleOffenen.slice().sort((a, b) => String(a.datum).localeCompare(String(b.datum)));
    const aeltesteIds = sortiert.slice(0, satz.length).map((p) => p.id).sort().join(",");
    if (satz.map((p) => p.id).sort().join(",") === aeltesteIds) {
      punkte += 15;
      gruende.push("es sind genau die ältesten offenen Rechnungen");
    }

    // Jede Zusammenstellung nennt mindestens die nackte Tatsache. Ein
    // Vorschlag ohne Begruendung waere ein Orakel.
    gruende.unshift(satz.length + " Rechnungen ergeben zusammen genau diesen Betrag");

    const datumsListe = satz.map((p) => p.datum).sort();
    return {
      ids: satz.map((p) => p.id),
      posten: satz.slice().sort((a, b) => String(a.datum).localeCompare(String(b.datum))),
      anzahl: satz.length,
      centSumme: satz.reduce((s, p) => s + p.offenCent, 0),
      von: datumsListe[0], bis: datumsListe[datumsListe.length - 1],
      punkte: Math.round(punkte),
      gruende,
    };
  }).sort((a, b) => b.punkte - a.punkte || a.anzahl - b.anzahl);
}

/**
 * Sind zwei Zusammenstellungen ueberhaupt unterscheidbar?
 *
 * Fuenf Rechnungen ueber je 137,60 und eine Zahlung ueber 275,20: Es gibt zehn
 * Kombinationen, und alle bestehen aus denselben Betraegen. Rechnerisch ist
 * das einerlei, fuer die offene-Posten-Liste aber nicht - es entscheidet,
 * welche Rechnung als bezahlt gilt und welche gemahnt wird. Genau das muss
 * dastehen, statt eine davon zu waehlen.
 */
function nurBetragsgleich(bewertet) {
  if (bewertet.length < 2) return false;
  const muster = (k) => k.posten.map((p) => p.offenCent).sort((a, b) => a - b).join("|");
  const erstes = muster(bewertet[0]);
  return bewertet.every((k) => muster(k) === erstes);
}

/**
 * Der ganze Vorgang: suchen, bewerten, einordnen.
 *
 * offenePosten sind die offenen Rechnungen eines Zahlers, zielCent der Betrag
 * der Zahlung.
 */
function aufschluesseln(offenePosten, zielCent, zweck, opt) {
  const roh = kombinationen(offenePosten, zielCent, opt);
  const bewertet = bewerten(roh.treffer, offenePosten, zweck);
  return {
    kombinationen: bewertet,
    mehrdeutig: roh.mehrdeutig,
    betragsgleich: nurBetragsgleich(bewertet),
    abgebrochen: roh.abgebrochen,
    geprueft: roh.geprueft,
    // Eindeutig heisst: genau eine Zusammenstellung geht auf. Nur dann darf
    // etwas vorausgewaehlt werden.
    eindeutig: bewertet.length === 1 && !roh.abgebrochen,
  };
}

module.exports = { aufschluesseln, kombinationen, bewerten, nurBetragsgleich, blank };
