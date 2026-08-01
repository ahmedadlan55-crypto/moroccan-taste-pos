import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowRight, CheckCircle2, CircleDot, FileText, Layers, ListTree,
  Lock, PackageMinus, PackagePlus, Printer, Trash2, Undo2, XCircle,
} from "lucide-react";
import { PageHeader } from "@/shared/ui";
import { StatusBadge } from "@/shared/ui";
import { Button } from "@/shared/ui";
import { Progress } from "@/shared/ui";
import { LoadingState, ErrorState } from "@/shared/ui";
import { ConfirmDialog } from "@/shared/ui";
import { ReasonDialog } from "@/modules/inventory/features/_shared/ReasonDialog";
import { useCan } from "@/modules/inventory/lib/permission-provider";
import { useAuth } from "@/app/providers";
import { formatCurrency, formatDate, formatDateTime, formatNumber, formatQty } from "@/shared/lib";
import { productionStatusToLabel } from "@/modules/inventory/lib/status-labels";
import { useProductionDetail, useProductionMutations, useVarianceReport } from "@/modules/inventory/lib/hooks/useProduction";
import { IssueMaterialsDialog } from "./IssueMaterialsDialog";
import { RecordOutputDialog } from "./RecordOutputDialog";
import { printProduction } from "./printProduction";
import { productionStatusLabel } from "./status-i18n";
import { ApiError } from "@/shared/api";
import { useT, useLang } from "@/i18n";

const TABS = [
  { id: "overview", labelKey: "production.detail.tabs.overview", icon: CircleDot },
  { id: "materials", labelKey: "production.detail.tabs.materials", icon: PackageMinus },
  { id: "outputs", labelKey: "production.detail.tabs.outputs", icon: PackagePlus },
  { id: "journals", labelKey: "production.detail.tabs.journals", icon: FileText },
  { id: "trace", labelKey: "production.detail.tabs.trace", icon: Layers },
  { id: "variance", labelKey: "production.detail.tabs.variance", icon: ListTree },
] as const;
type TabId = (typeof TABS)[number]["id"];

/**
 * Single production-order detail. The id arrives as a ROUTE param
 * (`/inventory/production/:id`); the retired `?doc=<id>` form redirects onto it
 * from the module router.
 */
