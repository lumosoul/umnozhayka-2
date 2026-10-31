#!/usr/bin/env python3
"""Генератор фикстур для tests/qr.test.js.

Эталоны независимы от нашего кода: матрицы строит segno, изображения
растеризуются через numpy/OpenCV. Запуск (нужны segno, numpy, opencv-python):

    python tools/make-qr-fixtures.py

Результат:
  tests/fixtures/qr-segno-tables.json    — таблицы блоков, выравнивания, ёмкостей, BCH;
  tests/fixtures/qr-segno-matrices.json  — матрицы (версия, уровень, маска, режим заданы явно);
  tests/fixtures/qr-segno-images.json    — серые изображения (PNG в base64) с искажениями.
"""
import base64
import json
import math
import os
import random

import cv2
import numpy as np
import segno
from segno import consts
from segno import encoder as segno_encoder

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, 'tests', 'fixtures')

ECL = {'L': consts.ERROR_LEVEL_L, 'M': consts.ERROR_LEVEL_M,
       'Q': consts.ERROR_LEVEL_Q, 'H': consts.ERROR_LEVEL_H}
MODE = {'numeric': consts.MODE_NUMERIC, 'alphanumeric': consts.MODE_ALPHANUMERIC,
        'byte': consts.MODE_BYTE}
ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:'
CYR = 'абвгдеёжзийклмнопрстуфхцчшщъыьэюяАБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ'
LATIN = 'abcdefghijklmnopqrstuvwxyz0123456789 .,!?-'


def _standard_padding_bits(buff, version, length):
    # segno 1.6.6 при потоке, уже выровненном на байт после терминатора, дописывает
    # лишний нулевой байт перед 0xEC/0x11 (ISO/IEC 18004 §7.4.10 требует добивать
    # нулями только до границы байта). Чиним только это место, чтобы эталон
    # соответствовал стандарту; остальной конвейер segno не трогаем.
    if version not in (consts.VERSION_M1, consts.VERSION_M3):
        buff.extend([0] * ((8 - (length % 8)) % 8))


segno_encoder.write_padding_bits = _standard_padding_bits


def b64(data):
    return base64.b64encode(bytes(data)).decode('ascii')


def pack_matrix(matrix):
    bits = np.array([list(row) for row in matrix], dtype=np.uint8).flatten()
    return b64(np.packbits(bits))


def segno_char_capacity(version, ecl, mode):
    """Максимальная длина сегмента по собственной логике segno (двоичный поиск)."""
    def fits(n):
        content = {'numeric': '1' * n, 'alphanumeric': 'A' * n, 'byte': b'a' * n}[mode]
        segs = segno_encoder.prepare_data(content, MODE[mode], None)
        return consts.SYMBOL_CAPACITY[version][ECL[ecl]] >= segs.bit_length_with_overhead(version, False)
    lo, hi = 0, 8000
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if fits(mid):
            lo = mid
        else:
            hi = mid - 1
    return lo


def make_tables():
    tables = {'ecc': {}, 'alignment': {}, 'capacityBits': {}, 'charCapacity': {},
              'formatInfo': list(consts.FORMAT_INFO), 'versionInfo': list(consts.VERSION_INFO)}
    for v in range(1, 41):
        tables['ecc'][v] = {e: [list(ec) for ec in consts.ECC[v][ECL[e]]] for e in ECL}
        tables['alignment'][v] = list(consts.ALIGNMENT_POS[v - 2]) if v >= 2 else []
        tables['capacityBits'][v] = {e: consts.SYMBOL_CAPACITY[v][ECL[e]] for e in ECL}
        tables['charCapacity'][v] = {e: {m: segno_char_capacity(v, e, m) for m in MODE} for e in ECL}
    return tables


def random_text(rng, mode, max_units):
    """Строка, которая в данном режиме занимает не больше max_units символов/байтов."""
    if mode == 'numeric':
        return ''.join(rng.choice('0123456789') for _ in range(max_units))
    if mode == 'alphanumeric':
        return ''.join(rng.choice(ALNUM) for _ in range(max_units))
    out = []
    used = 0
    while True:
        ch = rng.choice(CYR) if rng.random() < 0.6 else rng.choice(LATIN)
        n = len(ch.encode('utf-8'))
        if used + n > max_units:
            break
        out.append(ch)
        used += n
    return ''.join(out)


def segno_make(text, version, ecl, mode, mask):
    content = text.encode('utf-8') if mode == 'byte' else text
    qr = segno.make(content, error=ecl, version=version, mode=mode, mask=mask,
                    boost_error=False, micro=False)
    assert qr.version == version and qr.error == ecl and qr.mode == mode, (qr.version, qr.error, qr.mode)
    return qr


