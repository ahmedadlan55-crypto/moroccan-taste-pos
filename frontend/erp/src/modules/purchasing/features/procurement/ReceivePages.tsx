// استلام البضاعة (GRN) — الشاشتان اللتان كانتا ناقصتين تمامًا:
//   • ReceivePickerPage  → «/purchasing/receiving?new=1»  اختيار أمر شراء مفتوح
//   • ReceiveCreatePage  → «/purchasing/receiving?po=<id>» نموذج الاستلام نفسه
//
// The backend (POST /api/procurement/receipts) and useCreateReceipt() both
// existed; nothing ever called them, so goods receiving was unreachable from
// the UI. This is that control.
//
// Two deliberate contracts:
//   1. `warehouseId` is sent ONLY when it differs from the PO's — the server
//      inherits the PO's warehouse otherwise (routes/procurement/receipts.js),
//      and the scope guard runs on whichever value is finally used. Restating
//      it here would just be a second source of truth for the same fact.
//   2. Over-receipt is NOT re-implemented client-side. The server refuses it
//      (OVER_RECEIPT, services/procurement/InventoryPostingService.js) against
//      a LOCKED po_lines row, which is the only place the check can be race-
//      free. The form shows each line's remaining quantity and surfaces the
//      server's refusal verbatim.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { PackageCheck } from "lucide-react";
import { PageHeader, PanelTitle } from "@/shared/ui";
import { Button } from "@/shared/ui";
import { StatusBadge } from "@/shared/ui";
import { LoadingState, ErrorState, EmptyState } from "@/shared/ui";
import { formatCurrency, formatDate } from "@/shared/lib";
import { useCan } from "@/modules/inventory/lib/permission-provider";
import { useT, translateApiError } from "@/i18n";
import { useOrder, useOrders, useCreateReceipt } from "@/modules/inventory/lib/hooks/useProcurement";
import { useWarehouses } from "@/modules/inventory/lib/hooks/useWarehouses";
import { st } from "./labels";

/** Statuses of a PO that still has (or may have) goods coming in. */
export const RECEIVABLE_PO_STATUSES = ["approved", "sent", "partially_received"] as const;
export function isReceivable(status: unknown): boolean {
  return (RECEIVABLE_PO_STATUSES as readonly string[]).includes(String(status ?? ""));
}
/** The receiving form for one purchase order. */
export function receivePath(poId: string): string {
  return `/purchasing/receiving?po=${encodeURIComponent(poId)}`;
}

function s(v: unknown, d = ""): string { return v == null || v === "" ? d : String(v); }
function n(v: unknown, d = 0): number { const x = Number(v); return Number.isFinite(x) ? x : d; }
/** Trim binary-float noise (84/12 → 7, not 6.999999999999999) without lying about precision. */
function round4(x: number): number { return Math.round(x * 1e4) / 1e4; }

interface Row {
  poLineId: string;
  itemId: string;
  itemName: string;
  unitCode: string;
  factor: number;
  orderedBase: number;
  receivedBase: number;
  remainingBase: number;
  qty: number;        // in the PO line's ENTERED unit
  unitCost: number;   // per ENTERED unit — same basis the PO was priced in
  lotNo: string;
  expiryDate: string;
}

/** PO line → editable receiving row, defaulted to everything still outstanding. */
function toRow(l: Record<string, unknown>): Row {
  const factor = n(l.conversion_factor_snapshot, 1) || 1;
  const orderedBase = n(l.base_qty);
  const receivedBase = n(l.base_received_qty);
  const remainingBase = round4(Math.max(0, orderedBase - receivedBase));
  // The PO priced the ENTERED unit; fall back to the base price × factor, then
  // to the legacy per-unit column, so a line from any era still carries a cost.
  const unitCost = n(l.unit_price_entered) || round4(n(l.base_unit_price) * factor) || n(l.unit_price);
  return {
    poLineId: s(l.id),
    itemId: s(l.item_id),
    itemName: s(l.item_name, s(l.item_id)),
    unitCode: s(l.entered_unit_code),
    factor,
    orderedBase,
    receivedBase,
    remainingBase,
    qty: round4(remainingBase / factor),
    unitCost,
    lotNo: "",
    expiryDate: "",
  };
}

