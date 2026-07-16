import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Calculator, CheckCircle2, Crown, Trash2, Wallet } from "lucide-react";
import { apiClient } from "@/shared/api";
import {
  Button, ConfirmDialog, Dialog, EmptyState, ErrorState, LoadingState, PageHeader, PanelTitle,
  StatusBadge, useToast,
} from "@/shared/ui";
import { usePermissions } from "@/app/providers";

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

const STATUS_LABEL: Record<string, string> = { draft: "مسودة", approved: "معتمد", invoiced: "مفوتر", paid: "مسدَّد" };
const TYPE_LABEL: Record<string, string> = { none: "بدون", percentage: "نسبة", fixed: "مبلغ ثابت", mixed: "مختلط" };
const fmt = (n: number) => new Intl.NumberFormat("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
const ymd = (v: string | null | undefined) => (v ? String(v).slice(0, 10) : "—");

export function RoyaltiesPage() {
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
      if (!r.success) { toast({ tone: "error", title: r.error || "تعذّر الاعتماد" }); return; }
      toast({ tone: "success", title: r.journalNumber ? `اعتُمد ورُحّل القيد ${r.journalNumber}` : "اعتُمد (بلا قيد — المبلغ صفر)" });
      invalidate(); setToApprove(null);
    },
    onError: (e) => { toast({ tone: "error", title: e instanceof Error ? e.message : "تعذّر الاعتماد" }); setToApprove(null); },
  });
  const markPaid = useMutation({
    mutationFn: (id: string) => apiClient.post<{ success: boolean; error?: string }>(`/erp/royalty-runs/${id}/mark-paid`, {}),
    onSuccess: (r) => { if (!r.success) toast({ tone: "error", title: r.error || "تعذّر التأشير" }); else { toast({ tone: "success", title: "أُشّر بالسداد" }); invalidate(); } },
    onError: (e) => toast({ tone: "error", title: e instanceof Error ? e.message : "تعذّر التأشير" }),
  });
  const del = useMutation({
    mutationFn: (id: string) => apiClient.delete<{ success: boolean; error?: string }>(`/erp/royalty-runs/${id}`),
    onSuccess: (r) => { if (!r.success) toast({ tone: "error", title: r.error || "تعذّر الحذف" }); else { toast({ tone: "success", title: "حُذفت المسودة" }); invalidate(); } setToDelete(null); },
    onError: (e) => { toast({ tone: "error", title: e instanceof Error ? e.message : "تعذّر الحذف" }); setToDelete(null); },
  });

  const rows = runs.data ?? [];

  return (
    <div>
      <PageHeader
        eyebrow="المحاسبة"
        title="امتياز العلامات"
        subtitle="احتساب مستحقات الامتياز من المبيعات المسجّلة — معاينة، ثم مسودة، ثم اعتماد يُرحّل الاستحقاق"
        action={canManage ? <Button onClick={() => setComputeOpen(true)}><Calculator className="h-4 w-4" /> احتساب فترة</Button> : undefined}
      />

      <section className="section surface">
        <PanelTitle icon={Crown} title="الاحتسابات" subtitle="المرتجعات تُخصم في شهر إصدار الإشعار الدائن — الفترة المعتمدة لا يُعاد احتسابها" />
        {runs.isLoading ? (
          <LoadingState rows={5} />
        ) : runs.isError ? (
          <ErrorState error={runs.error} onRetry={() => runs.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState title="لا احتسابات بعد" body="ابدأ بمعاينة فترة من الزر أعلاه. البراند الذي لم يُضبط له نوع امتياز يُحتسب بصفر — اضبطه من شاشة العلامات." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-right text-xs font-extrabold text-slate-500">
                  <th className="py-2">البراند</th>
                  <th className="py-2">الفترة</th>
                  <th className="py-2">إجمالي المبيعات</th>
                  <th className="py-2">الصافي</th>
                  <th className="py-2">النوع</th>
                  <th className="py-2">المستحق</th>
                  <th className="py-2">الحالة</th>
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
                    <td className="py-2 text-slate-600">{TYPE_LABEL[r.royaltyType] || r.royaltyType}{r.royaltyType === "percentage" || r.royaltyType === "mixed" ? ` ${r.royaltyValue}%` : ""}</td>
                    <td className="py-2 tabular-nums font-extrabold text-slate-800">{fmt(r.royaltyAmount)}</td>
                    <td className="py-2"><StatusBadge dot>{STATUS_LABEL[r.status] || r.status}</StatusBadge></td>
                    <td className="py-2 text-left">
                      {canManage && (
                        <span className="inline-flex items-center gap-1">
                          {r.status === "draft" && (
                            <>
                              <Button size="sm" onClick={() => setToApprove(r)} aria-label={`اعتماد ${r.id}`}><CheckCircle2 className="h-4 w-4" /> اعتماد</Button>
                              <Button size="sm" variant="ghost" onClick={() => setToDelete(r)} aria-label={`حذف ${r.id}`}><Trash2 className="h-4 w-4" /></Button>
                            </>
                          )}
                          {(r.status === "approved" || r.status === "invoiced") && (
                            <Button size="sm" variant="ghost" onClick={() => markPaid.mutate(r.id)} disabled={markPaid.isPending}><Wallet className="h-4 w-4" /> تم السداد</Button>
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
          onCreated={() => { invalidate(); setComputeOpen(false); toast({ tone: "success", title: "أُنشئت مسودة الاحتساب" }); }}
        />
      )}

      <ConfirmDialog
        open={!!toApprove}
        onClose={() => setToApprove(null)}
        title={`اعتماد احتساب ${toApprove?.brandName || ""}؟`}
        description={`سيُرحَّل قيد استحقاق بمبلغ ${fmt(toApprove?.royaltyAmount ?? 0)} (مدين مصروف الامتياز / دائن مستحقات الامتياز). الاعتماد والقيد يتمان معًا أو لا يتمان.`}
        confirmLabel="اعتماد وترحيل"
        processing={approve.isPending}
        onConfirm={() => toApprove && approve.mutate(toApprove.id)}
      />
      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        title="حذف مسودة الاحتساب؟"
        description="تُحذف المسودات فقط — الاحتساب المعتمد له قيد مُرحَّل ولا يُحذف."
        tone="danger"
        confirmLabel="حذف"
        processing={del.isPending}
        onConfirm={() => toDelete && del.mutate(toDelete.id)}
      />
    </div>
  );
}

const monthStart = () => new Date().toISOString().slice(0, 8) + "01";
const todayYmd = () => new Date().toISOString().slice(0, 10);

function ComputeDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
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
      if (!r.success) { toast({ tone: "error", title: r.error || "رفض الخادم الاحتساب" }); setPreview(null); return; }
      if (wasPreview) setPreview(r);
      else onCreated();
    },
    onError: (e) => toast({ tone: "error", title: e instanceof Error ? e.message : "تعذّر الاحتساب" }),
  });

  const ready = !!brandId && !!periodStart && !!periodEnd;

  return (
    <Dialog open onClose={onClose} title="احتساب امتياز فترة" size="lg"
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>إغلاق</Button>
          <Button variant="secondary" disabled={!ready || run.isPending} loading={run.isPending && !preview} onClick={() => run.mutate(true)}>معاينة</Button>
          <Button disabled={!ready || !preview || run.isPending} loading={run.isPending && !!preview} onClick={() => run.mutate(false)}>إنشاء مسودة</Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <label className="flex flex-col gap-1 text-xs font-bold text-slate-600">
            البراند
            <select className="field" value={brandId} onChange={(e) => { setBrandId(e.target.value); setPreview(null); }}>
              <option value="">— اختر —</option>
              {(brands.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-bold text-slate-600">
            من
            <input dir="ltr" type="date" className="field tabular-nums" value={periodStart} onChange={(e) => { setPeriodStart(e.target.value); setPreview(null); }} />
          </label>
          <label className="flex flex-col gap-1 text-xs font-bold text-slate-600">
            إلى
            <input dir="ltr" type="date" className="field tabular-nums" value={periodEnd} onChange={(e) => { setPeriodEnd(e.target.value); setPreview(null); }} />
          </label>
        </div>

        {preview ? (
          <div className="rounded-2xl border border-teal-200 bg-teal-50/50 p-3">
            <p className="mb-2 text-xs font-extrabold text-teal-800">معاينة — لم يُكتب شيء بعد</p>
            <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
              <div><dt className="text-xs font-bold text-slate-500">فواتير الفترة</dt><dd className="tabular-nums font-bold">{preview.saleCount}</dd></div>
              <div><dt className="text-xs font-bold text-slate-500">إجمالي (بعد خصم الإشعارات)</dt><dd className="tabular-nums font-bold">{fmt(preview.grossSales ?? 0)}</dd></div>
              <div><dt className="text-xs font-bold text-slate-500">صافي (بلا ضريبة)</dt><dd className="tabular-nums font-bold">{fmt(preview.netSales ?? 0)}</dd></div>
              <div><dt className="text-xs font-bold text-slate-500">إشعارات دائنة مخصومة</dt><dd className="tabular-nums font-bold">{preview.creditNotes?.count ?? 0} ({fmt(preview.creditNotes?.gross ?? 0)})</dd></div>
              <div><dt className="text-xs font-bold text-slate-500">الأساس</dt><dd className="font-bold">{preview.royaltyBase === "net_sales" ? "الصافي" : "الإجمالي"}</dd></div>
              <div><dt className="text-xs font-bold text-slate-500">المستحق</dt><dd className="tabular-nums font-extrabold text-teal-800">{fmt(preview.royaltyAmount ?? 0)}</dd></div>
            </dl>
            {Number(preview.netUnknownCount) > 0 && (
              <p className="mt-2 text-xs font-bold text-amber-700">
                {preview.netUnknownCount} فاتورة بلا تفصيل ضريبي مسجّل — الصافي أعلاه ناقص بها؛ الاحتساب على الصافي سيُرفض.
              </p>
            )}
            {preview.royaltyType === "none" && (
              <p className="mt-2 text-xs font-bold text-amber-700">هذا البراند بلا نوع امتياز مضبوط — المستحق صفر حتى يُضبط من شاشة العلامات.</p>
            )}
          </div>
        ) : (
          <p className="text-xs font-semibold text-slate-400">عايِن الأرقام أولًا — الإنشاء يكتب مسودة بنفس أرقام المعاينة.</p>
        )}
      </div>
    </Dialog>
  );
}
