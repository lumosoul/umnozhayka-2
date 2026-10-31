// Календарь приложения. «День» — номер суток по местному времени, считая от 1970-01-01.
// Так серии дней и интервалы Лейтнера не зависят от часового пояса и перехода на летнее время.

export const DAY_MS = 86400000;

export function dayNumber(time = Date.now()) {
  const d = new Date(time);
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
}

/** Полночь местного времени для номера дня. */
export function dayToDate(day) {
  const u = new Date(day * DAY_MS);
  return new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate());
}

export function nowSec(time = Date.now()) {
  return Math.floor(time / 1000);
}

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн',
  'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const WEEKDAYS_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

export function formatDay(day, { short = false, weekday = false } = {}) {
  const d = dayToDate(day);
  const text = `${d.getDate()} ${(short ? MONTHS_SHORT : MONTHS)[d.getMonth()]}`;
  return weekday ? `${WEEKDAYS_SHORT[d.getDay()]}, ${text}` : text;
}

/** Русское склонение: plural(5, ['день', 'дня', 'дней']) → 'дней'. */
export function plural(n, forms) {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (last === 1) return forms[0];
  if (last >= 2 && last <= 4) return forms[1];
  return forms[2];
}

export function countText(n, forms) {
  return `${n} ${plural(n, forms)}`;
}

/** «сегодня», «завтра», «через 3 дня», «5 дней назад». */
export function relativeDay(day, today = dayNumber()) {
  const diff = day - today;
  if (diff === 0) return 'сегодня';
  if (diff === 1) return 'завтра';
  if (diff === -1) return 'вчера';
  if (diff > 1) return `через ${countText(diff, ['день', 'дня', 'дней'])}`;
  return `${countText(-diff, ['день', 'дня', 'дней'])} назад`;
}

/** «4,2 с» — секунды с одним знаком после запятой. */
export function formatSeconds(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  return `${(ms / 1000).toFixed(1).replace('.', ',')} с`;
}

export function formatMinutes(ms) {
  const min = Math.round(ms / 60000);
  if (min < 1) return 'меньше минуты';
  return countText(min, ['минута', 'минуты', 'минут']);
}
