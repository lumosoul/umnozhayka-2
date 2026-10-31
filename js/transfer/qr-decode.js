// Считыватель QR-кодов с кадров камеры (без BarcodeDetector, без DOM и глобального состояния).
//
// Конвейер decodeQR: яркость → адаптивная бинаризация по блокам → поиск искателей
// (1:1:3:1:1 с перекрёстной проверкой) → выбор тройки и ориентация → уточнение центров
// и размера модуля по профилям яркости → размерность (версионная информация, линии
// синхронизации, оценка по расстояниям) → перспектива (выравнивающие узоры, МНК-гомография)
// → выборка сетки с порогом в пространстве модулей → decodeMatrix.

import {
  ALNUM_CHARSET,
  alignmentPositions,
  blockInfo,
  charCountBits,
  dataModuleOrder,
  decodeFormatBits,
  decodeVersionBits,
  formatPositions,
  functionModuleMap,
  maskBit,
  rsDecode,
} from './qr-common.js';

// ===================== Разбор матрицы модулей =====================

/**
 * Читает QR-код по готовой матрице модулей (без изображения).
 * @param {Uint8Array|number[]} modules size×size построчно, 1 (истина) — тёмный модуль.
 * @param {number} size сторона матрицы (21..177).
 * @returns {{text: string, bytes: Uint8Array, version: number, ecl: 'L'|'M'|'Q'|'H', mask: number}|null}
 *   null — если форматная информация не читается или ошибок больше, чем исправляет код.
 *   Транспонированная (зеркальная) матрица тоже читается. Исключений не бросает.
 */
export function decodeMatrix(modules, size) {
  try {
    if (!modules || !Number.isInteger(size) || size < 21 || size > 177 || (size - 17) % 4 !== 0) return null;
    if (modules.length < size * size) return null;
    return decodeModules(modules, size);
  } catch {
    return null;
  }
}

// Зеркальное изображение даёт транспонированную матрицу: пробуем обе.
function decodeModules(modules, size) {
  const version = (size - 17) / 4;
  const order = dataModuleOrder(version, functionModuleMap(version));
  return decodeOriented(modules, size, order, false) || decodeOriented(modules, size, order, true);
}

function decodeOriented(modules, size, order, transposed) {
  const at = transposed ? (r, c) => modules[c * size + r] : (r, c) => modules[r * size + c];
  const [p1, p2] = formatPositions(size);
  let f1 = 0;
  let f2 = 0;
  for (let i = 0; i < 15; i++) {
    if (at(p1[i][0], p1[i][1])) f1 |= 1 << i;
    if (at(p2[i][0], p2[i][1])) f2 |= 1 << i;
  }
  // Кандидаты: лучший по обеим копиям, затем лучший по каждой копии отдельно.
  const tried = new Set();
  for (const fmt of [decodeFormatBits([f1, f2]), decodeFormatBits([f1]), decodeFormatBits([f2])]) {
    if (!fmt) continue;
    const key = fmt.ecl + fmt.mask;
    if (tried.has(key)) continue;
    tried.add(key);
    const res = decodeWithFormat(at, size, order, fmt.ecl, fmt.mask);
    if (res) return res;
  }
  return null;
}

function decodeWithFormat(at, size, order, ecl, mask) {
  const version = (size - 17) / 4;
  const info = blockInfo(version, ecl);
  const raw = new Uint8Array(info.totalCodewords);
  for (let i = 0; i < info.totalCodewords * 8; i++) {
    const idx = order[i];
    const r = Math.floor(idx / size);
    const c = idx - r * size;
    let bit = at(r, c) ? 1 : 0;
    if (maskBit(mask, r, c)) bit ^= 1;
    if (bit) raw[i >>> 3] |= 0x80 >>> (i & 7);
  }
  // Деинтерливинг: данные чередуются по блокам, затем коды коррекции.
  const lens = info.dataLengths;
  const ecc = info.eccPerBlock;
  const blocks = lens.map((len) => new Uint8Array(len + ecc));
  let k = 0;
  const maxData = lens[lens.length - 1];
  for (let i = 0; i < maxData; i++) {
    for (let b = 0; b < blocks.length; b++) if (i < lens[b]) blocks[b][i] = raw[k++];
  }
  for (let i = 0; i < ecc; i++) {
    for (let b = 0; b < blocks.length; b++) blocks[b][lens[b] + i] = raw[k++];
  }
  const data = new Uint8Array(info.dataCodewords);
  let off = 0;
  for (let b = 0; b < blocks.length; b++) {
    if (rsDecode(blocks[b], ecc) < 0) return null;
    data.set(blocks[b].subarray(0, lens[b]), off);
    off += lens[b];
  }
  const parsed = parseSegments(data, version);
  if (!parsed) return null;
  return { text: parsed.text, bytes: parsed.bytes, version, ecl, mask };
}

class BitReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.pos = 0;
  }

  available() {
    return this.bytes.length * 8 - this.pos;
  }

  read(n) {
    if (n > this.available()) throw new RangeError('QR: поток данных оборван');
    let v = 0;
    for (let i = 0; i < n; i++, this.pos++) {
      v = (v << 1) | ((this.bytes[this.pos >>> 3] >>> (7 - (this.pos & 7))) & 1);
    }
    return v;
  }
}

// Кодировки ECI (ISO/IEC 18004, AIM ECI) → метки WHATWG для TextDecoder.
const ECI_CHARSETS = {
  1: 'iso-8859-1', 3: 'iso-8859-1', 4: 'iso-8859-2', 5: 'iso-8859-3', 6: 'iso-8859-4',
  7: 'iso-8859-5', 8: 'iso-8859-6', 9: 'iso-8859-7', 10: 'iso-8859-8', 11: 'iso-8859-9',
  12: 'iso-8859-10', 13: 'iso-8859-11', 15: 'iso-8859-13', 16: 'iso-8859-14', 17: 'iso-8859-15',
  18: 'iso-8859-16', 20: 'shift_jis', 21: 'windows-1250', 22: 'windows-1251', 23: 'windows-1252',
  24: 'windows-1256', 25: 'utf-16be', 26: 'utf-8', 27: 'us-ascii', 28: 'big5', 29: 'gb18030',
  30: 'euc-kr',
};

function decodeText(bytes, label) {
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}

