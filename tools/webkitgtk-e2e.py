#!/usr/bin/env python3
"""Сквозная проверка «Умножайки» в WebKitGTK — на движке WebKit (WebCore + JavaScriptCore), как у Safari.

Ничего не скачивает: нужна системная библиотека WebKitGTK с привязками GObject
(Ubuntu/Debian: gir1.2-webkit2-4.1, python3-gi, python3-gi-cairo). Окно рисуется вне экрана,
а щелчки мыши и нажатия клавиш — настоящие события GDK: они проходят весь путь обработки
ввода в WebKit, как при работе с мышью и клавиатурой.

Запуск: python3 tools/webkitgtk-e2e.py [папка-для-скриншотов]
"""

import os

os.environ.setdefault('GTK_IM_MODULE', 'gtk-im-context-simple')  # без IBus: клавиши доходят как есть

import functools
import http.server
import json
import pathlib
import re
import sys
import tempfile
import threading
import time

import gi

gi.require_version('Gtk', '3.0')
gi.require_version('Gdk', '3.0')
gi.require_version('WebKit2', '4.1')
gi.require_foreign('cairo')
from gi.repository import Gdk, GLib, Gtk, WebKit2  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix='umnozhayka-webkitgtk-'))
OUT.mkdir(parents=True, exist_ok=True)

# Что сейчас на экране — тот же «ребёнок-робот», что и в tools/e2e.mjs.
DESCRIBE = r"""(() => {
  const app = globalThis.umnozhayka;
  const vis = (s) => [...document.querySelectorAll(s)].filter((e) => e.offsetParent !== null);
  const txt = (s) => vis(s)[0]?.textContent.replace(/\s+/g, ' ').trim() ?? null;
  const st = { screen: app?.currentName, modal: document.querySelector('.modal h2')?.textContent ?? null,
    timer: !!document.querySelector('.timer'), seen: !!document.querySelector('[data-e2e-seen]') };
  if (st.modal) st.kind = 'modal';
  else if (vis('.slides').length) st.kind = 'slides';
  else if (vis('.new-fact').length) st.kind = 'newFact';
  else if (vis('.correction').length) { st.kind = 'correction'; st.fact = txt('.correction__fact'); st.keypadOn = vis('.correction .key:not(:disabled)').length > 0; }
  else if (vis('.feedback--good').length || vis('.feedback--neutral').length) st.kind = 'feedback';
  else if (vis('.choices').length) { st.kind = 'choice'; st.expr = txt('.task .expr'); st.options = vis('.choice').map((b) => b.firstChild.textContent); st.hint = txt('.task__hint'); }
  else if (vis('.tf').length) { st.kind = 'tf'; st.expr = txt('.task .expr'); }
  else if (vis('.keypad').length && vis('.task .expr').length) { st.kind = 'keypad'; st.expr = txt('.task .expr'); }
  else if (vis('.countdown').length) st.kind = 'countdown';
  else st.kind = 'other';
  return st;
})()"""

# Ловим ошибки страницы до запуска её скриптов.
ERROR_HOOK = """
window.__e2eErrors = [];
addEventListener('error', (e) => __e2eErrors.push(String(e.message || e.error)));
addEventListener('unhandledrejection', (e) => __e2eErrors.push('promise: ' + String(e.reason?.message || e.reason)));
"""

KEYVALS = {
    'Enter': Gdk.KEY_Return,
    'Escape': Gdk.KEY_Escape,
    'Backspace': Gdk.KEY_BackSpace,
    'Tab': Gdk.KEY_Tab,
    'ArrowRight': Gdk.KEY_Right,
    'ArrowLeft': Gdk.KEY_Left,
    'ArrowDown': Gdk.KEY_Down,
    'ArrowUp': Gdk.KEY_Up,
    ' ': Gdk.KEY_space,
}

results = []


class Skip(Exception):
    """Шаг нельзя проверить в этой системе (а не ошибка приложения)."""


def step(name, fn):
    t0 = time.monotonic()
    try:
        note = fn()
        results.append(True)
        print(f'✓ {name}' + (f' — {note}' if note else '') + f' ({time.monotonic() - t0:.1f} с)', flush=True)
        return True
    except Skip as why:
        results.append(None)
        print(f'– {name}: пропущено — {why}', flush=True)
        return False
    except Exception as err:  # отчёт по каждому шагу, проверка идёт дальше
        results.append(False)
        print(f'✗ {name}: {err}', flush=True)
        return False


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'))


