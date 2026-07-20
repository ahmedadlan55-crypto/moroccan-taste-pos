/**
 * Header — brand, cashier identity (with branch), shift chip, connection
 * indicator, safe cashier switch, and a link back to the main system. Secondary
 * controls (sync report, PWA install/update, legacy drain, cashier switch)
 * collapse into a «more» menu under the sm breakpoint.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AlertTriangle, ChefHat, ClipboardCheck, CloudOff, DownloadCloud, ExternalLink, FileText, Inbox, Languages, Loader2, MapPin, MoreHorizontal, PackageSearch, RefreshCw, Repeat, UserRound, Wifi } from "lucide-react";
import { usePos } from "@/state/store";
import { fmtInt } from "@/lib/format";
import { getPwaStatus, subscribePwa, promptInstall, applyUpdate } from "@/lib/pwa";
import { getDrainStatus, subscribeDrain } from "@/lib/legacyDrain";
import { useLang, useSetLang, useT } from "../i18n";
import { cn, Button } from "./ui";

/** Keys that have a translated role label (header.roles.*) — any OTHER role
 *  string on the user record is shown as-is (never silently dropped), same
 *  as the original ROLE_LABELS[role] ?? role fallback behaviour. */
const KNOWN_ROLE_KEYS = ["admin", "manager", "cashier", "custody", "employee", "accountant", "finance", "sales"] as const;

export function ConnectionIndicator({ onOpenReport }: { onOpenReport: () => void }) {
  const t = useT();
  const { engineStatus } = usePos();
  const { online, syncing, queueCount } = engineStatus;

  let cls: string;
  let label: React.ReactNode;
  if (syncing) {
    cls = "border-sky-200 bg-sky-50 text-sky-700";
    label = (
      <>
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        {t("header.connection.syncing")}
      </>
    );
  } else if (online) {
    cls = "border-teal-200 bg-teal-50 text-teal-700";
    label = (
      <>
        <Wifi className="h-3.5 w-3.5" aria-hidden />
        {t("header.connection.online")}
        {queueCount > 0 ? <span className="num">({fmtInt(queueCount)})</span> : null}
      </>
    );
  } else {
    cls = "border-amber-300 bg-amber-50 text-amber-800";
    label = (
      <>
        <CloudOff className="h-3.5 w-3.5" aria-hidden />
        {t("header.connection.offline")}
        {queueCount > 0 ? (
          <span className="num" title={t("header.connection.queueTitle")}>
            ({fmtInt(queueCount)})
          </span>
        ) : null}
      </>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpenReport}
      title={t("header.connection.reportTitle")}
      className={cn("chip btn-press min-h-11 cursor-pointer px-3 text-xs", cls)}
    >
      {label}
    </button>
  );
}

/** ms → whole hours. Pure unit conversion only — the day-bucketing branch
 *  (1 يوم / يومان / N أيام) lives in the dictionary's header.staleAge()
 *  function, since it is inseparable from the chosen string per language. */
function msToHours(ms: number): number {
  return Math.floor(ms / 3_600_000);
}

/**
 * Stale-catalog warning. The cashier keeps selling — that is deliberate, an
 * outage must never stop the till — but they are told the price list could not
 * be confirmed, and how old it is. Previously this was completely silent.
 */
export function StaleCatalogChip() {
  const t = useT();
  const { catalogStale, catalogAgeMs, refetchCatalog, engineStatus } = usePos();
  if (!catalogStale) return null;
  const age = catalogAgeMs == null ? t("header.staleCatalog.unknownAge") : t("header.staleAge", { count: msToHours(catalogAgeMs) });
  return (
    <button
      type="button"
      onClick={refetchCatalog}
      disabled={!engineStatus.online}
      title={engineStatus.online ? t("header.staleCatalog.titleOnline") : t("header.staleCatalog.titleOffline")}
      className="chip btn-press min-h-11 border-amber-300 bg-amber-50 px-3 text-xs font-bold text-amber-800"
    >
      <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
      {t("header.staleCatalog.label")} ({age})
    </button>
  );
}

