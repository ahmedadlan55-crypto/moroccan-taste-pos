# مصفوفة الصلاحيات (RBAC) — المشتريات والموردون

- **Actor من JWT فقط** — كل مسار يقرأ `req.user.username` من التوكن (بوابة `/api/` العامة)؛ لا يُقرأ أبدًا من الجسم (مُثبَت في `tests/procurementRBAC.integration.test.js`: الجسم `createdBy:'HACKER'` يُتجاهَل).
- **الحارس:** `middleware/requireCapability(capId)` يحسب الصلاحية الفعّالة = `role_permissions ∪ {override:grant} \ {override:revoke}`. admin/developer bypass. **Fail-closed** (أي خطأ → 403 عام).

## Endpoint → الصلاحية المطلوبة

| المجموعة | Endpoint(s) | الصلاحية |
|---|---|---|
| Suppliers | `GET /suppliers`, `/search`, `/:id`, `/:id/statement|aging|price-history` | `suppliers.view` |
| | `POST /suppliers` | `suppliers.create` |
| | `PATCH /suppliers/:id` | `suppliers.edit` |
| | `POST /:id/activate|deactivate` | `suppliers.deactivate` |
| Orders | `GET /orders`, `/:id`, `/:id/timeline` | `procurement.view` |
| | `POST /orders` | `purchase_orders.create` |
| | `PATCH /orders/:id`, `POST /:id/change-orders` | `purchase_orders.edit_draft` |
| | `POST /:id/submit` | `purchase_orders.submit` |
| | `POST /:id/approve`, `/:id/send` | `purchase_orders.approve` |
| | `POST /:id/cancel` | `purchase_orders.cancel` |
| | `POST /:id/close` | `purchase_orders.close` |
| Receipts | `GET …` | `procurement.view` |
| | `POST /receipts` | `receipts.create` |
| | `POST /:id/approve|cancel` | `receipts.approve` |
| | `POST /:id/post` | `receipts.post` |
| | `POST /:id/reverse` | `receipts.reverse` |
| Invoices | `GET …` | `procurement.view` |
| | `POST /invoices`, `/:id/match|submit|cancel` | `supplier_invoices.create` |
| | `POST /:id/approve` | `supplier_invoices.approve` |
| | `POST /:id/credit-note` | `supplier_invoices.credit` |
| Payments | `GET …` | `procurement.view` |
| | `POST /payments`, `/:id/cancel` | `payments.request` |
| | `POST /:id/authorize` | `payments.authorize` |
| | `POST /:id/pay|allocations` | `payments.execute` |
| | `POST /:id/close` | `payments.close` |
| | `POST /:id/reverse` | `payments.reverse` |
| Returns | `GET …` | `procurement.view` |
| | `POST /returns`, `PATCH /:id` | `purchase_returns.create` |
| | `POST /:id/approve` | `purchase_returns.approve` |
| | `POST /:id/post|reverse` | `purchase_returns.post` |
| Reports/Dashboard | `GET /reports/*` | `procurement.reports` |
| | `GET /reports/data-quality` | `procurement.data_quality` |
| | `GET /dashboard` | `procurement.dashboard` |
| GL/Timeline | `GET /gl/:id`, `/:id/timeline` | `procurement.view` |

## الدور → الصلاحيات (المبذورة)

| الدور | ملخص الصلاحيات |
|---|---|
| **admin / manager** | **الكل** (admin عبر تمريرة top-up صريحة) |
| **purchasing** | view/dashboard/reports · suppliers.view/create/edit · purchase_orders.create/edit_draft/submit · receipts.create · supplier_invoices.create · purchase_returns.create — **بلا** approve/post/pay |
| **finance** | view/dashboard/reports/data_quality · suppliers.view · supplier_invoices.create/approve/credit · payments.* — **بلا** po.create/receipts.* |
| **inventory** | view · suppliers.view · receipts.create/approve/post/reverse · purchase_returns.create/approve/post — **بلا** invoices/payments |
| **cashier / custody / employee / hr** | لا شيء (403 على كل مسارات المشتريات) |

## إثبات (13/13 أخضر)
cashier→POST /orders=403 · purchasing→POST /orders=201، /approve=403 · manager→/approve=200 · inventory→/receipts=201، /invoices=403 · finance→/receipts=403، /invoices=201 · cashier→GET /orders=403 · actor من JWT (تجاهُل الجسم).
