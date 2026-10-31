// Общая часть кодера и декодера QR (ISO/IEC 18004): таблицы версий и блоков,
// форматная/версионная информация, карта служебных модулей, порядок обхода
// данных, маски, арифметика GF(256) и код Рида–Соломона.
// Модуль без состояния: все таблицы вычисляются один раз при загрузке и не меняются.

export const ALNUM_CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

export const ECL_LIST = ['L', 'M', 'Q', 'H'];
// Двухбитный индикатор уровня коррекции в форматной информации.
export const ECL_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

export const MODE_BITS = { numeric: 1, alphanumeric: 2, byte: 4, kanji: 8 };

// Кодовых слов коррекции на один блок, [уровень][версия] (индекс 0 не используется).
const ECC_PER_BLOCK = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28,
    28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
    26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30,
    28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28,
    30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};

// Число блоков Рида–Соломона, [уровень][версия].
const NUM_BLOCKS = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8,
    8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
    17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20,
    23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25,
    25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};

export function isValidEcl(ecl) {
  return ecl === 'L' || ecl === 'M' || ecl === 'Q' || ecl === 'H';
}

export function sizeForVersion(version) {
  return version * 4 + 17;
}

// Число модулей, отведённых под данные и коррекцию (всё, кроме служебных узоров).
export function rawDataModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

// Структура блоков: короткие блоки идут первыми, длинные содержат на одно слово данных больше.
export function blockInfo(version, ecl) {
  const numBlocks = NUM_BLOCKS[ecl][version];
  const eccPerBlock = ECC_PER_BLOCK[ecl][version];
  const totalCodewords = Math.floor(rawDataModules(version) / 8);
  const numLong = totalCodewords % numBlocks;
  const shortTotal = Math.floor(totalCodewords / numBlocks);
  const shortData = shortTotal - eccPerBlock;
  const dataLengths = [];
  for (let i = 0; i < numBlocks; i++) dataLengths.push(i < numBlocks - numLong ? shortData : shortData + 1);
  return {
    numBlocks,
    eccPerBlock,
    totalCodewords,
    dataCodewords: totalCodewords - eccPerBlock * numBlocks,
    dataLengths,
  };
}

export function dataCodewordCount(version, ecl) {
  return Math.floor(rawDataModules(version) / 8) - ECC_PER_BLOCK[ecl][version] * NUM_BLOCKS[ecl][version];
}

// Центры выравнивающих узоров по одной оси (одинаковы для строк и столбцов).
export function alignmentPositions(version) {
  if (version === 1) return [];
  const size = sizeForVersion(version);
  const numAlign = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

export function charCountBits(mode, version) {
  const range = version <= 9 ? 0 : version <= 26 ? 1 : 2;
  switch (mode) {
    case 'numeric': return [10, 12, 14][range];
    case 'alphanumeric': return [9, 11, 13][range];
    case 'byte': return [8, 16, 16][range];
    case 'kanji': return [8, 10, 12][range];
    default: throw new Error(`QR: неизвестный режим ${mode}`);
  }
}

// --- Форматная и версионная информация (коды БЧХ) ---

export function formatBits(ecl, mask) {
  const data = (ECL_FORMAT_BITS[ecl] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | (rem & 0x3ff)) ^ 0x5412;
}

export function versionBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | (rem & 0xfff);
}

// Все 32 допустимых форматных слова: { bits, ecl, mask }.
export const FORMAT_CODES = Object.freeze(ECL_LIST.flatMap((ecl) =>
  [0, 1, 2, 3, 4, 5, 6, 7].map((mask) => Object.freeze({ bits: formatBits(ecl, mask), ecl, mask }))));

// Версионные слова для версий 7..40.
export const VERSION_CODES = Object.freeze(Array.from({ length: 34 }, (_, i) =>
  Object.freeze({ bits: versionBits(i + 7), version: i + 7 })));

export function popcount(x) {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return Math.imul(x, 0x01010101) >>> 24;
}

// Ближайшая допустимая форматная информация к считанным копиям (минимум расстояния Хэмминга).
export function decodeFormatBits(copies) {
  let best = null;
  let bestDist = 99;
  for (const code of FORMAT_CODES) {
    for (const raw of copies) {
      const d = popcount(code.bits ^ raw);
      if (d < bestDist) {
        bestDist = d;
        best = code;
      }
    }
  }
  return bestDist <= 3 ? { ecl: best.ecl, mask: best.mask, distance: bestDist } : null;
}

