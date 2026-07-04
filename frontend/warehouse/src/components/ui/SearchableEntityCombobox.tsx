// Phase U — the ONE reusable searchable picker for every long list in the
// warehouse app (items/materials, GL accounts, suppliers, warehouses, POs,
// recipes, production orders, lots, users, customers). Replaces every large
// native <select> and every "load everything then filter" list.
//
// Guarantees (per the pre-production directive §ثانيًا):
//   • server-side search — the fetcher hits a paginated `?q=…&page=…` endpoint,
//     never loading thousands of rows at once
//   • debounce (250ms) before firing a query
//   • infinite scroll / pagination via useInfiniteQuery + a scroll sentinel
//   • virtualization — only the rows in the visible window are in the DOM, so a
//     list scrolled across many pages stays cheap
//   • full keyboard support: ↑ ↓ Home End to move, Enter to pick, Esc to close
//   • ARIA combobox / listbox / option with aria-activedescendant
//   • loading / empty / error+retry states (never a silent empty list)
//   • shows the current selection as a clearable chip
//   • exact-match auto-select (unique barcode → pick directly)
//   • RTL, English digits (numbers rendered by the caller's getSublabel)

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Search, X, AlertTriangle, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

export interface EntityPage<T> {
  items: T[];
  /** next page number, or null when there are no more pages */
  nextPage: number | null;
  total: number;
  /** when a query resolves to exactly one row (e.g. a unique barcode) */
  exactMatchId?: string | null;
}
export type EntityFetcher<T> = (args: {
  q: string;
  page: number;
  signal?: AbortSignal;
}) => Promise<EntityPage<T>>;

const ROW_H = 52; // fixed row height (px) — drives virtualization math
const MAX_H = 288; // dropdown viewport height (px)
const OVERSCAN = 4;

export interface SearchableEntityComboboxProps<T> {
  value: T | null;
  onChange: (v: T | null) => void;
  fetcher: EntityFetcher<T>;
  /** stable base query key; the debounced text is appended internally */
  queryKey: readonly unknown[];
  getKey: (t: T) => string;
  getLabel: (t: T) => string;
  getSublabel?: (t: T) => string | undefined;
  renderOption?: (t: T, active: boolean) => React.ReactNode;
  placeholder?: string;
  disabled?: boolean;
  emptyText?: string;
  /** auto-select when the query returns a single exact match (barcode) */
  autoSelectExact?: boolean;
  id?: string;
  ariaLabel?: string;
  /** render even before the user types (default false → prompt to type) */
  searchOnEmpty?: boolean;
}

