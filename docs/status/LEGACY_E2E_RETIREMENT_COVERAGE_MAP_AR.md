# تقاعد اختبارات E2E القديمة + خريطة التغطية البديلة (B6)

## لماذا الحذف (وليس skip)
`e2e/accounting-screens.spec.ts` و`e2e/flags-off.spec.ts` كانا يقودان **الواجهة القديمة المحذوفة** (Vanilla-JS admin shell عبر `public/js/app.js` وخطافات `window.erpNav(...)` / `#adminView` / `coaTreeBody` / `[data-legacy-purchasing]`). حُذفت هذه الواجهة في تحويل `/`→`/app`:
- `server.js` يعيد توجيه `/` دائمًا إلى `/app/` بـ 302 («the legacy shell it used to serve is deleted»)؛ عند إطفاء `ERP_UNIFIED_ENABLED` يُقدَّم `/app` صفحة 503 لا الواجهة القديمة.
- خطافات هذه الاختبارات لا وجود لها في أي مصدر إنتاجي — فقط داخل هذين الملفين.

لذلك لا يمكن أن ينجحا بأي تجهيز بيانات، وبقاؤهما `skipped` يُخفي واقعًا. حُذف الملفان وإعداداتهما المخصّصة: `playwright.accounting.config.ts`، `playwright.accounting.prod.config.ts`، `playwright.flags-off.config.ts`. (بقي `e2e/accounting-global-setup.ts` لأنه مشترك مع `playwright.erp.config.ts`.)

## خريطة التغطية — نفس السيناريوهات تُغطّى الآن في React E2E

| سيناريو legacy محذوف | التغطية البديلة الحيّة |
|---|---|
| فتح كل شاشات المحاسبة (دليل الحسابات، القيود، الأستاذ، ميزان المراجعة، قوائم مالية، أعمار الذمم، الفترات…) وعدم وجود console/network errors | `e2e/erp/erp.spec.ts` (closure gate) يمشي **كل** أوراق `/app/accounting/*` في المانيفست على 4 مقاسات، ويفشل على أي console error أو استجابة ≥400 أو overflow أو حالة غير سليمة |
| عرض ميزان المراجعة ببيانات حقيقية | `e2e/erp/trial-balance-rbac.spec.ts` — دخول حقيقي كـ accountant/auditor، ميزان مراجعة **مُعبّأ ومتوازن** (Dr=Cr) ببيانات مبذورة، ورفض 403 حقيقي للكاشير |
| صلاحيات الوصول لشاشات المحاسبة | `trial-balance-rbac.spec.ts` (accountant/auditor 200، cashier 403 على الواجهة والـAPI) + `tests/integration/glSecurity.api.test.js` + `auditorRole.test.js` |
| المحاسبة بالعربية والإنجليزية | `e2e/erp/rc-bilingual.spec.ts` يمشي أوراق المحاسبة في ar/en، صفر نص نظام عربي في الإنجليزي، اتجاه صحيح، خط Cairo محلي |
| صحة محرك المحاسبة/الترحيل | مجموعة الوحدات: `trialBalanceEngine` (62)، `trialBalance` (40)، `journalMakerChecker` (26)، `auditAtomicity` (14)، `glSecurity` (16)، `glJournalConcurrency` (12) |
| سلوك «الأعلام مطفأة» (كانت تُظهر واجهة legacy بديلة) | تلك الواجهة البديلة حُذفت؛ سلوك الإطفاء الحالي هو صفحة 503 بسيطة عند `/app` (تدهور مقصود، ليس تدفّق مستخدم) — لا يحتاج E2E مخصّصًا |

**النتيجة:** لا فقدان لتغطية سيناريو حقيقي؛ فقط إزالة اختبارات لواجهة لم تعد موجودة. الهدف النهائي: صفر failed وصفر skipped من اختبارات ميتة.