export function ReceiveCreatePage() {
  const t = useT();
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const poId = sp.get("po") ?? "";
  const { data, isLoading, isError, error, refetch } = useOrder(poId);
  const { data: whData } = useWarehouses();
  const create = useCreateReceipt();
  const canReceive = useCan("procurement.manage");

  const o = useMemo(() => (data ?? {}) as Record<string, unknown>, [data]);
  const poWarehouse = s(o.warehouse_id);
  const openLines = useMemo(
    () => ((o.lines ?? []) as Record<string, unknown>[]).map(toRow).filter((r) => r.remainingBase > 0),
    [o],
  );

  const [rows, setRows] = useState<Row[]>([]);
  const [warehouse, setWarehouse] = useState("");
  const [receiptDate, setReceiptDate] = useState(() => new Date().toISOString().slice(0, 10));
  // Seed ONCE per purchase order. Seeding on every `data` identity change would
  // hand the form back to the server on any background refetch (window focus,
  // an invalidation from a sibling mutation) and silently discard quantities
  // the user had already typed. Navigating to another PO re-seeds.
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (!data || seededFor.current === poId) return;
    seededFor.current = poId;
    setRows(openLines);
    setWarehouse(poWarehouse);
  }, [data, poId, openLines, poWarehouse]);

  const patch = (i: number, p: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const active = rows.filter((r) => r.qty > 0);
  const previewTotal = active.reduce((sum, r) => sum + r.qty * r.unitCost, 0);

  function submit() {
    const body: Record<string, unknown> = {
      poId,
      receiptDate,
      lines: active.map((r) => ({
        itemId: r.itemId,
        itemName: r.itemName,
        poLineId: r.poLineId,
        enteredQty: r.qty,
        factor: r.factor,
        enteredUnitCode: r.unitCode || undefined,
        unitCost: r.unitCost,
        ...(r.lotNo ? { lotNo: r.lotNo } : {}),
        ...(r.expiryDate ? { expiryDate: r.expiryDate } : {}),
      })),
    };
    const supplierId = s(o.supplier_id);
    if (supplierId) body.supplierId = supplierId;
    // Only an OVERRIDE travels. Unchanged, the server inherits the PO's.
    if (warehouse && warehouse !== poWarehouse) body.warehouseId = warehouse;
    create.mutate(body, {
      onSuccess: (r) => {
        const id = r?.data?.id;
        nav(id ? `/purchasing/receiving?doc=${id}` : "/purchasing/receiving");
      },
    });
  }

  if (isLoading) return <LoadingState />;
  if (isError || !data) return <ErrorState error={error} onRetry={() => refetch()} />;

  const status = s(o.status, "draft");
  const blocked = !isReceivable(status);
  const needsWarehouse = !warehouse;

  return (
    <div className="grid gap-6">
      <Link to={`/purchasing/orders?doc=${poId}`} className="text-sm font-bold text-teal-700 hover:underline">← {s(o.po_number, t("purchasing.tabs.orders"))}</Link>
      <PageHeader eyebrow={t("purchasing.receive.eyebrow")} title={t("purchasing.receive.title")} subtitle={`${s(o.po_number)} · ${s(o.supplier_name)}`} />

      {blocked ? (
        <EmptyState title={t("purchasing.receive.notReceivableTitle")} body={`${t("purchasing.receive.notReceivableBody")} (${st(t, status)})`} />
      ) : (
        <>
          <section className="surface p-5">
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label className="mb-1 block text-xs font-extrabold text-slate-500" htmlFor="rcv-date">{t("purchasing.receive.dateLabel")}</label>
                <input id="rcv-date" type="date" className="field w-full" value={receiptDate} onChange={(e) => setReceiptDate(e.target.value)} />
              </div>
              <div>
                <label className="mb-1 block text-xs font-extrabold text-slate-500" htmlFor="rcv-wh">{t("purchasing.field.warehouse")}</label>
                <input
                  id="rcv-wh" className="field w-full" list="rcv-wh-options" value={warehouse}
                  onChange={(e) => setWarehouse(e.target.value)} placeholder={t("purchasing.receive.warehousePlaceholder")}
                />
                <datalist id="rcv-wh-options">
                  {(whData?.warehouses ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                </datalist>
                <p className="mt-1 text-[11px] font-semibold text-slate-400">
                  {poWarehouse ? t("purchasing.receive.warehouseFromPo") : t("purchasing.receive.warehouseMissingOnPo")}
                </p>
              </div>
              <div>
                <label className="mb-1 block text-xs font-extrabold text-slate-500">{t("common.status")}</label>
                <div className="pt-2"><StatusBadge>{st(t, status)}</StatusBadge></div>
              </div>
            </div>
          </section>

          <section className="surface overflow-hidden">
            <PanelTitle icon={PackageCheck} title={t("purchasing.receive.linesTitle")} subtitle={t("purchasing.receive.linesSubtitle")} />
            {rows.length === 0 ? (
              <div className="p-6"><EmptyState title={t("purchasing.receive.noOpenLines")} body={t("purchasing.receive.noOpenLinesBody")} /></div>
            ) : (
              <>
                <div className="grid gap-4 p-4">
                  {rows.map((r, i) => (
                    <div key={r.poLineId} className="grid gap-3 rounded-xl border border-slate-200 p-3 lg:grid-cols-[2fr_1.2fr_1fr_1fr_1fr]">
                      <div>
                        <div className="text-sm font-bold text-slate-800">{r.itemName}</div>
                        <div className="mt-1 text-[11px] font-semibold text-slate-400 tabular-nums">
                          {t("purchasing.receive.ordered")} {r.orderedBase} · {t("purchasing.lines.received")} {r.receivedBase} · <span className="font-extrabold text-teal-700">{t("purchasing.receive.remaining")} {r.remainingBase}</span>
                        </div>
                      </div>
                      <div>
                        <label className="mb-1 block text-[11px] font-bold text-slate-400" htmlFor={`rcv-qty-${i}`}>
                          {t("purchasing.receive.qtyLabel")} {r.unitCode && <span className="text-slate-500">({r.unitCode})</span>}
                        </label>
                        <input
                          id={`rcv-qty-${i}`} type="number" min={0} step="0.0001" className="field w-full tabular-nums"
                          aria-label={`${t("purchasing.receive.qtyLabel")} — ${r.itemName}`}
                          value={r.qty} onChange={(e) => patch(i, { qty: Number(e.target.value) })}
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-[11px] font-bold text-slate-400" htmlFor={`rcv-cost-${i}`}>{t("purchasing.lines.unitCost")}</label>
                        <input
                          id={`rcv-cost-${i}`} type="number" min={0} step="0.0001" className="field w-full tabular-nums"
                          value={r.unitCost} onChange={(e) => patch(i, { unitCost: Number(e.target.value) })}
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-[11px] font-bold text-slate-400" htmlFor={`rcv-lot-${i}`}>{t("purchasing.lines.lot")}</label>
                        <input id={`rcv-lot-${i}`} className="field w-full" value={r.lotNo} onChange={(e) => patch(i, { lotNo: e.target.value })} placeholder={t("purchasing.common.optional")} />
                      </div>
                      <div>
                        <label className="mb-1 block text-[11px] font-bold text-slate-400" htmlFor={`rcv-exp-${i}`}>{t("purchasing.lines.expiry")}</label>
                        <input id={`rcv-exp-${i}`} type="date" className="field w-full" value={r.expiryDate} onChange={(e) => patch(i, { expiryDate: e.target.value })} />
                      </div>
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-5 py-4">
                  <div className="text-sm text-slate-500">
                    {t("purchasing.orderCreate.previewLabel")}: <b className="tabular-nums text-teal-700">{formatCurrency(previewTotal)}</b>
                  </div>
                  <Button disabled={!canReceive || create.isPending || active.length === 0 || needsWarehouse} onClick={submit}>
                    {create.isPending ? t("purchasing.receive.submitting") : t("purchasing.receive.submit")}
                  </Button>
                </div>
                {create.isError && (
                  <p className="mx-5 mb-4 rounded-xl bg-rose-50 px-4 py-2 text-sm font-semibold text-rose-600">{translateApiError(create.error, t)}</p>
                )}
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}

/** «من أي أمر شراء؟» — the way into receiving from the receipts list. */
export function ReceivePickerPage() {
  const t = useT();
  // The list endpoint filters ONE status at a time, so ask for each receivable
  // status and merge. A fixed-length list keeps the hook order stable.
  const approved = useOrders({ status: "approved", page: 1, pageSize: 50 });
  const sent = useOrders({ status: "sent", page: 1, pageSize: 50 });
  const partial = useOrders({ status: "partially_received", page: 1, pageSize: 50 });
  const queries = [approved, sent, partial];
  const isLoading = queries.some((q) => q.isLoading);
  const isError = queries.every((q) => q.isError);
  const rows = queries.flatMap((q) => q.data?.rows ?? []);

  return (
    <div className="grid gap-4">
      <Link to="/purchasing/receiving" className="text-sm font-bold text-teal-700 hover:underline">← {t("purchasing.receipts.title")}</Link>
      <PageHeader eyebrow={t("purchasing.receive.eyebrow")} title={t("purchasing.receive.pickerTitle")} subtitle={t("purchasing.receive.pickerSubtitle")} />
      {isLoading ? <LoadingState /> : isError ? (
        <ErrorState error={approved.error} onRetry={() => queries.forEach((q) => q.refetch())} />
      ) : rows.length === 0 ? (
        <EmptyState title={t("purchasing.receive.pickerEmptyTitle")} body={t("purchasing.receive.pickerEmptyBody")} />
      ) : (
        <div className="surface overflow-hidden"><div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead className="bg-slate-50"><tr>
              {[t("purchasing.col.number"), t("purchasing.col.supplier"), t("purchasing.col.date"), t("common.status"), t("purchasing.col.total")].map((h) => (
                <th key={h} className="px-3 py-2 text-right text-[11px] font-extrabold uppercase tracking-wide text-slate-400">{h}</th>
              ))}
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((o) => (
                <tr key={o.id} className="hover:bg-slate-50">
                  <td className="px-3 py-2.5 text-sm"><Link className="font-bold text-teal-700 hover:underline" to={receivePath(o.id)}>{o.poNumber}</Link></td>
                  <td className="px-3 py-2.5 text-sm text-slate-700">{o.supplierName}</td>
                  <td className="px-3 py-2.5 text-sm tabular-nums text-slate-700">{formatDate(o.poDate)}</td>
                  <td className="px-3 py-2.5 text-sm"><StatusBadge>{st(t, o.status)}</StatusBadge></td>
                  <td className="px-3 py-2.5 text-sm font-bold tabular-nums text-slate-700">{formatCurrency(o.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div></div>
      )}
    </div>
  );
}