// Разбор сегментов. Любое нарушение формата → null (лучше отказ, чем мусор).
function parseSegments(data, version) {
  const reader = new BitReader(data);
  const out = [];
  let text = '';
  let pending = [];
  let charset = 'utf-8';
  let fnc1 = false;
  const flush = () => {
    if (pending.length) {
      text += decodeText(Uint8Array.from(pending), charset);
      pending = [];
    }
  };
  try {
    while (reader.available() >= 4) {
      const mode = reader.read(4);
      if (mode === 0) break;
      if (mode === 1) {
        let left = reader.read(charCountBits('numeric', version));
        let s = '';
        while (left >= 3) {
          const v = reader.read(10);
          if (v >= 1000) return null;
          s += String(v).padStart(3, '0');
          left -= 3;
        }
        if (left === 2) {
          const v = reader.read(7);
          if (v >= 100) return null;
          s += String(v).padStart(2, '0');
        } else if (left === 1) {
          const v = reader.read(4);
          if (v >= 10) return null;
          s += String(v);
        }
        flush();
        text += s;
        for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
      } else if (mode === 2) {
        let left = reader.read(charCountBits('alphanumeric', version));
        let s = '';
        while (left >= 2) {
          const v = reader.read(11);
          if (v >= 45 * 45) return null;
          s += ALNUM_CHARSET[Math.floor(v / 45)] + ALNUM_CHARSET[v % 45];
          left -= 2;
        }
        if (left === 1) {
          const v = reader.read(6);
          if (v >= 45) return null;
          s += ALNUM_CHARSET[v];
        }
        // В режиме GS1 (FNC1) «%» означает разделитель GS, а «%%» — сам знак процента.
        if (fnc1) s = s.replace(/%%|%/g, (m) => (m === '%%' ? '%' : '\x1d'));
        flush();
        text += s;
        for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
      } else if (mode === 4) {
        const count = reader.read(charCountBits('byte', version));
        if (count * 8 > reader.available()) return null;
        for (let i = 0; i < count; i++) {
          const b = reader.read(8);
          pending.push(b);
          out.push(b);
        }
      } else if (mode === 7) {
        const first = reader.read(8);
        let value;
        if ((first & 0x80) === 0) value = first;
        else if ((first & 0xc0) === 0x80) value = ((first & 0x3f) << 8) | reader.read(8);
        else if ((first & 0xe0) === 0xc0) value = ((first & 0x1f) << 16) | reader.read(16);
        else return null;
        flush();
        charset = ECI_CHARSETS[value] || 'utf-8';
      } else if (mode === 8 || mode === 13) {
        // Кандзи (Shift JIS) и ханьцзы (GB2312): 13 бит на знак. Если TextDecoder
        // не знает кодировку — отказ, а не подмена текста.
        if (mode === 13 && reader.read(4) !== 1) return null;
        const count = reader.read(charCountBits('kanji', version));
        if (count * 13 > reader.available()) return null;
        const sjis = [];
        for (let i = 0; i < count; i++) {
          const v = reader.read(13);
          let code;
          if (mode === 8) {
            code = (Math.floor(v / 0xc0) << 8) | (v % 0xc0);
            code += code < 0x1f00 ? 0x8140 : 0xc140;
          } else {
            code = (Math.floor(v / 0x60) << 8) | (v % 0x60);
            code += code < 0xa00 ? 0xa1a1 : 0xa6a1;
          }
          sjis.push(code >>> 8, code & 0xff);
        }
        let decoded;
        try {
          decoded = new TextDecoder(mode === 8 ? 'shift_jis' : 'gb18030', { fatal: true }).decode(Uint8Array.from(sjis));
        } catch {
          return null;
        }
        flush();
        text += decoded;
        out.push(...sjis);
      } else if (mode === 3) {
        reader.read(16); // Structured Append: номер, количество, чётность — для текста не нужны.
      } else if (mode === 5) {
        fnc1 = true;
      } else if (mode === 9) {
        reader.read(8);
        fnc1 = true;
      } else {
        return null;
      }
    }
  } catch {
    return null;
  }
  flush();
  return { text, bytes: Uint8Array.from(out) };
}

// ===================== Изображение =====================

/**
 * Ищет и читает QR-код в кадре камеры.
 * @param {{data: Uint8ClampedArray|Uint8Array, width: number, height: number}} image
 *   RGBA-пиксели, как в ImageData (допускаются и серые: data.length === width·height).
 * @param {{tryHarder?: boolean}} [options] tryHarder (по умолчанию true): дополнительные
 *   проходы (несглаженный кадр, негатив), запасные тройки искателей, размерности и
 *   способы выборки. Без него — только основной проход (быстрее, но менее надёжно).
 * @returns {{text: string, bytes: Uint8Array, version: number, ecl: 'L'|'M'|'Q'|'H', mask: number}|null}
 *   null — код не найден или не прочитан. Исключений не бросает.
 */
export function decodeQR(image, options) {
  // Параметры разбираются внутри try: даже decodeQR(img, null) не должен бросать.
  try {
    const tryHarder = options?.tryHarder === undefined ? true : Boolean(options.tryHarder);
    return decodeImage(image, tryHarder);
  } catch {
    return null;
  }
}

function decodeImage(image, tryHarder) {
  if (!image || !image.data) return null;
  const w = Math.floor(image.width);
  const h = Math.floor(image.height);
  if (!(w >= 21 && h >= 21)) return null;
  const gray = toGray(image.data, w, h);
  if (!gray) return null;
  // Бюджет попыток подбора сетки общий на все проходы: кадр без кода или с похожими
  // на искатели предметами не должен съедать время следующего кадра.
  const budget = { left: tryHarder ? 14 : 5 };
  const context = (g) => ({ gray: g, w, h, tryHarder, budget, smallSeen: false, ...binarize(g, w, h) });
  // Основной проход — по слегка сглаженному кадру (биномиальный фильтр 3×3, σ ≈ 0.7 px):
  // шум сенсора иначе рвёт отрезки искателей в бинарном изображении.
  const soft = context(smooth(gray, w, h));
  let res = scanFrame(soft);
  // Сглаживание мешает лишь самым мелким модулям (до ~4 px): несглаженный кадр
  // пробуем, только если такие кандидаты в искатели вообще встречались.
  if (!res && tryHarder && soft.smallSeen) res = scanFrame(context(gray));
  // Светлый код на тёмном фоне (тёмная тема экрана) — та же процедура на негативе.
  if (!res && tryHarder) res = scanFrame(invertContext(soft));
  return res;
}

// Биномиальный фильтр [1 2 1]⊗[1 2 1]/16: горизонтальные суммы строк держим в кольце из
// трёх строк, чтобы не выделять на каждый кадр ещё одно полноразмерное изображение.
function smooth(gray, w, h) {
  const rows = [new Uint16Array(w), new Uint16Array(w), new Uint16Array(w)];
  const horizontal = (y, dst) => {
    const o = y * w;
    dst[0] = 3 * gray[o] + gray[o + 1];
    for (let x = 1; x < w - 1; x++) dst[x] = gray[o + x - 1] + 2 * gray[o + x] + gray[o + x + 1];
    dst[w - 1] = gray[o + w - 2] + 3 * gray[o + w - 1];
  };
  const out = new Uint8Array(w * h);
  horizontal(0, rows[0]);
  horizontal(0, rows[1]);
  for (let y = 0; y < h; y++) {
    const up = rows[y % 3];
    const mid = rows[(y + 1) % 3];
    const dn = rows[(y + 2) % 3];
    horizontal(Math.min(h - 1, y + 1), dn);
    const o = y * w;
    for (let x = 0; x < w; x++) out[o + x] = (up[x] + 2 * mid[x] + dn[x] + 8) >> 4;
  }
  return out;
}

// Яркость: RGBA (как ImageData) либо уже готовые серые пиксели (data.length = w·h).
function toGray(data, w, h) {
  const n = w * h;
  if (data.length >= n * 4) {
    const g = new Uint8Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      g[i] = (data[j] * 77 + data[j + 1] * 150 + data[j + 2] * 29 + 128) >> 8;
    }
    return g;
  }
  return data.length === n ? data : null;
}

const BLOCK = 8;
const MIN_DYNAMIC_RANGE = 24;

