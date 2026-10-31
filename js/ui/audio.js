// Мягкие звуки через Web Audio API: синус и треугольник с плавной огибающей, тихо и коротко.
// Звук ошибки — спокойные две ноты вниз, без «зуммера».

let ctx = null;
let enabled = true;

function context() {
  if (!ctx) {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

function tone(freq, start, duration, { type = 'sine', gain = 0.12 } = {}) {
  const c = context();
  if (!c) return;
  const t0 = c.currentTime + start;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(g);
  g.connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.05);
}

const SOUNDS = {
  tap: () => tone(620, 0, 0.07, { gain: 0.04 }),
  correct: () => {
    tone(659.25, 0, 0.18, { gain: 0.1 });
    tone(880, 0.09, 0.26, { gain: 0.1 });
  },
  gentle: () => {
    tone(392, 0, 0.24, { type: 'triangle', gain: 0.07 });
    tone(329.63, 0.13, 0.32, { type: 'triangle', gain: 0.06 });
  },
  fixed: () => {
    tone(523.25, 0, 0.16, { gain: 0.08 });
    tone(659.25, 0.08, 0.22, { gain: 0.08 });
  },
  complete: () => [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, i * 0.1, 0.32, { gain: 0.09 })),
  badge: () => [783.99, 987.77, 1174.66].forEach((f, i) => tone(f, i * 0.08, 0.36, { type: 'triangle', gain: 0.08 })),
  start: () => {
    tone(523.25, 0, 0.14, { gain: 0.08 });
    tone(783.99, 0.1, 0.22, { gain: 0.08 });
  },
  tick: () => tone(880, 0, 0.05, { gain: 0.03 }),
  scan: () => tone(1046.5, 0, 0.08, { type: 'triangle', gain: 0.05 }),
};

/** «7 × 8 = ?» → «7 умножить на 8 — сколько будет?» — так пример звучит естественно. */
export function mathToSpeech(text) {
  return String(text)
    .replace(/(\d+|\?) × (\d+|\?) = (\d+|\?)/g, (m, a, b, c) => {
      if (a === '?') return `какое число умножить на ${b}, чтобы получилось ${c}?`;
      if (b === '?') return `${a} умножить на какое число будет ${c}?`;
      if (c === '?') return `${a} умножить на ${b} — сколько будет?`;
      return `${a} умножить на ${b} равно ${c}`;
    })
    .replace(/×/g, ' умножить на ')
    .replace(/=/g, ' равно ');
}

/**
 * Чтение вслух встроенным синтезом речи (голоса устройства, работает без интернета).
 * Помогает ребёнку, который ещё медленно читает, заниматься без взрослого.
 */
export const voice = {
  get available() {
    return typeof globalThis.speechSynthesis !== 'undefined' && typeof globalThis.SpeechSynthesisUtterance === 'function';
  },
  speak(text) {
    if (!this.available) return false;
    const synth = globalThis.speechSynthesis;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(mathToSpeech(text));
    u.lang = 'ru-RU';
    const ru = synth.getVoices().find((v) => v.lang?.toLowerCase().startsWith('ru'));
    if (ru) u.voice = ru;
    u.rate = 0.95;
    synth.speak(u);
    return true;
  },
  stop() {
    if (this.available) globalThis.speechSynthesis.cancel();
  },
};

export const sound = {
  get enabled() {
    return enabled;
  },
  set enabled(value) {
    enabled = Boolean(value);
  },
  /** Браузеры (особенно iOS) разрешают звук только после касания — «будим» контекст при первом жесте. */
  unlock() {
    if (enabled) context();
  },
  play(name) {
    if (!enabled) return;
    try {
      SOUNDS[name]?.();
    } catch {
      // звук — не главное: ошибки аудио не мешают занятию
    }
  },
};
