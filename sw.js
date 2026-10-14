/* ==========================================================================
 * 橘猫桌宠 — Service Worker
 * 策略：app shell 全量预缓存 + cache-first（本应用完全离线，无动态数据）。
 * 更新：改任何资源后把 VERSION +1，老缓存会在 activate 阶段被清掉。
 * ========================================================================== */
'use strict';

const VERSION = 'v3';
const CACHE = `cat-pet-${VERSION}`;

/* 预缓存：app shell + 全部宠物动画帧（保证离线时任何动作都能播放） */
const PET_FRAMES = [
  'blink_00','blink_01','blink_02',
  'happy_00','happy_01','happy_02','happy_03','happy_04','happy_05','happy_06','happy_07',
  'idle_00','idle_01','idle_02','idle_03','idle_04','idle_05','idle_06','idle_07','idle_08','idle_09',
  'sleep_00','sleep_01','sleep_02','sleep_03','sleep_04',
  'talk_00','talk_01','talk_02','talk_03','talk_04','talk_05',
  'yawn_00','yawn_01','yawn_02','yawn_03','yawn_04',
].map((n) => `./img/pet/${n}.png`);

const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './pet.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './icons/icon-180.png',
  ...PET_FRAMES,
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  /* 页面导航：优先网络，离线时回退到缓存的 index.html */
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(() => caches.match('./index.html'))
    );
    return;
  }

  /* 其余资源：cache-first，未命中再回源并顺手入缓存 */
  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res && res.ok && new URL(req.url).origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      });
    })
  );
});
