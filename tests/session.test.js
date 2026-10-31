// Сборка занятия: 20 заданий, 70 % новых и слабых / 30 % повторения, не больше 3 новых,
// порядок столбцов, форматы по стадии, близкие дистракторы, возврат ошибки через 2–3 задания.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BLITZ_MS, LESSON_EXTRA_LIMIT, LESSON_SIZE, MAX_NEW_FACTS, BlitzRunner, LessonRunner,
  blitzAvailable, chooseFormat, distractors, linkPairAfterError, makeTask, newFactCapacity,
  orderQueue, pickNewFacts, planLesson, zeroPractice,
} from '../js/core/session.js';
import { createProfile } from '../js/core/profile.js';
import { ALL_FACT_IDS, COLUMN_ORDER, columnFacts, pairId, parseFactId } from '../js/core/facts.js';
import { applyAnswer, createFactState, factStatus } from '../js/core/knowledge.js';
import { dayNumber, nowSec } from '../js/core/dates.js';
import { createRng } from '../js/core/rng.js';

const T0 = new Date(2026, 9, 10, 17, 0, 0).getTime();
const TODAY = dayNumber(T0);

function setKnown(profile, id, { box = 3, due = TODAY + 3 } = {}) {
  Object.assign(profile.facts[id], {
    introduced: true, box, due, streak: 3, attempts: 3, correct: 3, totalMs: 6000,
    lastSeen: nowSec(T0) - 86400, updatedAt: nowSec(T0) - 86400,
    history: [[nowSec(T0) - 86400, 2000, 1, 0, parseFactId(id).a * parseFactId(id).b]],
  });
}

function setWeak(profile, id) {
  const f = profile.facts[id];
  Object.assign(f, createFactState(), { introduced: true });
  applyAnswer(f, { correct: false, ms: 5000, format: 'choice', now: T0 - 86400000, sessionId: 'old' });
  applyAnswer(f, { correct: true, ms: 7000, format: 'choice', now: T0 - 86400000 + 1000, sessionId: 'old' });
}

function knownColumns(profile, cols, opts) {
  for (const k of cols) for (const id of columnFacts(k)) setKnown(profile, id, opts);
}

test('первое занятие новичка: 20 заданий, 3 новых факта из столбца ×1 и его объяснение', () => {
  const p = createProfile({ name: 'Тест', now: T0 });
  const plan = planLesson(p, { now: T0, rng: createRng(1) });
  assert.equal(plan.queue.length, LESSON_SIZE);
  assert.equal(plan.newFacts.length, 3);
  assert.ok(plan.newFacts.every((id) => parseFactId(id).b === 1));
  assert.equal(plan.introColumn, 1);
  assert.equal(plan.zeroLesson, false);
  assert.ok(plan.queue.every((x) => plan.newFacts.includes(x.factId)));
  assert.equal(plan.queue.filter((x) => x.first).length, 3);
});

test('новые факты вводятся по столбцам в порядке ×1, ×10, ×2, ×5, ×9, ×3, ×4, ×6, ×7, ×8', () => {
  const p = createProfile({ now: T0 });
  const order = [];
  for (let guard = 0; guard < 60; guard++) {
    const { column, facts } = pickNewFacts(p, 3);
    if (column == null) break;
    if (order.at(-1) !== column) order.push(column);
    for (const id of facts) setKnown(p, id);
  }
  assert.deepEqual(order, COLUMN_ORDER);
  assert.ok(ALL_FACT_IDS.every((id) => p.facts[id].introduced));
});

test('внутри столбца сначала факты, чья пара уже известна (перестановка множителей)', () => {
  const p = createProfile({ now: T0 });
  knownColumns(p, [1, 10, 2, 5, 9]);
  const { column, facts } = pickNewFacts(p, 3);
  assert.equal(column, 3);
  for (const id of facts) assert.equal(factStatus(p.facts[pairId(id)]), 'known');
});

