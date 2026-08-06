'use strict';

/**
 * Canonical Saudi/IFRS chart used by fresh databases and migration 0036.
 *
 * Numbering is a product governance policy (Saudi regulation does not impose
 * one universal code list): six digits, five statement roots and at most four
 * levels.  Header accounts are never postable.  Operational detail such as
 * item, warehouse, branch, brand and production stage belongs to subledgers
 * and journal dimensions, not to extra GL accounts.
 */

const rows = [];
const add = (code, nameAr, nameEn, type, parentCode, options = {}) => {
  rows.push({
    code, nameAr, nameEn, type, parentCode: parentCode || '',
    kind: options.kind || 'folder',
    reportSection: options.reportSection || null,
    cashFlowActivity: options.cashFlowActivity || null,
    taxNature: options.taxNature || 'none',
    isContra: !!options.isContra,
    isControl: !!options.isControl,
    roles: options.roles || [],
    legacyCodes: options.legacyCodes || [],
  });
};
const F = (code, ar, en, type, parent) => add(code, ar, en, type, parent);
const L = (code, ar, en, type, parent, reportSection, options = {}) => add(
  code, ar, en, type, parent,
  { ...options, kind: 'leaf', reportSection },
);

// 1 — Assets
F('100000', 'الأصول', 'Assets', 'asset');
F('110000', 'الأصول المتداولة', 'Current Assets', 'asset', '100000');
F('111000', 'النقدية وما في حكمها', 'Cash and Cash Equivalents', 'asset', '110000');
L('111100', 'النقدية بالصندوق', 'Cash on Hand', 'asset', '111000', 'cash', {
  roles: ['CASH_ON_HAND'], legacyCodes: ['1110','100101','100102','100103','100104','1101'], cashFlowActivity: 'operating', isControl: true,
});
L('111200', 'الحسابات البنكية', 'Bank Accounts', 'asset', '111000', 'cash', {
  roles: ['BANK'], legacyCodes: ['1120','100105','100106','100107','100108','1102'], cashFlowActivity: 'operating', isControl: true,
});
L('111300', 'مدفوعات إلكترونية تحت التسوية', 'Electronic Payments Clearing', 'asset', '111000', 'cash', {
  roles: ['PAYMENT_CLEARING'], legacyCodes: ['100109','100110','100111'], cashFlowActivity: 'operating', isControl: true,
});
F('112000', 'الذمم المدينة والسلف', 'Receivables and Advances', 'asset', '110000');
L('112100', 'ذمم العملاء', 'Trade Receivables', 'asset', '112000', 'receivables', {
  roles: ['ACCOUNTS_RECEIVABLE'], legacyCodes: ['1150','100211'], cashFlowActivity: 'operating', isControl: true,
});
L('112200', 'ذمم منصات التوصيل', 'Delivery Platform Receivables', 'asset', '112000', 'receivables', {
  legacyCodes: ['100221','100222','100223','100224','100225'], cashFlowActivity: 'operating', isControl: true,
});
L('112300', 'سلف الموظفين والعهد', 'Employee Advances and Custody', 'asset', '112000', 'receivables', {
  roles: ['EMPLOYEE_ADVANCES'], legacyCodes: ['1130','100231','100232','100233'], cashFlowActivity: 'operating', isControl: true,
});
L('112400', 'دفعات مقدمة للموردين', 'Supplier Advances', 'asset', '112000', 'receivables', {
  roles: ['SUPPLIER_ADVANCES'], legacyCodes: ['100234'], cashFlowActivity: 'operating', isControl: true,
});
L('112900', 'ذمم مدينة أخرى', 'Other Receivables', 'asset', '112000', 'receivables', {
  legacyCodes: ['100240'], cashFlowActivity: 'operating',
});
L('112990', 'مخصص الخسائر الائتمانية المتوقعة', 'Expected Credit Loss Allowance', 'asset', '112000', 'allowance_doubtful', {
  legacyCodes: ['100250'], cashFlowActivity: 'operating', isContra: true,
});
F('113000', 'المخزون', 'Inventory', 'asset', '110000');
L('113100', 'حساب مراقبة المخزون', 'Inventory Control', 'asset', '113000', 'inventory', {
  roles: ['INVENTORY','BRANCH_INVENTORY','WORK_IN_PROGRESS','FINISHED_GOODS'],
  legacyCodes: ['1200','1210','1220','1230'], cashFlowActivity: 'operating', isControl: true,
});
F('114000', 'المصروفات المدفوعة مقدمًا', 'Prepayments', 'asset', '110000');
L('114100', 'مصروفات مدفوعة مقدمًا', 'Prepaid Expenses', 'asset', '114000', 'prepayments', {
  legacyCodes: ['100401','100402','100403','100404'], cashFlowActivity: 'operating', isControl: true,
});
F('115000', 'الضرائب والأرصدة الحكومية المدينة', 'Tax and Government Receivables', 'asset', '110000');
L('115100', 'ضريبة القيمة المضافة المدخلة القابلة للاسترداد', 'Recoverable Input VAT', 'asset', '115000', 'input_vat', {
  roles: ['INPUT_VAT'], legacyCodes: ['1290','100451'], cashFlowActivity: 'operating', taxNature: 'vat_input', isControl: true,
});
L('115200', 'ضريبة قيمة مضافة مستحقة التحصيل', 'VAT Receivable', 'asset', '115000', 'other_current_asset', {
  cashFlowActivity: 'operating', taxNature: 'vat_input', isControl: true,
});
F('119000', 'أصول متداولة أخرى', 'Other Current Assets', 'asset', '110000');
L('119900', 'أصول متداولة أخرى وحساب معلق', 'Other Current Assets and Suspense', 'asset', '119000', 'other_current_asset', {
  roles: ['SUSPENSE'], cashFlowActivity: 'operating', isControl: true,
});
F('120000', 'الأصول غير المتداولة', 'Non-current Assets', 'asset', '100000');
F('121000', 'الممتلكات والآلات والمعدات', 'Property, Plant and Equipment', 'asset', '120000');
L('121100', 'تكلفة الممتلكات والآلات والمعدات', 'PPE at Cost', 'asset', '121000', 'ppe', {
  legacyCodes: ['100501','100502','100503','100504','100505','100506','100507'], cashFlowActivity: 'investing', isControl: true,
});
L('121900', 'مجمع إهلاك الممتلكات والآلات والمعدات', 'Accumulated Depreciation - PPE', 'asset', '121000', 'acc_dep', {
  legacyCodes: ['100601','100602','100603','100604','100605','100606','100607'], cashFlowActivity: 'non_cash', isContra: true,
});
F('122000', 'أصول حق الاستخدام', 'Right-of-use Assets (IFRS 16)', 'asset', '120000');
L('122100', 'أصول حق استخدام العقارات', 'Property Right-of-use Assets', 'asset', '122000', 'rou', {
  legacyCodes: ['100701'], cashFlowActivity: 'non_cash', isControl: true,
});
L('122900', 'مجمع إهلاك أصول حق الاستخدام', 'Accumulated Depreciation - ROU', 'asset', '122000', 'acc_dep', {
  legacyCodes: ['100702'], cashFlowActivity: 'non_cash', isContra: true,
});
F('129000', 'أصول غير متداولة أخرى', 'Other Non-current Assets', 'asset', '120000');
L('129900', 'أصول غير متداولة أخرى', 'Other Non-current Assets', 'asset', '129000', 'intangibles', { cashFlowActivity: 'investing' });