// Адаптивная бинаризация по блокам 8×8 (по мотивам HybridBinarizer из ZXing): «чёрная
// точка» блока — его среднее; блок без контраста считается фоном (половина минимума),
// но наследует уровень соседей, если он темнее их, — так внутренности крупных тёмных
// модулей не рассыпаются в шум. Порог блока — среднее чёрных точек окрестности 5×5,
// причём если в окрестности есть контрастные блоки, усредняются только они: иначе
// светлая тихая зона (min/2) при низком контрасте экрана тянет порог ниже уровня
// тёмных модулей и искатель у угла «исчезает».
function binarize(gray, w, h) {
  const bw = Math.ceil(w / BLOCK);
  const bh = Math.ceil(h / BLOCK);
  const bp = new Uint8Array(bw * bh);
  const flat = new Uint8Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    const y0 = Math.min(by * BLOCK, h - BLOCK);
    for (let bx = 0; bx < bw; bx++) {
      const x0 = Math.min(bx * BLOCK, w - BLOCK);
      let sum = 0;
      let mn = 255;
      let mx = 0;
      for (let yy = 0; yy < BLOCK; yy++) {
        let o = (y0 + yy) * w + x0;
        for (let xx = 0; xx < BLOCK; xx++, o++) {
          const p = gray[o];
          sum += p;
          if (p < mn) mn = p;
          if (p > mx) mx = p;
        }
        // Контраст уже есть — дальше нужна только сумма (как в ZXing).
        if (mx - mn > MIN_DYNAMIC_RANGE) {
          for (yy++; yy < BLOCK; yy++) {
            o = (y0 + yy) * w + x0;
            for (let xx = 0; xx < BLOCK; xx++, o++) sum += gray[o];
          }
        }
      }
      let avg = sum >> 6;
      if (mx - mn <= MIN_DYNAMIC_RANGE) {
        flat[by * bw + bx] = 1;
        avg = mn >> 1;
        if (by > 0 && bx > 0) {
          const nb = (bp[(by - 1) * bw + bx] + 2 * bp[by * bw + bx - 1] + bp[(by - 1) * bw + bx - 1]) >> 2;
          if (mn < nb) avg = nb;
        }
      }
      bp[by * bw + bx] = avg;
    }
  }
  const thr = new Uint8Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    const t0 = Math.max(0, Math.min(by - 2, bh - 5));
    const t1 = Math.min(bh - 1, t0 + 4);
    for (let bx = 0; bx < bw; bx++) {
      const l0 = Math.max(0, Math.min(bx - 2, bw - 5));
      const l1 = Math.min(bw - 1, l0 + 4);
      let sum = 0;
      let sumC = 0;
      let cntC = 0;
      for (let y = t0; y <= t1; y++) {
        for (let x = l0; x <= l1; x++) {
          const q = y * bw + x;
          sum += bp[q];
          if (!flat[q]) {
            sumC += bp[q];
            cntC++;
          }
        }
      }
      thr[by * bw + bx] = cntC ? Math.floor(sumC / cntC) : Math.floor(sum / ((t1 - t0 + 1) * (l1 - l0 + 1)));
    }
  }
  const bits = new Uint8Array(w * h);
  for (let by = 0; by < bh; by++) {
    const yEnd = Math.min(h, (by + 1) * BLOCK);
    for (let bx = 0; bx < bw; bx++) {
      const t = thr[by * bw + bx];
      const xEnd = Math.min(w, (bx + 1) * BLOCK);
      for (let y = by * BLOCK; y < yEnd; y++) {
        for (let o = y * w + bx * BLOCK, e = y * w + xEnd; o < e; o++) bits[o] = gray[o] <= t ? 1 : 0;
      }
    }
  }
  return { bits, thr, bw, bh };
}

function invertContext(ctx) {
  const n = ctx.w * ctx.h;
  const gray = new Uint8Array(n);
  const bits = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    gray[i] = 255 - ctx.gray[i];
    bits[i] = 1 - ctx.bits[i];
  }
  const thr = ctx.thr.map((t) => 255 - t);
  return { ...ctx, gray, bits, thr };
}

// Билинейная выборка яркости; координаты в «краевой» системе: пиксель i занимает [i, i+1).
function sample(gray, w, h, x, y) {
  let fx = x - 0.5;
  let fy = y - 0.5;
  if (fx < 0) fx = 0;
  else if (fx > w - 1.001) fx = w - 1.001;
  if (fy < 0) fy = 0;
  else if (fy > h - 1.001) fy = h - 1.001;
  const x0 = fx | 0;
  const y0 = fy | 0;
  const ax = fx - x0;
  const ay = fy - y0;
  const i = y0 * w + x0;
  const a = gray[i];
  const top = a + (gray[i + 1] - a) * ax;
  const c = gray[i + w];
  const bottom = c + (gray[i + w + 1] - c) * ax;
  return top + (bottom - top) * ay;
}

// Порог бинаризатора в точке (билинейно между центрами блоков).
function thresholdAt(ctx, x, y) {
  const { thr, bw, bh } = ctx;
  let fx = x / BLOCK - 0.5;
  let fy = y / BLOCK - 0.5;
  if (fx < 0) fx = 0;
  else if (fx > bw - 1) fx = bw - 1;
  if (fy < 0) fy = 0;
  else if (fy > bh - 1) fy = bh - 1;
  const x0 = Math.min(fx | 0, Math.max(0, bw - 2));
  const y0 = Math.min(fy | 0, Math.max(0, bh - 2));
  const x1 = Math.min(x0 + 1, bw - 1);
  const y1 = Math.min(y0 + 1, bh - 1);
  const ax = fx - x0;
  const ay = fy - y0;
  const top = thr[y0 * bw + x0] * (1 - ax) + thr[y0 * bw + x1] * ax;
  const bottom = thr[y1 * bw + x0] * (1 - ax) + thr[y1 * bw + x1] * ax;
  return top * (1 - ay) + bottom * ay;
}

// ===================== Искатели =====================

// Пропорции искателя 1:1:3:1:1. Центр и светлое кольцо проверяются строго (допуск tol),
// внешнее тёмное кольцо — мягко (от половины модуля до 3.5 модулей): при размытии,
// муаре и повороте оно сливается с соседними тёмными модулями данных. Светлое кольцо
// может быть и тоньше (до 0.35 модуля): у мелких размытых модулей порог «съедает» его.
function finderRatio(a, b, c, d, e, tol) {
  const inner = b + c + d;
  if (inner < 5) return false;
  const m = inner / 5;
  const v = m * tol;
  return b > 0.35 * m && b < m + v && d > 0.35 * m && d < m + v && Math.abs(c - 3 * m) < 3 * v &&
    a > m - v && e > m - v && a < 3.5 * m && e < 3.5 * m;
}

// Пять отрезков вдоль линии через (x, y) с шагом (dx, dy): тёмный центр, светлое
// и тёмное кольца в обе стороны. Возвращает центр центрального отрезка и сумму.
function crossRuns(bits, w, h, x, y, dx, dy, limit) {
  const at = (i) => {
    const px = x + i * dx;
    const py = y + i * dy;
    return px >= 0 && py >= 0 && px < w && py < h ? bits[py * w + px] : 2;
  };
  if (at(0) !== 1) return null;
  const s = [0, 0, 0, 0, 0];
  let i = 0;
  while (at(i) === 1) { s[2]++; i--; }
  while (at(i) === 0 && s[1] <= limit) { s[1]++; i--; }
  while (at(i) === 1 && s[0] <= limit) { s[0]++; i--; }
  if (at(i) === 2 || !s[1] || !s[0] || s[1] > limit || s[0] > limit) return null;
  i = 1;
  while (at(i) === 1) { s[2]++; i++; }
  while (at(i) === 0 && s[3] <= limit) { s[3]++; i++; }
  while (at(i) === 1 && s[4] <= limit) { s[4]++; i++; }
  if (at(i) === 2 || !s[3] || !s[4] || s[3] > limit || s[4] > limit) return null;
  const end = i - s[4] - s[3]; // конец центрального отрезка (исключительно), в шагах
  return { s, inner: s[1] + s[2] + s[3], center: end - s[2] / 2 };
}

