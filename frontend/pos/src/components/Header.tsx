/**
 * Header — brand, cashier identity (with branch), shift chip, connection
 * indicator, safe cashier switch, and a link back to the main system. Secondary
 * controls (sync report, PWA install/update, legacy drain, cashier switch)
 * collapse into a «more» menu under the sm breakpoint.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AlertTriangle, ChefHat, ClipboardCheck, CloudOff, DownloadCloud, ExternalLink, FileText, Inbox, Loader2, MapPin, MoreHorizontal, PackageSearch, RefreshCw, Repeat, UserRound, Wifi } from "lucide-react";
import { usePos } from "@/state/store";
import { fmtInt } from "@/lib/format";
import { getPwaStatus, subscribePwa, promptInstall, applyUpdate } from "@/lib/pwa";
import { getDrainStatus, subscribeDrain } from "@/lib/legacyDrain";
import { cn, Button } from "./ui";

const ROLE_LABELS: Record<string, string> = {
  admin: "مدير النظام",
  manager: "مدير",
  cashier: "كاشير",
  custody: "أمين عهدة",
  employee: "موظف",
  accountant: "محاسب",
  finance: "مالية",
  sales: "مبيعات",
};

export function ConnectionIndicator({ onOpenReport }: { onOpenReport: () => void }) {
  const { engineStatus } = usePos();
  const { online, syncing, queueCount } = engineStatus;

  let cls: string;
  let label: React.ReactNode;
  if (syncing) {
    cls = "border-sky-200 bg-sky-50 text-sky-700";
    label = (
      <>
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        جارٍ المزامنة
      </>
    );
  } else if (online) {
    cls = "border-teal-200 bg-teal-50 text-teal-700";
    label = (
      <>
        <Wifi className="h-3.5 w-3.5" aria-hidden />
        متصل
        {queueCount > 0 ? <span className="num">({fmtInt(queueCount)})</span> : null}
      </>
    );
  } else {
    cls = "border-amber-300 bg-amber-50 text-amber-800";
    label = (
      <>
        <CloudOff className="h-3.5 w-3.5" aria-hidden />
        غير متصل
        {queueCount > 0 ? (
          <span className="num" title="عمليات بانتظار المزامنة">
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
      title="عرض تقرير المزامنة"
      className={cn("chip btn-press min-h-11 cursor-pointer px-3 text-xs", cls)}
    >
      {label}
    </button>
  );
}

/** Humanises a cache age for the cashier — "٣ ساعات", "يومان", never raw ms. */
function humanAge(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return "أقل من ساعة";
  if (h < 24) return `${h} ساعة`;
  const d = Math.floor(h / 24);
  return d === 1 ? "يوم" : d === 2 ? "يومان" : `${d} أيام`;
}

/**
 * Stale-catalog warning. The cashier keeps selling — that is deliberate, an
 * outage must never stop the till — but they are told the price list could not
 * be confirmed, and how old it is. Previously this was completely silent.
 */
export function StaleCatalogChip() {
  const { catalogStale, catalogAgeMs, refetchCatalog, engineStatus } = usePos();
  if (!catalogStale) return null;
  const age = catalogAgeMs == null ? "غير معروف" : humanAge(catalogAgeMs);
  return (
    <button
      type="button"
      onClick={refetchCatalog}
      disabled={!engineStatus.online}
      title={
        engineStatus.online
          ? "قائمة الأصناف غير مؤكَّدة — اضغط لإعادة التحميل"
          : "قائمة الأصناف محفوظة محليًا ولم يتم تأكيدها — ستُحدَّث عند عودة الاتصال"
      }
      className="chip btn-press min-h-11 border-amber-300 bg-amber-50 px-3 text-xs font-bold text-amber-800"
    >
      <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
      قائمة قديمة ({age})
    </button>
  );
}

