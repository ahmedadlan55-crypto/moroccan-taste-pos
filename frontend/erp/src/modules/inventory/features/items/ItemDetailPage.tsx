// D1 — Inventory Item full-page detail (read). Replaces the old
// ItemDetailDrawer with a routed page at /inventory/items/:id. Read-only across
// the board: WAC is display-only and there is no GL/balance editing here. Cost
// blocks are gated by the `item.cost.view` capability. Edit / activate /
// deactivate are the only actions.
import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Boxes, Pencil, Power, PowerOff } from "lucide-react";
import { Button, StatusBadge, Badge, PanelTitle, LoadingState, ErrorState } from "@/shared/ui";
import { ApiError } from "@/shared/api";
import { useCan } from "@/modules/inventory/lib/permission-provider";
import { formatCurrency, formatQty, formatDate } from "@/shared/lib";
import { useT, useLang } from "@/i18n";
import { useItemDetail, useItemMutations } from "@/modules/inventory/lib/hooks/useItems";
import { useItemUnits } from "@/modules/inventory/lib/hooks/useItemUnits";

const ACTION_LABEL: Record<string, string> = {
  create: "إنشاء", edit: "تعديل", activate: "تفعيل", deactivate: "تعطيل", rule: "قاعدة إعادة طلب", assign: "إسناد",
};

