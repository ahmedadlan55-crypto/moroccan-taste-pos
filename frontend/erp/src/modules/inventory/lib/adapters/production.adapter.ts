// Phase P1 — Production Orders V2 adapters. Map the backend rows (snake_case,
// stringy decimals) into the exact shapes the pages render. Every consumer of
// /api/inventory/v2/production-orders goes through here — never raw JSON.

export type ProductionStatus =
  | "draft" | "approved" | "in_progress" | "completed" | "closed"
  | "cancelled" | "reversed" | "planned" | "released";

export interface ProductionRow {
  id: string;
  number: string;
  productId: string;
  productName: string;
  productUnit: string;
  status: ProductionStatus;
  source: "v2" | "legacy";
  version: number;
  qtyPlanned: number;
  qtyProduced: number;
  qtyWaste: number;
  wipBalance: number;
  unitCost: number;
  yieldPct: number | null;
  warehouseId: string;
  warehouseName: string;
  outputWarehouseId: string;
  outputWarehouseName: string;
  plannedDate: string | null;
  priority: string;
  batchNumber: string | null;
  createdBy: string;
  createdAt: string | null;
  partiallyCompleted: boolean;
}

export interface ProductionKpis {
  draft: number;
  approved: number;
  inProgress: number;
  partiallyCompleted: number;
  completed: number;
  closed: number;
  cancelled: number;
  reversed: number;
  legacyActive: number;
  wipValue: number;
  producedValue: number;
}

