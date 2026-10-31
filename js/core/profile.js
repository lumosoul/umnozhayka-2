// Профиль ребёнка: один документ со всеми 100 фактами, журналом занятий и наградами.

import { ALL_FACT_IDS, FACTORS, isFactId } from './facts.js';
import { createFactState, HISTORY_LIMIT } from './knowledge.js';
import { BOX_COUNT } from './leitner.js';
import { nowSec } from './dates.js';
import { randomId } from './rng.js';

export const MAX_PROFILES = 4;
export const NAME_MAX = 16;
/** Сколько последних занятий хранить подробно (старые сворачиваются в счётчики). */
export const SESSION_LOG_LIMIT = 200;

export const AVATARS = Object.freeze([
  { id: 'fox', emoji: '🦊', label: 'Лисёнок' },
  { id: 'bear', emoji: '🐻', label: 'Медвежонок' },
  { id: 'rabbit', emoji: '🐰', label: 'Зайчик' },
  { id: 'cat', emoji: '🐱', label: 'Котёнок' },
  { id: 'dog', emoji: '🐶', label: 'Щенок' },
  { id: 'panda', emoji: '🐼', label: 'Панда' },
  { id: 'frog', emoji: '🐸', label: 'Лягушонок' },
  { id: 'tiger', emoji: '🐯', label: 'Тигрёнок' },
]);

export function avatarOf(profile) {
  return AVATARS.find((a) => a.id === profile.avatar) ?? AVATARS[0];
}

export function cleanName(name) {
  return String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
}

export function createProfile({ name, avatar, now = Date.now() } = {}) {
  const t = nowSec(now);
  const facts = {};
  for (const id of ALL_FACT_IDS) facts[id] = createFactState();
  return {
    id: `p-${randomId(10)}`,
    name: cleanName(name) || 'Ученик',
    avatar: AVATARS.some((a) => a.id === avatar) ? avatar : AVATARS[0].id,
    createdAt: t,
    nameUpdatedAt: t,
    diagnostic: null,
    diagnosticDraft: null,
    zeroLessonDone: false,
    introducedColumns: [],
    archivedStars: 0,
    archivedSessions: 0,
    archivedBefore: 0,
    blitzBest: 0,
    bestStreak: 0,
    badges: {},
    facts,
    sessions: [],
  };
}

const int = (v, min, max, dflt = min) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
};

const MAX_TIME = 4102444800; // 2100-01-01 в секундах — защита от мусора в импортируемых данных
const MAX_DAY = 47482;       // 2100-01-01 в днях

function normalizeHistory(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const h of list.slice(-HISTORY_LIMIT)) {
    if (!Array.isArray(h) || h.length < 5) continue;
    out.push([
      int(h[0], 0, MAX_TIME),
      int(h[1], 0, 600000),
      h[2] ? 1 : 0,
      int(h[3], 0, 9),
      int(h[4], -1, 1000, -1),
    ]);
  }
  return out;
}

export function normalizeFact(raw) {
  const f = createFactState();
  if (!raw || typeof raw !== 'object') return f;
  f.introduced = Boolean(raw.introduced);
  f.box = int(raw.box, 1, BOX_COUNT, 1);
  f.streak = int(raw.streak, 0, 10000);
  f.due = int(raw.due, 0, MAX_DAY);
  f.attempts = int(raw.attempts, 0, 1e7);
  f.correct = int(raw.correct, 0, f.attempts);
  f.errors = int(raw.errors, 0, f.attempts);
  f.slow = int(raw.slow, 0, f.correct);
  f.totalMs = int(raw.totalMs, 0, 1e12);
  f.autoRun = int(raw.autoRun, 0, 10000);
  f.autoStart = int(raw.autoStart, 0, MAX_DAY);
  f.autoLast = int(raw.autoLast, 0, MAX_DAY);
  f.autoSession = typeof raw.autoSession === 'string' ? raw.autoSession.slice(0, 40) : '';
  f.placed = int(raw.placed, 0, 2);
  f.lastSeen = int(raw.lastSeen, 0, MAX_TIME);
  f.updatedAt = int(raw.updatedAt, 0, MAX_TIME);
  f.history = normalizeHistory(raw.history);
  return f;
}

const SESSION_TYPES = new Set(['lesson', 'blitz', 'diagnostic']);

/** Незаконченная диагностика (чтобы продолжить её после перезагрузки). */
export function normalizeDiagnosticDraft(d) {
  if (!d || typeof d !== 'object' || !Array.isArray(d.answers)) return null;
  const answers = d.answers
    .filter((a) => a && isFactId(a.id))
    .slice(0, 20)
    .map((a) => ({
      id: a.id,
      correct: Boolean(a.correct),
      ms: int(a.ms, 0, 600000),
      given: a.given == null ? null : int(a.given, -1, 1000),
    }));
  return {
    id: typeof d.id === 'string' ? d.id.slice(0, 40) : '',
    answers,
    elapsedMs: int(d.elapsedMs, 0, 3600000),
    totalMs: int(d.totalMs, 0, 1e7),
  };
}

