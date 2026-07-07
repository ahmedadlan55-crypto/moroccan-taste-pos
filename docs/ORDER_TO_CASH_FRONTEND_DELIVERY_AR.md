# تسليم الواجهة — Order-to-Cash (قسم «المبيعات والعملاء»)

> SPA نظيرة `frontend/sales` مُركّبة في `server.js` عند `/sales` خلف `ORDER_TO_CASH_ENABLE` (الافتراضي OFF) — نفس JWT/الجلسة/التبويب، بلا خدمة/قاعدة/Login/Sidebar إضافي.

## 1) المعمارية
SPA ثالثة نظيرة لِـ`frontend/warehouse`(/warehouse) و`frontend/pos`(/pos-v2). React 18 + Vite + TS strict + TailwindCSS + shadcn-style + lucide-react + Framer Motion + TanStack Query + React Hook Form + Zod + Vitest. تعيد استخدام بنية warehouse (SearchableEntityCombobox، states، drawer، ui، api-client) بالنسخ المُحكم، والمنطق الخاص بـO2C فوقها.

## 2) التركيب في النظام
- `server.js`: كتلة `/sales` (CSP + static + history fallback) خلف `ORDER_TO_CASH_ENABLE`. عند OFF → 503 «القسم غير مُفعّل» (غير مرئي). `/api/version.orderToCash` يقود الإظهار.
- `package.json`: `build:sales` ضمن سلسلة `build`.
- الجلسة: `pos_token` من localStorage (نفس التطبيق الأساسي) — **لا Login ثانٍ**.

## 3) الشاشات (13 مسارًا)
| المسار | الوصف |
|---|---|
| `/sales/dashboard` | مؤشرات: مبيعات اليوم/الشهر، الذمم المفتوحة، المتأخرات، غير المخصّص، أعلى تعرّض |
| `/sales/customers` | قائمة + بحث + فلاتر + Pagination خادمي + إضافة/تعديل (Drawer + Zod) |
| `/sales/customers/:id` | Customer 360: رصيد/حد/تعرّض/أعمار حسب الاستحقاق/فواتير/تحصيلات/أعلى منتجات/كشف حساب+طباعة/تحذيرات جودة |
| `/sales/orders` (+`:id`) | أوامر البيع + Stepper (تأكيد/تنفيذ/تفويتر/إلغاء) + Timeline |
| `/sales/invoices` (+`:id`) | الفواتير + الأسطر/الضريبة/GL/زاتكا + إصدار/إلغاء (الصادرة immutable) + طباعة A4 |
| `/sales/payments` (+`:id`) | التحصيلات + إنشاء بتخصيص (منع over-allocation) + اعتماد/ترحيل/عكس |
| `/sales/returns` (+`:id`) | المرتجعات من فاتورة per-line + اعتماد/ترحيل/عكس + إشعار دائن |
| `/sales/reports` (+`:type`) | 14 تقريرًا + فلاتر تاريخ + جدول ديناميكي + CSV + طباعة |

## 4) عقود الواجهة الملتزمة
- **actor من JWT** فقط؛ **Idempotency-Key** على كل mutation؛ **If-Match/expectedVersion** حيث توجد نسخة (409 عند التقادم).
- **TanStack Query**: مفاتيح namespace `orderToCash`، invalidate بعد كل mutation، AbortSignal، **لا retry على mutations**، ولا على 4xx، Error normalization (ApiError)، بلا ابتلاع أخطاء.
- **الأرقام إنجليزية 0-9 دائمًا** (formatters بـ en-US + Gregorian) داخل RTL كامل.
- كل قائمة اختيار عميل/فاتورة searchable تُظهر الصفحة الأولى فور الضغط (SearchableEntityCombobox، searchOnEmpty).
- حالات: Loading skeleton، Empty، Error+Retry، PermissionDenied، Dormant (العلم OFF).

## 5) الصلاحيات (RBAC في الواجهة)
`permission-provider` يعكس `capabilities.js` (role→caps): admin/developer يتجاوزان؛ الكاشير إنشاء فقط؛ accountant/finance يعتمدان/يرحّلان/يعكسان. الأزرار تُخفى حسب الصلاحية، والخادم يبقى المرجع. بلا `o2c.view` → PermissionDenied.

## 6) القسم الواحد + إخفاء القديم (Strangler)
- `views/app-content.html`: مدخل واحد «المبيعات والعملاء» (`#o2c-unified-nav` → `/sales`)، والمداخل القديمة موسومة `data-legacy-o2c`.
- `public/js/app.js`: `applyOrderToCashNav()` يقرأ `/api/version.orderToCash` — عند ON يحقن CSS يُخفي `[data-legacy-o2c]` ويُظهر المدخل الموحّد، ويغلّف `nav('sales')`/`erpNav('erpCustomers'|'erpCustomerStatement'|'erpARAging')` لتحويلها إلى `/sales`. عند OFF: عكسي بالكامل (القديم يعود). «فتح الكاشير» داخل `/sales` → `/pos-v2` (نفس التبويب).

