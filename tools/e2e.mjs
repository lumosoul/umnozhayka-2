#!/usr/bin/env node
// Сквозная проверка в настоящем Chrome: первый запуск, диагностика, занятие (с ошибкой и разбором),
// перезагрузка, режим полёта, установка, перенос файлом, кодом и QR (фото и камера),
// вёрстка на ширине 320–1920 px, страница самопроверки. Запуск: node tools/e2e.mjs [папка-для-скриншотов];
// в Microsoft Edge — с путём к нему в переменной CHROME.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, serve, sleep } from './cdp.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = process.argv[2] ?? join(tmpdir(), 'umnozhayka-e2e');
mkdirSync(OUT, { recursive: true });

const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  try {
    const note = await fn();
    results.push({ name, ok: true });
    console.log(`✓ ${name}${note ? ` — ${note}` : ''} (${((Date.now() - t0) / 1000).toFixed(1)} с)`);
    return true;
  } catch (err) {
    results.push({ name, ok: false, error: err.message });
    console.log(`✗ ${name}: ${err.message}`);
    return false;
  }
}
const check = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

/** Что сейчас на экране — для «ребёнка-робота». */
const DESCRIBE = `(() => {
  const app = globalThis.umnozhayka;
  const vis = (s) => [...document.querySelectorAll(s)].filter((e) => e.offsetParent !== null);
  const txt = (s) => vis(s)[0]?.textContent.replace(/\\s+/g, ' ').trim() ?? null;
  const st = { screen: app?.currentName, modal: document.querySelector('.modal h2')?.textContent ?? null, timer: !!document.querySelector('.timer') };
  if (st.modal) st.kind = 'modal';
  else if (vis('.slides').length) { st.kind = 'slides'; st.next = vis('.slides .btn--primary')[0]?.textContent; }
  else if (vis('.new-fact').length) st.kind = 'newFact';
  else if (vis('.correction').length) { st.kind = 'correction'; st.fact = txt('.correction__fact'); st.keypadOn = vis('.correction .key:not(:disabled)').length > 0; }
  else if (vis('.feedback--good').length || vis('.feedback--neutral').length) st.kind = 'feedback';
  else if (vis('.choices').length) { st.kind = 'choice'; st.expr = txt('.task .expr'); st.options = vis('.choice').map((b) => b.firstChild.textContent); st.hint = txt('.task__hint'); }
  else if (vis('.tf').length) { st.kind = 'tf'; st.expr = txt('.task .expr'); }
  else if (vis('.keypad').length && vis('.task .expr').length) { st.kind = 'keypad'; st.expr = txt('.task .expr'); }
  else if (vis('.countdown').length) st.kind = 'countdown';
  else st.kind = 'other';
  return st;
})()`;

function solve(expr) {
  const m = /^(\?|\d+) × (\?|\d+) = (\?|\d+)$/.exec(expr.replace(/\s+/g, ' ').trim());
  if (!m) throw new Error(`не разобрал пример «${expr}»`);
  const [a, b, c] = m.slice(1).map((v) => (v === '?' ? null : Number(v)));
  if (a == null) return { a: c / b, b, answer: c / b, kind: 'missing' };
  if (b == null) return { a, b: c / a, answer: c / a, kind: 'missing' };
  if (c == null) return { a, b, answer: a * b, kind: 'product' };
  return { a, b, answer: a * b === c, kind: 'tf' };
}

/** Пароль-вопрос для взрослых: решаем его, как взрослый. */
async function passGate(page) {
  await page.waitFor(`!!document.querySelector('.modal .expr')`);
  const q = await page.eval(`document.querySelector('.modal .expr').textContent`);
  const [, a, b] = /(\d+) × (\d+)/.exec(q);
  await page.type(String(Number(a) * Number(b)));
  await page.key('Enter');
  await page.waitFor(`umnozhayka.currentName === 'parent' && !document.querySelector('.modal') && !!document.querySelector('.card h2')`);
}

/**
 * Проходит занятие как ребёнок: касаниями и клавиатурой. wrongOnce — ошибиться в первом
 * подходящем задании, чтобы проверить разбор ошибки и возврат примера.
 */
