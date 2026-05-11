# UI Unification Prompt — Moroccan Taste POS / ERP

> الـ prompt هذا جاهز للاستخدام في جلسة Claude Code جديدة. الصقه كرسالة واحدة، وكلاود سَيُنَفِّذ تَوحيد الهوية البصرية عبر كل المشروع.

---

## السياق

أنت مُهَنْدِس واجهة senior تَعمل على Moroccan Taste POS/ERP. المشروع له 4 modules منفصلة بـ CSS مُختَلطة:

| Module | المسار | CSS الرئيسي |
|---|---|---|
| Admin Dashboard | `/` (public/index.html) | `public/css/style.css` |
| Cashier POS | `/pos/` | `public/pos/style.css` |
| Employee Portal | `/employee/` | `public/employee/style.css` |
| Custody | `/custody/` | (مَختلف) |

POS الكاشير (v5.14.2) يَستخدم بالفعل CSS variables من tokens. الباقي عَشوائي (HEX مَكتوب يَدويًا).

## الهدف

1. كل ألوان/زوايا/ظلال/مسافات الواجهة مُتَوحِّدة عبر الـ 4 modules
2. تَغيير لون واحد في token يَنعكس على الكل
3. صفر تَكسير لأي وظيفة (JS، forms، modals، print templates، ZATCA receipts)

## الـ Design Tokens المُعتَمَدة

```css
:root {
  /* Brand */
  --mt-primary:     #1e293b;   /* slate 800 — main brand */
  --mt-primary-2:   #0f172a;   /* slate 900 — gradient end */
  --mt-accent:      #7c3aed;   /* purple 600 — interactive accent */
  --mt-accent-2:    #6d28d9;   /* purple 700 — hover */
  --mt-accent-soft: #faf5ff;   /* purple 50 — accent backgrounds */

  /* Semantic */
  --mt-success:     #16a34a;   /* green 600 — CTAs, paid */
  --mt-success-2:   #15803d;   /* green 700 — hover */
  --mt-danger:      #dc2626;   /* red 600 — destructive */
  --mt-warning:     #f59e0b;   /* amber 500 — warnings */
  --mt-info:        #0284c7;   /* sky 600 — info */

  /* Neutrals */
  --mt-bg:          #f1f5f9;   /* slate 100 — app background */
  --mt-surface:     #ffffff;
  --mt-surface-2:   #f8fafc;
  --mt-border:      #e2e8f0;   /* slate 200 */
  --mt-divider:     rgba(0,0,0,0.06);

  /* Text */
  --mt-text:        #0f172a;
  --mt-text-muted:  #64748b;
  --mt-text-light:  #94a3b8;

  /* Geometry */
  --mt-radius-sm:   10px;
  --mt-radius-md:   14px;
  --mt-radius-lg:   18px;
  --mt-radius-xl:   24px;

  /* Shadows */
  --mt-shadow-sm:   0 2px 8px rgba(15, 23, 42, 0.06);
  --mt-shadow-md:   0 8px 20px rgba(15, 23, 42, 0.10);
  --mt-shadow-lg:   0 16px 40px rgba(15, 23, 42, 0.20);

  /* Typography */
  --mt-font:        -apple-system, BlinkMacSystemFont, "SF Pro Display",
                    "Segoe UI", "Tahoma", "Cairo", Arial, sans-serif;
  --mt-font-mono:   ui-monospace, "SFMono-Regular", "Menlo", monospace;
}
```

## خطوات التَنفيذ

### 1. أنشئ ملف الـ tokens المُشترَك

أنشئ `public/shared/design-tokens.css` فيه الـ `:root` block أعلاه بالضبط.

### 2. اربطه في كل HTML entry

في كل من:
- `public/index.html`
- `public/pos/index.html`
- `public/employee/index.html`
- `public/custody/index.html` (إن وُجِد)

أَضِف قبل أول stylesheet آخر:
```html
<link rel="stylesheet" href="/shared/design-tokens.css?v=1">
```

### 3. استبدل القيم المَكتوبة بـ tokens

