/**
 * legacyDrain — parsing + replay + partial-failure retention.
 * The drain runs against injected storage/fetch, so these tests use an
 * in-memory Storage stub and a scripted fetch. The load-bearing invariants:
 *   • replay body = { ...order, username, shiftId } (legacy api-bridge shape)
 *   • ONLY successfully-synced entries are removed from localStorage
 *   • domain rejections, transport failures and malformed records are RETAINED
 *     and surfaced — never silently dropped
 *   • a transport failure stops the run (later entries stay untried)
 */
import { describe, expect, it, vi } from "vitest";
import { drainLegacyQueue, legacyQueueCount, parseLegacyQueue, LEGACY_QUEUE_KEY, type DrainDeps } from "../legacyDrain";

// ── Helpers ──────────────────────────────────────────────────────────────────
function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    dump: () => map.get(LEGACY_QUEUE_KEY) ?? null,
  };
}

function entry(clientOrderId: string, extra: Record<string, unknown> = {}) {
  return {
    order: { clientOrderId, items: [{ name: "شاي", qty: 1 }], totalFinal: 23, paymentMethod: "كاش", ...extra },
    user: "cashier1",
    shiftId: "SH-9",
    ts: 1700000000000,
  };
}

const jsonResponse = (body: unknown, status = 200) =>
  ({ status, ok: status < 400, json: async () => body }) as unknown as Response;

function deps(storage: ReturnType<typeof fakeStorage>, fetchFn: DrainDeps["fetchFn"], online = true): DrainDeps {
  return { storage, fetchFn, getToken: () => "tok-123", isOnline: () => online };
}

// ── Parsing ──────────────────────────────────────────────────────────────────
describe("parseLegacyQueue", () => {
  it("parses valid entries and flags malformed ones without dropping them", () => {
    const raw = JSON.stringify([
      entry("a1"),
      { order: { clientOrderId: "" } }, // empty key → invalid
      { noOrder: true }, // no order → invalid
      "garbage-string", // not an object → invalid
      entry("b2"),
    ]);
    const parsed = parseLegacyQueue(raw);
    expect(parsed).toHaveLength(5);
    expect(parsed.map((p) => (p.entry ? p.entry.order.clientOrderId : null))).toEqual(["a1", null, null, null, "b2"]);
  });

  it("malformed JSON / null / non-array → empty (nothing to drain)", () => {
    expect(parseLegacyQueue(null)).toEqual([]);
    expect(parseLegacyQueue("{not json")).toEqual([]);
    expect(parseLegacyQueue('{"an":"object"}')).toEqual([]);
  });

  it("legacyQueueCount counts entries, 0 on missing key", () => {
    const s = fakeStorage({ [LEGACY_QUEUE_KEY]: JSON.stringify([entry("a1"), entry("b2")]) });
    expect(legacyQueueCount(s)).toBe(2);
    expect(legacyQueueCount(fakeStorage())).toBe(0);
  });
});

