import { forwardRef } from "react";
import { NumberInput, type NumberInputProps } from "./number-input";

export interface QuantityInputProps extends Omit<NumberInputProps, "suffix"> {
  /** Short unit label pinned to the inline-end (e.g. "كجم", "حبة"). */
  unit?: string;
}

/**
 * Simple single-unit quantity entry. For multi-unit conversion (carton→piece)
 * with a live base-unit readout, use UnitQtyInput instead.
 */
export const QuantityInput = forwardRef<HTMLInputElement, QuantityInputProps>(
  ({ unit, min = 0, step = "any", ...props }, ref) => (
    <NumberInput ref={ref} suffix={unit} min={min} step={step} {...props} />
  ),
);
QuantityInput.displayName = "QuantityInput";
