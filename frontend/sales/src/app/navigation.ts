import {
  LayoutDashboard, Users, ClipboardList, FileText, HandCoins, Undo2, BarChart3,
  type LucideIcon,
} from "lucide-react";
import type { O2CCapability } from "@/lib/permissions";

// One section «المبيعات والعملاء» with a secondary (in-section) nav — spec §1.
// Each entry gates on a capability so the UI only shows what the user may open.
export interface NavItem {
  id: string;
  label: string;
  path: string;
  icon: LucideIcon;
  cap: O2CCapability;
}

export const navItems: NavItem[] = [
  { id: "dashboard", label: "اللوحة", path: "/dashboard", icon: LayoutDashboard, cap: "o2c.dashboard.view" },
  { id: "customers", label: "العملاء", path: "/customers", icon: Users, cap: "customers.view" },
  { id: "orders", label: "أوامر البيع", path: "/orders", icon: ClipboardList, cap: "sales_orders.view" },
  { id: "invoices", label: "الفواتير", path: "/invoices", icon: FileText, cap: "invoices.view" },
  { id: "payments", label: "التحصيلات", path: "/payments", icon: HandCoins, cap: "payments.view" },
  { id: "returns", label: "المرتجعات", path: "/returns", icon: Undo2, cap: "returns.view" },
  { id: "reports", label: "الذمم والتقارير", path: "/reports", icon: BarChart3, cap: "ar_reports.view" },
];
