// Адаптивная диагностика при первом запуске: до 20 примеров и не дольше 5 минут.
//
// Скрытое состояние — какие из 10 столбцов (×1 … ×10) ребёнок уже знает: 2^10 = 1024 гипотезы.
// Факт a × b считается известным, если известен столбец a ИЛИ столбец b — так в модель
// встроена перестановка множителей (3 × 7 = 7 × 3). После каждого ответа апостериорное
// распределение пересчитывается по формуле Байеса.
//
// Выбор следующего примера:
//  1) «граница сложности» растёт только после верных ответов — примеры идут от лёгких к трудным,
//     а кандидаты берутся из «окна» шириной 4 под границей, чтобы не откатываться к совсем лёгким;
//  2) из окна берём пример, ответ на который даст больше всего информации
//     (вероятность «знает» ближе всего к неопределённости), с лёгким сдвигом к более трудным;
//  3) после двух промахов подряд граница отступает, а следующий пример — из тех, что ребёнок
//     скорее всего знает: так диагностика не превращается в череду неудач.

import { ALL_FACT_IDS, COLUMN_ORDER, FACTORS, columnFacts, difficulty, pairId, parseFactId } from './facts.js';
import { SLOW_MS, intervalFor } from './leitner.js';
import { PLACED, applyAnswer, isMastered } from './knowledge.js';
import { dayNumber, nowSec } from './dates.js';

export const DIAG_ITEMS = 20;
export const DIAG_MAX_MS = 5 * 60 * 1000;
/** После стольких промахов подряд заканчиваем раньше: дальше будем учить, а не проверять. */
export const DIAG_MAX_MISSES = 5;
/** С какой вероятности непроверенный факт отмечаем как известный. */
export const KNOWN_THRESHOLD = 0.85;
export const START_FRONTIER = 2.5;
/** Ширина окна кандидатов под границей сложности. */
export const WINDOW = 4;
/** Насколько отступает граница после промаха. */
export const MISS_STEP = 0.75;
/** «Поддерживающий» пример после двух промахов подряд: P(знает) не ниже этого. */
export const BOOST_PROBABILITY = 0.7;

/** Априорная вероятность знать столбец у ребёнка 7–10 лет. */
const COLUMN_PRIOR = { 1: 0.85, 10: 0.8, 2: 0.7, 5: 0.65, 9: 0.4, 3: 0.5, 4: 0.45, 6: 0.35, 7: 0.3, 8: 0.3 };
/**
 * Доля «лестничной» составляющей априорного распределения: знает первые k столбцов по порядку.
 * Она связывает столбцы: верно решённый ×7 повышает веру в ×2.
 */
const PREFIX_WEIGHT = 0.4;
const STATES = 1 << 10;

/** P(категория ответа | факт известен / неизвестен). */
export const LIKELIHOOD = Object.freeze({
  known: { fast: 0.82, slow: 0.12, wrong: 0.06 },
  unknown: { fast: 0.08, slow: 0.22, wrong: 0.7 },
});
/**
 * Квадраты (3 × 3, 7 × 7) дети часто помнят отдельно от столбца,
 * поэтому верный ответ на квадрат — более слабое свидетельство о знании всего столбца.
 */
const SQUARE_UNKNOWN = Object.freeze({ fast: 0.3, slow: 0.2, wrong: 0.5 });
const CATEGORIES = ['fast', 'slow', 'wrong'];

export function likelihoodsFor(id) {
  const { a, b } = parseFactId(id);
  const square = a === b && a !== 1 && a !== 10;
  return { known: LIKELIHOOD.known, unknown: square ? SQUARE_UNKNOWN : LIKELIHOOD.unknown };
}

const bit = (v) => 1 << (v - 1);

export function factMask(id) {
  const { a, b } = parseFactId(id);
  return bit(a) | bit(b);
}

function buildPrior() {
  const prior = new Float64Array(STATES);
  for (let s = 0; s < STATES; s++) {
    let p = 1;
    for (const v of FACTORS) p *= s & bit(v) ? COLUMN_PRIOR[v] : 1 - COLUMN_PRIOR[v];
    prior[s] = (1 - PREFIX_WEIGHT) * p;
  }
  let mask = 0;
  prior[0] += PREFIX_WEIGHT / 11;
  for (const v of COLUMN_ORDER) {
    mask |= bit(v);
    prior[mask] += PREFIX_WEIGHT / 11;
  }
  return prior;
}

