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
import { Compass } from "lucide-react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { LoadingState, PageHeader, PermissionDenied, PrintDocument, StateShell } from "@/shared/ui";
import { normalizeRoutePath } from "@/shared/lib";
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
      {/* ── the work area: ONE filters-and-settings column, the report beside it.
          The two panels the analyst used to reassemble by eye — the shared
          filter bar and the page's own settings card — are now one rail.

          `xl`, not `lg`: at 1024 (a viewport the e2e suite actually runs) a
          17rem rail leaves a 400px table. At xl the table gets 640px (1280),
          800px (1440), 1200px (1920), and every viewport below xl keeps
          exactly today's stacked layout.

          `min-w-0` on the container and `minmax(0,1fr)` on the content track
          are load-bearing: grid items default to `min-width:auto`, so without
          them a wide report pushes the page into horizontal overflow.

          `data-analytics-split` is the print hook — see styles/index.css. */}
      <ReportRailProvider>
        {(pageControls) => (
          <div
            data-analytics-split
            className="grid min-w-0 gap-4 xl:grid-cols-[17rem_minmax(0,1fr)] 2xl:grid-cols-[19rem_minmax(0,1fr)]"
          >
            {/* `no-print` removes the whole grid ITEM on paper, so the report
                gets the full sheet with no phantom track and no phantom gap.
                `self-start` keeps the card at its natural height instead of
                stretching to the table's row.

                DELIBERATELY NOT STICKY. The design called for `sticky top-5`
                on the estimate that the rail is ~715px and fits any 1280+
                screen. Measured on the real page it is 1463px — because the
                report's OWN settings now live here too, which is the whole
                point of the rail. A sticky element taller than the viewport
                pins its top and puts its bottom permanently off-screen: the
                Run button and the active-filter chips would be unreachable at
                1280×800. Scrolling with the page keeps every control
                reachable, which beats keeping the period picker in view. */}
            <aside
              className="no-print min-w-0 xl:self-start"
              aria-label={t("salesReports.hub.filtersAria")}
            >
              <AnalyticsTopBar filters={filters} patch={patch} reset={reset}>
                {pageControls}
              </AnalyticsTopBar>
            </aside>

            <div className="min-w-0">
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
        )}
      </ReportRailProvider>
    </>
  );
}
