/* ==========================================================================
 * 橘猫桌宠 — 交互逻辑（单文件，无依赖）
 * 分区：CONFIG / 文案 / DOM&STATE / 几何 / 气泡 / 手势状态机 / 宠物状态机
 *       / 定时器 / 惯性&吸附 / 持久化 / PWA / 初始化
 *
 * 手势设计要点（单/双/拖三者互斥）：
 *  - 不使用 click / dblclick（拖动后仍会触发 click、双击会先冒两次单击、
 *    移动端有 300ms 延迟且 iOS 上行为不稳），全部用 Pointer Events 自行判定。
 *  - 指针位移 > DRAG_START_PX 才升级为"拖动"，升级时立刻取消待定单击；
 *    拖动结束绝不进入点击判定。
 *  - 抬起时若时长 <= TAP_MAX_MS 且位移 <= TAP_SLOP_PX，视为一次点击；
 *    单击会延迟 DOUBLE_WINDOW_MS 确认，期间若同点再点一次则升级为双击，
 *    因此双击不会先冒一次单击气泡。
 * ========================================================================== */
'use strict';

(function () {

  /* ------------------------------------------------------------------ *
   *  CONFIG —— 想调手感 / 换图片，改这里就够了
   * ------------------------------------------------------------------ */
  const CONFIG = {
    DEBUG: /[?&]debug/.test(location.search),   // ?debug=1 打开日志

    /* ★ 形象替换点：提供分帧 PNG 后设为 true 即启用；false 时回退到内置 SVG 橘猫 */
    USE_IMAGE: true,
    FRAME_DIR: 'img/pet/',      // 帧图所在目录
    FRAME_FPS: { idle: 6, blink: 12, yawn: 10, talk: 10, happy: 12, sleep: 5 },

    /* 手势阈值 */
    DRAG_START_PX: 8,           // 位移超过才升级为拖动（手指抖动容错）
    TAP_SLOP_PX: 10,            // 松手总位移 <= 此值才算点击
    TAP_MAX_MS: 260,            // 按下到抬起 <= 此值才算点击
    DOUBLE_WINDOW_MS: 280,      // 两次点击间隔 <= 此值视为双击
    DOUBLE_SLOP_PX: 42,         // 两次点击落点距离 <= 此值才算同一处双击

    /* 惯性 / 吸附 */
    FRICTION: 0.94,             // 速度衰减系数（每 16.7ms 乘一次）
    MIN_INERTIA_V: 0.02,        // 低于此速度(px/ms)惯性结束，进入吸附
    SNAP_SPRING: 0.18,          // 吸附弹簧强度
    SNAP_TO_EDGE: true,         // true=吸附到最近左/右边缘；false=只夹回屏内
    EDGE_MARGIN: 10,            // 贴边留白 px（会叠加安全区）

    /* 定时器（ms） */
    LULL_MIN: 18000,            // 随机小动作（眨眼/打哈欠）间隔下限（频率已调低）
    LULL_MAX: 34000,            // 上限
    FIRST_TALK_MS: 4000,        // 首次主动搭话延迟
    TALK_MIN: 45000,            // 之后每次主动搭话间隔下限
    TALK_MAX: 90000,            // 上限
    BUBBLE_MS: 2400,            // 气泡自动消失时间

    /* 持久化 */
    STORE_KEY: 'cat-pet:v1',
    HINT_KEY: 'cat-pet:ios-hint-dismissed',
  };

  /* ------------------------------------------------------------------ *
   *  分帧动画定义（用户提供的 img/pet/*.png，256x256，透明背景）
   *  每个状态一组帧，JS 按当前状态循环/单次播放这些帧
   * ------------------------------------------------------------------ */
  const FRAMES = {
    idle:  ['idle_00','idle_01','idle_02','idle_03','idle_04','idle_05','idle_06','idle_07','idle_08','idle_09'],
    blink: ['blink_00','blink_01','blink_02'],
    yawn:  ['yawn_00','yawn_01','yawn_02','yawn_03','yawn_04'],
    talk:  ['talk_00','talk_01','talk_02','talk_03','talk_04','talk_05'],
    happy: ['happy_00','happy_01','happy_02','happy_03','happy_04','happy_05','happy_06','happy_07'],
    sleep: ['sleep_00','sleep_01','sleep_02','sleep_03','sleep_04'],
  };

  /* ------------------------------------------------------------------ *
   *  文案库（可爱日常风，直接改这里的字符串即可）
   * ------------------------------------------------------------------ */
  const TAP_MSGS = [
    '今天也要加油呀～', '摸摸头~', '喵~', '在的在的！', '嘿嘿',
    '一起偷懒好不好', '你在忙什么呀', '手手好凉', '喵呜～', '叫我？',
  ];
  const TALK_MSGS = [
    '可以陪我玩玩吗～', '好无聊呀…', '要不要摸摸我？', '喵…看我一下嘛',
    '陪我玩会儿好不好', '肚子有点饿了…', '喵！理理我嘛',
  ];
  const FIRST_TALK = '可以陪我玩玩吗～';
  const STARTLE_MSGS = ['喵！！谁吵醒我…', '唔…干嘛啦', '被吓醒了喵…'];
  const SLEEP_MSG = '呼…睡着了 💤';

  /* ------------------------------------------------------------------ *
   *  DOM & STATE
   * ------------------------------------------------------------------ */
  const pet = document.getElementById('pet');
  const bubble = document.getElementById('bubble');
  const probe = document.getElementById('safeProbe');
  const petImage = document.getElementById('petImage');
  const iosHint = document.getElementById('iosHint');
  const iosHintClose = document.getElementById('iosHintClose');

  const st = {
    /* 视口 / 尺寸 / 安全区 */
    vw: 0, vh: 0, petW: 0, petH: 0,
    safe: { t: 0, r: 0, b: 0, l: 0 },

    /* 位置（宠物左上角，viewport 坐标） */
    x: 0, y: 0,

    /* 主状态 */
    sleeping: false,
    talkBubble: false,         // 当前气泡是否为"说话"类（驱动 talk 帧）

    /* 手势状态机 */
    gesture: {
      phase: 'idle',            // idle | pressed | dragging
      pointerId: null,
      startX: 0, startY: 0,     // 按下时指针坐标
      originX: 0, originY: 0,   // 按下时宠物坐标
      startTime: 0,
      samples: [],              // 近距离采样，用于松手测速
    },

    /* 双击判定 */
    pendingTapTimer: null,
    lastTapTime: 0, lastTapX: 0, lastTapY: 0,

    /* 定时器句柄 */
    lullTimer: null,
    talkTimer: null,
    bubbleTimer: null,
    motionTimer: null,
    rafId: null,
  };

  const log = (...a) => { if (CONFIG.DEBUG) console.log('[pet]', ...a); };
  const rand = (lo, hi) => lo + Math.random() * (hi - lo);
  const pick = (arr) => arr[(Math.random() * arr.length) | 0];
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  /* ------------------------------------------------------------------ *
   *  几何：视口 / 安全区 / 边界 / 位置应用
   * ------------------------------------------------------------------ */
  function readSafe() {
    // env() 在自定义属性里读不到具体值，这里用探针元素的 padding 拿真实数值
    const cs = getComputedStyle(probe);
    st.safe.t = parseFloat(cs.paddingTop) || 0;
    st.safe.r = parseFloat(cs.paddingRight) || 0;
    st.safe.b = parseFloat(cs.paddingBottom) || 0;
    st.safe.l = parseFloat(cs.paddingLeft) || 0;
  }

  function measure() {
    st.vw = window.innerWidth;
    st.vh = window.innerHeight;
    const rect = pet.getBoundingClientRect();
    st.petW = rect.width;
    st.petH = rect.height;
  }

  const edgeL = () => st.safe.l + CONFIG.EDGE_MARGIN;
  const edgeT = () => st.safe.t + CONFIG.EDGE_MARGIN;
  const edgeR = () => st.safe.r + CONFIG.EDGE_MARGIN;
  const edgeB = () => st.safe.b + CONFIG.EDGE_MARGIN;
  const minX = () => edgeL();
  const maxX = () => Math.max(edgeL(), st.vw - st.petW - edgeR());
  const minY = () => edgeT();
  const maxY = () => Math.max(edgeT(), st.vh - st.petH - edgeB());

  function clampPos() {
    st.x = clamp(st.x, minX(), maxX());
    st.y = clamp(st.y, minY(), maxY());
  }

  function applyTransform() {
    pet.style.setProperty('--x', st.x + 'px');
    pet.style.setProperty('--y', st.y + 'px');
  }

  function defaultPosition() {
    st.x = maxX();               // 右下角
    st.y = maxY();
  }

  /* ------------------------------------------------------------------ *
   *  气泡
   * ------------------------------------------------------------------ */
  function showBubble(text, ms, opts) {
    if (!text) return;
    clearTimeout(st.bubbleTimer);
    bubble.classList.remove('is-visible', 'bubble--below');
    bubble.textContent = text;
    bubble.hidden = false;
    const talk = opts ? !!opts.talk : (st.sleeping ? false : true);
    st.talkBubble = talk && !st.sleeping;
    layoutBubble();
    void bubble.offsetWidth;              // 强制 reflow，保证过渡动画生效
    bubble.classList.add('is-visible');
    st.bubbleTimer = setTimeout(hideBubble, ms || CONFIG.BUBBLE_MS);
    log('bubble:', text);
    if (useFrames) refreshAnim();
  }

  function hideBubble() {
    clearTimeout(st.bubbleTimer);
    st.bubbleTimer = null;
    st.talkBubble = false;
    bubble.classList.remove('is-visible');
    setTimeout(() => {
      if (!bubble.classList.contains('is-visible')) bubble.hidden = true;
    }, 220);
    if (useFrames) refreshAnim();
  }

  /* 气泡定位：水平方向夹取在视口内，尾巴对准宠物中心；贴顶时翻到下方 */
  function layoutBubble() {
    const rect = pet.getBoundingClientRect();
    const bw = bubble.offsetWidth;
    const bh = bubble.offsetHeight;
    const lo = edgeL();
    const hi = st.vw - edgeR();
    const petCenterX = rect.left + rect.width / 2;

    let left = clamp(petCenterX - bw / 2, lo, Math.max(lo, hi - bw));
    bubble.style.left = (left - rect.left) + 'px';
    bubble.style.setProperty('--tail-x',
      clamp(petCenterX - left, 14, Math.max(14, bw - 14)) + 'px');

    const fitsAbove = rect.top - bh - 14 >= st.safe.t;
    bubble.classList.toggle('bubble--below', !fitsAbove);
  }

  /* ------------------------------------------------------------------ *
   *  分帧动画播放器（USE_IMAGE 时驱动 petImage 切换各帧）
   * ------------------------------------------------------------------ */
  const useFrames = CONFIG.USE_IMAGE;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const imgCache = {};                  // name -> 预加载的 Image
  let anim = { name: null, loop: false, timer: null };

  function preloadFrames() {
    for (const k in FRAMES) for (const name of FRAMES[k]) {
      const im = new Image();
      im.src = CONFIG.FRAME_DIR + name + '.png';
      imgCache[name] = im;
    }
  }

  function setFrame(name) {
    const im = imgCache[name];
    petImage.src = im ? im.src : CONFIG.FRAME_DIR + name + '.png';
  }

  function stopFrame() {
    if (anim.timer) { clearInterval(anim.timer); anim.timer = null; }
  }

  /* playFrames(name, {loop, onDone})：播一组帧；loop 时循环，否则播完触发 onDone */
  function playFrames(name, opts) {
    stopFrame();
    const seq = FRAMES[name];
    const fps = (opts && opts.fps) || CONFIG.FRAME_FPS[name] || 10;
    const loop = !!(opts && opts.loop);
    const onDone = opts && opts.onDone;
    anim.name = name;
    anim.loop = loop;
    if (reducedMotion) {                 // 动效减弱：只定格首帧
      setFrame(seq[0]);
      anim.name = null; anim.loop = false;
      if (onDone) onDone();
      return;
    }
    let i = 0;
    setFrame(seq[0]);
    anim.timer = setInterval(() => {
      i++;
      if (i >= seq.length) {
        if (loop) { i = 0; }
        else {
          stopFrame();
          anim.name = null; anim.loop = false;
          setFrame(seq[seq.length - 1]);
          if (onDone) onDone();
          return;
        }
      }
      setFrame(seq[i]);
    }, 1000 / fps);
  }

  /* 按当前主状态决定基础循环动画（sleep / talk / idle） */
  function refreshAnim() {
    if (anim.name && !anim.loop) return;  // 有单次动画（blink/yawn/happy）在播，不抢占
    const want = st.sleeping ? 'sleep' : (st.talkBubble ? 'talk' : 'idle');
    if (anim.name === want && anim.loop) return;   // 已在播，避免重启
    playFrames(want, { loop: true });
  }

  /* ------------------------------------------------------------------ *
   *  手势状态机
   * ------------------------------------------------------------------ */
  function cancelPendingTap() {
    if (st.pendingTapTimer) {
      clearTimeout(st.pendingTapTimer);
      st.pendingTapTimer = null;
    }
  }

  function onDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (st.gesture.pointerId !== null) return;      // 已在跟踪别的指针

    stopKinetic();                                  // 惯性中直接接管
    e.preventDefault();
    try { pet.setPointerCapture(e.pointerId); } catch (_) {}

    const g = st.gesture;
    g.phase = 'pressed';
    g.pointerId = e.pointerId;
    g.startX = e.clientX;
    g.startY = e.clientY;
    g.originX = st.x;
    g.originY = st.y;
    g.startTime = performance.now();
    g.samples = [{ x: e.clientX, y: e.clientY, t: g.startTime }];
    pet.classList.add('is-pressed');
    log('down', e.clientX, e.clientY);
  }

  function onMove(e) {
    const g = st.gesture;
    if (g.phase === 'idle' || e.pointerId !== g.pointerId) return;
    e.preventDefault();

    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;

    if (g.phase === 'pressed') {
      if (Math.hypot(dx, dy) > CONFIG.DRAG_START_PX) {
        g.phase = 'dragging';
        pet.classList.add('is-moving');
        cancelPendingTap();                          // 一旦拖动，取消待定单击
        hideBubble();
        log('drag start');
      } else {
        return;                                      // 未过阈值，先不动
      }
    }

    /* 拖动跟随（实时夹取在屏内） */
    st.x = clamp(g.originX + dx, minX(), maxX());
    st.y = clamp(g.originY + dy, minY(), maxY());
    applyTransform();

    /* 近距离采样测速（90ms 窗口） */
    const now = performance.now();
    g.samples.push({ x: e.clientX, y: e.clientY, t: now });
    while (g.samples.length > 1 && now - g.samples[0].t > 90) g.samples.shift();
  }

  function onUp(e) {
    const g = st.gesture;
    if (g.phase === 'idle' || e.pointerId !== g.pointerId) return;
    pet.classList.remove('is-pressed');

    const now = performance.now();
    const dt = now - g.startTime;
    const dist = Math.hypot(e.clientX - g.startX, e.clientY - g.startY);

    if (g.phase === 'dragging') {
      g.phase = 'idle';
      g.pointerId = null;
      pet.classList.remove('is-moving');
      /* 松手 → 惯性滑行 + 边缘吸附；拖动后绝不触发点击 */
      const v = flickVelocity(g.samples);
      startKinetic(v.vx, v.vy);
      log('drag end, v=', v.vx.toFixed(3), v.vy.toFixed(3));
      return;
    }

    /* pressed（未升级为拖动）→ 是否算一次点击 */
    g.phase = 'idle';
    g.pointerId = null;
    log('up phase=pressed dt=' + dt + ' dist=' + dist.toFixed(1));
    if (dt <= CONFIG.TAP_MAX_MS && dist <= CONFIG.TAP_SLOP_PX) {
      registerTap(e.clientX, e.clientY);
    }
  }

  function onCancel(e) {
    const g = st.gesture;
    if (g.pointerId !== null && e.pointerId !== g.pointerId) return;
    pet.classList.remove('is-pressed', 'is-moving');
    if (g.phase === 'dragging') startKinetic(0, 0);  // 原地软回弹
    g.phase = 'idle';
    g.pointerId = null;
  }

  function flickVelocity(samples) {
    if (samples.length < 2) return { vx: 0, vy: 0 };
    const a = samples[0];
    const b = samples[samples.length - 1];
    const dt = Math.max(b.t - a.t, 1);
    return {
      vx: clamp((b.x - a.x) / dt, -4, 4),
      vy: clamp((b.y - a.y) / dt, -4, 4),
    };
  }

  /* 单击 / 双击合并判定：单击延迟确认，等 DOUBLE_WINDOW_MS 看会不会来第二下 */
  function registerTap(x, y) {
    const now = performance.now();
    const isDouble =
      now - st.lastTapTime <= CONFIG.DOUBLE_WINDOW_MS &&
      Math.hypot(x - st.lastTapX, y - st.lastTapY) <= CONFIG.DOUBLE_SLOP_PX;

    if (isDouble) {
      cancelPendingTap();
      st.lastTapTime = 0;                            // 清空，避免三连击误判
      log('double tap');
      onDoubleTap();
      return;
    }

    st.lastTapTime = now;
    st.lastTapX = x;
    st.lastTapY = y;
    cancelPendingTap();
    st.pendingTapTimer = setTimeout(() => {
      st.pendingTapTimer = null;
      log('single tap');
      onSingleTap();
    }, CONFIG.DOUBLE_WINDOW_MS);
  }

  /* ------------------------------------------------------------------ *
   *  宠物状态机（清醒 / 睡觉 + 瞬时动作）
   * ------------------------------------------------------------------ */
  function onSingleTap() {
    if (st.sleeping) {
      wakeUp(true, pick(STARTLE_MSGS));              // 彩蛋：睡觉被点 → 惊醒
    } else {
      showBubble(pick(TAP_MSGS));                     // 普通发言（talk 帧）
    }
  }

  function onDoubleTap() {
    if (st.sleeping) wakeUp(false, '喵…睡饱啦');
    else fallAsleep();
  }

  function fallAsleep() {
    st.sleeping = true;
    pet.classList.add('pet--sleeping');
    stopLull();                                       // 睡觉时暂停小动作
    stopTalk();
    st.talkBubble = false;
    hideBubble();
    showBubble(SLEEP_MSG, 1600, { talk: false });      // 睡觉语，不播 talk 帧
    if (useFrames) refreshAnim();                     // → sleep 循环
    save();
  }

  function wakeUp(startled, msg) {
    st.sleeping = false;
    pet.classList.remove('pet--sleeping');
    pet.classList.add('is-wakeup');                   // 伸懒腰过渡动画（对图片同样生效）
    clearTimeout(st.motionTimer);
    st.motionTimer = setTimeout(() => pet.classList.remove('is-wakeup'), 950);
    if (useFrames) playFrames('happy', { onDone: refreshAnim });
    if (msg) {                                        // 气泡立即弹；refreshAnim 有单次动画
      st.talkBubble = true;                           // 保护，不会打断 happy 帧
      showBubble(msg);
    }
    startLull();                                      // 醒来恢复小动作
    scheduleTalk(rand(CONFIG.TALK_MIN, CONFIG.TALK_MAX));
    save();
  }

  function doBlink() {
    if (useFrames) { playFrames('blink', { onDone: refreshAnim }); }
    else {
      pet.classList.add('is-blink');
      setTimeout(() => pet.classList.remove('is-blink'), 150);
    }
  }

  function doYawn() {
    if (st.sleeping) return;
    if (useFrames) { playFrames('yawn', { onDone: refreshAnim }); }
    else {
      pet.classList.add('is-yawn');
      setTimeout(() => pet.classList.remove('is-yawn'), 1300);
    }
  }

  /* ------------------------------------------------------------------ *
   *  定时器（递归 setTimeout，绝不用 setInterval，防止堆叠）
   * ------------------------------------------------------------------ */
  function startLull() {
    stopLull();
    const next = () => {
      st.lullTimer = setTimeout(() => {
        if (!st.sleeping && !document.hidden) {
          Math.random() < 0.5 ? doBlink() : doYawn();
        }
        next();
      }, rand(CONFIG.LULL_MIN, CONFIG.LULL_MAX));
    };
    next();
  }

  function stopLull() {
    clearTimeout(st.lullTimer);
    st.lullTimer = null;
  }

  function scheduleTalk(delay) {
    stopTalk();
    st.talkTimer = setTimeout(() => {
      if (!st.sleeping && !document.hidden) showBubble(pick(TALK_MSGS));
      scheduleTalk(rand(CONFIG.TALK_MIN, CONFIG.TALK_MAX));
    }, delay);
  }

  function stopTalk() {
    clearTimeout(st.talkTimer);
    st.talkTimer = null;
  }

  /* 页面隐藏时全部暂停，回前台恢复，避免"补偿式连发" */
  function onVisibility() {
    if (document.hidden) {
      stopLull();
      stopTalk();
      hideBubble();
      stopFrame();                                     // 暂停帧动画省电
    } else {
      if (!st.sleeping) startLull();
      scheduleTalk(rand(CONFIG.TALK_MIN, CONFIG.TALK_MAX));
      if (useFrames) refreshAnim();
    }
  }

  /* ------------------------------------------------------------------ *
   *  惯性 & 边缘吸附（rAF 只在这段期间运行）
   * ------------------------------------------------------------------ */
  function snapTargetX(x) {
    if (!CONFIG.SNAP_TO_EDGE) return clamp(x, minX(), maxX());
    const leftX = minX();
    const rightX = maxX();
    return (x + st.petW / 2 < st.vw / 2) ? leftX : rightX;
  }

  function startKinetic(vx, vy) {
    stopKinetic();
    pet.classList.add('is-moving');
    let phase = 'glide';
    let x = st.x;
    let y = st.y;
    let last = performance.now();

    const frame = (now) => {
      const dt = Math.min(Math.max(now - last, 1), 40);
      last = now;
      const f = dt / 16.7;

      if (phase === 'glide') {
        const k = Math.pow(CONFIG.FRICTION, f);
        vx *= k;
        vy *= k;
        x += vx * dt;
        y += vy * dt;
        x = clamp(x, minX(), maxX());
        y = clamp(y, minY(), maxY());
        st.x = x; st.y = y;
        applyTransform();
        if (Math.abs(vx) < CONFIG.MIN_INERTIA_V && Math.abs(vy) < CONFIG.MIN_INERTIA_V) {
          phase = 'snap';
        }
      } else {
        const tx = snapTargetX(x);
        const ty = clamp(y, minY(), maxY());
        const s = 1 - Math.pow(1 - CONFIG.SNAP_SPRING, f);
        x += (tx - x) * s;
        y += (ty - y) * s;
        if (Math.abs(tx - x) < 0.4 && Math.abs(ty - y) < 0.4) {
          st.x = tx; st.y = ty;
          applyTransform();
          stopKinetic();
          save();
          return;
        }
        st.x = x; st.y = y;
        applyTransform();
      }
      st.rafId = requestAnimationFrame(frame);
    };
    st.rafId = requestAnimationFrame(frame);
  }

  function stopKinetic() {
    if (st.rafId) {
      cancelAnimationFrame(st.rafId);
      st.rafId = null;
    }
    pet.classList.remove('is-moving');
  }

  /* ------------------------------------------------------------------ *
   *  持久化（位置 + 睡觉状态；隐私模式失败则退化为内存态）
   * ------------------------------------------------------------------ */
  function save() {
    try {
      localStorage.setItem(CONFIG.STORE_KEY, JSON.stringify({
        x: Math.round(st.x),
        y: Math.round(st.y),
        sleeping: st.sleeping,
      }));
    } catch (_) { /* 忽略 */ }
  }

  function load() {
    try {
      const raw = localStorage.getItem(CONFIG.STORE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (typeof data.x !== 'number' || typeof data.y !== 'number') return null;
      return data;
    } catch (_) { return null; }
  }

  /* ------------------------------------------------------------------ *
   *  PWA
   * ------------------------------------------------------------------ */
  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
    navigator.serviceWorker
      .register('./sw.js', { scope: './', updateViaCache: 'none' })
      .then((reg) => { if (reg.update) reg.update(); })
      .catch((err) => console.warn('[pet] Service Worker 注册失败：', err));
  }

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches ||
           window.navigator.standalone === true;
  }

  function maybeShowIosHint() {
    const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent);
    if (!isIOS || isStandalone()) return;
    let dismissed = false;
    try { dismissed = localStorage.getItem(CONFIG.HINT_KEY) === '1'; } catch (_) {}
    if (dismissed) return;
    iosHint.hidden = false;
    iosHintClose.addEventListener('click', () => {
      iosHint.hidden = true;
      try { localStorage.setItem(CONFIG.HINT_KEY, '1'); } catch (_) {}
    });
  }

  /* ------------------------------------------------------------------ *
   *  事件绑定 & 初始化
   * ------------------------------------------------------------------ */
  function bindEvents() {
    pet.addEventListener('pointerdown', onDown);
    pet.addEventListener('pointermove', onMove);
    pet.addEventListener('pointerup', onUp);
    pet.addEventListener('pointercancel', onCancel);
    pet.addEventListener('lostpointercapture', onCancel);
    pet.addEventListener('contextmenu', (e) => e.preventDefault()); // 拉黑长按菜单
    pet.addEventListener('keydown', (e) => {          // 无障碍：键盘也能互动
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        st.sleeping ? wakeUp(true) : onSingleTap();
      }
    });

    document.addEventListener('gesturestart', (e) => e.preventDefault()); // iOS 双指缩放
    document.addEventListener('dblclick', (e) => e.preventDefault());

    document.addEventListener('visibilitychange', onVisibility);

    let resizeTimer = null;
    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        readSafe();
        measure();
        clampPos();
        applyTransform();
        hideBubble();
        save();
      }, 120);
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', () => setTimeout(onResize, 250));
  }

  function init() {
    readSafe();
    measure();

    /* ★ 形象替换点：USE_IMAGE=true 时启用分帧动画，false 时回退到内置 SVG 橘猫 */
    if (useFrames) {
      preloadFrames();
      petImage.hidden = false;
      pet.classList.remove('has-fallback');
      pet.classList.add('has-image');
      petImage.addEventListener('error', () => {       // 图片加载失败 → 回退 SVG
        petImage.hidden = true;
        pet.classList.remove('has-image');
        pet.classList.add('has-fallback');
      });
    }

    const saved = load();
    if (saved) {
      st.x = saved.x;
      st.y = saved.y;
    } else {
      defaultPosition();
    }
    clampPos();
    applyTransform();

    if (saved && saved.sleeping) {
      st.sleeping = true;
      pet.classList.add('pet--sleeping');
    }

    bindEvents();

    if (!document.hidden && !st.sleeping) {
      startLull();
      scheduleTalk(CONFIG.FIRST_TALK_MS);            // 首次主动搭话
    }

    if (useFrames && !document.hidden) refreshAnim();  // 起循环动画（idle / sleep）

    registerSW();
    maybeShowIosHint();
    log('init ok', st.x, st.y);
  }

  init();
})();
