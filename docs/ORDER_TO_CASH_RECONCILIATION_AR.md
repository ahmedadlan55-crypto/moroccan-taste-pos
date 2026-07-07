# المطابقة والثوابت — Order-to-Cash

`O2CReconciliationService.run()` (وسكربت `npm run o2c:reconcile`) — كلها استعلامات **للقراءة فقط**، متوافقة مع ONLY_FULL_GROUP_BY، لا تُعدّل شيئًا. تُرجِع `{ pass, checks:[{name, pass, detail, severity}] }` وتخرج بـ exit 1 عند فشل صلب (severity=`error`).

## الثوابت
| # | الاسم | القاعدة | الشدّة |
|---|---|---|---|
| 1 | `gl_balanced` | كل `gl_journals`: Σمدين = Σدائن | error |
| 2 | `invoice_consistency` | لكل فاتورة: `balance = total − paid` | error |
| 3 | `no_negative_balance` | لا فاتورة برصيد سالب | error |
| 4 | `no_over_allocation` | Σ التخصيصات الحيّة ≤ إجمالي الفاتورة | error |
| 5 | `payment_within_amount` | Σ التخصيصات الحيّة ≤ مبلغ الدفعة | error |
| 6 | `no_orphan_allocation` | كل تخصيص يشير لفاتورة ودفعة موجودتين | error |
| 7 | `unique_source` | لا (source_type, source_id) مكرر | error |
| 8 | `ar_ties_to_gl` | AR الفرعي المفتوح (O2C) = رصيد GL 1150 | warn |

## ملاحظات
- **الثابت 8 (AR↔GL)** بشدّة `warn`: أثناء الانتقال قد يوجد فارق يعود لذمم قديمة رُحّلت لـ GL 1150 خارج O2C (مثلاً بيع آجل قديم). في قاعدة تحوي بيانات O2C فقط، الفارق = 0. **إشعار دائن AR-reduction** يخفض رصيد الفاتورة الأصل بالمبلغ نفسه الذي يخفض به GL 1150 → يبقى الفرعي مربوطًا بالـGL.
- **إشعار دائن نقدي/بنكي/رصيد-دائن** لا يمسّ AR (يدائن Cash/Bank/Deposits)، فلا يغيّر الفرعي ولا GL 1150 → متسق.
- الرصيد دائمًا **مشتق** من `v_customer_ar_balance` (لا `customers.balance`).

## نتيجة التشغيل المحلي (MariaDB 3307)
كل الثوابت الصلبة **PASS**؛ الثابت 8 `WARN` بفارق يُفسَّر بالبيانات القديمة/الاختبارية المتراكمة. لا فشل صلب.

## ثوابت إضافية على مستوى الاختبار (o2cServices.integration)
- 0% VAT يبقى 0 (لا يتحوّل 15). inclusive VAT صحيح. aging **حسب due date** لا تاريخ البيع.
- idempotency replay = نفس النتيجة بلا تكرار GL. `expectedVersion` متقادم = 409.
- العكس = قيد append-only (لا حذف من `gl_journals`/`gl_entries`).
