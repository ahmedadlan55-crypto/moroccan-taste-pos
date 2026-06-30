import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { WarehouseScopeSelect } from "../WarehouseScopeSelect";
import { renderWithProviders, stubFetch, type FetchHandler } from "@/test/test-utils";

// access-scope is token-gated; set a token so the provider actually loads it.
beforeEach(() => {
  try { localStorage.setItem("pos_token", "test-token"); } catch { /* jsdom */ }
});
afterEach(() => {
  vi.unstubAllGlobals();
  try { localStorage.clear(); } catch { /* jsdom */ }
});

function accessScope(body: unknown): FetchHandler {
  return (url) => {
    if (url.includes("/inventory/access-scope")) return { status: 200, body };
    return { status: 200, body: { success: true } };
  };
}

describe("WarehouseScopeSelect (access-scoped)", () => {
  it("global user: shows the 'all' option + every warehouse", async () => {
    stubFetch(accessScope({
      allWarehousesAccess: true,
      accessibleWarehouses: [{ id: "WH-A", name: "Alpha" }, { id: "WH-B", name: "Beta" }],
    }));
    renderWithProviders(<WarehouseScopeSelect />);
    await waitFor(() => expect(screen.getByRole("option", { name: "Alpha" })).toBeInTheDocument());
    expect(screen.getByRole("option", { name: "كل المستودعات" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Beta" })).toBeInTheDocument();
  });

  it("scoped user: hides 'all' and lists ONLY granted warehouses", async () => {
    stubFetch(accessScope({
      allWarehousesAccess: false,
      accessibleWarehouses: [{ id: "WH-A", name: "Alpha" }],
    }));
    renderWithProviders(<WarehouseScopeSelect />);
    await waitFor(() => expect(screen.getByRole("option", { name: "Alpha" })).toBeInTheDocument());
    expect(screen.queryByRole("option", { name: "كل المستودعات" })).toBeNull();
    expect(screen.queryByRole("option", { name: "Beta" })).toBeNull();
  });

  it("auto-corrects a forbidden ?wh to the first allowed warehouse", async () => {
    stubFetch(accessScope({
      allWarehousesAccess: false,
      accessibleWarehouses: [{ id: "WH-A", name: "Alpha" }],
    }));
    renderWithProviders(<WarehouseScopeSelect />, { route: "/?wh=WH-FORBIDDEN" });
    const select = (await screen.findByRole("combobox")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("WH-A"));
  });
});
