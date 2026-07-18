/**
 * Product grid + instant client-side search / barcode box.
 *
 * Barcode note (Phase U): a scanned code resolves LOCALLY from the cached
 * catalog. A PER-UNIT barcode wins first — scanning a carton barcode adds ONE
 * carton (the unit's factor is frozen at add time); otherwise the item's primary
 * (base) barcode or catalog id adds one BASE unit; finally a name substring.
 * All offline, no round-trip.
 */
import { forwardRef, memo, useEffect, useMemo, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { PackageSearch, Search, X } from "lucide-react";
import type { Catalog, CatalogItem } from "@/lib/types";
import { getToken } from "@/lib/auth";
import { fmt2 } from "@/lib/format";
import { cn, EmptyState, Skeleton } from "./ui";

// ── Item images (close/d-images) ─────────────────────────────────────────────
// The catalog carries only `imageVersion` (an 8-char content hash) — the bytes
// live behind GET /api/pos/v2/item-image/:id. That endpoint sits behind the
// global /api JWT gate and a plain <img src> cannot send an Authorization
// header, so images are fetched with the POS token and rendered as object URLs
// (the same fetch→objectURL pattern the ERP uses for authenticated downloads).
// `?v=<imageVersion>` keys both the browser HTTP cache (the response is
// `public, max-age=31536000, immutable`) and the in-memory cache below, so an
// image edit invalidates on the next catalog sync with no manual busting.
//
// The API base is deliberately ABSOLUTE: /api/* is mounted at the server root
// no matter where this SPA is served (/pos-v2/ today, /pos/ after the cutover),
// so — unlike anything derived from import.meta.env.BASE_URL — it survives the
// move unchanged.
const ITEM_IMAGE_API = "/api/pos/v2/item-image/";

/** Object-URL cache, insertion-ordered. Bounded so scrolling a 2,000-item
 *  catalog can't pin hundreds of MB of blobs: evicted entries (long unmounted
 *  by then — only ~50 cards are ever live) are revoked and simply refetch from
 *  the HTTP cache if the cashier scrolls back. */
const imageCache = new Map<string, Promise<string | null>>();
const IMAGE_CACHE_MAX = 300;

function loadItemImage(id: string, version: string): Promise<string | null> {
  const key = `${id}?v=${version}`;
  const hit = imageCache.get(key);
  if (hit) return hit;
  const p = (async (): Promise<string | null> => {
    try {
      const headers: Record<string, string> = {};
      const token = getToken();
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch(`${ITEM_IMAGE_API}${encodeURIComponent(id)}?v=${encodeURIComponent(version)}`, { headers });
      if (!res.ok) return null; // 404 corrupt/cleared, 401 logged-out — no photo, never a broken grid
      return URL.createObjectURL(await res.blob());
    } catch {
      return null; // offline / network error — the card just shows no photo
    }
  })();
  if (imageCache.size >= IMAGE_CACHE_MAX) {
    const oldest = imageCache.keys().next().value;
    if (oldest !== undefined) {
      const evicted = imageCache.get(oldest);
      imageCache.delete(oldest);
      void evicted?.then((url) => { if (url) URL.revokeObjectURL(url); });
    }
  }
  imageCache.set(key, p);
  return p;
}

function useItemImage(id: string, version: string | null | undefined): string | null {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!version) { setSrc(null); return; }
    let alive = true;
    void loadItemImage(id, version).then((url) => { if (alive) setSrc(url); });
    return () => { alive = false; };
  }, [id, version]);
  return version ? src : null;
}

export function filterItems(items: CatalogItem[], category: string | null, query: string): CatalogItem[] {
  const q = query.trim().toLowerCase();
  return items.filter((it) => {
    if (!it.active) return false; // inactive items are unsellable → hidden
    if (category && it.category !== category) return false;
    if (!q) return true;
    return it.id.toLowerCase() === q || it.name.toLowerCase().includes(q) || it.id.toLowerCase().includes(q);
  });
}

/** A resolved scan: the item + the unit to add it in (null = base unit). */
export interface ScanHit {
  item: CatalogItem;
  unitCode: string | null;
}