export function responseCategory(correct, ms) {
  if (!correct) return 'wrong';
  return ms <= SLOW_MS ? 'fast' : 'slow';
}

/**
 * Ожидаемая информация (в битах) от вопроса, если P(знает) = pk.
 * Ответ зависит от состояния только через «знает / не знает», поэтому I(ответ; состояние) = I(ответ; знает).
 */
export function expectedInfoGain(pk, lik = LIKELIHOOD) {
  let hAnswer = 0;
  let hGiven = 0;
  for (const c of CATEGORIES) {
    const lk = lik.known[c];
    const lu = lik.unknown[c];
    const p = pk * lk + (1 - pk) * lu;
    if (p > 0) hAnswer -= p * Math.log2(p);
    hGiven -= pk * lk * Math.log2(lk) + (1 - pk) * lu * Math.log2(lu);
  }
  return hAnswer - hGiven;
}

export class Diagnostic {
  constructor({
    rng = Math.random,
    maxItems = DIAG_ITEMS,
    maxMs = DIAG_MAX_MS,
    maxMisses = DIAG_MAX_MISSES,
  } = {}) {
    this.rng = rng;
    this.maxItems = maxItems;
    this.maxMs = maxMs;
    this.maxMisses = maxMisses;
    this.post = buildPrior();
    this.frontier = START_FRONTIER;
    this.misses = 0;
    this.answers = [];
    this.stopReason = null;
  }

  get count() {
    return this.answers.length;
  }

  isFinished(elapsedMs = 0) {
    if (this.answers.length >= this.maxItems) this.stopReason = 'items';
    else if (elapsedMs >= this.maxMs) this.stopReason = 'time';
    else if (this.misses >= this.maxMisses) this.stopReason = 'misses';
    else return false;
    return true;
  }

  probabilityOfMask(mask) {
    let p = 0;
    for (let s = 0; s < STATES; s++) if (s & mask) p += this.post[s];
    return p;
  }

  probabilityKnown(id) {
    return this.probabilityOfMask(factMask(id));
  }

  columnProbability(k) {
    return this.probabilityOfMask(bit(k));
  }

  /** Следующий пример (id факта) или null, если диагностика закончена. */
  next(elapsedMs = 0) {
    if (this.isFinished(elapsedMs)) return null;
    const asked = new Set();
    for (const a of this.answers) {
      asked.add(a.id);
      asked.add(pairId(a.id));
    }
    const open = ALL_FACT_IDS.filter((id) => !asked.has(id));
    if (!open.length) {
      this.stopReason = 'items';
      return null;
    }
    const low = this.frontier - WINDOW;
    let candidates = open.filter((id) => {
      const d = difficulty(id);
      return d <= this.frontier && d >= low;
    });
    if (!candidates.length) {
      // Окно исчерпано — берём ближайшие к нему примеры.
      const gap = (id) => {
        const d = difficulty(id);
        return d > this.frontier ? d - this.frontier : d < low ? low - d : 0;
      };
      candidates = open.slice().sort((x, y) => gap(x) - gap(y)).slice(0, 8);
    }
    if (this.misses >= 2) {
      // Поддержка: пример, который ребёнок скорее всего знает (сложность здесь не ограничиваем —
      // так диагностика находит и столбцы, выученные «не по нашему» порядку).
      const likely = open.filter((id) => this.probabilityKnown(id) >= BOOST_PROBABILITY);
      if (likely.length) candidates = likely;
    }
    let best = null;
    let bestScore = -Infinity;
    for (const id of candidates) {
      const score = expectedInfoGain(this.probabilityKnown(id), likelihoodsFor(id))
        + 0.02 * difficulty(id)
        + this.rng() * 0.004;
      if (score > bestScore) {
        bestScore = score;
        best = id;
      }
    }
    return best;
  }

