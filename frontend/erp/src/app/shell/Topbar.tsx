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
  const title = navByPath(pathname)?.label ?? "الإدارة الموحّدة";

  return (
    <header
      className={cn(
        "no-print sticky top-0 z-20 border-b border-slate-200/80 bg-canvas/90 px-4 py-3 backdrop-blur-xl transition-[margin] sm:px-6 xl:px-8",
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

          {/* Desktop: search + scope inline */}
          <div className="hidden items-center gap-2 lg:flex">
            <GlobalSearch />
            <CompanyBranchSelect />
          </div>

          <div className="flex items-center gap-2">
            <NotificationCenter />
            <ApprovalsInbox />
            <UserMenu />
          </div>
        </div>

        {/* Mobile/tablet: full-width search + scope row */}
        <div className="mt-2.5 flex flex-col gap-2 lg:hidden">
          <GlobalSearch />
          <CompanyBranchSelect fullWidth />
        </div>
      </div>
    </header>
  );
}
