import { Warehouse } from "lucide-react";
import { useWarehouseScope, ALL_WAREHOUSES } from "@/app/warehouse-scope-provider";
import { useWarehouses } from "@/lib/hooks/useWarehouses";
import { cn } from "@/lib/cn";

// Persistent warehouse scope selector (Topbar). Reads/writes the shared scope
// (URL ?wh= + sessionStorage). Options come from the live warehouses-summary
// (cached + shared with the Warehouses page); while loading we still render the
// current selection so the control never flickers empty.
export function WarehouseScopeSelect({ fullWidth = false }: { fullWidth?: boolean }) {
  const { scope, setScope } = useWarehouseScope();
  const { data } = useWarehouses(ALL_WAREHOUSES);
  const options = data?.warehouses ?? [];

  return (
    <label className={cn("flex items-center gap-2 text-xs font-extrabold text-slate-500", fullWidth && "w-full")}>
      <Warehouse className="h-4 w-4 shrink-0 text-teal-700" aria-hidden="true" />
      <span className="sr-only">نطاق المستودع</span>
      <select
        className={cn("field", fullWidth ? "w-full min-w-0 flex-1" : "min-w-44 sm:min-w-56")}
        value={scope}
        onChange={(e) => setScope(e.target.value)}
        aria-label="نطاق المستودع"
      >
        <option value={ALL_WAREHOUSES}>كل المستودعات</option>
        {/* Ensure the current scope remains selectable even before options load. */}
        {scope !== ALL_WAREHOUSES && !options.some((w) => w.id === scope) && (
          <option value={scope}>{scope}</option>
        )}
        {options.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
      </select>
    </label>
  );
}
