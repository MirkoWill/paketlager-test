// Oberfläche von RegalLotse.
import * as store from './store.js';
import { classifyCode, SLOT_PREFIX, looksLikeSlot } from './barcode.js';
import { scanWithCamera, feedback, lastScanAll } from './scanner.js';
import { computeStats, dayChart, barChart, parcelsCsv } from './report.js';
import { icon } from './icons.js';

const BRAND = 'Willbrandt und Kompagnon';
const APP_VERSION = '14';
const AUTO_LOGOUT_MIN = 20;
// Test-App: wird von der Vorführseite gesetzt (window.PAKETLAGER_TEST = true)
const TEST_APP = window.PAKETLAGER_TEST === true;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = d => new Date(d).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
const fmtDateTime = d => new Date(d).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const shortTracking = t => t.length > 10 ? '…' + t.slice(-8) : t;

const main = $('#main');
let user = null;
try { user = JSON.parse(sessionStorage.getItem('paketlager.user')); } catch { /* egal */ }

// ---------------- Hilfen ----------------

function toast(text, { type = 'ok', action, onAction, ms = 4000 } = {}) {
  const box = $('#toasts');
  box.replaceChildren(); // immer nur eine Meldung, damit nichts verdeckt wird
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${esc(text)}</span>${action ? `<button class="btn ghost small">${esc(action)}</button>` : ''}`;
  if (action) el.querySelector('button').onclick = () => { onAction?.(); el.remove(); };
  box.appendChild(el);
  setTimeout(() => el.remove(), action ? ms * 2 : ms);
}

function setUser(u) {
  user = u;
  try { u ? sessionStorage.setItem('paketlager.user', JSON.stringify(u)) : sessionStorage.removeItem('paketlager.user'); } catch { /* egal */ }
}

function go(route) {
  if (location.hash === '#' + route) render(); else location.hash = route;
}

// Läuft die App in der claude.ai-Vorschau? Dort gibt es kein Drucken und keine Browser-Dialoge.
const inViewer = () => typeof window.claude?.use === 'function';

/** Eigener Dialog statt confirm()/prompt() (funktioniert überall). */
function dialog({ text, input = null, ok = 'OK', danger = false }) {
  return new Promise(resolve => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-overlay';
    wrap.innerHTML = `
      <form class="modal" role="dialog" aria-modal="true">
        <p class="modal-text"></p>
        ${input ? `<input id="modal-input" autocomplete="off" ${input.numeric ? 'inputmode="numeric"' : ''}>` : ''}
        <div class="modal-actions">
          <button type="button" class="btn" data-cancel>Abbrechen</button>
          <button class="btn ${danger ? 'danger' : 'primary'}">${esc(ok)}</button>
        </div>
      </form>`;
    $('.modal-text', wrap).textContent = text;
    document.body.appendChild(wrap);
    const field = $('#modal-input', wrap);
    (field ?? $('.btn.primary, .btn.danger', wrap)).focus();
    const done = v => { wrap.remove(); resolve(v); };
    $('[data-cancel]', wrap).onclick = () => done(input ? null : false);
    $('form', wrap).onsubmit = e => { e.preventDefault(); done(input ? field.value.trim() : true); };
    wrap.addEventListener('keydown', e => { if (e.key === 'Escape') done(input ? null : false); });
  });
}
const confirmDialog = (text, opts = {}) => dialog({ text, ...opts });
const askText = (text, opts = {}) => dialog({ text, input: opts, ok: opts.ok ?? 'OK', danger: opts.danger });

async function download(filename, content, type) {
  if (inViewer()) {
    const dl = await window.claude.use('downloads').catch(() => null);
    if (!dl) return toast('Download ist in dieser Vorschau nicht verfügbar.', { type: 'error' });
    try { await dl.save({ filename, data: new Blob([content], { type }) }); }
    catch { toast('Download abgebrochen.', { type: 'info' }); }
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function qrSvg(text) {
  const qr = window.qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

/** Feld mit Kamera-Knopf. Ruft onCode(raw) bei Enter oder Kamera-Treffer. */
// Touch-Geräte: Scan-Felder öffnen die Bildschirmtastatur erst, wenn man hineintippt.
// Ein Bluetooth-Handscanner kann trotzdem jederzeit hineinschreiben.
const TOUCH = window.matchMedia?.('(pointer: coarse)').matches ?? false;
function quietKeyboard(input) {
  if (!TOUCH) return;
  input.setAttribute('inputmode', 'none');
  input.addEventListener('pointerup', () => {
    if (input.getAttribute('inputmode') !== 'none') return;
    input.setAttribute('inputmode', 'text');
    input.blur();
    setTimeout(() => input.focus(), 0);
  });
  input.addEventListener('blur', () => setTimeout(() => {
    if (document.activeElement !== input) input.setAttribute('inputmode', 'none');
  }, 0));
}

function bindScanField(input, cameraBtn, onCode, title, scanOpts = {}) {
  quietKeyboard(input);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); const v = input.value.trim(); if (v) onCode(v); }
  });
  cameraBtn?.addEventListener('click', async () => {
    const v = await scanWithCamera(title, scanOpts);
    if (v) onCode(v);
  });
}

// Auto-Abmelden bei Inaktivität
let idleTimer;
function resetIdle() {
  clearTimeout(idleTimer);
  if (user) idleTimer = setTimeout(() => { setUser(null); toast('Automatisch abgemeldet.', { type: 'info' }); go('login'); }, AUTO_LOGOUT_MIN * 60000);
}
['pointerdown', 'keydown'].forEach(ev => document.addEventListener(ev, resetIdle, { passive: true }));

// ---------------- Kopf & Navigation ----------------

const TITLES = {
  setup: 'Willkommen', login: 'Anmelden', ein: 'Einlagern', aus: 'Ausgabe', bestand: 'Bestand',
  bericht: 'Cockpit', mehr: 'Mehr', plaetze: 'Boxen', team: 'Zugänge', einstellungen: 'Einstellungen',
};
const TABS = [
  { route: 'ein', label: 'Einlagern', icon: 'einlagern' },
  { route: 'aus', label: 'Ausgabe', icon: 'ausgabe' },
  { route: 'bestand', label: 'Bestand', icon: 'bestand' },
  { route: 'bericht', label: 'Cockpit', icon: 'cockpit', admin: true },
  { route: 'mehr', label: 'Mehr', icon: 'mehr' },
];
const ADMIN_ROUTES = ['bericht', 'plaetze', 'team', 'einstellungen'];

// Schriftgröße (A+), pro Gerät gemerkt
let bigText = false;
try { bigText = localStorage.getItem('paketlager.bigtext') === '1'; } catch { /* egal */ }
document.documentElement.classList.toggle('big-text', bigText);

function renderHeader(route) {
  const f = store.getFiliale();
  $('#header').innerHTML = `
    <div class="hero">
      <div class="hero-inner">
        <div class="hero-top">
          <a class="brand" href="#ein" aria-label="RegalLotse von Willbrandt und Kompagnon">
            <span class="brand-name">RegalLotse</span>
            <span class="brand-by"><span class="brand-by-text"><span class="wm-light">Willbrandt</span> <span class="wm-bold">und Kompagnon</span></span></span>
          </a>
          <div class="hero-actions">
            <button class="pill" id="aplus" aria-pressed="${bigText}" title="Größere Schrift">A+</button>
            ${user ? `<a class="pill" href="#mehr" title="Angemeldet als ${esc(user.name)}">${esc(initials(user.name))}</a>` : ''}
          </div>
        </div>
        <div class="hero-page">
          <h1 class="hero-title">${esc(TITLES[route] ?? 'RegalLotse')}</h1>
          <span class="eyebrow">${esc(f.name || '')}</span>
        </div>
      </div>
    </div>`;
  fitBrand();
  const activeTab = ['plaetze', 'team', 'einstellungen'].includes(route) ? 'mehr' : route;
  $('#nav').innerHTML = user
    ? TABS.filter(n => !n.admin || user.role === 'admin').map(n =>
        `<a href="#${n.route}" class="${activeTab === n.route ? 'active' : ''}">${icon(n.icon)}<span>${n.label}</span></a>`).join('')
    : '';
  document.body.classList.toggle('has-tabs', !!user);
  $('#aplus').onclick = () => {
    bigText = !bigText;
    document.documentElement.classList.toggle('big-text', bigText);
    $('#aplus').setAttribute('aria-pressed', bigText);
    try { localStorage.setItem('paketlager.bigtext', bigText ? '1' : '0'); } catch { /* egal */ }
    fitBrand();
  };
  document.title = `${TITLES[route] ?? ''} · RegalLotse`;
}

/** „Willbrandt und Kompagnon“ genau so breit wie „RegalLotse“ (links und rechts bündig). */
function fitBrand() {
  const name = $('.brand-name'), text = $('.brand-by-text');
  if (!name || !text) return;
  text.style.letterSpacing = '0px';
  text.style.marginRight = '0px';
  const chars = text.textContent.length - 1;
  const ls = (name.getBoundingClientRect().width - text.getBoundingClientRect().width) / chars;
  text.style.letterSpacing = `${ls}px`;
  text.style.marginRight = `${-ls}px`; // Abstand nach dem letzten Buchstaben ausgleichen
}
document.fonts?.ready.then(fitBrand);
window.addEventListener('resize', fitBrand);

const initials = n => n.split(/\s+/).filter(Boolean).map(w => w[0]).slice(0, 2).join('').toUpperCase();

// ---------------- Router ----------------

function render() {
  let route = location.hash.slice(1) || 'ein';
  if (route === 'ruecksendungen') route = 'bestand';
  if (!store.isSetUp()) route = 'setup';
  else if (!user) route = 'login';
  else if (route === 'login' || route === 'setup') route = 'ein';
  if (ADMIN_ROUTES.includes(route) && user.role !== 'admin') route = 'ein';
  renderHeader(route);
  document.onkeydown = null; // nur Einlagern setzt einen eigenen Handscanner-Empfang
  $('#toasts').replaceChildren(); // Meldungen gehören zur vorigen Seite
  main.innerHTML = '';
  ({ setup: viewSetup, login: viewLogin, ein: viewEin, aus: viewAus, bestand: viewBestand, bericht: viewBericht, mehr: viewMehr,
     plaetze: viewPlaetze, team: viewTeam, einstellungen: viewEinstellungen }[route] ?? viewEin)();
  window.scrollTo(0, 0);
  resetIdle();
}
window.addEventListener('hashchange', render);

// ---------------- Mehr (Kachel-Übersicht) ----------------

function viewMehr() {
  const tiles = [
    user.role === 'admin' && { href: '#plaetze', icon: 'plaetze', title: 'Boxen', sub: 'Boxen anlegen, Etiketten drucken' },
    user.role === 'admin' && { href: '#team', icon: 'team', title: 'Zugänge', sub: 'PINs für Team und Chefin' },
    user.role === 'admin' && { href: '#einstellungen', icon: 'einstellungen', title: 'Einstellungen', sub: 'Fristen, Datensicherung' },
    { href: '#ruecksendungen', icon: 'retoure', title: 'Rücksendungen', sub: 'Pakete mit abgelaufener Frist' },
  ].filter(Boolean);
  main.innerHTML = `
    <section class="signed-in">
      <span class="muted">Angemeldet als</span>
      <strong>${esc(user.name)}</strong>
    </section>
    <h2 class="lead">Was möchten Sie erledigen?</h2>
    <div class="tiles">
      ${tiles.map(t => `<a class="tile" href="${t.href}">${icon(t.icon, 'tile-ic')}<span class="tile-title">${t.title}</span><span class="tile-sub">${t.sub}</span></a>`).join('')}
      <button class="tile" id="logout">${icon('abmelden', 'tile-ic')}<span class="tile-title">Abmelden</span><span class="tile-sub">Zwischen Team und Chefin wechseln</span></button>
      ${TEST_APP ? `<button class="tile" id="testreset">${icon('retoure', 'tile-ic')}<span class="tile-title">Test neu starten</span><span class="tile-sub">Alles zurück auf die Abrafaxe-Testdaten</span></button>` : ''}
    </div>`;
  $('#testreset')?.addEventListener('click', async () => {
    if (!(await confirmDialog('Test-App auf den Anfangszustand zurücksetzen? Alle Eingaben gehen verloren.', { ok: 'Zurücksetzen', danger: true }))) return;
    await store.setupTestApp();
    setUser(null);
    toast('Test-App zurückgesetzt.');
    go('login');
  });
  $('#logout').onclick = () => { setUser(null); go('login'); };
}

// ---------------- Ersteinrichtung ----------------

function viewSetup() {
  main.innerHTML = `
    <section class="card narrow">
      <h2>Einmalige Einrichtung</h2>
      <p class="muted">RegalLotse hat genau zwei Zugänge: <b>Team</b> für die tägliche Arbeit und <b>Chefin</b> für Cockpit, Boxen und Einstellungen. Namen von Mitarbeiterinnen werden nicht gespeichert.</p>
      <form id="f" class="stack">
        <label>Name der Filiale<input name="filiale" required placeholder="z. B. Postfiliale 546, Dorfstr. 25"></label>
        <label>PIN für das Team (4–8 Ziffern)<input name="pinTeam" required inputmode="numeric" type="password" pattern="\\d{4,8}" autocomplete="new-password"></label>
        <label>PIN für die Chefin (4–8 Ziffern)<input name="pin" required inputmode="numeric" type="password" pattern="\\d{4,8}" autocomplete="new-password"></label>
        <label>PIN für die Chefin wiederholen<input name="pin2" required inputmode="numeric" type="password" pattern="\\d{4,8}" autocomplete="new-password"></label>
        <label class="check"><input type="checkbox" name="demo"> Beispiel-Boxen und Testpakete anlegen (nur zum Ausprobieren)</label>
        <button class="btn primary big">Einrichten</button>
      </form>
    </section>`;
  $('#f').onsubmit = async e => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    if (fd.pin !== fd.pin2) return toast('Die beiden PINs der Chefin stimmen nicht überein.', { type: 'error' });
    if (fd.pin === fd.pinTeam) return toast('Team und Chefin brauchen verschiedene PINs.', { type: 'error' });
    try {
      store.updateFiliale({ name: fd.filiale.trim() });
      const chefin = await store.setupAccounts({ pinChefin: fd.pin, pinTeam: fd.pinTeam });
      if (fd.demo) store.seedDemo(chefin);
      setUser(await store.login(chefin, fd.pin));
      go(fd.demo ? 'ein' : 'plaetze');
    } catch (err) { toast(err.message, { type: 'error' }); }
  };
}

// ---------------- Anmeldung ----------------

function viewLogin() {
  const users = store.listUsers().filter(u => u.active);
  main.innerHTML = `
    <section class="card narrow">
      <h2>Wer arbeitet gerade?</h2>
      ${TEST_APP ? '<p class="test-hint"><b>Test-App:</b> PIN für Team <b>0000</b>, für Chefin <b>1234</b></p>' : ''}
      <div class="user-grid">${users.map(u => `<button class="user-tile" data-id="${u.id}">${esc(u.name)}</button>`).join('')}</div>
      <form id="pinform" class="stack hidden">
        <label><span id="pinlabel">PIN</span><input id="pin" inputmode="numeric" pattern="[0-9]*" type="password" autocomplete="off" maxlength="8" enterkeyhint="go"></label>
        <button class="btn primary big">Anmelden</button>
      </form>
    </section>`;
  let chosen = null;
  $$('.user-tile').forEach(b => b.onclick = () => {
    chosen = b.dataset.id;
    $$('.user-tile').forEach(x => x.classList.toggle('selected', x === b));
    $('#pinform').classList.remove('hidden');
    $('#pinlabel').textContent = `PIN für ${b.textContent}`;
    $('#pin').value = '';
    $('#pin').focus();
  });
  const enter = u => {
    try { localStorage.setItem('paketlager.lastuser', u.id); } catch { /* egal */ }
    setUser(u);
    go('ein');
  };
  $('#pinform').onsubmit = async e => {
    e.preventDefault();
    const u = await store.login(chosen, $('#pin').value);
    if (!u) { $('#pin').value = ''; return toast('Die PIN stimmt nicht. Bitte noch einmal.', { type: 'error' }); }
    enter(u);
  };
  // Bei richtiger PIN sofort anmelden, ohne Knopf
  $('#pin').addEventListener('input', async e => {
    const v = e.target.value;
    if (v.length < 4) return;
    const u = await store.login(chosen, v);
    if (u && $('#pin')?.value === v) enter(u);
  });
  let last = null;
  try { last = localStorage.getItem('paketlager.lastuser'); } catch { /* egal */ }
  const pre = users.length === 1 ? $('.user-tile') : last && $(`.user-tile[data-id="${last}"]`);
  pre?.click();
}

// ---------------- Einlagern ----------------

const draft = { tracking: '', carrier: '', leitcode: '', name: '', nameOk: false, slotId: '', info: '' };
const resetDraft = () => Object.assign(draft, { tracking: '', carrier: '', leitcode: '', name: '', nameOk: false, slotId: '', info: '' });

/**
 * Einlagern in drei Schritten. Immer nur der aktuelle Schritt ist offen,
 * erledigte Schritte zeigen ihr Ergebnis mit „Ändern“. Nach dem Box-Scan wird
 * automatisch eingelagert (mit „Rückgängig“).
 */
function viewEin() {
  if (!store.listSlots().length) {
    main.innerHTML = `<section class="card"><h2>Noch keine Boxen angelegt</h2>
      <p>${user.role === 'admin' ? 'Lege zuerst die Boxen an und drucke ihre QR-Etiketten.' : 'Bitte die Chefin, zuerst die Boxen anzulegen.'}</p>
      ${user.role === 'admin' ? '<a class="btn primary" href="#plaetze">Boxen anlegen</a>' : ''}</section>`;
    return;
  }
  const step = !draft.tracking ? 1 : !draft.nameOk ? 2 : 3;
  const st = n => (n < step ? 'done' : n === step ? 'active' : 'todo');
  main.innerHTML = `
    <section class="card flow" aria-label="Paket einlagern">
      <form id="f" autocomplete="off">
        <ol class="steps">
          <li class="step ${st(1)}">
            <div class="step-head">
              <span class="step-no" aria-hidden="true">${step > 1 ? '✓' : '1'}</span>
              <span class="step-title">Paket</span>
              ${step > 1 ? `<span class="step-value">${esc(shortTracking(draft.tracking))}${draft.leitcode ? ' · Adresse ✓' : ''}</span><button type="button" class="link" data-edit="1">Ändern</button>` : ''}
            </div>
            <div class="step-body">
              <button type="button" class="btn primary big" id="cam1">${icon('scan')}Paket scannen</button>
              <div class="or"><span>oder eintippen</span></div>
              <input id="code" placeholder="Sendungsnummer" enterkeyhint="next" autocapitalize="characters" spellcheck="false" aria-label="Sendungsnummer eintippen">
              <div id="codeinfo" class="info" role="status">${draft.info}</div>
            </div>
          </li>
          <li class="step ${st(2)}">
            <div class="step-head">
              <span class="step-no" aria-hidden="true">${step > 2 ? '✓' : '2'}</span>
              <span class="step-title">Name</span>
              ${step > 2 ? `<span class="step-value">${esc(draft.name)}</span><button type="button" class="link" data-edit="2">Ändern</button>` : ''}
            </div>
            <div class="step-body">
              <input id="name" list="names" placeholder="Name vom Etikett" enterkeyhint="next" autocapitalize="words" spellcheck="false" aria-label="Name des Empfängers">
              <datalist id="names"></datalist>
              <div id="nameinfo" class="info" role="status"></div>
              <button type="button" class="btn primary big" id="nameok">Weiter</button>
            </div>
          </li>
          <li class="step ${st(3)}">
            <div class="step-head">
              <span class="step-no" aria-hidden="true">3</span>
              <span class="step-title">Box</span>
            </div>
            <div class="step-body">
              <p class="hint">Paket in eine Box mit Platz legen, dann das Etikett der Box scannen.</p>
              <button type="button" class="btn primary big" id="cam2">${icon('scan')}Box scannen</button>
              <div class="or"><span>oder auswählen</span></div>
              <select id="slot" aria-label="Box auswählen"></select>
            </div>
          </li>
        </ol>
        ${step > 1 ? '<button type="button" class="link cancel" id="restart">Abbrechen und neu beginnen</button>' : ''}
      </form>
    </section>
    <section class="card">
      <h2>Zuletzt eingelagert</h2>
      <div id="recent"></div>
    </section>`;

  const code = $('#code'), name = $('#name'), slot = $('#slot');
  const rerender = () => viewEin();

  slot.innerHTML = '<option value="">Box wählen …</option>' + store.listSlots().map(s =>
    `<option value="${esc(s.id)}">${esc(s.id)}${s.label ? ' · ' + esc(s.label) : ''}</option>`).join('');

  function handleCode(raw) {
    const c = classifyCode(raw);
    code.value = '';
    if (c.type === 'slot') {
      if (step === 3) return chooseSlot(c.value);
      draft.info = `<span class="warn">Das war das Etikett einer Box. Bitte zuerst die Sendungsnummer des Pakets scannen.</span>`;
      return rerender();
    }
    if (c.type === 'leitcode') {
      draft.leitcode = c.value;
      feedback();
      draft.info = `<span class="warn">Adresse erkannt ✓ Jetzt bitte den Code mit der Sendungsnummer scannen („JJD…“ oder „00340…“).</span>`;
      return rerender();
    }
    if (c.type === 'unknown') {
      draft.info = `<span class="error">Diesen Code kennt RegalLotse nicht: ${esc(c.value || raw)}. Bitte den Strichcode mit der Sendungsnummer scannen.</span>`;
      return rerender();
    }
    const existing = store.findStoredByTracking(c.value);
    if (existing && !TEST_APP) {
      draft.info = `<span class="error">Dieses Paket ist schon eingelagert: ${esc(existing.name)} in Box <b>${esc(existing.slotId)}</b> (seit ${fmtDateTime(existing.inAt)}).</span>`;
      return rerender();
    }
    draft.tracking = c.value;
    draft.carrier = c.carrier;
    const leit = lastScanAll.map(classifyCode).find(x => x.type === 'leitcode');
    if (leit && !draft.leitcode) draft.leitcode = leit.value;
    draft.info = '';
    feedback();
    rerender();
  }

  function confirmName() {
    const v = name.value.trim();
    const c = classifyCode(v);
    if (c.type === 'slot') { name.value = draft.name; return chooseSlot(c.value); } // Handscanner im Namensfeld
    if (!v) { $('#nameinfo').innerHTML = '<span class="error">Bitte den Namen vom Etikett eintippen.</span>'; return name.focus(); }
    draft.name = v;
    draft.nameOk = true;
    name.blur();
    rerender();
  }

  async function chooseSlot(id) {
    // Test-App: jedes gescannte Box-Etikett funktioniert sofort, ohne Rückfrage
    if (!store.getSlot(id) && TEST_APP) store.addSlot({ id });
    if (!store.getSlot(id)) {
      if (user.role !== 'admin') return toast(`Box ${id} ist noch nicht angelegt. Bitte die Chefin, sie anzulegen.`, { type: 'error' });
      if (!(await confirmDialog(`Box ${id} gibt es noch nicht. Jetzt anlegen?`, { ok: `${id} anlegen` }))) return;
      try { store.addSlot({ id }); } catch (err) { return toast(err.message, { type: 'error' }); }
    }
    draft.slotId = id;
    save();
  }

  function save() {
    if (!draft.tracking) return rerender();
    if (!draft.nameOk) return rerender();
    try {
      const p = store.checkIn(user.id, draft, { allowDuplicate: TEST_APP });
      feedback();
      toast(`✓ ${p.name} liegt in Box ${p.slotId}`, { action: 'Rückgängig', onAction: () => { store.cancelCheckIn(user.id, p.id); toast('Einlagerung zurückgenommen.', { type: 'info' }); viewEin(); } });
      resetDraft();
      viewEin();
    } catch (err) { toast(err.message, { type: 'error' }); }
  }

  bindScanField(code, $('#cam1'), handleCode, 'Sendungsnummer scannen', { want: 'tracking' });
  $('#cam2').onclick = async () => {
    const v = await scanWithCamera('Etikett der Box scannen', { want: 'slot' });
    if (!v) return;
    const c = classifyCode(v);
    c.type === 'slot' ? chooseSlot(c.value) : toast('Das ist kein Box-Etikett.', { type: 'error' });
  };
  slot.addEventListener('change', () => { if (slot.value) chooseSlot(slot.value); });

  name.value = draft.name;
  name.addEventListener('input', () => {
    draft.name = name.value;
    if (looksLikeSlot(name.value)) return;
    $('#names').innerHTML = store.knownNames(name.value).map(n => `<option value="${esc(n)}">`).join('');
    const stored = name.value.trim().length >= 3 ? store.search(name.value).exact : [];
    $('#nameinfo').innerHTML = stored.length
      ? `Für diesen Namen liegt schon etwas in Box ${[...new Set(stored.map(p => `<b>${esc(p.slotId)}</b>`))].join(', ')}. Am besten dazulegen.`
      : '';
  });
  name.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); confirmName(); } });
  $('#nameok').onclick = confirmName;

  $$('[data-edit]').forEach(b => b.onclick = () => {
    if (b.dataset.edit === '1') Object.assign(draft, { tracking: '', carrier: '', leitcode: '', info: '' });
    draft.nameOk = false;
    rerender();
  });
  $('#restart')?.addEventListener('click', () => { resetDraft(); rerender(); });

  // Handscanner tippt ein Box-Etikett, während kein Feld aktiv ist
  let buf = '', bufTimer;
  document.onkeydown = e => {
    if (e.target === code || e.target === name) return;
    if (e.key === 'Enter' && looksLikeSlot(buf)) { e.preventDefault(); handleCode(buf); buf = ''; return; }
    if (e.key.length === 1) { buf += e.key; clearTimeout(bufTimer); bufTimer = setTimeout(() => (buf = ''), 300); }
  };
  $('#f').onsubmit = e => {
    e.preventDefault();
    if (step === 1 && code.value.trim()) handleCode(code.value.trim());
    if (step === 2) confirmName();
  };

  renderRecent();
  if (step === 1) code.focus();      // Tastatur bleibt auf dem Handy zu (Handscanner kann tippen)
  if (step === 2) name.focus();      // hier soll die Tastatur kommen
  $('.step.active')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function renderRecent() {
  const recent = store.storedParcels().slice().sort((a, b) => b.inAt.localeCompare(a.inAt)).slice(0, 6);
  $('#recent').innerHTML = recent.length
    ? `<ul class="list">${recent.map(p => `<li><span class="slot-badge">${esc(p.slotId)}</span><span class="grow">${esc(p.name)}</span><span class="muted">${fmtDateTime(p.inAt)}</span></li>`).join('')}</ul>`
    : '<p class="muted">Noch nichts eingelagert.</p>';
}

// ---------------- Ausgabe ----------------

function viewAus() {
  main.innerHTML = `
    <section class="card">
      <button type="button" class="btn primary big" id="cam">${icon('scan')}Code des Kunden scannen</button>
      <div class="or"><span>oder Namen suchen</span></div>
      <input id="q" type="search" placeholder="Name oder Sendungsnummer" autocomplete="off" enterkeyhint="search" spellcheck="false" aria-label="Name oder Sendungsnummer suchen">
      <p class="hint">${TEST_APP ? 'Probier mal „abr“, „cali“ oder „don“.' : 'Die ersten Buchstaben genügen, z. B. „schm“.'}</p>
    </section>
    <div id="results"></div>`;
  const q = $('#q');
  let timer;
  const run = (raw, fromScan = false) => {
    clearTimeout(timer);
    const c = classifyCode(raw);
    const res = store.search(raw, c.type !== 'unknown' ? c : null);
    showResults(res, raw);
    if (fromScan) { q.value = raw; q.select(); feedback(); } // nächster Scan überschreibt
  };
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => run(q.value), 150); });
  bindScanField(q, $('#cam'), v => run(v, true), 'Code des Kunden scannen', { want: 'tracking', leitcodeAfterMs: 2500 });
  q.focus(); // bereit für die Scan-Taste eines Handscanners; die Bildschirmtastatur bleibt zu
}

function parcelCard(p, { actions = true } = {}) {
  const days = store.daysStored(p);
  const overdue = store.dueDate(p) < new Date();
  return `
    <article class="parcel ${overdue ? 'overdue' : ''}" data-id="${p.id}">
      <div class="where"><span class="label">Box</span><span class="slot-big">${esc(p.slotId)}</span><span class="muted small">${esc(store.getSlot(p.slotId)?.label ?? '')}</span></div>
      <div class="what">
        <div class="pname">${esc(p.name)}</div>
        <div class="muted small">${esc(shortTracking(p.tracking))} · seit ${fmtDate(p.inAt)} (${days} ${days === 1 ? 'Tag' : 'Tage'})</div>
        ${overdue ? `<div class="warn small">Frist abgelaufen am ${fmtDate(store.dueDate(p))}</div>` : ''}
      </div>
      ${actions ? `<button class="btn primary" data-out="${p.id}">Ausgeben</button>` : ''}
    </article>`;
}

// Die gerade angezeigten Treffer. Nach dem Ausgeben bleiben die übrigen stehen,
// damit man ein zweites Paket derselben Person ohne neue Suche ausgeben kann.
let shown = { exact: [], related: [], query: '' };

function showResults({ exact, related }, query) {
  const box = $('#results');
  if (!query || query.trim().length < 2) { box.innerHTML = ''; return; }
  if (!exact.length && !related.length) {
    const c = classifyCode(query);
    const past = c.type === 'tracking' ? store.findAnyByTracking(c.value) : null;
    const labels = { ausgegeben: 'ausgegeben', retoure: 'als Retoure zurückgeschickt' };
    let html = `<p>Kein Paket im Lager für „${esc(query)}“.</p>`;
    if (past && past.status !== 'lagernd') {
      html = `<p><b>Dieses Paket ist nicht mehr im Lager.</b> Es wurde am ${fmtDateTime(past.outAt)} von ${esc(store.userName(past.outBy))} ${labels[past.status] ?? past.status}.</p>`;
    } else if (c.type === 'tracking') {
      html += `<p class="muted">Diese Sendungsnummer wurde hier nicht eingelagert.</p><button class="btn primary" id="toein">${icon('einlagern')}Jetzt einlagern</button>`;
    }
    box.innerHTML = `<section class="card">${html}</section>`;
    $('#toein')?.addEventListener('click', () => {
      resetDraft();
      Object.assign(draft, { tracking: c.value, carrier: c.carrier });
      go('ein');
    });
    return;
  }
  shown = { exact: exact.map(p => p.id), related: related.map(p => p.id), query };
  renderShown();
}

function renderShown(note = '', undoIds = null) {
  const box = $('#results');
  if (!box) return;
  const still = ids => ids.map(id => store.allParcels().find(p => p.id === id)).filter(p => p && p.status === 'lagernd');
  const exact = still(shown.exact), related = still(shown.related);
  if (!exact.length && !related.length) {
    box.innerHTML = `<section class="card done-all"><p class="big-ok">✓ Alles ausgegeben</p><p class="hint">Bereit für die nächste Kundin.</p>
      ${undoIds ? '<button type="button" class="btn small ghost" id="undoout">Rückgängig</button>' : ''}</section>`;
    const q = $('#q');
    if (q) { q.value = ''; q.focus(); }
    $('#undoout')?.addEventListener('click', () => undoOut(undoIds));
    return;
  }
  box.innerHTML = `
    <section class="card">
      ${note ? `<p class="ok-note"><span>${note}</span>${undoIds ? '<button type="button" class="btn small ghost" id="undoout">Rückgängig</button>' : ''}</p>` : ''}
      ${exact.length ? `
        <div class="row-between"><h2>${exact.length === 1 ? '1 Paket' : exact.length + ' Pakete'}${note ? ' übrig' : ''}</h2>
          ${exact.length > 1 ? `<button class="btn outline" id="allout">Alle ${exact.length} ausgeben</button>` : ''}</div>
        <p class="hint">Vor der Ausgabe den Ausweis prüfen.</p>
        ${exact.map(p => parcelCard(p)).join('')}` : ''}
      ${related.length ? `<h3>Gleiche Adresse – vielleicht gleich mitnehmen?</h3>${related.map(p => parcelCard(p)).join('')}` : ''}
    </section>`;
  $$('[data-out]', box).forEach(b => b.onclick = () => doOut([b.dataset.out]));
  $('#allout')?.addEventListener('click', () => doOut(exact.map(p => p.id)));
  $('#undoout')?.addEventListener('click', () => undoOut(undoIds));
}

function undoOut(ids) {
  ids.forEach(id => store.undoCheckOut(user.id, id));
  const q = $('#q');
  if (q && !q.value) q.value = shown.query;
  renderShown();
}

function doOut(ids) {
  ids.forEach(id => store.checkOut(user.id, id));
  const what = ids.length === 1 ? 'Paket' : ids.length + ' Pakete';
  feedback();
  renderShown(`✓ ${what} ausgegeben`, ids);
}

// ---------------- Bestand ----------------

function viewBestand() {
  const now = new Date();
  main.innerHTML = `
    <section class="card">
      <div class="row-between"><h2>Im Lager</h2><button class="btn outline" id="print">${icon('drucken')}Rücksendeliste</button></div>
      <div class="filters">
        <input id="q" placeholder="Filtern nach Name, Nummer, Platz">
        <div class="seg" id="mode"><button data-m="alle">Alle</button><button data-m="frist">Frist abgelaufen</button><button data-m="bald">Läuft bald ab</button></div>
      </div>
      <div id="tbl"></div>
    </section>`;
  let mode = location.hash === '#ruecksendungen' ? 'frist' : 'alle';
  $$('#mode button').forEach(x => x.classList.toggle('on', x.dataset.m === mode));
  const draw = () => {
    const q = $('#q').value.trim().toLowerCase();
    let rows = store.storedParcels().slice().sort((a, b) => a.inAt.localeCompare(b.inAt));
    if (mode === 'frist') rows = rows.filter(p => store.dueDate(p) < now);
    if (mode === 'bald') rows = rows.filter(p => { const d = store.dueDate(p); return d >= now && d - now < 2 * 86400000; });
    if (q) rows = rows.filter(p => (p.name + ' ' + p.tracking + ' ' + p.slotId).toLowerCase().includes(q));
    const slotOpts = store.listSlots().map(s => `<option value="${esc(s.id)}">${esc(s.id)}</option>`).join('');
    $('#tbl').innerHTML = rows.length ? `
      <div class="table-wrap"><table>
        <thead><tr><th>Box</th><th>Name</th><th>Sendung</th><th>Seit</th><th>Frist</th><th></th></tr></thead>
        <tbody>${rows.map(p => {
          const due = store.dueDate(p);
          return `<tr class="${due < now ? 'overdue' : ''}">
            <td><select data-move="${p.id}" aria-label="Umlagern">${slotOpts.replace(`value="${esc(p.slotId)}"`, `value="${esc(p.slotId)}" selected`)}</select></td>
            <td>${esc(p.name)}</td><td class="mono">${esc(shortTracking(p.tracking))}</td>
            <td>${fmtDate(p.inAt)}</td><td>${fmtDate(due)}</td>
            <td><button class="btn small" data-ret="${p.id}">Retoure</button></td></tr>`;
        }).join('')}</tbody></table></div>
      <p class="muted small">${rows.length} Pakete</p>` : '<p class="muted">Keine Pakete.</p>';
    $$('[data-move]').forEach(s => s.onchange = () => { store.moveParcel(user.id, s.dataset.move, s.value); toast(`Umgelagert in Box ${s.value}`); });
    $$('[data-ret]').forEach(b => b.onclick = () => {
      const id = b.dataset.ret;
      store.checkOut(user.id, id, 'retoure');
      toast('Als Retoure gebucht.', { action: 'Rückgängig', onAction: () => { store.undoCheckOut(user.id, id); draw(); } });
      draw();
    });
  };
  $('#q').oninput = draw;
  $$('#mode button').forEach(b => b.onclick = () => { mode = b.dataset.m; $$('#mode button').forEach(x => x.classList.toggle('on', x === b)); draw(); });
  $('#print').onclick = () => {
    const rows = store.storedParcels().filter(p => store.dueDate(p) < now).sort((a, b) => a.slotId.localeCompare(b.slotId, 'de', { numeric: true }));
    printHtml(`<h1>Rücksendeliste ${now.toLocaleDateString('de-DE')}</h1>
      <table class="print-table"><thead><tr><th>☐</th><th>Box</th><th>Name</th><th>Sendungsnummer</th><th>Eingelagert</th></tr></thead>
      <tbody>${rows.map(p => `<tr><td>☐</td><td><b>${esc(p.slotId)}</b></td><td>${esc(p.name)}</td><td>${esc(p.tracking)}</td><td>${fmtDate(p.inAt)}</td></tr>`).join('') || '<tr><td colspan="5">Keine Pakete mit abgelaufener Frist.</td></tr>'}</tbody></table>`);
  };
  draw();
}

function printHtml(html) {
  if (inViewer()) return toast('Drucken geht in dieser Vorschau nicht, nur in der fertig installierten App.', { type: 'info' });
  $('#print-area').innerHTML = html;
  window.print();
}

// ---------------- Bericht (Chefin) ----------------

function viewBericht() {
  store.anonymizeOld();
  const s = computeStats();
  const avg = s.avgHours == null ? '–' : s.avgHours < 48 ? `${Math.round(s.avgHours)} Std.` : `${(s.avgHours / 24).toFixed(1).replace('.', ',')} Tage`;
  const openHours = s.hours.filter(h => h.h >= 7 && h.h <= 20);
  main.innerHTML = `
    <section class="kpis">
      <div class="kpi"><span class="kpi-v">${s.bestand}</span><span class="kpi-l">im Lager</span></div>
      <div class="kpi ${s.ueberfaellig ? 'bad' : ''}"><span class="kpi-v">${s.ueberfaellig}</span><span class="kpi-l">Frist abgelaufen</span></div>
      <div class="kpi"><span class="kpi-v">${s.heuteEin} / ${s.heuteAus}</span><span class="kpi-l">heute ein / aus</span></div>
      <div class="kpi"><span class="kpi-v">${avg}</span><span class="kpi-l">Ø Liegezeit (30 Tage)</span></div>
      <div class="kpi"><span class="kpi-v">${s.ausgegeben30}</span><span class="kpi-l">ausgegeben (30 Tage)</span></div>
      <div class="kpi"><span class="kpi-v">${s.retoure30}</span><span class="kpi-l">Retouren (30 Tage)</span></div>
    </section>
    <section class="card">
      <div class="row-between"><h2>Pakete pro Tag</h2>
        <div class="legend"><span><i class="sw s1"></i>eingelagert</span><span><i class="sw s2"></i>ausgegeben</span></div></div>
      ${dayChart(s.days)}
    </section>
    <div class="grid2">
      <section class="card"><h2>Wann wird abgeholt?</h2><p class="muted small">Ausgaben je Uhrzeit, letzte 30 Tage – hilft bei der Personalplanung.</p>
        ${barChart(openHours, { label: h => h.h + ' Uhr', value: h => h.n, ariaLabel: 'Ausgaben pro Stunde' })}</section>
      <section class="card"><h2>Wie lange liegt der Bestand?</h2>
        ${barChart(s.buckets, { label: b => b.label, value: b => b.n, ariaLabel: 'Liegedauer im Bestand' })}</section>
    </div>
    <section class="card">
      <h2>Pakete je Box</h2>
      <div class="slots">${s.slots.map(sl => slotBar(sl, Math.max(...s.slots.map(x => x.count)))).join('')}</div>
    </section>
    <section class="card">
      <div class="row-between"><h2>Export & Protokoll</h2><button class="btn" id="csv">Excel-Export (CSV)</button></div>
      <details><summary>Letzte Buchungen anzeigen</summary><div id="log"></div></details>
    </section>`;
  $('#csv').onclick = () => download(`pakete-${new Date().toISOString().slice(0, 10)}.csv`, parcelsCsv(), 'text/csv;charset=utf-8');
  $('details').addEventListener('toggle', () => {
    const labels = { einlagern: 'eingelagert', ausgabe: 'ausgegeben', retoure: 'Retoure', umlagern: 'umgelagert', rueckgaengig: 'rückgängig', login: 'angemeldet' };
    const parcels = new Map(store.allParcels().map(p => [p.id, p]));
    $('#log').innerHTML = `<ul class="list">${store.getLog().slice(-200).reverse().map(l => {
      const p = parcels.get(l.parcelId);
      return `<li><span class="muted">${fmtDateTime(l.at)}</span><span>${esc(store.userName(l.userId))}</span><span class="grow">${labels[l.action] ?? esc(l.action)} ${p ? esc(p.name) : ''} ${esc(l.detail)}</span></li>`;
    }).join('')}</ul>`;
  }, { once: true });
}

function slotBar(sl, max) {
  const pct = max ? Math.round((sl.count / max) * 100) : 0;
  return `<div class="slotbar">
    <span class="slot-badge">${esc(sl.id)}</span>
    <div class="bar"><i style="width:${pct}%"></i></div>
    <span class="muted small">${sl.count} ${sl.count === 1 ? 'Paket' : 'Pakete'}</span></div>`;
}

// ---------------- Lagerplätze ----------------

function viewPlaetze() {
  const slots = store.listSlots(true);
  main.innerHTML = `
    <section class="card">
      <div class="row-between"><h2>Alle Boxen</h2><button class="btn outline" id="printqr">${icon('drucken')}QR-Etiketten</button></div>
      <div class="table-wrap"><table>
        <thead><tr><th><input type="checkbox" id="all" checked aria-label="Alle"></th><th>Code</th><th>Bezeichnung</th><th>Pakete</th><th>Aktiv</th></tr></thead>
        <tbody>${slots.map(s => `<tr data-id="${esc(s.id)}" class="${s.active ? '' : 'inactive'}">
          <td><input type="checkbox" class="sel" ${s.active ? 'checked' : ''} aria-label="Auswählen"></td>
          <td><b>${esc(s.id)}</b></td>
          <td><input data-f="label" value="${esc(s.label)}"></td>
          <td>${store.slotCount(s.id)}</td>
          <td><input type="checkbox" data-f="active" ${s.active ? 'checked' : ''} aria-label="Aktiv"></td></tr>`).join('')}</tbody>
      </table></div>
    </section>
    <div class="grid2">
      <section class="card"><h2>Eine Box anlegen</h2>
        <form id="one" class="stack">
          <label>Code<input name="id" required placeholder="z. B. A3" maxlength="12"></label>
          <label>Bezeichnung<input name="label" placeholder="z. B. Regal A, Box 3"></label>
          <button class="btn primary">Anlegen</button>
        </form></section>
      <section class="card"><h2>Ein ganzes Regal anlegen</h2>
        <form id="many" class="stack">
          <label>Regal<input name="prefix" required value="C" maxlength="6"></label>
          <div class="row"><label>Box von<input name="from" type="number" value="1" min="1"></label><label>bis<input name="to" type="number" value="4" min="1"></label></div>
          <p class="muted small">Ergibt z. B. C1 … C4</p>
          <button class="btn primary">Anlegen</button>
        </form></section>
    </div>`;
  $$('tr[data-id] [data-f]').forEach(inp => inp.onchange = () => {
    const id = inp.closest('tr').dataset.id;
    const f = inp.dataset.f;
    if (f === 'active' && !inp.checked && store.slotCount(id) > 0) {
      inp.checked = true;
      return toast('In dieser Box liegen noch Pakete.', { type: 'error' });
    }
    store.updateSlot(id, { [f]: f === 'active' ? inp.checked : inp.value });
    toast('Gespeichert.');
    if (f === 'active') viewPlaetze();
  });
  $('#all').onchange = e => $$('.sel').forEach(c => (c.checked = e.target.checked));
  $('#one').onsubmit = e => {
    e.preventDefault();
    try { store.addSlot(Object.fromEntries(new FormData(e.target))); viewPlaetze(); toast('Box angelegt.'); }
    catch (err) { toast(err.message, { type: 'error' }); }
  };
  $('#many').onsubmit = e => {
    e.preventDefault();
    const { prefix, from, to } = Object.fromEntries(new FormData(e.target));
    const a = +from, b = +to;
    if (b < a || b - a > 200) return toast('Bitte einen sinnvollen Bereich (max. 200) angeben.', { type: 'error' });
    const r = prefix.trim().toUpperCase();
    let n = 0;
    for (let i = a; i <= b; i++) {
      try { store.addSlot({ id: `${r}${i}`, label: `Regal ${r}, Box ${i}` }); n++; } catch { /* existiert */ }
    }
    toast(`${n} Boxen angelegt.`);
    viewPlaetze();
  };
  $('#printqr').onclick = () => {
    const ids = $$('tr[data-id]').filter(tr => $('.sel', tr).checked).map(tr => tr.dataset.id);
    if (!ids.length) return toast('Bitte Boxen auswählen.', { type: 'error' });
    printHtml(`<div class="labels">${ids.map(id => {
      const s = store.getSlot(id);
      return `<div class="qr-label">${qrSvg(SLOT_PREFIX + id)}<div><div class="qr-id">${esc(id)}</div><div class="qr-sub">${esc(s.label)}</div></div></div>`;
    }).join('')}</div>`);
  };
}

// ---------------- Team ----------------

function viewTeam() {
  const users = store.listUsers().filter(u => u.active);
  main.innerHTML = `
    <section class="card narrow">
      <h2>Zugänge</h2>
      <p class="hint">RegalLotse hat zwei feste Zugänge. Das Team teilt sich eine PIN, die Chefin hat eine eigene. Ändern Sie die PINs, wenn jemand das Team verlässt.</p>
      <ul class="list">${users.map(u => `<li data-id="${u.id}">
        <span class="grow"><b>${esc(u.name)}</b><br><span class="muted small">${u.role === 'admin' ? 'Cockpit, Boxen, Zugänge, Einstellungen' : 'Einlagern, Ausgabe, Bestand'}</span></span>
        <button class="btn small" data-pin>PIN ändern</button></li>`).join('')}</ul>
    </section>`;
  $$('li[data-id]').forEach(li => {
    const id = li.dataset.id;
    $('[data-pin]', li).onclick = async () => {
      const pin = await askText(`Neue PIN für ${users.find(u => u.id === id).name} (4–8 Ziffern):`, { numeric: true, ok: 'PIN speichern' });
      if (!pin) return;
      try {
        if (await store.pinInUse(pin.trim(), id)) throw new Error('Diese PIN hat schon der andere Zugang.');
        await store.setPin(id, pin.trim());
        toast('PIN geändert.');
      } catch (err) { toast(err.message, { type: 'error' }); }
    };
  });
}

// ---------------- Einstellungen ----------------

function viewEinstellungen() {
  const f = store.getFiliale();
  main.innerHTML = `
    <section class="card narrow">
      <h2>Filiale</h2>
      <form id="f" class="stack">
        <label>Name der Filiale<input name="name" value="${esc(f.name)}"></label>
        <label>Lagerfrist (Werktage Mo–Sa)<input name="lagerfristWerktage" type="number" min="1" max="30" value="${f.lagerfristWerktage}"></label>
        <p class="hint">Datenschutz: Name und Sendungsnummer abgeholter Pakete werden zwei Minuten nach der Ausgabe gelöscht. Für das Cockpit bleiben nur anonyme Zahlen.</p>
        <button class="btn primary">Speichern</button>
      </form>
    </section>
    <section class="card narrow">
      <h2>Datensicherung</h2>
      <p class="muted small">Der Prototyp speichert nur auf diesem Gerät. Bitte regelmäßig sichern. In der Mehrgeräte-Version entfällt das.</p>
      <div class="row"><button class="btn" id="backup">Sicherung herunterladen</button>
      <label class="btn">Sicherung einspielen<input type="file" id="restore" accept="application/json" hidden></label></div>
    </section>
    <section class="card narrow danger-zone">
      <h2>Zurücksetzen</h2>
      <button class="btn danger" id="reset">Alle Daten auf diesem Gerät löschen</button>
    </section>`;
  $('#f').onsubmit = e => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    store.updateFiliale({ name: d.name.trim(), lagerfristWerktage: Math.max(1, +d.lagerfristWerktage), });
    toast('Gespeichert.');
    renderHeader('einstellungen');
  };
  $('#backup').onclick = () => download(`paketlager-sicherung-${new Date().toISOString().slice(0, 10)}.json`, store.exportBackup(), 'application/json');
  $('#restore').onchange = async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file || !(await confirmDialog('Aktuelle Daten durch die Sicherung ersetzen?', { ok: 'Ersetzen', danger: true }))) return;
    try { store.importBackup(await file.text()); setUser(null); toast('Sicherung eingespielt. Bitte neu anmelden.'); go('login'); }
    catch (err) { toast(err.message, { type: 'error' }); }
  };
  $('#reset').onclick = async () => {
    const word = await askText('Wirklich ALLE Daten (Pakete, Plätze, Team) auf diesem Gerät löschen? Zur Bestätigung LÖSCHEN eintippen:', { ok: 'Alles löschen', danger: true });
    if (word?.toUpperCase() !== 'LÖSCHEN') { if (word != null) toast('Nicht gelöscht: Bestätigungswort stimmt nicht.', { type: 'info' }); return; }
    store.resetAll(); setUser(null); go('setup');
  };
}

// ---------------- Start ----------------

// Test-App: beim ersten Start oder wenn es neue Testdaten gibt, frisch beginnen
if (TEST_APP && (!store.isSetUp() || store.testDataVersion() !== store.TEST_DATA_VERSION)) {
  await store.setupTestApp();
  setUser(null);
}
store.anonymizeOld();
setInterval(() => store.anonymizeOld(), 30000);
render();
try { $('.footer').textContent += ` · Version ${APP_VERSION}`; } catch { /* egal */ }
if ('serviceWorker' in navigator && location.protocol !== 'file:' && !inViewer()) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline-Modus optional */ });
}