def solve(expr):
    m = re.match(r'^(\?|\d+) × (\?|\d+) = (\?|\d+)$', re.sub(r'\s+', ' ', expr).strip())
    if not m:
        raise AssertionError(f'не разобрал пример «{expr}»')
    a, b, c = (None if v == '?' else int(v) for v in m.groups())
    if a is None:
        return {'a': c // b, 'b': b, 'answer': c // b, 'kind': 'missing'}
    if b is None:
        return {'a': a, 'b': c // a, 'answer': c // a, 'kind': 'missing'}
    if c is None:
        return {'a': a, 'b': b, 'answer': a * b, 'kind': 'product'}
    return {'a': a, 'b': b, 'answer': a * b == c, 'kind': 'tf'}


def pump(seconds=0.0, until=None, timeout=30.0, what='событие'):
    """Крутит цикл GLib: заданное время или пока until() не станет истинным."""
    ctx = GLib.MainContext.default()
    end = time.monotonic() + (seconds if until is None else timeout)
    while True:
        while ctx.pending():
            ctx.iteration(False)
        if until is not None and until():
            return
        if time.monotonic() >= end:
            if until is None:
                return
            raise TimeoutError(f'не дождались: {what}')
        ctx.iteration(True)  # проснёмся по «пульсу» ниже или по событию


GLib.timeout_add(15, lambda: True)  # «пульс», чтобы цикл не засыпал надолго


class Server:
    """Статический сервер. offline=True — «режим полёта»: соединение рвётся без ответа."""

    def __init__(self, root):
        self.hits = 0
        self.offline = False
        server = self

        class Handler(http.server.SimpleHTTPRequestHandler):
            extensions_map = {
                **http.server.SimpleHTTPRequestHandler.extensions_map,
                '.js': 'text/javascript',
                '.mjs': 'text/javascript',
                '.webmanifest': 'application/manifest+json',
                '.svg': 'image/svg+xml',
                '.json': 'application/json',
            }

            def log_message(self, *args):  # тихо
                pass

            def do_GET(self):
                server.hits += 1
                if server.offline:
                    self.close_connection = True
                    return
                super().do_GET()

        self.httpd = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(root)))
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.url = f'http://127.0.0.1:{self.httpd.server_address[1]}/'


