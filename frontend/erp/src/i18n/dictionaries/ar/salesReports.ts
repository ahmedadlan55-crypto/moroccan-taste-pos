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
    pickerLabel: "التقرير",
  },

  report: {
    title: "تقرير المبيعات",
    print: "طباعة",
    totalRow: "الإجمالي",
    taxableBase: "الوعاء الخاضع",
    share: "النسبة",
    item: "البند",
    countCol: "العدد",
    valueCol: "القيمة",
    difference: "الفرق",
    balanced: "مطابق",
    sectionSummary: "بيان المبيعات",
    sectionSummaryNote: "كل سطر على أساس ضريبي واحد، وسطر «=» هو الناتج الحسابي لما فوقه بالهللة",
    basisExcl: "الأساس: دون ضريبة القيمة المضافة",
    basisIncl: "الأساس: شامل ضريبة القيمة المضافة",
    basisNoteExcl:
      "الخصم مسجَّل شاملًا الضريبة ولا يوجد له تفصيل ضريبي في البيانات، فهو مطروح سلفًا من الأسطر أدناه ولا يظهر كسطر في هذا البيان — قيمته في «بنود للعلم».",
    basisNoteIncl:
      "الخصم مسجَّل في هذه المساحة نفسها (شاملًا الضريبة)، فيظهر هنا سطرًا مطروحًا، والسطر الأول أُعيد بناؤه بجمعه على المُفوتر.",
    memoTitle: "بنود للعلم — خارج حساب البيان",
    memoNote: "أرقام تُعرَض للاطلاع ولا تدخل في الجمع أعلاه؛ الرسوم والتقريب ليسا جزءًا من إجمالي الفاتورة",
    memoControl: "سطر رقابي: يجب أن يساوي صفرًا",
    sectionTax: "الضريبة حسب الفئة",
    sectionTaxNote: "الوعاء الخاضع ومبلغ الضريبة لكل فئة — دائمًا دون الضريبة مهما كان اختيار الأساس أعلاه",
    sectionCollections: "التحصيل حسب وسيلة الدفع",
    sectionCollectionsNote: "المقبوض والمردود وصافي التحصيل، ومطابقته بإجمالي الفواتير",
    sectionReturns: "المرتجعات والإلغاءات",
    sectionReturnsNote: "العدد والقيمة ونسبتها من صافي المبيعات",
    sectionProfit: "التكلفة والربح",
    sectionProfitNote: "التكلفة من لقطات وقت البيع، لا من تكلفة اليوم",
    sectionDaily: "التفصيل اليومي",
  },

  groups: {
    overview: "نظرة عامة",
    products: "المنتجات والربحية",
    money: "المال والتحصيل",
    operations: "التشغيل والموظفون",
    advanced: "متقدم",
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
    "item-sales": {
      title: "مبيعات الأصناف",
      subtitle: "تفصيل يومي لكل صنف في كل فرع: الكمية والإجمالي والخصم والمرتجع والصافي، والتكلفة والربح لمن يملك صلاحية عرض التكلفة",
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
    print: "طباعة التقرير",
    from: "من",
    to: "إلى",
    allBrands: "كل العلامات",
    allBranches: "كل الفروع",
    allItems: "كل الأصناف",
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
    // كل تسمية مالية تذكر أساسها الضريبي صراحةً: البيان لا يجمع رقمين على
    // أساسين مختلفين، والقارئ يجب أن يرى الأساس دون فتح الشيفرة.
    // gross_product_sales هو مجموع d.gross_amount = الصافي + الضريبة بعد الخصم،
    // أي المبلغ المفوتر فعليًا — لا «قبل الخصم» ولا «قبل الضريبة».
    gross_product_sales: "المُفوتر على العملاء (شامل الضريبة)",
    discounts_total: "الخصومات الممنوحة (شاملة الضريبة)",
    discounts_line: "خصم الصنف (شامل الضريبة)",
    returns_net: "المرتجعات (دون الضريبة)",
    returns_vat: "ضريبة القيمة المضافة على المرتجعات",
    returns_cogs: "تكلفة المرتجعات",
    net_ex_vat: "صافي المبيعات دون الضريبة (بعد الخصم)",
    vat_amount: "ضريبة القيمة المضافة على المبيعات",
    invoice_total: "إجمالي الفواتير كما صدرت (شامل الضريبة)",
    orders: "عدد الطلبات",
    guests: "عدد الضيوف",
    discounted_orders: "الطلبات المخصومة",
    qty_sold: "الكمية المباعة",
    qty_returned: "الكمية المرتجعة",
    voids_count: "عدد الطلبات الملغاة",
    voids_value: "قيمة الطلبات الملغاة",
    returns_count: "عدد المرتجعات",
    returns_value: "المرتجعات (شاملة الضريبة)",
    cogs: "تكلفة البضاعة المباعة",
    uncosted_net: "إيراد بلا تكلفة مُعرَّفة",
    payments_in: "المقبوضات",
    refunds_out: "المبالغ المستردّة",
    tips_total: "إجمالي الإكراميات",
    fees_total: "رسوم مسجّلة خارج إجمالي الفاتورة",
    rounding_total: "فروق التقريب (خارج إجمالي الفاتورة)",
    till_expected_cash: "النقد المتوقع في الصندوق",
    till_counted: "النقد المعدود",
    modifier_lines: "أسطر الإضافات",
    modifier_qty: "كمية الإضافات",
    budget_amount: "مبلغ الموازنة",
    net_incl_vat: "صافي المبيعات شامل الضريبة",
    sales_before_discount: "المبيعات قبل الخصم (شاملة الضريبة)",
    net_product_sales: "صافي المبيعات بعد المرتجعات (شامل الضريبة)",
    net_product_sales_ex_vat: "صافي المبيعات بعد المرتجعات (دون الضريبة)",
    statement_variance: "فرق ترويسات الفواتير عن أسطرها",
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
    // UI-only key (NOT an equation key — carved out of the registry parity test):
    // the accessible label of the "why is this number?" info trigger.
    trigger: "لماذا هذا الرقم؟",
    sum: "مجموع القيم المخزّنة مباشرةً ضمن الفترة والفلاتر المحددة.",
    count: "عدد السجلات المطابقة ضمن الفترة والفلاتر المحددة.",
    grossProductSales: "مجموع مبالغ أسطر الفاتورة (الصافي + الضريبة) بعد الخصم — أي المبلغ المفوتر على العميل، شاملًا الضريبة.",
    invoiceTotal: "مجموع إجمالي الفواتير كما صدرت (شامل الضريبة، ولا يشمل الرسوم ولا التقريب).",
    expectedCash: "رصيد الافتتاح + المبيعات النقدية + الإيداعات − المصروفات − الاستردادات النقدية.",
    netInclVat: "صافي المبيعات دون الضريبة + مبلغ ضريبة القيمة المضافة.",
    salesBeforeDiscount: "المُفوتر شامل الضريبة + الخصومات الممنوحة — الخصم مسجّل شاملًا الضريبة فقط، فتُعاد إضافته في المساحة نفسها دون قسمته على نسبة الضريبة.",
    netSalesInclVat: "المُفوتر شامل الضريبة − المرتجعات شاملة الضريبة.",
    netSalesExVat: "صافي المبيعات دون الضريبة − المرتجعات دون الضريبة.",
    statementVariance: "إجمالي ترويسات الفواتير − مجموع أسطرها. يساوي صفرًا متى تم ترحيل الأسطر، ويظهر غير ذلك إذا وُجدت فاتورة بلا أسطر.",
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
    sort: "الترتيب",
    schedule: "جدولة التقرير",
    showChart: "عرض الرسم البياني",
  },

  pivot: {
    expand: "توسيع المجموعة",
    collapse: "طي المجموعة",
  },

  charts: {
    showTable: "عرض الجدول",
    empty: "لا توجد بيانات للرسم ضمن الفترة والفلاتر المحددة",
  },

  explorer: {
    primaryDim: "البُعد الأساسي",
    secondaryDim: "البُعد الثانوي",
    top: "الأعلى",
    bottom: "الأدنى",
    topN: "عدد النتائج",
  },

  groupBy: {
    label: "التجميع حسب",
    pickFirst: "اختر بُعد التجميع",
    pickNext: "أضف مستوى تجميع",
    kinds: {
      time: "الزمن",
      scope: "النطاق",
      attribute: "الخصائص",
      employee: "الموظفون",
      constant: "ثابت",
    },
    noSource: "لا يوجد مصدر بيانات لهذا البُعد بعد",
    blockedBy: "غير متاح مع:",
    alreadyUsed: "مستخدَم في مستوى آخر",
    droppedNotice: "أُسقطت مستويات تجميع لا تدعمها المقاييس المختارة: {dims}",
    grandTotal: "الإجمالي العام",
    grandTotalNote: "الإجمالي العام محسوب على كامل الفترة، لا على الصفوف الظاهرة فقط",
  },

  orders: {
    colInvoice: "رقم الفاتورة",
  },

  itemSales: {
    costUndefined: "تكلفة غير مُعرَّفة",
    costUndefinedHint:
      "لا توجد وصفة ولا تكلفة يدوية لهذا الصنف، فلم تُسجَّل له تكلفة وقت البيع — عرض التكلفة صفرًا كان سيُظهر هامشًا 100%.",
    costUndefinedCount: "{count} من الأسطر بلا تكلفة مُعرَّفة — حُجبت التكلفة والربح والهامش لها",
    rowLimit: "يعرض هذا التقرير أول {count} سطر فقط — ضيّق الفترة أو الفلاتر لرؤية الباقي",
  },

  profitability: {
    quadrants: {
      stars: "النجوم",
      plowhorses: "الأحصنة العاملة",
      puzzles: "الألغاز",
      dogs: "الأصناف الراكدة",
    },
    uncostedItems:
      "{count} من الأصناف بلا تكلفة مُعرَّفة — استُثنيت من التصنيف ومن حساب الوسيط، والأرقام أعلاه تزيد عن الحقيقة بمقدار تكلفتها",
  },

  reconciliation: {
    exceptionDays: "أيام الاستثناء",
    salesVsPayments: "المبيعات مقابل التحصيل",
    cashExpectedVsCounted: "العهدة (المتوقّع − المعدود)",
    exceptionsTitle: "الاستثناءات",
    ordersWithoutPayment: "طلبات بلا دفعة",
    paymentsWithoutOrder: "مدفوعات بلا طلب",
    moreIds: "+{count} أخرى",
  },

  discounts: {
    reasonGap: "سبب الخصم غير مسجَّل في مخزن الحقائق بعد",
  },

  saved: {
    title: "التقارير المحفوظة",
    tabViews: "التقارير المحفوظة",
    tabSchedules: "الجداول الزمنية",
    open: "فتح",
    sourceLocal: "جهاز",
    sourceServer: "خادم",
    saveName: "اسم العرض",
    savePrompt: "حفظ العرض الحالي",
  },

  exportMenu: {
    csv: "تصدير CSV",
    xlsx: "تصدير XLSX",
    queued: "التصدير في قائمة الانتظار",
    ready: "التصدير جاهز للتنزيل",
    failed: "تعذّر إنشاء التصدير",
    download: "تنزيل التصدير",
    // Header of the display-name column the export adds next to a dimension's
    // id column (menu_item → "الصنف", menu_item_label → "اسم الصنف").
    nameColumn: "اسم {name}",
  },

  schedules: {
    name: "اسم الجدولة",
    freq: "التكرار",
    daily: "يوميًا",
    weekly: "أسبوعيًا",
    monthly: "شهريًا",
    atTime: "وقت التنفيذ",
    weekday: "يوم الأسبوع",
    monthDay: "يوم الشهر",
    timezone: "المنطقة الزمنية",
    active: "مفعّلة",
    create: "جدولة جديدة",
    edit: "تعديل الجدولة",
    deleteConfirm: "هل تريد حذف هذه الجدولة؟",
  },
} as const;
