#!/usr/bin/env node
// Дымовая проверка в Firefox через WebDriver BiDi (встроен в Firefox, без geckodriver и npm):
// загрузка, первый профиль, начало диагностики, IndexedDB после перезагрузки, service worker,
// вёрстка на ширине 320 px, страница самопроверки. Запуск: node tools/firefox-smoke.mjs [папка-для-скриншотов]

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, sleep } from './cdp.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = process.argv[2] ?? join(tmpdir(), 'umnozhayka-firefox');
mkdirSync(OUT, { recursive: true });
const FIREFOX = process.env.FIREFOX || 'firefox';
const PORT = 9300 + Math.floor(Math.random() * 500);

const profile = mkdtempSync(join(tmpdir(), 'umn-ff-'));
// Service worker и localhost: разрешаем без HTTPS (как в обычном браузере для 127.0.0.1).
writeFileSync(join(profile, 'user.js'), [
  'user_pref("dom.serviceWorkers.enabled", true);',
  'user_pref("dom.serviceWorkers.testing.enabled", true);',
  'user_pref("browser.shell.checkDefaultBrowser", false);',
].join('\n'));
const proc = spawn(FIREFOX, ['--headless', '--no-remote', '--profile', profile, `--remote-debugging-port=${PORT}`, 'about:blank'], { stdio: 'ignore' });

let ws;
let id = 0;
const pending = new Map();
function send(method, params = {}) {
  const msgId = ++id;
  ws.send(JSON.stringify({ id: msgId, method, params }));
  return new Promise((resolve, reject) => pending.set(msgId, { resolve, reject, method }));
}

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      ws = new WebSocket(`ws://127.0.0.1:${PORT}/session`);
      await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = reject;
      });
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.id && pending.has(msg.id)) {
          const p = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.type === 'error') p.reject(new Error(`${p.method}: ${msg.error} ${msg.message}`));
          else p.resolve(msg.result);
        }
      };
      return;
    } catch {
      await sleep(250);
    }
  }
  throw new Error('Firefox не открыл порт отладки');
}

const results = [];
async function step(name, fn) {
  try {
    const note = await fn();
    results.push(true);
    console.log(`✓ ${name}${note ? ` — ${note}` : ''}`);
  } catch (err) {
    results.push(false);
    console.log(`✗ ${name}: ${err.message}`);
  }
}

