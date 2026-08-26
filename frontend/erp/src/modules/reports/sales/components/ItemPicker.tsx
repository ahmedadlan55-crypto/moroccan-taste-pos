// The item filter's picker — a catalogue-sized multi-select.
//
// WHY NOT MultiSelectCombobox
//   That component is documented for IN-MEMORY lists (branches, channels) and
//   renders EVERY matching option on every keystroke. A menu is the one lookup
//   in this bar that runs to four figures, and the item field is the one an
//   analyst types into: at 2,000 rows that is 2,000 DOM nodes rebuilt per
//   character, which is the whole frame budget spent on rows nobody can see.
//   Its own header says a server-backed multi belongs to a later wave — so this
//   is that component for this field, and it stays local to the hub rather than
//   changing a shared control every other screen depends on.
//
// WHAT IT DOES
//   • DEBOUNCE — the query is applied 200ms after the last keystroke, so a
//     six-letter word costs one filter pass, not six.
//   • VIRTUALIZE — only the rows inside the scroll window (plus a small
//     overscan) are mounted. A 2,000-row match renders ~20 nodes.
//   • NO IMAGES — an option row is an id and two names. `menu.image_data` is a
//     base64 data URL, and one of those in a row makes every keystroke's render
//     carry a payload larger than the entire useful list.
//
// SERVER-SIDE PAGED SEARCH — WHAT IS AND IS NOT HERE
//   GET /api/erp/menu-options takes NO parameters: it answers id/name/nameEn
//   for the whole sellable catalogue, capped at 2,000 rows server-side, and
//   there is no `q`/`limit`/`offset` on it (routes/erp/menu-options.js). Adding
//   one is outside this change's ownership, so the search and the paging run
//   over that ONE capped fetch — cached for the session by react-query, so the
//   catalogue is fetched once and never per keystroke. That is a genuine
//   difference from server-side paging: a catalogue past 2,000 items is
//   truncated by the route, and this control says so (`truncatedNote`) rather
//   than pretending the tail does not exist.
import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";
import { cn, formatNumber } from "@/shared/lib";
import { useT } from "@/i18n";
import { useListSeparator } from "../lib/listSeparator";

export interface ItemPickerOption {
  value: string;
  label: string;
}

export interface ItemPickerProps {
  options: ItemPickerOption[];
  values: string[];
  onChange: (values: string[]) => void;
  ariaLabel: string;
  placeholder: string;
  /** The server's row cap — when `options` reaches it, the list is truncated. */
  serverCap?: number;
  className?: string;
}

/** Row height in px — fixed, because a virtualizer needs to know it up front. */
const ROW_H = 40;
/** How many rows to mount above and below the window (scroll headroom). */
const OVERSCAN = 6;
/** Visible rows in the popover. */
const WINDOW_ROWS = 8;
const DEBOUNCE_MS = 200;

