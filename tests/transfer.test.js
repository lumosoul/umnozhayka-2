// Перенос прогресса: CRC-32, Base64, Base45, DEFLATE, упаковка, контейнер, файл, код и серия QR.

import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { crc32, crc32Hex } from '../js/transfer/crc32.js';
import { fromBase64, toBase64Url } from '../js/transfer/base64.js';
import { BASE45_ALPHABET, fromBase45, toBase45 } from '../js/transfer/base45.js';
import { deflateRaw, huffmanLengths, inflateRaw } from '../js/transfer/deflate.js';
import { pack, unpack } from '../js/transfer/pack.js';
import {
  FORMAT_VERSION, ImportError, QR_CHUNK_BYTES, QR_CHUNK_BYTES_LARGE, QrCollector, buildExport, decodeContainer,
  encodeContainer, exportCode, exportJson, exportQrChunks, importCode, importJson, parseQrChunk,
} from '../js/transfer/format.js';
import { encodeQR } from '../js/transfer/qr-encode.js';
import { applyImport, planImport } from '../js/core/merge.js';
import { createProfile, normalizeProfile } from '../js/core/profile.js';
import { LessonRunner, planLesson } from '../js/core/session.js';
import { recordSession } from '../js/core/progress.js';
import { DAY_MS } from '../js/core/dates.js';
import { createRng, shuffle } from '../js/core/rng.js';
import { SimLearner } from './helpers/learner.js';

const utf8 = (s) => new TextEncoder().encode(s);
const text = (b) => new TextDecoder().decode(b);

function randomBytes(n, rng) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = Math.floor(rng() * 256);
  return b;
}

/** Профиль после нескольких недель занятий — реалистичные данные для переноса. */
function practicedProfile(days = 21, seed = 77, name = 'Маша') {
  const rng = createRng(seed);
  const learner = new SimLearner(rng, { knownColumns: [1, 10] });
  const start = new Date(2026, 8, 1, 17).getTime();
  const p = createProfile({ name, avatar: 'cat', now: start });
  for (let day = 0; day < days; day++) {
    let now = start + day * DAY_MS;
    const plan = planLesson(p, { now, rng });
    const runner = new LessonRunner(p, plan, { rng, clock: () => now });
    while (!runner.finished) {
      const r = learner.respond(runner.current());
      runner.answer(r.value, r.ms);
      now += r.ms + 3000;
      runner.next();
    }
    recordSession(p, runner.summary(), { now });
    learner.forget(1);
  }
  return normalizeProfile(JSON.parse(JSON.stringify(p)));
}

test('CRC-32: эталонное значение', () => {
  assert.equal(crc32(utf8('123456789')), 0xCBF43926);
  assert.equal(crc32Hex(utf8('')), '00000000');
});

test('Base64: совпадает с эталоном, читает оба алфавита, пробелы и переносы строк', () => {
  const rng = createRng(1);
  for (let n = 0; n < 80; n++) {
    const b = randomBytes(n, rng);
    const enc = toBase64Url(b);
    assert.equal(enc, Buffer.from(b).toString('base64url'));
    assert.deepEqual(fromBase64(enc), b);
    const std = Buffer.from(b).toString('base64').replace(/(.{10})/g, '$1\n ');
    assert.deepEqual(fromBase64(std), b);
  }
  assert.throws(() => fromBase64('абв'));
});

test('Base45: векторы из RFC 9285', () => {
  assert.equal(toBase45(utf8('AB')), 'BB8');
  assert.equal(toBase45(utf8('Hello!!')), '%69 VD92EX0');
  assert.equal(toBase45(utf8('base-45')), 'UJCLQE7W581');
  assert.equal(text(fromBase45('QED8WEX0')), 'ietf!');
  assert.throws(() => fromBase45('GGW'));
  const rng = createRng(2);
  for (let n = 0; n < 60; n++) {
    const b = randomBytes(n, rng);
    const enc = toBase45(b);
    assert.ok([...enc].every((ch) => BASE45_ALPHABET.includes(ch)));
    assert.deepEqual(fromBase45(enc), b);
  }
});

