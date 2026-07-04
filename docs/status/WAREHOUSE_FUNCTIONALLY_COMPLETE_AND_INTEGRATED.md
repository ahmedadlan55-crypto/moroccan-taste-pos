# WAREHOUSE FUNCTIONALLY COMPLETE AND INTEGRATED

> تقرير بوابة اكتمال المستودعات — فرع `codex/warehouse-final-completion`
> التاريخ: 2026-07-03 · **لم يُنشر أي شيء على Production** (البوابة تطويرية بالكامل)

---

## 1. الخلاصة التنفيذية

نظام المستودعات V2 **مكتمل وظيفيًا ومدمج داخل النظام الرئيسي**:

- **أوامر الإنتاج** بُنيت كاملة (Backend + React) فوق الجداول القديمة الموجودة بتعايش صفري التداخل مع المسار القديم.
- كل واجهات W2 (سياسة السالب) وW3 (استلام المشتريات الجزئي) وW4 (الباركود) وW6 (إدارة المستودعات CRUD) اكتملت.
- **كل صفحة في القائمة تعمل** — صفر Placeholder، صفر 404، صفر أخطاء console، مثبتة بـ E2E حي في متصفح حقيقي (123 فحصًا).
- **الأرقام إنجليزية 0-9** في كامل القسم (مركزيًا + حارس اختباري يمنع ٠-٩).
- القسم يعمل على **`/warehouse` داخل النظام الرئيسي**: نفس الجلسة والtoken (لا login ثانٍ)، رابط واحد في القائمة الرئيسية، `/warehouse-v2` تحويل 301 متوافق، والواجهة القديمة خلف Flag للـ rollback فقط.

## 2. المعمارية

- **Repository واحد، Express server واحد، قاعدة بيانات واحدة، Auth واحد** — الSPA يُبنى بـ Vite إلى `frontend/warehouse/dist` ويُخدم من نفس السيرفر على `/warehouse` (CSP صارمة بنطاق المسار، أصول immutable، index بلا كاش).
- Strangler حقيقي: مساران للكتابة لا يتقاطعان — legacy يكتب `planned/released` فقط في الإنتاج، وV2 يكتب `draft/approved/in_progress/completed/closed/reversed` + عمود `source` كحزام أمان في كل UPDATE شرطي.
- كل V2 API تحت `/api/inventory/v2/*` يرث: JWT auth → Warehouse Scope → metrics → rate-limit → canary — بلا استثناء للمسارات الجديدة (production-orders, warehouses).

## 3. State Machines

### أوامر الإنتاج V2 (الجديدة)
```
draft ── approve (Maker–Checker) ──▶ approved ── issue-materials ──▶ in_progress ⟲ (إصدار/إنتاج جزئي متكرر)
                                                                        │ record-output (جيد+هدر)
draft|approved ──▶ cancelled (قبل أي إصدار فقط)                          ▼
in_progress|completed|closed ──▶ reversed (عكس دقيق كامل)            completed ── close ──▶ closed
حذف: draft فقط · "منجز جزئيًا" حالة مشتقة (in_progress + qty_produced>0) لا قيمة ENUM
```
- **التكلفة**: إصدار بتكلفة WAC مجمدة لكل سطر (`production_issue_lines.unit_cost`)؛ حدث الإنتاج يسعّر بـ `u = wip_balance / remainingExpected` (متوسط جارٍ، لا إعادة تسعير رجعية)؛ الهدر يُصرف بالكامل على 5122؛ الإغلاق يدفع بقايا WIP إلى 5420.
- **GL لكل حدث**: إصدار: Dr WIP 1220 / Cr مخزون 1200-1210 (+Cr 5400 عمالة، 5410 غ.مباشرة) · إنتاج: Dr FG 1230 (+Dr 5122 هدر) / Cr WIP · إغلاق: Dr 5420 / Cr WIP · العكس: قيد عاكس لكل قيد أصلي من القيم المجمدة.
- **FEFO إلزامي** للمواد المتتبعة (تخصيص عبر `inventory_lot_movements` بمرجع الحدث) مع override يدوي مُتحقق؛ العكس يسترجع **الدفعات الأصلية بالضبط** (لا re-FEFO) ويُحظر إن استُهلك المنتج (INSUFFICIENT_STOCK).

