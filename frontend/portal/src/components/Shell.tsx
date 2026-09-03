// The app shell: a header, the active screen, and a fixed bottom tab bar.
//
// Bottom tabs, not a drawer, and not the ERP's sidebar: the portal has six
// destinations and is used one-handed while standing up. The tab bar is the
// same shape the original PWA used (public/employee/index.html → nav.bnav), so
// muscle memory carries over for staff who had the old app installed.
import React from "react";
import { CalendarDays, Clock, Fingerprint, Home, User, Wallet } from "lucide-react";
import { cn } from "@/lib/cn";
import { useLang, useSetLang, useT } from "@/i18n";
import type { PortalSession } from "@/lib/api";

export type PageId = "home" | "clock" | "hours" | "leave" | "profile" | "custody";

interface TabDef {
  id: PageId;
  labelKey: string;
  Icon: typeof Home;
}

const HOME_TAB: TabDef = { id: "home", labelKey: "nav.home", Icon: Home };
// Attendance: what an EMPLOYEE opens this app for.
const ATTENDANCE_TABS: TabDef[] = [
  { id: "clock", labelKey: "nav.clock", Icon: Fingerprint },
  { id: "hours", labelKey: "nav.hours", Icon: Clock },
  { id: "leave", labelKey: "nav.leave", Icon: CalendarDays },
];
const PROFILE_TAB: TabDef = { id: "profile", labelKey: "nav.profile", Icon: User };
const CUSTODY_TAB: TabDef = { id: "custody", labelKey: "nav.custody", Icon: Wallet };

/**
 * The tab bar is BUILT from the two flags the server declared at login.
 *
 *   employee  → home · clock · hours · leave · profile
 *   custody   → home · custody · profile
 *   both      → home · clock · hours · leave · custody · profile
 *
 * Before, the five attendance tabs were unconditional and custody was a sixth
 * bolted on — so a custody officer, who never clocks in, opened an app that
 * led with a fingerprint button. The flags are the admin's decision about
 * what this person does; the bar follows them.
 *
 * The custody tab still appears only for an account the SERVER says holds
 * custody access — /api/custody is guarded by role OR the custody flag, and
 * showing the tab to anyone else puts a 403 one tap away.
 */
export function visibleTabs(session: PortalSession | null): TabDef[] {
  if (!session) return [HOME_TAB, ...ATTENDANCE_TABS, PROFILE_TAB];
  const attendance = session.employeePortal !== false;
  const custody = session.custodyPortal === true;
  return [
    HOME_TAB,
    ...(attendance ? ATTENDANCE_TABS : []),
    ...(custody ? [CUSTODY_TAB] : []),
    PROFILE_TAB,
  ];
}

/** True for an account that holds custody but is NOT an attendance employee. */
export function isCustodyOnly(session: PortalSession | null): boolean {
  return !!session && session.custodyPortal === true && session.employeePortal === false;
}

export function Shell({
  session,
  page,
  onNavigate,
  header,
  children,
}: {
  session: PortalSession | null;
  page: PageId;
  onNavigate: (page: PageId) => void;
  header?: React.ReactNode;
  children: React.ReactNode;
}) {
  const t = useT();
  const lang = useLang();
  const setLang = useSetLang();
  const tabs = visibleTabs(session);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="safe-top sticky top-0 z-40 border-b border-slate-200/70 bg-white/90 backdrop-blur">
        <div className="mx-auto flex w-full max-w-lg items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-extrabold text-slate-900">
              {t(`nav.${page}`)}
            </p>
            <p className="truncate text-[11px] font-bold text-slate-400">
              {session?.fullName || session?.username || t("app.company")}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {header}
            <button
              type="button"
              onClick={() => setLang(lang === "ar" ? "en" : "ar")}
              className="rounded-lg px-2 py-1.5 text-xs font-extrabold text-slate-500 hover:bg-slate-100"
            >
              {t("common.language")}
            </button>
          </div>
        </div>
      </header>

      {/* pb-24: the tab bar is fixed, so the last card would otherwise sit
          underneath it and be unreachable at the bottom of a scroll. */}
      <main className="mx-auto w-full max-w-lg flex-1 px-4 pb-24 pt-4">{children}</main>

      <nav
        aria-label={t("app.title")}
        className="safe-bottom fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white"
      >
        <div className="mx-auto flex w-full max-w-lg">
          {tabs.map(({ id, labelKey, Icon }) => {
            const active = id === page;
            return (
              <button
                key={id}
                type="button"
                onClick={() => onNavigate(id)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "btn-press flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 px-1 py-1.5",
                  active ? "text-teal-700" : "text-slate-400",
                )}
              >
                <Icon className="h-5 w-5" aria-hidden />
                <span className="truncate text-[10px] font-extrabold">{t(labelKey)}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
