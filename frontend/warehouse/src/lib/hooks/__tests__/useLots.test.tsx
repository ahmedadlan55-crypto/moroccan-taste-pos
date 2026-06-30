import { describe, it, expect, afterEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { makeTestClient, stubFetch } from "@/test/test-utils";
import { useLotMutations } from "../useLots";
import { toLotPage } from "@/lib/adapters/lot.adapter";
import { toIntegrity } from "@/lib/adapters/lotIntegrity.adapter";
import { ApiError } from "@/lib/api-error";

afterEach(() => vi.unstubAllGlobals());
function wrapper() { const client = makeTestClient(); return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>; }
const ok = { success: true, status: "active", version: 1, data: { id: "LOT-1" }, id: "LOT-1" };

describe("useLotMutations", () => {
  it("create POSTs to /inventory/v2/lots with an Idempotency-Key", async () => {
    const mock = stubFetch(() => ({ status: 201, body: { ...ok } }));
    const { result } = renderHook(() => useLotMutations(), { wrapper: wrapper() });
    act(() => result.current.create.mutate({ itemId: "I1", lotNumber: "L1", expiryDate: "2026-09-01" }));
    await waitFor(() => expect(result.current.create.isSuccess).toBe(true));
    const [url, init] = mock.mock.calls[0];
    expect(String(url)).toMatch(/\/inventory\/v2\/lots$/);
    expect(init?.method).toBe("POST");
    expect(((init?.headers ?? {}) as Record<string, string>)["Idempotency-Key"]).toBeTruthy();
  });

  it("quarantine POSTs to /lots/:id/quarantine with reason + Idempotency-Key", async () => {
    const mock = stubFetch(() => ({ status: 200, body: { ...ok, status: "quarantined", version: 2 } }));
    const { result } = renderHook(() => useLotMutations(), { wrapper: wrapper() });
    act(() => result.current.quarantine.mutate({ id: "LOT-1", reason: "فحص", expectedVersion: 1 }));
    await waitFor(() => expect(result.current.quarantine.isSuccess).toBe(true));
    const [url, init] = mock.mock.calls[0];
    expect(String(url)).toMatch(/\/inventory\/v2\/lots\/LOT-1\/quarantine$/);
    expect(String(init?.body)).toContain("reason");
    expect(((init?.headers ?? {}) as Record<string, string>)["Idempotency-Key"]).toBeTruthy();
  });

  it("a 409 recall surfaces as ApiError(conflict), no auto-retry", async () => {
    const mock = stubFetch(() => ({ status: 409, body: { success: false, code: "VERSION_CONFLICT", error: "تغيّرت الدفعة" } }));
    const { result } = renderHook(() => useLotMutations(), { wrapper: wrapper() });
    act(() => result.current.recall.mutate({ id: "LOT-1", reason: "استدعاء", expectedVersion: 1 }));
    await waitFor(() => expect(result.current.recall.isError).toBe(true));
    expect(result.current.recall.error).toBeInstanceOf(ApiError);
    expect((result.current.recall.error as ApiError).isConflict).toBe(true);
    expect(mock).toHaveBeenCalledTimes(1);
  });
});

describe("lot adapters", () => {
  it("toLotPage coerces rows + pagination", () => {
    const page = toLotPage({ data: [{ id: "L1", itemId: "I1", itemName: "زيت", lotNumber: "B1", expiryClass: "critical", daysToExpiry: 5, lifecycleStatus: "active", totalQty: "30", version: "1" }], pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 } });
    expect(page.rows[0].totalQty).toBe(30);
    expect(page.rows[0].expiryClass).toBe("critical");
    expect(page.pagination.total).toBe(1);
  });
  it("toIntegrity flags drift", () => {
    const r = toIntegrity({ data: [{ warehouseId: "W", warehouseName: "W", itemId: "I", itemName: "x", stockQty: 35, lotQty: 30, drift: 5, ok: false }], summary: { total: 1, drifting: 1 } });
    expect(r.rows[0].ok).toBe(false);
    expect(r.rows[0].drift).toBe(5);
    expect(r.summary.drifting).toBe(1);
  });
});
