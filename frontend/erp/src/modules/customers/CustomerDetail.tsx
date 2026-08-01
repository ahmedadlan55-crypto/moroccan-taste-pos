import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, ArrowLeft, Printer, Wallet, CreditCard, Gauge, AlertTriangle, type LucideIcon } from "lucide-react";
import {
  Button, Card, CardHeader, CardTitle, CardBody, Dialog, PageHeader, LoadingState, ErrorState,
  PrintDocument,
} from "@/shared/ui";
import { cn, formatCurrency } from "@/shared/lib";
import { useT, useLang } from "@/i18n";
import { o2cApi, qk, SalesStatus, Money, Num, DateCell } from "@/modules/sales/lib";

// Aging buckets in display order. `current` is a translated word; the rest are
// dir-neutral numeric day-ranges kept as literals.
const AGING_BUCKETS = ["current", "d1_30", "d31_60", "d61_90", "d91_120", "d120_plus"] as const;
const AGING_RANGES: Record<string, string> = {
  d1_30: "1-30", d31_60: "31-60", d61_90: "61-90", d91_120: "91-120", d120_plus: "+120",
};

type MetricTone = "violet" | "blue" | "amber" | "teal" | "rose";
const METRIC_TONE: Record<MetricTone, string> = {
  violet: "bg-violet-50 text-violet-700",
  blue: "bg-sky-50 text-sky-700",
  amber: "bg-amber-50 text-amber-700",
  teal: "bg-teal-50 text-teal-700",
  rose: "bg-rose-50 text-rose-700",
};

function Metric({ label, value, note, icon: Icon, tone }: { label: string; value: ReactNode; note?: string; icon: LucideIcon; tone: MetricTone }) {
  return (
    <div className="surface flex items-center gap-3 p-4">
      <span className={cn("grid h-11 w-11 shrink-0 place-items-center rounded-xl", METRIC_TONE[tone])}>
        <Icon className="h-5 w-5" />
      </span>
      <div className="min-w-0">
        <div className="text-[11px] font-bold text-slate-400">{label}</div>
        <div className="text-lg font-extrabold text-slate-900">{value}</div>
        {note && <div className="text-[11px] font-semibold text-slate-400">{note}</div>}
      </div>
    </div>
  );
}

