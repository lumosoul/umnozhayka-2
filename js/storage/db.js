// Хранилище на IndexedDB: профиль — один документ (все факты, журнал занятий, награды),
// настройки — отдельная запись. Если IndexedDB недоступна (редкий приватный режим),
// работаем в памяти и честно предупреждаем, что прогресс не сохранится.
//
// Имя базы включает адрес приложения: на GitHub Pages все проекты одного аккаунта живут
// на одном домене и делят IndexedDB, а простое имя «umnozhayka» может занять соседнее приложение.

import { normalizeProfile } from '../core/profile.js';

const APP_PATH = new URL('../../', import.meta.url).pathname;
export const DB_NAME = `umnozhayka@${APP_PATH}`;
/** Имя базы до версии 1.0.3: из неё переносим данные, если она точно наша. */
const LEGACY_DB_NAME = 'umnozhayka';
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

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Ошибка базы'));
  });
}

/**
 * Перенос из базы версии 1.0.2. Под старым именем на общем домене может жить чужое приложение,
 * поэтому берём данные, только если там есть оба наших хранилища. Если в старой базе только
 * они, после переноса удаляем её: имя «umnozhayka» снова свободно для соседа.
 */
async function importLegacy(db) {
  const known = await indexedDB.databases?.().catch(() => null);
  if (!known?.some((d) => d.name === LEGACY_DB_NAME)) return;
  const old = await request(indexedDB.open(LEGACY_DB_NAME));
  let onlyOurs = false;
  try {
    if (!old.objectStoreNames.contains(PROFILES) || !old.objectStoreNames.contains(SETTINGS)) return;
    onlyOurs = old.objectStoreNames.length === 2;
    const tx = old.transaction([PROFILES, SETTINGS], 'readonly');
    const [profiles, settings] = await Promise.all([
      request(tx.objectStore(PROFILES).getAll()),
      request(tx.objectStore(SETTINGS).get(SETTINGS_KEY)),
    ]);
    await new Promise((resolve, reject) => {
      const w = db.transaction([PROFILES, SETTINGS], 'readwrite');
      for (const p of profiles) w.objectStore(PROFILES).put(p);
      if (settings) w.objectStore(SETTINGS).put(settings);
      w.oncomplete = () => resolve();
      w.onerror = () => reject(w.error);
      w.onabort = () => reject(w.error);
    });
  } finally {
    old.close();
  }
  if (onlyOurs) indexedDB.deleteDatabase(LEGACY_DB_NAME);
}

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error('IndexedDB недоступна'));
      return;
    }
    let created = false;
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      created = e.oldVersion === 0;
      const db = req.result;
      if (!db.objectStoreNames.contains(PROFILES)) db.createObjectStore(PROFILES, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(SETTINGS)) db.createObjectStore(SETTINGS, { keyPath: 'key' });
    };
    req.onsuccess = () => {
      const db = req.result;
      // Если другая вкладка обновляет схему — закрываемся, чтобы её не блокировать.
      db.onversionchange = () => db.close();
      // База только что создана — один раз заглядываем в базу прошлой версии.
      resolve(created ? importLegacy(db).then(() => db, () => db) : db);
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
      const db = await openDb();
      // Без своих хранилищ работать нельзя — лучше честный режим «в памяти», чем падение.
      if (!db.objectStoreNames.contains(PROFILES) || !db.objectStoreNames.contains(SETTINGS)) {
        throw new Error('В базе нет хранилищ приложения');
      }
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
