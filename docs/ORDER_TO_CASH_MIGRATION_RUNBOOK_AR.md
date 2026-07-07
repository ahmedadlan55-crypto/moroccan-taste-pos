# دليل التشغيل — الترحيل والـBackfill والمطابقة (Order-to-Cash)

> كل السكربتات على **قاعدة اختبار/محلية production-like** (MariaDB منفذ 3307). لا تشغيل على Production في هذه الدفعة.

## المتغيّرات
- `ORDER_TO_CASH_ENABLE` — العلم الرئيسي (0 = خامل، القديم يعمل؛ 1 = الوحدة الموحّدة + بوابات الكاتب الواحد).
- `O2C_MAKER_CHECKER` (افتراضي 1) و`O2C_MAKER_CHECKER_THRESHOLD` (افتراضي 10000).
- أكواد الحسابات قابلة للضبط: `O2C_AR_ACCOUNT_CODE`(1150) · `O2C_CASH_ACCOUNT_CODE`(1110) · `O2C_BANK_ACCOUNT_CODE`(1120) · `O2C_REVENUE_ACCOUNT_CODE`(4100) · `O2C_OUTPUT_VAT_ACCOUNT_CODE`(2210) · `O2C_COGS_ACCOUNT_CODE`(5100) · `O2C_INVENTORY_ACCOUNT_CODE`(1200) · `O2C_CUSTOMER_DEPOSITS_CODE`(2140، يُنشأ تلقائيًا إن غاب).

## 1) الترحيل (idempotent)
```
npm run o2c:migrate -- --dry-run   # تقرير: ما سيُنشأ (بلا كتابة)
npm run o2c:migrate                # apply: 9 جداول + تطوير customers + view + 28 صلاحية
npm run o2c:migrate                # rerun: نظيف (لا تكرار) — آمن
```
يكتب علامة في `_o2c_migrations`. آمن على قاعدة فارغة/جزئية وعلى إعادة التشغيل.

## 2) الـBackfill (اتجاه واحد، idempotent، بلا ترحيل GL جديد)
```
npm run o2c:backfill -- --dry-run  # تصنيف: sales/customer_invoices/credit_notes + كشف تكرار العملاء
npm run o2c:backfill               # apply داخل transaction
npm run o2c:backfill               # rerun: 0 صف جديد (UNIQUE(source_type,source_id))
```
- **بيع POS** → `ar_documents` مربوطة بقيد `Sale` الموجود (لا مضاعفة Revenue/VAT/AR).
- **customer_invoices/credit_notes القديمة** → استيراد مع `gl_journal_id` الخاص بها (أو تُعلَّم Data-Quality إن غاب).
- **تكرار العملاء** → تقرير فقط، **لا دمج تلقائي** (الدمج يدوي عبر `/customers/:id/merge`).
- الرصيد **مشتق** (view)، لا يُوثَق بـ `customers.balance` اليدوي.

## 3) المطابقة (Reconcile)
```
npm run o2c:reconcile              # يطبع كل الثوابت؛ exit 1 عند فشل صلب
```
راجع [Reconciliation](ORDER_TO_CASH_RECONCILIATION_AR.md).

## 4) التراجع (Rollback)
- **الأساسي:** `ORDER_TO_CASH_ENABLE=0` → الوحدة تخمد، القديم يعود، الجداول الإضافية تبقى خاملة (بلا فقد بيانات).
- **إسقاط الجداول (نادر، محصّن):**
```
npm run o2c:rollback               # تقرير الحارس (يرفض إن وُجدت حركة O2C)
npm run o2c:rollback -- --confirm  # إسقاط الجداول الإضافية فقط — يرفض إن كان ar_events/دفعات/مستندات حيّة موجودة
```
لا يمسّ أي جدول قديم؛ أعمدة `customers` المضافة تبقى (غير ضارّة).

## 5) تسلسل التفعيل المقترح (للإنتاج لاحقًا — خارج نطاق هذه الدفعة)
1) نسخة احتياطية طازجة + اختبار استعادة. 2) `o2c:migrate` (apply→rerun). 3) `o2c:backfill --dry-run` مراجعة → `o2c:backfill` → rerun=0. 4) `o2c:reconcile` = PASS (أو تفسير delta AR↔GL). 5) جلسات دخول حقيقية (admin/موظف مخوّل/غير مخوّل). 6) `ORDER_TO_CASH_ENABLE=1` (تغيير واحد). 7) تحقق: `/api/version` orderToCash:true، القديم 409، القراءات تعمل. 8) مراقبة قصيرة. أي فشل ⇒ العلم→0 فورًا.
