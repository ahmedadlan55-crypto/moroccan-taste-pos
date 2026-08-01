// The filters-and-settings rail: one column, filled from two places.
//
// The owner's complaint was that the screen showed two stacked control panels —
// the shared filter bar and the page's own settings card — with nothing saying
// they belong together. The rail merges them. These tests pin the two things
// that can silently go wrong when a component renders somewhere other than
// where it is declared:
//
//   1. WITH a rail, the page's controls appear ONCE — in the rail, not in both
//      places. A double render is the classic portal/slot bug and it would be
//      invisible to a test that only asserts "the control exists".
//   2. WITHOUT a rail, the controls still appear. The first cut of this hook
//      returned void and published into nothing when no provider was present,
//      so a page rendered standalone lost its entire control panel with no
//      error anywhere. Every page test caught it — which is the only reason it
//      did not ship.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ReportRailProvider, useReportRailControls } from "../lib/reportRail";

/** A page that publishes one control and renders it itself only if unrailed. */
function FakePage({ label = "settings" }: { label?: string }) {
  const node = <div data-testid="page-controls">{label}</div>;
  const inRail = useReportRailControls(node, [label]);
  return (
    <section data-testid="page-body">
      <p>body</p>
      {!inRail && node}
    </section>
  );
}

afterEach(cleanup);

describe("a page inside the rail", () => {
  it("renders its controls exactly once, and inside the rail", () => {
    render(
      <ReportRailProvider>
        {(controls) => (
          <>
            <aside data-testid="rail">{controls}</aside>
            <FakePage />
          </>
        )}
      </ReportRailProvider>,
    );

    const found = screen.getAllByTestId("page-controls");
    expect(found, "controls rendered twice — the slot bug this test exists for").toHaveLength(1);
    expect(found[0].closest('[data-testid="rail"]'), "controls are not in the rail").not.toBeNull();
    expect(found[0].closest('[data-testid="page-body"]'), "controls also left in the page").toBeNull();
  });

  it("clears the rail when the page unmounts, so a section switch leaves nothing stranded", () => {
    const { rerender } = render(
      <ReportRailProvider>
        {(controls) => (
          <>
            <aside data-testid="rail">{controls}</aside>
            <FakePage />
          </>
        )}
      </ReportRailProvider>,
    );
    expect(screen.getByTestId("page-controls")).toBeInTheDocument();

    // Navigating to a report that publishes nothing.
    rerender(
      <ReportRailProvider>
        {(controls) => (
          <>
            <aside data-testid="rail">{controls}</aside>
          </>
        )}
      </ReportRailProvider>,
    );
    expect(screen.queryByTestId("page-controls")).not.toBeInTheDocument();
  });

  it("republishes when the controls change", () => {
    const { rerender } = render(
      <ReportRailProvider>
        {(controls) => (
          <>
            <aside data-testid="rail">{controls}</aside>
            <FakePage label="first" />
          </>
        )}
      </ReportRailProvider>,
    );
    expect(screen.getByTestId("page-controls").textContent).toBe("first");

    rerender(
      <ReportRailProvider>
        {(controls) => (
          <>
            <aside data-testid="rail">{controls}</aside>
            <FakePage label="second" />
          </>
        )}
      </ReportRailProvider>,
    );
    expect(screen.getByTestId("page-controls").textContent).toBe("second");
  });
});

describe("a page rendered with NO rail", () => {
  it("still shows its controls, in place", () => {
    // The degradation that matters: a standalone page must not lose its
    // controls just because nobody provided a rail.
    render(<FakePage />);
    const found = screen.getAllByTestId("page-controls");
    expect(found).toHaveLength(1);
    expect(found[0].closest('[data-testid="page-body"]'), "controls vanished").not.toBeNull();
  });
});