ابحث في كل ملفات CSS تحت `public/**/*.css` (ابدأ بـ `public/css/style.css`، `public/pos/style.css`، `public/employee/style.css`):

| ما تَجد | استبدل بـ |
|---|---|
| `#1e293b`, `#0f172a` (سَلَيت غامق) | `var(--mt-primary)` / `var(--mt-primary-2)` |
| `#7c3aed`, `#6d28d9` (بنفسجي) | `var(--mt-accent)` / `var(--mt-accent-2)` |
| `#3b82f6`, `#2563eb` (أزرق primary قديم) | `var(--mt-accent)` (وَحِّد على البنفسجي) |
| `#16a34a`, `#22c55e` (أخضر) | `var(--mt-success)` |
| `#dc2626`, `#ef4444`, `#b91c1c` (أحمر) | `var(--mt-danger)` |
| `#f59e0b`, `#fbbf24`, `#d97706` (أصفر) | `var(--mt-warning)` |
| `#ffffff`, `#fff` (أبيض cards) | `var(--mt-surface)` |
| `#f8fafc`, `#f1f5f9` (خلفية فاتحة) | `var(--mt-surface-2)` / `var(--mt-bg)` |
| `#e2e8f0`, `#cbd5e1` (حدود) | `var(--mt-border)` |
| `#64748b`, `#94a3b8` (نَص ثانوي) | `var(--mt-text-muted)` / `var(--mt-text-light)` |
| `border-radius: 8px` → `10px` | `var(--mt-radius-sm)` |
| `border-radius: 12px` → `14px` | `var(--mt-radius-md)` |
| `border-radius: 16px` → `18px` | `var(--mt-radius-lg)` |

### 4. وَحِّد قواعد الأزرار

أي زر "primary" → `background: linear-gradient(135deg, var(--mt-primary), var(--mt-primary-2)); color: #fff;`

أي زر "CTA / save / confirm" → `background: linear-gradient(135deg, var(--mt-success), var(--mt-success-2));`

أي زر "delete / destructive" → `background: var(--mt-danger);`

Focus ring مُوَحَّد:
```css
*:focus-visible { outline: 0; box-shadow: 0 0 0 3px rgba(124, 58, 237, 0.20); }
```

### 5. ما يَجب أن يَبقى كما هو (لا تُلامِسه!)

- ZATCA receipt templates في `public/pos/app.js` (`printReceiptWindow` و `_openShiftPrintWindow`) — تَستخدم Tahoma + bold للوضوح على الطباعة الحرارية، **لا تُحَوِّلها لـ tokens**
- منطق JS كله: `addToCart`, `doCheckout`, `_doSetChannel`, `posOpenPaymentModal`, etc.
- IDs والـ data attributes
- forms validation
- Permissions / auth flow
- DB schema و routes/

### 6. اختبار

بعد التَحديث:
- افتح `/` (admin), `/pos/`, `/employee/`, `/custody/`
- تَحقق أن جميع الأزرار primary بنفس اللون (سَلَيت)
- جميع CTAs أخضر مُوَحَّد
- destructive أحمر مُوَحَّد
- focus rings بنفس البنفسجي
- لا regression في وظيفة

### 7. Deploy

```bash
git add public/shared/design-tokens.css public/index.html public/pos/index.html \
        public/employee/index.html public/css/style.css public/pos/style.css \
        public/employee/style.css
git commit -m "feat(ui): unified design tokens across all modules"
git push origin main
```

---

## مَلاحظات

- **لا تُغَيِّر** أي logic في JS
- **لا تَحذف** الـ stylesheets الموجودة — فقط استبدل القيم بداخلها
- **اختبر** على mobile (touch) و desktop بعد كل module
- لو احتَجت لون لا يَوجد في tokens، أَضِفه إلى `:root` في `design-tokens.css` بدلاً من inlining

النَتيجة المُتَوَقَّعة: واجهة واحدة، 3 ألوان رئيسية، لمسة احترافية مَوحَّدة عبر كل النظام.
