# تصميم سياسة المخزون السالب — Warehouse V2 (تصميم فقط، غير مُفعّل)

> **الحالة:** تصميم للاعتماد فقط. **لا تنفيذ ولا تفعيل قبل اعتماد المالك.** لا يغيّر أي كود إنتاجي.
> **الافتراضي المعتمَد في التصميم:** `block` عالميًا · استثناء `controlled` للأصناف غير المتتبَّعة فقط · `lot/expiry` = block دائمًا · `allow` موجود تقنيًا لكنه **مُعطَّل** ولا يُتاح لأصناف الدفعات/الصلاحية.

---

## 0) الملخص التنفيذي

اليوم لا يوجد حارس صريح للمخزون السالب في محرك v2 عند الصرف؛ خصم المخزون يحدث في نقطة واحدة
[`applyStockMovement`](../../lib/inventoryTxEngine.js) (السطر 195: `qty = qty + qtyDelta`) دون فحص كفاية.
الأرصدة السالبة التي رُصدت في الإنتاج (‎−1.00‎) جاءت من مسارات legacy لا من v2. يقترح هذا التصميم
**مُحلِّل سياسة (policy resolver) مرجعُه الـBackend حصرًا**، يُستدعى قبل أي خصم، ويحسم:
هل يُسمح بأن يهبط الرصيد تحت الصفر، وبأي ضوابط.

**ثلاث سياسات:**
| السياسة | الجوهر | من يملكها | الأصناف |
|---|---|---|---|
| **`block`** (افتراضي) | منع الصرف إذا لم تكفِ الكمية المتاحة | — (سلوك افتراضي) | الكل |
| **`controlled`** | سماح محكوم بالهبوط تحت الصفر ضمن حدّ، بسبب إلزامي وتدقيق وتنبيه وتقرير عجز | manager/admin | **غير المتتبَّعة فقط** (`tracking_mode='none'`) |
| **`allow`** | سماح مفتوح تحت الصفر (خطر عالٍ) | developer/admin | غير المتتبَّعة فقط · **مُعطَّل ولا افتراضي** |

**القاعدة الحاكمة الأولى:** أصناف `lot` و`expiry` → **block دائمًا وبلا استثناء** — لا دفعة وهمية ولا FEFO سالب. الثابت
`Σ(‏warehouse_lot_balances‏) = warehouse_stock.qty` لا يُكسر أبدًا (يُفرض بـ[`assertInvariant`](../../lib/lotLedger.js) السطر 230 بعد كل معاملة).

---

## 1) المبادئ الحاكمة (غير قابلة للتفاوض)

1. **الـBackend هو المرجع الوحيد للقرار.** العميل **لا يرسل** قرار السماح إطلاقًا؛ يرسل النية فقط (صرف بكمية)
   وربما `reason`/`acknowledgeNegative` كإقرار واجهة. المحرك يقرأ السياسة من قاعدة البيانات ويقرر. أي `allowNegative`
   قادم من العميل يُتجاهل.
2. **الأكثر تقييدًا يفوز افتراضيًا** عند تعارض المستويات (global → warehouse → item).
3. **الثوابت لا تُكسر:** ثابت الدفعات، وتوازن GL (مدين=دائن)، وعدم ازدواج الترحيل — تبقى صحيحة تحت كل السياسات.
4. **كل هبوط تحت الصفر حدثٌ محاسبي وتشغيلي موثّق:** Audit Event كامل + تنبيه فوري + سطر في «سجل العجز».
5. **قابلية الرجوع:** كل معاملة صرف داخل Transaction واحدة؛ فشل أي فحص/ثابت → ROLLBACK كامل.
6. **`lot/expiry` = block مطلق** بصرف النظر عن أي إعداد على أي مستوى.

---

## 2) السياسات الثلاث — التعريف الكامل

