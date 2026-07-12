// Full procurement detail screens — Supplier, Purchase Order, Goods Receipt,
// Supplier Invoice (+ three-way match), Payment (+ allocations), Purchase Return.
// Each: header + status stepper + document body + status-driven action bar +
// GL journal + timeline + attachments + A4 print. Backend enforces permissions.
import { type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { FileText, PackageCheck, Receipt, Wallet, Undo2, Users } from "lucide-react";
import { MetricCard } from "@/modules/inventory/lib/MetricCard";
import { Button } from "@/shared/ui";
import { LoadingState, ErrorState, EmptyState } from "@/shared/ui";
import { formatCurrency, formatDate } from "@/shared/lib";
import { useCan } from "@/modules/inventory/lib/permission-provider";
import {
  useSupplier, useSupplierStatement, useSupplierAging,
  useOrder, useReceipt, useInvoice, usePayment, useReturn, useDocAction,
} from "@/modules/inventory/lib/hooks/useProcurement";
import { BackLink, DetailHeader, Section, KV, StatusStepper, TimelinePanel, GLPanel, AttachmentsPanel, ErrorLine } from "./detail-shared";
import { st } from "./labels";

function s(v: unknown, d = "—"): string { return v == null || v === "" ? d : String(v); }
function n(v: unknown): number { const x = Number(v); return Number.isFinite(x) ? x : 0; }
function Th({ children, left }: { children: ReactNode; left?: boolean }) { return <th className={`px-3 py-2 text-[11px] font-extrabold uppercase text-slate-400 ${left ? "text-left" : "text-right"}`}>{children}</th>; }
function Td({ children, left, bold }: { children: ReactNode; left?: boolean; bold?: boolean }) { return <td className={`px-3 py-2.5 text-sm text-slate-700 ${left ? "text-left tabular-nums" : ""} ${bold ? "font-bold" : ""}`}>{children}</td>; }
function Table({ head, children }: { head: ReactNode; children: ReactNode }) {
  return <div className="overflow-x-auto"><table className="w-full border-collapse"><thead className="bg-slate-50"><tr>{head}</tr></thead><tbody className="divide-y divide-slate-100">{children}</tbody></table></div>;
}

// ── Supplier ────────────────────────────────────────────────────────────────
export function SupplierDetailPage() {
  const [sp] = useSearchParams();
  const id = sp.get("doc") ?? "";
  const { data, isLoading, isError, error, refetch } = useSupplier(id);
  const statement = useSupplierStatement(id, {});
  const aging = useSupplierAging(id);
  if (isLoading) return <LoadingState />;
  if (isError || !data) return <ErrorState error={error} onRetry={() => refetch()} />;
  const d = data as Record<string, unknown>;
  const rows = (statement.data?.data ?? []) as Array<{ date: string; type: string; ref: string; debit: number; credit: number; balance: number }>;
  const b = aging.data?.buckets ?? { current: 0, d30: 0, d60: 0, d90: 0, d90plus: 0 };
  return (
    <div className="grid gap-6 print:gap-4">
      <BackLink to="/purchasing/suppliers" label="الموردون" />
      <DetailHeader eyebrow="مورد" title={s(d.name)} subtitle={s(d.vat_number, "")} status={Number(d.is_active) ? "" : "cancelled"} />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard label="الرصيد المستحق" value={formatCurrency(n(d.apBalance))} icon={Wallet} tone="violet" />
        <MetricCard label="إجمالي الفواتير" value={formatCurrency(n(d.invoicedTotal))} icon={FileText} tone="teal" />
        <MetricCard label="المسدد" value={formatCurrency(n(d.paidTotal))} icon={PackageCheck} tone="blue" />
        <MetricCard label="متأخر 90+" value={formatCurrency(n(b.d90plus))} icon={Receipt} tone="rose" />
      </div>
      <Section icon={Users} title="البيانات الأساسية">
        <KV items={[
          { label: "الاسم (EN)", value: s(d.name_en) }, { label: "الرقم الضريبي", value: s(d.vat_number) },
          { label: "الهاتف", value: s(d.phone) }, { label: "البريد", value: s(d.email) },
          { label: "المدينة", value: s(d.city) }, { label: "شروط الدفع", value: s(d.payment_terms) },
          { label: "أوامر", value: s((d.counts as Record<string, unknown>)?.orders) }, { label: "فواتير", value: s((d.counts as Record<string, unknown>)?.invoices) },
        ]} />
      </Section>
      <Section title="أعمار الذمم">
        <div className="grid grid-cols-5 gap-2 p-5 text-center">
          {[["جاري", b.current], ["1-30", b.d30], ["31-60", b.d60], ["61-90", b.d90], ["90+", b.d90plus]].map(([lbl, v]) => (
            <div key={lbl as string} className="rounded-xl border border-slate-100 bg-slate-50 py-3">
              <div className="text-[10px] font-bold text-slate-400">{lbl}</div>
              <div className="mt-1 text-sm font-extrabold tabular-nums text-slate-800">{formatCurrency(n(v))}</div>
            </div>
          ))}
        </div>
      </Section>
      <Section title="كشف الحساب" subtitle={`الرصيد الختامي: ${formatCurrency(statement.data?.closingBalance ?? 0)}`}>
        {rows.length === 0 ? <div className="p-5"><EmptyState title="لا حركات" /></div> : (
          <Table head={<><Th>التاريخ</Th><Th>النوع</Th><Th>المرجع</Th><Th left>مدين</Th><Th left>دائن</Th><Th left>الرصيد</Th></>}>
            {rows.map((r, i) => (
              <tr key={i}><Td>{formatDate(r.date)}</Td><Td>{r.type === "invoice" ? "فاتورة" : "سداد"}</Td><Td>{r.ref}</Td>
                <Td left>{r.debit ? formatCurrency(r.debit) : "—"}</Td><Td left>{r.credit ? formatCurrency(r.credit) : "—"}</Td><Td left bold>{formatCurrency(r.balance)}</Td></tr>
            ))}
          </Table>
        )}
      </Section>
    </div>
  );
}

// ── generic action runner ─────────────────────────────────────────────────
function useRun(entity: "orders" | "receipts" | "invoices" | "payments" | "returns", id: string, version: number, refetch: () => void) {
  const action = useDocAction(entity);
  const run = (act: string, body?: Record<string, unknown>) => action.mutate({ id, action: act, body, expectedVersion: version }, { onSuccess: () => refetch() });
  return { run, action };
}

// ── Purchase Order ──────────────────────────────────────────────────────────
const PO_STEPS = [{ key: "draft", label: "مسودة" }, { key: "submitted", label: "مُقدّم" }, { key: "approved", label: "معتمد" }, { key: "sent", label: "مُرسل" }, { key: "partially_received", label: "استلام جزئي" }, { key: "fully_received", label: "مستلم" }, { key: "closed", label: "مغلق" }];
export function OrderDetailPage() {
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
    <div className="grid gap-6 print:gap-4">
      <BackLink to="/purchasing/orders" label="أوامر الشراء" />
      <DetailHeader eyebrow="أمر شراء" title={s(o.po_number)} subtitle={s(o.supplier_name)} status={status}
        actions={<div className="flex flex-wrap gap-2 print:hidden">
          {canManage && status === "draft" && <Button onClick={() => run("submit")}>تقديم</Button>}
          {canApprove && status === "submitted" && <Button onClick={() => run("approve")}>اعتماد</Button>}
          {canApprove && status === "approved" && <Button variant="secondary" onClick={() => run("send")}>إرسال</Button>}
          {canApprove && ["approved", "sent", "fully_received"].includes(status) && <Button variant="secondary" onClick={() => run("close")}>إغلاق</Button>}
          {canApprove && ["draft", "submitted", "approved"].includes(status) && <Button variant="danger" onClick={() => run("cancel")}>إلغاء</Button>}
        </div>} />
      <ErrorLine error={action.error} />
      <Section title="الحالة"><StatusStepper steps={PO_STEPS} current={status === "received" ? "fully_received" : status} /></Section>
      <Section title="بيانات الأمر">
        <KV items={[
          { label: "التاريخ", value: formatDate(s(o.po_date, "")) }, { label: "التوريد المتوقع", value: formatDate(s(o.expected_date, "")) },
          { label: "العملة", value: s(o.currency) }, { label: "الإصدار", value: s(o.version) },
          { label: "صافي", value: formatCurrency(n(o.total_before_vat)) }, { label: "ضريبة", value: formatCurrency(n(o.vat_amount)) },
          { label: "الإجمالي", value: formatCurrency(n(o.total_after_vat)) }, { label: "أنشأه", value: s(o.created_by) },
        ]} />
      </Section>
      <Section icon={FileText} title="السطور">
        <Table head={<><Th>المادة</Th><Th left>المدخلة</Th><Th left>الأساسية</Th><Th left>المستلم</Th><Th left>السعر</Th><Th left>الإجمالي</Th></>}>
          {lines.map((l, i) => (
            <tr key={i}><Td>{s(l.item_name)}</Td><Td left>{n(l.entered_qty)} {s(l.entered_unit_code, "")}</Td><Td left>{n(l.base_qty)}</Td>
              <Td left>{n(l.base_received_qty)}</Td><Td left>{formatCurrency(n(l.unit_price))}</Td><Td left bold>{formatCurrency(n(l.total))}</Td></tr>
          ))}
        </Table>
      </Section>
      <Section icon={PackageCheck} title="الاستلامات">
        {receipts.length === 0 ? <div className="p-5 text-sm text-slate-400">لا استلامات.</div> : (
          <Table head={<><Th>الرقم</Th><Th>التاريخ</Th><Th>الحالة</Th><Th left>الإجمالي</Th></>}>
            {receipts.map((r, i) => <tr key={i}><Td>{s(r.receipt_number)}</Td><Td>{formatDate(s(r.receipt_date, ""))}</Td><Td>{st(s(r.status))}</Td><Td left bold>{formatCurrency(n(r.total))}</Td></tr>)}
          </Table>
        )}
      </Section>
      {invoices.length > 0 && (
        <Section icon={Receipt} title="الفواتير">
          <Table head={<><Th>الرقم</Th><Th>الحالة</Th><Th left>الإجمالي</Th></>}>
            {invoices.map((r, i) => <tr key={i}><Td>{s(r.invoice_no, s(r.code))}</Td><Td>{st(s(r.status))}</Td><Td left bold>{formatCurrency(n(r.total_amount))}</Td></tr>)}
          </Table>
        </Section>
      )}
      <TimelinePanel entity="orders" id={id} />
    </div>
  );
}

