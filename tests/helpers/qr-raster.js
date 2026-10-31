// Синтетические «кадры камеры» с QR-кодом для тестов декодера и чтение PNG-фикстур.
// Модель: телефон (тёмная рамка, светлый экран с кодом) в плоскости, спроецированной
// гомографией в кадр; поверх — муар, неровное освещение, размытие, шум и фоновые объекты.

import { inflateSync } from 'node:zlib';

// Детерминированный ГПСЧ (mulberry32).
export function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rng) {
  const u = Math.max(rng(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

// Гомография по четырём парам точек (точное решение 8×8).
function homography(src, dst) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [X, Y] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]);
    b.push(X);
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]);
    b.push(Y);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    [b[c], b[p]] = [b[p], b[c]];
    for (let r = c + 1; r < 8; r++) {
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const h = new Array(8);
  for (let r = 7; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < 8; k++) s -= A[r][k] * h[k];
    h[r] = s / A[r][r];
  }
  return [...h, 1];
}

function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

function apply(H, x, y) {
  const z = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / z, (H[3] * x + H[4] * y + H[5]) / z];
}

// Псевдотекст и фигуры на фоне: прямоугольники, эллипсы, линии, «буквы» из точек 5×7,
// иногда — ложный искатель (квадрат 7×7 с кольцами), чтобы проверить выбор тройки.
function drawClutter(img, w, h, count, rng) {
  const fillRect = (x0, y0, x1, y1, v) => {
    for (let y = Math.max(0, y0 | 0); y < Math.min(h, y1); y++) {
      for (let x = Math.max(0, x0 | 0); x < Math.min(w, x1); x++) img[y * w + x] = v;
    }
  };
  for (let k = 0; k < count; k++) {
    const kind = rng();
    const v = 20 + rng() * 215;
    const x = rng() * w;
    const y = rng() * h;
    if (kind < 0.3) {
      fillRect(x, y, x + 10 + rng() * 120, y + 10 + rng() * 90, v);
    } else if (kind < 0.5) {
      const rx = 8 + rng() * 60;
      const ry = 8 + rng() * 60;
      for (let yy = Math.max(0, (y - ry) | 0); yy < Math.min(h, y + ry); yy++) {
        for (let xx = Math.max(0, (x - rx) | 0); xx < Math.min(w, x + rx); xx++) {
          if (((xx - x) / rx) ** 2 + ((yy - y) / ry) ** 2 <= 1) img[yy * w + xx] = v;
        }
      }
    } else if (kind < 0.65) {
      const len = 30 + rng() * 300;
      const a = rng() * Math.PI;
      const th = 1 + rng() * 4;
      for (let t = 0; t < len; t += 0.5) {
        const px = x + Math.cos(a) * t;
        const py = y + Math.sin(a) * t;
        fillRect(px - th / 2, py - th / 2, px + th / 2, py + th / 2, v);
      }
    } else if (kind < 0.95) {
      // Строка «текста»: 4–14 знаков из случайных точек 5×7.
      const px = 1 + Math.floor(rng() * 3);
      const n = 4 + Math.floor(rng() * 10);
      const ink = rng() < 0.7 ? 20 + rng() * 60 : 180 + rng() * 60;
      for (let ch = 0; ch < n; ch++) {
        for (let gy = 0; gy < 7; gy++) {
          for (let gx = 0; gx < 5; gx++) {
            if (rng() < 0.45) fillRect(x + (ch * 6 + gx) * px, y + gy * px, x + (ch * 6 + gx + 1) * px, y + (gy + 1) * px, ink);
          }
        }
      }
    } else {
      const m = 2 + rng() * 5;
      fillRect(x - 4.5 * m, y - 4.5 * m, x + 4.5 * m, y + 4.5 * m, 220);
      fillRect(x - 3.5 * m, y - 3.5 * m, x + 3.5 * m, y + 3.5 * m, 25);
      fillRect(x - 2.5 * m, y - 2.5 * m, x + 2.5 * m, y + 2.5 * m, 220);
      fillRect(x - 1.5 * m, y - 1.5 * m, x + 1.5 * m, y + 1.5 * m, 25);
    }
  }
}