  /** Записать ответ: correct — верно ли, ms — время, given — что ввёл ребёнок (null — «не знаю»). */
  record(id, { correct, ms, given = null }) {
    const category = responseCategory(correct, ms);
    const mask = factMask(id);
    const lik = likelihoodsFor(id);
    const lk = lik.known[category];
    const lu = lik.unknown[category];
    let z = 0;
    for (let s = 0; s < STATES; s++) {
      this.post[s] *= s & mask ? lk : lu;
      z += this.post[s];
    }
    for (let s = 0; s < STATES; s++) this.post[s] /= z;

    const d = difficulty(id);
    if (category === 'fast') this.frontier = Math.max(this.frontier, d + 1.5);
    else if (category === 'slow') this.frontier = Math.max(this.frontier, d + 0.7);
    else this.frontier = Math.max(START_FRONTIER, this.frontier - MISS_STEP);
    this.misses = category === 'wrong' ? this.misses + 1 : 0;
    this.answers.push({ id, correct: Boolean(correct), ms: Math.round(ms), given, category });
    return category;
  }

  result() {
    const probs = {};
    for (const id of ALL_FACT_IDS) probs[id] = this.probabilityKnown(id);
    const columns = {};
    for (const k of FACTORS) columns[k] = this.columnProbability(k);
    return { answers: this.answers.slice(), probs, columns, stopReason: this.stopReason };
  }
}

function place(f, kind, today, t) {
  f.introduced = true;
  f.streak = Math.max(f.streak, 3);
  if (kind === PLACED.TESTED) {
    f.box = 3;
    f.due = today + intervalFor(3);
  } else {
    f.box = 2;
    f.due = today + intervalFor(2);
  }
  f.placed = kind;
  f.updatedAt = t;
}

/**
 * Переносит итог диагностики в профиль:
 *  - решён быстро (≤ 6 с) → «знает», коробка 3 (диагностика засчитывает серию из трёх);
 *  - решён медленно → «изучается», коробка 1;
 *  - ошибка или «не знаю» → остаётся «новым», его объясним;
 *  - не спрашивали, но пара решена быстро или P(знает) ≥ 0,85 → «знает», коробка 2 (проверим завтра).
 */
export function applyDiagnostic(profile, result, { now = Date.now(), sessionId = '', durationMs = 0 } = {}) {
  const today = dayNumber(now);
  const t = nowSec(now);
  const facts = profile.facts;
  const direct = new Map(result.answers.map((a) => [a.id, a]));

  for (const a of result.answers) {
    applyAnswer(facts[a.id], {
      correct: a.correct,
      ms: a.ms,
      format: 'diagnostic',
      given: a.given,
      now,
      sessionId,
      introduce: false,
    });
  }

  for (const id of ALL_FACT_IDS) {
    const f = facts[id];
    const own = direct.get(id);
    const pair = direct.get(pairId(id));
    if (own) {
      if (own.category === 'fast') {
        place(f, PLACED.TESTED, today, t);
      } else if (own.category === 'slow') {
        f.introduced = true;
        f.box = 1;
        f.due = today;
      } else {
        f.introduced = false;
        f.box = 1;
        f.due = today;
        f.streak = 0;
      }
    } else if (pair && pair.category === 'fast') {
      place(f, PLACED.INFERRED, today, t);
    } else if ((!pair || pair.category !== 'wrong') && result.probs[id] >= KNOWN_THRESHOLD) {
      place(f, PLACED.INFERRED, today, t);
    }
  }

  const columns = new Set(profile.introducedColumns);
  for (const k of FACTORS) {
    const allKnown = columnFacts(k).every((id) => isMastered(facts[id]));
    if (allKnown || result.columns[k] >= KNOWN_THRESHOLD) columns.add(k);
  }
  profile.introducedColumns = COLUMN_ORDER.filter((k) => columns.has(k));

  const known = ALL_FACT_IDS.filter((id) => isMastered(facts[id]));
  profile.diagnostic = {
    at: t,
    items: result.answers.length,
    known: known.length,
    durationMs: Math.round(durationMs),
  };
  return { known, correct: result.answers.filter((a) => a.correct).length };
}
