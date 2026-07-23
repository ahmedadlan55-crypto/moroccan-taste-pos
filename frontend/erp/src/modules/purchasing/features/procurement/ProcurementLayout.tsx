// Unified "المشتريات والموردون" module shell — one section, internal tab
// sub-navigation (spec §12). Renders under the AppShell's Outlet; its own
// <Outlet/> hosts the sub-pages.
import type { ReactNode } from "react";
import { NavLink, Outlet, Link } from "react-router-dom";
import { Users, ClipboardList, FileText, PackageCheck, Receipt, Wallet, Undo2, Lock } from "lucide-react";
import { cn } from "@/shared/lib";
import { PageHeader } from "@/shared/ui";
import { useServerFlags } from "@/app/server-flags";
import { useT } from "@/i18n";

// Tabs map to the unified manifest's purchasing leaf paths (the shell registers
// each of these; sub-pages — detail / create — ride on the same path via ?doc /
// ?new search params handled by the purchasing module index). `labelKey` resolves
// against the `purchasing.tabs.*` i18n namespace at render time.
const TABS = [
  { to: "/purchasing/suppliers", labelKey: "purchasing.tabs.suppliers", icon: Users, end: false },
  { to: "/purchasing/requisitions", labelKey: "purchasing.tabs.requisitions", icon: ClipboardList, end: false },
  { to: "/purchasing/orders", labelKey: "purchasing.tabs.orders", icon: FileText, end: false },
  { to: "/purchasing/receiving", labelKey: "purchasing.tabs.receiving", icon: PackageCheck, end: false },
  { to: "/purchasing/invoices", labelKey: "purchasing.tabs.invoices", icon: Receipt, end: false },
  { to: "/purchasing/payments", labelKey: "purchasing.tabs.payments", icon: Wallet, end: false },
  { to: "/purchasing/returns", labelKey: "purchasing.tabs.returns", icon: Undo2, end: false },
];

export function ProcurementLayout({ children }: { children?: ReactNode }) {
  const t = useT();
  // The unified server-flags hook exposes `procurementP2P` (dormant/false until
  // the backend /version flag turns on) — the shell's flag pattern, no separate
  // loading state.
  const { procurementP2P } = useServerFlags();
  if (!procurementP2P) {
    return (
      <div data-state="feature-disabled" className="surface grid place-items-center gap-3 p-12 text-center">
        <span className="grid h-14 w-14 place-items-center rounded-2xl bg-slate-100 text-slate-400"><Lock className="h-6 w-6" /></span>
        <div className="text-lg font-extrabold text-slate-800">{t("purchasing.layout.disabledTitle")}</div>
        <p className="max-w-md text-sm font-medium text-slate-500">
          {t("purchasing.layout.disabledBodyPre")} <code className="rounded bg-slate-100 px-1">PROCUREMENT_P2P_ENABLE</code> {t("purchasing.layout.disabledBodyPost")}
        </p>
        <Link className="text-sm font-bold text-teal-700 hover:underline" to="/overview">{t("purchasing.layout.backToOverview")}</Link>
      </div>
    );
  }
  return (
    <div>
      <PageHeader eyebrow="Procure-to-Pay" title={t("purchasing.layout.title")} subtitle={t("purchasing.layout.subtitle")} />
      <nav className="mb-6 flex flex-wrap gap-1.5 border-b border-slate-200 pb-2 print:hidden" aria-label={t("purchasing.layout.tabsAria")}>
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-bold transition",
                isActive ? "bg-teal-600 text-white shadow-sm" : "text-slate-500 hover:bg-slate-100 hover:text-slate-800",
              )
            }
          >
            <tab.icon className="h-4 w-4" />
            {t(tab.labelKey)}
          </NavLink>
        ))}
      </nav>
      {children ?? <Outlet />}
    </div>
  );
}
