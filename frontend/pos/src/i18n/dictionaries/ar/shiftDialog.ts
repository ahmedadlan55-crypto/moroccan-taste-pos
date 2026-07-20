// Arabic strings for ShiftDialog.tsx — shift open (opening float), the info
// screen (V2 order/payment summary + X-report), the V3 close flow (blind cash
// count by denomination, per-method counted vs expected, variance gate,
// notes), and the post-close Z-report + WhatsApp share.
//
// `status`/`method` hold i18n DOTTED PATHS (not literal text) — same
// convention as RequisitionsDialog's SHR_STATUS_LABELS, resolved via
// shiftStatusLabel()/shiftMethodLabel() in the component.
export const shiftDialog = {
  dialogTitle: "الوردية",
  currency: "ر.س",
  halala: "هللة",

  status: {
    open: "مفتوح",
    held: "معلق",
    submitted: "قيد الدفع",
    completed: "مكتمل",
    voided: "ملغي",
  },
  method: {
    cash: "كاش",
    card: "شبكة",
    credit: "آجل",
  },

  noShift: {
    title: "لا توجد وردية مفتوحة",
    subtitle: "افتح وردية لبدء البيع — الدفع يتطلب وردية مفتوحة",
    openingFloatLabel: "الرصيد الافتتاحي (نقدية بدء الوردية)",
    amountLabel: "المبلغ",
    openButton: "فتح وردية",
    openOfflineTooltip: "فتح الوردية يتطلب اتصالًا بالخادم",
    offlineNote: "غير متاح بلا اتصال",
  },

  info: {
    currentShiftLabel: "الوردية الحالية",
    byStatusHeading: "طلبات V2 حسب الحالة",
    noOrdersYet: "لا طلبات بعد",
    completedByMethodHeading: "المكتمل حسب طريقة الدفع",
    noPaymentsYet: "لا مدفوعات بعد",
    xReportButton: "تقرير X — طباعة",
    xReportTooltip: "لقطة منتصف الوردية — المتوقع حسب طريقة الدفع",
    xReportOfflineTooltip: "تقرير X يتطلب اتصالًا بالخادم",
    closeShiftButton: "إغلاق الوردية",
    closeShiftTooltip: "بدء إغلاق الوردية",
    closeShiftOfflineTooltip: "إغلاق الوردية يتطلب اتصالًا بالخادم",
    closeOfflineNote: "إغلاق الوردية غير متاح بلا اتصال",
  },

  // Shared column headers — reused by both the counting table (closing) and
  // the post-close breakdown table (closed).
  table: {
    method: "الطريقة",
    counted: "المعدود",
    expected: "المتوقع",
    variance: "الفرق",
    actual: "الفعلي",
    total: "الإجمالي",
  },

  closing: {
    countInstructionsPrefix: "أدخل المبالغ المعدودة فعليًا لكل طريقة دفع —",
    invoiceCountSuffix: "فاتورة في الوردية",
    openingFloatInClosing: "الرصيد الافتتاحي (ضمن المتوقع نقدًا)",
    cashDenomHeading: "عدّ النقدية بالفئات (كاش)",
    denomNote: "ورقة",
    denomCoin: "عملة",
    /** {face} — e.g. "5 ر.س" / "25 هللة". */
    denomCountAriaLabel: "عدد {face}",
    cashDrivenBadge: "من عدّ الفئات",
    countedAriaLabelPrefix: "المعدود —",
    notCountedBadge: "لم يُعد",
    revealLabel: "أنهيت العدّ وأدخلت المبالغ — أظهر مقارنة النظام",
    revealHint: "المبالغ المتوقعة مخفية أثناء العدّ حتى لا يتأثر العدّ الفعلي بها.",
    unmatchedWarningPrefix: "مبالغ غير مطابقة لأي طريقة:",
    unmatchedWarningSuffix: "— راجع الإدارة",
    notesLabel: "ملاحظات الإغلاق",
    varianceNoteHint: "— يوجد فرق: اشرح السبب (١٠ أحرف على الأقل)",
    confirmButton: "تأكيد إغلاق الوردية",
  },

  closed: {
    title: "أُغلقت الوردية",
    totalVarianceLabel: "الفرق الكلي:",
    printZButton: "طباعة تقرير Z",
    shareWhatsAppButton: "مشاركة واتساب",
    doneButton: "تم",
  },

  // closeGate reasons (legacy _scLockClose/_scUnlockClose :5793-5812 + the
  // variance gate :5767).
  gate: {
    needsReveal: "أنهِ العدّ ثم فعِّل «أنهيت العدّ» أولًا",
    needsCount: "أدخل المبالغ المعدودة أولًا",
    needsNote: "اشرح سبب الفرق أولًا (١٠ أحرف على الأقل)",
  },

  // buildShiftWhatsAppText (legacy shareShiftReportWhatsApp, app.js:2872).
  whatsapp: {
    title: "تقرير إغلاق وردية (Z) —",
    cashier: "الكاشير:",
    orderCount: "عدد الفواتير:",
    expected: "المتوقع:",
    counted: "المعدود:",
    variance: "الفرق:",
    lineExpectedPrefix: "متوقع",
  },

  printBlocked: "المتصفح منع نافذة الطباعة — اسمح بالنوافذ المنبثقة",
  reportLoadFailed: "تعذّر تحميل تقرير الوردية",
  closeFailed: "تعذّر إغلاق الوردية",
  closeSuccessToast: "أُغلقت الوردية بنجاح",
} as const;
