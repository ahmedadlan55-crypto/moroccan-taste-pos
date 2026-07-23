import { PackagePlus, PackageMinus, SlidersHorizontal, type LucideIcon } from "lucide-react";
import type { InvTxDocType } from "@/modules/inventory/lib/schemas/invtx.schema";
import type { WarehouseAction } from "@/modules/inventory/lib/permissions";

// Per-doc-type configuration that drives the GENERIC list / wizard / detail
// components. The differences that matter (line input mode, labels, permission
// actions) live here; the shared components read this config. Nothing here hides
// a per-type business rule — those live in the backend and the wizard's lineMode.
export interface InvTxConfig {
  docType: InvTxDocType;
  routeBase: string; // "/receipts"
  /** i18n key path (title/subtitle/newLabel) — the consuming components render t(config.<x>). */
  title: string;
  subtitle: string;
  newLabel: string;
  numberPrefix: string;
  icon: LucideIcon;
  lineMode: "receipt" | "issue" | "adjustment";
  perms: { create: WarehouseAction; approve: WarehouseAction; post: WarehouseAction; reverse: WarehouseAction };
}

export const INVTX_CONFIG: Record<InvTxDocType, InvTxConfig> = {
  receipt: {
    docType: "receipt",
    routeBase: "/inventory/receiving",
    title: "inventoryRest.invtx.receipt.title",
    subtitle: "inventoryRest.invtx.receipt.subtitle",
    newLabel: "inventoryRest.invtx.receipt.newLabel",
    numberPrefix: "RCV",
    icon: PackagePlus,
    lineMode: "receipt",
    perms: { create: "receipt.create", approve: "receipt.approve", post: "receipt.post", reverse: "receipt.reverse" },
  },
  issue: {
    docType: "issue",
    routeBase: "/inventory/issues",
    title: "inventoryRest.invtx.issue.title",
    subtitle: "inventoryRest.invtx.issue.subtitle",
    newLabel: "inventoryRest.invtx.issue.newLabel",
    numberPrefix: "ISU",
    icon: PackageMinus,
    lineMode: "issue",
    perms: { create: "issue.create", approve: "issue.approve", post: "issue.post", reverse: "issue.reverse" },
  },
  adjustment: {
    docType: "adjustment",
    routeBase: "/inventory/adjustments",
    title: "inventoryRest.invtx.adjustment.title",
    subtitle: "inventoryRest.invtx.adjustment.subtitle",
    newLabel: "inventoryRest.invtx.adjustment.newLabel",
    numberPrefix: "ADV",
    icon: SlidersHorizontal,
    lineMode: "adjustment",
    perms: { create: "adjustment.create", approve: "adjustment.approve", post: "adjustment.post", reverse: "adjustment.reverse" },
  },
};
