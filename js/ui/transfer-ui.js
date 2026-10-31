// Перенос прогресса между устройствами: файл JSON, код Base64 с контрольной суммой, серия QR.
// Импорт всегда идёт через предпросмотр: что добавится, что объединится и что будет перезаписано.

import { h, toast } from './dom.js';
import { alertDialog, openModal } from './components/modal.js';
import { decodeImageFile, qrPlayer, qrScanner } from './components/qr-view.js';
import { sound } from './audio.js';
import {
  ImportError, QR_CHUNK_BYTES, QR_CHUNK_BYTES_LARGE, QrCollector, exportCode, exportFileName, exportJson,
  exportQrChunks, importCode, importJson,
} from '../transfer/format.js';
import { applyImport, planImport } from '../core/merge.js';
import { MAX_PROFILES } from '../core/profile.js';
import { countText } from '../core/dates.js';

const messageOf = (err) => (err instanceof ImportError ? err.message : 'Не удалось прочитать данные. Проверьте, что это данные «Умножайки».');

/** Какие профили переносить (если их несколько). */
function chooseProfiles(app, title) {
  if (app.profiles.length <= 1) return Promise.resolve(app.profiles.slice());
  return new Promise((resolve) => {
    const boxes = app.profiles.map((p) => {
      const input = h('input', { type: 'checkbox', checked: true });
      return { p, input, row: h('label', { class: 'check' }, input, `${p.name}`) };
    });
    let result = null;
    openModal({
      title,
      body: h('div', null, h('p', null, 'Какие профили перенести?'), boxes.map((b) => b.row)),
      actions: [
        { label: 'Отмена', kind: 'secondary' },
        {
          label: 'Дальше',
          kind: 'primary',
          onClick: () => {
            const chosen = boxes.filter((b) => b.input.checked).map((b) => b.p);
            if (!chosen.length) return false;
            result = chosen;
            return true;
          },
        },
      ],
      onClose: () => resolve(result),
    });
  });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = h('textarea', { style: { position: 'fixed', opacity: '0' } });
    area.value = text;
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

// ---------- экспорт ----------

export async function exportFileFlow(app) {
  const profiles = await chooseProfiles(app, 'Сохранить в файл');
  if (!profiles) return;
  const json = exportJson(profiles, { appVersion: app.version });
  const name = exportFileName();
  const blob = new Blob([json], { type: 'application/json' });
  const download = () => {
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: name, style: { display: 'none' } });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  };
  const file = typeof File === 'function' ? new File([blob], name, { type: 'application/json' }) : null;
  const canShare = Boolean(file && navigator.canShare?.({ files: [file] }));
  openModal({
    title: '💾 Файл прогресса',
    body: h('div', null,
      h('p', null, `Файл «${name}» (${Math.ceil(blob.size / 1024)} КБ). Перенесите его на другое устройство любым способом и откройте там через «Загрузить файл».`),
      h('p', { class: 'muted small' }, `Профили: ${profiles.map((p) => p.name).join(', ')}.`)),
    actions: [
      ...(canShare ? [{
        label: 'Поделиться',
        kind: 'secondary',
        close: false,
        onClick: () => {
          navigator.share({ files: [file], title: 'Прогресс «Умножайки»' }).catch(() => {});
        },
      }] : []),
      { label: 'Скачать файл', kind: 'primary', close: false, onClick: download },
      { label: 'Готово', kind: 'secondary' },
    ],
  });
}

export async function showCodeFlow(app) {
  const profiles = await chooseProfiles(app, 'Код переноса');
  if (!profiles) return;
  const { code, checksum } = exportCode(profiles, { appVersion: app.version });
  const area = h('textarea', { class: 'input', readonly: true, rows: 6, 'aria-label': 'Код переноса' });
  area.value = code;
  const status = h('p', { class: 'muted small', role: 'status' }, `Длина: ${code.length} символов · контрольная сумма: ${checksum}`);
  openModal({
    title: '🔤 Код переноса',
    wide: true,
    body: h('div', { style: { display: 'grid', gap: '10px' } },
      h('p', null, 'Скопируйте код и отправьте его себе (например, в мессенджер). На другом устройстве: «Для взрослых» → «Ввести код».'),
      area, status),
    actions: [
      {
        label: 'Скопировать',
        kind: 'primary',
        close: false,
        onClick: async () => {
          const ok = await copyText(code);
          status.textContent = ok
            ? `Скопировано! Контрольная сумма: ${checksum}`
            : 'Не получилось скопировать автоматически — выделите текст и скопируйте вручную.';
          if (!ok) area.select();
        },
      },
      { label: 'Готово', kind: 'secondary' },
    ],
  });
}

