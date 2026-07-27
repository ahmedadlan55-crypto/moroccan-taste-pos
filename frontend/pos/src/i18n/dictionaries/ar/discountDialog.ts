export const discountDialog = {
  title: "خصم على الطلب",
  presets: {
    label: "خصومات جاهزة",
    minOrder: "الحد الأدنى للطلب {amount} ر.س",
  },
  type: {
    aria: "نوع الخصم",
    percent: "نسبة %",
    fixed: "مبلغ ر.س",
  },
  value: {
    percentLabel: "النسبة (0–100)",
    fixedLabel: "المبلغ (يُسقَف عند {amount})",
    keypadHint: "لوحة الأرقام تكتب قيمة الخصم",
  },
  name: {
    label: "اسم الخصم",
    placeholder: "عرض الافتتاح، موظف…",
  },
  summary: {
    discountValue: "قيمة الخصم",
    totalAfter: "الإجمالي بعد الخصم",
  },
  overCeiling: {
    before: "الخصم",
    between: "% يتجاوز حد الكاشير (",
    after: "%) — سيرفضه الخادم عند الدفع بدون مدير",
  },
  actions: {
    remove: "إزالة الخصم",
    apply: "تطبيق الخصم",
  },
} as const;
