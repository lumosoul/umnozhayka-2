// Самопроверка устройства (selftest.html): прямо в этом браузере проверяет всё, на чём держится
// «Умножайка», — модули, логику занятий, IndexedDB, service worker и кэш, воркер с распознаванием QR,
// перенос данных, установку, звук, озвучку и камеру. Данные детей не трогает: запись в IndexedDB
// проверяется на отдельной временной базе, а базу приложения страница только открывает и читает.

import { h } from './ui/dom.js';
import { voice } from './ui/audio.js';
import { DB_NAME, storage } from './storage/db.js';
import { createProfile, normalizeProfile } from './core/profile.js';
import { LessonRunner, planLesson } from './core/session.js';
import { scheduleAfterAnswer } from './core/leitner.js';
import { recordSession } from './core/progress.js';
import { createRng } from './core/rng.js';
import { DAY_MS, dayNumber } from './core/dates.js';
import { encodeQR } from './transfer/qr-encode.js';
import {
  QrCollector, exportCode, exportJson, exportQrChunks, importCode, importJson,
} from './transfer/format.js';

window.__selftestStarted = true;

const MARKS = { ok: '✓', warn: '!', fail: '✗', info: 'i', wait: '…' };
const WORDS = { ok: 'работает', warn: 'есть замечание', fail: 'не работает', info: 'сведения', wait: 'проверяется' };
const TEST_DB = `umnozhayka-selftest@${new URL('../', import.meta.url).pathname}`;
/** Так service worker называет кэш этого приложения (адрес приложения в имени — см. sw.js). */
const CACHE_PREFIX = `umnozhayka@${new URL('../', import.meta.url).pathname}#`;
/** Без этих файлов в кэше приложение не откроется в режиме полёта. */
const CRITICAL = ['./', './index.html', './selftest.html', './manifest.webmanifest', './css/styles.css',
  './js/main.js', './js/selftest.js', './js/transfer/qr-worker.js'];

const ua = navigator.userAgent;
const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

const list = document.getElementById('checks');
const summary = document.getElementById('summary');
const manual = document.getElementById('manual');
const preview = document.getElementById('preview');
const items = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const timeout = (promise, ms, what) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`нет ответа за ${Math.round(ms / 1000)} с: ${what}`)), ms)),
]);

async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v || null;
    await sleep(100);
  }
}

const canonical = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]]))
  : x));

function addItem(title, { counted = true } = {}) {
  const mark = h('span', { class: 'selftest__mark', 'aria-hidden': 'true' });
  const state = h('span', { class: 'sr-only' });
  const detail = h('span', { class: 'selftest__detail' });
  list.append(h('li', null, mark, h('span', { class: 'selftest__title' }, title, state), detail));
  const item = {
    title,
    counted,
    status: 'wait',
    detail: '',
    set(status, text = '') {
      item.status = status;
      item.detail = text;
      mark.className = `selftest__mark selftest__mark--${status}`;
      mark.textContent = MARKS[status];
      state.textContent = ` — ${WORDS[status]}`;
      detail.textContent = text;
    },
  };
  item.set('wait');
  items.push(item);
  return item;
}

async function check(title, fn) {
  const item = addItem(title);
  try {
    const { status = 'ok', detail = '' } = await timeout(Promise.resolve().then(fn), 30000, title);
    item.set(status, detail);
  } catch (err) {
    item.set('fail', String(err?.message ?? err));
  }
  return item;
}

