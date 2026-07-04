/**
 * Cart panel (left column in RTL) — lines with qty steppers + inline
 * notes/line-discount editor, order type, customer quick-attach, order
 * discount, totals, actions (hold / held board / void / pay).
 */
import { useState } from "react";
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
  Trash2,
  UserPlus,
  Utensils,
  XCircle,
} from "lucide-react";
import { usePos } from "@/state/store";
import { fmt2, fmtInt } from "@/lib/format";
import { lineTotals, orderDiscountPct } from "@/lib/cartMath";
import type { CartLine, OrderType } from "@/lib/types";
import { Button, cn, EmptyState, Money } from "./ui";
import { UnitPicker } from "./UnitPicker";

const ORDER_TYPES: Array<{ value: OrderType; label: string; icon: typeof Utensils }> = [
  { value: "dine_in", label: "محلي", icon: Utensils },
  { value: "takeaway", label: "سفري", icon: ShoppingBasket },
  { value: "delivery", label: "توصيل", icon: Bike },
];

function CartLineRow({ line, index }: { line: CartLine; index: number }) {
  const { setQty, setLineUnit, removeLine, setLineNotes, setLineDiscount, catalog } = usePos();
  const [expanded, setExpanded] = useState(false);
  const t = lineTotals(line);
  const item = catalog?.items.find((i) => i.id === line.menuId) || null;
  const units = item?.units || [];
  const baseUnitName = item?.baseUnitName || null;
  const factor = Number(line.conversionFactorSnapshot) || 1;
  const baseQty = Number(line.baseQty ?? line.qty);
  const isMajor = factor > 1 && !!line.enteredUnitName;

  return (
    <li className="rounded-xl border border-slate-100 bg-white shadow-sm">
      <div className="flex items-center gap-1.5 p-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex min-h-11 flex-1 items-center gap-1 text-start"
          aria-expanded={expanded}
          aria-label={`تفاصيل ${line.name}`}
        >
          <span className="flex-1">
            <span className="block text-sm font-extrabold leading-tight text-ink">{line.name}</span>
            <span className="mt-0.5 block text-[11px] font-bold text-slate-400">
              <Money value={fmt2(line.unitPrice)} /> ر.س{isMajor && baseUnitName ? `/${baseUnitName}` : ""}
              {isMajor ? (
                <span className="ms-1.5 text-teal-600">
                  = <span className="num">{fmt2(baseQty)}</span> {baseUnitName || ""}
                </span>
              ) : null}
              {line.lineDiscount > 0 ? (
                <span className="ms-1.5 text-saffron-600">
                  خصم <Money value={fmt2(line.lineDiscount)} />
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

        {/* Qty stepper */}
        <div className="flex items-center gap-0.5 rounded-xl border border-slate-200 bg-slate-50 p-0.5">
          <button
            type="button"
            onClick={() => setQty(index, line.qty + 1)}
            aria-label={`زيادة ${line.name}`}
            className="btn-press flex h-10 w-10 items-center justify-center rounded-lg bg-white text-teal-600 shadow-sm hover:bg-teal-50"
          >
            <Plus className="h-4 w-4" aria-hidden />
          </button>
          <span className="num w-8 text-center text-sm font-extrabold text-ink">{fmtInt(line.qty)}</span>
          <button
            type="button"
            onClick={() => setQty(index, line.qty - 1)}
            aria-label={`إنقاص ${line.name}`}
            className="btn-press flex h-10 w-10 items-center justify-center rounded-lg bg-white text-slate-500 shadow-sm hover:bg-slate-100"
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
            aria-label={`الوحدة ${line.enteredUnitName}`}
          >
            {line.enteredUnitName}
          </span>
        ) : null}

        <div className="w-[4.5rem] text-end">
          <Money value={fmt2(t.gross)} className="text-sm font-extrabold text-ink" />
        </div>

        <button
          type="button"
          onClick={() => removeLine(index)}
          aria-label={`حذف ${line.name}`}
          className="btn-press flex h-11 w-11 items-center justify-center rounded-xl text-red-400 hover:bg-red-50 hover:text-red-600"
        >
          <Trash2 className="h-4 w-4" aria-hidden />
        </button>
      </div>

      {expanded ? (
        <div className="grid grid-cols-1 gap-2 border-t border-slate-100 bg-slate-50/60 p-2.5 sm:grid-cols-2">
          {units.length > 1 ? (
            <label className="block sm:col-span-2">
              <span className="mb-1 block text-[11px] font-extrabold text-slate-500">
                الوحدة{isMajor && baseUnitName ? ` — 1 ${line.enteredUnitName} = ` : ""}
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
            <span className="mb-1 block text-[11px] font-extrabold text-slate-500">ملاحظات للمطبخ</span>
            <input
              type="text"
              value={line.notes ?? ""}
              onChange={(e) => setLineNotes(index, e.target.value || null)}
              placeholder="بدون بصل، حار…"
              className="field"
              maxLength={300}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-extrabold text-slate-500">
              خصم السطر (ر.س) — الحد <Money value={fmt2(line.qty * line.unitPrice)} />
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
              placeholder="0.00"
              className="field num"
              dir="ltr"
            />
          </label>
        </div>
      ) : null}
    </li>
  );
}

function CustomerAttach() {
  const { cart, setCustomer } = usePos();
  const [open, setOpen] = useState(false);
  const hasCustomer = !!(cart.customerName || cart.customerPhone);

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
        {hasCustomer ? (cart.customerName || cart.customerPhone) : "عميل"}
      </button>
      {open ? (
        <div className="dialog-in absolute bottom-full z-20 mb-2 w-64 rounded-2xl border border-slate-200 bg-white p-3 shadow-lift">
          {/* customerId is NOT set here — name/phone ride in the order note
              (see composeNote in lib/offline.ts for the server-contract why). */}
          <label className="mb-2 block">
            <span className="mb-1 block text-[11px] font-extrabold text-slate-500">اسم العميل</span>
            <input
              type="text"
              value={cart.customerName ?? ""}
              onChange={(e) => setCustomer(e.target.value || null, cart.customerPhone)}
              placeholder="محمد أحمد"
              className="field"
            />
          </label>
          <label className="block">
            <span className="mb-1 flex items-center gap-1 text-[11px] font-extrabold text-slate-500">
              <Phone className="h-3 w-3" aria-hidden /> الجوال
            </span>
            <input
              type="tel"
              inputMode="tel"
              value={cart.customerPhone ?? ""}
              onChange={(e) => setCustomer(cart.customerName, e.target.value || null)}
              placeholder="05xxxxxxxx"
              className="field num"
              dir="ltr"
            />
          </label>
          <div className="mt-2.5 flex gap-2">
            <Button size="sm" variant="primary" className="flex-1" onClick={() => setOpen(false)}>
              تم
            </Button>
            {hasCustomer ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setCustomer(null, null);
                  setOpen(false);
                }}
              >
                إزالة
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
  const { cart, totals, catalog, setOrderType, setTableNo, supervisor } = usePos();
  const empty = cart.lines.length === 0;
  const discPct = orderDiscountPct(totals);
  const ceiling = catalog?.maxCashierDiscountPct ?? 10;
  const overCeiling = !supervisor && totals.discountAmount > 0 && discPct > ceiling + 1e-9;

  return (
    <section className="surface flex h-full min-h-0 flex-col" aria-label="سلة الطلب">
      {/* Order type */}
      <div className="border-b border-slate-100 p-2.5">
        <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label="نوع الطلب">
          {ORDER_TYPES.map(({ value, label, icon: Icon }) => (
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
              {label}
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
              placeholder="رقم الطاولة"
              aria-label="رقم الطاولة"
              className="field num"
              dir="ltr"
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
            title="سلة فارغة"
            hint="اختر أصنافًا من القائمة أو امسح باركود"
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
              ? `خصم${cart.discountName ? ` «${cart.discountName}»` : ""}`
              : "إضافة خصم على الطلب"}
          </span>
          {totals.discountAmount > 0 ? <Money value={`-${fmt2(totals.discountAmount)}`} /> : null}
        </button>
        {overCeiling ? (
          <p role="alert" className="mb-2 rounded-xl bg-amber-50 px-3 py-2 text-[11px] font-bold text-amber-800">
            الخصم <Money value={fmt2(discPct)} />% يتجاوز حد الكاشير (<Money value={fmt2(ceiling)} />%) — سيرفضه
            الخادم بدون مدير
          </p>
        ) : null}

        <dl className="space-y-1 text-sm">
          <div className="flex justify-between text-slate-500">
            <dt className="font-bold">المجموع</dt>
            <dd>
              <Money value={fmt2(totals.subtotal)} className="font-bold" />
            </dd>
          </div>
          {totals.lineDiscountTotal > 0 ? (
            <div className="flex justify-between text-slate-500">
              <dt className="font-bold">خصومات الأسطر</dt>
              <dd>
                <Money value={`-${fmt2(totals.lineDiscountTotal)}`} className="font-bold text-saffron-600" />
              </dd>
            </div>
          ) : null}
          {totals.discountAmount > 0 ? (
            <div className="flex justify-between text-slate-500">
              <dt className="font-bold">خصم الطلب</dt>
              <dd>
                <Money value={`-${fmt2(totals.discountAmount)}`} className="font-bold text-saffron-600" />
              </dd>
            </div>
          ) : null}
          <div className="flex justify-between text-slate-500">
            <dt className="font-bold">الضريبة (مشمولة)</dt>
            <dd>
              <Money value={fmt2(totals.vatTotal)} className="font-bold" />
            </dd>
          </div>
          <div className="flex items-center justify-between border-t border-slate-200 pt-1.5 text-ink">
            <dt className="text-base font-extrabold">الإجمالي</dt>
            <dd className="text-xl font-extrabold">
              <Money value={fmt2(totals.total)} /> <span className="text-xs font-bold text-slate-400">ر.س</span>
            </dd>
          </div>
        </dl>
      </div>

      {/* Actions */}
      <div className="grid grid-cols-3 gap-1.5 border-t border-slate-100 p-2.5">
        <Button variant="secondary" onClick={onHold} disabled={empty || holdBusy} loading={holdBusy} title="تعليق الطلب (F9)">
          <PauseCircle className="h-4 w-4" aria-hidden />
          تعليق
        </Button>
        <Button variant="secondary" onClick={onOpenHeld} className="relative" title="الطلبات المعلقة">
          الطلبات المعلقة
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
          title={voidDisabledReason ?? "إلغاء الطلب"}
        >
          <XCircle className="h-4 w-4" aria-hidden />
          إلغاء
        </Button>
        <Button variant="primary" size="lg" className="col-span-3" onClick={onPay} disabled={empty} title="الدفع (F4)">
          <Banknote className="h-5 w-5" aria-hidden />
          دفع — <Money value={fmt2(totals.total)} /> ر.س
        </Button>
      </div>
    </section>
  );
}
