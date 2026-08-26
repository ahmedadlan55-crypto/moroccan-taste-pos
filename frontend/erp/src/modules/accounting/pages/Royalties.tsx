import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Calculator, CheckCircle2, Crown, Trash2, Wallet } from "lucide-react";
import { apiClient } from "@/shared/api";
import {
  Button, ConfirmDialog, DatePicker, Dialog, EmptyState, ErrorState, LoadingState, PageHeader, PanelTitle,
  StatusBadge, useToast,
} from "@/shared/ui";
import { usePermissions } from "@/app/providers";
import { useT, type TFunction } from "@/i18n";

// /accounting/royalties — franchise royalty accrual on the REPAIRED backend
// (3fa7e0f). The legacy screen never worked: compute selected columns the sales
// table does not have, so royalty_runs stayed empty since the feature shipped.
//
// The flow the backend enforces, mirrored here rather than papered over:
//   preview (writes nothing) → create draft → approve (accrues Dr 6100/Cr 2310
//   atomically — a closed period rolls the WHOLE approval back) → mark paid.
//   Drafts delete; approved runs do not.

interface RoyaltyRun {
  id: string; brandId: string; brandName: string;
  runDate: string; periodStart: string; periodEnd: string;
  grossSales: number; netSales: number;
  royaltyType: string; royaltyValue: number; fixedComponent: number; royaltyAmount: number;
  status: string; approvedBy: string; approvedAt: string | null; paidAt: string | null;
}
interface Brand { id: string; name: string; royalty_type?: string | null }
interface ComputeResponse {
  success: boolean; error?: string; id?: string; preview?: boolean;
  grossSales?: number; netSales?: number; saleCount?: number;
  creditNotes?: { count: number; gross: number; net: number };
  netUnknownCount?: number; royaltyType?: string; royaltyValue?: number;
  royaltyBase?: string; royaltyAmount?: number;
}