def make_matrices(tables):
    rng = random.Random(20261031)
    modes = ['numeric', 'alphanumeric', 'byte']
    cases = []
    versions = list(range(1, 26)) + [27, 30, 33, 36, 40]
    for v in versions:
        for ei, ecl in enumerate('LMQH'):
            mode = modes[(v + ei) % 3]
            mask_choice = (v * 4 + ei) % 9  # 8 — автоматический выбор маски segno
            mask = None if mask_choice == 8 else mask_choice
            cap = tables['charCapacity'][v][ecl][mode]
            # Чередуем полную ёмкость, почти полную и случайную длину.
            kind = (v + 2 * ei) % 4
            if kind == 0:
                n = cap
            elif kind == 1:
                n = max(1, cap - rng.randint(1, 5))
            else:
                n = rng.randint(1, cap)
            text = random_text(rng, mode, n)
            qr = segno_make(text, v, ecl, mode, mask)
            cases.append({'text': text, 'version': v, 'ecl': ecl, 'mode': mode,
                          'mask': qr.mask, 'autoMask': mask is None,
                          'size': len(qr.matrix), 'bits': pack_matrix(qr.matrix)})
    # Дополнительно: автоматический выбор маски на небольших версиях и граничные строки.
    extra = [('HELLO WORLD', 1, 'M', 'alphanumeric'), ('01234567', 1, 'H', 'numeric'),
             ('Привет, мир!', 2, 'M', 'byte'), ('UM1:K3ZQ:2:7:', 1, 'L', 'alphanumeric')]
    for i in range(36):
        v = 1 + i % 9
        ecl = 'LMQH'[i % 4]
        mode = modes[i % 3]
        n = rng.randint(1, tables['charCapacity'][v][ecl][mode])
        extra.append((random_text(rng, mode, n), v, ecl, mode))
    for text, v, ecl, mode in extra:
        qr = segno_make(text, v, ecl, mode, None)
        cases.append({'text': text, 'version': v, 'ecl': ecl, 'mode': mode, 'mask': qr.mask,
                      'autoMask': True, 'size': len(qr.matrix), 'bits': pack_matrix(qr.matrix)})
    # Кандзи — для проверки, что декодер аккуратно обрабатывает этот режим.
    kanji = segno.make('漢字テスト', error='M', version=2, mode='kanji', mask=3,
                       boost_error=False, micro=False)
    cases.append({'text': '漢字テスト', 'version': 2, 'ecl': 'M', 'mode': 'kanji', 'mask': 3,
                  'autoMask': False, 'size': len(kanji.matrix), 'bits': pack_matrix(kanji.matrix)})
    return cases


# --- Изображения ---

def base45(data):
    out = []
    for i in range(0, len(data) - 1, 2):
        x = data[i] * 256 + data[i + 1]
        x, c = divmod(x, 45)
        e, d = divmod(x, 45)
        out += [ALNUM[c], ALNUM[d], ALNUM[e]]
    if len(data) % 2:
        d, c = divmod(data[-1], 45)
        out += [ALNUM[c], ALNUM[d]]
    return ''.join(out)


