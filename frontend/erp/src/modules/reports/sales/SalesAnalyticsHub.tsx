// Sales Analytics Hub — the /reports/sales/* container (rp-sales owns its
// subtree via subRoutes:true in the manifest).
//
// FIVE CENTERS, NOT SEVENTEEN REPORTS
//   /reports/sales                      → <Navigate replace> to the executive centre
//   /reports/sales/<centre>[?view=…]    → picker + view switcher + top bar + report
//   /reports/sales/<retired-segment>    → <Navigate replace> onto its centre + view,
//                                         QUERY STRING INTACT (a bookmark is a promise)
//   /reports/sales/<unknown>            → the shared not-found state
//
//   The centre and the view both come from lib/reportRegistry — this file
//   contains no list of reports, no list of groups and no redirect table of its
//   own. Which is the point: the picker, the switcher, the filter bar and the
//   tests all read the same declaration, so a report cannot exist in one of
//   them and not the others.
//
// CAPABILITIES
//   The whole hub is gated on analytics.view (PermissionDenied without it — the
//   router's CapGuard only checks reports.view, which is broader). A report may
//   carry its OWN capability (registry `cap`): it is hidden from the picker and
//   the switcher, and a direct deep-link renders PermissionDenied instead of
//   the page. A CENTRE disappears only when every one of its views is gated
//   away.
//
// THE AUTO-DROP
//   Filters live in the URL and survive a report switch — which is what makes a
//   drill useful and a shared link honest. But a filter the new report's facts
//   cannot express is one of three bad things: a 422 (visible but useless), a
//   silently unapplied filter whose chip still claims it (invisible and wrong),
//   or a 403 when the dimension is capability-gated. So on arrival the hub
//   clears exactly those keys from the URL and says which ones it cleared.
import { Suspense, useEffect, useMemo, useState } from "react";
import { Compass, FilterX, Loader2 } from "lucide-react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useIsFetching } from "@tanstack/react-query";
import { LoadingState, PageHeader, PermissionDenied, PrintDocument, StateShell } from "@/shared/ui";
import { cn, normalizeRoutePath } from "@/shared/lib";
import { useUrlFilters } from "@/shared/hooks/useUrlFilters";
import { useCan, usePermissions } from "@/shared/permissions";

import { useT } from "@/i18n";
import { analyticsFilterCodec, nonDefaultFilterKeys, type AnalyticsFilters } from "./lib/filters";
import {
  CENTERS,
  FILTER_DIMENSION,
  REPORT_BY_ID,
  reportAnalyticsFilterKeys,
  reportFilterKeys,
  resolveHubRoute,
  supportsDateBasisToggle,
  supportsTaxToggle,
  unsupportedFilterKeys,
  type FilterKey,
} from "./lib/reportRegistry";
import { AnalyticsTopBar } from "./components/AnalyticsTopBar";
import { BasisOfPreparation } from "./components/BasisOfPreparation";

import { CenterNav } from "./components/CenterNav";
import { ViewSwitcher } from "./components/ViewSwitcher";
import { useListSeparator } from "./lib/listSeparator";
import { ReportRailProvider } from "./lib/reportRail";
import { VIEW_PAGES } from "./pages/registry";
import SalesReportsDirectory from "./pages/SalesReportsDirectory";

const BASE = "/reports/sales";

/** Reset value per filter key — the codec's default, so the URL param is removed. */
function clearingPatch(keys: readonly FilterKey[]): Partial<AnalyticsFilters> {
  const out: Partial<AnalyticsFilters> = {};
  for (const key of keys) {
    if (key === "hour") out.hour = "";
    else (out as Record<string, string[]>)[key] = [];
  }
  return out;
}

/** `/reports/sales/<centre>?view=<view>` keeping every other query param. */
function hubHref(center: string, view: string, search: string): { pathname: string; search: string } {
  const sp = new URLSearchParams(search);
  sp.set("view", view);
  const qs = sp.toString();
  return { pathname: `${BASE}/${center}`, search: qs ? `?${qs}` : "" };
}

