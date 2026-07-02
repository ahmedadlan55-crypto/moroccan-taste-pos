# Release Manifest — Warehouse V2 · المراحل 5A/5B/5B.1

> **قرار 5A:** READY FOR STAGING → **قرار 5B:** STAGING ACCEPTED → **5B.1:** تقوية نهائية (توقيت القاعدة + metrics) — انظر §7.
> الفرع مدفوع إلى `origin/codex/warehouse-v2-release-candidate` فقط · **Draft PR #4 غير مدمج** · لا نشر إنتاج.

## 0) حالة Staging (المرحلة 5B — 2026-07-02)

| البند | القيمة |
|---|---|
| الرابط | https://warehouse-staging-production-aa06.up.railway.app |
| مشروع Railway المنفصل | `moroccan-pos-staging` · `6cc5b7a3-313f-43dc-b3b9-672fbfa9bcdc` (MySQL 9.4 مستقل + أسرار مستقلة) |
| Backup ID | `staging-backup-2026-07-02T01-10-46.sql` · SHA256 `715822c2…f015` |
| UAT على الرابط الحي | **56/56** (15 خطوة × 7 دخولات حقيقية) + 8 لقطات + صفر كونسول + 5xx=0 |
| p95 عبر HTTPS | ≤273ms لكل الواجهات العشر (الشبكة هي الغالب) · RSS 85MB |
| Rollback Drill | ✅ V2=0 → نشر النسخة السابقة `c42847b` (عملت على القاعدة المُهاجَرة) → استعادة RC → preflight 0 → V2=1 |
| Preflight على Staging | **BLOCKER=0** (قبل وبعد apply وبعد الدرل) |

## 7) المرحلة 5B.1 — التقوية النهائية

1. **توقيت القاعدة جذريًا (بلا SET GLOBAL):** `db/connection.js` يفرض `SET time_zone='+03:00'` على **كل اتصال جديد** في الـpool (يبقى بعد أي إعادة تشغيل لقاعدة البيانات تلقائيًا) + خيار `timezone` صريح في mysql2 لتحويلات DATETIME (مستقل عن TZ العملية) + متغير `DB_TIME_ZONE` للضبط. الفصل موثق: timestamps تُخزَّن وتُقرأ بجلسة الرياض، expiry أعمدة DATE تقويمية لا تتأثر بالتحويل. `/ready` صار **يفحص إزاحة الجلسة الفعلية** (`NOW()-UTC = +180min`) ويُخفق (503) عند أي انحراف. اختبار `test:db-timezone` (10 تأكيدات: 3 اتصالات، round-trips، حدود اليوم CURDATE، تطابق DATEDIFF مع expiryPolicy، بوابة /ready).
2. **Metrics:** مُركِّب `requests_total` انتقل إلى **قمة سلسلة `/api`** (قبل كل الراوترات والبوابات → يحسب 401/429 أيضًا) بوسوم محدودة **method / normalized_route / status_class** (كل معرّف يُطوى إلى `:id`، سقف 300 مسار ثم `other` — لا URL خام ولا cardinality انفجاري) معروضة في `/api/metrics/json` (`requests_by_route`) وProm (`http_requests_route_total{…}`). عدّادات v2 لم تتكرر (تأكيد +1 بالضبط). اختبارات: `metricsContract` وحدة (5) + ops-api صار 13.

## 1) الكود

| البند | القيمة |
|---|---|
| الفرع | `codex/warehouse-v2-release-candidate` (محلي، **بلا upstream**) |
| الأساس | `f2e932d` (سلسلة 53 commit كاملة من merge-base `d8a5ab9` مع main) |
| commits المرحلة 5A | 8 منظمة: `eeee84c` أمن · `5d5bef1` مراقبة · `7aacfd8` أعلام · `5c3f8da` preflight · `f482938` أداء+فهرس · `3e24f6e` حرّاس الكتّاب القدامى · `5e2d33b` UAT+وصولية · + commit الوثائق النهائي |
| التبعيات | `npm audit --omit=dev` = **0 ثغرات** (رُقّي express 4.22.2 ضمن semver لإغلاق سلسلة qs المتوسطة) |
| بناء الواجهة | `npm run build` — الرئيسية **192KB gzip** + Analytics 111KB (كسول) |

## 2) متغيرات البيئة (المطلوبة للـstaging)