function gaussianBlur(src, w, h, sigma) {
  if (!(sigma > 0)) return src;
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) {
    k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
    s += k[i + r];
  }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  // Строки: свёртка по буферу с продолжением крайних значений.
  const tmp = new Float32Array(w * h);
  const line = new Float32Array(w + 2 * r);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let i = 0; i < r; i++) {
      line[i] = src[row];
      line[r + w + i] = src[row + w - 1];
    }
    for (let i = 0; i < w; i++) line[r + i] = src[row + i];
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let j = 0; j <= 2 * r; j++) acc += k[j] * line[x + j];
      tmp[row + x] = acc;
    }
  }
  // Столбцы: целыми строками (последовательный доступ к памяти).
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let j = -r; j <= r; j++) {
      const sr = Math.min(h - 1, Math.max(0, y + j)) * w;
      const kj = k[j + r];
      for (let x = 0; x < w; x++) out[row + x] += kj * tmp[sr + x];
    }
  }
  return out;
}

/**
 * Рисует кадр с QR-кодом. Возвращает { data (RGBA), width, height, gray, corners }.
 * Параметры: moduleSize (px/модуль, дробный), angle (рад), center [x, y], perspective
 * (доля смещения углов), blur (σ, px), noise (σ), dark/light (уровни), gradient (0..1 —
 * глубина затемнения по кадру), moire (амплитуда 0..1), clutter (число объектов фона),
 * margin (поле экрана сверх тихой зоны, модули), barrel (радиальная дисторсия объектива:
 * относительное смещение на краю кадра, < 0 — «бочка»), motion (смаз, px), mirror, invert, seed.
 */
