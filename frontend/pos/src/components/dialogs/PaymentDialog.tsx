/**
 * PaymentDialog — method tabs (كاش/شبكة/مختلط/آجل), cash quick-tender with
 * change math, mixed split with live validation, then the submit→sales→
 * complete chain with visible progress. Offline: CASH ONLY, queued for
 * replay ("سيُرحَّل عند عودة الاتصال") with a local reference.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Banknote, CheckCircle2, ChefHat, CreditCard, HandCoins, Loader2, Printer, SplitSquareHorizontal, Wallet } from "lucide-react";
import { usePos } from "@/state/store";
import { round2, paymentsError } from "@/lib/cartMath";
import { fmt2, shortRef } from "@/lib/format";
import { buildKitchenTicketHtml, buildReceiptHtml, printHtml } from "@/lib/receipt";
import type { CatalogPaymentMethod, LocalOrder, Payment } from "@/lib/types";
import { Dialog } from "../Dialog";
import { Numpad } from "../Numpad";
import { Button, cn, Money } from "../ui";

/** Built-in tabs + `owner:<name>` for owner-configured methods (close/w25-sell-ui). */
type Tab = "cash" | "card" | "split" | "credit" | `owner:${string}`;

/** Names the built-in tiles already cover — an owner row with one of these
 *  names would render a duplicate tile, so it is skipped. */
const BUILTIN_METHOD_NAMES = new Set(["cash", "card", "credit", "split"]);

/** 'other'-group methods REQUIRE a note ≥3 chars (server 422s otherwise —
 *  legacy doCheckout enforced the same, app.js:2556-2569). */
function methodNeedsNote(m: CatalogPaymentMethod | null): boolean {
  if (!m) return false;
  return m.requiresNote === true || String(m.groupType ?? "").toLowerCase() === "other";
}
type Phase =
  | { name: "form" }
  | { name: "working"; stage: "submit" | "sale" | "complete" }
  /** The watchdog fired: the request may STILL land server-side (it is not
   *  aborted — checkout is idempotent), but the cashier gets an exit. */
  | { name: "timeout" }
  | { name: "success"; invoiceNumber: string | null; saleId: string | null; queued: boolean; doc: LocalOrder; payments: Payment[]; cashTendered: number; changeDue: number; zatcaQrDataUrl: string | null }
  | { name: "failed"; error: string };

/** pay-watchdog — legacy released a hung checkout after 120s (app.js:2753-2770):
 *  a fetch whose connection is accepted but never answered fires NEITHER
 *  handler, and the dialog would stay locked forever. */
export const CHECKOUT_WATCHDOG_MS = 120_000;

const STAGE_LABELS: Record<"submit" | "sale" | "complete", string> = {
  submit: "تثبيت الطلب…",
  sale: "تسجيل الفاتورة…",
  complete: "إكمال الطلب…",
};

