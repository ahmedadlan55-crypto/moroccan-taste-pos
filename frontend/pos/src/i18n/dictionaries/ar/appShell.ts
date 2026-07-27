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
    /** يظهر حين تُخدَم أسعار الأساسي بينما القناة مختارة — كان هذا العلم
     *  محسوبًا ولا يُعرض في أي مكان، فيبيع الكاشير بسعر لا يعرف مصدره. */
    pricesUnavailable: "أسعار القناة المختارة غير متاحة الآن — الأصناف تُحتسب بأسعار الأساسي",
    backToBase: "العودة إلى الأساسي",
  },

  priceList: {
    prefix: "أسعار من قائمة:",
  },

  mobileCart: {
    label: "السلة",
  },

  /** Suspense fallback while a lazily-loaded dialog's chunk arrives. */
  dialogLoading: "جارٍ فتح النافذة…",
  dialogLoadFailed: "تعذّر فتح النافذة — تحقق من الاتصال ثم أعد المحاولة. طلبك في السلة كما هو.",
  dialogRetry: "إعادة تحميل الصفحة",
  dialogClose: "إغلاق",

  /** Toast stack (components/Toasts.tsx) — the error-specific affordances. */
  toastStack: {
    region: "تنبيهات النظام",
    errorPersists: "يبقى حتى الإغلاق",
    showOlderErrors: "و {count} خطأ آخر — عرض",
    hideOlderErrors: "إخفاء الأخطاء الأقدم",
    dismissAllErrors: "إغلاق كل الأخطاء ({count})",
  },

  /** Fallback reasons written to the durable failure log (lib/failureLog.ts)
   *  when the engine hands us no message of its own. */
  failureLog: {
    checkoutFailed: "تعذّر إتمام البيع",
    legacyDrainFailed: "تعذّرت مزامنة عملية من الكاشير القديم",
  },

  toast: {
    legacySynced: "تمت مزامنة {count} عملية من النسخة القديمة",
    /** قناة محفوظة لم يعد الخادم يسردها — أُسقطت والعودة إلى الأساسي. تُقال
     *  بصوت عالٍ لأن قائمة الأسعار التي تُحتسب بها الفاتورة تغيّرت. */
    channelGone: "قناة البيع المحفوظة لم تعد متاحة — رجعت الأسعار إلى الأساسي",
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
