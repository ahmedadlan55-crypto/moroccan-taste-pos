# جرد ابتلاع أخطاء قاعدة البيانات

> **الحالة:** HEAD `a60fe88` · فُحص حيًّا ضد MySQL الفعلي، لا استنتاجًا من الكود.

## الصنف (bug class)

نقطة نهاية تُشغّل استعلامًا يُسمّي عمودًا **غير موجود** في المخطط الحقيقي → يرمي
`ER_BAD_FIELD_ERROR` → يبتلعه `catch` عارٍ → تُعيد **نتيجة فارغة معقولة**
(`res.json([])` أو افتراضًا مُلفَّقًا). الشاشة تقول «لا توجد بيانات» إلى الأبد على
جدول ممتلئ، والعطل **غير مرئي**: لا خطأ، لا سجل، لا 500.

### لماذا هذا منهجي لا عارض

**1. `createTableIfMissing` لا يعمل على جدول موجود.** `server.js:940` يفحص
`SHOW TABLES LIKE ?` أولًا، و`db/init.js:10-17` يُشغّل `db/schema.sql` ويبتلع خطأ
«already exists». فأي جدول يُعرّفه `schema.sql` → كتلة `CREATE TABLE` المقابلة في
`server.js` **كود ميت ومُضلِّل**. المخطط الحقيقي = `schema.sql` + كل
`addColumnIfMissing` نجح.

`accounting_periods` معرَّف **أربع مرات بثلاثة أشكال**:

| الموضع | الشكل | الحالة |
|---|---|---|
| `db/schema.sql:232` | `period_label`, `closing_notes`, `brand_id`, `branch_id` | **هذا الفائز** |
| `db/schema.sql:482` | `name`, `status ENUM('open','closed')` | ميت («already exists») |
| `server.js:3707` | `company_id`, `period_name`, `notes` | ميت (no-op) — **الطُّعم** |
| `server.js:4237` | نسخة من schema.sql:232 | ميت (no-op) |

**مصدر الحقيقة الوحيد = `INFORMATION_SCHEMA` الحيّ.** لا تقرأ المخطط من `server.js`.

**2. `SELECT *` لا يمكن أن يرمي `ER_BAD_FIELD_ERROR`.** هذا هو المُرشِّح:
المجموعة المكسورة = **موضع ابتلاع ∩ ذكر عمود صريح** (في SELECT/WHERE/ORDER BY/JOIN).
موضع ابتلاع فوق `SELECT *` يتدهور إلى `undefined` لا إلى `[]` — وهو **صنف ثانٍ**:
**فقدان صامت للقيمة** (انظر `p.notes` و`hr_departments` أدناه).

**3. مُشغِّل ثالث:** `server.js:952-958` يوثّق أن JOIN بترميزات مختلطة يرمي
`Illegal mix of collations`، «which the list endpoints silently swallowed into an
empty array». فأي موضع ابتلاع فيه **JOIN** مكشوف حتى بأسماء أعمدة صحيحة.

## مُثبَت ومُصلَح

