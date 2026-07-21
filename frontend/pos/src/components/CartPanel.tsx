/**
 * Cart panel (left column in RTL) — lines with qty steppers + inline
 * notes/line-discount editor, order type, customer quick-attach, order
 * discount, totals, actions (hold / held board / void / pay).
 */
import { useState } from "react";
import { useT } from "@/i18n/I18nProvider";
import { CustomerPicker } from "./CustomerPicker";
import {
  BadgePercent,
  Banknote,
  Bike,
  ChevronDown,
  ChevronUp,
  Minus,
  PauseCircle,
  Phone,
  Plus,
  ShoppingBasket,
  Tag,
  Trash2,
  UserPlus,
  Utensils,
  XCircle,
} from "lucide-react";
import { usePos } from "@/state/store";
import { fmt2, fmtInt } from "@/lib/format";
import { lineTotals, orderDiscountPct, round2 } from "@/lib/cartMath";
import { presetLineAmount, presetsForScope, useDiscountPresets } from "@/lib/discountPresets";
import type { CartLine, OrderType } from "@/lib/types";
import { Button, cn, EmptyState, Money } from "./ui";
import { UnitPicker } from "./UnitPicker";

const ORDER_TYPES: Array<{ value: OrderType; labelKey: string; icon: typeof Utensils }> = [
  { value: "dine_in", labelKey: "cartPanel.orderTypes.dineIn", icon: Utensils },
  { value: "takeaway", labelKey: "cartPanel.orderTypes.takeaway", icon: ShoppingBasket },
  { value: "delivery", labelKey: "cartPanel.orderTypes.delivery", icon: Bike },
];