// Кандидат из строки подтверждается по вертикали, затем по горизонтали (уточняя центр)
// и по диагонали. Близкие подтверждения сливаются (взвешенное среднее, count — их число).
function confirmFinder(ctx, cx0, y, hInner, cands) {
  const { bits, w, h } = ctx;
  const limit = hInner;
  const ix = Math.floor(cx0);
  const v = crossRuns(bits, w, h, ix, y, 0, 1, limit);
  if (!v || Math.abs(v.inner - hInner) > 0.5 * hInner + 1 || !finderRatio(...v.s, 0.5)) return;
  const py = y + v.center;
  const iy = Math.floor(py);
  const hz = crossRuns(bits, w, h, ix, iy, 1, 0, limit);
  if (!hz || Math.abs(hz.inner - hInner) > 0.5 * hInner + 1 || !finderRatio(...hz.s, 0.5)) return;
  const px = ix + hz.center;
  const d = crossRuns(bits, w, h, Math.floor(px), iy, 1, 1, limit);
  if (!d || !finderRatio(...d.s, 0.75)) return;
  const ms = (hz.inner + v.inner) / 10;
  for (const c of cands) {
    if (Math.abs(c.x - px) <= ms && Math.abs(c.y - py) <= ms) {
      const diff = Math.abs(ms - c.ms);
      if (diff <= 1 || diff <= c.ms) {
        const n = c.count;
        c.x = (c.x * n + px) / (n + 1);
        c.y = (c.y * n + py) / (n + 1);
        c.ms = (c.ms * n + ms) / (n + 1);
        c.count = n + 1;
        return;
      }
    }
  }
  if (cands.length < 300) cands.push({ x: px, y: py, ms, count: 1 });
}

function findFinders(ctx, step) {
  const { bits, w, h } = ctx;
  const cands = [];
  for (let y = 0; y < h; y += step) {
    const row = y * w;
    let c0 = 0;
    let c1 = 0;
    let c2 = 0;
    let c3 = 0;
    let c4 = 0;
    let runs = 0;
    let color = bits[row];
    let len = 0;
    for (let x = 0; x <= w; x++) {
      const v = x < w ? bits[row + x] : 2;
      if (v === color) {
        len++;
        continue;
      }
      c0 = c1;
      c1 = c2;
      c2 = c3;
      c3 = c4;
      c4 = len;
      runs++;
      if (color === 1 && runs >= 5 && finderRatio(c0, c1, c2, c3, c4, 0.5)) {
        // Центр среднего отрезка в «краевых» координатах (пиксель i занимает [i, i+1)).
        confirmFinder(ctx, x - c4 - c3 - c2 / 2, y, c1 + c2 + c3, cands);
      }
      color = v;
      len = 1;
    }
  }
  return cands;
}

// Лучшие тройки: почти прямоугольный равнобедренный треугольник, близкие размеры модуля.
function rankTriples(cands, limit) {
  // Модуль меньше ~2 px — это шум или мелкий текст, а не читаемый код.
  const sized = cands.filter((c) => c.ms >= 1.8);
  let pool = sized.filter((c) => c.count >= 2);
  if (pool.length < 3) pool = sized;
  pool.sort((a, b) => b.count - a.count);
  pool = pool.slice(0, 12);
  const out = [];
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      for (let k = j + 1; k < pool.length; k++) {
        const s = tripleScore(pool[i], pool[j], pool[k]);
        if (s < Infinity) out.push({ a: pool[i], b: pool[j], c: pool[k], score: s });
      }
    }
  }
  out.sort((x, y) => x.score - y.score);
  return out.slice(0, limit);
}

function tripleScore(a, b, c) {
  const msMin = Math.min(a.ms, b.ms, c.ms);
  const msMax = Math.max(a.ms, b.ms, c.ms);
  if (msMax > 2 * msMin) return Infinity;
  const d = [Math.hypot(a.x - b.x, a.y - b.y), Math.hypot(b.x - c.x, b.y - c.y), Math.hypot(c.x - a.x, c.y - a.y)]
    .sort((x, y) => x - y);
  const [s1, s2, s3] = d;
  const ms = (a.ms + b.ms + c.ms) / 3;
  const dim = (s1 + s2) / 2 / ms + 7;
  if (dim < 12 || dim > 200) return Infinity;
  const ratio = s2 / s1;
  if (ratio > 2) return Infinity;
  const cos = (s1 * s1 + s2 * s2 - s3 * s3) / (2 * s1 * s2);
  if (Math.abs(cos) > 0.5) return Infinity;
  return (ratio - 1) + 2 * Math.abs(cos) + 0.5 * (msMax / msMin - 1);
}

