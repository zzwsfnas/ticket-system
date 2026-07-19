// 变电运维五班操作票系统 - Service Worker
// 作用：缓存前端壳（app shell），使主域名穿透链路完全中断时，
// 已安装 PWA 的用户仍能从缓存加载页面并触发主备域名自动切换。
const CACHE = 'ts-pwa-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/app.js',
  '/manifest.webmanifest',
  '/icon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // 只处理同源静态资源；API 请求与跨域请求放行，不做缓存
  if (url.origin !== self.location.origin) return;

  // 页面导航：网络优先，失败回退到缓存的 index.html（关键容灾逻辑）
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('/index.html'))
    );
    return;
  }

  // 静态资源：缓存优先，离线可用；缺失时回源并补缓存
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return resp;
      }).catch(() => cached);
    })
  );
});
