import { Input, Select } from "@/shared/ui";
import type { ShiftFilters as ShiftFiltersValue } from "../lib/types";

interface ShiftFiltersProps {
  value: ShiftFiltersValue;
  onChange: (next: ShiftFiltersValue) => void;
  cashiers: { value: string; label: string }[];
}

const STATUS_OPTIONS = [
  { value: "", label: "كل الحالات" },
  { value: "OPEN", label: "مفتوحة" },
  { value: "CLOSED", label: "مغلقة" },
];

/** Server-side filter controls for the shifts endpoint (date range / cashier / status). */
export function ShiftFilters({ value, onChange, cashiers }: ShiftFiltersProps) {
  const set = (patch: Partial<ShiftFiltersValue>) => onChange({ ...value, ...patch });

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-1.5 text-xs font-bold text-slate-500">
        <span>من</span>
        <Input
          type="date"
          className="h-10 w-40 py-1.5"
          value={value.startDate ?? ""}
          onChange={(e) => set({ startDate: e.target.value || undefined })}
          aria-label="من تاريخ"
        />
      </label>
      <label className="flex items-center gap-1.5 text-xs font-bold text-slate-500">
        <span>إلى</span>
        <Input
          type="date"
          className="h-10 w-40 py-1.5"
          value={value.endDate ?? ""}
          onChange={(e) => set({ endDate: e.target.value || undefined })}
          aria-label="إلى تاريخ"
        />
      </label>
      <Select
        className="h-10 w-44 py-1.5"
        value={value.username ?? ""}
        onChange={(e) => set({ username: e.target.value || undefined })}
        aria-label="الكاشير"
      >
        <option value="">كل الكاشيرين</option>
        {cashiers.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </Select>
      <Select
        className="h-10 w-36 py-1.5"
        options={STATUS_OPTIONS}
        value={value.status ?? ""}
        onChange={(e) => set({ status: e.target.value || undefined })}
        aria-label="الحالة"
      />
    </div>
  );
}