// ── Goods Receipt ───────────────────────────────────────────────────────────
const GRN_STEPS = [{ key: "draft", label: "مسودة" }, { key: "approved", label: "معتمد" }, { key: "posted", label: "مُرحّل" }];
export function ReceiptDetailPage() {
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
    <div className="grid gap-6 print:gap-4">
      <BackLink to="/purchasing/receiving" label="الاستلامات" />
      <DetailHeader eyebrow="استلام بضاعة" title={s(o.receipt_number)} subtitle={s(o.supplier_name_snapshot)} status={status}
        actions={<div className="flex flex-wrap gap-2 print:hidden">
          {canApprove && status === "draft" && <Button onClick={() => run("approve")}>اعتماد</Button>}
          {canApprove && status === "approved" && <Button onClick={() => run("post")}>ترحيل (المخزون + GRNI)</Button>}
          {canApprove && status === "posted" && <Button variant="secondary" onClick={() => run("reverse")}>عكس</Button>}
          {canApprove && ["draft", "approved"].includes(status) && <Button variant="danger" onClick={() => run("cancel")}>إلغاء</Button>}
        </div>} />
      <ErrorLine error={action.error} />
      <Section title="الحالة"><StatusStepper steps={GRN_STEPS} current={status} /></Section>
      <Section title="بيانات الاستلام">
        <KV items={[
          { label: "التاريخ", value: formatDate(s(o.receipt_date, "")) }, { label: "المستودع", value: s(o.warehouse_id) },
          { label: "أمر الشراء", value: s(o.po_id) }, { label: "الإجمالي", value: formatCurrency(n(o.total)) }, { label: "الإصدار", value: s(o.version) },
        ]} />
      </Section>
      <Section icon={PackageCheck} title="السطور">
        <Table head={<><Th>المادة</Th><Th left>المدخلة</Th><Th left>الأساسية</Th><Th left>تكلفة الوحدة</Th><Th>الدفعة</Th><Th>الصلاحية</Th><Th left>الإجمالي</Th></>}>
          {lines.map((l, i) => (
            <tr key={i}><Td>{s(l.item_id)}</Td><Td left>{n(l.entered_qty)} {s(l.entered_unit_code, "")}</Td><Td left>{n(l.base_qty)}</Td>
              <Td left>{formatCurrency(n(l.base_unit_cost))}</Td><Td>{s(l.lot_no)}</Td><Td>{l.expiry_date ? formatDate(s(l.expiry_date, "")) : "—"}</Td><Td left bold>{formatCurrency(n(l.line_total))}</Td></tr>
          ))}
        </Table>
      </Section>
      <GLPanel journalId={s(o.gl_journal_id, "") || null} />
      <TimelinePanel entity="receipts" id={id} />
    </div>
  );
}

