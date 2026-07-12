// The Reports center is a HUB: it does not duplicate report pages, it links to
// the canonical routes owned by the domain modules. Each section below maps to a
// /reports/* manifest path and lists the real destination routes.
import type { ComponentType } from "react";
import {
  BarChart3,
  Banknote,
  Boxes,
  CalendarClock,
  CalendarCheck,
  ClipboardCheck,
  CornerUpLeft,
  FileText,
  HandCoins,
  Layers,
  LineChart,
  PiggyBank,
  Plane,
  Receipt,
  RefreshCcw,
  Scale,
  ScrollText,
  ShoppingBag,
  ShoppingCart,
  Tags,
  TrendingUp,
  Truck,
  Undo2,
  Users,
  Wallet,
  Building2,
  Clock,
} from "lucide-react";

export interface ReportLink {
  to: string;
  label: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
}
export interface ReportSection {
  path: string;
  title: string;
  subtitle: string;
  links: ReportLink[];
}

export const REPORT_SECTIONS: Record<string, ReportSection> = {
  "/reports/sales": {
    path: "/reports/sales",
    title: "تقارير المبيعات",
    subtitle: "الأداء البيعي عبر الطلبات والفواتير والمرتجعات والمدفوعات.",
    links: [
      { to: "/sales/orders", label: "الطلبات", description: "حجم الطلبات وحالتها.", icon: ShoppingCart },
      { to: "/sales/invoices", label: "الفواتير", description: "الفواتير الصادرة والمحصّلة.", icon: FileText },
      { to: "/sales/returns", label: "المرتجعات", description: "مرتجعات المبيعات وأسبابها.", icon: Undo2 },
      { to: "/sales/payments", label: "المدفوعات", description: "التحصيل عبر طرق الدفع.", icon: Banknote },
      { to: "/sales/pricing", label: "الأسعار والخصومات", description: "أثر قوائم الأسعار والخصومات.", icon: Tags },
      { to: "/pos-admin/reports", label: "تقارير الكاشير", description: "مبيعات نقاط البيع والورديات.", icon: Receipt },
    ],
  },
  "/reports/inventory": {
    path: "/reports/inventory",
    title: "تقارير المخزون",
    subtitle: "الأرصدة والحركات والجرد والصلاحية.",
    links: [
      { to: "/inventory/balances", label: "الأرصدة", description: "أرصدة الأصناف في المستودعات.", icon: Boxes },
      { to: "/inventory/transfers", label: "التحويلات", description: "حركة الأصناف بين المستودعات.", icon: Truck },
      { to: "/inventory/stocktakes", label: "الجرد", description: "فروقات الجرد وتسوياتها.", icon: ClipboardCheck },
      { to: "/inventory/lots-expiry", label: "الصلاحية", description: "التشغيلات القريبة من الانتهاء.", icon: CalendarClock },
      { to: "/inventory/replenishment", label: "إعادة الطلب", description: "الأصناف تحت حد الطلب.", icon: RefreshCcw },
    ],
  },
  "/reports/purchasing": {
    path: "/reports/purchasing",
    title: "تقارير المشتريات",
    subtitle: "أوامر الشراء وفواتير الموردين والمدفوعات.",
    links: [
      { to: "/purchasing/orders", label: "أوامر الشراء", description: "أوامر الشراء وحالتها.", icon: ShoppingBag },
      { to: "/purchasing/invoices", label: "فواتير الموردين", description: "مطالبات الموردين.", icon: FileText },
      { to: "/purchasing/payments", label: "مدفوعات الموردين", description: "سداد مستحقات الموردين.", icon: Wallet },
      { to: "/purchasing/returns", label: "مرتجعات المشتريات", description: "المرتجعات للموردين.", icon: CornerUpLeft },
      { to: "/purchasing/suppliers", label: "الموردون", description: "أداء الموردين وأرصدتهم.", icon: Users },
    ],
  },
  "/reports/financial": {
    path: "/reports/financial",
    title: "التقارير المالية",
    subtitle: "القوائم المالية وأعمار الذمم — تُدار ضمن وحدة المحاسبة.",
    links: [
      { to: "/accounting/general-ledger", label: "الأستاذ العام", description: "حركة كل حساب.", icon: Layers },
      { to: "/accounting/trial-balance", label: "ميزان المراجعة", description: "أرصدة الحسابات.", icon: Scale },
      { to: "/accounting/income-statement", label: "قائمة الدخل", description: "الإيرادات والمصروفات.", icon: TrendingUp },
      { to: "/accounting/balance-sheet", label: "الميزانية", description: "المركز المالي.", icon: Building2 },
      { to: "/accounting/cash-flow", label: "التدفقات النقدية", description: "حركة النقد.", icon: LineChart },
      { to: "/accounting/ar-aging", label: "أعمار الذمم المدينة", description: "أعمار مديونيات العملاء.", icon: HandCoins },
      { to: "/accounting/ap-aging", label: "أعمار الذمم الدائنة", description: "أعمار مستحقات الموردين.", icon: PiggyBank },
    ],
  },
  "/reports/people": {
    path: "/reports/people",
    title: "تقارير الموظفين",
    subtitle: "الموظفون والحضور والرواتب والإجازات.",
    links: [
      { to: "/people/employees", label: "الموظفون", description: "بيانات الموظفين.", icon: Users },
      { to: "/people/attendance", label: "الحضور", description: "الحضور والانصراف.", icon: CalendarCheck },
      { to: "/people/payroll", label: "الرواتب", description: "مسيّرات الرواتب.", icon: Banknote },
      { to: "/people/leaves", label: "الإجازات", description: "أرصدة وطلبات الإجازات.", icon: Plane },
    ],
  },
  "/reports/operations": {
    path: "/reports/operations",
    title: "تقارير التشغيل",
    subtitle: "الورديات ونقاط البيع وسجل الإجراءات.",
    links: [
      { to: "/pos-admin/shifts", label: "الورديات", description: "إغلاق الورديات والفروقات.", icon: Clock },
      { to: "/pos-admin/reports", label: "تقارير نقاط البيع", description: "أداء نقاط البيع.", icon: Receipt },
      { to: "/workflow/action-log", label: "سجل الإجراءات", description: "سجل إجراءات المعاملات.", icon: ScrollText },
      { to: "/inventory", label: "نظرة المخزون", description: "مؤشرات المخزون التشغيلية.", icon: BarChart3 },
    ],
  },
};
