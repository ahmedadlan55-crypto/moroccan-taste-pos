import { describe, it, expect, afterEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { makeTestClient, stubFetch } from "@/test/test-utils";
import { useInvTxMutations } from "../useInventoryTx";
import { ApiError } from "@/lib/api-error";

afterEach(() => vi.unstubAllGlobals());

function wrapper() {
  const client = makeTestClient();
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const ok = { success: true, status: "draft", version: 1, documentNumber: "RCV-1", data: { id: "RC-1" }, affectedStock: [], affectedValue: 0, movementIds: [], journalId: null };

describe("useInvTxMutations (receipts)", () => {
  it("create POSTs to /inventory/v2/receipts with an Idempotency-Key", async () => {
    const mock = stubFetch(() => ({ status: 201, body: { ...ok, status: "draft" } }));
    const { result } = renderHook(() => useInvTxMutations("receipt"), { wrapper: wrapper() });
    act(() => result.current.create.mutate({ warehouseId: "WA", items: [{ itemId: "I1", qty: 5, unitCost: 7 }] }));
    await waitFor(() => expect(result.current.create.isSuccess).toBe(true));
    const [url, init] = mock.mock.calls[0];
    expect(String(url)).toMatch(/\/inventory\/v2\/receipts$/);
    expect(init?.method).toBe("POST");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBeTruthy();
  });

  it("update PATCHes the SAME document with expectedVersion (no recreate)", async () => {
    const mock = stubFetch(() => ({ status: 200, body: { ...ok, status: "draft", version: 3, data: { id: "RC-1" } } }));
    const { result } = renderHook(() => useInvTxMutations("receipt"), { wrapper: wrapper() });
    act(() => result.current.update.mutate({ id: "RC-1", input: { warehouseId: "WA", expectedVersion: 2, items: [{ itemId: "I1", qty: 5, unitCost: 7 }] } }));
    await waitFor(() => expect(result.current.update.isSuccess).toBe(true));
    const [url, init] = mock.mock.calls[0];
    expect(String(url)).toMatch(/\/inventory\/v2\/receipts\/RC-1$/);
    expect(init?.method).toBe("PATCH");
    expect(String(init?.body)).toContain("expectedVersion");
  });

  it("post carries an Idempotency-Key + expectedVersion", async () => {
    const mock = stubFetch(() => ({ status: 200, body: { ...ok, status: "posted", version: 4 } }));
    const { result } = renderHook(() => useInvTxMutations("issue"), { wrapper: wrapper() });
    act(() => result.current.post.mutate({ id: "IS-1", expectedVersion: 3 }));
    await waitFor(() => expect(result.current.post.isSuccess).toBe(true));
    const [url, init] = mock.mock.calls[0];
    expect(String(url)).toMatch(/\/inventory\/v2\/issues\/IS-1\/post$/);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBeTruthy();
    expect(String(init?.body)).toContain("expectedVersion");
  });

  it("a 409 surfaces as ApiError(conflict) with no auto-retry", async () => {
    const mock = stubFetch(() => ({ status: 409, body: { success: false, code: "VERSION_CONFLICT", error: "تغيّرت الحالة" } }));
    const { result } = renderHook(() => useInvTxMutations("adjustment"), { wrapper: wrapper() });
    act(() => result.current.post.mutate({ id: "AD-1", expectedVersion: 2 }));
    await waitFor(() => expect(result.current.post.isError).toBe(true));
    const err = result.current.post.error;
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).isConflict).toBe(true);
    expect((err as ApiError).code).toBe("VERSION_CONFLICT");
    expect(mock).toHaveBeenCalledTimes(1);
  });
});
