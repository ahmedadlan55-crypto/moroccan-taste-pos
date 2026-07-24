# ترشيد أسطح تقارير المبيعات — وثيقة المرحلة الأولى (الجرد، الأدلة، القرارات)

**السبرنت:** Unified Sales Analytics Hub — Phase 1 (Rationalization)

## 1. الهوية والمنهجية

- **الأساس (Baseline):** worktree `wt-sales-hub` على الفرع `sprint/sales-hub-20260724`، HEAD = `f494468`. كل استشهاد `file:line` في هذه الوثيقة مأخوذ من هذه النقطة تحديدًا.
- **الهدف:** حصر **كل** سطح تقارير يخص المبيعات/المدفوعات/الورديات/الأصناف/المرتجعات (واجهةً وخلفيةً)، وتصنيف كل سطح: **Keep / Merge / Retire / Fix-before-merge / Delete**، مع دليل ملف+سطر لكل ادعاء — تمهيدًا لهَب تقارير مبيعات موحّد تحت `/reports/sales/*` (16 صفحة فرعية؛ ورقة `rp-sales` الوحيدة في الـmanifest تكتسب `subRoutes`).
- **منهجية الإثبات:** لا قرار يُبنى على ذاكرة أو ادعاء سابق. كل تصنيف أدناه تحقّقتُ منه بقراءة الملف المعني سطرًا سطرًا و/أو بـ`rg` شامل تُلصق أوامره ونتائجه كما خرجت. أي ادعاء من المصفوفة المعتمدة **نقضه** الفحص مُعلَّم بوضوح في القسم 2 — القرار فيه لمالك الدمج، لا لهذه الوثيقة. (درس مثبَّت في سجل المشروع: «تحقّق بتشغيل/قراءة المسار الفعلي، لا بأن دالة بهذا الاسم موجودة».)
- **حدود هذه المرحلة:** وثيقة + سكربت فحص فقط. **لا حذف ولا تعديل سلوك في هذا الكوميت.** الحذف الفعلي يقع في «كوميت الإخراج» اللاحق وفق البروتوكول في القسم 5.

---

## 2. ⚠️ تعارضان نقض فيهما التحقق المصفوفة المعتمدة — قرار مالك الدمج مطلوب

### 2.1 `GET /api/erp/reports/balance-sheet` ليس يتيمًا — لا يُحذف كما هو مخطط

المصفوفة المعتمدة اعتبرت معالج `erp-core` القديم للميزانية «غير مستخدم لأن الواجهة تستهلك `-ifrs`». التحقق:

- صفحة الميزانية الرسمية تستهلك فعلًا النسخة IFRS: `frontend/erp/src/modules/accounting/api.ts:206` → `GET /erp/reports/balance-sheet-ifrs` (المعالج: `routes/erp/reports/balance-sheet.js`، مُركَّب عبر `routes/erp.js:101`).
- **لكن** صفحة النسب المالية الحية `/accounting/financial-ratios` تستهلك المعالج القديم مباشرة:
  - `frontend/erp/src/modules/accounting/pages/FinancialRatios.tsx:28` → `` apiClient.get(`/erp/reports/balance-sheet`, { params: { asOf } }) ``
  - المعالج القديم: `routes/erp-core.js:2359`.
- بل إن ملف IFRS نفسه يوثّق السبب التاريخي للاحقة `-ifrs`: «erp-core has a legacy /reports/balance-sheet that mounts first and was shadowing us» — `routes/erp/reports/balance-sheet.js:22-24`.

**الأثر:** حذف المعالج القديم كما هو الآن يكسر صفحة النسب المالية. الخيار السليم: تحويل `FinancialRatios.tsx` إلى `-ifrs` أولًا (مع مواءمة `lib/ratios.ts#extractInputs` لشكل الاستجابة المختلف)، **ثم** حذف المعالج القديم. مُعلَّم `pending` في سكربت الفحص — لا يؤثر على بوابة الإخراج حتى يُحسم.

### 2.2 ملفا aging «المظلَّلان» هما اللذان يطابقان عقد الواجهة — الصفحتان الحيّتان تتلقيان اليوم شكلًا لا تفهمانه

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
3. **جدول تكافؤ المقاييس والفلاتر** (نفس `from/to`، بلا brand/branch — لأن القديم يتجاهلهما فعليًا، §6.1):

| المقياس | مصدره القديم (erp-core.js) | القيمة القديمة | القيمة الجديدة | ملاحظة |
|---|---|---|---|---|
| invoiceCount | :2848 | «تُلتقط قبل الحذف» | «تُلتقط قبل الحذف» | استبعاد الملغي بـ`zatca_type` (:2807) |
| grossInclVat | :2894 | «تُلتقط قبل الحذف» | «تُلتقط قبل الحذف» | Σ `total_final` |
| net / vat | :2895-2896 | «تُلتقط قبل الحذف» | «تُلتقط قبل الحذف» | من `tax_subtotals_json` المسجَّل؛ يجب نقل `netUnknownCount` (:2897) لا إخفاؤه |
| discounts | :2898 | «تُلتقط قبل الحذف» | «تُلتقط قبل الحذف» | |
| cost / profit | :2899-2901 | «تُلتقط قبل الحذف» | «تُلتقط قبل الحذف» | القديم بالتكلفة الحالية بالاسم (§6.2) — فرقٌ هنا متوقَّع ويوثَّق لا يُسوَّى |
| daily / byPayment / byCashier / byHour | :2904-2935 | «تُلتقط قبل الحذف» | «تُلتقط قبل الحذف» | صفوف كاملة |

