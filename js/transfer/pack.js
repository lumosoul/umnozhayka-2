// Компактная двоичная запись JSON-совместимых данных (для кода и QR).
// Ключи объектов хранятся один раз в словаре, целые — переменной длины, малые числа — в одном байте.
// Без потерь по построению: unpack(pack(x)) совпадает с JSON.parse(JSON.stringify(x)).

const T_NULL = 0x00;
const T_FALSE = 0x01;
const T_TRUE = 0x02;
const T_UINT = 0x03;
const T_NEGINT = 0x04;
const T_FLOAT = 0x05;
const T_STRING = 0x06;
const T_ARRAY = 0x07;
const T_OBJECT = 0x08;
const T_SMALL = 0x40; // 0x40…0x7F — целые 0…63

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

class Writer {
  constructor() {
    this.buf = new Uint8Array(1024);
    this.pos = 0;
  }

  ensure(n) {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
  }

  byte(b) {
    this.ensure(1);
    this.buf[this.pos++] = b;
  }

  /** Беззнаковое целое до 2^53: по 7 бит, старший бит — «дальше есть ещё». */
  varint(n) {
    while (n >= 0x80) {
      this.byte((n % 0x80) | 0x80);
      n = Math.floor(n / 0x80);
    }
    this.byte(n);
  }

  bytes(arr) {
    this.ensure(arr.length);
    this.buf.set(arr, this.pos);
    this.pos += arr.length;
  }

  result() {
    return this.buf.slice(0, this.pos);
  }
}

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.pos = 0;
  }

  byte() {
    if (this.pos >= this.bytes.length) throw new Error('Данные оборваны');
    return this.bytes[this.pos++];
  }

  varint() {
    let n = 0;
    let mul = 1;
    for (let i = 0; i < 8; i++) {
      const b = this.byte();
      n += (b & 0x7F) * mul;
      if (!(b & 0x80)) return n;
      mul *= 0x80;
    }
    throw new Error('Слишком длинное число');
  }

  take(n) {
    if (this.pos + n > this.bytes.length) throw new Error('Данные оборваны');
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

function collectKeys(value, keys) {
  if (Array.isArray(value)) {
    for (const v of value) collectKeys(v, keys);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined || typeof v === 'function') continue;
      if (!keys.has(k)) keys.set(k, keys.size);
      collectKeys(v, keys);
    }
  }
}

function writeValue(w, v, keys) {
  if (v === null || v === undefined || typeof v === 'function') {
    w.byte(T_NULL);
  } else if (v === false) {
    w.byte(T_FALSE);
  } else if (v === true) {
    w.byte(T_TRUE);
  } else if (typeof v === 'number') {
    if (!Number.isFinite(v)) {
      w.byte(T_NULL);
    } else if (Number.isSafeInteger(v)) {
      if (v >= 0 && v < 64) w.byte(T_SMALL + v);
      else if (v >= 0) {
        w.byte(T_UINT);
        w.varint(v);
      } else {
        w.byte(T_NEGINT);
        w.varint(-v);
      }
    } else {
      w.byte(T_FLOAT);
      const b = new Uint8Array(8);
      new DataView(b.buffer).setFloat64(0, v, true);
      w.bytes(b);
    }
  } else if (typeof v === 'string') {
    const b = encoder.encode(v);
    w.byte(T_STRING);
    w.varint(b.length);
    w.bytes(b);
  } else if (Array.isArray(v)) {
    w.byte(T_ARRAY);
    w.varint(v.length);
    for (const x of v) writeValue(w, x, keys);
  } else if (typeof v === 'object') {
    const entries = Object.entries(v).filter(([, x]) => x !== undefined && typeof x !== 'function');
    w.byte(T_OBJECT);
    w.varint(entries.length);
    for (const [k, x] of entries) {
      w.varint(keys.get(k));
      writeValue(w, x, keys);
    }
  } else {
    throw new Error(`Нельзя упаковать значение типа ${typeof v}`);
  }
}

function readValue(r, keys, depth) {
  if (depth > 64) throw new Error('Слишком глубокая вложенность');
  const tag = r.byte();
  if (tag >= T_SMALL && tag < T_SMALL + 64) return tag - T_SMALL;
  switch (tag) {
    case T_NULL: return null;
    case T_FALSE: return false;
    case T_TRUE: return true;
    case T_UINT: return r.varint();
    case T_NEGINT: return -r.varint();
    case T_FLOAT: {
      const b = r.take(8);
      return new DataView(b.buffer, b.byteOffset, 8).getFloat64(0, true);
    }
    case T_STRING: return decoder.decode(r.take(r.varint()));
    case T_ARRAY: {
      const n = r.varint();
      if (n > r.bytes.length) throw new Error('Неверная длина массива');
      const out = new Array(n);
      for (let i = 0; i < n; i++) out[i] = readValue(r, keys, depth + 1);
      return out;
    }
    case T_OBJECT: {
      const n = r.varint();
      if (n > r.bytes.length) throw new Error('Неверная длина объекта');
      const out = {};
      for (let i = 0; i < n; i++) {
        const k = keys[r.varint()];
        if (k === undefined) throw new Error('Неизвестный ключ');
        // присваивание __proto__ подменило бы прототип — такие данные не принимаем
        if (k === '__proto__') throw new Error('Недопустимый ключ');
        out[k] = readValue(r, keys, depth + 1);
      }
      return out;
    }
    default:
      throw new Error('Неизвестный тип данных');
  }
}

export function pack(value) {
  const keys = new Map();
  collectKeys(value, keys);
  const w = new Writer();
  w.varint(keys.size);
  for (const k of keys.keys()) {
    const b = encoder.encode(k);
    w.varint(b.length);
    w.bytes(b);
  }
  writeValue(w, value, keys);
  return w.result();
}

export function unpack(bytes) {
  const r = new Reader(bytes);
  const count = r.varint();
  if (count > bytes.length) throw new Error('Неверный словарь ключей');
  const keys = [];
  for (let i = 0; i < count; i++) keys.push(decoder.decode(r.take(r.varint())));
  const value = readValue(r, keys, 0);
  if (r.pos !== bytes.length) throw new Error('Лишние данные в конце');
  return value;
}
