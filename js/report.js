// Kennzahlen und kleine SVG-Diagramme für die Chefin.
import * as store from './store.js';

const DAY = 86400000;
const startOfDay = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };

export function computeStats(now = new Date()) {
  const parcels = store.allParcels();
  const stored = parcels.filter(p => p.status === 'lagernd');
  const today = startOfDay(now);
  const since30 = new Date(now - 30 * DAY);
  const closed30 = parcels.filter(p => p.status !== 'lagernd' && new Date(p.outAt) >= since30);
  const ausgegeben30 = closed30.filter(p => p.status === 'ausgegeben');

  const avgHours = ausgegeben30.length
    ? ausgegeben30.reduce((s, p) => s + (new Date(p.outAt) - new Date(p.inAt)), 0) / ausgegeben30.length / 3600000
    : null;

  // Verlauf der letzten 14 Tage
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const from = new Date(today - i * DAY);
    const to = new Date(+from + DAY);
    days.push({
      date: from,
      ein: parcels.filter(p => new Date(p.inAt) >= from && new Date(p.inAt) < to).length,
      aus: parcels.filter(p => p.outAt && p.status === 'ausgegeben' && new Date(p.outAt) >= from && new Date(p.outAt) < to).length,
    });
  }

  // Abholungen nach Uhrzeit (letzte 30 Tage)
  const hours = Array.from({ length: 24 }, (_, h) => ({ h, n: 0 }));
  ausgegeben30.forEach(p => hours[new Date(p.outAt).getHours()].n++);

  // Liegedauer des aktuellen Bestands
  const buckets = [
    { label: 'heute/1 Tag', min: 0, max: 1, n: 0 },
    { label: '2–3 Tage', min: 2, max: 3, n: 0 },
    { label: '4–5 Tage', min: 4, max: 5, n: 0 },
    { label: '6–7 Tage', min: 6, max: 7, n: 0 },
    { label: 'über 7 Tage', min: 8, max: Infinity, n: 0 },
  ];
  stored.forEach(p => {
    const d = store.daysStored(p, now);
    buckets.find(b => d >= b.min && d <= b.max).n++;
  });

  const slots = store.listSlots().map(s => ({ id: s.id, label: s.label, count: store.slotCount(s.id) }));

  return {
    bestand: stored.length,
    ueberfaellig: stored.filter(p => store.dueDate(p) < now).length,
    heuteEin: days.at(-1).ein,
    heuteAus: days.at(-1).aus,
    ausgegeben30: ausgegeben30.length,
    retoure30: closed30.filter(p => p.status === 'retoure').length,
    avgHours,
    days, hours, buckets, slots,
  };
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Gruppiertes Säulendiagramm: eingelagert vs. ausgegeben pro Tag. */
export function dayChart(days) {
  const W = 640, H = 200, pad = { l: 28, r: 8, t: 10, b: 26 };
  const max = Math.max(4, ...days.flatMap(d => [d.ein, d.aus]));
  const step = (W - pad.l - pad.r) / days.length;
  const bw = Math.min(14, step / 2 - 2);
  const y = v => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const ticks = [0, Math.round(max / 2), max];
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="chart wide" role="img" aria-label="Pakete pro Tag">`;
  ticks.forEach(t => {
    svg += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}" class="grid"/>`;
    svg += `<text x="${pad.l - 6}" y="${y(t) + 4}" text-anchor="end" class="tick">${t}</text>`;
  });
  days.forEach((d, i) => {
    const x = pad.l + i * step + step / 2;
    const lbl = d.date.toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric' });
    svg += `<rect x="${x - bw - 1}" y="${y(d.ein)}" width="${bw}" height="${y(0) - y(d.ein)}" rx="2" class="s1"><title>${esc(lbl)}: ${d.ein} eingelagert</title></rect>`;
    svg += `<rect x="${x + 1}" y="${y(d.aus)}" width="${bw}" height="${y(0) - y(d.aus)}" rx="2" class="s2"><title>${esc(lbl)}: ${d.aus} ausgegeben</title></rect>`;
    if (i % 2 === days.length % 2) svg += `<text x="${x}" y="${H - 8}" text-anchor="middle" class="tick">${esc(lbl)}</text>`;
  });
  return svg + '</svg>';
}

/** Einfache Säulen (eine Reihe), z. B. Abholungen pro Stunde. */
export function barChart(items, { label, value, ariaLabel }) {
  const W = 380, H = 170, pad = { l: 28, r: 8, t: 10, b: 24 };
  const max = Math.max(2, ...items.map(value));
  const step = (W - pad.l - pad.r) / items.length;
  const bw = Math.max(4, step - 4);
  const y = v => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="${esc(ariaLabel)}">`;
  svg += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(0)}" y2="${y(0)}" class="grid"/>`;
  svg += `<text x="${pad.l - 6}" y="${y(max) + 4}" text-anchor="end" class="tick">${max}</text>`;
  items.forEach((it, i) => {
    const x = pad.l + i * step + 2;
    const v = value(it);
    svg += `<rect x="${x}" y="${y(v)}" width="${bw}" height="${y(0) - y(v)}" rx="2" class="s1"><title>${esc(label(it))}: ${v}</title></rect>`;
    if (items.length <= 6 || i % 3 === 0) svg += `<text x="${x + bw / 2}" y="${H - 8}" text-anchor="middle" class="tick">${esc(label(it))}</text>`;
  });
  return svg + '</svg>';
}

/** CSV für Excel (Semikolon, UTF-8 mit BOM). */
export function parcelsCsv() {
  const head = ['Sendungsnummer', 'Name', 'Box', 'Status', 'Eingelagert', 'Eingelagert von', 'Abgeschlossen', 'Abgeschlossen von', 'Liegetage'];
  const rows = store.allParcels().map(p => [
    p.tracking, p.name, p.slotId, p.status,
    new Date(p.inAt).toLocaleString('de-DE'), store.userName(p.inBy),
    p.outAt ? new Date(p.outAt).toLocaleString('de-DE') : '', p.outBy ? store.userName(p.outBy) : '',
    store.daysStored(p),
  ]);
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return '﻿' + [head, ...rows].map(r => r.map(q).join(';')).join('\r\n');
}
