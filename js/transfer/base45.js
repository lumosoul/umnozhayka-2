// Base45 (RFC 9285): байты → символы алфавита QR alphanumeric.
// Такой текст QR-код хранит в компактном режиме (5,5 бита на символ) — почти как сырые байты.

export const BASE45_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

const DECODE = (() => {
  const t = new Int8Array(128).fill(-1);
  for (let i = 0; i < 45; i++) t[BASE45_ALPHABET.charCodeAt(i)] = i;
  return t;
})();

export function toBase45(bytes) {
  let out = '';
  let i = 0;
  for (; i + 1 < bytes.length; i += 2) {
    let n = bytes[i] * 256 + bytes[i + 1];
    const c = n % 45;
    n = (n - c) / 45;
    const d = n % 45;
    const e = (n - d) / 45;
    out += BASE45_ALPHABET[c] + BASE45_ALPHABET[d] + BASE45_ALPHABET[e];
  }
  if (i < bytes.length) {
    const n = bytes[i];
    out += BASE45_ALPHABET[n % 45] + BASE45_ALPHABET[Math.floor(n / 45)];
  }
  return out;
}

export function fromBase45(text) {
  const s = String(text);
  if (s.length % 3 === 1) throw new Error('Неверная длина Base45');
  const val = (ch) => {
    const code = ch.charCodeAt(0);
    const v = code < 128 ? DECODE[code] : -1;
    if (v < 0) throw new Error(`Недопустимый символ Base45 «${ch}»`);
    return v;
  };
  const out = new Uint8Array(Math.floor(s.length / 3) * 2 + (s.length % 3 === 2 ? 1 : 0));
  let o = 0;
  let i = 0;
  for (; i + 2 < s.length; i += 3) {
    const n = val(s[i]) + val(s[i + 1]) * 45 + val(s[i + 2]) * 2025;
    if (n > 0xFFFF) throw new Error('Неверная тройка Base45');
    out[o++] = n >> 8;
    out[o++] = n & 0xFF;
  }
  if (i < s.length) {
    const n = val(s[i]) + val(s[i + 1]) * 45;
    if (n > 0xFF) throw new Error('Неверная пара Base45');
    out[o++] = n;
  }
  return out;
}
