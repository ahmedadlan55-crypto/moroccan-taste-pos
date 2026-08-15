// The house money cell.
//
// Moved here verbatim from `modules/accounting/components.tsx`, where it had
// been the only correct financial number renderer in the product while every
// other module hand-rolled its own. It is unchanged on purpose — accounting is
// full of screens whose numbers are checked against a printed sheet, and the
// module still re-exports these two names so no existing call site moves.
//
// What it encodes, and why each rule is not cosmetic:
//   · NEGATIVES IN PARENTHESES (`signed`). The accounting convention. A minus
//     sign in front of an English numeral inside a right-to-left line lands on
//     the wrong side of the digits and can read as part of the neighbouring
//     cell; parentheses cannot.
//   · ZERO AS A DASH (`dash`). A statement distinguishes "nothing happened"
//     from "0.00 was computed"; a column of 0.00s hides the few rows that carry
//     a figure.
//   · dir="ltr" + tabular-nums. Digits stay English (the approved numbering
//     policy) and every column aligns on the decimal point regardless of page
//     direction.
//   · AN INVALID VALUE IS SHOWN, NOT SWALLOWED. NaN/Infinity render a red "!"
//     carrying `data-invalid-financial-value`, because a bad figure formatted
//     as "0.00" is a wrong number presented as a real one — and the attribute
//     lets a test or an audit sweep find it.
import type { ReactNode } from "react";

// English-digit, 2-decimal grouping — matches the legacy report formatting and
// the app-wide numbering policy (English numerals inside RTL layout).
const NUM = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function fmt(value: number | null | undefined): string {
  const parsed = value == null ? 0 : Number(value);
  return Number.isFinite(parsed) ? NUM.format(parsed) : "—";
}

export interface NumProps {
  value: number | null | undefined;
  /** Render a zero as an em dash. On by default. */
  dash?: boolean;
  /** Total / subtotal weight. */
  strong?: boolean;
  /** Accounting sign convention: negatives in parentheses, in red. */
  signed?: boolean;
}

/** A signed amount cell: LTR + tabular, negatives parenthesised, zero → dash. */
export function Num({ value, dash = true, strong = false, signed = false }: NumProps): ReactNode {
  const parsed = value == null ? 0 : Number(value);
  if (!Number.isFinite(parsed)) {
    return (
      <span
        className="font-bold tabular-nums text-rose-700"
        data-invalid-financial-value="true"
        title="Invalid financial value"
      >
        !
      </span>
    );
  }
  const n = parsed;
  if (dash && Math.abs(n) < 0.005) {
    return <span className="tabular-nums text-slate-300">—</span>;
  }
  const negative = n < 0;
  const body = signed && negative ? `(${fmt(Math.abs(n))})` : fmt(n);
  return (
    <span
      dir="ltr"
      className={[
        "tabular-nums",
        strong ? "font-extrabold text-slate-900" : "font-semibold text-slate-700",
        signed && negative ? "text-rose-600" : "",
      ].join(" ")}
    >
      {body}
    </span>
  );
}
