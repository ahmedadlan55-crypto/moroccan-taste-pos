/**
 * Header — brand, cashier identity (with branch), shift chip, connection
 * indicator, safe cashier switch, and a link back to the main system. Secondary
 * controls (sync report, PWA install/update, legacy drain) collapse into a
 * «more» menu under the sm breakpoint.
 */
import { useSyncExternalStore, useState } from "react";
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

/** PWA install button + «نسخة جديدة» update action + legacy-queue drain chip. */
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

/**
 * «more» menu (⋯) — visible only under the sm breakpoint. Collects the
 * secondary header controls with FULL Arabic labels (space isn't constrained
 * inside the menu the way it is in the bar): the connection/sync report, the
 * PWA install + update actions, and the legacy-drain report when pending.
 * Native-ish popover: a controlled panel + a full-screen backdrop to dismiss.
 */
const MENU_ITEM =
  "btn-press flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-start text-xs font-bold text-slate-600 hover:bg-slate-100";

function MoreMenu({
  onOpenSyncReport,
  onOpenDrainReport,
}: {
  onOpenSyncReport: () => void;
  onOpenDrainReport?: () => void;
}) {
  const pwa = useSyncExternalStore(subscribePwa, getPwaStatus);
  const drain = useSyncExternalStore(subscribeDrain, getDrainStatus);
  const [open, setOpen] = useState(false);
  const drainPending = drain.pending > 0 || (drain.outcome != null && drain.outcome.failed.length > 0);

  return (
    <div className="relative sm:hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="المزيد"
        title="المزيد"
        className="btn-press flex min-h-11 items-center justify-center rounded-xl px-3 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
      >
        <MoreHorizontal className="h-5 w-5" aria-hidden />
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
          <div role="menu" className="absolute end-0 z-50 mt-1 w-60 rounded-xl border border-slate-200 bg-white p-1 shadow-lift">
            <button role="menuitem" className={MENU_ITEM} onClick={() => { setOpen(false); onOpenSyncReport(); }}>
              <Wifi className="h-4 w-4 shrink-0" aria-hidden />
              تقرير الاتصال والمزامنة
            </button>
            {drainPending && onOpenDrainReport ? (
              <button role="menuitem" className={MENU_ITEM} onClick={() => { setOpen(false); onOpenDrainReport(); }}>
                <Inbox className="h-4 w-4 shrink-0" aria-hidden />
                عمليات الكاشير القديم (<span className="num">{fmtInt(drain.pending)}</span>)
              </button>
            ) : null}
            {pwa.updateReady ? (
              <button role="menuitem" className={MENU_ITEM} onClick={() => { setOpen(false); applyUpdate(); }}>
                <RefreshCw className="h-4 w-4 shrink-0" aria-hidden />
                تحديث إلى نسخة جديدة
              </button>
            ) : null}
            {pwa.canInstall ? (
              <button role="menuitem" className={MENU_ITEM} onClick={() => { setOpen(false); void promptInstall(); }}>
                <DownloadCloud className="h-4 w-4 shrink-0" aria-hidden />
                تثبيت التطبيق على الجهاز
              </button>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
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

  return (
    <header className="flex flex-wrap items-center gap-2 border-b border-slate-200/80 bg-white/90 px-3 py-2 shadow-sm backdrop-blur sm:px-4">
      {/* Brand */}
      <div className="flex items-center gap-2.5">
        <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-ink text-saffron-500 shadow-sm">
          <ChefHat className="h-6 w-6" aria-hidden />
        </div>
        <div className="leading-tight">
          <p className="text-sm font-extrabold text-ink">المذاق المغربي</p>
          <p className="text-[11px] font-bold text-slate-400">كاشير V2</p>
        </div>
      </div>

      {/* Cashier identity — username, role, and (when the catalog resolved it)
          the branch name so the cashier can see which outlet they're selling in. */}
      <div className="ms-1 hidden items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 sm:flex">
        <UserRound className="h-4 w-4 text-slate-400" aria-hidden />
        <div className="leading-tight">
          <p className="text-xs font-extrabold text-slate-700">{user?.username}</p>
          <p className="text-[10px] font-bold text-slate-400">{ROLE_LABELS[user?.role ?? ""] ?? user?.role}</p>
        </div>
        {branchName ? (
          <span className="ms-1 flex items-center gap-1 border-s border-slate-200 ps-2 text-[10px] font-bold text-slate-500">
            <MapPin className="h-3.5 w-3.5 text-slate-400" aria-hidden />
            {branchName}
          </span>
        ) : null}
      </div>

      <div className="ms-auto flex flex-wrap items-center gap-2">
        {/* Shift chip */}
        {shiftLoading ? (
          <span className="chip min-h-11 border-slate-200 bg-slate-50 px-3 text-xs text-slate-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            الوردية…
          </span>
        ) : shiftId ? (
          <button
            type="button"
            onClick={onOpenShiftDialog}
            title="تفاصيل الوردية / الإغلاق"
            className="chip btn-press min-h-11 border-teal-200 bg-teal-50 px-3 text-xs text-teal-700"
          >
            وردية <span className="num">{shiftId.replace(/^SH-/, "")}</span>
          </button>
        ) : (
          <span className="flex items-center gap-1.5">
            <span className="chip min-h-11 border-amber-300 bg-amber-50 px-3 text-xs text-amber-800">لا وردية</span>
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

        {/* فواتيري — legacy reaches this from the cashier action menu
            (public/pos/app.js:4357). Same function, same shift scope. */}
        <Button size="sm" variant="secondary" onClick={onOpenMyInvoices} title="فواتير الوردية الحالية">
          <FileText className="h-3.5 w-3.5" aria-hidden />
          فواتيري
        </Button>

        <StaleCatalogChip />
        {/* PWA install/update + drain chip: inline from sm up; collapsed into the
            «more» menu below the sm breakpoint. */}
        <div className="hidden items-center gap-2 sm:flex">
          <PwaControls onOpenDrainReport={onOpenDrainReport} />
        </div>

        {/* Connectivity indicator stays in the bar at all times. */}
        <ConnectionIndicator onOpenReport={onOpenSyncReport} />

        {/* «more» menu — mobile-only overflow for the secondary controls. */}
        <MoreMenu onOpenSyncReport={onOpenSyncReport} onOpenDrainReport={onOpenDrainReport} />

        {/* Inventory launchers — stocktake (جرد) + shortage requests (النواقص) */}
        <button
          type="button"
          onClick={onOpenStocktake}
          title="جرد المخزون"
          className="btn-press flex min-h-11 items-center gap-1.5 rounded-xl px-3 text-xs font-bold text-slate-500 hover:bg-slate-100 hover:text-slate-700"
        >
          <ClipboardCheck className="h-4 w-4" aria-hidden />
          <span className="hidden sm:inline">جرد المخزون</span>
        </button>
        <button
          type="button"
          onClick={onOpenRequisitions}
          title="طلب النواقص والاستلام"
          className="btn-press flex min-h-11 items-center gap-1.5 rounded-xl px-3 text-xs font-bold text-slate-500 hover:bg-slate-100 hover:text-slate-700"
        >
          <PackageSearch className="h-4 w-4" aria-hidden />
          <span className="hidden sm:inline">طلب النواقص</span>
        </button>

        <nav className="flex items-center gap-1">
          {/* Safe cashier switch — hands over via the close flow if a shift is
              open (App enforces it) before clearing the session. */}
          {onSwitchCashier ? (
            <button
              type="button"
              onClick={onSwitchCashier}
              title="تبديل الكاشير — يتطلب إغلاق الوردية المفتوحة أولًا"
              className="btn-press flex min-h-11 items-center gap-1.5 rounded-xl px-3 text-xs font-bold text-slate-500 hover:bg-slate-100 hover:text-slate-700"
            >
              <Repeat className="h-3.5 w-3.5" aria-hidden />
              تبديل الكاشير
            </button>
          ) : null}
          <a
            href="/"
            className="btn-press flex min-h-11 items-center gap-1.5 rounded-xl px-3 text-xs font-bold text-slate-500 hover:bg-slate-100 hover:text-slate-700"
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            العودة للنظام الرئيسي
          </a>
        </nav>
      </div>
    </header>
  );
}
