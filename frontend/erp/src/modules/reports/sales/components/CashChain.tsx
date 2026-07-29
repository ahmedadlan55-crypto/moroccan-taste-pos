// Sales Analytics Hub — the cash chain: one column, invoiced → deposited.
//
// WHY A CHAIN AND NOT A TABLE
//   The three-way reconciliation already carried every figure below, in a wide
//   per-day × per-branch grid. Every number was there and the question an owner
//   actually asks was not answerable: "I billed X — where did it end up?"
//   Answering it meant reading across eleven columns, holding four subtotals in
//   your head, and knowing which pairs are supposed to differ.
//
//   So the same data is read down instead of across, and each place the money
//   can leak gets its own named line:
//
//     BILLED        invoices issued
//       ↓  gap = sold on credit / not yet collected
//     COLLECTED     received − refunded
//       ↓
//     DRAWER        opening float + cash sales − cash refunds − pay-outs − deposits
//       ↓  gap = till variance, the only one that should be zero
//     COUNTED       what the cashier actually counted
//
//   The two gaps mean opposite things and that is the point of naming them.
//   Billed-vs-collected is EXPECTED to be non-zero the moment anything is sold
//   on account — it is a receivable, not an error. Expected-vs-counted is the
//   only line that should read zero, and every halala of it is unexplained.
//   A screen that presents both as "differences" teaches people to ignore both.
//
// Every figure comes from the server's period totals (ReconciliationService
// sums them where it computes the deltas). Nothing here is added up in the
// browser — a cash chain that disagrees with the table beneath it would be
// worse than no chain.
import { ArrowDownRight } from "lucide-react";
import { cn } from "@/shared/lib";
import { formatCurrency } from "@/shared/lib";
import { useT } from "@/i18n";
import type { ReconciliationTotals } from "../lib/api";

/** |delta| above this is real; money is exact to the halala. */
const EPS = 0.01;

interface ChainLine {
  id: string;
  label: string;
  value: number | null;
  /** "sub" renders a subtracted operand, "eq" a computed result. */
  op?: "add" | "sub" | "eq";
  strong?: boolean;
}

interface GapLine {
  id: string;
  label: string;
  value: number | null;
  note: string;
  /** true → any non-zero is an exception; false → non-zero is normal. */
  mustBeZero: boolean;
}

export interface CashChainProps {
  totals: ReconciliationTotals | undefined;
  className?: string;
}

function money(v: number | null | undefined): string {
  return typeof v === "number" && Number.isFinite(v) ? formatCurrency(v) : "—";
}

