export const customerPicker = {
  currency: "ر.س",
  fallbackName: "عميل",
  available: "المتاح {amount}",
  selected: {
    historyAria: "سجل العميل",
    collectAria: "سند قبض",
    clearAria: "مسح العميل",
  },
  credit: {
    aria: "حد الائتمان",
    limit: "حد الائتمان",
    used: "المستخدم",
    available: "المتاح",
    loadError: "تعذّر قراءة حد الائتمان.",
  },
  search: {
    placeholder: "ابحث بالاسم أو الهاتف أو الرقم الضريبي…",
    loadError: "تعذّر تحميل العملاء.",
    retry: "إعادة المحاولة",
    loading: "جارٍ البحث…",
    empty: "لا عملاء مطابقون.",
    newCustomer: "عميل جديد",
  },
} as const;
