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
