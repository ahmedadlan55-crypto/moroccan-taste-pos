/**
 * Cashier stocktake (جرد المخزون) — React parity port of the legacy modal:
 *   public/pos/app.js: openCashierStocktake(3659) / filterCashierStItems(3709)
 *   selectCstItem(3737) / updateCstDual(3817) / submitCashierStocktake(3875)
 *   / _printStocktakeReport(3924).
 *
 * Contract highlights (the legacy behavior IS the acceptance contract):
 *  • BLIND COUNT (v5.12.7): system qty + variance are NEVER shown before
 *    submit — both columns render a dash. Variance only appears in the
 *    post-submit printable report.
 *  • Dual-unit entry: total (base unit) = big×convRate + small; each input is
 *    stored independently and both-empty means "not counted" (excluded).
 *  • Persistent cart in localStorage 'pos_stocktake_cart' — the SAME key the
 *    legacy POS uses, so a draft survives close/reopen and even a UI switch.
 *  • Online-only: without a connection the dialog shows «الجرد يتطلب اتصالًا».
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, ClipboardCheck, Printer, Search, Trash2 } from "lucide-react";
import { usePos } from "@/state/store";
import { getInvItems, submitStocktake, type InvItem, type StocktakeLine } from "@/lib/api";
import { fmtDateTime } from "@/lib/format";
import { printHtml } from "@/lib/receipt";
import { Dialog } from "../Dialog";
import { Button, EmptyState, ErrorBanner, Skeleton, cn } from "../ui";

// ── Shared helpers (also used by RequisitionsDialog) ─────────────────────────

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

// ── Post-submit printable report (A4, RTL — port of _printStocktakeReport) ───

function esc(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildStocktakeReportHtml(stId: string, items: StocktakeLine[], cashier: string, notes: string): string {
  const rows = items
    .map((c, i) => {
      const diff = c.diff;
      const color = diff === 0 ? "#64748b" : diff > 0 ? "#16a34a" : "#ef4444";
      return `<tr>
        <td>${i + 1}</td><td style="text-align:right">${esc(c.name)}</td><td>${esc(c.unit)}</td>
        <td>${c.sys}</td><td>${c.actual}</td>
        <td style="color:${color};font-weight:800">${diff > 0 ? "+" : ""}${diff.toFixed(2)}</td>
      </tr>`;
    })
    .join("");
  const totalVar = items.reduce((s, c) => s + c.diff, 0);
  return `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8">
  <title>تقرير جرد ${esc(stId)}</title>
  <style>
    @page { size: A4 portrait; margin: 12mm; }
    body { font-family: 'Cairo', 'Segoe UI', Tahoma, sans-serif; color: #0f172a; margin: 0; }
    h1 { font-size: 18px; margin: 0 0 2px; } .muted { color: #64748b; font-size: 12px; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 12px; }
    th, td { border: 1px solid #e2e8f0; padding: 6px 8px; text-align: center; }
    th { background: #f1f5f9; }
    .tot { margin-top: 10px; font-weight: 800; font-size: 13px; }
    .print-btn { margin: 12px 0; padding: 10px 18px; font-size: 14px; border-radius: 10px; border: 0; background: #0f766e; color: #fff; }
    @media print { .print-btn { display: none; } }
  </style></head><body>
  <h1>تقرير جرد المخزون</h1>
  <p class="muted">رقم المحضر: <b dir="ltr">${esc(stId)}</b> · الكاشير: ${esc(cashier)} · ${fmtDateTime(new Date())}</p>
  ${notes ? `<p class="muted">ملاحظات: ${esc(notes)}</p>` : ""}
  <button class="print-btn" onclick="window.print()">🖨 طباعة / PDF</button>
  <table><thead><tr><th>#</th><th style="text-align:right">المادة</th><th>الوحدة</th><th>النظام</th><th>الفعلي</th><th>الفرق</th></tr></thead>
  <tbody>${rows}</tbody></table>
  <p class="tot">إجمالي التباين: <span dir="ltr">${totalVar.toFixed(2)}</span> · عدد المواد: ${items.length}</p>
  </body></html>`;
}

// ── The dialog ────────────────────────────────────────────────────────────────

type Step = "entry" | "review" | "done";

export function StocktakeDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user, engineStatus, pushToast } = usePos();

  const [items, setItems] = useState<InvItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [cart, setCart] = useState<CstLine[]>(() => loadCart());
  const [notes, setNotes] = useState("");
  const [step, setStep] = useState<Step>("entry");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ stocktakeId: string; lines: StocktakeLine[]; notes: string } | null>(null);

  const online = engineStatus.online;

  const fetchItems = useCallback(async () => {
    setLoadError(null);
    setItems(null);
    try {
      const list = await getInvItems();
      setItems(list);
      // stocktake-refresh-units-on-render: refresh bigUnit/convRate/unit/systemQty
      // from the server list so a stale draft cart can't submit stale units.
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
    pushToast("info", "تم مسح المحضر");
  }

  const counted = useMemo(() => cart.filter((c) => c.actualQty !== "" && c.actualQty !== null), [cart]);

  function goReview() {
    if (!cart.length) return pushToast("error", "أضف مادة واحدة على الأقل");
    if (!counted.length) return pushToast("error", "أدخل الكمية الفعلية لمادة واحدة على الأقل");
    setStep("review");
  }

  async function submit() {
    const username = user?.username ?? "";
    const linesToSend: StocktakeLine[] = counted.map((c) => {
      const s = Number(c.systemQty) || 0;
      const a = Number(c.actualQty) || 0;
      return { id: c.id, name: c.name, unit: c.unit || "", systemQty: s, actualQty: a, sys: s, actual: a, diff: a - s };
    });
    const finalNotes = notes.trim() || `جرد بواسطة ${username}`;
    setBusy(true);
    try {
      const r = await submitStocktake(linesToSend, username, finalNotes);
      try {
        localStorage.removeItem(CART_KEY);
      } catch {
        /* ignore */
      }
      setCart([]);
      setNotes("");
      setResult({ stocktakeId: r.stocktakeId || "", lines: linesToSend, notes: finalNotes });
      setStep("done");
      pushToast("success", "تم حفظ محضر الجرد وإرساله");
    } catch (e) {
      pushToast("error", (e as Error).message); // server message verbatim
    } finally {
      setBusy(false);
    }
  }

  // ── Renders ─────────────────────────────────────────────────────────────────

  const offlineBody = (
    <EmptyState
      icon={<ClipboardCheck className="h-10 w-10" aria-hidden />}
      title="الجرد يتطلب اتصالًا"
      hint="أعد المحاولة عند عودة الاتصال بالخادم — مسودة المحضر محفوظة على هذا الجهاز"
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
            placeholder="ابحث عن مادة خام لإضافتها للمحضر…"
            aria-label="البحث عن مادة"
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
          <ul className="scrollbar-thin mt-1 max-h-48 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-sm" role="listbox" aria-label="نتائج البحث">
            {matches.length === 0 ? (
              <li className="px-4 py-3 text-center text-xs font-bold text-slate-400">لا نتائج مطابقة</li>
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
          title="محضر الجرد فارغ"
          hint="ابحث عن مادة وأضفها ثم أدخل الكمية الفعلية المعدودة"
        />
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-slate-200">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="bg-slate-50 text-[11px] font-extrabold text-slate-500">
                <th className="px-3 py-2 text-start">المادة</th>
                <th className="px-2 py-2 text-center">الكمية الكبيرة</th>
                <th className="px-2 py-2 text-center">وحدة كبرى</th>
                <th className="px-2 py-2 text-center">الكمية الصغيرة</th>
                <th className="px-2 py-2 text-center">وحدة صغرى</th>
                <th className="px-2 py-2 text-center">النظام</th>
                <th className="px-2 py-2 text-center">الفرق</th>
                <th className="px-2 py-2 text-center">حذف</th>
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
                          aria-label={`الكمية الكبيرة — ${c.name}`}
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
                        aria-label={`الكمية الصغيرة — ${c.name}`}
                        className="field num min-h-11 w-16 text-center font-extrabold"
                      />
                    </td>
                    <td className="px-2 py-2 text-center text-[11px] font-bold text-slate-500">{c.unit || ""}</td>
                    {/* BLIND COUNT (v5.12.7) — system qty & variance hidden until submit */}
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
                        aria-label={`حذف ${c.name}`}
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
        placeholder="ملاحظات الجرد (اختياري)"
        aria-label="ملاحظات الجرد"
        className="field min-h-11 w-full"
        maxLength={300}
      />
    </div>
  );

  const reviewBody = (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-bold text-slate-500">
        مراجعة المحضر قبل الإرسال — <span className="num">{counted.length}</span> مادة معدودة
        {cart.length > counted.length ? (
          <span className="text-slate-400"> (سيتم تجاهل {cart.length - counted.length} مادة بلا كمية)</span>
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
      {/* Still blind: no system qty / variance in the review step. */}
      <p className="text-[11px] font-bold text-slate-400">يُحتسب الفرق على الخادم بعد الإرسال (جرد أعمى).</p>
    </div>
  );

  const doneBody = result ? (
    <div className="flex flex-col items-center gap-3 py-4 text-center">
      <CheckCircle2 className="h-12 w-12 text-teal-600" aria-hidden />
      <p className="text-sm font-extrabold text-ink">تم حفظ محضر الجرد وإرساله</p>
      <p className="text-xs font-bold text-slate-500">
        رقم المحضر: <span className="num text-sm font-extrabold text-teal-700">{result.stocktakeId || "—"}</span>
      </p>
      <Button
        variant="secondary"
        onClick={() => {
          if (!printHtml(buildStocktakeReportHtml(result.stocktakeId, result.lines, user?.username ?? "", result.notes))) {
            pushToast("error", "المتصفح منع نافذة الطباعة");
          }
        }}
      >
        <Printer className="h-4 w-4" aria-hidden />
        طباعة / PDF
      </Button>
    </div>
  ) : null;

  const footer = !online ? null : step === "entry" ? (
    <div className="flex items-center gap-2">
      <Button variant="danger" size="sm" onClick={clearCart} disabled={!cart.length} title="مسح كامل المحضر">
        <Trash2 className="h-4 w-4" aria-hidden />
        مسح المحضر
      </Button>
      <span className="ms-auto text-[11px] font-bold text-slate-400">تُحفظ المسودة تلقائيًا</span>
      <Button variant="primary" onClick={goReview} disabled={!counted.length}>
        مراجعة وإرسال (<span className="num">{counted.length}</span>)
      </Button>
    </div>
  ) : step === "review" ? (
    <div className="flex items-center justify-between gap-2">
      <Button variant="secondary" onClick={() => setStep("entry")} disabled={busy}>
        رجوع للتعديل
      </Button>
      <Button variant="primary" onClick={() => void submit()} loading={busy}>
        حفظ وإرسال التقرير
      </Button>
    </div>
  ) : (
    <Button variant="primary" className="w-full" onClick={onClose}>
      إغلاق
    </Button>
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={step === "done" ? "تم إرسال الجرد" : "جرد المخزون"}
      widthClass="max-w-3xl"
      footer={footer}
      locked={busy}
    >
      {!online ? offlineBody : step === "entry" ? entryBody : step === "review" ? reviewBody : doneBody}
    </Dialog>
  );
}
