// Datenschicht. Prototyp: speichert lokal im Browser (localStorage).
// Später wird diese Datei durch eine Supabase-Variante mit derselben
// Schnittstelle ersetzt – die Oberfläche muss dafür nicht geändert werden.

import { trackingKey, normalizeName, nameMatches } from './barcode.js';

const KEY = globalThis.PAKETLAGER_TEST === true ? 'paketlager.test.v1' : 'paketlager.v1';

let state = load();

function uid() {
  return (crypto.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2));
}

function empty() {
  return {
    version: 1,
    filiale: { id: uid(), name: '', lagerfristWerktage: 7, loeschfristTage: 30 },
    users: [],
    slots: [],
    parcels: [],
    log: [],
  };
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...empty(), ...JSON.parse(raw) };
  } catch { /* privates Fenster o. ä. */ }
  return empty();
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { console.error(e); }
}

function log(userId, action, parcelId = null, detail = '') {
  state.log.push({ at: new Date().toISOString(), userId, action, parcelId, detail });
  if (state.log.length > 20000) state.log.splice(0, state.log.length - 20000);
}

// ---------- Einrichtung & Benutzer ----------

export const isSetUp = () => state.users.some(u => u.role === 'admin' && u.active);
export const getFiliale = () => ({ ...state.filiale });

export function updateFiliale(patch) {
  Object.assign(state.filiale, patch);
  save();
}

