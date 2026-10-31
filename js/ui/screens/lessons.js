// «Уроки и приёмы»: объяснения столбцов и правило нуля можно открыть снова в любой момент.

import { h } from '../dom.js';
import { owlSays } from '../components/owl.js';
import { childTopbar } from '../common.js';
import { columnSlides, slideShow, zeroSlides } from '../components/explain.js';
import { COLUMN_ORDER, COLUMN_TRICK_TITLES } from '../../core/facts.js';

export function lessonsScreen(app) {
  const p = app.profile;
  const body = h('div', { style: { display: 'grid', gap: '16px' } });
  const el = h('section', { class: 'screen' },
    childTopbar(app, { title: 'Уроки и приёмы', back: () => app.go('home') }),
    body);
  let keyHandler = null;

  const list = () => {
    keyHandler = null;
    const zeroOpen = p.zeroLessonDone || p.introducedColumns.length > 0;
    const items = [
      h('button', { type: 'button', class: 'btn btn--secondary', disabled: !zeroOpen, onClick: () => open(zeroSlides(), 'Правило нуля') },
        h('span', { class: 'icon', 'aria-hidden': 'true' }, '⭕'), 'Умножение на 0'),
      ...COLUMN_ORDER.map((k) => {
        const ready = p.introducedColumns.includes(k);
        return h('button', { type: 'button', class: 'btn btn--secondary', disabled: !ready, onClick: () => open(columnSlides(k), `×${k}`) },
          h('span', { class: 'icon', 'aria-hidden': 'true' }, `×${k}`),
          h('span', null, COLUMN_TRICK_TITLES[k], !ready && h('span', { class: 'profile-card__meta' }, 'Откроется на занятии')));
      }),
    ];
    body.replaceChildren(
      owlSays('Здесь живут все объяснения. Открой любое, чтобы повторить приём.'),
      h('nav', { class: 'menu-grid', 'aria-label': 'Уроки' }, items));
  };

  const open = (slides) => {
    const show = slideShow(slides, { doneLabel: 'Готово', onDone: list });
    keyHandler = show.onKey;
    body.replaceChildren(show.el);
  };

  list();
  return { el, onKey: (e) => (keyHandler ? keyHandler(e) : false) };
}