/** PWA install button + «نسخة جديدة» update action + migration-queue status. */
export function PwaControls({ onOpenDrainReport }: { onOpenDrainReport?: () => void }) {
  const t = useT();
  const pwa = useSyncExternalStore(subscribePwa, getPwaStatus);
  const drain = useSyncExternalStore(subscribeDrain, getDrainStatus);
  return (
    <>
      {drain.pending > 0 || (drain.outcome && drain.outcome.failed.length > 0) ? (
        <button
          type="button"
          onClick={onOpenDrainReport}
          title={t("header.pwa.drainTitle")}
          className="chip btn-press min-h-11 cursor-pointer border-amber-300 bg-amber-50 px-3 text-xs text-amber-800"
        >
          {drain.state === "running" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <Inbox className="h-3.5 w-3.5" aria-hidden />
          )}
          {t("header.pwa.legacyLabel")} <span className="num">({fmtInt(drain.pending)})</span>
        </button>
      ) : null}
      {pwa.updateReady ? (
        <Button size="sm" variant="saffron" onClick={applyUpdate} title={t("header.pwa.updateTitle")}>
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          {t("header.pwa.updateAction")}
        </Button>
      ) : null}
      {pwa.canInstall ? (
        <Button size="sm" variant="secondary" onClick={() => void promptInstall()} title={t("header.pwa.installTitle")}>
          <DownloadCloud className="h-3.5 w-3.5" aria-hidden />
          {t("header.pwa.installAction")}
        </Button>
      ) : null}
    </>
  );
}

/** Min-44px language toggle chip — switches ar↔en. Lives inside the «more»
 *  panel per the i18n plan; label always names the language you'll switch
 *  TO (kept in its own script in both dictionaries, so it stays recognisable
 *  regardless of the current UI language). */
function LanguageToggle() {
  const t = useT();
  const lang = useLang();
  const setLang = useSetLang();
  const nextLang = lang === "ar" ? "en" : "ar";
  return (
    <button
      type="button"
      onClick={() => setLang(nextLang)}
      title={t("header.languageToggle.ariaLabel")}
      aria-label={t("header.languageToggle.ariaLabel")}
      className="btn-press flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 text-xs font-bold text-slate-600 hover:bg-slate-50 hover:text-slate-800"
    >
      <Languages className="h-3.5 w-3.5" aria-hidden />
      {lang === "ar" ? t("header.languageToggle.switchToEnglish") : t("header.languageToggle.switchToArabic")}
    </button>
  );
}