export function normalizeSession(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) return null;
  return {
    id: raw.id.slice(0, 40),
    type: SESSION_TYPES.has(raw.type) ? raw.type : 'lesson',
    day: int(raw.day, 0, MAX_DAY),
    start: int(raw.start, 0, MAX_TIME),
    durationMs: int(raw.durationMs, 0, 86400000),
    tasks: int(raw.tasks, 0, 10000),
    correct: int(raw.correct, 0, 10000),
    totalMs: int(raw.totalMs, 0, 1e10),
    newFacts: int(raw.newFacts, 0, 100),
    improved: int(raw.improved, 0, 1000),
    stars: int(raw.stars, 0, 3),
  };
}

/**
 * Приводит профиль к текущей схеме: все 100 фактов, числа в допустимых границах.
 * Используется при чтении из базы и при импорте (данные из файла считаем ненадёжными).
 */
export function normalizeProfile(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Профиль повреждён');
  if (typeof raw.id !== 'string' || !/^[\w-]{1,40}$/.test(raw.id)) throw new Error('У профиля нет идентификатора');
  const facts = {};
  const src = raw.facts && typeof raw.facts === 'object' ? raw.facts : {};
  for (const id of ALL_FACT_IDS) facts[id] = normalizeFact(src[id]);
  const sessions = Array.isArray(raw.sessions)
    ? raw.sessions.map(normalizeSession).filter(Boolean)
    : [];
  sessions.sort((x, y) => x.start - y.start || (x.id < y.id ? -1 : 1));
  const badges = {};
  if (raw.badges && typeof raw.badges === 'object') {
    for (const [k, v] of Object.entries(raw.badges)) {
      if (/^[\w-]{1,24}$/.test(k)) badges[k] = int(v, 0, MAX_DAY);
    }
  }
  const diag = raw.diagnostic && typeof raw.diagnostic === 'object'
    ? {
        at: int(raw.diagnostic.at, 0, MAX_TIME),
        items: int(raw.diagnostic.items, 0, 100),
        known: int(raw.diagnostic.known, 0, 100),
        durationMs: int(raw.diagnostic.durationMs, 0, 3600000),
      }
    : null;
  return {
    id: raw.id,
    name: cleanName(raw.name) || 'Ученик',
    avatar: AVATARS.some((a) => a.id === raw.avatar) ? raw.avatar : AVATARS[0].id,
    createdAt: int(raw.createdAt, 0, MAX_TIME),
    nameUpdatedAt: int(raw.nameUpdatedAt, 0, MAX_TIME),
    diagnostic: diag,
    diagnosticDraft: diag ? null : normalizeDiagnosticDraft(raw.diagnosticDraft),
    zeroLessonDone: Boolean(raw.zeroLessonDone),
    introducedColumns: Array.isArray(raw.introducedColumns)
      ? [...new Set(raw.introducedColumns.map(Number).filter((k) => FACTORS.includes(k)))]
      : [],
    archivedStars: int(raw.archivedStars, 0, 1e7),
    archivedSessions: int(raw.archivedSessions, 0, 1e7),
    archivedBefore: int(raw.archivedBefore, 0, MAX_TIME),
    blitzBest: int(raw.blitzBest, 0, 1000),
    bestStreak: int(raw.bestStreak, 0, 100000),
    badges,
    facts,
    sessions,
  };
}

/**
 * Удаляет из журнала самые старые занятия сверх лимита, сохраняя их звёзды в счётчике.
 * archivedBefore запоминает границу, чтобы при слиянии уже свёрнутые занятия не вернулись повторно.
 */
export function trimSessions(profile) {
  const extra = profile.sessions.length - SESSION_LOG_LIMIT;
  if (extra <= 0) return;
  const dropped = profile.sessions.splice(0, extra);
  profile.archivedSessions += dropped.length;
  profile.archivedStars += dropped.reduce((s, x) => s + x.stars, 0);
  profile.archivedBefore = Math.max(profile.archivedBefore, dropped[dropped.length - 1].start);
}

export function totalStars(profile) {
  return profile.archivedStars + profile.sessions.reduce((s, x) => s + x.stars, 0);
}

export function isProfileShape(obj) {
  return Boolean(obj && typeof obj === 'object' && typeof obj.id === 'string'
    && obj.facts && typeof obj.facts === 'object'
    && Object.keys(obj.facts).every(isFactId));
}
