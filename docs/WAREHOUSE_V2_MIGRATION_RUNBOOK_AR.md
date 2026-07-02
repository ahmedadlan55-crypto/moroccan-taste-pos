# Runbook ترقية Warehouse V2 إلى Staging — المرحلة 5A

> **الفرع:** `codex/warehouse-v2-release-candidate` · **الأساس:** `f2e932d` (سلسلة 53 commit من `d8a5ab9`).
> **المبدأ:** كل الهجرات **إضافية idempotent** وتعمل تلقائيًا عند الإقلاع **قبل فتح المنفذ** (`autoInitDB()` ثم `app.listen`). لا توجد أي هجرة يدوية.

## 1) المتطلبات المسبقة

| البند | القيمة |
|---|---|
| Node.js | ≥ 20 (مُختبَر على 24) |
| MySQL/MariaDB | MySQL 8 / MariaDB 10.6+ (مُختبَر على MariaDB 11.4) |
| ذاكرة العملية | ~400MB RSS تحت حمل 50k صنف×مستودع |
| بناء الواجهة | `npm run build` (ينتج `frontend/warehouse/dist` — الرئيسية 192KB gzip) |

## 2) متغيرات البيئة (الجديدة في 5A بالخط العريض)

```
DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME
PORT، NODE_ENV=production، JWT_SECRET (سري قوي)
TZ=Asia/Riyadh                       ← افتراضي في الكود؛ اضبط توقيت نظام قاعدة البيانات أيضًا
WAREHOUSE_SCOPE_ENFORCE=1            ← إلزامي في staging/الإنتاج (افتراضيًا متوقف — تحذير إقلاع عند نسيانه)
**WAREHOUSE_V2_ENABLED=1**           ← 0 = تعطيل آمن (صيانة + منع كتابة v2؛ القديم يعمل)
**WAREHOUSE_V2_MUTATION_RATE_MAX=300** / **WAREHOUSE_V2_MUTATION_RATE_WINDOW_MS=60000**
ALLOWED_ORIGINS=https://your-domain  ← فارغ = سماح عام (وضع تطوير فقط)
INV_MAKER_CHECKER=1 (افتراضي)        · IDEMPOTENCY_RETENTION_DAYS=30
EXPIRY_CRITICAL_DAYS=7 · EXPIRY_WARNING_DAYS=30 · EXPIRY_RECEIPT_MIN_DAYS=30 · EXPIRY_BLOCK_NEAR_RECEIPT=0
```

## 3) خطوات الترقية (بالترتيب)

1. **نسخة احتياطية كاملة** لقاعدة البيانات (`mariadb-dump --single-transaction`) + توثيق commit الحالي من `GET /api/version`.
2. انشر الكود (بلا تشغيل) وابنِ الواجهة: `npm ci && npm run build`.
3. **Preflight قبل التشغيل** على نسخة القراءة/القاعدة نفسها:
   `npm run warehouse:v2:preflight -- --json` → يجب **BLOCKER = 0** (يخرج بغير صفر عند أي عائق). عالج أي عائق قبل المتابعة.
4. شغّل الخادم — الهجرات تعمل تلقائيًا قبل فتح المنفذ:
   - قاعدة فارغة: بناء كامل (~9-50 ث). قاعدة قائمة: no-op سريع. **مخطط ناقص جزئيًا: يُستكمل ذاتيًا** (مُثبَت: حذف جدولين+عمود ثم إقلاع → استُعيد كل شيء).
   - خادمان متزامنان على قاعدة فارغة آمنان (اختبار bootstrap يثبته) — لا حاجة لقفل هجرات.
   - `ALTER inv_items ADD tracking_mode` لحظي (instant/metadata) — لا قفل طويل على الجداول الكبيرة؛ والفهرس الجديد `idx_invmov_item_wh_date` يُبنى online (~0.8s لكل 100k حركة).
5. **تحقق الجاهزية:** `GET /api/inventory/v2/ready` → `200 {ready:true, checks:{db,schema,timezone}}`؛ و`GET /api/version` للـcommit.
6. **Dry-runs قبل تفعيل السياسات:**
   - نطاق المستودعات: `node scripts/backfill-warehouse-access.js` (dry-run افتراضيًا) → راجع «المستخدمين الذين سيُمنعون» (يظهرون أيضًا في preflight: `users_denied_before_scope`) → أسند المستودعات ثم `--apply`.
   - دفعات المشتريات التاريخية: `npm run migrate:purchase-lots` (dry-run + تقرير مطابقة) → يستورد المتطابق فقط عند `--apply`؛ **لا يمسّ المخزون إطلاقًا**؛ غير المتطابق يبقى «unverified» ويُسوّى بجرد v2.
7. فعّل تدريجيًا: `WAREHOUSE_SCOPE_ENFORCE=1` أولًا بمستخدمين تجريبيين (الإسناد عبر `user_warehouse_access` هو بوابة الطيار — من لا إسناد له لا يرى شيئًا)، والواجهة القديمة تبقى العودة الآمنة على `/`.
8. **بعد الترقية:** أعد `npm run warehouse:v2:preflight` (BLOCKER=0) + راقب `/api/metrics` (العدّادان `lot_invariant_violation_total` و`gl_imbalance_total` يجب أن يبقيا **صفرًا** — نبّه فورًا عند > 0؛ سطر log بمستوى fatal يصدر تلقائيًا).

## 4) قواعد السلامة المفروضة بالكود (لا تعتمد على انضباط بشري)

- لا كتابة مزدوجة لنفس الوثيقة/الرصيد: المسارات القديمة **ترفض الأصناف المُتتبَّعة** (WRITER_NOT_LOT_AWARE 422 برسالة عربية توجّه إلى v2) في: استلام المشتريات القديم، stock-update، الجرد القديم، register، receive-approve — بلا أي كتابة جزئية.
- تعطيل V2 (`WAREHOUSE_V2_ENABLED=0`) يوقف كتابة v2 فورًا (503) ويبقي القراءة والقديم — **بلا فقد بيانات**.
- `assertInvariant` بعد كل معاملة (للزوج المتأثر فقط) + GL لا يقبل قيدًا غير متوازن.

## 5) ملاحظات معروفة

- **توقيت جلسة قاعدة البيانات:** العملية تعمل بـ`Asia/Riyadh` لكن جلسة MariaDB قد تكون `SYSTEM` — اضبط توقيت نظام خادم القاعدة أو `default-time-zone='+03:00'` (يظهر في `/ready`).
- الحدّ من المعدّل في-الذاكرة أحادي العملية — خلف موازن حمل متعدد العُقد استكمله بحدّ على مستوى البنية.
- FKs على مستوى القاعدة غير معلنة لجداول الدفعات (التكامل مفروض تطبيقيًا + preflight يكشف اليتامى) — إضافة FKs هجرة مستقبلية موثقة في سجل المخاطر.
