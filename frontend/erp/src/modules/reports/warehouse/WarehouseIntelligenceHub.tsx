import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Boxes,
  CircleDollarSign,
  ClipboardList,
  Download,
  PackageCheck,
  PackageMinus,
  PackageX,
  RefreshCw,
  Search,
  ShieldCheck,
  ShoppingCart,
  Users,
} from "lucide-react";
import {
  Badge,
  Button,
  DateRangePicker,
  EmptyState,
  ErrorState,
  LoadingState,
  MetricCard,
  PageHeader,
  SearchableEntityCombobox,
  StatusBadge,
  computePresetRange,
  type DateRange,
  type DateRangePreset,
} from "@/shared/ui";
import { cn, formatCurrency, formatDate, formatNumber, formatQty } from "@/shared/lib";
import { downloadCsv } from "@/shared/lib/downloadCsv";
import { useLang, useT } from "@/i18n";
import { useServerFlags } from "@/app/server-flags";
import { WarehouseModuleProviders } from "@/modules/inventory/lib/providers";
import { WarehouseScopeSelect } from "@/modules/inventory/lib/WarehouseScopeSelect";
import { ALL_WAREHOUSES, useWarehouseScope } from "@/modules/inventory/lib/warehouse-scope-provider";
import { useAnalytics } from "@/modules/inventory/lib/hooks/useAnalytics";
import { makeItemFetcher, supplierFetcher, type ItemHit, type SupplierHit } from "@/modules/inventory/lib/hooks/useEntitySearch";
import { useProcurementReport } from "@/modules/inventory/lib/hooks/useProcurement";
import { usePurchaseIntelligence, useWarehouseIntelligenceOverview } from "./api";
import {
  INVENTORY_INTELLIGENCE_REPORTS,
  PURCHASING_INTELLIGENCE_REPORTS,
  type IntelligenceReportLink,
} from "./reportCatalog";
import type { IntelligenceWarning, PurchaseIntelligenceRow } from "./contracts";

export type WarehouseIntelligenceMode = "inventory" | "purchasing";

const PRESETS: DateRangePreset[] = [
  "today", "yesterday", "last7", "last30", "mtd", "lastMonth",
  "qtd", "lastQuarter", "ytd", "lastYear", "custom",
];

function initialRange(): DateRange {
  return { ...computePresetRange("last30"), preset: "last30" };
}

function presetLabels(t: ReturnType<typeof useT>): Record<DateRangePreset, string> {
  return Object.fromEntries(PRESETS.map((preset) => [preset, t(`warehouseIntelligence.filters.presets.${preset}`)])) as Record<DateRangePreset, string>;
}

function withScope(link: IntelligenceReportLink, range: DateRange, scope: string): string {
  if (!link.to.startsWith("/reports/inventory/")) return link.to;
  const [path, hash] = link.to.split("#");
  const params = new URLSearchParams({ from: range.from, to: range.to });
  if (scope !== ALL_WAREHOUSES) params.set("wh", scope);
  return `${path}?${params.toString()}${hash ? `#${hash}` : ""}`;
}

function IntelligenceNavigation({ mode }: { mode: WarehouseIntelligenceMode }) {
  const t = useT();
  return (
    <nav className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-2" aria-label={t("warehouseIntelligence.nav.aria") }>
      {([
        ["inventory", "/reports/inventory", Boxes, "warehouseIntelligence.nav.inventory", "warehouseIntelligence.nav.inventoryHint"],
        ["purchasing", "/reports/purchasing", ShoppingCart, "warehouseIntelligence.nav.purchasing", "warehouseIntelligence.nav.purchasingHint"],
      ] as const).map(([id, to, Icon, labelKey, hintKey]) => (
        <Link
          key={id}
          to={to}
          aria-current={mode === id ? "page" : undefined}
          className={cn(
            "flex min-h-16 items-center gap-3 rounded-2xl border px-4 py-3 transition focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100",
            mode === id
              ? "border-teal-300 bg-teal-50 text-teal-900 shadow-sm"
              : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50",
          )}
        >
          <span className={cn("grid h-10 w-10 shrink-0 place-items-center rounded-xl", mode === id ? "bg-teal-600 text-white" : "bg-slate-100 text-slate-500")}>
            <Icon className="h-5 w-5" />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-extrabold">{t(labelKey)}</span>
            <span className="mt-0.5 block text-xs font-semibold text-slate-500">{t(hintKey)}</span>
          </span>
        </Link>
      ))}
    </nav>
  );
}

