# ترشيد أسطح تقارير المبيعات — وثيقة المرحلة الأولى (الجرد، الأدلة، القرارات)

**السبرنت:** Unified Sales Analytics Hub — Phase 1 (Rationalization)

## 1. الهوية والمنهجية

- **الأساس (Baseline):** worktree `wt-sales-hub` على الفرع `sprint/sales-hub-20260724`، HEAD = `f494468`. كل استشهاد `file:line` في هذه الوثيقة مأخوذ من هذه النقطة تحديدًا.
- **الهدف:** حصر **كل** سطح تقارير يخص المبيعات/المدفوعات/الورديات/الأصناف/المرتجعات (واجهةً وخلفيةً)، وتصنيف كل سطح: **Keep / Merge / Retire / Fix-before-merge / Delete**، مع دليل ملف+سطر لكل ادعاء — تمهيدًا لهَب تقارير مبيعات موحّد تحت `/reports/sales/*` (16 صفحة فرعية؛ ورقة `rp-sales` الوحيدة في الـmanifest تكتسب `subRoutes`).
- **منهجية الإثبات:** لا قرار يُبنى على ذاكرة أو ادعاء سابق. كل تصنيف أدناه تحقّقتُ منه بقراءة الملف المعني سطرًا سطرًا و/أو بـ`rg` شامل تُلصق أوامره ونتائجه كما خرجت. أي ادعاء من المصفوفة المعتمدة **نقضه** الفحص مُعلَّم بوضوح في القسم 2 — القرار فيه لمالك الدمج، لا لهذه الوثيقة. (درس مثبَّت في سجل المشروع: «تحقّق بتشغيل/قراءة المسار الفعلي، لا بأن دالة بهذا الاسم موجودة».)
- **حدود هذه المرحلة:** وثيقة + سكربت فحص فقط. **لا حذف ولا تعديل سلوك في هذا الكوميت.** الحذف الفعلي يقع في «كوميت الإخراج» اللاحق وفق البروتوكول في القسم 5.

---

## 2. ⚠️ تعارضان نقض فيهما التحقق المصفوفة المعتمدة — **حُسما ونُفِّذا في كوميت الإخراج (انظر §11.6)**

### 2.1 `GET /api/erp/reports/balance-sheet` ليس يتيمًا — لا يُحذف كما هو مخطط
> **قرار منفَّذ (كوميت الإخراج):** إبقاء المعالج كما هو — `FinancialRatios.tsx` يستهلكه حيًّا. مثبَّت بفحص 200 في `tests/integration/retiredSurfaces.api.test.js` (balance-sheet + pnl)، وأُزيلت علامته المعلّقة من سكربت الفحص.

المصفوفة المعتمدة اعتبرت معالج `erp-core` القديم للميزانية «غير مستخدم لأن الواجهة تستهلك `-ifrs`». التحقق:

- صفحة الميزانية الرسمية تستهلك فعلًا النسخة IFRS: `frontend/erp/src/modules/accounting/api.ts:206` → `GET /erp/reports/balance-sheet-ifrs` (المعالج: `routes/erp/reports/balance-sheet.js`، مُركَّب عبر `routes/erp.js:101`).
- **لكن** صفحة النسب المالية الحية `/accounting/financial-ratios` تستهلك المعالج القديم مباشرة:
  - `frontend/erp/src/modules/accounting/pages/FinancialRatios.tsx:28` → `` apiClient.get(`/erp/reports/balance-sheet`, { params: { asOf } }) ``
  - المعالج القديم: `routes/erp-core.js:2359`.
- بل إن ملف IFRS نفسه يوثّق السبب التاريخي للاحقة `-ifrs`: «erp-core has a legacy /reports/balance-sheet that mounts first and was shadowing us» — `routes/erp/reports/balance-sheet.js:22-24`.

**الأثر:** حذف المعالج القديم كما هو الآن يكسر صفحة النسب المالية. الخيار السليم: تحويل `FinancialRatios.tsx` إلى `-ifrs` أولًا (مع مواءمة `lib/ratios.ts#extractInputs` لشكل الاستجابة المختلف)، **ثم** حذف المعالج القديم. مُعلَّم `pending` في سكربت الفحص — لا يؤثر على بوابة الإخراج حتى يُحسم.

### 2.2 ملفا aging «المظلَّلان» هما اللذان يطابقان عقد الواجهة — الصفحتان الحيّتان تتلقيان اليوم شكلًا لا تفهمانه
> **قرار منفَّذ (كوميت الإخراج) — الخيار (ب) بعكس اتجاه الحذف المعتمد:** حُذف معالجا `erp-core` (‏`/reports/ar-aging` و`/reports/ap-aging`) وبقي الملفان النمطيان `routes/erp/reports/{ar,ap}-aging.js` — وهما الآن **المعالجان الفعليان** (mount في `server.js:761-762` لم يعد مظلَّلًا). إثبات حي في §11.6: `asOfDate` يُقرأ فعلًا، والاستجابة بشكل `AgingResponse` الذي بُنيت عليه الصفحتان (`grandBuckets` بمفاتيح `0-30…120+` + مصفوفة `customers`/`suppliers`)، والشكل القديم (`totals.current/1_30`) زال.

المصفوفة اعتبرت `routes/erp/reports/ar-aging.js` + `ap-aging.js` «كودًا ميتًا مظلَّلًا» يُحذف. شقّ التظليل **صحيح ومثبَت**:

- `server.js:750` يركّب `erp-core` أولًا (وتعليق `server.js:748-749` يشرح أن الأسبقية مقصودة ضد `routes/erp.js` القديم)، ثم `server.js:758-759` يركّب الملفين النمطيين على نفس المسارات.
- `erp-core` يعرّف نفس المسارين: `routes/erp-core.js:2509` (`/reports/ar-aging`) و`:2577` (`/reports/ap-aging`) — فأي طلب يلتقطه `erp-core` أولًا والملفان النمطيان **لا يصلهما طلب أبدًا**.

**لكن الفحص كشف ما هو أخطر من مجرد تظليل:**

| | معالج `erp-core` (الذي يجيب فعلًا) | الملف النمطي المظلَّل | ما ترسله/تتوقعه الواجهة |
|---|---|---|---|
| البارامتر | `asOf` (`erp-core.js:2511`) | `asOfDate` (`ar-aging.js:42`) | ترسل `asOfDate` (`api.ts:340,352`) |
| فلاتر | لا brand/branch | `brandId`/`branchId` (`ar-aging.js:43-44`) | لا تُرسل حاليًا |
| السلال | `current / 1_30 / 31_60 / 61_90 / 90_plus` (`erp-core.js:2537`) | `0-30 / 31-60 / 61-90 / 91-120 / 120+` (`ar-aging.js:26-32`) | `0-30 … 120+` (`api.ts:308`) |
| شكل الاستجابة | `{ asOf, totals, items }` (`erp-core.js:2557-2569`) | `{ asOfDate, customers, grandTotal, grandBuckets, overdue90PlusRatio }` (`ar-aging.js:129-145`) | النوع `AgingResponse` = شكل الملف النمطي حرفيًا (`api.ts:323-332`) |
| مصدر البيانات | GL حساب 1150/2100 | `sales` + `customer_payments` | — |

أي أن صفحتَي `/accounting/ar-aging` و`/accounting/ap-aging` الحيّتين (manifest.ts:159-160) تنتظران عقد الملف المظلَّل، بينما الذي يجيبهما فعليًا هو معالج `erp-core` بشكل مغاير تمامًا وبارامتر تاريخ يتجاهل ما تُرسله (`asOfDate` يصل، المعالج يقرأ `asOf` فيسقط للـdefault). **حذف الملفين النمطيين وحده يُثبّت العطل بدل أن يزيله.** الخيارات لمالك الدمج: (أ) نقل منطق/شكل الملفين النمطيين إلى `erp-core` وحذف الملفين، أو (ب) حذف معالجَي `erp-core` وإبقاء النمطيَّين (عكس اتجاه الحذف المعتمد)، أو (ج) عكس ترتيب mount. مُعلَّمة `pending` في السكربت.

*(ملاحظة نطاق: aging تقارير ذمم لا مبيعات مباشرة — دخلت الجرد لأن المصفوفة المعتمدة سمّتها؛ لم أتجاوز التوثيق والتعليم `pending`.)*

---

## 3. جدول الجرد الكامل

