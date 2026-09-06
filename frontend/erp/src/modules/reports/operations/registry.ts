// /reports/operations — three read-only, printable control reports.
//
// WHAT THIS REPLACED
//   Four links OUT of /reports: the POS shifts admin screen, a duplicate jump
//   into the Sales Analytics Hub, the inventory dashboard (whose reports
//   already live under /reports/inventory), and `/workflow/action-log` — a stub
//   page whose entire content was a button pointing at /administration/audit-log.
//   The user-actions report below is that stub's real destination, brought into
//   /reports as an actual report instead of a redirect wearing a card.
//
// EVERY REPORT BELOW IS BACKED BY A REAL ENDPOINT
//   shift variance    GET /shifts/            (theoretical vs counted, per shift)
//   user actions      GET /erp/audit-logs     (the audit_logs table)
//   transaction log   GET /workflow/reports/transaction-log
//
// WHAT IS DELIBERATELY ABSENT
//   A SIGN-IN / SESSION report ("who logged in, when, from where") is not here
//   and cannot be built today. Nothing writes a login or logout row: every
//   `INSERT INTO audit_logs` in the codebase records a business action, there is
//   no `login_history` / `user_sessions` table, and `last_login` is not stored.
//   The audit-log screen's own action list offers `login`/`logout` filters that
//   can never match a row. Building the report would produce a permanently
//   empty sheet that reads as "nobody signed in" — the failure mode this
//   catalogue exists to remove. It needs an auth-side audit write first.
//
// CAPABILITIES ARE BORROWED, NEVER INVENTED
//   `pos.shifts.view` already gates shift data. The audit report uses
//   `administration.audit` — the capability on the screen that reads this very
//   endpoint — which is STRICTER than the `workflow.audit.view` the deleted
//   action-log card carried; nothing was widened.
import { Clock, Factory, GitCompareArrows, Layers, Scale, ScrollText, TrendingDown, Workflow } from "lucide-react";
import { apiClient } from "@/shared/api";
import { operationalReports as arOperationalReports } from "@/i18n/dictionaries/ar/operationalReports";
import { operationalReports as enOperationalReports } from "@/i18n/dictionaries/en/operationalReports";
import { asRows, num, str, type ReportOption, type ReportResult, type ReportSectionDef, type ReportTotal } from "../engine";

/**
 * The inventory value roll-forward: opening + in − out = closing, per item.
 *
 * Read from `inventory_value_ledger`, which records the cost a movement
 * carried WHEN IT HAPPENED. Every earlier attempt at a historical valuation
 * applied today's average to an old quantity and called it history.
 *
 * The endpoint REFUSES a period starting before the ledger was activated,
 * with `LEDGER_STARTS_LATER` and the earliest answerable date. That error is
 * left to surface: a half-covered month looks exactly like a quiet month, and
 * swallowing it here would put that ambiguity on the page.
 */
