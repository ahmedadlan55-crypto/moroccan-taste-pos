// Phase W2 — lightweight item picker: debounced search over the existing item
// master endpoint (GET /api/inventory/v2/items?q=… via useItemList; response
// is { data:[{ id, name, sku, unit … }] }). Selected value renders as a chip
// with a clear button.

import { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { useDebouncedValue } from "@/lib/hooks/useDebouncedValue";
import { useItemList } from "@/lib/hooks/useItems";

export interface ItemOption {
  id: string;
  name: string;
}

export function ItemSearchSelect({
  value,
  onChange,
  disabled = false,
  placeholder = "ابحث عن صنف بالاسم أو SKU…",
}: {
  value: ItemOption | null;
  onChange: (v: ItemOption | null) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const debounced = useDebouncedValue(q, 300);
  const boxRef = useRef<HTMLDivElement>(null);

  const { data, isLoading } = useItemList({ q: debounced, status: "active", pageSize: 8 });
  const rows = data?.rows ?? [];

  // Close the results panel on an outside click.
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  if (value) {
    return (
      <div className="flex min-h-11 items-center justify-between gap-2 rounded-xl border border-teal-200 bg-teal-50/60 px-3 py-2">
        <span className="truncate text-sm font-bold text-slate-800">{value.name}</span>
        {!disabled && (
          <button
            type="button"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-slate-400 transition hover:bg-white hover:text-rose-600"
            aria-label="مسح الصنف المحدد"
            onClick={() => onChange(null)}
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    );
  }

  return (
    <div ref={boxRef} className="relative">
      <label className="relative block">
        <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          className="field w-full pr-10"
          placeholder={placeholder}
          value={q}
          disabled={disabled}
          onFocus={() => setOpen(true)}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          aria-label="بحث عن صنف"
          role="combobox"
          aria-expanded={open}
          aria-controls="item-search-results"
        />
      </label>
      {open && !disabled && (
        <div
          id="item-search-results"
          role="listbox"
          className="absolute z-30 mt-1 max-h-64 w-full overflow-y-auto rounded-xl border border-slate-200 bg-white p-1 shadow-lg"
        >
          {isLoading ? (
            <div className="px-3 py-2 text-xs font-medium text-slate-400">جارٍ البحث…</div>
          ) : rows.length === 0 ? (
            <div className="px-3 py-2 text-xs font-medium text-slate-400">
              {debounced ? "لا نتائج مطابقة." : "اكتب للبحث عن صنف."}
            </div>
          ) : (
            rows.map((it) => (
              <button
                key={it.id}
                type="button"
                role="option"
                aria-selected="false"
                className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-right text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                onClick={() => {
                  onChange({ id: it.id, name: it.name });
                  setOpen(false);
                  setQ("");
                }}
              >
                <span className="truncate">{it.name}</span>
                <span className="shrink-0 text-[10px] font-bold text-slate-400">{it.sku || it.unit}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
