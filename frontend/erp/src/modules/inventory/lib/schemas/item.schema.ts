import { z } from "zod";

// Phase 4A — item master + per-warehouse replenishment rules. Client mirrors of
// routes/inventory-items.js validation; the backend stays authoritative.

export const createItemInput = z.object({
  name: z.string().trim().min(1, "اسم الصنف مطلوب"),
  sku: z.string().trim().min(1, "الـ SKU مطلوب"),
  unit: z.string().trim().min(1, "الوحدة مطلوبة"),
  nameEn: z.string().max(200).optional(),
  category: z.string().max(100).optional(),
  cost: z.number().min(0, "التكلفة لا يمكن أن تكون سالبة").optional(),
  minStock: z.number().min(0).optional(),
  maxStock: z.number().min(0).optional(),
  bigUnit: z.string().max(50).optional(),
  convRate: z.number().positive().optional(),
  kind: z.enum(["raw", "semi"]).optional(),
  defaultWarehouseId: z.string().optional(),
  description: z.string().max(5000).optional(),
  notes: z.string().max(500).optional(),
});

// Update = a partial of create, + mandatory expectedVersion. SKU/unit edits are
// blocked server-side once the item has movements; the wizard warns before sending.
export const updateItemInput = createItemInput.partial().extend({ expectedVersion: z.number().int() });

export const warehouseRuleInput = z.object({
  minQty: z.number().min(0).optional(),
  reorderPoint: z.number().min(0, "نقطة إعادة الطلب لا يمكن أن تكون سالبة"),
  reorderQty: z.number().min(0),
  maxStock: z.number().min(0).optional(),
  safetyStock: z.number().min(0).optional(),
  leadTimeDays: z.number().min(0).optional(),
  isEnabled: z.boolean().optional(),
  expectedVersion: z.number().int().optional(),
})
  .refine((v) => !v.isEnabled || v.reorderQty > 0, { message: "كمية إعادة الطلب يجب أن تكون أكبر من صفر عند التفعيل", path: ["reorderQty"] })
  .refine((v) => !(v.maxStock && v.maxStock > 0) || v.maxStock >= v.reorderPoint, { message: "الحد الأقصى يجب أن يكون ≥ نقطة إعادة الطلب", path: ["maxStock"] })
  .refine((v) => v.reorderPoint >= (v.safetyStock ?? 0), { message: "نقطة إعادة الطلب يجب أن تكون ≥ مخزون الأمان", path: ["reorderPoint"] });

export type CreateItemInput = z.infer<typeof createItemInput>;
export type WarehouseRuleInput = z.infer<typeof warehouseRuleInput>;
