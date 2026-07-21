/** App-shell UI copy (Arabic) — sidebar, topbar, breadcrumbs, user menu, mobile
 *  nav, command palette, global search, notifications, approvals, company/branch
 *  scope, the 404 screen and the language toggle. Consumed by
 *  frontend/erp/src/app/shell/* and wired via t("shell.xxx").
 *
 *  English mirror: frontend/erp/src/i18n/dictionaries/en/shell.ts (identical
 *  shape — enforced by the dictionary parity test). */
export const shell = {
  brand: {
    name: "المذاق المغربي",
    tagline: "الإدارة الموحّدة",
  },
  identity: {
    guest: "زائر",
    unregistered: "غير مسجّل",
  },
  roles: {
    admin: "مدير النظام",
    developer: "مطوّر",
    manager: "مشرف",
    employee: "موظف",
    custody: "أمين عهدة",
    cashier: "كاشير",
    auditor: "مدقق",
    sales: "مندوب مبيعات",
    accountant: "محاسب",
    finance: "مالية",
  },
  languageToggle: {
    ariaLabel: "تبديل لغة الواجهة",
    switchToEnglish: "English",
    switchToArabic: "عربي",
  },
  sidebar: {
    ariaLabel: "الشريط الجانبي",
    nav: "التنقل الرئيسي",
    expandRail: "توسيع الشريط الجانبي",
    collapseRail: "طي الشريط الجانبي",
    collapse: "طي القائمة",
    expandGroup: "فتح صفحات {group}",
    collapseGroup: "طي صفحات {group}",
  },
  topbar: {
    toolsOpen: "فتح البحث ونطاق العمل",
    toolsClose: "إغلاق البحث ونطاق العمل",
    toolsLabel: "البحث والنطاق",
  },
  breadcrumbs: {
    ariaLabel: "مسار التنقل",
  },
  search: {
    open: "بحث والانتقال السريع (Ctrl+K)",
    placeholder: "بحث والانتقال السريع…",
  },
  commandPalette: {
    ariaLabel: "لوحة الأوامر",
    inputPlaceholder: "ابحث عن شاشة أو انتقل إليها…",
    inputAriaLabel: "بحث في الشاشات",
    noResults: "لا توجد نتائج مطابقة",
  },
  notifications: {
    label: "الإشعارات",
    heading: "الإشعارات",
    empty: "لا توجد إشعارات جديدة",
  },
  approvals: {
    label: "الموافقات المطلوبة",
    heading: "الموافقات المطلوبة",
    empty: "لا توجد موافقات معلّقة",
    openInbox: "فتح صندوق الوارد",
  },
  userMenu: {
    label: "حساب المستخدم",
    selfService: "الخدمة الذاتية",
    logout: "تسجيل الخروج",
  },
  scope: {
    groupLabel: "نطاق عرض البيانات",
    company: "الشركة",
    branch: "الفرع",
    selectCompany: "اختيار الشركة",
    selectBranch: "اختيار الفرع",
    allCompanies: "كل الشركات",
    allBranches: "كل الفروع",
  },
  appShell: {
    skipToContent: "تخطٍّ إلى المحتوى",
    mainContent: "المحتوى الرئيسي",
  },
  mobileNav: {
    ariaLabel: "تنقل سريع",
  },
  notFound: {
    title: "الصفحة غير موجودة",
    body: "لا يوجد قسم على هذا المسار. عُد إلى نظرة عامة وتابع من القائمة الجانبية.",
    back: "العودة إلى نظرة عامة",
  },
} as const;
