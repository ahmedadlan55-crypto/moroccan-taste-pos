import { Warehouse } from "lucide-react";
import { useWarehouseScope, ALL_WAREHOUSES } from "./warehouse-scope-provider";
import { cn } from "@/shared/lib";

// Persistent warehouse scope selector. MOVED from the warehouse Topbar (SD4).
// The unified shell's Topbar is generic (no scope slot), so the inventory-family
// modules render this as a module-level control above their scope-aware pages.
// Reads/writes the shared scope (URL ?wh= + sessionStorage). Options come from
// the caller's ACCESSIBLE warehouses (access-scope) — a non-global user never
// sees a warehouse they can't act on, and the "all" option only appears for
// users with all-warehouses access.
export function WarehouseScopeSelect({ fullWidth = false }: { fullWidth?: boolean }) {
  const { scope, setScope, accessibleWarehouses, allWarehousesAccess } = useWarehouseScope();
  const options = accessibleWarehouses;

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
        {allWarehousesAccess && <option value={ALL_WAREHOUSES}>كل المستودعات</option>}
        {/* Keep the current scope selectable even before options load. */}
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
