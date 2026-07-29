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
import { LoadingState, PageHeader, PermissionDenied, StateShell } from "@/shared/ui";
import { normalizeRoutePath } from "@/shared/lib";
import { useUrlFilters } from "@/shared/hooks/useUrlFilters";
import { useCan, usePermissions, type Capability } from "@/shared/permissions";
import { PrintArea } from "@/modules/accounting/components";
import { useT } from "@/i18n";
import { analyticsFilterCodec } from "./lib/filters";
import { AnalyticsTopBar } from "./components/AnalyticsTopBar";
import { BasisOfPreparation } from "./components/BasisOfPreparation";
import { SectionPicker } from "./components/SectionPicker";
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
      <AnalyticsTopBar filters={filters} patch={patch} reset={reset} />
      {segmentDenied ? (
        <PermissionDenied />
      ) : (
        // PrintArea marks the routed report as THE printable document (see
        // styles/index.css @media print): printing the hub then puts the
        // report on paper, not the picker, the filter bar and the app shell.
        <PrintArea>
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
        </PrintArea>
      )}
    </>
  );
}
