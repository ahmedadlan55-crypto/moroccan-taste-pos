// The app root: session gate, tab router, and the two ambient banners
// (install / new version).
//
// There is no router library. The portal has six flat destinations reached only
// from a tab bar — no deep links, no nested routes, no URL an employee types.
// A route table would be ceremony around `useState<PageId>`.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, RefreshCw, X } from "lucide-react";
import { Shell, visibleTabs, isCustodyOnly, type PageId } from "@/components/Shell";
import { Login } from "@/components/Login";
import { HomePage } from "@/pages/HomePage";
import { ClockPage } from "@/pages/ClockPage";
import { HoursPage } from "@/pages/HoursPage";
import { LeavePage } from "@/pages/LeavePage";
import { ProfilePage } from "@/pages/ProfilePage";
import { CustodyPage } from "@/pages/CustodyPage";
import { CustodyHome } from "@/pages/CustodyHome";
import { useT } from "@/i18n";
import { getSession, type PortalSession } from "@/lib/api";
import { logout } from "@/lib/auth";
import { initPwa, isIos, isStandalone } from "@/lib/pwa";
import { useQueryClient } from "@tanstack/react-query";

const pwa = initPwa();

export function App() {
  const t = useT();
  const qc = useQueryClient();
  const [session, setSession] = useState<PortalSession | null>(() => getSession());
  const [page, setPage] = useState<PageId>("home");
  const [updateReady, setUpdateReady] = useState(false);
  const [installReady, setInstallReady] = useState(() => pwa.canInstall());
  const [installDismissed, setInstallDismissed] = useState(false);

  useEffect(() => {
    pwa.onUpdateAvailable(() => setUpdateReady(true));
    pwa.onInstallAvailable(() => setInstallReady(true));
  }, []);

  const onSignOut = useCallback(() => {
    logout();
    // Clear the cache, not just the session: react-query would otherwise hand
    // the NEXT person to sign in on this device the previous employee's
    // payslips and attendance from memory before the first refetch lands.
    qc.clear();
    setSession(null);
    setPage("home");
  }, [qc]);

  const onSignedIn = useCallback((next: PortalSession) => {
    setSession(next);
    setPage("home");
  }, []);

  // A tab that disappears must not leave the app on a blank screen: if the
  // signed-in account has no custody access, fall back to home.
  const tabs = useMemo(() => visibleTabs(session), [session]);
  useEffect(() => {
    if (!tabs.some((tab) => tab.id === page)) setPage("home");
  }, [tabs, page]);

  if (!session) return <Login onSignedIn={onSignedIn} />;

  return (
    <Shell session={session} page={page} onNavigate={setPage}>
      {updateReady && (
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="btn-press mb-4 flex w-full items-center justify-center gap-2 rounded-xl border border-teal-200 bg-teal-50 px-3 py-2.5 text-xs font-extrabold text-teal-800"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          {t("common.newVersion")} — {t("common.update")}
        </button>
      )}

      <InstallBanner
        show={!installDismissed && !isStandalone() && (installReady || isIos())}
        onDismiss={() => setInstallDismissed(true)}
      />

      {page === "home" && (isCustodyOnly(session) ? <CustodyHome session={session} onNavigate={setPage} /> : <HomePage onNavigate={setPage} />)}
      {page === "clock" && <ClockPage session={session} />}
      {page === "hours" && <HoursPage />}
      {page === "leave" && <LeavePage />}
      {page === "profile" && <ProfilePage onSignOut={onSignOut} />}
      {page === "custody" && <CustodyPage session={session} />}
    </Shell>
  );
}

/**
 * The install invitation — the whole reason this is a separate app rather than
 * an ERP route. iOS never fires `beforeinstallprompt`, so there it is written
 * instructions instead of a button; anywhere else it replays the deferred event.
 */
function InstallBanner({ show, onDismiss }: { show: boolean; onDismiss: () => void }) {
  const t = useT();
  if (!show) return null;

  const ios = isIos();

  return (
    <div className="mb-4 flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2.5">
      <Download className="h-4 w-4 shrink-0 text-teal-600" aria-hidden />
      {ios ? (
        <span className="min-w-0 flex-1 text-[11px] font-bold text-slate-600">
          {t("common.installHintIos")}
        </span>
      ) : (
        <button
          type="button"
          onClick={() => void pwa.promptInstall().then(onDismiss)}
          className="min-w-0 flex-1 text-start text-xs font-extrabold text-slate-700"
        >
          {t("common.install")}
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t("common.close")}
        className="shrink-0 rounded-lg p-1 text-slate-400 hover:bg-slate-100"
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}
