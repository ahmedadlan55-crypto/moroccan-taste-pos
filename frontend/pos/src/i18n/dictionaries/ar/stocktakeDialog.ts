// Arabic dictionary — StocktakeDialog (جرد المخزون), incl. buildCountSheetHtml's
// print-only "countSheet" namespace (imported directly by that function — NOT via
// useT(), since it is a plain string-building function, not a React component).
export const stocktakeDialog = {
  title: "جرد المخزون",
  doneTitle: "أُرسل الجرد للاعتماد",

  offline: {
    title: "الجرد يتطلب اتصالًا",
    hint: "أعد المحاولة عند عودة الاتصال بالخادم — مسودة المحضر محفوظة على هذا الجهاز",
  },

  search: {
    placeholder: "ابحث عن مادة خام لإضافتها للمحضر…",
    ariaLabel: "البحث عن مادة",
    resultsAriaLabel: "نتائج البحث",
    noResults: "لا نتائج مطابقة",
  },

  cart: {
    emptyTitle: "محضر الجرد فارغ",
    emptyHint: "ابحث عن مادة وأضفها ثم أدخل الكمية الفعلية المعدودة",
  },

  table: {
    item: "المادة",
    bigQty: "الكمية الكبيرة",
    bigUnit: "وحدة كبرى",
    smallQty: "الكمية الصغيرة",
    smallUnit: "وحدة صغرى",
    system: "النظام",
    variance: "الفرق",
    // delete column header reuses common.delete (exact match) — see footer.
    bigQtyAria: "الكمية الكبيرة — {name}",
    smallQtyAria: "الكمية الصغيرة — {name}",
    deleteAria: "حذف {name}",
  },

  notes: {
    placeholder: "ملاحظات الجرد (اختياري)",
    ariaLabel: "ملاحظات الجرد",
  },

  review: {
    summaryPrefix: "مراجعة المحضر قبل الإرسال —",
    countedSuffix: "مادة معدودة",
    ignoredHint: "سيتم تجاهل {count} مادة بلا كمية",
    blindNotice: "يُرسَل المحضر إلى مستودعك لاعتماد الإدارة — يُحتسب الفرق ويُراجَع بعد الإرسال (جرد أعمى).",
  },

  done: {
    submittedTitle: "أُرسل محضر الجرد للاعتماد",
    numberLabel: "رقم المحضر:",
    pendingNotice: "بانتظار مراجعة الإدارة واعتمادها — لا يلزمك أي إجراء إضافي.",
    printButton: "طباعة محضر العدّ / PDF",
  },

  footer: {
    clearCart: "مسح المحضر",
    clearCartTitle: "مسح كامل المحضر",
    autoSaveHint: "تُحفظ المسودة تلقائيًا",
    reviewAndSend: "مراجعة وإرسال",
    backToEdit: "رجوع للتعديل",
    sendForApproval: "إرسال للاعتماد",
    // close button reuses common.close (exact match, per i18n dedup rule).
  },

  toasts: {
    cartCleared: "تم مسح المحضر",
    addAtLeastOneItem: "أضف مادة واحدة على الأقل",
    enterQtyAtLeastOne: "أدخل الكمية الفعلية لمادة واحدة على الأقل",
    noWarehouse: "تعذّر تحديد مستودع الكاشير — لا يوجد مستودع افتراضي مرتبط بحسابك. راجع الإدارة قبل الجرد.",
    submittedForApproval: "أُرسل محضر الجرد للاعتماد",
  },

  errors: {
    noDocumentNumber: "لم يُرجِع الخادم رقم محضر الجرد",
    countsNotSaved: "تعذّر تسجيل الكميات المعدودة — لم يُجمَّد أي صنف لهذا المستودع",
    stockMovementConflict: "حدثت حركة مخزون أثناء العدّ — أعد المحاولة",
    printBlocked: "المتصفح منع نافذة الطباعة",
  },

  misc: {
    defaultNotesPrefix: "جرد بواسطة {username}",
  },

  // Used ONLY by buildCountSheetHtml (imported directly, not via useT()).
  countSheet: {
    docTitle: "محضر جرد",
    heading: "محضر جرد المخزون",
    numberLabel: "رقم المحضر:",
    cashierLabel: "الكاشير:",
    pendingApprovalBadge: "أُرسل للاعتماد — بانتظار مراجعة الإدارة",
    notesLabel: "ملاحظات:",
    printButton: "🖨 طباعة / PDF",
    colIndex: "#",
    colItem: "المادة",
    colUnit: "الوحدة",
    colCounted: "الكمية المعدودة",
    totalCountedLabel: "عدد المواد المعدودة:",
  },
} as const;
