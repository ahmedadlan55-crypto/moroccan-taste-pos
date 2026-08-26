import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { ArrowRight, Search, Send, WifiOff, CloudOff, Check, Loader2 } from "lucide-react";
import { PageHeader } from "@/shared/ui";
import { Button } from "@/shared/ui";
import { Progress } from "@/shared/ui";
import { MetricCard } from "@/modules/inventory/lib/MetricCard";
import { LoadingState, ErrorState } from "@/shared/ui";
import { ApiError } from "@/shared/api";
import { formatQty, formatNumber } from "@/shared/lib";
import { useT } from "@/i18n";
import { useStocktakeDetail, useStocktakeMutations } from "@/modules/inventory/lib/hooks/useStocktakes";
import type { StocktakeLine } from "@/modules/inventory/lib/adapters/stocktake.adapter";

type Edit = { countedQty: number | null; notes: string; observedSeq?: number };
const AUTOSAVE_MS = 700;

export function CountingWorkspace() {
  const t = useT();
  const [csp] = useSearchParams();
  const id = csp.get("count") ?? "";
  const navigate = useNavigate();
  const q = useStocktakeDetail(id);
  const m = useStocktakeMutations();
  const d = q.data;

  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [search, setSearch] = useState("");
  const [online, setOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "offline" | "conflict">("idle");
  const [staleItems, setStaleItems] = useState<string[]>([]); // items flagged by the server for recount
  const editsRef = useRef(edits); editsRef.current = edits;
  // The movement high-water-mark the device last knew — stamped onto each edit so a
  // count taken offline (then synced after later movements) is flagged for recount.
  const seenSeqRef = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bufKey = `stk-counts-${id}`;
  if (d && d.currentSeq > seenSeqRef.current) seenSeqRef.current = d.currentSeq;

  // Restore any buffered (e.g. offline) edits for this stocktake on mount.
  useEffect(() => {
    try { const raw = localStorage.getItem(bufKey); if (raw) setEdits(JSON.parse(raw)); } catch { /* ignore */ }
  }, [bufKey]);

  // Online/offline awareness — block flush + approve/submit while offline.
  useEffect(() => {
    const on = () => setOnline(true); const off = () => { setOnline(false); setSaveState("offline"); };
    window.addEventListener("online", on); window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);

  function flush() {
    const pend = editsRef.current;
    const keys = Object.keys(pend);
    if (keys.length === 0) return;
    if (!online) { setSaveState("offline"); return; }
    setSaveState("saving");
    const counts = keys.map((itemId) => ({ itemId, countedQty: pend[itemId].countedQty, notes: pend[itemId].notes || undefined, observedSeq: pend[itemId].observedSeq }));
    m.saveCounts.mutate({ id, counts }, {
      onSuccess: (res) => {
        const conflicts = Array.isArray(res?.conflicts) ? res.conflicts : [];
        const conflictIds = new Set(conflicts.map((c) => c.itemId));
        // Clear what was APPLIED; keep server-rejected (stale) lines pending so the
        // counter re-counts them. An edit made during the request also stays.
        setEdits((cur) => {
          const next: Record<string, Edit> = {};
          for (const k of Object.keys(cur)) if (!keys.includes(k) || conflictIds.has(k)) next[k] = cur[k];
          try { Object.keys(next).length ? localStorage.setItem(bufKey, JSON.stringify(next)) : localStorage.removeItem(bufKey); } catch { /* ignore */ }
          return next;
        });
        setStaleItems(conflicts.map((c) => c.itemId));
        setSaveState(conflicts.length ? "conflict" : "saved");
        q.refetch();
      },
      onError: (e) => {
        if (e instanceof ApiError && (e.isConflict || e.status === 409)) { setSaveState("conflict"); q.refetch(); }
        else { setSaveState("offline"); } // keep buffer for retry
      },
    });
  }

  function setEdit(itemId: string, patch: Partial<Edit>, base: StocktakeLine) {
    setEdits((cur) => {
      const prev = cur[itemId] ?? { countedQty: base.countedQty, notes: base.notes ?? "" };
      // Stamp the movement seq the device sees AT COUNT TIME. If this count is later
      // synced after other movements landed, the server flags it for recount.
      const next = { ...cur, [itemId]: { ...prev, ...patch, observedSeq: seenSeqRef.current } };
      try { localStorage.setItem(bufKey, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
    setStaleItems((s) => s.filter((x) => x !== itemId));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, AUTOSAVE_MS);
  }

  const lines = d?.lines ?? [];
  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return lines;
    return lines.filter((l) => l.item.name.toLowerCase().includes(s) || l.item.id.toLowerCase().includes(s));
  }, [lines, search]);

  // Merge server lines with local edits for display + progress.
  function val(l: StocktakeLine): number | null { return l.item.id in edits ? edits[l.item.id].countedQty : l.countedQty; }
  const countedN = lines.filter((l) => val(l) !== null).length;
  const varianceN = lines.filter((l) => { const v = val(l); return v !== null && Math.abs(v - l.theoreticalQty) > 0.0001; }).length;
  const progress = lines.length ? Math.round((countedN / lines.length) * 100) : 0;

  if (q.isLoading) return <div className="p-4"><LoadingState rows={4} /></div>;
  if (q.isError) return <div className="p-4"><ErrorState error={q.error} onRetry={() => q.refetch()} /></div>;
  if (!d) return null;
  if (d.status !== "counting") {
    return (
      <div className="p-4">
        <PageHeader eyebrow={t("inventoryRest.stocktakes.counting.eyebrow")} title={t("inventoryRest.stocktakes.counting.notCountingTitle", { number: d.number })} subtitle={t("inventoryRest.stocktakes.counting.notCountingSubtitle")} action={<Button variant="ghost" onClick={() => navigate(`/inventory/stocktakes?view=${d.id}`)}>{t("inventoryRest.stocktakes.counting.back")}</Button>} />
        <div className="surface p-8 text-center text-sm text-slate-500">{t("inventoryRest.stocktakes.counting.notCountingBody", { status: d.status })}</div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader eyebrow={t("inventoryRest.stocktakes.counting.eyebrow")} title={t("inventoryRest.stocktakes.counting.workspaceTitle", { number: d.number })} subtitle={`${d.warehouse.name}${d.blindCount ? t("inventoryRest.stocktakes.counting.blindSuffix") : ""}`}
        action={<div className="flex items-center gap-2"><SaveBadge state={saveState} online={online} />
          <Button variant="ghost" onClick={() => navigate(`/inventory/stocktakes?view=${d.id}`)}>{t("inventoryRest.stocktakes.counting.finish")}</Button></div>} />

      {!online && (
        <div className="mb-4 flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm font-bold text-amber-800">
          <WifiOff className="h-4 w-4" /> {t("inventoryRest.stocktakes.counting.offlineBanner")}
        </div>
      )}
      {staleItems.length > 0 && (
        <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-sm font-bold text-rose-700">
          {t("inventoryRest.stocktakes.counting.staleBanner", { count: formatNumber(staleItems.length) })}
        </div>
      )}
      {saveState === "conflict" && staleItems.length === 0 && (
        <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-sm font-bold text-rose-700">{t("inventoryRest.stocktakes.counting.conflictBanner")}</div>
      )}

      <section className="grid gap-4 sm:grid-cols-3">
        <MetricCard label={t("inventoryRest.stocktakes.counting.counted")} value={`${formatNumber(countedN)} / ${formatNumber(lines.length)}`} note={t("inventoryRest.stocktakes.counting.countedNote")} icon={Check} tone="teal" />
        <MetricCard label={t("inventoryRest.stocktakes.counting.remaining")} value={formatNumber(lines.length - countedN)} note={t("inventoryRest.stocktakes.counting.remainingNote")} icon={CloudOff} tone="amber" />
        <MetricCard label={t("inventoryRest.stocktakes.counting.variance")} value={formatNumber(varianceN)} note={t("inventoryRest.stocktakes.counting.varianceNote")} icon={Send} tone="rose" />
      </section>
      <div className="mt-3"><Progress value={progress} tone={progress === 100 ? "teal" : "amber"} /></div>

      <section className="surface mt-4 p-4">
        <label className="relative mb-3 block">
          <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input className="field w-full ps-10" placeholder={t("inventoryRest.stocktakes.counting.searchPlaceholder")} value={search} onChange={(e) => setSearch(e.target.value)} aria-label={t("inventoryRest.invtx.list.searchAria")} />
        </label>

        {/* Desktop table */}
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full text-sm">
            <thead className="text-xs text-slate-400"><tr>
              <th className="py-2 text-start">{t("inventoryRest.stocktakes.counting.colItem")}</th>{!d.blindCount && <th>{t("inventoryRest.stocktakes.counting.colTheoretical")}</th>}<th>{t("inventoryRest.stocktakes.counting.colCounted")}</th><th>{t("inventoryRest.stocktakes.counting.colDelta")}</th><th>{t("inventoryRest.stocktakes.counting.colNote")}</th>
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((l) => <Row key={l.id} l={l} blind={d.blindCount} value={val(l)} notes={l.item.id in edits ? edits[l.item.id].notes : (l.notes ?? "")} onChange={setEdit} />)}
            </tbody>
          </table>
        </div>

        {/* Mobile cards */}
        <div className="space-y-3 md:hidden">
          {filtered.map((l) => {
            const v = val(l); const delta = v === null ? null : v - l.theoreticalQty;
            return (
              <div key={l.id} className="rounded-xl border border-slate-100 p-3">
                <div className="mb-2 flex items-center justify-between"><span className="font-bold text-slate-800">{l.item.name}</span>{!d.blindCount && <span className="text-xs text-slate-400">{t("inventoryRest.stocktakes.counting.theoreticalShort", { qty: formatQty(l.theoreticalQty) })}</span>}</div>
                <div className="flex items-center gap-2">
                  <input type="number" min={0} step="any" inputMode="decimal" className="field w-28 text-center" value={v ?? ""} onChange={(e) => setEdit(l.item.id, { countedQty: e.target.value === "" ? null : Number(e.target.value) }, l)} aria-label={t("inventoryRest.stocktakes.counting.countAria", { name: l.item.name })} />
                  {delta !== null && <span className={`text-sm font-extrabold tabular-nums ${delta < 0 ? "text-rose-600" : delta > 0 ? "text-emerald-600" : "text-slate-400"}`}>{delta > 0 ? "+" : ""}{formatQty(delta)}</span>}
                </div>
                <input className="field mt-2 w-full text-xs" placeholder={t("inventoryRest.stocktakes.counting.notePlaceholder")} value={l.item.id in edits ? edits[l.item.id].notes : (l.notes ?? "")} onChange={(e) => setEdit(l.item.id, { notes: e.target.value }, l)} aria-label={t("inventoryRest.stocktakes.counting.noteAria")} />
              </div>
            );
          })}
        </div>
      </section>

      <div className="mt-4 flex justify-end">
        <Button variant="primary" disabled={!online || m.submit.isPending} onClick={() => { flush(); m.submit.mutate({ id: d.id, expectedVersion: d.version }, { onSuccess: () => navigate(`/inventory/stocktakes?view=${d.id}`), onError: () => q.refetch() }); }}>
          <Send className="h-4 w-4" /> {t("inventoryRest.stocktakes.counting.submitForApproval")} <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function Row({ l, blind, value, notes, onChange }: { l: StocktakeLine; blind: boolean; value: number | null; notes: string; onChange: (id: string, p: Partial<Edit>, base: StocktakeLine) => void }) {
  const t = useT();
  const delta = value === null ? null : value - l.theoreticalQty;
  return (
    <tr>
      <td className="py-2 font-bold text-slate-700">{l.item.name}<span className="mr-2 text-[10px] font-normal text-slate-400">{l.item.id}</span></td>
      {!blind && <td className="text-center tabular-nums text-slate-500">{formatQty(l.theoreticalQty)}</td>}
      <td className="text-center"><input type="number" min={0} step="any" inputMode="decimal" className="field w-24 text-center" value={value ?? ""} onChange={(e) => onChange(l.item.id, { countedQty: e.target.value === "" ? null : Number(e.target.value) }, l)} aria-label={t("inventoryRest.stocktakes.counting.countAria", { name: l.item.name })} /></td>
      <td className={`text-center font-extrabold tabular-nums ${delta === null ? "text-slate-300" : delta < 0 ? "text-rose-600" : delta > 0 ? "text-emerald-600" : "text-slate-400"}`}>{delta === null ? "—" : `${delta > 0 ? "+" : ""}${formatQty(delta)}`}</td>
      <td><input className="field w-full text-xs" placeholder={t("inventoryRest.stocktakes.counting.notePlaceholder")} value={notes} onChange={(e) => onChange(l.item.id, { notes: e.target.value }, l)} aria-label={t("inventoryRest.stocktakes.counting.noteAria")} /></td>
    </tr>
  );
}

function SaveBadge({ state, online }: { state: string; online: boolean }) {
  const t = useT();
  if (!online) return <span className="flex items-center gap-1 text-xs font-bold text-amber-700"><WifiOff className="h-3.5 w-3.5" /> {t("inventoryRest.stocktakes.counting.saveOffline")}</span>;
  if (state === "saving") return <span className="flex items-center gap-1 text-xs font-bold text-slate-500"><Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("inventoryRest.stocktakes.counting.saveSaving")}</span>;
  if (state === "saved") return <span className="flex items-center gap-1 text-xs font-bold text-emerald-600"><Check className="h-3.5 w-3.5" /> {t("inventoryRest.stocktakes.counting.saveSaved")}</span>;
  if (state === "conflict") return <span className="text-xs font-bold text-rose-600">{t("inventoryRest.stocktakes.counting.saveConflict")}</span>;
  return null;
}