// 2 — Liabilities
F('200000', 'الالتزامات', 'Liabilities', 'liability');
F('210000', 'الالتزامات المتداولة', 'Current Liabilities', 'liability', '200000');
F('211000', 'الموردون والذمم الدائنة', 'Trade and Other Payables', 'liability', '210000');
L('211100', 'ذمم الموردين', 'Accounts Payable', 'liability', '211000', 'payables', {
  roles: ['ACCOUNTS_PAYABLE'], legacyCodes: ['2100','2101','2109','200101','200102','200103','200104','200105','200106'], cashFlowActivity: 'operating', isControl: true,
});
L('211200', 'بضاعة مستلمة غير مفوترة', 'Goods Received Not Invoiced', 'liability', '211000', 'grni', {
  roles: ['GRNI'], legacyCodes: ['2150'], cashFlowActivity: 'operating', isControl: true,
});
F('212000', 'المصروفات والمبالغ المستحقة', 'Accruals and Other Payables', 'liability', '210000');
L('212100', 'رواتب وأجور مستحقة', 'Payroll Payable', 'liability', '212000', 'accrued', {
  roles: ['PAYROLL_PAYABLE'], legacyCodes: ['2201','200201'], cashFlowActivity: 'operating', isControl: true,
});
L('212200', 'منافع مستحقة', 'Utilities Payable', 'liability', '212000', 'accrued', { legacyCodes: ['200202'], cashFlowActivity: 'operating' });
L('212300', 'إيجارات مستحقة', 'Rent Payable', 'liability', '212000', 'accrued', { legacyCodes: ['200203'], cashFlowActivity: 'operating' });
L('212400', 'مستحقات الامتياز', 'Royalty Payable', 'liability', '212000', 'accrued', {
  roles: ['ROYALTY_PAYABLE'], legacyCodes: ['2310'], cashFlowActivity: 'operating', isControl: true,
});
L('212500', 'مستحقات منصات التوصيل', 'Platform Payable', 'liability', '212000', 'accrued', {
  roles: ['PLATFORM_PAYABLE'], legacyCodes: ['2320'], cashFlowActivity: 'operating', isControl: true,
});
L('212900', 'مصروفات ومستحقات أخرى', 'Other Accruals', 'liability', '212000', 'accrued', { legacyCodes: ['200204'], cashFlowActivity: 'operating' });
F('213000', 'الضرائب والاستحقاقات الحكومية', 'Taxes and Government Dues', 'liability', '210000');
L('213100', 'ضريبة القيمة المضافة على المخرجات', 'Output VAT', 'liability', '213000', 'output_vat', {
  roles: ['OUTPUT_VAT'], legacyCodes: ['2210','200301'], cashFlowActivity: 'operating', taxNature: 'vat_output', isControl: true,
});
L('213200', 'صافي ضريبة القيمة المضافة المستحقة', 'Net VAT Payable', 'liability', '213000', 'net_vat', {
  legacyCodes: ['200302'], cashFlowActivity: 'operating', taxNature: 'vat_output', isControl: true,
});
L('213300', 'التأمينات الاجتماعية المستحقة', 'GOSI Payable', 'liability', '213000', 'gosi', {
  roles: ['GOSI_EMPLOYEE_SHARE'], legacyCodes: ['2202','200303'], cashFlowActivity: 'operating', taxNature: 'gosi', isControl: true,
});
L('213400', 'ضريبة الاستقطاع المستحقة', 'Withholding Tax Payable', 'liability', '213000', 'withholding', {
  legacyCodes: ['200304'], cashFlowActivity: 'operating', taxNature: 'withholding', isControl: true,
});
L('213500', 'الزكاة المستحقة', 'Zakat Payable', 'liability', '213000', 'zakat', {
  roles: ['ZAKAT'], legacyCodes: ['200305'], cashFlowActivity: 'operating', taxNature: 'zakat', isControl: true,
});
F('214000', 'تمويل والتزامات متداولة', 'Current Financing Liabilities', 'liability', '210000');
L('214100', 'الجزء المتداول من التزام الإيجار', 'Current Lease Liability', 'liability', '214000', 'short_term_debt', { legacyCodes: ['200431'], cashFlowActivity: 'financing' });
L('214200', 'قروض قصيرة الأجل', 'Short-term Loans', 'liability', '214000', 'short_term_debt', { legacyCodes: ['200401'], cashFlowActivity: 'financing' });
F('215000', 'دفعات مقدمة من العملاء', 'Customer Advances', 'liability', '210000');
L('215100', 'دفعات مقدمة من العملاء', 'Customer Advances', 'liability', '215000', 'customer_advances', {
  roles: ['CUSTOMER_ADVANCES'], legacyCodes: ['200601'], cashFlowActivity: 'operating', isControl: true,
});
F('219000', 'التزامات متداولة أخرى', 'Other Current Liabilities', 'liability', '210000');
L('219900', 'التزامات متداولة أخرى', 'Other Current Liabilities', 'liability', '219000', 'other_current_liability', { legacyCodes: ['200701'], cashFlowActivity: 'operating' });
F('220000', 'الالتزامات غير المتداولة', 'Non-current Liabilities', 'liability', '200000');
F('221000', 'القروض والتزامات الإيجار طويلة الأجل', 'Long-term Loans and Leases', 'liability', '220000');
L('221100', 'التزام الإيجار طويل الأجل', 'Non-current Lease Liability', 'liability', '221000', 'lease_obligation', { legacyCodes: ['200432'], cashFlowActivity: 'financing' });
L('221200', 'قروض طويلة الأجل', 'Long-term Loans', 'liability', '221000', 'long_term_debt', { legacyCodes: ['200402'], cashFlowActivity: 'financing' });
F('222000', 'منافع الموظفين طويلة الأجل', 'Long-term Employee Benefits', 'liability', '220000');
L('222100', 'مخصص مكافأة نهاية الخدمة', 'End-of-service Benefit Provision', 'liability', '222000', 'eosb', { legacyCodes: ['200501'], cashFlowActivity: 'non_cash', taxNature: 'eosb', isControl: true });
F('229000', 'التزامات غير متداولة أخرى', 'Other Non-current Liabilities', 'liability', '220000');
L('229900', 'التزامات غير متداولة أخرى', 'Other Non-current Liabilities', 'liability', '229000', 'long_term_debt', { cashFlowActivity: 'financing' });

