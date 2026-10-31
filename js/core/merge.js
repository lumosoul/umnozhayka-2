// Объединение профилей при импорте. Слияние идемпотентно: повторный импорт того же файла ничего не меняет.

import { ALL_FACT_IDS, COLUMN_ORDER } from './facts.js';
import { MAX_PROFILES, trimSessions } from './profile.js';

const clone = (v) => JSON.parse(JSON.stringify(v));

/** По каждому факту берём более свежую запись (по updatedAt); при равенстве остаётся местная. */
export function mergeFact(local, remote) {
  if (!remote) return { fact: local, from: 'local' };
  if (!local) return { fact: remote, from: 'remote' };
  return remote.updatedAt > local.updatedAt
    ? { fact: remote, from: 'remote' }
    : { fact: local, from: 'local' };
}

function minPositive(a, b) {
  if (!a) return b;
  if (!b) return a;
  return Math.min(a, b);
}

export function mergeProfiles(local, remote) {
  const facts = {};
  let fromRemote = 0;
  for (const id of ALL_FACT_IDS) {
    const r = mergeFact(local.facts[id], remote.facts[id]);
    facts[id] = clone(r.fact);
    if (r.from === 'remote') fromRemote += 1;
  }

  const archivedBefore = Math.max(local.archivedBefore ?? 0, remote.archivedBefore ?? 0);
  const byId = new Map();
  for (const s of local.sessions) byId.set(s.id, s);
  let sessionsAdded = 0;
  for (const s of remote.sessions) {
    if (byId.has(s.id) || s.start <= archivedBefore) continue;
    byId.set(s.id, s);
    sessionsAdded += 1;
  }
  const sessions = [...byId.values()]
    .filter((s) => s.start > archivedBefore)
    .sort((x, y) => x.start - y.start || (x.id < y.id ? -1 : 1))
    .map(clone);

  const badges = { ...local.badges };
  for (const [id, day] of Object.entries(remote.badges)) {
    badges[id] = badges[id] == null ? day : Math.min(badges[id], day);
  }
  const remoteName = remote.nameUpdatedAt > local.nameUpdatedAt;
  const columns = new Set([...local.introducedColumns, ...remote.introducedColumns]);

  const profile = {
    id: local.id,
    name: remoteName ? remote.name : local.name,
    avatar: remoteName ? remote.avatar : local.avatar,
    createdAt: minPositive(local.createdAt, remote.createdAt),
    nameUpdatedAt: Math.max(local.nameUpdatedAt, remote.nameUpdatedAt),
    diagnostic: clone(local.diagnostic ?? remote.diagnostic ?? null),
    diagnosticDraft: local.diagnostic || remote.diagnostic
      ? null
      : clone(local.diagnosticDraft ?? remote.diagnosticDraft ?? null),
    zeroLessonDone: local.zeroLessonDone || remote.zeroLessonDone,
    introducedColumns: COLUMN_ORDER.filter((k) => columns.has(k)),
    archivedStars: Math.max(local.archivedStars, remote.archivedStars),
    archivedSessions: Math.max(local.archivedSessions, remote.archivedSessions),
    archivedBefore,
    blitzBest: Math.max(local.blitzBest, remote.blitzBest),
    bestStreak: Math.max(local.bestStreak, remote.bestStreak),
    badges,
    facts,
    sessions,
  };
  trimSessions(profile);
  return {
    profile,
    stats: { fromRemote, keptLocal: ALL_FACT_IDS.length - fromRemote, sessionsAdded },
  };
}

const sameName = (x, y) => x.name.trim().toLowerCase() === y.name.trim().toLowerCase();

/**
 * План импорта для экрана подтверждения: что добавим, что объединим, что не поместится.
 * Профиль ищем по идентификатору, а если его нет — по имени (тот же ребёнок на другом устройстве).
 */
export function planImport(existing, incoming) {
  const plan = [];
  const taken = new Set();
  let free = MAX_PROFILES - existing.length;
  for (const remote of incoming) {
    let local = existing.find((p) => p.id === remote.id && !taken.has(p.id));
    let matchedBy = 'id';
    if (!local) {
      local = existing.find((p) => !taken.has(p.id)
        && sameName(p, remote)
        && !incoming.some((r) => r.id === p.id));
      matchedBy = 'name';
    }
    if (local) {
      taken.add(local.id);
      const { stats } = mergeProfiles(local, remote);
      plan.push({ action: 'merge', remote, local, matchedBy, stats, overwrites: stats.fromRemote > 0 });
    } else if (free > 0) {
      free -= 1;
      plan.push({ action: 'add', remote });
    } else {
      plan.push({ action: 'skip', remote, reason: 'limit' });
    }
  }
  return plan;
}

/** Профили, которые нужно сохранить после подтверждения. */
export function applyImport(plan) {
  const out = [];
  for (const step of plan) {
    if (step.action === 'add') out.push(clone(step.remote));
    else if (step.action === 'merge') out.push(mergeProfiles(step.local, step.remote).profile);
  }
  return out;
}
