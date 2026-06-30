import { useNavigate } from "react-router-dom";
import { Bell, Menu, RefreshCw } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { flatNav } from "@/app/navigation";
import { WarehouseScopeSelect } from "@/components/warehouse-scope/WarehouseScopeSelect";
import { Button } from "@/components/ui/button";

export function Topbar() {
  const navigate = useNavigate();
  const qc = useQueryClient();

  return (
    <header className="no-print sticky top-0 z-20 border-b border-slate-200/80 bg-canvas/90 px-4 py-3 backdrop-blur-xl sm:px-6 lg:mr-72 xl:px-8">
      <div className="mx-auto max-w-[1680px]">
        <div className="flex items-center gap-3">
          {/* Mobile/tablet: menu + route picker */}
          <div className="flex min-w-0 items-center gap-2 lg:hidden">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-slate-950 text-white">
              <Menu className="h-5 w-5" />
            </span>
            <select
              className="field max-w-40"
              aria-label="اختيار الشاشة"
              onChange={(e) => navigate(e.target.value)}
              defaultValue=""
            >
              <option value="" disabled>
                انتقال…
              </option>
              {flatNav.map((item) => (
                <option key={item.id} value={item.path}>
                  {item.label}
                </option>
              ))}
            </select>
          </div>

          {/* Desktop: scope inline */}
          <div className="hidden lg:block">
            <WarehouseScopeSelect />
          </div>

          <div className="mr-auto flex items-center gap-1">
            <Button variant="ghost" size="icon" aria-label="تحديث" onClick={() => qc.invalidateQueries()}>
              <RefreshCw className="h-5 w-5" />
            </Button>
            <div className="relative">
              <Button variant="ghost" size="icon" aria-label="التنبيهات">
                <Bell className="h-5 w-5" />
              </Button>
              <span className="absolute left-1 top-1 grid h-4 min-w-4 place-items-center rounded-full border-2 border-canvas bg-rose-500 px-0.5 text-[8px] font-extrabold text-white">
                9
              </span>
            </div>
          </div>
        </div>

        {/* Mobile/tablet: a dedicated full-width row so the CURRENT warehouse
            scope name is always clearly visible (and changeable) on phones. */}
        <div className="mt-2.5 lg:hidden">
          <WarehouseScopeSelect fullWidth />
        </div>
      </div>
    </header>
  );
}
