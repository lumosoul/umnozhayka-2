// DEFLATE (RFC 1951) без обёртки zlib: сжатие для кода и QR и распаковка при импорте.
// Своя реализация: без CompressionStream и сторонних библиотек, одинаково во всех браузерах и в Node.

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
/** Порядок длин кодов «длин кодов» в заголовке динамического блока. */
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

const FIXED_LIT_LENGTHS = (() => {
  const l = new Uint8Array(288);
  l.fill(8, 0, 144);
  l.fill(9, 144, 256);
  l.fill(7, 256, 280);
  l.fill(8, 280, 288);
  return l;
})();
const FIXED_DIST_LENGTHS = new Uint8Array(30).fill(5);

// ---------------------------------------------------------------- распаковка

class BitReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.pos = 0;
    this.buf = 0;
    this.cnt = 0;
  }

  bits(n) {
    while (this.cnt < n) {
      if (this.pos >= this.bytes.length) throw new Error('Данные оборваны');
      this.buf |= this.bytes[this.pos++] << this.cnt;
      this.cnt += 8;
    }
    const v = this.buf & ((1 << n) - 1);
    this.buf >>>= n;
    this.cnt -= n;
    return v;
  }

  /** Остаток текущего байта отбрасываем (перед несжатым блоком). */
  align() {
    this.buf = 0;
    this.cnt = 0;
  }
}

/** Таблица канонического кода Хаффмана: число кодов каждой длины и символы по порядку. */
function buildDecoder(lengths) {
  const counts = new Uint16Array(16);
  for (let i = 0; i < lengths.length; i++) counts[lengths[i]]++;
  counts[0] = 0;
  let left = 1;
  for (let len = 1; len <= 15; len++) {
    left = (left << 1) - counts[len];
    if (left < 0) throw new Error('Неверный код Хаффмана');
  }
  const offs = new Uint16Array(16);
  for (let len = 1; len < 15; len++) offs[len + 1] = offs[len] + counts[len];
  const symbols = new Uint16Array(lengths.length);
  for (let i = 0; i < lengths.length; i++) if (lengths[i]) symbols[offs[lengths[i]]++] = i;
  return { counts, symbols };
}

function decodeSymbol(br, h) {
  let code = 0;
  let first = 0;
  let index = 0;
  for (let len = 1; len <= 15; len++) {
    code |= br.bits(1);
    const count = h.counts[len];
    if (code - first < count) return h.symbols[index + code - first];
    index += count;
    first = (first + count) << 1;
    code <<= 1;
  }
  throw new Error('Неверный код в данных');
}

let fixedDecoders = null;

function readDynamicDecoders(br) {
  const hlit = br.bits(5) + 257;
  const hdist = br.bits(5) + 1;
  const hclen = br.bits(4) + 4;
  if (hlit > 286 || hdist > 30) throw new Error('Неверный заголовок блока');
  const clLengths = new Uint8Array(19);
  for (let i = 0; i < hclen; i++) clLengths[CL_ORDER[i]] = br.bits(3);
  const cl = buildDecoder(clLengths);
  const lengths = new Uint8Array(hlit + hdist);
  for (let i = 0; i < lengths.length;) {
    const sym = decodeSymbol(br, cl);
    if (sym < 16) {
      lengths[i++] = sym;
      continue;
    }
    let value = 0;
    let repeat;
    if (sym === 16) {
      if (i === 0) throw new Error('Повтор без предыдущей длины');
      value = lengths[i - 1];
      repeat = 3 + br.bits(2);
    } else if (sym === 17) {
      repeat = 3 + br.bits(3);
    } else {
      repeat = 11 + br.bits(7);
    }
    if (i + repeat > lengths.length) throw new Error('Слишком много длин кодов');
    lengths.fill(value, i, i + repeat);
    i += repeat;
  }
  if (!lengths[256]) throw new Error('Нет кода конца блока');
  return [buildDecoder(lengths.subarray(0, hlit)), buildDecoder(lengths.subarray(hlit))];
}

