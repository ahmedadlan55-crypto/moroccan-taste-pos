import { NavLink } from "react-router-dom";
import { navItems } from "@/app/navigation";
import { usePermissions } from "@/app/permission-provider";
import { cn } from "@/lib/cn";

// Fixed bottom nav for phones — the first 5 permitted sections. Touch targets
// ≥44px, English digits not applicable here.
export function MobileNav() {
  const { can } = usePermissions();
  const items = navItems.filter((i) => can(i.cap)).slice(0, 5);

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-30 flex items-stretch justify-around border-t border-slate-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden no-print"
      aria-label="التنقّل"
    >
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <NavLink
            key={item.id}
            to={item.path}
            className={({ isActive }) =>
              cn(
                "flex min-h-14 flex-1 flex-col items-center justify-center gap-1 px-1 py-2 text-[11px] font-bold transition",
                isActive ? "text-teal-600" : "text-slate-400 hover:text-slate-600",
              )
            }
          >
            <Icon className="h-5 w-5" />
            <span className="truncate">{item.label}</span>
          </NavLink>
        );
      })}
    </nav>
  );
}
