/** Baked-in default copy + aria labels for the shared UI kit
 *  (frontend/erp/src/shared/ui/*). One sub-object per component. Business DATA
 *  (user-entered names/values) is never here. English mirror: en/sharedUi.ts. */
export const sharedUi = {
  /** Default currency suffix for CurrencyInput (SAR). */
  currencySymbol: "ر.س",
  combobox: {
    placeholder: "اختر…",
    empty: "لا نتائج مطابقة.",
    clear: "مسح",
    searchPlaceholder: "ابحث…",
    searchLabel: "بحث",
  },
  entityCombobox: {
    placeholder: "ابحث بالاسم أو الرمز…",
    empty: "لا نتائج مطابقة.",
    clearSelected: "مسح المحدد",
    searchLabel: "بحث",
    loadError: "تعذّر تحميل النتائج.",
    searching: "جارٍ البحث…",
    typeToSearch: "اكتب للبحث…",
    loadingMore: "تحميل المزيد…",
  },
  entityMultiCombobox: {
    placeholder: "ابحث للإضافة… (اختيار متعدد)",
    empty: "لا نتائج مطابقة.",
    searchLabel: "بحث متعدد",
    loadError: "تعذّر تحميل النتائج.",
    searching: "جارٍ البحث…",
    typeToSearch: "اكتب للبحث…",
    loadingMore: "تحميل المزيد…",
    removeItem: "إزالة {label}",
    clearAll: "مسح الكل ({count})",
    addAllVisible: "إضافة كل النتائج الظاهرة ({count})",
    selectedCount: "المحدد: {count}",
  },
  geo: {
    countryPlaceholder: "ابحث عن دولة…",
    cityPlaceholder: "ابحث عن مدينة…",
    cityPlaceholderNoCountry: "اختر الدولة أولًا",
    countryEmpty: "لا دول مطابقة.",
    cityEmpty: "لا مدن مطابقة.",
    countryLabel: "اختيار الدولة",
    cityLabel: "اختيار المدينة",
  },
  fileUploader: {
    hint: "اسحب الملفات هنا أو اضغط للاختيار",
    tooLarge: "الملف أكبر من الحد المسموح.",
    empty: "لا مرفقات.",
    remove: "إزالة {name}",
  },
  fullPageFlow: {
    workspace: "مساحة عمل",
    back: "العودة",
    backAria: "العودة إلى الصفحة السابقة",
  },
  drawer: {
    eyebrow: "تفاصيل السجل",
  },
  unitQty: {
    qtyLabel: "الكمية",
    unitLabel: "الوحدة",
    countAria: "عدد {unit}",
    majorFallback: "الوحدة الكبرى",
    majorShort: "كبرى",
  },
  stepper: {
    progress: "الخطوة {current} من {total}: {label}",
  },
  timeline: {
    empty: "لا يوجد سجل بعد.",
  },
  pageHeader: {
    actions: "إجراءات الصفحة",
  },
  toast: {
    region: "التنبيهات",
    close: "إغلاق التنبيه",
  },
  errorBoundary: {
    title: "حدث خطأ غير متوقّع",
    body: "نأسف على الإزعاج، حدث خلل مؤقّت في الواجهة. جرّب إعادة المحاولة، وإن استمرّت المشكلة تواصل مع الدعم الفني.",
    retry: "إعادة المحاولة",
  },
} as const;