export async function showQrFlow(app) {
  const profiles = await chooseProfiles(app, 'Перенос через QR');
  if (!profiles) return;
  // На большом экране код показывается крупнее — в него можно положить больше данных.
  const large = Math.min(window.innerWidth, window.innerHeight) >= 700;
  const { chunks, checksum } = exportQrChunks(profiles, {
    appVersion: app.version,
    chunkBytes: large ? QR_CHUNK_BYTES_LARGE : QR_CHUNK_BYTES,
  });
  const player = qrPlayer(chunks, {
    speed: app.settings.qrSpeed,
    onSpeed: (ms) => app.updateSettings({ qrSpeed: ms }),
  });
  openModal({
    title: '▦ Перенос через QR',
    wide: true,
    body: h('div', { style: { display: 'grid', gap: '12px' } },
      h('p', { style: { margin: 0 } }, chunks.length > 1
        ? `Данные разбиты на ${countText(chunks.length, ['QR-код', 'QR-кода', 'QR-кодов'])}, они сменяются сами. На втором устройстве: «Для взрослых» → «Сканировать QR» — и держите камеру, пока не соберутся все части.`
        : 'На втором устройстве: «Для взрослых» → «Сканировать QR» и наведите камеру на код.'),
      player.el,
      h('p', { class: 'muted small center', style: { margin: 0 } }, `Контрольная сумма: ${checksum}. Держите камеру в 10–20 см от экрана и сделайте его ярче, если код не читается.`)),
    actions: [{ label: 'Готово', kind: 'primary' }],
    onClose: () => player.destroy(),
  });
}

// ---------- импорт ----------

function describeStep(step) {
  const name = `«${step.remote.name}»`;
  if (step.action === 'add') return `➕ ${name} — новый профиль, будет добавлен.`;
  if (step.action === 'skip') return `⛔ ${name} — не поместится: на устройстве уже ${MAX_PROFILES} профиля. Удалите лишний профиль и повторите.`;
  const s = step.stats;
  const how = step.matchedBy === 'name' ? `с профилем «${step.local.name}» (совпало имя)` : 'с таким же профилем на этом устройстве';
  return `🔄 ${name} — объединим ${how}: более свежих записей фактов из импорта — ${s.fromRemote}, остаются местными — ${s.keptLocal}, новых занятий — ${s.sessionsAdded}.`;
}

/** Предпросмотр и объединение. Возвращает true, если данные записаны. */
export function previewAndMerge(app, parsed) {
  const plan = planImport(app.profiles, parsed.profiles);
  const changes = plan.filter((s) => s.action === 'add'
    || (s.action === 'merge' && (s.stats.fromRemote > 0 || s.stats.sessionsAdded > 0)));
  const overwrites = plan.some((s) => s.action === 'merge' && s.overwrites);
  return new Promise((resolve) => {
    if (!changes.length) {
      alertDialog({
        title: 'Новых данных нет',
        text: plan.some((s) => s.action === 'skip')
          ? h('div', null, plan.map((s) => h('p', null, describeStep(s))))
          : 'Всё из этих данных уже есть на этом устройстве.',
      }).then(() => resolve(false));
      return;
    }
    let confirmed = false;
    openModal({
      title: 'Перенос прогресса',
      wide: true,
      body: h('div', null,
        h('p', { class: 'muted small' }, `Формат данных: версия ${parsed.version}. Проверка целостности пройдена.`),
        plan.map((s) => h('p', null, describeStep(s))),
        overwrites && h('p', { class: 'notice' }, '⚠️ Внимание: часть записей на этом устройстве будет перезаписана более свежими данными из импорта. По каждому примеру сохранится самая свежая запись, остальное не пропадёт.')),
      actions: [
        { label: 'Отмена', kind: 'secondary' },
        { label: overwrites ? 'Объединить и перезаписать' : 'Перенести', kind: 'primary', onClick: () => { confirmed = true; } },
      ],
      onClose: async () => {
        if (!confirmed) {
          resolve(false);
          return;
        }
        try {
          await app.importProfiles(applyImport(plan));
          sound.play('complete');
          toast('Готово! Прогресс перенесён.');
          resolve(true);
        } catch {
          alertDialog({ title: 'Не получилось', text: 'Не удалось сохранить данные на этом устройстве.' });
          resolve(false);
        }
      },
    });
  });
}

function pickFiles({ accept, multiple = false, capture = false }) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, multiple, style: { display: 'none' } });
    if (capture) input.setAttribute('capture', 'environment');
    const done = (files) => {
      resolve(files);
      input.remove();
    };
    input.addEventListener('change', () => done([...(input.files ?? [])]), { once: true });
    // Окно выбора закрыли без файла: не оставляем скрытый input на странице.
    input.addEventListener('cancel', () => done([]), { once: true });
    document.body.append(input);
    input.click();
  });
}

