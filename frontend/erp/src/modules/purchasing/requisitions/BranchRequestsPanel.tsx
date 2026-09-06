// Branch shortage requests — the cashier's «طلبات النواقص», in the back office.
//
// The POS files these into `shortage_requests` (routes/inventory.js
// /shortage-requests): a SEPARATE table from purchase requisitions with its own
// lifecycle — pending → approved → converted (to a PO) → partially/fully
// received → closed, or rejected. Until this panel, no back-office screen read
// that table: a manager could not see, approve or convert what a branch asked
// for, and the branch waited on a queue nobody was looking at.
//
// This is the approver's side of that same lifecycle (approve / reject /
// convert-to-PO). Receiving stays on the POS, where the branch does it.
// Actions are gated on purchasing.requisitions.approve via <Can>; the router
// stays authoritative.
//
// `?source=branch&doc=<id>` opens a request directly.
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Store, ExternalLink } from "lucide-react";
import {
  Button,
  Drawer,
  ConfirmDialog,
  StatusBadge,
  LoadingState,
  ErrorState,
  PanelTitle,
  SearchableEntityCombobox,
} from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { Can } from "@/shared/permissions";
import { formatCurrency, formatDate, formatDateTime } from "@/shared/lib";
import { useBranchOptions } from "@/modules/administration/users/pickers";
import { useT } from "@/i18n";
import type { ApiError } from "@/shared/api";
import {
  useBranchRequests,
  useBranchRequest,
  useApproveBranchRequest,
  useRejectBranchRequest,
  useConvertBranchRequest,
  supplierFetcher,
  type BranchRequestRow,
  type BranchRequestStatus,
  type SupplierHit,
} from "./api";

export const BRANCH_REQUEST_STATUSES: BranchRequestStatus[] = [
  "pending", "approved", "converted", "rejected", "partially_received", "fully_received", "closed",
];
// Mirrors SUPPLY_VALUES in administration/pages/Branches.tsx and the router's
// default ('parent_company').
const SUPPLY_MODES = ["parent_company", "warehouse", "auto"] as const;
const errMsg = (e: unknown) => (e as ApiError)?.message ?? null;

