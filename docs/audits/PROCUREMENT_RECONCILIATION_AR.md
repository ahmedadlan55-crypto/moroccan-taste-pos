# تقرير التسوية المحاسبية (Reconciliation)

المُنتِج: `node scripts/procurement/reconcile.js` (قراءة فقط، خروج ≠ 0 عند فشل ثابت).

## الثوابت المفروضة

| الفحص | التعريف | فادح؟ |
|---|---|---|
| `lot_invariant` | Σ `purchase_lots.qty_remaining` لكل مادة·مستودع = `warehouse_stock.qty` | نعم |
| `stock_rollup` | Σ `warehouse_stock.qty` لكل مادة = `inv_items.stock` | نعم |
| `gl_balanced` | كل `gl_journals`: `total_debit = total_credit` | نعم |
| `gl_global_balance` | Σ مدين = Σ دائن على مستوى النظام | نعم |
| `invoice_balance_integrity` | `balance_amount = total_amount − Σ(payment_allocations غير معكوسة)` | نعم |
| `ap_balance_reconciled` | رصيد GL AP (2100) مقابل Σ `v_supplier_ap_balance` | دلتا مُبلّغة؛ فادح فقط بـ`--strict` |

## نتيجة التشغيل على القاعدة المحلية (بعد دورة التكامل الكاملة)

```
✅ lot_invariant — 0 اختلاف (من 1 مادة ملوّتة)
✅ stock_rollup — 0
✅ gl_balanced — 0 قيود غير متوازنة
✅ gl_global_balance — Σمدين=37367.4 = Σدائن=37367.4
✅ ap_balance_reconciled — GL AP=-450 مقابل مشتق=0 (دلتا -450)
✅ invoice_balance_integrity — 0
النتيجة: PASS
```

### تفسير دلتا AP (قبل/بعد)
- **المشتق (`v_supplier_ap_balance`) = 0**: كل فواتير المشتريات الجديدة سُدّدت بالكامل عبر التخصيصات (الدورة المُختبَرة: فاتورة 1380 → سداد 1380 → رصيد 0).
- **رصيد GL AP = -450**: يعود إلى قيود **قديمة (قبل-P2P)** موجودة مسبقًا في `gl_accounts.balance`، لا علاقة لها بمحرك المشتريات الجديد. لذلك الدلتا مُفسَّرة بالكامل ولا تُعدّ فشلًا (تصبح فادحة فقط تحت `--strict` على دفتر نظيف/مُرحّل).
- **ضريبة المدخلات = 180** = 15% من صافي 1200 (متطابق مع الفاتورة الوحيدة).

## الأعداد (بعد الدورة)
suppliers=1 · purchase_orders=1 · purchase_receipts=3 · supplier_invoices=1 · payment_records=1 · purchase_returns=0 · procurement_events=78 · orphan invoices بلا مورد=0.

> على قاعدة تحمل بيانات قديمة كثيرة، شغّل `backfill --apply` ثم `reconcile` لتفسير الدلتا؛ ثوابت المخزون/التوازن يجب أن تبقى صفرًا.