const STATUS_TONE: Record<string, "neutral" | "success" | "info"> = { draft: "neutral", approved: "success", invoiced: "info", paid: "success" };
const ROY_STATUSES = ["draft", "approved", "invoiced", "paid"];
const ROY_TYPES = ["none", "percentage", "fixed", "mixed"];
function royStatusLabel(t: TFunction, s: string): string {
  return ROY_STATUSES.includes(s) ? t(`accounting.royalties.status.${s}`) : s;
}
function royTypeLabel(t: TFunction, s: string): string {
  return ROY_TYPES.includes(s) ? t(`accounting.royalties.type.${s}`) : s;
}
const fmt = (n: number) => new Intl.NumberFormat("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
const ymd = (v: string | null | undefined) => (v ? String(v).slice(0, 10) : "—");

export function RoyaltiesPage() {
  const t = useT();
  const { can } = usePermissions();
  const canManage = can("royalty.manage");
  const { toast } = useToast();
  const qc = useQueryClient();
  const [computeOpen, setComputeOpen] = useState(false);
  const [toDelete, setToDelete] = useState<RoyaltyRun | null>(null);
  const [toApprove, setToApprove] = useState<RoyaltyRun | null>(null);

  const runs = useQuery({
    queryKey: ["acc", "royalty-runs"],
    queryFn: ({ signal }) => apiClient.get<RoyaltyRun[]>("/erp/royalty-runs", { signal }),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["acc", "royalty-runs"] });

  const approve = useMutation({
    mutationFn: (id: string) => apiClient.post<{ success: boolean; error?: string; journalNumber?: string | null }>(`/erp/royalty-runs/${id}/approve`, {}),
    onSuccess: (r) => {
      if (!r.success) { toast({ tone: "error", title: r.error || t("accounting.royalties.toast.approveError") }); return; }
      toast({ tone: "success", title: r.journalNumber ? t("accounting.royalties.toast.approvedPosted", { number: r.journalNumber }) : t("accounting.royalties.toast.approvedNoJournal") });
      invalidate(); setToApprove(null);
    },
    onError: (e) => { toast({ tone: "error", title: e instanceof Error ? e.message : t("accounting.royalties.toast.approveError") }); setToApprove(null); },
  });
  const markPaid = useMutation({
    mutationFn: (id: string) => apiClient.post<{ success: boolean; error?: string }>(`/erp/royalty-runs/${id}/mark-paid`, {}),
    onSuccess: (r) => { if (!r.success) toast({ tone: "error", title: r.error || t("accounting.royalties.toast.markPaidError") }); else { toast({ tone: "success", title: t("accounting.royalties.toast.markedPaid") }); invalidate(); } },
    onError: (e) => toast({ tone: "error", title: e instanceof Error ? e.message : t("accounting.royalties.toast.markPaidError") }),
  });
  const del = useMutation({
    mutationFn: (id: string) => apiClient.delete<{ success: boolean; error?: string }>(`/erp/royalty-runs/${id}`),
    onSuccess: (r) => { if (!r.success) toast({ tone: "error", title: r.error || t("accounting.royalties.toast.deleteError") }); else { toast({ tone: "success", title: t("accounting.royalties.toast.deleted") }); invalidate(); } setToDelete(null); },
    onError: (e) => { toast({ tone: "error", title: e instanceof Error ? e.message : t("accounting.royalties.toast.deleteError") }); setToDelete(null); },
  });

  const rows = runs.data ?? [];

  return (
    <div>
      <PageHeader
        eyebrow={t("accounting.eyebrow")}
        title={t("accounting.royalties.title")}
        subtitle={t("accounting.royalties.subtitle")}
        action={canManage ? <Button onClick={() => setComputeOpen(true)}><Calculator className="h-4 w-4" /> {t("accounting.royalties.computeButton")}</Button> : undefined}
      />

      <section className="section surface">
        <PanelTitle icon={Crown} title={t("accounting.royalties.panelTitle")} subtitle={t("accounting.royalties.panelSub")} />
        {runs.isLoading ? (
          <LoadingState rows={5} />
        ) : runs.isError ? (
          <ErrorState error={runs.error} onRetry={() => runs.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState title={t("accounting.royalties.empty.title")} body={t("accounting.royalties.empty.body")} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-start text-xs font-extrabold text-slate-500">
                  <th className="py-2">{t("accounting.royalties.col.brand")}</th>
                  <th className="py-2">{t("accounting.royalties.col.period")}</th>
                  <th className="py-2">{t("accounting.royalties.col.gross")}</th>
                  <th className="py-2">{t("accounting.royalties.col.net")}</th>
                  <th className="py-2">{t("accounting.royalties.col.type")}</th>
                  <th className="py-2">{t("accounting.royalties.col.amount")}</th>
                  <th className="py-2">{t("accounting.royalties.col.status")}</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-slate-100">
                    <td className="py-2 font-bold text-slate-700">{r.brandName || r.brandId}</td>
                    <td className="py-2 tabular-nums text-slate-600" dir="ltr">{ymd(r.periodStart)} → {ymd(r.periodEnd)}</td>
                    <td className="py-2 tabular-nums text-slate-600">{fmt(r.grossSales)}</td>
                    <td className="py-2 tabular-nums text-slate-600">{fmt(r.netSales)}</td>
                    <td className="py-2 text-slate-600">{royTypeLabel(t, r.royaltyType)}{r.royaltyType === "percentage" || r.royaltyType === "mixed" ? ` ${r.royaltyValue}%` : ""}</td>
                    <td className="py-2 tabular-nums font-extrabold text-slate-800">{fmt(r.royaltyAmount)}</td>
                    <td className="py-2"><StatusBadge dot tone={STATUS_TONE[r.status]}>{royStatusLabel(t, r.status)}</StatusBadge></td>
                    <td className="py-2 text-end">
                      {canManage && (
                        <span className="inline-flex items-center gap-1">
                          {r.status === "draft" && (
                            <>
                              <Button size="sm" onClick={() => setToApprove(r)} aria-label={t("accounting.royalties.approveAria", { id: r.id })}><CheckCircle2 className="h-4 w-4" /> {t("accounting.royalties.approve")}</Button>
                              <Button size="sm" variant="ghost" onClick={() => setToDelete(r)} aria-label={t("accounting.royalties.deleteAria", { id: r.id })}><Trash2 className="h-4 w-4" /></Button>
                            </>
                          )}
                          {(r.status === "approved" || r.status === "invoiced") && (
                            <Button size="sm" variant="ghost" onClick={() => markPaid.mutate(r.id)} disabled={markPaid.isPending}><Wallet className="h-4 w-4" /> {t("accounting.royalties.markPaid")}</Button>
                          )}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {computeOpen && (
        <ComputeDialog
          onClose={() => setComputeOpen(false)}
          onCreated={() => { invalidate(); setComputeOpen(false); toast({ tone: "success", title: t("accounting.royalties.toast.draftCreated") }); }}
        />
      )}

      <ConfirmDialog
        open={!!toApprove}
        onClose={() => setToApprove(null)}
        title={t("accounting.royalties.approveTitle", { brand: toApprove?.brandName || "" })}
        description={t("accounting.royalties.approveDesc", { amount: fmt(toApprove?.royaltyAmount ?? 0) })}
        confirmLabel={t("accounting.royalties.approveConfirm")}
        processing={approve.isPending}
        onConfirm={() => toApprove && approve.mutate(toApprove.id)}
      />
      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        title={t("accounting.royalties.deleteTitle")}
        description={t("accounting.royalties.deleteDesc")}
        tone="danger"
        confirmLabel={t("common.delete")}
        processing={del.isPending}
        onConfirm={() => toDelete && del.mutate(toDelete.id)}
      />
    </div>
  );
}

const monthStart = () => new Date().toISOString().slice(0, 8) + "01";
const todayYmd = () => new Date().toISOString().slice(0, 10);

function ComputeDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const t = useT();
  const { toast } = useToast();
  const [brandId, setBrandId] = useState("");
  const [periodStart, setPeriodStart] = useState(monthStart());
  const [periodEnd, setPeriodEnd] = useState(todayYmd());
  const [preview, setPreview] = useState<ComputeResponse | null>(null);

  const brands = useQuery({
    queryKey: ["acc", "brands"],
    queryFn: ({ signal }) => apiClient.get<Brand[]>("/erp/brands", { signal }),
  });

  // Two explicit steps, matching the backend: preview computes and writes
  // NOTHING; create writes the draft. The numbers the operator approves are the
  // numbers they previewed.
  const run = useMutation({
    mutationFn: (p: boolean) =>
      apiClient.post<ComputeResponse>("/erp/royalty-runs/compute", { brandId, periodStart, periodEnd, preview: p }),
    onSuccess: (r, wasPreview) => {
      if (!r.success) { toast({ tone: "error", title: r.error || t("accounting.royalties.toast.computeRejected") }); setPreview(null); return; }
      if (wasPreview) setPreview(r);
      else onCreated();
    },
    onError: (e) => toast({ tone: "error", title: e instanceof Error ? e.message : t("accounting.royalties.toast.computeError") }),
  });

  const ready = !!brandId && !!periodStart && !!periodEnd;

  return (
    <Dialog open onClose={onClose} title={t("accounting.royalties.compute.title")} size="lg"
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>{t("common.close")}</Button>
          <Button variant="secondary" disabled={!ready || run.isPending} loading={run.isPending && !preview} onClick={() => run.mutate(true)}>{t("accounting.royalties.compute.preview")}</Button>
          <Button disabled={!ready || !preview || run.isPending} loading={run.isPending && !!preview} onClick={() => run.mutate(false)}>{t("accounting.royalties.compute.createDraft")}</Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <label className="flex flex-col gap-1 text-xs font-bold text-slate-600">
            {t("accounting.royalties.compute.brand")}
            <select className="field" value={brandId} onChange={(e) => { setBrandId(e.target.value); setPreview(null); }}>
              <option value="">{t("accounting.royalties.compute.selectBrand")}</option>
              {(brands.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-bold text-slate-600">
            {t("accounting.royalties.compute.from")}
            <DatePicker value={periodStart} onChange={(v) => { setPeriodStart(v); setPreview(null); }} />
          </label>
          <label className="flex flex-col gap-1 text-xs font-bold text-slate-600">
            {t("accounting.royalties.compute.to")}
            <DatePicker value={periodEnd} onChange={(v) => { setPeriodEnd(v); setPreview(null); }} />
          </label>
        </div>

        {preview ? (
          <div className="rounded-2xl border border-teal-200 bg-teal-50/50 p-3">
            <p className="mb-2 text-xs font-extrabold text-teal-800">{t("accounting.royalties.compute.previewTitle")}</p>
            <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
              <div><dt className="text-xs font-bold text-slate-500">{t("accounting.royalties.compute.invoices")}</dt><dd className="tabular-nums font-bold">{preview.saleCount}</dd></div>
              <div><dt className="text-xs font-bold text-slate-500">{t("accounting.royalties.compute.grossAfter")}</dt><dd className="tabular-nums font-bold">{fmt(preview.grossSales ?? 0)}</dd></div>
              <div><dt className="text-xs font-bold text-slate-500">{t("accounting.royalties.compute.netNoVat")}</dt><dd className="tabular-nums font-bold">{fmt(preview.netSales ?? 0)}</dd></div>
              <div><dt className="text-xs font-bold text-slate-500">{t("accounting.royalties.compute.creditNotes")}</dt><dd className="tabular-nums font-bold">{preview.creditNotes?.count ?? 0} ({fmt(preview.creditNotes?.gross ?? 0)})</dd></div>
              <div><dt className="text-xs font-bold text-slate-500">{t("accounting.royalties.compute.basis")}</dt><dd className="font-bold">{preview.royaltyBase === "net_sales" ? t("accounting.royalties.compute.basisNet") : t("accounting.royalties.compute.basisGross")}</dd></div>
              <div><dt className="text-xs font-bold text-slate-500">{t("accounting.royalties.compute.amount")}</dt><dd className="tabular-nums font-extrabold text-teal-800">{fmt(preview.royaltyAmount ?? 0)}</dd></div>
            </dl>
            {Number(preview.netUnknownCount) > 0 && (
              <p className="mt-2 text-xs font-bold text-amber-700">
                {t("accounting.royalties.compute.netUnknownWarn", { count: preview.netUnknownCount ?? 0 })}
              </p>
            )}
            {preview.royaltyType === "none" && (
              <p className="mt-2 text-xs font-bold text-amber-700">{t("accounting.royalties.compute.noTypeWarn")}</p>
            )}
          </div>
        ) : (
          <p className="text-xs font-semibold text-slate-400">{t("accounting.royalties.compute.previewFirst")}</p>
        )}
      </div>
    </Dialog>
  );
}
