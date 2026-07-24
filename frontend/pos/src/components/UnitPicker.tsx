/**
 * Phase U — searchable unit picker for a cart line. The per-item unit list is
 * short, but the pre-production spec requires a SEARCHABLE list, so this is a
 * filter-input + option list (RTL, touch ≥44px, keyboard: type to filter, Enter
 * picks the first match, Escape closes). Numbers render as English digits.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { useT } from "@/i18n/I18nProvider";
import type { CatalogUnit } from "@/lib/types";
import { fmt2 } from "@/lib/format";
import { cn } from "./ui";

export function UnitPicker({
  units,
  value,
  onSelect,
  baseUnitName,
}: {
  units: CatalogUnit[];
  value: string | null;
  onSelect: (unit: CatalogUnit) => void;
  baseUnitName?: string | null;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  const current = units.find((u) => u.unitCode === value) || units.find((u) => u.isBase) || units[0] || null;

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return units;
    return units.filter((u) => `${u.unitName} ${u.unitCode}`.toLowerCase().includes(needle));
  }, [units, q]);

  function pick(u: CatalogUnit) {
    onSelect(u);
    setOpen(false);
    setQ("");
  }

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t("unitPicker.toggleAria")}
        className="btn-press flex min-h-11 w-full items-center justify-between gap-1 rounded-xl border border-slate-200 bg-white px-2.5 text-xs font-extrabold text-ink hover:bg-slate-50"
      >
        <span className="truncate">
          {current ? current.unitName : t("unitPicker.fallbackLabel")}
          {current && !current.isBase ? (
            <span className="ms-1 text-[10px] font-bold text-slate-400">
              (×<span className="num">{fmt2(current.factor)}</span>)
            </span>
          ) : null}
        </span>
        <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
      </button>
      {open ? (
        <div
          role="listbox"
          className="dialog-in absolute z-30 mt-1 w-56 rounded-2xl border border-slate-200 bg-white p-1.5 shadow-lift"
        >
          <div className="relative mb-1">
            <Search className="pointer-events-none absolute end-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" aria-hidden />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && filtered[0]) { e.preventDefault(); pick(filtered[0]); }
                else if (e.key === "Escape") setOpen(false);
              }}
              placeholder={t("unitPicker.search.placeholder")}
              aria-label={t("unitPicker.search.aria")}
              className="field h-9 pe-8 text-xs"
            />
          </div>
          <ul className="max-h-56 overflow-y-auto">
            {filtered.length === 0 ? (
              <li className="px-2 py-2 text-[11px] font-bold text-slate-400">{t("unitPicker.noMatch")}</li>
            ) : (
              filtered.map((u) => (
                <li key={u.unitCode}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={current?.unitCode === u.unitCode}
                    onClick={() => pick(u)}
                    className={cn(
                      "btn-press flex min-h-11 w-full items-center justify-between gap-2 rounded-lg px-2.5 text-start text-xs font-bold transition",
                      current?.unitCode === u.unitCode ? "bg-teal-50 text-teal-700" : "text-ink hover:bg-slate-50",
                    )}
                  >
                    <span className="truncate">
                      {u.unitName}
                      {!u.isBase ? (
                        <span className="ms-1 text-[10px] font-bold text-slate-400">
                          = <span className="num">{fmt2(u.factor)}</span> {baseUnitName || ""}
                        </span>
                      ) : (
                        <span className="ms-1 text-[10px] font-bold text-slate-400">{t("unitPicker.baseTag")}</span>
                      )}
                    </span>
                    {current?.unitCode === u.unitCode ? <Check className="h-3.5 w-3.5 shrink-0 text-teal-600" aria-hidden /> : null}
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
