// ExplainNumber — "why is this number what it is?" popover for KPI values.
// A small info trigger opens an accessible click-popover (dropdown-menu
// interaction pattern: outside click / Escape close, focus moves into the
// panel and returns to the trigger) showing the metric's formula, what is
// included/excluded, the filter snapshot it was computed under, and a
// footnote. Purely presentational — every string arrives via props (callers
// pass t(...)); no i18n keys and no data fetching here.
import { useEffect, useId, useRef, useState } from "react";
import { Check, Info, Minus } from "lucide-react";
import { cn } from "@/shared/lib";

export interface ExplainFilterRow {
  label: string;
  value: string;
}

export interface ExplainNumberSectionLabels {
  formula?: string;
  inclusions?: string;
  exclusions?: string;
  filters?: string;
}

export interface ExplainNumberProps {
  /** Popover heading — the metric's name. */
  title: string;
  /** The calculation, shown LTR in monospace (e.g. "net = gross − returns − discounts"). */
  formula?: string;
  /** What counts INTO the number. */
  inclusions?: string[];
  /** What is deliberately left OUT. */
  exclusions?: string[];
  /** The filters the number was computed under (label/value pairs, preformatted). */
  filtersSnapshot?: ExplainFilterRow[];
  footnote?: string;
  /** Accessible name for the info trigger (callers pass t(...)). */
  triggerLabel: string;
  /** Headings for the sections that are present. */
  sectionLabels?: ExplainNumberSectionLabels;
  className?: string;
}

export function ExplainNumber({
  title,
  formula,
  inclusions,
  exclusions,
  filtersSnapshot,
  footnote,
  triggerLabel,
  sectionLabels,
  className,
}: ExplainNumberProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
    function onDoc(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  function close() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  const section = (heading: string | undefined, node: React.ReactNode) => (
    <div className="mt-2 first:mt-0">
      {heading && <div className="mb-1 text-[11px] font-extrabold text-slate-400">{heading}</div>}
      {node}
    </div>
  );

  return (
    <div ref={rootRef} className={cn("relative inline-flex", className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={triggerLabel}
        onClick={() => setOpen((o) => !o)}
        className="grid h-11 w-11 place-items-center rounded-xl text-slate-400 transition hover:bg-slate-100 hover:text-teal-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100"
      >
        <Info className="h-3.5 w-3.5" aria-hidden="true" />
      </button>

      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-labelledby={titleId}
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              close();
            } else if (e.key === "Tab") {
              // Same containment contract as DropdownMenu: leaving the surface
              // closes it, so focus is never stranded behind the popover.
              setOpen(false);
            }
          }}
          className="absolute start-0 top-full z-popover mt-1 w-72 max-w-[85vw] rounded-xl border border-slate-200 bg-white p-3 text-start shadow-xl ring-1 ring-black/5 focus-visible:outline-none"
        >
          <div id={titleId} className="text-sm font-extrabold text-slate-900">
            {title}
          </div>

          {formula &&
            section(
              sectionLabels?.formula,
              <code
                dir="ltr"
                className="block rounded-lg bg-slate-50 px-2 py-1.5 text-left font-mono text-[11px] font-semibold text-slate-700"
              >
                {formula}
              </code>,
            )}

          {inclusions && inclusions.length > 0 &&
            section(
              sectionLabels?.inclusions,
              <ul className="space-y-1">
                {inclusions.map((item, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-xs font-semibold text-slate-600">
                    <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" aria-hidden="true" />
                    <span className="min-w-0">{item}</span>
                  </li>
                ))}
              </ul>,
            )}

          {exclusions && exclusions.length > 0 &&
            section(
              sectionLabels?.exclusions,
              <ul className="space-y-1">
                {exclusions.map((item, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-xs font-semibold text-slate-600">
                    <Minus className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-500" aria-hidden="true" />
                    <span className="min-w-0">{item}</span>
                  </li>
                ))}
              </ul>,
            )}

          {filtersSnapshot && filtersSnapshot.length > 0 &&
            section(
              sectionLabels?.filters,
              <dl className="space-y-1">
                {filtersSnapshot.map((row, i) => (
                  <div key={i} className="flex items-baseline justify-between gap-3 text-xs">
                    <dt className="shrink-0 font-bold text-slate-400">{row.label}</dt>
                    <dd className="min-w-0 truncate text-end font-semibold text-slate-700">{row.value}</dd>
                  </div>
                ))}
              </dl>,
            )}

          {footnote && <p className="mt-2 border-t border-slate-100 pt-2 text-[11px] font-medium text-slate-400">{footnote}</p>}
        </div>
      )}
    </div>
  );
}