test('DEFLATE: наши данные распаковывает zlib, а данные zlib — наш inflate', () => {
  const rng = createRng(3);
  const samples = [
    new Uint8Array(0),
    utf8('a'),
    utf8('абвгд '.repeat(500)),
    randomBytes(5000, rng),
    new Uint8Array(70000).fill(7),
    Uint8Array.from({ length: 256 }, (_, i) => i),
    utf8(JSON.stringify(practicedProfile(7))),
  ];
  const far = randomBytes(40000, rng);
  far.set(far.subarray(0, 300), 39000); // совпадение на расстоянии ~32 КБ
  samples.push(far);
  for (const s of samples) {
    const mine = deflateRaw(s);
    assert.deepEqual(new Uint8Array(zlib.inflateRawSync(mine)), s);
    for (const level of [1, 6, 9]) {
      assert.deepEqual(inflateRaw(new Uint8Array(zlib.deflateRawSync(s, { level }))), s);
    }
    assert.deepEqual(inflateRaw(mine), s);
  }
});

test('DEFLATE: сжатие сопоставимо с zlib, несжимаемые данные почти не растут', () => {
  const json = utf8(JSON.stringify(practicedProfile(14)));
  const mine = deflateRaw(json).length;
  const ref = zlib.deflateRawSync(json, { level: 9 }).length;
  assert.ok(mine < ref * 1.15, `наш: ${mine}, zlib: ${ref}`);
  const noise = randomBytes(3000, createRng(4));
  assert.ok(deflateRaw(noise).length <= noise.length + 10);
});

test('DEFLATE: повреждённые данные дают ошибку, а не мусор', () => {
  const packed = deflateRaw(utf8('проверка '.repeat(100)));
  assert.throws(() => inflateRaw(packed.subarray(0, packed.length - 3)));
  assert.throws(() => inflateRaw(Uint8Array.of(0xFF, 0xFF, 0xFF)));
});

test('Коды Хаффмана с ограничением длины остаются полными (неравенство Крафта)', () => {
  const freqs = Array.from({ length: 30 }, (_, i) => 2 ** Math.min(i, 25));
  const lens = huffmanLengths(freqs, 7);
  assert.ok(Math.max(...lens) <= 7);
  const kraft = [...lens].reduce((s, l) => s + (l ? 2 ** -l : 0), 0);
  assert.ok(Math.abs(kraft - 1) < 1e-12);
});

test('Упаковка без потерь: совпадает с JSON-круговоротом', () => {
  const values = [
    null, true, false, 0, 1, 63, 64, 127, 128, 300, 2 ** 31, 2 ** 53 - 1, -1, -64, -(2 ** 40), 3.25, -0.5, 1e-9,
    '', 'Маша', '🦉 совёнок', 'a'.repeat(1000),
    [], {}, [1, [2, [3, []]]], { a: 1, b: { c: [null, 'x'] }, 'ключ с пробелом': -7 },
    { skip: undefined, keep: 1, nan: NaN, inf: Infinity, arr: [undefined, 2] },
    practicedProfile(5),
  ];
  for (const v of values) {
    assert.deepEqual(unpack(pack(v)), JSON.parse(JSON.stringify(v)));
  }
  const p = practicedProfile(10);
  assert.ok(pack(p).length < utf8(JSON.stringify(p)).length / 2);
});

test('Упаковка отвергает подмену прототипа и мусор', () => {
  const evil = pack(JSON.parse('{"__proto__": {"polluted": true}}'));
  assert.throws(() => unpack(evil));
  assert.throws(() => unpack(Uint8Array.of(0, 0x99)));
  assert.throws(() => unpack(Uint8Array.of(0, 0x40, 0x40)));
});

test('Контейнер: версия формата и контрольная сумма', () => {
  const p = practicedProfile(7);
  const bytes = encodeContainer(buildExport([p]));
  assert.deepEqual(decodeContainer(bytes).profiles[0], p);

  const broken = bytes.slice();
  broken[Math.floor(broken.length / 2)] ^= 0x10;
  assert.throws(() => decodeContainer(broken), (e) => e instanceof ImportError && e.code === 'checksum');

  assert.throws(() => decodeContainer(bytes.subarray(0, bytes.length - 5)), ImportError);

  const newer = encodeContainer({ ...buildExport([p]), version: FORMAT_VERSION + 1 });
  assert.throws(() => decodeContainer(newer), (e) => e.code === 'newer');
});

test('JSON-файл: перенос без потерь, проверка формата и версии', () => {
  const profiles = [practicedProfile(10, 5, 'Аня'), practicedProfile(6, 6, 'Ваня')];
  const json = exportJson(profiles, { appVersion: '1.0.0' });
  const parsed = importJson(json);
  assert.deepEqual(parsed.profiles, profiles);
  assert.equal(parsed.version, FORMAT_VERSION);
  assert.throws(() => importJson('{"format":"other"}'), (e) => e.code === 'format');
  assert.throws(() => importJson('не json'), (e) => e.code === 'json');
  const newer = JSON.stringify({ ...JSON.parse(json), version: FORMAT_VERSION + 1 });
  assert.throws(() => importJson(newer), (e) => e.code === 'newer');
});

