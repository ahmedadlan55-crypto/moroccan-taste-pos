export const myInvoicesDialog = {
  title: "فواتيري",

  // View switch (O2C on only) — invoices vs the returns this till raised
  views: {
    aria: "العرض",
    invoices: "الفواتير",
    returns: "مرتجعاتي",
  },
  returns: {
    tableStatus: "الحالة",
    tableNumber: "رقم المرتجع",
    tableOriginal: "الفاتورة الأصلية",
    tableTotal: "الإجمالي",
    emptyTitle: "لم ترفع أي طلب مرتجع بعد",
    emptyHint: "المرتجعات التي ترفعها من «فواتيري» ستظهر هنا مع حالتها.",
    unavailableTitle: "متابعة المرتجعات غير متاحة من هذه الشاشة",
    unavailableHint: "وحدة «المبيعات والعملاء» غير مفعّلة أو خارج صلاحيات بوابة الكاشير.",
    loadError: "تعذّر تحميل حالات المرتجعات",
    notInWindowHint: "المرتجع أقدم من نافذة القائمة الحالية",
    status: {
      draft: "بانتظار اعتماد المدير",
      approved: "معتمد — بانتظار الترحيل",
      posted: "مُرحَّل",
      reversed: "معكوس",
      cancelled: "ملغى",
      unknown: "غير معروفة",
    },
  },

  // Stat strip
  statTotal: "الإجمالي",
  statActive: "سارية",
  statCancelled: "ملغاة",
  statReturned: "مرتجع",
  statAmount: "ر.س",
  refresh: "تحديث",

  // Search + filter chips
  searchPlaceholder: "بحث برقم الفاتورة أو العميل أو الصنف…",
  filterAll: "الكل",
  filterActive: "سارية",
  filterCancelled: "ملغاة",
  filterReturned: "مرتجع",

  // Body states
  offlineBanner: "عرض الفواتير يتطلب اتصالًا بالخادم — الفواتير السابقة غير محفوظة على الجهاز.",
  noShiftTitle: "لا توجد وردية مفتوحة",
  noShiftHint: "افتح وردية لعرض فواتيرها.",
  emptyTitleNoRows: "لا توجد فواتير في هذه الوردية بعد",
  emptyTitleNoMatch: "لا نتائج مطابقة",
  emptyHintNoRows: "ستظهر الفواتير هنا فور إتمام أول عملية بيع.",
  emptyHintNoMatch: "جرّب بحثًا أو تصفية مختلفة.",

  // Table headers
  tableStatus: "الحالة",
  tableTime: "الوقت",
  tableInvoiceNumber: "رقم الفاتورة",
  tableProducts: "المنتجات",
  tableTotal: "الإجمالي",
  tablePayment: "الدفع",
  tableActions: "إجراءات",

  // Status badge (StatusBadge component)
  badgeCancelled: "ملغاة",
  badgeReturned: "مرتجع",
  badgeActive: "سارية",

  // Row actions
  printButton: "طباعة",
  printTooltip: "إعادة طباعة الفاتورة (برمز ZATCA المختوم)",
  voidButton: "إلغاء",
  returnButton: "مرتجع",
  reversedNoActions: "تم — لا إجراءات",

  // Manager approval dialog wiring
  voidApprovalTitle: "اعتماد إلغاء فاتورة",
  returnApprovalTitle: "اعتماد مرتجع",
  returnReasonLabel: "سبب الإرجاع",
  returnDefaultReason: "مرتجع عميل",

  // Toasts
  voidSuccessToast: "أُلغيت الفاتورة",
  returnSuccessToast: "سُجّل المرتجع (إشعار دائن)",
  // ORDER_TO_CASH_ENABLE=1 makes middleware/o2cLegacyGate reject the legacy
  // reverse path with 409 — say so plainly rather than showing the raw gate
  // message, which redirects to /sales, a SPA that no longer exists. Kept as
  // its own key (not errors.O2C_MODULE_ACTIVE, which is the generic
  // cross-dialog fallback) because this context has a more specific story.
  o2cModuleActiveToast: "الإلغاء والمرتجع منقولان إلى وحدة «المبيعات والعملاء» — غير متاحين من الكاشير حاليًا.",
  popupBlocked: "المتصفح منع نافذة الطباعة — اسمح بالنوافذ المنبثقة",
  reprintLoadFailed: "تعذّر تحميل بيانات الفاتورة للطباعة",
  reprintFailed: "تعذّرت طباعة الفاتورة",

  // Reprint reversal stamps (reprintHtmlFromInvoice) — kept bilingual to match
  // the legacy printed-receipt convention (ZATCA-facing document).
  stampVoided: "ملغاة · VOIDED",
  stampReturned: "مرتجع · RETURNED",
} as const;
