import { useEffect } from "react";

/**
 * Warns before the user LEAVES the tab (reload / close / external nav) while a
 * form has unsaved changes, via the native `beforeunload` prompt. For in-app
 * (react-router) navigation blocking, pair this with a route-level confirm in
 * the consuming screen — kept out of here so the shared kit stays router-shape
 * agnostic (works whether or not a data router is in use).
 */
export function useUnsavedGuard(isDirty: boolean): void {
  useEffect(() => {
    if (!isDirty) return;
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      // Modern browsers show a generic message; setting returnValue is required.
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isDirty]);
}
