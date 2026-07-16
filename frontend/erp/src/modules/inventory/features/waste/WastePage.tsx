import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PackageMinus, Plus, Trash2 } from "lucide-react";
import { apiClient } from "@/shared/api";
import {
  Button, ConfirmDialog, Dialog, EmptyState, ErrorState, LoadingState, PageHeader, PanelTitle,
  StatusBadge, useToast,
} from "@/shared/ui";
import { usePermissions } from "@/app/providers";
import { useItemList } from "@/modules/inventory/lib/hooks/useItems";
import { useWarehouses } from "@/modules/inventory/lib/hooks/useWarehouses";

// /inventory/waste — the React face of the waste-entry backend hardened in
// 89c8e6a (transaction, idempotency, qty validation, JWT actor, period lock,
// reason-granular GL: each reason posts to its own 512x sub-account).
//
// Honest scope, stated rather than implied:
//  · There is NO approval step and NO attachments — waste_entries has no columns
//    for either. A waste entry posts its GL on create; deleting reverses it.
//    Building approval means new columns + a state machine, deliberately not
//    smuggled in here.
//  · The server may answer HTTP 200 with { success:false } (validation,
//    closed period) — the UI checks the flag, never just the status.

const REASONS = [
  { value: "expired", label: "منتهي الصلاحية" },
  { value: "damaged", label: "تالف" },
  { value: "spill", label: "انسكاب / تشغيل" },
  { value: "prep_loss", label: "فاقد تحضير" },
  { value: "customer_return", label: "مرتجع عميل (هدر)" },
  { value: "other", label: "أخرى" },
] as const;
type Reason = (typeof REASONS)[number]["value"];
const REASON_LABEL: Record<string, string> = Object.fromEntries(REASONS.map((r) => [r.value, r.label]));

interface WasteRow {
  id: string;
  wasteNumber: string;
  wasteDate: string;
  reason: string;
  warehouseId: string;
  warehouseName: string;
  branchName: string;
  totalCost: number;
  notes: string;
  createdBy: string;
  createdAt: string;
}
interface WasteListResponse {
  success: boolean;
  items: WasteRow[];
  total: number;
  summary: { total: number; totalCost: number; byReason: Record<string, { count: number; cost: number }> };
}
interface WasteItemLine {
  id: string; itemId: string; itemName: string; sku: string;
  quantity: number; unit: string; unitCost: number; lineCost: number;
}
interface CreateLine { itemId: string; itemName: string; unit: string; quantity: number; unitCost: number }

