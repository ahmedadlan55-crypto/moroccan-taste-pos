/**
 * PWA runtime — service-worker registration, install prompt, update signal.
 *
 * A tiny framework-free external store (useSyncExternalStore-friendly, same
 * pattern as the offline engine) so the Header can render:
 *   • an install button while the browser holds a deferred
 *     `beforeinstallprompt` event, and
 *   • a «نسخة جديدة — تحديث» action when a NEW service worker took over
 *     (sw.js posts POSV2_SW_UPDATED after activate — skipWaiting+claim means
 *     the running page still executes the OLD bundle until it reloads).
 *
 * Registration is PRODUCTION-ONLY: the dev server has no built asset manifest
 * and a dev SW would fight Vite's HMR. The URL is base-relative
 * (import.meta.env.BASE_URL) so the identical code registers /pos-v2/sw.js
 * today and /pos/sw.js after cutover.
 */

// Chromium-only event, not in lib.dom — minimal local typing.
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export interface PwaStatus {
  /** A deferred install prompt is available (browser deems the app installable). */
  canInstall: boolean;
  /** A new service worker version activated — a reload picks up the new bundle. */
  updateReady: boolean;
  /**
   * The deploy watcher's target entry bundle (hashed basename) when updateReady
   * came from a detected redeploy — null for SW-triggered updates. Used to
   * guard the idle auto-reload against loops (one attempt per target).
   */
  updateTarget: string | null;
}

let status: PwaStatus = { canInstall: false, updateReady: false, updateTarget: null };
let deferredPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
let initialized = false;

function setStatus(patch: Partial<PwaStatus>): void {
  status = { ...status, ...patch };
  listeners.forEach((fn) => fn());
}

