import { NavLink } from "react-router-dom";
import { ShoppingBag, Store, ExternalLink } from "lucide-react";
import { navItems } from "@/app/navigation";
import { usePermissions } from "@/app/permission-provider";
import { cn } from "@/lib/cn";

// The dark, fixed sidebar (right side in RTL). One section «المبيعات والعملاء»
// with its secondary nav. «فتح الكاشير» jumps to the POS V2 SPA in the same tab.
export function Sidebar() {
  const { can } = usePermissions();
  const items = navItems.filter((i) => can(i.cap));

  return (
    <aside className="fixed inset-y-0 right-0 z-30 hidden w-72 flex-col bg-slate-900 text-slate-100 lg:flex no-print">
      <div className="flex items-center gap-3 border-b border-white/10 px-5 py-5">
        <span className="grid h-11 w-11 place-items-center rounded-2xl bg-teal-500 text-white">
          <ShoppingBag className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <div className="truncate text-base font-extrabold">المبيعات والعملاء</div>
          <div className="truncate text-[11px] font-semibold text-slate-400">دورة الطلب إلى التحصيل</div>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4" aria-label="أقسام المبيعات">
        <ul className="flex flex-col gap-1">
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <li key={item.id}>
                <NavLink
                  to={item.path}
                  className={({ isActive }) =>
                    cn(
                      "flex min-h-11 items-center gap-3 rounded-xl px-3 py-2 text-sm font-bold transition",
                      isActive ? "bg-teal-500 text-white shadow-sm" : "text-slate-300 hover:bg-white/5 hover:text-white",
                    )
                  }
                >
                  <Icon className="h-[18px] w-[18px] shrink-0" />
                  <span className="truncate">{item.label}</span>
                </NavLink>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="border-t border-white/10 p-3">
        <a
          href="/pos-v2"
          className="flex min-h-11 items-center justify-center gap-2 rounded-xl bg-amber-500 px-3 py-2 text-sm font-extrabold text-slate-900 transition hover:bg-amber-400"
        >
          <Store className="h-[18px] w-[18px]" /> فتح الكاشير
        </a>
        <a
          href="/"
          className="mt-2 flex min-h-11 items-center justify-center gap-2 rounded-xl px-3 py-2 text-xs font-bold text-slate-400 transition hover:bg-white/5 hover:text-white"
        >
          <ExternalLink className="h-4 w-4" /> النظام الأساسي
        </a>
      </div>
    </aside>
  );
}
