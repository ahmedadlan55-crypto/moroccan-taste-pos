import { useEffect, useMemo, useRef, useState } from "react";
import { Barcode, CheckCircle2, Plus, Printer, ScanLine, Star, Trash2, XCircle } from "lucide-react";
import { Button } from "@/shared/ui";
import { useCan } from "@/modules/inventory/lib/permission-provider";
import { useItemMutations, lookupBarcode, type BarcodeLookupResult } from "@/modules/inventory/lib/hooks/useItems";
import type { ItemDetail } from "@/modules/inventory/lib/adapters/item.adapter";
import { ApiError } from "@/shared/api";
import { useT } from "@/i18n";
import { code39Svg, printBarcodeLabels } from "./barcodeLabel";

interface Row { code: string; sizeVariant: string; isPrimary: boolean }

// Phase W4 — barcode management inside Item Details: primary + secondary codes
// with size variants, scan-to-add, a live scan tester, explicit 409 conflict
// display (BARCODE_TAKEN), and Code39 label printing.
export function BarcodesTab({ detail, onSaved }: { detail: ItemDetail; onSaved: () => void }) {
  const t = useT();
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
    if (localDup) { setErr(t("inventoryRest.itemBarcodes.duplicate", { code: localDup })); return; }
    const primary = rows.find((r) => r.isPrimary)?.code.trim() ?? null;
    const secondaries = rows.filter((r) => !r.isPrimary && r.code.trim()).map((r) => ({ code: r.code.trim(), sizeVariant: r.sizeVariant.trim() || null }));
    m.saveBarcodes.mutate(
      { id: detail.id, primaryBarcode: primary, barcodes: secondaries, expectedVersion: detail.version },
      {
        onSuccess: () => { setSaved(true); setDirty(false); onSaved(); },
        onError: (e) => {
          if (e instanceof ApiError && e.code === "BARCODE_TAKEN") setErr(t("inventoryRest.itemBarcodes.conflictTaken"));
          else if (e instanceof ApiError && e.isConflict) { setErr(t("inventoryRest.itemBarcodes.conflictVersion")); onSaved(); }
          else setErr(t("inventoryRest.itemBarcodes.saveFailed"));
        },
      },
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {rows.length === 0 && <p className="rounded-xl border border-dashed border-slate-200 p-5 text-center text-sm font-medium leading-6 text-slate-500">{t("inventoryRest.itemBarcodes.empty")}</p>}
        {rows.map((r, i) => {
          const svg = code39Svg(r.code, { height: 28, moduleWidth: 1 });
          return (
            <div key={i} className={`flex min-w-0 flex-col gap-3 rounded-2xl border p-3 sm:flex-row sm:items-center ${r.isPrimary ? "border-teal-300 bg-teal-50/50" : "border-slate-200 bg-white"}`}>
              <button type="button" title={r.isPrimary ? t("inventoryRest.itemBarcodes.primaryTitle") : t("inventoryRest.itemBarcodes.setPrimaryTitle")} aria-label={r.isPrimary ? t("inventoryRest.itemBarcodes.primaryAria", { code: r.code }) : t("inventoryRest.itemBarcodes.setPrimaryAria", { code: r.code })}
                onClick={() => canManage && setPrimary(i)} disabled={!canManage}
                className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl transition focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-100 disabled:cursor-not-allowed disabled:opacity-60 ${r.isPrimary ? "bg-teal-600 text-white" : "bg-slate-100 text-slate-400 hover:bg-slate-200"}`}>
                <Star className="h-4 w-4" aria-hidden="true" />
              </button>
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                <span className="min-w-0 break-all font-mono text-sm font-bold text-slate-800" dir="ltr">{r.code}</span>
                {r.sizeVariant && <span className="break-words rounded-lg bg-slate-100 px-2 py-1 text-xs font-bold text-slate-600">{r.sizeVariant}</span>}
                {r.isPrimary && <span className="rounded-lg bg-teal-100 px-2 py-1 text-xs font-bold text-teal-700">{t("inventoryRest.itemBarcodes.primaryBadge")}</span>}
              </div>
              {svg && (
                <img
                  className="hidden h-8 max-w-full shrink-0 sm:block"
                  src={`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`}
                  alt={t("inventoryRest.itemBarcodes.imageAlt", { code: r.code })}
                />
              )}
              {canManage && (
                <Button className="self-end sm:self-auto" variant="ghost" size="icon" aria-label={t("inventoryRest.itemBarcodes.deleteAria", { code: r.code })} onClick={() => removeRow(i)}>
                  <Trash2 className="h-4 w-4 text-rose-500" aria-hidden="true" />
                </Button>
              )}
            </div>
          );
        })}
      </div>

      {canManage && (
        <div className="grid grid-cols-1 items-end gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,0.55fr)_auto]">
          <label className="block min-w-0 text-xs font-bold leading-5 text-slate-600">{t("inventoryRest.itemBarcodes.add.codeLabel")}
            <input ref={addRef} className="field mt-1 min-h-11 w-full font-mono" dir="ltr" value={addCode}
              onChange={(e) => setAddCode(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addRow(); } }}
              placeholder={t("inventoryRest.itemBarcodes.add.codePlaceholder")} aria-label={t("inventoryRest.itemBarcodes.add.codeAria")} />
          </label>
          <label className="block min-w-0 text-xs font-bold leading-5 text-slate-600">{t("inventoryRest.itemBarcodes.add.variantLabel")}
            <input className="field mt-1 min-h-11 w-full" value={addVariant} onChange={(e) => setAddVariant(e.target.value)} placeholder={t("inventoryRest.itemBarcodes.add.variantPlaceholder")} aria-label={t("inventoryRest.itemBarcodes.add.variantAria")} />
          </label>
          <Button className="w-full sm:w-auto" variant="secondary" size="sm" onClick={addRow} disabled={!addCode.trim()}><Plus className="h-4 w-4" aria-hidden="true" /> {t("inventoryRest.itemBarcodes.add.action")}</Button>
        </div>
      )}

      {err && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-3 text-xs font-bold leading-5 text-rose-700">{err}</p>}
      {saved && <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-3 text-xs font-bold text-emerald-700"><CheckCircle2 className="me-1 inline h-4 w-4" aria-hidden="true" /> {t("inventoryRest.itemBarcodes.saved")}</p>}

      <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap sm:justify-between">
        <Button className="w-full sm:w-auto" variant="ghost" size="sm" disabled={rows.length === 0}
          onClick={() => printBarcodeLabels(rows.map((r) => ({ itemName: detail.name, sku: detail.sku, code: r.code, sizeVariant: r.sizeVariant || null })))}>
          <Printer className="h-4 w-4" aria-hidden="true" /> {t("inventoryRest.itemBarcodes.printLabels")}
        </Button>
        {canManage && (
          <Button className="w-full sm:w-auto" variant="primary" size="sm" disabled={!dirty || m.saveBarcodes.isPending || !!localDup} onClick={save}>
            {m.saveBarcodes.isPending ? t("inventoryRest.itemBarcodes.saving") : t("inventoryRest.itemBarcodes.save")}
          </Button>
        )}
      </div>
      {localDup && <p className="text-xs font-bold text-amber-600">{t("inventoryRest.itemBarcodes.duplicate", { code: localDup })}</p>}

      <ScanTester currentItemId={detail.id} />
    </div>
  );
}

// Live scan tester: scan any code and see instantly which item it resolves to.
function ScanTester({ currentItemId }: { currentItemId: string }) {
  const t = useT();
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
    <section className="rounded-2xl border border-slate-200 p-4">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-extrabold text-slate-700"><ScanLine className="h-4 w-4" aria-hidden="true" /> {t("inventoryRest.itemBarcodes.scan.title")}</h3>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
        <input className="field min-h-11 min-w-0 w-full font-mono" dir="ltr" value={code} onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void test(); } }}
          placeholder={t("inventoryRest.itemBarcodes.scan.placeholder")} aria-label={t("inventoryRest.itemBarcodes.scan.aria")} />
        <Button className="w-full sm:w-auto" variant="secondary" size="sm" onClick={() => void test()} disabled={!code.trim() || result === "pending"}>
          {result === "pending" ? t("inventoryRest.itemBarcodes.scan.checking") : t("inventoryRest.itemBarcodes.scan.check")}
        </Button>
      </div>
      {result !== null && result !== "pending" && (
        <div className="mt-3 break-words rounded-xl bg-slate-50 px-3 py-2 text-xs font-bold leading-5">
          {result === "error" ? (
            <span className="text-rose-600"><XCircle className="me-1 inline h-4 w-4" aria-hidden="true" /> {t("inventoryRest.itemBarcodes.scan.error")}</span>
          ) : result === null || !result ? (
            <span className="text-amber-600"><XCircle className="me-1 inline h-4 w-4" aria-hidden="true" /> {t("inventoryRest.itemBarcodes.scan.notFound", { code: tested })}</span>
          ) : (
            <span className={result.itemId === currentItemId ? "text-emerald-700" : "text-sky-700"}>
              <Barcode className="me-1 inline h-4 w-4" aria-hidden="true" />
              {t("inventoryRest.itemBarcodes.scan.result", { code: tested, name: result.name, variant: result.sizeVariant ? ` (${result.sizeVariant})` : "" })}
              {` — ${result.itemId === currentItemId ? t("inventoryRest.itemBarcodes.scan.currentItem") : t("inventoryRest.itemBarcodes.scan.otherItem")}`}
            </span>
          )}
        </div>
      )}
    </section>
  );
}
