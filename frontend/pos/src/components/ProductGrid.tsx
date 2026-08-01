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
import { Minus, PackageSearch, Search, X } from "lucide-react";
import { useLocalizedName, useT } from "@/i18n/I18nProvider";
import type { Catalog, CatalogItem } from "@/lib/types";
import { getToken } from "@/lib/auth";
import { fmtPrice, fmtQty } from "@/lib/format";
import { displayUnitPrice, DEFAULT_VAT_RATE_PCT } from "@/lib/cartMath";
import { getQuickPicks, QUICK_PICKS_CATEGORY, useQuickPicks } from "@/lib/quickPicks";
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

/** Every barcode an item can be found by: the primary (base) one + every
 *  per-unit one (a carton carries its own). Lower-cased, blanks dropped. */
function barcodesOf(it: CatalogItem): string[] {
  const out: string[] = [];
  if (it.barcode) out.push(String(it.barcode).toLowerCase());
  for (const u of it.units || []) if (u.barcode) out.push(String(u.barcode).toLowerCase());
  return out;
}

/**
 * Instant search. Matches id (exact or substring), Arabic/English name, AND
 * every barcode the item carries.
 *
 * Barcodes were missing entirely: typing (or half-scanning) a code found
 * nothing, even though resolveScan could resolve that exact same string — so
 * the grid looked empty for a product that was right there. Substring, like the
 * name/id arms, so a partially-typed or partially-read code still narrows.
 *
 * resolveScan's precedence is UNAFFECTED: it checks exact per-unit → exact
 * primary → exact id BEFORE ever falling through to this function.
 *
 * QUICK PICKS (close/w1b-quickpicks): `category` may be the QUICK_PICKS_CATEGORY
 * sentinel instead of a real DB category. That branch keeps the tally's RANK
 * (best seller first) rather than catalog order, which is the entire point of
 * the chip — so it cannot be expressed as a plain `.filter()`. `quickPickIds` is
 * injectable so the component can hand down the subscribed value (and specs can
 * pin a ranking); omitted, it reads the live tally.
 */
export function filterItems(
  items: CatalogItem[],
  category: string | null,
  query: string,
  quickPickIds?: string[],
): CatalogItem[] {
  const q = query.trim().toLowerCase();
  const matches = (it: CatalogItem) =>
    !q ||
    it.id.toLowerCase() === q ||
    it.name.toLowerCase().includes(q) ||
    (it.nameEn ? it.nameEn.toLowerCase().includes(q) : false) ||
    it.id.toLowerCase().includes(q) ||
    barcodesOf(it).some((b) => b.includes(q));

  if (category === QUICK_PICKS_CATEGORY) {
    const ranked = quickPickIds ?? getQuickPicks();
    const byId = new Map<string, CatalogItem>();
    for (const it of items) if (it.active) byId.set(it.id, it); // inactive stays unsellable
    const out: CatalogItem[] = [];
    for (const id of ranked) {
      const it = byId.get(id);
      if (it && matches(it)) out.push(it);
    }
    return out;
  }

  return items.filter((it) => {
    if (!it.active) return false; // inactive items are unsellable → hidden
    if (category && it.category !== category) return false;
    return matches(it);
  });
}

/** A quantity multiplier typed (or wedged by a scale/scanner) ahead of a code. */
export interface QtyPrefix {
  qty: number;
  /** Everything after the separator — the code/name to actually resolve. */
  rest: string;
}

/**
 * Parse a `<qty><sep><code>` prefix: "12*7501" / "12x7501" / "12×7501" →
 * { qty: 12, rest: "7501" }. Separators: `*`, `x`, `X`, `×`.
 *
 * PURE and total: returns null whenever there is no well-formed prefix, so the
 * caller can hand the untouched query to the normal resolve path. qty must be
 * > 0 and `rest` non-empty, otherwise "12*" or "0x7501" would silently add
 * nothing.
 *
 * WHOLE QUANTITIES ONLY. This used to accept a decimal for weighed goods
 * ("2.5*7501"). The register sells in whole units, so a fraction here would be
 * the one remaining way to smuggle one into a cart line — past the QtyPad,
 * which now refuses it. "2.5*7501" no longer parses as a prefix; it falls
 * through to the normal search path and finds nothing, which is the honest
 * outcome for a quantity the register cannot sell.
 *
 * Exported for the App's scan wiring (another stream owns that call site).
 */
