import { useMemo, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
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
import { useCan } from "@/app/providers";
import { WarehouseModuleProviders } from "@/modules/inventory/lib/providers";
import { WarehouseScopeSelect } from "@/modules/inventory/lib/WarehouseScopeSelect";
import { ALL_WAREHOUSES, useWarehouseScope } from "@/modules/inventory/lib/warehouse-scope-provider";
import { useAnalytics } from "@/modules/inventory/lib/hooks/useAnalytics";
import { makeItemFetcher, supplierFetcher, type ItemHit, type SupplierHit } from "@/modules/inventory/lib/hooks/useEntitySearch";
import { useProcurementReport } from "@/modules/inventory/lib/hooks/useProcurement";
import {
  useGrniReconciliation,
  useInventoryAccountingReconciliation,
  usePurchaseIntelligence,
  useWarehouseIntelligenceOverview,
} from "./api";
import {
  INVENTORY_INTELLIGENCE_REPORTS,
  PURCHASING_INTELLIGENCE_REPORTS,
  REPORT_FAMILIES,
  REPORT_READINESS_REQUIREMENTS,
  type IntelligenceReportLink,
  type ReportFamily,
} from "./reportCatalog";
import type { IntelligenceWarning, PurchaseIntelligenceRow } from "./contracts";
import { ReportDirectory, type ReportDirectoryGroup, type ReportDirectoryTone } from "../components/ReportDirectory";
import { PurchasingReportsDirectory } from "../purchasing/PurchasingReportsDirectory";

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
  const reports = mode === "inventory" ? INVENTORY_INTELLIGENCE_REPORTS : PURCHASING_INTELLIGENCE_REPORTS;
  const familyTones: Partial<Record<ReportFamily, ReportDirectoryTone>> = {
    stock: "teal",
    valuation: "amber",
    movement: "blue",
    procurement: "violet",
    productionCost: "lime",
    reconciliation: "rose",
  };
  const groups: ReportDirectoryGroup[] = REPORT_FAMILIES
    .map((family) => ({
      id: family.id,
      title: t(family.labelKey),
      icon: family.icon,
      items: reports.filter((report) => report.family === family.id).map((report) => ({
        id: report.id,
        title: t(report.labelKey),
        to: withScope(report, range, scope),
        icon: report.icon,
        tone: familyTones[family.id],
      })),
    }))
    .filter((family) => family.items.length > 0);

  const firstGroup = groups[0];
  if (firstGroup) {
    firstGroup.items.unshift({
      id: `${mode}-control-center`,
      title: t(mode === "inventory" ? "warehouseIntelligence.inventory.title" : "warehouseIntelligence.purchases.title"),
      to: `/reports/${mode}?workspace=1`,
      icon: mode === "inventory" ? Boxes : ShoppingCart,
      tone: "teal",
    });
  }

  return (
    <section id="report-catalog" className="scroll-mt-24" aria-labelledby="warehouse-report-catalog">
      <h2 id="warehouse-report-catalog" className="sr-only">{t("warehouseIntelligence.catalog.title")}</h2>

      <ReportDirectory
        groups={groups}
        openLabel={t("misc.reports.directory.open")}
        emptyLabel={t("misc.reports.directory.empty")}
      />

    </section>
  );
}

