/**
 * Common JS — DOM helpers, i18n, modals, toast, loader, state base
 * Loaded by every page.
 */

// ─── Global state (each page initializes from localStorage) ───
window.state = window.state || {
  user: '',
  role: '',
  activeShiftId: '',
  settings: { name: 'Moroccan Taste', taxNumber: '0', currency: 'SAR' },
  menu: [],
  categories: [],
  cart: [],
  currentDiscount: { name: '', amount: 0 },
  activeCat: '',
  lang: localStorage.getItem('pos_lang') || 'ar',
  paymentMethods: [],
  kitaFeeRate: 0
};

// ─── DOM Utilities ───
window.q = function(s) { return document.querySelector(s); };
window.qs = function(s) { return document.querySelectorAll(s); };
window.show = function(id) { var el = q(id); if (el) el.classList.remove('hidden'); };
window.hide = function(id) { var el = q(id); if (el) el.classList.add('hidden'); };
window.formatVal = function(v) { return Number(v || 0).toFixed(2); };

// ─── Locales Dictionary ───
window.dict = {
  ar: {
    // Auth / common
    login: 'تسجيل الدخول', errLogin: 'خطأ في تسجيل الدخول', loading: 'جاري التحميل...',
    cancel: 'إلغاء', confirm: 'تأكيد', ok: 'حسناً', close: 'إغلاق', back: 'رجوع',
    errorTitle: 'خطأ', success: 'تمت العملية بنجاح!',
    yes: 'نعم', no: 'لا', print: 'طباعة',

    // Navigation / header
    sales: 'المبيعات', home: 'الرئيسية', inventory: 'المخزون', users: 'المستخدمين',
    reports: 'التقارير', settings: 'الإعدادات', dash: 'الداشبورد',
    pos: 'نقطة البيع', dashboard: 'الرئيسية', logout: 'تسجيل خروج',
    installApp: 'تثبيت التطبيق', installingApp: 'جاري تثبيت التطبيق…',

    // Shift — general
    shift: 'الشيفت:', openShift: 'فتح الوردية', closeShift: 'إغلاق الوردية', noShift: 'لا يوجد وردية مفتوحة',
    openShiftTitle: 'فتح وردية', openShiftMsg: 'هل تريد فتح وردية بيع جديدة للموظف: ',
    openShiftBtn: 'فتح الوردية', shiftStarted: 'تم بدء الوردية بنجاح!',
    shiftAlreadyOpen: 'هناك وردية مفتوحة بالفعل', noActiveShift: 'ليس لديك وردية نشطة حالياً لإغلاقها',
    shiftRequired: 'عذراً، يجب فتح وردية لاستقبال الطلبات.',
    noShiftTitle: 'وردية مغلقة', noShiftBodyMsg: 'لا توجد وردية مفتوحة حالياً. افتح وردية جديدة قبل إتمام الدفع.',
    shiftClosed: 'تم إغلاق الوردية بنجاح!',
    shiftClose: 'إغلاق الوردية', confirmClose: 'اعتماد وإغلاق', approveAndClose: 'اعتماد وإغلاق',
    enterAmounts: 'أدخل المبالغ الفعلية في الدرج:',
    cashAmount: 'المبلغ النقدي (كاش)', cardAmount: 'مدى / شبكة', kitaAmount: 'كيتا / آجل',
    confirmCloseTitle: 'تأكيد الإغلاق',
    diffExactMsg: 'الفرق متطابق تماماً (0.00). متابعة لإغلاق الوردية؟',

    // Shift variance block
    unbalancedDiff: 'فرق غير متوازن',
    noAmountEnteredMsg: 'لم تُدخل أي مبلغ! المبيعات المتوقعة في النظام هي ',
    noAmountEnteredMsgSuffix: '. أدخل المبالغ الفعلية في الدرج قبل الإغلاق.',
    unbalancedMsg: 'يوجد فرق بين مبالغ الدرج والمبيعات المسجلة. يجب أن يكون الفرق صفراً لإغلاق الوردية. يُرجى مراجعة الفواتير وتصحيح المبالغ ثم المحاولة مجدداً.',
    method: 'الوسيلة', expected: 'المتوقع', actual: 'الفعلي', difference: 'الفرق',
    varianceBlockNote: '⚠️ لا يمكن إغلاق الوردية حتى يكون الفرق صفراً. اضغط رجوع وراجع الفواتير في السجل.',
    backToInvoices: 'رجوع لمراجعة الفواتير',

    // Shift close report
    shiftCloseReport: 'تقرير إغلاق الوردية',
    shiftNumber: 'رقم الوردية', cashierLabel: 'الكاشير', closeDate: 'تاريخ الإغلاق',
    ordersCount: 'عدد الطلبات', totalSales: 'إجمالي المبيعات',
    diffExactConfirm: 'الفرق متطابق — البيانات سليمة',
    identifier: 'المعرف', amountSar: 'المبلغ (SAR)',
    diffZeroValid: '✅ الفرق: 0.00 — متطابق',
    sendWhatsApp: 'إرسال عبر واتساب',

    // WhatsApp report
    wappTitle: '🧾 *تقرير إغلاق الوردية*',
    wappOrders: '🧾 عدد الطلبات: ',
    wappTotalSales: '💰 إجمالي المبيعات: ',
    wappCashier: '👤 الكاشير',
    wappDate: '🕐 التاريخ',
    wappShiftId: '📋 رقم الوردية',
    wappPaymentBreakdown: '*تفصيل الدفع:*',
    wappCash: '• كاش: ',
    wappCard: '• مدى: ',
    wappKita: '• كيتا: ',
    wappDiffExact: '✅ الفرق: 0.00 — متطابق',

    // Cart
    cartTitle: 'سلة الطلبات', goBack: 'الرجوع', viewCart: 'السلة',
    emptyCart: 'السلة فارغة!', emptyCartDesc: 'اختر منتجات من القائمة لإضافتها',
    subtotal: 'المجموع الفرعي:', discount: 'الخصم:',
    serviceFee: 'رسوم الخدمة:', serviceFeeAuto: 'تلقائي',
    serviceFeeInputPH: 'أدخل مبلغ الرسوم يدوياً',
    totalLabel: 'الإجمالي:', total: 'الإجمالي', tax: 'الضريبة',
    checkout: 'إتمام الطلب', checkoutBtn: 'إتمام الدفع والطلب',
    clearCart: 'تفريغ السلة',
    clearCartTitle: 'تفريغ السلة', clearCartMsg: 'هل تريد إزالة جميع الأصناف من السلة؟',
    yesClear: 'نعم، أفرغ',
    addDiscount: 'إضافة خصم', emptyCartTitle: 'إفراغ السلة',

    // Search / product grid
    searchP: 'بحث عن منتج...', searchPlaceholder: 'البحث برقم، أو اسم المنتج...',
    categories: 'التصنيفات', allItems: 'الكل',
    outOfStock: 'نفذ', inStock: 'متوفر', noProducts: 'لا توجد منتجات',
    qty: 'الكمية', price: 'السعر', remove: 'حذف', addToCart: 'أضف للسلة',
    decrease: 'تقليل', increase: 'زيادة', add: 'إضافة', deleteLabel: 'حذف',

    // Payment methods
    cash: 'كاش', card: 'مدى', kita: 'كيتا', split: 'تجزئة',
    splitPayment: 'تجزئة الدفع', splitTitle: 'تجزئة الدفع',
    remaining: 'المتبقي:',
    splitMismatchTitle: 'فرق في التجزئة',
    splitMismatchPre: 'مجموع التجزئة (',
    splitMismatchMid: ') لا يساوي الإجمالي (',
    splitMismatchSuf: ')',

    // Discount modal
    chooseDiscount: 'اختر خصماً',
    noDiscounts: 'لا توجد خصومات متاحة',
    discountApplied: 'تم تطبيق الخصم',

    // Checkout / order save
    orderSaved: 'تم حفظ الطلب بنجاح!',
    invoiceSaveFailed: 'فشل حفظ الفاتورة',
    invoiceSaveErrorDefault: 'تعذّر حفظ الفاتورة في قاعدة البيانات',
    connectionFailed: 'فشل الاتصال',
    connectionFailedMsg: 'تعذّر الاتصال بالخادم لحفظ الفاتورة',
    userNotRecognized: 'لم يتم التعرّف على المستخدم. الرجاء تسجيل الدخول من جديد.',
    confirmServiceFeeTitle: 'تأكيد رسوم الخدمة',
    serviceFeeLine: 'رسوم الخدمة: ',
    totalLine: 'الإجمالي: ',
    continue: 'متابعة',
    failLoadData: 'فشل تحميل البيانات',
    failConnect: 'تعذر الاتصال بالخادم',

    // Receipt
    receiptTitle: 'فاتورة',
    simplifiedTaxInvoice: 'فاتورة ضريبية مبسطة',
    thankYou: 'شكراً لزيارتكم',
    receiptTotalLabel: 'إجمالي',
    receiptNetLabel: 'قبل الضريبة',
    receiptVatLabel: 'الضريبة',

    // Glass confirm/alert fallbacks
    confirmTitle: 'تأكيد', alertTitle: 'تنبيه',

    // Language toggle toast
    switchedAr: 'تم التحويل للعربية',
    switchedEn: 'Switched to English',

    // Printer settings
    printer: 'الطابعة الحرارية',
    printerSettings: 'إعدادات الطابعة الحرارية',
    noPrinterConnected: 'لا توجد طابعة مرتبطة',
    printerConnected: 'تم ربط الطابعة',
    printerCleared: 'تم إلغاء ربط الطابعة',
    printerType_bluetooth: 'بلوتوث',
    printerType_usb: 'USB',
    printerType_network: 'شبكة',
    bluetooth: 'بلوتوث',
    usb: 'USB',
    network: 'شبكة',
    bluetoothHint: 'اضغط "بحث" لفتح قائمة أجهزة البلوتوث القريبة. اختر الطابعة من القائمة التي تظهر.',
    usbHint: 'وصّل الطابعة بالهاتف أو الجهاز عن طريق كابل USB ثم اضغط "بحث" لاختيارها.',
    networkHint: 'إذا كانت الطابعة متصلة بالشبكة، أدخل عنوان IP والمنفذ (عادة 9100) ثم اضغط "حفظ".',
    scanBluetooth: 'بحث عن طابعة بلوتوث',
    scanUsb: 'بحث عن طابعة USB',
    ipAddress: 'عنوان IP',
    port: 'المنفذ',
    save: 'حفظ',
    ipRequired: 'الرجاء إدخال عنوان IP',
    invalidIp: 'صيغة عنوان IP غير صحيحة',
    supported: 'مدعوم في هذا المتصفح',
    unsupportedBrowserBluetooth: 'متصفحك لا يدعم Web Bluetooth. استخدم Chrome أو Edge على Android أو سطح المكتب (ليس iOS Safari ولا Firefox).',
    unsupportedBrowserUsb: 'متصفحك لا يدعم Web USB. استخدم Chrome أو Edge على Android أو سطح المكتب.',
    bluetoothIOSHint: 'Web Bluetooth غير مدعوم على أجهزة iPhone / iPad. لربط طابعة بلوتوث، استخدم خيار "شبكة" إذا كانت الطابعة تدعم WiFi، أو استخدم تطبيق طابعة من App Store.',
    bluetoothNotSecure: 'البلوتوث يتطلب اتصالاً آمناً (HTTPS). تأكد من فتح الموقع عبر https:// وليس http://.',
    bluetoothRadioOff: 'البلوتوث مُعطَّل في جهازك. افتح إعدادات الجهاز وشغّل البلوتوث، ثم حاول مرة أخرى.',
    bluetoothPwaWarning: 'تنبيه: أنت تستخدم التطبيق في وضع "التطبيق المُثبَّت" (PWA). بعض إصدارات Chrome على Android لا تدعم البلوتوث في هذا الوضع. إذا لم تظهر أي طابعات في القائمة، افتح الرابط مباشرة في Chrome (ليس من الأيقونة المُثبَّتة).',
    bluetoothNoDevicePicked: 'لم يتم اختيار أي جهاز.',
    bluetoothNoDevicesFound: 'لم يتم العثور على أي جهاز بلوتوث قريب.\n\nتأكد من:\n• تشغيل الطابعة وأنها في وضع الإقران (Pairing Mode)\n• البلوتوث مُفعَّل على جهازك\n• الطابعة قريبة (أقل من 10 أمتار)\n• صلاحية البلوتوث مسموحة للمتصفح في إعدادات الجهاز',
    bluetoothSecurityError: 'خطأ أمان — البلوتوث مرفوض بسبب سياسة الأمان. قد يكون الموقع يعمل على HTTP بدلاً من HTTPS.',
    bluetoothPermissionDenied: 'تم رفض إذن البلوتوث. اذهب إلى إعدادات المتصفح لهذا الموقع وفعّل إذن البلوتوث، ثم حاول مرة أخرى.',
    bluetoothNotSupportedHere: 'البلوتوث غير مدعوم في هذا السياق. جرّب فتح الرابط في Chrome المتصفح بدلاً من التطبيق المثبت.'
  },

  en: {
    // Auth / common
    login: 'Login', errLogin: 'Login failed', loading: 'Loading...',
    cancel: 'Cancel', confirm: 'Confirm', ok: 'OK', close: 'Close', back: 'Back',
    errorTitle: 'Error', success: 'Operation successful!',
    yes: 'Yes', no: 'No', print: 'Print',

    // Navigation / header
    sales: 'Sales', home: 'Home', inventory: 'Inventory', users: 'Users',
    reports: 'Reports', settings: 'Settings', dash: 'Dashboard',
    pos: 'POS', dashboard: 'Dashboard', logout: 'Logout',
    installApp: 'Install App', installingApp: 'Installing app…',

    // Shift — general
    shift: 'Shift:', openShift: 'Open Shift', closeShift: 'Close Shift', noShift: 'No open shift',
    openShiftTitle: 'Open Shift', openShiftMsg: 'Open a new shift for: ',
    openShiftBtn: 'Open Shift', shiftStarted: 'Shift started successfully!',
    shiftAlreadyOpen: 'A shift is already open', noActiveShift: 'You have no active shift to close',
    shiftRequired: 'A shift must be opened to receive orders.',
    noShiftTitle: 'No Open Shift', noShiftBodyMsg: 'No shift is currently open. Open a new shift before completing payment.',
    shiftClosed: 'Shift closed successfully!',
    shiftClose: 'Close Shift', confirmClose: 'Approve & Close', approveAndClose: 'Approve & Close',
    enterAmounts: 'Enter the actual drawer amounts:',
    cashAmount: 'Cash Amount', cardAmount: 'Card / Network', kitaAmount: 'Kita / Credit',
    confirmCloseTitle: 'Confirm Close',
    diffExactMsg: 'Difference is exactly 0.00. Continue to close the shift?',

    // Shift variance block
    unbalancedDiff: 'Unbalanced Difference',
    noAmountEnteredMsg: 'No amount entered! Expected sales in the system are ',
    noAmountEnteredMsgSuffix: '. Enter the actual drawer amounts before closing.',
    unbalancedMsg: 'There is a difference between the drawer amounts and recorded sales. The difference must be zero to close the shift. Please review the invoices and correct the amounts, then try again.',
    method: 'Method', expected: 'Expected', actual: 'Actual', difference: 'Difference',
    varianceBlockNote: '⚠️ You cannot close the shift until the difference is zero. Go back and review the invoices in the log.',
    backToInvoices: 'Back to Review Invoices',

    // Shift close report
    shiftCloseReport: 'Shift Close Report',
    shiftNumber: 'Shift Number', cashierLabel: 'Cashier', closeDate: 'Close Date',
    ordersCount: 'Orders Count', totalSales: 'Total Sales',
    diffExactConfirm: 'Difference is exact — data is valid',
    identifier: 'ID', amountSar: 'Amount (SAR)',
    diffZeroValid: '✅ Difference: 0.00 — Exact',
    sendWhatsApp: 'Send via WhatsApp',

    // WhatsApp report
    wappTitle: '🧾 *Shift Close Report*',
    wappOrders: '🧾 Orders: ',
    wappTotalSales: '💰 Total Sales: ',
    wappCashier: '👤 Cashier',
    wappDate: '🕐 Date',
    wappShiftId: '📋 Shift ID',
    wappPaymentBreakdown: '*Payment Breakdown:*',
    wappCash: '• Cash: ',
    wappCard: '• Card: ',
    wappKita: '• Kita: ',
    wappDiffExact: '✅ Difference: 0.00 — Exact',

    // Cart
    cartTitle: 'Order Cart', goBack: 'Back', viewCart: 'Cart',
    emptyCart: 'Cart is empty!', emptyCartDesc: 'Select products from the menu to add',
    subtotal: 'Subtotal:', discount: 'Discount:',
    serviceFee: 'Service Fee:', serviceFeeAuto: 'auto',
    serviceFeeInputPH: 'Enter service fee manually',
    totalLabel: 'Total:', total: 'Total', tax: 'Tax',
    checkout: 'Checkout', checkoutBtn: 'Complete Payment',
    clearCart: 'Clear Cart',
    clearCartTitle: 'Clear Cart', clearCartMsg: 'Remove all items from the cart?',
    yesClear: 'Yes, clear',
    addDiscount: 'Add Discount', emptyCartTitle: 'Clear Cart',

    // Search / product grid
    searchP: 'Search product...', searchPlaceholder: 'Search by number or product name...',
    categories: 'Categories', allItems: 'All',
    outOfStock: 'Out', inStock: 'In Stock', noProducts: 'No products',
    qty: 'Qty', price: 'Price', remove: 'Remove', addToCart: 'Add to Cart',
    decrease: 'Decrease', increase: 'Increase', add: 'Add', deleteLabel: 'Delete',

    // Payment methods
    cash: 'Cash', card: 'Card', kita: 'Kita', split: 'Split',
    splitPayment: 'Split Payment', splitTitle: 'Split Payment',
    remaining: 'Remaining:',
    splitMismatchTitle: 'Split Mismatch',
    splitMismatchPre: 'Split total (',
    splitMismatchMid: ') does not equal the grand total (',
    splitMismatchSuf: ')',

    // Discount modal
    chooseDiscount: 'Choose a Discount',
    noDiscounts: 'No discounts available',
    discountApplied: 'Discount applied',

    // Checkout / order save
    orderSaved: 'Order saved successfully!',
    invoiceSaveFailed: 'Failed to save invoice',
    invoiceSaveErrorDefault: 'Could not save invoice to the database',
    connectionFailed: 'Connection failed',
    connectionFailedMsg: 'Could not reach the server to save the invoice',
    userNotRecognized: 'User not recognized. Please log in again.',
    confirmServiceFeeTitle: 'Confirm Service Fee',
    serviceFeeLine: 'Service fee: ',
    totalLine: 'Total: ',
    continue: 'Continue',
    failLoadData: 'Failed to load data',
    failConnect: 'Could not connect to the server',

    // Receipt
    receiptTitle: 'Invoice',
    simplifiedTaxInvoice: 'Simplified Tax Invoice',
    thankYou: 'Thank you for your visit',
    receiptTotalLabel: 'Total',
    receiptNetLabel: 'Net',
    receiptVatLabel: 'VAT',

    // Glass confirm/alert fallbacks
    confirmTitle: 'Confirm', alertTitle: 'Notice',

    // Language toggle toast
    switchedAr: 'Switched to Arabic',
    switchedEn: 'Switched to English',

    // Printer settings
    printer: 'Thermal Printer',
    printerSettings: 'Thermal Printer Settings',
    noPrinterConnected: 'No printer connected',
    printerConnected: 'Printer connected',
    printerCleared: 'Printer disconnected',
    printerType_bluetooth: 'Bluetooth',
    printerType_usb: 'USB',
    printerType_network: 'Network',
    bluetooth: 'Bluetooth',
    usb: 'USB',
    network: 'Network',
    bluetoothHint: 'Tap "Scan" to open the nearby Bluetooth devices picker and select your printer.',
    usbHint: 'Connect the printer to your phone or device via USB cable, then tap "Scan" to select it.',
    networkHint: 'If the printer is on your local network, enter its IP address and port (usually 9100), then tap "Save".',
    scanBluetooth: 'Scan for Bluetooth printer',
    scanUsb: 'Scan for USB printer',
    ipAddress: 'IP Address',
    port: 'Port',
    save: 'Save',
    ipRequired: 'Please enter an IP address',
    invalidIp: 'Invalid IP format',
    supported: 'Supported in this browser',
    unsupportedBrowserBluetooth: 'Your browser does not support Web Bluetooth. Use Chrome or Edge on Android or desktop (not iOS Safari or Firefox).',
    unsupportedBrowserUsb: 'Your browser does not support Web USB. Use Chrome or Edge on Android or desktop.',
    bluetoothIOSHint: 'Web Bluetooth is not supported on iPhone / iPad. To connect a Bluetooth printer, use the "Network" option if your printer has WiFi, or use a printer app from the App Store.',
    bluetoothNotSecure: 'Bluetooth requires a secure connection (HTTPS). Make sure you are opening the site over https:// and not http://.',
    bluetoothRadioOff: 'Bluetooth is turned off on your device. Go to your device settings and enable Bluetooth, then try again.',
    bluetoothPwaWarning: 'Notice: you are running the app as an installed PWA. Some versions of Chrome for Android do not support Bluetooth in this mode. If no printers show up, open the link directly in Chrome (not from the installed icon).',
    bluetoothNoDevicePicked: 'No device was selected.',
    bluetoothNoDevicesFound: 'No nearby Bluetooth devices were found.\n\nCheck that:\n• The printer is powered on and in pairing mode\n• Bluetooth is enabled on your device\n• The printer is within range (less than 10 meters)\n• The browser has Bluetooth permission in your device settings',
    bluetoothSecurityError: 'Security error — Bluetooth was blocked by the security policy. The site may be running on HTTP instead of HTTPS.',
    bluetoothPermissionDenied: 'Bluetooth permission denied. Go to your browser settings for this site and enable Bluetooth permission, then try again.',
    bluetoothNotSupportedHere: 'Bluetooth is not supported in this context. Try opening the link in Chrome browser instead of the installed app.'
  }
};
window.t = function(k) { return (dict[state.lang] && dict[state.lang][k]) || k; };

