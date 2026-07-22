import { AlertCircle } from "lucide-react";
import { validation as arValidation } from "@/i18n/dictionaries/ar/validation";
import { useTx } from "@/shared/ui/i18n";

/** Accepts a plain string or a react-hook-form / zod FieldError-shaped object. */
export type FieldErrorLike = string | { message?: unknown } | null | undefined;

export function resolveErrorMessage(error: FieldErrorLike): string | null {
  if (!error) return null;
  if (typeof error === "string") return error;
  if (typeof error.message === "string" && error.message.length > 0) return error.message;
  return null;
}

// Reverse index: Arabic validation message → dotted key, derived from the Arabic
// dictionary so the single source of truth is i18n/dictionaries/ar/validation.ts.
// The shared zod primitives emit these Arabic strings as their `.message` (they
// render correctly even with no i18n provider — see shared/schemas/primitives.ts);
// here we map a rendered message back to its key and re-translate it through t()
// so a form under an English provider shows English. Parametric templates
// (containing "{") are skipped — an interpolated runtime string can't reverse-match.
function collectReverse(node: unknown, prefix: string, out: Record<string, string>) {
  if (typeof node === "string") {
    if (!node.includes("{")) out[node] = prefix;
    return;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      collectReverse(v, prefix ? `${prefix}.${k}` : k, out);
    }
  }
}
const AR_MSG_TO_KEY: Record<string, string> = {};
collectReverse(arValidation, "validation", AR_MSG_TO_KEY);

export function FieldError({ error, id }: { error: FieldErrorLike; id?: string }) {
  const t = useTx();
  const raw = resolveErrorMessage(error);
  if (!raw) return null;
  const key = AR_MSG_TO_KEY[raw];
  const message = key ? t(key) : raw;
  return (
    <p id={id} role="alert" className="flex items-center gap-1 text-xs font-semibold text-rose-600">
      <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {message}
    </p>
  );
}
