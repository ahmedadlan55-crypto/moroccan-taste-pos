// الرئيسية — the one screen that answers "what do I need to do right now".
//
// Everything here is a shortcut into a tab that owns the detail. It deliberately
// leads with today's clock state, because that is the question an employee opens
// this app to answer, and it repeats the clock button so the common case is one
// tap from launch rather than two.
import { ChevronLeft, Clock, Fingerprint } from "lucide-react";
import { Card, EmptyState, ErrorState, LoadingState, Stat, StatGrid } from "@/components/ui";
import { useT } from "@/i18n";
import { useAttendance, useHoursSummary, useLeaveBalances, useProfile } from "@/lib/queries";
import { deriveClockState } from "@/lib/selfService";
import { formatHours, formatMoney, formatNumber, formatTime, toYmd } from "@/lib/format";
import type { PageId } from "@/components/Shell";
import type { MyAttendanceRow } from "@/lib/types";

/** Today's row, matched on the DEVICE's calendar day — the employee's day. */
function todayRow(rows: MyAttendanceRow[]): MyAttendanceRow | undefined {
  const today = toYmd(new Date());
  return rows.find((r) => String(r.attendance_date ?? "").slice(0, 10) === today);
}

export function HomePage({ onNavigate }: { onNavigate: (page: PageId) => void }) {
  const t = useT();
  const profile = useProfile();
  const attendance = useAttendance();
  const balances = useLeaveBalances();

  const now = new Date();
  const monthFrom = toYmd(new Date(now.getFullYear(), now.getMonth(), 1));
  const hours = useHoursSummary(monthFrom, toYmd(now));

  const rows = attendance.data ?? [];
  const state = deriveClockState(rows);
  const today = todayRow(rows);

  const statusLine =
    state === "in"
      ? t("home.notClockedIn")
      : state === "out"
        ? t("home.clockedInAt", { time: formatTime(today?.clock_in) })
        : t("home.completedToday", {
            inTime: formatTime(today?.clock_in),
            outTime: formatTime(today?.clock_out),
          });

  const remainingLeave = (balances.data ?? []).reduce(
    (sum, b) => sum + Number(b.remaining_days ?? 0),
    0,
  );

  const totals = hours.data?.totals;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        {profile.isLoading ? (
          <LoadingState />
        ) : profile.isError ? (
          <ErrorState error={profile.error} onRetry={() => void profile.refetch()} />
        ) : (
          <p className="text-sm font-extrabold text-slate-900">
            {t("home.greeting", {
              name: (profile.data?.first_name as string) || (profile.data?.full_name as string) || "",
            })}
          </p>
        )}
      </Card>

      {/* Today. Tapping anywhere on it goes to the clock — the whole card is the
          target, because a thumb on a phone is imprecise. */}
      <button
        type="button"
        onClick={() => onNavigate("clock")}
        className="surface btn-press flex items-center gap-3 px-4 py-4 text-start"
      >
        <span
          className={
            state === "done"
              ? "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-400"
              : "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-teal-50 text-teal-700"
          }
        >
          <Fingerprint className="h-6 w-6" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[11px] font-bold text-slate-400">{t("home.todayStatus")}</span>
          <span className="block truncate text-sm font-extrabold text-slate-900">
            {attendance.isLoading ? t("common.loading") : statusLine}
          </span>
        </span>
        {/* rtl:rotate-180 — the chevron must point INTO the page, and "forward"
            is the other way round in RTL. */}
        <ChevronLeft className="h-4 w-4 shrink-0 text-slate-300 rtl:rotate-180" aria-hidden />
      </button>

      <Card title={t("hours.thisMonth")} action={<Clock className="h-4 w-4 text-slate-300" aria-hidden />}>
        {hours.isLoading ? (
          <LoadingState />
        ) : hours.isError ? (
          <ErrorState error={hours.error} onRetry={() => void hours.refetch()} />
        ) : !totals ? (
          <EmptyState message={t("home.noEmployeeProfile")} />
        ) : (
          <StatGrid>
            <Stat label={t("home.monthHours")} value={formatHours(totals.totalHours)} />
            <Stat
              label={t("home.monthOvertime")}
              value={formatHours(totals.overtimeHours)}
              tone="good"
              hint={<span className="num">+{formatMoney(totals.overtimeValue)}</span>}
            />
            <Stat
              label={t("home.monthLate")}
              value={formatHours(totals.lateHours)}
              tone={totals.lateHours > 0 ? "bad" : "neutral"}
              hint={<span className="num">−{formatMoney(totals.lateValue)}</span>}
            />
            <Stat
              label={t("home.leaveBalance")}
              value={formatNumber(remainingLeave)}
              unit={t("common.days")}
              tone="accent"
            />
          </StatGrid>
        )}
      </Card>
    </div>
  );
}
