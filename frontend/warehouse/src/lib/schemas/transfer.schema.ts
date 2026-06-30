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
