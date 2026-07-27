/**
 * Header — connection state must be visible WITHOUT opening a menu.
 *
 * ConnectionIndicator / StaleCatalogChip / PwaControls all lived inside the
 * «المزيد» dropdown at every breakpoint. Going offline mid-sale showed nothing,
 * the queued-operation count showed nothing, and «نسخة جديدة — تحديث» was
 * invisible until someone happened to open the menu.
 *
 * Fix: connection + queue count are promoted to the app bar (into the EXISTING
 * shift row, so the header gains no height at any breakpoint — responsive.spec
 * asserts it stays under 45% of a 390px-tall-viewport till). The rest stays in
 * the menu but the trigger now carries an attention dot so it is discoverable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { PosContextValue } from "@/state/store";
import { IDLE_ENGINE_STATUS, makeCtx } from "./parityTestkit";

let currentCtx: PosContextValue;
vi.mock("@/state/store", () => ({ usePos: () => currentCtx }));

const pwaStatus = { canInstall: false, updateReady: false, updateTarget: null as string | null };
vi.mock("@/lib/pwa", () => ({
  getPwaStatus: () => pwaStatus,
  subscribePwa: () => () => {},
  promptInstall: vi.fn(),
  applyUpdate: vi.fn(),
}));

const drainStatus: { state: string; pending: number; outcome: { succeeded: unknown[]; failed: unknown[] } | null } = {
  state: "idle",
  pending: 0,
  outcome: null,
};
vi.mock("@/lib/legacyDrain", () => ({
  getDrainStatus: () => drainStatus,
  subscribeDrain: () => () => {},
}));

import { Header } from "../Header";
import { I18nProvider } from "@/i18n/I18nProvider";

function headerProps() {
  return {
    onOpenShiftDialog: vi.fn(),
    onOpenSyncReport: vi.fn(),
    onOpenMyInvoices: vi.fn(),
    onOpenStocktake: vi.fn(),
    onOpenRequisitions: vi.fn(),
    onOpenDrainReport: vi.fn(),
  };
}

function renderHeader(ctx: PosContextValue = makeCtx()) {
  currentCtx = ctx;
  const props = headerProps();
  render(
    <I18nProvider>
      <Header {...props} />
    </I18nProvider>,
  );
  return props;
}

beforeEach(() => {
  cleanup();
  pwaStatus.canInstall = false;
  pwaStatus.updateReady = false;
  drainStatus.pending = 0;
  drainStatus.outcome = null;
});
afterEach(() => cleanup());

describe("connection state is on the app bar, not behind «المزيد»", () => {
  it("renders online status with NO menu interaction", () => {
    renderHeader();
    expect(screen.getByRole("button", { name: /متصل/ })).toBeInTheDocument();
    // and it is NOT inside the quick-action strip — responsive.spec measures
    // that strip's direct children for the 44×44 / no-overlap contract.
    expect(within(screen.getByTestId("pos-quick-actions")).queryByRole("button", { name: /متصل/ })).toBeNull();
  });

  it("OFFLINE is visible immediately — the case the bug hid completely", () => {
    renderHeader(makeCtx({ online: false }));
    expect(screen.getByRole("button", { name: /غير متصل/ })).toBeInTheDocument();
  });

  it("shows the PENDING QUEUE COUNT next to the state, online and offline", () => {
    renderHeader(
      makeCtx({ online: false, overrides: { engineStatus: { ...IDLE_ENGINE_STATUS, online: false, queueCount: 7 } } }),
    );
    expect(screen.getByRole("button", { name: /غير متصل/ })).toHaveTextContent("7");
  });

  it("stays visible after the «المزيد» menu is opened and closed again", () => {
    renderHeader();
    fireEvent.click(screen.getByRole("button", { name: "المزيد" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("button", { name: /متصل/ })).toBeInTheDocument();
  });

  it("is a single control — never duplicated between the bar and the menu", () => {
    renderHeader();
    fireEvent.click(screen.getByRole("button", { name: "المزيد" }));
    expect(screen.getAllByRole("button", { name: /متصل/ })).toHaveLength(1);
  });

  it("still opens the sync report when tapped", () => {
    const props = renderHeader();
    fireEvent.click(screen.getByRole("button", { name: /متصل/ }));
    expect(props.onOpenSyncReport).toHaveBeenCalledTimes(1);
  });
});

describe("what stays in the menu is at least ADVERTISED by the trigger", () => {
  it("no attention → no dot, and the button keeps its exact accessible name", () => {
    renderHeader();
    expect(screen.queryByTestId("more-attention-dot")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "المزيد" })).toBeInTheDocument();
  });

  it("nothing to report → the menu does not caption an empty status box", () => {
    renderHeader();
    fireEvent.click(screen.getByRole("button", { name: "المزيد" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.queryByText("حالة الجهاز والنظام")).not.toBeInTheDocument();
    // the always-relevant menu items are untouched
    expect(screen.getByRole("button", { name: "تغيير لغة الواجهة" })).toBeInTheDocument();
  });

  it("a ready UPDATE raises the dot — the button used to be invisible entirely", () => {
    pwaStatus.updateReady = true;
    renderHeader();
    expect(screen.getByTestId("more-attention-dot")).toBeInTheDocument();
    // and the update action itself is one tap away, still with the pinned label
    fireEvent.click(screen.getByRole("button", { name: "المزيد" }));
    expect(screen.getByRole("button", { name: /نسخة جديدة — تحديث/ })).toBeInTheDocument();
  });

  it("a STALE catalog raises the dot, and the chip is in the menu", () => {
    renderHeader(makeCtx({ overrides: { catalogStale: true, catalogAgeMs: 7_200_000 } }));
    expect(screen.getByTestId("more-attention-dot")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "المزيد" }));
    expect(screen.getByRole("button", { name: /قائمة قديمة/ })).toBeInTheDocument();
  });

  it("a stuck LEGACY queue raises the dot too", () => {
    drainStatus.pending = 3;
    renderHeader();
    expect(screen.getByTestId("more-attention-dot")).toBeInTheDocument();
  });

  it("the dot never changes the accessible name (responsive.spec pins «المزيد»)", () => {
    pwaStatus.updateReady = true;
    drainStatus.pending = 2;
    renderHeader(makeCtx({ overrides: { catalogStale: true } }));
    const more = screen.getByRole("button", { name: "المزيد" });
    expect(more).toBeInTheDocument();
    expect(more).toHaveAttribute("title", expect.stringContaining("تنبيه"));
  });
});

describe("the app bar gains no ROW — the height budget is untouched", () => {
  it("connection sits in the same flex row as the shift chip", () => {
    renderHeader();
    const connection = screen.getByRole("button", { name: /متصل/ });
    const shift = screen.getByRole("button", { name: /وردية/ });
    expect(connection.parentElement).toBe(shift.parentElement);
  });
});