### 2.1 `block` (الافتراضي والأكثر أمانًا)
- عند الصرف: `available = warehouse_stock.qty` (وللأصناف المتتبَّعة: مجموع أرصدة الدفعات القابلة للصرف عبر FEFO).
- إذا `requested > available` → رفض **422 `INSUFFICIENT_STOCK`** (رسالة عربية: «الكمية المتاحة غير كافية») **قبل** أي كتابة.
- لا حركة، لا قيد، لا تغيير رصيد. هذا سلوك النظام الافتراضي على كل المستويات ولكل الأصناف.

### 2.2 `controlled` (سماح محكوم — غير المتتبَّعة فقط)
شروط **تراكمية إلزامية** (فشل أيٍّ منها → يسقط إلى `block`):
1. **الصنف غير متتبَّع** (`tracking_mode='none'`). أي صنف lot/expiry يتجاهل هذه السياسة ويُمنع.
2. **صلاحية:** المنفِّذ دوره `manager` أو `admin` (RBAC في الـBackend). الكاشير/الموظف → block.
3. **سبب إلزامي** (`reason` غير فارغ، طول ≥ N) يُخزَّن في الحركة وسجل العجز.
4. **حدّ سالب أقصى لكل (صنف، مستودع)** `max_negative_qty` (قيمة موجبة تمثل أقصى عجز مسموح). الصرف مسموح فقط إذا
   `newQty ≥ −max_negative_qty`. **تجاوز الحد ممنوع** حتى مع الصلاحية → 422 `NEGATIVE_LIMIT_EXCEEDED`.
5. **إقرار صريح** من العميل (`acknowledgeNegative=true`) — يُترجم لواجهة تأكيد واضحة؛ غيابه → 409 `NEGATIVE_CONFIRMATION_REQUIRED`
   (الـBackend يفرضه، ليس مجرد Dialog).
6. **Maker–Checker:** إن كانت مفعّلة على نوع المستند، **لا يجوز لنفس المستخدم** أن يعتمد صرفًا سالبًا أنشأه (فحص
   `created_by ≠ approved_by` مضاف لبوابة الاعتماد).
7. **مخرجات إلزامية عند التنفيذ:** Audit Event (`negative_issue`) + تنبيه فوري (`negative_stock_alert`) + سطر
   `stock_deficits` بحالة `open` («عجز مخزني يجب تسويته»).

### 2.3 `allow` (خطر عالٍ — مُعطَّل)
- سماح مفتوح بالهبوط تحت الصفر **بلا حدّ**.
- **`developer`/`admin` فقط**، مع **تحذير دائم** في الواجهة والـAudit («سياسة allow نشطة — مخاطر محاسبية»).
- **ليس افتراضيًا أبدًا**، **لا يُتاح لأصناف lot/expiry**، ويظل **مُعطَّلًا تقنيًا** (خلف علم `NEGATIVE_STOCK_ALLOW_ENABLED=0`
   على مستوى النظام؛ حتى لو ضبط أحدهم `policy='allow'` على صنف، يسقط إلى `controlled`/`block` ما لم يُرفع العلم عالميًا
   بيد developer). يُبقى في التصميم للطوارئ الموثقة فقط.

---

## 3) القواعد الإلزامية

- **BR-1 — lot/expiry:** block دائمًا. FEFO لا يخصّص أكثر من المتاح؛ لا تُنشأ «دفعة وهمية» ولا رصيد دفعة سالب.
- **BR-2 — الثوابت:** التحويلات والجرد والعكس لا تكسر ثابت الدفعات. التحويل السالب من المصدر ممنوع (block على طرف
   المصدر للأصناف المتتبَّعة؛ وللأصناف غير المتتبَّعة يخضع لنفس مُحلِّل السياسة على مستودع المصدر).
- **BR-3 — العكس المحاسبي الموثّق:** مسموح **حتى لو كان الصنف غير نشط** أو خرج عن السياسة — لأن العكس يعيد رصيدًا
   (إضافة) ويصحّح قيدًا؛ لا يُنشئ عجزًا. (الحارس الحالي `assertCanReverse` يبقى، ولا يُطبَّق فحص السالب على مسار الإضافة/العكس.)
