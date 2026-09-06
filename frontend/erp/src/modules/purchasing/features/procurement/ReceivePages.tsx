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
//   3. Landed cost. Freight/customs/insurance/handling charges ride the same
//      POST as `charges[]` and are previewed here with the SAME allocation
//      rule the server posts with (allocateReceiptCharges in the adapter):
//      by value or by qty, 4 dp, residual on the largest line. A line with no
//      charges shows "—" for its landed unit cost — never 0, which would read
//      as a real cost of nothing. The detail screen mounts
//      ReceiptLandedCostPanel (below) for the same figures read back from the
//      server, and edits them via PUT /receipts/:id/charges while the receipt
//      is still draft/approved.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { PackageCheck, Plus, Ship, Trash2 } from "lucide-react";
import { PageHeader, PanelTitle } from "@/shared/ui";
import { Button } from "@/shared/ui";
import { StatusBadge } from "@/shared/ui";
import { DatePicker } from "@/shared/ui";
import { Select } from "@/shared/ui";
import { SearchableEntityCombobox } from "@/shared/ui";
import { LoadingState, ErrorState, EmptyState } from "@/shared/ui";
import { formatCurrency, formatDate, formatNumber } from "@/shared/lib";
import { useCan } from "@/modules/inventory/lib/permission-provider";
import { useT, translateApiError } from "@/i18n";
import {
  useOrder, useOrders, useCreateReceipt, useReceipt, useUpdateReceiptCharges, supplierFetcher,
} from "@/modules/inventory/lib/hooks/useProcurement";
import { useWarehouses } from "@/modules/inventory/lib/hooks/useWarehouses";
import {
  RECEIPT_CHARGE_TYPES, allocateReceiptCharges, toPurchaseReceipt, toSupplier,
  type AllocatableLine, type ChargeAllocationMethod, type ReceiptCharge, type ReceiptChargeInput, type ReceiptChargeType, type Supplier,
} from "@/modules/inventory/lib/adapters/procurement.adapter";
import { Section, KV } from "./detail-shared";
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
/**
 * Receipt statuses whose charges may still be replaced — mirrors
 * CHARGES_EDITABLE in routes/procurement/receipts.js. Past these the landed
 * values have entered inventory and the ledger and the server answers 409
 * RECEIPT_CHARGES_LOCKED; the UI shows the reason instead of an editor.
 */
