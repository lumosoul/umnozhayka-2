// Наглядность: группы и сетка точек, числовой луч с прыжками, пальцы для ×9, цепочки приёмов.
// n × k читаем как «k групп по n»: k рядов, в каждом n точек.

import { h } from '../dom.js';
import { groupsWord } from '../../core/facts.js';
import { plural } from '../../core/dates.js';

function dotSize(n) {
  if (n >= 9) return 12;
  if (n >= 7) return 14;
  if (n >= 5) return 16;
  return 20;
}

/**
 * k групп по n точек. plain — сплошная сетка без рамок групп;
 * labels — промежуточные суммы справа (n, 2n, 3n…); highlight — подсветка при разборе ошибки.
 */
export function dotGroups(n, k, { plain = false, labels = true, highlight = false } = {}) {
  const rows = [];
  for (let r = 1; r <= k; r++) {
    rows.push(h('div', { class: ['dots__row', highlight && 'is-lit'] },
      h('div', { class: 'dots__group' }, Array.from({ length: n }, () => h('span', { class: 'dot' }))),
      labels && h('span', { class: 'dots__label' }, String(n * r))));
  }
  return h('div', {
    class: ['dots', plain && 'dots--plain', highlight && 'dots--highlight'],
    style: { '--dot': `${dotSize(Math.max(n, k > 8 ? 9 : 0))}px`, '--dot-gap': n >= 9 ? '4px' : '5px' },
    role: 'img',
    'aria-label': `${k} ${groupsWord(k)} по ${n}, всего ${n * k}`,
  }, rows);
}

/** Числовой луч: k прыжков по n от нуля. */
export function numberLine(n, k) {
  const W = 560;
  const H = 130;
  const pad = 24;
  const total = Math.max(1, n * k);
  const x = (v) => pad + (v / total) * (W - 2 * pad);
  const baseY = 92;
  const svg = h('svg', {
    class: 'numline',
    viewBox: `0 0 ${W} ${H}`,
    role: 'img',
    'aria-label': `Числовой луч: ${k} прыжков по ${n} — получается ${n * k}`,
  });
  svg.append(h('line', { x1: pad - 8, y1: baseY, x2: W - pad + 12, y2: baseY, stroke: '#5A5470', 'stroke-width': 3, 'stroke-linecap': 'round' }));
  svg.append(h('path', { d: `M${W - pad + 12} ${baseY} l-10 -6 v12 z`, fill: '#5A5470' }));
  const step = (W - 2 * pad) / Math.max(1, k);
  const labelEvery = step < 26 ? 2 : 1;
  for (let i = 0; i <= k; i++) {
    const v = i * n;
    svg.append(h('line', { x1: x(v), y1: baseY - 8, x2: x(v), y2: baseY + 8, stroke: '#5A5470', 'stroke-width': 2 }));
    if (i % labelEvery === 0 || i === k) {
      svg.append(h('text', {
        x: x(v), y: baseY + 30, 'text-anchor': 'middle', 'font-size': i === k ? 20 : 16,
        fill: i === k ? '#2F62D0' : '#26213A',
      }, String(v)));
    }
  }
  for (let i = 0; i < k; i++) {
    const x1 = x(i * n);
    const x2 = x((i + 1) * n);
    const top = baseY - Math.min(56, 18 + (x2 - x1) * 0.45);
    svg.append(h('path', {
      d: `M${x1} ${baseY - 4} Q${(x1 + x2) / 2} ${top} ${x2} ${baseY - 4}`,
      fill: 'none', stroke: i % 2 ? '#C77700' : '#2F62D0', 'stroke-width': 3, 'stroke-linecap': 'round',
    }));
    if (step >= 34) {
      svg.append(h('text', { x: (x1 + x2) / 2, y: top + 2, 'text-anchor': 'middle', 'font-size': 14, fill: '#5A5470' }, `+${n}`));
    }
  }
  return svg;
}

