import { useId, type ReactNode } from "react";
import { cn } from "@/shared/lib";
import { FieldError, resolveErrorMessage, type FieldErrorLike } from "./FieldError";

export interface FieldProps {
  label?: ReactNode;
  /** The control's id; when omitted a generated id is passed to `children` via
   *  a render function so the label's htmlFor stays wired to the input. */
  htmlFor?: string;
  required?: boolean;
  error?: FieldErrorLike;
  hint?: ReactNode;
  className?: string;
  /** The control. May be a node, or a function receiving `{ id, invalid }`. */
  children: ReactNode | ((args: { id: string; invalid: boolean }) => ReactNode);
}

/**
 * Label + control + error/hint wrapper. Wire it to react-hook-form by passing
 * `error={errors.fieldName}`; the message is read from a string or a RHF/zod
 * FieldError. The generated id links label ↔ control and aria-describedby ↔ error.
 */
export function Field({ label, htmlFor, required, error, hint, className, children }: FieldProps) {
  const autoId = useId();
  const id = htmlFor ?? autoId;
  const message = resolveErrorMessage(error);
  const invalid = !!message;
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      {label != null && (
        <label htmlFor={id} className="text-xs font-bold text-slate-600">
          {label}
          {required && (
            <span className="text-rose-600" aria-hidden="true">
              {" "}
              *
            </span>
          )}
        </label>
      )}
      <div aria-describedby={cn(message && errorId, hint && hintId) || undefined}>
        {typeof children === "function" ? children({ id, invalid }) : children}
      </div>
      {hint && !message && (
        <p id={hintId} className="text-[11px] font-medium text-slate-400">
          {hint}
        </p>
      )}
      <FieldError id={errorId} error={error} />
    </div>
  );
}
