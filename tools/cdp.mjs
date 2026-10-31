// Минимальный клиент Chrome DevTools Protocol для сквозных проверок (без puppeteer и npm).
// Нужен Node 22+ (встроенный WebSocket) и Google Chrome/Chromium.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';

const CHROME = process.env.CHROME || '/usr/bin/google-chrome';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/** Статический сервер (как GitHub Pages): отдаёт файлы проекта, считает запросы. */
export function serve(root, port = 0) {
  const log = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(root, path));
    log.push(path);
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    try {
      if (!statSync(file).isFile()) throw new Error('dir');
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(readFileSync(file));
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, log }));
  });
}

export async function launch({ args = [] } = {}) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'umn-chrome-'));
  const proc = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--mute-audio',
    ...args, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('Chrome не запустился')), 20000);
    proc.stderr.on('data', (d) => {
      buf += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
  });
  const browser = new Browser(wsUrl, proc, userDataDir);
  await browser.ready;
  return browser;
}

class Browser {
  constructor(wsUrl, proc, dir) {
    this.proc = proc;
    this.dir = dir;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Set();
    this.ws = new WebSocket(wsUrl);
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    this.ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, method } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const l of this.listeners) l(msg);
      }
    };
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Новая вкладка; context — отдельный профиль браузера («второе устройство»). */
  async newPage({ context = false, width = 390, height = 844, mobile = true } = {}) {
    let browserContextId;
    if (context) ({ browserContextId } = await this.send('Target.createBrowserContext'));
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this, sessionId, targetId, browserContextId);
    await page.init({ width, height, mobile });
    return page;
  }

  async close() {
    const exited = new Promise((resolve) => {
      if (this.proc.exitCode !== null) resolve();
      else this.proc.once('exit', resolve);
    });
    try {
      await Promise.race([this.send('Browser.close'), sleep(3000)]);
    } catch {
      // уже закрыт
    }
    await Promise.race([exited, sleep(3000)]);
    this.proc.kill('SIGKILL');
    try {
      this.ws.close();
    } catch {
      // соединения уже нет
    }
    rmSync(this.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

class Page {
  constructor(browser, sessionId, targetId, contextId) {
    this.b = browser;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.contextId = contextId;
    this.console = [];
    this.errors = [];
    this.failed = [];
    browser.on((msg) => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === 'Runtime.consoleAPICalled') {
        this.console.push(`${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        this.errors.push(d.exception?.description ?? d.text);
      } else if (msg.method === 'Network.loadingFailed' && !msg.params.canceled) {
        this.failed.push(msg.params.errorText);
      } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        this.errors.push(`${msg.params.entry.source}: ${msg.params.entry.text} ${msg.params.entry.url ?? ''}`);
      }
    });
  }

  send(method, params) {
    return this.b.send(method, params, this.sessionId);
  }

  async init({ width, height, mobile }) {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Network.enable');
    await this.send('Log.enable');
    // Без анимаций: скриншоты не попадают на середину появления экрана (и проверяется этот режим).
    await this.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await this.viewport(width, height, mobile);
  }

  async viewport(width, height, mobile = width < 700) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
    await this.send('Emulation.setTouchEmulationEnabled', mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
  }

  async goto(url) {
    const loaded = this.waitEvent('Page.loadEventFired', 20000);
    await this.send('Page.navigate', { url });
    await loaded;
  }

  async reload() {
    const loaded = this.waitEvent('Page.loadEventFired', 20000);
    await this.send('Page.reload', { ignoreCache: false });
    await loaded;
  }

  waitEvent(method, timeout = 10000, predicate = () => true) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`нет события ${method}`));
      }, timeout);
      const off = this.b.on((msg) => {
        if (msg.sessionId === this.sessionId && msg.method === method && predicate(msg.params)) {
          clearTimeout(timer);
          off();
          resolve(msg.params);
        }
      });
    });
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (res.exceptionDetails) throw new Error(`${expression.slice(0, 80)}… → ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
    return res.result.value;
  }

  async waitFor(expression, timeout = 10000, every = 100) {
    const end = Date.now() + timeout;
    for (;;) {
      let v;
      try {
        v = await this.eval(expression);
      } catch {
        v = null;
      }
      if (v) return v;
      if (Date.now() > end) throw new Error(`не дождались: ${expression}`);
      await sleep(every);
    }
  }

  /** Касание/клик в центр элемента (настоящие события указателя). */
  async tap(selector, { index = 0, touch = true } = {}) {
    const box = await this.eval(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((x) => x.offsetParent !== null)[${index}];
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    })()`);
    if (!box) throw new Error(`нет элемента ${selector}[${index}]`);
    if (touch) {
      const tp = [{ x: box.x, y: box.y }];
      await this.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp });
      await this.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await this.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
      }
    }
    return box;
  }

  /** Клик по кнопке с текстом. */
  async tapText(text, opts) {
    const idx = await this.eval(`(() => {
      const els = [...document.querySelectorAll('button')].filter((x) => x.offsetParent !== null);
      const i = els.findIndex((b) => b.textContent.includes(${JSON.stringify(text)}) && !b.disabled);
      if (i < 0) return -1;
      els.forEach((b, k) => b.toggleAttribute('data-e2e', k === i));
      return i;
    })()`);
    if (idx < 0) throw new Error(`нет кнопки «${text}»`);
    return this.tap('button[data-e2e]', opts);
  }

  async key(key) {
    const named = {
      Enter: { code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
      Backspace: { code: 'Backspace', windowsVirtualKeyCode: 8 },
      Escape: { code: 'Escape', windowsVirtualKeyCode: 27 },
      Tab: { code: 'Tab', windowsVirtualKeyCode: 9 },
      ArrowRight: { code: 'ArrowRight', windowsVirtualKeyCode: 39 },
      ArrowLeft: { code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
      ArrowDown: { code: 'ArrowDown', windowsVirtualKeyCode: 40 },
      ' ': { code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
    }[key];
    const desc = named ?? (/^\d$/.test(key)
      ? { code: `Digit${key}`, windowsVirtualKeyCode: 48 + Number(key), text: key }
      : { code: `Key${key.toUpperCase()}`, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0), text: key });
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, ...desc });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: desc.code, windowsVirtualKeyCode: desc.windowsVirtualKeyCode });
  }

  async type(text) {
    for (const ch of String(text)) await this.key(ch);
  }

  async screenshot(path, { full = false } = {}) {
    let clip;
    if (full) {
      const { contentSize } = await this.send('Page.getLayoutMetrics');
      clip = { x: 0, y: 0, width: contentSize.width, height: contentSize.height, scale: 1 };
    }
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full, clip });
    writeFileSync(path, Buffer.from(data, 'base64'));
  }

  async offline(on) {
    await this.send('Network.emulateNetworkConditions', { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  }

  async close() {
    await this.b.send('Target.closeTarget', { targetId: this.targetId });
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
