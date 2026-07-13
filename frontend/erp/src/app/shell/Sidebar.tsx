import { NavLink } from "react-router-dom";
import { LayoutGrid, MoreHorizontal, ChevronsRight, ChevronsLeft } from "lucide-react";
import { NAV } from "@/app/navigation/manifest";
import { useAuth } from "@/app/providers";
import { usePermissions } from "@/app/providers";
import { useServerFlags } from "@/app/server-flags";
import { getIcon } from "./icons";
import { useShell } from "./shell-context";
import { cn } from "@/shared/lib";

// Dark fixed sidebar (RTL: pinned to the right). Renders the ONE navigation
// manifest, filtering each item by the user's capability AND its optional server
// flag. Active state comes from the URL via NavLink. Collapsible to an icon rail.
export function Sidebar() {
  const { user } = useAuth();
  const { can } = usePermissions();
  const flags = useServerFlags();
  const { collapsed, toggleCollapsed } = useShell();
  const initials = (user?.name || user?.username || "؟").slice(0, 2);

  const groups = NAV.map((group) => ({
    ...group,
    items: group.items.filter(
      (item) => (!item.cap || can(item.cap)) && (!item.flag || flags[item.flag] === true),
    ),
  })).filter((group) => group.items.length > 0);

  return (
    <aside
      className={cn(
        "no-print fixed inset-y-0 right-0 z-30 hidden flex-col bg-navy px-3 pb-5 pt-4 text-white transition-[width] lg:flex",
        collapsed ? "w-20" : "w-72",
      )}
      aria-label="الشريط الجانبي"
    >
      <div className={cn("flex items-center gap-3 px-1 py-3", collapsed && "justify-center")}>
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-teal-600 text-white shadow-lg shadow-black/20">
          <LayoutGrid className="h-5 w-5" />
        </span>
        {!collapsed && (
          <div className="min-w-0">
            <div className="truncate text-base font-extrabold">المذاق المغربي</div>
            <div className="mt-0.5 text-[11px] font-bold text-slate-400">الإدارة الموحّدة</div>
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={toggleCollapsed}
        aria-label={collapsed ? "توسيع الشريط الجانبي" : "طي الشريط الجانبي"}
        aria-pressed={collapsed}
        className="mb-2 mt-1 flex min-h-9 items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 px-2 text-[11px] font-bold text-slate-300 transition hover:bg-white/10 hover:text-white"
      >
        {collapsed ? <ChevronsLeft className="h-4 w-4" /> : <><ChevronsRight className="h-4 w-4" /> طي القائمة</>}
      </button>

      <nav className="mt-2 flex-1 overflow-y-auto pl-1 scrollbar-thin" aria-label="التنقل الرئيسي">
        {groups.map((group) => (
          <div key={group.id} className="mb-4">
            {!collapsed && (
              <div className="mb-2 px-3 text-[10px] font-extrabold tracking-wider text-slate-500">{group.label}</div>
            )}
            <div className="space-y-1">
              {group.items.map((item) => {
                const Icon = getIcon(item.icon);
                return (
                  <NavLink
                    key={item.id}
                    to={item.path}
                    end
                    title={collapsed ? item.label : undefined}
                    className={({ isActive }) =>
                      cn("nav-item", collapsed && "justify-center px-0", isActive && "nav-item-active")
                    }
                  >
                    <Icon className="h-[18px] w-[18px] shrink-0" />
                    {!collapsed && <span className="flex-1 truncate">{item.label}</span>}
                  </NavLink>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className={cn("rounded-2xl border border-white/10 bg-white/5 p-3", collapsed && "px-2")}>
        <div className={cn("flex items-center gap-3", collapsed && "justify-center")}>
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-saffron-500 text-sm font-extrabold uppercase text-white">
            {initials}
          </span>
          {!collapsed && (
            <>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-extrabold">{user?.name || user?.username || "زائر"}</div>
                <div className="text-[10px] font-bold text-slate-400">{user?.role ? roleLabel(String(user.role)) : "غير مسجّل"}</div>
              </div>
              <MoreHorizontal className="h-4 w-4 text-slate-500" />
            </>
          )}
        </div>
      </div>
    </aside>
  );
}

function roleLabel(role: string): string {
  const map: Record<string, string> = {
    admin: "مدير النظام",
    developer: "مطوّر",
    manager: "مشرف",
    employee: "موظف",
    custody: "أمين عهدة",
    cashier: "كاشير",
    auditor: "مدقق",
    sales: "مندوب مبيعات",
    accountant: "محاسب",
    finance: "مالية",
  };
  return map[role] || role;
}
