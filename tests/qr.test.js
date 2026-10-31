// Тесты модуля QR: таблицы и Рида–Соломона, побитовое совпадение кодера с segno,
// круговой тест через decodeMatrix, декодер на изображениях segno/OpenCV и на
// синтетических кадрах камеры 1280×720 с искажениями.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { encodeQR, qrCapacity } from '../js/transfer/qr-encode.js';
import { decodeMatrix, decodeQR } from '../js/transfer/qr-decode.js';
import {
  alignmentPositions,
  blockInfo,
  dataModuleOrder,
  formatBits,
  functionModuleMap,
  gfDiv,
  gfInv,
  gfMul,
  rsDecode,
  rsEncode,
  versionBits,
} from '../js/transfer/qr-common.js';
import { decodeGrayPng, grayToRgba, makeRng, makeTransferText, renderQR } from './helpers/qr-raster.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const tables = fixture('qr-segno-tables.json');
const matrices = fixture('qr-segno-matrices.json').cases;
const images = fixture('qr-segno-images.json').images;

const ECLS = ['L', 'M', 'Q', 'H'];

function unpackBits(b64, size) {
  const bytes = Buffer.from(b64, 'base64');
  const out = new Uint8Array(size * size);
  for (let i = 0; i < out.length; i++) out[i] = (bytes[i >> 3] >> (7 - (i & 7))) & 1;
  return out;
}

function transpose(m, size) {
  const t = new Uint8Array(size * size);
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) t[c * size + r] = m[r * size + c];
  return t;
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}

// ---------------------------------------------------------------------------

describe('qr-common: таблицы против segno', () => {
  it('блоки Рида–Соломона для версий 1–40 × L/M/Q/H', () => {
    for (let v = 1; v <= 40; v++) {
      for (const ecl of ECLS) {
        const expected = tables.ecc[v][ecl].flatMap(([n, total, data]) => Array(n).fill([total, data]));
        const info = blockInfo(v, ecl);
        const actual = info.dataLengths.map((d) => [d + info.eccPerBlock, d]);
        assert.deepEqual(actual, expected, `версия ${v}, уровень ${ecl}`);
        assert.equal(info.dataCodewords * 8, tables.capacityBits[v][ecl], `ёмкость ${v}-${ecl}`);
      }
    }
  });

  it('позиции выравнивающих узоров', () => {
    for (let v = 1; v <= 40; v++) assert.deepEqual(alignmentPositions(v), tables.alignment[v], `версия ${v}`);
  });

  it('карта служебных модулей оставляет ровно нужное число модулей данных', () => {
    for (let v = 1; v <= 40; v++) {
      const order = dataModuleOrder(v, functionModuleMap(v));
      assert.equal(order.length, new Set(order).size, `версия ${v}: модули не повторяются`);
      assert.equal(Math.floor(order.length / 8), blockInfo(v, 'L').totalCodewords, `версия ${v}`);
    }
  });

  it('форматная и версионная информация (БЧХ) совпадает с таблицами стандарта', () => {
    const order = ['M', 'L', 'H', 'Q']; // порядок в таблице C.1 по двум битам уровня
    for (let i = 0; i < 32; i++) assert.equal(formatBits(order[i >> 3], i & 7), tables.formatInfo[i]);
    for (let v = 7; v <= 40; v++) assert.equal(versionBits(v), tables.versionInfo[v - 7]);
  });

  it('qrCapacity совпадает с segno и с опорными значениями ISO/IEC 18004', () => {
    for (let v = 1; v <= 40; v++) {
      for (const ecl of ECLS) {
        for (const mode of ['numeric', 'alphanumeric', 'byte']) {
          assert.equal(qrCapacity(v, ecl, mode), tables.charCapacity[v][ecl][mode], `${v}-${ecl} ${mode}`);
        }
      }
    }
    assert.equal(qrCapacity(1, 'L', 'numeric'), 41);
    assert.equal(qrCapacity(1, 'M', 'alphanumeric'), 20);
    assert.equal(qrCapacity(1, 'H', 'byte'), 7);
    assert.equal(qrCapacity(10, 'M', 'alphanumeric'), 311);
    assert.equal(qrCapacity(16, 'M', 'alphanumeric'), 656);
    assert.equal(qrCapacity(40, 'L', 'numeric'), 7089);
    assert.equal(qrCapacity(40, 'L', 'alphanumeric'), 4296);
    assert.equal(qrCapacity(40, 'L', 'byte'), 2953);
    assert.equal(qrCapacity(40, 'H', 'byte'), 1273);
    assert.throws(() => qrCapacity(41, 'M', 'byte'));
    assert.throws(() => qrCapacity(1, 'X', 'byte'));
    assert.throws(() => qrCapacity(1, 'M', 'kanji'));
  });
});