function browserName() {
  if (isIOS) {
    const os = /OS (\d+)_(\d+)/.exec(ua);
    const app = /CriOS/.test(ua) ? 'Chrome' : /FxiOS/.test(ua) ? 'Firefox' : /EdgiOS/.test(ua) ? 'Edge' : 'Safari';
    return `${app} на iOS${os ? ` ${os[1]}.${os[2]}` : ''} (движок WebKit)`;
  }
  const ver = (re) => re.exec(ua)?.[1] ?? '';
  if (/EdgA?\//.test(ua)) return `Microsoft Edge ${ver(/EdgA?\/([\d.]+)/)}`;
  if (/Firefox\//.test(ua)) return `Firefox ${ver(/Firefox\/([\d.]+)/)}`;
  if (/Chrome\//.test(ua)) return `Chrome ${ver(/Chrome\/([\d.]+)/)}`;
  if (/AppleWebKit\//.test(ua)) {
    return /Linux|X11/.test(ua) ? 'WebKitGTK (движок WebKit)' : `Safari ${ver(/Version\/([\d.]+)/)} (движок WebKit)`;
  }
  return 'неизвестный браузер';
}

function installHint() {
  if (isIOS) return 'Чтобы установить: Safari → «Поделиться» → «На экран „Домой“».';
  if (/Android/.test(ua)) return 'Чтобы установить: меню ⋮ → «Установить приложение».';
  if (/Firefox\//.test(ua)) return 'Firefox на компьютере открывает приложение во вкладке — без интернета оно тоже работает.';
  return 'Чтобы установить: значок установки справа в адресной строке.';
}

/** Профиль после нескольких занятий с ошибками — реалистичные данные для проверок. */
let practicedCache = null;
function practiced() {
  if (practicedCache) return practicedCache;
  const rng = createRng(2026);
  const start = Date.now() - 3 * DAY_MS;
  const p = createProfile({ name: 'Проверка', now: start });
  for (let day = 0; day < 3; day++) {
    let now = start + day * DAY_MS;
    const plan = planLesson(p, { now, rng });
    const runner = new LessonRunner(p, plan, { rng, clock: () => now });
    for (let k = 0; !runner.finished; k++) {
      const task = runner.current();
      const wrong = k % 7 === 3;
      const value = task.format === 'truefalse' ? task.truth !== wrong : task.answer + (wrong ? 1 : 0);
      runner.answer(value, 1500 + (k % 5) * 900);
      if (wrong) runner.checkCorrection(task.product);
      now += 6000;
      runner.next();
    }
    recordSession(p, runner.summary(), { now });
  }
  practicedCache = normalizeProfile(JSON.parse(JSON.stringify(p)));
  return practicedCache;
}

// ---------- автоматические проверки ----------

function checkSecure() {
  if (!isSecureContext) {
    return { status: 'fail', detail: 'Откройте приложение по защищённому адресу (HTTPS), например на GitHub Pages: без этого не работают service worker и камера.' };
  }
  return { detail: location.protocol === 'https:' ? 'страница открыта по HTTPS' : 'localhost — для проверки этого достаточно' };
}

function checkJavaScript() {
  const need = {
    'Array.prototype.at': typeof [].at === 'function',
    'Array.prototype.flat': typeof [].flat === 'function',
    'Object.fromEntries': typeof Object.fromEntries === 'function',
    TextEncoder: typeof TextEncoder === 'function',
    'Web Worker': typeof Worker === 'function',
    Canvas: typeof HTMLCanvasElement === 'function',
  };
  const missing = Object.keys(need).filter((k) => !need[k]);
  return missing.length
    ? { status: 'fail', detail: `нет: ${missing.join(', ')}` }
    : { detail: 'модули загрузились, всё нужное на месте' };
}

function checkLogic() {
  const today = dayNumber();
  const steps = [1, 2, 3, 4].map((box) => scheduleAfterAnswer({ box, due: today }, { correct: true, ms: 2000 }, today).due - today);
  const slow = scheduleAfterAnswer({ box: 3, due: today }, { correct: true, ms: 7000 }, today).box;
  const reset = scheduleAfterAnswer({ box: 4, due: today }, { correct: false, ms: 2000 }, today).box;
  const plan = planLesson(createProfile({ name: 'Проверка' }), { rng: createRng(7) });
  const runner = new LessonRunner(createProfile({ name: 'Проверка' }), plan, { rng: createRng(7) });
  const task = runner.current();
  runner.answer(task.format === 'truefalse' ? !task.truth : task.answer + 1, 3000);
  const back = runner.queue.findIndex((x, i) => i > runner.index && x.kind === 'retry');
  const gap = back - runner.index - 1;
  const problems = [];
  if (steps.join() !== '1,3,7,14' || slow !== 3 || reset !== 1) problems.push(`коробки Лейтнера: ${steps.join(', ')}`);
  if (plan.queue.length !== 20 || plan.newFacts.length > 3) problems.push(`план: ${plan.queue.length} заданий, новых ${plan.newFacts.length}`);
  if (gap < 2 || gap > 3) problems.push(`ошибка вернётся через ${gap}`);
  return problems.length
    ? { status: 'fail', detail: problems.join('; ') }
    : { detail: 'интервалы 0–1–3–7–14 дней, 20 заданий, не больше 3 новых, ошибка вернётся через 2–3 задания' };
}

function idb(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('ошибка IndexedDB'));
  });
}

function openTestDb() {
  const req = indexedDB.open(TEST_DB, 1);
  req.onupgradeneeded = () => req.result.createObjectStore('p', { keyPath: 'id' });
  return idb(req);
}

function put(db, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('p', 'readwrite');
    tx.objectStore('p').put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('запись не удалась'));
    tx.onabort = () => reject(tx.error ?? new Error('запись прервана'));
  });
}

