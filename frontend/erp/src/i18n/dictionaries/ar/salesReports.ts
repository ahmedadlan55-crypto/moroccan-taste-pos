/** Sales Analytics Hub (/reports/sales/*) — Arabic strings.
 *
 *  Namespaces:
 *    hub / pages.<segment>      — the 16-tab container + per-tab title/subtitle
 *    topbar                     — the shared filter bar (period/compare/scopes/
 *                                 basis toggles/freshness/chips)
 *    metrics.<code>             — display name for EVERY metric code in
 *                                 lib/analytics/registry/metrics.js
 *    dims.<code>                — display name for EVERY dimension code in
 *                                 lib/analytics/registry/dimensions.js
 *    explain.<equationKey>      — short formula prose per registry equationKey
 *    states / builder / pivot   — hub-specific states + placeholders
 *
 *  The metric/dimension/equation key lists are pinned by
 *  modules/reports/sales/lib/registry-fixture.ts and covered by
 *  modules/reports/sales/__tests__/registry-i18n.test.ts (ar+en parity is also
 *  enforced by i18n/__tests__/dictionary.test.ts). English mirror:
 *  en/salesReports.ts (identical shape). */
export const salesReports = {
  hub: {
    eyebrow: "التقارير · المبيعات",
    title: "تحليلات المبيعات",
    subtitle: "مركز تحليلات المبيعات الموحّد — المقاييس والأبعاد من سجل الحقائق المعتمد",
    tabsAria: "أقسام تحليلات المبيعات",
  },

  pages: {
    executive: {
      title: "اللوحة التنفيذية",
      subtitle: "نظرة تنفيذية موجزة: صافي المبيعات والطلبات ومتوسط الفاتورة مقارنةً بالفترة السابقة",
    },
    explorer: {
      title: "المستكشف",
      subtitle: "استكشاف حر: اختر المقاييس والأبعاد وابنِ الجدول المحوري الذي تحتاجه",
    },
    items: {
      title: "الأصناف",
      subtitle: "مبيعات الأصناف والفئات: الكميات والصافي والمساهمة في الإجمالي",
    },
    modifiers: {
      title: "الإضافات",
      subtitle: "أداء الإضافات: معدل الإرفاق والكميات حسب الصنف الأم",
    },
    payments: {
      title: "المدفوعات",
      subtitle: "المقبوضات والمبالغ المستردّة حسب طريقة الدفع والمزوّد",
    },
    cashiers: {
      title: "أداء الكاشير",
      subtitle: "مبيعات كل موظف ومعدلات الخصم والإلغاء والإرجاع (يتطلب صلاحية أداء الموظفين)",
    },
    branches: {
      title: "الفروع",
      subtitle: "مقارنة الفروع والعلامات: الصافي والطلبات ومتوسط الفاتورة",
    },
    hours: {
      title: "الساعات",
      subtitle: "خريطة الذروة: المبيعات حسب الساعة ويوم الأسبوع وفترة الوجبة",
    },
    orders: {
      title: "الطلبات",
      subtitle: "حجم الطلبات وأنواعها وقنواتها وحالاتها عبر الفترة",
    },
    discounts: {
      title: "الخصومات",
      subtitle: "قيمة الخصومات ونسبتها والطلبات المخصومة حسب الفرع والموظف",
    },
    voids: {
      title: "الإلغاءات والمرتجعات",
      subtitle: "الطلبات الملغاة والمرتجعات: العدد والقيمة والأسباب",
    },
    shifts: {
      title: "الورديات",
      subtitle: "أداء الورديات: المبيعات والنقد المتوقع مقابل المعدود وفروق الصندوق",
    },
    taxes: {
      title: "الضرائب",
      subtitle: "ضريبة القيمة المضافة من الأعمدة المخزّنة: حسب الفئة والنسبة",
    },
    profitability: {
      title: "الربحية",
      subtitle: "التكلفة والربح الإجمالي ونسبة الهامش (يتطلب صلاحية عرض التكلفة)",
    },
    reconciliation: {
      title: "التسويات",
      subtitle: "تسوية المدفوعات والصندوق: المحصّل مقابل المتوقع والفروقات",
    },
    builder: {
      title: "منشئ التقارير",
      subtitle: "ابنِ تقريرًا مخصّصًا من أي مقاييس وأبعاد واحفظه وشاركه",
    },
  },

  topbar: {
    period: "الفترة",
    compare: "المقارنة",
    brand: "العلامة التجارية",
    branch: "الفرع",
    channel: "قناة البيع",
    orderType: "نوع الطلب",
    dateBasis: "أساس التاريخ",
    businessDay: "يوم العمل",
    calendarDay: "اليوم التقويمي",
    taxBasis: "أساس الضريبة",
    taxIncl: "شامل الضريبة",
    taxExcl: "دون الضريبة",
    refreshedAt: "آخر تحديث: {time}",
    refresh: "تحديث البيانات",
    lateTx: "أيام قيد الاكتمال: {count}",
    activeFilters: "الفلاتر النشطة",
    clearAll: "مسح الكل",
    saveView: "حفظ العرض",
    export: "تصدير",
    from: "من",
    to: "إلى",
    allBrands: "كل العلامات",
    allBranches: "كل الفروع",
    allChannels: "كل القنوات",
    allOrderTypes: "كل أنواع الطلب",
    removeFilter: "إزالة الفلتر: {name}",
    presets: {
      today: "اليوم",
      yesterday: "أمس",
      last7: "آخر 7 أيام",
      last30: "آخر 30 يومًا",
      mtd: "منذ بداية الشهر",
      qtd: "منذ بداية الربع",
      ytd: "منذ بداية السنة",
      custom: "مخصّص",
    },
    compareModes: {
      none: "بدون مقارنة",
      prevPeriod: "الفترة السابقة",
      prevYear: "السنة السابقة",
      custom: "مخصّص",
    },
    channels: {
      pos: "نقطة البيع",
      online: "المتجر الإلكتروني",
      aggregator: "تطبيقات التوصيل",
      call_center: "مركز الاتصال",
    },
    orderTypes: {
      dine_in: "محلي",
      takeaway: "سفري",
      delivery: "توصيل",
      pickup: "استلام",
    },
  },

  metrics: {
    gross_product_sales: "إجمالي مبيعات المنتجات",
    discounts_total: "إجمالي الخصومات",
    returns_net: "صافي المرتجعات",
    net_ex_vat: "صافي المبيعات دون الضريبة",
    vat_amount: "مبلغ ضريبة القيمة المضافة",
    invoice_total: "إجمالي الفواتير",
    orders: "عدد الطلبات",
    guests: "عدد الضيوف",
    discounted_orders: "الطلبات المخصومة",
    qty_sold: "الكمية المباعة",
    qty_returned: "الكمية المرتجعة",
    voids_count: "عدد الطلبات الملغاة",
    voids_value: "قيمة الطلبات الملغاة",
    returns_count: "عدد المرتجعات",
    returns_value: "قيمة المرتجعات",
    cogs: "تكلفة البضاعة المباعة",
    payments_in: "المقبوضات",
    refunds_out: "المبالغ المستردّة",
    tips_total: "إجمالي الإكراميات",
    fees_total: "إجمالي الرسوم",
    rounding_total: "إجمالي التقريب",
    till_expected_cash: "النقد المتوقع في الصندوق",
    till_counted: "النقد المعدود",
    modifier_lines: "أسطر الإضافات",
    modifier_qty: "كمية الإضافات",
    budget_amount: "مبلغ الموازنة",
    net_incl_vat: "صافي المبيعات شامل الضريبة",
    net_product_sales: "صافي مبيعات المنتجات",
    qty_net: "صافي الكمية",
    avg_ticket: "متوسط الفاتورة",
    avg_items_per_order: "متوسط الأصناف لكل طلب",
    discount_pct: "نسبة الخصم",
    gross_profit: "الربح الإجمالي",
    margin_pct: "نسبة الهامش",
    net_collections: "صافي التحصيلات",
    till_variance: "فرق الصندوق",
    item_contribution_pct: "نسبة مساهمة الصنف",
    attach_rate: "معدل إرفاق الإضافات",
    modifiers_per_item: "متوسط الإضافات لكل صنف",
    growth: "نسبة النمو",
    discount_rate_by_cashier: "معدل الخصم حسب الكاشير",
    void_rate_by_cashier: "معدل الإلغاء حسب الكاشير",
    return_rate_by_cashier: "معدل الإرجاع حسب الكاشير",
  },

  dims: {
    business_day: "يوم العمل",
    calendar_day: "اليوم التقويمي",
    week: "الأسبوع",
    month: "الشهر",
    quarter: "ربع السنة",
    year: "السنة",
    hour: "الساعة",
    half_hour: "نصف الساعة",
    weekday: "يوم الأسبوع",
    meal_period: "فترة الوجبة",
    branch: "الفرع",
    brand: "العلامة التجارية",
    company: "الشركة",
    warehouse: "المستودع",
    channel: "قناة البيع",
    order_type: "نوع الطلب",
    source: "مصدر الطلب",
    origin: "منشأ الطلب",
    device: "الجهاز",
    shift: "الوردية",
    table_no: "رقم الطاولة",
    order_status: "حالة الطلب",
    provenance: "مصدر البيانات",
    cashier: "الكاشير",
    salesperson: "مندوب المبيعات",
    payment_collector: "محصّل الدفع",
    discount_by: "مانح الخصم",
    void_by: "منفّذ الإلغاء",
    approved_by: "المعتمِد",
    closed_by: "من أغلق الطلب",
    menu_item: "الصنف",
    category: "الفئة",
    modifier_kind: "نوع الإضافة",
    payment_method: "طريقة الدفع",
    direction: "اتجاه الحركة",
    payment_provider: "مزوّد الدفع",
    discount_reason: "سبب الخصم",
    return_reason: "سبب الإرجاع",
    vat_category: "فئة الضريبة",
    vat_rate: "نسبة الضريبة",
    customer: "العميل",
    budget_metric: "مقياس الموازنة",
  },

  explain: {
    sum: "مجموع القيم المخزّنة مباشرةً ضمن الفترة والفلاتر المحددة.",
    count: "عدد السجلات المطابقة ضمن الفترة والفلاتر المحددة.",
    grossProductSales: "مجموع مبالغ أسطر البيع قبل الخصومات والمرتجعات (دون الضريبة).",
    invoiceTotal: "مجموع إجمالي الفواتير كما صدرت (شاملة الضريبة والرسوم).",
    expectedCash: "رصيد الافتتاح + المبيعات النقدية + الإيداعات − المصروفات − الاستردادات النقدية.",
    netInclVat: "صافي المبيعات دون الضريبة + مبلغ ضريبة القيمة المضافة.",
    netProductSales: "إجمالي مبيعات المنتجات − إجمالي الخصومات − صافي المرتجعات.",
    netQuantity: "الكمية المباعة − الكمية المرتجعة.",
    avgTicket: "صافي المبيعات دون الضريبة ÷ عدد الطلبات.",
    avgItemsPerOrder: "الكمية المباعة ÷ عدد الطلبات.",
    discountPct: "إجمالي الخصومات ÷ إجمالي مبيعات المنتجات × 100.",
    grossProfit: "صافي المبيعات دون الضريبة − تكلفة البضاعة المباعة.",
    marginPct: "الربح الإجمالي ÷ صافي المبيعات دون الضريبة × 100.",
    netCollections: "المقبوضات − المبالغ المستردّة.",
    tillVariance: "النقد المعدود − النقد المتوقع في الصندوق.",
    contributionPct: "قيمة المجموعة ÷ الإجمالي الكلي للمقياس نفسه × 100.",
    attachRate: "أسطر الإضافات ÷ الكمية المباعة × 100.",
    avgModifiersPerItem: "كمية الإضافات ÷ الكمية المباعة.",
    growth: "(قيمة الفترة الحالية − قيمة الفترة السابقة) ÷ قيمة الفترة السابقة × 100.",
    ratePct: "قيمة العدّاد ÷ عدد الطلبات × 100 لكل موظف.",
  },

  states: {
    notAvailableHistorically: "غير متاح للفترات التاريخية — يُحتسب هذا المقياس من تاريخ تفعيل التتبع فقط",
    completeness: "اكتمال البيانات: {value}",
    empty: "لا توجد بيانات ضمن الفترة والفلاتر المحددة",
    loadFailed: "تعذّر تحميل التحليلات — أعد المحاولة",
    notFound: "هذا القسم غير موجود",
    notFoundBody: "القسم المطلوب غير معروف في مركز تحليلات المبيعات — اختر قسمًا من الشريط أعلاه.",
  },

  builder: {
    metrics: "المقاييس",
    dimensions: "الأبعاد",
    runQuery: "تشغيل الاستعلام",
    saveReport: "حفظ التقرير",
    comingSoon: "منشئ التقارير المخصّصة يصل في الموجة القادمة",
  },

  placeholder: {
    title: "قيد البناء",
    body: "تصل هذه الصفحة مع موجة الصفحات القادمة — الفلاتر أعلاه جاهزة وستنطبق عليها فور وصولها.",
  },

  pivot: {
    expand: "توسيع المجموعة",
    collapse: "طي المجموعة",
  },
} as const;