// Вершина при прямом угле — левый верхний; правый верхний — по знаку векторного произведения.
function orient(a, b, c) {
  const dab = (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
  const dbc = (b.x - c.x) ** 2 + (b.y - c.y) ** 2;
  const dca = (c.x - a.x) ** 2 + (c.y - a.y) ** 2;
  let tl;
  let p;
  let q;
  if (dbc >= dab && dbc >= dca) [tl, p, q] = [a, b, c];
  else if (dca >= dab && dca >= dbc) [tl, p, q] = [b, c, a];
  else [tl, p, q] = [c, a, b];
  const cross = (p.x - tl.x) * (q.y - tl.y) - (p.y - tl.y) * (q.x - tl.x);
  return cross > 0 ? { tl, tr: p, bl: q } : { tl, tr: q, bl: p };
}

function unit(ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  return [dx / len, dy / len];
}

// Профиль яркости вдоль луча от центра искателя: три перехода (центр→светлое кольцо→
// тёмное кольцо→разделитель) на расстояниях 1.5, 2.5, 3.5 модуля. По двум
// противоположным лучам получаем сдвиг центра вдоль оси и размер модуля.
function axisProfile(ctx, x, y, dx, dy, ms) {
  const { gray, w, h } = ctx;
  const step = 0.5;
  const n = Math.ceil((6 * ms) / step) + 2;
  const prof = [new Float32Array(n), new Float32Array(n)];
  let mn = 255;
  let mx = 0;
  for (let s = 0; s < 2; s++) {
    const sign = s === 0 ? 1 : -1;
    const raw = new Float32Array(n);
    for (let i = 0; i < n; i++) raw[i] = sample(gray, w, h, x + sign * i * step * dx, y + sign * i * step * dy);
    const p = prof[s];
    for (let i = 0; i < n; i++) {
      const a = raw[Math.max(0, i - 1)];
      const b = raw[Math.min(n - 1, i + 1)];
      p[i] = (a + 2 * raw[i] + b) / 4;
      if (p[i] < mn) mn = p[i];
      if (p[i] > mx) mx = p[i];
    }
  }
  if (mx - mn < 16) return null;
  const t = (mn + mx) / 2;
  const edges = [];
  for (let s = 0; s < 2; s++) {
    const p = prof[s];
    if (p[0] >= t) return null;
    const e = [];
    let dark = true;
    for (let i = 1; i < n && e.length < 3; i++) {
      const isDark = p[i] < t;
      if (isDark !== dark) {
        const f = (t - p[i - 1]) / (p[i] - p[i - 1]);
        e.push((i - 1 + f) * step);
        dark = isDark;
      }
    }
    if (e.length < 3) return null;
    edges.push(e);
  }
  const [e, f] = edges;
  const module = (1.5 * (e[0] + f[0]) + 2.5 * (e[1] + f[1]) + 3.5 * (e[2] + f[2])) / 41.5;
  // Каждое кольцо — около модуля, центр — около трёх: иначе это не искатель по этой оси.
  for (const g of edges) {
    if (g[0] < 0.9 * module || g[0] > 2.2 * module) return null;
    if (g[1] - g[0] < 0.4 * module || g[1] - g[0] > 1.8 * module) return null;
    if (g[2] - g[1] < 0.4 * module || g[2] - g[1] > 1.8 * module) return null;
  }
  const offset = ((f[0] - e[0]) + (f[1] - e[1]) + (f[2] - e[2])) / 6;
  return { offset, module, dark: mn, light: mx };
}

function refineFinder(ctx, f, du, dv) {
  let { x, y } = f;
  const ms = f.ms0;
  const a = axisProfile(ctx, x, y, du[0], du[1], ms);
  if (a) {
    x += a.offset * du[0];
    y += a.offset * du[1];
  }
  const b = axisProfile(ctx, x, y, dv[0], dv[1], ms);
  if (b) {
    x += b.offset * dv[0];
    y += b.offset * dv[1];
  }
  const est = ms / 1.2; // запасной вариант: оценка по строкам завышена при повороте
  return {
    x,
    y,
    ms0: ms,
    mu: a ? a.module : est,
    mv: b ? b.module : est,
    dark: a ? a.dark : b ? b.dark : 0,
    light: a ? a.light : b ? b.light : 255,
    ok: !!(a && b),
  };
}

// Перспективная оценка четвёртого «угла» (dim−3.5, dim−3.5): знаменатель проективного
// преобразования W вдоль стороны меняется так, что масштаб ∝ 1/W², поэтому отношение
// размеров модуля у соседних искателей даёт W, а числитель гомографии аффинен.
function virtualCorner(tl, tr, bl) {
  const clamp = (v) => Math.min(1.45, Math.max(0.69, v));
  let wTR = clamp(Math.sqrt(tl.mu / tr.mu));
  let wBL = clamp(Math.sqrt(tl.mv / bl.mv));
  if (!tl.ok || !tr.ok || !bl.ok) {
    wTR = 1;
    wBL = 1;
  }
  const wBR = wTR + wBL - 1;
  return {
    x: (tr.x * wTR + bl.x * wBL - tl.x) / wBR,
    y: (tr.y * wTR + bl.y * wBL - tl.y) / wBR,
  };
}

function refineTriple(ctx, tl0, tr0, bl0) {
  let tl = { ...tl0, ms0: tl0.ms };
  let tr = { ...tr0, ms0: tr0.ms };
  let bl = { ...bl0, ms0: bl0.ms };
  let br = null;
  for (let iter = 0; iter < 2; iter++) {
    const top = unit(tl.x, tl.y, tr.x, tr.y);
    const left = unit(tl.x, tl.y, bl.x, bl.y);
    const right = br ? unit(tr.x, tr.y, br.x, br.y) : left;
    const bottom = br ? unit(bl.x, bl.y, br.x, br.y) : top;
    tl = refineFinder(ctx, tl, top, left);
    tr = refineFinder(ctx, tr, top, right);
    bl = refineFinder(ctx, bl, bottom, left);
    br = virtualCorner(tl, tr, bl);
  }
  const top = unit(tl.x, tl.y, tr.x, tr.y);
  const left = unit(tl.x, tl.y, bl.x, bl.y);
  const right = unit(tr.x, tr.y, br.x, br.y);
  const bottom = unit(bl.x, bl.y, br.x, br.y);
  // Локальные векторы модуля (u — вдоль строки, v — вдоль столбца) у каждого искателя.
  const frame = (f, du, dv) => ({ ux: du[0] * f.mu, uy: du[1] * f.mu, vx: dv[0] * f.mv, vy: dv[1] * f.mv });
  return {
    tl, tr, bl, br,
    ftl: frame(tl, top, left),
    ftr: frame(tr, top, right),
    fbl: frame(bl, bottom, left),
    contrast: Math.max(16, ((tl.light - tl.dark) + (tr.light - tr.dark) + (bl.light - bl.dark)) / 3),
  };
}

// ===================== Размерность =====================

// Число тёмных модулей линии синхронизации между искателями (k = 2·версия + 1)
// по профилю от точки A внутри одного искателя до точки B внутри другого.
function timingCount(ctx, ax, ay, bx, by, ms) {
  const { gray, w, h } = ctx;
  const len = Math.hypot(bx - ax, by - ay);
  const step = Math.min(0.5, ms / 4);
  const n = Math.floor(len / step) + 1;
  if (n < 20 || n > 40000) return -1;
  const raw = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const x = ax + t * (bx - ax);
    const y = ay + t * (by - ay);
    raw[i] = sample(gray, w, h, x, y) < thresholdAt(ctx, x, y) ? 1 : 0;
  }
  // Медианный фильтр на 3 отсчёта гасит одиночные выбросы шума.
  const m = new Uint8Array(n);
  m[0] = raw[0];
  m[n - 1] = raw[n - 1];
  for (let i = 1; i < n - 1; i++) m[i] = raw[i - 1] + raw[i] + raw[i + 1] >= 2 ? 1 : 0;
  if (!m[0] || !m[n - 1]) return -1;
  const lens = [];
  let cur = m[0];
  let run = 0;
  let dark = 0;
  for (let i = 0; i < n; i++) {
    if (m[i] === cur) run++;
    else {
      lens.push(run);
      if (cur) dark++;
      cur = m[i];
      run = 1;
    }
  }
  lens.push(run);
  if (cur) dark++;
  const k = dark - 2;
  if (k < 3 || k % 2 === 0) return -1;
  const inner = lens.slice(1, -1).sort((a, b) => a - b);
  const med = inner[inner.length >> 1];
  if (inner[0] < 0.35 * med || inner[inner.length - 1] > 2.6 * med) return -1;
  return k;
}

function readVersionBlock(ctx, f, fr, topRight) {
  const { gray, w, h } = ctx;
  let bits = 0;
  for (let i = 0; i < 18; i++) {
    const dx = topRight ? (i % 3) - 7 : Math.floor(i / 3) - 3;
    const dy = topRight ? Math.floor(i / 3) - 3 : (i % 3) - 7;
    const x = f.x + dx * fr.ux + dy * fr.vx;
    const y = f.y + dx * fr.uy + dy * fr.vy;
    if (sample(gray, w, h, x, y) < thresholdAt(ctx, x, y)) bits |= 1 << i;
  }
  return bits;
}

