/**
 * كاشير المذاق (Cashier V2) — Service Worker
 * -----------------------------------------------------------------------------
 * Hand-rolled (no workbox), modeled on the battle-tested legacy /pos/sw.js:
 *   • App shell (HTML + JS)   → NETWORK-FIRST, cache fallback — deploys are
 *     never trapped behind a stale cache; offline still boots the last shell.
 *   • Static (css/img/fonts)  → stale-while-revalidate.
 *   • /api/*                  → NEVER cached, never intercepted.
 *   • Everything cross-origin or outside this SW's base → passed through.
 *
 * BASE-RELATIVE by design: every URL is resolved against this script's
 * location (self.location), which IS the scope root. The same file works at
 * /pos-v2/ today and at /pos/ after cutover — zero edits.
 *
 * Precache: at install time the SW fetches Vite's build manifest
 * (asset-manifest.json — build.manifest in vite.config.ts; emitted at the
 * dist ROOT because express.static ignores dotfile paths like .vite/) and
 * caches every hashed asset it lists, plus the shell entry points.
 *
 * CACHE_NAME is versioned and namespaced `mt-posv2-*` — it can NEVER collide
 * with the legacy PWA's `mt-pos-v61-warehouse-rollout` (different prefix AND
 * different scope). On activate, older mt-posv2-* caches are deleted and every
 * client is told a new version took over (the app shows «نسخة جديدة — تحديث»).
 */

/* eslint-disable no-restricted-globals */

const SW_VERSION = "1.0.1"; // 1.0.1: ignoreVary matches (cors Vary: Origin broke offline shell)
const CACHE_NAME = "mt-posv2-" + SW_VERSION;

// Scope root, base-relative: '/pos-v2/' today, '/pos/' after cutover.
const BASE = new URL("./", self.location).pathname;

// Vite build manifest (see vite.config.ts build.manifest) — maps entries to
// their hashed asset files. Fetched fresh at install time.
const ASSET_MANIFEST = "asset-manifest.json";

// Shell entry points cached even if the asset manifest fetch fails.
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

// ─── Activate: drop old mt-posv2-* caches, claim clients, announce update ────
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      // Sweep BOTH generations: older mt-posv2-* versions of this SW, and the
      // retired legacy POS caches (mt-pos-v61-* …) orphaned when this SW took
      // over the legacy registration URL (/pos/sw.js) at cutover.
      const stale = keys.filter((k) => (k.startsWith("mt-posv2-") || k.startsWith("mt-pos-v")) && k !== CACHE_NAME);
      await Promise.all(stale.map((k) => caches.delete(k)));
      await self.clients.claim();
      // Old caches existed → this is an UPDATE, not a first install: tell every
      // open client so the app can offer «نسخة جديدة — تحديث».
      if (stale.length > 0) {
        const clients = await self.clients.matchAll({ type: "window" });
        for (const client of clients) {
          client.postMessage({ type: "POSV2_SW_UPDATED", version: SW_VERSION });
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

  // 1. API is sacred — always network, never cached, never intercepted.
  if (url.pathname.startsWith("/api/")) return;

  // 2. Never cache the service worker itself.
  if (url.origin === self.location.origin && url.pathname === self.location.pathname) return;

  // 3. Only handle same-origin requests inside our base (cross-origin fonts/CDN
  //    pass through untouched — prod CSP blocks them anyway).
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
          // bundle NEVER matches and the offline shell boots blank.
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
