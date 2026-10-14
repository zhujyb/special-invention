# -*- coding: utf-8 -*-
"""
remove_bg.py — 纯标准库给桌宠帧图抠掉白色背景（无 Pillow 依赖）
方法：PNG 解码（zlib + 逐行 unfilter）→ 估计背景色 → 从四边 BFS 泛洪，
      只移除与边缘连通的近白像素（角色内部的白色不受影响）→
      对泛洪边界一圈按色距做 alpha 羽化 → 重新压缩写回。
用法：python tools/remove_bg.py [输入目录] [输出目录] [容差]
"""
import zlib, struct, os, sys
from collections import deque

def read_rgba(path):
    d = open(path, 'rb').read()
    if d[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError('not png: ' + path)
    idat = b''
    w = h = bitd = ct = 0
    pos = 8
    while pos < len(d):
        ln = struct.unpack('>I', d[pos:pos+4])[0]
        typ = d[pos+4:pos+8]
        data = d[pos+8:pos+8+ln]
        if typ == b'IHDR':
            w, h, bitd, ct = struct.unpack('>IIBB', data[:10])
        elif typ == b'IDAT':
            idat += data
        pos += 12 + ln
    if ct != 6 or bitd != 8:
        raise ValueError('expect RGBA8, got colortype=%s bit=%s in %s' % (ct, bitd, path))
    raw = zlib.decompress(idat)
    stride = w * 4
    px = bytearray(stride * h)
    prev = bytearray(stride)
    for y in range(h):
        f = raw[y*(stride+1)]
        line = bytearray(raw[y*(stride+1)+1:(y+1)*(stride+1)])
        if f == 1:
            for i in range(4, stride):
                line[i] = (line[i] + line[i-4]) & 255
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif f == 3:
            for i in range(stride):
                a = line[i-4] if i >= 4 else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255
        elif f == 4:
            for i in range(stride):
                a = line[i-4] if i >= 4 else 0
                b = prev[i]
                c = prev[i-4] if i >= 4 else 0
                p = a + b - c
                pa = abs(p-a); pb = abs(p-b); pc = abs(p-c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        px[y*stride:(y+1)*stride] = line
        prev = line
    return w, h, px

def remove_bg(w, h, px, tol):
    """从四边泛洪移除近白背景；返回 (像素数组, 背景色)"""
    stride = w * 4

    # 1. 背景色 = 四边像素的中位数（比均值抗干扰）
    border = []
    for x in range(0, w, 4):
        border.append((x, 0)); border.append((x, h-1))
    for y in range(0, h, 4):
        border.append((0, y)); border.append((w-1, y))
    rs = sorted(px[y*stride + x*4]     for x, y in border)
    gs = sorted(px[y*stride + x*4 + 1] for x, y in border)
    bs = sorted(px[y*stride + x*4 + 2] for x, y in border)
    br, bg_, bb = rs[len(rs)//2], gs[len(gs)//2], bs[len(bs)//2]
    tol2 = tol * tol

    # 2. BFS：与边缘连通且色距 <= tol 的都算背景
    n = w * h
    is_bg = bytearray(n)
    stack = deque()
    def try_push(x, y):
        if x < 0 or x >= w or y < 0 or y >= h: return
        idx = y*w + x
        if is_bg[idx]: return
        o = idx * 4
        dr = px[o]-br; dg = px[o+1]-bg_; db = px[o+2]-bb
        if dr*dr + dg*dg + db*db <= tol2:
            is_bg[idx] = 1
            stack.append((x, y))
    for x in range(w):
        try_push(x, 0); try_push(x, h-1)
    for y in range(h):
        try_push(0, y); try_push(w-1, y)
    while stack:
        x, y = stack.popleft()
        try_push(x+1, y); try_push(x-1, y); try_push(x, y+1); try_push(x, y-1)

    # 3. 泛洪边界一圈：按色距做 alpha 羽化（抗白边）
    for y in range(h):
        for x in range(w):
            idx = y*w + x
            if is_bg[idx]:
                px[idx*4+3] = 0
                continue
            near_bg = False
            for dx, dy in ((1,0),(-1,0),(0,1),(0,-1)):
                nx, ny = x+dx, y+dy
                if 0 <= nx < w and 0 <= ny < h and is_bg[ny*w+nx]:
                    near_bg = True; break
            if near_bg:
                o = idx*4
                dr = px[o]-br; dg = px[o+1]-bg_; db = px[o+2]-bb
                d = (dr*dr + dg*dg + db*db) ** 0.5
                a = int(255 * (d - tol*0.6) / (tol*0.9))
                px[o+3] = 0 if a <= 0 else (255 if a >= 255 else a)
    return px, (br, bg_, bb)

def write_png(path, w, h, px):
    stride = w * 4
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        raw += px[y*stride:(y+1)*stride]
    comp = zlib.compress(bytes(raw), 9)
    def chunk(typ, data):
        return (struct.pack('>I', len(data)) + typ + data +
                struct.pack('>I', zlib.crc32(typ + data) & 0xffffffff))
    out = b'\x89PNG\r\n\x1a\n'
    out += chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
    out += chunk(b'IDAT', comp)
    out += chunk(b'IEND', b'')
    open(path, 'wb').write(out)

def main():
    src = sys.argv[1] if len(sys.argv) > 1 else 'img/pet'
    tol = int(sys.argv[2]) if len(sys.argv) > 2 else 38
    files = sorted(f for f in os.listdir(src) if f.endswith('.png'))
    for f in files:
        p = os.path.join(src, f)
        w, h, px = read_rgba(p)
        px, bg = remove_bg(w, h, px, tol)
        write_png(p, w, h, px)
        print('%s  bg=(%d,%d,%d) tol=%d' % (f, bg[0], bg[1], bg[2], tol))
    print('done:', len(files), 'files')

if __name__ == '__main__':
    main()