async function checkIndexedDb() {
  if (!globalThis.indexedDB) {
    return { status: 'fail', detail: 'IndexedDB недоступна (возможно, приватный режим) — прогресс не сохранится' };
  }
  const profile = practiced();
  let db = await openTestDb();
  await put(db, JSON.parse(JSON.stringify(profile)));
  db.close();
  db = await openTestDb(); // открываем заново — как после перезагрузки
  const back = await idb(db.transaction('p').objectStore('p').get(profile.id));
  db.close();
  await idb(indexedDB.deleteDatabase(TEST_DB));
  if (!back || canonical(normalizeProfile(back)) !== canonical(profile)) {
    return { status: 'fail', detail: 'прочитанные данные отличаются от записанных' };
  }
  const kb = Math.ceil(JSON.stringify(profile).length / 1024);
  return { detail: `профиль (${kb} КБ) записан, прочитан заново и совпал; временная база удалена` };
}

async function checkAppDb() {
  if (!(await storage.init())) {
    return { status: 'fail', detail: 'база приложения не открылась — прогресс проживёт только до закрытия вкладки' };
  }
  await storage.loadSettings();
  const profiles = await storage.loadProfiles();
  return { detail: `«${DB_NAME}» открывается, профилей: ${profiles.length}` };
}

/** Другие приложения на том же домене (на GitHub Pages он общий для всех проектов аккаунта). */
async function neighbours() {
  const dbs = ((await indexedDB.databases?.().catch(() => null)) ?? [])
    .map((d) => d.name)
    .filter((name) => name !== DB_NAME && name !== TEST_DB);
  const other = globalThis.caches ? (await caches.keys()).filter((k) => !k.startsWith(CACHE_PREFIX)) : [];
  return [...dbs, ...other];
}

async function checkPersistence() {
  if (isIOS && standalone) return { detail: 'приложение на экране «Домой» — Safari не удаляет его данные' };
  const persisted = await navigator.storage?.persisted?.().catch(() => null);
  if (persisted) return { detail: 'браузер не удалит данные при нехватке места' };
  return {
    status: 'warn',
    detail: isIOS
      ? 'Safari может удалить данные сайта, если его не открывать 7 дней. Установите приложение на экран «Домой» и иногда сохраняйте файл прогресса.'
      : 'Браузер может удалить данные при нехватке места. В разделе «Для взрослых» есть кнопка «Защитить данные от очистки».',
  };
}

