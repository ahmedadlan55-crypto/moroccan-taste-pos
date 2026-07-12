// Arabic status labels + tone for every O2C document status. Ported verbatim from
// the standalone O2C app. The `tone` is mapped onto the shared <StatusBadge>
// semantic tones in ./format.tsx (SalesStatus).

export type Tone = "slate" | "teal" | "amber" | "blue" | "green" | "rose" | "violet";

interface StatusMeta { label: string; tone: Tone }

const MAP: Record<string, StatusMeta> = {
  // shared
  draft: { label: "مسودة", tone: "slate" },
  cancelled: { label: "ملغى", tone: "rose" },
  reversed: { label: "معكوس", tone: "rose" },
  // ar_document
  issued: { label: "صادرة", tone: "blue" },
  partially_paid: { label: "مدفوعة جزئيًا", tone: "amber" },
  paid: { label: "مدفوعة", tone: "green" },
  credited: { label: "مُصدَّرة إشعارًا", tone: "violet" },
  closed: { label: "مغلقة", tone: "slate" },
  // sales_order
  confirmed: { label: "مؤكَّد", tone: "blue" },
  fulfilled: { label: "مُنفَّذ", tone: "teal" },
  invoiced: { label: "مُفوتَر", tone: "green" },
  // payment / return
  approved: { label: "معتمد", tone: "blue" },
  posted: { label: "مُرحّل", tone: "green" },
  // zatca
  pending: { label: "بانتظار زاتكا", tone: "amber" },
  submitted: { label: "مُرسَلة", tone: "blue" },
  accepted: { label: "مقبولة", tone: "green" },
  rejected: { label: "مرفوضة", tone: "rose" },
  not_required: { label: "غير مطلوبة", tone: "slate" },
};

export function statusMeta(status: string | null | undefined): StatusMeta {
  const key = String(status || "").toLowerCase();
  return MAP[key] || { label: status ? String(status) : "—", tone: "slate" };
}

export const VAT_CATEGORY_LABEL: Record<string, string> = {
  S: "خاضع 15%",
  Z: "صفري 0%",
  E: "معفى",
  O: "خارج النطاق",
};