مسحتُ مجموعات الـmanifest (`frontend/erp/src/app/navigation/manifest.ts`) بنفسي: `overview` (:56-65)، `sales` (:66-78)، `pos-admin` (:93-103)، `accounting` (:137-171)، `banking` (:172-184)، `reports` (:213-225)، `administration` (:226-242) — إضافة إلى أسطح لا تظهر في الـmanifest (حوار POS، وendpoints خلفية بلا مستهلك). لم يظهر أي سطح تقارير مبيعات خارج ما يلي.

### 3.1 أسطح الواجهة (ERP React)

| # | السطح | المسار | الملف | الـendpoint | cap (manifest) | القرار |
|---|---|---|---|---|---|---|
| 1 | مركز تقارير المبيعات (link-hub) | `/reports/sales` | `modules/reports/reportLinks.tsx:53-65` + `pages/ReportsHub.tsx` | لا شيء (روابط فقط) | `reports.view` (manifest.ts:217) | **Merge** — يصبح الهَب |
| 2 | التقارير المحفوظة | `/reports/saved` | `modules/reports/pages/SavedReports.tsx` | لا شيء (localStorage فقط) | `reports.view` (manifest.ts:223) | **Fix-before-merge** |
| 3 | تحليلات المبيعات | `/accounting/sales-analytics` | `modules/accounting/pages/SalesAnalytics.tsx` | `GET /api/erp/reports/sales-analytics` | `sales.reports.advanced` (manifest.ts:165) | **Retire → redirect** |
| 4 | تقارير الكاشير | `/pos-admin/reports` | `modules/pos-admin/pages/ReportsPage.tsx` | `GET /api/shifts/` (routes/shifts.js:1282) + حساب عميل `summarizeShifts` (`pos-admin/lib/shifts.ts:44-57`) | `pos.reports.view` (manifest.ts:101) | **Retire (تقسيم)** |
| 5 | ورديات الكاشير (تشغيلي) | `/pos-admin/shifts` | `modules/pos-admin` | `GET /api/shifts/` + `closing-data-v3/:id` (`pos-admin/lib/api.ts:33-37`) | `pos.shifts.view` (manifest.ts:98) | **Keep** — هدف الحفر التشغيلي |
| 6-12 | مجموعة المبيعات التشغيلية | `/sales/{orders,invoices,returns,payments,channels,pricing}` + `/customers` | `modules/sales`, `modules/customers` | متعددة | manifest.ts:70-77 | **Keep** — أهداف حفر الهَب |
| 13 | لوحة النظرة العامة | `/overview` | `modules/overview/_common.tsx:39` | `GET /api/dashboard/overview` (routes/dashboard.js:102، mount server.js:777) | `overview.view` (manifest.ts:60) | **Keep + Fix** (§6.3، §6.7) |
| 14-16 | الخزائن/الإقفال/التسوية | `/banking/{cashboxes,cash-closing,reconciliation}` | `modules/banking` | متعددة | `banking.view` (manifest.ts:176,181,182) | **Keep** |
| 17 | الضريبة (إعداد + إقرار VAT) | `/administration/tax` | `modules/administration` | متعددة | `administration.tax` (manifest.ts:237) | **Keep** — الهَب سيثبت تكافؤ Σvat ضدها |
| 18 | ربحية GL | `/accounting/profitability` | `modules/accounting` | P&L من GL (يشمل المصروفات) | `accounting.reports.view` (manifest.ts:163) | **Keep** — نطاق محاسبي مختلف عن ربحية المبيعات |
| 19-20 | أعمار الذمم | `/accounting/{ar,ap}-aging` | `modules/accounting` | `GET /erp/reports/{ar,ap}-aging` | `accounting.reports.view` (manifest.ts:159-160) | **Keep** الصفحتين + تعارض §2.2 في الخلفية |

بقية أوراق مجموعة `reports` — `/reports/{inventory,purchasing,financial,people,operations}` (manifest.ts:218-222) — link-hubs خارج نطاق المبيعات، تبقى كما هي **باستثناء** بطاقتين تُعاد وجهتهما (§5.2 بند 6).

### 3.2 أسطح POS (تبقى)

| السطح | الملف | الـendpoint |
|---|---|---|
| حوار تقرير X/Z للوردية | `frontend/pos/src/components/dialogs/ShiftDialog.tsx` (التوثيق :19) عبر `frontend/pos/src/lib/api.ts:547,566` | `GET /api/shifts/:id/full-report` — المعالج `routes/shifts.js:793` |

### 3.3 endpoints خلفية بلا أي مستهلك واجهة (مثبَت بالجرد — §5.3)

| الـendpoint | المعالج | ملاحظة الجودة | القرار |
|---|---|---|---|
| `GET /api/sales/report/advanced` | `routes/sales.js:2950` (mount `/api/sales` في server.js:672) | بلا `requireCapability` على المسار (قارن `bulk-delete` :2918)؛ VAT/خصومات بمنطق legacy | **Delete** |
| `GET /api/erp/reports/sales-by-channel` | `routes/erp-core.js:2963` | catch → HTTP 200 `{success:false}` (:3035-3038)؛ فلتر `deleted_at` §6.6 | **Delete** |
| `GET /api/erp/reports/channel-settlements` | `routes/erp-core.js:3047` | catch → 200 (:3124-3127)؛ فلتر `deleted_at` :3054 | **Delete** |
| `GET /api/erp/reports/discounts-given` | `routes/erp-core.js:3134` | catch → 200 (:3178-3181)؛ فلتر `deleted_at` :3141 | **Delete** |
| `GET /api/erp/reports/waste-analytics` | `routes/erp-core.js:3188` | catch → 200 (:3261) | **Delete** — النية محفوظة لـ`/reports/inventory` مستقبلًا (§8) |
| `GET /api/erp/reports/royalty-reconciliation` | `routes/erp-core.js:3268` | catch → 200 (:3319)؛ يقرأ `royalty_runs` مباشرة | **Delete** — انظر تحذير `_royaltyBase` أدناه |
| `GET /api/erp/reports/sales-analytics` | `routes/erp-core.js:2792` | له مستهلكان: الصفحة (بند 3 أعلاه) واختبار `tests/integration/reportsEquations.api.test.js:177,192` | **Keep خلال السبرنت** → يُحذف في كوميت الإخراج بعد إعادة توجيه الاختبار للمحرك الجديد |

**⚠ تحذير `_royaltyBase`:** الدالة `routes/erp-core.js:1465` **ليست** جزءًا من `royalty-reconciliation` ولا يجوز حذفها معه — إنها قلب صفحة الرويالتي **الحية**: `Royalties.tsx:203` → `POST /erp/royalty-runs/compute` (`erp-core.js:1517`) الذي يستدعيها في `:1527`. معالج `royalty-reconciliation` (:3268-3320) لا يستدعيها إطلاقًا (يقرأ `royalty_runs` بـSELECT مباشر)، فحذف المعالج وحده آمن.

### 3.4 O2C Reports API — خامل، خارج النطاق

- `routes/order-to-cash/reports.js` (list/run/export — :21، :30، :37) فوق `services/order-to-cash/O2CReportingService.js` — **14 تقريرًا**: 13 مفتاحًا في `REPORTS` (:249-262) + `customer-statement` (:279).
- مقفول خلف علم `ORDER_TO_CASH_ENABLE` (mount مشروط `server.js:653-666`) وقدرات `ar_reports.view`/`o2c.data_quality`/`o2c.export`.
- **صفر مستهلكين في الواجهة** — الجرد التالي لم يُظهر إلا سلسلتَي القدرة في كتالوج الصلاحيات (وليست استدعاءات):

```
rg -n "order-to-cash/reports|ar_reports" frontend/erp/src frontend/pos/src e2e public -g '!**/dist/**'
→ frontend/erp/src/app/permissions/catalog.ts:91  "ar_reports.view",
→ frontend/erp/src/app/permissions/can.ts:91      "ar_reports.view": [...]
```

**القرار:** Keep dormant — لا يُلمس في هذا السبرنت.

---

## 4. مصفوفة القرار التفصيلية

### 4.1 `/reports/sales` — **Merge** (يصبح الهَب الجديد)

- اليوم: link-hub خالص — `ReportsHub.tsx:10-47` شبكة بطاقات `<Link>` بلا أي استدعاء API، تقرأ القسم `"/reports/sales"` من `reportLinks.tsx:53-65` (توثيق الفلسفة :1-3: «hub لا يكرر الصفحات، يشير للمسارات القانونية»).
- الخطة: الورقة `rp-sales` (manifest.ts:217) تكتسب `subRoutes: true` (الآلية موجودة ومجرَّبة — `manifest.ts:34-44`) و16 صفحة فرعية تحت `/reports/sales/*` تصبح صفحات تقارير حقيقية، مع بقاء بطاقات الحفر التشغيلي إلى `/sales/*`.