// ── Supplier Invoice + three-way match ──────────────────────────────────────
const INV_STEPS = [{ key: "draft", label: "مسودة" }, { key: "pending_review", label: "مراجعة" }, { key: "approved", label: "معتمد" }, { key: "paid", label: "مسدد" }];
export function InvoiceDetailPage() {
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
    <div className="grid gap-6 print:gap-4">
      <BackLink to="/purchasing/invoices" label="الفواتير" />
      <DetailHeader eyebrow="فاتورة مورد" title={s(o.invoice_no, s(o.code))} subtitle={`${s(o.supplier_name)} · مطابقة: ${st(matchStatus)}`} status={status}
        actions={<div className="flex flex-wrap gap-2 print:hidden">
          {canManage && ["draft", "pending_review"].includes(status) && <Button variant="secondary" onClick={() => run("match")}>مطابقة ثلاثية</Button>}
          {canManage && status === "draft" && <Button onClick={() => run("submit")}>تقديم</Button>}
          {canApprove && ["pending_review", "pending_approval"].includes(status) && <Button onClick={() => run("approve")}>اعتماد (GRNI/AP)</Button>}
          {canApprove && ["approved", "partially_paid"].includes(status) && <Button variant="secondary" onClick={() => run("credit-note")}>إشعار دائن</Button>}
          {canManage && status === "draft" && <Button variant="danger" onClick={() => run("cancel")}>إلغاء</Button>}
        </div>} />
      <ErrorLine error={action.error} />
      <Section title="الحالة"><StatusStepper steps={INV_STEPS} current={["partially_paid"].includes(status) ? "approved" : status} /></Section>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard label="الإجمالي" value={formatCurrency(n(o.total_amount))} icon={Receipt} tone="teal" />
        <MetricCard label="المسدد" value={formatCurrency(n(o.paid_amount))} icon={Wallet} tone="blue" />
        <MetricCard label="المتبقي" value={formatCurrency(n(o.balance_amount))} icon={Wallet} tone="violet" />
        <MetricCard label="الضريبة" value={formatCurrency(n(o.vat_amount))} icon={FileText} tone="amber" />
      </div>
      <Section icon={FileText} title="السطور">
        <Table head={<><Th>الوصف</Th><Th left>الكمية</Th><Th left>السعر</Th><Th left>الضريبة%</Th><Th left>الإجمالي</Th></>}>
          {lines.map((l, i) => <tr key={i}><Td>{s(l.description)}</Td><Td left>{n(l.quantity)}</Td><Td left>{formatCurrency(n(l.unit_price))}</Td><Td left>{s(l.vat_pct)}</Td><Td left bold>{formatCurrency(n(l.line_total))}</Td></tr>)}
        </Table>
      </Section>
      <Section title="المطابقة الثلاثية (PO ↔ استلام ↔ فاتورة)">
        {matches.length === 0 ? <div className="p-5 text-sm text-slate-400">لم تُجرَ المطابقة بعد — اضغط «مطابقة ثلاثية».</div> : (
          <Table head={<><Th>سطر الاستلام</Th><Th left>الكمية المطابقة</Th><Th left>القيمة</Th><Th left>فرق السعر</Th><Th left>فرق الكمية</Th></>}>
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
    </div>
  );
}

// ── Payment + allocations ───────────────────────────────────────────────────
const PAY_STEPS = [{ key: "requested", label: "مطلوب" }, { key: "authorized", label: "مُخوّل" }, { key: "paid", label: "مسدد" }, { key: "closed", label: "مغلق" }];
export function PaymentDetailPage() {
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
    <div className="grid gap-6 print:gap-4">
      <BackLink to="/purchasing/payments" label="المدفوعات" />
      <DetailHeader eyebrow="سداد مورد" title={s(o.payment_number)} subtitle={`${s(o.payment_method)} · ${formatCurrency(n(o.amount))}`} status={status}
        actions={<div className="flex flex-wrap gap-2 print:hidden">
          {canApprove && status === "requested" && <Button onClick={() => run("authorize")}>تخويل</Button>}
          {canApprove && status === "authorized" && <Button onClick={() => run("pay")}>تنفيذ السداد</Button>}
          {canApprove && status === "paid" && <Button variant="secondary" onClick={() => run("close")}>إغلاق</Button>}
          {canApprove && ["paid", "closed"].includes(status) && <Button variant="danger" onClick={() => run("reverse")}>عكس</Button>}
          {canApprove && ["requested", "authorized"].includes(status) && <Button variant="danger" onClick={() => run("cancel")}>إلغاء</Button>}
        </div>} />
      <ErrorLine error={action.error} />
      <Section title="الحالة"><StatusStepper steps={PAY_STEPS} current={status} /></Section>
      <Section title="بيانات السداد">
        <KV items={[
          { label: "المبلغ", value: formatCurrency(n(o.amount)) }, { label: "المخصص", value: formatCurrency(n(o.allocated_amount)) },
          { label: "الطريقة", value: s(o.payment_method) }, { label: "المورد", value: s(o.supplier_id) }, { label: "الإصدار", value: s(o.version) },
        ]} />
      </Section>
      <Section icon={Wallet} title="التخصيصات">
        {allocations.length === 0 ? <div className="p-5 text-sm text-slate-400">لا تخصيصات.</div> : (
          <Table head={<><Th>الفاتورة</Th><Th>التاريخ</Th><Th left>المبلغ المخصص</Th></>}>
            {allocations.map((a, i) => <tr key={i}><Td>{s(a.supplier_invoice_id)}</Td><Td>{formatDate(s(a.allocation_date, ""))}</Td><Td left bold>{formatCurrency(n(a.allocated_amount))}</Td></tr>)}
          </Table>
        )}
      </Section>
      <GLPanel journalId={s(o.gl_journal_id, "") || null} />
      <TimelinePanel entity="payments" id={id} />
    </div>
  );
}

