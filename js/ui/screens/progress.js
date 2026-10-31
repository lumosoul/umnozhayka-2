// Прогресс: сетка 10 × 10, цвет клетки — статус факта (серый, жёлтый, светло-зелёный, тёмно-зелёный),
// касание открывает точность, среднее время и ошибки. Стрелки клавиатуры ходят по клеткам.

import { h } from '../dom.js';
import { owlSays } from '../components/owl.js';
import { childTopbar, statusPill } from '../common.js';
import { COLUMN_ORDER, FACTORS, STATUS_LABELS, factId } from '../../core/facts.js';
import { factStatus } from '../../core/knowledge.js';
import { columnProgress, factDetails, masteryPercent, statusCounts, streakInfo } from '../../core/progress.js';
import { totalStars } from '../../core/profile.js';
import { countText, formatSeconds, relativeDay } from '../../core/dates.js';

/** Сетка 10 × 10. interactive — клетки-кнопки с выбором; иначе — просто картинка. */
function buildGrid(profile, { interactive = false, onSelect } = {}) {
  const cells = [];
  const grid = h('div', {
    class: 'grid10',
    role: interactive ? 'grid' : 'img',
    'aria-label': interactive ? 'Таблица умножения: строка — первый множитель, столбец — второй' : 'Сетка прогресса',
  });
  grid.append(h('span', { class: 'grid10__head', 'aria-hidden': 'true' }, '×'));
  for (const b of FACTORS) grid.append(h('span', { class: 'grid10__head', 'aria-hidden': 'true' }, String(b)));
  for (const a of FACTORS) {
    grid.append(h('span', { class: 'grid10__head', 'aria-hidden': 'true' }, String(a)));
    for (const b of FACTORS) {
      const id = factId(a, b);
      const status = factStatus(profile.facts[id]);
      const label = `${a} × ${b} = ${a * b}, ${STATUS_LABELS[status]}`;
      const cell = interactive
        ? h('button', {
          type: 'button',
          class: ['cell', `cell--${status}`],
          role: 'gridcell',
          'aria-label': label,
          'aria-selected': 'false',
          tabindex: -1,
          dataset: { id, a: String(a), b: String(b) },
          onClick: () => select(cells.indexOf(cell)),
        }, String(a * b))
        : h('span', { class: ['cell', `cell--${status}`], title: label, 'aria-hidden': 'true' }, String(a * b));
      cells.push(cell);
      grid.append(cell);
    }
  }
  let current = -1;
  function select(i, focus = true) {
    if (!interactive) return;
    if (current >= 0) {
      cells[current].setAttribute('aria-selected', 'false');
      cells[current].tabIndex = -1;
    }
    current = i;
    cells[i].setAttribute('aria-selected', 'true');
    cells[i].tabIndex = 0;
    if (focus) cells[i].focus({ preventScroll: true });
    onSelect?.(cells[i].dataset.id);
  }
  if (interactive) {
    cells[0].tabIndex = 0;
    grid.addEventListener('keydown', (e) => {
      const i = Math.max(0, current);
      const moves = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 10, ArrowUp: -10, Home: -(i % 10), End: 9 - (i % 10) };
      if (!(e.key in moves)) return;
      e.preventDefault();
      e.stopPropagation();
      const next = i + moves[e.key];
      if (next >= 0 && next < 100) select(next);
    });
  }
  grid.select = select;
  return grid;
}

export function gridMini(profile) {
  return buildGrid(profile);
}

function legend(counts) {
  return h('ul', { class: 'legend' },
    ['new', 'learning', 'known', 'auto'].map((s) => h('li', null,
      h('span', { class: ['swatch', `swatch--${s}`], 'aria-hidden': 'true' }),
      `${STATUS_LABELS[s]}: ${counts[s]}`)));
}

