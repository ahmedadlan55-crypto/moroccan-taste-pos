export const returnRequestDialog = {
  dialog: {
    titleForm: "طلب مرتجع · Sales Return",
    titleDone: "تم إنشاء طلب المرتجع",
  },
  done: {
    status: {
      draft: "تم إنشاء طلب المرتجع — بانتظار اعتماد المدير",
      approved: "تم إنشاء المرتجع واعتماده — بانتظار الترحيل",
      posted: "تم إنشاء المرتجع وترحيله",
      fallback: "تم إنشاء طلب المرتجع (الحالة: {status})",
      unknownStatus: "غير معروفة",
    },
    documentNumberLabel: "رقم المرتجع:",
    statusLabel: "الحالة:",
    noPayoutNote: "— لا تُصرف قيمة حتى يعتمد المدير المرتجع ويُرحّله.",
  },
  errors: {
    overReturn: "الكمية المطلوبة تتجاوز المتاح للإرجاع",
    sodViolation: "لا يمكن اعتماد مرتجع أنشأته بنفسك.",
    createFailed: "تعذّر إنشاء طلب المرتجع",
    loadInvoiceFailed: "تعذّر تحميل بيانات الفاتورة",
  },
  invoice: {
    originalLabel: "الفاتورة الأصلية:",
  },
  empty: {
    noReturnable: "لا توجد أصناف قابلة للإرجاع في هذه الفاتورة",
  },
  table: {
    item: "الصنف",
    sold: "المُباع",
    price: "السعر",
    returnQty: "كمية الإرجاع",
  },
  line: {
    qtyAriaLabel: "كمية إرجاع {name}",
    overSold: "الكمية تتجاوز المُباع",
  },
  reason: {
    label: "سبب الإرجاع",
    ariaLabel: "سبب الإرجاع",
    placeholder: "مثال: صنف غير مطابق، طلب العميل الإلغاء…",
    requiredToast: "سبب الإرجاع مطلوب",
  },
  proportionalNote:
    "تُحتسب القيم (السعر/الضريبة/التكلفة) تناسبيًا في الخادم من الفاتورة الأصلية، ويعتمد المدير المرتجع قبل صرف أي قيمة.",
  actions: {
    close: "إغلاق",
    cancel: "إلغاء",
    submit: "إنشاء طلب المرتجع",
  },
} as const;
