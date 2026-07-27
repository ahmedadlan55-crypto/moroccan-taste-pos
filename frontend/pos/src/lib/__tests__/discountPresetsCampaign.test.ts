/**
 * W2-B — the discount-preset fields the client used to THROW AWAY.
 *
 * /api/settings/discounts-v2-full (routes/settings.js:371) has always shipped
 * requireCode / code / requireApproval / minRole / validFrom / validTo /
 * maxPerInvoice / applyOn. The old mapper kept only
 * {id,name,type,value,scope,minOrder,maxAmount}, so an owner could configure a
 * promo code or a weekend campaign and the register would ignore it silently.
 *
 * These specs pin the mapping AND the enforcement rules, at the pure level
 * (the UI prompts/locks that consume them are pinned in the component specs).
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  _resetDiscountPresetsCache,
  isPresetInWindow,
  loadDiscountPresets,
  presetCap,
  presetCodeMatches,
  presetInvoiceFill,
  presetLineAmount,
  presetNeedsApproval,
  presetsForScope,
  type DiscountPreset,
} from "../discountPresets";

function preset(over: Partial<DiscountPreset> = {}): DiscountPreset {
  return {
    id: "D1",
    name: "عرض",
    type: "PERCENT",
    value: 10,
    scope: "invoice",
    minOrder: null,
    maxAmount: null,
    maxPerInvoice: null,
    requireCode: false,
    code: null,
    requireApproval: false,
    minRole: "cashier",
    validFrom: null,
    validTo: null,
    applyOn: "invoice",
    ...over,
  };
}

function stubRows(rows: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => rows })) as unknown as typeof fetch,
  );
}

beforeEach(() => {
  _resetDiscountPresetsCache();
  localStorage.setItem("pos_token", "tok-test");
});
afterEach(() => vi.unstubAllGlobals());

describe("the mapper carries every configured field through", () => {
  it("keeps requireCode/code/requireApproval/minRole/validFrom/validTo/maxPerInvoice/applyOn", async () => {
    stubRows([
      {
        id: "PROMO",
        name: "رمضان",
        type: "percentage",
        value: 20,
        enabled: true,
        showInPos: true,
        discountScope: "invoice",
        maxAmount: 50,
        maxPerInvoice: 40,
        requireCode: true,
        code: "RAMADAN25",
        requireApproval: true,
        minRole: "Manager",
        validFrom: "2026-07-01",
        validTo: "2026-07-31T00:00:00.000Z",
        applyOn: "item",
      },
    ]);
    const [p] = await loadDiscountPresets();
    expect(p).toMatchObject({
      requireCode: true,
      code: "RAMADAN25",
      requireApproval: true,
      minRole: "manager", // normalised
      validFrom: "2026-07-01",
      validTo: "2026-07-31", // an ISO timestamp collapses to its calendar day
      maxPerInvoice: 40,
      applyOn: "item",
    });
  });

  it("treats the route's 0 sentinel as «no ceiling» for both DECIMAL caps", async () => {
    stubRows([{ id: 1, name: "بلا سقف", type: "fixed", value: 5, enabled: true, maxAmount: 0, maxPerInvoice: 0 }]);
    const [p] = await loadDiscountPresets();
    expect(p.maxAmount).toBeNull();
    expect(p.maxPerInvoice).toBeNull();
  });

  it("defaults minRole to cashier and applyOn to invoice when the owner set neither", async () => {
    stubRows([{ id: 1, name: "بسيط", type: "fixed", value: 5, enabled: true }]);
    const [p] = await loadDiscountPresets();
    expect(p.minRole).toBe("cashier");
    expect(p.applyOn).toBe("invoice");
    expect(p.requireCode).toBe(false);
    expect(p.requireApproval).toBe(false);
  });
});

describe("validFrom / validTo — an out-of-window campaign is never OFFERED", () => {
  const july20 = new Date(2026, 6, 20, 13, 0, 0); // local noon-ish, month is 0-based

  it("includes a preset inside its window (both bounds inclusive)", () => {
    expect(isPresetInWindow(preset({ validFrom: "2026-07-20", validTo: "2026-07-20" }), july20)).toBe(true);
  });

  it("excludes one that has not opened and one that has closed", () => {
    expect(isPresetInWindow(preset({ validFrom: "2026-07-21" }), july20)).toBe(false);
    expect(isPresetInWindow(preset({ validTo: "2026-07-19" }), july20)).toBe(false);
  });

  it("an open-ended side never excludes", () => {
    expect(isPresetInWindow(preset({ validFrom: null, validTo: null }), july20)).toBe(true);
  });

  it("presetsForScope drops the out-of-window rows entirely", () => {
    const rows = [
      preset({ id: "now", scope: "invoice" }),
      preset({ id: "next-week", scope: "invoice", validFrom: "2026-07-27" }),
      preset({ id: "expired", scope: "preset", validTo: "2026-07-01" }),
    ];
    expect(presetsForScope(rows, "invoice", july20).map((p) => p.id)).toEqual(["now"]);
  });
});

describe("requireCode — the promo code has to match", () => {
  const p = preset({ requireCode: true, code: "SUMMER" });

  it("accepts the code case- and whitespace-insensitively", () => {
    expect(presetCodeMatches(p, " summer ")).toBe(true);
    expect(presetCodeMatches(p, "SUMMER")).toBe(true);
  });

  it("refuses a wrong or empty code", () => {
    expect(presetCodeMatches(p, "WINTER")).toBe(false);
    expect(presetCodeMatches(p, "")).toBe(false);
  });

  it("a preset with requireCode but NO code is unusable — misconfiguration fails closed", () => {
    expect(presetCodeMatches(preset({ requireCode: true, code: null }), "")).toBe(false);
    expect(presetCodeMatches(preset({ requireCode: true, code: null }), "anything")).toBe(false);
  });

  it("a preset that needs no code always matches", () => {
    expect(presetCodeMatches(preset(), "")).toBe(true);
  });
});

describe("requireApproval + minRole — the manager gate", () => {
  it("requireApproval needs authority no matter the role", () => {
    expect(presetNeedsApproval(preset({ requireApproval: true }), "manager")).toBe(true);
    expect(presetNeedsApproval(preset({ requireApproval: true }), "cashier")).toBe(true);
  });

  it("minRole above the actor needs authority; at or below does not", () => {
    expect(presetNeedsApproval(preset({ minRole: "manager" }), "cashier")).toBe(true);
    expect(presetNeedsApproval(preset({ minRole: "manager" }), "manager")).toBe(false);
    expect(presetNeedsApproval(preset({ minRole: "manager" }), "admin")).toBe(false);
    expect(presetNeedsApproval(preset({ minRole: "cashier" }), "cashier")).toBe(false);
  });

  it("an unrecognised minRole ranks with the cashier — a typo never ELEVATES a preset", () => {
    expect(presetNeedsApproval(preset({ minRole: "supervisorr" }), "cashier")).toBe(false);
  });
});

describe("maxAmount / maxPerInvoice — the two ceilings", () => {
  it("presetCap is the tighter of the two, or null when neither is set", () => {
    expect(presetCap(preset({ maxAmount: 50, maxPerInvoice: 40 }))).toBe(40);
    expect(presetCap(preset({ maxAmount: 30, maxPerInvoice: 40 }))).toBe(30);
    expect(presetCap(preset())).toBeNull();
  });

  describe("on a LINE", () => {
    it("keeps the legacy maxAmount cap (50% of 46 → capped at 10)", () => {
      expect(presetLineAmount(preset({ type: "PERCENT", value: 50, maxAmount: 10 }), 46)).toBe(10);
    });

    it("maxPerInvoice caps the preset's INVOICE-WIDE total, not each line alone", () => {
      const p = preset({ type: "FIXED", value: 5, maxPerInvoice: 12 });
      expect(presetLineAmount(p, 100, 0)).toBe(5); // first line
      expect(presetLineAmount(p, 100, 5)).toBe(5); // second — 10 of 12 used
      expect(presetLineAmount(p, 100, 10)).toBe(2); // third — only 2 left
      expect(presetLineAmount(p, 100, 12)).toBe(0); // budget spent
    });

    it("still never exceeds the line gross", () => {
      expect(presetLineAmount(preset({ type: "FIXED", value: 500 }), 46)).toBe(46);
    });
  });

  describe("on the INVOICE — the asymmetry that used to let a ceiling be ignored", () => {
    it("a percentage whose amount breaks maxAmount lands as the FIXED ceiling", () => {
      // 20% of 900 = 180, but the owner said never more than 50.
      const fill = presetInvoiceFill(preset({ type: "PERCENT", value: 20, maxAmount: 50 }), 900);
      expect(fill).toEqual({ type: "FIXED", value: 50, capped: true });
    });

    it("maxPerInvoice caps the invoice discount exactly the same way", () => {
      const fill = presetInvoiceFill(preset({ type: "FIXED", value: 200, maxPerInvoice: 75 }), 900);
      expect(fill).toEqual({ type: "FIXED", value: 75, capped: true });
    });

    it("under the ceiling the preset fills VERBATIM — percentages stay percentages", () => {
      const fill = presetInvoiceFill(preset({ type: "PERCENT", value: 10, maxAmount: 500 }), 900);
      expect(fill).toEqual({ type: "PERCENT", value: 10, capped: false });
    });

    it("no ceiling configured → nothing is rewritten", () => {
      expect(presetInvoiceFill(preset({ type: "PERCENT", value: 20 }), 900)).toEqual({
        type: "PERCENT",
        value: 20,
        capped: false,
      });
    });
  });
});
