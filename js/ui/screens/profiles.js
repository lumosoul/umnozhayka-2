// «Кто занимается?» — до 4 профилей детей и вход для взрослых.

import { h } from '../dom.js';
import { owlSays } from '../components/owl.js';
import { soundToggle } from '../common.js';
import { AVATARS, MAX_PROFILES, avatarOf, cleanName, createProfile, totalStars } from '../../core/profile.js';
import { masteryPercent } from '../../core/progress.js';
import { sound } from '../audio.js';

export function profilesScreen(app) {
  const list = app.profiles.map((p) => h('button', {
    type: 'button',
    class: 'profile-card',
    onClick: () => {
      sound.play('tap');
      app.setActive(p.id);
      app.go(p.diagnostic ? 'home' : 'diagnostic');
    },
  },
  h('span', { class: 'avatar', 'aria-hidden': 'true' }, avatarOf(p).emoji),
  h('span', null,
    h('span', { class: 'profile-card__name' }, p.name),
    h('span', { class: 'profile-card__meta' }, `⭐ ${totalStars(p)} · освоено ${masteryPercent(p)} %`))));

  if (app.profiles.length < MAX_PROFILES) {
    list.push(h('button', { type: 'button', class: 'profile-card profile-card--add', onClick: () => app.go('newProfile') },
      h('span', { 'aria-hidden': 'true', style: { fontSize: '2rem' } }, '＋'), 'Новый ученик'));
  }

  const el = h('section', { class: 'screen screen--narrow' },
    h('header', { class: 'topbar' }, h('h1', { class: 'topbar__title', tabindex: -1 }, 'Умножайка'), soundToggle(app)),
    owlSays(app.profiles.length ? 'Кто сегодня занимается? Нажми на себя!' : 'Привет! Я совёнок Умник. Давай знакомиться!', { size: 'big' }),
    h('div', { class: 'profiles' }, list),
    !app.persistent && h('p', { class: 'notice' }, 'Браузер не даёт сохранять данные (возможно, приватный режим). Прогресс пропадёт после закрытия вкладки.'),
    h('div', { style: { marginTop: 'auto', display: 'flex', justifyContent: 'center' } },
      h('button', { type: 'button', class: 'btn btn--ghost btn--small', onClick: () => app.go('parent') }, '🔒 Для взрослых')));
  return { el };
}

export function newProfileScreen(app) {
  let avatar = AVATARS[app.profiles.length % AVATARS.length].id;
  const input = h('input', {
    class: 'input',
    id: 'child-name',
    type: 'text',
    maxlength: 16,
    autocomplete: 'off',
    autocapitalize: 'words',
    enterkeyhint: 'done',
    placeholder: 'Например, Маша',
  });
  const error = h('p', { class: 'muted small', role: 'status' });
  const options = AVATARS.map((a) => h('button', {
    type: 'button',
    class: 'avatar-option',
    'aria-pressed': String(a.id === avatar),
    'aria-label': a.label,
    onClick: (e) => {
      avatar = a.id;
      for (const btn of e.currentTarget.parentElement.children) btn.setAttribute('aria-pressed', 'false');
      e.currentTarget.setAttribute('aria-pressed', 'true');
      sound.play('tap');
    },
  }, a.emoji));

  const create = async () => {
    // Имя можно не писать (ребёнку 7 лет это бывает трудно) — тогда профиль зовут по картинке.
    const name = cleanName(input.value) || AVATARS.find((a) => a.id === avatar).label;
    if (app.profiles.length >= MAX_PROFILES) {
      error.textContent = 'Уже есть 4 профиля — это максимум.';
      return;
    }
    const profile = createProfile({ name, avatar });
    await app.addProfile(profile);
    app.setActive(profile.id);
    app.go('diagnostic');
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      create();
    }
  });

  const el = h('section', { class: 'screen screen--narrow' },
    h('header', { class: 'topbar' },
      app.profiles.length ? h('button', { type: 'button', class: 'btn btn--ghost btn--icon', 'aria-label': 'Назад', onClick: () => app.go('profiles') }, '←') : null,
      h('h1', { class: 'topbar__title', tabindex: -1 }, 'Новый ученик'),
      soundToggle(app)),
    owlSays('Как тебя зовут? Можно просто выбрать картинку!'),
    h('div', { class: 'card', style: { display: 'grid', gap: '18px' } },
      h('div', { class: 'field' }, h('label', { for: 'child-name' }, 'Имя (можно не писать)'), input, error),
      h('div', { class: 'field' }, h('span', { class: 'label', id: 'avatar-label' }, 'Картинка'),
        h('div', { class: 'avatar-picker', role: 'group', 'aria-labelledby': 'avatar-label' }, options)),
      h('button', { type: 'button', class: 'btn btn--primary btn--big btn--block', onClick: create }, 'Готово!')),
    !app.profiles.length && h('div', { style: { marginTop: 'auto', display: 'flex', justifyContent: 'center' } },
      h('button', { type: 'button', class: 'btn btn--ghost btn--small', onClick: () => app.go('parent') },
        '🔒 Перенести прогресс с другого устройства')));
  requestAnimationFrame(() => input.focus({ preventScroll: true }));
  return { el };
}
