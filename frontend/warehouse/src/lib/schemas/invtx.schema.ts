import { z } from "zod";

// Phase 3B — independent inventory transactions (receipts / issues / adjustments).
// One unified lifecycle status set; per-type create/edit input schemas validated
// client-side before POST. The backend (routes/inventory-transactions.js) is the
// real authority — these mirror its rules to fail fast in the UI.

export const invTxStatus = z.enum(["draft", "approved", "posted", "cancelled", "reversed"]);
export type InvTxStatus = z.infer<typeof invTxStatus>;

export type InvTxDocType = "receipt" | "issue" | "adjustment";

// ── line inputs ─────────────────────────────────────────────────────────────
export const receiptLineInput = z.object({
  itemId: z.string().min(1, "اختر صنفًا"),
  qty: z.number().positive("الكمية يجب أن تكون أكبر من صفر"),
  unitCost: z.number().positive("التكلفة مطلوبة وموجبة"),
});
export const issueLineInput = z.object({
  itemId: z.string().min(1, "اختر صنفًا"),
  qty: z.number().positive("الكمية يجب أن تكون أكبر من صفر"),
});
export const adjustmentLineInput = z.object({
  itemId: z.string().min(1, "اختر صنفًا"),
  countedQty: z.number().min(0, "الكمية المجرودة لا يمكن أن تكون سالبة"),
});

// ── create inputs ───────────────────────────────────────────────────────────
export const createReceiptInput = z.object({
  warehouseId: z.string().min(1, "اختر المستودع"),
  receiptDate: z.string().optional(),
  sourceRef: z.string().max(200).optional(),
  notes: z.string().max(2000).optional(),
  items: z.array(receiptLineInput).min(1, "أضف صنفًا واحدًا على الأقل"),
});
export const createIssueInput = z.object({
  warehouseId: z.string().min(1, "اختر المستودع"),
  issueDate: z.string().optional(),
  reason: z.string().trim().min(2, "سبب الصرف إلزامي"),
  recipient: z.string().max(200).optional(),
  notes: z.string().max(2000).optional(),
  items: z.array(issueLineInput).min(1, "أضف صنفًا واحدًا على الأقل"),
});
export const createAdjustmentInput = z.object({
  warehouseId: z.string().min(1, "اختر المستودع"),
  adjustmentDate: z.string().optional(),
  reason: z.string().trim().min(2, "سبب التعديل إلزامي"),
  referenceEvidence: z.string().max(500).optional(),
  notes: z.string().max(2000).optional(),
  items: z.array(adjustmentLineInput).min(1, "أضف صنفًا واحدًا على الأقل"),
});

// update = create + mandatory expectedVersion (drives optimistic 409).
const withVersion = { expectedVersion: z.number().int() };
export const updateReceiptInput = createReceiptInput.extend(withVersion);
export const updateIssueInput = createIssueInput.extend(withVersion);
export const updateAdjustmentInput = createAdjustmentInput.extend(withVersion);

export const reasonInput = z.object({
  reason: z.string().trim().min(3, "اكتب السبب (٣ أحرف على الأقل)"),
  expectedVersion: z.number().int().optional(),
});

export type CreateReceiptInput = z.infer<typeof createReceiptInput>;
export type CreateIssueInput = z.infer<typeof createIssueInput>;
export type CreateAdjustmentInput = z.infer<typeof createAdjustmentInput>;
export type ReasonInput = z.infer<typeof reasonInput>;
