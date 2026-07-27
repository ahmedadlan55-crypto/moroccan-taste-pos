export const productGrid = {
  currency: "ر.س",
  badge: {
    combo: "عرض",
    custom: "مُخصَّص",
  },
  card: {
    inCartAria: "في السلة {name}: {qty}",
    decrementAria: "إنقاص {name}",
  },
  search: {
    placeholder: "بحث أو مسح باركود… (F2)",
    aria: "بحث في الأصناف أو مسح باركود",
    clearAria: "مسح البحث",
  },
  // لوحة النفاد — تحذير لا منع: الخادم هو المرجع، والبطاقة تبقى قابلة للضغط.
  stock: {
    out: "نفد",
    low: "منخفض",
    outTitle: "«{name}» غير متاح — نفدت إحدى المكوّنات",
    lowTitle: "المتاح للصنع: {count}",
    addedOutOfStock: "«{name}» يبدو غير متاح — تمت الإضافة، والخادم هو المرجع",
  },
  empty: {
    title: "لا نتائج",
    hintQuery: "جرّب كلمة أخرى أو امسح الباركود مرة أخرى",
    hintCategory: "لا توجد أصناف نشطة في هذا التصنيف",
    hintQuick: "لا مبيعات متكررة بعد — بِع أصنافًا وستظهر هنا تلقائيًا",
  },
} as const;
