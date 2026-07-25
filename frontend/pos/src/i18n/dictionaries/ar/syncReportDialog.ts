export const syncReportDialog = {
  title: "تقرير المزامنة",
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
