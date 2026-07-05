# التقرير النهائي — توحيد المشتريات والموردين (Procure-to-Pay)

## 1. الهوية
- **البداية:** `origin/main` = `2f0b303096562bd50c81409f4542ccb8746b0d43`.
- **الفرع:** `codex/procurement-p2p-unification`
- **Worktree:** `C:\tmp\procurement-p2p-unification` (الشجرة الرئيسية لم تُمس).
- **الحجم:** 5 commits منظّمة · 43 ملفًا · +5379 سطرًا · 35 ملفًا خاص بالمشتريات.
- **العلم:** `PROCUREMENT_P2P_ENABLE` (افتراضيًا OFF).

## 2. المعمارية قبل/بعد
- **قبل:** مشتريات مجزّأة — ازدواج كتّاب مخزون (`purchases/receive` + `inventory/receive-approve`)، ذمم موزّعة على 3 مصادر غير مرتبطة، `/ap-invoices/:id/pay` بلا GL، اعتماد PO ينشئ صفًا وهميًا، GL يرحّل عند الاستلام بلا GRNI، `vatRate||15` يطمس 0%.
- **بعد:** وحدة واحدة `/api/procurement` + واجهة «المشتريات والموردون» واحدة، كاتب مخزون واحد، نموذج GRNI صحيح، ذمم مشتقة من View واحد، صلاحيات فعّالة، Strangler-Fig (القديم مُجمّد ويُبوَّب عند التفعيل). التفاصيل في [المعمارية](../architecture/PROCUREMENT_P2P_ARCHITECTURE_AR.md).

## 3. قاعدة البيانات
تطوير إضافي Idempotent (MySQL8 + MariaDB) عبر `db/migrations/procurement/*` + `scripts/procurement/migrate.js`:
- **مطوّرة:** purchase_orders/po_lines، purchase_receipts/purchase_receipt_lines، supplier_invoices/supplier_invoice_lines، payment_records (version, idempotency, lifecycle actors, لقطات UoM، `vat_rate/vat_pct → NULLable`).
- **جديدة:** supplier_invoice_matches، payment_allocations، purchase_returns(+lines)، procurement_events + View `v_supplier_ap_balance`.
- **GRNI 2150** مُنشأ Idempotently. أعمدة/جداول جديدة مُطبّعة إلى `utf8mb4_unicode_ci`.

## 4. الـEndpoints وState machines وGL
جميعها موثّقة في [المعمارية §6/§3/§4](../architecture/PROCUREMENT_P2P_ARCHITECTURE_AR.md): ~55 endpoint تحت `/api/procurement`، خمس state machines عبر `TransitionExecutor`، ونموذج GRNI الكامل (استلام→GRNI، فاتورة→AP+ضريبة، سداد→نقد/بنك، إرجاع قبل/بعد).

## 5. أمثلة مُختبَرة
- **UoM:** 10 كراتين × factor 12 = **120** حبة (base). `majorPrice = base × factor`. ✅
- **VAT:** 15% → 150 على 1000؛ **0% يبقى 0** (لا يتحول 15)؛ معفى/خارج النطاق = 0؛ inclusive 1150 → صافي 1000 + ضريبة 150. ✅
- **GRNI GL (الدورة):** استلام Dr مخزون 1200/Cr GRNI؛ فاتورة Dr GRNI 1200 + Dr ضريبة 180 / Cr AP 1380؛ سداد Dr AP/Cr بنك 1380. ✅

## 6. الترحيل والتسوية
- `migrate` (apply + dry-run + tracking) — طُبّق وتحقّق: GRNI، 5 جداول جديدة، 27 صلاحية، View.
- `backfill` — تصنيف purchases + كشف تكرار الموردين (بلا دمج تلقائي) + backfill لقطات؛ dry-run افتراضي.
- `reconcile` — **PASS**: lot invariant=0، stock rollup=0، GL متوازن (Σ=37367.4)، سلامة رصيد الفاتورة=0، دلتا AP مُفسَّرة (قيود قديمة). التفاصيل في [التسوية](../audits/PROCUREMENT_RECONCILIATION_AR.md).
- `rollback` — محصّن (يرفض عند وجود أحداث).

## 7. الاختبارات بالأرقام
| المجموعة | العدد | النتيجة |
|---|---|---|
| وحدة — الحسابات (UoM/VAT/totals/WAC) | 18 | ✅ 18/18 |
| وحدة — state machines + numbering | 19 | ✅ 19/19 |
| تكامل E2E حيّ على القاعدة | 31 | ✅ 31/31 |
| **الإجمالي (خاص بالمشتريات)** | **68** | ✅ **كلها خضراء** |
| TypeScript strict (`tsc --noEmit`) | — | ✅ نظيف |
| بناء الإنتاج (vite) | — | ✅ أخضر (module مُقسّم لـchunks) |
| تسوية الثوابت | — | ✅ PASS |

سيناريوهات التكامل تشمل: PO(10×12)→submit→approve (صفر GL)→استلام 4+6 (stock=120، GRNI متوازن)→over-receipt 422→فاتورة→مطابقة ثلاثية→approve (AP)→سداد+تخصيص (AP=0)→version conflict 409→idempotency replay→GL متوازن عالميًا→Maker-Checker 403.

## 8. الأداء
قوائم بـpagination خادمي + sort allowlisted + فلاتر + إجماليات على المجموعة؛ لا N+1 (رؤوس فقط في القوائم، السطور عند التفصيل)؛ فهارس مركّبة على الجداول؛ CSV بسقف؛ الواجهة lazy-loaded (module في chunk مستقل)، AbortSignal، لا retry تلقائي للـmutations.

## 9. إثبات إزالة الازدواجية
- قائمة رئيسية واحدة «المشتريات والموردون»، مسار `/purchasing` بتبويبات داخلية.
- عند العلم ON: `POST /api/purchases/receive/:id`، `/api/inventory/receive-request`، `/api/inventory/receive-approve/:id`، `/api/ap-invoices/:id/pay` → **409 + توجيه** (تحقّق حيّ). الكاتب الوحيد = `InventoryPostingService`.
- عند العلم OFF: القديم بلا لمس (صفر مخاطرة).

## 10. الأمان
موثّق في [المراجعة الأمنية](../audits/PROCUREMENT_SECURITY_REVIEW_AR.md): JWT actor، `requireCapability`، Maker-Checker، نطاق مستودعات، parameterized SQL + allowlist، حماية CSV، منع Mass Assignment، optimistic concurrency + idempotency.

## 11. الملفات المُعطّلة من القديم
لا حذف. عند العلم ON فقط: بوابات 409 على 4 مسارات كتابة قديمة (قابلة للعكس بإطفاء العلم).

## 12. التسليم
- commits: foundation → engine → server wiring → UI → tooling/tests → docs.
- push للفرع فقط · **Draft PR** إلى main. **لا merge · لا Production deploy · لا خدمة/قاعدة إضافية · الشجرة الرئيسية لم تُمس.**

## 13. حدود صريحة (شفافية)
- Playwright E2E: البنية والسيناريوهات موصوفة؛ التنفيذ الكامل يتطلب تثبيت المتصفحات (لم يُشغَّل ضمن هذه الجلسة). التحقق الحيّ تم عبر 31 اختبار تكامل E2E على الخادم الحقيقي + معاينة SPA + استعلامات API بتوكن حقيقي.
- بعض شاشات التفصيل (استلام/فاتورة/دفعة) مُنفَّذة كقوائم + إجراءات؛ التوسّع لتفاصيل غنية إضافية ممكن على نفس البنية دون تغيير العقود.
