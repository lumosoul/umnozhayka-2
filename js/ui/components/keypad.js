// Крупная экранная цифровая клавиатура. Работает касанием, мышью и с физической клавиатуры
// (цифры, Backspace, Enter, цифровой блок). Системная клавиатура телефона не открывается.

import { h, pressKeyVisual } from '../dom.js';
import { sound } from '../audio.js';

export function createKeypad({ maxLength = 3, onChange, onSubmit, okLabel = 'Готово' } = {}) {
  let value = '';
  const keys = new Map();

  const set = (next) => {
    value = next;
    onChange?.(value);
    keys.get('ok').disabled = value === '';
  };

  const press = (k) => {
    sound.play('tap');
    if (k === 'erase') set(value.slice(0, -1));
    else if (k === 'ok') {
      if (value !== '') onSubmit?.(Number(value), value);
    } else if (value.length < maxLength) {
      set(value === '0' ? k : value + k);
    }
  };

  const key = (k, label, cls, aria) => {
    const btn = h('button', {
      type: 'button',
      class: ['key', cls],
      'aria-label': aria ?? label,
      onClick: () => press(k),
    }, label);
    keys.set(k, btn);
    return btn;
  };

  const el = h('div', { class: 'keypad', role: 'group', 'aria-label': 'Цифровая клавиатура' },
    ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => key(d, d)),
    key('erase', '⌫', 'key--erase', 'Стереть'),
    key('0', '0'),
    key('ok', '✓', 'key--ok', okLabel));
  keys.get('ok').disabled = true;

  /** Обработка физической клавиатуры; возвращает true, если клавиша обработана. */
  const handleKey = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    let k = null;
    if (/^[0-9]$/.test(e.key)) k = e.key;
    else if (e.key === 'Backspace' || e.key === 'Delete') k = 'erase';
    else if (e.key === 'Enter' || e.key === 'NumpadEnter') k = 'ok';
    if (!k) return false;
    e.preventDefault();
    pressKeyVisual(keys.get(k));
    press(k);
    return true;
  };

  return {
    el,
    handleKey,
    get value() {
      return value;
    },
    clear: () => set(''),
    setDisabled(disabled) {
      for (const btn of keys.values()) btn.disabled = disabled || (btn === keys.get('ok') && value === '');
    },
    focus: () => keys.get('1').focus({ preventScroll: true }),
  };
}
