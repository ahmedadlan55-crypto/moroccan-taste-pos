import { useId, useState } from "react";
import { Building2, ChevronDown, MapPin, type LucideIcon } from "lucide-react";
import { cn } from "@/shared/lib";

type ScopeOption = { value: string; label: string };

const COMPANY_OPTIONS: ScopeOption[] = [{ value: "all", label: "كل الشركات" }];
const BRANCH_OPTIONS: ScopeOption[] = [{ value: "all", label: "كل الفروع" }];

function ScopeField({
  label,
  ariaLabel,
  icon: Icon,
  value,
  options,
  onChange,
}: {
  label: string;
  ariaLabel: string;
  icon: LucideIcon;
  value: string;
  options: ScopeOption[];
  onChange: (value: string) => void;
}) {
  const id = useId();
  const selectedLabel = options.find((option) => option.value === value)?.label ?? options[0]?.label ?? "—";

  return (
    <label
      htmlFor={id}
      className={cn(
        "group relative block min-w-0 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm",
        "transition hover:border-slate-300 hover:shadow-md",
        "focus-within:border-teal-500 focus-within:ring-4 focus-within:ring-teal-100",
      )}
      title={`${label}: ${selectedLabel}`}
    >
      <select
        id={id}
        className="absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0"
        aria-label={ariaLabel}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>

      <span className="pointer-events-none flex min-h-14 items-center gap-2.5 px-3" aria-hidden="true">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-slate-50 text-slate-500 transition group-hover:bg-teal-50 group-hover:text-teal-700">
          <Icon className="h-4 w-4" aria-hidden />
        </span>
        <span className="min-w-0 flex-1 text-right">
          <span className="block text-xs font-bold leading-4 text-slate-500">{label}</span>
          <span data-scope-value className="block truncate text-sm font-extrabold leading-5 text-slate-800">
            {selectedLabel}
          </span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
      </span>
    </label>
  );
}

/** A readable, touch-friendly company and branch scope surface for the shell. */
export function CompanyBranchSelect({ fullWidth = false }: { fullWidth?: boolean }) {
  const [company, setCompany] = useState("all");
  const [branch, setBranch] = useState("all");

  return (
    <div
      role="group"
      aria-label="نطاق عرض البيانات"
      data-testid="company-branch-scope"
      className={cn(
        "grid min-w-0 gap-2",
        fullWidth ? "w-full grid-cols-1 sm:grid-cols-2" : "shrink-0 grid-cols-[13rem_12rem]",
      )}
    >
      <ScopeField
        label="الشركة"
        ariaLabel="اختيار الشركة"
        icon={Building2}
        value={company}
        options={COMPANY_OPTIONS}
        onChange={setCompany}
      />
      <ScopeField
        label="الفرع"
        ariaLabel="اختيار الفرع"
        icon={MapPin}
        value={branch}
        options={BRANCH_OPTIONS}
        onChange={setBranch}
      />
    </div>
  );
}