async function checkServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    return { status: 'fail', detail: 'service worker не поддерживается — без интернета приложение не откроется' };
  }
  if (!isSecureContext) return { status: 'fail', detail: 'нужно защищённое соединение (HTTPS)' };
  await navigator.serviceWorker.register('./sw.js');
  await timeout(navigator.serviceWorker.ready, 20000, 'service worker');
  const cache = await waitFor(async () => {
    const name = (await caches.keys()).filter((k) => k.startsWith(CACHE_PREFIX)).at(-1);
    if (!name) return null;
    const store = await caches.open(name);
    const count = (await store.keys()).length;
    return count ? { name, store, count } : null;
  }, 20000);
  if (!cache) return { status: 'fail', detail: 'кэш приложения не появился' };
  const missing = [];
  for (const path of CRITICAL) {
    if (!(await cache.store.match(new URL(path, location.href).href))) missing.push(path);
  }
  if (missing.length) return { status: 'fail', detail: `в кэше нет: ${missing.join(', ')}` };
  const controlled = await waitFor(() => navigator.serviceWorker.controller, 5000);
  return controlled
    ? { detail: `${cache.name}: в кэше ${cache.count} файлов — можно включать режим полёта` }
    : { status: 'warn', detail: `файлы сохранены (${cache.count}), но страница ещё не под управлением service worker — обновите её один раз` };
}

async function checkQrWorker() {
  const text = `UM1:TEST:1:1:${Date.now().toString(36).toUpperCase()}`;
  const qr = encodeQR(text, { ecl: 'M' });
  const scale = 6;
  const side = (qr.size + 8) * scale;
  const canvas = document.createElement('canvas');
  canvas.width = side;
  canvas.height = side;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, side, side);
  ctx.fillStyle = '#000000';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y * qr.size + x]) ctx.fillRect((x + 4) * scale, (y + 4) * scale, scale, scale);
    }
  }
  const img = ctx.getImageData(0, 0, side, side);
  const worker = new Worker(new URL('./transfer/qr-worker.js', import.meta.url), { type: 'module' });
  const t0 = performance.now();
  try {
    const got = await timeout(new Promise((resolve, reject) => {
      worker.onmessage = (e) => resolve(e.data.text);
      worker.onerror = (e) => reject(new Error(e.message || 'воркер с модулями не запустился'));
      worker.postMessage({ id: 1, width: img.width, height: img.height, buffer: img.data.buffer }, [img.data.buffer]);
    }), 15000, 'распознавание QR');
    if (got !== text) return { status: 'fail', detail: 'QR-код не распознан' };
    return { detail: `свой генератор и считыватель QR, распознавание в отдельном потоке — ${Math.round(performance.now() - t0)} мс` };
  } finally {
    worker.terminate();
  }
}

function checkTransfer() {
  const p = practiced();
  const want = canonical(p);
  const viaFile = importJson(exportJson([p])).profiles[0];
  const viaCode = importCode(exportCode([p]).code).profiles[0];
  const qr = exportQrChunks([p]);
  const collector = new QrCollector();
  for (const chunk of [...qr.chunks].reverse()) collector.add(chunk);
  const viaQr = collector.result().profiles[0];
  const broken = [['файл', viaFile], ['код', viaCode], ['QR', viaQr]]
    .filter(([, x]) => canonical(x) !== want)
    .map(([name]) => name);
  if (broken.length) return { status: 'fail', detail: `данные изменились при переносе: ${broken.join(', ')}` };
  const download = 'download' in HTMLAnchorElement.prototype
    ? 'файл скачивается'
    : 'скачивание файлов не поддерживается — переносите кодом или QR';
  return { detail: `совпало байт в байт; ${download}; QR-кодов для этого профиля: ${qr.chunks.length}` };
}

function imageSize(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(`${img.naturalWidth}x${img.naturalHeight}`);
    img.onerror = () => resolve('ошибка');
    img.src = src;
  });
}

async function checkInstall() {
  const manifest = await (await fetch('manifest.webmanifest')).json();
  const srcs = [...manifest.icons.map((i) => i.src), 'icons/apple-touch-icon.png'];
  const want = [...manifest.icons.map((i) => i.sizes), '180x180'];
  const sizes = await Promise.all(srcs.map(imageSize));
  const wrong = srcs.filter((src, i) => sizes[i] !== want[i]);
  if (wrong.length) return { status: 'fail', detail: `иконки не загрузились: ${wrong.join(', ')}` };
  if (standalone) return { detail: 'приложение установлено и открыто с главного экрана' };
  return { detail: `манифест и иконки в порядке. ${installHint()}` };
}

