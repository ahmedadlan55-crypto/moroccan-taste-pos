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
    title: "الاستلامات المستقلة",
    subtitle: "إدخال مخزون إلى مستودع بدورة اعتماد وترحيل قابلة للتدقيق (غير مرتبط بأمر شراء).",
    newLabel: "استلام جديد",
    numberPrefix: "RCV",
    icon: PackagePlus,
    lineMode: "receipt",
    perms: { create: "receipt.create", approve: "receipt.approve", post: "receipt.post", reverse: "receipt.reverse" },
  },
  issue: {
    docType: "issue",
    routeBase: "/inventory/issues",
    title: "أذونات الصرف المستقلة",
    subtitle: "صرف مخزون من مستودع إلى مصروف/قسم بسبب إلزامي وتحقق من الرصيد عند الترحيل.",
    newLabel: "إذن صرف جديد",
    numberPrefix: "ISU",
    icon: PackageMinus,
    lineMode: "issue",
    perms: { create: "issue.create", approve: "issue.approve", post: "issue.post", reverse: "issue.reverse" },
  },
  adjustment: {
    docType: "adjustment",
    routeBase: "/inventory/adjustments",
    title: "التعديلات المخزنية",
    subtitle: "تسوية الأرصدة بالجرد: تُدخل الكمية المجرودة ويحسب النظام الفرق (delta) بنفسه.",
    newLabel: "تعديل جديد",
    numberPrefix: "ADV",
    icon: SlidersHorizontal,
    lineMode: "adjustment",
    perms: { create: "adjustment.create", approve: "adjustment.approve", post: "adjustment.post", reverse: "adjustment.reverse" },
  },
};
