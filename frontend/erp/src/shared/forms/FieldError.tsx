import { AlertCircle } from "lucide-react";

/** Accepts a plain string or a react-hook-form / zod FieldError-shaped object. */
export type FieldErrorLike = string | { message?: unknown } | null | undefined;

export function resolveErrorMessage(error: FieldErrorLike): string | null {
  if (!error) return null;
  if (typeof error === "string") return error;
  if (typeof error.message === "string" && error.message.length > 0) return error.message;
  return null;
}

export function FieldError({ error, id }: { error: FieldErrorLike; id?: string }) {
  const message = resolveErrorMessage(error);
  if (!message) return null;
  return (
    <p id={id} role="alert" className="flex items-center gap-1 text-xs font-bold text-rose-600">
      <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {message}
    </p>
  );
}
