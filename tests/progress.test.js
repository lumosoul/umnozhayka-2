// Мотивация: звёзды за занятия, серия дней, награды за столбики; черновик диагностики.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BADGES, blitzStars, lessonStars, masteryPercent, recordSession, streakInfo, updateBadges,
} from '../js/core/progress.js';
import { createProfile, normalizeProfile, totalStars } from '../js/core/profile.js';
import { mergeProfiles } from '../js/core/merge.js';
import { columnFacts } from '../js/core/facts.js';
import { DAY_MS, dayNumber } from '../js/core/dates.js';

const T0 = new Date(2026, 9, 20, 18).getTime();
const TODAY = dayNumber(T0);

function lesson(profile, dayOffset, { id = `s${dayOffset}`, tasks = 20, correct = 18 } = {}) {
  const at = T0 + dayOffset * DAY_MS;
  return recordSession(profile, {
    id, type: 'lesson', day: dayNumber(at), start: Math.floor(at / 1000),
    durationMs: 400000, tasks, correct, totalMs: 80000, newFacts: 2, improved: 3,
  }, { now: at });
}

test('звёзды: всегда есть хотя бы одна за законченное занятие, больше — за старание', () => {
  assert.equal(lessonStars({ tasks: 20, correct: 4 }), 1);
  assert.equal(lessonStars({ tasks: 20, correct: 12 }), 2);
  assert.equal(lessonStars({ tasks: 20, correct: 17 }), 3);
  assert.equal(lessonStars({ tasks: 3, correct: 3 }), 0, 'за три ответа занятие ещё не засчитывается');
  assert.equal(blitzStars({ correct: 5, newRecord: false }), 1);
  assert.equal(blitzStars({ correct: 12, newRecord: true }), 3);
});

test('серия дней: занятия подряд, вчерашняя серия ещё жива, пропуск начинает новую', () => {
  const p = createProfile({ now: T0 });
  for (const d of [-4, -3, -2, -1]) lesson(p, d);
  assert.equal(streakInfo(p, TODAY).current, 4, 'сегодня ещё не занимались — серия со вчера не сгорает');
  assert.equal(streakInfo(p, TODAY).practicedToday, false);
  lesson(p, 0);
  assert.deepEqual(streakInfo(p, TODAY), { current: 5, best: 5, practicedToday: true });
  assert.equal(streakInfo(p, TODAY + 2).current, 0, 'пропущен день — новая серия');
  assert.equal(streakInfo(p, TODAY + 2).best, 5, 'рекорд сохраняется');
});

test('повторная запись того же занятия обновляет его, а не удваивает звёзды', () => {
  const p = createProfile({ now: T0 });
  lesson(p, 0, { id: 'x', tasks: 8, correct: 4 });
  assert.equal(totalStars(p), 1);
  lesson(p, 0, { id: 'x', tasks: 20, correct: 19 });
  assert.equal(p.sessions.length, 1);
  assert.equal(totalStars(p), 3);
});

test('награды: за освоенный столбик и серию; полученные не отнимаются', () => {
  const p = createProfile({ now: T0 });
  for (const id of columnFacts(5)) Object.assign(p.facts[id], { introduced: true, streak: 3 });
  const got = updateBadges(p, TODAY).map((b) => b.id);
  assert.ok(got.includes('col-5'));
  for (const d of [0, 1, 2]) lesson(p, d);
  assert.ok(p.badges['streak-3'] != null);
  p.facts['7x5'].streak = 0; // забыл пример — награда остаётся
  assert.ok(updateBadges(p, TODAY).every((b) => b.id !== 'col-5'));
  assert.ok(p.badges['col-5'] != null);
  assert.ok(BADGES.length >= 25);
  assert.equal(masteryPercent(p), 9);
});

test('черновик диагностики переживает сохранение и не мешает слиянию', () => {
  const p = createProfile({ now: T0 });
  p.diagnosticDraft = {
    id: 's-1', elapsedMs: 42000, totalMs: 30000,
    answers: [{ id: '2x7', correct: true, ms: 2100, given: 14 }, { id: '8x7', correct: false, ms: 9000, given: null }],
  };
  const restored = normalizeProfile(JSON.parse(JSON.stringify(p)));
  assert.deepEqual(restored.diagnosticDraft, p.diagnosticDraft);
  const done = { ...restored, diagnostic: { at: 1, items: 20, known: 30, durationMs: 1 } };
  assert.equal(normalizeProfile(done).diagnosticDraft, null, 'после диагностики черновик не нужен');
  assert.equal(mergeProfiles(restored, normalizeProfile(done)).profile.diagnosticDraft, null);
  const broken = normalizeProfile({ ...JSON.parse(JSON.stringify(p)), diagnosticDraft: { answers: [{ id: 'xx' }] } });
  assert.deepEqual(broken.diagnosticDraft.answers, []);
});
