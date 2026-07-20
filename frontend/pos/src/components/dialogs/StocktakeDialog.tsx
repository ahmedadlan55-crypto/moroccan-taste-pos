/**
 * Cashier stocktake (جرد المخزون) — PER-WAREHOUSE professional flow.
 *
 * Rewritten for close2/stocktake-pro-pos to consume the v2 professional system
 *   /api/inventory/v2/stocktakes   (routes/inventory-stocktakes.js)
 * instead of the legacy one-shot POST /api/inventory/stocktakes. The legacy path
 * compared the count against a company-wide stock ROLLUP while the write landed
 * in one warehouse — a real bug. The v2 flow reconciles against, and posts the
 * variance to, ONE specific warehouse: the cashier's own (resolved from the JWT
 * default_warehouse_id, the same field the legacy route resolved server-side).
 *
 * The cashier still builds a blind cart (search → add → dual-unit count), but on
 * "submit" the dialog runs the v2 lifecycle as one batch:
 *   1. create   POST /            (scopeType 'items' + the counted itemIds,
 *                                  includeZero so a surplus item at 0 stock is
 *                                  still frozen; blindCount; Idempotency-Key)
 *   2. start    POST /:id/start   (freezes the per-warehouse snapshot)
 *   3. counts   PUT  /:id/counts  (the counted base-unit quantities)
 *   4. submit   POST /:id/submit  (→ submitted; the cashier's job ENDS here)
 * A manager approves + posts the document in the ERP — the POS never shows an
 * approve/post control and never reveals the system quantity or variance.
 *
 * Contract highlights preserved from the legacy modal:
 *  • BLIND COUNT (v5.12.7): system qty + variance are NEVER shown — both columns
 *    render a dash and appear nowhere before or after submit.
 *  • Dual-unit entry: total (base unit) = big×convRate + small; both-empty means
 *    "not counted" (excluded).
 *  • Persistent cart in localStorage 'pos_stocktake_cart' (survives close/reopen).
 *  • Online-only: without a connection the dialog shows «الجرد يتطلب اتصالًا».
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, ClipboardCheck, Printer, Search, Trash2 } from "lucide-react";
import { usePos } from "@/state/store";
import {
  createStocktakeV2,
  getInvItems,
  resolveStocktakeWarehouseId,
  saveStocktakeCountsV2,
  startStocktakeV2,
  stkIdempotencyKey,
  submitStocktakeV2,
  type InvItem,
} from "@/lib/api";
import { fmtDateTime } from "@/lib/format";
import { printHtml } from "@/lib/receipt";
import { useLang, useT } from "@/i18n/I18nProvider";
import { translateApiError } from "@/i18n/errorCodes";
import { stocktakeDialog as stocktakeDialogAr } from "@/i18n/dictionaries/ar/stocktakeDialog";
import { stocktakeDialog as stocktakeDialogEn } from "@/i18n/dictionaries/en/stocktakeDialog";
import { Dialog } from "../Dialog";
import { Button, EmptyState, ErrorBanner, Skeleton, cn } from "../ui";

// ── Shared helpers (also used by RequisitionsDialog — keep signatures stable) ─

/** Arabic fuzzy-search normalizer — port of legacy _normalizeArabic (app.js:3698). */
export function normalizeArabic(s: string): string {
  return String(s || "")
    .toLowerCase()
    .replace(/[ً-ْ]/g, "") // strip tashkeel
    .replace(/[ٱأإآ]/g, "ا") // ٱ أ إ آ → ا
    .replace(/ة/g, "ه") // ة → ه
    .replace(/ى/g, "ي") // ى → ي
    .replace(/ؤ/g, "و") // ؤ → و
    .replace(/ئ/g, "ي"); // ئ → ي
}

/**
 * Dual-unit total in the BASE (small) unit — port of updateCstDual/shrUpdateDual:
 * total = big×convRate + small when the item has a big unit (convRate > 1),
 * otherwise just small. Both inputs empty ⇒ "" (not counted / no qty).
 */
export function dualUnitTotal(
  bigInput: number | "",
  smallInput: number | "",
  convRate: number,
  hasBig: boolean,
): number | "" {
  const bigEmpty = bigInput === "" || bigInput === undefined;
  const smallEmpty = smallInput === "" || smallInput === undefined;
  if (bigEmpty && smallEmpty) return "";
  const b = Number(bigInput) || 0;
  const s = Number(smallInput) || 0;
  return hasBig ? b * (Number(convRate) || 1) + s : s;
}

