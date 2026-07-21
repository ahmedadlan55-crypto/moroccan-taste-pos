/** Sign-in + change-password copy (Arabic). Pre-auth screens: the language is
 *  resolved from localStorage (erp_lang) before any user identity exists (the
 *  I18nProvider already does this), and both screens carry a language toggle.
 *
 *  Consumed by frontend/erp/src/app/pages/Login.tsx and
 *  frontend/erp/src/app/pages/ChangePassword.tsx via t("login.xxx").
 *  English mirror: frontend/erp/src/i18n/dictionaries/en/login.ts (identical
 *  shape — enforced by the dictionary parity test). */
export const login = {
  brand: "المذاق المغربي",
  subtitle: "الإدارة الموحّدة — تسجيل الدخول",
  usernameLabel: "اسم المستخدم",
  passwordLabel: "كلمة المرور",
  totpLabel: "رمز التحقق الثنائي",
  totpPlaceholder: "000000",
  submit: "تسجيل الدخول",
  errors: {
    totpRequired: "أدخل رمز التحقق الثنائي",
    loginFailed: "تعذّر تسجيل الدخول",
    network: "تعذّر الاتصال بالخادم. حاول مجددًا.",
  },
  changePassword: {
    title: "تغيير كلمة المرور",
    subtitle: "اختر كلمة مرور قوية لحسابك",
    mandatory: "حسابك يستخدم كلمة مرور افتراضية. يجب تغييرها قبل المتابعة.",
    currentLabel: "كلمة المرور الحالية",
    newLabel: "كلمة المرور الجديدة",
    confirmLabel: "تأكيد كلمة المرور الجديدة",
    reveal: "إظهار كلمة المرور",
    hide: "إخفاء كلمة المرور",
    mismatch: "الكلمتان غير متطابقتين",
    submit: "حفظ كلمة المرور",
    back: "العودة إلى نظرة عامة",
    genericError: "تعذّر تغيير كلمة المرور",
    checks: {
      minLength: "12 حرفًا على الأقل",
      hasLetter: "تحتوي على حرف",
      hasNumber: "تحتوي على رقم",
      hasSpecial: "تحتوي على رمز خاص (‏!@#$…)",
      notCommon: "ليست كلمة مرور شائعة",
    },
    strength: {
      veryWeak: "ضعيفة جدًا",
      weak: "ضعيفة",
      medium: "متوسطة",
      good: "جيدة",
      strong: "قوية",
    },
  },
} as const;