// ─── Language ───
// IMPORTANT: do NOT reassign document.body.className here — it would wipe out
// the 'authenticated' class and re-engage the critical CSS auth gate, hiding
// the entire page. Toggle only the lang-specific classes.
window.applyLang = function() {
  document.body.classList.remove('ar', 'en');
  document.body.classList.add(state.lang);
  var html = document.documentElement;
  if (state.lang === 'ar') {
    html.setAttribute('lang', 'ar');
    html.setAttribute('dir', 'rtl');
  } else {
    html.setAttribute('lang', 'en');
    html.setAttribute('dir', 'ltr');
  }
};
window.translateUI = function() {
  // Text content
  document.querySelectorAll('[data-i18n]').forEach(function(el) {
    var key = el.getAttribute('data-i18n');
    var v = dict[state.lang] && dict[state.lang][key];
    if (v !== undefined) el.textContent = v;
  });
  // Placeholders
  document.querySelectorAll('[data-i18n-placeholder]').forEach(function(el) {
    var key = el.getAttribute('data-i18n-placeholder');
    var v = dict[state.lang] && dict[state.lang][key];
    if (v !== undefined) el.setAttribute('placeholder', v);
  });
  // title attributes (tooltips)
  document.querySelectorAll('[data-i18n-title]').forEach(function(el) {
    var key = el.getAttribute('data-i18n-title');
    var v = dict[state.lang] && dict[state.lang][key];
    if (v !== undefined) el.setAttribute('title', v);
  });
  // aria-label
  document.querySelectorAll('[data-i18n-aria-label]').forEach(function(el) {
    var key = el.getAttribute('data-i18n-aria-label');
    var v = dict[state.lang] && dict[state.lang][key];
    if (v !== undefined) el.setAttribute('aria-label', v);
  });
};
window.toggleLang = function() {
  state.lang = state.lang === 'ar' ? 'en' : 'ar';
  localStorage.setItem('pos_lang', state.lang);
  applyLang();
  translateUI();
  if (typeof window.onLangChange === 'function') window.onLangChange();
  showToast(state.lang === 'ar' ? t('switchedAr') : t('switchedEn'));
};

