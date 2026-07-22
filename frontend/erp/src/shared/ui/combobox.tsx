import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown, Search, X } from "lucide-react";
import { cn } from "@/shared/lib";
import { useTx } from "./i18n";

export interface ComboboxOption<T extends string> {
  value: T;
  label: string;
  sublabel?: string;
  disabled?: boolean;
}

export interface ComboboxProps<T extends string> {
  options: ComboboxOption<T>[];
  value: T | null;
  onChange: (value: T | null) => void;
  placeholder?: string;
  emptyText?: string;
  disabled?: boolean;
  clearable?: boolean;
  id?: string;
  invalid?: boolean;
  "aria-label"?: string;
}

/**
 * Client-side searchable single-select over an IN-MEMORY option list (statuses,
 * categories, a small enum). For long/paginated server lists use
 * SearchableEntityCombobox. Accessible combobox/listbox with keyboard nav.
 */
export function Combobox<T extends string>({
  options,
  value,
  onChange,
  placeholder,
  emptyText,
  disabled = false,
  clearable = true,
  id,
  invalid,
  "aria-label": ariaLabel,
}: ComboboxProps<T>) {
  const t = useTx();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const autoId = useId();
  const listId = `${id ?? autoId}-list`;

  const selected = useMemo(() => options.find((o) => o.value === value) ?? null, [options, value]);
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

  function pick(v: T) {
    onChange(v);
    setOpen(false);
    setQ("");
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
      if (opt && !opt.disabled) pick(opt.value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button
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
          "field flex items-center justify-between gap-2 py-2 text-right",
          invalid && "border-rose-400 focus:border-rose-500 focus:ring-rose-100",
          disabled && "cursor-not-allowed opacity-60",
        )}
      >
        <span className={cn("truncate", selected ? "text-slate-800" : "font-normal text-slate-400")}>
          {selected ? selected.label : (placeholder ?? t("sharedUi.combobox.placeholder"))}
        </span>
        <span className="flex items-center gap-1">
          {clearable && selected && !disabled && (
            <span
              role="button"
              tabIndex={-1}
              aria-label={t("sharedUi.combobox.clear")}
              className="grid h-6 w-6 place-items-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-rose-600"
              onClick={(e) => {
                e.stopPropagation();
                onChange(null);
              }}
            >
              <X className="h-3.5 w-3.5" />
            </span>
          )}
          <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
        </span>
      </button>

      {open && (
        <div
          className="absolute z-popover mt-1 w-full overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl ring-1 ring-black/5"
          dir="rtl"
        >
          <div className="border-b border-slate-100 p-2">
            <label className="relative block">
              <Search className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={onKeyDown}
                className="field h-9 w-full py-1 pr-9 text-sm"
                placeholder={t("sharedUi.combobox.searchPlaceholder")}
                aria-label={t("sharedUi.combobox.searchLabel")}
              />
            </label>
          </div>
          <ul id={listId} role="listbox" className="max-h-64 overflow-y-auto p-1">
            {filtered.length === 0 ? (
              <li className="px-3 py-3 text-xs font-medium text-slate-400">{emptyText ?? t("sharedUi.combobox.empty")}</li>
            ) : (
              filtered.map((o, i) => (
                <li key={o.value} role="option" aria-selected={o.value === value}>
                  <button
                    type="button"
                    disabled={o.disabled}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => pick(o.value)}
                    className={cn(
                      "flex w-full flex-col rounded-lg px-3 py-2 text-right transition disabled:cursor-not-allowed disabled:opacity-50",
                      i === active ? "bg-teal-50 ring-1 ring-teal-200" : "hover:bg-slate-50",
                    )}
                  >
                    <span className="truncate text-sm font-semibold text-slate-700">{o.label}</span>
                    {o.sublabel && <span className="truncate text-[11px] text-slate-400">{o.sublabel}</span>}
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
