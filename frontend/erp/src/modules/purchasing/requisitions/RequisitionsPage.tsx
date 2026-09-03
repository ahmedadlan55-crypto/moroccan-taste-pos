// Purchase Requisitions screen — the internal request that precedes a PO.
//   • List (shared DataTable) with status / branch / warehouse filters, a
//     "my requests" switch, and a PO column that names the order, not its id.
//   • Create / edit Drawer: a REAL branch picker that sets the warehouse, a
//     line-items table with the item combobox.
//   • Detail Drawer: stepper + timeline (who did what, when) + lines + a
//     status-driven action bar (submit / approve / reject / convert-to-PO).
//     Convert shows the lines with the supplier's price editable per line and
//     lands the approver ON the new order — a draft PO nobody is taken to is a
//     draft PO nobody finds.
// Create is gated on purchasing.requisitions.manage; approve/convert on
// purchasing.requisitions.approve via <Can> (backend stays authoritative).
//
// `?doc=<id>` opens a requisition directly — the PO detail links back here.
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ClipboardList, Plus, Trash2, FileText, ArrowLeftRight, ExternalLink } from "lucide-react";
import {
  Button,
  Drawer,
  ConfirmDialog,
  StatusBadge,
  LoadingState,
  ErrorState,
  PanelTitle,
  SearchableEntityCombobox,
  DatePicker,
  Toggle,
} from "@/shared/ui";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { Can } from "@/shared/permissions";
import { useCan } from "@/app/providers";
import { formatCurrency, formatDate, formatDateTime } from "@/shared/lib";
import { useAccessScope } from "@/modules/inventory/lib/hooks/useAccessScope";
import { useBranchOptions } from "@/modules/administration/users/pickers";
import { useT } from "@/i18n";
import { st } from "../features/procurement/labels";
import type { ApiError } from "@/shared/api";
import {
  useRequisitions,
  useRequisition,
  useCreateRequisition,
  useUpdateRequisition,
  useSubmitRequisition,
  useApproveRequisition,
  useRejectRequisition,
  useConvertRequisition,
  useDeleteRequisition,
  itemFetcher,
  supplierFetcher,
  todayISO,
  type RequisitionRow,
  type RequisitionDetail,
  type RequisitionInput,
  type RequisitionStatus,
  type ItemHit,
  type SupplierHit,
} from "./api";
import {
  buildConvertPayload,
  convertNetTotal,
  requisitionSteps,
  warehouseForBranch,
  type ConvertLineOverride,
} from "./lib";

// ── labels ────────────────────────────────────────────────────────────────
// The requisition lifecycle statuses (rendered via t("purchasing.status.*")).
const REQ_STATUSES: RequisitionStatus[] = ["draft", "submitted", "approved", "rejected", "converted"];
const errMsg = (e: unknown) => (e as ApiError)?.message ?? null;

// ── line editor draft ───────────────────────────────────────────────────────
interface LineDraft {
  key: string;
  item: ItemHit | null;
  quantity: number;
  unit: string;
  estimatedPrice: number;
  notes: string;
}
let _k = 0;
const newLine = (): LineDraft => ({ key: "L" + ++_k, item: null, quantity: 1, unit: "", estimatedPrice: 0, notes: "" });

function draftFromDetail(d: RequisitionDetail): LineDraft[] {
  return d.lines.map((l) => ({
    key: "L" + ++_k,
    item: l.item_id ? { id: l.item_id, name: l.item_name || l.item_id, sku: "" } : null,
    quantity: Number(l.quantity) || 0,
    unit: l.unit || "",
    estimatedPrice: Number(l.estimated_price) || 0,
    notes: l.notes || "",
  }));
}