// 3 — Equity
F('300000', 'حقوق الملكية', 'Equity', 'equity');
F('310000', 'رأس المال وحقوق الملاك', 'Capital and Owners Equity', 'equity', '300000');
F('311000', 'رأس المال', 'Capital', 'equity', '310000');
L('311100', 'رأس المال المدفوع', 'Paid-in Capital', 'equity', '311000', 'capital', { legacyCodes: ['300101'], cashFlowActivity: 'financing', isControl: true });
L('311200', 'مساهمات رأسمالية إضافية', 'Additional Paid-in Capital', 'equity', '311000', 'capital', { legacyCodes: ['300102'], cashFlowActivity: 'financing' });
F('312000', 'الأرباح المبقاة', 'Retained Earnings', 'equity', '310000');
L('312100', 'الأرباح المبقاة من سنوات سابقة', 'Retained Earnings - Prior Years', 'equity', '312000', 'retained_earnings', { legacyCodes: ['300201'], cashFlowActivity: 'financing', isControl: true });
F('313000', 'نتيجة الفترة الحالية', 'Current Period Result', 'equity', '310000');
L('313100', 'صافي ربح أو خسارة الفترة', 'Current Period Profit or Loss', 'equity', '313000', 'retained_earnings', { legacyCodes: ['300301'], cashFlowActivity: 'non_cash', isControl: true });
F('314000', 'الاحتياطيات', 'Reserves', 'equity', '310000');
L('314100', 'الاحتياطي النظامي', 'Statutory Reserve', 'equity', '314000', 'reserves', { legacyCodes: ['300401'], cashFlowActivity: 'financing' });
L('314200', 'الاحتياطي العام واحتياطيات أخرى', 'General and Other Reserves', 'equity', '314000', 'reserves', { legacyCodes: ['300402','300403'], cashFlowActivity: 'financing' });
F('315000', 'المسحوبات والتوزيعات', 'Drawings and Distributions', 'equity', '310000');
L('315100', 'مسحوبات الملاك', 'Owner Drawings', 'equity', '315000', 'drawings', { legacyCodes: ['300501'], cashFlowActivity: 'financing', isContra: true });
L('315200', 'توزيعات الأرباح', 'Profit Distributions', 'equity', '315000', 'drawings', { legacyCodes: ['300601'], cashFlowActivity: 'financing', isContra: true });

