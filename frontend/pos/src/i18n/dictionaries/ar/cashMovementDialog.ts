// Arabic strings for CashMovementDialog.tsx — حركات نقدية على الدرج.
// English mirror: i18n/dictionaries/en/cashMovementDialog.ts. Keep both in sync
// (enforced by i18n/__tests__/dictionary.test.ts).
export const cashMovementDialog = {
  dialogTitle: "حركة نقدية على الدرج",
  currency: "ر.س",

  kind: {
    label: "نوع الحركة",
    payIn: "إيداع في الدرج",
    payOut: "سحب من الدرج",
    payInHint: "نقد يدخل الدرج — تعزيز عهدة أو استرداد",
    payOutHint: "نقد يخرج من الدرج — إيداع في الخزنة أو مصروف نثري",
  },

  form: {
    amountLabel: "المبلغ",
    reasonLabel: "السبب",
    reasonPlaceholder: "اكتب سبب الحركة",
    reasonRequired: "السبب مطلوب",
    noteLabel: "ملاحظة (اختياري)",
    submitButton: "متابعة للاعتماد",
    amountRequired: "أدخل مبلغًا أكبر من صفر",
  },

  presets: {
    heading: "أسباب شائعة",
    floatTopUp: "تعزيز عهدة الدرج",
    safeDrop: "إيداع في الخزنة",
    pettyCash: "مصروف نثري",
    supplierCod: "دفع لمورد نقدًا",
    changeFund: "توفير فكة",
    other: "أخرى",
  },

  approval: {
    heading: "اعتماد المدير",
    summaryPrefix: "سيتم تسجيل",
    back: "رجوع",
    confirmButton: "تسجيل واعتماد",
  },

  list: {
    heading: "حركات هذه الوردية",
    empty: "لا توجد حركات نقدية مسجّلة على هذه الوردية",
    approvedByPrefix: "اعتمدها",
    payInTotal: "إجمالي الإيداعات",
    payOutTotal: "إجمالي السحوبات",
    netTotal: "الصافي (يُضاف للنقد المتوقع)",
    loadFailed: "تعذّر تحميل حركات الوردية",
  },

  successToast: "تم تسجيل الحركة النقدية",
  offlineNote: "تسجيل حركة نقدية يتطلب اتصالاً بالخادم",
  closeButton: "إغلاق",
} as const;
