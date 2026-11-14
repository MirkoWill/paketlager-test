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
  // ZXing findet pro Durchgang einen Code: gefundenen Code übermalen und erneut suchen.
  await loadZxing();
  const ZX = window.ZXing;
  const img = await createImageBitmap(file);
  const scale = Math.min(1, 2000 / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const reader = new ZX.MultiFormatReader();
  reader.setHints(new Map([[ZX.DecodeHintType.TRY_HARDER, true]]));
  const found = [];
  for (let i = 0; i < 4; i++) {
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
 */
export function scanWithCamera(title = 'Code scannen') {
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
    let stream = null, stopped = false, zxReader = null, raf = 0;

    function finish(value) {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(raf);
      try { zxReader?.reset(); } catch { /* egal */ }
      stream?.getTracks().forEach(t => t.stop());
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      if (value) feedback();
      resolve(value || null);
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
              if (codes.length) { lastScanAll = codes.map(c => c.rawValue); return finish(pickBest(lastScanAll)); }
            } catch { /* nächster Versuch */ }
            raf = requestAnimationFrame(tick);
          };
          tick();
        } else {
          await loadZxing();
          if (stopped) return;
          zxReader = new window.ZXing.BrowserMultiFormatReader();
          await zxReader.decodeFromConstraints(
            { video: { facingMode: 'environment' }, audio: false },
            video,
            (result) => { if (result) finish(result.getText()); },
          );
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
