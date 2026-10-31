// Справочник 100 фактов a × b (a, b = 1…10).
// Запись a × b читаем как в российской школе: «a взять b раз» = b групп по a.
// Столбец «×k» — это факты n × k (n = 1…10), то есть столбец k сетки 10×10.

import { plural } from './dates.js';

export const FACTORS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/** Порядок введения столбцов: от простых правил к трудным. */
export const COLUMN_ORDER = [1, 10, 2, 5, 9, 3, 4, 6, 7, 8];

export const COLUMN_RANK = Object.freeze(
  Object.fromEntries(COLUMN_ORDER.map((k, i) => [k, i]))
);

export const STATUS = Object.freeze({
  NEW: 'new',
  LEARNING: 'learning',
  KNOWN: 'known',
  AUTO: 'auto',
});

export const STATUS_LABELS = Object.freeze({
  new: 'новый',
  learning: 'изучается',
  known: 'знает',
  auto: 'автоматизм',
});

export function factId(a, b) {
  return `${a}x${b}`;
}

export function parseFactId(id) {
  const [a, b] = id.split('x').map(Number);
  return { a, b };
}

/** Все факты построчно: 1x1, 1x2, …, 10x10. */
export const ALL_FACT_IDS = Object.freeze(
  FACTORS.flatMap((a) => FACTORS.map((b) => factId(a, b)))
);

export function isFactId(id) {
  if (typeof id !== 'string') return false;
  const m = /^(\d{1,2})x(\d{1,2})$/.exec(id);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a >= 1 && a <= 10 && b >= 1 && b <= 10 && id === factId(a, b);
}

/** Пара с переставленными множителями: 3x7 ↔ 7x3 (у квадратов пара — сам факт). */
export function pairId(id) {
  const { a, b } = parseFactId(id);
  return factId(b, a);
}

export function columnOf(id) {
  return parseFactId(id).b;
}

export function columnFacts(k) {
  return FACTORS.map((n) => factId(n, k));
}

export function product(id) {
  const { a, b } = parseFactId(id);
  return a * b;
}

/**
 * Типичная трудность факта (шкала примерно от −0,6 до 9,5).
 * Главное — более «лёгкий» из двух множителей (ведь 7 × 2 = 2 × 7 решается удвоением),
 * немного добавляет величина второго множителя, квадраты запоминаются легче.
 */
export function difficulty(id) {
  const { a, b } = parseFactId(id);
  const ra = COLUMN_RANK[a];
  const rb = COLUMN_RANK[b];
  const lo = Math.min(ra, rb);
  const hi = Math.max(ra, rb);
  return lo + 0.12 * hi - (a === b ? 0.6 : 0);
}

/** Текст приёма «×k» для числа n (то есть для n × k). */
export function trickText(k, n) {
  switch (k) {
    case 1:
      return `Умножить на 1 — число не меняется: ${n} × 1 = ${n}.`;
    case 10:
      return `Умножить на 10 — припиши к числу ноль: ${n} × 10 = ${n * 10}.`;
    case 2:
      return `Умножить на 2 — значит удвоить: ${n} + ${n} = ${n * 2}.`;
    case 4:
      return `Умножить на 4 — удвой два раза: ${n} → ${n * 2} → ${n * 4}.`;
    case 5:
      return `Умножить на 5 — это половина от ×10: ${n} × 10 = ${n * 10}, половина — ${n * 5}.`;
    case 9:
      return `Пальцы для ×9: загни ${n}-й палец. Слева ${n - 1} — это десятки, справа ${10 - n} — единицы: ${n * 9}.`;
    case 3:
      return `Умножить на 3 — удвой и прибавь ещё раз: ${n * 2} + ${n} = ${n * 3}.`;
    case 6:
      return `Умножить на 6 — это ×5 и ещё один раз: ${n * 5} + ${n} = ${n * 6}.`;
    case 7:
      return `Умножить на 7 — это ×5 и ×2: ${n * 5} + ${n * 2} = ${n * 7}.`;
    case 8:
      return `Умножить на 8 — удвой три раза: ${n} → ${n * 2} → ${n * 4} → ${n * 8}.`;
    default:
      return `${n} × ${k} = ${n * k}.`;
  }
}

/**
 * Подсказка-приём для факта a × b: берём множитель с более простым приёмом,
 * при необходимости через перестановку множителей.
 */
export function trickFor(a, b) {
  const swapped = a !== b && COLUMN_RANK[a] < COLUMN_RANK[b];
  const k = swapped ? a : b;
  const n = swapped ? b : a;
  const base = trickText(k, n);
  const text = swapped
    ? `Поменяй множители местами: ${a} × ${b} = ${b} × ${a}. ${base}`
    : base;
  return { k, n, swapped, text };
}

/** Короткое название приёма столбца для экранов объяснения. */
export const COLUMN_TRICK_TITLES = Object.freeze({
  1: 'Умножение на 1',
  10: 'Припиши ноль',
  2: 'Удвоение',
  5: 'Половина от ×10',
  9: 'Пальцы для ×9',
  3: 'Удвой и прибавь',
  4: 'Удвой два раза',
  6: '×5 и ещё раз',
  7: '×5 и ×2',
  8: 'Удвой три раза',
});

/** Пример, на котором объясняем столбец: небольшой, чтобы точки и прыжки помещались на экране. */
const INTRO_SAMPLE = { 1: 4, 10: 2, 2: 4, 5: 3, 9: 3, 3: 4, 4: 3, 6: 3, 7: 3, 8: 3 };

export function groupsWord(k) {
  return plural(k, ['группа', 'группы', 'групп']);
}

/** Сумма n + n + … (k раз) — длинные суммы сокращаем. */
export function repeatedSum(n, k) {
  if (k === 1) return `${n}`;
  if (k <= 6) return Array(k).fill(n).join(' + ');
  return `${n} + ${n} + … + ${n} (${k} ${plural(k, ['раз', 'раза', 'раз'])})`;
}

export function columnIntro(k) {
  const n = INTRO_SAMPLE[k] ?? 3;
  return {
    k,
    n,
    product: n * k,
    title: `Учим ×${k}`,
    trickTitle: COLUMN_TRICK_TITLES[k],
    groupsText: `${n} × ${k} — это ${k} ${groupsWord(k)} по ${n}.`,
    sumText: `${repeatedSum(n, k)} = ${n * k}`,
    trick: trickText(k, n),
    swapText: `${n} × ${k} = ${k} × ${n} = ${n * k}`,
  };
}