export function ItemPicker({
  options,
  values,
  onChange,
  ariaLabel,
  placeholder,
  serverCap = 2000,
  className,
}: ItemPickerProps) {
  const t = useT();
  const listSeparator = useListSeparator();
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState("");
  const [query, setQuery] = useState("");
  const [scrollTop, setScrollTop] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  // THE DEBOUNCE. `raw` follows the keystrokes (so the input never lags the
  // typist); `query` — the value the list actually filters on — settles 200ms
  // later. useDeferredValue alone would not do it: it de-prioritises the render
  // but still runs one filter pass per character.
  useEffect(() => {
    const id = window.setTimeout(() => setQuery(raw), DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [raw]);
  const deferredQuery = useDeferredValue(query);

  const matches = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    if (q === "") return options;
    return options.filter((o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q));
  }, [options, deferredQuery]);

  // Reset the scroll window whenever the match set changes, or the first render
  // after a search shows rows from the middle of the previous list.
  useEffect(() => {
    setScrollTop(0);
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [deferredQuery]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const selected = useMemo(() => new Set(values), [values]);
  const toggle = (value: string) => {
    onChange(selected.has(value) ? values.filter((v) => v !== value) : [...values, value]);
  };

  // ── the virtual window ────────────────────────────────────────────────────
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(matches.length, first + WINDOW_ROWS + OVERSCAN * 2);
  const visible = matches.slice(first, last);

  const triggerLabel =
    values.length === 0
      ? placeholder
      : values.length <= 2
        ? values.map((v) => options.find((o) => o.value === v)?.label ?? v).join(listSeparator)
        : t("salesReports.itemPicker.selectedCount", { count: formatNumber(values.length) });

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <div className="flex min-h-11 w-full items-stretch overflow-hidden rounded-xl border border-slate-200 bg-white text-sm font-bold text-slate-700 transition-colors focus-within:border-teal-300 focus-within:ring-2 focus-within:ring-teal-500/40 hover:border-teal-300">
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listboxId : undefined}
          aria-label={ariaLabel}
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 items-center gap-2 px-3 text-start focus:outline-none"
        >
          <span className={cn("flex-1 truncate", values.length === 0 && "font-medium text-slate-400")}>
            {triggerLabel}
          </span>
          <ChevronDown
            className={cn("h-4 w-4 shrink-0 text-slate-400 transition-transform", open && "rotate-180")}
            aria-hidden="true"
          />
        </button>
        {values.length > 0 && (
          <button
            type="button"
            aria-label={t("salesReports.itemPicker.clear")}
            onClick={() => onChange([])}
            className="grid h-11 w-11 shrink-0 place-items-center border-s border-slate-100 text-slate-400 transition hover:bg-slate-50 hover:text-rose-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-500"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {open && (
        <div className="absolute z-30 mt-1 w-[min(24rem,calc(100vw-2rem))] rounded-2xl border border-slate-200 bg-white p-1.5 shadow-lift start-0">
          <div className="flex items-center gap-2 rounded-xl border border-slate-200 px-2.5">
            <Search className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
            <input
              type="text"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              aria-label={t("salesReports.itemPicker.search")}
              placeholder={t("salesReports.itemPicker.search")}
              className="min-h-11 w-full bg-transparent text-sm font-bold text-slate-700 outline-none placeholder:font-medium placeholder:text-slate-400"
              autoFocus
            />
          </div>

          <div
            id={listboxId}
            role="listbox"
            aria-multiselectable="true"
            aria-label={ariaLabel}
            ref={listRef}
            data-testid="item-picker-list"
            onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
            className="mt-1.5 overflow-y-auto"
            style={{ height: WINDOW_ROWS * ROW_H }}
          >
            {matches.length === 0 ? (
              <p className="px-2.5 py-3 text-xs font-bold text-slate-400">
                {t("salesReports.itemPicker.empty")}
              </p>
            ) : (
              // The spacer div carries the FULL height so the scrollbar is
              // honest about how much list there is; the mounted rows are
              // absolutely positioned inside it at their real offsets.
              <div style={{ height: matches.length * ROW_H, position: "relative" }}>
                {visible.map((opt, i) => {
                  const index = first + i;
                  const isSelected = selected.has(opt.value);
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      onClick={() => toggle(opt.value)}
                      style={{ position: "absolute", top: index * ROW_H, height: ROW_H, insetInline: 0 }}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-lg px-2.5 text-start text-sm font-bold transition-colors",
                        isSelected ? "bg-teal-50 text-teal-900" : "text-slate-700 hover:bg-slate-50",
                      )}
                    >
                      <Check
                        className={cn("h-4 w-4 shrink-0", isSelected ? "text-teal-700" : "text-transparent")}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 truncate">{opt.label}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* The route caps its answer; saying so is the difference between a
              short list and a list the reader believes is complete. */}
          {options.length >= serverCap && (
            <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-bold text-amber-700">
              {t("salesReports.itemPicker.truncatedNote", { count: formatNumber(serverCap) })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