async function hashPin(pin, salt) {
  const data = new TextEncoder().encode(salt + ':' + pin);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export const listUsers = () => state.users.map(({ pinHash, salt, ...u }) => u);

export async function addUser({ name, pin, role = 'staff' }) {
  name = name.trim();
  if (!name) throw new Error('Bitte einen Namen eingeben.');
  if (!/^\d{4,8}$/.test(pin)) throw new Error('Die PIN muss 4–8 Ziffern haben.');
  if (state.users.some(u => u.active && u.name.toLowerCase() === name.toLowerCase())) {
    throw new Error('Diesen Namen gibt es schon.');
  }
  const salt = uid();
  const user = { id: uid(), name, role, active: true, salt, pinHash: await hashPin(pin, salt), createdAt: new Date().toISOString() };
  state.users.push(user);
  save();
  return user.id;
}

export async function setPin(userId, pin) {
  if (!/^\d{4,8}$/.test(pin)) throw new Error('Die PIN muss 4–8 Ziffern haben.');
  const u = state.users.find(x => x.id === userId);
  u.salt = uid();
  u.pinHash = await hashPin(pin, u.salt);
  save();
}

export function setUserActive(userId, active) {
  const u = state.users.find(x => x.id === userId);
  if (!active && u.role === 'admin' && state.users.filter(x => x.role === 'admin' && x.active).length === 1) {
    throw new Error('Mindestens eine Chefin/ein Admin muss aktiv bleiben.');
  }
  u.active = active;
  save();
}

export function setUserRole(userId, role) {
  const u = state.users.find(x => x.id === userId);
  if (role !== 'admin' && u.role === 'admin' && state.users.filter(x => x.role === 'admin' && x.active).length === 1) {
    throw new Error('Mindestens eine Chefin/ein Admin muss bleiben.');
  }
  u.role = role;
  save();
}

/** Die zwei festen Zugänge anlegen. Liefert die ID der Chefin. */
export async function setupAccounts({ pinChefin, pinTeam }) {
  await addUser({ name: 'Team', pin: pinTeam, role: 'staff' });
  return addUser({ name: 'Chefin', pin: pinChefin, role: 'admin' });
}

/** Hat ein anderer aktiver Zugang schon diese PIN? (sonst wäre nicht klar, wer sich anmeldet) */
export async function pinInUse(pin, exceptId) {
  for (const u of state.users) {
    if (u.id !== exceptId && u.active && (await hashPin(pin, u.salt)) === u.pinHash) return true;
  }
  return false;
}

export async function login(userId, pin) {
  const u = state.users.find(x => x.id === userId && x.active);
  if (!u) return null;
  const ok = (await hashPin(pin, u.salt)) === u.pinHash;
  if (ok) { log(u.id, 'login'); save(); }
  return ok ? { id: u.id, name: u.name, role: u.role } : null;
}

export const userName = id => state.users.find(u => u.id === id)?.name ?? '–';

// ---------- Lagerplätze ----------

export const listSlots = (all = false) =>
  state.slots.filter(s => all || s.active).sort((a, b) => a.id.localeCompare(b.id, 'de', { numeric: true }));

export const getSlot = id => state.slots.find(s => s.id === id);

export function addSlot({ id, label = '' }) {
  id = String(id).trim().toUpperCase();
  if (!/^[A-Z0-9\-]{1,12}$/.test(id)) throw new Error('Platz-Code: nur Buchstaben, Ziffern und Bindestrich (max. 12).');
  if (state.slots.some(s => s.id === id)) throw new Error(`Platz ${id} gibt es schon.`);
  state.slots.push({ id, label: String(label).trim(), active: true });
  save();
}

export function updateSlot(id, patch) {
  Object.assign(getSlot(id), patch);
  save();
}

export function slotCount(id) {
  return state.parcels.filter(p => p.status === 'lagernd' && p.slotId === id).length;
}

// ---------- Pakete ----------

export function findStoredByTracking(value) {
  const key = trackingKey(value);
  return state.parcels.find(p => p.status === 'lagernd' && p.trackingKey === key) ?? null;
}

export function checkIn(userId, { tracking, carrier, leitcode, name, slotId, note = '' }, { allowDuplicate = false } = {}) {
  if (!tracking) throw new Error('Sendungsnummer fehlt.');
  if (!name?.trim()) throw new Error('Name fehlt.');
  if (!getSlot(slotId)) throw new Error('Bitte einen gültigen Lagerplatz wählen.');
  if (!allowDuplicate && findStoredByTracking(tracking)) throw new Error('Dieses Paket ist bereits eingelagert.');
  const p = {
    id: uid(), tracking, trackingKey: trackingKey(tracking), carrier: carrier || '', leitcode: leitcode || null,
    name: name.trim(), nameKey: normalizeName(name), slotId, note,
    status: 'lagernd', inAt: new Date().toISOString(), inBy: userId, outAt: null, outBy: null,
  };
  state.parcels.push(p);
  log(userId, 'einlagern', p.id, slotId);
  save();
  return p;
}

export function moveParcel(userId, parcelId, slotId) {
  const p = state.parcels.find(x => x.id === parcelId);
  const from = p.slotId;
  p.slotId = slotId;
  log(userId, 'umlagern', p.id, `${from} → ${slotId}`);
  save();
}

export function checkOut(userId, parcelId, status = 'ausgegeben') {
  const p = state.parcels.find(x => x.id === parcelId);
  if (p.status !== 'lagernd') throw new Error('Paket ist nicht mehr im Lager.');
  p.status = status;
  p.outAt = new Date().toISOString();
  p.outBy = userId;
  log(userId, status === 'retoure' ? 'retoure' : 'ausgabe', p.id, p.slotId);
  save();
}

/** Fehlerhafte Einlagerung zurücknehmen (direkt danach). */
export function cancelCheckIn(userId, parcelId) {
  const i = state.parcels.findIndex(x => x.id === parcelId);
  if (i < 0) return;
  log(userId, 'storniert', null, state.parcels[i].tracking);
  state.parcels.splice(i, 1);
  save();
}

export function undoCheckOut(userId, parcelId) {
  const p = state.parcels.find(x => x.id === parcelId);
  p.status = 'lagernd';
  p.outAt = null;
  p.outBy = null;
  log(userId, 'rueckgaengig', p.id);
  save();
}

export const storedParcels = () => state.parcels.filter(p => p.status === 'lagernd');
export const allParcels = () => state.parcels;

/** Suche nach Sendungsnummer, Leitcode oder Name. Liefert nur lagernde Pakete. */
export function search(query, classified) {
  const stored = storedParcels();
  if (classified?.type === 'tracking') {
    const key = trackingKey(classified.value);
    const hit = stored.filter(p => p.trackingKey === key);
    if (hit.length) return { exact: hit, related: related(hit) };
  }
  if (classified?.type === 'leitcode') {
    const hit = stored.filter(p => p.leitcode === classified.value);
    return { exact: hit, related: [] };
  }
  const q = String(query || '').trim();
  if (q.length < 2) return { exact: [], related: [] };
  const byName = stored.filter(p => nameMatches(p.name, q));
  const byTracking = stored.filter(p => p.trackingKey.includes(q.toUpperCase().replace(/\s/g, '')));
  const exact = [...new Set([...byName, ...byTracking])];
  return { exact, related: exact.length ? related(exact) : [] };
}

/** Letzter Eintrag zu einer Sendungsnummer, egal ob noch im Lager oder schon abgeschlossen. */
export function findAnyByTracking(value) {
  const key = trackingKey(value);
  for (let i = state.parcels.length - 1; i >= 0; i--) if (state.parcels[i].trackingKey === key) return state.parcels[i];
  return null;
}

/** Weitere Pakete für denselben Namen bzw. dieselbe Adresse. */
function related(hits) {
  const ids = new Set(hits.map(p => p.id));
  const names = new Set(hits.map(p => p.nameKey));
  const leit = new Set(hits.map(p => p.leitcode).filter(Boolean));
  return storedParcels().filter(p => !ids.has(p.id) && (names.has(p.nameKey) || (p.leitcode && leit.has(p.leitcode))));
}

/** Namen für die Autovervollständigung (aus den letzten Wochen). */
export function knownNames(prefix) {
  const q = normalizeName(prefix);
  if (q.length < 2) return [];
  const seen = new Map();
  for (let i = state.parcels.length - 1; i >= 0 && seen.size < 8; i--) {
    const p = state.parcels[i];
    if (p.anonymized) continue;
    if (nameMatches(p.name, prefix) && !seen.has(p.nameKey)) seen.set(p.nameKey, p.name);
  }
  return [...seen.values()];
}

// ---------- Fristen ----------

/** Addiert Werktage (Mo–Sa, ohne Sonntag). Feiertage bleiben im Prototyp unberücksichtigt. */
export function addWerktage(date, n) {
  const d = new Date(date);
  while (n > 0) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0) n--;
  }
  d.setHours(23, 59, 59, 0);
  return d;
}

