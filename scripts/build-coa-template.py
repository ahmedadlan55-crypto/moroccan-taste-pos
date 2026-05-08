#!/usr/bin/env python3
"""
v5.11.8 — Build the official IFRS-aligned chart of accounts template
for the Moroccan Taste POS (multi-brand F&B in KSA).

Hierarchy: 6 IFRS roots (Assets / Liabilities / Equity / Revenue /
COGS / Operating-Admin Expenses) with sensible level depth (1..5).

Run: python3 scripts/build-coa-template.py
Output: db/coa-template.json (replaces the existing one)
"""

import json
import sys
from collections import Counter

sys.stdout.reconfigure(encoding='utf-8')

# Tuple shape: (code, nameAr, nameEn, type, kind, children)
tree = [
    # ─── 1. ASSETS ────────────────────────────────────────────
    ('1', 'الأصول', 'Assets', 'asset', 'folder', [
        ('11', 'الأصول المتداولة', 'Current Assets', 'asset', 'folder', [
            ('111', 'النقدية والبنوك', 'Cash and Bank', 'asset', 'folder', [
                ('1111', 'النقدية بالخزينة', 'Cash on Hand', 'asset', 'folder', [
                    ('11111', 'عهدة الكاشير (POS)', 'POS Cash Drawer', 'asset', 'leaf', []),
                    ('11112', 'النثرية', 'Petty Cash', 'asset', 'leaf', []),
                    ('11113', 'خزنة الإدارة', 'Main Safe', 'asset', 'leaf', []),
                ]),
                ('1112', 'الحسابات البنكية', 'Bank Accounts', 'asset', 'folder', [
                    ('11121', 'مصرف الراجحي', 'Al-Rajhi Bank', 'asset', 'leaf', []),
                    ('11122', 'البنك الأهلي السعودي', 'Saudi National Bank', 'asset', 'leaf', []),
                    ('11123', 'بنك الرياض', 'Riyad Bank', 'asset', 'leaf', []),
                    ('11124', 'حسابات بنكية أخرى', 'Other Bank Accounts', 'asset', 'leaf', []),
                ]),
                ('1113', 'تسويات نقاط البيع', 'POS Settlement', 'asset', 'folder', [
                    ('11131', 'مدى — تحت التسوية', 'Mada — Pending', 'asset', 'leaf', []),
                    ('11132', 'فيزا/ماستر — تحت التسوية', 'Visa/Master — Pending', 'asset', 'leaf', []),
                    ('11133', 'محافظ رقمية — تحت التسوية', 'Digital Wallets — Pending', 'asset', 'leaf', []),
                ]),
            ]),
            ('112', 'الذمم المدينة', 'Accounts Receivable', 'asset', 'folder', [
                ('1121', 'ذمم العملاء التجاريين', 'Trade Receivables', 'asset', 'leaf', []),
                ('1122', 'ذمم تطبيقات التوصيل', 'Delivery Apps Receivables', 'asset', 'folder', [
                    ('11221', 'هنقرستيشن', 'HungerStation', 'asset', 'leaf', []),
                    ('11222', 'جاهز', 'Jahez', 'asset', 'leaf', []),
                    ('11223', 'مرسول', 'Mrsool', 'asset', 'leaf', []),
                    ('11224', 'ذي تشيفز', 'The Chefz', 'asset', 'leaf', []),
                    ('11225', 'تطبيقات أخرى', 'Other Delivery Apps', 'asset', 'leaf', []),
                ]),
                ('1123', 'ذمم مدينة أخرى', 'Other Receivables', 'asset', 'leaf', []),
                ('1124', 'مخصص الديون المشكوك فيها', 'Allowance for Doubtful Debts', 'asset', 'leaf', []),
            ]),
            ('113', 'المخزون', 'Inventory', 'asset', 'folder', [
                ('1131', 'المواد الخام', 'Raw Materials', 'asset', 'folder', [
                    ('11311', 'حبوب البن والقهوة', 'Coffee Beans', 'asset', 'leaf', []),
                    ('11312', 'الحليب ومشتقاته', 'Milk & Dairy', 'asset', 'leaf', []),
                    ('11313', 'الصوصات والمنكهات', 'Syrups & Sauces', 'asset', 'leaf', []),
                    ('11314', 'مكونات المعجنات والحلويات', 'Bakery & Pastry Ingredients', 'asset', 'leaf', []),
                    ('11315', 'الفواكه والخضروات', 'Fruits & Vegetables', 'asset', 'leaf', []),
                    ('11316', 'مواد خام أخرى', 'Other Raw Materials', 'asset', 'leaf', []),
                ]),
                ('1132', 'التغليف والمستهلكات', 'Packaging & Supplies', 'asset', 'folder', [
                    ('11321', 'الأكواب والأغطية', 'Cups & Lids', 'asset', 'leaf', []),
                    ('11322', 'أكياس وعلب التعبئة', 'Bags & Boxes', 'asset', 'leaf', []),
                    ('11323', 'مناديل وشفاطات', 'Napkins & Straws', 'asset', 'leaf', []),
                    ('11324', 'مستلزمات النظافة', 'Cleaning Supplies', 'asset', 'leaf', []),
                ]),
                ('1133', 'المنتجات الجاهزة', 'Finished Goods', 'asset', 'leaf', []),
                ('1134', 'بضاعة في الطريق', 'Goods in Transit', 'asset', 'leaf', []),
            ]),
            ('114', 'المصروفات المدفوعة مقدمًا', 'Prepayments', 'asset', 'folder', [
                ('1141', 'إيجارات مدفوعة مقدمًا', 'Prepaid Rent', 'asset', 'leaf', []),
                ('1142', 'تأمين مدفوع مقدمًا', 'Prepaid Insurance', 'asset', 'leaf', []),
                ('1143', 'اشتراكات مدفوعة مقدمًا', 'Prepaid Subscriptions', 'asset', 'leaf', []),
                ('1144', 'مصروفات أخرى مدفوعة مقدمًا', 'Other Prepaid Expenses', 'asset', 'leaf', []),
            ]),
            ('115', 'العهد والسلف', 'Custody & Advances', 'asset', 'folder', [
                ('1151', 'عهد التشغيل', 'Operations Custody', 'asset', 'leaf', []),
                ('1152', 'عهد إدارية', 'Administrative Custody', 'asset', 'leaf', []),
                ('1153', 'سلف الموظفين', 'Employee Advances', 'asset', 'leaf', []),
                ('1154', 'سلف للموردين', 'Supplier Advances', 'asset', 'leaf', []),
            ]),
            ('116', 'ضريبة المدخلات', 'Input VAT', 'asset', 'folder', [
                ('1161', 'ضريبة المدخلات — 15%', 'Input VAT — Standard 15%', 'asset', 'leaf', []),
                ('1162', 'ضريبة المدخلات — تحت الاسترداد', 'Input VAT — Pending Recovery', 'asset', 'leaf', []),
            ]),
        ]),
        ('12', 'الأصول غير المتداولة', 'Non-Current Assets', 'asset', 'folder', [
            ('121', 'الممتلكات والآلات والمعدات', 'Property, Plant & Equipment', 'asset', 'folder', [
                ('1211', 'الأثاث والتركيبات', 'Furniture & Fixtures', 'asset', 'leaf', []),
                ('1212', 'معدات المطبخ', 'Kitchen Equipment', 'asset', 'leaf', []),
                ('1213', 'أجهزة نقاط البيع', 'POS Hardware', 'asset', 'leaf', []),
                ('1214', 'المركبات', 'Vehicles', 'asset', 'leaf', []),
                ('1215', 'الأجهزة الحاسوبية', 'Computer Equipment', 'asset', 'leaf', []),
                ('1216', 'المباني والتحسينات', 'Buildings & Improvements', 'asset', 'leaf', []),
            ]),
            ('122', 'مجمع الإهلاك', 'Accumulated Depreciation', 'asset', 'folder', [
                ('1221', 'م.إ — الأثاث', 'AD — Furniture', 'asset', 'leaf', []),
                ('1222', 'م.إ — معدات المطبخ', 'AD — Kitchen Equipment', 'asset', 'leaf', []),
                ('1223', 'م.إ — أجهزة POS', 'AD — POS Hardware', 'asset', 'leaf', []),
                ('1224', 'م.إ — المركبات', 'AD — Vehicles', 'asset', 'leaf', []),
                ('1225', 'م.إ — الأجهزة الحاسوبية', 'AD — Computer Equipment', 'asset', 'leaf', []),
                ('1226', 'م.إ — تحسينات المباني', 'AD — Building Improvements', 'asset', 'leaf', []),
            ]),
            ('123', 'الأصول غير الملموسة', 'Intangible Assets', 'asset', 'folder', [
                ('1231', 'تراخيص البرمجيات', 'Software Licenses', 'asset', 'leaf', []),
                ('1232', 'العلامات التجارية', 'Trademarks', 'asset', 'leaf', []),
                ('1233', 'حقوق الفرنشايز', 'Franchise Rights', 'asset', 'leaf', []),
            ]),
            ('124', 'حق استخدام الأصول (IFRS 16)', 'Right-of-Use Assets', 'asset', 'folder', [
                ('1241', 'حق استخدام — إيجار الفروع', 'ROU — Branch Leases', 'asset', 'leaf', []),
                ('1242', 'حق استخدام — إيجار المستودعات', 'ROU — Warehouse Leases', 'asset', 'leaf', []),
            ]),
        ]),
    ]),

    # ─── 2. LIABILITIES ───────────────────────────────────────
    ('2', 'الالتزامات', 'Liabilities', 'liability', 'folder', [
        ('21', 'الالتزامات المتداولة', 'Current Liabilities', 'liability', 'folder', [
            ('211', 'الذمم الدائنة', 'Accounts Payable', 'liability', 'folder', [
                ('2111', 'موردون تجاريون', 'Trade Payables', 'liability', 'leaf', []),
                ('2112', 'دائنون آخرون', 'Other Payables', 'liability', 'leaf', []),
            ]),
            ('212', 'المصروفات المستحقة', 'Accrued Expenses', 'liability', 'folder', [
                ('2121', 'رواتب وأجور مستحقة', 'Accrued Salaries', 'liability', 'leaf', []),
                ('2122', 'منافع مستحقة (كهرباء، ماء، إنترنت)', 'Accrued Utilities', 'liability', 'leaf', []),
                ('2123', 'إيجارات مستحقة', 'Accrued Rent', 'liability', 'leaf', []),
                ('2124', 'مستحقات أخرى', 'Other Accruals', 'liability', 'leaf', []),
            ]),
            ('213', 'ضريبة المخرجات', 'Output VAT', 'liability', 'folder', [
                ('2131', 'ضريبة المخرجات — 15%', 'Output VAT — Standard 15%', 'liability', 'leaf', []),
                ('2132', 'الضريبة المستحقة الدفع', 'VAT Payable', 'liability', 'leaf', []),
            ]),
            ('214', 'دفعات مقدمة من العملاء', 'Customer Deposits', 'liability', 'leaf', []),
            ('215', 'مستحقات الفرنشايز', 'Royalty / Franchise Payable', 'liability', 'leaf', []),
            ('216', 'التأمينات الاجتماعية المستحقة', 'GOSI Payable', 'liability', 'leaf', []),
            ('217', 'ضريبة الاستقطاع المستحقة', 'Withholding Tax Payable', 'liability', 'leaf', []),
            ('218', 'القروض قصيرة الأجل', 'Short-term Loans', 'liability', 'leaf', []),
            ('219', 'الجزء الحالي من التزام الإيجار', 'Current Portion of Lease Liability', 'liability', 'leaf', []),
        ]),
        ('22', 'الالتزامات غير المتداولة', 'Non-Current Liabilities', 'liability', 'folder', [
            ('221', 'القروض طويلة الأجل', 'Long-term Loans', 'liability', 'leaf', []),
            ('222', 'التزام الإيجار طويل الأجل', 'Long-term Lease Liability', 'liability', 'leaf', []),
            ('223', 'مكافأة نهاية الخدمة', 'End-of-Service Benefits', 'liability', 'leaf', []),
        ]),
    ]),

    # ─── 3. EQUITY ────────────────────────────────────────────
    ('3', 'حقوق الملكية', 'Equity', 'equity', 'folder', [
        ('31', 'رأس المال', 'Capital', 'equity', 'folder', [
            ('311', 'رأس مال المالك', "Owner's Capital", 'equity', 'leaf', []),
            ('312', 'مساهمات رأسمالية إضافية', 'Additional Capital Contributions', 'equity', 'leaf', []),
        ]),
        ('32', 'الأرباح المحتجزة', 'Retained Earnings', 'equity', 'folder', [
            ('321', 'أرباح محتجزة من سنوات سابقة', 'Retained Earnings — Brought Forward', 'equity', 'leaf', []),
            ('322', 'أرباح/خسائر السنة الحالية', 'Current Year Profit/Loss', 'equity', 'leaf', []),
        ]),
        ('33', 'مسحوبات المالك', "Owner's Drawings", 'equity', 'leaf', []),
        ('34', 'الاحتياطيات', 'Reserves', 'equity', 'folder', [
            ('341', 'احتياطي نظامي', 'Statutory Reserve', 'equity', 'leaf', []),
            ('342', 'احتياطي عام', 'General Reserve', 'equity', 'leaf', []),
        ]),
    ]),

    # ─── 4. REVENUE ───────────────────────────────────────────
    ('4', 'الإيرادات', 'Revenue', 'revenue', 'folder', [
        ('41', 'الإيرادات التشغيلية', 'Operating Revenue', 'revenue', 'folder', [
            ('411', 'مبيعات داخل المحل', 'Sales — Dine-in', 'revenue', 'leaf', []),
            ('412', 'مبيعات خارجي (Takeaway)', 'Sales — Takeaway', 'revenue', 'leaf', []),
            ('413', 'مبيعات تطبيقات التوصيل', 'Sales — Delivery Apps', 'revenue', 'folder', [
                ('4131', 'هنقرستيشن', 'HungerStation', 'revenue', 'leaf', []),
                ('4132', 'جاهز', 'Jahez', 'revenue', 'leaf', []),
                ('4133', 'مرسول', 'Mrsool', 'revenue', 'leaf', []),
                ('4134', 'ذي تشيفز', 'The Chefz', 'revenue', 'leaf', []),
                ('4135', 'تطبيقات أخرى', 'Other Apps', 'revenue', 'leaf', []),
            ]),
            ('414', 'مبيعات الضيافة (Catering)', 'Sales — Catering', 'revenue', 'leaf', []),
            ('415', 'مبيعات الجملة', 'Sales — Wholesale', 'revenue', 'leaf', []),
        ]),
        ('42', 'الإيرادات الأخرى', 'Other Income', 'revenue', 'folder', [
            ('421', 'خصومات مكتسبة من الموردين', 'Discounts Received', 'revenue', 'leaf', []),
            ('422', 'أرباح جرد (زيادة)', 'Stock Gain', 'revenue', 'leaf', []),
            ('423', 'إيرادات فوائد', 'Interest Income', 'revenue', 'leaf', []),
            ('424', 'إيرادات متنوعة', 'Miscellaneous Income', 'revenue', 'leaf', []),
        ]),
        ('43', 'تعديلات المبيعات (دائن مقابل)', 'Sales Adjustments (Contra)', 'revenue', 'folder', [
            ('431', 'مرتجعات المبيعات', 'Sales Returns', 'revenue', 'leaf', []),
            ('432', 'الخصومات الممنوحة', 'Sales Discounts Given', 'revenue', 'leaf', []),
        ]),
    ]),

    # ─── 5. COGS ──────────────────────────────────────────────
    ('5', 'تكلفة المبيعات (COGS)', 'Cost of Goods Sold', 'expense', 'folder', [
        ('51', 'التكلفة المباشرة', 'Direct Cost', 'expense', 'folder', [
            ('511', 'تكلفة مبيعات — القهوة', 'COGS — Coffee', 'expense', 'leaf', []),
            ('512', 'تكلفة مبيعات — الطعام', 'COGS — Food', 'expense', 'leaf', []),
            ('513', 'تكلفة مبيعات — المعجنات والحلويات', 'COGS — Bakery & Pastry', 'expense', 'leaf', []),
            ('514', 'تكلفة مبيعات — المشروبات الباردة', 'COGS — Cold Beverages', 'expense', 'leaf', []),
            ('515', 'تكلفة التغليف', 'Packaging Cost', 'expense', 'leaf', []),
        ]),
        ('52', 'تعديلات المخزون والهدر', 'Inventory Adjustments & Waste', 'expense', 'folder', [
            ('521', 'الهدر والتلف', 'Stock Loss & Spoilage', 'expense', 'folder', [
                ('5211', 'هدر المواد الخام', 'Spoilage — Raw Materials', 'expense', 'leaf', []),
                ('5212', 'هدر المنتجات الجاهزة', 'Spoilage — Finished Goods', 'expense', 'leaf', []),
                ('5213', 'تالف منتهي الصلاحية', 'Expired Stock', 'expense', 'leaf', []),
                ('5214', 'هدر التشغيل (انسكاب)', 'Operational Spillage', 'expense', 'leaf', []),
                ('5215', 'مرتجعات العملاء (هدر)', 'Customer Returns Waste', 'expense', 'leaf', []),
            ]),
            ('522', 'فروقات الإنتاج', 'Production Variance', 'expense', 'leaf', []),
            ('523', 'فروقات سعر المشتريات', 'Purchase Price Variance', 'expense', 'leaf', []),
        ]),
        ('53', 'الأجور المباشرة', 'Direct Labor', 'expense', 'folder', [
            ('531', 'رواتب موظفي المطبخ', 'Kitchen Staff Wages', 'expense', 'leaf', []),
            ('532', 'رواتب الباريستا', 'Barista Wages', 'expense', 'leaf', []),
        ]),
    ]),

    # ─── 6. OPERATING & ADMIN EXPENSES ────────────────────────
    ('6', 'المصروفات التشغيلية والإدارية', 'Operating & Administrative Expenses', 'expense', 'folder', [
        ('61', 'مصروفات تشغيل الفروع', 'Branch Operating Expenses', 'expense', 'folder', [
            ('611', 'الرواتب والأجور', 'Salaries & Wages', 'expense', 'folder', [
                ('6111', 'رواتب موظفي الخدمة', 'Service Staff Salaries', 'expense', 'leaf', []),
                ('6112', 'رواتب الكاشير', 'Cashier Salaries', 'expense', 'leaf', []),
                ('6113', 'الحوافز والمكافآت', 'Bonuses & Incentives', 'expense', 'leaf', []),
                ('6114', 'العمل الإضافي', 'Overtime', 'expense', 'leaf', []),
            ]),
            ('612', 'مزايا الموظفين', 'Employee Benefits', 'expense', 'folder', [
                ('6121', 'حصة المنشأة في التأمينات (GOSI)', 'GOSI Employer Contribution', 'expense', 'leaf', []),
                ('6122', 'التأمين الصحي', 'Health Insurance', 'expense', 'leaf', []),
                ('6123', 'مخصص نهاية الخدمة', 'EoS Provision', 'expense', 'leaf', []),
                ('6124', 'التدريب والتطوير', 'Training & Development', 'expense', 'leaf', []),
            ]),
            ('613', 'الإيجارات', 'Rent', 'expense', 'folder', [
                ('6131', 'إيجار الفروع', 'Branch Rent', 'expense', 'leaf', []),
                ('6132', 'إيجار المستودعات', 'Warehouse Rent', 'expense', 'leaf', []),
                ('6133', 'إيجار المكاتب الإدارية', 'Admin Office Rent', 'expense', 'leaf', []),
            ]),
            ('614', 'المنافع العامة', 'Utilities', 'expense', 'folder', [
                ('6141', 'الكهرباء', 'Electricity', 'expense', 'leaf', []),
                ('6142', 'الماء', 'Water', 'expense', 'leaf', []),
                ('6143', 'الإنترنت والاتصالات', 'Internet & Telephone', 'expense', 'leaf', []),
                ('6144', 'الغاز', 'Gas', 'expense', 'leaf', []),
            ]),
            ('615', 'الصيانة والإصلاحات', 'Maintenance & Repairs', 'expense', 'folder', [
                ('6151', 'صيانة المعدات', 'Equipment Maintenance', 'expense', 'leaf', []),
                ('6152', 'صيانة المباني', 'Building Maintenance', 'expense', 'leaf', []),
                ('6153', 'صيانة المركبات', 'Vehicle Maintenance', 'expense', 'leaf', []),
            ]),
            ('616', 'النظافة والتعقيم', 'Cleaning & Sanitation', 'expense', 'leaf', []),
            ('617', 'الأمن والحراسة', 'Security', 'expense', 'leaf', []),
        ]),
        ('62', 'المصروفات الإدارية', 'Administrative Expenses', 'expense', 'folder', [
            ('621', 'رواتب الإدارة', 'Admin Salaries', 'expense', 'leaf', []),
            ('622', 'مستلزمات مكتبية', 'Office Supplies', 'expense', 'leaf', []),
            ('623', 'الأتعاب المهنية', 'Professional Fees', 'expense', 'folder', [
                ('6231', 'أتعاب قانونية', 'Legal Fees', 'expense', 'leaf', []),
                ('6232', 'أتعاب محاسبية ومراجعة', 'Accounting & Audit Fees', 'expense', 'leaf', []),
                ('6233', 'استشارات', 'Consulting Fees', 'expense', 'leaf', []),
            ]),
            ('624', 'الرسوم الحكومية', 'Government Fees', 'expense', 'folder', [
                ('6241', 'رسوم البلدية', 'Municipality Fees', 'expense', 'leaf', []),
                ('6242', 'السجل التجاري والتراخيص', 'Commercial Registration', 'expense', 'leaf', []),
                ('6243', 'رسوم السعودة', 'Saudization Fees', 'expense', 'leaf', []),
            ]),
            ('625', 'الرسوم البنكية ورسوم الدفع', 'Bank & Payment Fees', 'expense', 'folder', [
                ('6251', 'مصاريف البنوك', 'Bank Charges', 'expense', 'leaf', []),
                ('6252', 'عمولات نقاط البيع', 'POS Transaction Fees', 'expense', 'leaf', []),
                ('6253', 'رسوم بوابات الدفع الإلكترونية', 'Payment Gateway Fees', 'expense', 'leaf', []),
            ]),
            ('626', 'التأمين', 'Insurance', 'expense', 'leaf', []),
            ('627', 'تكنولوجيا المعلومات والاشتراكات', 'IT & Subscriptions', 'expense', 'folder', [
                ('6271', 'اشتراكات البرمجيات', 'Software Subscriptions', 'expense', 'leaf', []),
                ('6272', 'الخدمات السحابية', 'Cloud Services', 'expense', 'leaf', []),
                ('6273', 'رسوم نظام POS', 'POS System Fees', 'expense', 'leaf', []),
            ]),
        ]),
        ('63', 'التسويق والمبيعات', 'Marketing & Sales', 'expense', 'folder', [
            ('631', 'الإعلانات', 'Advertising', 'expense', 'leaf', []),
            ('632', 'وسائل التواصل الاجتماعي', 'Social Media', 'expense', 'leaf', []),
            ('633', 'العروض والخصومات الترويجية', 'Promotions & Discounts', 'expense', 'leaf', []),
            ('634', 'الهوية البصرية والتصميم', 'Branding & Design', 'expense', 'leaf', []),
            ('635', 'برامج ولاء العملاء', 'Customer Loyalty Programs', 'expense', 'leaf', []),
        ]),
        ('64', 'الإهلاك والإطفاء', 'Depreciation & Amortization', 'expense', 'folder', [
            ('641', 'مصروف الإهلاك', 'Depreciation Expense', 'expense', 'leaf', []),
            ('642', 'مصروف الإطفاء', 'Amortization Expense', 'expense', 'leaf', []),
        ]),
        ('65', 'الفرنشايز والامتياز', 'Franchise & Royalty', 'expense', 'folder', [
            ('651', 'مصروف الفرنشايز (Royalty)', 'Royalty Expense', 'expense', 'leaf', []),
            ('652', 'رسوم تسويق الفرنشايز', 'Franchise Marketing Fee', 'expense', 'leaf', []),
        ]),
        ('66', 'الضيافة والمتنوعات', 'Hospitality & Sundries', 'expense', 'folder', [
            ('661', 'وجبات الموظفين', 'Staff Meals', 'expense', 'leaf', []),
            ('662', 'ضيافة العملاء', 'Customer Hospitality', 'expense', 'leaf', []),
            ('663', 'مصروفات متنوعة', 'Miscellaneous Expenses', 'expense', 'leaf', []),
        ]),
        ('67', 'تكاليف التمويل', 'Finance Costs', 'expense', 'folder', [
            ('671', 'فوائد القروض', 'Interest Expense', 'expense', 'leaf', []),
            ('672', 'فوائد التزام الإيجار (IFRS 16)', 'Lease Interest', 'expense', 'leaf', []),
            ('673', 'خسائر صرف العملات', 'FX Loss', 'expense', 'leaf', []),
        ]),
    ]),
]

