/** Shared page-state copy (loading / empty / error / offline / session-expired
 *  / permission-denied / conflict). These MIRROR the currently-hardcoded Arabic
 *  in frontend/erp/src/shared/ui/states.tsx exactly — another agent wires the
 *  component up to t("states.xxx"); this file just supplies the keys+values so
 *  the ar/en shapes stay in parity from the start. */
export const states = {
  loading: "جارٍ التحميل…",
  emptyDefault: "لا توجد بيانات بعد",
  errorDefault: "تعذّر تحميل البيانات",

  reference: "رقم المرجع:",
  permissionDenied: "لا تملك صلاحية لعرض هذا القسم",
  permissionDeniedBody: "هذه العملية تتطلب صلاحية أعلى. تواصل مع المدير إن كنت تظن أن هذا خطأ.",
  sessionExpired: "انتهت الجلسة",
  sessionExpiredBody: "انتهت صلاحية تسجيل الدخول. سجّل الدخول من جديد ثم عُد إلى هذه الصفحة.",
  loginBtn: "تسجيل الدخول",
  offline: "أنت غير متصل بالإنترنت",
  offlineBody: "تعذّر الوصول إلى الخادم. سنعيد المحاولة تلقائيًا عند عودة الاتصال.",
  retryBtn: "إعادة المحاولة",
  conflict: "تغيّرت البيانات منذ آخر تحميل",
  refreshBtn: "تحديث",
  /** Generic safe fallback for safeUserMessage() when the raw error looks like a
   *  DB/stack dump. */
  unexpectedError: "حدث خطأ غير متوقع. أعد المحاولة، وإن استمرت المشكلة تواصل مع المسؤول.",
} as const;