function checkAudio() {
  return globalThis.AudioContext || globalThis.webkitAudioContext
    ? { detail: 'поддерживается — послушайте кнопкой «🔊 Проверить звук» ниже' }
    : { status: 'warn', detail: 'Web Audio недоступен — приложение будет работать без звуков' };
}

function loadVoices() {
  const now = speechSynthesis.getVoices();
  if (now.length) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => resolve(speechSynthesis.getVoices());
    speechSynthesis.addEventListener('voiceschanged', done, { once: true });
    setTimeout(done, 2000);
  });
}

async function checkSpeech() {
  if (!voice.available) return { status: 'warn', detail: 'синтеза речи нет — не будет кнопки 🔈, остальное работает' };
  const voices = await loadVoices();
  const ru = voices.filter((v) => v.lang?.toLowerCase().startsWith('ru'));
  if (ru.length) return { detail: `русские голоса: ${ru.slice(0, 3).map((v) => v.name).join(', ')}` };
  return {
    status: 'warn',
    detail: voices.length
      ? 'русского голоса нет — добавьте его в настройках устройства (раздел «Устная речь» или «Синтез речи»)'
      : 'голоса не загружены — проверьте кнопкой «🔈 Прочитать вслух» ниже',
  };
}

function checkCamera() {
  return navigator.mediaDevices?.getUserMedia && isSecureContext
    ? { detail: 'доступ к камере поддерживается — проверьте его кнопкой «📷 Проверить камеру» ниже' }
    : { status: 'warn', detail: 'камера из браузера недоступна — переносите данные кодом, файлом или QR с фото' };
}

// ---------- проверки с участием взрослого ----------

let audioCtx = null;

async function testSound(item) {
  try {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) throw new Error('Web Audio недоступен');
    audioCtx ??= new AC();
    await audioCtx.resume();
    [659.25, 880].forEach((freq, i) => {
      const t0 = audioCtx.currentTime + i * 0.12;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.frequency.setValueAtTime(freq, t0);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.1, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.3);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.35);
    });
    item.set(audioCtx.state === 'running' ? 'ok' : 'warn', audioCtx.state === 'running'
      ? 'звук играет; если ничего не слышно — проверьте беззвучный режим и громкость'
      : `аудио не запустилось (состояние «${audioCtx.state}»)`);
  } catch (err) {
    item.set('fail', String(err?.message ?? err));
  }
}

function testSpeech(item) {
  if (voice.speak('7 × 8 = ?')) item.set('ok', 'читаю «7 умножить на 8 — сколько будет?»; если не слышно — проверьте громкость');
  else item.set('warn', 'синтеза речи нет');
}

async function testCamera(item) {
  let stream = null;
  item.set('wait', 'жду разрешения на камеру…');
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    const video = h('video', { class: 'selftest__video', playsinline: true, muted: true, autoplay: true });
    video.setAttribute('playsinline', '');
    video.muted = true;
    preview.replaceChildren(video);
    video.srcObject = stream;
    await video.play().catch(() => {});
    const width = await waitFor(() => video.videoWidth, 6000);
    item.set(width ? 'ok' : 'fail', width
      ? `камера работает: ${video.videoWidth}×${video.videoHeight}`
      : 'изображение с камеры не пришло');
    if (width) await sleep(2500);
  } catch (err) {
    item.set('fail', err?.name === 'NotAllowedError'
      ? 'доступ к камере не разрешён — разрешите его в настройках браузера для этого сайта'
      : `камера не включилась: ${err?.message ?? err}`);
  } finally {
    for (const track of stream?.getTracks() ?? []) track.stop();
    preview.replaceChildren();
  }
}

// ---------- отчёт ----------

function reportText() {
  return [
    `Умножайка — проверка устройства, ${new Date().toLocaleString('ru-RU')}`,
    `Адрес: ${location.href}`,
    `Браузер: ${browserName()}`,
    `User-Agent: ${ua}`,
    summary.textContent,
    '',
    ...items.map((i) => `${MARKS[i.status]} ${i.title}${i.detail ? ` — ${i.detail}` : ''}`),
  ].join('\n');
}

