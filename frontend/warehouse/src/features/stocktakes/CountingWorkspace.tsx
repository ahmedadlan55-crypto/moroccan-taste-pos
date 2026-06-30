import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowRight, Search, Send, WifiOff, CloudOff, Check, Loader2 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/Progress";
import { MetricCard } from "@/components/metric-card/MetricCard";
import { LoadingState, ErrorState } from "@/components/states/States";
import { ApiError } from "@/lib/api-error";
import { formatQty, formatNumber } from "@/lib/formatters";
import { useStocktakeDetail, useStocktakeMutations } from "@/lib/hooks/useStocktakes";
import type { StocktakeLine } from "@/lib/adapters/stocktake.adapter";

type Edit = { countedQty: number | null; notes: string; observedSeq?: number };
const AUTOSAVE_MS = 700;

export function CountingWorkspace() {
  const { id = "" } = useParams();
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
        <PageHeader eyebrow="الجرد" title={`العد — ${d.number}`} subtitle="هذا المحضر ليس في حالة العد." action={<Button variant="ghost" onClick={() => navigate(`/stocktakes?view=${d.id}`)}>عودة</Button>} />
        <div className="surface p-8 text-center text-sm text-slate-500">حالة المحضر «{d.status}» — لا يمكن العد إلا أثناء «قيد العد».</div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader eyebrow="الجرد" title={`ورشة العد — ${d.number}`} subtitle={`${d.warehouse.name}${d.blindCount ? " · عدّ أعمى" : ""}`}
        action={<div className="flex items-center gap-2"><SaveBadge state={saveState} online={online} />
          <Button variant="ghost" onClick={() => navigate(`/stocktakes?view=${d.id}`)}>إنهاء</Button></div>} />

      {!online && (
        <div className="mb-4 flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm font-bold text-amber-800">
          <WifiOff className="h-4 w-4" /> أنت غير متصل — يُحفظ العد محليًا ويُرسل تلقائيًا عند عودة الاتصال. لا يمكن التقديم دون اتصال.
        </div>
      )}
      {staleItems.length > 0 && (
        <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-sm font-bold text-rose-700">
          حدثت حركات على {formatNumber(staleItems.length)} صنف منذ عدّه دون اتصال — لم يُحفَظ العد. أعد عدّ الأصناف المظلّلة ثم احفظ.
        </div>
      )}
      {saveState === "conflict" && staleItems.length === 0 && (
        <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-sm font-bold text-rose-700">تغيّرت حالة المحضر (ربما طُلبت إعادة عد أو قُدّم) — أُعيد التحميل. تحقق ثم تابع.</div>
      )}

      <section className="grid gap-4 sm:grid-cols-3">
        <MetricCard label="المعدود" value={`${formatNumber(countedN)} / ${formatNumber(lines.length)}`} note="أصناف عُدّت" icon={Check} tone="teal" />
        <MetricCard label="المتبقّي" value={formatNumber(lines.length - countedN)} note="لم يُعدّ بعد" icon={CloudOff} tone="amber" />
        <MetricCard label="فروقات مرصودة" value={formatNumber(varianceN)} note="تختلف عن النظري" icon={Send} tone="rose" />
      </section>
      <div className="mt-3"><Progress value={progress} tone={progress === 100 ? "teal" : "amber"} /></div>

      <section className="surface mt-4 p-4">
        <label className="relative mb-3 block">
          <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input className="field w-full pr-10" placeholder="بحث بالاسم أو الرمز (SKU)…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="بحث" />
        </label>

        {/* Desktop table */}
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full text-sm">
            <thead className="text-xs text-slate-400"><tr>
              <th className="py-2 text-right">الصنف</th>{!d.blindCount && <th>النظري</th>}<th>المعدود</th><th>الفرق</th><th>ملاحظة</th>
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
                <div className="mb-2 flex items-center justify-between"><span className="font-bold text-slate-800">{l.item.name}</span>{!d.blindCount && <span className="text-xs text-slate-400">النظري {formatQty(l.theoreticalQty)}</span>}</div>
                <div className="flex items-center gap-2">
                  <input type="number" min={0} step="any" inputMode="decimal" className="field w-28 text-center" value={v ?? ""} onChange={(e) => setEdit(l.item.id, { countedQty: e.target.value === "" ? null : Number(e.target.value) }, l)} aria-label={`عدّ ${l.item.name}`} />
                  {delta !== null && <span className={`text-sm font-extrabold tabular-nums ${delta < 0 ? "text-rose-600" : delta > 0 ? "text-emerald-600" : "text-slate-400"}`}>{delta > 0 ? "+" : ""}{formatQty(delta)}</span>}
                </div>
                <input className="field mt-2 w-full text-xs" placeholder="ملاحظة" value={l.item.id in edits ? edits[l.item.id].notes : (l.notes ?? "")} onChange={(e) => setEdit(l.item.id, { notes: e.target.value }, l)} aria-label="ملاحظة" />
              </div>
            );
          })}
        </div>
      </section>

      <div className="mt-4 flex justify-end">
        <Button variant="primary" disabled={!online || m.submit.isPending} onClick={() => { flush(); m.submit.mutate({ id: d.id, expectedVersion: d.version }, { onSuccess: () => navigate(`/stocktakes?view=${d.id}`), onError: () => q.refetch() }); }}>
          <Send className="h-4 w-4" /> تقديم للاعتماد <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function Row({ l, blind, value, notes, onChange }: { l: StocktakeLine; blind: boolean; value: number | null; notes: string; onChange: (id: string, p: Partial<Edit>, base: StocktakeLine) => void }) {
  const delta = value === null ? null : value - l.theoreticalQty;
  return (
    <tr>
      <td className="py-2 font-bold text-slate-700">{l.item.name}<span className="mr-2 text-[10px] font-normal text-slate-400">{l.item.id}</span></td>
      {!blind && <td className="text-center tabular-nums text-slate-500">{formatQty(l.theoreticalQty)}</td>}
      <td className="text-center"><input type="number" min={0} step="any" inputMode="decimal" className="field w-24 text-center" value={value ?? ""} onChange={(e) => onChange(l.item.id, { countedQty: e.target.value === "" ? null : Number(e.target.value) }, l)} aria-label={`عدّ ${l.item.name}`} /></td>
      <td className={`text-center font-extrabold tabular-nums ${delta === null ? "text-slate-300" : delta < 0 ? "text-rose-600" : delta > 0 ? "text-emerald-600" : "text-slate-400"}`}>{delta === null ? "—" : `${delta > 0 ? "+" : ""}${formatQty(delta)}`}</td>
      <td><input className="field w-full text-xs" placeholder="ملاحظة" value={notes} onChange={(e) => onChange(l.item.id, { notes: e.target.value }, l)} aria-label="ملاحظة" /></td>
    </tr>
  );
}

function SaveBadge({ state, online }: { state: string; online: boolean }) {
  if (!online) return <span className="flex items-center gap-1 text-xs font-bold text-amber-700"><WifiOff className="h-3.5 w-3.5" /> غير متصل</span>;
  if (state === "saving") return <span className="flex items-center gap-1 text-xs font-bold text-slate-500"><Loader2 className="h-3.5 w-3.5 animate-spin" /> حفظ…</span>;
  if (state === "saved") return <span className="flex items-center gap-1 text-xs font-bold text-emerald-600"><Check className="h-3.5 w-3.5" /> محفوظ</span>;
  if (state === "conflict") return <span className="text-xs font-bold text-rose-600">تعارض</span>;
  return null;
}
