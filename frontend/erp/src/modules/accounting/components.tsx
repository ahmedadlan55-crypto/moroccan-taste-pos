// ── Shared building blocks for the accounting screens ───────────────────────
// Report scaffolding (filter card, print/export actions, print banner) and the
// money formatter.

import { useState, type ReactNode } from "react";
import { Printer } from "lucide-react";
import { Button } from "@/shared/ui";
import { LoadingState, ErrorState, EmptyState } from "@/shared/ui";
import { useT } from "@/i18n";

// `Num` / `fmt` now live in the shared kit (`shared/ui/num.tsx`) — they are the
// house money cell for the WHOLE product, not an accounting-module detail, and
// the statement renderer in `shared/reports` needs them too. They are re-exported
// under their original names so every existing `import { Num, fmt } from
// "../components"` keeps working unchanged; nothing about their behaviour moved.
export { Num, fmt, type NumProps } from "@/shared/ui";

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
  printDisabled = false,
}: {
  title: string;
  subtitle?: string;
  onPrint?: () => void;
  extraActions?: ReactNode;
  /**
   * Block printing when the source failed. A statement whose query errored
   * still has a page around it — header, filters, print button — and the
   * printed sheet of an errored report is indistinguishable from a real one
   * once it leaves the screen. The button is disabled, not hidden, so the
   * reason stays visible.
   */
  printDisabled?: boolean;
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
          <Button variant="secondary" onClick={onPrint} disabled={printDisabled}>
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
  runDisabled,
}: {
  children: ReactNode;
  onRun: () => void;
  running?: boolean;
  runLabel?: string;
  runDisabled?: boolean;
}) {
  const t = useT();
  return (
    <div className="no-print surface mb-5 p-4">
      <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2 lg:flex lg:flex-wrap">
        {children}
        <Button className="w-full sm:w-auto" variant="primary" onClick={onRun} loading={running} disabled={runDisabled}>
          {runLabel ?? t("accounting.common.viewReport")}
        </Button>
      </div>
    </div>
  );
}

/** A single labelled filter control. */
export function FilterField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1 sm:min-w-40">
      <span className="text-xs font-bold text-slate-600">{label}</span>
      {children}
    </label>
  );
}

// PrintArea and PrintBanner were DELETED here, not deprecated.
//
//   PrintBanner stamped `accounting.common.systemName` — the literal string
//   "نظام ADLAN" — in the top corner of every sheet it headed. That is the
//   software's name, not the entity's, and on an accounting document the issuer
//   line is the one thing that must be true: a balance sheet whose letterhead
//   names the accounting package tells a reader nothing about whose balance
//   sheet it is. `PrintDocument` resolves the real legal name and VAT number
//   from GET /api/settings/invoice-identity, and prints NOTHING when it cannot.
//
//   PrintArea was the bare `.print-document` wrapper the banner sat inside. It
//   carried no title, no period and no printed-at stamp, so a sheet produced
//   through it could not say what it was or when it was run.
//
//   Keeping either as a working export would leave the wrong letterhead one
//   import away. Every screen that printed through them is on PrintDocument
//   now, and `import { PrintArea } from "../components"` no longer resolves —
//   which is the point.

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
    let s = String(v ?? "");
    // Keep user-controlled labels as text when opened by spreadsheet apps.
    // Numeric negatives remain numeric because only string cells are escaped.
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
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