export function renderQR(modules, size, opts = {}) {
  const {
    width = 1280, height = 720, moduleSize = 5, angle = 0, perspective = 0,
    blur = 0, noise = 0, dark = 35, light = 215, gradient = 0, moire = 0,
    clutter = 0, quiet = 4, margin = 3, bezel = 6, mirror = false, invert = false, seed = 1,
    background = 120, barrel = 0, motion = 0,
  } = opts;
  const rng = makeRng(seed);
  const center = opts.center || [width / 2, height / 2];
  const w = width;
  const h = height;
  const img = new Float32Array(w * h);
  // Фон: плавный градиент плюс объекты.
  const bgA = background + (rng() - 0.5) * 60;
  const bgB = background + (rng() - 0.5) * 60;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) img[y * w + x] = bgA + (bgB - bgA) * (x / w);
  if (clutter > 0) drawClutter(img, w, h, clutter, rng);

  // Углы символа (без тихой зоны) в кадре: поворот, масштаб, случайные смещения углов.
  const half = (size * moduleSize) / 2;
  const cs = Math.cos(angle);
  const sn = Math.sin(angle);
  const dst = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
    const jx = (rng() * 2 - 1) * perspective * half;
    const jy = (rng() * 2 - 1) * perspective * half;
    const x = sx * half + jx;
    const y = sy * half + jy;
    return [center[0] + x * cs - y * sn, center[1] + x * sn + y * cs];
  });
  const src = mirror ? [[size, 0], [0, 0], [0, size], [size, size]] : [[0, 0], [size, 0], [size, size], [0, size]];
  const H = homography(src, dst);
  const Hi = invert3(H);

  const screen = quiet + margin;
  const body = screen + bezel;
  // Ограничивающий прямоугольник телефона в кадре.
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [u, v] of [[-body, -body], [size + body, -body], [size + body, size + body], [-body, size + body]]) {
    const [X, Y] = apply(H, u, v);
    x0 = Math.min(x0, X);
    y0 = Math.min(y0, Y);
    x1 = Math.max(x1, X);
    y1 = Math.max(y1, Y);
  }
  // Муар: сетка субпикселей экрана с шагом, близким к пикселю камеры, даёт биения.
  const screenPx = moduleSize * (0.85 + rng() * 0.3);
  const reflect = (u, v) => {
    if (u < -body || v < -body || u >= size + body || v >= size + body) return -1;
    if (u < -screen || v < -screen || u >= size + screen || v >= size + screen) return 18;
    let val = light;
    if (u >= 0 && v >= 0 && u < size && v < size && modules[Math.floor(v) * size + Math.floor(u)]) val = dark;
    if (invert) val = light + dark - val;
    if (moire > 0) {
      const gu = (u * screenPx) % 1;
      const gv = (v * screenPx) % 1;
      if (gu < 0.22 || gv < 0.22) val *= 1 - moire * 0.6;
    }
    return val;
  };
  // Обратная гомография без выделения массивов: точка кадра → (u, v) в модулях.
  // Дисторсия: точка кадра p_d = c + (p_u − c)(1 + k·r_u²/R²); обращаем итерациями.
  const [i0, i1, i2, i3, i4, i5, i6, i7, i8] = Hi;
  const R2 = (w * w + h * h) / 4;
  const reflectAt = (x, y) => {
    if (barrel !== 0) {
      const dx = x - w / 2;
      const dy = y - h / 2;
      let f = 1;
      for (let it = 0; it < 4; it++) f = 1 + (barrel * (dx * dx + dy * dy)) / (f * f * R2);
      x = w / 2 + dx / f;
      y = h / 2 + dy / f;
    }
    const z = i6 * x + i7 * y + i8;
    return reflect((i0 * x + i1 * y + i2) / z, (i3 * x + i4 * y + i5) / z);
  };
  if (barrel > 0) {
    const grow = barrel * Math.sqrt(R2);
    x0 -= grow;
    y0 -= grow;
    x1 += grow;
    y1 += grow;
  }
  // Значения в углах пикселей; пиксель, у которого все четыре угла попали в одну
  // область, однороден, остальные усредняются по 4×4 подвыборкам (сглаживание краёв).
  const SS = 4;
  const gx0 = Math.max(0, Math.floor(x0));
  const gy0 = Math.max(0, Math.floor(y0));
  const gx1 = Math.min(w, Math.ceil(x1));
  const gy1 = Math.min(h, Math.ceil(y1));
  const cw = gx1 - gx0 + 1;
  const corner = new Float32Array(cw * (gy1 - gy0 + 1));
  for (let y = gy0; y <= gy1; y++) {
    for (let x = gx0; x <= gx1; x++) corner[(y - gy0) * cw + x - gx0] = reflectAt(x, y);
  }
  for (let y = gy0; y < gy1; y++) {
    for (let x = gx0; x < gx1; x++) {
      const k = (y - gy0) * cw + x - gx0;
      const a = corner[k];
      if (a === corner[k + 1] && a === corner[k + cw] && a === corner[k + cw + 1]) {
        if (a >= 0) img[y * w + x] = a;
        continue;
      }
      let acc = 0;
      let inside = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const r = reflectAt(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
          if (r >= 0) {
            acc += r;
            inside++;
          }
        }
      }
      if (inside) img[y * w + x] = (acc + img[y * w + x] * (SS * SS - inside)) / (SS * SS);
    }
  }
  // Муар низкой частоты (биения) поверх кадра: sin(A + B) раскладывается по осям.
  if (moire > 0) {
    const period = 9 + rng() * 25;
    const a = rng() * Math.PI;
    const ph = rng() * 6.28;
    const k = (2 * Math.PI) / period;
    const sx = Float32Array.from({ length: w }, (_, x) => Math.sin(k * x * Math.cos(a) + ph));
    const cx = Float32Array.from({ length: w }, (_, x) => Math.cos(k * x * Math.cos(a) + ph));
    for (let y = 0; y < h; y++) {
      const sy = Math.sin(k * y * Math.sin(a));
      const cy = Math.cos(k * y * Math.sin(a));
      for (let x = 0; x < w; x++) {
        img[y * w + x] *= 1 - moire * 0.25 * (0.5 + 0.5 * (sx[x] * cy + cx[x] * sy));
      }
    }
  }
  // Неравномерное освещение: линейное затемнение в случайном направлении и блик
  // (гауссово пятно раскладывается в произведение множителей по осям).
  if (gradient > 0) {
    const a = rng() * 2 * Math.PI;
    const gx = Math.cos(a) / Math.hypot(w, h);
    const gy = Math.sin(a) / Math.hypot(w, h);
    const hx = rng() * w;
    const hy = rng() * h;
    const hr = 150 + rng() * 250;
    const ex = Float32Array.from({ length: w }, (_, x) => Math.exp(-((x - hx) ** 2) / (hr * hr)));
    for (let y = 0; y < h; y++) {
      const ey = gradient * 40 * Math.exp(-((y - hy) ** 2) / (hr * hr));
      const ty = 0.5 + (y - h / 2) * gy;
      for (let x = 0; x < w; x++) {
        const t = ty + (x - w / 2) * gx;
        img[y * w + x] = img[y * w + x] * (1 - gradient * t) + ey * ex[x];
      }
    }
  }
  // Смаз от движения руки: среднее вдоль отрезка длиной motion px в случайном направлении.
  if (motion > 0) {
    const a = rng() * Math.PI;
    const n = Math.max(2, Math.ceil(motion * 2));
    const src = img.slice();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let acc = 0;
        for (let k = 0; k < n; k++) {
          const t = (k / (n - 1) - 0.5) * motion;
          const sx = Math.min(w - 1, Math.max(0, Math.round(x + t * Math.cos(a))));
          const sy = Math.min(h - 1, Math.max(0, Math.round(y + t * Math.sin(a))));
          acc += src[sy * w + sx];
        }
        img[y * w + x] = acc / n;
      }
    }
  }
  const blurred = gaussianBlur(img, w, h, blur);
  const gray = new Uint8Array(w * h);
  const data = new Uint8ClampedArray(w * h * 4);
  // Таблица нормальных отсчётов: генерировать Бокса–Мюллера на каждый пиксель дорого.
  const table = new Float32Array(1 << 16);
  if (noise > 0) for (let i = 0; i < table.length; i++) table[i] = gauss(rng);
  for (let i = 0; i < w * h; i++) {
    const v = blurred[i] + (noise > 0 ? noise * table[(rng() * 65536) | 0] : 0);
    const g = Math.max(0, Math.min(255, Math.round(v)));
    gray[i] = g;
    // Лёгкий цветовой оттенок, чтобы проверять путь RGBA → яркость.
    data[i * 4] = Math.min(255, g + 6);
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = Math.max(0, g - 6);
    data[i * 4 + 3] = 255;
  }
  const corners = [[0, 0], [size, 0], [size, size], [0, size]].map(([u, v]) => {
    const [X, Y] = apply(H, u, v);
    const f = 1 + (barrel * ((X - w / 2) ** 2 + (Y - h / 2) ** 2)) / R2;
    return [w / 2 + (X - w / 2) * f, h / 2 + (Y - h / 2) * f];
  });
  return { data, width: w, height: h, gray, corners };
}