// ════════════════════════════════════════════════════════════════════════════
export function RequisitionsPage() {
  const t = useT();
  const [sp, setSp] = useSearchParams();
  const [status, setStatus] = useState<string>("");
  const [branchId, setBranchId] = useState<string>("");
  const [warehouseId, setWarehouseId] = useState<string>("");
  const [mine, setMine] = useState(false);
  const list = useRequisitions({ status, branchId, warehouseId, mine, page: 1, pageSize: 200 });
  const branches = useBranchOptions(true);
  const access = useAccessScope();

  // Deep link: the PO detail points back at its source requisition.
  const [detailId, setDetailId] = useState<string | null>(sp.get("doc"));
  useEffect(() => { const d = sp.get("doc"); if (d) setDetailId(d); }, [sp]);
  const closeDetail = () => {
    setDetailId(null);
    if (sp.get("doc")) { const next = new URLSearchParams(sp); next.delete("doc"); setSp(next, { replace: true }); }
  };
  const [form, setForm] = useState<{ open: boolean; editing: RequisitionDetail | null }>({ open: false, editing: null });

  const rows = list.data?.data ?? [];

  const columns: ColumnDef<RequisitionRow>[] = useMemo(
    () => [
      { id: "req_number", header: t("purchasing.col.number"), accessor: (r) => r.req_number, sortable: true },
      {
        id: "status",
        header: t("common.status"),
        accessor: (r) => r.status,
        cell: (r) => <StatusBadge>{st(t, r.status)}</StatusBadge>,
        sortable: true,
      },
      // The two columns a purchasing manager scans first: who is asking, and
      // for which stock. Both were on the row and shown nowhere.
      { id: "branch", header: t("purchasing.requisitions.branch"), accessor: (r) => r.branch_name || r.branch_id || "", cell: (r) => r.branch_name || r.branch_id || "—", sortable: true },
      { id: "warehouse", header: t("purchasing.requisitions.warehouse"), accessor: (r) => r.warehouse_name || r.warehouse_id || "", cell: (r) => r.warehouse_name || r.warehouse_id || "—", sortable: true },
      { id: "needed_date", header: t("purchasing.requisitions.neededDate"), accessor: (r) => r.needed_date, cell: (r) => (r.needed_date ? formatDate(r.needed_date) : "—"), sortable: true },
      { id: "line_count", header: t("purchasing.lines.title"), accessor: (r) => r.line_count, numeric: true },
      { id: "estimated_total", header: t("purchasing.requisitions.estimatedTotal"), accessor: (r) => Number(r.estimated_total), cell: (r) => formatCurrency(Number(r.estimated_total)), numeric: true, sortable: true },
      {
        id: "po",
        header: t("purchasing.requisitions.poRef"),
        accessor: (r) => r.po_number || "",
        // The order's NUMBER, linked — never the id, which nobody can read.
        cell: (r) => r.po_id
          ? <Link className="font-bold text-teal-700 hover:underline" to={`/purchasing/orders?doc=${r.po_id}`} onClick={(e) => e.stopPropagation()}>{r.po_number || r.po_id}{r.po_status ? <span className="ms-1 text-[11px] font-bold text-slate-400">· {st(t, r.po_status)}</span> : null}</Link>
          : "—",
      },
      { id: "created_by", header: t("purchasing.field.createdBy"), accessor: (r) => r.created_by || "—" },
      { id: "created_at", header: t("purchasing.col.date"), accessor: (r) => r.created_at, cell: (r) => formatDate(r.created_at), sortable: true, defaultHidden: true },
    ],
    [t],
  );

  const warehouseChoices = access.data?.accessibleWarehouses ?? [];

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select
          className="field w-44"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          aria-label={t("purchasing.common.filterStatusAria")}
        >
          <option value="">{t("purchasing.common.allStatuses")}</option>
          {REQ_STATUSES.map((s) => (
            <option key={s} value={s}>{t(`purchasing.status.${s}`)}</option>
          ))}
        </select>
        <select className="field w-44" value={branchId} onChange={(e) => setBranchId(e.target.value)} aria-label={t("purchasing.requisitions.filterBranchAria")}>
          <option value="">{t("purchasing.requisitions.allBranches")}</option>
          {(branches.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <select className="field w-44" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} aria-label={t("purchasing.requisitions.filterWarehouseAria")}>
          <option value="">{t("purchasing.requisitions.allWarehouses")}</option>
          {warehouseChoices.map((w) => <option key={w.id} value={w.id}>{w.name || w.id}</option>)}
        </select>
        <label className="flex min-h-11 items-center gap-2 text-sm font-bold text-slate-600">
          <Toggle checked={mine} onChange={setMine} aria-label={t("purchasing.requisitions.mineOnly")} />
          {t("purchasing.requisitions.mineOnly")}
        </label>
        <div className="grow" />
        <Can cap="purchasing.requisitions.manage">
          <Button onClick={() => setForm({ open: true, editing: null })}>
            <Plus className="h-4 w-4" /> {t("purchasing.requisitions.newRequisition")}
          </Button>
        </Can>
      </div>

      <DataTable<RequisitionRow>
        columns={columns}
        rows={rows}
        getRowId={(r) => r.id}
        loading={list.isLoading}
        error={list.isError ? list.error : undefined}
        onRetry={() => list.refetch()}
        searchable
        searchPlaceholder={t("purchasing.requisitions.searchPlaceholder")}
        onRowClick={(r) => setDetailId(r.id)}
        emptyTitle={t("purchasing.requisitions.emptyTitle")}
        emptyBody={t("purchasing.requisitions.emptyBody")}
        initialSort={{ columnId: "created_at", dir: "desc" }}
        tableId="purchase-requisitions"
      />

      {form.open && (
        <RequisitionFormDrawer
          editing={form.editing}
          onClose={() => setForm({ open: false, editing: null })}
        />
      )}

      {detailId && (
        <RequisitionDetailDrawer
          id={detailId}
          onClose={closeDetail}
          onEdit={(d) => {
            closeDetail();
            setForm({ open: true, editing: d });
          }}
        />
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Create / edit drawer
// ════════════════════════════════════════════════════════════════════════════
function RequisitionFormDrawer({
  editing,
  onClose,
}: {
  editing: RequisitionDetail | null;
  onClose: () => void;
}) {
  const t = useT();
  const create = useCreateRequisition();
  const update = useUpdateRequisition();
  const busy = create.isPending || update.isPending;

  // The warehouse used to be a free-text "type the warehouse ID" box, so in
  // practice every requisition was filed with warehouse_id = NULL — and a NULL
  // matches no `warehouse_id IN (…)` scope list, which is how a request could
  // vanish from the requester's own list. It is a picker over the warehouses
  // this caller may actually touch, pre-selected when there is only one.
  //
  // The branch had the SAME free-text box, and the list filters by branch id:
  // a branch typed by name matched nothing. It is now a picker too, and picking
  // a branch fills the warehouse from the branch record — the pair cannot
  // disagree, and the request is found under either filter.
  const access = useAccessScope();
  const branches = useBranchOptions(true);
  const whOptions = access.data?.accessibleWarehouses ?? [];
  const onlyWarehouse = !access.data?.allWarehousesAccess && whOptions.length === 1 ? whOptions[0].id : "";

  const [neededDate, setNeededDate] = useState(editing?.needed_date || "");
  const [warehouseId, setWarehouseId] = useState(editing?.warehouse_id || "");
  const [branchId, setBranchId] = useState(editing?.branch_id || "");
  const [notes, setNotes] = useState(editing?.notes || "");
  const [lines, setLines] = useState<LineDraft[]>(editing ? draftFromDetail(editing) : [newLine()]);

  const estimatedTotal = useMemo(
    () => lines.reduce((s, l) => s + (Number(l.quantity) || 0) * (Number(l.estimatedPrice) || 0), 0),
    [lines],
  );

  // Derived, not an effect: an empty choice falls back to the caller's only
  // warehouse. Users with several warehouses (or global access) keep "" and can
  // deliberately file a company-wide request.
  const effectiveWarehouseId = warehouseId || onlyWarehouse;
  const warehouseChoices = useMemo(() => {
    const list = whOptions.map((w) => ({ id: w.id, name: w.name || w.id }));
    // keep an already-stored warehouse selectable even if it is outside the
    // picker's list (e.g. an admin editing another site's requisition, or the
    // warehouse a branch just set)
    if (effectiveWarehouseId && !list.some((w) => w.id === effectiveWarehouseId)) {
      list.unshift({ id: effectiveWarehouseId, name: effectiveWarehouseId });
    }
    return list;
  }, [whOptions, effectiveWarehouseId]);

  function onBranchChange(next: string) {
    setBranchId(next);
    const derived = warehouseForBranch(branches.data ?? [], next);
    if (derived) setWarehouseId(derived);
  }

  const validLines = lines.filter((l) => l.item && (Number(l.quantity) || 0) > 0);
  const canSave = validLines.length > 0 && !busy;
  const mutationError = errMsg(create.error) || errMsg(update.error);

  function patchLine(idx: number, patch: Partial<LineDraft>) {
    setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, ...patch } : x)));
  }

  function submit() {
    const input: RequisitionInput = {
      neededDate: neededDate || null,
      warehouseId: effectiveWarehouseId || null,
      branchId: branchId || null,
      notes: notes || null,
      lines: validLines.map((l) => ({
        itemId: (l.item as ItemHit).id,
        itemName: (l.item as ItemHit).name,
        quantity: Number(l.quantity) || 0,
        unit: l.unit || null,
        estimatedPrice: Number(l.estimatedPrice) || 0,
        notes: l.notes || null,
      })),
    };
    const onDone = { onSuccess: () => onClose() };
    if (editing) update.mutate({ id: editing.id, input }, onDone);
    else create.mutate(input, onDone);
  }

  return (
    <Drawer
      open
      onClose={onClose}
      icon={ClipboardList}
      eyebrow={editing ? t("purchasing.requisitions.editEyebrow", { number: editing.req_number }) : t("purchasing.requisitions.newRequisition")}
      title={editing ? t("purchasing.requisitions.editTitle") : t("purchasing.requisitions.createTitle")}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>{t("common.cancel")}</Button>
          <Button onClick={submit} disabled={!canSave} loading={busy}>
            {editing ? t("purchasing.common.saveChanges") : t("purchasing.requisitions.createSubmit")}
          </Button>
          <span className="ms-auto self-center text-sm text-slate-500">
            {t("purchasing.requisitions.estimatedTotal")}: <b className="tabular-nums text-teal-700">{formatCurrency(estimatedTotal)}</b>
          </span>
        </>
      }
    >
      <div className="grid gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-extrabold text-slate-500">{t("purchasing.requisitions.branch")}</span>
            <select
              className="field w-full"
              value={branchId}
              onChange={(e) => onBranchChange(e.target.value)}
              aria-label={t("purchasing.requisitions.branchAria")}
            >
              <option value="">{t("purchasing.requisitions.branchNone")}</option>
              {(branches.data ?? []).map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
            <span className="mt-1 block text-[11px] text-slate-400">{t("purchasing.requisitions.branchHint")}</span>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-extrabold text-slate-500">{t("purchasing.requisitions.warehouseOptional")}</span>
            <select
              className="field w-full"
              value={effectiveWarehouseId}
              onChange={(e) => setWarehouseId(e.target.value)}
              aria-label={t("purchasing.requisitions.warehouseAria")}
            >
              <option value="">{t("purchasing.requisitions.warehouseNone")}</option>
              {warehouseChoices.map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-extrabold text-slate-500">{t("purchasing.requisitions.neededDate")}</span>
            <DatePicker value={neededDate} min={todayISO()} onChange={setNeededDate} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-extrabold text-slate-500">{t("purchasing.field.notes")}</span>
            <input className="field w-full" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t("purchasing.common.optional")} />
          </label>
        </div>

        <section className="rounded-xl border border-slate-200">
          <PanelTitle
            title={t("purchasing.lines.title")}
            action={
              <Button variant="secondary" size="sm" onClick={() => setLines((ls) => [...ls, newLine()])}>
                <Plus className="h-4 w-4" /> {t("purchasing.lines.addLine")}
              </Button>
            }
          />
          <div className="grid gap-3 p-3">
            {lines.map((l, idx) => (
              <div key={l.key} className="grid gap-2 rounded-xl border border-slate-100 bg-slate-50/50 p-3">
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1.6fr)_0.7fr_0.7fr_0.9fr_auto] sm:items-end">
                  <div>
                    <span className="mb-1 block text-[11px] font-bold text-slate-400">{t("purchasing.col.item")}</span>
                    <SearchableEntityCombobox<ItemHit>
                      value={l.item}
                      onChange={(it) => patchLine(idx, { item: it, unit: l.unit || it?.baseUnit?.code || "" })}
                      fetcher={itemFetcher}
                      queryKey={["requisitions", "item-picker"]}
                      getKey={(it) => it.id}
                      getLabel={(it) => it.name}
                      getSublabel={(it) => it.sku || undefined}
                      placeholder={t("purchasing.requisitions.itemSearchPlaceholder")}
                      ariaLabel={t("purchasing.common.selectItemAria")}
                    />
                  </div>
                  <label className="block">
                    <span className="mb-1 block text-[11px] font-bold text-slate-400">{t("purchasing.lines.qty")}</span>
                    <input type="number" min={0} step="0.0001" className="field w-full tabular-nums" value={l.quantity}
                      onChange={(e) => patchLine(idx, { quantity: Number(e.target.value) })} />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-[11px] font-bold text-slate-400">{t("purchasing.requisitions.unit")}</span>
                    <input className="field w-full" value={l.unit} onChange={(e) => patchLine(idx, { unit: e.target.value })} placeholder={t("purchasing.requisitions.unitPlaceholder")} />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-[11px] font-bold text-slate-400">{t("purchasing.requisitions.estimatedPrice")}</span>
                    <input type="number" min={0} step="0.0001" className="field w-full tabular-nums" value={l.estimatedPrice}
                      onChange={(e) => patchLine(idx, { estimatedPrice: Number(e.target.value) })} />
                  </label>
                  <button
                    type="button"
                    aria-label={t("purchasing.lines.deleteLine")}
                    className="grid h-11 w-11 place-items-center rounded-xl text-slate-400 transition hover:bg-rose-50 hover:text-rose-600"
                    onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((_, i) => i !== idx) : ls))}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
                <input className="field w-full" value={l.notes} onChange={(e) => patchLine(idx, { notes: e.target.value })} placeholder={t("purchasing.requisitions.lineNotePlaceholder")} />
              </div>
            ))}
          </div>
        </section>

        {mutationError && <p className="text-sm font-semibold text-rose-600">{mutationError}</p>}
      </div>
    </Drawer>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Detail drawer + actions
