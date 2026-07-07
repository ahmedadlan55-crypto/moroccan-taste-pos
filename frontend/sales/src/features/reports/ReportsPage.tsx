import { Link } from "react-router-dom";
import { BarChart3, Users, Package, Radio, UserCog, CalendarClock, FileText, HandCoins, Wallet, ShieldAlert, Undo2, BadgeCheck, Database, Receipt } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardBody } from "@/components/ui/card";

interface ReportDef { type: string; label: string; desc: string; icon: LucideIcon }

const REPORTS: ReportDef[] = [
  { type: "sales-summary", label: "ملخص المبيعات", desc: "الصافي والضريبة والمرتجعات والمُحصّل", icon: BarChart3 },
  { type: "sales-by-customer", label: "المبيعات حسب العميل", desc: "إجمالي المبيعات لكل عميل", icon: Users },
  { type: "sales-by-product", label: "المبيعات حسب الصنف", desc: "الكميات والصافي لكل صنف", icon: Package },
  { type: "sales-by-channel", label: "المبيعات حسب القناة", desc: "التوزيع على قنوات البيع", icon: Radio },
  { type: "sales-by-cashier", label: "المبيعات حسب الكاشير", desc: "أداء نقاط البيع", icon: UserCog },
  { type: "ar-aging", label: "أعمار الذمم", desc: "حسب تاريخ الاستحقاق", icon: CalendarClock },
  { type: "open-invoices", label: "الفواتير المفتوحة", desc: "الأرصدة غير المسدّدة", icon: FileText },
  { type: "collections", label: "التحصيلات", desc: "سندات القبض المُرحّلة", icon: HandCoins },
  { type: "unallocated-payments", label: "دفعات غير مخصّصة", desc: "الأرصدة الدائنة المعلّقة", icon: Wallet },
  { type: "credit-exposure", label: "التعرّض الائتماني", desc: "الحدود والأرصدة والمتاح", icon: ShieldAlert },
  { type: "returns", label: "المرتجعات", desc: "مرتجعات البيع المُرحّلة", icon: Undo2 },
  { type: "zatca-status", label: "حالة زاتكا", desc: "توزيع حالات الفوترة الإلكترونية", icon: BadgeCheck },
  { type: "data-quality", label: "جودة البيانات", desc: "ملاحظات ونواقص للمراجعة", icon: Database },
  { type: "customer-statement", label: "كشف حساب عميل", desc: "من صفحة العميل 360°", icon: Receipt },
];

export function ReportsPage() {
  return (
    <div>
      <PageHeader eyebrow="الذمم والتقارير" title="مركز التقارير" subtitle="تقارير المبيعات والذمم — أرقام إنجليزية، تصدير وطباعة." />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {REPORTS.map((r) => {
          const Icon = r.icon;
          const disabled = r.type === "customer-statement";
          const inner = (
            <Card className={`h-full transition ${disabled ? "opacity-60" : "hover:-translate-y-0.5 hover:shadow-md"}`}>
              <CardBody className="flex items-start gap-3">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-teal-50 text-teal-700"><Icon className="h-5 w-5" /></span>
                <span className="min-w-0">
                  <span className="block text-sm font-extrabold text-slate-900">{r.label}</span>
                  <span className="mt-0.5 block text-xs font-semibold text-slate-500">{r.desc}</span>
                </span>
              </CardBody>
            </Card>
          );
          return disabled ? <div key={r.type} title="افتح من صفحة العميل">{inner}</div> : <Link key={r.type} to={`/reports/${r.type}`}>{inner}</Link>;
        })}
      </div>
    </div>
  );
}
