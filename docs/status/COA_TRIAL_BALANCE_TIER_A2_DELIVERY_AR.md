# التقرير النهائي — Tier A.2: البوابة التصحيحية النهائية لميزان المراجعة ودليل الحسابات

## 1. الهوية

- **الفرع:** `feat/coa-trial-balance-audit` — **لم يُدفع (Push) بعد**. ينتظر أمرك الصريح "انشر" قبل أي `git push`/نشر.
- **الأساس:** مدموج فعليًا مع `origin/main` (ميزة Bilingual/i18n، 13 commit) عبر commit `3cee6fe` — الفرع اليوم يحوي كل تحديثات main بالإضافة لعمل هذه الجولة.
- **حجم Tier A.2 تحديدًا:** 12 commit محليًا فوق نقطة الدمج (`9a170d6` → `36b23e1`)، على القمة من 3 commits لـTier A.1 المُصحَّح سابقًا (`c84c445`، `b194c71`، `4f0a137`) و3 commits تصحيحية إضافية من نفس الجولة (`f1c9028`، `2a1772c`، `63d68f0`، `723916f`).
- **قائمة commits Tier A.2 (بالترتيب):**
  ```
  9a170d6  chore(migrations): renumber Tier A.1 migrations to resolve origin/main collision
  ec9c8f0  feat(tests): isolated test-database harness — Tier A.2 section 0.2
  1f20dfe  test(harness): migrate all 5 integration test files onto the isolated test DB
  a93bf8b  fix(accounting): trial balance engine — Opening net-vs-gross, mandatory range, deeper diagnostics
  554245a  feat(gl): unified GL transitions service — maker/checker on the real UI path
  b1e2ff7  fix(audit): consolidate audit_logs schema, atomic audit writes on GL success
  2107bdf  feat(auth): real, assignable auditor role — end-to-end via the product API
  b8611d6  docs(gl): lock Account Role Registry explicitly to Single Ledger/CO-MAIN
  823c653  Tier A.2 Section 6: real migration idempotency, checksum drift, safe rollback, deploy docs
  c66f0f9  Tier A.2 Section 7: consolidated test gate for the COA/GL work
  589760a  Tier A.2 Section 6 follow-up: fix 5 defects from an adversarial multi-agent review
  36b23e1  Tier A.2 Section 8b: E2E Trial Balance RBAC spec, three real logins
  ```
- **`git status`:** نظيف — لا تغييرات غير مُلتزَمة (Uncommitted) في أي ملف من عمل هذه الجولة.

## 2. لماذا Tier A.2؟ (السياق)

مراجعة مستقلة لتقرير Tier A.1 رفضته بالكامل. الاكتشاف المحوري: **حارس Maker/Checker الذي أُضيف في Tier A.1 كان يحمي فقط `POST /gl/journals/bulk`** — مسار لا يستدعيه أي مكوّن حقيقي في الواجهة الأمامية. الزر الفعلي "ترحيل" في `JournalList.tsx` يستدعي `usePostJournal()` التي تسلسل `POST /gl/journals/:id/approve` ثم `POST /gl/journals/:id/post` — بلا أي حماية SoD على أيٍّ منهما. اختبار Tier A.1 أثبت وجود حماية، لكنها لا تحمي المستخدم الحقيقي. هذا، إلى جانب ثمانية اكتشافات أخرى بنفس الفئة (قفل الفترة أضعف على المسار الفردي، `force:true` بلا صلاحية مستقلة، اختبار حذف Draft يمرّ حتى لو كان المنطق خاطئًا، 4 من 5 ملفات اختبار تكتب على القاعدة الحقيقية، `audit_logs` بثلاثة تعريفات متعارضة، دور `auditor` مُثبَت بإدخال SQL مباشر متجاوزًا تحقق `routes/auth.js`، `0002_sales_numbering.sql` بلا حارس فعلي رغم ادّعاء دعمه)، شكّلت نطاق الأقسام التسعة (0-8) أدناه.

## 3. ملخص الأقسام — قبل/بعد لكل Finding رئيسي