async function loadInventoryValueRollForward(
  filters: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<ReportResult> {
  const body = await apiClient.get<{ data?: unknown; totals?: Record<string, unknown> }>(
    "/erp/reports/inventory-value/roll-forward",
    { params: { from: filters.from, to: filters.to }, signal },
  );
  const rows = asRows(body?.data);
  const t = body?.totals ?? {};
  return {
    rows: rows.map((r) => ({
      id: str(r.itemId),
      itemName: str(r.itemName) || str(r.itemId),
      openingQuantity: num(r.openingQuantity),
      openingValue: num(r.openingValue),
      inValue: num(r.inValue),
      outValue: num(r.outValue),
      closingQuantity: num(r.closingQuantity),
      closingValue: num(r.closingValue),
      // Surfaced as a COLUMN, not hidden in a footnote: a closing value that
      // rests partly on movements whose cost could not be established is not
      // the same number as one that does not, and the reader has to be able
      // to see which rows those are.
      unknownCostRows: num(r.unknownCostRows),
    })),
    totals: [
      { labelKey: "operationalReports.col.openingValue", value: num(t.openingValue), format: "money" },
      { labelKey: "operationalReports.col.inValue", value: num(t.inValue), format: "money" },
      { labelKey: "operationalReports.col.outValue", value: num(t.outValue), format: "money" },
      { labelKey: "operationalReports.col.closingValue", value: num(t.closingValue), format: "money" },
    ],
  };
}

// ── net realizable value ────────────────────────────────────────────────────
// IAS 2 carries inventory at the LOWER of cost and net realizable value. Both
// endpoints below live in routes/erp/reports/inventoryValue.js and do their
// arithmetic in lib/nrv.js; these loaders only carry the wire shape onto the
// sheet — and refuse to improve on it. Two things the shapes insist on:
//
//   · A NULL IS NOT A ZERO. An item no active recipe consumes has no selling
//     basis, so its NRV and write-down are null and the row says so. The
//     engine's `num` would print that as 0.00 — "fully recoverable", the one
//     claim an unpriced item cannot make — so nullable figures go through
//     `maybeNum` and reach the sheet as "—".
//   · THE BASIS IS PRINTED. The VAT rate stripped, the costs-to-sell percent,
//     which average cost was used and where the units sold came from are all
//     part of the answer. `ReportResult` has no basis slot, so the numeric
//     ones ride as labelled totals and the named ones as a per-row column —
//     never dropped.

/**
 * A figure the server may legitimately not have. `num` turns null into 0,
 * which is right for a ledger column (no movement = 0) and wrong for a
 * measurement (no basis ≠ a write-down of nothing). Null stays null.
 */
function maybeNum(value: unknown): number | null {
  return value == null || value === "" ? null : num(value);
}

interface ReportEnvelope {
  success?: unknown;
  error?: unknown;
  data?: unknown;
  totals?: Record<string, unknown>;
  basis?: Record<string, unknown>;
}

/**
 * Rows out of a `{ success, data, totals, basis }` envelope. `asRows` only
 * judges what it is handed: given the `data` of an HTTP-200
 * `{ success:false, error }` answer it sees undefined and returns [] — a
 * REFUSED valuation rendered as an empty one, every total at 0. So the
 * envelope is judged first, and a refusal is thrown for <ErrorState>.
 */
function envelopeRows(body: ReportEnvelope | null | undefined): Record<string, unknown>[] {
  if (body && typeof body === "object" && body.success === false) throw new Error(String(body.error ?? ""));
  return asRows(body?.data);
}

/**
 * A server figure as a printed total — or nothing, when the server had none.
 * A 0 standing in for "not measured" is the lie this catalogue exists to remove.
 */
function optionalTotal(labelKey: string, value: unknown, format: ReportTotal["format"]): ReportTotal[] {
  const n = maybeNum(value);
  return n == null ? [] : [{ labelKey, value: n, format }];
}

/**
 * The warehouse picker's "every warehouse" choice. Deliberately not "": the
 * engine runs a report only once its remote filter holds a truthy value, and
 * an empty string would leave the page loading forever.
 */
const ALL_WAREHOUSES = "*";

async function loadWarehouseOptions(signal?: AbortSignal): Promise<ReportOption[]> {
  const body = await apiClient.get<ReportEnvelope>("/inventory/v2/warehouses", { signal });
  // Remote-picker labels are display text, not keys, and a loader has no hook
  // to translate with. The language is read the way shared/lib/formatters.ts
  // reads it: the provider stamps <html lang> on every switch, so this cannot
  // drift from what the page around it shows.
  const english = typeof document !== "undefined" && document.documentElement.lang === "en";
  const dictionary = english ? enOperationalReports : arOperationalReports;
  return [
    { value: ALL_WAREHOUSES, label: dictionary.filter.allWarehouses },
    ...envelopeRows(body).map((warehouse) => ({
      value: str(warehouse.id),
      label:
        (english ? str(warehouse.nameEn) || str(warehouse.name) : str(warehouse.name) || str(warehouse.nameEn)) ||
        str(warehouse.code) ||
        str(warehouse.id),
    })),
  ];
}

const NRV_STATUS = {
  ok: "operationalReports.nrvStatus.ok",
  impaired: "operationalReports.nrvStatus.impaired",
  "no-basis": "operationalReports.nrvStatus.noBasis",
} as const;

/** `basis.costSource` — which weighted average the unit cost is. */
const NRV_COST_BASIS = {
  "warehouse-wac": "operationalReports.costBasis.warehouseWac",
  "item-wac": "operationalReports.costBasis.itemWac",
} as const;

/** A product's cost, by where it came from (lib/nrv.js resolveProductCost). */
const PRODUCT_COST_SOURCE = {
  recipe: "operationalReports.productCostSource.recipe",
  bom: "operationalReports.productCostSource.bom",
} as const;

/** `basis.salesSource` — the table the units sold were read from. */
const SALES_SOURCE = {
  analytics_daily_item: "operationalReports.salesSource.analytics_daily_item",
} as const;

async function loadInventoryNrv(
  filters: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<ReportResult> {
  const body = await apiClient.get<ReportEnvelope>(
    "/erp/reports/inventory-value/nrv",
    // "*" is the picker's own choice, not a warehouse: it sends nothing, and
    // the server answers over every warehouse at the item's own average.
    { params: { warehouseId: filters.warehouse === ALL_WAREHOUSES ? "" : str(filters.warehouse) }, signal },
  );
  const rows = envelopeRows(body);
  const t = body?.totals ?? {};
  const basis = body?.basis ?? {};
  // One cost basis per request (the endpoint names it once); printed on every
  // row so a sheet filtered to a warehouse cannot be read as item averages.
  const costBasis = str(basis.costSource);
  const itemsWithBasis = num(t.itemsWithBasis);
  return {
    rows: rows.map((r) => ({
      id: str(r.itemId),
      itemName: str(r.itemName) || str(r.itemId),
      quantity: num(r.quantity),
      unitCost: num(r.unitCost),
      costBasis,
      inventoryValue: num(r.inventoryValue),
      basisProductName: r.basisProductName == null ? null : str(r.basisProductName),
      netSellingPrice: maybeNum(r.netSellingPrice),
      nrvUnit: maybeNum(r.nrvUnit),
      writeDownUnit: maybeNum(r.writeDownUnit),
      writeDown: maybeNum(r.writeDown),
      status: str(r.status),
    })),
    totals: [
      { labelKey: "operationalReports.col.inventoryValue", value: num(t.inventoryValue), format: "money" },
      // The server sums the write-down over rows WITH a basis only. When no
      // row has one that sum is 0 over an empty set — not "nothing impaired" —
      // so the figure is withheld and the counts beside it say why.
      ...(itemsWithBasis > 0 ? optionalTotal("operationalReports.col.writeDown", t.writeDown, "money") : []),
      { labelKey: "operationalReports.total.itemsWithBasis", value: itemsWithBasis, format: "count" },
      { labelKey: "operationalReports.total.noBasisCount", value: num(t.noBasisCount), format: "count" },
      { labelKey: "operationalReports.total.impairedItems", value: num(t.impairedItems), format: "count" },
      ...optionalTotal("operationalReports.total.vatRatePct", basis.vatRatePct, "count"),
      ...optionalTotal("operationalReports.total.sellingCostPct", basis.sellingCostPct, "count"),
    ],
  };
}

async function loadProductsBelowCost(
  filters: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<ReportResult> {
  const body = await apiClient.get<ReportEnvelope>(
    "/erp/reports/inventory-value/products-below-cost",
    { params: { days: filters.days }, signal },
  );
  const rows = envelopeRows(body);
  const t = body?.totals ?? {};
  const basis = body?.basis ?? {};
  // Null on a server with no sales fact table: then units sold and exposure
  // are null on every row (an absent table is not "nothing sold"), the
  // exposure total is withheld, and this column prints "—" to say why.
  const salesSource = basis.salesSource == null ? null : str(basis.salesSource);
  return {
    rows: rows.map((r) => ({
      id: str(r.menuId),
      productName: str(r.productName) || str(r.menuId),
      netSellingPrice: num(r.netSellingPrice),
      unitCost: num(r.unitCost),
      costSource: str(r.costSource),
      shortfallUnit: num(r.shortfallUnit),
      // Margin on a zero price is undefined — null, never 0%.
      marginPct: maybeNum(r.marginPct),
      soldQty: maybeNum(r.soldQty),
      exposure: maybeNum(r.exposure),
      salesSource,
    })),
    totals: [
      { labelKey: "operationalReports.total.products", value: num(t.products), format: "count" },
      { labelKey: "operationalReports.total.noCostCount", value: num(t.noCostCount), format: "count" },
      ...optionalTotal("operationalReports.col.exposure", t.exposure, "money"),
      ...optionalTotal("operationalReports.total.salesWindowDays", basis.days, "count"),
      ...optionalTotal("operationalReports.total.vatRatePct", basis.vatRatePct, "count"),
    ],
  };
}

const TXN_STATUS = {
  draft: "operationalReports.txnStatus.draft",
  pending: "operationalReports.txnStatus.pending",
  in_progress: "operationalReports.txnStatus.in_progress",
  approved: "operationalReports.txnStatus.approved",
  rejected: "operationalReports.txnStatus.rejected",
  completed: "operationalReports.txnStatus.completed",
  cancelled: "operationalReports.txnStatus.cancelled",
} as const;

const IMPORTANCE = {
  critical: "operationalReports.importance.critical",
  high: "operationalReports.importance.high",
  medium: "operationalReports.importance.medium",
  low: "operationalReports.importance.low",
} as const;

const SHIFT_STATUS = {
  OPEN: "people.status.open",
  CLOSED: "people.status.closed",
  open: "people.status.open",
  closed: "people.status.closed",
} as const;

const YES_NO = {
  "1": "common.yes",
  "0": "common.no",
} as const;

// ── loaders ─────────────────────────────────────────────────────────────────

// ── production ─────────────────────────────────────────────────────────────
// Both endpoints were built after checking the schema rather than trusting a
// note that said the data did not exist. `production_orders` carries the plan,
// the output, the scrap and the three cost buckets; `production_consumption`
// carries qty_planned AND qty_actual on the same row.
async function loadProductionYield(
  filters: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<ReportResult> {
  const body = await apiClient.get<{ data?: unknown; totals?: Record<string, unknown> }>(
    "/erp/reports/production-yield",
    { params: { from: filters.from, to: filters.to }, signal },
  );
  const rows = asRows(body?.data);
  const t = body?.totals ?? {};
  return {
    rows: rows.map((r) => ({
      // The engine needs a stable row identity; the order number is it.
      id: str(r.orderNumber),
      orderNumber: str(r.orderNumber),
      productName: str(r.productName),
      status: str(r.status),
      releasedAt: str(r.releasedAt),
      qtyPlanned: num(r.qtyPlanned),
      qtyProduced: num(r.qtyProduced),
      qtyScrap: num(r.qtyScrap),
      // A null yield stays null: "nothing was planned" is not "produced 0%".
      yieldPct: r.yieldPct == null ? null : num(r.yieldPct),
      totalCost: num(r.totalCost),
    })),
    totals: [
      { labelKey: "operationalReports.col.qtyPlanned", value: num(t.qtyPlanned), format: "count" },
      { labelKey: "operationalReports.col.qtyProduced", value: num(t.qtyProduced), format: "count" },
      { labelKey: "operationalReports.col.wipCost", value: num(t.wipCost), format: "money" },
      { labelKey: "operationalReports.col.totalCost", value: num(t.totalCost), format: "money" },
    ],
  };
}

async function loadRecipeVariance(
  filters: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<ReportResult> {
  const body = await apiClient.get<{ data?: unknown; totals?: Record<string, unknown> }>(
    "/erp/reports/recipe-variance",
    { params: { from: filters.from, to: filters.to }, signal },
  );
  const rows = asRows(body?.data);
  const t = body?.totals ?? {};
  return {
    rows: rows.map((r) => ({
      // One order consumes many components, so neither alone is unique.
      id: `${str(r.orderNumber)}:${str(r.componentName)}`,
      orderNumber: str(r.orderNumber),
      productName: str(r.productName),
      componentName: str(r.componentName),
      qtyStandard: num(r.qtyStandard),
      qtyActual: num(r.qtyActual),
      qtyVariance: num(r.qtyVariance),
      standardCost: num(r.standardCost),
      actualCost: num(r.actualCost),
      qtyVarianceCost: num(r.qtyVarianceCost),
    })),
    totals: [
      { labelKey: "operationalReports.col.standardCost", value: num(t.standardCost), format: "money" },
      { labelKey: "operationalReports.col.actualCost", value: num(t.actualCost), format: "money" },
      { labelKey: "operationalReports.col.totalVariance", value: num(t.totalVariance), format: "money" },
    ],
  };
}

async function loadShiftVariance(
  filters: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<ReportResult> {
  const shifts = asRows(
    await apiClient.get<unknown>("/shifts/", {
      params: { report: 1, startDate: filters.from, endDate: filters.to, status: filters.status },
      signal,
    }),
  );
  return {
    rows: shifts.map((shift) => ({
      id: str(shift.id),
      cashier: str(shift.displayName) || str(shift.username),
      shiftStart: str(shift.startTime),
      shiftEnd: str(shift.endTime),
      status: str(shift.status),
      openingFloat: num(shift.openingFloat),
      expectedCash: num(shift.theoreticalCash),
      actualCash: num(shift.actualCash),
      cashVariance: num(shift.diffCash),
      expectedCard: num(shift.theoreticalCard),
      actualCard: num(shift.actualCard),
      cardVariance: num(shift.diffCard),
      totalVariance: num(shift.varianceTotal),
    })),
  };
}

async function loadUserActions(
  filters: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<ReportResult> {
  const entries = asRows(
    await apiClient.get<unknown>("/erp/audit-logs", {
      params: { report: 1, from: filters.from, to: filters.to },
      signal,
    }),
  );
  return {
    rows: entries.map((entry, index) => ({
      // audit_logs ids are unique, but the endpoint has been seen to answer
      // rows without one; the index keeps row identity stable either way.
      id: str(entry.id) || `audit-${index}`,
      at: str(entry.createdAt),
      user: str(entry.username),
      action: str(entry.action),
      entity: str(entry.entityType),
      reference: str(entry.entityId),
      details: str(entry.details),
      ip: str(entry.ipAddress),
    })),
  };
}

async function loadTransactionLog(
  filters: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<ReportResult> {
  const transactions = asRows(
    await apiClient.get<unknown>("/workflow/reports/transaction-log", {
      params: { startDate: filters.from, endDate: filters.to, status: filters.status },
      signal,
    }),
  );
  return {
    rows: transactions.map((transaction) => ({
      id: str(transaction.id),
      txnNumber: str(transaction.txnNumber),
      txnType: str(transaction.typeName),
      subject: str(transaction.subject),
      createdBy: str(transaction.createdBy),
      assignee: str(transaction.currentAssignee),
      importance: str(transaction.importance),
      status: str(transaction.status),
      createdAt: str(transaction.createdAt),
      dueDate: str(transaction.dueDate),
      overdue: transaction.isOverdue ? "1" : "0",
    })),
  };
}

// ── the section ─────────────────────────────────────────────────────────────
export const OPERATIONS_REPORTS_SECTION: ReportSectionDef = {
  path: "/reports/operations",
  titleKey: "misc.reports.sections.operations.title",
  subtitleKey: "misc.reports.sections.operations.subtitle",
  eyebrowKey: "misc.reports.eyebrow",
  groups: [
    {
      id: "posControl",
      titleKey: "operationalReports.groups.posControl.title",
      descriptionKey: "operationalReports.groups.posControl.description",
      icon: Clock,
    },
    {
      id: "production",
      titleKey: "operationalReports.groups.production.title",
      descriptionKey: "operationalReports.groups.production.description",
      icon: Factory,
    },
    {
      id: "inventoryValue",
      titleKey: "operationalReports.groups.inventoryValue.title",
      descriptionKey: "operationalReports.groups.inventoryValue.description",
      icon: Layers,
    },
    {
      id: "governance",
      titleKey: "operationalReports.groups.governance.title",
      descriptionKey: "operationalReports.groups.governance.description",
      icon: ScrollText,
    },
  ],
  reports: [
    {
      id: "production-yield",
      groupId: "production",
      labelKey: "operationalReports.reports.productionYield.label",
      descriptionKey: "operationalReports.reports.productionYield.description",
      icon: Factory,
      tone: "lime",
      // Production cost is financial data; this is the capability that already
      // gates the cost side of the warehouse reports. Nothing is widened.
      cap: "finance.reports.view",
      csvName: "production-yield",
      filters: [
        { id: "from", labelKey: "operationalReports.filter.from", kind: "date" },
        { id: "to", labelKey: "operationalReports.filter.to", kind: "date" },
      ],
      columns: [
        { key: "orderNumber", labelKey: "operationalReports.col.orderNumber", format: "code" },
        { key: "productName", labelKey: "operationalReports.col.product" },
        { key: "status", labelKey: "operationalReports.col.status" },
        { key: "releasedAt", labelKey: "operationalReports.col.releasedAt", format: "datetime" },
        { key: "qtyPlanned", labelKey: "operationalReports.col.qtyPlanned", format: "count" },
        { key: "qtyProduced", labelKey: "operationalReports.col.qtyProduced", format: "count" },
        { key: "qtyScrap", labelKey: "operationalReports.col.qtyScrap", format: "count" },
        { key: "yieldPct", labelKey: "operationalReports.col.yieldPct", format: "count" },
        { key: "totalCost", labelKey: "operationalReports.col.totalCost", format: "money" },
      ],
      load: loadProductionYield,
    },
    {
      id: "inventory-value-roll-forward",
      groupId: "inventoryValue",
      labelKey: "operationalReports.reports.inventoryValueRollForward.label",
      descriptionKey: "operationalReports.reports.inventoryValueRollForward.description",
      icon: Layers,
      tone: "teal",
      // Inventory VALUE is financial data — the same capability that gates
      // the cost side of every other report here. Nothing is widened.
      cap: "finance.reports.view",
      csvName: "inventory-value-roll-forward",
      filters: [
        { id: "from", labelKey: "operationalReports.filter.from", kind: "date" },
        { id: "to", labelKey: "operationalReports.filter.to", kind: "date" },
      ],
      columns: [
        { key: "itemName", labelKey: "operationalReports.col.item" },
        { key: "openingQuantity", labelKey: "operationalReports.col.openingQuantity", format: "count" },
        { key: "openingValue", labelKey: "operationalReports.col.openingValue", format: "money" },
        { key: "inValue", labelKey: "operationalReports.col.inValue", format: "money" },
        { key: "outValue", labelKey: "operationalReports.col.outValue", format: "money" },
        { key: "closingQuantity", labelKey: "operationalReports.col.closingQuantity", format: "count" },
        { key: "closingValue", labelKey: "operationalReports.col.closingValue", format: "money" },
        { key: "unknownCostRows", labelKey: "operationalReports.col.unknownCostRows", format: "count" },
      ],
      load: loadInventoryValueRollForward,
    },
    {
      id: "inventory-nrv",
      groupId: "inventoryValue",
      labelKey: "operationalReports.reports.inventoryNrv.label",
      descriptionKey: "operationalReports.reports.inventoryNrv.description",
      icon: Scale,
      tone: "teal",
      // Inventory VALUE, like the roll-forward beside it. Nothing is widened.
      cap: "finance.reports.view",
      csvName: "inventory-nrv",
      filters: [
        {
          id: "warehouse",
          labelKey: "operationalReports.filter.warehouse",
          kind: "remote",
          loadOptions: loadWarehouseOptions,
          optionsKey: ["reports", "operations", "warehouses"],
          // Opens answered — over every warehouse — instead of waiting on the
          // picker; a chosen warehouse switches cost to that warehouse's WAC.
          defaultValue: ALL_WAREHOUSES,
        },
      ],
      columns: [
        { key: "itemName", labelKey: "operationalReports.col.item" },
        { key: "quantity", labelKey: "operationalReports.col.quantity", format: "count" },
        { key: "unitCost", labelKey: "operationalReports.col.unitCost", format: "money" },
        { key: "costBasis", labelKey: "operationalReports.col.costBasis", format: "status", labels: NRV_COST_BASIS },
        { key: "inventoryValue", labelKey: "operationalReports.col.inventoryValue", format: "money" },
        { key: "basisProductName", labelKey: "operationalReports.col.basisProduct" },
        { key: "netSellingPrice", labelKey: "operationalReports.col.netSellingPrice", format: "money" },
        { key: "nrvUnit", labelKey: "operationalReports.col.nrvUnit", format: "money" },
        { key: "writeDownUnit", labelKey: "operationalReports.col.writeDownUnit", format: "money" },
        { key: "writeDown", labelKey: "operationalReports.col.writeDown", format: "money" },
        { key: "status", labelKey: "operationalReports.col.status", format: "status", labels: NRV_STATUS },
      ],
      load: loadInventoryNrv,
    },
    {
      id: "products-below-cost",
      groupId: "inventoryValue",
      labelKey: "operationalReports.reports.productsBelowCost.label",
      descriptionKey: "operationalReports.reports.productsBelowCost.description",
      icon: TrendingDown,
      tone: "rose",
      cap: "finance.reports.view",
      csvName: "products-below-cost",
      filters: [
        {
          id: "days",
          labelKey: "operationalReports.filter.salesWindow",
          kind: "select",
          options: [
            { value: "30", labelKey: "operationalReports.filter.last30Days" },
            { value: "60", labelKey: "operationalReports.filter.last60Days" },
            { value: "90", labelKey: "operationalReports.filter.last90Days" },
          ],
        },
      ],
      columns: [
        { key: "productName", labelKey: "operationalReports.col.product" },
        { key: "netSellingPrice", labelKey: "operationalReports.col.netSellingPrice", format: "money" },
        { key: "unitCost", labelKey: "operationalReports.col.unitCost", format: "money" },
        { key: "costSource", labelKey: "operationalReports.col.costSource", format: "status", labels: PRODUCT_COST_SOURCE },
        { key: "shortfallUnit", labelKey: "operationalReports.col.shortfallUnit", format: "money" },
        // The engine has no percent format, and its `count` cell prints a
        // null as 0 (Number(null ?? 0)). `money` renders through Num: LTR
        // digits, a dash for null and a numeric sort — what a signed, nullable
        // percentage needs. A zero cannot occur on this sheet (cost is strictly
        // above price on every row), so Num's zero-dash never fires here.
        { key: "marginPct", labelKey: "operationalReports.col.marginPct", format: "money" },
        // Units sold: null when the server has no sales source, and 0 is a real
        // answer that must stay visible. `count` would print the null as 0;
        // `code` prints a null as "—", a zero as "0", and keeps the digits LTR
        // — at the cost of the monospace face.
        { key: "soldQty", labelKey: "operationalReports.col.soldQty", format: "code" },
        { key: "exposure", labelKey: "operationalReports.col.exposure", format: "money" },
        { key: "salesSource", labelKey: "operationalReports.col.salesSource", format: "status", labels: SALES_SOURCE },
      ],
      load: loadProductsBelowCost,
    },
    {
      id: "recipe-variance",
      groupId: "production",
      labelKey: "operationalReports.reports.recipeVariance.label",
      descriptionKey: "operationalReports.reports.recipeVariance.description",
      icon: GitCompareArrows,
      tone: "amber",
      cap: "finance.reports.view",
      csvName: "recipe-variance",
      filters: [
        { id: "from", labelKey: "operationalReports.filter.from", kind: "date" },
        { id: "to", labelKey: "operationalReports.filter.to", kind: "date" },
      ],
      columns: [
        { key: "orderNumber", labelKey: "operationalReports.col.orderNumber", format: "code" },
        { key: "productName", labelKey: "operationalReports.col.product" },
        { key: "componentName", labelKey: "operationalReports.col.component" },
        { key: "qtyStandard", labelKey: "operationalReports.col.qtyStandard", format: "count" },
        { key: "qtyActual", labelKey: "operationalReports.col.qtyActual", format: "count" },
        { key: "qtyVariance", labelKey: "operationalReports.col.qtyVariance", format: "count" },
        { key: "standardCost", labelKey: "operationalReports.col.standardCost", format: "money" },
        { key: "actualCost", labelKey: "operationalReports.col.actualCost", format: "money" },
        { key: "qtyVarianceCost", labelKey: "operationalReports.col.qtyVarianceCost", format: "money" },
      ],
      load: loadRecipeVariance,
    },
    {
      id: "shift-variance",
      groupId: "posControl",
      labelKey: "operationalReports.reports.shiftVariance.label",
      descriptionKey: "operationalReports.reports.shiftVariance.description",
      icon: Clock,
      tone: "blue",
      cap: "pos.shifts.view",
      csvName: "shift-variance",
      filters: [
        { id: "from", labelKey: "operationalReports.filter.from", kind: "date" },
        { id: "to", labelKey: "operationalReports.filter.to", kind: "date" },
        {
          id: "status",
          labelKey: "operationalReports.filter.status",
          kind: "select",
          options: [
            { value: "", labelKey: "common.all" },
            { value: "CLOSED", labelKey: "people.status.closed" },
            { value: "OPEN", labelKey: "people.status.open" },
          ],
        },
      ],
      columns: [
        { key: "cashier", labelKey: "operationalReports.col.cashier" },
        { key: "shiftStart", labelKey: "operationalReports.col.shiftStart", format: "datetime" },
        { key: "shiftEnd", labelKey: "operationalReports.col.shiftEnd", format: "datetime" },
        { key: "status", labelKey: "operationalReports.col.status", format: "status", labels: SHIFT_STATUS },
        { key: "openingFloat", labelKey: "operationalReports.col.openingFloat", format: "money" },
        { key: "expectedCash", labelKey: "operationalReports.col.expectedCash", format: "money" },
        { key: "actualCash", labelKey: "operationalReports.col.actualCash", format: "money" },
        { key: "cashVariance", labelKey: "operationalReports.col.cashVariance", format: "money" },
        { key: "expectedCard", labelKey: "operationalReports.col.expectedCard", format: "money" },
        { key: "actualCard", labelKey: "operationalReports.col.actualCard", format: "money" },
        { key: "cardVariance", labelKey: "operationalReports.col.cardVariance", format: "money" },
        { key: "totalVariance", labelKey: "operationalReports.col.totalVariance", format: "money" },
      ],
      load: loadShiftVariance,
    },
    {
      id: "user-actions",
      groupId: "governance",
      labelKey: "operationalReports.reports.userActions.label",
      descriptionKey: "operationalReports.reports.userActions.description",
      icon: ScrollText,
      tone: "violet",
      cap: "administration.audit",
      csvName: "user-actions",
      filters: [
        { id: "from", labelKey: "operationalReports.filter.from", kind: "date" },
        { id: "to", labelKey: "operationalReports.filter.to", kind: "date" },
      ],
      columns: [
        { key: "at", labelKey: "operationalReports.col.at", format: "datetime" },
        { key: "user", labelKey: "operationalReports.col.user" },
        { key: "action", labelKey: "operationalReports.col.action" },
        { key: "entity", labelKey: "operationalReports.col.entity" },
        { key: "reference", labelKey: "operationalReports.col.reference", format: "code" },
        { key: "details", labelKey: "operationalReports.col.details" },
        { key: "ip", labelKey: "operationalReports.col.ip", format: "code" },
      ],
      load: loadUserActions,
    },
    {
      id: "transaction-log",
      groupId: "governance",
      labelKey: "operationalReports.reports.transactionLog.label",
      descriptionKey: "operationalReports.reports.transactionLog.description",
      icon: Workflow,
      tone: "teal",
      cap: "workflow.audit.view",
      csvName: "transaction-log",
      filters: [
        { id: "from", labelKey: "operationalReports.filter.from", kind: "date" },
        { id: "to", labelKey: "operationalReports.filter.to", kind: "date" },
        {
          id: "status",
          labelKey: "operationalReports.filter.status",
          kind: "select",
          options: [
            { value: "", labelKey: "common.all" },
            { value: "pending", labelKey: "operationalReports.txnStatus.pending" },
            { value: "in_progress", labelKey: "operationalReports.txnStatus.in_progress" },
            { value: "approved", labelKey: "operationalReports.txnStatus.approved" },
            { value: "rejected", labelKey: "operationalReports.txnStatus.rejected" },
            { value: "completed", labelKey: "operationalReports.txnStatus.completed" },
          ],
        },
      ],
      columns: [
        { key: "txnNumber", labelKey: "operationalReports.col.txnNumber", format: "code" },
        { key: "txnType", labelKey: "operationalReports.col.txnType" },
        { key: "subject", labelKey: "operationalReports.col.subject" },
        { key: "createdBy", labelKey: "operationalReports.col.createdBy" },
        { key: "assignee", labelKey: "operationalReports.col.assignee" },
        { key: "importance", labelKey: "operationalReports.col.importance", format: "status", labels: IMPORTANCE },
        { key: "status", labelKey: "operationalReports.col.status", format: "status", labels: TXN_STATUS },
        { key: "createdAt", labelKey: "operationalReports.col.createdAt", format: "datetime" },
        { key: "dueDate", labelKey: "operationalReports.col.dueDate", format: "date" },
        { key: "overdue", labelKey: "operationalReports.col.overdue", format: "status", labels: YES_NO },
      ],
      load: loadTransactionLog,
    },
  ],
};
