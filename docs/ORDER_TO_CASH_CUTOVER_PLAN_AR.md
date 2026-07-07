# خطة التفعيل (Cutover) — Order-to-Cash

> للتنفيذ الإنتاجي لاحقًا (خارج نطاق هذه الدفعة: لا Production write/merge/deploy الآن). تغيير علم واحد `ORDER_TO_CASH_ENABLE`، خدمة/قاعدة واحدة.

## البوابات قبل التفعيل
1. **نسخة احتياطية طازجة** + اختبار استعادة.
2. **بناء الواجهات**: `npm run build` (يشمل `build:sales`) — يجب أن يُنتج `frontend/sales/dist`.
3. **الترحيل**: `npm run o2c:migrate` (apply→rerun نظيف، idempotent).
4. **Backfill**: `o2c:backfill --dry-run` مراجعة → `o2c:backfill` → rerun=0.
5. **المطابقة**: `npm run o2c:reconcile` = PASS (أو تفسير delta AR↔GL).
6. **جلسات حقيقية**: admin + موظف مخوّل + غير مخوّل.

## التفعيل
- ضبط `ORDER_TO_CASH_ENABLE=1` (تغيير واحد) → إعادة تشغيل.
- تحقق `/api/version.orderToCash=true` (بقية الأعلام بلا مساس).

## التحقق بعد التفعيل
- القائمة الرئيسية: قسم واحد «المبيعات والعملاء»؛ القديم مخفي (`[data-legacy-o2c]`)؛ `nav('sales')`/`erpNav(...)` تُحوّل إلى `/sales`.
- `/sales` يخدم الـSPA؛ 401 بلا توكن؛ 403 لموظف بلا `o2c.view`.
- بوابات الكاتب الواحد: `POST /api/ar-invoices`→409، سند قبض عميل→409، عكس/حذف البيع القديم→409، بيع آجل بلا عميل→422؛ القراءات القديمة تعمل؛ إنشاء بيع POS يمرّ.
- `o2c:reconcile` = PASS؛ صفر أخطاء console؛ Smoke على Desktop + Mobile.

## التراجع (Rollback)
- **الأساسي:** `ORDER_TO_CASH_ENABLE=0` → القسم يختفي، البوابات تُفكّ، القديم يعود، الجداول الإضافية خاملة (بلا فقد بيانات). عكسي فورًا بتغيير علم واحد.
- استعادة DB **فقط** عند ثبوت تلف (النسخة الاحتياطية أعلاه).

## عمل لاحق مطلوب قبل الاعتماد الكامل
1. **تكامل واجهة POS** (`frontend/pos`): منتقي عميل يحفظ `customer_id` فعليًا + بنية مدفوعات منظمة `payments:[{method,amount}]` + منع الآجل offline. (البوابة الخادمية تفرض «الآجل يتطلب عميلًا» بالفعل، لكن UX الكاشير يحتاج التحسين.)
- «فتح الكاشير» في القائمة الرئيسية → `/pos-v2` عند `POS_V2_ENABLED=1` (داخل `/sales` مُنفَّذ بالفعل).
2. **Playwright E2E** كامل (§سيناريوهات UAT) على خادم حيّ + جلسة.
3. **بذر أداء** production-like + قياس p95 للقوائم/اللوحة/التقارير.

## تأكيدات
لا تغيير `WAREHOUSE_V2_ENABLED`/`POS_V2_ENABLED`/`PROCUREMENT_P2P_ENABLE`/`WAREHOUSE_SCOPE_ENFORCE`/`JWT_SECRET`. خدمة/قاعدة واحدة. Draft PR فقط. لا merge/deploy.
