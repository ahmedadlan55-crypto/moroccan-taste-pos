# SYSTEM V2 — تحديث Usability + Units-of-Measure — تقرير التسليم

- **الفرع:** `codex/system-v2-usability-uom` @ `80d38ee` (Base `0ebeff6`)
- **Final RC:** `codex/system-v2-final-rc` مُقدَّم بـ fast-forward إلى `80d38ee` → **PR #5** يحوي الآن Warehouse + Cashier + UoM. main ثابت `dcc21653`.
- **Staging:** https://warehouse-staging-production-aa06.up.railway.app — deploy `c00a62a7` (RC الكامل مع واجهة الكاشير UoM).
- **الحالة:** ✅ **SYSTEM V2 READY FOR PRODUCTION** (الكود والاختبارات مكتملة وخضراء بما فيها واجهة الكاشير؛ النشر الإنتاجي بيد المالك).
- **القيود المحترمة:** ❌ لا دمج إلى main · ❌ لا نشر Production (`kind-quietude`) · ❌ لا تغيير Canary/Scope · النظام القديم يعمل.

---

## 0) إكمال واجهة الكاشير UoM (frontend/pos) — الفجوة التي رُفض عليها القرار سابقًا

**Backend (surgical، بلا هجرة):** `GET /api/pos/v2/catalog` يعرض `units[]` لكل صنف (أساس+كبرى+عامل+باركود الوحدة) + باركود الأساس + `basePrice` + `warehouseQty`(أساس)؛ `_linesForMath` يمرّر لقطة الوحدة؛ `buildLegacySalePayload` يضيف `enteredUnitCode/enteredQty/baseQty` ⇒ `sales.items_json` ⇒ **المرتجع يعيد نفس الوحدة والكمية الأساسية**.

**Frontend/pos:** `CatalogItem.units` + `CartLine.{enteredUnit*,conversionFactorSnapshot,baseQty}`؛ `resolveScan` يربط باركود الوحدة الكبرى (مسح كرتون = **1 كرتون**، ليس 12 حبة بصريًا)؛ `store.addItem(item,unit)`+`setLineUnit` (baseQty=enteredQty×factor، **عامل مجمّد**)؛ `cartMath` يحسب على `baseQty` (السعر=factor×أساس، الأسطر القديمة دون تغيير)؛ **`UnitPicker`** قائمة وحدة قابلة للبحث لتغيير الوحدة من السلة؛ `offline.upsertPayloadFrom` يحمل `unitFactor/enteredUnitCode/baseQty` (لا ازدواج عند إعادة المزامنة)؛ الإيصال يعرض الوحدة المدخلة.

**الأدلة (كلها خضراء):**
- **pos vitest 44** (11 UoM: cartMath baseQty، resolveScan باركود→وحدة، upsert payload يحمل العامل).
- **posV2Uom.api 20/20**: catalog units، كرتون→أساس 12، سعر=factor×base، `items_json` يحمل الوحدة+الأساس، **GL متوازن**، **صنف tracked → FEFO من أقدم دفعة (12 أساس)**، **المرتجع يعيد الوحدة+القيمة الأساسية (60)**، `UNIT_CONVERSION_CONFLICT`، **replay بلا خصم مزدوج**.
- **E2E متصفح `scripts/e2e-pos-v2-uom.cjs` 18/18** (لقطات `artifacts/screenshots/pos-uom/`): باركود حبة→خصم 1 · باركود كرتون→«1 كرتون» + «=12 حبة» + خصم 12 أساس · كرتونان→24 · تغيير الوحدة من السلة · **offline بيع كرتون ثم reconnect → مزامنة مرة واحدة (خصم 12 مرة واحدة)** · السعر/الإجمالي 60=12×5 · صفر console errors.

---

## 1) مخطط قاعدة البيانات (Schema)

جدول جديد `item_units` (يعيد استخدام master `units`؛ أساسية واحدة لكل صنف):
`id, item_id, unit_id, unit_name, unit_code, is_base, conversion_to_base DECIMAL(18,6), quantity_precision, allow_purchase/receipt/issue/transfer/stocktake/production/sale, barcode_id, is_active, version, created/updated_at/by` + `UNIQUE(item_id, unit_code)`.

أعمدة اللقطة المجمّدة على كل أسطر المستندات (idempotent، NULL-safe):
`entered_qty, entered_unit_id, entered_unit_code, conversion_factor_snapshot, base_qty`
على: `inv_receipt_items, inv_issue_items, inv_adjustment_items, inv_stocktake_items, production_issue_lines, production_output, stock_issue_items, pos_order_lines`.

أعمدة الأمان: `users.token_version, must_change_password, password_changed_at`.

## 2) الهجرة (Migration)