| الموضع | العطل | الأثر | الإصلاح |
|---|---|---|---|
| `routes/erp.js` `GET /periods` | يختار `company_id`,`notes` — غير موجودَين | «لا توجد فترات» على **12 صفًا حقيقيًا** | `739408b` |
| `routes/erp.js` `POST /periods` | يكتب نفس العمودين | **إنشاء فترة مستحيل** | `739408b` |
| `routes/pos-v2.js:346` | `` `key`/`value` `` بدل `setting_key`/`setting_value` | ضريبة React POS مثبّتة **15** | `f2e3c8f` |
| `routes/erp.js` حارس طريقة التقييم | `created_at` — الجدول يؤرّخ بـ`movement_date` | يفشل مُقفلًا للسبب الخطأ | `f4530d7` |
| `lib/glPosting.js:172` + `routes/erp-core.js:30` `isPeriodClosed` | `catch → return false` = «الفترة مفتوحة» + مقارنة بـ`'closed'` وحدها بينما enum فيه 5 قيم | **`locked`/`soft_close`/`soft_closed` تقبل الترحيل**؛ وأي خطأ DB يُعطّل الرقابة | `da47ca5` |
| `routes/erp-core.js` `GET /period-status` | `catch → {closed:false}` | يقول «مفتوحة» عند الفشل | `da47ca5` |
| `routes/erp-core.js:1332` `POST /royalty-runs/compute` | يختار `sales.total_amount`/`vat_amount` — غير موجودَين (الحقيقي `total_final`، ولا عمود VAT) | **لم ينجح قط** → `royalty_runs` فارغ لأنه **مكسور** لا لأنه غير مستخدم | ⏳ P1.3 |
| `routes/erp-core.js` `GET /accounting-periods` | `p.notes` وهمي (`SELECT *` → `undefined`) + `catch → []` | كل فترة تُعاد بلا ملاحظات | ✅ هذا الـcommit |
| `routes/sla.js:48` | `catch → []` بلا أي تسجيل | «لا تجاوزات SLA» عند العطل — أصحّ إجابة ممكنة | ✅ هذا الـcommit |

## مُثبَت ومفتوح (خارج نطاق React الحالي)

| الموضع | العطل | لماذا لم يُصلَح الآن |
|---|---|---|
| `routes/hr.js:333` `GET /departments` | `d.manager_id`,`d.parent_id`,`d.description` **وهمية** → `''` دائمًا؛ و`POST` (`hr.js:348`) يفكّكها ثم **يُسقطها صامتًا** ويرد `{success:true}` | **فقدان كتابة صامت**. شجرة الأقسام ميزة وهمية: تبدو قابلة للكتابة ولا تُحفظ. تحتاج ترحيلًا (P1.1) |
| `routes/cash.js:923` `GET /summary` | `catch(e){}` → أصفار مُلفَّقة | صفر مُلفَّق لا يُميَّز عن صفر حقيقي في بطاقات KPI. الأعمدة سليمة اليوم → كامن |
| `routes/erp-core.js:1722` `/waste-entries/:id/items` | `catch → []` | الأعمدة سليمة → كامن. يُصلَح مع P1.2 |
| `routes/erp-core.js:1316` `GET /royalty-runs` | `catch → []` | الأعمدة سليمة؛ الفراغ **حقيقي** لأن `compute` مكسور. يُصلَح مع P1.3 |

## الأرقام

- `res.json([])` عبر `routes/`: **116** موضعًا.
- مفحوصة بعمق (أعمدة مقابل `INFORMATION_SCHEMA` الحيّ): جداول `accounting_periods`,
  `waste_entries`, `royalty_runs`, `item_categories`, `inventory_movements`,
  `settings`, `sales`, `positions`, org-tree, `brands`, `branches`, `companies`.
- **`settings` نظيف تمامًا** من عيب `key`/`value` (35 قارئًا، كلهم صحيحون).
- `.catch(() => …)`: 19 موضعًا، كلها تنظيف على مسار الخطأ — **لا تبتلع نتائج استعلام**.
- `catch → res.json({})`: صفر.

## القاعدة

> **خطأ قاعدة بيانات ⇒ 500 + سجل. لا نتيجة فارغة معقولة، ولا افتراض مُلفَّق.**
> والرقابات (قفل الفترة، حراس الصلاحيات) **تفشل مُقفلة**: الرفض قابل للتعافي،
> والقبول الخاطئ لا.

## كيف تتحقق (لا تثق بالقراءة)

1. شغّل الاستعلام حرفيًا ضد MySQL الحقيقي.
2. قارن أعمدته بـ`INFORMATION_SCHEMA` — **لا** بـ`server.js`.
3. تحقّق من عدد الصفوف الفعلي (فارغ ≠ غير مستخدم).
4. نفّذ **القراءة والكتابة** — `/royalty-runs` يقرأ 200 ويكتب `ER_BAD_FIELD_ERROR`.
5. اختبر نجاحًا حقيقيًا **وفشلًا حقيقيًا**.
