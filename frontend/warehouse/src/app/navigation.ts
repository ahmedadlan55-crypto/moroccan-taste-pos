import {
  LayoutDashboard,
  Warehouse,
  Boxes,
  PackageCheck,
  Truck,
  ClipboardCheck,
  SlidersHorizontal,
  Factory,
  BarChart3,
  FileBarChart,
  GitBranch,
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
    ],
  },
  {
    title: "العمليات",
    items: [
      { id: "receipts", label: "الاستلامات", path: "/receipts", icon: PackageCheck },
      { id: "transfers", label: "التحويلات وإذونات الصرف", path: "/transfers", icon: Truck },
      { id: "stocktakes", label: "الجرد والتسويات", path: "/stocktakes", icon: ClipboardCheck },
      { id: "adjustments", label: "التعديلات والهدر", path: "/adjustments", icon: SlidersHorizontal },
      { id: "production", label: "أوامر الإنتاج", path: "/production", icon: Factory },
    ],
  },
  {
    title: "الذكاء والتقارير",
    items: [
      { id: "analytics", label: "التحليلات والتنبيهات", path: "/analytics", icon: BarChart3 },
      { id: "reports", label: "مركز التقارير", path: "/reports", icon: FileBarChart },
      { id: "system-map", label: "خريطة النظام", path: "/system-map", icon: GitBranch },
    ],
  },
];

export const flatNav: NavItem[] = navigation.flatMap((g) => g.items);