// 4 — Revenue. Product, channel, branch and cashier analytics are dimensions.
F('400000', 'الإيرادات', 'Revenue', 'revenue');
F('410000', 'إيرادات النشاط', 'Operating Revenue', 'revenue', '400000');
F('411000', 'المبيعات', 'Sales', 'revenue', '410000');
L('411100', 'إيرادات المبيعات', 'Sales Revenue', 'revenue', '411000', 'sales_revenue', {
  roles: ['SALES_REVENUE'], legacyCodes: ['4100','400110','400120','400130','400140','400210','400220','400230','400240','400310','400320','400330','400340'], cashFlowActivity: 'operating', isControl: true,
});
F('412000', 'مقابلات الإيراد', 'Contra Revenue', 'revenue', '410000');
L('412100', 'خصومات المبيعات', 'Sales Discounts', 'revenue', '412000', 'sales_returns', {
  roles: ['SALES_DISCOUNT'], cashFlowActivity: 'operating', isContra: true, isControl: true,
});
L('412200', 'مردودات المبيعات', 'Sales Returns', 'revenue', '412000', 'sales_returns', { cashFlowActivity: 'operating', isContra: true, isControl: true });
F('419000', 'إيرادات أخرى', 'Other Income', 'revenue', '400000');
L('419100', 'أرباح فروقات الجرد', 'Inventory Gains', 'revenue', '419000', 'other_income', {
  roles: ['STOCK_GAIN','INVENTORY_GAIN_LOSS'], legacyCodes: ['4910','400902'], cashFlowActivity: 'operating', isControl: true,
});
L('419200', 'إيرادات جزاءات ومخالفات', 'Penalty Income', 'revenue', '419000', 'other_income', { roles: ['PENALTY_REVENUE'], legacyCodes: ['4201'], cashFlowActivity: 'operating' });
L('419900', 'إيرادات أخرى', 'Other Income', 'revenue', '419000', 'other_income', { legacyCodes: ['400901','400903','400904'], cashFlowActivity: 'operating' });

