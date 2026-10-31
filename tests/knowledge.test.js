// Модель знания факта: история, точность, среднее время, серия, статусы и автоматизм.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HISTORY_LIMIT, WEAK_THRESHOLD, accuracy, applyAnswer, averageMs, createFactState, factStatus, weakness,
} from '../js/core/knowledge.js';
import { DAY_MS, dayNumber } from '../js/core/dates.js';

const T0 = new Date(2026, 9, 5, 9, 0, 0).getTime();
const TODAY = dayNumber(T0);

const answer = (f, correct, ms, extra = {}) => applyAnswer(f, {
  correct, ms, format: 'input', now: T0, sessionId: 's1', ...extra,
});

test('новый факт: статус «новый», пустая история', () => {
  const f = createFactState();
  assert.equal(factStatus(f), 'new');
  assert.equal(accuracy(f), null);
  assert.equal(averageMs(f), null);
  assert.deepEqual(f.history, []);
});

test('история, точность, среднее время и ошибки считаются по каждому ответу', () => {
  const f = createFactState();
  answer(f, true, 2000);
  answer(f, false, 5000, { given: 54 });
  answer(f, true, 3000);
  assert.equal(f.attempts, 3);
  assert.equal(f.correct, 2);
  assert.equal(f.errors, 1);
  assert.equal(accuracy(f), 2 / 3);
  assert.equal(averageMs(f), 10000 / 3);
  assert.equal(f.history.length, 3);
  assert.deepEqual(f.history[1].slice(1), [5000, 0, 0, 54]);
  assert.ok(f.updatedAt > 0 && f.lastSeen === f.updatedAt);
});

test('история хранит только последние ответы', () => {
  const f = createFactState();
  for (let i = 0; i < HISTORY_LIMIT + 5; i++) answer(f, true, 1000 + i);
  assert.equal(f.history.length, HISTORY_LIMIT);
  assert.equal(f.history.at(-1)[1], 1000 + HISTORY_LIMIT + 4);
  assert.equal(f.attempts, HISTORY_LIMIT + 5);
});

test('«знает» — после трёх верных подряд; ошибка сбрасывает серию', () => {
  const f = createFactState();
  answer(f, true, 2500);
  assert.equal(factStatus(f), 'learning');
  answer(f, true, 2500);
  assert.equal(factStatus(f), 'learning');
  answer(f, true, 2500);
  assert.equal(f.streak, 3);
  assert.equal(factStatus(f), 'known');
  answer(f, false, 2500);
  assert.equal(f.streak, 0);
  assert.equal(factStatus(f), 'learning');
  assert.equal(f.box, 1);
});

function sessionAt(dayOffset, minute = 0) {
  return T0 + dayOffset * DAY_MS + minute * 60000;
}

test('«автоматизм» — верно быстрее 3 с в трёх сессиях подряд минимум в два разных дня', () => {
  const f = createFactState();
  // три быстрых сессии в один день — ещё не автоматизм
  for (let s = 0; s < 3; s++) {
    applyAnswer(f, { correct: true, ms: 2000, format: 'input', now: sessionAt(0, s * 30), sessionId: `d0s${s}` });
  }
  assert.equal(f.autoRun, 3);
  assert.equal(factStatus(f), 'known');
  // четвёртая сессия на следующий день — автоматизм
  applyAnswer(f, { correct: true, ms: 2100, format: 'missing', now: sessionAt(1), sessionId: 'd1s0' });
  assert.equal(factStatus(f), 'auto');
});

test('две сессии в один день и одна на другой — автоматизм', () => {
  const f = createFactState();
  applyAnswer(f, { correct: true, ms: 2000, format: 'input', now: sessionAt(0, 0), sessionId: 'a' });
  applyAnswer(f, { correct: true, ms: 2000, format: 'input', now: sessionAt(0, 60), sessionId: 'b' });
  assert.equal(factStatus(f), 'learning');
  applyAnswer(f, { correct: true, ms: 2000, format: 'input', now: sessionAt(2), sessionId: 'c' });
  assert.equal(f.streak, 3);
  assert.equal(factStatus(f), 'auto');
});

test('несколько ответов в одной сессии засчитываются как одна сессия', () => {
  const f = createFactState();
  for (let i = 0; i < 5; i++) {
    applyAnswer(f, { correct: true, ms: 1500, format: 'input', now: sessionAt(i % 2, i), sessionId: 'same' });
  }
  assert.equal(f.autoRun, 1);
  assert.equal(factStatus(f), 'known');
});

test('медленный ответ в сессии прерывает серию быстрых сессий', () => {
  const f = createFactState();
  applyAnswer(f, { correct: true, ms: 2000, format: 'input', now: sessionAt(0), sessionId: 'a' });
  applyAnswer(f, { correct: true, ms: 2000, format: 'input', now: sessionAt(1), sessionId: 'b' });
  applyAnswer(f, { correct: true, ms: 2000, format: 'input', now: sessionAt(1, 5), sessionId: 'c' });
  applyAnswer(f, { correct: true, ms: 4000, format: 'input', now: sessionAt(1, 6), sessionId: 'c' });
  assert.equal(f.autoRun, 0);
  assert.notEqual(factStatus(f), 'auto');
  // ровно 3 секунды — уже не «быстрее 3 секунд»
  applyAnswer(f, { correct: true, ms: 3000, format: 'input', now: sessionAt(2), sessionId: 'd' });
  assert.equal(f.autoRun, 0);
});

test('ошибка сбрасывает автоматизм', () => {
  const f = createFactState();
  for (let s = 0; s < 3; s++) {
    applyAnswer(f, { correct: true, ms: 1500, format: 'input', now: sessionAt(s), sessionId: `s${s}` });
  }
  assert.equal(factStatus(f), 'auto');
  applyAnswer(f, { correct: false, ms: 1500, format: 'choice', now: sessionAt(3), sessionId: 's3' });
  assert.equal(f.autoRun, 0);
  assert.equal(factStatus(f), 'learning');
});

test('выбор из вариантов и «верно/неверно» не идут в зачёт автоматизма', () => {
  const f = createFactState();
  for (let s = 0; s < 4; s++) {
    applyAnswer(f, { correct: true, ms: 1200, format: s % 2 ? 'choice' : 'truefalse', now: sessionAt(s), sessionId: `s${s}` });
  }
  assert.equal(f.autoRun, 0);
  assert.equal(factStatus(f), 'known');
});

test('слабость: ошибки и медленные ответы повышают, уверенное знание — понижает', () => {
  const weak = createFactState();
  answer(weak, false, 4000);
  answer(weak, true, 8000);
  const known = createFactState();
  for (let s = 0; s < 4; s++) {
    applyAnswer(known, { correct: true, ms: 1500, format: 'input', now: sessionAt(s), sessionId: `k${s}` });
  }
  const today = TODAY + 4;
  assert.ok(weakness(weak, today) >= WEAK_THRESHOLD);
  assert.ok(weakness(known, today) < WEAK_THRESHOLD);
  assert.ok(weakness(weak, today) > weakness(known, today) * 3);
  assert.equal(weakness(createFactState(), today), 0);
});

test('«не знаю» записывается как ошибка с ответом −1', () => {
  const f = createFactState();
  answer(f, false, 7000, { given: null });
  assert.equal(f.history[0][4], -1);
  assert.equal(f.errors, 1);
});