export async function importFileFlow(app) {
  const [file] = await pickFiles({ accept: 'application/json,.json,text/plain' });
  if (!file) return false;
  try {
    const parsed = importJson(await file.text());
    return previewAndMerge(app, parsed);
  } catch (err) {
    await alertDialog({ title: 'Файл не подходит', text: messageOf(err) });
    return false;
  }
}

export function enterCodeFlow(app) {
  return new Promise((resolve) => {
    const area = h('textarea', { class: 'input', rows: 6, placeholder: 'UM1.…', 'aria-label': 'Код переноса', autocomplete: 'off', spellcheck: false });
    const error = h('p', { class: 'muted small', role: 'alert' });
    let parsed = null;
    openModal({
      title: '⌨ Ввести код',
      wide: true,
      body: h('div', { style: { display: 'grid', gap: '10px' } },
        h('p', { style: { margin: 0 } }, 'Вставьте код переноса целиком (переносы строк не мешают).'), area, error),
      actions: [
        { label: 'Отмена', kind: 'secondary' },
        {
          label: 'Проверить',
          kind: 'primary',
          onClick: () => {
            try {
              parsed = importCode(area.value);
              return true;
            } catch (err) {
              error.textContent = messageOf(err);
              return false;
            }
          },
        },
      ],
      onClose: () => resolve(parsed ? previewAndMerge(app, parsed) : false),
    });
  });
}

function partsList(collector) {
  const list = h('ol', { class: 'qr-parts', 'aria-hidden': 'true' });
  const status = h('p', { class: 'center', role: 'status', style: { fontWeight: 800, margin: 0 } }, 'Ищу QR-код…');
  const update = () => {
    list.replaceChildren(...Array.from({ length: collector.total }, (_, i) => h('li', {
      class: collector.parts.has(i + 1) ? 'is-on' : '',
    }, String(i + 1))));
    if (collector.total) status.textContent = `Получено ${collector.received} из ${collector.total}`;
  };
  return { list, status, update };
}

export function scanQrFlow(app) {
  return new Promise((resolve) => {
    const collector = new QrCollector();
    const ui = partsList(collector);
    const error = h('p', { class: 'notice', hidden: true, role: 'alert' });
    let result = null;
    let modal = null;
    const scanner = qrScanner({
      onText: (text) => {
        const st = collector.add(text);
        if (st === 'foreign') return;
        if (st === 'newer') {
          error.hidden = false;
          error.textContent = 'Эти коды созданы более новой версией «Умножайки». Обновите приложение.';
          return;
        }
        if (st === 'added' || st === 'restarted') sound.play('scan');
        ui.update();
        if (collector.complete) {
          try {
            result = collector.result();
            modal.close();
          } catch (err) {
            error.hidden = false;
            error.textContent = `${messageOf(err)} Начинаем считывание заново.`;
            collector.reset();
            ui.update();
          }
        }
      },
      onError: (msg) => {
        error.hidden = false;
        error.textContent = msg;
      },
    });
    modal = openModal({
      title: '📷 Сканировать QR',
      wide: true,
      body: h('div', { style: { display: 'grid', gap: '12px' } },
        h('p', { style: { margin: 0 } }, 'Наведите камеру на QR-коды на другом устройстве. Части можно ловить в любом порядке.'),
        scanner.el, ui.status, ui.list, error),
      actions: [{ label: 'Отмена', kind: 'secondary' }],
      onClose: () => {
        scanner.stop();
        resolve(result ? previewAndMerge(app, result) : false);
      },
    });
    scanner.start();
  });
}

export async function photoQrFlow(app) {
  const collector = new QrCollector();
  for (;;) {
    const files = await pickFiles({ accept: 'image/*', multiple: true });
    if (!files.length) return false;
    let found = 0;
    for (const file of files) {
      const text = await decodeImageFile(file).catch(() => null);
      if (text && collector.add(text) !== 'foreign') found += 1;
    }
    if (collector.complete) {
      try {
        return previewAndMerge(app, collector.result());
      } catch (err) {
        await alertDialog({ title: 'Не получилось', text: messageOf(err) });
        return false;
      }
    }
    const more = await new Promise((resolve) => {
      let again = false;
      openModal({
        title: 'Нужны ещё фото',
        body: h('p', null, found
          ? `Распознано частей: ${collector.received} из ${collector.total}. Добавьте фото остальных кодов: ${collector.missing().join(', ')}.`
          : 'На фото не нашлось QR-кода «Умножайки». Снимите код крупнее и при хорошем свете.'),
        actions: [
          { label: 'Отмена', kind: 'secondary' },
          { label: 'Добавить фото', kind: 'primary', onClick: () => { again = true; } },
        ],
        onClose: () => resolve(again),
      });
    });
    if (!more) return false;
  }
}
