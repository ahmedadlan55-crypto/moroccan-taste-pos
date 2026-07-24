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
import { REDIRECTS, REDIRECT_PATHS, RedirectWithParams } from "@/app/router";

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

  it("every redirect targets the sales hub subtree", () => {
    for (const spec of REDIRECTS) {
      expect(spec.to.startsWith("/reports/sales/")).toBe(true);
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
