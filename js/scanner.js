// Kamera-Scanner.
// 1. Live-Kamera: eingebaute BarcodeDetector-API (Android/Chrome), sonst ZXing (iPhone, Desktop).
// 2. Ersatz, wenn keine Live-Kamera erlaubt ist: Foto aufnehmen und den Code daraus lesen.
// Hand-/Bluetooth-Scanner brauchen das alles nicht: Sie "tippen" den Code ins Eingabefeld.

import { classifyCode } from './barcode.js';

const FORMATS = ['code_128', 'qr_code', 'data_matrix', 'code_39', 'ean_13', 'itf'];

let zxingLoading = null;
function loadZxing() {
  if (window.ZXing) return Promise.resolve();
  zxingLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/zxing.min.js';
    s.onload = resolve;
    s.onerror = () => { zxingLoading = null; reject(new Error('Scanner-Bibliothek konnte nicht geladen werden.')); };
    document.head.appendChild(s);
  });
  return zxingLoading;
}

async function nativeFormats() {
  if (!('BarcodeDetector' in window)) return [];
  try { return (await window.BarcodeDetector.getSupportedFormats()).filter(f => FORMATS.includes(f)); }
  catch { return []; }
}

export function feedback() {
  try { navigator.vibrate?.(60); } catch { /* egal */ }
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.frequency.value = 1400; g.gain.value = 0.08;
    o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.09);
    o.onended = () => ctx.close();
  } catch { /* egal */ }
}

/** Liest Barcodes aus einem Foto. Liefert alle gefundenen Werte. */
async function decodeImage(file) {
  const native = await nativeFormats();
  if (native.length) {
    try {
      const bmp = await createImageBitmap(file);
      const codes = await new window.BarcodeDetector({ formats: native }).detect(bmp);
      if (codes.length) return codes.map(c => c.rawValue);
    } catch { /* weiter mit ZXing */ }
  }
  await loadZxing();
  const img = await createImageBitmap(file);
  const scale = Math.min(1, 2000 / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0, canvas.width, canvas.height);
  return zxingMulti(canvas);
}

/**
 * ZXing findet pro Durchgang nur einen Code: gefundenen Code übermalen und erneut suchen.
 * So kommen Leitcode UND Sendungsnummer aus einem Bild.
 */
function zxingMulti(canvas, rounds = 4) {
  const ZX = window.ZXing;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const reader = new ZX.MultiFormatReader();
  reader.setHints(new Map([[ZX.DecodeHintType.TRY_HARDER, true]]));
  const found = [];
  for (let i = 0; i < rounds; i++) {
    let result;
    try {
      const lum = new ZX.HTMLCanvasElementLuminanceSource(canvas);
      result = reader.decodeWithState(new ZX.BinaryBitmap(new ZX.HybridBinarizer(lum)));
    } catch { break; }
    if (found.includes(result.getText())) break;
    found.push(result.getText());
    const pts = result.getResultPoints();
    const xs = pts.map(q => q.getX()), ys = pts.map(q => q.getY());
    const pad = Math.max(30, canvas.width * 0.04);
    let x0 = Math.min(...xs) - pad, x1 = Math.max(...xs) + pad, y0 = Math.min(...ys) - pad, y1 = Math.max(...ys) + pad;
    // Strichcodes liefern oft nur eine Linie: Fläche in die Höhe ziehen
    if (y1 - y0 < canvas.height * 0.08) { const c = (y0 + y1) / 2, h = canvas.height * 0.06; y0 = c - h; y1 = c + h; }
    if (x1 - x0 < canvas.width * 0.08) { const c = (x0 + x1) / 2, w = canvas.width * 0.06; x0 = c - w; x1 = c + w; }
    ctx.fillStyle = '#fff';
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  }
  return found;
}

/** Alle Codes des letzten Scans (z. B. Leitcode + Sendungsnummer aus einem Foto). */
export let lastScanAll = [];

/**
 * Öffnet die Kamera als Overlay und liefert den ersten erkannten Code (oder null bei Abbruch).
 * @param {string} title Hinweis oben im Overlay
 * @param {{want?: 'tracking'|'slot'}} opts Gesuchte Code-Art: Die Live-Kamera scannt weiter,
 *   bis so ein Code im Bild ist (z. B. Leitcode merken, aber auf die Sendungsnummer warten).
 */
