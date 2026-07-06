import { NavLink } from "react-router-dom";
import { Warehouse, MoreHorizontal, Home } from "lucide-react";
import { navigation } from "@/app/navigation";
import { useAuth } from "@/app/auth-provider";
import { useServerFlags } from "@/app/server-flags";
import { cn } from "@/lib/cn";

// Dark fixed sidebar (RTL: pinned to the right). Uses NavLink so the active
// route is derived from the URL, not local state.
export function Sidebar() {
  const { user } = useAuth();
  const { procurementEnabled } = useServerFlags();
  const initials = (user?.name || user?.username || "؟").slice(0, 2);
  // Keep the Procurement section DORMANT in the nav until the backend flag is on.
  const groups = navigation.filter((g) => procurementEnabled || !g.items.some((i) => i.id === "purchasing"));

  return (
    <aside className="no-print fixed inset-y-0 right-0 z-30 hidden w-72 flex-col bg-slate-950 px-4 pb-5 pt-4 text-white lg:flex">
      <div className="flex items-center gap-3 px-2 py-3">
        <span className="grid h-11 w-11 place-items-center rounded-2xl bg-teal-500 text-white shadow-lg shadow-teal-900/30">
          <Warehouse className="h-5 w-5" />
        </span>
        <div>
          <div className="text-base font-extrabold">المذاق المغربي</div>
          <div className="mt-0.5 text-[11px] font-bold text-slate-400">Warehouse Control Center</div>
        </div>
      </div>

      <nav className="mt-5 flex-1 overflow-y-auto pr-1 scrollbar-thin" aria-label="التنقل الرئيسي">
        {groups.map((group) => (
          <div key={group.title} className="mb-5">
            <div className="mb-2 px-3 text-[10px] font-extrabold tracking-wider text-slate-500">{group.title}</div>
            <div className="space-y-1">
              {group.items.map((item) => (
                <NavLink
                  key={item.id}
                  to={item.path}
                  end={item.path === "/"}
                  className={({ isActive }) => cn("nav-item", isActive && "nav-item-active")}
                >
                  {({ isActive }) => (
                    <>
                      <item.icon className="h-[18px] w-[18px] shrink-0" />
                      <span className="flex-1">{item.label}</span>
                      {item.badge && (
                        <span
                          className={cn(
                            "grid h-6 min-w-6 place-items-center rounded-full px-1.5 text-[10px] font-extrabold",
                            isActive ? "bg-slate-900 text-white" : "bg-rose-500 text-white",
                          )}
                        >
                          {item.badge}
                        </span>
                      )}
                    </>
                  )}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>

      {/* Same-tab jump back to the main system shell (same session/token —
          the warehouse section is a first-class part of the one app). */}
      <a href="/" className="nav-item mb-2 border border-white/10 bg-white/5 hover:bg-white/10">
        <Home className="h-[18px] w-[18px] shrink-0" />
        <span className="flex-1">العودة للنظام الرئيسي</span>
      </a>

      <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
        <div className="flex items-center gap-3">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-saffron-500 text-sm font-extrabold uppercase text-white">
            {initials}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-extrabold">{user?.name || user?.username || "زائر"}</div>
            <div className="text-[10px] font-bold text-slate-400">{user?.role ? roleLabel(user.role) : "غير مسجّل"}</div>
          </div>
          <MoreHorizontal className="h-4 w-4 text-slate-500" />
        </div>
      </div>
    </aside>
  );
}

function roleLabel(role: string): string {
  const map: Record<string, string> = {
    admin: "مدير النظام",
    manager: "مشرف",
    employee: "موظف مستودع",
    custody: "أمين عهدة",
    cashier: "كاشير",
    auditor: "مدقق",
  };
  return map[role] || role;
}
