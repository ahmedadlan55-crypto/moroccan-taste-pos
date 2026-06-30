import { describe, it, expect, afterEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { makeTestClient, stubFetch } from "@/test/test-utils";
import { useItemMutations } from "../useItems";
import { ApiError } from "@/lib/api-error";

afterEach(() => vi.unstubAllGlobals());
function wrapper() { const client = makeTestClient(); return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>; }
const ok = { success: true, status: "active", version: 1, data: { id: "INV-1" }, id: "INV-1" };

describe("useItemMutations", () => {
  it("create POSTs to /inventory/v2/items with an Idempotency-Key", async () => {
    const mock = stubFetch(() => ({ status: 201, body: { ...ok } }));
    const { result } = renderHook(() => useItemMutations(), { wrapper: wrapper() });
    act(() => result.current.create.mutate({ name: "زيت", sku: "X1", unit: "لتر" }));
    await waitFor(() => expect(result.current.create.isSuccess).toBe(true));
    const [url, init] = mock.mock.calls[0];
    expect(String(url)).toMatch(/\/inventory\/v2\/items$/);
    expect(init?.method).toBe("POST");
    expect(((init?.headers ?? {}) as Record<string, string>)["Idempotency-Key"]).toBeTruthy();
  });

  it("update PATCHes with expectedVersion", async () => {
    const mock = stubFetch(() => ({ status: 200, body: { ...ok, version: 2 } }));
    const { result } = renderHook(() => useItemMutations(), { wrapper: wrapper() });
    act(() => result.current.update.mutate({ id: "INV-1", input: { name: "محدث", expectedVersion: 1 } }));
    await waitFor(() => expect(result.current.update.isSuccess).toBe(true));
    const [url, init] = mock.mock.calls[0];
    expect(String(url)).toMatch(/\/inventory\/v2\/items\/INV-1$/);
    expect(init?.method).toBe("PATCH");
    expect(String(init?.body)).toContain("expectedVersion");
  });

  it("saveRule PUTs to /warehouse-rules/:wh with an Idempotency-Key", async () => {
    const mock = stubFetch(() => ({ status: 200, body: { ...ok, version: 1 } }));
    const { result } = renderHook(() => useItemMutations(), { wrapper: wrapper() });
    act(() => result.current.saveRule.mutate({ id: "INV-1", warehouseId: "WA", input: { reorderPoint: 10, reorderQty: 20 } }));
    await waitFor(() => expect(result.current.saveRule.isSuccess).toBe(true));
    const [url, init] = mock.mock.calls[0];
    expect(String(url)).toMatch(/\/inventory\/v2\/items\/INV-1\/warehouse-rules\/WA$/);
    expect(init?.method).toBe("PUT");
    expect(((init?.headers ?? {}) as Record<string, string>)["Idempotency-Key"]).toBeTruthy();
  });

  it("a 409 surfaces as ApiError(conflict) with no auto-retry", async () => {
    const mock = stubFetch(() => ({ status: 409, body: { success: false, code: "VERSION_CONFLICT", error: "تغيّر الصنف" } }));
    const { result } = renderHook(() => useItemMutations(), { wrapper: wrapper() });
    act(() => result.current.update.mutate({ id: "INV-1", input: { name: "x", expectedVersion: 1 } }));
    await waitFor(() => expect(result.current.update.isError).toBe(true));
    const err = result.current.update.error;
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).isConflict).toBe(true);
    expect(mock).toHaveBeenCalledTimes(1);
  });
});