### 4.2 `/reports/saved` — **Fix-before-merge**

- العلّة المثبتة: `SavedReports.tsx` يقرأ **حصريًا** `localStorage` بالبادئة `adlan.views.` (`SavedReports.tsx:9`، الدالة `readSaved` :18-37 تمشي `window.localStorage` فقط؛ لا يوجد أي `apiClient`/fetch في الملف كله).
- بينما يملك الخادم مخزن عروض محفوظة كاملًا بمشاركة بين المستخدمين: `routes/saved-views.js` — ‏GET/POST/PUT/DELETE ‏`/api/saved-views` (:24-33 للعقد، :92 وما بعده للتنفيذ)، mount في `server.js:687`، والجدول `saved_views` يُنشأ في `server.js:6712-6714`.
- الإصلاح: الصفحة تجلب عروض الخادم وتدمجها مع المحلية (مع تمييز المصدر)، وإلا فالهَب الجديد الذي سيحفظ عروضه في الخادم لن يظهر شيء منه هنا.

### 4.3 `/accounting/sales-analytics` — **Retire → redirect إلى `/reports/sales/executive`**

- السبب: وظيفتها (KPIs + يومي + بالدفع + بالكاشير + بالساعة + أعلى المنتجات) هي نواة الصفحة التنفيذية للهَب؛ وعيوبها الحية موثقة في §6.1-6.2 (فلاتر لا تعمل، تكلفة بالاسم).
- redirect يحفظ `from/to/brandId/branchId` (خريطة §7).
- بروتوكول الإثبات الكامل: §5.1.

### 4.4 `/pos-admin/reports` — **Retire (تقسيم)**

- الشق التحليلي (بطاقات الإجماليات `ReportsPage.tsx:137-144` المحسوبة عميلًا عبر `summarizeShifts` — `shifts.ts:44-57`) → صفحة `/reports/sales/shifts` في الهَب بحساب خادم.
- الشق التشغيلي (جدول الورديات + حفر الوردية الواحدة) → موجود أصلًا في `/pos-admin/shifts` (تبقى) عبر `closing-data-v3/:shiftId` (`pos-admin/lib/api.ts:37`).
- redirect ‏`/pos-admin/reports` → `/reports/sales/shifts`.
- بروتوكول الإثبات الكامل: §5.2.

### 4.5 بقية القرارات

مفصَّلة في جدول الجرد (§3): Keep للأسطح التشغيلية وأهداف الحفر والخزائن والضريبة وO2C الخامل؛ Delete للـendpoints اليتيمة (§3.3 مع أدلة §5.3)؛ pending للتعارضين (§2).

---

## 5. بروتوكولات الإخراج (Retire) — 9 بنود لكل سطح

> القيم الرقمية في جداول التكافؤ **placeholders تُلتقط قبل الحذف مباشرة** على بيئة التطوير بنفس المدخلات على السطحين، وتُلصق في كوميت الإخراج. لا يُعتمد أي حذف قبل امتلاء الجدول وتطابقه (أو توثيق سبب الفرق بندًا بندًا).

### 5.1 بروتوكول إخراج `/accounting/sales-analytics`

1. **التصنيف والسبب:** Retire→redirect. الأصل: `modules/accounting/pages/SalesAnalytics.tsx` (المسار في manifest.ts:165) + hook ‏`useSalesAnalytics` ‏(`accounting/api.ts:1051-1067`). البديل: `/reports/sales/executive` في الهَب. السبب: توحيد؛ والصفحة تحمل عيبَين حيَّين موثقين (§6.1، §6.2).
2. **البديل حي:** يُثبت قبل الحذف بأن `/reports/sales/executive` يعمل ببيانات حقيقية (لقطة + مسار e2e).
3. **جدول تكافؤ المقاييس والفلاتر** — **مُلتقَط قبل الحذف مباشرة** (2026-07-24، بذرة `salesHubSeed` على نافذة 2032-03 مُنسوخة إلى مسار القراءة القديم أيضًا — نفس المستندات في الخطّين؛ التفاصيل والمستخرجات الكاملة في §11.3):

| المقياس | مصدره القديم (erp-core.js) | القيمة القديمة | القيمة الجديدة (POST /api/analytics/query) | الحكم |
|---|---|---|---|---|
| invoiceCount / orders | :2848 | **8** | **8** | ✅ تطابق — الملغي (D5) مستبعد في الخطّين (`zatca_type` قديمًا، `excluded_voided` جديدًا) |
| grossInclVat / invoice_total | :2894 | **1071.50** | **1071.50** | ✅ تطابق (و`net_incl_vat` = 1071.50 كذلك) |
| net / net_ex_vat | :2895 | **950** | **950** | ✅ تطابق — القديم من `tax_subtotals_json`، الجديد من سطور `ar_document_lines` المسجَّلة |
| vat / vat_amount | :2896 | **121.50** | **121.50** | ✅ تطابق |
| netUnknownCount | :2897 | **0** | — (لا مكافئ رقمي) | 🔁 استُبدل بعقد أصدق: المحرك يقرأ سطورًا مُسقَطة لا blob لكل فاتورة، فالمجهول يظهر عبر `meta.completeness` + `maskedMetrics` (والواجهة تعرض «—» لا 0) |
| avgTicket / avg_ticket | :2852 | **133.94** | **118.75** | 📖 فرق تعريف موثَّق: القديم شامل الضريبة (1071.5÷8)، الجديد صافٍ قبلها (950÷8). المصالحة: `net_incl_vat ÷ orders` = 133.94 بالضبط |
| discounts / discounts_total | :2898 | **15.75** | **15.75** | ✅ تطابق |
| cost / cogs | :2899 | **95** | **365** | 📖 الفرق **المتوقَّع والمقصود** (§6.2): القديم = التكلفة **الحالية** من `menu` مربوطة **بالاسم** (7×10 + 5×2 + 3×5)، الجديد = `cost_snapshot` المسجَّل على كل سطر لحظة البيع (البذرة تعمّدت المغايرة لإثبات المصدر). رقم الجديد هو الصحيح تاريخيًّا — تعديل تكلفة اليوم لم يعُد يعيد كتابة ربح الأمس |
| profit / gross_profit | :2901 | **855** | **585** | 📖 نفس سبب سطر التكلفة (net − cost) |
| daily | :2904 | 6 أيام: 204/1، 320/2، 57.5/1، 115/1، 230/1، 145/2 | `calendar_day`: **مطابقة يومًا بيوم** (§11.3) | ✅ تطابق كامل |
| byPayment | :2911 | Mada ‏460/2، Cash ‏407.5/5، Split ‏204/1 | `payment_method` على وقائع الدفع: card ‏560، cash ‏511.5 (+out 57.5)، other out 205 | 📖 ترقية موثَّقة: القديم يصنّف **صف البيع** (فـSplit سلة مستقلة)، الجديد يوزّع أرجل الدفع الفعلية (104 كاش + 100 شبكة من D1) ويُظهر الاستردادات |
| byCashier | :2918 | c1 ‏6/951.5 (avg 158.58)، c2 ‏2/120 (avg 60) | c1 ‏6/951.5 (avg_ticket 138.33)، c2 ‏2/120 (avg 60) | ✅ العدّ والإجمالي متطابقان؛ متوسط c1 يختلف بنفس فرق تعريف avgTicket أعلاه |
| byHour | :2929 | 7 ساعات (1، 3، 4، 12، 13، 15، 21) | **مطابقة ساعة بساعة** (§11.3) | ✅ تطابق كامل |
| byProduct | :2866 | net/vat/profit/margin = **null** بالتصميم؛ التكلفة الحالية بالاسم | قيم **حقيقية لكل صنف** من السطور: Burger ‏net 550 / vat 82.5 / cogs 220 / margin 60% … | 📖 الترقية الجوهرية: ما كان «غير قابل للاشتقاق» صار مسجَّلًا لكل سطر، وΣ net الأصناف = 950 = الصافي الكلي |

   وفلترا §6.1: استدعاء القديم بأسماء الواجهة `brandId/branchId` أعاد **نفس** الناتج غير المفلتر حرفيًّا (`identicalToUnfiltered: true` — العلّة حية حتى لحظة الحذف)، بينما استدعاؤه بالاسم الصحيح `branch=B1` أعطى 6/951.5/net 830، والمحرك الجديد بـ`branch in [B1]` أعطى **نفسها بالضبط** (orders 6، invoice 951.5، net 830، vat 121.5) — §11.3.

