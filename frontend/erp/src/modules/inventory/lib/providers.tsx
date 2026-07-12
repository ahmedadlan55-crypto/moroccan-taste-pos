import type { ReactNode } from "react";
import { WarehouseScopeProvider } from "./warehouse-scope-provider";
import { WarehousePermissionProvider } from "./permission-provider";

// The two warehouse-domain contexts the moved feature pages depend on. The
// unified shell (SD1) mounts Query/Auth/erp-Permission at the app root but has
// no warehouse-scope slot, so the inventory / purchasing / production modules
// wrap their routed content in these locally. Both read shared, react-query
// deduped state (the single /inventory/access-scope request + the ?wh URL
// param), so mounting the wrapper in each module keeps them consistent.
export function WarehouseModuleProviders({ children }: { children: ReactNode }) {
  return (
    <WarehouseScopeProvider>
      <WarehousePermissionProvider>{children}</WarehousePermissionProvider>
    </WarehouseScopeProvider>
  );
}
