/**
 * CustomerHistoryDialog — سجل العميل (close/b2-pos-daily).
 *
 * Legacy contract: public/pos/app.js posOpenCustomerHistoryModal :1395 fed by
 * _posCustomerLoadSummary :1347 → GET /api/erp/customers/:id/summary. Same
 * content, live-fetched (react-query) instead of the legacy state cache:
 *   • KPI strip — إجمالي المشتريات / عدد الفواتير / متوسط الفاتورة / آخر زيارة
 *   • meta line — phone · first visit · customer type
 *   • last 50 invoices with the legacy status badges (ملغاة / مرتجع / تعديل /
 *     مرتجع جزئياً / مكتملة — :1444-1456)
 * English digits throughout (fmt2/fmtInt); totals exclude reversed documents
 * SERVER-side (the summary endpoint's aggregation rules).
 */
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CalendarDays, CheckCircle2, Coins, Phone, ReceiptText, Tag, Wallet } from "lucide-react";
import { createCustomerPayment, getCustomerSummary, isFeatureUnavailable } from "@/lib/api";
import { fmt2, fmtInt } from "@/lib/format";
import { ulid } from "@/lib/ulid";
import { useT } from "@/i18n/I18nProvider";
import type { TFunction } from "@/i18n/types";
import { Dialog } from "../Dialog";
import { Button, EmptyState, ErrorBanner, Money, Skeleton, cn } from "../ui";

