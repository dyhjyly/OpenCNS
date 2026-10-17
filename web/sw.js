/**
 * Service Worker —— 只做两件事：让 Chrome 认这个站可以装；离线时壳子还能打开。
 *
 * 一条铁律：**API 请求一律不缓存**。里面的东西是私密的、实时的，
 * 缓存在手机上没有任何好处，只会在她下次打开时看到过期数据。
 */

const CACHE = 'jly-home-v1';

const SHELL = [
  './',
  './index.html',
  './theme.css',
  './app.js',
  './manifest.webmanifest',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 别碰跨域（字体 CDN）和 API
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/api/')) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(req);
        if (hit) return hit;
        // 导航请求离线时退回壳子
        if (req.mode === 'navigate') {
          const shell = await caches.match('./index.html');
          if (shell) return shell;
        }
        return new Response('离线了', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }),
  );
});
