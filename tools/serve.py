#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地预览服务器（开发 / 联调用，应用本身不联网也能跑）。

为什么不用 python -m http.server：
  1. 它不认 .webmanifest 的 MIME；
  2. 开发期浏览器/服务器的双层缓存容易让人误以为"改了没生效"。

用法：
    python tools/serve.py            # 默认 http://localhost:8080
    python tools/serve.py 3000       # 指定端口
"""

import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        '.webmanifest': 'application/manifest+json',
        '.js': 'text/javascript',
        '.mjs': 'text/javascript',
        '.css': 'text/css',
        '.png': 'image/png',
    }

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')  # 开发期不缓存
        super().end_headers()


def main():
    root = __file__.rsplit('tools', 1)[0]
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    handler = Handler
    # 以项目根目录为站点根
    import os
    os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    server = ThreadingHTTPServer(('127.0.0.1', port), handler)
    print(f'橘猫桌宠预览: http://localhost:{port}   (Ctrl+C 停止)')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
