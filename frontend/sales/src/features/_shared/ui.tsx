// Shared presentational atoms for every O2C screen. Numbers ALWAYS render as
// English digits (formatters use en-US) wrapped in dir="ltr" tabular-nums so
// they align cleanly inside RTL text.
import { type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { statusMeta, type Tone } from "@/lib/status-labels";
import { formatCurrency, formatNumber, formatDate } from "@/lib/formatters";
import { cn } from "@/lib/cn";

const TONE_CLASS: Record<Tone, string> = {
  slate: "bg-slate-100 text-slate-700 ring-slate-200",
  teal: "bg-teal-50 text-teal-700 ring-teal-200",
  amber: "bg-amber-50 text-amber-700 ring-amber-200",
  blue: "bg-blue-50 text-blue-700 ring-blue-200",
  green: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  rose: "bg-rose-50 text-rose-700 ring-rose-200",
  violet: "bg-violet-50 text-violet-700 ring-violet-200",
};

export function StatusPill({ status }: { status: string | null | undefined }) {
  const m = statusMeta(status);
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-bold ring-1", TONE_CLASS[m.tone])}>
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
      {m.label}
    </span>
  );
}

/** Money cell — English digits, LTR, tabular. */
export function Money({ value, className }: { value: number | null | undefined; className?: string }) {
  return <span dir="ltr" className={cn("tabular-nums", className)}>{formatCurrency(value)}</span>;
}

export function Num({ value, className }: { value: number | null | undefined; className?: string }) {
  return <span dir="ltr" className={cn("tabular-nums", className)}>{formatNumber(value)}</span>;
}

export function DateCell({ value }: { value: string | null | undefined }) {
  return <span dir="ltr" className="tabular-nums">{formatDate(value)}</span>;
}

export function Field({ label, children, hint, required }: { label: string; children: ReactNode; hint?: string; required?: boolean }) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-center gap-1 text-sm font-bold text-slate-700">
        {label}
        {required && <span className="text-rose-500">*</span>}
      </span>
      {children}
      {hint && <span className="mt-1 block text-[11px] font-semibold text-slate-400">{hint}</span>}
    </label>
  );
}

export function FieldError({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return <span className="mt-1 block text-[11px] font-bold text-rose-600">{children}</span>;
}

export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="mb-4 flex flex-wrap items-center gap-2">{children}</div>;
}

export function Pagination({ page, totalPages, total, onPage }: { page: number; totalPages: number; total: number; onPage: (p: number) => void }) {
  if (total === 0) return null;
  return (
    <div className="mt-4 flex items-center justify-between gap-3 text-sm">
      <span className="font-semibold text-slate-500">
        الإجمالي: <span dir="ltr" className="tabular-nums font-bold text-slate-700">{formatNumber(total)}</span>
      </span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
          className="grid h-9 w-9 place-items-center rounded-lg border border-slate-200 text-slate-500 transition enabled:hover:bg-slate-50 disabled:opacity-40"
          aria-label="السابق"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
        <span dir="ltr" className="min-w-16 text-center tabular-nums text-sm font-bold text-slate-700">
          {page} / {Math.max(1, totalPages)}
        </span>
        <button
          type="button"
          disabled={page >= totalPages}
          onClick={() => onPage(page + 1)}
          className="grid h-9 w-9 place-items-center rounded-lg border border-slate-200 text-slate-500 transition enabled:hover:bg-slate-50 disabled:opacity-40"
          aria-label="التالي"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

/** A simple data table shell with sticky header + horizontal scroll. */
export function TableShell({ head, children }: { head: ReactNode; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
      <table className="w-full min-w-[720px] border-collapse text-right text-sm">
        <thead className="sticky top-0 bg-slate-50 text-xs font-bold text-slate-500">{head}</thead>
        <tbody className="divide-y divide-slate-100">{children}</tbody>
      </table>
    </div>
  );
}

export function Th({ children, className }: { children: ReactNode; className?: string }) {
  return <th className={cn("whitespace-nowrap px-4 py-3 font-bold", className)}>{children}</th>;
}
export function Td({ children, className }: { children: ReactNode; className?: string }) {
  return <td className={cn("whitespace-nowrap px-4 py-3 text-slate-700", className)}>{children}</td>;
}
