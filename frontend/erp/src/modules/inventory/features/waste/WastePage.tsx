import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PackageMinus, Plus, Trash2 } from "lucide-react";
import { apiClient } from "@/shared/api";
import {
  Button, ConfirmDialog, DatePicker, Dialog, EmptyState, ErrorState, LoadingState, PageHeader,
  PanelTitle, StatusBadge, useToast,
} from "@/shared/ui";
import { useT, translateApiError } from "@/i18n";
import type { TFunction } from "@/i18n";
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

const REASONS = ["expired", "damaged", "spill", "prep_loss", "customer_return", "other"] as const;
type Reason = (typeof REASONS)[number];
const reasonLabel = (t: TFunction, value: string) => t(`inventoryRest.waste.reason.${value}`);

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
  const t = useT();
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
      if (!r.success) { toast({ tone: "error", title: r.error || t("inventoryRest.waste.deleteFailed") }); return; }
      toast({ tone: "success", title: t("inventoryRest.waste.reversed") });
      qc.invalidateQueries({ queryKey: ["inv", "waste"] });
      setToDelete(null);
    },
    onError: (e) => toast({ tone: "error", title: translateApiError(e, t) }),
  });

  const rows = list.data?.items ?? [];
  const summary = list.data?.summary;

  return (
    <div>
      <PageHeader
        eyebrow={t("inventoryRest.waste.eyebrow")}
        title={t("inventoryRest.waste.title")}
        subtitle={t("inventoryRest.waste.subtitle")}
        action={canCreate ? (
          <Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" /> {t("inventoryRest.waste.newEntry")}</Button>
        ) : undefined}
      />

      {/* No approval workflow exists for waste — the entry posts on create. Said
          here so nobody hunts for a nonexistent "اعتماد" button. */}
      <p className="mb-4 text-xs font-semibold text-slate-400">
        {t("inventoryRest.waste.disclaimer")}
      </p>

      {summary && (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="section surface p-3">
            <p className="text-xs font-bold text-slate-500">{t("inventoryRest.waste.totalEntries")}</p>
            <p className="text-lg font-extrabold tabular-nums text-slate-800">{summary.total}</p>
          </div>
          <div className="section surface p-3">
            <p className="text-xs font-bold text-slate-500">{t("inventoryRest.waste.totalCost")}</p>
            <p className="text-lg font-extrabold tabular-nums text-slate-800">{fmt(summary.totalCost)}</p>
          </div>
          {(["expired", "damaged"] as const).map((k) => (
            <div key={k} className="section surface p-3">
              <p className="text-xs font-bold text-slate-500">{reasonLabel(t, k)}</p>
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
          title={t("inventoryRest.waste.logTitle")}
          action={
            <select className="field" value={reasonFilter} onChange={(e) => setReasonFilter(e.target.value)} aria-label={t("inventoryRest.waste.filterAria")}>
              <option value="">{t("inventoryRest.filter.allReasons")}</option>
              {REASONS.map((r) => <option key={r} value={r}>{reasonLabel(t, r)}</option>)}
            </select>
          }
        />
        {list.isLoading ? (
          <LoadingState rows={5} />
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState title={t("inventoryRest.waste.emptyTitle")} body={reasonFilter ? t("inventoryRest.waste.emptyBodyFiltered") : t("inventoryRest.waste.emptyBody")} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-start text-xs font-extrabold text-slate-500">
                  <th className="py-2">{t("inventoryRest.waste.col.number")}</th>
                  <th className="py-2">{t("inventoryRest.waste.col.date")}</th>
                  <th className="py-2">{t("inventoryRest.waste.col.warehouse")}</th>
                  <th className="py-2">{t("inventoryRest.waste.col.reason")}</th>
                  <th className="py-2">{t("inventoryRest.waste.col.cost")}</th>
                  <th className="py-2">{t("inventoryRest.waste.col.by")}</th>
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
            toast({ tone: "success", title: n ? t("inventoryRest.waste.createdWithNumber", { number: n }) : t("inventoryRest.waste.created") });
            qc.invalidateQueries({ queryKey: ["inv", "waste"] });
            setCreateOpen(false);
          }}
        />
      )}

      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        title={t("inventoryRest.waste.confirmCancelTitle", { number: toDelete?.wasteNumber || "" })}
        description={t("inventoryRest.waste.confirmCancelBody")}
        tone="danger"
        confirmLabel={t("inventoryRest.waste.confirmCancelLabel")}
        processing={del.isPending}
        onConfirm={() => toDelete && del.mutate(toDelete.id)}
      />
    </div>
  );
}

function WasteRowView({ row, expanded, onToggle, onDelete }: { row: WasteRow; expanded: boolean; onToggle: () => void; onDelete?: () => void }) {
  const t = useT();
  const items = useQuery({
    enabled: expanded,
    queryKey: ["inv", "waste", row.id, "items"],
    queryFn: ({ signal }) => apiClient.get<WasteItemLine[]>(`/erp/waste-entries/${row.id}/items`, { signal }),
  });
  return (
    <>
      <tr className="border-b border-slate-100">
        <td className="py-2">
          <button type="button" onClick={onToggle} className="inline-flex min-h-11 items-center rounded-xl px-2 font-bold tabular-nums text-teal-700 hover:bg-teal-50 hover:underline focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100" dir="ltr">
            {row.wasteNumber || row.id}
          </button>
        </td>
        <td className="py-2 tabular-nums text-slate-600" dir="ltr">{String(row.wasteDate).slice(0, 10)}</td>
        <td className="py-2 text-slate-600">{row.warehouseName || row.warehouseId}</td>
        <td className="py-2"><StatusBadge dot>{reasonLabel(t, row.reason)}</StatusBadge></td>
        <td className="py-2 tabular-nums font-bold text-slate-700">{fmt(row.totalCost)}</td>
        <td className="py-2 text-slate-500">{row.createdBy}</td>
        <td className="py-2 text-end">
          {onDelete && (
            <Button size="sm" variant="ghost" onClick={onDelete} aria-label={t("inventoryRest.waste.cancelAria", { number: row.wasteNumber || row.id })}>
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
                {row.notes ? <li className="pt-1 text-xs text-slate-400">{t("inventoryRest.waste.notesLabel", { notes: row.notes })}</li> : null}
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
  const t = useT();
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
      if (!r.success) { toast({ tone: "error", title: r.error || t("inventoryRest.waste.dialog.rejected") }); return; }
      onCreated(r.wasteNumber ?? null);
    },
    onError: (e) => toast({ tone: "error", title: translateApiError(e, t) }),
  });

  const canSubmit = !!warehouseId && lines.length > 0 && lines.every((l) => l.quantity > 0) && !save.isPending;

  return (
    <Dialog open onClose={onClose} title={t("inventoryRest.waste.dialog.title")} size="lg"
      footer={
        <div className="flex w-full items-center justify-between">
          <span className="text-sm font-extrabold tabular-nums text-slate-700">{t("inventoryRest.waste.dialog.total", { value: fmt(total) })}</span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onClose}>{t("common.close")}</Button>
            <Button loading={save.isPending} disabled={!canSubmit} onClick={() => save.mutate()}>{t("inventoryRest.waste.dialog.submit")}</Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <label className="flex flex-col gap-1 text-xs font-bold text-slate-600">
            {t("inventoryRest.waste.dialog.warehouse")}
            <select className="field" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              <option value="">{t("inventoryRest.waste.dialog.pickWarehouse")}</option>
              {(warehouses.data?.warehouses ?? []).map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-bold text-slate-600">
            {t("inventoryRest.waste.dialog.date")}
            <DatePicker value={wasteDate} onChange={setWasteDate} />
          </label>
          <label className="flex flex-col gap-1 text-xs font-bold text-slate-600">
            {t("inventoryRest.waste.dialog.reasonLabel")}
            <select className="field" value={reason} onChange={(e) => setReason(e.target.value as Reason)}>
              {REASONS.map((r) => <option key={r} value={r}>{reasonLabel(t, r)}</option>)}
            </select>
          </label>
        </div>

        <div className="rounded-2xl border border-slate-200 p-3">
          <p className="mb-2 text-xs font-extrabold text-slate-600">{t("inventoryRest.waste.dialog.itemsTitle")}</p>
          {lines.map((l, i) => (
            <div key={l.itemId} className="mb-2 grid grid-cols-1 items-center gap-2 rounded-xl bg-slate-50 px-3 py-2 sm:grid-cols-12">
              <span className="min-w-0 break-words text-sm font-bold text-slate-700 sm:col-span-5 sm:truncate">{l.itemName}</span>
              <input
                dir="ltr" type="number" step="0.01" min={0.01}
                className="field tabular-nums sm:col-span-3" value={l.quantity || ""}
                aria-label={t("inventoryRest.waste.dialog.qtyAria", { name: l.itemName })}
                onChange={(e) => {
                  const v = Math.max(0, Number(e.target.value) || 0);
                  setLines((s) => s.map((x, j) => (j === i ? { ...x, quantity: v } : x)));
                }}
              />
              <span className="text-xs tabular-nums text-slate-500 sm:col-span-2">{fmt(l.unitCost)} / {l.unit}</span>
              <button
                type="button" aria-label={t("inventoryRest.waste.dialog.removeAria", { name: l.itemName })}
                className="inline-flex min-h-11 items-center justify-center rounded-xl px-3 text-xs font-bold text-rose-600 hover:bg-rose-50 hover:underline focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100 sm:col-span-2"
                onClick={() => setLines((s) => s.filter((_, j) => j !== i))}
              >{t("inventoryRest.waste.dialog.remove")}</button>
            </div>
          ))}
          <input
            className="field w-full" placeholder={t("inventoryRest.waste.dialog.itemSearch")}
            value={search} onChange={(e) => setSearch(e.target.value)}
            aria-label={t("inventoryRest.waste.dialog.searchAria")}
          />
          {search && (
            <ul className="mt-1 max-h-40 overflow-y-auto rounded-xl border border-slate-200">
              {(items.data?.rows ?? [])
                .filter((r) => !lines.some((l) => l.itemId === r.id))
                .map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      className="flex min-h-11 w-full items-center justify-between px-3 py-2 text-start text-sm font-bold text-slate-700 hover:bg-slate-50"
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
                <li className="px-3 py-2 text-xs font-semibold text-slate-400">{t("inventoryRest.waste.dialog.noResults")}</li>
              )}
            </ul>
          )}
        </div>

        <label className="flex flex-col gap-1 text-xs font-bold text-slate-600">
          {t("inventoryRest.waste.dialog.notes")}
          <input className="field" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
      </div>
    </Dialog>
  );
}
