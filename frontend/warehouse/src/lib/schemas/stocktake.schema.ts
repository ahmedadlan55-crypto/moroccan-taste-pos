import { z } from "zod";

// Phase 3C — professional stocktake. Client-side mirrors of the backend rules
// (routes/inventory-stocktakes.js) to fail fast in the UI; the backend stays the
// authority.

export const stocktakeStatus = z.enum(["draft", "counting", "submitted", "approved", "posted", "cancelled"]);
export type StocktakeStatus = z.infer<typeof stocktakeStatus>;
export const stocktakeScopeType = z.enum(["full", "category", "items"]);
export type StocktakeScopeType = z.infer<typeof stocktakeScopeType>;

export const createStocktakeInput = z
  .object({
    warehouseId: z.string().min(1, "اختر المستودع"),
    stocktakeDate: z.string().optional(),
    scopeType: stocktakeScopeType.default("full"),
    categoryId: z.string().optional(),
    itemIds: z.array(z.string()).optional(),
    includeZero: z.boolean().optional(),
    blindCount: z.boolean().optional(),
    countMethod: z.enum(["full", "cycle", "spot"]).optional(),
    reason: z.string().trim().min(2, "سبب الجرد إلزامي"),
    referenceEvidence: z.string().max(500).optional(),
    varianceQtyThreshold: z.number().optional(),
    varianceValueThreshold: z.number().optional(),
    evidenceThreshold: z.number().optional(),
    notes: z.string().max(2000).optional(),
  })
  .refine((v) => v.scopeType !== "category" || !!(v.categoryId && v.categoryId.trim()), { message: "الفئة مطلوبة لجرد حسب الفئة", path: ["categoryId"] })
  .refine((v) => v.scopeType !== "items" || (Array.isArray(v.itemIds) && v.itemIds.length > 0), { message: "حدّد صنفًا واحدًا على الأقل", path: ["itemIds"] });

export const updateStocktakeInput = z.object({
  reason: z.string().trim().min(2).optional(),
  referenceEvidence: z.string().max(500).optional(),
  includeZero: z.boolean().optional(),
  blindCount: z.boolean().optional(),
  notes: z.string().max(2000).optional(),
  expectedVersion: z.number().int(),
});

// One count cell. countedQty null = uncounted (excluded at post, never zeroed).
export const countInput = z.object({
  itemId: z.string().optional(),
  lineId: z.string().optional(),
  countedQty: z.number().min(0, "الكمية المجرودة لا يمكن أن تكون سالبة").nullable(),
  notes: z.string().max(400).optional(),
  reasonCode: z.string().max(40).optional(),
});
export const countsInput = z.object({ counts: z.array(countInput).min(1) });

export const recountInput = z.object({
  reason: z.string().trim().min(3, "اكتب سبب إعادة العد (٣ أحرف على الأقل)"),
  expectedVersion: z.number().int().optional(),
});

export type CreateStocktakeInput = z.infer<typeof createStocktakeInput>;
export type CountInput = z.infer<typeof countInput>;
