// Unified "المشتريات والموردون" module shell — one section, internal tab
// sub-navigation (spec §12). Renders under the AppShell's Outlet; its own
// <Outlet/> hosts the sub-pages.
import type { ReactNode } from "react";
import { NavLink, Outlet, Link } from "react-router-dom";
import { Users, ClipboardList, FileText, PackageCheck, Receipt, Wallet, Undo2, Lock } from "lucide-react";
import { cn } from "@/shared/lib";
import { PageHeader } from "@/shared/ui";
import { useServerFlags } from "@/app/server-flags";

// Tabs map to the unified manifest's purchasing leaf paths (the shell registers
// each of these; sub-pages — detail / create — ride on the same path via ?doc /
// ?new search params handled by the purchasing module index).
const TABS = [
  { to: "/purchasing/suppliers", label: "الموردون", icon: Users, end: false },
  { to: "/purchasing/requisitions", label: "طلبات الشراء", icon: ClipboardList, end: false },
  { to: "/purchasing/orders", label: "أوامر الشراء", icon: FileText, end: false },
  { to: "/purchasing/receiving", label: "الاستلامات", icon: PackageCheck, end: false },
  { to: "/purchasing/invoices", label: "الفواتير", icon: Receipt, end: false },
  { to: "/purchasing/payments", label: "المدفوعات", icon: Wallet, end: false },
  { to: "/purchasing/returns", label: "المرتجعات", icon: Undo2, end: false },
];

export function ProcurementLayout({ children }: { children?: ReactNode }) {
  // The unified server-flags hook exposes `procurementP2P` (dormant/false until
  // the backend /version flag turns on) — the shell's flag pattern, no separate
  // loading state.
  const { procurementP2P } = useServerFlags();
  if (!procurementP2P) {
    return (
      <div className="surface grid place-items-center gap-3 p-12 text-center">
        <span className="grid h-14 w-14 place-items-center rounded-2xl bg-slate-100 text-slate-400"><Lock className="h-6 w-6" /></span>
        <div className="text-lg font-extrabold text-slate-800">وحدة المشتريات والموردون غير مفعّلة</div>
        <p className="max-w-md text-sm font-medium text-slate-500">
          هذه الوحدة مُهيّأة لكنها خاملة على هذه البيئة (العلم <code className="rounded bg-slate-100 px-1">PROCUREMENT_P2P_ENABLE</code> غير مُفعّل).
          تُفعّل من إعدادات الخادم عند الجاهزية.
        </p>
        <Link className="text-sm font-bold text-teal-700 hover:underline" to="/">العودة إلى مركز المستودعات</Link>
      </div>
    );
  }
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
      {children ?? <Outlet />}
    </div>
  );
}
