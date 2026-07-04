import { describe, expect, it } from "vitest";
import { ulid } from "../ulid";

const CROCKFORD = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;

describe("ulid", () => {
  it("emits 26 Crockford base32 chars (no I, L, O, U)", () => {
    for (let i = 0; i < 50; i++) {
      expect(ulid()).toMatch(CROCKFORD);
    }
  });

  it("matches the server's ULID_RE acceptance (/^[0-9A-Za-z_-]{10,40}$/)", () => {
    expect(ulid()).toMatch(/^[0-9A-Za-z_-]{10,40}$/);
  });

  it("is unique across many generations", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) seen.add(ulid());
    expect(seen.size).toBe(5000);
  });

  it("encodes time in the first 10 chars (later ms → lexicographically later)", () => {
    const a = ulid(1_700_000_000_000);
    const b = ulid(1_700_000_000_001);
    expect(a.slice(0, 10) < b.slice(0, 10)).toBe(true);
  });

  it("is monotonic within the same millisecond", () => {
    const t = 1_700_000_000_500;
    const ids = Array.from({ length: 200 }, () => ulid(t));
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
    expect(new Set(ids).size).toBe(200);
  });
});
