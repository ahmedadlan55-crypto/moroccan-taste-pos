/**
 * Arabic dictionary — App shell (the single-screen POS scaffold in App.tsx:
 * category/products/cart landmarks, the sales-channel + price-list strip, the
 * mobile cart bar, background toasts, the legacy-drain report dialog, and the
 * post-hold kitchen-ticket dialog).
 * English mirror: frontend/pos/src/i18n/dictionaries/en/appShell.ts
 */
export const appShell = {
  currency: "ر.س",

  aria: {
    categories: "التصنيفات",
    products: "الأصناف",
    cart: "السلة",
    closeCart: "إغلاق السلة",
  },

  channel: {
    label: "قناة البيع",
    base: "الأساسي",
  },

  priceList: {
    prefix: "أسعار من قائمة:",
  },

  mobileCart: {
    label: "السلة",
  },

  toast: {
    legacySynced: "تمت مزامنة {count} عملية من النسخة القديمة",
    noMatch: "لا صنف يطابق «{query}»",
    held: "عُلّق الطلب — يمكنك استعادته من «الطلبات المعلقة»",
    voided: "أُلغي الطلب",
    closeShiftFirst: "أغلق الوردية الحالية لإتمام تبديل الكاشير",
    printBlocked: "المتصفح منع نافذة الطباعة",
  },

  voidAction: {
    syncedOfflineDisabled: "إلغاء طلب مزامَن غير متاح بلا اتصال",
  },

  drain: {
    title: "مزامنة النسخة القديمة",
    pending: "{count} عملية من الكاشير القديم بانتظار المزامنة — تتم المحاولة عند توفر الاتصال",
    noneQueued: "لا عمليات معلّقة من الكاشير القديم",
    syncedPrefix: "تمت مزامنة",
    syncedSuffix: "عملية من النسخة القديمة",
    notSyncedSuffix: " — {count} لم تُزامَن وبقيت محفوظة",
    rowSucceeded: "نجحت",
    invoiceRef: " — فاتورة {id}",
    unknownId: "؟",
  },

  kitchen: {
    title: "تم تعليق الطلب",
    prompt: "هل تريد طباعة تذكرة للمطبخ الآن؟",
    later: "لاحقًا",
    print: "طباعة للمطبخ",
  },
} as const;