// ════════════════════════════════════════════════════════════════════════════
function RequisitionDetailDrawer({
  id,
  onClose,
  onEdit,
}: {
  id: string;
  onClose: () => void;
  onEdit: (d: RequisitionDetail) => void;
}) {
  const t = useT();
  const navigate = useNavigate();
  const { data, isLoading, isError, error, refetch } = useRequisition(id);
  const canManage = useCan("purchasing.requisitions.manage");

  const submit = useSubmitRequisition();
  const approve = useApproveRequisition();
  const reject = useRejectRequisition();
  const convert = useConvertRequisition();
  const del = useDeleteRequisition();

  const [rejectOpen, setRejectOpen] = useState(false);
  const [converting, setConverting] = useState(false);
  const [supplier, setSupplier] = useState<SupplierHit | null>(null);
  const [overrides, setOverrides] = useState<Record<string, ConvertLineOverride>>({});

  const actionError =
    errMsg(submit.error) || errMsg(approve.error) || errMsg(reject.error) || errMsg(convert.error) || errMsg(del.error);
  const busy = submit.isPending || approve.isPending || reject.isPending || convert.isPending || del.isPending;

  const status = (data?.status ?? "draft") as RequisitionStatus;
  const steps = requisitionSteps(status);

  function doConvert() {
    if (!data || !supplier) return;
    convert.mutate(
      { id, ...buildConvertPayload(supplier.id, data.lines, overrides) },
      {
        onSuccess: (r) => {
          setConverting(false);
          // Land on the order. The old flow left a draft PO behind and the
          // approver on the requisition, hunting for what they just created.
          const poId = r?.data?.poId;
          if (poId) { onClose(); navigate(`/purchasing/orders?doc=${poId}`); } else refetch();
        },
      },
    );
  }

  const footer = data ? (
    <>
      {status === "draft" && canManage && (
        <>
          <Button onClick={() => submit.mutate(id, { onSuccess: () => refetch() })} loading={submit.isPending}>{t("purchasing.action.submit")}</Button>
          <Button variant="secondary" onClick={() => onEdit(data)} disabled={busy}>{t("common.edit")}</Button>
          <Button variant="danger" onClick={() => del.mutate(id, { onSuccess: () => onClose() })} loading={del.isPending}>{t("common.delete")}</Button>
        </>
      )}
      {status === "submitted" && (
        <>
          <Can cap="purchasing.requisitions.manage">
            <Button variant="secondary" onClick={() => onEdit(data)} disabled={busy}>{t("common.edit")}</Button>
          </Can>
          <Can cap="purchasing.requisitions.approve">
            <Button onClick={() => approve.mutate(id, { onSuccess: () => refetch() })} loading={approve.isPending}>{t("purchasing.action.approve")}</Button>
            <Button variant="danger" onClick={() => setRejectOpen(true)} disabled={busy}>{t("purchasing.requisitions.reject")}</Button>
          </Can>
        </>
      )}
      {status === "approved" && (
        <Can cap="purchasing.requisitions.approve">
          <Button onClick={() => setConverting((v) => !v)} disabled={busy}>
            <ArrowLeftRight className="h-4 w-4" /> {t("purchasing.requisitions.convert")}
          </Button>
        </Can>
      )}
      {status === "converted" && data.po_id && (
        <Link to={`/purchasing/orders?doc=${data.po_id}`} onClick={onClose}>
          <Button><ExternalLink className="h-4 w-4" /> {t("purchasing.requisitions.openPo")}</Button>
        </Link>
      )}
    </>
  ) : undefined;

  return (
    <Drawer
      open
      onClose={onClose}
      icon={ClipboardList}
      eyebrow={t("purchasing.requisitions.eyebrow")}
      title={data?.req_number || t("purchasing.requisitions.eyebrow")}
      footer={footer}
    >
      {isLoading ? (
        <LoadingState />
      ) : isError || !data ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : (
        <div className="grid gap-4">
          {/* Where the request is in its life — the same stepper the PO has. */}
          <ol className="flex flex-wrap items-center gap-2" aria-label={t("purchasing.requisitions.timelineTitle")}>
            {steps.map((s, i) => (
              <li key={s.key} className="flex items-center gap-2">
                <span className={`rounded-full px-3 py-1 text-xs font-extrabold ${
                  s.current
                    ? (s.key === "rejected" ? "bg-rose-600 text-white" : "bg-teal-600 text-white")
                    : s.reached ? "bg-teal-50 text-teal-700" : "bg-slate-100 text-slate-400"
                }`}>{t(`purchasing.requisitions.steps.${s.key}`)}</span>
                {i < steps.length - 1 && <span className="text-slate-300">›</span>}
              </li>
            ))}
          </ol>

          <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
            <KV label={t("purchasing.requisitions.branch")} value={data.branch_name || data.branch_id || "—"} />
            <KV label={t("purchasing.requisitions.warehouse")} value={data.warehouse_name || data.warehouse_id || "—"} />
            <KV label={t("purchasing.requisitions.neededDate")} value={data.needed_date ? formatDate(data.needed_date) : "—"} />
            <KV label={t("purchasing.requisitions.estimatedTotal")} value={formatCurrency(Number(data.estimatedTotal))} />
            <KV label={t("purchasing.field.createdBy")} value={`${data.created_by || "—"} · ${formatDateTime(data.created_at)}`} />
            {data.submitted_at && <KV label={t("purchasing.requisitions.submittedAt")} value={`${data.submitted_by || "—"} · ${formatDateTime(data.submitted_at)}`} />}
            {data.approved_at && <KV label={t("purchasing.requisitions.approvedAt")} value={`${data.approved_by || "—"} · ${formatDateTime(data.approved_at)}`} />}
            {data.rejected_at && <KV label={t("purchasing.requisitions.rejectedAt")} value={`${data.rejected_by || "—"} · ${formatDateTime(data.rejected_at)}`} />}
            {data.po_id && (
              <KV
                label={t("purchasing.requisitions.poRef")}
                value={<Link className="text-teal-700 hover:underline" to={`/purchasing/orders?doc=${data.po_id}`} onClick={onClose}>{data.po_number || data.po_id}{data.po_status ? ` · ${st(t, data.po_status)}` : ""}</Link>}
              />
            )}
          </div>

          {data.notes && (
            <div className="rounded-xl border border-slate-100 bg-slate-50 p-3 text-sm text-slate-600">{data.notes}</div>
          )}

          {status === "rejected" && data.reject_reason && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm font-semibold text-rose-700">
              {t("purchasing.requisitions.rejectReason")}: {data.reject_reason}
            </div>
          )}

          <section className="rounded-xl border border-slate-200">
            <PanelTitle icon={FileText} title={t("purchasing.lines.title")} />
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    <Th>{t("purchasing.col.item")}</Th>
                    <Th left>{t("purchasing.lines.qty")}</Th>
                    <Th>{t("purchasing.requisitions.unit")}</Th>
                    <Th left>{t("purchasing.requisitions.estimatedPrice")}</Th>
                    <Th left>{t("purchasing.col.total")}</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.lines.map((l) => (
                    <tr key={l.id}>
                      <Td>{l.item_name || l.item_id || "—"}</Td>
                      <Td left>{Number(l.quantity)}</Td>
                      <Td>{l.unit || "—"}</Td>
                      <Td left>{formatCurrency(Number(l.estimated_price))}</Td>
                      <Td left bold>{formatCurrency(Number(l.quantity) * Number(l.estimated_price))}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {converting && status === "approved" && (
            <section className="grid gap-3 rounded-xl border border-teal-200 bg-teal-50/40 p-3">
              <span className="text-xs font-extrabold text-slate-600">{t("purchasing.requisitions.chooseSupplier")}</span>
              <SearchableEntityCombobox<SupplierHit>
                value={supplier}
                onChange={setSupplier}
                fetcher={supplierFetcher}
                queryKey={["requisitions", "supplier-picker"]}
                getKey={(s) => s.id}
                getLabel={(s) => s.name}
                getSublabel={(s) => s.vat_number || undefined}
                placeholder={t("purchasing.requisitions.supplierSearchPlaceholder")}
                ariaLabel={t("purchasing.common.selectSupplierAria")}
              />

              {/* The supplier's ACTUAL price, per line. The server accepted
                  overrides from the start; the screen never offered them, so
                  every PO was created at the requester's estimate and then
                  edited by hand. */}
              <div>
                <span className="text-xs font-extrabold text-slate-600">{t("purchasing.requisitions.convertLinesTitle")}</span>
                <span className="ms-2 text-[11px] text-slate-400">{t("purchasing.requisitions.convertLinesHint")}</span>
              </div>
              <div className="overflow-x-auto rounded-lg border border-teal-100 bg-white">
                <table className="w-full border-collapse text-sm">
                  <thead className="bg-slate-50">
                    <tr>
                      <Th>{t("purchasing.col.item")}</Th>
                      <Th left>{t("purchasing.lines.qty")}</Th>
                      <Th left>{t("purchasing.requisitions.supplierPrice")}</Th>
                      <Th left>{t("purchasing.requisitions.vatPct")}</Th>
                      <Th left>{t("purchasing.col.total")}</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.lines.map((l) => {
                      const ov = overrides[l.id] ?? {};
                      const unit = ov.unitPrice ?? Number(l.estimated_price);
                      return (
                        <tr key={l.id}>
                          <Td>{l.item_name || l.item_id || "—"}</Td>
                          <Td left>{Number(l.quantity)}</Td>
                          <Td left>
                            <input
                              type="number" min={0} step="0.0001"
                              className="field w-28 tabular-nums"
                              value={unit}
                              aria-label={`${t("purchasing.requisitions.supplierPrice")} ${l.item_name || ""}`}
                              onChange={(e) => setOverrides((o) => ({ ...o, [l.id]: { ...o[l.id], unitPrice: Number(e.target.value) } }))}
                            />
                          </Td>
                          <Td left>
                            <input
                              type="number" min={0} max={100} step="0.5"
                              className="field w-20 tabular-nums"
                              value={ov.vatRate ?? ""}
                              placeholder={t("purchasing.requisitions.vatStandard")}
                              aria-label={`${t("purchasing.requisitions.vatPct")} ${l.item_name || ""}`}
                              onChange={(e) => setOverrides((o) => ({ ...o, [l.id]: { ...o[l.id], vatRate: e.target.value === "" ? null : Number(e.target.value) } }))}
                            />
                          </Td>
                          <Td left bold>{formatCurrency(Number(l.quantity) * unit)}</Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="text-slate-500">{t("purchasing.requisitions.convertNote")}</span>
                <span className="font-extrabold text-slate-800">{t("purchasing.requisitions.convertNet")}: <b className="tabular-nums text-teal-700">{formatCurrency(convertNetTotal(data.lines, overrides))}</b></span>
              </div>

              <div className="flex gap-2">
                <Button disabled={!supplier || convert.isPending} loading={convert.isPending} onClick={doConvert}>
                  {t("purchasing.requisitions.confirmConvert")}
                </Button>
                <Button variant="secondary" onClick={() => setConverting(false)} disabled={convert.isPending}>{t("common.cancel")}</Button>
              </div>
            </section>
          )}

          {actionError && <p className="text-sm font-semibold text-rose-600">{actionError}</p>}
        </div>
      )}

      <ConfirmDialog
        open={rejectOpen}
        title={t("purchasing.requisitions.rejectTitle")}
        description={t("purchasing.requisitions.rejectDescription")}
        tone="danger"
        confirmLabel={t("purchasing.requisitions.reject")}
        requireReason
        reasonLabel={t("purchasing.requisitions.rejectReason")}
        processing={reject.isPending}
        error={errMsg(reject.error)}
        onClose={() => setRejectOpen(false)}
        onConfirm={(reason) =>
          reject.mutate({ id, reason }, { onSuccess: () => { setRejectOpen(false); refetch(); } })
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
function Th({ children, left }: { children: React.ReactNode; left?: boolean }) {
  return <th className={`px-3 py-2 text-[11px] font-extrabold uppercase text-slate-400 ${left ? "text-end" : "text-start"}`}>{children}</th>;
}
function Td({ children, left, bold }: { children: React.ReactNode; left?: boolean; bold?: boolean }) {
  return <td className={`px-3 py-2.5 text-slate-700 ${left ? "text-end tabular-nums" : ""} ${bold ? "font-bold" : ""}`}>{children}</td>;
}

export default RequisitionsPage;
