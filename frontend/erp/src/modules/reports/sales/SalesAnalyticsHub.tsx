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
import { LoadingState, PageHeader, PermissionDenied, StateShell, Tabs } from "@/shared/ui";
import { normalizeRoutePath } from "@/shared/lib";
import { useUrlFilters } from "@/shared/hooks/useUrlFilters";
import { useCan, usePermissions, type Capability } from "@/shared/permissions";
import { useT } from "@/i18n";
import { analyticsFilterCodec } from "./lib/filters";
import { AnalyticsTopBar } from "./components/AnalyticsTopBar";
import { SEGMENT_PAGES } from "./pages/registry";

const BASE = "/reports/sales";
const DEFAULT_SEGMENT = "executive";

export interface HubSegment {
  id: string;
  /** Extra capability on top of analytics.view (hidden + deep-link denied). */
  cap?: Capability;
}

/** The 16 hub segments, in tab order. Exported for tests + the pages wave. */
export const SALES_HUB_SEGMENTS: readonly HubSegment[] = [
  { id: "executive" },
  { id: "explorer" },
  { id: "items" },
  { id: "modifiers" },
  { id: "payments" },
  { id: "cashiers", cap: "analytics.employees.view" },
  { id: "branches" },
  { id: "hours" },
  { id: "orders" },
  { id: "discounts" },
  { id: "voids" },
  { id: "shifts" },
  { id: "taxes" },
  { id: "profitability", cap: "analytics.cost.view" },
  { id: "reconciliation" },
  { id: "builder" },
];

export default function SalesAnalyticsHub() {
  const t = useT();
  const { pathname } = useLocation();
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
      <Tabs
        aria-label={t("salesReports.hub.tabsAria")}
        className="mb-4"
        items={visibleSegments.map((s) => ({
          value: s.id,
          label: t(`salesReports.pages.${s.id}.title`),
        }))}
        value={segment.id}
        onChange={(next) => navigate(`${BASE}/${next}`)}
      />
      <AnalyticsTopBar filters={filters} patch={patch} reset={reset} />
      {segmentDenied ? (
        <PermissionDenied />
      ) : (
        <Suspense fallback={<LoadingState />}>
          {(() => {
            const Page = SEGMENT_PAGES[segment.id];
            return <Page />;
          })()}
        </Suspense>
      )}
    </>
  );
}
