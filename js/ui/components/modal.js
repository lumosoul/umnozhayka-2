// Модальные окна: фокус не уходит из окна (Tab), Escape закрывает, фокус возвращается на место.

import { h } from '../dom.js';
import { createKeypad } from './keypad.js';
import { randInt } from '../../core/rng.js';

let counter = 0;
const stack = [];

export function modalOpen() {
  return stack.length > 0;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * openModal({ title, body, actions: [{ label, kind, onClick, close }], wide, dismissible, onKey })
 * Возвращает { close, dialog }.
 */
export function openModal({ title, body, actions = [], wide = false, dismissible = true, onKey, onClose } = {}) {
  const previous = document.activeElement;
  const titleId = `modal-title-${++counter}`;
  let closed = false;
  const close = (result) => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', keyHandler, true);
    overlay.remove();
    stack.splice(stack.indexOf(api), 1);
    onClose?.(result);
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
  };
  const buttons = actions.map((a) => h('button', {
    type: 'button',
    class: ['btn', `btn--${a.kind ?? 'secondary'}`],
    onClick: () => {
      const keep = a.onClick?.() === false;
      if (!keep && a.close !== false) close(a.value);
    },
  }, a.label));
  const dialog = h('div', {
    class: ['modal__dialog', wide && 'modal__dialog--wide'],
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': titleId,
    tabindex: -1,
  },
  h('h2', { class: 'modal__title', id: titleId }, title),
  body,
  buttons.length ? h('div', { class: 'modal__actions' }, buttons) : null);
  const overlay = h('div', { class: 'modal' }, dialog);
  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === overlay && dismissible) close();
  });

  function keyHandler(e) {
    if (stack.at(-1) !== api) return;
    if (e.key === 'Escape' && dismissible) {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === 'Tab') {
      const items = [...dialog.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (!items.length) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items.at(-1);
      if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
      return;
    }
    if (onKey?.(e)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  const api = { close, dialog };
  stack.push(api);
  document.addEventListener('keydown', keyHandler, true);
  document.body.append(overlay);
  requestAnimationFrame(() => {
    const target = dialog.querySelector('[autofocus]') ?? dialog.querySelector(FOCUSABLE) ?? dialog;
    target.focus({ preventScroll: true });
  });
  return api;
}

/** Подтверждение: resolve(true) — согласие. */
export function confirmDialog({ title, text, ok = 'Да', cancel = 'Отмена', danger = false }) {
  return new Promise((resolve) => {
    let answer = false;
    openModal({
      title,
      body: typeof text === 'string' ? h('p', null, text) : text,
      actions: [
        { label: cancel, kind: 'secondary' },
        { label: ok, kind: danger ? 'calm' : 'primary', onClick: () => { answer = true; } },
      ],
      onClose: () => resolve(answer),
    });
  });
}

export function alertDialog({ title, text, ok = 'Понятно' }) {
  return new Promise((resolve) => {
    openModal({
      title,
      body: typeof text === 'string' ? h('p', null, text) : text,
      actions: [{ label: ok, kind: 'primary' }],
      onClose: () => resolve(),
    });
  });
}

/**
 * Вопрос-замок для взрослых: пример за пределами таблицы (двузначное на однозначное).
 * Ребёнку 7–10 лет его быстро не решить, взрослому — секунды.
 */
export function parentGate() {
  return new Promise((resolve) => {
    let a;
    let b;
    let passed = false;
    const question = h('p', { class: 'expr', style: { fontSize: 'clamp(2rem, 8vw, 3rem)' } });
    const answer = h('span', { class: 'answer answer--empty' });
    const note = h('p', { class: 'muted small', role: 'status' }, 'Решите пример, чтобы открыть раздел.');
    const ask = () => {
      a = randInt(12, 19, Math.random);
      b = randInt(3, 9, Math.random);
      question.replaceChildren(`${a} × ${b} = `, answer);
    };
    let api = null;
    const keypad = createKeypad({
      maxLength: 3,
      okLabel: 'Проверить',
      onChange: (v) => {
        answer.textContent = v;
        answer.classList.toggle('answer--empty', v === '');
      },
      onSubmit: (v) => {
        if (v === a * b) {
          passed = true;
          api.close();
        } else {
          note.textContent = 'Не подошло. Вот другой пример.';
          keypad.clear();
          ask();
        }
      },
    });
    ask();
    api = openModal({
      title: '🔒 Для взрослых',
      body: h('div', { class: 'center', style: { display: 'grid', gap: '12px', justifyItems: 'center' } }, question, note, keypad.el),
      actions: [{ label: 'Отмена', kind: 'secondary' }],
      onKey: (e) => keypad.handleKey(e),
      onClose: () => resolve(passed),
    });
  });
}
