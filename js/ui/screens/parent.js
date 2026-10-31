// Родительский экран (за вопросом-замком): точность, график среднего времени ответа,
// самые трудные примеры, занятия по дням, перенос данных, профили и настройки.

import { fill, h, toast } from '../dom.js';
import { barChart, lineChart } from '../components/chart.js';
import { confirmDialog, openModal, parentGate } from '../components/modal.js';
import { backButton, statusPill } from '../common.js';
import { gridMini } from './progress.js';
import {
  enterCodeFlow, exportFileFlow, importFileFlow, photoQrFlow, scanQrFlow, showCodeFlow, showQrFlow,
} from '../transfer-ui.js';
import { dailyStats, hardestFacts, profileSummary } from '../../core/progress.js';
import { AVATARS, MAX_PROFILES, avatarOf, cleanName, createProfile } from '../../core/profile.js';
import { countText, formatDay, formatMinutes, formatSeconds, nowSec } from '../../core/dates.js';

const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)} %`);

function kpi(value, label) {
  return h('div', { class: 'stat' }, h('span', { class: 'stat__value' }, value), h('span', { class: 'stat__label' }, label));
}

function profileReport(app, p) {
  const today = app.today();
  const s = profileSummary(p, today);
  const days = dailyStats(p, { today, days: 30 });
  const hard = hardestFacts(p, 8);

  const timePoints = days.filter((d) => d.avgMs != null).map((d) => ({
    label: formatDay(d.day, { short: true }),
    value: d.avgMs / 1000,
    display: formatSeconds(d.avgMs),
    tip: `${formatDay(d.day, { weekday: true })} · ${countText(d.tasks, ['ответ', 'ответа', 'ответов'])}`,
  }));
  const taskPoints = days.map((d) => ({
    label: formatDay(d.day, { short: true }),
    value: d.tasks,
    display: String(d.tasks),
    tip: `${formatDay(d.day, { weekday: true })}: ${countText(d.sessions, ['занятие', 'занятия', 'занятий'])}, верно ${pct(d.accuracy)}`,
  }));

  return h('div', { style: { display: 'grid', gap: '16px' } },
    h('div', { class: 'kpis' },
      kpi(`${s.mastery} %`, 'таблицы освоено'),
      kpi(String(s.counts.auto), 'фактов на автомате'),
      kpi(pct(s.accuracyAll), 'точность за всё время'),
      kpi(pct(s.accuracyWeek), 'точность за 7 дней'),
      kpi(formatSeconds(s.avgMs), 'среднее время ответа'),
      kpi(String(s.sessions), 'занятий всего'),
      kpi(formatMinutes(s.practiceMs), 'в занятиях'),
      kpi(`${s.streak.current} / ${s.streak.best}`, 'серия дней / рекорд')),
    h('section', { class: 'card section' },
      h('h2', null, 'Среднее время ответа по дням'),
      h('p', { class: 'muted small', style: { margin: 0 } }, 'Чем ниже линия, тем увереннее ребёнок. Автоматизм — быстрее 3 секунд.'),
      lineChart(timePoints, { label: 'График среднего времени ответа по дням за 30 дней', yFormat: (v, d) => `${v.toFixed(d).replace('.', ',')} с` })),
    h('section', { class: 'card section' },
      h('h2', null, 'Занятия по дням'),
      barChart(taskPoints, { label: 'Количество заданий по дням за 30 дней', yFormat: (v, d) => v.toFixed(d).replace('.', ',') }),
      days.length
        ? h('div', { class: 'table-scroll' }, h('table', { class: 'table' },
          h('thead', null, h('tr', null,
            h('th', { scope: 'col' }, 'День'), h('th', { scope: 'col', class: 'num' }, 'Занятий'),
            h('th', { scope: 'col', class: 'num' }, 'Заданий'), h('th', { scope: 'col', class: 'num' }, 'Верно'),
            h('th', { scope: 'col', class: 'num' }, 'Ср. время'), h('th', { scope: 'col', class: 'num' }, 'Минут'))),
          h('tbody', null, days.slice().reverse().map((d) => h('tr', null,
            h('td', null, formatDay(d.day, { weekday: true })),
            h('td', { class: 'num' }, String(d.sessions)),
            h('td', { class: 'num' }, String(d.tasks)),
            h('td', { class: 'num' }, pct(d.accuracy)),
            h('td', { class: 'num' }, formatSeconds(d.avgMs)),
            h('td', { class: 'num' }, String(Math.max(1, Math.round(d.durationMs / 60000)))))))))
        : h('p', { class: 'muted' }, 'Занятий пока не было.')),
    h('section', { class: 'card section' },
      h('h2', null, 'Самые трудные примеры'),
      hard.length
        ? h('div', { class: 'table-scroll' }, h('table', { class: 'table' },
          h('thead', null, h('tr', null,
            h('th', { scope: 'col' }, 'Пример'), h('th', { scope: 'col', class: 'num' }, 'Точность'),
            h('th', { scope: 'col', class: 'num' }, 'Ср. время'), h('th', { scope: 'col', class: 'num' }, 'Ошибок'),
            h('th', { scope: 'col' }, 'Статус'))),
          h('tbody', null, hard.map((d) => h('tr', null,
            h('td', { style: { fontWeight: 800 } }, `${d.a} × ${d.b} = ${d.product}`),
            h('td', { class: 'num' }, pct(d.accuracy)),
            h('td', { class: 'num' }, formatSeconds(d.avgMs)),
            h('td', { class: 'num' }, String(d.errors)),
            h('td', null, statusPill(d.status)))))))
        : h('p', { class: 'muted' }, 'Трудных примеров пока нет — или занятий ещё мало.')),
    h('section', { class: 'card section' },
      h('h2', null, 'Карта знаний'),
      h('div', { class: 'table-wrap' }, gridMini(p))));
}

function renameProfile(app, p, refresh) {
  let avatar = p.avatar;
  const input = h('input', { class: 'input', type: 'text', maxlength: 16, value: p.name, 'aria-label': 'Имя' });
  const options = AVATARS.map((a) => h('button', {
    type: 'button',
    class: 'avatar-option',
    'aria-pressed': String(a.id === avatar),
    'aria-label': a.label,
    onClick: (e) => {
      avatar = a.id;
      for (const b of e.currentTarget.parentElement.children) b.setAttribute('aria-pressed', 'false');
      e.currentTarget.setAttribute('aria-pressed', 'true');
    },
  }, a.emoji));
  openModal({
    title: 'Имя и картинка',
    body: h('div', { style: { display: 'grid', gap: '14px' } }, input, h('div', { class: 'avatar-picker' }, options)),
    actions: [
      { label: 'Отмена', kind: 'secondary' },
      {
        label: 'Сохранить',
        kind: 'primary',
        onClick: () => {
          const name = cleanName(input.value);
          if (!name) return false;
          p.name = name;
          p.avatar = avatar;
          p.nameUpdatedAt = nowSec();
          app.saveProfile(p);
          refresh();
          return true;
        },
      },
    ],
  });
}

export function parentScreen(app, params = {}) {
  if (!params.unlocked) {
    const el = h('section', { class: 'screen screen--narrow' },
      h('header', { class: 'topbar' }, h('h1', { class: 'topbar__title', tabindex: -1 }, '🔒 Для взрослых')));
    parentGate().then((ok) => (ok ? app.go('parent', { unlocked: true }) : app.back()));
    return { el };
  }

  let selectedId = params.profileId ?? app.profile?.id ?? app.profiles[0]?.id;
  const content = h('div', { style: { display: 'grid', gap: '16px' } });
  const refresh = () => app.go('parent', { unlocked: true, profileId: selectedId });
  const afterImport = (changed) => {
    if (changed) refresh();
  };

  const draw = () => {
    const p = app.profiles.find((x) => x.id === selectedId) ?? app.profiles[0];
    selectedId = p?.id;
    const tabs = app.profiles.length > 1 && h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Профили' },
      app.profiles.map((x) => h('button', {
        type: 'button',
        class: 'tab',
        role: 'tab',
        'aria-selected': String(x.id === selectedId),
        onClick: () => {
          selectedId = x.id;
          draw();
        },
      }, h('span', { class: 'avatar avatar--small', 'aria-hidden': 'true' }, avatarOf(x).emoji), x.name)));

    const transfer = h('section', { class: 'card section' },
      h('h2', null, 'Перенос на другое устройство'),
      h('p', { class: 'muted small', style: { margin: 0 } }, 'Три способа на выбор. При загрузке данные объединяются: по каждому примеру остаётся самая свежая запись.'),
      h('h3', { style: { margin: '8px 0 0' } }, 'Отправить с этого устройства'),
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn btn--secondary', disabled: !app.profiles.length, onClick: () => exportFileFlow(app) }, '💾 Сохранить в файл'),
        h('button', { type: 'button', class: 'btn btn--secondary', disabled: !app.profiles.length, onClick: () => showCodeFlow(app) }, '🔤 Показать код'),
        h('button', { type: 'button', class: 'btn btn--secondary', disabled: !app.profiles.length, onClick: () => showQrFlow(app) }, '▦ Показать QR')),
      h('h3', { style: { margin: '8px 0 0' } }, 'Получить на это устройство'),
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn btn--secondary', onClick: () => importFileFlow(app).then(afterImport) }, '📂 Загрузить файл'),
        h('button', { type: 'button', class: 'btn btn--secondary', onClick: () => enterCodeFlow(app).then(afterImport) }, '⌨ Ввести код'),
        h('button', { type: 'button', class: 'btn btn--secondary', onClick: () => scanQrFlow(app).then(afterImport) }, '📷 Сканировать QR'),
        h('button', { type: 'button', class: 'btn btn--ghost', onClick: () => photoQrFlow(app).then(afterImport) }, '🖼 QR с фото')));

    const manage = p && h('section', { class: 'card section' },
      h('h2', null, `Профиль «${p.name}»`),
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn btn--secondary', onClick: () => renameProfile(app, p, refresh) }, '✏️ Имя и картинка'),
        h('button', {
          type: 'button',
          class: 'btn btn--ghost',
          onClick: async () => {
            const ok = await confirmDialog({
              title: 'Начать заново?',
              text: `Весь прогресс «${p.name}» будет удалён, и при следующем входе начнётся знакомство. Сначала можно сохранить файл.`,
              ok: 'Сбросить прогресс',
              danger: true,
            });
            if (!ok) return;
            const fresh = createProfile({ name: p.name, avatar: p.avatar });
            fresh.id = p.id;
            await app.importProfiles([fresh]);
            toast('Прогресс сброшен.');
            refresh();
          },
        }, '↺ Сбросить прогресс'),
        h('button', {
          type: 'button',
          class: 'btn btn--ghost',
          onClick: async () => {
            const ok = await confirmDialog({
              title: 'Удалить профиль?',
              text: `Профиль «${p.name}» и весь его прогресс будут удалены с этого устройства.`,
              ok: 'Удалить',
              danger: true,
            });
            if (!ok) return;
            await app.removeProfile(p.id);
            toast('Профиль удалён.');
            selectedId = null;
            refresh();
          },
        }, '🗑 Удалить профиль')),
      app.profiles.length < MAX_PROFILES && h('button', { type: 'button', class: 'btn btn--secondary', onClick: () => app.go('newProfile') }, '＋ Добавить ученика'));

    const soundBox = h('input', { type: 'checkbox', checked: app.settings.sound });
    soundBox.addEventListener('change', () => app.setSound(soundBox.checked));
    const installBtn = app.installPrompt && h('button', {
      type: 'button',
      class: 'btn btn--primary',
      onClick: async () => {
        const prompt = app.installPrompt;
        app.installPrompt = null;
        prompt.prompt();
        await prompt.userChoice.catch(() => null);
        draw();
      },
    }, '📲 Установить приложение');
    const offline = navigator.serviceWorker?.controller
      ? '✅ Работает без интернета: все файлы сохранены на устройстве.'
      : '⏳ Файлы для работы без интернета ещё загружаются — откройте приложение ещё раз с интернетом.';

    const protectLine = h('p', { style: { margin: 0 } });
    const protectBtn = h('button', {
      type: 'button',
      class: 'btn btn--secondary',
      hidden: true,
      onClick: async () => {
        const ok = await app.protectStorage();
        protectLine.textContent = ok
          ? '🛡 Браузер не будет удалять данные при нехватке места.'
          : '🛡 Браузер не разрешил защиту. Установите приложение на главный экран и сохраняйте файл прогресса.';
        protectBtn.hidden = ok;
      },
    }, '🛡 Защитить данные от очистки');
    app.storageProtected().then((state) => {
      if (state === null) return;
      protectLine.textContent = state
        ? '🛡 Данные защищены от автоматической очистки браузером.'
        : '🛡 Браузер может удалить данные при нехватке места — защитите их кнопкой ниже.';
      protectBtn.hidden = state;
    });

    const settings = h('section', { class: 'card section' },
      h('h2', null, 'Настройки и установка'),
      h('label', { class: 'check' }, soundBox, 'Звуки'),
      h('p', { style: { margin: 0 } }, offline),
      protectLine,
      protectBtn,
      h('p', { style: { margin: 0 } }, app.persistent
        ? '💾 Прогресс хранится только на этом устройстве (IndexedDB), без регистрации и интернета.'
        : '⚠️ Браузер не разрешает сохранять данные — прогресс пропадёт после закрытия вкладки.'),
      installBtn,
      h('a', { class: 'btn btn--secondary', href: 'selftest.html' }, '🩺 Проверить это устройство'),
      h('details', null,
        h('summary', { style: { cursor: 'pointer', fontWeight: 700, minHeight: '48px', display: 'flex', alignItems: 'center' } }, 'Как установить на главный экран'),
        h('ul', null,
          h('li', null, 'iPhone и iPad (Safari): кнопка «Поделиться» → «На экран „Домой“».'),
          h('li', null, 'Android (Chrome): меню ⋮ → «Установить приложение» или «Добавить на главный экран».'),
          h('li', null, 'Компьютер (Chrome, Edge): значок установки справа в адресной строке.'),
          h('li', null, 'Firefox на Android: меню → «Установить». На компьютере Firefox открывает приложение во вкладке — оно работает и без интернета.'))),
      h('p', { class: 'muted small', style: { margin: 0 } }, `Умножайка ${app.version}. Без рекламы, регистрации и отправки данных.`));

    fill(content,
      tabs,
      p ? profileReport(app, p) : h('p', { class: 'notice' }, 'Профилей пока нет. Создайте ученика или загрузите прогресс с другого устройства.'),
      transfer,
      manage,
      settings);
  };
  draw();

  const el = h('section', { class: 'screen' },
    h('header', { class: 'topbar' },
      backButton(() => app.back(), 'Выйти'),
      h('h1', { class: 'topbar__title', tabindex: -1 }, 'Для взрослых')),
    content);
  return { el };
}
