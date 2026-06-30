import { describe, it, expect, afterEach, vi } from "vitest";
import { apiClient } from "../api-client";
import { ApiError } from "../api-error";
import { stubFetch } from "@/test/test-utils";

afterEach(() => vi.unstubAllGlobals());

describe("apiClient", () => {
  it("returns parsed JSON on success and sends the JWT when present", async () => {
    localStorage.setItem("pos_token", "tok123");
    const mock = stubFetch(() => ({ status: 200, body: { success: true, rows: [1, 2] } }));
    const data = await apiClient.get<{ rows: number[] }>("/inventory/grid");
    expect(data.rows).toEqual([1, 2]);
    const init = mock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok123");
    localStorage.removeItem("pos_token");
  });

  it("maps 401 → unauthorized, 403 → forbidden, 409 → conflict, 500 → server", async () => {
    for (const [status, kind] of [[401, "unauthorized"], [403, "forbidden"], [409, "conflict"], [500, "server"]] as const) {
      stubFetch(() => ({ status, body: { error: "x" } }));
      const err = await apiClient.get("/x").catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).kind).toBe(kind);
    }
  });

  it("NEVER turns a server error into an empty array (throws instead)", async () => {
    stubFetch(() => ({ status: 500, body: { error: "boom" } }));
    await expect(apiClient.get("/inventory/grid")).rejects.toBeInstanceOf(ApiError);
  });

  it("surfaces a network failure as ApiError(kind=network)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const err = await apiClient.get("/x").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe("network");
  });

  it("re-throws an AbortError WITHOUT wrapping it (so cancellations aren't shown as errors)", async () => {
    const controller = new AbortController();
    controller.abort();
    stubFetch(() => ({ status: 200, body: {} }));
    const err = await apiClient.get("/x", { signal: controller.signal }).catch((e) => e);
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe("AbortError");
    expect(err).not.toBeInstanceOf(ApiError);
  });

  it("passes query params and skips empty ones", async () => {
    const mock = stubFetch(() => ({ status: 200, body: {} }));
    await apiClient.get("/inventory/grid", { params: { page: 2, q: "", warehouseId: "WH-1" } });
    const url = mock.mock.calls[0][0] as string;
    expect(url).toContain("page=2");
    expect(url).toContain("warehouseId=WH-1");
    expect(url).not.toContain("q=");
  });
});
