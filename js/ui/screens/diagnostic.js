// Диагностика при первом запуске: до 20 примеров, не дольше 5 минут (таймер не показываем).
// Ошибки не подсвечиваем как провал: «Это выучим вместе!» — и дальше.

import { Stopwatch, afterPaint, h } from '../dom.js';
import { createOwl, owlSays, setOwlMood, speakButton } from '../components/owl.js';
import { createKeypad } from '../components/keypad.js';
import { soundToggle } from '../common.js';
import { confirmDialog } from '../components/modal.js';
import { gridMini } from './progress.js';
import { sound } from '../audio.js';
import { DIAG_ITEMS, DIAG_MAX_MS, Diagnostic, applyDiagnostic } from '../../core/diagnostic.js';
import { parseFactId } from '../../core/facts.js';
import { sessionId } from '../../core/session.js';
import { recordSession } from '../../core/progress.js';
import { countText, dayNumber, nowSec } from '../../core/dates.js';

export function diagnosticScreen(app) {
  const profile = app.profile;
  const diag = new Diagnostic();
  const draft = profile.diagnosticDraft;
  // Диагностику прервали (перезагрузка, закрытая вкладка) — продолжаем с того же места.
  const resumed = Boolean(draft?.answers?.length);
  const id = resumed && draft.id ? draft.id : sessionId();
  if (resumed) for (const a of draft.answers) diag.record(a.id, a);
  const stopwatch = new Stopwatch();
  const stage = h('div', { class: 'task' });
  const title = h('h1', { class: 'topbar__title', tabindex: -1 }, 'Знакомство');
  const stopBtn = h('button', {
    type: 'button',
    class: 'btn btn--ghost btn--small',
    hidden: true,
    onClick: async () => {
      const ok = await confirmDialog({
        title: 'Закончить знакомство?',
        text: 'Ответы сохранятся, а остальное мы узнаем на занятиях.',
        ok: 'Закончить',
        cancel: 'Продолжить',
      });
      if (ok) finish();
    },
  }, 'Закончить');
  const el = h('section', { class: 'screen screen--narrow' },
    h('header', { class: 'topbar' }, title, stopBtn, soundToggle(app)),
    stage);
  let keyHandler = null;
  let startedAt = 0;
  let deadline = null;
  let finished = false;
  let totalMs = resumed ? draft.totalMs : 0;
  const resumedMs = resumed ? draft.elapsedMs : 0;
  const timers = new Set();

  const later = (fn, ms) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  };

  function intro() {
    if (resumed) {
      const go = h('button', { type: 'button', class: 'btn btn--primary btn--big', onClick: begin }, 'Продолжить');
      stage.replaceChildren(
        owlSays(`${profile.name}, продолжим знакомство! Осталось совсем немного.`, { size: 'big' }),
        go);
      afterPaint(() => go.focus({ preventScroll: true }));
      return;
    }
    const start = h('button', { type: 'button', class: 'btn btn--primary btn--big', onClick: begin }, 'Начать');
    stage.replaceChildren(
      owlSays(`Привет, ${profile.name}! Давай посмотрим, что ты уже знаешь.`, { size: 'big' }),
      h('div', { class: 'card', style: { textAlign: 'left' } },
        h('p', null, `Будет до ${DIAG_ITEMS} примеров — это займёт несколько минут.`),
        h('p', { style: { margin: 0 } }, 'Не знаешь ответ — нажми «Не знаю». Это нормально: мы всё выучим вместе!')),
      start);
    keyHandler = null;
    afterPaint(() => start.focus({ preventScroll: true }));
  }

  function begin() {
    sound.play('start');
    stopBtn.hidden = false;
    startedAt = performance.now() - resumedMs;
    // Жёсткий предел 5 минут: даже если ребёнок задумался над примером.
    deadline = setTimeout(() => finish(), Math.max(0, DIAG_MAX_MS - resumedMs));
    ask();
  }

  function saveDraft() {
    profile.diagnosticDraft = {
      id,
      answers: diag.answers.map(({ id: factId, correct, ms, given }) => ({ id: factId, correct, ms, given })),
      elapsedMs: Math.round(elapsed()),
      totalMs: Math.round(totalMs),
    };
    app.saveProfile(profile);
  }

  function elapsed() {
    return performance.now() - startedAt;
  }

  function ask() {
    if (finished) return;
    const factId = diag.next(elapsed());
    if (!factId) {
      finish();
      return;
    }
    const { a, b } = parseFactId(factId);
    const owl = createOwl({ size: 'small' });
    const slot = h('span', { class: 'expr__slot expr__slot--empty' }, '?');
    const feedback = h('div', { 'aria-live': 'polite', style: { minHeight: '56px', width: '100%' } });
    let answered = false;
    const submit = (value) => {
      if (answered || finished) return;
      answered = true;
      const ms = stopwatch.elapsed();
      totalMs += Math.min(ms, 30000);
      const correct = value === a * b;
      diag.record(factId, { correct, ms, given: value });
      saveDraft();
      keypad.setDisabled(true);
      dontKnow.disabled = true;
      if (correct) {
        sound.play('correct');
        setOwlMood(owl, 'happy');
        feedback.replaceChildren(h('div', { class: 'feedback feedback--good' }, '✓ Верно!'));
      } else {
        sound.play('tap');
        feedback.replaceChildren(h('div', { class: 'feedback feedback--neutral' }, 'Хорошо! Это выучим вместе.'));
      }
      later(ask, correct ? 650 : 900);
    };
    const keypad = createKeypad({
      maxLength: 3,
      onChange: (v) => {
        slot.textContent = v || '?';
        slot.classList.toggle('expr__slot--empty', v === '');
      },
      onSubmit: (v) => submit(v),
    });
    const dontKnow = h('button', { type: 'button', class: 'btn btn--ghost btn--small dontknow', onClick: () => submit(null) }, '🤔 Не знаю');
    keyHandler = (e) => keypad.handleKey(e);
    title.textContent = `Знакомство · ${diag.count + 1} из ${DIAG_ITEMS}`;
    stage.replaceChildren(
      h('div', { class: 'owl-say owl-say--center' }, owl, h('p', { class: 'task__hint' }, 'Введи ответ'),
        speakButton(() => `${a} × ${b} = ?`)),
      h('p', { class: 'expr' }, `${a} × ${b} = `, slot),
      h('div', { style: { display: 'grid', gap: '12px', justifyItems: 'center', width: '100%' } }, keypad.el, dontKnow),
      feedback);
    afterPaint(() => stopwatch.start());
  }

  /** silent — уход с экрана посреди диагностики: только сохраняем результат. */
  function finish({ silent = false } = {}) {
    if (finished) return;
    finished = true;
    stopBtn.hidden = true;
    clearTimeout(deadline);
    for (const t of timers) clearTimeout(t);
    const now = Date.now();
    const durationMs = startedAt ? elapsed() : 0;
    const result = diag.result();
    const { known } = applyDiagnostic(profile, result, { now, sessionId: id, durationMs });
    profile.diagnosticDraft = null;
    recordSession(profile, {
      id,
      type: 'diagnostic',
      day: dayNumber(now),
      start: nowSec(now - durationMs),
      durationMs,
      tasks: result.answers.length,
      correct: result.answers.filter((x) => x.correct).length,
      totalMs,
      newFacts: 0,
      improved: 0,
    }, { now });
    app.saveProfile(profile);
    if (silent) return;
    sound.play('complete');
    title.textContent = 'Знакомство окончено!';
    const go = h('button', { type: 'button', class: 'btn btn--primary btn--big btn--block', onClick: () => app.go('home') }, 'Начать учиться!');
    const knownText = known.length
      ? `Ты уже знаешь ${countText(known.length, ['пример', 'примера', 'примеров'])} из 100! Они отмечены зелёным.`
      : 'Отлично начинаем! Все примеры выучим шаг за шагом.';
    stage.replaceChildren(
      owlSays(knownText, { mood: 'cheer', size: 'big' }),
      h('div', { class: 'table-wrap' }, gridMini(profile)),
      h('p', { class: 'muted center', style: { margin: 0 } }, '⭐ +2 звезды за знакомство'),
      go);
    keyHandler = (e) => (e.key === 'Enter' ? (go.click(), true) : false);
    afterPaint(() => go.focus({ preventScroll: true }));
  }

  intro();
  return {
    el,
    onKey: (e) => (keyHandler ? keyHandler(e) : false),
    destroy: () => {
      clearTimeout(deadline);
      for (const t of timers) clearTimeout(t);
      stopwatch.dispose();
      // Ушли с экрана посреди диагностики — сохраняем то, что успели узнать.
      if (startedAt && !finished && diag.count > 0) finish({ silent: true });
    },
  };
}
