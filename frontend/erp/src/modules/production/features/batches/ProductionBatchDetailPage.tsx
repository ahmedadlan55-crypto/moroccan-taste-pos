import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, CheckCircle2, XCircle } from "lucide-react";
import { DataTable, type ColumnDef } from "@/shared/tables";
import { Button, ConfirmDialog, ErrorState, LoadingState, PageHeader, StatusBadge } from "@/shared/ui";
import { ReasonDialog } from "@/modules/inventory/features/_shared/ReasonDialog";
import { useCan } from "@/shared/permissions";
import { ApiError } from "@/shared/api";
import { formatCurrency, formatDate, formatDateTime, formatNumber, formatQty } from "@/shared/lib";
import { useT } from "@/i18n";
import { productionStatusLabel } from "../production/status-i18n";
import type { BatchChild, BatchMaterial } from "../../lib/batchApi";
import { useBatchDetail, useBatchMutations } from "../../lib/useBatches";

/** draft → approved → in_progress → completed → closed. `cancelled`/`reversed`
 *  are terminal exits, rendered as a badge rather than a step. */
const LIFECYCLE = ["draft", "approved", "in_progress", "completed", "closed"] as const;

const ACTION_KEY: Record<string, string> = {
  create: "production.detail.timeline.actions.create",
  approve: "production.detail.timeline.actions.approve",
  cancel: "production.detail.timeline.actions.cancel",
};