`scripts/migrate-item-units.js` (idempotent، dry-run + `--apply`): يبذر وحدة أساسية من `inv_items.unit` (عامل 1) + وحدة كبرى من `big_unit/conv_rate` إن ضُبطت (>1). **لا يمس الكميات/الأرصدة الحالية.** كل الأعمدة تُضاف عبر `addColumnIfMissing` بعد إنشاء الجداول.

## 3) محرك التحويل

- `lib/unitConversion.js` (نقي): `toBase/fromBase/compositeToBase/splitBaseToMajorMinor/describeBase/validateItemUnitSet/isUnitAllowed` — DECIMAL، تقريب epsilon-safe ≤6 خانات. **27/27**.
- `lib/itemUnits.js` (جسر DB): `resolveLineBase` — enteredUnit→baseQty، مركّب كبرى+صغرى، إعادة حساب خادمية ومقارنة (`UNIT_CONVERSION_CONFLICT`)، `itemHasMovements` لقفل العامل.
- المخزون/الدفعات/WAC/GL/FEFO/السالب **دائمًا بالوحدة الأساسية**؛ العكس يستخدم العامل المجمّد.

## 4) نقاط البحث الخادمية

- `GET /api/inventory/v2/item-search` — name(ar/en)/sku/باركود/تصنيف، Scope، رصيد+تحذير المستودع، وحدة أساسية+كبرى، exactBarcodeId، warehouseCost. **14/14**.
- `GET /api/accounting/accounts/search` — ورقة قابلة للترحيل + allowlist بالسياق.
- `GET /api/erp/suppliers/search`, `/api/erp/customers/search`.

## 5) إدماج الوحدات في المستندات (Backend)

| المستند | المسار | الحالة |
|---|---|---|
| استلام / استلام مشتريات | inventory-transactions `_buildReceipt` | ✅ enteredUnit→base + لقطة |
| صرف / تالف | `_buildIssue` (context waste) | ✅ |
| تعديل / جرد سريع | `_buildAdjustment` | ✅ |
| جرد V2 | inventory-stocktakes `PUT /counts` | ✅ مركّب + دلالة NULL محفوظة |
| إنتاج (إصدار مواد) | inventory-production `issue-materials` | ✅ وحدة كبرى→base + لقطة |
| إنتاج (تسجيل إخراج) | `record-output` | ✅ إخراج بوحدة كبرى + لقطة |
| تحويل (React) | warehouse-ops `stock-issues` create/patch | ✅ توسيع للأساسي + لقطة |
| كاشير | pos-v2 `_normalizeLines` | ✅ توسيع للأساسي (unitFactor)، سعر=factor×أساسي |
| CRUD وحدات الصنف | inventory-items `GET/PUT /items/:id/units` | ✅ version+audit+قفل بعد الحركات |

عقد الأخطاء: `UNIT_REQUIRED·UNIT_NOT_ALLOWED·INVALID_CONVERSION_FACTOR·UNIT_CONVERSION_CONFLICT·UNIT_LOCKED_BY_HISTORY·DUPLICATE_BASE_UNIT·BARCODE_UNIT_CONFLICT` — عدّاد العقد الآن 39، اختبار العقد 21.

## 6) الواجهة (React — frontend/warehouse)

- **`SearchableEntityCombobox`** (مركزي): بحث خادمي + `useInfiniteQuery` + تمرير لانهائي + virtualization (نافذة مرئية) + keyboard (↑↓/Home/End/Enter/Esc) + ARIA combobox·listbox·option + loading/empty/error+retry + اختيار مباشر عند تطابق الباركود + RTL + أرقام إنجليزية.
- **`UnitQtyInput`**: نمط مفرد (وحدة+كمية) ومركّب (كبرى+صغرى) بعرض تحويل فوري للأساسي.
- **`useEntitySearch`**: fetchers لكل كيان (item/accounts/suppliers/customers/warehouses).
- **تبويب «الوحدات والتحويلات»** في تفاصيل الصنف: أساسية/كبرى/عامل/دقة/سماحيات السياق/تفعيل + قفل العامل بعد الحركات (تعطيل + تحذير). عرض الرصيد: `125 حبة = 10 كرتون + 5 حبة`.
- **التطبيق:** InvTxWizard (استلام/صرف/تعديل/تالف — أصناف+حساب+وحدة)، StocktakeWizard (أصناف)، TransferCreateWizard (أصناف+وحدة)، PurchaseReceiveWizard (حساب).

## 7) تقرير التغطية (Coverage)

`scripts/reporting/searchable-coverage.cjs` → **✅ صفر قوائم مواد/حسابات طويلة غير قابلة للبحث**؛ 5 استخدامات للمكوّن المركزي في 4 نوافذ، 4 fetchers أصناف خادمية، 3 UnitQtyInput، 52 قائمة قصيرة مسموحة (حالة/نوع/نطاق/مستودع). يفشل (exit 1) عند أي مخالفة.

## 8) الاختبارات (بالأرقام)

