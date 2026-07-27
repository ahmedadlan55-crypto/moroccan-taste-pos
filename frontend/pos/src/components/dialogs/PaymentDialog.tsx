/**
 * PaymentDialog — method tabs (كاش/شبكة/مختلط/آجل), cash quick-tender with
 * change math, mixed split with live validation, then the submit→sales→
 * complete chain with visible progress. Offline: CASH ONLY, queued for
 * replay ("سيُرحَّل عند عودة الاتصال") with a local reference.
 *
 * LAYOUT CONTRACT — THE KEYPAD NEVER MOVES.
 *   The on-screen Numpad used to render only inside the cash tab and inside
 *   the split block, so it appeared, vanished and jumped as the cashier moved
 *   between methods; a thumb cannot learn a target that moves. There is now
 *   exactly ONE <Numpad>, mounted once, always in the same slot (below the
 *   method-specific fields, above Confirm), on every tab. What it drives
 *   changes, its position does not:
 *     cash   → the tendered amount
 *     split  → the ACTIVE (ringed) leg
 *     card   → the terminal/approval reference (reference grammar, not money)
 *     owner  → the same reference, when the method's group carries a slip
 *     credit → inert (dimmed, keys disabled) — the amount is fixed and there
 *              is no slip; a one-line hint above the pad says why
 *   The method-fields region carries a min-height so the pad's top edge is at
 *   the same offset on every tab, not merely "somewhere below".
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  Banknote,
  CheckCircle2,
  ChefHat,
  Clock,
  CreditCard,
  HandCoins,
  Hash,
  Loader2,
  Printer,
  SplitSquareHorizontal,
  Wallet,
} from "lucide-react";
import { usePos } from "@/state/store";
import { round2, paymentsError } from "@/lib/cartMath";
import { tenderLadder } from "@/lib/tender";
import { fmt2, shortRef } from "@/lib/format";
import {
  buildKitchenTicketHtml,
  buildReceiptHtml,
  printHtml,
  printHtmlInto,
  resolveAutoPrint,
  resolvePaperWidth,
} from "@/lib/receipt";
import type { CatalogPaymentMethod, LocalOrder, Payment } from "@/lib/types";
import { useLang, useT } from "@/i18n/I18nProvider";
import { translateApiError } from "@/i18n/errorCodes";
import { Dialog } from "../Dialog";
import { applyReferenceKey, Numpad, type NumpadKey } from "../Numpad";
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

/** Owner-method groups that hand the cashier a slip with a number on it, so
 *  the always-present keypad has something real to type. Derived from the
 *  catalog's existing `groupType` — no new server field. */
const REFERENCE_GROUPS = new Set(["card", "bank", "transfer", "wallet", "cheque", "check", "online"]);

/** Does this owner method take a reference/approval number? ('other' does not:
 *  its entry is the mandatory free-text note, not a number.) */
function methodTakesReference(m: CatalogPaymentMethod | null): boolean {
  if (!m || methodNeedsNote(m)) return false;
  return REFERENCE_GROUPS.has(String(m.groupType ?? "").toLowerCase());
}

/** What the one permanent keypad is wired to right now. */
interface PadSpec {
  value: string;
  onChange: (next: string) => void;
  /** Absent → the money grammar (applyNumpadKey). */
  apply?: (value: string, key: NumpadKey) => string;
  /** Visible but inert — the pad must never disappear between tabs. */
  disabled: boolean;
  /** One line, always rendered, saying what the pad types (or why it can't). */
  hint: string;
}

/** Ladder buttons read as tender notes: "50", not "50.00" — but a non-round
 *  exact amount still needs its halalas. */
function tenderLabel(value: number): string {
  return Number.isInteger(value) ? String(value) : fmt2(value);
}

