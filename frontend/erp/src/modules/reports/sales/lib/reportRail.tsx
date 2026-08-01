// The filters-and-settings rail: one column, filled from two places.
//
// THE PROBLEM THIS SOLVES
//   The hub owns the SHARED filters (period, scope, basis) and each report page
//   owns its OWN settings (Explorer's grouping + metrics, Builder's whole config
//   card). Rendering them where they are declared put two `.surface` panels on
//   the screen, stacked, with nothing to say they belong together — which is
//   exactly the "crowded" complaint: the eye has to reassemble one control
//   surface out of two boxes that look like separate features.
//
//   The owner's words were "the filters and settings column is ONE". So a page
//   PUBLISHES its controls and the hub RENDERS them inside the same card as the
//   shared filters. The page keeps ownership of its state and its logic; only
//   the mounting point moves.
//
// WHY A SLOT AND NOT A PROP
//   The pages are lazy-loaded through `SEGMENT_PAGES[segment.id]` behind a
//   `<Suspense>`; the hub never sees them as values it could ask for controls.
//   And threading a render-prop down through the route registry would make all
//   17 pages declare a slot they mostly do not use. A context that a page opts
//   into keeps the 15 fixed reports untouched.
//
// PUBLISHING RULE
//   `useReportRailControls(node, deps)` — the node is stored in state, so pass
//   the dependency list that actually changes it. Publishing on every render
//   would loop: set state → re-render → set state.
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

interface RailContextValue {
  /** Replace the page-owned section of the rail. `null` clears it. */
  publish: (node: ReactNode) => void;
}

const RailContext = createContext<RailContextValue | null>(null);

export interface ReportRailProviderProps {
  children: (pageControls: ReactNode) => ReactNode;
}

/**
 * Holds the page-published controls and hands them back to the hub to render.
 * The render-prop shape keeps the state here while letting the hub decide where
 * in the rail the page's section sits (below the shared filters).
 */
export function ReportRailProvider({ children }: ReportRailProviderProps) {
  const [pageControls, setPageControls] = useState<ReactNode>(null);
  const value = useMemo<RailContextValue>(() => ({ publish: setPageControls }), []);
  return <RailContext.Provider value={value}>{children(pageControls)}</RailContext.Provider>;
}

/**
 * Publish this page's settings into the shared rail.
 *
 * Returns TRUE when a rail took the node, FALSE when there is no provider —
 * and the caller MUST render the node itself in the false case:
 *
 *     const inRail = useReportRailControls(configPanel, [deps]);
 *     …
 *     {!inRail && configPanel}
 *
 * Why a return value instead of failing silently: a page rendered outside the
 * hub — a page-level test, a future embed, a route that forgets the provider —
 * would otherwise lose its entire control panel with no error anywhere. The
 * controls would simply not be on the screen. Degrading to "render where you
 * are" makes the missing provider a cosmetic difference rather than a
 * disappearing feature, and it is what keeps the page's own tests honest:
 * they exercise the real controls without knowing about the rail.
 *
 * @param node  the controls to show; `null` to contribute nothing
 * @param deps  what changes `node` — same contract as useEffect's dep list
 * @returns     whether the rail is rendering it (so the caller should not)
 */
export function useReportRailControls(node: ReactNode, deps: unknown[]): boolean {
  const ctx = useContext(RailContext);
  const publish = ctx?.publish;
  useEffect(() => {
    if (!publish) return;
    publish(node);
    // Clear on unmount so a section switch never leaves the previous report's
    // controls stranded in the rail.
    return () => publish(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publish, ...deps]);
  return !!publish;
}
