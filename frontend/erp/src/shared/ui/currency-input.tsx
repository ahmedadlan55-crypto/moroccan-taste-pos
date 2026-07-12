import { forwardRef } from "react";
import { NumberInput, type NumberInputProps } from "./number-input";

export interface CurrencyInputProps extends Omit<NumberInputProps, "suffix" | "step"> {
  /** Currency label pinned to the inline-end. Defaults to the SAR symbol. */
  currency?: string;
  step?: number | "any";
}

/** Money entry — two decimals by default, SAR suffix, LTR tabular alignment. */
export const CurrencyInput = forwardRef<HTMLInputElement, CurrencyInputProps>(
  ({ currency = "ر.س", step = 0.01, min = 0, ...props }, ref) => (
    <NumberInput ref={ref} suffix={currency} step={step} min={min} {...props} />
  ),
);
CurrencyInput.displayName = "CurrencyInput";
