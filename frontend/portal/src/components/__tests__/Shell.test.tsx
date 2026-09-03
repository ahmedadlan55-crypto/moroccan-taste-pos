// The tab bar is built from the two flags the server declared at login.
//
// Before, five attendance tabs were unconditional and custody was a sixth
// bolted on: a custody officer — who never clocks in — opened an app that led
// with a fingerprint button and told them they had not clocked in yet. The
// flags are the admin's decision about what this person does; the bar follows
// them. Custody still appears ONLY when the server said so, because showing it
// to anyone else puts a 403 one tap away.
import { describe, expect, it } from "vitest";
import { isCustodyOnly, visibleTabs } from "../Shell";
import type { PortalSession } from "@/lib/api";

function session(flags: { custodyPortal?: boolean; employeePortal?: boolean }): PortalSession {
  return { username: "sara", role: "employee", fullName: "سارة", ...flags };
}
const ids = (s: PortalSession | null) => visibleTabs(s).map((t) => t.id);

describe("visibleTabs", () => {
  it("shows the attendance set for an ordinary employee", () => {
    expect(ids(session({ employeePortal: true, custodyPortal: false }))).toEqual(["home", "clock", "hours", "leave", "profile"]);
  });

  it("shows custody instead of attendance for a custody officer", () => {
    // THE separation: no clock, no hours, no leave — the officer never clocks in.
    expect(ids(session({ employeePortal: false, custodyPortal: true }))).toEqual(["home", "custody", "profile"]);
  });

  it("shows both sets for an employee who also holds custody", () => {
    expect(ids(session({ employeePortal: true, custodyPortal: true }))).toEqual(["home", "clock", "hours", "leave", "custody", "profile"]);
  });

  it("treats an ABSENT employee flag as attendance on (older backend)", () => {
    // That backend refused everyone without the employee flag, so anyone it
    // let in was an employee. Only an explicit false turns attendance off.
    expect(ids(session({ custodyPortal: false }))).toEqual(["home", "clock", "hours", "leave", "profile"]);
  });

  it("hides custody when the flag is absent, not just false", () => {
    expect(ids(session({}))).not.toContain("custody");
  });

  it("hides custody when there is no session at all", () => {
    expect(ids(null)).not.toContain("custody");
  });
});

describe("isCustodyOnly", () => {
  it("is true only for custody WITHOUT attendance", () => {
    expect(isCustodyOnly(session({ employeePortal: false, custodyPortal: true }))).toBe(true);
    expect(isCustodyOnly(session({ employeePortal: true, custodyPortal: true }))).toBe(false);
    expect(isCustodyOnly(session({ employeePortal: false, custodyPortal: false }))).toBe(false);
    expect(isCustodyOnly(session({ custodyPortal: true }))).toBe(false); // absent employee flag → employee
    expect(isCustodyOnly(null)).toBe(false);
  });
});
