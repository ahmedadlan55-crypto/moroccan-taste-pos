import { describe, it, expect } from "vitest";
import { allowedPeriodTransitions, PERIOD_STATUS_LABEL, type PeriodStatus } from "../api";

// The transitions mirror the server's rules in routes/erp.js POST
// /periods/:id/lock. They matter because a hard close GENERATES closing journal
// entries and a reopen REVERSES them with an offsetting entry — so "reopen a
// closed period" moves the ledger and must never be offered as a casual button.
describe("allowedPeriodTransitions", () => {
  it("an open period can be soft- or hard-closed, and neither needs force", () => {
    const t = allowedPeriodTransitions("open");
    expect(t.map((x) => x.to).sort()).toEqual(["closed", "soft_closed"]);
    expect(t.every((x) => !x.force)).toBe(true);
  });

  it("a soft-closed period can be reopened or hard-closed without force", () => {
    const t = allowedPeriodTransitions("soft_closed");
    expect(t.map((x) => x.to).sort()).toEqual(["closed", "open"]);
    expect(t.every((x) => !x.force)).toBe(true);
  });

  it("a hard-closed period offers ONLY a forced reopen", () => {
    const t = allowedPeriodTransitions("closed");
    expect(t).toEqual([{ to: "open", force: true }]);
  });

  it("never offers a transition to the status it is already in", () => {
    (["open", "soft_closed", "closed"] as PeriodStatus[]).forEach((s) => {
      expect(allowedPeriodTransitions(s).some((t) => t.to === s)).toBe(false);
    });
  });

  it("force is required exactly when leaving a hard close", () => {
    const forced = (["open", "soft_closed", "closed"] as PeriodStatus[]).flatMap((s) =>
      allowedPeriodTransitions(s).filter((t) => t.force).map(() => s),
    );
    expect(forced).toEqual(["closed"]);
  });

  it("every status has an Arabic label", () => {
    (["open", "soft_closed", "closed"] as PeriodStatus[]).forEach((s) => {
      expect(PERIOD_STATUS_LABEL[s]).toBeTruthy();
    });
  });
});
