export const heldOrdersDialog = {
  title: "الطلبات المعلقة",
  // count-dependent noun shown after the count span
  heldCount: (_n: number) => "طلب معلق",
  offlineSuffix: " (المحلية فقط — لا اتصال)",
  loading: "جارٍ التحميل…",
  refresh: "تحديث",
  empty: {
    title: "لا طلبات معلقة",
    hint: "علّق طلبًا من السلة ليظهر هنا",
  },
  row: {
    table: "طاولة",
    localBadge: "محلي — غير مزامن",
    // count-dependent noun shown after the item-count span
    itemCount: (_n: number) => "صنف",
    currency: "ر.س",
  },
  resume: {
    label: "استعادة",
    offlineTitle: "استعادة طلب من الخادم تتطلب اتصالًا",
    title: "استعادة إلى السلة",
  },
  void: {
    label: "إلغاء",
    offlineTitle: "إلغاء طلب مزامَن غير متاح بلا اتصال",
    title: "إلغاء الطلب",
    reasonPlaceholder: "سبب الإلغاء (إلزامي)",
    confirm: "تأكيد الإلغاء",
  },
  toast: {
    resumeBlocked: "علّق الطلب الحالي أو أفرغه قبل استعادة طلب آخر",
    resumed: "تمت استعادة الطلب إلى السلة",
    voided: "أُلغي الطلب المعلق",
  },
} as const;
