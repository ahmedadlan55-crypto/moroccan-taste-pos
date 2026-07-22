import type { ReactNode } from "react";
import { Printer } from "lucide-react";
import { Button, Drawer, ErrorState, LoadingState } from "@/shared/ui";
import { useTx } from "@/shared/ui/i18n";
import { useLang } from "@/i18n";
import { money, periodLabel, usePayslip, type Payslip } from "./api";

interface PayslipDrawerProps {
  runId: string | null;
  empId: string | null;
  /** Employee name from the item row — a friendly title before the payslip loads. */
  employeeName?: string;
  onClose: () => void;
}

function Line({ label, value, strong }: { label: string; value: ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className={strong ? "text-sm font-extrabold text-slate-800" : "text-sm font-medium text-slate-600"}>
        {label}
      </span>
      <span
        dir="ltr"
        className={
          strong
            ? "text-sm font-extrabold text-slate-900 tabular-nums"
            : "text-sm font-semibold text-slate-700 tabular-nums"
        }
      >
        {value}
      </span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50/60 p-3">
      <div className="mb-1 text-[11px] font-extrabold text-slate-500">{title}</div>
      <div className="divide-y divide-slate-100">{children}</div>
    </div>
  );
}

export function PayslipDrawer({ runId, empId, employeeName, onClose }: PayslipDrawerProps) {
  const t = useTx();
  const open = !!runId && !!empId;
  const query = usePayslip(runId, empId);
  const p = query.data;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={employeeName || t("people.payroll.payslip.title")}
      eyebrow={t("people.payroll.payslip.eyebrow")}
      icon={Printer}
      footer={
        <div className="no-print flex w-full items-center justify-between gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t("common.close")}
          </Button>
          <Button variant="primary" onClick={() => window.print()} disabled={!p}>
            <Printer className="h-4 w-4" /> {t("people.payroll.payslip.print")}
          </Button>
        </div>
      }
    >
      {query.isLoading ? (
        <LoadingState rows={4} />
      ) : query.error ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : p ? (
        <PayslipBody p={p} />
      ) : null}
    </Drawer>
  );
}

function PayslipBody({ p }: { p: Payslip }) {
  const t = useTx();
  const lang = useLang();
  const allowances = p.housingAllowance + p.transportAllowance + p.otherAllowance;
  return (
    <div className="print-document space-y-4" dir={lang === "ar" ? "rtl" : "ltr"}>
      {/* Header */}
      <div className="flex items-start justify-between gap-3 border-b border-slate-100 pb-3">
        <div>
          <h3 className="text-lg font-extrabold text-slate-900">{t("people.payroll.payslip.heading")}</h3>
          <p className="mt-0.5 text-xs font-bold text-slate-500">
            {p.companyName || t("people.payroll.payslip.systemName")}
          </p>
        </div>
        <div className="text-end">
          <div className="text-xs font-bold text-slate-500">{t("people.payroll.payslip.period")}</div>
          <div className="text-sm font-extrabold text-slate-800">
            {p.month ? periodLabel({ month: p.month, year: p.year }, t) : "—"}
          </div>
        </div>
      </div>

      {/* Employee */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-[11px] font-bold text-slate-400">{t("people.field.employee")}</div>
          <div className="text-sm font-extrabold text-slate-800">{p.employeeName || "—"}</div>
        </div>
        <div>
          <div className="text-[11px] font-bold text-slate-400">{t("people.field.empNumber")}</div>
          <div dir="ltr" className="text-sm font-extrabold text-slate-800 tabular-nums">
            {p.employeeNumber || "—"}
          </div>
        </div>
        {p.branchName && (
          <div>
            <div className="text-[11px] font-bold text-slate-400">{t("people.field.branch")}</div>
            <div className="text-sm font-extrabold text-slate-800">{p.branchName}</div>
          </div>
        )}
      </div>

      {/* Earnings */}
      <Section title={t("people.payroll.payslip.earnings")}>
        <Line label={t("people.payroll.payslip.basicSalary")} value={money(p.basicSalary)} />
        <Line label={t("people.payroll.payslip.housing")} value={money(p.housingAllowance)} />
        <Line label={t("people.payroll.payslip.transport")} value={money(p.transportAllowance)} />
        <Line label={t("people.payroll.payslip.other")} value={money(p.otherAllowance)} />
        <Line
          label={p.overtimeHours ? t("people.payroll.payslip.overtimeHours", { hours: money(p.overtimeHours) }) : t("people.payroll.payslip.overtime")}
          value={money(p.overtimeAmount)}
        />
        <Line label={t("people.payroll.payslip.totalAllowances")} value={money(allowances)} />
        <Line label={t("people.payroll.payslip.totalGross")} value={money(p.grossSalary)} strong />
      </Section>

      {/* Deductions */}
      <Section title={t("people.payroll.payslip.deductions")}>
        <Line label={t("people.payroll.payslip.absence")} value={money(p.absenceDeduction)} />
        <Line label={t("people.payroll.payslip.lateDeduction")} value={money(p.lateDeduction)} />
        <Line label={t("people.payroll.payslip.advance")} value={money(p.advanceDeduction)} />
        <Line label={t("people.payroll.payslip.totalDeductions")} value={money(p.totalDeductions)} strong />
      </Section>

      {/* Net */}
      <div className="flex items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
        <span className="text-sm font-extrabold text-emerald-700">{t("people.payroll.payslip.net")}</span>
        <span dir="ltr" className="text-lg font-extrabold text-emerald-700 tabular-nums">
          {money(p.netSalary)} {t("people.payroll.payslip.sar")}
        </span>
      </div>
    </div>
  );
}