### بقية دورات المستندات (كما كانت، مثبتة)
receipts/issues/adjustments: `draft→approved→posted→reversed (+cancelled)` · stocktakes: `draft→counting→submitted→approved→posted` · transfers: `draft→approved→issued→partially_received→received (+reversed)`.

## 4. Business Rules (أوامر الإنتاج — 25 قاعدة المطلوبة)

| # | القاعدة | التطبيق |
|---|---|---|
| 1 | الإنشاء والاعتماد لا يغيران المخزون | create/approve بلا أي حركة — مثبت اختباريًا |
| 2 | إصدار المواد يخصم من مستودع المواد | applyStockMovement(-qty) على source wh |
| 3 | FEFO إلزامي للمتتبع | allocateOutbound (الأقرب صلاحية أولًا) — مثبت |
| 4 | تخصيص الدفعات يُحفظ في الأمر | inventory_lot_movements (ref=event) + work_order_lot_consumption |
| 5 | إصدار جزئي | أحداث production_issue_events متعددة |
| 6 | إنتاج جزئي متعدد الدفعات | صفوف production_output متعددة بدفعة لكل حدث |
| 7 | المنتج المتتبع يتطلب lot/expiry | LOT_REQUIRED / VALIDATION_ERROR |
| 8 | planned/actualGood/waste/yield/variance | أعمدة الرأس + variance-report endpoint |
| 9 | التكلفة من الاستهلاك الفعلي (WAC/دفعات؛ overhead إن وُجد) | تكلفة مجمدة لكل سطر + labor/overhead اختياريان |
| 10 | تحديث WAC للمنتج النهائي | عبر inventoryTxEngine.newWAC — مثبت (2.28) |
| 11 | GL متوازن ومربوط | postJournal يرفض غير المتوازن؛ ref=eventId |
| 12 | Transaction ذرّية شاملة | db.withTransaction واحدة لكل عملية + rollback كامل |
| 13 | expectedVersion | UPDATE شرطي → VERSION_CONFLICT 409 |
| 14 | Idempotency-Key | idempotency_keys (replay مطابق مثبت) |
| 15 | actor من JWT فقط | `_actor(req)` — لا body actor |
| 16 | RBAC | BACKOFFICE/MGR لكل endpoint |
| 17 | Scope للمصدر والوجهة | guardWh على المستودعين + whScopeClause للقوائم |
| 18 | Maker–Checker | منشئ الأمر لا يعتمده (admin bypass) — مثبت |
| 19 | منع double issue/completion | قفل FOR UPDATE + version + حالة شرطية — تزامن مثبت (200/409) |
| 20 | منع الاستهلاك الزائد | over-issue tolerance (env 10%) + تجاوز مدير مسبب |
| 21 | منع كمية سالبة/صفر | VALIDATION_ERROR |
| 22 | العكس بالدفعات والتكلفة الأصلية | reverseAllocation + التكلفة المجمدة — baseline يعود بالضبط |
| 23 | Rollback كامل عند أي فشل | كل الكتابات في معاملة واحدة |
| 24 | تقارير planned vs actual | GET variance-report + تبويب الفروقات |
| 25 | تقارير yield/waste/cost variance | نفس التقرير + KPIs |

**سياسة السالب (W2):** block افتراضي، controlled لغير المتتبع فقط بشروط (سبب + حد + إقرار + تدقيق + عجز يُتابع حتى التسوية)، allow خلف بوابتي env + مطور، المتتبع block دائمًا، غير مفعّلة في Production.
**استلام المشتريات (W3):** جزئي ومتعدد لنفس الأمر، منع over-receipt، منع الازدواج بين المسارين (الاتجاهان)، المسار القديم يرفض المتتبع قبل أي كتابة برسالة عربية توجه لV2.
**الباركود (W4):** normalized فريد عالميًا، أساسي + ثانوية بمتغيرات حجم، تعارض 409 واضح، بلا تغيير SKU.
**المستودعات (W6):** لا حذف صلب مع رصيد/حركات، تعطيل ممنوع مع رصيد ≠ 0، Scope assignments بيد admin.

## 5. Database changes (idempotent — تُطبق تلقائيًا عند الإقلاع)

- `production_orders`: توسعة ENUM append-only (`draft/approved/reversed`) + أعمدة `source, version, approved_by/at, qty_waste, wip_balance, closed_*, close_variance, gl_close_id, cancelled_*, reversed_*, reverse_gl_ids(JSON)`.
- جديد: `production_issue_events` (حدث إصدار بتكاليفه وقيده) + `production_issue_lines` (تكلفة مجمدة لكل سطر).
- `production_output`: `qty_waste, waste_cost, gl_journal_id, created_by`.
- لا تغيير على أي جدول legacy بغير الإضافة؛ `production_counter` مشترك بين المسارين (لا تصادم أرقام).