export function CashChain({ totals, className }: CashChainProps) {
  const t = useT();
  if (!totals) return null;

  const collected =
    totals.payments_in == null && totals.payments_out == null
      ? null
      : (totals.payments_in ?? 0) - (totals.payments_out ?? 0);

  const billed: ChainLine[] = [
    { id: "invoiced", label: t("salesReports.chain.invoiced"), value: totals.invoice_total ?? null, strong: true },
  ];

  const collectedLines: ChainLine[] = [
    { id: "in", label: t("salesReports.chain.received"), value: totals.payments_in ?? null },
    { id: "out", label: t("salesReports.chain.refunded"), value: totals.payments_out ?? null, op: "sub" },
    { id: "net", label: t("salesReports.chain.collected"), value: collected, op: "eq", strong: true },
  ];

  const drawerLines: ChainLine[] = [
    { id: "float", label: t("salesReports.chain.openFloat"), value: totals.open_float ?? null },
    { id: "cash_sale", label: t("salesReports.chain.cashSales"), value: totals.cash_sale ?? null, op: "add" },
    { id: "cash_refund", label: t("salesReports.chain.cashRefunds"), value: totals.cash_refund ?? null, op: "sub" },
    // pay_in is an INFLOW and belongs here because expectedCash() counts it
    // (ReconciliationService: expectedCash(float, sale, refund, pay_in,
    // pay_out + deposit)). Omitting it would leave the lines above not summing
    // to the "expected" line printed beneath them — a chain that visibly fails
    // to add up is worse than no chain.
    { id: "pay_in", label: t("salesReports.chain.payIns"), value: totals.pay_in ?? null, op: "add" },
    { id: "pay_out", label: t("salesReports.chain.payOuts"), value: totals.pay_out ?? null, op: "sub" },
    { id: "deposit", label: t("salesReports.chain.deposits"), value: totals.deposit ?? null, op: "sub" },
    { id: "expected", label: t("salesReports.chain.expected"), value: totals.expected_cash ?? null, op: "eq", strong: true },
    { id: "counted", label: t("salesReports.chain.counted"), value: totals.counted ?? null, strong: true },
  ];

  const gaps: GapLine[] = [
    {
      id: "billed-vs-collected",
      label: t("salesReports.chain.gapCollection"),
      value: totals.salesVsPayments ?? null,
      note: t("salesReports.chain.gapCollectionNote"),
      mustBeZero: false,
    },
    {
      id: "expected-vs-counted",
      label: t("salesReports.chain.gapTill"),
      value: totals.cashExpectedVsCounted ?? null,
      note: t("salesReports.chain.gapTillNote"),
      mustBeZero: true,
    },
  ];

  const opGlyph = (op?: ChainLine["op"]) => (op === "sub" ? "−" : op === "add" ? "+" : op === "eq" ? "=" : "");

  const section = (title: string, lines: ChainLine[]) => (
    <div className="min-w-0 flex-1">
      <h4 className="mb-1.5 text-[11px] font-extrabold uppercase tracking-wide text-slate-400">{title}</h4>
      <dl className="space-y-0.5">
        {lines.map((l) => (
          <div
            key={l.id}
            data-chain-line={l.id}
            className={cn(
              "flex items-baseline justify-between gap-3 rounded-lg px-2 py-1",
              l.op === "eq" && "border-t border-slate-200 pt-1.5",
              l.strong && "bg-slate-50",
            )}
          >
            <dt className={cn("min-w-0 truncate text-xs", l.strong ? "font-extrabold text-slate-800" : "font-bold text-slate-500")}>
              <span className="me-1 inline-block w-3 text-slate-400" aria-hidden="true">
                {opGlyph(l.op)}
              </span>
              {l.label}
            </dt>
            <dd
              dir="ltr"
              className={cn("shrink-0 text-xs tabular-nums", l.strong ? "font-extrabold text-slate-900" : "font-bold text-slate-600")}
            >
              {money(l.value)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );

  return (
    <article className={cn("surface p-5", className)} data-testid="cash-chain">
      <header className="mb-4">
        <h3 className="text-base font-extrabold text-slate-900">{t("salesReports.chain.title")}</h3>
        <p className="mt-0.5 text-xs font-bold text-slate-500">{t("salesReports.chain.subtitle")}</p>
      </header>

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        {section(t("salesReports.chain.stepBilled"), billed)}
        <ArrowDownRight className="h-4 w-4 shrink-0 self-center text-slate-300 lg:mt-8" aria-hidden="true" />
        {section(t("salesReports.chain.stepCollected"), collectedLines)}
        <ArrowDownRight className="h-4 w-4 shrink-0 self-center text-slate-300 lg:mt-8" aria-hidden="true" />
        {section(t("salesReports.chain.stepDrawer"), drawerLines)}
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2" data-testid="cash-chain-gaps">
        {gaps.map((g) => {
          const real = g.value != null && Math.abs(g.value) > EPS;
          // Colour encodes the MEANING, not the magnitude: an uncollected
          // receivable is information, an unexplained drawer difference is a
          // problem. Painting both amber would teach the reader to ignore both.
          const tone = !real
            ? "border-slate-200 bg-slate-50 text-slate-600"
            : g.mustBeZero
              ? "border-rose-200 bg-rose-50 text-rose-800"
              : "border-blue-200 bg-blue-50 text-blue-800";
          return (
            <div key={g.id} data-chain-gap={g.id} className={cn("rounded-xl border p-3", tone)}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-xs font-extrabold">{g.label}</span>
                <span dir="ltr" className="shrink-0 text-sm font-extrabold tabular-nums">
                  {money(g.value)}
                </span>
              </div>
              <p className="mt-1 text-[11px] font-bold opacity-80">{g.note}</p>
            </div>
          );
        })}
      </div>
    </article>
  );
}
