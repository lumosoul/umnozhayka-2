// Совёнок-помощник: SVG с настроениями (обычное, радость, «думаю», ура) и моргание.

import { h } from '../dom.js';
import { voice } from '../audio.js';

/** Кнопка 🔈: читает текст вслух (если в браузере есть синтез речи). */
export function speakButton(getText) {
  if (!voice.available) return null;
  return h('button', {
    type: 'button',
    class: 'btn btn--ghost btn--icon speak',
    'aria-label': 'Прочитать вслух',
    title: 'Прочитать вслух',
    onClick: () => voice.speak(typeof getText === 'function' ? getText() : getText),
  }, '🔈');
}

const OWL_SVG = `
<svg viewBox="0 0 120 120" aria-hidden="true" focusable="false">
  <path d="M30 34 L36 9 L50 28 Z" fill="#3F6BD0"/>
  <path d="M90 34 L84 9 L70 28 Z" fill="#3F6BD0"/>
  <ellipse cx="60" cy="68" rx="40" ry="45" fill="#5B8DEF"/>
  <path class="owl-wing-l" d="M24 58 C12 74 16 94 32 104 C34 86 32 72 24 58 Z" fill="#3F6BD0"/>
  <path class="owl-wing-r" d="M96 58 C108 74 104 94 88 104 C86 86 88 72 96 58 Z" fill="#3F6BD0"/>
  <ellipse cx="60" cy="84" rx="25" ry="26" fill="#FFE9B8"/>
  <path d="M54 80 l12 12 M66 80 l-12 12" stroke="#E0A33A" stroke-width="3.2" stroke-linecap="round" opacity=".85"/>
  <circle class="owl-eye-white" cx="44" cy="48" r="15" fill="#fff"/>
  <circle class="owl-eye-white" cx="76" cy="48" r="15" fill="#fff"/>
  <g class="owl-pupils">
    <circle cx="46" cy="49" r="7.5" fill="#26213A"/>
    <circle cx="74" cy="49" r="7.5" fill="#26213A"/>
    <circle cx="48.6" cy="46.2" r="2.4" fill="#fff"/>
    <circle cx="76.6" cy="46.2" r="2.4" fill="#fff"/>
  </g>
  <g class="owl-lids" fill="#5B8DEF">
    <circle cx="44" cy="48" r="15.5"/>
    <circle cx="76" cy="48" r="15.5"/>
    <path d="M31 50 q13 7 26 0 M63 50 q13 7 26 0" stroke="#26213A" stroke-width="3" fill="none" stroke-linecap="round"/>
  </g>
  <g class="owl-happy-eyes" stroke="#26213A" stroke-width="4" fill="none" stroke-linecap="round">
    <path d="M34 51 q10 -12 20 0"/>
    <path d="M66 51 q10 -12 20 0"/>
  </g>
  <path d="M60 57 l-7 6 l7 9 l7 -9 z" fill="#FFA630"/>
  <circle cx="32" cy="64" r="5" fill="#FFB4B4" opacity=".75"/>
  <circle cx="88" cy="64" r="5" fill="#FFB4B4" opacity=".75"/>
  <g stroke="#FFA630" stroke-width="3.5" stroke-linecap="round">
    <path d="M47 111 l-4 6 M51 111 v7 M55 111 l4 6"/>
    <path d="M65 111 l-4 6 M69 111 v7 M73 111 l4 6"/>
  </g>
</svg>`;

const owls = new Set();
let blinkTimer = null;

function scheduleBlink() {
  clearTimeout(blinkTimer);
  blinkTimer = setTimeout(() => {
    for (const owl of owls) {
      if (!owl.isConnected) {
        owls.delete(owl);
        continue;
      }
      if (owl.classList.contains('owl--happy') || owl.classList.contains('owl--cheer')) continue;
      owl.classList.add('owl--blink');
      setTimeout(() => owl.classList.remove('owl--blink'), 160);
    }
    if (owls.size) scheduleBlink();
  }, 3200 + Math.random() * 2600);
}

/** Совёнок; mood: 'idle' | 'happy' | 'think' | 'cheer'. */
export function createOwl({ mood = 'idle', size = '' } = {}) {
  const el = h('div', { class: ['owl', size && `owl--${size}`] });
  el.innerHTML = OWL_SVG;
  setOwlMood(el, mood);
  owls.add(el);
  scheduleBlink();
  return el;
}

export function setOwlMood(el, mood) {
  if (!el) return;
  el.classList.remove('owl--happy', 'owl--think', 'owl--cheer', 'owl--bounce');
  if (mood !== 'idle') el.classList.add(`owl--${mood}`);
  if (mood === 'happy' || mood === 'cheer') {
    el.classList.add('owl--bounce');
    setTimeout(() => el.classList.remove('owl--bounce'), 220);
  }
}

/** Совёнок с репликой в «облачке». */
export function owlSays(text, { mood = 'idle', size = '', center = false } = {}) {
  const owl = createOwl({ mood, size });
  const line = h('span', { class: 'bubble__text' }, text);
  // Кнопка «прочитать» — внутри облачка: на узком экране она переносится вместе с текстом.
  const bubble = h('p', { class: 'bubble' }, line, speakButton(() => line.textContent));
  const wrap = h('div', { class: ['owl-say', center && 'owl-say--center'] }, owl, bubble);
  wrap.owl = owl;
  wrap.bubble = bubble;
  wrap.say = (next, nextMood) => {
    line.textContent = next;
    if (nextMood) setOwlMood(owl, nextMood);
  };
  return wrap;
}