export function SearchableEntityCombobox<T>(props: SearchableEntityComboboxProps<T>) {
  const {
    value, onChange, fetcher, queryKey, getKey, getLabel, getSublabel, renderOption,
    placeholder = "ابحث بالاسم أو الرمز…", disabled = false, emptyText = "لا نتائج مطابقة.",
    autoSelectExact = false, id, ariaLabel, searchOnEmpty = false,
  } = props;

  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [debounced, setDebounced] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const reactId = useId();
  const listId = `${id || reactId}-list`;

  // debounce the query text (250ms)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const enabled = open && (searchOnEmpty || debounced.length > 0);
  const query = useInfiniteQuery({
    queryKey: [...queryKey, debounced],
    queryFn: ({ pageParam, signal }) => fetcher({ q: debounced, page: pageParam as number, signal }),
    initialPageParam: 1,
    getNextPageParam: (last) => last.nextPage,
    enabled,
    staleTime: 15_000,
  });

  const rows = useMemo<T[]>(
    () => (query.data?.pages ?? []).flatMap((p) => p.items),
    [query.data],
  );
  const exactId = query.data?.pages?.[0]?.exactMatchId ?? null;

  // reset active row + scroll when the result set changes
  useEffect(() => { setActive(0); setScrollTop(0); if (listRef.current) listRef.current.scrollTop = 0; }, [debounced]);

  // exact-match auto-select (unique barcode) — pick and close.
  useEffect(() => {
    if (!autoSelectExact || !open || !exactId) return;
    const hit = rows.find((r) => getKey(r) === exactId);
    if (hit) { onChange(hit); setOpen(false); setQ(""); }
  }, [autoSelectExact, open, exactId, rows, getKey, onChange]);

  // close on outside click
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  // keep the active row within the visible window (keyboard nav ↔ virtualization)
  const ensureVisible = useCallback((idx: number) => {
    const el = listRef.current;
    if (!el) return;
    const top = idx * ROW_H;
    const bottom = top + ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
  }, []);

  const onScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    // infinite scroll: near the bottom → next page
    if (el.scrollHeight - (el.scrollTop + el.clientHeight) < ROW_H * 3 && query.hasNextPage && !query.isFetchingNextPage) {
      query.fetchNextPage();
    }
  }, [query]);

  function pick(row: T | undefined) {
    if (!row) return;
    onChange(row);
    setOpen(false);
    setQ("");
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open && (e.key === "ArrowDown" || e.key === "Enter")) { setOpen(true); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); const n = Math.min(active + 1, rows.length - 1); setActive(n); ensureVisible(n); }
    else if (e.key === "ArrowUp") { e.preventDefault(); const n = Math.max(active - 1, 0); setActive(n); ensureVisible(n); }
    else if (e.key === "Home") { e.preventDefault(); setActive(0); ensureVisible(0); }
    else if (e.key === "End") { e.preventDefault(); const n = rows.length - 1; setActive(n); ensureVisible(n); }
    else if (e.key === "Enter") { e.preventDefault(); pick(rows[active]); }
    else if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
  }

  // ── selected chip ──────────────────────────────────────────────────────────
  if (value) {
    const sub = getSublabel?.(value);
    return (
      <div className="flex min-h-11 items-center justify-between gap-2 rounded-xl border border-teal-200 bg-teal-50/60 px-3 py-2">
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-bold text-slate-800">{getLabel(value)}</span>
          {sub && <span dir="ltr" className="truncate text-[11px] font-semibold text-slate-500 tabular-nums">{sub}</span>}
        </span>
        {!disabled && (
          <button
            type="button"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-slate-400 transition hover:bg-white hover:text-rose-600"
            aria-label="مسح المحدد"
            onClick={() => onChange(null)}
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    );
  }

  // ── virtualization window ────────────────────────────────────────────────────
  const total = rows.length;
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const visibleCount = Math.ceil(MAX_H / ROW_H) + OVERSCAN * 2;
  const end = Math.min(total, start + visibleCount);
  const padTop = start * ROW_H;
  const padBottom = Math.max(0, (total - end) * ROW_H);
  const window = rows.slice(start, end);

  const isError = query.isError;
  const isLoading = enabled && query.isLoading;

  return (
    <div ref={boxRef} className="relative">
      <label className="relative block">
        <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          ref={inputRef}
          id={id}
          className="field w-full pr-10"
          placeholder={placeholder}
          value={q}
          disabled={disabled}
          onFocus={() => setOpen(true)}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onKeyDown={onKeyDown}
          aria-label={ariaLabel || "بحث"}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && rows[active] ? `${listId}-opt-${getKey(rows[active])}` : undefined}
          autoComplete="off"
        />
      </label>
      {open && !disabled && (
        <div
          id={listId}
          role="listbox"
          ref={listRef}
          onScroll={onScroll}
          className="absolute z-40 mt-1 w-full overflow-y-auto rounded-xl border border-slate-200 bg-white p-1 shadow-lg"
          style={{ maxHeight: MAX_H }}
        >
          {isError ? (
            <div className="flex flex-col items-center gap-2 px-3 py-5 text-center">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              <span className="text-xs font-semibold text-slate-500">تعذّر تحميل النتائج.</span>
              <button type="button" onClick={() => query.refetch()} className="rounded-lg bg-slate-100 px-3 py-1 text-xs font-bold text-slate-700 hover:bg-slate-200">
                إعادة المحاولة
              </button>
            </div>
          ) : isLoading ? (
            <div className="flex items-center justify-center gap-2 px-3 py-4 text-xs font-medium text-slate-400">
              <Loader2 className="h-4 w-4 animate-spin" /> جارٍ البحث…
            </div>
          ) : !enabled ? (
            <div className="px-3 py-3 text-xs font-medium text-slate-400">اكتب للبحث…</div>
          ) : rows.length === 0 ? (
            <div className="px-3 py-3 text-xs font-medium text-slate-400">{emptyText}</div>
          ) : (
            <div style={{ paddingTop: padTop, paddingBottom: padBottom }}>
              {window.map((row, i) => {
                const idx = start + i;
                const key = getKey(row);
                const isActive = idx === active;
                const sub = getSublabel?.(row);
                return (
                  <button
                    key={key}
                    id={`${listId}-opt-${key}`}
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    style={{ height: ROW_H }}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 rounded-lg px-3 text-right transition",
                      isActive ? "bg-teal-50 ring-1 ring-teal-200" : "hover:bg-slate-50",
                    )}
                    onMouseEnter={() => setActive(idx)}
                    onClick={() => pick(row)}
                  >
                    {renderOption ? (
                      renderOption(row, isActive)
                    ) : (
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-sm font-semibold text-slate-700">{getLabel(row)}</span>
                        {sub && <span dir="ltr" className="truncate text-[11px] font-semibold text-slate-400 tabular-nums">{sub}</span>}
                      </span>
                    )}
                  </button>
                );
              })}
              {query.isFetchingNextPage && (
                <div className="flex items-center justify-center gap-2 py-2 text-[11px] text-slate-400">
                  <Loader2 className="h-3 w-3 animate-spin" /> تحميل المزيد…
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
