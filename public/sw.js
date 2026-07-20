// 变电运维五班操作票系统 - Service Worker
// 作用：缓存前端壳（app shell），使主域名穿透链路完全中断时，
// 已安装 PWA 的用户仍能从缓存加载页面并触发主备域名自动切换。
//
// 关键策略（v4）：
// - /api/ 请求：始终走网络，绝不缓存（避免「保存后重进显示旧值」「下载接口被当页面」）。
// - 页面导航 / 静态资源（app.js、css 等）：网络优先 + 缓存兜底。
//   这样每次部署后任意一次刷新即可拿到最新代码，不会被旧缓存卡死。
// - install 时 skipWaiting、activate 时 clients.claim：新 SW 立即接管，无需手动清缓存。
const CACHE = 'ts-pwa-v4';
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
  if (req.method !== 'GET') return;                 // 非 GET（POST/PUT/DELETE）直接放行

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // 跨域请求放行

  // API 请求：始终走网络，绝不缓存
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(req));
    return;
  }

  // 网络优先：先取最新资源并刷新缓存；网络失败再回退缓存（容灾），再失败回退 index.html
  event.respondWith(
    fetch(req)
      .then((resp) => {
        if (resp && resp.status === 200 && resp.type === 'basic') {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return resp;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match('/index.html')))
  );
});
