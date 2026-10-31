// Диагностика: до 20 примеров, не дольше 5 минут, от лёгких к трудным, адаптивный выбор.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DIAG_ITEMS, DIAG_MAX_MS, Diagnostic, applyDiagnostic, expectedInfoGain,
} from '../js/core/diagnostic.js';
import { ALL_FACT_IDS, columnFacts, difficulty, pairId, parseFactId } from '../js/core/facts.js';
import { factStatus, isMastered } from '../js/core/knowledge.js';
import { createProfile } from '../js/core/profile.js';
import { dayNumber } from '../js/core/dates.js';
import { createRng } from '../js/core/rng.js';
import { diagnosticResponder } from './helpers/learner.js';

const T0 = new Date(2026, 9, 12, 16, 0, 0).getTime();
const TODAY = dayNumber(T0);

function run(knownColumns, { seed = 1, msPerItem = 9000, responder } = {}) {
  const rng = createRng(seed);
  const diag = new Diagnostic({ rng });
  const respond = responder ?? diagnosticResponder(knownColumns, { rng });
  const asked = [];
  let elapsed = 0;
  for (;;) {
    const id = diag.next(elapsed);
    if (!id) break;
    asked.push(id);
    diag.record(id, respond(id));
    elapsed += msPerItem;
  }
  return { diag, asked, result: diag.result() };
}

const knowsFact = (cols) => (id) => {
  const { a, b } = parseFactId(id);
  return cols.includes(a) || cols.includes(b);
};

test('не больше 20 примеров, без повторов и без пары уже заданного', () => {
  const { asked } = run([1, 10, 2, 5, 9, 3, 4, 6, 7, 8]);
  assert.equal(asked.length, DIAG_ITEMS);
  const seen = new Set();
  for (const id of asked) {
    assert.ok(!seen.has(id) && !seen.has(pairId(id)));
    seen.add(id);
  }
});

test('заканчивается не позже 5 минут', () => {
  const { asked, diag } = run([1, 10, 2, 5, 9, 3, 4, 6, 7, 8], { msPerItem: 40000 });
  assert.ok(asked.length * 40000 <= DIAG_MAX_MS + 40000);
  assert.equal(asked.length, Math.ceil(DIAG_MAX_MS / 40000));
  assert.equal(diag.stopReason, 'time');
});

test('идёт от лёгких к трудным: у знающего ребёнка сложность растёт', () => {
  const { asked } = run([1, 10, 2, 5, 9, 3, 4, 6, 7, 8]);
  const d = asked.map(difficulty);
  const avg = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const trace = d.map((x) => x.toFixed(1)).join(' ');
  assert.ok(d[0] <= 2.5, `первый пример лёгкий (${asked[0]})`);
  // первые примеры — строго по нарастающей
  for (let i = 1; i < 6; i++) assert.ok(d[i] > d[i - 1], trace);
  assert.ok(Math.max(...d.slice(0, 8)) > 8, `дошли до самых трудных: ${trace}`);
  assert.ok(avg(d.slice(10)) > avg(d.slice(0, 5)), trace);
  // граница открывается постепенно: каждый пример не труднее, чем позволили прошлые верные ответы
  let frontier = 2.5;
  for (const x of d) {
    assert.ok(x <= frontier + 1e-9, trace);
    frontier = Math.max(frontier, x + 1.5);
  }
});

test('подстраивается: после ошибок даёт примеры полегче', () => {
  const strong = run([1, 10, 2, 5, 9, 3, 4, 6, 7, 8]).asked.map(difficulty);
  const weak = run([1, 10]).asked.map(difficulty);
  const avg = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
  assert.ok(avg(weak) < avg(strong) - 1.5);
});

