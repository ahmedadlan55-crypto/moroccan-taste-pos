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
    /** Cart is NOT empty: one tap holds what's in the cart, then resumes this
     *  row. The label states both halves so nothing happens by surprise. */
    holdAndResumeLabel: "علّق الحالي واستعد",
    holdAndResumeTitle: "يُعلَّق طلب السلة الحالي تلقائيًا، ثم يُستعاد هذا الطلب",
  },

  /** Banner above the list while the cart has lines. */
  cartBusyHint: "بالسلة طلب قيد التحضير — «علّق الحالي واستعد» يعلّقه تلقائيًا قبل استعادة أي طلب",
  void: {
    label: "إلغاء",
    offlineTitle: "إلغاء طلب مزامَن غير متاح بلا اتصال",
    title: "إلغاء الطلب",
    reasonPlaceholder: "سبب الإلغاء (إلزامي)",
    confirm: "تأكيد الإلغاء",
  },
  toast: {
    resumed: "تمت استعادة الطلب إلى السلة",
    heldCurrentThenResumed: "عُلّق طلب السلة، ثم استُعيد الطلب المختار",
    holdCurrentFailed: "تعذّر تعليق الطلب الحالي — لم تُنفَّذ الاستعادة",
    voided: "أُلغي الطلب المعلق",
  },
} as const;
