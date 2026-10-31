// Занятие: правило нуля и объяснение столбца (когда нужно), знакомство с новыми фактами,
// 20 заданий в четырёх форматах, спокойный разбор ошибок. Время ответа измеряется незаметно.

import { Stopwatch, afterPaint, announce, h } from '../dom.js';
import { createOwl, owlSays, setOwlMood, speakButton } from '../components/owl.js';
import { createKeypad } from '../components/keypad.js';
import { dotGroups } from '../components/visuals.js';
import { columnSlides, newFactCard, slideShow, zeroSlides } from '../components/explain.js';
import { confirmDialog } from '../components/modal.js';
import { phrases, soundToggle } from '../common.js';
import { sound } from '../audio.js';
import {
  LessonRunner, markColumnIntroduced, markZeroLessonDone, planLesson, zeroPractice,
} from '../../core/session.js';
import { pairId, trickFor } from '../../core/facts.js';
import { FAST_MS } from '../../core/leitner.js';
import { isMastered } from '../../core/knowledge.js';
import { recordSession, updateBadges } from '../../core/progress.js';

const HINTS = {
  choice: 'Выбери ответ',
  truefalse: 'Верно или неверно?',
  input: 'Введи ответ',
  missing: 'Какое число пропущено?',
};

export function lessonScreen(app) {
  const profile = app.profile;
  const plan = planLesson(profile);
  const runner = new LessonRunner(profile, plan);
  const stopwatch = new Stopwatch();
  const timers = new Set();
  let keyHandler = null;
  let streakRun = 0;
  let finished = false;
  const zeroBadge = [];

  const later = (fn, ms) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  };

  const bar = h('span', { style: { width: '0%' } });
  const progress = h('div', {
    class: 'lesson-progress',
    role: 'progressbar',
    'aria-label': 'Прогресс занятия',
    'aria-valuemin': 0,
    'aria-valuemax': 100,
    'aria-valuenow': 0,
  }, bar);
  const exitBtn = h('button', {
    type: 'button',
    class: 'btn btn--ghost btn--icon',
    'aria-label': 'Закончить занятие',
    title: 'Закончить',
    onClick: () => askExit(),
  }, '✕');
  const title = h('h1', { class: 'sr-only', tabindex: -1 }, 'Занятие');
  const stage = h('div', { class: 'task' });
  const el = h('section', { class: 'screen screen--narrow' },
    title,
    h('div', { class: 'lesson-top' }, exitBtn, progress, soundToggle(app)),
    stage);

  const updateProgress = () => {
    const pct = Math.round((runner.index / Math.max(1, runner.total)) * 100);
    bar.style.width = `${pct}%`;
    progress.setAttribute('aria-valuenow', String(pct));
    progress.setAttribute('aria-valuetext', `Задание ${Math.min(runner.index + 1, runner.total)} из ${runner.total}`);
  };

  const save = () => app.saveProfile(profile);

  // ---------- вступление: правило нуля и объяснение столбца ----------

  function startIntro() {
    if (plan.zeroLesson) showZeroLesson(() => startColumnIntro());
    else startColumnIntro();
  }

  function startColumnIntro() {
    if (plan.introColumn == null) {
      nextTask();
      return;
    }
    const show = slideShow(columnSlides(plan.introColumn), {
      doneLabel: 'Начинаем!',
      onDone: () => {
        markColumnIntroduced(profile, plan.introColumn);
        save();
        nextTask();
      },
    });
    keyHandler = show.onKey;
    stage.replaceChildren(show.el);
  }

  function showZeroLesson(done) {
    const show = slideShow(zeroSlides(), {
      doneLabel: 'Проверим!',
      onDone: () => zeroQuiz(zeroPractice(), 0, done),
    });
    keyHandler = show.onKey;
    stage.replaceChildren(show.el);
  }

  function zeroQuiz(tasks, i, done) {
    if (i >= tasks.length) {
      markZeroLessonDone(profile);
      zeroBadge.push(...updateBadges(profile, app.today()));
      save();
      sound.play('badge');
      const cont = h('button', { type: 'button', class: 'btn btn--primary btn--big', onClick: () => done() }, 'Дальше');
      stage.replaceChildren(
        owlSays('Правило нуля — твоё! Любое число × 0 = 0.', { mood: 'cheer' }),
        h('div', { class: 'badge-earned' }, h('span', { class: 'badge-earned__icon' }, '⭕'), 'Награда: «Правило нуля»'),
        cont);
      keyHandler = (e) => (e.key === 'Enter' ? (cont.click(), true) : false);
      afterPaint(() => cont.focus({ preventScroll: true }));
      return;
    }
    const t = tasks[i];
    const feedback = h('div', { 'aria-live': 'polite' });
    const buttons = t.options.map((v, k) => h('button', {
      type: 'button',
      class: 'choice',
      onClick: () => pickZero(v, buttons[k]),
    }, String(v), h('span', { class: 'choice__key', 'aria-hidden': 'true' }, String(k + 1))));
    let locked = false;
    const pickZero = (v, btn) => {
      if (locked) return;
      if (v === 0) {
        locked = true;
        btn.classList.add('is-right');
        sound.play('correct');
        feedback.replaceChildren(h('div', { class: 'feedback feedback--good' }, '✓ ', phrases.correct()));
        later(() => zeroQuiz(tasks, i + 1, done), 800);
      } else {
        btn.classList.add('is-picked');
        btn.disabled = true;
        sound.play('gentle');
        feedback.replaceChildren(h('div', { class: 'feedback feedback--calm' }, 'Вспомни правило: с нулём всегда 0.'));
      }
    };
    keyHandler = (e) => {
      const n = Number(e.key);
      if (n >= 1 && n <= buttons.length) {
        buttons[n - 1].click();
        return true;
      }
      return false;
    };
    stage.replaceChildren(
      h('p', { class: 'task__hint' }, `Правило нуля · ${i + 1} из ${tasks.length}`),
      h('p', { class: 'expr' }, `${t.a} × ${t.b} = `, h('span', { class: 'expr__slot expr__slot--empty' }, '?')),
      h('div', { class: 'choices' }, buttons),
      feedback);
  }

  // ---------- задания ----------

  function nextTask() {
    if (finished) return;
    updateProgress();
    if (runner.finished) {
      finish();
      return;
    }
    const task = runner.current();
    if (task.intro) showNewFact(task);
    else showQuestion(task);
  }

  function showNewFact(task) {
    const pair = profile.facts[pairId(task.factId)];
    const card = newFactCard(task, { pairKnown: isMastered(pair), onReady: () => showQuestion(task) });
    keyHandler = null;
    stage.replaceChildren(owlSays('Познакомимся с новым примером!', { mood: 'think' }), card);
  }

  function exprFor(task, slot) {
    const { a, b, product } = task;
    switch (task.format) {
      case 'truefalse':
        return h('p', { class: 'expr' }, `${a} × ${b} = ${task.shown}`);
      case 'missing':
        return task.side === 'a'
          ? h('p', { class: 'expr' }, slot, ` × ${b} = ${product}`)
          : h('p', { class: 'expr' }, `${a} × `, slot, ` = ${product}`);
      default:
        return h('p', { class: 'expr' }, `${a} × ${b} = `, slot);
    }
  }

  function showQuestion(task) {
    const owl = createOwl({ size: 'small' });
    const slot = h('span', { class: 'expr__slot expr__slot--empty' }, '?');
    const feedback = h('div', { 'aria-live': 'polite', style: { minHeight: '56px', width: '100%' } });
    const expr = exprFor(task, slot);
    const parts = [
      h('div', { class: 'owl-say owl-say--center' }, owl, h('p', { class: 'task__hint' }, HINTS[task.format]),
        speakButton(() => `${HINTS[task.format]}. ${task.format === 'truefalse' ? `${task.a} × ${task.b} = ${task.shown}` : expr.textContent.replace(/\s+/g, ' ')}`)),
      expr,
    ];
    let answered = false;
    const submit = (value) => {
      if (answered) return;
      answered = true;
      const ms = stopwatch.elapsed();
      const res = runner.answer(value, ms);
      save();
      if (res.correct) onCorrect(task, res, ms, { owl, slot, feedback, controls });
      else onWrong(task, value, { owl });
    };

    let controls;
    if (task.format === 'choice') {
      const buttons = task.options.map((v, i) => h('button', {
        type: 'button',
        class: 'choice',
        'aria-label': `${v}`,
        onClick: () => {
          buttons[i].classList.add(v === task.answer ? 'is-right' : 'is-picked');
          submit(v);
        },
      }, String(v), h('span', { class: 'choice__key', 'aria-hidden': 'true' }, String(i + 1))));
      controls = h('div', { class: 'choices' }, buttons);
      keyHandler = (e) => {
        const n = Number(e.key);
        if (n >= 1 && n <= buttons.length) {
          buttons[n - 1].click();
          return true;
        }
        return false;
      };
    } else if (task.format === 'truefalse') {
      const yes = h('button', { type: 'button', class: 'btn btn--secondary', onClick: () => submit(true) }, '✓ Верно');
      const no = h('button', { type: 'button', class: 'btn btn--secondary', onClick: () => submit(false) }, '✗ Неверно');
      controls = h('div', { class: 'tf' }, yes, no);
      keyHandler = (e) => {
        if (e.key === '1' || e.key === 'ArrowLeft') {
          yes.click();
          return true;
        }
        if (e.key === '2' || e.key === 'ArrowRight') {
          no.click();
          return true;
        }
        return false;
      };
    } else {
      const keypad = createKeypad({
        maxLength: task.format === 'missing' ? 2 : 3,
        onChange: (v) => {
          slot.textContent = v || '?';
          slot.classList.toggle('expr__slot--empty', v === '');
        },
        onSubmit: (v) => submit(v),
      });
      const dontKnow = h('button', { type: 'button', class: 'btn btn--ghost btn--small dontknow', onClick: () => submit(null) }, '🤔 Не знаю');
      controls = h('div', { style: { display: 'grid', gap: '12px', justifyItems: 'center', width: '100%' } }, keypad.el, dontKnow);
      keyHandler = (e) => keypad.handleKey(e);
    }
    stage.replaceChildren(...parts, controls, feedback);
    title.textContent = `Задание ${runner.index + 1} из ${runner.total}`;
    afterPaint(() => stopwatch.start());
  }

  function onCorrect(task, res, ms, { owl, slot, feedback, controls }) {
    streakRun += 1;
    sound.play('correct');
    setOwlMood(owl, 'happy');
    slot.textContent = String(task.answer === true || task.answer === false ? task.product : task.answer);
    slot.classList.remove('expr__slot--empty');
    slot.classList.add('expr__slot--good');
    for (const b of controls.querySelectorAll('button')) b.disabled = true;
    let text = phrases.correct();
    if (streakRun >= 5 && streakRun % 5 === 0) text = phrases.streak(streakRun);
    else if (ms < FAST_MS && (task.format === 'input' || task.format === 'missing')) text = phrases.fast();
    if (res.statusBefore !== res.status && (res.status === 'known' || res.status === 'auto')) {
      text = res.status === 'auto' ? `${task.a} × ${task.b} — теперь на автомате! ⚡` : `${task.a} × ${task.b} — выучен! ✓`;
    }
    const next = h('button', { type: 'button', class: 'btn btn--good btn--small', onClick: () => go() }, 'Дальше →');
    feedback.replaceChildren(h('div', { class: 'feedback feedback--good' }, '✓ ', text, next));
    announce(text);
    let gone = false;
    const go = () => {
      if (gone) return;
      gone = true;
      runner.next();
      nextTask();
    };
    keyHandler = (e) => (e.key === 'Enter' || e.key === ' ' ? (go(), true) : false);
    later(go, 1100);
  }

  function onWrong(task, value, { owl }) {
    streakRun = 0;
    sound.play('gentle');
    setOwlMood(owl, 'think');
    const { a, b, product } = task;
    const typed = h('span', { class: 'answer answer--empty' });
    const status = h('p', { class: 'muted', role: 'status', style: { margin: 0, fontWeight: 700 } }, 'Теперь введи этот ответ на клавиатуре:');
    const keypad = createKeypad({
      maxLength: 3,
      onChange: (v) => {
        typed.textContent = v;
        typed.classList.toggle('answer--empty', v === '');
      },
      onSubmit: (v) => {
        if (runner.checkCorrection(v)) {
          sound.play('fixed');
          keypad.setDisabled(true);
          status.textContent = phrases.fixed();
          status.style.color = 'var(--good-ink)';
          announce(status.textContent);
          later(() => {
            runner.next();
            nextTask();
          }, 900);
        } else {
          sound.play('tap');
          status.textContent = `Посмотри ещё раз: ${a} × ${b} = ${product}. Введи ${product}.`;
          keypad.clear();
        }
      },
    });
    keyHandler = (e) => keypad.handleKey(e);
    const opener = value == null ? phrases.dontKnow() : phrases.calm();
    stage.replaceChildren(
      owlSays(opener, { mood: 'think' }),
      h('div', { class: 'correction' },
        h('p', { class: 'correction__fact' }, `${a} × ${b} = ${product}`),
        dotGroups(a, b, { highlight: true, labels: b > 1 }),
        h('p', { class: 'trick' }, trickFor(a, b).text),
        status,
        h('p', { class: 'expr', style: { fontSize: 'clamp(2rem, 7vw, 2.75rem)' } }, `${a} × ${b} = `, typed),
        keypad.el));
    announce(`${opener} Правильный ответ: ${a} умножить на ${b} равно ${product}.`);
  }

  // ---------- конец ----------

  async function askExit() {
    if (finished) return;
    const ok = await confirmDialog({
      title: 'Закончить занятие?',
      text: 'Все ответы уже сохранены. Можно продолжить в любой момент.',
      ok: 'Закончить',
      cancel: 'Продолжить',
    });
    if (ok) {
      runner.stop();
      finish();
    }
  }

  function finish() {
    if (finished) return;
    finished = true;
    for (const t of timers) clearTimeout(t);
    const summary = runner.summary();
    if (summary.tasks === 0) {
      save();
      app.go('home');
      return;
    }
    const result = recordSession(profile, summary);
    result.badges.unshift(...zeroBadge);
    save();
    app.go('summary', { kind: 'lesson', summary, result });
  }

  afterPaint(startIntro);
  return {
    el,
    onKey: (e) => {
      if (e.key === 'Escape') {
        askExit();
        return true;
      }
      return keyHandler ? keyHandler(e) : false;
    },
    /** Страницу закрывают или прячут: записываем незаконченное занятие (потом оно обновится). */
    suspend: () => {
      if (finished || runner.answered < 5) return;
      recordSession(profile, runner.summary());
      save();
    },
    destroy: () => {
      for (const t of timers) clearTimeout(t);
      stopwatch.dispose();
    },
  };
}