test('не больше 3 новых фактов за занятие при любом состоянии', () => {
  const rng = createRng(7);
  for (let trial = 0; trial < 40; trial++) {
    const p = createProfile({ now: T0 });
    const cols = COLUMN_ORDER.slice(0, Math.floor(rng() * 10));
    knownColumns(p, cols, { due: TODAY - Math.floor(rng() * 3) });
    const plan = planLesson(p, { now: T0, rng });
    const fresh = new Set(plan.queue.map((x) => x.factId).filter((id) => !p.facts[id].introduced));
    assert.ok(plan.newFacts.length <= MAX_NEW_FACTS);
    assert.ok(fresh.size <= MAX_NEW_FACTS, `новых фактов: ${fresh.size}`);
    assert.equal(plan.queue.length, LESSON_SIZE);
  }
});

test('состав: 70 % новых и слабых (14 заданий) и 30 % повторения (6 заданий)', () => {
  const p = createProfile({ now: T0 });
  knownColumns(p, [1, 10, 2, 5], { due: TODAY - 1 });
  for (const id of ['3x9', '9x3', '4x9', '6x9']) setWeak(p, id);
  const plan = planLesson(p, { now: T0, rng: createRng(3) });
  const kinds = plan.queue.reduce((m, x) => ({ ...m, [x.kind]: (m[x.kind] ?? 0) + 1 }), {});
  assert.equal(plan.newFacts.length, 3);
  assert.equal((kinds.new ?? 0) + (kinds.weak ?? 0), 14);
  assert.equal(kinds.review, 6);
  for (const x of plan.queue.filter((q) => q.kind === 'review')) {
    assert.ok(p.facts[x.factId].due <= TODAY, 'повторение берёт факты с подошедшим сроком');
  }
});

test('если «застряло» много фактов, новых не дают, а слабые занимают 70 %', () => {
  const p = createProfile({ now: T0 });
  knownColumns(p, [1, 10], { due: TODAY });
  const weakIds = [...columnFacts(2), ...columnFacts(5)].filter((id) => !p.facts[id].introduced).slice(0, 16);
  for (const id of weakIds) setWeak(p, id);
  assert.equal(newFactCapacity(p), 0);
  const plan = planLesson(p, { now: T0, rng: createRng(5) });
  const kinds = plan.queue.reduce((m, x) => ({ ...m, [x.kind]: (m[x.kind] ?? 0) + 1 }), {});
  assert.equal(plan.newFacts.length, 0);
  assert.equal(kinds.weak, 14);
  assert.equal(kinds.review, 6);
});

test('после неудачного занятия (меньше 60 % верных) — не больше одного нового факта', () => {
  const p = createProfile({ now: T0 });
  knownColumns(p, [1]);
  p.sessions.push({ id: 's-old', type: 'lesson', day: TODAY - 1, start: nowSec(T0) - 86400, durationMs: 1, tasks: 20, correct: 9, totalMs: 1, newFacts: 0, improved: 0, stars: 1 });
  assert.equal(newFactCapacity(p), 1);
});

test('повторы одного факта не стоят подряд, пары 3×7 / 7×3 — тоже', () => {
  const rng = createRng(11);
  for (let trial = 0; trial < 30; trial++) {
    const p = createProfile({ now: T0 });
    knownColumns(p, COLUMN_ORDER.slice(0, 3 + (trial % 5)), { due: TODAY });
    for (const id of ['7x3', '3x7', '8x6', '6x8'].filter((x) => !p.facts[x].introduced)) setWeak(p, id);
    const { queue } = planLesson(p, { now: T0, rng });
    for (let i = 1; i < queue.length; i++) {
      assert.notEqual(queue[i].factId, queue[i - 1].factId, 'один и тот же факт подряд');
      assert.notEqual(queue[i].factId, pairId(queue[i - 1].factId), 'пара подряд');
    }
  }
});

test('знакомство с новым фактом идёт раньше его повторов', () => {
  const p = createProfile({ now: T0 });
  knownColumns(p, [1, 10], { due: TODAY });
  const plan = planLesson(p, { now: T0, rng: createRng(2) });
  for (const id of plan.newFacts) {
    const idx = plan.queue.map((x, i) => (x.factId === id ? i : -1)).filter((i) => i >= 0);
    assert.equal(plan.queue[idx[0]].first, true);
    assert.equal(idx.length, 3);
    for (let k = 1; k < idx.length; k++) assert.ok(idx[k] - idx[k - 1] >= 3);
  }
});

