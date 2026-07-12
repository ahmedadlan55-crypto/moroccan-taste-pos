import { useEffect, useRef, useState } from "react";
import { Columns3 } from "lucide-react";
import { Checkbox } from "@/shared/ui";
import type { ColumnDef } from "./types";

export interface ColumnsMenuProps<T> {
  columns: ColumnDef<T>[];
  hiddenColumns: string[];
  onToggle: (columnId: string) => void;
}

/** A popover of checkboxes to show/hide hideable columns. */
export function ColumnsMenu<T>({ columns, hiddenColumns, onToggle }: ColumnsMenuProps<T>) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const hideable = columns.filter((c) => c.hideable !== false);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-sm font-bold text-slate-600 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100"
      >
        <Columns3 className="h-4 w-4" /> الأعمدة
      </button>
      {open && (
        <div
          dir="rtl"
          className="absolute left-0 z-popover mt-1 w-52 rounded-xl border border-slate-200 bg-white p-2 shadow-xl ring-1 ring-black/5"
        >
          <div className="px-2 py-1 text-[11px] font-extrabold text-slate-400">إظهار الأعمدة</div>
          <ul className="max-h-64 space-y-0.5 overflow-y-auto">
            {hideable.map((c) => (
              <li key={c.id}>
                <Checkbox
                  className="w-full rounded-lg px-2 py-1.5 hover:bg-slate-50"
                  checked={!hiddenColumns.includes(c.id)}
                  onChange={() => onToggle(c.id)}
                  label={typeof c.header === "string" ? c.header : (c.label ?? c.id)}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
