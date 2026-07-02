// Phase 4B — Zod input schemas for lot create / edit / lifecycle + a lot line
// (used by the receipt wizard). Validation mirrors routes/inventory-lots.js +
// the lot ledger so the UI fails fast before the request.
import { z } from "zod";

export const createLotInput = z.object({
  itemId: z.string().trim().min(1, "الصنف مطلوب"),
  lotNumber: z.string().trim().min(1, "رقم الدفعة مطلوب").max(120),
  expiryDate: z.string().trim().optional().or(z.literal("")),
  manufactureDate: z.string().trim().optional().or(z.literal("")),
  unitCost: z.coerce.number().min(0).optional(),
  notes: z.string().trim().max(500).optional(),
});
export type CreateLotInput = z.infer<typeof createLotInput>;

export const updateLotInput = z.object({
  notes: z.string().trim().max(500).optional(),
  expiryDate: z.string().trim().optional(),
  manufactureDate: z.string().trim().optional(),
  reason: z.string().trim().max(200).optional(),
  expectedVersion: z.number().int().optional(),
});

export const lifecycleInput = z.object({
  reason: z.string().trim().min(1, "السبب مطلوب").max(200),
  expectedVersion: z.number().int().optional(),
});
export type LifecycleInput = z.infer<typeof lifecycleInput>;

// A per-line lot for the receipt wizard: lotNumber + qty (+ optional expiry).
export const lotLineInput = z.object({
  lotNumber: z.string().trim().min(1, "رقم الدفعة مطلوب"),
  qty: z.coerce.number().positive("الكمية يجب أن تكون موجبة"),
  expiryDate: z.string().trim().optional().or(z.literal("")),
  manufactureDate: z.string().trim().optional().or(z.literal("")),
});
export type LotLineInput = z.infer<typeof lotLineInput>;
