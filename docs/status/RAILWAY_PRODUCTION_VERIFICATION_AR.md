# تحقق الإنتاج على Railway — أدلة مباشرة من الـCLI

> جُمعت عبر `railway` CLI 5.26.0، مسجّل الدخول كـ`ahmedadlan55@gmail.com`.
> **قراءة فقط** — لم يُنفَّذ أي نشر أو تعديل إعدادات.

## 1. هوية الخدمة

| | |
|---|---|
| Workspace | `ahmedadlan55-crypto's Projects` |
| Project | `kind-quietude` — `2c2de1a8-7b9e-4be0-8c7c-940f0ab21a4d` |
| Environment | `production` — `dda68184-b677-4863-81ac-a7d2164ee569` |
| Service | `moroccan-taste-pos` — `309ffaf4-bf08-47f7-bd5d-e62e23887399` |
| Repo | `ahmedadlan55-crypto/moroccan-taste-pos` |
| URL | https://moroccan-taste-pos-production.up.railway.app |
| Region | US East |
| الحالة | ● Online |

## 2. النشر الحيّ حاليًا

| | |
|---|---|
| Deployment ID | `c55e8dea-823b-48bc-8511-6ae9dfc65b3c` |
| الحالة | SUCCESS |
| التاريخ | 2026-07-21T10:45:40Z |
| الـcommit | `feat(pos): add a plain logout button…` = **`e1dc4f9` = `origin/main`** |

**استنتاج مهم:** الإنتاج يعمل الآن على `origin/main` بالضبط — أي أنه **لم يستلم أيًّا** من عمل
Sprint 3 أو Tier A.3 أو الـRelease Candidate أو الإغلاق. النشر القادم هو أول مرة تصل فيها
هذه التغييرات كلها إلى الإنتاج، ومنها أول تشغيل لأي migration مرقّمة هناك.

## 3. أمر التشغيل الفعلي — دليل من سجلات النشر الحيّ

أول أسطر سجل الحاوية الحيّة:

```
Starting Container
[pos] React cashier SPA mounted at /pos
[erp] unified Back-Office SPA mounted at /app
...
Database connection OK — tables already exist.
```

* **لا يوجد أي أثر لخطوات سلسلة الإصدار** (`[release] 1/3 …`) — متوقَّع تمامًا، لأن الإنتاج
  على `e1dc4f9` وهو سابق لتغيير `Dockerfile` في RC-2. الحاوية تبدأ وتُشغّل `node server.js`
  مباشرة، وهو سلوك `CMD ["node","server.js"]` القديم.
* **لا توجد خطوة Pre-Deploy** ظاهرة في السجل.
* **معيار التحقق بعد النشر القادم:** يجب أن تظهر في السجل أسطر
  `[release] 1/3 legacy schema provisioning` ثم `[release] 2/3 numbered migrations`
  ثم `[release] 3/3 starting server`. غيابها يعني أن Custom Start Command على مستوى
  الخدمة يتجاوز الـDockerfile — وهو الاحتمال الوحيد الذي **لا يمكن** إثباته من داخل
  المستودع، ويُحسم بهذا السجل تحديدًا.

## 4. متغيرات البيئة (44 متغيرًا — الأسماء فقط، القيم محجوبة)

الأعلام ذات الصلة بسلسلة الإصدار:

| المتغير | القيمة |
|---|---|
| `NODE_ENV` | `production` |
| `ORDER_TO_CASH_ENABLE` | `1` |
| `PROCUREMENT_P2P_ENABLE` | `1` |
| `POS_V2_ENABLED` | `1` |
| `WAREHOUSE_V2_ENABLED` | `1` |
| `WAREHOUSE_SCOPE_ENFORCE` | **`1`** (محليًا `0` — فارق مقصود) |
| `RUN_DB_INIT` | **غير مضبوط** ✅ |
| `ERP_UNIFIED_ENABLED` | **غير مضبوط** |

**نقطتان تحتاجان انتباهًا:**

1. **`RUN_DB_INIT` غير مضبوط — وهذا صحيح.** سلسلة الإصدار الجديدة تتخطّى `db/init.js`
   افتراضيًا، فلا خطر تكرار طرق الدفع في الإنتاج.
2. **`ERP_UNIFIED_ENABLED` غير مضبوط، ومع ذلك السجل يقول
   `[erp] unified Back-Office SPA mounted at /app`** — أي أن العلم **مفعَّل افتراضيًا في
   الكود** (دلالات kill-switch) ولا يحتاج ضبطًا. أُثبت بالسجل لا بالافتراض.
3. قاعدة الإنتاج تُحدَّد عبر `MYSQL_DATABASE`/`MYSQLDATABASE` — وهو ما يقرأه
   `db/connection.js` **قبل** `DB_NAME`. مهم عند أخذ النسخة الاحتياطية قبل النشر.

## 5. ما لم يُتحقق منه بعد

* **Custom Start Command** على مستوى الخدمة: `railway config pull` يتطلب
  Railway TypeScript SDK غير المثبَّت، فتعذّر قراءته إعلاميًا. الدليل البديل المقبول هو
  سجل النشر التالي (القسم 3). ليس حاجبًا خارجيًا — مجرد قناة تحقق مؤجَّلة.
* **مهلة الـhealthcheck** مقابل الزمن الجديد للإقلاع (سلسلة الإصدار تُضيف تجهيزًا مقاسًا
  ~120 ثانية باردًا قبل ربط المنفذ) — يجب مراجعتها قبل النشر.
