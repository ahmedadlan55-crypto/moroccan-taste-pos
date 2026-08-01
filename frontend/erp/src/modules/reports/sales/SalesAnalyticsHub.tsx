// Sales Analytics Hub — the /reports/sales/* container (rp-sales owns its
// subtree via subRoutes:true in the manifest).
//
//   /reports/sales               → <Navigate replace> to /reports/sales/executive
//   /reports/sales/<segment>     → tab strip + AnalyticsTopBar + the segment page
//   /reports/sales/<unknown>     → the shared not-found state
//
// The whole hub is gated on analytics.view (PermissionDenied without it — the
// router's CapGuard only checks reports.view, which is broader). Two tabs carry
// their OWN capability: cashiers → analytics.employees.view and profitability →
// analytics.cost.view. Those tabs are HIDDEN from the strip without the cap,
// and a direct deep-link renders PermissionDenied instead of the page.
import { Suspense } from "react";
import { Compass, Loader2 } from "lucide-react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useIsFetching } from "@tanstack/react-query";
import { LoadingState, PageHeader, PermissionDenied, PrintDocument, StateShell } from "@/shared/ui";
import { cn, normalizeRoutePath } from "@/shared/lib";
import { useUrlFilters } from "@/shared/hooks/useUrlFilters";
import { useCan, usePermissions, type Capability } from "@/shared/permissions";

import { useT } from "@/i18n";
import { analyticsFilterCodec } from "./lib/filters";
import { AnalyticsTopBar } from "./components/AnalyticsTopBar";
import { BasisOfPreparation } from "./components/BasisOfPreparation";

import { SectionPicker } from "./components/SectionPicker";
import { ReportRailProvider } from "./lib/reportRail";
import { SEGMENT_PAGES } from "./pages/registry";

const BASE = "/reports/sales";
const DEFAULT_SEGMENT = "executive";

export interface HubSegment {
  id: string;
  /** Extra capability on top of analytics.view (hidden + deep-link denied). */
  cap?: Capability;
  /** Which picker group the section belongs to. */
  group: SectionGroupKey;
}

type SectionGroupKey = "overview" | "products" | "money" | "operations" | "advanced";

/** Picker group order — grouping is what makes 16 reports scannable. */
const SECTION_GROUPS: readonly SectionGroupKey[] = [
  "overview",
  "products",
  "money",
  "operations",
  "advanced",
];

/** The 17 hub segments, in menu order. Exported for tests + the pages. */
export const SALES_HUB_SEGMENTS: readonly HubSegment[] = [
  { id: "executive", group: "overview" },
  { id: "explorer", group: "overview" },
  { id: "branches", group: "overview" },
  { id: "items", group: "products" },
  // No `cap` even though it carries cost columns: the cost/profit/margin
  // columns gate themselves inside the page, so an analyst without
  // analytics.cost.view still gets the quantity/discount/returns report.
  { id: "item-sales", group: "products" },
  { id: "modifiers", group: "products" },
  { id: "profitability", cap: "analytics.cost.view", group: "products" },
  { id: "payments", group: "money" },
  { id: "discounts", group: "money" },
  { id: "taxes", group: "money" },
  { id: "reconciliation", group: "money" },
  { id: "orders", group: "operations" },
  { id: "hours", group: "operations" },
  { id: "cashiers", cap: "analytics.employees.view", group: "operations" },
  { id: "shifts", group: "operations" },
  { id: "voids", group: "operations" },
  { id: "builder", group: "advanced" },
];