- **BR-4 — مستويات السياسة الثلاثة:** `global` → `warehouse` → `item(+warehouse)`؛ الحسم **بالمستوى الأكثر تحديدًا المضبوط** (§4).
- **BR-5 — إعدادات محوكمة:** كل تغيير سياسة يتطلب RBAC + `expectedVersion` (تفاؤلي) + Audit — بنفس نمط
   [`warehouse_item_rules`](../../routes/inventory-items.js) (السطر 378-387، `version=version+1`، `_expectedVersion`).
- **BR-6 — backend-authoritative:** لا اعتماد على أي قيمة سماح من العميل.
- **BR-7 — idempotency:** الصرف السالب يخضع لنفس `Idempotency-Key`؛ إعادة الطلب لا تُنشئ عجزًا مضاعفًا ولا سطر
   `stock_deficits` مكرر.

---

## 4) حل تعارض المستويات (المستوى الأكثر تحديدًا يفوز + بوابات الأمان)

الدلالة المُنفَّذة والمُختبَرة: **المستوى الأكثر تحديدًا المضبوط يفوز** (`item` > `warehouse` > `global`)، ثم تُطبَّق
بوابتا أمان: `allow` تُخفَّض إلى `controlled` ما لم يُرفع العلم العالمي، والصنف المُتتبَّع = `block` دائمًا. هذا هو التفسير
الوحيد الذي يجعل **استثناء صنف/مستودع محدد بـ`controlled`** ممكنًا (متطلب §15) ويُرضي كل صفوف الجدول أدناه. الأمان
مضمون لأن ضبط `controlled` يتطلب admin و`allow` يتطلب developer (يُفرض في مسار الكتابة)، فأي تخفيف على مستوى أخص هو
فعل مُصرَّح متعمَّد. الافتراضي عند غياب أي سطر = `block`.

**خوارزمية الحسم** `resolvePolicy(item, global, warehouse, item@wh)`:
1. إذا `item.tracking_mode ≠ 'none'` → **`block`** (تجاوز كل شيء — BR-1).
2. اختر أول سطر مُفعَّل من الأكثر تحديدًا: `I=item@warehouse` → `W=warehouse` → `G=global`.
3. إن لم يوجد أي سطر → **`block`** (الافتراضي الآمن).
4. `max_negative_qty` الفعّال = حدّ **المستوى الفائز نفسه** (لا يوجد على المستوى الأخص = لا سماح فعلي).
5. `allow` → يسقط إلى `controlled` ما لم يكن `NEGATIVE_STOCK_ALLOW_ENABLED=1` (`allowGated`).

| global | warehouse | item | الفائز | الفعّالة (غير متتبَّع) | متتبَّع |
|---|---|---|---|---|---|
| block | — | — | global | block | block |
| controlled | — | — | global | controlled | block |
| **block** | — | **controlled** | item | **controlled** (استثناء صنف) | block |
| controlled | **block** | — | warehouse | **block** (تشديد مستودع) | block |
| controlled | controlled | **allow** | item | **controlled** (allow مُبوَّبة) | block |
| allow* | — | **block** | item | **block** (تشديد صنف) | block |
| allow* | allow* | allow* | item | allow (إن رُفع العلم) | block |

\* `allow` يتطلب العلم العالمي، وإلا = `controlled`. **مُثبَت في** `tests/integration/negativeStock.api.test.js` (22/22) و`tests/negativeStockPolicy.test.js` (19/19).

---

## 5) نقاط الإدماج في المحرك (أين يُفرض القرار)

