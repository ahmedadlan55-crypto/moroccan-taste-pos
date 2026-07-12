import { Banknote } from "lucide-react";
import { EmptyState, PageHeader } from "@/shared/ui";

/**
 * DEFERRED — Payroll run engine. The multi-week payroll run + calculation flow
 * (hr_payroll_runs / calculate / approve / pay / payslip export) is a heavy,
 * server-owned engine that stays in the legacy system for now. This is a clean
 * placeholder (no half-built UI) until it is converted in a dedicated pass.
 */
export function PayrollPage() {
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="الموارد البشرية" title="الرواتب" subtitle="دورات احتساب الرواتب ومسيّرها." />
      <EmptyState
        icon={<Banknote className="h-6 w-6" />}
        title="قيد التحويل — يُدار حاليًا في النظام الأصلي"
        body="محرّك احتساب الرواتب (الدورات الشهرية، الاعتماد، الصرف، قسائم الراتب) لا يزال يعمل ضمن النظام الأصلي وسيُنقل إلى الواجهة الموحّدة في مرحلة لاحقة."
      />
    </div>
  );
}
