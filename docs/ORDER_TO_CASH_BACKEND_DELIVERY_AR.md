# تسليم Backend — توحيد دورة المبيعات والعملاء والذمم (Order-to-Cash)

> الحالة: **Backend READY** خلف العلم `ORDER_TO_CASH_ENABLE` (الافتراضي OFF). لا Production write، لا merge، لا deploy، لا خدمة/قاعدة جديدة.

## 1) نظرة عامة
وحدة موحّدة تجعل `ar_documents` **مصدر الحقيقة الوحيد للذمم**، وتوحّد: العملاء + أوامر البيع + فواتير العملاء + التحصيل/التخصيص + المرتجعات الجزئية + التقارير + المطابقة (Reconcile) + لوحة المبيعات. كل كتابة مالية تمرّ بكاتب GL واحد (`lib/order-to-cash/posting.js`) بقيود **append-only** (العكس قيد جديد، لا حذف). ZATCA حقيقي (UUID + hash-chain + QR)، وحالة صادقة `pending` بدل mock كاذب. البيع الآجل محكوم ببوابة خادم (`CreditLimitService`). عند تفعيل العلم، مسارات الكتابة القديمة المكرِّرة للذمم تُرجِع 409 (كاتب واحد)، والقراءات القديمة تبقى تعمل.

## 2) المعمارية (Strangler-Fig)
```
lib/order-to-cash/         عقود نقية: calculations, config, numbering, events,
                           stateMachine, errors, http, accounts, posting
services/order-to-cash/    منطق الأعمال (12 خدمة) + TransitionExecutor
routes/order-to-cash/      Routers رفيعة تحت /api/order-to-cash
middleware/o2cLegacyGate.js حراس الكاتب الواحد (409) + بوابة الائتمان
db/migrations/order-to-cash schema (9 جداول) + capabilities (28 صلاحية) + ddlHelpers
scripts/order-to-cash/     migrate · backfill · reconcile · rollback
tests/                     o2cFoundation · o2cServices.integration · o2cLegacyGate.integration
```

## 3) الجداول (إضافية فقط، idempotent، InnoDB/utf8mb4_unicode_ci/DECIMAL)
`ar_documents` (فاتورة/إشعار مدين/إشعار دائن — UNIQUE(source_type,source_id) + UNIQUE(idempotency_key))، `ar_document_lines`، `sales_orders` + `sales_order_lines`، `customer_payments`، `ar_payment_allocations` (UNIQUE(payment_id,ar_document_id))، `sales_returns` + `sales_return_lines`، `ar_events` (UNIQUE(entity_type,idempotency_key)) + تطوير `customers` (name_en/vat_number/email/…/payment_terms/credit_days/brand_id/merged_into_id) + view `v_customer_ar_balance` (الرصيد مشتق، لا `customers.balance`).

## 4) الخدمات (services/order-to-cash)
| الخدمة | المسؤولية |
|---|---|
| CustomerService | Master + بحث ع/إ/هاتف مطبّع/VAT + كشف تكرار (بلا دمج تلقائي) + منع حذف بعد حركة + رصيد مشتق |
| CreditLimitService | بوابة البيع الآجل الخادمية (لا عميل/غير نشط/تجاوز الحد → 422؛ Override بصلاحية `credit.override`) |
| InvoiceService | الكاتب الوحيد للـAR؛ manual/contract تُرحّل GL، بيع POS **يربط** قيد البيع القائم بلا إعادة ترحيل |
| ZatcaDocumentService | UUID + hash-chain + QR حقيقي؛ حالة `pending`/`not_required` بلا mock |
| CustomerPaymentService | تحصيل/دفعة مقدمة؛ Dr Cash|Bank / Cr AR (+Deposits)؛ عكس append-only؛ Maker–Checker للكبير |
| PaymentAllocationService | الكاتب الوحيد لـ paid/balance؛ منع over-allocation بـ FOR UPDATE |
| SalesOrderService | draft→confirmed→fulfilled→invoiced→closed؛ التفويتر يجسر لـ InvoiceService |
| SalesReturnService | مرتجع جزئي per-line + snapshots + إشعار دائن + GL append-only + استعادة مخزون |
| CustomerStatementService | كشف حساب برصيد متحرك + Customer 360 (aging by due date، بلا N+1) |
| CustomerMergeService | دمج مُعتمَد يدويًا (بلا حذف بيانات) |
| O2CReportingService | 14 تقريرًا، كلها ONLY_FULL_GROUP_BY-safe، الإجماليات على كامل المجموعة |
| O2CReconciliationService | 8 ثوابت (GL متوازن، لا over-allocation، AR↔GL) |

