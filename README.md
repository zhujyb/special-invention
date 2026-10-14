# 橘猫桌宠（离线 PWA）

一只浮在屏幕上的橘猫：可拖动、单击聊天、双击睡觉，每 8~15 秒随机眨眼或打哈欠，
还会自己冒泡说「可以陪我玩玩吗～」。纯静态、零依赖、零 CDN，完全离线可用。

## 文件结构

```
index.html                 页面骨架（DOM + PWA/iOS meta）
styles.css                 猫脸绘制、动画、气泡、安全区适配
pet.js                     手势状态机 + 宠物行为 + 定时器 + 位置记忆
manifest.webmanifest       PWA 清单
sw.js                      Service Worker（离线缓存）
icons/                     应用图标（由脚本生成）
tools/make_icons.py        图标生成脚本（纯 Python 标准库，无 Pillow）
tools/serve.py             本地预览服务器
```

## 本机预览

Service Worker 只在安全上下文生效，**直接双击 index.html（file://）不行**，
需要走 localhost：

```bash
python tools/serve.py        # 打开 http://localhost:8080
```

## 装到手机（装完断网也能用）

1. 手机和电脑连同一个 Wi-Fi 时只能"看"，**注册不了 Service Worker**（http 不是安全上下文）。
   要真机安装，需要通过 https 打开一次页面（发布到任意静态托管 / 内网穿透均可）。
2. Android Chrome：打开页面 → 菜单「添加到主屏幕/安装」→ 从主屏图标打开即为独立窗口。
3. iOS Safari：点「分享」→「添加到主屏幕」（页面内也会出现一次性引导提示）。
4. 安装后开飞行模式再从主屏图标打开，验证离线可用。

## 更新内容后如何让用户拿到新版

改完任何文件后，把 `sw.js` 顶部的 `VERSION` 从 `'v1'` 改成 `'v2'`（依次递增）即可，
老缓存会自动清除。

## 换成你自己的图片

**当前已启用分帧动画形象**（`img/pet/` 下 37 张 256×256 帧 PNG）。
状态与帧的对应关系（在 `pet.js` 的 `FRAMES` 里配置）：

| 状态 | 帧文件 | 播放方式 | 默认帧率 |
|---|---|---|---|
| 待机 | `idle_00~09` | 循环 | 8 fps |
| 眨眼 | `blink_00~02` | 单次 | 12 fps |
| 打哈欠 | `yawn_00~04` | 单次 | 10 fps |
| 说话（有气泡时） | `talk_00~05` | 循环 | 10 fps |
| 唤醒/开心 | `happy_00~07` | 单次 | 12 fps |
| 睡觉 | `sleep_00~04` | 循环 | 6 fps |

想整体换形象：替换 `img/pet/` 下同名帧（帧数可以不同，改 `FRAMES` 数组即可）；
想回到零图片模式：把 `pet.js` 的 `USE_IMAGE` 改为 `false`，自动回退到内置 SVG 橘猫。
换完记得把 `sw.js` 的 `VERSION` +1（本次已升到 v2，帧图已全部进离线缓存）。

工具：
- `tools/remove_bg.py` — 纯标准库给白底帧图抠透明（边缘泛洪，不伤角色内部白色），
  用法 `python tools/remove_bg.py img/pet 38`（38 是颜色容差）；
- `img/pet_orig/` — 抠图前的原始帧备份。

呼吸、按压、唤醒伸懒腰、Zzz 等整体动画作用在外层容器上，与帧动画叠加生效。

## 想调手感 / 文案

全部集中在 `pet.js` 顶部的 `CONFIG` 和文案数组里：

| 参数 | 默认 | 说明 |
|---|---|---|
| `LULL_MIN/MAX` | 8000 / 15000 | 随机眨眼/打哈欠的间隔（ms） |
| `TALK_MIN/MAX` | 45000 / 90000 | 主动搭话间隔（ms） |
| `BUBBLE_MS` | 2400 | 气泡停留时长 |
| `DRAG_START_PX` | 8 | 多大位移算"拖动" |
| `DOUBLE_WINDOW_MS` | 280 | 双击判定窗口（单击会延迟这么久确认） |
| `SNAP_TO_EDGE` | true | 松手后是否吸附到屏幕左/右边缘 |
| `FRICTION` | 0.94 | 惯性衰减，越小停得越快 |

文案直接改 `TAP_MSGS`（单击）、`TALK_MSGS`（主动搭话）、`STARTLE_MSGS`（被吵醒）。

## 重新生成图标

```bash
python tools/make_icons.py
```

不依赖 Pillow，用标准库手写 PNG 编码；改配色/五官直接编辑 `tools/make_icons.py`
顶部的颜色常量和 `draw_cat()` 里的坐标。
