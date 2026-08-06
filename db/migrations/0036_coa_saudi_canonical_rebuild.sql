-- 0036_coa_saudi_canonical_rebuild.sql
-- Replace the active presentation chart with one governed Saudi/IFRS chart.
-- Historical journals are immutable.  Every non-zero balance on a retired
-- account is moved by one balanced, auditable transition journal; the old
-- row is archived and remains available in historical drill-downs.
--
-- The chart has five roots, six-digit codes, four levels maximum and one
-- Inventory Control account. Item/warehouse/branch/brand/stage detail stays
-- in operational subledgers and journal dimensions.

SET @coa36_company = COALESCE(
  (SELECT id FROM companies ORDER BY (id='CO-MAIN') DESC,id LIMIT 1),
  'CO-MAIN'
);

CREATE TABLE IF NOT EXISTS coa_0036_canonical_source (
  code VARCHAR(20) NOT NULL PRIMARY KEY,name_ar VARCHAR(200) NOT NULL,name_en VARCHAR(200) NOT NULL,
  account_type ENUM('asset','liability','equity','revenue','expense') NOT NULL,parent_code VARCHAR(20) NULL,
  level_no INT NOT NULL,account_kind ENUM('folder','leaf') NOT NULL,report_section VARCHAR(40) NULL,
  cash_flow_activity ENUM('operating','investing','financing','non_cash') NULL,tax_nature VARCHAR(20) NOT NULL,
  is_contra TINYINT(1) NOT NULL DEFAULT 0,is_control TINYINT(1) NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO coa_0036_canonical_source
  (code,name_ar,name_en,account_type,parent_code,level_no,account_kind,report_section,cash_flow_activity,tax_nature,is_contra,is_control) VALUES
  ('100000','الأصول','Assets','asset',NULL,1,'folder',NULL,NULL,'none',0,0),
  ('110000','الأصول المتداولة','Current Assets','asset','100000',2,'folder',NULL,NULL,'none',0,0),
  ('111000','النقدية وما في حكمها','Cash and Cash Equivalents','asset','110000',3,'folder',NULL,NULL,'none',0,0),
  ('111100','النقدية بالصندوق','Cash on Hand','asset','111000',4,'leaf','cash','operating','none',0,1),
  ('111200','الحسابات البنكية','Bank Accounts','asset','111000',4,'leaf','cash','operating','none',0,1),
  ('111300','مدفوعات إلكترونية تحت التسوية','Electronic Payments Clearing','asset','111000',4,'leaf','cash','operating','none',0,1),
  ('112000','الذمم المدينة والسلف','Receivables and Advances','asset','110000',3,'folder',NULL,NULL,'none',0,0),
  ('112100','ذمم العملاء','Trade Receivables','asset','112000',4,'leaf','receivables','operating','none',0,1),
  ('112200','ذمم منصات التوصيل','Delivery Platform Receivables','asset','112000',4,'leaf','receivables','operating','none',0,1),
  ('112300','سلف الموظفين والعهد','Employee Advances and Custody','asset','112000',4,'leaf','receivables','operating','none',0,1),
  ('112400','دفعات مقدمة للموردين','Supplier Advances','asset','112000',4,'leaf','receivables','operating','none',0,1),
  ('112900','ذمم مدينة أخرى','Other Receivables','asset','112000',4,'leaf','receivables','operating','none',0,0),
  ('112990','مخصص الخسائر الائتمانية المتوقعة','Expected Credit Loss Allowance','asset','112000',4,'leaf','allowance_doubtful','operating','none',1,0),
  ('113000','المخزون','Inventory','asset','110000',3,'folder',NULL,NULL,'none',0,0),
  ('113100','حساب مراقبة المخزون','Inventory Control','asset','113000',4,'leaf','inventory','operating','none',0,1),
  ('114000','المصروفات المدفوعة مقدمًا','Prepayments','asset','110000',3,'folder',NULL,NULL,'none',0,0),
  ('114100','مصروفات مدفوعة مقدمًا','Prepaid Expenses','asset','114000',4,'leaf','prepayments','operating','none',0,1),
  ('115000','الضرائب والأرصدة الحكومية المدينة','Tax and Government Receivables','asset','110000',3,'folder',NULL,NULL,'none',0,0),
  ('115100','ضريبة القيمة المضافة المدخلة القابلة للاسترداد','Recoverable Input VAT','asset','115000',4,'leaf','input_vat','operating','vat_input',0,1),
  ('115200','ضريبة قيمة مضافة مستحقة التحصيل','VAT Receivable','asset','115000',4,'leaf','other_current_asset','operating','vat_input',0,1),
  ('119000','أصول متداولة أخرى','Other Current Assets','asset','110000',3,'folder',NULL,NULL,'none',0,0),
  ('119900','أصول متداولة أخرى وحساب معلق','Other Current Assets and Suspense','asset','119000',4,'leaf','other_current_asset','operating','none',0,1),
  ('120000','الأصول غير المتداولة','Non-current Assets','asset','100000',2,'folder',NULL,NULL,'none',0,0),
  ('121000','الممتلكات والآلات والمعدات','Property, Plant and Equipment','asset','120000',3,'folder',NULL,NULL,'none',0,0),
  ('121100','تكلفة الممتلكات والآلات والمعدات','PPE at Cost','asset','121000',4,'leaf','ppe','investing','none',0,1),
  ('121900','مجمع إهلاك الممتلكات والآلات والمعدات','Accumulated Depreciation - PPE','asset','121000',4,'leaf','acc_dep','non_cash','none',1,0),
  ('122000','أصول حق الاستخدام','Right-of-use Assets (IFRS 16)','asset','120000',3,'folder',NULL,NULL,'none',0,0),
  ('122100','أصول حق استخدام العقارات','Property Right-of-use Assets','asset','122000',4,'leaf','rou','non_cash','none',0,1),
  ('122900','مجمع إهلاك أصول حق الاستخدام','Accumulated Depreciation - ROU','asset','122000',4,'leaf','acc_dep','non_cash','none',1,0),
  ('129000','أصول غير متداولة أخرى','Other Non-current Assets','asset','120000',3,'folder',NULL,NULL,'none',0,0),
  ('129900','أصول غير متداولة أخرى','Other Non-current Assets','asset','129000',4,'leaf','intangibles','investing','none',0,0),
  ('200000','الالتزامات','Liabilities','liability',NULL,1,'folder',NULL,NULL,'none',0,0),
  ('210000','الالتزامات المتداولة','Current Liabilities','liability','200000',2,'folder',NULL,NULL,'none',0,0),
  ('211000','الموردون والذمم الدائنة','Trade and Other Payables','liability','210000',3,'folder',NULL,NULL,'none',0,0),
  ('211100','ذمم الموردين','Accounts Payable','liability','211000',4,'leaf','payables','operating','none',0,1),
  ('211200','بضاعة مستلمة غير مفوترة','Goods Received Not Invoiced','liability','211000',4,'leaf','grni','operating','none',0,1),
  ('212000','المصروفات والمبالغ المستحقة','Accruals and Other Payables','liability','210000',3,'folder',NULL,NULL,'none',0,0),
  ('212100','رواتب وأجور مستحقة','Payroll Payable','liability','212000',4,'leaf','accrued','operating','none',0,1),
  ('212200','منافع مستحقة','Utilities Payable','liability','212000',4,'leaf','accrued','operating','none',0,0),
  ('212300','إيجارات مستحقة','Rent Payable','liability','212000',4,'leaf','accrued','operating','none',0,0),
  ('212400','مستحقات الامتياز','Royalty Payable','liability','212000',4,'leaf','accrued','operating','none',0,1),
  ('212500','مستحقات منصات التوصيل','Platform Payable','liability','212000',4,'leaf','accrued','operating','none',0,1),
  ('212900','مصروفات ومستحقات أخرى','Other Accruals','liability','212000',4,'leaf','accrued','operating','none',0,0),
  ('213000','الضرائب والاستحقاقات الحكومية','Taxes and Government Dues','liability','210000',3,'folder',NULL,NULL,'none',0,0),
  ('213100','ضريبة القيمة المضافة على المخرجات','Output VAT','liability','213000',4,'leaf','output_vat','operating','vat_output',0,1),
  ('213200','صافي ضريبة القيمة المضافة المستحقة','Net VAT Payable','liability','213000',4,'leaf','net_vat','operating','vat_output',0,1),
  ('213300','التأمينات الاجتماعية المستحقة','GOSI Payable','liability','213000',4,'leaf','gosi','operating','gosi',0,1),
  ('213400','ضريبة الاستقطاع المستحقة','Withholding Tax Payable','liability','213000',4,'leaf','withholding','operating','withholding',0,1),
  ('213500','الزكاة المستحقة','Zakat Payable','liability','213000',4,'leaf','zakat','operating','zakat',0,1),
  ('214000','تمويل والتزامات متداولة','Current Financing Liabilities','liability','210000',3,'folder',NULL,NULL,'none',0,0),
  ('214100','الجزء المتداول من التزام الإيجار','Current Lease Liability','liability','214000',4,'leaf','short_term_debt','financing','none',0,0),
  ('214200','قروض قصيرة الأجل','Short-term Loans','liability','214000',4,'leaf','short_term_debt','financing','none',0,0),
  ('215000','دفعات مقدمة من العملاء','Customer Advances','liability','210000',3,'folder',NULL,NULL,'none',0,0),
  ('215100','دفعات مقدمة من العملاء','Customer Advances','liability','215000',4,'leaf','customer_advances','operating','none',0,1),
  ('219000','التزامات متداولة أخرى','Other Current Liabilities','liability','210000',3,'folder',NULL,NULL,'none',0,0),
  ('219900','التزامات متداولة أخرى','Other Current Liabilities','liability','219000',4,'leaf','other_current_liability','operating','none',0,0),
  ('220000','الالتزامات غير المتداولة','Non-current Liabilities','liability','200000',2,'folder',NULL,NULL,'none',0,0),
  ('221000','القروض والتزامات الإيجار طويلة الأجل','Long-term Loans and Leases','liability','220000',3,'folder',NULL,NULL,'none',0,0),
  ('221100','التزام الإيجار طويل الأجل','Non-current Lease Liability','liability','221000',4,'leaf','lease_obligation','financing','none',0,0),
  ('221200','قروض طويلة الأجل','Long-term Loans','liability','221000',4,'leaf','long_term_debt','financing','none',0,0),
  ('222000','منافع الموظفين طويلة الأجل','Long-term Employee Benefits','liability','220000',3,'folder',NULL,NULL,'none',0,0),
  ('222100','مخصص مكافأة نهاية الخدمة','End-of-service Benefit Provision','liability','222000',4,'leaf','eosb','non_cash','eosb',0,1),
  ('229000','التزامات غير متداولة أخرى','Other Non-current Liabilities','liability','220000',3,'folder',NULL,NULL,'none',0,0),
  ('229900','التزامات غير متداولة أخرى','Other Non-current Liabilities','liability','229000',4,'leaf','long_term_debt','financing','none',0,0),
  ('300000','حقوق الملكية','Equity','equity',NULL,1,'folder',NULL,NULL,'none',0,0),
  ('310000','رأس المال وحقوق الملاك','Capital and Owners Equity','equity','300000',2,'folder',NULL,NULL,'none',0,0),
  ('311000','رأس المال','Capital','equity','310000',3,'folder',NULL,NULL,'none',0,0),
  ('311100','رأس المال المدفوع','Paid-in Capital','equity','311000',4,'leaf','capital','financing','none',0,1),
  ('311200','مساهمات رأسمالية إضافية','Additional Paid-in Capital','equity','311000',4,'leaf','capital','financing','none',0,0),
  ('312000','الأرباح المبقاة','Retained Earnings','equity','310000',3,'folder',NULL,NULL,'none',0,0),
  ('312100','الأرباح المبقاة من سنوات سابقة','Retained Earnings - Prior Years','equity','312000',4,'leaf','retained_earnings','financing','none',0,1),
  ('313000','نتيجة الفترة الحالية','Current Period Result','equity','310000',3,'folder',NULL,NULL,'none',0,0),
  ('313100','صافي ربح أو خسارة الفترة','Current Period Profit or Loss','equity','313000',4,'leaf','retained_earnings','non_cash','none',0,1),
  ('314000','الاحتياطيات','Reserves','equity','310000',3,'folder',NULL,NULL,'none',0,0),
  ('314100','الاحتياطي النظامي','Statutory Reserve','equity','314000',4,'leaf','reserves','financing','none',0,0),
  ('314200','الاحتياطي العام واحتياطيات أخرى','General and Other Reserves','equity','314000',4,'leaf','reserves','financing','none',0,0),
  ('315000','المسحوبات والتوزيعات','Drawings and Distributions','equity','310000',3,'folder',NULL,NULL,'none',0,0),
  ('315100','مسحوبات الملاك','Owner Drawings','equity','315000',4,'leaf','drawings','financing','none',1,0),
  ('315200','توزيعات الأرباح','Profit Distributions','equity','315000',4,'leaf','drawings','financing','none',1,0),
  ('400000','الإيرادات','Revenue','revenue',NULL,1,'folder',NULL,NULL,'none',0,0),
  ('410000','إيرادات النشاط','Operating Revenue','revenue','400000',2,'folder',NULL,NULL,'none',0,0),
  ('411000','المبيعات','Sales','revenue','410000',3,'folder',NULL,NULL,'none',0,0),
  ('411100','إيرادات المبيعات','Sales Revenue','revenue','411000',4,'leaf','sales_revenue','operating','none',0,1),
  ('412000','مقابلات الإيراد','Contra Revenue','revenue','410000',3,'folder',NULL,NULL,'none',0,0),
  ('412100','خصومات المبيعات','Sales Discounts','revenue','412000',4,'leaf','sales_returns','operating','none',1,1),
  ('412200','مردودات المبيعات','Sales Returns','revenue','412000',4,'leaf','sales_returns','operating','none',1,1),
  ('419000','إيرادات أخرى','Other Income','revenue','400000',2,'folder',NULL,NULL,'none',0,0),
  ('419100','أرباح فروقات الجرد','Inventory Gains','revenue','419000',3,'leaf','other_income','operating','none',0,1),
  ('419200','إيرادات جزاءات ومخالفات','Penalty Income','revenue','419000',3,'leaf','other_income','operating','none',0,0),
  ('419900','إيرادات أخرى','Other Income','revenue','419000',3,'leaf','other_income','operating','none',0,0),
  ('500000','المصروفات','Expenses','expense',NULL,1,'folder',NULL,NULL,'none',0,0),
  ('510000','تكلفة الإيرادات','Cost of Revenue','expense','500000',2,'folder',NULL,NULL,'none',0,0),
  ('511000','تكلفة المبيعات','Cost of Sales','expense','510000',3,'folder',NULL,NULL,'none',0,0),
  ('511100','تكلفة المبيعات','Cost of Sales','expense','511000',4,'leaf','cogs','operating','none',0,1),
  ('512000','فروقات وهدر المخزون','Inventory Waste and Variances','expense','510000',3,'folder',NULL,NULL,'none',0,0),
  ('512100','مصروف الهدر والتلف','Waste and Spoilage','expense','512000',4,'leaf','waste','operating','none',0,1),
  ('512200','فروقات الجرد','Stock Variances','expense','512000',4,'leaf','stock_variance','operating','none',0,1),
  ('512300','فروق أسعار المشتريات','Purchase Price Variance','expense','512000',4,'leaf','stock_variance','operating','none',0,1),
  ('512400','فروقات الإنتاج','Production Variance','expense','512000',4,'leaf','stock_variance','operating','none',0,1),
  ('520000','تكاليف الموظفين','Employee Costs','expense','500000',2,'folder',NULL,NULL,'none',0,0),
  ('521000','الرواتب والمزايا','Payroll and Benefits','expense','520000',3,'folder',NULL,NULL,'none',0,0),
  ('521100','الرواتب والأجور الأساسية','Basic Salaries and Wages','expense','521000',4,'leaf','payroll','operating','none',0,1),
  ('521200','البدلات والحوافز','Allowances and Bonuses','expense','521000',4,'leaf','payroll','operating','none',0,0),
  ('521300','العمل الإضافي','Overtime','expense','521000',4,'leaf','payroll','operating','none',0,0),
  ('521400','حصة المنشأة في التأمينات الاجتماعية','Employer GOSI Contribution','expense','521000',4,'leaf','payroll','operating','gosi',0,0),
  ('521500','مصروف مكافأة نهاية الخدمة','End-of-service Benefit Expense','expense','521000',4,'leaf','payroll','non_cash','eosb',0,0),
  ('521900','مزايا وتدريب الموظفين','Other Employee Benefits and Training','expense','521000',4,'leaf','payroll','operating','none',0,0),
  ('530000','تكاليف الإشغال والمرافق','Occupancy and Utilities','expense','500000',2,'folder',NULL,NULL,'none',0,0),
  ('531000','الإشغال والتشغيل','Occupancy Operations','expense','530000',3,'folder',NULL,NULL,'none',0,0),
  ('531100','الإيجارات','Rent Expense','expense','531000',4,'leaf','rent_utilities','operating','none',0,0),
  ('531200','المرافق والاتصالات','Utilities and Telecom','expense','531000',4,'leaf','rent_utilities','operating','none',0,0),
  ('531300','الصيانة والإصلاح','Maintenance and Repairs','expense','531000',4,'leaf','rent_utilities','operating','none',0,0),
  ('540000','تكاليف البيع والتوزيع','Selling and Distribution Costs','expense','500000',2,'folder',NULL,NULL,'none',0,0),
  ('541000','العمولات والتسويق','Commissions and Marketing','expense','540000',3,'folder',NULL,NULL,'none',0,0),
  ('541100','عمولات منصات التوصيل','Delivery Platform Commissions','expense','541000',4,'leaf','marketing','operating','none',0,1),
  ('541200','التسويق والإعلان والولاء','Marketing, Advertising and Loyalty','expense','541000',4,'leaf','marketing','operating','none',0,0),
  ('541300','رسوم المدفوعات والبنوك','Payment and Bank Fees','expense','541000',4,'leaf','bank_gov_fees','operating','none',0,0),
  ('550000','تكاليف التشغيل والإنتاج','Operations and Production Costs','expense','500000',2,'folder',NULL,NULL,'none',0,0),
  ('551000','تكاليف التشغيل المحملة','Applied Operating Costs','expense','550000',3,'folder',NULL,NULL,'none',0,0),
  ('551100','العمالة المحملة على الإنتاج','Applied Production Labor','expense','551000',4,'leaf','opex','operating','none',1,1),
  ('551200','التكاليف غير المباشرة المحملة','Applied Production Overhead','expense','551000',4,'leaf','opex','operating','none',1,1),
  ('551300','النظافة والمستهلكات التشغيلية','Cleaning and Operating Supplies','expense','551000',4,'leaf','opex','operating','none',0,0),
  ('560000','المصروفات العمومية والإدارية','General and Administrative Expenses','expense','500000',2,'folder',NULL,NULL,'none',0,0),
  ('561000','المصروفات الإدارية','Administrative Expenses','expense','560000',3,'folder',NULL,NULL,'none',0,0),
  ('561100','الأتعاب المهنية','Professional Fees','expense','561000',4,'leaf','opex','operating','none',0,0),
  ('561200','تقنية المعلومات والبرمجيات','IT and Software','expense','561000',4,'leaf','opex','operating','none',0,0),
  ('561300','الرسوم والتراخيص الحكومية','Government Fees and Licenses','expense','561000',4,'leaf','bank_gov_fees','operating','none',0,0),
  ('561400','التأمين','Insurance','expense','561000',4,'leaf','opex','operating','none',0,0),
  ('570000','الإهلاك والإطفاء','Depreciation and Amortization','expense','500000',2,'folder',NULL,NULL,'none',0,0),
  ('571000','الإهلاك والإطفاء','Depreciation and Amortization','expense','570000',3,'folder',NULL,NULL,'none',0,0),
  ('571100','مصروف الإهلاك والإطفاء','Depreciation and Amortization Expense','expense','571000',4,'leaf','depreciation','non_cash','none',0,0),
  ('580000','تكاليف التمويل','Finance Costs','expense','500000',2,'folder',NULL,NULL,'none',0,0),
  ('581000','تكاليف التمويل وفروق العملة','Finance Costs and Foreign Exchange','expense','580000',3,'folder',NULL,NULL,'none',0,0),
  ('581100','فوائد القروض','Loan Interest','expense','581000',4,'leaf','opex','financing','none',0,0),
  ('581200','فوائد التزامات الإيجار','Lease Interest (IFRS 16)','expense','581000',4,'leaf','opex','financing','none',0,0),
  ('581300','خسائر فروق العملة','Foreign Exchange Losses','expense','581000',4,'leaf','opex','operating','none',0,0),
  ('590000','مصروفات أخرى','Other Expenses','expense','500000',2,'folder',NULL,NULL,'none',0,0),
  ('591100','رسوم الامتياز','Franchise and Royalty Fees','expense','590000',3,'leaf','franchise_fees','operating','none',0,1),
  ('592100','مصروف الزكاة','Zakat Expense','expense','590000',3,'leaf','bank_gov_fees','operating','zakat',0,0),
  ('599100','فروق التقريب','Rounding Differences','expense','590000',3,'leaf','opex','operating','none',0,1),
  ('599900','مصروفات أخرى','Other Expenses','expense','590000',3,'leaf','opex','operating','none',0,0)
ON DUPLICATE KEY UPDATE name_ar=VALUES(name_ar),name_en=VALUES(name_en),account_type=VALUES(account_type),
 parent_code=VALUES(parent_code),level_no=VALUES(level_no),account_kind=VALUES(account_kind),
 report_section=VALUES(report_section),cash_flow_activity=VALUES(cash_flow_activity),tax_nature=VALUES(tax_nature),
 is_contra=VALUES(is_contra),is_control=VALUES(is_control);

CREATE TABLE IF NOT EXISTS coa_0036_legacy_map (
  legacy_code VARCHAR(20) NOT NULL PRIMARY KEY,
  canonical_code VARCHAR(20) NOT NULL,
  priority_no INT NOT NULL DEFAULT 0,
  KEY ix_coa36_canonical (canonical_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO coa_0036_legacy_map (legacy_code, canonical_code, priority_no) VALUES
  ('1110','111100',0),
  ('100101','111100',1),
  ('100102','111100',2),
  ('100103','111100',3),
  ('100104','111100',4),
  ('1101','111100',5),
  ('1120','111200',0),
  ('100105','111200',1),
  ('100106','111200',2),
  ('100107','111200',3),
  ('100108','111200',4),
  ('1102','111200',5),
  ('100109','111300',0),
  ('100110','111300',1),
  ('100111','111300',2),
  ('1150','112100',0),
  ('100211','112100',1),
  ('100221','112200',0),
  ('100222','112200',1),
  ('100223','112200',2),
  ('100224','112200',3),
  ('100225','112200',4),
  ('1130','112300',0),
  ('100231','112300',1),
  ('100232','112300',2),
  ('100233','112300',3),
  ('100234','112400',0),
  ('100240','112900',0),
  ('100250','112990',0),
  ('1200','113100',0),
  ('1210','113100',1),
  ('1220','113100',2),
  ('1230','113100',3),
  ('100401','114100',0),
  ('100402','114100',1),
  ('100403','114100',2),
  ('100404','114100',3),
  ('1290','115100',0),
  ('100451','115100',1),
  ('100501','121100',0),
  ('100502','121100',1),
  ('100503','121100',2),
  ('100504','121100',3),
  ('100505','121100',4),
  ('100506','121100',5),
  ('100507','121100',6),
  ('100601','121900',0),
  ('100602','121900',1),
  ('100603','121900',2),
  ('100604','121900',3),
  ('100605','121900',4),
  ('100606','121900',5),
  ('100607','121900',6),
  ('100701','122100',0),
  ('100702','122900',0),
  ('2100','211100',0),
  ('2101','211100',1),
  ('2109','211100',2),
  ('200101','211100',3),
  ('200102','211100',4),
  ('200103','211100',5),
  ('200104','211100',6),
  ('200105','211100',7),
  ('200106','211100',8),
  ('2150','211200',0),
  ('2201','212100',0),
  ('200201','212100',1),
  ('200202','212200',0),
  ('200203','212300',0),
  ('2310','212400',0),
  ('2320','212500',0),
  ('200204','212900',0),
  ('2210','213100',0),
  ('200301','213100',1),
  ('200302','213200',0),
  ('2202','213300',0),
  ('200303','213300',1),
  ('200304','213400',0),
  ('200305','213500',0),
  ('200431','214100',0),
  ('200401','214200',0),
  ('200601','215100',0),
  ('200701','219900',0),
  ('200432','221100',0),
  ('200402','221200',0),
  ('200501','222100',0),
  ('300101','311100',0),
  ('300102','311200',0),
  ('300201','312100',0),
  ('300301','313100',0),
  ('300401','314100',0),
  ('300402','314200',0),
  ('300403','314200',1),
  ('300501','315100',0),
  ('300601','315200',0),
  ('4100','411100',0),
  ('400110','411100',1),
  ('400120','411100',2),
  ('400130','411100',3),
  ('400140','411100',4),
  ('400210','411100',5),
  ('400220','411100',6),
  ('400230','411100',7),
  ('400240','411100',8),
  ('400310','411100',9),
  ('400320','411100',10),
  ('400330','411100',11),
  ('400340','411100',12),
  ('4910','419100',0),
  ('400902','419100',1),
  ('4201','419200',0),
  ('400901','419900',0),
  ('400903','419900',1),
  ('400904','419900',2),
  ('5100','511100',0),
  ('500101','511100',1),
  ('500102','511100',2),
  ('500201','511100',3),
  ('500202','511100',4),
  ('500301','511100',5),
  ('500302','511100',6),
  ('5200','512100',0),
  ('5121','512100',1),
  ('5122','512100',2),
  ('5123','512100',3),
  ('5124','512100',4),
  ('5125','512100',5),
  ('500103','512100',6),
  ('500203','512100',7),
  ('500303','512100',8),
  ('5300','512200',0),
  ('5350','512300',0),
  ('5420','512400',0),
  ('5301','521100',0),
  ('500401','521100',1),
  ('500402','521100',2),
  ('500403','521100',3),
  ('500404','521100',4),
  ('5302','521200',0),
  ('500405','521200',1),
  ('5303','521300',0),
  ('500406','521300',1),
  ('5304','521400',0),
  ('500407','521400',1),
  ('500409','521500',0),
  ('500408','521900',0),
  ('500410','521900',1),
  ('500411','521900',2),
  ('500501','531100',0),
  ('500502','531100',1),
  ('500503','531100',2),
  ('500601','531200',0),
  ('500602','531200',1),
  ('500603','531200',2),
  ('500604','531200',3),
  ('500801','531300',0),
  ('500802','531300',1),
  ('500803','531300',2),
  ('500804','531300',3),
  ('5500','541100',0),
  ('500701','541200',0),
  ('500702','541200',1),
  ('500703','541200',2),
  ('500704','541200',3),
  ('500705','541200',4),
  ('501001','541300',0),
  ('501002','541300',1),
  ('501003','541300',2),
  ('5400','551100',0),
  ('5410','551200',0),
  ('501301','551300',0),
  ('501302','551300',1),
  ('501303','551300',2),
  ('501101','561100',0),
  ('501102','561100',1),
  ('501103','561100',2),
  ('501201','561200',0),
  ('501202','561200',1),
  ('501203','561200',2),
  ('500901','561300',0),
  ('500902','561300',1),
  ('500903','561300',2),
  ('501401','561400',0),
  ('501402','561400',1),
  ('501403','561400',2),
  ('501501','571100',0),
  ('501502','571100',1),
  ('501601','581100',0),
  ('501602','581200',0),
  ('501603','581300',0),
  ('6100','591100',0),
  ('501701','591100',1),
  ('501702','591100',2),
  ('500904','592100',0),
  ('501801','599900',0),
  ('501802','599900',1)
ON DUPLICATE KEY UPDATE canonical_code=VALUES(canonical_code), priority_no=VALUES(priority_no);

CREATE TABLE IF NOT EXISTS coa_0036_account_map (
  source_account_id VARCHAR(50) NOT NULL PRIMARY KEY,
  company_id VARCHAR(50) NOT NULL,
  source_code VARCHAR(20) NOT NULL,
  target_account_id VARCHAR(50) NOT NULL,
  target_code VARCHAR(20) NOT NULL,
  mapping_reason VARCHAR(120) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_coa36_target (target_account_id),
  KEY ix_coa36_company (company_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Canonical rows.  Existing five roots are updated below rather than copied.
INSERT IGNORE INTO gl_accounts
  (id,company_id,code,name_ar,name_en,type,parent_id,level,is_active,is_folder,is_postable,balance,normal_balance,is_contra,is_control,cash_flow_activity,status,system_managed,report_section,tax_nature,created_by)
SELECT CONCAT('C36-',source.code),@coa36_company,source.code,source.name_ar,source.name_en,source.account_type,NULL,source.level_no,1,
 IF(source.account_kind='folder',1,0),IF(source.account_kind='leaf',1,0),0,
 IF(source.account_type IN ('asset','expense'),'debit','credit'),source.is_contra,source.is_control,source.cash_flow_activity,
 'active',1,source.report_section,source.tax_nature,'migration:0036' FROM coa_0036_canonical_source source;

-- Refresh canonical metadata and connect the hierarchy by id.
UPDATE gl_accounts account_row
JOIN coa_0036_canonical_source source ON source.code = account_row.code
LEFT JOIN gl_accounts parent_row
  ON parent_row.company_id = account_row.company_id
 AND parent_row.code = source.parent_code
SET account_row.name_ar = source.name_ar,
    account_row.name_en = source.name_en,
    account_row.type = source.account_type,
    account_row.parent_id = parent_row.id,
    account_row.level = source.level_no,
    account_row.is_active = 1,
    account_row.status = 'active',
    account_row.is_folder = IF(source.account_kind='folder',1,0),
    account_row.is_postable = IF(source.account_kind='leaf',1,0),
    account_row.normal_balance = IF(source.account_type IN ('asset','expense'),'debit','credit'),
    account_row.is_contra = source.is_contra,
    account_row.is_control = source.is_control,
    account_row.cash_flow_activity = source.cash_flow_activity,
    account_row.report_section = source.report_section,
    account_row.tax_nature = source.tax_nature,
    account_row.system_managed = 1,
    account_row.is_system_root = IF(source.parent_code IS NULL,1,0),
    account_row.class_code = IF(source.parent_code IS NULL,LEFT(source.code,1),NULL),
    account_row.archived_by = NULL,
    account_row.archived_at = NULL,
    account_row.updated_by = 'migration:0036',
    account_row.updated_at = NOW()
WHERE account_row.company_id = @coa36_company;

-- Explicit legacy mapping first.
INSERT INTO coa_0036_account_map
  (source_account_id, company_id, source_code, target_account_id, target_code, mapping_reason)
SELECT old_account.id, old_account.company_id, old_account.code,
       target_account.id, target_account.code, 'explicit canonical mapping'
FROM gl_accounts old_account
JOIN coa_0036_legacy_map map_row ON map_row.legacy_code = old_account.code
JOIN gl_accounts target_account
  ON target_account.company_id = old_account.company_id
 AND target_account.code = map_row.canonical_code
WHERE old_account.company_id = @coa36_company
  AND old_account.id <> target_account.id
ON DUPLICATE KEY UPDATE
  target_account_id=VALUES(target_account_id), target_code=VALUES(target_code),
  mapping_reason=VALUES(mapping_reason);

-- A custom/legacy posting account not in the reviewed map is not dropped.
-- Its balance goes to a visible class-specific "other" account; the source
-- remains archived for drill-down and the map records that fallback openly.
INSERT INTO coa_0036_account_map
  (source_account_id, company_id, source_code, target_account_id, target_code, mapping_reason)
SELECT old_account.id, old_account.company_id, old_account.code,
       target_account.id, target_account.code, 'class fallback for unmapped legacy account'
FROM gl_accounts old_account
JOIN gl_accounts target_account
  ON target_account.company_id = old_account.company_id
 AND target_account.code = CASE
   WHEN old_account.report_section IN ('cash','cash_bank') THEN '111100'
   WHEN old_account.report_section IN ('receivables','trade_receivables') THEN '112100'
   WHEN old_account.report_section = 'inventory' THEN '113100'
   WHEN old_account.report_section IN ('input_vat','vat_input') THEN '115100'
   WHEN old_account.report_section IN ('ppe','fixed_assets') THEN '121100'
   WHEN old_account.report_section IN ('acc_dep','accumulated_depreciation') THEN '121900'
   WHEN old_account.report_section IN ('rou','right_of_use') THEN '122100'
   WHEN old_account.report_section IN ('payables','trade_payables') THEN '211100'
   WHEN old_account.report_section = 'grni' THEN '211200'
   WHEN old_account.report_section IN ('accrued','accruals') THEN '212900'
   WHEN old_account.report_section IN ('output_vat','vat_output') THEN '213100'
   WHEN old_account.report_section = 'net_vat' THEN '213200'
   WHEN old_account.report_section = 'gosi' THEN '213300'
   WHEN old_account.report_section IN ('withholding','wht') THEN '213400'
   WHEN old_account.report_section = 'zakat' AND old_account.type='liability' THEN '213500'
   WHEN old_account.report_section IN ('customer_advances','customer_deposits') THEN '215100'
   WHEN old_account.report_section = 'short_term_debt' THEN '214200'
   WHEN old_account.report_section = 'long_term_debt' THEN '221200'
   WHEN old_account.report_section IN ('lease_obligation','lease_liability') THEN '221100'
   WHEN old_account.report_section = 'eosb' THEN '222100'
   WHEN old_account.report_section = 'capital' THEN '311100'
   WHEN old_account.report_section IN ('retained','retained_earnings') THEN '312100'
   WHEN old_account.report_section = 'drawings' THEN '315100'
   WHEN old_account.report_section = 'reserves' THEN '314200'
   WHEN old_account.report_section IN ('sales_revenue','revenue') THEN '411100'
   WHEN old_account.report_section = 'sales_returns' THEN '412200'
   WHEN old_account.report_section = 'other_income' THEN '419900'
   WHEN old_account.report_section = 'cogs' THEN '511100'
   WHEN old_account.report_section = 'waste' THEN '512100'
   WHEN old_account.report_section = 'stock_variance' THEN '512200'
   WHEN old_account.report_section = 'payroll' THEN '521100'
   WHEN old_account.report_section = 'rent_utilities' THEN '531200'
   WHEN old_account.report_section = 'marketing' THEN '541200'
   WHEN old_account.report_section = 'depreciation' THEN '571100'
   WHEN old_account.report_section = 'bank_gov_fees' THEN '561300'
   WHEN old_account.report_section = 'franchise_fees' THEN '591100'
   WHEN old_account.type='asset' THEN '119900'
   WHEN old_account.type='liability' THEN '219900'
   WHEN old_account.type='equity' THEN '312100'
   WHEN old_account.type='revenue' THEN '419900'
   ELSE '599900' END
LEFT JOIN coa_0036_canonical_source canonical ON canonical.code = old_account.code
LEFT JOIN coa_0036_account_map existing_map ON existing_map.source_account_id = old_account.id
WHERE old_account.company_id = @coa36_company
  AND canonical.code IS NULL
  AND existing_map.source_account_id IS NULL
  AND (COALESCE(old_account.is_postable,0)=1 OR EXISTS (
    SELECT 1 FROM gl_entries existing_entry WHERE existing_entry.account_id=old_account.id
  ))
ON DUPLICATE KEY UPDATE target_account_id=VALUES(target_account_id), target_code=VALUES(target_code);

-- Old codes remain forwarding addresses for imports/integrations.
INSERT INTO account_code_aliases
  (id, company_id, old_code, account_id, reason, created_by)
SELECT CONCAT('A36-', map_row.source_code), map_row.company_id,
       map_row.source_code, map_row.target_account_id,
       'Saudi canonical CoA rebuild 0036', 'migration:0036'
FROM coa_0036_account_map map_row
ON DUPLICATE KEY UPDATE account_id=VALUES(account_id), reason=VALUES(reason);

-- A partially executed draft is safe to rebuild. A posted transition is
-- immutable and makes every following statement an idempotent no-op/update.
DELETE entry_row FROM gl_entries entry_row
JOIN gl_journals journal_row ON journal_row.id=entry_row.journal_id
WHERE journal_row.id='COA36-TRANSITION' AND journal_row.status='draft';
DELETE FROM gl_journals WHERE id='COA36-TRANSITION' AND status='draft';

INSERT IGNORE INTO gl_journals
  (id,journal_number,journal_date,reference_type,reference_id,description,
   total_debit,total_credit,status,created_by)
SELECT 'COA36-TRANSITION','COA36-TRANSITION',CURRENT_DATE,
       'CoaTransition','0036','إعادة تصنيف أرصدة دليل الحسابات إلى الشجرة السعودية القياسية',
       COALESCE(SUM(ABS(ledger.net_balance)),0),
       COALESCE(SUM(ABS(ledger.net_balance)),0),'draft','migration:0036'
FROM coa_0036_account_map map_row
JOIN (
  SELECT entry_row.account_id, SUM(entry_row.debit-entry_row.credit) AS net_balance
  FROM gl_entries entry_row
  JOIN gl_journals journal_row ON journal_row.id=entry_row.journal_id
  WHERE journal_row.status='posted' AND journal_row.id<>'COA36-TRANSITION'
  GROUP BY entry_row.account_id
) ledger ON ledger.account_id=map_row.source_account_id
WHERE ABS(ledger.net_balance)>0.005;

-- Reverse each retired account's balance.
INSERT INTO gl_entries
  (id,journal_id,account_id,account_code,account_name,debit,credit,description)
SELECT UUID(),'COA36-TRANSITION',source_account.id,source_account.code,source_account.name_ar,
       IF(ledger.net_balance<0,ABS(ledger.net_balance),0),
       IF(ledger.net_balance>0,ABS(ledger.net_balance),0),
       CONCAT('إقفال الرصيد القديم ونقله إلى ',map_row.target_code)
FROM coa_0036_account_map map_row
JOIN gl_accounts source_account ON source_account.id=map_row.source_account_id
JOIN (
  SELECT entry_row.account_id, SUM(entry_row.debit-entry_row.credit) AS net_balance
  FROM gl_entries entry_row
  JOIN gl_journals journal_row ON journal_row.id=entry_row.journal_id
  WHERE journal_row.status='posted' AND journal_row.id<>'COA36-TRANSITION'
  GROUP BY entry_row.account_id
) ledger ON ledger.account_id=map_row.source_account_id
JOIN gl_journals transition ON transition.id='COA36-TRANSITION' AND transition.status='draft'
WHERE ABS(ledger.net_balance)>0.005;

-- Open the same balances on canonical accounts, aggregated by target.
INSERT INTO gl_entries
  (id,journal_id,account_id,account_code,account_name,debit,credit,description)
SELECT UUID(),'COA36-TRANSITION',target_account.id,target_account.code,target_account.name_ar,
       SUM(IF(ledger.net_balance>0,ledger.net_balance,0)),
       SUM(IF(ledger.net_balance<0,ABS(ledger.net_balance),0)),
       'أرصدة افتتاحية بعد إعادة بناء دليل الحسابات'
FROM coa_0036_account_map map_row
JOIN gl_accounts target_account ON target_account.id=map_row.target_account_id
JOIN (
  SELECT entry_row.account_id, SUM(entry_row.debit-entry_row.credit) AS net_balance
  FROM gl_entries entry_row
  JOIN gl_journals journal_row ON journal_row.id=entry_row.journal_id
  WHERE journal_row.status='posted' AND journal_row.id<>'COA36-TRANSITION'
  GROUP BY entry_row.account_id
) ledger ON ledger.account_id=map_row.source_account_id
JOIN gl_journals transition ON transition.id='COA36-TRANSITION' AND transition.status='draft'
WHERE ABS(ledger.net_balance)>0.005
GROUP BY target_account.id,target_account.code,target_account.name_ar;

UPDATE gl_journals journal_row
LEFT JOIN (
  SELECT journal_id,SUM(debit) AS debit_total,SUM(credit) AS credit_total
  FROM gl_entries WHERE journal_id='COA36-TRANSITION' GROUP BY journal_id
) totals ON totals.journal_id=journal_row.id
SET journal_row.total_debit=COALESCE(totals.debit_total,0),
    journal_row.total_credit=COALESCE(totals.credit_total,0),
    journal_row.status='posted'
WHERE journal_row.id='COA36-TRANSITION'
  AND journal_row.status='draft'
  AND ABS(COALESCE(totals.debit_total,0)-COALESCE(totals.credit_total,0))<=0.005;

-- Preserve id-based configuration links before legacy rows are archived.
UPDATE payment_methods item JOIN coa_0036_account_map map_row ON map_row.source_account_id=item.gl_account_id SET item.gl_account_id=map_row.target_account_id;
UPDATE discounts_v2 item JOIN coa_0036_account_map map_row ON map_row.source_account_id=item.gl_account_id SET item.gl_account_id=map_row.target_account_id;
UPDATE cash_boxes item JOIN coa_0036_account_map map_row ON map_row.source_account_id=item.gl_account_id SET item.gl_account_id=map_row.target_account_id;
UPDATE bank_accounts item JOIN coa_0036_account_map map_row ON map_row.source_account_id=item.gl_account_id SET item.gl_account_id=map_row.target_account_id;
UPDATE custody_expenses item JOIN coa_0036_account_map map_row ON map_row.source_account_id=item.gl_account_id SET item.gl_account_id=map_row.target_account_id;
UPDATE cash_payments item JOIN coa_0036_account_map map_row ON map_row.source_account_id=item.expense_account_id SET item.expense_account_id=map_row.target_account_id;
UPDATE expense_categories item JOIN coa_0036_account_map map_row ON map_row.source_account_id=item.gl_account_id SET item.gl_account_id=map_row.target_account_id,item.gl_account_code=map_row.target_code;
UPDATE inv_items item JOIN coa_0036_account_map map_row ON map_row.source_account_id=item.waste_gl_account_id SET item.waste_gl_account_id=map_row.target_account_id;
UPDATE customers item JOIN coa_0036_account_map map_row ON map_row.source_account_id=item.default_revenue_account_id SET item.default_revenue_account_id=map_row.target_account_id;
UPDATE suppliers item JOIN coa_0036_account_map map_row ON map_row.source_account_id=item.default_expense_account_id SET item.default_expense_account_id=map_row.target_account_id;
UPDATE assets item JOIN coa_0036_account_map map_row ON map_row.source_account_id=item.gl_asset_account_id SET item.gl_asset_account_id=map_row.target_account_id;
UPDATE assets item JOIN coa_0036_account_map map_row ON map_row.source_account_id=item.gl_dep_expense_account_id SET item.gl_dep_expense_account_id=map_row.target_account_id;
UPDATE assets item JOIN coa_0036_account_map map_row ON map_row.source_account_id=item.gl_accum_dep_account_id SET item.gl_accum_dep_account_id=map_row.target_account_id;
UPDATE ar_document_lines item JOIN coa_0036_account_map map_row ON map_row.source_account_id=item.revenue_account_id SET item.revenue_account_id=map_row.target_account_id,item.revenue_account_code=map_row.target_code;

-- Code-based configuration links move too; historical gl_entries snapshots
-- deliberately retain the code printed when each journal was posted.
UPDATE transactions item JOIN coa_0036_account_map map_row ON map_row.source_code=item.account_code SET item.account_code=map_row.target_code;
UPDATE payment_records item JOIN coa_0036_account_map map_row ON map_row.source_code=item.expense_account_code SET item.expense_account_code=map_row.target_code;
UPDATE payment_records item JOIN coa_0036_account_map map_row ON map_row.source_code=item.counter_account_code SET item.counter_account_code=map_row.target_code;
UPDATE inv_receipts item JOIN coa_0036_account_map map_row ON map_row.source_code=item.counter_account_code SET item.counter_account_code=map_row.target_code;

-- Governance history then current role mapping.
INSERT IGNORE INTO account_role_history
  (id,role_key,company_id,old_account_id,new_account_id,expected_version,reason,changed_by)
SELECT CONCAT('H36-',role_source.role_key),role_source.role_key,@coa36_company,
       current_role.account_id,target_account.id,current_role.version,
       'Saudi canonical CoA rebuild 0036','migration:0036'
FROM (
  SELECT 'CASH_ON_HAND' AS role_key, '111100' AS target_code
  UNION ALL SELECT 'BANK' AS role_key, '111200' AS target_code
  UNION ALL SELECT 'PAYMENT_CLEARING' AS role_key, '111300' AS target_code
  UNION ALL SELECT 'ACCOUNTS_RECEIVABLE' AS role_key, '112100' AS target_code
  UNION ALL SELECT 'EMPLOYEE_ADVANCES' AS role_key, '112300' AS target_code
  UNION ALL SELECT 'SUPPLIER_ADVANCES' AS role_key, '112400' AS target_code
  UNION ALL SELECT 'INVENTORY' AS role_key, '113100' AS target_code
  UNION ALL SELECT 'BRANCH_INVENTORY' AS role_key, '113100' AS target_code
  UNION ALL SELECT 'WORK_IN_PROGRESS' AS role_key, '113100' AS target_code
  UNION ALL SELECT 'FINISHED_GOODS' AS role_key, '113100' AS target_code
  UNION ALL SELECT 'INPUT_VAT' AS role_key, '115100' AS target_code
  UNION ALL SELECT 'SUSPENSE' AS role_key, '119900' AS target_code
  UNION ALL SELECT 'ACCOUNTS_PAYABLE' AS role_key, '211100' AS target_code
  UNION ALL SELECT 'GRNI' AS role_key, '211200' AS target_code
  UNION ALL SELECT 'PAYROLL_PAYABLE' AS role_key, '212100' AS target_code
  UNION ALL SELECT 'ROYALTY_PAYABLE' AS role_key, '212400' AS target_code
  UNION ALL SELECT 'PLATFORM_PAYABLE' AS role_key, '212500' AS target_code
  UNION ALL SELECT 'OUTPUT_VAT' AS role_key, '213100' AS target_code
  UNION ALL SELECT 'GOSI_EMPLOYEE_SHARE' AS role_key, '213300' AS target_code
  UNION ALL SELECT 'ZAKAT' AS role_key, '213500' AS target_code
  UNION ALL SELECT 'CUSTOMER_ADVANCES' AS role_key, '215100' AS target_code
  UNION ALL SELECT 'SALES_REVENUE' AS role_key, '411100' AS target_code
  UNION ALL SELECT 'SALES_DISCOUNT' AS role_key, '412100' AS target_code
  UNION ALL SELECT 'STOCK_GAIN' AS role_key, '419100' AS target_code
  UNION ALL SELECT 'INVENTORY_GAIN_LOSS' AS role_key, '419100' AS target_code
  UNION ALL SELECT 'PENALTY_REVENUE' AS role_key, '419200' AS target_code
  UNION ALL SELECT 'COGS' AS role_key, '511100' AS target_code
  UNION ALL SELECT 'WASTE_EXPENSE' AS role_key, '512100' AS target_code
  UNION ALL SELECT 'WASTE_RAW' AS role_key, '512100' AS target_code
  UNION ALL SELECT 'WASTE_FINISHED' AS role_key, '512100' AS target_code
  UNION ALL SELECT 'WASTE_EXPIRED' AS role_key, '512100' AS target_code
  UNION ALL SELECT 'WASTE_SPILL' AS role_key, '512100' AS target_code
  UNION ALL SELECT 'WASTE_RETURNS' AS role_key, '512100' AS target_code
  UNION ALL SELECT 'STOCK_VARIANCE' AS role_key, '512200' AS target_code
  UNION ALL SELECT 'PPV' AS role_key, '512300' AS target_code
  UNION ALL SELECT 'PRODUCTION_VARIANCE' AS role_key, '512400' AS target_code
  UNION ALL SELECT 'SALARY_EXPENSE' AS role_key, '521100' AS target_code
  UNION ALL SELECT 'ALLOWANCES_EXPENSE' AS role_key, '521200' AS target_code
  UNION ALL SELECT 'OVERTIME_EXPENSE' AS role_key, '521300' AS target_code
  UNION ALL SELECT 'GOSI_COMPANY_SHARE' AS role_key, '521400' AS target_code
  UNION ALL SELECT 'PLATFORM_COMMISSION' AS role_key, '541100' AS target_code
  UNION ALL SELECT 'DELIVERY_COMMISSION' AS role_key, '541100' AS target_code
  UNION ALL SELECT 'LABOR_APPLIED' AS role_key, '551100' AS target_code
  UNION ALL SELECT 'OVERHEAD_APPLIED' AS role_key, '551200' AS target_code
  UNION ALL SELECT 'FRANCHISE_FEE' AS role_key, '591100' AS target_code
  UNION ALL SELECT 'ROUNDING' AS role_key, '599100' AS target_code
  UNION ALL SELECT 'OTHER_EXPENSE' AS role_key, '599900' AS target_code
) role_source
JOIN gl_accounts target_account ON target_account.company_id=@coa36_company AND target_account.code=role_source.target_code
LEFT JOIN account_roles current_role ON current_role.company_id=@coa36_company AND current_role.role_key=role_source.role_key
WHERE current_role.account_id IS NULL OR current_role.account_id<>target_account.id;

INSERT INTO account_roles
  (id,role_key,company_id,account_id,is_active,version,notes,created_by)
SELECT CONCAT('R36-',role_source.role_key),role_source.role_key,@coa36_company,target_account.id,1,1,
       'Canonical Saudi/IFRS chart 0036','migration:0036'
FROM (
  SELECT 'CASH_ON_HAND' AS role_key, '111100' AS target_code
  UNION ALL SELECT 'BANK' AS role_key, '111200' AS target_code
  UNION ALL SELECT 'PAYMENT_CLEARING' AS role_key, '111300' AS target_code
  UNION ALL SELECT 'ACCOUNTS_RECEIVABLE' AS role_key, '112100' AS target_code
  UNION ALL SELECT 'EMPLOYEE_ADVANCES' AS role_key, '112300' AS target_code
  UNION ALL SELECT 'SUPPLIER_ADVANCES' AS role_key, '112400' AS target_code
  UNION ALL SELECT 'INVENTORY' AS role_key, '113100' AS target_code
  UNION ALL SELECT 'BRANCH_INVENTORY' AS role_key, '113100' AS target_code
  UNION ALL SELECT 'WORK_IN_PROGRESS' AS role_key, '113100' AS target_code
  UNION ALL SELECT 'FINISHED_GOODS' AS role_key, '113100' AS target_code
  UNION ALL SELECT 'INPUT_VAT' AS role_key, '115100' AS target_code
  UNION ALL SELECT 'SUSPENSE' AS role_key, '119900' AS target_code
  UNION ALL SELECT 'ACCOUNTS_PAYABLE' AS role_key, '211100' AS target_code
  UNION ALL SELECT 'GRNI' AS role_key, '211200' AS target_code
  UNION ALL SELECT 'PAYROLL_PAYABLE' AS role_key, '212100' AS target_code
  UNION ALL SELECT 'ROYALTY_PAYABLE' AS role_key, '212400' AS target_code
  UNION ALL SELECT 'PLATFORM_PAYABLE' AS role_key, '212500' AS target_code
  UNION ALL SELECT 'OUTPUT_VAT' AS role_key, '213100' AS target_code
  UNION ALL SELECT 'GOSI_EMPLOYEE_SHARE' AS role_key, '213300' AS target_code
  UNION ALL SELECT 'ZAKAT' AS role_key, '213500' AS target_code
  UNION ALL SELECT 'CUSTOMER_ADVANCES' AS role_key, '215100' AS target_code
  UNION ALL SELECT 'SALES_REVENUE' AS role_key, '411100' AS target_code
  UNION ALL SELECT 'SALES_DISCOUNT' AS role_key, '412100' AS target_code
  UNION ALL SELECT 'STOCK_GAIN' AS role_key, '419100' AS target_code
  UNION ALL SELECT 'INVENTORY_GAIN_LOSS' AS role_key, '419100' AS target_code
  UNION ALL SELECT 'PENALTY_REVENUE' AS role_key, '419200' AS target_code
  UNION ALL SELECT 'COGS' AS role_key, '511100' AS target_code
  UNION ALL SELECT 'WASTE_EXPENSE' AS role_key, '512100' AS target_code
  UNION ALL SELECT 'WASTE_RAW' AS role_key, '512100' AS target_code
  UNION ALL SELECT 'WASTE_FINISHED' AS role_key, '512100' AS target_code
  UNION ALL SELECT 'WASTE_EXPIRED' AS role_key, '512100' AS target_code
  UNION ALL SELECT 'WASTE_SPILL' AS role_key, '512100' AS target_code
  UNION ALL SELECT 'WASTE_RETURNS' AS role_key, '512100' AS target_code
  UNION ALL SELECT 'STOCK_VARIANCE' AS role_key, '512200' AS target_code
  UNION ALL SELECT 'PPV' AS role_key, '512300' AS target_code
  UNION ALL SELECT 'PRODUCTION_VARIANCE' AS role_key, '512400' AS target_code
  UNION ALL SELECT 'SALARY_EXPENSE' AS role_key, '521100' AS target_code
  UNION ALL SELECT 'ALLOWANCES_EXPENSE' AS role_key, '521200' AS target_code
  UNION ALL SELECT 'OVERTIME_EXPENSE' AS role_key, '521300' AS target_code
  UNION ALL SELECT 'GOSI_COMPANY_SHARE' AS role_key, '521400' AS target_code
  UNION ALL SELECT 'PLATFORM_COMMISSION' AS role_key, '541100' AS target_code
  UNION ALL SELECT 'DELIVERY_COMMISSION' AS role_key, '541100' AS target_code
  UNION ALL SELECT 'LABOR_APPLIED' AS role_key, '551100' AS target_code
  UNION ALL SELECT 'OVERHEAD_APPLIED' AS role_key, '551200' AS target_code
  UNION ALL SELECT 'FRANCHISE_FEE' AS role_key, '591100' AS target_code
  UNION ALL SELECT 'ROUNDING' AS role_key, '599100' AS target_code
  UNION ALL SELECT 'OTHER_EXPENSE' AS role_key, '599900' AS target_code
) role_source
JOIN gl_accounts target_account ON target_account.company_id=@coa36_company AND target_account.code=role_source.target_code
ON DUPLICATE KEY UPDATE
  version=IF(account_roles.account_id<>VALUES(account_id),account_roles.version+1,account_roles.version),
  account_id=VALUES(account_id),is_active=1,notes=VALUES(notes),updated_by='migration:0036';

-- Retire every row outside the reviewed chart. Nothing is deleted.
UPDATE gl_accounts old_account
LEFT JOIN coa_0036_canonical_source canonical ON canonical.code=old_account.code
SET old_account.status='archived',old_account.is_active=0,old_account.is_postable=0,
    old_account.is_system_root=0,old_account.class_code=NULL,
    old_account.archived_by='migration:0036',
    old_account.archived_at=COALESCE(old_account.archived_at,NOW()),
    old_account.updated_by='migration:0036',old_account.updated_at=NOW()
WHERE old_account.company_id=@coa36_company AND canonical.code IS NULL;

-- Rebuild the display cache from posted ledger truth.
UPDATE gl_accounts account_row
LEFT JOIN (
  SELECT entry_row.account_id,SUM(entry_row.debit-entry_row.credit) AS net_balance
  FROM gl_entries entry_row JOIN gl_journals journal_row ON journal_row.id=entry_row.journal_id
  WHERE journal_row.status='posted' GROUP BY entry_row.account_id
) ledger ON ledger.account_id=account_row.id
SET account_row.balance=COALESCE(ledger.net_balance,0);

-- Fail closed on every invariant the owner asked for.
INSERT INTO _migrations(version,filename)
SELECT '0035','0036_invalid_active_chart'
WHERE (SELECT COUNT(*) FROM gl_accounts WHERE company_id=@coa36_company AND status='active')<>141
   OR (SELECT COUNT(*) FROM gl_accounts WHERE company_id=@coa36_company AND status='active' AND parent_id IS NULL)<>5
   OR EXISTS (SELECT 1 FROM gl_accounts WHERE company_id=@coa36_company AND status='active' AND code NOT REGEXP '^[0-9]{6}$')
   OR EXISTS (SELECT 1 FROM gl_accounts WHERE company_id=@coa36_company AND status='active' AND level NOT BETWEEN 1 AND 4)
   OR (SELECT COUNT(*) FROM gl_accounts WHERE company_id=@coa36_company AND status='active' AND report_section='inventory' AND is_postable=1)<>1
   OR EXISTS (
     SELECT 1 FROM gl_accounts parent_row
     JOIN gl_accounts child_row ON child_row.parent_id=parent_row.id AND child_row.status='active'
     WHERE parent_row.company_id=@coa36_company AND parent_row.status='active' AND parent_row.is_postable=1
   )
   OR EXISTS (
     SELECT 1 FROM gl_journals WHERE id='COA36-TRANSITION'
       AND (status<>'posted' OR ABS(total_debit-total_credit)>0.005)
   );
