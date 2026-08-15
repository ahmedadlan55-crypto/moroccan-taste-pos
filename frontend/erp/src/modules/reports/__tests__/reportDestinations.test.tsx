// THE STRUCTURAL GUARANTEE — every report has ONE home, and it is /reports/.
//
// This test mounts the REAL routing spine (modules/reports/index.tsx) at every
// section path, waits for that section's catalogue, and reads back every link
// the page actually renders. Then it holds all of them to three rules:
//
//   1. a destination is a route under /reports/ — never a jump into accounting,
//      inventory, people or any other top-level section;
//   2. a destination carries no `#` — a report is a page, never a scroll
//      position on the page you are already looking at;
//   3. a destination is a REPORT address, `/reports/<section>/<id>` — so a row
//      cannot quietly become a link back to its own directory with a query
//      string on it.
//
// It reads the rendered DOM rather than the registries on purpose. A registry
// can be correct while the component that renders it appends something else,
// and it is the href in the page that the owner clicks.
//
// The ONE exception is allow-listed by hand below, and adding to that list is
// the deliberate act this test exists to force.
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@/i18n";
import ReportsModule from "..";

// Everything visible: the rules below are about ADDRESSES, and a capability
// filter would hide rows and make the sweep look cleaner than the app is.
vi.mock("@/app/providers", () => ({
  usePermissions: () => ({ can: () => true }),
  useCan: () => true,
}));
vi.mock("@/modules/inventory/lib/providers", () => ({
  WarehouseModuleProviders: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/modules/inventory/lib/warehouse-scope-provider", () => ({
  ALL_WAREHOUSES: "all",
  useWarehouseScope: () => ({ scope: "all" }),
}));

/** Every catalogue in the product. A new section belongs in this list. */
const SECTIONS = [
  "/reports/financial",
  "/reports/inventory",
  "/reports/purchasing",
  "/reports/sales",
  "/reports/receivables",
  "/reports/people",
  "/reports/operations",
] as const;

/**
 * The only destinations allowed to stay on their own directory path.
 *
 * Both are the warehouse CONTROL CENTRE, not a report: a live workspace of
 * KPIs, reconciliations and a ledger, which the same route renders instead of
 * the catalogue when `?workspace=1` is present. It is a different surface, not
 * an anchor into this one — the rule it must not break is that clicking it
 * changes what you are looking at.
 */
const WORKSPACE_DESTINATIONS = new Set([
  "/reports/inventory?workspace=1",
  "/reports/purchasing?workspace=1",
]);

/** `/reports/<section>/<id>` — a report address, with or without a query. */
const REPORT_ROUTE = /^\/reports\/[a-z-]+\/[a-z0-9-]+$/;

async function destinationsAt(path: string): Promise<string[]> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/reports/*" element={<ReportsModule />} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
  await waitFor(
    () => expect(view.container.querySelector('[data-testid="report-directory"]')).not.toBeNull(),
    { timeout: 5_000 },
  );
  return [...view.container.querySelectorAll("a[href]")].map((a) => a.getAttribute("href") ?? "");
}

describe("every report catalogue destination", () => {
  afterEach(cleanup);

  it("stays inside /reports, is never an anchor, and always names a report", async () => {
    const found: Array<{ section: string; href: string }> = [];
    for (const section of SECTIONS) {
      const hrefs = await destinationsAt(section);
      // A catalogue that rendered no destination would pass every rule below
      // by being empty, so the section has to publish something first.
      expect(hrefs.length, `${section} rendered no destinations`).toBeGreaterThan(0);
      for (const href of hrefs) found.push({ section, href });
    }

    const label = ({ section, href }: { section: string; href: string }) => `${section} → ${href}`;

    // 1. Nothing leaves the reports section.
    const external = found.filter((d) => !d.href.startsWith("/reports/"));
    expect(external.map(label)).toEqual([]);

    // 2. Nothing is a same-page anchor.
    const anchors = found.filter((d) => d.href.includes("#"));
    expect(anchors.map(label)).toEqual([]);

    // 3. Everything names a report — no bare directory path, and no directory
    //    path carrying only a query, except the allow-listed workspace.
    const notAReport = found.filter(
      (d) => !WORKSPACE_DESTINATIONS.has(d.href) && !REPORT_ROUTE.test(d.href.split("?")[0]),
    );
    expect(notAReport.map(label)).toEqual([]);

    // Nothing may link to the directory the reader is already standing on.
    const selfLinks = found.filter((d) => d.href === d.section);
    expect(selfLinks.map(label)).toEqual([]);

    // The sweep is worth something only if it covers the whole library: 74
    // destinations today — 11 financial, 13 inventory, 9 purchasing, 17 sales,
    // 13 receivables, 6 people, 3 operations, plus the two workspaces. A floor
    // rather than an exact count, so adding a report does not fail this test,
    // but silently unmounting a whole section does.
    expect(found.length).toBeGreaterThanOrEqual(70);
  }, 60_000);
});
