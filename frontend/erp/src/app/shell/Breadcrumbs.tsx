import { useLocation } from "react-router-dom";
import { ChevronLeft } from "lucide-react";
import { navByPath, navGroupOf } from "@/app/navigation/manifest";

// Breadcrumb trail derived from the manifest: «المجموعة › الشاشة». RTL, so the
// chevron points left (toward the next crumb). Falls back gracefully when the
// current path has no manifest entry (deep sub-routes added later).
export function Breadcrumbs() {
  const { pathname } = useLocation();
  const item = navByPath(pathname);
  const group = item ? navGroupOf(item) : undefined;

  return (
    <nav aria-label="مسار التنقل" className="flex items-center gap-1.5 text-[11px] font-bold text-slate-400">
      <span>الإدارة الموحّدة</span>
      {group && (
        <>
          <ChevronLeft className="h-3 w-3" aria-hidden="true" />
          <span>{group.label}</span>
        </>
      )}
      {item && (
        <>
          <ChevronLeft className="h-3 w-3" aria-hidden="true" />
          <span className="text-slate-600">{item.label}</span>
        </>
      )}
    </nav>
  );
}
