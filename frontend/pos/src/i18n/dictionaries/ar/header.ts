/**
 * Arabic dictionary — Header (brand, cashier identity, shift chip, connection
 * status, quick-action buttons, and the collapsible «المزيد» panel).
 * English mirror: frontend/pos/src/i18n/dictionaries/en/header.ts
 */
export const header = {
  roles: {
    admin: "مدير النظام",
    manager: "مدير",
    cashier: "كاشير",
    custody: "أمين عهدة",
    employee: "موظف",
    accountant: "محاسب",
    finance: "مالية",
    sales: "مبيعات",
  },
  /** Used when the cashier has no role at all (never for an unrecognised
   *  role string, which is shown as-is — see Header.tsx roleLabel()). */
  roleFallback: "كاشير",
  /** Only shown when catalog.identity.brandName is empty/unresolved. */
  brandFallback: "المذاق المغربي",
  unknownUser: "مستخدم غير معروف",

  connection: {
    syncing: "جارٍ المزامنة",
    online: "متصل",
    offline: "غير متصل",
    queueTitle: "عمليات بانتظار المزامنة",
    reportTitle: "عرض تقرير المزامنة",
  },

  /**
   * Humanises a cache age for the cashier — "٣ ساعة", "يومان", never raw ms.
   * Receives whole HOURS; the ms→h division stays in the component
   * (Header.tsx msToHours()) since it is pure unit conversion, but the
   * day-bucketing branch (1 يوم / يومان / N أيام) stays HERE because it is
   * inseparable from the chosen string. Call via
   * t("header.staleAge", { count: hours }).
   */
  staleAge: (h: number): string => {
    if (h < 1) return "أقل من ساعة";
    if (h < 24) return `${h} ساعة`;
    const d = Math.floor(h / 24);
    return d === 1 ? "يوم" : d === 2 ? "يومان" : `${d} أيام`;
  },

  staleCatalog: {
    unknownAge: "غير معروف",
    titleOnline: "قائمة الأصناف غير مؤكَّدة — اضغط لإعادة التحميل",
    titleOffline: "قائمة الأصناف محفوظة محليًا ولم يتم تأكيدها — ستُحدَّث عند عودة الاتصال",
    /** Label prefix only — the "(age)" part renders as a separate node next
     *  to it, same pattern as the queue-count chips below. */
    label: "قائمة قديمة",
  },

  pwa: {
    drainTitle: "عمليات من الكاشير القديم بانتظار المزامنة",
    legacyLabel: "قديم",
    updateTitle: "توفرت نسخة جديدة من التطبيق",
    updateAction: "نسخة جديدة — تحديث",
    installTitle: "تثبيت الكاشير كتطبيق على هذا الجهاز",
    installAction: "تثبيت التطبيق",
  },

  shift: {
    loading: "الوردية…",
    detailsTitle: "تفاصيل الوردية / الإغلاق",
    chipLabel: "وردية",
    none: "لا وردية",
    openTitle: "فتح وردية جديدة",
    openTitleOffline: "فتح الوردية يتطلب اتصالًا بالخادم",
    openAction: "فتح وردية",
  },

  quickActions: {
    ariaLabel: "إجراءات الكاشير السريعة",
    myInvoices: "فواتيري",
    myInvoicesTitle: "فواتير الوردية الحالية",
    stocktake: "جرد المخزون",
    requisitions: "طلب النواقص",
    requisitionsTitle: "طلب النواقص والاستلام",
  },

  more: {
    label: "المزيد",
    systemStatusHeading: "حالة الجهاز والنظام",
    switchCashier: "تبديل الكاشير",
    switchCashierTitle: "تبديل الكاشير — يتطلب إغلاق الوردية المفتوحة أولًا",
    backToSystem: "العودة للنظام الرئيسي",
  },

  languageToggle: {
    ariaLabel: "تغيير لغة الواجهة",
    /** Language names are intentionally NOT translated between dictionaries —
     *  the label always names the language you'll switch TO, in its own
     *  script, so it stays recognisable regardless of current UI language. */
    switchToEnglish: "EN",
    switchToArabic: "عربي",
  },
} as const;