export function dueDate(p) {
  return addWerktage(p.inAt, state.filiale.lagerfristWerktage);
}

export function daysStored(p, now = new Date()) {
  const end = p.outAt ? new Date(p.outAt) : now;
  return Math.floor((end - new Date(p.inAt)) / 86400000);
}

// ---------- Datenschutz ----------

/** Entfernt Namen und Adressbezug bei abgeschlossenen Paketen nach Ablauf der Löschfrist. Statistik bleibt. */
/** Wie lange ein ausgegebenes Paket noch mit Daten da ist (für „Rückgängig“). */
export const UNDO_MS = 2 * 60000;

/**
 * Datensparsamkeit: Abgeholte (und zurückgeschickte) Pakete verlieren nach UNDO_MS
 * Name, Sendungsnummer und Adressbezug. Die Ausgabe dokumentiert ohnehin die DHL-Software.
 * Übrig bleiben nur anonyme Zeiten für das Cockpit.
 */
export function anonymizeOld(now = new Date()) {
  const limit = now - UNDO_MS;
  let n = 0;
  for (const p of state.parcels) {
    if (p.anonymized && p.tracking) { p.tracking = ''; n++; } // ältere Stände: Restnummer entfernen
    if (p.status !== 'lagernd' && !p.anonymized && new Date(p.outAt) < limit) {
      p.name = '(gelöscht)'; p.nameKey = ''; p.leitcode = null; p.note = ''; p.tracking = '';
      p.trackingKey = ''; p.anonymized = true; n++;
    }
  }
  if (n) save();
  return n;
}

