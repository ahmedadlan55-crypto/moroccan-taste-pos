// Retired-surface redirects — data-driven over the router's ONE redirect table.
//
// Every REDIRECTS entry must: (1) be allow-listed in REDIRECT_PATHS (the
// architecture test accepts it as a legitimate non-nav route), (2) land on its
// hub target, and (3) carry the whole query along — mapped params renamed per
// the spec, unmapped/foreign params passed through untouched. The harness
// registers the routes exactly the way AppRouter does (path = spec.from,
// element = <RedirectWithParams spec/>), so a spec added to the table is
// covered here automatically.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { REDIRECTS, REDIRECT_PATHS, SUBROUTE_BASE_PATHS, RedirectWithParams } from "@/app/router";
import { NAV_ITEMS } from "@/app/navigation/manifest";

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname + loc.search}</div>;
}

/** The exact query every retired deep link is exercised with. */
const QUERY = "?from=2026-01-01&to=2026-01-31&brandId=2&unknown=x";

function renderAt(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        {REDIRECTS.map((spec) => (
          <Route key={spec.from} path={spec.from} element={<RedirectWithParams spec={spec} />} />
        ))}
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("retired-surface redirects (REDIRECTS table)", () => {
  it("has at least the two rationalization redirects", () => {
    expect(REDIRECTS.map((r) => r.from)).toEqual(
      expect.arrayContaining(["/accounting/sales-analytics", "/pos-admin/reports"]),
    );
  });

  it("every redirect source is allow-listed in REDIRECT_PATHS (architecture contract)", () => {
    for (const spec of REDIRECTS) {
      expect(REDIRECT_PATHS.has(spec.from)).toBe(true);
    }
  });

  // Was "every redirect targets the sales hub subtree" — true only because the
  // table happened to hold nothing but retired REPORT surfaces. The table is
  // now the one home for ANY retired path (the recipe screen moved to
  // /menu/recipes), so the meaningful contract is stronger and more general:
  // a redirect must land somewhere that actually exists. A redirect to a dead
  // path is worse than no redirect — it turns a 404 into a silent 404.
  it("every redirect targets a LIVE route (a nav path, or under a subtree owner)", () => {
    const navPaths = new Set(NAV_ITEMS.map((i) => i.path));
    for (const spec of REDIRECTS) {
      const isExact = navPaths.has(spec.to);
      const isUnderSubtree = [...SUBROUTE_BASE_PATHS].some(
        (base) => spec.to === base || spec.to.startsWith(base + "/"),
      );
      expect(isExact || isUnderSubtree).toBe(true);
    }
  });

  for (const spec of REDIRECTS) {
    it(`${spec.from} → ${spec.to} with ALL params intact (mapped + pass-through)`, () => {
      renderAt(spec.from + QUERY);

      const loc = screen.getByTestId("location").textContent ?? "";
      const [pathname, search = ""] = loc.split("?");
      expect(pathname).toBe(spec.to);

      const params = new URLSearchParams(search);
      // Mapped params arrive under their NEW names with the original values.
      const map = spec.params ?? {};
      for (const [oldName, value] of new URLSearchParams(QUERY).entries()) {
        const newName = map[oldName] ?? oldName;
        expect(params.get(newName)).toBe(value);
      }
      // All four survive — nothing dropped, nothing invented.
      expect([...params.keys()].sort()).toEqual(["brandId", "from", "to", "unknown"]);
    });
  }

  it("a bare (query-less) old link redirects cleanly with no stray '?'", () => {
    renderAt(REDIRECTS[0].from);
    expect(screen.getByTestId("location")).toHaveTextContent(REDIRECTS[0].to);
    expect(screen.getByTestId("location").textContent).not.toContain("?");
  });
});
