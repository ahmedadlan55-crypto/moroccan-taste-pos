import { forwardRef } from "react";
import { NumberInput, type NumberInputProps } from "./number-input";
import { useTx } from "./i18n";

export interface CurrencyInputProps extends Omit<NumberInputProps, "suffix" | "step"> {
  /** Currency label pinned to the inline-end. Defaults to the SAR symbol. */
  currency?: string;
  step?: number | "any";
}

/** Money entry — two decimals by default, SAR suffix, LTR tabular alignment. */
export const CurrencyInput = forwardRef<HTMLInputElement, CurrencyInputProps>(
  ({ currency, step = 0.01, min = 0, ...props }, ref) => {
    const t = useTx();
    return <NumberInput ref={ref} suffix={currency ?? t("sharedUi.currencySymbol")} step={step} min={min} {...props} />;
  },
);
CurrencyInput.displayName = "CurrencyInput";