export interface PaymentDialogProps {
  open: boolean;
  onClose: () => void;
  /**
   * Hand off to the FULL ShiftDialog when the cashier has no open shift.
   * Optional so the dialog still renders standalone (and in specs) — when it
   * is absent the banner simply has no button, exactly as before.
   *
   * It must open the real dialog, NEVER an inline zero-float open: a shift
   * opened without its counted float silently corrupts the Z-report.
   */
  onOpenShift?: () => void;
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

export function PaymentDialog({ open, onClose, onOpenShift }: PaymentDialogProps) {
  const t = useT();
  const lang = useLang();
  const { cart, totals, engine, engineStatus, supervisor, posCan, user, catalog, startNewOrder, loadOrderDoc, pushToast, shiftId, o2cEnabled } = usePos();
  // Capability-aware: a non-supervisor with the granted capability also
  // unlocks البيع الآجل (broadening only — see lib/capabilities.ts). Every
  // `supervisor` reference below that gates credit uses this instead.
  const canCredit = supervisor || posCan("pos.sale.credit");
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
  /** Terminal/approval number for card + slip-bearing owner methods. */
  const [reference, setReference] = useState<string>("");
  const [phase, setPhase] = useState<Phase>({ name: "form" });
  const tenderedRef = useRef<HTMLInputElement>(null);
  // Which split leg the on-screen numpad edits (touch POS): the last-focused
  // amount field, highlighted with a ring. Cash tab always edits `tendered`.
  const [activeSplitField, setActiveSplitField] = useState<"cash" | "card" | "credit">("cash");

  // ── Auto-print (owner setting ReceiptAutoPrint) ────────────────────────────
  // resolveAutoPrint() was defined, exported and unit-tested but had ZERO
  // non-test callers, so «طباعة تلقائية» silently did nothing on every till.
  //
  // It cannot be fired from an effect after the checkout await: printHtml opens
  // a window and by then the user-gesture task is long gone, so the popup is
  // blocked. The window is therefore opened SYNCHRONOUSLY inside the confirm
  // CLICK handler and parked in a REF — never state: StrictMode double-invokes
  // effects, and a state-driven print would run twice and print two receipts.
  const autoPrintOn = resolveAutoPrint(catalog);
  const autoPrintWinRef = useRef<Window | null>(null);

  /** Discard an un-handed-over print window (failure / timeout / dialog close /
   *  unmount). Once a receipt has been WRITTEN into the window the ref is
   *  cleared first, so this can never close a window that is mid-print. */
  const releaseAutoPrintWindow = useCallback(() => {
    const w = autoPrintWinRef.current;
    autoPrintWinRef.current = null;
    try {
      w?.close();
    } catch {
      /* already gone */
    }
  }, []);

  // A blank print window must never outlive the component.
  useEffect(() => releaseAutoPrintWindow, [releaseAutoPrintWindow]);

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
      setReference("");
      setActiveSplitField("cash");
      setPhase({ name: "form" });
    } else {
      // Closed without an outcome (Esc / backdrop): drop any parked window.
      releaseAutoPrintWindow();
    }
  }, [open, releaseAutoPrintWindow]);

  // Offline forces cash.
  useEffect(() => {
    if (!online && tab !== "cash") setTab("cash");
  }, [online, tab]);

  // An owner tab whose method vanished from the catalog (owner edit mid-shift)
  // falls back to cash rather than confirming against a ghost method.
  useEffect(() => {
    if (tab.startsWith("owner:") && !ownerMethod) setTab("cash");
  }, [tab, ownerMethod]);

  // The split tab's آجل leg requires a supervisor (or the equivalent
  // capability), same as the dedicated credit tab — if that status drops
  // mid-session (or the dialog was left open), a stale nonzero value must not
  // silently keep counting toward the split sum once the field is disabled.
  useEffect(() => {
    if (!canCredit) setSplitCredit("");
  }, [canCredit]);

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
      // The effect is torn down the moment the phase leaves 'working', so
      // reaching here means the sale never answered: the blank auto-print
      // window would otherwise sit on the till forever.
      releaseAutoPrintWindow();
    }, CHECKOUT_WATCHDOG_MS);
    return () => clearTimeout(t);
  }, [phase.name, releaseAutoPrintWindow]);

  const tenderedNum = Number(tendered) || 0;
  const changeDue = round2(Math.max(0, tenderedNum - total));
  const cashShort = tab === "cash" && tendered !== "" && tenderedNum < total;

  /** Quick-tender buttons, DERIVED from this bill (lib/tender.ts) instead of
   *  the old hardcoded exact/50/100/200 — which offered notes below the total
   *  and had no 500 at all. Slot 0 is always the exact amount. */
  const ladder = useMemo(() => tenderLadder(total), [total]);

  /** The split آجل leg is supervisor-gated: NOTHING may write a nonzero value
   *  into it without the permission — not the input, not the keypad, not
   *  fill-remainder. One guarded setter is the single write path. */
  const setSplitCreditGuarded = useCallback(
    (next: string) => {
      if (canCredit) setSplitCredit(next);
    },
    [canCredit],
  );

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
          t,
        )
      : null;

  // ── Split: the ACTIVE leg + fill-remainder ─────────────────────────────────
  // The cashier used to compute 23.50 on a 73.50 bill with 50 already in cash
  // and type it digit by digit while the error banner flashed red on every
  // keystroke. One button now does it.
  const activeLegValue = activeSplitField === "cash" ? splitCash : activeSplitField === "card" ? splitCard : splitCredit;
  const setActiveLeg =
    activeSplitField === "cash" ? setSplitCash : activeSplitField === "card" ? setSplitCard : setSplitCreditGuarded;
  /** The active leg is unwritable exactly when it is the credit leg without
   *  the credit permission — fill-remainder must then be a NO-OP. */
  const activeLegLocked = activeSplitField === "credit" && !canCredit;
  const splitRemainder = round2(Math.max(0, total - round2(splitSum - (Number(activeLegValue) || 0))));
  const fillRemainder = useCallback(() => {
    if (activeLegLocked) return; // credit-leg guard — never writes
    setActiveLeg(String(splitRemainder));
  }, [activeLegLocked, setActiveLeg, splitRemainder]);

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

  // Split's آجل leg needs a supervisor (or the capability) too — checked
  // BEFORE any network call, even when the arithmetic sum already matches the
  // total (a role gate, not a sum-mismatch check).
  const splitCreditNeedsSupervisor = tab === "split" && !canCredit && splitCreditNum > 0;

  const confirmDisabled =
    total <= 0 ||
    (tab === "cash" && tendered !== "" && tenderedNum < total) ||
    (tab === "split" && !!splitError) ||
    splitCreditNeedsSupervisor ||
    creditBlocked ||
    noteTooShort ||
    !effectiveShiftId;

  // ── The one permanent keypad ───────────────────────────────────────────────
  /** Tabs that show a reference/approval field (and so give the pad digits to
   *  type). Card always does; an owner method does when its group carries a
   *  slip. Never on cash/split (they type money) or credit (no slip exists). */
  const showReference = tab === "card" || methodTakesReference(ownerMethod);
  const referenceTrimmed = reference.trim();

  const pad: PadSpec =
    tab === "cash"
      ? { value: tendered, onChange: setTendered, disabled: false, hint: t("paymentDialog.padHint.cash") }
      : tab === "split"
        ? {
            value: activeLegValue,
            onChange: setActiveLeg,
            disabled: activeLegLocked,
            hint: activeLegLocked ? t("paymentDialog.creditNeedsSupervisorTip") : t("paymentDialog.padHint.split"),
          }
        : showReference
          ? {
              value: reference,
              onChange: setReference,
              // NOT the money grammar: "0042" ≠ "42" on a terminal slip.
              apply: applyReferenceKey,
              disabled: false,
              hint: t("paymentDialog.padHint.reference"),
            }
          : {
              // Inert — still on screen, still the same size, still the same
              // spot; only the keys are dead, with the reason spelled out.
              value: "",
              onChange: () => {},
              disabled: true,
              hint:
                tab === "credit"
                  ? t("paymentDialog.padHint.inertCredit")
                  : noteRequired
                    ? t("paymentDialog.padHint.inertNote")
                    : t("paymentDialog.padHint.inertFixed"),
            };

  /** The free-text note the server stores: the mandatory 'other' note, the
   *  typed reference, or both. Empty on every path that typed neither, so the
   *  existing "no note ⇒ paymentNotes undefined" contract is unchanged. */
  function paymentNotesPayload(): string | undefined {
    const parts: string[] = [];
    if (noteRequired && payNote.trim()) parts.push(payNote.trim());
    if (showReference && referenceTrimmed) parts.push(`${t("paymentDialog.referenceNotePrefix")}${referenceTrimmed}`);
    return parts.length ? parts.join(" — ") : undefined;
  }

  /** The reference/approval field — shared by the card tab and slip-bearing
   *  owner methods, and the target of the keypad on both. */
  function referenceField() {
    return (
      <label className="mt-3 block">
        <span className="mb-1 flex items-center gap-1 text-[11px] font-extrabold text-slate-500">
          <Hash className="h-3.5 w-3.5" aria-hidden /> {t("paymentDialog.referenceLabel")}
        </span>
        <input
          type="text"
          inputMode="numeric"
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          placeholder={t("paymentDialog.referencePlaceholder")}
          maxLength={32}
          dir="ltr" /* LTR forced: numeric/phone - do not remove, see i18n plan */
          className="field num"
        />
      </label>
    );
  }

  async function confirm() {
    // 'timeout' allows a RETRY: safe — the sale dedupes on clientOrderId
    // (= the doc id) server-side, so a landed first attempt is replayed, not
    // duplicated (same guarantee legacy leaned on, app.js:2756-2766).
    if (phase.name !== "form" && phase.name !== "timeout") return;
    // A retry after the watchdog: never leak the previous attempt's window.
    releaseAutoPrintWindow();
    // SYNCHRONOUS, still inside the click task — the ONLY moment the browser
    // will hand us a window (see the autoPrintOn block above). A blocked open
    // returns null; that is detected at write time and toasted, and the manual
    // «طباعة الإيصال» button below still works.
    if (autoPrintOn) autoPrintWinRef.current = window.open("", "_blank", "width=420,height=640");
    const snapshot: LocalOrder = { ...cart, lines: cart.lines.map((l) => ({ ...l })) };
    const cashTendered = tab === "cash" ? (tendered === "" ? total : tenderedNum) : 0;
    const change = tab === "cash" ? round2(Math.max(0, cashTendered - total)) : 0;
    setPhase({ name: "working", stage: "submit" });
    try {
      const outcome = await engine.checkout(snapshot, payments, {
        cashTendered,
        changeDue: change,
        // The 'other'-group note (already gated ≥3 chars by confirmDisabled)
        // and/or the typed terminal reference. Undefined when neither exists.
        paymentNotes: paymentNotesPayload(),
      });
      if (outcome.state === "failed") {
        // The engine reopened the doc server-side + locally; reload the fresh
        // copy so the cart stays editable (status back to 'open').
        releaseAutoPrintWindow();
        const fresh = await engine.getOrder(snapshot.id);
        if (fresh) loadOrderDoc(fresh);
        setPhase({ name: "failed", error: outcome.error || t("paymentDialog.failedDefault") });
        return;
      }
      const success: Extract<Phase, { name: "success" }> = {
        name: "success",
        invoiceNumber: outcome.invoiceNumber,
        saleId: outcome.saleId,
        queued: outcome.state === "queued",
        doc: snapshot,
        payments,
        cashTendered,
        changeDue: change,
        zatcaQrDataUrl: outcome.zatcaQrDataUrl ?? null,
      };
      setPhase(success);
      autoPrintReceipt(success);
    } catch (e) {
      releaseAutoPrintWindow();
      const fresh = await engine.getOrder(snapshot.id);
      if (fresh) loadOrderDoc(fresh);
      setPhase({ name: "failed", error: translateApiError(e, t) });
    }
  }

  function finishAndNew() {
    startNewOrder();
    onClose();
  }

  /** The sale receipt for a completed phase — ONE builder, shared by the manual
   *  button and auto-print, so the two can never drift apart again. */
  function receiptHtmlFor(p: Extract<Phase, { name: "success" }>): string {
    return buildReceiptHtml({
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
      // The owner's ReceiptPaperWidth was NEVER passed on the sale path, so
      // buildReceiptHtml fell back to 80mm: a 58mm shop got every fresh sale
      // clipped while a REPRINT of the same sale (MyInvoicesDialog, which does
      // pass it) came out right — which reads as a printer fault, not a bug.
      paperWidth: resolvePaperWidth(catalog),
    });
  }

  function printReceipt(p: Extract<Phase, { name: "success" }>) {
    if (!printHtml(receiptHtmlFor(p))) pushToast("error", t("paymentDialog.printBlockedFull"));
  }

  /** Hand the completed sale to the window opened during the confirm click.
   *  Blocked or already gone ⇒ toast and leave the manual button as the
   *  fallback; a receipt is never silently dropped. */
  function autoPrintReceipt(p: Extract<Phase, { name: "success" }>) {
    if (!autoPrintOn) return;
    const win = autoPrintWinRef.current;
    autoPrintWinRef.current = null; // handed over — cleanup must NOT close it
    if (!printHtmlInto(receiptHtmlFor(p), win)) {
      pushToast("error", t("paymentDialog.printBlockedFull"));
    }
  }

  const locked = phase.name === "working";

  // Checkout progress stage labels — built here (not module scope) since
  // t() is only available inside the component.
  const stageLabels: Record<"submit" | "sale" | "complete", string> = {
    submit: t("paymentDialog.stageSubmit"),
    sale: t("paymentDialog.stageSale"),
    complete: t("paymentDialog.stageComplete"),
  };

  return (
    <Dialog
      open={open}
      onClose={phase.name === "success" ? finishAndNew : onClose}
      title={t("paymentDialog.title")}
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

          {/* No open shift — a dead end until now: the banner said "open one
              from the top bar", Confirm was disabled, and the cashier had to
              close the dialog, hunt the header button and rebuild their route
              back. The button hands off to the FULL ShiftDialog (the opening
              float MUST be counted — an inline zero-float open corrupts the
              Z-report), and App re-opens payment afterwards. */}
          {!effectiveShiftId ? (
            <div role="alert" className="mb-3 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-800">
              <p>{t("paymentDialog.noShiftOpen")}</p>
              {onOpenShift ? (
                <Button variant="dark" size="sm" className="mt-2 w-full" onClick={onOpenShift}>
                  <Clock className="h-4 w-4" aria-hidden />
                  {t("paymentDialog.openShiftButton")}
                </Button>
              ) : null}
            </div>
          ) : null}

          {/* Total */}
          <div className="mb-4 rounded-2xl bg-ink px-5 py-4 text-center text-white">
            <p className="text-xs font-bold text-slate-300">{t("paymentDialog.totalDue")}</p>
            <p className="text-3xl font-extrabold">
              <Money value={fmt2(total)} /> <span className="text-sm font-bold text-slate-300">{t("paymentDialog.currency")}</span>
            </p>
          </div>

          {/* Method tiles — built-ins always; owner methods appended (pay-method-tiles) */}
          <div className="mb-4 grid grid-cols-4 gap-1.5" role="tablist" aria-label={t("paymentDialog.methodTablistLabel")}>
            {(
              [
                { key: "cash" as Tab, label: t("paymentDialog.methodCash"), icon: Banknote, disabled: false, tip: undefined },
                {
                  key: "card" as Tab,
                  label: t("paymentDialog.methodCard"),
                  icon: CreditCard,
                  disabled: !online,
                  tip: !online ? t("paymentDialog.cardOfflineTip") : undefined,
                },
                {
                  key: "split" as Tab,
                  label: t("paymentDialog.methodSplit"),
                  icon: SplitSquareHorizontal,
                  disabled: !online,
                  tip: !online ? t("paymentDialog.splitOfflineTip") : undefined,
                },
                {
                  key: "credit" as Tab,
                  label: t("paymentDialog.methodCredit"),
                  icon: HandCoins,
                  disabled: !online || !canCredit,
                  tip: !online
                    ? t("paymentDialog.creditOfflineTip")
                    : !canCredit
                      ? t("paymentDialog.creditNeedsSupervisorTip")
                      : undefined,
                },
                ...ownerMethods.map((m) => ({
                  key: `owner:${m.name}` as Tab,
                  label: m.nameAr || m.name,
                  icon: Wallet,
                  disabled: !online,
                  tip: !online ? t("paymentDialog.ownerMethodOfflineTip") : undefined,
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
              {t("paymentDialog.offlineBanner")}
            </p>
          ) : null}

          {/* ── Method-specific fields ──────────────────────────────────────
              The min-height is load-bearing, not decoration: it pins the
              BOTTOM of this region so the single keypad below starts at the
              same offset on cash / card / split / credit. Without it the pad
              would still slide up and down as the taller cash and split
              layouts gave way to the one-line card/credit ones. */}
          <div className="min-h-[11rem]">
          {/* Cash */}
          {tab === "cash" ? (
            <div>
              {/* Derived tender ladder (lib/tender.ts): exact amount, the
                  round-up reflexes, then the notes the customer is actually
                  holding. One row, never wraps — the column count follows the
                  ladder length instead of a fixed grid-cols-4. */}
              {ladder.length > 0 ? (
                <div
                  className="mb-2 grid gap-1.5"
                  style={{ gridTemplateColumns: `repeat(${ladder.length}, minmax(0, 1fr))` }}
                >
                  {ladder.map((v, i) => (
                    <Button
                      key={v}
                      variant="secondary"
                      onClick={() => setTendered(String(v))}
                      className={cn("px-1", i === 0 ? "text-[11px] leading-tight" : "num")}
                    >
                      {i === 0 ? t("paymentDialog.exactAmount") : tenderLabel(v)}
                    </Button>
                  ))}
                </div>
              ) : null}
              <label className="block">
                <span className="mb-1 block text-[11px] font-extrabold text-slate-500">{t("paymentDialog.tenderedLabel")}</span>
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
                  dir="ltr" /* LTR forced: numeric/phone - do not remove, see i18n plan */
                />
              </label>
              <div
                className={cn(
                  "mt-2 flex items-center justify-between rounded-xl px-4 py-3",
                  cashShort ? "bg-red-50 text-red-700" : "bg-teal-50 text-teal-800",
                )}
              >
                <span className="text-sm font-extrabold">
                  {cashShort ? t("paymentDialog.insufficientAmount") : t("paymentDialog.changeDueLabel")}
                </span>
                <Money value={fmt2(cashShort ? total - tenderedNum : changeDue)} className="text-lg font-extrabold" />
              </div>
            </div>
          ) : null}

          {/* Split */}
          {tab === "split" ? (
            <div>
              <div className="grid grid-cols-3 gap-2">
                <label className="block">
                  <span className="mb-1 flex items-center gap-1 text-[11px] font-extrabold text-slate-500">
                    <Banknote className="h-3.5 w-3.5" aria-hidden /> {t("paymentDialog.methodCash")}
                  </span>
                  <input
                    type="number" inputMode="decimal" min={0} step="0.01"
                    value={splitCash}
                    onChange={(e) => setSplitCash(e.target.value)}
                    onFocus={() => setActiveSplitField("cash")}
                    placeholder="0.00"
                    dir="ltr" /* LTR forced: numeric/phone - do not remove, see i18n plan */
                    className={cn("field num", activeSplitField === "cash" && "ring-2 ring-teal-500/60")}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 flex items-center gap-1 text-[11px] font-extrabold text-slate-500">
                    <CreditCard className="h-3.5 w-3.5" aria-hidden /> {t("paymentDialog.methodCard")}
                  </span>
                  <input
                    type="number" inputMode="decimal" min={0} step="0.01"
                    value={splitCard}
                    onChange={(e) => setSplitCard(e.target.value)}
                    onFocus={() => setActiveSplitField("card")}
                    placeholder="0.00"
                    dir="ltr" /* LTR forced: numeric/phone - do not remove, see i18n plan */
                    className={cn("field num", activeSplitField === "card" && "ring-2 ring-teal-500/60")}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 flex items-center gap-1 text-[11px] font-extrabold text-slate-500">
                    <HandCoins className="h-3.5 w-3.5" aria-hidden /> {t("paymentDialog.methodCredit")}
                  </span>
                  <input
                    type="number" inputMode="decimal" min={0} step="0.01"
                    value={splitCredit}
                    // Guard (not just the `disabled` attribute): a user without
                    // credit permission must never get a nonzero splitCredit
                    // into state, from any input path — typing, the keypad, or
                    // fill-remainder. They all go through setSplitCreditGuarded.
                    onChange={(e) => setSplitCreditGuarded(e.target.value)}
                    onFocus={() => setActiveSplitField("credit")}
                    placeholder="0.00"
                    dir="ltr" /* LTR forced: numeric/phone - do not remove, see i18n plan */
                    disabled={!canCredit}
                    title={!canCredit ? t("paymentDialog.creditNeedsSupervisorTip") : undefined}
                    className={cn(
                      "field num disabled:cursor-not-allowed disabled:opacity-40",
                      activeSplitField === "credit" && "ring-2 ring-teal-500/60",
                    )}
                  />
                </label>
              </div>
              {/* Fill-remainder — the whole point of the split screen is that
                  the legs must sum to the total, and until now the cashier did
                  that subtraction in their head and typed it digit by digit
                  while the banner flashed red on every keystroke. */}
              <Button
                variant="secondary"
                aria-label={t("paymentDialog.splitFillRemainderAria")}
                onClick={fillRemainder}
                disabled={activeLegLocked || splitRemainder <= 0}
                className="mt-2 min-h-11 w-full text-xs"
              >
                <ArrowDownToLine className="h-4 w-4" aria-hidden />
                {t("paymentDialog.splitRemaining", { amount: fmt2(splitRemainder) })}
              </Button>
              <div
                className={cn(
                  "mt-2 flex items-center justify-between rounded-xl px-4 py-3 text-sm font-extrabold",
                  splitError ? "bg-red-50 text-red-700" : "bg-teal-50 text-teal-800",
                )}
                role={splitError ? "alert" : undefined}
              >
                <span>{splitError ? splitError : t("paymentDialog.splitSumMatches")}</span>
                <Money value={`${fmt2(splitSum)} / ${fmt2(total)}`} />
              </div>
            </div>
          ) : null}

          {/* Card — info line + the approval number the keypad now types */}
          {tab === "card" ? (
            <div>
              <p className="rounded-xl bg-slate-50 px-3 py-2.5 text-xs font-bold text-slate-500">
                {t("paymentDialog.cardCollectInfoPrefix")} <Money value={fmt2(total)} /> {t("paymentDialog.currency")}{" "}
                {t("paymentDialog.cardCollectInfoSuffix")}
              </p>
              {referenceField()}
            </div>
          ) : null}
          {/* Credit — the amount is fixed at the total and there is no slip, so
              this tab is the one with nothing to type: the pad stays put and
              goes inert (see the PadSpec above). */}
          {tab === "credit" ? (
            <p className="rounded-xl bg-slate-50 px-3 py-2.5 text-xs font-bold text-slate-500">
              {t("paymentDialog.creditInfoPrefix")} <Money value={fmt2(total)} /> {t("paymentDialog.currency")}{" "}
              {t("paymentDialog.creditInfoSuffix")}
            </p>
          ) : null}

          {/* Owner method info + the notes block ('other' group ⇒ note ≥3 chars) */}
          {ownerMethod ? (
            <div>
              <p className="rounded-xl bg-slate-50 px-3 py-2.5 text-xs font-bold text-slate-500">
                {t("paymentDialog.cardCollectInfoPrefix")} <Money value={fmt2(total)} /> {t("paymentDialog.currency")}{" "}
                {t("paymentDialog.ownerCollectInfoMiddle")}
                {ownerMethod.nameAr || ownerMethod.name}
                {t("paymentDialog.ownerCollectInfoSuffix")}
              </p>
              {noteRequired ? (
                <div className="mt-3">
                  <label className="block">
                    <span className="mb-1 flex items-center justify-between text-[11px] font-extrabold text-slate-500">
                      <span>
                        {t("paymentDialog.ownerNoteLabelPrefix")}
                        {ownerMethod.nameAr || ownerMethod.name}
                        {t("paymentDialog.ownerNoteLabelSuffix")}
                      </span>
                      <span
                        className="num text-slate-400"
                        dir="ltr" /* LTR forced: numeric/phone - do not remove, see i18n plan */
                        data-testid="pay-notes-counter"
                      >
                        {payNote.length}/200
                      </span>
                    </span>
                    <textarea
                      value={payNote}
                      onChange={(e) => setPayNote(e.target.value)}
                      maxLength={200}
                      rows={2}
                      placeholder={t("paymentDialog.ownerNotePlaceholder")}
                      aria-label={t("paymentDialog.paymentNotesAriaLabel")}
                      className="field resize-none"
                    />
                  </label>
                  {noteTooShort ? (
                    <p role="alert" className="mt-1 rounded-xl bg-amber-50 px-3 py-2 text-[11px] font-bold text-amber-800">
                      {t("paymentDialog.noteTooShortWarning")}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {/* Owner methods whose group carries a slip get the same
                  reference field — and therefore the same live keypad. */}
              {showReference ? referenceField() : null}
            </div>
          ) : null}

          {/* Order-to-Cash: a credit sale must be attached to a real customer.
              Kept INSIDE the fields region so it eats the min-height slack
              instead of pushing the keypad down. */}
          {creditBlocked ? (
            <p role="alert" className="mt-3 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2.5 text-xs font-extrabold text-amber-800">
              {t("paymentDialog.creditBlockedWarning")}
            </p>
          ) : null}
          </div>

          {/* ── The keypad — SAME SLOT ON EVERY TAB ───────────────────────────
              Mounted once, unconditionally. `pad` decides what it edits (and
              whether it edits anything at all); the hint line above it is
              always rendered, so even the wording changing cannot move the
              keys. The system keyboard still works on every bound input. */}
          <p className="mt-3 text-[11px] font-bold text-slate-400" data-testid="numpad-hint">
            {pad.hint}
          </p>
          <Numpad
            value={pad.value}
            onChange={pad.onChange}
            apply={pad.apply}
            disabled={pad.disabled}
            className="mt-1"
          />

          <Button variant="primary" size="lg" className="mt-4 w-full" onClick={() => void confirm()} disabled={confirmDisabled}>
            {t("paymentDialog.confirmButtonPrefix")} <Money value={fmt2(total)} /> {t("paymentDialog.currency")}
          </Button>
        </div>
      ) : null}

      {/* Working */}
      {phase.name === "working" ? (
        <div className="flex flex-col items-center gap-4 py-10">
          <Loader2 className="h-10 w-10 animate-spin text-teal-600" aria-hidden />
          <p className="text-sm font-extrabold text-slate-600" role="status">
            {stageLabels[phase.stage]}
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
                {i + 1}. {stageLabels[s].replace("…", "")}
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {/* Watchdog timeout — an exit instead of an eternal lock */}
      {phase.name === "timeout" ? (
        <div data-testid="pay-timeout-panel" className="flex flex-col items-center gap-3 py-6 text-center">
          <p role="alert" className="rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-extrabold text-amber-800">
            {t("paymentDialog.timeoutTitle")}
          </p>
          <p className="max-w-sm text-xs font-bold text-slate-500">{t("paymentDialog.timeoutBody")}</p>
          <div className="grid w-full grid-cols-2 gap-2">
            <Button variant="secondary" onClick={onClose}>
              {t("common.close")}
            </Button>
            <Button variant="primary" onClick={() => void confirm()}>
              {t("common.retry")}
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
              <p className="text-lg font-extrabold text-ink">{t("paymentDialog.queuedTitle")}</p>
              <p className="text-sm font-bold text-slate-500">
                {t("paymentDialog.localRefLabel")} <Money value={shortRef(phase.doc.id)} className="text-base" />
              </p>
            </>
          ) : (
            <>
              <p className="text-lg font-extrabold text-ink">{t("paymentDialog.successTitle")}</p>
              <p className="text-sm font-bold text-slate-500">
                {t("paymentDialog.invoiceLabel")}{" "}
                <Money value={phase.invoiceNumber || phase.saleId || shortRef(phase.doc.id)} className="text-base" />
              </p>
            </>
          )}
          {phase.changeDue > 0 ? (
            <p className="rounded-xl bg-saffron-50 px-4 py-2 text-sm font-extrabold text-saffron-600">
              {t("paymentDialog.changeDueLabelColon")} <Money value={fmt2(phase.changeDue)} /> {t("paymentDialog.currency")}
            </p>
          ) : null}
          <div className="mt-2 grid w-full grid-cols-2 gap-2">
            <Button variant="secondary" onClick={() => printReceipt(phase)}>
              <Printer className="h-4 w-4" aria-hidden />
              {t("paymentDialog.printReceiptButton")}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                // Paper width AND language were both defaulted away here: the
                // ticket printed 80mm Arabic on an English 58mm till, and the
                // whole receipt.kitchen.* English namespace was unreachable.
                if (!printHtml(buildKitchenTicketHtml(phase.doc, resolvePaperWidth(catalog), lang))) {
                  pushToast("error", t("paymentDialog.printBlockedShort"));
                }
              }}
            >
              <ChefHat className="h-4 w-4" aria-hidden />
              {t("paymentDialog.printKitchenButton")}
            </Button>
            <Button variant="primary" size="lg" className="col-span-2" onClick={finishAndNew}>
              {t("paymentDialog.newOrderButton")}
            </Button>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