async function main() {
  const { server, port } = await serve(ROOT);
  const url = `http://127.0.0.1:${port}/`;
  try {
    await connect();
    await send('session.new', { capabilities: {} });
    const { contexts } = await send('browsingContext.getTree', {});
    const context = contexts[0].context;
    const evaluate = async (expression) => {
      const r = await send('script.evaluate', { expression, target: { context }, awaitPromise: true, resultOwnership: 'none' });
      if (r.type !== 'success') throw new Error(r.exceptionDetails?.text ?? 'ошибка скрипта');
      return r.result?.value;
    };
    const waitFor = async (expression, timeout = 10000) => {
      const end = Date.now() + timeout;
      for (;;) {
        const v = await evaluate(`(() => { try { return Boolean(${expression}); } catch { return false; } })()`).catch(() => false);
        if (v) return;
        if (Date.now() > end) throw new Error(`не дождались: ${expression}`);
        await sleep(150);
      }
    };
    const shot = async (name) => {
      const { data } = await send('browsingContext.captureScreenshot', { context });
      writeFileSync(join(OUT, name), Buffer.from(data, 'base64'));
    };
    const navigate = (u) => send('browsingContext.navigate', { context, url: u, wait: 'complete' });
    await send('browsingContext.setViewport', { context, viewport: { width: 390, height: 844 } });

    await step('Firefox: приложение загружается, первый экран — новый ученик', async () => {
      await navigate(url);
      await waitFor(`globalThis.umnozhayka?.currentName === 'newProfile'`);
      await shot('ff-01-new-profile.png');
    });

    await step('Firefox: профиль создаётся, начинается диагностика, ввод с клавиатуры работает', async () => {
      await evaluate(`document.querySelector('#child-name').value = 'Петя'; [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Готово')).click(); true`);
      await waitFor(`umnozhayka.currentName === 'diagnostic'`);
      await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Начать')).click(); true`);
      await waitFor(`!!document.querySelector('.task .expr')`);
      for (let i = 0; i < 3; i++) {
        await waitFor(`!!document.querySelector('.task .expr') && !document.querySelector('.feedback')`);
        const expr = await evaluate(`document.querySelector('.task .expr').textContent`);
        const [, a, b] = /(\d+) × (\d+)/.exec(expr);
        const answer = String(Number(a) * Number(b));
        await evaluate(`for (const ch of ${JSON.stringify(answer)}) document.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); true`);
        await waitFor(`!!document.querySelector('.feedback--good')`);
      }
      await shot('ff-02-diagnostic.png');
      return 'три ответа приняты';
    });

    await step('Firefox: после перезагрузки диагностика продолжается с того же места (IndexedDB)', async () => {
      await evaluate(`umnozhayka.saveProfile().then(() => true)`);
      await navigate(url);
      await waitFor(`globalThis.umnozhayka?.currentName === 'diagnostic'`);
      const n = await evaluate(`umnozhayka.profiles[0].diagnosticDraft?.answers?.length ?? 0`);
      if (n < 3) throw new Error(`сохранено ответов: ${n}`);
      await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Продолжить')).click(); true`);
      await waitFor(`/из 20/.test(document.querySelector('h1').textContent)`);
      const title = await evaluate(`document.querySelector('h1').textContent`);
      if (!title.includes(`${n + 1} из 20`)) throw new Error(`заголовок: ${title}`);
      return `сохранено ответов: ${n}, продолжаем с ${n + 1}-го`;
    });

    await step('Firefox: service worker кэширует файлы', async () => {
      await waitFor(`navigator.serviceWorker && navigator.serviceWorker.controller !== undefined`);
      await evaluate(`navigator.serviceWorker.ready.then(() => true)`);
      await waitFor(`caches.keys().then((k) => k.some((x) => x.startsWith('umnozhayka-')))`, 15000).catch(() => {});
      const files = await evaluate(`caches.keys().then(async (k) => { const c = k.find((x) => x.startsWith('umnozhayka-')); return c ? (await (await caches.open(c)).keys()).length : 0; })`);
      if (!files) throw new Error('кэш пуст');
      return `в кэше ${files} файлов`;
    });

    await step('Firefox: ширина 320 px без горизонтальной прокрутки', async () => {
      await send('browsingContext.setViewport', { context, viewport: { width: 320, height: 640 } });
      await evaluate(`umnozhayka.go('home'); true`);
      await sleep(400);
      const over = await evaluate(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
      await shot('ff-03-w320.png');
      if (over > 0) throw new Error(`прокрутка +${over}px`);
    });

    await step('Firefox: страница самопроверки — автоматические проверки пройдены', async () => {
      await navigate(`${url}selftest.html`);
      await waitFor(`document.body.dataset.done === '1'`, 60000);
      const r = JSON.parse(await evaluate('JSON.stringify(window.selftest)'));
      await shot('ff-04-selftest.png');
      const failed = r.items.filter((i) => i.status === 'fail').map((i) => `${i.title}: ${i.detail}`);
      if (failed.length) throw new Error(failed.join('; '));
      return `${r.total} проверок, с замечаниями ${r.warned}`;
    });

    await send('session.end', {}).catch(() => {});
  } finally {
    server.close();
    proc.kill('SIGKILL');
    await sleep(300);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  const ok = results.filter(Boolean).length;
  console.log(`\nИтого: ${ok} из ${results.length}. Скриншоты: ${OUT}`);
  process.exitCode = ok === results.length ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  proc.kill('SIGKILL');
  process.exitCode = 1;
}).finally(() => setTimeout(() => process.exit(), 200));
