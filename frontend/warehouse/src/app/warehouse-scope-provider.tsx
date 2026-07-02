import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import { useSearchParams } from "react-router-dom";
import { useAccessScope } from "@/lib/hooks/useAccessScope";
import type { AccessibleWarehouse } from "@/lib/adapters/access-scope.adapter";

// Persistent Warehouse Scope (blueprint §4.1) + per-user access control
// (Phase 2A.2). The selected warehouse lives in the URL query (?wh=...) so it
// survives reloads and is shareable, mirrored to sessionStorage so it carries
// across navigations. "all" means every (accessible) warehouse.
//
// Access control: the option list and the validity of ?wh come from
// GET /inventory/access-scope. A non-global user can only select a warehouse
// they're granted; a forbidden ?wh is auto-corrected to their first allowed
// warehouse. The backend is the real boundary — this only keeps the UI honest
// and avoids firing requests that would 403.

const STORAGE_KEY = "wh-v2.scope";
export const ALL_WAREHOUSES = "all";

interface ScopeContextValue {
  scope: string;
  setScope: (id: string) => void;
  accessibleWarehouses: AccessibleWarehouse[];
  allWarehousesAccess: boolean;
  scopeReady: boolean;
}

const ScopeContext = createContext<ScopeContextValue>({
  scope: ALL_WAREHOUSES,
  setScope: () => {},
  accessibleWarehouses: [],
  allWarehousesAccess: true,
  scopeReady: false,
});

export function WarehouseScopeProvider({ children }: { children: ReactNode }) {
  const [params, setParams] = useSearchParams();
  const { data, isSuccess } = useAccessScope();

  const fromUrl = params.get("wh");
  const fromStore =
    typeof sessionStorage !== "undefined" ? sessionStorage.getItem(STORAGE_KEY) : null;
  const scope = fromUrl || fromStore || ALL_WAREHOUSES;

  const accessibleWarehouses = data?.accessibleWarehouses ?? [];
  // Optimistic "all-access" until the scope loads, so we never flash a
  // restricted selector or wrongly correct ?wh before we know the answer.
  const allWarehousesAccess = data?.allWarehousesAccess ?? true;

  const setScope = useCallback(
    (id: string) => {
      if (typeof sessionStorage !== "undefined") sessionStorage.setItem(STORAGE_KEY, id);
      const next = new URLSearchParams(params);
      if (id === ALL_WAREHOUSES) next.delete("wh");
      else next.set("wh", id);
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  // Correct a forbidden / "all" scope for a non-global user once the access
  // scope is known: fall back to the first allowed warehouse. If they have no
  // accessible warehouse, leave the scope — the data queries will then surface
  // a PermissionDenied state.
  const allowedIds = useMemo(
    () => accessibleWarehouses.map((w) => w.id),
    [accessibleWarehouses],
  );
  useEffect(() => {
    if (!isSuccess || allWarehousesAccess) return;
    if (scope === ALL_WAREHOUSES || !allowedIds.includes(scope)) {
      const fallback = allowedIds[0];
      if (fallback && fallback !== scope) setScope(fallback);
    }
  }, [isSuccess, allWarehousesAccess, scope, allowedIds, setScope]);

  const value = useMemo<ScopeContextValue>(
    () => ({ scope, setScope, accessibleWarehouses, allWarehousesAccess, scopeReady: isSuccess }),
    [scope, setScope, accessibleWarehouses, allWarehousesAccess, isSuccess],
  );

  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
}

export function useWarehouseScope(): ScopeContextValue {
  return useContext(ScopeContext);
}
