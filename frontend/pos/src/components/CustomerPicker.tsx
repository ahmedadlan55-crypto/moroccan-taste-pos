/**
 * CustomerPicker — the searchable customer selector for POS V2 (Order-to-Cash).
 * Opens showing the FIRST PAGE instantly (no typing needed), searches the server
 * (/api/order-to-cash/customers/search) with a 250ms debounce, supports keyboard
 * navigation + ARIA, and surfaces a loading / empty / error+retry state (never a
 * silent empty list). No native <select>. Selecting a row returns the REAL
 * customerId (+ name/phone + credit summary) to the caller.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Loader2, Search, X } from "lucide-react";
import { searchCustomers, type PosCustomerHit } from "@/lib/api";
import { fmt2 } from "@/lib/format";
import { cn } from "./ui";

export interface CustomerPickerProps {
  value: { id: string; name: string | null; phone: string | null } | null;
  onChange: (c: { id: string; name: string | null; phone: string | null } | null) => void;
}

function sublabel(c: PosCustomerHit): string {
  const bits: string[] = [];
  if (c.phone) bits.push(c.phone);
  const bal = c.derived?.arBalance ?? c.balance;
  if (Number(c.creditLimit) > 0) bits.push(`المتاح ${fmt2(Number(c.creditLimit) - Number(bal || 0))}`);
  return bits.join(" · ");
}

export function CustomerPicker({ value, onChange }: CustomerPickerProps) {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const query = useQuery({
    queryKey: ["o2c-customer-search", debounced],
    queryFn: () => searchCustomers(debounced, 1),
    enabled: !value, // only search while picking
    staleTime: 15_000,
  });

  const rows = useMemo(() => query.data?.data ?? [], [query.data]);
  useEffect(() => { setActive(0); }, [debounced]);

  if (value) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-xl border border-teal-200 bg-teal-50 px-3 py-2">
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-extrabold text-teal-800">{value.name || "عميل"}</span>
          {value.phone ? <span dir="ltr" className="truncate text-[11px] font-bold text-teal-600 num">{value.phone}</span> : null}
        </span>
        <button
          type="button"
          onClick={() => onChange(null)}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-teal-500 transition hover:bg-white hover:text-rose-600"
          aria-label="مسح العميل"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
    );
  }

  function pick(c: PosCustomerHit | undefined) {
    if (!c) return;
    onChange({ id: c.id, name: c.name, phone: c.phone ?? null });
    setQ("");
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, rows.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); pick(rows[active]); }
  }

  return (
    <div>
      <label className="relative block">
        <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
        <input
          ref={inputRef}
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="ابحث بالاسم أو الهاتف أو الرقم الضريبي…"
          className="field w-full pr-9"
          role="combobox"
          aria-expanded="true"
          aria-controls="o2c-cust-list"
          aria-autocomplete="list"
          autoComplete="off"
          autoFocus
        />
      </label>
      <div id="o2c-cust-list" role="listbox" className="mt-2 max-h-56 overflow-y-auto rounded-xl border border-slate-200 bg-white">
        {query.isError ? (
          <div className="flex flex-col items-center gap-2 px-3 py-5 text-center">
            <AlertTriangle className="h-5 w-5 text-amber-500" aria-hidden />
            <span className="text-xs font-bold text-slate-500">تعذّر تحميل العملاء.</span>
            <button type="button" onClick={() => query.refetch()} className="rounded-lg bg-slate-100 px-3 py-1 text-xs font-extrabold text-slate-700 hover:bg-slate-200">
              إعادة المحاولة
            </button>
          </div>
        ) : query.isLoading ? (
          <div className="flex items-center justify-center gap-2 px-3 py-4 text-xs font-bold text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> جارٍ البحث…
          </div>
        ) : rows.length === 0 ? (
          <div className="px-3 py-4 text-center text-xs font-bold text-slate-400">لا عملاء مطابقون.</div>
        ) : (
          rows.map((c, i) => (
            <button
              key={c.id}
              type="button"
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(c)}
              className={cn(
                "flex w-full items-center justify-between gap-2 px-3 py-2 text-right transition",
                i === active ? "bg-teal-50" : "hover:bg-slate-50",
              )}
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-bold text-slate-700">{c.name}</span>
                {sublabel(c) ? <span dir="ltr" className="truncate text-[11px] font-bold text-slate-400 num">{sublabel(c)}</span> : null}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
