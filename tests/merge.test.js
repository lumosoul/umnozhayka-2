// Слияние при импорте: по каждому факту — более свежая запись, без потерь и без дублей.

import test from 'node:test';
import assert from 'node:assert/strict';
import { applyImport, mergeFact, mergeProfiles, planImport } from '../js/core/merge.js';
import { MAX_PROFILES, SESSION_LOG_LIMIT, createProfile, normalizeProfile, totalStars } from '../js/core/profile.js';
import { applyAnswer } from '../js/core/knowledge.js';
import { recordSession } from '../js/core/progress.js';
import { DAY_MS } from '../js/core/dates.js';

const T0 = new Date(2026, 9, 1, 12).getTime();

function practiced(profile, id, correct, at) {
  applyAnswer(profile.facts[id], { correct, ms: 2000, format: 'input', now: at, sessionId: `s${at}` });
}

/** Занятие, за которое начисляется ровно `stars` звёзд (1 — меньше 60 % верных, 3 — от 85 %). */
function addSession(profile, at, stars = 2) {
  const correct = { 1: 10, 2: 14, 3: 18 }[stars];
  recordSession(profile, {
    id: `sess-${at}`, type: 'lesson', day: Math.floor(at / DAY_MS), start: Math.floor(at / 1000),
    durationMs: 300000, tasks: 20, correct, totalMs: 60000, newFacts: 1, improved: 2,
  }, { now: at });
}

test('по факту побеждает более свежая запись, при равенстве — местная', () => {
  const a = { updatedAt: 10, box: 2 };
  const b = { updatedAt: 20, box: 4 };
  assert.equal(mergeFact(a, b).fact, b);
  assert.equal(mergeFact(b, a).fact, b);
  assert.equal(mergeFact(a, { ...a, box: 5 }).fact, a);
});

test('объединение двух устройств: свежие факты с обеих сторон, занятия без дублей', () => {
  const local = createProfile({ name: 'Маша', now: T0 });
  practiced(local, '3x7', true, T0 + 1000);
  practiced(local, '2x2', true, T0 + 5000);
  addSession(local, T0 + 6000);

  const remote = normalizeProfile(JSON.parse(JSON.stringify(local)));
  practiced(remote, '3x7', false, T0 + 9000); // на втором устройстве — позже и с ошибкой
  practiced(local, '2x2', false, T0 + 12000); // на первом — ещё позже
  addSession(remote, T0 + 10000, 3);

  const { profile: merged, stats } = mergeProfiles(local, remote);
  assert.equal(merged.facts['3x7'].errors, 1, '3×7 — свежее на втором устройстве');
  assert.equal(merged.facts['2x2'].errors, 1, '2×2 — свежее на первом');
  assert.equal(stats.fromRemote, 1);
  assert.equal(merged.sessions.length, 2);
  assert.equal(stats.sessionsAdded, 1);
  assert.equal(totalStars(merged), totalStars(local) + 3);
});

test('слияние идемпотентно: повторный импорт ничего не меняет', () => {
  const local = createProfile({ name: 'Петя', now: T0 });
  const remote = normalizeProfile(JSON.parse(JSON.stringify(local)));
  practiced(remote, '6x7', true, T0 + 3000);
  addSession(remote, T0 + 4000);
  const once = mergeProfiles(local, remote).profile;
  const twice = mergeProfiles(once, remote).profile;
  assert.deepEqual(twice, once);
  assert.equal(mergeProfiles(once, once).stats.fromRemote, 0);
});

test('журнал занятий после слияния не превышает лимит и не задваивает звёзды', () => {
  const local = createProfile({ name: 'Оля', now: T0 });
  for (let i = 0; i < SESSION_LOG_LIMIT + 30; i++) addSession(local, T0 + i * 60000, 1);
  const remote = normalizeProfile(JSON.parse(JSON.stringify(local)));
  for (let i = 0; i < 10; i++) addSession(remote, T0 + (SESSION_LOG_LIMIT + 40 + i) * 60000, 1);
  const merged = mergeProfiles(local, remote).profile;
  assert.equal(merged.sessions.length, SESSION_LOG_LIMIT);
  assert.equal(totalStars(merged), SESSION_LOG_LIMIT + 40);
  const again = mergeProfiles(merged, remote).profile;
  assert.equal(totalStars(again), SESSION_LOG_LIMIT + 40);
});

test('имя и аватар берутся из более позднего переименования, награды объединяются', () => {
  const local = createProfile({ name: 'Саша', avatar: 'fox', now: T0 });
  const remote = normalizeProfile(JSON.parse(JSON.stringify(local)));
  remote.name = 'Сашенька';
  remote.avatar = 'cat';
  remote.nameUpdatedAt += 100;
  remote.badges = { 'col-1': 20000 };
  local.badges = { 'col-1': 20005, diag: 20001 };
  const merged = mergeProfiles(local, remote).profile;
  assert.equal(merged.name, 'Сашенька');
  assert.equal(merged.avatar, 'cat');
  assert.deepEqual(merged.badges, { 'col-1': 20000, diag: 20001 });
});

test('план импорта: добавление, объединение по id и по имени, лимит 4 профиля', () => {
  const existing = [createProfile({ name: 'Аня', now: T0 }), createProfile({ name: 'Ваня', now: T0 })];
  const sameId = normalizeProfile(JSON.parse(JSON.stringify(existing[0])));
  practiced(sameId, '9x9', true, T0 + 1000);
  const sameName = createProfile({ name: 'ваня', now: T0 });
  const extra = [1, 2, 3].map((i) => createProfile({ name: `Новый ${i}`, now: T0 }));
  const plan = planImport(existing, [sameId, sameName, ...extra]);
  assert.deepEqual(plan.map((x) => x.action), ['merge', 'merge', 'add', 'add', 'skip']);
  assert.equal(plan[0].matchedBy, 'id');
  assert.equal(plan[0].overwrites, true);
  assert.equal(plan[1].matchedBy, 'name');
  assert.equal(plan[1].local.id, existing[1].id);
  const saved = applyImport(plan);
  assert.equal(saved.length, 4);
  assert.ok(existing.length + plan.filter((x) => x.action === 'add').length <= MAX_PROFILES);
  assert.equal(saved[0].facts['9x9'].attempts, 1);
});
