import { describe, expect, it } from "vitest";
import {
  toProductionPage, toProductionDetail, toBomOptions, toAvailability, toMutationResult,
} from "../production.adapter";

describe("production.adapter", () => {
  it("maps a list page with KPIs and derives partial completion", () => {
    const page = toProductionPage({
      data: [{
        id: "POV2-1", order_number: "PRD-20260703-0001", product_id: "FG1", product_name: "منتج",
        status: "in_progress", source: "v2", version: 4, qty_planned: "50", qty_produced: "20",
        qty_waste: "2", wip_balance: "68.4", unit_cost: "2.28", warehouse_id: "WA",
        warehouse_name: "رئيسي", output_warehouse_id: "WB", output_warehouse_name: "إخراج",
        partially_completed: 1,
      }],
      kpis: { draft: 1, approved: 0, inProgress: 1, partiallyCompleted: 1, completed: 2, closed: 1, cancelled: 0, reversed: 2, legacyActive: 3, wipValue: "68.4", producedValue: "102.6" },
      pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
    });
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0].number).toBe("PRD-20260703-0001");
    expect(page.rows[0].qtyProduced).toBe(20);
    expect(page.rows[0].partiallyCompleted).toBe(true);
    expect(page.rows[0].source).toBe("v2");
    expect(page.kpis.wipValue).toBeCloseTo(68.4);
    expect(page.kpis.legacyActive).toBe(3);
  });

  it("maps detail: plan remaining, issue events with lines, outputs, journals", () => {
    const d = toProductionDetail({
      data: {
        id: "POV2-1", order_number: "PRD-1", product_id: "FG1", status: "in_progress", source: "v2",
        version: 5, qty_planned: 50, qty_produced: 20, qty_waste: 0, wip_balance: 68.4,
        materials_cost: 94, labor_cost: 20, overhead_cost: 0, total_cost: 114,
        allowed_scrap_pct: "10", warehouse_id: "WA", product_tracking_mode: "lot",
      },
      plan: [{ item_id: "R1", item_name: "خام", item_unit: "كجم", tracking_mode: "none", qty_planned: 10, qty_actual: 6, remaining: 4, unit_cost: 4, total_cost: 24, available: 94 }],
      issueEvents: [{ id: "PIE-1", event_no: 1, materials_cost: 42, labor_cost: 20, overhead_cost: 0, gl_journal_id: "J1", issued_by: "a", issued_at: "2026-07-03", lines: [{ id: "PIL-1", item_id: "R1", item_name: "خام", qty: 6, unit_cost: 4, line_total: 24 }] }],
      outputs: [{ id: "POE-1", qty: 20, unit_cost: 2.28, total_cost: 45.6, qty_waste: 0, waste_cost: 0, batch_number: "B1", gl_journal_id: "J2", created_by: "a" }],
      journals: [{ id: "J1", journal_number: "JV-1", total_debit: 62, total_credit: 62, reference_type: "prod_issue", entries: [{ account_code: "1220", account_name: "WIP", debit: 62, credit: 0 }] }],
      timeline: [], movements: [], lotMovements: [], genealogy: [],
    });
    expect(d.order.productTrackingMode).toBe("lot");
    expect(d.order.allowedScrapPct).toBe(10);
    expect(d.plan[0].remaining).toBe(4);
    expect(d.issueEvents[0].lines[0].lineTotal).toBe(24);
    expect(d.outputs[0].batchNumber).toBe("B1");
    expect(d.journals[0].entries[0].accountCode).toBe("1220");
  });

  it("maps BOM options and availability preview", () => {
    const boms = toBomOptions({ data: [{ id: "B1", product_id: "FG1", product_name: "منتج", yield_quantity: "10", yield_unit: "PCS", tracking_mode: "lot", line_count: 2 }] });
    expect(boms[0].yieldQuantity).toBe(10);
    expect(boms[0].trackingMode).toBe("lot");
    const av = toAvailability({
      items: [{ itemId: "R1", itemName: "خام", itemUnit: "كجم", trackingMode: "expiry", required: 10, available: 8, delta: -2, unitCost: 4, lineCost: 40, fefoAvailable: 7, status: "short" }],
      summary: { shortageCount: 1, allAvailable: false, itemCount: 1, reservedValue: 40, batches: 5 },
    });
    expect(av.items[0].status).toBe("short");
    expect(av.items[0].fefoAvailable).toBe(7);
    expect(av.summary.batches).toBe(5);
  });

  it("maps a mutation envelope", () => {
    const r = toMutationResult({ success: true, data: { id: "POV2-1", eventId: "PIE-9", unitCost: 2.28 }, documentNumber: "PRD-1", status: "in_progress", version: 5, journalId: "J9" });
    expect(r.id).toBe("POV2-1");
    expect(r.eventId).toBe("PIE-9");
    expect(r.version).toBe(5);
    expect(r.journalId).toBe("J9");
  });
});
