/**
 * POS-administration module namespace (Sprint 3 · Phase C — نقاط البيع).
 *
 * Screen copy for the pos-admin module: the register (payment methods) screen,
 * the shifts review screen, the cashier-shift-close reports screen, the
 * per-shift detail drawer, and the "managed from the cashier" deferred notices.
 *
 * Generic verbs (save/cancel/delete/edit/all/yes/no/status) stay in `common.*`;
 * record-status chips for OPEN/CLOSED shifts use the module-local `shift.*`
 * codes (feminine agreement — وردية — so they intentionally do NOT reuse the
 * masculine status.closed). Repeated financial column headers live in `col.*`.
 *
 * English mirror: frontend/erp/src/i18n/dictionaries/en/posAdmin.ts — identical
 * key-set / leaf-shape (enforced by i18n/__tests__/dictionary.test.ts once the
 * barrel merge wires this namespace in).
 */
export const posAdmin = {
  // ── Payment-method group codes (cash | electronic | …) ────────────────────
  pmGroup: {
    cash: "كاش",
    electronic: "إلكتروني",
    voucher: "قسيمة",
    loyalty: "ولاء",
    transfer: "تحويل",
    other: "أخرى",
  },
  // ── Service-fee type codes (none | percent | fixed) ───────────────────────
  feeType: {
    none: "بدون رسوم",
    percent: "نسبة %",
    fixed: "مبلغ ثابت",
  },
  // ── Shift OPEN/CLOSED status + balance chips (feminine — وردية) ────────────
  shift: {
    open: "مفتوحة",
    closed: "مغلقة",
    balanced: "متطابق",
    diffAmount: "الفرق {amount}",
  },
  // ── Repeated financial / table column headers ─────────────────────────────
  col: {
    order: "الترتيب",
    name: "الاسم",
    group: "المجموعة",
    fee: "رسوم الخدمة",
    shiftClose: "إغلاق الشيفت",
    date: "التاريخ",
    cashier: "الكاشير",
    start: "بدء الوردية",
    close: "الإغلاق",
    expected: "المتوقّع",
    actual: "الفعلي",
    diff: "الفرق",
    method: "طريقة الدفع",
  },
  // ── Register / payment-methods screen ─────────────────────────────────────
  register: {
    launcherTitle: "فتح الكاشير",
    launcherDesc:
      "طرق الدفع المُعرّفة هنا تظهر مباشرةً في شاشة الكاشير. لبدء البيع افتح تطبيق نقطة البيع.",
    launcherCta: "فتح شاشة الكاشير",
    heading: "طرق الدفع",
    subtitle: "إدارة طرق الدفع التي تُشغّل الكاشير وإغلاق الشيفت.",
    searchPlaceholder: "ابحث بالاسم…",
    emptyTitle: "لا توجد طرق دفع",
    emptyBody: "أضف أول طريقة دفع لتظهر في شاشة الكاشير.",
    groupAll: "كل المجموعات",
    newMethod: "طريقة دفع جديدة",
    enabled: "مفعّل",
    disabled: "معطّل",
    deleteTitle: "حذف طريقة الدفع",
    deleteBody: "سيتم حذف «{name}». لن تتأثر المبيعات السابقة.",
    saveFailed: "فشل الحفظ",
    deleteFailed: "فشل الحذف",
  },
  // ── Create / edit payment-method dialog ───────────────────────────────────
  dialog: {
    editTitle: "تعديل طريقة دفع",
    newTitle: "طريقة دفع جديدة",
    desc: "اضبط بيانات الطريقة والرسوم والخصائص — طرق الدفع تُشغّل شاشة الكاشير.",
    nameAr: "الاسم بالعربية",
    nameEn: "الاسم بالإنجليزية",
    sortOrder: "ترتيب العرض",
    feeType: "نوع الرسوم",
    feeValue: "قيمة الرسوم",
    flagsLegend: "الخصائص",
    description: "وصف",
    flags: {
      isActive: "مفعّل في النظام",
      showInShiftClose: "إظهار في إغلاق الشيفت",
      showInReports: "إظهار في التقارير",
      allowManualTotal: "السماح بإجمالي يدوي",
      requireReference: "يتطلب مرجع",
      requireTransactionNumber: "يتطلب رقم عملية",
      requireTerminal: "يتطلب جهاز",
      allowRefund: "يسمح بالاسترجاع",
      allowCancel: "يسمح بالإلغاء",
    },
  },
  // ── Payment-method form validation ────────────────────────────────────────
  valid: {
    nameArRequired: "الاسم بالعربية مطلوب",
    nameTooLong: "الاسم طويل جدًا",
    numberInvalid: "أدخل رقمًا صحيحًا",
    notNegative: "لا يمكن أن يكون سالبًا",
    descTooLong: "الوصف طويل جدًا",
  },
  // ── Shifts review screen ──────────────────────────────────────────────────
  shifts: {
    subtitle:
      "مراجعة ورديات الكاشير — المتوقّع مقابل الفعلي والفروقات. اضغط أي وردية لعرض توزيع طرق الدفع.",
    emptyTitle: "لا توجد ورديات",
    emptyBody: "لا توجد ورديات مطابقة لعوامل التصفية المحددة.",
  },
  // ── Cashier shift-close reports screen ────────────────────────────────────
  reports: {
    subtitle: "ملخّص إغلاق ورديات الكاشير مع إمكانية التصدير — المتوقّع، الفعلي، والفروقات.",
    emptyTitle: "لا توجد بيانات",
    stat: {
      totalShifts: "إجمالي الورديات",
      totalExpected: "إجمالي المتوقّع",
      totalActual: "إجمالي الفعلي",
      totalDiff: "إجمالي الفرق",
    },
    // CSV export column headers (mirrors the legacy shift-close admin sheet).
    export: {
      displayName: "اسم العرض",
      username: "اسم المستخدم",
      opening: "الافتتاح",
      cashActual: "الفعلي - كاش",
      cardActual: "الفعلي - بطاقة",
      otherActual: "الفعلي - أخرى",
      totalActual: "الفعلي - إجمالي",
      sessionId: "رقم الجلسة",
    },
  },
  // ── Shift filter bar (date range / cashier / status) ──────────────────────
  filters: {
    from: "من",
    to: "إلى",
    fromDateAria: "من تاريخ",
    toDateAria: "إلى تاريخ",
    cashierAll: "كل الكاشيرين",
    statusAll: "كل الحالات",
  },
  // ── Per-shift detail drawer ───────────────────────────────────────────────
  drawer: {
    eyebrow: "تفاصيل الوردية",
    titleFallback: "وردية",
    orderCount: "عدد الفواتير",
    endLabel: "إغلاق الوردية",
    openingFloat: "الرصيد الافتتاحي",
    breakdownTitle: "التوزيع حسب طريقة الدفع",
    emptyTitle: "لا توجد بيانات توزيع",
    emptyBody: "لم يسجّل الخادم توزيعًا لطرق الدفع لهذه الوردية.",
  },
  // ── "Managed from the cashier" deferred notices ───────────────────────────
  deferred: {
    parkedTitle: "الطلبات المعلقة تُدار من الكاشير",
    parkedBody:
      "الطلبات المعلقة (المحفوظة مؤقتًا) حالة تشغيلية تعيش داخل تطبيق نقطة البيع ولا يوجد لها مصدر بيانات في الواجهة الخلفية — استكملها من شاشة الكاشير.",
    deviceTitle: "مزامنة الأجهزة تُدار من الكاشير",
    deviceBody:
      "مزامنة أجهزة نقاط البيع تُنفَّذ داخل تطبيق الكاشير على كل جهاز، ولا تملك الواجهة الخلفية نقطة نهاية للتحكم بها — افتح تطبيق نقطة البيع للمزامنة.",
    openPos: "فتح تطبيق نقطة البيع",
  },
} as const;
