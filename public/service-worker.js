'use strict';

const CACHE = 'sr-shell-v1';

const SHELL = [
  '/index.html',
  '/css/style.css',
  '/js/offline-cache.js',
  '/js/app.js',
  '/favicon.svg',
  '/favicon.png',
  '/apple-touch-icon.png',
];

// Install: pre-cache shell
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL))
  );
  self.skipWaiting();
});

// Activate: delete old shell caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin GET requests
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Skip Netlify functions — let them go straight to network
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/.netlify/')) return;

  // Navigation requests: network-first, fall back to cached version of the
  // requested page (or '/') so cached content is reachable when offline.
  // The auth edge function only runs when the request reaches the server —
  // a cache hit here bypasses it entirely, which is intentional for offline use.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match(request).then(r => r || caches.match('/'))
      )
    );
    return;
  }

  // Static shell assets: stale-while-revalidate — serve from cache instantly,
  // fetch from network in background to keep cache fresh
  event.respondWith(
    caches.open(CACHE).then(cache =>
      cache.match(request).then(cached => {
        const networkFetch = fetch(request).then(res => {
          if (res.ok) cache.put(request, res.clone());
          return res;
        }).catch(() => null);
        return cached || networkFetch;
      })
    )
  );
});