async function playLesson(page, { wrongOnce = false, maxSteps = 400, shots = null } = {}) {
  const log = [];
  let madeError = null;
  const seen = new Set();
  for (let i = 0; i < maxSteps; i++) {
    const st = await page.eval(DESCRIBE);
    if (st.screen === 'summary') return { log, madeError };
    if (st.timer) throw new Error('в обычном занятии виден таймер');
    if (shots && !seen.has(st.kind) && st.kind !== 'other') {
      seen.add(st.kind);
      await page.screenshot(join(shots, `lesson-${st.kind}.png`));
    }
    if (st.kind === 'slides') {
      if (i % 2) await page.key('ArrowRight');
      else await page.tap('.slides .btn--primary');
    } else if (st.kind === 'newFact') {
      await page.tapText('Понятно');
    } else if (st.kind === 'choice') {
      const isZero = st.hint?.startsWith('Правило нуля');
      const target = isZero ? 0 : solve(st.expr).answer;
      const fact = isZero ? null : solve(st.expr);
      let idx = st.options.indexOf(String(target));
      if (wrongOnce && !madeError && !isZero) {
        idx = st.options.findIndex((o) => o !== String(target));
        madeError = `${fact.a}x${fact.b}`;
      }
      if (fact) log.push({ fact: `${fact.a}x${fact.b}`, format: 'choice', correct: st.options[idx] === String(target) });
      if (i % 3 === 0) await page.key(String(idx + 1));
      else await page.tap('.choice', { index: idx });
    } else if (st.kind === 'tf') {
      const s = solve(st.expr);
      log.push({ fact: `${s.a}x${s.b}`, format: 'tf', correct: true });
      await page.key(s.answer ? '1' : '2');
    } else if (st.kind === 'keypad') {
      const s = solve(st.expr);
      let value = s.answer;
      if (wrongOnce && !madeError) {
        value = s.answer + 1;
        madeError = `${s.a}x${s.b}`;
      }
      log.push({ fact: `${s.a}x${s.b}`, format: s.kind === 'missing' ? 'missing' : 'input', correct: value === s.answer });
      if (i % 2) {
        await page.type(String(value));
        await page.key('Enter');
      } else {
        for (const d of String(value)) await page.tap('.keypad .key', { index: d === '0' ? 10 : Number(d) - 1 });
        await page.tap('.key--ok');
      }
    } else if (st.kind === 'correction') {
      if (st.keypadOn) {
        const [, p] = /= (\d+)/.exec(st.fact);
        await page.type(p);
        await page.key('Enter');
      }
    } else if (st.kind === 'modal') {
      throw new Error(`неожиданное окно «${st.modal}»`);
    }
    await sleep(140);
  }
  throw new Error('занятие не закончилось');
}

async function playDiagnostic(page, knownColumns) {
  await page.tapText('Начать');
  let asked = 0;
  for (let i = 0; i < 200; i++) {
    const st = await page.eval(DESCRIBE);
    if (st.kind === 'keypad') {
      const s = solve(st.expr);
      const knows = knownColumns.includes(s.a) || knownColumns.includes(s.b);
      asked += 1;
      if (knows) {
        await page.type(String(s.answer));
        await page.key('Enter');
      } else {
        await page.tapText('Не знаю');
      }
    } else if (await page.eval(`!!document.querySelector('.table-wrap .grid10')`)) {
      return asked;
    }
    await sleep(160);
  }
  throw new Error('диагностика не закончилась');
}

const canonical = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]]))
  : x));

async function profilesJson(page) {
  return page.eval(`JSON.stringify(umnozhayka.profiles)`).then((s) => JSON.parse(s));
}

async function newDevice(browser, url, opts = {}) {
  const page = await browser.newPage({ context: true, ...opts });
  await page.goto(url);
  await page.waitFor('globalThis.umnozhayka?.currentName');
  return page;
}

async function openParentOnFreshDevice(page) {
  await page.waitFor(`umnozhayka.currentName === 'newProfile'`);
  await page.tapText('Перенести прогресс');
  await passGate(page);
}

async function confirmImport(page) {
  await page.waitFor(`document.querySelector('.modal h2')?.textContent === 'Перенос прогресса'`, 30000);
  const text = await page.eval(`document.querySelector('.modal').textContent`);
  await page.tapText('Перенести');
  await page.waitFor(`!document.querySelector('.modal') && umnozhayka.profiles.length > 0`);
  await sleep(300);
  return text;
}

