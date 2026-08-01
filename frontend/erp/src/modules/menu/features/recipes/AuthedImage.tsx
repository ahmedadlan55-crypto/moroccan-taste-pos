// ═══════════════════════════════════════════════════════════════════════════
// A product thumbnail fetched WITH the session token.
//
// WHY THIS EXISTS. `/api/recipes/product-image/...` sits behind the global JWT
// gate, and this app authenticates with `Authorization: Bearer <token>` read
// from localStorage — a header a plain `<img src>` cannot send. Pointing an
// <img> at the endpoint therefore returns 401 for EVERY row, and because the
// browser reports a broken image rather than an error the grid just looks
// image-less. The E2E deep-link sweep caught it as "failed API requests:
// 401 /api/recipes/product-image/…".
//
// The alternative — exempting the endpoint from the auth gate — was rejected:
// it would add a new unauthenticated surface, and "menu images are already
// public through /api/menu" is a reason to fix that, not to copy it.
//
// So: fetch the bytes with the token, hand the <img> an object URL. The
// response is served immutable + ETagged, so the browser still caches the
// bytes; the module-level cache below stops N rows re-fetching the same URL
// within a session and stops a re-render creating a second blob.
// ═══════════════════════════════════════════════════════════════════════════
import { useEffect, useState } from "react";

const TOKEN_KEYS = ["pos_token", "token", "jwt"] as const;
function authToken(): string | null {
  for (const k of TOKEN_KEYS) {
    const v = localStorage.getItem(k);
    if (v) return v;
  }
  return null;
}

/** url → object URL. Kept for the page's lifetime; the blob is small and the
 *  underlying HTTP response is immutable, so re-fetching would be pure waste. */
const cache = new Map<string, string>();
/** url → in-flight request, so ten rows sharing an image issue ONE fetch. */
const inFlight = new Map<string, Promise<string | null>>();

async function load(url: string): Promise<string | null> {
  const hit = cache.get(url);
  if (hit) return hit;
  const pending = inFlight.get(url);
  if (pending) return pending;

  const p = (async () => {
    try {
      const token = authToken();
      const res = await fetch(url, {
        headers: token ? { Authorization: "Bearer " + token } : {},
        credentials: "same-origin",
      });
      // 404 is a legitimate answer (no image / corrupt stored data) and must not
      // be treated as a failure — the caller simply renders the placeholder.
      if (!res.ok) return null;
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      cache.set(url, objectUrl);
      return objectUrl;
    } catch {
      return null;
    } finally {
      inFlight.delete(url);
    }
  })();
  inFlight.set(url, p);
  return p;
}

export function AuthedImage({
  src,
  alt,
  className,
  fallback,
}: {
  /** Null when the product has no image — nothing is fetched. */
  src: string | null;
  alt: string;
  className?: string;
  fallback: React.ReactNode;
}) {
  const [objectUrl, setObjectUrl] = useState<string | null>(() => (src ? cache.get(src) ?? null : null));

  useEffect(() => {
    if (!src) {
      setObjectUrl(null);
      return;
    }
    const cached = cache.get(src);
    if (cached) {
      setObjectUrl(cached);
      return;
    }
    let alive = true;
    load(src).then((u) => {
      if (alive) setObjectUrl(u);
    });
    return () => {
      alive = false;
    };
  }, [src]);

  // No image, or it could not be loaded → the caller's placeholder. Never a
  // broken-image icon.
  if (!src || !objectUrl) return <>{fallback}</>;
  return <img src={objectUrl} alt={alt} className={className} loading="lazy" decoding="async" />;
}
