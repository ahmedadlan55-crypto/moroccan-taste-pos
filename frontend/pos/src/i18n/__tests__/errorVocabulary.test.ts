/**
 * Regression — DEFECT 6: the error vocabulary.
 *
 * `lib/offline.ts` calls t("errors.CHECKOUT_PREREQUISITE_FAILED") for a real,
 * money-losing outcome (the order never reached the server, so the payment did
 * not happen). The key existed in NEITHER dictionary, so translateApiError's
 * miss-detection handed the cashier the literal dotted path.
 *
 * The same hole covered the codes routes/sales.js and routes/pos-v2.js actually
 * return on a failed checkout. Each one now has a message that says what to DO.
 *
 * VALIDATION_ERROR is deliberately NOT here and this file pins that: it is the
 * server's catch-all bad-input code with ~30 far more specific messages, and
 * translateApiError prefers `errors.<code>` over `e.message` — so adding it
 * would REPLACE every precise sentence with one vague line.
 */
import { describe, expect, it } from "vitest";
import { ar } from "../dictionaries/ar";
import { en } from "../dictionaries/en";
import { errors as arErrors } from "../dictionaries/ar/errors";
import { errors as enErrors } from "../dictionaries/en/errors";
import { translateApiError } from "../errorCodes";

/** The codes the POS can actually be shown, per the server routes that emit them. */
const REQUIRED_CODES = [
  // lib/offline.ts — the checkout prerequisite that never had a key at all
  "CHECKOUT_PREREQUISITE_FAILED",
  // routes/sales.js — checkout
  "total_mismatch",
  "sale_failed",
  "IDEMPOTENCY_UNAVAILABLE",
  // lib/posOrderMachine.js → routes/pos-v2.js
  "PAYMENT_MISMATCH",
  "INVALID_STATE_TRANSITION",
  "UNIT_CONVERSION_CONFLICT",
  "NOT_FOUND",
  // routes/sales.js:486-511 — re-validated on every sale AND every offline replay
  "shift_required",
  "shift_not_found",
  "shift_closed",
  "shift_owner_mismatch",
  // lib/catalogCache.ts — CatalogError.code
  "CATALOG_OFFLINE",
  "CATALOG_LOAD_FAILED",
  "SESSION_EXPIRED",
] as const;

/** Minimal t() over a dictionary: returns the dotted path on a miss, exactly
 *  like I18nProvider — which is how translateApiError detects a missing key. */
function makeT(dict: unknown) {
  return ((path: string) => {
    const hit = path.split(".").reduce<unknown>((acc, k) => (acc as Record<string, unknown>)?.[k], dict);
    return typeof hit === "string" ? hit : path;
  }) as Parameters<typeof translateApiError>[1];
}

describe("every code the server can return has a message in BOTH dictionaries", () => {
  it.each(REQUIRED_CODES)("%s exists in ar and en", (code) => {
    expect(arErrors).toHaveProperty(code);
    expect(enErrors).toHaveProperty(code);
  });

  it("CHECKOUT_PREREQUISITE_FAILED resolves — offline.ts's own fallback is now dead code", () => {
    // offline.ts guards with `error === "errors.CHECKOUT_PREREQUISITE_FAILED"`,
    // i.e. it detects the miss. That guard must never fire again.
    for (const dict of [ar, en]) {
      const t = makeT(dict);
      expect(t("errors.CHECKOUT_PREREQUISITE_FAILED")).not.toBe("errors.CHECKOUT_PREREQUISITE_FAILED");
    }
  });

  it.each(REQUIRED_CODES)("%s reaches the cashier through translateApiError", (code) => {
    for (const dict of [ar, en]) {
      const msg = translateApiError({ code, message: "raw server string" }, makeT(dict));
      expect(msg).not.toBe(`errors.${code}`); // not a path miss
      expect(msg).not.toBe("raw server string"); // the dictionary won
    }
  });
});

describe("the messages are actionable, not just descriptive", () => {
  it.each(REQUIRED_CODES)("%s tells the cashier what to do next", (code) => {
    const arMsg = arErrors[code as keyof typeof arErrors] as string;
    const enMsg = enErrors[code as keyof typeof enErrors] as string;
    for (const msg of [arMsg, enMsg]) {
      expect(typeof msg).toBe("string");
      expect(msg.trim().length).toBeGreaterThan(20);
      // Every message carries an instruction clause after the em-dash separator
      // used throughout these dictionaries ("what failed — what to do").
      expect(msg).toContain("—");
      expect(msg.split("—")[1]?.trim().length ?? 0).toBeGreaterThan(5);
    }
  });

  it("no message is left as a bare code or dotted path", () => {
    for (const dict of [arErrors, enErrors]) {
      for (const [key, msg] of Object.entries(dict)) {
        expect(msg).not.toBe(key);
        expect(msg).not.toMatch(/^errors\./);
      }
    }
  });
});

describe("VALIDATION_ERROR stays OUT so the server's own sentence wins", () => {
  it("is absent from both dictionaries", () => {
    expect(arErrors).not.toHaveProperty("VALIDATION_ERROR");
    expect(enErrors).not.toHaveProperty("VALIDATION_ERROR");
  });

  it("so translateApiError falls through to the specific server message", () => {
    // e.g. routes/pos-v2.js:669 «البيع الآجل يتطلب اختيار عميل» — far more
    // useful than any generic "invalid input" line we could write here.
    const specific = "البيع الآجل يتطلب اختيار عميل";
    expect(translateApiError({ code: "VALIDATION_ERROR", message: specific }, makeT(ar))).toBe(specific);
  });
});
