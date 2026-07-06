# دليل التراجع (Rollback Runbook)

## المستوى 1 — تراجع تشغيلي (المفضّل، فوري، بلا فقد بيانات)
اضبط:
```bash
PROCUREMENT_P2P_ENABLE=0
```
وأعد تشغيل الخادم. النتيجة:
- وحدة `/api/procurement` **لا تُركّب**.
- بوابات الكتابة القديمة تُرفع → `POST /api/purchases/receive/:id` و`/api/inventory/receive-*` و`/api/ap-invoices/:id/pay` تعمل كما كانت (الكاتب القديم يستأنف).
- المخطط الإضافي (أعمدة/جداول/حساب GRNI) يبقى خاملًا وغير ضار.
- الواجهة: مجموعة «المشتريات والموردون» تبقى ظاهرة في البناء لكن الـAPI يرجع 404 عند العلم OFF؛ لإخفائها بالكامل أزل عنصر التنقّل أو اضبط علم واجهة إن رغبت.

> هذا هو التراجع الموصى به: عكسي بالكامل، صفر مخاطرة على البيانات.

## المستوى 2 — تراجع صلب محصّن (آخر ملاذ)
يُسقط الجداول الجديدة فقط، وفقط عندما **لا توجد أي مستندات P2P** (`procurement_events` فارغ):
```bash
node scripts/procurement/rollback.js            # معاينة
node scripts/procurement/rollback.js --confirm  # تنفيذ
```
- يرفض التنفيذ إذا وُجدت أحداث (يوجّهك للمستوى 1 بدلًا من فقد بيانات).
- يُسقط: `payment_allocations, supplier_invoice_matches, purchase_return_lines, purchase_returns, procurement_events` + View، ويمسح علامات `_procurement_migrations`.
- **يُبقي** الأعمدة المُضافة على الجداول القائمة وحساب GRNI (إضافية غير ضارة).

## ما لا يجب فعله
- لا `git reset --hard` ولا force push ولا حذف ملفات المالك.
- لا تطبيق أي من هذا على Production ضمن هذا العمل.
