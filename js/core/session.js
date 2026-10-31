// Сборка и проведение занятий: урок из 20 заданий и 60-секундный блиц.

import {
  ALL_FACT_IDS, COLUMN_ORDER, STATUS, columnFacts, difficulty, factId, pairId, parseFactId,
} from './facts.js';
import {
  STAT_MS_CAP, WEAK_THRESHOLD, applyAnswer, factStatus, isMastered, weakness,
} from './knowledge.js';
import { dayNumber, nowSec } from './dates.js';
import { randomId, shuffle } from './rng.js';

export const LESSON_SIZE = 20;
/** Доля новых и слабых фактов в занятии; остальное — повторение. */
export const NEW_WEAK_SHARE = 0.7;
export const MAX_NEW_FACTS = 3;
/** Сколько раз новый факт встречается в своём первом занятии (знакомство + 2 повтора). */
export const NEW_EXPOSURES = 3;
/** Ошибку возвращаем через 2–3 задания. */
export const RETRY_GAPS = [2, 3];
/** Сколько возвратов после ошибок можно добавить сверх плана, прежде чем вытеснять повторение. */
export const LESSON_EXTRA_LIMIT = 4;
/** Мягкий предел: занятие задумано на 10 минут, после 12 минут спокойно завершаем. */
export const LESSON_SOFT_LIMIT_MS = 12 * 60 * 1000;
export const BLITZ_MS = 60 * 1000;
export const BLITZ_MIN_FACTS = 4;

export function sessionId(now = Date.now()) {
  return `s-${now.toString(36)}-${randomId(4)}`;
}

// ---------- Задания ----------

/**
 * Близкие дистракторы: соседи по таблице, ±1, ±2, перестановка цифр, ±10, сумма вместо произведения.
 * Чем правдоподобнее ошибка, тем раньше она попадает в варианты.
 */
export function distractors(a, b, count = 3, rng = Math.random) {
  const p = a * b;
  const score = new Map();
  const add = (v, s) => {
    if (!Number.isInteger(v) || v <= 0 || v === p || v > 120) return;
    if (!score.has(v) || score.get(v) > s) score.set(v, s);
  };
  add((a + 1) * b, 1);
  add((a - 1) * b, 1);
  add(a * (b + 1), 1);
  add(a * (b - 1), 1);
  add(p + 1, 2);
  add(p - 1, 2);
  if (p >= 12 && p < 100 && p % 10 !== 0) add(Number(String(p).split('').reverse().join('')), 2);
  add(p + 2, 2.5);
  add(p - 2, 2.5);
  add(p + 10, 3);
  add(p - 10, 3);
  add((a + 1) * (b + 1), 3.5);
  add((a - 1) * (b - 1), 3.5);
  add(a + b, 4);
  const ranked = [...score.entries()]
    .map(([v, s]) => ({ v, s: s + rng() * 1.2 }))
    .sort((x, y) => x.s - y.s)
    .map((x) => x.v);
  const out = ranked.slice(0, count);
  for (let k = 3; out.length < count; k++) {
    if (!out.includes(p + k)) out.push(p + k);
  }
  return out;
}

export function makeTask(id, format, rng = Math.random) {
  const { a, b } = parseFactId(id);
  const p = a * b;
  const base = { factId: id, a, b, product: p, format };
  switch (format) {
    case 'choice':
      return { ...base, options: shuffle([p, ...distractors(a, b, 3, rng)], rng), answer: p };
    case 'truefalse': {
      const truth = rng() < 0.5;
      const shown = truth ? p : distractors(a, b, 1, rng)[0];
      return { ...base, shown, truth, answer: truth };
    }
    case 'missing': {
      const side = a === b || rng() < 0.5 ? 'a' : 'b';
      return { ...base, side, answer: side === 'a' ? a : b };
    }
    case 'blitz':
      return { ...base, answer: p };
    default:
      return { ...base, format: 'input', answer: p };
  }
}

export function checkAnswer(task, value) {
  if (task.format === 'truefalse') return value === task.truth;
  return Number(value) === task.answer;
}

