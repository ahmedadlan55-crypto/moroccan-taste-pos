import {
  LayoutDashboard,
  Warehouse,
  Boxes,
  PackageCheck,
  PackageMinus,
  PackageOpen,
  Truck,
  ClipboardCheck,
  SlidersHorizontal,
  Factory,
  BarChart3,
  FileBarChart,
  ShieldAlert,
  TrendingDown,
  Tags,
  ShoppingCart,
  ShoppingBag,
  Layers,
  CalendarClock,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  id: string;
  label: string;
  path: string;
  icon: LucideIcon;
  badge?: number;
}

export interface NavGroup {
  title: string;
  items: NavItem[];
}

// Information architecture from the blueprint §4.2 / prompt §7.
export const navigation: NavGroup[] = [
  {
    title: "القيادة",
    items: [{ id: "dashboard", label: "مركز المستودعات", path: "/", icon: LayoutDashboard }],
  },
  {
    title: "البيانات الرئيسية",
    items: [
      { id: "warehouses", label: "المستودعات والهيكل", path: "/warehouses", icon: Warehouse },
      { id: "inventory", label: "المواد والأرصدة", path: "/inventory", icon: Boxes },
      { id: "items", label: "كتالوج الأصناف", path: "/items", icon: Tags },
      { id: "replenishment", label: "خطة إعادة الطلب", path: "/replenishment", icon: ShoppingCart },
      { id: "lots", label: "الدفعات", path: "/lots", icon: Layers },
      { id: "expiry", label: "تحذيرات الصلاحية", path: "/expiry", icon: CalendarClock },
    ],
  },
  {
    // One unified section (spec §12) — internal tabs cover suppliers / orders /
    // receipts / invoices / payments / returns / reports.
    title: "المشتريات والموردون",
    items: [
      { id: "purchasing", label: "المشتريات والموردون", path: "/purchasing", icon: ShoppingBag },
    ],
  },
  {
    title: "العمليات",
    items: [
      { id: "receipts", label: "الاستلامات", path: "/receipts", icon: PackageCheck },
      { id: "purchase-receiving", label: "استلام المشتريات", path: "/purchase-receiving", icon: PackageOpen },
      { id: "issues", label: "أذونات الصرف", path: "/issues", icon: PackageMinus },
      { id: "transfers", label: "التحويلات", path: "/transfers", icon: Truck },
      { id: "stocktakes", label: "الجرد", path: "/stocktakes", icon: ClipboardCheck },
      { id: "adjustments", label: "التعديلات المخزنية", path: "/adjustments", icon: SlidersHorizontal },
      { id: "production", label: "أوامر الإنتاج", path: "/production", icon: Factory },
    ],
  },
  {
    title: "الذكاء والتقارير",
    items: [
      { id: "analytics", label: "التحليلات والتنبيهات", path: "/analytics", icon: BarChart3 },
      { id: "reports", label: "مركز التقارير", path: "/reports", icon: FileBarChart },
      { id: "deficits", label: "تقرير العجز", path: "/deficits", icon: TrendingDown },
    ],
  },
  {
    title: "السياسات والضبط",
    items: [
      { id: "negative-policy", label: "سياسة المخزون السالب", path: "/negative-policy", icon: ShieldAlert },
    ],
  },
];

export const flatNav: NavItem[] = navigation.flatMap((g) => g.items);
