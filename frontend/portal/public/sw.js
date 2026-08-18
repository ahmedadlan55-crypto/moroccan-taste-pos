/**
 * بوابة الموظف (Employee Portal) — Service Worker
 * -----------------------------------------------------------------------------
 * Hand-rolled (no workbox), modeled on frontend/pos/public/sw.js:
 *   • App shell (HTML + JS)   → NETWORK-FIRST, cache fallback — deploys are
 *     never trapped behind a stale cache; offline still boots the last shell.
 *   • Static (css/img/fonts)  → stale-while-revalidate.
 *   • /api/*                  → NEVER cached, never intercepted.
 *   • Everything cross-origin or outside this SW's base → passed through.
 *
 * WHY THE SHELL IS CACHED AT ALL, given every screen needs the network: so the
 * app OPENS. An employee standing in a walk-in fridge with one bar of signal
 * taps the icon; a network-first shell with no cached fallback shows the
 * browser's offline page. Cached, it boots and shows its own honest "no
 * connection" state — and the moment signal returns, the clock button works.
 *
 * BASE-RELATIVE by design: every URL is resolved against this script's location
 * (self.location), which IS the scope root — so it works at / in dev and at
 * /employee/ in production with zero edits.
 *
 * ─── THE CACHE-PREFIX RULE ───────────────────────────────────────────────────
 * The Cache API is ORIGIN-GLOBAL, not scope-scoped: an unqualified sweep here
 * would delete the cashier's offline caches too, and the cashier's offline
 * caches are the ones holding un-synced sales. Every filter below is therefore
 * PREFIX-anchored with startsWith, never a substring test.
 *
 * On activate we also sweep `mt-emp-*` — the caches of the ORIGINAL employee
 * PWA that lived at this exact scope before commit e97ebfbf deleted it. A
 * device that still carries them would otherwise keep dead 2026 assets forever.
 * That sweep used to live in the /employee/sw.js tombstone that server.js
 * served in the gap; it moves here now that a real SW owns the URL again.
 */

/* eslint-disable no-restricted-globals */

const SW_VERSION = "1.0.0";
const CACHE_NAME = "mt-portal-" + SW_VERSION;

/** Scope root, base-relative: '/' in dev, '/employee/' in production. */
const BASE = new URL("./", self.location).pathname;

/** Vite build manifest (build.manifest in vite.config.ts), fetched at install. */
const ASSET_MANIFEST = "asset-manifest.json";

/** Shell entry points cached even if the asset-manifest fetch fails. */
const SHELL = ["./", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png"];

/** Collect every file the Vite manifest references (js, css, assets). */
function filesFromViteManifest(manifest) {
  const files = new Set();
  for (const key of Object.keys(manifest || {})) {
    const entry = manifest[key] || {};
    if (entry.file) files.add(entry.file);
    for (const list of [entry.css, entry.assets]) {
      if (Array.isArray(list)) for (const f of list) files.add(f);
    }
  }
  return [...files];
}

// ─── Install: precache the shell + hashed bundle ─────────────────────────────
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      let assetFiles = [];
      try {
        const res = await fetch(new URL(ASSET_MANIFEST, self.location).href, { cache: "no-cache" });
        if (res.ok) assetFiles = filesFromViteManifest(await res.json());
      } catch (err) {
        // Dev server / manifest missing — the fetch handler still caches lazily.
      }
      const urls = [...SHELL, ...assetFiles];
      // Individual adds: one failing resource must not sink the whole shell.
      await Promise.all(
        urls.map((u) =>
          cache.add(new Request(new URL(u, self.location).href, { cache: "no-cache" })).catch(() => {}),
        ),
      );
      await self.skipWaiting();
    })(),
  );
});

// ─── Activate: drop old portal caches + the retired PWA's, claim clients ─────
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      // PREFIX-anchored (see the cache-prefix rule at the top of this file):
      // older mt-portal-* versions of this SW, plus mt-emp-* from the original
      // employee PWA that owned this scope before it was deleted.
      const stale = keys.filter(
        (k) => (k.startsWith("mt-portal-") || k.startsWith("mt-emp-")) && k !== CACHE_NAME,
      );
      await Promise.all(stale.map((k) => caches.delete(k)));
      await self.clients.claim();
      // Old caches existed → this is an UPDATE, not a first install.
      if (stale.length > 0) {
        const clients = await self.clients.matchAll({ type: "window" });
        for (const client of clients) {
          client.postMessage({ type: "PORTAL_SW_UPDATED", version: SW_VERSION });
        }
      }
    })(),
  );
});

// ─── Fetch: network-first (html/js) / SWR (static) / API passthrough ─────────
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // 1. API is sacred — always network, never cached, never intercepted. A
  //    cached attendance row or leave balance is a WRONG answer, not a stale
  //    one: an employee must never be shown yesterday's clock state as today's.
  if (url.pathname.startsWith("/api/")) return;

  // 2. Never cache the service worker itself.
  if (url.origin === self.location.origin && url.pathname === self.location.pathname) return;

  // 3. Only handle same-origin requests inside our base (cross-origin passes
  //    through untouched — the production CSP blocks it anyway).
  if (url.origin !== self.location.origin || !url.pathname.startsWith(BASE)) return;

  const isNavigation = request.mode === "navigate";
  const isHtml = isNavigation || url.pathname.endsWith(".html") || url.pathname.endsWith("/");
  const isJs = url.pathname.endsWith(".js");

  if (isHtml || isJs) {
    // NETWORK-FIRST: users always pick up freshly deployed code; the cached
    // copy only serves when the network is down.
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.status === 200 && (response.type === "basic" || response.type === "cors")) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone).catch(() => {}));
          }
          return response;
        })
        .catch(async () => {
          // ignoreVary: the server's cors middleware stamps `Vary: Origin` on
          // every response, and module/CSS requests carry an Origin header the
          // install-time precache fetch did not — without this flag the cached
          // bundle NEVER matches and the offline shell boots blank. This exact
          // omission once shipped as a live offline-killer; do not remove it.
          const cached = await caches.match(request, { ignoreVary: true });
          if (cached) return cached;
          // SPA fallback: any offline navigation inside the scope boots the shell.
          if (isNavigation) {
            const shell = await caches.match(new URL("./", self.location).href, { ignoreVary: true });
            if (shell) return shell;
          }
          return Response.error();
        }),
    );
    return;
  }

  // STALE-WHILE-REVALIDATE for css / images / fonts / manifest.
  // (ignoreVary for the same `Vary: Origin` reason as the branch above.)
  event.respondWith(
    caches.match(request, { ignoreVary: true }).then((cached) => {
      const fetchPromise = fetch(request)
        .then((response) => {
          if (response && response.status === 200 && (response.type === "basic" || response.type === "cors")) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone).catch(() => {}));
          }
          return response;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    }),
  );
});

// ─── Messages: page can force immediate takeover ─────────────────────────────
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
