import { useState } from "react";
import { Boxes, ShieldX, ShieldCheck, AlertOctagon } from "lucide-react";
import { Drawer, PrintDocument } from "@/shared/ui";
import { Button } from "@/shared/ui";
import { StatusBadge } from "@/shared/ui";
import { LoadingState, ErrorState } from "@/shared/ui";
import { ApiError } from "@/shared/api";
import { useT } from "@/i18n";
import type { TFunction } from "@/i18n";
import { useCan } from "@/modules/inventory/lib/permission-provider";
import { formatQty, formatDate } from "@/shared/lib";
import { lotStatusToLabel, expiryClassToLabel } from "@/modules/inventory/lib/status-labels";
import { useLotDetail, useLotMovements, useLotTrace, useLotMutations } from "@/modules/inventory/lib/hooks/useLots";
import { ReasonDialog } from "@/modules/inventory/features/_shared/ReasonDialog";

const TAB_IDS = ["basics", "warehouses", "trace", "movements"] as const;
type TabId = (typeof TAB_IDS)[number];

function refLabel(t: TFunction, ref: string | null): string {
  if (!ref) return "—";
  const base = ref.replace(/_reverse$/, "");
  const key = `inventoryRest.lots.ref.${base}`;
  const label = t(key);
  const resolved = label === key ? ref : label;
  return resolved + (/_reverse$/.test(ref) ? t("inventoryRest.lots.ref.reverseSuffix") : "");
}

