import { useLocation } from "react-router-dom";
import { ChevronLeft } from "lucide-react";
import { navByPath, navGroupOf } from "@/app/navigation/manifest";

/** Compact route context. The routed page owns the only visible H1. */
export function Breadcrumbs() {
  const { pathname } = useLocation();
  const item = navByPath(pathname);
  const group = item ? navGroupOf(item) : undefined;

  return (
    <nav
      aria-label="مسار التنقل"
      className="flex min-w-0 items-center gap-1.5 overflow-hidden text-xs font-medium text-slate-500 sm:text-[13px]"
    >
      <span className="hidden shrink-0 sm:inline">الإدارة الموحّدة</span>
      {group && (
        <>
          <ChevronLeft className="hidden h-3.5 w-3.5 shrink-0 sm:block" aria-hidden="true" />
          <span className="hidden shrink-0 md:inline">{group.label}</span>
        </>
      )}
      {item && (
        <>
          <ChevronLeft className="hidden h-3.5 w-3.5 shrink-0 md:block" aria-hidden="true" />
          <span className="truncate font-semibold text-slate-700">{item.label}</span>
        </>
      )}
    </nav>
  );
}
