// Простые SVG-графики для родительского экрана: линия (среднее время ответа) и столбцы (задания по дням).
// Рисуем в реальных пикселях контейнера (подписи не мельчают на узком экране) и перерисовываем
// при изменении ширины. Подсказка — при наведении и при фокусе с клавиатуры (стрелки ← →);
// все значения дублируются таблицей под графиком, так что подсказка ничего не прячет.

import { h } from '../dom.js';

const INK_2 = '#5A5470';
const GRID = '#E6DCCB';
const SERIES = '#2F62D0';
const SURFACE = '#FFFFFF';

/** Деления оси: круглый шаг (1, 2, 2,5 или 5 × 10^k) и число знаков после запятой для подписей. */
export function niceScale(maxValue, target = 4) {
  const raw = Math.max(maxValue, 1e-9) / target;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const m = [1, 2, 2.5, 5, 10].find((x) => x * pow >= raw);
  const step = m * pow;
  const count = Math.max(1, Math.ceil(maxValue / step - 1e-9));
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + (m === 2.5 ? 1 : 0));
  return {
    max: step * count,
    decimals,
    ticks: Array.from({ length: count + 1 }, (_, i) => Number((step * i).toFixed(10))),
  };
}

function createFrame(label) {
  const tip = h('div', { class: 'chart-tip', role: 'status', hidden: true });
  const host = h('div', {
    class: 'chart-host',
    tabindex: 0,
    role: 'img',
    'aria-label': label,
    style: { position: 'relative' },
  });
  host.append(tip);
  return { host, tip };
}

function showTip(frame, x, y, value, label) {
  const { tip, host } = frame;
  tip.replaceChildren(h('strong', null, value), h('span', null, label));
  tip.hidden = false;
  const w = host.clientWidth;
  const tipW = Math.min(180, w - 8);
  tip.style.left = `${Math.max(4, Math.min(w - tipW - 4, x - tipW / 2))}px`;
  tip.style.top = `${Math.max(0, y - 64)}px`;
  tip.style.width = `${tipW}px`;
}

function mount(frame, draw) {
  let width = 0;
  const render = () => {
    const w = Math.max(240, Math.floor(frame.host.clientWidth || 320));
    if (w === width) return;
    width = w;
    frame.host.querySelector('svg')?.remove();
    frame.host.prepend(draw(w));
  };
  requestAnimationFrame(render);
  if (globalThis.ResizeObserver) new ResizeObserver(render).observe(frame.host);
  else globalThis.addEventListener('resize', render);
}

/**
 * Линейный график одной серии. points: [{ label, value, display }].
 * yFormat — подпись делений оси Y.
 */
export function lineChart(points, { label, yFormat = (v) => String(v), height = 220 } = {}) {
  const frame = createFrame(label);
  if (!points.length) return h('p', { class: 'muted' }, 'Пока нет данных.');
  let focusIndex = points.length - 1;

  const draw = (W) => {
    const m = { l: 44, r: 54, t: 18, b: 34 };
    const scale = niceScale(Math.max(...points.map((p) => p.value)) * 1.05);
    const { max } = scale;
    const pw = W - m.l - m.r;
    const ph = height - m.t - m.b;
    const x = (i) => m.l + (points.length === 1 ? pw / 2 : (i / (points.length - 1)) * pw);
    const y = (v) => m.t + ph - (v / max) * ph;
    const svg = h('svg', { class: 'chart', width: W, height, viewBox: `0 0 ${W} ${height}`, 'aria-hidden': 'true' });
    for (const t of scale.ticks) {
      svg.append(h('line', { class: 'chart__grid', x1: m.l, x2: W - m.r, y1: y(t), y2: y(t) }));
      svg.append(h('text', { x: m.l - 8, y: y(t) + 4, 'text-anchor': 'end' }, yFormat(t, scale.decimals)));
    }
    const coords = points.map((p, i) => [x(i), y(p.value)]);
    const line = coords.map(([cx, cy], i) => `${i ? 'L' : 'M'}${cx.toFixed(1)} ${cy.toFixed(1)}`).join(' ');
    svg.append(h('path', { d: `${line} L${coords.at(-1)[0]} ${y(0)} L${coords[0][0]} ${y(0)} Z`, fill: SERIES, 'fill-opacity': 0.1 }));
    svg.append(h('path', { d: line, fill: 'none', stroke: SERIES, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    for (const [cx, cy] of coords) {
      svg.append(h('circle', { cx, cy, r: 4.5, fill: SERIES, stroke: SURFACE, 'stroke-width': 2 }));
    }
    // подпись только у последней точки — остальные значения в подсказке и таблице
    const [lx, ly] = coords.at(-1);
    svg.append(h('text', { x: lx + 10, y: ly + 4, fill: '#26213A', 'font-weight': 700, 'font-size': 13 }, points.at(-1).display));
    const every = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(pw / 70))));
    points.forEach((p, i) => {
      if (i % every === 0 || i === points.length - 1) {
        svg.append(h('text', { x: x(i), y: height - 10, 'text-anchor': 'middle' }, p.label));
      }
    });
    const cross = h('line', { x1: 0, x2: 0, y1: m.t, y2: m.t + ph, stroke: INK_2, 'stroke-width': 1, opacity: 0 });
    svg.append(cross);
    const hit = h('rect', { x: m.l - 12, y: 0, width: pw + 24, height, fill: 'transparent' });
    svg.append(hit);
    const showAt = (i) => {
      focusIndex = i;
      cross.setAttribute('x1', x(i));
      cross.setAttribute('x2', x(i));
      cross.setAttribute('opacity', 0.6);
      showTip(frame, x(i), y(points[i].value), points[i].display, points[i].tip ?? points[i].label);
    };
    hit.addEventListener('pointermove', (e) => {
      const rect = svg.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * W;
      let best = 0;
      for (let i = 1; i < points.length; i++) if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
      showAt(best);
    });
    hit.addEventListener('pointerleave', () => {
      cross.setAttribute('opacity', 0);
      frame.tip.hidden = true;
    });
    svg.showAt = showAt;
    return svg;
  };

  frame.host.addEventListener('focus', () => frame.host.querySelector('svg')?.showAt(focusIndex));
  frame.host.addEventListener('blur', () => {
    frame.tip.hidden = true;
  });
  frame.host.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation();
    focusIndex = Math.max(0, Math.min(points.length - 1, focusIndex + (e.key === 'ArrowRight' ? 1 : -1)));
    frame.host.querySelector('svg')?.showAt(focusIndex);
  });
  mount(frame, draw);
  return frame.host;
}

