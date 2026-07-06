# دليل تشغيل ترحيل المشتريات (Migration Runbook)

> يُطبَّق على قاعدة **محلية/اختبار فقط** — ممنوع على Production ضمن هذا العمل.

## المتطلبات
- Node 18+، MySQL 8 أو MariaDB.
- متغيرات البيئة في `.env`: `DB_*`, `JWT_SECRET`.
- علم التفعيل: `PROCUREMENT_P2P_ENABLE=1`.
- (اختياري) أكواد الحسابات: `PROCUREMENT_GRNI_ACCOUNT_CODE` (افتراضي 2150)، `PROCUREMENT_AP_ACCOUNT_CODE` (2100)، `PROCUREMENT_INPUT_VAT_ACCOUNT_CODE` (1290)، `PROCUREMENT_OVER_RECEIPT_TOLERANCE` (0)، `PROCUREMENT_MAKER_CHECKER` (1).

## الخطوات

1. **معاينة الترحيل (dry-run):**
   ```bash
   node scripts/procurement/migrate.js --dry-run
   ```
   يعرض كل عبارة ستُنفَّذ دون تطبيق.

2. **تطبيق المخطط (idempotent):**
   ```bash
   node scripts/procurement/migrate.js        # أو: npm run procurement:migrate
   ```
   يُنشئ حساب GRNI، يطوّر الجداول (version/idempotency/lifecycle/UoM snapshots)، ينشئ الجداول الجديدة (matches/allocations/returns/events + View)، يبذر صلاحيات `procurement.*`. آمن لإعادة التشغيل.

   > بديل: عند تشغيل الخادم بـ`PROCUREMENT_P2P_ENABLE=1` يتم التطبيق تلقائيًا على الإقلاع (خطوة واحدة).

3. **معاينة الترحيل التاريخي (dry-run):**
   ```bash
   node scripts/procurement/backfill.js       # npm run procurement:backfill
   ```
   يصنّف `purchases` القديمة (po_placeholder/direct/received/credit/cash/orphan)، يكشف تكرار الموردين (VAT→هاتف→اسم، **بلا دمج تلقائي**)، ويُخرج تقرير مراجعة JSON.

4. **تطبيق backfill اللقطات (آمن، إضافي):**
   ```bash
   node scripts/procurement/backfill.js --apply
   ```
   يملأ `base_qty`/`conversion_factor_snapshot`/`base_received_qty` على السطور القديمة فقط. لا ينشئ فاتورة وهمية من PO، ولا استلامًا بلا دليل مخزون.

5. **التسوية (إثبات الثوابت):**
   ```bash
   node scripts/procurement/reconcile.js       # npm run procurement:reconcile
   ```
   يؤكد: Σ lot = warehouse stock، Σ warehouse = inv_items.stock، كل GL متوازن، رصيد الفاتورة = الإجمالي − التخصيصات، ويعرض دلتا AP (GL مقابل المشتق). خروج ≠ 0 عند فشل ثابت.

6. **الاختبارات:**
   ```bash
   npm test                         # وحدات نقية (يشمل procurement)
   npm run test:procurement-api     # تكامل E2E على القاعدة (31 فحصًا)
   ```

## التحقق النهائي
- `reconcile` = PASS.
- `GET /api/procurement/dashboard` (بـJWT) يعيد بيانات.
- المسارات القديمة `POST /api/purchases/receive/:id` وأخواتها تعيد 409 (توجيه للوحدة الموحدة).

## ملاحظات
- لا يعتمد الترحيل على `db/migrate.js` المرقّم؛ يستخدم مُشغّل Node مُحصّن بـ`information_schema` (MySQL8 + MariaDB).
- الجداول الجديدة تُطبَّع إلى `utf8mb4_unicode_ci` لمطابقة الأساس (تفادي «Illegal mix of collations»).
