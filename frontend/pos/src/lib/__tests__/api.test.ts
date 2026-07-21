/**
 * Fix B — the `allowPartialSuccess` opt-out on request()/postSync().
 *
 * Root cause (see routes/pos-v2.js's POST /sync ~line 1082): the server
 * answers a partial-batch failure with HTTP 200 + `{success: results.every(r
 * => r.ok), results}` — a legitimate per-op report, no top-level
 * error/message field. request()'s generic contract used to treat ANY
 * `body.success === false` as a hard failure and throw an ApiError whose
 * message fell back to the literal `HTTP ${res.status}` (there was nothing
 * else to read) — producing the useless toast "HTTP 200" for offline.ts's
 * runSyncBatch to catch. postSync() now opts OUT of that hard-throw via
 * `allowPartialSuccess`, so a 2xx response is always returned to the caller
 * as data (letting the caller read results[] itself); a genuine non-2xx
 * failure (auth, batch-level validation) still throws exactly as before.
 *
 * These tests pin BOTH halves of the contract: postSync()'s new opt-in
 * behavior, AND that every other endpoint's throw-on-success:false is
 * completely unchanged (spot-checked via getServerFlags(), which goes
 * through the exact same request() helper with no opt-out).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, getServerFlags, postSync, request } from "../api";

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("postSync() — HTTP 200 partial-batch failure is data, not an exception", () => {
  it("does NOT throw when the server answers 200 with success:false + per-op results", async () => {
    stubFetch(200, {
      success: false,
      results: [
        { opId: "OP1", ok: true, result: { version: 2 } },
        { opId: "OP2", ok: false, code: "VALIDATION_ERROR", error: "بيانات غير صالحة" },
      ],
    });

    const resp = await postSync([
      { opId: "OP1", type: "hold", orderId: "O1", payload: {} },
      { opId: "OP2", type: "hold", orderId: "O2", payload: {} },
    ]);

    // The full envelope reaches the caller — nothing thrown, nothing swallowed.
    expect(resp.success).toBe(false);
    expect(resp.results).toHaveLength(2);
    expect(resp.results.find((r) => r.opId === "OP1")?.ok).toBe(true);
    const failed = resp.results.find((r) => r.opId === "OP2");
    expect(failed?.ok).toBe(false);
    expect(failed?.code).toBe("VALIDATION_ERROR");
    expect(failed?.error).toBe("بيانات غير صالحة");
  });

  it("still resolves cleanly when every op in the batch succeeds (success:true, unaffected)", async () => {
    stubFetch(200, { success: true, results: [{ opId: "OP1", ok: true, result: { version: 3 } }] });
    const resp = await postSync([{ opId: "OP1", type: "hold", orderId: "O1", payload: {} }]);
    expect(resp.success).toBe(true);
    expect(resp.results[0].ok).toBe(true);
  });

  it("still THROWS on a genuine non-2xx failure (auth, or a batch-level rejection) — allowPartialSuccess only covers a 2xx envelope", async () => {
    stubFetch(422, { success: false, code: "VALIDATION_ERROR", error: "ops مطلوبة" });
    await expect(postSync([])).rejects.toMatchObject({
      status: 422,
      code: "VALIDATION_ERROR",
      message: "ops مطلوبة",
    });
  });

  it("still throws on a 401 with no body (session expired) — the !res.ok branch is untouched by allowPartialSuccess", async () => {
    stubFetch(401, null);
    await expect(postSync([])).rejects.toBeInstanceOf(ApiError);
  });
});

describe("request() — allowPartialSuccess is opt-IN, scoped to the single call site that passes it", () => {
  it("without allowPartialSuccess, a 200 + success:false still hard-throws exactly as before (the literal HTTP-status fallback included) — proves the generic contract for every OTHER endpoint is unchanged", async () => {
    stubFetch(200, { success: false });
    await expect(request("/api/pos/v2/catalog")).rejects.toMatchObject({
      status: 200,
      message: "HTTP 200",
    });
  });

  it("getServerFlags() (a real, unrelated endpoint) still throws on success:false — spot check that only postSync() opted out", async () => {
    stubFetch(200, { success: false, error: "تعذّر تحميل الإعدادات" });
    await expect(getServerFlags()).rejects.toMatchObject({ message: "تعذّر تحميل الإعدادات" });
  });

  it("request({allowPartialSuccess:true}) still throws on a real non-2xx failure — the opt-out never masks a transport-level error", async () => {
    stubFetch(500, { success: false, error: "server exploded" });
    await expect(request("/api/pos/v2/sync", { method: "POST", allowPartialSuccess: true })).rejects.toMatchObject({
      status: 500,
      message: "server exploded",
    });
  });

  it("request({allowPartialSuccess:true}) returns a 200 body with success:false as plain data", async () => {
    stubFetch(200, { success: false, results: [] });
    const body = await request<{ success: boolean; results: unknown[] }>("/api/pos/v2/sync", {
      method: "POST",
      allowPartialSuccess: true,
    });
    expect(body).toEqual({ success: false, results: [] });
  });
});
