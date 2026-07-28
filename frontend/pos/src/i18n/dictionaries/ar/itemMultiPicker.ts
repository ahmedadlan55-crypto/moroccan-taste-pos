// Arabic dictionary — ItemMultiPicker (منتقي الأصناف المتعدد), the shared
// open-on-focus multi-select used by الجرد (StocktakeDialog) و النواقص
// (RequisitionsDialog). English twin: ../en/itemMultiPicker.ts — identical key
// set and identical leaf TYPES (all strings; no function leaves), enforced by
// i18n/__tests__/dictionary.test.ts.
export const itemMultiPicker = {
  search: {
    // The affordance lives in the placeholder on purpose: the owner's complaint
    // was that nothing appears until you type.
    placeholder: "اضغط هنا لعرض كل الأصناف… أو اكتب للبحث",
    ariaLabel: "اختيار الأصناف — اضغط لعرض القائمة كاملة",
  },

  list: {
    ariaLabel: "قائمة الأصناف",
    loading: "جارٍ تحميل الأصناف…",
    empty: "لا توجد أصناف",
    noResults: "لا نتائج مطابقة",
    // Two variables ⇒ MUST be a {placeholder} template, never a function leaf
    // (i18n/makeT.ts:52-72 calls a function leaf with a plain number).
    showingOf: "يُعرض {shown} من {total} — اكتب للتصفية",
  },

  chips: {
    ariaLabel: "الأصناف المحددة",
    removeAria: "إزالة {name}",
  },

  actions: {
    selectAllShown: "تحديد كل المعروض",
    clearAll: "إلغاء تحديد الكل",
  },

  selectedCount: "المحدد: {count}",
} as const;
