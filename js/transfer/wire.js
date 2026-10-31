// Столбцовая запись снимка для кода и QR. Данные те же, что в JSON-файле (преобразование обратимо),
// но поля 100 фактов идут столбцами, а времена — разностями: DEFLATE сжимает такое заметно лучше.

import { ALL_FACT_IDS } from '../core/facts.js';
import { createFactState } from '../core/knowledge.js';

const FACT_FIELDS = Object.keys(createFactState()).filter((k) => k !== 'history');
/** Поля-времена: пишем как смещение от минимального ненулевого значения (0 остаётся 0). */
const OFFSET_FIELDS = new Set(['due', 'autoStart', 'autoLast', 'lastSeen', 'updatedAt']);
const HISTORY_WIDTH = 5;

function offsetEncode(values) {
  const nonZero = values.filter((v) => v !== 0);
  const base = nonZero.length ? Math.min(...nonZero) - 1 : 0;
  return { base, values: values.map((v) => (v === 0 ? 0 : v - base)) };
}

function offsetDecode({ base, values }) {
  return values.map((v) => (v === 0 ? 0 : v + base));
}

function profileToWire(p) {
  const { facts, ...rest } = p;
  const cols = {};
  for (const k of FACT_FIELDS) {
    const values = ALL_FACT_IDS.map((id) => facts[id][k]);
    cols[k] = OFFSET_FIELDS.has(k) ? offsetEncode(values) : values;
  }
  // История: сколько записей у каждого факта и по столбцам; время записи — разность с предыдущей.
  const counts = [];
  const columns = Array.from({ length: HISTORY_WIDTH }, () => []);
  let prevT = 0;
  for (const id of ALL_FACT_IDS) {
    const h = facts[id].history;
    counts.push(h.length);
    for (const entry of h) {
      columns[0].push(entry[0] - prevT);
      prevT = entry[0];
      for (let c = 1; c < HISTORY_WIDTH; c++) columns[c].push(entry[c]);
    }
  }
  return { ...rest, factCols: cols, history: { counts, columns } };
}

function profileFromWire(w) {
  const { factCols, history, ...rest } = w;
  if (!factCols || !history || !Array.isArray(history.counts) || !Array.isArray(history.columns)) {
    throw new Error('Нет данных фактов');
  }
  const facts = {};
  const cols = {};
  for (const k of FACT_FIELDS) {
    const raw = factCols[k];
    const values = OFFSET_FIELDS.has(k) ? offsetDecode(raw) : raw;
    if (!Array.isArray(values) || values.length !== ALL_FACT_IDS.length) throw new Error(`Нет столбца ${k}`);
    cols[k] = values;
  }
  const columns = history.columns;
  let pos = 0;
  let prevT = 0;
  ALL_FACT_IDS.forEach((id, i) => {
    const f = {};
    for (const k of FACT_FIELDS) f[k] = cols[k][i];
    f.history = [];
    for (let n = 0; n < history.counts[i]; n++, pos++) {
      const t = prevT + columns[0][pos];
      prevT = t;
      const entry = [t];
      for (let c = 1; c < HISTORY_WIDTH; c++) entry.push(columns[c][pos]);
      f.history.push(entry);
    }
    facts[id] = f;
  });
  return { ...rest, facts };
}

export function toWire(snapshot) {
  return { ...snapshot, profiles: snapshot.profiles.map(profileToWire) };
}

export function fromWire(wire) {
  if (!wire || !Array.isArray(wire.profiles)) return wire;
  return { ...wire, profiles: wire.profiles.map(profileFromWire) };
}