function ReportCatalog({ mode, range, scope }: { mode: WarehouseIntelligenceMode; range: DateRange; scope: string }) {
  const t = useT();
  const lang = useLang();
  const GoArrow = lang === "ar" ? ArrowLeft : ArrowRight;
  const reports = mode === "inventory" ? INVENTORY_INTELLIGENCE_REPORTS : PURCHASING_INTELLIGENCE_REPORTS;
  return (
    <section aria-labelledby="warehouse-report-catalog">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="warehouse-report-catalog" className="text-lg font-extrabold text-slate-900">{t("warehouseIntelligence.catalog.title")}</h2>
          <p className="mt-1 text-xs font-semibold text-slate-500">{t("warehouseIntelligence.catalog.subtitle")}</p>
        </div>
        <Badge tone="neutral">{t("warehouseIntelligence.catalog.count", { count: reports.length })}</Badge>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {reports.map((report) => {
          const Icon = report.icon;
          return (
            <Link
              key={report.id}
              to={withScope(report, range, scope)}
              data-report-id={report.id}
              className="surface group flex min-h-32 items-start gap-3 p-4 transition hover:-translate-y-0.5 hover:border-teal-300 hover:shadow-lift focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100"
            >
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-teal-50 text-teal-700"><Icon className="h-5 w-5" /></span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-2 text-sm font-extrabold text-slate-900">
                  {t(report.labelKey)}
                  <GoArrow className="h-4 w-4 shrink-0 text-slate-300 transition group-hover:text-teal-600" />
                </span>
                <span className="mt-1.5 block text-xs font-medium leading-5 text-slate-500">{t(report.descriptionKey)}</span>
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

function WarningStrip({ warnings }: { warnings: IntelligenceWarning[] }) {
  const t = useT();
  if (!warnings.length) return null;
  return (
    <section className="mb-4 space-y-2" aria-label={t("warehouseIntelligence.warnings.title")}>
      {warnings.map((warning, index) => (
        <div key={`${warning.code}:${index}`} className={cn(
          "flex items-start gap-2 rounded-xl border px-3 py-2.5 text-xs font-bold",
          warning.level === "error" ? "border-rose-200 bg-rose-50 text-rose-800" : "border-amber-200 bg-amber-50 text-amber-800",
        )}>
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{(() => {
            const key = `warehouseIntelligence.warnings.codes.${warning.code}`;
            const translated = t(key);
            return translated === key ? warning.message : translated;
          })()}</span>
        </div>
      ))}
    </section>
  );
}

function nullableCurrency(value: number | null): string {
  return value == null ? "—" : formatCurrency(value);
}

function nullablePercent(value: number | null): string {
  return value == null ? "—" : `${formatNumber(value)}%`;
}

function CostControlPanel({ data }: { data: ReturnType<typeof useWarehouseIntelligenceOverview>["data"] }) {
  const t = useT();
  if (!data) return null;
  const bridge = data.salesCostBridge;
  const stateKey = `warehouseIntelligence.costControl.state.${bridge.state}`;
  const translatedState = t(stateKey);
  return (
    <section className="surface p-4" aria-labelledby="sales-cost-control-title" data-testid="sales-cost-control">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="sales-cost-control-title" className="text-sm font-extrabold text-slate-900">{t("warehouseIntelligence.costControl.title")}</h2>
          <p className="mt-1 max-w-3xl text-xs font-medium leading-5 text-slate-500">{t("warehouseIntelligence.costControl.subtitle")}</p>
        </div>
        <Badge tone={bridge.state === "available" ? "success" : bridge.state === "permission_denied" ? "neutral" : "warning"}>
          {translatedState === stateKey ? bridge.state : translatedState}
        </Badge>
      </div>
      <dl className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
        <MiniTotal label={t("warehouseIntelligence.costControl.netSales")} value={nullableCurrency(bridge.netSalesExVat)} />
        <MiniTotal label={t(bridge.includesReturns ? "warehouseIntelligence.costControl.cogsAfterReturns" : "warehouseIntelligence.costControl.cogsBeforeReturns")} value={nullableCurrency(bridge.cogsSnapshot)} />
        <MiniTotal label={t("warehouseIntelligence.costControl.grossProfit")} value={nullableCurrency(bridge.grossProfit)} />
        <MiniTotal label={t("warehouseIntelligence.costControl.margin")} value={nullablePercent(bridge.marginPct)} />
        <MiniTotal label={t("warehouseIntelligence.costControl.coverage")} value={nullablePercent(bridge.coveragePct)} />
      </dl>
      <div className="mt-4 flex flex-wrap gap-2">
        {([
          ["/reports/sales/items?view=profitability", "warehouseIntelligence.costControl.links.profitability"],
          ["/menu/recipes", "warehouseIntelligence.costControl.links.recipes"],
          ["/production/orders", "warehouseIntelligence.costControl.links.production"],
          ["/accounting/income-statement", "warehouseIntelligence.costControl.links.incomeStatement"],
        ] as const).map(([to, label]) => <Link key={to} to={to} className="inline-flex min-h-10 items-center rounded-xl border border-slate-200 bg-white px-3 text-xs font-extrabold text-slate-600 transition hover:border-teal-300 hover:text-teal-700">{t(label)}</Link>)}
      </div>
      {!bridge.includesReturns && bridge.state === "available" && <p className="mt-3 text-[11px] font-bold text-amber-700">{t("warehouseIntelligence.costControl.beforeReturnsNote")}</p>}
    </section>
  );
}

function CostCoveragePanel({ data }: { data: ReturnType<typeof useWarehouseIntelligenceOverview>["data"] }) {
  const t = useT();
  if (!data) return null;
  const c = data.costCoverage;
  return (
    <section className="surface p-4" aria-labelledby="cost-coverage-title">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="cost-coverage-title" className="text-sm font-extrabold text-slate-900">{t("warehouseIntelligence.costCoverage.title")}</h2>
          <p className="mt-1 text-xs font-medium text-slate-500">{t("warehouseIntelligence.costCoverage.subtitle")}</p>
        </div>
        <Badge tone={c.uncostedStockCount > 0 ? "warning" : "success"}>
          {t("warehouseIntelligence.costCoverage.records", { count: c.totalStockCount })}
        </Badge>
      </div>
      {c.totalStockCount === 0 ? (
        <p className="mt-4 text-sm font-semibold text-slate-400">{t("warehouseIntelligence.costCoverage.empty")}</p>
      ) : (
        <>
          <div className="mt-4 flex h-3 overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
            <span className="bg-emerald-500" style={{ width: `${Math.min(100, c.costedPct)}%` }} />
            <span className="bg-amber-400" style={{ width: `${Math.min(100, c.estimatedPct)}%` }} />
            <span className="bg-rose-500" style={{ width: `${Math.min(100, c.uncostedPct)}%` }} />
          </div>
          <dl className="mt-3 grid gap-2 sm:grid-cols-3">
            {([
              ["costed", c.costedStockCount, c.costedPct, "bg-emerald-500"],
              ["estimated", c.estimatedCostStockCount, c.estimatedPct, "bg-amber-400"],
              ["uncosted", c.uncostedStockCount, c.uncostedPct, "bg-rose-500"],
            ] as const).map(([key, count, pct, color]) => (
              <div key={key} className="rounded-xl bg-slate-50 p-3">
                <dt className="flex items-center gap-2 text-xs font-bold text-slate-500"><span className={cn("h-2.5 w-2.5 rounded-full", color)} />{t(`warehouseIntelligence.costCoverage.${key}`)}</dt>
                <dd className="mt-1 text-sm font-extrabold tabular-nums text-slate-900">{formatNumber(count)} <span className="text-xs text-slate-400">({formatNumber(pct)}%)</span></dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </section>
  );
}

function FlowAndWastePanel({ data }: { data: ReturnType<typeof useWarehouseIntelligenceOverview>["data"] }) {
  const t = useT();
  if (!data) return null;
  const sourceLabel = (source: string) => {
    const key = `warehouseIntelligence.flow.sources.${source}`;
    const translated = t(key);
    return translated === key ? source.replaceAll("_", " ") : translated;
  };
  return (
    <section className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]" data-testid="flow-waste-control">
      <div className="surface overflow-hidden">
        <div className="border-b border-slate-100 px-4 py-3">
          <h2 className="text-sm font-extrabold text-slate-900">{t("warehouseIntelligence.flow.title")}</h2>
          <p className="mt-1 text-xs font-semibold text-slate-500">{t("warehouseIntelligence.flow.subtitle")}</p>
        </div>
        {data.stockFlow.length === 0 ? <p className="p-6 text-center text-sm font-semibold text-slate-400">{t("warehouseIntelligence.flow.empty")}</p> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[520px] text-sm">
            <thead className="bg-slate-50"><tr>
              <th className="px-4 py-3 text-start text-xs font-extrabold text-slate-500">{t("warehouseIntelligence.flow.source")}</th>
              <th className="px-4 py-3 text-start text-xs font-extrabold text-slate-500">{t("warehouseIntelligence.flow.direction")}</th>
              <th className="px-4 py-3 text-start text-xs font-extrabold text-slate-500">{t("warehouseIntelligence.table.qty")}</th>
              <th className="px-4 py-3 text-start text-xs font-extrabold text-slate-500">{t("warehouseIntelligence.table.value")}</th>
            </tr></thead>
            <tbody className="divide-y divide-slate-100">{data.stockFlow.map((row) => {
              const direction = row.direction || row.type.split(":").at(-1) || "out";
              return <tr key={row.type} className="hover:bg-slate-50/70">
                <td className="px-4 py-3 font-bold text-slate-800">{sourceLabel(row.label)}</td>
                <td className="px-4 py-3"><Badge tone={direction === "in" ? "success" : "neutral"}>{t(`warehouseIntelligence.flow.${direction === "in" ? "in" : "out"}`)}</Badge></td>
                <td className="px-4 py-3 font-extrabold tabular-nums text-slate-800">{formatQty(row.qty)}</td>
                <td className="px-4 py-3 font-extrabold tabular-nums text-slate-500">{nullableCurrency(row.value)}</td>
              </tr>;
            })}</tbody>
          </table></div>
        )}
      </div>
      <div className="surface p-4">
        <div className="flex items-center gap-2"><PackageMinus className="h-5 w-5 text-rose-600" /><h2 className="text-sm font-extrabold text-slate-900">{t("warehouseIntelligence.waste.title")}</h2></div>
        <p className="mt-1 text-xs font-semibold leading-5 text-slate-500">{t("warehouseIntelligence.waste.subtitle")}</p>
        <dl className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
          <MiniTotal label={t("warehouseIntelligence.waste.qty")} value={data.kpis.wasteQty == null ? "—" : formatQty(data.kpis.wasteQty)} />
          <MiniTotal label={t("warehouseIntelligence.waste.value")} value={nullableCurrency(data.kpis.wasteValue)} />
        </dl>
      </div>
    </section>
  );
}

function InventoryDecisionView({ range, scope }: { range: DateRange; scope: string }) {
  const t = useT();
  const analytics = useAnalytics(scope, { from: range.from, to: range.to, window: 90 });
  const overview = useWarehouseIntelligenceOverview({ from: range.from, to: range.to, warehouseId: scope === ALL_WAREHOUSES ? undefined : scope });

  if (analytics.isLoading) return <LoadingState rows={6} />;
  if (analytics.isError || !analytics.data) return <ErrorState error={analytics.error} onRetry={() => analytics.refetch()} />;
  const data = analytics.data;
  const k = data.kpis;
  const warnings: IntelligenceWarning[] = [
    ...data.warnings.map((w) => ({ code: w.code, message: w.message, level: (w.level === "error" ? "error" : "warning") as IntelligenceWarning["level"] })),
    ...(overview.data?.warnings ?? []),
  ];

  return (
    <div className="space-y-5" data-testid="inventory-decision-view">
      <WarningStrip warnings={warnings} />
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label={t("warehouseIntelligence.kpis.inventoryAria")}>
        <MetricCard label={t("warehouseIntelligence.kpis.inventoryValue")} value={formatCurrency(k.inventoryValueWac)} note={t("warehouseIntelligence.kpis.wacNote")} icon={CircleDollarSign} />
        <MetricCard label={t("warehouseIntelligence.kpis.totalQty")} value={formatQty(k.totalQty)} note={t("warehouseIntelligence.kpis.itemsNote", { count: k.itemCount })} icon={Boxes} tone="blue" />
        <MetricCard label={t("warehouseIntelligence.kpis.lowOut")} value={formatNumber(k.lowCount + k.outCount)} note={t("warehouseIntelligence.kpis.lowOutNote", { low: k.lowCount, out: k.outCount })} icon={PackageMinus} tone="amber" />
        <MetricCard label={t("warehouseIntelligence.kpis.negative")} value={formatNumber(k.negativeCount)} note={t("warehouseIntelligence.kpis.negativeNote")} icon={PackageX} tone="rose" />
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <DecisionTable
          id="warehouse-value"
          title={t("warehouseIntelligence.inventory.valueByWarehouse")}
          empty={t("warehouseIntelligence.inventory.noWarehouseValue")}
          headers={[t("warehouseIntelligence.table.warehouse"), t("warehouseIntelligence.table.qty"), t("warehouseIntelligence.table.value")]}
          rows={data.valueByWarehouse.slice(0, 8).map((row) => [row.name || row.code, formatQty(row.qty), formatCurrency(row.value)])}
        />
        <DecisionTable
          id="top-stock-value"
          title={t("warehouseIntelligence.inventory.topItems")}
          empty={t("warehouseIntelligence.inventory.noTopItems")}
          headers={[t("warehouseIntelligence.table.item"), t("warehouseIntelligence.table.qty"), t("warehouseIntelligence.table.value")]}
          rows={data.topItemsByValue.slice(0, 8).map((row) => [row.name, formatQty(row.qty), formatCurrency(row.value)])}
        />
        <DecisionTable
          id="movement-trend"
          title={t("warehouseIntelligence.inventory.movementTrend")}
          empty={t("warehouseIntelligence.inventory.noMovementTrend")}
          headers={[t("warehouseIntelligence.table.period"), t("warehouseIntelligence.table.inQty"), t("warehouseIntelligence.table.outQty")]}
          rows={data.movementTrend.slice(-8).map((row) => [formatDate(row.bucket), formatQty(row.in), formatQty(row.out)])}
        />
        <section className="surface p-4" aria-labelledby="data-quality-title">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-teal-700" />
            <h2 id="data-quality-title" className="text-sm font-extrabold text-slate-900">{t("warehouseIntelligence.inventory.dataQuality")}</h2>
          </div>
          <dl className="mt-4 grid gap-3 sm:grid-cols-2">
            <QualityValue label={t("warehouseIntelligence.inventory.estimatedCostItems")} value={data.dataQualityIndicators.estimatedCostItems} />
            <QualityValue label={t("warehouseIntelligence.inventory.missingMinStock")} value={data.dataQualityIndicators.missingMinStock} />
            <QualityValue label={t("warehouseIntelligence.inventory.stagnantItems")} value={data.slowNoMovement.count} />
            <QualityValue label={t("warehouseIntelligence.inventory.inTransit")} value={data.transfers.inTransit} />
          </dl>
        </section>
      </section>

      {overview.isError ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs font-bold text-amber-800">
          {t("warehouseIntelligence.overviewSupplementUnavailable")}
          <Button size="sm" variant="ghost" className="ms-2" onClick={() => overview.refetch()}>{t("warehouseIntelligence.actions.retry")}</Button>
        </div>
      ) : <><CostCoveragePanel data={overview.data} /><FlowAndWastePanel data={overview.data} /><CostControlPanel data={overview.data} /></>}
      <ReportCatalog mode="inventory" range={range} scope={scope} />
    </div>
  );
}

function QualityValue({ label, value }: { label: string; value: number }) {
  return <div className="rounded-xl bg-slate-50 p-3"><dt className="text-xs font-bold text-slate-500">{label}</dt><dd className="mt-1 text-lg font-extrabold tabular-nums text-slate-900">{formatNumber(value)}</dd></div>;
}

function DecisionTable({ id, title, headers, rows, empty }: { id: string; title: string; headers: string[]; rows: string[][]; empty: string }) {
  return (
    <section className="surface overflow-hidden" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="border-b border-slate-100 px-4 py-3 text-sm font-extrabold text-slate-900">{title}</h2>
      {rows.length === 0 ? <p className="p-6 text-center text-sm font-semibold text-slate-400">{empty}</p> : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-slate-50"><tr>{headers.map((header) => <th key={header} className="whitespace-nowrap px-4 py-3 text-start text-xs font-extrabold text-slate-500">{header}</th>)}</tr></thead>
            <tbody className="divide-y divide-slate-100">{rows.map((row, index) => <tr key={`${id}:${index}`} className="hover:bg-slate-50/70">{row.map((cell, cellIndex) => <td key={cellIndex} className={cn("whitespace-nowrap px-4 py-3 font-semibold text-slate-700", cellIndex > 0 && "tabular-nums")}>{cell || "—"}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function PurchaseLedger({ rows }: { rows: PurchaseIntelligenceRow[] }) {
  const t = useT();
  if (!rows.length) return <EmptyState title={t("warehouseIntelligence.purchases.emptyTitle")} body={t("warehouseIntelligence.purchases.emptyBody")} />;
  return (
    <div className="surface overflow-hidden"><div className="overflow-x-auto">
      <table className="w-full min-w-[1040px] border-collapse text-sm">
        <thead className="bg-slate-50"><tr>
          {["date", "document", "supplier", "item", "warehouse", "qty", "unitCost", "net", "vat", "gross", "status"].map((key) => <th key={key} className="whitespace-nowrap px-3 py-3 text-start text-xs font-extrabold text-slate-500">{t(`warehouseIntelligence.table.${key}`)}</th>)}
        </tr></thead>
        <tbody className="divide-y divide-slate-100">{rows.map((row) => <tr key={row.id} className="hover:bg-slate-50/70">
          <td className="whitespace-nowrap px-3 py-3 font-semibold text-slate-600">{formatDate(row.date)}</td>
          <td className="whitespace-nowrap px-3 py-3 font-extrabold text-slate-800">{row.documentNumber || row.receiptNumber || "—"}</td>
          <td className="px-3 py-3 font-semibold text-slate-700">{row.supplierName || "—"}</td>
          <td className="px-3 py-3"><span className="font-bold text-slate-800">{row.itemName || "—"}</span>{row.sku && <span className="mt-0.5 block text-[11px] font-semibold text-slate-400" dir="ltr">{row.sku}</span>}</td>
          <td className="px-3 py-3 font-semibold text-slate-600">{row.warehouseName || "—"}</td>
          <td className="whitespace-nowrap px-3 py-3 font-bold tabular-nums text-slate-800">{formatQty(row.qty)} {row.unit}</td>
          <td className="whitespace-nowrap px-3 py-3 font-bold tabular-nums text-slate-700">{formatCurrency(row.unitCost)}</td>
          <td className="whitespace-nowrap px-3 py-3 font-bold tabular-nums text-slate-700">{formatCurrency(row.netAmount)}</td>
          <td className="whitespace-nowrap px-3 py-3 font-bold tabular-nums text-slate-700">{nullableCurrency(row.vatAmount)}</td>
          <td className="whitespace-nowrap px-3 py-3 font-extrabold tabular-nums text-slate-900">{nullableCurrency(row.grossAmount)}</td>
          <td className="whitespace-nowrap px-3 py-3"><StatusBadge>{row.status || "—"}</StatusBadge></td>
        </tr>)}</tbody>
      </table>
    </div></div>
  );
}

const SPECIALIZED_REPORT_IDS = new Set([
  "open-orders", "receiving-variance", "three-way-match", "price-variance",
  "purchase-analysis", "tax", "ap-aging", "supplier-statement", "data-quality",
]);

const SPECIALIZED_REPORT_OPTIONS = [
  "open-orders", "receiving-variance", "three-way-match", "price-variance",
  "purchase-analysis", "tax", "ap-aging", "data-quality",
] as const;

function specializedRows(raw: unknown): Record<string, unknown>[] {
  const envelope = (raw ?? {}) as Record<string, unknown>;
  const data = envelope.data;
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (data && typeof data === "object") {
    return Object.entries(data as Record<string, unknown>).map(([metric, value]) => ({ metric, value }));
  }
  return [];
}

function formatSpecializedValue(key: string, value: unknown): string {
  if (value == null || value === "") return "—";
  if (/(amount|value|spend|total|net|vat|variance)/i.test(key) && Number.isFinite(Number(value))) return formatCurrency(Number(value));
  if (/(qty|ordered|received|count|invoices|d30|d60|d90|current)/i.test(key) && Number.isFinite(Number(value))) return formatNumber(Number(value));
  if (/(date|period)/i.test(key)) return formatDate(String(value));
  return String(value);
}

function SpecializedProcurementReport({ report, range, scope, supplierId }: { report: string; range: DateRange; scope: string; supplierId?: string }) {
  const t = useT();
  const { procurementP2P } = useServerFlags();
  const needsSupplier = report === "supplier-statement";
  const query = useProcurementReport(report, {
    dateFrom: range.from,
    dateTo: range.to,
    asOfDate: range.to,
    warehouseId: scope === ALL_WAREHOUSES ? undefined : scope,
    supplierId,
  }, SPECIALIZED_REPORT_IDS.has(report) && procurementP2P && (!needsSupplier || !!supplierId));
  if (!SPECIALIZED_REPORT_IDS.has(report)) return null;
  // The specialized reports live behind the P2P router, while the warehouse
  // intelligence endpoints above remain available independently.  Read the
  // server's existing runtime capability contract before calling that router:
  // a dormant module is an intentional environment state, not a failed report.
  if (!procurementP2P) {
    return (
      <EmptyState
        title={t("warehouseIntelligence.specialized.unavailableTitle")}
        body={t("warehouseIntelligence.specialized.unavailableBody")}
      />
    );
  }
  if (needsSupplier && !supplierId) {
    return (
      <EmptyState
        title={t("warehouseIntelligence.specialized.selectSupplierTitle")}
        body={t("warehouseIntelligence.specialized.selectSupplierBody")}
      />
    );
  }
  if (query.isLoading) return <LoadingState />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  const rows = specializedRows(query.data);
  if (!rows.length) return <EmptyState title={t("warehouseIntelligence.specialized.emptyTitle")} body={t("warehouseIntelligence.specialized.emptyBody")} />;
  const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  return (
    <div className="surface overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse text-sm">
          <thead className="bg-slate-50"><tr>{columns.map((column) => {
            const key = `warehouseIntelligence.procurementColumns.${column}`;
            const translated = t(key);
            return <th key={column} className="whitespace-nowrap px-3 py-3 text-start text-xs font-extrabold text-slate-500">{translated === key ? column.replaceAll("_", " ") : translated}</th>;
          })}</tr></thead>
          <tbody className="divide-y divide-slate-100">{rows.map((row, index) => <tr key={index} className="hover:bg-slate-50/70">{columns.map((column) => <td key={column} className="whitespace-nowrap px-3 py-3 font-semibold text-slate-700">{
            /(^|_)status$/i.test(column) && row[column] != null
              ? <StatusBadge>{String(row[column])}</StatusBadge>
              : formatSpecializedValue(column, row[column])
          }</td>)}</tr>)}</tbody>
        </table>
      </div>
    </div>
  );
}

function PurchasingDecisionView({ range, scope }: { range: DateRange; scope: string }) {
  const t = useT();
  const lang = useLang();
  const [searchParams, setSearchParams] = useSearchParams();
  const [draftQ, setDraftQ] = useState("");
  const [q, setQ] = useState("");
  const [supplier, setSupplier] = useState<SupplierHit | null>(null);
  const [item, setItem] = useState<ItemHit | null>(null);
  const requestedReport = SPECIALIZED_REPORT_IDS.has(searchParams.get("report") ?? "") ? String(searchParams.get("report")) : "open-orders";
  const selectedReport = requestedReport;
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const itemFetcher = useMemo(() => makeItemFetcher({
    warehouseId: scope === ALL_WAREHOUSES ? undefined : scope,
    context: "report",
    activeOnly: false,
  }), [scope]);
  const base = {
    from: range.from,
    to: range.to,
    warehouseId: scope === ALL_WAREHOUSES ? undefined : scope,
    supplierId: supplier?.id,
    itemId: item?.id,
  };
  const overview = useWarehouseIntelligenceOverview(base);
  const purchases = usePurchaseIntelligence({ ...base, q, page, pageSize: 50 });
  if (overview.isLoading) return <LoadingState rows={6} />;
  if (overview.isError || !overview.data) return <ErrorState error={overview.error} onRetry={() => overview.refetch()} />;
  const k = overview.data.kpis;
  return (
    <div className="space-y-5" data-testid="purchasing-decision-view">
      <WarningStrip warnings={[...overview.data.warnings, ...(purchases.data?.warnings ?? [])]} />
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label={t("warehouseIntelligence.kpis.purchasingAria")}>
        <MetricCard label={t("warehouseIntelligence.kpis.purchaseSpend")} value={formatCurrency(k.purchaseSpend)} note={t("warehouseIntelligence.kpis.periodNote")} icon={CircleDollarSign} />
        <MetricCard label={t("warehouseIntelligence.kpis.receivedQty")} value={formatQty(k.receivedQty)} note={t("warehouseIntelligence.kpis.receivedNote")} icon={PackageCheck} tone="blue" />
        <MetricCard label={t("warehouseIntelligence.kpis.openPoValue")} value={formatCurrency(k.openPoValue)} note={t("warehouseIntelligence.kpis.openPoQty", { qty: formatQty(k.openPoQty) })} icon={ClipboardList} tone="amber" />
        <MetricCard label={t("warehouseIntelligence.kpis.suppliers")} value={formatNumber(k.supplierCount)} note={t("warehouseIntelligence.kpis.suppliersNote")} icon={Users} tone="violet" />
      </section>
      <section className="grid gap-4 xl:grid-cols-2">
        <DecisionTable id="supplier-analysis" title={t("warehouseIntelligence.purchases.bySupplier")} empty={t("warehouseIntelligence.purchases.noSuppliers")} headers={[t("warehouseIntelligence.table.supplier"), t("warehouseIntelligence.table.documents"), t("warehouseIntelligence.table.qty"), t("warehouseIntelligence.table.spend")]} rows={overview.data.purchaseBySupplier.slice(0, 10).map((row) => [row.supplierName, formatNumber(row.documentCount), formatQty(row.receivedQty), formatCurrency(row.spend)])} />
        <DecisionTable id="purchase-trend" title={t("warehouseIntelligence.purchases.trend")} empty={t("warehouseIntelligence.purchases.noTrend")} headers={[t("warehouseIntelligence.table.period"), t("warehouseIntelligence.table.qty"), t("warehouseIntelligence.table.spend")]} rows={overview.data.purchaseTrend.slice(-10).map((row) => [formatDate(row.period), formatQty(row.receivedQty), formatCurrency(row.spend)])} />
      </section>
      <CostCoveragePanel data={overview.data} />
      <CostControlPanel data={overview.data} />
      <ReportCatalog mode="purchasing" range={range} scope={scope} />
      <section id="specialized-report" className="scroll-mt-24" aria-labelledby="specialized-report-title">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 id="specialized-report-title" className="text-lg font-extrabold text-slate-900">{t("warehouseIntelligence.specialized.title")}</h2>
            <p className="mt-1 text-xs font-semibold text-slate-500">{t("warehouseIntelligence.specialized.subtitle")}</p>
          </div>
          <label className="w-full sm:w-72">
            <span className="sr-only">{t("warehouseIntelligence.specialized.select")}</span>
            <select className="field w-full" value={selectedReport} onChange={(event) => {
              const next = new URLSearchParams(searchParams);
              next.set("report", event.target.value);
              setSearchParams(next, { replace: true });
            }}>
              {[
                ...SPECIALIZED_REPORT_OPTIONS,
                ...(supplier || selectedReport === "supplier-statement" ? ["supplier-statement" as const] : []),
              ].map((id) => (
                <option key={id} value={id} disabled={id === "supplier-statement" && !supplier}>{t(`warehouseIntelligence.specialized.options.${id}`)}</option>
              ))}
            </select>
          </label>
        </div>
        <SpecializedProcurementReport report={selectedReport} range={range} scope={scope} supplierId={supplier?.id} />
      </section>
      <section id="purchase-ledger" aria-labelledby="purchase-ledger-title" className="scroll-mt-24">
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <div className="me-auto">
            <h2 id="purchase-ledger-title" className="text-lg font-extrabold text-slate-900">{t("warehouseIntelligence.purchases.ledgerTitle")}</h2>
            <p className="mt-1 text-xs font-semibold text-slate-500">{t("warehouseIntelligence.purchases.ledgerSubtitle")}</p>
          </div>
          <Button
            type="button"
            variant="secondary"
            disabled={exporting}
            onClick={() => {
              setExporting(true);
              setExportError("");
              void downloadCsv(
                "/inventory/intelligence/purchases/export",
                `purchase-ledger-${range.from}-${range.to}.csv`,
                { ...base, q, lang },
              ).catch((error: unknown) => {
                setExportError(error instanceof Error ? error.message : t("warehouseIntelligence.actions.exportFailed"));
              }).finally(() => setExporting(false));
            }}
          >
            <Download className="h-4 w-4" />
            {t(exporting ? "warehouseIntelligence.actions.exporting" : "warehouseIntelligence.actions.export")}
          </Button>
          <form className="flex w-full gap-2 sm:w-auto" onSubmit={(event) => { event.preventDefault(); setPage(1); setQ(draftQ.trim()); }}>
            <label className="relative min-w-0 flex-1 sm:w-72">
              <span className="sr-only">{t("warehouseIntelligence.filters.search")}</span>
              <Search className="pointer-events-none absolute start-3 top-3.5 h-4 w-4 text-slate-400" />
              <input className="field w-full ps-9" value={draftQ} onChange={(event) => setDraftQ(event.target.value)} placeholder={t("warehouseIntelligence.filters.searchPlaceholder")} />
            </label>
            <Button type="submit">{t("warehouseIntelligence.actions.apply")}</Button>
          </form>
        </div>
        <div className="mb-3 grid gap-3 rounded-2xl border border-slate-200 bg-slate-50/70 p-3 md:grid-cols-2">
          <label>
            <span className="mb-1 block text-xs font-extrabold text-slate-500">{t("warehouseIntelligence.filters.supplier")}</span>
            <SearchableEntityCombobox<SupplierHit>
              value={supplier}
              onChange={(value) => { setSupplier(value); setPage(1); }}
              fetcher={supplierFetcher}
              queryKey={["warehouse-intelligence", "supplier-filter"]}
              getKey={(value) => value.id}
              getLabel={(value) => value.name}
              getSublabel={(value) => value.vatNumber || value.nameEn || undefined}
              placeholder={t("warehouseIntelligence.filters.supplierPlaceholder")}
              ariaLabel={t("warehouseIntelligence.filters.supplier")}
            />
          </label>
          <label>
            <span className="mb-1 block text-xs font-extrabold text-slate-500">{t("warehouseIntelligence.filters.item")}</span>
            <SearchableEntityCombobox<ItemHit>
              value={item}
              onChange={(value) => { setItem(value); setPage(1); }}
              fetcher={itemFetcher}
              queryKey={["warehouse-intelligence", "item-filter", scope]}
              getKey={(value) => value.id}
              getLabel={(value) => value.name}
              getSublabel={(value) => value.sku || value.nameEn || undefined}
              placeholder={t("warehouseIntelligence.filters.itemPlaceholder")}
              ariaLabel={t("warehouseIntelligence.filters.item")}
            />
          </label>
        </div>
        {exportError && <div role="alert" className="mb-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-800">{exportError}</div>}
        {purchases.isLoading ? <LoadingState /> : purchases.isError || !purchases.data ? <ErrorState error={purchases.error} onRetry={() => purchases.refetch()} /> : <>
          <div className="mb-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <MiniTotal label={t("warehouseIntelligence.table.qty")} value={formatQty(purchases.data.totals.qty)} />
            <MiniTotal label={t("warehouseIntelligence.table.net")} value={formatCurrency(purchases.data.totals.netAmount)} />
            <MiniTotal label={t("warehouseIntelligence.table.vat")} value={nullableCurrency(purchases.data.totals.vatAmount)} />
            <MiniTotal label={t("warehouseIntelligence.table.gross")} value={nullableCurrency(purchases.data.totals.grossAmount)} />
          </div>
          {purchases.data.totals.missingVatLines > 0 && <p className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-800">
            {t("warehouseIntelligence.purchases.vatIncomplete", {
              count: purchases.data.totals.missingVatLines,
              known: formatCurrency(purchases.data.totals.knownVatAmount),
            })}
          </p>}
          <PurchaseLedger rows={purchases.data.rows} />
          {purchases.data.pagination.totalPages > 1 && <div className="mt-3 flex items-center justify-between gap-2">
            <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>{t("warehouseIntelligence.actions.previous")}</Button>
            <span className="text-xs font-extrabold text-slate-500">{t("warehouseIntelligence.purchases.page", { page, total: purchases.data.pagination.totalPages })}</span>
            <Button variant="secondary" disabled={page >= purchases.data.pagination.totalPages} onClick={() => setPage((value) => value + 1)}>{t("warehouseIntelligence.actions.next")}</Button>
          </div>}
        </>}
      </section>
    </div>
  );
}

function MiniTotal({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2"><div className="text-[11px] font-bold text-slate-500">{label}</div><div className="mt-0.5 text-sm font-extrabold tabular-nums text-slate-900">{value}</div></div>;
}

export function WarehouseIntelligenceHub({ mode }: { mode: WarehouseIntelligenceMode }) {
  const t = useT();
  const queryClient = useQueryClient();
  const { scope } = useWarehouseScope();
  const [range, setRange] = useState<DateRange>(initialRange);
  const titleKey = mode === "inventory" ? "warehouseIntelligence.inventory.title" : "warehouseIntelligence.purchases.title";
  const subtitleKey = mode === "inventory" ? "warehouseIntelligence.inventory.subtitle" : "warehouseIntelligence.purchases.subtitle";
  return (
    <div data-testid="warehouse-intelligence-hub" data-mode={mode}>
      <PageHeader
        eyebrow={t("warehouseIntelligence.eyebrow")}
        title={t(titleKey)}
        subtitle={t(subtitleKey)}
        action={<Button variant="secondary" onClick={() => {
          void queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === "warehouse-intelligence" || query.queryKey[0] === "analytics" });
        }}><RefreshCw className="h-4 w-4" />{t("warehouseIntelligence.actions.refresh")}</Button>}
      />
      <IntelligenceNavigation mode={mode} />
      <section className="no-print surface mb-5 grid gap-3 p-3 sm:grid-cols-2 xl:grid-cols-[minmax(20rem,1fr)_minmax(14rem,auto)]" aria-label={t("warehouseIntelligence.filters.aria")}>
        <DateRangePicker value={range} onChange={setRange} labels={{ presets: presetLabels(t), from: t("warehouseIntelligence.filters.from"), to: t("warehouseIntelligence.filters.to"), presetAriaLabel: t("warehouseIntelligence.filters.period") }} />
        <WarehouseScopeSelect fullWidth />
      </section>
      {mode === "inventory" ? <InventoryDecisionView range={range} scope={scope} /> : <PurchasingDecisionView range={range} scope={scope} />}
    </div>
  );
}

export function InventoryIntelligencePage() {
  return <WarehouseModuleProviders><WarehouseIntelligenceHub mode="inventory" /></WarehouseModuleProviders>;
}

export function PurchasingIntelligencePage() {
  return <WarehouseModuleProviders><WarehouseIntelligenceHub mode="purchasing" /></WarehouseModuleProviders>;
}

export default WarehouseIntelligenceHub;