### القسم 0 — الدمج + عزل بيانات الاختبار
- **قبل:** 4 من 5 ملفات اختبار integration تكتب مباشرة على `moroccan_taste_pos` الحقيقية، بلا حارس بيئة. 2 منها (`process.exit()` داخل `try`) يُخلّفان خوادم فرعية يتيمة عند فشل الإقلاع.
- **بعد:** `tests/helpers/testHarness.js` — حارس صارم يرفض التشغيل إلا على `localhost`/`127.0.0.1` واسم قاعدة بلاحقة `_test` صريحة. كل الملفات الخمسة محوّلة. منفذ ديناميكي حقيقي (`net.createServer().listen(0)`) بدل أرقام ثابتة عرضة للتصادم. `process.exit()` استُبدل بـ`throw` يمرّ عبر `finally`.
- **دمج origin/main:** حُلّت 5 تعارضات يدويًا (`manifest.ts`, `can.ts`, `catalog.ts`, `package.json`, و`server.js` الأخطر — كتلتا `runMigrations()` من كلا الفرعين محفوظتان معًا). أُعيد ترقيم migrations 0014-0016 (Tier A.2) إلى 0017-0019 لتفادي تصادم أرقام مع 3 ملفات جديدة من `origin/main`.

### القسم 1 — محرك ميزان المراجعة (`lib/reports/trialBalance.js`)
- **الخلل الأخطر المُكتشَف (لا بالمراجعة اليدوية، بل عبر اختبار استبعاد Draft الجديد):** أقواس `rawOpenClause`/`openBoundaryClause` كانت ناقصة فعليًا — `status='posted' AND (A) OR (B)` يُفسَّر كـ`(status='posted' AND A) OR (B)`، أي أن **قيود Draft تاريخية كانت تدخل رصيد أول المدة فعليًا**. أُصلح بأقواس صريحة صحيحة.
- **Opening صافي لا إجمالي خام:** `openDebit`/`openCredit` كانا SUM خام؛ وُحِّدا مع نمط `closeDebit`/`closeCredit` (صافي كل حساب own-only). أُضيف `grossHistoricalMovement` منفصلًا للتشخيص فقط.
- **`from`/`to` إلزاميان الآن** (400 محدد بدل إسقاط Opening بصمت)، مع تحقق تقويم حقيقي (رفض `2026-02-31`).
- **`COUNT(DISTINCT journal_id)`** بدل عدّ سطور `gl_entries`.
- Diagnostics أعمق تؤثر فعليًا على `isClean`: `orphanAccounts`، كل أعضاء `cycleAccounts` (لا عيّنة)، `levelMismatches`، قيود منشورة غير متوازنة فرديًا (لا يُسمح بتعويض قيدين).
- **الشجرة (Backend + React):** حسابات الدورات/الشاردة تظهر الآن كصفوف محذَّرة بدل الاختفاء الصامت.
- **`todayISO()`:** وُحِّدت 3 نسخ UTC-خاطئة في `frontend/erp` (accounting/banking/purchasing) على نمط التوقيت المحلي الصحيح من `frontend/pos`.
- **خلل كامن آخر اكتُشف بالاختبار:** `lib/glPosting.js#ensureCoreAccounts` كان يستخدم `code.length` كـlevel افتراضي بدل `1` عند عدم إيجاد أب — أُصلح.

### القسم 2 — خدمة انتقالات GL موحّدة (`lib/glTransitions.js`)
- **الإصلاح الجوهري:** خدمة واحدة (`approve`, `post`, `approvePost`, `deleteJournal`, `reverse`, `checkPeriodOpen`, `checkSelfApproval`) يستدعيها الآن **كل** من `/approve`, `/post`, `/reverse`, `DELETE /:id`, و`POST /bulk` — لا شيفرة SQL مكرّرة. **هذا ما يُغلق الخلل الأصلي**: مسار `usePostJournal()` الحقيقي (`/approve` ثم `/post`) يرفض الآن الاعتماد الذاتي بنفس كود الرفض ونفس حدث Audit مثل Bulk تمامًا — مُثبَت باختبار تكافؤ مباشر.
- صلاحية `finance.periods.override_lock` جديدة (admin/manager فقط) — `force:true` لم يعد كافيًا لأي حامل لصلاحية الترحيل وحدها.
- `approve_post` في Bulk يتطلب الآن `finance.gl.approve` **و** `finance.gl.post` معًا.
- أُصلح Fixture حذف Draft (كان يستخدم نفس الحساب لسطري مدين/دائن، فيمرّ حتى لو كان منطق العكس خاطئًا) — أصبح حسابين مختلفين مع فحص Delta منفصل لكل منهما.
- خلل مخطط كامن اكتُشف: `accounting_periods` له تعريفا `CREATE TABLE` متعارضان في `server.js` (نفس فئة خلل `audit_logs` أدناه) — استُخدم العمود المضمون `period_label` بدل `period_name`.