## 5) نموذج GL (append-only)
- فاتورة (manual/contract): Dr AR / Cr Revenue / Cr Output VAT (+ Dr COGS / Cr Inventory للبضاعة).
- بيع POS: يُربط قيد `Sale` الموجود (لا إعادة ترحيل — لا مضاعفة Revenue/VAT/COGS).
- تحصيل: Dr Cash|Bank / Cr AR. دفعة مقدمة: Dr Cash|Bank / Cr Customer Deposits. تخصيص المقدمة: Dr Deposits / Cr AR.
- إشعار دائن/مرتجع: Dr Revenue + Dr Output VAT / Cr AR|Cash|Bank|Deposit؛ عكس التكلفة Dr Inventory / Cr COGS.
- العكس: نسخة القيد بمبادلة مدين/دائن + ربط (`reverses_journal_id`) — لا حذف من `gl_journals`/`gl_entries`.
- منع الترحيل في فترة مقفلة/مغلقة (`accounting_periods`).

## 6) نتائج الاختبارات (مُشغّلة فعليًا على MariaDB 3307)
- `tests/o2cFoundation.test.js` — **37/37** (رياضيات المال/الضريبة صفرية-آمنة/inclusive/aging + state machines + تنقية الأخطاء).
- `tests/o2cServices.integration.test.js` — **36/36** (بوابة الائتمان، فاتورة+GL 280/250/30 + ZATCA، idempotency replay، تحصيل جزئي، منع over-allocation، version conflict 409، مرتجع جزئي + إشعار دائن + GL append-only + خفض رصيد الأصل، over-return، 9 تقارير، reconcile PASS).
- `tests/o2cLegacyGate.integration.test.js` — **19/19** (HTTP: 401/403/200، 8 بوابات قديمة 409/422، القراءات تمر، صفر dual-write).
- الانحدار: `npm test` **exit 0** (30 ملفًا)، `test:pos-v2-api` **41/41**، `test:pos-v2-uom` **20/20**.
- migrate apply→rerun نظيف؛ backfill dry→apply(1 sale)→rerun(0)؛ `o2c:reconcile` PASS.

## 7) قيود مُحترمة
لا تغيير `WAREHOUSE_V2_ENABLED`/`POS_V2_ENABLED`/`PROCUREMENT_P2P_ENABLE`/`WAREHOUSE_SCOPE_ENFORCE`/`JWT_SECRET`. خدمة Railway واحدة + MySQL واحدة + Express واحد. الفرع فقط، بلا merge/deploy. الواجهة React `/sales` مؤجّلة لدفعة لاحقة (البوابة الحالية = Backend فقط).

## 8) الحالة النهائية: **READY (Backend)**
راجع: [API Contract](ORDER_TO_CASH_API_CONTRACT_AR.md) · [Migration Runbook](ORDER_TO_CASH_MIGRATION_RUNBOOK_AR.md) · [Reconciliation](ORDER_TO_CASH_RECONCILIATION_AR.md) · [RBAC Matrix](ORDER_TO_CASH_RBAC_MATRIX_AR.md) · [Legacy Gate](ORDER_TO_CASH_LEGACY_GATE_AR.md).
