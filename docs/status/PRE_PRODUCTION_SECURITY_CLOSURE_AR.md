# بوابة Pre-Production Security Closure — التقرير النهائي

> التاريخ: 2026-07-04 · **لم يُدمج PR #5 ولم يُنشر Final RC.** التغيير الإنتاجي الوحيد = تدوير `JWT_SECRET` (إعادة تشغيل نفس كود main `dcc21653`).

## 1. تقرير مراقبة 24h — ✅ WAVE 1 STABLE

انظر `WAVE1_24H_MONITOR_REPORT_AR.md`. المراقب المستقل: 257 فحصًا (~21h متصلة، >24h تشغيل فعلي). **إشارات صحة الإنتاج الجوهرية مثالية عبر كل الفحوص**: `real_5xx`=0، `lot_invariant`=0، `gl_imbalance`=0، `/ready` 100%، `/` 100%، `login` 100%، 409=0. النافذة النظيفة (توكن صالح) 100% (41/41). الـ216 «إخفاقًا» + الحادثة الوحيدة كلها **عيب توكن مراقبة منتهٍ** (canary/metrics 401 بعد 2026-07-03T15:10) — صفر حادثة إنتاج حقيقية.

## 2. تقاعد المراقب وإلغاء توكناته — ✅ منفّذ

- `railway down -s prod-monitor -y` → الخدمة `○ Offline`.
- `railway variable delete CANARY_TOKEN|NONCANARY_TOKEN -s prod-monitor` → `present:false`. إلغاء ثلاثي (منتهيان أصلًا + الخدمة Offline + أبطلهما تدوير JWT).
- Staging (warehouse-staging + MySQL) يبقيان Online — **لم يُحذف Staging**.

## 3. تحقّق كلمة admin — ⚠️ **حرج: admin على الإنتاج يستخدم الافتراضي المكشوف `admin123`**

فحص **read-only** (قراءة hash وeمقارنته محليًا بـ bcrypt — بلا محاولة دخول، فلا زيادة `failed_attempts` ولا قفل):

```
admin: role=admin active=1 hashAlgo=$2a$ failed_attempts=0 locked_until=null
bcrypt.compare("admin123", hash) → TRUE   ← كلمة المرور الحالية هي الافتراضي المكشوف
باقي الافتراضيات (admin/password/123456/…) → false
```

- **النتيجة: كلمة admin الإنتاجية = `admin123` (تعرّض حي مؤكَّد).** ليست مجرد «تُعتبر مكشوفة» — هي فعليًا الافتراضي.
- التدوير الفعلي بيد المالك (الأداة تفاعلية تتطلب TTY + كلمة يدخلها المالك مخفيةً — لا أستطيع تنفيذه بالنيابة، ولا يجوز ضبط كلمة عشوائية لا يعرفها المالك).
- **إجراء مطلوب فورًا:** `node scripts/maintenance/rotate-admin-prod.cjs` (بعد `railway link` لمشروع الإنتاج). بعد تدويرك، يُعاد التحقق بـ `node scripts/maintenance/verify-admin-not-default.cjs` (يجب أن تُصبح كل الافتراضيات false) + `audit_log.password_rotated`.
- أداة التحقق: `scripts/maintenance/verify-admin-not-default.cjs` (لا تطبع الـ hash، لا تلمس الحساب).

## 4. تدوير JWT_SECRET على الإنتاج — ✅ منفّذ ومُختبَر

`scripts/maintenance/rotate-jwt-prod.cjs` (حارس `CONFIRM_ROTATE_JWT=EXECUTE`؛ السر لا يُطبع/يُحفظ؛ يُضبط عبر stdin لا argv؛ استرجاع تلقائي عند فشل الإشارات الجوهرية):

- **السر القديم كان 18 حرفًا فقط** (ضعيف — دون 32) → **الجديد 86 حرفًا** (`crypto.randomBytes(64).base64url`، ≥64).
- ضُبط على خدمة الإنتاج عبر stdin → إعادة تشغيل تلقائية (deploy جديد `77e28469` من نفس main `dcc21653` — **لا كود جديد**). `startedAt`: 2026-07-02T04:06 → 2026-07-04T09:30.
- **حزمة الاختبار بعد التدوير (كلها نجحت):**

| الاختبار | النتيجة | المتوقع |
|---|---|---|
| `/api/inventory/v2/ready` | 200 · tz=180 | 200/180 ✅ |
| `/` (الرئيسية القديمة) | 200 | 200 ✅ |
| `POST /api/auth/login` ببيانات خطأ | 200 · success=false | حي (ليس 5xx) ✅ |
| **توكن بالسر القديم → endpoint محمي** | **401** | 401 ✅ |
| **توكن بالسر الجديد (admin) → endpoint محمي** | **200** | 200 ✅ |
| Canary allow (admin جديد) → `/v2/lots` | 200 | 200 ✅ |
| Canary deny (غير-canary جديد) → `/v2/lots` | 403 · `V2_CANARY_DENIED` | 403 ✅ |

- **الأثر:** كل الجلسات والتوكنات القديمة أُبطلت فورًا (خروج قسري — إعادة تسجيل دخول عادية). توكن المراقبة المنتهي أُبطل عالميًا أيضًا. **كلمة admin لم تتغيّر بهذه الخطوة** (تبقى `admin123` حتى يدوّرها المالك — القسم 3).
- الإنتاج مستقر بعد التدوير: `/ready` 200/tz180 عبر عيّنات متتالية.
- **لم يُغيَّر أي Feature Flag** (POS_V2_ENABLED يبقى OFF، Canary=admin,5000، Scope كما هي).

## 5. حالة PR #5

`HEAD=0ebeff6` · Draft · `MERGEABLE` + `CLEAN` · base=main. main ثابت `dcc21653`. لم يُدمج ولم يُنشر.

## 6. القرار

# ⛔ NOT READY FOR FINAL PRODUCTION CUTOVER — عائق أمني واحد متبقٍّ

كل بنود الإغلاق الأمني اكتملت (WAVE 1 STABLE، تقاعد المراقب وإلغاء توكناته، تدوير JWT إلى سر قوي مع اجتياز كل الاختبارات، PR #5 نظيف) **عدا بندًا واحدًا حاسمًا بيد المالك**: كلمة مرور admin الإنتاجية لا تزال الافتراضي المكشوف `admin123`.

**يتحول القرار إلى READY فور تدوير المالك لكلمة admin** (خطوة واحدة: `scripts/maintenance/rotate-admin-prod.cjs`) وإعادة التحقق (`verify-admin-not-default.cjs` → كل الافتراضيات false). لا يوجد أي عائق تقني آخر؛ الدمج/النشر الفعلي يبقى قرار المالك الصريح.

## 7. تأكيد الالتزام

✅ لا دمج PR #5 · ✅ لا نشر Final RC (نفس كود `dcc21653` أُعيد تشغيله فقط) · ✅ لا `POS_V2_ENABLED=1` · ✅ لا توسيع Canary · ✅ لا تغيير Scope · ✅ لم يُحذف Staging · ✅ الأسرار لم تُطبع/تُحفظ في Git/Logs.
