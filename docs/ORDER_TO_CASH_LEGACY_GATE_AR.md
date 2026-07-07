# حارس المسارات القديمة — Order-to-Cash (`middleware/o2cLegacyGate.js`)

عند `ORDER_TO_CASH_ENABLE=1`، تصبح وحدة `/api/order-to-cash` **الكاتب الوحيد** لمصدر حقيقة الذمم (`ar_documents`)، للتحصيلات، وللمرتجعات. تحجب الحُرّاس مسارات الكتابة **القديمة المكرِّرة** (409) بينما تمرّ القراءات (GET/HEAD/OPTIONS). عند العلم `0` تُزال كل الحُرّاس ويعمل القديم كما هو.

## الحُرّاس (مُركَّبة في `server.js` داخل كتلة العلم)
| الحارس | يُركَّب على | يحجب | النتيجة |
|---|---|---|---|
| `legacyArGate` | `/api/ar-invoices` | كل mutation (مصدر فاتورة ثانٍ) | 409 → `/sales/invoices` |
| `customerReceiptGate` | `/api/cash` | `POST /receipts` بـ `source_type='customer'` أو `customer_id` | 409 → `/sales/payments` |
| `saleReverseGate` | `/api/sales` | `void`/`return`/`refund`/`reverse`/`bulk-delete` + أي `DELETE` | 409 → `/sales` |
| `creditSaleGate` | `/api/sales` | بيع آجل لا يجتاز بوابة الائتمان الخادمية | 422 (كود O2C) |

## المبدأ الحاسم: إنشاء بيع POS **لا يُحجب**
`POST /api/sales` (إنشاء بيع) يمرّ — POS يبقى **الكاتب المالي** للبيع (مخزون/GL/ZATCA بلا لمس). يُحجب فقط:
1. **العكس/الحذف المُتلِف للـGL** (`void`/`return`/`DELETE`/`bulk-delete`) → يُنقَل لإشعار دائن append-only في الوحدة.
2. **البيع الآجل** الذي لا يجتاز `creditSaleGate` (لا عميل/غير نشط/تجاوز الحد) → 422 قبل الكتابة.

بنية المدفوعات المنظّمة المدعومة: `payments:[{method:'cash|card|credit|customer_credit', amount}]` أو `payment_method` نصيًّا (توافقًا). الجزء الآجل يُشتق من البنية لا من تحليل نص مربك.

## الرسالة الموحّدة للحجب
```json
{ "success": false, "code": "O2C_MODULE_ACTIVE",
  "error": "انتقلت هذه العملية إلى وحدة «المبيعات والعملاء» الموحدة.",
  "redirect": "/sales/..." }
```

## إثبات حيّ (مُشغّل — `tests/o2cLegacyGate.integration.test.js`، 19/19)
- `POST /api/ar-invoices` · `PUT/DELETE .../X` → **409**.
- `POST /api/cash/receipts {source_type:'customer'}` → **409**؛ `{source_type:'income'}` → **يمرّ** (غير محجوب).
- `POST /api/sales/:id/void|/return` · `DELETE /api/sales/:id` → **409**.
- `POST /api/sales {payment_method:'credit', بلا عميل}` → **422 CUSTOMER_REQUIRED**؛ `{payment_method:'cash'}` → **يمرّ** (400 سلة فارغة، ليس حجبًا).
- `GET /api/ar-invoices` → **ليس 409**. أعداد `ar_documents`/`customer_payments`/`gl_entries` **بلا تغيير** تحت محاولات الحجب (صفر dual-write).

## التراجع
`ORDER_TO_CASH_ENABLE=0` → تُفكّ كل الحُرّاس فورًا، ويستأنف القديم بلا لمس (تغيير علم واحد).
