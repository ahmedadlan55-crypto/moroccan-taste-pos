// MultiSelectCombobox — the multi-value sibling of Combobox for IN-MEMORY
// option lists (branches, channels, categories). Search input, checkbox rows,
// select-all/clear, keyboard navigation; the popover stays OPEN across toggles
// (multi-select). For long/paginated server lists keep using
// SearchableEntityCombobox (single) — a server-backed multi belongs to a later
// wave.
//
// Strings: callers should pass explicit labels (t(...)); the fallbacks reuse
// EXISTING sharedUi/table dictionary keys via useTx — no new i18n keys here.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";
import { cn, formatNumber } from "@/shared/lib";
import { useTx } from "./i18n";

export interface MultiSelectOption {
  value: string;
  label: string;
  sublabel?: string;
  disabled?: boolean;
}

export interface MultiSelectComboboxLabels {
  placeholder?: string;
  searchPlaceholder?: string;
  empty?: string;
  selectAll?: string;
  clear?: string;
  /** Trigger text when more than `maxLabelCount` options are selected. */
  countLabel?: (count: number) => string;
}

export interface MultiSelectComboboxProps {
  options: MultiSelectOption[];
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  /** Show the search input (default true). */
  searchable?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
  id?: string;
  invalid?: boolean;
  labels?: MultiSelectComboboxLabels;
  /** Up to this many selections the trigger joins the labels; above it shows a count (default 2). */
  maxLabelCount?: number;
  className?: string;
}

export function MultiSelectCombobox({
  options,
  values,
  onChange,
  placeholder,
  searchable = true,
  disabled = false,
  ariaLabel,
  id,
  invalid,
  labels,
  maxLabelCount = 2,
  className,
}: MultiSelectComboboxProps) {
  const t = useTx();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const autoId = useId();
  const listId = `${id ?? autoId}-list`;

  const selectedSet = useMemo(() => new Set(values), [values]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return options;
    return options.filter(
      (o) => o.label.toLowerCase().includes(needle) || o.sublabel?.toLowerCase().includes(needle),
    );
  }, [options, q]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [q, open]);

  function toggle(value: string) {
    onChange(selectedSet.has(value) ? values.filter((v) => v !== value) : [...values, value]);
    // popover stays open — multi-select.
  }

  const enabledFiltered = filtered.filter((o) => !o.disabled);
  const allFilteredSelected =
    enabledFiltered.length > 0 && enabledFiltered.every((o) => selectedSet.has(o.value));

  /** Select-all over the CURRENT (filtered) list; toggles off when all are on. */
  function selectAllFiltered() {
    if (allFilteredSelected) {
      const drop = new Set(enabledFiltered.map((o) => o.value));
      onChange(values.filter((v) => !drop.has(v)));
    } else {
      const merged = new Set(values);
      for (const o of enabledFiltered) merged.add(o.value);
      onChange([...merged]);
    }
  }

  function close() {
    setOpen(false);
    setQ("");
    triggerRef.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open && (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      setOpen(true);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const opt = filtered[active];
      if (opt && !opt.disabled) toggle(opt.value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  const selectedLabels = useMemo(
    () => options.filter((o) => selectedSet.has(o.value)).map((o) => o.label),
    [options, selectedSet],
  );

  const triggerText =
    selectedLabels.length === 0
      ? (labels?.placeholder ?? placeholder ?? t("sharedUi.combobox.placeholder"))
      : selectedLabels.length <= maxLabelCount
        ? selectedLabels.join(", ")
        : (labels?.countLabel?.(selectedLabels.length) ?? formatNumber(selectedLabels.length));

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        onClick={() => !disabled && setOpen((o) => !o)}
        onKeyDown={onKeyDown}
        className={cn(
          "field flex items-center justify-between gap-2 py-2 text-start",
          invalid && "border-rose-400 focus:border-rose-500 focus:ring-rose-100",
          disabled && "cursor-not-allowed opacity-60",
        )}
      >
        <span
          className={cn(
            "truncate",
            selectedLabels.length > 0 ? "text-slate-800" : "font-normal text-slate-400",
          )}
        >
          {triggerText}
        </span>
        <span className="flex items-center gap-1">
          {selectedLabels.length > 0 && !disabled && (
            <span
              role="button"
              tabIndex={-1}
              aria-label={labels?.clear ?? t("sharedUi.combobox.clear")}
              className="grid h-6 w-6 place-items-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-rose-600"
              onClick={(e) => {
                e.stopPropagation();
                onChange([]);
              }}
            >
              <X className="h-3.5 w-3.5" />
            </span>
          )}
          <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
        </span>
      </button>

      {open && (
        <div className="absolute z-popover mt-1 w-full min-w-56 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl ring-1 ring-black/5">
          {searchable && (
            <div className="border-b border-slate-100 p-2">
              <label className="relative block">
                <Search className="pointer-events-none absolute end-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  autoFocus
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={onKeyDown}
                  className="field h-9 w-full py-1 pe-9 text-sm"
                  placeholder={labels?.searchPlaceholder ?? t("sharedUi.combobox.searchPlaceholder")}
                  aria-label={labels?.searchPlaceholder ?? t("sharedUi.combobox.searchLabel")}
                />
              </label>
            </div>
          )}
          <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-2 py-1.5">
            <button
              type="button"
              onClick={selectAllFiltered}
              disabled={enabledFiltered.length === 0}
              className="rounded-md px-2 py-1 text-xs font-extrabold text-teal-700 transition hover:bg-teal-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {labels?.selectAll ?? t("table.selectAllRows")}
            </button>
            <button
              type="button"
              onClick={() => onChange([])}
              disabled={values.length === 0}
              className="rounded-md px-2 py-1 text-xs font-extrabold text-slate-500 transition hover:bg-slate-50 hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {labels?.clear ?? t("sharedUi.combobox.clear")}
            </button>
          </div>
          <ul id={listId} role="listbox" aria-multiselectable="true" className="max-h-64 overflow-y-auto p-1">
            {filtered.length === 0 ? (
              <li className="px-3 py-3 text-xs font-medium text-slate-400">
                {labels?.empty ?? t("sharedUi.combobox.empty")}
              </li>
            ) : (
              filtered.map((o, i) => {
                const checked = selectedSet.has(o.value);
                return (
                  <li key={o.value} role="option" aria-selected={checked}>
                    <button
                      type="button"
                      disabled={o.disabled}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => toggle(o.value)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-start transition disabled:cursor-not-allowed disabled:opacity-50",
                        i === active ? "bg-teal-50 ring-1 ring-teal-200" : "hover:bg-slate-50",
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          "grid h-4 w-4 shrink-0 place-items-center rounded border transition",
                          checked ? "border-teal-600 bg-teal-600 text-white" : "border-slate-300 bg-white",
                        )}
                      >
                        {checked && <Check className="h-3 w-3" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-slate-700">{o.label}</span>
                        {o.sublabel && (
                          <span className="block truncate text-[11px] text-slate-400">{o.sublabel}</span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
