import { describe, it, expect } from "vitest";
import { can, type SessionUser } from "../permissions";

const manager: SessionUser = { username: "m", role: "manager" };
const cashier: SessionUser = { username: "c", role: "cashier" };
const employee: SessionUser = { username: "e", role: "employee" };
const dev: SessionUser = { username: "d", role: "cashier", isDeveloper: true };
const auditor: SessionUser = { username: "a", role: "auditor" };

describe("permissions.can — mirrors backend RBAC (Phase 0)", () => {
  it("approve/reverse are managers only", () => {
    expect(can(manager, "transfer.approve")).toBe(true);
    expect(can(employee, "transfer.approve")).toBe(false);
    expect(can(cashier, "transfer.approve")).toBe(false);
    expect(can(manager, "document.reverse")).toBe(true);
    expect(can(employee, "document.reverse")).toBe(false);
  });

  it("cashier cannot move stock (the fraud vector)", () => {
    expect(can(cashier, "transfer.issue")).toBe(false);
    expect(can(cashier, "transfer.create")).toBe(false);
    expect(can(cashier, "stocktake.create")).toBe(false);
  });

  it("employee/custody can create + issue + receive transfers", () => {
    expect(can(employee, "transfer.create")).toBe(true);
    expect(can(employee, "transfer.issue")).toBe(true);
    expect(can(employee, "transfer.receive")).toBe(true);
  });

  it("auditor is read-only", () => {
    expect(can(auditor, "warehouse.view")).toBe(true);
    expect(can(auditor, "transfer.approve")).toBe(false);
    expect(can(auditor, "adjustment.create")).toBe(false);
  });

  it("developer overrides everything; null user can do nothing", () => {
    expect(can(dev, "warehouse.deactivate")).toBe(true);
    expect(can(dev, "settings.edit")).toBe(true);
    expect(can(null, "warehouse.view")).toBe(false);
  });
});