def um_text(rng, length):
    head = 'UM1:%s:%d:%d:' % (''.join(rng.choice(ALNUM[10:36]) for _ in range(4)),
                              rng.randint(1, 9), rng.randint(1, 30))
    raw = bytes(rng.randrange(256) for _ in range((length - len(head)) * 2 // 3 + 1))
    return (head + base45(raw))[:length]


def render(matrix, out_w, out_h, module_px, angle_deg, persp, center, blur, noise, dark, light,
           gradient, mirror, seed):
    """Растеризация через cv2.warpPerspective с суперсэмплингом 4× и INTER_AREA."""
    rng = np.random.default_rng(seed)
    m = np.array([list(row) for row in matrix], dtype=np.uint8)
    quiet = 4
    m = np.pad(m, quiet)
    n = m.shape[0]
    big_scale = 8
    src = np.where(np.kron(m, np.ones((big_scale, big_scale), dtype=np.uint8)) > 0, 0, 255).astype(np.uint8)
    if mirror:
        src = src[:, ::-1].copy()
    side = n * big_scale
    ss = 4
    # Углы символа в итоговом кадре: поворот + независимые смещения углов (перспектива).
    half = n * module_px / 2
    a = math.radians(angle_deg)
    corners = []
    for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
        x, y = sx * half, sy * half
        jx, jy = rng.uniform(-persp, persp, 2) * half
        corners.append((center[0] + (x + jx) * math.cos(a) - (y + jy) * math.sin(a),
                        center[1] + (x + jx) * math.sin(a) + (y + jy) * math.cos(a)))
    src_pts = np.float32([[0, 0], [side, 0], [side, side], [0, side]])
    dst_pts = np.float32(corners) * ss
    hmat = cv2.getPerspectiveTransform(src_pts, dst_pts)
    canvas = cv2.warpPerspective(src, hmat, (out_w * ss, out_h * ss), flags=cv2.INTER_LINEAR,
                                 borderMode=cv2.BORDER_CONSTANT, borderValue=200)
    img = cv2.resize(canvas, (out_w, out_h), interpolation=cv2.INTER_AREA).astype(np.float64)
    img = dark + (img / 255.0) * (light - dark)
    if gradient:
        yy, xx = np.mgrid[0:out_h, 0:out_w]
        img *= 0.55 + 0.45 * (xx / out_w * 0.6 + yy / out_h * 0.4)
    if blur > 0:
        img = cv2.GaussianBlur(img, (0, 0), blur)
    if noise > 0:
        img += rng.normal(0, noise, img.shape)
    return np.clip(np.rint(img), 0, 255).astype(np.uint8)


def make_images():
    rng = random.Random(4545)
    specs = [
        # (текст, уровень, режим, px/модуль, угол, перспектива, размытие, шум, градиент, зеркало);
        # версию (минимальную подходящую) выбирает segno, кадр подбирается под повёрнутый символ.
        (um_text(rng, 300), 'M', 'alphanumeric', 4.0, 0, 0.0, 0.0, 0, False, False),
        (um_text(rng, 420), 'M', 'alphanumeric', 3.6, 17, 0.0, 0.7, 0, False, False),
        (um_text(rng, 500), 'M', 'alphanumeric', 3.8, -128, 0.06, 0.8, 0, True, False),
        (um_text(rng, 620), 'M', 'alphanumeric', 4.3, 63, 0.07, 1.0, 0, False, False),
        (um_text(rng, 310), 'M', 'alphanumeric', 3.4, 205, 0.04, 0.6, 0, False, False),
        (um_text(rng, 900), 'M', 'alphanumeric', 3.7, 9, 0.05, 0.7, 0, False, False),
        (um_text(rng, 330), 'M', 'alphanumeric', 3.5, 0, 0.0, 0.6, 0, False, True),
        ('Умножайка: 7 × 8 = 56', 'Q', 'byte', 6.0, 33, 0.05, 1.0, 0, False, False),
        ('31415926535897932384626433832795028841971693993751', 'H', 'numeric',
         5.5, 271, 0.03, 0.7, 0, False, False),
        ('HELLO WORLD', 'M', 'alphanumeric', 5.0, 300, 0.0, 0.5, 6, False, False),
        (um_text(rng, 1400), 'M', 'alphanumeric', 3.6, -21, 0.03, 0.6, 0, False, False),
    ]
    images = []
    for i, (text, ecl, mode, px, ang, persp, blur, noise, grad, mirror) in enumerate(specs):
        content = text.encode('utf-8') if mode == 'byte' else text
        qr = segno.make(content, error=ecl, mode=mode, boost_error=False, micro=False)
        v = qr.version
        # Габарит повёрнутого символа с тихой зоной плюс запас на перспективу и сдвиг.
        span = (len(qr.matrix) + 8) * px
        a = math.radians(ang)
        extent = span * (abs(math.cos(a)) + abs(math.sin(a))) * (1 + 2 * persp)
        w = int(extent + 24 + rng.uniform(0, 60))
        h = int(extent + 24 + rng.uniform(0, 40))
        center = (w / 2 + rng.uniform(-8, 8), h / 2 + rng.uniform(-8, 8))
        img = render(qr.matrix, w, h, px, ang, persp, center, blur, noise, 35, 215, grad, mirror, 1000 + i)
        # Независимая проверка декодерами OpenCV (классическим и на основе ArUco).
        cv_ok = any(det.detectAndDecode(img)[0] == text
                    for det in (cv2.QRCodeDetector(), cv2.QRCodeDetectorAruco()))
        ok, png = cv2.imencode('.png', img, [cv2.IMWRITE_PNG_COMPRESSION, 9])
        assert ok
        images.append({'text': text, 'version': v, 'ecl': ecl, 'width': w, 'height': h,
                       'moduleSize': px, 'angle': ang, 'perspective': persp, 'blur': blur,
                       'noise': noise, 'gradient': grad, 'mirror': mirror,
                       'opencv': cv_ok, 'png': b64(png.tobytes())})
    print(f'OpenCV прочитал {sum(im["opencv"] for im in images)} из {len(images)} изображений')
    return images


def write_json(name, payload):
    path = os.path.join(OUT_DIR, name)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, separators=(',', ':'))
    print(f'{name}: {os.path.getsize(path) // 1024} КБ')


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    tables = make_tables()
    write_json('qr-segno-tables.json', {'generator': f'segno {segno.__version__}', **tables})
    write_json('qr-segno-matrices.json', {'generator': f'segno {segno.__version__}',
                                          'cases': make_matrices(tables)})
    write_json('qr-segno-images.json', {'generator': f'segno {segno.__version__}, OpenCV {cv2.__version__}',
                                        'images': make_images()})


if __name__ == '__main__':
    main()
