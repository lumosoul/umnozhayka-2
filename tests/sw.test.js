// Service worker на общем домене GitHub Pages: файлы — только из своего кэша, при обновлении
// удаляются только свои старые кэши, стёртый соседом кэш докачивается.
// sw.js выполняется в отдельном контексте node:vm с поддельными caches, clients и fetch.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const SCOPE = 'https://lumosoul.github.io/umnozhayka-2/';
const VERSION = /const VERSION = '([^']+)'/.exec(SOURCE)[1];
const CACHE = `umnozhayka@/umnozhayka-2/#${VERSION}`;
const ASSET_COUNT = [.../const ASSETS = \[([\s\S]*?)\];/.exec(SOURCE)[1].matchAll(/'([^']+)'/g)].length;

const abs = (url) => new URL(url, SCOPE).href;

/** Кэш с поиском, как в браузере: адрес без учёта ?параметров по просьбе. */
class FakeCache {
  entries = new Map();

  constructor(fetch) {
    this.fetch = fetch;
  }

  async match(request, { ignoreSearch = false } = {}) {
    const strip = (u) => {
      const x = new URL(u);
      if (ignoreSearch) x.search = '';
      return x.href;
    };
    const wanted = strip(abs(request.url ?? request));
    for (const [url, body] of this.entries) {
      if (strip(url) === wanted) return new Response(body);
    }
    return undefined;
  }

  async put(request, response) {
    this.entries.set(abs(request.url ?? request), await response.text());
  }

  async addAll(requests) {
    for (const r of requests) await this.put(r, await this.fetch(r));
  }

  async keys() {
    return [...this.entries.keys()].map((url) => ({ url }));
  }
}

/** Одно «устройство»: Cache Storage домена (кэши — в порядке создания), окна, сеть. */
function world(initial = {}, { windows = [] } = {}) {
  const store = new Map();
  const w = {
    online: true,
    navigated: [],
    handlers: {},
    caches: {
      async open(name) {
        if (!store.has(name)) store.set(name, new FakeCache(w.fetch));
        return store.get(name);
      },
      async keys() { return [...store.keys()]; },
      async has(name) { return store.has(name); },
      async delete(name) { return store.delete(name); },
      // Как в браузере: ищет во всех кэшах домена по порядку создания.
      async match(request, options) {
        for (const cache of store.values()) {
          const found = await cache.match(request, options);
          if (found) return found;
        }
        return undefined;
      },
    },
    async fetch(request) {
      if (!w.online) throw new TypeError('Failed to fetch');
      return new Response(`новое ${new URL(abs(request.url ?? request)).pathname}`);
    },
    /** Событие service worker; ждём respondWith и все waitUntil. */
    async dispatch(type, fields = {}) {
      const waits = [];
      let response;
      w.handlers[type]({ ...fields, waitUntil: (p) => waits.push(p), respondWith: (p) => { response = p; } });
      const result = await response;
      await Promise.all(waits);
      return result;
    },
    async open(url, mode = 'navigate') {
      const response = await w.dispatch('fetch', { request: { url: abs(url), method: 'GET', mode } });
      return response.text();
    },
  };
  for (const [name, files] of Object.entries(initial)) {
    const cache = new FakeCache(w.fetch);
    for (const [url, body] of Object.entries(files)) cache.entries.set(abs(url), body);
    store.set(name, cache);
  }
  const self = {
    registration: { scope: SCOPE },
    location: new URL('sw.js', SCOPE),
    addEventListener: (type, fn) => { w.handlers[type] = fn; },
    skipWaiting: async () => {},
    clients: {
      claim: async () => {},
      matchAll: async () => windows.map((url) => ({ url, navigate: async (to) => { w.navigated.push(to); } })),
    },
  };
  // Request в service worker понимает относительные адреса — от адреса sw.js.
  class SwRequest extends Request {
    constructor(input, init) { super(typeof input === 'string' ? abs(input) : input, init); }
  }
  vm.runInNewContext(SOURCE, { self, caches: w.caches, fetch: w.fetch, Request: SwRequest, Response, URL, console });
  return w;
}

async function install(w) {
  await w.dispatch('install');
  await w.dispatch('activate');
}

test('файлы берутся только из своего кэша, даже если в кэше, созданном раньше, есть те же адреса', async () => {
  const w = world({ 'другое-приложение': { './': 'чужое', './index.html': 'чужое', './js/main.js': 'чужое' } });
  await install(w);
  w.online = false;
  assert.equal(await w.open('./'), 'новое /umnozhayka-2/');
  assert.equal(await w.open('./js/main.js?v=1', 'cors'), 'новое /umnozhayka-2/js/main.js');
  assert.ok(await w.caches.has('другое-приложение'), 'чужой кэш удалён');
});

test('обновление с версии 1.0.2: свой старый кэш удаляется, кэши соседей остаются, окна перезагружаются', async () => {
  const w = world({
    'umnozhayka-1.0.2': { './': 'старое', './index.html': 'старое' },
    'umnozhayka-v1': { '/umnozhayka-1/': 'сосед', '/umnozhayka-1/index.html': 'сосед' },
    'umnozhayka@/umnozhayka-2/#1.0.3': { './index.html': 'прошлое' },
    'umnozhayka@/umnozhayka-1/#2.0.0': { '/umnozhayka-1/index.html': 'сосед' },
  }, { windows: [SCOPE, `${SCOPE}selftest.html`] });
  await install(w);
  assert.deepEqual(await w.caches.keys(), ['umnozhayka-v1', 'umnozhayka@/umnozhayka-1/#2.0.0', CACHE]);
  assert.deepEqual(w.navigated, [SCOPE, `${SCOPE}selftest.html`]);
  w.online = false;
  assert.equal(await w.open('./'), 'новое /umnozhayka-2/');
});

test('обычное обновление удаляет прошлую версию и не перезагружает открытые окна', async () => {
  const w = world({ 'umnozhayka@/umnozhayka-2/#1.0.3': { './index.html': 'прошлое' } }, { windows: [SCOPE] });
  await install(w);
  assert.deepEqual(await w.caches.keys(), [CACHE]);
  assert.deepEqual(w.navigated, []);
});

test('если сосед стёр наш кэш, при открытии с интернетом он скачивается заново', async () => {
  const w = world();
  await install(w);
  assert.equal((await (await w.caches.open(CACHE)).keys()).length, ASSET_COUNT);
  await w.caches.delete(CACHE);
  assert.equal(await w.open('./'), 'новое /umnozhayka-2/');
  assert.equal((await (await w.caches.open(CACHE)).keys()).length, ASSET_COUNT);
  w.online = false;
  assert.equal(await w.open('./'), 'новое /umnozhayka-2/');
});

test('без сети любой адрес приложения открывает index.html, а самопроверка — свою страницу', async () => {
  const w = world();
  await install(w);
  w.online = false;
  assert.equal(await w.open('./?source=pwa'), 'новое /umnozhayka-2/');
  assert.equal(await w.open('./какой-то/адрес'), 'новое /umnozhayka-2/index.html');
  assert.equal(await w.open('./selftest.html'), 'новое /umnozhayka-2/selftest.html');
});