export interface ProductionPage {
  rows: ProductionRow[];
  kpis: ProductionKpis;
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

export interface PlanLine {
  itemId: string;
  itemName: string;
  itemUnit: string;
  trackingMode: string;
  qtyPlanned: number;
  qtyIssued: number;
  remaining: number;
  unitCost: number;
  totalCost: number;
  available: number;
}

export interface IssueLine {
  id: string;
  itemId: string;
  itemName: string;
  itemUnit: string;
  qty: number;
  unitCost: number;
  lineTotal: number;
}

export interface IssueEvent {
  id: string;
  eventNo: number;
  materialsCost: number;
  laborCost: number;
  overheadCost: number;
  glJournalId: string | null;
  issuedBy: string;
  issuedAt: string | null;
  notes: string | null;
  lines: IssueLine[];
}

export interface OutputEvent {
  id: string;
  qty: number;
  unitCost: number;
  totalCost: number;
  qtyWaste: number;
  wasteCost: number;
  batchNumber: string | null;
  expiryDate: string | null;
  producedAt: string | null;
  glJournalId: string | null;
  createdBy: string;
}

export interface TimelineEvent {
  id: string;
  action: string;
  fromStatus: string | null;
  toStatus: string | null;
  actor: string;
  note: string;
  at: string | null;
}

export interface JournalEntryLine { accountCode: string; accountName: string; debit: number; credit: number }
export interface Journal {
  id: string;
  number: string;
  date: string | null;
  totalDebit: number;
  totalCredit: number;
  referenceType: string;
  entries: JournalEntryLine[];
}

export interface LotMovementRow {
  id: string;
  lotId: string;
  lotNumber: string;
  expiryDate: string | null;
  itemId: string;
  warehouseId: string;
  signedQty: number;
  referenceType: string;
  referenceId: string;
}

export interface GenealogyRow {
  id: string;
  outputLotId: string;
  outputLotNumber: string;
  componentLotId: string | null;
  componentLotNumber: string | null;
  componentName: string;
  qty: number;
  /** True for orders produced before the allocation ledger existed: the lot
   *  LINKAGE is real, but the per-output quantity split was never recorded. */
  approximate: boolean;
}

export interface MovementRow {
  id: string;
  date: string | null;
  itemId: string;
  itemName: string;
  type: string;
  qty: number;
  reason: string;
  warehouseId: string;
  referenceType: string;
}

export interface ProductionDetail {
  order: ProductionRow & {
    productTrackingMode: string;
    materialsCost: number;
    laborCost: number;
    overheadCost: number;
    totalCost: number;
    allowedScrapPct: number;
    notes: string | null;
    approvedBy: string | null;
    completedAt: string | null;
    closeVariance: number;
    cancelReason: string | null;
    reverseReason: string | null;
    bomId: string;
  };
  plan: PlanLine[];
  issueEvents: IssueEvent[];
  outputs: OutputEvent[];
  lotMovements: LotMovementRow[];
  genealogy: GenealogyRow[];
  timeline: TimelineEvent[];
  movements: MovementRow[];
  journals: Journal[];
}

export interface BomOption {
  id: string;
  productId: string;
  productName: string;
  productUnit: string;
  trackingMode: string;
  yieldQuantity: number;
  yieldUnit: string;
  lineCount: number;
}

export interface AvailabilityItem {
  itemId: string;
  itemName: string;
  itemUnit: string;
  trackingMode: string;
  required: number;
  planned?: number;
  issued?: number;
  remaining?: number;
  available: number;
  delta: number;
  unitCost: number;
  lineCost?: number;
  fefoAvailable: number | null;
  status: "ok" | "short" | "done";
}

export interface Availability {
  items: AvailabilityItem[];
  summary: { shortageCount: number; allAvailable: boolean; itemCount: number; reservedValue?: number; batches?: number };
}

export interface VarianceReport {
  order: { id: string; number: string; status: string };
  plannedQty: number;
  producedQty: number;
  wasteQty: number;
  yieldPct: number | null;
  components: Array<{
    itemId: string; itemName: string; itemUnit: string;
    qtyPlanned: number; qtyActual: number; qtyVariance: number;
    unitCost: number; plannedValue: number; actualValue: number; valueVariance: number;
  }>;
  laborCost: number;
  overheadCost: number;
  fgValue: number;
  wasteValue: number;
  wipResidual: number;
  closeVariance: number;
}

export interface MutationResult {
  id: string;
  documentNumber: string | null;
  status: string | null;
  version: number | null;
  journalId: string | null;
  eventId?: string;
  unitCost?: number;
  yieldPct?: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const str = (v: unknown): string => (v == null ? "" : String(v));
const dateStr = (v: unknown): string | null => (v ? String(v) : null);

export function toProductionRow(r: any): ProductionRow {
  return {
    id: str(r?.id),
    number: str(r?.order_number),
    productId: str(r?.product_id),
    productName: str(r?.product_name) || str(r?.product_id),
    productUnit: str(r?.product_unit),
    status: (str(r?.status) || "draft") as ProductionStatus,
    source: r?.source === "legacy" ? "legacy" : "v2",
    version: num(r?.version) || 1,
    qtyPlanned: num(r?.qty_planned),
    qtyProduced: num(r?.qty_produced),
    qtyWaste: num(r?.qty_waste),
    wipBalance: num(r?.wip_balance),
    unitCost: num(r?.unit_cost),
    yieldPct: r?.yield_pct != null ? num(r?.yield_pct) : null,
    warehouseId: str(r?.warehouse_id),
    warehouseName: str(r?.warehouse_name),
    outputWarehouseId: str(r?.output_warehouse_id) || str(r?.warehouse_id),
    outputWarehouseName: str(r?.output_warehouse_name) || str(r?.warehouse_name),
    plannedDate: dateStr(r?.planned_date),
    priority: str(r?.priority) || "normal",
    batchNumber: r?.batch_number ? str(r?.batch_number) : null,
    createdBy: str(r?.created_by),
    createdAt: dateStr(r?.created_at),
    partiallyCompleted: !!r?.partially_completed,
  };
}

export function toProductionPage(body: any): ProductionPage {
  const rows = Array.isArray(body?.data) ? body.data.map(toProductionRow) : [];
  const k = body?.kpis ?? {};
  const p = body?.pagination ?? {};
  return {
    rows,
    kpis: {
      draft: num(k.draft), approved: num(k.approved), inProgress: num(k.inProgress),
      partiallyCompleted: num(k.partiallyCompleted), completed: num(k.completed),
      closed: num(k.closed), cancelled: num(k.cancelled), reversed: num(k.reversed),
      legacyActive: num(k.legacyActive), wipValue: num(k.wipValue), producedValue: num(k.producedValue),
    },
    pagination: {
      page: num(p.page) || 1, pageSize: num(p.pageSize) || 25,
      total: num(p.total), totalPages: num(p.totalPages) || 1,
    },
  };
}

export function toProductionDetail(body: any): ProductionDetail {
  const d = body?.data ?? {};
  const base = toProductionRow(d);
  return {
    order: {
      ...base,
      productTrackingMode: str(d.product_tracking_mode) || "none",
      materialsCost: num(d.materials_cost),
      laborCost: num(d.labor_cost),
      overheadCost: num(d.overhead_cost),
      totalCost: num(d.total_cost),
      allowedScrapPct: num(d.allowed_scrap_pct),
      notes: d.notes ? str(d.notes) : null,
      approvedBy: d.approved_by ? str(d.approved_by) : null,
      completedAt: dateStr(d.completed_at),
      closeVariance: num(d.close_variance),
      cancelReason: d.cancel_reason ? str(d.cancel_reason) : null,
      reverseReason: d.reverse_reason ? str(d.reverse_reason) : null,
      bomId: str(d.bom_id),
    },
    plan: (Array.isArray(body?.plan) ? body.plan : []).map((p: any): PlanLine => ({
      itemId: str(p.item_id),
      itemName: str(p.item_name) || str(p.item_id),
      itemUnit: str(p.item_unit),
      trackingMode: str(p.tracking_mode) || "none",
      qtyPlanned: num(p.qty_planned),
      qtyIssued: num(p.qty_actual),
      remaining: num(p.remaining),
      unitCost: num(p.unit_cost),
      totalCost: num(p.total_cost),
      available: num(p.available),
    })),
    issueEvents: (Array.isArray(body?.issueEvents) ? body.issueEvents : []).map((e: any): IssueEvent => ({
      id: str(e.id),
      eventNo: num(e.event_no),
      materialsCost: num(e.materials_cost),
      laborCost: num(e.labor_cost),
      overheadCost: num(e.overhead_cost),
      glJournalId: e.gl_journal_id ? str(e.gl_journal_id) : null,
      issuedBy: str(e.issued_by),
      issuedAt: dateStr(e.issued_at),
      notes: e.notes ? str(e.notes) : null,
      lines: (Array.isArray(e.lines) ? e.lines : []).map((l: any): IssueLine => ({
        id: str(l.id), itemId: str(l.item_id), itemName: str(l.item_name) || str(l.item_id),
        itemUnit: str(l.item_unit), qty: num(l.qty), unitCost: num(l.unit_cost), lineTotal: num(l.line_total),
      })),
    })),
    outputs: (Array.isArray(body?.outputs) ? body.outputs : []).map((o: any): OutputEvent => ({
      id: str(o.id), qty: num(o.qty), unitCost: num(o.unit_cost), totalCost: num(o.total_cost),
      qtyWaste: num(o.qty_waste), wasteCost: num(o.waste_cost),
      batchNumber: o.batch_number ? str(o.batch_number) : null,
      expiryDate: dateStr(o.expiry_date), producedAt: dateStr(o.produced_at),
      glJournalId: o.gl_journal_id ? str(o.gl_journal_id) : null, createdBy: str(o.created_by),
    })),
    lotMovements: (Array.isArray(body?.lotMovements) ? body.lotMovements : []).map((m: any): LotMovementRow => ({
      id: str(m.id), lotId: str(m.lot_id), lotNumber: str(m.lot_number), expiryDate: dateStr(m.expiry_date),
      itemId: str(m.item_id), warehouseId: str(m.warehouse_id), signedQty: num(m.signed_qty),
      referenceType: str(m.reference_type), referenceId: str(m.reference_id),
    })),
    // The allocation ledger serialises camelCase and carries no row id. This
    // used to read snake_case only, so every field except qty came back empty
    // and each row rendered as "— ← (5)". Both spellings are accepted: the
    // pre-ledger fallback rows are shaped the same way, and a browser holding a
    // cached bundle across the deploy still renders.
    genealogy: (Array.isArray(body?.genealogy) ? body.genealogy : []).map((g: any, i: number): GenealogyRow => ({
      id: str(g.id ?? `${g.outputEventId ?? g.output_event_id ?? "g"}:${g.componentLotId ?? g.component_lot_id ?? i}:${i}`),
      outputLotId: str(g.outputLotId ?? g.output_lot_id),
      outputLotNumber: str(g.outputLotNumber ?? g.output_lot_number),
      componentLotId: (g.componentLotId ?? g.component_lot_id) ? str(g.componentLotId ?? g.component_lot_id) : null,
      componentLotNumber: (g.componentLotNumber ?? g.component_lot_number) ? str(g.componentLotNumber ?? g.component_lot_number) : null,
      componentName: str(g.componentName ?? g.component_name),
      qty: num(g.qty),
      approximate: g.approximate === true,
    })),
    timeline: (Array.isArray(body?.timeline) ? body.timeline : []).map((t: any): TimelineEvent => ({
      id: str(t.id), action: str(t.action), fromStatus: t.from_status ? str(t.from_status) : null,
      toStatus: t.to_status ? str(t.to_status) : null, actor: str(t.actor), note: str(t.note), at: dateStr(t.created_at),
    })),
    movements: (Array.isArray(body?.movements) ? body.movements : []).map((m: any): MovementRow => ({
      id: str(m.id), date: dateStr(m.movement_date), itemId: str(m.item_id), itemName: str(m.item_name),
      type: str(m.type), qty: num(m.qty), reason: str(m.reason), warehouseId: str(m.warehouse_id),
      referenceType: str(m.reference_type),
    })),
    journals: (Array.isArray(body?.journals) ? body.journals : []).map((j: any): Journal => ({
      id: str(j.id), number: str(j.journal_number), date: dateStr(j.journal_date),
      totalDebit: num(j.total_debit), totalCredit: num(j.total_credit), referenceType: str(j.reference_type),
      entries: (Array.isArray(j.entries) ? j.entries : []).map((e: any): JournalEntryLine => ({
        accountCode: str(e.account_code), accountName: str(e.account_name), debit: num(e.debit), credit: num(e.credit),
      })),
    })),
  };
}

export function toBomOptions(body: any): BomOption[] {
  return (Array.isArray(body?.data) ? body.data : []).map((b: any): BomOption => ({
    id: str(b.id), productId: str(b.product_id), productName: str(b.product_name) || str(b.product_id),
    productUnit: str(b.product_unit), trackingMode: str(b.tracking_mode) || "none",
    yieldQuantity: num(b.yield_quantity) || 1, yieldUnit: str(b.yield_unit), lineCount: num(b.line_count),
  }));
}

export function toAvailability(body: any): Availability {
  const items = (Array.isArray(body?.items) ? body.items : []).map((i: any): AvailabilityItem => ({
    itemId: str(i.itemId), itemName: str(i.itemName) || str(i.itemId), itemUnit: str(i.itemUnit),
    trackingMode: str(i.trackingMode) || "none",
    required: num(i.required ?? i.remaining), planned: i.planned != null ? num(i.planned) : undefined,
    issued: i.issued != null ? num(i.issued) : undefined,
    remaining: i.remaining != null ? num(i.remaining) : undefined,
    available: num(i.available), delta: num(i.delta), unitCost: num(i.unitCost),
    lineCost: i.lineCost != null ? num(i.lineCost) : undefined,
    fefoAvailable: i.fefoAvailable != null ? num(i.fefoAvailable) : null,
    status: (i.status === "short" || i.status === "done" ? i.status : "ok"),
  }));
  const s = body?.summary ?? {};
  return {
    items,
    summary: {
      shortageCount: num(s.shortageCount), allAvailable: !!s.allAvailable, itemCount: num(s.itemCount),
      reservedValue: s.reservedValue != null ? num(s.reservedValue) : undefined,
      batches: s.batches != null ? num(s.batches) : undefined,
    },
  };
}

export function toVarianceReport(body: any): VarianceReport {
  const d = body?.data ?? {};
  return {
    order: { id: str(d.order?.id), number: str(d.order?.number), status: str(d.order?.status) },
    plannedQty: num(d.plannedQty), producedQty: num(d.producedQty), wasteQty: num(d.wasteQty),
    yieldPct: d.yieldPct != null ? num(d.yieldPct) : null,
    components: (Array.isArray(d.components) ? d.components : []).map((c: any) => ({
      itemId: str(c.item_id), itemName: str(c.item_name) || str(c.item_id), itemUnit: str(c.item_unit),
      qtyPlanned: num(c.qty_planned), qtyActual: num(c.qty_actual), qtyVariance: num(c.qtyVariance),
      unitCost: num(c.unit_cost), plannedValue: num(c.plannedValue), actualValue: num(c.actualValue),
      valueVariance: num(c.valueVariance),
    })),
    laborCost: num(d.laborCost), overheadCost: num(d.overheadCost),
    fgValue: num(d.fgValue), wasteValue: num(d.wasteValue),
    wipResidual: num(d.wipResidual), closeVariance: num(d.closeVariance),
  };
}

export function toMutationResult(body: any): MutationResult {
  const d = body?.data ?? {};
  return {
    id: str(d.id ?? body?.id),
    documentNumber: body?.documentNumber != null ? str(body.documentNumber) : null,
    status: body?.status != null ? str(body.status) : null,
    version: body?.version != null ? num(body.version) : null,
    journalId: body?.journalId != null ? str(body.journalId) : null,
    eventId: d.eventId ? str(d.eventId) : undefined,
    unitCost: d.unitCost != null ? num(d.unitCost) : undefined,
    yieldPct: d.yieldPct != null ? num(d.yieldPct) : undefined,
  };
}