// ── Drain ────────────────────────────────────────────────────────────────────
describe("drainLegacyQueue", () => {
  it("replays each entry as POST /api/sales with the exact legacy body + Bearer token, then clears", async () => {
    const s = fakeStorage({ [LEGACY_QUEUE_KEY]: JSON.stringify([entry("a1"), entry("b2")]) });
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ success: true, orderId: "INV-77" }));

    const out = await drainLegacyQueue(deps(s, fetchFn));

    expect(fetchFn).toHaveBeenCalledTimes(2);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("/api/sales");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer tok-123");
    const body = JSON.parse(init.body);
    // legacy api-bridge saveOrder shape: { ...order, username, shiftId }
    expect(body.clientOrderId).toBe("a1");
    expect(body.username).toBe("cashier1");
    expect(body.shiftId).toBe("SH-9");
    expect(body.totalFinal).toBe(23);

    expect(out.attempted).toBe(2);
    expect(out.succeeded).toEqual([
      { clientOrderId: "a1", orderId: "INV-77" },
      { clientOrderId: "b2", orderId: "INV-77" },
    ]);
    expect(out.failed).toEqual([]);
    expect(out.remaining).toBe(0);
    expect(JSON.parse(s.dump()!)).toEqual([]);
  });

  it("treats an idempotent replay (clientOrderId dedupe) as success", async () => {
    const s = fakeStorage({ [LEGACY_QUEUE_KEY]: JSON.stringify([entry("dup-1")]) });
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ success: true, idempotent: true, orderId: "OLD-5" }));
    const out = await drainLegacyQueue(deps(s, fetchFn));
    expect(out.succeeded).toEqual([{ clientOrderId: "dup-1", orderId: "OLD-5" }]);
    expect(out.remaining).toBe(0);
  });

  it("PARTIAL FAILURE: domain rejection stays in localStorage and is surfaced; successes are cleared", async () => {
    const s = fakeStorage({ [LEGACY_QUEUE_KEY]: JSON.stringify([entry("ok-1"), entry("bad-2"), entry("ok-3")]) });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ success: true, orderId: "S1" }))
      .mockResolvedValueOnce(jsonResponse({ success: false, error: "الوردية مغلقة" }, 400))
      .mockResolvedValueOnce(jsonResponse({ success: true, orderId: "S3" }));

    const out = await drainLegacyQueue(deps(s, fetchFn));

    expect(out.succeeded.map((x) => x.clientOrderId)).toEqual(["ok-1", "ok-3"]);
    expect(out.failed).toEqual([{ clientOrderId: "bad-2", error: "الوردية مغلقة" }]);
    expect(out.remaining).toBe(1);
    const retained = JSON.parse(s.dump()!);
    expect(retained).toHaveLength(1);
    expect(retained[0].order.clientOrderId).toBe("bad-2"); // verbatim retention
    expect(retained[0].ts).toBe(1700000000000);
  });

  it("TRANSPORT failure stops the run: the failing entry AND every later entry are retained untried", async () => {
    const s = fakeStorage({ [LEGACY_QUEUE_KEY]: JSON.stringify([entry("ok-1"), entry("net-2"), entry("later-3")]) });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ success: true, orderId: "S1" }))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));

    const out = await drainLegacyQueue(deps(s, fetchFn));

    expect(fetchFn).toHaveBeenCalledTimes(2); // later-3 never attempted
    expect(out.succeeded.map((x) => x.clientOrderId)).toEqual(["ok-1"]);
    expect(out.failed).toHaveLength(1);
    expect(out.failed[0].clientOrderId).toBe("net-2");
    expect(out.remaining).toBe(2);
    const retained = JSON.parse(s.dump()!);
    expect(retained.map((r: { order: { clientOrderId: string } }) => r.order.clientOrderId)).toEqual(["net-2", "later-3"]);
  });

  it("malformed records are retained + reported, valid siblings still sync", async () => {
    const s = fakeStorage({
      [LEGACY_QUEUE_KEY]: JSON.stringify([{ broken: true }, entry("ok-1")]),
    });
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ success: true, orderId: "S1" }));
    const out = await drainLegacyQueue(deps(s, fetchFn));
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(out.failed).toEqual([{ clientOrderId: null, error: "سجل غير صالح — يتعذّر إرساله" }]);
    expect(out.remaining).toBe(1);
    expect(JSON.parse(s.dump()!)).toEqual([{ broken: true }]);
  });

  it("offline boot: nothing attempted, storage untouched", async () => {
    const raw = JSON.stringify([entry("a1")]);
    const s = fakeStorage({ [LEGACY_QUEUE_KEY]: raw });
    const fetchFn = vi.fn();
    const out = await drainLegacyQueue(deps(s, fetchFn, /* online */ false));
    expect(fetchFn).not.toHaveBeenCalled();
    expect(out.attempted).toBe(1);
    expect(out.remaining).toBe(1);
    expect(s.dump()).toBe(raw); // byte-identical — not rewritten
  });

  it("empty / missing queue is a no-op", async () => {
    const fetchFn = vi.fn();
    const out = await drainLegacyQueue(deps(fakeStorage(), fetchFn));
    expect(out).toEqual({ attempted: 0, succeeded: [], failed: [], remaining: 0 });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("non-JSON error response body → surfaced as HTTP rejection, entry retained", async () => {
    const s = fakeStorage({ [LEGACY_QUEUE_KEY]: JSON.stringify([entry("a1")]) });
    const fetchFn = vi.fn().mockResolvedValue({
      status: 500,
      ok: false,
      json: async () => {
        throw new Error("not json");
      },
    } as unknown as Response);
    const out = await drainLegacyQueue(deps(s, fetchFn));
    expect(out.failed).toEqual([{ clientOrderId: "a1", error: "رفض الخادم (HTTP 500)" }]);
    expect(out.remaining).toBe(1);
  });
});