async function copyReport(button) {
  const text = reportText();
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    const area = h('textarea', { style: { position: 'fixed', opacity: '0' } });
    area.value = text;
    document.body.append(area);
    area.select();
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
  }
  button.textContent = ok ? '✓ Отчёт скопирован' : 'Не получилось скопировать';
}

function finish() {
  const counted = items.filter((i) => i.counted);
  const passed = counted.filter((i) => i.status === 'ok').length;
  const warned = counted.filter((i) => i.status === 'warn').length;
  const failed = counted.filter((i) => i.status === 'fail').length;
  summary.className = `notice ${failed ? 'notice--calm' : 'notice--good'}`;
  summary.textContent = failed
    ? `Не работает: ${failed} из ${counted.length}. Подробности — в списке ниже.`
    : `Всё работает: ${counted.length} из ${counted.length}${warned ? `, из них с замечаниями — ${warned}` : ''}. «Умножайка» будет работать на этом устройстве.`;
  window.selftest = {
    done: true,
    passed,
    warned,
    failed,
    total: counted.length,
    items: items.map(({ title, status, detail, counted: c }) => ({ title, status, detail, counted: c })),
  };
  document.body.dataset.done = '1';
}

async function main() {
  addItem('Это устройство', { counted: false }).set('info',
    `${browserName()}; экран ${innerWidth}×${innerHeight}, плотность ${devicePixelRatio}; касание: ${navigator.maxTouchPoints > 0 ? 'есть' : 'нет'}; ${standalone ? 'открыто как установленное приложение' : 'открыто в браузере'}`);
  await check('Защищённое соединение', checkSecure);
  await check('Современный JavaScript и ES-модули', checkJavaScript);
  await check('Логика занятий: Лейтнер, план урока, возврат ошибки', checkLogic);
  await check('IndexedDB — хранение прогресса', checkIndexedDb);
  await check('База приложения', checkAppDb);
  await check('Защита данных от очистки браузером', checkPersistence);
  await check('Service worker — работа без интернета', checkServiceWorker);
  await check('Воркер и распознавание QR', checkQrWorker);
  await check('Перенос файлом, кодом и QR без потерь', checkTransfer);
  await check('Установка на главный экран', checkInstall);
  await check('Звук (Web Audio)', checkAudio);
  await check('Чтение вслух по-русски', checkSpeech);
  await check('Камера для сканирования QR', checkCamera);
  const others = await neighbours().catch(() => []);
  if (others.length) {
    addItem('Другие приложения на этом домене', { counted: false })
      .set('info', `хранят свои данные отдельно и «Умножайке» не мешают: ${others.join(', ')}`);
  }

  const soundItem = addItem('Звук — проверка на слух', { counted: false });
  soundItem.set('info', 'нажмите «🔊 Проверить звук»: прозвучат две мягкие ноты');
  const speechItem = addItem('Чтение вслух — проверка на слух', { counted: false });
  speechItem.set('info', 'нажмите «🔈 Прочитать вслух»');
  const cameraItem = addItem('Камера — проверка с разрешением', { counted: false });
  cameraItem.set('info', 'нажмите «📷 Проверить камеру» и разрешите доступ');
  manual.append(
    h('button', { type: 'button', class: 'btn btn--secondary', onClick: () => testSound(soundItem) }, '🔊 Проверить звук'),
    h('button', { type: 'button', class: 'btn btn--secondary', onClick: () => testSpeech(speechItem) }, '🔈 Прочитать вслух'),
    h('button', { type: 'button', class: 'btn btn--secondary', onClick: () => testCamera(cameraItem) }, '📷 Проверить камеру'));
  const copy = document.getElementById('copy');
  copy.addEventListener('click', () => copyReport(copy));
  if (navigator.share) {
    const share = h('button', { type: 'button', class: 'btn btn--secondary', onClick: () => navigator.share({ title: 'Проверка «Умножайки»', text: reportText() }).catch(() => {}) }, '📤 Отправить отчёт');
    copy.after(share);
  }
  finish();
}

main().catch((err) => {
  summary.textContent = `Проверка прервалась: ${err?.message ?? err}`;
});