describe('GF(256) и код Рида–Соломона', () => {
  it('арифметика поля: обратные, деление, ассоциативность', () => {
    for (let a = 1; a < 256; a++) {
      assert.equal(gfMul(a, gfInv(a)), 1);
      assert.equal(gfDiv(gfMul(a, 7), 7), a);
    }
    assert.equal(gfMul(0, 5), 0);
    assert.equal(gfMul(2, 0x80), 0x1d); // α^8 = x^4 + x^3 + x^2 + 1 по модулю 0x11D
  });

  it('пример «HELLO WORLD» 1-M из стандарта', () => {
    const data = Uint8Array.from([32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17]);
    assert.deepEqual([...rsEncode(data, 10)], [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });

  // Блоки реальных размеров: (всего, коды коррекции).
  const shapes = [[26, 7], [26, 10], [26, 17], [44, 16], [70, 26], [35, 18], [100, 20], [134, 26], [67, 24],
    [146, 28], [151, 30], [54, 30]];

  it('исправляет любые ошибки числом до ⌊ecc/2⌋', () => {
    const rng = makeRng(42);
    for (const [n, ecc] of shapes) {
      for (let trial = 0; trial < 25; trial++) {
        const data = Uint8Array.from({ length: n - ecc }, () => Math.floor(rng() * 256));
        const word = new Uint8Array(n);
        word.set(data);
        word.set(rsEncode(data, ecc), n - ecc);
        const errors = trial === 0 ? Math.floor(ecc / 2) : Math.floor(rng() * (Math.floor(ecc / 2) + 1));
        const damaged = word.slice();
        const positions = new Set();
        while (positions.size < errors) positions.add(Math.floor(rng() * n));
        for (const p of positions) damaged[p] ^= 1 + Math.floor(rng() * 255);
        assert.equal(rsDecode(damaged, ecc), errors, `n=${n} ecc=${ecc} ошибок ${errors}`);
        assert.deepEqual(damaged, word);
      }
    }
  });

  it('при ошибках сверх возможностей кода — отказ, слово не меняется', () => {
    const rng = makeRng(7);
    let checked = 0;
    for (const [n, ecc] of shapes) {
      for (let trial = 0; trial < 40; trial++) {
        const data = Uint8Array.from({ length: n - ecc }, () => Math.floor(rng() * 256));
        const word = new Uint8Array(n);
        word.set(data);
        word.set(rsEncode(data, ecc), n - ecc);
        const errors = Math.floor(ecc / 2) + 1 + Math.floor(rng() * ecc);
        const damaged = word.slice();
        const positions = new Set();
        while (positions.size < Math.min(errors, n)) positions.add(Math.floor(rng() * n));
        for (const p of positions) damaged[p] ^= 1 + Math.floor(rng() * 255);
        const before = damaged.slice();
        assert.equal(rsDecode(damaged, ecc), -1, `n=${n} ecc=${ecc} ошибок ${errors}`);
        assert.deepEqual(damaged, before);
        checked++;
      }
    }
    assert.equal(checked, shapes.length * 40);
  });
});

describe('encodeQR', () => {
  it('побитово совпадает с segno (версии 1–40, все уровни, маски и режимы)', () => {
    let compared = 0;
    for (const c of matrices) {
      if (c.mode === 'kanji') continue;
      const q = encodeQR(c.text, { ecl: c.ecl, minVersion: c.version, maxVersion: c.version, mask: c.autoMask ? -1 : c.mask });
      const label = `${c.version}-${c.ecl} ${c.mode} маска ${c.mask}${c.autoMask ? ' (авто)' : ''}`;
      assert.equal(q.version, c.version, label);
      assert.equal(q.size, c.size, label);
      assert.equal(q.mask, c.mask, `${label}: выбор маски`);
      assert.ok(Buffer.from(q.modules).equals(Buffer.from(unpackBits(c.bits, c.size))), `${label}: модули`);
      compared++;
    }
    assert.ok(compared >= 150);
    const masks = new Set(matrices.filter((c) => !c.autoMask).map((c) => `${c.ecl}${c.mask}`));
    assert.equal(masks.size, 32, 'покрыты все 8 масок на всех 4 уровнях');
  });

  it('выбирает самый компактный режим и наименьшую версию', () => {
    assert.equal(encodeQR('HELLO WORLD').version, 1);
    // 1-M: 34 цифры, 20 знаков alphanumeric, 14 байт.
    assert.equal(encodeQR('1'.repeat(34)).version, 1);
    assert.equal(encodeQR('1'.repeat(35)).version, 2);
    assert.equal(encodeQR('A'.repeat(20)).version, 1);
    assert.equal(encodeQR('A'.repeat(21)).version, 2);
    assert.equal(encodeQR('a'.repeat(14)).version, 1);
    assert.equal(encodeQR('a'.repeat(15)).version, 2);
    assert.equal(encodeQR('Ж'.repeat(7)).version, 1); // 14 байт UTF-8
    assert.equal(encodeQR('Ж'.repeat(8)).version, 2);
    assert.equal(encodeQR('A'.repeat(20), { minVersion: 5 }).version, 5);
    const rng = makeRng(3);
    for (const len of [300, 450, 620]) {
      const q = encodeQR(makeTransferText(rng, len), { ecl: 'M' });
      assert.ok(q.version >= 10 && q.version <= 16, `длина ${len} → версия ${q.version}`);
    }
  });

  it('отвергает слишком длинные данные и неверные параметры', () => {
    assert.throws(() => encodeQR('1'.repeat(7090), { ecl: 'L' }), /не помещаются/);
    assert.throws(() => encodeQR('A'.repeat(21), { maxVersion: 1 }), /не помещаются/);
    assert.throws(() => encodeQR('x'.repeat(2954), { ecl: 'L' }), /не помещаются/);
    assert.doesNotThrow(() => encodeQR('x'.repeat(2953), { ecl: 'L' }));
    assert.throws(() => encodeQR('A', { ecl: 'X' }));
    assert.throws(() => encodeQR('A', { mask: 8 }));
    assert.throws(() => encodeQR('A', { minVersion: 0 }));
    assert.throws(() => encodeQR('A', { minVersion: 5, maxVersion: 4 }));
    assert.throws(() => encodeQR(42));
  });
});

describe('decodeMatrix', () => {
  it('читает все матрицы segno, включая кандзи', () => {
    for (const c of matrices) {
      const res = decodeMatrix(unpackBits(c.bits, c.size), c.size);
      assert.ok(res, `${c.version}-${c.ecl} ${c.mode}`);
      assert.equal(res.text, c.text);
      assert.equal(res.version, c.version);
      assert.equal(res.ecl, c.ecl);
      assert.equal(res.mask, c.mask);
    }
  });

  it('decodeMatrix(encodeQR(x)) === x для случайных строк всех режимов, версий 1–40 и уровней', () => {
    const rng = makeRng(2024);
    const alnum = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
    const pool = 'abcxyzАБВжэюё0123 ,.!?€😀';
    const make = (mode, n) => {
      if (mode === 'numeric') return Array.from({ length: n }, () => Math.floor(rng() * 10)).join('');
      if (mode === 'alphanumeric') return Array.from({ length: n }, () => alnum[Math.floor(rng() * 45)]).join('');
      let s = 'ы';
      while (new TextEncoder().encode(s).length < n) s += [...pool][Math.floor(rng() * [...pool].length)];
      while (new TextEncoder().encode(s).length > n) s = [...s].slice(0, -1).join('');
      return s;
    };
    for (let v = 1; v <= 40; v++) {
      for (const ecl of ECLS) {
        const mode = ['numeric', 'alphanumeric', 'byte'][(v + ECLS.indexOf(ecl)) % 3];
        const cap = qrCapacity(v, ecl, mode);
        const n = v % 5 === 0 ? cap : Math.max(1, Math.floor(cap * (0.5 + rng() * 0.5)));
        const text = make(mode, n);
        const q = encodeQR(text, { ecl, minVersion: v, maxVersion: v });
        const res = decodeMatrix(q.modules, q.size);
        assert.ok(res, `${v}-${ecl} ${mode}`);
        assert.equal(res.text, text, `${v}-${ecl} ${mode}`);
        assert.equal(res.version, v);
        assert.equal(res.ecl, ecl);
        assert.equal(res.mask, q.mask);
        assert.deepEqual([...res.bytes], [...new TextEncoder().encode(text)]);
      }
    }
  });

  it('читает отражённую (транспонированную) матрицу', () => {
    const q = encodeQR('UM1:ABCD:3:12:ZERKALO', { ecl: 'M' });
    assert.equal(decodeMatrix(transpose(q.modules, q.size), q.size).text, 'UM1:ABCD:3:12:ZERKALO');
  });

  it('исправляет повреждённые модули в пределах кода коррекции', () => {
    const rng = makeRng(99);
    const text = makeTransferText(rng, 500);
    const q = encodeQR(text, { ecl: 'M' });
    const order = dataModuleOrder(q.version, functionModuleMap(q.version));
    for (let trial = 0; trial < 10; trial++) {
      const m = q.modules.slice();
      for (let k = 0; k < 40; k++) m[order[Math.floor(rng() * order.length)]] ^= 1;
      // Повреждаем и одну копию форматной информации.
      m[8 * q.size + 2] ^= 1;
      m[8 * q.size + 4] ^= 1;
      assert.equal(decodeMatrix(m, q.size)?.text, text);
    }
    const ruined = q.modules.slice();
    for (let k = 0; k < order.length; k += 3) ruined[order[k]] ^= 1;
    assert.equal(decodeMatrix(ruined, q.size), null);
  });

  it('на мусоре возвращает null и не бросает исключений', () => {
    const rng = makeRng(5);
    for (const size of [21, 25, 57, 177]) {
      const m = Uint8Array.from({ length: size * size }, () => (rng() < 0.5 ? 1 : 0));
      assert.equal(decodeMatrix(m, size), null);
    }
    assert.equal(decodeMatrix(new Uint8Array(400), 20), null);
    assert.equal(decodeMatrix(new Uint8Array(10), 21), null);
    assert.equal(decodeMatrix(null, 21), null);
    assert.equal(decodeMatrix(undefined, undefined), null);
  });
});

// ---------------------------------------------------------------------------

describe('decodeQR: изображения segno, растеризованные OpenCV', () => {
  it('читает все фикстуры (RGBA и серый вход)', () => {
    assert.ok(images.length >= 10);
    // Генератор фикстур проверил каждое изображение независимым декодером OpenCV.
    assert.ok(images.every((im) => im.opencv), 'все фикстуры читаются OpenCV');
    for (const im of images) {
      const png = decodeGrayPng(Buffer.from(im.png, 'base64'));
      const label = `v${im.version}-${im.ecl} ${png.width}×${png.height}, ${im.moduleSize} px/модуль, ` +
        `поворот ${im.angle}°${im.mirror ? ', зеркально' : ''}`;
      const rgba = decodeQR({ data: grayToRgba(png.gray), width: png.width, height: png.height });
      assert.equal(rgba?.text, im.text, label);
      assert.equal(rgba.version, im.version, label);
      const gray = decodeQR({ data: png.gray, width: png.width, height: png.height });
      assert.equal(gray?.text, im.text, `${label} (серый)`);
    }
  });
});

// Серии синтетических кадров 1280×720 с текстом протокола переноса (уровень M, 300–620
// знаков, версии 10–16). gen(rng, i) задаёт искажения; min — требуемая доля успеха.
const W = 1280;
const H = 720;
const turn = (r) => r() * 2 * Math.PI;
const SERIES = [
  {
    name: 'чистый, поворот, 2.5–8 px',
    min: 1,
    gen: (r) => ({ moduleSize: 2.5 + r() * 5.5, angle: turn(r), blur: 0.5, noise: 2 }),
  },
  {
    name: 'мелкие модули 2.5–3.2 px + размытие',
    min: 0.9,
    gen: (r) => ({ moduleSize: 2.5 + r() * 0.7, angle: turn(r), blur: 0.8, noise: 3 }),
  },
  {
    name: 'перспектива 6–20%',
    min: 0.9,
    gen: (r) => ({ moduleSize: 3 + r() * 4, angle: turn(r), perspective: 0.06 + r() * 0.14, blur: 0.7, noise: 3 }),
  },
  {
    name: 'размытие σ 0.2–0.4 модуля (0.8–3.2 px)',
    min: 0.9,
    gen: (r) => {
      const m = 4 + r() * 4;
      return { moduleSize: m, angle: turn(r), blur: m * (0.2 + r() * 0.2), noise: 3 };
    },
  },
  {
    name: 'шум σ 10–20 при контрасте 100',
    min: 0.9,
    gen: (r) => ({ moduleSize: 3.5 + r() * 3.5, angle: turn(r), blur: 0.7, noise: 10 + r() * 10, dark: 70, light: 170 }),
  },
  {
    name: 'низкий контраст 105/160',
    min: 0.9,
    gen: (r) => ({ moduleSize: 3 + r() * 4, angle: turn(r), blur: 0.8, noise: 4, dark: 105, light: 160 }),
  },
  {
    name: 'градиент освещённости и блик',
    min: 0.9,
    gen: (r) => ({ moduleSize: 3 + r() * 4, angle: turn(r), blur: 0.7, noise: 4, gradient: 0.5 + r() * 0.35 }),
  },
  {
    name: 'муар экрана',
    min: 0.9,
    gen: (r) => ({ moduleSize: 3 + r() * 4, angle: turn(r), blur: 0.8, noise: 4, moire: 0.4 + r() * 0.5 }),
  },
  {
    name: 'фон с текстом и ложными искателями, код у края',
    min: 0.9,
    gen: (r) => ({ moduleSize: 3 + r() * 3, angle: turn(r), blur: 0.7, noise: 4, clutter: 60, nearEdge: true }),
  },
  {
    name: 'зеркально и негатив',
    min: 0.9,
    gen: (r, i) => ({
      moduleSize: 3 + r() * 4, angle: turn(r), perspective: 0.05, blur: 0.7, noise: 3,
      mirror: i % 2 === 0, invert: i % 2 === 1, background: i % 2 ? 40 : 120,
    }),
  },
  {
    name: 'всё сразу (умеренно)',
    min: 0.85,
    gen: (r) => ({
      moduleSize: 3.5 + r() * 3, angle: turn(r), perspective: 0.05 + r() * 0.06, blur: 0.9 + r() * 0.4,
      noise: 6, gradient: 0.4, moire: 0.3, clutter: 30,
    }),
  },
  {
    name: 'дисторсия объектива 2–8% и смаз 1.5–4 px',
    min: 0.9,
    gen: (r) => ({ moduleSize: 4 + r() * 3.5, angle: turn(r), blur: 0.6, noise: 3, barrel: -0.02 - r() * 0.06, motion: 1.5 + r() * 2.5 }),
  },
  {
    name: 'крупные модули 12–24 px (короткая строка)',
    min: 1,
    gen: (r) => ({ moduleSize: 12 + r() * 12, angle: turn(r), blur: 1.2, noise: 3, length: 20 + Math.floor(r() * 40) }),
  },
];
const PER_SERIES = 12;

function makeFrame(series, i) {
  const rng = makeRng(1009 * (SERIES.indexOf(series) + 1) + 7919 * i);
  let text = makeTransferText(rng, 300 + Math.floor(rng() * 321));
  const o = series.gen(rng, i);
  if (o.length) text = text.slice(0, o.length);
  const q = encodeQR(text, { ecl: 'M' });
  // Масштаб ограничен так, чтобы повёрнутый код с тихой зоной целиком помещался в кадр.
  const spread = (Math.abs(Math.cos(o.angle)) + Math.abs(Math.sin(o.angle))) * (1 + 2 * (o.perspective || 0));
  const moduleSize = Math.min(o.moduleSize, (H - 10) / ((q.size + 8) * spread));
  const half = ((q.size + 8) * moduleSize * spread) / 2;
  let center = [W / 2 + (rng() - 0.5) * 120, H / 2 + (rng() - 0.5) * 60];
  if (o.nearEdge) {
    const x = half + 2 + rng() * 30;
    const y = half + 2 + rng() * Math.max(0, H / 2 - half - 2);
    center = [rng() < 0.5 ? x : W - x, rng() < 0.5 ? Math.min(y, H / 2) : Math.max(H - y, H / 2)];
  }
  const img = renderQR(q.modules, q.size, { ...o, moduleSize, center, width: W, height: H, seed: i + 1 });
  return { img, text, version: q.version, moduleSize };
}

describe('decodeQR: синтетические кадры камеры 1280×720', () => {
  const timings = [];

  for (const series of SERIES) {
    it(`серия «${series.name}»: не менее ${Math.round(series.min * 100)}% успеха`, (t) => {
      let ok = 0;
      const failed = [];
      for (let i = 0; i < PER_SERIES; i++) {
        const { img, text, version, moduleSize } = makeFrame(series, i);
        const t0 = performance.now();
        const res = decodeQR(img);
        timings.push(performance.now() - t0);
        if (res && res.text === text) ok++;
        else {
          assert.equal(res, null, 'вместо неверного текста декодер обязан вернуть null');
          failed.push(`#${i} v${version} ${moduleSize.toFixed(2)} px`);
        }
      }
      t.diagnostic(`${ok}/${PER_SERIES} = ${Math.round((ok / PER_SERIES) * 100)}%` +
        (failed.length ? `; не прочитаны: ${failed.join(', ')}` : ''));
      assert.ok(ok / PER_SERIES >= series.min, `успех ${ok}/${PER_SERIES}`);
    });
  }

  it('время обработки кадра 1280×720 укладывается в бюджет (медиана ≤ 60 мс)', (t) => {
    const m = median(timings.slice(1)); // первый кадр включает прогрев JIT
    t.diagnostic(`кадров ${timings.length}: медиана ${m.toFixed(1)} мс, 90% ≤ ` +
      `${[...timings].sort((a, b) => a - b)[Math.floor(timings.length * 0.9)].toFixed(1)} мс, ` +
      `максимум ${Math.max(...timings).toFixed(1)} мс`);
    assert.ok(m <= 60, `медиана ${m.toFixed(1)} мс`);
  });

  it('кадры без кода: null, без ложных срабатываний, быстро', (t) => {
    const times = [];
    for (let i = 0; i < 6; i++) {
      const img = renderQR(new Uint8Array(21 * 21), 21, {
        width: W, height: H, moduleSize: 1e-4, quiet: 0, margin: 0, bezel: 0, clutter: i * 25, noise: 2 + i, seed: 500 + i,
      });
      const t0 = performance.now();
      assert.equal(decodeQR(img), null);
      times.push(performance.now() - t0);
    }
    t.diagnostic(`медиана ${median(times).toFixed(1)} мс, максимум ${Math.max(...times).toFixed(1)} мс`);
    assert.ok(median(times) <= 60);
  });

  it('tryHarder: false читает чистый кадр', () => {
    const { img, text } = makeFrame(SERIES[0], 3);
    assert.equal(decodeQR(img, { tryHarder: false })?.text, text);
  });
});

describe('decodeQR: некорректный вход', () => {
  it('возвращает null и не бросает исключений', () => {
    const rng = makeRng(11);
    const noise = Uint8ClampedArray.from({ length: 64 * 48 * 4 }, () => Math.floor(rng() * 256));
    const cases = [
      undefined, null, {}, { data: null, width: 10, height: 10 }, { data: new Uint8Array(0), width: 0, height: 0 },
      { data: new Uint8Array(100), width: 10, height: 10 }, { data: new Uint8Array(30), width: 100, height: 100 },
      { data: noise, width: 64, height: 48 }, { data: noise, width: NaN, height: 48 },
      { data: new Uint8ClampedArray(320 * 240 * 4).fill(255), width: 320, height: 240 },
    ];
    for (const c of cases) assert.equal(decodeQR(c), null);
    assert.equal(decodeQR({ data: noise, width: 64, height: 48 }, null), null);
  });
});