4. **إثبات grep-zero بعد الحذف: ✅ نُفِّذ** — `node scripts/audit/retired-surfaces-report.js` يمر PASS ‏(exit 0) على كل العلامات (`/accounting/sales-analytics`، `ac-sales-analytics`، `SalesAnalyticsPage`، `useSalesAnalytics`، `salesAnalytics`) — الناتج الكامل في §11.4. المواضع التي كانت مرصودة صفرت كلها: manifest، ‏accounting/index.tsx، ‏api.ts (الـhook والـDTOs حُذفت)، قاموسا nav وaccounting (كلا اللغتين).
5. **غياب manifest/i18n:** حذف البند من `manifest.ts:165` ومفاتيح `ac-sales-analytics` من `nav.ts` ‏(ar:95/en:88) وكتلة `salesAnalytics` من قاموسَي `accounting` — والفحص أعلاه يحرس ذلك.
6. **redirect واختباره:** إضافة `/accounting/sales-analytics` إلى `REDIRECT_PATHS` (`app/router.tsx:60-67`) + `<Route ... element={<Navigate .../>}>` على نمط `router.tsx:92` مع تمرير query ‏(§7)، واختبار وحدة/e2e يفتح المسار القديم بكامل البارامترات ويتحقق من الوصول للجديد بها. (اختبار المعمارية `app/__tests__/architecture.test.ts:70` يعتمد `REDIRECT_PATHS` أصلًا فيبقى أخضر.)
7. **نقل سيناريوهات الاختبار: ✅ نُفِّذ** — جدول النقل الكامل فحصًا-فحصًا في §11.5. الخلاصة: قسم sales-analytics في `reportsEquations.api.test.js` أُعيدت كتابته على `POST /api/analytics/query` (نفس عقيدة المعادلات، بذرة `salesHubSeed`) **قبل** حذف القديم، والسويت 34/34 أخضر قبل الحذف وبعده؛ لا اختبار FE/e2e كان يمس الصفحة القديمة أصلًا (تحقّق §11.5).

8. **قرار الـendpoint الخلفي: ✅ نُفِّذ** — `GET /api/erp/reports/sales-analytics` حُذف من `erp-core.js` بعد البند 7، والاختبار السلبي 404 يمر في `tests/integration/retiredSurfaces.api.test.js` (§11.6).
9. **لقطات visual baselines:** تحقَّقتُ من `e2e/erp/visual-baselines.spec.ts-snapshots` — الشاشات السبع المثبَّتة هي `admin-users / inventory-list / inventory-new / menu-list / menu-new / overview / trial-balance` فقط؛ **لا baseline لهذه الصفحة** → لا شيء يُحذف، ويُوثَّق ذلك في رسالة كوميت الإخراج.

### 5.2 بروتوكول إخراج `/pos-admin/reports`

1. **التصنيف والسبب:** Retire (تقسيم). الأصل: `modules/pos-admin/pages/ReportsPage.tsx` (manifest.ts:101، التسجيل `pos-admin/index.tsx:46`). البديل التحليلي: `/reports/sales/shifts`؛ البديل التشغيلي قائم: `/pos-admin/shifts` (manifest.ts:98). السبب: الصفحة تكرر جدول الورديات وتحسب الإجماليات **في العميل** (`ReportsPage.tsx:80` → `summarizeShifts` في `shifts.ts:44-57`) على صفحة البيانات المحمَّلة فقط.
2. **البديل حي:** صفحة shifts في الهَب بإجماليات خادم + بطاقة حفر إلى `/pos-admin/shifts`.
3. **جدول تكافؤ المقاييس — توثيق فرقٍ بندًا بندًا** (المسار الذي تسمح به مقدمة §5: «أو توثيق سبب الفرق بندًا بندًا»). لا يوجد هنا «رقم قديم مقابل رقم جديد» قابل للمساواة، لأن **مصدر البيانات نفسه اختلف عمدًا**، والعلّة الأصلية (البند 1) هي أن القديم كان يَحسب في العميل على الصفحة المحمَّلة فقط:

| المقياس (بطاقات `ReportsPage` المحذوفة) | مصدره القديم | مكافئه في `/reports/sales/shifts` | الحكم |
|---|---|---|---|
| total / open / closed | عدّ صفوف `GET /api/shifts/` **المحمَّلة في العميل فقط** | صفوف بُعد `shift` من وقائع till (خادم، كل النطاق) | 📖 القديم عدّاد صفحة لا مقياس؛ الجديد إجمالي خادم حقيقي |
| expected (Σ theoretical) | `shiftTheoretical` من أعمدة الوردية (`theoretical_*`) عميلًا | `till_expected_cash` (open_float + cash_sale − pay_out − deposit − cash_refund) خادمًا | 📖 تعريف أدق مصدره وقائع الدرج المسجَّلة، وتثبته `analyticsReconciliation.api.test.js` (يوم 03-22: 100 مقابل 90) |
| actual (Σ cash+card+kita) | `shiftActual` عميلًا | `till_counted` (Σ close_count) خادمًا — وnull بصدق حين لا عدّ | 📖 «لم يُعَدّ» لم يعُد يظهر صفرًا |
| variance (Σ diff) | `shiftDiff` عميلًا | `till_variance` خادمًا | 📖 نفس المعادلة، محسوبة عند مصدر الحقيقة |
| أعمدة CSV الكامل | `makeExportColumns` (حُذفت مع الصفحة) | تصدير الهَب الخلفي (CSV/XLSX عبر `POST /analytics/exports`) + الحفر التشغيلي للوردية الواحدة باقٍ كاملًا في `/pos-admin/shifts` (لم يُمس) | 📖 وظيفة التصدير انتقلت للخادم؛ تفصيلة الوردية الواحدة ما زالت في الشاشة التشغيلية |

4. **grep-zero: ✅ نُفِّذ** — علامات `/pos-admin/reports`، `pa-reports`، `pages/ReportsPage`، `posAdmin.reports.` كلها «نظيف» في فحص §11.4. ما نُفِّذ فعلًا: حُذف بند manifest، وخريطة `pos-admin/index.tsx`، وقسم `"/reports/sales"` **بأكمله** من `reportLinks.tsx` (الهَب يملك المسار فلا بطاقة تعوّضه)، وأُعيدت وجهة بطاقة `opsPosReports` في قسم `/reports/operations` إلى `/reports/sales/shifts` مع تحديث مفتاحيها في `misc.ts` (اللغتين)، وحُذفت مفاتيح `posReports` وبطاقات المبيعات الست ومفاتيح `sections.sales` اليتيمة معها.
5. **غياب manifest/i18n:** حذف `pa-reports` من manifest.ts:101 ومن `nav.ts` (ar:57/en:50)، ومفاتيح `posAdmin.reports.*` من قاموسَي `posAdmin`.
6. **redirect واختباره:** `/pos-admin/reports` → `/reports/sales/shifts` بنفس آلية §5.1-6، مع تمرير فلاتر الورديات المدعومة.
7. **نقل سيناريوهات الاختبار: ✅ نُفِّذ** — لا اختبار كان يمس الصفحة القديمة (تحقّق §11.5)؛ صفحة الهَب `/reports/sales/shifts` مغطاة أصلًا بمجموعة «Shifts page» في `pages2.test.tsx` (KPIs + ألوان الفروقات + الحفر إلى `/pos-admin/shifts`)، والـredirect مغطى بـ`redirects.test.tsx` (§11.2).
8. **قرار الـendpoint الخلفي:** `GET /api/shifts/` (routes/shifts.js:1282) **يبقى** — تستهلكه `/pos-admin/shifts` وPOS؛ لا اختبار 404 هنا لأن لا endpoint يُحذف.
9. **visual baselines:** لا baseline لهذه الصفحة (نفس قائمة §5.1-9) → لا شيء يُحذف.

### 5.3 الحذف المباشر للـendpoints اليتيمة — إثبات grep-zero (الأمر + النتيجة كما خرجت)

الأمر الواحد نفسه نُفِّذ لكل علامة عبر الأشجار السبع (الواجهتان + e2e + tests + public، مع استبعاد dist):

```
rg -n "<MARKER>" frontend/erp/src frontend/pos/src e2e tests public -g '!**/dist/**'
```

النتائج (2026-07-24 على `f494468`):

```
--- report/advanced ---            (لا نتائج)
--- sales-by-channel ---           (لا نتائج)
--- channel-settlements ---        (لا نتائج)
--- discounts-given ---            (لا نتائج)
--- waste-analytics ---            (لا نتائج)
--- royalty-reconciliation ---     (لا نتائج)
```

