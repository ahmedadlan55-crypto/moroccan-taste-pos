// الرئيسية لمسؤول العهدة — the home screen for an account that holds custody
// and is NOT an attendance employee.
//
// The employee home leads with today's clock state, because that is what an
// employee opens this app for. A custody officer opens it to see their
// balance. Showing them "you haven't clocked in yet" every morning is not a
// cosmetic flaw: it tells a person who never clocks in that they are late.
import { ChevronLeft, Wallet } from "lucide-react";
import { Card, ErrorState, LoadingState, Stat, StatGrid } from "@/components/ui";
import { useT } from "@/i18n";
import { useCustody } from "@/lib/queries";
import { formatMoney } from "@/lib/format";
import type { PageId } from "@/components/Shell";
import type { PortalSession } from "@/lib/api";

export function CustodyHome({ session, onNavigate }: { session: PortalSession; onNavigate: (page: PageId) => void }) {
  const t = useT();
  // Only rendered for a session the server flagged as custody, so always on.
  const custody = useCustody(true);
  // `{ error, noCustody: true }` at HTTP 200 is a known absence, not a failure.
  const data = custody.data && !custody.data.noCustody ? custody.data.custody ?? null : null;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <p className="text-sm font-extrabold text-slate-900">
          {t("home.greeting", { name: session.fullName || session.username })}
        </p>
        <p className="mt-1 text-[11px] font-bold text-slate-400">{t("home.custodyIntro")}</p>
      </Card>

      <button
        type="button"
        onClick={() => onNavigate("custody")}
        className="surface btn-press flex items-center gap-3 px-4 py-4 text-start"
      >
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-teal-50 text-teal-700">
          <Wallet className="h-6 w-6" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[11px] font-bold text-slate-400">{t("custody.balance")}</span>
          <span className="num block truncate text-sm font-extrabold text-slate-900">
            {custody.isLoading ? t("common.loading") : data ? formatMoney(data.balance) : t("custody.noCustody")}
          </span>
        </span>
        <ChevronLeft className="h-4 w-4 shrink-0 text-slate-300 rtl:rotate-180" aria-hidden />
      </button>

      <Card title={t("custody.title")}>
        {custody.isLoading ? (
          <LoadingState />
        ) : custody.isError ? (
          <ErrorState error={custody.error} onRetry={() => void custody.refetch()} />
        ) : !data ? (
          <p className="text-[11px] font-bold text-slate-400">{t("custody.noCustodyHint")}</p>
        ) : (
          <StatGrid>
            <Stat label={t("custody.topups")} value={formatMoney(data.totalTopups)} tone="good" />
            <Stat label={t("custody.expenses")} value={formatMoney(data.totalExpenses)} tone="bad" />
          </StatGrid>
        )}
      </Card>
    </div>
  );
}
