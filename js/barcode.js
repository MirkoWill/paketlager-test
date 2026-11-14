// Erkennt, was für ein Code gescannt wurde.
// Wichtig: Auf DHL-Labels ist der OBERE Code meist der Leitcode (= Adresse,
// für alle Pakete an dieselbe Adresse gleich). Eindeutig ist die SENDUNGSNUMMER.

export const SLOT_PREFIX = 'PL:';

// Box-Etikett „PL:A3“. Handscanner mit falsch eingestelltem Tastaturlayout liefern
// statt „:“ oft „Ö“ oder „;“ und statt „-“ ein „ß“ oder „/“. Das wird hier toleriert.
// Groß geschrieben und ohne Leerzeichen, damit ein getippter Name wie „Plötz“ nie als Box gilt.
const SLOT_RE = /^PL[:;ÖÄ>]([A-Z0-9\-ß\/]{1,12})$/;
export const looksLikeSlot = str => SLOT_RE.test(String(str ?? '').trim());

/** Entfernt Steuerzeichen und Symbologie-Präfixe, die Scanner mitsenden. */
export function cleanCode(raw) {
  return String(raw ?? '')
    .replace(/^\](C1|d2|Q3|e0)/, '') // AIM-Kennung (GS1-128, DataMatrix, QR)
    .replace(/[\x00-\x1f\x7f]/g, '') // FNC1/GS u. a.
    .replace(/[()\s.]/g, '')          // Klammern/Punkte/Leerzeichen aus Klartext
    .trim()
    .toUpperCase();
}

/**
 * @returns {{type:'slot'|'tracking'|'leitcode'|'unknown', value:string, carrier?:string, hint?:string}}
 */
export function classifyCode(raw) {
  const str = String(raw ?? '').trim();
  const slot = SLOT_RE.exec(str);
  if (slot) return { type: 'slot', value: slot[1].replace(/[ß/]/g, '-') };
  const c = cleanCode(str);
  if (!c) return { type: 'unknown', value: '' };

  // GS1-Leitcode: Application Identifier 403 (Routing-Code), z. B. 403276130596+...
  if (/^403\d{6,}/.test(c) && c.includes('+')) {
    return { type: 'leitcode', value: c.slice(3), hint: 'Leitcode (Adresse) – bitte die Sendungsnummer scannen.' };
  }
  // Klassischer DHL-Leitcode: 14 Ziffern (PLZ 5 + Straße 3 + Hausnr. 3 + Produkt 2 + Prüfziffer 1)
  if (/^\d{14}$/.test(c)) {
    return { type: 'leitcode', value: c, hint: 'Leitcode (Adresse) – bitte die Sendungsnummer scannen.' };
  }
  // DHL/Amazon-Format JJD…
  if (/^JJD\d{10,}$/.test(c)) return { type: 'tracking', value: c, carrier: 'DHL' };
  // SSCC/NVE mit AI 00: 00 + 18 Ziffern
  if (/^00\d{18}$/.test(c)) return { type: 'tracking', value: c.slice(2), carrier: 'DHL' };
  if (/^\d{18}$/.test(c) && c.startsWith('3404')) return { type: 'tracking', value: c, carrier: 'DHL' };
  // DHL Paketnummer 12 oder 20 Ziffern
  if (/^\d{12}$/.test(c) || /^\d{20}$/.test(c)) return { type: 'tracking', value: c, carrier: 'DHL' };
  // Internationale Sendungen (UPU S10): RR123456785DE
  if (/^[A-Z]{2}\d{9}[A-Z]{2}$/.test(c)) return { type: 'tracking', value: c, carrier: 'Post' };
  // Sonstiges (Hermes, GLS, DPD …): alles mit mind. 8 Zeichen akzeptieren
  if (/^(?=.*\d)[A-Z0-9+\-]{8,}$/.test(c)) return { type: 'tracking', value: c, carrier: 'Sonstige' };
  return { type: 'unknown', value: c };
}

/** Vergleichsschlüssel, damit 00340434… und 340434… dasselbe Paket finden. */
export function trackingKey(value) {
  const c = cleanCode(value);
  return /^00\d{18}$/.test(c) ? c.slice(2) : c;
}

/** PLZ aus einem 14-stelligen Leitcode. */
export function plzFromLeitcode(leitcode) {
  const m = /^(\d{5})\d{9}$/.exec(leitcode || '');
  return m ? m[1] : null;
}

/** Name normalisieren für die Suche (Umlaute, Groß/klein, Titel). */
export function normalizeName(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\b(herr|frau|dr|prof|c\/o)\b\.?/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Trifft die Suche den Namen? Jeder Suchbegriff muss Anfang eines Namensteils sein. */
export function nameMatches(name, query) {
  const parts = normalizeName(name).split(' ');
  const terms = normalizeName(query).split(' ').filter(Boolean);
  if (!terms.length) return false;
  return terms.every(t => parts.some(p => p.startsWith(t)));
}