function detailPanel(profile, id, today) {
  const d = factDetails(profile, id);
  const rows = [];
  if (!d.introduced && !d.attempts) {
    rows.push(h('p', { style: { margin: 0 } }, 'Этот пример мы ещё не учили. Скоро познакомимся!'));
  } else {
    const errorsText = d.errors
      ? `${d.errors}${d.wrong.length ? ` (ответы: ${d.wrong.slice(0, 4).map((v) => (v < 0 ? '«не знаю»' : v)).join(', ')})` : ''}`
      : 'нет';
    rows.push(h('dl', null,
      h('dt', null, 'Точность'), h('dd', null, d.accuracy == null ? '—' : `${Math.round(d.accuracy * 100)} % (${d.attempts - d.errors} из ${d.attempts})`),
      h('dt', null, 'Среднее время'), h('dd', null, formatSeconds(d.avgMs)),
      h('dt', null, 'Ошибки'), h('dd', null, errorsText),
      h('dt', null, 'Коробка'), h('dd', null, `${d.box} из 5`),
      h('dt', null, 'Повторим'), h('dd', null, d.introduced ? relativeDay(Math.max(d.due, today), today) : '—')));
    if (d.placed && d.attempts <= 1) rows.push(h('p', { class: 'muted small', style: { margin: 0 } }, 'Отмечен по итогам знакомства.'));
  }
  return h('div', { class: 'fact-detail', 'aria-live': 'polite' },
    h('div', { class: 'fact-detail__title' },
      h('h2', { style: { margin: 0 } }, `${d.a} × ${d.b} = ${d.product}`),
      statusPill(d.status)),
    rows);
}

export function progressScreen(app) {
  const p = app.profile;
  const today = app.today();
  const counts = statusCounts(p);
  const mastery = masteryPercent(p);
  const streak = streakInfo(p, today);
  const detail = h('div', null, h('p', { class: 'muted', style: { margin: 0 } }, 'Нажми на клетку, чтобы узнать подробности.'));
  const grid = buildGrid(p, {
    interactive: true,
    onSelect: (id) => detail.replaceChildren(detailPanel(p, id, today)),
  });
  const ring = (() => {
    const r = 52;
    const c = 2 * Math.PI * r;
    return h('div', { class: 'ring', role: 'img', 'aria-label': `Освоено ${mastery} процентов` },
      h('svg', { viewBox: '0 0 120 120', width: 120, height: 120, 'aria-hidden': 'true' },
        h('circle', { cx: 60, cy: 60, r, fill: 'none', stroke: '#D9DDE4', 'stroke-width': 12 }),
        h('circle', { cx: 60, cy: 60, r, fill: 'none', stroke: '#1F7A45', 'stroke-width': 12, 'stroke-linecap': 'round', 'stroke-dasharray': `${(c * mastery) / 100} ${c}` })),
      h('span', { class: 'ring__value' }, `${mastery}%`));
  })();
  const columns = h('div', { class: 'chips', style: { justifyContent: 'center' } },
    COLUMN_ORDER.map((k) => {
      const cp = columnProgress(p, k);
      const icon = cp.auto === cp.total ? '⚡' : cp.mastered === cp.total ? '🏅' : '';
      return h('span', { class: 'chip', title: `Столбик ×${k}` }, `×${k}: ${cp.mastered}/10 ${icon}`);
    }));

  const el = h('section', { class: 'screen' },
    childTopbar(app, { title: 'Мой прогресс', back: () => app.go('home') }),
    h('div', { class: 'progress-layout' },
      h('div', { class: 'card', style: { display: 'grid', gap: '14px' } },
        h('div', { class: 'table-wrap' }, grid),
        legend(counts)),
      h('div', { style: { display: 'grid', gap: '16px' } },
        h('div', { class: 'card', style: { display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap' } },
          ring,
          h('div', null,
            h('p', { style: { margin: 0, fontWeight: 800, fontSize: '1.25rem' } }, `Освоено: ${counts.known + counts.auto} из 100`),
            h('p', { class: 'muted', style: { margin: 0 } }, `⚡ на автомате: ${counts.auto}`),
            h('p', { class: 'muted', style: { margin: 0 } }, `🔥 ${countText(streak.current, ['день', 'дня', 'дней'])} подряд · ⭐ ${totalStars(p)}`))),
        detail,
        h('div', { class: 'card card--soft' }, h('h2', null, 'Столбики'), columns),
        owlSays(counts.learning ? 'Жёлтые клетки — то, что сейчас учим. Они станут зелёными!' : 'Каждое занятие красит новые клетки!', { size: 'small' }))));
  return { el };
}