class Device:
    """Отдельное «устройство»: свой профиль WebKit (IndexedDB, service worker, кэш) и своё окно."""

    def __init__(self, name, width=390, height=844):
        base = OUT / 'profiles' / name
        self.name = name
        self.downloads = OUT / f'{name}-downloads'
        self.downloads.mkdir(parents=True, exist_ok=True)
        self.files_to_choose = []
        self.errors = []
        self.load_finished = False
        manager = WebKit2.WebsiteDataManager(base_data_directory=str(base / 'data'),
                                             base_cache_directory=str(base / 'cache'))
        self.context = WebKit2.WebContext(website_data_manager=manager)
        self.context.connect('download-started', self._on_download)
        content = WebKit2.UserContentManager()
        content.add_script(WebKit2.UserScript(ERROR_HOOK, WebKit2.UserContentInjectedFrames.TOP_FRAME,
                                              WebKit2.UserScriptInjectionTime.START, None, None))
        self.view = WebKit2.WebView(web_context=self.context, user_content_manager=content)
        settings = self.view.get_settings()
        settings.set_enable_write_console_messages_to_stdout(False)
        settings.set_enable_media_stream(True)
        settings.set_media_playback_requires_user_gesture(False)
        settings.set_hardware_acceleration_policy(WebKit2.HardwareAccelerationPolicy.NEVER)
        self.view.connect('load-changed', self._on_load)
        self.view.connect('run-file-chooser', self._on_file_chooser)
        self.view.connect('permission-request', lambda _v, req: (req.allow(), True)[1])
        self.window = Gtk.OffscreenWindow()
        self.window.add(self.view)
        self.resize(width, height)
        self.window.show_all()
        self.downloaded = []

    # --- окно и загрузка ---

    def resize(self, width, height):
        self.view.set_size_request(width, height)
        self.window.resize(width, height)
        pump(0.05)

    def _on_load(self, _view, event):
        if event == WebKit2.LoadEvent.FINISHED:
            self.load_finished = True

    def open(self, url, ready='globalThis.umnozhayka?.currentName', timeout=15.0):
        self.load_finished = False
        self.view.load_uri(url)
        pump(until=lambda: self.load_finished, what='загрузка страницы')
        self.wait(ready, timeout)

    def reload(self):
        self.collect_errors()
        self.load_finished = False
        self.view.reload()
        pump(until=lambda: self.load_finished, what='перезагрузка')
        self.wait('globalThis.umnozhayka?.currentName')

    def close(self):
        self.collect_errors()
        self.window.destroy()
        pump(0.1)

    def _on_download(self, _context, download):
        def decide(dl, suggested):
            path = self.downloads / suggested
            dl.set_allow_overwrite(True)
            dl.set_destination(GLib.filename_to_uri(str(path)))
            return True

        download.connect('decide-destination', decide)
        download.connect('finished', lambda dl: self.downloaded.append(GLib.filename_from_uri(dl.get_destination())[0]))

    def _on_file_chooser(self, _view, request):
        files = [str(p) for p in self.files_to_choose]
        if files:
            request.select_files(files if request.get_select_multiple() else files[:1])
        else:
            request.cancel()
        return True

    # --- JavaScript ---

    def js(self, body, timeout=30.0):
        """Выполняет тело async-функции на странице и возвращает результат через JSON."""
        source = ('const __v = await (async () => {\n' + body + '\n})();\n'
                  'return JSON.stringify(__v === undefined ? null : __v);')
        box = {}

        def done(view, res):
            try:
                box['value'] = view.call_async_javascript_function_finish(res).to_string()
            except GLib.Error as err:
                box['error'] = err.message

        self.view.call_async_javascript_function(source, -1, None, None, None, None, done)
        pump(until=lambda: box, timeout=timeout, what='ответ JavaScript')
        if 'error' in box:
            raise RuntimeError(box['error'])
        return json.loads(box['value'])

    def ev(self, expression, timeout=30.0):
        return self.js(f'return ({expression});', timeout)

    def wait(self, expression, timeout=15.0):
        return self.js(f"""
          const end = Date.now() + {int(timeout * 1000)};
          for (;;) {{
            try {{ const v = await ({expression}); if (v) return v; }} catch (e) {{}}
            if (Date.now() > end) throw new Error('не дождались: ' + {json.dumps(expression)});
            await new Promise((r) => setTimeout(r, 40));
          }}""", timeout + 10)

    def collect_errors(self):
        try:
            self.errors += self.ev('globalThis.__e2eErrors?.splice(0) ?? []')
        except Exception:  # страница уже закрыта
            pass

    def screenshot(self, name, full=False):
        box = {}

        def done(view, res):
            try:
                box['surface'] = view.get_snapshot_finish(res)
            except GLib.Error as err:
                box['error'] = err.message

        region = WebKit2.SnapshotRegion.FULL_DOCUMENT if full else WebKit2.SnapshotRegion.VISIBLE
        self.view.get_snapshot(region, WebKit2.SnapshotOptions.NONE, None, done)
        pump(until=lambda: box, timeout=20, what='снимок экрана')
        if 'surface' in box:
            box['surface'].write_to_png(str(OUT / name))

    # --- настоящий ввод: события GDK ---

    def _send(self, event_type, **fields):
        event = Gdk.Event.new(event_type)
        event.window = self.view.get_window()
        event.send_event = 1
        event.time = Gtk.get_current_event_time() or int(time.monotonic() * 1000) & 0xFFFFFFFF
        for key, value in fields.items():
            setattr(event, key, value)
        seat = Gdk.Display.get_default().get_default_seat()
        device = seat.get_keyboard() if event_type in (Gdk.EventType.KEY_PRESS, Gdk.EventType.KEY_RELEASE) else seat.get_pointer()
        event.set_device(device)
        event.set_source_device(device)
        Gtk.main_do_event(event)

    def click_at(self, x, y):
        rx, ry = x, y  # окно вне экрана: его начало — в точке (0, 0)
        self._send(Gdk.EventType.MOTION_NOTIFY, x=float(x), y=float(y), x_root=float(rx), y_root=float(ry), state=0)
        self._send(Gdk.EventType.BUTTON_PRESS, x=float(x), y=float(y), x_root=float(rx), y_root=float(ry), button=1, state=0)
        self._send(Gdk.EventType.BUTTON_RELEASE, x=float(x), y=float(y), x_root=float(rx), y_root=float(ry), button=1,
                   state=Gdk.ModifierType.BUTTON1_MASK)
        pump(0.03)

    def tap(self, selector, index=0):
        box = self.js(f"""
          const el = [...document.querySelectorAll({json.dumps(selector)})].filter((x) => x.offsetParent !== null)[{index}];
          if (!el) return null;
          el.scrollIntoView({{ block: 'center' }});
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          const r = el.getBoundingClientRect();
          return {{ x: r.left + r.width / 2, y: r.top + r.height / 2 }};""")
        if not box:
            raise AssertionError(f'нет элемента {selector}[{index}]')
        self.click_at(box['x'], box['y'])

    def tap_text(self, text):
        found = self.js(f"""
          const els = [...document.querySelectorAll('button')].filter((x) => x.offsetParent !== null);
          const i = els.findIndex((b) => b.textContent.includes({json.dumps(text)}) && !b.disabled);
          els.forEach((b, k) => b.toggleAttribute('data-e2e', k === i));
          return i >= 0;""")
        if not found:
            raise AssertionError(f'нет кнопки «{text}»')
        self.tap('button[data-e2e]')

    def key(self, key):
        keyval = KEYVALS.get(key) or Gdk.unicode_to_keyval(ord(key))
        keymap = Gdk.Keymap.get_for_display(Gdk.Display.get_default())
        ok, entries = keymap.get_entries_for_keyval(keyval)
        code, group = (entries[0].keycode, entries[0].group) if ok and entries else (0, 0)
        for event_type in (Gdk.EventType.KEY_PRESS, Gdk.EventType.KEY_RELEASE):
            self._send(event_type, keyval=keyval, hardware_keycode=code, group=group, state=0)
        pump(0.02)

    def type(self, text):
        for ch in str(text):
            self.key(ch)