// ─── Loader ───
window.loader = function(showLoader) {
  if (showLoader === undefined) showLoader = true;
  var el = q('#loader');
  if (!el) return;
  el.style.display = showLoader ? 'flex' : 'none';
};

// ─── Toast ───
window.showToast = function(msg, isError) {
  var container = q('#toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  var tDiv = document.createElement('div');
  tDiv.className = 'toast ' + (isError ? 'error' : 'success');
  tDiv.innerHTML = '<i class="fas fa-' + (isError ? 'exclamation-circle' : 'check-circle') + '"></i> <span>' + msg + '</span>';
  container.appendChild(tDiv);
  setTimeout(function() {
    tDiv.style.animation = 'fadeOut 0.3s ease forwards';
    setTimeout(function() { tDiv.remove(); }, 300);
  }, 3000);
};

// ─── Modals ───
window.openModal = function(id) {
  show(id);
  setTimeout(function() {
    var m = q(id);
    if (m) m.classList.add('show');
  }, 10);
};
window.closeModal = function(id) {
  var m = q(id);
  if (m) m.classList.remove('show');
  setTimeout(function() { hide(id); }, 300);
};
// Click outside modal closes it
document.addEventListener('click', function(e) {
  if (e.target && e.target.classList && e.target.classList.contains('modal') && e.target.id) {
    closeModal('#' + e.target.id);
  }
});

// ─── API alias ───
// api-bridge.js exposes window._apiBridge — alias it as api for convenience
window.api = window._apiBridge;

// ─── Persist & restore minimal state ───
window.saveState = function() {
  try {
    localStorage.setItem('pos_state', JSON.stringify({
      user: state.user,
      role: state.role,
      activeShiftId: state.activeShiftId,
      settings: state.settings,
      paymentMethods: state.paymentMethods,
      kitaFeeRate: state.kitaFeeRate
    }));
  } catch (e) {}
};
window.restoreState = function() {
  try {
    var saved = localStorage.getItem('pos_state');
    if (saved) {
      var s = JSON.parse(saved);
      Object.assign(state, s);
    }
  } catch (e) {}
};

// ─── Glass modal helpers (replace native confirm/alert) ───
window.openGlassModal = function(id) {
  var m = q(id);
  if (!m) return;
  m.classList.remove('hidden');
  void m.offsetWidth; // force reflow so the transition runs
  m.classList.add('show');
};
window.closeGlassModal = function(id, result) {
  var m = q(id);
  if (!m) return;
  m.classList.remove('show');
  setTimeout(function() {
    m.classList.add('hidden');
    if (id === '#modalGlassConfirm' && typeof state._gcResolve === 'function') {
      var cb = state._gcResolve;
      state._gcResolve = null;
      cb(!!result);
    }
  }, 250);
};

// Ensure a generic confirm/alert modal exists at the end of <body>.
// Each page using glassConfirm/glassAlert calls this once (idempotent).
window.ensureGlassConfirmModal = function() {
  if (document.getElementById('modalGlassConfirm')) return;
  var m = document.createElement('div');
  m.id = 'modalGlassConfirm';
  m.className = 'glass-modal hidden';
  m.innerHTML =
    '<div class="glass-modal-content small">' +
      '<div class="glass-modal-title"><span id="gcTitle"><i class="fas fa-question-circle"></i> ' + t('confirmTitle') + '</span></div>' +
      '<div class="glass-modal-body"><p id="gcMessage" class="glass-modal-message"></p></div>' +
      '<div class="glass-modal-actions" id="gcActions">' +
        '<button class="btn btn-light" onclick="closeGlassModal(\'#modalGlassConfirm\', false)">' + t('cancel') + '</button>' +
        '<button class="btn btn-primary" onclick="closeGlassModal(\'#modalGlassConfirm\', true)">' + t('confirm') + '</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(m);
};

window.glassConfirm = function(title, message, opts) {
  ensureGlassConfirmModal();
  opts = opts || {};
  var tEl = q('#gcTitle');
  var mEl = q('#gcMessage');
  var actions = q('#gcActions');
  if (tEl) tEl.innerHTML = '<i class="fas ' + (opts.danger ? 'fa-exclamation-triangle' : 'fa-question-circle') + '"></i> ' + title;
  if (mEl) mEl.textContent = message;
  if (actions) {
    var okClass = opts.danger ? 'btn-danger' : 'btn-primary';
    actions.innerHTML =
      '<button class="btn btn-light" onclick="closeGlassModal(\'#modalGlassConfirm\', false)">' + (opts.cancelText || t('cancel')) + '</button>' +
      '<button class="btn ' + okClass + '" onclick="closeGlassModal(\'#modalGlassConfirm\', true)">' + (opts.okText || t('confirm')) + '</button>';
  }
  return new Promise(function(resolve) {
    state._gcResolve = resolve;
    openGlassModal('#modalGlassConfirm');
  });
};

window.glassAlert = function(title, message, opts) {
  ensureGlassConfirmModal();
  opts = opts || {};
  var tEl = q('#gcTitle');
  var mEl = q('#gcMessage');
  var actions = q('#gcActions');
  if (tEl) tEl.innerHTML = '<i class="fas ' + (opts.danger ? 'fa-exclamation-circle' : 'fa-info-circle') + '"></i> ' + title;
  if (mEl) mEl.textContent = message;
  if (actions) actions.innerHTML = '<button class="btn btn-primary" onclick="closeGlassModal(\'#modalGlassConfirm\', true)" style="flex:1;">' + t('ok') + '</button>';
  return new Promise(function(resolve) {
    state._gcResolve = resolve;
    openGlassModal('#modalGlassConfirm');
  });
};

// Apply language on first load
applyLang();

// ─── Branding (logo + name) ───
window.loadBrandingFromCache = function() {
  try {
    var b = JSON.parse(localStorage.getItem('pos_branding') || '{}');
    if (b.name) state.settings.name = b.name;
    if (b.logo) state.settings.logo = b.logo;
  } catch (e) {}
};
window.refreshBrandingFromServer = function(cb) {
  fetch('/api/settings').then(function(r) { return r.json(); }).then(function(s) {
    if (!s) return;
    var name = s.name || s.CompanyName || state.settings.name || 'Moroccan Taste';
    var logo = s.logo || s.Logo || '';
    state.settings.name = name;
    state.settings.logo = logo;
    try { localStorage.setItem('pos_branding', JSON.stringify({ name: name, logo: logo })); } catch (e) {}
    if (typeof cb === 'function') cb(name, logo);
  }).catch(function() {});
};
loadBrandingFromCache();
