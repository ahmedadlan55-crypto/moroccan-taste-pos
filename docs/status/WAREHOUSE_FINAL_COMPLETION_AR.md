# إغلاق المستودعات — تقرير الإنجاز (Track 1: W1→W5)

> فرع `codex/warehouse-final-completion` من `6288290`. **لا مساس بالإنتاج ولا Canary ولا المراقبة** — كل التطوير والاختبار على الفرع + Staging/MariaDB المعزول.

## القرار: ✅ **WAREHOUSE BACKEND FUNCTIONALLY COMPLETE** (واجهات SPA للميزات الثلاث الجديدة = البند المتبقّي الوحيد، موثّق أدناه)

كل منطق الأعمال ونقاط الـAPI والهجرات والاختبارات مكتملة ومُثبتة على بيانات إنتاج حقيقية و/أو MariaDB وStaging. الواجهة الأمامية للشاشات الإدارية الثلاث الجديدة (إعدادات السالب، تقرير العجز، محرّر الباركود) هي العمل المتبقّي الوحيد وقابلة للبناء فوق طبقة البيانات القائمة.

---

## W1 — إغلاق فجوة 161 مادة قديمة  ✅ (مُثبَت على نسخة إنتاج حقيقية)
- `scripts/reconcile-legacy-materials.js` (dry-run/apply/revert، Transaction + فحص ثابت).
- على `prod_rehearsal_5c`: **161 صنفًا مُدرَجًا**، الفجوة (LEFT JOIN) = 0 بعد، إجماليات المخزون **513/34091.01/1.081 قبل = بعد**، preflight = BLOCKER 0.
- إضافي بحت: لا مساس بـ`warehouse_stock` ولا WAC ولا GL. artifact للـrevert. اختبار 4/4.

## W2 — سياسة المخزون السالب  ✅ (22/22 تكامل + 19/19 وحدة)
- `lib/negativeStockPolicy.js`: resolver (المستوى الأكثر تحديدًا يفوز + allow-gating + lot/expiry=block دائمًا) + evaluator (كل البوابات) + decide.
- حارس اختياري في `lib/inventoryTxEngine.js:applyStockMovement` خلف `NEGATIVE_STOCK_POLICY_ENABLED` (**مطفأ افتراضيًا** — سلوك مطابق للنظام القائم؛ inv-tx 46/46).
- `routes/negative-policy.js`: `GET /` · `GET /effective` · `PUT /` (RBAC + expectedVersion + Audit؛ allow→developer؛ tracked→422) · `GET /deficits[/export]` (CSV آمن).
- جدولا `negative_stock_policy` (+ global/block) و`stock_deficits` (open→partial→covered/adjusted) — تغطية العجز بالاستلام اللاحق.
- **غير مُفعّل على الإنتاج** — اختُبر بالتفعيل محليًا فقط.

## W3 — استلام المشتريات V2 (جزئي + ربط PO/مورد)  ✅ (11/11)
- أعمدة `inv_receipts.purchase_id/supplier_id` + `purchases.v2_receive_status` (لا يمس ENUM القديم).
- `GET /purchases/:id/receive-plan` + قبول `purchaseId` في الاستلام (منع تجاوز = 422 OVER_RECEIPT) + إعادة حساب الحالة عند الترحيل + `po_lines.received_qty`.
- حماية النظام القديم: receive→409 ALREADY_RECEIVED_IN_V2، revert→409 V2_RECEIPTS_LINKED.
- الثابت (Σ دفعات = رصيد) + WAC + GL + idempotency سليمة عبر المسار الكامل 100→60→40.

## W4 — باركود موحّد  ✅ (10/10 تكامل + 4/4 وحدة)
- `lib/barcode.js` (normalize/isValid/requireValid) + `inv_items.barcode(_norm)` UNIQUE + جدول `item_barcodes` (أحجام متعددة).
- `GET /items/by-barcode` (أسبقية item_barcodes ثم inv_items) + `PUT /items/:id/barcodes` (تفرّد عبر الجدولين = 409 BARCODE_TAKEN) + بحث القائمة + مسح الجرد بالباركود. **SKU دون مساس.**

## W5 — بوابة التحقق  ✅
- وحدات **25/25** ملفًا · تكامل **18 حزمة** خضراء (46+14+20+12+21+39+41+19+9+13+4+16+10 + الجديدة 22+11+10) · **tsc + vite build** ✓.
- **Staging**: الهجرات الإضافية طُبِّقت (الجداول + الأعمدة + global/block) · **preflight = BLOCKER 0**.
- الإنتاج غير مُتأثّر: `/api/version` = `dcc21653` (startedAt ثابت) · Canary=admin,5000 · المراقب السحابي يعمل (صفوف جديدة كل 5 دقائق).

## البند المتبقّي (واجهة SPA للميزات الجديدة)
شاشات React الثلاث تُبنى فوق الـAPI الجاهز: (1) إعدادات المخزون السالب (تبويبات global/warehouse/item + معاينة القرار الفعّال + إخفاء allow عن غير developer)، (2) تقرير «عجز مخزني يجب تسويته» + CSV، (3) محرّر باركود في شاشة الصنف (أساسي + ثانويات + حجم). طبقة البيانات (endpoints + عقود) جاهزة ومُختبَرة.

## الالتزامات
`bfefa11` (W1) · `<W2>` · `e675ad4` (W3) · `e2bae5b` (W4) — على الفرع فقط، لا دمج، لا main. **لا نشر إنتاج، لا تغيير Canary/Scope، المراقبة لم تتوقف.**