function ReportReadiness({ mode }: { mode: WarehouseIntelligenceMode }) {
  const t = useT();
  const requirements = REPORT_READINESS_REQUIREMENTS.filter((item) => item.modes.includes(mode));
  const groups = REPORT_FAMILIES
    .map((family) => ({ family, requirements: requirements.filter((item) => item.family === family.id) }))
    .filter((group) => group.requirements.length > 0);
  return (
    <section className="surface overflow-hidden" aria-labelledby="report-readiness-title" data-testid="report-readiness">
      <div className="border-b border-slate-100 bg-slate-50/70 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 id="report-readiness-title" className="text-sm font-extrabold text-slate-900">{t("warehouseIntelligence.readiness.title")}</h2>
            <p className="mt-1 text-xs font-semibold leading-5 text-slate-500">{t("warehouseIntelligence.readiness.subtitle")}</p>
          </div>
          <Badge tone="warning">{t("warehouseIntelligence.readiness.notPublished")}</Badge>
        </div>
      </div>
      <div className="space-y-px bg-slate-100">
        {groups.map(({ family, requirements: familyRequirements }) => {
          const Icon = family.icon;
          return <section key={family.id} className="bg-white" aria-labelledby={`readiness-${mode}-${family.id}`}>
            <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3"><Icon className="h-4 w-4 text-teal-700" /><h3 id={`readiness-${mode}-${family.id}`} className="text-xs font-extrabold text-slate-700">{t(family.labelKey)}</h3><Badge tone="neutral">{familyRequirements.length}</Badge></div>
            <div className="grid gap-px bg-slate-100 lg:grid-cols-2">
              {familyRequirements.map((requirement) => (
                <div key={requirement.id} className="bg-white p-4" data-readiness-requirement={requirement.id}>
                  <div className="flex items-start justify-between gap-2">
                    <h4 className="text-sm font-extrabold text-slate-900">{t(`warehouseIntelligence.readiness.items.${requirement.id}.label`)}</h4>
                    <Badge tone="neutral">{t("warehouseIntelligence.readiness.requiresLedger")}</Badge>
                  </div>
                  <p className="mt-1.5 text-xs font-medium leading-5 text-slate-500">{t(`warehouseIntelligence.readiness.items.${requirement.id}.reason`)}</p>
                  <p className="mt-2 text-[11px] font-bold leading-5 text-amber-700">{t(`warehouseIntelligence.readiness.items.${requirement.id}.requirement`)}</p>
                </div>
              ))}
            </div>
          </section>;
        })}
      </div>
    </section>
  );
}

function blockerLabel(t: ReturnType<typeof useT>, code: string): string {
  const key = `warehouseIntelligence.accounting.blockers.${code}`;
  const translated = t(key);
  return translated === key ? code.replaceAll("_", " ") : translated;
}

const CRITICAL_ACCOUNTING_BLOCKERS = new Set([
  "SUBLEDGER_GL_DIFFERENCE", "WAREHOUSE_DIMENSION_DIFFERENCE", "UNALLOCATED_GL_BALANCE",
  "ORPHAN_STOCK_ITEM", "NEGATIVE_COST", "PERIODIC_INVENTORY_SYSTEM", "INVENTORY_SYSTEM_UNSUPPORTED",
  "GRNI_GL_DIFFERENCE", "GRNI_OVER_CLEARED",
]);

