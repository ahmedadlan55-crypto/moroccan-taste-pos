// Unified "المشتريات والموردون" module shell — one section, internal tab
// sub-navigation (spec §12). Renders under the AppShell's Outlet; its own
// <Outlet/> hosts the sub-pages.
import { NavLink, Outlet } from "react-router-dom";
import { LayoutDashboard, Users, FileText, PackageCheck, Receipt, Wallet, Undo2, FileBarChart } from "lucide-react";
import { cn } from "@/lib/cn";
import { PageHeader } from "@/components/PageHeader";

const TABS = [
  { to: "/purchasing", label: "اللوحة", icon: LayoutDashboard, end: true },
  { to: "/purchasing/suppliers", label: "الموردون", icon: Users, end: false },
  { to: "/purchasing/orders", label: "أوامر الشراء", icon: FileText, end: false },
  { to: "/purchasing/receipts", label: "الاستلامات", icon: PackageCheck, end: false },
  { to: "/purchasing/invoices", label: "الفواتير", icon: Receipt, end: false },
  { to: "/purchasing/payments", label: "المدفوعات", icon: Wallet, end: false },
  { to: "/purchasing/returns", label: "المرتجعات", icon: Undo2, end: false },
  { to: "/purchasing/reports", label: "التقارير", icon: FileBarChart, end: false },
];

export function ProcurementLayout() {
  return (
    <div>
      <PageHeader eyebrow="Procure-to-Pay" title="المشتريات والموردون" subtitle="دورة كاملة: مورد ← أمر شراء ← استلام ← فاتورة ← سداد ← إرجاع" />
      <nav className="mb-6 flex flex-wrap gap-1.5 border-b border-slate-200 pb-2 print:hidden" aria-label="أقسام المشتريات">
        {TABS.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-bold transition",
                isActive ? "bg-teal-600 text-white shadow-sm" : "text-slate-500 hover:bg-slate-100 hover:text-slate-800",
              )
            }
          >
            <t.icon className="h-4 w-4" />
            {t.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}