test('Код Base64: без потерь, с контрольной суммой, устойчив к переносам строк', () => {
  const profiles = [practicedProfile(12, 8)];
  const { code, checksum } = exportCode(profiles);
  assert.match(code, /^UM1\.[A-Za-z0-9_-]+$/);
  assert.match(checksum, /^[0-9A-F]{8}$/);
  assert.deepEqual(importCode(code).profiles, profiles);
  const wrapped = code.replace(/(.{40})/g, '$1\n');
  assert.deepEqual(importCode(`  ${wrapped}  `).profiles, profiles);
  assert.deepEqual(importCode(code.slice(4)).profiles, profiles, 'префикс необязателен');
  const tampered = code.slice(0, 30) + (code[30] === 'A' ? 'B' : 'A') + code.slice(31);
  assert.throws(() => importCode(tampered), (e) => e.code === 'checksum');
  assert.throws(() => importCode(code.slice(0, code.length - 10)), ImportError);
  assert.throws(() => importCode(''), (e) => e.code === 'empty-code');
});

test('Серия QR: части в любом порядке и с повторами собираются без потерь', () => {
  const profiles = [practicedProfile(14, 9), practicedProfile(5, 10, 'Петя')];
  const { chunks } = exportQrChunks(profiles);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.match(c, /^[0-9A-Z $%*+\-./:]+$/, 'только символы QR alphanumeric');
  const collector = new QrCollector();
  assert.equal(collector.add('https://example.com'), 'foreign');
  const stream = shuffle([...chunks, ...chunks.slice(0, 3)], createRng(11));
  for (const c of stream) collector.add(c);
  assert.equal(collector.complete, true);
  assert.deepEqual(collector.result().profiles, profiles);
});

test('Серия QR: новая передача сбрасывает старую, неполная серия не импортируется', () => {
  const a = exportQrChunks([practicedProfile(8, 12)]).chunks;
  const b = exportQrChunks([practicedProfile(8, 13, 'Оля')]).chunks;
  const c = new QrCollector();
  c.add(a[0]);
  assert.equal(c.add(b[0]), 'restarted');
  assert.equal(c.received, 1);
  assert.throws(() => c.result(), (e) => e.code === 'incomplete');
  assert.deepEqual(c.missing().length, b.length - 1);
  assert.equal(parseQrChunk('UM1:ABCD:3:2:00'), null);
});

test('Сквозной перенос на чистое устройство всеми тремя способами — без потерь', () => {
  const source = [practicedProfile(30, 14, 'Маша'), practicedProfile(20, 15, 'Петя')];
  const viaFile = importJson(exportJson(source)).profiles;
  const viaCode = importCode(exportCode(source).code).profiles;
  const collector = new QrCollector();
  for (const c of exportQrChunks(source).chunks) collector.add(c);
  const viaQr = collector.result().profiles;
  for (const incoming of [viaFile, viaCode, viaQr]) {
    const saved = applyImport(planImport([], incoming));
    assert.deepEqual(saved, source);
  }
});

test('Размер: месяц занятий — компактно, а каждый QR-код остаётся легко читаемым', () => {
  const p = practicedProfile(30, 16);
  const json = utf8(JSON.stringify(p)).length;
  const phone = exportQrChunks([p]);
  assert.ok(phone.bytes < json / 6, `контейнер ${phone.bytes} Б при JSON ${json} Б`);
  // Телефон: код не больше версии 16 (81 модуль) с коррекцией M.
  for (const c of phone.chunks) assert.ok(encodeQR(c, { ecl: 'M' }).version <= 16);
  const large = exportQrChunks([p], { chunkBytes: QR_CHUNK_BYTES_LARGE });
  for (const c of large.chunks) assert.ok(encodeQR(c, { ecl: 'M' }).version <= 20);
  assert.equal(phone.chunks.length, Math.ceil(phone.bytes / QR_CHUNK_BYTES));
  assert.ok(large.chunks.length <= 12, `QR-кодов на большом экране: ${large.chunks.length}`);
  assert.ok(phone.chunks.length <= 18, `QR-кодов на телефоне: ${phone.chunks.length}`);
});