function InventoryAccountingClose({ scope, range, canViewFinance }: { scope: string; range: DateRange; canViewFinance: boolean }) {
  const t = useT();
  const query = useInventoryAccountingReconciliation(scope === ALL_WAREHOUSES ? undefined : scope, canViewFinance);
  const stockBalance = INVENTORY_INTELLIGENCE_REPORTS.find((item) => item.id === "stock-balance")!;
  if (!canViewFinance) return <FinanceOnlySection title={t("warehouseIntelligence.accounting.inventoryTitle")} />;
  if (query.isLoading) return <section className="surface p-4"><LoadingState rows={4} /></section>;
  if (query.isError || !query.data) return (
    <section className="surface p-4" data-testid="inventory-accounting-unavailable">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-sm font-extrabold text-slate-900">{t("warehouseIntelligence.accounting.inventoryTitle")}</h2><p className="mt-1 max-w-3xl text-xs font-semibold leading-5 text-amber-700">{t("warehouseIntelligence.accounting.supplementUnavailable")}</p></div><Button size="sm" variant="secondary" onClick={() => query.refetch()}>{t("warehouseIntelligence.actions.retry")}</Button></div>
    </section>
  );
  const data = query.data;
  const summary = data.summary;
  const inventorySystem = data.measurement.inventorySystem === "periodic" ? "periodic" : data.measurement.inventorySystem === "perpetual" ? "perpetual" : "unknown";
  const readiness = [
    ["carryingAmount", data.ias2Readiness.carryingAmountReady ? "ready" : "blocked"],
    ["byInventoryClass", data.ias2Readiness.byInventoryClass.state],
    ["nrvAndWriteDowns", data.ias2Readiness.nrvAndWriteDowns.state],
    ["writeDownReversals", data.ias2Readiness.writeDownReversals.state],
    ["pledgedInventory", data.ias2Readiness.pledgedInventory.state],
  ] as const;
  return (
    <section className="surface overflow-hidden" data-testid="inventory-accounting-reconciliation" aria-labelledby="inventory-accounting-title">
      <div className="border-b border-slate-100 bg-slate-50/70 px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div><h2 id="inventory-accounting-title" className="text-sm font-extrabold text-slate-900">{t("warehouseIntelligence.accounting.inventoryTitle")}</h2><p className="mt-1 text-xs font-semibold leading-5 text-slate-500">{t("warehouseIntelligence.accounting.inventorySubtitle")}</p></div>
          <div className="flex flex-wrap gap-2"><Badge tone={summary.state === "reconciled" ? "success" : "danger"}>{t(`warehouseIntelligence.accounting.state.${summary.state === "reconciled" ? "reconciled" : "notReconciled"}`)}</Badge><Badge tone="neutral">{t("warehouseIntelligence.accounting.currentOnly")}</Badge></div>
        </div>
      </div>
      <div className="space-y-4 p-4">
        <WarningStrip warnings={data.warnings} />
        {summary.blockers.length > 0 && <div className="flex flex-wrap gap-2" aria-label={t("warehouseIntelligence.accounting.blockersTitle")}>{summary.blockers.map((code) => <Badge key={code} tone={CRITICAL_ACCOUNTING_BLOCKERS.has(code) ? "danger" : "warning"}>{blockerLabel(t, code)}</Badge>)}</div>}
        <dl className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <MiniTotal label={t("warehouseIntelligence.accounting.subledgerValue")} value={formatCurrency(summary.subledgerValue)} />
          <MiniTotal label={t("warehouseIntelligence.accounting.glBalance")} value={formatCurrency(summary.glBalance)} />
          <MiniTotal label={t("warehouseIntelligence.accounting.difference")} value={formatCurrency(summary.difference)} />
          <MiniTotal label={t("warehouseIntelligence.accounting.controlAccount")} value={data.measurement.inventoryControlAccount.code || "—"} />
        </dl>
        <div className="rounded-xl border border-sky-200 bg-sky-50 p-3 text-xs font-semibold leading-5 text-sky-900">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <strong>{t("warehouseIntelligence.accounting.measurementTitle")}</strong>
            <Badge tone={inventorySystem === "periodic" ? "warning" : "info"}>{t(`warehouseIntelligence.accounting.inventorySystem.${inventorySystem}`)}</Badge>
          </div>
          {t("warehouseIntelligence.accounting.measurementBody", { system: t(`warehouseIntelligence.accounting.inventorySystem.${inventorySystem}`), account: data.measurement.inventoryControlAccount.code || "—" })}
        </div>
        <div className="overflow-x-auto rounded-xl border border-slate-200"><table className="w-full min-w-[820px] text-sm">
          <thead className="bg-slate-50"><tr>{["warehouse", "subledgerValue", "glBalance", "difference", "costCoverage", "drilldown"].map((key) => <th key={key} className="px-3 py-3 text-start text-xs font-extrabold text-slate-500">{t(`warehouseIntelligence.accounting.columns.${key}`)}</th>)}</tr></thead>
          <tbody className="divide-y divide-slate-100">{data.rows.map((row) => <tr key={row.warehouseId ?? "unallocated"} className="hover:bg-slate-50/70">
            <td className="px-3 py-3 font-extrabold text-slate-800">{row.warehouseName || t("warehouseIntelligence.accounting.unallocated")}</td>
            <td className="px-3 py-3 font-bold tabular-nums">{formatCurrency(row.subledgerValue)}</td><td className="px-3 py-3 font-bold tabular-nums">{formatCurrency(row.glBalance)}</td>
            <td className={cn("px-3 py-3 font-extrabold tabular-nums", Math.abs(row.difference) > summary.tolerance ? "text-rose-700" : "text-emerald-700")}>{formatCurrency(row.difference)}</td>
            <td className="px-3 py-3 text-xs font-bold text-slate-600">{t("warehouseIntelligence.accounting.costCoverageLine", { wac: row.wacPositions, fallback: row.fallbackPositions, missing: row.missingCostPositions, orphan: row.orphanStockPositions, negative: row.negativeCostPositions })}</td>
            <td className="px-3 py-3"><Link className="font-extrabold text-teal-700 hover:underline" to={withScope(stockBalance, range, row.warehouseId ?? scope)}>{t("warehouseIntelligence.accounting.openStock")}</Link></td>
          </tr>)}</tbody>
        </table></div>
        <div>
          <h3 className="text-xs font-extrabold text-slate-700">{t("warehouseIntelligence.accounting.ias2Title")}</h3>
          <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{readiness.map(([id, state]) => {
            const ready = state === "ready" || state === "available";
            return <div key={id} className="rounded-xl border border-slate-200 p-3"><div className="flex items-start justify-between gap-2"><span className="text-xs font-bold text-slate-700">{t(`warehouseIntelligence.accounting.ias2.${id}`)}</span><Badge tone={ready ? "success" : "warning"}>{t(ready ? "warehouseIntelligence.accounting.ready" : "warehouseIntelligence.accounting.dataRequired")}</Badge></div></div>;
          })}</div>
        </div>
      </div>
    </section>
  );
}