/** Пальцы для ×9: загибаем n-й палец; слева — десятки, справа — единицы. */
export function fingers9(n) {
  const W = 420;
  const H = 190;
  const svg = h('svg', {
    class: 'fingers',
    viewBox: `0 0 ${W} ${H}`,
    role: 'img',
    'aria-label': `Загнут ${n}-й палец: слева ${n - 1}, справа ${10 - n}, получается ${9 * n}`,
  });
  const heights = [70, 96, 108, 100, 84, 84, 100, 108, 96, 70];
  const cxOf = (i) => 26 + i * 37 + (i >= 5 ? 16 : 0);
  for (let i = 0; i < 10; i++) {
    const cx = cxOf(i);
    const bent = i + 1 === n;
    const hgt = bent ? 34 : heights[i];
    const fill = bent ? '#FFB81C' : i + 1 < n ? '#5B8DEF' : '#A6E3A8';
    svg.append(h('rect', { x: cx - 13, y: 132 - hgt, width: 26, height: hgt, rx: 13, fill, stroke: '#26213A', 'stroke-width': 1.5 }));
    svg.append(h('text', { x: cx, y: 152, 'text-anchor': 'middle', 'font-size': 13, fill: '#5A5470' }, String(i + 1)));
  }
  const tens = n - 1;
  const units = 10 - n;
  const leftX = tens > 0 ? (cxOf(0) + cxOf(tens - 1)) / 2 : cxOf(0) + 14;
  const rightX = units > 0 ? (cxOf(n) + cxOf(9)) / 2 : cxOf(9) - 20;
  svg.append(h('text', { x: leftX, y: 180, 'text-anchor': 'middle', 'font-size': 16, fill: '#2F62D0' },
    `${tens} ${plural(tens, ['десяток', 'десятка', 'десятков'])}`));
  svg.append(h('text', { x: rightX, y: 180, 'text-anchor': 'middle', 'font-size': 16, fill: '#1B6B3C' },
    `${units} ${plural(units, ['единица', 'единицы', 'единиц'])}`));
  return svg;
}

/** Цепочка шагов: 3 → 6 → 12 → 24 (с подписями над стрелками). */
export function chain(items, arrowLabel = '') {
  const parts = [];
  items.forEach((item, i) => {
    if (i) parts.push(h('span', { class: 'chain__arrow', 'aria-hidden': 'true' }, arrowLabel ? `${arrowLabel} →` : '→'));
    parts.push(h('span', { class: 'chain__item' }, String(item)));
  });
  return h('div', { class: 'chain', role: 'img', 'aria-label': items.join(', затем ') }, parts);
}

/** Наглядность приёма столбца ×k для числа n. */
export function trickVisual(k, n) {
  switch (k) {
    case 2:
      return chain([n, n * 2], '×2');
    case 4:
      return chain([n, n * 2, n * 4], '×2');
    case 8:
      return chain([n, n * 2, n * 4, n * 8], '×2');
    case 5:
      return chain([`${n} × 10 = ${n * 10}`, `${n * 5}`], '½');
    case 9:
      return fingers9(n);
    case 10:
      return chain([n, `${n}0`], '+0');
    case 3:
      return chain([`${n} + ${n} = ${n * 2}`, `${n * 2} + ${n} = ${n * 3}`]);
    case 6:
      return chain([`${n} × 5 = ${n * 5}`, `${n * 5} + ${n} = ${n * 6}`]);
    case 7:
      return chain([`${n} × 5 = ${n * 5}`, `${n} × 2 = ${n * 2}`, `${n * 5} + ${n * 2} = ${n * 7}`]);
    default:
      return chain([n, n], '×1');
  }
}

/** Пустые «тарелки» для правила нуля: k групп, в которых ничего нет. */
export function emptyGroups(k) {
  return h('div', { class: 'dots', role: 'img', 'aria-label': `${k} пустых групп` },
    h('div', { class: 'dots__row' },
      Array.from({ length: k }, () => h('div', {
        class: 'dots__group',
        style: { width: '44px', height: '44px', borderRadius: '50%', boxShadow: 'inset 0 0 0 3px #8E86A3', background: '#fff' },
      }))));
}
