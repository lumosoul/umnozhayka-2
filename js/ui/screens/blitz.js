// Блиц: 60 секунд, только освоенные факты. Единственное место, где виден таймер.

import { Stopwatch, afterPaint, fill, h } from '../dom.js';
import { owlSays } from '../components/owl.js';
import { createKeypad } from '../components/keypad.js';
import { childTopbar } from '../common.js';
import { sound } from '../audio.js';
import { BLITZ_MS, BlitzRunner, blitzAvailable } from '../../core/session.js';
import { recordSession } from '../../core/progress.js';

export function blitzScreen(app) {
  const profile = app.profile;
  const stage = h('div', { class: 'task' });
  const el = h('section', { class: 'screen screen--narrow' },
    childTopbar(app, { title: 'Блиц', back: () => app.go('home') }),
    stage);
  const timers = new Set();
  const stopwatch = new Stopwatch();
  let keyHandler = null;
  let runner = null;
  let tick = null;
  let done = false;

  const later = (fn, ms) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  };

  function intro() {
    if (!blitzAvailable(profile)) {
      stage.replaceChildren(owlSays('Блиц откроется, когда ты выучишь хотя бы 4 примера. Позанимайся немного — и вперёд!'),
        h('button', { type: 'button', class: 'btn btn--primary btn--big', onClick: () => app.go('lesson') }, 'К занятию'));
      return;
    }
    const start = h('button', { type: 'button', class: 'btn btn--primary btn--big', onClick: countdown }, 'Старт!');
    fill(stage,
      owlSays('60 секунд! Решай примеры, которые ты уже знаешь, как можно быстрее.', { size: 'big' }),
      profile.blitzBest ? h('p', { class: 'chip chip--accent' }, `Твой рекорд: ${profile.blitzBest}`) : null,
      start);
    keyHandler = null;
    afterPaint(() => start.focus({ preventScroll: true }));
  }

  function countdown() {
    let n = 3;
    keyHandler = () => true;
    const show = () => {
      if (n === 0) {
        run();
        return;
      }
      sound.play('tick');
      stage.replaceChildren(h('p', { class: 'countdown', 'aria-live': 'assertive' }, String(n)));
      n -= 1;
      later(show, 700);
    };
    show();
  }

  function run() {
    runner = new BlitzRunner(profile);
    runner.start();
    sound.play('start');
    const barFill = h('span', { style: { width: '100%' } });
    const secs = h('span', { class: 'timer__sec', 'aria-hidden': 'true' }, '60');
    const score = h('p', { class: 'blitz-score', 'aria-live': 'polite' }, 'Верно: 0');
    const timer = h('div', { class: 'timer', role: 'timer', 'aria-label': 'Осталось 60 секунд' },
      h('div', { class: 'timer__bar' }, barFill), secs);
    const area = h('div', { style: { display: 'grid', gap: '16px', justifyItems: 'center', width: '100%' } });
    stage.replaceChildren(timer, score, area);
    let lastSec = 60;
    tick = setInterval(() => {
      const left = runner.timeLeft();
      barFill.style.width = `${(left / BLITZ_MS) * 100}%`;
      const s = Math.ceil(left / 1000);
      if (s !== lastSec) {
        lastSec = s;
        secs.textContent = String(s);
        if (s % 10 === 0 || s <= 5) timer.setAttribute('aria-label', `Осталось ${s} секунд`);
      }
      if (left <= 0) finish();
    }, 200);
    const ask = () => {
      if (done) return;
      const task = runner.current();
      const slot = h('span', { class: 'expr__slot expr__slot--empty' }, '?');
      const note = h('div', { style: { minHeight: '56px', width: '100%' } });
      let answered = false;
      const keypad = createKeypad({
        maxLength: 3,
        onChange: (v) => {
          slot.textContent = v || '?';
          slot.classList.toggle('expr__slot--empty', v === '');
        },
        onSubmit: (v) => {
          if (answered || done) return;
          answered = true;
          const res = runner.answer(v, stopwatch.elapsed());
          app.saveProfile(profile);
          score.textContent = `Верно: ${runner.correctCount}`;
          if (res.correct) {
            sound.play('correct');
            slot.classList.add('expr__slot--good');
            runner.next();
            later(ask, 180);
          } else {
            sound.play('gentle');
            keypad.setDisabled(true);
            note.replaceChildren(h('div', { class: 'feedback feedback--calm' }, `${task.a} × ${task.b} = ${task.product}`));
            runner.next();
            later(ask, 1200);
          }
        },
      });
      keyHandler = (e) => keypad.handleKey(e);
      area.replaceChildren(h('p', { class: 'expr' }, `${task.a} × ${task.b} = `, slot), keypad.el, note);
      afterPaint(() => stopwatch.start());
    };
    ask();
  }

  function finish() {
    if (done) return;
    done = true;
    clearInterval(tick);
    for (const t of timers) clearTimeout(t);
    const summary = runner.summary();
    const result = recordSession(profile, summary);
    app.saveProfile(profile);
    app.go('summary', { kind: 'blitz', summary, result });
  }

  intro();
  return {
    el,
    onKey: (e) => (keyHandler ? keyHandler(e) : false),
    destroy: () => {
      clearInterval(tick);
      for (const t of timers) clearTimeout(t);
      stopwatch.dispose();
      // Ушли посреди блица — ответы уже в фактах, занятие засчитаем, если что-то решено.
      if (runner && !done && runner.answered > 0) {
        done = true;
        recordSession(profile, runner.summary());
        app.saveProfile(profile);
      }
    },
  };
}