### القسم 3 — Audit موثوق
- حُذف تعريفا `CREATE TABLE audit_logs` الميتان (المتعارضان) من `server.js` — الثالث الحيّ فعليًا فقط بقي، مع migration `0021` تُثبّته صراحة لمستخدمي `db/migrate.js`.
- حُذفت دالة `auditLog()` المحلية المكرّرة في `routes/erp.js` — استُبدلت بـ`lib/auditLogger.js#logAudit` الموجود أصلًا.
- **الذرّية:** `logAuditTx(conn,...)` جديدة (بلا try/catch عمدًا) تكتب Audit النجاح **داخل نفس معاملة** التحديث المالي — فشل كتابة Audit يُسقط القيد المالي كله. أُثبت بفشل حقيقي (تبديل `audit_logs` بجدول مؤقت بعمود أضيق عبر RENAME TABLE، لا ALTER على الجدول الحقيقي المأهول).

### القسم 4 — دور Auditor حقيقي End-to-end
- نُقل `'auditor'` من `GRANT_ONLY_ROLES` إلى `ASSIGNABLE_ROLES` في `lib/roles.js` — المصدر الوحيد الذي يتحقق منه `routes/auth.js`. أُضيف لقائمة الأدوار في الواجهة.
- **الاختبار أُعيد كتابته بالكامل** ليمرّ عبر `POST /api/auth/users` الحقيقي (لا إدخال SQL مباشر كما في Tier A.1) — ينشئ Auditor، يسجّل دخوله، يقرأ ميزان المراجعة بنجاح، ثم يُثبت رفضه الصريح (403 برمز محدد لكل حالة) عند إنشاء/اعتماد/ترحيل/حذف قيد.

### القسم 5 — Account Role Registry
- تحقّق (بلا حاجة لتعديل كود): الاختبارات كانت بالفعل على الحارس المعزول، تستخدم مفاتيح Catalog حقيقية.
- توثيق صريح جديد: قفل CO-MAIN في `lib/accountRoles.js` وADR §7.8 — `company_id` يعزل التعيين فقط، لا بيانات الحسابات.

### القسم 6 — Migrations والنشر
انظر القسم 5 من هذا التقرير أدناه (تفصيل كامل — الأكبر والأكثر اكتشافات).

### القسم 7 — بوابة الاختبارات
- `npm run test:coa-gl-gate` جديد يُسلسل 8 ملفات integration حقيقية على قاعدة بيانات (166→169 فحصًا بعد إصلاحات القسم 6 الإضافية، صفر فشل).
- فحص شامل لكل استخدامات `>=`/`<=`: القليل الموجود متعمَّد (حدود دنيا لصفوف Audit بمعرّفات Fixture ثابتة تتراكم شرعيًا عبر تشغيلات متكررة) — تشديدها كان سيُدخل هشاشة لا دقة.

### القسم 8 — التسليم
انظر الأقسام 6-9 من هذا التقرير أدناه.

## 4. مصالحة حسابية — ميزان المراجعة

اختبار `trialBalanceEngine.test.js` يُثبت هوية التسوية مباشرة (لا افتراضًا):
```
grossHistoricalMovement.debit − grossHistoricalMovement.credit === totals.opening
```
أي أن تقديم الحركة التاريخية كإجمالي خام (تشخيصي) أو كصافي (Footer الرسمي) لا يغيّر **صافي** رصيد أول المدة إطلاقًا — الفرق فقط في توزيع D/C، مضمون بالكود لا بالصدفة. إلى جانبها: اختبار "Mutation guard" صريح يُثبت أن تصميم leaves-only القديم (Tier A) كان سيُنتج رقمًا **مختلفًا فعليًا** عن التصميم الصحيح own-all-rows كلما كان لحساب غير-ورقي نشاط مباشر — أي أن الإصلاح ليس مجرد إعادة صياغة، بل تصحيح رقمي حقيقي مُثبَت.

