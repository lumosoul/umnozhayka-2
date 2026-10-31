// Интервальное повторение: 5 коробок Лейтнера с интервалами 0, 1, 3, 7, 14 дней.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOX_COUNT, FAST_MS, INTERVALS, SLOW_MS, intervalFor, scheduleAfterAnswer,
} from '../js/core/leitner.js';
import { applyAnswer, createFactState } from '../js/core/knowledge.js';
import { DAY_MS, dayNumber } from '../js/core/dates.js';

const T0 = new Date(2026, 9, 1, 10, 0, 0).getTime();
const TODAY = dayNumber(T0);

test('пять коробок с интервалами 0, 1, 3, 7, 14 дней', () => {
  assert.equal(BOX_COUNT, 5);
  assert.deepEqual([...INTERVALS], [0, 1, 3, 7, 14]);
  assert.deepEqual([1, 2, 3, 4, 5].map(intervalFor), [0, 1, 3, 7, 14]);
  assert.equal(SLOW_MS, 6000);
  assert.equal(FAST_MS, 3000);
});

test('верный ответ двигает факт в следующую коробку и назначает показ через её интервал', () => {
  for (let box = 1; box <= 4; box++) {
    const r = scheduleAfterAnswer({ box, due: TODAY }, { correct: true, ms: 2000 }, TODAY);
    assert.equal(r.box, box + 1);
    assert.equal(r.due, TODAY + INTERVALS[box]);
    assert.equal(r.move, 'up');
  }
});

test('из пятой коробки факт не уходит дальше, интервал — 14 дней', () => {
  const r = scheduleAfterAnswer({ box: 5, due: TODAY }, { correct: true, ms: 1000 }, TODAY);
  assert.equal(r.box, 5);
  assert.equal(r.due, TODAY + 14);
});

test('верный ответ дольше 6 секунд оставляет факт на месте', () => {
  for (let box = 1; box <= 5; box++) {
    const r = scheduleAfterAnswer({ box, due: TODAY - 2 }, { correct: true, ms: 6500 }, TODAY);
    assert.equal(r.box, box);
    assert.equal(r.due, TODAY + INTERVALS[box - 1]);
    assert.equal(r.move, 'stay');
  }
  // ровно 6 секунд — ещё не «дольше 6 секунд»
  assert.equal(scheduleAfterAnswer({ box: 2, due: TODAY }, { correct: true, ms: 6000 }, TODAY).box, 3);
});

test('ошибка возвращает факт в первую коробку с показом сегодня же', () => {
  for (let box = 1; box <= 5; box++) {
    const r = scheduleAfterAnswer({ box, due: TODAY + 5 }, { correct: false, ms: 1500 }, TODAY);
    assert.equal(r.box, 1);
    assert.equal(r.due, TODAY);
  }
});

test('повтор раньше срока не двигает коробку (как в Anki)', () => {
  const r = scheduleAfterAnswer({ box: 2, due: TODAY + 1 }, { correct: true, ms: 1500 }, TODAY);
  assert.equal(r.box, 2);
  assert.equal(r.due, TODAY + 1);
  assert.equal(r.move, 'early');
});

test('факт проходит все коробки, если отвечать вовремя: 0 → 1 → 3 → 7 → 14 дней', () => {
  const f = createFactState();
  let t = T0;
  const seenDays = [];
  for (let step = 0; step < 6; step++) {
    seenDays.push(dayNumber(t) - TODAY);
    applyAnswer(f, { correct: true, ms: 2000, format: 'input', now: t, sessionId: `s${step}` });
    t = new Date(t).setHours(10) + (f.due - dayNumber(t)) * DAY_MS;
  }
  assert.deepEqual(seenDays, [0, 1, 4, 11, 25, 39]);
  assert.equal(f.box, 5);
});

test('несколько верных ответов в одном занятии продвигают новый факт только на одну коробку', () => {
  const f = createFactState();
  for (let i = 0; i < 3; i++) {
    applyAnswer(f, { correct: true, ms: 1800, format: 'choice', now: T0 + i * 30000, sessionId: 's1' });
  }
  assert.equal(f.box, 2);
  assert.equal(f.due, TODAY + 1);
});

test('медленный верный ответ в коробке 1 оставляет факт к показу сегодня', () => {
  const f = createFactState();
  applyAnswer(f, { correct: true, ms: 9000, format: 'input', now: T0 });
  assert.equal(f.box, 1);
  assert.equal(f.due, TODAY);
  assert.equal(f.slow, 1);
});