| المسار | الملف/الدالة | الإدماج |
|---|---|---|
| صرف صنف **غير متتبَّع** | [`applyStockMovement`](../../lib/inventoryTxEngine.js) `:195` | قبل `INSERT … ON DUPLICATE KEY UPDATE`: احسب `newQty=oldQty+qtyDelta`؛ إن `qtyDelta<0` و`newQty<0` → استدعِ `resolvePolicy`؛ `block`→throw `INSUFFICIENT_STOCK`؛ `controlled`→تحقق الحد+الصلاحية+السبب+الإقرار ثم اسمح واكتب سطر عجز؛ الصف مقفول بـ`FOR UPDATE` (تزامن آمن). |
| صرف صنف **متتبَّع** | [`allocateOutbound`](../../lib/lotLedger.js) (FEFO) | لا تغيير سلوكي: FEFO لا يخصّص أكثر من أرصدة الدفعات؛ العجز مستحيل بنيويًا → block ضمني. يبقى `WRITER_NOT_LOT_AWARE` كما هو. |
| بعد كل معاملة متتبَّعة | [`assertInvariant`](../../lib/lotLedger.js) `:230` | يبقى؛ يضمن عدم كسر الثابت (يرفع `lot_invariant_violation_total` + fatal log عند أي خرق). |
| التحويلات | [`lib/warehouseTransfer.js`](../../lib/warehouseTransfer.js) | خصم المصدر يمر بنفس المُحلِّل على `sourceWarehouse`. |

**التزامن:** القرار يُتخذ **بعد** `SELECT … FOR UPDATE` على صف `warehouse_stock` (قفل صف موجود أصلًا في `applyStockMovement`)،
فلا سباق بين طلبين متزامنين على تجاوز الحد. سطر `stock_deficits` يُكتب داخل نفس Transaction.

---

## 6) الأثر المحاسبي: WAC · GL · التقييم · التقارير

- **WAC:** الصرف لا يغيّر `avg_cost` (WAC يُعاد حسابه عند **الإدخال** فقط عبر `newWAC`, `:200`). عند العجز يصبح
  `qty<0` بينما `avg_cost` يبقى آخر متوسط. **خطر:** `qty×avg_cost` يصبح **قيمة مخزون سالبة** — أي «مطلوب/التزام مخزوني».
- **GL:** الصرف السالب يُرحّل كالمعتاد عبر `glIssue` (مدين مصروف/تكلفة، دائن مخزون) بتكلفة `avg_cost` الحالية. توازن
  القيد يبقى (مدين=دائن). لكن حساب المخزون قد يصبح **دائنًا صافيًا** (رصيد سالب) → يجب أن تُظهره التقارير كـ«عجز مخزون
  يُسوّى» لا كأصل موجب.
- **التقييم/التقارير:** كل تقرير تقييم يجب أن:
  1. يعرض صفوف `qty<0` صراحةً كـ**عجز** (لون/شارة)، لا يخفيها ولا يصفّرها.
  2. يفصل «قيمة المخزون الموجب» عن «قيمة العجز» في الإجماليات.
  3. `stock_deficits` المفتوحة تظهر في تقرير مخصص «عجز مخزني يجب تسويته» (§10).
- **preflight:** فحص `negative_stock` يبقى **BLOCKER** بطبيعته؛ لكن مع سياسة `controlled` نضيف تمييزًا: عجز **مسجَّل**
  (له سطر `stock_deficits` مفتوح + سبب + معتمِد) = **WARNING محكوم**؛ عجز **غير مسجَّل** (سالب بلا سطر عجز) = **BLOCKER**
  حقيقي (تسرّب). هذا يفصل «السالب المقصود المحوكم» عن «السالب العرضي».

---

## 7) الاستلام اللاحق الذي يغطي العجز (Deficit Backfill)

عند وصول استلام/تعديل موجب لصنف عليه عجز مفتوح:
1. `applyStockMovement` بـ`qtyDelta>0` يرفع `qty` من السالب نحو الصفر/الموجب.
2. **تغطية WAC:** الجزء الذي يغطّي العجز (`min(inbound, |negative|)`) يُسوّى بتكلفة الاستلام، والجزء الفائض فوق الصفر
   يدخل في `newWAC` الطبيعي. (تفصيل: عند `oldQty<0`، صيغة WAC القياسية تُشوَّه؛ التصميم يفرض **معالجة خاصة**:
   عند تغطية عجز، تُسجَّل تسوية تكلفة العجز في GL — مدين مخزون/دائن حساب العجز — بتكلفة الاستلام، ثم يبدأ WAC نظيفًا
   من الرصيد الموجب المتبقّي.)
