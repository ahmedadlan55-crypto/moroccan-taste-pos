import { useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import {
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  LayoutGrid,
  MoreHorizontal,
} from "lucide-react";
import { NAV } from "@/app/navigation/manifest";
import { useAuth, usePermissions } from "@/app/providers";
import { useServerFlags } from "@/app/server-flags";
import { getIcon } from "./icons";
import { useShell } from "./shell-context";
import { cn } from "@/shared/lib";

/**
 * Section-first navigation: the expanded sidebar shows one clear business
 * section at a time, while the collapsed rail shows one icon per section rather
 * than the former wall of more than one hundred route icons.
 */
export function Sidebar() {
  const { pathname } = useLocation();
  const { user } = useAuth();
  const { can } = usePermissions();
  const flags = useServerFlags();
  const { collapsed, toggleCollapsed } = useShell();
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const initials = (user?.name || user?.username || "؟").slice(0, 2);

  const groups = NAV.map((group) => ({
    ...group,
    items: group.items.filter(
      (item) => (!item.cap || can(item.cap)) && (!item.flag || flags[item.flag] === true),
    ),
  })).filter((group) => group.items.length > 0);

  const activeGroupId = groups.find((group) => group.items.some((item) => item.path === pathname))?.id;
  const firstGroupId = groups[0]?.id;

  useEffect(() => {
    if (activeGroupId) setOpenGroup(activeGroupId);
    else if (firstGroupId) setOpenGroup((current) => current ?? firstGroupId);
  }, [activeGroupId, firstGroupId]);

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
            <div className="truncate text-base font-bold">المذاق المغربي</div>
            <div className="mt-0.5 text-xs font-medium text-slate-400">الإدارة الموحّدة</div>
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={toggleCollapsed}
        aria-label={collapsed ? "توسيع الشريط الجانبي" : "طي الشريط الجانبي"}
        aria-pressed={collapsed}
        className="mb-2 mt-1 flex min-h-10 items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 px-2 text-xs font-medium text-slate-300 transition hover:bg-white/10 hover:text-white"
      >
        {collapsed ? (
          <ChevronsLeft className="h-4 w-4" />
        ) : (
          <>
            <ChevronsRight className="h-4 w-4" />
            طي القائمة
          </>
        )}
      </button>

      <nav className="scrollbar-thin mt-2 flex-1 overflow-y-auto pl-1" aria-label="التنقل الرئيسي">
        {collapsed ? (
          <div className="space-y-1.5">
            {groups.map((group) => {
              const Icon = getIcon(group.items[0].icon);
              const active = activeGroupId === group.id;
              return (
                <NavLink
                  key={group.id}
                  to={group.items[0].path}
                  title={group.label}
                  aria-label={group.label}
                  className={cn("nav-item justify-center px-0", active && "nav-item-active")}
                >
                  <Icon className="h-5 w-5" />
                </NavLink>
              );
            })}
          </div>
        ) : (
          <div className="space-y-2">
            {groups.map((group) => {
              const GroupIcon = getIcon(group.items[0].icon);
              const expanded = openGroup === group.id;
              const active = activeGroupId === group.id;
              return (
                <section key={group.id} className="rounded-2xl">
                  <div
                    className={cn(
                      "flex min-h-11 w-full items-stretch rounded-xl text-sm font-semibold text-slate-300 transition hover:bg-white/10 hover:text-white",
                      active && "bg-white/5 text-white",
                    )}
                  >
                    <NavLink
                      to={group.items[0].path}
                      aria-label={group.label}
                      onClick={() => setOpenGroup(group.id)}
                      className="flex min-w-0 flex-1 items-center gap-3 rounded-r-xl px-3 text-right"
                    >
                      <GroupIcon className={cn("h-[18px] w-[18px] shrink-0", active && "text-teal-300")} />
                      <span className="min-w-0 flex-1 truncate">{group.label}</span>
                      <span className="rounded-full bg-white/5 px-2 py-0.5 text-[11px] font-medium text-slate-400">
                        {group.items.length}
                      </span>
                    </NavLink>
                    <button
                      type="button"
                      onClick={() => setOpenGroup(expanded ? null : group.id)}
                      className="grid w-11 shrink-0 place-items-center rounded-l-xl text-slate-400 transition hover:bg-white/10 hover:text-white"
                      aria-label={`${expanded ? "طي" : "فتح"} صفحات ${group.label}`}
                      aria-expanded={expanded}
                      aria-controls={`nav-group-${group.id}`}
                    >
                      <ChevronDown className={cn("h-4 w-4 transition-transform", expanded && "rotate-180")} />
                    </button>
                  </div>

                  {expanded && (
                    <div
                      id={`nav-group-${group.id}`}
                      className="mt-1 space-y-1 border-r border-white/10 pr-2"
                    >
                      {group.items.map((item) => {
                        const Icon = getIcon(item.icon);
                        return (
                          <NavLink
                            key={item.id}
                            to={item.path}
                            end
                            className={({ isActive }) => cn("nav-item", isActive && "nav-item-active")}
                          >
                            <Icon className="h-[18px] w-[18px] shrink-0" />
                            <span className="flex-1 truncate">{item.label}</span>
                          </NavLink>
                        );
                      })}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </nav>

      <div className={cn("mt-3 rounded-2xl border border-white/10 bg-white/5 p-3", collapsed && "px-2")}>
        <div className={cn("flex items-center gap-3", collapsed && "justify-center")}>
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-saffron-500 text-sm font-bold uppercase text-white">
            {initials}
          </span>
          {!collapsed && (
            <>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">{user?.name || user?.username || "زائر"}</div>
                <div className="text-xs font-medium text-slate-400">
                  {user?.role ? roleLabel(String(user.role)) : "غير مسجّل"}
                </div>
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