def mark_seen(d):
    # Отмечаем пример, на который уже ответили: элемент .expr создаётся заново для каждого задания.
    d.js("document.querySelector('.task .expr')?.setAttribute('data-e2e-seen', '')")


def pass_gate(d):
    d.wait("!!document.querySelector('.modal .expr')")
    pump(0.3)
    question = d.ev("document.querySelector('.modal .expr').textContent")
    a, b = map(int, re.search(r'(\d+) × (\d+)', question).groups())
    d.type(a * b)
    d.key('Enter')
    d.wait("umnozhayka.currentName === 'parent' && !document.querySelector('.modal') && !!document.querySelector('.card h2')")


def play_diagnostic(d, known_columns):
    d.tap_text('Начать')
    asked = 0
    for _ in range(300):
        st = d.ev(DESCRIBE)
        if st['kind'] == 'keypad' and not st['seen']:
            s = solve(st['expr'])
            asked += 1
            mark_seen(d)
            if s['a'] in known_columns or s['b'] in known_columns:
                if asked % 2:  # мышью по экранной клавиатуре
                    for digit in str(s['answer']):
                        d.tap('.keypad .key', 10 if digit == '0' else int(digit) - 1)
                    d.tap('.key--ok')
                else:  # с клавиатуры
                    d.type(s['answer'])
                    d.key('Enter')
            else:
                d.tap_text('Не знаю')
        elif d.ev("!!document.querySelector('.table-wrap .grid10')"):
            return asked
        pump(0.12)
    raise AssertionError('диагностика не закончилась')


def play_lesson(d, wrong_once=False, max_steps=500):
    log = []
    made_error = None
    shots = set()
    for i in range(max_steps):
        st = d.ev(DESCRIBE)
        if st['screen'] == 'summary':
            return log, made_error
        if st['timer']:
            raise AssertionError('в обычном занятии виден таймер')
        if st['kind'] not in shots and st['kind'] in ('choice', 'tf', 'keypad', 'correction', 'slides', 'newFact'):
            shots.add(st['kind'])
            d.screenshot(f'lesson-{st["kind"]}.png')
        if st['seen'] and st['kind'] in ('choice', 'tf', 'keypad'):
            pump(0.1)
            continue
        if st['kind'] == 'slides':
            if i % 2:
                d.key('ArrowRight')
            else:
                d.tap('.slides .btn--primary')
        elif st['kind'] == 'newFact':
            d.tap_text('Понятно')
        elif st['kind'] == 'choice':
            is_zero = (st.get('hint') or '').startswith('Правило нуля')
            fact = None if is_zero else solve(st['expr'])
            target = '0' if is_zero else str(fact['answer'])
            idx = st['options'].index(target)
            if wrong_once and not made_error and fact:
                idx = next(k for k, o in enumerate(st['options']) if o != target)
                made_error = f"{fact['a']}x{fact['b']}"
            if fact:
                log.append({'fact': f"{fact['a']}x{fact['b']}", 'format': 'choice', 'correct': st['options'][idx] == target})
            mark_seen(d)
            if i % 3 == 0:
                d.key(str(idx + 1))
            else:
                d.tap('.choice', idx)
        elif st['kind'] == 'tf':
            s = solve(st['expr'])
            log.append({'fact': f"{s['a']}x{s['b']}", 'format': 'tf', 'correct': True})
            mark_seen(d)
            if i % 2:
                d.key('1' if s['answer'] else '2')
            else:
                d.tap('.tf button', 0 if s['answer'] else 1)
        elif st['kind'] == 'keypad':
            s = solve(st['expr'])
            value = s['answer']
            if wrong_once and not made_error:
                value += 1
                made_error = f"{s['a']}x{s['b']}"
            log.append({'fact': f"{s['a']}x{s['b']}", 'format': 'missing' if s['kind'] == 'missing' else 'input',
                        'correct': value == s['answer']})
            mark_seen(d)
            if i % 2:
                d.type(value)
                d.key('Enter')
            else:
                for digit in str(value):
                    d.tap('.keypad .key', 10 if digit == '0' else int(digit) - 1)
                d.tap('.key--ok')
        elif st['kind'] == 'correction':
            if st['keypadOn']:
                product = re.search(r'= (\d+)', st['fact']).group(1)
                d.type(product)
                d.key('Enter')
                pump(0.3)
        elif st['kind'] == 'modal':
            raise AssertionError(f'неожиданное окно «{st["modal"]}»')
        pump(0.12)
    raise AssertionError('занятие не закончилось')


