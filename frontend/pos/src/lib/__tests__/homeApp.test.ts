// Where a till-refused account is sent.
//
// The role gate itself is not in question — admin/manager/cashier and nothing
// else, matching routes/pos-v2.js requireRole exactly. What this pins is the
// half that was missing: a refusal that names the right door instead of leaving
// the person to "contact your administrator".
import { describe, expect, it } from "vitest";
import { homeAppForRole, isPosRole, POS_ROLES } from "../auth";

describe("the till allowlist stays in step with the server", () => {
  it("admits exactly the three roles routes/pos-v2.js admits", () => {
    // A drift here is not cosmetic: a role the SERVER accepts but the client
    // refuses locks a real cashier out of the till with no server error to
    // diagnose from.
    expect([...POS_ROLES].sort()).toEqual(["admin", "cashier", "manager"]);
  });

  it("is case-insensitive — a role stored as 'Cashier' must still get in", () => {
    expect(isPosRole("Cashier")).toBe(true);
    expect(isPosRole("ADMIN")).toBe(true);
  });
});

describe("homeAppForRole", () => {
  it("returns null for a role the till admits — there is nowhere to redirect", () => {
    for (const r of POS_ROLES) expect(homeAppForRole(r)).toBeNull();
  });

  it("sends an employee to the employee portal", () => {
    expect(homeAppForRole("employee")).toBe("portal");
  });

  it("sends a custody holder to the portal, not the back office", () => {
    // The standalone custody portal was retired and folded in as a TAB of the
    // employee portal — so 'custody' belongs there now, not at /app.
    expect(homeAppForRole("custody")).toBe("portal");
  });

  it("sends every other non-till role to the back office", () => {
    for (const r of ["accountant", "finance", "sales", "auditor"]) {
      expect(homeAppForRole(r)).toBe("office");
    }
  });

  it("does not strand an unknown or empty role", () => {
    // A role added to the enum later must land SOMEWHERE usable rather than
    // rendering no door at all.
    expect(homeAppForRole("some_future_role")).toBe("office");
    expect(homeAppForRole("")).toBe("office");
    expect(homeAppForRole(null)).toBe("office");
  });
});
