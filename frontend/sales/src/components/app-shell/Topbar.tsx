import { useLocation } from "react-router-dom";
import { RefreshCw, Store, UserCircle2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { navItems } from "@/app/navigation";
import { useAuth } from "@/app/auth-provider";
import { qk } from "@/lib/query-keys";

// Sticky top bar: the active section title, a refresh action (invalidates the
// O2C cache), a quick «فتح الكاشير», and the current user chip.
export function Topbar() {
  const location = useLocation();
  const qc = useQueryClient();
  const { user } = useAuth();

  const active = navItems.find((i) => location.pathname.startsWith(i.path));
  const title = active?.label ?? "المبيعات والعملاء";

  return (
    <header className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-slate-200 bg-white/90 px-4 py-3 backdrop-blur lg:mr-72 lg:px-6 no-print">
      <h1 className="truncate text-lg font-extrabold text-slate-900">{title}</h1>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => qc.invalidateQueries({ queryKey: qk.all })}
          className="grid h-10 w-10 place-items-center rounded-xl border border-slate-200 text-slate-500 transition hover:bg-slate-50 hover:text-slate-800"
          aria-label="تحديث"
          title="تحديث البيانات"
        >
          <RefreshCw className="h-[18px] w-[18px]" />
        </button>
        <a
          href="/pos-v2"
          className="hidden min-h-10 items-center gap-2 rounded-xl bg-amber-500 px-3 text-sm font-extrabold text-slate-900 transition hover:bg-amber-400 sm:inline-flex"
        >
          <Store className="h-4 w-4" /> فتح الكاشير
        </a>
        <span className="flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-1.5">
          <UserCircle2 className="h-5 w-5 text-slate-400" />
          <span className="max-w-28 truncate text-sm font-bold text-slate-700">{user?.name || user?.username || "مستخدم"}</span>
        </span>
      </div>
    </header>
  );
}