3. **إغلاق العجز:** يُحدَّث سطر `stock_deficits` إلى `covered` (كليًا) أو ينقص `remaining_qty` (جزئيًا) داخل نفس
   Transaction، مع Audit Event `deficit_covered`.
4. **متتبَّع؟** لا ينطبق — لا يوجد عجز على المتتبَّع أصلًا (block).

---

## 8) State Flow — دورة حياة العجز (`stock_deficits`)

```
        صرف controlled يتجاوز الصفر
                   │
                   ▼
              ┌─────────┐   استلام/تعديل موجب جزئي    ┌───────────┐
              │  open   │ ─────────────────────────▶ │  partial  │
              └────┬────┘                            └─────┬─────┘
                   │ تغطية كاملة                            │ تغطية كاملة
                   ▼                                        ▼
              ┌──────────┐        تسوية جرد/تعديل      ┌──────────┐
              │ covered  │◀──────────────────────────│ adjusted │
              └──────────┘                            └──────────┘
```
- `open → partial → covered` عبر الاستلام اللاحق.
- `open/partial → adjusted` عبر تسوية جرد/تعديل يدوي (manager) يصفّر العجز محاسبيًا (كتابة سبب + قيد).
- كل انتقال: Audit + تحديث `remaining_qty` + (عند الإغلاق) إزالة من تقرير «يجب تسويته».

---

## 9) Database Schema (جداول جديدة — إضافية، بلا مساس بالقائم)

```sql
-- (أ) سياسة على ثلاثة مستويات. صف واحد per (scope, warehouse_id?, item_id?).
CREATE TABLE negative_stock_policy (
  id             VARCHAR(40) PRIMARY KEY,
  scope          ENUM('global','warehouse','item') NOT NULL,
  warehouse_id   VARCHAR(40) NULL,          -- NULL للـglobal
  item_id        VARCHAR(40) NULL,          -- NULL للـglobal/warehouse
  policy         ENUM('block','controlled','allow') NOT NULL DEFAULT 'block',
  max_negative_qty DECIMAL(18,3) NOT NULL DEFAULT 0,   -- أقصى عجز (قيمة موجبة)
  require_reason   TINYINT(1) NOT NULL DEFAULT 1,
  is_enabled       TINYINT(1) NOT NULL DEFAULT 1,
  version          INT NOT NULL DEFAULT 1,
  created_by VARCHAR(64), updated_by VARCHAR(64),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_scope (scope, warehouse_id, item_id)
);
-- سطر global افتراضي واحد policy='block' يُبذر عند الإقلاع (مثل ensureCoreAccounts).

-- (ب) سجل العجز — «عجز مخزني يجب تسويته».
CREATE TABLE stock_deficits (
  id            VARCHAR(40) PRIMARY KEY,
  warehouse_id  VARCHAR(40) NOT NULL,
  item_id       VARCHAR(40) NOT NULL,
  origin_doc_type VARCHAR(24) NOT NULL,     -- inv_issue / transfer / ...
  origin_doc_id   VARCHAR(40) NOT NULL,
  deficit_qty   DECIMAL(18,3) NOT NULL,     -- حجم العجز الأصلي (موجب)
  remaining_qty DECIMAL(18,3) NOT NULL,     -- المتبقّي غير المُغطّى
  unit_cost_at_issue DECIMAL(18,4) NOT NULL,
  reason        VARCHAR(400) NOT NULL,
  status        ENUM('open','partial','covered','adjusted') NOT NULL DEFAULT 'open',
  created_by VARCHAR(64), approved_by VARCHAR(64) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, closed_at TIMESTAMP NULL,
  version INT NOT NULL DEFAULT 1,
  KEY idx_open (status, warehouse_id, item_id)
);

-- (ج) التدقيق يعيد استخدام inv_tx_events القائم بأنواع أحداث جديدة:
--     negative_issue · deficit_covered · deficit_adjusted · policy_changed
```
- **لا FK صارمة** (اتساقًا مع نمط جداول الدفعات؛ preflight يكشف اليتامى).
- **لا تعديل** على `warehouse_stock`/`inventory_lots`/GL — الجداول إضافية فقط.