## 6. APIs (الجديدة/المكملة في هذه البوابة)

**`/api/inventory/v2/production-orders`** (17 endpoint): GET / (list+KPIs) · GET /:id (أحداث+دفعات+قيود+timeline) · POST / · PATCH /:id · POST /:id/approve|issue-materials|record-output|complete|close|cancel|reverse · DELETE /:id · GET /:id/availability|cost-preview|variance-report|print · POST /preview-availability · GET /boms.
**`/api/inventory/v2/warehouses`** (9): list+stats · detail(+movements+assignments+audit) · options · POST · PATCH · activate/deactivate · DELETE (admin) · GET/PUT scope-assignments.
**W3b**: GET `/api/inventory/v2/purchases/open` + إثراء `receive-plan` بوضع التتبع.
**أكواد أخطاء جديدة**: OVER_ISSUE، OVER_PRODUCTION، NO_OUTPUT_RECORDED (422)، WASTE_ALLOWANCE_EXCEEDED (403) — ضمن عقد الأكواد الموحد (32 كودًا).

## 7. الصفحات والنماذج (كلها فعلية — صفر Placeholder)

| الصفحة | الحالة | الصفحة | الحالة |
|---|---|---|---|
| مركز المستودعات | ✅ | أذونات الصرف + Wizard | ✅ |
| المستودعات والهيكل (CRUD كامل) | ✅ جديد | التعديلات + Wizard | ✅ |
| المواد والأرصدة (Grid) | ✅ | التحويلات + Wizard + استلام | ✅ |
| كتالوج الأصناف + تبويب باركود | ✅ مكتمل | الجرد + مساحة العد | ✅ |
| خطة إعادة الطلب | ✅ | **أوامر الإنتاج (قائمة/معالج/تفاصيل 6 تبويبات)** | ✅ جديد |
| الدفعات + حجر/إفراج/استدعاء بحوار | ✅ محسّن | التحليلات (Recharts) | ✅ |
| تحذيرات الصلاحية | ✅ | مركز التقارير + التفاصيل | ✅ |
| الاستلامات + Wizard | ✅ | **تقرير العجز + CSV** | ✅ جديد |
| **استلام المشتريات (طابور + معالج)** | ✅ جديد | **سياسة المخزون السالب + فاحص** | ✅ جديد |
| خريطة النظام | 🗑 حُذفت (القرار المعتمد) | بحث باركود عالمي + ملصقات Code39 | ✅ جديد |

كل صفحة: Loading/Empty/Error/Permission/Conflict + Desktop/Mobile + طباعة RTL للمستندية — مثبتة بالتغطية الحية.

## 8. Tests بالأرقام

| الحزمة | النتيجة |
|---|---|
| Backend unit (`npm test` — 26 ملفًا شاملًا productionEngine 30) | ✅ 0 فشل |
| Production Orders integration (73 فحصًا: FEFO/GL/WAC/idempotency/تزامن/عكس/baseline) | ✅ 73/73 |
| Warehouses CRUD integration | ✅ 37/37 |
| بقية حزم الـ integration (27 حزمة — scope/transfers/stocktake/lots/GL-concurrency/bootstrap فارغة/security/canary/preflight/negative-stock/purchase-receipt/barcode…) | ✅ انظر ملحق أ |
| Frontend vitest (26 ملفًا) | ✅ 102/102 |
| TypeScript `tsc --noEmit` | ✅ 0 أخطاء |
| Vite build | ✅ |
| **Navigation Coverage E2E (متصفح حقيقي)** | ✅ **123/123** |
| لقطات شاشة | 37 لقطة في `artifacts/screenshots/nav/` (كل صفحة + مراحل الإنتاج + جوال) |

## 9. الأمن (المرحلة 0 — منفذة)