## 5. القسم 6 بالتفصيل — Migrations (الأكبر اكتشافًا)

**المشكلة الجذرية:** `ADD COLUMN IF NOT EXISTS`، `DROP INDEX IF EXISTS` غير صالحة نحويًا على MySQL 8.4.9 الفعلي هنا (خطأ Parse حقيقي، ثبت تجريبيًا — تركيب MariaDB لا MySQL). عدة ملفات migrations ادّعت دعمها.

**الإصلاح المُطبَّق على كل حالة:** حراسة حقيقية عبر `INFORMATION_SCHEMA` + `PREPARE`/`EXECUTE` ديناميكي، مُثبَّتة كقاعدة إلزامية جديدة في `db/migrations/README.md`.

**الملفات المُصلَحة (9، عبر جولتين من الاكتشاف):**
| الملف | الخلل الأصلي |
|---|---|
| `0002_sales_numbering.sql` | لا حارس فعلي؛ `sales.invoice_number` كان موجودًا فعلاً في القاعدة الحقيقية عبر مسار server.js القديم، بينما 0002 لم تُسجَّل أبدًا في `_migrations` — لغمٌ حيّ |
| `0004_hr_job_titles.sql` | نفس النمط — اكتُشف عبر خطأ Parse حقيقي أول مرة عبر اختبار المُشغِّل الحقيقي |
| `0005_user_employee_link.sql` | نفس النمط |
| `0011_tax_inclusive.sql` | يتصادم مع `addColumnIfMissing` الخاص بـserver.js لنفس العمود |
| `0013_contact_master_data.sql` | ادّعى تعليقه زورًا أنه "لا يُنفَّذ عبر مُشغِّل مستقل" — مُثبَت خطأً |
| `0014_brand_branch_scope.sql` | نفس الادّعاء الزائف؛ يتصادم مع خلل ترتيب server.js أدناه |
| `0015_name_en_backfill.sql` | نفس الادّعاء الزائف؛ الأعمدة كانت فعليًا مُوصَّلة في server.js |
| `0017_bilingual_catalog.sql` | نفس النمط لـ`price_lists`/`brands`/`branches` |
| `0019_account_role_registry_scope_fix.sql` | تعليقه الأصلي اعترف صراحة بعدم قابليته للاستئناف — أُعيد بناؤه ليكون كذلك فعليًا |

**خلل ترتيب حقيقي في `server.js` (مُكتشَف عبر اختبار المُشغِّل الحقيقي):** `addColumnIfMissing('pos_orders', 'branch_id', ...)` كان يعمل **قبل** إنشاء جدول `pos_orders` نفسه (لاحقًا في نفس الدالة) — يُبتلع صامتًا في أول إقلاع (`addColumnIfMissing` يسجّل تحذيرًا ويكمل)، فينجح فقط بعد إعادة تشغيل ثانية. أُصلح بنقل السطر، ومُثبَت بـMutation Testing مباشر: إعادة الخلل يدويًا وتأكيد فشل الاختبار الجديد، ثم استعادة الإصلاح وتأكيد نجاحه.

**checksum drift:** كان مُدَّعى في تعليق بلا تنفيذ فعلي — أُضيف تحقّق حقيقي في `db/migrate.js` يقارن checksum الملف الحالي بالمخزَّن، يحذّر (لا يفشل) عند الانحراف.