export function CustomerDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const t = useT();
  const lang = useLang();
  const nav = useNavigate();
  const [stmtOpen, setStmtOpen] = useState(false);
  // "Back" chevron points against the reading direction (end→start).
  const BackArrow = lang === "ar" ? ArrowRight : ArrowLeft;

  const q = useQuery({
    queryKey: qk.customer360(id),
    queryFn: ({ signal }) => o2cApi.customer360(id, signal).then((r) => r.data),
    enabled: !!id,
  });

  if (q.isLoading) return <LoadingState rows={6} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;
  const c = d.customer;
  const ex = d.creditExposure;
  const bizName = lang === "en" ? c.nameEn || c.name : c.name;

  return (
    <div>
      <button type="button" onClick={onBack} className="mb-3 inline-flex items-center gap-1 text-sm font-bold text-slate-500 hover:text-teal-700 no-print">
        <BackArrow className="h-4 w-4" /> {t("misc.customers.detail.back")}
      </button>
      <PageHeader
        eyebrow={t("misc.customers.detail.eyebrow", { type: c.customerType }) + (c.isActive ? "" : ` · ${t("status.disabled")}`)}
        title={bizName}
        subtitle={[c.phone, c.vatNumber, c.city].filter(Boolean).join(" · ") || undefined}
        action={
          <div className="flex flex-wrap items-center gap-2 no-print">
            <Button variant="secondary" onClick={() => setStmtOpen(true)}><Printer className="h-4 w-4" /> {t("misc.customers.detail.statement")}</Button>
            <Button variant="secondary" onClick={() => nav(`/sales/payments?customerId=${c.id}&new=1`)}>{t("misc.customers.detail.recordCollection")}</Button>
          </div>
        }
      />

      {d.warnings.length > 0 && (
        <div className="mb-4 flex flex-col gap-1 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 no-print">
          {d.warnings.map((w, i) => (
            <span key={i} className="flex items-center gap-2 text-sm font-bold text-amber-800"><AlertTriangle className="h-4 w-4" /> {w}</span>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label={t("misc.customers.detail.metric.balance")} value={<Money value={d.balance} />} icon={Wallet} tone="violet" />
        <Metric label={t("misc.customers.detail.metric.creditLimit")} value={<Money value={ex.creditLimit} />} icon={CreditCard} tone="blue" />
        <Metric label={t("misc.customers.detail.metric.exposure")} value={<Money value={ex.exposure} />} note={ex.utilizationPct != null ? t("misc.customers.detail.metric.utilization", { pct: ex.utilizationPct }) : undefined} icon={Gauge} tone="amber" />
        <Metric label={t("misc.customers.detail.metric.available")} value={<Money value={ex.available} />} icon={CreditCard} tone={ex.available < 0 ? "rose" : "teal"} />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle>{t("misc.customers.detail.recentInvoices")}</CardTitle></CardHeader>
          <CardBody>
            {d.recentSales.length === 0 ? <Empty /> : (
              <div className="overflow-x-auto rounded-2xl border border-slate-200">
                <table className="w-full min-w-[560px] border-collapse text-start text-sm">
                  <thead className="bg-slate-50 text-xs font-bold text-slate-500">
                    <tr>
                      <th className="px-4 py-3 font-bold">{t("misc.customers.detail.invCol.invoice")}</th>
                      <th className="px-4 py-3 font-bold">{t("misc.customers.detail.invCol.date")}</th>
                      <th className="px-4 py-3 font-bold">{t("misc.customers.detail.total")}</th>
                      <th className="px-4 py-3 font-bold">{t("misc.customers.detail.invCol.remaining")}</th>
                      <th className="px-4 py-3 font-bold">{t("common.status")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {d.recentSales.map((inv) => (
                      <tr key={inv.id} className="hover:bg-slate-50/60">
                        <td className="px-4 py-3"><button type="button" onClick={() => nav(`/sales/invoices?doc=${inv.id}`)} className="font-bold text-teal-700 hover:underline">{inv.document_number}</button></td>
                        <td className="px-4 py-3 text-slate-700"><DateCell value={inv.issue_date} /></td>
                        <td className="px-4 py-3 text-slate-700"><Money value={inv.total_amount} /></td>
                        <td className="px-4 py-3 text-slate-700"><Money value={inv.balance_amount} /></td>
                        <td className="px-4 py-3"><SalesStatus status={inv.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader><CardTitle>{t("misc.customers.detail.agingTitle")}</CardTitle></CardHeader>
          <CardBody>
            <ul className="flex flex-col gap-2">
              {AGING_BUCKETS.map((k) => (
                <li key={k} className="flex items-center justify-between text-sm">
                  <span className="font-bold text-slate-600">{k === "current" ? t("misc.customers.detail.aging.current") : AGING_RANGES[k]}</span>
                  <Money value={d.aging.buckets[k] ?? 0} className="font-bold" />
                </li>
              ))}
              <li className="mt-1 flex items-center justify-between border-t border-slate-100 pt-2 text-sm">
                <span className="font-extrabold text-slate-800">{t("misc.customers.detail.total")}</span>
                <Money value={d.aging.total} className="font-extrabold text-slate-900" />
              </li>
            </ul>
          </CardBody>
        </Card>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>{t("misc.customers.detail.summary")}</CardTitle></CardHeader>
          <CardBody>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <Stat label={t("misc.customers.detail.stat.openInvoices")} value={<span dir="ltr" className="tabular-nums">{d.openInvoices.count}</span>} />
              <Stat label={t("misc.customers.detail.stat.openBalance")} value={<Money value={d.openInvoices.balance} />} />
              <Stat label={t("misc.customers.detail.stat.collectionsCount")} value={<span dir="ltr" className="tabular-nums">{d.collections.count}</span>} />
              <Stat label={t("misc.customers.detail.stat.collectionsTotal")} value={<Money value={d.collections.total} />} />
              <Stat label={t("misc.customers.detail.stat.unappliedCredit")} value={<Money value={d.unappliedCredit} />} />
              <Stat label={t("misc.customers.detail.stat.paymentTerms")} value={`${ex.paymentTerms} · ${t("misc.customers.detail.daysValue", { days: ex.creditDays })}`} />
              <Stat label={t("misc.customers.detail.stat.firstDeal")} value={<DateCell value={d.firstDeal} />} />
              <Stat label={t("misc.customers.detail.stat.lastDeal")} value={<DateCell value={d.lastDeal} />} />
            </dl>
          </CardBody>
        </Card>

        <Card>
          <CardHeader><CardTitle>{t("misc.customers.detail.topProducts")}</CardTitle></CardHeader>
          <CardBody>
            {d.topProducts.length === 0 ? <Empty /> : (
              <ul className="divide-y divide-slate-100">
                {d.topProducts.map((p, i) => (
                  <li key={i} className="flex items-center justify-between py-2 text-sm">
                    <span className="truncate font-bold text-slate-700">{p.description || "—"}</span>
                    <span className="flex items-center gap-3">
                      <Num value={p.qty} className="text-slate-400" />
                      <Money value={p.net} className="font-bold" />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      {stmtOpen && <StatementDialog customerId={c.id} customerName={bizName} onClose={() => setStmtOpen(false)} />}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-xl bg-slate-50 px-3 py-2">
      <dt className="text-[11px] font-bold text-slate-400">{label}</dt>
      <dd className="mt-0.5 text-sm font-extrabold text-slate-800">{value}</dd>
    </div>
  );
}
function Empty() {
  const t = useT();
  return <p className="py-6 text-center text-sm font-medium text-slate-400">{t("states.emptyDefault")}</p>;
}

function StatementDialog({ customerId, customerName, onClose }: { customerId: string; customerName: string; onClose: () => void }) {
  const t = useT();
  const q = useQuery({
    queryKey: qk.customerStatement(customerId),
    queryFn: ({ signal }) => o2cApi.customerStatement(customerId, {}, signal).then((r) => r.data),
  });
  // Statement-line kind → localized label. `kind` is a stable data code.
  const kindLabel = (kind: string) =>
    kind === "payment"
      ? t("misc.customers.statement.kind.payment")
      : kind === "credit_note"
        ? t("misc.customers.statement.kind.creditNote")
        : t("misc.customers.statement.kind.invoice");
  return (
    <Dialog
      open
      onClose={onClose}
      size="xl"
      title={t("misc.customers.statement.title", { name: customerName })}
      footer={
        <>
          <Button variant="secondary" onClick={() => window.print()}><Printer className="h-4 w-4" /> {t("misc.customers.statement.print")}</Button>
          <Button variant="ghost" onClick={onClose}>{t("common.close")}</Button>
        </>
      }
    >
      {q.isLoading ? <LoadingState rows={4} /> : q.isError ? <ErrorState error={q.error} /> : (
        // The dialog CHROME (title bar, footer buttons) is not part of the
        // statement. Wrapping the body makes the print stylesheet hide
        // everything else and gives the sheet its own head — a customer
        // statement handed over on paper has to name the customer.
        <PrintDocument
          title={t("misc.customers.statement.title", { name: customerName })}
        >
          <div className="mb-3 flex items-center justify-between rounded-xl bg-slate-50 px-4 py-2 text-sm">
            <span className="font-bold text-slate-600">{t("misc.customers.statement.opening")}</span>
            <Money value={q.data!.opening} className="font-extrabold" />
          </div>
          <div className="overflow-x-auto rounded-2xl border border-slate-200">
            <table className="w-full min-w-[560px] border-collapse text-start text-sm">
              <thead className="bg-slate-50 text-xs font-bold text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-bold">{t("misc.customers.statement.col.date")}</th>
                  <th className="px-4 py-3 font-bold">{t("misc.customers.statement.col.ref")}</th>
                  <th className="px-4 py-3 font-bold">{t("misc.customers.statement.col.type")}</th>
                  <th className="px-4 py-3 font-bold">{t("misc.customers.statement.col.movement")}</th>
                  <th className="px-4 py-3 font-bold">{t("misc.customers.statement.col.balance")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {q.data!.lines.map((l, i) => (
                  <tr key={i}>
                    <td className="px-4 py-3 text-slate-700"><DateCell value={l.date} /></td>
                    <td className="px-4 py-3 font-bold text-slate-700">{l.ref}</td>
                    <td className="px-4 py-3 text-slate-700">{kindLabel(l.kind)}</td>
                    <td className="px-4 py-3 text-slate-700"><span dir="ltr" className="tabular-nums">{formatCurrency(l.amount)}</span></td>
                    <td className="px-4 py-3 text-slate-700"><Money value={l.balance} className="font-bold" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex items-center justify-between rounded-xl bg-teal-50 px-4 py-2 text-sm">
            <span className="font-bold text-teal-700">{t("misc.customers.statement.closing")}</span>
            <Money value={q.data!.closing} className="font-extrabold text-teal-800" />
          </div>
        </PrintDocument>
      )}
    </Dialog>
  );
}
