import { describe, expect, it } from "vitest";
import {
  toPolicySettings, toEffectivePolicy, toDeficitLedger, toPolicySaveResult,
  toPolicyMode, toDeficitStatus,
} from "../negative-policy.adapter";

describe("negative-policy.adapter", () => {
  it("maps the camelCase route payload, groups rows by scope and reads env gates", () => {
    const st = toPolicySettings({
      success: true,
      data: [
        { id: "NSP-g", scope: "global", warehouseId: null, warehouseName: null, itemId: null, itemName: null, policy: "block", maxNegativeQty: "0", requireReason: true, isEnabled: true, version: 2, updatedBy: "admin", updatedAt: "2026-07-01" },
        { id: "NSP-w", scope: "warehouse", warehouseId: "WH1", warehouseName: "المستودع الرئيسي", itemId: null, itemName: null, policy: "controlled", maxNegativeQty: "12.5", requireReason: true, isEnabled: true, version: 1, updatedBy: "admin", updatedAt: null },
        { id: "NSP-i", scope: "item", warehouseId: "WH1", warehouseName: "المستودع الرئيسي", itemId: "IT9", itemName: "دقيق", policy: "allow", maxNegativeQty: 0, requireReason: false, isEnabled: false, version: 4, updatedBy: "dev", updatedAt: "2026-07-02" },
      ],
      allowEnabled: false,
      policyEnabled: true,
    });
    expect(st.rows).toHaveLength(3);
    expect(st.globalRow?.id).toBe("NSP-g");
    expect(st.warehouseRows).toHaveLength(1);
    expect(st.warehouseRows[0].maxNegativeQty).toBeCloseTo(12.5);
    expect(st.itemRows[0].itemName).toBe("دقيق");
    expect(st.itemRows[0].requireReason).toBe(false);
    expect(st.itemRows[0].isEnabled).toBe(false);
    expect(st.allowEnabled).toBe(false);
    expect(st.policyEnabled).toBe(true);
  });

  it("accepts snake_case rows (raw DB shape) as a fallback", () => {
    const st = toPolicySettings({
      data: [{
        id: "NSP-x", scope: "warehouse", warehouse_id: "WH2", warehouse_name: "فرع",
        item_id: null, item_name: null, policy: "CONTROLLED", max_negative_qty: "7",
        require_reason: 1, is_enabled: 1, version: "3", updated_by: "a", updated_at: "2026-06-30",
      }],
    });
    const row = st.warehouseRows[0];
    expect(row.warehouseId).toBe("WH2");
    expect(row.warehouseName).toBe("فرع");
    expect(row.policy).toBe("controlled"); // normalized lowercase
    expect(row.maxNegativeQty).toBe(7);
    expect(row.requireReason).toBe(true);
    expect(row.isEnabled).toBe(true);
    expect(row.version).toBe(3);
    expect(st.globalRow).toBeNull();
    expect(st.allowEnabled).toBe(false); // absent → false, never undefined
    expect(st.policyEnabled).toBe(false);
  });

  it("survives a garbage payload with safe empty defaults", () => {
    const st = toPolicySettings(null);
    expect(st.rows).toEqual([]);
    expect(st.globalRow).toBeNull();
    expect(st.warehouseRows).toEqual([]);
    expect(st.itemRows).toEqual([]);
  });

  it("maps the effective decision — null max means unlimited, levels normalized", () => {
    const eff = toEffectivePolicy({
      success: true,
      data: {
        effectivePolicy: "controlled",
        effectiveMaxNegative: "25",
        reason: "resolved",
        allowGated: true,
        trackingMode: "none",
        levels: { global: "block", warehouse: "ALLOW", item: null },
      },
    });
    expect(eff.effectivePolicy).toBe("controlled");
    expect(eff.effectiveMaxNegative).toBe(25);
    expect(eff.allowGated).toBe(true);
    expect(eff.levels.global).toBe("block");
    expect(eff.levels.warehouse).toBe("allow"); // case-normalized
    expect(eff.levels.item).toBeNull();

    const unlimited = toEffectivePolicy({ data: { effectivePolicy: "allow", effectiveMaxNegative: null, reason: "resolved", allowGated: false, trackingMode: "none", levels: {} } });
    expect(unlimited.effectiveMaxNegative).toBeNull();

    const tracked = toEffectivePolicy({ data: { effectivePolicy: "block", effectiveMaxNegative: 0, reason: "tracked-item", trackingMode: "lot", levels: {} } });
    expect(tracked.reason).toBe("tracked-item");
    expect(tracked.trackingMode).toBe("lot");
    expect(tracked.effectiveMaxNegative).toBe(0);
  });

  it("maps deficit rows, derives remainingValue and falls back on names/status", () => {
    const led = toDeficitLedger({
      success: true,
      data: [
        {
          id: "DEF-1", warehouseId: "WH1", warehouseName: "رئيسي", itemId: "IT1", itemName: "سكر",
          originDocType: "issue", originDocId: "ISS-9", deficitQty: "10", remainingQty: "4",
          unitCostAtIssue: "2.5", reason: "طلب عاجل", status: "partial", createdBy: "m",
          createdAt: "2026-07-01T10:00:00Z", closedAt: null,
        },
        {
          // snake_case + missing names + unknown status → id fallbacks + "open"
          id: "DEF-2", warehouse_id: "WH2", item_id: "IT2", origin_doc_type: "transfer",
          origin_doc_id: "TR-3", deficit_qty: 3, remaining_qty: 0, unit_cost_at_issue: 5,
          status: "weird", created_by: "x",
        },
      ],
      total: 2,
    });
    expect(led.total).toBe(2);
    expect(led.rows[0].remainingValue).toBeCloseTo(10); // 4 × 2.5
    expect(led.rows[0].status).toBe("partial");
    expect(led.rows[1].warehouseName).toBe("WH2"); // falls back to id
    expect(led.rows[1].itemName).toBe("IT2");
    expect(led.rows[1].status).toBe("open"); // unknown → open
    expect(led.rows[1].remainingValue).toBe(0);

    const noTotal = toDeficitLedger({ data: [{ id: "D" }] });
    expect(noTotal.total).toBe(1); // falls back to rows.length
  });

  it("maps the PUT save envelope", () => {
    const r = toPolicySaveResult({ success: true, data: { id: "NSP-abc", scope: "warehouse", warehouseId: "WH1", itemId: null }, status: "saved", version: 5 });
    expect(r.success).toBe(true);
    expect(r.id).toBe("NSP-abc");
    expect(r.status).toBe("saved");
    expect(r.version).toBe(5);

    const bad = toPolicySaveResult({ success: false });
    expect(bad.success).toBe(false);
    expect(bad.id).toBeNull();
    expect(bad.version).toBeNull();
  });

  it("normalizes enums defensively", () => {
    expect(toPolicyMode("ALLOW")).toBe("allow");
    expect(toPolicyMode("nonsense")).toBe("block"); // safest default
    expect(toDeficitStatus("COVERED")).toBe("covered");
    expect(toDeficitStatus(undefined)).toBe("open");
  });
});
