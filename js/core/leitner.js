// Пять коробок Лейтнера. Коробка задаёт, через сколько дней факт покажется снова.

export const BOX_COUNT = 5;
/** Интервалы для коробок 1…5, в днях. */
export const INTERVALS = Object.freeze([0, 1, 3, 7, 14]);
/** Верный ответ дольше этого времени не двигает факт вперёд. */
export const SLOW_MS = 6000;
/** Порог «автоматизма»: верный ответ быстрее 3 секунд. */
export const FAST_MS = 3000;

export function clampBox(box) {
  return Math.min(BOX_COUNT, Math.max(1, Math.round(Number(box) || 1)));
}

export function intervalFor(box) {
  return INTERVALS[clampBox(box) - 1];
}

export function isDue(card, today) {
  return card.due <= today;
}

/**
 * Новое положение карточки после ответа.
 *  - ошибка → коробка 1, показать сегодня же;
 *  - верно, но дольше 6 с → коробка не меняется, срок отсчитывается заново;
 *  - верно и быстрее 6 с → следующая коробка.
 * Как в Anki, повтор раньше срока (факт ещё не «созрел») коробку не двигает:
 * иначе три верных ответа подряд в одном занятии перенесли бы новый факт сразу на неделю.
 */
export function scheduleAfterAnswer(card, { correct, ms }, today) {
  const box = clampBox(card.box);
  const due = Number.isFinite(card.due) ? card.due : today;
  const wasDue = due <= today;
  if (!correct) {
    return { box: 1, due: today, move: 'reset' };
  }
  if (ms > SLOW_MS) {
    return { box, due: wasDue ? today + intervalFor(box) : due, move: 'stay' };
  }
  if (!wasDue) {
    return { box, due, move: 'early' };
  }
  const next = Math.min(BOX_COUNT, box + 1);
  return { box: next, due: today + intervalFor(next), move: next > box ? 'up' : 'stay' };
}
