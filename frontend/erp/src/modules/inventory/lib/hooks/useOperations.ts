/**
 * Unified inventory OPERATIONS read model — the client half of
 * routes/inventory-operations.js.
 *
 * THREE contracts this file will not bend:
 *  1. SERVER-SIDE paging/filtering/sorting ONLY. Every filter goes on the wire;
 *     nothing is fetched whole and narrowed in the browser.
 *  2. The document-type and status VOCABULARIES come from `/meta` — never
 *     hardcoded here. The i18n dictionary only supplies LABELS for the codes the
 *     server reports, and falls back to the server's own label for a code it
 *     does not know yet.
 *  3. A failed request stays failed. These hooks never coerce an error into an
 *     empty page — the caller renders ErrorState from `isError`, which is the
 *     whole reason the backend refuses to answer `[]` on a DB failure.
 *
 * The list row's `id` is the COMPOSITE "<type>:<id>" (ids are not unique across
 * the eleven header tables), so navigation always uses `documentType` +
 * `documentId` separately — never a split of `id`.
 */
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { apiClient } from "@/shared/api";

// ── wire shapes ─────────────────────────────────────────────────────────────

export interface OperationsMetaType {
  documentType: string;
  /** Server-supplied label — the FALLBACK when the dictionary has no entry. */
  label: string;
  table?: string;
  capability: string | null;
  /** available AND the caller holds the capability. */
  visible: boolean;
  available: boolean;
  twoSided: boolean;
  hasDocumentNumber: boolean;
  statuses: { raw: string; canonical: string }[];
}

export interface OperationsMeta {
  types: OperationsMetaType[];
  canonicalStatuses: string[];
  sortable: string[];
  maxPageSize: number;
  currency: string;
}

export interface OperationSide {
  kind: string;
  id: string | null;
  label: string | null;
}

export interface OperationRow {
  /** Composite "<documentType>:<documentId>" — unique across every source. */
  id: string;
  documentType: string;
  documentTypeLabel: string;
  documentId: string;
  documentNumber: string | null;
  date: string | null;
  /** Canonical status (draft | pending_approval | … | reversed). */
  status: string;
  rawStatus: string | null;
  source: OperationSide;
  destination: OperationSide;
  partyLabel: string | null;
  productSummary: string | null;
  lineCount: number | null;
  totalQuantity: number | null;
  totalValue: number | null;
  vatAmount: number | null;
  grossValue: number | null;
  /** true ⇒ totalValue is a SIGNED variance; never render its absolute value. */
  valueSigned: boolean;
  currency: string;
  createdBy: string | null;
  createdByName: string | null;
  approvedBy: string | null;
  approvedByName: string | null;
  createdAt: string | null;
}

export interface OperationsPage {
  data: OperationRow[];
  counts: Record<string, number>;
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  includedTypes: string[];
  /** Types dropped because their table does not exist on this deployment. */
  unavailableTypes: string[];
  /** Types dropped because the caller lacks the branch capability. */
  deniedTypes: string[];
  scope: { allWarehousesAccess: boolean };
  generatedAt: string | null;
}

export interface OperationLine {
  id: string | null;
  itemId: string | null;
  itemName: string | null;
  unit: string | null;
  qty: number | null;
  unitCost: number | null;
  lineTotal: number | null;
}

export interface OperationMovement {
  id: string;
  at: string | null;
  itemId: string | null;
  itemName: string | null;
  type: string | null;
  qty: number | null;
  reason: string | null;
  warehouseId: string | null;
  referenceType: string | null;
  referenceId: string | null;
  actor: string | null;
  notes: string | null;
}

export interface OperationLot {
  id: string;
  lotId: string | null;
  lotNumber: string | null;
  expiryDate: string | null;
  itemId: string | null;
  warehouseId: string | null;
  signedQty: number | null;
  referenceType: string | null;
  referenceId: string | null;
  at: string | null;
}

export interface OperationJournalEntry {
  accountCode: string | null;
  accountName: string | null;
  debit: number | null;
  credit: number | null;
}

export interface OperationJournal {
  id: string;
  journalNumber: string | null;
  journalDate: string | null;
  totalDebit: number | null;
  totalCredit: number | null;
  referenceType: string | null;
  description: string | null;
  entries: OperationJournalEntry[];
}

export interface OperationTimelineEvent {
  action: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  actor: string;
  note: string | null;
  at: string | null;
  /** true ⇒ rebuilt from the stamped actor columns, not a real audit row. */
  synthetic: boolean;
}

export interface OperationDetail {
  data: OperationRow;
  /** Every type-specific header column, verbatim (attachments live here). */
  header: Record<string, unknown>;
  lines: OperationLine[];
  movements: OperationMovement[];
  lots: OperationLot[];
  journals: OperationJournal[];
  timeline: OperationTimelineEvent[];
  capabilities: { requiredToView: string | null };
}

