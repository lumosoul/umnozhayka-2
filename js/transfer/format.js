// Форматы переноса прогресса: JSON-файл, код Base64 с контрольной суммой и серия QR-кодов.
//
// Файл — читаемый JSON со снимком профилей. Код и QR — тот же снимок в двоичном контейнере:
//   'U' 'M' | версия контейнера | версия формата | флаги | длина до сжатия (varint) | данные | CRC-32
// Данные — pack(toWire(снимок)) (столбцовая запись), сжатые DEFLATE, если так короче.
// CRC-32 считается по всему, что перед ним.

import { normalizeProfile } from '../core/profile.js';
import { nowSec } from '../core/dates.js';
import { crc32, crc32Hex } from './crc32.js';
import { deflateRaw, inflateRaw } from './deflate.js';
import { pack, unpack } from './pack.js';
import { fromBase64, toBase64Url } from './base64.js';
import { fromBase45, toBase45 } from './base45.js';
import { fromWire, toWire } from './wire.js';

export const APP_FORMAT = 'umnozhayka-progress';
/** Версия формата данных. Увеличивается при несовместимом изменении схемы. */
export const FORMAT_VERSION = 1;
export const SUPPORTED_VERSIONS = Object.freeze([1]);
export const CONTAINER_VERSION = 1;
const MAGIC_0 = 0x55; // 'U'
const MAGIC_1 = 0x4D; // 'M'
const FLAG_DEFLATE = 1;
export const CODE_PREFIX = 'UM1.';
export const QR_PREFIX = 'UM1';
/**
 * Сколько байт контейнера кладём в один QR-код. На телефоне — до версии 16 (81 модуль) с коррекцией M:
 * такой код уверенно читается камерой с 10–20 см. На большом экране модули крупнее, поэтому
 * помещаем больше — до версии 20 (97 модулей). Замеры — в tests/qr.test.js и README.
 */
export const QR_CHUNK_BYTES = 420;
export const QR_CHUNK_BYTES_LARGE = 620;
const MAX_PROFILES_IN_FILE = 16;

export class ImportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
  }
}

const clone = (v) => JSON.parse(JSON.stringify(v));

export function buildExport(profiles, { now = Date.now(), appVersion = '' } = {}) {
  return {
    format: APP_FORMAT,
    version: FORMAT_VERSION,
    app: appVersion,
    exportedAt: nowSec(now),
    profiles: profiles.map(clone),
  };
}

function checkVersion(version) {
  if (!Number.isInteger(version)) {
    throw new ImportError('version', 'Не удалось определить версию формата данных.');
  }
  if (version > FORMAT_VERSION) {
    throw new ImportError('newer', 'Данные сохранены более новой версией «Умножайки». Обновите приложение на этом устройстве и попробуйте ещё раз.');
  }
  if (!SUPPORTED_VERSIONS.includes(version)) {
    throw new ImportError('version', `Версия формата ${version} не поддерживается.`);
  }
}

/** Проверяет снимок (формат, версию, структуру) и приводит профили к текущей схеме. */
export function parseExport(obj) {
  if (!obj || typeof obj !== 'object' || obj.format !== APP_FORMAT) {
    throw new ImportError('format', 'Это не данные «Умножайки».');
  }
  checkVersion(obj.version);
  if (!Array.isArray(obj.profiles) || obj.profiles.length === 0) {
    throw new ImportError('empty', 'В данных нет ни одного профиля.');
  }
  if (obj.profiles.length > MAX_PROFILES_IN_FILE) {
    throw new ImportError('too-many', 'В данных слишком много профилей.');
  }
  let profiles;
  try {
    profiles = obj.profiles.map(normalizeProfile);
  } catch (err) {
    throw new ImportError('profile', `Профиль в данных повреждён: ${err.message}`);
  }
  return {
    version: obj.version,
    exportedAt: Number.isFinite(obj.exportedAt) ? obj.exportedAt : 0,
    profiles,
  };
}

// ---------- JSON-файл ----------

export function exportJson(profiles, opts) {
  return JSON.stringify(buildExport(profiles, opts));
}

export function importJson(text) {
  let obj;
  try {
    obj = JSON.parse(String(text).replace(/^\uFEFF/, ''));
  } catch {
    throw new ImportError('json', 'Файл не читается: это не JSON-файл «Умножайки».');
  }
  return parseExport(obj);
}

export function exportFileName(now = Date.now()) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `umnozhayka-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.json`;
}

// ---------- двоичный контейнер ----------

function varintBytes(n) {
  const out = [];
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
  return out;
}

export function encodeContainer(exportObj) {
  const packed = pack(toWire(exportObj));
  const deflated = deflateRaw(packed);
  const compress = deflated.length < packed.length;
  const payload = compress ? deflated : packed;
  const header = [MAGIC_0, MAGIC_1, CONTAINER_VERSION, exportObj.version, compress ? FLAG_DEFLATE : 0, ...varintBytes(packed.length)];
  const out = new Uint8Array(header.length + payload.length + 4);
  out.set(header, 0);
  out.set(payload, header.length);
  const crc = crc32(out.subarray(0, out.length - 4));
  new DataView(out.buffer).setUint32(out.length - 4, crc, false);
  return out;
}

export function containerChecksum(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getUint32(bytes.length - 4, false).toString(16).toUpperCase().padStart(8, '0');
}

