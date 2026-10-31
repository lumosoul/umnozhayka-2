// Итоги занятий: звёзды, серия дней, награды и сводки для экранов прогресса и родителя.

import { ALL_FACT_IDS, COLUMN_ORDER, STATUS, columnFacts, parseFactId } from './facts.js';
import { accuracy, averageMs, factStatus, isMastered } from './knowledge.js';
import { dayNumber } from './dates.js';
import { normalizeSession, totalStars, trimSessions } from './profile.js';

/**
 * Звёзды хвалят за работу: одна — за законченное занятие, ещё по одной за 60 % и 85 % верных.
 * Пустые звёзды не показываем, поэтому «проигрыша» нет.
 */
export function lessonStars({ tasks, correct }) {
  if (tasks < 5) return 0;
  const acc = correct / tasks;
  return 1 + (acc >= 0.6 ? 1 : 0) + (acc >= 0.85 ? 1 : 0);
}

export function blitzStars({ correct, newRecord }) {
  return 1 + (correct >= 10 ? 1 : 0) + (newRecord ? 1 : 0);
}

export const DIAGNOSTIC_STARS = 2;

export function streakInfo(profile, today = dayNumber()) {
  const days = new Set(profile.sessions.map((s) => s.day));
  let current = 0;
  const start = days.has(today) ? today : days.has(today - 1) ? today - 1 : null;
  if (start !== null) for (let d = start; days.has(d); d--) current += 1;
  let best = 0;
  let run = 0;
  let prev = null;
  for (const d of [...days].sort((x, y) => x - y)) {
    run = prev !== null && d === prev + 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  return {
    current,
    best: Math.max(best, profile.bestStreak ?? 0, current),
    practicedToday: days.has(today),
  };
}

export const BADGES = Object.freeze([
  { id: 'diag', icon: '🦉', title: 'Знакомство', text: 'Теперь я знаю, что ты уже умеешь.' },
  { id: 'first-lesson', icon: '🌱', title: 'Первое занятие', text: 'Начало положено!' },
  { id: 'zero', icon: '⭕', title: 'Правило нуля', text: 'Любое число × 0 = 0.' },
  ...COLUMN_ORDER.map((k) => ({
    id: `col-${k}`, icon: '🏅', title: `Мастер ×${k}`, text: `Ты знаешь весь столбик ×${k}.`, column: k,
  })),
  ...COLUMN_ORDER.map((k) => ({
    id: `auto-${k}`, icon: '⚡', title: `Молния ×${k}`, text: `Столбик ×${k} — на автомате!`, column: k,
  })),
  { id: 'streak-3', icon: '🔥', title: '3 дня подряд', text: 'Три дня занятий без пропуска.' },
  { id: 'streak-7', icon: '🔥', title: 'Неделя подряд', text: 'Семь дней без пропуска!' },
  { id: 'streak-14', icon: '🔥', title: '2 недели подряд', text: 'Четырнадцать дней подряд!' },
  { id: 'streak-30', icon: '🔥', title: 'Месяц подряд', text: 'Тридцать дней подряд!' },
  { id: 'blitz-15', icon: '🚀', title: 'Быстрый ум', text: '15 верных ответов в блице.' },
  { id: 'all', icon: '🏆', title: 'Вся таблица', text: 'Все 100 примеров освоены!' },
]);

export const BADGE_BY_ID = Object.freeze(Object.fromEntries(BADGES.map((b) => [b.id, b])));

/** Выдаёт заслуженные награды. Награды не отнимаются, даже если факт потом забылся. */
export function updateBadges(profile, today = dayNumber()) {
  const earned = [];
  const award = (id) => {
    if (profile.badges[id] == null) {
      profile.badges[id] = today;
      earned.push(BADGE_BY_ID[id]);
    }
  };
  if (profile.diagnostic) award('diag');
  if (profile.sessions.some((s) => s.type === 'lesson')) award('first-lesson');
  if (profile.zeroLessonDone) award('zero');
  for (const k of COLUMN_ORDER) {
    const ids = columnFacts(k);
    if (ids.every((id) => isMastered(profile.facts[id]))) award(`col-${k}`);
    if (ids.every((id) => factStatus(profile.facts[id]) === STATUS.AUTO)) award(`auto-${k}`);
  }
  const { current } = streakInfo(profile, today);
  for (const n of [3, 7, 14, 30]) if (current >= n) award(`streak-${n}`);
  if (profile.blitzBest >= 15) award('blitz-15');
  if (ALL_FACT_IDS.every((id) => isMastered(profile.facts[id]))) award('all');
  return earned;
}

/**
 * Записывает занятие в журнал профиля, начисляет звёзды и награды.
 * rec — итог из LessonRunner/BlitzRunner.summary() или диагностики.
 * Повторная запись с тем же id обновляет занятие (незаконченное при уходе со страницы,
 * а потом — законченное), а не добавляет второе.
 */
export function recordSession(profile, rec, { now = Date.now() } = {}) {
  const today = dayNumber(now);
  let stars = 0;
  let newRecord = false;
  if (rec.type === 'lesson') {
    stars = lessonStars(rec);
  } else if (rec.type === 'blitz') {
    newRecord = rec.correct > profile.blitzBest;
    if (newRecord) profile.blitzBest = rec.correct;
    stars = blitzStars({ correct: rec.correct, newRecord });
  } else {
    stars = DIAGNOSTIC_STARS;
  }
  const session = normalizeSession({ ...rec, stars });
  const existing = profile.sessions.findIndex((s) => s.id === session.id);
  if (existing >= 0) profile.sessions[existing] = session;
  else profile.sessions.push(session);
  trimSessions(profile);
  const streak = streakInfo(profile, today);
  profile.bestStreak = Math.max(profile.bestStreak, streak.best);
  const badges = updateBadges(profile, today);
  return { session, stars, newRecord, streak, badges };
}

export function statusCounts(profile) {
  const counts = { new: 0, learning: 0, known: 0, auto: 0 };
  for (const id of ALL_FACT_IDS) counts[factStatus(profile.facts[id])] += 1;
  return counts;
}

/** Процент освоения: доля фактов со статусом «знает» или «автоматизм». */
export function masteryPercent(profile) {
  const c = statusCounts(profile);
  return Math.round(((c.known + c.auto) / ALL_FACT_IDS.length) * 100);
}

export function columnProgress(profile, k) {
  const ids = columnFacts(k);
  const statuses = ids.map((id) => factStatus(profile.facts[id]));
  return {
    k,
    mastered: statuses.filter((s) => s === STATUS.KNOWN || s === STATUS.AUTO).length,
    auto: statuses.filter((s) => s === STATUS.AUTO).length,
    total: ids.length,
  };
}

export function factDetails(profile, id) {
  const f = profile.facts[id];
  const { a, b } = parseFactId(id);
  return {
    id,
    a,
    b,
    product: a * b,
    status: factStatus(f),
    accuracy: accuracy(f),
    avgMs: averageMs(f),
    attempts: f.attempts,
    errors: f.errors,
    wrong: f.history.filter((h) => !h[2]).map((h) => h[4]).reverse(),
    box: f.box,
    due: f.due,
    introduced: f.introduced,
    placed: f.placed,
  };
}

/** Занятия по дням (только дни с занятиями), новые — в конце. */
export function dailyStats(profile, { today = dayNumber(), days = 30 } = {}) {
  const from = today - days + 1;
  const map = new Map();
  for (const s of profile.sessions) {
    if (s.day < from || s.day > today) continue;
    const d = map.get(s.day) ?? { day: s.day, sessions: 0, lessons: 0, blitz: 0, tasks: 0, correct: 0, answerMs: 0, durationMs: 0, stars: 0 };
    d.sessions += 1;
    if (s.type === 'lesson') d.lessons += 1;
    if (s.type === 'blitz') d.blitz += 1;
    d.tasks += s.tasks;
    d.correct += s.correct;
    d.answerMs += s.totalMs;
    d.durationMs += s.durationMs;
    d.stars += s.stars;
    map.set(s.day, d);
  }
  return [...map.values()]
    .sort((x, y) => x.day - y.day)
    .map((d) => ({
      ...d,
      accuracy: d.tasks ? d.correct / d.tasks : null,
      avgMs: d.tasks ? d.answerMs / d.tasks : null,
    }));
}

/** Самые трудные примеры: низкая точность, затем долгие ответы. */
export function hardestFacts(profile, limit = 8) {
  return ALL_FACT_IDS
    .map((id) => factDetails(profile, id))
    .filter((d) => d.attempts >= 2 && (d.errors > 0 || d.avgMs > 4000))
    .sort((x, y) => x.accuracy - y.accuracy || y.avgMs - x.avgMs || y.errors - x.errors)
    .slice(0, limit);
}

export function profileSummary(profile, today = dayNumber()) {
  let attempts = 0;
  let correct = 0;
  let totalMs = 0;
  for (const id of ALL_FACT_IDS) {
    const f = profile.facts[id];
    attempts += f.attempts;
    correct += f.correct;
    totalMs += f.totalMs;
  }
  const week = profile.sessions.filter((s) => s.day > today - 7);
  const weekTasks = week.reduce((s, x) => s + x.tasks, 0);
  const weekCorrect = week.reduce((s, x) => s + x.correct, 0);
  return {
    counts: statusCounts(profile),
    mastery: masteryPercent(profile),
    accuracyAll: attempts ? correct / attempts : null,
    accuracyWeek: weekTasks ? weekCorrect / weekTasks : null,
    avgMs: attempts ? totalMs / attempts : null,
    attempts,
    sessions: profile.archivedSessions + profile.sessions.length,
    practiceMs: profile.sessions.reduce((s, x) => s + x.durationMs, 0),
    stars: totalStars(profile),
    streak: streakInfo(profile, today),
  };
}