/** Столбцы одной серии. points: [{ label, value, display, tip }]. */
export function barChart(points, { label, yFormat = (v) => String(v), height = 200 } = {}) {
  const frame = createFrame(label);
  if (!points.length) return h('p', { class: 'muted' }, 'Пока нет данных.');
  let focusIndex = points.length - 1;

  const draw = (W) => {
    const m = { l: 40, r: 12, t: 22, b: 34 };
    const scale = niceScale(Math.max(...points.map((p) => p.value), 1));
    const { max } = scale;
    const pw = W - m.l - m.r;
    const ph = height - m.t - m.b;
    const band = pw / points.length;
    const bw = Math.max(4, Math.min(24, band - 2));
    const y = (v) => m.t + ph - (v / max) * ph;
    const svg = h('svg', { class: 'chart', width: W, height, viewBox: `0 0 ${W} ${height}`, 'aria-hidden': 'true' });
    for (const t of scale.ticks) {
      svg.append(h('line', { class: 'chart__grid', x1: m.l, x2: W - m.r, y1: y(t), y2: y(t) }));
      svg.append(h('text', { x: m.l - 8, y: y(t) + 4, 'text-anchor': 'end' }, yFormat(t, scale.decimals)));
    }
    const bars = [];
    let maxIndex = 0;
    points.forEach((p, i) => {
      if (p.value > points[maxIndex].value) maxIndex = i;
      const cx = m.l + band * (i + 0.5);
      const top = y(p.value);
      const hgt = y(0) - top;
      const r = Math.min(4, hgt, bw / 2);
      // скругление только у вершины, основание — прямое
      const d = hgt <= 0 ? '' : `M${cx - bw / 2} ${y(0)} V${top + r} Q${cx - bw / 2} ${top} ${cx - bw / 2 + r} ${top} H${cx + bw / 2 - r} Q${cx + bw / 2} ${top} ${cx + bw / 2} ${top + r} V${y(0)} Z`;
      const bar = h('path', { d, fill: SERIES });
      svg.append(bar);
      bars.push({ bar, cx, top });
    });
    // подпись только у самого большого значения и у последнего дня
    for (const i of new Set([maxIndex, points.length - 1])) {
      if (points[i].value > 0) {
        svg.append(h('text', { x: bars[i].cx, y: bars[i].top - 6, 'text-anchor': 'middle', fill: '#26213A', 'font-weight': 700, 'font-size': 12 }, points[i].display));
      }
    }
    const every = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(pw / 56))));
    points.forEach((p, i) => {
      if (i % every === 0 || i === points.length - 1) {
        svg.append(h('text', { x: bars[i].cx, y: height - 10, 'text-anchor': 'middle' }, p.label));
      }
    });
    const showAt = (i) => {
      focusIndex = i;
      bars.forEach((b, k) => b.bar.setAttribute('fill-opacity', k === i ? 1 : 0.55));
      showTip(frame, bars[i].cx, bars[i].top, points[i].display, points[i].tip ?? points[i].label);
    };
    points.forEach((p, i) => {
      const hit = h('rect', { x: m.l + band * i, y: 0, width: band, height, fill: 'transparent' });
      hit.addEventListener('pointerenter', () => showAt(i));
      hit.addEventListener('pointerleave', () => {
        bars.forEach((b) => b.bar.setAttribute('fill-opacity', 1));
        frame.tip.hidden = true;
      });
      svg.append(hit);
    });
    svg.showAt = showAt;
    return svg;
  };

  frame.host.addEventListener('focus', () => frame.host.querySelector('svg')?.showAt(focusIndex));
  frame.host.addEventListener('blur', () => {
    frame.tip.hidden = true;
  });
  frame.host.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation();
    focusIndex = Math.max(0, Math.min(points.length - 1, focusIndex + (e.key === 'ArrowRight' ? 1 : -1)));
    frame.host.querySelector('svg')?.showAt(focusIndex);
  });
  mount(frame, draw);
  return frame.host;
}
