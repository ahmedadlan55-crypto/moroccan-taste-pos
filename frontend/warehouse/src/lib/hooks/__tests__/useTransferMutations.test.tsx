import { describe, it, expect, afterEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { makeTestClient, stubFetch } from "@/test/test-utils";
import { useApproveTransfer, useIssueTransfer, useReceiveTransfer } from "../useTransferMutations";
import { ApiError } from "@/lib/api-error";

afterEach(() => vi.unstubAllGlobals());

function wrapper() {
  const client = makeTestClient();
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const okEnvelope = { success: true, status: "issued", version: 3, data: { id: "SI-1" }, affectedStock: [] };

describe("useTransferMutations", () => {
  it("approve POSTs the expectedVersion for optimistic concurrency", async () => {
    const mock = stubFetch(() => ({ status: 200, body: { ...okEnvelope, status: "approved", version: 2 } }));
    const { result } = renderHook(() => useApproveTransfer(), { wrapper: wrapper() });
    act(() => result.current.mutate({ id: "SI-1", expectedVersion: 1 }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const [url, init] = mock.mock.calls[0];
    expect(String(url)).toMatch(/\/erp\/stock-issues\/SI-1\/approve$/);
    expect(init?.method).toBe("POST");
    expect(String(init?.body)).toContain("expectedVersion");
  });

  it("issue carries an Idempotency-Key header", async () => {
    const mock = stubFetch(() => ({ status: 200, body: okEnvelope }));
    const { result } = renderHook(() => useIssueTransfer(), { wrapper: wrapper() });
    act(() => result.current.mutate({ id: "SI-1", expectedVersion: 2 }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const headers = (mock.mock.calls[0][1]?.headers ?? {}) as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBeTruthy();
  });

  it("a 409 surfaces as an ApiError of kind 'conflict' (no auto-retry)", async () => {
    const mock = stubFetch(() => ({ status: 409, body: { success: false, code: "VERSION_CONFLICT", error: "تغيّرت الحالة" } }));
    const { result } = renderHook(() => useReceiveTransfer(), { wrapper: wrapper() });
    act(() => result.current.mutate({ id: "SI-1", input: { expectedVersion: 2 } }));
    await waitFor(() => expect(result.current.isError).toBe(true));
    const err = result.current.error;
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).isConflict).toBe(true);
    expect((err as ApiError).code).toBe("VERSION_CONFLICT");
    // mutations.retry = false → exactly one request, no retry storm.
    expect(mock).toHaveBeenCalledTimes(1);
  });
});