/** Scanner Enter-key resolution: per-unit barcode → primary barcode → id → name. */
export function resolveScan(items: CatalogItem[], query: string): ScanHit | null {
  const q = query.trim();
  if (!q) return null;
  const ql = q.toLowerCase();
  const active = items.filter((i) => i.active);
  // 1) exact per-unit barcode (a carton barcode adds a carton)
  for (const it of active) {
    for (const u of it.units || []) {
      if (u.barcode && u.barcode.toLowerCase() === ql) return { item: it, unitCode: u.unitCode };
    }
  }
  // 2) exact primary (base) barcode
  for (const it of active) {
    if (it.barcode && it.barcode.toLowerCase() === ql) return { item: it, unitCode: null };
  }
  // 3) exact catalog id, then name/id substring — always the base unit
  const byId = active.find((i) => i.id.toLowerCase() === ql);
  if (byId) return { item: byId, unitCode: null };
  const results = filterItems(items, null, q);
  return results[0] ? { item: results[0], unitCode: null } : null;
}

const ProductCard = memo(function ProductCard({ item, onAdd }: { item: CatalogItem; onAdd: (item: CatalogItem) => void }) {
  const imgSrc = useItemImage(item.id, item.imageVersion);
  return (
    <button
      type="button"
      onClick={() => onAdd(item)}
      className="btn-press group relative flex min-h-[5.5rem] flex-col justify-between rounded-2xl border border-slate-200 bg-white p-3 text-start shadow-sm transition hover:border-teal-200 hover:shadow-soft"
    >
      {item.isCombo ? (
        // العروض (close/w25-combos): tapping this card opens the combo chooser,
        // not a direct add — the badge says so (legacy amber «عرض» badge).
        <span
          data-testid="combo-badge"
          className="absolute end-1.5 top-1.5 z-[1] rounded-md bg-amber-500 px-1.5 py-0.5 text-[10px] font-extrabold text-white shadow-sm"
        >
          عرض
        </span>
      ) : null}
      {item.imageVersion ? (
        // FIXED height, reserved from first paint: the box exists before (and
        // whether or not) the bytes arrive, so a finished download never changes
        // the card's height — the virtualizer's measured rows stay put (no
        // reflow, no scroll jump). Rendered ONLY when the item has an image.
        <div data-testid="product-thumb" aria-hidden className="mb-2 h-16 w-full shrink-0 overflow-hidden rounded-xl bg-slate-100">
          {imgSrc ? (
            <img
              key={imgSrc}
              src={imgSrc}
              alt=""
              loading="lazy"
              decoding="async"
              draggable={false}
              className="h-full w-full object-cover"
              // Graceful: a corrupt blob hides ITSELF (the box keeps the row
              // height stable); keyed by src so a later good image starts fresh.
              onError={(e) => { e.currentTarget.style.display = "none"; }}
            />
          ) : null}
        </div>
      ) : null}
      <p className="line-clamp-2 text-sm font-extrabold leading-snug text-ink group-hover:text-teal-700">{item.name}</p>
      <p className="mt-2 text-sm font-extrabold text-teal-600">
        <span className="num">{fmt2(item.price)}</span> <span className="text-[11px] font-bold text-slate-400">ر.س</span>
      </p>
    </button>
  );
});

export interface ProductGridProps {
  catalog: Catalog | null;
  loading: boolean;
  category: string | null;
  query: string;
  onQueryChange: (q: string) => void;
  onScanSubmit: () => void;
  onAdd: (item: CatalogItem) => void;
  /** The element that actually scrolls the grid — the host owns it, so it has to
   *  hand it down for windowing to have an axis to measure.
   *
   *  It must be STATE in the host, not a ref: React attaches a child's refs and
   *  runs its effects BEFORE the parent's ref callback, so a ref passed down here
   *  is still null when the virtualizer first reads it, and nothing would ever
   *  re-trigger the read — the grid would stay permanently empty.
   *
   *  Omit the prop entirely and the grid renders every item (correct, unwindowed). */
  scrollElement?: HTMLElement | null;
}

