/** ApiError.code → user-facing Arabic string. Consumed via
 *  translateApiError(e, t) (frontend/pos/src/i18n/errorCodes.ts). */
export const errors = {
  VERSION_CONFLICT: "تم تعديل هذا العنصر من جهاز آخر — يرجى إعادة التحميل والمحاولة مجددًا",
  UNAUTHORIZED: "الجلسة منتهية أو غير مصرَّح بها — يرجى تسجيل الدخول من جديد",
  SERVER_ERROR: "حدث خطأ في الخادم — يرجى المحاولة لاحقًا",
  O2C_MODULE_ACTIVE: "هذه العملية معطَّلة حاليًا بسبب تفعيل نظام إدارة المبيعات الجديد",
  approval_required: "هذه العملية تتطلب موافقة مدير",
  OVER_RETURN: "الكمية المطلوب إرجاعها تتجاوز الكمية المتاحة للإرجاع",
  SOD_VIOLATION: "لا يمكنك تنفيذ هذه العملية بنفسك — فصل المهام يتطلب موافقة شخص آخر",
} as const;
