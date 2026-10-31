// Генератор QR-кодов (ISO/IEC 18004): один сегмент в самом компактном режиме,
// наименьшая подходящая версия, выбор маски по штрафным правилам.

import {
  ALNUM_CHARSET,
  MODE_BITS,
  alignmentPositions,
  blockInfo,
  charCountBits,
  dataCodewordCount,
  dataModuleOrder,
  formatBits,
  formatPositions,
  functionModuleMap,
  isValidEcl,
  maskBit,
  rsEncode,
  rsGenerator,
  sizeForVersion,
  versionBits,
  versionPositions,
} from './qr-common.js';

const MODES = ['numeric', 'alphanumeric', 'byte'];

function checkVersion(v, name) {
  if (!Number.isInteger(v) || v < 1 || v > 40) throw new Error(`QR: ${name} должна быть целым от 1 до 40`);
}

/**
 * Ёмкость одного сегмента.
 * @param {number} version 1..40
 * @param {'L'|'M'|'Q'|'H'} ecl
 * @param {'numeric'|'alphanumeric'|'byte'} mode
 * @returns {number} максимум символов (для byte — байтов).
 */
export function qrCapacity(version, ecl, mode) {
  checkVersion(version, 'версия');
  if (!isValidEcl(ecl)) throw new Error(`QR: неизвестный уровень коррекции ${ecl}`);
  if (!MODES.includes(mode)) throw new Error(`QR: неизвестный режим ${mode}`);
  const ccBits = charCountBits(mode, version);
  const avail = dataCodewordCount(version, ecl) * 8 - 4 - ccBits;
  if (avail < 0) return 0;
  let n;
  if (mode === 'numeric') {
    const rest = avail % 10;
    n = Math.floor(avail / 10) * 3 + (rest >= 7 ? 2 : rest >= 4 ? 1 : 0);
  } else if (mode === 'alphanumeric') {
    n = Math.floor(avail / 11) * 2 + (avail % 11 >= 6 ? 1 : 0);
  } else {
    n = Math.floor(avail / 8);
  }
  return Math.min(n, 2 ** ccBits - 1);
}

function chooseMode(text) {
  if (/^[0-9]*$/.test(text)) return 'numeric';
  let alnum = true;
  for (let i = 0; i < text.length; i++) {
    if (ALNUM_CHARSET.indexOf(text[i]) < 0) {
      alnum = false;
      break;
    }
  }
  return alnum ? 'alphanumeric' : 'byte';
}

function payloadBits(mode, count) {
  if (mode === 'numeric') return Math.floor(count / 3) * 10 + [0, 4, 7][count % 3];
  if (mode === 'alphanumeric') return Math.floor(count / 2) * 11 + (count % 2) * 6;
  return count * 8;
}

class BitWriter {
  constructor(byteLength) {
    this.bytes = new Uint8Array(byteLength);
    this.length = 0;
  }

  write(value, bits) {
    for (let i = bits - 1; i >= 0; i--) {
      if ((value >>> i) & 1) this.bytes[this.length >>> 3] |= 0x80 >>> (this.length & 7);
      this.length++;
    }
  }
}

// Поток данных: режим, счётчик, полезная нагрузка, терминатор, добивка до байта и 0xEC/0x11.
function buildDataCodewords(mode, text, bytes, version, ecl) {
  const capacityBytes = dataCodewordCount(version, ecl);
  const w = new BitWriter(capacityBytes);
  const count = mode === 'byte' ? bytes.length : text.length;
  w.write(MODE_BITS[mode], 4);
  w.write(count, charCountBits(mode, version));
  if (mode === 'numeric') {
    for (let i = 0; i < count; i += 3) {
      const chunk = text.slice(i, i + 3);
      w.write(Number(chunk), chunk.length * 3 + 1);
    }
  } else if (mode === 'alphanumeric') {
    for (let i = 0; i < count; i += 2) {
      const a = ALNUM_CHARSET.indexOf(text[i]);
      if (i + 1 < count) w.write(a * 45 + ALNUM_CHARSET.indexOf(text[i + 1]), 11);
      else w.write(a, 6);
    }
  } else {
    for (let i = 0; i < count; i++) w.write(bytes[i], 8);
  }
  const capacityBits = capacityBytes * 8;
  w.write(0, Math.min(4, capacityBits - w.length));
  w.length = Math.ceil(w.length / 8) * 8;
  for (let pad = 0xec; w.length < capacityBits; pad ^= 0xec ^ 0x11) w.write(pad, 8);
  return w.bytes;
}