export function Header({
  onOpenShiftDialog,
  onOpenSyncReport,
  onOpenMyInvoices,
  onOpenStocktake,
  onOpenRequisitions,
  onOpenDrainReport,
  onSwitchCashier,
}: {
  onOpenShiftDialog: () => void;
  onOpenSyncReport: () => void;
  onOpenMyInvoices: () => void;
  onOpenStocktake: () => void;
  onOpenRequisitions: () => void;
  onOpenDrainReport?: () => void;
  /** Safe cashier switch — App checks for an open shift and routes through the
   *  close flow before it clears the token. */
  onSwitchCashier?: () => void;
}) {
  const t = useT();
  const { user, shiftId, shiftLoading, engineStatus, catalog } = usePos();
  const branchName = catalog?.identity?.branchName || catalog?.identity?.branchCompanyName || "";
  // Real brand name comes from the owner-configured seller identity (rides in
  // the catalog payload, so it's available offline too — see ReceiptIdentity
  // in lib/types.ts). Only when that's empty/unresolved do we fall back to
  // the dictionary string instead of the old hardcoded literal.
  const brandName = catalog?.identity?.brandName || t("header.brandFallback");
  const role = user?.role;
  const roleLabel = role && (KNOWN_ROLE_KEYS as readonly string[]).includes(role) ? t(`header.roles.${role}`) : role || t("header.roleFallback");
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!moreOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(event.target as Node)) setMoreOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMoreOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [moreOpen]);

  return (
    <header className="relative z-30 border-b border-slate-200/80 bg-white/95 px-3 py-2 shadow-sm backdrop-blur sm:px-4" data-testid="pos-header">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
        {/* Brand + cashier identity stay visible at every supported width. */}
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-ink text-saffron-500 shadow-sm">
            <ChefHat className="h-6 w-6" aria-hidden />
          </div>
          <div className="min-w-0 leading-tight">
            <p className="truncate text-sm font-extrabold text-ink">{brandName}</p>
            <p className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] font-bold text-slate-500">
              <UserRound className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
              <span className="truncate" data-testid="cashier-identity">{user?.username || t("header.unknownUser")}</span>
              <span aria-hidden>·</span>
              <span className="shrink-0 text-slate-400">{roleLabel}</span>
              {branchName ? (
                <>
                  <span aria-hidden>·</span>
                  <span className="flex shrink-0 items-center gap-0.5 truncate">
                    <MapPin className="h-3 w-3 shrink-0 text-slate-400" aria-hidden />
                    <span className="truncate">{branchName}</span>
                  </span>
                </>
              ) : null}
            </p>
          </div>
        </div>

        {/* Shift status has a reserved cell, so it never competes with actions. */}
        <div className="flex min-w-0 justify-end">
        {shiftLoading ? (
          <span className="chip min-h-11 border-slate-200 bg-slate-50 px-2.5 text-xs text-slate-400 sm:px-3">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            {t("header.shift.loading")}
          </span>
        ) : shiftId ? (
          <button
            type="button"
            onClick={onOpenShiftDialog}
            title={t("header.shift.detailsTitle")}
            className="chip btn-press min-h-11 max-w-32 border-teal-200 bg-teal-50 px-2.5 text-xs text-teal-700 sm:max-w-none sm:px-3"
          >
            {t("header.shift.chipLabel")} <span className="num">{shiftId.replace(/^SH-/, "")}</span>
          </button>
        ) : (
          <span className="flex min-w-0 items-center gap-1">
            <span className="hidden min-h-11 items-center rounded-xl border border-amber-300 bg-amber-50 px-2 text-xs font-bold text-amber-800 min-[430px]:inline-flex">{t("header.shift.none")}</span>
            {/* Opening a shift MUST go through the full ShiftDialog so the cashier
                enters the opening float — never a header quick-open that would
                bypass the float screen and record a 0 float silently. */}
            <Button
              size="sm"
              variant="saffron"
              onClick={onOpenShiftDialog}
              disabled={!engineStatus.online}
              title={engineStatus.online ? t("header.shift.openTitle") : t("header.shift.openTitleOffline")}
            >
              {t("header.shift.openAction")}
            </Button>
          </span>
        )}
        </div>
      </div>

      {/* Operational actions use a deterministic 2×2 mobile grid. Primary action
          labels are never hidden; secondary/system actions live under the
          «more» menu (header.more.label). */}
      <div
        className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:ms-auto lg:max-w-[44rem]"
        data-testid="pos-quick-actions"
        aria-label={t("header.quickActions.ariaLabel")}
      >
        <Button className="min-w-0 px-2" size="sm" variant="secondary" onClick={onOpenMyInvoices} title={t("header.quickActions.myInvoicesTitle")}>
          <FileText className="h-3.5 w-3.5" aria-hidden />
          <span>{t("header.quickActions.myInvoices")}</span>
        </Button>
        <button
          type="button"
          onClick={onOpenStocktake}
          title={t("header.quickActions.stocktake")}
          className="btn-press flex min-h-11 min-w-0 items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white px-2 text-xs font-bold text-slate-700 shadow-sm hover:border-slate-300 hover:bg-slate-50"
        >
          <ClipboardCheck className="h-4 w-4" aria-hidden />
          <span>{t("header.quickActions.stocktake")}</span>
        </button>
        <button
          type="button"
          onClick={onOpenRequisitions}
          title={t("header.quickActions.requisitionsTitle")}
          className="btn-press flex min-h-11 min-w-0 items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white px-2 text-xs font-bold text-slate-700 shadow-sm hover:border-slate-300 hover:bg-slate-50"
        >
          <PackageSearch className="h-4 w-4" aria-hidden />
          <span>{t("header.quickActions.requisitions")}</span>
        </button>

        <div ref={moreRef} className="relative min-w-0">
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((open) => !open)}
            className="btn-press flex min-h-11 w-full items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white px-2 text-xs font-bold text-slate-700 shadow-sm hover:border-slate-300 hover:bg-slate-50"
          >
            <MoreHorizontal className="h-4 w-4" aria-hidden />
            <span>{t("header.more.label")}</span>
          </button>
          {moreOpen && <div role="menu" className="absolute end-0 top-full z-50 mt-2 grid w-[min(20rem,calc(100vw-1.5rem))] gap-2 rounded-2xl border border-slate-200 bg-white p-3 shadow-lift">
            <p className="text-[11px] font-extrabold text-slate-400">{t("header.more.systemStatusHeading")}</p>
            <ConnectionIndicator onOpenReport={onOpenSyncReport} />
            <StaleCatalogChip />
            <div className="grid gap-2 [&>button]:w-full">
              <PwaControls onOpenDrainReport={onOpenDrainReport} />
            </div>
            <LanguageToggle />
            {onSwitchCashier ? (
              <button
                type="button"
                onClick={() => { setMoreOpen(false); onSwitchCashier(); }}
                title={t("header.more.switchCashierTitle")}
                className="btn-press flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 text-xs font-bold text-slate-600 hover:bg-slate-50 hover:text-slate-800"
              >
                <Repeat className="h-3.5 w-3.5" aria-hidden />
                {t("header.more.switchCashier")}
              </button>
            ) : null}
            <a
              href="/app/"
              className="btn-press flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 text-xs font-bold text-slate-600 hover:bg-slate-50 hover:text-slate-800"
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              {t("header.more.backToSystem")}
            </a>
          </div>}
        </div>
      </div>
    </header>
  );
}