// ── query params ────────────────────────────────────────────────────────────

export interface OperationsQuery {
  page: number;
  pageSize: number;
  /** Canonical document types; empty ⇒ every visible type. */
  types: string[];
  /** Canonical statuses; empty ⇒ every status. */
  statuses: string[];
  warehouseId: string;
  dateFrom: string;
  dateTo: string;
  search: string;
  sort: string;
  dir: "asc" | "desc";
}

const BASE = "/inventory/operations";

/** Query keys are LOCAL to this module (the shared query-keys file is owned by
 *  the pages that predate the operations centre). */
export const operationsKeys = {
  meta: () => ["inventory-operations", "meta"] as const,
  list: (q: Record<string, unknown>) => ["inventory-operations", "list", q] as const,
  detail: (type: string, id: string) => ["inventory-operations", "detail", type, id] as const,
};

// ── hooks ───────────────────────────────────────────────────────────────────

/**
 * The type + status vocabulary. Everything the hub renders as a tab, a type
 * filter option or a status filter option is derived from THIS — so a document
 * family added (or gated off) on the server appears (or disappears) with no UI
 * change at all.
 */
export function useOperationsMeta() {
  return useQuery<OperationsMeta>({
    queryKey: operationsKeys.meta(),
    queryFn: ({ signal }) =>
      apiClient
        .get<{ data?: OperationsMeta }>(`${BASE}/meta`, { signal })
        .then((raw) => normalizeMeta(raw)),
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
  });
}

export function useOperationsList(query: OperationsQuery) {
  const params = {
    page: query.page,
    pageSize: query.pageSize,
    types: query.types.length ? query.types.join(",") : undefined,
    statuses: query.statuses.length ? query.statuses.join(",") : undefined,
    warehouseId: query.warehouseId || undefined,
    dateFrom: query.dateFrom || undefined,
    dateTo: query.dateTo || undefined,
    search: query.search || undefined,
    sort: query.sort,
    dir: query.dir,
  };
  return useQuery<OperationsPage>({
    queryKey: operationsKeys.list(params),
    queryFn: ({ signal }) =>
      apiClient.get<unknown>(BASE, { signal, params }).then(normalizeList),
    staleTime: 15_000,
    gcTime: 5 * 60_000,
    // Keeps the table populated (and the ErrorState away) while the next page
    // or filter loads — the row set is replaced only once the answer arrives.
    placeholderData: keepPreviousData,
  });
}

export function useOperationDetail(documentType: string | null, documentId: string | null) {
  const enabled = !!documentType && !!documentId;
  return useQuery<OperationDetail>({
    queryKey: operationsKeys.detail(documentType ?? "", documentId ?? ""),
    enabled,
    queryFn: ({ signal }) =>
      apiClient
        .get<unknown>(`${BASE}/${encodeURIComponent(documentType ?? "")}/${encodeURIComponent(documentId ?? "")}`, {
          signal,
        })
        .then(normalizeDetail),
    staleTime: 15_000,
    gcTime: 5 * 60_000,
  });
}

// ── normalizers ─────────────────────────────────────────────────────────────
// Defensive but NEVER lossy-on-failure: a missing envelope yields empty
// collections, and any thrown/rejected request propagates as a query error.

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function str(v: unknown): string | null {
  return v == null || v === "" ? null : String(v);
}
function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeMeta(raw: unknown): OperationsMeta {
  const d = asRecord(asRecord(raw).data);
  return {
    types: asArray(d.types).map((t) => {
      const r = asRecord(t);
      return {
        documentType: String(r.documentType ?? ""),
        label: String(r.label ?? r.documentType ?? ""),
        table: r.table == null ? undefined : String(r.table),
        capability: str(r.capability),
        visible: r.visible !== false,
        available: r.available !== false,
        twoSided: !!r.twoSided,
        hasDocumentNumber: !!r.hasDocumentNumber,
        statuses: asArray(r.statuses).map((s) => {
          const sr = asRecord(s);
          return { raw: String(sr.raw ?? ""), canonical: String(sr.canonical ?? "") };
        }),
      };
    }),
    canonicalStatuses: asArray(d.canonicalStatuses).map(String),
    sortable: asArray(d.sortable).map(String),
    maxPageSize: num(d.maxPageSize) ?? 100,
    currency: String(d.currency ?? "SAR"),
  };
}

function normalizeSide(v: unknown): OperationSide {
  const r = asRecord(v);
  return { kind: String(r.kind ?? ""), id: str(r.id), label: str(r.label) };
}