export const CHARGES_EDITABLE_STATUSES = ["draft", "approved"] as const;
export function chargesEditable(status: unknown): boolean {
  return (CHARGES_EDITABLE_STATUSES as readonly string[]).includes(String(status ?? ""));
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

// ── Landed cost: charge rows ────────────────────────────────────────────────
// One editable row per charge. The same editor serves the create form (rows
// travel in the POST) and the detail panel (rows replace the set via PUT), so
// the two can never disagree about what a charge is.
export interface ChargeDraft {
  key: string;
  chargeType: ReceiptChargeType;
  description: string;
  supplier: Supplier | null;
  /** Net of VAT — the amount that enters the goods cost. */
  amount: number;
  /** Recoverable input VAT — travels with the charge, never into the cost. */
  vatAmount: number;
  allocationMethod: ChargeAllocationMethod;
}
let chargeSeq = 0;
export function newChargeDraft(p: Partial<ChargeDraft> = {}): ChargeDraft {
  return { key: `C${++chargeSeq}`, chargeType: "freight", description: "", supplier: null, amount: 0, vatAmount: 0, allocationMethod: "value", ...p };
}
/** A stored charge → an editable row (the vendor is rebuilt from id + snapshot name). */
export function chargeDraftFromServer(c: ReceiptCharge): ChargeDraft {
  return newChargeDraft({
    chargeType: c.chargeType,
    description: c.description,
    supplier: c.supplierId ? toSupplier({ id: c.supplierId, name: c.supplierName || c.supplierId }) : null,
    amount: c.amount,
    vatAmount: c.vatAmount,
    allocationMethod: c.allocationMethod,
  });
}
/** The server 422s a charge with amount <= 0 or vatAmount < 0; refuse to send one. */
export function chargeDraftValid(c: ChargeDraft): boolean {
  return Number.isFinite(c.amount) && c.amount > 0 && Number.isFinite(c.vatAmount) && c.vatAmount >= 0;
}
/** Row → the wire shape of the contract. Optional fields are omitted, not sent as "". */
export function toChargeInput(c: ChargeDraft): ReceiptChargeInput {
  const description = c.description.trim();
  return {
    chargeType: c.chargeType,
    ...(description ? { description } : {}),
    ...(c.supplier ? { supplierId: c.supplier.id } : {}),
    amount: c.amount,
    vatAmount: c.vatAmount,
    allocationMethod: c.allocationMethod,
  };
}
/** Only the rows the server would accept take part in the preview — a 0 charge allocates nothing. */
export function chargeInputsForPreview(rows: ChargeDraft[]): Array<{ amount: number; allocationMethod: ChargeAllocationMethod }> {
  return rows.filter(chargeDraftValid).map((c) => ({ amount: c.amount, allocationMethod: c.allocationMethod }));
}

function ChargesEditor({ rows, onChange, idPrefix }: { rows: ChargeDraft[]; onChange: (rows: ChargeDraft[]) => void; idPrefix: string }) {
  const t = useT();
  const patch = (i: number, p: Partial<ChargeDraft>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <div className="grid gap-3 p-4 print:hidden">
      {rows.length === 0 && <p className="px-1 text-sm text-slate-400">{t("purchasing.charges.empty")}</p>}
      {rows.map((c, i) => (
        <div key={c.key} className="grid gap-3 rounded-xl border border-slate-200 p-3 lg:grid-cols-[1fr_1.4fr_1.6fr_1fr_1fr_1fr_auto]">
          <div>
            <label className="mb-1 block text-[11px] font-bold text-slate-400" htmlFor={`${idPrefix}-type-${i}`}>{t("purchasing.charges.type")}</label>
            <Select id={`${idPrefix}-type-${i}`} className="w-full" value={c.chargeType} onChange={(e) => patch(i, { chargeType: e.target.value as ReceiptChargeType })}>
              {RECEIPT_CHARGE_TYPES.map((k) => <option key={k} value={k}>{t(`purchasing.charges.types.${k}`)}</option>)}
            </Select>
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-bold text-slate-400" htmlFor={`${idPrefix}-desc-${i}`}>{t("purchasing.charges.description")}</label>
            <input id={`${idPrefix}-desc-${i}`} className="field w-full" value={c.description} onChange={(e) => patch(i, { description: e.target.value })} placeholder={t("purchasing.common.optional")} />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-bold text-slate-400" htmlFor={`${idPrefix}-vendor-${i}`}>{t("purchasing.charges.vendor")}</label>
            {/* The same supplier search the purchase order form uses (supplierFetcher
                already returns adapted Supplier rows — one search, one adapter). */}
            <SearchableEntityCombobox<Supplier>
              id={`${idPrefix}-vendor-${i}`} value={c.supplier} onChange={(supplier) => patch(i, { supplier })}
              fetcher={supplierFetcher}
              queryKey={["procurement", "supplier-picker"]}
              getKey={(sup) => sup.id} getLabel={(sup) => sup.name} getSublabel={(sup) => sup.vatNumber || undefined}
              placeholder={t("purchasing.charges.vendorPlaceholder")} ariaLabel={t("purchasing.charges.vendorAria")}
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-bold text-slate-400" htmlFor={`${idPrefix}-amount-${i}`}>{t("purchasing.charges.amount")}</label>
            <input id={`${idPrefix}-amount-${i}`} type="number" min={0} step="0.01" className="field w-full tabular-nums" value={c.amount} onChange={(e) => patch(i, { amount: Number(e.target.value) })} />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-bold text-slate-400" htmlFor={`${idPrefix}-vat-${i}`}>{t("purchasing.charges.vatAmount")}</label>
            <input id={`${idPrefix}-vat-${i}`} type="number" min={0} step="0.01" className="field w-full tabular-nums" value={c.vatAmount} onChange={(e) => patch(i, { vatAmount: Number(e.target.value) })} />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-bold text-slate-400" htmlFor={`${idPrefix}-alloc-${i}`}>{t("purchasing.charges.allocation")}</label>
            <Select id={`${idPrefix}-alloc-${i}`} className="w-full" value={c.allocationMethod} onChange={(e) => patch(i, { allocationMethod: e.target.value === "qty" ? "qty" : "value" })}>
              <option value="value">{t("purchasing.charges.allocationValue")}</option>
              <option value="qty">{t("purchasing.charges.allocationQty")}</option>
            </Select>
          </div>
          <div className="flex items-end">
            <button type="button" aria-label={t("purchasing.charges.remove")} className="grid h-11 w-11 place-items-center rounded-xl text-slate-400 hover:bg-rose-50 hover:text-rose-600" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        </div>
      ))}
      <div>
        <Button type="button" variant="secondary" size="sm" onClick={() => onChange([...rows, newChargeDraft()])}>
          <Plus className="h-4 w-4" /> {t("purchasing.charges.add")}
        </Button>
      </div>
    </div>
  );
}

/** "—" for an absent figure; a landed cost that is null is not a cost of 0. */
function money(v: number | null | undefined): string {
  return v == null ? "—" : formatCurrency(v);
}
// Landed unit costs carry 4 dp (that is what enters the WAC and the lot);
// printing them at 2 would show 10.42 for a cost the warehouse holds as
// 10.4167. English digits, like every other figure in the product.
const unitCostFmt = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
function unitCost4(v: number | null | undefined): string {
  return v == null ? "—" : unitCostFmt.format(v);
}
function pct(v: number | null | undefined): string {
  return v == null ? "—" : `${formatNumber(v)}%`;
}
/** chargesTotal / goodsValue × 100 at 2 dp; null when there is no goods value to measure against. */
export function upliftPct(chargesTotal: number | null, goodsValue: number): number | null {
  if (chargesTotal == null || !(goodsValue > 0)) return null;
  return Math.round((chargesTotal / goodsValue) * 100 * 100) / 100;
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
  const [charges, setCharges] = useState<ChargeDraft[]>([]);
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
  // The same weights the server will use: line_total = entered qty × entered
  // unit cost, base_qty = entered qty × factor. Lines with no quantity are not
  // received and therefore carry no charge.
  const allocLines: AllocatableLine[] = active.map((r) => ({ key: r.poLineId, lineTotal: round4(r.qty * r.unitCost), baseQty: round4(r.qty * r.factor) }));
  const allocation = allocateReceiptCharges(allocLines, chargeInputsForPreview(charges));
  const chargesInvalid = charges.some((c) => !chargeDraftValid(c));

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
    // `charges` is optional on the wire: a receipt without import charges
    // sends none at all, so a server that predates landed cost still accepts it.
    if (charges.length > 0) body.charges = charges.map(toChargeInput);
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
  const hasCharges = charges.length > 0;

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
                <DatePicker id="rcv-date" value={receiptDate} onChange={setReceiptDate} />
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
                        {hasCharges && (
                          <div className="mt-1 text-[11px] font-semibold text-slate-500 tabular-nums" data-testid={`landed-unit-cost-${r.poLineId}`}>
                            {t("purchasing.charges.landedUnitCost")}: <b className="text-teal-700">{unitCost4(allocation.byKey[r.poLineId]?.landedUnitCost)}</b> {t("purchasing.charges.perBaseUnit")}
                          </div>
                        )}
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
                        <DatePicker id={`rcv-exp-${i}`} value={r.expiryDate} onChange={(expiryDate) => patch(i, { expiryDate })} />
                      </div>
                    </div>
                  ))}
                </div>

                {/* مصاريف الشحن والاستيراد — part of the same receipt, so part of the same form. */}
                <div className="border-t border-slate-100">
                  <PanelTitle icon={Ship} title={t("purchasing.charges.title")} subtitle={t("purchasing.charges.subtitle")} />
                  <ChargesEditor rows={charges} onChange={setCharges} idPrefix="rcv-charge" />
                  {chargesInvalid && (
                    <p className="mx-5 mb-3 rounded-xl bg-amber-50 px-4 py-2 text-sm font-semibold text-amber-700">{t("purchasing.charges.invalidAmount")}</p>
                  )}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-5 py-4">
                  <div className="grid gap-1 text-sm text-slate-500">
                    <div>
                      {t("purchasing.orderCreate.previewLabel")}: <b className="tabular-nums text-teal-700">{formatCurrency(previewTotal)}</b>
                    </div>
                    {hasCharges && (
                      <div data-testid="rcv-landed-preview">
                        {t("purchasing.charges.chargesTotal")}: <b className="tabular-nums text-slate-700">{formatCurrency(allocation.chargesTotal)}</b>
                        {" · "}
                        {t("purchasing.charges.landedTotal")}: <b className="tabular-nums text-teal-700">{formatCurrency(allocation.landedTotal)}</b>
                        {" · "}
                        {t("purchasing.charges.upliftPct")}: <b className="tabular-nums text-slate-700">{pct(upliftPct(allocation.chargesTotal, allocation.goodsTotal))}</b>
                      </div>
                    )}
                  </div>
                  <Button disabled={!canReceive || create.isPending || active.length === 0 || needsWarehouse || chargesInvalid} onClick={submit}>
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

