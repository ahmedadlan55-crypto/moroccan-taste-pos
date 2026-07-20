# تقرير جرد دليل الحسابات وميزان المراجعة — محلي فقط

> **تحذير:** هذا التقرير يعكس قاعدة بيانات `moroccan_taste_pos` على المضيف `DESKTOP-PG1F13S` فقط. **لا يمثل بيانات الإنتاج.** لم يُدقَّق الإنتاج بعد (بموافقة المستخدم على تأجيله).

تاريخ التوليد: 2026-07-20T05:13:57.340Z — MySQL 8.4.9

## 1. الإجماليات

- إجمالي الحسابات: **118**
- حسب النوع: {"asset":32,"liability":17,"equity":7,"revenue":14,"expense":48}
- حسب المستوى: {"1":5,"2":11,"3":38,"4":64}
- نشط/غير نشط: {"active":118}
- Folder/Posting: {"folder":32,"posting":86}
- gl_accounts has NO company_id/legal_entity_id column today — counts below are for the single implicit legal scope (companies row CO-MAIN). Cannot be broken out per company until that column exists (see ADR 0002).

## 2. سلامة الشجرة

- الجذور (8): 1 الأصول، 2 الالتزامات، 3 حقوق الملكية، 4 الإيرادات، 5 المصروفات، 5410 التكاليف غير المباشرة، 5500 عمولات منصات التوصيل، 6100 مصروف رسوم الامتياز
- أيتام (parent_id لا يطابق حسابًا) (0): 
- Self-parent (0): 
- حلقات (0): 
- اختلاف level المخزَّن عن عمق الشجرة الفعلي (6): 1130 عهد الموظفين (مخزَّن=3, فعلي=4)؛ 4203 إيرادات أخرى (مخزَّن=3, فعلي=2)؛ 5205 مصروفات أخرى (مخزَّن=3, فعلي=2)؛ 5410 التكاليف غير المباشرة (مخزَّن=4, فعلي=1)؛ 5500 عمولات منصات التوصيل (مخزَّن=4, فعلي=1)؛ 6100 مصروف رسوم الامتياز (مخزَّن=4, فعلي=1)

## 3. Parent غير تجميعي (له أبناء لكن is_folder=0)

لا شيء

## 4. اختلاف النوع بين الأب والابن

لا شيء

## 5. أكواد مكررة

العدد: 0 — gl_accounts.code has a UNIQUE constraint; non-zero here would mean the constraint is missing/bypassed.

## 6. Posting على Folder

لا شيء

## 7. حسابات غير نشطة لها حركة

لا شيء

## 8. قيود بـ account_id = NULL (6)

journal JE-20260713 (2026-01-07, posted) — كود مسجَّل تاريخيًا: 8A74059 "CVS-A-74059" مدين=100.00 دائن=0.00؛ journal JE-20260713 (2026-01-07, posted) — كود مسجَّل تاريخيًا: 8B74059 "CVS-B-74059" مدين=0.00 دائن=100.00؛ journal JE-20260714 (2026-01-07, posted) — كود مسجَّل تاريخيًا: 8A87962 "CVS-A-87962" مدين=100.00 دائن=0.00؛ journal JE-20260714 (2026-01-07, posted) — كود مسجَّل تاريخيًا: 8B87962 "CVS-B-87962" مدين=0.00 دائن=100.00؛ journal JE-20260715 (2026-01-07, posted) — كود مسجَّل تاريخيًا: 8A01686 "CVS-A-01686" مدين=100.00 دائن=0.00؛ journal JE-20260715 (2026-01-07, posted) — كود مسجَّل تاريخيًا: 8B01686 "CVS-B-01686" مدين=0.00 دائن=100.00

## 9. اختلاف gl_accounts.balance عن المُشتق من القيود المرحّلة

> Per rule 6, gl_accounts.balance must never be treated as the source of truth — this section exists only to show HOW STALE it already is.

1110 النقدية — مخزَّن=23257، مُشتق=85؛ 1120 البنوك — مخزَّن=-18088، مُشتق=-715؛ 1150 ذمم العملاء — مخزَّن=8923.5، مُشتق=0؛ 1200 المخزون الرئيسي — مخزَّن=95630.48، مُشتق=1315؛ 1210 مخزون الفروع — مخزَّن=-69700، مُشتق=50؛ 1220 الإنتاج تحت التشغيل — مخزَّن=230.4، مُشتق=0؛ 1230 المنتجات التامة — مخزَّن=945.6، مُشتق=700؛ 1290 ضريبة المدخلات — مخزَّن=2160، مُشتق=180؛ 2100 ذمم الموردين — مخزَّن=-400، مُشتق=400؛ 2140 دفعات مقدمة من العملاء — مخزَّن=-4980، مُشتق=0؛ 2150 بضاعة مستلمة لم تُفوتر (GRNI) — مخزَّن=-7400، مُشتق=0؛ 2210 ضريبة المخرجات — مخزَّن=-4457.75، مُشتق=97.83؛ 2310 مستحقات الامتياز — مخزَّن=-59.84، مُشتق=0؛ 4100 إيرادات المبيعات — مخزَّن=-31094.75، مُشتق=652.17؛ 4203 إيرادات أخرى — مخزَّن=-500، مُشتق=0؛ 4910 إيراد فروقات جرد — مخزَّن=-12644، مُشتق=555؛ 5100 تكلفة المبيعات — مخزَّن=13016.5، مُشتق=0؛ 5123 تالف منتهي الصلاحية — مخزَّن=490، مُشتق=10؛ 5205 مصروفات أخرى — مخزَّن=100، مُشتق=0؛ 5300 فروقات الجرد — مخزَّن=6848.36، مُشتق=80؛ 6100 مصروف رسوم الامتياز — مخزَّن=59.84، مُشتق=0