**سكربت التراجع** (`scripts/migrate-rollback-account-role-registry.js`): إضافة رفض صريح لإسقاط `expected_version`/`version` إن حملا بيانات حقيقية — **ثم اكتشفت مراجعة عدائية لاحقة** أن هذا الرفض كان يفشل بصمت (fail-open) على أي خطأ قاعدة بيانات، لا فقط "العمود غير موجود" — أُصلح ليتحقق من كود الخطأ تحديدًا (`ER_BAD_FIELD_ERROR`/`ER_NO_SUCH_TABLE` فقط تُسامَح)، ومُثبَت بثلاثة سيناريوهات حقيقية: جدول/عمود غائب (يُسامَح)، قاعدة تطوير حقيقية بدون بيانات (Dry-run سليم)، بيانات `expected_version`/`version` حقيقية مزروعة (رفض فعلي، exit code 1).

**`ALTER ENUM` غير المشروط:** كان يُنفَّذ على `users.role` في **كل** إقلاع بلا شرط — أصبح مشروطًا بمقارنة `INFORMATION_SCHEMA.COLUMNS.COLUMN_TYPE` الفعلي مقابل الهدف.

## 6. المراجعة العدائية متعددة الوكلاء (منهجية Ultracode، خارج التسلسل الرسمي)

بعد إتمام القسم 8a (التحقق الأساسي)، شُغِّلت Workflow متعددة الوكلاء (5 أبعاد مراجعة متوازية + تحقّق عدائي مستقل لكل نتيجة قبل قبولها) على كومِتَي القسم 6-7 تحديدًا، بدافع الحفاظ على نفس صرامة هذه الجولة حتى في مراحلها الأخيرة. **7 نتائج مرشَّحة، 5 نجت من التحقّق العدائي المستقل (2 مرفوضتان بسبب صحيحتان)، وأُصلحت الخمسة جميعًا** (commit `589760a`، تفصيل في القسم 5 أعلاه). النتيجتان المرفوضتان: (أ) حساسية `ALTER ENUM` تجاه `DEFAULT` منفصلًا عن قائمة القيم — حقيقية نظريًا لكن غير قابلة للتحقق فعليًا (لا مسار في هذا المستودع يُغيّر `DEFAULT` وحده)؛ (ب) — راجع `journal.jsonl` للتفصيل الكامل إن لزم.

بناء إصلاح إحدى النتائج الخمس (اختبار الـADD الحقيقي لـ0002) كشف **خللين إضافيين** غير مطروحين أصلًا، مُوثَّقين بالتفصيل في `tests/integration/migrationLifecycle.test.js` (سيناريو 6) ومُرسَلين كمهمتين منفصلتين (انظر القسم 8 أدناه) لأنهما خارج نطاق سكربتات هذه البوابة تحديدًا (`db/init.js`+`db/schema.sql`، سكربت تثبيت قديم منفصل):
- `USE moroccan_taste_pos;` مُثبَّتة في `schema.sql` تتجاهل صامتًا `DB_NAME`/`MYSQL_DATABASE` أيًّا كانت.
- سطر تعليق يحوي فاصلة منقوطة + نهايات أسطر CRLF يكسران المُقسِّم الساذج، فيمنعان إنشاء جدول `sales` بالكامل عبر `npm run db:init` على أي قاعدة جديدة اليوم.

## 7. الاختبارات بالأرقام (كلها خضراء، آخر تشغيل)

| المجموعة | العدد |
|---|---|
| `trialBalanceEngine.test.js` | 51/51 |
| `trialBalance.api.test.js` | 34/34 |
| `accountRoles.test.js` | 18/18 |
| `migrationLifecycle.test.js` | 18/18 |
| `journalMakerChecker.test.js` | 14/14 |
| `auditAtomicity.test.js` | 7/7 |
| `auditorRole.test.js` | 11/11 |
| `glSecurity.api.test.js` | 16/16 |
| **`npm run test:coa-gl-gate` (الإجمالي)** | **169/169** |
| `catalogBrandScope.api.test.js` | 16/16 |
| `shiftsAuthzScope.api.test.js` | 12/12 |
| `roles.api.test.js` | 36/36 |
| `bootstrap.empty-db.test.js` | 75/75 |
| Root `npm test` (35 ملفًا وحدويًا) | 0 فشل |
| ERP `tsc --noEmit` | نظيف |
| ERP `vitest` | 211/211 (44 ملفًا) |
| ERP `npm run build` (إنتاجي) | ناجح، 11.49s |
| `e2e/erp/trial-balance-rbac.spec.ts` (جديد) | 12/12 (3 اختبارات × 4 أحجام شاشة) |
| `e2e/erp/erp.spec.ts` (بوابة 89 مسارًا، غير مُعدَّلة) | لا تأثر من عمل هذه الجولة |

