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
}

let status: PwaStatus = { canInstall: false, updateReady: false };
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

  // ── Service worker (production builds only) ────────────────────────────────
  if (!import.meta.env.PROD) return;
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
