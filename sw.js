// Офлайн-кэш оболочки приложения. Свои файлы: сначала сеть (чтобы обновления
// приходили сразу), при отсутствии сети — кэш. Данные Firebase кэширует сам.
const CACHE = 'ncx-v12';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'helper.js', 'store.js', 'util.js', 'ocr.js', 'glyphs.js', 'templates.js', 'config.js', 'manifest.webmanifest', 'icons/icon-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  const own = url.origin === location.origin;
  const static3p = /fonts\.(googleapis|gstatic)\.com|cdn\.jsdelivr\.net|www\.gstatic\.com\/firebasejs/.test(url.href);
  if (!own && !static3p) return;
  if (own) {
    e.respondWith(fetch(e.request, { cache: 'no-cache' })
      .then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request, { ignoreSearch: true })));
  } else {
    e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(r => {
      if (r.ok || r.type === 'opaque') { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return r;
    })));
  }
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then(list => list[0] ? list[0].focus() : self.clients.openWindow('./')));
});
