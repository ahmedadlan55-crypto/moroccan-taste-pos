/**
 * Product grid + instant client-side search / barcode box.
 *
 * Barcode note: menu items have NO physical barcode column — a scanner that
 * types a code + Enter is matched against the CATALOG ID first (menu-level
 * "barcodes" ride on catalog ids), then name substring. The inventory-level
 * GET /api/inventory/v2/items/by-barcode endpoint targets warehouse items,
 * not sellable menu items, so it is intentionally not used here.
 */
import { forwardRef, memo, useMemo } from "react";
import { PackageSearch, Search, X } from "lucide-react";
import type { Catalog, CatalogItem } from "@/lib/types";
import { fmt2 } from "@/lib/format";
import { cn, EmptyState, Skeleton } from "./ui";

export function filterItems(items: CatalogItem[], category: string | null, query: string): CatalogItem[] {
  const q = query.trim().toLowerCase();
  return items.filter((it) => {
    if (!it.active) return false; // inactive items are unsellable → hidden
    if (category && it.category !== category) return false;
    if (!q) return true;
    return it.id.toLowerCase() === q || it.name.toLowerCase().includes(q) || it.id.toLowerCase().includes(q);
  });
}

/** Scanner Enter-key resolution: exact-id match first, else first result. */
export function resolveScan(items: CatalogItem[], query: string): CatalogItem | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const active = items.filter((i) => i.active);
  const exact = active.find((i) => i.id.toLowerCase() === q);
  if (exact) return exact;
  const results = filterItems(items, null, q);
  return results[0] ?? null;
}

const ProductCard = memo(function ProductCard({ item, onAdd }: { item: CatalogItem; onAdd: (item: CatalogItem) => void }) {
  return (
    <button
      type="button"
      onClick={() => onAdd(item)}
      className="btn-press group flex min-h-[5.5rem] flex-col justify-between rounded-2xl border border-slate-200 bg-white p-3 text-start shadow-sm transition hover:border-teal-200 hover:shadow-soft"
    >
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

export function ProductGrid({ catalog, loading, category, query, onAdd }: Omit<ProductGridProps, "onQueryChange" | "onScanSubmit">) {
  const visible = useMemo(
    () => (catalog ? filterItems(catalog.items, category, query) : []),
    [catalog, category, query],
  );

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

  return (
    <div className={cn("grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-4")}>
      {visible.map((item) => (
        <ProductCard key={item.id} item={item} onAdd={onAdd} />
      ))}
    </div>
  );
}
