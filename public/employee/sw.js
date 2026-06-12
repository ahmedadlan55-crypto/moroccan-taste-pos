/**
 * Moroccan Taste — Employee Portal Service Worker (V4.1 — NETWORK-FIRST)
 * ------------------------------------------------------------
 * STRATEGY CHANGE (was the cause of "old code on phone" complaints):
 *   • OLD: stale-while-revalidate → users saw old code on every visit
 *   • NEW: NETWORK-FIRST           → always tries fresh first, cache is fallback only
 *
 *   • App shell (HTML/CSS/JS/icons)  → NETWORK-FIRST (5s timeout, then cache)
 *   • /shared/* assets               → NETWORK-FIRST (5s timeout, then cache)
 *   • Font Awesome CDN               → cache-first (it never changes)
 *   • /api/*                         → NEVER cached, always network
 *   • Anything outside /employee/, /shared/, or the CDN → passed through
 *
 * Scope is /employee/ only (because this file lives at /employee/sw.js).
 * Bump CACHE_VERSION when shipping new assets.
 */

const CACHE_VERSION = 'mt-emp-v4.2.0-netfirst';
const CACHE_NAME = CACHE_VERSION;

// App shell — pre-cached on install so the first launch works offline
const APP_SHELL = [
  '/employee/',
  '/employee/index.html',
  '/employee/style.css',
  '/employee/app.js',
  '/employee/manifest.json',
  '/employee/icons/icon.svg',
  '/employee/icons/icon-192.svg',
  '/employee/icons/icon-512.svg',
  '/shared/api-bridge.js',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css'
];

// ─── Install: pre-cache the shell + skip waiting (activate immediately) ───
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => Promise.all(
        APP_SHELL.map((url) => cache.add(url).catch(() => {}))
      ))
      .then(() => self.skipWaiting())
  );
});

// ─── Activate: delete ALL old caches + claim clients ───
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((k) => k.startsWith('mt-emp-') && k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
      .then(() => {
        // Tell all clients the SW updated — they can reload to get fresh code
        return self.clients.matchAll().then((clients) => {
          clients.forEach((c) => c.postMessage({ type: 'SW_UPDATED', version: CACHE_VERSION }));
        });
      })
  );
});

// ─── Fetch: NETWORK-FIRST (with timeout fallback to cache) ───
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname === '/employee/sw.js') return;

  const isEmployee = url.pathname === '/employee/' || url.pathname.startsWith('/employee/');
  const isShared = url.pathname.startsWith('/shared/');
  const isFontAwesome =
    url.hostname === 'cdnjs.cloudflare.com' &&
    url.pathname.includes('font-awesome');

  if (!isEmployee && !isShared && !isFontAwesome) return;

  // Font Awesome → cache-first (it never changes; saves bandwidth)
  if (isFontAwesome) {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request).then((res) => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone).catch(() => {}));
        }
        return res;
      }))
    );
    return;
  }

  // App shell + shared → NETWORK-FIRST with 5s timeout, then cache fallback
  event.respondWith(
    Promise.race([
      fetch(request).then((response) => {
        if (
          response &&
          response.status === 200 &&
          (response.type === 'basic' || response.type === 'cors')
        ) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone).catch(() => {}));
        }
        return response;
      }),
      // 5-second timeout — if network is slow, fall back to cache
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
    ]).catch(() => caches.match(request).then((cached) => cached || Response.error()))
  );
});

// ─── Message channel: clients can ask for immediate activation ───
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'CLEAR_CACHE') {
    caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))));
  }
});