async function main() {
  const { server, port, log: requests } = await serve(ROOT);
  const url = `http://127.0.0.1:${port}/`;
  const browser = await launch();
  let page;
  const state = {};
  const qrFrames = [];
  try {
    page = await browser.newPage({ width: 390, height: 844 });
    await page.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: OUT, eventsEnabled: true }).catch(() => {});
    await page.goto(url);
    await page.waitFor('globalThis.umnozhayka?.currentName');

    await step('Первый запуск: экран нового ученика, без ошибок', async () => {
      check(await page.eval('umnozhayka.currentName') === 'newProfile', 'ожидался экран нового ученика');
      await page.screenshot(join(OUT, '01-new-profile.png'));
      await page.tap('#child-name');
      await page.eval(`document.querySelector('#child-name').value = 'Маша'`);
      await page.tap('.avatar-option', { index: 3 });
      await page.tapText('Готово');
      await page.waitFor(`umnozhayka.currentName === 'diagnostic'`);
    });

    await step('Диагностика: ≤ 20 примеров, от лёгких к трудным, известные факты отмечены', async () => {
      await page.screenshot(join(OUT, '02-diagnostic-intro.png'));
      const asked = await playDiagnostic(page, [1, 10, 2, 5]);
      await page.screenshot(join(OUT, '03-diagnostic-result.png'));
      const p = (await profilesJson(page))[0];
      const known = Object.values(p.facts).filter((f) => f.introduced && f.streak >= 3).length;
      check(asked <= 20, `спрошено ${asked}`);
      check(p.diagnostic?.items === asked, 'итог диагностики не записан');
      check(known >= 50, `отмечено известных: ${known}`);
      state.knownAfterDiag = known;
      await page.tapText('Начать учиться');
      await page.waitFor(`umnozhayka.currentName === 'home'`);
      await page.screenshot(join(OUT, '04-home.png'));
      return `спрошено ${asked}, отмечено известных ${known}`;
    });

    await step('Занятие: 20 заданий, разные форматы, ошибка разобрана и вернулась через 2–3 задания', async () => {
      await page.tapText('Начать занятие');
      await page.waitFor(`umnozhayka.currentName === 'lesson'`);
      await sleep(300);
      await page.screenshot(join(OUT, '05-lesson-start.png'));
      const { log, madeError } = await playLesson(page, { wrongOnce: true, shots: OUT });
      await page.screenshot(join(OUT, '06-summary.png'));
      const formats = new Set(log.map((x) => x.format));
      const errIdx = log.findIndex((x) => !x.correct);
      const back = log.findIndex((x, i) => i > errIdx && x.fact === madeError);
      check(log.length >= 20 && log.length <= 24, `заданий: ${log.length}`);
      check(formats.size >= 3, `форматы: ${[...formats]}`);
      check(madeError && back - errIdx - 1 >= 2 && back - errIdx - 1 <= 3, `ошибка ${madeError} вернулась через ${back - errIdx - 1}`);
      const p = (await profilesJson(page))[0];
      const lesson = p.sessions.find((s) => s.type === 'lesson');
      check(lesson && lesson.stars >= 1, 'занятие не записано');
      state.lessonStars = lesson.stars;
      return `заданий ${log.length}, форматы: ${[...formats].join(', ')}, звёзд ${lesson.stars}`;
    });

    await step('Прогресс сохраняется после перезагрузки', async () => {
      const before = canonical(await profilesJson(page));
      await page.reload();
      await page.waitFor(`umnozhayka.currentName === 'home'`);
      const after = canonical(await profilesJson(page));
      check(before === after, 'данные после перезагрузки отличаются');
      return 'профиль совпал байт в байт';
    });

    await step('Сетка прогресса 10 × 10 и подробности по касанию', async () => {
      await page.tapText('Мой прогресс');
      await page.waitFor(`document.querySelectorAll('.grid10 .cell').length === 100`);
      await page.tap('.cell', { index: 4 });
      await page.waitFor(`!!document.querySelector('.fact-detail dl, .fact-detail p')`);
      await page.screenshot(join(OUT, '07-progress.png'), { full: true });
      const colors = await page.eval(`[...new Set([...document.querySelectorAll('.grid10 .cell')].map((c) => getComputedStyle(c).backgroundColor))].length`);
      check(colors >= 2, 'клетки одного цвета');
      await page.key('ArrowRight');
      const sel = await page.eval(`document.querySelector('.cell[aria-selected="true"]').getAttribute('aria-label')`);
      check(/1 × 6/.test(sel), `стрелка не сработала: ${sel}`);
      return sel;
    });

    await step('Блиц: видимый таймер, 60 секунд, только освоенные факты', async () => {
      await page.eval(`umnozhayka.go('home')`);
      await page.tapText('Блиц 60 секунд');
      await page.waitFor(`umnozhayka.currentName === 'blitz'`);
      await page.tapText('Старт');
      await page.waitFor(`!!document.querySelector('.timer')`, 5000);
      const mastered = await page.eval(`Object.entries(umnozhayka.profile.facts).filter(([, f]) => f.introduced && f.streak >= 3).map(([id]) => id)`);
      let answered = 0;
      let shot = false;
      const seen = new Set();
      const t0 = Date.now();
      while (Date.now() - t0 < 75000) {
        const st = await page.eval(DESCRIBE);
        if (st.screen === 'summary') break;
        if (st.kind === 'keypad') {
          const s = solve(st.expr);
          seen.add(`${s.a}x${s.b}`);
          await page.type(String(s.answer));
          await page.key('Enter');
          answered += 1;
          if (!shot && answered === 3) {
            shot = true;
            await page.screenshot(join(OUT, '12-blitz.png'));
          }
        }
        await sleep(150);
      }
      const secs = (Date.now() - t0) / 1000;
      check(await page.eval(`umnozhayka.currentName`) === 'summary', 'блиц не закончился');
      // Нажатия в последний момент не уводят с итогов: кнопки оживают через 0,7 с.
      await page.key('Enter');
      await page.tapText('На главную');
      await sleep(150);
      check(await page.eval(`umnozhayka.currentName`) === 'summary', 'случайное нажатие увело с экрана итогов');
      check(secs > 55 && secs < 70, `длительность ${secs.toFixed(1)} с`);
      check([...seen].every((id) => mastered.includes(id)), 'в блице встретился неосвоенный факт');
      await page.screenshot(join(OUT, '13-blitz-summary.png'));
      return `ответов ${answered} за ${secs.toFixed(0)} с`;
    });

    await step('Награды и «Уроки и приёмы» открываются, объяснения можно повторить', async () => {
      await page.eval(`umnozhayka.go('rewards')`);
      await page.waitFor(`document.querySelectorAll('.badge').length > 10`);
      const earned = await page.eval(`document.querySelectorAll('.badge:not(.badge--locked)').length`);
      await page.screenshot(join(OUT, '14-rewards.png'), { full: true });
      await page.eval(`umnozhayka.go('lessons')`);
      await page.tapText('Умножение на 0');
      await page.waitFor(`!!document.querySelector('.slides')`);
      for (let i = 0; i < 4; i++) await page.key('ArrowRight');
      await page.waitFor(`!!document.querySelector('.menu-grid')`);
      await page.tapText('Пальцы для ×9');
      await page.waitFor(`!!document.querySelector('.slides')`);
      for (let i = 0; i < 3; i++) await page.key('ArrowRight');
      await page.waitFor(`!!document.querySelector('.fingers')`);
      await page.screenshot(join(OUT, '15-lesson-fingers.png'));
      return `наград получено: ${earned}`;
    });

    await step('Работает в режиме полёта после первой загрузки', async () => {
      await page.waitFor('!!navigator.serviceWorker.controller', 15000);
      await page.waitFor(`caches.keys().then((k) => k.some((x) => x.startsWith('umnozhayka-')))`, 15000);
      const cached = await page.eval(`caches.keys().then(async (k) => (await (await caches.open(k[0])).keys()).length)`);
      const before = requests.length;
      await page.offline(true);
      await page.reload();
      await page.waitFor(`umnozhayka.currentName === 'home'`, 15000);
      await page.tapText('Начать занятие');
      await page.waitFor(`umnozhayka.currentName === 'lesson'`);
      await sleep(400);
      await page.screenshot(join(OUT, '08-offline-lesson.png'));
      await page.key('Escape');
      await page.waitFor(`!!document.querySelector('.modal')`);
      await page.tapText('Закончить');
      await page.waitFor(`['home', 'summary'].includes(umnozhayka.currentName)`);
      check(requests.length === before, `запросы к серверу в офлайне: ${requests.length - before}`);
      await page.offline(false);
      return `в кэше ${cached} файлов, к серверу — 0 запросов`;
    });

    await step('Установка: манифест без ошибок, критерии установки выполнены', async () => {
      const { errors } = await page.send('Page.getAppManifest');
      const inst = await page.send('Page.getInstallabilityErrors');
      check(!errors?.length, `ошибки манифеста: ${JSON.stringify(errors)}`);
      check(!inst.installabilityErrors?.length, `не устанавливается: ${JSON.stringify(inst.installabilityErrors)}`);
      return 'браузер считает приложение устанавливаемым';
    });

    state.source = await profilesJson(page);

    await step('Перенос кодом Base64 на «второе устройство» без потерь', async () => {
      await page.eval(`umnozhayka.go('parent')`);
      await passGate(page);
      await page.screenshot(join(OUT, '09-parent.png'), { full: true });
      await page.tapText('Показать код');
      await page.waitFor(`!!document.querySelector('.modal textarea')`);
      const code = await page.eval(`document.querySelector('.modal textarea').value`);
      await page.tapText('Готово');
      const b = await newDevice(browser, url);
      await openParentOnFreshDevice(b);
      await b.tapText('Ввести код');
      await b.waitFor(`!!document.querySelector('.modal textarea')`);
      await b.eval(`document.querySelector('.modal textarea').value = ${JSON.stringify(code.replace(/(.{60})/g, '$1\n'))}`);
      await b.tapText('Проверить');
      await confirmImport(b);
      const got = await profilesJson(b);
      check(canonical(got) === canonical(state.source), 'данные отличаются');
      await b.close();
      return `код ${code.length} символов`;
    });

    await step('Перенос JSON-файлом без потерь', async () => {
      for (const f of readdirSync(OUT)) if (f.endsWith('.json')) rmSync(join(OUT, f));
      await page.tapText('Сохранить в файл');
      await page.waitFor(`!!document.querySelector('.modal')`);
      await page.tapText('Скачать файл');
      let file = null;
      for (let i = 0; i < 50 && !file; i++) {
        await sleep(200);
        file = readdirSync(OUT).find((f) => /^umnozhayka-.*\.json$/.test(f));
      }
      check(file, 'файл не скачался');
      await page.tapText('Готово');
      const b = await newDevice(browser, url);
      await openParentOnFreshDevice(b);
      await b.send('Page.setInterceptFileChooserDialog', { enabled: true });
      const chooser = b.waitEvent('Page.fileChooserOpened');
      await b.tapText('Загрузить файл');
      const { backendNodeId } = await chooser;
      await b.send('DOM.setFileInputFiles', { files: [join(OUT, file)], backendNodeId });
      await confirmImport(b);
      check(canonical(await profilesJson(b)) === canonical(state.source), 'данные отличаются');
      await b.close();
      return file;
    });

    await step('Перенос через QR: коды с фото распознаются встроенным декодером без потерь', async () => {
      await page.tapText('Показать QR');
      await page.waitFor(`!!document.querySelector('.modal .qr-canvas')`);
      const total = await page.eval(`document.querySelectorAll('.modal .qr-parts li').length || 1`);
      await page.screenshot(join(OUT, '10-qr.png'));
      if (total > 1) await page.tapText('Листать сами').catch(() => page.tapText('Пауза'));
      for (let i = 0; i < total; i++) {
        const png = await page.eval(`document.querySelector('.modal .qr-canvas').toDataURL('image/png')`);
        const path = join(OUT, `qr-part-${String(i + 1).padStart(2, '0')}.png`);
        writeFileSync(path, Buffer.from(png.split(',')[1], 'base64'));
        qrFrames.push(path);
        if (total > 1) await page.tap('button[aria-label="Следующий код"]');
        await sleep(120);
      }
      await page.tapText('Готово');
      const b = await newDevice(browser, url);
      await openParentOnFreshDevice(b);
      await b.send('Page.setInterceptFileChooserDialog', { enabled: true });
      const chooser = b.waitEvent('Page.fileChooserOpened');
      await b.tapText('QR с фото');
      const { backendNodeId } = await chooser;
      await b.send('DOM.setFileInputFiles', { files: qrFrames, backendNodeId });
      await confirmImport(b);
      check(canonical(await profilesJson(b)) === canonical(state.source), 'данные отличаются');
      await b.close();
      return `${total} QR-кодов`;
    });

    await step('Вёрстка 320–1920 px без горизонтальной прокрутки', async () => {
      const screens = ['home', 'progress', 'parent'];
      const bad = [];
      for (const [w, hgt] of [[320, 640], [768, 1024], [1366, 768], [1920, 1080]]) {
        await page.viewport(w, hgt, w < 700);
        for (const s of screens) {
          if (s === 'parent') {
            await page.eval(`umnozhayka.go('parent', { unlocked: true })`);
          } else {
            await page.eval(`umnozhayka.go('${s}')`);
          }
          await sleep(350);
          const over = await page.eval(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
          if (over > 0) bad.push(`${s}@${w}: +${over}px`);
          await page.screenshot(join(OUT, `w${w}-${s}.png`));
        }
      }
      await page.viewport(390, 844, true);
      check(!bad.length, bad.join('; '));
      return 'проверено: главная, прогресс, родительский экран';
    });

    await step('Страница самопроверки: все автоматические проверки пройдены, в том числе без сети', async () => {
      const t = await browser.newPage({ width: 390, height: 844 });
      const result = async () => {
        await t.waitFor(`document.body.dataset.done === '1'`, 60000);
        const r = JSON.parse(await t.eval('JSON.stringify(window.selftest)'));
        const failed = r.items.filter((i) => i.status === 'fail').map((i) => `${i.title}: ${i.detail}`);
        check(!failed.length, failed.join('; '));
        return r;
      };
      await t.goto(`${url}selftest.html`);
      const online = await result();
      await t.screenshot(join(OUT, '16-selftest.png'), { full: true });
      await t.offline(true);
      await t.reload();
      await result();
      await t.offline(false);
      check(!t.errors.length, t.errors.join(' | '));
      await t.close();
      const warned = online.items.filter((i) => i.status === 'warn').map((i) => i.title);
      return `${online.total} проверок, с замечаниями — ${warned.length ? warned.join(', ') : 'нет'}`;
    });

    await step('Нет ошибок JavaScript и неудачных загрузок', async () => {
      check(!page.errors.length, page.errors.join(' | '));
      return `${requests.length} запросов к серверу за всю проверку`;
    });
  } finally {
    await browser.close().catch(() => {});
  }

  // QR с камеры: отдельный Chrome с «поддельной» камерой, которая показывает видео из QR-кадров.
  if (qrFrames.length && existsSync('/usr/bin/ffmpeg')) {
    await step('Перенос через QR с камеры второго устройства', async () => {
      const video = join(OUT, 'qr-camera.y4m');
      // Кадры по порядку: каждый QR «висит» на экране 0,7 с (как в проигрывателе), 15 кадров/с.
      const seqDir = join(OUT, 'camera-seq');
      mkdirSync(seqDir, { recursive: true });
      let n = 0;
      for (const f of qrFrames) {
        for (let r = 0; r < 10; r++) {
          execFileSync('cp', [f, join(seqDir, `s${String(n++).padStart(4, '0')}.png`)]);
        }
      }
      // Камера видит экран телефона: код меньше кадра, на сером фоне, повёрнут, размыт и с шумом.
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '15', '-i', join(seqDir, 's%04d.png'),
        '-vf', 'scale=520:520,pad=1280:720:380:100:color=0x8a8a8a,rotate=0.12:c=0x8a8a8a,boxblur=1:1,noise=alls=12:allf=t,format=yuv420p',
        video]);
      const cam = await launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`] });
      try {
        const b = await newDevice(cam, url);
        await openParentOnFreshDevice(b);
        await b.tapText('Сканировать QR');
        await b.waitFor(`!!document.querySelector('.scanner video')?.videoWidth`, 15000);
        await sleep(1500);
        await b.screenshot(join(OUT, '11-scanner.png'));
        await confirmImport(b);
        check(canonical(await profilesJson(b)) === canonical(state.source), 'данные отличаются');
      } finally {
        await cam.close().catch(() => {});
      }
      return `видео ${qrFrames.length} кадров, считано камерой`;
    });
  }

  server.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\nИтого: ${results.length - failed.length} из ${results.length} проверок пройдено. Скриншоты: ${OUT}`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
}).finally(() => setTimeout(() => process.exit(), 100));