export function decodeVersionBits(copies) {
  let best = 0;
  let bestDist = 99;
  for (const code of VERSION_CODES) {
    for (const raw of copies) {
      const d = popcount(code.bits ^ raw);
      if (d < bestDist) {
        bestDist = d;
        best = code.version;
      }
    }
  }
  return bestDist <= 3 ? { version: best, distance: bestDist } : null;
}

// Координаты битов форматной информации: бит i → [строка, столбец] для двух копий.
export function formatPositions(size) {
  const first = [];
  const second = [];
  for (let i = 0; i < 15; i++) {
    if (i <= 5) first.push([i, 8]);
    else if (i === 6) first.push([7, 8]);
    else if (i === 7) first.push([8, 8]);
    else if (i === 8) first.push([8, 7]);
    else first.push([8, 14 - i]);
    if (i < 8) second.push([8, size - 1 - i]);
    else second.push([size - 15 + i, 8]);
  }
  return [first, second];
}

// Координаты битов версионной информации (бит i): блок справа сверху и слева снизу.
export function versionPositions(size) {
  const topRight = [];
  const bottomLeft = [];
  for (let i = 0; i < 18; i++) {
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    topRight.push([b, a]);
    bottomLeft.push([a, b]);
  }
  return [topRight, bottomLeft];
}

// --- Карта служебных модулей и порядок размещения данных ---

// 1 — служебный модуль (искатели с разделителями, синхронизация, выравнивание,
// форматная и версионная информация, тёмный модуль), 0 — область данных.
export function functionModuleMap(version) {
  const size = sizeForVersion(version);
  const map = new Uint8Array(size * size);
  const fill = (r0, c0, h, w) => {
    for (let r = Math.max(0, r0); r < Math.min(size, r0 + h); r++) {
      for (let c = Math.max(0, c0); c < Math.min(size, c0 + w); c++) map[r * size + c] = 1;
    }
  };
  // Искатели вместе с разделителями и областями форматной информации (9×9 / 9×8 / 8×9).
  fill(0, 0, 9, 9);
  fill(0, size - 8, 9, 8);
  fill(size - 8, 0, 8, 9);
  // Линии синхронизации.
  fill(6, 0, 1, size);
  fill(0, 6, size, 1);
  const pos = alignmentPositions(version);
  const last = pos.length - 1;
  for (let i = 0; i <= last; i++) {
    for (let j = 0; j <= last; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      fill(pos[i] - 2, pos[j] - 2, 5, 5);
    }
  }
  if (version >= 7) {
    fill(0, size - 11, 6, 3);
    fill(size - 11, 0, 3, 6);
  }
  return map;
}

// Индексы модулей данных в порядке размещения битов (зигзаг снизу справа, пары столбцов).
export function dataModuleOrder(version, functionMap = functionModuleMap(version)) {
  const size = sizeForVersion(version);
  const order = new Int32Array(rawDataModules(version));
  let k = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let vert = 0; vert < size; vert++) {
      const r = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const idx = r * size + right - j;
        if (!functionMap[idx]) order[k++] = idx;
      }
    }
  }
  if (k !== order.length) throw new Error('QR: внутренняя ошибка обхода модулей');
  return order;
}

// Условие инвертирования модуля маской (r — строка, c — столбец).
export function maskBit(mask, r, c) {
  switch (mask) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: throw new Error(`QR: неверная маска ${mask}`);
  }
}

// --- GF(256) с примитивным многочленом x^8 + x^4 + x^3 + x^2 + 1 (0x11D) ---

export const GF_EXP = new Uint8Array(512);
export const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}

export function gfMul(a, b) {
  return a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

export function gfDiv(a, b) {
  if (b === 0) throw new Error('GF(256): деление на ноль');
  return a === 0 ? 0 : GF_EXP[GF_LOG[a] + 255 - GF_LOG[b]];
}

export function gfInv(a) {
  if (a === 0) throw new Error('GF(256): обратный к нулю');
  return GF_EXP[255 - GF_LOG[a]];
}

// --- Рида–Соломона: порождающий многочлен ∏(x − α^i), i = 0..n−1 ---

// Коэффициенты от старшей степени к младшей, старший (=1) опущен: длина n.
export function rsGenerator(degree) {
  const poly = new Uint8Array(degree);
  poly[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    // Умножаем текущий многочлен на (x − root).
    for (let j = 0; j < degree; j++) {
      poly[j] = gfMul(poly[j], root);
      if (j + 1 < degree) poly[j] ^= poly[j + 1];
    }
    root = gfMul(root, 2);
  }
  return poly;
}

// Остаток от деления data(x)·x^n на порождающий многочлен — кодовые слова коррекции.
export function rsEncode(data, eccLen, generator = rsGenerator(eccLen)) {
  const result = new Uint8Array(eccLen);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ result[0];
    result.copyWithin(0, 1);
    result[eccLen - 1] = 0;
    if (factor !== 0) {
      const lf = GF_LOG[factor];
      for (let j = 0; j < eccLen; j++) {
        const g = generator[j];
        if (g !== 0) result[j] ^= GF_EXP[lf + GF_LOG[g]];
      }
    }
  }
  return result;
}

