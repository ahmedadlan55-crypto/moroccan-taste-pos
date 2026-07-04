import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowRight, CheckCircle2, CircleDot, FileText, Layers, ListTree,
  Lock, PackageMinus, PackagePlus, Printer, Trash2, Undo2, XCircle,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { StatusBadge } from "@/components/status-badge/StatusBadge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/Progress";
import { LoadingState, ErrorState } from "@/components/states/States";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ReasonDialog } from "@/features/_shared/ReasonDialog";
import { useCan } from "@/app/permission-provider";
import { useAuth } from "@/app/auth-provider";
import { formatCurrency, formatDate, formatDateTime, formatNumber, formatQty } from "@/lib/formatters";
import { productionStatusToLabel, PRODUCTION_PARTIAL_LABEL } from "@/lib/status-labels";
import { useProductionDetail, useProductionMutations, useVarianceReport } from "@/lib/hooks/useProduction";
import { IssueMaterialsDialog } from "./IssueMaterialsDialog";
import { RecordOutputDialog } from "./RecordOutputDialog";
import { printProduction } from "./printProduction";
import { ApiError } from "@/lib/api-error";

const TABS = [
  { id: "overview", label: "نظرة عامة", icon: CircleDot },
  { id: "materials", label: "المواد", icon: PackageMinus },
  { id: "outputs", label: "المخرجات", icon: PackagePlus },
  { id: "journals", label: "القيود", icon: FileText },
  { id: "trace", label: "تتبع الدفعات", icon: Layers },
  { id: "variance", label: "الفروقات", icon: ListTree },
] as const;
type TabId = (typeof TABS)[number]["id"];