// Гипотезы размерности по убыванию надёжности: версионная информация (БЧХ), счёт
// модулей линий синхронизации, оценка по расстоянию между искателями и её соседи.
// trusted — гипотеза подтверждена независимо, её не нужно проверять по синхронизации.
function dimensionCandidates(ctx, g) {
  const { tl, tr, bl, ftl, ftr, fbl } = g;
  const dU = Math.hypot(tr.x - tl.x, tr.y - tl.y) / ((tl.mu + tr.mu) / 2);
  const dV = Math.hypot(bl.x - tl.x, bl.y - tl.y) / ((tl.mv + bl.mv) / 2);
  const est = (dU + dV) / 2 + 7;
  const out = [];
  const plausible = (d) => Math.abs(d - est) <= Math.max(8, 0.25 * est);
  const add = (dim, trusted) => {
    if (dim < 21 || dim > 177 || (dim - 17) % 4 !== 0 || !plausible(dim)) return;
    const old = out.find((c) => c.dim === dim);
    if (old) old.trusted ||= trusted;
    else out.push({ dim, trusted });
  };
  if (est >= 38) {
    const vi = decodeVersionBits([readVersionBlock(ctx, tr, ftr, true), readVersionBlock(ctx, bl, fbl, false)]);
    if (vi) add(17 + 4 * vi.version, vi.distance <= 2);
  }
  const ms = Math.min(tl.mu, tl.mv, tr.mu, bl.mv);
  const kh = timingCount(ctx, tl.x + 3 * ftl.vx, tl.y + 3 * ftl.vy, tr.x + 3 * ftr.vx, tr.y + 3 * ftr.vy, ms);
  const kv = timingCount(ctx, tl.x + 3 * ftl.ux, tl.y + 3 * ftl.uy, bl.x + 3 * fbl.ux, bl.y + 3 * fbl.uy, ms);
  if (kh > 0 && kh === kv) add(2 * kh + 15, true);
  const snapped = Math.round((est - 17) / 4) * 4 + 17;
  add(snapped, false);
  if (kh > 0) add(2 * kh + 15, false);
  if (kv > 0) add(2 * kv + 15, false);
  if (ctx.tryHarder) {
    const order = est >= snapped ? [4, -4] : [-4, 4];
    for (const d of order) add(snapped + d, false);
  }
  return out;
}

// ===================== Гомография =====================

function normalization(pts) {
  let cx = 0;
  let cy = 0;
  for (const p of pts) {
    cx += p[0];
    cy += p[1];
  }
  cx /= pts.length;
  cy /= pts.length;
  let d = 0;
  for (const p of pts) d += Math.hypot(p[0] - cx, p[1] - cy);
  const s = d > 0 ? (Math.SQRT2 * pts.length) / d : 1;
  return { cx, cy, s };
}

// Гомография модульные координаты → пиксели по ≥ 4 соответствиям (DLT, МНК, нормировка Хартли).
function fitHomography(src, dst) {
  const ns = normalization(src);
  const nd = normalization(dst);
  const A = new Float64Array(64);
  const B = new Float64Array(8);
  const row = new Float64Array(8);
  for (let k = 0; k < src.length; k++) {
    const x = (src[k][0] - ns.cx) * ns.s;
    const y = (src[k][1] - ns.cy) * ns.s;
    const X = (dst[k][0] - nd.cx) * nd.s;
    const Y = (dst[k][1] - nd.cy) * nd.s;
    for (let eq = 0; eq < 2; eq++) {
      const T = eq === 0 ? X : Y;
      row.fill(0);
      const o = eq * 3;
      row[o] = x;
      row[o + 1] = y;
      row[o + 2] = 1;
      row[6] = -x * T;
      row[7] = -y * T;
      for (let i = 0; i < 8; i++) {
        if (row[i] === 0) continue;
        B[i] += row[i] * T;
        for (let j = 0; j < 8; j++) A[i * 8 + j] += row[i] * row[j];
      }
    }
  }
  const hv = solve8(A, B);
  if (!hv) return null;
  // H = T_dst⁻¹ · Hn · T_src
  const hn = [hv[0], hv[1], hv[2], hv[3], hv[4], hv[5], hv[6], hv[7], 1];
  const ts = [ns.s, 0, -ns.s * ns.cx, 0, ns.s, -ns.s * ns.cy, 0, 0, 1];
  const td = [1 / nd.s, 0, nd.cx, 0, 1 / nd.s, nd.cy, 0, 0, 1];
  const H = mul3(td, mul3(hn, ts));
  if (!Number.isFinite(H[8]) || Math.abs(H[8]) < 1e-12) return null;
  for (let i = 0; i < 9; i++) H[i] /= H[8];
  return H.every(Number.isFinite) ? H : null;
}

function mul3(a, b) {
  const r = new Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  }
  return r;
}

function solve8(A, B) {
  const n = 8;
  const m = Float64Array.from(A);
  const b = Float64Array.from(B);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r * n + col]) > Math.abs(m[piv * n + col])) piv = r;
    if (Math.abs(m[piv * n + col]) < 1e-12) return null;
    if (piv !== col) {
      for (let j = 0; j < n; j++) [m[col * n + j], m[piv * n + j]] = [m[piv * n + j], m[col * n + j]];
      [b[col], b[piv]] = [b[piv], b[col]];
    }
    for (let r = col + 1; r < n; r++) {
      const f = m[r * n + col] / m[col * n + col];
      if (f === 0) continue;
      for (let j = col; j < n; j++) m[r * n + j] -= f * m[col * n + j];
      b[r] -= f * b[col];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let j = r + 1; j < n; j++) s -= m[r * n + j] * x[j];
    x[r] = s / m[r * n + r];
  }
  return x;
}

function project(H, x, y) {
  const z = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / z, (H[3] * x + H[4] * y + H[5]) / z];
}

// Векторы смещения в пикселях на один модуль по x (u) и по y (v) в точке (x, y).
function jacobian(H, x, y) {
  const z = H[6] * x + H[7] * y + H[8];
  const X = (H[0] * x + H[1] * y + H[2]) / z;
  const Y = (H[3] * x + H[4] * y + H[5]) / z;
  return {
    ux: (H[0] - H[6] * X) / z,
    uy: (H[3] - H[6] * Y) / z,
    vx: (H[1] - H[7] * X) / z,
    vy: (H[4] - H[7] * Y) / z,
  };
}

// ===================== Выравнивающие узоры =====================

// Сходство с узором 5×5 (тёмная рамка, светлое кольцо, тёмный центр) по центрам ячеек.
function alignScore(gray, w, h, cx, cy, J) {
  let ring = 0;
  let light = 0;
  let center = 0;
  for (let j = -2; j <= 2; j++) {
    for (let i = -2; i <= 2; i++) {
      const g = sample(gray, w, h, cx + i * J.ux + j * J.vx, cy + i * J.uy + j * J.vy);
      const r = Math.max(Math.abs(i), Math.abs(j));
      if (r === 2) ring += g;
      else if (r === 1) light += g;
      else center = g;
    }
  }
  return light / 8 - (ring / 16 + center) / 2;
}

