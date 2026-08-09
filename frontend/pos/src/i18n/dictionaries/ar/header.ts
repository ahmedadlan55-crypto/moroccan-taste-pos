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

  /** عمليات محجوزة لكاشير لم يعد مسجّل الدخول — راجع splitByActor() في
   *  lib/offline.ts. البادئة فقط؛ العدد يُعرض كعقدة مستقلة مثل بقية الشرائح. */
  orphanQueue: {
    unknownOwner: "عملية قديمة تحتاج مراجعة مدير",
    label: "كاشير آخر",
    title: "عمليات غير مُزامَنة تخص {who} — تُرسَل عند دخوله، أو يفرج عنها مدير",
    titleSales:
      "مبيعات مكتملة باسم {who} لم تصل الخادم بعد: {count}. تُرسَل عند دخوله أو بدخول مدير. لم يضع منها شيء.",
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
    /** Tooltip when the menu hides something that wants attention (نسخة جديدة /
     *  قائمة قديمة / عمليات قديمة عالقة). The BUTTON TEXT never changes — the
     *  accessible name «المزيد» is pinned by the responsive e2e spec. */
    attentionTitle: "المزيد — يوجد تنبيه بالداخل (تحديث أو قائمة قديمة أو عمليات معلّقة)",
    systemStatusHeading: "حالة الجهاز والنظام",
    switchCashier: "تبديل الكاشير",
    switchCashierTitle: "تبديل الكاشير — يتطلب إغلاق الوردية المفتوحة أولًا",
    backToSystem: "العودة للنظام الرئيسي",
    logout: "تسجيل الخروج",
    logoutTitle: "تسجيل الخروج من هذه الجلسة فقط — الوردية المفتوحة (إن وُجدت) تبقى مفتوحة كما هي عند تسجيل الدخول مرة أخرى",
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
