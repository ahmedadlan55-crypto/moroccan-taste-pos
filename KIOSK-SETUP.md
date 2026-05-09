# إعداد جهاز الكاشير (Kiosk PC)

دليل تَشغيل شاشة الكاشير `/pos/` على كمبيوتر Touch بطابعة حرارية وبدون لوحة مفاتيح، مع طباعة صامتة على Chrome أو Edge.

---

## 1. تَعيين الطابعة الحرارية كافتراضية

```
Windows Settings → Bluetooth & devices → Printers & scanners
```

اختر طابعتك الحرارية (مثلاً Epson TM-T20III أو XPrinter XP-80) → اضغط **"Set as default"**.

تَأكَّد:
- الورق 80mm
- درايفر مُحَدَّث
- اطبع صفحة اختبار من Windows (Right-click → Properties → Print Test Page)

---

## 2. تَشغيل المتصفح بـ `--kiosk-printing`

هذا العَلم (flag) يَجعل `window.print()` يُرسل مباشرة إلى الطابعة الافتراضية **بدون dialog**.

### Chrome
أنشئ اختصارًا على سطح المكتب باسم "MT POS"، يَمين-كليك → **Properties** → في حقل **Target** اكتب:

```
"C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk --kiosk-printing --no-first-run --disable-pinch --overscroll-history-navigation=0 https://your-server.up.railway.app/pos/
```

استبدل `your-server.up.railway.app` بعنوان النَشر الفعلي.

### Edge
نفس الفكرة:

```
"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --kiosk --kiosk-printing --no-first-run --edge-kiosk-type=fullscreen https://your-server.up.railway.app/pos/
```

### تَشغيل تلقائي عند بدء Windows
انسخ الاختصار إلى:
```
shell:startup
```
(اضغط Win+R، الصق `shell:startup`، Enter — مُجَلَّد بدء التَشغيل سيَفتح. الصق الاختصار هناك.)

---

## 3. التَحَقُّق من الطباعة الصامتة

1. افتح المتصفح بالاختصار
2. سَجِّل دخول كاشير
3. أَضِف منتج للسلة → اضغط الدفع
4. **يَجب أن تَطبع الفاتورة فورًا** بدون أي dialog

إذا ظَهَر dialog:
- ✗ الـ flag `--kiosk-printing` لم يُطَبَّق → افحص الاختصار
- ✗ Edge قد يَتطلَّب أيضًا `--edge-kiosk-type=fullscreen-public-browsing-no-print-preview`

---

## 4. لوحة المفاتيح الافتراضية

- تَظهر تلقائيًا عند الضغط على صندوق البحث
- زر 🌐 يُبَدِّل بين العربي والإنجليزي
- ✕ يُخفيها

تَكتشف الـ kiosk تلقائيًا (touch + لا keyboard فيزيائية) وتَعرض اللوحة فقط هناك. على الـ desktop العادي بـ mouse + keyboard، اللوحة لا تَظهر.

لإجبار ظهورها على أي جهاز (للاختبار):
```js
// في console
document.body.classList.add('vk-force');
```

---

## 5. استكشاف الأخطاء

### الفاتورة لا تُطبع بعد الدفع
1. افتح Developer Tools (F12) → Console
2. ابحث عن "auto-print failed"
3. تَأكَّد أن الـ popup blocker مُعَطَّل في الإعدادات

### نَافذة الطباعة تَبقى مَفتوحة
ضِف للاختصار: `--disable-popup-blocking`

### الورق يَخرج فارغًا
- افحص الـ default printer
- تَأكَّد أن الطابعة 80mm مَوصولة وعليها ورق

---

## 6. مَزايا v5.12.0

| المَزية | الحالة |
|--------|--------|
| لوحة مفاتيح ديناميكية AR/EN | ✅ |
| طباعة تلقائية للفاتورة عند Checkout | ✅ |
| طباعة تلقائية لتَقرير الشيفت عند الإقفال | ✅ |
| إخفاء زر "طباعة" في receipt modal | ✅ |
| Silent print بـ Chrome/Edge --kiosk-printing | ✅ |
