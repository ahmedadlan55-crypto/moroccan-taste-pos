/**
 * Unified inventory OPERATIONS centre (مركز عمليات المخزون).
 *
 * NAMING CONTRACT — the two inbound documents are DIFFERENT and must never be
 * collapsed into one word:
 *   receipt          → «وارد مخزني»    — إدخال مخزون بدون مورد/أمر شراء
 *   purchase_receipt → «استلام مشتريات» — استلام بضاعة من مورد مقابل أمر شراء
 * The English mirror (dictionaries/en/operations.ts) keeps the same distinction
 * ("Stock inbound" vs "Purchase receipt") — the key sets are identical and the
 * parity test (i18n/__tests__/dictionary.test.ts) enforces it.
 *
 * `type.*` and `status.*` are keyed by the SERVER's raw vocabulary
 * (lib/inventoryOperations.js SOURCES / CANONICAL_STATUSES) so a value the
 * backend adds later falls back to the server-supplied label instead of
 * rendering a dotted key.
 */
export const operations = {
  eyebrow: "المخزون",
  title: "مركز عمليات المخزون",
  subtitle: "كل مستندات المخزون — الوارد والمشتريات والتحويلات والإنتاج والصرف والتسويات — في قائمة واحدة.",

  hub: {
    searchPlaceholder: "ابحث برقم المستند…",
    resultCount: "{count} مستند",
    tab: {
      all: "الكل",
      inbound: "وارد مخزني (غير مشتريات)",
      purchases: "استلام مشتريات",
      transfers: "تحويلات مخزنية",
      production: "أوامر الإنتاج",
      issues: "صرف وتسويات",
    },
    filter: {
      type: "نوع المستند",
      allTypes: "كل الأنواع",
      status: "الحالة",
      allStatuses: "كل الحالات",
      warehouse: "المستودع",
      allWarehouses: "كل المستودعات",
      dateFrom: "من تاريخ",
      dateTo: "إلى تاريخ",
    },
    col: {
      number: "رقم المستند",
      type: "النوع",
      date: "التاريخ",
      status: "الحالة",
      source: "المصدر",
      destination: "الوجهة",
      party: "المورد / الأصناف",
      lines: "عدد السطور",
      quantity: "إجمالي الكمية",
      value: "القيمة",
      currency: "العملة",
      createdBy: "أنشأه",
      approvedBy: "اعتمده",
    },
    empty: {
      title: "لا توجد مستندات",
      body: "لم يُسجَّل أي مستند مخزني بعد.",
      filtered: "لا يوجد مستند يطابق التصفية الحالية — جرّب توسيعها.",
    },
    notice: {
      denied: "أنواع مستندات مخفية لعدم توفر الصلاحية: {types}",
      unavailable: "أنواع مستندات غير مفعّلة في هذا النظام: {types}",
    },
  },

  detail: {
    back: "العودة إلى مركز العمليات",
    eyebrow: "مستند مخزني",
    fallbackTitle: "مستند",
    print: "طباعة",
    notFoundTitle: "مسار مستند غير صالح",
    notFoundBody: "الرابط لا يحتوي على نوع المستند ورقمه معًا.",
    signedValueNote: "قيمة هذا المستند مُوجَّهة بإشارة: السالب يعني انخفاض قيمة المخزون.",
    field: {
      number: "رقم المستند",
      type: "النوع",
      date: "التاريخ",
      status: "الحالة",
      rawStatus: "الحالة في المصدر",
      source: "المصدر",
      destination: "الوجهة",
      party: "الطرف",
      product: "الأصناف",
      lines: "عدد السطور",
      quantity: "إجمالي الكمية",
      netValue: "القيمة قبل الضريبة",
      vat: "ضريبة القيمة المضافة",
      grossValue: "الإجمالي شامل الضريبة",
      currency: "العملة",
      createdBy: "أنشأه",
      approvedBy: "اعتمده",
      createdAt: "تاريخ الإنشاء",
    },
    section: {
      summary: "بيانات المستند",
      lines: "سطور المستند",
      movements: "حركات المخزون الناتجة",
      lots: "الدفعات المتأثرة",
      journals: "القيود المحاسبية",
      attachments: "المرفقات",
      timeline: "سجل الإجراءات",
    },
    lines: {
      item: "الصنف",
      unit: "الوحدة",
      qty: "الكمية",
      unitCost: "تكلفة الوحدة",
      total: "إجمالي السطر",
      empty: "لا توجد سطور لهذا المستند.",
    },
    movements: {
      at: "التاريخ",
      item: "الصنف",
      type: "النوع",
      qty: "الكمية",
      warehouse: "المستودع",
      reference: "المرجع",
      actor: "المستخدم",
      in: "إدخال",
      out: "إخراج",
      empty: "لم يُنتج هذا المستند أي حركة مخزون (لم يُرحَّل بعد).",
    },
    lots: {
      lot: "رقم الدفعة",
      expiry: "تاريخ الانتهاء",
      item: "الصنف",
      warehouse: "المستودع",
      qty: "الكمية الموقّعة",
      at: "التاريخ",
      empty: "لا توجد دفعات مرتبطة بهذا المستند.",
    },
    journals: {
      number: "رقم القيد",
      date: "تاريخ القيد",
      account: "الحساب",
      debit: "مدين",
      credit: "دائن",
      totalDebit: "إجمالي المدين",
      totalCredit: "إجمالي الدائن",
      openInAccounting: "فتح في دفتر اليومية",
      empty: "لم يُنشئ هذا المستند أي قيد محاسبي.",
    },
    attachments: {
      open: "فتح المرفق",
      empty: "لا توجد مرفقات.",
    },
    timeline: {
      empty: "لا يوجد سجل إجراءات لهذا المستند.",
      synthetic: "مستنتج من أعمدة التوقيع",
      action: {
        create: "إنشاء",
        edit: "تعديل",
        submit: "إرسال للاعتماد",
        "request-recount": "طلب إعادة عد",
        approve: "اعتماد",
        post: "ترحيل",
        issue: "صرف",
        receive: "استلام",
        release: "إطلاق",
        complete: "إنهاء",
        close: "إقفال",
        cancel: "إلغاء",
        reverse: "عكس",
        delete: "حذف",
      },
    },
  },

  type: {
    receipt: "وارد مخزني",
    issue: "إذن صرف مخزني",
    adjustment: "تسوية مخزنية",
    stocktake: "جرد مخزني",
    transfer: "تحويل مخزني",
    production: "أمر إنتاج",
    production_legacy: "أمر إنتاج (قديم)",
    purchase_receipt: "استلام مشتريات",
    purchase_return: "مرتجع مشتريات",
    purchase_legacy: "مشتريات (قديم)",
    adjustment_legacy: "تعديل كمية (قديم)",
  },

  status: {
    draft: "مسودة",
    pending_approval: "بانتظار الاعتماد",
    approved: "معتمد",
    in_progress: "قيد التنفيذ",
    posted: "مُرحّل",
    partially_completed: "مكتمل جزئيًا",
    completed: "مكتمل",
    cancelled: "ملغى",
    reversed: "معكوس",
  },

  side: {
    warehouse: "مستودع",
    supplier: "مورد",
    gl_account: "حساب محاسبي",
    expense: "حساب مصروف",
    external: "جهة خارجية",
  },
} as const;