export function inflateRaw(input, { maxOutput = 64 * 1024 * 1024 } = {}) {
  const br = new BitReader(input);
  let out = new Uint8Array(Math.max(1024, input.length * 4));
  let o = 0;
  const ensure = (extra) => {
    if (o + extra <= out.length) return;
    if (o + extra > maxOutput) throw new Error('Распакованные данные слишком велики');
    let size = out.length * 2;
    while (size < o + extra) size *= 2;
    const next = new Uint8Array(Math.min(size, maxOutput));
    next.set(out.subarray(0, o));
    out = next;
  };
  let final = 0;
  while (!final) {
    final = br.bits(1);
    const type = br.bits(2);
    if (type === 0) {
      br.align();
      if (br.pos + 4 > input.length) throw new Error('Данные оборваны');
      const len = input[br.pos] | (input[br.pos + 1] << 8);
      const nlen = input[br.pos + 2] | (input[br.pos + 3] << 8);
      if ((len ^ 0xFFFF) !== nlen) throw new Error('Повреждён несжатый блок');
      br.pos += 4;
      if (br.pos + len > input.length) throw new Error('Данные оборваны');
      ensure(len);
      out.set(input.subarray(br.pos, br.pos + len), o);
      o += len;
      br.pos += len;
    } else if (type === 1 || type === 2) {
      let lit;
      let dist;
      if (type === 1) {
        fixedDecoders ??= [buildDecoder(FIXED_LIT_LENGTHS), buildDecoder(FIXED_DIST_LENGTHS)];
        [lit, dist] = fixedDecoders;
      } else {
        [lit, dist] = readDynamicDecoders(br);
      }
      for (;;) {
        const sym = decodeSymbol(br, lit);
        if (sym < 256) {
          ensure(1);
          out[o++] = sym;
        } else if (sym === 256) {
          break;
        } else {
          const li = sym - 257;
          if (li >= 29) throw new Error('Неверная длина повтора');
          const len = LEN_BASE[li] + br.bits(LEN_EXTRA[li]);
          const ds = decodeSymbol(br, dist);
          if (ds >= 30) throw new Error('Неверное расстояние');
          const d = DIST_BASE[ds] + br.bits(DIST_EXTRA[ds]);
          if (d > o) throw new Error('Расстояние за началом данных');
          ensure(len);
          for (let k = 0; k < len; k++, o++) out[o] = out[o - d];
        }
      }
    } else {
      throw new Error('Неверный тип блока');
    }
  }
  return out.slice(0, o);
}

// ---------------------------------------------------------------- сжатие

class BitWriter {
  constructor(size) {
    this.buf = new Uint8Array(Math.max(64, size));
    this.pos = 0;
    this.acc = 0;
    this.cnt = 0;
  }

  byte(b) {
    if (this.pos >= this.buf.length) {
      const next = new Uint8Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.pos++] = b;
  }

  write(value, n) {
    this.acc |= value << this.cnt;
    this.cnt += n;
    while (this.cnt >= 8) {
      this.byte(this.acc & 0xFF);
      this.acc >>>= 8;
      this.cnt -= 8;
    }
  }

  align() {
    if (this.cnt > 0) this.byte(this.acc & 0xFF);
    this.acc = 0;
    this.cnt = 0;
  }

  result() {
    this.align();
    return this.buf.slice(0, this.pos);
  }
}

const WSIZE = 32768;
const WMASK = WSIZE - 1;
const HASH_SIZE = 1 << 15;
const MIN_MATCH = 3;
const MAX_MATCH = 258;
const MAX_CHAIN = 256;
const NICE_MATCH = 128;