out = []
counter = [0]


def visit(node, parent_code, depth):
    code, name_ar, name_en, acc_type, kind, children = node
    counter[0] += 1
    out.append({
        'code': code,
        'nameAr': name_ar,
        'nameEn': name_en,
        'type': acc_type,
        'parentCode': parent_code,
        'level': depth + 1,
        'kind': kind,
        'order': counter[0],
    })
    for child in children:
        visit(child, code, depth + 1)


for root in tree:
    visit(root, '', 0)

# Sanity checks
codes = {a['code'] for a in out}
broken = [a for a in out if a['parentCode'] and a['parentCode'] not in codes]
if broken:
    print('ERROR: broken parents:', broken)
    sys.exit(1)

for a in out:
    if a['parentCode']:
        p = next(x for x in out if x['code'] == a['parentCode'])
        if a['level'] != p['level'] + 1:
            print('ERROR: level mismatch on', a['code'], 'parent', p['code'])
            sys.exit(1)

# Duplicate-code check
dup = [c for c, n in Counter(a['code'] for a in out).items() if n > 1]
if dup:
    print('ERROR: duplicate codes:', dup)
    sys.exit(1)

with open('db/coa-template.json', 'w', encoding='utf-8') as f:
    json.dump(out, f, ensure_ascii=False, indent=2)

print('Wrote', len(out), 'accounts to db/coa-template.json')
print('Roots (L1):', [a['nameAr'] for a in out if a['level'] == 1])
print('Level distribution:', dict(sorted(Counter(a['level'] for a in out).items())))
print('Type distribution:', dict(Counter(a['type'] for a in out)))
print('Kind distribution:', dict(Counter(a['kind'] for a in out)))
