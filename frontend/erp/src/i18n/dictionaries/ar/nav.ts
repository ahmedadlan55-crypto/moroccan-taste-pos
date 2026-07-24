/**
 * Navigation labels (Arabic) — the group headings + every nav-item label.
 *
 * The navigation manifest (frontend/erp/src/app/navigation/manifest.ts) is a
 * plain data structure evaluated at import time, BEFORE React mounts, so it
 * cannot call useT(). Instead each `label` there is a STABLE translation KEY
 * (`nav.groups.<groupId>` / `nav.items.<itemId>`) and the render sites
 * (Sidebar / MobileNav / Breadcrumbs / CommandPalette) resolve it through
 * t(item.label). Keys are the manifest's own unique ids, so this stays 1:1 with
 * the manifest and can never collide.
 *
 * English mirror: frontend/erp/src/i18n/dictionaries/en/nav.ts — identical shape.
 */
export const nav = {
  groups: {
    overview: "الرئيسية",
    sales: "المبيعات",
    menu: "القوائم والوصفات",
    "pos-admin": "نقاط البيع",
    inventory: "المخزون",
    purchasing: "المشتريات",
    accounting: "المحاسبة",
    banking: "النقد والبنوك",
    people: "الموارد البشرية",
    workflow: "المعاملات والموافقات",
    reports: "التقارير",
    administration: "الإدارة",
  },
  items: {
    // overview
    "ov-overview": "نظرة عامة",
    "ov-tasks": "المهام والتنبيهات",
    "ov-approvals": "الموافقات المطلوبة",
    "ov-kpis": "مؤشرات الأداء",
    // sales
    "sl-orders": "الطلبات",
    "sl-invoices": "الفواتير",
    "sl-returns": "المرتجعات",
    "sl-payments": "المدفوعات",
    "sl-customers": "العملاء",
    "sl-channels": "قنوات البيع",
    "sl-pricing": "قوائم الأسعار والخصومات",
    // menu
    "mn-hub": "لوحة القوائم",
    "mn-brand": "قائمة العلامة التجارية",
    "mn-recipes": "الوصفات ومكوّنات التصنيع",
    "mn-price-lists": "قوائم الأسعار",
    "mn-combos": "الوجبات المركّبة",
    "mn-semi": "المنتجات نصف المصنّعة",
    "mn-images": "صور الأصناف",
    "mn-categories": "ترجمة الأقسام",
    // pos-admin
    "pa-register": "فتح الكاشير",
    "pa-shifts": "الورديات",
    "pa-parked": "الطلبات المعلقة",
    "pa-devices": "مزامنة الأجهزة",
    // inventory
    "inv-overview": "نظرة عامة",
    "inv-items": "الأصناف",
    "inv-warehouses": "المستودعات",
    "inv-balances": "الأرصدة",
    "inv-transfers": "التحويلات",
    "inv-receiving": "الاستلام",
    "inv-issues": "الصرف",
    "inv-adjustments": "التسويات",
    "inv-stocktakes": "الجرد",
    "inv-waste": "الهدر",
    "inv-lots-expiry": "التشغيلات والصلاحية",
    "inv-replenishment": "إعادة الطلب",
    "inv-production": "الإنتاج",
    "inv-method": "طريقة تقييم المخزون",
    // purchasing
    "pu-suppliers": "الموردون",
    "pu-requisitions": "طلبات الشراء",
    "pu-orders": "أوامر الشراء",
    "pu-receiving": "استلام البضاعة",
    "pu-invoices": "فواتير الموردين",
    "pu-payments": "مدفوعات الموردين",
    "pu-returns": "مرتجعات المشتريات",
    // accounting
    "ac-coa": "دليل الحسابات",
    "ac-journals": "القيود اليومية",
    "ac-gl": "الأستاذ العام",
    "ac-tb": "ميزان المراجعة",
    "ac-pnl": "قائمة الدخل",
    "ac-bs": "الميزانية",
    "ac-cf": "التدفقات النقدية",
    "ac-ar-aging": "أعمار الذمم المدينة",
    "ac-ap-aging": "أعمار الذمم الدائنة",
    "ac-ratios": "النسب المالية",
    "ac-equity-changes": "التغيرات في حقوق الملكية",
    "ac-profitability": "الربحية حسب البعد",
    "ac-inventory-valuation": "تقييم المخزون",
    "ac-royalties": "امتياز العلامات",
    "ac-periods": "الفترات المحاسبية",
    "ac-cost-centers": "مراكز التكلفة",
    "ac-dimensions": "المشروعات والأبعاد",
    // banking
    "bk-cashboxes": "الخزائن",
    "bk-accounts": "الحسابات البنكية",
    "bk-receipts": "المقبوضات",
    "bk-payments": "المدفوعات",
    "bk-transfers": "التحويلات البنكية",
    "bk-reconciliation": "التسويات البنكية",
    "bk-cash-closing": "إقفال الصندوق",
    // people
    "pe-employees": "الموظفون",
    "pe-attendance": "الحضور والانصراف",
    "pe-shifts": "الورديات",
    "pe-leaves": "الإجازات",
    "pe-contracts": "العقود",
    "pe-payroll": "الرواتب",
    "pe-org-tree": "الهيكل الإداري",
    "pe-custody": "العهد والمستندات",
    "pe-custody-officers": "مسؤولو العهدة",
    "pe-self-service": "الخدمة الذاتية",
    // workflow
    "wf-new": "إنشاء معاملة",
    "wf-inbox": "صندوق الوارد",
    "wf-outbox": "صندوق الصادر",
    "wf-my-requests": "طلباتي",
    "wf-approval-flows": "مسارات الاعتماد",
    "wf-action-log": "سجل الإجراءات",
    // reports
    "rp-sales": "تقارير المبيعات",
    "rp-inventory": "تقارير المخزون",
    "rp-purchasing": "تقارير المشتريات",
    "rp-financial": "التقارير المالية",
    "rp-people": "تقارير الموظفين",
    "rp-operations": "تقارير التشغيل",
    "rp-saved": "التقارير المحفوظة",
    // administration
    "ad-companies": "الشركات والعلامات التجارية",
    "ad-branches": "الفروع",
    "ad-warehouses": "المستودعات",
    "ad-users": "المستخدمون",
    "ad-roles": "الأدوار والصلاحيات",
    "ad-settings": "الإعدادات",
    "ad-invoice-settings": "بيانات وتصميم الفاتورة",
    "ad-tax": "الضرائب",
    "ad-payment-methods": "طرق الدفع",
    "ad-security": "الأمان",
    "ad-audit-log": "سجل التدقيق",
  },
} as const;
