// Итоги занятия или блица: звёзды (только заработанные — без «пустых»), похвала за старание,
// серия дней и новые награды.

import { h } from '../dom.js';
import { owlSays } from '../components/owl.js';
import { childTopbar, phrases } from '../common.js';
import { sound } from '../audio.js';
import { countText } from '../../core/dates.js';
import { parseFactId } from '../../core/facts.js';

// Блиц кончается по таймеру — ребёнок может как раз нажимать «OK» или Enter. Кнопки итогов
// оживают чуть позже, чтобы случайное нажатие не увело с экрана со звёздами.
const ACTIONS_DELAY_MS = 700;

const factText = (id) => {
  const { a, b } = parseFactId(id);
  return `${a} × ${b}`;
};

export function summaryScreen(app, { kind, summary, result }) {
  const isBlitz = kind === 'blitz';
  const lines = [];
  if (isBlitz) {
    lines.push(`За 60 секунд — ${countText(summary.correct, ['верный ответ', 'верных ответа', 'верных ответов'])}!`);
    if (result.newRecord) lines.push('Это новый рекорд! 🎉');
    else if (app.profile.blitzBest) lines.push(`Твой рекорд: ${app.profile.blitzBest}.`);
  } else {
    lines.push(`Готово заданий: ${summary.tasks}, верных ответов: ${summary.correct}.`);
    if (summary.newFacts) lines.push(`Новые примеры: ${summary.learned.map(factText).join(', ')}.`);
    if (summary.mastered.length) lines.push(`Выучено сегодня: ${summary.mastered.map(factText).join(', ')}.`);
    if (summary.corrections) lines.push(`Исправлено ошибок: ${summary.corrections} — так и учатся!`);
  }
  const streakLine = result.streak.current > 1
    ? `🔥 Серия: ${countText(result.streak.current, ['день', 'дня', 'дней'])} подряд!`
    : '🔥 Серия началась — приходи завтра, чтобы её продолжить!';

  const home = h('button', { type: 'button', class: 'btn btn--primary btn--big btn--block', onClick: () => app.go('home') }, 'На главную');
  const actions = h('div', { class: 'btn-stack', inert: true, style: { width: '100%' } },
    home,
    h('button', { type: 'button', class: 'btn btn--secondary btn--block', onClick: () => app.go('progress') }, '🟩 Посмотреть прогресс'));
  const el = h('section', { class: 'screen screen--narrow' },
    childTopbar(app, { title: isBlitz ? 'Блиц окончен!' : 'Занятие окончено!' }),
    h('div', { class: 'summary' },
      owlSays(phrases.effort(), { mood: 'cheer', size: 'big', center: true }),
      result.stars > 0 && h('div', { class: 'stars', role: 'img', 'aria-label': `Звёзд: ${result.stars}` },
        Array.from({ length: result.stars }, () => h('span', null, '⭐'))),
      result.stars > 0 && h('p', { style: { fontWeight: 800, margin: 0 } }, `+${countText(result.stars, ['звезда', 'звезды', 'звёзд'])}`),
      h('div', { class: 'card', style: { width: '100%', textAlign: 'left' } },
        lines.map((t) => h('p', null, t)),
        h('p', { style: { margin: 0, fontWeight: 700 } }, streakLine)),
      result.badges.length > 0 && h('div', { style: { display: 'grid', gap: '10px', width: '100%' } },
        result.badges.map((b) => h('div', { class: 'badge-earned' },
          h('span', { class: 'badge-earned__icon', 'aria-hidden': 'true' }, b.icon),
          h('span', null, `Новая награда: «${b.title}». ${b.text}`)))),
      isBlitz && summary.missed?.length > 0 && h('p', { class: 'notice notice--calm', style: { width: '100%' } },
        `Повторим в занятии: ${summary.missed.map(factText).join(', ')}.`),
      actions));

  sound.play(result.badges.length ? 'badge' : 'complete');
  setTimeout(() => {
    actions.removeAttribute('inert');
    home.focus({ preventScroll: true });
  }, ACTIONS_DELAY_MS);
  return { el };
}