export function LotDetailDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const t = useT();
  const q = useLotDetail(id);
  const trace = useLotTrace(id);
  const mv = useLotMovements(id);
  const m = useLotMutations();
  const canQ = useCan("lot.quarantine");
  const canR = useCan("lot.recall");
  const [tab, setTab] = useState<TabId>("basics");
  const [err, setErr] = useState<string | null>(null);
  const d = q.data?.lot;
  const busy = m.quarantine.isPending || m.release.isPending || m.recall.isPending;

  const TABS: { id: TabId; label: string }[] = [
    { id: "basics", label: t("inventoryRest.lots.detail.tabBasics") },
    { id: "warehouses", label: t("inventoryRest.lots.detail.tabWarehouses") },
    { id: "trace", label: t("inventoryRest.lots.detail.tabTrace") },
    { id: "movements", label: t("inventoryRest.lots.detail.tabMovements") },
  ];

  const [pendingAct, setPendingAct] = useState<null | "quarantine" | "release" | "recall">(null);
  const ACT_META = {
    quarantine: { title: t("inventoryRest.lots.detail.quarantineTitle"), desc: t("inventoryRest.lots.detail.quarantineDesc"), label: t("inventoryRest.lots.detail.quarantine") },
    release: { title: t("inventoryRest.lots.detail.releaseTitle"), desc: t("inventoryRest.lots.detail.releaseDesc"), label: t("inventoryRest.lots.detail.release") },
    recall: { title: t("inventoryRest.lots.detail.recallTitle"), desc: t("inventoryRest.lots.detail.recallDesc"), label: t("inventoryRest.lots.detail.recall") },
  } as const;
  function confirmAct(kind: "quarantine" | "release" | "recall", reason: string) {
    if (!d) return;
    setErr(null);
    m[kind].mutate({ id: d.id, reason, expectedVersion: d.version }, {
      onSuccess: () => { setPendingAct(null); q.refetch(); trace.refetch(); },
      onError: (e) => { setPendingAct(null); setErr(e instanceof ApiError ? (e.isConflict ? t("inventoryRest.lots.detail.conflict") : e.message) : t("inventoryRest.lots.detail.actionFailed")); },
    });
  }
  function act(kind: "quarantine" | "release" | "recall") { setPendingAct(kind); }

  return (
    <Drawer open={!!id} onClose={onClose} title={d ? t("inventoryRest.lots.detail.title", { lot: d.lotNumber }) : t("inventoryRest.lots.detail.fallbackTitle")} eyebrow={t("inventoryRest.lots.detail.eyebrow")} icon={Boxes}>
      {!d ? (q.isLoading ? <LoadingState rows={3} /> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : null) : (
        // The DRAWER chrome (title bar, close button, the page behind it) is
        // not part of the lot card. Wrapping the body puts only the card on
        // paper, with the lot number on it.
        <PrintDocument overlay title={t("inventoryRest.lots.detail.title", { lot: d.lotNumber })}>
          <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge>{lotStatusToLabel(d.lifecycleStatus)}</StatusBadge>
            <StatusBadge>{expiryClassToLabel(d.expiryClass)}</StatusBadge>
            <span className="text-xs font-bold text-slate-400">{t("inventoryRest.ui.version")} {d.version}</span>
            {d.isImported && <span className="text-xs font-bold text-amber-600">{t("inventoryRest.lots.detail.imported")}</span>}
          </div>
          {err && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm font-bold text-rose-700">{err}</p>}

          <div className="flex flex-wrap gap-1 border-b border-slate-100 pb-2">
            {TABS.map((tabDef) => (
              <button key={tabDef.id} type="button" onClick={() => setTab(tabDef.id)}
                className={`rounded-lg px-3 py-1.5 text-xs font-extrabold transition ${tab === tabDef.id ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-100"}`}>{tabDef.label}</button>
            ))}
          </div>

          {tab === "basics" && (
            <div className="grid grid-cols-2 gap-3 text-sm">
              <F k={t("inventoryRest.lots.detail.lotNumber")} v={d.lotNumber} /><F k={t("inventoryRest.lots.detail.item")} v={d.itemName} />
              <F k={t("inventoryRest.lots.detail.expiryDate")} v={d.expiryDate || "—"} /><F k={t("inventoryRest.lots.detail.daysLeft")} v={d.daysToExpiry == null ? "—" : String(d.daysToExpiry)} />
              <F k={t("inventoryRest.lots.detail.manufactureDate")} v={d.manufactureDate || "—"} /><F k={t("inventoryRest.lots.detail.totalQty")} v={formatQty(d.totalQty)} />
              <F k={t("inventoryRest.lots.detail.source")} v={refLabel(t, d.sourceType)} /><F k={t("inventoryRest.lots.detail.sourceRef")} v={d.sourceId || "—"} />
              {d.notes && <F k={t("inventoryRest.lots.detail.notes")} v={d.notes} full />}
            </div>
          )}

          {tab === "warehouses" && (
            <div className="space-y-1">
              {q.data?.distribution.length === 0 ? <p className="text-sm text-slate-400">{t("inventoryRest.lots.detail.noWarehouseQty")}</p> : q.data?.distribution.map((w) => (
                <div key={w.warehouseId} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-sm">
                  <span className="font-bold text-slate-700">{w.warehouseName}</span><span className="tabular-nums text-slate-600">{formatQty(w.qty)}</span>
                </div>
              ))}
            </div>
          )}

          {tab === "trace" && (
            trace.isLoading ? <LoadingState rows={2} /> : (
              <div className="space-y-4">
                {trace.data && trace.data.recallImpact.length > 0 && (
                  <div className="rounded-xl border border-rose-100 bg-rose-50/60 p-3 text-xs text-rose-900">
                    <div className="mb-1 font-extrabold">{t("inventoryRest.lots.detail.recallImpactTitle")}</div>
                    <ul className="list-disc space-y-0.5 ps-5">{trace.data.recallImpact.map((r, i) => <li key={i}>{refLabel(t, r.referenceType)} {r.referenceId || ""} — {formatQty(r.qty)}</li>)}</ul>
                  </div>
                )}
                <ol className="space-y-2">
                  {(trace.data?.timeline ?? []).map((e, i) => (
                    <li key={i} className="flex items-start gap-2 text-xs">
                      <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${e.signedQty >= 0 ? "bg-emerald-500" : "bg-sky-500"}`} />
                      <div>
                        <span className="font-bold text-slate-700">{refLabel(t, e.referenceType)} · {e.warehouseName}</span>
                        <span className={`font-extrabold ${e.signedQty >= 0 ? "text-emerald-700" : "text-sky-700"}`}> {e.signedQty >= 0 ? "+" : "−"}{formatQty(Math.abs(e.signedQty))}</span>
                        <span className="text-slate-400"> · {e.actor || "—"} · {formatDate(e.at)}</span>
                      </div>
                    </li>
                  ))}
                  {(trace.data?.timeline ?? []).length === 0 && <p className="text-sm text-slate-400">{t("inventoryRest.lots.detail.traceEmpty")}</p>}
                </ol>
              </div>
            )
          )}

          {tab === "movements" && (
            mv.isLoading ? <LoadingState rows={2} /> : (
              <div className="space-y-1">
                {(mv.data ?? []).length === 0 ? <p className="text-sm text-slate-400">{t("inventoryRest.lots.detail.movementsEmpty")}</p> : (mv.data ?? []).map((r) => (
                  <div key={r.id} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-1.5 text-xs">
                    <span>{refLabel(t, r.referenceType)} · {r.warehouseName} · {formatDate(r.occurredAt)}</span>
                    <span className={`font-bold ${r.signedQty >= 0 ? "text-emerald-700" : "text-sky-700"}`}>{r.signedQty >= 0 ? "+" : "−"}{formatQty(Math.abs(r.signedQty))}</span>
                  </div>
                ))}
              </div>
            )
          )}

          <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-4">
            {canQ && d.lifecycleStatus === "active" && <Button variant="secondary" size="sm" disabled={busy} onClick={() => act("quarantine")}><ShieldX className="h-4 w-4" /> {t("inventoryRest.lots.detail.quarantine")}</Button>}
            {canQ && d.lifecycleStatus === "quarantined" && <Button variant="primary" size="sm" disabled={busy} onClick={() => act("release")}><ShieldCheck className="h-4 w-4" /> {t("inventoryRest.lots.detail.release")}</Button>}
            {canR && (d.lifecycleStatus === "active" || d.lifecycleStatus === "quarantined") && <Button variant="danger" size="sm" disabled={busy} onClick={() => act("recall")}><AlertOctagon className="h-4 w-4" /> {t("inventoryRest.lots.detail.recall")}</Button>}
            <Button variant="ghost" size="sm" onClick={() => window.print()}>{t("inventoryRest.lots.detail.printCard")}</Button>
          </div>

          <ReasonDialog
            open={!!pendingAct}
            title={pendingAct ? ACT_META[pendingAct].title : ""}
            description={pendingAct ? ACT_META[pendingAct].desc : undefined}
            confirmLabel={pendingAct ? ACT_META[pendingAct].label : t("common.confirm")}
            tone={pendingAct === "recall" ? "danger" : "primary"}
            pending={busy}
            error={null}
            onConfirm={(reason) => pendingAct && confirmAct(pendingAct, reason)}
            onClose={() => setPendingAct(null)}
          />
        </div>
        </PrintDocument>
      )}
    </Drawer>
  );
}

function F({ k, v, full }: { k: string; v: string; full?: boolean }) {
  return <div className={full ? "col-span-2" : ""}><div className="text-[10px] font-bold text-slate-400">{k}</div><div className="mt-0.5 font-bold text-slate-700">{v}</div></div>;
}
