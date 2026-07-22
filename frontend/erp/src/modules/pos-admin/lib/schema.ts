// Payment-method form schema (RHF + zod). Only the operator-editable fields are
// exposed; icon / color / GL-account / cost-center are preserved verbatim from the
// loaded record on edit (see toPaymentMethodInput) so no data is lost and no raw
// hex/icon literal ever appears in this source.
import { z } from "@/shared/schemas";
import type { TFunction } from "@/i18n";
import type { PaymentMethod, PaymentMethodInput } from "./types";

/** Build the payment-method form schema with localized messages. The field
 *  SHAPE is fixed regardless of language, so `PaymentMethodFormValues` stays a
 *  stable type; only the validation copy is resolved through t(). Consumers
 *  memoize this against the active t (see PaymentMethodDialog). */
export function makePaymentMethodSchema(t: TFunction) {
  return z.object({
    nameAr: z
      .string()
      .trim()
      .min(1, t("posAdmin.valid.nameArRequired"))
      .max(120, t("posAdmin.valid.nameTooLong")),
    name: z.string().trim().max(120, t("posAdmin.valid.nameTooLong")),
    groupType: z.enum(["cash", "electronic", "voucher", "loyalty", "transfer", "other"]),
    sortOrder: z
      .number({ invalid_type_error: t("posAdmin.valid.numberInvalid") })
      .min(0, t("posAdmin.valid.notNegative")),
    serviceFeeType: z.enum(["none", "percent", "fixed"]),
    serviceFeeValue: z
      .number({ invalid_type_error: t("posAdmin.valid.numberInvalid") })
      .min(0, t("posAdmin.valid.notNegative")),
    isActive: z.boolean(),
    showInShiftClose: z.boolean(),
    showInReports: z.boolean(),
    allowManualTotal: z.boolean(),
    requireReference: z.boolean(),
    requireTransactionNumber: z.boolean(),
    requireTerminal: z.boolean(),
    allowRefund: z.boolean(),
    allowCancel: z.boolean(),
    description: z.string().max(500, t("posAdmin.valid.descTooLong")),
  });
}

export type PaymentMethodFormValues = z.infer<ReturnType<typeof makePaymentMethodSchema>>;

const GROUPS = ["cash", "electronic", "voucher", "loyalty", "transfer", "other"] as const;
const FEE_TYPES = ["none", "percent", "fixed"] as const;

function asGroup(v: string | undefined): PaymentMethodFormValues["groupType"] {
  return (GROUPS as readonly string[]).includes(v ?? "")
    ? (v as PaymentMethodFormValues["groupType"])
    : "cash";
}
function asFeeType(v: string | undefined): PaymentMethodFormValues["serviceFeeType"] {
  return (FEE_TYPES as readonly string[]).includes(v ?? "")
    ? (v as PaymentMethodFormValues["serviceFeeType"])
    : "none";
}

/** Seed the form from an existing record (or blank defaults for a new method). */
export function toFormValues(pm?: PaymentMethod | null): PaymentMethodFormValues {
  return {
    nameAr: pm?.nameAr ?? "",
    name: pm?.name ?? "",
    groupType: asGroup(pm?.groupType),
    sortOrder: Number(pm?.sortOrder) || 0,
    serviceFeeType: asFeeType(pm?.serviceFeeType),
    serviceFeeValue: Number(pm?.serviceFeeValue) || 0,
    isActive: pm?.isActive ?? true,
    showInShiftClose: pm?.showInShiftClose ?? true,
    showInReports: pm?.showInReports ?? true,
    allowManualTotal: pm?.allowManualTotal ?? false,
    requireReference: pm?.requireReference ?? false,
    requireTransactionNumber: pm?.requireTransactionNumber ?? false,
    requireTerminal: pm?.requireTerminal ?? false,
    allowRefund: pm?.allowRefund ?? true,
    allowCancel: pm?.allowCancel ?? true,
    description: pm?.description ?? "",
  };
}

/** Map validated form values → the exact POST body the backend expects. */
export function toPaymentMethodInput(
  values: PaymentMethodFormValues,
  base?: PaymentMethod | null,
): PaymentMethodInput {
  const nameAr = values.nameAr.trim();
  const name = values.name.trim() || nameAr; // legacy: name falls back to nameAr
  return {
    id: base?.id ?? null,
    name,
    nameAr,
    groupType: values.groupType,
    sortOrder: values.sortOrder,
    serviceFeeType: values.serviceFeeType,
    serviceFeeValue: values.serviceFeeValue,
    serviceFeeRate: values.serviceFeeValue, // back-compat field the legacy sends
    isActive: values.isActive,
    showInShiftClose: values.showInShiftClose,
    showInReports: values.showInReports,
    allowManualTotal: values.allowManualTotal,
    requireReference: values.requireReference,
    requireTransactionNumber: values.requireTransactionNumber,
    requireTerminal: values.requireTerminal,
    allowRefund: values.allowRefund,
    allowCancel: values.allowCancel,
    description: values.description,
    // Preserved passthrough — kept from the record on edit, defaults on create.
    icon: base?.icon ?? "fa-money-bill",
    color: base?.color,
    glAccountId: base?.glAccountId ?? null,
    costCenterId: base?.costCenterId ?? null,
  };
}
