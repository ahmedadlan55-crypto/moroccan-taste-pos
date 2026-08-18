// ساعاتي — hours, overtime, lateness, and what each is worth in riyals.
//
// THIS SCREEN WAS LOST. `GET /api/hr/my-hours-summary` has been live and
// unconsumed since commit e97ebfbf deleted the PWA that called it: the ERP's
// self-service page shows a plain attendance table and never touches it. The
// endpoint computes far more than a table — per-day overtime and late minutes
// priced at the employee's own hourly rate, period totals, and a comparison
// against the previous period of equal length.
//
// The money framing is the point. "You were late 95 minutes this month" is
// abstract; "‎−34.20 SAR" is not, and it is the number the employee will see on
// the payslip. Overtime is paid at 1.5×, lateness deducted at 1.0× — both come
// from the server (multipliers), never hardcoded here, because the rate is a
// payroll policy and this screen is only a window onto it.
import { useMemo, useState } from "react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { Card, EmptyState, ErrorState, LoadingState, Stat, StatGrid } from "@/components/ui";
import { cn } from "@/lib/cn";
import { useT } from "@/i18n";
import { useHoursSummary } from "@/lib/queries";
import { formatDate, formatHours, formatMoney, formatNumber, formatSigned, toYmd } from "@/lib/format";
import type { HoursDayRow } from "@/lib/types";

type RangeId = "thisMonth" | "lastMonth" | "last7" | "last30";

/** Range boundaries, computed in the DEVICE's calendar — the employee's day. */
function resolveRange(id: RangeId): { from: string; to: string } {
  const now = new Date();
  switch (id) {
    case "lastMonth": {
      const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const last = new Date(now.getFullYear(), now.getMonth(), 0);
      return { from: toYmd(first), to: toYmd(last) };
    }
    case "last7": {
      const from = new Date(now);
      from.setDate(from.getDate() - 6);
      return { from: toYmd(from), to: toYmd(now) };
    }
    case "last30": {
      const from = new Date(now);
      from.setDate(from.getDate() - 29);
      return { from: toYmd(from), to: toYmd(now) };
    }
    case "thisMonth":
    default:
      return { from: toYmd(new Date(now.getFullYear(), now.getMonth(), 1)), to: toYmd(now) };
  }
}

const RANGES: RangeId[] = ["thisMonth", "lastMonth", "last7", "last30"];

/** Period-over-period arrow. Direction is meaning: MORE lateness is worse. */
function Delta({ pct, higherIsBetter }: { pct: number | undefined; higherIsBetter: boolean }) {
  if (pct === undefined || !Number.isFinite(pct) || Math.round(pct) === 0) {
    return (
      <span className="inline-flex items-center gap-0.5 text-[10px] font-bold text-slate-400">
        <Minus className="h-3 w-3" aria-hidden />
      </span>
    );
  }
  const up = pct > 0;
  const good = up === higherIsBetter;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-[10px] font-extrabold",
        good ? "text-emerald-600" : "text-rose-600",
      )}
    >
      <Icon className="h-3 w-3" aria-hidden />
      <span className="num">{formatNumber(Math.abs(pct), 0)}%</span>
    </span>
  );
}

