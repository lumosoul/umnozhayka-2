// Общие элементы экранов ребёнка: верхняя панель, звук, фразы совёнка.
// Фразы — на «ты», короткие и без глаголов прошедшего времени (они выдают род: «решил/решила»).

import { h } from './dom.js';
import { sound } from './audio.js';
import { avatarOf, totalStars } from '../core/profile.js';
import { streakInfo } from '../core/progress.js';
import { STATUS_LABELS } from '../core/facts.js';

export function soundToggle(app) {
  const btn = h('button', {
    type: 'button',
    class: 'btn btn--ghost btn--icon',
    'aria-pressed': String(app.settings.sound),
    'aria-label': 'Звук',
    title: 'Звук',
  });
  const paint = () => {
    btn.textContent = app.settings.sound ? '🔊' : '🔇';
    btn.setAttribute('aria-pressed', String(app.settings.sound));
    btn.setAttribute('aria-label', app.settings.sound ? 'Звук включён' : 'Звук выключен');
  };
  btn.addEventListener('click', () => {
    app.setSound(!app.settings.sound);
    paint();
    sound.play('tap');
  });
  paint();
  return btn;
}

export function backButton(onClick, label = 'Назад') {
  return h('button', { type: 'button', class: 'btn btn--ghost btn--icon', 'aria-label': label, title: label, onClick }, '←');
}

/** Верхняя панель ребёнка: назад или аватар, заголовок, звёзды, серия, звук. */
export function childTopbar(app, { title, back = null, showProfile = false } = {}) {
  const p = app.profile;
  const items = [];
  if (back) items.push(backButton(back));
  if (showProfile && p) {
    items.push(h('button', {
      type: 'button',
      class: 'btn btn--ghost btn--small',
      'aria-label': `Профиль: ${p.name}. Сменить профиль`,
      onClick: () => app.go('profiles'),
    }, h('span', { class: 'avatar avatar--small', 'aria-hidden': 'true' }, avatarOf(p).emoji), h('span', { class: 'topbar__name' }, p.name)));
  }
  items.push(title ? h('h1', { class: 'topbar__title', tabindex: -1 }, title) : h('span', { class: 'topbar__spacer' }));
  if (p) {
    const streak = streakInfo(p, app.today());
    items.push(h('div', { class: 'chips' },
      h('span', { class: 'chip chip--accent', title: 'Звёзды' }, '⭐ ', String(totalStars(p)), h('span', { class: 'sr-only' }, ' звёзд')),
      h('span', { class: 'chip', title: 'Дней подряд' }, '🔥 ', String(streak.current), h('span', { class: 'sr-only' }, ' дней подряд'))));
  }
  items.push(soundToggle(app));
  return h('header', { class: ['topbar', title && 'topbar--titled'] }, items);
}

export function statusPill(status) {
  return h('span', { class: ['status-pill', `status-pill--${status}`] }, STATUS_LABELS[status]);
}

const pick = (list) => list[Math.floor(Math.random() * list.length)];

export const phrases = {
  correct: () => pick(['Верно!', 'Здорово!', 'Отлично!', 'Точно!', 'Супер!', 'Так держать!', 'Молодец!']),
  fast: () => pick(['Быстро и верно!', 'Молниеносно!', 'Как на автомате!']),
  streak: (n) => `${n} верно подряд — ты в ударе!`,
  calm: () => pick(['Давай разберём.', 'Почти! Посмотри, как надо.', 'Ничего страшного — так и учатся.', 'Ошибки помогают учиться.']),
  fixed: () => pick(['Вот так! Запоминаем.', 'Теперь ты это знаешь!', 'Отлично, запомним!']),
  dontKnow: () => pick(['Хорошо, что спрашиваешь! Смотри.', 'Сейчас покажу, как решать.']),
  greet: (name) => pick([`Привет, ${name}! Позанимаемся?`, `${name}, рад тебя видеть!`, `Привет, ${name}! Новые примеры ждут!`]),
  effort: () => pick(['Видно, как ты стараешься!', 'Старание — это главное!', 'Каждое занятие делает тебя сильнее!']),
};
