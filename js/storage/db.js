// Хранилище на IndexedDB: профиль — один документ (все факты, журнал занятий, награды),
// настройки — отдельная запись. Если IndexedDB недоступна (редкий приватный режим),
// работаем в памяти и честно предупреждаем, что прогресс не сохранится.

import { normalizeProfile } from '../core/profile.js';

const DB_NAME = 'umnozhayka';
const DB_VERSION = 1;
const PROFILES = 'profiles';
const SETTINGS = 'settings';
const SETTINGS_KEY = 'app';

export const DEFAULT_SETTINGS = Object.freeze({
  sound: true,
  activeProfileId: null,
  qrSpeed: 700,
});

let dbPromise = null;
let memory = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error('IndexedDB недоступна'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(PROFILES)) db.createObjectStore(PROFILES, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(SETTINGS)) db.createObjectStore(SETTINGS, { keyPath: 'key' });
    };
    req.onsuccess = () => {
      const db = req.result;
      // Если другая вкладка обновляет схему — закрываемся, чтобы её не блокировать.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error('Не удалось открыть базу'));
    req.onblocked = () => reject(new Error('База занята другой вкладкой'));
  });
  return dbPromise;
}

function run(storeName, mode, action) {
  if (memory) return Promise.resolve(action(null));
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let result;
    const req = action(store);
    if (req) req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error ?? new Error('Ошибка записи'));
    tx.onabort = () => reject(tx.error ?? new Error('Запись прервана'));
  }));
}

export const storage = {
  persistent: true,

  async init() {
    try {
      await openDb();
    } catch {
      memory = { profiles: new Map(), settings: { ...DEFAULT_SETTINGS } };
      this.persistent = false;
    }
    return this.persistent;
  },

  /** Защищены ли данные от автоматической очистки браузером (null — браузер не сообщает). */
  async isProtected() {
    try {
      return (await navigator.storage?.persisted?.()) ?? null;
    } catch {
      return null;
    }
  },

  /**
   * Просим браузер не удалять данные при нехватке места. Вызывать только по нажатию взрослого:
   * Firefox показывает на это запрос разрешения, и промис ждёт ответа — запуск ждать его не должен.
   */
  async protect() {
    try {
      return Boolean(await navigator.storage?.persist?.());
    } catch {
      return false;
    }
  },

  async loadProfiles() {
    const raw = memory
      ? [...memory.profiles.values()].map((p) => JSON.parse(JSON.stringify(p)))
      : await run(PROFILES, 'readonly', (store) => store.getAll());
    const out = [];
    for (const p of raw ?? []) {
      try {
        out.push(normalizeProfile(p));
      } catch {
        // повреждённую запись пропускаем, остальные профили загружаем
      }
    }
    return out.sort((x, y) => x.createdAt - y.createdAt);
  },

  async saveProfile(profile) {
    const copy = JSON.parse(JSON.stringify(profile));
    if (memory) {
      memory.profiles.set(copy.id, copy);
      return;
    }
    await run(PROFILES, 'readwrite', (store) => store.put(copy));
  },

  async saveProfiles(list) {
    const copies = list.map((p) => JSON.parse(JSON.stringify(p)));
    if (memory) {
      for (const c of copies) memory.profiles.set(c.id, c);
      return;
    }
    await run(PROFILES, 'readwrite', (store) => {
      for (const c of copies) store.put(c);
      return null;
    });
  },

  async deleteProfile(id) {
    if (memory) {
      memory.profiles.delete(id);
      return;
    }
    await run(PROFILES, 'readwrite', (store) => store.delete(id));
  },

  async loadSettings() {
    if (memory) return { ...memory.settings };
    const rec = await run(SETTINGS, 'readonly', (store) => store.get(SETTINGS_KEY));
    const { key, ...rest } = rec ?? {};
    return { ...DEFAULT_SETTINGS, ...rest };
  },

  async saveSettings(settings) {
    if (memory) {
      memory.settings = { ...settings };
      return;
    }
    await run(SETTINGS, 'readwrite', (store) => store.put({ ...settings, key: SETTINGS_KEY }));
  },
};
