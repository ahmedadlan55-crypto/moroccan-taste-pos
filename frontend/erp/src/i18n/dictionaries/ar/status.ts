/** Record-status labels, keyed by a STABLE status CODE (the English/enum value),
 *  NOT by the Arabic text. The shared <StatusBadge> (frontend/erp/src/shared/ui/
 *  status-badge.tsx) renders t("status."+code); it bridges the legacy Arabic
 *  labels that ~200 module call-sites still pass as children to these codes via a
 *  reverse index derived from THIS file — so translating the map here localizes
 *  record-status display across the whole ERP at once. Every code also has a tone
 *  in status-badge.tsx (CODE_TONE); the two are kept in sync by the code key. */
export const status = {
  // healthy / done → success (emerald)
  available: "متوفر",
  good: "جيد",
  received: "مستلم",
  approved: "معتمد",
  paid: "مدفوع",
  posted: "مُرحّل",
  active: "نشط",
  safe: "آمن",
  // warning / pending → warning (amber)
  low: "منخفض",
  monitor: "مراقبة",
  pendingApproval: "بانتظار الاعتماد",
  underReview: "قيد المراجعة",
  matchRequired: "مطابقة مطلوبة",
  due: "مستحق",
  sent: "مُرسل",
  quarantined: "محجور",
  warning: "تحذير",
  // in-flight → info (sky) / purple (violet)
  inTransit: "في الطريق",
  transferring: "قيد النقل",
  counting: "قيد العد",
  inProgress: "قيد التنفيذ",
  partiallyReceived: "استلام جزئي",
  // danger / terminal → danger (rose)
  outOfStock: "نافد",
  negative: "سالب",
  critical: "حرج",
  reversed: "معكوس",
  recalled: "مُستدعى",
  expired: "منتهي",
  overdue: "متأخر",
  rejected: "مرفوض",
  // neutral / inactive → neutral (slate)
  cancelled: "ملغى",
  disabled: "معطّل",
  closed: "مغلق",
  noPermission: "بلا صلاحية",
  draft: "مسودة",
} as const;