test('формат: выбор и «верно/неверно» — новым и изучаемым, ввод и пропуск — закрепляемым', () => {
  const rng = createRng(4);
  const fresh = createFactState();
  const learning = { ...createFactState(), introduced: true, streak: 1 };
  const consolidating = { ...createFactState(), introduced: true, streak: 2 };
  const known = { ...createFactState(), introduced: true, streak: 5 };
  assert.equal(chooseFormat(fresh, { first: true, rng }), 'choice');
  const seen = (f) => new Set(Array.from({ length: 200 }, () => chooseFormat(f, { rng })));
  assert.deepEqual([...seen(fresh)].sort(), ['choice', 'truefalse']);
  assert.deepEqual([...seen(learning)].sort(), ['choice', 'truefalse']);
  assert.deepEqual([...seen(consolidating)].sort(), ['input', 'missing']);
  assert.deepEqual([...seen(known)].sort(), ['input', 'missing']);
});

test('форматы чередуются: тот же формат подряд встречается реже, чем при случайном выборе', () => {
  const rng = createRng(9);
  const f = { ...createFactState(), introduced: true, streak: 4 };
  let prev = null;
  let repeats = 0;
  for (let i = 0; i < 1000; i++) {
    const fmt = chooseFormat(f, { prevFormat: prev, rng });
    if (fmt === prev) repeats += 1;
    prev = fmt;
  }
  assert.ok(repeats < 400, `повторов подряд: ${repeats}`);
});

test('дистракторы: 3 разных близких числа, без верного ответа', () => {
  const rng = createRng(6);
  for (const id of ALL_FACT_IDS) {
    const { a, b } = parseFactId(id);
    const p = a * b;
    for (let k = 0; k < 5; k++) {
      const d = distractors(a, b, 3, rng);
      assert.equal(new Set(d).size, 3);
      assert.ok(!d.includes(p));
      assert.ok(d.every((v) => v > 0 && Number.isInteger(v)));
      const close = d.filter((v) => Math.abs(v - p) <= Math.max(a, b) + 2 || String(v) === [...String(p)].reverse().join(''));
      assert.ok(close.length >= 2, `${id}: ${d}`);
    }
  }
});

test('задания всех форматов проверяются верно', () => {
  const rng = createRng(8);
  const choice = makeTask('7x8', 'choice', rng);
  assert.equal(choice.options.length, 4);
  assert.ok(choice.options.includes(56));
  const tf = makeTask('7x8', 'truefalse', rng);
  assert.equal(tf.truth, tf.shown === 56);
  const miss = makeTask('7x8', 'missing', rng);
  assert.equal(miss.answer, miss.side === 'a' ? 7 : 8);
  assert.equal(makeTask('7x8', 'input', rng).answer, 56);
});

test('ошибка: пример возвращается через 2–3 задания', () => {
  const rng = createRng(12);
  for (let trial = 0; trial < 20; trial++) {
    const p = createProfile({ now: T0 });
    knownColumns(p, [1, 10, 2], { due: TODAY });
    const plan = planLesson(p, { now: T0, rng });
    const runner = new LessonRunner(p, plan, { rng, clock: () => T0 });
    const wrongAt = trial % 6;
    for (let i = 0; i <= wrongAt; i++) {
      const task = runner.current();
      const value = i === wrongAt ? (task.format === 'truefalse' ? !task.truth : task.answer + 1) : task.answer;
      const res = runner.answer(value, 2500);
      if (i === wrongAt) {
        assert.equal(res.correct, false);
        assert.equal(runner.checkCorrection(task.product), true);
        const back = runner.queue.findIndex((x, j) => j > runner.index && x.kind === 'retry' && x.factId === task.factId);
        assert.ok(back - runner.index - 1 >= 2 && back - runner.index - 1 <= 3, `между: ${back - runner.index - 1}`);
      }
      runner.next();
    }
  }
});