## 7) الاختبارات (مُشغّلة فعليًا)
- **Vitest: 42/42** (9 ملفات): permissions (role→caps)، formatters (منع الأرقام العربية ٠-٩)، server-flags (ENABLED/DORMANT)، CustomersPage (قائمة + أرصدة إنجليزية + empty + إجراء admin)، SearchableEntityCombobox (يفتح الصفحة الأولى)، ConfirmDialog/UnitQtyInput/States/ErrorState.
- **`tsc --noEmit`**: نظيف. **`vite build`**: أخضر (2048 وحدة، التقارير code-split).
- **التركيب**: الخادم يقلع بالعلم ON → `/sales/` يخدم التطبيق (عنوان + JS/CSS 200)، `/sales/customers` SPA fallback 200؛ العلم OFF → 503.
- **الانحدار Backend**: `o2cFoundation` 37/37، `o2cServices` 36/36، `o2cLegacyGate` 19/19 (بلا تأثّر بتعديلات `server.js`).

## 8) POS V2 O2C Integration (مُنجَز)
شاشة الكاشير `/pos-v2` تربط الآن **عميلًا حقيقيًا** وترسل **مدفوعات منظمة** خلف `ORDER_TO_CASH_ENABLE` (العلم OFF ⇒ POS كما كان تمامًا):
- **`CustomerPicker` جديد** في السلة (searchable، يفتح الصفحة الأولى فور الضغط، بحث `/api/order-to-cash/customers/search`، keyboard/ARIA، Error+Retry، يعرض المتاح الائتماني بأرقام إنجليزية، بلا native select). يُحفظ `customerId` الحقيقي في حالة السلة و`pos_orders.customer_id` (لا اسم/هاتف في notes فقط)؛ محفوظ عبر hold/resume.
- **بنية المدفوعات المنظمة:** `payments:[{method:'cash'|'card'|'credit',amount}]` تُضاف في `buildLegacySalePayload` **بجانب** الحقول القديمة (لا انحدار على `routes/sales.js`/GL)؛ split يدعم cash+card+credit (partial credit). credit طريقة حقيقية، تُعرض «آجل» في الإيصال (لا «كيتا»).
- **بوابة البيع الآجل:** أي جزء credit يتطلب عميلًا مرتبطًا — الواجهة تمنع التأكيد برسالة «البيع الآجل يتطلب اختيار عميل»، وحارس `/submit` (مُعلَّم بالعلم) + `creditSaleGate` على `/api/sales` يفرضان ذلك خادميًّا (422). offline يبقى cash فقط (البيع الآجل ممنوع). لم تُمَسّ UoM/barcode/FEFO/offline exactly-once (`clientOrderId`).
- **الاختبارات:** `posO2CPayload` 9/9 · `o2cLegacyGate` 20/20 (يشمل structured-credit-بلا-عميل→422) · POS Vitest 53/53 (+`CustomerPicker` 4، +`o2cPos` 5) · posV2.api 41/41 · posV2Uom 20/20 (بلا انحدار).

## 9) Playwright E2E Evidence (مُشغَّل فعليًا)
`npm run e2e:o2c` (خادم حقيقي بالعلم ON، desktop + mobile) — **9 passed · 0 failed · 3 skipped** (الـskips = تدفقات إنشاء لسطح المكتب فقط، تُتخطّى في مشروع الجوال):
- `/sales`: قسم واحد + تنقّل يُعرض (صفر console errors، لا تمرير أفقي) · إنشاء عميل + Customer 360 · فاتورة draft→issue→«صادرة» + GL + ZATCA (الصادرة immutable) · تقرير ar-aging بأرقام إنجليزية + طباعة.
- `/pos-v2`: الكاتالوج يُعرض (صفر console errors، لا تمرير أفقي) · CustomerPicker يفتح الصفحة الأولى + بحث خادمي + المتاح الائتماني «5,000.00» بأرقام إنجليزية + يحلّ customerId حقيقيًا.
- لقطات: `artifacts/e2e/o2c-final/{desktop,mobile}/*.png` (غير متتبعة في Git).

## 10) Remaining Gaps
**لا شيء مؤثر.** كلا البندين المُعلنين سابقًا (تكامل POS + Playwright) مُغلقان ومُتحقَّقان فعليًا أعلاه.