export default function SalesAnalyticsHub() {
  const t = useT();
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const canViewAnalytics = useCan("analytics.view");
  const { can } = usePermissions();
  const { filters, patch, reset } = useUrlFilters(analyticsFilterCodec);
  const listSeparator = useListSeparator();

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

  const routeKey = normalizeRoutePath(pathname);
  const segmentId = routeKey.startsWith(`${BASE}/`) ? routeKey.slice(BASE.length + 1) : "";
  const viewParam = new URLSearchParams(search).get("view");
  const route = useMemo(() => resolveHubRoute(segmentId, viewParam), [segmentId, viewParam]);

  const report = route ? REPORT_BY_ID[route.view] : undefined;
  const allowedFilterKeys = useMemo(
    () => (report ? reportFilterKeys(report, can) : []),
    [report, can],
  );
  const showExactExport = useMemo(() => {
    if (!report?.exportQuery) return false;
    const exportFilters = new Set(reportAnalyticsFilterKeys(report, can));
    return nonDefaultFilterKeys(filters)
      .filter((key) => key in FILTER_DIMENSION)
      .every((key) => exportFilters.has(key as FilterKey));
  }, [report, filters, can]);

  /* ── the auto-drop ─────────────────────────────────────────────────────── */
  const toDrop = useMemo(() => {
    if (!report) return [] as FilterKey[];
    return unsupportedFilterKeys(report, nonDefaultFilterKeys(filters) as string[], can);
  }, [report, filters, can]);
  const dropSignature = toDrop.join(",");

  // Remembered per view so the notice survives the patch that removes the
  // params (after which `toDrop` is empty — the notice would otherwise flash
  // for one frame and the analyst would never learn their scope changed).
  const [dropped, setDropped] = useState<{ view: string; keys: FilterKey[] } | null>(null);

  useEffect(() => {
    if (!route || dropSignature === "") return;
    setDropped({ view: route.view, keys: dropSignature.split(",") as FilterKey[] });
    patch(clearingPatch(dropSignature.split(",") as FilterKey[]));
    // `patch` is stable per codec; `route.view` and the signature are the real
    // inputs. Re-running on a fresh `filters` object would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dropSignature, route?.view]);

  if (!canViewAnalytics) return <PermissionDenied />;

  if (routeKey === BASE) return <SalesReportsDirectory />;

  const header = (
    <PageHeader
      eyebrow={t("salesReports.hub.eyebrow")}
      title={report ? t(`salesReports.pages.${report.id}.title`) : t("salesReports.hub.title")}
      subtitle={
        report ? t(`salesReports.pages.${report.id}.subtitle`) : t("salesReports.hub.subtitle")
      }
    />
  );

  if (!route || !report) {
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

  // A retired segment (or a `view` belonging to another centre) resolves to its
  // canonical home; the query string — the whole filter state — rides along.
  if (route.redirect) {
    return <Navigate to={hubHref(route.center, route.view, search)} replace />;
  }

  const visible = (viewId: string) => {
    const r = REPORT_BY_ID[viewId];
    return !!r && (!r.cap || can(r.cap));
  };
  const centerViews = CENTERS.find((c) => c.id === route.center)!.views.filter(visible);
  const visibleCenters = CENTERS.map((center) => ({
    id: center.id,
    label: t(`salesReports.centers.${center.id}.title`),
    shortLabel: t(`salesReports.centers.${center.id}.shortTitle`),
    subtitle: t(`salesReports.centers.${center.id}.subtitle`),
    views: center.views.filter(visible),
  })).filter((center) => center.views.length > 0);
  const activeCenter = visibleCenters.find((center) => center.id === route.center);
  const segmentDenied = !!report.cap && !can(report.cap);
  const noticeKeys = dropped && dropped.view === route.view ? dropped.keys : [];

  const goToView = (viewId: string) => {
    const target = REPORT_BY_ID[viewId];
    if (!target) return;
    // Carry the query string across the switch. The hub keeps ALL of its state
    // in the URL (period, tax/date basis, brand/branch/channel scope, drill
    // pins) — navigating to a bare path threw every one of them away, so
    // picking a different report silently reset the analyst's filters back to
    // the default last-30-days, whole-company view. Anything the destination
    // cannot honour is dropped on arrival by the effect above, not here, so
    // one rule covers deep links too.
    navigate(hubHref(target.center, viewId, search));
  };

  const goToCenter = (centerId: string) => {
    const target = visibleCenters.find((center) => center.id === centerId);
    const firstView = target?.views[0];
    if (!firstView) return;
    navigate(hubHref(centerId, firstView, search));
  };

  return (
    <>
      {header}
      <div className="no-print surface mb-4 overflow-hidden" data-testid="sales-workspace-nav">
        <div className="bg-slate-50 p-2.5">
          <CenterNav
            ariaLabel={t("salesReports.hub.tabsAria")}
            value={route.center}
            onChange={goToCenter}
            options={visibleCenters.map(({ id, label, shortLabel }) => ({ id, label, shortLabel }))}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-3 border-t border-slate-100 px-3 py-3 lg:flex-row lg:items-center lg:justify-between lg:px-4">
          <div className="min-w-0 lg:max-w-[34rem]" data-testid="active-sales-center">
            <p className="text-[11px] font-black uppercase tracking-[0.14em] text-teal-700">
              {t("salesReports.hub.workspaceLabel")}
            </p>
            <h2 className="mt-0.5 text-base font-black text-slate-950">{activeCenter?.label}</h2>
            <p className="mt-0.5 text-xs font-medium leading-5 text-slate-500">{activeCenter?.subtitle}</p>
          </div>
          {centerViews.length > 1 && (
            <ViewSwitcher
              ariaLabel={t("salesReports.hub.viewsAria", {
                center: t(`salesReports.centers.${route.center}.title`),
              })}
              value={report.id}
              onChange={goToView}
              className="lg:max-w-[65%] lg:justify-end"
              options={centerViews.map((viewId) => ({
                id: viewId,
                label: t(`salesReports.pages.${viewId}.title`),
              }))}
            />
          )}
        </div>
      </div>

      {noticeKeys.length > 0 && (
        <div
          role="status"
          data-testid="dropped-filters-notice"
          className="no-print mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-extrabold text-amber-800"
        >
          <FilterX className="h-4 w-4 shrink-0" aria-hidden="true" />
          {t("salesReports.hub.filtersDropped", {
            filters: noticeKeys
              .map((k) => t(`salesReports.topbar.filterNames.${k}`))
              .join(listSeparator),
          })}
        </div>
      )}

      {/* The filter bar spans the page, above the work area. It used to sit in
          the 17rem rail beside the report — which is why it measured 1463px
          tall: a 272px column cannot hold period + branch + compare + Apply +
          the action cluster in anything less than five stacked rows, and the
          page's own settings were stacked under them. Full width, it is one
          44px row of controls under one 44px action bar.

          `filterKeys` / `showCompare` / the two basis flags come from the
          registry: a control the routed report cannot honour is not rendered. */}
      <AnalyticsTopBar
        reportId={report.id}
        filters={filters}
        patch={patch}
        reset={reset}
        filterKeys={allowedFilterKeys}
        showCompare={report.compare}
        showDateBasis={supportsDateBasisToggle(report)}
        showTaxBasis={supportsTaxToggle(report)}
        showExport={showExactExport}
      />

      {/* ── the work area: the report, and (only when the routed page publishes
          any) its OWN settings in a rail beside it.

          The rail is CONDITIONAL. Most reports publish nothing, and an
          always-declared 17rem track spent 17rem of every one of those screens
          on an empty column.

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
                  // (shared/ui/print-document).
                  <PrintDocument
                    title={t(`salesReports.pages.${report.id}.title`)}
                    subtitle={`${filters.from} — ${filters.to}`}
                    meta={`${filters.businessDay ? t("salesReports.topbar.businessDay") : t("salesReports.topbar.calendarDay")} · ${filters.taxIncl ? t("salesReports.topbar.taxIncl") : t("salesReports.topbar.taxExcl")}`}
                  >
                    <Suspense fallback={<LoadingState />}>
                      {(() => {
                        const Page = VIEW_PAGES[report.id];
                        return <Page />;
                      })()}
                    </Suspense>
                    {/* INSIDE PrintArea, deliberately. The filter bar states the basis on
                        screen and is .no-print, so a printed report used to carry none of
                        it: two printouts of "sales, July" can differ by a full day's
                        takings — the business day runs past midnight — with nothing on
                        either page to say which is which. Placing it here gives every
                        report the disclosure without touching every file. */}
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
