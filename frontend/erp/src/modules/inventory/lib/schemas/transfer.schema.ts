import { z } from "zod";

// Canonical Transfer (stock-issue) DTO the React app consumes — the camelCase,
// UI-facing shape. Mirrors the blueprint §7.1 JSON Schema and the Phase 0
// backend lifecycle (draft → approved → issued → partially_received →
// received → cancelled/reversed). Adapters validate raw backend rows against
// this so a contract drift fails loudly at the boundary, not deep in a screen.

export const transferStatus = z.enum([
  "draft",
  "submitted",
  "approved",
  "in_transit", // UI label for the backend 'issued'
  "partially_received",
  "received",
  "cancelled",
  "reversed",
]);
export type TransferStatus = z.infer<typeof transferStatus>;

export const warehouseRef = z.object({
  id: z.string().min(1),
  name: z.string(),
  code: z.string().optional(),
});

export const itemRef = z.object({
  id: z.string(),
  name: z.string(),
  unit: z.string(),
});

export const transferLine = z.object({
  id: z.string(),
  item: itemRef,
  qtyRequested: z.number().positive(),
  qtyIssued: z.number().min(0),
  qtyReceived: z.number().min(0),
  qtyRemaining: z.number().min(0),
  unitCost: z.number().min(0),
});

export const transfer = z.object({
  id: z.string().min(1),
  number: z.string().regex(/^ISS-/),
  status: transferStatus,
  fromWarehouse: warehouseRef,
  toWarehouse: warehouseRef,
  issuedAt: z.string().datetime().nullable().optional(),
  totalCost: z.number().min(0),
  lines: z.array(transferLine).min(1),
});

export type Transfer = z.infer<typeof transfer>;
export type TransferLine = z.infer<typeof transferLine>;

// ── Phase 3A — mutation INPUT schemas (validated client-side before POST) ────

export const createTransferLineInput = z.object({
  itemId: z.string().min(1, "اختر صنفًا"),
  qtyRequested: z.number().positive("الكمية يجب أن تكون أكبر من صفر"),
});

export const createTransferDraftInput = z
  .object({
    fromWarehouseId: z.string().min(1, "اختر المستودع المصدر"),
    toWarehouseId: z.string().min(1, "اختر المستودع الوجهة"),
    issueDate: z.string().optional(),
    notes: z.string().max(500).optional(),
    items: z.array(createTransferLineInput).min(1, "أضف صنفًا واحدًا على الأقل"),
  })
  .refine((v) => v.fromWarehouseId !== v.toWarehouseId, {
    message: "المصدر والوجهة يجب أن يكونا مختلفين",
    path: ["toWarehouseId"],
  });

// Phase 3A.1 — real in-place draft EDIT (PATCH). Same shape as create + a
// mandatory expectedVersion for optimistic concurrency. The backend keeps the
// same document number; the UI never delete+recreates.
export const updateTransferDraftInput = z
  .object({
    fromWarehouseId: z.string().min(1, "اختر المستودع المصدر"),
    toWarehouseId: z.string().min(1, "اختر المستودع الوجهة"),
    issueDate: z.string().optional(),
    notes: z.string().max(500).optional(),
    expectedVersion: z.number().int(),
    items: z.array(createTransferLineInput).min(1, "أضف صنفًا واحدًا على الأقل"),
  })
  .refine((v) => v.fromWarehouseId !== v.toWarehouseId, {
    message: "المصدر والوجهة يجب أن يكونا مختلفين",
    path: ["toWarehouseId"],
  });

export const receiveLineInput = z.object({
  id: z.string().min(1),
  qtyReceived: z.number().min(0),
});
export const receiveTransferInput = z.object({
  items: z.array(receiveLineInput).optional(), // omit → receive all remaining
  expectedVersion: z.number().int().optional(),
});

export const reverseTransferInput = z.object({
  reason: z.string().trim().min(3, "اكتب سبب الإرجاع (3 أحرف على الأقل)"),
  expectedVersion: z.number().int().optional(),
});

export const cancelTransferInput = z.object({
  reason: z.string().trim().min(3, "اكتب سبب الإلغاء (3 أحرف على الأقل)"),
  expectedVersion: z.number().int().optional(),
});

export type CreateTransferDraftInput = z.infer<typeof createTransferDraftInput>;
export type UpdateTransferDraftInput = z.infer<typeof updateTransferDraftInput>;
export type ReceiveTransferInput = z.infer<typeof receiveTransferInput>;
export type ReverseTransferInput = z.infer<typeof reverseTransferInput>;
export type CancelTransferInput = z.infer<typeof cancelTransferInput>;