export const SearchBox = forwardRef<HTMLInputElement, Pick<ProductGridProps, "query" | "onQueryChange" | "onScanSubmit">>(
  function SearchBox({ query, onQueryChange, onScanSubmit }, ref) {
    return (
      <div className="relative">
        <Search className="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
        <input
          ref={ref}
          type="search"
          inputMode="search"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onScanSubmit();
            }
          }}
          placeholder="بحث أو مسح باركود… (F2)"
          aria-label="بحث في الأصناف أو مسح باركود"
          className="field pe-9"
        />
        {query ? (
          <button
            type="button"
            onClick={() => onQueryChange("")}
            aria-label="مسح البحث"
            className="absolute start-1.5 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        ) : null}
      </div>
    );
  },
);

/** Mirrors the Tailwind classes below (`grid-cols-2 sm:grid-cols-3 xl:grid-cols-4`).
 *  These are VIEWPORT media queries, so the column count follows window width —
 *  not the container's. If those classes change, change this with them. */
const colsFor = (w: number) => (w >= 1280 ? 4 : w >= 640 ? 3 : 2);
/** Card min-height (5.5rem = 88px) + the 2.5 gap (10px). The virtualizer measures
 *  each real row anyway; this only has to be close enough to size the scrollbar
 *  before anything is measured. */
const ROW_ESTIMATE = 98;
const GRID_CLASS = "grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-4";

function useColumns(): number {
  const [cols, setCols] = useState(() => (typeof window === "undefined" ? 2 : colsFor(window.innerWidth)));
  useEffect(() => {
    const onResize = () => setCols(colsFor(window.innerWidth));
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return cols;
}

export function ProductGrid({ catalog, loading, category, query, onAdd, scrollElement }: Omit<ProductGridProps, "onQueryChange" | "onScanSubmit">) {
  const visible = useMemo(
    () => (catalog ? filterItems(catalog.items, category, query) : []),
    [catalog, category, query],
  );
  const cols = useColumns();
  const rowCount = Math.ceil(visible.length / cols);
  // Windowed by ROW, not by card: the grid is 2-4 columns, so the scroll axis is
  // rows. The catalog is ~2,000 items × 5 nodes = ~10k DOM nodes if we map the
  // whole array, which is what this used to do. ProductCard is memoised and onAdd
  // is a stable useCallback, so re-render churn was never the cost — mounting and
  // laying out 10k nodes was.
  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollElement ?? null,
    estimateSize: () => ROW_ESTIMATE,
    // Rows are measured (a long name can wrap and push a card past its min-height),
    // but a height of 0 is never a real row — it means layout has not run yet.
    // Trusting it would collapse every row to nothing and blank the grid.
    measureElement: (el) => (el as HTMLElement).getBoundingClientRect().height || ROW_ESTIMATE,
    overscan: 4,
  });

  if (loading) {
    return (
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 12 }, (_, i) => (
          <Skeleton key={i} className="min-h-[5.5rem]" />
        ))}
      </div>
    );
  }

  if (!visible.length) {
    return (
      <EmptyState
        icon={<PackageSearch className="h-10 w-10" aria-hidden />}
        title="لا نتائج"
        hint={query ? "جرّب كلمة أخرى أو امسح الباركود مرة أخرى" : "لا توجد أصناف نشطة في هذا التصنيف"}
      />
    );
  }

  // The host opted out of windowing entirely (prop absent — distinct from null,
  // which means "attaching"). Render everything rather than window against
  // nothing and show a blank grid.
  if (scrollElement === undefined) {
    return (
      <div className={cn(GRID_CLASS)}>
        {visible.map((item) => (
          <ProductCard key={item.id} item={item} onAdd={onAdd} />
        ))}
      </div>
    );
  }

  return (
    <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative", width: "100%" }}>
      {rowVirtualizer.getVirtualItems().map((vRow) => {
        const start = vRow.index * cols;
        return (
          <div
            key={vRow.key}
            data-index={vRow.index}
            data-testid="product-row"
            ref={rowVirtualizer.measureElement}
            // left+right rather than an inline-start offset: the row spans the full
            // width, so this is direction-agnostic and stays correct in RTL.
            style={{ position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${vRow.start}px)` }}
            className={cn(GRID_CLASS, "pb-2.5")}
          >
            {visible.slice(start, start + cols).map((item) => (
              <ProductCard key={item.id} item={item} onAdd={onAdd} />
            ))}
          </div>
        );
      })}
    </div>
  );
}
