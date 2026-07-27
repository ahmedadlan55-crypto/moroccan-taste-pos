// Arabic strings for PaymentDialog.tsx — method tabs, cash/split tender,
// owner-method notes, checkout progress, timeout/success screens.
export const paymentDialog = {
  title: "الدفع",
  currency: "ر.س",

  totalDue: "الإجمالي المستحق",
  noShiftOpen: "لا يمكن الدفع بلا وردية مفتوحة — افتح وردية أولًا من الشريط العلوي",
  openShiftButton: "افتح وردية الآن",

  methodTablistLabel: "طريقة الدفع",
  methodCash: "كاش",
  methodCard: "شبكة",
  methodSplit: "مختلط",
  methodCredit: "آجل",
  cardOfflineTip: "دفع الشبكة غير متاح بلا اتصال",
  splitOfflineTip: "الدفع المختلط غير متاح بلا اتصال",
  creditOfflineTip: "البيع الآجل غير متاح بلا اتصال",
  creditNeedsSupervisorTip: "البيع الآجل يتطلب مشرفًا/مديرًا",
  ownerMethodOfflineTip: "طرق الدفع الإضافية غير متاحة بلا اتصال",

  offlineBanner: "أنت غير متصل — الدفع كاش فقط، وسيُرحَّل البيع عند عودة الاتصال",

  exactAmount: "المبلغ بالضبط",
  tenderedLabel: "المستلَم من العميل (ر.س)",
  insufficientAmount: "المبلغ غير كافٍ",
  changeDueLabel: "الباقي للعميل",
  changeDueLabelColon: "الباقي للعميل:",

  splitSumMatches: "المجموع مطابق",
  // Fill-remainder: the cashier used to compute «الإجمالي − بقية الخانات» in
  // their head and type it digit by digit while the banner flashed red.
  splitRemaining: "المتبقي: {amount}",
  splitFillRemainderAria: "املأ المبلغ المتبقي في الخانة المحددة",

  // Reference/approval number — the pad drives this on شبكة and on owner
  // methods that come with a slip (بنك/محفظة/شيك…).
  referenceLabel: "رقم العملية / الموافقة (اختياري)",
  referencePlaceholder: "من إيصال الجهاز",
  referenceNotePrefix: "مرجع: ",

  // One-line hint under the ALWAYS-PRESENT keypad, saying what it types now.
  padHint: {
    cash: "لوحة الأرقام تكتب المبلغ المستلَم",
    split: "لوحة الأرقام تكتب في الخانة المحددة",
    reference: "لوحة الأرقام تكتب رقم العملية",
    inertCredit: "البيع الآجل يُسجَّل بالكامل على حساب العميل — لا يوجد رقم لإدخاله",
    inertNote: "هذه الطريقة تحتاج ملاحظة مكتوبة بالأعلى — لا يوجد إدخال رقمي",
    inertFixed: "المبلغ مثبّت على إجمالي الفاتورة — لا يوجد رقم لإدخاله",
  },

  cardCollectInfoPrefix: "حصّل",
  cardCollectInfoSuffix: "عبر جهاز الشبكة ثم أكّد",

  creditInfoPrefix: "بيع آجل بقيمة",
  creditInfoSuffix: "— يُسجَّل على حساب العميل (يتطلب صلاحية مشرف)",

  ownerCollectInfoMiddle: "عبر «",
  ownerCollectInfoSuffix: "» ثم أكّد",

  ownerNoteLabelPrefix: "ملاحظات الدفع — سبب اختيار «",
  ownerNoteLabelSuffix: "» (إلزامية)",
  ownerNotePlaceholder: "مثال: تحويل بنكي — إيصال رقم 123",
  paymentNotesAriaLabel: "ملاحظات الدفع",
  noteTooShortWarning: "اكتب ٣ أحرف على الأقل لوصف الدفعة — الخادم يرفض «أخرى» بلا ملاحظة",

  creditBlockedWarning: "البيع الآجل يتطلب اختيار عميل — اختر عميلًا من السلة أولًا",

  confirmButtonPrefix: "تأكيد الدفع —",

  stageSubmit: "تثبيت الطلب…",
  stageSale: "تسجيل الفاتورة…",
  stageComplete: "إكمال الطلب…",

  timeoutTitle: "انتهت مهلة الطلب — تحقق من الاتصال ثم أعد المحاولة",
  timeoutBody:
    "لم يُلغَ الطلب — قد يكون البيع وصل للخادم رغم انقطاع الرد. إعادة المحاولة آمنة: إن كان البيع قد سُجّل فلن يتكرر (محمي ضد الازدواج)، ويمكنك أيضًا التحقق من «فواتيري».",
  // closeButton / retryButton intentionally omitted — reuse common.close /
  // common.retry (exact same text), per the i18n contract's dedup rule.

  queuedTitle: "حُفظ الطلب — سيُرحَّل عند عودة الاتصال",
  localRefLabel: "مرجع محلي:",
  successTitle: "تم الدفع بنجاح",
  invoiceLabel: "فاتورة:",

  printReceiptButton: "طباعة الإيصال",
  printKitchenButton: "طباعة للمطبخ",
  newOrderButton: "طلب جديد",
  printBlockedFull: "المتصفح منع نافذة الطباعة — اسمح بالنوافذ المنبثقة",
  printBlockedShort: "المتصفح منع نافذة الطباعة",

  failedDefault: "فشل الدفع",
} as const;
