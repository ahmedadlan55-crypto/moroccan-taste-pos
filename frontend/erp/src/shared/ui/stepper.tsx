import { Check } from "lucide-react";
import { cn } from "@/shared/lib";

// Shared multi-step indicator (lifted from the inventory transfer wizard for
// FC-P3 so the payroll / brand-wizard / bank-rec flows reuse it). Purely
// presentational — the parent owns `current` (1-based). Accessible: the active
// step is announced via aria-live.
export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <>
      <span aria-live="polite" className="sr-only">
        الخطوة {current} من {steps.length}: {steps[current - 1] ?? ""}
      </span>
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-3">
        {steps.map((label, i) => {
          const n = i + 1;
          const state = n < current ? "done" : n === current ? "current" : "todo";
          return (
            <li key={label} className="flex items-center gap-2">
              <span
                aria-current={state === "current" ? "step" : undefined}
                className={cn(
                  "grid h-8 w-8 place-items-center rounded-full text-xs font-extrabold transition",
                  state === "done"
                    ? "bg-teal-600 text-white"
                    : state === "current"
                      ? "bg-teal-50 text-teal-700 ring-2 ring-teal-500"
                      : "bg-slate-100 text-slate-400",
                )}
              >
                {state === "done" ? <Check className="h-4 w-4" /> : n}
              </span>
              <span className={cn("text-xs font-bold", state === "todo" ? "text-slate-400" : "text-slate-700")}>
                {label}
              </span>
              {i < steps.length - 1 && <span className="hidden h-px w-6 bg-slate-200 sm:block" aria-hidden="true" />}
            </li>
          );
        })}
      </ol>
    </>
  );
}
