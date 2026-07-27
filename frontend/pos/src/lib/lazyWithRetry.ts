/**
 * A dynamic import that survives a bad few seconds.
 *
 * WHY THIS EXISTS — a real production incident. A till had the register open
 * while a deploy restarted the server. The cashier tapped a lazily-loaded
 * dialog inside that window, `/pos/assets/<chunk>.js` answered 502, React.lazy
 * rejected, and — because Suspense does not catch rejections — the app-level
 * error boundary replaced the whole register with the crash screen. A missing
 * dialog had cost the cart.
 *
 * Two things are wrong with a bare `lazy(() => import(...))` on a PWA till:
 *
 *  1. A CHUNK FETCH IS NOT RELIABLE. Deploys restart the origin, tills run on
 *     café wifi, and a proxy can drop one request out of a thousand. Almost
 *     every one of those failures is gone a second later.
 *
 *  2. REACT CACHES THE REJECTION FOREVER. The rejected promise is stored on
 *     the lazy component object itself, so re-rendering it — even after
 *     remounting the Suspense boundary with a new key — replays the SAME
 *     rejection. A "Retry" button wired to a re-render is therefore a lie: it
 *     shows a spinner and fails again, every time. (Proven by
 *     components/__tests__/lazy-chunk-failure.test.tsx.)
 *
 * So the retry has to live INSIDE the factory, before React ever sees a
 * rejection. Three attempts with a short backoff covers a server restart
 * window without making a genuinely-missing chunk take ten seconds to report.
 * If all attempts fail the rejection propagates as normal and the caller's
 * boundary shows an honest message whose only real recovery is a reload.
 */

const ATTEMPTS = 3;
/** 0ms, then 400ms, then 1200ms — ~1.6s total, which spans a container swap. */
const BACKOFF_MS = [0, 400, 1200];

export function retryImport<T>(factory: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const attempt = (n: number): void => {
      factory().then(resolve, (err: unknown) => {
        if (n >= ATTEMPTS - 1) {
          reject(err);
          return;
        }
        setTimeout(() => attempt(n + 1), BACKOFF_MS[n + 1] ?? 1200);
      });
    };
    attempt(0);
  });
}
