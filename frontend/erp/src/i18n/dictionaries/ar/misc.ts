/** "misc" namespace — the Reports center (modules/reports) and the Customers
 *  domain (modules/customers). Two sub-objects: reports.* and customers.*.
 *  English mirror: en/misc.ts (identical key shape). Business DATA (customer
 *  name_ar/name_en, phone, VAT number, account codes, statement refs) is NOT
 *  here — only chrome/copy. Record-status text reuses status.*; generic verbs
 *  reuse common.*; page states reuse states.*. */
export const misc = {
  reports: {
    // Shared eyebrow for every /reports/* hub page + the Saved Reports page.
    eyebrow: "التقارير",
    // Shown when a hub section has no destination links yet.
    emptyTitle: "لا توجد تقارير في هذا القسم بعد",
    // Section headings — one per /reports/* manifest path (see reportLinks.tsx).
    // (No `sales` section: /reports/sales/* is the Sales Analytics Hub.)
    sections: {
      inventory: {
        title: "تقارير المخزون",
        subtitle: "الأرصدة والحركات والجرد والصلاحية.",
      },
      purchasing: {
        title: "تقارير المشتريات",
        subtitle: "أوامر الشراء وفواتير الموردين والمدفوعات.",
      },
      financial: {
        title: "التقارير المالية",
        subtitle: "القوائم المالية وأعمار الذمم — تُدار ضمن وحدة المحاسبة.",
      },
      people: {
        title: "تقارير الموظفين",
        subtitle: "الموظفون والحضور والرواتب والإجازات.",
      },
      operations: {
        title: "تقارير التشغيل",
        subtitle: "الورديات ونقاط البيع وسجل الإجراءات.",
      },
    },
    // Card links inside the hub sections — each maps to a canonical report route.
    links: {
      invBalances: { label: "الأرصدة", description: "أرصدة الأصناف في المستودعات." },
      invTransfers: { label: "التحويلات", description: "حركة الأصناف بين المستودعات." },
      invStocktakes: { label: "الجرد", description: "فروقات الجرد وتسوياتها." },
      invLotsExpiry: { label: "الصلاحية", description: "التشغيلات القريبة من الانتهاء." },
      invReplenishment: { label: "إعادة الطلب", description: "الأصناف تحت حد الطلب." },
      purOrders: { label: "أوامر الشراء", description: "أوامر الشراء وحالتها." },
      purInvoices: { label: "فواتير الموردين", description: "مطالبات الموردين." },
      purPayments: { label: "مدفوعات الموردين", description: "سداد مستحقات الموردين." },
      purReturns: { label: "مرتجعات المشتريات", description: "المرتجعات للموردين." },
      purSuppliers: { label: "الموردون", description: "أداء الموردين وأرصدتهم." },
      glGeneralLedger: { label: "الأستاذ العام", description: "حركة كل حساب." },
      glTrialBalance: { label: "ميزان المراجعة", description: "أرصدة الحسابات." },
      glIncomeStatement: { label: "قائمة الدخل", description: "الإيرادات والمصروفات." },
      glBalanceSheet: { label: "الميزانية", description: "المركز المالي." },
      glCashFlow: { label: "التدفقات النقدية", description: "حركة النقد." },
      glArAging: { label: "أعمار الذمم المدينة", description: "أعمار مديونيات العملاء." },
      glApAging: { label: "أعمار الذمم الدائنة", description: "أعمار مستحقات الموردين." },
      pplEmployees: { label: "الموظفون", description: "بيانات الموظفين." },
      pplAttendance: { label: "الحضور", description: "الحضور والانصراف." },
      pplPayroll: { label: "الرواتب", description: "مسيّرات الرواتب." },
      pplLeaves: { label: "الإجازات", description: "أرصدة وطلبات الإجازات." },
      opsShifts: { label: "الورديات", description: "إغلاق الورديات والفروقات." },
      opsPosReports: { label: "تحليلات الورديات", description: "إجماليات الورديات وفروقاتها في هَب تقارير المبيعات." },
      opsActionLog: { label: "سجل الإجراءات", description: "سجل إجراءات المعاملات." },
      opsInventoryOverview: { label: "نظرة المخزون", description: "مؤشرات المخزون التشغيلية." },
    },
    // Saved Reports page (/reports/saved).
    saved: {
      title: "التقارير المحفوظة",
      subtitle: "طرق العرض التي حفظتها من الجداول عبر النظام.",
      emptyTitle: "لا توجد تقارير محفوظة",
      emptyBody: "احفظ طريقة عرض من أي جدول (زر «{menu}») لتظهر هنا.",
      badge: "عرض محفوظ",
      source: "المصدر",
      deleteView: "حذف {name}",
      // Human labels for the known DataTable ids the saved views come from.
      tableLabels: {
        "admin-companies": "الشركات",
        "admin-brands": "العلامات التجارية",
        "admin-branches": "الفروع",
        "admin-users": "المستخدمون",
        "admin-payment-methods": "طرق الدفع",
        "admin-audit-log": "سجل التدقيق",
        "admin-vat-reports": "إقرارات القيمة المضافة",
      },
    },
  },

  customers: {
    // Shared eyebrow for the list + detail pages.
    eyebrow: "العملاء",
    // Customer-type labels (the stored code B2C/B2B/B2G stays the data value).
    types: { B2C: "أفراد", B2B: "شركات", B2G: "حكومي" },
    list: {
      title: "سجل العملاء",
      subtitle: "بحث وتصفية العملاء وإدارة الحدود الائتمانية.",
      newCustomer: "عميل جديد",
      searchPlaceholder: "ابحث بالاسم أو الهاتف أو الرقم الضريبي…",
      emptyTitle: "لا يوجد عملاء مطابقون",
      emptyBody: "جرّب تعديل البحث أو أضف عميلًا جديدًا.",
      editAria: "تعديل العميل",
      filterByStatus: "تصفية بالحالة",
      filterByType: "تصفية بالنوع",
      filter: {
        active: "النشطون",
        inactive: "المعطّلون",
        allTypes: "كل الأنواع",
      },
      col: {
        name: "العميل",
        phone: "الهاتف",
        type: "النوع",
        creditLimit: "حد الائتمان",
        balance: "الرصيد",
      },
    },
    detail: {
      back: "رجوع للعملاء",
      // {type} is the stored customer-type code (B2C/B2B/B2G).
      eyebrow: "عميل {type}",
      statement: "كشف حساب",
      recordCollection: "تسجيل تحصيل",
      metric: {
        balance: "الرصيد (ذمم)",
        creditLimit: "حد الائتمان",
        exposure: "التعرّض الائتماني",
        utilization: "{pct}% مستخدم",
        available: "المتاح",
      },
      recentInvoices: "الفواتير الأخيرة",
      invCol: {
        invoice: "الفاتورة",
        date: "التاريخ",
        remaining: "المتبقّي",
      },
      agingTitle: "أعمار الذمم (حسب الاستحقاق)",
      aging: { current: "جاري" },
      total: "الإجمالي",
      summary: "ملخص",
      stat: {
        openInvoices: "فواتير مفتوحة",
        openBalance: "رصيد مفتوح",
        collectionsCount: "عدد التحصيلات",
        collectionsTotal: "إجمالي التحصيلات",
        unappliedCredit: "رصيد دائن غير مخصّص",
        paymentTerms: "شروط السداد",
        firstDeal: "أول تعامل",
        lastDeal: "آخر تعامل",
      },
      // {days} is the numeric credit-days count.
      daysValue: "{days} يوم",
      topProducts: "أعلى المنتجات (بعد المرتجعات)",
    },
    statement: {
      // {name} is the customer's (data) name.
      title: "كشف حساب — {name}",
      opening: "الرصيد الافتتاحي",
      closing: "الرصيد الختامي",
      print: "طباعة",
      col: {
        date: "التاريخ",
        ref: "المرجع",
        type: "النوع",
        movement: "الحركة",
        balance: "الرصيد",
      },
      kind: {
        payment: "تحصيل",
        creditNote: "إشعار دائن",
        invoice: "فاتورة",
      },
    },
    form: {
      newEyebrow: "عميل جديد",
      editEyebrow: "تعديل عميل",
      addTitle: "إضافة عميل",
      saveCustomer: "حفظ العميل",
      saveChanges: "حفظ التعديلات",
      selectNone: "بدون",
      section: {
        entity: "المنشأة والتسجيل الضريبي",
        address: "العنوان",
        salesDefaults: "البيانات الافتراضية في المبيعات (اختياري)",
      },
      field: {
        name: "الاسم",
        nameAria: "اسم العميل",
        nameEn: "الاسم بالإنجليزية",
        phone: "الهاتف",
        vatRegistration: "التسجيل في ضريبة القيمة المضافة",
        vatNumber: "الرقم الضريبي",
        city: "المدينة",
        district: "الحي",
        postalCode: "الرمز البريدي",
        street: "الشارع",
        buildingNumber: "رقم المبنى",
        additionalNo: "الرقم الفرعي للعنوان",
        revenueAccount: "حساب الإيرادات الافتراضي",
        revenueCostCenter: "مركز تكلفة الإيرادات الافتراضي",
        email: "البريد الإلكتروني",
        customerType: "نوع العميل",
        creditLimit: "حد الائتمان",
        paymentTerms: "شروط السداد",
        creditDays: "أيام الائتمان",
      },
      vat: {
        registered: "مسجَّل في الضريبة",
        unregistered: "غير مسجَّل",
      },
      type: {
        b2c: "أفراد B2C",
        b2b: "شركات B2B",
        b2g: "حكومي B2G",
      },
      hint: {
        optional: "اختياري",
        creditLimit: "0 = لا يُسمح بالبيع الآجل",
        paymentTerms: "Cash = نقدي فقط",
      },
      validation: {
        nameRequired: "اسم العميل مطلوب",
        vatDigits: "الرقم الضريبي يجب أن يكون 15 رقمًا",
        emailInvalid: "بريد غير صالح",
        notNegative: "لا يمكن أن يكون سالبًا",
      },
    },
  },
} as const;
