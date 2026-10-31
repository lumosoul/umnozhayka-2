// Base64 для кода переноса. Пишем вариант base64url без «=» (его не портят мессенджеры),
// а читаем оба алфавита и игнорируем пробелы и переносы строк.

const URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const DECODE = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < 64; i++) t[URL_ALPHABET.charCodeAt(i)] = i;
  t['+'.charCodeAt(0)] = 62;
  t['/'.charCodeAt(0)] = 63;
  return t;
})();

export function toBase64Url(bytes) {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += URL_ALPHABET[n >> 18] + URL_ALPHABET[(n >> 12) & 63] + URL_ALPHABET[(n >> 6) & 63] + URL_ALPHABET[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += URL_ALPHABET[n >> 18] + URL_ALPHABET[(n >> 12) & 63];
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += URL_ALPHABET[n >> 18] + URL_ALPHABET[(n >> 12) & 63] + URL_ALPHABET[(n >> 6) & 63];
  }
  return out;
}

export function fromBase64(text) {
  const clean = String(text).replace(/[\s=]+/g, '');
  if (clean.length % 4 === 1) throw new Error('Неверная длина Base64');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i);
    const v = code < 128 ? DECODE[code] : -1;
    if (v < 0) throw new Error(`Недопустимый символ «${clean[i]}»`);
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xFF;
    }
  }
  return out.subarray(0, o);
}
