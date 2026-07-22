// Quantity entry in a chosen unit, with a live base-unit conversion. Two patterns:
//   • "single"    — one unit <select> (base + majors) + a quantity, e.g. 3 كراتين
//   • "composite" — major quantity + minor(base) quantity, e.g. 2 كرتون + 3 حبة
// The base quantity is ALWAYS recomputed here for display (and by the backend for
// truth). Numbers render as English digits. Emits { unitCode, qty, majorQty,
// minorQty }; call baseFromValue() to derive the base quantity for the payload.

import { useMemo } from "react";
import { formatQty } from "@/shared/lib";
import { useTx } from "./i18n";

export interface ItemUnitLite {
  code: string;
  name: string;
  factor: number; // conversion_to_base
  isBase?: boolean;
}
export interface UnitQtyValue {
  unitCode: string;
  qty: number; // entered qty in the chosen unit (single mode)
  majorQty?: number; // composite mode
  minorQty?: number; // composite mode (base units)
}

const round6 = (n: number) => Math.round((n + Number.EPSILON) * 1e6) / 1e6;

export function baseFromValue(
  units: ItemUnitLite[],
  v: UnitQtyValue,
  mode: "single" | "composite",
): number {
  const unit = units.find((u) => u.code === v.unitCode) || units.find((u) => u.isBase);
  const factor = unit ? Number(unit.factor) || 1 : 1;
  if (mode === "composite") return round6((Number(v.majorQty) || 0) * factor + (Number(v.minorQty) || 0));
  return round6((Number(v.qty) || 0) * factor);
}

export function UnitQtyInput({
  units,
  value,
  onChange,
  mode = "single",
  baseUnitName,
  disabled = false,
  qtyLabel,
  minQty = 0,
}: {
  units: ItemUnitLite[];
  value: UnitQtyValue;
  onChange: (v: UnitQtyValue) => void;
  mode?: "single" | "composite";
  baseUnitName?: string;
  disabled?: boolean;
  qtyLabel?: string;
  minQty?: number;
}) {
  const t = useTx();
  const base = useMemo(() => units.find((u) => u.isBase), [units]);
  const baseName = baseUnitName || base?.name || base?.code || "";
  const majors = units.filter((u) => !u.isBase);
  const selUnit = units.find((u) => u.code === value.unitCode) || base;
  const factor = selUnit ? Number(selUnit.factor) || 1 : 1;
  const baseQty = baseFromValue(units, value, mode);

  if (mode === "composite") {
    const majorUnit = majors[0] || base; // the "carton" unit
    const mFactor = majorUnit ? Number(majorUnit.factor) || 1 : 1;
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <div className="flex flex-col">
            <input
              type="number"
              min={0}
              step="any"
              disabled={disabled}
              className="field h-10 w-24 py-2 text-center tabular-nums"
              value={value.majorQty ?? ""}
              onChange={(e) =>
                onChange({
                  ...value,
                  unitCode: majorUnit?.code ?? value.unitCode,
                  majorQty: e.target.value === "" ? 0 : Number(e.target.value),
                })
              }
              aria-label={t("sharedUi.unitQty.countAria", { unit: majorUnit?.name ?? t("sharedUi.unitQty.majorFallback") })}
              dir="ltr"
            />
            <span className="mt-0.5 text-center text-[10px] font-bold text-slate-400">
              {majorUnit?.name ?? t("sharedUi.unitQty.majorShort")}
            </span>
          </div>
          <span className="text-slate-400">+</span>
          <div className="flex flex-col">
            <input
              type="number"
              min={0}
              step="any"
              disabled={disabled}
              className="field h-10 w-24 py-2 text-center tabular-nums"
              value={value.minorQty ?? ""}
              onChange={(e) =>
                onChange({ ...value, minorQty: e.target.value === "" ? 0 : Number(e.target.value) })
              }
              aria-label={t("sharedUi.unitQty.countAria", { unit: baseName })}
              dir="ltr"
            />
            <span className="mt-0.5 text-center text-[10px] font-bold text-slate-400">{baseName}</span>
          </div>
        </div>
        <span className="text-[11px] font-bold text-teal-700" dir="rtl">
          ={" "}
          <span dir="ltr" className="tabular-nums">
            {formatQty(baseQty)}
          </span>{" "}
          {baseName}
          {mFactor > 1 && (
            <span className="text-slate-400">
              {" "}
              (1 {majorUnit?.name} ={" "}
              <span dir="ltr" className="tabular-nums">
                {formatQty(mFactor)}
              </span>{" "}
              {baseName})
            </span>
          )}
        </span>
      </div>
    );
  }

  // single-unit mode
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={minQty}
          step="any"
          disabled={disabled}
          className="field h-10 w-24 py-2 text-center tabular-nums"
          value={value.qty ?? ""}
          onChange={(e) => onChange({ ...value, qty: e.target.value === "" ? 0 : Number(e.target.value) })}
          aria-label={qtyLabel ?? t("sharedUi.unitQty.qtyLabel")}
          dir="ltr"
        />
        {units.length > 1 ? (
          <select
            className="field h-10 w-28 py-2"
            disabled={disabled}
            value={value.unitCode || base?.code || ""}
            onChange={(e) => onChange({ ...value, unitCode: e.target.value })}
            aria-label={t("sharedUi.unitQty.unitLabel")}
          >
            {units.map((u) => (
              <option key={u.code} value={u.code}>
                {u.name}
                {u.isBase ? "" : ` (×${formatQty(u.factor)})`}
              </option>
            ))}
          </select>
        ) : (
          <span className="grid h-10 place-items-center rounded-xl bg-slate-50 px-3 text-xs font-bold text-slate-500">
            {baseName}
          </span>
        )}
      </div>
      {factor > 1 && (
        <span className="text-[11px] font-bold text-teal-700" dir="rtl">
          ={" "}
          <span dir="ltr" className="tabular-nums">
            {formatQty(baseQty)}
          </span>{" "}
          {baseName}
        </span>
      )}
    </div>
  );
}
