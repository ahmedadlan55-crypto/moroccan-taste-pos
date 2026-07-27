/**
 * Arabic labels for the POS-only print builders in `lib/receipt.ts`
 * (kitchen ticket + shift X/Z report). These are NOT the shared sale-receipt /
 * credit-note templates in `frontend/shared/invoiceTemplate.ts` — that module
 * has its own bilingual migration in parallel.
 *
 * receipt.ts imports this object directly (it builds raw HTML strings, not
 * JSX) rather than going through useT() — see the i18n plan's note on
 * non-component consumers.
 */
export const receipt = {
  kitchen: {
    docTitle: "تذكرة مطبخ",
    heading: "المطبخ",
    table: "طاولة",
    orderType: {
      dine_in: "محلي",
      delivery: "توصيل",
      takeaway: "سفري",
    },
  },
  shift: {
    titleX: "تقرير منتصف وردية · X",
    titleZ: "تقرير إغلاق وردية · Z",
    shift: "وردية:",
    cashier: "الكاشير:",
    start: "البداية:",
    end: "الإغلاق:",
    printed: "طُبع:",
    orderCount: "عدد الفواتير",
    itemsCount: "عدد الأصناف المباعة",
    openingFloat: "رصيد افتتاحي",
    paymentMethod: "طريقة الدفع",
    expected: "متوقع",
    counted: "معدود",
    variance: "فرق",
    expectedTotal: "الإجمالي المتوقع",
    countedTotal: "الإجمالي المعدود",
    difference: "الفرق",
    unmatched: "غير مطابق لأي طريقة",
    denomFace: "الفئة",
    count: "العدد",
    total: "الإجمالي",
    // W2-A — till cash movements (pay-in / pay-out) on the X/Z report. Printed
    // only when the shift has any, so an untouched drawer's report is unchanged.
    tillMovements: "حركات نقدية على الدرج",
    movementReason: "السبب",
    movementIn: "إيداع",
    movementOut: "سحب",
    movementNet: "صافي الحركات",
    item: "الصنف",
    qty: "كمية",
    itemTotal: "إجمالي",
    footerX: "تقرير X — الوردية ما زالت مفتوحة",
    footerZ: "نهاية تقرير الوردية",
    halala: "هللة",
    currency: "ر.س",
    dash: "—",
  },
} as const;