```
WAREHOUSE_V2_ENABLED=1
WAREHOUSE_SCOPE_ENFORCE=1            ← إلزامي (بند إطلاق)
JWT_SECRET=<سري قوي>
ALLOWED_ORIGINS=<نطاقات محددة>
TZ=Asia/Riyadh (+ default-time-zone='+03:00' في my.cnf — بند إطلاق)
WAREHOUSE_V2_MUTATION_RATE_MAX=300 / _WINDOW_MS=60000
INV_MAKER_CHECKER=1 · IDEMPOTENCY_RETENTION_DAYS=30
EXPIRY_CRITICAL_DAYS=7 · EXPIRY_WARNING_DAYS=30 · EXPIRY_RECEIPT_MIN_DAYS=30 · EXPIRY_BLOCK_NEAR_RECEIPT=0
```

## 3) الاختبارات — الأرقام النهائية (كلها من هذا الفرع)

| الحزمة | النتيجة |
|---|---|
| سلسلة الوحدات `npm test` (20 ملفًا؛ آخرها securityHardening) | ✅ 0 فشل (منها: expiryPolicy 23 · lotLedger 11 · itemPolicy 15 · replenishment 31 · contract 18 · **securityHardening 11**) |
| scope-api · reports-api · transfers-api (41) · gl-concurrency (6) · idempotency-retention (11) | ✅ PASS |
| inv-tx-api **46** · inv-tx-reverse **14** | ✅ PASS |
| stocktake-api **39** · stocktake-concurrency **4** · stocktake-lots **8** | ✅ PASS |
| item-master **26** · replenishment **13** | ✅ PASS |
| lots-api **20** · lot-concurrency **25** · **lot-writers 12** (+5 حرّاس جدد) · lot-integrity **21** · lot-migration **11** | ✅ PASS |
| **security-api 9 · ops-api 9 · flags-api 4 · preflight 8** (جديدة في 5A) | ✅ PASS |
| bootstrap فارغة + خادمان متزامنان | ✅ 69/69 |
| الواجهة: `tsc` + vitest + build | ✅ نظيف · **89/89** · بناء ناجح |
| **UAT** (15 خطوة، 6 أدوار، ENFORCE=1) | ✅ **50/50** + 15 لقطة + **صفر أخطاء كونسول** |
| preflight على قاعدة التطوير | ✅ **BLOCKER = 0** |
| المخطط الجزئي (حذف جداول/عمود ثم إقلاع) | ✅ اكتمال ذاتي + ready 200 |
| الأداء (المواصفة الكاملة) | ✅ p50/p95 موثقة + فهرس واحد بدليل (تقرير الأداء) |

## 4) الأدوات التشغيلية الجديدة

`npm run warehouse:v2:preflight` (بوابة مصالحة، خروج غير صفري عند BLOCKER) · `npm run perf:warehouse-v2` · `node scripts/uat-warehouse-v2.cjs` · `GET /api/inventory/v2/ready` · عدّادات `/api/metrics` (نبّه عند `lot_invariant_violation_total>0` أو `gl_imbalance_total>0`).

## 5) شروط الإطلاق (Go-conditions)

1. `WAREHOUSE_SCOPE_ENFORCE=1` + مراجعة إسنادات `user_warehouse_access` (preflight يسردها).
2. ضبط توقيت قاعدة البيانات إلى الرياض (`/ready` يعرضه).
3. `ALLOWED_ORIGINS` و`JWT_SECRET` إنتاجيان.
4. تشغيل preflight بعد الترقية مباشرة → BLOCKER=0.
5. ربط التنبيه على عدّادي السلامة + متابعة runbook الترقية خطوة بخطوة.

## 6) الوثائق

`docs/WAREHOUSE_V2_RELEASE_AUDIT_AR.md` · `docs/WAREHOUSE_V2_UAT_AR.md` · `docs/WAREHOUSE_V2_MIGRATION_RUNBOOK_AR.md` · `docs/WAREHOUSE_V2_ROLLBACK_RUNBOOK_AR.md` · `docs/WAREHOUSE_V2_RISK_REGISTER_AR.md` · `docs/status/WAREHOUSE_V2_PERF_REPORT_AR.md` · هذا الـmanifest. الأدلة المولّدة (لقطات + JSON) في `artifacts/` محليًا.
