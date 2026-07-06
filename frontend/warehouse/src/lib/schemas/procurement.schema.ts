// Procurement Zod schemas — client-side validation mirrors the server (which is
// authoritative for totals). Used with react-hook-form's zodResolver.
import { z } from "zod";

export const supplierSchema = z.object({
  name: z.string().min(2, "اسم المورد مطلوب"),
  nameEn: z.string().optional(),
  vatNumber: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email("بريد غير صالح").optional().or(z.literal("")),
  city: z.string().optional(),
  paymentTerms: z.enum(["Cash", "Net30", "Net60"]).default("Cash"),
});
export type SupplierInput = z.infer<typeof supplierSchema>;

export const poLineSchema = z.object({
  itemId: z.string().min(1, "اختر مادة"),
  itemName: z.string().default(""),
  enteredQty: z.coerce.number().positive("الكمية يجب أن تكون موجبة"),
  factor: z.coerce.number().positive().default(1),
  enteredUnitCode: z.string().default(""),
  unitPriceEntered: z.coerce.number().nonnegative("السعر لا يمكن أن يكون سالبًا"),
  vatRate: z.coerce.number().min(0).max(100).default(15),
});
export type PoLineInput = z.infer<typeof poLineSchema>;

export const poSchema = z.object({
  supplierId: z.string().min(1, "اختر موردًا"),
  warehouseId: z.string().optional(),
  orderDate: z.string().optional(),
  expectedDate: z.string().optional(),
  notes: z.string().optional(),
  lines: z.array(poLineSchema).min(1, "أضف سطرًا واحدًا على الأقل"),
});
export type PoInput = z.infer<typeof poSchema>;
