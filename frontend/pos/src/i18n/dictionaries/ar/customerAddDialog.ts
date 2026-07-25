export const customerAddDialog = {
  title: "إضافة عميل جديد",
  fields: {
    nameLabel: "الاسم *",
    namePlaceholder: "محمد أحمد",
    phoneLabel: "الهاتف *",
    phonePlaceholder: "05xxxxxxxx",
    vatLabel: "الرقم الضريبي (اختياري)",
    typeLabel: "نوع العميل",
    typeB2C: "أفراد · B2C",
    typeB2B: "شركات · B2B",
    typeB2G: "حكومي · B2G",
  },
  actions: {
    cancel: "إلغاء",
    saveLink: "حفظ وربط",
    recallExisting: "استدعاء العميل الموجود",
  },
  validation: {
    nameRequired: "اسم العميل مطلوب",
    phoneRequired: "رقم الهاتف مطلوب",
    phoneTooShort: "رقم الهاتف قصير جداً (5 أرقام على الأقل)",
  },
  errors: {
    saveFailed: "فشل حفظ العميل",
  },
} as const;