// 5 — Expenses including cost of sales
F('500000', 'المصروفات', 'Expenses', 'expense');
F('510000', 'تكلفة الإيرادات', 'Cost of Revenue', 'expense', '500000');
F('511000', 'تكلفة المبيعات', 'Cost of Sales', 'expense', '510000');
L('511100', 'تكلفة المبيعات', 'Cost of Sales', 'expense', '511000', 'cogs', {
  roles: ['COGS'], legacyCodes: ['5100','500101','500102','500201','500202','500301','500302'], cashFlowActivity: 'operating', isControl: true,
});
F('512000', 'فروقات وهدر المخزون', 'Inventory Waste and Variances', 'expense', '510000');
L('512100', 'مصروف الهدر والتلف', 'Waste and Spoilage', 'expense', '512000', 'waste', {
  roles: ['WASTE_EXPENSE','WASTE_RAW','WASTE_FINISHED','WASTE_EXPIRED','WASTE_SPILL','WASTE_RETURNS'],
  legacyCodes: ['5200','5121','5122','5123','5124','5125','500103','500203','500303'], cashFlowActivity: 'operating', isControl: true,
});
L('512200', 'فروقات الجرد', 'Stock Variances', 'expense', '512000', 'stock_variance', { roles: ['STOCK_VARIANCE'], legacyCodes: ['5300'], cashFlowActivity: 'operating', isControl: true });
L('512300', 'فروق أسعار المشتريات', 'Purchase Price Variance', 'expense', '512000', 'stock_variance', { roles: ['PPV'], legacyCodes: ['5350'], cashFlowActivity: 'operating', isControl: true });
L('512400', 'فروقات الإنتاج', 'Production Variance', 'expense', '512000', 'stock_variance', { roles: ['PRODUCTION_VARIANCE'], legacyCodes: ['5420'], cashFlowActivity: 'operating', isControl: true });
F('520000', 'تكاليف الموظفين', 'Employee Costs', 'expense', '500000');
F('521000', 'الرواتب والمزايا', 'Payroll and Benefits', 'expense', '520000');
L('521100', 'الرواتب والأجور الأساسية', 'Basic Salaries and Wages', 'expense', '521000', 'payroll', { roles: ['SALARY_EXPENSE'], legacyCodes: ['5301','500401','500402','500403','500404'], cashFlowActivity: 'operating', isControl: true });
L('521200', 'البدلات والحوافز', 'Allowances and Bonuses', 'expense', '521000', 'payroll', { roles: ['ALLOWANCES_EXPENSE'], legacyCodes: ['5302','500405'], cashFlowActivity: 'operating' });
L('521300', 'العمل الإضافي', 'Overtime', 'expense', '521000', 'payroll', { roles: ['OVERTIME_EXPENSE'], legacyCodes: ['5303','500406'], cashFlowActivity: 'operating' });
L('521400', 'حصة المنشأة في التأمينات الاجتماعية', 'Employer GOSI Contribution', 'expense', '521000', 'payroll', { roles: ['GOSI_COMPANY_SHARE'], legacyCodes: ['5304','500407'], cashFlowActivity: 'operating', taxNature: 'gosi' });
L('521500', 'مصروف مكافأة نهاية الخدمة', 'End-of-service Benefit Expense', 'expense', '521000', 'payroll', { legacyCodes: ['500409'], cashFlowActivity: 'non_cash', taxNature: 'eosb' });
L('521900', 'مزايا وتدريب الموظفين', 'Other Employee Benefits and Training', 'expense', '521000', 'payroll', { legacyCodes: ['500408','500410','500411'], cashFlowActivity: 'operating' });
F('530000', 'تكاليف الإشغال والمرافق', 'Occupancy and Utilities', 'expense', '500000');
F('531000', 'الإشغال والتشغيل', 'Occupancy Operations', 'expense', '530000');
L('531100', 'الإيجارات', 'Rent Expense', 'expense', '531000', 'rent_utilities', { legacyCodes: ['500501','500502','500503'], cashFlowActivity: 'operating' });
L('531200', 'المرافق والاتصالات', 'Utilities and Telecom', 'expense', '531000', 'rent_utilities', { legacyCodes: ['500601','500602','500603','500604'], cashFlowActivity: 'operating' });
L('531300', 'الصيانة والإصلاح', 'Maintenance and Repairs', 'expense', '531000', 'rent_utilities', { legacyCodes: ['500801','500802','500803','500804'], cashFlowActivity: 'operating' });
F('540000', 'تكاليف البيع والتوزيع', 'Selling and Distribution Costs', 'expense', '500000');
F('541000', 'العمولات والتسويق', 'Commissions and Marketing', 'expense', '540000');
L('541100', 'عمولات منصات التوصيل', 'Delivery Platform Commissions', 'expense', '541000', 'marketing', { roles: ['PLATFORM_COMMISSION','DELIVERY_COMMISSION'], legacyCodes: ['5500'], cashFlowActivity: 'operating', isControl: true });
L('541200', 'التسويق والإعلان والولاء', 'Marketing, Advertising and Loyalty', 'expense', '541000', 'marketing', { legacyCodes: ['500701','500702','500703','500704','500705'], cashFlowActivity: 'operating' });
L('541300', 'رسوم المدفوعات والبنوك', 'Payment and Bank Fees', 'expense', '541000', 'bank_gov_fees', { legacyCodes: ['501001','501002','501003'], cashFlowActivity: 'operating' });
F('550000', 'تكاليف التشغيل والإنتاج', 'Operations and Production Costs', 'expense', '500000');
F('551000', 'تكاليف التشغيل المحملة', 'Applied Operating Costs', 'expense', '550000');
L('551100', 'العمالة المحملة على الإنتاج', 'Applied Production Labor', 'expense', '551000', 'opex', { roles: ['LABOR_APPLIED'], legacyCodes: ['5400'], cashFlowActivity: 'operating', isContra: true, isControl: true });
L('551200', 'التكاليف غير المباشرة المحملة', 'Applied Production Overhead', 'expense', '551000', 'opex', { roles: ['OVERHEAD_APPLIED'], legacyCodes: ['5410'], cashFlowActivity: 'operating', isContra: true, isControl: true });
L('551300', 'النظافة والمستهلكات التشغيلية', 'Cleaning and Operating Supplies', 'expense', '551000', 'opex', { legacyCodes: ['501301','501302','501303'], cashFlowActivity: 'operating' });
F('560000', 'المصروفات العمومية والإدارية', 'General and Administrative Expenses', 'expense', '500000');
F('561000', 'المصروفات الإدارية', 'Administrative Expenses', 'expense', '560000');
L('561100', 'الأتعاب المهنية', 'Professional Fees', 'expense', '561000', 'opex', { legacyCodes: ['501101','501102','501103'], cashFlowActivity: 'operating' });
L('561200', 'تقنية المعلومات والبرمجيات', 'IT and Software', 'expense', '561000', 'opex', { legacyCodes: ['501201','501202','501203'], cashFlowActivity: 'operating' });
L('561300', 'الرسوم والتراخيص الحكومية', 'Government Fees and Licenses', 'expense', '561000', 'bank_gov_fees', { legacyCodes: ['500901','500902','500903'], cashFlowActivity: 'operating' });
L('561400', 'التأمين', 'Insurance', 'expense', '561000', 'opex', { legacyCodes: ['501401','501402','501403'], cashFlowActivity: 'operating' });
F('570000', 'الإهلاك والإطفاء', 'Depreciation and Amortization', 'expense', '500000');
F('571000', 'الإهلاك والإطفاء', 'Depreciation and Amortization', 'expense', '570000');
L('571100', 'مصروف الإهلاك والإطفاء', 'Depreciation and Amortization Expense', 'expense', '571000', 'depreciation', { legacyCodes: ['501501','501502'], cashFlowActivity: 'non_cash' });
F('580000', 'تكاليف التمويل', 'Finance Costs', 'expense', '500000');
F('581000', 'تكاليف التمويل وفروق العملة', 'Finance Costs and Foreign Exchange', 'expense', '580000');
L('581100', 'فوائد القروض', 'Loan Interest', 'expense', '581000', 'opex', { legacyCodes: ['501601'], cashFlowActivity: 'financing' });
L('581200', 'فوائد التزامات الإيجار', 'Lease Interest (IFRS 16)', 'expense', '581000', 'opex', { legacyCodes: ['501602'], cashFlowActivity: 'financing' });
L('581300', 'خسائر فروق العملة', 'Foreign Exchange Losses', 'expense', '581000', 'opex', { legacyCodes: ['501603'], cashFlowActivity: 'operating' });
F('590000', 'مصروفات أخرى', 'Other Expenses', 'expense', '500000');
L('591100', 'رسوم الامتياز', 'Franchise and Royalty Fees', 'expense', '590000', 'franchise_fees', { roles: ['FRANCHISE_FEE'], legacyCodes: ['6100','501701','501702'], cashFlowActivity: 'operating', isControl: true });
L('592100', 'مصروف الزكاة', 'Zakat Expense', 'expense', '590000', 'bank_gov_fees', { legacyCodes: ['500904'], cashFlowActivity: 'operating', taxNature: 'zakat' });
L('599100', 'فروق التقريب', 'Rounding Differences', 'expense', '590000', 'opex', { roles: ['ROUNDING'], cashFlowActivity: 'operating', isControl: true });
L('599900', 'مصروفات أخرى', 'Other Expenses', 'expense', '590000', 'opex', { roles: ['OTHER_EXPENSE'], legacyCodes: ['501801','501802'], cashFlowActivity: 'operating' });

const byCode = new Map(rows.map((row) => [row.code, row]));
for (const row of rows) {
  let level = 1;
  let cursor = row;
  const seen = new Set([row.code]);
  while (cursor.parentCode) {
    cursor = byCode.get(cursor.parentCode);
    if (!cursor || seen.has(cursor.code)) throw new Error(`Invalid canonical CoA parent chain for ${row.code}`);
    seen.add(cursor.code);
    level += 1;
  }
  row.level = level;
}

const codes = rows.map((row) => row.code);
if (new Set(codes).size !== codes.length) throw new Error('Duplicate canonical CoA code');
if (rows.some((row) => !/^\d{6}$/.test(row.code) || row.level > 4)) throw new Error('Canonical CoA must be six digits and at most four levels');
if (rows.filter((row) => !row.parentCode).length !== 5) throw new Error('Canonical CoA must have exactly five roots');
if (rows.filter((row) => row.reportSection === 'inventory' && row.kind === 'leaf').length !== 1) throw new Error('Canonical CoA must have one inventory posting leaf');

module.exports = Object.freeze(rows.map((row, index) => Object.freeze({ ...row, order: index + 1 })));
