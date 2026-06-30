import { createContext, useCallback, useContext, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";

// Persistent Warehouse Scope (blueprint §4.1). The selected warehouse lives in
// the URL query (?wh=...) so it survives reloads and is shareable, and is
// mirrored to sessionStorage so it carries across navigations even when a link
// omits the param. "all" means every warehouse.

const STORAGE_KEY = "wh-v2.scope";
export const ALL_WAREHOUSES = "all";

interface ScopeContextValue {
  scope: string;
  setScope: (id: string) => void;
}

const ScopeContext = createContext<ScopeContextValue>({
  scope: ALL_WAREHOUSES,
  setScope: () => {},
});

export function WarehouseScopeProvider({ children }: { children: ReactNode }) {
  const [params, setParams] = useSearchParams();

  const fromUrl = params.get("wh");
  const fromStore =
    typeof sessionStorage !== "undefined" ? sessionStorage.getItem(STORAGE_KEY) : null;
  const scope = fromUrl || fromStore || ALL_WAREHOUSES;

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

  return <ScopeContext.Provider value={{ scope, setScope }}>{children}</ScopeContext.Provider>;
}

export function useWarehouseScope(): ScopeContextValue {
  return useContext(ScopeContext);
}
