/**
 * MenuItemThumb — the list/detail product thumbnail.
 *
 * The redesigned menu list (GET /api/menu/list) deliberately ships NO image
 * bytes — only `hasImage` + an 8-char `imageVer` content hash. The bytes live
 * behind GET /api/pos/v2/item-image/:id, which sits behind the /api JWT gate; a
 * plain <img src> cannot send an Authorization header, so — exactly like the POS
 * ProductGrid — we fetch the image with the token and render it as an object
 * URL. `?v=<imageVer>` keys both the HTTP cache (immutable, 1y) and the small
 * in-memory cache below, so an image edit invalidates on the next list refetch.
 *
 * Never throws: a missing/corrupt image, a 401/403 (roles that can browse the
 * catalog but not the POS image route), or a jsdom environment with no
 * URL.createObjectURL all degrade to the neutral placeholder.
 */
import { useEffect, useState } from "react";
import { ImageOff } from "lucide-react";
import { cn } from "@/shared/lib";
import { getToken } from "@/shared/api";

const ITEM_IMAGE_API = "/api/pos/v2/item-image/";

// Object-URL cache, insertion-ordered + bounded so a long list can't pin many
// blobs. Evicted entries are revoked; they refetch from the HTTP cache if needed.
const cache = new Map<string, Promise<string | null>>();
const CACHE_MAX = 200;

function canMakeObjectUrl(): boolean {
  return typeof URL !== "undefined" && typeof URL.createObjectURL === "function";
}

function loadImage(id: string, version: string): Promise<string | null> {
  const key = `${id}?v=${version}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const p = (async (): Promise<string | null> => {
    if (!canMakeObjectUrl() || typeof fetch !== "function") return null;
    try {
      const headers: Record<string, string> = {};
      const token = getToken();
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch(
        `${ITEM_IMAGE_API}${encodeURIComponent(id)}?v=${encodeURIComponent(version)}`,
        { headers },
      );
      if (!res.ok) return null; // 404 corrupt/cleared, 401/403 — no photo, never a broken cell
      return URL.createObjectURL(await res.blob());
    } catch {
      return null; // offline / network error → placeholder
    }
  })();
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      const evicted = cache.get(oldest);
      cache.delete(oldest);
      void evicted?.then((url) => { if (url && canMakeObjectUrl()) URL.revokeObjectURL(url); });
    }
  }
  cache.set(key, p);
  return p;
}

/** Fetch-and-object-URL the per-item image; null until loaded / when absent.
 *  Shared by the list thumbnail and the product-page POS-card preview. */
export function useItemImage(id: string, imageVer: string | null | undefined, hasImage?: boolean): string | null {
  const show = (hasImage ?? !!imageVer) && !!imageVer;
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!show || !imageVer) { setSrc(null); return; }
    let alive = true;
    void loadImage(id, imageVer).then((url) => { if (alive) setSrc(url); });
    return () => { alive = false; };
  }, [id, imageVer, show]);
  return src;
}

export interface MenuItemThumbProps {
  id: string;
  imageVer: string | null | undefined;
  hasImage?: boolean;
  alt?: string;
  className?: string;
}

export function MenuItemThumb({ id, imageVer, hasImage, alt, className }: MenuItemThumbProps) {
  const src = useItemImage(id, imageVer, hasImage);

  return (
    <div
      className={cn(
        "grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-xl border border-slate-200 bg-slate-50",
        className,
      )}
    >
      {src ? (
        <img src={src} alt={alt ?? ""} className="h-full w-full object-cover" data-testid="menu-item-thumb" />
      ) : (
        <ImageOff className="h-4 w-4 text-slate-300" aria-hidden data-testid="menu-item-thumb-placeholder" />
      )}
    </div>
  );
}
