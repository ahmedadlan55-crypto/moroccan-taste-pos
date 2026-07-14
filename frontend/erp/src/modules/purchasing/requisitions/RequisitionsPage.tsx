// Purchase Requisitions screen — the internal request that precedes a PO.
//   • List (shared DataTable) with a status filter + search.
//   • Create / edit Drawer: header + a line-items table with the item combobox.
//   • Detail Drawer: header + lines + a status-driven action bar
//     (submit / approve / reject / convert-to-PO). Reject uses ConfirmDialog with
//     a mandatory reason; convert reveals an inline supplier picker.
// Create is gated on purchasing.requisitions.manage; approve/convert on
// purchasing.requisitions.approve via <Can> (backend stays authoritative).
import { useMemo, useState } from "react";
import { ClipboardList, Plus, Trash2, FileText, ArrowLeftRight } from "lucide-react";
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
import { useCan } from "@/app/providers";
import { formatCurrency, formatDate } from "@/shared/lib";
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

// ── labels ────────────────────────────────────────────────────────────────
const STATUS_AR: Record<RequisitionStatus, string> = {
  draft: "مسودة",
  submitted: "مُقدّم",
  approved: "معتمد",
  rejected: "مرفوض",
  converted: "محوّل لأمر شراء",
};
const st = (s: string) => STATUS_AR[s as RequisitionStatus] ?? s;
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
  const [status, setStatus] = useState<string>("");
  const list = useRequisitions({ status, page: 1, pageSize: 200 });

  const [detailId, setDetailId] = useState<string | null>(null);
  const [form, setForm] = useState<{ open: boolean; editing: RequisitionDetail | null }>({ open: false, editing: null });

  const rows = list.data?.data ?? [];

  const columns: ColumnDef<RequisitionRow>[] = useMemo(
    () => [
      { id: "req_number", header: "الرقم", accessor: (r) => r.req_number, sortable: true },
      {
        id: "status",
        header: "الحالة",
        accessor: (r) => r.status,
        cell: (r) => <StatusBadge>{st(r.status)}</StatusBadge>,
        sortable: true,
      },
      { id: "needed_date", header: "تاريخ الحاجة", accessor: (r) => r.needed_date, cell: (r) => (r.needed_date ? formatDate(r.needed_date) : "—"), sortable: true },
      { id: "line_count", header: "السطور", accessor: (r) => r.line_count, numeric: true },
      { id: "estimated_total", header: "القيمة التقديرية", accessor: (r) => Number(r.estimated_total), cell: (r) => formatCurrency(Number(r.estimated_total)), numeric: true, sortable: true },
      { id: "created_by", header: "أنشأه", accessor: (r) => r.created_by || "—" },
      { id: "created_at", header: "التاريخ", accessor: (r) => r.created_at, cell: (r) => formatDate(r.created_at), sortable: true, defaultHidden: true },
    ],
    [],
  );

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select
          className="field w-44"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          aria-label="تصفية الحالة"
        >
          <option value="">كل الحالات</option>
          {(Object.keys(STATUS_AR) as RequisitionStatus[]).map((s) => (
            <option key={s} value={s}>{STATUS_AR[s]}</option>
          ))}
        </select>
        <div className="grow" />
        <Can cap="purchasing.requisitions.manage">
          <Button onClick={() => setForm({ open: true, editing: null })}>
            <Plus className="h-4 w-4" /> طلب شراء جديد
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
        searchPlaceholder="بحث بالرقم / الملاحظات…"
        onRowClick={(r) => setDetailId(r.id)}
        emptyTitle="لا طلبات شراء"
        emptyBody="ابدأ بإنشاء طلب شراء داخلي — يُحوَّل لاحقًا إلى أمر شراء."
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
          onClose={() => setDetailId(null)}
          onEdit={(d) => {
            setDetailId(null);
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
  const create = useCreateRequisition();
  const update = useUpdateRequisition();
  const busy = create.isPending || update.isPending;

  const [neededDate, setNeededDate] = useState(editing?.needed_date || "");
  const [warehouseId, setWarehouseId] = useState(editing?.warehouse_id || "");
  const [branchId, setBranchId] = useState(editing?.branch_id || "");
  const [notes, setNotes] = useState(editing?.notes || "");
  const [lines, setLines] = useState<LineDraft[]>(editing ? draftFromDetail(editing) : [newLine()]);

  const estimatedTotal = useMemo(
    () => lines.reduce((s, l) => s + (Number(l.quantity) || 0) * (Number(l.estimatedPrice) || 0), 0),
    [lines],
  );

  const validLines = lines.filter((l) => l.item && (Number(l.quantity) || 0) > 0);
  const canSave = validLines.length > 0 && !busy;
  const mutationError = errMsg(create.error) || errMsg(update.error);

  function patchLine(idx: number, patch: Partial<LineDraft>) {
    setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, ...patch } : x)));
  }

  function submit() {
    const input: RequisitionInput = {
      neededDate: neededDate || null,
      warehouseId: warehouseId || null,
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
      eyebrow={editing ? `تعديل ${editing.req_number}` : "طلب شراء جديد"}
      title={editing ? "تعديل طلب الشراء" : "إنشاء طلب شراء"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>إلغاء</Button>
          <Button onClick={submit} disabled={!canSave} loading={busy}>
            {editing ? "حفظ التعديلات" : "إنشاء الطلب"}
          </Button>
          <span className="ms-auto self-center text-sm text-slate-500">
            القيمة التقديرية: <b className="tabular-nums text-teal-700">{formatCurrency(estimatedTotal)}</b>
          </span>
        </>
      }
    >
      <div className="grid gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-extrabold text-slate-500">تاريخ الحاجة</span>
            <input type="date" className="field w-full" value={neededDate} min={todayISO()} onChange={(e) => setNeededDate(e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-extrabold text-slate-500">المستودع (اختياري)</span>
            <input className="field w-full" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} placeholder="معرّف المستودع" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-extrabold text-slate-500">الفرع (اختياري)</span>
            <input className="field w-full" value={branchId} onChange={(e) => setBranchId(e.target.value)} placeholder="معرّف الفرع" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-extrabold text-slate-500">ملاحظات</span>
            <input className="field w-full" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="اختياري" />
          </label>
        </div>

        <section className="rounded-xl border border-slate-200">
          <PanelTitle
            title="السطور"
            action={
              <Button variant="secondary" size="sm" onClick={() => setLines((ls) => [...ls, newLine()])}>
                <Plus className="h-4 w-4" /> سطر
              </Button>
            }
          />
          <div className="grid gap-3 p-3">
            {lines.map((l, idx) => (
              <div key={l.key} className="grid gap-2 rounded-xl border border-slate-100 bg-slate-50/50 p-3">
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1.6fr)_0.7fr_0.7fr_0.9fr_auto] sm:items-end">
                  <div>
                    <span className="mb-1 block text-[11px] font-bold text-slate-400">المادة</span>
                    <SearchableEntityCombobox<ItemHit>
                      value={l.item}
                      onChange={(it) => patchLine(idx, { item: it, unit: l.unit || it?.baseUnit?.code || "" })}
                      fetcher={itemFetcher}
                      queryKey={["requisitions", "item-picker"]}
                      getKey={(it) => it.id}
                      getLabel={(it) => it.name}
                      getSublabel={(it) => it.sku || undefined}
                      placeholder="ابحث بالاسم / SKU…"
                      ariaLabel="اختيار المادة"
                    />
                  </div>
                  <label className="block">
                    <span className="mb-1 block text-[11px] font-bold text-slate-400">الكمية</span>
                    <input type="number" min={0} step="0.0001" className="field w-full tabular-nums" value={l.quantity}
                      onChange={(e) => patchLine(idx, { quantity: Number(e.target.value) })} />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-[11px] font-bold text-slate-400">الوحدة</span>
                    <input className="field w-full" value={l.unit} onChange={(e) => patchLine(idx, { unit: e.target.value })} placeholder="مثال: كجم" />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-[11px] font-bold text-slate-400">السعر التقديري</span>
                    <input type="number" min={0} step="0.0001" className="field w-full tabular-nums" value={l.estimatedPrice}
                      onChange={(e) => patchLine(idx, { estimatedPrice: Number(e.target.value) })} />
                  </label>
                  <button
                    type="button"
                    aria-label="حذف السطر"
                    className="grid h-11 w-11 place-items-center rounded-xl text-slate-400 transition hover:bg-rose-50 hover:text-rose-600"
                    onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((_, i) => i !== idx) : ls))}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
                <input className="field w-full" value={l.notes} onChange={(e) => patchLine(idx, { notes: e.target.value })} placeholder="ملاحظة السطر (اختياري)" />
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

  const actionError =
    errMsg(submit.error) || errMsg(approve.error) || errMsg(reject.error) || errMsg(convert.error) || errMsg(del.error);
  const busy = submit.isPending || approve.isPending || reject.isPending || convert.isPending || del.isPending;

  const status = (data?.status ?? "draft") as RequisitionStatus;

  const footer = data ? (
    <>
      {status === "draft" && canManage && (
        <>
          <Button onClick={() => submit.mutate(id, { onSuccess: () => refetch() })} loading={submit.isPending}>تقديم</Button>
          <Button variant="secondary" onClick={() => onEdit(data)} disabled={busy}>تعديل</Button>
          <Button variant="danger" onClick={() => del.mutate(id, { onSuccess: () => onClose() })} loading={del.isPending}>حذف</Button>
        </>
      )}
      {status === "submitted" && (
        <>
          <Can cap="purchasing.requisitions.manage">
            <Button variant="secondary" onClick={() => onEdit(data)} disabled={busy}>تعديل</Button>
          </Can>
          <Can cap="purchasing.requisitions.approve">
            <Button onClick={() => approve.mutate(id, { onSuccess: () => refetch() })} loading={approve.isPending}>اعتماد</Button>
            <Button variant="danger" onClick={() => setRejectOpen(true)} disabled={busy}>رفض</Button>
          </Can>
        </>
      )}
      {status === "approved" && (
        <Can cap="purchasing.requisitions.approve">
          <Button onClick={() => setConverting((v) => !v)} disabled={busy}>
            <ArrowLeftRight className="h-4 w-4" /> تحويل إلى أمر شراء
          </Button>
        </Can>
      )}
    </>
  ) : undefined;

  return (
    <Drawer
      open
      onClose={onClose}
      icon={ClipboardList}
      eyebrow="طلب شراء"
      title={data?.req_number || "طلب شراء"}
      footer={footer}
    >
      {isLoading ? (
        <LoadingState />
      ) : isError || !data ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : (
        <div className="grid gap-4">
          <div className="flex items-center justify-between">
            <StatusBadge>{st(status)}</StatusBadge>
            {data.po_id && (
              <span className="text-xs font-bold text-teal-700">أمر الشراء: {data.po_id}</span>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2 text-sm">
            <KV label="تاريخ الحاجة" value={data.needed_date ? formatDate(data.needed_date) : "—"} />
            <KV label="طلبه" value={data.requested_by || "—"} />
            <KV label="أنشأه" value={data.created_by || "—"} />
            <KV label="القيمة التقديرية" value={formatCurrency(Number(data.estimatedTotal))} />
            {data.approved_by && <KV label="اعتمده" value={data.approved_by} />}
          </div>

          {data.notes && (
            <div className="rounded-xl border border-slate-100 bg-slate-50 p-3 text-sm text-slate-600">{data.notes}</div>
          )}

          {status === "rejected" && data.reject_reason && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm font-semibold text-rose-700">
              سبب الرفض: {data.reject_reason}
            </div>
          )}

          <section className="rounded-xl border border-slate-200">
            <PanelTitle icon={FileText} title="السطور" />
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    <Th>المادة</Th>
                    <Th left>الكمية</Th>
                    <Th>الوحدة</Th>
                    <Th left>السعر التقديري</Th>
                    <Th left>الإجمالي</Th>
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
              <span className="text-xs font-extrabold text-slate-600">اختر المورد لإنشاء أمر الشراء</span>
              <SearchableEntityCombobox<SupplierHit>
                value={supplier}
                onChange={setSupplier}
                fetcher={supplierFetcher}
                queryKey={["requisitions", "supplier-picker"]}
                getKey={(s) => s.id}
                getLabel={(s) => s.name}
                getSublabel={(s) => s.vat_number || undefined}
                placeholder="ابحث بالاسم / الرقم الضريبي…"
                ariaLabel="اختيار المورد"
              />
              <div className="flex gap-2">
                <Button
                  disabled={!supplier || convert.isPending}
                  loading={convert.isPending}
                  onClick={() =>
                    supplier &&
                    convert.mutate(
                      { id, supplierId: supplier.id },
                      { onSuccess: () => { setConverting(false); refetch(); } },
                    )
                  }
                >
                  تأكيد التحويل
                </Button>
                <Button variant="secondary" onClick={() => setConverting(false)} disabled={convert.isPending}>إلغاء</Button>
              </div>
            </section>
          )}

          {actionError && <p className="text-sm font-semibold text-rose-600">{actionError}</p>}
        </div>
      )}

      <ConfirmDialog
        open={rejectOpen}
        title="رفض طلب الشراء"
        description="سيُرفض الطلب ولا يمكن تحويله إلى أمر شراء."
        tone="danger"
        confirmLabel="رفض"
        requireReason
        reasonLabel="سبب الرفض"
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
  return <th className={`px-3 py-2 text-[11px] font-extrabold uppercase text-slate-400 ${left ? "text-left" : "text-right"}`}>{children}</th>;
}
function Td({ children, left, bold }: { children: React.ReactNode; left?: boolean; bold?: boolean }) {
  return <td className={`px-3 py-2.5 text-slate-700 ${left ? "text-left tabular-nums" : ""} ${bold ? "font-bold" : ""}`}>{children}</td>;
}

export default RequisitionsPage;
