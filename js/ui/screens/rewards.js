// Награды: за освоенные столбики, автоматизм, серии дней и правило нуля.
// Ещё не полученные показаны спокойно — как цель, а не как «проигрыш».

import { h } from '../dom.js';
import { owlSays } from '../components/owl.js';
import { childTopbar } from '../common.js';
import { BADGES, streakInfo } from '../../core/progress.js';
import { totalStars } from '../../core/profile.js';
import { formatDay } from '../../core/dates.js';

export function rewardsScreen(app) {
  const p = app.profile;
  const earned = BADGES.filter((b) => p.badges[b.id] != null);
  const streak = streakInfo(p, app.today());
  const el = h('section', { class: 'screen' },
    childTopbar(app, { title: 'Награды', back: () => app.go('home') }),
    owlSays(earned.length
      ? `У тебя ${earned.length} из ${BADGES.length} наград и ${totalStars(p)} ⭐. Лучшая серия — ${streak.best} дн.`
      : 'Здесь будут твои награды. Первая — уже за первое занятие!'),
    h('div', { class: 'badges' },
      BADGES.map((b) => {
        const day = p.badges[b.id];
        const got = day != null;
        return h('div', { class: ['badge', !got && 'badge--locked'] },
          h('span', { class: 'badge__icon', 'aria-hidden': 'true' }, b.icon),
          h('span', { class: 'badge__title' }, b.title),
          h('span', { class: 'badge__text' }, got ? `${b.text} ${formatDay(day, { short: true })}` : 'Впереди!'),
          h('span', { class: 'sr-only' }, got ? 'получена' : 'ещё не получена'));
      })));
  return { el };
}
