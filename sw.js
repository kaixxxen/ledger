const CACHE = 'ledger-v54-bill-header-consistency';
const SHELL = [
  'index.html', 'styles.css', 'app.js', 'config.js', 'manifest.webmanifest',
  'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(SHELL.map(url => c.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function networkFirst(req, fallbackKey) {
  return new Promise(resolve => {
    let settled = false;
    const done = res => { if (!settled && res) { settled = true; resolve(res); } };
    const fromCache = async () => (await caches.match(req, { ignoreSearch: true })) ||
                                  (fallbackKey ? await caches.match(fallbackKey) : undefined);
    const timer = setTimeout(async () => done(await fromCache()), 3000);
    fetch(req).then(res => {
      clearTimeout(timer);
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(fallbackKey && req.mode === 'navigate' ? fallbackKey : req, copy));
      }
      done(res);
    }).catch(async () => {
      clearTimeout(timer);
      done(await fromCache());
      if (!settled) { settled = true; resolve(Response.error()); }
    });
  });
}

function cacheFirst(req) {
  return caches.match(req).then(hit => hit || fetch(req).then(res => {
    if (res && (res.ok || res.type === 'opaque')) {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
    }
    return res;
  }));
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === location.origin) {
    e.respondWith(networkFirst(req, req.mode === 'navigate' ? 'index.html' : null));
    return;
  }
  const isFont = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  const isAuthLib = url.hostname === 'cdn.jsdelivr.net' && url.pathname.startsWith('/npm/@supabase/');
  if (isFont || isAuthLib) e.respondWith(cacheFirst(req));
});