// ---------- Protokoll, Sicherung ----------

export const getLog = () => state.log;

export function exportBackup() {
  return JSON.stringify(state, null, 2);
}

export function importBackup(json) {
  const data = JSON.parse(json);
  if (!data || data.version !== 1 || !Array.isArray(data.parcels)) throw new Error('Keine gültige Sicherungsdatei.');
  state = { ...empty(), ...data };
  save();
}

export function resetAll() {
  state = empty();
  save();
}

/** Stand der Testdaten. Erhöhen, damit alle Test-Geräte beim nächsten Öffnen frisch starten. */
export const TEST_DATA_VERSION = 4;
export const testDataVersion = () => state.testDataVersion ?? 1;

/** Test-App: Filiale, Team und Testdaten auf einen Schlag. */
export async function setupTestApp() {
  resetAll();
  updateFiliale({ name: 'Test-Filiale' });
  const chefin = await setupAccounts({ pinChefin: '1234', pinTeam: '0000' });
  seedDemo(chefin);
  state.testDataVersion = TEST_DATA_VERSION;
  save();
}

/** Demo-Daten zum Ausprobieren: ein Regal mit Boxen A1–A4 und B1–B4. */
export function seedDemo(userId) {
  for (const r of ['A', 'B']) for (let n = 1; n <= 4; n++) {
    if (!getSlot(r + n)) addSlot({ id: r + n, label: `Regal ${r}, Box ${n}` });
  }
  // Testkunden: die Abrafaxe. Abrax, Brabax und Califax wohnen zusammen (gleicher Leitcode),
  // so zeigt die Ausgabe auch „gleiche Adresse“.
  const ZUHAUSE = '13051014003571', BURG = '13051088001572';
  const kunden = [ // Name, Box, Tage im Lager, Adresse (Leitcode)
    ['Don Ferrando', 'B4', 9.3, BURG], ['Califax', 'A1', 8.6, ZUHAUSE], ['Brabax', 'A2', 5.2, ZUHAUSE],
    ['Califax', 'B1', 3.4, ZUHAUSE], ['Abrax', 'A1', 2.8, ZUHAUSE], ['Don Ferrando', 'B2', 2.1, BURG],
    ['Brabax', 'A4', 1.3, ZUHAUSE], ['Califax', 'B3', 0.6, ZUHAUSE], ['Abrax', 'A2', 0.2, ZUHAUSE],
  ];
  const now = Date.now();
  kunden.forEach(([name, slotId, tage, leitcode], i) => {
    const tracking = i % 2
      ? '340434' + String(617000000000 + now % 1000000 * 7 + i * 104729).slice(0, 12)
      : 'JJD000390018' + String((now % 100000) * 10 + i).padStart(9, '0');
    const p = checkIn(userId, { tracking, carrier: 'DHL', leitcode, name, slotId });
    p.inAt = new Date(now - tage * 86400000).toISOString();
  });
  // Ein paar abgeschlossene für das Reporting
  for (let d = 1; d <= 14; d++) {
    for (let k = 0; k < 3 + (d * 7) % 6; k++) {
      const inAt = now - d * 86400000 - k * 3600000;
      const out = new Date(inAt + (1 + (k % 4)) * 86400000);
      out.setHours([9, 11, 12, 16, 17, 17, 18, 10][(d + k) % 8], (d * 7 + k * 13) % 60);
      const outAt = +out;
      if (outAt > now || outAt < inAt) continue;
      state.parcels.push({
        id: uid(), tracking: '', trackingKey: '', carrier: 'DHL', leitcode: null, name: '(gelöscht)', nameKey: '',
        slotId: 'A1', note: '', status: k === 4 ? 'retoure' : 'ausgegeben', anonymized: true,
        inAt: new Date(inAt).toISOString(), inBy: userId, outAt: new Date(outAt).toISOString(), outBy: userId,
      });
    }
  }
  save();
}
