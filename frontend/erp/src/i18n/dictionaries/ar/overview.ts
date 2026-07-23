/**
 * Overview (Home) module namespace — the dashboard/home domain
 * (frontend/erp/src/modules/overview/*): the financial + operational KPI grids,
 * the Overview / KPIs / Tasks & Alerts / Approvals screens, and the shared
 * workflow-inbox list.
 *
 * Generic verbs live in `common.*`; page-state copy in `states.*`; the "item"
 * noun in `table.itemNoun`; record-status chips resolve through `status.*` via
 * <StatusBadge> (the workflow statuses map to canonical status codes in the
 * component). Everything unique to the overview experience lives here.
 *
 * English mirror: frontend/erp/src/i18n/dictionaries/en/overview.ts — identical
 * key-set / leaf-shape (enforced by i18n/__tests__/dictionary.test.ts).
 */
export const overview = {
  // Shared across every overview screen.
  eyebrow: "الرئيسية",
  opsHeading: "الأرصدة التشغيلية",

  // Financial KPI tiles (KpiGrid — _common.tsx).
  kpi: {
    sales: "المبيعات",
    orders: "عدد الطلبات",
    avgTicket: "متوسط الفاتورة",
    netIncome: "صافي الدخل",
    expenses: "المصروفات",
    purchases: "المشتريات",
    grossMargin: "هامش الربح الإجمالي",
  },
  // Operational balance tiles (OpsGrid — _common.tsx).
  ops: {
    pendingPayments: "مدفوعات معلّقة",
    arOutstanding: "ذمم مدينة مستحقة",
    apOutstanding: "ذمم دائنة مستحقة",
  },

  // Overview (Home) screen.
  home: {
    title: "نظرة عامة",
    subtitle: "ملخّص الأداء المالي والتشغيلي للمجموعة.",
    loadErrorTitle: "تعذّر تحميل لوحة المؤشرات",
    loadErrorBody: "لم نتمكّن من جلب بيانات النظرة العامة الآن.",
    // Quick-link card description (the label reuses tasks.title).
    quickTasksDesc: "الوارد والمهام التي تحتاج انتباهك.",
  },

  // KPIs screen.
  kpis: {
    title: "مؤشرات الأداء",
    subtitle: "أهم مؤشرات الأداء المالية والتشغيلية للفترة الحالية.",
    loadError: "تعذّر تحميل المؤشرات",
  },

  // Tasks & Alerts screen.
  tasks: {
    title: "المهام والتنبيهات",
    subtitle: "المعاملات الواردة التي تحتاج إلى إجراء منك.",
    openInbox: "فتح صندوق الوارد",
    emptyTitle: "لا توجد مهام معلّقة",
    emptyBody: "صندوق الوارد فارغ — لا شيء يحتاج انتباهك الآن.",
    overdueCount: "{count} متأخرة",
  },

  // Approvals screen.
  approvals: {
    title: "الموافقات المطلوبة",
    subtitle: "المعاملات بانتظار اعتمادك.",
    openTxns: "فتح المعاملات",
    awaitingCount: "{count} بانتظار الاعتماد",
    emptyTitle: "لا توجد موافقات مطلوبة",
    emptyBody: "لا توجد معاملات بانتظار اعتمادك حاليًا.",
  },

  // Shared workflow-inbox list (incoming.tsx).
  inbox: {
    txnFallback: "معاملة",
    overdue: "متأخرة",
  },
  // Transaction importance chips (Badge tone is set in the component).
  importance: {
    critical: "حرج",
    high: "عالي",
    medium: "متوسط",
    low: "منخفض",
  },
  // Workflow statuses with no canonical status.* code (rendered neutral).
  txnStatus: {
    created: "جديد",
    replied: "تم الرد",
    returned: "مُعاد للتعديل",
  },
} as const;
