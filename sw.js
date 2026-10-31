// Service worker: при первом открытии кэширует все файлы приложения, дальше отдаёт их из кэша —
// поэтому «Умножайка» работает в режиме полёта. При выпуске новой версии меняйте VERSION.

const VERSION = '1.0.2';
const CACHE = `umnozhayka-${VERSION}`;

const ASSETS = [
  './',
  './index.html',
  './selftest.html',
  './manifest.webmanifest',
  './css/styles.css',
  './icons/favicon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './js/main.js',
  './js/selftest.js',
  './js/core/dates.js',
  './js/core/diagnostic.js',
  './js/core/facts.js',
  './js/core/knowledge.js',
  './js/core/leitner.js',
  './js/core/merge.js',
  './js/core/profile.js',
  './js/core/progress.js',
  './js/core/rng.js',
  './js/core/session.js',
  './js/storage/db.js',
  './js/transfer/base45.js',
  './js/transfer/base64.js',
  './js/transfer/crc32.js',
  './js/transfer/deflate.js',
  './js/transfer/format.js',
  './js/transfer/pack.js',
  './js/transfer/qr-common.js',
  './js/transfer/qr-decode.js',
  './js/transfer/qr-encode.js',
  './js/transfer/qr-worker.js',
  './js/transfer/wire.js',
  './js/ui/audio.js',
  './js/ui/common.js',
  './js/ui/dom.js',
  './js/ui/transfer-ui.js',
  './js/ui/components/chart.js',
  './js/ui/components/explain.js',
  './js/ui/components/keypad.js',
  './js/ui/components/modal.js',
  './js/ui/components/owl.js',
  './js/ui/components/qr-view.js',
  './js/ui/components/visuals.js',
  './js/ui/screens/blitz.js',
  './js/ui/screens/diagnostic.js',
  './js/ui/screens/home.js',
  './js/ui/screens/lesson.js',
  './js/ui/screens/lessons.js',
  './js/ui/screens/parent.js',
  './js/ui/screens/profiles.js',
  './js/ui/screens/progress.js',
  './js/ui/screens/rewards.js',
  './js/ui/screens/summary.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // cache: 'reload' — мимо HTTP-кэша, чтобы новая версия не смешалась со старыми файлами
    await cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('umnozhayka-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    // Страница из кэша (приложение или самопроверка); любой другой адрес — index.html.
    event.respondWith((async () => {
      const cached = await caches.match(request, { ignoreSearch: true })
        ?? await caches.match('./index.html', { ignoreSearch: true });
      return cached ?? fetch(request);
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(request, copy));
    }
    return response;
  })());
});
