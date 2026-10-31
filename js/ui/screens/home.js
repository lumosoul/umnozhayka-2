// Главная ребёнка: одна большая кнопка «Начать занятие», серия дней, звёзды, освоение и разделы.

import { h } from '../dom.js';
import { owlSays } from '../components/owl.js';
import { childTopbar, phrases } from '../common.js';
import { masteryPercent, statusCounts, streakInfo } from '../../core/progress.js';
import { BLITZ_MIN_FACTS, blitzAvailable, blitzPool } from '../../core/session.js';
import { countText, plural } from '../../core/dates.js';
import { sound } from '../audio.js';

export function homeScreen(app) {
  const p = app.profile;
  const today = app.today();
  const streak = streakInfo(p, today);
  const counts = statusCounts(p);
  const mastery = masteryPercent(p);

  let line;
  if (counts.known + counts.auto === 100) line = 'Ты знаешь всю таблицу! Повторяй и проходи блиц.';
  else if (streak.practicedToday) line = 'Сегодня занятие уже есть — серия продолжается! Можно ещё одно.';
  else if (streak.current > 0) line = `Серия: ${countText(streak.current, ['день', 'дня', 'дней'])} подряд. Позанимайся сегодня, чтобы её продолжить!`;
  else line = phrases.greet(p.name);

  const canBlitz = blitzAvailable(p);
  const blitzLeft = Math.max(0, BLITZ_MIN_FACTS - blitzPool(p).length);
  const start = h('button', {
    type: 'button',
    class: 'btn btn--primary btn--big btn--block',
    onClick: () => {
      sound.play('start');
      app.go('lesson');
    },
  }, '▶ Начать занятие');

  const el = h('section', { class: 'screen' },
    childTopbar(app, { showProfile: true }),
    h('div', { class: 'hero' },
      h('div', { class: 'card', style: { display: 'grid', gap: '16px' } },
        owlSays(line, { size: 'big' }),
        h('div', { class: 'hero__start' },
          start,
          h('p', { class: 'muted center small', style: { margin: 0 } }, '20 заданий · около 10 минут'))),
      h('div', { class: 'stats-row' },
        h('div', { class: 'stat' },
          h('span', { class: 'stat__value' }, `${mastery} %`),
          h('span', { class: 'stat__label' }, 'таблицы освоено'),
          h('div', { class: 'progress-bar', role: 'img', 'aria-label': `Освоено ${mastery} процентов`, style: { marginTop: '8px' } },
            h('span', { style: { width: `${mastery}%` } }))),
        h('div', { class: 'stat' },
          h('span', { class: 'stat__value' }, `🔥 ${streak.current}`),
          h('span', { class: 'stat__label' }, `${plural(streak.current, ['день', 'дня', 'дней'])} подряд · рекорд ${streak.best}`)),
        h('div', { class: 'stat' },
          h('span', { class: 'stat__value' }, `⚡ ${counts.auto}`),
          h('span', { class: 'stat__label' }, 'на автомате')))),
    h('nav', { class: 'menu-grid', 'aria-label': 'Разделы' },
      h('button', {
        type: 'button',
        class: 'btn btn--secondary',
        disabled: !canBlitz,
        onClick: () => app.go('blitz'),
      }, h('span', { class: 'icon', 'aria-hidden': 'true' }, '⚡'),
      h('span', null, 'Блиц 60 секунд',
        !canBlitz && h('span', { class: 'profile-card__meta' }, `Откроется, когда выучишь ещё ${countText(blitzLeft, ['пример', 'примера', 'примеров'])}`))),
      h('button', { type: 'button', class: 'btn btn--secondary', onClick: () => app.go('progress') },
        h('span', { class: 'icon', 'aria-hidden': 'true' }, '🟩'), 'Мой прогресс'),
      h('button', { type: 'button', class: 'btn btn--secondary', onClick: () => app.go('rewards') },
        h('span', { class: 'icon', 'aria-hidden': 'true' }, '🏅'), 'Награды'),
      h('button', { type: 'button', class: 'btn btn--secondary', onClick: () => app.go('lessons') },
        h('span', { class: 'icon', 'aria-hidden': 'true' }, '📖'), 'Уроки и приёмы')),
    h('div', { style: { marginTop: 'auto', display: 'flex', justifyContent: 'center' } },
      h('button', { type: 'button', class: 'btn btn--ghost btn--small', onClick: () => app.go('parent') }, '🔒 Для взрослых')));

  return {
    el,
    onKey(e) {
      if (e.key === 'Enter' && document.activeElement === document.body) {
        start.click();
        return true;
      }
      return false;
    },
  };
}
