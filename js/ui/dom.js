// Мини-помощники для DOM без фреймворка.

const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set(['svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon', 'text', 'tspan', 'defs', 'title']);

function setProps(el, props) {
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.setAttribute('class', Array.isArray(value) ? value.filter(Boolean).join(' ') : value);
    else if (key === 'style' && typeof value === 'object') {
      for (const [prop, v] of Object.entries(value)) {
        if (prop.startsWith('--')) el.style.setProperty(prop, v);
        else el.style[prop] = v;
      }
    }
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'text') el.textContent = value;
    else if (key === 'html') el.innerHTML = value;
    else if (key in el && !SVG_TAGS.has(el.tagName) && key !== 'list' && key !== 'form') el[key] = value === true ? true : value;
    else el.setAttribute(key, value === true ? '' : value);
  }
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** h('button', { class: 'btn', onClick }, 'Текст') */
export function h(tag, props, ...children) {
  const el = SVG_TAGS.has(tag) ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
  } else {
    setProps(el, props);
  }
  append(el, children);
  return el;
}

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

/** Заменить содержимое; null и false пропускаются (replaceChildren превратил бы их в текст «null»). */
export function fill(el, ...children) {
  clear(el);
  append(el, children);
  return el;
}

/** Сообщение для экранных дикторов (aria-live). */
export function announce(text) {
  const live = document.getElementById('live');
  if (!live) return;
  live.textContent = '';
  requestAnimationFrame(() => {
    live.textContent = text;
  });
}

let toastTimer = null;
export function toast(text, ms = 2600) {
  document.querySelector('.toast')?.remove();
  clearTimeout(toastTimer);
  const el = h('div', { class: 'toast', role: 'status' }, text);
  document.body.append(el);
  toastTimer = setTimeout(() => el.remove(), ms);
}

/** Измеритель времени ответа: незаметный, без учёта времени, когда вкладка скрыта. */
export class Stopwatch {
  constructor() {
    this.start();
    this.onVisibility = () => {
      if (document.hidden) this.hiddenAt = performance.now();
      else if (this.hiddenAt != null) {
        this.paused += performance.now() - this.hiddenAt;
        this.hiddenAt = null;
      }
    };
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  start() {
    this.t0 = performance.now();
    this.paused = 0;
    this.hiddenAt = document.hidden ? performance.now() : null;
  }

  elapsed() {
    const hidden = this.hiddenAt != null ? performance.now() - this.hiddenAt : 0;
    return Math.max(0, performance.now() - this.t0 - this.paused - hidden);
  }

  dispose() {
    document.removeEventListener('visibilitychange', this.onVisibility);
  }
}

/** Запуск после отрисовки кадра — от этого момента и считаем время ответа. */
export function afterPaint(fn) {
  requestAnimationFrame(() => requestAnimationFrame(fn));
}

export function isTypingTarget(target) {
  return target instanceof HTMLElement
    && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
}

export function pressKeyVisual(button) {
  if (!button) return;
  button.classList.add('is-pressed');
  setTimeout(() => button.classList.remove('is-pressed'), 120);
}
