// ملفي — who the employee is on file, what this month is projecting, and every
// payslip that has been run.
//
// TWO ENDPOINTS RESTORED HERE. Both `GET /api/hr/my-payslips` and
// `GET /api/hr/my-salary-projection` have been live and unconsumed since the
// PWA that called them was deleted — nothing in the ERP reads either. An
// employee has had no way to see their own payslip inside this product.
//
// The projection is labelled as an ESTIMATE, prominently. It is recomputed from
// attendance on every read (routes/hr.js → payrollEngine.computeMonthlyProjection),
// so it moves with each clock — which makes it useful and also makes it not a
// payslip. Presenting a moving figure as settled pay is how a payroll dispute
// starts.
import { LogOut } from "lucide-react";
import { Button, Card, EmptyState, ErrorState, FieldRow, LoadingState, Stat, StatGrid } from "@/components/ui";
import { useLang, useT } from "@/i18n";
import { useProfile, useProjection, usePayslips } from "@/lib/queries";
import { formatDate, formatMoney, formatMonth, formatNumber } from "@/lib/format";
import type { MyProfile, Payslip } from "@/lib/types";

function fullName(p: MyProfile | undefined): string {
  if (!p) return "—";
  const joined = [p.first_name, p.last_name].filter(Boolean).join(" ").trim();
  return (p.full_name as string) || joined || "—";
}

function shiftLabel(p: MyProfile | undefined): string {
  if (!p?.work_start && !p?.work_end) return "—";
  const clip = (v: unknown) => String(v ?? "").slice(0, 5) || "—";
  return `${clip(p?.work_start)} → ${clip(p?.work_end)}`;
}

export function ProfilePage({ onSignOut }: { onSignOut: () => void }) {
  const t = useT();
  const lang = useLang();
  const profile = useProfile();
  const projection = useProjection();
  const payslips = usePayslips();

  const p = profile.data;
  // The engine answers `{ error: 'no-employee-profile' }` with HTTP 200 for an
  // unlinked account — a known absence, not a failure, and it must not render
  // as an error banner.
  const proj = projection.data && !projection.data.error ? projection.data : null;
  const slips: Payslip[] = payslips.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <Card>
        {profile.isLoading ? (
          <LoadingState />
        ) : profile.isError ? (
          <ErrorState error={profile.error} onRetry={() => void profile.refetch()} />
        ) : (
          <>
            <div className="mb-3 flex flex-col items-center gap-1 text-center">
              <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-teal-50 text-lg font-extrabold text-teal-700">
                {fullName(p).trim().charAt(0) || "؟"}
              </span>
              <p className="mt-1 text-sm font-extrabold text-slate-900">{fullName(p)}</p>
              <p className="text-[11px] font-bold text-slate-400">{p?.job_title || "—"}</p>
            </div>
            <div>
              <FieldRow label={t("profile.employeeNumber")} value={p?.employee_number || "—"} numeric />
              <FieldRow label={t("profile.department")} value={p?.department_name || "—"} />
              <FieldRow label={t("profile.branch")} value={p?.branch_name || "—"} />
              <FieldRow label={t("profile.shift")} value={shiftLabel(p)} numeric />
              <FieldRow label={t("profile.hireDate")} value={formatDate(p?.hire_date)} numeric />
              <FieldRow label={t("profile.phone")} value={p?.phone || "—"} numeric />
            </div>
          </>
        )}
      </Card>

      <Card title={t("profile.projection")}>
        {projection.isLoading ? (
          <LoadingState />
        ) : !proj ? (
          <EmptyState message={t("home.noEmployeeProfile")} />
        ) : (
          <>
            <div className="mb-4 flex flex-col items-center gap-0.5 text-center">
              <span className="num text-3xl font-extrabold text-teal-700">
                {formatMoney(proj.net)}
              </span>
              <span className="text-[11px] font-bold text-slate-400">
                {t("common.riyal")}
                {proj.asOfDate ? ` · ${t("profile.projectionAsOf", { date: formatDate(proj.asOfDate) })}` : ""}
              </span>
            </div>

            <StatGrid cols={3}>
              <Stat label={t("profile.gross")} value={formatMoney(proj.earnings?.gross)} />
              <Stat
                label={t("profile.deductions")}
                value={formatMoney(proj.deductions?.total)}
                tone={Number(proj.deductions?.total) > 0 ? "bad" : "neutral"}
              />
              <Stat label={t("profile.overtimePay")} value={formatMoney(proj.earnings?.overtimePay)} tone="good" />
            </StatGrid>

            <div className="mt-4">
              <FieldRow label={t("profile.basicEarned")} value={formatMoney(proj.earnings?.basicEarned)} numeric />
              <FieldRow label={t("profile.allowances")} value={formatMoney(proj.earnings?.allowancesEarned)} numeric />
              <FieldRow
                label={t("profile.presentDays")}
                value={formatNumber(proj.attendance?.presentDays)}
                numeric
              />
              <FieldRow
                label={t("profile.absentDays")}
                value={formatNumber(proj.attendance?.absentDays)}
                numeric
              />
            </div>

            <p className="mt-3 border-t border-slate-100 pt-3 text-[10px] font-bold text-slate-400">
              {t("profile.projectionHint")}
            </p>
          </>
        )}
      </Card>

      <Card title={t("profile.payslips")} bodyClassName="px-0 py-0">
        {payslips.isLoading ? (
          <LoadingState />
        ) : payslips.isError ? (
          <ErrorState error={payslips.error} onRetry={() => void payslips.refetch()} />
        ) : slips.length === 0 ? (
          <EmptyState message={t("profile.noPayslips")} />
        ) : (
          <ul>
            {slips.map((slip) => (
              <li
                key={String(slip.id)}
                className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3 last:border-b-0"
              >
                <div className="min-w-0">
                  <p className="text-xs font-extrabold text-slate-800">
                    {formatMonth(slip.year, slip.month, lang)}
                  </p>
                  {slip.run_number && (
                    <p className="num mt-0.5 text-[11px] font-bold text-slate-400">{slip.run_number}</p>
                  )}
                </div>
                <span className="num shrink-0 text-sm font-extrabold text-slate-900">
                  {formatMoney(slip.net_salary)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Button variant="secondary" block onClick={onSignOut}>
        <LogOut className="h-4 w-4" aria-hidden />
        {t("common.signOut")}
      </Button>
    </div>
  );
}
