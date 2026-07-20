/**
 * Arabic dictionary — PosLogin (the POS's own sign-in screen: brand heading,
 * username/password/2FA fields, submit button, error copy, and the link back
 * to the main system's login).
 * English mirror: frontend/pos/src/i18n/dictionaries/en/login.ts
 *
 * NOTE: the language-toggle button on this screen does NOT get its own keys
 * here — it reuses header.languageToggle.* verbatim (see PosLogin.tsx), so a
 * login-screen toggle and the post-login Header toggle say exactly the same
 * thing.
 */
export const login = {
  brand: "المذاق المغربي — كاشير",
  title: "تسجيل الدخول",
  usernameLabel: "اسم المستخدم",
  passwordLabel: "كلمة المرور",
  totpLabel: "رمز التحقق الثنائي",
  totpPlaceholder: "000000",
  submit: "تسجيل الدخول",
  backToSystem: "الدخول من النظام الرئيسي بدلًا من ذلك",
  errors: {
    totpRequired: "أدخل رمز التحقق الثنائي",
    loginFailed: "تعذّر تسجيل الدخول",
    roleNotAllowed: "هذا الحساب لا يملك صلاحية الدخول إلى الكاشير. تواصل مع الإدارة.",
    networkError: "تعذّر الاتصال بالخادم. حاول مجددًا.",
  },
} as const;