// ── Receipt detail: landed cost panel ───────────────────────────────────────
// Mounted by ReceiptDetailPage (DetailPages.tsx). Reads the SAME query the
// detail page holds (useReceipt(id) — one cache entry, no second request) and
// maps it through toPurchaseReceipt so the landed fields keep their null
// semantics: null = "no charges", printed "—", never 0.
export function ReceiptLandedCostPanel({ id }: { id: string }) {
  const t = useT();
  const { data } = useReceipt(id);
  // Same gate as the receiving form itself — the server's receipts.create
  // capability is the real guard, this only decides whether to offer the control.
  const canEdit = useCan("procurement.manage");
  const update = useUpdateReceiptCharges();
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<ChargeDraft[]>([]);
  if (!data) return null;
  const r = toPurchaseReceipt(data as Record<string, unknown>);
  const editable = chargesEditable(r.status);
  const chargeRows = r.charges ?? [];
  const hasCharges = chargeRows.length > 0;
  const uplift = hasCharges ? upliftPct(r.chargesTotal, r.subtotal) : null;
  const chargeInvalid = rows.some((c) => !chargeDraftValid(c));

  const startEdit = () => { setRows(chargeRows.map(chargeDraftFromServer)); update.reset(); setEditing(true); };
  const save = () => update.mutate({ id, charges: rows.map(toChargeInput) }, { onSuccess: () => setEditing(false) });
  // The lock is a document-state conflict, not a validation slip: say WHY in
  // the reader's language rather than echoing the server's sentence.
  const updateError = update.error
    ? ((update.error as { code?: string }).code === "RECEIPT_CHARGES_LOCKED" ? t("purchasing.charges.locked") : translateApiError(update.error, t))
    : "";

  return (
    <Section
      icon={Ship}
      title={t("purchasing.charges.panelTitle")}
      subtitle={t("purchasing.charges.basisNote")}
      action={editable && canEdit && !editing && r.charges !== null
        ? <Button variant="secondary" size="sm" className="print:hidden" onClick={startEdit}>{t("purchasing.charges.edit")}</Button>
        : undefined}
    >
      {r.charges === null ? (
        // A server that never sent `charges` at all — say so, print no figure.
        <p className="p-5 text-sm text-slate-400" data-testid="landed-not-provided">{t("purchasing.charges.notProvided")}</p>
      ) : (
        <>
          <KV items={[
            { label: t("purchasing.charges.goodsValue"), value: formatCurrency(r.subtotal) },
            { label: t("purchasing.charges.chargesTotal"), value: <span data-testid="landed-kv-charges">{hasCharges ? money(r.chargesTotal) : "—"}</span> },
            { label: t("purchasing.charges.landedTotal"), value: <span data-testid="landed-kv-landed">{hasCharges ? money(r.landedTotal) : "—"}</span> },
            { label: t("purchasing.charges.upliftPct"), value: <span data-testid="landed-kv-uplift">{pct(uplift)}</span> },
          ]} />

          {!editing && (hasCharges ? (
            <div className="overflow-x-auto border-t border-slate-100">
              <table className="w-full border-collapse" data-testid="landed-charges-table">
                <thead className="bg-slate-50"><tr>
                  {[t("purchasing.charges.type"), t("purchasing.charges.description"), t("purchasing.charges.vendor")].map((h) => (
                    <th key={h} className="px-3 py-2 text-start text-[11px] font-extrabold uppercase text-slate-400">{h}</th>
                  ))}
                  {[t("purchasing.charges.amount"), t("purchasing.charges.vatAmount")].map((h) => (
                    <th key={h} className="px-3 py-2 text-end text-[11px] font-extrabold uppercase text-slate-400">{h}</th>
                  ))}
                  {[t("purchasing.charges.allocation"), t("common.status"), t("purchasing.charges.invoice")].map((h) => (
                    <th key={h} className="px-3 py-2 text-start text-[11px] font-extrabold uppercase text-slate-400">{h}</th>
                  ))}
                </tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {chargeRows.map((c) => (
                    <tr key={c.id}>
                      <td className="px-3 py-2.5 text-sm font-bold text-slate-700">{t(`purchasing.charges.types.${c.chargeType}`)}</td>
                      <td className="px-3 py-2.5 text-sm text-slate-700">{c.description || "—"}</td>
                      <td className="px-3 py-2.5 text-sm text-slate-700">{c.supplierName || "—"}</td>
                      <td className="px-3 py-2.5 text-end text-sm tabular-nums text-slate-700">{formatCurrency(c.amount)}</td>
                      <td className="px-3 py-2.5 text-end text-sm tabular-nums text-slate-700">{formatCurrency(c.vatAmount)}</td>
                      <td className="px-3 py-2.5 text-sm text-slate-700">{c.allocationMethod === "qty" ? t("purchasing.charges.allocationQty") : t("purchasing.charges.allocationValue")}</td>
                      <td className="px-3 py-2.5 text-sm"><StatusBadge>{t(`purchasing.charges.status.${c.status}`)}</StatusBadge></td>
                      <td className="px-3 py-2.5 text-sm">
                        {c.supplierInvoiceId
                          ? <Link className="font-bold text-teal-700 hover:underline" to={`/purchasing/invoices?doc=${encodeURIComponent(c.supplierInvoiceId)}`}>{t("purchasing.charges.invoice")}</Link>
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="border-t border-slate-100 px-5 py-4 text-sm text-slate-400">{t("purchasing.charges.empty")}</p>
          ))}

          {editing && (
            <div className="border-t border-slate-100 print:hidden">
              <ChargesEditor rows={rows} onChange={setRows} idPrefix={`grn-charge-${id}`} />
              {chargeInvalid && (
                <p className="mx-5 mb-3 rounded-xl bg-amber-50 px-4 py-2 text-sm font-semibold text-amber-700">{t("purchasing.charges.invalidAmount")}</p>
              )}
              {updateError && (
                <p className="mx-5 mb-3 rounded-xl bg-rose-50 px-4 py-2 text-sm font-semibold text-rose-600">{updateError}</p>
              )}
              <div className="flex flex-wrap items-center justify-end gap-2 px-5 pb-4">
                <Button variant="secondary" size="sm" disabled={update.isPending} onClick={() => { setEditing(false); update.reset(); }}>{t("purchasing.charges.cancelEdit")}</Button>
                <Button size="sm" disabled={update.isPending || chargeInvalid} onClick={save}>
                  {update.isPending ? t("purchasing.charges.saving") : t("purchasing.charges.save")}
                </Button>
              </div>
            </div>
          )}

          {!editable && (
            <p className="border-t border-slate-100 px-5 py-3 text-[12px] font-semibold text-slate-500 print:hidden" data-testid="landed-locked">{t("purchasing.charges.locked")}</p>
          )}

          {/* Per-line landed cost — next to the goods unit cost, so the uplift on
              every item is visible, not only the receipt-level total. */}
          <div className="border-t border-slate-100">
            <PanelTitle title={t("purchasing.charges.linesTitle")} subtitle={t("purchasing.charges.perBaseUnit")} />
            <div className="overflow-x-auto">
              <table className="w-full border-collapse" data-testid="landed-lines-table">
                <thead className="bg-slate-50"><tr>
                  <th className="px-3 py-2 text-start text-[11px] font-extrabold uppercase text-slate-400">{t("purchasing.col.item")}</th>
                  {[t("purchasing.lines.base"), t("purchasing.lines.unitCost"), t("purchasing.charges.landedCharge"), t("purchasing.charges.landedUnitCost")].map((h) => (
                    <th key={h} className="px-3 py-2 text-end text-[11px] font-extrabold uppercase text-slate-400">{h}</th>
                  ))}
                </tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {r.lines.map((l) => (
                    <tr key={l.id}>
                      <td className="px-3 py-2.5 text-sm text-slate-700">{l.itemName}</td>
                      <td className="px-3 py-2.5 text-end text-sm tabular-nums text-slate-700">{formatNumber(l.baseQty)}</td>
                      <td className="px-3 py-2.5 text-end text-sm tabular-nums text-slate-700">{unitCost4(l.baseUnitCost)}</td>
                      <td className="px-3 py-2.5 text-end text-sm tabular-nums text-slate-700">{unitCost4(l.landedChargeAmount)}</td>
                      <td className="px-3 py-2.5 text-end text-sm font-bold tabular-nums text-teal-700" data-testid={`landed-line-${l.id}`}>{unitCost4(l.landedUnitCost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </Section>
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
                <th key={h} className="px-3 py-2 text-end text-[11px] font-extrabold uppercase tracking-wide text-slate-400">{h}</th>
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