export function subscribePwa(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getPwaStatus(): PwaStatus {
  return status;
}

// ─── Deploy watcher ──────────────────────────────────────────────────────────
// sw.js serves HTML/JS network-first, so any RELOAD picks up a new deploy —
// but a cashier kiosk tab never navigates and never reloads, so nothing ever
// told it a deploy happened: fixes shipped to production kept NOT reaching
// long-lived devices (the SW only announces updates when sw.js ITSELF
// changes, which app-code deploys don't touch). The watcher compares the
// entry bundle this page is EXECUTING against the entry in the freshly
// served asset-manifest.json; a mismatch raises the same updateReady signal
// the Header's «نسخة جديدة — تحديث» button already renders, and App may
// auto-reload when the register is idle.

const MANIFEST_CHECK_INTERVAL_MS = 5 * 60_000;
const AUTO_RELOAD_GUARD_KEY = "posv2-auto-reload-target";
let swReg: ServiceWorkerRegistration | null = null;

/** Hashed basename of the build's entry chunk from a Vite manifest, or null. */
export function manifestEntryBasename(manifest: unknown): string | null {
  if (!manifest || typeof manifest !== "object") return null;
  for (const value of Object.values(manifest as Record<string, unknown>)) {
    const entry = value as { file?: unknown; isEntry?: unknown };
    if (entry && entry.isEntry === true && typeof entry.file === "string") {
      return entry.file.split("/").pop() || null;
    }
  }
  return null;
}

/**
 * Hashed basename of the entry chunk THIS page is executing, read from the
 * module <script> the served index.html carried. Comparing against the DOM
 * (not a boot-time manifest snapshot) means a deploy landing between page
 * load and first poll is still detected.
 */
export function runningEntryBasename(doc: Document = document): string | null {
  const src = doc.querySelector('script[type="module"][src]')?.getAttribute("src");
  if (!src) return null;
  try {
    return new URL(src, "http://local.invalid").pathname.split("/").pop() || null;
  } catch {
    return null;
  }
}

export function updateAvailable(running: string | null, target: string | null): boolean {
  return !!running && !!target && running !== target;
}

/** One auto-reload attempt per target: if the reload didn't converge (e.g. an
 *  intermediary cached index.html), we must not spin — the manual button stays. */
export function autoReloadAlreadyTried(target: string): boolean {
  try {
    return sessionStorage.getItem(AUTO_RELOAD_GUARD_KEY) === target;
  } catch {
    return true; // storage unavailable → never auto-reload, manual only
  }
}
export function markAutoReloadTried(target: string): void {
  try {
    sessionStorage.setItem(AUTO_RELOAD_GUARD_KEY, target);
  } catch {
    /* storage unavailable — autoReloadAlreadyTried already reports true */
  }
}

/**
 * One poll: fetch the served manifest, compare with the running entry, raise
 * updateReady on mismatch. Silent on any failure — offline or a mid-deploy
 * 404 must never surface to the cashier. Returns whether an update was found.
 */
export async function checkForDeployedUpdate(
  fetchImpl?: typeof fetch,
  doc?: Document,
): Promise<boolean> {
  const doFetch = fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  try {
    const res = await doFetch(`${import.meta.env.BASE_URL}asset-manifest.json`, { cache: "no-store" });
    if (!res.ok) return false;
    const target = manifestEntryBasename(await res.json());
    const running = runningEntryBasename(doc ?? document);
    if (!updateAvailable(running, target)) return false;
    setStatus({ updateReady: true, updateTarget: target });
    return true;
  } catch {
    return false;
  }
}

/**
 * Wire everything once (idempotent — React StrictMode double-effects safe).
 * Called from App on mount.
 */
export function initPwa(): void {
  if (initialized || typeof window === "undefined") return;
  initialized = true;

  // ── Install prompt hook ────────────────────────────────────────────────────
  window.addEventListener("beforeinstallprompt", (e: Event) => {
    e.preventDefault(); // keep it for our own button
    deferredPrompt = e as BeforeInstallPromptEvent;
    setStatus({ canInstall: true });
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    setStatus({ canInstall: false });
  });

  // ── Deploy watcher (production builds only — dev has no asset manifest) ────
  if (!import.meta.env.PROD) return;
  const runCheck = () => {
    if (!navigator.onLine) return; // pointless offline; 'online' re-arms below
    void checkForDeployedUpdate();
    // Nudge the SW update check too: browsers only re-fetch sw.js on
    // navigation, and a kiosk tab never navigates.
    swReg?.update().catch(() => {});
  };
  window.setInterval(runCheck, MANIFEST_CHECK_INTERVAL_MS);
  window.addEventListener("online", runCheck);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") runCheck();
  });

  // ── Service worker ─────────────────────────────────────────────────────────
  if (!("serviceWorker" in navigator)) return;

  navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
    if (event.data && event.data.type === "POSV2_SW_UPDATED") {
      setStatus({ updateReady: true });
    }
  });

  const swUrl = `${import.meta.env.BASE_URL}sw.js`;
  navigator.serviceWorker
    .register(swUrl) // scope defaults to BASE_URL — exactly what we want
    .then((reg) => {
      swReg = reg;
      // Belt-and-braces: a worker already waiting (page loaded between install
      // and activate) is also an update signal.
      if (reg.waiting) setStatus({ updateReady: true });
      reg.addEventListener("updatefound", () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener("statechange", () => {
          // A NEW worker activated while an old controller exists → update.
          if (nw.state === "activated" && navigator.serviceWorker.controller) {
            setStatus({ updateReady: true });
          }
        });
      });
    })
    .catch(() => {
      /* registration failure is non-fatal — the app simply isn't offline-capable */
    });
}

/** Show the browser install prompt (only meaningful while canInstall). */
export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const p = deferredPrompt;
  if (!p) return "unavailable";
  deferredPrompt = null;
  setStatus({ canInstall: false });
  try {
    await p.prompt();
    const choice = await p.userChoice;
    if (choice.outcome !== "accepted") {
      // The browser may re-fire beforeinstallprompt later; until then hide.
      return "dismissed";
    }
    return "accepted";
  } catch {
    return "unavailable";
  }
}

/** Apply a ready update — the new SW already controls the page; reload swaps the bundle. */
export function applyUpdate(): void {
  if (typeof window !== "undefined") window.location.reload();
}