const fmt = (n: number) => new Intl.NumberFormat("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
const uid = () => {
  try { if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID(); } catch { /* jsdom */ }
  return "idem-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
};

export function WastePage() {
  const { can } = usePermissions();
  const canCreate = can("waste.create");
  const { toast } = useToast();
  const qc = useQueryClient();
  const [reasonFilter, setReasonFilter] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<WasteRow | null>(null);

  const list = useQuery({
    queryKey: ["inv", "waste", { reason: reasonFilter }],
    queryFn: ({ signal }) =>
      apiClient.get<WasteListResponse>("/erp/waste-entries", {
        signal,
        params: { paginated: "1", limit: 100, ...(reasonFilter ? { reason: reasonFilter } : {}) },
      }),
  });

  const del = useMutation({
    mutationFn: (id: string) => apiClient.delete<{ success: boolean; error?: string }>(`/erp/waste-entries/${id}`),
    onSuccess: (r) => {
      if (!r.success) { toast({ tone: "error", title: r.error || "تعذّر الحذف" }); return; }
      toast({ tone: "success", title: "أُلغي قيد الهدر وعُكست آثاره (المخزون + القيد)" });
      qc.invalidateQueries({ queryKey: ["inv", "waste"] });
      setToDelete(null);
    },
    onError: (e) => toast({ tone: "error", title: e instanceof Error ? e.message : "تعذّر الحذف" }),
  });

  const rows = list.data?.items ?? [];
  const summary = list.data?.summary;

  return (
    <div>
      <PageHeader
        eyebrow="المخزون"
        title="الهدر"
        subtitle="خصم فوري من المخزون مع قيد محاسبي بحساب فرعي لكل سبب"
        action={canCreate ? (
          <Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" /> تسجيل هدر</Button>
        ) : undefined}
      />

      {/* No approval workflow exists for waste — the entry posts on create. Said
          here so nobody hunts for a nonexistent "اعتماد" button. */}
      <p className="mb-4 text-xs font-semibold text-slate-400">
        قيد الهدر يُرحَّل محاسبيًا فور تسجيله ويخصم المخزون مباشرة — لا توجد خطوة اعتماد ولا مرفقات في هذا الإصدار؛ الحذف يعكس الأثرين معًا.
      </p>

      {summary && (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="section surface p-3">
            <p className="text-xs font-bold text-slate-500">إجمالي القيود</p>
            <p className="text-lg font-extrabold tabular-nums text-slate-800">{summary.total}</p>
          </div>
          <div className="section surface p-3">
            <p className="text-xs font-bold text-slate-500">إجمالي التكلفة</p>
            <p className="text-lg font-extrabold tabular-nums text-slate-800">{fmt(summary.totalCost)}</p>
          </div>
          {(["expired", "damaged"] as const).map((k) => (
            <div key={k} className="section surface p-3">
              <p className="text-xs font-bold text-slate-500">{REASON_LABEL[k]}</p>
              <p className="text-lg font-extrabold tabular-nums text-slate-800">
                {summary.byReason?.[k]?.count ?? 0} <span className="text-xs font-bold text-slate-400">({fmt(summary.byReason?.[k]?.cost ?? 0)})</span>
              </p>
            </div>
          ))}
        </div>
      )}

      <section className="section surface">
        <PanelTitle
          icon={PackageMinus}
          title="سجل الهدر"
          action={
            <select className="field" value={reasonFilter} onChange={(e) => setReasonFilter(e.target.value)} aria-label="تصفية بالسبب">
              <option value="">كل الأسباب</option>
              {REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          }
        />
        {list.isLoading ? (
          <LoadingState rows={5} />
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState title="لا يوجد هدر مسجّل" body={reasonFilter ? "لا قيود بهذا السبب." : "سجّل أول قيد هدر من الزر أعلاه."} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-right text-xs font-extrabold text-slate-500">
                  <th className="py-2">الرقم</th>
                  <th className="py-2">التاريخ</th>
                  <th className="py-2">المستودع</th>
                  <th className="py-2">السبب</th>
                  <th className="py-2">التكلفة</th>
                  <th className="py-2">بواسطة</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((w) => (
                  <WasteRowView
                    key={w.id}
                    row={w}
                    expanded={expanded === w.id}
                    onToggle={() => setExpanded(expanded === w.id ? null : w.id)}
                    onDelete={canCreate ? () => setToDelete(w) : undefined}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {createOpen && (
        <CreateWasteDialog
          onClose={() => setCreateOpen(false)}
          onCreated={(n) => {
            toast({ tone: "success", title: n ? `سُجّل الهدر ${n}` : "سُجّل الهدر" });
            qc.invalidateQueries({ queryKey: ["inv", "waste"] });
            setCreateOpen(false);
          }}
        />
      )}

      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        title={`إلغاء قيد الهدر ${toDelete?.wasteNumber || ""}؟`}
        description="سيُعاد المخزون المخصوم ويُعكس القيد المحاسبي داخل معاملة واحدة."
        tone="danger"
        confirmLabel="إلغاء القيد"
        processing={del.isPending}
        onConfirm={() => toDelete && del.mutate(toDelete.id)}
      />
    </div>
  );
}

function WasteRowView({ row, expanded, onToggle, onDelete }: { row: WasteRow; expanded: boolean; onToggle: () => void; onDelete?: () => void }) {
  const items = useQuery({
    enabled: expanded,
    queryKey: ["inv", "waste", row.id, "items"],
    queryFn: ({ signal }) => apiClient.get<WasteItemLine[]>(`/erp/waste-entries/${row.id}/items`, { signal }),
  });
  return (
    <>
      <tr className="border-b border-slate-100">
        <td className="py-2">
          <button type="button" onClick={onToggle} className="font-bold tabular-nums text-teal-700 hover:underline" dir="ltr">
            {row.wasteNumber || row.id}
          </button>
        </td>
        <td className="py-2 tabular-nums text-slate-600" dir="ltr">{String(row.wasteDate).slice(0, 10)}</td>
        <td className="py-2 text-slate-600">{row.warehouseName || row.warehouseId}</td>
        <td className="py-2"><StatusBadge dot>{REASON_LABEL[row.reason] || row.reason}</StatusBadge></td>
        <td className="py-2 tabular-nums font-bold text-slate-700">{fmt(row.totalCost)}</td>
        <td className="py-2 text-slate-500">{row.createdBy}</td>
        <td className="py-2 text-left">
          {onDelete && (
            <Button size="sm" variant="ghost" onClick={onDelete} aria-label={`إلغاء ${row.wasteNumber || row.id}`}>
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-slate-100 bg-slate-50/60">
          <td colSpan={7} className="px-4 py-2">
            {items.isLoading ? (
              <LoadingState rows={2} />
            ) : items.isError ? (
              <ErrorState error={items.error} onRetry={() => items.refetch()} />
            ) : (
              <ul className="space-y-1">
                {(items.data ?? []).map((l) => (
                  <li key={l.id} className="text-xs font-semibold text-slate-600">
                    {l.itemName || l.itemId} — <span className="tabular-nums">{l.quantity}</span> {l.unit}
                    {" × "}<span className="tabular-nums">{fmt(l.unitCost)}</span>
                    {" = "}<span className="tabular-nums font-bold">{fmt(l.lineCost)}</span>
                  </li>
                ))}
                {row.notes ? <li className="pt-1 text-xs text-slate-400">ملاحظات: {row.notes}</li> : null}
              </ul>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

const today = () => new Date().toISOString().slice(0, 10);

function CreateWasteDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (wasteNumber: string | null) => void }) {
  const { toast } = useToast();
  const [warehouseId, setWarehouseId] = useState("");
  const [wasteDate, setWasteDate] = useState(today());
  const [reason, setReason] = useState<Reason>("expired");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<CreateLine[]>([]);
  const [search, setSearch] = useState("");
  // One key per dialog OPEN: a retry after a network hiccup replays instead of
  // double-deducting (the exact bug the backend's idempotency exists to stop).
  const [idemKey] = useState(uid);

  const warehouses = useWarehouses();
  const items = useItemList({ q: search, pageSize: 8, status: "active" });

  const total = useMemo(() => lines.reduce((s, l) => s + l.quantity * l.unitCost, 0), [lines]);

  const save = useMutation({
    mutationFn: () =>
      apiClient.post<{ success: boolean; error?: string; wasteNumber?: string | null }>(
        "/erp/waste-entries",
        {
          warehouseId, wasteDate, reason, notes: notes || undefined,
          items: lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity, unit: l.unit, unitCost: l.unitCost })),
        },
        { headers: { "X-Idempotency-Key": idemKey } },
      ),
    onSuccess: (r) => {
      // The server answers 200 with success:false for validation/closed-period —
      // treating that as success would report a deduction that never happened.
      if (!r.success) { toast({ tone: "error", title: r.error || "رفض الخادم تسجيل الهدر" }); return; }
      onCreated(r.wasteNumber ?? null);
    },
    onError: (e) => toast({ tone: "error", title: e instanceof Error ? e.message : "تعذّر تسجيل الهدر" }),
  });

  const canSubmit = !!warehouseId && lines.length > 0 && lines.every((l) => l.quantity > 0) && !save.isPending;

  return (
    <Dialog open onClose={onClose} title="تسجيل هدر" size="lg"
      footer={
        <div className="flex w-full items-center justify-between">
          <span className="text-sm font-extrabold tabular-nums text-slate-700">الإجمالي: {fmt(total)}</span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onClose}>إغلاق</Button>
            <Button loading={save.isPending} disabled={!canSubmit} onClick={() => save.mutate()}>تسجيل وترحيل</Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <label className="flex flex-col gap-1 text-xs font-bold text-slate-600">
            المستودع
            <select className="field" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              <option value="">— اختر —</option>
              {(warehouses.data?.warehouses ?? []).map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-bold text-slate-600">
            التاريخ
            <input dir="ltr" type="date" className="field tabular-nums" value={wasteDate} onChange={(e) => setWasteDate(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-xs font-bold text-slate-600">
            السبب — يحدد الحساب المحاسبي
            <select className="field" value={reason} onChange={(e) => setReason(e.target.value as Reason)}>
              {REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </label>
        </div>

        <div className="rounded-2xl border border-slate-200 p-3">
          <p className="mb-2 text-xs font-extrabold text-slate-600">الأصناف</p>
          {lines.map((l, i) => (
            <div key={l.itemId} className="mb-2 grid grid-cols-12 items-center gap-2 rounded-xl bg-slate-50 px-3 py-2">
              <span className="col-span-5 truncate text-sm font-bold text-slate-700">{l.itemName}</span>
              <input
                dir="ltr" type="number" step="0.01" min={0.01}
                className="field col-span-3 tabular-nums" value={l.quantity || ""}
                aria-label={`كمية ${l.itemName}`}
                onChange={(e) => {
                  const v = Math.max(0, Number(e.target.value) || 0);
                  setLines((s) => s.map((x, j) => (j === i ? { ...x, quantity: v } : x)));
                }}
              />
              <span className="col-span-2 text-xs tabular-nums text-slate-500">{fmt(l.unitCost)} / {l.unit}</span>
              <button
                type="button" aria-label={`إزالة ${l.itemName}`}
                className="col-span-2 text-xs font-bold text-rose-600 hover:underline"
                onClick={() => setLines((s) => s.filter((_, j) => j !== i))}
              >إزالة</button>
            </div>
          ))}
          <input
            className="field w-full" placeholder="ابحث عن صنف لإضافته…"
            value={search} onChange={(e) => setSearch(e.target.value)}
            aria-label="بحث الأصناف"
          />
          {search && (
            <ul className="mt-1 max-h-40 overflow-y-auto rounded-xl border border-slate-200">
              {(items.data?.rows ?? [])
                .filter((r) => !lines.some((l) => l.itemId === r.id))
                .map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      className="flex w-full items-center justify-between px-3 py-2 text-right text-sm font-bold text-slate-700 hover:bg-slate-50"
                      onClick={() => {
                        // The item's current cost is a DEFAULT the operator can see,
                        // not silently assume — it prints next to the qty box.
                        setLines((s) => [...s, { itemId: r.id, itemName: r.name, unit: r.unit || "PCS", quantity: 1, unitCost: r.cost }]);
                        setSearch("");
                      }}
                    >
                      <span className="truncate">{r.name}</span>
                      <span className="text-xs tabular-nums text-slate-400">{fmt(r.cost)} / {r.unit || "PCS"}</span>
                    </button>
                  </li>
                ))}
              {!items.isLoading && (items.data?.rows ?? []).length === 0 && (
                <li className="px-3 py-2 text-xs font-semibold text-slate-400">لا نتائج.</li>
              )}
            </ul>
          )}
        </div>

        <label className="flex flex-col gap-1 text-xs font-bold text-slate-600">
          ملاحظات
          <input className="field" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
      </div>
    </Dialog>
  );
}