export function ItemDetailPage({ itemId }: { itemId: string }) {
  const t = useT();
  const lang = useLang();
  const navigate = useNavigate();
  const q = useItemDetail(itemId);
  const unitsQ = useItemUnits(itemId);
  const m = useItemMutations();
  const canEdit = useCan("item.edit");
  const canActivate = useCan("item.activate");
  const canCost = useCan("item.cost.view");
  const [err, setErr] = useState<string | null>(null);
  const d = q.data;

  if (!d) return <div className="p-4">{q.isLoading ? <LoadingState rows={3} /> : <ErrorState error={q.error} onRetry={() => q.refetch()} />}</div>;

  const busy = m.activate.isPending || m.deactivate.isPending;
  const onError = (e: unknown) => {
    setErr(e instanceof ApiError ? (e.isConflict ? t("states.conflict") : e.message) : t("states.unexpectedError"));
    if (e instanceof ApiError && e.isConflict) q.refetch();
  };
  const bizName = lang === "en" ? d.nameEn || d.name : d.name;
  const unitRows = unitsQ.data?.units ?? [];

  return (
    <div className="grid gap-6">
      <Link to="/inventory/items" className="text-sm font-bold text-teal-700 hover:underline">← {t("items.detail.back")}</Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs font-extrabold uppercase tracking-wide text-teal-700">
            <Boxes className="h-4 w-4" /> {t("items.detail.eyebrow")}
          </div>
          <h1 className="mt-0.5 truncate text-2xl font-extrabold text-slate-900">{bizName}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span className="font-mono" dir="ltr">{d.sku || "—"}</span>
            <span>·</span>
            <span>{t("items.detail.version")} {d.version}</span>
            {!d.nameEn && <Badge tone="warning">{t("items.badge.missingNameEn")}</Badge>}
            <Badge tone={d.kind === "semi" ? "purple" : "neutral"}>{d.kind === "semi" ? t("items.badge.semi") : t("items.badge.raw")}</Badge>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge>{d.active ? t("status.active") : t("common.inactive")}</StatusBadge>
          {canEdit && <Button variant="secondary" onClick={() => navigate(`/inventory/items/${d.id}/edit`)}><Pencil className="h-4 w-4" /> {t("items.detail.edit")}</Button>}
          {canActivate && (d.active ? (
            <Button variant="ghost" disabled={busy} onClick={() => m.deactivate.mutate({ id: d.id, expectedVersion: d.version }, { onSuccess: () => q.refetch(), onError })}><PowerOff className="h-4 w-4" /> {t("items.detail.deactivate")}</Button>
          ) : (
            <Button variant="primary" disabled={busy} onClick={() => m.activate.mutate({ id: d.id, expectedVersion: d.version }, { onSuccess: () => q.refetch(), onError })}><Power className="h-4 w-4" /> {t("items.detail.activate")}</Button>
          ))}
        </div>
      </div>

      {err && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm font-bold text-rose-700">{err}</p>}

      {/* Basic data */}
      <Section title={t("items.detail.section.basics")}>
        <div className="grid grid-cols-2 gap-3 p-5 sm:grid-cols-3 lg:grid-cols-4">
          <KV label={t("items.form.field.nameAr")} value={d.name} />
          <KV label={t("items.form.field.nameEn")} value={d.nameEn || "—"} />
          <KV label={t("items.form.field.code")} value={<span className="font-mono" dir="ltr">{d.sku || "—"}</span>} />
          <KV label={t("items.form.field.category")} value={d.category || "—"} />
          <KV label={t("items.form.field.kind")} value={d.kind === "semi" ? t("items.form.field.kindSemi") : t("items.form.field.kindRaw")} />
          <KV label={t("items.detail.totalStock")} value={formatQty(d.stock)} />
          {d.description && <div className="col-span-2 sm:col-span-3 lg:col-span-4"><KV label={t("items.form.field.descAr")} value={d.description} /></div>}
        </div>
      </Section>

      {/* Units & conversion */}
      <Section title={t("items.detail.section.units")}>
        <div className="overflow-x-auto p-5">
          <table className="w-full text-sm">
            <thead className="text-[11px] font-extrabold uppercase text-slate-400">
              <tr>
                <th className="px-3 py-2 text-start">{t("items.form.field.majorUnitName")}</th>
                <th className="px-3 py-2 text-end">{t("items.form.field.conversionFactor")}</th>
                <th className="px-3 py-2 text-start">{t("common.status")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {unitRows.length === 0 ? (
                <tr><td className="px-3 py-3 text-slate-400" colSpan={3}>{d.unit}</td></tr>
              ) : unitRows.map((u, i) => (
                <tr key={u.unitCode || i}>
                  <td className="px-3 py-2 font-bold text-slate-700">{u.unitName} {u.isBase && <Badge tone="teal">{t("items.form.field.baseUnitName")}</Badge>}</td>
                  <td className="px-3 py-2 text-end tabular-nums text-slate-600" dir="ltr">{u.isBase ? "1" : t("items.conversionPreview", { major: u.unitName, factor: formatQty(u.conversionToBase), base: d.unit })}</td>
                  <td className="px-3 py-2"><StatusBadge>{u.isActive ? t("status.active") : t("common.inactive")}</StatusBadge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* Barcodes (read) */}
      <Section title={t("items.detail.section.barcodes")}>
        <div className="flex flex-wrap gap-2 p-5">
          {(!d.barcode && d.barcodes.length === 0) ? <p className="text-sm text-slate-400">{t("items.detail.noBarcodes")}</p> : (
            <>
              {d.barcode && <span className="rounded-lg border border-teal-300 bg-teal-50/50 px-3 py-1.5 font-mono text-sm font-bold text-slate-800" dir="ltr">{d.barcode} · {t("items.badge.main")}</span>}
              {d.barcodes.map((b) => <span key={b.id} className="rounded-lg border border-slate-200 px-3 py-1.5 font-mono text-sm text-slate-700" dir="ltr">{b.code}{b.sizeVariant ? ` · ${b.sizeVariant}` : ""}</span>)}
            </>
          )}
        </div>
      </Section>

      {/* Cost & accounting — gated */}
      {canCost && (
        <Section title={t("items.detail.section.cost")}>
          <div className="grid grid-cols-2 gap-3 p-5 sm:grid-cols-3 lg:grid-cols-4">
            <KV label={t("items.detail.fallbackCost")} value={formatCurrency(d.cost)} />
            <KV label={t("items.form.field.costMethod")} value={t("items.form.costMethodWac")} />
          </div>
          <p className="mx-5 mb-5 rounded-lg bg-amber-50 px-3 py-2 text-xs font-bold text-amber-800">{t("items.form.wacReadOnly")}</p>
        </Section>
      )}

      {/* Branches & warehouses + stock/WAC */}
      <Section title={t("items.detail.section.assignments")}>
        {d.distribution.length === 0 ? <p className="p-5 text-sm text-slate-400">{t("items.detail.noAssignments")}</p> : (
          <div className="overflow-x-auto p-5">
            <table className="w-full text-sm">
              <thead className="text-[11px] font-extrabold uppercase text-slate-400">
                <tr>
                  <th className="px-3 py-2 text-start">{t("items.assign.warehouse")}</th>
                  <th className="px-3 py-2 text-end">{t("items.col.availableQty")}</th>
                  {canCost && <th className="px-3 py-2 text-end">WAC</th>}
                  {canCost && <th className="px-3 py-2 text-end">{t("items.detail.section.cost")}</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {d.distribution.map((w) => (
                  <tr key={w.warehouseId}>
                    <td className="px-3 py-2 font-bold text-slate-700">{w.warehouseName}{w.isMain && <Badge tone="teal">{t("items.assign.isDefault")}</Badge>}</td>
                    <td className="px-3 py-2 text-end tabular-nums text-slate-600" dir="ltr">{formatQty(w.qty)}</td>
                    {canCost && <td className="px-3 py-2 text-end tabular-nums text-slate-600" dir="ltr">{formatCurrency(w.avgCost)}</td>}
                    {canCost && <td className="px-3 py-2 text-end tabular-nums text-slate-600" dir="ltr">{formatCurrency(w.value)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* Movements */}
      <Section title={t("items.detail.section.movements")}>
        <div className="p-5">
          {d.movements.length === 0 ? <p className="text-sm text-slate-400">{t("items.detail.noMovements")}</p> : (
            <ul className="space-y-1">
              {d.movements.map((mv) => (
                <li key={mv.id} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-1.5 text-xs">
                  <span>{mv.reason || (mv.type === "in" ? "وارد" : "صادر")} · {formatDate(mv.at)}</span>
                  <span className={`font-bold ${mv.type === "in" ? "text-emerald-700" : "text-sky-700"}`} dir="ltr">{mv.type === "in" ? "+" : "−"}{formatQty(mv.qty)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Section>

      {/* Audit trail */}
      <Section title={t("items.detail.section.audit")}>
        <ol className="space-y-2 p-5">
          {d.timeline.map((e, i) => (
            <li key={i} className="flex items-start gap-2 text-xs">
              <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-teal-500" />
              <div><span className="font-bold text-slate-700">{ACTION_LABEL[e.action] ?? e.action}</span><span className="text-slate-400"> · {e.actor} · {formatDate(e.at)}</span>{e.note && <div className="text-slate-500">{e.note}</div>}</div>
            </li>
          ))}
        </ol>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="surface overflow-hidden">
      <PanelTitle title={title} />
      {children}
    </section>
  );
}
function KV({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2">
      <div className="text-[10px] font-extrabold uppercase text-slate-400">{label}</div>
      <div className="mt-0.5 text-sm font-bold text-slate-800">{value}</div>
    </div>
  );
}
