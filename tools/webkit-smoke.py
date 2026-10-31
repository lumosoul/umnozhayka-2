#!/usr/bin/env python3
"""Дымовая проверка «Умножайки» в WebKit — движке Safari — с эмуляцией iPhone (через Playwright).

Подготовка (один раз, только для проверки — приложению Playwright не нужен):
    python3 -m pip install playwright
    python3 -m playwright install webkit
    # Linux: системные библиотеки для WebKit
    sudo apt-get install libevent-2.1-7t64 libgstreamer-plugins-bad1.0-0

Запуск:
    python3 tools/webkit-smoke.py                    # WebKit, iPhone 13
    python3 tools/webkit-smoke.py --browser msedge   # установленный Microsoft Edge
    python3 tools/webkit-smoke.py --browser chrome   # установленный Google Chrome
"""

import argparse
import functools
import http.server
import pathlib
import re
import sys
import tempfile
import threading

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript',
        '.mjs': 'text/javascript',
        '.webmanifest': 'application/manifest+json',
        '.svg': 'image/svg+xml',
    }

    def log_message(self, *args):  # тихо
        pass


def serve():
    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(ROOT)))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--browser', default='webkit', choices=['webkit', 'chrome', 'msedge'])
    parser.add_argument('--out', default=tempfile.mkdtemp(prefix='umnozhayka-webkit-'))
    args = parser.parse_args()
    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    httpd = serve()
    url = f'http://127.0.0.1:{httpd.server_address[1]}/'
    results = []

    def step(name, fn):
        try:
            note = fn()
            results.append(True)
            print(f'✓ {name}' + (f' — {note}' if note else ''))
        except Exception as err:  # отчёт по каждому шагу, проверка идёт дальше
            results.append(False)
            print(f'✗ {name}: {err}')

    with sync_playwright() as p:
        if args.browser == 'webkit':
            browser = p.webkit.launch()
            context = browser.new_context(**p.devices['iPhone 13'])
        else:
            browser = p.chromium.launch(channel=args.browser)
            context = browser.new_context(viewport={'width': 390, 'height': 844}, has_touch=True, is_mobile=True)
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        label = f'{args.browser} {browser.version}'

        def wait(js, timeout=10000):
            page.wait_for_function(js, timeout=timeout)

        def tap_text(text):
            page.locator('button:visible', has_text=text).first.tap()

        def first_screen():
            page.goto(url)
            wait("globalThis.umnozhayka?.currentName === 'newProfile'")
            page.screenshot(path=str(out / 'wk-01-new-profile.png'))
            return label
        step('Приложение загружается, первый экран — новый ученик', first_screen)

        def diagnostic():
            page.locator('.avatar-option').nth(2).tap()
            tap_text('Готово')  # имя можно не писать
            wait("umnozhayka.currentName === 'diagnostic'")
            tap_text('Начать')
            for i in range(3):
                wait("!!document.querySelector('.task .expr') && !document.querySelector('.feedback')")
                expr = page.locator('.task .expr').inner_text()
                a, b = map(int, re.search(r'(\d+)\s*×\s*(\d+)', expr).groups())
                answer = str(a * b)
                if i == 0:  # касаниями по экранной клавиатуре
                    for d in answer:
                        page.locator('.keypad .key').nth(9 if d == '0' else int(d) - 1).tap()
                    page.locator('.key--ok').tap()
                else:  # с клавиатуры
                    page.keyboard.type(answer)
                    page.keyboard.press('Enter')
                wait("!!document.querySelector('.feedback--good')")
            page.screenshot(path=str(out / 'wk-02-diagnostic.png'))
            name = page.evaluate('umnozhayka.profile.name')
            return f'профиль «{name}», три ответа приняты'
        step('Профиль без имени, диагностика касанием и клавиатурой', diagnostic)

        def resume():
            page.evaluate('umnozhayka.saveProfile().then(() => true)')
            page.reload()
            wait("umnozhayka.currentName === 'diagnostic'")
            saved = page.evaluate('umnozhayka.profiles[0].diagnosticDraft?.answers?.length ?? 0')
            if saved < 3:
                raise AssertionError(f'сохранено ответов: {saved}')
            tap_text('Продолжить')
            wait(f"document.querySelector('h1').textContent.includes('{saved + 1} из 20')")
            return f'IndexedDB: {saved} ответа, продолжаем с {saved + 1}-го'
        step('После перезагрузки диагностика продолжается (IndexedDB)', resume)

        def offline():
            has_sw = page.evaluate("'serviceWorker' in navigator")
            if not has_sw:
                return 'в этой сборке нет service worker — пропущено'
            page.evaluate('navigator.serviceWorker.ready.then(() => true)')
            wait("caches.keys().then((k) => k.some((x) => x.startsWith('umnozhayka@')))", 20000)
            if not page.evaluate('!!navigator.serviceWorker.controller'):
                page.reload()
                wait('!!navigator.serviceWorker.controller', 15000)
            context.set_offline(True)
            page.reload()
            wait('!!globalThis.umnozhayka?.currentName', 15000)
            context.set_offline(False)
            return 'перезагрузка без сети прошла'
        step('Работает без сети после первой загрузки', offline)

        def narrow():
            page.set_viewport_size({'width': 320, 'height': 640})
            page.evaluate("umnozhayka.go('profiles')")
            page.wait_for_timeout(300)
            over = page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
            page.screenshot(path=str(out / 'wk-03-w320.png'))
            if over > 0:
                raise AssertionError(f'горизонтальная прокрутка +{over}px')
        step('Ширина 320 px без горизонтальной прокрутки', narrow)

        step('Нет ошибок JavaScript', lambda: (_ for _ in ()).throw(AssertionError('; '.join(errors))) if errors else None)
        browser.close()

    httpd.shutdown()
    ok = sum(results)
    print(f'\nИтого: {ok} из {len(results)} ({label}). Скриншоты: {out}')
    sys.exit(0 if ok == len(results) else 1)


if __name__ == '__main__':
    main()