أي: صفر مستهلك واجهة/اختبار/e2e/أصول عامة لكل الستة. (المستودع بعد إخراج legacy النهائي في `1426ad5` لم يعد يحوي شاشات `public/js` القديمة التي كانت تستهلك بعضها.)

**✅ نُفِّذ في كوميت الإخراج:** حُذفت المعالجات الستة (+ `sales-analytics` سابعها بعد §5.1-7)، والاختبار السلبي 404 يمر لكل مسار (`tests/integration/retiredSurfaces.api.test.js` — §11.6)، و`_royaltyBase` باقية بلا مساس (المعالج المحذوف لم يكن يستدعيها أصلًا؛ اختبار compute الحي `test:royalty-runs` لم يُلمس)، و`retired-surfaces-report.js` يمر PASS ‏(§11.4).

---

## 6. العيوب المكتشفة أثناء الجرد (كلها حية على `f494468`)

### 6.1 فلترا brand/branch في تحليلات المبيعات لا يعملان إطلاقًا — تعارض أسماء صامت

- الواجهة ترسل: `brandId` و`branchId` — ‏`frontend/erp/src/modules/accounting/api.ts:1061-1062` (داخل `useSalesAnalytics` :1051، الاستدعاء :1057).
- الخادم يقرأ: `brand` و`branch` — ‏`routes/erp-core.js:2794` ‏(`const { from, to, branch, brand, ... } = req.query`)، ويبني الشرط منهما فقط (:2811-2812).
- النتيجة: أي اختيار علامة/فرع في الصفحة **لا يغيّر رقمًا واحدًا** — الشرطان لا يُضافان أصلًا لأن `brand`/`branch` غير معرَّفين، والاستجابة تعود بمجاميع غير مفلترة بلا أي تحذير. (اختبار المعادلات `reportsEquations.api.test.js:192` يمرّر `brand=` — اسم الخادم الصحيح — لذا يمرّ الاختبار بينما الواجهة مكسورة: تغطية صحيحة لعقد خاطئ الاستخدام.)
- المعالجة في الهَب: البديل الجديد يوحّد الأسماء ويجعل الفلاتر فعلية؛ وخريطة الـredirect (§7) توثّق أن القيم المنقولة كانت بلا أثر تاريخيًا.

### 6.2 ربح التحليلات = التكلفة **الحالية** من `menu` مربوطة **بالاسم**؛ وصافي/ضريبة/ربح الصنف الواحد NULL عمدًا

- `routes/erp-core.js:2864-2865`: ‏`SELECT name, cost FROM menu` ثم `Map` بالاسم — أي تعديل تكلفة اليوم يعيد كتابة «ربح» مبيعات الماضي، وأي إعادة تسمية صنف تُخرِجه من التكلفة (يُعَدّ الآن في `costUnknownCount` ويُستبعد — :2875-2878 — بدل أن يُسعَّر صفرًا كما كان، والتعليق :2782-2783 يوثق التاريخ).
- الأسماء المكررة في `menu`: آخر صف يكسب (توثيق :2863).
- على مستوى الصنف: `net/vat/profit/margin = null` بالتصميم (:2881-2882) لأن التفصيل الضريبي مسجَّل على مستوى الفاتورة (`tax_subtotals_json`) لا السطر — والملاحظة معلنة في الاستجابة نفسها (:2886). محرك الهَب يرث هذا القيد **بصدق** (يعرض غير-القابل-للاشتقاق كغير قابل، لا يخترع قسمة ÷1.15).

### 6.3 جدول `sale_payments` الوهمي في لوحة النظرة العامة — «نقدية اليوم» تسقط صامتة إلى 0

- `routes/dashboard.js:262-264`: استعلام «الوضع النقدي» يقرأ من `sale_payments` — جدول **لا يوجد له أي `CREATE TABLE` في المستودع كله**. إثبات الجرد:

```
rg -l "sale_payments" --glob '!node_modules' -g '!**/dist/**'
→ routes\dashboard.js        (الموضع الوحيد في المستودع بأكمله)
```

- ولأن الاستعلام ملحوق بـ`.catch(() => [[{cash:0}]])` ‏(:269)، يفشل في كل تشغيل ويعود «نقدية اليوم = مصروفات اليوم بالسالب» فعليًا، بلا أي خطأ ظاهر. الإصلاح (ضمن Keep+Fix): القراءة من مصدر الدفع الحقيقي (`sales.payment_method`/تفصيل الورديات) أو إسقاط البطاقة.

### 6.4 خمسة endpoints تبتلع أعطال قاعدة البيانات إلى HTTP 200

المعالجات الستة اليتيمة (§3.3) كلها — عدا `sales-analytics` المُصلَح (:2949-2954 يجيب 500 صادقًا الآن، والتعليق يوثق العلة القديمة) — تجيب عن أي استثناء بـ`res.json({success:false,...})` أي **200**: ‏`erp-core.js:3035-3038` و`:3124-3127` و`:3178-3181` و`:3261` و`:3319`، ومعالجا aging في erp-core كذلك (:2570، :2633). عطل DB يظهر للمستهلك كجواب مؤدب فارغ. تُحذف مع أصحابها؛ والعبرة منقولة لمحرك الهَب: الفشل 500 لا 200.

### 6.5 تعارض شكل aging (التفصيل الكامل في §2.2)

الصفحتان الحيّتان تخاطبان معالجًا بشكل استجابة وبارامتر مغايرين لما بُنيتا عليه — عطل حي مستقل عن قرار الحذف.

### 6.6 فلتر `deleted_at IS NULL` في endpoints القنوات/الخصومات — عمود لا يكتبه شيء

- `erp-core.js:2971` و`:3054` و`:3141` تستبعد الملغي بـ`s.deleted_at IS NULL`، بينما إعادة كتابة sales-analytics وثّقت صراحة أن الإلغاء الفعلي يُكتب في `zatca_type` وأن `deleted_at` «عمود لا يكتبه شيء» (:2784، :2806). أي أن هذه التقارير كانت تُدخل المبيعات الملغاة في أرقامها. تسقط العلة بحذف أصحابها؛ محرك الهَب يستبعد بـ`zatca_type` (:2807 هو النمط الصحيح).

### 6.7 «هامش إجمالي» اللوحة = ‏(مبيعات − مشتريات) ÷ مبيعات — وكيل تقريبي غير مسمّى

- `routes/dashboard.js:308`: ‏`grossMargin = (salesV - purV) / salesV` — مشتريات الفترة ليست تكلفة البضاعة المباعة (تتجاهل حركة المخزون بالكامل)، والواجهة تعرضه كـ«هامش إجمالي» بلا تحفظ (`overview/_common.tsx:88,97`). ضمن Keep+Fix: يُعاد تسميته صراحة كوكيل («مبيعات−مشتريات») أو يُستبدل بهامش الهَب المحسوب من مصدر التكلفة الفعلي.

---

## 7. خريطة المسارات القديمة → الجديدة (مع نقل البارامترات)

| المسار القديم | الوجهة | نقل البارامترات | ملاحظات |
|---|---|---|---|
| `/accounting/sales-analytics?from&to&brandId&branchId` | `/reports/sales/executive?from&to&brandId&branchId` | الأربعة تُمرَّر كما هي | **توثيق إلزامي في كوميت الـredirect:** فلترا `brandId/branchId` القديمان لم يصلا الخادم قط (§6.1) — فالمستخدم الذي «كان يفلتر» سيرى في الصفحة الجديدة أرقامًا مفلترة فعلًا لأول مرة؛ هذا تصحيح لا انحراف، ويُذكر في ملاحظة الإصدار |
| `/pos-admin/reports` (+ فلاتر الورديات المدعومة) | `/reports/sales/shifts` | نطاق التاريخ/الكاشير حسب عقد الصفحة الجديدة | الحفر التشغيلي للوردية الواحدة يبقى في `/pos-admin/shifts` |
| بطاقة `posReports` في قسم `/reports/sales` ‏(reportLinks.tsx:63) | تُحذف | — | الهَب نفسه يغني عنها |
| بطاقة `opsPosReports` في قسم `/reports/operations` ‏(reportLinks.tsx:121) | تُعاد وجهتها إلى `/reports/sales/shifts` | — | مع تحديث مفاتيح `misc.ts` (ar:70/en:63) |
| `GET /api/erp/reports/sales-analytics` | endpoint المحرك الجديد | `brandId/branchId` أسماء موحّدة نهاية-إلى-نهاية | يُحذف بعد إعادة توجيه `reportsEquations.api.test.js` |
| الـendpoints الستة اليتيمة (§3.3) | لا بديل مباشر (وظائفها الحية تُبنى في الهَب من الصفر) | — | حذف + 404 سلبي |

