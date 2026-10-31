// QR на экране: проигрыватель серии кодов и сканер камерой второго устройства.
// Генератор и считыватель — свои (js/transfer/qr-encode.js, qr-decode.js), без библиотек и сети.

import { h } from '../dom.js';
import { encodeQR } from '../../transfer/qr-encode.js';
import { decodeQR } from '../../transfer/qr-decode.js';

function drawMatrix(canvas, qr) {
  const quiet = 4;
  const modules = qr.size + quiet * 2;
  const scale = Math.max(2, Math.floor(840 / modules));
  const px = modules * scale;
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = '#000000';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y * qr.size + x]) ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
    }
  }
}

/** Серия QR-кодов, сменяющих друг друга. Скорость регулируется, можно листать вручную. */
export function qrPlayer(chunks, { speed = 700, onSpeed } = {}) {
  const codes = chunks.map((text) => encodeQR(text, { ecl: 'M' }));
  let index = 0;
  let playing = chunks.length > 1;
  let timer = null;
  let interval = speed;

  const canvas = h('canvas', { class: 'qr-canvas', role: 'img' });
  const caption = h('p', { class: 'center', style: { fontWeight: 800, margin: 0 } });
  const parts = h('ol', { class: 'qr-parts', 'aria-hidden': 'true' },
    chunks.map((_, i) => h('li', null, String(i + 1))));
  const playBtn = h('button', { type: 'button', class: 'btn btn--secondary btn--small', onClick: () => toggle() });
  const prevBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--small', 'aria-label': 'Предыдущий код', onClick: () => step(-1) }, '◀');
  const nextBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--small', 'aria-label': 'Следующий код', onClick: () => step(1) }, '▶');
  const slower = h('button', { type: 'button', class: 'btn btn--ghost btn--small', onClick: () => setSpeed(interval + 200) }, 'Медленнее');
  const faster = h('button', { type: 'button', class: 'btn btn--ghost btn--small', onClick: () => setSpeed(interval - 200) }, 'Быстрее');

  const show = () => {
    drawMatrix(canvas, codes[index]);
    canvas.setAttribute('aria-label', `QR-код ${index + 1} из ${codes.length}`);
    caption.textContent = codes.length > 1 ? `Код ${index + 1} из ${codes.length}` : 'Один QR-код';
    [...parts.children].forEach((li, i) => li.classList.toggle('is-current', i === index));
  };
  const schedule = () => {
    clearInterval(timer);
    if (playing && codes.length > 1) {
      timer = setInterval(() => {
        index = (index + 1) % codes.length;
        show();
      }, interval);
    }
    playBtn.textContent = playing ? '⏸ Пауза' : '▶ Листать сами';
  };
  const toggle = () => {
    playing = !playing;
    schedule();
  };
  const step = (d) => {
    playing = false;
    index = (index + d + codes.length) % codes.length;
    show();
    schedule();
  };
  const setSpeed = (ms) => {
    interval = Math.max(300, Math.min(2500, ms));
    onSpeed?.(interval);
    schedule();
  };

  show();
  schedule();
  const multi = codes.length > 1;
  const el = h('div', { class: 'qr-box' },
    canvas,
    caption,
    multi && parts,
    multi && h('div', { class: 'btn-row', style: { justifyContent: 'center' } }, prevBtn, playBtn, nextBtn),
    multi && h('div', { class: 'btn-row', style: { justifyContent: 'center' } }, slower, faster));
  return {
    el,
    version: Math.max(...codes.map((c) => c.version)),
    destroy: () => clearInterval(timer),
  };
}

// ---------- распознавание ----------

let worker = null;
let workerBroken = false;
let jobId = 0;
const pending = new Map();

function getWorker() {
  if (worker || workerBroken) return worker;
  try {
    worker = new Worker(new URL('../../transfer/qr-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const job = pending.get(e.data.id);
      pending.delete(e.data.id);
      job?.(e.data.text);
    };
    worker.onerror = () => {
      workerBroken = true;
      worker = null;
      for (const job of pending.values()) job(undefined);
      pending.clear();
    };
  } catch {
    workerBroken = true;
    worker = null;
  }
  return worker;
}

/** Распознать кадр: в воркере, а если он недоступен — прямо здесь. */
export function decodeImageData(imageData) {
  const w = getWorker();
  if (!w) {
    try {
      return Promise.resolve(decodeQR(imageData)?.text ?? null);
    } catch {
      return Promise.resolve(null);
    }
  }
  return new Promise((resolve) => {
    const id = ++jobId;
    pending.set(id, (text) => {
      if (text === undefined) {
        // воркер упал — повторяем в основном потоке
        try {
          resolve(decodeQR(imageData)?.text ?? null);
        } catch {
          resolve(null);
        }
      } else {
        resolve(text);
      }
    });
    const copy = new Uint8ClampedArray(imageData.data);
    w.postMessage({ id, width: imageData.width, height: imageData.height, buffer: copy.buffer }, [copy.buffer]);
  });
}

function frameToImageData(source, width, height, maxSide = 1280) {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const hgt = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = hgt;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, hgt);
  return ctx.getImageData(0, 0, w, hgt);
}

/** Распознать QR на фотографии (запасной путь, если камера недоступна). */
export async function decodeImageFile(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Не удалось открыть изображение'));
      el.src = url;
    });
    for (const side of [1600, 1000, 2400]) {
      const text = await decodeImageData(frameToImageData(img, img.naturalWidth, img.naturalHeight, side));
      if (text) return text;
    }
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Сканер с камеры. onText(text) вызывается для каждого распознанного кода.
 * Возвращает { el, start(), stop() }.
 */
export function qrScanner({ onText, onError } = {}) {
  const video = h('video', { playsinline: true, muted: true, autoplay: true, 'aria-label': 'Изображение с камеры' });
  video.setAttribute('playsinline', '');
  video.muted = true;
  const el = h('div', { class: 'scanner' }, video, h('div', { class: 'scanner__frame', 'aria-hidden': 'true' }));
  let stream = null;
  let running = false;
  let busy = false;
  let timer = null;

  const tick = async () => {
    if (!running) return;
    if (!busy && video.readyState >= 2 && video.videoWidth) {
      busy = true;
      try {
        const text = await decodeImageData(frameToImageData(video, video.videoWidth, video.videoHeight));
        if (text && running) onText?.(text);
      } catch {
        // пропускаем кадр
      }
      busy = false;
    }
    if (running) timer = setTimeout(tick, 60);
  };

  return {
    el,
    async start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        onError?.('На этом устройстве нет доступа к камере из браузера. Используйте код или файл.');
        return false;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
      } catch (err) {
        const denied = err?.name === 'NotAllowedError' || err?.name === 'SecurityError';
        onError?.(denied
          ? 'Нет разрешения на камеру. Разрешите доступ в настройках браузера или перенесите данные кодом.'
          : 'Камера не включилась. Попробуйте ещё раз или перенесите данные кодом.');
        return false;
      }
      video.srcObject = stream;
      try {
        await video.play();
      } catch {
        // iOS иногда требует жеста — видео всё равно запустится
      }
      running = true;
      tick();
      return true;
    },
    stop() {
      running = false;
      clearTimeout(timer);
      for (const track of stream?.getTracks() ?? []) track.stop();
      stream = null;
      video.srcObject = null;
    },
  };
}
