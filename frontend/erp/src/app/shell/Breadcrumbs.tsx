import { useLocation } from "react-router-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { navByPath, navGroupOf } from "@/app/navigation/manifest";
import { useLang, useT } from "@/i18n";

/** Compact route context. The routed page owns the only visible H1. */
export function Breadcrumbs() {
  const t = useT();
  const lang = useLang();
  const { pathname } = useLocation();
  const item = navByPath(pathname);
  const group = item ? navGroupOf(item) : undefined;

  // The separator points in the reading direction: left in RTL, right in LTR.
  const Chevron = lang === "ar" ? ChevronLeft : ChevronRight;

  return (
    <nav
      aria-label={t("shell.breadcrumbs.ariaLabel")}
      className="flex min-w-0 items-center gap-1.5 overflow-hidden text-xs font-medium text-slate-500 sm:text-[13px]"
    >
      <span className="hidden shrink-0 sm:inline">{t("shell.brand.tagline")}</span>
      {group && (
        <>
          <Chevron className="hidden h-3.5 w-3.5 shrink-0 sm:block" aria-hidden="true" />
          <span className="hidden shrink-0 md:inline">{t(group.label)}</span>
        </>
      )}
      {item && (
        <>
          <Chevron className="hidden h-3.5 w-3.5 shrink-0 md:block" aria-hidden="true" />
          <span className="truncate font-semibold text-slate-700">{t(item.label)}</span>
        </>
      )}
    </nav>
  );
}