/** PWA install button + «نسخة جديدة» update action + migration-queue status. */
export function PwaControls({ onOpenDrainReport }: { onOpenDrainReport?: () => void }) {
  const pwa = useSyncExternalStore(subscribePwa, getPwaStatus);
  const drain = useSyncExternalStore(subscribeDrain, getDrainStatus);
  return (
    <>
      {drain.pending > 0 || (drain.outcome && drain.outcome.failed.length > 0) ? (
        <button
          type="button"
          onClick={onOpenDrainReport}
          title="عمليات من الكاشير القديم بانتظار المزامنة"
          className="chip btn-press min-h-11 cursor-pointer border-amber-300 bg-amber-50 px-3 text-xs text-amber-800"
        >
          {drain.state === "running" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <Inbox className="h-3.5 w-3.5" aria-hidden />
          )}
          قديم <span className="num">({fmtInt(drain.pending)})</span>
        </button>
      ) : null}
      {pwa.updateReady ? (
        <Button size="sm" variant="saffron" onClick={applyUpdate} title="توفرت نسخة جديدة من التطبيق">
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          نسخة جديدة — تحديث
        </Button>
      ) : null}
      {pwa.canInstall ? (
        <Button size="sm" variant="secondary" onClick={() => void promptInstall()} title="تثبيت الكاشير كتطبيق على هذا الجهاز">
          <DownloadCloud className="h-3.5 w-3.5" aria-hidden />
          تثبيت التطبيق
        </Button>
      ) : null}
    </>
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
  const { user, shiftId, shiftLoading, engineStatus, catalog } = usePos();
  const branchName = catalog?.identity?.branchName || catalog?.identity?.branchCompanyName || "";
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
            <p className="truncate text-sm font-extrabold text-ink">المذاق المغربي</p>
            <p className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] font-bold text-slate-500">
              <UserRound className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
              <span className="truncate" data-testid="cashier-identity">{user?.username || "مستخدم غير معروف"}</span>
              <span aria-hidden>·</span>
              <span className="shrink-0 text-slate-400">{ROLE_LABELS[user?.role ?? ""] ?? user?.role ?? "كاشير"}</span>
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
            الوردية…
          </span>
        ) : shiftId ? (
          <button
            type="button"
            onClick={onOpenShiftDialog}
            title="تفاصيل الوردية / الإغلاق"
            className="chip btn-press min-h-11 max-w-32 border-teal-200 bg-teal-50 px-2.5 text-xs text-teal-700 sm:max-w-none sm:px-3"
          >
            وردية <span className="num">{shiftId.replace(/^SH-/, "")}</span>
          </button>
        ) : (
          <span className="flex min-w-0 items-center gap-1">
            <span className="hidden min-h-11 items-center rounded-xl border border-amber-300 bg-amber-50 px-2 text-xs font-bold text-amber-800 min-[430px]:inline-flex">لا وردية</span>
            {/* Opening a shift MUST go through the full ShiftDialog so the cashier
                enters the opening float — never a header quick-open that would
                bypass the float screen and record a 0 float silently. */}
            <Button
              size="sm"
              variant="saffron"
              onClick={onOpenShiftDialog}
              disabled={!engineStatus.online}
              title={engineStatus.online ? "فتح وردية جديدة" : "فتح الوردية يتطلب اتصالًا بالخادم"}
            >
              فتح وردية
            </Button>
          </span>
        )}
        </div>
      </div>

      {/* Operational actions use a deterministic 2×2 mobile grid. Primary action
          labels are never hidden; secondary/system actions live under المزيد. */}
      <div
        className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:ms-auto lg:max-w-[44rem]"
        data-testid="pos-quick-actions"
        aria-label="إجراءات الكاشير السريعة"
      >
        <Button className="min-w-0 px-2" size="sm" variant="secondary" onClick={onOpenMyInvoices} title="فواتير الوردية الحالية">
          <FileText className="h-3.5 w-3.5" aria-hidden />
          <span>فواتيري</span>
        </Button>
        <button
          type="button"
          onClick={onOpenStocktake}
          title="جرد المخزون"
          className="btn-press flex min-h-11 min-w-0 items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white px-2 text-xs font-bold text-slate-700 shadow-sm hover:border-slate-300 hover:bg-slate-50"
        >
          <ClipboardCheck className="h-4 w-4" aria-hidden />
          <span>جرد المخزون</span>
        </button>
        <button
          type="button"
          onClick={onOpenRequisitions}
          title="طلب النواقص والاستلام"
          className="btn-press flex min-h-11 min-w-0 items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white px-2 text-xs font-bold text-slate-700 shadow-sm hover:border-slate-300 hover:bg-slate-50"
        >
          <PackageSearch className="h-4 w-4" aria-hidden />
          <span>طلب النواقص</span>
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
            <span>المزيد</span>
          </button>
          {moreOpen && <div role="menu" className="absolute end-0 top-full z-50 mt-2 grid w-[min(20rem,calc(100vw-1.5rem))] gap-2 rounded-2xl border border-slate-200 bg-white p-3 shadow-lift">
            <p className="text-[11px] font-extrabold text-slate-400">حالة الجهاز والنظام</p>
            <ConnectionIndicator onOpenReport={onOpenSyncReport} />
            <StaleCatalogChip />
            <div className="grid gap-2 [&>button]:w-full">
              <PwaControls onOpenDrainReport={onOpenDrainReport} />
            </div>
            {onSwitchCashier ? (
              <button
                type="button"
                onClick={() => { setMoreOpen(false); onSwitchCashier(); }}
                title="تبديل الكاشير — يتطلب إغلاق الوردية المفتوحة أولًا"
                className="btn-press flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 text-xs font-bold text-slate-600 hover:bg-slate-50 hover:text-slate-800"
              >
                <Repeat className="h-3.5 w-3.5" aria-hidden />
                تبديل الكاشير
              </button>
            ) : null}
            <a
              href="/app/"
              className="btn-press flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 text-xs font-bold text-slate-600 hover:bg-slate-50 hover:text-slate-800"
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              العودة للنظام الرئيسي
            </a>
          </div>}
        </div>
      </div>
    </header>
  );
}