function GrniAccountingClose({ scope, canViewFinance }: { scope: string; canViewFinance: boolean }) {
  const t = useT();
  const query = useGrniReconciliation(scope === ALL_WAREHOUSES ? undefined : scope, canViewFinance);
  if (!canViewFinance) return <FinanceOnlySection title={t("warehouseIntelligence.accounting.grniTitle")} />;
  if (query.isLoading) return <section className="surface p-4"><LoadingState rows={4} /></section>;
  if (query.isError || !query.data) return (
    <section className="surface p-4" data-testid="grni-accounting-unavailable">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-sm font-extrabold text-slate-900">{t("warehouseIntelligence.accounting.grniTitle")}</h2><p className="mt-1 max-w-3xl text-xs font-semibold leading-5 text-amber-700">{t("warehouseIntelligence.accounting.supplementUnavailable")}</p></div><Button size="sm" variant="secondary" onClick={() => query.refetch()}>{t("warehouseIntelligence.actions.retry")}</Button></div>
    </section>
  );
  const data = query.data;
  const rec = data.reconciliation;
  const visibleRows = data.rows.slice(0, 100);
  return (
    <section className="surface overflow-hidden" data-testid="grni-reconciliation" aria-labelledby="grni-accounting-title">
      <div className="border-b border-slate-100 bg-slate-50/70 px-4 py-3"><div className="flex flex-wrap items-start justify-between gap-2"><div><h2 id="grni-accounting-title" className="text-sm font-extrabold text-slate-900">{t("warehouseIntelligence.accounting.grniTitle")}</h2><p className="mt-1 text-xs font-semibold leading-5 text-slate-500">{t("warehouseIntelligence.accounting.grniSubtitle")}</p></div><div className="flex gap-2"><Badge tone={rec.state === "reconciled" ? "success" : "danger"}>{t(`warehouseIntelligence.accounting.state.${rec.state === "reconciled" ? "reconciled" : "notReconciled"}`)}</Badge><Badge tone="neutral">{t("warehouseIntelligence.accounting.currentOnly")}</Badge></div></div></div>
      <div className="space-y-4 p-4">
        <WarningStrip warnings={data.warnings} />
        {rec.blockers.length > 0 && <div className="flex flex-wrap gap-2">{rec.blockers.map((code) => <Badge key={code} tone={CRITICAL_ACCOUNTING_BLOCKERS.has(code) ? "danger" : "warning"}>{blockerLabel(t, code)}</Badge>)}</div>}
        <dl className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4"><MiniTotal label={t("warehouseIntelligence.accounting.grniOperational")} value={formatCurrency(rec.operationalOutstanding)} /><MiniTotal label={t("warehouseIntelligence.accounting.glBalance")} value={nullableCurrency(rec.glBalance)} /><MiniTotal label={t("warehouseIntelligence.accounting.difference")} value={nullableCurrency(rec.difference)} /><MiniTotal label={t("warehouseIntelligence.accounting.controlAccount")} value={rec.grniAccount.code || "—"} /></dl>
        <div><h3 className="text-xs font-extrabold text-slate-700">{t("warehouseIntelligence.accounting.agingTitle")}</h3><dl className="mt-2 grid gap-2 grid-cols-2 sm:grid-cols-3 xl:grid-cols-6">{(["current", "d30", "d60", "d90", "d90plus", "negative"] as const).map((key) => <MiniTotal key={key} label={t(`warehouseIntelligence.accounting.aging.${key}`)} value={formatCurrency(data.aging[key])} />)}</dl></div>
        {data.rows.length === 0 ? <EmptyState title={t("warehouseIntelligence.accounting.grniEmptyTitle")} body={t("warehouseIntelligence.accounting.grniEmptyBody")} /> : <><div className="overflow-x-auto rounded-xl border border-slate-200"><table className="w-full min-w-[980px] text-sm"><thead className="bg-slate-50"><tr>{["receipt", "date", "supplier", "warehouse", "ageDays", "received", "invoiced", "returns", "outstanding"].map((key) => <th key={key} className="px-3 py-3 text-start text-xs font-extrabold text-slate-500">{t(`warehouseIntelligence.accounting.columns.${key}`)}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{visibleRows.map((row) => <tr key={row.receiptId} className="hover:bg-slate-50/70"><td className="px-3 py-3 font-extrabold text-slate-800">{row.receiptNumber}</td><td className="px-3 py-3 font-semibold">{formatDate(row.receiptDate)}</td><td className="px-3 py-3 font-semibold">{row.supplierName || "—"}</td><td className="px-3 py-3 font-semibold">{row.warehouseName || "—"}</td><td className="px-3 py-3 font-bold tabular-nums">{formatNumber(row.ageDays)}</td><td className="px-3 py-3 font-bold tabular-nums">{formatCurrency(row.receivedValue)}</td><td className="px-3 py-3 font-bold tabular-nums">{formatCurrency(row.invoicedValue)}</td><td className="px-3 py-3 font-bold tabular-nums">{formatCurrency(row.returnedBeforeInvoiceValue)}</td><td className="px-3 py-3 font-extrabold tabular-nums text-amber-700">{formatCurrency(row.outstandingValue)}</td></tr>)}</tbody></table></div><p className="text-xs font-bold text-slate-500">{t("warehouseIntelligence.accounting.grniDetailDisclosure", { visible: visibleRows.length, loaded: data.detail.shown || data.rows.length, total: data.detail.totalOpenReceipts || data.rows.length })}</p></>}
      </div>
    </section>
  );
}

function FinanceOnlySection({ title }: { title: string }) {
  const t = useT();
  return <section className="surface p-4" data-testid="finance-only-reconciliation"><div className="flex items-start gap-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-slate-100 text-slate-500"><ShieldCheck className="h-5 w-5" /></span><div><h2 className="text-sm font-extrabold text-slate-900">{title}</h2><p className="mt-1 text-xs font-semibold leading-5 text-slate-500">{t("warehouseIntelligence.accounting.financeOnly")}</p></div></div></section>;
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
        ] as const).map(([to, label]) => <Link key={to} to={to} className="inline-flex min-h-11 items-center rounded-xl border border-slate-200 bg-white px-3 text-xs font-extrabold text-slate-600 transition hover:border-teal-300 hover:text-teal-700">{t(label)}</Link>)}
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