// Синдромы S_j = r(α^j), j = 0..n−1; кодовое слово — старшая степень первой.
function syndromes(codeword, eccLen) {
  const s = new Uint8Array(eccLen);
  let nonZero = false;
  for (let j = 0; j < eccLen; j++) {
    let acc = 0;
    for (let i = 0; i < codeword.length; i++) {
      acc = (acc === 0 ? 0 : GF_EXP[GF_LOG[acc] + j]) ^ codeword[i];
    }
    s[j] = acc;
    if (acc !== 0) nonZero = true;
  }
  return nonZero ? s : null;
}

// Исправляет ошибки на месте. Возвращает число исправленных байтов или −1, если
// ошибок больше, чем код способен исправить (в этом случае codeword не меняется).
// Синдромы → Берлекэмп–Мэсси → поиск Ченя → алгоритм Форни.
export function rsDecode(codeword, eccLen) {
  const n = codeword.length;
  const s = syndromes(codeword, eccLen);
  if (!s) return 0;

  // Берлекэмп–Мэсси: многочлен локаторов Λ(x), коэффициенты от младшей степени.
  let lambda = new Uint8Array(eccLen + 1);
  let prev = new Uint8Array(eccLen + 1);
  lambda[0] = 1;
  prev[0] = 1;
  let L = 0;
  let m = 1;
  let b = 1;
  for (let k = 0; k < eccLen; k++) {
    let d = s[k];
    for (let i = 1; i <= L; i++) d ^= gfMul(lambda[i], s[k - i]);
    if (d === 0) {
      m++;
      continue;
    }
    const coef = gfDiv(d, b);
    if (2 * L <= k) {
      const saved = lambda.slice();
      for (let i = 0; i + m <= eccLen; i++) lambda[i + m] ^= gfMul(coef, prev[i]);
      L = k + 1 - L;
      prev = saved;
      b = d;
      m = 1;
    } else {
      for (let i = 0; i + m <= eccLen; i++) lambda[i + m] ^= gfMul(coef, prev[i]);
      m++;
    }
  }
  if (L === 0 || 2 * L > eccLen) return -1;

  // Ω(x) = S(x)·Λ(x) mod x^n.
  const omega = new Uint8Array(eccLen);
  for (let i = 0; i < eccLen; i++) {
    let acc = 0;
    for (let j = 0; j <= Math.min(i, L); j++) acc ^= gfMul(lambda[j], s[i - j]);
    omega[i] = acc;
  }

  // Поиск Ченя: позиция p (степень x) ошибочна, если Λ(α^−p) = 0.
  const positions = [];
  const magnitudes = [];
  for (let p = 0; p < n; p++) {
    const xInvLog = (255 - p) % 255;
    let val = 0;
    for (let i = L; i >= 0; i--) val = (val === 0 ? 0 : GF_EXP[GF_LOG[val] + xInvLog]) ^ lambda[i];
    if (val !== 0) continue;
    // Форни (первый корень α^0): e = X·Ω(X^−1) / Λ'(X^−1).
    let num = 0;
    for (let i = eccLen - 1; i >= 0; i--) num = (num === 0 ? 0 : GF_EXP[GF_LOG[num] + xInvLog]) ^ omega[i];
    let den = 0;
    for (let i = 1; i <= L; i += 2) {
      if (lambda[i] !== 0) den ^= GF_EXP[GF_LOG[lambda[i]] + ((xInvLog * (i - 1)) % 255)];
    }
    if (den === 0) return -1;
    const e = gfMul(GF_EXP[p % 255], gfDiv(num, den));
    positions.push(n - 1 - p);
    magnitudes.push(e);
  }
  if (positions.length !== L) return -1;

  const fixed = codeword.slice();
  for (let i = 0; i < positions.length; i++) fixed[positions[i]] ^= magnitudes[i];
  // Контроль: после исправления все синдромы обязаны обнулиться, иначе это отказ, а не «мусор».
  if (syndromes(fixed, eccLen)) return -1;
  codeword.set(fixed);
  return positions.length;
}
