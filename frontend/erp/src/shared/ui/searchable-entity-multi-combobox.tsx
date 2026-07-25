// Multi-select sibling of SearchableEntityCombobox — same server-paginated,
// portalled, virtualized, RTL, keyboard/ARIA-complete picker, but you pick MANY
// rows at once. Each row is a checkbox that TOGGLES membership; the list STAYS
// OPEN so you can tick several, and the current selection shows as removable
// chips above the input. Controlled: value:T[] / onChange:(v:T[]).
//
// "Add all visible" only spans the rows already loaded/filtered (the list is
// server-paginated) — the footer button says so honestly.
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Search, X, AlertTriangle, Loader2, Check } from "lucide-react";
import { cn } from "@/shared/lib";
import { useTx } from "./i18n";
import { Badge } from "./badge";
import type { EntityFetcher } from "./searchable-entity-combobox";

const ROW_H = 52;
const MAX_H = 288;
const OVERSCAN = 4;
const GAP = 4;

export interface SearchableEntityMultiComboboxProps<T> {
  value: T[];
  onChange: (v: T[]) => void;
  fetcher: EntityFetcher<T>;
  /** stable base query key; the debounced text is appended internally */
  queryKey: readonly unknown[];
  getKey: (t: T) => string;
  getLabel: (t: T) => string;
  getSublabel?: (t: T) => string | undefined;
  placeholder?: string;
  disabled?: boolean;
  emptyText?: string;
  id?: string;
  ariaLabel?: string;
  /** load the first page as soon as the list opens, before any typing */
  searchOnEmpty?: boolean;
  /** hide the "add all visible" footer helper (default shown) */
  hideSelectAll?: boolean;
}

interface PopupPos {
  left: number;
  width: number;
  maxH: number;
  top?: number;
  bottom?: number;
}