interface InventoryException {
  id: string;
  value: number;
  tone: "rose" | "amber" | "blue" | "neutral";
  to: string;
}

function InventoryExceptionQueue({ exceptions }: { exceptions: InventoryException[] }) {
  const t = useT();
  const lang = useLang();
  const GoArrow = lang === "ar" ? ArrowLeft : ArrowRight;
  const open = exceptions.filter((item) => item.value > 0);
  return (
    <section id="inventory-exceptions" className="surface overflow-hidden scroll-mt-24" aria-labelledby="inventory-exceptions-title">
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 bg-slate-50/70 px-4 py-3">
        <div>
          <h2 id="inventory-exceptions-title" className="text-sm font-extrabold text-slate-900">{t("warehouseIntelligence.exceptions.title")}</h2>
          <p className="mt-1 text-xs font-semibold leading-5 text-slate-500">{t("warehouseIntelligence.exceptions.subtitle")}</p>
        </div>
        <Badge tone={open.length ? "warning" : "success"}>{t(open.length ? "warehouseIntelligence.exceptions.open" : "warehouseIntelligence.exceptions.clear", { count: open.length })}</Badge>
      </div>
      {open.length === 0 ? (
        <div className="flex items-center gap-2 p-4 text-sm font-bold text-emerald-700"><ShieldCheck className="h-5 w-5" />{t("warehouseIntelligence.exceptions.clearBody")}</div>
      ) : (
        <div className="grid gap-px bg-slate-100 sm:grid-cols-2 xl:grid-cols-3">
          {open.map((item) => <Link key={item.id} to={item.to} className="group flex min-h-24 items-center justify-between gap-3 bg-white p-4 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-teal-100">
            <span>
              <span className="block text-xs font-bold text-slate-500">{t(`warehouseIntelligence.exceptions.items.${item.id}`)}</span>
              <span className={cn("mt-1 block text-xl font-extrabold tabular-nums", item.tone === "rose" ? "text-rose-700" : item.tone === "amber" ? "text-amber-700" : item.tone === "blue" ? "text-blue-700" : "text-slate-800")}>{formatNumber(item.value)}</span>
            </span>
            <GoArrow className="h-5 w-5 shrink-0 text-slate-300 transition group-hover:text-teal-600" />
          </Link>)}
        </div>
      )}
    </section>
  );
}

