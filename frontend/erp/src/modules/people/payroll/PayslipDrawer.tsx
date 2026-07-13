import type { ReactNode } from "react";
import { Printer } from "lucide-react";
import { Button, Drawer, ErrorState, LoadingState } from "@/shared/ui";
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
  const open = !!runId && !!empId;
  const query = usePayslip(runId, empId);
  const p = query.data;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={employeeName || "قسيمة الراتب"}
      eyebrow="قسيمة راتب"
      icon={Printer}
      footer={
        <div className="no-print flex w-full items-center justify-between gap-2">
          <Button variant="secondary" onClick={onClose}>
            إغلاق
          </Button>
          <Button variant="primary" onClick={() => window.print()} disabled={!p}>
            <Printer className="h-4 w-4" /> طباعة
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
  const allowances = p.housingAllowance + p.transportAllowance + p.otherAllowance;
  return (
    <div className="print-document space-y-4" dir="rtl">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 border-b border-slate-100 pb-3">
        <div>
          <h3 className="text-lg font-extrabold text-slate-900">قسيمة راتب</h3>
          <p className="mt-0.5 text-xs font-bold text-slate-500">
            {p.companyName || "نظام ADLAN"}
          </p>
        </div>
        <div className="text-left">
          <div className="text-xs font-bold text-slate-500">الفترة</div>
          <div className="text-sm font-extrabold text-slate-800">
            {p.month ? periodLabel({ month: p.month, year: p.year }) : "—"}
          </div>
        </div>
      </div>

      {/* Employee */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-[11px] font-bold text-slate-400">الموظف</div>
          <div className="text-sm font-extrabold text-slate-800">{p.employeeName || "—"}</div>
        </div>
        <div>
          <div className="text-[11px] font-bold text-slate-400">الرقم الوظيفي</div>
          <div dir="ltr" className="text-sm font-extrabold text-slate-800 tabular-nums">
            {p.employeeNumber || "—"}
          </div>
        </div>
        {p.branchName && (
          <div>
            <div className="text-[11px] font-bold text-slate-400">الفرع</div>
            <div className="text-sm font-extrabold text-slate-800">{p.branchName}</div>
          </div>
        )}
      </div>

      {/* Earnings */}
      <Section title="المستحقات">
        <Line label="الراتب الأساسي" value={money(p.basicSalary)} />
        <Line label="بدل السكن" value={money(p.housingAllowance)} />
        <Line label="بدل النقل" value={money(p.transportAllowance)} />
        <Line label="بدلات أخرى" value={money(p.otherAllowance)} />
        <Line
          label={`العمل الإضافي${p.overtimeHours ? ` (${money(p.overtimeHours)} ساعة)` : ""}`}
          value={money(p.overtimeAmount)}
        />
        <Line label="إجمالي البدلات" value={money(allowances)} />
        <Line label="إجمالي المستحق" value={money(p.grossSalary)} strong />
      </Section>

      {/* Deductions */}
      <Section title="الاستقطاعات">
        <Line label="خصم الغياب" value={money(p.absenceDeduction)} />
        <Line label="خصم التأخير" value={money(p.lateDeduction)} />
        <Line label="سلف" value={money(p.advanceDeduction)} />
        <Line label="إجمالي الاستقطاعات" value={money(p.totalDeductions)} strong />
      </Section>

      {/* Net */}
      <div className="flex items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
        <span className="text-sm font-extrabold text-emerald-700">صافي الراتب</span>
        <span dir="ltr" className="text-lg font-extrabold text-emerald-700 tabular-nums">
          {money(p.netSalary)} ر.س
        </span>
      </div>
    </div>
  );
}