test('ошибка в 3×7 переносит повторение 7×3 на сегодня', () => {
  const p = createProfile({ now: T0 });
  setKnown(p, '7x3', { box: 4, due: TODAY + 7 });
  assert.equal(linkPairAfterError(p, '3x7', T0), true);
  assert.equal(p.facts['7x3'].due, TODAY);
  assert.equal(p.facts['7x3'].box, 4);
  assert.equal(linkPairAfterError(p, '4x4', T0), false);
});

test('занятие, где все ответы неверны, всё равно заканчивается (не длиннее 24 заданий)', () => {
  const p = createProfile({ now: T0 });
  const plan = planLesson(p, { now: T0, rng: createRng(13) });
  const runner = new LessonRunner(p, plan, { rng: createRng(13), clock: () => T0 });
  let n = 0;
  while (!runner.finished && n < 200) {
    const task = runner.current();
    runner.answer(task.format === 'truefalse' ? !task.truth : task.answer + 1, 4000);
    runner.next();
    n += 1;
  }
  assert.ok(runner.finished);
  assert.ok(n <= LESSON_SIZE + LESSON_EXTRA_LIMIT, `заданий: ${n}`);
});

test('занятие мягко заканчивается после 12 минут', () => {
  const p = createProfile({ now: T0 });
  knownColumns(p, [1, 10, 2], { due: TODAY });
  const plan = planLesson(p, { now: T0, rng: createRng(14) });
  let t = T0;
  const runner = new LessonRunner(p, plan, { rng: createRng(14), clock: () => t });
  let n = 0;
  while (!runner.finished) {
    const task = runner.current();
    runner.answer(task.answer, 2000);
    t += 65000;
    runner.next();
    n += 1;
  }
  assert.ok(n < LESSON_SIZE && n >= 10, `заданий: ${n}`);
});

test('итог занятия: новые факты, улучшения, точность', () => {
  const p = createProfile({ now: T0 });
  const plan = planLesson(p, { now: T0, rng: createRng(15) });
  const runner = new LessonRunner(p, plan, { rng: createRng(15), clock: () => T0 });
  while (!runner.finished) {
    runner.answer(runner.current().answer, 2000);
    runner.next();
  }
  const s = runner.summary();
  assert.equal(s.tasks, LESSON_SIZE);
  assert.equal(s.correct, LESSON_SIZE);
  assert.equal(s.newFacts, 3);
  assert.equal(s.type, 'lesson');
  for (const id of plan.newFacts) assert.equal(factStatus(p.facts[id]), 'known');
});

test('блиц: только освоенные факты, 60 секунд, видимый таймер', () => {
  const p = createProfile({ now: T0 });
  assert.equal(blitzAvailable(p), false);
  knownColumns(p, [2]);
  assert.equal(blitzAvailable(p), true);
  let t = T0;
  const blitz = new BlitzRunner(p, { rng: createRng(16), clock: () => t });
  blitz.start();
  const seen = new Set();
  while (!blitz.finished) {
    const task = blitz.current();
    seen.add(task.factId);
    assert.equal(task.format, 'blitz');
    blitz.answer(task.answer, 1500);
    blitz.next();
    t += 1500;
  }
  assert.equal(blitz.timeLeft(), 0);
  assert.ok([...seen].every((id) => parseFactId(id).b === 2));
  const s = blitz.summary();
  assert.equal(s.durationMs, BLITZ_MS);
  assert.equal(s.correct, 40);
});

test('правило нуля: в упражнениях ответ 0 и разные варианты', () => {
  const tasks = zeroPractice(createRng(17));
  assert.equal(tasks.length, 3);
  for (const t of tasks) {
    assert.ok(t.a === 0 || t.b === 0);
    assert.equal(t.product, 0);
    assert.equal(new Set(t.options).size, 4);
    assert.ok(t.options.includes(0));
  }
});

test('orderQueue сохраняет все задания', () => {
  const items = [
    { factId: '2x3', kind: 'new', first: true }, { factId: '2x3', kind: 'new', first: false },
    { factId: '5x5', kind: 'weak', first: false }, { factId: '1x9', kind: 'review', first: false },
  ];
  const out = orderQueue(items, createRng(18));
  assert.equal(out.length, items.length);
  assert.ok(out.findIndex((x) => x.factId === '2x3' && x.first) < out.findIndex((x) => x.factId === '2x3' && !x.first));
});
