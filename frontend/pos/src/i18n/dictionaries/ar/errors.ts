/** ApiError.code → user-facing Arabic string. Consumed via
 *  translateApiError(e, t) (frontend/pos/src/i18n/errorCodes.ts).
 *
 *  RULE: every message tells the cashier what to DO next. A code the cashier
 *  cannot act on is worse than the server's own sentence.
 *
 *  DELIBERATELY ABSENT: VALIDATION_ERROR. It is the server's catch-all bad-input
 *  code (~30 distinct, far more specific messages in routes/pos-v2.js alone —
 *  «السلة فارغة», «الصنف "X" غير نشط», «البيع الآجل يتطلب اختيار عميل»…), and
 *  translateApiError prefers `errors.<code>` over `e.message`. Adding a key here
 *  would REPLACE every one of those precise sentences with one vague line.
 */
export const errors = {
  VERSION_CONFLICT: "تم تعديل هذا العنصر من جهاز آخر — يرجى إعادة التحميل والمحاولة مجددًا",
  UNAUTHORIZED: "الجلسة منتهية أو غير مصرَّح بها — يرجى تسجيل الدخول من جديد",
  SERVER_ERROR: "حدث خطأ في الخادم — يرجى المحاولة لاحقًا",
  O2C_MODULE_ACTIVE: "هذه العملية معطَّلة حاليًا بسبب تفعيل نظام إدارة المبيعات الجديد",
  approval_required: "هذه العملية تتطلب موافقة مدير",
  OVER_RETURN: "الكمية المطلوب إرجاعها تتجاوز الكمية المتاحة للإرجاع",
  SOD_VIOLATION: "لا يمكنك تنفيذ هذه العملية بنفسك — فصل المهام يتطلب موافقة شخص آخر",

  // ── Offline engine ────────────────────────────────────────────────────────
  // lib/offline.ts calls t("errors.CHECKOUT_PREREQUISITE_FAILED") — the key
  // existed in NEITHER dictionary, so the cashier got the raw dotted path.
  CHECKOUT_PREREQUISITE_FAILED:
    "لم يُحفَظ الطلب على الخادم، فلم تُنفَّذ عملية الدفع — الطلب مفتوح من جديد، أعد الدفع",

  // ── Checkout / sale (routes/sales.js) ─────────────────────────────────────
  total_mismatch: "تغيّرت الأسعار منذ إضافة الأصناف — حدِّث القائمة ثم أعد إدخال الطلب والمحاولة",
  sale_failed: "تعذّر إتمام البيع بسبب خطأ داخلي — أعد المحاولة، وإن تكرّر تواصل مع الدعم",
  PAYMENT_MISMATCH: "مجموع الدفعات لا يساوي إجمالي الطلب — صحّح المبالغ حتى تتطابق تمامًا",
  IDEMPOTENCY_UNAVAILABLE:
    "أُوقف الدفع منعًا لتكرار الفاتورة — لا تُعِد المحاولة على هذا الجهاز وأبلغ الدعم فورًا",

  // ── Shift (routes/sales.js:486-511 — re-validated at every sale/replay) ────
  shift_required: "لا توجد وردية مفتوحة — افتح وردية ثم أعد الدفع",
  shift_not_found: "الوردية لم تعد موجودة — افتح وردية جديدة ثم أعد الدفع",
  shift_closed: "الوردية مغلقة — افتح وردية جديدة ثم أعد الدفع",
  shift_owner_mismatch: "هذه الوردية تخص مستخدمًا آخر — افتح وردية باسمك ثم أعد الدفع",

  // ── Order lifecycle / catalog data ────────────────────────────────────────
  INVALID_STATE_TRANSITION:
    "حالة الطلب لا تسمح بهذا الإجراء — افتح الطلب من «الطلبات المعلّقة» وابدأ الخطوة من جديد",
  UNIT_CONVERSION_CONFLICT:
    "وحدات هذا الصنف تغيّرت على الخادم — حدِّث القائمة، ثم احذف السطر وأضفه من جديد",
  NOT_FOUND: "العنصر المطلوب لم يعد موجودًا على الخادم — حدِّث القائمة وأعد المحاولة",

  // ── Catalog loading (lib/catalogCache.ts CatalogError.code) ───────────────
  CATALOG_OFFLINE:
    "لا يوجد اتصال ولا نسخة محفوظة من القائمة — اتصل بالشبكة مرة واحدة ثم أعد فتح الكاشير",
  CATALOG_LOAD_FAILED: "تعذّر تحميل القائمة — تحقّق من الاتصال ثم اضغط «إعادة المحاولة»",
  SESSION_EXPIRED: "انتهت صلاحية الجلسة — سجّل الدخول من جديد قبل متابعة البيع",
} as const;