export function decodeContainer(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 10) {
    throw new ImportError('short', 'Код неполный — похоже, скопирована только часть.');
  }
  if (bytes[0] !== MAGIC_0 || bytes[1] !== MAGIC_1) {
    throw new ImportError('magic', 'Это не код «Умножайки».');
  }
  const stored = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(bytes.length - 4, false);
  if (crc32(bytes.subarray(0, bytes.length - 4)) !== stored) {
    throw new ImportError('checksum', 'Контрольная сумма не совпала: код повреждён или скопирован не полностью.');
  }
  if (bytes[2] > CONTAINER_VERSION) {
    throw new ImportError('newer', 'Код создан более новой версией «Умножайки». Обновите приложение и попробуйте ещё раз.');
  }
  checkVersion(bytes[3]);
  const flags = bytes[4];
  let pos = 5;
  let rawLength = 0;
  let mul = 1;
  for (let i = 0; ; i++) {
    if (i > 7 || pos >= bytes.length - 4) throw new ImportError('corrupt', 'Код повреждён.');
    const b = bytes[pos++];
    rawLength += (b & 0x7F) * mul;
    if (!(b & 0x80)) break;
    mul *= 0x80;
  }
  const payload = bytes.subarray(pos, bytes.length - 4);
  let obj;
  try {
    const packed = flags & FLAG_DEFLATE ? inflateRaw(payload, { maxOutput: rawLength + 16 }) : payload;
    if (packed.length !== rawLength) throw new Error('длина не совпала');
    obj = fromWire(unpack(packed));
  } catch {
    throw new ImportError('corrupt', 'Код повреждён: данные не распаковываются.');
  }
  const parsed = parseExport(obj);
  if (parsed.version !== bytes[3]) throw new ImportError('corrupt', 'Код повреждён: версии не совпадают.');
  return parsed;
}

// ---------- код Base64 ----------

export function exportCode(profiles, opts) {
  const bytes = encodeContainer(buildExport(profiles, opts));
  return { code: CODE_PREFIX + toBase64Url(bytes), checksum: containerChecksum(bytes), bytes: bytes.length };
}

export function importCode(text) {
  const clean = String(text ?? '').replace(/\s+/g, '');
  if (!clean) throw new ImportError('empty-code', 'Вставьте код переноса.');
  const body = clean.startsWith(CODE_PREFIX) ? clean.slice(CODE_PREFIX.length) : clean;
  let bytes;
  try {
    bytes = fromBase64(body);
  } catch {
    throw new ImportError('base64', 'В коде есть лишние символы — скопируйте его целиком ещё раз.');
  }
  return decodeContainer(bytes);
}

// ---------- серия QR-кодов ----------

const ID_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function transferId(bytes) {
  // Идентификатор передачи выводим из CRC: одинаковые данные — одинаковый id.
  let n = crc32(bytes);
  let id = '';
  for (let i = 0; i < 4; i++) {
    id += ID_CHARS[n % 36];
    n = Math.floor(n / 36);
  }
  return id;
}

/** Строки для QR-кодов: «UM1:ID:номер:всего:данные в Base45» — только символы режима alphanumeric. */
export function exportQrChunks(profiles, { chunkBytes = QR_CHUNK_BYTES, ...opts } = {}) {
  const bytes = encodeContainer(buildExport(profiles, opts));
  const id = transferId(bytes);
  const total = Math.max(1, Math.ceil(bytes.length / chunkBytes));
  const chunks = [];
  for (let i = 0; i < total; i++) {
    const part = bytes.subarray(i * chunkBytes, (i + 1) * chunkBytes);
    chunks.push(`${QR_PREFIX}:${id}:${i + 1}:${total}:${toBase45(part)}`);
  }
  return { chunks, checksum: containerChecksum(bytes), bytes: bytes.length, id };
}

const CHUNK_RE = /^UM(\d+):([0-9A-Z]{4}):(\d{1,4}):(\d{1,4}):([0-9A-Z $%*+\-./:]*)$/;

export function parseQrChunk(text) {
  const m = CHUNK_RE.exec(String(text ?? '').trim());
  if (!m) return null;
  const index = Number(m[3]);
  const total = Number(m[4]);
  if (index < 1 || total < 1 || index > total) return null;
  let data;
  try {
    data = fromBase45(m[5]);
  } catch {
    return null;
  }
  return { version: Number(m[1]), id: m[2], index, total, data };
}

/** Собирает части в любом порядке; повторы и чужие коды игнорирует. */
export class QrCollector {
  constructor() {
    this.reset();
  }

  reset() {
    this.id = null;
    this.total = 0;
    this.parts = new Map();
  }

  get received() {
    return this.parts.size;
  }

  get complete() {
    return this.total > 0 && this.parts.size === this.total;
  }

  missing() {
    const out = [];
    for (let i = 1; i <= this.total; i++) if (!this.parts.has(i)) out.push(i);
    return out;
  }

  /** → 'added' | 'duplicate' | 'restarted' | 'foreign' | 'newer' */
  add(text) {
    const chunk = parseQrChunk(text);
    if (!chunk) return 'foreign';
    if (chunk.version > CONTAINER_VERSION) return 'newer';
    let status = 'added';
    if (this.id !== chunk.id || this.total !== chunk.total) {
      if (this.id !== null) status = 'restarted';
      this.id = chunk.id;
      this.total = chunk.total;
      this.parts = new Map();
    }
    if (this.parts.has(chunk.index)) return 'duplicate';
    this.parts.set(chunk.index, chunk.data);
    return status;
  }

  bytes() {
    if (!this.complete) throw new ImportError('incomplete', 'Считаны не все QR-коды.');
    const size = [...this.parts.values()].reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(size);
    let pos = 0;
    for (let i = 1; i <= this.total; i++) {
      out.set(this.parts.get(i), pos);
      pos += this.parts.get(i).length;
    }
    return out;
  }

  result() {
    return decodeContainer(this.bytes());
  }
}

export { crc32Hex };
