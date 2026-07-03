import { useEffect, useMemo, useRef, useState } from "react";
import { Barcode, CheckCircle2, Plus, Printer, ScanLine, Star, Trash2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCan } from "@/app/permission-provider";
import { useItemMutations, lookupBarcode, type BarcodeLookupResult } from "@/lib/hooks/useItems";
import type { ItemDetail } from "@/lib/adapters/item.adapter";
import { ApiError } from "@/lib/api-error";
import { code39Svg, printBarcodeLabels } from "./barcodeLabel";

interface Row { code: string; sizeVariant: string; isPrimary: boolean }

// Phase W4 — barcode management inside Item Details: primary + secondary codes
// with size variants, scan-to-add, a live scan tester, explicit 409 conflict
// display (BARCODE_TAKEN), and Code39 label printing.
export function BarcodesTab({ detail, onSaved }: { detail: ItemDetail; onSaved: () => void }) {
  const m = useItemMutations();
  const canManage = useCan("barcode.manage");
  const [rows, setRows] = useState<Row[]>([]);
  const [dirty, setDirty] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const addRef = useRef<HTMLInputElement>(null);
  const [addCode, setAddCode] = useState("");
  const [addVariant, setAddVariant] = useState("");

  useEffect(() => {
    const init: Row[] = [];
    if (detail.barcode) init.push({ code: detail.barcode, sizeVariant: "", isPrimary: true });
    for (const b of detail.barcodes) init.push({ code: b.code, sizeVariant: b.sizeVariant ?? "", isPrimary: false });
    setRows(init);
    setDirty(false); setErr(null); setSaved(false);
  }, [detail.id, detail.version, detail.barcode, detail.barcodes]);

  const normalized = useMemo(() => rows.map((r) => ({ ...r, norm: r.code.trim().toUpperCase().replace(/\s+/g, "") })), [rows]);
  const localDup = useMemo(() => {
    const seen = new Set<string>();
    for (const r of normalized) {
      if (!r.norm) continue;
      if (seen.has(r.norm)) return r.code;
      seen.add(r.norm);
    }
    return null;
  }, [normalized]);

  function addRow() {
    const code = addCode.trim();
    if (!code) return;
    setRows((rs) => [...rs, { code, sizeVariant: addVariant.trim(), isPrimary: rs.length === 0 }]);
    setAddCode(""); setAddVariant(""); setDirty(true); setSaved(false);
    addRef.current?.focus();
  }
  function removeRow(i: number) {
    setRows((rs) => {
      const next = rs.filter((_, idx) => idx !== i);
      if (rs[i]?.isPrimary && next.length) next[0] = { ...next[0], isPrimary: true };
      return next;
    });
    setDirty(true); setSaved(false);
  }
  function setPrimary(i: number) {
    setRows((rs) => rs.map((r, idx) => ({ ...r, isPrimary: idx === i })));
    setDirty(true); setSaved(false);
  }

  function save() {
    setErr(null); setSaved(false);
    if (localDup) { setErr(`باركود مكرر ضمن القائمة: ${localDup}`); return; }
    const primary = rows.find((r) => r.isPrimary)?.code.trim() ?? null;
    const secondaries = rows.filter((r) => !r.isPrimary && r.code.trim()).map((r) => ({ code: r.code.trim(), sizeVariant: r.sizeVariant.trim() || null }));
    m.saveBarcodes.mutate(
      { id: detail.id, primaryBarcode: primary, barcodes: secondaries, expectedVersion: detail.version },
      {
        onSuccess: () => { setSaved(true); setDirty(false); onSaved(); },
        onError: (e) => {
          if (e instanceof ApiError && e.code === "BARCODE_TAKEN") setErr(`تعارض 409: ${e.message} — الباركود مستخدم لصنف آخر.`);
          else if (e instanceof ApiError && e.isConflict) { setErr("تغيّر الصنف منذ آخر تحميل — أُعيد التحميل، حاول مجددًا."); onSaved(); }
          else setErr(e instanceof ApiError ? e.message : "تعذّر حفظ الباركودات.");
        },
      },
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {rows.length === 0 && <p className="rounded-lg border border-dashed border-slate-200 p-4 text-center text-sm text-slate-400">لا باركودات لهذا الصنف — أضف الأول أدناه.</p>}
        {rows.map((r, i) => {
          const svg = code39Svg(r.code, { height: 28, moduleWidth: 1 });
          return (
            <div key={i} className={`flex flex-wrap items-center gap-2 rounded-xl border p-2.5 ${r.isPrimary ? "border-teal-300 bg-teal-50/50" : "border-slate-200 bg-white"}`}>
              <button type="button" title={r.isPrimary ? "الباركود الأساسي" : "تعيين كأساسي"} aria-label={r.isPrimary ? "الأساسي" : `تعيين ${r.code} كأساسي`}
                onClick={() => canManage && setPrimary(i)} disabled={!canManage}
                className={`grid h-8 w-8 place-items-center rounded-lg ${r.isPrimary ? "bg-teal-600 text-white" : "bg-slate-100 text-slate-400 hover:bg-slate-200"}`}>
                <Star className="h-4 w-4" />
              </button>
              <span className="font-mono text-sm font-bold text-slate-800" dir="ltr">{r.code}</span>
              {r.sizeVariant && <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-500">{r.sizeVariant}</span>}
              {r.isPrimary && <span className="rounded-md bg-teal-100 px-1.5 py-0.5 text-[10px] font-bold text-teal-700">أساسي</span>}
              <span className="mr-auto hidden sm:block" dangerouslySetInnerHTML={svg ? { __html: svg } : undefined} />
              {canManage && (
                <Button variant="ghost" size="icon" aria-label={`حذف ${r.code}`} onClick={() => removeRow(i)}>
                  <Trash2 className="h-4 w-4 text-rose-500" />
                </Button>
              )}
            </div>
          );
        })}
      </div>

      {canManage && (
        <div className="flex flex-wrap items-end gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
          <label className="block flex-1 text-xs font-bold text-slate-500">باركود جديد (امسح أو اكتب)
            <input ref={addRef} className="field mt-1 w-full font-mono" dir="ltr" value={addCode}
              onChange={(e) => setAddCode(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addRow(); } }}
              placeholder="612345678901" aria-label="باركود جديد" />
          </label>
          <label className="block w-36 text-xs font-bold text-slate-500">حجم/متغير (اختياري)
            <input className="field mt-1 w-full" value={addVariant} onChange={(e) => setAddVariant(e.target.value)} placeholder="عبوة 500مل" aria-label="متغير الحجم" />
          </label>
          <Button variant="secondary" size="sm" onClick={addRow} disabled={!addCode.trim()}><Plus className="h-4 w-4" /> إضافة</Button>
        </div>
      )}

      {err && <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">{err}</p>}
      {saved && <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700"><CheckCircle2 className="ml-1 inline h-4 w-4" /> حُفظت الباركودات.</p>}

      <div className="flex flex-wrap justify-between gap-2">
        <Button variant="ghost" size="sm" disabled={rows.length === 0}
          onClick={() => printBarcodeLabels(rows.map((r) => ({ itemName: detail.name, sku: detail.sku, code: r.code, sizeVariant: r.sizeVariant || null })))}>
          <Printer className="h-4 w-4" /> طباعة ملصقات
        </Button>
        {canManage && (
          <Button variant="primary" size="sm" disabled={!dirty || m.saveBarcodes.isPending || !!localDup} onClick={save}>
            {m.saveBarcodes.isPending ? "جارٍ الحفظ…" : "حفظ الباركودات"}
          </Button>
        )}
      </div>
      {localDup && <p className="text-xs font-bold text-amber-600">باركود مكرر ضمن القائمة: {localDup}</p>}

      <ScanTester currentItemId={detail.id} />
    </div>
  );
}

// Live scan tester: scan any code and see instantly which item it resolves to.
function ScanTester({ currentItemId }: { currentItemId: string }) {
  const [code, setCode] = useState("");
  const [result, setResult] = useState<BarcodeLookupResult | null | "pending" | "error">(null);
  const [tested, setTested] = useState("");

  async function test() {
    const c = code.trim();
    if (!c) return;
    setResult("pending"); setTested(c);
    try { setResult(await lookupBarcode(c)); } catch { setResult("error"); }
  }

  return (
    <div className="rounded-xl border border-slate-200 p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-extrabold text-slate-600"><ScanLine className="h-4 w-4" /> اختبار مسح مباشر</div>
      <div className="flex gap-2">
        <input className="field flex-1 font-mono" dir="ltr" value={code} onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void test(); } }}
          placeholder="امسح باركودًا هنا…" aria-label="اختبار مسح" />
        <Button variant="secondary" size="sm" onClick={() => void test()} disabled={!code.trim() || result === "pending"}>
          {result === "pending" ? "…" : "فحص"}
        </Button>
      </div>
      {result !== null && result !== "pending" && (
        <div className="mt-2 text-xs font-bold">
          {result === "error" ? (
            <span className="text-rose-600"><XCircle className="ml-1 inline h-4 w-4" /> تعذّر الفحص — تحقق من الاتصال.</span>
          ) : result === null || !result ? (
            <span className="text-amber-600"><XCircle className="ml-1 inline h-4 w-4" /> لا يوجد صنف بالباركود «{tested}».</span>
          ) : (
            <span className={result.itemId === currentItemId ? "text-emerald-700" : "text-sky-700"}>
              <Barcode className="ml-1 inline h-4 w-4" />
              «{tested}» ← {result.name}{result.sizeVariant ? ` (${result.sizeVariant})` : ""}
              {result.itemId === currentItemId ? " — هذا الصنف ✓" : " — صنف آخر!"}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
