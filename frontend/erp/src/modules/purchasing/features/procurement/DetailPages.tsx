// Full procurement detail screens — Supplier, Purchase Order, Goods Receipt,
// Supplier Invoice (+ three-way match), Payment (+ allocations), Purchase Return.
// Each: header + status stepper + document body + status-driven action bar +
// GL journal + timeline + attachments + A4 print. Backend enforces permissions.
import { type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { FileText, PackageCheck, Receipt, Wallet, Undo2 } from "lucide-react";
import { MetricCard } from "@/modules/inventory/lib/MetricCard";
import { Button, PrintDocument } from "@/shared/ui";
import { LoadingState, ErrorState } from "@/shared/ui";
import { formatCurrency, formatDate } from "@/shared/lib";
import { useCan } from "@/modules/inventory/lib/permission-provider";
import {
  useOrder, useReceipt, useInvoice, usePayment, useReturn, useDocAction,
} from "@/modules/inventory/lib/hooks/useProcurement";
import { useT } from "@/i18n";
import type { TFunction } from "@/i18n";
import { BackLink, DetailHeader, Section, KV, StatusStepper, TimelinePanel, GLPanel, AttachmentsPanel, ErrorLine } from "./detail-shared";
import { st } from "./labels";

function s(v: unknown, d = "—"): string { return v == null || v === "" ? d : String(v); }
// Stepper node label: two nodes use a shorter label than their status text
// ("مستلم" for the fully_received node; "مراجعة" for the pending_review node).
function stepLabel(t: TFunction, key: string): string {
  if (key === "fully_received") return t("purchasing.status.received");
  if (key === "pending_review") return t("purchasing.step.review");
  return st(t, key);
}
function n(v: unknown): number { const x = Number(v); return Number.isFinite(x) ? x : 0; }
function Th({ children, left }: { children: ReactNode; left?: boolean }) { return <th className={`px-3 py-2 text-[11px] font-extrabold uppercase text-slate-400 ${left ? "text-left" : "text-right"}`}>{children}</th>; }
function Td({ children, left, bold }: { children: ReactNode; left?: boolean; bold?: boolean }) { return <td className={`px-3 py-2.5 text-sm text-slate-700 ${left ? "text-left tabular-nums" : ""} ${bold ? "font-bold" : ""}`}>{children}</td>; }
function Table({ head, children }: { head: ReactNode; children: ReactNode }) {
  return <div className="overflow-x-auto"><table className="w-full border-collapse"><thead className="bg-slate-50"><tr>{head}</tr></thead><tbody className="divide-y divide-slate-100">{children}</tbody></table></div>;
}

// ── generic action runner ─────────────────────────────────────────────────
function useRun(entity: "orders" | "receipts" | "invoices" | "payments" | "returns", id: string, version: number, refetch: () => void) {
  const action = useDocAction(entity);
  const run = (act: string, body?: Record<string, unknown>) => action.mutate({ id, action: act, body, expectedVersion: version }, { onSuccess: () => refetch() });
  return { run, action };
}

// ── Purchase Order ──────────────────────────────────────────────────────────
const PO_STEP_KEYS = ["draft", "submitted", "approved", "sent", "partially_received", "fully_received", "closed"];
export function OrderDetailPage() {
  const t = useT();
  const [sp] = useSearchParams();
  const id = sp.get("doc") ?? "";
  const { data, isLoading, isError, error, refetch } = useOrder(id);
  const canApprove = useCan("procurement.approve"), canManage = useCan("procurement.manage");
  const o = (data ?? {}) as Record<string, unknown>;
  const { run, action } = useRun("orders", id, n(o.version) || 1, refetch);
  if (isLoading) return <LoadingState />;
  if (isError || !data) return <ErrorState error={error} onRetry={() => refetch()} />;
  const status = s(o.status, "draft");
  const lines = (o.lines ?? []) as Record<string, unknown>[];
  const receipts = (o.receipts ?? []) as Record<string, unknown>[];
  const invoices = (o.invoices ?? []) as Record<string, unknown>[];
  return (
    <PrintDocument className="grid gap-6 print:gap-4" title={s(o.po_number)}>
      <BackLink to="/purchasing/orders" label={t("purchasing.tabs.orders")} />
      <DetailHeader eyebrow={t("purchasing.order.eyebrow")} title={s(o.po_number)} subtitle={s(o.supplier_name)} status={status}
        actions={<div className="flex flex-wrap gap-2 print:hidden">
          {canManage && status === "draft" && <Button onClick={() => run("submit")}>{t("purchasing.action.submit")}</Button>}
          {canApprove && status === "submitted" && <Button onClick={() => run("approve")}>{t("purchasing.action.approve")}</Button>}
          {canApprove && status === "approved" && <Button variant="secondary" onClick={() => run("send")}>{t("purchasing.action.send")}</Button>}
          {canApprove && ["approved", "sent", "fully_received"].includes(status) && <Button variant="secondary" onClick={() => run("close")}>{t("purchasing.action.close")}</Button>}
          {canApprove && ["draft", "submitted", "approved"].includes(status) && <Button variant="danger" onClick={() => run("cancel")}>{t("purchasing.action.cancel")}</Button>}
        </div>} />
      <ErrorLine error={action.error} />
      <Section title={t("common.status")}><StatusStepper steps={PO_STEP_KEYS.map((k) => ({ key: k, label: stepLabel(t, k) }))} current={status === "received" ? "fully_received" : status} /></Section>
      <Section title={t("purchasing.order.dataTitle")}>
        <KV items={[
          { label: t("purchasing.col.date"), value: formatDate(s(o.po_date, "")) }, { label: t("purchasing.order.expectedSupply"), value: formatDate(s(o.expected_date, "")) },
          { label: t("purchasing.order.currency"), value: s(o.currency) }, { label: t("purchasing.field.version"), value: s(o.version) },
          { label: t("purchasing.field.net"), value: formatCurrency(n(o.total_before_vat)) }, { label: t("purchasing.field.vat"), value: formatCurrency(n(o.vat_amount)) },
          { label: t("purchasing.col.total"), value: formatCurrency(n(o.total_after_vat)) }, { label: t("purchasing.field.createdBy"), value: s(o.created_by) },
        ]} />
      </Section>
      <Section icon={FileText} title={t("purchasing.lines.title")}>
        <Table head={<><Th>{t("purchasing.col.item")}</Th><Th left>{t("purchasing.lines.entered")}</Th><Th left>{t("purchasing.lines.base")}</Th><Th left>{t("purchasing.lines.received")}</Th><Th left>{t("purchasing.lines.price")}</Th><Th left>{t("purchasing.col.total")}</Th></>}>
          {lines.map((l, i) => (
            <tr key={i}><Td>{s(l.item_name)}</Td><Td left>{n(l.entered_qty)} {s(l.entered_unit_code, "")}</Td><Td left>{n(l.base_qty)}</Td>
              <Td left>{n(l.base_received_qty)}</Td><Td left>{formatCurrency(n(l.unit_price))}</Td><Td left bold>{formatCurrency(n(l.total))}</Td></tr>
          ))}
        </Table>
      </Section>
      <Section icon={PackageCheck} title={t("purchasing.tabs.receiving")}>
        {receipts.length === 0 ? <div className="p-5 text-sm text-slate-400">{t("purchasing.order.noReceipts")}</div> : (
          <Table head={<><Th>{t("purchasing.col.number")}</Th><Th>{t("purchasing.col.date")}</Th><Th>{t("common.status")}</Th><Th left>{t("purchasing.col.total")}</Th></>}>
            {receipts.map((r, i) => <tr key={i}><Td>{s(r.receipt_number)}</Td><Td>{formatDate(s(r.receipt_date, ""))}</Td><Td>{st(t, s(r.status))}</Td><Td left bold>{formatCurrency(n(r.total))}</Td></tr>)}
          </Table>
        )}
      </Section>
      {invoices.length > 0 && (
        <Section icon={Receipt} title={t("purchasing.tabs.invoices")}>
          <Table head={<><Th>{t("purchasing.col.number")}</Th><Th>{t("common.status")}</Th><Th left>{t("purchasing.col.total")}</Th></>}>
            {invoices.map((r, i) => <tr key={i}><Td>{s(r.invoice_no, s(r.code))}</Td><Td>{st(t, s(r.status))}</Td><Td left bold>{formatCurrency(n(r.total_amount))}</Td></tr>)}
          </Table>
        </Section>
      )}
      <TimelinePanel entity="orders" id={id} />
    </PrintDocument>
  );
}

// ── Goods Receipt ───────────────────────────────────────────────────────────
const GRN_STEP_KEYS = ["draft", "approved", "posted"];
export function ReceiptDetailPage() {
  const t = useT();
  const [sp] = useSearchParams();
  const id = sp.get("doc") ?? "";
  const { data, isLoading, isError, error, refetch } = useReceipt(id);
  const canApprove = useCan("procurement.approve");
  const o = (data ?? {}) as Record<string, unknown>;
  const { run, action } = useRun("receipts", id, n(o.version) || 1, refetch);
  if (isLoading) return <LoadingState />;
  if (isError || !data) return <ErrorState error={error} onRetry={() => refetch()} />;
  const status = s(o.status, "draft");
  const lines = (o.lines ?? []) as Record<string, unknown>[];
  return (
    <PrintDocument className="grid gap-6 print:gap-4" title={s(o.receipt_number)}>
      <BackLink to="/purchasing/receiving" label={t("purchasing.tabs.receiving")} />
      <DetailHeader eyebrow={t("purchasing.receipt.eyebrow")} title={s(o.receipt_number)} subtitle={s(o.supplier_name_snapshot)} status={status}
        actions={<div className="flex flex-wrap gap-2 print:hidden">
          {canApprove && status === "draft" && <Button onClick={() => run("approve")}>{t("purchasing.action.approve")}</Button>}
          {canApprove && status === "approved" && <Button onClick={() => run("post")}>{t("purchasing.receipt.postAction")}</Button>}
          {canApprove && status === "posted" && <Button variant="secondary" onClick={() => run("reverse")}>{t("purchasing.action.reverse")}</Button>}
          {canApprove && ["draft", "approved"].includes(status) && <Button variant="danger" onClick={() => run("cancel")}>{t("purchasing.action.cancel")}</Button>}
        </div>} />
      <ErrorLine error={action.error} />
      <Section title={t("common.status")}><StatusStepper steps={GRN_STEP_KEYS.map((k) => ({ key: k, label: stepLabel(t, k) }))} current={status} /></Section>
      <Section title={t("purchasing.receipt.dataTitle")}>
        <KV items={[
          { label: t("purchasing.col.date"), value: formatDate(s(o.receipt_date, "")) }, { label: t("purchasing.field.warehouse"), value: s(o.warehouse_id) },
          { label: t("purchasing.field.purchaseOrder"), value: s(o.po_id) }, { label: t("purchasing.col.total"), value: formatCurrency(n(o.total)) }, { label: t("purchasing.field.version"), value: s(o.version) },
        ]} />
      </Section>
      <Section icon={PackageCheck} title={t("purchasing.lines.title")}>
        <Table head={<><Th>{t("purchasing.col.item")}</Th><Th left>{t("purchasing.lines.entered")}</Th><Th left>{t("purchasing.lines.base")}</Th><Th left>{t("purchasing.lines.unitCost")}</Th><Th>{t("purchasing.lines.lot")}</Th><Th>{t("purchasing.lines.expiry")}</Th><Th left>{t("purchasing.col.total")}</Th></>}>
          {lines.map((l, i) => (
            <tr key={i}><Td>{s(l.item_id)}</Td><Td left>{n(l.entered_qty)} {s(l.entered_unit_code, "")}</Td><Td left>{n(l.base_qty)}</Td>
              <Td left>{formatCurrency(n(l.base_unit_cost))}</Td><Td>{s(l.lot_no)}</Td><Td>{l.expiry_date ? formatDate(s(l.expiry_date, "")) : "—"}</Td><Td left bold>{formatCurrency(n(l.line_total))}</Td></tr>
          ))}
        </Table>
      </Section>
      <GLPanel journalId={s(o.gl_journal_id, "") || null} />
      <TimelinePanel entity="receipts" id={id} />
    </PrintDocument>
  );
}

// ── Supplier Invoice + three-way match ──────────────────────────────────────
const INV_STEP_KEYS = ["draft", "pending_review", "approved", "paid"];
export function InvoiceDetailPage() {
  const t = useT();
  const [sp] = useSearchParams();
  const id = sp.get("doc") ?? "";
  const { data, isLoading, isError, error, refetch } = useInvoice(id);
  const canApprove = useCan("procurement.approve"), canManage = useCan("procurement.manage");
  const o = (data ?? {}) as Record<string, unknown>;
  const { run, action } = useRun("invoices", id, n(o.version) || 1, refetch);
  if (isLoading) return <LoadingState />;
  if (isError || !data) return <ErrorState error={error} onRetry={() => refetch()} />;
  const status = s(o.status, "draft");
  const lines = (o.lines ?? []) as Record<string, unknown>[];
  const matches = (o.matches ?? []) as Record<string, unknown>[];
  const matchStatus = s(o.matching_status, "unmatched");
  return (
    <PrintDocument className="grid gap-6 print:gap-4" title={s(o.invoice_no, s(o.code))}>
      <BackLink to="/purchasing/invoices" label={t("purchasing.tabs.invoices")} />
      <DetailHeader eyebrow={t("purchasing.invoice.eyebrow")} title={s(o.invoice_no, s(o.code))} subtitle={`${s(o.supplier_name)} · ${t("purchasing.invoice.matchingLabel")}: ${st(t, matchStatus)}`} status={status}
        actions={<div className="flex flex-wrap gap-2 print:hidden">
          {canManage && ["draft", "pending_review"].includes(status) && <Button variant="secondary" onClick={() => run("match")}>{t("purchasing.invoice.matchAction")}</Button>}
          {canManage && status === "draft" && <Button onClick={() => run("submit")}>{t("purchasing.action.submit")}</Button>}
          {canApprove && ["pending_review", "pending_approval"].includes(status) && <Button onClick={() => run("approve")}>{t("purchasing.invoice.approveAction")}</Button>}
          {canApprove && ["approved", "partially_paid"].includes(status) && <Button variant="secondary" onClick={() => run("credit-note")}>{t("purchasing.action.credit_note")}</Button>}
          {canManage && status === "draft" && <Button variant="danger" onClick={() => run("cancel")}>{t("purchasing.action.cancel")}</Button>}
        </div>} />
      <ErrorLine error={action.error} />
      <Section title={t("common.status")}><StatusStepper steps={INV_STEP_KEYS.map((k) => ({ key: k, label: stepLabel(t, k) }))} current={["partially_paid"].includes(status) ? "approved" : status} /></Section>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard label={t("purchasing.invoice.total")} value={formatCurrency(n(o.total_amount))} icon={Receipt} tone="teal" />
        <MetricCard label={t("purchasing.invoice.paid")} value={formatCurrency(n(o.paid_amount))} icon={Wallet} tone="blue" />
        <MetricCard label={t("purchasing.invoice.balance")} value={formatCurrency(n(o.balance_amount))} icon={Wallet} tone="violet" />
        <MetricCard label={t("purchasing.invoice.tax")} value={formatCurrency(n(o.vat_amount))} icon={FileText} tone="amber" />
      </div>
      <Section icon={FileText} title={t("purchasing.lines.title")}>
        <Table head={<><Th>{t("purchasing.invoice.colDescription")}</Th><Th left>{t("purchasing.lines.qty")}</Th><Th left>{t("purchasing.lines.price")}</Th><Th left>{t("purchasing.invoice.colVatPct")}</Th><Th left>{t("purchasing.col.total")}</Th></>}>
          {lines.map((l, i) => <tr key={i}><Td>{s(l.description)}</Td><Td left>{n(l.quantity)}</Td><Td left>{formatCurrency(n(l.unit_price))}</Td><Td left>{s(l.vat_pct)}</Td><Td left bold>{formatCurrency(n(l.line_total))}</Td></tr>)}
        </Table>
      </Section>
      <Section title={t("purchasing.invoice.matchTitle")}>
        {matches.length === 0 ? <div className="p-5 text-sm text-slate-400">{t("purchasing.invoice.matchEmpty")}</div> : (
          <Table head={<><Th>{t("purchasing.invoice.colReceiptLine")}</Th><Th left>{t("purchasing.invoice.colMatchedQty")}</Th><Th left>{t("purchasing.invoice.colMatchedValue")}</Th><Th left>{t("purchasing.invoice.colPriceVar")}</Th><Th left>{t("purchasing.invoice.colQtyVar")}</Th></>}>
            {matches.map((m, i) => (
              <tr key={i}><Td>{s(m.receipt_line_id)}</Td><Td left>{n(m.matched_qty)}</Td><Td left>{formatCurrency(n(m.matched_amount))}</Td>
                <Td left><span className={n(m.price_variance) !== 0 ? "font-bold text-amber-600" : ""}>{formatCurrency(n(m.price_variance))}</span></Td>
                <Td left><span className={n(m.qty_variance) !== 0 ? "font-bold text-amber-600" : ""}>{n(m.qty_variance)}</span></Td></tr>
            ))}
          </Table>
        )}
      </Section>
      <GLPanel journalId={s(o.gl_journal_id, "") || null} />
      <AttachmentsPanel attachments={o.attachments as string | null} />
      <TimelinePanel entity="invoices" id={id} />
    </PrintDocument>
  );
}

// ── Payment + allocations ───────────────────────────────────────────────────
const PAY_STEP_KEYS = ["requested", "authorized", "paid", "closed"];
export function PaymentDetailPage() {
  const t = useT();
  const [sp] = useSearchParams();
  const id = sp.get("doc") ?? "";
  const { data, isLoading, isError, error, refetch } = usePayment(id);
  const canApprove = useCan("procurement.approve");
  const o = (data ?? {}) as Record<string, unknown>;
  const { run, action } = useRun("payments", id, n(o.version) || 1, refetch);
  if (isLoading) return <LoadingState />;
  if (isError || !data) return <ErrorState error={error} onRetry={() => refetch()} />;
  const status = s(o.status, "requested");
  const allocations = (o.allocations ?? []) as Record<string, unknown>[];
  return (
    <PrintDocument className="grid gap-6 print:gap-4" title={s(o.payment_number)}>
      <BackLink to="/purchasing/payments" label={t("purchasing.tabs.payments")} />
      <DetailHeader eyebrow={t("purchasing.payment.eyebrow")} title={s(o.payment_number)} subtitle={`${s(o.payment_method)} · ${formatCurrency(n(o.amount))}`} status={status}
        actions={<div className="flex flex-wrap gap-2 print:hidden">
          {canApprove && status === "requested" && <Button onClick={() => run("authorize")}>{t("purchasing.action.authorize")}</Button>}
          {canApprove && status === "authorized" && <Button onClick={() => run("pay")}>{t("purchasing.payment.payAction")}</Button>}
          {canApprove && status === "paid" && <Button variant="secondary" onClick={() => run("close")}>{t("purchasing.action.close")}</Button>}
          {canApprove && ["paid", "closed"].includes(status) && <Button variant="danger" onClick={() => run("reverse")}>{t("purchasing.action.reverse")}</Button>}
          {canApprove && ["requested", "authorized"].includes(status) && <Button variant="danger" onClick={() => run("cancel")}>{t("purchasing.action.cancel")}</Button>}
        </div>} />
      <ErrorLine error={action.error} />
      <Section title={t("common.status")}><StatusStepper steps={PAY_STEP_KEYS.map((k) => ({ key: k, label: stepLabel(t, k) }))} current={status} /></Section>
      <Section title={t("purchasing.payment.dataTitle")}>
        <KV items={[
          { label: t("purchasing.payment.amount"), value: formatCurrency(n(o.amount)) }, { label: t("purchasing.payment.allocated"), value: formatCurrency(n(o.allocated_amount)) },
          { label: t("purchasing.payment.method"), value: s(o.payment_method) }, { label: t("purchasing.col.supplier"), value: s(o.supplier_id) }, { label: t("purchasing.field.version"), value: s(o.version) },
        ]} />
      </Section>
      <Section icon={Wallet} title={t("purchasing.payment.allocationsTitle")}>
        {allocations.length === 0 ? <div className="p-5 text-sm text-slate-400">{t("purchasing.payment.allocationsEmpty")}</div> : (
          <Table head={<><Th>{t("purchasing.payment.colInvoice")}</Th><Th>{t("purchasing.col.date")}</Th><Th left>{t("purchasing.payment.colAllocatedAmount")}</Th></>}>
            {allocations.map((a, i) => <tr key={i}><Td>{s(a.supplier_invoice_id)}</Td><Td>{formatDate(s(a.allocation_date, ""))}</Td><Td left bold>{formatCurrency(n(a.allocated_amount))}</Td></tr>)}
          </Table>
        )}
      </Section>
      <GLPanel journalId={s(o.gl_journal_id, "") || null} />
      <TimelinePanel entity="payments" id={id} />
    </PrintDocument>
  );
}

// ── Purchase Return ─────────────────────────────────────────────────────────
const RET_STEP_KEYS = ["draft", "approved", "posted", "settled"];
export function ReturnDetailPage() {
  const t = useT();
  const [sp] = useSearchParams();
  const id = sp.get("doc") ?? "";
  const { data, isLoading, isError, error, refetch } = useReturn(id);
  const canApprove = useCan("procurement.approve");
  const o = (data ?? {}) as Record<string, unknown>;
  const { run, action } = useRun("returns", id, n(o.version) || 1, refetch);
  if (isLoading) return <LoadingState />;
  if (isError || !data) return <ErrorState error={error} onRetry={() => refetch()} />;
  const status = s(o.status, "draft");
  const lines = (o.lines ?? []) as Record<string, unknown>[];
  return (
    <PrintDocument className="grid gap-6 print:gap-4" title={s(o.return_number)}>
      <BackLink to="/purchasing/returns" label={t("purchasing.tabs.returns")} />
      <DetailHeader eyebrow={t("purchasing.return.eyebrow")} title={s(o.return_number)} subtitle={`${st(t, s(o.phase))} · ${formatCurrency(n(o.total))}`} status={status}
        actions={<div className="flex flex-wrap gap-2 print:hidden">
          {canApprove && status === "draft" && <Button onClick={() => run("approve")}>{t("purchasing.action.approve")}</Button>}
          {canApprove && status === "approved" && <Button onClick={() => run("post")}>{t("purchasing.action.post")}</Button>}
          {canApprove && status === "posted" && <Button variant="secondary" onClick={() => run("reverse")}>{t("purchasing.action.reverse")}</Button>}
        </div>} />
      <ErrorLine error={action.error} />
      <Section title={t("common.status")}><StatusStepper steps={RET_STEP_KEYS.map((k) => ({ key: k, label: stepLabel(t, k) }))} current={status} /></Section>
      <Section title={t("purchasing.return.dataTitle")}>
        <KV items={[
          { label: t("purchasing.return.phase"), value: st(t, s(o.phase)) }, { label: t("purchasing.return.receipt"), value: s(o.receipt_id) }, { label: t("purchasing.return.invoice"), value: s(o.invoice_id) },
          { label: t("purchasing.field.warehouse"), value: s(o.warehouse_id) }, { label: t("purchasing.field.net"), value: formatCurrency(n(o.subtotal)) }, { label: t("purchasing.field.vat"), value: formatCurrency(n(o.vat_amount)) },
        ]} />
      </Section>
      <Section icon={Undo2} title={t("purchasing.lines.title")}>
        <Table head={<><Th>{t("purchasing.col.item")}</Th><Th left>{t("purchasing.lines.qty")}</Th><Th left>{t("purchasing.return.colCost")}</Th><Th left>{t("purchasing.col.total")}</Th></>}>
          {lines.map((l, i) => <tr key={i}><Td>{s(l.item_name_snapshot, s(l.item_id))}</Td><Td left>{n(l.base_qty)}</Td><Td left>{formatCurrency(n(l.base_unit_cost))}</Td><Td left bold>{formatCurrency(n(l.line_total))}</Td></tr>)}
        </Table>
      </Section>
      <GLPanel journalId={s(o.gl_journal_id, "") || null} />
      <TimelinePanel entity="returns" id={id} />
    </PrintDocument>
  );
}
