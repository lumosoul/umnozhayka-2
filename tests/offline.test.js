// Работа без интернета: service worker должен заранее кэшировать каждый файл приложения,
// а приложение — не обращаться к внешним адресам.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

function precacheList() {
  const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  const block = /const ASSETS = \[([\s\S]*?)\];/.exec(sw)[1];
  return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

test('service worker кэширует все файлы приложения', () => {
  const assets = new Set(precacheList());
  const appFiles = [
    'index.html',
    'selftest.html',
    'manifest.webmanifest',
    ...walk(join(ROOT, 'js')).map((p) => relative(ROOT, p)),
    ...walk(join(ROOT, 'css')).map((p) => relative(ROOT, p)),
    ...walk(join(ROOT, 'icons')).map((p) => relative(ROOT, p)),
  ].map((p) => `./${p.split('\\').join('/')}`);
  for (const f of appFiles) assert.ok(assets.has(f), `не кэшируется: ${f}`);
  for (const a of assets) {
    if (a === './') continue;
    assert.ok(existsSync(join(ROOT, a)), `в списке кэша, но файла нет: ${a}`);
  }
  assert.ok(assets.has('./'));
});

test('все модули импортируют только локальные файлы, внешних запросов нет', () => {
  const files = [...walk(join(ROOT, 'js')), join(ROOT, 'index.html'), join(ROOT, 'selftest.html'), join(ROOT, 'sw.js'), join(ROOT, 'css', 'styles.css')];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)) {
      assert.ok(m[1].startsWith('.'), `${relative(ROOT, f)}: нелокальный импорт ${m[1]}`);
    }
    assert.doesNotMatch(src, /https?:\/\/(?!www\.w3\.org)/, `${relative(ROOT, f)}: ссылка на внешний адрес`);
    assert.doesNotMatch(src, /\bfetch\(\s*['"`]http/, `${relative(ROOT, f)}: внешний fetch`);
  }
});

test('manifest: установка на главный экран с иконками 192 и 512 px', () => {
  const m = JSON.parse(readFileSync(join(ROOT, 'manifest.webmanifest'), 'utf8'));
  assert.equal(m.display, 'standalone');
  assert.equal(m.start_url, './');
  assert.equal(m.lang, 'ru');
  const sizes = m.icons.map((i) => i.sizes);
  assert.ok(sizes.includes('192x192') && sizes.includes('512x512'));
  for (const icon of m.icons) {
    const png = readFileSync(join(ROOT, icon.src));
    assert.equal(png.toString('ascii', 1, 4), 'PNG');
    const [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)];
    assert.equal(`${w}x${h}`, icon.sizes, icon.src);
  }
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'));
});