آلية التنفيذ: إضافة المسارين إلى `REDIRECT_PATHS` ‏(`app/router.tsx:60-67`) + `<Navigate>` حافظ للـquery على نمط `router.tsx:92` — وهذا الملف هو **الاستثناء الوحيد** المسموح له حمل المسارات القديمة للأبد، وهو allow-listed في سكربت الفحص لهذا السبب بالذات.

---

## 8. ملاحظات النطاق

- **O2C Reports:** يبقى خاملًا كما هو (§3.4) — أي توحيد معه مؤجَّل لما بعد تفعيل `ORDER_TO_CASH_ENABLE` في الإنتاج، ولا يُحسب ضمن أسطح الهَب.
- **waste-analytics:** الـendpoint يُحذف كيتيم، لكن **النية التحليلية** (الهدر كنسبة من المبيعات، أعلى الأصناف هدرًا، بالسبب، الاتجاه الشهري — `erp-core.js:3199-3236`) موثَّقة هنا كمرشح أول لهَب `/reports/inventory` مستقبلًا. لا يُبنى في هذا السبرنت.
- **الملفان النمطيان aging + معالج balance-sheet القديم:** خارج مسار هذا السبرنت حتى يحسم مالك الدمج التعارضين (§2) — السكربت يراقبهما `pending` بلا تأثير على البوابة.

---

## 9. سكربت الفحص الدائم — `scripts/audit/retired-surfaces-report.js`

- **الاستخدام:**
  - `node scripts/audit/retired-surfaces-report.js --list` — يطبع مصفوفة العلامات (**16 علامة معتمدة؛ علامتا §2 المعلّقتان الثلاث أُزيلت بعد حسم القرارين** — انظر ترويسة السكربت) ويخرج 0 دائمًا.
  - `node scripts/audit/retired-surfaces-report.js` — يفحص `frontend/erp/src, frontend/pos/src, routes, services, lib, e2e, tests, public` (مستبعدًا `node_modules`/`dist`/`docs/status`/لقطات `-snapshots`/قائمة الملفات المسموحة: `app/router.tsx` بجدول الـredirects، واختباره المعطياتي `app/__tests__/redirects.test.tsx`، وسويت النفي `tests/integration/retiredSurfaces.api.test.js` الذي **يجب** أن يسمّي المسارات الميتة ليثبت 404) ويخرج **1** مع قائمة `file:line` لأي إشارة متبقية، و**0** عند النظافة.
- **الحالة بعد كوميت الإخراج: ✅ PASS ‏(exit 0)** — الناتج في §11.4 — والسكربت الآن **خطوة بوابة** `audit:retired-surfaces` في `scripts/gate/run-full-gate.js` مباشرة بعد `hygiene:test-residue`، فأي إحياء لإشارة مُخرَجة يُفشل بوابة الإصدار.

---

## 10. الخلاصة التنفيذية

| القرار | الأسطح |
|---|---|
| **Merge** | `/reports/sales` (يتحول من link-hub إلى هَب 16 صفحة، `rp-sales` + `subRoutes`) |
| **Fix-before-merge** | `/reports/saved` (دمج عروض الخادم `saved_views`) |
| **Retire → redirect** | `/accounting/sales-analytics` → `/reports/sales/executive`؛ `/pos-admin/reports` → `/reports/sales/shifts` (تقسيم) |
| **Delete (يتيمة، مثبتة)** | `sales.js /report/advanced` + خمسة `erp-core`: sales-by-channel، channel-settlements، discounts-given، waste-analytics، royalty-reconciliation (مع بقاء `_royaltyBase`) |
| **Keep خلال السبرنت ثم حذف** | `GET /api/erp/reports/sales-analytics` — **✅ حُذف** بعد إعادة توجيه `reportsEquations.api.test.js` |
| **Keep** | `/pos-admin/shifts`، حوار X/Z في POS، `/sales/*` السبعة، `/banking/{cashboxes,cash-closing,reconciliation}`، `/administration/tax`، `/overview` (+Fix §6.3/§6.7)، `/accounting/profitability`، O2C خامل |
| **✅ قرارا §2 — حُسما ونُفِّذا** | balance-sheet: **إبقاء** معالج `erp-core` (يستهلكه `FinancialRatios.tsx` حيًّا — مثبَّت 200)؛ aging: **عكس اتجاه الحذف المعتمد** — حُذف معالجا `erp-core` وأصبح الملفان النمطيان `erp/reports/{ar,ap}-aging.js` (المطابقان لعقد الواجهة) هما الحيَّين — مثبَّت بعقده الكامل في `retiredSurfaces.api.test.js` (§11.6) |

---

## 11. كوميت الإخراج — الأدلة المنفَّذة (2026-07-25، wt-sales-hub)

> هذا القسم هو «كوميت الإخراج» الذي اشترطته §1: كل بند من بروتوكولات §5 التسعة نُفِّذ وأُلصق دليله هنا. كل ناتج أدناه مأخوذ كما خرج من التشغيل الفعلي على قاعدة MySQL الحية (3306).

### 11.1 قائمة المحذوفات

**واجهة (frontend/erp/src):**

| الملف | ما حُذف |
|---|---|
| `modules/accounting/pages/SalesAnalytics.tsx` | الملف كاملًا (الصفحة المتقاعدة) |
| `modules/accounting/index.tsx` | الاستيراد + تسجيل المسار في خريطة `ROUTES` |
| `modules/accounting/api.ts` | ‏hook ‏`useSalesAnalytics` + كل DTOs التحليلات (`SalesHeadline`، `SalesRevenueSummary`، `SalesByProductRow`، `SalesDailyRow`، `SalesByPaymentRow`، `SalesByCashierRow`، `SalesByHourRow`، `SalesAnalyticsResponse`، `SalesAnalyticsFilter`) — تحقّقنا أن لا مستهلك آخر لها في الشجرة كلها |
| `modules/pos-admin/pages/ReportsPage.tsx` | الملف كاملًا (صفحة تقارير الكاشير) |
| `modules/pos-admin/index.tsx` | الاستيراد + تسجيل المسار |
| `modules/pos-admin/lib/shifts.ts` | ‏`summarizeShifts` + ‏`ShiftSummary` (كانا لهذه الصفحة وحدها)؛ بقية الدوال (`shiftActual/Theoretical/Diff`، `isShiftOpen`، `cashierOptions`، `useShifts`) باقية — تستهلكها `ShiftsPage` و`ShiftDetailDrawer` |
| `app/navigation/manifest.ts` | ورقتا `ac-sales-analytics` و`pa-reports` |
| `modules/reports/reportLinks.tsx` | قسم `"/reports/sales"` بأكمله (الهَب يملك المسار)، وأُعيدت وجهة بطاقة `opsPosReports` إلى `/reports/sales/shifts` |
| قواميس i18n (ar+en) | ‏`nav.items.{ac-sales-analytics,pa-reports}`؛ كتلة `accounting.salesAnalytics.*`؛ كتلة `posAdmin.reports.*`؛ ‏`misc.reports.sections.sales.*` + بطاقات `misc.reports.links.{salesOrders,salesInvoices,salesReturns,salesPayments,salesPricing,posReports}` (وتحديث `opsPosReports`) — اختبار تطابق القاموسين أخضر |

**خلفية:**

| الملف | ما حُذف |
|---|---|
| `routes/sales.js` | معالج «التقرير المتطور» بأكمله (كان :3006-3249، نحو 244 سطرًا) |
| `routes/erp-core.js` | معالجا aging القديمان (كانا :2504-2634) + معالج sales-analytics (كان :2774-2955) + المعالجات الخمسة اليتيمة (كانت :2957-3320). الملف 3536 → 2880 سطرًا. `_royaltyBase` ‏(:1465) لم تُمس |

### 11.2 الـredirects واختبارها

| من | إلى | البارامترات |
|---|---|---|
| `/accounting/sales-analytics` | `/reports/sales/executive` | ‏`from/to/brandId/branchId` تُمرَّر بأسمائها (وهي أسماء codec الهَب القانونية)؛ أي بارامتر آخر يمرّ كما هو |
| `/pos-admin/reports` | `/reports/sales/shifts` | ‏`from/to` + تمرير الباقي كما هو |

