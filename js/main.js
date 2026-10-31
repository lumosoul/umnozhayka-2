// Точка входа: загрузка данных из IndexedDB, переходы между экранами, клавиатура,
// service worker (работа без интернета) и установка на главный экран.

import { storage } from './storage/db.js';
import { sound } from './ui/audio.js';
import { h, isTypingTarget, toast } from './ui/dom.js';
import { modalOpen } from './ui/components/modal.js';
import { owlSays } from './ui/components/owl.js';
import { dayNumber } from './core/dates.js';
import { MAX_PROFILES } from './core/profile.js';
import { profilesScreen, newProfileScreen } from './ui/screens/profiles.js';
import { homeScreen } from './ui/screens/home.js';
import { diagnosticScreen } from './ui/screens/diagnostic.js';
import { lessonScreen } from './ui/screens/lesson.js';
import { summaryScreen } from './ui/screens/summary.js';
import { blitzScreen } from './ui/screens/blitz.js';
import { progressScreen } from './ui/screens/progress.js';
import { rewardsScreen } from './ui/screens/rewards.js';
import { lessonsScreen } from './ui/screens/lessons.js';
import { parentScreen } from './ui/screens/parent.js';

export const APP_VERSION = '1.0.4';

const SCREENS = {
  profiles: profilesScreen,
  newProfile: newProfileScreen,
  home: homeScreen,
  diagnostic: diagnosticScreen,
  lesson: lessonScreen,
  summary: summaryScreen,
  blitz: blitzScreen,
  progress: progressScreen,
  rewards: rewardsScreen,
  lessons: lessonsScreen,
  parent: parentScreen,
};
/** Экраны, которым нужен выбранный профиль ребёнка. */
const NEEDS_PROFILE = new Set(['home', 'diagnostic', 'lesson', 'summary', 'blitz', 'progress', 'rewards', 'lessons']);

const root = document.getElementById('screen');

const app = {
  version: APP_VERSION,
  profiles: [],
  profile: null,
  settings: null,
  persistent: true,
  installPrompt: null,
  current: null,
  currentName: null,
  previousName: null,

  today: () => dayNumber(),

  go(name, params = {}) {
    let target = name;
    if (NEEDS_PROFILE.has(target) && !this.profile) target = 'profiles';
    if (target === 'home' && this.profile && !this.profile.diagnostic) target = 'diagnostic';
    if (target === 'newProfile' && this.profiles.length >= MAX_PROFILES) target = 'profiles';
    if (target === 'profiles' && !this.profiles.length) target = 'newProfile';
    try {
      this.current?.destroy?.();
    } catch {
      // экран уже разрушен
    }
    if (this.currentName && this.currentName !== target && this.currentName !== 'parent') this.previousName = this.currentName;
    const screen = SCREENS[target](this, params);
    this.current = screen;
    this.currentName = target;
    root.replaceChildren(screen.el);
    window.scrollTo(0, 0);
    requestAnimationFrame(() => {
      const heading = root.querySelector('h1');
      if (heading && !root.contains(document.activeElement)) heading.focus({ preventScroll: true });
    });
  },

  /** «Назад» из родительского раздела — только на спокойные экраны, не в середину занятия. */
  back() {
    const safe = new Set(['profiles', 'home', 'progress', 'rewards', 'lessons']);
    const prev = safe.has(this.previousName) ? this.previousName : null;
    this.go(prev ?? (this.profile ? 'home' : 'profiles'));
  },

  setActive(id) {
    this.profile = this.profiles.find((p) => p.id === id) ?? null;
    this.updateSettings({ activeProfileId: this.profile?.id ?? null });
  },

  updateSettings(patch) {
    Object.assign(this.settings, patch);
    storage.saveSettings(this.settings).catch(() => {});
  },

  setSound(on) {
    sound.enabled = on;
    this.updateSettings({ sound: on });
  },

  storageProtected: () => storage.isProtected(),
  protectStorage: () => storage.protect(),

  /** Сохранение после каждого ответа. Записи идут по очереди, чтобы не обгонять друг друга. */
  saveQueue: Promise.resolve(),
  saveProfile(profile = this.profile) {
    if (!profile) return Promise.resolve();
    this.saveQueue = this.saveQueue
      .then(() => storage.saveProfile(profile))
      .catch(() => toast('Не удалось сохранить прогресс на устройстве.'));
    return this.saveQueue;
  },

  async addProfile(profile) {
    this.profiles.push(profile);
    await this.saveProfile(profile);
  },

  async removeProfile(id) {
    this.profiles = this.profiles.filter((p) => p.id !== id);
    if (this.profile?.id === id) this.setActive(null);
    await storage.deleteProfile(id);
  },

  /** Добавляет или заменяет профили (импорт, сброс). Активный профиль обновляется на новую версию. */
  async importProfiles(list) {
    for (const p of list) {
      const i = this.profiles.findIndex((x) => x.id === p.id);
      if (i >= 0) this.profiles[i] = p;
      else this.profiles.push(p);
    }
    await storage.saveProfiles(list);
    if (this.profile) this.profile = this.profiles.find((p) => p.id === this.profile.id) ?? null;
  },
};

// ---------- клавиатура ----------

document.addEventListener('keydown', (e) => {
  sound.unlock();
  if (modalOpen() || e.defaultPrevented) return;
  if (isTypingTarget(e.target)) return;
  if (app.current?.onKey?.(e)) e.preventDefault();
});
document.addEventListener('pointerdown', () => sound.unlock(), { passive: true });

// Вкладку прячут или закрывают (на телефоне это может быть последним событием) —
// экран успевает записать незаконченное занятие. Ответы по фактам и так сохраняются сразу.
const suspend = () => {
  try {
    app.current?.suspend?.();
  } catch {
    // сохранение при уходе — по возможности
  }
};
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') suspend();
});
window.addEventListener('pagehide', suspend);

// ---------- установка и работа без интернета ----------

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  app.installPrompt = e;
});
window.addEventListener('appinstalled', () => {
  app.installPrompt = null;
  toast('Умножайка установлена!');
});

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      // без service worker приложение работает, но не офлайн
    });
  });
}

// ---------- запуск ----------

async function start() {
  root.replaceChildren(h('div', { class: 'splash' }, owlSays('Загружаю…', { center: true })));
  app.persistent = await storage.init();
  app.settings = await storage.loadSettings();
  sound.enabled = app.settings.sound;
  app.profiles = await storage.loadProfiles();
  app.profile = app.profiles.find((p) => p.id === app.settings.activeProfileId) ?? null;
  if (app.profile) app.go(app.profile.diagnostic ? 'home' : 'diagnostic');
  else app.go(app.profiles.length ? 'profiles' : 'newProfile');
}

registerServiceWorker();
start().catch((err) => {
  // Если как раз пришла новая версия (возможно, с исправлением), перезапускаемся сами.
  navigator.serviceWorker?.addEventListener('controllerchange', () => location.reload());
  // Кнопка нужна и потому, что у приложения на экране «Домой» нет кнопки обновления браузера.
  root.replaceChildren(h('div', { class: 'splash' },
    owlSays('Ой! Не получилось запуститься.', { center: true }),
    h('button', { type: 'button', class: 'btn btn--primary', onClick: () => location.reload() }, 'Попробовать ещё раз'),
    h('p', { class: 'muted small' }, String(err?.message ?? err))));
});

// Для отладки и сквозных проверок из консоли.
globalThis.umnozhayka = app;
