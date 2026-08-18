// العهدة — the custody holder's own balance, expenses and top-ups.
//
// This is «بوابة العهدة», the second app deleted in e97ebfbf, folded in as a tab
// rather than restored as a third install: it is one screen, its audience is a
// handful of custody holders, and every one of them is already an employee with
// this app on their phone.
//
// ACCESS, STATED PLAINLY: /api/custody is mounted behind
// requireRole('admin','manager','custody') in server.js. The `custody_portal`
// flag alone does NOT open it — an account with the flag but a plain `employee`
// role is refused by that middleware, and this screen must not pretend
// otherwise. The tab is therefore hidden unless the server declared
// custodyPortal at login (Shell.visibleTabs), and a 403 that slips through
// still renders as the honest refusal below rather than an empty screen.
//
// READ-ONLY, deliberately. Filing an expense means an amount, a VAT split, a GL
// account and an invoice photo — a form that belongs on the ERP's custody page
// where it already exists and is already tested. Restoring visibility is the
// gap that mattered: a custody holder had no way to see their own balance.
import { Card, EmptyState, ErrorState, LoadingState, Badge, Stat, StatGrid, statusTone } from "@/components/ui";
import { useStatusLabel, useT } from "@/i18n";
import { useCustody } from "@/lib/queries";
import { formatDate, formatMoney } from "@/lib/format";
import { ApiError } from "@/lib/api";
import type { PortalSession } from "@/lib/api";

export function CustodyPage({ session }: { session: PortalSession | null }) {
  const t = useT();
  const statusLabel = useStatusLabel();
  const query = useCustody(!!session?.custodyPortal);

  const data = query.data;
  const forbidden = query.error instanceof ApiError && query.error.status === 403;

  if (query.isLoading) {
    return (
      <Card>
        <LoadingState />
      </Card>
    );
  }

  if (forbidden || !session?.custodyPortal) {
    return (
      <Card>
        <EmptyState message={t("custody.notAllowed")} />
      </Card>
    );
  }

  if (query.isError) {
    return (
      <Card>
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </Card>
    );
  }

  // `{ error, noCustody:true }` at HTTP 200 — a known absence, not a failure.
  if (!data?.custody) {
    return (
      <Card>
        <div className="flex flex-col items-center gap-1 py-8 text-center">
          <p className="text-sm font-extrabold text-slate-600">{t("custody.noCustody")}</p>
          <p className="text-[11px] font-bold text-slate-400">{t("custody.noCustodyHint")}</p>
        </div>
      </Card>
    );
  }

  const custody = data.custody;
  const expenses = data.expenses ?? [];
  const topups = data.topups ?? [];

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="mb-4 flex flex-col items-center gap-1 text-center">
          <span className="text-[11px] font-bold text-slate-500">{t("custody.balance")}</span>
          <span className="num text-3xl font-extrabold text-teal-700">
            {formatMoney(custody.balance)}
          </span>
          <span className="text-[11px] font-bold text-slate-400">{t("common.riyal")}</span>
          <div className="mt-1 flex items-center gap-2">
            <span className="num text-[11px] font-bold text-slate-400">{custody.custodyNumber}</span>
            <Badge tone={statusTone(custody.status)}>{statusLabel(custody.status)}</Badge>
          </div>
        </div>

        <StatGrid>
          <Stat label={t("custody.topups")} value={formatMoney(custody.totalTopups)} tone="good" />
          <Stat label={t("custody.expenses")} value={formatMoney(custody.totalExpenses)} tone="bad" />
        </StatGrid>
      </Card>

      <Card title={t("custody.expenseList")} bodyClassName="px-0 py-0">
        {expenses.length === 0 ? (
          <EmptyState message={t("custody.noExpenses")} />
        ) : (
          <ul>
            {expenses.map((e) => (
              <li
                key={String(e.id)}
                className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3 last:border-b-0"
              >
                <div className="min-w-0">
                  <p className="truncate text-xs font-extrabold text-slate-800">
                    {e.description || "—"}
                  </p>
                  <p className="num mt-0.5 text-[11px] font-bold text-slate-400">
                    {formatDate(e.expenseDate)}
                    {e.glAccountName ? ` · ${e.glAccountName}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <span className="num text-sm font-extrabold text-slate-900">
                    {formatMoney(e.totalWithVat ?? e.amount)}
                  </span>
                  {e.status && <Badge tone={statusTone(e.status)}>{statusLabel(e.status)}</Badge>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={t("custody.topupList")} bodyClassName="px-0 py-0">
        {topups.length === 0 ? (
          <EmptyState message={t("custody.noTopups")} />
        ) : (
          <ul>
            {topups.map((tp) => (
              <li
                key={String(tp.id)}
                className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3 last:border-b-0"
              >
                <div className="min-w-0">
                  <p className="num text-xs font-extrabold text-slate-800">{formatDate(tp.createdAt)}</p>
                  {tp.notes && (
                    <p className="mt-0.5 truncate text-[11px] font-bold text-slate-400">{tp.notes}</p>
                  )}
                </div>
                <span className="num shrink-0 text-sm font-extrabold text-emerald-600">
                  +{formatMoney(tp.amount)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