function locateAlignment(ctx, H, mx, my, radius, minContrast) {
  const { gray, w, h } = ctx;
  const [px, py] = project(H, mx, my);
  const J = jacobian(H, mx, my);
  const ms = Math.sqrt(Math.abs(J.ux * J.vy - J.uy * J.vx));
  if (!(ms >= 1) || !Number.isFinite(px) || !Number.isFinite(py)) return null;
  if (px < -ms * 3 || py < -ms * 3 || px > w + ms * 3 || py > h + ms * 3) return null;
  let best = -Infinity;
  let ba = 0;
  let bb = 0;
  const coarse = 0.5;
  for (let b = -radius; b <= radius + 1e-9; b += coarse) {
    for (let a = -radius; a <= radius + 1e-9; a += coarse) {
      const s = alignScore(gray, w, h, px + a * J.ux + b * J.vx, py + a * J.uy + b * J.vy, J);
      if (s > best) {
        best = s;
        ba = a;
        bb = b;
      }
    }
  }
  const fine = 0.125;
  let fa = ba;
  let fb = bb;
  for (let b = bb - 0.375; b <= bb + 0.375 + 1e-9; b += fine) {
    for (let a = ba - 0.375; a <= ba + 0.375 + 1e-9; a += fine) {
      const s = alignScore(gray, w, h, px + a * J.ux + b * J.vx, py + a * J.uy + b * J.vy, J);
      if (s > best) {
        best = s;
        fa = a;
        fb = b;
      }
    }
  }
  // Параболическое уточнение пика по каждой оси.
  const at = (a, b) => alignScore(gray, w, h, px + a * J.ux + b * J.vx, py + a * J.uy + b * J.vy, J);
  const peak = (m, z, p) => {
    const den = m - 2 * z + p;
    return den < 0 ? Math.max(-0.5, Math.min(0.5, (m - p) / (2 * den))) : 0;
  };
  fa += fine * peak(at(fa - fine, fb), best, at(fa + fine, fb));
  fb += fine * peak(at(fa, fb - fine), best, at(fa, fb + fine));
  const cx = px + fa * J.ux + fb * J.vx;
  const cy = py + fa * J.uy + fb * J.vy;
  // Проверка качества: контраст и согласие ячеек с шаблоном.
  const vals = [];
  let lightSum = 0;
  let darkSum = 0;
  for (let j = -2; j <= 2; j++) {
    for (let i = -2; i <= 2; i++) {
      const g = sample(gray, w, h, cx + i * J.ux + j * J.vx, cy + i * J.uy + j * J.vy);
      const isLight = Math.max(Math.abs(i), Math.abs(j)) === 1;
      vals.push([g, isLight]);
      if (isLight) lightSum += g;
      else darkSum += g;
    }
  }
  const lm = lightSum / 8;
  const dm = darkSum / 17;
  if (lm - dm < minContrast) return null;
  const t = (lm + dm) / 2;
  let good = 0;
  for (const [g, isLight] of vals) if ((g >= t) === isLight) good++;
  if (good < 22) return null;
  return { x: cx, y: cy };
}

// ===================== Сетка =====================

function sampleGrid(ctx, H, dim) {
  const { gray, w, h } = ctx;
  const [h0, h1, h2, h3, h4, h5, h6, h7, h8] = H;
  const at = (x, y) => {
    const z = h6 * x + h7 * y + h8;
    return sample(gray, w, h, (h0 * x + h1 * y + h2) / z, (h3 * x + h4 * y + h5) / z);
  };
  const J = jacobian(H, dim / 2, dim / 2);
  // Крупные модули усредняем по пяти точкам (центр с весом 2) — против шума и муара;
  // у мелких дополнительные точки задели бы соседние модули.
  const multi = Math.sqrt(Math.abs(J.ux * J.vy - J.uy * J.vx)) >= 3.5;
  const o = 0.2;
  const vals = new Float32Array(dim * dim);
  for (let r = 0; r < dim; r++) {
    const y = r + 0.5;
    for (let c = 0; c < dim; c++) {
      const x = c + 0.5;
      vals[r * dim + c] = multi
        ? (2 * at(x, y) + at(x - o, y - o) + at(x + o, y - o) + at(x - o, y + o) + at(x + o, y + o)) / 6
        : at(x, y);
    }
  }
  return vals;
}

// Порог в пространстве модулей: сначала локальное среднее окна 9×9, затем среднее
// между средними тёмных и светлых ячеек того же окна (устойчиво к перекосу долей
// возле искателей и к градиенту освещённости). Суммы окон — по интегральным таблицам.
function thresholdGrid(vals, dim) {
  const R = 4;
  const W = dim + 1;
  const integral = (table, value) => {
    for (let r = 0; r < dim; r++) {
      let acc = 0;
      for (let c = 0; c < dim; c++) {
        acc += value(r * dim + c);
        table[(r + 1) * W + c + 1] = table[r * W + c + 1] + acc;
      }
    }
  };
  const rect = (table, r, c) => {
    const r0 = Math.max(0, r - R) * W;
    const r1 = Math.min(dim, r + R + 1) * W;
    const c0 = Math.max(0, c - R);
    const c1 = Math.min(dim, c + R + 1);
    return table[r1 + c1] - table[r0 + c1] - table[r1 + c0] + table[r0 + c0];
  };
  const area = (r, c) => (Math.min(dim, r + R + 1) - Math.max(0, r - R)) * (Math.min(dim, c + R + 1) - Math.max(0, c - R));
  const sum = new Float64Array(W * W);
  integral(sum, (q) => vals[q]);
  const mean = new Float32Array(dim * dim);
  for (let r = 0; r < dim; r++) for (let c = 0; c < dim; c++) mean[r * dim + c] = rect(sum, r, c) / area(r, c);
  const darkSum = new Float64Array(W * W);
  const darkCnt = new Float64Array(W * W);
  integral(darkSum, (q) => (vals[q] < mean[q] ? vals[q] : 0));
  integral(darkCnt, (q) => (vals[q] < mean[q] ? 1 : 0));
  const modules = new Uint8Array(dim * dim);
  for (let r = 0; r < dim; r++) {
    for (let c = 0; c < dim; c++) {
      const q = r * dim + c;
      const n = area(r, c);
      const ds = rect(darkSum, r, c);
      const dc = rect(darkCnt, r, c);
      const t = dc > 0 && dc < n ? (ds / dc + (rect(sum, r, c) - ds) / (n - dc)) / 2 : mean[q];
      modules[q] = vals[q] < t ? 1 : 0;
    }
  }
  return modules;
}

// Эквалайзер в пространстве модулей: размытие подмешивает к модулю соседей, подъём
// отличия от среднего четырёх соседей частично это компенсирует.
function sharpenGrid(vals, dim, beta) {
  const out = new Float32Array(vals.length);
  for (let r = 0; r < dim; r++) {
    for (let c = 0; c < dim; c++) {
      const q = r * dim + c;
      let s = 0;
      let n = 0;
      if (r > 0) { s += vals[q - dim]; n++; }
      if (r < dim - 1) { s += vals[q + dim]; n++; }
      if (c > 0) { s += vals[q - 1]; n++; }
      if (c < dim - 1) { s += vals[q + 1]; n++; }
      out[q] = vals[q] + beta * (vals[q] - s / n);
    }
  }
  return out;
}

// Выборка по бинарному изображению (запасной вариант, как в классических декодерах).
function sampleBinary(ctx, H, dim) {
  const { bits, w, h } = ctx;
  const modules = new Uint8Array(dim * dim);
  for (let r = 0; r < dim; r++) {
    for (let c = 0; c < dim; c++) {
      const [X, Y] = project(H, c + 0.5, r + 0.5);
      const x = Math.min(w - 1, Math.max(0, Math.floor(X)));
      const y = Math.min(h - 1, Math.max(0, Math.floor(Y)));
      modules[r * dim + c] = bits[y * w + x];
    }
  }
  return modules;
}