/** An item has a usable big unit only when named AND convRate > 1 (legacy rule). */
export function hasBigUnit(bigUnit: string | null | undefined, convRate: number): boolean {
  return !!bigUnit && (Number(convRate) || 1) > 1;
}

// ── Persistent cart (same key + line shape as the legacy POS) ────────────────

export interface CstLine {
  id: string;
  name: string;
  unit: string;
  bigUnit: string;
  convRate: number;
  systemQty: number;
  actualQty: number | "";
  unitCost: number;
  _bigInput?: number | "";
  _smallInput?: number | "";
}

const CART_KEY = "pos_stocktake_cart";

function loadCart(): CstLine[] {
  try {
    const raw = JSON.parse(localStorage.getItem(CART_KEY) || "[]") as CstLine[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}
function saveCart(cart: CstLine[]) {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
  } catch {
    /* storage full/blocked — draft just won't survive reload */
  }
}

// ── Post-submit COUNT SHEET (A4, RTL) — counted quantities only. Deliberately
//    carries NO system qty / variance: the cashier count is blind, and the
//    variance belongs to the manager's approval screen in the ERP. ───────────

function esc(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface CountSheetLine {
  name: string;
  unit: string;
  counted: number;
}

export type StocktakeLang = "ar" | "en";

/**
 * Builds the printable A4 count sheet as a standalone HTML string. This runs
 * OUTSIDE React (called from a plain onClick handler, then handed to
 * printHtml/window.open), so it cannot use the useT() hook — it imports the
 * ar/en dictionary objects directly and picks one by `lang` (default 'ar',
 * matching pos_lang's own default).
 */
export function buildCountSheetHtml(
  stNumber: string,
  items: CountSheetLine[],
  cashier: string,
  notes: string,
  lang: StocktakeLang = "ar",
): string {
  const cs = (lang === "en" ? stocktakeDialogEn : stocktakeDialogAr).countSheet;
  const dir = lang === "en" ? "ltr" : "rtl";
  // LTR forced: numeric/phone - do not remove, see i18n plan
  const stNumberHtml = `<b dir="ltr">${esc(stNumber)}</b>`;
  const rows = items
    .map(
      (c, i) => `<tr>
        <td>${i + 1}</td><td style="text-align:start">${esc(c.name)}</td><td>${esc(c.unit)}</td>
        <td style="font-weight:800">${c.counted}</td>
      </tr>`,
    )
    .join("");
  return `<!doctype html><html dir="${dir}" lang="${lang}"><head><meta charset="utf-8">
  <title>${esc(cs.docTitle)} ${esc(stNumber)}</title>
  <style>
    @page { size: A4 portrait; margin: 12mm; }
    body { font-family: 'Cairo', 'Segoe UI', Tahoma, sans-serif; color: #0f172a; margin: 0; }
    h1 { font-size: 18px; margin: 0 0 2px; } .muted { color: #64748b; font-size: 12px; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 12px; }
    th, td { border: 1px solid #e2e8f0; padding: 6px 8px; text-align: center; }
    th { background: #f1f5f9; }
    .tot { margin-top: 10px; font-weight: 800; font-size: 13px; }
    .badge { display:inline-block; margin-top:6px; padding:3px 10px; border-radius:8px; background:#fef3c7; color:#92400e; font-size:11px; font-weight:800; }
    .print-btn { margin: 12px 0; padding: 10px 18px; font-size: 14px; border-radius: 10px; border: 0; background: #0f766e; color: #fff; }
    @media print { .print-btn { display: none; } }
  </style></head><body>
  <h1>${esc(cs.heading)}</h1>
  <p class="muted">${esc(cs.numberLabel)} ${stNumberHtml} · ${esc(cs.cashierLabel)} ${esc(cashier)} · ${fmtDateTime(new Date())}</p>
  <p><span class="badge">${esc(cs.pendingApprovalBadge)}</span></p>
  ${notes ? `<p class="muted">${esc(cs.notesLabel)} ${esc(notes)}</p>` : ""}
  <button class="print-btn" onclick="window.print()">${esc(cs.printButton)}</button>
  <table><thead><tr><th>${esc(cs.colIndex)}</th><th style="text-align:start">${esc(cs.colItem)}</th><th>${esc(cs.colUnit)}</th><th>${esc(cs.colCounted)}</th></tr></thead>
  <tbody>${rows}</tbody></table>
  <p class="tot">${esc(cs.totalCountedLabel)} ${items.length}</p>
  </body></html>`;
}

// ── The dialog ────────────────────────────────────────────────────────────────

type Step = "entry" | "review" | "done";

interface DoneResult {
  stocktakeNumber: string;
  lines: CountSheetLine[];
  notes: string;
}

export function StocktakeDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user, engineStatus, pushToast } = usePos();
  const t = useT();
  const lang = useLang();

  const [items, setItems] = useState<InvItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [cart, setCart] = useState<CstLine[]>(() => loadCart());
  const [notes, setNotes] = useState("");
  const [step, setStep] = useState<Step>("entry");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DoneResult | null>(null);

  const online = engineStatus.online;

  const fetchItems = useCallback(async () => {
    setLoadError(null);
    setItems(null);
    try {
      const list = await getInvItems();
      setItems(list);
      // stocktake-refresh-units-on-render: refresh bigUnit/convRate/unit from the
      // server list so a stale draft cart can't submit stale unit conversions.
      // (systemQty is NOT used any more — the v2 snapshot is taken server-side at
      // /start from THIS warehouse's stock — but we keep the field for cart shape.)
      setCart((c) => {
        const next = c.map((line) => {
          const fresh = list.find((x) => x.id === line.id);
          if (!fresh) return line;
          return {
            ...line,
            bigUnit: fresh.bigUnit || line.bigUnit || "",
            convRate: Number(fresh.convRate) || Number(line.convRate) || 1,
            unit: fresh.unit || line.unit || "",
            systemQty: Number(fresh.stock) || 0,
          };
        });
        saveCart(next);
        return next;
      });
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setStep("entry");
    setResult(null);
    setQuery("");
    setCart(loadCart()); // draft survives close/reopen (stocktake-persistent-cart)
    if (online) void fetchItems();
  }, [open, online, fetchItems]);

  const mutateCart = useCallback((fn: (c: CstLine[]) => CstLine[]) => {
    setCart((c) => {
      const next = fn(c);
      saveCart(next);
      return next;
    });
  }, []);

  // Search: exclude items already in the cart; Arabic-normalized match on name/id.
  const matches = useMemo(() => {
    if (!items) return [];
    const inCart = new Set(cart.map((c) => c.id));
    const available = items.filter((i) => !inCart.has(i.id));
    const qn = normalizeArabic(query);
    if (!qn) return available;
    return available.filter(
      (i) => normalizeArabic(i.name || "").includes(qn) || normalizeArabic(i.id || "").includes(qn),
    );
  }, [items, cart, query]);

  function addItem(item: InvItem) {
    mutateCart((c) => {
      if (c.some((x) => x.id === item.id)) return c;
      return [
        ...c,
        {
          id: item.id,
          name: item.name,
          unit: item.unit || "",
          bigUnit: item.bigUnit || "",
          convRate: Number(item.convRate) || 1,
          systemQty: Number(item.stock) || 0,
          actualQty: "",
          unitCost: Number(item.cost) || 0,
        },
      ];
    });
    setQuery("");
  }

  function updateDual(idx: number, bigVal: number | "" | null, smallVal: number | "" | null) {
    mutateCart((c) =>
      c.map((line, i) => {
        if (i !== idx) return line;
        const next = { ...line };
        if (bigVal !== null) next._bigInput = bigVal;
        if (smallVal !== null) next._smallInput = smallVal;
        next.actualQty = dualUnitTotal(
          next._bigInput ?? "",
          next._smallInput ?? "",
          next.convRate,
          hasBigUnit(next.bigUnit, next.convRate),
        );
        return next;
      }),
    );
  }

  function removeLine(idx: number) {
    mutateCart((c) => c.filter((_, i) => i !== idx));
  }

  function clearCart() {
    try {
      localStorage.removeItem(CART_KEY);
    } catch {
      /* ignore */
    }
    setCart([]);
    pushToast("info", t("stocktakeDialog.toasts.cartCleared"));
  }

  const counted = useMemo(() => cart.filter((c) => c.actualQty !== "" && c.actualQty !== null), [cart]);

  function goReview() {
    if (!cart.length) return pushToast("error", t("stocktakeDialog.toasts.addAtLeastOneItem"));
    if (!counted.length) return pushToast("error", t("stocktakeDialog.toasts.enterQtyAtLeastOne"));
    setStep("review");
  }

  async function submit() {
    const username = user?.username ?? "";
    const finalNotes = notes.trim() || t("stocktakeDialog.misc.defaultNotesPrefix", { username });
    const sheetLines: CountSheetLine[] = counted.map((c) => ({
      name: c.name,
      unit: c.unit || "",
      counted: Number(c.actualQty) || 0,
    }));
    setBusy(true);
    try {
      // Resolve THE cashier's own warehouse (JWT default_warehouse_id, or the
      // single scoped warehouse). Never send an empty warehouseId: the v2 create
      // 422s on a missing warehouse rather than auto-resolving.
      const warehouseId = await resolveStocktakeWarehouseId();
      if (!warehouseId) {
        pushToast("error", t("stocktakeDialog.toasts.noWarehouse"));
        setBusy(false);
        return;
      }

      const itemIds = counted.map((c) => c.id);
      const countsPayload = counted.map((c) => ({ itemId: c.id, countedQty: Number(c.actualQty) || 0 }));

      // 1. create draft (scoped to the counted items, blind, includeZero so a
      //    surplus item at 0 system stock still gets a frozen line).
      const created = await createStocktakeV2(
        { warehouseId, itemIds, reason: finalNotes },
        stkIdempotencyKey(),
      );
      const id = created.id ?? created.data?.id;
      if (!id) throw new Error(t("stocktakeDialog.errors.noDocumentNumber"));
      let version = created.version ?? 1;
      const stNumber = created.documentNumber ?? created.number ?? id;

      // 2. start — freeze the per-warehouse snapshot.
      const started = await startStocktakeV2(id, version);
      version = started.version ?? version + 1;

      // 3. counts — record the counted base-unit quantities.
      const saved = await saveStocktakeCountsV2(id, countsPayload);
      if (!saved.applied) {
        throw new Error(t("stocktakeDialog.errors.countsNotSaved"));
      }
      if (Array.isArray(saved.conflicts) && saved.conflicts.length) {
        // Rare online: a movement raced the count. Surface it; the cashier recounts.
        throw new Error(saved.conflicts[0]?.message || t("stocktakeDialog.errors.stockMovementConflict"));
      }

      // 4. submit — hand off for the manager's approval. Cashier's job ends here.
      await submitStocktakeV2(id, version);

      try {
        localStorage.removeItem(CART_KEY);
      } catch {
        /* ignore */
      }
      setCart([]);
      setNotes("");
      setResult({ stocktakeNumber: stNumber, lines: sheetLines, notes: finalNotes });
      setStep("done");
      pushToast("success", t("stocktakeDialog.toasts.submittedForApproval"));
    } catch (e) {
      pushToast("error", translateApiError(e, t));
    } finally {
      setBusy(false);
    }
  }

  // ── Renders ─────────────────────────────────────────────────────────────────

  const offlineBody = (
    <EmptyState
      icon={<ClipboardCheck className="h-10 w-10" aria-hidden />}
      title={t("stocktakeDialog.offline.title")}
      hint={t("stocktakeDialog.offline.hint")}
    />
  );

  const entryBody = (
    <div className="flex flex-col gap-3">
      {loadError ? <ErrorBanner message={loadError} onRetry={() => void fetchItems()} /> : null}

      {/* Search + results */}
      <div>
        <div className="relative">
          <Search className="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("stocktakeDialog.search.placeholder")}
            aria-label={t("stocktakeDialog.search.ariaLabel")}
            className="field min-h-11 w-full"
            disabled={!items}
          />
        </div>
        {items === null && !loadError ? (
          <div className="mt-2 space-y-2">
            <Skeleton className="h-11" />
            <Skeleton className="h-11" />
          </div>
        ) : null}
        {items && query.trim() ? (
          <ul className="scrollbar-thin mt-1 max-h-48 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-sm" role="listbox" aria-label={t("stocktakeDialog.search.resultsAriaLabel")}>
            {matches.length === 0 ? (
              <li className="px-4 py-3 text-center text-xs font-bold text-slate-400">{t("stocktakeDialog.search.noResults")}</li>
            ) : (
              matches.slice(0, 50).map((i) => {
                const low = (Number(i.stock) || 0) <= (Number(i.minStock) || 0);
                return (
                  <li key={i.id}>
                    <button
                      type="button"
                      onClick={() => addItem(i)}
                      className="btn-press flex min-h-11 w-full items-center justify-between gap-2 border-b border-slate-100 px-4 py-2 text-start hover:bg-slate-50"
                    >
                      <span className="text-sm font-bold text-ink">{i.name}</span>
                      {/* BLIND: current stock is NOT echoed here as a countable figure —
                          only a low-stock hint color, exactly like legacy shows unit. */}
                      <span className={cn("text-[11px] font-bold", low ? "text-red-500" : "text-slate-400")}>{i.unit || ""}</span>
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        ) : null}
      </div>

      {/* Cart table */}
      {cart.length === 0 ? (
        <EmptyState
          icon={<ClipboardCheck className="h-10 w-10" aria-hidden />}
          title={t("stocktakeDialog.cart.emptyTitle")}
          hint={t("stocktakeDialog.cart.emptyHint")}
        />
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-slate-200">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="bg-slate-50 text-[11px] font-extrabold text-slate-500">
                <th className="px-3 py-2 text-start">{t("stocktakeDialog.table.item")}</th>
                <th className="px-2 py-2 text-center">{t("stocktakeDialog.table.bigQty")}</th>
                <th className="px-2 py-2 text-center">{t("stocktakeDialog.table.bigUnit")}</th>
                <th className="px-2 py-2 text-center">{t("stocktakeDialog.table.smallQty")}</th>
                <th className="px-2 py-2 text-center">{t("stocktakeDialog.table.smallUnit")}</th>
                <th className="px-2 py-2 text-center">{t("stocktakeDialog.table.system")}</th>
                <th className="px-2 py-2 text-center">{t("stocktakeDialog.table.variance")}</th>
                <th className="px-2 py-2 text-center">{t("common.delete")}</th>
              </tr>
            </thead>
            <tbody>
              {cart.map((c, i) => {
                const hasBig = hasBigUnit(c.bigUnit, c.convRate);
                return (
                  <tr key={c.id} className="border-t border-slate-100">
                    <td className="px-3 py-2 text-xs font-extrabold text-ink">{c.name}</td>
                    <td className="px-2 py-2 text-center">
                      {hasBig ? (
                        <input
                          type="number"
                          min={0}
                          step={1}
                          inputMode="numeric"
                          value={c._bigInput ?? ""}
                          onChange={(e) => updateDual(i, e.target.value === "" ? "" : Number(e.target.value), null)}
                          placeholder="0"
                          aria-label={t("stocktakeDialog.table.bigQtyAria", { name: c.name })}
                          className="field num min-h-11 w-16 text-center font-extrabold"
                        />
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className="px-2 py-2 text-center text-[11px] font-bold text-slate-500">{hasBig ? c.bigUnit : "—"}</td>
                    <td className="px-2 py-2 text-center">
                      <input
                        type="number"
                        min={0}
                        step={0.01}
                        inputMode="decimal"
                        value={c._smallInput ?? ""}
                        onChange={(e) => updateDual(i, null, e.target.value === "" ? "" : Number(e.target.value))}
                        placeholder="0"
                        aria-label={t("stocktakeDialog.table.smallQtyAria", { name: c.name })}
                        className="field num min-h-11 w-16 text-center font-extrabold"
                      />
                    </td>
                    <td className="px-2 py-2 text-center text-[11px] font-bold text-slate-500">{c.unit || ""}</td>
                    {/* BLIND COUNT (v5.12.7) — system qty & variance hidden always */}
                    <td className="px-2 py-2 text-center text-slate-300" data-testid={`cst-sys-${c.id}`}>
                      —
                    </td>
                    <td className="px-2 py-2 text-center text-slate-300" data-testid={`cst-diff-${c.id}`}>
                      —
                    </td>
                    <td className="px-2 py-2 text-center">
                      <button
                        type="button"
                        onClick={() => removeLine(i)}
                        aria-label={t("stocktakeDialog.table.deleteAria", { name: c.name })}
                        className="btn-press inline-flex h-11 w-11 items-center justify-center rounded-xl text-red-500 hover:bg-red-50"
                      >
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <input
        type="text"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder={t("stocktakeDialog.notes.placeholder")}
        aria-label={t("stocktakeDialog.notes.ariaLabel")}
        className="field min-h-11 w-full"
        maxLength={300}
      />
    </div>
  );

  const reviewBody = (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-bold text-slate-500">
        {t("stocktakeDialog.review.summaryPrefix")} <span className="num">{counted.length}</span>{" "}
        {t("stocktakeDialog.review.countedSuffix")}
        {cart.length > counted.length ? (
          <span className="text-slate-400"> ({t("stocktakeDialog.review.ignoredHint", { count: cart.length - counted.length })})</span>
        ) : null}
      </p>
      <ul className="divide-y divide-slate-100 rounded-2xl border border-slate-200">
        {counted.map((c) => {
          const hasBig = hasBigUnit(c.bigUnit, c.convRate);
          const parts: string[] = [];
          if (hasBig && Number(c._bigInput)) parts.push(`${Number(c._bigInput)} ${c.bigUnit}`);
          if (Number(c._smallInput)) parts.push(`${Number(c._smallInput)} ${c.unit}`);
          return (
            <li key={c.id} className="flex items-center justify-between gap-2 px-4 py-2.5">
              <span className="text-sm font-extrabold text-ink">{c.name}</span>
              <span className="text-xs font-bold text-slate-500">
                {parts.length ? parts.join(" + ") + " = " : ""}
                <span className="num">{Number(c.actualQty)}</span> {c.unit}
              </span>
            </li>
          );
        })}
      </ul>
      {/* Still blind: no system qty / variance. The manager reviews the variance
          on the ERP approval screen after this is submitted. */}
      <p className="text-[11px] font-bold text-slate-400">{t("stocktakeDialog.review.blindNotice")}</p>
    </div>
  );

  const doneBody = result ? (
    <div className="flex flex-col items-center gap-3 py-4 text-center">
      <CheckCircle2 className="h-12 w-12 text-teal-600" aria-hidden />
      <p className="text-sm font-extrabold text-ink">{t("stocktakeDialog.done.submittedTitle")}</p>
      <p className="text-xs font-bold text-slate-500">
        {t("stocktakeDialog.done.numberLabel")}{" "}
        <span className="num text-sm font-extrabold text-teal-700">{result.stocktakeNumber || "—"}</span>
      </p>
      <p className="rounded-xl bg-amber-50 px-3 py-2 text-[11px] font-bold text-amber-800">
        {t("stocktakeDialog.done.pendingNotice")}
      </p>
      <Button
        variant="secondary"
        onClick={() => {
          if (!printHtml(buildCountSheetHtml(result.stocktakeNumber, result.lines, user?.username ?? "", result.notes, lang))) {
            pushToast("error", t("stocktakeDialog.errors.printBlocked"));
          }
        }}
      >
        <Printer className="h-4 w-4" aria-hidden />
        {t("stocktakeDialog.done.printButton")}
      </Button>
    </div>
  ) : null;

  const footer = !online ? null : step === "entry" ? (
    <div className="flex items-center gap-2">
      <Button variant="danger" size="sm" onClick={clearCart} disabled={!cart.length} title={t("stocktakeDialog.footer.clearCartTitle")}>
        <Trash2 className="h-4 w-4" aria-hidden />
        {t("stocktakeDialog.footer.clearCart")}
      </Button>
      <span className="ms-auto text-[11px] font-bold text-slate-400">{t("stocktakeDialog.footer.autoSaveHint")}</span>
      <Button variant="primary" onClick={goReview} disabled={!counted.length}>
        {t("stocktakeDialog.footer.reviewAndSend")} (<span className="num">{counted.length}</span>)
      </Button>
    </div>
  ) : step === "review" ? (
    <div className="flex items-center justify-between gap-2">
      <Button variant="secondary" onClick={() => setStep("entry")} disabled={busy}>
        {t("stocktakeDialog.footer.backToEdit")}
      </Button>
      <Button variant="primary" onClick={() => void submit()} loading={busy}>
        {t("stocktakeDialog.footer.sendForApproval")}
      </Button>
    </div>
  ) : (
    <Button variant="primary" className="w-full" onClick={onClose}>
      {t("common.close")}
    </Button>
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={step === "done" ? t("stocktakeDialog.doneTitle") : t("stocktakeDialog.title")}
      widthClass="max-w-3xl"
      footer={footer}
      locked={busy}
    >
      {!online ? offlineBody : step === "entry" ? entryBody : step === "review" ? reviewBody : doneBody}
    </Dialog>
  );
}
