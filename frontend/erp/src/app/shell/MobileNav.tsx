import { NavLink } from "react-router-dom";
import { NAV_ITEMS, canAccessNavItem } from "@/app/navigation/manifest";
import { usePermissions } from "@/app/providers";
import { useServerFlags } from "@/app/server-flags";
import { useT } from "@/i18n";
import { getIcon } from "./icons";
import { cn } from "@/shared/lib";

// Bottom nav for phones — the first 5 items the user is permitted to see.
export function MobileNav() {
  const t = useT();
  const { can } = usePermissions();
  const flags = useServerFlags();
  const items = NAV_ITEMS.filter(
    (i) => canAccessNavItem(i, can) && (!i.flag || flags[i.flag] === true),
  ).slice(0, 5);

  return (
    <nav
      className="no-print fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-40 mx-auto flex max-w-lg items-center justify-around rounded-2xl border border-slate-200 bg-white/95 p-1.5 shadow-lift backdrop-blur lg:hidden"
      aria-label={t("shell.mobileNav.ariaLabel")}
    >
      {items.map((item) => {
        const Icon = getIcon(item.icon);
        return (
          <NavLink
            key={item.id}
            to={item.path}
            end
            className={({ isActive }) =>
              cn(
                "flex min-h-12 min-w-14 flex-col items-center justify-center gap-1 rounded-xl px-1 text-[10px] font-extrabold transition",
                isActive ? "bg-slate-950 text-white" : "text-slate-500 hover:bg-slate-100",
              )
            }
          >
            <Icon className="h-4 w-4" />
            <span className="max-w-[3.5rem] truncate">{t(item.label)}</span>
          </NavLink>
        );
      })}
    </nav>
  );
}
