// Модель знания одного факта: история ответов, статистика, коробка Лейтнера, статус.

import { dayNumber, nowSec } from './dates.js';
import { STATUS } from './facts.js';
import { FAST_MS, SLOW_MS, clampBox, scheduleAfterAnswer } from './leitner.js';

/** Сколько последних ответов хранить в истории факта. */
export const HISTORY_LIMIT = 12;
/** Время ответа для средней статистики обрезаем: отвлёкшийся ребёнок не должен портить среднее. */
export const STAT_MS_CAP = 30000;

/** Коды форматов в истории ответов. */
export const FORMAT_CODES = Object.freeze({
  input: 0,
  choice: 1,
  missing: 2,
  truefalse: 3,
  blitz: 4,
  diagnostic: 5,
});
export const FORMAT_BY_CODE = Object.freeze(
  Object.fromEntries(Object.entries(FORMAT_CODES).map(([k, v]) => [v, k]))
);

/** Форматы-воспроизведения (ребёнок сам вспоминает число) — только они идут в зачёт автоматизма. */
export const RECALL_FORMATS = new Set(['input', 'missing', 'blitz', 'diagnostic']);

/** Метка, как факт попал в «знает» без трёх ответов подряд: 1 — решён в диагностике, 2 — выведен. */
export const PLACED = Object.freeze({ NONE: 0, TESTED: 1, INFERRED: 2 });

export function createFactState() {
  return {
    introduced: false,
    box: 1,
    streak: 0,
    due: 0,
    attempts: 0,
    correct: 0,
    errors: 0,
    slow: 0,
    totalMs: 0,
    autoRun: 0,
    autoStart: 0,
    autoLast: 0,
    autoSession: '',
    placed: 0,
    lastSeen: 0,
    updatedAt: 0,
    // [время (с), длительность (мс), верно 1/0, код формата, ответ ребёнка или −1 («не знаю»)]
    history: [],
  };
}

/**
 * Статус выводится из полей, а не хранится отдельно:
 *  новый — факт ещё не вводили;
 *  изучается — введён, но меньше 3 верных подряд;
 *  знает — 3 верных подряд;
 *  автоматизм — знает и отвечает верно быстрее 3 с в 3 сессиях подряд минимум в 2 разных дня.
 */
export function factStatus(f) {
  if (!f.introduced) return STATUS.NEW;
  if (f.streak >= 3 && f.autoRun >= 3 && f.autoLast > f.autoStart) return STATUS.AUTO;
  if (f.streak >= 3) return STATUS.KNOWN;
  return STATUS.LEARNING;
}

export function isMastered(f) {
  const s = factStatus(f);
  return s === STATUS.KNOWN || s === STATUS.AUTO;
}

export function accuracy(f) {
  return f.attempts ? f.correct / f.attempts : null;
}

export function averageMs(f) {
  return f.attempts ? f.totalMs / f.attempts : null;
}

/** Ответы ребёнка с ошибками (самые свежие — первыми). */
export function wrongAnswers(f) {
  return f.history.filter((h) => !h[2]).map((h) => h[4]).reverse();
}

/**
 * Учёт автоматизма. Сессия засчитывается факту, если все ответы-воспроизведения в ней
 * верны и быстрее 3 с. Сессии, где факт не встречался, серию не прерывают.
 */
function updateAutomaticity(f, { correct, ms, format, sessionId, today }) {
  if (!correct) {
    f.autoRun = 0;
    if (sessionId) f.autoSession = sessionId;
    return;
  }
  if (!RECALL_FORMATS.has(format)) return;
  const fast = ms < FAST_MS;
  if (sessionId && f.autoSession === sessionId) {
    // В этой сессии факт уже был: медленный ответ лишает сессию зачёта.
    if (!fast) f.autoRun = 0;
    return;
  }
  f.autoSession = sessionId || '';
  if (fast) {
    if (f.autoRun === 0) f.autoStart = today;
    f.autoRun += 1;
    f.autoLast = today;
  } else {
    f.autoRun = 0;
  }
}

/**
 * Записывает ответ в факт (изменяет объект) и возвращает, что поменялось.
 * answer: { correct, ms, format, given, now, sessionId, introduce }
 */
export function applyAnswer(f, answer) {
  const {
    correct,
    ms,
    format = 'input',
    given = null,
    now = Date.now(),
    sessionId = '',
    introduce = true,
  } = answer;
  const today = dayNumber(now);
  const t = nowSec(now);
  const time = Math.max(0, Math.min(Math.round(ms), 600000));
  const before = { box: f.box, status: factStatus(f), streak: f.streak };

  f.history.push([t, time, correct ? 1 : 0, FORMAT_CODES[format] ?? 0, given == null ? -1 : given]);
  if (f.history.length > HISTORY_LIMIT) f.history.splice(0, f.history.length - HISTORY_LIMIT);

  f.attempts += 1;
  f.totalMs += Math.min(time, STAT_MS_CAP);
  if (correct) {
    f.correct += 1;
    if (time > SLOW_MS) f.slow += 1;
  } else {
    f.errors += 1;
  }
  f.streak = correct ? f.streak + 1 : 0;

  const sched = scheduleAfterAnswer(f, { correct, ms: time }, today);
  f.box = sched.box;
  f.due = sched.due;

  updateAutomaticity(f, { correct, ms: time, format, sessionId, today });
  if (introduce) f.introduced = true;
  f.lastSeen = t;
  f.updatedAt = t;

  const after = { box: f.box, status: factStatus(f), streak: f.streak };
  return { before, after, move: sched.move };
}

/**
 * Насколько факт «слабый» — чем больше, тем нужнее практика.
 * Учитываем ошибки и медленные ответы среди последних пяти, общую точность и низкую коробку.
 */
export function weakness(f, today) {
  if (!f.introduced) return 0;
  const recent = f.history.slice(-5);
  let errors = 0;
  let slow = 0;
  for (const h of recent) {
    if (!h[2]) errors += 1;
    else if (h[1] > SLOW_MS) slow += 1;
  }
  // Факт, отмеченный диагностикой без единого ответа, слабым не считаем — данных о слабости нет.
  const acc = f.attempts ? f.correct / f.attempts : 1;
  let score = errors * 3 + slow * 1.5 + (1 - acc) * 2;
  const box = clampBox(f.box);
  if (box === 1) score += 3;
  else if (box === 2) score += 1.5;
  if (f.streak < 3) score += 2;
  if (f.due <= today) score += 0.5;
  return score;
}

export const WEAK_THRESHOLD = 3;
