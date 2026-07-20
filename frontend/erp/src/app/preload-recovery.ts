const RELOAD_STAMP_KEY = "erp:preload-reload-at";
const DEFAULT_COOLDOWN_MS = 30_000;

interface PreloadRecoveryOptions {
  target?: EventTarget;
  storage?: Pick<Storage, "getItem" | "setItem">;
  reload?: () => void;
  now?: () => number;
  cooldownMs?: number;
}

/**
 * Vite emits `vite:preloadError` when a tab from the previous deployment asks
 * for a hashed lazy chunk that no longer exists. Refresh once so the tab loads
 * the new entry manifest; the cooldown prevents a broken deployment from
 * creating a reload loop.
 */
export function installPreloadRecovery(options: PreloadRecoveryOptions = {}) {
  const target = options.target ?? window;
  let storage = options.storage;
  if (!storage) {
    try {
      storage = window.sessionStorage;
    } catch {
      // Some privacy modes expose window but block the storage getter itself.
    }
  }
  const reload = options.reload ?? (() => window.location.reload());
  const now = options.now ?? Date.now;
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  let inMemoryReload = 0;

  const handlePreloadError: EventListener = (event) => {
    const currentTime = now();
    let previousReload = inMemoryReload;
    try {
      previousReload = Math.max(previousReload, Number(storage?.getItem(RELOAD_STAMP_KEY) || 0));
    } catch {
      // The in-memory stamp still prevents repeated events before navigation.
    }

    if (previousReload > 0 && currentTime - previousReload < cooldownMs) return;

    event.preventDefault();
    inMemoryReload = currentTime;
    try {
      storage?.setItem(RELOAD_STAMP_KEY, String(currentTime));
    } catch {
      // The in-memory stamp still protects this document from a reload loop.
    }
    reload();
  };

  target.addEventListener("vite:preloadError", handlePreloadError);
  return () => target.removeEventListener("vite:preloadError", handlePreloadError);
}
