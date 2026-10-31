// Service worker: при первом открытии кэширует все файлы приложения, дальше отдаёт их из кэша —
// поэтому «Умножайка» работает в режиме полёта. При выпуске новой версии меняйте VERSION.
//
// Все проекты GitHub Pages одного аккаунта живут на одном домене и делят Cache Storage,
// поэтому имя кэша включает адрес приложения, файлы берутся только из своего кэша,
// а удаляем мы только свои старые кэши.

const VERSION = '1.0.4';
const PREFIX = `umnozhayka@${new URL(self.registration.scope).pathname}#`;
const CACHE = `${PREFIX}${VERSION}`;
/** Так назывались кэши до версии 1.0.3 — без адреса приложения, как и кэши соседей. */
const LEGACY_PREFIX = 'umnozhayka-';

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

async function precache() {
  const cache = await caches.open(CACHE);
  // cache: 'reload' — мимо HTTP-кэша, чтобы новая версия не смешалась со старыми файлами
  await cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' })));
}

/** Соседнее приложение на том же домене может стереть наш кэш — тогда тихо скачиваем его заново. */
async function ensurePrecached() {
  const cache = await caches.open(CACHE);
  if ((await cache.keys()).length < ASSETS.length) await precache();
}

/**
 * Ищем только в своём кэше. caches.match() смотрит во все кэши домена по порядку создания,
 * и файлы прошлой версии или соседа с тем же адресом нашлись бы раньше наших.
 */
async function fromCache(request) {
  const cache = await caches.open(CACHE);
  return cache.match(request, { ignoreSearch: true });
}

/** Кэш нашей версии до 1.0.3, а не соседа с похожим именем: в нём лежит наша страница. */
async function isOurLegacyCache(name) {
  if (!name.startsWith(LEGACY_PREFIX)) return false;
  const cache = await caches.open(name);
  return Boolean(await cache.match('./index.html'));
}

async function reloadWindow(client) {
  try {
    await client.navigate(client.url);
  } catch {
    // браузер не умеет WindowClient.navigate() — новая версия откроется в следующий раз
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    let fromLegacy = false;
    for (const name of await caches.keys()) {
      if (name === CACHE) continue;
      if (name.startsWith(PREFIX)) {
        await caches.delete(name);
      } else if (await isOurLegacyCache(name)) {
        await caches.delete(name);
        fromLegacy = true;
      }
    }
    await self.clients.claim();
    if (fromLegacy) {
      // Версия до 1.0.3 на общем домене могла показать «Не получилось запуститься», а сама
      // она при обновлении не перезагружается. Перезагружаем открытые окна сами. Не ждём:
      // запрос новой страницы придёт сюда же и будет ждать окончания этой активации.
      for (const client of await self.clients.matchAll({ type: 'window' })) reloadWindow(client);
    }
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
      const cached = await fromCache(request) ?? await fromCache('./index.html');
      return cached ?? fetch(request);
    })());
    event.waitUntil(ensurePrecached().catch(() => {}));
    return;
  }

  event.respondWith((async () => {
    const cached = await fromCache(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(request, copy));
    }
    return response;
  })());
});