**Backend نقي:** unitConversion 27 · passwordPolicy 10 · inventoryTxContract 21 · productionEngine 30 · posOrderMachine 28.
**Backend integration:** uomBackend2 **28** (CRUD وحدات+قفل، إنتاج كبرى، جرد مركّب، كاشير توسيع، تحويل) · uomDocs **12** (10 كرتون=120، صرف كرتون=−12، جرد، تعارض، GL 600) · production.api 73 · stocktake.api 39 · posV2.api 41 · inventoryTx.api 46 · transfers.api 41 · purchaseReceipt.api 11 · barcode.api 10 · changePassword 14 · search.api 14.
**Frontend vitest:** **114/114** (28 ملفًا)، منها UnitQtyInput+SearchableEntityCombobox **12**.
**بناء:** `tsc` نظيف · `vite build` ناجح · `node --check` لكل ملفات backend المعدّلة.

## 9) سلسلة E2E (مُتحقَّقة على مستوى API/التكامل)

`tests/integration/uomBackend2.api.test.js` + `uomDocs.api.test.js` يغطيان السلسلة المطلوبة بالكامل ضد MariaDB:
استلام **10 كراتين = 120 أساسي** → صرف كرتون = **−12** → جرد مركّب **5 كرتون + 3 = 63** → إنتاج يستهلك RAW بالكرتون (24) ويُنتج بوحدة صندوق (×6) → كاشير يبيع بعامل 12 (24 أساسي، سعر=factor×أساسي) → تحويل بالكرتون → مع تحقق المخزون/الحركة/GL المتوازن/اللقطة بعد كل خطوة. تعارض baseQty → `UNIT_CONVERSION_CONFLICT`؛ وحدة غير مسموحة → `UNIT_NOT_ALLOWED`؛ تغيير العامل بعد حركة → `UNIT_LOCKED_BY_HISTORY`.

## 10) نشر Staging + التحقق

- `railway up` على خدمة **warehouse-staging** فقط (لم يُمس `kind-quietude` الإنتاجي). deploy `c00a62a7` أصبح Online خلال ~60 ث (يحمل واجهة الكاشير UoM — bundle pos جديد).
- **smoke UAT:** `/api/version` 200 · `/api/inventory/v2/ready` 200 · `GET /api/pos/v2/catalog` **401** (كود الكتالوج الجديد مركّب) · `/pos-v2/` 200 (SPA الكاشير الجديد) · `/warehouse/` 200 · كل نقاط UoM/البحث/كلمة المرور مركّبة (401 لا 404).
- preflight محلي: **BLOCKER=0**.

## 11) Commits (فرع التطوير فقط)

`d6e94f2` محرك الوحدات · `6b58f19` كلمة المرور · `8d9129d` بحث · `1f7efa7` عقد · `230ce15` UoM مستندات · `c3f2d80` إنتاج/جرد/تحويل/كاشير+CRUD · `1a5efb7` مكوّنات+تطبيق UI · `151f18b` تبويب الوحدات · `68d37c4` vitest · `c0ca307` تقرير · **`80d38ee` واجهة الكاشير UoM (frontend/pos) + posV2Uom + E2E**. Final RC = fast-forward `codex/system-v2-final-rc`→`80d38ee` (بلا force؛ 0ebeff6 سلف) → PR #5.

## 12) المخاطر المتبقية / بيد المالك (غير حاجبة للكود)

1. **النشر الإنتاجي**: يتطلب أمر المالك بالدمج/النشر + إتمام **تدوير كلمة admin** (أداة تفاعلية `scripts/rotate-admin-password.js` — عائق إنتاجي فقط، لا يوقف الاختبارات).
2. **قفل المخزون السالب في الكاشير**: مسار `/api/sales` القديم لا يمنع البيع بالسالب (سلوك قائم قبل التحديث)؛ الخصم والمحاسبة تتمّان **بالوحدة الأساسية** بشكل صحيح (مُثبت)، وحارس السالب الصلب يعيش في محرك الصرف V2. لا يخص UoM.
3. تحذيرات preflight الثلاثة = بيانات اختبار محلية (يتيم/بلا إسناد Scope) — لا علاقة لها بالإنتاج.

## القرار

**✅ SYSTEM V2 READY FOR PRODUCTION** — نظام الوحدات الحقيقي يعمل عبر كل المستندات مع لقطة عامل مجمّدة، المخزون/WAC/GL/الدفعات بالأساسي، تغيير كلمة المرور من داخل النظام، كل القوائم الطويلة للمواد/الحسابات قابلة للبحث (تغطية 0)، الأرقام الإنجليزية محفوظة، كل الاختبارات خضراء، ونُشر على Staging بنجاح. **تأكيد: لم يُدمج إلى main ولم يُنشر على Production؛ النشر الإنتاجي بيد المالك.**