// Минимальный декодер PNG: 8 бит, оттенки серого (тип 0), без чересстрочности.
export function decodeGrayPng(buf) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) throw new Error('PNG: неверная сигнатура');
  let pos = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8 || body[9] !== 0 || body[12] !== 0) throw new Error('PNG: ожидается 8-битный серый без чересстрочности');
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const gray = new Uint8Array(width * height);
  let prev = new Uint8Array(width);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (width + 1)];
    const line = raw.subarray(y * (width + 1) + 1, (y + 1) * (width + 1));
    const cur = new Uint8Array(width);
    for (let x = 0; x < width; x++) {
      const a = x > 0 ? cur[x - 1] : 0;
      const b = prev[x];
      const c = x > 0 ? prev[x - 1] : 0;
      let pred = 0;
      if (f === 1) pred = a;
      else if (f === 2) pred = b;
      else if (f === 3) pred = (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = (line[x] + pred) & 0xff;
    }
    gray.set(cur, y * width);
    prev = cur;
  }
  return { width, height, gray };
}

// Серые пиксели → RGBA, как отдаёт canvas.getImageData.
export function grayToRgba(gray) {
  const data = new Uint8ClampedArray(gray.length * 4);
  for (let i = 0; i < gray.length; i++) {
    data[i * 4] = gray[i];
    data[i * 4 + 1] = gray[i];
    data[i * 4 + 2] = gray[i];
    data[i * 4 + 3] = 255;
  }
  return data;
}

// Base45 (RFC 9285) — алфавит совпадает с алфавитом alphanumeric-режима QR.
const B45 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
export function base45(bytes) {
  let out = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    let x = bytes[i] * 256 + bytes[i + 1];
    const c = x % 45;
    x = (x - c) / 45;
    out += B45[c] + B45[x % 45] + B45[Math.floor(x / 45)];
  }
  if (bytes.length % 2) {
    const v = bytes[bytes.length - 1];
    out += B45[v % 45] + B45[Math.floor(v / 45)];
  }
  return out;
}

// Строка формата приложения: «UM1:ABCD:3:12:» + base45 случайных байтов, длиной length.
export function makeTransferText(rng, length) {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let id = '';
  for (let i = 0; i < 4; i++) id += letters[Math.floor(rng() * 26)];
  const head = `UM1:${id}:${1 + Math.floor(rng() * 9)}:${1 + Math.floor(rng() * 30)}:`;
  const raw = new Uint8Array(Math.ceil(((length - head.length) * 2) / 3) + 2);
  for (let i = 0; i < raw.length; i++) raw[i] = Math.floor(rng() * 256);
  return (head + base45(raw)).slice(0, length);
}