4. **إثبات grep-zero بعد الحذف:** يُنفَّذ `node scripts/audit/retired-surfaces-report.js` (العلامات: `/accounting/sales-analytics`، `ac-sales-analytics`، `SalesAnalyticsPage`، `useSalesAnalytics`، `salesAnalytics`) وتُلصق نتيجته PASS. اليوم (قبل الحذف) يرصد الفحص المواضع المتوقعة: manifest.ts:165، ‏accounting/index.tsx:28 (الاستيراد) و:45 (تسجيل الصفحة)، api.ts:1051-1067، قاموسا nav ‏(ar:95، en:88) وaccounting.
5. **غياب manifest/i18n:** حذف البند من `manifest.ts:165` ومفاتيح `ac-sales-analytics` من `nav.ts` ‏(ar:95/en:88) وكتلة `salesAnalytics` من قاموسَي `accounting` — والفحص أعلاه يحرس ذلك.
6. **redirect واختباره:** إضافة `/accounting/sales-analytics` إلى `REDIRECT_PATHS` (`app/router.tsx:60-67`) + `<Route ... element={<Navigate .../>}>` على نمط `router.tsx:92` مع تمرير query ‏(§7)، واختبار وحدة/e2e يفتح المسار القديم بكامل البارامترات ويتحقق من الوصول للجديد بها. (اختبار المعمارية `app/__tests__/architecture.test.ts:70` يعتمد `REDIRECT_PATHS` أصلًا فيبقى أخضر.)
7. **نقل سيناريوهات الاختبار:**

| الاختبار الحالي | الموضع | الوجهة |
|---|---|---|
| معادلات sales-analytics (net/vat/unknown counts) | `tests/integration/reportsEquations.api.test.js:177,192` | تُعاد كتابتها على endpoint المحرك الجديد **قبل** حذف القديم |
| e2e للصفحة القديمة | لا يوجد (`rg -n "sales-analytics" e2e` → لا نتائج) | سيناريو e2e جديد لصفحة executive |

8. **قرار الـendpoint الخلفي:** `GET /api/erp/reports/sales-analytics` (erp-core.js:2792) يبقى خلال السبرنت ثم يُحذف في كوميت الإخراج بعد البند 7، مع **اختبار سلبي 404** على المسار المحذوف.
9. **لقطات visual baselines:** تحقَّقتُ من `e2e/erp/visual-baselines.spec.ts-snapshots` — الشاشات السبع المثبَّتة هي `admin-users / inventory-list / inventory-new / menu-list / menu-new / overview / trial-balance` فقط؛ **لا baseline لهذه الصفحة** → لا شيء يُحذف، ويُوثَّق ذلك في رسالة كوميت الإخراج.

### 5.2 بروتوكول إخراج `/pos-admin/reports`

1. **التصنيف والسبب:** Retire (تقسيم). الأصل: `modules/pos-admin/pages/ReportsPage.tsx` (manifest.ts:101، التسجيل `pos-admin/index.tsx:46`). البديل التحليلي: `/reports/sales/shifts`؛ البديل التشغيلي قائم: `/pos-admin/shifts` (manifest.ts:98). السبب: الصفحة تكرر جدول الورديات وتحسب الإجماليات **في العميل** (`ReportsPage.tsx:80` → `summarizeShifts` في `shifts.ts:44-57`) على صفحة البيانات المحمَّلة فقط.
2. **البديل حي:** صفحة shifts في الهَب بإجماليات خادم + بطاقة حفر إلى `/pos-admin/shifts`.
3. **جدول تكافؤ المقاييس** (نفس نطاق التاريخ/الكاشير):

| المقياس (بطاقات `ReportsPage.tsx:137-144`) | القيمة القديمة | القيمة الجديدة | ملاحظة |
|---|---|---|---|
| total / open / closed | «تُلتقط قبل الحذف» | «تُلتقط قبل الحذف» | القديم يعدّ الصفحة المحمَّلة فقط — فرق محتمل يوثَّق |
| expected (Σ theoretical) | «تُلتقط قبل الحذف» | «تُلتقط قبل الحذف» | `shiftTheoretical` ‏(shifts.ts:12-19) |
| actual (Σ cash+card+kita) | «تُلتقط قبل الحذف» | «تُلتقط قبل الحذف» | `shiftActual` ‏(shifts.ts:8-10) |
| variance (Σ diff) | «تُلتقط قبل الحذف» | «تُلتقط قبل الحذف» | يفضّل diffs الخادم إن وُجدت (shifts.ts:21-29) |
| أعمدة CSV الكامل | «تُلتقط قبل الحذف» | «تُلتقط قبل الحذف» | `makeExportColumns` ‏(ReportsPage.tsx:52-73) تُنقل كما هي |