/** LZ77 с цепочками хешей и «ленивым» сопоставлением. Возвращает длины (0 — литерал) и значения. */
function lz77(data) {
  const n = data.length;
  const lens = [];
  const vals = [];
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(WSIZE).fill(-1);
  const hash = (i) => ((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & (HASH_SIZE - 1);
  const insert = (i) => {
    if (i + MIN_MATCH > n) return;
    const h = hash(i);
    prev[i & WMASK] = head[h];
    head[h] = i;
  };
  const longest = (i) => {
    if (i + MIN_MATCH > n) return 0;
    const max = Math.min(MAX_MATCH, n - i);
    let best = MIN_MATCH - 1;
    let bestDist = 0;
    let j = head[hash(i)];
    for (let chain = MAX_CHAIN; j >= 0 && i - j <= WSIZE && chain > 0; chain--) {
      if (data[j + best] === data[i + best] && data[j] === data[i]) {
        let len = 0;
        while (len < max && data[j + len] === data[i + len]) len++;
        if (len > best) {
          best = len;
          bestDist = i - j;
          if (len >= NICE_MATCH || len === max) break;
        }
      }
      const pj = prev[j & WMASK];
      if (pj >= j) break;
      j = pj;
    }
    return best >= MIN_MATCH ? best * 65536 + bestDist : 0;
  };

  let i = 0;
  while (i < n) {
    const m = longest(i);
    insert(i);
    if (m) {
      const len = Math.floor(m / 65536);
      if (len < NICE_MATCH && i + 1 < n) {
        const m2 = longest(i + 1);
        if (m2 && Math.floor(m2 / 65536) > len) {
          lens.push(0);
          vals.push(data[i]);
          i += 1;
          continue;
        }
      }
      lens.push(len);
      vals.push(m % 65536);
      for (let k = 1; k < len; k++) insert(i + k);
      i += len;
    } else {
      lens.push(0);
      vals.push(data[i]);
      i += 1;
    }
  }
  return { lens, vals };
}

const LEN_SYM = (() => {
  const t = new Uint16Array(MAX_MATCH + 1);
  for (let li = 0; li < 29; li++) {
    const hi = li === 28 ? 258 : LEN_BASE[li] + (1 << LEN_EXTRA[li]) - 1;
    for (let len = LEN_BASE[li]; len <= hi && len <= MAX_MATCH; len++) t[len] = li;
  }
  t[258] = 28;
  return t;
})();

function distIndex(d) {
  let lo = 0;
  let hi = 29;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (DIST_BASE[mid] <= d) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Длины кодов Хаффмана с ограничением maxBits (выравнивание по алгоритму JPEG, прил. K.3). */
export function huffmanLengths(freqs, maxBits) {
  const lengths = new Uint8Array(freqs.length);
  const used = [];
  for (let s = 0; s < freqs.length; s++) if (freqs[s] > 0) used.push(s);
  if (!used.length) return lengths;
  if (used.length === 1) {
    lengths[used[0]] = 1;
    lengths[used[0] === 0 ? 1 : 0] = 1;
    return lengths;
  }
  const leaves = used.map((s) => ({ f: freqs[s], s })).sort((x, y) => x.f - y.f || x.s - y.s);
  const merged = [];
  let a = 0;
  let b = 0;
  const take = () => (a < leaves.length && (b >= merged.length || leaves[a].f <= merged[b].f)
    ? leaves[a++]
    : merged[b++]);
  while (leaves.length - a + merged.length - b > 1) {
    const x = take();
    const y = take();
    merged.push({ f: x.f + y.f, s: -1, l: x, r: y });
  }
  const stack = [[take(), 0]];
  while (stack.length) {
    const [node, depth] = stack.pop();
    if (node.s >= 0) lengths[node.s] = Math.max(1, depth);
    else stack.push([node.l, depth + 1], [node.r, depth + 1]);
  }
  let maxLen = 0;
  for (const s of used) maxLen = Math.max(maxLen, lengths[s]);
  if (maxLen <= maxBits) return lengths;
  const count = new Array(maxLen + 1).fill(0);
  for (const s of used) count[lengths[s]]++;
  for (let i = maxLen; i > maxBits; i--) {
    while (count[i] > 0) {
      let j = i - 2;
      while (count[j] === 0) j--;
      count[i] -= 2;
      count[i - 1] += 1;
      count[j + 1] += 2;
      count[j] -= 1;
    }
  }
  const byFreq = used.slice().sort((x, y) => freqs[y] - freqs[x] || x - y);
  let k = 0;
  for (let len = 1; len <= maxBits; len++) {
    for (let c = 0; c < count[len]; c++) lengths[byFreq[k++]] = len;
  }
  return lengths;
}

/** Канонические коды (уже с обратным порядком битов — DEFLATE пишет коды старшим битом вперёд). */
function canonicalCodes(lengths) {
  const count = new Uint16Array(16);
  for (const l of lengths) if (l) count[l]++;
  const next = new Uint16Array(16);
  let code = 0;
  for (let bits = 1; bits <= 15; bits++) {
    code = (code + count[bits - 1]) << 1;
    next[bits] = code;
  }
  const codes = new Uint16Array(lengths.length);
  for (let s = 0; s < lengths.length; s++) {
    const len = lengths[s];
    if (!len) continue;
    let c = next[len]++;
    let r = 0;
    for (let k = 0; k < len; k++) {
      r = (r << 1) | (c & 1);
      c >>= 1;
    }
    codes[s] = r;
  }
  return codes;
}

/** RLE длин кодов (символы 16, 17, 18) для заголовка динамического блока. */
function rleLengths(lengths) {
  const out = [];
  for (let i = 0; i < lengths.length;) {
    const v = lengths[i];
    let run = 1;
    while (i + run < lengths.length && lengths[i + run] === v) run++;
    let left = run;
    if (v === 0) {
      while (left >= 11) {
        const r = Math.min(138, left);
        out.push([18, r - 11]);
        left -= r;
      }
      if (left >= 3) {
        out.push([17, left - 3]);
        left = 0;
      }
    } else {
      out.push([v, 0]);
      left -= 1;
      while (left >= 3) {
        const r = Math.min(6, left);
        out.push([16, r - 3]);
        left -= r;
      }
    }
    while (left-- > 0) out.push([v, 0]);
    i += run;
  }
  return out;
}

const CL_EXTRA = { 16: 2, 17: 3, 18: 7 };

export function deflateRaw(data) {
  const input = data instanceof Uint8Array ? data : new Uint8Array(data);
  const { lens, vals } = lz77(input);
  const litFreq = new Uint32Array(286);
  const distFreq = new Uint32Array(30);
  let extraBits = 0;
  for (let t = 0; t < lens.length; t++) {
    if (!lens[t]) {
      litFreq[vals[t]]++;
    } else {
      const li = LEN_SYM[lens[t]];
      const di = distIndex(vals[t]);
      litFreq[257 + li]++;
      distFreq[di]++;
      extraBits += LEN_EXTRA[li] + DIST_EXTRA[di];
    }
  }
  litFreq[256] = 1;

  // Динамические коды
  const litLen = huffmanLengths(litFreq, 15);
  let distLen = huffmanLengths(distFreq, 15);
  if (!distLen.some(Boolean)) {
    distLen = new Uint8Array(30);
    distLen[0] = 1;
    distLen[1] = 1;
  }
  let hlit = 286;
  while (hlit > 257 && !litLen[hlit - 1]) hlit--;
  let hdist = 30;
  while (hdist > 1 && !distLen[hdist - 1]) hdist--;
  const rle = rleLengths([...litLen.subarray(0, hlit), ...distLen.subarray(0, hdist)]);
  const clFreq = new Uint32Array(19);
  for (const [sym] of rle) clFreq[sym]++;
  const clLen = huffmanLengths(clFreq, 7);
  let hclen = 19;
  while (hclen > 4 && !clLen[CL_ORDER[hclen - 1]]) hclen--;

  const cost = (lit, dist) => {
    let bits = extraBits;
    for (let s = 0; s < 286; s++) bits += litFreq[s] * lit[s];
    for (let s = 0; s < 30; s++) bits += distFreq[s] * dist[s];
    return bits;
  };
  let dynHeader = 5 + 5 + 4 + 3 * hclen;
  for (const [sym] of rle) dynHeader += clLen[sym] + (CL_EXTRA[sym] ?? 0);
  const dynamicBits = 3 + dynHeader + cost(litLen, distLen);
  const fixedBits = 3 + cost(FIXED_LIT_LENGTHS, FIXED_DIST_LENGTHS);
  const storedBits = Math.max(1, Math.ceil(input.length / 65535)) * 40 + input.length * 8;

  const w = new BitWriter(Math.ceil(Math.min(dynamicBits, fixedBits, storedBits) / 8) + 16);
  if (storedBits < Math.min(dynamicBits, fixedBits)) {
    let pos = 0;
    do {
      const len = Math.min(65535, input.length - pos);
      const final = pos + len >= input.length ? 1 : 0;
      w.write(final, 1);
      w.write(0, 2);
      w.align();
      w.byte(len & 0xFF);
      w.byte(len >> 8);
      w.byte(~len & 0xFF);
      w.byte((~len >> 8) & 0xFF);
      for (let k = 0; k < len; k++) w.byte(input[pos + k]);
      pos += len;
    } while (pos < input.length);
    return w.result();
  }

  const dynamic = dynamicBits < fixedBits;
  const lit = dynamic ? litLen : FIXED_LIT_LENGTHS;
  const dist = dynamic ? distLen : FIXED_DIST_LENGTHS;
  w.write(1, 1);
  w.write(dynamic ? 2 : 1, 2);
  if (dynamic) {
    w.write(hlit - 257, 5);
    w.write(hdist - 1, 5);
    w.write(hclen - 4, 4);
    for (let i = 0; i < hclen; i++) w.write(clLen[CL_ORDER[i]], 3);
    const clCodes = canonicalCodes(clLen);
    for (const [sym, extra] of rle) {
      w.write(clCodes[sym], clLen[sym]);
      if (sym >= 16) w.write(extra, CL_EXTRA[sym]);
    }
  }
  const litCodes = canonicalCodes(lit);
  const distCodes = canonicalCodes(dist);
  for (let t = 0; t < lens.length; t++) {
    if (!lens[t]) {
      w.write(litCodes[vals[t]], lit[vals[t]]);
      continue;
    }
    const len = lens[t];
    const li = LEN_SYM[len];
    w.write(litCodes[257 + li], lit[257 + li]);
    if (LEN_EXTRA[li]) w.write(len - LEN_BASE[li], LEN_EXTRA[li]);
    const d = vals[t];
    const di = distIndex(d);
    w.write(distCodes[di], dist[di]);
    if (DIST_EXTRA[di]) w.write(d - DIST_BASE[di], DIST_EXTRA[di]);
  }
  w.write(litCodes[256], lit[256]);
  return w.result();
}
