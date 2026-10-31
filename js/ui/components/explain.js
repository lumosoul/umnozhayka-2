// Объяснения: столбец начинается с понимания (группы → сетка точек → числовой луч → приём →
// перестановка множителей), отдельно — правило умножения на 0. Короткие фразы, на «ты».

import { h } from '../dom.js';
import { owlSays } from './owl.js';
import { chain, dotGroups, emptyGroups, numberLine, trickVisual } from './visuals.js';
import { columnIntro, groupsWord, trickFor } from '../../core/facts.js';
import { plural } from '../../core/dates.js';

const rows = (k) => `${k} ${plural(k, ['ряд', 'ряда', 'рядов'])}`;
const jumps = (k) => `${k} ${plural(k, ['прыжок', 'прыжка', 'прыжков'])}`;
const dots = (n) => `${n} ${plural(n, ['точке', 'точки', 'точек'])}`;

/** Слайды объяснения столбца ×k. */
export function columnSlides(k) {
  const c = columnIntro(k);
  const { n } = c;
  return [
    {
      title: `${c.title}!`,
      owl: 'Умножение — это когда складываем одинаковые группы.',
      body: () => [
        h('p', { class: 'slide__text' }, c.groupsText),
        dotGroups(n, k, { labels: false }),
        h('p', { class: 'sum-line' }, c.sumText),
      ],
    },
    {
      title: 'Сетка точек',
      owl: 'Сложим группы рядами — получится сетка. Считай по рядам!',
      body: () => [
        h('p', { class: 'slide__text' }, `${rows(k)} по ${dots(n)} — всего ${n * k}.`),
        dotGroups(n, k, { plain: true, labels: true }),
      ],
    },
    {
      title: 'Числовой луч',
      owl: `Прыгаем по ${n}: ${jumps(k)} от нуля.`,
      body: () => [
        numberLine(n, k),
        h('p', { class: 'slide__text' }, `${jumps(k)} по ${n} — и мы на числе ${n * k}.`),
      ],
    },
    {
      title: `Приём: ${c.trickTitle}`,
      owl: 'Вот хитрость, чтобы считать быстрее.',
      body: () => [
        trickVisual(k, n),
        h('p', { class: 'trick' }, c.trick),
      ],
    },
    {
      title: 'Перестановка множителей',
      owl: 'Поменяй числа местами — ответ тот же!',
      body: () => [
        h('p', { class: 'sum-line' }, c.swapText),
        h('div', { class: 'btn-row', style: { justifyContent: 'center', alignItems: 'flex-start' } },
          dotGroups(n, k, { plain: true, labels: false }),
          dotGroups(k, n, { plain: true, labels: false })),
        h('p', { class: 'slide__text' }, `${k} ${groupsWord(k)} по ${n} — столько же, сколько ${n} ${groupsWord(n)} по ${k}.`),
      ],
    },
  ];
}

/** Слайды правила нуля (упражнения к нему проводит экран занятия). */
export function zeroSlides() {
  return [
    {
      title: 'Умножение на 0',
      owl: 'Сегодня — особое правило про ноль!',
      body: () => [
        h('p', { class: 'slide__text' }, '5 × 0 — это 0 групп по 5. Групп нет — значит, нет и точек.'),
        h('p', { class: 'sum-line' }, '5 × 0 = 0'),
      ],
    },
    {
      title: 'Пустые группы',
      owl: 'А если групп много, но они пустые?',
      body: () => [
        emptyGroups(4),
        h('p', { class: 'slide__text' }, '0 × 4 — это 4 группы по 0: 0 + 0 + 0 + 0 = 0.'),
        h('p', { class: 'sum-line' }, '0 × 4 = 0'),
      ],
    },
    {
      title: 'Прыжки на месте',
      owl: 'Прыжки длиной 0 — стоим на месте!',
      body: () => [
        chain([0, 0, 0, 0], '+0'),
        h('p', { class: 'slide__text' }, 'Сколько ни прыгай по 0 — останешься на нуле.'),
      ],
    },
    {
      title: 'Правило',
      owl: 'Запомни — и проверим на трёх примерах.',
      body: () => [
        h('p', { class: 'sum-line' }, 'Любое число × 0 = 0'),
        h('p', { class: 'sum-line' }, '0 × любое число = 0'),
      ],
    },
  ];
}

/**
 * Показ слайдов с кнопками «Назад» / «Дальше». Клавиатура: ← → и Enter.
 * Возвращает { el, onKey }.
 */
export function slideShow(slides, { onDone, doneLabel = 'Начинаем!' } = {}) {
  let index = 0;
  const holder = h('div', { class: 'slides' });
  const render = () => {
    const s = slides[index];
    const back = h('button', { type: 'button', class: 'btn btn--secondary', disabled: index === 0, onClick: () => go(-1) }, '← Назад');
    const last = index === slides.length - 1;
    const next = h('button', { type: 'button', class: 'btn btn--primary', onClick: () => go(1) }, last ? doneLabel : 'Дальше →');
    holder.replaceChildren(
      owlSays(s.owl),
      h('section', { class: 'slide', 'aria-live': 'polite' },
        h('h2', { class: 'slide__title' }, s.title),
        s.body()),
      h('div', { class: 'steps', 'aria-label': `Шаг ${index + 1} из ${slides.length}` },
        slides.map((_, i) => h('span', { class: i === index ? 'is-on' : '' }))),
      h('div', { class: 'btn-row' }, back, next),
    );
    requestAnimationFrame(() => next.focus({ preventScroll: true }));
  };
  const go = (d) => {
    if (d > 0 && index === slides.length - 1) {
      onDone?.();
      return;
    }
    index = Math.max(0, Math.min(slides.length - 1, index + d));
    render();
  };
  render();
  return {
    el: holder,
    onKey(e) {
      if (e.key === 'ArrowRight') {
        go(1);
        return true;
      }
      if (e.key === 'ArrowLeft') {
        go(-1);
        return true;
      }
      return false;
    },
  };
}

/** Карточка знакомства с новым фактом: пример, точки, приём и связь с известной парой. */
export function newFactCard(task, { pairKnown = false, onReady } = {}) {
  const { a, b, product } = task;
  const tip = trickFor(a, b);
  const pairLine = pairKnown && a !== b
    ? h('p', { class: 'notice notice--good' }, `Ты уже знаешь ${b} × ${a} = ${product}. Поменяй множители — ответ тот же!`)
    : null;
  const ready = h('button', { type: 'button', class: 'btn btn--primary btn--big', onClick: () => onReady?.() }, 'Понятно!');
  const el = h('div', { class: 'new-fact' },
    h('span', { class: 'new-fact__badge' }, 'Новый пример'),
    h('p', { class: 'expr' }, `${a} × ${b} = ${product}`),
    dotGroups(a, b, { labels: b > 1 }),
    pairLine,
    h('p', { class: 'trick' }, tip.text),
    ready);
  requestAnimationFrame(() => ready.focus({ preventScroll: true }));
  return el;
}
