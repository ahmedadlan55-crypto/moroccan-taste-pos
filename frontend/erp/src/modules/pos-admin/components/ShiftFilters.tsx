import { Input, Select } from "@/shared/ui";
import { useT } from "@/i18n";
import type { ShiftFilters as ShiftFiltersValue } from "../lib/types";

interface ShiftFiltersProps {
  value: ShiftFiltersValue;
  onChange: (next: ShiftFiltersValue) => void;
  cashiers: { value: string; label: string }[];
}

/** Server-side filter controls for the shifts endpoint (date range / cashier / status). */
export function ShiftFilters({ value, onChange, cashiers }: ShiftFiltersProps) {
  const t = useT();
  const set = (patch: Partial<ShiftFiltersValue>) => onChange({ ...value, ...patch });

  const statusOptions = [
    { value: "", label: t("posAdmin.filters.statusAll") },
    { value: "OPEN", label: t("posAdmin.shift.open") },
    { value: "CLOSED", label: t("posAdmin.shift.closed") },
  ];

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-1.5 text-xs font-bold text-slate-500">
        <span>{t("posAdmin.filters.from")}</span>
        <Input
          type="date"
          className="h-10 w-40 py-1.5"
          value={value.startDate ?? ""}
          onChange={(e) => set({ startDate: e.target.value || undefined })}
          aria-label={t("posAdmin.filters.fromDateAria")}
        />
      </label>
      <label className="flex items-center gap-1.5 text-xs font-bold text-slate-500">
        <span>{t("posAdmin.filters.to")}</span>
        <Input
          type="date"
          className="h-10 w-40 py-1.5"
          value={value.endDate ?? ""}
          onChange={(e) => set({ endDate: e.target.value || undefined })}
          aria-label={t("posAdmin.filters.toDateAria")}
        />
      </label>
      <Select
        className="h-10 w-44 py-1.5"
        value={value.username ?? ""}
        onChange={(e) => set({ username: e.target.value || undefined })}
        aria-label={t("posAdmin.col.cashier")}
      >
        <option value="">{t("posAdmin.filters.cashierAll")}</option>
        {cashiers.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </Select>
      <Select
        className="h-10 w-36 py-1.5"
        options={statusOptions}
        value={value.status ?? ""}
        onChange={(e) => set({ status: e.target.value || undefined })}
        aria-label={t("common.status")}
      />
    </div>
  );
}