- الآلية: جدول `REDIRECTS` المصدَّر في `app/router.tsx` + مكوّن `RedirectWithParams` (يبني الـsearch ثم `<Navigate replace>`)، و`REDIRECT_PATHS` **مشتق** من الجدول فلا مصدر حقيقة ثانٍ — اختبار المعمارية `architecture.test.ts` مرّ **بلا أي تعديل**.
- الاختبار الجديد `app/__tests__/redirects.test.tsx` معطياتيّ فوق `REDIRECTS`: يفتح كل مسار قديم بـ`?from=2026-01-01&to=2026-01-31&brandId=2&unknown=x` ويثبت المسار النهائي + وصول **البارامترات الأربعة** كاملة (بما فيها `unknown` غير المُخطَّط)، + نظافة الرابط الخالي من query، + اشتقاق `REDIRECT_PATHS` — **6 اختبارات، كلها خضراء**.
- ملاحظة الإصدار الإلزامية (§7) مثبتة في تعليق الجدول نفسه: قيم `brandId/branchId` المنقولة كانت **بلا أثر** تاريخيًّا (§6.1) — المستخدم سيرى فلترة حقيقية لأول مرة؛ تصحيحٌ لا انحراف، وقد أُثبت رقميًّا في §11.3 (سطر `identicalToUnfiltered`).

### 11.3 التقاط التكافؤ — المستخرجات (قبل الحذف مباشرة)

المنهج: بذرة `tests/fixtures/salesHubSeed.js` (نافذة 2032-03، قيم محسوبة يدويًّا) زُرعت ثم **نُسخت مستنداتها إلى مسار القراءة القديم** (‏`tax_subtotals_json` الحقيقية لكل بيعة + صفوف `sales_items` بمطابقة سطور `ar_document_lines` جرسًا بجرس، مع صف item لبيعة ملغاة للتحقق من الاستبعاد) — فالخطّان قرآ **نفس المستندات**. خادم حقيقي على منفذ 3947، مستخدم admin.

**القديم (unfiltered + groupBy=all):**

```json
"headline": { "invoiceCount": 8, "total": 1071.5, "avgTicket": 133.94 },
"revenue": { "invoiceCount": 8, "grossInclVat": 1071.5, "net": 950, "vat": 121.5,
             "netUnknownCount": 0, "discounts": 15.75,
             "cost": 95, "costUnknownCount": 0, "profit": 855 }
```

**الجديد (POST /api/analytics/query، بلا أبعاد):**

```json
"totals": { "orders": 8, "invoice_total": 1071.5, "avg_ticket": 118.75,
            "net_ex_vat": 950, "vat_amount": 121.5, "net_incl_vat": 1071.5,
            "discounts_total": 15.75, "cogs": 365, "gross_profit": 585 },
"meta":   { "defaultsApplied": ["excluded_voided", "excluded_credit_note_docs"] }
```

**التفصيلات (كلاهما):**

- **daily** — القديم (تواريخ متزحزحة TZ في JSON، القيم يومية محلية) والجديد (`calendar_day`) **متطابقان يومًا بيوم**: ‏03-10: 204/1 · 03-11: 320/2 · 03-13: 57.5/1 · 03-15: 115/1 · 03-16: 230/1 · 03-20: 145/2.
- **byHour** — متطابقان ساعة بساعة: ‏1: 230 · 3: 30 · 4: 115 · 12: 230 · 13: 261.5 (2) · 15: 90 · 21: 115.
- **byCashier** — متطابقان عدًّا وإجمالًا: ‏c1 ‏6/951.5، ‏c2 ‏2/120 (متوسط c1: ‏158.58 قديمًا [شامل] مقابل 138.33 جديدًا [صافٍ] — فرق تعريف avgTicket نفسه).
- **byPayment** — القديم: ‏Mada ‏460/2 · Cash ‏407.5/5 · **Split ‏204/1** (سلة مستقلة). الجديد (وقائع الدفع): ‏card in ‏560 · cash in ‏511.5 / out ‏57.5 · other out ‏205 — أرجل Split ‏D1 (كاش 104 + شبكة 100) موزّعة على حقيقتها، والاستردادات ظاهرة لا مطموسة.
- **byProduct** — القديم: ‏net/vat/profit/margin = null بالتصميم، والتكلفة **الحالية بالاسم** (Burger 70 / Combo 15 / Water 10 = 95). الجديد (`menu_item` بربط `menu_id` لا الاسم):

```json
Burger: { "qty_sold": 7, "gross_product_sales": 632.5, "net_ex_vat": 550,
          "vat_amount": 82.5, "cogs": 220, "gross_profit": 330, "margin_pct": 60 }
Water:  { "qty_sold": 5, "gross": 140, "net": 140, "vat": 0, "cogs": 30, "margin_pct": 78.57 }
Combo:  { "qty_sold": 3, "gross": 299, "net": 260, "vat": 39, "cogs": 115, "margin_pct": 55.77 }
```

  ‏gross القديم = ‏gross_product_sales الجديد لكل صنف بالضبط (632.5 / 140 / 299)، وΣ net الأصناف = 950 = الصافي الكلي.

- **علّة الفلاتر §6.1 مثبتة رقميًّا لحظة الحذف:** القديم بـ`brandId=…&branchId=…` (أسماء الواجهة) أعاد `"identicalToUnfiltered": true` حرفيًّا. القديم بـ`branch=B1` (اسم الخادم) أعاد ‏6 / 951.5 / net ‏830 / cost ‏87. الجديد بـ`branch in [B1]` أعاد ‏orders ‏6 / invoice ‏951.5 / net ‏830 / vat ‏121.5 — **تطابق تام مع القديم-حين-يعمل**.

**الفروقات المشروحة (الرقم الجديد صحيح دفاعًا لا مجرد مختلف):**

1. **avgTicket ‏133.94 → 118.75:** تعريفان — شامل الضريبة ÷ العدد مقابل صافٍ ÷ العدد. المصالحة الحسابية: `net_incl_vat ÷ orders = 1071.5 ÷ 8 = 133.94` بالضبط؛ لا رقم ضائع.
2. **cost ‏95 → cogs ‏365 (وprofit ‏855 → gross_profit ‏585):** القديم يضرب الكمية في تكلفة `menu` **الحالية** المربوطة **بالاسم** (§6.2) — أي تعديل تكلفة اليوم يعيد كتابة ربح الماضي، وإعادة التسمية تُسقط الصنف. الجديد يجمع `cost_snapshot` المسجَّل على كل سطر لحظة البيع (البذرة تعمّدت جعل اللقطات مغايرة للتكلفة الحالية لإثبات مصدر الرقم). الرقم الجديد هو **الحقيقة التاريخية**.
3. **netUnknownCount → عقد اكتمال:** القديم كان يعدّ الفواتير التي بلا `tax_subtotals_json` صالح ويستثنيها. المحرك يقرأ سطورًا مُسقَطة أصلًا فلا يوجد blob يُفسد؛ النقص إن وُجد يظهر عبر `meta.completeness`/`maskedMetrics` والواجهة تعرض «—» لا 0 — نفس عقيدة «يُحصى ولا يُخمَّن» بآلية أصدق.
4. **مسألة «هل القديم يُدخل إشعار الدائن في شهر البيع الأصلي؟» — تحقّقنا:** القديم لا يُجري أي netting إطلاقًا: إشعارات الدائن في هذا النظام مستندات `ar_documents` لا صفوف `sales`، فالقديم **لا يراها أصلًا** ويُبقي فاتورة الأصل كاملة في شهرها (فـS3 تظهر 230 كاملة رغم مرتجع 115)؛ ولو وُجد إشعار قديم كصف `sales` بـ`zatca_type='credit_note'` لاستُبعد من شهر **إصداره** لا من شهر الأصل. الجديد يطابق هذا السلوك في `invoice_total` (يستبعد مستندات CN افتراضيًّا ولا يُنقص الأصل) ويكشف المرتجعات **صراحة** عبر مقاييسها (`returns_net` ‏240، `returns_value` ‏262.5، `refunds_out` ‏262.5 في نفس النافذة) — لا خسارة معلومة، بل إظهارها.

### 11.4 إثبات grep-zero بعد الحذف (ناتج السكربت كما خرج)

