export const customerHistoryDialog = {
  title: "سجل العميل",
  titleWithName: "سجل العميل — {name}",
  loadError: "فشل تحميل السجل",
  currency: "ر.س",

  // KPI strip
  kpi: {
    totalSpentLabel: "إجمالي المشتريات",
    orderCountLabel: "عدد الفواتير",
    orderCountUnit: "فاتورة",
    avgInvoiceLabel: "متوسط الفاتورة",
    lastVisitLabel: "آخر زيارة",
  },

  // Meta line
  meta: {
    firstVisitLabel: "أول زيارة:",
  },

  // سند قبض — collection on account (draft only)
  collect: {
    open: "سند قبض",
    title: "سند قبض من العميل",
    amountLabel: "المبلغ (ر.س)",
    destinationLabel: "جهة التحصيل",
    destinationCash: "نقدًا",
    destinationBank: "بنك",
    referenceLabel: "المرجع",
    referencePlaceholder: "رقم الإيصال أو التحويل",
    notesLabel: "ملاحظات",
    submit: "تسجيل السند",
    cancel: "إلغاء",
    another: "سند آخر",
    doneTitle: "تم تسجيل السند كمسودة",
    documentNumberLabel: "رقم السند:",
    draftNote: "مسودة بانتظار اعتماد وترحيل المدير — لم تتحرك أي أرصدة بعد.",
    unavailable: "تسجيل السندات غير متاح من هذه الشاشة.",
    failed: "تعذّر تسجيل السند",
  },

  // Empty state
  empty: {
    title: "لا توجد فواتير سابقة لهذا العميل",
    hint: "أكمل بيعاً الآن لتسجيل أول فاتورة.",
  },

  // Recent purchases table headers
  table: {
    date: "التاريخ",
    invoiceNumber: "رقم الفاتورة",
    total: "الإجمالي",
    payment: "الدفع",
    status: "الحالة",
  },

  // Invoice status badges (invoiceBadge → labelKey)
  badge: {
    cancelled: "ملغاة",
    returned: "مرتجع",
    adjusted: "تعديل",
    partiallyReturned: "مرتجع جزئياً",
    completed: "مكتملة",
  },
} as const;
