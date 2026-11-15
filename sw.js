// Offline-Fähigkeit: App-Dateien werden zwischengespeichert.
// Bei jeder Änderung an der App VERSION erhöhen.
const VERSION = 'paketlager-v16';
const FILES = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest', 'icons/icon.svg', 'img/header.jpg', 'icons/icon-192.png', 'icons/icon-512.png',
  'js/app.js', 'js/icons.js', 'js/store.js', 'js/barcode.js', 'js/scanner.js', 'js/report.js',
  'vendor/qrcode.js', 'vendor/zxing.min.js',
  'fonts/playfair-display-latin-400-normal.woff2', 'fonts/oswald-latin-300-normal.woff2', 'fonts/oswald-latin-600-normal.woff2',
  'fonts/source-sans-3-latin-400-normal.woff2', 'fonts/source-sans-3-latin-600-normal.woff2', 'fonts/source-sans-3-latin-700-normal.woff2',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Netz zuerst (damit Updates sofort ankommen), bei fehlender Verbindung aus dem Cache.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    // immer beim Server nachfragen (kein veralteter Browser-Cache), offline aus dem eigenen Cache
    fetch(new Request(e.request.url, { cache: 'no-cache', credentials: 'same-origin' }))
      .then(res => { const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
