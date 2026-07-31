/**
 * QtyPad — type the quantity instead of tapping «+» eleven times.
 *
 * THE PROBLEM
 *   The cart row rendered its quantity as a plain <span>. "12 bottles of water"
 *   cost 11 taps on «+» — 11 cart mutations, 11 IndexedDB writes, and a real
 *   chance of overshooting in front of a queue.
 *
 * THE SHAPE
 *   The quantity becomes a BUTTON that opens an anchored popover: a large value
 *   display, the EXISTING <Numpad> (imported, never forked — the money grammar
 *   in applyNumpadKey is exactly the grammar a weighed quantity needs), and
 *   Set / Cancel. Setting 0 removes the line, which is the store's existing
 *   `setQty(index, 0)` contract — so the undo affordance comes along for free.
 *
 * WHY position:fixed AND NOT an absolutely-positioned child
 *   The cart's line list is `overflow-y-auto`: an absolutely-positioned popover
 *   would be CLIPPED by that scroll container for the first and last rows. A
 *   fixed popover placed from the trigger's own rect escapes the clip, and is
 *   then clamped into the viewport on both axes — which is what keeps it on
 *   screen at 390px, where the cart is a full-width bottom sheet rather than the
 *   24rem rail. Placement is measured, not guessed: it prefers ABOVE the
 *   trigger and flips BELOW only when there isn't room.
 *
 * The inline `left`/`top` are physical ON PURPOSE: they come from
 * getBoundingClientRect(), which is already physical in both RTL and LTR. There
 * is no logical-property equivalent for "put it exactly where the rect says".
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useT } from "@/i18n/I18nProvider";
import { fmtQty } from "@/lib/format";
import { applyIntegerKey, Numpad } from "./Numpad";
import { Button, cn } from "./ui";

/** Popover width in px. Narrower than the 390px viewport with both margins. */
const POPOVER_W = 240;
/** Minimum gap to any viewport edge. */
const EDGE_MARGIN = 8;
/** A single cart line never legitimately holds more than this. A typo of an
 *  extra digit must not book 99,999 units against a shift. */
export const QTY_MAX = 9999;

/**
 * PURE. Turns the numpad's string into a committable quantity.
 * null = "not committable" — an empty draft or anything non-numeric, so Set
 * stays disabled rather than silently committing Number("") === 0 and deleting
 * the line the cashier only wanted to look at.
 *
 * WHOLE QUANTITIES ONLY. This used to round to 3 decimals for weighed goods.
 * The register sells in whole units, and a fractional quantity was a lie the
 * moment it reached the card badge (fmtInt turned 0.5 into "1" and 0.4 into
 * "0"). A fraction is now REJECTED — Set stays disabled — rather than silently
 * rounded, so the cashier corrects the entry instead of booking a quantity they
 * never typed. `applyIntegerKey` already makes it unreachable from the pad
 * itself; this covers a hardware keyboard and any programmatic caller.
 */
export function parseQtyInput(raw: string): number | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  if (!Number.isInteger(n)) return null;
  return Math.min(n, QTY_MAX);
}

export interface QtyPadProps {
  /** The line's current entered quantity. */
  qty: number;
  /** Display name — used for the accessible names only. */
  itemName: string;
  /** The line's entered unit (كرتون / حبة), shown as context in the popover. */
  unitName?: string | null;
  /** Commit. `0` means "remove this line" (the store already does that). */
  onSubmit: (qty: number) => void;
  className?: string;
}

export function QtyPad({ qty, itemName, unitName, onSubmit, className }: QtyPadProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: EDGE_MARGIN, left: EDGE_MARGIN });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  /** Measure the trigger, prefer ABOVE, flip below, then clamp into view. */
  const place = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const r = trigger.getBoundingClientRect();
    const vw = (typeof window !== "undefined" && window.innerWidth) || 0;
    const vh = (typeof window !== "undefined" && window.innerHeight) || 0;
    const h = popRef.current?.offsetHeight ?? 0;

    const maxLeft = Math.max(EDGE_MARGIN, vw - POPOVER_W - EDGE_MARGIN);
    const left = Math.min(Math.max(r.left, EDGE_MARGIN), maxLeft);

    let top = r.top - h - EDGE_MARGIN;
    if (top < EDGE_MARGIN) top = r.bottom + EDGE_MARGIN;
    const maxTop = Math.max(EDGE_MARGIN, vh - h - EDGE_MARGIN);
    top = Math.min(Math.max(top, EDGE_MARGIN), maxTop);

    setPos({ top, left });
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setDraft("");
    // Focus goes back where it came from — a cashier who escapes out of the pad
    // must not be dumped on <body> with every keyboard shortcut dead.
    triggerRef.current?.focus();
  }, []);

  const commit = useCallback(() => {
    const next = parseQtyInput(draft);
    if (next === null) return;
    onSubmit(next);
    setOpen(false);
    setDraft("");
    triggerRef.current?.focus();
  }, [draft, onSubmit]);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Capture + stop: inside the mobile cart sheet, one Escape must close the
      // PAD, not the sheet underneath it.
      e.stopPropagation();
      close();
    };
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (popRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onPointerDown, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onPointerDown, true);
      window.removeEventListener("resize", place);
    };
  }, [open, close, place]);

  const committable = parseQtyInput(draft);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-testid="qty-trigger"
        onClick={() => {
          setDraft("");
          setOpen((v) => !v);
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("cartPanel.qtyPad.triggerAria", { name: itemName, qty: fmtQty(qty) })}
        className={cn(
          "num btn-press flex min-h-11 min-w-11 items-center justify-center rounded-lg px-1 text-sm font-extrabold text-ink transition hover:bg-white hover:shadow-sm",
          className,
        )}
      >
        {fmtQty(qty)}
      </button>

      {open ? (
        <div
          ref={popRef}
          role="dialog"
          aria-label={t("cartPanel.qtyPad.dialogAria", { name: itemName })}
          style={{ position: "fixed", top: pos.top, left: pos.left, width: POPOVER_W }}
          className="dialog-in z-[60] rounded-2xl border border-slate-200 bg-white p-2.5 shadow-lift"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
          }}
        >
          <p className="mb-1.5 text-[11px] font-extrabold text-slate-500">
            {t("cartPanel.qtyPad.title")}
            {unitName ? <span className="text-teal-600"> · {unitName}</span> : null}
          </p>
          <div
            data-testid="qtypad-value"
            dir="ltr" /* LTR forced: numeric - do not remove, see i18n plan */
            className={cn(
              "num mb-2 rounded-xl bg-slate-50 px-3 py-2 text-center text-2xl font-extrabold",
              draft ? "text-ink" : "text-slate-400",
            )}
          >
            {draft || fmtQty(qty)}
          </div>
          {/* Whole quantities only — the «.» key is inert and the grammar drops
              it, so a fractional quantity cannot be entered at all. */}
          <Numpad value={draft} onChange={setDraft} apply={applyIntegerKey} allowDecimal={false} />
          <p className="mt-1.5 text-center text-[10px] font-bold text-slate-400">{t("cartPanel.qtyPad.removeHint")}</p>
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            <Button size="sm" variant="secondary" onClick={close}>
              {t("cartPanel.qtyPad.cancel")}
            </Button>
            <Button size="sm" variant="primary" disabled={committable === null} onClick={commit}>
              {t("cartPanel.qtyPad.set")}
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}
