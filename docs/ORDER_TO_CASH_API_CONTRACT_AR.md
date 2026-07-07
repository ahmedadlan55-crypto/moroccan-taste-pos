# عقد الـAPI — Order-to-Cash (`/api/order-to-cash`)

> يُركَّب فقط عند `ORDER_TO_CASH_ENABLE=1`. كل المسارات خلف بوابة JWT العامة (`req.user`) ثم `requireCapability`. **actor دائمًا من JWT** — أي `actor`/`userId` في الجسم يُتجاهل.

## المغلّف الموحّد
**نجاح (كتابة):**
```json
{ "success": true, "data": {...}, "documentNumber": "SI-...", "status": "issued",
  "version": 2, "affectedStock": [], "affectedValue": 280, "journalId": "JV-...",
  "auditEvent": null, "warnings": [], "generatedAt": "ISO" }
```
**قائمة (قراءة):** `{ success, data:[...], pagination:{page,pageSize,total,totalPages}, generatedAt }` وقد تُضاف `totals`/`columns`.
**خطأ:** `{ success:false, code, error, details? }` — وللأخطاء الداخلية `{ success:false, code:"INTERNAL_ERROR", error:"رسالة عامة", correlationId:"O2C-…" }` (بلا تسريب SQL).

## الترويسات
- `Idempotency-Key: <key>` — إعادة التشغيل الآمنة لأي كتابة (نفس النتيجة، بلا تكرار).
- `If-Match: <version>` أو `expectedVersion` في الجسم — القفل التفاؤلي (409 VERSION_CONFLICT عند التقادم).

## المسارات
### العملاء `/customers`
| الطريقة | المسار | الصلاحية |
|---|---|---|
| GET | `/` · `/search` | customers.view |
| GET | `/:id` · `/:id/360` · `/:id/statement` · `/:id/exposure` | customers.view |
| POST | `/` | customers.create |
| PUT | `/:id` | customers.edit |
| POST | `/:id/deactivate` | customers.deactivate |
| POST | `/:id/activate` | customers.edit |
| GET | `/:id/merge-preview?target=` · POST `/:id/merge` | customers.merge |

### أوامر البيع `/orders`
GET `/` · `/:id` (view) · POST `/` (create) · `/:id/confirm` (confirm) · `/:id/fulfill` (fulfill) · `/:id/invoice` (invoices.issue) · `/:id/cancel` (create).

### الفواتير `/invoices`
GET `/` · `/:id` (invoices.view) · POST `/` (invoices.create) · `/:id/issue` (invoices.issue) · `/:id/cancel` (invoices.create). **الفاتورة الصادرة immutable** — التصحيح إشعار دائن عبر `/returns`.

### التحصيل `/payments`
GET `/` · `/:id` · `/:id/timeline` (payments.view) · POST `/` (payments.create) · `/:id/approve` (payments.approve) · `/:id/post` (payments.post) · `/:id/allocate` (payments.post) · `/:id/reverse` (payments.reverse) · `/:id/cancel` (payments.create).

### المرتجعات `/returns`
GET `/` · `/:id` (returns.view) · POST `/` (returns.create) · `/:id/approve` (returns.approve) · `/:id/post` (returns.post) · `/:id/reverse` (returns.reverse) · `/:id/cancel` (returns.create).

### التقارير `/reports`
GET `/` (قائمة الأنواع) · `/:type` (ar_reports.view؛ `data-quality` تتطلب o2c.data_quality) · `/:type/export` (o2c.export، CSV بـ BOM + حماية حقن + سقف). الأنواع: sales-summary, sales-by-customer, sales-by-product, sales-by-channel, sales-by-cashier, ar-aging, open-invoices, collections, unallocated-payments, credit-exposure, returns, zatca-status, data-quality, customer-statement.

### المطابقة واللوحة
GET `/reconcile` (ar_reports.view) · `/ready` · `/dashboard` (o2c.dashboard.view).

## أكواد الأخطاء (HTTP)
VALIDATION_ERROR(422) · CUSTOMER_REQUIRED(422) · CUSTOMER_INACTIVE(422) · CREDIT_LIMIT_EXCEEDED(422) · CREDIT_APPROVAL_REQUIRED(422) · INVALID_STATE_TRANSITION(422) · INVOICE_IMMUTABLE(409) · OVER_ALLOCATION(422) · OVER_RETURN(422) · VERSION_CONFLICT(409) · IDEMPOTENCY_CONFLICT(409) · PERIOD_CLOSED(422) · CUSTOMER_DUPLICATE(409) · PAYMENT_NOT_ALLOCATABLE(422) · RETURN_ALREADY_POSTED(409) · PERMISSION_DENIED(403) · SCOPE_ACCESS_DENIED(403) · NOT_FOUND(404) · GL_POSTING_FAILED(500) · ZATCA_POSTING_FAILED(502) · O2C_MODULE_ACTIVE(409 من الحارس القديم).
