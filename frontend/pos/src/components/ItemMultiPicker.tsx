/**
 * ItemMultiPicker — the shared "tap the box → see EVERYTHING → tick several"
 * item picker for the cashier's جرد (StocktakeDialog) and نواقص
 * (RequisitionsDialog) flows.
 *
 * WHY IT EXISTS (owner complaint, 2026-07-28): both dialogs render a plain
 * <input> whose result list is gated on `items && query.trim()`
 * (StocktakeDialog.tsx:449, RequisitionsDialog.tsx:568) — nothing appears until
 * the cashier TYPES. On a tablet, with Arabic item names, that is unusable. Here
 * FOCUS alone (or a tap, or ArrowDown) opens the list showing the FULL catalogue;
 * typing only narrows it.
 *
 * CONTRACT — it is a pure controlled component:
 *   • `items`        the caller's already-fetched list (null = still loading).
 *                    Nothing is fetched here, so it works offline with whatever
 *                    list the caller has cached.
 *   • `selectedIds`  the current selection, caller-owned, ORDER-SIGNIFICANT
 *                    (Backspace removes the LAST id, chips render in this order).
 *   • `onChange`     receives the complete next id array. Never mutates.
 *
 * DELIBERATE NON-FEATURES
 *   • No stock / quantity is rendered. The stocktake is a BLIND COUNT
 *     (StocktakeDialog.tsx:2-30) and GET /api/inventory/items answers a GLOBAL
 *     rollup, not the cashier's warehouse — echoing either number here would be
 *     both a contract break and a lie.
 *   • Inactive rows are hidden by default: the default branch of
 *     GET /api/inventory/items (routes/inventory.js:1229-1233) applies NO
 *     `active = 1 AND deleted_at IS NULL` filter, and a drop-everything list
 *     surfaces that immediately. Pass `includeInactive` to opt out.
 *   • NOT virtualised. Prod is ~159 inv_items (routes/inventory.js:1124); the
 *     brief's threshold for reaching for @tanstack/react-virtual (as ProductGrid
 *     does) is ~300 rows. Instead the render is capped at `maxVisible` (300) and
 *     the cap is ANNOUNCED ("showing N of M") rather than silently truncating the
 *     way the existing `.slice(0, 50)` calls do.
 *
 * LAYOUT: the list is an absolutely-positioned popover with its own
 * max-height + overflow, so opening it never reflows the host dialog.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { CheckSquare, Search, Square, X } from "lucide-react";
import { useLang, useLocalizedName, useT, type Lang } from "@/i18n/I18nProvider";
import { format } from "@/i18n/interpolate";
import { itemMultiPicker as pickerAr } from "@/i18n/dictionaries/ar/itemMultiPicker";
import { itemMultiPicker as pickerEn } from "@/i18n/dictionaries/en/itemMultiPicker";
import { Button, cn, Skeleton } from "./ui";

/** Render cap before the "showing N of M" notice appears. */
export const DEFAULT_MAX_VISIBLE = 300;

/**
 * The minimum an item must expose to be pickable. Deliberately a superset-free
 * structural shape rather than `InvItem` (lib/api.ts:400) so a caller can feed
 * this a cached/offline list, a menu row, or a test fixture. `InvItem[]` is
 * assignable as-is.
 */
export interface PickerItem {
  id: string;
  name: string;
  /** English name, when the source has one (inv_items.name_en, db/schema.sql:98). */
  nameEn?: string | null;
  code?: string | null;
  barcode?: string | null;
  unit?: string | null;
  category?: string | null;
  /** tinyint(1) / boolean. Missing ⇒ treated as active. */
  active?: number | boolean | null;
}