// ── Purchase Return ─────────────────────────────────────────────────────────
const RET_STEPS = [{ key: "draft", label: "مسودة" }, { key: "approved", label: "معتمد" }, { key: "posted", label: "مُرحّل" }, { key: "settled", label: "مُسوّى" }];
export function ReturnDetailPage() {
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
    <div className="grid gap-6 print:gap-4">
      <BackLink to="/purchasing/returns" label="المرتجعات" />
      <DetailHeader eyebrow="مرتجع شراء" title={s(o.return_number)} subtitle={`${st(s(o.phase))} · ${formatCurrency(n(o.total))}`} status={status}
        actions={<div className="flex flex-wrap gap-2 print:hidden">
          {canApprove && status === "draft" && <Button onClick={() => run("approve")}>اعتماد</Button>}
          {canApprove && status === "approved" && <Button onClick={() => run("post")}>ترحيل</Button>}
          {canApprove && status === "posted" && <Button variant="secondary" onClick={() => run("reverse")}>عكس</Button>}
        </div>} />
      <ErrorLine error={action.error} />
      <Section title="الحالة"><StatusStepper steps={RET_STEPS} current={status} /></Section>
      <Section title="بيانات المرتجع">
        <KV items={[
          { label: "المرحلة", value: st(s(o.phase)) }, { label: "الاستلام", value: s(o.receipt_id) }, { label: "الفاتورة", value: s(o.invoice_id) },
          { label: "المستودع", value: s(o.warehouse_id) }, { label: "صافي", value: formatCurrency(n(o.subtotal)) }, { label: "ضريبة", value: formatCurrency(n(o.vat_amount)) },
        ]} />
      </Section>
      <Section icon={Undo2} title="السطور">
        <Table head={<><Th>المادة</Th><Th left>الكمية</Th><Th left>التكلفة</Th><Th left>الإجمالي</Th></>}>
          {lines.map((l, i) => <tr key={i}><Td>{s(l.item_name_snapshot, s(l.item_id))}</Td><Td left>{n(l.base_qty)}</Td><Td left>{formatCurrency(n(l.base_unit_cost))}</Td><Td left bold>{formatCurrency(n(l.line_total))}</Td></tr>)}
        </Table>
      </Section>
      <GLPanel journalId={s(o.gl_journal_id, "") || null} />
      <TimelinePanel entity="returns" id={id} />
    </div>
  );
}