/** Full-page detail for ONE production document (/inventory/production/batches/:id). */
export function ProductionBatchDetailPage({ batchId }: { batchId: string }) {
  const t = useT();
  const navigate = useNavigate();
  const id = batchId;
  const { data, isLoading, isError, error, refetch } = useBatchDetail(id || null);
  const m = useBatchMutations();
  const canApprove = useCan("production.approve");
  const canCancel = useCan("production.cancel");
  const [dialog, setDialog] = useState<null | "approve" | "cancel">(null);

  if (isLoading) return <LoadingState />;
  if (isError || !data) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const b = data.batch;
  const totalCost = data.children.reduce((s, c) => s + c.totalCost, 0);
  const wip = data.children.reduce((s, c) => s + c.wipBalance, 0);
  const stepIndex = LIFECYCLE.indexOf(b.status as (typeof LIFECYCLE)[number]);
  const mutErr = (mu: { error: Error | null }) =>
    mu.error instanceof ApiError ? mu.error.message : (mu.error?.message ?? null);

  const childColumns: ColumnDef<BatchChild>[] = [
    {
      id: "line",
      header: t("production.batch.detail.childrenCol.line"),
      accessor: (r) => r.lineNo + 1,
      numeric: true,
      width: 70,
    },
    {
      id: "orderNumber",
      header: t("production.batch.detail.childrenCol.orderNumber"),
      accessor: (r) => r.orderNumber,
      cell: (r) => <span className="font-extrabold text-slate-900">{r.orderNumber}</span>,
      sortable: true,
      priority: 1,
    },
    {
      id: "product",
      header: t("production.batch.detail.childrenCol.product"),
      accessor: (r) => r.productName,
      priority: 2,
    },
    {
      id: "status",
      header: t("common.status"),
      accessor: (r) => r.status,
      cell: (r) => <StatusBadge>{productionStatusLabel(t, r.status)}</StatusBadge>,
      priority: 3,
    },
    {
      id: "qty",
      header: t("production.batch.detail.childrenCol.qty"),
      accessor: (r) => r.qtyPlanned,
      cell: (r) => `${formatQty(r.qtyProduced)} / ${formatQty(r.qtyPlanned)}`,
      numeric: true,
    },
    {
      id: "warehouses",
      header: t("production.batch.detail.childrenCol.warehouses"),
      accessor: (r) =>
        r.outputWarehouseId !== r.warehouseId ? `${r.warehouseName} → ${r.outputWarehouseName}` : r.warehouseName,
      mobileHidden: true,
    },
    {
      id: "cost",
      header: t("production.batch.detail.childrenCol.cost"),
      accessor: (r) => r.totalCost,
      cell: (r) => formatCurrency(r.totalCost),
      numeric: true,
    },
    {
      id: "wip",
      header: t("production.batch.detail.childrenCol.wip"),
      accessor: (r) => r.wipBalance,
      cell: (r) => formatCurrency(r.wipBalance),
      numeric: true,
    },
  ];

  const materialColumns: ColumnDef<BatchMaterial>[] = [
    {
      id: "material",
      header: t("production.batch.detail.materialsCol.material"),
      accessor: (r) => r.itemName,
      priority: 1,
    },
    {
      id: "required",
      header: t("production.batch.detail.materialsCol.required"),
      accessor: (r) => r.required,
      cell: (r) => formatQty(r.required, r.unit),
      numeric: true,
      priority: 2,
    },
    {
      id: "issued",
      header: t("production.batch.detail.materialsCol.issued"),
      accessor: (r) => r.issued,
      cell: (r) => formatQty(r.issued),
      numeric: true,
    },
    {
      id: "remaining",
      header: t("production.batch.detail.materialsCol.remaining"),
      accessor: (r) => r.remaining,
      cell: (r) => formatQty(Math.max(r.remaining, 0)),
      numeric: true,
      priority: 3,
    },
    {
      id: "available",
      header: t("production.batch.detail.materialsCol.available"),
      accessor: (r) => r.available,
      cell: (r) => formatQty(r.available),
      numeric: true,
    },
    {
      id: "shortage",
      header: t("production.batch.detail.materialsCol.shortage"),
      accessor: (r) => r.shortage,
      cell: (r) => formatQty(r.shortage),
      cellTone: (r) => (r.shortage > 0 ? "negative" : undefined),
      numeric: true,
    },
    {
      id: "unitCost",
      header: t("production.batch.detail.materialsCol.unitCost"),
      accessor: (r) => r.unitCost,
      cell: (r) => formatCurrency(r.unitCost),
      numeric: true,
      defaultHidden: true,
    },
    {
      id: "attribution",
      header: t("production.batch.detail.materialsCol.attribution"),
      accessor: (r) => r.attribution.map((a) => `${a.productName}: ${formatQty(a.qty)}`).join(" · "),
      cell: (r) => (
        <ul className="space-y-0.5">
          {r.attribution.map((a) => (
            <li key={a.orderId} className="text-xs font-bold text-slate-600">
              {t("production.batch.create.attributionLine", {
                product: `${a.productName} (${a.orderNumber})`,
                qty: formatQty(a.qty, r.unit),
              })}
            </li>
          ))}
        </ul>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow={t("production.batch.eyebrow")}
        title={b.batchNumber || id}
        subtitle={t("production.batch.detail.subtitle", {
          products: formatNumber(data.children.length),
          // The batch header carries warehouse IDS only; the children carry the
          // resolved names, so read the label off the first child and fall back
          // to the id rather than printing a blank.
          warehouses: warehouseLabel(data.children[0], b.warehouseId),
          date: formatDate(b.batchDate),
        })}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge>{productionStatusLabel(t, b.status)}</StatusBadge>
            <Button variant="ghost" onClick={() => navigate("/inventory/production?view=batches")}>
              <ArrowRight className="h-4 w-4 rotate-180 rtl:rotate-0" aria-hidden="true" />{" "}
              {t("production.batch.detail.backToList")}
            </Button>
          </div>
        }
      />

      {(canApprove || canCancel) && (b.status === "draft" || b.status === "approved") && (
        <div className="surface mb-4 flex flex-wrap items-center gap-2 p-3">
          {canApprove && b.status === "draft" && (
            <Button variant="primary" onClick={() => setDialog("approve")}>
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> {t("production.batch.detail.actions.approve")}
            </Button>
          )}
          {canCancel && (
            <Button variant="ghost" onClick={() => setDialog("cancel")}>
              <XCircle className="h-4 w-4" aria-hidden="true" /> {t("production.batch.detail.actions.cancel")}
            </Button>
          )}
        </div>
      )}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label={t("production.batch.detail.kpi.products")} value={formatNumber(data.children.length)} />
        <Kpi label={t("production.batch.detail.kpi.materialsCost")} value={formatCurrency(totalCost)} />
        <Kpi label={t("production.batch.detail.kpi.wip")} value={formatCurrency(wip)} />
        <Kpi label={t("production.batch.detail.kpi.approvedBy")} value={b.approvedBy ?? "—"} />
      </section>

      <section className="surface mt-4 p-5">
        <h2 className="mb-1 text-sm font-extrabold text-slate-800">{t("production.batch.detail.lifecycleHeading")}</h2>
        <p className="mb-3 text-xs font-medium text-slate-500">{t("production.batch.detail.lifecycleNote")}</p>
        <ol className="grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {LIFECYCLE.map((s, i) => (
            <li
              key={s}
              className={`rounded-xl border px-3 py-2 text-xs font-extrabold ${
                stepIndex === i
                  ? "border-teal-600 bg-teal-50 text-teal-800"
                  : stepIndex > i
                    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                    : "border-slate-200 bg-white text-slate-400"
              }`}
            >
              <span className="tabular-nums">{i + 1}.</span> {productionStatusLabel(t, s)}
            </li>
          ))}
        </ol>
        {stepIndex < 0 && (
          <p className="mt-2">
            <StatusBadge>{productionStatusLabel(t, b.status)}</StatusBadge>
          </p>
        )}
      </section>

      <section className="mt-4">
        <h2 className="mb-3 text-sm font-extrabold text-slate-800">{t("production.batch.detail.childrenHeading")}</h2>
        <DataTable<BatchChild>
          columns={childColumns}
          rows={data.children}
          getRowId={(r) => r.id}
          paginate={false}
          columnMenu={false}
          tableId="production-batch-children"
          onRowClick={(r) => navigate(`/inventory/production/${r.id}`)}
          mobileTitle={(r) => r.orderNumber}
          emptyTitle={t("production.batch.detail.childrenEmpty")}
        />
      </section>

      <section className="mt-4">
        <h2 className="mb-3 text-sm font-extrabold text-slate-800">{t("production.batch.detail.materialsHeading")}</h2>
        <DataTable<BatchMaterial>
          columns={materialColumns}
          rows={data.materials}
          getRowId={(r) => `${r.itemId}|${r.warehouseId}`}
          paginate={false}
          tableId="production-batch-materials"
          mobileTitle={(r) => r.itemName}
          emptyTitle={t("production.batch.detail.materialsEmpty")}
        />
      </section>

      <section className="surface mt-4 p-5">
        <h2 className="mb-3 text-sm font-extrabold text-slate-800">{t("production.batch.detail.timelineHeading")}</h2>
        {data.timeline.length === 0 ? (
          <p className="text-sm text-slate-400">{t("production.batch.detail.timelineEmpty")}</p>
        ) : (
          <ol className="space-y-3">
            {data.timeline.map((ev) => (
              <li key={ev.id} className="flex gap-3">
                <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-teal-500" aria-hidden="true" />
                <div className="min-w-0">
                  <div className="text-sm font-bold text-slate-800">
                    {ACTION_KEY[ev.action] ? t(ACTION_KEY[ev.action]) : ev.action}
                    {ev.toStatus && (
                      <span className="ms-2 text-xs font-medium text-slate-400">
                        → {productionStatusLabel(t, ev.toStatus)}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-slate-500">
                    {ev.actor || "—"} · {formatDateTime(ev.at)}
                    {ev.note ? ` · ${ev.note}` : ""}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      <ConfirmDialog
        open={dialog === "approve"}
        title={t("production.batch.detail.dialogs.approve.title")}
        description={t("production.batch.detail.dialogs.approve.desc")}
        confirmLabel={t("production.batch.detail.dialogs.approve.confirm")}
        processing={m.approve.isPending}
        error={mutErr(m.approve)}
        onConfirm={() =>
          m.approve.mutate({ id: b.id, expectedVersion: b.version }, { onSuccess: () => setDialog(null) })
        }
        onClose={() => setDialog(null)}
      />
      <ReasonDialog
        open={dialog === "cancel"}
        title={t("production.batch.detail.dialogs.cancel.title")}
        description={t("production.batch.detail.dialogs.cancel.desc")}
        confirmLabel={t("production.batch.detail.dialogs.cancel.confirm")}
        pending={m.cancel.isPending}
        error={mutErr(m.cancel)}
        onConfirm={(reason) =>
          m.cancel.mutate({ id: b.id, reason, expectedVersion: b.version }, { onSuccess: () => setDialog(null) })
        }
        onClose={() => setDialog(null)}
      />
    </div>
  );
}

function warehouseLabel(child: BatchChild | undefined, fallback: string): string {
  if (!child) return fallback || "—";
  const src = child.warehouseName || child.warehouseId;
  if (child.outputWarehouseId === child.warehouseId) return src;
  return `${src} → ${child.outputWarehouseName || child.outputWarehouseId}`;
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="surface p-4">
      <div className="text-[11px] font-bold text-slate-400">{label}</div>
      <div className="mt-1 text-lg font-extrabold tabular-nums text-slate-900">{value}</div>
    </div>
  );
}
