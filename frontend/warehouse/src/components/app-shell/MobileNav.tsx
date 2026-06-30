import { NavLink } from "react-router-dom";
import { LayoutDashboard, Boxes, Truck, FileBarChart } from "lucide-react";
import { cn } from "@/lib/cn";

const ITEMS = [
  { path: "/", label: "الرئيسية", icon: LayoutDashboard },
  { path: "/inventory", label: "المخزون", icon: Boxes },
  { path: "/transfers", label: "الحركة", icon: Truck },
  { path: "/reports", label: "التقارير", icon: FileBarChart },
];

export function MobileNav() {
  return (
    <nav
      className="no-print fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-40 flex items-center justify-around rounded-2xl border border-slate-200 bg-white/95 p-1.5 shadow-2xl backdrop-blur lg:hidden"
      aria-label="تنقل سريع"
    >
      {ITEMS.map((item) => (
        <NavLink
          key={item.path}
          to={item.path}
          end={item.path === "/"}
          className={({ isActive }) =>
            cn(
              "flex min-h-12 min-w-16 flex-col items-center justify-center gap-1 rounded-xl text-[10px] font-extrabold transition",
              isActive ? "bg-slate-950 text-white" : "text-slate-500 hover:bg-slate-100",
            )
          }
        >
          <item.icon className="h-4 w-4" />
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}
