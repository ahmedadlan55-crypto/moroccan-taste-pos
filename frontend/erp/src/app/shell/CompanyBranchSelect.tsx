import { useId, useState } from "react";
import { Building2, ChevronDown, MapPin, type LucideIcon } from "lucide-react";
import { useT } from "@/i18n";
import { cn } from "@/shared/lib";

type ScopeOption = { value: string; label: string };

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
        <span className="min-w-0 flex-1 text-start">
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
  const t = useT();
  const [company, setCompany] = useState("all");
  const [branch, setBranch] = useState("all");

  const companyOptions: ScopeOption[] = [{ value: "all", label: t("shell.scope.allCompanies") }];
  const branchOptions: ScopeOption[] = [{ value: "all", label: t("shell.scope.allBranches") }];

  return (
    <div
      role="group"
      aria-label={t("shell.scope.groupLabel")}
      data-testid="company-branch-scope"
      className={cn(
        "grid min-w-0 gap-2",
        fullWidth ? "w-full grid-cols-1 sm:grid-cols-2" : "shrink-0 grid-cols-[13rem_12rem]",
      )}
    >
      <ScopeField
        label={t("shell.scope.company")}
        ariaLabel={t("shell.scope.selectCompany")}
        icon={Building2}
        value={company}
        options={companyOptions}
        onChange={setCompany}
      />
      <ScopeField
        label={t("shell.scope.branch")}
        ariaLabel={t("shell.scope.selectBranch")}
        icon={MapPin}
        value={branch}
        options={branchOptions}
        onChange={setBranch}
      />
    </div>
  );
}
