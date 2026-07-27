export const syncReportDialog = {
  title: "تقرير المزامنة",

  /** Two tabs inside the SAME overlay — no new entry in App's overlayOpen union. */
  tabs: {
    ariaLabel: "أقسام تقرير المزامنة",
    sync: "المزامنة",
    failures: "سجل الإخفاقات",
  },

  /** Durable failure log (lib/failureLog.ts) — survives reloads, unlike the
   *  engine's in-memory lastReport shown on the first tab. */
  failures: {
    heading: "عمليات فشلت نهائيًا",
    hint: "سجل محلي على هذا الجهاز يبقى بعد إعادة التشغيل — آخر {max} حالة",
    countLabel: "حالة مسجّلة",
    empty: {
      title: "لا إخفاقات مسجّلة",
      hint: "كل عملية أُرسلت للخادم إمّا نجحت أو ما زالت في قائمة الانتظار",
    },
    kind: {
      checkout: "بيع",
      sync: "مزامنة",
      "legacy-drain": "الكاشير القديم",
      other: "أخرى",
    },
    order: "طلب",
    reference: "مرجع",
    cashier: "الكاشير",
    currency: "ر.س",
    clear: "مسح السجل",
    clearTitle: "مسح كل الحالات المسجّلة",
    clearNotAllowed: "مسح السجل يتطلب صلاحية مشرف",
    clearConfirm: "تأكيد المسح",
    clearCancel: "تراجع",
  },

  status: {
    online: "متصل بالخادم",
    offline: "غير متصل",
    queueLabel: "عملية بانتظار المزامنة",
  },
  sync: {
    now: "مزامنة الآن",
  },
  queue: {
    heading: "قائمة الانتظار",
  },
  order: "طلب",
  lastSync: "آخر مزامنة",
  empty: {
    title: "لا مزامنة بعد",
    hint: "ستظهر النتائج هنا بعد أول دفعة",
  },
  result: {
    replayed: "مُعاد",
    succeeded: "نجحت",
    failed: "فشلت",
  },
  opLabels: {
    upsert: "حفظ طلب",
    hold: "تعليق",
    resume: "استعادة",
    reopen: "إعادة فتح",
    void: "إلغاء",
    complete: "إكمال",
    submitAndSale: "دفع + فاتورة",
  },
} as const;
