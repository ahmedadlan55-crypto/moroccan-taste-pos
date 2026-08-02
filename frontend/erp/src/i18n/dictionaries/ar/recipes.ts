/**
 * Recipe catalog & recipe detail namespace (/menu/recipes).
 *
 * Everything the two recipe screens render passes through here — INCLUDING the
 * status / product-type / anomaly vocabularies, which arrive from the server as
 * stable English codes (`draft`, `semi_finished`, `ZERO_COST`, …) and must never
 * be printed raw: a code is not a label, and an untranslated code is a bug in
 * English mode just as much as in Arabic.
 *
 * Generic verbs (save/cancel/…) stay in `common.*`; table chrome in `table.*`.
 *
 * English mirror: frontend/erp/src/i18n/dictionaries/en/recipes.ts — identical
 * key-set / leaf-shape (enforced by i18n/__tests__/dictionary.test.ts).
 */
export const recipes = {
  eyebrow: "القوائم والوصفات",

  // ── Screen 1 — catalog ────────────────────────────────────────────────────
  catalog: {
    title: "كتالوج الوصفات",
    subtitle:
      "كل منتج قابل للبيع أو نصف مصنّع أو صنف مخزني — بوصفته أو بدونها. المنتجات بلا وصفة تظهر هنا أولاً لأنها أهم ما يحتاج معالجة.",
    searchPlaceholder: "ابحث بالاسم أو الكود أو الـ SKU…",
    open: "فتح الوصفة",
  },

  kpi: {
    products: "عدد المنتجات",
    productsNote: "ضمن نتائج التصفية الحالية",
    withoutRecipe: "بلا وصفة",
    withoutRecipeNote: "منتجات لم تُبنَ لها وصفة بعد",
    needsReview: "تحتاج مراجعة",
    needsReviewNote: "وصفات مُعلَّمة للمراجعة",
    avgFoodCost: "متوسط تكلفة الطعام",
    avgFoodCostNote: "متوسط نسبة التكلفة إلى سعر البيع",
    costHidden: "غير متاح",
  },

  filter: {
    brand: "العلامة التجارية",
    allBrands: "كل العلامات",
    category: "الفئة",
    allCategories: "كل الفئات",
    productType: "نوع المنتج",
    allTypes: "كل الأنواع",
    status: "حالة الوصفة",
    allStatuses: "كل الحالات",
    anomaly: "تنبيه التكلفة",
    allAnomalies: "كل التنبيهات",
    noRecipe: "بلا وصفة",
    needsReview: "تحتاج مراجعة",
  },

  col: {
    image: "الصورة",
    sku: "الكود / SKU",
    nameAr: "الاسم (عربي)",
    nameEn: "الاسم (إنجليزي)",
    productType: "نوع المنتج",
    brand: "العلامة",
    category: "الفئة",
    status: "حالة الوصفة",
    version: "النسخة",
    yieldQuantity: "كمية الإنتاج",
    unit: "الوحدة",
    unitCost: "تكلفة الوحدة",
    sellingPrice: "سعر البيع",
    foodCostPct: "تكلفة الطعام %",
    marginPct: "الهامش %",
    updatedAt: "آخر تحديث",
  },

  status: {
    none: "بلا وصفة",
    draft: "مسودة",
    active: "نشطة",
    archived: "مؤرشفة",
  },

  type: {
    sold: "منتج للبيع",
    semi_finished: "نصف مصنّع",
    combo: "وجبة مركّبة",
    stock_item: "صنف مخزني",
  },

  anomaly: {
    ZERO_COST: "تكلفة صفرية",
    COMPONENT_WITHOUT_COST: "مكوّن بلا تكلفة",
    COST_EXCEEDS_PRICE: "التكلفة تتجاوز السعر",
    FOOD_COST_HIGH: "تكلفة طعام مرتفعة",
    COST_STALE: "تكلفة قديمة",
  },

  empty: {
    title: "لا توجد منتجات",
    filtered: "لا يوجد منتج يطابق التصفية الحالية — جرّب توسيع البحث.",
    plain: "لم يُسجَّل أي منتج في الكتالوج بعد.",
  },

  noImage: "بلا صورة",
  dash: "—",

  // ── Screen 2 — recipe detail ──────────────────────────────────────────────
  detail: {
    back: "رجوع إلى الكتالوج",
    notFound: "المنتج غير موجود",
    notFoundBody: "تعذّر العثور على هذا المنتج — قد يكون محذوفًا أو الرابط غير صحيح.",

    tabs: {
      overview: "نظرة عامة",
      components: "المكوّنات",
      cost: "التكلفة",
      production: "الإنتاج والهدر",
      availability: "توفّر المستودع",
      whereUsed: "أين يُستخدم",
      versions: "النسخ والتدقيق",
    },

    head: {
      sku: "الكود",
      type: "النوع",
      brand: "العلامة",
      category: "الفئة",
      status: "الحالة",
      version: "النسخة",
      none: "—",
    },

    noRecipe: {
      title: "لا توجد وصفة لهذا المنتج",
      body: "أضف المكوّنات ثم احفظ لإنشاء النسخة الأولى كمسودة.",
      start: "ابدأ وصفة جديدة",
    },

    banner: {
      revisionTitle: "الوصفة النشطة لا تُعدَّل في مكانها",
      revisionBody: "سيؤدي الحفظ إلى إنشاء النسخة {next} كمسودة، وتبقى النسخة {current} نشطة حتى تُفعِّل الجديدة.",
      draftTitle: "أنت تحرّر مسودة",
      draftBody: "التعديلات تُحفَظ على النسخة {current} نفسها ولا تؤثر على الإنتاج حتى تُفعَّل.",
      archivedTitle: "هذه النسخة مؤرشفة",
      archivedBody: "لا يمكن تعديل نسخة مؤرشفة — أنشئ نسخة جديدة عبر «استنساخ».",
      conflictTitle: "تغيّرت الوصفة منذ آخر تحميل",
      conflictBody: "حفظ شخص آخر نسخة أحدث. أعد التحميل ثم أعد تطبيق تعديلك — لن نكتب فوق عمله.",
      immutableTitle: "لا يمكن الحفظ على هذه النسخة",
      immutableBody: "هذه النسخة غير قابلة للتعديل. أعد التحميل أو أنشئ نسخة جديدة عبر «استنساخ».",
      reload: "إعادة التحميل",
      dismiss: "إخفاء",
    },

    actions: {
      save: "حفظ",
      saving: "جارٍ الحفظ…",
      discard: "تراجع عن التغييرات",
      readOnly: "عرض فقط — لا تملك صلاحية تعديل الوصفات",
    },

    dirty: "تغييرات غير محفوظة",

    overview: {
      title: "بيانات الوصفة",
      subtitle: "رأس الوصفة: كمية الإنتاج وفترة السريان والملاحظات.",
      yieldQuantity: "كمية الإنتاج (الدفعة)",
      yieldUnit: "وحدة الإنتاج",
      effectiveFrom: "ساري من",
      effectiveTo: "ساري حتى",
      notes: "ملاحظات",
      notesPlaceholder: "ملاحظات التحضير أو أي قيود تشغيلية…",
      needsReview: "علّم الوصفة للمراجعة",
      needsReviewHint: "لا يمنع الحفظ — يظهر كمؤشّر في الكتالوج فقط.",
      lineCount: "عدد المكوّنات",
      createdBy: "أنشأها",
      updatedBy: "آخر تعديل",
      approvedBy: "اعتمدها",
      at: "بتاريخ",
      unknown: "غير معروف",
      sellingPrice: "سعر البيع",
      productUnit: "وحدة المنتج",
    },

    components: {
      title: "مكوّنات الوصفة",
      subtitle: "كل سطر يستهلك مكوّنًا واحدًا بوحدة مسجّلة — لا وحدات حرّة.",
      add: "إضافة مكوّن",
      addPlaceholder: "ابحث عن مكوّن بالاسم أو الـ SKU أو الباركود…",
      remove: "حذف السطر",
      empty: "لا توجد مكوّنات بعد",
      emptyBody: "أضف مكوّنًا واحدًا على الأقل — لا يمكن حفظ وصفة فارغة.",
      duplicate: "هذا المكوّن مضاف بالفعل في سطر آخر.",
      col: {
        component: "المكوّن",
        nameAr: "الاسم (عربي)",
        nameEn: "الاسم (إنجليزي)",
        enteredUnit: "وحدة الإدخال",
        baseUnit: "الوحدة الأساسية",
        conversion: "معامل التحويل المحفوظ",
        netQuantity: "الكمية الصافية",
        wastePct: "الفقد المتوقّع %",
        grossQuantity: "الكمية الإجمالية",
        unitCost: "تكلفة الوحدة",
        lineCost: "تكلفة السطر",
        availability: "التوفّر",
        actions: "إجراءات",
      },
      unitLabel: "وحدة السطر",
      unitSaved: "الوحدة المحفوظة",
      noUnits: "لا توجد وحدات مسجّلة",
      conversionHint: "لقطة محفوظة وقت الحفظ — إعادة تعريف الوحدة لاحقًا لا تُعيد صياغة هذه الوصفة.",
      wasteHint: "الفقد المتوقّع جزء من الوصفة نفسها ويدخل في التكلفة المعيارية.",
      wasteVsScrap: "هذا ليس هدر الإنتاج الفعلي — الهدر الفعلي يُسجَّل على أمر الإنتاج ويُقارَن بهذه النسبة.",
      availabilityHint: "من تبويب توفّر المستودع",
      availabilityUnknown: "غير محسوب",
      costHidden: "التكلفة مخفيّة",
    },

    cost: {
      title: "تكلفة الوصفة",
      subtitle: "محسوبة من تكاليف المكوّنات وقت العرض — لا تُؤخذ أي تكلفة من المتصفح.",
      batchCost: "تكلفة الدفعة",
      unitCost: "تكلفة الوحدة",
      sellingPrice: "سعر البيع",
      foodCostPct: "تكلفة الطعام %",
      marginPct: "الهامش %",
      computedAt: "آخر احتساب",
      anomalies: "تنبيهات التكلفة",
      noAnomalies: "لا توجد تنبيهات على هذه الوصفة.",
      hidden: "التكلفة غير متاحة لك",
      hiddenBody: "أرقام التكلفة والهامش مخفيّة لأن صلاحيتك لا تشملها — لم تُستبدل بأصفار.",
      noRecipe: "لا توجد وصفة لاحتساب تكلفتها بعد.",
    },

    production: {
      title: "الإنتاج والهدر",
      subtitle: "ما تُنتجه الوصفة، وأين يُستهلك المخزون، والفرق بين الفقد المتوقّع والهدر الفعلي.",
      expectedLoss: "الفقد المتوقّع (داخل الوصفة)",
      expectedLossBody:
        "نسبة تُضاف على الكمية الصافية لكل مكوّن فتصبح الكمية الإجمالية المصروفة. هي جزء من التكلفة المعيارية ويحدّدها مصمّم الوصفة.",
      actualScrap: "الهدر الفعلي (على أمر الإنتاج)",
      actualScrapBody:
        "يُسجَّل عند التنفيذ لكل أمر إنتاج على حدة، ويُقارَن بالفقد المتوقّع لقياس الانحراف. لا يُعدَّل من هذه الشاشة ولا يغيّر الوصفة.",
      totalExpectedLoss: "إجمالي الفقد المتوقّع",
      consumptionWarehouse: "مستودع الاستهلاك",
      consumptionWarehouseHint: "المستودع الافتراضي الذي تُصرف منه المكوّنات.",
      defaultWarehouse: "بدون تحديد",
      outputs: "مخرجات الإنتاج",
      outputsHint: "المخرج الرئيسي مشتقّ من كمية الإنتاج ما لم تُعرّف مخرجات مشتركة.",
      noOutputs: "لا توجد مخرجات إضافية — المخرج الرئيسي فقط.",
      outputType: "نوع المخرج",
      outputProduct: "المنتج",
      outputQty: "الكمية",
      allocMethod: "أسلوب توزيع التكلفة",
      warehouse: "المستودع",
      requiresLot: "يتطلب تشغيلة",
      yes: "نعم",
      no: "لا",
    },

    outputType: {
      primary: "مخرج رئيسي",
      co_product: "منتج مشترك",
      by_product: "منتج ثانوي",
      rework: "إعادة تشغيل",
      scrap: "هالك",
    },

    allocMethod: {
      fixed_pct: "نسبة ثابتة",
      standard_cost: "التكلفة المعيارية",
      weight: "الوزن",
      nrv: "صافي القيمة البيعية",
    },

    availability: {
      title: "توفّر المستودع",
      subtitle: "كم دفعة يسمح بها المخزون الحالي، وأي مكوّن هو القيد.",
      warehouse: "المستودع",
      globalStock: "المخزون الإجمالي (كل المستودعات)",
      batches: "عدد الدفعات",
      makeableBatches: "دفعات ممكنة",
      makeableQuantity: "الكمية الممكنة",
      shortages: "مكوّنات ناقصة",
      allAvailable: "كل المكوّنات متوفّرة",
      col: {
        item: "المكوّن",
        nameEn: "الاسم (إنجليزي)",
        unit: "الوحدة",
        required: "المطلوب",
        available: "المتاح",
        delta: "الفرق",
        status: "الحالة",
      },
      ok: "متوفّر",
      short: "ناقص",
      needRecipe: "احفظ الوصفة أولاً لحساب التوفّر.",
      empty: "لا توجد مكوّنات لحساب توفّرها.",
    },

    whereUsed: {
      title: "أين يُستخدم المكوّن",
      subtitle: "اختر مكوّنًا من الوصفة لعرض كل الوصفات التي تستهلكه — نطاق أثر أي تغيير عليه.",
      pick: "المكوّن",
      pickPlaceholder: "اختر مكوّنًا…",
      activeCount: "وصفات نشطة",
      totalCount: "إجمالي الاستخدامات",
      empty: "لا تستخدم أي وصفة أخرى هذا المكوّن.",
      needComponent: "أضف مكوّنًا إلى الوصفة أولاً.",
      col: {
        product: "المنتج",
        nameEn: "الاسم (إنجليزي)",
        version: "النسخة",
        status: "الحالة",
        quantity: "الكمية",
        wastePct: "الفقد %",
        unit: "الوحدة",
        origin: "المصدر",
      },
      origin: {
        bom: "وصفة",
        legacy_recipe: "وصفة قديمة",
      },
      statusLegacy: "قديمة",
    },

    versions: {
      title: "النسخ والتدقيق",
      subtitle: "كل نسخة محفوظة مع من أنشأها ومن اعتمدها. لا تُحذف نسخة أبدًا — تُؤرشف.",
      col: {
        version: "النسخة",
        status: "الحالة",
        yield: "كمية الإنتاج",
        effectiveFrom: "ساري من",
        updatedAt: "آخر تحديث",
        updatedBy: "آخر تعديل بواسطة",
        approvedBy: "اعتمدها",
        unitCost: "تكلفة الوحدة",
        actions: "إجراءات",
      },
      empty: "لا توجد نسخ محفوظة بعد.",
      activate: "تفعيل",
      clone: "استنساخ",
      archive: "أرشفة",
      confirmActivate: "تفعيل هذه النسخة سيؤرشف النسخة النشطة الحالية. المتابعة؟",
      confirmArchive: "أرشفة هذه النسخة تُخرجها من الاستخدام دون حذف سجلّها. المتابعة؟",
      compare: {
        title: "مقارنة نسختين",
        subtitle: "فرق حقيقي بين نسختين، لا جدولان متجاوران.",
        a: "النسخة (أ)",
        b: "النسخة (ب)",
        pick: "اختر نسخة…",
        run: "قارن",
        needTwo: "اختر نسختين مختلفتين للمقارنة.",
        added: "مُضاف",
        removed: "محذوف",
        modified: "معدّل",
        unchanged: "دون تغيير",
        change: "التغيير",
        component: "المكوّن",
        before: "قبل",
        after: "بعد",
        quantity: "الكمية",
        wastePct: "الفقد %",
        costDeltaBatch: "فرق تكلفة الدفعة",
        costDeltaUnit: "فرق تكلفة الوحدة",
        yieldChanged: "تغيّرت كمية الإنتاج",
        unitChanged: "تغيّرت وحدة الإنتاج",
        noChange: "لا فرق بين النسختين.",
      },
    },

    toast: {
      savedDraft: "حُفظت الوصفة كمسودة",
      savedRevision: "أُنشئت النسخة {version} كمسودة",
      savedEdit: "حُفظت التعديلات",
      activated: "فُعِّلت النسخة",
      cloned: "أُنشئت نسخة جديدة كمسودة",
      archived: "أُرشفت النسخة",
      failed: "تعذّر إتمام العملية",
      needLines: "أضف مكوّنًا واحدًا على الأقل قبل الحفظ",
      needYield: "كمية الإنتاج يجب أن تكون أكبر من صفر",
    },
  },
} as const;
