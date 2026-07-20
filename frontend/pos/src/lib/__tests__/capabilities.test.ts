/**
 * capabilities — posCan() precedence (Owner J: frontend capability awareness):
 *   1. caps.isAdmin always wins.
 *   2. loaded caps + an explicit granted permission wins next.
 *   3. otherwise fall back to POS_ROLE_FALLBACK[capId] by role (mirrors the
 *      isSupervisor()-based gating this app already performs).
 *   4. a capId absent from the fallback table defaults to allowed — posCan()
 *      never invents a NEW restriction that doesn't already exist.
 */
import { describe, expect, it } from "vitest";
import { posCan, POS_ROLE_FALLBACK, type EffectiveCaps } from "../capabilities";

const GATED_CAP_ID = "pos.discount.override"; // present in POS_ROLE_FALLBACK

function makeCaps(overrides: Partial<EffectiveCaps> = {}): EffectiveCaps {
  return {
    permissions: new Set<string>(),
    role: "cashier",
    isAdmin: false,
    loaded: true,
    ...overrides,
  };
}

describe("posCan — isAdmin always passes", () => {
  it("isAdmin true short-circuits regardless of role or capId", () => {
    const caps = makeCaps({ isAdmin: true, role: "cashier", permissions: new Set() });
    expect(posCan(caps, "cashier", GATED_CAP_ID)).toBe(true);
    expect(posCan(caps, "cashier", "totally-unknown-cap")).toBe(true);
  });
});

describe("posCan — loaded caps with an explicit granted permission", () => {
  it("returns true even for a role NOT in the fallback table (e.g. cashier)", () => {
    const caps = makeCaps({ loaded: true, role: "cashier", permissions: new Set([GATED_CAP_ID]) });
    expect(posCan(caps, "cashier", GATED_CAP_ID)).toBe(true);
  });
});

describe("posCan — loaded caps but the permission is missing", () => {
  it("falls back to the role table: admin/manager pass, cashier does not", () => {
    const caps = makeCaps({ loaded: true, role: "cashier", permissions: new Set(["some.other.perm"]) });
    expect(posCan(caps, "cashier", GATED_CAP_ID)).toBe(false);
    expect(posCan(caps, "admin", GATED_CAP_ID)).toBe(true);
    expect(posCan(caps, "manager", GATED_CAP_ID)).toBe(true);
  });
});

describe("posCan — caps not loaded yet (null)", () => {
  it("falls back to the role table exactly like the loaded-but-missing case", () => {
    expect(posCan(null, "cashier", GATED_CAP_ID)).toBe(false);
    expect(posCan(null, "admin", GATED_CAP_ID)).toBe(true);
    expect(posCan(null, "Manager", GATED_CAP_ID)).toBe(true); // case-insensitive
  });
});

describe("posCan — capId absent from the fallback table", () => {
  it("defaults to allowed for any role, loaded or not (never invents a restriction)", () => {
    const capId = "pos.some.never-gated-action";
    expect(POS_ROLE_FALLBACK[capId]).toBeUndefined();
    expect(posCan(null, "cashier", capId)).toBe(true);
    expect(posCan(makeCaps({ loaded: true, role: "cashier" }), "cashier", capId)).toBe(true);
  });
});
