// Тексты для ребёнка: склонения и озвучка примеров.

import test from 'node:test';
import assert from 'node:assert/strict';
import { countText, plural } from '../js/core/dates.js';
import { mathToSpeech } from '../js/ui/audio.js';
import { repeatedSum, trickFor } from '../js/core/facts.js';

test('русские склонения: 1 пример, 2 примера, 5 примеров, 11 примеров, 21 пример', () => {
  const forms = ['пример', 'примера', 'примеров'];
  assert.deepEqual([1, 2, 5, 11, 12, 21, 22, 25, 100, 101].map((n) => plural(n, forms)),
    ['пример', 'примера', 'примеров', 'примеров', 'примеров', 'пример', 'примера', 'примеров', 'примеров', 'пример']);
  assert.equal(countText(3, ['день', 'дня', 'дней']), '3 дня');
});

test('озвучка: примеры читаются словами, пропуск — вопросом', () => {
  assert.equal(mathToSpeech('7 × 8 = ?'), '7 умножить на 8 — сколько будет?');
  assert.equal(mathToSpeech('? × 7 = 56'), 'какое число умножить на 7, чтобы получилось 56?');
  assert.equal(mathToSpeech('6 × ? = 42'), '6 умножить на какое число будет 42?');
  assert.equal(mathToSpeech('Верно или неверно?. 3 × 7 = 24'), 'Верно или неверно?. 3 умножить на 7 равно 24');
  assert.equal(mathToSpeech('Как тебя зовут?'), 'Как тебя зовут?');
});

test('подсказки-приёмы: перестановка множителей и короткие суммы', () => {
  assert.match(trickFor(2, 7).text, /^Поменяй множители местами: 2 × 7 = 7 × 2\. Умножить на 2/);
  assert.match(trickFor(4, 9).text, /загни 4-й палец\. Слева 3 — это десятки, справа 6 — единицы: 36/);
  assert.match(trickFor(7, 5).text, /половина от ×10: 7 × 10 = 70, половина — 35/);
  assert.equal(repeatedSum(4, 3), '4 + 4 + 4');
  assert.equal(repeatedSum(3, 9), '3 + 3 + … + 3 (9 раз)');
});
