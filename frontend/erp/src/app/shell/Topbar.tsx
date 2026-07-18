import { useEffect, useState } from "react";
import { SlidersHorizontal, X } from "lucide-react";
import { useLocation } from "react-router-dom";
import { navByPath } from "@/app/navigation/manifest";
import { Breadcrumbs } from "./Breadcrumbs";
import { GlobalSearch } from "./GlobalSearch";
import { CompanyBranchSelect } from "./CompanyBranchSelect";
import { NotificationCenter } from "./NotificationCenter";
import { ApprovalsInbox } from "./ApprovalsInbox";
import { UserMenu } from "./UserMenu";
import { useShell } from "./shell-context";
import { cn } from "@/shared/lib";

// The single top bar: ONE page title (from the route), breadcrumbs, global
// search (⌘K), company/branch scope, notifications, approvals and the user menu.
// No duplicate page title — the module content shows its group header + body,
// never a second copy of this screen title.
export function Topbar() {
  const { pathname } = useLocation();
  const { collapsed } = useShell();
  const [mobileToolsOpen, setMobileToolsOpen] = useState(false);
  const title = navByPath(pathname)?.label ?? "الإدارة الموحّدة";

  useEffect(() => {
    setMobileToolsOpen(false);
  }, [pathname]);

  return (
    <header
      className={cn(
        "no-print sticky top-0 z-20 border-b border-slate-200/80 bg-canvas/95 px-4 py-2.5 backdrop-blur-xl transition-[margin] sm:px-6 xl:px-8",
        collapsed ? "lg:mr-20" : "lg:mr-72",
      )}
    >
      <div className="mx-auto max-w-[1680px]">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-extrabold text-slate-900">{title}</h1>
            <div className="mt-0.5 hidden sm:block">
              <Breadcrumbs />
            </div>
          </div>

          {/* Wide desktop: keep the complete labels visible instead of shrinking
              the scope selects into clipped native controls. */}
          <div className="hidden items-center gap-2 2xl:flex">
            <GlobalSearch />
            <CompanyBranchSelect />
          </div>

          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
            <button
              type="button"
              className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-xs font-extrabold text-slate-600 shadow-sm transition hover:border-slate-300 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100 2xl:hidden"
              aria-label={mobileToolsOpen ? "إغلاق البحث ونطاق العمل" : "فتح البحث ونطاق العمل"}
              aria-expanded={mobileToolsOpen}
              aria-controls="mobile-shell-tools"
              onClick={() => setMobileToolsOpen((open) => !open)}
            >
              {mobileToolsOpen ? <X className="h-4 w-4" /> : <SlidersHorizontal className="h-4 w-4" />}
              <span className="hidden sm:inline">البحث والنطاق</span>
            </button>
            <NotificationCenter />
            <ApprovalsInbox />
            <UserMenu />
          </div>
        </div>

        {/* Mobile/laptop: full-width search + scope row. At these widths a
            deliberate second row is clearer than three compressed controls. */}
        {mobileToolsOpen && (
          <div
            id="mobile-shell-tools"
            className="mt-2.5 grid gap-2 border-t border-slate-200/70 pt-2.5 2xl:hidden md:grid-cols-[minmax(0,1fr)_minmax(22rem,1fr)]"
          >
            <GlobalSearch />
            <CompanyBranchSelect fullWidth />
          </div>
        )}
      </div>
    </header>
  );
}
