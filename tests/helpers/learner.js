// Модель ребёнка для тестов: у каждого факта скрытая «сила памяти» от 0 до 1.
// Практика её повышает, перерывы — понижают; от силы зависят верность и скорость ответа.

import { ALL_FACT_IDS, parseFactId } from '../../js/core/facts.js';

export class SimLearner {
  constructor(rng, { knownColumns = [], strength = 0.97, base = 0.03 } = {}) {
    this.rng = rng;
    this.strength = {};
    for (const id of ALL_FACT_IDS) {
      const { a, b } = parseFactId(id);
      const knows = knownColumns.includes(a) || knownColumns.includes(b);
      this.strength[id] = knows ? strength : base;
    }
  }

  knows(id) {
    return this.strength[id] >= 0.8;
  }

  /** Ответ на задание: { value, ms }. value = null — «не знаю». */
  respond(task) {
    const s = this.strength[task.factId];
    const recognition = task.format === 'choice' || task.format === 'truefalse';
    const p = recognition ? 0.35 + 0.65 * s : s;
    const correct = this.rng() < p;
    const ms = correct
      ? (s > 0.85 ? 1200 + this.rng() * 1500 : 3000 + this.rng() * 5000)
      : 4000 + this.rng() * 5000;
    let value;
    if (task.format === 'truefalse') value = correct ? task.truth : !task.truth;
    else if (correct) value = task.answer;
    else value = task.format === 'missing' ? task.answer + 1 : task.product + 1;
    this.learn(task.factId, correct ? 0.22 : 0.3);
    return { value, ms, correct };
  }

  /** Практика укрепляет память; разбор ошибки — тоже. */
  learn(id, rate) {
    const s = this.strength[id];
    this.strength[id] = Math.min(0.99, s + (1 - s) * rate);
  }

  /** Забывание за прошедшие дни: сильная память забывается медленнее. */
  forget(days) {
    for (const id of ALL_FACT_IDS) {
      const s = this.strength[id];
      const decay = s > 0.9 ? 0.995 : 0.97;
      this.strength[id] = s * decay ** days;
    }
  }
}

/** Ответ ребёнка, который знает заданные столбцы (для диагностики). */
export function diagnosticResponder(knownColumns, { rng, fastMs = 2200, slowMs = 8000 } = {}) {
  return (id) => {
    const { a, b } = parseFactId(id);
    const knows = knownColumns.includes(a) || knownColumns.includes(b);
    if (knows) return { correct: true, ms: fastMs + (rng ? rng() * 800 : 0), given: a * b };
    return { correct: false, ms: slowMs, given: null };
  };
}
