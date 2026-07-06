// Arabic status labels shared across procurement detail screens.
export const STATUS_AR: Record<string, string> = {
  draft: "مسودة", submitted: "مُقدّم", approved: "معتمد", sent: "مُرسل",
  partially_received: "استلام جزئي", received: "مستلم", fully_received: "مستلم كليًا",
  posted: "مُرحّل", reversed: "معكوس", cancelled: "ملغى", closed: "مغلق",
  pending_review: "قيد المراجعة", pending_approval: "بانتظار الاعتماد",
  partially_paid: "مسدد جزئيًا", paid: "مسدد", overdue: "متأخر", settled: "مُسوّى",
  requested: "مطلوب", authorized: "مُخوّل",
  unmatched: "غير مطابقة", partial: "جزئية", matched: "مطابقة", overmatched: "زائدة",
  before_invoice: "قبل الفاتورة", after_invoice: "بعد الفاتورة",
};
export const st = (s: string | null | undefined): string => (s ? STATUS_AR[s] || s : "—");

export const ACTION_AR: Record<string, string> = {
  create: "إنشاء", submit: "تقديم", approve: "اعتماد", send: "إرسال", cancel: "إلغاء",
  close: "إغلاق", receive: "استلام", change_order: "أمر تغيير", post: "ترحيل",
  reverse: "عكس", match: "مطابقة", credit_note: "إشعار دائن", authorize: "تخويل",
  pay: "سداد", allocate: "تخصيص", settle: "تسوية",
};
export const act = (a: string): string => ACTION_AR[a] || a;