function InventoryDecisionView({ range, scope }: { range: DateRange; scope: string }) {
  const t = useT();
  const canViewFinance = useCan("finance.reports.view");
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
  const costMissing = overview.data?.costCoverage.uncostedStockCount ?? 0;
  const exceptions: InventoryException[] = [
    { id: "negative", value: k.negativeCount, tone: "rose", to: withScope(INVENTORY_INTELLIGENCE_REPORTS.find((item) => item.id === "low-stock")!, range, scope) },
    { id: "lowOut", value: k.lowCount + k.outCount, tone: "amber", to: withScope(INVENTORY_INTELLIGENCE_REPORTS.find((item) => item.id === "low-stock")!, range, scope) },
    { id: "missingCost", value: costMissing, tone: "rose", to: withScope(INVENTORY_INTELLIGENCE_REPORTS.find((item) => item.id === "data-quality")!, range, scope) },
    { id: "missingReorder", value: data.dataQualityIndicators.missingMinStock, tone: "amber", to: withScope(INVENTORY_INTELLIGENCE_REPORTS.find((item) => item.id === "data-quality")!, range, scope) },
    { id: "stagnant", value: data.slowNoMovement.count, tone: "blue", to: withScope(INVENTORY_INTELLIGENCE_REPORTS.find((item) => item.id === "no-movement")!, range, scope) },
    { id: "inTransit", value: data.transfers.inTransit, tone: "neutral", to: withScope(INVENTORY_INTELLIGENCE_REPORTS.find((item) => item.id === "transfers")!, range, scope) },
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

      <InventoryExceptionQueue exceptions={exceptions} />

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
      <InventoryAccountingClose scope={scope} range={range} canViewFinance={canViewFinance} />
      <ReportReadiness mode="inventory" />
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

export function formatSpecializedValue(key: string, value: unknown): string {
  if (value == null || value === "") return "—";
  if (/(qty|ordered|received|count|invoices|d30|d60|d90|current)/i.test(key) && Number.isFinite(Number(value))) return formatNumber(Number(value));
  if (/(amount|value|spend|total|net|vat|variance)/i.test(key) && Number.isFinite(Number(value))) return formatCurrency(Number(value));
  if (/(date|period)/i.test(key)) return formatDate(String(value));
  return String(value);
}

function ReportAssuranceSummary({ report }: { report: IntelligenceReportLink }) {
  const t = useT();
  return (
    <div className="mb-3 grid gap-3 rounded-2xl border border-slate-200 bg-slate-50/70 p-3 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,auto)]" data-testid="selected-report-assurance">
      <div>
        <h3 className="text-sm font-extrabold text-slate-900">{t(report.labelKey)}</h3>
        <p className="mt-1 text-xs font-medium leading-5 text-slate-500">{t(report.descriptionKey)}</p>
      </div>
      <dl className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-xl bg-white p-2.5"><dt className="font-bold text-slate-400">{t("warehouseIntelligence.assurance.statusLabel")}</dt><dd className="mt-1 font-extrabold text-slate-700">{t(`warehouseIntelligence.assurance.maturity.${report.maturity}`)}</dd></div>
        <div className="rounded-xl bg-white p-2.5"><dt className="font-bold text-slate-400">{t("warehouseIntelligence.assurance.basisLabel")}</dt><dd className="mt-1 font-extrabold text-slate-700">{t(`warehouseIntelligence.assurance.basis.${report.basis}`)}</dd></div>
        <div className="col-span-2 rounded-xl bg-white p-2.5"><dt className="font-bold text-slate-400">{t("warehouseIntelligence.assurance.sourceLabel")}</dt><dd className="mt-1 font-extrabold leading-5 text-slate-700">{t(`warehouseIntelligence.assurance.source.${report.basis}`)}</dd></div>
      </dl>
    </div>
  );
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
  const canViewFinance = useCan("finance.reports.view");
  const lang = useLang();
  const [searchParams, setSearchParams] = useSearchParams();
  const [draftQ, setDraftQ] = useState("");
  const [q, setQ] = useState("");
  const [supplier, setSupplier] = useState<SupplierHit | null>(null);
  const [item, setItem] = useState<ItemHit | null>(null);
  const requestedReport = SPECIALIZED_REPORT_IDS.has(searchParams.get("report") ?? "") ? String(searchParams.get("report")) : "open-orders";
  const selectedReport = requestedReport;
  const selectedReportDefinition = PURCHASING_INTELLIGENCE_REPORTS.find((item) => item.id === selectedReport);
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
        {selectedReportDefinition && <ReportAssuranceSummary report={selectedReportDefinition} />}
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
      <GrniAccountingClose scope={scope} canViewFinance={canViewFinance} />
      <ReportReadiness mode="purchasing" />
    </div>
  );
}

function MiniTotal({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2"><div className="text-[11px] font-bold text-slate-500">{label}</div><div className="mt-0.5 text-sm font-extrabold tabular-nums text-slate-900">{value}</div></div>;
}

export function WarehouseIntelligenceHub({ mode }: { mode: WarehouseIntelligenceMode }) {
  const t = useT();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { scope } = useWarehouseScope();
  const [range, setRange] = useState<DateRange>(initialRange);
  const titleKey = mode === "inventory" ? "warehouseIntelligence.inventory.title" : "warehouseIntelligence.purchases.title";
  const subtitleKey = mode === "inventory" ? "warehouseIntelligence.inventory.subtitle" : "warehouseIntelligence.purchases.subtitle";
  const isDirectory = location.search === "" && location.hash === "";

  // Purchasing's catalogue now lives with the pages it opens: every row is a
  // real /reports/purchasing/<id> route rather than a `?report=X#anchor` back
  // into THIS page, so it is rendered from the purchasing registry, not from
  // the governance catalog. This page keeps serving the WORKSPACE below.
  if (isDirectory && mode === "purchasing") return <PurchasingReportsDirectory />;

  if (isDirectory) {
    return (
      <div data-testid="warehouse-report-directory" data-mode={mode}>
        <PageHeader title={t(mode === "inventory" ? "warehouseIntelligence.inventory.directoryTitle" : "warehouseIntelligence.purchases.directoryTitle")} />
        <ReportCatalog mode={mode} range={range} scope={scope} />
      </div>
    );
  }

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