export function BranchRequestsPanel() {
  const t = useT();
  const [sp, setSp] = useSearchParams();
  const [status, setStatus] = useState<string>("");
  const [branchId, setBranchId] = useState<string>("");
  const list = useBranchRequests({ status, branchId });
  const branches = useBranchOptions(true);

  const [detailId, setDetailId] = useState<string | null>(sp.get("doc"));
  useEffect(() => { const d = sp.get("doc"); if (d) setDetailId(d); }, [sp]);
  const closeDetail = () => {
    setDetailId(null);
    if (sp.get("doc")) { const next = new URLSearchParams(sp); next.delete("doc"); setSp(next, { replace: true }); }
  };

  const rows = list.data ?? [];
  const statusLabel = (s: string) => t(`purchasing.branchRequests.status.${s}`);

  const columns: ColumnDef<BranchRequestRow>[] = useMemo(
    () => [
      { id: "requestNumber", header: t("purchasing.branchRequests.colNumber"), accessor: (r) => r.requestNumber, sortable: true },
      {
        id: "status",
        header: t("common.status"),
        accessor: (r) => r.status,
        cell: (r) => <StatusBadge>{statusLabel(r.status)}</StatusBadge>,
        sortable: true,
      },
      { id: "branch", header: t("purchasing.branchRequests.colBranch"), accessor: (r) => r.branchName || r.branchId, cell: (r) => r.branchName || r.branchId || "—" },
      { id: "warehouse", header: t("purchasing.branchRequests.colWarehouse"), accessor: (r) => r.warehouseName || r.warehouseId, cell: (r) => r.warehouseName || r.warehouseId || "—" },
      { id: "username", header: t("purchasing.branchRequests.colRequestedBy"), accessor: (r) => r.username, cell: (r) => r.username || "—" },
      { id: "totalItems", header: t("purchasing.branchRequests.colItems"), accessor: (r) => r.totalItems, numeric: true },
      {
        id: "po",
        header: t("purchasing.branchRequests.colPo"),
        accessor: (r) => r.poNumber || "",
        // The order's NUMBER, linked — never its id.
        cell: (r) => r.poId
          ? <Link className="font-bold text-teal-700 hover:underline" to={`/purchasing/orders?doc=${r.poId}`} onClick={(e) => e.stopPropagation()}>{r.poNumber || r.poId}</Link>
          : "—",
      },
      { id: "requestDate", header: t("purchasing.branchRequests.colDate"), accessor: (r) => r.requestDate, cell: (r) => (r.requestDate ? formatDate(r.requestDate) : "—"), sortable: true },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t],
  );

  return (
    <div>
      <p className="mb-3 text-sm text-slate-500">{t("purchasing.branchRequests.hint")}</p>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select
          className="field w-44"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          aria-label={t("purchasing.branchRequests.filterStatusAria")}
        >
          <option value="">{t("purchasing.branchRequests.allStatuses")}</option>
          {BRANCH_REQUEST_STATUSES.map((s) => (
            <option key={s} value={s}>{statusLabel(s)}</option>
          ))}
        </select>
        <select className="field w-44" value={branchId} onChange={(e) => setBranchId(e.target.value)} aria-label={t("purchasing.branchRequests.filterBranchAria")}>
          <option value="">{t("purchasing.branchRequests.allBranches")}</option>
          {(branches.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </div>

      <DataTable<BranchRequestRow>
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        loading={list.isLoading}
        error={list.isError ? list.error : undefined}
        onRetry={() => list.refetch()}
        searchable
        searchPlaceholder={t("purchasing.branchRequests.searchPlaceholder")}
        onRowClick={(r) => setDetailId(r.id)}
        emptyTitle={t("purchasing.branchRequests.emptyTitle")}
        emptyBody={t("purchasing.branchRequests.emptyBody")}
        initialSort={{ columnId: "requestDate", dir: "desc" }}
        tableId="branch-shortage-requests"
      />

      {detailId && <BranchRequestDrawer id={detailId} onClose={closeDetail} />}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Detail drawer — the approver's actions
// ═══════════════════════════════════════════════════════════════════════════
function BranchRequestDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useT();
  const navigate = useNavigate();
  const { data, isLoading, isError, error, refetch } = useBranchRequest(id);
  const approve = useApproveBranchRequest();
  const reject = useRejectBranchRequest();
  const convert = useConvertBranchRequest();

  const [approveOpen, setApproveOpen] = useState(false);
  const [supplyMode, setSupplyMode] = useState<string>("parent_company");
  const [rejectOpen, setRejectOpen] = useState(false);
  const [converting, setConverting] = useState(false);
  const [supplier, setSupplier] = useState<SupplierHit | null>(null);

  const busy = approve.isPending || reject.isPending || convert.isPending;
  const actionError = errMsg(approve.error) || errMsg(reject.error) || errMsg(convert.error);
  const status = data?.status;
  const estTotal = (data?.items ?? []).reduce((s, i) => s + i.requestedQty * i.unitPrice, 0);

  function doApprove() {
    approve.mutate({ id, supplyMode }, { onSuccess: () => { setApproveOpen(false); refetch(); } });
  }
  function doConvert() {
    if (!supplier) return;
    convert.mutate(
      { id, supplierId: supplier.id, supplierName: supplier.name },
      {
        onSuccess: (r) => {
          setConverting(false);
          // Land the approver ON the new order — a draft PO nobody is taken to
          // is a draft PO nobody finds.
          if (r?.poId) navigate(`/purchasing/orders?doc=${r.poId}`);
          else refetch();
        },
      },
    );
  }

  const footer = data ? (
    <div className="flex flex-wrap gap-2">
      {status === "pending" && (
        <Can cap="purchasing.requisitions.approve">
          <Button onClick={() => { setApproveOpen(true); setConverting(false); }} disabled={busy}>
            {t("purchasing.branchRequests.approve")}
          </Button>
          <Button variant="secondary" onClick={() => setRejectOpen(true)} disabled={busy}>
            {t("purchasing.branchRequests.reject")}
          </Button>
        </Can>
      )}
      {status === "approved" && (
        <Can cap="purchasing.requisitions.approve">
          <Button onClick={() => setConverting(true)} disabled={busy || converting}>
            {t("purchasing.branchRequests.convert")}
          </Button>
        </Can>
      )}
      {status === "converted" && data.poId && (
        <Button variant="secondary" onClick={() => navigate(`/purchasing/orders?doc=${data.poId}`)}>
          <ExternalLink className="h-4 w-4" /> {t("purchasing.branchRequests.openPo")}
        </Button>
      )}
      <Button variant="secondary" onClick={onClose}>{t("common.close")}</Button>
    </div>
  ) : undefined;

  return (
    <Drawer
      open
      onClose={onClose}
      icon={Store}
      eyebrow={t("purchasing.branchRequests.detailEyebrow")}
      title={data?.requestNumber || t("purchasing.branchRequests.detailEyebrow")}
      footer={footer}
    >
      {isLoading ? (
        <LoadingState />
      ) : isError || !data ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : (
        <div className="grid gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge>{t(`purchasing.branchRequests.status.${data.status}`)}</StatusBadge>
            {data.status === "converted" && data.poNumber && (
              <span className="text-sm text-slate-500">{t("purchasing.branchRequests.convertedTo", { number: data.poNumber })}</span>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <KV label={t("purchasing.branchRequests.colBranch")} value={data.branchName || data.branchId || "—"} />
            <KV label={t("purchasing.branchRequests.colWarehouse")} value={data.warehouseName || data.warehouseId || "—"} />
            <KV label={t("purchasing.branchRequests.requestedBy")} value={data.username || "—"} />
            <KV label={t("purchasing.branchRequests.requestDate")} value={data.requestDate ? formatDate(data.requestDate) : "—"} />
            <KV label={t("purchasing.branchRequests.supplyMode")} value={data.supplyMode ? t(`purchasing.branchRequests.supplyModes.${data.supplyMode}`) : "—"} />
            {data.approvedBy && (
              <KV label={t("purchasing.branchRequests.approvedBy")} value={`${data.approvedBy}${data.approvedAt ? " · " + formatDateTime(data.approvedAt) : ""}`} />
            )}
          </div>

          {data.notes && (
            <div className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-sm text-slate-700">
              <div className="text-[10px] font-bold text-slate-400">{t("purchasing.branchRequests.notes")}</div>
              <div className="whitespace-pre-wrap">{data.notes}</div>
            </div>
          )}

          <section>
            <PanelTitle icon={Store} title={t("purchasing.branchRequests.itemsTitle")} />
            <div className="overflow-x-auto rounded-lg border border-slate-100">
              <table className="w-full border-collapse text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    <Th>{t("purchasing.branchRequests.colItem")}</Th>
                    <Th>{t("purchasing.branchRequests.colUnit")}</Th>
                    <Th end>{t("purchasing.branchRequests.colCurrent")}</Th>
                    <Th end>{t("purchasing.branchRequests.colMin")}</Th>
                    <Th end>{t("purchasing.branchRequests.colRequested")}</Th>
                    <Th end>{t("purchasing.branchRequests.colEstPrice")}</Th>
                    <Th end>{t("purchasing.branchRequests.colTotal")}</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.items.map((i) => (
                    <tr key={i.id}>
                      <Td bold>{i.invItemName || i.invItemId || "—"}</Td>
                      <Td>{i.unit || "—"}</Td>
                      <Td end>{i.currentQty}</Td>
                      <Td end>{i.minQty}</Td>
                      <Td end bold>{i.requestedQty}</Td>
                      <Td end>{formatCurrency(i.unitPrice)}</Td>
                      <Td end bold>{formatCurrency(i.requestedQty * i.unitPrice)}</Td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-slate-50">
                    <td colSpan={6} className="px-3 py-2 text-end text-xs font-extrabold text-slate-500">{t("purchasing.branchRequests.colTotal")}</td>
                    <td className="px-3 py-2 text-end font-extrabold tabular-nums text-slate-800">{formatCurrency(estTotal)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>

          {approveOpen && status === "pending" && (
            <section className="grid gap-3 rounded-xl border border-teal-200 bg-teal-50/40 p-3">
              <span className="text-sm font-extrabold text-slate-700">{t("purchasing.branchRequests.approveTitle")}</span>
              <span className="text-xs text-slate-500">{t("purchasing.branchRequests.approveDescription")}</span>
              <div className="grid gap-1 text-xs font-bold text-slate-600">
                <span>{t("purchasing.branchRequests.supplyMode")}</span>
                <select
                  className="field w-56"
                  value={supplyMode}
                  aria-label={t("purchasing.branchRequests.supplyMode")}
                  onChange={(e) => setSupplyMode(e.target.value)}
                >
                  {SUPPLY_MODES.map((m) => <option key={m} value={m}>{t(`purchasing.branchRequests.supplyModes.${m}`)}</option>)}
                </select>
              </div>
              <div className="flex gap-2">
                <Button onClick={doApprove} disabled={approve.isPending} loading={approve.isPending}>{t("purchasing.branchRequests.approve")}</Button>
                <Button variant="secondary" onClick={() => setApproveOpen(false)} disabled={approve.isPending}>{t("common.cancel")}</Button>
              </div>
            </section>
          )}

          {converting && status === "approved" && (
            <section className="grid gap-3 rounded-xl border border-teal-200 bg-teal-50/40 p-3">
              <span className="text-xs font-extrabold text-slate-600">{t("purchasing.branchRequests.chooseSupplier")}</span>
              <SearchableEntityCombobox<SupplierHit>
                value={supplier}
                onChange={setSupplier}
                fetcher={supplierFetcher}
                queryKey={["branch-requests", "supplier-picker"]}
                getKey={(s) => s.id}
                getLabel={(s) => s.name}
                getSublabel={(s) => s.vat_number || undefined}
                placeholder={t("purchasing.branchRequests.supplierSearchPlaceholder")}
                ariaLabel={t("purchasing.common.selectSupplierAria")}
              />
              <div className="flex gap-2">
                <Button disabled={!supplier || convert.isPending} loading={convert.isPending} onClick={doConvert}>
                  {t("purchasing.branchRequests.confirmConvert")}
                </Button>
                <Button variant="secondary" onClick={() => setConverting(false)} disabled={convert.isPending}>{t("common.cancel")}</Button>
              </div>
            </section>
          )}

          {status !== "pending" && status !== "approved" && status !== "converted" && (
            <p className="text-xs text-slate-500">{t("purchasing.branchRequests.lockedNote")}</p>
          )}

          {actionError && <p className="text-sm font-semibold text-rose-600">{actionError}</p>}
        </div>
      )}

      <ConfirmDialog
        open={rejectOpen}
        title={t("purchasing.branchRequests.rejectTitle")}
        description={t("purchasing.branchRequests.rejectDescription")}
        tone="danger"
        confirmLabel={t("purchasing.branchRequests.reject")}
        requireReason
        reasonLabel={t("purchasing.branchRequests.rejectReason")}
        processing={reject.isPending}
        error={errMsg(reject.error)}
        onClose={() => setRejectOpen(false)}
        onConfirm={(reason) =>
          reject.mutate({ id, reason: reason || "" }, { onSuccess: () => { setRejectOpen(false); refetch(); } })
        }
      />
    </Drawer>
  );
}

// ── tiny display helpers ─────────────────────────────────────────────────────
function KV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2">
      <div className="text-[10px] font-bold text-slate-400">{label}</div>
      <div className="mt-0.5 font-extrabold text-slate-800">{value}</div>
    </div>
  );
}
function Th({ children, end }: { children: React.ReactNode; end?: boolean }) {
  return <th className={`px-3 py-2 text-[11px] font-extrabold uppercase text-slate-400 ${end ? "text-end" : "text-start"}`}>{children}</th>;
}
function Td({ children, end, bold }: { children: React.ReactNode; end?: boolean; bold?: boolean }) {
  return <td className={`px-3 py-2.5 text-slate-700 ${end ? "text-end tabular-nums" : ""} ${bold ? "font-bold" : ""}`}>{children}</td>;
}