export default function SalesAnalyticsHub() {
  const t = useT();
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const canViewAnalytics = useCan("analytics.view");
  const { can } = usePermissions();
  const { filters, patch, reset } = useUrlFilters(analyticsFilterCodec);

  /* ── "the number and the label must never disagree" ───────────────────────
   * The heading, the print masthead and the basis block all read the COMMITTED
   * filters, and the filter bar now commits only on «تطبيق» — so the moment a
   * commit lands, the labels say the new period while the table still holds
   * the old one until the round-trip returns (useAnalyticsQuery deliberately
   * keeps the previous rows on screen, `placeholderData: keepPreviousData`).
   * That window is exactly the silent wrong-number bug, so it is marked:
   * aria-busy for assistive tech, a stale overlay for everyone else.
   *
   * Counted by PREDICATE, not by the ["analytics"] key prefix: saved-views and
   * the registry live under that same prefix and would flag the report stale
   * while a dropdown was populating. Only ["analytics","query",…] is a report. */
  const inFlightReports = useIsFetching({
    predicate: (q) => q.queryKey[0] === "analytics" && q.queryKey[1] === "query",
  });
  const stale = inFlightReports > 0;

  if (!canViewAnalytics) return <PermissionDenied />;

  const key = normalizeRoutePath(pathname);
  if (key === BASE) return <Navigate to={`${BASE}/${DEFAULT_SEGMENT}`} replace />;

  const segmentId = key.startsWith(`${BASE}/`) ? key.slice(BASE.length + 1) : "";
  const segment = SALES_HUB_SEGMENTS.find((s) => s.id === segmentId);

  const visibleSegments = SALES_HUB_SEGMENTS.filter((s) => !s.cap || can(s.cap));

  const header = (
    <PageHeader
      eyebrow={t("salesReports.hub.eyebrow")}
      title={t("salesReports.hub.title")}
      subtitle={
        segment ? t(`salesReports.pages.${segment.id}.subtitle`) : t("salesReports.hub.subtitle")
      }
    />
  );

  if (!segment) {
    return (
      <>
        {header}
        <StateShell
          state="not-found"
          icon={<Compass className="h-6 w-6" />}
          title={t("salesReports.states.notFound")}
          body={t("salesReports.states.notFoundBody")}
        />
      </>
    );
  }

  const segmentDenied = !!segment.cap && !can(segment.cap);

  return (
    <>
      {header}
      <SectionPicker
        className="mb-4"
        label={t("salesReports.hub.pickerLabel")}
        ariaLabel={t("salesReports.hub.tabsAria")}
        value={segment.id}
        // Carry the query string across the section switch. The hub keeps ALL
        // of its state in the URL (period, tax/date basis, brand/branch/channel
        // scope, drill pins) — navigating to a bare path threw every one of
        // them away, so picking a different report silently reset the analyst's
        // filters back to the default last-30-days, whole-company view.
        onChange={(next) => navigate({ pathname: `${BASE}/${next}`, search })}
        groups={SECTION_GROUPS.map((g) => ({
          key: g,
          label: t(`salesReports.groups.${g}`),
          options: visibleSegments
            .filter((s) => s.group === g)
            .map((s) => ({
              id: s.id,
              title: t(`salesReports.pages.${s.id}.title`),
              subtitle: t(`salesReports.pages.${s.id}.subtitle`),
            })),
        })).filter((g) => g.options.length > 0)}
      />
      {/* The filter bar spans the page, above the work area. It used to sit in
          the 17rem rail beside the report — which is why it measured 1463px
          tall: a 272px column cannot hold period + branch + compare + Apply +
          the action cluster in anything less than five stacked rows, and the
          page's own settings were stacked under them. Full width, it is one
          44px row of controls under one 44px action bar. */}
      <AnalyticsTopBar filters={filters} patch={patch} reset={reset} />

      {/* ── the work area: the report, and (only when the routed page publishes
          any) its OWN settings in a rail beside it.

          The rail is CONDITIONAL. Sixteen of the seventeen reports publish
          nothing, and an always-declared 17rem track spent 17rem of every one
          of those screens on an empty column.

          `xl`, not `lg`: at 1024 (a viewport the e2e suite actually runs) a
          17rem rail leaves a 400px table. At xl the table gets 640px (1280),
          800px (1440), 1200px (1920), and every viewport below xl stacks.

          `min-w-0` on the container and `minmax(0,1fr)` on the content track
          are load-bearing: grid items default to `min-width:auto`, so without
          them a wide report pushes the page into horizontal overflow.

          `data-analytics-split` is the print hook — see styles/index.css. */}
      <ReportRailProvider>
        {(pageControls) => (
          <div
            data-analytics-split
            className={cn(
              "grid min-w-0 gap-4",
              pageControls && "xl:grid-cols-[17rem_minmax(0,1fr)] 2xl:grid-cols-[19rem_minmax(0,1fr)]",
            )}
          >
            {/* `no-print` removes the whole grid ITEM on paper, so the report
                gets the full sheet with no phantom track and no phantom gap.
                `self-start` keeps the card at its natural height instead of
                stretching to the table's row.

                DELIBERATELY NOT STICKY: Builder's configuration is taller than
                a 800px viewport, and a sticky element taller than the viewport
                pins its top and puts its bottom (the Run button) permanently
                off-screen. */}
            {pageControls && (
              <aside
                className="no-print min-w-0 xl:self-start"
                aria-label={t("salesReports.hub.settingsAria")}
              >
                <div className="surface p-4">{pageControls}</div>
              </aside>
            )}

            <div
              className="min-w-0"
              data-testid="analytics-results"
              aria-label={t("salesReports.hub.resultsAria")}
              aria-busy={stale || undefined}
            >
              {/* The stale marker. NOT a spinner over an empty box: the figures
                  underneath are real, they just answer the PREVIOUS question,
                  and saying so is the difference between a slow screen and a
                  wrong one. */}
              {stale && (
                <div
                  role="status"
                  data-testid="analytics-stale-notice"
                  className="no-print mb-3 flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-extrabold text-amber-800"
                >
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
                  {t("salesReports.hub.updating")}
                </div>
              )}
              {/* `print:opacity-100` — the dimming is a screen affordance; a
                  sheet printed mid-refetch must still be legible ink. */}
              <div className={cn(stale && "pointer-events-none opacity-40 print:opacity-100")}>
                {segmentDenied ? (
                  <PermissionDenied />
                ) : (
                  // Printing the hub puts the REPORT on paper — not the picker, the
                  // filter bar or the app shell (styles/index.css @media print).
                  // ONE house style, shared with every other printed report in the system
                  // (shared/ui/print-document). The hub used to import PrintArea from the
                  // accounting module and render its own masthead beside it — two copies
                  // of the same idea, free to drift apart.
                  <PrintDocument
                    title={t(`salesReports.pages.${segment.id}.title`)}
                    subtitle={`${filters.from} — ${filters.to}`}
                    meta={`${filters.businessDay ? t("salesReports.topbar.businessDay") : t("salesReports.topbar.calendarDay")} · ${filters.taxIncl ? t("salesReports.topbar.taxIncl") : t("salesReports.topbar.taxExcl")}`}
                  >
                    <Suspense fallback={<LoadingState />}>
                      {(() => {
                        const Page = SEGMENT_PAGES[segment.id];
                        return <Page />;
                      })()}
                    </Suspense>
                    {/* INSIDE PrintArea, deliberately. The filter bar states the basis on
                        screen and is .no-print, so a printed report used to carry none of
                        it: two printouts of "sales, July" can differ by a full day's
                        takings — the business day runs past midnight — with nothing on
                        either page to say which is which. Placing it here gives all 16
                        reports the disclosure without touching 16 files. */}
                    <div className="mt-4">
                      <BasisOfPreparation filters={filters} />
                    </div>
                  </PrintDocument>
                )}
              </div>
            </div>
          </div>
        )}
      </ReportRailProvider>
    </>
  );
}
