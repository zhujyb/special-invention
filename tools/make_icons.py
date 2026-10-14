#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""纯标准库生成桌宠 PWA 图标（不依赖 Pillow，不联网）。

- PNG 编码：手写 IHDR / IDAT / IEND（zlib + struct，8bit RGBA）
- 绘图：每个像素按「有符号距离场」解析求覆盖率，天然抗锯齿（无需超采样）
- 输出：icons/icon-{192,512,512-maskable,180}.png

运行： python tools/make_icons.py
"""

import math
import os
import struct
import zlib

# ---------------------------------------------------------------- 配色
ORANGE = (245, 166, 35)
OUTLINE = (168, 92, 12)
DEEP = (214, 126, 17)
BLUSH = (255, 154, 158)
MUZZLE = (255, 247, 235)
INK = (59, 42, 26)
WHITE = (255, 255, 255)
NOSE = (255, 124, 124)
MOUTH = (122, 90, 58)
CREAM = (253, 246, 227)


def clamp(v, lo, hi):
    return lo if v < lo else (hi if v > hi else v)


def seg_dist(px, py, x1, y1, x2, y2):
    """点到线段的距离。"""
    dx, dy = x2 - x1, y2 - y1
    l2 = dx * dx + dy * dy
    if l2 <= 1e-12:
        return math.hypot(px - x1, py - y1)
    t = clamp(((px - x1) * dx + (py - y1) * dy) / l2, 0.0, 1.0)
    return math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))


def ell_dist(px, py, cx, cy, rx, ry):
    """点到椭圆边界的近似有符号距离（内部为负）。"""
    ex, ey = (px - cx) / rx, (py - cy) / ry
    k = math.hypot(ex, ey)
    gx, gy = (px - cx) / (rx * rx), (py - cy) / (ry * ry)
    g = math.hypot(gx, gy)
    if g <= 1e-12:
        return -min(rx, ry)
    return (k - 1.0) / g


def tri_dist(px, py, p1, p2, p3):
    """点到三角形边界的有符号距离（内部为负）。"""
    pts = (p1, p2, p3)
    d = min(
        seg_dist(px, py, *p1, *p2),
        seg_dist(px, py, *p2, *p3),
        seg_dist(px, py, *p3, *p1),
    )
    sign = 0
    inside = True
    for i in range(3):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % 3]
        cross = (x2 - x1) * (py - y1) - (y2 - y1) * (px - x1)
        if abs(cross) < 1e-12:
            continue
        s = 1 if cross > 0 else -1
        if sign == 0:
            sign = s
        elif s != sign:
            inside = False
            break
    return -d if inside else d


class Canvas:
    """RGBA 画布（颜色分量 0-255 浮点，直接合成，不做预乘）。"""

    def __init__(self, size):
        self.size = size
        self.buf = [(0.0, 0.0, 0.0, 0.0)] * (size * size)

    def over(self, x, y, color, a):
        if a <= 0.0008:
            return
        i = y * self.size + x
        dr, dg, db, da = self.buf[i]
        na = a + da * (1.0 - a)
        if na <= 1e-6:
            return
        inv = da * (1.0 - a)
        self.buf[i] = (
            (color[0] * a + dr * inv) / na,
            (color[1] * a + dg * inv) / na,
            (color[2] * a + db * inv) / na,
            na,
        )

    def to_rgba_bytes(self):
        out = bytearray(self.size * self.size * 4)
        i = 0
        for r, g, b, a in self.buf:
            out[i] = int(clamp(r + 0.5, 0, 255))
            out[i + 1] = int(clamp(g + 0.5, 0, 255))
            out[i + 2] = int(clamp(b + 0.5, 0, 255))
            out[i + 3] = int(clamp(a * 255.0 + 0.5, 0, 255))
            i += 4
        return bytes(out)


def paint(canvas, dist_fn, bbox, color, alpha=1.0, stroke_color=None, stroke_w=0.0):
    """把距离场函数刷到画布上；stroke_color/stroke_w 可选描边。"""
    size = canvas.size
    x0 = max(0, int(math.floor(bbox[0])))
    y0 = max(0, int(math.floor(bbox[1])))
    x1 = min(size - 1, int(math.ceil(bbox[2])))
    y1 = min(size - 1, int(math.ceil(bbox[3])))
    for y in range(y0, y1 + 1):
        py = y + 0.5
        for x in range(x0, x1 + 1):
            d = dist_fn(x + 0.5, py)
            if stroke_color is not None and stroke_w > 0.0:
                sa = clamp(0.5 + stroke_w * 0.5 - abs(d), 0.0, 1.0) * alpha
                if sa > 0:
                    canvas.over(x, y, stroke_color, sa)
            a = clamp(0.5 - d, 0.0, 1.0) * alpha
            if a > 0:
                canvas.over(x, y, color, a)


def circle_bbox(cx, cy, r, extra=3.0):
    return (cx - r - extra, cy - r - extra, cx + r + extra, cy + r + extra)


def ell_bbox(cx, cy, rx, ry, extra=3.0):
    return (cx - rx - extra, cy - ry - extra, cx + rx + extra, cy + ry + extra)


def tri_bbox(pts, extra=3.0):
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return (min(xs) - extra, min(ys) - extra, max(xs) + extra, max(ys) + extra)


def seg_bbox(p1, p2, w, extra=2.0):
    h = w * 0.5 + extra
    return (min(p1[0], p2[0]) - h, min(p1[1], p2[1]) - h,
            max(p1[0], p2[0]) + h, max(p1[1], p2[1]) + h)


def draw_cat(size, content_scale=1.0, background=None):
    """画一张橘猫脸。

    content_scale < 1 会把猫整体缩小（maskable 图标留安全边距用）。
    坐标以 0..1 的「设计空间」定义，再按 size 与 content_scale 映射到像素。
    """
    cv = Canvas(size)
    S = float(size)

    def X(u):
        return S * (0.5 + (u - 0.5) / content_scale)

    def Y(u):
        return S * (0.5 + (u - 0.5) / content_scale)

    def P(u, v):
        return (X(u), Y(v))

    # 线宽随尺寸缩放（小尺寸保证不细到看不见）
    face_r = Y(0.910) - Y(0.575)  # 半径像素值
    outline_w = max(1.8, 0.026 * face_r)
    stripe_w = max(2.0, 0.085 * face_r)
    eye_rx = (X(0.622) - X(0.378)) * 0.5 * 0.46
    eye_ry = eye_rx * 1.18
    mouth_w = max(1.6, 0.052 * face_r)
    whisker_w = max(1.4, 0.038 * face_r)

    if background is not None:
        # 满幅底色（iOS / maskable 用，避免透明被渲染成黑底）
        paint(cv, lambda px, py: -1.0, (0, 0, size, size), background)

    # ---- 1. 耳朵（先描边后填充，让描边只留在外侧）
    ears = [
        (P(0.205, 0.315), P(0.115, 0.075), P(0.415, 0.205)),
        (P(0.795, 0.315), P(0.885, 0.075), P(0.585, 0.205)),
    ]
    for p1, p2, p3 in ears:
        paint(cv, lambda px, py, p1=p1, p2=p2, p3=p3: tri_dist(px, py, p1, p2, p3),
              tri_bbox([p1, p2, p3], outline_w), ORANGE,
              stroke_color=OUTLINE, stroke_w=outline_w)
    inner_ears = [
        (P(0.235, 0.300), P(0.180, 0.145), P(0.375, 0.235)),
        (P(0.765, 0.300), P(0.820, 0.145), P(0.625, 0.235)),
    ]
    for p1, p2, p3 in inner_ears:
        paint(cv, lambda px, py, p1=p1, p2=p2, p3=p3: tri_dist(px, py, p1, p2, p3),
              tri_bbox([p1, p2, p3], 1.0), BLUSH, alpha=0.85)

    # ---- 2. 脸
    fcx, fcy, fr = X(0.5), Y(0.575), face_r
    paint(cv, lambda px, py, cx=fcx, cy=fcy, r=fr: math.hypot(px - cx, py - cy) - r,
          circle_bbox(fcx, fcy, fr, outline_w), ORANGE,
          stroke_color=OUTLINE, stroke_w=outline_w)

    # ---- 3. 额头条纹
    stripes = [
        (P(0.428, 0.285), P(0.418, 0.375)),
        (P(0.500, 0.262), P(0.500, 0.362)),
        (P(0.572, 0.285), P(0.582, 0.375)),
    ]
    for p1, p2 in stripes:
        paint(cv, lambda px, py, p1=p1, p2=p2: seg_dist(px, py, p1[0], p1[1], p2[0], p2[1]) - stripe_w * 0.5,
              seg_bbox(p1, p2, stripe_w), DEEP, alpha=0.9)

    # ---- 4. 腮红
    for u in (0.245, 0.755):
        cx, cy = X(u), Y(0.645)
        rx, ry = (X(0.315) - X(0.175)) * 0.5, (Y(0.690) - Y(0.600)) * 0.5
        paint(cv, lambda px, py, cx=cx, cy=cy, rx=rx, ry=ry: ell_dist(px, py, cx, cy, rx, ry),
              ell_bbox(cx, cy, rx, ry), BLUSH, alpha=0.55)

    # ---- 5. 白色口鼻区
    mcx, mcy = X(0.5), Y(0.700)
    mrx, mry = (X(0.615) - X(0.385)) * 0.5, (Y(0.775) - Y(0.625)) * 0.5
    paint(cv, lambda px, py, cx=mcx, cy=mcy, rx=mrx, ry=mry: ell_dist(px, py, cx, cy, rx, ry),
          ell_bbox(mcx, mcy, mrx, mry), MUZZLE, alpha=0.92)

    # ---- 6. 胡须（小尺寸省略，避免糊成一团）
    if size >= 256:
        whiskers = [
            (P(0.185, 0.615), P(0.078, 0.592)),
            (P(0.185, 0.668), P(0.078, 0.690)),
            (P(0.815, 0.615), P(0.922, 0.592)),
            (P(0.815, 0.668), P(0.922, 0.690)),
        ]
        for p1, p2 in whiskers:
            paint(cv, lambda px, py, p1=p1, p2=p2: seg_dist(px, py, p1[0], p1[1], p2[0], p2[1]) - whisker_w * 0.5,
                  seg_bbox(p1, p2, whisker_w), MOUTH, alpha=0.85)

    # ---- 7. 眼睛 + 高光
    for u in (0.378, 0.622):
        cx, cy = X(u), Y(0.535)
        paint(cv, lambda px, py, cx=cx, cy=cy: ell_dist(px, py, cx, cy, eye_rx, eye_ry),
              ell_bbox(cx, cy, eye_rx, eye_ry), INK)
    glint_r = max(1.2, eye_rx * 0.30)
    for u in (0.366, 0.610):
        cx, cy = X(u), Y(0.512)
        paint(cv, lambda px, py, cx=cx, cy=cy, r=glint_r: math.hypot(px - cx, py - cy) - r,
              circle_bbox(cx, cy, glint_r), WHITE)

    # ---- 8. 鼻子
    nose = [P(0.500, 0.642), P(0.456, 0.686), P(0.544, 0.686)]
    paint(cv, lambda px, py, a=nose[0], b=nose[1], c=nose[2]: tri_dist(px, py, a, b, c),
          tri_bbox(nose), NOSE)

    # ---- 9. 嘴（从鼻底向两侧张开的 w 形）
    mouth = [
        (P(0.500, 0.686), P(0.472, 0.722), P(0.448, 0.722)),
        (P(0.500, 0.686), P(0.528, 0.722), P(0.552, 0.722)),
    ]
    for a, b, c in mouth:
        paint(cv, lambda px, py, a=a, b=b: seg_dist(px, py, a[0], a[1], b[0], b[1]) - mouth_w * 0.5,
              seg_bbox(a, b, mouth_w), MOUTH, alpha=0.9)
        paint(cv, lambda px, py, a=b, c=c: seg_dist(px, py, a[0], a[1], c[0], c[1]) - mouth_w * 0.5,
              seg_bbox(b, c, mouth_w), MOUTH, alpha=0.9)

    return cv.to_rgba_bytes()


# ---------------------------------------------------------------- PNG 编码
def png_chunk(tag, data):
    return (struct.pack('>I', len(data)) + tag + data +
            struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF))


def write_png(path, width, height, rgba):
    stride = width * 4
    raw = bytearray()
    for y in range(height):
        raw.append(0)  # filter type 0 (None)
        raw += rgba[y * stride:(y + 1) * stride]
    ihdr = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)  # 8bit RGBA
    blob = (b'\x89PNG\r\n\x1a\n'
            + png_chunk(b'IHDR', ihdr)
            + png_chunk(b'IDAT', zlib.compress(bytes(raw), 9))
            + png_chunk(b'IEND', b''))
    with open(path, 'wb') as fh:
        fh.write(blob)
    return len(blob)


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_dir = os.path.join(root, 'icons')
    os.makedirs(out_dir, exist_ok=True)

    jobs = [
        ('icon-192.png', 192, 1.00, None),      # 安卓主屏（透明底）
        ('icon-512.png', 512, 1.00, None),      # 高清
        ('icon-512-maskable.png', 512, 0.78, CREAM),  # 自适应图标，留安全边距
        ('icon-180.png', 180, 0.92, CREAM),     # iOS apple-touch-icon（不吃透明）
    ]
    for name, size, scale, bg in jobs:
        rgba = draw_cat(size, content_scale=scale, background=bg)
        path = os.path.join(out_dir, name)
        n = write_png(path, size, size, rgba)
        print(f'  {name:26s} {size}x{size}  {n / 1024:7.1f} KB')
    print('图标已生成 ->', out_dir)


if __name__ == '__main__':
    main()
