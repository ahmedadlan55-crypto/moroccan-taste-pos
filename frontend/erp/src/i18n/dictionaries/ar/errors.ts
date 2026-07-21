/** ApiError.code → user-facing Arabic string. Consumed via
 *  translateApiError(e, t) (frontend/erp/src/i18n/errorCodes.ts).
 *
 *  Seeded with the common backend codes the Express routes emit
 *  (VERSION_CONFLICT / PERMISSION_DENIED / NOT_FOUND / RATE_LIMITED — see
 *  routes/*.js) plus the SERVER_ERROR / UNAUTHORIZED / VALIDATION_ERROR
 *  fallbacks translateApiError relies on. Other agents append module-specific
 *  codes as they translate each screen. */
export const errors = {
  SERVER_ERROR: "حدث خطأ في الخادم — يرجى المحاولة لاحقًا",
  UNAUTHORIZED: "انتهت الجلسة أو أنها غير مصرَّح بها — يرجى تسجيل الدخول من جديد",
  VALIDATION_ERROR: "تحقّق من البيانات المُدخلة ثم أعد المحاولة",
  VERSION_CONFLICT: "تم تعديل هذا العنصر من مكان آخر — يرجى إعادة التحميل والمحاولة مجددًا",
  PERMISSION_DENIED: "لا تملك صلاحية لتنفيذ هذه العملية",
  NOT_FOUND: "العنصر المطلوب غير موجود أو تم حذفه",
  RATE_LIMITED: "عدد كبير من المحاولات — يرجى الانتظار قليلًا ثم المحاولة مجددًا",
} as const;
