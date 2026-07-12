import { useEffect, useState } from "react";

/** Reactively tracks a CSS media query. SSR-safe (returns false on the server). */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

/** True below the `md` breakpoint (768px) — the DataTable/nav stacked-card cutoff. */
export function useIsMobile(): boolean {
  return useMediaQuery("(max-width: 767px)");
}
