import { useLocation } from "react-router-dom";
import { Construction } from "lucide-react";
import { navByPath, navGroupOf } from "@/app/navigation/manifest";
import { getIcon } from "./icons";

// The foundation placeholder rendered by every not-yet-built module. It shows a
// PageHeader with the GROUP label (the screen title itself lives once in the
// Topbar — no duplicate) and a clean "قيد النقل" empty state. Domain agents
// overwrite src/modules/<module>/index.tsx with the real routed pages; the lazy
// route + manifest entry stay unchanged.
export function ModulePlaceholder() {
  const { pathname } = useLocation();
  const item = navByPath(pathname);
  const group = item ? navGroupOf(item) : undefined;
  const Icon = item ? getIcon(item.icon) : Construction;

  return (
    <div className="space-y-5">
      <header className="flex items-center gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-teal-50 text-teal-700">
          <Icon className="h-5 w-5" />
        </span>
        <div>
          <h2 className="text-xl font-extrabold text-slate-900">{group?.label ?? "الإدارة الموحّدة"}</h2>
          <p className="mt-0.5 text-[12px] font-bold text-slate-400">الواجهة الموحّدة — نظام ADLAN</p>
        </div>
      </header>

      <div className="surface grid place-items-center gap-3 p-12 text-center">
        <div className="grid h-14 w-14 place-items-center rounded-2xl bg-slate-100 text-slate-500">
          <Construction className="h-6 w-6" aria-hidden="true" />
        </div>
        <div className="text-base font-extrabold text-slate-800">قيد النقل</div>
        <p className="max-w-md text-sm font-medium text-slate-500">
          {item ? `شاشة «${item.label}» ` : "هذه الشاشة "}
          قيد النقل إلى الواجهة الموحّدة الجديدة، وستُفعَّل قريبًا ضمن نظام ADLAN.
        </p>
      </div>
    </div>
  );
}

export default ModulePlaceholder;