4. **grep-zero:** علامات السكربت `/pos-admin/reports`، `pa-reports`، `pages/ReportsPage`، `posAdmin.reports.`. المواضع المعروفة اليوم التي يجب أن تصفر: manifest.ts:101، ‏pos-admin/index.tsx:15,46، وبطاقتا `reportLinks.tsx` **الاثنتان** — تحقّقتُهما بالسطر: قسم `"/reports/sales"` سطر **:63** (بطاقة `posReports`) وقسم `"/reports/operations"` سطر **:121** (بطاقة `opsPosReports`). الأولى تُحذف (الهَب نفسه يحل محلها)، والثانية تُعاد وجهتها إلى `/reports/sales/shifts`، مع مفاتيح i18n المرافقة (`misc.ts` ‏ar:47,70 / en:40,63).
5. **غياب manifest/i18n:** حذف `pa-reports` من manifest.ts:101 ومن `nav.ts` (ar:57/en:50)، ومفاتيح `posAdmin.reports.*` من قاموسَي `posAdmin`.
6. **redirect واختباره:** `/pos-admin/reports` → `/reports/sales/shifts` بنفس آلية §5.1-6، مع تمرير فلاتر الورديات المدعومة.
7. **نقل سيناريوهات الاختبار:** لا اختبار integration/e2e يمس الصفحة (`rg -n "pos-admin/reports" e2e tests` → لا نتائج) — يُستحدث سيناريو للصفحة الجديدة.
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

أي: صفر مستهلك واجهة/اختبار/e2e/أصول عامة لكل الستة. (المستودع بعد إخراج legacy النهائي في `1426ad5` لم يعد يحوي شاشات `public/js` القديمة التي كانت تستهلك بعضها.) بروتوكول حذفها في كوميت الإخراج: حذف المعالج + اختبار سلبي 404 لكل مسار + بقاء `_royaltyBase` مثبتًا باختبار compute الحي (§3.3-تحذير) + تمرير `retired-surfaces-report.js`.

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
  - `node scripts/audit/retired-surfaces-report.js --list` — يطبع مصفوفة العلامات (19 علامة: 16 معتمدة + 3 معلّقة) ويخرج 0 دائمًا. ✅ مُشغَّل ومتحقَّق منه على هذا الأساس.
  - `node scripts/audit/retired-surfaces-report.js` — يفحص `frontend/erp/src, frontend/pos/src, routes, services, lib, e2e, tests, public` (مستبعدًا `node_modules`/`dist`/`docs/status`/لقطات `-snapshots`/ملف الـredirects المسموح `app/router.tsx`) عبر `rg` إن وُجد وإلا مشي ملفات خالص، ويخرج **1** مع قائمة `file:line` لأي إشارة متبقية لعلامة معتمدة، و**0** عند النظافة. العلامات المعلّقة (§2) تُفحص وتُطبع **معلوماتيًا فقط** ولا تمس exit code.
- **الحالة الآن (مقصودة):** الفحص يفشل — 114 إشارة معتمدة متبقية (الأسطح لم تُحذف بعد؛ آخر تشغيل على `f494468`). هذا هو التصميم: السكربت تقريرٌ قائم اليوم، ولا يُضاف كخطوة بوابة (`gate`) **إلا في كوميت الإخراج نفسه** حيث يجب أن يمر PASS.

---

## 10. الخلاصة التنفيذية

| القرار | الأسطح |
|---|---|
| **Merge** | `/reports/sales` (يتحول من link-hub إلى هَب 16 صفحة، `rp-sales` + `subRoutes`) |
| **Fix-before-merge** | `/reports/saved` (دمج عروض الخادم `saved_views`) |
| **Retire → redirect** | `/accounting/sales-analytics` → `/reports/sales/executive`؛ `/pos-admin/reports` → `/reports/sales/shifts` (تقسيم) |
| **Delete (يتيمة، مثبتة)** | `sales.js /report/advanced` + خمسة `erp-core`: sales-by-channel، channel-settlements، discounts-given، waste-analytics، royalty-reconciliation (مع بقاء `_royaltyBase`) |
| **Keep خلال السبرنت ثم حذف** | `GET /api/erp/reports/sales-analytics` (بعد إعادة توجيه `reportsEquations.api.test.js`) |
| **Keep** | `/pos-admin/shifts`، حوار X/Z في POS، `/sales/*` السبعة، `/banking/{cashboxes,cash-closing,reconciliation}`، `/administration/tax`، `/overview` (+Fix §6.3/§6.7)، `/accounting/profitability`، O2C خامل |
| **⚠ Pending — قرار مالك الدمج** | معالج `erp-core /reports/balance-sheet` (ليس يتيمًا — §2.1)؛ ملفا `erp/reports/{ar,ap}-aging.js` (المظلَّل هو المطابق لعقد الواجهة — §2.2) |
