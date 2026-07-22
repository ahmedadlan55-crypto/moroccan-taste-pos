// Shared bits for the Overview (Home) module: the dashboard data types, a KPI
// tile, and the KPI grid reused by both the overview and the KPIs screens.
import { useQuery } from "@tanstack/react-query";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { apiClient } from "@/shared/api";
import { formatCurrency, formatNumber } from "@/shared/lib";
import { useT } from "@/i18n";

export interface KpiValue {
  value: number;
  prev?: number;
  delta?: number;
}
export interface OpsValue {
  count: number;
  amount: number;
}
export interface DashboardOverview {
  kpi?: {
    sales?: KpiValue;
    orders?: KpiValue;
    avgTicket?: KpiValue;
    expenses?: KpiValue;
    purchases?: KpiValue;
    netIncome?: KpiValue;
    grossMargin?: { value: number };
  };
  ops?: {
    pendingPayments?: OpsValue;
    arOutstanding?: OpsValue;
    apOutstanding?: OpsValue;
  };
}

/** Shared dashboard query — a couple of screens read the same aggregate. */
export function useDashboardOverview() {
  return useQuery({
    queryKey: ["dashboard", "overview"],
    queryFn: ({ signal }) => apiClient.get<DashboardOverview>("/dashboard/overview", { signal }),
    staleTime: 60_000,
  });
}

function Delta({ delta }: { delta?: number }) {
  if (delta == null || !Number.isFinite(delta) || delta === 0) return null;
  const up = delta > 0;
  return (
    <span
      className={
        up
          ? "inline-flex items-center gap-0.5 text-xs font-extrabold text-emerald-600"
          : "inline-flex items-center gap-0.5 text-xs font-extrabold text-rose-600"
      }
      dir="ltr"
    >
      {up ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
      {formatNumber(Math.abs(delta))}%
    </span>
  );
}

export function KpiTile({
  label,
  value,
  delta,
}: {
  label: string;
  value: string;
  delta?: number;
}) {
  return (
    <div className="surface p-4">
      <div className="text-xs font-bold text-slate-400">{label}</div>
      <div className="mt-1.5 flex items-end justify-between gap-2">
        <span className="text-xl font-extrabold tabular-nums text-slate-900" dir="ltr">
          {value}
        </span>
        <Delta delta={delta} />
      </div>
    </div>
  );
}

/** The financial KPI grid derived from the dashboard overview payload. */
export function KpiGrid({ data }: { data: DashboardOverview }) {
  const t = useT();
  const k = data.kpi ?? {};
  const gm = k.grossMargin?.value ?? 0;
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <KpiTile label={t("overview.kpi.sales")} value={formatCurrency(k.sales?.value ?? 0)} delta={k.sales?.delta} />
      <KpiTile label={t("overview.kpi.orders")} value={formatNumber(k.orders?.value ?? 0)} delta={k.orders?.delta} />
      <KpiTile label={t("overview.kpi.avgTicket")} value={formatCurrency(k.avgTicket?.value ?? 0)} delta={k.avgTicket?.delta} />
      <KpiTile label={t("overview.kpi.netIncome")} value={formatCurrency(k.netIncome?.value ?? 0)} delta={k.netIncome?.delta} />
      <KpiTile label={t("overview.kpi.expenses")} value={formatCurrency(k.expenses?.value ?? 0)} delta={k.expenses?.delta} />
      <KpiTile label={t("overview.kpi.purchases")} value={formatCurrency(k.purchases?.value ?? 0)} delta={k.purchases?.delta} />
      <KpiTile label={t("overview.kpi.grossMargin")} value={`${formatNumber(gm)}%`} />
    </div>
  );
}

/** The operational balances (AR/AP/pending payments) from the same payload. */
export function OpsGrid({ data }: { data: DashboardOverview }) {
  const t = useT();
  const ops = data.ops ?? {};
  const tile = (label: string, v?: OpsValue) => (
    <div className="surface p-4">
      <div className="text-xs font-bold text-slate-400">{label}</div>
      <div className="mt-1.5 text-lg font-extrabold tabular-nums text-slate-900" dir="ltr">
        {formatCurrency(v?.amount ?? 0)}
      </div>
      <div className="mt-0.5 text-[11px] font-bold text-slate-400" dir="ltr">
        {formatNumber(v?.count ?? 0)} {t("table.itemNoun")}
      </div>
    </div>
  );
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {tile(t("overview.ops.pendingPayments"), ops.pendingPayments)}
      {tile(t("overview.ops.arOutstanding"), ops.arOutstanding)}
      {tile(t("overview.ops.apOutstanding"), ops.apOutstanding)}
    </div>
  );
}
