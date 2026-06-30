import { describe, it, expect } from "vitest";
import { toApiError, kindFromStatus, ApiError } from "../api-error";

describe("kindFromStatus", () => {
  it("maps HTTP statuses to error kinds", () => {
    expect(kindFromStatus(401)).toBe("unauthorized");
    expect(kindFromStatus(403)).toBe("forbidden");
    expect(kindFromStatus(404)).toBe("not_found");
    expect(kindFromStatus(409)).toBe("conflict");
    expect(kindFromStatus(422)).toBe("validation");
    expect(kindFromStatus(400)).toBe("validation");
    expect(kindFromStatus(500)).toBe("server");
  });
});

describe("toApiError", () => {
  it("reads the legacy flat { error: string } shape", () => {
    const err = toApiError(400, { error: "الكمية غير صالحة" });
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe("الكمية غير صالحة");
    expect(err.kind).toBe("validation");
  });

  it("reads { success:false, error, code, field }", () => {
    const err = toApiError(409, { success: false, error: "state changed", code: "STATE_CHANGED" });
    expect(err.kind).toBe("conflict");
    expect(err.code).toBe("STATE_CHANGED");
    expect(err.isConflict).toBe(true);
  });

  it("reads the new nested contract { error:{ code, message, field, requestId } }", () => {
    const err = toApiError(422, {
      success: false,
      error: { code: "STOCK_INSUFFICIENT", message: "الرصيد غير كافٍ", field: "lines.2.qty", requestId: "req_1" },
    });
    expect(err.code).toBe("STOCK_INSUFFICIENT");
    expect(err.message).toBe("الرصيد غير كافٍ");
    expect(err.details?.field).toBe("lines.2.qty");
    expect(err.requestId).toBe("req_1");
  });

  it("flags permission-denied for 401/403", () => {
    expect(toApiError(401, {}).isPermissionDenied).toBe(true);
    expect(toApiError(403, {}).isPermissionDenied).toBe(true);
    expect(toApiError(500, {}).isPermissionDenied).toBe(false);
  });
});
