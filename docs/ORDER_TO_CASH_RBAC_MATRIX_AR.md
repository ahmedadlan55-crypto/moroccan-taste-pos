# مصفوفة الصلاحيات (RBAC) — Order-to-Cash

الصلاحيات تُبذَر في `permissions_v3` (الفئة `order_to_cash`) وتُمنَح للأدوار في `role_permissions` عبر `db/migrations/order-to-cash/capabilities.js` (idempotent، `INSERT IGNORE`). الصلاحية الفعّالة وقت الطلب = `role_permissions ∪ {override:grant} \ {override:revoke}`. **admin/developer يتجاوزان**. غير المخوّل → **403 عام** (بلا كشف وجود المستند). actor من JWT فقط.

## الصلاحيات (28)
`o2c.view` · `o2c.dashboard.view` · `ar_reports.view` · `o2c.export` · `o2c.data_quality`
`customers.view|create|edit|deactivate|merge`
`sales_orders.view|create|confirm|fulfill`
`invoices.view|create|issue` · `credit.override`
`payments.view|create|approve|post|reverse`
`returns.view|create|approve|post|reverse`

## منح الأدوار
| الصلاحية | admin | manager | cashier | sales | accountant | finance |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| view/dashboard | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| ar_reports.view | ✅ | ✅ | — | ✅ | ✅ | ✅ |
| o2c.export / data_quality | ✅ | ✅ | — | — | ✅ | ✅ |
| customers.view/create/edit | ✅ | ✅ | ✅ | ✅ | view | view |
| customers.deactivate/merge | ✅ | ✅ | — | — | — | — |
| sales_orders.create | ✅ | ✅ | ✅ | ✅ | — | — |
| sales_orders.confirm/fulfill | ✅ | ✅ | — | confirm | — | — |
| invoices.create | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| invoices.issue | ✅ | ✅ | — | — | ✅ | ✅ |
| credit.override | ✅ | ✅ | — | — | ✅ | ✅ |
| payments.create | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| payments.approve/post/reverse | ✅ | ✅ | — | — | ✅ | ✅ |
| returns.create | ✅ | ✅ | ✅ | ✅ | — | — |
| returns.approve/post/reverse | ✅ | ✅ | — | — | ✅ | ✅ |

**الكاشير** لا يملك: approve/post/reverse/deactivate/merge/issue/credit.override — أدوار الإنشاء فقط.
**admin top-up:** يُمنح admin كل `o2c.*` صراحةً (لأن البذر الأساسي يمنح admin=ALL فقط حين يكون `role_permissions` فارغًا).

## تحقق حيّ (مُشغّل)
`tests/o2cLegacyGate.integration.test.js`: بلا توكن → **401**، admin → **200**، موظف (role=employee بلا منح o2c) → **403**، admin reconcile → **200**. لم تُمنَح صلاحية لأي مستخدم بغرض إنجاح اختبار.