```
$ node scripts/audit/retired-surfaces-report.js
retired-surfaces-report — scan
allow-list: app/router.tsx, app/__tests__/redirects.test.tsx, tests/integration/retiredSurfaces.api.test.js
✓ نظيف  /accounting/sales-analytics     ✓ نظيف  ac-sales-analytics
✓ نظيف  SalesAnalyticsPage              ✓ نظيف  useSalesAnalytics
✓ نظيف  salesAnalytics                  ✓ نظيف  /pos-admin/reports
✓ نظيف  pa-reports                      ✓ نظيف  pages/ReportsPage
✓ نظيف  posAdmin.reports.               ✓ نظيف  /report/advanced
✓ نظيف  /reports/sales-by-channel       ✓ نظيف  /reports/channel-settlements
✓ نظيف  /reports/discounts-given        ✓ نظيف  /reports/waste-analytics
✓ نظيف  /reports/royalty-reconciliation ✓ نظيف  /reports/sales-analytics
الخلاصة: 0 إشارة معتمدة متبقية، 0 إشارة معلّقة (معلوماتية).
النتيجة: PASS (exit 0)
```

(المسموح لها حمل المسارات القديمة ثلاثة ملفات فقط وبأسباب معلنة: جدول الـredirects، اختباره المعطياتي، وسويت النفي الذي يثبت 404. حتى تعليقات الشيفرة الإرشادية صيغت بلا العلامات الحرفية كي يبقى الفحص صارمًا.)

### 11.5 جدول نقل سيناريوهات الاختبار (لا حذف بلا صف نقل)

| السيناريو القديم (`reportsEquations` قسم sales-analytics) | وجهته |
|---|---|
| gross يستبعد الملغي بـ`zatca_type` لا `deleted_at` | `reportsEquations` الجديد: «gross (invoice_total) = 1071.5 — the VOID never counted (excluded_voided default)» + `analyticsQuery.api.test.js`: «defaultsApplied reports excluded_voided + excluded_credit_note_docs» |
| net من التفصيل **المسجَّل** لا gross÷1.15 | `reportsEquations` الجديد: «net = 950 from the RECORDED lines (NOT 1071.5 ÷ 1.15 = 931.74)» + وحدات `tests/analyticsEquations.test.js` |
| vat من المسجَّل | `reportsEquations` الجديد: «vat = 121.5 …» + `analyticsQuery`: «vat_amount 121.50 (stored column, never derived)» |
| invoiceCount يستبعد الملغي | `reportsEquations` الجديد: «orders = 8 (void excluded; credit notes NOT double-counted)» + سويت `analyticsNoDoubleCount.api.test.js` كاملًا |
| blob فاسد → ‏`netUnknownCount=1` يُحصى لا يُخمَّن | 🔁 **مستبدَل بالبناء** (لا مكافئ حرفيًّا): المحرك لا يقرأ blob لكل فاتورة أصلًا؛ عقيدة «يُحصى ولا يُخمَّن» محمولة على `meta.completeness`/`maskedMetrics` (يثبتها `analyticsQuery` + عقد «—» في واجهات الهَب في `pages1/pages2`) — موثَّق في §11.3-3 |
| صنف بلا صف menu → ‏`costUnknownCount` لا هامش 100% | 🔁 **مستبدَل بالبناء**: الربط صار بـ`menu_id` + ‏`cost_snapshot` على السطر، فسيناريو «إعادة التسمية تُفقد التكلفة» لم يعُد ممكنًا بالتصميم؛ التكلفة المحجوبة قدرةً تظهر «—» (اختبار Profitability: «masks cogs as '—'») |
| profit = net − cost المعلوم | `reportsEquations` الجديد (per-item cogs) + معادلة `grossProfit` في وحدات `analyticsEquations` |
| byProduct ‏qty/gross بالاسم | `reportsEquations` الجديد: «per-item row (Burger): qty 7 / net 550 / cogs 220 — REAL per-line values, not null» |
| byProduct ‏net=null (لا يُخترع تقسيم) | انقلب إلى إثبات موجب: «Σ per-item net === headline net (950)» — القيم صارت مسجَّلة فتُجمع ويُتحقق من مصالحتها |
| daily يومان = 187.5 (يوم الملغي غائب) | `analyticsQuery` (حلقة `BD_B1` يومًا بيوم + سطر منتصف الليل) + سويت `analyticsTimezone.api.test.js` |
| اختبارات FE للصفحتين المحذوفتين | **لا شيء يُنقل** — تحقّقنا أن `modules/accounting/__tests__` و`modules/pos-admin/__tests__` لم يكن فيهما أي اختبار للصفحتين. الجديد أضاف: ‏6 اختبارات redirects + ‏5 اختبارات Reconciliation المرقّاة (عقد الخادم + الاستثناءات + بوابة القدرة) |

### 11.6 إثبات 404 + انقلاب aging + بقاء المُبقى (ناتج `retiredSurfaces.api.test.js` — منفذ 3994)

```
▶ retired endpoints → 404
  ✅ 404 /api/sales/report/advanced            ✅ 404 /api/erp/reports/sales-by-channel
  ✅ 404 /api/erp/reports/channel-settlements  ✅ 404 /api/erp/reports/discounts-given
  ✅ 404 /api/erp/reports/waste-analytics      ✅ 404 /api/erp/reports/royalty-reconciliation
  ✅ 404 /api/erp/reports/sales-analytics
  ✅ anonymous on a retired path is 401 (global JWT gate first — the 404s are real routing 404s)
▶ ar-aging answers the MODULAR contract (the live-page fix)
  ✅ 200 success · ✅ asOfDate ECHOED · ✅ customers is an ARRAY
  ✅ grandBuckets carries '0-30'…'120+' · ✅ grandTotal + overdue90PlusRatio
  ✅ the LEGACY shape is GONE (no totals.current / totals.1_30)
▶ ap-aging answers the MODULAR contract
  ✅ 200 success · ✅ suppliers ARRAY + grandBuckets · ✅ asOfDate echoed
▶ kept endpoints still answer 200
  ✅ balance-sheet (FinancialRatios consumer) · ✅ pnl (the ratios page's second call)
✅ retiredSurfaces: 20 passed, 0 failed
```

### 11.7 البوابة والسويتات واللقطات

- **خطوات بوابة جديدة في `scripts/gate/run-full-gate.js`** (بترتيب الأرخص أولًا): ‏`audit:analytics-vat` (ستاتيكي، بعد `static:sql-removed-fns`)؛ ‏`backend:analytics-core` (query + no-double-count + timezone + rollup-parity)؛ ‏`backend:analytics-security` (scope + exports)؛ ‏`backend:analytics-money` (payments + reconciliation + budget + anomalies + forecast-api)؛ ‏`backend:sales-fixes` (split + dashboard + **retired-surfaces**)؛ ‏`audit:mutation-sales-math` (حاصدة الطفرات)؛ ‏`audit:retired-surfaces` (بعد `hygiene:test-residue` مباشرة). سكربتات `package.json` المجمِّعة أُضيفت (`test:analytics-core/-security/-money`، `test:sales-fixes`، `test:retired-surfaces`).
- **السويتات بعد الإخراج:** ‏ERP vitest ‏**418/418** (66 ملفًا — كانت 410؛ الصافي +8: ‏redirects الجديدة + إعادة كتابة Reconciliation)؛ ‏`npm test` الجذري (41 سويت وحدات) أخضر؛ ‏`test:reports-equations` ‏**34/34** قبل الحذف وبعده؛ ‏`test:analytics-query` ‏**46/46** (انحدار)؛ ‏`retiredSurfaces` ‏**20/20**؛ ‏`tsc --noEmit` نظيف.
- **اللقطات البصرية:** أُعيد التحقق — لقطات `e2e/erp/visual-baselines.spec.ts-snapshots` السبع هي `admin-users / inventory-list / inventory-new / menu-list / menu-new / overview / trial-balance`؛ **لا baseline لأي صفحة مُخرَجة → لا لقطة تُحذف**، كما توقّعت §5.1-9 و§5.2-9.
- **إصلاحات مرافقة ضمن هذه الموجة:** ترقية صفحة `reconciliation` في الهَب إلى عقد الخادم `GET /api/analytics/reconciliation` (صفوف اليوم×الفرع + الدلتاوان + حفر الاستثناءات بروابط `/sales/invoices?doc=` + بوابة `analytics.reconciliation.view`)؛ إصلاح `shared/tables/SavedViews.tsx` (فكّ غلاف `{success,data}` + وقف التسلسل المزدوج للحقول JSON فصار مزامَن-الخادم يعمل فعلًا، مع بقاء fallback ‏localStorage وتوافق خلفي مع الصفوف المشوَّهة القديمة)؛ واستبدال مفاتيح i18n المستعارة مؤقتًا في Executive/Modifiers/Branches/Builder/Profitability/Discounts/Reconciliation بمفاتيحها الأصلية (`salesReports.charts.*`، `builder.sort/showChart/schedule`، `profitability.quadrants.*`، `discounts.reasonGap`، `reconciliation.exceptionDays`).
