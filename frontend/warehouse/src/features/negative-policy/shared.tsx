// Phase W2 — small shared UI bits for the negative-policy feature: policy /
// deficit badges (never color-only — dot + Arabic label, mirrors StatusBadge)
// and an accessible toggle row used by the dialog.

import { cn } from "@/lib/cn";
import type { DeficitStatus, PolicyMode } from "@/lib/adapters/negative-policy.adapter";
import {
  DEFICIT_STATUS_BADGE,
  DEFICIT_STATUS_LABELS,
  POLICY_BADGE_CLASS,
  POLICY_LABELS,
} from "./labels";

export function PolicyBadge({ policy }: { policy: PolicyMode }) {
  return (
    <span className={cn("chip", POLICY_BADGE_CLASS[policy])}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      {POLICY_LABELS[policy]}
    </span>
  );
}

export function DeficitStatusBadge({ status }: { status: DeficitStatus }) {
  return (
    <span className={cn("chip", DEFICIT_STATUS_BADGE[status])}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      {DEFICIT_STATUS_LABELS[status]}
    </span>
  );
}

export function EnabledBadge({ enabled }: { enabled: boolean }) {
  return (
    <span className={cn("chip", enabled ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-slate-100 text-slate-500")}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      {enabled ? "مفعّلة" : "معطّلة"}
    </span>
  );
}

export function ToggleField({
  label,
  hint,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start justify-between gap-3 rounded-xl border border-slate-200 bg-white p-3 transition hover:border-slate-300",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <span className="min-w-0">
        <span className="block text-sm font-bold text-slate-800">{label}</span>
        {hint && <span className="mt-0.5 block text-xs font-medium leading-5 text-slate-500">{hint}</span>}
      </span>
      <input
        type="checkbox"
        className="mt-0.5 h-5 w-5 shrink-0 accent-teal-600"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}