/** Local date-only (matches legacy _posFormatDateOnly :1330). */
function dateOnly(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Legacy badge logic (app.js:1444-1456), verbatim mapping. `label` keeps the
 * ORIGINAL Arabic string — customerDialogs.test.tsx asserts it verbatim and
 * imports this pure function outside any I18nProvider, so it cannot translate.
 * The dialog renders the translated `labelKey` (via useT()) instead, so the
 * badge follows the active UI language.
 */
export function invoiceBadge(r: { zatcaType: string; hasCreditNote: boolean }): { label: string; labelKey: string; tone: string } {
  if (r.zatcaType === "cancellation") return { label: "ملغاة", labelKey: "customerHistoryDialog.badge.cancelled", tone: "border-red-200 bg-red-50 text-red-700" };
  if (r.zatcaType === "credit_note") return { label: "مرتجع", labelKey: "customerHistoryDialog.badge.returned", tone: "border-purple-200 bg-purple-50 text-purple-700" };
  if (r.zatcaType === "debit_note") return { label: "تعديل", labelKey: "customerHistoryDialog.badge.adjusted", tone: "border-purple-200 bg-purple-50 text-purple-700" };
  if (r.hasCreditNote) return { label: "مرتجع جزئياً", labelKey: "customerHistoryDialog.badge.partiallyReturned", tone: "border-purple-200 bg-purple-50 text-purple-700" };
  return { label: "مكتملة", labelKey: "customerHistoryDialog.badge.completed", tone: "border-teal-200 bg-teal-50 text-teal-700" };
}

/**
 * Turn a collection failure into a line the cashier can act on. A path the till
 * cannot reach (O2C flag off → 404, or outside the cashier-portal allow-list →
 * 403) is NOT "something broke" — it is "not from this till", and it must not
 * read like a bug the cashier should retry.
 */
export function collectErrorMessage(e: unknown, t: TFunction): string {
  if (isFeatureUnavailable(e)) return t("customerHistoryDialog.collect.unavailable");
  return (e as Error)?.message || t("customerHistoryDialog.collect.failed");
}

/**
 * سند قبض — record a collection on account, as a DRAFT.
 *
 * The cashier already holds `payments.create`
 * (db/migrations/order-to-cash/capabilities.js ROLE_GRANTS.cashier), yet had no
 * way to use it: a regular walking in to settle their tab meant fetching a
 * manager just to WRITE THE RECEIPT DOWN. This records it; `payments.approve`
 * and `payments.post` stay manager/accountant capabilities and are never called
 * from the till, so no money moves and no GL is touched until a manager posts.
 */
function CollectOnAccount({
  customer,
  initiallyOpen,
}: {
  customer: { id: string; name: string | null };
  initiallyOpen?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(!!initiallyOpen);
  const [amount, setAmount] = useState("");
  const [destination, setDestination] = useState<"cash" | "bank">("cash");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [done, setDone] = useState<{ documentNumber: string | null; status: string | null } | null>(null);

  const amountNum = Number(amount);
  const submit = useMutation({
    mutationFn: () =>
      createCustomerPayment(
        {
          customerId: customer.id,
          customerName: customer.name,
          amount: amountNum,
          destinationType: destination,
          reference,
          notes,
        },
        // A retry replays the SAME draft rather than opening a second one
        // (events.findPrior on customer_payment:create).
        { idempotencyKey: ulid() },
      ),
    onSuccess: (res) => {
      setDone({
        documentNumber: res.documentNumber ?? res.data?.payment_number ?? null,
        status: res.status ?? res.data?.status ?? "draft",
      });
      setAmount("");
      setReference("");
      setNotes("");
    },
  });

  if (!open) {
    return (
      <Button size="sm" variant="secondary" className="mb-3" onClick={() => setOpen(true)}>
        <Wallet className="h-4 w-4" aria-hidden />
        {t("customerHistoryDialog.collect.open")}
      </Button>
    );
  }

  return (
    <section className="mb-3 rounded-2xl border border-teal-200 bg-teal-50/50 p-3" aria-label={t("customerHistoryDialog.collect.title")}>
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-extrabold text-teal-800">
        <Wallet className="h-4 w-4" aria-hidden />
        {t("customerHistoryDialog.collect.title")}
      </h3>

      {done ? (
        <div className="flex flex-col items-center gap-2 py-2 text-center">
          <CheckCircle2 className="h-8 w-8 text-teal-600" aria-hidden />
          <p className="text-sm font-extrabold text-ink">{t("customerHistoryDialog.collect.doneTitle")}</p>
          {done.documentNumber ? (
            <p className="text-xs font-bold text-slate-500">
              {t("customerHistoryDialog.collect.documentNumberLabel")}{" "}
              <span className="num text-sm font-extrabold text-teal-700">{done.documentNumber}</span>
            </p>
          ) : null}
          <p className="text-[11px] font-bold text-slate-400">{t("customerHistoryDialog.collect.draftNote")}</p>
          <Button size="sm" variant="ghost" onClick={() => setDone(null)}>
            {t("customerHistoryDialog.collect.another")}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {submit.isError ? <ErrorBanner message={collectErrorMessage(submit.error, t)} /> : null}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-[11px] font-extrabold text-slate-600">
                {t("customerHistoryDialog.collect.amountLabel")}
              </span>
              <input
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                aria-label={t("customerHistoryDialog.collect.amountLabel")}
                placeholder="0.00"
                className="field num min-h-11"
                dir="ltr" /* LTR forced: numeric - do not remove, see i18n plan */
              />
            </label>
            <div role="radiogroup" aria-label={t("customerHistoryDialog.collect.destinationLabel")}>
              <span className="mb-1 block text-[11px] font-extrabold text-slate-600">
                {t("customerHistoryDialog.collect.destinationLabel")}
              </span>
              <div className="grid grid-cols-2 gap-1.5">
                {(
                  [
                    ["cash", t("customerHistoryDialog.collect.destinationCash")],
                    ["bank", t("customerHistoryDialog.collect.destinationBank")],
                  ] as Array<["cash" | "bank", string]>
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    role="radio"
                    aria-checked={destination === key}
                    onClick={() => setDestination(key)}
                    className={cn(
                      "btn-press min-h-11 rounded-xl border text-xs font-extrabold transition",
                      destination === key
                        ? "border-ink bg-ink text-white"
                        : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <label className="block">
              <span className="mb-1 block text-[11px] font-extrabold text-slate-600">
                {t("customerHistoryDialog.collect.referenceLabel")}
              </span>
              <input
                type="text"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                aria-label={t("customerHistoryDialog.collect.referenceLabel")}
                placeholder={t("customerHistoryDialog.collect.referencePlaceholder")}
                className="field min-h-11"
                maxLength={100}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] font-extrabold text-slate-600">
                {t("customerHistoryDialog.collect.notesLabel")}
              </span>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                aria-label={t("customerHistoryDialog.collect.notesLabel")}
                className="field min-h-11"
                maxLength={200}
              />
            </label>
          </div>
          <p className="text-[11px] font-semibold text-slate-500">{t("customerHistoryDialog.collect.draftNote")}</p>
          <div className="flex items-center justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={submit.isPending}>
              {t("customerHistoryDialog.collect.cancel")}
            </Button>
            <Button
              size="sm"
              variant="primary"
              loading={submit.isPending}
              disabled={!(amountNum > 0) || submit.isPending}
              onClick={() => submit.mutate()}
            >
              {t("customerHistoryDialog.collect.submit")}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

function Kpi({ icon, label, value, unit }: { icon: React.ReactNode; label: string; value: string; unit?: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 p-3 text-center">
      <div className="mx-auto mb-1 grid h-8 w-8 place-items-center rounded-xl bg-violet-50 text-violet-600">{icon}</div>
      <p className="num text-lg font-extrabold text-ink">{value}</p>
      {unit ? <p className="text-[10px] font-bold text-slate-400">{unit}</p> : null}
      <p className="text-[11px] font-extrabold text-slate-500">{label}</p>
    </div>
  );
}

export function CustomerHistoryDialog({
  open,
  onClose,
  customer,
  /** Show the سند قبض panel. Off by default so a standalone render (or an
   *  older caller) is byte-identical to before this capability landed. */
  allowCollect = false,
  collectInitiallyOpen = false,
}: {
  open: boolean;
  onClose: () => void;
  customer: { id: string; name: string | null; phone: string | null } | null;
  allowCollect?: boolean;
  collectInitiallyOpen?: boolean;
}) {
  const t = useT();
  const query = useQuery({
    queryKey: ["cust-summary", customer?.id],
    queryFn: () => getCustomerSummary(customer!.id),
    enabled: open && !!customer?.id,
    staleTime: 30_000,
  });
  const s = query.data;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={customer?.name ? t("customerHistoryDialog.titleWithName", { name: customer.name }) : t("customerHistoryDialog.title")}
      widthClass="max-w-3xl"
    >
      {allowCollect && customer ? (
        <CollectOnAccount customer={customer} initiallyOpen={collectInitiallyOpen} />
      ) : null}
      {query.isLoading ? (
        <div>
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
          <Skeleton className="h-40 w-full" />
        </div>
      ) : query.isError ? (
        <ErrorBanner message={(query.error as Error).message || t("customerHistoryDialog.loadError")} onRetry={() => void query.refetch()} />
      ) : s ? (
        <div>
          {/* KPI strip — the legacy 4 cards (:1415-1421) */}
          <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Kpi icon={<Coins className="h-4 w-4" aria-hidden />} label={t("customerHistoryDialog.kpi.totalSpentLabel")} value={fmt2(s.kpi.totalSpent)} unit={t("customerHistoryDialog.currency")} />
            <Kpi icon={<ReceiptText className="h-4 w-4" aria-hidden />} label={t("customerHistoryDialog.kpi.orderCountLabel")} value={fmtInt(s.kpi.orderCount)} unit={t("customerHistoryDialog.kpi.orderCountUnit")} />
            <Kpi icon={<Coins className="h-4 w-4" aria-hidden />} label={t("customerHistoryDialog.kpi.avgInvoiceLabel")} value={fmt2(s.kpi.avgInvoice)} unit={t("customerHistoryDialog.currency")} />
            <Kpi icon={<CalendarDays className="h-4 w-4" aria-hidden />} label={t("customerHistoryDialog.kpi.lastVisitLabel")} value={dateOnly(s.kpi.lastVisit)} />
          </div>

          {/* Meta line (:1423-1430) */}
          <p className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-bold text-slate-500">
            {s.customer.phone ? (
              <span className="flex items-center gap-1">
                <Phone className="h-3 w-3" aria-hidden /> <span dir="ltr" className="num">{s.customer.phone}</span>
              </span>
            ) : null}
            {s.kpi.firstVisit ? (
              <span className="flex items-center gap-1">
                <CalendarDays className="h-3 w-3" aria-hidden /> {t("customerHistoryDialog.meta.firstVisitLabel")} <span className="num">{dateOnly(s.kpi.firstVisit)}</span>
              </span>
            ) : null}
            {s.customer.customerType ? (
              <span className="flex items-center gap-1">
                <Tag className="h-3 w-3" aria-hidden /> {s.customer.customerType}
              </span>
            ) : null}
          </p>

          {/* Recent purchases table (:1441-1486) */}
          {s.recentInvoices.length === 0 ? (
            <EmptyState
              icon={<ReceiptText className="h-10 w-10" />}
              title={t("customerHistoryDialog.empty.title")}
              hint={t("customerHistoryDialog.empty.hint")}
            />
          ) : (
            <div className="scrollbar-thin max-h-[45vh] overflow-y-auto rounded-xl border border-slate-200">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-slate-50 text-[11px] font-extrabold text-slate-500">
                  <tr>
                    <th className="p-2 text-start">{t("customerHistoryDialog.table.date")}</th>
                    <th className="p-2 text-start">{t("customerHistoryDialog.table.invoiceNumber")}</th>
                    <th className="p-2 text-start">{t("customerHistoryDialog.table.total")}</th>
                    <th className="p-2 text-start">{t("customerHistoryDialog.table.payment")}</th>
                    <th className="p-2 text-start">{t("customerHistoryDialog.table.status")}</th>
                  </tr>
                </thead>
                <tbody>
                  {s.recentInvoices.map((r) => {
                    const badge = invoiceBadge(r);
                    const reversed = r.zatcaType === "cancellation" || r.zatcaType === "credit_note";
                    return (
                      <tr key={r.id} className={cn("border-t border-slate-100", reversed && "opacity-60")}>
                        <td className="num p-2 text-slate-500">{dateOnly(r.date)}</td>
                        <td className="p-2">
                          <span className="num font-extrabold text-ink">{r.invoiceNumber ?? r.id}</span>
                          {r.voidSerial ? <div className="num text-[10px] text-red-700">{r.voidSerial}</div> : null}
                          {r.returnSerial ? <div className="num text-[10px] text-purple-700">{r.returnSerial}</div> : null}
                        </td>
                        <td className="p-2">
                          <Money value={fmt2(r.total)} className="font-extrabold text-ink" />
                        </td>
                        <td className="p-2 font-bold text-slate-600">{r.payment || "—"}</td>
                        <td className="p-2">
                          <span className={cn("chip px-2 py-0.5 text-[10px] font-extrabold", badge.tone)}>{t(badge.labelKey)}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}
    </Dialog>
  );
}