export function parseQtyPrefix(query: string): QtyPrefix | null {
  const m = /^\s*(\d+)\s*[*xX×]\s*(\S.*?)\s*$/.exec(query ?? "");
  if (!m) return null;
  const qty = Number(m[1]);
  if (!Number.isInteger(qty) || qty <= 0) return null;
  const rest = m[2];
  return rest ? { qty, rest } : null;
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

const ProductCard = memo(function ProductCard({
  item,
  onAdd,
  qty = 0,
  onDec,
  vatRatePct,
}: {
  item: CatalogItem;
  onAdd: (item: CatalogItem) => void;
  /** Live quantity of this item in the cart (0 = not in the cart). */
  qty?: number;
  /** Decrement one unit of this item (only offered while qty > 0). */
  onDec?: (item: CatalogItem) => void;
  /** Server VAT rate, so the card can print the price the customer pays.
   *  A PRIMITIVE on purpose — an object prop would defeat this card's memo(). */
  vatRatePct: number;
}) {
  const t = useT();
  const tn = useLocalizedName();
  const imgSrc = useItemImage(item.id, item.imageVersion);
  const inCart = qty > 0;
  return (
    // Wrapper: the qty badge + − button are SIBLINGS of the add button (a
    // button cannot nest a button). Absolute overlays never change the card's
    // height, so the virtualizer's measured rows stay put.
    <div className="relative">
      <button
        type="button"
        // WARN, NEVER BLOCK: an out-of-stock card is muted, not disabled. The
        // server is the authority on stock and many rows legitimately have no
        // figure at all; refusing the tap here would invent a rule the backend
        // does not have. state/store.tsx raises one info toast per item instead.
        onClick={() => onAdd(item)}
        className={cn(
          "btn-press group flex h-full min-h-[5.5rem] w-full flex-col justify-between rounded-2xl border bg-white p-3 text-start shadow-sm transition hover:border-teal-200 hover:shadow-soft",
          // Selection ring while the item sits in the cart (legacy .selected).
          inCart ? "border-teal-300 ring-2 ring-teal-500/50" : "border-slate-200",
          // Pure paint (opacity + filter) — no box-model property, so the card's
          // measured height is byte-for-byte what it was before this landed.
        )}
      >
        {/* ALWAYS rendered — image on top, name beneath, on every card.
            It used to appear only for items that HAD an image, so a menu with
            no photos uploaded fell back to a text-only card and the grid looked
            like two different designs at once. A fixed height reserved from
            first paint also keeps the virtualizer's measured rows put whether
            or not the bytes ever arrive. With no image the slot carries the
            item's first letter — quiet, but a shape the eye can aim at. */}
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
          ) : (
            <span className="flex h-full w-full items-center justify-center text-xl font-extrabold text-slate-300">
              {tn(item.name, item.nameEn).trim().charAt(0)}
            </span>
          )}
        </div>
        <p className="line-clamp-2 text-sm font-extrabold leading-snug text-ink group-hover:text-teal-700">{tn(item.name, item.nameEn)}</p>
        {/* THE PRICE THE CUSTOMER PAYS — VAT included. Menu rows are stored
            tax-exclusive, so printing `item.price` raw showed 13.04 for an item
            that rings up at 15.00: two numbers for one product on one screen.
            displayUnitPrice routes through lineTotals, so this can never drift
            from the cart. */}
        <p className="mt-2 text-sm font-extrabold text-teal-600">
          <span className="num">{fmtPrice(displayUnitPrice(item, vatRatePct))}</span>{" "}
          <span className="text-[11px] font-bold text-slate-400">{t("productGrid.currency")}</span>
        </p>
      </button>
      {/* العروض (close/w25-combos): tapping this card opens the combo chooser,
          not a direct add — the badge says so (legacy amber «عرض» badge).
          Sibling overlay at top-end; the qty badge sits at -top-1.5 (clear). */}
      {item.isCombo ? (
        <span
          data-testid="combo-badge"
          className="pointer-events-none absolute end-1.5 top-1.5 z-[1] rounded-md bg-amber-500 px-1.5 py-0.5 text-[10px] font-extrabold text-white shadow-sm"
        >
          {t("productGrid.badge.combo")}
        </span>
      ) : null}
      {/* «مُخصَّص» — a channel price list drives this card's price (legacy badge
          app.js:410-412; top-start like the original). */}
      {item.priceSource ? (
        <span
          aria-hidden
          className="pointer-events-none absolute start-1.5 top-1.5 rounded-md bg-saffron-500 px-1.5 py-0.5 text-[9px] font-extrabold text-white"
        >
          {t("productGrid.badge.custom")}
        </span>
      ) : null}
      {/* 86 board (close/w1b-stock): bottom-START, so it never collides with the
          combo/«مُخصَّص» chips at the top or the inline − at bottom-END. A <span>,
          never a button — the windowing spec pins the buttons-per-row count. */}
      {inCart ? (
        <>
          {/* Live qty badge (legacy qty-display, app.js:449) */}
          <span
            data-testid="card-qty-badge"
            aria-label={t("productGrid.card.inCartAria", { name: tn(item.name, item.nameEn), qty: fmtQty(qty) })}
            className="num absolute -top-1.5 end-1.5 min-w-6 rounded-full bg-teal-600 px-1.5 py-0.5 text-center text-[11px] font-extrabold text-white shadow-sm"
          >
            {fmtQty(qty)}
          </span>
          {/* Inline − (legacy decFromCart, app.js:448) — last unit removes the line */}
          <button
            type="button"
            onClick={() => onDec?.(item)}
            aria-label={t("productGrid.card.decrementAria", { name: tn(item.name, item.nameEn) })}
            className="btn-press absolute bottom-1.5 end-1.5 flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 shadow-sm hover:bg-slate-100 hover:text-red-600"
          >
            <Minus className="h-4 w-4" aria-hidden />
          </button>
        </>
      ) : null}
    </div>
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
  /** Live cart quantity per item id — drives the qty badge + selection ring
   *  (close/w25-sell-ui). Omit for badge-less rendering. */
  cartQty?: Record<string, number>;
  /** Decrement one unit of an in-cart item (the card's − button). */
  onDecrement?: (item: CatalogItem) => void;
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
    const t = useT();
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
          placeholder={t("productGrid.search.placeholder")}
          aria-label={t("productGrid.search.aria")}
          className="field ps-9 pe-9"
        />
        {query ? (
          <button
            type="button"
            onClick={() => onQueryChange("")}
            aria-label={t("productGrid.search.clearAria")}
            className="absolute start-1.5 top-1/2 flex min-h-11 min-w-11 -translate-y-1/2 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        ) : null}
      </div>
    );
  },
);

/** Column count follows the space actually available to the product surface,
 *  not the browser viewport. On desktop the cart/category rails can consume
 *  half the viewport; using viewport breakpoints there produced crushed cards. */
export const productColumnsForWidth = (w: number) => (w >= 900 ? 4 : w >= 600 ? 3 : 2);
/** Card min-height (5.5rem = 88px) + the 2.5 gap (10px). The virtualizer measures
 *  each real row anyway; this only has to be close enough to size the scrollbar
 *  before anything is measured. */
const ROW_ESTIMATE = 98;
const gridClassFor = (cols: number) =>
  cn(
    "grid gap-2.5",
    cols === 4 ? "grid-cols-4" : cols === 3 ? "grid-cols-3" : "grid-cols-2",
  );

function useColumns(scrollElement: HTMLElement | null | undefined): number {
  const [cols, setCols] = useState(2);
  useEffect(() => {
    const measure = (el?: HTMLElement | null) => {
      const width = el
        ? el.getBoundingClientRect().width || el.clientWidth || el.offsetWidth
        : typeof window !== "undefined"
          ? window.innerWidth
          : 0;
      if (width > 0) setCols(productColumnsForWidth(width));
    };

    if (scrollElement) {
      measure(scrollElement);
      const observer = new ResizeObserver(() => measure(scrollElement));
      observer.observe(scrollElement);
      return () => observer.disconnect();
    }

    // Unwindowed consumers do not provide a container. Preserve a safe viewport
    // fallback for them, while App always supplies its real scroll surface.
    const onResize = () => measure(null);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [scrollElement]);
  return cols;
}

export function ProductGrid({ catalog, loading, category, query, onAdd, scrollElement, cartQty, onDecrement }: Omit<ProductGridProps, "onQueryChange" | "onScanSubmit">) {
  const t = useT();
  // Subscribed, so selling an item re-ranks the «الأكثر مبيعًا» chip live.
  const quickPickIds = useQuickPicks();
  const visible = useMemo(
    () => (catalog ? filterItems(catalog.items, category, query, quickPickIds) : []),
    [catalog, category, query, quickPickIds],
  );
  const cols = useColumns(scrollElement);
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
      <div className={gridClassFor(cols)}>
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
        title={t("productGrid.empty.title")}
        hint={
          query
            ? t("productGrid.empty.hintQuery")
            : category === QUICK_PICKS_CATEGORY
              ? t("productGrid.empty.hintQuick")
              : t("productGrid.empty.hintCategory")
        }
      />
    );
  }

  /** One card. Shared by both render paths so the windowed and unwindowed grids
   *  can never diverge.
   *
   *  NO 86-BOARD VERDICT. The availability signal is computed from RAW STOCK,
   *  and on this menu every sellable row is built from a recipe rather than held
   *  as a physical unit — so the badge marked almost the whole grid «Out» and
   *  dimmed it, while every one of those items was perfectly sellable. A
   *  warning that is wrong about most of the screen is worse than no warning:
   *  the cashier learns to ignore the one case where it might be right.
   *  The endpoint and StockPip stay in the tree, unwired, for a menu that
   *  actually sells shelf goods. */
  const card = (item: CatalogItem) => (
    <ProductCard
      key={item.id}
      item={item}
      onAdd={onAdd}
      qty={cartQty?.[item.id] ?? 0}
      onDec={onDecrement}
      vatRatePct={catalog?.vatRate ?? DEFAULT_VAT_RATE_PCT}
    />
  );

  // The host opted out of windowing entirely (prop absent — distinct from null,
  // which means "attaching"). Render everything rather than window against
  // nothing and show a blank grid.
  if (scrollElement === undefined) {
    return <div className={gridClassFor(cols)}>{visible.map(card)}</div>;
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
            className={cn(gridClassFor(cols), "pb-2.5")}
          >
            {visible.slice(start, start + cols).map(card)}
          </div>
        );
      })}
    </div>
  );
}