export function SearchableEntityMultiCombobox<T>(props: SearchableEntityMultiComboboxProps<T>) {
  const t = useTx();
  const {
    value,
    onChange,
    fetcher,
    queryKey,
    getKey,
    getLabel,
    getSublabel,
    placeholder = t("sharedUi.entityMultiCombobox.placeholder"),
    disabled = false,
    emptyText = t("sharedUi.entityMultiCombobox.empty"),
    id,
    ariaLabel,
    searchOnEmpty = true,
    hideSelectAll = false,
  } = props;

  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [debounced, setDebounced] = useState("");
  const [pos, setPos] = useState<PopupPos | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const reactId = useId();
  const listId = `${id || reactId}-list`;

  const selectedKeys = useMemo(() => new Set(value.map(getKey)), [value, getKey]);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(timer);
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

  const rows = useMemo<T[]>(() => (query.data?.pages ?? []).flatMap((p) => p.items), [query.data]);

  useEffect(() => {
    setActive(0);
    setScrollTop(0);
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [debounced]);

  const computePos = useCallback(() => {
    const el = boxRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const spaceBelow = window.innerHeight - r.bottom - GAP;
    const spaceAbove = r.top - GAP;
    const flipUp = spaceBelow < Math.min(MAX_H, 200) && spaceAbove > spaceBelow;
    const maxH = Math.max(140, Math.min(MAX_H, flipUp ? spaceAbove : spaceBelow));
    if (flipUp) setPos({ left: r.left, width: r.width, maxH, bottom: window.innerHeight - r.top + GAP });
    else setPos({ left: r.left, width: r.width, maxH, top: r.bottom + GAP });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    computePos();
    const onWin = () => computePos();
    window.addEventListener("scroll", onWin, true);
    window.addEventListener("resize", onWin);
    return () => {
      window.removeEventListener("scroll", onWin, true);
      window.removeEventListener("resize", onWin);
    };
  }, [open, computePos]);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      const target = e.target as Node;
      if (boxRef.current && boxRef.current.contains(target)) return;
      if (listRef.current && listRef.current.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

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
    if (
      el.scrollHeight - (el.scrollTop + el.clientHeight) < ROW_H * 3 &&
      query.hasNextPage &&
      !query.isFetchingNextPage
    ) {
      query.fetchNextPage();
    }
  }, [query]);

  const toggle = useCallback(
    (row: T | undefined) => {
      if (!row) return;
      const key = getKey(row);
      if (selectedKeys.has(key)) onChange(value.filter((v) => getKey(v) !== key));
      else onChange([...value, row]);
    },
    [getKey, onChange, selectedKeys, value],
  );

  function remove(key: string) {
    onChange(value.filter((v) => getKey(v) !== key));
  }

  function addAllVisible() {
    if (!rows.length) return;
    const merged = [...value];
    const seen = new Set(selectedKeys);
    for (const r of rows) {
      const k = getKey(r);
      if (!seen.has(k)) {
        seen.add(k);
        merged.push(r);
      }
    }
    onChange(merged);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open && (e.key === "ArrowDown" || e.key === "Enter")) {
      setOpen(true);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const n = Math.min(active + 1, rows.length - 1);
      setActive(n);
      ensureVisible(n);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const n = Math.max(active - 1, 0);
      setActive(n);
      ensureVisible(n);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
      ensureVisible(0);
    } else if (e.key === "End") {
      e.preventDefault();
      const n = rows.length - 1;
      setActive(n);
      ensureVisible(n);
    } else if (e.key === "Enter") {
      e.preventDefault();
      toggle(rows[active]); // toggle, keep open
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  }

  // ── virtualization window ──
  const total = rows.length;
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const visibleCount = Math.ceil(MAX_H / ROW_H) + OVERSCAN * 2;
  const end = Math.min(total, start + visibleCount);
  const padTop = start * ROW_H;
  const padBottom = Math.max(0, (total - end) * ROW_H);
  const windowRows = rows.slice(start, end);

  const isError = query.isError;
  const isLoading = enabled && (query.isLoading || (query.isFetching && rows.length === 0));

  return (
    <div>
      {value.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {value.map((v) => (
            <Badge key={getKey(v)} tone="teal" className="max-w-full gap-1 py-1">
              <span className="truncate">{getLabel(v)}</span>
              {!disabled && (
                <button
                  type="button"
                  aria-label={t("sharedUi.entityMultiCombobox.removeItem", { label: getLabel(v) })}
                  className="grid h-4 w-4 shrink-0 place-items-center rounded transition hover:bg-white/70 hover:text-rose-600"
                  onClick={() => remove(getKey(v))}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </Badge>
          ))}
          {!disabled && (
            <button
              type="button"
              className="text-[11px] font-bold text-slate-400 transition hover:text-rose-600"
              onClick={() => onChange([])}
            >
              {t("sharedUi.entityMultiCombobox.clearAll", { count: value.length })}
            </button>
          )}
        </div>
      )}

      <div ref={boxRef} className="relative">
        <label className="relative block">
          <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            ref={inputRef}
            id={id}
            className="field w-full py-2 pr-10"
            placeholder={placeholder}
            value={q}
            disabled={disabled}
            onFocus={() => setOpen(true)}
            onMouseDown={() => setOpen(true)}
            onChange={(e) => {
              setQ(e.target.value);
              setOpen(true);
            }}
            onKeyDown={onKeyDown}
            aria-label={ariaLabel || t("sharedUi.entityMultiCombobox.searchLabel")}
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={open && rows[active] ? `${listId}-opt-${getKey(rows[active])}` : undefined}
            autoComplete="off"
          />
        </label>
        {open &&
          !disabled &&
          pos &&
          createPortal(
            <div
              id={listId}
              role="listbox"
              aria-multiselectable="true"
              ref={listRef}
              dir="rtl"
              onScroll={onScroll}
              onMouseDown={(e) => {
                if (e.target !== listRef.current) e.preventDefault();
              }}
              className="fixed z-palette overflow-y-auto rounded-xl border border-slate-200 bg-white p-1 shadow-xl ring-1 ring-black/5"
              style={{ left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxH }}
            >
              {isError ? (
                <div className="flex flex-col items-center gap-2 px-3 py-5 text-center">
                  <AlertTriangle className="h-5 w-5 text-amber-500" />
                  <span className="text-xs font-semibold text-slate-500">{t("sharedUi.entityMultiCombobox.loadError")}</span>
                  <button
                    type="button"
                    onClick={() => query.refetch()}
                    className="rounded-lg bg-slate-100 px-3 py-1 text-xs font-bold text-slate-700 hover:bg-slate-200"
                  >
                    {t("common.retry")}
                  </button>
                </div>
              ) : isLoading ? (
                <div className="flex items-center justify-center gap-2 px-3 py-4 text-xs font-medium text-slate-400">
                  <Loader2 className="h-4 w-4 animate-spin" /> {t("sharedUi.entityMultiCombobox.searching")}
                </div>
              ) : !enabled ? (
                <div className="px-3 py-3 text-xs font-medium text-slate-400">{t("sharedUi.entityMultiCombobox.typeToSearch")}</div>
              ) : rows.length === 0 ? (
                <div className="px-3 py-3 text-xs font-medium text-slate-400">{emptyText}</div>
              ) : (
                <>
                  <div style={{ paddingTop: padTop, paddingBottom: padBottom }}>
                    {windowRows.map((row, i) => {
                      const idx = start + i;
                      const key = getKey(row);
                      const isActive = idx === active;
                      const isSel = selectedKeys.has(key);
                      const sub = getSublabel?.(row);
                      return (
                        <button
                          key={key}
                          id={`${listId}-opt-${key}`}
                          type="button"
                          role="option"
                          aria-selected={isSel}
                          style={{ height: ROW_H }}
                          className={cn(
                            "flex w-full items-center gap-2 rounded-lg px-3 text-right transition",
                            isActive ? "bg-teal-50 ring-1 ring-teal-200" : "hover:bg-slate-50",
                          )}
                          onMouseEnter={() => setActive(idx)}
                          onClick={() => toggle(row)}
                        >
                          <span
                            aria-hidden="true"
                            className={cn(
                              "grid h-5 w-5 shrink-0 place-items-center rounded-md border transition",
                              isSel ? "border-teal-600 bg-teal-600 text-white" : "border-slate-300 bg-white",
                            )}
                          >
                            {isSel && <Check className="h-3.5 w-3.5" />}
                          </span>
                          <span className="flex min-w-0 flex-col">
                            <span className="truncate text-sm font-semibold text-slate-700">{getLabel(row)}</span>
                            {sub && (
                              <span dir="ltr" className="truncate text-[11px] font-semibold text-slate-400 tabular-nums">
                                {sub}
                              </span>
                            )}
                          </span>
                        </button>
                      );
                    })}
                    {query.isFetchingNextPage && (
                      <div className="flex items-center justify-center gap-2 py-2 text-[11px] text-slate-400">
                        <Loader2 className="h-3 w-3 animate-spin" /> {t("sharedUi.entityMultiCombobox.loadingMore")}
                      </div>
                    )}
                  </div>
                  {!hideSelectAll && (
                    <div className="sticky bottom-0 flex items-center justify-between gap-2 border-t border-slate-100 bg-white/95 px-2 py-1.5 text-[11px]">
                      <button
                        type="button"
                        className="font-bold text-teal-700 transition hover:text-teal-900"
                        onClick={addAllVisible}
                      >
                        {t("sharedUi.entityMultiCombobox.addAllVisible", { count: rows.length })}
                      </button>
                      <span className="font-semibold text-slate-400">
                        {t("sharedUi.entityMultiCombobox.selectedCount", { count: value.length })}
                      </span>
                    </div>
                  )}
                </>
              )}
            </div>,
            document.body,
          )}
      </div>
    </div>
  );
}
