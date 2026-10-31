// Распознавание QR в отдельном потоке: кадр камеры не тормозит интерфейс.

import { decodeQR } from './qr-decode.js';

self.onmessage = (event) => {
  const { id, width, height, buffer } = event.data;
  let text = null;
  try {
    const result = decodeQR({ data: new Uint8ClampedArray(buffer), width, height });
    text = result?.text ?? null;
  } catch {
    text = null;
  }
  self.postMessage({ id, text, buffer }, [buffer]);
};