export function ProductionDetailPage({ orderId }: { orderId: string }) {
  const t = useT();
  const lang = useLang();
  const id = orderId;
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

  // Backend code → localized label. Only known codes are mapped; unknown ones
  // fall through to the raw code at the call site (`MAP[x] ?? x`), preserving
  // the legacy fallback behaviour.
  const ACTION_LABEL: Record<string, string> = {
    create: t("production.detail.timeline.actions.create"),
    edit: t("production.detail.timeline.actions.edit"),
    approve: t("production.detail.timeline.actions.approve"),
    issue_materials: t("production.detail.timeline.actions.issue_materials"),
    record_output: t("production.detail.timeline.actions.record_output"),
    complete: t("production.detail.timeline.actions.complete"),
    close: t("production.detail.timeline.actions.close"),
    cancel: t("production.detail.timeline.actions.cancel"),
    reverse: t("production.detail.timeline.actions.reverse"),
    delete: t("production.detail.timeline.actions.delete"),
  };
  const JOURNAL_TYPE: Record<string, string> = {
    prod_issue: t("production.detail.journals.type.prod_issue"),
    prod_output: t("production.detail.journals.type.prod_output"),
    prod_close: t("production.detail.journals.type.prod_close"),
    prod_issue_reverse: t("production.detail.journals.type.prod_issue_reverse"),
    prod_output_reverse: t("production.detail.journals.type.prod_output_reverse"),
    prod_close_reverse: t("production.detail.journals.type.prod_close_reverse"),
  };
  const LOT_REF: Record<string, string> = {
    prod_issue: t("production.detail.trace.ref.prod_issue"),
    prod_output: t("production.detail.trace.ref.prod_output"),
    prod_issue_reverse: t("production.detail.trace.ref.prod_issue_reverse"),
    prod_output_reverse: t("production.detail.trace.ref.prod_output_reverse"),
  };

  return (
    <div>
      <PageHeader
        eyebrow={t("production.opsEyebrow")}
        title={o.number}
        subtitle={t("production.detail.subtitle", {
          product: o.productName,
          planned: formatQty(o.qtyPlanned, o.productUnit),
          warehouses: `${o.warehouseName}${o.outputWarehouseId !== o.warehouseId ? ` ← ${o.outputWarehouseName}` : ""}`,
        })}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge>{productionStatusToLabel(o.status)}</StatusBadge>
            {o.partiallyCompleted && <StatusBadge>{t("production.status.partial")}</StatusBadge>}
            {o.source === "legacy" && <StatusBadge>{t("production.detail.legacyDocBadge")}</StatusBadge>}
            <Button variant="ghost" onClick={() => navigate("/inventory/production")}><ArrowRight className="h-4 w-4 rotate-180 rtl:rotate-0" aria-hidden="true" /> {t("production.detail.backToList")}</Button>
          </div>
        }
      />

      {/* Action toolbar — every button maps 1:1 to a legal transition for this status+role. */}
      {active && o.source === "v2" && (
        <div className="surface mb-4 flex flex-wrap items-center gap-2 p-3">
          {active.issue && <Button variant="primary" onClick={() => setDialog("issue")}><PackageMinus className="h-4 w-4" /> {t("production.detail.actions.issue")}</Button>}
          {active.output && <Button variant="primary" onClick={() => setDialog("output")}><PackagePlus className="h-4 w-4" /> {t("production.detail.actions.output")}</Button>}
          {active.approve && <Button variant="secondary" onClick={() => setDialog("approve")}><CheckCircle2 className="h-4 w-4" /> {t("production.detail.actions.approve")}</Button>}
          {active.approveBlockedSelf && <span className="rounded-lg bg-amber-50 px-3 py-2 text-xs font-bold text-amber-700">{t("production.detail.actions.makerCheckerWarn")}</span>}
          {active.complete && <Button variant="secondary" onClick={() => setDialog("complete")}><CheckCircle2 className="h-4 w-4" /> {t("production.detail.actions.complete")}</Button>}
          {active.close && <Button variant="secondary" onClick={() => setDialog("close")}><Lock className="h-4 w-4" /> {t("production.detail.actions.close")}</Button>}
          {active.edit && <Button variant="secondary" onClick={() => navigate(`/inventory/production/${o.id}/edit`)}>{t("production.detail.actions.editDraft")}</Button>}
          <span className="flex-1" />
          <Button variant="ghost" onClick={() => printProduction(data, t, lang)}><Printer className="h-4 w-4" /> {t("production.detail.actions.print")}</Button>
          {active.cancel && <Button variant="ghost" onClick={() => setDialog("cancel")}><XCircle className="h-4 w-4" /> {t("production.detail.actions.cancel")}</Button>}
          {active.reverse && <Button variant="ghost" className="text-rose-600 hover:bg-rose-50" onClick={() => setDialog("reverse")}><Undo2 className="h-4 w-4" /> {t("production.detail.actions.reverse")}</Button>}
          {active.delete && <Button variant="ghost" className="text-rose-600 hover:bg-rose-50" onClick={() => setDialog("delete")}><Trash2 className="h-4 w-4" /> {t("common.delete")}</Button>}
        </div>
      )}

      {/* KPI strip */}
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Kpi label={t("production.detail.kpi.goodProduced")} value={formatQty(o.qtyProduced, o.productUnit)} />
        <Kpi label={t("production.detail.kpi.waste")} value={formatQty(o.qtyWaste)} tone={o.qtyWaste > 0 ? "rose" : undefined} />
        <Kpi label={t("production.detail.kpi.wipBalance")} value={formatCurrency(o.wipBalance)} />
        <Kpi label={t("production.detail.kpi.cumulativeUnitCost")} value={o.unitCost > 0 ? formatCurrency(o.unitCost) : "—"} />
        <Kpi label={t("production.detail.kpi.completionPct")} value={`${formatNumber(Math.min(producedPct, 100))}%`}>
          <Progress value={producedPct} tone={producedPct >= 100 ? "teal" : "amber"} />
        </Kpi>
      </section>

      {/* Tabs */}
      <div className="mt-5 flex flex-wrap gap-1 border-b border-slate-200" role="tablist" aria-label={t("production.detail.tabsAria")}>
        {TABS.map((tab_) => (
          <button key={tab_.id} role="tab" aria-selected={tab === tab_.id} onClick={() => setTab(tab_.id)}
            className={`inline-flex min-h-11 items-center gap-1.5 rounded-t-xl px-4 text-sm font-extrabold transition ${tab === tab_.id ? "border-b-2 border-teal-600 bg-teal-50/60 text-teal-800" : "text-slate-500 hover:bg-slate-50 hover:text-slate-800"}`}>
            <tab_.icon className="h-4 w-4" /> {t(tab_.labelKey)}
          </button>
        ))}
      </div>

      <section className="surface mt-4 p-5">
        {tab === "overview" && (
          <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
            <div>
              <h3 className="mb-3 text-sm font-extrabold text-slate-800">{t("production.detail.timeline.heading")}</h3>
              {data.timeline.length === 0 ? <p className="text-sm text-slate-400">{t("production.detail.timeline.empty")}</p> : (
                <ol className="space-y-3">
                  {data.timeline.map((ev) => (
                    <li key={ev.id} className="flex gap-3">
                      <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-teal-500" aria-hidden="true" />
                      <div>
                        <div className="text-sm font-bold text-slate-800">
                          {ACTION_LABEL[ev.action] ?? ev.action}
                          {ev.toStatus && <span className="ms-2 text-xs font-medium text-slate-400">← {productionStatusLabel(t, ev.toStatus)}</span>}
                        </div>
                        <div className="text-xs text-slate-500">{ev.actor || "—"} · {formatDateTime(ev.at)}{ev.note ? ` · ${ev.note}` : ""}</div>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </div>
            <div className="space-y-2 text-sm">
              <InfoRow label={t("production.detail.info.createdBy")} value={o.createdBy || "—"} />
              <InfoRow label={t("production.detail.info.approvedBy")} value={o.approvedBy ?? "—"} />
              <InfoRow label={t("production.detail.info.plannedDate")} value={formatDate(o.plannedDate)} />
              <InfoRow label={t("production.detail.info.materials")} value={formatCurrency(o.materialsCost)} />
              <InfoRow label={t("production.detail.info.labor")} value={formatCurrency(o.laborCost)} />
              <InfoRow label={t("production.detail.info.overhead")} value={formatCurrency(o.overheadCost)} />
              <InfoRow label={t("production.detail.info.totalCost")} value={formatCurrency(o.totalCost)} strong />
              {o.yieldPct != null && <InfoRow label={t("production.detail.info.yieldPct")} value={`${formatNumber(o.yieldPct)}%`} />}
              {o.closeVariance > 0 && <InfoRow label={t("production.detail.info.closeVariance")} value={formatCurrency(o.closeVariance)} />}
              {o.cancelReason && <InfoRow label={t("production.detail.info.cancelReason")} value={o.cancelReason} />}
              {o.reverseReason && <InfoRow label={t("production.detail.info.reverseReason")} value={o.reverseReason} />}
              {o.notes && <InfoRow label={t("production.detail.info.notes")} value={o.notes} />}
            </div>
          </div>
        )}

        {tab === "materials" && (
          <div className="space-y-6">
            <div>
              <h3 className="mb-2 text-sm font-extrabold text-slate-800">{t("production.detail.materials.planHeading")}</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-xs font-bold text-slate-500">
                    <tr>
                      <th className="px-3 py-2 text-start">{t("production.detail.materials.col.material")}</th>
                      <th className="px-3 py-2 text-start">{t("production.detail.materials.col.planned")}</th>
                      <th className="px-3 py-2 text-start">{t("production.detail.materials.col.issued")}</th>
                      <th className="px-3 py-2 text-start">{t("production.detail.materials.col.remaining")}</th>
                      <th className="px-3 py-2 text-start">{t("production.detail.materials.col.availableNow")}</th>
                      <th className="px-3 py-2 text-end">{t("production.detail.materials.col.issuedValue")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.plan.map((p) => (
                      <tr key={p.itemId}>
                        <td className="px-3 py-2 font-bold text-slate-800">{p.itemName}{p.trackingMode !== "none" && <span className="ms-2 rounded-md bg-sky-50 px-1.5 py-0.5 text-[10px] font-bold text-sky-700">{t("production.detail.materials.trackedBadge")}</span>}</td>
                        <td className="px-3 py-2 tabular-nums">{formatQty(p.qtyPlanned, p.itemUnit)}</td>
                        <td className="px-3 py-2 tabular-nums">{formatQty(p.qtyIssued)}</td>
                        <td className={`px-3 py-2 font-bold tabular-nums ${p.remaining > 0 ? "text-amber-600" : "text-emerald-600"}`}>{formatQty(Math.max(p.remaining, 0))}</td>
                        <td className="px-3 py-2 tabular-nums text-slate-500">{formatQty(p.available)}</td>
                        <td className="px-3 py-2 text-end tabular-nums">{formatCurrency(p.totalCost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div>
              <h3 className="mb-2 text-sm font-extrabold text-slate-800">{t("production.detail.materials.issueEventsHeading", { count: formatNumber(data.issueEvents.length) })}</h3>
              {data.issueEvents.length === 0 ? <p className="text-sm text-slate-400">{t("production.detail.materials.noIssues")}</p> : data.issueEvents.map((ev) => (
                <div key={ev.id} className="mb-3 rounded-xl border border-slate-200">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50/60 px-4 py-2 text-xs font-bold text-slate-600">
                    <span>{t("production.detail.materials.eventLine", { no: formatNumber(ev.eventNo), by: ev.issuedBy, at: formatDateTime(ev.issuedAt) })}</span>
                    <span className="tabular-nums">
                      {t("production.detail.materials.sumMaterials", { value: formatCurrency(ev.materialsCost) })}
                      {ev.laborCost > 0 && <> · {t("production.detail.materials.sumLabor", { value: formatCurrency(ev.laborCost) })}</>}
                      {ev.overheadCost > 0 && <> · {t("production.detail.materials.sumOverhead", { value: formatCurrency(ev.overheadCost) })}</>}
                    </span>
                  </div>
                  <table className="w-full text-xs">
                    <tbody className="divide-y divide-slate-50">
                      {ev.lines.map((l) => (
                        <tr key={l.id}>
                          <td className="px-4 py-1.5 font-bold text-slate-700">{l.itemName}</td>
                          <td className="px-4 py-1.5 tabular-nums">{formatQty(l.qty, l.itemUnit)}</td>
                          <td className="px-4 py-1.5 tabular-nums text-slate-500">@ {formatCurrency(l.unitCost)}</td>
                          <td className="px-4 py-1.5 text-end tabular-nums font-bold">{formatCurrency(l.lineTotal)}</td>
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
          data.outputs.length === 0 ? <p className="text-sm text-slate-400">{t("production.detail.outputs.empty")}</p> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs font-bold text-slate-500">
                  <tr>
                    <th className="px-3 py-2 text-start">{t("production.detail.outputs.col.date")}</th>
                    <th className="px-3 py-2 text-start">{t("production.detail.outputs.col.good")}</th>
                    <th className="px-3 py-2 text-start">{t("production.detail.outputs.col.waste")}</th>
                    <th className="px-3 py-2 text-start">{t("production.detail.outputs.col.unitCost")}</th>
                    <th className="px-3 py-2 text-start">{t("production.detail.outputs.col.batch")}</th>
                    <th className="px-3 py-2 text-start">{t("production.detail.outputs.col.expiry")}</th>
                    <th className="px-3 py-2 text-end">{t("production.detail.outputs.col.value")}</th>
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
                      <td className="px-3 py-2 text-end tabular-nums font-bold">{formatCurrency(ev.totalCost + ev.wasteCost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}

        {tab === "journals" && (
          data.journals.length === 0 ? <p className="text-sm text-slate-400">{t("production.detail.journals.empty")}</p> : (
            <div className="space-y-4">
              {data.journals.map((j) => (
                <div key={j.id} className="rounded-xl border border-slate-200">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50/60 px-4 py-2 text-xs font-bold text-slate-600">
                    <span>{j.number} · {JOURNAL_TYPE[j.referenceType] ?? j.referenceType} · {formatDate(j.date)}</span>
                    <span className="tabular-nums">{t("production.detail.journals.debitEqualsCredit", { debit: formatCurrency(j.totalDebit), credit: formatCurrency(j.totalCredit) })}</span>
                  </div>
                  <table className="w-full text-xs">
                    <tbody className="divide-y divide-slate-50">
                      {j.entries.map((e, i) => (
                        <tr key={i}>
                          <td className="px-4 py-1.5 font-mono text-slate-500" dir="ltr">{e.accountCode}</td>
                          <td className="px-4 py-1.5 font-bold text-slate-700">{e.accountName}</td>
                          <td className="px-4 py-1.5 text-end tabular-nums">{e.debit > 0 ? formatCurrency(e.debit) : ""}</td>
                          <td className="px-4 py-1.5 text-end tabular-nums text-slate-500">{e.credit > 0 ? formatCurrency(e.credit) : ""}</td>
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
              <h3 className="mb-2 text-sm font-extrabold text-slate-800">{t("production.detail.trace.lotMovementsHeading")}</h3>
              {data.lotMovements.length === 0 ? <p className="text-sm text-slate-400">{t("production.detail.trace.noLotMovements")}</p> : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-xs font-bold text-slate-500">
                      <tr><th className="px-3 py-2 text-start">{t("production.detail.trace.col.lot")}</th><th className="px-3 py-2 text-start">{t("production.detail.trace.col.expiry")}</th><th className="px-3 py-2 text-start">{t("production.detail.trace.col.movement")}</th><th className="px-3 py-2 text-end">{t("production.detail.trace.col.qty")}</th></tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {data.lotMovements.map((lm) => (
                        <tr key={lm.id}>
                          <td className="px-3 py-2 font-bold text-slate-800">{lm.lotNumber || lm.lotId}</td>
                          <td className="px-3 py-2 text-slate-500">{formatDate(lm.expiryDate)}</td>
                          <td className="px-3 py-2 text-xs text-slate-500">{LOT_REF[lm.referenceType] ?? lm.referenceType}</td>
                          <td className={`px-3 py-2 text-end font-bold tabular-nums ${lm.signedQty < 0 ? "text-rose-600" : "text-emerald-700"}`}>{lm.signedQty > 0 ? "+" : ""}{formatQty(lm.signedQty)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            <div>
              <h3 className="mb-2 text-sm font-extrabold text-slate-800">{t("production.detail.trace.genealogyHeading")}</h3>
              {data.genealogy.length === 0 ? <p className="text-sm text-slate-400">{t("production.detail.trace.noGenealogy")}</p> : (
                <ul className="space-y-1 text-sm">
                  {data.genealogy.map((g) => (
                    <li key={g.id} className="rounded-lg bg-slate-50 px-3 py-2">
                      <span className="font-bold text-slate-700">{g.componentLotNumber ?? "—"}</span>
                      <span className="mx-2 text-slate-400">←</span>
                      <span className="font-bold text-teal-700">{g.outputLotNumber}</span>
                      <span className="ms-2 text-xs tabular-nums text-slate-500">({formatQty(g.qty)})</span>
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
                <Kpi label={t("production.detail.variance.kpi.yield")} value={variance.data.yieldPct != null ? `${formatNumber(variance.data.yieldPct)}%` : "—"} />
                <Kpi label={t("production.detail.variance.kpi.goodValue")} value={formatCurrency(variance.data.fgValue)} />
                <Kpi label={t("production.detail.variance.kpi.wasteValue")} value={formatCurrency(variance.data.wasteValue)} tone={variance.data.wasteValue > 0 ? "rose" : undefined} />
                <Kpi label={t("production.detail.variance.kpi.wipCloseVariance")} value={formatCurrency(variance.data.wipResidual + variance.data.closeVariance)} />
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-xs font-bold text-slate-500">
                    <tr>
                      <th className="px-3 py-2 text-start">{t("production.detail.variance.col.component")}</th>
                      <th className="px-3 py-2 text-start">{t("production.detail.variance.col.planned")}</th>
                      <th className="px-3 py-2 text-start">{t("production.detail.variance.col.actual")}</th>
                      <th className="px-3 py-2 text-start">{t("production.detail.variance.col.qtyVariance")}</th>
                      <th className="px-3 py-2 text-end">{t("production.detail.variance.col.valueVariance")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {variance.data.components.map((c) => (
                      <tr key={c.itemId}>
                        <td className="px-3 py-2 font-bold text-slate-800">{c.itemName}</td>
                        <td className="px-3 py-2 tabular-nums">{formatQty(c.qtyPlanned, c.itemUnit)}</td>
                        <td className="px-3 py-2 tabular-nums">{formatQty(c.qtyActual)}</td>
                        <td className={`px-3 py-2 font-bold tabular-nums ${c.qtyVariance > 0 ? "text-rose-600" : c.qtyVariance < 0 ? "text-emerald-600" : "text-slate-400"}`}>{c.qtyVariance > 0 ? "+" : ""}{formatQty(c.qtyVariance)}</td>
                        <td className={`px-3 py-2 text-end font-bold tabular-nums ${c.valueVariance > 0 ? "text-rose-600" : "text-slate-600"}`}>{formatCurrency(c.valueVariance)}</td>
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
        open={dialog === "approve"} title={t("production.detail.dialogs.approve.title")} description={t("production.detail.dialogs.approve.desc")}
        confirmLabel={t("production.detail.dialogs.approve.confirm")} processing={m.approve.isPending} error={mutErr(m.approve)}
        onConfirm={() => m.approve.mutate({ id: o.id, expectedVersion: o.version }, { onSuccess: () => setDialog(null) })}
        onClose={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog === "complete"} title={t("production.detail.dialogs.complete.title")}
        description={o.qtyProduced + o.qtyWaste < o.qtyPlanned ? t("production.detail.dialogs.complete.descEarly") : t("production.detail.dialogs.complete.descNormal")}
        confirmLabel={t("production.detail.dialogs.complete.confirm")} requireReason={o.qtyProduced + o.qtyWaste < o.qtyPlanned}
        reasonLabel={t("production.detail.dialogs.complete.reasonLabel")} processing={m.complete.isPending} error={mutErr(m.complete)}
        onConfirm={(reason) => m.complete.mutate({ id: o.id, reason: reason || undefined, expectedVersion: o.version }, { onSuccess: () => setDialog(null) })}
        onClose={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog === "close"} title={t("production.detail.dialogs.close.title")}
        description={o.wipBalance > 0.005 ? t("production.detail.dialogs.close.descWithWip", { value: formatCurrency(o.wipBalance) }) : t("production.detail.dialogs.close.descClean")}
        confirmLabel={t("production.detail.dialogs.close.confirm")} processing={m.close.isPending} error={mutErr(m.close)}
        onConfirm={() => m.close.mutate({ id: o.id, expectedVersion: o.version }, { onSuccess: () => setDialog(null) })}
        onClose={() => setDialog(null)}
      />
      <ReasonDialog
        open={dialog === "cancel"} title={t("production.detail.dialogs.cancel.title")} description={t("production.detail.dialogs.cancel.desc")}
        confirmLabel={t("production.detail.dialogs.cancel.confirm")} pending={m.cancel.isPending} error={mutErr(m.cancel)}
        onConfirm={(reason) => m.cancel.mutate({ id: o.id, reason, expectedVersion: o.version }, { onSuccess: () => setDialog(null) })}
        onClose={() => setDialog(null)}
      />
      <ReasonDialog
        open={dialog === "reverse"} title={t("production.detail.dialogs.reverse.title")}
        description={t("production.detail.dialogs.reverse.desc")}
        confirmLabel={t("production.detail.dialogs.reverse.confirm")} pending={m.reverse.isPending} error={mutErr(m.reverse)}
        onConfirm={(reason) => m.reverse.mutate({ id: o.id, reason, expectedVersion: o.version }, { onSuccess: () => setDialog(null) })}
        onClose={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog === "delete"} title={t("production.detail.dialogs.delete.title")} description={t("production.detail.dialogs.delete.desc")} tone="danger"
        confirmLabel={t("production.detail.dialogs.delete.confirm")} processing={m.remove.isPending} error={mutErr(m.remove)}
        onConfirm={() => m.remove.mutate({ id: o.id }, { onSuccess: () => navigate("/inventory/production", { replace: true }) })}
        onClose={() => setDialog(null)}
      />
    </div>
  );
}

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