export function ProductionDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { data, isLoading, isError, error, refetch } = useProductionDetail(id);
  const m = useProductionMutations();
  const { user } = useAuth();
  const [tab, setTab] = useState<TabId>("overview");
  const [dialog, setDialog] = useState<null | "issue" | "output" | "approve" | "complete" | "close" | "cancel" | "reverse" | "delete">(null);

  const canApprove = useCan("production.approve");
  const canIssue = useCan("production.issue");
  const canOutput = useCan("production.output");
  const canComplete = useCan("production.complete");
  const canClose = useCan("production.close");
  const canCancel = useCan("production.cancel");
  const canReverse = useCan("production.reverse");
  const canDelete = useCan("production.delete");

  const variance = useVarianceReport(id, tab === "variance");

  const active = useMemo(() => {
    if (!data) return null;
    const s = data.order.status;
    const isV2 = data.order.source === "v2";
    const hasIssues = data.issueEvents.length > 0;
    const isCreator = !!user && user.username === data.order.createdBy;
    return {
      edit: isV2 && s === "draft",
      approve: isV2 && s === "draft" && canApprove && !isCreator,
      approveBlockedSelf: isV2 && s === "draft" && canApprove && isCreator,
      issue: isV2 && (s === "approved" || s === "in_progress") && canIssue,
      output: isV2 && s === "in_progress" && canOutput,
      complete: isV2 && s === "in_progress" && canComplete && data.outputs.length > 0,
      close: isV2 && s === "completed" && canClose,
      cancel: isV2 && (s === "draft" || s === "approved") && !hasIssues && canCancel,
      reverse: isV2 && ["in_progress", "completed", "closed"].includes(s) && canReverse,
      delete: isV2 && s === "draft" && canDelete,
    };
  }, [data, user, canApprove, canIssue, canOutput, canComplete, canClose, canCancel, canReverse, canDelete]);

  if (isLoading) return <LoadingState />;
  if (isError || !data) return <ErrorState error={error} onRetry={() => refetch()} />;

  const o = data.order;
  const producedPct = o.qtyPlanned > 0 ? ((o.qtyProduced + o.qtyWaste) / o.qtyPlanned) * 100 : 0;
  const mutErr = (mu: { error: Error | null }) => (mu.error instanceof ApiError ? mu.error.message : mu.error?.message ?? null);

  return (
    <div>
      <PageHeader
        eyebrow="العمليات · أوامر الإنتاج"
        title={o.number}
        subtitle={`${o.productName} — ${formatQty(o.qtyPlanned, o.productUnit)} مخطط · ${o.warehouseName}${o.outputWarehouseId !== o.warehouseId ? ` ← ${o.outputWarehouseName}` : ""}`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge>{productionStatusToLabel(o.status)}</StatusBadge>
            {o.partiallyCompleted && <StatusBadge>{PRODUCTION_PARTIAL_LABEL}</StatusBadge>}
            {o.source === "legacy" && <StatusBadge>مستند قديم — للعرض فقط</StatusBadge>}
            <Button variant="ghost" onClick={() => navigate("/production")}><ArrowRight className="h-4 w-4" /> القائمة</Button>
          </div>
        }
      />

      {/* Action toolbar — every button maps 1:1 to a legal transition for this status+role. */}
      {active && o.source === "v2" && (
        <div className="surface mb-4 flex flex-wrap items-center gap-2 p-3">
          {active.issue && <Button variant="primary" onClick={() => setDialog("issue")}><PackageMinus className="h-4 w-4" /> إصدار مواد</Button>}
          {active.output && <Button variant="primary" onClick={() => setDialog("output")}><PackagePlus className="h-4 w-4" /> تسجيل إنتاج</Button>}
          {active.approve && <Button variant="secondary" onClick={() => setDialog("approve")}><CheckCircle2 className="h-4 w-4" /> اعتماد</Button>}
          {active.approveBlockedSelf && <span className="rounded-lg bg-amber-50 px-3 py-2 text-xs font-bold text-amber-700">أنشأت هذا الأمر — الاعتماد يتطلب مديرًا آخر (Maker–Checker)</span>}
          {active.complete && <Button variant="secondary" onClick={() => setDialog("complete")}><CheckCircle2 className="h-4 w-4" /> إكمال</Button>}
          {active.close && <Button variant="secondary" onClick={() => setDialog("close")}><Lock className="h-4 w-4" /> إغلاق</Button>}
          {active.edit && <Button variant="secondary" onClick={() => navigate(`/production/${o.id}/edit`)}>تعديل المسودة</Button>}
          <span className="flex-1" />
          <Button variant="ghost" onClick={() => printProduction(data)}><Printer className="h-4 w-4" /> طباعة</Button>
          {active.cancel && <Button variant="ghost" onClick={() => setDialog("cancel")}><XCircle className="h-4 w-4" /> إلغاء</Button>}
          {active.reverse && <Button variant="ghost" className="text-rose-600 hover:bg-rose-50" onClick={() => setDialog("reverse")}><Undo2 className="h-4 w-4" /> عكس</Button>}
          {active.delete && <Button variant="ghost" className="text-rose-600 hover:bg-rose-50" onClick={() => setDialog("delete")}><Trash2 className="h-4 w-4" /> حذف</Button>}
        </div>
      )}

      {/* KPI strip */}
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Kpi label="المنجز الجيد" value={formatQty(o.qtyProduced, o.productUnit)} />
        <Kpi label="الهدر" value={formatQty(o.qtyWaste)} tone={o.qtyWaste > 0 ? "rose" : undefined} />
        <Kpi label="رصيد WIP" value={formatCurrency(o.wipBalance)} />
        <Kpi label="تكلفة الوحدة التراكمية" value={o.unitCost > 0 ? formatCurrency(o.unitCost) : "—"} />
        <Kpi label="نسبة الإنجاز" value={`${formatNumber(Math.min(producedPct, 100))}%`}>
          <Progress value={producedPct} tone={producedPct >= 100 ? "teal" : "amber"} />
        </Kpi>
      </section>

      {/* Tabs */}
      <div className="mt-5 flex flex-wrap gap-1 border-b border-slate-200" role="tablist" aria-label="أقسام أمر الإنتاج">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
            className={`inline-flex min-h-11 items-center gap-1.5 rounded-t-xl px-4 text-sm font-extrabold transition ${tab === t.id ? "border-b-2 border-teal-600 bg-teal-50/60 text-teal-800" : "text-slate-500 hover:bg-slate-50 hover:text-slate-800"}`}>
            <t.icon className="h-4 w-4" /> {t.label}
          </button>
        ))}
      </div>

      <section className="surface mt-4 p-5">
        {tab === "overview" && (
          <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
            <div>
              <h3 className="mb-3 text-sm font-extrabold text-slate-800">الجدول الزمني</h3>
              {data.timeline.length === 0 ? <p className="text-sm text-slate-400">لا أحداث بعد.</p> : (
                <ol className="space-y-3">
                  {data.timeline.map((t) => (
                    <li key={t.id} className="flex gap-3">
                      <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-teal-500" aria-hidden="true" />
                      <div>
                        <div className="text-sm font-bold text-slate-800">
                          {ACTION_LABEL[t.action] ?? t.action}
                          {t.toStatus && <span className="mr-2 text-xs font-medium text-slate-400">← {productionStatusToLabel(t.toStatus)}</span>}
                        </div>
                        <div className="text-xs text-slate-500">{t.actor || "—"} · {formatDateTime(t.at)}{t.note ? ` · ${t.note}` : ""}</div>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </div>
            <div className="space-y-2 text-sm">
              <InfoRow label="أنشأه" value={o.createdBy || "—"} />
              <InfoRow label="اعتمده" value={o.approvedBy ?? "—"} />
              <InfoRow label="تاريخ الإنتاج المخطط" value={formatDate(o.plannedDate)} />
              <InfoRow label="مواد" value={formatCurrency(o.materialsCost)} />
              <InfoRow label="عمالة" value={formatCurrency(o.laborCost)} />
              <InfoRow label="غير مباشرة" value={formatCurrency(o.overheadCost)} />
              <InfoRow label="إجمالي التكلفة" value={formatCurrency(o.totalCost)} strong />
              {o.yieldPct != null && <InfoRow label="نسبة العائد" value={`${formatNumber(o.yieldPct)}%`} />}
              {o.closeVariance > 0 && <InfoRow label="فروقات الإغلاق (5420)" value={formatCurrency(o.closeVariance)} />}
              {o.cancelReason && <InfoRow label="سبب الإلغاء" value={o.cancelReason} />}
              {o.reverseReason && <InfoRow label="سبب العكس" value={o.reverseReason} />}
              {o.notes && <InfoRow label="ملاحظات" value={o.notes} />}
            </div>
          </div>
        )}

        {tab === "materials" && (
          <div className="space-y-6">
            <div>
              <h3 className="mb-2 text-sm font-extrabold text-slate-800">خطة المواد (مخطط / صُرف / متبقٍ)</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-xs font-bold text-slate-500">
                    <tr>
                      <th className="px-3 py-2 text-right">المادة</th>
                      <th className="px-3 py-2 text-right">المخطط</th>
                      <th className="px-3 py-2 text-right">صُرف</th>
                      <th className="px-3 py-2 text-right">المتبقي</th>
                      <th className="px-3 py-2 text-right">المتاح الآن</th>
                      <th className="px-3 py-2 text-left">قيمة المصروف</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.plan.map((p) => (
                      <tr key={p.itemId}>
                        <td className="px-3 py-2 font-bold text-slate-800">{p.itemName}{p.trackingMode !== "none" && <span className="mr-2 rounded-md bg-sky-50 px-1.5 py-0.5 text-[10px] font-bold text-sky-700">متتبع</span>}</td>
                        <td className="px-3 py-2 tabular-nums">{formatQty(p.qtyPlanned, p.itemUnit)}</td>
                        <td className="px-3 py-2 tabular-nums">{formatQty(p.qtyIssued)}</td>
                        <td className={`px-3 py-2 font-bold tabular-nums ${p.remaining > 0 ? "text-amber-600" : "text-emerald-600"}`}>{formatQty(Math.max(p.remaining, 0))}</td>
                        <td className="px-3 py-2 tabular-nums text-slate-500">{formatQty(p.available)}</td>
                        <td className="px-3 py-2 text-left tabular-nums">{formatCurrency(p.totalCost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div>
              <h3 className="mb-2 text-sm font-extrabold text-slate-800">أحداث الإصدار ({formatNumber(data.issueEvents.length)})</h3>
              {data.issueEvents.length === 0 ? <p className="text-sm text-slate-400">لم تُصدر مواد بعد.</p> : data.issueEvents.map((ev) => (
                <div key={ev.id} className="mb-3 rounded-xl border border-slate-200">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50/60 px-4 py-2 text-xs font-bold text-slate-600">
                    <span>حدث {formatNumber(ev.eventNo)} · {ev.issuedBy} · {formatDateTime(ev.issuedAt)}</span>
                    <span className="tabular-nums">
                      مواد {formatCurrency(ev.materialsCost)}
                      {ev.laborCost > 0 && <> · عمالة {formatCurrency(ev.laborCost)}</>}
                      {ev.overheadCost > 0 && <> · غ.مباشرة {formatCurrency(ev.overheadCost)}</>}
                    </span>
                  </div>
                  <table className="w-full text-xs">
                    <tbody className="divide-y divide-slate-50">
                      {ev.lines.map((l) => (
                        <tr key={l.id}>
                          <td className="px-4 py-1.5 font-bold text-slate-700">{l.itemName}</td>
                          <td className="px-4 py-1.5 tabular-nums">{formatQty(l.qty, l.itemUnit)}</td>
                          <td className="px-4 py-1.5 tabular-nums text-slate-500">@ {formatCurrency(l.unitCost)}</td>
                          <td className="px-4 py-1.5 text-left tabular-nums font-bold">{formatCurrency(l.lineTotal)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === "outputs" && (
          data.outputs.length === 0 ? <p className="text-sm text-slate-400">لا مخرجات مسجلة بعد.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs font-bold text-slate-500">
                  <tr>
                    <th className="px-3 py-2 text-right">التاريخ</th>
                    <th className="px-3 py-2 text-right">جيد</th>
                    <th className="px-3 py-2 text-right">هدر</th>
                    <th className="px-3 py-2 text-right">تكلفة الوحدة</th>
                    <th className="px-3 py-2 text-right">الدفعة</th>
                    <th className="px-3 py-2 text-right">الصلاحية</th>
                    <th className="px-3 py-2 text-left">القيمة</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.outputs.map((ev) => (
                    <tr key={ev.id}>
                      <td className="px-3 py-2 text-slate-500">{formatDateTime(ev.producedAt)}</td>
                      <td className="px-3 py-2 font-bold tabular-nums text-emerald-700">{formatQty(ev.qty)}</td>
                      <td className={`px-3 py-2 tabular-nums ${ev.qtyWaste > 0 ? "font-bold text-rose-600" : "text-slate-400"}`}>{formatQty(ev.qtyWaste)}</td>
                      <td className="px-3 py-2 tabular-nums">{formatCurrency(ev.unitCost)}</td>
                      <td className="px-3 py-2">{ev.batchNumber ?? "—"}</td>
                      <td className="px-3 py-2">{formatDate(ev.expiryDate)}</td>
                      <td className="px-3 py-2 text-left tabular-nums font-bold">{formatCurrency(ev.totalCost + ev.wasteCost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}

        {tab === "journals" && (
          data.journals.length === 0 ? <p className="text-sm text-slate-400">لا قيود محاسبية بعد.</p> : (
            <div className="space-y-4">
              {data.journals.map((j) => (
                <div key={j.id} className="rounded-xl border border-slate-200">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50/60 px-4 py-2 text-xs font-bold text-slate-600">
                    <span>{j.number} · {JOURNAL_TYPE[j.referenceType] ?? j.referenceType} · {formatDate(j.date)}</span>
                    <span className="tabular-nums">مدين {formatCurrency(j.totalDebit)} = دائن {formatCurrency(j.totalCredit)}</span>
                  </div>
                  <table className="w-full text-xs">
                    <tbody className="divide-y divide-slate-50">
                      {j.entries.map((e, i) => (
                        <tr key={i}>
                          <td className="px-4 py-1.5 font-mono text-slate-500" dir="ltr">{e.accountCode}</td>
                          <td className="px-4 py-1.5 font-bold text-slate-700">{e.accountName}</td>
                          <td className="px-4 py-1.5 text-left tabular-nums">{e.debit > 0 ? formatCurrency(e.debit) : ""}</td>
                          <td className="px-4 py-1.5 text-left tabular-nums text-slate-500">{e.credit > 0 ? formatCurrency(e.credit) : ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )
        )}

        {tab === "trace" && (
          <div className="space-y-6">
            <div>
              <h3 className="mb-2 text-sm font-extrabold text-slate-800">حركات الدفعات</h3>
              {data.lotMovements.length === 0 ? <p className="text-sm text-slate-400">لا حركات دفعات (لا مواد متتبعة في هذا الأمر).</p> : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-xs font-bold text-slate-500">
                      <tr><th className="px-3 py-2 text-right">الدفعة</th><th className="px-3 py-2 text-right">الصلاحية</th><th className="px-3 py-2 text-right">الحركة</th><th className="px-3 py-2 text-left">الكمية</th></tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {data.lotMovements.map((lm) => (
                        <tr key={lm.id}>
                          <td className="px-3 py-2 font-bold text-slate-800">{lm.lotNumber || lm.lotId}</td>
                          <td className="px-3 py-2 text-slate-500">{formatDate(lm.expiryDate)}</td>
                          <td className="px-3 py-2 text-xs text-slate-500">{LOT_REF[lm.referenceType] ?? lm.referenceType}</td>
                          <td className={`px-3 py-2 text-left font-bold tabular-nums ${lm.signedQty < 0 ? "text-rose-600" : "text-emerald-700"}`}>{lm.signedQty > 0 ? "+" : ""}{formatQty(lm.signedQty)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            <div>
              <h3 className="mb-2 text-sm font-extrabold text-slate-800">التتبع الجيني (مكوّنات ← منتج)</h3>
              {data.genealogy.length === 0 ? <p className="text-sm text-slate-400">لا روابط جينية (منتج غير متتبع أو لا مخرجات بعد).</p> : (
                <ul className="space-y-1 text-sm">
                  {data.genealogy.map((g) => (
                    <li key={g.id} className="rounded-lg bg-slate-50 px-3 py-2">
                      <span className="font-bold text-slate-700">{g.componentLotNumber ?? "—"}</span>
                      <span className="mx-2 text-slate-400">←</span>
                      <span className="font-bold text-teal-700">{g.outputLotNumber}</span>
                      <span className="mr-2 text-xs tabular-nums text-slate-500">({formatQty(g.qty)})</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        {tab === "variance" && (
          variance.isLoading ? <LoadingState rows={2} /> : variance.isError ? <ErrorState error={variance.error} onRetry={() => variance.refetch()} /> : variance.data ? (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Kpi label="العائد" value={variance.data.yieldPct != null ? `${formatNumber(variance.data.yieldPct)}%` : "—"} />
                <Kpi label="قيمة الإنتاج الجيد" value={formatCurrency(variance.data.fgValue)} />
                <Kpi label="قيمة الهدر" value={formatCurrency(variance.data.wasteValue)} tone={variance.data.wasteValue > 0 ? "rose" : undefined} />
                <Kpi label="فروقات WIP/إغلاق" value={formatCurrency(variance.data.wipResidual + variance.data.closeVariance)} />
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-xs font-bold text-slate-500">
                    <tr>
                      <th className="px-3 py-2 text-right">المكوّن</th>
                      <th className="px-3 py-2 text-right">مخطط</th>
                      <th className="px-3 py-2 text-right">فعلي</th>
                      <th className="px-3 py-2 text-right">فرق الكمية</th>
                      <th className="px-3 py-2 text-left">فرق القيمة</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {variance.data.components.map((c) => (
                      <tr key={c.itemId}>
                        <td className="px-3 py-2 font-bold text-slate-800">{c.itemName}</td>
                        <td className="px-3 py-2 tabular-nums">{formatQty(c.qtyPlanned, c.itemUnit)}</td>
                        <td className="px-3 py-2 tabular-nums">{formatQty(c.qtyActual)}</td>
                        <td className={`px-3 py-2 font-bold tabular-nums ${c.qtyVariance > 0 ? "text-rose-600" : c.qtyVariance < 0 ? "text-emerald-600" : "text-slate-400"}`}>{c.qtyVariance > 0 ? "+" : ""}{formatQty(c.qtyVariance)}</td>
                        <td className={`px-3 py-2 text-left font-bold tabular-nums ${c.valueVariance > 0 ? "text-rose-600" : "text-slate-600"}`}>{formatCurrency(c.valueVariance)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null
        )}
      </section>

      {/* Dialogs */}
      <IssueMaterialsDialog open={dialog === "issue"} detail={data} onClose={() => setDialog(null)} onDone={() => { setDialog(null); void refetch(); }} />
      <RecordOutputDialog open={dialog === "output"} detail={data} trackingMode={o.productTrackingMode} onClose={() => setDialog(null)} onDone={() => { setDialog(null); void refetch(); }} />
      <ConfirmDialog
        open={dialog === "approve"} title="اعتماد أمر الإنتاج" description="الاعتماد لا يحرّك المخزون — يسمح فقط بإصدار المواد."
        confirmLabel="اعتماد" processing={m.approve.isPending} error={mutErr(m.approve)}
        onConfirm={() => m.approve.mutate({ id: o.id, expectedVersion: o.version }, { onSuccess: () => setDialog(null) })}
        onClose={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog === "complete"} title="إكمال أمر الإنتاج"
        description={o.qtyProduced + o.qtyWaste < o.qtyPlanned ? "الإنتاج أقل من المخطط — الإكمال المبكر يتطلب سببًا." : "سيتحول الأمر إلى مكتمل ولن يمكن إصدار مواد أو تسجيل مخرجات بعدها."}
        confirmLabel="إكمال" requireReason={o.qtyProduced + o.qtyWaste < o.qtyPlanned}
        reasonLabel="سبب الإكمال المبكر" processing={m.complete.isPending} error={mutErr(m.complete)}
        onConfirm={(reason) => m.complete.mutate({ id: o.id, reason: reason || undefined, expectedVersion: o.version }, { onSuccess: () => setDialog(null) })}
        onClose={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog === "close"} title="إغلاق أمر الإنتاج"
        description={o.wipBalance > 0.005 ? `رصيد WIP المتبقي (${formatCurrency(o.wipBalance)}) سيُرحّل إلى حساب فروقات الإنتاج 5420.` : "لا رصيد WIP متبقٍ — إغلاق نظيف بلا قيد فروقات."}
        confirmLabel="إغلاق نهائي" processing={m.close.isPending} error={mutErr(m.close)}
        onConfirm={() => m.close.mutate({ id: o.id, expectedVersion: o.version }, { onSuccess: () => setDialog(null) })}
        onClose={() => setDialog(null)}
      />
      <ReasonDialog
        open={dialog === "cancel"} title="إلغاء أمر الإنتاج" description="الإلغاء متاح قبل إصدار أي مواد فقط."
        confirmLabel="إلغاء الأمر" pending={m.cancel.isPending} error={mutErr(m.cancel)}
        onConfirm={(reason) => m.cancel.mutate({ id: o.id, reason, expectedVersion: o.version }, { onSuccess: () => setDialog(null) })}
        onClose={() => setDialog(null)}
      />
      <ReasonDialog
        open={dialog === "reverse"} title="عكس أمر الإنتاج"
        description="يعيد كل المواد المصروفة بدفعاتها الأصلية، يسحب المنتج من مستودع الإخراج، ويُنشئ قيدًا عاكسًا لكل قيد. يفشل إن كان المنتج قد استُهلك."
        confirmLabel="تنفيذ العكس" pending={m.reverse.isPending} error={mutErr(m.reverse)}
        onConfirm={(reason) => m.reverse.mutate({ id: o.id, reason, expectedVersion: o.version }, { onSuccess: () => setDialog(null) })}
        onClose={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog === "delete"} title="حذف المسودة" description="حذف نهائي — متاح للمسودات فقط." tone="danger"
        confirmLabel="حذف" processing={m.remove.isPending} error={mutErr(m.remove)}
        onConfirm={() => m.remove.mutate({ id: o.id }, { onSuccess: () => navigate("/production", { replace: true }) })}
        onClose={() => setDialog(null)}
      />
    </div>
  );
}

const ACTION_LABEL: Record<string, string> = {
  create: "إنشاء المسودة",
  edit: "تعديل المسودة",
  approve: "اعتماد",
  issue_materials: "إصدار مواد",
  record_output: "تسجيل إنتاج",
  complete: "إكمال",
  close: "إغلاق",
  cancel: "إلغاء",
  reverse: "عكس",
  delete: "حذف",
};
const JOURNAL_TYPE: Record<string, string> = {
  prod_issue: "إصدار مواد (WIP)",
  prod_output: "إنتاج (بضاعة تامة)",
  prod_close: "فروقات إغلاق",
  prod_issue_reverse: "عكس إصدار",
  prod_output_reverse: "عكس إنتاج",
  prod_close_reverse: "عكس إغلاق",
};
const LOT_REF: Record<string, string> = {
  prod_issue: "استهلاك إنتاج",
  prod_output: "إنتاج",
  prod_issue_reverse: "عكس استهلاك",
  prod_output_reverse: "عكس إنتاج",
};

function Kpi({ label, value, tone, children }: { label: string; value: string; tone?: "rose"; children?: React.ReactNode }) {
  return (
    <div className="surface p-4">
      <div className="text-[11px] font-bold text-slate-400">{label}</div>
      <div className={`mt-1 text-lg font-extrabold tabular-nums ${tone === "rose" ? "text-rose-600" : "text-slate-900"}`}>{value}</div>
      {children && <div className="mt-2">{children}</div>}
    </div>
  );
}

function InfoRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2">
      <span className="text-xs font-bold text-slate-400">{label}</span>
      <span className={`text-sm ${strong ? "font-extrabold text-slate-900" : "font-bold text-slate-700"}`}>{value}</span>
    </div>
  );
}