---

## 10) API Contracts

### إعدادات السياسة (محوكمة: RBAC + expectedVersion + Audit)
```
GET    /api/inventory/v2/negative-policy?scope=&warehouseId=&itemId=
         → { data:[{scope,warehouseId,itemId,policy,maxNegativeQty,version,...}], effective:{...} }
PUT    /api/inventory/v2/negative-policy         (admin؛ allow→developer فقط)
         body: { scope, warehouseId?, itemId?, policy, maxNegativeQty, requireReason, expectedVersion }
         → 200 {version:+1} | 409 STALE_VERSION | 403 forbidden_role | 422 VALIDATION_ERROR
                | 422 POLICY_NOT_ALLOWED_FOR_TRACKED (لو item متتبَّع) | 403 ALLOW_REQUIRES_DEVELOPER
GET    /api/inventory/v2/negative-policy/effective?warehouseId=&itemId=   → القرار المحسوب (الأكثر تقييدًا)
```
### الصرف (سلوك المحرك)
```
POST /api/inventory/v2/issues            body: { warehouseId, items:[{itemId,qty}], reason?, acknowledgeNegative? }
  block:      newQty<0 → 422 INSUFFICIENT_STOCK
  controlled: يحتاج role∈{manager,admin} + reason + acknowledgeNegative + newQty≥−maxNeg
              وإلا: 409 NEGATIVE_CONFIRMATION_REQUIRED | 422 NEGATIVE_LIMIT_EXCEEDED | 403 forbidden_role | 422 REASON_REQUIRED
              نجاح → يُنشئ stock_deficits(open) + Audit negative_issue + alert
  allow:      كـcontrolled بلا حدّ، فقط إذا العلم العالمي مرفوع؛ وإلا يسقط لـcontrolled
```
### تقرير العجز والتنبيهات
```
GET /api/inventory/v2/reports/stock-deficits?status=open   → «عجز مخزني يجب تسويته» (+CSV محمي من حقن الصيغ)
GET /api/metrics                                           → negative_issues_total · open_deficits_total (عدّادات جديدة)
```

---

## 11) RBAC Matrix

| الإجراء | cashier | employee | manager | admin | developer |
|---|:-:|:-:|:-:|:-:|:-:|
| صرف `block` عادي | ✔ | ✔ | ✔ | ✔ | ✔ |
| صرف `controlled` سالب | ✗ (block) | ✗ (block) | ✔ | ✔ | ✔ |
| ضبط policy=block/controlled | ✗ | ✗ | ✗ | ✔ | ✔ |
| ضبط policy=allow | ✗ | ✗ | ✗ | ✗ | ✔ |
| تسوية/إغلاق عجز | ✗ | ✗ | ✔ | ✔ | ✔ |
| اعتماد صرف سالب (Maker≠Checker) | ✗ | ✗ | ✔* | ✔* | ✔ |

\* لا يعتمد المنشئ صرفه إن كانت Maker–Checker مفعّلة.

---

## 12) واجهات المستخدم

- **شاشة إعدادات السياسة** (admin): ثلاثة تبويبات global/warehouse/item؛ اختيار `policy` + `maxNegativeQty` + `requireReason`؛
  عرض «القرار الفعّال المحسوب» لكل (صنف، مستودع) مع شرح أي مستوى فاز ولماذا؛ حفظ بـ`expectedVersion` (رسالة تعارض واضحة)؛
  تحذير أحمر دائم عند اختيار `allow`؛ إخفاء `allow` عن غير developer.
- **معالج الصرف:** إن كان الناتج سالبًا تحت `controlled` → خطوة تأكيد صريحة (سبب إلزامي + عرض الحد والعجز المتوقع + مربع
  إقرار). لا «إخفاء رابط» — الرفض/السماح من الـBackend.
