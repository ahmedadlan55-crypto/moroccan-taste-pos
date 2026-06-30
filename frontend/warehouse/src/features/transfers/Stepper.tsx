import { Check } from "lucide-react";
import { cn } from "@/lib/cn";

// Compact 3-step indicator for the create-transfer wizard. Purely presentational
// — the wizard owns the current step. Accessible: the active step is announced.
export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
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
            <span className={cn("text-xs font-bold", state === "todo" ? "text-slate-400" : "text-slate-700")}>{label}</span>
            {i < steps.length - 1 && <span className="hidden h-px w-6 bg-slate-200 sm:block" aria-hidden="true" />}
          </li>
        );
      })}
    </ol>
  );
}
