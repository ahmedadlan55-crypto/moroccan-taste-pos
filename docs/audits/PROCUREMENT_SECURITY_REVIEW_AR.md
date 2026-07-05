# مراجعة أمنية — منظومة المشتريات (Security Review)

## المصادقة والصلاحيات
- **JWT actor فقط**: بوابة `/api/` العامة في `server.js` تضع `req.user` من التوكن؛ الوحدة لا تقرأ اسم المستخدم من الجسم أبدًا (`H.actorOf(req)` من JWT).
- **RBAC دقيق**: `middleware/requireCapability(capId)` على كل mutation، يحسب الصلاحية الفعّالة من `permissions_v3 ∪ overrides:grant \ overrides:revoke` (نفس منطق routes/auth.js). admin/developer bypass. **Fail-closed** عند أي خطأ.
- **بذر الصلاحيات**: 27+ صلاحية `procurement.*` في `permissions_v3`؛ منح للأدوار admin/manager/purchasing/finance/inventory مع تمريرة top-up صريحة لـadmin.
- **Maker–Checker**: يُمنع المُنشئ من اعتماد أمر الشراء/الفاتورة الخاصة به (`PERMISSION_DENIED`) عند `PROCUREMENT_MAKER_CHECKER=1`.
- **نطاق المستودعات**: `middleware/warehouseScope` مُركّب على `/api/procurement`؛ `req.guardWh` على إنشاء الاستلام، و`whScopeClause` على قوائم PO/الاستلام. 403 عام لا يكشف وجود مستند خارج النطاق.

## الحقن والإدخال
- **SQL parameterized** حصريًا (لا سلاسل مبنية بقيم مستخدم). الفرز عبر **allowlist** (`parseListQuery` + `orderBy` من خرائط أعمدة ثابتة).
- **CSV**: تعقيم حقن الصيغ (تحييد `= + - @` في البداية) + BOM + سقف صفوف (`toCsv`).
- **Mass Assignment**: PATCH المورد يستخدم خريطة حقول صريحة؛ لا يسمح بتعديل `status`/`balance`/`version` مباشرة.
- **الإجماليات لا يُوثق بها من العميل** — تُحسب في الخادم (`calculations.computeLine/computeTotals`).

## التزامن والسلامة
- **قفل تفاؤلي** (`expectedVersion` + conditional UPDATE) → `VERSION_CONFLICT` (409).
- **Idempotency** عبر `Idempotency-Key` + `UNIQUE(document_type, idempotency_key)` في `procurement_events` (إعادة تشغيل آمنة).
- **over-receipt** يُعاد فحصه داخل Transaction بـ`FOR UPDATE` على سطر الأمر → استلامان متزامنان لا يتجاوزان.
- **حذف محظور** للمستندات المرحّلة (draft فقط قابل للحذف؛ العكس بمستند عكسي).
- **رفض العكس** إذا الاستلام مُفوتر (`DOCUMENT_HAS_HISTORY`)، والدفعة المخصّصة تمنع إشعار الدائن حتى عكس السداد.

## المحاسبة
- لا ترحيل إلى حساب مفقود/غير نشط/تجميعي (`PROC_GRNI_STRUCTURAL`) — لا fallback صامت.
- حارس الفترة يمنع `closed` **و`locked`**.
- `postJournal` داخل transaction المستند → ذرية الترقيم مع كتابة المخزون.

## الأسرار والتسجيل
- لا أسرار في الأجساد/السجلات؛ `procurement_events.payload` يحمل بيانات العملية لا أسرارًا.
- `x-request-id` على كل استجابة لتتبّع الأخطاء دون كشف داخلي.

## نقاط للمتابعة (خارج النطاق الحالي)
- rate-limiting مخصّص للـmutations على `/api/procurement` (حاليًا يرث بوابة المصادقة العامة؛ يُنصح بإضافة limiter مثل `/api/inventory/v2`).
- التحقق من صحة مرفقات الفاتورة (نوع/حجم) عند تفعيل الرفع.
