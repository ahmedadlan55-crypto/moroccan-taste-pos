/**
 * DiscountDialog — order-level discount: نسبة (PERCENT) or مبلغ (FIXED) with a
 * discount name. Warns client-side above maxCashierDiscountPct (the server
 * enforces the ceiling at /submit regardless — hidden buttons are not RBAC).
 */
import { useEffect, useMemo, useState } from "react";
import { BadgePercent, Tag } from "lucide-react";
import { usePos } from "@/state/store";
import { cartTotals, orderDiscountPct, round2 } from "@/lib/cartMath";
import { presetsForScope, useDiscountPresets } from "@/lib/discountPresets";
import { fmt2 } from "@/lib/format";
import type { DiscountType } from "@/lib/types";
import { Dialog } from "../Dialog";
import { Button, cn, Money } from "../ui";

export function DiscountDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { cart, setDiscount, catalog, supervisor, posCan } = usePos();
  const [type, setType] = useState<DiscountType>("PERCENT");
  const [value, setValue] = useState("");
  const [name, setName] = useState("");

  useEffect(() => {
    if (open) {
      setType(cart.discountType ?? "PERCENT");
      setValue(cart.discountType ? String(cart.discountValue) : "");
      setName(cart.discountName ?? "");
    }
  }, [open, cart.discountType, cart.discountValue, cart.discountName]);

  const preview = useMemo(
    () => cartTotals(cart.lines, Number(value) > 0 ? { type, value: Number(value) } : null),
    [cart.lines, type, value],
  );
  const pct = orderDiscountPct(preview);
  const ceiling = catalog?.maxCashierDiscountPct ?? 10;
  // Capability-aware: a non-supervisor with the granted capability also
  // bypasses the ceiling warning (broadening only — see lib/capabilities.ts).
  const canOverrideDiscountCeiling = supervisor || posCan("pos.discount.override");
  const overCeiling = !canOverrideDiscountCeiling && preview.discountAmount > 0 && pct > ceiling + 1e-9;

  // Preset cards (خصومات جاهزة) from the owner's discounts settings — a preset
  // click only FILLS the form (type/value/name) exactly like manual typing; the
  // apply button + ceiling logic stay the single path (close/w25-sell-ui).
  const presets = presetsForScope(useDiscountPresets(open), "invoice");

  return (
    <Dialog open={open} onClose={onClose} title="خصم على الطلب" widthClass="max-w-md">
      {presets.length > 0 ? (
        <div className="mb-3">
          <p className="mb-1.5 text-[11px] font-extrabold text-slate-500">خصومات جاهزة</p>
          <div className="grid grid-cols-2 gap-1.5">
            {presets.map((p) => {
              const belowMin = p.minOrder != null && preview.subtotal < p.minOrder;
              return (
                <button
                  key={p.id}
                  type="button"
                  disabled={belowMin}
                  title={belowMin ? `الحد الأدنى للطلب ${fmt2(p.minOrder!)} ر.س` : undefined}
                  onClick={() => {
                    setType(p.type);
                    setValue(String(p.value));
                    setName(p.name);
                  }}
                  className="btn-press flex min-h-11 items-center justify-between gap-1.5 rounded-xl border border-slate-200 bg-white px-3 text-xs font-extrabold text-slate-600 transition hover:border-teal-200 hover:bg-teal-50 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <span className="flex items-center gap-1.5 truncate">
                    <Tag className="h-3.5 w-3.5 shrink-0 text-teal-600" aria-hidden />
                    <span className="truncate">{p.name}</span>
                  </span>
                  <Money value={p.type === "PERCENT" ? `${fmt2(p.value)}%` : fmt2(p.value)} className="shrink-0 text-teal-700" />
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
      <div className="mb-3 grid grid-cols-2 gap-1.5" role="radiogroup" aria-label="نوع الخصم">
        {(
          [
            { key: "PERCENT" as DiscountType, label: "نسبة %" },
            { key: "FIXED" as DiscountType, label: "مبلغ ر.س" },
          ] as const
        ).map(({ key, label }) => (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={type === key}
            onClick={() => setType(key)}
            className={cn(
              "btn-press min-h-11 rounded-xl border text-sm font-extrabold transition",
              type === key ? "border-ink bg-ink text-white" : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <label className="mb-3 block">
        <span className="mb-1 block text-[11px] font-extrabold text-slate-500">
          {type === "PERCENT" ? "النسبة (0–100)" : `المبلغ (يُسقَف عند ${fmt2(preview.subtotal)})`}
        </span>
        <input
          type="number"
          inputMode="decimal"
          min={0}
          max={type === "PERCENT" ? 100 : undefined}
          step="0.01"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={type === "PERCENT" ? "10" : "15.00"}
          className="field num text-lg"
          dir="ltr"
        />
      </label>

      <label className="mb-3 block">
        <span className="mb-1 block text-[11px] font-extrabold text-slate-500">اسم الخصم</span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="عرض الافتتاح، موظف…"
          className="field"
          maxLength={100}
        />
      </label>

      <div className="rounded-xl bg-slate-50 px-3 py-2.5 text-sm">
        <div className="flex justify-between font-bold text-slate-500">
          <span>قيمة الخصم</span>
          <Money value={`-${fmt2(preview.discountAmount)}`} className="text-saffron-600" />
        </div>
        <div className="mt-1 flex justify-between font-extrabold text-ink">
          <span>الإجمالي بعد الخصم</span>
          <Money value={fmt2(preview.total)} />
        </div>
      </div>

      {overCeiling ? (
        <p role="alert" className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-[11px] font-bold text-amber-800">
          <BadgePercent className="ms-1 inline h-3.5 w-3.5" aria-hidden />
          الخصم <Money value={fmt2(round2(pct))} />% يتجاوز حد الكاشير (<Money value={fmt2(ceiling)} />%) — سيرفضه الخادم
          عند الدفع بدون مدير
        </p>
      ) : null}

      <div className="mt-4 flex gap-2">
        {cart.discountType ? (
          <Button
            variant="danger"
            onClick={() => {
              setDiscount(null, 0, null);
              onClose();
            }}
          >
            إزالة الخصم
          </Button>
        ) : null}
        <Button
          variant="primary"
          className="flex-1"
          disabled={!(Number(value) > 0)}
          onClick={() => {
            setDiscount(type, Number(value), name.trim() || null);
            onClose();
          }}
        >
          تطبيق الخصم
        </Button>
      </div>
    </Dialog>
  );
}