test('отмечает известные факты у ребёнка, который знает ×1, ×10, ×2 и ×5', () => {
  const cols = [1, 10, 2, 5];
  const { result } = run(cols, { seed: 3 });
  const p = createProfile({ now: T0 });
  applyDiagnostic(p, result, { now: T0 });
  const knows = knowsFact(cols);
  const shouldKnow = ALL_FACT_IDS.filter(knows);
  const shouldNot = ALL_FACT_IDS.filter((id) => !knows(id));
  const hit = shouldKnow.filter((id) => isMastered(p.facts[id])).length / shouldKnow.length;
  const falseAlarm = shouldNot.filter((id) => isMastered(p.facts[id])).length / shouldNot.length;
  assert.ok(hit >= 0.9, `отмечено известных: ${(hit * 100).toFixed(0)} %`);
  assert.ok(falseAlarm <= 0.1, `лишних: ${(falseAlarm * 100).toFixed(0)} %`);
});

test('ребёнок учил таблицу по школьному порядку (×2, ×3, ×4) — диагностика это видит', () => {
  const cols = [1, 10, 2, 3, 4];
  const { result } = run(cols, { seed: 5 });
  assert.ok(result.columns[3] > 0.8, `×3: ${result.columns[3].toFixed(2)}`);
  assert.ok(result.columns[4] > 0.8, `×4: ${result.columns[4].toFixed(2)}`);
  assert.ok(result.columns[7] < 0.3 && result.columns[8] < 0.3);
});

test('знает всё — почти вся таблица отмечена', () => {
  const { result } = run([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], { seed: 8 });
  const p = createProfile({ now: T0 });
  const { known } = applyDiagnostic(p, result, { now: T0 });
  assert.ok(known.length >= 90, `известно ${known.length}`);
});

test('новичок: диагностика заканчивается раньше после 5 промахов подряд и почти ничего не отмечает', () => {
  const { asked, result, diag } = run([]);
  assert.ok(asked.length <= 6);
  assert.equal(diag.stopReason, 'misses');
  const p = createProfile({ now: T0 });
  const { known } = applyDiagnostic(p, result, { now: T0 });
  assert.ok(known.length <= 5);
});

test('перенос в профиль: быстро → «знает» (коробка 3), медленно → «изучается», ошибка → «новый», пара — тоже известна', () => {
  const p = createProfile({ now: T0 });
  const result = {
    answers: [
      { id: '2x7', correct: true, ms: 2500, given: 14, category: 'fast' },
      { id: '6x8', correct: true, ms: 9000, given: 48, category: 'slow' },
      { id: '7x8', correct: false, ms: 7000, given: 54, category: 'wrong' },
    ],
    probs: Object.fromEntries(ALL_FACT_IDS.map((id) => [id, 0.2])),
    columns: Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((k) => [k, 0.2])),
  };
  applyDiagnostic(p, result, { now: T0, sessionId: 'diag' });
  const f = p.facts;
  assert.equal(factStatus(f['2x7']), 'known');
  assert.equal(f['2x7'].box, 3);
  assert.equal(f['2x7'].due, TODAY + 3);
  assert.equal(f['2x7'].placed, 1);
  assert.equal(factStatus(f['7x2']), 'known');
  assert.equal(f['7x2'].box, 2);
  assert.equal(f['7x2'].due, TODAY + 1);
  assert.equal(factStatus(f['6x8']), 'learning');
  assert.equal(f['6x8'].box, 1);
  assert.equal(factStatus(f['7x8']), 'new');
  assert.equal(f['7x8'].errors, 1);
  assert.equal(f['7x8'].history[0][4], 54);
  assert.equal(p.diagnostic.items, 3);
});

test('столбцы, которые ребёнок знает, отмечаются как объяснённые', () => {
  const { result } = run([1, 10, 2, 5], { seed: 2 });
  const p = createProfile({ now: T0 });
  applyDiagnostic(p, result, { now: T0 });
  for (const k of [1, 10, 2, 5]) assert.ok(p.introducedColumns.includes(k), `×${k}`);
  assert.ok(!p.introducedColumns.includes(8));
  assert.ok(columnFacts(8).some((id) => factStatus(p.facts[id]) === 'new'));
});

test('прирост информации максимален при неопределённости', () => {
  assert.ok(expectedInfoGain(0.5) > expectedInfoGain(0.9));
  assert.ok(expectedInfoGain(0.5) > expectedInfoGain(0.1));
  assert.ok(expectedInfoGain(0.999) < 0.02);
});