export interface ItemMultiPickerProps {
  /** The full pickable list. `null` means "still loading" (skeletons). */
  items: PickerItem[] | null;
  /** Currently-picked ids, in pick order. Caller-owned. */
  selectedIds: readonly string[];
  /** Receives the COMPLETE next id array. */
  onChange: (nextIds: string[]) => void;
  /** Already-translated label from the caller's own namespace; defaults to ours. */
  label?: string;
  /** Already-translated placeholder from the caller's own namespace. */
  placeholder?: string;
  disabled?: boolean;
  /** Show rows whose `active` is 0/false. Default false — see the header note. */
  includeInactive?: boolean;
  /** Rows rendered before the "showing N of M" notice. Default 300. */
  maxVisible?: number;
}

// ── Search normalisation ─────────────────────────────────────────────────────
// Same rules as StocktakeDialog.tsx:56 `normalizeArabic` (tashkeel stripped,
// alef/teh-marbuta/alef-maqsura/hamza folded). Duplicated ON PURPOSE: importing
// it from StocktakeDialog would drag that module's whole graph (lib/api,
// state/store, lib/receipt) into this picker's chunk and into every test that
// renders it. The two are ~8 lines and semantically frozen; if they are ever
// unified, the home is a lib/ module, not either component.

/** Arabic fuzzy-search normaliser — lowercase + fold the usual orthography. */
export function normalizePickerText(s: string): string {
  return String(s || "")
    .toLowerCase()
    .replace(/[ً-ْ]/g, "")
    .replace(/[ٱأإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي");
}

/** `active` is optional; only an explicit 0/false hides a row. */
export function isPickerItemActive(item: PickerItem): boolean {
  const a = item.active;
  if (a === undefined || a === null) return true;
  if (typeof a === "boolean") return a;
  return Number(a) !== 0;
}

/** Everything a query is matched against: both names, code, barcode, id, category. */
export function pickerHaystack(item: PickerItem): string {
  const parts = [item.name, item.nameEn, item.code, item.barcode, item.id, item.category];
  return normalizePickerText(parts.filter(Boolean).join(" "));
}

/**
 * Pure filter — exported so the consuming dialogs (and their tests) can reason
 * about the exact same matching the popover does. An EMPTY query returns the
 * whole pool: that is the entire point of this component.
 */
export function filterPickerItems(
  items: readonly PickerItem[],
  query: string,
  includeInactive = false,
): PickerItem[] {
  const pool = includeInactive ? [...items] : items.filter(isPickerItemActive);
  const tokens = normalizePickerText(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return pool;
  return pool.filter((it) => {
    const hay = pickerHaystack(it);
    return tokens.every((tk) => hay.includes(tk));
  });
}

// ── String resolution ────────────────────────────────────────────────────────
// Strings live ONLY in i18n/dictionaries/{ar,en}/itemMultiPicker.ts — there is
// no user-facing literal below this line.
//
// `useT()` is tried first, so the moment `itemMultiPicker` is added to the two
// barrels (see the delivery note) this component resolves exactly like every
// other screen — including a live language toggle. Until then it falls back to
// the co-located namespace it already imports, which is the same direct-import
// pattern StocktakeDialog.tsx:48-49 uses for its print sheet. The miss is
// detected via makeT's documented contract: "Missing key: return the dotted
// path itself (unchanged)" (i18n/makeT.ts:68-70) — the same signal
// translateApiError() relies on.

type NsNode = string | { [key: string]: NsNode };

function localLeaf(lang: Lang, key: string): string {
  let cur: NsNode | undefined = (lang === "en" ? pickerEn : pickerAr) as unknown as NsNode;
  for (const part of key.split(".")) {
    if (cur === undefined || typeof cur === "string") return key;
    cur = cur[part];
  }
  return typeof cur === "string" ? cur : key;
}

/** Namespace-scoped translator for this component's own strings. */
function usePickerT(): (key: string, vars?: Record<string, string | number>) => string {
  const t = useT();
  const lang = useLang();
  return useCallback(
    (key, vars) => {
      const path = `itemMultiPicker.${key}`;
      const viaBarrel = t(path, vars);
      if (viaBarrel !== path) return viaBarrel;
      return format(localLeaf(lang, key), vars);
    },
    [t, lang],
  );
}

// ── Component ────────────────────────────────────────────────────────────────

export function ItemMultiPicker({
  items,
  selectedIds,
  onChange,
  label,
  placeholder,
  disabled = false,
  includeInactive = false,
  maxVisible = DEFAULT_MAX_VISIBLE,
}: ItemMultiPickerProps) {
  const tp = usePickerT();
  const localizedName = useLocalizedName();
  const reactId = useId();
  const listId = `imp-list-${reactId}`;
  const optionId = useCallback((index: number) => `imp-opt-${reactId}-${index}`, [reactId]);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef(new Map<number, HTMLLIElement>());

  const loading = items === null;

  const matches = useMemo(
    () => filterPickerItems(items ?? [], query, includeInactive),
    [items, query, includeInactive],
  );
  const shown = useMemo(
    () => (matches.length <= maxVisible ? matches : matches.slice(0, maxVisible)),
    [matches, maxVisible],
  );
  const truncated = matches.length !== shown.length;

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const byId = useMemo(() => {
    const m = new Map<string, PickerItem>();
    for (const it of items ?? []) m.set(it.id, it);
    return m;
  }, [items]);

  // Keep the active row inside the rendered window as the query narrows it.
  useEffect(() => {
    setActiveIndex((i) => (i < shown.length ? i : 0));
  }, [shown.length]);

  // Click outside closes. Same approach as UnitPicker.tsx:31-37 (mousedown, so
  // it fires before the click lands and before focus moves).
  useEffect(() => {
    if (!open) return undefined;
    function onDocMouseDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  // jsdom has no scrollIntoView; guard rather than crash the suite.
  useEffect(() => {
    if (!open) return;
    const el = optionRefs.current.get(activeIndex);
    if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  const toggle = useCallback(
    (id: string) => {
      if (selectedSet.has(id)) onChange(selectedIds.filter((s) => s !== id));
      else onChange([...selectedIds, id]);
    },
    [onChange, selectedIds, selectedSet],
  );

  const selectAllShown = useCallback(() => {
    const next = [...selectedIds];
    const have = new Set(next);
    for (const it of shown) {
      if (have.has(it.id)) continue;
      have.add(it.id);
      next.push(it.id);
    }
    onChange(next);
    inputRef.current?.focus();
  }, [onChange, selectedIds, shown]);

  const clearAll = useCallback(() => {
    onChange([]);
    inputRef.current?.focus();
  }, [onChange]);

  const move = useCallback(
    (delta: number) => {
      setActiveIndex((i) => {
        if (shown.length === 0) return 0;
        return (i + delta + shown.length) % shown.length;
      });
    },
    [shown.length],
  );

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      // Only swallow Escape while the popover owns it — otherwise it must reach
      // Dialog.tsx:38's document listener and close the whole dialog.
      if (!open) return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      move(e.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
      // Space must still TYPE a space once the cashier is mid-query; it only
      // acts as a toggle while the box is empty.
      if (e.key !== "Enter" && query !== "") return;
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const target = shown[activeIndex];
      if (target) toggle(target.id);
      return;
    }
    if (e.key === "Backspace" && query === "" && selectedIds.length !== 0) {
      e.preventDefault();
      onChange(selectedIds.slice(0, -1));
    }
  }

  const activeOption = open ? shown[activeIndex] : undefined;

  return (
    <div ref={rootRef} className="flex flex-col gap-2">
      {/* Picked items — removable chips, in pick order (Backspace pops the last). */}
      {selectedIds.length !== 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label={tp("chips.ariaLabel")}>
          {selectedIds.map((sid) => {
            const it = byId.get(sid);
            const name = it ? localizedName(it.name, it.nameEn) : sid;
            return (
              <li key={sid}>
                <button
                  type="button"
                  onClick={() => toggle(sid)}
                  aria-label={tp("chips.removeAria", { name })}
                  className="btn-press chip min-h-11 border-teal-200 bg-teal-50 text-teal-700 hover:bg-teal-100"
                >
                  <span className="max-w-[10rem] truncate">{name}</span>
                  <X className="h-3.5 w-3.5 shrink-0" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      {/* Live count + bulk actions */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p aria-live="polite" className="text-[11px] font-extrabold text-slate-500">
          {tp("selectedCount", { count: selectedIds.length })}
        </p>
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={selectAllShown}
            disabled={disabled || shown.length === 0}
          >
            {tp("actions.selectAllShown")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={clearAll}
            disabled={disabled || selectedIds.length === 0}
          >
            {tp("actions.clearAll")}
          </Button>
        </div>
      </div>

      {/* The box. Focus OR click opens — no typing required. */}
      <div className="relative">
        <div className="relative">
          <Search
            className="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
            aria-hidden
          />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-haspopup="listbox"
            aria-autocomplete="list"
            aria-activedescendant={activeOption ? optionId(activeIndex) : undefined}
            aria-label={label ?? tp("search.ariaLabel")}
            placeholder={placeholder ?? tp("search.placeholder")}
            autoComplete="off"
            value={query}
            disabled={disabled || loading}
            onFocus={() => setOpen(true)}
            onClick={() => setOpen(true)}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
              setOpen(true);
            }}
            onKeyDown={handleKeyDown}
            className="field min-h-11 w-full pe-10"
          />
        </div>

        {loading ? (
          <div className="mt-2 space-y-2">
            <p role="status" className="text-[11px] font-bold text-slate-400">
              {tp("list.loading")}
            </p>
            <Skeleton className="h-11" />
            <Skeleton className="h-11" />
          </div>
        ) : null}

        {open && !loading ? (
          // ABSOLUTE: opening must not reflow the host dialog's body.
          <div className="dialog-in absolute inset-x-0 z-30 mt-1 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lift">
            <ul
              id={listId}
              role="listbox"
              aria-multiselectable="true"
              aria-label={tp("list.ariaLabel")}
              className="scrollbar-thin max-h-64 overflow-y-auto overscroll-contain"
            >
              {shown.length === 0 ? (
                <li className="px-4 py-3 text-center text-xs font-bold text-slate-400">
                  {(items ?? []).length === 0
                    ? tp("list.empty")
                    : tp("list.noResults")}
                </li>
              ) : (
                shown.map((it, index) => {
                  const picked = selectedSet.has(it.id);
                  const isActiveRow = index === activeIndex;
                  return (
                    <li
                      key={it.id}
                      id={optionId(index)}
                      role="option"
                      aria-selected={picked}
                      ref={(el) => {
                        if (el) optionRefs.current.set(index, el);
                        else optionRefs.current.delete(index);
                      }}
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => toggle(it.id)}
                      className={cn(
                        "btn-press flex min-h-11 cursor-pointer items-center gap-2 border-b border-slate-100 px-4 py-2 text-start transition",
                        picked && isActiveRow
                          ? "bg-teal-100 text-teal-800"
                          : picked
                            ? "bg-teal-50 text-teal-700"
                            : isActiveRow
                              ? "bg-slate-100 text-ink"
                              : "text-ink",
                      )}
                    >
                      {picked ? (
                        <CheckSquare className="h-4 w-4 shrink-0 text-teal-600" aria-hidden />
                      ) : (
                        <Square className="h-4 w-4 shrink-0 text-slate-300" aria-hidden />
                      )}
                      <span className="min-w-0 flex-1 truncate text-sm font-bold">
                        {localizedName(it.name, it.nameEn)}
                      </span>
                      {it.unit ? (
                        <span className="shrink-0 text-[11px] font-bold text-slate-400">{it.unit}</span>
                      ) : null}
                    </li>
                  );
                })
              )}
            </ul>
            {truncated ? (
              <p className="border-t border-slate-100 bg-slate-50 px-4 py-2 text-center text-[11px] font-bold text-slate-500">
                {tp("list.showingOf", { shown: shown.length, total: matches.length })}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
