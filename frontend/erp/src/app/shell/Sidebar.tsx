import { useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import {
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  LayoutGrid,
  MoreHorizontal,
} from "lucide-react";
import { NAV, canAccessNavItem } from "@/app/navigation/manifest";
import { useAuth, usePermissions } from "@/app/providers";
import { useServerFlags } from "@/app/server-flags";
import { useLang, useT } from "@/i18n";
import { getIcon } from "./icons";
import { useShell } from "./shell-context";
import { cn } from "@/shared/lib";

/** Roles that have a translated label (shell.roles.*) — any OTHER role string
 *  on the user record is shown as-is, preserving the original `map[role] ?? role`
 *  fallback. */
const KNOWN_ROLE_KEYS = [
  "admin",
  "developer",
  "manager",
  "employee",
  "custody",
  "cashier",
  "auditor",
  "sales",
  "accountant",
  "finance",
] as const;

/**
 * Section-first navigation: the expanded sidebar shows one clear business
 * section at a time, while the collapsed rail shows one icon per section rather
 * than the former wall of more than one hundred route icons.
 */
export function Sidebar() {
  const t = useT();
  const lang = useLang();
  const { pathname } = useLocation();
  const { user } = useAuth();
  const { can } = usePermissions();
  const flags = useServerFlags();
  const { collapsed, toggleCollapsed } = useShell();
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const initials = (user?.name || user?.username || "؟").slice(0, 2);

  // Directional rail chevrons flip with the writing direction: in RTL the
  // sidebar is pinned to the (right) start edge, in LTR to the (left) start
  // edge, so the collapse/expand arrows must point the matching way.
  const RailCollapsed = lang === "ar" ? ChevronsLeft : ChevronsRight;
  const RailExpanded = lang === "ar" ? ChevronsRight : ChevronsLeft;

  const groups = NAV.map((group) => ({
    ...group,
    items: group.items.filter(
      (item) => canAccessNavItem(item, can) && (!item.flag || flags[item.flag] === true),
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
        "no-print fixed inset-y-0 start-0 z-30 hidden flex-col bg-navy px-3 pb-5 pt-4 text-white transition-[width] lg:flex",
        collapsed ? "w-20" : "w-72",
      )}
      aria-label={t("shell.sidebar.ariaLabel")}
    >
      <div className={cn("flex items-center gap-3 px-1 py-3", collapsed && "justify-center")}>
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-teal-600 text-white shadow-lg shadow-black/20">
          <LayoutGrid className="h-5 w-5" />
        </span>
        {!collapsed && (
          <div className="min-w-0">
            <div className="truncate text-base font-bold">{t("shell.brand.name")}</div>
            <div className="mt-0.5 text-xs font-medium text-slate-400">{t("shell.brand.tagline")}</div>
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={toggleCollapsed}
        aria-label={collapsed ? t("shell.sidebar.expandRail") : t("shell.sidebar.collapseRail")}
        aria-pressed={collapsed}
        className="mb-2 mt-1 flex min-h-11 items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 px-2 text-xs font-medium text-slate-300 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-400/30"
      >
        {collapsed ? (
          <RailCollapsed className="h-4 w-4" />
        ) : (
          <>
            <RailExpanded className="h-4 w-4" />
            {t("shell.sidebar.collapse")}
          </>
        )}
      </button>

      <nav className="scrollbar-thin mt-2 flex-1 overflow-y-auto pe-1" aria-label={t("shell.sidebar.nav")}>
        {collapsed ? (
          <div className="space-y-1.5">
            {groups.map((group) => {
              const Icon = getIcon(group.items[0].icon);
              const active = activeGroupId === group.id;
              const groupLabel = t(group.label);
              return (
                <NavLink
                  key={group.id}
                  to={group.items[0].path}
                  title={groupLabel}
                  aria-label={groupLabel}
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
              const groupLabel = t(group.label);
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
                      aria-label={groupLabel}
                      onClick={() => setOpenGroup(group.id)}
                      className="flex min-w-0 flex-1 items-center gap-3 rounded-s-xl px-3 text-start"
                    >
                      <GroupIcon className={cn("h-[18px] w-[18px] shrink-0", active && "text-teal-300")} />
                      <span className="min-w-0 flex-1 truncate">{groupLabel}</span>
                      <span className="rounded-full bg-white/5 px-2 py-0.5 text-[11px] font-medium text-slate-400">
                        {group.items.length}
                      </span>
                    </NavLink>
                    <button
                      type="button"
                      onClick={() => setOpenGroup(expanded ? null : group.id)}
                      className="grid w-11 shrink-0 place-items-center rounded-e-xl text-slate-400 transition hover:bg-white/10 hover:text-white"
                      aria-label={t(expanded ? "shell.sidebar.collapseGroup" : "shell.sidebar.expandGroup", { group: groupLabel })}
                      aria-expanded={expanded}
                      aria-controls={`nav-group-${group.id}`}
                    >
                      <ChevronDown className={cn("h-4 w-4 transition-transform", expanded && "rotate-180")} />
                    </button>
                  </div>

                  {expanded && (
                    <div
                      id={`nav-group-${group.id}`}
                      className="mt-1 space-y-1 border-s border-white/10 ps-2"
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
                            <span className="flex-1 truncate">{t(item.label)}</span>
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
                <div className="truncate text-sm font-semibold">{user?.name || user?.username || t("shell.identity.guest")}</div>
                <div className="text-xs font-medium text-slate-400">
                  {user?.role ? roleLabel(String(user.role), t) : t("shell.identity.unregistered")}
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

/** Translate a known role via shell.roles.*, else show the raw role string. */
function roleLabel(role: string, t: ReturnType<typeof useT>): string {
  return (KNOWN_ROLE_KEYS as readonly string[]).includes(role) ? t(`shell.roles.${role}`) : role;
}