export function scanWithCamera(title = 'Code scannen', { want, leitcodeAfterMs } = {}) {
  lastScanAll = [];
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'scan-overlay';
    overlay.innerHTML = `
      <div class="scan-box" role="dialog" aria-modal="true">
        <div class="scan-head"><strong></strong><button type="button" class="btn ghost small" data-close>Abbrechen</button></div>
        <div class="scan-video"><video playsinline muted></video><div class="scan-frame"></div></div>
        <p class="scan-msg muted">Code in den Rahmen halten …</p>
        <label class="btn primary scan-photo" hidden>Foto vom Code aufnehmen<input type="file" accept="image/*" capture="environment" hidden></label>
      </div>`;
    overlay.querySelector('strong').textContent = title;
    document.body.appendChild(overlay);
    const video = overlay.querySelector('video');
    const msg = overlay.querySelector('.scan-msg');
    const photoBtn = overlay.querySelector('.scan-photo');
    let stream = null, stopped = false, zxTimer = 0, raf = 0;

    function finish(value) {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(raf);
      clearTimeout(zxTimer);
      stream?.getTracks().forEach(t => t.stop());
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      if (value) feedback();
      resolve(value || null);
    }
    let hinted = '', leitSeenAt = 0;
    /** Neue Live-Treffer prüfen: fertig, sobald die gesuchte Code-Art dabei ist. */
    function consider(values) {
      for (const v of values) if (!lastScanAll.includes(v)) lastScanAll.push(v);
      if (!want) return finish(pickBest(lastScanAll));
      const hit = lastScanAll.find(v => classifyCode(v).type === want);
      if (hit) return finish(hit);
      const types = lastScanAll.map(v => classifyCode(v).type);
      // Optional: nur Adresse im Bild? Nach kurzer Zeit damit weitermachen (Suche nach Adresse)
      if (leitcodeAfterMs && types.includes('leitcode')) {
        leitSeenAt ||= Date.now();
        if (Date.now() - leitSeenAt > leitcodeAfterMs) return finish(lastScanAll.find(v => classifyCode(v).type === 'leitcode'));
      }
      let text = '';
      if (want === 'tracking' && types.includes('leitcode')) text = 'Adresse erkannt ✓ Jetzt den Code mit der Sendungsnummer (JJD… oder 00340…) in den Rahmen halten.';
      else if (want === 'tracking' && types.includes('slot')) text = 'Das ist ein Lagerplatz. Bitte den Code mit der Sendungsnummer scannen.';
      else if (want === 'slot') text = 'Das ist kein Lagerplatz-QR. Bitte den QR-Code am Fach scannen.';
      else text = 'Code nicht erkannt. Bitte den Code mit der Sendungsnummer scannen.';
      if (text !== hinted) { hinted = text; msg.textContent = text; msg.classList.add('scan-hint'); try { navigator.vibrate?.(30); } catch { /* egal */ } }
    }
    const onKey = e => { if (e.key === 'Escape') finish(null); };
    document.addEventListener('keydown', onKey);
    overlay.querySelector('[data-close]').onclick = () => finish(null);

    function photoMode(text) {
      overlay.querySelector('.scan-video').hidden = true;
      msg.textContent = text;
      photoBtn.hidden = false;
    }
    photoBtn.querySelector('input').onchange = async e => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      msg.textContent = 'Lese Code aus dem Foto …';
      const values = await decodeImage(file);
      if (values.length) { lastScanAll = values; finish(pickBest(values)); }
      else msg.textContent = 'Kein Code erkannt. Bitte näher ran, gerade halten und erneut versuchen.';
    };

    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('keine Kamera'), { name: 'NotSupported' });
        const native = await nativeFormats();
        if (native.length) {
          stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 } }, audio: false });
          if (stopped) return finish(null);
          video.srcObject = stream;
          await video.play();
          const detector = new window.BarcodeDetector({ formats: native });
          const tick = async () => {
            if (stopped) return;
            try {
              const codes = await detector.detect(video);
              if (codes.length) consider(codes.map(c => c.rawValue));
              if (stopped) return;
            } catch { /* nächster Versuch */ }
            raf = requestAnimationFrame(tick);
          };
          tick();
        } else {
          await loadZxing();
          if (stopped) return;
          stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 } }, audio: false });
          if (stopped) return finish(null);
          video.srcObject = stream;
          await video.play();
          // Eigene Schleife: pro Kamerabild alle Codes suchen (nicht nur den ersten)
          const canvas = document.createElement('canvas');
          let frame = 0;
          const loop = () => {
            if (stopped) return;
            if (video.videoWidth) {
              const vw = video.videoWidth, vh = video.videoHeight;
              // abwechselnd: ganzes Bild und der Bereich im Zielrahmen in voller Auflösung
              const crop = frame++ % 2 === 1;
              const sx = crop ? vw * 0.08 : 0, sy = crop ? vh * 0.2 : 0;
              const sw = crop ? vw * 0.84 : vw, sh = crop ? vh * 0.6 : vh;
              const scale = Math.min(1, 1800 / Math.max(sw, sh));
              canvas.width = Math.round(sw * scale);
              canvas.height = Math.round(sh * scale);
              canvas.getContext('2d', { willReadFrequently: true }).drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
              const values = zxingMulti(canvas, 4);
              if (values.length) consider(values);
            }
            if (!stopped) zxTimer = setTimeout(loop, 200);
          };
          loop();
        }
      } catch (e) {
        if (stopped) return;
        photoMode(e?.name === 'NotAllowedError' || e?.name === 'SecurityError' || e?.name === 'NotSupported'
          ? 'Live-Kamera ist hier nicht verfügbar. Fotografiere den Code einfach:'
          : 'Kamera nicht verfügbar. Fotografiere den Code stattdessen:');
      }
    })();
  });
}

/** Wenn mehrere Codes gleichzeitig im Bild sind: lieber Lagerplatz/Sendungsnummer als den Leitcode. */
function pickBest(values) {
  const rank = { slot: 0, tracking: 1, leitcode: 2, unknown: 3 };
  return [...values].sort((a, b) => rank[classifyCode(a).type] - rank[classifyCode(b).type])[0];
}