- `scripts/rotate-admin-password.js`: تدوير تفاعلي بإدخال مخفي، bcrypt(12) فقط، تحقق ذاتي (الجديدة تعمل/القديمة لا)، تدقيق بلا أسرار. **تشغيلها على Production بيد المالك** — التغيير الإنتاجي الوحيد المسموح.
- Production يرفض إنشاء admin بكلمة افتراضية على قاعدة فارغة (يتطلب `ADMIN_INITIAL_PASSWORD` ≥ 12 ولا يسجَّل).
- مسح كامل: لا Default Password في code/seeds/scripts/docs/tests (dev-only admin123 خلف NODE_ENV!==production حصريًا).
- Runbook تدوير JWT_SECRET جاهز (`docs/guides/jwt-rotation-runbook.md`) — **لا يُنفذ قبل نهاية المراقبة** (يُبطل الجلسات وتوكن المراقبة).

## 10. Git commits (هذه البوابة — مرفوعة إلى origin)

`be48161` security(phase-0) · `66098a7` P1 backend · `ae1a478` P1 React · `03ba22a` W3b+W1 · `736c329` W4 UI · `e8c1f2b` i18n digits · `daf15c1` W2 UI + W6 CRUD · `2f85e80` integration /warehouse · `584a8ac` nav-coverage E2E (+ هذا التقرير).

## 11. Staging validation والمخاطر المتبقية

- كل التحقق جرى محليًا على MariaDB 3307 بقاعدة مطابقة بنيويًا + bootstrap على قاعدة فارغة ضمن المصفوفة. Staging السحابي يبقى كما هو (لا تغيير على خدماته).
- **مخاطر متبقية**: (1) قاعدة البيانات المحلية fixture صغيرة — فحصا Σqty/قابلية العكس في مدقق الكتالوج يجب إعادتهما على بيانات Staging الحقيقية قبل الموجة الثانية (السكربت جاهز ويرفض غير المحلي إلا بـ --allow-remote). (2) شاشات legacy داخل وحدة ERP القديمة ما تزال تحوي روابط مخزون قديمة داخلية — القائمة الرئيسية نظيفة (رابط واحد)، وإخفاء بقايا ERP الداخلية مرهون بقرار إيقاف legacy بعد UAT. (3) توسيع Canary/تفعيل controlled يبقيان قرارَي مالك.
- **Rollback**: `WAREHOUSE_V2_ENABLED=0` يعيد رابط "المخزون" القديم فورًا ويغلق /warehouse بصفحة صيانة؛ schema الإضافات append-only لا تكسر legacy.

## 12. تأكيدات البوابة

- ✅ لا Placeholder ولا TODO ولا أزرار وهمية (فُحصت آليًا).
- ✅ نظام رئيسي واحد: repo/سيرفر/قاعدة/Auth واحد — لا خدمة ثانية ولا تكلفة استضافة إضافية.
- ✅ **لم يُنشر شيء على Production**، لم يتغير Canary/Scope/Flags، prod-monitor لم يُمس.
- ✅ الفرع مدفوع إلى `origin/codex/warehouse-final-completion` فقط (ليس main).

---
### ملحق أ — مصفوفة البوابة الكاملة (29 حزمة — كلها ✅)

`unit-suite (26 ملفًا)` · `scope-api` · `reports-api` · `transfers-api` · `gl-concurrency` · `bootstrap (قاعدة فارغة)` · `idempotency-retention` · `inv-tx-api` · **`production-api (73)`** · `inv-tx-reverse-api` · `stocktake-api` · `stocktake-concurrency` · `item-master-api` · `replenishment-api` · `lots-api` · `lot-concurrency` · `lot-writers` · `stocktake-lots` · `lot-integrity` · `lot-migration` · `security-api (10 — حُدّث لـ CSP على /warehouse + إثبات 301 للalias)` · `ops-api` · `db-timezone` · `flags-api` · `negative-stock` · `purchase-receipt` · `barcode` · `canary-api` · `preflight (8)`.

**ملاحظتا تشغيل** (شفافية كاملة):
1. `preflight` كشف في أول تشغيل 12 حركة دفعة يتيمة + 5 قيود بلا مستند في القاعدة المحلية — **بقايا اختبارات قديمة سابقة للجلسة** (طوابع زمنية أقدم، دفعاتها حذفتها عمليات تنظيف حزم أقدم). نُظفت البقايا اليتيمة محليًا وأعيد التشغيل → 8/8. هذا بالضبط دور preflight وسيُشغَّل على Staging قبل أي موجة.
2. `security-api` حُدّثت توقعاته بعد نقل الSPA إلى /warehouse (الـ CSP تُفحص على المسار الأساسي + إثبات جديد أن /warehouse-v2 يعيد 301 بحفظ المسار) → 10/10.