// Начальная гомография: три центра искателей и перспективная оценка четвёртого угла.
function cornerHomography(g, dim) {
  return fitHomography([[3.5, 3.5], [dim - 3.5, 3.5], [3.5, dim - 3.5], [dim - 3.5, dim - 3.5]],
    [[g.tl.x, g.tl.y], [g.tr.x, g.tr.y], [g.bl.x, g.bl.y], [g.br.x, g.br.y]]);
}

// Сетка по искателям и выравнивающим узорам: сначала правый нижний (поиск в широком
// окне), затем для версий ≥ 7 все остальные с МНК-подгонкой в два прохода.
// Возвращает гомографии от лучшей к запасной.
function gridHomographies(ctx, g, dim) {
  const version = (dim - 17) / 4;
  const src = [[3.5, 3.5], [dim - 3.5, 3.5], [3.5, dim - 3.5]];
  const dst = [[g.tl.x, g.tl.y], [g.tr.x, g.tr.y], [g.bl.x, g.bl.y]];
  const h0 = cornerHomography(g, dim);
  if (!h0) return [];
  if (version < 2) return [h0];
  const minContrast = 0.22 * g.contrast;
  const pos = alignmentPositions(version);
  const last = pos.length - 1;
  const am = pos[last] + 0.5;
  let br = locateAlignment(ctx, h0, am, am, 4, minContrast);
  if (!br && ctx.tryHarder) br = locateAlignment(ctx, h0, am, am, 7, minContrast);
  let h1 = h0;
  const ms = src.slice();
  const md = dst.slice();
  if (br) {
    ms.push([am, am]);
    md.push([br.x, br.y]);
    h1 = fitHomography(ms, md) || h0;
  }
  const result = [];
  if (version >= 7) {
    // Остальные выравнивающие узоры уточняют перспективу по всей площади символа.
    let H = h1;
    const total = (last + 1) * (last + 1) - 4;
    for (let pass = 0; pass < 2; pass++) {
      const ps = ms.slice();
      const pd = md.slice();
      for (let i = 0; i <= last; i++) {
        for (let j = 0; j <= last; j++) {
          if ((i === 0 && (j === 0 || j === last)) || (i === last && j === 0) || (i === last && j === last)) continue;
          const a = locateAlignment(ctx, H, pos[j] + 0.5, pos[i] + 0.5, br ? 2 : 3, minContrast);
          if (a) {
            ps.push([pos[j] + 0.5, pos[i] + 0.5]);
            pd.push([a.x, a.y]);
          }
        }
      }
      // Почти ничего не нашлось — гипотеза сетки, скорее всего, неверна; не тратим время.
      if (ps.length < 6 || ps.length - ms.length < 0.3 * total) break;
      const fitted = robustFit(ps, pd);
      if (!fitted) break;
      H = fitted;
    }
    if (H !== h1) result.push(H);
  }
  result.push(h1);
  if (h1 !== h0) result.push(h0);
  return result;
}

// МНК с отбрасыванием выбросов (неверно найденных узоров; искатели не отбрасываются).
function robustFit(src, dst) {
  let ps = src.slice();
  let pd = dst.slice();
  let H = fitHomography(ps, pd);
  for (let iter = 0; iter < 3 && H; iter++) {
    let worst = -1;
    let worstErr = 0;
    for (let k = 3; k < ps.length; k++) {
      const [X, Y] = project(H, ps[k][0], ps[k][1]);
      const J = jacobian(H, ps[k][0], ps[k][1]);
      const ms = Math.sqrt(Math.abs(J.ux * J.vy - J.uy * J.vx));
      const err = Math.hypot(X - pd[k][0], Y - pd[k][1]) / ms;
      if (err > 0.35 && err > worstErr) {
        worstErr = err;
        worst = k;
      }
    }
    if (worst < 0) break;
    ps = ps.filter((_, k) => k !== worst);
    pd = pd.filter((_, k) => k !== worst);
    if (ps.length < 4) return null;
    H = fitHomography(ps, pd);
  }
  return H;
}

// ===================== Поиск в кадре =====================

function scanFrame(ctx) {
  const cands = findFinders(ctx, 1);
  ctx.smallSeen = cands.some((c) => c.ms < 4.5 && c.ms >= 1.8);
  if (cands.length < 3) return null;
  const triples = rankTriples(cands, ctx.tryHarder ? 4 : 2);
  for (const t of triples) {
    if (ctx.budget.left <= 0) break;
    const res = decodeTriple(ctx, t);
    if (res) return res;
  }
  return null;
}

// Доля модулей линий синхронизации (строка и столбец 6), совпавших с чередованием.
// Дешёвая проверка гипотезы «размерность + гомография» до дорогого подбора сетки:
// у неверной гипотезы совпадает около половины.
// Строка и столбец проверяются с поперечными сдвигами ±0.4 модуля (берётся лучший):
// начальная гомография без выравнивающих узоров может немного промахиваться.
function timingAgreement(ctx, H, dim) {
  const { gray, w, h } = ctx;
  const n = dim - 16;
  const line = new Float32Array(n);
  let total = 0;
  for (let axis = 0; axis < 2; axis++) {
    let best = 0;
    for (const off of [0, -0.4, 0.4]) {
      for (let i = 0; i < n; i++) {
        const [x, y] = axis === 0 ? project(H, 8.5 + i, 6.5 + off) : project(H, 6.5 + off, 8.5 + i);
        line[i] = sample(gray, w, h, x, y);
      }
      // Тёмный модуль должен быть темнее среднего двух соседей (порог не нужен).
      let good = 0;
      for (let i = 0; i < n; i++) {
        const prev = i > 0 ? line[i - 1] : line[i + 1];
        const next = i < n - 1 ? line[i + 1] : line[i - 1];
        if ((line[i] < (prev + next) / 2) === (i % 2 === 0)) good++;
      }
      best = Math.max(best, good);
    }
    total += best;
  }
  return total / (2 * n);
}

function decodeTriple(ctx, t) {
  const { tl, tr, bl } = orient(t.a, t.b, t.c);
  const g = refineTriple(ctx, tl, tr, bl);
  for (const { dim, trusted } of dimensionCandidates(ctx, g)) {
    if (!trusted && dim > 25) {
      const h0 = cornerHomography(g, dim);
      if (!h0 || timingAgreement(ctx, h0, dim) < 0.8) continue;
    }
    if (ctx.budget.left-- <= 0) return null;
    for (const H of gridHomographies(ctx, g, dim)) {
      const vals = sampleGrid(ctx, H, dim);
      let res = decodeModules(thresholdGrid(vals, dim), dim);
      // Размытие смешивает соседние модули; подъём отличия от соседей частично это
      // компенсирует (эквалайзер в пространстве модулей): сначала мягко, затем сильнее.
      if (!res && ctx.tryHarder) res = decodeModules(thresholdGrid(sharpenGrid(vals, dim, 0.7), dim), dim);
      if (!res && ctx.tryHarder) res = decodeModules(thresholdGrid(sharpenGrid(vals, dim, 1.6), dim), dim);
      if (!res && ctx.tryHarder) res = decodeModules(sampleBinary(ctx, H, dim), dim);
      if (res) return res;
    }
  }
  return null;
}