function normalizeRow(v: unknown): OperationRow {
  const r = asRecord(v);
  const documentType = String(r.documentType ?? "");
  const documentId = String(r.documentId ?? "");
  return {
    id: String(r.id ?? `${documentType}:${documentId}`),
    documentType,
    documentTypeLabel: String(r.documentTypeLabel ?? documentType),
    documentId,
    documentNumber: str(r.documentNumber),
    date: str(r.date),
    status: String(r.status ?? ""),
    rawStatus: str(r.rawStatus),
    source: normalizeSide(r.source),
    destination: normalizeSide(r.destination),
    partyLabel: str(r.partyLabel),
    productSummary: str(r.productSummary),
    lineCount: num(r.lineCount),
    totalQuantity: num(r.totalQuantity),
    totalValue: num(r.totalValue),
    vatAmount: num(r.vatAmount),
    grossValue: num(r.grossValue),
    valueSigned: !!r.valueSigned,
    currency: String(r.currency ?? "SAR"),
    createdBy: str(r.createdBy),
    createdByName: str(r.createdByName),
    approvedBy: str(r.approvedBy),
    approvedByName: str(r.approvedByName),
    createdAt: str(r.createdAt),
  };
}

function normalizeList(raw: unknown): OperationsPage {
  const r = asRecord(raw);
  const pg = asRecord(r.pagination);
  const counts: Record<string, number> = {};
  for (const [k, v] of Object.entries(asRecord(r.counts))) counts[k] = num(v) ?? 0;
  return {
    data: asArray(r.data).map(normalizeRow),
    counts,
    pagination: {
      page: num(pg.page) ?? 1,
      pageSize: num(pg.pageSize) ?? 25,
      total: num(pg.total) ?? 0,
      totalPages: num(pg.totalPages) ?? 1,
    },
    includedTypes: asArray(r.includedTypes).map(String),
    unavailableTypes: asArray(r.unavailableTypes).map(String),
    deniedTypes: asArray(r.deniedTypes).map(String),
    scope: { allWarehousesAccess: !!asRecord(r.scope).allWarehousesAccess },
    generatedAt: str(r.generatedAt),
  };
}

function normalizeDetail(raw: unknown): OperationDetail {
  const r = asRecord(raw);
  return {
    data: normalizeRow(r.data),
    header: asRecord(r.header),
    lines: asArray(r.lines).map((l) => {
      const x = asRecord(l);
      return {
        id: str(x.id),
        itemId: str(x.itemId),
        itemName: str(x.itemName),
        unit: str(x.unit),
        qty: num(x.qty),
        unitCost: num(x.unitCost),
        lineTotal: num(x.lineTotal),
      };
    }),
    movements: asArray(r.movements).map((m) => {
      const x = asRecord(m);
      return {
        id: String(x.id ?? ""),
        at: str(x.at),
        itemId: str(x.itemId),
        itemName: str(x.itemName),
        type: str(x.type),
        qty: num(x.qty),
        reason: str(x.reason),
        warehouseId: str(x.warehouseId),
        referenceType: str(x.referenceType),
        referenceId: str(x.referenceId),
        actor: str(x.actor),
        notes: str(x.notes),
      };
    }),
    lots: asArray(r.lots).map((l) => {
      const x = asRecord(l);
      return {
        id: String(x.id ?? ""),
        lotId: str(x.lotId),
        lotNumber: str(x.lotNumber),
        expiryDate: str(x.expiryDate),
        itemId: str(x.itemId),
        warehouseId: str(x.warehouseId),
        signedQty: num(x.signedQty),
        referenceType: str(x.referenceType),
        referenceId: str(x.referenceId),
        at: str(x.at),
      };
    }),
    journals: asArray(r.journals).map((j) => {
      const x = asRecord(j);
      return {
        id: String(x.id ?? ""),
        journalNumber: str(x.journalNumber),
        journalDate: str(x.journalDate),
        totalDebit: num(x.totalDebit),
        totalCredit: num(x.totalCredit),
        referenceType: str(x.referenceType),
        description: str(x.description),
        entries: asArray(x.entries).map((e) => {
          const y = asRecord(e);
          return {
            accountCode: str(y.accountCode),
            accountName: str(y.accountName),
            debit: num(y.debit),
            credit: num(y.credit),
          };
        }),
      };
    }),
    timeline: asArray(r.timeline).map((e) => {
      const x = asRecord(e);
      return {
        action: str(x.action),
        fromStatus: str(x.fromStatus),
        toStatus: str(x.toStatus),
        actor: String(x.actor ?? ""),
        note: str(x.note),
        at: str(x.at),
        synthetic: !!x.synthetic,
      };
    }),
    capabilities: { requiredToView: str(asRecord(r.capabilities).requiredToView) },
  };
}
