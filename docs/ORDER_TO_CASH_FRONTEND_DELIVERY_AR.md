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

## 8) النواقص الحقيقية
- **تكامل واجهة POS** (`frontend/pos`): بوابة الائتمان الخادمية تفرض «الآجل يتطلب عميلًا» فعليًا (`creditSaleGate`)، لكن تعديل شاشة الكاشير لإرسال `customer_id` + بنية مدفوعات منظمة لم يُنفَّذ في هذه الدفعة (تجنّبًا لمخاطرة مسار البيع القوي) — يبقى عملًا لاحقًا موصوفًا في [Cutover Plan](ORDER_TO_CASH_CUTOVER_PLAN_AR.md).
- **Playwright E2E**: لم يُشغَّل في هذه الدفعة (يتطلب خادمًا حيًّا + جلسة). التحقق تم عبر Vitest + build + تركيب الخادم.