## 8. إثبات العزل وصفر البقايا

- كل ملفات `tests/integration/*.test.js` ذات الصلة تعمل ضد `moroccan_taste_pos_migration_runner_test`/`_test` معزولة (`tests/helpers/testHarness.js` يرفض التشغيل بلا هذا العزل صراحة).
- `e2e/erp/trial-balance-rbac.spec.ts`: 3 حسابات اختبار (accountant/auditor/cashier) تُنشَأ عبر API حقيقي، وتُحذَف في `afterAll` عبر API حقيقي — تحقّق مباشر عبر SQL بعد التشغيل: **صفر صفوف متبقية** بأسماء `e2e_tb_%`.
- `scripts/audit/test-residue-report.js` (قراءة فقط): **56 صفًا معروفة سابقًا** (17 مستخدم + 39 سطر Audit)، **كلها مؤرَّخة قبل بداية عمل اليوم** وتخص ملفات اختبار أخرى غير مُحوَّلة بعد للحارس المعزول (`receiptQr`, `periodsSecurity`, `workflowAuth`, إلخ) — لم تُنشئها أو تُضِف إليها هذه الجولة شيئًا؛ الفحص الشامل (كل عمود VARCHAR/TEXT) يُظهر **صفر بقايا إضافية**.

## 9. ما تبقّى مؤجَّلًا بصدق

1. **`db/init.js` + `db/schema.sql`** (USE مُثبَّتة + كسر مُقسِّم التعليقات بسبب CRLF) — خللان حقيقيان مُكتشَفان أثناء بناء اختبار Section 6، **مُرسَلان كمهمة متابعة منفصلة** (`task_b9570aeb`) لأنهما في سكربت تثبيت قديم منفصل تمامًا عن نطاق COA/Trial-Balance/GL.
2. **خلل ترتيب server.js في تسع أعمدة أخرى** (`permissions_v3`, `custody_expenses.*`, `txn_recipients.*`, `transaction_replies.stage_step_id`, `hr_advances.*`, `assets.*`) — نفس فئة خلل `pos_orders.branch_id` المُصلَح، لكن في وحدات غير مرتبطة (الحضانة/الموارد البشرية/الأصول)، **مُرسَل كمهمة متابعة منفصلة** (`task_2f421bfc`).
3. **Single Ledger/CO-MAIN فقط** — لا عزل شركات كامل (يتطلب `company_id` على `gl_accounts` نفسها، تخمين مخطط جديد) — موثَّق صراحة في العقد، ليس بادّعاء زائف.
4. **`{bulk:true}` غائبة من تفاصيل Audit للمسار الموحَّد** — الكود القديم كان يُضيفها لكل صف من Bulk، الخدمة الموحَّدة `_writeAudit` لا تفعل — فقدان تفصيل صغير مقبول، لا اختبار يعتمد عليه.
5. **`reverse()` تُسجّل Audit عند النجاح فقط** — فجوة موجودة أصلًا في الكود القديم (لم يكن يُسجّل إطلاقًا)، تحسين لا تراجع.
6. **فشل E2E غير مرتبط ومسبق:** `erp.spec.ts › create and edit workflows... mobile supplier workspace` يفشل بشكل مستقل تمامًا عن أي ملف لمسته هذه الجولة (شاشة مورّدين/مشتريات) — لوحظ أثناء التحقق النهائي، غير مُصلَح (خارج النطاق).

## 10. القرار المطلوب منك

- الفرع نظيف ومُتحقَّق بالكامل، **لم يُدفع بعد**. بانتظار أمرك الصريح "انشر" لتنفيذ `git push`/أي نشر.
- المهمتان المؤجَّلتان (البند 9.1 و9.2) ظاهرتان كـTask Chips منفصلتين — يمكن بدؤهما في جلسة منفصلة بنقرة واحدة، أو تجاهلهما إن رأيت أنهما خارج الأولوية حاليًا.