/** Что записать в историю как ответ ребёнка. */
export function givenValue(task, value) {
  if (value == null) return null;
  if (task.format === 'truefalse') return value ? 1 : 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Формат по стадии факта: узнавание (выбор из 4, «верно или неверно») — новым и изучаемым,
 * пока нет двух верных подряд; воспроизведение (ввод, пропущенный множитель) — закрепляемым.
 * Подряд один и тот же формат по возможности не повторяем.
 */
export function chooseFormat(fact, { first = false, prevFormat = null, rng = Math.random } = {}) {
  if (first) return 'choice';
  const status = factStatus(fact);
  const recognition = status === STATUS.NEW || (status === STATUS.LEARNING && fact.streak < 2);
  const pool = recognition ? ['choice', 'truefalse'] : ['input', 'missing'];
  let format = rng() < 0.65 ? pool[0] : pool[1];
  if (format === prevFormat && rng() < 0.7) format = format === pool[0] ? pool[1] : pool[0];
  return format;
}

// ---------- План урока ----------

function lastLesson(profile) {
  for (let i = profile.sessions.length - 1; i >= 0; i--) {
    if (profile.sessions[i].type === 'lesson') return profile.sessions[i];
  }
  return null;
}

/**
 * Сколько новых фактов можно дать (не больше 3). Меньше, если много слабых фактов,
 * и ни одного, только если много фактов «застряло» в первой коробке —
 * иначе медленный, но верно отвечающий ребёнок никогда не дошёл бы до новых столбцов.
 */
export function newFactCapacity(profile, today = dayNumber()) {
  let struggling = 0;
  let weak = 0;
  let introduced = 0;
  for (const id of ALL_FACT_IDS) {
    const f = profile.facts[id];
    if (!f.introduced) continue;
    introduced += 1;
    if (f.box === 1 && factStatus(f) === STATUS.LEARNING) struggling += 1;
    if (weakness(f, today) >= WEAK_THRESHOLD) weak += 1;
  }
  let cap = MAX_NEW_FACTS;
  if (struggling > 6 || weak > 12) cap = 2;
  if (struggling > 10 || weak > 20) cap = 1;
  if (struggling > 14) cap = 0;
  const last = lastLesson(profile);
  if (last && last.tasks >= 5 && last.correct / last.tasks < 0.6) cap = Math.min(cap, 1);
  if (introduced < 3) cap = MAX_NEW_FACTS;
  return Math.min(MAX_NEW_FACTS, cap);
}

/**
 * Новые факты берём из первого по порядку столбца, где они остались.
 * Сначала — те, чья пара уже известна (их легко взять перестановкой множителей), затем по трудности.
 */
export function pickNewFacts(profile, capacity) {
  if (capacity <= 0) return { column: null, facts: [] };
  const pairScore = (id) => {
    const pid = pairId(id);
    if (pid === id) return 0;
    const pair = profile.facts[pid];
    return isMastered(pair) ? 2 : pair.introduced ? 1 : 0;
  };
  for (const k of COLUMN_ORDER) {
    const fresh = columnFacts(k).filter((id) => !profile.facts[id].introduced);
    if (!fresh.length) continue;
    fresh.sort((x, y) => pairScore(y) - pairScore(x) || difficulty(x) - difficulty(y));
    return { column: k, facts: fresh.slice(0, capacity) };
  }
  return { column: null, facts: [] };
}

/**
 * Расставляет задания: знакомства с новыми фактами — по очереди (позиции 1, 5, 9),
 * повторы одного факта — не ближе чем через 2 задания, пара 3×7/7×3 — не подряд,
 * а виды заданий (новые, слабые, повторение) распределены равномерно.
 */
export function orderQueue(items, rng = Math.random) {
  const total = items.length;
  if (!total) return [];
  const pool = shuffle(items, rng);
  const kindTotals = {};
  const placedByKind = {};
  for (const it of items) {
    kindTotals[it.kind] = (kindTotals[it.kind] ?? 0) + 1;
    placedByKind[it.kind] = 0;
  }
  const firstTarget = new Map();
  items.filter((x) => x.first).forEach((x, i) => firstTarget.set(x.factId, 1 + 4 * i));
  const introducedNow = new Set();
  const lastPos = new Map();
  const copiesLeft = new Map();
  for (const it of items) copiesLeft.set(it.factId, (copiesLeft.get(it.factId) ?? 0) + 1);
  const out = [];
  while (pool.length) {
    const pos = out.length;
    const prev = out[pos - 1];
    let chosen = -1;
    for (const minGap of [3, 2, 1, 0]) {
      let bestScore = -Infinity;
      for (let i = 0; i < pool.length; i++) {
        const it = pool[i];
        if (it.kind === 'new' && !it.first && !introducedNow.has(it.factId)) continue;
        if (it.first && minGap > 0 && pos < firstTarget.get(it.factId)) continue;
        const lp = lastPos.get(it.factId);
        if (minGap > 0 && lp !== undefined && pos - lp < minGap) continue;
        if (minGap > 1 && prev && pairId(prev.factId) === it.factId) continue;
        // Равномерность по видам заданий + приоритет фактам, у которых осталось больше копий
        // (иначе копии одного факта скапливаются в конце и встают подряд).
        let s = (kindTotals[it.kind] * (pos + 1)) / total - placedByKind[it.kind]
          + 0.8 * (copiesLeft.get(it.factId) - 1)
          + rng() * 0.05;
        if (it.first) s += 5;
        if (s > bestScore) {
          bestScore = s;
          chosen = i;
        }
      }
      if (chosen >= 0) break;
    }
    if (chosen < 0) chosen = 0;
    const [it] = pool.splice(chosen, 1);
    out.push(it);
    copiesLeft.set(it.factId, copiesLeft.get(it.factId) - 1);
    placedByKind[it.kind] += 1;
    lastPos.set(it.factId, pos);
    if (it.first) introducedNow.add(it.factId);
  }
  repairAdjacency(out);
  return out;
}

const clash = (x, y) => x.factId === y.factId || pairId(x.factId) === y.factId;

function clashAround(q, k) {
  return (k > 0 && clash(q[k], q[k - 1])) || (k < q.length - 1 && clash(q[k], q[k + 1]));
}

/** Знакомство с новым фактом должно идти раньше его повторов. */
function introductionsFirst(q) {
  const seen = new Set();
  for (const it of q) {
    if (it.first) seen.add(it.factId);
    else if (it.kind === 'new' && !seen.has(it.factId) && q.some((x) => x.first && x.factId === it.factId)) return false;
  }
  return true;
}

/** Жадная расстановка может упереться в тупик в конце — переставляем конфликтные задания. */
function repairAdjacency(q) {
  for (let i = 1; i < q.length; i++) {
    if (!clash(q[i], q[i - 1])) continue;
    for (let j = 0; j < q.length; j++) {
      if (j === i || q[j].first || q[i].first) continue;
      [q[i], q[j]] = [q[j], q[i]];
      if (!clashAround(q, i) && !clashAround(q, j) && introductionsFirst(q)) break;
      [q[i], q[j]] = [q[j], q[i]];
    }
  }
}

/**
 * План урока из 20 заданий:
 *  14 (70 %) — новые факты (до 3, каждый 3 раза) и слабые (ошибки, медленные ответы, низкая коробка);
 *   6 (30 %) — повторение фактов, у которых подошёл срок по Лейтнеру.
 * Если какой-то группы не хватает, места занимает другая; в самом начале обучения,
 * когда фактов мало, новые и изучаемые факты повторяются чаще.
 */
export function planLesson(profile, { now = Date.now(), rng = Math.random } = {}) {
  const today = dayNumber(now);
  const facts = profile.facts;
  const introduced = ALL_FACT_IDS.filter((id) => facts[id].introduced);
  const { column, facts: newFacts } = pickNewFacts(profile, newFactCapacity(profile, today));
  const introColumn = column != null && !profile.introducedColumns.includes(column) ? column : null;
  const newWeakSlots = Math.round(LESSON_SIZE * NEW_WEAK_SHARE);

  const items = [];
  for (const id of newFacts) {
    for (let k = 0; k < NEW_EXPOSURES; k++) items.push({ factId: id, kind: 'new', first: k === 0 });
  }

  const weakScore = (id) => {
    const pid = pairId(id);
    const pairWeak = pid !== id && weakness(facts[pid], today) >= WEAK_THRESHOLD ? 0.5 : 0;
    return weakness(facts[id], today) + pairWeak;
  };
  const weakRanked = introduced
    .map((id) => ({ id, w: weakScore(id) }))
    .filter((x) => x.w >= WEAK_THRESHOLD)
    .sort((x, y) => y.w - x.w || difficulty(x.id) - difficulty(y.id))
    .map((x) => x.id);
  const weakSet = new Set(weakRanked);
  const weakSlots = Math.max(0, newWeakSlots - items.length);
  let weakCount = 0;
  for (let round = 0; round < 2 && weakCount < weakSlots; round++) {
    for (const id of weakRanked) {
      if (weakCount >= weakSlots) break;
      items.push({ factId: id, kind: 'weak', first: false });
      weakCount += 1;
    }
  }

  // Повторение: сначала факты с подошедшим сроком (самые просроченные и из низких коробок),
  // затем — давно не встречавшиеся освоенные, чтобы они не забывались.
  const used = new Set(items.map((x) => x.factId));
  const reviewTarget = LESSON_SIZE - items.length;
  const due = introduced
    .filter((id) => !used.has(id) && facts[id].due <= today)
    .sort((x, y) => facts[x].due - facts[y].due || facts[x].box - facts[y].box || rng() - 0.5);
  const maintenance = introduced
    .filter((id) => !used.has(id) && facts[id].due > today)
    .sort((x, y) => facts[x].lastSeen - facts[y].lastSeen || facts[x].due - facts[y].due);
  for (const id of [...due, ...maintenance].slice(0, reviewTarget)) {
    items.push({ factId: id, kind: 'review', first: false });
  }

  // Начало обучения: материала меньше 20 заданий — добавляем повторы, начиная с самых редких.
  const counts = new Map();
  for (const it of items) counts.set(it.factId, (counts.get(it.factId) ?? 0) + 1);
  const fillPool = [...new Set([...newFacts, ...weakRanked, ...introduced])];
  while (items.length < LESSON_SIZE && fillPool.length) {
    let best = fillPool[0];
    for (const id of fillPool) if ((counts.get(id) ?? 0) < (counts.get(best) ?? 0)) best = id;
    if ((counts.get(best) ?? 0) >= 8) break;
    const kind = newFacts.includes(best) ? 'new' : weakSet.has(best) ? 'weak' : 'review';
    items.push({ factId: best, kind, first: false });
    counts.set(best, (counts.get(best) ?? 0) + 1);
  }

  const lessonsDone = profile.sessions.filter((s) => s.type === 'lesson').length;
  const zeroLesson = !profile.zeroLessonDone
    && (profile.introducedColumns.includes(1) || column !== 1)
    && (introColumn == null || lessonsDone >= 2);

  return {
    id: sessionId(now),
    type: 'lesson',
    createdAt: now,
    day: today,
    introColumn,
    zeroLesson,
    newFacts,
    queue: orderQueue(items, rng),
  };
}

// ---------- Урок ----------

/** Ошибка в 3×7 приближает повторение 7×3: пара покажется в ближайшем занятии. */
export function linkPairAfterError(profile, id, now = Date.now()) {
  const pid = pairId(id);
  if (pid === id) return false;
  const pair = profile.facts[pid];
  const today = dayNumber(now);
  if (!pair.introduced || pair.due <= today) return false;
  pair.due = today;
  pair.updatedAt = nowSec(now);
  return true;
}

export class LessonRunner {
  constructor(profile, plan, { rng = Math.random, clock = () => Date.now() } = {}) {
    this.profile = profile;
    this.plan = plan;
    this.rng = rng;
    this.clock = clock;
    this.queue = plan.queue.map((x) => ({ ...x }));
    this.planned = this.queue.length;
    this.index = 0;
    this.task = null;
    this.prevFormat = null;
    this.startedAt = clock();
    this.answered = 0;
    this.correctCount = 0;
    this.totalMs = 0;
    this.corrections = 0;
    this.improved = new Set();
    this.learnedNew = new Set();
    this.mastered = new Set();
    this.stopped = false;
    this.log = [];
  }

  get finished() {
    return this.stopped || this.index >= this.queue.length;
  }

  get total() {
    return this.queue.length;
  }

  current() {
    if (this.finished) return null;
    if (!this.task || this.task.queueIndex !== this.index) {
      const item = this.queue[this.index];
      const fact = this.profile.facts[item.factId];
      const intro = item.kind === 'new' && item.first && !fact.introduced;
      const format = chooseFormat(fact, { first: intro, prevFormat: this.prevFormat, rng: this.rng });
      this.task = { ...makeTask(item.factId, format, this.rng), queueIndex: this.index, kind: item.kind, intro };
    }
    return this.task;
  }

  /** value — число, true/false для «верно или неверно», null — «не знаю». */
  answer(value, ms) {
    const task = this.current();
    if (!task || task.result) return task?.result ?? null;
    const correct = value != null && checkAnswer(task, value);
    const now = this.clock();
    const fact = this.profile.facts[task.factId];
    const res = applyAnswer(fact, {
      correct,
      ms,
      format: task.format,
      given: givenValue(task, value),
      now,
      sessionId: this.plan.id,
    });
    if (res.after.box > res.before.box) this.improved.add(task.factId);
    if (task.intro) this.learnedNew.add(task.factId);
    if (res.before.status !== res.after.status
      && (res.after.status === STATUS.KNOWN || res.after.status === STATUS.AUTO)) {
      this.mastered.add(task.factId);
    }
    this.answered += 1;
    if (correct) this.correctCount += 1;
    this.totalMs += Math.min(ms, STAT_MS_CAP);
    this.prevFormat = task.format;
    this.log.push({ factId: task.factId, kind: task.kind, format: task.format, correct, ms });
    if (!correct) {
      linkPairAfterError(this.profile, task.factId, now);
      this.scheduleRetry(task.factId);
    }
    task.result = {
      correct,
      expected: task.answer,
      product: task.product,
      statusBefore: res.before.status,
      status: res.after.status,
      move: res.move,
    };
    return task.result;
  }

  /** После ошибки ребёнок сам вводит верный ответ; в статистику это не идёт. */
  checkCorrection(value) {
    const ok = Number(value) === this.task?.product;
    if (ok) this.corrections += 1;
    return ok;
  }

  /**
   * Возвращает пример через 2–3 задания. Занятие не растёт больше чем на LESSON_EXTRA_LIMIT:
   * сначала возврат вытесняет более позднее повторение, а если вытеснять нечего —
   * пример просто придёт в следующем занятии (он уже в первой коробке).
   */
  scheduleRetry(id) {
    if (this.queue.length >= this.planned + LESSON_EXTRA_LIMIT) {
      let removed = false;
      for (let i = this.queue.length - 1; i > this.index; i--) {
        if (this.queue[i].kind === 'review') {
          this.queue.splice(i, 1);
          removed = true;
          break;
        }
      }
      if (!removed) return -1;
    }
    const gap = RETRY_GAPS[Math.floor(this.rng() * RETRY_GAPS.length)];
    const pos = Math.min(this.queue.length, this.index + 1 + gap);
    this.queue.splice(pos, 0, { factId: id, kind: 'retry', first: false });
    return pos;
  }

  next() {
    this.index += 1;
    this.task = null;
    if (this.clock() - this.startedAt > LESSON_SOFT_LIMIT_MS && this.answered >= 10) this.stopped = true;
  }

  stop() {
    this.stopped = true;
  }

  summary() {
    return {
      id: this.plan.id,
      type: 'lesson',
      day: dayNumber(this.startedAt),
      start: nowSec(this.startedAt),
      durationMs: this.clock() - this.startedAt,
      tasks: this.answered,
      correct: this.correctCount,
      totalMs: this.totalMs,
      newFacts: this.learnedNew.size,
      improved: this.improved.size,
      corrections: this.corrections,
      mastered: [...this.mastered],
      learned: [...this.learnedNew],
    };
  }
}

// ---------- Блиц ----------

export function blitzPool(profile) {
  return ALL_FACT_IDS.filter((id) => isMastered(profile.facts[id]));
}

export function blitzAvailable(profile) {
  return blitzPool(profile).length >= BLITZ_MIN_FACTS;
}

/** Блиц: 60 секунд, только освоенные факты, ввод с клавиатуры, таймер виден. */
export class BlitzRunner {
  constructor(profile, { rng = Math.random, clock = () => Date.now() } = {}) {
    this.profile = profile;
    this.rng = rng;
    this.clock = clock;
    this.id = sessionId(clock());
    this.pool = blitzPool(profile);
    this.order = [];
    this.task = null;
    this.startedAt = null;
    this.answered = 0;
    this.correctCount = 0;
    this.totalMs = 0;
    this.missed = [];
  }

  start() {
    this.startedAt = this.clock();
  }

  timeLeft() {
    if (this.startedAt == null) return BLITZ_MS;
    return Math.max(0, BLITZ_MS - (this.clock() - this.startedAt));
  }

  get finished() {
    return this.startedAt != null && this.timeLeft() <= 0;
  }

  current() {
    if (!this.task) {
      if (!this.order.length) {
        let next = shuffle(this.pool, this.rng);
        // не начинать новый круг с только что показанного факта
        if (this.lastId && next.length > 1 && next[0] === this.lastId) next = [...next.slice(1), next[0]];
        this.order = next;
      }
      const id = this.order.shift();
      this.task = makeTask(id, 'blitz', this.rng);
    }
    return this.task;
  }

  answer(value, ms) {
    const task = this.current();
    const correct = checkAnswer(task, value);
    applyAnswer(this.profile.facts[task.factId], {
      correct,
      ms,
      format: 'blitz',
      given: givenValue(task, value),
      now: this.clock(),
      sessionId: this.id,
    });
    this.answered += 1;
    this.totalMs += Math.min(ms, STAT_MS_CAP);
    if (correct) this.correctCount += 1;
    else {
      linkPairAfterError(this.profile, task.factId, this.clock());
      if (!this.missed.includes(task.factId)) this.missed.push(task.factId);
    }
    return { correct, product: task.product };
  }

  next() {
    this.lastId = this.task?.factId;
    this.task = null;
  }

  summary() {
    const start = this.startedAt ?? this.clock();
    return {
      id: this.id,
      type: 'blitz',
      day: dayNumber(start),
      start: nowSec(start),
      durationMs: Math.min(BLITZ_MS, this.clock() - start),
      tasks: this.answered,
      correct: this.correctCount,
      totalMs: this.totalMs,
      newFacts: 0,
      improved: 0,
      missed: this.missed.slice(),
    };
  }
}

/** Упражнения на правило нуля — не входят в 100 фактов и в статистику. */
export function zeroPractice(rng = Math.random) {
  const nums = shuffle([2, 3, 4, 5, 6, 7, 8, 9], rng);
  const pairs = [{ a: 0, b: nums[0] }, { a: nums[1], b: 0 }, { a: 0, b: nums[2] }];
  return pairs.map(({ a, b }) => {
    const n = a + b;
    // Типичная ошибка — спутать с ×1 или со сложением: 0 × 7 = 7.
    const wrong = [...new Set([n, 1, 10, n + 1])].filter((v) => v !== 0).slice(0, 3);
    return { a, b, product: 0, options: shuffle([0, ...wrong], rng) };
  });
}

/** Объяснение столбца показано — повторно его не начинаем (но его можно открыть в «Уроках»). */
export function markColumnIntroduced(profile, k) {
  if (!profile.introducedColumns.includes(k)) {
    profile.introducedColumns = COLUMN_ORDER.filter((c) => c === k || profile.introducedColumns.includes(c));
  }
}

export function markZeroLessonDone(profile) {
  profile.zeroLessonDone = true;
}

export { factId };
