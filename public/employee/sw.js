/**
 * Moroccan Taste — Employee Portal Service Worker
 * ------------------------------------------------------------
 * Strategy:
 *   • App shell (HTML/CSS/JS/icons)  → stale-while-revalidate
 *   • /shared/* assets               → stale-while-revalidate
 *   • Font Awesome CDN               → stale-while-revalidate
 *   • /api/*                         → NEVER cached, always network
 *   • Anything outside /employee/, /shared/, or the CDN → passed through
 *
 * Scope is /employee/ only (because this file lives at /employee/sw.js).
 * Bump CACHE_VERSION when shipping new assets.
 */

const CACHE_VERSION = 'mt-emp-v3.1.3';
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

// ─── Install: pre-cache the shell ───
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        // Use individual adds so one failing resource doesn't prevent the rest
        return Promise.all(
          APP_SHELL.map((url) =>
            cache.add(url).catch((err) => {
              console.warn('[Employee SW] Pre-cache skipped:', url, err.message);
            })
          )
        );
      })
      .then(() => self.skipWaiting())
  );
});

// ─── Activate: delete old caches ───
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith('mt-emp-') && k !== CACHE_NAME)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

// ─── Fetch: smart routing ───
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET requests — POST/PUT/DELETE always go straight to network
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // 1. Never touch API requests — always fresh from the server
  if (url.pathname.startsWith('/api/')) return;

  // 2. Never cache the service worker itself
  if (url.pathname === '/employee/sw.js') return;

  // 3. Only handle requests in our scope + shared assets + Font Awesome CDN
  const isEmployee = url.pathname === '/employee/' || url.pathname.startsWith('/employee/');
  const isShared = url.pathname.startsWith('/shared/');
  const isFontAwesome =
    url.hostname === 'cdnjs.cloudflare.com' &&
    url.pathname.includes('font-awesome');

  if (!isEmployee && !isShared && !isFontAwesome) return;

  // 4. Stale-while-revalidate: return cache immediately, refresh in background
  event.respondWith(
    caches.match(request).then((cached) => {
      const fetchPromise = fetch(request)
        .then((response) => {
          // Only cache successful responses we're allowed to read
          if (
            response &&
            response.status === 200 &&
            (response.type === 'basic' || response.type === 'cors')
          ) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, clone).catch(() => {});
            });
          }
          return response;
        })
        .catch(() => cached); // if network fails, fall back to cache

      // Return cached version immediately if we have one, else wait for network
      return cached || fetchPromise;
    })
  );
});

// ─── Message channel: clients can ask for immediate activation ───
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
