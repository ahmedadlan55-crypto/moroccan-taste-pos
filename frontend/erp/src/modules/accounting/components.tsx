// ── Shared building blocks for the accounting screens ───────────────────────
// Report scaffolding (filter card, print/export actions, print banner) and the
// money formatter.

import { useState, type ReactNode } from "react";
import { Printer } from "lucide-react";
import { Button } from "@/shared/ui";
import { LoadingState, ErrorState, EmptyState } from "@/shared/ui";
import { useT } from "@/i18n";

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
  const t = useT();
  return (
    <div className="no-print mb-5 flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
      <div className="min-w-0">
        <div className="mb-1 text-xs font-extrabold tracking-wide text-teal-700">{t("accounting.eyebrow")}</div>
        <h1 className="text-2xl font-extrabold tracking-tight text-slate-950 sm:text-3xl">{title}</h1>
        {subtitle && (
          <p className="mt-2 max-w-3xl text-sm font-medium leading-6 text-slate-500">{subtitle}</p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {extraActions}
        {onPrint && (
          <Button variant="secondary" onClick={onPrint}>
            <Printer className="h-4 w-4" /> {t("accounting.common.print")}
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
  runLabel,
}: {
  children: ReactNode;
  onRun: () => void;
  running?: boolean;
  runLabel?: string;
}) {
  const t = useT();
  return (
    <div className="no-print surface mb-5 p-4">
      <div className="flex flex-wrap items-end gap-3">
        {children}
        <Button variant="primary" onClick={onRun} loading={running}>
          {runLabel ?? t("accounting.common.viewReport")}
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
  const t = useT();
  return (
    <div className="mb-4 flex flex-col gap-1 border-b border-slate-200 pb-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-extrabold text-slate-900">{title}</h2>
        <span className="text-xs font-extrabold text-teal-700">{t("accounting.common.systemName")}</span>
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
  emptyTitle,
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
  const t = useT();
  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  if (isEmpty) return <EmptyState title={emptyTitle ?? t("accounting.common.noData")} body={emptyBody} />;
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