export function PaymentDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { cart, totals, engine, engineStatus, supervisor, user, catalog, startNewOrder, loadOrderDoc, pushToast, shiftId, o2cEnabled } = usePos();
  const online = engineStatus.online;
  const total = totals.total;
  // Offline the live shift query is disabled — fall back to the shift stored
  // on the cart doc (the server re-validates o.shift_id at replay anyway).
  const effectiveShiftId = shiftId ?? cart.shiftId;

  const [tab, setTab] = useState<Tab>("cash");
  const [tendered, setTendered] = useState<string>("");
  const [splitCash, setSplitCash] = useState<string>("");
  const [splitCard, setSplitCard] = useState<string>("");
  const [splitCredit, setSplitCredit] = useState<string>("");
  const [payNote, setPayNote] = useState<string>("");
  const [phase, setPhase] = useState<Phase>({ name: "form" });
  const tenderedRef = useRef<HTMLInputElement>(null);
  // Which split leg the on-screen numpad edits (touch POS): the last-focused
  // amount field, highlighted with a ring. Cash tab always edits `tendered`.
  const [activeSplitField, setActiveSplitField] = useState<"cash" | "card" | "credit">("cash");

  // Owner-configured method tiles from the catalog (close/w25-sell-ui).
  // Absent on an old server → [] → the four built-in tabs only, as before.
  const ownerMethods = useMemo(() => {
    const seen = new Set<string>();
    const out: CatalogPaymentMethod[] = [];
    for (const m of catalog?.paymentMethods ?? []) {
      const name = String(m?.name ?? "").trim();
      if (!name) continue;
      const lower = name.toLowerCase();
      if (BUILTIN_METHOD_NAMES.has(lower) || seen.has(lower)) continue;
      seen.add(lower);
      out.push({ ...m, name });
    }
    return out;
  }, [catalog]);
  const ownerMethod = tab.startsWith("owner:")
    ? ownerMethods.find((m) => `owner:${m.name}` === tab) ?? null
    : null;
  const noteRequired = methodNeedsNote(ownerMethod);
  const noteTooShort = noteRequired && payNote.trim().length < 3;

  // Reset per open.
  useEffect(() => {
    if (open) {
      setTab("cash");
      setTendered("");
      setSplitCash("");
      setSplitCard("");
      setSplitCredit("");
      setPayNote("");
      setActiveSplitField("cash");
      setPhase({ name: "form" });
    }
  }, [open]);

  // Offline forces cash.
  useEffect(() => {
    if (!online && tab !== "cash") setTab("cash");
  }, [online, tab]);

  // An owner tab whose method vanished from the catalog (owner edit mid-shift)
  // falls back to cash rather than confirming against a ghost method.
  useEffect(() => {
    if (tab.startsWith("owner:") && !ownerMethod) setTab("cash");
  }, [tab, ownerMethod]);

  // The split tab's آجل leg requires a supervisor, same as the dedicated
  // credit tab — if supervisor status drops mid-session (or the dialog was
  // left open), a stale nonzero value must not silently keep counting toward
  // the split sum once the field is disabled.
  useEffect(() => {
    if (!supervisor) setSplitCredit("");
  }, [supervisor]);

  // Progress events from the engine's checkout chain.
  useEffect(() => {
    if (!open) return;
    return engine.onEvent((e) => {
      if (e.type === "checkout-progress" && e.orderId === cart.id) {
        setPhase((p) => (p.name === "working" ? { name: "working", stage: e.stage } : p));
      }
    });
  }, [engine, open, cart.id]);

  // Watchdog: entering 'working' arms a 120s timer (stage changes keep the SAME
  // timer — phase.name is the dep). Leaving 'working' (success/failed) clears
  // it, so it can never fire after an outcome; if it fires first, a late
  // outcome from the still-running checkout simply overwrites the timeout view.
  useEffect(() => {
    if (phase.name !== "working") return;
    const t = setTimeout(() => {
      setPhase((p) => (p.name === "working" ? { name: "timeout" } : p));
    }, CHECKOUT_WATCHDOG_MS);
    return () => clearTimeout(t);
  }, [phase.name]);

  const tenderedNum = Number(tendered) || 0;
  const changeDue = round2(Math.max(0, tenderedNum - total));
  const cashShort = tab === "cash" && tendered !== "" && tenderedNum < total;

  const splitCashNum = Number(splitCash) || 0;
  const splitCardNum = Number(splitCard) || 0;
  const splitCreditNum = Number(splitCredit) || 0;
  const splitSum = round2(splitCashNum + splitCardNum + splitCreditNum);
  const splitError =
    tab === "split"
      ? paymentsError(
          ([
            { method: "cash", amount: splitCashNum },
            { method: "card", amount: splitCardNum },
            { method: "credit", amount: splitCreditNum },
          ] as Payment[]).filter((p) => p.amount > 0),
          total,
        )
      : null;

  const payments: Payment[] = useMemo(() => {
    if (tab === "cash") return [{ method: "cash", amount: total }];
    if (tab === "card") return [{ method: "card", amount: total }];
    if (tab === "credit") return [{ method: "credit", amount: total }];
    // Owner method — the method NAME rides verbatim (pinned contract).
    if (ownerMethod) return [{ method: ownerMethod.name, amount: total }];
    // split — only the non-zero legs (cash + card + credit).
    return (
      [
        { method: "cash", amount: round2(splitCashNum) },
        { method: "card", amount: round2(splitCardNum) },
        { method: "credit", amount: round2(splitCreditNum) },
      ] as Payment[]
    ).filter((p) => p.amount > 0);
  }, [tab, ownerMethod, total, splitCashNum, splitCardNum, splitCreditNum]);

  // Order-to-Cash credit gate: any credit portion needs a REAL linked customer
  // (server enforces too — this blocks earlier with a clear message).
  const creditAmount = round2(payments.filter((p) => p.method === "credit").reduce((s, p) => s + p.amount, 0));
  const creditNeedsCustomer = o2cEnabled && creditAmount > 0;
  const creditBlocked = creditNeedsCustomer && !cart.customerId;

  // Split's آجل leg needs a supervisor too — checked BEFORE any network call,
  // even when the arithmetic sum already matches the total (a role gate, not
  // a sum-mismatch check).
  const splitCreditNeedsSupervisor = tab === "split" && !supervisor && splitCreditNum > 0;

  const confirmDisabled =
    total <= 0 ||
    (tab === "cash" && tendered !== "" && tenderedNum < total) ||
    (tab === "split" && !!splitError) ||
    splitCreditNeedsSupervisor ||
    creditBlocked ||
    noteTooShort ||
    !effectiveShiftId;

  async function confirm() {
    // 'timeout' allows a RETRY: safe — the sale dedupes on clientOrderId
    // (= the doc id) server-side, so a landed first attempt is replayed, not
    // duplicated (same guarantee legacy leaned on, app.js:2756-2766).
    if (phase.name !== "form" && phase.name !== "timeout") return;
    const snapshot: LocalOrder = { ...cart, lines: cart.lines.map((l) => ({ ...l })) };
    const cashTendered = tab === "cash" ? (tendered === "" ? total : tenderedNum) : 0;
    const change = tab === "cash" ? round2(Math.max(0, cashTendered - total)) : 0;
    setPhase({ name: "working", stage: "submit" });
    try {
      const outcome = await engine.checkout(snapshot, payments, {
        cashTendered,
        changeDue: change,
        // The 'other'-group note (already gated ≥3 chars by confirmDisabled).
        paymentNotes: noteRequired && payNote.trim() ? payNote.trim() : undefined,
      });
      if (outcome.state === "failed") {
        // The engine reopened the doc server-side + locally; reload the fresh
        // copy so the cart stays editable (status back to 'open').
        const fresh = await engine.getOrder(snapshot.id);
        if (fresh) loadOrderDoc(fresh);
        setPhase({ name: "failed", error: outcome.error || "فشل الدفع" });
        return;
      }
      setPhase({
        name: "success",
        invoiceNumber: outcome.invoiceNumber,
        saleId: outcome.saleId,
        queued: outcome.state === "queued",
        doc: snapshot,
        payments,
        cashTendered,
        changeDue: change,
        zatcaQrDataUrl: outcome.zatcaQrDataUrl ?? null,
      });
    } catch (e) {
      const fresh = await engine.getOrder(snapshot.id);
      if (fresh) loadOrderDoc(fresh);
      setPhase({ name: "failed", error: (e as Error).message });
    }
  }

  function finishAndNew() {
    startNewOrder();
    onClose();
  }

  function printReceipt(p: Extract<Phase, { name: "success" }>) {
    const ok = printHtml(
      buildReceiptHtml({
        order: { ...p.doc, invoiceNumber: p.invoiceNumber, saleId: p.saleId },
        payments: p.payments,
        invoiceNumber: p.invoiceNumber,
        cashTendered: p.cashTendered,
        changeDue: p.changeDue,
        cashierName: user?.username ?? "",
        vatRate: catalog?.vatRate ?? 15,
        offlineRef: p.queued,
        // Owner-configured seller block from the cached catalog (works offline)
        // and the server-stamped QR from checkout (absent while queued).
        identity: catalog?.identity ?? null,
        showFields: catalog?.receiptShowFields ?? null,
        zatcaQrDataUrl: p.zatcaQrDataUrl,
      }),
    );
    if (!ok) pushToast("error", "المتصفح منع نافذة الطباعة — اسمح بالنوافذ المنبثقة");
  }

  const locked = phase.name === "working";

  return (
    <Dialog
      open={open}
      onClose={phase.name === "success" ? finishAndNew : onClose}
      title="الدفع"
      widthClass="max-w-xl"
      locked={locked}
    >
      {phase.name === "form" || phase.name === "failed" ? (
        <div>
          {phase.name === "failed" ? (
            <div role="alert" className="mb-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-bold text-red-700">
              {phase.error}
            </div>
          ) : null}

          {!effectiveShiftId ? (
            <div role="alert" className="mb-3 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-800">
              لا يمكن الدفع بلا وردية مفتوحة — افتح وردية أولًا من الشريط العلوي
            </div>
          ) : null}

          {/* Total */}
          <div className="mb-4 rounded-2xl bg-ink px-5 py-4 text-center text-white">
            <p className="text-xs font-bold text-slate-300">الإجمالي المستحق</p>
            <p className="text-3xl font-extrabold">
              <Money value={fmt2(total)} /> <span className="text-sm font-bold text-slate-300">ر.س</span>
            </p>
          </div>

          {/* Method tiles — built-ins always; owner methods appended (pay-method-tiles) */}
          <div className="mb-4 grid grid-cols-4 gap-1.5" role="tablist" aria-label="طريقة الدفع">
            {(
              [
                { key: "cash" as Tab, label: "كاش", icon: Banknote, disabled: false, tip: undefined },
                {
                  key: "card" as Tab,
                  label: "شبكة",
                  icon: CreditCard,
                  disabled: !online,
                  tip: !online ? "دفع الشبكة غير متاح بلا اتصال" : undefined,
                },
                {
                  key: "split" as Tab,
                  label: "مختلط",
                  icon: SplitSquareHorizontal,
                  disabled: !online,
                  tip: !online ? "الدفع المختلط غير متاح بلا اتصال" : undefined,
                },
                {
                  key: "credit" as Tab,
                  label: "آجل",
                  icon: HandCoins,
                  disabled: !online || !supervisor,
                  tip: !online ? "البيع الآجل غير متاح بلا اتصال" : !supervisor ? "البيع الآجل يتطلب مشرفًا/مديرًا" : undefined,
                },
                ...ownerMethods.map((m) => ({
                  key: `owner:${m.name}` as Tab,
                  label: m.nameAr || m.name,
                  icon: Wallet,
                  disabled: !online,
                  tip: !online ? "طرق الدفع الإضافية غير متاحة بلا اتصال" : undefined,
                })),
              ] as ReadonlyArray<{ key: Tab; label: string; icon: typeof Banknote; disabled: boolean; tip: string | undefined }>
            ).map(({ key, label, icon: Icon, disabled, tip }) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                disabled={disabled}
                title={tip}
                onClick={() => setTab(key)}
                className={cn(
                  "btn-press flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-xl border py-2 text-xs font-extrabold transition disabled:cursor-not-allowed disabled:opacity-40",
                  tab === key ? "border-teal-600 bg-teal-50 text-teal-700" : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50",
                )}
              >
                <Icon className="h-5 w-5" aria-hidden />
                {label}
              </button>
            ))}
          </div>

          {!online ? (
            <p className="mb-3 rounded-xl bg-amber-50 px-3 py-2 text-[11px] font-bold text-amber-800">
              أنت غير متصل — الدفع كاش فقط، وسيُرحَّل البيع عند عودة الاتصال
            </p>
          ) : null}

          {/* Cash */}
          {tab === "cash" ? (
            <div>
              <div className="mb-2 grid grid-cols-4 gap-1.5">
                {[
                  { label: "المبلغ بالضبط", v: total },
                  { label: "50", v: 50 },
                  { label: "100", v: 100 },
                  { label: "200", v: 200 },
                ].map((b, i) => (
                  <Button
                    key={i}
                    variant="secondary"
                    onClick={() => setTendered(String(b.v))}
                    className={cn(i === 0 ? "text-xs" : "num")}
                  >
                    {b.label}
                  </Button>
                ))}
              </div>
              <label className="block">
                <span className="mb-1 block text-[11px] font-extrabold text-slate-500">المستلَم من العميل (ر.س)</span>
                <input
                  ref={tenderedRef}
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.01"
                  value={tendered}
                  onChange={(e) => setTendered(e.target.value)}
                  placeholder={fmt2(total)}
                  className="field num text-lg"
                  dir="ltr"
                />
              </label>
              <div
                className={cn(
                  "mt-2 flex items-center justify-between rounded-xl px-4 py-3",
                  cashShort ? "bg-red-50 text-red-700" : "bg-teal-50 text-teal-800",
                )}
              >
                <span className="text-sm font-extrabold">{cashShort ? "المبلغ غير كافٍ" : "الباقي للعميل"}</span>
                <Money value={fmt2(cashShort ? total - tenderedNum : changeDue)} className="text-lg font-extrabold" />
              </div>
              {/* On-screen keypad (touch POS) — edits the same `tendered` state
                  the input above is bound to; the system keyboard still works. */}
              <Numpad value={tendered} onChange={setTendered} className="mt-2" />
            </div>
          ) : null}

          {/* Split */}
          {tab === "split" ? (
            <div>
              <div className="grid grid-cols-3 gap-2">
                <label className="block">
                  <span className="mb-1 flex items-center gap-1 text-[11px] font-extrabold text-slate-500">
                    <Banknote className="h-3.5 w-3.5" aria-hidden /> كاش
                  </span>
                  <input
                    type="number" inputMode="decimal" min={0} step="0.01"
                    value={splitCash}
                    onChange={(e) => setSplitCash(e.target.value)}
                    onFocus={() => setActiveSplitField("cash")}
                    placeholder="0.00" dir="ltr"
                    className={cn("field num", activeSplitField === "cash" && "ring-2 ring-teal-500/60")}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 flex items-center gap-1 text-[11px] font-extrabold text-slate-500">
                    <CreditCard className="h-3.5 w-3.5" aria-hidden /> شبكة
                  </span>
                  <input
                    type="number" inputMode="decimal" min={0} step="0.01"
                    value={splitCard}
                    onChange={(e) => setSplitCard(e.target.value)}
                    onFocus={() => setActiveSplitField("card")}
                    placeholder="0.00" dir="ltr"
                    className={cn("field num", activeSplitField === "card" && "ring-2 ring-teal-500/60")}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 flex items-center gap-1 text-[11px] font-extrabold text-slate-500">
                    <HandCoins className="h-3.5 w-3.5" aria-hidden /> آجل
                  </span>
                  <input
                    type="number" inputMode="decimal" min={0} step="0.01"
                    value={splitCredit}
                    // Guard (not just the `disabled` attribute): a non-supervisor
                    // must never get a nonzero splitCredit into state, from any
                    // input path.
                    onChange={(e) => { if (supervisor) setSplitCredit(e.target.value); }}
                    onFocus={() => setActiveSplitField("credit")}
                    placeholder="0.00" dir="ltr"
                    disabled={!supervisor}
                    title={!supervisor ? "البيع الآجل يتطلب مشرفًا/مديرًا" : undefined}
                    className={cn(
                      "field num disabled:cursor-not-allowed disabled:opacity-40",
                      activeSplitField === "credit" && "ring-2 ring-teal-500/60",
                    )}
                  />
                </label>
              </div>
              <div
                className={cn(
                  "mt-2 flex items-center justify-between rounded-xl px-4 py-3 text-sm font-extrabold",
                  splitError ? "bg-red-50 text-red-700" : "bg-teal-50 text-teal-800",
                )}
                role={splitError ? "alert" : undefined}
              >
                <span>{splitError ? splitError : "المجموع مطابق"}</span>
                <Money value={`${fmt2(splitSum)} / ${fmt2(total)}`} />
              </div>
              {/* On-screen keypad — edits the ACTIVE (ringed) split leg. */}
              <Numpad
                value={activeSplitField === "cash" ? splitCash : activeSplitField === "card" ? splitCard : splitCredit}
                onChange={activeSplitField === "cash" ? setSplitCash : activeSplitField === "card" ? setSplitCard : setSplitCredit}
                className="mt-2"
              />
            </div>
          ) : null}

          {/* Card / credit info line */}
          {tab === "card" ? (
            <p className="rounded-xl bg-slate-50 px-3 py-2.5 text-xs font-bold text-slate-500">
              حصّل <Money value={fmt2(total)} /> ر.س عبر جهاز الشبكة ثم أكّد
            </p>
          ) : null}
          {tab === "credit" ? (
            <p className="rounded-xl bg-slate-50 px-3 py-2.5 text-xs font-bold text-slate-500">
              بيع آجل بقيمة <Money value={fmt2(total)} /> ر.س — يُسجَّل على حساب العميل (يتطلب صلاحية مشرف)
            </p>
          ) : null}

          {/* Owner method info + the notes block ('other' group ⇒ note ≥3 chars) */}
          {ownerMethod ? (
            <div>
              <p className="rounded-xl bg-slate-50 px-3 py-2.5 text-xs font-bold text-slate-500">
                حصّل <Money value={fmt2(total)} /> ر.س عبر «{ownerMethod.nameAr || ownerMethod.name}» ثم أكّد
              </p>
              {noteRequired ? (
                <div className="mt-3">
                  <label className="block">
                    <span className="mb-1 flex items-center justify-between text-[11px] font-extrabold text-slate-500">
                      <span>ملاحظات الدفع — سبب اختيار «{ownerMethod.nameAr || ownerMethod.name}» (إلزامية)</span>
                      <span className="num text-slate-400" dir="ltr" data-testid="pay-notes-counter">
                        {payNote.length}/200
                      </span>
                    </span>
                    <textarea
                      value={payNote}
                      onChange={(e) => setPayNote(e.target.value)}
                      maxLength={200}
                      rows={2}
                      placeholder="مثال: تحويل بنكي — إيصال رقم 123"
                      aria-label="ملاحظات الدفع"
                      className="field resize-none"
                    />
                  </label>
                  {noteTooShort ? (
                    <p role="alert" className="mt-1 rounded-xl bg-amber-50 px-3 py-2 text-[11px] font-bold text-amber-800">
                      اكتب ٣ أحرف على الأقل لوصف الدفعة — الخادم يرفض «أخرى» بلا ملاحظة
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Order-to-Cash: a credit sale must be attached to a real customer. */}
          {creditBlocked ? (
            <p role="alert" className="mt-3 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2.5 text-xs font-extrabold text-amber-800">
              البيع الآجل يتطلب اختيار عميل — اختر عميلًا من السلة أولًا
            </p>
          ) : null}

          <Button variant="primary" size="lg" className="mt-4 w-full" onClick={() => void confirm()} disabled={confirmDisabled}>
            تأكيد الدفع — <Money value={fmt2(total)} /> ر.س
          </Button>
        </div>
      ) : null}

      {/* Working */}
      {phase.name === "working" ? (
        <div className="flex flex-col items-center gap-4 py-10">
          <Loader2 className="h-10 w-10 animate-spin text-teal-600" aria-hidden />
          <p className="text-sm font-extrabold text-slate-600" role="status">
            {STAGE_LABELS[phase.stage]}
          </p>
          <ol className="flex items-center gap-2 text-[11px] font-bold text-slate-400">
            {(["submit", "sale", "complete"] as const).map((s, i) => (
              <li
                key={s}
                className={cn(
                  "rounded-full border px-2.5 py-1",
                  phase.stage === s ? "border-teal-300 bg-teal-50 text-teal-700" : "border-slate-200",
                )}
              >
                {i + 1}. {STAGE_LABELS[s].replace("…", "")}
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {/* Watchdog timeout — an exit instead of an eternal lock */}
      {phase.name === "timeout" ? (
        <div data-testid="pay-timeout-panel" className="flex flex-col items-center gap-3 py-6 text-center">
          <p role="alert" className="rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-extrabold text-amber-800">
            انتهت مهلة الطلب — تحقق من الاتصال ثم أعد المحاولة
          </p>
          <p className="max-w-sm text-xs font-bold text-slate-500">
            لم يُلغَ الطلب — قد يكون البيع وصل للخادم رغم انقطاع الرد. إعادة المحاولة آمنة: إن كان البيع قد سُجّل فلن
            يتكرر (محمي ضد الازدواج)، ويمكنك أيضًا التحقق من «فواتيري».
          </p>
          <div className="grid w-full grid-cols-2 gap-2">
            <Button variant="secondary" onClick={onClose}>
              إغلاق
            </Button>
            <Button variant="primary" onClick={() => void confirm()}>
              إعادة المحاولة
            </Button>
          </div>
        </div>
      ) : null}

      {/* Success */}
      {phase.name === "success" ? (
        <div className="flex flex-col items-center gap-3 py-4 text-center">
          <CheckCircle2 className="h-14 w-14 text-teal-500" aria-hidden />
          {phase.queued ? (
            <>
              <p className="text-lg font-extrabold text-ink">حُفظ الطلب — سيُرحَّل عند عودة الاتصال</p>
              <p className="text-sm font-bold text-slate-500">
                مرجع محلي: <Money value={shortRef(phase.doc.id)} className="text-base" />
              </p>
            </>
          ) : (
            <>
              <p className="text-lg font-extrabold text-ink">تم الدفع بنجاح</p>
              <p className="text-sm font-bold text-slate-500">
                فاتورة: <Money value={phase.invoiceNumber || phase.saleId || shortRef(phase.doc.id)} className="text-base" />
              </p>
            </>
          )}
          {phase.changeDue > 0 ? (
            <p className="rounded-xl bg-saffron-50 px-4 py-2 text-sm font-extrabold text-saffron-600">
              الباقي للعميل: <Money value={fmt2(phase.changeDue)} /> ر.س
            </p>
          ) : null}
          <div className="mt-2 grid w-full grid-cols-2 gap-2">
            <Button variant="secondary" onClick={() => printReceipt(phase)}>
              <Printer className="h-4 w-4" aria-hidden />
              طباعة الإيصال
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                if (!printHtml(buildKitchenTicketHtml(phase.doc))) pushToast("error", "المتصفح منع نافذة الطباعة");
              }}
            >
              <ChefHat className="h-4 w-4" aria-hidden />
              طباعة للمطبخ
            </Button>
            <Button variant="primary" size="lg" className="col-span-2" onClick={finishAndNew}>
              طلب جديد
            </Button>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
