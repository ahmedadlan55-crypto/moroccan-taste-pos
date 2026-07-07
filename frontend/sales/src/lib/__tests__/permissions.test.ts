import { describe, it, expect } from "vitest";
import { can, isAdmin, type SessionUser } from "../permissions";

const u = (role: string, extra: Partial<SessionUser> = {}): SessionUser => ({ username: "u", role, ...extra });

describe("O2C permissions mirror", () => {
  it("admin/developer bypass everything", () => {
    expect(isAdmin(u("admin"))).toBe(true);
    expect(can(u("admin"), "payments.reverse")).toBe(true);
    expect(can(u("developer"), "customers.merge")).toBe(true);
    expect(can(u("employee", { isDeveloper: true }), "invoices.issue")).toBe(true);
  });

  it("cashier gets create-level only — never approve/post/reverse/issue", () => {
    const c = u("cashier");
    expect(can(c, "customers.create")).toBe(true);
    expect(can(c, "payments.create")).toBe(true);
    expect(can(c, "returns.create")).toBe(true);
    expect(can(c, "payments.post")).toBe(false);
    expect(can(c, "payments.approve")).toBe(false);
    expect(can(c, "invoices.issue")).toBe(false);
    expect(can(c, "returns.reverse")).toBe(false);
    expect(can(c, "customers.merge")).toBe(false);
  });

  it("accountant/finance can post + reverse collections", () => {
    expect(can(u("accountant"), "payments.post")).toBe(true);
    expect(can(u("finance"), "payments.reverse")).toBe(true);
    expect(can(u("accountant"), "invoices.issue")).toBe(true);
    expect(can(u("finance"), "credit.override")).toBe(true);
  });

  it("an unknown/plain employee has NO o2c capability", () => {
    const e = u("employee");
    expect(can(e, "o2c.view")).toBe(false);
    expect(can(e, "customers.view")).toBe(false);
    expect(can(e, "payments.post")).toBe(false);
  });

  it("null user has nothing", () => {
    expect(can(null, "o2c.view")).toBe(false);
    expect(isAdmin(null)).toBe(false);
  });
});
