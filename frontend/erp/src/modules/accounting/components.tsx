// ── Shared building blocks for the accounting screens ───────────────────────
// Report scaffolding (filter card, print/export actions, print banner), the
// money formatter, and a small deferred-screen placeholder for the HEAVY
// editors that stay in the legacy system for now.

import { useState, type ReactNode } from "react";
import { Printer, Construction, ExternalLink } from "lucide-react";
import { Button } from "@/shared/ui";
import { LoadingState, ErrorState, EmptyState } from "@/shared/ui";
import { getIcon } from "@/app/shell/icons";
import { navByPath, navGroupOf } from "@/app/navigation/manifest";

// English-digit, 2-decimal grouping — matches the legacy report formatting and
// the app-wide numbering policy (English numerals inside RTL layout).
const NUM = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
export function fmt(value: number | null | undefined): string {
  return NUM.format(Number(value) || 0);
}

/** A signed amount cell: LTR + tabular, negatives parenthesised, zero → dash. */
export function Num({
  value,
  dash = true,
  strong = false,
  signed = false,
}: {
  value: number | null | undefined;
  dash?: boolean;
  strong?: boolean;
  signed?: boolean;
}) {
  const n = Number(value) || 0;
  if (dash && Math.abs(n) < 0.005) {
    return <span className="tabular-nums text-slate-300">—</span>;
  }
  const negative = n < 0;
  const body = signed && negative ? `(${fmt(Math.abs(n))})` : fmt(n);
  return (
    <span
      dir="ltr"
      className={[
        "tabular-nums",
        strong ? "font-extrabold text-slate-900" : "font-semibold text-slate-700",
        signed && negative ? "text-rose-600" : "",
      ].join(" ")}
    >
      {body}
    </span>
  );
}

// ── Applied-vs-draft filter state (run-on-click, like the legacy loaders) ────
export function useAppliedFilter<T>(initial: T): {
  draft: T;
  applied: T;
  setDraft: (next: T) => void;
  patch: (part: Partial<T>) => void;
  run: () => void;
} {
  const [draft, setDraft] = useState<T>(initial);
  const [applied, setApplied] = useState<T>(initial);
  return {
    draft,
    applied,
    setDraft,
    patch: (part) => setDraft({ ...draft, ...part }),
    run: () => setApplied(draft),
  };
}

// ── Report page shell ───────────────────────────────────────────────────────
export function ReportHeader({
  title,
  subtitle,
  onPrint,
  extraActions,
}: {
  title: string;
  subtitle?: string;
  onPrint?: () => void;
  extraActions?: ReactNode;
}) {
  return (
    <div className="no-print mb-5 flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
      <div className="min-w-0">
        <div className="mb-1 text-xs font-extrabold tracking-wide text-teal-700">المحاسبة</div>
        <h1 className="text-2xl font-extrabold tracking-tight text-slate-950 sm:text-3xl">{title}</h1>
        {subtitle && (
          <p className="mt-2 max-w-3xl text-sm font-medium leading-6 text-slate-500">{subtitle}</p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {extraActions}
        {onPrint && (
          <Button variant="secondary" onClick={onPrint}>
            <Printer className="h-4 w-4" /> طباعة
          </Button>
        )}
      </div>
    </div>
  );
}

/** The filter row card — hidden when printing. */
export function FilterCard({
  children,
  onRun,
  running,
  runLabel = "عرض التقرير",
}: {
  children: ReactNode;
  onRun: () => void;
  running?: boolean;
  runLabel?: string;
}) {
  return (
    <div className="no-print surface mb-5 p-4">
      <div className="flex flex-wrap items-end gap-3">
        {children}
        <Button variant="primary" onClick={onRun} loading={running}>
          {runLabel}
        </Button>
      </div>
    </div>
  );
}

/** A single labelled filter control. */
export function FilterField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-w-40 flex-col gap-1">
      <span className="text-xs font-bold text-slate-600">{label}</span>
      {children}
    </label>
  );
}

/** Screen + print banner shown at the top of the printable results area. */
export function PrintBanner({ title, period }: { title: string; period: string }) {
  return (
    <div className="mb-4 flex flex-col gap-1 border-b border-slate-200 pb-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-extrabold text-slate-900">{title}</h2>
        <span className="text-xs font-extrabold text-teal-700">نظام ADLAN</span>
      </div>
      <div className="text-xs font-bold text-slate-500">{period}</div>
    </div>
  );
}

/** Wrap the printable report body so only it prints (see index.css @media print). */
export function PrintArea({ children }: { children: ReactNode }) {
  return <div className="print-document">{children}</div>;
}

/** Uniform loading / error / empty gate for a report body. */
export function ReportState({
  isLoading,
  error,
  isEmpty,
  onRetry,
  emptyTitle = "لا توجد بيانات",
  emptyBody,
  children,
}: {
  isLoading: boolean;
  error: unknown;
  isEmpty: boolean;
  onRetry?: () => void;
  emptyTitle?: string;
  emptyBody?: string;
  children: ReactNode;
}) {
  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  if (isEmpty) return <EmptyState title={emptyTitle} body={emptyBody} />;
  return <>{children}</>;
}

export function printReport() {
  window.print();
}

// Client-side CSV export (the aging endpoints return JSON, not CSV). Prefixed
// with a UTF-8 BOM so Excel renders the Arabic headers correctly.
export function exportRowsCsv(filename: string, header: string[], rows: (string | number)[][]) {
  const esc = (v: string | number) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = [header, ...rows].map((r) => r.map(esc).join(",")).join("\r\n");
  const blob = new Blob([`﻿${body}`], { type: "text/csv;charset=utf-8;" });
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
}

// ── Deferred screen (HEAVY editors that stay in the legacy app for now) ──────
export function DeferredScreen({ pathname }: { pathname: string }) {
  const item = navByPath(pathname);
  const group = item ? navGroupOf(item) : undefined;
  const Icon = item ? getIcon(item.icon) : Construction;
  return (
    <div className="space-y-5">
      <header className="flex items-center gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-teal-50 text-teal-700">
          <Icon className="h-5 w-5" />
        </span>
        <div>
          <h1 className="text-xl font-extrabold text-slate-900">{item?.label ?? group?.label}</h1>
          <p className="mt-0.5 text-[12px] font-bold text-slate-400">الواجهة الموحّدة — نظام ADLAN</p>
        </div>
      </header>
      <div className="surface grid place-items-center gap-3 p-12 text-center">
        <div className="grid h-14 w-14 place-items-center rounded-2xl bg-slate-100 text-slate-500">
          <Construction className="h-6 w-6" aria-hidden="true" />
        </div>
        <div className="text-base font-extrabold text-slate-800">شاشة متقدّمة — تُدار حاليًا في النظام الحالي</div>
        <p className="max-w-md text-sm font-medium text-slate-500">
          {item ? `«${item.label}» ` : "هذه الشاشة "}
          محرّر متقدّم لم يُنقل بعد إلى الواجهة الموحّدة. يمكنك استخدامه الآن من النظام الحالي، وسيُنقل لاحقًا ضمن نظام
          ADLAN.
        </p>
        <a
          href="/"
          className="mt-1 inline-flex min-h-11 items-center gap-2 rounded-xl bg-teal-600 px-4 text-sm font-bold text-white transition hover:bg-teal-700"
        >
          <ExternalLink className="h-4 w-4" /> فتح في النظام الحالي
        </a>
      </div>
    </div>
  );
}