export function HoursPage() {
  const t = useT();
  const [rangeId, setRangeId] = useState<RangeId>("thisMonth");
  const range = useMemo(() => resolveRange(rangeId), [rangeId]);
  const query = useHoursSummary(range.from, range.to);

  const data = query.data;
  const totals = data?.totals;
  const rows: HoursDayRow[] = data?.rows ?? [];

  return (
    <div className="flex flex-col gap-4">
      {/* Range picker. A scrolling row, not a <select>: four options is fewer
          taps as chips, and a native select on Android covers the screen. */}
      <div className="scrollbar-thin -mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        {RANGES.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setRangeId(id)}
            aria-pressed={id === rangeId}
            className={cn(
              "btn-press shrink-0 whitespace-nowrap rounded-full border px-3 py-2 text-xs font-extrabold",
              id === rangeId
                ? "border-teal-600 bg-teal-600 text-white"
                : "border-slate-200 bg-white text-slate-600",
            )}
          >
            {t(`hours.${id}`)}
          </button>
        ))}
      </div>

      {query.isLoading ? (
        <Card>
          <LoadingState />
        </Card>
      ) : query.isError ? (
        <Card>
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        </Card>
      ) : !data ? (
        <Card>
          <EmptyState />
        </Card>
      ) : (
        <>
          {/* The headline: what this period did to the paycheque. */}
          <Card>
            <div className="flex flex-col items-center gap-1 py-1 text-center">
              <span className="text-[11px] font-bold text-slate-500">{t("hours.netImpact")}</span>
              <span
                className={cn(
                  "num text-3xl font-extrabold",
                  (totals?.netImpact ?? 0) > 0
                    ? "text-emerald-600"
                    : (totals?.netImpact ?? 0) < 0
                      ? "text-rose-600"
                      : "text-slate-900",
                )}
              >
                {formatSigned(totals?.netImpact)}
              </span>
              <span className="text-[11px] font-bold text-slate-400">
                {t("common.riyal")} · {t("hours.netImpactHint")}
              </span>
            </div>
          </Card>

          <Card>
            <StatGrid>
              <Stat
                label={t("hours.totalHours")}
                value={formatHours(totals?.totalHours)}
                hint={
                  <span className="inline-flex items-center gap-1">
                    {t("hours.daysWorked")}: <span className="num">{formatNumber(totals?.days)}</span>
                  </span>
                }
              />
              <Stat
                label={t("hours.overtime")}
                value={formatHours(totals?.overtimeHours)}
                tone="good"
                hint={
                  <span className="inline-flex items-center gap-1">
                    <span className="num">+{formatMoney(totals?.overtimeValue)}</span>
                    <Delta pct={data.deltas?.overtimeHours} higherIsBetter />
                  </span>
                }
              />
              <Stat
                label={t("hours.late")}
                value={formatHours(totals?.lateHours)}
                tone={(totals?.lateHours ?? 0) > 0 ? "bad" : "neutral"}
                hint={
                  <span className="inline-flex items-center gap-1">
                    <span className="num">−{formatMoney(totals?.lateValue)}</span>
                    <Delta pct={data.deltas?.lateHours} higherIsBetter={false} />
                  </span>
                }
              />
              <Stat
                label={t("hours.earlyLeave")}
                value={formatHours(totals?.earlyLeaveHours)}
                tone={(totals?.earlyLeaveHours ?? 0) > 0 ? "bad" : "neutral"}
                hint={<span className="num">−{formatMoney(totals?.earlyLeaveValue)}</span>}
              />
            </StatGrid>

            <p className="mt-4 border-t border-slate-100 pt-3 text-[10px] font-bold text-slate-400">
              {t("hours.multiplierNote", { rate: data.multipliers?.overtime ?? 1.5 })} ·{" "}
              {t("hours.hourlyRate")}{" "}
              <span className="num">{formatMoney(data.employee?.hourlyRate)}</span>{" "}
              {t("common.riyal")}
            </p>
          </Card>

          <Card title={t("hours.perDay")} bodyClassName="px-0 py-0">
            {rows.length === 0 ? (
              <EmptyState message={t("hours.noRows")} />
            ) : (
              <ul>
                {rows.map((row, i) => (
                  <li
                    key={row.date ?? i}
                    className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3 last:border-b-0"
                  >
                    <div className="min-w-0">
                      <p className="num text-xs font-extrabold text-slate-800">{formatDate(row.date)}</p>
                      <p className="num mt-0.5 text-[11px] font-bold text-slate-400">
                        {formatHours(row.totalHours)} {t("common.hours")}
                        {row.lateMinutes > 0 && (
                          <span className="text-rose-500">
                            {" · "}
                            {t("hours.late")} {formatHours(row.lateHours)}
                          </span>
                        )}
                        {row.overtimeMinutes > 0 && (
                          <span className="text-emerald-600">
                            {" · "}
                            {t("hours.overtime")} {formatHours(row.overtimeHours)}
                          </span>
                        )}
                      </p>
                    </div>
                    <span
                      className={cn(
                        "num shrink-0 text-sm font-extrabold",
                        row.netImpact > 0
                          ? "text-emerald-600"
                          : row.netImpact < 0
                            ? "text-rose-600"
                            : "text-slate-400",
                      )}
                    >
                      {formatSigned(row.netImpact)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