## 10. انحراف الأكواد الثابتة القديمة (CORE_ACCOUNTS / SALARY_ACCOUNTS)

> These are the accounts that lib/glPosting.js ensureCoreAccounts() / lib/hrGLPosting.js ensurePayrollAccounts() will SILENTLY RE-CREATE (with parent lookups keyed to the OLD 1-3 digit scheme) the next time ANY journal posts, if missing. A non-empty list here on a database already seeded from the new 6-digit template is the hybrid-tree landmine described in the brief, confirmed live.

- CORE_ACCOUNTS المفقودة من الشجرة الحالية: لا شيء (كلها موجودة بالفعل — الشجرة الحالية لا تزال بالنظام القديم)
- SALARY_ACCOUNTS المفقودة: SALARY_EXPENSE=5301؛ ALLOWANCES_EXPENSE=5302؛ OVERTIME_EXPENSE=5303؛ GOSI_COMPANY_SHARE=5304؛ SALARIES_PAYABLE=2201؛ GOSI_EMPLOYEE_SHARE=2202؛ PENALTY_REVENUE=4201
- SALARY parents المفقودة: 22

## 11. تصنيف ضريبي مشكوك (tax_nature)

> routes/erp.js _deriveTaxNature() (used only at wipe-and-seed time) maps ANY 6-digit code starting '2003' to vat_output — this mislabels 200303 GOSI / 200304 Withholding / 200305 Zakat Payable in the template. Confirmed by static read of routes/erp.js:1053-1068 (this section flags any LIVE accounts with a similar live mismatch, independently).

5215 تأمينات اجتماعية (GOSI) — tax_nature=none، المتوقع=gosi

## 12. مرشحو Account Role (لم يُعيَّن أي منها تلقائيًا)

- **CASH_ON_HAND**: 1101 النقدية، 111 النقدية والبنوك، 1110 النقدية
- **BANK**: 111 النقدية والبنوك، 11102 الحسابات البنكية الجارية، 1120 البنوك، 533 العمولات البنكية ورسوم شبكات الدفع
- **ACCOUNTS_RECEIVABLE**: 1150 ذمم العملاء، 2140 دفعات مقدمة من العملاء، 5125 مرتجعات العملاء (هدر)
- **ACCOUNTS_PAYABLE**: 2100 ذمم الموردين
- **INVENTORY**: 112 المخزون، 11201 مخزون المواد الخام (البن، الحليب، المنكهات)، 11202 مخزون المنتجات الجاهزة (المخبوزات، الحلويات)، 11203 مخزون مواد التغليف والتعبئة (الأكواب، الأكياس)، 11204 مخزون المنتجات تحت التشغيل (WIP)، 11205 مخزون المنتجات التامة (Finished Goods)، 1200 المخزون الرئيسي، 1210 مخزون الفروع
- **WORK_IN_PROGRESS**: 11204 مخزون المنتجات تحت التشغيل (WIP)، 1220 الإنتاج تحت التشغيل
- **FINISHED_GOODS**: لا مرشح محلي
- **INPUT_VAT**: 114 ضريبة المدخلات، 1290 ضريبة المدخلات
- **OUTPUT_VAT**: 2210 ضريبة المخرجات
- **SALES_REVENUE**: 4100 إيرادات المبيعات
- **SALES_DISCOUNT**: لا مرشح محلي
- **COGS**: 51 تكلفة المبيعات (COGS)، 5100 تكلفة المبيعات
- **INVENTORY_GAIN_LOSS**: 4910 إيراد فروقات جرد
- **PAYROLL_PAYABLE**: 21201 رواتب وأجور مستحقة
- **ZAKAT**: لا مرشح محلي
- **DELIVERY_COMMISSION**: 5500 عمولات منصات التوصيل
- **FRANCHISE_FEE**: 2310 مستحقات الامتياز، 6100 مصروف رسوم الامتياز
- **ROUNDING**: لا مرشح محلي
- **CUSTOMER_ADVANCES**: لا مرشح محلي
- **SUPPLIER_ADVANCES**: لا مرشح محلي

## 13. سلامة القيود (gl_journals)

- الإجمالي: 55 (posted=55, draft=0, approved=0)
- إجمالي مدين=7905.00, إجمالي دائن=7905.00
- قيود غير متوازنة على مستوى الرأس (0): لا شيء