function CartLineRow({ line, index }: { line: CartLine; index: number }) {
  const t = useT();
  const { setQty, setLineUnit, removeLine, setLineNotes, setLineDiscount, catalog } = usePos();
  const [expanded, setExpanded] = useState(false);
  const lineTotal = lineTotals(line);
  const item = catalog?.items.find((i) => i.id === line.menuId) || null;
  const units = item?.units || [];
  const baseUnitName = item?.baseUnitName || null;
  const factor = Number(line.conversionFactorSnapshot) || 1;
  const baseQty = Number(line.baseQty ?? line.qty);
  const isMajor = factor > 1 && !!line.enteredUnitName;
  // Preset discounts for the line editor (loaded once per session, only when a
  // row is actually expanded). A preset fills the SAME amount field manual
  // entry uses — the store/math clamp path is unchanged (close/w25-sell-ui).
  const linePresets = presetsForScope(useDiscountPresets(expanded), "line");
  // True line gross (baseQty × unit price) — matches the cartMath clamp, so a
  // carton line discounts its real total, not the entered-qty figure.
  const lineGross = round2(baseQty * line.unitPrice);

  return (
    <li className="rounded-xl border border-slate-100 bg-white shadow-sm">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 p-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex min-h-11 min-w-0 items-center gap-1 text-start"
          aria-expanded={expanded}
          aria-label={t("cartPanel.line.detailsAria", { name: line.name })}
        >
          <span className="min-w-0 flex-1">
            <span className="line-clamp-2 block break-words text-sm font-extrabold leading-tight text-ink [overflow-wrap:anywhere]" title={line.name}>{line.name}</span>
            <span className="mt-0.5 block break-words text-[11px] font-bold text-slate-400">
              <Money value={fmt2(line.unitPrice)} /> {t("cartPanel.currency")}{isMajor && baseUnitName ? `/${baseUnitName}` : ""}
              {isMajor ? (
                <span className="ms-1.5 text-teal-600">
                  = <span className="num">{fmt2(baseQty)}</span> {baseUnitName || ""}
                </span>
              ) : null}
              {line.lineDiscount > 0 ? (
                <span className="ms-1.5 text-saffron-600">
                  {t("cartPanel.line.discountPrefix")} <Money value={fmt2(line.lineDiscount)} />
                </span>
              ) : null}
              {line.notes ? <span className="ms-1.5 text-teal-600">📝</span> : null}
            </span>
          </span>
          {expanded ? (
            <ChevronUp className="h-4 w-4 shrink-0 text-slate-300" aria-hidden />
          ) : (
            <ChevronDown className="h-4 w-4 shrink-0 text-slate-300" aria-hidden />
          )}
        </button>

        <button
          type="button"
          onClick={() => removeLine(index)}
          aria-label={t("cartPanel.line.deleteAria", { name: line.name })}
          className="btn-press flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-red-400 hover:bg-red-50 hover:text-red-600"
        >
          <Trash2 className="h-4 w-4" aria-hidden />
        </button>

        <div className="col-span-2 flex min-w-0 flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-2">
          {/* Qty stepper */}
          <div className="flex shrink-0 items-center gap-0.5 rounded-xl border border-slate-200 bg-slate-50 p-0.5">
          <button
            type="button"
            onClick={() => setQty(index, line.qty + 1)}
            aria-label={t("cartPanel.line.increaseAria", { name: line.name })}
            className="btn-press flex min-h-11 min-w-11 items-center justify-center rounded-lg bg-white text-teal-600 shadow-sm hover:bg-teal-50"
          >
            <Plus className="h-4 w-4" aria-hidden />
          </button>
          <span className="num w-8 text-center text-sm font-extrabold text-ink">{fmtInt(line.qty)}</span>
          <button
            type="button"
            onClick={() => setQty(index, line.qty - 1)}
            aria-label={t("cartPanel.line.decreaseAria", { name: line.name })}
            className="btn-press flex min-h-11 min-w-11 items-center justify-center rounded-lg bg-white text-slate-500 shadow-sm hover:bg-slate-100"
          >
            <Minus className="h-4 w-4" aria-hidden />
          </button>
          </div>

          {line.enteredUnitName ? (
          <span
            className={cn(
              "shrink-0 rounded-lg px-1.5 py-1 text-[11px] font-extrabold",
              isMajor ? "bg-teal-50 text-teal-700" : "text-slate-400",
            )}
            aria-label={t("cartPanel.line.unitAria", { unit: line.enteredUnitName })}
          >
            {line.enteredUnitName}
          </span>
          ) : null}

          <div className="ms-auto shrink-0 text-end">
            <Money value={fmt2(lineTotal.gross)} className="text-sm font-extrabold text-ink" />
          </div>
        </div>
      </div>

      {expanded ? (
        <div className="grid grid-cols-1 gap-2 border-t border-slate-100 bg-slate-50/60 p-2.5 sm:grid-cols-2">
          {units.length > 1 ? (
            <label className="block sm:col-span-2">
              <span className="mb-1 block text-[11px] font-extrabold text-slate-500">
                {t("cartPanel.line.unitFieldLabel")}
                {isMajor && baseUnitName ? ` ${t("cartPanel.line.unitConversion", { unit: line.enteredUnitName ?? "" })} ` : ""}
                {isMajor && baseUnitName ? (
                  <>
                    <span className="num">{fmt2(factor)}</span> {baseUnitName}
                  </>
                ) : null}
              </span>
              <UnitPicker
                units={units}
                value={line.enteredUnitCode ?? null}
                baseUnitName={baseUnitName}
                onSelect={(u) => setLineUnit(index, u)}
              />
            </label>
          ) : null}
          <label className="block">
            <span className="mb-1 block text-[11px] font-extrabold text-slate-500">{t("cartPanel.line.notesLabel")}</span>
            <input
              type="text"
              value={line.notes ?? ""}
              onChange={(e) => setLineNotes(index, e.target.value || null)}
              placeholder={t("cartPanel.line.notesPlaceholder")}
              className="field"
              maxLength={300}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-extrabold text-slate-500">
              {t("cartPanel.line.discountCapLabel")} <Money value={fmt2(line.qty * line.unitPrice)} />
            </span>
            <input
              type="number"
              inputMode="decimal"
              min={0}
              max={line.qty * line.unitPrice}
              step="0.01"
              value={line.lineDiscount || ""}
              onChange={(e) => {
                const v = Math.min(Number(e.target.value) || 0, line.qty * line.unitPrice);
                setLineDiscount(index, v);
              }}
              placeholder={t("cartPanel.line.discountInputPlaceholder")}
              className="field num"
              dir="ltr" /* LTR forced: numeric/phone - do not remove, see i18n plan */
            />
          </label>
          {linePresets.length > 0 ? (
            <div className="sm:col-span-2">
              <p className="mb-1 text-[11px] font-extrabold text-slate-500">{t("cartPanel.line.presetsLabel")}</p>
              <div className="flex flex-wrap gap-1.5">
                {linePresets.map((p) => {
                  const belowMin = p.minOrder != null && lineGross < p.minOrder;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      disabled={belowMin}
                      title={belowMin ? t("cartPanel.line.presetMinOrder", { amount: fmt2(p.minOrder!) }) : undefined}
                      onClick={() => setLineDiscount(index, presetLineAmount(p, lineGross))}
                      className="btn-press flex min-h-9 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 text-[11px] font-extrabold text-slate-600 transition hover:border-teal-200 hover:bg-teal-50 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Tag className="h-3 w-3 text-teal-600" aria-hidden />
                      {p.name}
                      <Money value={p.type === "PERCENT" ? `${fmt2(p.value)}%` : fmt2(p.value)} className="text-teal-700" />
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function CustomerAttach() {
  const t = useT();
  const { cart, setCustomer, setCustomerRef, o2cEnabled } = usePos();
  const [open, setOpen] = useState(false);
  const hasCustomer = !!(cart.customerName || cart.customerPhone || cart.customerId);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          "btn-press flex min-h-11 w-full items-center justify-center gap-1.5 rounded-xl border px-2 text-xs font-bold transition",
          hasCustomer
            ? "border-teal-200 bg-teal-50 text-teal-700"
            : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50",
        )}
      >
        <UserPlus className="h-4 w-4" aria-hidden />
        {hasCustomer ? (cart.customerName || cart.customerPhone) : t("cartPanel.customer.button")}
      </button>
      {open ? (
        <div className="dialog-in absolute bottom-full z-20 mb-2 w-72 rounded-2xl border border-slate-200 bg-white p-3 shadow-lift">
          {o2cEnabled ? (
            /* Order-to-Cash: a REAL linked customer (customerId) — required for a
               credit sale. Searchable picker shows the first page on open. */
            <CustomerPicker
              value={cart.customerId ? { id: cart.customerId, name: cart.customerName, phone: cart.customerPhone } : null}
              onChange={(c) => setCustomerRef(c)}
            />
          ) : (
            /* Legacy path (O2C off) — name/phone only, ride in the order note. */
            <>
              <label className="mb-2 block">
                <span className="mb-1 block text-[11px] font-extrabold text-slate-500">{t("cartPanel.customer.nameLabel")}</span>
                <input
                  type="text"
                  value={cart.customerName ?? ""}
                  onChange={(e) => setCustomer(e.target.value || null, cart.customerPhone)}
                  placeholder={t("cartPanel.customer.namePlaceholder")}
                  className="field"
                />
              </label>
              <label className="block">
                <span className="mb-1 flex items-center gap-1 text-[11px] font-extrabold text-slate-500">
                  <Phone className="h-3 w-3" aria-hidden /> {t("cartPanel.customer.phoneLabel")}
                </span>
                <input
                  type="tel"
                  inputMode="tel"
                  value={cart.customerPhone ?? ""}
                  onChange={(e) => setCustomer(cart.customerName, e.target.value || null)}
                  placeholder={t("cartPanel.customer.phonePlaceholder")}
                  className="field num"
                  dir="ltr" /* LTR forced: numeric/phone - do not remove, see i18n plan */
                />
              </label>
            </>
          )}
          <div className="mt-2.5 flex gap-2">
            <Button size="sm" variant="primary" className="flex-1" onClick={() => setOpen(false)}>
              {t("cartPanel.customer.done")}
            </Button>
            {hasCustomer ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setCustomerRef(null);
                  setOpen(false);
                }}
              >
                {t("cartPanel.customer.remove")}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export interface CartPanelProps {
  heldCount: number;
  onPay: () => void;
  onHold: () => void;
  onOpenHeld: () => void;
  onVoid: () => void;
  onOpenDiscount: () => void;
  holdBusy: boolean;
  voidDisabledReason: string | null;
}

export function CartPanel({
  heldCount,
  onPay,
  onHold,
  onOpenHeld,
  onVoid,
  onOpenDiscount,
  holdBusy,
  voidDisabledReason,
}: CartPanelProps) {
  const t = useT();
  const { cart, totals, catalog, setOrderType, setTableNo, supervisor, posCan } = usePos();
  const empty = cart.lines.length === 0;
  const discPct = orderDiscountPct(totals);
  const ceiling = catalog?.maxCashierDiscountPct ?? 10;
  // Capability-aware: a non-supervisor with the granted capability also
  // bypasses the ceiling warning (broadening only — see lib/capabilities.ts).
  const canOverrideDiscountCeiling = supervisor || posCan("pos.discount.override");
  const overCeiling = !canOverrideDiscountCeiling && totals.discountAmount > 0 && discPct > ceiling + 1e-9;

  return (
    <section className="surface flex h-full min-h-0 flex-col" aria-label={t("cartPanel.section.aria")}>
      {/* Order type */}
      <div className="border-b border-slate-100 p-2.5">
        <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label={t("cartPanel.orderTypes.ariaLabel")}>
          {ORDER_TYPES.map(({ value, labelKey, icon: Icon }) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={cart.orderType === value}
              onClick={() => setOrderType(value)}
              className={cn(
                "btn-press flex min-h-11 items-center justify-center gap-1.5 rounded-xl border text-xs font-extrabold transition",
                cart.orderType === value
                  ? "border-ink bg-ink text-white shadow-sm"
                  : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50",
              )}
            >
              <Icon className="h-4 w-4" aria-hidden />
              {t(labelKey)}
            </button>
          ))}
        </div>
        {cart.orderType === "dine_in" ? (
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            <input
              type="text"
              inputMode="numeric"
              value={cart.tableNo ?? ""}
              onChange={(e) => setTableNo(e.target.value || null)}
              placeholder={t("cartPanel.tableNo.label")}
              aria-label={t("cartPanel.tableNo.label")}
              className="field num"
              dir="ltr" /* LTR forced: numeric/phone - do not remove, see i18n plan */
              maxLength={20}
            />
            <CustomerAttach />
          </div>
        ) : (
          <div className="mt-2">
            <CustomerAttach />
          </div>
        )}
      </div>

      {/* Lines */}
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-2.5">
        {empty ? (
          <EmptyState
            icon={<ShoppingBasket className="h-10 w-10" aria-hidden />}
            title={t("cartPanel.empty.title")}
            hint={t("cartPanel.empty.hint")}
          />
        ) : (
          <ul className="flex flex-col gap-1.5">
            {cart.lines.map((l, i) => (
              <CartLineRow key={`${i}-${l.menuId}`} line={l} index={i} />
            ))}
          </ul>
        )}
      </div>

      {/* Discount + totals */}
      <div className="border-t border-slate-100 px-3 pb-2 pt-2.5">
        <button
          type="button"
          onClick={onOpenDiscount}
          disabled={empty}
          className={cn(
            "btn-press mb-2 flex min-h-11 w-full items-center justify-between rounded-xl border px-3 text-xs font-extrabold transition disabled:opacity-45",
            totals.discountAmount > 0
              ? "border-saffron-500/40 bg-saffron-50 text-saffron-600"
              : "border-dashed border-slate-300 bg-white text-slate-500 hover:bg-slate-50",
          )}
        >
          <span className="flex items-center gap-1.5">
            <BadgePercent className="h-4 w-4" aria-hidden />
            {totals.discountAmount > 0
              ? cart.discountName
                ? t("cartPanel.discount.appliedNamedLabel", { name: cart.discountName })
                : t("cartPanel.discount.appliedLabel")
              : t("cartPanel.discount.addLabel")}
          </span>
          {totals.discountAmount > 0 ? <Money value={`-${fmt2(totals.discountAmount)}`} /> : null}
        </button>
        {overCeiling ? (
          <p role="alert" className="mb-2 rounded-xl bg-amber-50 px-3 py-2 text-[11px] font-bold text-amber-800">
            {t("cartPanel.overCeiling.before")} <Money value={fmt2(discPct)} />
            {t("cartPanel.overCeiling.between")}<Money value={fmt2(ceiling)} />
            {t("cartPanel.overCeiling.after")}
          </p>
        ) : null}

        <dl className="space-y-1 text-sm">
          <div className="flex justify-between text-slate-500">
            <dt className="font-bold">{t("cartPanel.totals.subtotal")}</dt>
            <dd>
              <Money value={fmt2(totals.subtotal)} className="font-bold" />
            </dd>
          </div>
          {totals.lineDiscountTotal > 0 ? (
            <div className="flex justify-between text-slate-500">
              <dt className="font-bold">{t("cartPanel.totals.lineDiscounts")}</dt>
              <dd>
                <Money value={`-${fmt2(totals.lineDiscountTotal)}`} className="font-bold text-saffron-600" />
              </dd>
            </div>
          ) : null}
          {totals.discountAmount > 0 ? (
            <div className="flex justify-between text-slate-500">
              <dt className="font-bold">{t("cartPanel.totals.orderDiscount")}</dt>
              <dd>
                <Money value={`-${fmt2(totals.discountAmount)}`} className="font-bold text-saffron-600" />
              </dd>
            </div>
          ) : null}
          <div className="flex justify-between text-slate-500">
            <dt className="font-bold">{t("cartPanel.totals.tax")}</dt>
            <dd>
              <Money value={fmt2(totals.vatTotal)} className="font-bold" />
            </dd>
          </div>
          <div className="flex items-center justify-between border-t border-slate-200 pt-1.5 text-ink">
            <dt className="text-base font-extrabold">{t("cartPanel.totals.total")}</dt>
            <dd className="text-xl font-extrabold">
              <Money value={fmt2(totals.total)} /> <span className="text-xs font-bold text-slate-400">{t("cartPanel.currency")}</span>
            </dd>
          </div>
        </dl>
      </div>

      {/* Actions */}
      <div className="grid grid-cols-3 gap-1.5 border-t border-slate-100 p-2.5">
        <Button variant="secondary" onClick={onHold} disabled={empty || holdBusy} loading={holdBusy} title={t("cartPanel.actions.holdTitle")}>
          <PauseCircle className="h-4 w-4" aria-hidden />
          {t("cartPanel.actions.hold")}
        </Button>
        <Button variant="secondary" onClick={onOpenHeld} className="relative" title={t("cartPanel.actions.held")}>
          {t("cartPanel.actions.held")}
          {heldCount > 0 ? (
            <span className="num absolute -top-1.5 start-1 rounded-full bg-saffron-500 px-1.5 py-0.5 text-[10px] font-extrabold text-white">
              {fmtInt(heldCount)}
            </span>
          ) : null}
        </Button>
        <Button
          variant="danger"
          onClick={onVoid}
          disabled={empty || !!voidDisabledReason}
          title={voidDisabledReason ?? t("cartPanel.actions.voidTitle")}
        >
          <XCircle className="h-4 w-4" aria-hidden />
          {t("cartPanel.actions.void")}
        </Button>
        <Button variant="primary" size="lg" className="col-span-3" onClick={onPay} disabled={empty} title={t("cartPanel.actions.payTitle")}>
          <Banknote className="h-5 w-5" aria-hidden />
          {t("cartPanel.actions.pay")} <Money value={fmt2(totals.total)} /> {t("cartPanel.currency")}
        </Button>
      </div>
    </section>
  );
}