// Разбиение на блоки, коды коррекции и чередование: сначала данные по столбцам, затем ECC.
function interleave(data, version, ecl) {
  const info = blockInfo(version, ecl);
  const gen = rsGenerator(info.eccPerBlock);
  const blocks = [];
  let offset = 0;
  for (const len of info.dataLengths) {
    const block = data.subarray(offset, offset + len);
    blocks.push({ data: block, ecc: rsEncode(block, info.eccPerBlock, gen) });
    offset += len;
  }
  const out = new Uint8Array(info.totalCodewords);
  let k = 0;
  const maxData = info.dataLengths[info.dataLengths.length - 1];
  for (let i = 0; i < maxData; i++) {
    for (const b of blocks) if (i < b.data.length) out[k++] = b.data[i];
  }
  for (let i = 0; i < info.eccPerBlock; i++) {
    for (const b of blocks) out[k++] = b.ecc[i];
  }
  return out;
}

// Служебные узоры, не зависящие от маски: искатели, синхронизация, выравнивание.
// Области форматной/версионной информации и тёмный модуль пока светлые.
function drawFixedPatterns(modules, version) {
  const size = sizeForVersion(version);
  const set = (r, c, v) => { modules[r * size + c] = v ? 1 : 0; };
  const finder = (r0, c0) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = r0 + dr;
        const c = c0 + dc;
        if (r < 0 || c < 0 || r >= size || c >= size) continue;
        const ring = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
        set(r, c, ring !== 2 && ring !== 4);
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);
  for (let i = 8; i < size - 8; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  const pos = alignmentPositions(version);
  const last = pos.length - 1;
  for (let i = 0; i <= last; i++) {
    for (let j = 0; j <= last; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          set(pos[i] + dr, pos[j] + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
  }
}

function drawFormatAndVersion(modules, version, ecl, mask) {
  const size = sizeForVersion(version);
  const fmt = formatBits(ecl, mask);
  for (const copy of formatPositions(size)) {
    copy.forEach(([r, c], i) => { modules[r * size + c] = (fmt >>> i) & 1; });
  }
  modules[(size - 8) * size + 8] = 1;
  if (version >= 7) {
    const ver = versionBits(version);
    for (const copy of versionPositions(size)) {
      copy.forEach(([r, c], i) => { modules[r * size + c] = (ver >>> i) & 1; });
    }
  }
}

// Число вхождений 1011101 со светлой полосой в 4 модуля хотя бы с одной стороны.
// Обход повторяет эталон (segno): после засчитанного узора поиск продолжается
// с его конца, после незасчитанного — с центральной тройки; за краем символа — свет.
function finderLikePenalty(line, size) {
  let score = 0;
  let from = 0;
  for (;;) {
    let idx = -1;
    for (let i = from; i + 7 <= size; i++) {
      if (line[i] && !line[i + 1] && line[i + 2] && line[i + 3] && line[i + 4] && !line[i + 5] && line[i + 6]) {
        idx = i;
        break;
      }
    }
    if (idx < 0) return score;
    let lightBefore = true;
    for (let i = Math.max(idx - 4, 0); i < idx; i++) if (line[i]) { lightBefore = false; break; }
    let lightAfter = true;
    for (let i = idx + 7; i < Math.min(idx + 11, size); i++) if (line[i]) { lightAfter = false; break; }
    if (lightBefore || lightAfter) {
      score += 40;
      from = idx + 7;
    } else {
      from = idx + 4;
    }
  }
}

// Штраф маски (N1..N4 из ISO/IEC 18004, табл. 11). Оценивается до записи
// форматной и версионной информации (их области светлые), как в эталонном кодере.
function maskPenalty(m, size) {
  let score = 0;
  let dark = 0;
  const row = new Uint8Array(size);
  const col = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    let runRow = 0;
    let runCol = 0;
    let prevRow = -1;
    let prevCol = -1;
    for (let j = 0; j < size; j++) {
      const a = m[i * size + j];
      const b = m[j * size + i];
      row[j] = a;
      col[j] = b;
      dark += a;
      if (a === prevRow) runRow++;
      else {
        if (runRow >= 5) score += runRow - 2;
        runRow = 1;
        prevRow = a;
      }
      if (b === prevCol) runCol++;
      else {
        if (runCol >= 5) score += runCol - 2;
        runCol = 1;
        prevCol = b;
      }
      if (i > 0 && j > 0 && a === m[i * size + j - 1] && a === m[(i - 1) * size + j] &&
        a === m[(i - 1) * size + j - 1]) score += 3;
    }
    if (runRow >= 5) score += runRow - 2;
    if (runCol >= 5) score += runCol - 2;
    score += finderLikePenalty(row, size) + finderLikePenalty(col, size);
  }
  const percent = dark / (size * size);
  score += 10 * Math.trunc(Math.abs(percent * 100 - 50) / 5);
  return score;
}

function applyMask(base, out, order, mask, size) {
  out.set(base);
  for (let k = 0; k < order.length; k++) {
    const idx = order[k];
    const r = Math.floor(idx / size);
    if (maskBit(mask, r, idx - r * size)) out[idx] ^= 1;
  }
}

/**
 * Строит QR-код: один сегмент в самом компактном режиме, способном закодировать всю
 * строку (numeric → alphanumeric → byte в UTF-8), наименьшая версия из
 * [minVersion, maxVersion]; маска — заданная или (mask = −1) с наименьшим штрафом.
 * @param {string} text
 * @param {{ecl?: 'L'|'M'|'Q'|'H', minVersion?: number, maxVersion?: number, mask?: number}} [options]
 * @returns {{version: number, size: number, ecl: string, mask: number, modules: Uint8Array}}
 *   modules — size×size построчно, 1 = тёмный модуль (без тихой зоны).
 * @throws {Error} если данные не помещаются или параметры неверны.
 */
export function encodeQR(text, { ecl = 'M', minVersion = 1, maxVersion = 40, mask = -1 } = {}) {
  if (typeof text !== 'string') throw new Error('QR: текст должен быть строкой');
  if (!isValidEcl(ecl)) throw new Error(`QR: неизвестный уровень коррекции ${ecl}`);
  checkVersion(minVersion, 'minVersion');
  checkVersion(maxVersion, 'maxVersion');
  if (minVersion > maxVersion) throw new Error('QR: minVersion больше maxVersion');
  if (!Number.isInteger(mask) || mask < -1 || mask > 7) throw new Error('QR: маска должна быть от −1 до 7');

  const mode = chooseMode(text);
  const bytes = mode === 'byte' ? new TextEncoder().encode(text) : null;
  const count = mode === 'byte' ? bytes.length : text.length;
  let version = 0;
  for (let v = minVersion; v <= maxVersion; v++) {
    const cc = charCountBits(mode, v);
    if (count < 2 ** cc && 4 + cc + payloadBits(mode, count) <= dataCodewordCount(v, ecl) * 8) {
      version = v;
      break;
    }
  }
  if (!version) {
    throw new Error(`QR: данные (${count} ${mode === 'byte' ? 'байт' : 'символов'}, режим ${mode}) ` +
      `не помещаются в версии ${minVersion}–${maxVersion} с уровнем ${ecl}`);
  }

  const size = sizeForVersion(version);
  const codewords = interleave(buildDataCodewords(mode, text, bytes, version, ecl), version, ecl);
  const base = new Uint8Array(size * size);
  drawFixedPatterns(base, version);
  const order = dataModuleOrder(version, functionModuleMap(version));
  // Биты кодовых слов по порядку обхода; остаточные модули остаются нулевыми и маскируются.
  for (let i = 0; i < codewords.length * 8; i++) {
    base[order[i]] = (codewords[i >>> 3] >>> (7 - (i & 7))) & 1;
  }

  const modules = new Uint8Array(size * size);
  let chosen = mask;
  if (chosen < 0) {
    let best = Infinity;
    for (let mk = 0; mk < 8; mk++) {
      applyMask(base, modules, order, mk, size);
      const p = maskPenalty(modules, size);
      if (p < best) {
        best = p;
        chosen = mk;
      }
    }
  }
  applyMask(base, modules, order, chosen, size);
  drawFormatAndVersion(modules, version, ecl, chosen);
  return { version, size, ecl, mask: chosen, modules };
}
