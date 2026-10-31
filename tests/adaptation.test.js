// Сквозная симуляция: ребёнок занимается месяц, приложение подстраивается.
// Проверяем главное требование адаптации — слабые примеры появляются заметно чаще освоенных,
// а знание со временем растёт.

import test from 'node:test';
import assert from 'node:assert/strict';
import { LessonRunner, planLesson } from '../js/core/session.js';
import { Diagnostic, applyDiagnostic } from '../js/core/diagnostic.js';
import { ALL_FACT_IDS, COLUMN_ORDER } from '../js/core/facts.js';
import { WEAK_THRESHOLD, factStatus, isMastered, weakness } from '../js/core/knowledge.js';
import { createProfile } from '../js/core/profile.js';
import { masteryPercent, recordSession } from '../js/core/progress.js';
import { DAY_MS, dayNumber } from '../js/core/dates.js';
import { createRng } from '../js/core/rng.js';
import { SimLearner } from './helpers/learner.js';

function simulate({ days = 30, seed = 21, knownColumns = [1, 10, 2] } = {}) {
  const rng = createRng(seed);
  const learner = new SimLearner(rng, { knownColumns });
  const start = new Date(2026, 8, 1, 17, 0, 0).getTime();
  const profile = createProfile({ name: 'Сим', now: start });

  // Диагностика первого дня
  const diag = new Diagnostic({ rng });
  for (let id = diag.next(0), t = 0; id; id = diag.next(t)) {
    const r = learner.respond({ factId: id, format: 'diagnostic', answer: 0, product: 0 });
    diag.record(id, { correct: learner.knows(id) && r.correct, ms: r.ms, given: null });
    t += 8000;
  }
  applyDiagnostic(profile, diag.result(), { now: start, sessionId: 'diag' });

  const stats = { weakShown: 0, weakSlots: 0, masteredShown: 0, masteredSlots: 0 };
  const masteryByDay = [];
  for (let day = 0; day < days; day++) {
    let now = start + day * DAY_MS;
    const today = dayNumber(now);
    const plan = planLesson(profile, { now, rng });
    // Как часто в плане встречаются слабые и освоенные факты (в расчёте на один факт).
    const counts = new Map();
    for (const x of plan.queue) counts.set(x.factId, (counts.get(x.factId) ?? 0) + 1);
    for (const id of ALL_FACT_IDS) {
      const f = profile.facts[id];
      if (!f.introduced) continue;
      if (factStatus(f) === 'learning' || weakness(f, today) >= WEAK_THRESHOLD) {
        stats.weakSlots += 1;
        stats.weakShown += counts.get(id) ?? 0;
      } else if (isMastered(f)) {
        stats.masteredSlots += 1;
        stats.masteredShown += counts.get(id) ?? 0;
      }
    }
    const runner = new LessonRunner(profile, plan, { rng, clock: () => now });
    while (!runner.finished) {
      const task = runner.current();
      const r = learner.respond(task);
      const res = runner.answer(r.value, r.ms);
      if (!res.correct) {
        learner.learn(task.factId, 0.25);
        runner.checkCorrection(task.product);
      }
      now += r.ms + 4000;
      runner.next();
    }
    recordSession(profile, runner.summary(), { now });
    masteryByDay.push(masteryPercent(profile));
    learner.forget(1);
  }
  return { profile, stats, masteryByDay };
}

test('слабые факты появляются в занятиях намного чаще освоенных', () => {
  const { stats } = simulate();
  const weakRate = stats.weakShown / stats.weakSlots;
  const masteredRate = stats.masteredShown / stats.masteredSlots;
  assert.ok(stats.weakSlots > 20 && stats.masteredSlots > 100);
  assert.ok(weakRate > masteredRate * 4,
    `слабый факт: ${weakRate.toFixed(2)} показа за занятие, освоенный: ${masteredRate.toFixed(2)}`);
});

test('за месяц занятий освоение растёт, новые столбцы вводятся по порядку', () => {
  const { profile, masteryByDay } = simulate({ days: 30, seed: 22, knownColumns: [1] });
  assert.ok(masteryByDay.at(-1) > masteryByDay[0] + 25, masteryByDay.join(' '));
  const introduced = profile.introducedColumns;
  const expectedPrefix = COLUMN_ORDER.slice(0, introduced.length);
  assert.deepEqual(introduced, expectedPrefix);
});

test('освоенные факты повторяются всё реже — коробки Лейтнера растут', () => {
  const { profile } = simulate({ days: 30, seed: 23, knownColumns: [1, 10, 2, 5] });
  const boxes = ALL_FACT_IDS.map((id) => profile.facts[id]).filter(isMastered).map((f) => f.box);
  const high = boxes.filter((b) => b >= 4).length;
  assert.ok(high > boxes.length / 3, `в коробках 4–5: ${high} из ${boxes.length}`);
});

test('в каждом занятии — 20 заданий и не больше 3 новых фактов', () => {
  const rng = createRng(31);
  const learner = new SimLearner(rng, { knownColumns: [] });
  const start = new Date(2026, 8, 1, 17).getTime();
  const profile = createProfile({ now: start });
  for (let day = 0; day < 15; day++) {
    let now = start + day * DAY_MS;
    const plan = planLesson(profile, { now, rng });
    assert.equal(plan.queue.length, 20);
    const fresh = new Set(plan.queue.map((x) => x.factId).filter((id) => !profile.facts[id].introduced));
    assert.ok(fresh.size <= 3);
    const runner = new LessonRunner(profile, plan, { rng, clock: () => now });
    while (!runner.finished) {
      const r = learner.respond(runner.current());
      runner.answer(r.value, r.ms);
      now += 6000;
      runner.next();
    }
    recordSession(profile, runner.summary(), { now });
    learner.forget(1);
  }
});
