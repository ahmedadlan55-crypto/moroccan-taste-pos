// تقارير الموظفين والتشغيل — الفئات وأسماء التقارير وعناوين الأعمدة والمرشّحات.
// المرآة الإنجليزية: frontend/erp/src/i18n/dictionaries/en/operationalReports.ts
//
// حالات الموظفين وأسماء الأشهر لا تتكرر هنا: تُقرأ من people.status.*
// و people.payroll.months.* لأنها موجودة أصلًا ومصدرها واحد.
export const operationalReports = {
  backToDirectory: "الرجوع إلى دليل التقارير",
  print: "طباعة",
  run: "عرض التقرير",

  unknown: {
    title: "تقرير غير معروف",
    body: "الرابط لا يشير إلى تقرير في هذا الدليل.",
  },
  empty: {
    title: "لا توجد بيانات للفترة المحددة",
    body: "غيّر الفترة أو المرشّحات ثم اعرض التقرير مرة أخرى.",
  },

  groups: {
    payroll: {
      title: "الرواتب والاستحقاقات",
      description: "كشوف الرواتب وهيكل الأجور والسلف.",
    },
    timeAttendance: {
      title: "الحضور والإجازات",
      description: "أيام الحضور والغياب والتأخير وسجل الإجازات.",
    },
    custody: {
      title: "العهد",
      description: "أرصدة العهد المفتوحة وحركتها.",
    },
    posControl: {
      title: "رقابة نقاط البيع",
      description: "إغلاق الورديات وفروقات النقد والشبكة.",
    },
    governance: {
      title: "الرقابة والحوكمة",
      description: "إجراءات المستخدمين ومسار المعاملات.",
    },
  },

  reports: {
    payrollRegister: {
      label: "كشف رواتب الفترة",
      description: "استحقاقات وخصومات وصافي كل موظف في مسيّر رواتب محدد.",
    },
    wageStructure: {
      label: "هيكل الأجور الشهري",
      description: "الأساسي والبدلات وإجمالي الأجر الشهري لكل موظف حسب الإدارة والفرع.",
    },
    staffAdvances: {
      label: "سلف الموظفين وأرصدتها",
      description: "قيمة كل سلفة والمسدَّد منها والمتبقي والقسط الشهري.",
    },
    attendanceSummary: {
      label: "ملخّص الحضور والغياب",
      description: "أيام الحضور والغياب والتأخير والعمل الإضافي لكل موظف خلال شهر.",
    },
    leaveRegister: {
      label: "سجل الإجازات",
      description: "طلبات الإجازات ونوعها ومدّتها وحالتها ومن اعتمدها.",
    },
    openCustody: {
      label: "العهد القائمة وأرصدتها",
      description: "إجمالي التغذية والمصروف والرصيد المتبقي لكل عهدة.",
    },
    shiftVariance: {
      label: "الورديات والفروقات النقدية",
      description: "المتوقع مقابل المُستلَم فعليًا نقدًا وشبكة لكل وردية وفرق الإغلاق.",
    },
    userActions: {
      label: "سجل إجراءات المستخدمين",
      description: "من نفّذ أي إجراء وعلى أي سجل ومتى ومن أي عنوان.",
    },
    transactionLog: {
      label: "سجل المعاملات والمتأخر منها",
      description: "المعاملات المُنشأة في الفترة وحالتها والمسؤول عنها وما تجاوز تاريخ استحقاقه.",
    },
  },

  filter: {
    from: "من تاريخ",
    to: "إلى تاريخ",
    month: "الشهر",
    year: "السنة",
    status: "الحالة",
    payrollRun: "مسيّر الرواتب",
    employmentStatus: "حالة الموظف",
    invalidRange: "تاريخ البداية يجب ألا يكون بعد تاريخ النهاية.",
  },

  total: {
    employees: "عدد الموظفين",
    gross: "إجمالي الاستحقاق",
    deductions: "إجمالي الخصومات",
    net: "صافي المستحق",
  },

  col: {
    employeeNumber: "الرقم الوظيفي",
    employeeName: "الموظف",
    department: "الإدارة",
    branch: "الفرع",
    jobTitle: "المسمى الوظيفي",
    basicSalary: "الراتب الأساسي",
    housingAllowance: "بدل السكن",
    transportAllowance: "بدل النقل",
    otherAllowance: "بدلات أخرى",
    totalAllowances: "إجمالي البدلات",
    overtimeAmount: "قيمة العمل الإضافي",
    grossSalary: "إجمالي الاستحقاق",
    absenceDeduction: "خصم الغياب",
    lateDeduction: "خصم التأخير",
    advanceDeduction: "خصم السلف",
    otherDeduction: "خصومات أخرى",
    totalDeductions: "إجمالي الخصومات",
    netSalary: "صافي المستحق",
    actualDays: "أيام العمل",
    absentDays: "أيام الغياب",
    leaveDays: "أيام الإجازة",
    workingDays: "أيام العمل بالشهر",
    presentDays: "أيام الحضور",
    lateDays: "أيام التأخير",
    lateMinutes: "دقائق التأخير",
    overtimeMinutes: "دقائق العمل الإضافي",
    leaveType: "نوع الإجازة",
    startDate: "من تاريخ",
    endDate: "إلى تاريخ",
    days: "عدد الأيام",
    status: "الحالة",
    approvedBy: "اعتمدها",
    requestDate: "تاريخ الطلب",
    advanceAmount: "قيمة السلفة",
    advancePaid: "المسدَّد",
    advanceRemaining: "المتبقي",
    monthlyDeduction: "القسط الشهري",
    deductionMonths: "عدد الأقساط",
    custodyNumber: "رقم العهدة",
    custodian: "أمين العهدة",
    openedOn: "تاريخ الفتح",
    topups: "إجمالي التغذية",
    spent: "إجمالي المصروف",
    balance: "الرصيد",
    cashier: "الكاشير",
    shiftStart: "بداية الوردية",
    shiftEnd: "نهاية الوردية",
    openingFloat: "الرصيد الافتتاحي",
    expectedCash: "النقد المتوقع",
    actualCash: "النقد المستلم",
    cashVariance: "فرق النقد",
    expectedCard: "الشبكة المتوقعة",
    actualCard: "الشبكة المستلمة",
    cardVariance: "فرق الشبكة",
    totalVariance: "إجمالي الفرق",
    at: "التاريخ والوقت",
    user: "المستخدم",
    action: "الإجراء",
    entity: "نوع السجل",
    reference: "المرجع",
    details: "التفاصيل",
    ip: "عنوان الشبكة",
    txnNumber: "رقم المعاملة",
    txnType: "نوع المعاملة",
    subject: "الموضوع",
    createdBy: "المُنشئ",
    assignee: "لدى",
    importance: "الأهمية",
    createdAt: "تاريخ الإنشاء",
    dueDate: "تاريخ الاستحقاق",
    overdue: "متأخرة",
  },

  txnStatus: {
    draft: "مسودة",
    pending: "قيد الاعتماد",
    in_progress: "قيد التنفيذ",
    approved: "معتمدة",
    rejected: "مرفوضة",
    completed: "منجزة",
    cancelled: "ملغاة",
  },

  importance: {
    critical: "حرجة",
    high: "عالية",
    medium: "متوسطة",
    low: "منخفضة",
  },
} as const;