- **تقرير «عجز مخزني يجب تسويته»:** جدول العجوزات المفتوحة (صنف/مستودع/الكمية/التكلفة/السبب/المنشئ/العمر) + تصدير CSV +
  إجراء «تغطية/تسوية».
- **تنبيهات:** شارة/إشعار فوري عند كل `negative_issue`، وعدّاد `open_deficits_total` في لوحة العمليات.

---

## 13) خطة الاختبارات

- **التزامن:** طلبان متزامنان يصرفان من رصيد يكفي واحدًا فقط تحت `controlled` بحدّ ضيّق → واحد ينجح والآخر
  `NEGATIVE_LIMIT_EXCEEDED` (بفضل `FOR UPDATE`)؛ لا تجاوز للحد ولا سطرَي عجز.
- **Rollback:** فشل `assertInvariant`/فشل كتابة `stock_deficits` → ROLLBACK كامل: لا حركة، لا قيد، لا رصيد، لا سطر عجز.
- **Idempotency:** إعادة طلب صرف سالب بنفس المفتاح → لا عجز مضاعف، لا قيد مضاعف، `remaining_qty` صحيح.
- **GL:** صرف سالب → قيد متوازن (مدين=دائن)؛ تغطية لاحقة → قيد تسوية عجز متوازن؛ `gl_imbalance_total=0`.
- **WAC:** تسلسل صرف-سالب ثم استلام يغطّي → `avg_cost` النهائي = تكلفة الاستلام على الرصيد الموجب المتبقّي (لا تلوّث من الرصيد السالب).
- **الثابت:** أي محاولة سالب على `lot/expiry` → block؛ الثابت يبقى 0 خرقًا في كل السيناريوهات.
- **preflight:** عجز مسجَّل → WARNING؛ عجز غير مسجَّل (محقون يدويًا) → BLOCKER.
- **RBAC/expectedVersion:** تغيير سياسة بدور غير كافٍ → 403؛ بنسخة قديمة → 409؛ `allow` بغير developer → 403.

---

## 14) المخاطر لكل خيار

| السياسة | مخاطر محاسبية | مخاطر تشغيلية |
|---|---|---|
| **block** | لا شيء (الأأمن) — قيمة المخزون دائمًا ≥ 0 | قد يوقف صرفًا مشروعًا عند تأخر إدخال استلام → إحباط تشغيلي |
| **controlled** | قيمة مخزون سالبة مؤقتة (التزام)؛ تشوّه WAC إن لم تُعالَج التغطية؛ حساب مخزون دائن صافٍ | يتطلب انضباط تسوية العجز؛ إساءة استخدام الحدّ؛ تراكم عجوزات غير مُسوّاة |
| **allow** | خطر عالٍ: قيم سالبة غير محدودة، تشوّه تقييم وتقارير، تكلفة مباع مضللة | فقدان ضبط المخزون الفعلي؛ يخفي أخطاء إدخال؛ صعب التدقيق — لذا **مُعطَّل** |

---

## 15) حالة التفعيل المعتمدة في التصميم

1. **الافتراضي `block`** على المستوى العالمي (سطر global مبذور).
2. **`controlled` استثناءً** يُفعَّل يدويًا (admin) لأصناف/مستودعات غير متتبَّعة محددة عند الحاجة، بحدّ واضح.
3. **`lot/expiry` = block دائمًا** (غير قابل للتجاوز).
4. **`allow` موجود تقنيًا لكنه مُعطَّل** خلف علم على مستوى النظام بيد developer، وغير متاح للأصناف المتتبَّعة — للطوارئ الموثقة فقط.

> لا يُنفَّذ أيٌّ مما سبق قبل اعتمادك. عند الاعتماد يُقترح تسليمه على دفعات: (0) الجداول + المُحلِّل + وحدات اختبار →
> (1) إدماج `applyStockMovement` + `controlled` + سجل العجز → (2) التقارير/التنبيهات/الواجهة → خلف علم `NEGATIVE_STOCK_POLICY_ENABLED`
> يبدأ صفرًا (سلوك block الحالي مطابق) ويُرفع تدريجيًا كنمط الموجات.
