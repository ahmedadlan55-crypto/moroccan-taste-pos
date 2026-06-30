import { describe, it, expect, afterEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { makeTestClient, stubFetch } from "@/test/test-utils";
import { useStocktakeMutations } from "../useStocktakes";
import { ApiError } from "@/lib/api-error";

afterEach(() => vi.unstubAllGlobals());

function wrapper() {
  const client = makeTestClient();
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const ok = { success: true, status: "draft", version: 1, documentNumber: "STK-1", data: { id: "STK-1" } };

describe("useStocktakeMutations", () => {
  it("create POSTs to /inventory/v2/stocktakes with an Idempotency-Key", async () => {
    const mock = stubFetch(() => ({ status: 201, body: { ...ok } }));
    const { result } = renderHook(() => useStocktakeMutations(), { wrapper: wrapper() });
    act(() => result.current.create.mutate({ warehouseId: "WA", scopeType: "full", reason: "جرد" }));
    await waitFor(() => expect(result.current.create.isSuccess).toBe(true));
    const [url, init] = mock.mock.calls[0];
    expect(String(url)).toMatch(/\/inventory\/v2\/stocktakes$/);
    expect(init?.method).toBe("POST");
    expect(((init?.headers ?? {}) as Record<string, string>)["Idempotency-Key"]).toBeTruthy();
  });

  it("saveCounts PUTs to /:id/counts", async () => {
    const mock = stubFetch(() => ({ status: 200, body: { success: true, status: "counting" } }));
    const { result } = renderHook(() => useStocktakeMutations(), { wrapper: wrapper() });
    act(() => result.current.saveCounts.mutate({ id: "STK-1", counts: [{ itemId: "I1", countedQty: 5 }] }));
    await waitFor(() => expect(result.current.saveCounts.isSuccess).toBe(true));
    const [url, init] = mock.mock.calls[0];
    expect(String(url)).toMatch(/\/inventory\/v2\/stocktakes\/STK-1\/counts$/);
    expect(init?.method).toBe("PUT");
    expect(String(init?.body)).toContain("countedQty");
  });

  it("post carries Idempotency-Key + expectedVersion", async () => {
    const mock = stubFetch(() => ({ status: 200, body: { ...ok, status: "posted", version: 5, adjustmentId: "ADV-1" } }));
    const { result } = renderHook(() => useStocktakeMutations(), { wrapper: wrapper() });
    act(() => result.current.post.mutate({ id: "STK-1", expectedVersion: 4 }));
    await waitFor(() => expect(result.current.post.isSuccess).toBe(true));
    const [url, init] = mock.mock.calls[0];
    expect(String(url)).toMatch(/\/inventory\/v2\/stocktakes\/STK-1\/post$/);
    expect(((init?.headers ?? {}) as Record<string, string>)["Idempotency-Key"]).toBeTruthy();
    expect(String(init?.body)).toContain("expectedVersion");
  });

  it("a 409 surfaces as ApiError(conflict) with no auto-retry", async () => {
    const mock = stubFetch(() => ({ status: 409, body: { success: false, code: "VERSION_CONFLICT", error: "تغيّرت الحالة" } }));
    const { result } = renderHook(() => useStocktakeMutations(), { wrapper: wrapper() });
    act(() => result.current.approve.mutate({ id: "STK-1", expectedVersion: 2 }));
    await waitFor(() => expect(result.current.approve.isError).toBe(true));
    const err = result.current.approve.error;
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).isConflict).toBe(true);
    expect((err as ApiError).code).toBe("VERSION_CONFLICT");
    expect(mock).toHaveBeenCalledTimes(1);
  });
});
