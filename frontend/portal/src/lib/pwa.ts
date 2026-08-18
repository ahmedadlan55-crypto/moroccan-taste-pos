// Service-worker registration and the install prompt.
//
// Registration lives here, not in an inline <script>: the production CSP is
// `script-src 'self'` (server.js), which blocks inline scripts outright.
//
// The scope is base-relative so one build works at / in dev and /employee/ in
// production. It is also the SAME URL the retired PWA registered — a device
// that still carries the old registration gets replaced by this one, and the
// activate handler sweeps its `mt-emp-*` caches.

export interface PwaHandle {
  /** Fires when a newer SW takes over and the page is running old code. */
  onUpdateAvailable: (cb: () => void) => void;
  /** True once the browser has offered an install prompt we can replay. */
  canInstall: () => boolean;
  onInstallAvailable: (cb: () => void) => void;
  /** Replays the deferred prompt. Resolves true if the user accepted. */
  promptInstall: () => Promise<boolean>;
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const updateCallbacks: (() => void)[] = [];
const installCallbacks: (() => void)[] = [];

export function initPwa(): PwaHandle {
  if (typeof window !== "undefined") {
    window.addEventListener("beforeinstallprompt", (e) => {
      // Chrome shows its own mini-infobar unless the event is cancelled; we
      // defer it so the prompt appears where the app chooses, not mid-clock.
      e.preventDefault();
      deferredPrompt = e as BeforeInstallPromptEvent;
      for (const cb of installCallbacks) cb();
    });

    window.addEventListener("appinstalled", () => {
      deferredPrompt = null;
    });
  }

  if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
    // After load: registering during boot competes with the app's own first
    // paint and its first data fetch on a phone.
    window.addEventListener("load", () => {
      const swUrl = new URL("sw.js", document.baseURI).href;
      void navigator.serviceWorker.register(swUrl, { scope: new URL("./", document.baseURI).pathname });
    });

    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data && event.data.type === "PORTAL_SW_UPDATED") {
        for (const cb of updateCallbacks) cb();
      }
    });
  }

  return {
    onUpdateAvailable: (cb) => updateCallbacks.push(cb),
    canInstall: () => deferredPrompt !== null,
    onInstallAvailable: (cb) => installCallbacks.push(cb),
    promptInstall: async () => {
      if (!deferredPrompt) return false;
      const evt = deferredPrompt;
      // One prompt per event — Chrome refuses a replay, so drop the reference
      // before awaiting rather than after.
      deferredPrompt = null;
      await evt.prompt();
      const choice = await evt.userChoice;
      return choice.outcome === "accepted";
    },
  };
}

/** True when the app is running from the home screen rather than a browser tab. */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const iosStandalone = (window.navigator as unknown as { standalone?: boolean }).standalone === true;
  return iosStandalone || window.matchMedia?.("(display-mode: standalone)")?.matches === true;
}

/** iOS Safari never fires beforeinstallprompt — it needs a written instruction. */
export function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !("MSStream" in window);
}