def profiles_json(d):
    return json.loads(d.ev('JSON.stringify(umnozhayka.profiles)'))


def open_parent_on_fresh_device(d):
    d.wait("umnozhayka.currentName === 'newProfile'")
    d.tap_text('Перенести прогресс')
    pass_gate(d)


def confirm_import(d, timeout=40):
    d.wait("document.querySelector('.modal h2')?.textContent === 'Перенос прогресса'", timeout)
    pump(0.3)
    d.tap_text('Перенести')
    d.wait('!document.querySelector(".modal") && umnozhayka.profiles.length > 0')
    pump(0.3)


def main():
    server = Server(ROOT)
    url = server.url
    devices = []
    state = {}
    qr_frames = []

    a = Device('device-a')
    devices.append(a)
    version = f'WebKitGTK {WebKit2.get_major_version()}.{WebKit2.get_minor_version()}.{WebKit2.get_micro_version()}'

    def first_run():
        a.open(url)
        check(a.ev('umnozhayka.currentName') == 'newProfile', 'ожидался экран нового ученика')
        check(a.ev("document.visibilityState") == 'visible', 'страница считается скрытой')
        a.screenshot('01-new-profile.png')
        a.tap('#child-name')
        a.type('Маша')
        typed = a.ev("document.querySelector('#child-name').value")
        a.tap('.avatar-option', 3)
        a.tap_text('Готово')
        a.wait("umnozhayka.currentName === 'diagnostic'")
        ua = a.ev('navigator.userAgent')
        engine = re.search(r'AppleWebKit/[\d.]+', ua).group(0)
        return f'{version}, {engine}; имя набрано с клавиатуры: «{typed}»'
    step('Первый запуск в WebKit: экран нового ученика, имя с клавиатуры', first_run)

    def diagnostic():
        a.screenshot('02-diagnostic-intro.png')
        asked = play_diagnostic(a, [1, 10, 2, 5])
        a.screenshot('03-diagnostic-result.png')
        p = profiles_json(a)[0]
        known = sum(1 for f in p['facts'].values() if f['introduced'] and f['streak'] >= 3)
        check(asked <= 20, f'спрошено {asked}')
        check((p.get('diagnostic') or {}).get('items') == asked, 'итог диагностики не записан')
        check(known >= 50, f'отмечено известных: {known}')
        a.tap_text('Начать учиться')
        a.wait("umnozhayka.currentName === 'home'")
        a.screenshot('04-home.png')
        return f'спрошено {asked}, отмечено известных {known}'
    step('Диагностика мышью и клавиатурой: ≤ 20 примеров, известные факты отмечены', diagnostic)

    def lesson():
        a.tap_text('Начать занятие')
        a.wait("umnozhayka.currentName === 'lesson'")
        pump(0.3)
        log, made_error = play_lesson(a, wrong_once=True)
        a.screenshot('06-summary.png')
        formats = {x['format'] for x in log}
        err_idx = next(k for k, x in enumerate(log) if not x['correct'])
        back = next(k for k, x in enumerate(log) if k > err_idx and x['fact'] == made_error)
        gap = back - err_idx - 1
        check(20 <= len(log) <= 24, f'заданий: {len(log)}')
        check(len(formats) >= 3, f'форматы: {formats}')
        check(2 <= gap <= 3, f'ошибка {made_error} вернулась через {gap}')
        lesson_rec = next(s for s in profiles_json(a)[0]['sessions'] if s['type'] == 'lesson')
        check(lesson_rec['stars'] >= 1, 'занятие не записано')
        return f'заданий {len(log)}, форматы: {", ".join(sorted(formats))}, ошибка вернулась через {gap}, звёзд {lesson_rec["stars"]}'
    step('Занятие: 20 заданий, форматы чередуются, ошибка разобрана и вернулась через 2–3', lesson)

    def persist():
        before = canonical(profiles_json(a))
        a.reload()
        a.wait("umnozhayka.currentName === 'home'")
        after = canonical(profiles_json(a))
        check(before == after, 'данные после перезагрузки отличаются')
        return f'IndexedDB: профиль совпал байт в байт ({len(before)} символов JSON)'
    step('Прогресс сохраняется после перезагрузки', persist)

    def grid():
        a.tap_text('Мой прогресс')
        a.wait("document.querySelectorAll('.grid10 .cell').length === 100")
        a.tap('.cell', 4)
        a.wait("!!document.querySelector('.fact-detail dl, .fact-detail p')")
        a.screenshot('07-progress.png', full=True)
        colors = a.ev("new Set([...document.querySelectorAll('.grid10 .cell')].map((c) => getComputedStyle(c).backgroundColor)).size")
        check(colors >= 2, 'клетки одного цвета')
        a.key('ArrowRight')
        sel = a.ev("""document.querySelector('.cell[aria-selected="true"]').getAttribute('aria-label')""")
        check(re.search(r'1 × 6', sel), f'стрелка не сработала: {sel}')
        return f'{colors} цвета статусов, стрелкой → «{sel}»'
    step('Сетка 10 × 10: цвет по статусу, подробности по щелчку, стрелки', grid)

    def blitz():
        a.ev("umnozhayka.go('home')")
        a.tap_text('Блиц 60 секунд')
        a.wait("umnozhayka.currentName === 'blitz'")
        a.tap_text('Старт')
        a.wait("!!document.querySelector('.timer')", 5)
        mastered = set(a.ev("Object.entries(umnozhayka.profile.facts).filter(([, f]) => f.introduced && f.streak >= 3).map(([id]) => id)"))
        answered = 0
        seen = set()
        t0 = time.monotonic()
        while time.monotonic() - t0 < 80:
            st = a.ev(DESCRIBE)
            if st['screen'] == 'summary':
                break
            if st['kind'] == 'keypad' and not st['seen']:
                s = solve(st['expr'])
                seen.add(f"{s['a']}x{s['b']}")
                mark_seen(a)
                a.type(s['answer'])
                a.key('Enter')
                answered += 1
                if answered == 3:
                    a.screenshot('12-blitz.png')
            pump(0.1)
        secs = time.monotonic() - t0
        if a.ev('umnozhayka.currentName') != 'summary':
            a.screenshot('12-blitz-stuck.png')
            info = a.ev("({ timer: document.querySelector('.timer__sec')?.textContent, vis: document.visibilityState })")
            raise AssertionError(f'блиц не закончился: ответов {answered}, на таймере {info["timer"]}, '
                                 f'страница {info["vis"]}, последнее состояние {st}')
        # Нажатия в последний момент не уводят с итогов: кнопки оживают через 0,7 с.
        a.key('Enter')
        a.tap_text('На главную')
        pump(0.15)
        check(a.ev('umnozhayka.currentName') == 'summary', 'случайное нажатие увело с экрана итогов')
        check(55 < secs < 72, f'длительность {secs:.1f} с')
        check(seen <= mastered, f'неосвоенные факты в блице: {seen - mastered}')
        return f'ответов {answered} за {secs:.0f} с, все — освоенные факты'
    step('Блиц: видимый таймер, 60 секунд, только освоенные факты', blitz)

    def offline():
        a.wait('!!navigator.serviceWorker.controller', 20)
        a.wait("caches.keys().then((k) => k.some((x) => x.startsWith('umnozhayka-')))", 20)
        cached = a.js("const k = await caches.keys(); return (await (await caches.open(k.find((x) => x.startsWith('umnozhayka-')))).keys()).length;")
        server.offline = True
        hits = server.hits
        try:
            a.reload()
            a.wait("umnozhayka.currentName === 'home'", 15)
            a.tap_text('Начать занятие')
            a.wait("umnozhayka.currentName === 'lesson'")
            pump(0.4)
            a.screenshot('08-offline-lesson.png')
            a.key('Escape')
            a.wait("!!document.querySelector('.modal')")
            pump(0.3)
            a.tap_text('Закончить')
            a.wait("['home', 'summary'].includes(umnozhayka.currentName)")
            attempts = server.hits - hits
        finally:
            server.offline = False
        check(attempts == 0, f'запросы к серверу без сети: {attempts}')
        return f'service worker: в кэше {cached} файлов, без сети — 0 запросов'
    step('Работает в режиме полёта после первой загрузки (service worker)', offline)

    def install():
        info = a.js("""
          const m = await (await fetch('manifest.webmanifest')).json();
          const size = (src) => new Promise((res) => { const i = new Image(); i.onload = () => res(i.naturalWidth + 'x' + i.naturalHeight); i.onerror = () => res('ошибка'); i.src = src; });
          const icons = await Promise.all(m.icons.map(async (i) => ({ sizes: i.sizes, purpose: i.purpose ?? 'any', real: await size(i.src) })));
          const apple = document.querySelector('link[rel="apple-touch-icon"]');
          return { display: m.display, start: m.start_url, icons, apple: await size(apple.href),
                   capable: document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.content };""")
        for icon in info['icons']:
            check(icon['real'] == icon['sizes'], f"иконка {icon['sizes']}: на деле {icon['real']}")
        check(info['display'] == 'standalone', f"display: {info['display']}")
        check(info['apple'] == '180x180', f"apple-touch-icon: {info['apple']}")
        return f"display {info['display']}, иконки {', '.join(i['real'] + ' ' + i['purpose'] for i in info['icons'])}, apple-touch-icon {info['apple']}"
    step('Установка на экран «Домой»: манифест и иконки читаются в WebKit', install)

    state['source'] = profiles_json(a)

    def by_code():
        a.ev("umnozhayka.go('parent')")
        pass_gate(a)
        a.screenshot('09-parent.png', full=True)
        a.tap_text('Показать код')
        a.wait("!!document.querySelector('.modal textarea')")
        code = a.ev("document.querySelector('.modal textarea').value")
        a.tap_text('Готово')
        b = Device('device-b-code')
        devices.append(b)
        b.open(url)
        open_parent_on_fresh_device(b)
        b.tap_text('Ввести код')
        b.wait("!!document.querySelector('.modal textarea')")
        wrapped = re.sub(r'(.{60})', r'\1\n', code)
        b.js(f"const t = document.querySelector('.modal textarea'); t.value = {json.dumps(wrapped)}; t.dispatchEvent(new Event('input', {{ bubbles: true }}));")
        b.tap_text('Проверить')
        confirm_import(b)
        check(canonical(profiles_json(b)) == canonical(state['source']), 'данные отличаются')
        b.close()
        return f'код {len(code)} символов, профиль совпал байт в байт'
    step('Перенос кодом Base64 на второе устройство без потерь', by_code)

    def by_file():
        a.tap_text('Сохранить в файл')
        a.wait("!!document.querySelector('.modal')")
        pump(0.3)
        a.tap_text('Скачать файл')
        pump(until=lambda: a.downloaded, timeout=15, what='скачивание файла')
        path = pathlib.Path(a.downloaded[-1])
        a.tap_text('Готово')
        b = Device('device-b-file')
        devices.append(b)
        b.open(url)
        open_parent_on_fresh_device(b)
        b.files_to_choose = [path]
        b.tap_text('Загрузить файл')
        confirm_import(b)
        check(canonical(profiles_json(b)) == canonical(state['source']), 'данные отличаются')
        b.close()
        return f'{path.name}, {path.stat().st_size} байт: скачан и загружен через выбор файла'
    step('Перенос JSON-файлом без потерь', by_file)

    def by_qr_photo():
        a.tap_text('Показать QR')
        a.wait("!!document.querySelector('.modal .qr-canvas')")
        pump(0.3)
        total = a.ev("document.querySelectorAll('.modal .qr-parts li').length || 1")
        a.screenshot('10-qr.png')
        if total > 1:
            try:
                a.tap_text('Листать сами')
            except AssertionError:
                a.tap_text('Пауза')
        for i in range(total):
            png = a.ev("document.querySelector('.modal .qr-canvas').toDataURL('image/png')")
            path = OUT / f'qr-part-{i + 1:02d}.png'
            path.write_bytes(__import__('base64').b64decode(png.split(',', 1)[1]))
            qr_frames.append(path)
            if total > 1:
                a.tap('button[aria-label="Следующий код"]')
            pump(0.12)
        a.tap_text('Готово')
        b = Device('device-b-photo')
        devices.append(b)
        b.open(url)
        open_parent_on_fresh_device(b)
        b.files_to_choose = qr_frames
        b.tap_text('QR с фото')
        confirm_import(b, 60)
        check(canonical(profiles_json(b)) == canonical(state['source']), 'данные отличаются')
        b.close()
        return f'{total} QR-кодов распознаны встроенным декодером в Web Worker'
    step('Перенос через QR с фото без потерь', by_qr_photo)

    def by_qr_camera():
        check(qr_frames, 'нет QR-кадров из предыдущего шага')
        b = Device('device-b-camera')
        devices.append(b)
        b.open(url)
        # Сначала — умеет ли этот WebKitGTK вообще показывать видеопоток (ему нужны модули GStreamer).
        plays = b.js("""
          if (typeof HTMLCanvasElement.prototype.captureStream !== 'function' || !navigator.mediaDevices) return false;
          const c = document.createElement('canvas'); c.width = 64; c.height = 48;
          const g = c.getContext('2d'); const t = setInterval(() => g.fillRect(0, 0, 64, 48), 50);
          const v = document.createElement('video'); v.muted = true; v.srcObject = c.captureStream(15);
          const ok = await Promise.race([v.play().then(() => true, () => false), new Promise((r) => setTimeout(() => r(false), 3000))]);
          clearInterval(t); v.srcObject = null;
          return ok && v.videoWidth > 0;""")
        if not plays:
            b.close()
            raise Skip('в этой сборке WebKitGTK видеопоток MediaStream не воспроизводится даже из простого canvas '
                       '(нет модулей GStreamer, например gstreamer1.0-plugins-bad); путь камеры проверен в Chrome')
        frames = [f'data:image/png;base64,{__import__("base64").b64encode(p.read_bytes()).decode()}' for p in qr_frames]
        # «Камера» снимает экран другого телефона: код меньше кадра, на сером фоне, чуть повёрнут и размыт.
        b.js(f"""
          const imgs = await Promise.all({json.dumps(frames)}.map((src) => new Promise((res) => {{ const i = new Image(); i.onload = () => res(i); i.src = src; }})));
          const c = document.createElement('canvas'); c.width = 1280; c.height = 720;
          const g = c.getContext('2d');
          const t0 = performance.now();
          const draw = () => {{
            const k = Math.floor((performance.now() - t0) / 700) % imgs.length;
            g.fillStyle = '#8a8a8a'; g.fillRect(0, 0, c.width, c.height);
            g.save(); g.translate(640, 360); g.rotate(0.12); g.filter = 'blur(1px)';
            g.drawImage(imgs[k], -260, -260, 520, 520); g.restore();
          }};
          draw(); setInterval(draw, 60);
          const stream = c.captureStream(15);
          navigator.mediaDevices.getUserMedia = async () => stream;
          return true;""")
        open_parent_on_fresh_device(b)
        b.tap_text('Сканировать QR')
        b.wait("!!document.querySelector('.scanner video')?.videoWidth", 15)
        pump(1.5)
        b.screenshot('11-scanner.png')
        confirm_import(b, 90)
        check(canonical(profiles_json(b)) == canonical(state['source']), 'данные отличаются')
        b.close()
        return f'видео из {len(qr_frames)} QR-кадров считано через getUserMedia → video → canvas → Worker'
    step('Перенос через QR с камеры второго устройства', by_qr_camera)

    def layout():
        bad = []
        for w, h in ((320, 640), (390, 844), (768, 1024), (1366, 768), (1920, 1080)):
            a.resize(w, h)
            a.wait(f'innerWidth === {w}')
            for screen in ('home', 'progress', 'parent'):
                arg = ", { unlocked: true }" if screen == 'parent' else ''
                a.ev(f"umnozhayka.go('{screen}'{arg})")
                pump(0.4)
                over = a.ev('document.documentElement.scrollWidth - document.documentElement.clientWidth')
                if over > 0:
                    bad.append(f'{screen}@{w}: +{over}px')
                a.screenshot(f'w{w}-{screen}.png')
        a.resize(390, 844)
        check(not bad, '; '.join(bad))
        return 'главная, прогресс, родительский экран на 320, 390, 768, 1366, 1920 px'
    step('Вёрстка 320–1920 px без горизонтальной прокрутки', layout)

    def selftest():
        a.collect_errors()
        a.open(url + 'selftest.html', ready="document.body.dataset.done === '1'", timeout=60)
        r = json.loads(a.ev('JSON.stringify(window.selftest)'))
        a.screenshot('16-selftest.png', full=True)
        failed = [f"{i['title']}: {i['detail']}" for i in r['items'] if i['status'] == 'fail']
        check(not failed, '; '.join(failed))
        warned = [i['title'] for i in r['items'] if i['status'] == 'warn']
        return f"{r['total']} проверок, с замечаниями — {', '.join(warned) or 'нет'}"
    step('Страница самопроверки: все автоматические проверки пройдены', selftest)

    def no_errors():
        for d in devices:
            d.collect_errors()
        errors = [f'{d.name}: {e}' for d in devices for e in d.errors]
        check(not errors, ' | '.join(errors))
        return f'{len(devices)} устройства, {server.hits} запросов к серверу за проверку'
    step('Нет ошибок JavaScript', no_errors)

    server.httpd.shutdown()
    ok = results.count(True)
    run = len(results) - results.count(None)
    skipped = f', пропущено {results.count(None)}' if None in results else ''
    print(f'\nИтого: {ok} из {run} проверок пройдено{skipped} ({version}). Скриншоты: {OUT}')
    sys.exit(0 if ok == run else 1)


if __name__ == '__main__':
    main()
