/**
 * Header — brand, cashier identity, shift chip, connection indicator,
 * links back to the main system and the legacy cashier.
 */
import { ChefHat, ClipboardCheck, CloudOff, ExternalLink, History, Loader2, PackageSearch, UserRound, Wifi } from "lucide-react";
import { usePos } from "@/state/store";
import { fmtInt } from "@/lib/format";
import { cn, Button } from "./ui";

const ROLE_LABELS: Record<string, string> = {
  admin: "مدير النظام",
  manager: "مدير",
  cashier: "كاشير",
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

export function Header({
  onOpenShiftDialog,
  onOpenSyncReport,
  onOpenStocktake,
  onOpenRequisitions,
}: {
  onOpenShiftDialog: () => void;
  onOpenSyncReport: () => void;
  onOpenStocktake: () => void;
  onOpenRequisitions: () => void;
}) {
  const { user, shiftId, shiftLoading, engineStatus, openShiftNow, openingShift } = usePos();

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

      {/* Cashier identity */}
      <div className="ms-1 hidden items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 sm:flex">
        <UserRound className="h-4 w-4 text-slate-400" aria-hidden />
        <div className="leading-tight">
          <p className="text-xs font-extrabold text-slate-700">{user?.username}</p>
          <p className="text-[10px] font-bold text-slate-400">{ROLE_LABELS[user?.role ?? ""] ?? user?.role}</p>
        </div>
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
            <Button
              size="sm"
              variant="saffron"
              onClick={openShiftNow}
              loading={openingShift}
              disabled={!engineStatus.online}
              title={engineStatus.online ? "فتح وردية جديدة" : "فتح الوردية يتطلب اتصالًا بالخادم"}
            >
              فتح وردية
            </Button>
          </span>
        )}

        <ConnectionIndicator onOpenReport={onOpenSyncReport} />

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
          <a
            href="/"
            className="btn-press flex min-h-11 items-center gap-1.5 rounded-xl px-3 text-xs font-bold text-slate-500 hover:bg-slate-100 hover:text-slate-700"
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            العودة للنظام الرئيسي
          </a>
          <a
            href="/pos/"
            className="btn-press flex min-h-11 items-center gap-1.5 rounded-xl px-3 text-xs font-bold text-slate-500 hover:bg-slate-100 hover:text-slate-700"
          >
            <History className="h-3.5 w-3.5" aria-hidden />
            الكاشير القديم
          </a>
        </nav>
      </div>
    </header>
  );
}
