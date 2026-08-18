// The custody tab must not appear for an account that cannot open it.
//
// /api/custody is mounted behind requireRole('admin','manager','custody') in
// server.js. The `custody_portal` flag alone does not satisfy that middleware,
// so the portal takes its answer from what the SERVER declared at login and
// nothing else. Show the tab optimistically and a custody holder-in-name-only
// gets a tab that 403s on first touch.
import { describe, expect, it } from "vitest";
import { visibleTabs } from "../Shell";
import type { PortalSession } from "@/lib/api";

function session(custodyPortal: boolean | undefined): PortalSession {
  return { username: "sara", role: "employee", fullName: "سارة", custodyPortal };
}

describe("visibleTabs", () => {
  it("shows five tabs for an ordinary employee", () => {
    const ids = visibleTabs(session(false)).map((t) => t.id);
    expect(ids).toEqual(["home", "clock", "hours", "leave", "profile"]);
  });

  it("adds custody only when the server declared it", () => {
    const ids = visibleTabs(session(true)).map((t) => t.id);
    expect(ids).toEqual(["home", "clock", "hours", "leave", "profile", "custody"]);
  });

  it("hides custody when the flag is absent, not just false", () => {
    // An older backend omits the field entirely; `undefined` must read as "no".
    expect(visibleTabs(session(undefined)).map((t) => t.id)).not.toContain("custody");
  });

  it("hides custody when there is no session at all", () => {
    expect(visibleTabs(null).map((t) => t.id)).not.toContain("custody");
  });
});
