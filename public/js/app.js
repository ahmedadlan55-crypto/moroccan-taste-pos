// =========================================
// 0. Lazy script loader — defer Chart.js / XLSX / QRCode / erp.js until needed
// =========================================
// Cache-bust our own /js/ files so browser always pulls the latest build.
// (CDN libs are left alone since they use immutable versioned URLs.)
window._appBuildId = window._appBuildId || ('b' + Date.now());  // per-tab cache buster
window._loadedScripts = window._loadedScripts || {};
window.loadScript = function(url) {
  // Append ?v= build id only for same-origin /js/ files
  var final = url;
  if (/^\/js\//.test(url) && url.indexOf('?') < 0) {
    final = url + '?v=' + window._appBuildId;
  }
  if (window._loadedScripts[final] === true) return Promise.resolve();
  if (window._loadedScripts[final] && window._loadedScripts[final].then) return window._loadedScripts[final];
  var p = new Promise(function(resolve, reject) {
    var s = document.createElement('script');
    s.src = final;
    s.async = false; // preserve order if multiple loads happen
    s.onload  = function() { window._loadedScripts[final] = true; resolve(); };
    s.onerror = function() { delete window._loadedScripts[final]; reject(new Error('فشل تحميل ' + url)); };
    document.head.appendChild(s);
  });
  window._loadedScripts[final] = p;
  return p;
};
window.ensureChartJs = function() {
  if (typeof Chart !== 'undefined') return Promise.resolve();
  return loadScript('https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js');
};
window.ensureXlsx = function() {
  if (typeof XLSX !== 'undefined') return Promise.resolve();
  return loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
};
window.ensureQRCode = function() {
  if (typeof QRCode !== 'undefined') return Promise.resolve();
  return loadScript('https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js');
};
window.ensureErpJs = function() {
  if (window._erpJsLoaded) return Promise.resolve();
  return loadScript('/js/erp.js')
    .then(function() { return loadScript('/js/cash-mgmt.js'); })
    .then(function() { window._erpJsLoaded = true; });
};

window.ensureCustodyJs = function() {
  if (window._custodyJsLoaded) return Promise.resolve();
  return loadScript('/js/custody.js').then(function() { window._custodyJsLoaded = true; });
};

// erpNav is called by sidebar onclicks but erp.js isn't loaded eagerly anymore.
// Define a lazy stub here that loads erp.js then forwards the call to the real
// erpNav defined inside erp.js (which overwrites this stub on load).
window.erpNav = function(section) {
  ensureErpJs().then(function() {
    if (window.erpNav && window.erpNav !== window._erpNavStub) {
      window.erpNav(section);
    }
  }).catch(function(e) { showToast(e.message || 'فشل تحميل وحدة ERP', true); });
};
window._erpNavStub = window.erpNav;

// =========================================
// 1. App State & Utilities
// =========================================
let state = {
  user: "", role: "", activeShiftId: "", settings: { name: "Moroccan Taste", taxNumber: "0", currency: "SAR" },
  menu: [], categories: [], cart: [], currentDiscount: { name: "", amount: 0 },
  activeCat: "", lang: localStorage.getItem("pos_lang") || "ar",
  charts: {}, reportCache: null, kitaFeeRate: 0
};

// DOM Utilities
const q = s => document.querySelector(s);
const qs = s => document.querySelectorAll(s);
const show = id => { const el = q(id); if (el) el.classList.remove("hidden"); };
const hide = id => { const el = q(id); if (el) el.classList.add("hidden"); };
// Smart formatting: show up to 4 decimal places for tiny costs (< 1),
// 2 decimals for normal prices. Never shows "0.00" when the value is 0.0035.
const formatVal = v => {
  var n = Number(v || 0);
  if (n === 0) return '0.00';
  if (Math.abs(n) < 0.01) return n.toFixed(4);
  if (Math.abs(n) < 1) return n.toFixed(3);
  return n.toFixed(2);
};

// ─── Local-date helper ───
// Returns "YYYY-MM-DD" in the user's LOCAL timezone (not UTC).
// Critical: using new Date().toISOString().split('T')[0] returns the UTC
// date, which drifts from the local date around midnight and causes
// invoices created "today" locally to disappear from the "today" filter
// in reports. Always use this helper for report filter defaults.
const localDateStr = d => {
  const dt = d ? new Date(d) : new Date();
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return yyyy + '-' + mm + '-' + dd;
};
// Resolve a username to its display name (falls back to username if no metadata)
function userLabel(username) {
  if (!username) return '';
  if (state && state.userDisplayMap && state.userDisplayMap[username]) {
    return state.userDisplayMap[username] + ' (' + username + ')';
  }
  return username;
}

// Distribute a sale's payment string + amount across cash/card/kita/other buckets.
// Handles both plain methods ("Cash", "Card", "Kita") and split format
// (e.g. "Cash:50/Card:30/Kita:20" — what the backend writes when Split is used).
// `buckets` is mutated; if `countBuckets` is provided, each method that received money
// also gets +1 there (so a split sale counts in multiple categories).
function distributePayment(paymentStr, totalAmount, buckets, countBuckets) {
  buckets.cash  = buckets.cash  || 0;
  buckets.card  = buckets.card  || 0;
  buckets.kita  = buckets.kita  || 0;
  buckets.other = buckets.other || 0;
  if (countBuckets) {
    countBuckets.cash  = countBuckets.cash  || 0;
    countBuckets.card  = countBuckets.card  || 0;
    countBuckets.kita  = countBuckets.kita  || 0;
    countBuckets.other = countBuckets.other || 0;
  }

  var pay = String(paymentStr || '').toLowerCase().trim();
  totalAmount = Number(totalAmount) || 0;

  function addTo(method, amt) {
    if (amt <= 0) return;
    if (method === 'cash')                       { buckets.cash += amt; if (countBuckets) countBuckets.cash++; }
    else if (method === 'card' || method === 'mada') { buckets.card += amt; if (countBuckets) countBuckets.card++; }
    else if (method === 'kita')                  { buckets.kita += amt; if (countBuckets) countBuckets.kita++; }
    else                                          { buckets.other += amt; if (countBuckets) countBuckets.other++; }
  }

  // Split format: "Cash:50/Card:30/Kita:20"
  if (pay.indexOf(':') !== -1) {
    pay.split('/').forEach(function(part) {
      var kv = part.split(':');
      if (kv.length === 2) addTo(kv[0].trim(), Number(kv[1]) || 0);
    });
    return;
  }

  // Plain method
  addTo(pay, totalAmount);
}

// Format a payment string for human display.
// "Cash:50/Card:30" → "كاش 50.00 + مدى 30.00"
function paymentLabel(paymentStr) {
  var pay = String(paymentStr || '');
  if (pay.indexOf(':') === -1) {
    var p = pay.toLowerCase();
    if (p === 'cash') return state.lang === 'en' ? 'Cash' : 'كاش';
    if (p === 'card' || p === 'mada') return state.lang === 'en' ? 'Card' : 'مدى';
    if (p === 'kita') return state.lang === 'en' ? 'Kita' : 'كيتا';
    return pay || '—';
  }
  var labelMap = {
    cash: state.lang === 'en' ? 'Cash' : 'كاش',
    card: state.lang === 'en' ? 'Card' : 'مدى',
    mada: state.lang === 'en' ? 'Card' : 'مدى',
    kita: state.lang === 'en' ? 'Kita' : 'كيتا'
  };
  return pay.split('/').map(function(part) {
    var kv = part.split(':');
    if (kv.length !== 2) return part;
    var lbl = labelMap[kv[0].trim().toLowerCase()] || kv[0];
    return lbl + ' ' + (Number(kv[1]) || 0).toFixed(2);
  }).join(' + ');
}

// =========================================
// Server-side template injection (Foodics-style)
// =========================================
// The application HTML (admin / POS / ERP / modals) is NOT in index.html.
// It lives in views/app-content.html and is served by GET /api/auth/template,
// which is protected by the JWT verifyToken middleware. The frontend fetches
// it AFTER login, injects it at the <!-- TEMPLATE_INJECTION_POINT --> marker,
// then runs the normal init flow. Anonymous visitors never see the HTML.
function fetchAppTemplate() {
  var token = localStorage.getItem('pos_token');
  if (!token) return Promise.reject(new Error('NO_TOKEN'));
  return fetch('/api/auth/template', {
    headers: { 'Authorization': 'Bearer ' + token, 'Cache-Control': 'no-cache' }
  }).then(function(r) {
    if (r.status === 401) throw new Error('UNAUTHORIZED');
    if (!r.ok) throw new Error('FETCH_FAILED_' + r.status);
    return r.text();
  });
}

// ─── Section HTML Cache — lazy-mounting ───
window._sectionHTMLCache = {};     // sectionId → outerHTML (cached from template)
window._mountedSections = {};      // sectionId → true if already in DOM

function injectAppTemplate(html) {
  // If already injected (DOM already has #adminView), do nothing
  if (document.getElementById('adminView')) return;

  // Find the marker comment node
  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_COMMENT, null);
  var marker = null;
  while (walker.nextNode()) {
    if (walker.currentNode.nodeValue && walker.currentNode.nodeValue.indexOf('TEMPLATE_INJECTION_POINT') !== -1) {
      marker = walker.currentNode;
      break;
    }
  }

  // Parse HTML into a fragment via a temporary container
  var container = document.createElement('div');
  container.innerHTML = html;

  // Extract ALL admin-section + dash-section children → cache them, remove from DOM tree
  // Keep only the sidebar + main content frame + modals
  var extracted = 0;
  var toCache = container.querySelectorAll('.admin-section, .dash-section');
  toCache.forEach(function(el) {
    var id = el.id;
    if (!id) return;
    window._sectionHTMLCache[id] = el.outerHTML;
    el.parentNode.removeChild(el);
    extracted++;
  });
  console.log('[Lazy] Cached ' + extracted + ' sections for on-demand mounting');

  // Insert remaining children (sidebar + shell + modals) before the marker
  var insertBefore = marker || document.querySelector('script[src="/js/api-bridge.js"]') || document.querySelector('script[src="/js/app.js"]');
  while (container.firstChild) {
    document.body.insertBefore(container.firstChild, insertBefore);
  }
  if (marker && marker.parentNode) marker.parentNode.removeChild(marker);
}

// Mount a section from cache into the DOM (lazy) — called by nav/erpNav
window.mountSection = function(sectionId) {
  if (window._mountedSections[sectionId]) return true; // already mounted
  if (document.getElementById(sectionId)) { window._mountedSections[sectionId] = true; return true; }
  var html = window._sectionHTMLCache[sectionId];
  if (!html) return false; // section doesn't exist in template
  // Mount inside .admin-main (where sections originally lived)
  var mountPoint = document.querySelector('.admin-main') || document.querySelector('.admin-content');
  if (!mountPoint) return false;
  var wrapper = document.createElement('div');
  wrapper.innerHTML = html;
  while (wrapper.firstChild) {
    mountPoint.appendChild(wrapper.firstChild);
  }
  window._mountedSections[sectionId] = true;
  return true;
};

// Wipe injected template back out — used by logout
function clearInjectedTemplate() {
  var keep = { 'loader': 1, 'loginView': 1, 'toastContainer': 1 };
  Array.from(document.body.children).forEach(function(node) {
    if (node.id && keep[node.id]) return;
    if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE') return;
    node.remove();
  });
  // Re-add the marker so subsequent logins can re-inject
  var firstScript = document.querySelector('script[src="/js/api-bridge.js"]') || document.querySelector('script[src="/js/app.js"]');
  if (firstScript && firstScript.parentNode === document.body) {
    document.body.insertBefore(document.createComment(' TEMPLATE_INJECTION_POINT '), firstScript);
  }
}

// Locales Dict
const dict = {
  ar: {
    login: "تسجيل الدخول", errLogin: "خطأ في تسجيل الدخول",
    sales: "المبيعات", shift: "الشيفت:", openShift: "فتح الوردية", closeShift: "إغلاق الوردية", noShift: "لا يوجد وردية مفتوحة",
    dash: "الداشبورد", home: "الرئيسية", inventory: "المخزون", users: "المستخدمين", reports: "التقارير", settings: "الإعدادات",
    emptyCart: "السلة فارغة!", checkout: "إتمام الطلب", tax: "الضريبة", total: "الإجمالي", searchP: "بحث عن منتج...",
    success: "تمت العملية بنجاح!", loading: "جاري المعالجة...",
    cartTitle: "سلة الطلبات", goBack: "الرجوع", viewCart: "مشاهدة السلة",
    cash: "كاش", card: "مدى", kita: "كيتا", split: "تجزئة",
    subtotal: "المجموع الفرعي:", discount: "الخصم:", serviceFee: "رسوم الخدمة:",
    totalLabel: "الإجمالي:", checkoutBtn: "إتمام الدفع والطلب",
    emptyCartDesc: "اختر منتجات من القائمة لإضافتها",
    qty: "الكمية", price: "السعر", remove: "حذف", addToCart: "أضف للسلة",
    shiftClose: "إغلاق الوردية", cashAmount: "المبلغ النقدي (كاش)", cardAmount: "مدى / شبكة", kitaAmount: "كيتا / آجل",
    confirmClose: "اعتماد الجرد وإغلاق الوردية", cancel: "إلغاء",
    enterAmounts: "أدخل المبالغ الفعلية في الدرج:", shiftReport: "تقرير إغلاق الوردية",
    categories: "التصنيفات", allItems: "الكل", outOfStock: "نفذ", inStock: "متوفر",

    // ═══ Admin ERP translations (Phase A foundation) ═══
    "admin.dashboard": "لوحة تحكم المدير",
    "admin.save": "حفظ", "admin.cancel": "إلغاء", "admin.delete": "حذف", "admin.edit": "تعديل",
    "admin.add": "إضافة", "admin.search": "بحث", "admin.filter": "تصفية", "admin.refresh": "تحديث",
    "admin.export": "تصدير", "admin.import": "استيراد", "admin.close": "إغلاق", "admin.apply": "تطبيق",
    "admin.back": "رجوع", "admin.next": "التالي", "admin.prev": "السابق", "admin.submit": "إرسال",
    "admin.confirm": "تأكيد", "admin.yes": "نعم", "admin.no": "لا", "admin.loading": "جاري التحميل...",
    "admin.empty": "لا توجد بيانات", "admin.error": "خطأ", "admin.success": "تم بنجاح",
    "admin.logout": "تسجيل خروج", "admin.toggleLang": "English",
    // Menu items
    "admin.nav.menu": "المنيو", "admin.nav.warehouse": "المستودعات والإنتاج",
    "admin.nav.purchases": "المشتريات", "admin.nav.expenses": "المصروفات",
    "admin.nav.custody": "العهد", "admin.nav.shifts": "سجل المناوبات",
    "admin.nav.reports": "التقارير", "admin.nav.settings": "الإعدادات",
    "admin.nav.erp": "نظام ERP", "admin.nav.accounting": "المحاسبة",
    "admin.nav.customers": "العملاء والموردين", "admin.nav.cashMgmt": "إدارة النقد",
    "admin.nav.general": "الإدارة العامة", "admin.nav.txns": "المعاملات",
    "admin.nav.hr": "الموارد البشرية",
    // Transactions
    "txn.status.pending": "قيد الانتظار", "txn.status.in_progress": "قيد التنفيذ",
    "txn.status.approved": "معتمدة", "txn.status.rejected": "مرفوضة",
    "txn.status.closed": "مغلقة", "txn.status.draft": "مسودة", "txn.status.returned": "مُرجعة",
    "txn.imp.critical": "عاجل", "txn.imp.high": "عالي", "txn.imp.medium": "متوسط", "txn.imp.low": "منخفض",
    "txn.act.approve": "الموافقة", "txn.act.reject": "الرفض",
    "txn.act.return": "الإرجاع", "txn.act.forward": "التحويل", "txn.act.close": "الإغلاق",
    "txn.field.subject": "الموضوع", "txn.field.content": "المحتوى",
    "txn.field.amount": "المبلغ", "txn.field.type": "نوع المعاملة",
    "txn.field.importance": "درجة الأهمية", "txn.field.recipient": "المستلم",
    "txn.field.note": "الملاحظة", "txn.field.attachment": "المرفق",
    "txn.validation.noteRequired": "الملاحظة مطلوبة لهذا الإجراء",
    // Payment
    "pay.method.cash": "نقدي", "pay.method.bank": "تحويل بنكي",
    "pay.method.cheque": "شيك", "pay.method.wire": "حوالة",
    "pay.status.requested": "مطلوب", "pay.status.authorized": "معتمد",
    "pay.status.paid": "مدفوع", "pay.status.closed": "مُقفل",
    "pay.receipt": "إيصال الدفع", "pay.uploadReceipt": "ارفع إيصال الدفع",
    "pay.bankAccount": "الحساب البنكي", "pay.recordPayment": "تسجيل الدفع",

    // ─── V3 Sidebar nav (16 groups) ───
    "nav.home":"الرئيسية", "nav.daily":"العمليات اليومية", "nav.openPOS":"فتح شاشة الكاشير POS",
    "nav.sales":"المبيعات", "nav.shiftsLog":"سجل المناوبات",
    "nav.menuProduction":"المنيو والإنتاج", "nav.menuHub":"إدارة المنيو والبرندات",
    "nav.semiFinished":"المنتجات غير التامة", "nav.bom":"الوصفات (BOM)",
    "nav.productionOrders":"أوامر الإنتاج", "nav.priceLists":"قوائم الأسعار", "nav.categories":"تصنيفات الأصناف",
    "nav.inventory":"المخزون والمستودعات", "nav.stockManagement":"إدارة المخزون والجرد",
    "nav.multiWarehouses":"المستودعات المتعددة", "nav.whHierarchy":"هيكل المستودعات",
    "nav.inventoryMethod":"نوع الجرد وقيمة المخزون", "nav.stockIssues":"إذونات الصرف",
    "nav.wasteEntries":"قيود الهدر", "nav.expiryAlerts":"تنبيهات انتهاء الصلاحية",
    "nav.slowMoving":"أصناف بطيئة الحركة", "nav.turnover":"دوران المخزون",
    "nav.purchasingSuppliers":"المشتريات والموردين", "nav.purchases":"المشتريات",
    "nav.purchaseOrders":"أوامر الشراء", "nav.suppliers":"الموردين",
    "nav.supplierStatement":"كشف حساب مورد",
    "nav.paymentChannels":"إدارة الدفع والقنوات", "nav.paymentMethods":"طرق الدفع",
    "nav.salesChannels":"قنوات البيع", "nav.discounts":"الخصومات", "nav.shiftClose":"إغلاق الشيفت",
    "nav.cashBanks":"النقد والبنوك", "nav.cashOverview":"نظرة عامة",
    "nav.cashBoxes":"الصناديق", "nav.bankAccounts":"البنوك",
    "nav.receipts":"سندات القبض", "nav.payments":"سندات الصرف", "nav.transfers":"التحويلات",
    "nav.expensesCustody":"المصروفات والعهد", "nav.expenses":"المصروفات",
    "nav.custodyUsers":"مسؤولو العهدة", "nav.custodies":"إدارة العهد",
    "nav.custodyApproval":"تأكيد المصروفات", "nav.custodyReports":"تقارير العهد",
    "nav.customersAR":"العملاء والذمم", "nav.customers":"العملاء",
    "nav.customerStatement":"كشف حساب عميل", "nav.arAging":"أعمار ذمم العملاء",
    "nav.apAging":"أعمار ذمم الموردين",
    "nav.accounting":"المحاسبة", "nav.erpDash":"لوحة ERP",
    "nav.coa":"دليل الحسابات", "nav.journals":"القيود المحاسبية",
    "nav.periods":"الفترات المحاسبية", "nav.costCenters":"مراكز التكلفة",
    "nav.financialReports":"التقارير المالية", "nav.reportsHub":"مركز التقارير المالية",
    "nav.section.coreIFRS":"القوائم المالية الأساسية (IFRS)",
    "nav.section.analysis":"التحليل المالي والتشغيلي",
    "nav.section.recoLedger":"التسويات ودفتر الأستاذ",
    "nav.section.taxPurchase":"الضرائب والمشتريات",
    "nav.trialBalance":"ميزان المراجعة", "nav.pnl":"قائمة الدخل الشامل",
    "nav.balanceSheet":"قائمة المركز المالي", "nav.cashFlow":"قائمة التدفقات النقدية",
    "nav.equityChanges":"التغيرات في حقوق الملكية", "nav.finRatios":"المؤشرات والنسب المالية",
    "nav.profitability":"الربحية حسب البُعد", "nav.salesAnalytics":"تحليل المبيعات",
    "nav.salesByChannel":"المبيعات حسب القناة", "nav.discountsGiven":"الخصومات الممنوحة",
    "nav.invValuation":"تقييم المخزون", "nav.wasteAnalytics":"تحليل الهدر",
    "nav.bankRecon":"تسوية البنوك", "nav.glLedger":"دفتر الأستاذ العام",
    "nav.royaltyRecon":"تسوية الفرانشايز", "nav.vatReports":"تقارير الضريبة",
    "nav.purchaseReports":"تقارير المشتريات",
    "nav.zatcaInvoicing":"ZATCA والفوترة الإلكترونية",
    "nav.zatca":"ZATCA — الفواتير المختومة", "nav.creditNotes":"الإشعارات الدائنة/المدينة",
    "nav.organization":"الإدارة العامة", "nav.brandWizard":"معالج براند جديد",
    "nav.companies":"الشركات", "nav.branches":"الفروع",
    "nav.posTerminals":"أجهزة POS", "nav.royaltyRuns":"احتساب الفرانشايز",
    "nav.auditLog":"سجل العمليات",
    "nav.workflow":"المعاملات الإدارية", "nav.wfDashboard":"لوحة المعاملات",
    "nav.wfIncoming":"صندوق الوارد", "nav.wfOutgoing":"صندوق الصادر",
    "nav.wfAll":"جميع المعاملات", "nav.wfOrgTree":"الشجرة الإدارية",
    "nav.wfPositions":"المناصب", "nav.wfTypes":"أنواع المعاملات",
    "nav.wfSteps":"خطوات سير العمل",
    "nav.hr":"الموارد البشرية", "nav.hrDash":"لوحة HR",
    "nav.employees":"الموظفون", "nav.usersPerms":"المستخدمون والصلاحيات",
    "nav.departments":"الأقسام", "nav.attendance":"الحضور والانصراف",
    "nav.workShifts":"الشفتات", "nav.overtime":"الإضافي",
    "nav.exceptions":"الاستثناءات", "nav.leave":"الإجازات",
    "nav.payroll":"الرواتب", "nav.advances":"السلف",
    "nav.settings":"الإعدادات", "nav.legacyReports":"تقارير قديمة"
  },
  en: {
    login: "Login", errLogin: "Login failed",
    sales: "Sales", shift: "Shift:", openShift: "Open Shift", closeShift: "Close Shift", noShift: "No open shift",
    dash: "Dashboard", home: "Home", inventory: "Inventory", users: "Users", reports: "Reports", settings: "Settings",
    emptyCart: "Cart is empty!", checkout: "Checkout", tax: "Tax", total: "Total", searchP: "Search product...",
    success: "Operation successful!", loading: "Processing...",
    cartTitle: "Order Cart", goBack: "Back", viewCart: "View Cart",
    cash: "Cash", card: "Card", kita: "Kita", split: "Split",
    subtotal: "Subtotal:", discount: "Discount:", serviceFee: "Service Fee:",
    totalLabel: "Total:", checkoutBtn: "Complete Payment",
    emptyCartDesc: "Select products from the menu to add",
    qty: "Qty", price: "Price", remove: "Remove", addToCart: "Add to Cart",
    shiftClose: "Close Shift", cashAmount: "Cash Amount", cardAmount: "Card / Network", kitaAmount: "Kita / Credit",
    confirmClose: "Confirm & Close Shift", cancel: "Cancel",
    enterAmounts: "Enter actual drawer amounts:", shiftReport: "Shift Close Report",
    categories: "Categories", allItems: "All", outOfStock: "Out", inStock: "In Stock",

    // ═══ Admin ERP translations ═══
    "admin.dashboard": "Admin Dashboard",
    "admin.save": "Save", "admin.cancel": "Cancel", "admin.delete": "Delete", "admin.edit": "Edit",
    "admin.add": "Add", "admin.search": "Search", "admin.filter": "Filter", "admin.refresh": "Refresh",
    "admin.export": "Export", "admin.import": "Import", "admin.close": "Close", "admin.apply": "Apply",
    "admin.back": "Back", "admin.next": "Next", "admin.prev": "Previous", "admin.submit": "Submit",
    "admin.confirm": "Confirm", "admin.yes": "Yes", "admin.no": "No", "admin.loading": "Loading...",
    "admin.empty": "No data", "admin.error": "Error", "admin.success": "Done",
    "admin.logout": "Logout", "admin.toggleLang": "العربية",
    "admin.nav.menu": "Menu", "admin.nav.warehouse": "Warehouses & Production",
    "admin.nav.purchases": "Purchases", "admin.nav.expenses": "Expenses",
    "admin.nav.custody": "Custody", "admin.nav.shifts": "Shifts",
    "admin.nav.reports": "Reports", "admin.nav.settings": "Settings",
    "admin.nav.erp": "ERP System", "admin.nav.accounting": "Accounting",
    "admin.nav.customers": "Customers & Suppliers", "admin.nav.cashMgmt": "Cash Management",
    "admin.nav.general": "General Admin", "admin.nav.txns": "Transactions",
    "admin.nav.hr": "Human Resources",
    "txn.status.pending": "Pending", "txn.status.in_progress": "In Progress",
    "txn.status.approved": "Approved", "txn.status.rejected": "Rejected",
    "txn.status.closed": "Closed", "txn.status.draft": "Draft", "txn.status.returned": "Returned",
    "txn.imp.critical": "Critical", "txn.imp.high": "High", "txn.imp.medium": "Medium", "txn.imp.low": "Low",
    "txn.act.approve": "Approve", "txn.act.reject": "Reject",
    "txn.act.return": "Return", "txn.act.forward": "Forward", "txn.act.close": "Close",
    "txn.field.subject": "Subject", "txn.field.content": "Content",
    "txn.field.amount": "Amount", "txn.field.type": "Transaction Type",
    "txn.field.importance": "Importance", "txn.field.recipient": "Recipient",
    "txn.field.note": "Note", "txn.field.attachment": "Attachment",
    "txn.validation.noteRequired": "Note is required for this action",
    "pay.method.cash": "Cash", "pay.method.bank": "Bank Transfer",
    "pay.method.cheque": "Cheque", "pay.method.wire": "Wire",
    "pay.status.requested": "Requested", "pay.status.authorized": "Authorized",
    "pay.status.paid": "Paid", "pay.status.closed": "Closed",
    "pay.receipt": "Payment Receipt", "pay.uploadReceipt": "Upload Payment Receipt",
    "pay.bankAccount": "Bank Account", "pay.recordPayment": "Record Payment",

    // ─── V3 Sidebar nav (16 groups) — English ───
    "nav.home":"Home", "nav.daily":"Daily Operations", "nav.openPOS":"Open POS Cashier",
    "nav.sales":"Sales", "nav.shiftsLog":"Shifts Log",
    "nav.menuProduction":"Menu & Production", "nav.menuHub":"Menu & Brands",
    "nav.semiFinished":"Semi-Finished Products", "nav.bom":"Recipes (BOM)",
    "nav.productionOrders":"Production Orders", "nav.priceLists":"Price Lists", "nav.categories":"Item Categories",
    "nav.inventory":"Inventory & Warehouses", "nav.stockManagement":"Stock & Stocktake",
    "nav.multiWarehouses":"Multi-Warehouses", "nav.whHierarchy":"Warehouse Hierarchy",
    "nav.inventoryMethod":"Valuation Method", "nav.stockIssues":"Stock Issues",
    "nav.wasteEntries":"Waste Entries", "nav.expiryAlerts":"Expiry Alerts",
    "nav.slowMoving":"Slow-Moving Items", "nav.turnover":"Inventory Turnover",
    "nav.purchasingSuppliers":"Purchasing & Suppliers", "nav.purchases":"Purchases",
    "nav.purchaseOrders":"Purchase Orders", "nav.suppliers":"Suppliers",
    "nav.supplierStatement":"Supplier Statement",
    "nav.paymentChannels":"Payment & Channels", "nav.paymentMethods":"Payment Methods",
    "nav.salesChannels":"Sales Channels", "nav.discounts":"Discounts", "nav.shiftClose":"Shift Close",
    "nav.cashBanks":"Cash & Banks", "nav.cashOverview":"Overview",
    "nav.cashBoxes":"Cash Boxes", "nav.bankAccounts":"Bank Accounts",
    "nav.receipts":"Cash Receipts", "nav.payments":"Cash Payments", "nav.transfers":"Transfers",
    "nav.expensesCustody":"Expenses & Custody", "nav.expenses":"Expenses",
    "nav.custodyUsers":"Custody Users", "nav.custodies":"Custody Management",
    "nav.custodyApproval":"Expense Approval", "nav.custodyReports":"Custody Reports",
    "nav.customersAR":"Customers & AR", "nav.customers":"Customers",
    "nav.customerStatement":"Customer Statement", "nav.arAging":"AR Aging",
    "nav.apAging":"AP Aging",
    "nav.accounting":"Accounting", "nav.erpDash":"ERP Dashboard",
    "nav.coa":"Chart of Accounts", "nav.journals":"Journal Entries",
    "nav.periods":"Accounting Periods", "nav.costCenters":"Cost Centers",
    "nav.financialReports":"Financial Reports", "nav.reportsHub":"Financial Reports Hub",
    "nav.section.coreIFRS":"Core Financial Statements (IFRS)",
    "nav.section.analysis":"Financial & Operational Analysis",
    "nav.section.recoLedger":"Reconciliations & General Ledger",
    "nav.section.taxPurchase":"Tax & Purchases",
    "nav.trialBalance":"Trial Balance", "nav.pnl":"Income Statement",
    "nav.balanceSheet":"Balance Sheet", "nav.cashFlow":"Cash Flow Statement",
    "nav.equityChanges":"Statement of Equity Changes", "nav.finRatios":"Financial Ratios & KPIs",
    "nav.profitability":"Profitability by Dimension", "nav.salesAnalytics":"Sales Analytics",
    "nav.salesByChannel":"Sales by Channel", "nav.discountsGiven":"Discounts Given",
    "nav.invValuation":"Inventory Valuation", "nav.wasteAnalytics":"Waste Analytics",
    "nav.bankRecon":"Bank Reconciliation", "nav.glLedger":"General Ledger",
    "nav.royaltyRecon":"Franchise Reconciliation", "nav.vatReports":"VAT Reports",
    "nav.purchaseReports":"Purchase Reports",
    "nav.zatcaInvoicing":"ZATCA & E-Invoicing",
    "nav.zatca":"ZATCA — Stamped Invoices", "nav.creditNotes":"Credit/Debit Notes",
    "nav.organization":"Organization", "nav.brandWizard":"New Brand Wizard",
    "nav.companies":"Companies", "nav.branches":"Branches",
    "nav.posTerminals":"POS Terminals", "nav.royaltyRuns":"Franchise Calculation",
    "nav.auditLog":"Audit Log",
    "nav.workflow":"Workflow", "nav.wfDashboard":"Workflow Dashboard",
    "nav.wfIncoming":"Inbox", "nav.wfOutgoing":"Outbox",
    "nav.wfAll":"All Transactions", "nav.wfOrgTree":"Org Tree",
    "nav.wfPositions":"Positions", "nav.wfTypes":"Transaction Types",
    "nav.wfSteps":"Workflow Steps",
    "nav.hr":"Human Resources", "nav.hrDash":"HR Dashboard",
    "nav.employees":"Employees", "nav.usersPerms":"Users & Permissions",
    "nav.departments":"Departments", "nav.attendance":"Attendance",
    "nav.workShifts":"Work Shifts", "nav.overtime":"Overtime",
    "nav.exceptions":"Exceptions", "nav.leave":"Leave Requests",
    "nav.payroll":"Payroll", "nav.advances":"Advances",
    "nav.settings":"Settings", "nav.legacyReports":"Legacy Reports"
  }
};
const t = k => (dict[state.lang] && dict[state.lang][k]) || (dict.ar && dict.ar[k]) || k;
// Expose t + dict globally so erp.js + inline code can use them
window.t = t;
window.dict = dict;

// Notifications & Loaders
function loader(showLoader = true) {
  var el = q("#loader");
  if (!el) return;
  if (showLoader) { el.style.display = 'flex'; } else { el.style.display = 'none'; }
}

function showToast(msg, isError = false) {
  const container = q("#toastContainer") || (function() {
    let c = document.createElement("div"); c.id = "toastContainer"; c.className = "toast-container";
    document.body.appendChild(c); return c;
  })();
  const tDiv = document.createElement("div");
  tDiv.className = `toast ${isError ? 'error' : 'success'}`;
  tDiv.innerHTML = `<i class="fas fa-${isError ? 'exclamation-circle' : 'check-circle'}"></i> <span>${msg}</span>`;
  container.appendChild(tDiv);
  setTimeout(() => { tDiv.style.animation = "fadeOut 0.3s ease forwards"; setTimeout(() => tDiv.remove(), 300); }, 3000);
}

// Global API Object (Wrap window._apiBridge for robust error handling)
const api = window._apiBridge || window._apiBridge.withFailureHandler(err => {
  loader(false);
  showToast(err.message || "حدث خطأ غير متوقع بالخادم.", true);
  console.error("GAS Error:", err);
});

// =========================================
// 2. Authentication & Initialization
// =========================================
window.onload = function() {
  applyLang();
  translateUI();

  // Apply cached company branding instantly (logo + name) for fast paint on login
  applyCachedBranding();

  // Refresh branding from server (public — no auth needed)
  fetchPublicBranding();

  // Load cached menu instantly for faster UI
  try {
    var cached = localStorage.getItem("pos_menu_cache");
    if (cached) {
      var c = JSON.parse(cached);
      if (c.menu && c.menu.length && (Date.now() - c.ts) < 3600000) {
        state.menu = c.menu;
        state.categories = [...new Set(c.menu.map(function(i){return i.category;}))];
      }
    }
  } catch(e) {}

  // ─── Silent auto-login from saved JWT ───
  var token = localStorage.getItem("pos_token");
  var saved = localStorage.getItem("pos_session");
  if (token && saved) {
    var savedRole = '';
    try { savedRole = (JSON.parse(saved).role || '').toLowerCase(); } catch(e) {}

    // Cashier session → redirect straight to /pos/
    if (savedRole === 'cashier') {
      window.location.replace('/pos/');
      return;
    }

    // Custody session → redirect straight to /custody/
    if (savedRole === 'custody') {
      window.location.replace('/custody/');
      return;
    }

    // Employee session → redirect straight to /employee/
    if (savedRole === 'employee') {
      window.location.replace('/employee/');
      return;
    }

    // Helper: show login form when auto-login fails
    function _showLoginFallback() {
      localStorage.removeItem("pos_token");
      // Remove has-session from <html> so CSS shows login again
      document.documentElement.classList.remove('has-session');
      loader(false);
    }

    // Admin session → refresh token first, then load template.
    // This ensures even expired tokens get renewed (using saved credentials as fallback).
    function _tryLoadAdmin() {
      fetchAppTemplate()
        .then(function(html) {
          injectAppTemplate(html);
          try {
            var s = JSON.parse(saved);
            state.user = s.user || s.username || '';
            state.role = (s.role || '').toLowerCase();
            if (q("#lUser")) q("#lUser").value = state.user;
          } catch(e) {}
          loadCoreData();
        })
        .catch(function(err) {
          // Token invalid and can't refresh → show login
          _showLoginFallback();
        });
    }

    // Try refreshing token first, then load
    fetch('/api/auth/refresh-token', {
      method: 'POST', headers: {'Content-Type':'application/json','Authorization':'Bearer '+token}
    }).then(function(r){return r.json();}).then(function(res) {
      if (res.success && res.token) localStorage.setItem('pos_token', res.token);
      _tryLoadAdmin();
    }).catch(function() { _tryLoadAdmin(); });
    return;
  }

  loader(false);
};

function applyLang() {
  // Toggle only lang-specific classes — do NOT overwrite body.className
  // or we'd wipe the 'authenticated' class and re-engage the auth gate.
  document.body.classList.remove('ar', 'en');
  document.body.classList.add(state.lang);
  const htmlEl = document.documentElement;
  if (state.lang === 'ar') {
    htmlEl.setAttribute('lang', 'ar');
    htmlEl.setAttribute('dir', 'rtl');
  } else {
    htmlEl.setAttribute('lang', 'en');
    htmlEl.setAttribute('dir', 'ltr');
  }
}

function toggleLang() {
  state.lang = state.lang === "ar" ? "en" : "ar";
  localStorage.setItem("pos_lang", state.lang);
  applyLang();
  // Translate all data-i18n elements
  translateUI();
  // Re-render current view elements without reloading
  renderPayButtons();
  updateShiftUI();
  renderMenuGrid();
  updateCart();
  showToast(state.lang === 'ar' ? 'تم التحويل للعربية' : 'Switched to English');
}

function translateUI() {
  // text nodes
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const val = t(key);
    if (val) el.textContent = val;
  });
  // placeholder attributes (inputs)
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    const val = t(key);
    if (val) el.setAttribute('placeholder', val);
  });
  // title attributes (tooltips)
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.getAttribute('data-i18n-title');
    const val = t(key);
    if (val) el.setAttribute('title', val);
  });
  // HTML variant (supports nested icons + bold tags)
  document.querySelectorAll('[data-i18n-html]').forEach(el => {
    const key = el.getAttribute('data-i18n-html');
    const icon = el.getAttribute('data-i18n-icon') || '';
    const val = t(key);
    if (val) el.innerHTML = (icon ? '<i class="' + icon + '"></i> ' : '') + val;
  });
  // Update document title (if set)
  var titleKey = document.documentElement.getAttribute('data-i18n-title');
  if (titleKey) { try { document.title = t(titleKey); } catch(e) {} }
}
window.translateUI = translateUI;

// =========================================
// Branding (Logo + Company Name)
// =========================================
function applyCachedBranding() {
  try {
    var cached = localStorage.getItem('pos_branding');
    if (cached) {
      var b = JSON.parse(cached);
      if (b.name) state.settings.name = b.name;
      if (b.logo) state.settings.logo = b.logo;
      applyBrandingToUI(b.name, b.logo);
    }
  } catch (e) {}
}

function fetchPublicBranding() {
  // Public endpoint — no auth needed
  fetch('/api/settings').then(function(r) { return r.json(); }).then(function(s) {
    if (!s) return;
    var name = s.name || s.CompanyName || 'Moroccan Taste';
    var logo = s.logo || s.Logo || '';
    state.settings.name = name;
    state.settings.logo = logo;
    try { localStorage.setItem('pos_branding', JSON.stringify({ name: name, logo: logo })); } catch (e) {}
    applyBrandingToUI(name, logo);
  }).catch(function() {});
}

function applyBrandingToUI(name, logo) {
  // Login screen
  var loginName = document.getElementById('loginCompanyName');
  if (loginName && name) loginName.textContent = name;
  var loginLogoBox = document.getElementById('loginLogoBox');
  if (loginLogoBox) {
    if (logo) {
      loginLogoBox.innerHTML = '<img src="' + logo + '" alt="logo">';
    } else {
      loginLogoBox.innerHTML = '<span class="login-logo-fallback">&#9749;</span>';
    }
  }
  // Sidebar (admin)
  var sbName = document.getElementById('sidebarBrandName');
  if (sbName && name) sbName.textContent = name;
  var sbBrand = document.getElementById('sidebarBrand');
  if (sbBrand && logo) {
    sbBrand.innerHTML = '<img src="' + logo + '" class="brand-logo-img" alt="logo"> <span id="sidebarBrandName">' + name + '</span>';
  }
  // POS header
  var pbName = document.getElementById('posBrandName');
  if (pbName && name) pbName.textContent = name;
  var pbBrand = document.getElementById('posBrand');
  if (pbBrand && logo) {
    pbBrand.innerHTML = '<img src="' + logo + '" class="brand-logo-img" alt="logo"> <span id="posBrandName">' + name + '</span>';
  }
  // Settings preview (if open)
  var setLogoPrev = document.getElementById('setLogoPreview');
  if (setLogoPrev && logo) {
    setLogoPrev.innerHTML = '<img src="' + logo + '" style="width:100%;height:100%;object-fit:cover;">';
  }
  var setName = document.getElementById('setCompany');
  if (setName && name && !setName.value) setName.value = name;
}

// Resize uploaded image to ≤200x200 JPEG (~30KB) so it fits in TEXT column
function handleLogoUpload(input) {
  var file = input.files && input.files[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) return showToast('يرجى اختيار ملف صورة', true);

  var reader = new FileReader();
  reader.onload = function(e) {
    var img = new Image();
    img.onload = function() {
      var MAX = 200;
      var w = img.width, h = img.height;
      if (w > h) {
        if (w > MAX) { h = Math.round(h * MAX / w); w = MAX; }
      } else {
        if (h > MAX) { w = Math.round(w * MAX / h); h = MAX; }
      }
      var canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      // Try JPEG first (smaller), fallback to PNG if transparent matters
      var dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      // Show preview immediately
      var prev = document.getElementById('setLogoPreview');
      if (prev) prev.innerHTML = '<img src="' + dataUrl + '" style="width:100%;height:100%;object-fit:cover;">';
      // Stash in state — saved when user clicks "Save Settings"
      state.settings.logo = dataUrl;
      showToast('تم تحميل الشعار — اضغط حفظ الإعدادات لاعتماده');
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function removeLogo() {
  if (!confirm('هل تريد إزالة شعار الشركة؟')) return;
  state.settings.logo = '';
  var prev = document.getElementById('setLogoPreview');
  if (prev) prev.innerHTML = '<i class="fas fa-image" style="color:#cbd5e1;font-size:28px;"></i>';
  showToast('سيتم إزالة الشعار عند الحفظ');
}

function doLogin() {
  const u = q("#lUser").value.trim();
  const p = q("#lPass").value.trim();
  if (!u || !p) return showToast("يرجى إدخال اسم المستخدم وكلمة المرور", true);

  loader(true);
  api.withSuccessHandler(res => {
    if (!res.success) { loader(false); showToast(res.error, true); return; }
    state.user = res.username;
    state.role = res.role.toLowerCase();

    // Save token for secured API calls and templates
    localStorage.setItem("pos_token", res.token);

    // Save session (NO password — only user + role for session restore)
    localStorage.setItem("pos_session", JSON.stringify({ user: u, username: u, role: state.role }));
    localStorage.setItem("pos_last_view", state.role === 'cashier' ? 'pos' : state.role === 'custody' ? 'custody' : state.role === 'employee' ? 'employee' : 'admin');

    // ─── Cashier → redirect to /pos/ ───
    if (state.role === 'cashier') {
      window.location.replace('/pos/');
      return;
    }

    // ─── Custody → redirect to /custody/ ───
    if (state.role === 'custody') {
      window.location.replace('/custody/');
      return;
    }

    // ─── Employee → redirect to /employee/ ───
    if (state.role === 'employee') {
      window.location.replace('/employee/');
      return;
    }

    // ─── Admin → hide login immediately, then fetch template ───
    document.documentElement.classList.add('has-session');
    fetchAppTemplate()
      .then(injectAppTemplate)
      .then(function() { loadCoreData(); })
      .catch(function(err) {
        loader(false);
        if (err.message === 'UNAUTHORIZED') {
          localStorage.removeItem('pos_token');
          showToast('فشل التحقق من الجلسة، حاول مرة أخرى', true);
        } else {
          showToast('فشل تحميل التطبيق: ' + err.message, true);
        }
      });
  }).checkLogin(u, p);
}

function loadCoreData() {
  // Show cached menu instantly while API loads (faster mobile experience)
  try {
    var cached = localStorage.getItem("pos_menu_cache");
    if (cached) {
      var c = JSON.parse(cached);
      if (c.menu && c.menu.length && (Date.now() - c.ts) < 3600000) {
        state.menu = c.menu;
        state.categories = [...new Set(state.menu.map(i => i.category))];
      }
    }
  } catch(e) {}

  api.withSuccessHandler(res => {
    loader(false);
    if (res.error) return showToast(res.error, true);

    state.settings = res.settings;
    if (q("#setCompany")) q("#setCompany").value = res.settings.name || "";
    if (q("#setTax")) q("#setTax").value = res.settings.taxNumber || "";
    // Apply branding (logo + name) to UI + cache
    try { localStorage.setItem('pos_branding', JSON.stringify({ name: res.settings.name || '', logo: res.settings.logo || '' })); } catch(e) {}
    applyBrandingToUI(res.settings.name, res.settings.logo);

    state.kitaFeeRate = Number(res.kitaFeeRate) || 0;
    if (q("#setKitaFee")) q("#setKitaFee").value = state.kitaFeeRate;

    // Payment methods
    state.paymentMethods = res.paymentMethods || [];
    renderPayButtons();

    state.menu = res.menu || [];
    state.categories = [...new Set(state.menu.map(i => i.category))];
    state.activeShiftId = res.activeShiftId || "";
    state.users = (res.usernames || []).map(u => ({ username: u }));

    // Current user info (display name + developer flag)
    state.currentUser = res.currentUser || { username: state.user, displayName: '', role: state.role, isDeveloper: state.role === 'admin' };
    state.isDeveloper = !!state.currentUser.isDeveloper;
    // user → display name lookup map (used by report renderers)
    state.userMeta = res.userMeta || {};
    state.userDisplayMap = {};
    Object.keys(state.userMeta).forEach(function(u) {
      if (state.userMeta[u] && state.userMeta[u].name) state.userDisplayMap[u] = state.userMeta[u].name;
    });

    // Cache menu in localStorage
    try { localStorage.setItem("pos_menu_cache", JSON.stringify({ ts: Date.now(), menu: state.menu })); } catch(e) {}

    // Template was already fetched + injected BEFORE loadCoreData was called
    // (by doLogin or window.onload). Just initialize the views now.
    updateShiftUI();
    initViews();
  }).getInitialAppData(state.user);
}

function initViews() {
  // Authenticated — release the critical CSS gate so the rest of the page can render
  document.body.classList.add('authenticated');
  hide("#loginView");

  // Cashier role → redirect to the standalone /pos/ page
  if (state.role === 'cashier') {
    localStorage.setItem("pos_last_view", 'pos');
    window.location.replace('/pos/');
    return;
  }

  // Custody role → redirect to lightweight /custody/ page
  if (state.role === 'custody') {
    localStorage.setItem("pos_last_view", 'custody');
    window.location.replace('/custody/');
    return;
  }

  // Employee role: no redirect — portal is fully independent at /employee/

  // Admin/Manager/Employee → show admin panel
  localStorage.setItem("pos_last_view", 'admin');
  show("#adminView");
  if (q("#adminUserLabel")) q("#adminUserLabel").innerText = state.user;

  {
    // Admin/manager → restore last section or default to home
    var lastSection = localStorage.getItem("pos_last_section") || 'home';
    if (lastSection.indexOf('erp:') === 0) {
      // ERP section — load ERP nav
      var erpSec = lastSection.substring(4);
      if (typeof erpNav === 'function') {
        try { erpNav(erpSec); } catch(e) { nav('home'); }
      } else { nav('home'); }
    } else {
      nav(lastSection);
    }
  }
  // Use usernames already loaded from getInitialAppData (no extra API call)
  const users = (state.users || []).map(u => u.username);
  const selectors = ['#repUserOpt', '#fsCashier', '#fpayCashier'];
  selectors.forEach(sel => {
    const el = q(sel);
    if (el) {
      el.innerHTML = '<option value="">\u0627\u0644\u0643\u0644</option>';
      users.forEach(u => { el.innerHTML += `<option value="${u}">${u}</option>`; });
    }
  });
}

// POS is no longer embedded in the admin interface. viewPOS redirects to the
// standalone /pos/ page which has its own auth gate + lightweight assets.
function viewPOS() { window.location.replace('/pos/'); }
function viewAdmin() { if (state.role === "admin") { show("#adminView"); nav('home'); } }

function logout() {
  // Clear ALL session data
  localStorage.removeItem("pos_session");
  localStorage.removeItem("pos_token");
  localStorage.removeItem("pos_active_shift_id");
  localStorage.removeItem("pos_last_view");
  localStorage.removeItem("pos_last_section");

  // Full page reload to / — cleanest way to reset everything
  window.location.replace('/');
}

// =========================================
// Session Management — Activity tracking + Auto-refresh + Inactivity timeout
// =========================================
(function() {
  var INACTIVITY_LIMIT = 15 * 60 * 1000; // 15 minutes
  var REFRESH_INTERVAL = 10 * 60 * 1000; // 10 minutes
  var CHECK_INTERVAL = 30 * 1000;        // check every 30 seconds
  var lastActivity = Date.now();

  // Track user activity
  ['click', 'keydown', 'scroll', 'mousemove', 'touchstart'].forEach(function(evt) {
    document.addEventListener(evt, function() { lastActivity = Date.now(); }, { passive: true });
  });

  // Check inactivity every 30 seconds
  setInterval(function() {
    var token = localStorage.getItem('pos_token');
    if (!token) return; // not logged in
    var idle = Date.now() - lastActivity;
    if (idle >= INACTIVITY_LIMIT) {
      // Auto-logout due to inactivity
      if (typeof logout === 'function') {
        logout();
        showToast('تم تسجيل الخروج تلقائياً بسبب عدم النشاط', true);
      }
    }
  }, CHECK_INTERVAL);

  // Refresh token every 10 minutes (only if user is active)
  setInterval(function() {
    var token = localStorage.getItem('pos_token');
    if (!token) return;
    var idle = Date.now() - lastActivity;
    if (idle < INACTIVITY_LIMIT && window._apiBridge) {
      window._apiBridge.withSuccessHandler(function(r) {
        if (r && r.success && r.token) {
          localStorage.setItem('pos_token', r.token);
        }
      }).refreshToken();
    }
  }, REFRESH_INTERVAL);
})();

// =========================================
// 3. Modals Management
// =========================================
function openModal(id) { show(id); setTimeout(() => q(id).classList.add("show"), 10); }
function closeModal(id) { q(id).classList.remove("show"); setTimeout(() => hide(id), 300); }

// ─── Glass modal helpers (replace native confirm/alert) ───
function openGlassModal(id) {
  var m = q(id); if (!m) return;
  m.classList.remove('hidden');
  void m.offsetWidth;
  m.classList.add('show');
}
function closeGlassModal(id, result) {
  var m = q(id); if (!m) return;
  m.classList.remove('show');
  setTimeout(function() {
    m.classList.add('hidden');
    if (id === '#modalGlassConfirm' && typeof state._gcResolve === 'function') {
      var cb = state._gcResolve; state._gcResolve = null;
      cb(!!result);
    }
  }, 250);
}
function glassConfirm(title, message, opts) {
  opts = opts || {};
  var tEl = q('#gcTitle'); var mEl = q('#gcMessage'); var actions = q('#gcActions');
  if (tEl) tEl.innerHTML = '<i class="fas ' + (opts.danger ? 'fa-exclamation-triangle' : 'fa-question-circle') + '"></i> ' + title;
  if (mEl) mEl.textContent = message;
  if (actions) {
    var okClass = opts.danger ? 'btn-danger' : 'btn-primary';
    actions.innerHTML =
      '<button class="btn btn-light" onclick="closeGlassModal(\'#modalGlassConfirm\', false)">' + (opts.cancelText || 'إلغاء') + '</button>' +
      '<button class="btn ' + okClass + '" onclick="closeGlassModal(\'#modalGlassConfirm\', true)">' + (opts.okText || 'تأكيد') + '</button>';
  }
  return new Promise(function(resolve) {
    state._gcResolve = resolve;
    openGlassModal('#modalGlassConfirm');
  });
}
function glassAlert(title, message, opts) {
  opts = opts || {};
  var tEl = q('#gcTitle'); var mEl = q('#gcMessage'); var actions = q('#gcActions');
  if (tEl) tEl.innerHTML = '<i class="fas ' + (opts.danger ? 'fa-exclamation-circle' : 'fa-info-circle') + '"></i> ' + title;
  if (mEl) mEl.textContent = message;
  if (actions) actions.innerHTML = '<button class="btn btn-primary" onclick="closeGlassModal(\'#modalGlassConfirm\', true)" style="flex:1;">حسناً</button>';
  return new Promise(function(resolve) {
    state._gcResolve = resolve;
    openGlassModal('#modalGlassConfirm');
  });
}
window.onclick = function(e) { if (e.target.classList.contains('modal')) { closeModal('#' + e.target.id); } }

// Refresh the active admin section whenever the user returns to this tab.
// Solves the "dashboard didn't update after I sold from another window" issue.
document.addEventListener('visibilitychange', function() {
  if (document.visibilityState !== 'visible') return;
  if (typeof refreshActiveAdminSection === 'function') refreshActiveAdminSection();
});

// =========================================
// 4. POS (Cashier) Logic
// =========================================
function updateShiftUI() {
  // #shiftBadge lives only inside the old #posView (now removed from the
  // admin template). In the admin-only layout this element doesn't exist,
  // so bail out quietly instead of crashing on null.
  const badge = q("#shiftBadge");
  if (!badge) return;
  if (state.activeShiftId) {
    badge.innerText = state.activeShiftId;
    badge.className = "shift-indicator active";
  } else {
    badge.innerText = t("noShift");
    badge.className = "shift-indicator";
  }
}

function setPosCat(cat) {
  state.activeCat = cat;
  renderMenuGrid();
}

function renderMenuGrid() {
  // The POS grid containers (#posCatTabs, #posItemsGrid) only exist inside
  // #posView which was removed from the admin template. Bail out quietly if
  // either container is missing — admin code paths may still call this.
  const catTabsEl = q("#posCatTabs");
  const itemsGridEl = q("#posItemsGrid");
  if (!catTabsEl || !itemsGridEl) return;

  // Render Categories Tabs
  let catHtml = `<div class="cat-pill ${!state.activeCat ? 'active' : ''}" onclick="setPosCat('')">الكل</div>`;
  state.categories.forEach(c => catHtml += `<div class="cat-pill ${state.activeCat === c ? 'active' : ''}" onclick="setPosCat('${c}')">${c}</div>`);
  catTabsEl.innerHTML = catHtml;

  // Render Items — explicit ± buttons (no full-card click)
  const searchTerm = (q("#posSearchInput") ? q("#posSearchInput").value : '').toLowerCase();
  let list = state.menu.filter(i => i.active);
  if (state.activeCat) list = list.filter(i => i.category === state.activeCat);
  if (searchTerm) list = list.filter(i => (i.name || '').toLowerCase().includes(searchTerm) || String(i.id || '').toLowerCase().includes(searchTerm));

  let h = "";
  list.forEach(i => {
    const inCart = state.cart.find(c => c.id === i.id);
    const qty = inCart ? inCart.qty : 0;
    const isSel = !!inCart;
    // The menu no longer has its own stock — hide the stock badge entirely.
    const safeJson = JSON.stringify(i).replace(/'/g, "&#39;");
    h += `<div class="pos-item ${isSel ? 'selected' : ''}">
      <div>
        <div class="pos-item-name">${i.name}</div>
        <div class="pos-item-price">${formatVal(i.price)}</div>
      </div>
      <div class="pos-item-actions">
        <button class="qty-btn" ${qty <= 0 ? 'disabled' : ''} onclick="decFromCart('${i.id}')" aria-label="تقليل">−</button>
        <div class="qty-display">${qty}</div>
        <button class="qty-btn add" onclick='addToCart(${safeJson})' aria-label="إضافة">+</button>
      </div>
    </div>`;
  });
  if (!list.length) {
    h = '<div style="grid-column:1/-1;text-align:center;padding:50px 20px;color:#94a3b8;"><i class="fas fa-box-open" style="font-size:54px;margin-bottom:14px;display:block;opacity:0.35;"></i><div style="font-weight:700;">لا توجد منتجات</div></div>';
  }
  itemsGridEl.innerHTML = h;
}

function addToCart(item) {
  let found = state.cart.find(c => c.id === item.id);
  if (found) {
    found.qty++;
  } else {
    state.cart.push({ ...item, qty: 1, basePrice: item.price });
  }
  updateCart();
}

// Decrement an item from the cart by id (called by the − button on a product card)
function decFromCart(itemId) {
  var idx = state.cart.findIndex(function(c) { return String(c.id) === String(itemId); });
  if (idx === -1) return;
  state.cart[idx].qty -= 1;
  if (state.cart[idx].qty <= 0) state.cart.splice(idx, 1);
  updateCart();
}

function modQty(idx, delta) {
  state.cart[idx].qty += delta;
  if (state.cart[idx].qty <= 0) state.cart.splice(idx, 1);
  updateCart();
}

function editCartPrice(idx, newPrice) {
  state.cart[idx].price = Number(newPrice) || 0;
  updateCart();
}

function clearCart() { state.cart = []; state.currentDiscount = { name: "", amount: 0 }; updateCart(); }

function updateCart() {
  // POS-only DOM — these elements live only inside the removed #posView.
  // In the admin-only layout they don't exist; bail out quietly.
  const payInput = q("#posPayMethod");
  const cartItemsEl = q("#cartItemsArea");
  if (!payInput || !cartItemsEl) return;

  const payMethod = payInput.value;
  let subtotal = 0;
  
  if (payMethod !== "Kita") {
    state.cart.forEach(c => c.price = c.basePrice);
  }

  let h = "";
  state.cart.forEach((c, idx) => {
    subtotal += c.qty * c.price;
    const priceEditEl = payMethod === "Kita" 
      ? `<input type="number" step="0.01" value="${c.price}" class="price-edit-input" onchange="editCartPrice(${idx}, this.value)">` 
      : `${formatVal(c.price)}`;
      
    h += `<div class="cart-item-row">
      <div class="cart-item-info">
        <div class="cart-item-title">${c.name}</div>
        <div class="cart-item-total">${formatVal(c.qty * c.price)}</div>
      </div>
      <div class="cart-item-actions">
        <div class="qty-control">
          <button class="qty-btn" onclick="modQty(${idx}, 1)">+</button>
          <div class="qty-val">${c.qty}</div>
          <button class="qty-btn" onclick="modQty(${idx}, -1)">-</button>
        </div>
        <div>
          <span style="font-size:12px; font-weight:bold; color:var(--text-light); margin-right:10px;">@ ${priceEditEl}</span>
          <button class="btn btn-danger" style="padding:6px 12px; border-radius:10px;" onclick="state.cart.splice(${idx},1); updateCart();"><i class="fas fa-trash"></i></button>
        </div>
      </div>
    </div>`;
  });

  if (state.cart.length === 0) {
    h = `<div class="cart-empty"><i class="fas fa-shopping-basket"></i><h3>${t('emptyCart')}</h3><p style="font-size:14px; margin-top:5px;">${t('emptyCartDesc')}</p></div>`;
  }
  q("#cartItemsArea").innerHTML = h;

  if (state.currentDiscount.amount > subtotal) state.currentDiscount.amount = subtotal;
  const afterDiscount = subtotal - state.currentDiscount.amount;
  
  // Calculate service fee for selected payment method
  let serviceFee = 0;
  let finalTotal = afterDiscount;
  var feeRow = q("#serviceFeeRow");
  var feeInput = q("#serviceFeeInput");
  var selectedPM = (state.paymentMethods||[]).find(function(m){return m.Name===payMethod;});
  var feeRate = selectedPM ? Number(selectedPM.ServiceFeeRate)||0 : (payMethod==='Kita'?state.kitaFeeRate:0);
  var showFee = payMethod !== 'Split' && payMethod !== 'Cash' && payMethod !== 'Card';
  if (showFee) {
    // Use manual input if filled, otherwise auto-calculate from rate
    var manualFee = feeInput ? Number(feeInput.value) : 0;
    if (manualFee > 0) {
      serviceFee = manualFee;
    } else if (feeRate > 0) {
      serviceFee = afterDiscount * (feeRate / 100);
    }
    finalTotal = afterDiscount + serviceFee;
    if (feeRow) feeRow.classList.remove("hidden");
    var isEn = state.lang==='en';
    var feeLabel = q("#serviceFeeLabel");
    if (feeLabel) feeLabel.textContent = (isEn?'Service Fee':'رسوم الخدمة') + ' (' + (selectedPM?(isEn?selectedPM.Name:selectedPM.NameAR):payMethod) + '):';
    q("#serviceFeeText").innerText = formatVal(serviceFee) + (feeRate>0 && !manualFee ? ' ('+feeRate+'%)' : '');
    if (feeInput && !manualFee && feeRate > 0) feeInput.placeholder = formatVal(serviceFee) + ' (تلقائي '+feeRate+'%)';
  } else {
    if (feeRow) feeRow.classList.add("hidden");
    if (feeInput) { feeInput.value = ''; feeInput.placeholder = '0'; }
  }

  // Split payment panel
  var splitPanel = q("#splitPayPanel");
  if (splitPanel) splitPanel.classList.toggle("hidden", payMethod !== 'Split');
  if (payMethod === 'Split') renderSplitFields(afterDiscount);

  q("#cartSubtotalText").innerText = formatVal(subtotal);
  q("#cartDiscText").innerText = formatVal(state.currentDiscount.amount);
  q("#cartFinalTotal").innerText = formatVal(payMethod==='Split'?afterDiscount:finalTotal) + " " + state.settings.currency;

  // Mobile Cart Updates
  if(q("#mobCartCount")) {
    var mobileCount = state.cart.reduce(function(s,c){return s+c.qty;}, 0);
    q("#mobCartCount").innerText = mobileCount;
    q("#mobCartTotal").innerText = formatVal(finalTotal) + " " + state.settings.currency;
  }

  // Highlight active pay method
  qs(".pay-btn").forEach(function(btn){btn.classList.remove("active");});
  var activeBtn = q("#payBtn"+payMethod);
  if (activeBtn) activeBtn.classList.add("active");

  renderMenuGrid();
}

// Mobile Cart Toggle
function toggleMobileCart() {
  const cartPanel = q("#mobileCartPanel");
  if (cartPanel) {
    cartPanel.classList.toggle("open");
  }
}

function setPayMethod(m) {
  q("#posPayMethod").value = m;
  var feeInput = q("#serviceFeeInput");
  if (feeInput) feeInput.value = '';
  updateCart();
}
function applyManualServiceFee() { updateCart(); }

// ─── Render dynamic pay buttons from state.paymentMethods + always-on Split feature ───
function renderPayButtons() {
  var container = q("#payMethodsContainer");
  if (!container) return;
  // Filter out inactive methods AND any "Split" entry from the saved methods —
  // Split is rendered as a fixed feature, not a saved method.
  var active = (state.paymentMethods || []).filter(function(m) {
    if (m.IsActive === false || m.IsActive === 'FALSE') return false;
    var n = String(m.Name || '').toLowerCase();
    return n !== 'split';
  });
  if (!active.length) {
    // Fallback minimum so the cart isn't broken
    active = [{ Name: 'Cash', NameAR: 'كاش', Icon: 'fa-money-bill-wave' }];
  }
  var isEn = state.lang === 'en';
  var defaultMethod = active[0].Name;
  var hiddenInput = '<input type="hidden" id="posPayMethod" value="' + defaultMethod + '">';

  var html = active.map(function(m) {
    var label = isEn ? (m.Name || m.NameAR) : (m.NameAR || m.Name);
    return '<button class="pay-btn' + (m.Name === defaultMethod ? ' active' : '') + '" id="payBtn' + m.Name + '" onclick="setPayMethod(\'' + m.Name + '\')"><i class="fas ' + (m.Icon || 'fa-money-bill') + '"></i> <span>' + label + '</span></button>';
  }).join('');

  // Always-on Split feature button
  html += '<button class="pay-btn" id="payBtnSplit" onclick="setPayMethod(\'Split\')" title="' + (isEn ? 'Split payment between methods' : 'تجزئة الدفع بين أكثر من وسيلة') + '"><i class="fas fa-divide"></i> <span>' + (isEn ? 'Split' : 'تجزئة') + '</span></button>';

  container.innerHTML = html + hiddenInput;
}

// ─── Split payment fields ───
function renderSplitFields(total) {
  var container = q("#splitFields");
  if (!container) return;
  var isEn = state.lang === 'en';
  var methods = (state.paymentMethods||[]).filter(function(m){ return m.IsActive!==false && m.IsActive!=='FALSE' && m.Name!=='Split'; });
  container.innerHTML = methods.map(function(m){
    var label = isEn ? (m.Name||m.NameAR) : (m.NameAR||m.Name);
    return '<div style="margin-bottom:4px;"><label style="font-size:12px;font-weight:600;">'+label+'</label><input type="number" step="0.01" class="form-control split-input" data-method="'+m.Name+'" placeholder="0.00" value="" oninput="calcSplitRemaining()" style="padding:8px;font-size:14px;"></div>';
  }).join('');
  q("#splitRemaining").textContent = formatVal(total);
}
function calcSplitRemaining() {
  var sub = state.cart.reduce(function(s,c){return s+c.qty*c.price;},0);
  var afterDiscount = sub - state.currentDiscount.amount;
  var paid = 0;
  qs(".split-input").forEach(function(el){ paid += Number(el.value)||0; });
  var rem = afterDiscount - paid;
  var el = q("#splitRemaining");
  if (el) { el.textContent = formatVal(rem); el.style.color = Math.abs(rem)<0.01 ? '#16a34a' : '#ef4444'; }
}

// ─── Payment methods settings ───
function loadPayMethodsSettings() {
  var container = q("#payMethodsSettings");
  if (!container) return;
  var methods = state.paymentMethods||[];
  if (!methods.length) { container.innerHTML = '<p style="color:#94a3b8;">لا توجد طرق دفع</p>'; return; }
  container.innerHTML = methods.map(function(m,i){
    var checked = (m.IsActive!==false && m.IsActive!=='FALSE') ? 'checked' : '';
    return '<div style="display:flex;gap:10px;align-items:center;background:#f8fafc;padding:10px 12px;border-radius:10px;border:1px solid #e2e8f0;margin-bottom:8px;">'+
      '<input type="checkbox" class="pm-active" data-idx="'+i+'" '+checked+' style="width:18px;height:18px;">'+
      '<i class="fas '+(m.Icon||'fa-money-bill')+'" style="color:var(--accent);width:20px;cursor:pointer;" onclick="promptPMIcon('+i+')"></i>'+
      '<input type="text" class="form-control pm-name-ar" data-idx="'+i+'" value="'+(m.NameAR||'')+'" style="flex:1;padding:6px 10px;" placeholder="الاسم بالعربي">'+
      '<div style="width:100px;"><label style="font-size:10px;color:#64748b;">الاسم EN</label><input type="text" class="form-control pm-name-en" data-idx="'+i+'" value="'+(m.Name||'')+'" style="padding:6px 10px;" placeholder="English"></div>'+
      '<div style="width:100px;"><label style="font-size:10px;color:#64748b;">رسوم %</label><input type="number" step="0.1" class="form-control pm-fee" data-idx="'+i+'" value="'+(Number(m.ServiceFeeRate)||0)+'" style="padding:6px 10px;"></div>'+
      '<button class="btn-icon text-red" onclick="removePM('+i+')" title="حذف"><i class="fas fa-trash"></i></button>'+
    '</div>';
  }).join('') + '<button class="btn btn-sm btn-success" style="width:100%;margin-top:8px;" onclick="addNewPM()"><i class="fas fa-plus"></i> إضافة طريقة دفع جديدة</button>';
}
function addNewPM() {
  // Don't pre-assign an ID — let the backend AUTO_INCREMENT it on INSERT.
  state.paymentMethods.push({ Name: 'NewMethod', NameAR: 'طريقة جديدة', Icon: 'fa-money-bill', IsActive: true, ServiceFeeRate: 0, SortOrder: state.paymentMethods.length + 1 });
  loadPayMethodsSettings();
  renderPayButtons();
}
function removePM(idx) {
  var m = state.paymentMethods[idx];
  if (!m) return;
  if (!confirm('حذف طريقة الدفع "' + (m.NameAR || m.Name || '') + '"؟')) return;

  // If the method has an ID, delete it from the DB immediately so it doesn't reappear on reload
  if (m.ID) {
    loader();
    api.withFailureHandler(function(err) { loader(false); showToast('فشل الحذف: ' + err.message, true); })
       .withSuccessHandler(function(r) {
          loader(false);
          if (r && r.success) {
            state.paymentMethods.splice(idx, 1);
            loadPayMethodsSettings();
            renderPayButtons();        // refresh the cart pay buttons immediately
            showToast('تم حذف طريقة الدفع');
          } else {
            showToast((r && r.error) || 'فشل الحذف', true);
          }
       }).deletePaymentMethod(m.ID);
  } else {
    // New unsaved method — just remove locally
    state.paymentMethods.splice(idx, 1);
    loadPayMethodsSettings();
    renderPayButtons();
    showToast('تم حذف طريقة الدفع');
  }
}
function promptPMIcon(idx) {
  var icon = prompt('أدخل اسم أيقونة FontAwesome (مثال: fa-wallet, fa-mobile, fa-coins):', state.paymentMethods[idx].Icon||'fa-money-bill');
  if (icon) { state.paymentMethods[idx].Icon = icon; loadPayMethodsSettings(); }
}

// ═══════════════════════════════════════
// Advanced Payment Method Modal
// ═══════════════════════════════════════
function openAdvancedPMModal(data) {
  var d = data || {};
  var isEdit = !!d.id;
  var h = '<div class="modal-content modal-large"><div class="modal-title">' + (isEdit ? 'تعديل' : 'إضافة') + ' طريقة دفع<button class="modal-close" onclick="closeModal(\'#modalAdvPM\')">&times;</button></div>' +
    '<input type="hidden" id="apmId" value="' + (d.id||'') + '">' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
      '<div class="form-group"><label class="form-label">الاسم EN *</label><input type="text" id="apmName" class="form-control" value="' + (d.name||'') + '"></div>' +
      '<div class="form-group"><label class="form-label">الاسم AR</label><input type="text" id="apmNameAr" class="form-control" value="' + (d.nameAr||'') + '"></div>' +
    '</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">' +
      '<div class="form-group"><label class="form-label">الأيقونة</label><input type="text" id="apmIcon" class="form-control" value="' + (d.icon||'fa-money-bill') + '" placeholder="fa-wallet"></div>' +
      '<div class="form-group"><label class="form-label">اللون</label><input type="color" id="apmColor" class="form-control" value="' + (d.color||'#3b82f6') + '" style="height:38px;"></div>' +
      '<div class="form-group"><label class="form-label">رسوم %</label><input type="number" id="apmFee" class="form-control" value="' + (d.serviceFeeRate||0) + '" step="0.1"></div>' +
    '</div>' +
    '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:12px 0;">' +
      '<label style="display:flex;gap:6px;align-items:center;font-size:13px;"><input type="checkbox" id="apmReqRef" ' + (d.requireReference?'checked':'') + '> يتطلب مرجع</label>' +
      '<label style="display:flex;gap:6px;align-items:center;font-size:13px;"><input type="checkbox" id="apmReqTxn" ' + (d.requireTransactionNumber?'checked':'') + '> رقم عملية</label>' +
      '<label style="display:flex;gap:6px;align-items:center;font-size:13px;"><input type="checkbox" id="apmReqTerm" ' + (d.requireTerminal?'checked':'') + '> جهاز طرفي</label>' +
      '<label style="display:flex;gap:6px;align-items:center;font-size:13px;"><input type="checkbox" id="apmRefund" ' + (d.allowRefund!==false?'checked':'') + '> استرجاع</label>' +
      '<label style="display:flex;gap:6px;align-items:center;font-size:13px;"><input type="checkbox" id="apmCancel" ' + (d.allowCancel!==false?'checked':'') + '> إلغاء</label>' +
      '<label style="display:flex;gap:6px;align-items:center;font-size:13px;"><input type="checkbox" id="apmActive" ' + (d.isActive!==false?'checked':'') + '> مفعّل</label>' +
    '</div>' +
    '<div style="display:flex;gap:10px;margin-top:15px;"><button class="btn btn-primary" style="flex:1;" onclick="saveAdvancedPM()"><i class="fas fa-save"></i> حفظ</button><button class="btn btn-light" onclick="closeModal(\'#modalAdvPM\')">إلغاء</button></div></div>';
  if (!document.getElementById('modalAdvPM')) { var m = document.createElement('div'); m.id = 'modalAdvPM'; m.className = 'modal'; document.body.appendChild(m); }
  document.getElementById('modalAdvPM').innerHTML = h;
  openModal('#modalAdvPM');
}
function saveAdvancedPM() {
  var data = {
    id: q('#apmId').value, name: q('#apmName').value, nameAr: q('#apmNameAr').value,
    icon: q('#apmIcon').value, color: q('#apmColor').value, serviceFeeRate: Number(q('#apmFee').value)||0,
    requireReference: q('#apmReqRef').checked, requireTransactionNumber: q('#apmReqTxn').checked,
    requireTerminal: q('#apmReqTerm').checked, allowRefund: q('#apmRefund').checked,
    allowCancel: q('#apmCancel').checked, isActive: q('#apmActive').checked
  };
  if (!data.name) return showToast('الاسم مطلوب', true);
  loader(true);
  api.withSuccessHandler(function(r) {
    loader(false);
    if (r.success) { closeModal('#modalAdvPM'); showToast('تم الحفظ'); loadPayMethodsSettings(); loadCoreData(); }
    else showToast(r.error, true);
  }).savePaymentMethodFull(data);
}

// ═══════════════════════════════════════
// Discounts V2 Management
// ═══════════════════════════════════════
function loadDiscountsV2() {
  var container = q('#discountsV2List');
  if (!container) return;
  api.withSuccessHandler(function(list) {
    if (!list || !list.length) { container.innerHTML = '<p style="color:#94a3b8;text-align:center;padding:10px;">لا توجد خصومات</p>'; return; }
    var typeLabels = {percentage:'نسبة %',fixed:'مبلغ ثابت',promo_code:'كود خصم',automatic:'تلقائي'};
    container.innerHTML = list.map(function(d) {
      return '<div style="display:flex;gap:8px;align-items:center;background:#f8fafc;padding:10px 12px;border-radius:10px;border:1px solid #e2e8f0;margin-bottom:6px;">' +
        '<span style="width:8px;height:8px;border-radius:50%;background:' + (d.enabled?'#16a34a':'#ef4444') + ';flex-shrink:0;"></span>' +
        '<div style="flex:1;min-width:0;"><div style="font-weight:700;font-size:13px;">' + d.name + '</div>' +
        '<div style="font-size:11px;color:#64748b;">' + (typeLabels[d.type]||d.type) + ' — ' + (d.type==='percentage'?d.value+'%':d.value+' SAR') +
        (d.requireCode?' | كود: '+d.code:'') + (d.requireApproval?' | يتطلب موافقة':'') + '</div></div>' +
        '<button class="btn-icon" onclick="editDiscountV2(\'' + d.id + '\')" title="تعديل"><i class="fas fa-edit"></i></button>' +
        '<button class="btn-icon" style="color:#ef4444;" onclick="deleteDiscountV2(\'' + d.id + '\')" title="حذف"><i class="fas fa-trash"></i></button>' +
      '</div>';
    }).join('');
  }).getDiscountsV2();
}
var _discV2Cache = [];
function openDiscountV2Modal(data) {
  var d = data || {};
  var h = '<div class="modal-content modal-large"><div class="modal-title">' + (d.id?'تعديل':'إضافة') + ' خصم<button class="modal-close" onclick="closeModal(\'#modalDiscV2\')">&times;</button></div>' +
    '<input type="hidden" id="dv2Id" value="' + (d.id||'') + '">' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
      '<div class="form-group"><label class="form-label">اسم الخصم *</label><input type="text" id="dv2Name" class="form-control" value="' + (d.name||'') + '"></div>' +
      '<div class="form-group"><label class="form-label">النوع</label><select id="dv2Type" class="form-control"><option value="percentage"' + (d.type==='percentage'?' selected':'') + '>نسبة %</option><option value="fixed"' + (d.type==='fixed'?' selected':'') + '>مبلغ ثابت</option><option value="promo_code"' + (d.type==='promo_code'?' selected':'') + '>كود خصم</option><option value="automatic"' + (d.type==='automatic'?' selected':'') + '>تلقائي</option></select></div>' +
    '</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">' +
      '<div class="form-group"><label class="form-label">القيمة</label><input type="number" id="dv2Value" class="form-control" value="' + (d.value||0) + '" step="0.01"></div>' +
      '<div class="form-group"><label class="form-label">حد أقصى</label><input type="number" id="dv2Max" class="form-control" value="' + (d.maxAmount||0) + '" step="0.01"></div>' +
      '<div class="form-group"><label class="form-label">حد أدنى طلب</label><input type="number" id="dv2Min" class="form-control" value="' + (d.minOrder||0) + '" step="0.01"></div>' +
    '</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
      '<div class="form-group"><label class="form-label">من تاريخ</label><input type="date" id="dv2From" class="form-control" value="' + (d.validFrom?d.validFrom.substring(0,10):'') + '"></div>' +
      '<div class="form-group"><label class="form-label">إلى تاريخ</label><input type="date" id="dv2To" class="form-control" value="' + (d.validTo?d.validTo.substring(0,10):'') + '"></div>' +
    '</div>' +
    '<div class="form-group"><label class="form-label">كود الخصم</label><input type="text" id="dv2Code" class="form-control" value="' + (d.code||'') + '" placeholder="DISCOUNT10"></div>' +
    '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:8px 0;">' +
      '<label style="display:flex;gap:6px;align-items:center;font-size:13px;"><input type="checkbox" id="dv2ReqCode" ' + (d.requireCode?'checked':'') + '> يتطلب كود</label>' +
      '<label style="display:flex;gap:6px;align-items:center;font-size:13px;"><input type="checkbox" id="dv2ReqApproval" ' + (d.requireApproval?'checked':'') + '> يتطلب موافقة</label>' +
      '<label style="display:flex;gap:6px;align-items:center;font-size:13px;"><input type="checkbox" id="dv2Enabled" ' + (d.enabled!==false?'checked':'') + '> مفعّل</label>' +
    '</div>' +
    '<div style="display:flex;gap:10px;margin-top:15px;"><button class="btn btn-primary" style="flex:1;" onclick="saveDiscountV2()"><i class="fas fa-save"></i> حفظ</button><button class="btn btn-light" onclick="closeModal(\'#modalDiscV2\')">إلغاء</button></div></div>';
  if (!document.getElementById('modalDiscV2')) { var m = document.createElement('div'); m.id = 'modalDiscV2'; m.className = 'modal'; document.body.appendChild(m); }
  document.getElementById('modalDiscV2').innerHTML = h;
  openModal('#modalDiscV2');
}
function editDiscountV2(id) {
  api.withSuccessHandler(function(list) {
    _discV2Cache = list || [];
    var d = _discV2Cache.find(function(x){return x.id===id;});
    if (d) openDiscountV2Modal(d);
  }).getDiscountsV2();
}
function saveDiscountV2() {
  var data = {
    id: q('#dv2Id').value, name: q('#dv2Name').value, type: q('#dv2Type').value,
    value: Number(q('#dv2Value').value)||0, maxAmount: Number(q('#dv2Max').value)||0,
    minOrder: Number(q('#dv2Min').value)||0, code: q('#dv2Code').value,
    requireCode: q('#dv2ReqCode').checked, requireApproval: q('#dv2ReqApproval').checked,
    enabled: q('#dv2Enabled').checked, validFrom: q('#dv2From').value||null, validTo: q('#dv2To').value||null
  };
  if (!data.name) return showToast('الاسم مطلوب', true);
  loader(true);
  api.withSuccessHandler(function(r) { loader(false); if (r.success) { closeModal('#modalDiscV2'); showToast('تم الحفظ'); loadDiscountsV2(); } else showToast(r.error, true); }).saveDiscountV2(data);
}
function deleteDiscountV2(id) {
  if (!confirm('حذف هذا الخصم؟')) return;
  loader(true);
  api.withSuccessHandler(function(r) { loader(false); if (r.success) { showToast('تم الحذف'); loadDiscountsV2(); } else showToast(r.error, true); }).deleteDiscountV2(id);
}

// Load discounts on settings open
(function() {
  var origNav = window._origNavSettings;
  if (!origNav) {
    var _oldLoadDashSettings = window.loadDashSettings;
    window.loadDashSettings = function() { if (_oldLoadDashSettings) _oldLoadDashSettings(); setTimeout(loadDiscountsV2, 300); };
  }
})();

function openDiscountModal() {
  if (!state.cart.length) return showToast(t("emptyCart"), true);
  loader();
  // Try v2 discounts first, fallback to legacy
  api.withSuccessHandler(function(v2list) {
    if (v2list && v2list.length) {
      loader(false);
      var now = new Date();
      var sub = state.cart.reduce(function(s,c){return s+c.qty*c.price;},0);
      // Filter: enabled + valid dates + min order
      var valid = v2list.filter(function(d) {
        if (!d.enabled) return false;
        if (d.validFrom && new Date(d.validFrom) > now) return false;
        if (d.validTo && new Date(d.validTo) < now) return false;
        if (d.minOrder > 0 && sub < d.minOrder) return false;
        return true;
      });
      var h = '';
      if (!valid.length) h = '<p style="text-align:center;color:#94a3b8;">لا توجد خصومات متاحة</p>';
      valid.forEach(function(d) {
        var valStr = d.type === 'percentage' ? d.value + '%' : d.value + ' SAR';
        var typeLabel = d.type==='percentage'?'نسبة':d.type==='fixed'?'مبلغ':d.type==='promo_code'?'كود':'تلقائي';
        var badges = '';
        if (d.requireCode) badges += '<span style="font-size:10px;background:#fef3c7;color:#92400e;padding:1px 6px;border-radius:4px;">كود</span> ';
        if (d.requireApproval) badges += '<span style="font-size:10px;background:#fee2e2;color:#991b1b;padding:1px 6px;border-radius:4px;">موافقة</span> ';
        if (d.maxAmount > 0) badges += '<span style="font-size:10px;background:#f1f5f9;color:#64748b;padding:1px 6px;border-radius:4px;">حد: ' + d.maxAmount + '</span>';
        h += '<div class="card" style="margin-bottom:10px;cursor:pointer;padding:12px;border-radius:12px;" onclick="applyDiscountV2(\'' + d.id + '\',\'' + (d.name||'').replace(/'/g,'') + '\',\'' + d.type + '\',' + d.value + ',' + (d.maxAmount||0) + ',' + (d.requireCode?'true':'false') + ',' + (d.requireApproval?'true':'false') + ',\'' + (d.code||'') + '\')">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;">' +
            '<div><strong style="font-size:14px;">' + d.name + '</strong><div style="font-size:11px;color:#64748b;">' + typeLabel + ' ' + badges + '</div></div>' +
            '<strong style="color:#8b5cf6;font-size:18px;">' + valStr + '</strong>' +
          '</div></div>';
      });
      q('#discModalList').innerHTML = h;
      openModal('#modalDiscount');
    } else {
      // Fallback to legacy discounts
      api.withSuccessHandler(function(discs) {
        loader(false);
        var h = '';
        if (!discs.length) h = '<p style="text-align:center;">لا توجد خصومات متاحة</p>';
        discs.forEach(function(d) {
          var valStr = d.type === 'PERCENT' ? d.value + '%' : d.value + ' SAR';
          h += '<div class="card" style="margin-bottom:15px;cursor:pointer;" onclick="applyDiscount(\'' + d.name + '\',\'' + d.type + '\',' + d.value + ')"><div style="display:flex;justify-content:space-between;align-items:center;"><h4 style="margin:0;">' + d.name + '</h4><strong style="color:var(--secondary);font-size:18px;">' + valStr + '</strong></div></div>';
        });
        q('#discModalList').innerHTML = h;
        openModal('#modalDiscount');
      }).getDiscounts();
    }
  }).getDiscountsV2();
}

function applyDiscountV2(id, name, type, value, maxAmount, requireCode, requireApproval, code) {
  if (requireCode) {
    var entered = prompt('أدخل كود الخصم:');
    if (!entered) return;
    if (entered !== code) return showToast('كود الخصم غير صحيح', true);
  }
  if (requireApproval) {
    var mgr = prompt('أدخل رمز موافقة المدير:');
    if (!mgr) return showToast('الموافقة مطلوبة', true);
  }
  var sub = state.cart.reduce(function(s,c){return s+c.qty*c.price;},0);
  var calc = type === 'percentage' ? sub * (value / 100) : value;
  if (maxAmount > 0 && calc > maxAmount) calc = maxAmount;
  state.currentDiscount = { name: name, amount: calc };
  updateCart();
  closeModal('#modalDiscount');
  showToast('تم تطبيق الخصم: ' + name);
}

function applyDiscount(name, type, val) {
  let sub = state.cart.reduce((s,c) => s + c.qty * c.price, 0);
  let calc = type === "PERCENT" ? sub * (val / 100) : val;
  state.currentDiscount = { name, amount: calc };
  updateCart();
  closeModal("#modalDiscount");
  showToast("تم تطبيق الخصم");
}

function doCheckout() {
  if (!state.activeShiftId) return showToast("عذراً، يجب فتح وردية (شيفت) لاستقبال الطلبات.", true);
  if (!state.cart.length) return showToast(t("emptyCart"), true);

  var sub = state.cart.reduce(function(s,c){return s+c.qty*c.price;}, 0);
  var afterDiscount = sub - state.currentDiscount.amount;
  var payMethod = q("#posPayMethod").value;

  // Calculate service fee (manual or auto)
  var serviceFee = 0;
  var totalFinal = afterDiscount;
  var selectedPM = (state.paymentMethods||[]).find(function(m){return m.Name===payMethod;});
  var feeRate = selectedPM ? Number(selectedPM.ServiceFeeRate)||0 : (payMethod==='Kita'?state.kitaFeeRate:0);
  var feeInput = q("#serviceFeeInput");
  var manualFee = feeInput ? Number(feeInput.value) : 0;

  // Handle split payment
  var splitDetails = null;
  if (payMethod === 'Split') {
    splitDetails = {};
    var totalPaid = 0;
    qs(".split-input").forEach(function(el){
      var val = Number(el.value)||0;
      if (val > 0) { splitDetails[el.dataset.method] = val; totalPaid += val; }
    });
    if (Math.abs(totalPaid - afterDiscount) > 0.01) return showToast("مجموع التجزئة (" + formatVal(totalPaid) + ") لا يساوي الإجمالي (" + formatVal(afterDiscount) + ")", true);
    totalFinal = afterDiscount;
  } else if (manualFee > 0) {
    serviceFee = manualFee;
    totalFinal = afterDiscount + serviceFee;
  } else if (feeRate > 0 && payMethod !== 'Cash' && payMethod !== 'Card') {
    serviceFee = afterDiscount * (feeRate / 100);
    totalFinal = afterDiscount + serviceFee;
  }

  var order = {
    items: state.cart, total: sub, totalFinal: totalFinal,
    paymentMethod: payMethod, discountName: state.currentDiscount.name,
    discountAmount: state.currentDiscount.amount, kitaServiceFee: serviceFee,
    splitDetails: splitDetails
  };

  // Confirm service fee
  if (serviceFee > 0) {
    if (!confirm("رسوم الخدمة: " + formatVal(serviceFee) + " " + state.settings.currency + "\nالإجمالي: " + formatVal(totalFinal) + " " + state.settings.currency + "\n\nمتابعة؟")) return;
  }

  loader();
  api.withSuccessHandler(function(res) {
    loader(false);
    showToast("تم حفظ الطلب بنجاح!");
    printReceipt(res.orderId);
    clearCart();
    api.withSuccessHandler(function(m) { state.menu = m; renderMenuGrid(); }).getMenu();
    // Mark dashboard as stale + refresh any visible admin section so cards update instantly
    state.lastSaleAt = Date.now();
    refreshActiveAdminSection();
  }).saveOrder(order, state.user, state.activeShiftId);
}

// Refresh whichever admin section is currently visible (after a sale, recipe save, etc.)
function refreshActiveAdminSection() {
  var adminVisible = q('#adminView') && !q('#adminView').classList.contains('hidden');
  if (!adminVisible) return;
  var active = q('.admin-section.active');
  if (!active) return;
  var id = (active.id || '').replace('sec_', '');
  switch (id) {
    case 'home':       if (typeof loadDashHome === 'function') loadDashHome(); break;
    case 'sales':      if (typeof salesGo === 'function') salesGo('hub'); else if (typeof loadDashSales === 'function') loadDashSales(); break;
    case 'inventory':  if (typeof loadDashInv === 'function') loadDashInv(); break;
    case 'warehouse':  if (typeof loadDashInvItems === 'function') loadDashInvItems(); break;
    case 'expenses':   if (typeof loadDashExpenses === 'function') loadDashExpenses(); break;
    case 'purchases':  if (typeof loadDashPurchases === 'function') loadDashPurchases(); break;
    case 'shifts':     if (typeof loadDashShifts === 'function') loadDashShifts(); break;
  }
}

function printReceipt(orderId) {
  // Lazy-load QRCode the first time we need to render a receipt
  ensureQRCode().then(function() { _printReceiptBody(orderId); }).catch(function(e) { showToast(e.message || 'فشل تحميل QRCode', true); });
}
function _printReceiptBody(orderId) {
  api.withSuccessHandler(function(inv) {
    if (!inv) return;
    var dt = new Date(inv.date);
    var dateStr = dt.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})+' '+dt.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',second:'2-digit'});
    var companyName = (state.settings&&state.settings.name)||'Moroccan Taste';
    var taxNumber = (state.settings&&state.settings.taxNumber)||'';
    var currency = (state.settings&&state.settings.currency)||'SAR';
    var totalItems = 0;
    var itemsHtml = '';
    (inv.items||[]).forEach(function(i){
      totalItems += Number(i.qty)||0;
      itemsHtml += '<tr><td style="text-align:left;font-size:12px;">'+i.name+'</td><td style="text-align:center;">'+i.qty+'@</td><td style="text-align:right;">'+formatVal(i.total)+'</td></tr>';
    });
    var netAmount = Number(inv.totalFinal) / 1.15;
    var vatAmount = Number(inv.totalFinal) - netAmount;
    var payLabel = {'Cash':'Cash | كاش','Card':'Mada | مدى','Kita':'Kita | كيتا'};

    var logoUrl = (state.settings && state.settings.logo) || '';
    var logoTag = logoUrl ? '<div style="text-align:center;margin-bottom:6px;"><img src="'+logoUrl+'" style="max-width:80px;max-height:80px;object-fit:contain;"></div>' : '';
    var h = logoTag +
      '<div style="text-align:center;font-size:18px;font-weight:900;margin-bottom:2px;">'+companyName+'</div>'+
      '<div style="text-align:center;font-size:11px;color:#666;margin-bottom:2px;">Simplified TAX Invoice</div>'+
      '<div style="text-align:center;font-size:11px;color:#666;">فاتورة ضريبية مبسطة</div>'+
      '<div style="text-align:center;font-size:11px;color:#666;margin-bottom:8px;">Tax No: '+taxNumber+'</div>'+
      '<div style="border-top:1px dashed #999;border-bottom:1px dashed #999;padding:8px 0;margin:8px 0;">'+
        '<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;"><span>Tax Invoice | فاتورة ضريبية</span></div>'+
        '<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:2px;"><span>ID</span><span style="font-weight:700;">'+inv.orderId+'</span></div>'+
        '<div style="display:flex;justify-content:space-between;font-size:12px;"><span>Date</span><span>'+dateStr+'</span></div>'+
      '</div>'+
      '<table style="width:100%;border-collapse:collapse;margin:8px 0;"><thead><tr style="border-bottom:1px dashed #999;"><th style="text-align:left;font-size:11px;padding:4px 0;">Item</th><th style="text-align:center;font-size:11px;">Qty</th><th style="text-align:right;font-size:11px;">'+currency+'</th></tr></thead><tbody>'+itemsHtml+'</tbody></table>'+
      '<div style="text-align:center;font-size:12px;font-weight:700;border-top:1px dashed #999;padding-top:6px;">Total Items / عدد الأصناف<br><span style="font-size:16px;">'+totalItems+'</span></div>'+
      '<table style="width:100%;margin:10px 0;border-collapse:collapse;border-top:1px solid #333;border-bottom:1px solid #333;"><tr>'+
        '<td style="text-align:center;padding:8px;border-left:1px solid #333;"><div style="font-size:10px;font-weight:700;">Total Value<br>إجمالي القيمة</div><div style="font-size:15px;font-weight:900;">'+formatVal(inv.totalFinal)+'</div></td>'+
        '<td style="text-align:center;padding:8px;border-left:1px solid #333;"><div style="font-size:10px;font-weight:700;">Net Amount<br>المبلغ قبل الضريبة</div><div style="font-size:15px;font-weight:900;">'+netAmount.toFixed(2)+'</div></td>'+
        '<td style="text-align:center;padding:8px;"><div style="font-size:10px;font-weight:700;">VAT Amount<br>ضريبة القيمة المضافة 15%</div><div style="font-size:15px;font-weight:900;">'+vatAmount.toFixed(2)+'</div></td>'+
      '</tr></table>'+
      '<div style="text-align:center;font-size:13px;margin:8px 0;"><span style="font-weight:700;">'+(payLabel[inv.payment]||inv.payment)+'</span> <span style="font-weight:900;font-size:15px;">'+formatVal(inv.totalFinal)+'</span></div>'+
      '<div style="text-align:center;font-size:11px;color:#666;margin-bottom:4px;">Served by: '+( inv.username||state.user)+'</div>'+
      (inv.discountAmount>0?'<div style="text-align:center;font-size:12px;color:#ef4444;">Discount: -'+formatVal(inv.discountAmount)+'</div>':'')+
      '<div id="receiptQR" style="text-align:center;margin:12px auto;width:150px;height:150px;"></div>'+
      '<div style="text-align:center;font-size:10px;color:#999;margin-bottom:4px;">'+inv.orderId+'</div>'+
      '<div style="text-align:center;font-size:11px;color:#666;">Thank you! / شكراً لزيارتكم</div>';

    q("#receiptBox").innerHTML = h;
    state._lastReceipt = { inv: inv, html: h, companyName: companyName, taxNumber: taxNumber };
    openModal("#modalReceipt");
    // Generate ZATCA Phase 1 TLV QR Code
    setTimeout(function(){
      var qrEl = document.getElementById('receiptQR');
      if (qrEl && typeof QRCode !== 'undefined') {
        qrEl.innerHTML = '';
        var tlvBase64 = generateZATCA_TLV(companyName, taxNumber, new Date(inv.date).toISOString(), formatVal(inv.totalFinal), vatAmount.toFixed(2));
        new QRCode(qrEl, { text: tlvBase64, width: 140, height: 140, colorDark:'#000', colorLight:'#fff' });
      }
    }, 200);
  }).getInvoice(orderId);
}

// ZATCA Phase 1 TLV QR Code Generator
function generateZATCA_TLV(sellerName, vatNumber, timestamp, totalAmount, vatAmount) {
  // TLV Tags: 1=Seller, 2=VAT#, 3=Timestamp(ISO8601), 4=Total, 5=VAT
  function utf8Bytes(str) {
    var bytes = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) { bytes.push(0xC0|(c>>6)); bytes.push(0x80|(c&0x3F)); }
      else if (c < 0x10000) { bytes.push(0xE0|(c>>12)); bytes.push(0x80|((c>>6)&0x3F)); bytes.push(0x80|(c&0x3F)); }
      else { bytes.push(0xF0|(c>>18)); bytes.push(0x80|((c>>12)&0x3F)); bytes.push(0x80|((c>>6)&0x3F)); bytes.push(0x80|(c&0x3F)); }
    }
    return bytes;
  }
  function makeTLV(tag, value) {
    var valBytes = utf8Bytes(String(value||''));
    return [tag, valBytes.length].concat(valBytes);
  }
  var tlv = [];
  tlv = tlv.concat(makeTLV(1, sellerName));
  tlv = tlv.concat(makeTLV(2, vatNumber));
  tlv = tlv.concat(makeTLV(3, timestamp));
  tlv = tlv.concat(makeTLV(4, totalAmount));
  tlv = tlv.concat(makeTLV(5, vatAmount));
  // Convert to Base64
  var binary = '';
  for (var i = 0; i < tlv.length; i++) binary += String.fromCharCode(tlv[i]);
  return btoa(binary);
}

function printReceiptWindow() {
  var r = state._lastReceipt;
  if (!r) return;
  var qrCanvas = document.querySelector('#receiptQR canvas');
  var qrImg = qrCanvas ? qrCanvas.toDataURL() : '';
  var w = window.open('','_blank','width=350,height=700');
  w.document.write('<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width"><title>Receipt</title>'+
    '<style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:Arial,sans-serif;padding:8px;width:280px;margin:0 auto;font-size:12px;color:#000;}'+
    'table{width:100%;border-collapse:collapse;}th,td{padding:4px 2px;font-size:11px;}th{text-align:left;border-bottom:1px dashed #000;}'+
    '.center{text-align:center;}.bold{font-weight:700;}.big{font-size:14px;}.line{border-top:1px dashed #000;margin:6px 0;}'+
    '@media print{@page{margin:0;size:80mm auto;}body{padding:4px;width:100%;}}</style></head><body>'+
    ((state.settings && state.settings.logo) ? '<div class="center" style="margin-bottom:6px;"><img src="'+state.settings.logo+'" style="max-width:80px;max-height:80px;"></div>' : '')+
    '<div class="center bold" style="font-size:16px;">'+r.companyName+'</div>'+
    '<div class="center" style="font-size:10px;color:#666;">Simplified TAX Invoice | فاتورة ضريبية مبسطة</div>'+
    '<div class="center" style="font-size:10px;color:#666;margin-bottom:6px;">Tax: '+r.taxNumber+'</div>'+
    '<div class="line"></div>'+
    '<div style="display:flex;justify-content:space-between;font-size:11px;margin:4px 0;"><span>ID:</span><span class="bold">'+r.inv.orderId+'</span></div>'+
    '<div style="display:flex;justify-content:space-between;font-size:11px;margin:4px 0;"><span>Date:</span><span>'+new Date(r.inv.date).toLocaleString('en-US')+'</span></div>'+
    '<div class="line"></div>');
  // Items
  w.document.write('<table><tr><th>Item</th><th style="text-align:center;">Qty</th><th style="text-align:right;">SAR</th></tr>');
  (r.inv.items||[]).forEach(function(it){
    w.document.write('<tr><td>'+it.name+'</td><td style="text-align:center;">'+it.qty+'</td><td style="text-align:right;">'+formatVal(it.total)+'</td></tr>');
  });
  w.document.write('</table><div class="line"></div>');
  var net = r.inv.totalFinal / 1.15;
  var vat = r.inv.totalFinal - net;
  w.document.write('<div class="center bold">Total Items: '+(r.inv.items||[]).reduce(function(s,i){return s+i.qty;},0)+'</div>');
  w.document.write('<table style="margin:6px 0;border:1px solid #000;"><tr>'+
    '<td class="center" style="border-right:1px solid #000;padding:6px;"><div style="font-size:9px;">Total<br>إجمالي</div><div class="bold big">'+formatVal(r.inv.totalFinal)+'</div></td>'+
    '<td class="center" style="border-right:1px solid #000;padding:6px;"><div style="font-size:9px;">Net<br>قبل الضريبة</div><div class="bold big">'+net.toFixed(2)+'</div></td>'+
    '<td class="center" style="padding:6px;"><div style="font-size:9px;">VAT 15%<br>الضريبة</div><div class="bold big">'+vat.toFixed(2)+'</div></td>'+
  '</tr></table>');
  w.document.write('<div class="center bold" style="margin:6px 0;">'+(r.inv.payment||'')+' '+formatVal(r.inv.totalFinal)+'</div>');
  w.document.write('<div class="center" style="font-size:10px;">Served by: '+(r.inv.username||'')+'</div>');
  if (qrImg) w.document.write('<div class="center" style="margin:10px 0;"><img src="'+qrImg+'" width="130" height="130"></div>');
  w.document.write('<div class="center" style="font-size:9px;color:#666;">'+r.inv.orderId+'</div>');
  w.document.write('<div class="center" style="font-size:10px;margin-top:6px;">Thank you! / شكراً لزيارتكم</div>');
  w.document.write('</body></html>');
  w.document.close();
  setTimeout(function(){ w.print(); }, 400);
}

// =========================================
// 5. Shift Operations
// =========================================
// Old shift functions removed — using new versions below (with variance check)

// =========================================
// 6. Admin Dashboard Engine
// =========================================
function toggleSubmenu(element) {
  element.classList.toggle('open');
  const submenu = element.nextElementSibling;
  if(submenu.classList.contains('submenu')) {
    submenu.classList.toggle('open');
  }
}

// ═══ Admin navigation history stack — allows back/forward between sections ═══
window._navHistory = window._navHistory || [];
window._navFuture  = window._navFuture  || [];
window._navSilent  = false;  // set to true when programmatic nav shouldn't be recorded

window.navBack = function() {
  if (!window._navHistory.length) return;
  var current = localStorage.getItem('pos_last_section') || 'home';
  var prev = window._navHistory.pop();
  window._navFuture.push(current);
  window._navSilent = true;
  try { nav(prev); } finally { window._navSilent = false; }
  _updateNavBackBtn();
};
window.navForward = function() {
  if (!window._navFuture.length) return;
  var current = localStorage.getItem('pos_last_section') || 'home';
  var next = window._navFuture.pop();
  window._navHistory.push(current);
  window._navSilent = true;
  try { nav(next); } finally { window._navSilent = false; }
  _updateNavBackBtn();
};
function _updateNavBackBtn() {
  var back = document.getElementById('navBackBtn');
  var fwd  = document.getElementById('navFwdBtn');
  if (back) back.disabled = window._navHistory.length === 0;
  if (fwd)  fwd.disabled  = window._navFuture.length === 0;
}

// Alt+← / Alt+→ shortcuts for section back/forward
document.addEventListener('keydown', function(e) {
  if (!e.altKey) return;
  if (e.key === 'ArrowRight' || e.key === 'Backspace') { e.preventDefault(); navBack(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); navForward(); }
});

function nav(sectionId) {
  // Push the PREVIOUS section onto the back stack before switching.
  if (!window._navSilent) {
    var prev = localStorage.getItem('pos_last_section');
    if (prev && prev !== sectionId) {
      window._navHistory.push(prev);
      // Cap history at 50 entries
      if (window._navHistory.length > 50) window._navHistory.shift();
      // Manual nav invalidates the forward stack
      window._navFuture = [];
    }
  }
  localStorage.setItem("pos_last_section", sectionId);
  _updateNavBackBtn();
  // Lazy-mount the section on first access
  if (typeof mountSection === 'function') mountSection('sec_' + sectionId);
  qs(".nav-item").forEach(el => el.classList.remove("active"));
  var navEl = q('.nav-item[onclick="nav(\''+sectionId+'\')"]');
  if (navEl) {
    navEl.classList.add("active");
    // Auto-open parent submenu if collapsed
    var parent = navEl.closest('.submenu');
    if (parent && !parent.classList.contains('open')) {
      parent.classList.add('open');
      var toggle = parent.previousElementSibling;
      if (toggle && toggle.classList.contains('has-submenu')) toggle.classList.add('open');
    }
  }

  // Stop any previous auto-refresh interval (only the home dashboard polls)
  if (state._dashAutoRefresh) { clearInterval(state._dashAutoRefresh); state._dashAutoRefresh = null; }

  // Hide ERP sections when navigating POS
  document.querySelectorAll('.dash-section').forEach(s => s.classList.add('hidden'));

  qs(".admin-section").forEach(el => el.classList.remove("active"));
  const secEl = q(`#sec_${sectionId}`);
  if (secEl) secEl.classList.add("active");

  // Start polling on the home dashboard so KPIs/chart cards reflect new sales without manual refresh
  if (sectionId === 'home') {
    state._dashAutoRefresh = setInterval(function() {
      if (document.visibilityState === 'visible' && typeof loadDashHome === 'function') {
        loadDashHome();
      }
    }, 30000);
  }
  
  const titles = { home:"\u0646\u0638\u0631\u0629 \u0639\u0627\u0645\u0629", sales:"\u0633\u062c\u0644 \u0627\u0644\u0645\u0628\u064a\u0639\u0627\u062a", menu:"\u0642\u0627\u0626\u0645\u0629 \u0627\u0644\u0645\u0646\u064a\u0648", recipes:"\u0627\u0644\u0645\u0642\u0627\u062f\u064a\u0631 \u0648\u0627\u0644\u0648\u0635\u0641\u0627\u062a", inventory:"\u0627\u0644\u0645\u0646\u064a\u0648", warehouse:"\u0625\u062f\u0627\u0631\u0629 \u0627\u0644\u0645\u0633\u062a\u0648\u062f\u0639", expenses:"\u0625\u062f\u0627\u0631\u0629 \u0627\u0644\u0645\u0635\u0631\u0648\u0641\u0627\u062a", purchases:"\u0625\u062f\u0627\u0631\u0629 \u0627\u0644\u0645\u0634\u062a\u0631\u064a\u0627\u062a", users:"\u0635\u0644\u0627\u062d\u064a\u0627\u062a \u0627\u0644\u0645\u0633\u062a\u062e\u062f\u0645\u064a\u0646", shifts:"\u0633\u062c\u0644 \u0627\u0644\u0645\u0646\u0627\u0648\u0628\u0627\u062a \u0627\u0644\u0645\u063a\u0644\u0642\u0629", reports:"\u0627\u0644\u062a\u0642\u0627\u0631\u064a\u0631 \u0627\u0644\u0645\u062a\u0642\u062f\u0645\u0629", settings:"\u0627\u0644\u0625\u0639\u062f\u0627\u062f\u0627\u062a", custodyUsers:"\u0645\u0633\u0624\u0648\u0644\u0648 \u0627\u0644\u0639\u0647\u062f\u0629", custodies:"\u0625\u062f\u0627\u0631\u0629 \u0627\u0644\u0639\u0647\u062f", custodyApproval:"\u062a\u0623\u0643\u064a\u062f \u0645\u0635\u0631\u0648\u0641\u0627\u062a \u0627\u0644\u0639\u0647\u062f", custodyReports:"\u062a\u0642\u0627\u0631\u064a\u0631 \u0627\u0644\u0639\u0647\u062f" };
  const hTitle = q('.admin-header-title');
  if (hTitle) hTitle.innerText = titles[sectionId] || "لوحة التحكم";

  // Data Loading Trigger
  if (sectionId === 'home') loadDashHome();
  if (sectionId === 'sales') { if (typeof salesGo === 'function') salesGo('hub'); else loadDashSales(); }
  if (sectionId === 'menu') loadDashMenu();
  if (sectionId === 'recipes') loadDashRecipes();
  if (sectionId === 'inventory') loadDashMenu(); // legacy alias → menu
  if (sectionId === 'warehouse') loadDashInvItems();
  if (sectionId === 'expenses') loadDashExpenses();
  if (sectionId === 'purchases') loadDashPurchases();
  if (sectionId === 'users') loadDashUsers();
  if (sectionId === 'shifts') loadDashShifts();
  if (sectionId === 'reports') populateReportFilters();
  if (sectionId === 'settings') { loadPayMethodsSettings(); applyDeveloperVisibility(); }
  // Custody sections (lazy-load custody.js)
  if (sectionId === 'custodyUsers') { ensureCustodyJs().then(function() { loadCustodyUsers(); }); }
  if (sectionId === 'custodies') { ensureCustodyJs().then(function() { loadCustodies(); }); }
  if (sectionId === 'custodyApproval') { ensureCustodyJs().then(function() { loadCustodyApprovals(); }); }
  if (sectionId === 'custodyReports') { ensureCustodyJs().then(function() { loadCustodies(); }); }
}

// ═══════════════════════════════════════════════════════════════════
// Enterprise Command Center — الرئيسية (new unified dashboard)
// Uses single aggregator endpoint: GET /api/dashboard/overview
// ═══════════════════════════════════════════════════════════════════
window._ccFilters = { preset: 'last7', from: '', to: '', brandId: '', branchId: '', compare: 'previous' };
window._ccPresetLabels = {
  today: 'اليوم', yesterday: 'أمس',
  thisweek: 'هذا الأسبوع', lastweek: 'الأسبوع الماضي',
  last7: 'آخر 7 أيام', last14: 'آخر 14 يوم',
  thismonth: 'هذا الشهر', lastmonth: 'الشهر الماضي',
  last30: 'آخر 30 يوم', last90: 'آخر 90 يوم',
  thisquarter: 'هذا الربع', lastquarter: 'الربع الماضي',
  thisyear: 'هذه السنة', lastyear: 'السنة الماضية',
  week: 'آخر 7 أيام', month: 'هذا الشهر', quarter: 'هذا الربع', year: 'هذه السنة'
};
window._ccCompareLabels = { previous: 'الفترة السابقة', yearago: 'نفس الفترة السنة الماضية', none: 'بدون مقارنة' };
var _ccClockInterval = null;
var _ccBrandsLoaded = false;
var _ccBranchesLoaded = false;

function _ccEsc(s){ if(s===null||s===undefined) return ''; return String(s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
function _ccFmt(n, fractionDigits) {
  n = Number(n || 0);
  return n.toLocaleString('en', { minimumFractionDigits: fractionDigits!=null?fractionDigits:2, maximumFractionDigits: fractionDigits!=null?fractionDigits:2 });
}
function _ccDeltaClass(d) { if (d > 0.5) return 'up'; if (d < -0.5) return 'down'; return 'flat'; }
function _ccDeltaIcon(d)  { if (d > 0.5) return '<i class="fas fa-arrow-up"></i>'; if (d < -0.5) return '<i class="fas fa-arrow-down"></i>'; return '<i class="fas fa-minus"></i>'; }

function _ccStartClock() {
  if (_ccClockInterval) return;
  var tick = function() {
    var el = q('#ccClock'); if (!el) return;
    var n = new Date();
    el.textContent = n.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  };
  tick();
  _ccClockInterval = setInterval(tick, 1000);
}

window.ccSetPreset = function(p) {
  window._ccFilters.preset = p;
  window._ccFilters.from = '';
  window._ccFilters.to   = '';
  document.querySelectorAll('[data-cc-preset]').forEach(function(el){
    el.classList.toggle('active', el.getAttribute('data-cc-preset') === p);
  });
  if (q('#ccFFrom')) q('#ccFFrom').value = '';
  if (q('#ccFTo'))   q('#ccFTo').value = '';
  loadDashHome();
};

window.ccApplyCustomRange = function() {
  var f = q('#ccFFrom') ? q('#ccFFrom').value : '';
  var t = q('#ccFTo')   ? q('#ccFTo').value : '';
  if (f || t) {
    window._ccFilters.preset = '';
    window._ccFilters.from = f;
    window._ccFilters.to   = t || f;
    document.querySelectorAll('[data-cc-preset]').forEach(function(el){ el.classList.remove('active'); });
    loadDashHome();
  }
};

window.ccResetFilters = function() {
  window._ccFilters = { preset: 'last7', from: '', to: '', brandId: '', branchId: '', compare: 'previous' };
  if (q('#ccFBrand'))   q('#ccFBrand').value = '';
  if (q('#ccFBranch'))  q('#ccFBranch').value = '';
  if (q('#ccFCompare')) q('#ccFCompare').value = 'previous';
  if (q('#ccFFrom'))    q('#ccFFrom').value = '';
  if (q('#ccFTo'))      q('#ccFTo').value = '';
  document.querySelectorAll('[data-cc-preset]').forEach(function(el){
    el.classList.toggle('active', el.getAttribute('data-cc-preset') === 'last7');
  });
  loadDashHome();
};

window.ccSetCompareMode = function(mode) {
  window._ccFilters.compare = mode || 'previous';
  loadDashHome();
};

window.ccExportPdf = function() {
  showToast('تصدير PDF — قيد التطوير');
};

function _ccPopulateBrandBranchSelects() {
  var hdr = { 'Authorization':'Bearer '+(localStorage.getItem('pos_token')||'') };
  // Always (re)bind onchange — even if the selects were previously populated,
  // the user may have navigated away and come back, losing the handler.
  var bSel = q('#ccFBrand');
  if (bSel) {
    bSel.onchange = function(){
      window._ccFilters.brandId = this.value || '';
      loadDashHome();
    };
  }
  var brSel = q('#ccFBranch');
  if (brSel) {
    brSel.onchange = function(){
      window._ccFilters.branchId = this.value || '';
      loadDashHome();
    };
  }
  if (!_ccBrandsLoaded && bSel) {
    fetch('/api/erp/brands', { headers: hdr }).then(function(r){return r.json();}).then(function(brs){
      bSel.innerHTML = '<option value="">كل البراندات</option>' +
        (brs||[]).map(function(b){return '<option value="'+b.id+'">'+_ccEsc(b.name||'')+'</option>';}).join('');
      if (window._ccFilters.brandId) bSel.value = window._ccFilters.brandId;
      _ccBrandsLoaded = true;
    }).catch(function(){});
  }
  if (!_ccBranchesLoaded && brSel) {
    fetch('/api/erp/branches-full', { headers: hdr }).then(function(r){return r.json();}).then(function(bnrs){
      brSel.innerHTML = '<option value="">كل الفروع</option>' +
        (bnrs||[]).map(function(b){return '<option value="'+b.id+'">'+_ccEsc(b.name||'')+'</option>';}).join('');
      if (window._ccFilters.branchId) brSel.value = window._ccFilters.branchId;
      _ccBranchesLoaded = true;
    }).catch(function(){});
  }
}

function loadDashHome() {
  _ccStartClock();
  _ccPopulateBrandBranchSelects();
  // Lazy-load Chart.js the first time the dashboard is opened
  ensureChartJs().then(_ccFetchAndRender).catch(function(e) {
    showToast(e.message || 'فشل تحميل المكتبات', true);
  });
}

function _ccFetchAndRender() {
  var f = window._ccFilters;
  var params = [];
  if (f.preset)   params.push('preset='   + encodeURIComponent(f.preset));
  if (f.from)     params.push('from='     + encodeURIComponent(f.from));
  if (f.to)       params.push('to='       + encodeURIComponent(f.to));
  if (f.brandId)  params.push('brandId='  + encodeURIComponent(f.brandId));
  if (f.branchId) params.push('branchId=' + encodeURIComponent(f.branchId));
  if (f.compare)  params.push('compare='  + encodeURIComponent(f.compare));
  var url = '/api/dashboard/overview' + (params.length ? '?' + params.join('&') : '');
  var hdr = { 'Authorization':'Bearer '+(localStorage.getItem('pos_token')||'') };

  fetch(url, { headers: hdr }).then(function(r){return r.json();}).then(function(d){
    if (!d || d.error) { showToast(d && d.error || 'فشل تحميل الداش بورد', true); return; }
    _ccRenderAll(d);
    _ccRenderActiveTags();
  }).catch(function(e){
    showToast((e && e.message) || 'خطأ شبكة', true);
  });
}

// Render the currently-applied filters as removable chips
function _ccRenderActiveTags() {
  var box = q('#ccActiveTags'); if (!box) return;
  var f = window._ccFilters;
  var tags = [];
  if (f.preset && window._ccPresetLabels[f.preset]) {
    tags.push({ label: 'الفترة: ' + window._ccPresetLabels[f.preset], key: 'preset' });
  } else if (f.from || f.to) {
    tags.push({ label: 'تاريخ: ' + (f.from||'') + ' → ' + (f.to||''), key: 'dates' });
  }
  if (f.brandId) {
    var bSel = q('#ccFBrand');
    var name = bSel && bSel.selectedOptions[0] ? bSel.selectedOptions[0].textContent : f.brandId;
    tags.push({ label: 'البراند: ' + name, key: 'brand' });
  }
  if (f.branchId) {
    var brSel = q('#ccFBranch');
    var name = brSel && brSel.selectedOptions[0] ? brSel.selectedOptions[0].textContent : f.branchId;
    tags.push({ label: 'الفرع: ' + name, key: 'branch' });
  }
  if (f.compare && f.compare !== 'previous') {
    tags.push({ label: 'مقارنة: ' + (window._ccCompareLabels[f.compare]||f.compare), key: 'compare' });
  }
  if (!tags.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
  box.style.display = 'flex';
  box.innerHTML = '<span style="font-size:11px;font-weight:800;color:var(--wo-on-surface-subtle);padding:0 6px;">الفلاتر المُطبَّقة:</span>' +
    tags.map(function(t){
      return '<span class="cc-active-tag"><i class="fas fa-filter"></i>' + _ccEsc(t.label) +
        '<button type="button" onclick="ccClearTag(\''+t.key+'\')" aria-label="إزالة"><i class="fas fa-xmark"></i></button></span>';
    }).join('');
}

window.ccClearTag = function(key) {
  var f = window._ccFilters;
  if (key === 'preset')  { f.preset = 'last7'; document.querySelectorAll('[data-cc-preset]').forEach(function(el){ el.classList.toggle('active', el.getAttribute('data-cc-preset')==='last7'); }); }
  if (key === 'dates')   { f.from = ''; f.to = ''; if (q('#ccFFrom')) q('#ccFFrom').value = ''; if (q('#ccFTo')) q('#ccFTo').value = ''; f.preset = 'last7'; document.querySelectorAll('[data-cc-preset]').forEach(function(el){ el.classList.toggle('active', el.getAttribute('data-cc-preset')==='last7'); }); }
  if (key === 'brand')   { f.brandId = '';  if (q('#ccFBrand'))   q('#ccFBrand').value = ''; }
  if (key === 'branch')  { f.branchId = ''; if (q('#ccFBranch'))  q('#ccFBranch').value = ''; }
  if (key === 'compare') { f.compare = 'previous'; if (q('#ccFCompare')) q('#ccFCompare').value = 'previous'; }
  loadDashHome();
};

function _ccRenderAll(d) {
  // Period label (include compare window if enabled)
  if (q('#ccPeriodLabel')) {
    var cmp = '';
    if (d.period.compareMode && d.period.compareMode !== 'none' && d.period.prevFrom && d.period.prevTo) {
      var lbl = window._ccCompareLabels[d.period.compareMode] || '';
      cmp = ' · <span style="color:var(--wo-on-surface-subtle);font-weight:600;">مقارنة مع '+lbl+': '+d.period.prevFrom+' → '+d.period.prevTo+'</span>';
    }
    q('#ccPeriodLabel').innerHTML = '<i class="fas fa-calendar-range"></i> من <b>'+d.period.from+'</b> إلى <b>'+d.period.to+'</b> ('+d.period.rangeDays+' يوم)' + cmp;
  }

  // KPIs
  _ccSetKpi('ccKpiSales',  d.kpi.sales.value,    d.kpi.sales.delta, true);
  _ccSetKpi('ccKpiOrders', d.kpi.orders.value,   d.kpi.orders.delta, false, 0);
  _ccSetKpi('ccKpiAvg',    d.kpi.avgTicket.value,d.kpi.avgTicket.delta, true);
  _ccSetKpi('ccKpiExp',    d.kpi.expenses.value, d.kpi.expenses.delta, true, 2, true);
  _ccSetKpi('ccKpiPur',    d.kpi.purchases.value,d.kpi.purchases.delta, true, 2, true);
  _ccSetKpi('ccKpiNet',    d.kpi.netIncome.value,d.kpi.netIncome.delta, true);
  if (q('#ccKpiMargin')) q('#ccKpiMargin').textContent = _ccFmt(d.kpi.grossMargin.value, 1) + '%';

  // Operational pulse
  if (q('#ccOpShifts'))   q('#ccOpShifts').textContent   = d.ops.openShifts;
  if (q('#ccOpTxns'))     q('#ccOpTxns').textContent     = d.ops.openTransactions;
  if (q('#ccOpPayments')) q('#ccOpPayments').innerHTML   = d.ops.pendingPayments.count + ' <small style="font-size:11px;color:#64748b;font-weight:600;">(' + _ccFmt(d.ops.pendingPayments.amount) + ')</small>';
  if (q('#ccOpAR'))       q('#ccOpAR').innerHTML         = d.ops.arOutstanding.count + ' <small style="font-size:11px;color:#64748b;font-weight:600;">(' + _ccFmt(d.ops.arOutstanding.amount) + ')</small>';
  if (q('#ccOpAP'))       q('#ccOpAP').innerHTML         = d.ops.apOutstanding.count + ' <small style="font-size:11px;color:#64748b;font-weight:600;">(' + _ccFmt(d.ops.apOutstanding.amount) + ')</small>';
  if (q('#ccOpCash'))     q('#ccOpCash').textContent     = _ccFmt(d.ops.cashInHand);
  if (q('#ccOpLow'))      q('#ccOpLow').textContent      = d.ops.lowStockCount;
  if (q('#ccOpExp'))      q('#ccOpExp').textContent      = d.ops.expiringCount;

  // Charts — destroy previous
  if (state.charts) Object.values(state.charts).forEach(function(c){ if (c && c.destroy) c.destroy(); });
  state.charts = {};

  _ccRenderDailyChart(d.charts.dailySales);
  _ccRenderHourlyChart(d.charts.hourlyToday);
  _ccRenderTopItemsChart(d.charts.topItems);
  _ccRenderTopBrandsChart(d.charts.topBrands);

  // Rankings
  _ccRenderRankingList('ccTopCashiers', d.charts.topCashiers, function(r){ return { name: r.name, meta: r.orders + ' طلب', val: _ccFmt(r.total) }; });
  _ccRenderRankingList('ccTopBrands',   d.charts.topBrands,   function(r){ return { name: r.name, meta: r.count + ' مشترى', val: _ccFmt(r.total) }; });
  _ccRenderRankingList('ccTopProducts', d.charts.topItems,    function(r){ return { name: r.name, meta: _ccFmt(r.qty, 0) + ' وحدة', val: _ccFmt(r.revenue) }; });

  // Alerts
  _ccRenderLowStock(d.alerts.lowStock);
  _ccRenderExpiring(d.alerts.expiringSoon);
  _ccRenderShortages();
}

function _ccSetKpi(id, value, delta, isMoney, digits, invertDelta) {
  var v = q('#'+id); if (v) v.textContent = _ccFmt(value, digits!=null?digits:2);
  var dEl = q('#'+id+'Delta');
  if (dEl) {
    var mode = window._ccFilters.compare || 'previous';
    if (mode === 'none') { dEl.className = 'cc-kpi-delta flat'; dEl.innerHTML = '<small style="color:var(--wo-on-surface-subtle);font-weight:600;">بدون مقارنة</small>'; return; }
    var deltaNum = Number(delta || 0);
    // For expenses/purchases, going DOWN is good — invert the color
    var effective = invertDelta ? -deltaNum : deltaNum;
    var cls = _ccDeltaClass(effective);
    var arrow = deltaNum > 0.5 ? '<i class="fas fa-arrow-up"></i>' : (deltaNum < -0.5 ? '<i class="fas fa-arrow-down"></i>' : '<i class="fas fa-minus"></i>');
    var lbl   = mode === 'yearago' ? 'vs نفس الفترة السنة الماضية' : 'vs الفترة السابقة';
    dEl.className = 'cc-kpi-delta ' + cls;
    dEl.innerHTML = arrow + ' ' + (deltaNum > 0 ? '+' : '') + deltaNum.toFixed(1) + '% <small style="color:var(--wo-on-surface-subtle);font-weight:600;">'+lbl+'</small>';
  }
}

function _ccRenderDailyChart(rows) {
  var ctx = q('#dailySalesChartCtx'); if (!ctx || typeof Chart === 'undefined') return;
  var labels = (rows||[]).map(function(r){ var p = String(r.date).split('-'); return p[2]+'/'+p[1]; });
  var data = (rows||[]).map(function(r){ return Number(r.total||0); });
  state.charts.daily = new Chart(ctx.getContext('2d'), {
    type: 'line',
    data: { labels: labels, datasets: [{
      label: 'المبيعات (SAR)', data: data,
      borderColor: '#6366f1', backgroundColor: 'rgba(99,102,241,0.12)',
      borderWidth: 3, pointBackgroundColor: '#fff', pointBorderColor: '#6366f1', pointBorderWidth: 2, pointRadius: 4, fill: true, tension: 0.4
    }] },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, grid: { color: '#f1f5f9' } }, x: { grid: { display: false } } } }
  });
}

function _ccRenderHourlyChart(rows) {
  var ctx = q('#hourlySalesChartCtx'); if (!ctx || typeof Chart === 'undefined') return;
  var byHour = new Array(24).fill(0);
  (rows||[]).forEach(function(r){ byHour[r.hour] = Number(r.total||0); });
  state.charts.hourly = new Chart(ctx.getContext('2d'), {
    type: 'bar',
    data: { labels: byHour.map(function(_,h){return h+':00';}),
      datasets: [{ label: 'ساعات اليوم (SAR)', data: byHour,
        backgroundColor: '#10b981', borderRadius: 4 }] },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
  });
}

function _ccRenderTopItemsChart(rows) {
  var ctx = q('#topItemsChartCtx'); if (!ctx || typeof Chart === 'undefined') return;
  var top = (rows||[]).slice(0, 8);
  if (!top.length) {
    ctx.getContext('2d').clearRect(0,0,ctx.width,ctx.height);
    return;
  }
  state.charts.topItems = new Chart(ctx.getContext('2d'), {
    type: 'doughnut',
    data: { labels: top.map(function(r){return r.name;}),
      datasets: [{ data: top.map(function(r){return r.revenue;}),
        backgroundColor: ['#f59e0b','#3b82f6','#ec4899','#8b5cf6','#14b8a6','#f43f5e','#84cc16','#06b6d4'],
        borderWidth: 2, hoverOffset: 6 }] },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'right', labels: { boxWidth: 12, font: { size: 11 } } } },
      cutout: '65%' }
  });
}

function _ccRenderTopBrandsChart(rows) {
  var ctx = q('#topBrandsChartCtx'); if (!ctx || typeof Chart === 'undefined') return;
  var top = (rows||[]).filter(function(r){ return r.total > 0; });
  if (!top.length) {
    ctx.getContext('2d').clearRect(0,0,ctx.width,ctx.height);
    return;
  }
  state.charts.topBrands = new Chart(ctx.getContext('2d'), {
    type: 'bar',
    data: { labels: top.map(function(r){return r.name;}),
      datasets: [{ label: 'مشتريات حسب البراند (SAR)', data: top.map(function(r){return r.total;}),
        backgroundColor: '#8b5cf6', borderRadius: 4 }] },
    options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true } } }
  });
}

function _ccRenderRankingList(containerId, rows, fmt) {
  var el = q('#'+containerId); if (!el) return;
  if (!rows || !rows.length) {
    el.innerHTML = '<div class="wo-empty" style="padding:20px;"><i class="fas fa-inbox"></i><span>لا توجد بيانات</span></div>';
    return;
  }
  el.innerHTML = rows.slice(0, 5).map(function(r, i) {
    var o = fmt(r);
    return '<div class="cc-rank-row r-'+(i+1)+'">' +
      '<div class="cc-rank-medal">'+(i+1)+'</div>' +
      '<div class="cc-rank-main"><div class="cc-rank-name">'+_ccEsc(o.name||'')+'</div><div class="cc-rank-meta">'+_ccEsc(o.meta||'')+'</div></div>' +
      '<div class="cc-rank-val">'+_ccEsc(o.val||'')+'</div>' +
    '</div>';
  }).join('');
}

function _ccRenderLowStock(rows) {
  var el = q('#dhLowStock'); if (!el) return;
  if (!rows || !rows.length) {
    el.innerHTML = '<div class="wo-empty" style="padding:20px;color:var(--wo-success-fg);"><i class="fas fa-check-circle"></i><span>المخزون ممتاز — لا نواقص</span></div>';
    return;
  }
  el.innerHTML = rows.map(function(r){
    return '<div class="cc-rank-row">' +
      '<div class="cc-rank-medal" style="background:var(--wo-danger-bg);color:var(--wo-danger);"><i class="fas fa-exclamation"></i></div>' +
      '<div class="cc-rank-main"><div class="cc-rank-name">'+_ccEsc(r.name)+'</div><div class="cc-rank-meta">المخزون الحالي: '+r.stock+' '+_ccEsc(r.unit)+' · الحد: '+r.minStock+'</div></div>' +
      '<div class="cc-rank-val" style="color:var(--wo-danger-fg);">-'+_ccFmt(r.shortfall,0)+'</div>' +
    '</div>';
  }).join('');
}

function _ccRenderExpiring(rows) {
  var el = q('#ccExpiring'); if (!el) return;
  if (!rows || !rows.length) {
    el.innerHTML = '<div class="wo-empty" style="padding:20px;color:var(--wo-success-fg);"><i class="fas fa-check-circle"></i><span>لا أصناف قريبة الانتهاء</span></div>';
    return;
  }
  el.innerHTML = rows.map(function(r){
    var urgent = r.daysLeft != null && r.daysLeft <= 7;
    return '<div class="cc-rank-row">' +
      '<div class="cc-rank-medal" style="background:'+(urgent?'var(--wo-danger-bg)':'var(--wo-warning-bg)')+';color:'+(urgent?'var(--wo-danger)':'var(--wo-warning)')+';"><i class="fas fa-hourglass-half"></i></div>' +
      '<div class="cc-rank-main"><div class="cc-rank-name">'+_ccEsc(r.name)+'</div><div class="cc-rank-meta">'+(r.batchNumber?'دفعة '+_ccEsc(r.batchNumber)+' · ':'')+'ينتهي في '+_ccEsc(r.expiryDate||'—')+'</div></div>' +
      '<div class="cc-rank-val" style="color:'+(urgent?'var(--wo-danger-fg)':'var(--wo-warning-fg)')+';">'+(r.daysLeft!=null?r.daysLeft+' يوم':'—')+'</div>' +
    '</div>';
  }).join('');
}

function _ccRenderShortages() {
  // Reuse the existing getShortageRequests endpoint
  var hdr = { 'Authorization':'Bearer '+(localStorage.getItem('pos_token')||'') };
  fetch('/api/inventory/shortage-requests', { headers: hdr }).then(function(r){return r.json();}).then(function(list){
    var el = q('#dhPendingShortages'); if (!el) return;
    var pending = (list||[]).filter(function(r){ return r.status === 'pending'; });
    if (!pending.length) {
      el.innerHTML = '<div class="wo-empty" style="padding:20px;color:var(--wo-success-fg);"><i class="fas fa-check-circle"></i><span>لا طلبات معلقة</span></div>';
      return;
    }
    el.innerHTML = pending.slice(0, 8).map(function(r) {
      var dt = r.requestDate ? new Date(r.requestDate).toLocaleDateString('en-GB') : '';
      return '<div class="cc-rank-row" onclick="viewAndApproveShortage(\''+r.id+'\')" style="cursor:pointer;">' +
        '<div class="cc-rank-medal" style="background:var(--wo-purple-bg);color:var(--wo-purple);"><i class="fas fa-store"></i></div>' +
        '<div class="cc-rank-main"><div class="cc-rank-name">'+_ccEsc(r.requestNumber||'')+' — '+_ccEsc(r.username||'')+'</div><div class="cc-rank-meta">'+dt+' · '+(r.totalItems||0)+' مادة'+(r.brandName?' · '+_ccEsc(r.brandName):'')+'</div></div>' +
        '<div class="cc-rank-val" style="color:var(--wo-purple);"><i class="fas fa-chevron-left"></i></div>' +
      '</div>';
    }).join('');
  }).catch(function(){});
}
// Legacy body — retained as shim in case anything still references it.
// The new command center uses /api/dashboard/overview via _ccFetchAndRender.
function _loadDashHomeBody() {
  // Build the date range: last 7 days through today (LOCAL dates).
  var today = new Date();
  var todayStr = localDateStr(today);
  var sevenAgo = new Date(today); sevenAgo.setDate(sevenAgo.getDate() - 6);
  var sevenStr = localDateStr(sevenAgo);

  // Widen the server query by 1 day each side to catch sales that fall on
  // an adjacent UTC day (server is UTC, client may be UTC+3, etc.).
  var queryStart = localDateStr(sevenAgo.getTime() - 86400000);
  var queryEnd   = localDateStr(today.getTime() + 86400000);

  // Compute everything from /api/sales — the backend dashboard endpoint
  // returns a simplified shape that doesn't include payment / hourly / top items.
  api.withFailureHandler(function(err) { loader(false); showToast(err.message || 'فشل تحميل الداش بورد', true); })
  .withSuccessHandler(function(sales) {
    loader(false);
    sales = Array.isArray(sales) ? sales : [];

    var todaySales = sales.filter(function(s) {
      return localDateStr(s.date) === todayStr;
    });

    // ─── KPI cards ───
    var totalToday = todaySales.reduce(function(sum, s) { return sum + (Number(s.total) || 0); }, 0);
    var countToday = todaySales.length;
    // Distribute split payments correctly across cash/card buckets
    var todayBuckets = { cash: 0, card: 0, kita: 0, other: 0 };
    todaySales.forEach(function(s) {
      distributePayment(s.payment, Number(s.total) || 0, todayBuckets);
    });

    if (q("#dhTotalSale")) q("#dhTotalSale").innerText = formatVal(totalToday);
    if (q("#dhTotalOrders")) q("#dhTotalOrders").innerText = countToday;
    if (q("#dhTotalCash")) q("#dhTotalCash").innerText = formatVal(todayBuckets.cash);
    if (q("#dhTotalCard")) q("#dhTotalCard").innerText = formatVal(todayBuckets.card);

    // ─── Low stock from the RAW INVENTORY (inv_items), not the menu ───
    // The menu doesn't have its own stock any more — it draws from the raw
    // materials via recipes. So "low stock" must be computed on inv_items.
    api.withSuccessHandler(function(rawList) {
      var lowStock = (rawList || []).filter(function(it) {
        return it.active !== false && (Number(it.stock) || 0) <= (Number(it.minStock) || 0);
      });
      var lsHtml = '';
      if (!lowStock.length) {
        lsHtml = "<div style='text-align:center; padding:30px; color:var(--text-light);'><i class='fas fa-check-circle' style='font-size:40px; color:var(--success); margin-bottom:10px; display:block;'></i>المخزون ممتاز</div>";
      } else {
        lowStock.forEach(function(ls) {
          lsHtml += '<div style="display:flex; justify-content:space-between; align-items:center; padding:12px; background:#fff1f2; border:1px solid #ffe4e6; border-radius:12px; margin-bottom:10px;">'+
            '<span style="font-weight:600; color:#9f1239;">' + (ls.name||'') + '</span>'+
            '<span class="badge red">' + (Number(ls.stock)||0) + ' ' + (ls.unit || 'وحدة') + '</span>'+
          '</div>';
        });
      }
      if (q("#dhLowStock")) q("#dhLowStock").innerHTML = lsHtml;
    }).getInvItems();

    // ─── Pending Shortage Requests from Branches ───
    api.withSuccessHandler(function(list) {
      var container = q('#dhPendingShortages');
      if (!container) return;
      var pending = (list||[]).filter(function(r) { return r.status === 'pending'; });
      if (!pending.length) {
        container.innerHTML = '<div style="text-align:center;padding:16px;color:#94a3b8;font-size:13px;"><i class="fas fa-check-circle" style="color:#16a34a;margin-left:6px;"></i>لا توجد طلبات معلقة</div>';
        return;
      }
      container.innerHTML = pending.map(function(r) {
        var dt = '';
        try { dt = new Date(r.requestDate).toLocaleDateString('en-GB') + ' ' + new Date(r.requestDate).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}); } catch(e) {}
        return '<div style="display:flex;align-items:center;gap:12px;padding:12px 14px;border:1.5px solid #e2e8f0;border-radius:12px;background:#fff;">' +
          '<div style="width:42px;height:42px;border-radius:50%;background:#f3e8ff;display:flex;align-items:center;justify-content:center;flex-shrink:0;"><i class="fas fa-store" style="color:#8b5cf6;font-size:18px;"></i></div>' +
          '<div style="flex:1;min-width:0;">' +
            '<div style="font-weight:800;font-size:14px;color:#1e293b;">' + (r.requestNumber||'') + ' — <span style="color:#8b5cf6;">' + (r.username||'') + '</span></div>' +
            '<div style="font-size:12px;color:#64748b;display:flex;gap:10px;"><span><i class="fas fa-clock" style="margin-left:3px;"></i>' + dt + '</span><span><i class="fas fa-boxes" style="margin-left:3px;"></i>' + (r.totalItems||0) + ' مادة</span></div>' +
          '</div>' +
          '<div style="display:flex;gap:6px;">' +
            '<button class="btn btn-sm btn-primary" onclick="viewAndApproveShortage(\'' + r.id + '\')" style="border-radius:8px;"><i class="fas fa-eye"></i> عرض</button>' +
          '</div>' +
        '</div>';
      }).join('');
    }).getShortageRequests();

    // ─── Charts: destroy old before redraw ───
    if (state.charts) Object.values(state.charts).forEach(function(c) { if (c) c.destroy(); });
    state.charts = {};

    // 1. Daily Sales (last 7 days, line chart) — all keys in LOCAL date.
    var dailyCtx = q("#dailySalesChartCtx");
    if (dailyCtx && typeof Chart !== 'undefined') {
      var byDay = {};
      for (var i = 6; i >= 0; i--) {
        var d2 = new Date(today); d2.setDate(d2.getDate() - i);
        byDay[localDateStr(d2)] = 0;
      }
      sales.forEach(function(s) {
        var k = localDateStr(s.date);
        if (k in byDay) byDay[k] += Number(s.total) || 0;
      });
      var dayLabels = Object.keys(byDay).map(function(k) {
        var p = k.split('-');
        return p[2] + '/' + p[1];
      });
      var dayData = Object.values(byDay);
      state.charts.daily = new Chart(dailyCtx.getContext("2d"), {
        type: 'line',
        data: {
          labels: dayLabels,
          datasets: [{
            label: 'المبيعات (SAR)', data: dayData,
            borderColor: '#6366f1', backgroundColor: 'rgba(99, 102, 241, 0.1)',
            borderWidth: 3, pointBackgroundColor: '#ffffff', pointBorderColor: '#6366f1', pointBorderWidth: 2, pointRadius: 5, fill: true, tension: 0.4
          }]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, grid: { color: '#f8fafc' } }, x: { grid: { display: false } } } }
      });
    }

    // 2. Hourly Sales (today, bar chart)
    var hourlyCtx = q("#hourlySalesChartCtx");
    if (hourlyCtx && typeof Chart !== 'undefined') {
      var byHour = new Array(24).fill(0);
      todaySales.forEach(function(s) {
        try { var h = new Date(s.date).getHours(); byHour[h] += Number(s.total) || 0; } catch(e) {}
      });
      var hourLabels = byHour.map(function(_, h) { return h + ':00'; });
      state.charts.hourly = new Chart(hourlyCtx.getContext("2d"), {
        type: 'bar',
        data: {
          labels: hourLabels,
          datasets: [{
            label: 'مبيعات الساعة (SAR)', data: byHour,
            backgroundColor: '#10b981', borderRadius: 4
          }]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
      });
    }

    // 3. Top Items (Doughnut) — aggregate qty across all 7-day sales
    var topCtx = q("#topItemsChartCtx");
    if (topCtx && typeof Chart !== 'undefined') {
      var byItem = {};
      sales.forEach(function(s) {
        (s.items || []).forEach(function(it) {
          var name = it.name || 'غير معروف';
          if (!byItem[name]) byItem[name] = 0;
          byItem[name] += Number(it.qty) || 0;
        });
      });
      var topArr = Object.entries(byItem).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 8);
      state.charts.top = new Chart(topCtx.getContext("2d"), {
        type: 'doughnut',
        data: {
          labels: topArr.map(function(x) { return x[0]; }),
          datasets: [{
            data: topArr.map(function(x) { return x[1]; }),
            backgroundColor: ['#f59e0b', '#3b82f6', '#ec4899', '#8b5cf6', '#14b8a6', '#f43f5e', '#84cc16', '#06b6d4'],
            borderWidth: 2, hoverOffset: 4
          }]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { boxWidth: 12 } } }, cutout: '70%' }
      });
    }

    // 4. User Sales (Horizontal Bar) — aggregate by cashier across 7 days
    var userCtx = q("#userSalesChartCtx");
    if (userCtx && typeof Chart !== 'undefined') {
      var byUser = {};
      sales.forEach(function(s) {
        var u = s.username || 'غير معروف';
        if (!byUser[u]) byUser[u] = 0;
        byUser[u] += Number(s.total) || 0;
      });
      var userArr = Object.entries(byUser).sort(function(a, b) { return b[1] - a[1]; });
      state.charts.user = new Chart(userCtx.getContext("2d"), {
        type: 'bar',
        data: {
          labels: userArr.map(function(x) { return userLabel(x[0]); }),
          datasets: [{
            label: 'إجمالي مبيعات الكاشير', data: userArr.map(function(x) { return x[1]; }),
            backgroundColor: '#8b5cf6', borderRadius: 4
          }]
        },
        options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true } } }
      });
    }
  }).getSalesListDetailed({ startDate: queryStart, endDate: queryEnd });
}

// Sales Table
function loadDashSales() {
  loader();
  // V3: Prefer new filter bar values if mounted, fallback to legacy IDs
  var f = (typeof getSalesFilters === 'function' && q('#sf_log_start')) ? getSalesFilters('log') : null;
  var start = f ? f.start : (q("#fsStart") ? q("#fsStart").value : "");
  var end   = f ? f.end   : (q("#fsEnd")   ? q("#fsEnd").value   : "");
  // Default: today if no dates set
  if (!start && !end) {
    var today = localDateStr();
    start = today; end = today;
    if (q("#fsStart")) q("#fsStart").value = today;
    if (q("#fsEnd")) q("#fsEnd").value = today;
  }
  var cashier   = f ? f.cashier       : (q("#fsCashier") ? q("#fsCashier").value : "");
  var payMethod = f ? f.paymentMethod : (q("#fsPay") ? q("#fsPay").value : "");
  // V3 filters (only meaningful when new bar is mounted)
  var brandId    = f ? f.brandId : '';
  var branchId   = f ? f.branchId : '';
  var channelId  = f ? f.channelId : '';
  var minAmt     = f ? f.minAmount : 0;
  var maxAmt     = f ? f.maxAmount : 0;
  var invoiceNo  = f ? f.invoiceNo : '';
  var productIds = f ? f.productIds : [];
  // Widen the server query by 1 day on each side to catch timezone drift
  // between the client (local) and server (UTC). We re-filter client-side
  // below so the final rendered list still matches the user's intent.
  var queryStart = localDateStr(new Date(start + 'T00:00:00').getTime() - 86400000);
  var queryEnd   = localDateStr(new Date(end + 'T00:00:00').getTime() + 86400000);
  var params = { startDate: queryStart, endDate: queryEnd };
  if (cashier) params.username = cashier;
  if (payMethod) params.paymentMethod = payMethod;

  api.withFailureHandler(err => { loader(false); showToast(err.message || 'خطأ في جلب بيانات المبيعات', true); }).withSuccessHandler(arr => {
    loader(false);
    // Client-side filter on LOCAL date to offset the ±1 day widening we did
    // on the server query. This ensures "today" really means the user's
    // local today, not server UTC today.
    var startMs = new Date(start + 'T00:00:00').getTime();
    var endMs   = new Date(end   + 'T23:59:59.999').getTime();
    arr = (arr || []).filter(function(r) {
      var t = new Date(r.date).getTime();
      if (isNaN(t) || t < startMs || t > endMs) return false;
      // V3 client-side filters
      if (brandId && r.brandId && r.brandId !== brandId) return false;
      if (branchId && r.branchId && r.branchId !== branchId) return false;
      if (channelId && r.channelId && r.channelId !== channelId) return false;
      if (minAmt > 0 && Number(r.total) < minAmt) return false;
      if (maxAmt > 0 && Number(r.total) > maxAmt) return false;
      if (invoiceNo && (r.orderId || '').toLowerCase().indexOf(invoiceNo.toLowerCase()) < 0) return false;
      if (productIds.length && (!r.items || !r.items.some(function(it){ return productIds.indexOf(String(it.id||it.itemId)) >= 0; }))) return false;
      return true;
    });
    let totalSales = 0;
    let maxInvoice = 0;
    let h = "";
    if (!arr || !arr.length) h = "<tr><td colspan='9' style='text-align:center; padding:30px;'>لا توجد بيانات لهذه الفترة</td></tr>";
    else {
      arr.forEach(s => {
        try {
          totalSales += s.total;
          if (s.total > maxInvoice) maxInvoice = s.total;
          let payType = String(s.payment || "").toLowerCase();
          let isSplit = payType.indexOf(':') !== -1;
          let bClass = isSplit ? 'blue' : (payType === 'cash' ? 'green' : (payType === 'card' || payType === 'mada' ? 'blue' : 'yellow'));
          let payDisplay = paymentLabel(s.payment);
          let itemsHtml = "<div style='display:flex; flex-wrap:wrap; gap:5px;'>";
          if (s.items && s.items.length) {
            s.items.forEach(it => {
              itemsHtml += `<span style="background:#f1f5f9; padding:3px 8px; border-radius:4px; font-size:12px; color:#475569;">${it.qty}x ${it.name}</span>`;
            });
          }
          itemsHtml += "</div>";

          var dateStr = '';
          try { var dt = new Date(s.date); dateStr = dt.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})+' '+dt.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'}); } catch(e){ dateStr = s.date; }
          // V3: channel badge
          var chBadge = s.channelName
            ? '<span style="background:#ede9fe;color:#6d28d9;padding:2px 8px;border-radius:6px;font-size:11px;font-weight:700;">'+s.channelName+'</span>'
            : '<span style="color:#94a3b8;font-size:11px;">—</span>';
          h += '<tr>'+
            (state.isDeveloper ? '<td style="text-align:center;"><input type="checkbox" class="sale-chk" value="'+s.orderId+'" style="width:16px;height:16px;"></td>' : '<td></td>')+
            '<td style="font-family:monospace;font-weight:bold;color:var(--primary);font-size:12px;">'+(s.orderId||'')+'</td>'+
            '<td style="font-size:12px;color:#64748b;">'+dateStr+'</td>'+
            '<td>'+chBadge+'</td>'+
            '<td style="font-weight:600;">'+userLabel(s.username)+'</td>'+
            '<td>'+itemsHtml+'</td>'+
            '<td><span class="badge '+bClass+'">'+payDisplay+'</span></td>'+
            '<td style="font-weight:900;color:var(--secondary);font-size:15px;">'+formatVal(s.total)+'</td>'+
            '<td style="white-space:nowrap;">'+
              '<button class="btn btn-sm btn-primary" onclick="printReceipt(\''+s.orderId+'\')"><i class="fas fa-print"></i></button>'+
              (state.isDeveloper ? ' <button class="btn btn-sm btn-danger" onclick="deleteSingleSale(\''+s.orderId+'\')"><i class="fas fa-trash"></i></button>' : '')+
            '</td>'+
          '</tr>';
        } catch(ex) { console.error("Error rendering row", s, ex); }
      });
    }
    q("#tbSales").innerHTML = h;
    state.salesCache = arr || [];
    if (q("#slTotalSales")) q("#slTotalSales").innerText = formatVal(totalSales);
    if (q("#slTotalCount")) q("#slTotalCount").innerText = arr ? arr.length : 0;
    if (q("#slAvgInvoice")) q("#slAvgInvoice").innerText = formatVal(arr && arr.length ? totalSales / arr.length : 0);
    if (q("#slMaxInvoice")) q("#slMaxInvoice").innerText = formatVal(maxInvoice);
    var bulkBar = q("#salesBulkBar");
    if (bulkBar) bulkBar.style.display = state.isDeveloper && arr && arr.length ? '' : 'none';
  }).getSalesListDetailed(params);
}

// ─── Sales bulk actions (developer only) ───
function toggleAllSales() {
  var checked = q("#salesSelectAll") ? q("#salesSelectAll").checked : false;
  qs(".sale-chk").forEach(function(cb) { cb.checked = checked; });
}

function deleteSingleSale(orderId) {
  if (!confirm('حذف الفاتورة ' + orderId + '؟')) return;
  loader(true);
  api.withSuccessHandler(function(r) {
    loader(false);
    if (r && r.success) { showToast('تم الحذف'); loadDashSales(); }
    else showToast((r && r.error) || 'خطأ', true);
  }).deleteSale(orderId);
}

function deleteSelectedSales() {
  var ids = [];
  qs(".sale-chk:checked").forEach(function(cb) { ids.push(cb.value); });
  if (!ids.length) return showToast('حدد فواتير أولاً', true);
  if (!confirm('حذف ' + ids.length + ' فاتورة نهائياً؟')) return;
  loader(true);
  api.withSuccessHandler(function(r) {
    loader(false);
    if (r && r.success) { showToast('تم حذف ' + (r.deleted || ids.length) + ' فاتورة'); loadDashSales(); }
    else showToast((r && r.error) || 'خطأ', true);
  }).bulkDeleteSales(ids);
}

function exportSelectedSales() {
  ensureXlsx().then(function() {
    var ids = [];
    qs(".sale-chk:checked").forEach(function(cb) { ids.push(cb.value); });
    var data = (state.salesCache || []);
    if (ids.length) data = data.filter(function(s) { return ids.indexOf(s.orderId) !== -1; });
    if (!data.length) return showToast('لا توجد فواتير للتصدير', true);
    var wsData = [['رقم الفاتورة','التاريخ','الكاشير','المنتجات','طريقة الدفع','المبلغ']];
    data.forEach(function(s){
      var items = (s.items||[]).map(function(it){return it.qty+'x '+it.name;}).join(', ');
      wsData.push([s.orderId, s.date, s.username, items, s.payment, Number(s.total)||0]);
    });
    var wb = XLSX.utils.book_new();
    var ws = XLSX.utils.aoa_to_sheet(wsData);
    ws['!cols'] = [{wch:20},{wch:22},{wch:14},{wch:40},{wch:14},{wch:14}];
    XLSX.utils.book_append_sheet(wb, ws, 'فواتير');
    XLSX.writeFile(wb, 'sales-export-' + new Date().toISOString().split('T')[0] + '.xlsx');
    showToast('تم تصدير ' + data.length + ' فاتورة');
  }).catch(function(e){ showToast(e.message, true); });
}

// ═══════════════════════════════════════════════════════════════════
// MENU ADVANCED FILTER SYSTEM (enterprise-grade)
// ═══════════════════════════════════════════════════════════════════
window._menuFilterState = window._menuFilterState || {
  search: '',
  quickFilters: [],       // ['active', 'noRecipe', 'highMargin', ...]
  brand: '',
  category: '',
  priceMin: null, priceMax: null,
  marginMin: null, marginMax: null,
  sortBy: '',
  sortDir: 'asc',         // 'asc' or 'desc'
  groupBy: ''
};
window._menuEnriched = [];   // cached enriched menu data
window._menuAllRecipes = [];

// Save/load filter state in localStorage (key: mt_menu_filter_state)
function _menuSaveState() {
  try { localStorage.setItem('mt_menu_filter_state', JSON.stringify(window._menuFilterState)); } catch(e) {}
}
function _menuLoadState() {
  try {
    var s = localStorage.getItem('mt_menu_filter_state');
    if (s) Object.assign(window._menuFilterState, JSON.parse(s));
  } catch(e) {}
}

// Open/close advanced panel
window.menuToggleAdvanced = function() {
  var panel = q('#menuAdvPanel');
  var btn = q('#menuAdvToggleBtn');
  if (!panel) return;
  panel.classList.toggle('hidden');
  if (btn) btn.classList.toggle('wo-btn-primary', !panel.classList.contains('hidden'));
};

// Quick-filter toggles
window.menuToggleQuickFilter = function(name) {
  var s = window._menuFilterState;
  var i = s.quickFilters.indexOf(name);
  if (i >= 0) s.quickFilters.splice(i, 1);
  else {
    // Mutually-exclusive sets
    var exclusives = {
      active: 'inactive', inactive: 'active',
      highMargin: ['lowMargin','loss'], lowMargin: ['highMargin','loss'], loss: ['highMargin','lowMargin'],
      variable: 'fixed', fixed: 'variable'
    };
    var ex = exclusives[name];
    if (ex) (Array.isArray(ex)?ex:[ex]).forEach(function(e){ var j=s.quickFilters.indexOf(e); if(j>=0) s.quickFilters.splice(j,1); });
    s.quickFilters.push(name);
  }
  _menuSyncToUI();
  menuApplyFilters();
};

// Sort direction toggle
window.menuToggleSortDir = function() {
  var s = window._menuFilterState;
  s.sortDir = s.sortDir === 'asc' ? 'desc' : 'asc';
  var btn = q('#menuSortDir i');
  if (btn) btn.className = 'fas fa-arrow-' + (s.sortDir === 'asc' ? 'down-wide-short' : 'up-short-wide');
  menuApplyFilters();
};

// Reset all filters
window.menuResetFilters = function() {
  window._menuFilterState = {
    search: '', quickFilters: [], brand: '', category: '',
    priceMin: null, priceMax: null, marginMin: null, marginMax: null,
    sortBy: '', sortDir: 'asc', groupBy: ''
  };
  _menuSyncToUI();
  menuApplyFilters();
};

// Sync filter state → UI inputs
function _menuSyncToUI() {
  var s = window._menuFilterState;
  if (q('#menuSearchQ')) q('#menuSearchQ').value = s.search;
  if (q('#menuFilterBrand')) q('#menuFilterBrand').value = s.brand;
  if (q('#menuFilterCategory')) q('#menuFilterCategory').value = s.category;
  if (q('#menuFilterPriceMin')) q('#menuFilterPriceMin').value = s.priceMin != null ? s.priceMin : '';
  if (q('#menuFilterPriceMax')) q('#menuFilterPriceMax').value = s.priceMax != null ? s.priceMax : '';
  if (q('#menuFilterMarginMin')) q('#menuFilterMarginMin').value = s.marginMin != null ? s.marginMin : '';
  if (q('#menuFilterMarginMax')) q('#menuFilterMarginMax').value = s.marginMax != null ? s.marginMax : '';
  if (q('#menuSortBy')) q('#menuSortBy').value = s.sortBy;
  if (q('#menuGroupBy')) q('#menuGroupBy').value = s.groupBy;
  // Quick-filter chip highlights
  qs('.wo-quickfilter').forEach(function(el) {
    var qf = el.getAttribute('data-qf');
    el.classList.toggle('active', s.quickFilters.indexOf(qf) >= 0);
  });
}

// Sync UI inputs → filter state
function _menuReadFromUI() {
  var s = window._menuFilterState;
  s.search = (q('#menuSearchQ') ? q('#menuSearchQ').value : '') || '';
  s.brand = (q('#menuFilterBrand') ? q('#menuFilterBrand').value : '') || '';
  s.category = (q('#menuFilterCategory') ? q('#menuFilterCategory').value : '') || '';
  s.priceMin = q('#menuFilterPriceMin') && q('#menuFilterPriceMin').value !== '' ? Number(q('#menuFilterPriceMin').value) : null;
  s.priceMax = q('#menuFilterPriceMax') && q('#menuFilterPriceMax').value !== '' ? Number(q('#menuFilterPriceMax').value) : null;
  s.marginMin = q('#menuFilterMarginMin') && q('#menuFilterMarginMin').value !== '' ? Number(q('#menuFilterMarginMin').value) : null;
  s.marginMax = q('#menuFilterMarginMax') && q('#menuFilterMarginMax').value !== '' ? Number(q('#menuFilterMarginMax').value) : null;
  s.sortBy = (q('#menuSortBy') ? q('#menuSortBy').value : '') || '';
  s.groupBy = (q('#menuGroupBy') ? q('#menuGroupBy').value : '') || '';
}

// Apply all filters to the enriched cache and render
window.menuApplyFilters = function() {
  _menuReadFromUI();
  _menuSaveState();
  _menuRenderFilteredMenu();
};

// Filter + sort + group + render
function _menuRenderFilteredMenu() {
  var s = window._menuFilterState;
  var enriched = window._menuEnriched || [];
  var esc = (typeof _woEscapeHtml === 'function') ? _woEscapeHtml : function(v){return String(v||'');};

  // Apply text search (normalized: name/id/category/brand)
  var search = (s.search||'').toLowerCase().trim();
  var filtered = enriched.filter(function(row) {
    var i = row.item;
    if (search) {
      var hay = ((i.name||'')+' '+(i.id||'')+' '+(i.category||'')+' '+(i.brandName||'')).toLowerCase();
      if (hay.indexOf(search) < 0) return false;
    }
    if (s.brand && i.brandId !== s.brand) return false;
    if (s.category && i.category !== s.category) return false;
    if (s.priceMin != null && row.sellPrice < s.priceMin) return false;
    if (s.priceMax != null && row.sellPrice > s.priceMax) return false;
    if (s.marginMin != null && row.margin < s.marginMin) return false;
    if (s.marginMax != null && row.margin > s.marginMax) return false;
    // Quick filters
    var qf = s.quickFilters;
    if (qf.indexOf('active') >= 0 && !i.active) return false;
    if (qf.indexOf('inactive') >= 0 && i.active) return false;
    if (qf.indexOf('noRecipe') >= 0 && row.ings.length > 0) return false;
    if (qf.indexOf('highMargin') >= 0 && row.margin <= 40) return false;
    if (qf.indexOf('lowMargin') >= 0 && (row.margin >= 20 || row.margin < 0)) return false;
    if (qf.indexOf('loss') >= 0 && row.profit >= 0) return false;
    if (qf.indexOf('variable') >= 0 && i.pricingMode !== 'variable') return false;
    if (qf.indexOf('fixed') >= 0 && i.pricingMode === 'variable') return false;
    return true;
  });

  // Sort
  if (s.sortBy) {
    var dir = s.sortDir === 'desc' ? -1 : 1;
    filtered.sort(function(a, b) {
      var av, bv;
      if (s.sortBy === 'name') { av = (a.item.name||''); bv = (b.item.name||''); return dir * av.localeCompare(bv, 'ar'); }
      if (s.sortBy === 'price') { av = a.sellPrice; bv = b.sellPrice; }
      else if (s.sortBy === 'cost') { av = a.recipeCost; bv = b.recipeCost; }
      else if (s.sortBy === 'profit') { av = a.profit; bv = b.profit; }
      else if (s.sortBy === 'margin') { av = a.margin; bv = b.margin; }
      else return 0;
      return dir * (av - bv);
    });
  }

  // Group
  var groups = null;
  if (s.groupBy) {
    groups = {};
    filtered.forEach(function(row) {
      var key = '';
      if (s.groupBy === 'category') key = row.item.category || 'بدون تصنيف';
      else if (s.groupBy === 'brand') key = row.item.brandName || 'بدون براند';
      else if (s.groupBy === 'pricingMode') key = row.item.pricingMode === 'variable' ? 'تكلفة متغيرة' : 'تكلفة ثابتة';
      else if (s.groupBy === 'profitBand') {
        if (row.profit < 0) key = 'خاسر';
        else if (row.margin > 40) key = 'ربح عالي (>40%)';
        else if (row.margin > 20) key = 'ربح متوسط (20-40%)';
        else key = 'ربح منخفض (<20%)';
      }
      if (!groups[key]) groups[key] = [];
      groups[key].push(row);
    });
  }

  // Render active filter tags
  _menuRenderActiveFilterTags();

  // Render results count
  var countEl = q('#menuResultsCount');
  if (countEl) countEl.innerHTML = '<i class="fas fa-list-ul"></i> <b>' + filtered.length + '</b> من <b>' + enriched.length + '</b> منتج';

  // Build table HTML
  var h = '';
  var renderRow = function(row) {
    var i = row.item;
    var profitClass = row.profit < 0 ? 'loss' : (row.margin > 40 ? 'high' : (row.margin > 20 ? 'medium' : 'low'));
    var priceBadge = (i.pricingMode === 'variable')
      ? '<span class="wo-chip info flat"><i class="fas fa-arrows-rotate"></i> تكلفة متغيرة</span>'
      : '<span class="wo-chip warning flat"><i class="fas fa-lock"></i> تكلفة ثابتة</span>';
    var costDisplay = row.ings.length
      ? '<span class="wo-money neg">' + formatVal(row.recipeCost) + '</span> <span class="wo-text-subtle wo-text-caption">· ' + row.ings.length + ' مكوّن</span>'
      : '<span class="wo-text-subtle wo-text-caption" style="font-style:italic;">لا توجد مقادير</span>';
    var statusChip = i.active ? '<span class="wo-chip success">نشط</span>' : '<span class="wo-chip neutral">متوقف</span>';
    var brandChip = i.brandName
      ? '<span class="wo-chip purple"><i class="fas fa-store"></i> '+esc(i.brandName)+'</span>'
      : '<span class="wo-chip neutral flat" style="opacity:.6;"><i class="fas fa-minus"></i> بدون</span>';
    return '<tr>'+
      '<td data-label="الكود"><code>'+esc(i.id||'')+'</code></td>'+
      '<td data-label="المنتج"><div style="display:flex;flex-direction:column;gap:4px;"><b>'+esc(i.name||'')+'</b>'+priceBadge+'</div></td>'+
      '<td data-label="البراند">'+brandChip+'</td>'+
      '<td data-label="التصنيف"><span class="wo-chip neutral flat">'+esc(i.category||'—')+'</span></td>'+
      '<td data-label="سعر البيع" class="num strong">'+formatVal(row.sellPrice)+'</td>'+
      '<td data-label="تكلفة المقادير" class="num">'+costDisplay+'</td>'+
      '<td data-label="الربح" class="num"><span class="wo-money '+(row.profit>=0?'pos':'neg')+'">'+formatVal(row.profit)+'</span></td>'+
      '<td data-label="هامش الربح"><span class="wo-profit-bar '+profitClass+'">'+row.margin.toFixed(1)+'%</span></td>'+
      '<td data-label="الحالة">'+statusChip+'</td>'+
      '<td data-label="الإجراءات"><div class="wo-actions">'+
        '<button class="wo-icon-btn info" onclick="openRecipeModal(\''+i.id+'\',\''+String(i.name||'').replace(/\'/g,"\\\'")+'\')" title="المقادير" aria-label="مقادير"><i class="fas fa-blender"></i></button>'+
        '<button class="wo-icon-btn" onclick="openInvM(\'edit\',\''+i.id+'\')" title="تعديل" aria-label="تعديل"><i class="fas fa-pen"></i></button>'+
        '<button class="wo-icon-btn danger" onclick="delInv(\''+i.id+'\')" title="حذف" aria-label="حذف"><i class="fas fa-trash"></i></button>'+
      '</div></td>'+
    '</tr>';
  };

  if (!filtered.length) {
    h = '<tr><td colspan="10">' +
      (typeof _woEmpty === 'function'
        ? _woEmpty('fa-filter-circle-xmark', 'لا توجد نتائج مطابقة',
            (enriched.length ? 'جرّب تعديل الفلاتر أو امسحها بالكامل.' : 'ابدأ بإضافة أول منتج في المنيو.'),
            enriched.length
              ? '<button class="wo-btn wo-btn-secondary" onclick="menuResetFilters()"><i class="fas fa-rotate-left"></i><span>مسح الفلاتر</span></button>'
              : '<button class="wo-btn wo-btn-primary" onclick="openInvM(\'add\')"><i class="fas fa-plus"></i><span>إضافة منتج</span></button>')
        : '<div style="text-align:center;padding:30px;">لا توجد نتائج</div>') +
    '</td></tr>';
  } else if (groups) {
    Object.keys(groups).sort(function(a,b){return a.localeCompare(b,'ar');}).forEach(function(gKey) {
      var grows = groups[gKey];
      var gTotalPrice = grows.reduce(function(s,r){return s + r.sellPrice;}, 0);
      var gTotalProfit = grows.reduce(function(s,r){return s + r.profit;}, 0);
      h += '<tr class="wo-group-header"><td colspan="10"><i class="fas fa-folder-open"></i> ' + esc(gKey) + '<span class="wo-group-count">' + grows.length + '</span>' +
        '<span class="wo-text-subtle wo-text-caption" style="margin-inline-start:12px;">إجمالي سعر البيع: <b>' + formatVal(gTotalPrice) + '</b> · صافي الربح: <b>' + formatVal(gTotalProfit) + '</b></span>' +
        '</td></tr>';
      grows.forEach(function(row) { h += renderRow(row); });
    });
  } else {
    filtered.forEach(function(row) { h += renderRow(row); });
  }

  if (q("#tbMenu")) q("#tbMenu").innerHTML = h;
  if (q("#tbInv")) q("#tbInv").innerHTML = h;
}

// Active filter tags (removable chips)
function _menuRenderActiveFilterTags() {
  var s = window._menuFilterState;
  var tags = [];
  var esc = function(v){return String(v||'').replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});};
  var makeTag = function(label, onRemove) {
    return '<span class="wo-filtertag">' + label + '<button onclick="' + onRemove + '" title="إزالة"><i class="fas fa-xmark"></i></button></span>';
  };

  if (s.search) tags.push(makeTag('🔍 ' + esc(s.search), "q('#menuSearchQ').value='';menuApplyFilters()"));
  if (s.brand) {
    var b = q('#menuFilterBrand');
    var bn = b ? (b.options[b.selectedIndex]||{}).text : s.brand;
    tags.push(makeTag('🏪 ' + esc(bn), "q('#menuFilterBrand').value='';menuApplyFilters()"));
  }
  if (s.category) tags.push(makeTag('🏷️ ' + esc(s.category), "q('#menuFilterCategory').value='';menuApplyFilters()"));
  if (s.priceMin != null) tags.push(makeTag('سعر ≥ ' + s.priceMin, "q('#menuFilterPriceMin').value='';menuApplyFilters()"));
  if (s.priceMax != null) tags.push(makeTag('سعر ≤ ' + s.priceMax, "q('#menuFilterPriceMax').value='';menuApplyFilters()"));
  if (s.marginMin != null) tags.push(makeTag('ربح ≥ ' + s.marginMin + '%', "q('#menuFilterMarginMin').value='';menuApplyFilters()"));
  if (s.marginMax != null) tags.push(makeTag('ربح ≤ ' + s.marginMax + '%', "q('#menuFilterMarginMax').value='';menuApplyFilters()"));

  var qfLabels = {
    active:'نشط فقط', inactive:'متوقف', noRecipe:'بدون مقادير',
    highMargin:'ربح عالي', lowMargin:'ربح منخفض', loss:'خاسر',
    variable:'تكلفة متغيرة', fixed:'تكلفة ثابتة'
  };
  s.quickFilters.forEach(function(qf) {
    tags.push(makeTag(qfLabels[qf] || qf, "menuToggleQuickFilter('" + qf + "')"));
  });

  if (s.sortBy) {
    var sbLabels = { name:'الاسم', price:'السعر', cost:'التكلفة', profit:'الربح', margin:'الهامش' };
    tags.push(makeTag('↕ ' + (sbLabels[s.sortBy] || s.sortBy) + (s.sortDir==='desc'?' ↓':' ↑'), "q('#menuSortBy').value='';menuApplyFilters()"));
  }
  if (s.groupBy) {
    var gbLabels = { category:'التصنيف', brand:'البراند', pricingMode:'نوع التسعير', profitBand:'شريحة الربح' };
    tags.push(makeTag('📂 تجميع: ' + (gbLabels[s.groupBy] || s.groupBy), "q('#menuGroupBy').value='';menuApplyFilters()"));
  }

  var el = q('#menuActiveFilters');
  if (el) el.innerHTML = tags.length ? tags.join('') : '<span class="wo-filtertags-empty">لا توجد فلاتر مفعّلة — كل المنتجات معروضة</span>';
}

// Populate brand + category dropdowns from actual data
function _menuPopulateFilterDropdowns() {
  var enriched = window._menuEnriched || [];
  var brands = {}, cats = {};
  enriched.forEach(function(r) {
    if (r.item.brandId) brands[r.item.brandId] = r.item.brandName || r.item.brandId;
    if (r.item.category) cats[r.item.category] = true;
  });
  var brSel = q('#menuFilterBrand');
  if (brSel) {
    var current = brSel.value;
    brSel.innerHTML = '<option value="">كل البراندات</option>' +
      Object.keys(brands).map(function(id){return '<option value="'+id+'">'+brands[id]+'</option>';}).join('');
    if (current) brSel.value = current;
  }
  var catSel = q('#menuFilterCategory');
  if (catSel) {
    var currentC = catSel.value;
    catSel.innerHTML = '<option value="">كل التصنيفات</option>' +
      Object.keys(cats).sort().map(function(c){return '<option value="'+c+'">'+c+'</option>';}).join('');
    if (currentC) catSel.value = currentC;
  }
}

// Saved views (localStorage key: mt_menu_saved_views)
window.menuToggleSavedViews = function() {
  var menu = q('#menuSavedViewsMenu');
  if (!menu) return;
  if (menu.classList.contains('hidden')) {
    _menuRenderSavedViews();
    menu.classList.remove('hidden');
    setTimeout(function() {
      document.addEventListener('click', _menuSavedViewsOutside);
    }, 100);
  } else {
    menu.classList.add('hidden');
    document.removeEventListener('click', _menuSavedViewsOutside);
  }
};
function _menuSavedViewsOutside(e) {
  var menu = q('#menuSavedViewsMenu');
  if (menu && !menu.contains(e.target) && !e.target.closest('.wo-saved-views button')) {
    menu.classList.add('hidden');
    document.removeEventListener('click', _menuSavedViewsOutside);
  }
}
function _menuRenderSavedViews() {
  var menu = q('#menuSavedViewsMenu');
  if (!menu) return;
  var views = [];
  try { views = JSON.parse(localStorage.getItem('mt_menu_saved_views') || '[]'); } catch(e) {}
  if (!views.length) {
    menu.innerHTML = '<div class="wo-saved-view-empty">لا توجد عروض محفوظة<br><span style="font-size:10px;">استخدم زر "حفظ هذا العرض" في الفلتر المتقدم</span></div>';
    return;
  }
  menu.innerHTML = views.map(function(v, idx) {
    return '<div class="wo-saved-view-item" onclick="menuLoadSavedView(' + idx + ')"><span><i class="fas fa-bookmark" style="color:#8b5cf6;margin-inline-end:6px;"></i>' + v.name + '</span><button class="delete-btn" onclick="event.stopPropagation();menuDeleteSavedView(' + idx + ')"><i class="fas fa-trash"></i></button></div>';
  }).join('');
}
window.menuSaveCurrentView = function() {
  WoModal.prompt({
    icon: 'fa-bookmark', iconColor: 'purple',
    title: 'حفظ العرض الحالي',
    message: 'سيتم حفظ الفلاتر الحالية باسم مخصص لاستدعائها سريعاً لاحقاً.',
    placeholder: 'مثلاً: منتجات الصيف الرابحة',
    validate: function(v) { return v && v.trim().length ? null : 'الاسم مطلوب'; }
  }).then(function(name) {
    if (!name) return;
    var views = [];
    try { views = JSON.parse(localStorage.getItem('mt_menu_saved_views') || '[]'); } catch(e) {}
    views.push({ name: name.trim(), state: JSON.parse(JSON.stringify(window._menuFilterState)) });
    localStorage.setItem('mt_menu_saved_views', JSON.stringify(views));
    showToast('تم حفظ العرض');
  });
};
window.menuLoadSavedView = function(idx) {
  var views = [];
  try { views = JSON.parse(localStorage.getItem('mt_menu_saved_views') || '[]'); } catch(e) {}
  if (!views[idx]) return;
  window._menuFilterState = Object.assign({}, views[idx].state);
  _menuSyncToUI();
  menuApplyFilters();
  var menu = q('#menuSavedViewsMenu'); if (menu) menu.classList.add('hidden');
  showToast('تم تحميل العرض: ' + views[idx].name);
};
window.menuDeleteSavedView = function(idx) {
  var views = [];
  try { views = JSON.parse(localStorage.getItem('mt_menu_saved_views') || '[]'); } catch(e) {}
  views.splice(idx, 1);
  localStorage.setItem('mt_menu_saved_views', JSON.stringify(views));
  _menuRenderSavedViews();
};

// ─── Menu section ───
function loadDashMenu() {
  loader();
  _menuLoadState();
  api.withSuccessHandler(function(m) {
    state.menu = m || [];
    api.withSuccessHandler(function(recipes) {
      api.withSuccessHandler(function(raws) {
        loader(false);
        cachedRawItems = raws || [];
        var allRecipes = recipes || [];
        window._menuAllRecipes = allRecipes;
        var list = state.menu;

        // Build the enriched cache ONCE per data-load (filters operate on this)
        var totalItems = list.length;
        var activeItems = list.filter(function(i){return i.active;}).length;
        var totalSellValue = 0, totalCostValue = 0, totalMargin = 0, marginCount = 0, lossCount = 0;
        window._menuEnriched = list.map(function(i) {
          var sellPrice = Number(i.price)||0;
          var netSell = sellPrice / 1.15;
          var ings = allRecipes.filter(function(r){ return String(r.menuId).trim()===String(i.id).trim(); });
          var recipeCost = 0;
          ings.forEach(function(ing){
            var raw = cachedRawItems.find(function(r){ return String(r.id)===String(ing.invItemId); });
            var uCost = raw ? (Number(raw.cost) || 0) : 0;
            recipeCost += ing.qtyUsed * uCost;
          });
          var profit = netSell - recipeCost;
          var margin = netSell > 0 ? (profit/netSell*100) : 0;
          totalSellValue += netSell; totalCostValue += recipeCost;
          if (ings.length) { totalMargin += margin; marginCount++; }
          if (profit < 0) lossCount++;
          return { item: i, sellPrice: sellPrice, netSell: netSell, ings: ings, recipeCost: recipeCost, profit: profit, margin: margin };
        });
        var avgMargin = marginCount ? (totalMargin / marginCount) : 0;

        // Metric strip — based on ALL data (not filtered)
        var metricsEl = document.getElementById('menuMetrics');
        if (metricsEl && typeof _woMetric === 'function') {
          metricsEl.innerHTML =
            _woMetric('fa-utensils', 'info', 'إجمالي المنتجات', totalItems + ' / ' + activeItems + ' نشط', 'info') +
            _woMetric('fa-tag', 'success', 'إجمالي أسعار البيع (صافي)', totalSellValue.toLocaleString('en',{minimumFractionDigits:2}), 'success') +
            _woMetric('fa-coins', 'warning', 'إجمالي التكاليف', totalCostValue.toLocaleString('en',{minimumFractionDigits:2}), 'warning') +
            _woMetric(lossCount?'fa-triangle-exclamation':'fa-chart-line', lossCount?'danger':'purple',
              'متوسط هامش الربح', avgMargin.toFixed(1) + '%' + (lossCount ? ' · ' + lossCount + ' خاسر' : ''),
              lossCount?'danger':'purple');
        }

        // Populate filter dropdowns from data + sync UI + run filters
        _menuPopulateFilterDropdowns();
        _menuSyncToUI();
        _menuRenderFilteredMenu();
      }).getInvItems();
    }).getRecipes();
  }).getMenuAll();
}

// ─── NEW: Recipes flat table section ───
function loadDashRecipes() {
  loader();
  var search = (q("#recipeSearchQ") ? q("#recipeSearchQ").value : '').toLowerCase();
  api.withSuccessHandler(function(recipes) {
    api.withSuccessHandler(function(raws) {
      api.withSuccessHandler(function(menus) {
        loader(false);
        cachedRawItems = raws || [];
        var allRecipes = recipes || [];
        if (search) {
          allRecipes = allRecipes.filter(function(r) {
            return (r.menuName||'').toLowerCase().includes(search) || (r.invItemName||'').toLowerCase().includes(search);
          });
        }
        // Group by menuId to show subtotals
        var menuMap = {};
        menus.forEach(function(m){ menuMap[m.id] = m; });
        var h = '';
        if (!allRecipes.length) { h = '<tr><td colspan="8" style="text-align:center;padding:30px;">لا توجد مقادير مسجلة</td></tr>'; }
        else {
          allRecipes.forEach(function(r) {
            var raw = cachedRawItems.find(function(x){ return String(x.id)===String(r.invItemId); });
            var cRate = raw ? (Number(raw.convRate)||1) : 1;
            var uCost = raw ? (Number(raw.cost) || 0) : 0;
            var lineCost = r.qtyUsed * uCost;
            var unitName = raw ? (raw.unit||'') : '';
            h += '<tr>'+
              '<td><code style="font-size:11px;">'+(r.menuId||'')+'</code></td>'+
              '<td style="font-weight:700;">'+(r.menuName||'')+'</td>'+
              '<td>'+(r.invItemName||'')+'</td>'+
              '<td style="text-align:center;">'+unitName+'</td>'+
              '<td style="text-align:center;font-weight:700;">'+r.qtyUsed+'</td>'+
              '<td style="text-align:center;">'+formatVal(uCost)+'</td>'+
              '<td style="text-align:center;font-weight:800;color:var(--secondary);">'+formatVal(lineCost)+'</td>'+
              '<td>'+
                '<button class="btn btn-primary btn-sm" onclick="openRecipeModal(\''+r.menuId+'\',\''+String(r.menuName||'').replace(/'/g,"\\'")+'\')" title="تعديل المقادير" style="margin-inline-end: 4px;"><i class="fas fa-edit"></i></button>'+
                '<button class="btn btn-danger btn-sm" onclick="deleteRecipeItem(\''+r.menuId+'\',\''+String(r.menuName||'').replace(/'/g,"\\'")+'\',\''+r.invItemId+'\')" title="حذف المادة من الوصفة"><i class="fas fa-trash"></i></button>'+
              '</td>'+
            '</tr>';
          });
        }
        q("#tbRecipes").innerHTML = h;
      }).getMenuAll();
    }).getInvItems();
  }).getRecipes();
}

// ─── Export Recipes to Excel ───
function exportRecipesExcel() {
  ensureXlsx().then(function() {
    api.withSuccessHandler(function(recipes) {
      api.withSuccessHandler(function(raws) {
        var rawMap = {};
        (raws||[]).forEach(function(r){ rawMap[r.id] = r; });
        // Sheet: المقادير — matches user's Excel structure
        var wsData = [['كود المنتج','اسم المنتج','اسم المادة الخام','كود المادة','الوحدة','الكمية المستخدمة','تكلفة الوحدة','التكلفة الإجمالية']];
        (recipes||[]).forEach(function(r){
          var raw = rawMap[r.invItemId];
          var cRate = raw ? (Number(raw.convRate)||1) : 1;
          var uCost = raw ? (Number(raw.cost) || 0) : 0;
          wsData.push([
            r.menuId||'', r.menuName||'', r.invItemName||'', r.invItemId||'',
            raw ? (raw.unit||'') : '', r.qtyUsed||0, Number(uCost.toFixed(4)), Number((r.qtyUsed*uCost).toFixed(4))
          ]);
        });
        var wb = XLSX.utils.book_new();
        var ws = XLSX.utils.aoa_to_sheet(wsData);
        ws['!cols'] = [{wch:16},{wch:20},{wch:20},{wch:18},{wch:10},{wch:14},{wch:12},{wch:14}];
        XLSX.utils.book_append_sheet(wb, ws, 'المقادير');
        XLSX.writeFile(wb, 'recipes-' + new Date().toISOString().split('T')[0] + '.xlsx');
      }).getInvItems();
    }).getRecipes();
  }).catch(function(e){ showToast(e.message||'فشل تحميل XLSX',true); });
}

// ─── Import Recipes from Excel ───
// Expected columns: كود المنتج, اسم المنتج, اسم المادة الخام (أو كود المادة), الكمية المستخدمة
function importRecipesExcel(input) {
  ensureXlsx().then(function(){ _importRecipesBody(input); }).catch(function(e){ showToast(e.message||'فشل',true); });
}
function _importRecipesBody(input) {
  var file = input.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function(e) {
    try {
      var wb = XLSX.read(e.target.result, { type: 'array' });
      var ws = wb.Sheets[wb.SheetNames[0]];
      var rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
      if (!rows.length) return showToast('الملف فارغ', true);

      // Group by menu item (by code or name)
      var grouped = {}; // menuKey → { menuId, menuName, ingredients: [] }
      rows.forEach(function(r) {
        var menuId   = String(r['كود المنتج'] || r['menuId'] || r['menu_id'] || '').trim();
        var menuName = String(r['اسم المنتج'] || r['menuName'] || r['menu_name'] || '').trim();
        var invName  = String(r['اسم المادة الخام'] || r['المقادير'] || r['invItemName'] || r['ingredient'] || '').trim();
        var invId    = String(r['كود المادة'] || r['invItemId'] || r['inv_item_id'] || '').trim();
        var qtyUsed  = Number(r['الكمية المستخدمة'] || r['التكلفة'] || r['qtyUsed'] || r['qty_used'] || 1) || 1;

        if (!menuName && !menuId) return;
        if (!invName && !invId) return;

        var key = menuId || menuName;
        if (!grouped[key]) grouped[key] = { menuId: menuId, menuName: menuName, ingredients: [] };
        grouped[key].ingredients.push({ invItemId: invId, invItemName: invName, qtyUsed: qtyUsed });
      });

      var keys = Object.keys(grouped);
      if (!keys.length) return showToast('لم يتم العثور على مقادير صالحة في الملف', true);

      // Resolve menu IDs and inv_item IDs from names if needed
      loader(true);
      api.withSuccessHandler(function(menus) {
        api.withSuccessHandler(function(invItems) {
          var menuByName = {};
          (menus||[]).forEach(function(m){ menuByName[m.name.toLowerCase().trim()] = m; });
          var invByName = {};
          (invItems||[]).forEach(function(i){ invByName[i.name.toLowerCase().trim()] = i; });

          var saved = 0, failed = 0, total = keys.length;
          var pending = total;

          keys.forEach(function(key) {
            var g = grouped[key];
            // Resolve menu ID
            var mid = g.menuId;
            var mname = g.menuName;
            if (!mid && mname) {
              var found = menuByName[mname.toLowerCase().trim()];
              if (found) { mid = found.id; mname = found.name; }
            }
            if (!mid) { failed++; pending--; checkDone(); return; }

            // Resolve inv_item IDs for each ingredient
            var cleanIngs = g.ingredients.map(function(ing) {
              var iid = ing.invItemId;
              if (!iid && ing.invItemName) {
                var found = invByName[ing.invItemName.toLowerCase().trim()];
                if (found) iid = found.id;
              }
              return { invItemId: iid || '', invItemName: ing.invItemName, qtyUsed: ing.qtyUsed };
            }).filter(function(ing) { return ing.invItemId; });

            if (!cleanIngs.length) { failed++; pending--; checkDone(); return; }

            api.withSuccessHandler(function(r) {
              if (r && r.success) saved++; else failed++;
              pending--;
              checkDone();
            }).withFailureHandler(function() {
              failed++; pending--;
              checkDone();
            }).saveRecipe(mid, mname, cleanIngs);
          });

          function checkDone() {
            if (pending <= 0) {
              loader(false);
              showToast('تم استيراد مقادير ' + saved + ' منتج' + (failed ? ' (فشل ' + failed + ')' : ''));
              loadDashRecipes();
            }
          }
        }).getInvItems();
      }).getMenuAll();
    } catch(ex) {
      loader(false);
      showToast('خطأ في قراءة الملف: ' + ex.message, true);
    }
  };
  reader.readAsArrayBuffer(file);
  input.value = '';
}

// Keep old loadDashInv as alias
function loadDashInv() { loadDashMenu(); }

function openInvM(mode, id = null) {
  // Load brand options first (every time — brand list may change)
  _loadBrandOptions('#miBrand', function() {
    if (mode === 'add') {
      q("#iMdlTitle").innerText = "إضافة منتج جديد";
      q("#miId").value = ""; q("#miName").value = ""; q("#miCat").value = "عام";
      q("#miPrice").value = ""; q("#miCost").value = "0"; q("#miActive").checked = true;
      q("#miComputedCost").value = "0"; q("#miMarkupPct").value = "30";
      q("#miPricingFixed").checked = true;
      if (q("#miBrand")) q("#miBrand").value = '';
    } else {
      q("#iMdlTitle").innerText = "تعديل المنتج";
      let d = state.menu.find(x => x.id === id);
      if (!d) return;
      q("#miId").value = d.id || ""; q("#miName").value = d.name || ""; q("#miCat").value = d.category || "";
      q("#miPrice").value = d.price || ""; q("#miCost").value = d.cost || "0";
      q("#miComputedCost").value = d.computedCost || "0";
      q("#miMarkupPct").value = d.markupPct || "30";
      q("#miActive").checked = !!d.active;
      if (q("#miBrand")) q("#miBrand").value = d.brandId || d.brand_id || '';
      // Set pricing mode radio
      if (d.pricingMode === 'variable') { q("#miPricingVariable").checked = true; }
      else { q("#miPricingFixed").checked = true; }
    }
    togglePricingMode();
    openModal("#modalInvForm");
  });
}

// Shared helper: load /api/erp/brands into a <select>
function _loadBrandOptions(selector, done) {
  var el = typeof selector === 'string' ? q(selector) : selector;
  if (!el) { if (done) done(); return; }
  var token = localStorage.getItem('pos_token') || '';
  fetch('/api/erp/brands', { headers: { 'Authorization': 'Bearer ' + token } })
    .then(function(r){ return r.json(); })
    .then(function(list){
      if (!Array.isArray(list)) list = [];
      var current = el.value;
      el.innerHTML = '<option value="">— بدون براند (عام) —</option>' +
        list.map(function(b){ return '<option value="'+b.id+'">'+(b.name||'')+(b.code?' ('+b.code+')':'')+'</option>'; }).join('');
      if (current) el.value = current;
      if (done) done();
    })
    .catch(function(){ if (done) done(); });
}

// Toggle: variable cost (from recipes/inventory) vs fixed cost (manual).
// Selling price is ALWAYS manual — this only controls the cost source.
function togglePricingMode() {
  var isFixed = q("#miPricingFixed") && q("#miPricingFixed").checked;
  var manualCostGroup = q("#manualCostGroup");
  if (isFixed) {
    if (manualCostGroup) manualCostGroup.style.display = '';
    if (q("#labelPricingFixed")) q("#labelPricingFixed").style.borderColor = '#3b82f6';
    if (q("#labelPricingVariable")) q("#labelPricingVariable").style.borderColor = '#e2e8f0';
  } else {
    if (manualCostGroup) manualCostGroup.style.display = 'none';
    if (q("#labelPricingVariable")) q("#labelPricingVariable").style.borderColor = '#3b82f6';
    if (q("#labelPricingFixed")) q("#labelPricingFixed").style.borderColor = '#e2e8f0';
  }
}

function saveInv() {
  var pricingMode = q('input[name="miPricingMode"]:checked') ? q('input[name="miPricingMode"]:checked').value : 'fixed';
  const d = {
    id: q("#miId").value, name: q("#miName").value, category: q("#miCat").value,
    brandId: (q("#miBrand") ? q("#miBrand").value : '') || '',
    price: q("#miPrice").value, cost: q("#miCost").value, stock: 9999, minStock: 0, active: q("#miActive").checked,
    pricingMode: pricingMode,
    markupPct: q("#miMarkupPct") ? q("#miMarkupPct").value : 30
  };
  if (!d.name) return showToast("يرجى كتابة اسم المنتج", true);
  if (pricingMode === 'fixed' && !d.price) return showToast("يرجى إدخال سعر البيع", true);

  loader();
  if (d.id) { api.withFailureHandler(err=>{loader(false);showToast(err.message,true);}).withSuccessHandler(r=>{loader(false); closeModal('#modalInvForm'); showToast("تم التعديل"); loadDashMenu();}).updateMenuItem(d); }
  else { api.withFailureHandler(err=>{loader(false);showToast(err.message,true);}).withSuccessHandler(r=>{loader(false); closeModal('#modalInvForm'); showToast("تمت الإضافة"); loadDashMenu();}).addMenuItem(d); }
}

// ─── Export Menu to Excel ───
function exportMenuExcel() {
  ensureXlsx().then(_exportMenuExcelBody).catch(function(e) { showToast(e.message || 'فشل تحميل XLSX', true); });
}
function _exportMenuExcelBody() {
  var headers = ['الاسم', 'التصنيف', 'سعر البيع', 'التكلفة', 'فعال'];
  var data = (state.menu || []).map(function(m) {
    return {
      'الاسم': m.name || '',
      'التصنيف': m.category || '',
      'سعر البيع': m.price || 0,
      'التكلفة': m.cost || 0,
      'فعال': m.active ? 'نعم' : 'لا'
    };
  });
  var ws;
  if (data.length) {
    ws = XLSX.utils.json_to_sheet(data);
  } else {
    ws = XLSX.utils.aoa_to_sheet([headers]);
  }
  ws['!cols'] = [{wch:25},{wch:15},{wch:12},{wch:12},{wch:8}];
  var wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'المنيو');
  var today = new Date().toISOString().slice(0,10);
  XLSX.writeFile(wb, 'menu-products-' + today + '.xlsx');
  showToast(data.length ? 'تم تصدير ' + data.length + ' منتج بنجاح' : 'تم تصدير نموذج فارغ — قم بتعبئته ثم استيراده');
}

// ─── Import Menu from Excel ───
function importMenuExcel(input) {
  ensureXlsx().then(function() { _importMenuExcelBody(input); }).catch(function(e) { showToast(e.message || 'فشل تحميل XLSX', true); });
}
function _importMenuExcelBody(input) {
  var file = input.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function(e) {
    try {
      var wb = XLSX.read(e.target.result, { type: 'array' });
      var ws = wb.Sheets[wb.SheetNames[0]];
      var rows = XLSX.utils.sheet_to_json(ws);
      if (!rows.length) { showToast("الملف فارغ", true); input.value = ''; return; }

      var items = rows.map(function(r) {
        return {
          name: r['الاسم'] || r['name'] || r['Name'] || '',
          category: r['التصنيف'] || r['category'] || r['Category'] || 'عام',
          price: Number(r['سعر البيع'] || r['price'] || r['Price'] || 0),
          cost: Number(r['التكلفة'] || r['cost'] || r['Cost'] || 0),
          stock: 9999,
          minStock: 0,
          active: r['فعال'] === 'لا' ? false : true
        };
      }).filter(function(i) { return i.name; });

      if (!items.length) { showToast("لم يتم العثور على منتجات صالحة", true); input.value = ''; return; }

      if (!confirm('سيتم استيراد ' + items.length + ' منتج. المنتجات الموجودة بنفس الاسم سيتم تحديثها. متابعة؟')) { input.value = ''; return; }

      loader();
      api.withSuccessHandler(function(res) {
        loader(false);
        if (res.success) {
          showToast('تم الاستيراد: ' + (res.imported||0) + ' جديد، ' + (res.updated||0) + ' محدث');
          loadDashInv();
        } else {
          showToast(res.error || 'خطأ في الاستيراد', true);
        }
      }).withFailureHandler(function(err) {
        loader(false);
        showToast(err.message || 'خطأ في الاستيراد', true);
      }).importMenuItems({ items: items });
    } catch(ex) {
      showToast("خطأ في قراءة الملف: " + ex.message, true);
    }
    input.value = '';
  };
  reader.readAsArrayBuffer(file);
}

function delInv(id) {
  if (confirm("هل أنت متأكد من حذف/إيقاف هذا المنتج؟")) {
    loader(); api.withFailureHandler(err=>{loader(false);showToast(err.message,true);}).withSuccessHandler(r=>{loader(false); showToast("تم التنفيذ"); loadDashInv();}).deleteMenuItem(id);
  }
}

function openMovM(id, name) {
  q("#movId").value = id || ""; q("#movName").innerText = name || ""; q("#movQty").value = 1; q("#movNotes").value = "";
  openModal("#modalStockMove");
}

function saveStockMove() {
  loader();
  api.withFailureHandler(err=>{loader(false);showToast(err.message,true);}).withSuccessHandler(r => {
    loader(false); closeModal("#modalStockMove"); showToast("تم تحديث المخزون"); loadDashInv(); loadDashInvItems();
  }).updateStock(q("#movId").value, q("#movQty").value, q("#movType").value, q("#movNotes").value, state.user, "تسوية من لوحة التحكم");
}

// =========================================
// 6.b. Raw Materials (INV_Items) Management
// =========================================
let cachedRawItems = [];

// =========================================
// Warehouse Tabs
// =========================================
function switchWhTab(tab) {
  qs('#whTabs .sales-tab').forEach(t => t.classList.remove('active'));
  qs('#sec_warehouse .sales-tab-content').forEach(c => c.classList.remove('active'));
  const tabEl = q('#whtab_' + tab);
  const contentEl = q('#wh_' + tab);
  if (tabEl) tabEl.classList.add('active');
  if (contentEl) contentEl.classList.add('active');
  if (tab === 'items') loadDashInvItems();
  if (tab === 'live') loadLiveInventory();
  if (tab === 'stocktake') loadDashStocktake();
  if (tab === 'adjustments') loadDashAdjustments();
  if (tab === 'transfers') loadDashTransfers();
  if (tab === 'shortage') loadDashShortageRequests();
}

// =========================================
// Stock Adjustments (تعديل كمية)
// =========================================
var _adjCart = []; // [{id, name, unit, qty, unitCost, stockBefore}]
var _adjReasonLabels = { damaged: 'تالف', admin: 'إداري', settlement: 'تسويات' };

function loadDashAdjustments() {
  loader();
  api.withSuccessHandler(function(res) {
    loader(false);
    var h = '';
    if (!res || !res.length) {
      h = '<tr><td colspan="8" style="text-align:center;padding:30px;">لا توجد محاضر تعديل سابقة</td></tr>';
    } else {
      res.forEach(function(a) {
        var dateStr = a.date ? new Date(a.date).toLocaleString('ar-SA') : '';
        var reasonBadge = '<span class="badge ' + (a.reason === 'damaged' ? 'red' : (a.reason === 'admin' ? 'blue' : 'yellow')) + '">' + (a.reasonLabel || a.reason) + '</span>';
        var statusBadge = a.status === 'approved'
          ? '<span class="badge green">معتمد ✓</span>'
          : '<span class="badge yellow">بانتظار الاعتماد</span>';
        h += '<tr>' +
          '<td style="font-family:monospace;font-size:12px;color:#64748b;">' + a.id + '</td>' +
          '<td>' + dateStr + '</td>' +
          '<td>' + reasonBadge + '</td>' +
          '<td style="font-weight:600;">' + a.username + '</td>' +
          '<td style="text-align:center;">' + a.itemsCount + '</td>' +
          '<td style="font-weight:800;color:#ef4444;">' + formatVal(a.totalCost) + ' SAR</td>' +
          '<td>' + statusBadge + '</td>' +
          '<td style="white-space:nowrap;">' +
            '<button class="btn btn-primary btn-sm" onclick="viewAdjustmentDetail(\'' + a.id + '\')" title="عرض"><i class="fas fa-eye"></i></button> ' +
            (a.status !== 'approved' ? '<button class="btn btn-success btn-sm" onclick="approveAdjustment(\'' + a.id + '\')" title="اعتماد"><i class="fas fa-check"></i></button> ' : '') +
            '<button class="btn btn-light btn-sm" onclick="printAdjustment(\'' + a.id + '\')" title="طباعة"><i class="fas fa-print"></i></button> ' +
            (a.status !== 'approved' || state.isDeveloper ? '<button class="btn btn-danger btn-sm" onclick="deleteAdjustment(\'' + a.id + '\')" title="حذف"><i class="fas fa-trash"></i></button>' : '') +
          '</td></tr>';
      });
    }
    q("#tbAdjustments").innerHTML = h;
  }).getAllAdjustments();
}

function openAdjustmentModal() {
  _adjCart = [];
  // Create modal dynamically if not exists
  if (!q('#modalAdjustment')) {
    var m = document.createElement('div');
    m.id = 'modalAdjustment';
    m.className = 'modal';
    m.innerHTML =
      '<div class="modal-content modal-large">' +
        '<div class="modal-title"><i class="fas fa-minus-circle" style="color:var(--danger);"></i> محضر تعديل كمية جديد<button class="modal-close" onclick="closeModal(\'#modalAdjustment\')">&times;</button></div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px;">' +
          '<div class="form-group"><label class="form-label">سبب التعديل *</label>' +
            '<select id="adjReason" class="form-control"><option value="damaged">تالف</option><option value="admin">إداري</option><option value="settlement">تسويات</option></select></div>' +
          '<div class="form-group"><label class="form-label">ملاحظات</label><input type="text" id="adjNotes" class="form-control" placeholder="تفاصيل إضافية..."></div>' +
        '</div>' +
        '<div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;align-items:flex-end;">' +
          '<div style="flex:1;min-width:200px;position:relative;">' +
            '<label style="font-size:11px;color:#64748b;font-weight:600;">المادة</label>' +
            '<input type="text" id="adjItemSearch" class="form-control" placeholder="ابحث عن مادة..." oninput="filterAdjItems()" onfocus="filterAdjItems()">' +
            '<div id="adjSearchResults" style="position:absolute;top:100%;left:0;right:0;z-index:100;background:#fff;border:1px solid #e2e8f0;border-radius:8px;max-height:200px;overflow-y:auto;display:none;box-shadow:0 4px 12px rgba(0,0,0,0.1);"></div>' +
          '</div>' +
          '<div id="adjBigQtyGroup" style="display:none;">' +
            '<label style="font-size:11px;color:#64748b;font-weight:600;" id="adjBigLabel">كبرى</label>' +
            '<input type="number" id="adjQtyBig" class="form-control" style="width:70px;" placeholder="0" min="0" step="1">' +
          '</div>' +
          '<div>' +
            '<label style="font-size:11px;color:#64748b;font-weight:600;" id="adjSmallLabel">الكمية</label>' +
            '<input type="number" id="adjQty" class="form-control" style="width:80px;" placeholder="0" min="0" step="0.01">' +
          '</div>' +
          '<button class="btn btn-danger" style="height:40px;" onclick="addAdjItem()"><i class="fas fa-plus"></i></button>' +
        '</div>' +
        '<div class="table-wrapper" style="max-height:300px;overflow-y:auto;">' +
          '<table class="table" style="font-size:13px;"><thead><tr><th>المادة</th><th>الوحدة</th><th>الكمية المخصومة</th><th>تكلفة الوحدة</th><th>إجمالي التكلفة</th><th>المخزون قبل</th><th>المخزون بعد</th><th></th></tr></thead>' +
          '<tbody id="adjCartBody"></tbody></table>' +
        '</div>' +
        '<div id="adjTotalRow" style="text-align:left;font-weight:900;font-size:16px;color:#ef4444;margin-top:8px;"></div>' +
        '<div style="display:flex;gap:10px;margin-top:15px;">' +
          '<button class="btn btn-danger" style="flex:1;" onclick="submitAdjustment()"><i class="fas fa-check-double"></i> حفظ المحضر (بانتظار الاعتماد)</button>' +
          '<button class="btn btn-light" onclick="closeModal(\'#modalAdjustment\')">إلغاء</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(m);
  }
  renderAdjCart();
  // Load items for search
  api.withSuccessHandler(function(items) { state._adjAllItems = items || []; }).getInvItems();
  openModal('#modalAdjustment');
}

var _adjSelectedItem = null;
function filterAdjItems() {
  var search = (q('#adjItemSearch') ? q('#adjItemSearch').value : '').toLowerCase();
  var res = q('#adjSearchResults');
  if (!res) return;
  var all = state._adjAllItems || [];
  // Hide items already in cart
  var cartIds = _adjCart.map(function(c) { return c.id; });
  var available = all.filter(function(i) { return cartIds.indexOf(i.id) === -1; });
  var matches = search
    ? available.filter(function(i) { return (i.name || '').toLowerCase().includes(search) || (i.id || '').toLowerCase().includes(search); })
    : available;
  if (!matches.length) { res.innerHTML = '<div style="padding:8px;color:#94a3b8;">لا توجد نتائج</div>'; res.style.display = 'block'; return; }
  res.innerHTML = matches.map(function(i) {
    var stk = Number(i.stock) || 0;
    var stkColor = stk <= (Number(i.minStock)||0) ? '#ef4444' : '#16a34a';
    return '<div style="padding:8px 12px;cursor:pointer;border-bottom:1px solid #f1f5f9;display:flex;justify-content:space-between;" onclick="selectAdjItem(\'' + i.id + '\')">' +
      '<strong>' + i.name + '</strong> <span style="font-size:11px;color:' + stkColor + ';font-weight:700;">' + stk + ' ' + (i.unit || '') + '</span></div>';
  }).join('');
  res.style.display = 'block';
}

function selectAdjItem(itemId) {
  _adjSelectedItem = (state._adjAllItems || []).find(function(i) { return i.id === itemId; });
  if (!_adjSelectedItem) return;
  if (q('#adjItemSearch')) q('#adjItemSearch').value = _adjSelectedItem.name;
  if (q('#adjSearchResults')) q('#adjSearchResults').style.display = 'none';
  // Show big unit field if item has one
  var hasBig = _adjSelectedItem.bigUnit && Number(_adjSelectedItem.convRate) > 1;
  var bigGroup = q('#adjBigQtyGroup');
  if (bigGroup) bigGroup.style.display = hasBig ? '' : 'none';
  if (q('#adjBigLabel')) q('#adjBigLabel').textContent = _adjSelectedItem.bigUnit || '';
  if (q('#adjSmallLabel')) q('#adjSmallLabel').textContent = _adjSelectedItem.unit || 'حبة';
  if (q('#adjQtyBig')) q('#adjQtyBig').value = '';
  if (q('#adjQty')) { q('#adjQty').value = ''; q('#adjQty').focus(); }
}

function addAdjItem() {
  if (!_adjSelectedItem) return showToast('اختر مادة أولاً', true);
  if (_adjCart.find(function(c) { return c.id === _adjSelectedItem.id; })) {
    return showToast('هذه المادة موجودة بالفعل في المحضر', true);
  }
  var i = _adjSelectedItem;
  var cRate = Number(i.convRate) || 1;
  var bigQty = Number(q('#adjQtyBig') ? q('#adjQtyBig').value : 0) || 0;
  var smallQty = Number(q('#adjQty') ? q('#adjQty').value : 0) || 0;
  // Total in small units: (bigQty × convRate) + smallQty
  var totalSmall = (bigQty * cRate) + smallQty;
  if (totalSmall <= 0) return showToast('أدخل كمية صحيحة', true);
  var stockBefore = Number(i.stock) || 0;
  _adjCart.push({
    id: i.id, name: i.name, unit: i.unit || '', bigUnit: i.bigUnit || '', convRate: cRate,
    qty: totalSmall, bigQtyEntered: bigQty, smallQtyEntered: smallQty,
    unitCost: Number(i.cost) || 0, stockBefore: stockBefore
  });
  _adjSelectedItem = null;
  if (q('#adjItemSearch')) q('#adjItemSearch').value = '';
  if (q('#adjQty')) q('#adjQty').value = '';
  if (q('#adjQtyBig')) q('#adjQtyBig').value = '';
  if (q('#adjBigQtyGroup')) q('#adjBigQtyGroup').style.display = 'none';
  renderAdjCart();
}

function renderAdjCart() {
  var tb = q('#adjCartBody');
  if (!tb) return;
  if (!_adjCart.length) {
    tb.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#94a3b8;padding:20px;">لم تتم إضافة مواد</td></tr>';
    if (q('#adjTotalRow')) q('#adjTotalRow').textContent = '';
    return;
  }
  var total = 0;
  tb.innerHTML = _adjCart.map(function(c, idx) {
    var lineCost = c.qty * c.unitCost;
    total += lineCost;
    var after = c.stockBefore - c.qty;
    // Display entered qty nicely: "1 كرتون + 50 حبة" if both entered
    var qtyDisplay = '';
    if (c.bigQtyEntered > 0 && c.smallQtyEntered > 0) {
      qtyDisplay = c.bigQtyEntered + ' ' + (c.bigUnit||'') + ' + ' + c.smallQtyEntered + ' ' + (c.unit||'');
    } else if (c.bigQtyEntered > 0) {
      qtyDisplay = c.bigQtyEntered + ' ' + (c.bigUnit||'');
    } else {
      qtyDisplay = c.qty + ' ' + (c.unit||'');
    }
    return '<tr>' +
      '<td style="font-weight:700;">' + c.name + '</td>' +
      '<td style="text-align:center;font-weight:800;color:#ef4444;">' + qtyDisplay + '</td>' +
      '<td style="text-align:center;font-size:11px;color:#64748b;">(' + c.qty.toFixed(2) + ' ' + (c.unit||'') + ')</td>' +
      '<td style="text-align:center;">' + formatVal(c.unitCost) + '</td>' +
      '<td style="text-align:center;font-weight:800;color:#ef4444;">' + formatVal(lineCost) + '</td>' +
      '<td style="text-align:center;">' + c.stockBefore.toFixed(2) + '</td>' +
      '<td style="text-align:center;font-weight:800;color:' + (after < 0 ? '#ef4444' : '#16a34a') + ';">' + (after < 0 ? 0 : after).toFixed(2) + '</td>' +
      '<td><button class="btn btn-danger btn-sm" onclick="_adjCart.splice(' + idx + ',1);renderAdjCart();filterAdjItems();"><i class="fas fa-trash"></i></button></td>' +
    '</tr>';
  }).join('');
  if (q('#adjTotalRow')) q('#adjTotalRow').innerHTML = 'إجمالي تكلفة التالف/التعديل: <span style="font-size:20px;">' + formatVal(total) + ' SAR</span>';
}

function submitAdjustment() {
  if (!_adjCart.length) return showToast('أضف مواد للمحضر', true);
  var reason = q('#adjReason') ? q('#adjReason').value : 'damaged';
  var notes = q('#adjNotes') ? q('#adjNotes').value : '';
  if (!confirm('سيتم إنشاء محضر تعديل كمية بعدد ' + _adjCart.length + ' صنف. المحضر سيكون بانتظار الاعتماد. متابعة؟')) return;
  loader(true);
  api.withSuccessHandler(function(r) {
    loader(false);
    if (r && r.success) {
      closeModal('#modalAdjustment');
      showToast('تم إنشاء المحضر ' + (r.adjustmentId || '') + ' — بانتظار الاعتماد');
      loadDashAdjustments();
    } else showToast((r && r.error) || 'خطأ', true);
  }).withFailureHandler(function(e) { loader(false); showToast(e.message, true); })
  .submitAdjustment({ items: _adjCart, reason: reason, reasonNotes: notes, username: state.user });
}

function approveAdjustment(adjId) {
  if (!confirm('اعتماد المحضر وخصم الكميات من المخزون؟')) return;
  loader(true);
  api.withSuccessHandler(function(r) {
    loader(false);
    if (r && r.success) { showToast('تم الاعتماد وخصم الكميات ✓'); loadDashAdjustments(); loadDashInvItems(); }
    else showToast((r && r.error) || 'خطأ', true);
  }).approveAdjustment(adjId, state.user);
}

function deleteAdjustment(adjId) {
  if (!confirm('حذف المحضر؟')) return;
  loader(true);
  api.withSuccessHandler(function(r) {
    loader(false);
    if (r && r.success) { showToast('تم الحذف'); loadDashAdjustments(); }
    else showToast((r && r.error) || 'خطأ', true);
  }).deleteAdjustment(adjId);
}

function viewAdjustmentDetail(adjId) {
  loader();
  api.withSuccessHandler(function(a) {
    loader(false);
    if (!a || a.error) return showToast(a && a.error || 'خطأ', true);
    var dateStr = a.date ? new Date(a.date).toLocaleString('ar-SA') : '';
    var h = '<div style="margin-bottom:14px;">' +
      '<div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:10px;">' +
        '<div><strong>رقم المحضر:</strong> <code>' + a.id + '</code></div>' +
        '<div><strong>التاريخ:</strong> ' + dateStr + '</div>' +
        '<div><strong>السبب:</strong> <span class="badge ' + (a.reason === 'damaged' ? 'red' : 'blue') + '">' + (a.reasonLabel || a.reason) + '</span></div>' +
        '<div><strong>المنشئ:</strong> ' + a.username + '</div>' +
        '<div><strong>الحالة:</strong> ' + (a.status === 'approved' ? '<span class="badge green">معتمد (' + (a.approvedBy || '') + ')</span>' : '<span class="badge yellow">بانتظار</span>') + '</div>' +
      '</div>' +
      (a.reasonNotes ? '<div style="background:#fefce8;padding:8px 12px;border-radius:8px;font-size:13px;border:1px solid #fef08a;">' + a.reasonNotes + '</div>' : '') +
    '</div>' +
    '<table class="table" style="font-size:13px;"><thead><tr>' +
      '<th>المادة</th><th>الوحدة</th><th>الكمية</th><th>تكلفة الوحدة</th><th>إجمالي التكلفة</th><th>المخزون قبل</th><th>المخزون بعد</th>' +
    '</tr></thead><tbody>';
    (a.items || []).forEach(function(i) {
      h += '<tr>' +
        '<td style="font-weight:700;">' + i.invItemName + '</td>' +
        '<td>' + i.unit + '</td>' +
        '<td style="text-align:center;font-weight:800;color:#ef4444;">' + i.qty.toFixed(2) + '</td>' +
        '<td style="text-align:center;">' + formatVal(i.unitCost) + '</td>' +
        '<td style="text-align:center;font-weight:800;color:#ef4444;">' + formatVal(i.totalCost) + '</td>' +
        '<td style="text-align:center;">' + i.stockBefore.toFixed(2) + '</td>' +
        '<td style="text-align:center;font-weight:800;">' + i.stockAfter.toFixed(2) + '</td>' +
      '</tr>';
    });
    h += '</tbody></table>';
    h += '<div style="text-align:left;font-weight:900;font-size:16px;color:#ef4444;margin-top:8px;">إجمالي التكلفة: ' + formatVal(a.totalCost) + ' SAR</div>';
    if (!q('#modalAdjDetail')) {
      var m = document.createElement('div'); m.id = 'modalAdjDetail'; m.className = 'modal';
      m.innerHTML = '<div class="modal-content modal-large"><div class="modal-title">محضر تعديل الكمية<button class="modal-close" onclick="closeModal(\'#modalAdjDetail\')">&times;</button></div><div id="adjDetailBody"></div><div style="display:flex;gap:10px;margin-top:15px;"><button class="btn btn-primary" onclick="printAdjustment(state._viewingAdjId)"><i class="fas fa-print"></i> طباعة</button><button class="btn btn-light" onclick="closeModal(\'#modalAdjDetail\')">إغلاق</button></div></div>';
      document.body.appendChild(m);
    }
    state._viewingAdjId = adjId;
    q('#adjDetailBody').innerHTML = h;
    openModal('#modalAdjDetail');
  }).getAdjustmentDetail(adjId);
}

function printAdjustment(adjId) {
  loader();
  api.withSuccessHandler(function(a) {
    loader(false);
    if (!a || a.error) return showToast('خطأ', true);
    var company = (state.settings && state.settings.name) || 'Moroccan Taste';
    var dateStr = a.date ? new Date(a.date).toLocaleString('ar-SA') : '';
    var rows = (a.items || []).map(function(i, idx) {
      return '<tr><td>' + (idx + 1) + '</td><td style="font-weight:700;">' + i.invItemName + '</td><td>' + i.unit + '</td>' +
        '<td style="font-weight:800;color:#ef4444;">' + i.qty.toFixed(2) + '</td>' +
        '<td>' + formatVal(i.unitCost) + '</td><td style="font-weight:800;color:#ef4444;">' + formatVal(i.totalCost) + '</td>' +
        '<td>' + i.stockBefore.toFixed(2) + '</td><td>' + i.stockAfter.toFixed(2) + '</td></tr>';
    }).join('');
    var reasonLabel = _adjReasonLabels[a.reason] || a.reason;
    var w = window.open('', '_blank', 'width=900,height=700');
    w.document.write(
      '<html dir="rtl"><head><meta charset="UTF-8"><title>محضر تعديل كمية ' + a.id + '</title>' +
      '<style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:Arial,sans-serif;direction:rtl;padding:30px;color:#1e293b;font-size:13px;}' +
      'h2{text-align:center;margin-bottom:4px;}h3{text-align:center;color:#ef4444;margin-bottom:14px;}' +
      '.meta{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin:14px 0;}.meta div{background:#f8fafc;padding:10px 14px;border-radius:10px;border:1px solid #e2e8f0;}.meta .lbl{font-size:10px;color:#64748b;}.meta .val{font-weight:700;}' +
      'table{width:100%;border-collapse:collapse;margin-top:12px;}th,td{border:1px solid #ddd;padding:8px 10px;text-align:right;}th{background:#f1f5f9;font-weight:700;}' +
      '.total{text-align:center;margin-top:14px;font-weight:900;font-size:18px;color:#ef4444;padding:14px;background:#fef2f2;border-radius:12px;border:2px solid #fecaca;}' +
      '.sig{display:flex;justify-content:space-around;margin-top:40px;}.sig div{text-align:center;}.sig .line{width:150px;border-bottom:1px solid #94a3b8;padding-top:40px;margin:0 auto;}.sig .cap{font-size:11px;color:#64748b;margin-top:4px;}' +
      '@media print{body{padding:10px;}}</style></head><body>' +
      '<h2>' + company + '</h2><h3>محضر تعديل كمية — ' + reasonLabel + '</h3>' +
      '<div class="meta">' +
        '<div><div class="lbl">رقم المحضر</div><div class="val">' + a.id + '</div></div>' +
        '<div><div class="lbl">التاريخ</div><div class="val">' + dateStr + '</div></div>' +
        '<div><div class="lbl">المنشئ</div><div class="val">' + a.username + '</div></div>' +
        '<div><div class="lbl">السبب</div><div class="val" style="color:#ef4444;">' + reasonLabel + '</div></div>' +
        '<div><div class="lbl">عدد الأصناف</div><div class="val">' + a.itemsCount + '</div></div>' +
        '<div><div class="lbl">الحالة</div><div class="val">' + (a.status === 'approved' ? 'معتمد ✓' : 'بانتظار الاعتماد') + '</div></div>' +
      '</div>' +
      (a.reasonNotes ? '<div style="background:#fefce8;padding:10px;border-radius:8px;border:1px solid #fef08a;font-size:12px;margin-bottom:10px;">ملاحظات: ' + a.reasonNotes + '</div>' : '') +
      '<table><thead><tr><th>#</th><th>المادة</th><th>الوحدة</th><th>الكمية</th><th>تكلفة الوحدة</th><th>إجمالي التكلفة</th><th>المخزون قبل</th><th>المخزون بعد</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<div class="total">إجمالي تكلفة التالف / التعديل: ' + formatVal(a.totalCost) + ' SAR</div>' +
      '<div class="sig"><div><div class="line"></div><div class="cap">المنشئ</div></div><div><div class="line"></div><div class="cap">مدير المستودع</div></div><div><div class="line"></div><div class="cap">المدير العام</div></div></div>' +
      '</body></html>'
    );
    w.document.close();
    setTimeout(function() { w.print(); }, 400);
  }).getAdjustmentDetail(adjId);
}

function calcSmallUnitCost() {
  var cost = Number(q('#mrCost').value) || 0;
  var rate = Number(q('#mrConvRate').value) || 1;
  var small = rate > 0 ? (cost / rate) : 0;
  if (q('#mrSmallCost')) q('#mrSmallCost').value = small ? small.toFixed(4) : '0';
}
function calcBigUnitCost() {
  var small = Number(q('#mrSmallCost').value) || 0;
  var rate = Number(q('#mrConvRate').value) || 1;
  var big = small * rate;
  if (q('#mrCost')) q('#mrCost').value = big ? big.toFixed(2) : '0';
}

function filterInvItems() {
  if (!cachedRawItems || !cachedRawItems.length) return loadDashInvItems();
  renderInvTable(applyInvFilters(cachedRawItems));
}
function applyInvFilters(items) {
  var search = (q("#rawSearchQ")?.value||'').toLowerCase();
  var cat = q("#rawCatFilter")?.value||'';
  var brandF = q("#rawBrandFilter")?.value||'';
  var stockF = q("#rawStockFilter")?.value||'';
  return items.filter(function(i){
    var matchSearch = !search || (i.name||'').toLowerCase().includes(search) || (i.id||'').toLowerCase().includes(search) || (i.category||'').toLowerCase().includes(search) || (i.brandName||'').toLowerCase().includes(search);
    var matchCat = !cat || (i.category||'') === cat;
    var matchBrand = !brandF || (brandF === '__none__' ? !i.brandId : i.brandId === brandF);
    var matchStock = !stockF || (stockF==='low' && i.stock<=i.minStock && i.stock>0) || (stockF==='out' && i.stock<=0) || (stockF==='ok' && i.stock>i.minStock);
    return matchSearch && matchCat && matchBrand && matchStock;
  });
}
function populateInvCatFilter() {
  var sel = q("#rawCatFilter");
  if (!sel || !cachedRawItems) return;
  var cats = []; cachedRawItems.forEach(function(i){ if(i.category && cats.indexOf(i.category)<0) cats.push(i.category); });
  sel.innerHTML = '<option value="">كل التصنيفات</option>' + cats.map(function(c){ return '<option value="'+c+'">'+c+'</option>'; }).join('');
  // Also populate brand filter from live data
  _populateWhBrandFilters();
}

// Populate all warehouse-tab brand filter dropdowns from /api/erp/brands
function _populateWhBrandFilters() {
  var token = localStorage.getItem('pos_token') || '';
  fetch('/api/erp/brands', { headers: { 'Authorization': 'Bearer ' + token } })
    .then(function(r){ return r.json(); })
    .then(function(list){
      if (!Array.isArray(list)) list = [];
      var opts = '<option value="">🏪 كل البراندات</option>' +
        list.map(function(b){ return '<option value="'+b.id+'">'+(b.name||'')+(b.code?' ('+b.code+')':'')+'</option>'; }).join('') +
        '<option value="__none__">— بدون براند —</option>';
      ['#rawBrandFilter','#liveBrandFilter','#stocktakeBrandFilter','#adjBrandFilter','#transferBrandFilter','#shortageBrandFilter'].forEach(function(sel){
        var el = q(sel);
        if (el) {
          var current = el.value;
          el.innerHTML = opts;
          if (current) el.value = current;
        }
      });
    })
    .catch(function(){});
}
function loadDashInvItems() {
  loader();
  api.withFailureHandler(function(err) { loader(false); showToast(err.message, true); }).withSuccessHandler(function(items) {
    loader(false);
    cachedRawItems = items || [];
    populateInvCatFilter();
    renderInvTable(applyInvFilters(cachedRawItems));
  }).getInvItems();
}
function renderInvTable(list) {
    
    let h = "";
    if(!list.length) h = "<tr><td colspan='10' style='text-align:center;'>\u0644\u0627 \u062a\u0648\u062c\u062f \u0645\u0648\u0627\u062f \u062e\u0627\u0645 \u0645\u0633\u062c\u0644\u0629</td></tr>";
    else {
      let grandTotal = 0;
      list.forEach(i => {
        try {
          let stClass = i.stock <= i.minStock ? 'red' : 'green';
          let cRate = Number(i.convRate) || 1;
          let hasBigUnit = !!i.bigUnit;

          let bigQty = hasBigUnit ? (i.stock / cRate).toFixed(2) : i.stock;
          let smallQty = i.stock;
          // inv_items.cost = per SMALL unit (after WAC). Derive big from small.
          let smallCost = i.cost;
          let bigCost = hasBigUnit ? (i.cost * cRate) : i.cost;
          let totalValue = smallQty * smallCost;
          grandTotal += totalValue;

          let bigUnitDisplay = hasBigUnit ? `
            <div style="font-weight:900; color:var(--primary); margin-bottom:4px;">${bigQty} <span style="font-size:11px; color:#64748b;">${i.bigUnit}</span></div>
            <div style="font-size:12px; color:#0369a1;"><i class="fas fa-tag"></i> ${formatVal(bigCost)} SAR/${i.bigUnit}</div>
          ` : `<span style="color:#94a3b8; font-size:12px;">\u0646\u0641\u0633 \u0627\u0644\u0648\u062d\u062f\u0629</span>`;

          let smallUnitDisplay = `
            <div style="font-weight:900; color:var(--primary); margin-bottom:4px;">${smallQty} <span style="font-size:11px; color:#64748b;">${i.unit || '\u062d\u0628\u0629'}</span></div>
            <div style="font-size:12px; color:#16a34a;"><i class="fas fa-tag"></i> ${formatVal(smallCost)} SAR/${i.unit || '\u062d\u0628\u0629'}</div>
          `;

          let brandHtml = i.brandName
            ? `<span class="badge" style="background:#ede9fe;color:#6d28d9;font-weight:700;"><i class="fas fa-store"></i> ${i.brandName}</span>`
            : `<span class="badge" style="background:#f1f5f9;color:#94a3b8;"><i class="fas fa-minus"></i> بدون</span>`;
          h += `<tr>
            <td style="font-family:monospace; color:var(--text-light); font-size:12px;">${i.id || ''}</td>
            <td style="font-weight:800; color:var(--text-dark);">${i.name || ''}</td>
            <td>${brandHtml}</td>
            <td><span class="badge" style="background:#e2e8f0; color:#475569;">${i.category || ''}</span></td>
            <td style="background:#f8fafc; border-right:2px solid #e2e8f0;">${bigUnitDisplay}</td>
            <td style="background:#f0fdf4;">${smallUnitDisplay}</td>
            <td style="font-weight:800; color:#7c3aed;">${formatVal(totalValue)} SAR</td>
            <td><span class="badge ${stClass}">${i.minStock}</span></td>
            <td>${i.active ? '<i class="fas fa-check-circle" style="color:var(--success);"></i>' : '<i class="fas fa-times-circle" style="color:var(--danger);"></i>'}</td>
            <td style="display:flex; gap:8px; justify-content:flex-end;">
              <button class="btn btn-light" style="padding:6px 10px;" onclick="openRawModal('${i.id}')" title="\u062a\u0639\u062f\u064a\u0644"><i class="fas fa-edit"></i></button>
              <button class="btn btn-primary" style="padding:6px 10px;" onclick="openMovM('${i.id}', '${String(i.name||'').replace(/'/g, "\\'")}')" title="\u062d\u0631\u0643\u0629 \u0645\u062e\u0632\u0648\u0646"><i class="fas fa-exchange-alt"></i></button>
              <button class="btn btn-danger" style="padding:6px 10px;" onclick="delRawItem('${i.id}')" title="\u062d\u0630\u0641"><i class="fas fa-trash"></i></button>
            </td>
          </tr>`;
        } catch (ex) { console.error(ex); }
      });
      h += `<tr style="background:#f8fafc; border-top:2px solid var(--border);"><td colspan="6" style="font-weight:900; text-align:center;">\u0625\u062c\u0645\u0627\u0644\u064a \u0642\u064a\u0645\u0629 \u0627\u0644\u0645\u062e\u0632\u0648\u0646</td><td style="font-weight:900; color:#7c3aed; font-size:16px;">${formatVal(grandTotal)} SAR</td><td colspan="3"></td></tr>`;
    }
    if(q("#tbRawItems")) q("#tbRawItems").innerHTML = h;
}

function openRawModal(id = null) {
  _loadBrandOptions('#mrBrand', function() {
    if (!id) {
      q("#rMdlTitle").innerText = "إضافة مادة خام جديدة للمستودع";
      q("#mrId").value = ""; q("#mrName").value = ""; q("#mrCat").value = "";
      q("#mrCost").value = "0"; q("#mrBigUnit").value = ""; q("#mrUnit").value = "حبة"; q("#mrConvRate").value = "1";
      q("#mrStock").value = "0"; q("#mrMin").value = "0";
      if(q("#mrSmallCost")) q("#mrSmallCost").value = "0";
      if (q("#mrBrand")) q("#mrBrand").value = '';
    } else {
      q("#rMdlTitle").innerText = "تعديل مادة خام";
      let d = cachedRawItems.find(x => x.id === id);
      if (!d) return;
      q("#mrId").value = d.id; q("#mrName").value = d.name; q("#mrCat").value = d.category;
      // inv_items.cost is per small unit. The form #mrCost shows per BIG unit.
      var cRate = Number(d.convRate) || 1;
      q("#mrCost").value = (cRate > 1 ? d.cost * cRate : d.cost).toFixed(2);
      q("#mrBigUnit").value = d.bigUnit || ""; q("#mrUnit").value = d.unit || "حبة"; q("#mrConvRate").value = d.convRate || 1;
      q("#mrStock").value = d.stock; q("#mrMin").value = d.minStock;
      if (q("#mrBrand")) q("#mrBrand").value = d.brandId || d.brand_id || '';
    }
    calcSmallUnitCost();
    openModal("#modalRawForm");
  });
}

function saveRawItem() {
  // #mrCost is the big-unit cost from the form. Convert to per-small-unit for storage.
  var bigCostInput = Number(q("#mrCost").value) || 0;
  var cRateInput = Number(q("#mrConvRate").value) || 1;
  var costPerSmall = cRateInput > 1 ? bigCostInput / cRateInput : bigCostInput;
  const d = {
    id: q("#mrId").value, name: q("#mrName").value, category: q("#mrCat").value,
    brandId: (q("#mrBrand") ? q("#mrBrand").value : '') || '',
    cost: costPerSmall, bigUnit: q("#mrBigUnit").value, unit: q("#mrUnit").value, convRate: q("#mrConvRate").value,
    stock: q("#mrStock").value, minStock: q("#mrMin").value, active: true
  };
  if (!d.name) return showToast("يرجى تعبئة اسم المادة الخام", true);
  
  loader();
  api.withSuccessHandler(r => {
    loader(false);
    if(r.success) {
      closeModal('#modalRawForm');
      showToast("تم حفظ المادة الخام بنجاح");
      loadDashInvItems();
    } else { showToast(r.error, true); }
  }).saveInvItem(d);
}

function delRawItem(id) {
  if (confirm("هل أنت متأكد من حذف هذه المادة الخام؟")) {
    loader(); api.withSuccessHandler(r=>{loader(false); showToast("تم الحذف"); loadDashInvItems();}).deleteInvItem(id);
  }
}

// ─── تصدير Excel ───
function exportInvExcel() {
  ensureXlsx().then(_exportInvExcelBody).catch(function(e) { showToast(e.message || 'فشل تحميل XLSX', true); });
}
function _exportInvExcelBody() {
  // Allow export even with no items — exports an empty template the user can fill and re-import
  // inv_items.cost is per SMALL unit. Export shows both: big-unit cost (cost × convRate) and small-unit cost.
  var wsData = [["ID","اسم المادة","التصنيف","تكلفة الوحدة الكبرى","تكلفة الوحدة الصغرى","المخزون (صغرى)","حد التنبيه","الوحدة الصغرى","الوحدة الكبرى","معامل التحويل","نشط"]];
  cachedRawItems.forEach(function(i) {
    var smallCost = Number(i.cost) || 0;
    var cRate = Number(i.convRate) || 1;
    var bigCost = cRate > 1 ? smallCost * cRate : smallCost;
    wsData.push([i.id||'', i.name||'', i.category||'', Number(bigCost.toFixed(4)), Number(smallCost.toFixed(4)), i.stock||0, i.minStock||0, i.unit||'', i.bigUnit||'', cRate, i.active!==false?'TRUE':'FALSE']);
  });
  var wb = XLSX.utils.book_new();
  var ws = XLSX.utils.aoa_to_sheet(wsData);
  ws['!cols'] = [{wch:18},{wch:25},{wch:15},{wch:15},{wch:12},{wch:10},{wch:12},{wch:12},{wch:12},{wch:8}];
  XLSX.utils.book_append_sheet(wb, ws, "مواد المخزون");
  XLSX.writeFile(wb, "مواد_المخزون_" + new Date().toISOString().split('T')[0] + ".xlsx");
  showToast("تم تصدير " + cachedRawItems.length + " مادة");
}

// ─── استيراد Excel ───
function importInvExcel(input) {
  ensureXlsx().then(function() { _importInvExcelBody(input); }).catch(function(e) { showToast(e.message || 'فشل تحميل XLSX', true); });
}
function _importInvExcelBody(input) {
  var file = input.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function(e) {
    try {
      var wb = XLSX.read(e.target.result, {type:'array'});
      var ws = wb.Sheets[wb.SheetNames[0]];
      var rows = XLSX.utils.sheet_to_json(ws, {defval:''});
      if (!rows.length) return showToast("الملف فارغ", true);
      // Map columns (support Arabic or English headers)
      var mapped = rows.map(function(r) {
        var convRate = Number(r['معامل التحويل'] || r['ConvRate'] || r['convRate']) || 1;
        // Cost: accept either big-unit or small-unit cost. Convert big to small for DB storage.
        var bigCost = Number(r['تكلفة الوحدة الكبرى'] || r['سعر الوحدة الكبرى'] || r['Cost'] || r['cost'] || r['السعر']) || 0;
        var smallCost = Number(r['تكلفة الوحدة الصغرى'] || r['SmallCost'] || r['smallCost']) || 0;
        // If small cost is provided, use it directly; otherwise derive from big cost
        var costForDb = smallCost > 0 ? smallCost : (convRate > 1 ? bigCost / convRate : bigCost);
        return {
          id: r['ID'] || r['id'] || r['كود'] || '',
          name: r['اسم المادة'] || r['Name'] || r['name'] || r['الاسم'] || '',
          category: r['التصنيف'] || r['Category'] || r['category'] || '',
          cost: costForDb,
          stock: Number(r['المخزون (صغرى)'] || r['Stock'] || r['stock'] || r['المخزون']) || 0,
          minStock: Number(r['حد التنبيه'] || r['MinStock'] || r['minStock'] || r['الحد الأدنى']) || 0,
          unit: r['الوحدة الصغرى'] || r['Unit'] || r['unit'] || r['الوحدة'] || '',
          bigUnit: r['الوحدة الكبرى'] || r['BigUnit'] || r['bigUnit'] || '',
          convRate: convRate,
          active: String(r['نشط'] || r['Active'] || r['active'] || 'TRUE').toUpperCase() !== 'FALSE'
        };
      }).filter(function(i) { return i.name; });
      if (!mapped.length) return showToast("لم يتم العثور على بيانات صالحة", true);
      if (!confirm("سيتم استيراد " + mapped.length + " مادة. المواد الموجودة سيتم تحديثها. متابعة؟")) return;
      loader(true);
      api.withSuccessHandler(function(r) {
        loader(false);
        if (r.success) { showToast("تم الاستيراد: " + (r.imported||0) + " جديد، " + (r.updated||0) + " محدّث"); loadDashInvItems(); }
        else showToast(r.error || "خطأ", true);
      }).withFailureHandler(function(err) { loader(false); showToast("خطأ: " + err.message, true); }).importInvItems({items: mapped});
    } catch(ex) { showToast("خطأ في قراءة الملف: " + ex.message, true); }
    input.value = '';
  };
  reader.readAsArrayBuffer(file);
}

// =========================================
// 6.b. Product Card
// =========================================
function openProductCard(menuId) {
  loader(true);
  // Load recipes + inv items + menu item
  api.withSuccessHandler(function(recipes) {
    api.withSuccessHandler(function(raws) {
      loader(false);
      var item = state.menu.find(function(m){ return String(m.id)===String(menuId); });
      if (!item) return showToast('المنتج غير موجود','error');

      q("#pcId").value = menuId;
      q("#pcName").textContent = item.name;
      q("#pcCategory").textContent = item.category||'';
      q("#pcPrice").value = item.price;
      q("#pcPrice").oninput = function(){ calcProductCard(); };

      // Get ingredients for this product
      var ings = (recipes||[]).filter(function(r){ return String(r.menuId).trim()===String(menuId).trim(); });
      var totalCost = 0;
      var tbody = q("#pcIngredientsBody");

      if (!ings.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-msg">لا توجد مقادير — اضغط تعديل لإضافتها</td></tr>';
      } else {
        tbody.innerHTML = ings.map(function(ing){
          var raw = (raws||[]).find(function(r){ return String(r.id)===String(ing.invItemId); });
          var unit = raw ? (raw.unit||'') : '';
          var cRate = raw ? (Number(raw.convRate)||1) : 1;
          var unitCost = raw ? (Number(raw.cost) || 0) : 0;
          var ingCost = ing.qtyUsed * unitCost;
          totalCost += ingCost;
          return '<tr>'+
            '<td style="font-weight:600;">'+ing.invItemName+'</td>'+
            '<td style="text-align:center;">'+ing.qtyUsed+'</td>'+
            '<td style="text-align:center;color:#64748b;">'+unit+'</td>'+
            '<td style="text-align:center;">'+unitCost.toFixed(2)+'</td>'+
            '<td style="text-align:center;font-weight:700;color:#ef4444;">'+ingCost.toFixed(2)+'</td>'+
          '</tr>';
        }).join('');
      }

      // Calculate profit
      var sellPrice = Number(item.price)||0;
      var netSell = sellPrice / 1.15;
      var vatSell = sellPrice - netSell;
      q("#pcNetPrice").textContent = netSell.toFixed(2);
      q("#pcVATPrice").textContent = vatSell.toFixed(2);
      q("#pcCost").textContent = totalCost.toFixed(2);
      var profit = netSell - totalCost;
      q("#pcProfit").textContent = profit.toFixed(2);
      q("#pcProfit").style.color = profit>=0 ? '#16a34a' : '#ef4444';
      var margin = netSell > 0 ? (profit/netSell*100) : 0;
      q("#pcMargin").textContent = margin.toFixed(1)+'%';
      q("#pcMargin").style.color = margin>=30 ? '#2563eb' : (margin>=0 ? '#d97706' : '#ef4444');

      openModal("#modalProductCard");
    }).getInvItems();
  }).getRecipes();
}

function calcProductCard() {
  var price = Number(q("#pcPrice").value)||0;
  var net = price/1.15;
  var vat = price - net;
  q("#pcNetPrice").textContent = net.toFixed(2);
  q("#pcVATPrice").textContent = vat.toFixed(2);
  var cost = parseFloat(q("#pcCost").textContent)||0;
  var profit = net - cost;
  q("#pcProfit").textContent = profit.toFixed(2);
  q("#pcProfit").style.color = profit>=0?'#16a34a':'#ef4444';
  var margin = net>0?(profit/net*100):0;
  q("#pcMargin").textContent = margin.toFixed(1)+'%';
}

function saveProductPrice() {
  var menuId = q("#pcId").value;
  var newPrice = Number(q("#pcPrice").value)||0;
  if (newPrice<=0) return showToast('أدخل سعر صحيح','error');
  loader(true);
  api.withSuccessHandler(function(r){
    loader(false);
    if (r.success) {
      showToast('تم تحديث السعر');
      // Update local menu cache
      var item = state.menu.find(function(m){return String(m.id)===String(menuId);});
      if (item) item.price = newPrice;
      renderMenuGrid();
    } else showToast(r.error,'error');
  }).withFailureHandler(function(e){loader(false);showToast(e.message,'error');}).updateMenuPrice(menuId, newPrice);
}

// =========================================
// 6.c. Recipe Management
// =========================================
let currentRecipeIngredients = [];
let cachedAllRecipes = [];

// Open recipe modal for a NEW product — shows a dropdown to pick the menu item first
function openRecipeModalNew() {
  // Load menu items and let user pick one
  loader();
  api.withSuccessHandler(function(menus) {
    loader(false);
    var list = (menus || []).filter(function(m) { return m.active !== false; });
    if (!list.length) return showToast('لا توجد منتجات في المنيو — أضف منتجاً أولاً', true);
    // Build a simple picker modal
    var h = '<div style="margin-bottom:12px;"><input type="text" id="recPickSearch" class="form-control" placeholder="ابحث عن منتج..." oninput="filterRecipePicker()" style="margin-bottom:10px;"></div>';
    h += '<div id="recPickList" style="max-height:400px;overflow-y:auto;">';
    list.forEach(function(m) {
      h += '<div class="card" style="margin-bottom:8px;padding:14px;cursor:pointer;background:rgba(255,255,255,0.7);border:1px solid #e2e8f0;border-radius:12px;" onclick="pickMenuForRecipe(\'' + m.id + '\',\'' + String(m.name||'').replace(/'/g,"\\'") + '\')">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;"><strong>' + m.name + '</strong><span class="badge" style="background:#e2e8f0;color:#475569;">' + (m.category||'') + '</span></div></div>';
    });
    h += '</div>';
    state._recPickMenus = list;
    if (!q('#modalRecipePick')) {
      var modal = document.createElement('div'); modal.id = 'modalRecipePick'; modal.className = 'modal';
      modal.innerHTML = '<div class="modal-content"><div class="modal-title">اختر منتجاً لإضافة مقاديره<button class="modal-close" onclick="closeModal(\'#modalRecipePick\')">&times;</button></div><div id="recPickBody"></div></div>';
      document.body.appendChild(modal);
    }
    q('#recPickBody').innerHTML = h;
    openModal('#modalRecipePick');
  }).getMenuAll();
}

function filterRecipePicker() {
  var search = (q('#recPickSearch') ? q('#recPickSearch').value : '').toLowerCase();
  var list = state._recPickMenus || [];
  var filtered = search ? list.filter(function(m) { return (m.name||'').toLowerCase().includes(search); }) : list;
  var h = '';
  filtered.forEach(function(m) {
    h += '<div class="card" style="margin-bottom:8px;padding:14px;cursor:pointer;background:rgba(255,255,255,0.7);border:1px solid #e2e8f0;border-radius:12px;" onclick="pickMenuForRecipe(\'' + m.id + '\',\'' + String(m.name||'').replace(/'/g,"\\'") + '\')">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;"><strong>' + m.name + '</strong><span class="badge" style="background:#e2e8f0;color:#475569;">' + (m.category||'') + '</span></div></div>';
  });
  if (q('#recPickList')) q('#recPickList').innerHTML = h || '<div style="text-align:center;color:#94a3b8;padding:20px;">لا توجد نتائج</div>';
}

function pickMenuForRecipe(menuId, menuName) {
  closeModal('#modalRecipePick');
  openRecipeModal(menuId, menuName);
}

function openRecipeModal(menuId, menuName) {
  q("#recMenuId").value = menuId;
  q("#recMenuName").innerText = menuName;
  currentRecipeIngredients = [];
  if (q("#recRawSearch")) q("#recRawSearch").value = "";
  if (q("#recRawId")) q("#recRawId").value = "";
  if (q("#recRawName")) q("#recRawName").value = "";
  if (q("#recQtyInput")) q("#recQtyInput").value = "";

  loader();
  api.withSuccessHandler(function(allRecipes) {
    cachedAllRecipes = allRecipes || [];
    currentRecipeIngredients = cachedAllRecipes.filter(function(r){ return String(r.menuId).trim() === String(menuId).trim(); });
    api.withSuccessHandler(function(raws) {
      cachedRawItems = raws || [];
      renderRecipeTable();
      loader(false);
      openModal("#modalRecipeForm");
      // Debug: if no recipes found, check why
      if (!currentRecipeIngredients.length && cachedAllRecipes.length === 0) {
        window._apiBridge.withSuccessHandler(function(dbg){
          if (dbg) console.log('Recipe Debug:', JSON.stringify(dbg));
          if (dbg && dbg.rows > 1 && dbg.recipes === 0) {
            showToast('تنبيه: يوجد '+dbg.rows+' صف في شيت Recipe لكن getRecipes أرجعت 0. الأعمدة: '+dbg.headers.join(', '), true);
          }
        }).debugRecipes();
      }
    }).withFailureHandler(function(e){ loader(false); showToast('خطأ المواد: '+e.message, true); }).getInvItems();
  }).withFailureHandler(function(e){ loader(false); showToast('خطأ الوصفات: '+e.message, true); }).getRecipes();
}

let recDropOpen = false;
function filterRecipeItems() {
  const search = (q("#recRawSearch").value || "").toLowerCase();
  const items = cachedRawItems || [];
  const results = q("#recRawResults");
  let filtered = items;
  if (search) filtered = items.filter(i => String(i.name||"").toLowerCase().includes(search) || String(i.category||"").toLowerCase().includes(search));

  let h = "";
  filtered.slice(0, 20).forEach(item => {
    const cRate = Number(item.convRate) || 1;
    // inv_items.cost is already per small unit — no division needed
    const smallCost = Number(item.cost) || 0;
    h += `<div class="sd-result-item" onclick="selectRecipeItem('${String(item.id).replace(/'/g,"\\'")}','${String(item.name).replace(/'/g,"\\'")}')">
      <div><span class="sd-item-name">${item.name}</span></div>
      <span class="sd-item-meta">${item.unit||'\u062d\u0628\u0629'} | ${formatVal(smallCost)} SAR</span>
    </div>`;
  });
  results.innerHTML = h;
  results.classList.add('open');
  recDropOpen = true;
}

function selectRecipeItem(id, name) {
  q("#recRawSearch").value = name;
  q("#recRawId").value = id;
  q("#recRawName").value = name;
  q("#recRawResults").classList.remove('open');
  recDropOpen = false;
}

function renderRecipeTable() {
  var h = "";
  var totalCost = 0;
  var lowestCost = Infinity, lowestName = '';
  if (!currentRecipeIngredients.length) {
    h = '<tr><td colspan="5" style="text-align:center;color:#94a3b8;">لا يوجد مقادير مسجلة لهذا المنتج</td></tr>';
  } else {
    currentRecipeIngredients.forEach(function(ing, index) {
      var raw = (cachedRawItems || []).find(function(r){return r.id === ing.invItemId;});
      var unit = raw ? (raw.unit || 'حبة') : '';
      // inv_items.cost is already per SMALL unit — do NOT divide by convRate again
      var smallCost = raw ? (Number(raw.cost) || 0) : 0;
      var ingCost = ing.qtyUsed * smallCost;
      totalCost += ingCost;
      if (ingCost < lowestCost && ingCost > 0) { lowestCost = ingCost; lowestName = ing.invItemName; }
      h += '<tr>'+
        '<td style="font-weight:600;">'+ing.invItemName+'</td>'+
        '<td><input type="number" step="0.01" min="0.01" value="'+ing.qtyUsed+'" style="width:70px;text-align:center;padding:4px;border:1px solid #e2e8f0;border-radius:6px;font-weight:700;" onchange="updateRecipeQty('+index+',this.value)"></td>'+
        '<td style="font-weight:700; color:#0369a1;">'+formatVal(ingCost)+' SAR</td>'+
        '<td style="color:#64748b;">'+unit+'</td>'+
        '<td><button class="btn btn-danger" style="padding:5px 10px;" onclick="removeRecipeIngredient('+index+')"><i class="fas fa-trash"></i></button></td>'+
      '</tr>';
    });
  }
  q("#tbRecipeIngs").innerHTML = h;
  var costEl = q("#recipeTotalCost");
  if (costEl) costEl.innerText = formatVal(totalCost) + " SAR";
  // Show lowest cost ingredient
  var lowEl = q("#recipeLowestCost");
  if (lowEl) {
    if (lowestName && lowestCost < Infinity) lowEl.innerHTML = '<i class="fas fa-arrow-down" style="color:#16a34a;"></i> Lowest: <b>'+lowestName+'</b> = '+formatVal(lowestCost)+' SAR';
    else lowEl.innerHTML = '';
  }
}

function updateRecipeQty(index, newQty) {
  var val = Number(newQty);
  if (val > 0 && currentRecipeIngredients[index]) {
    currentRecipeIngredients[index].qtyUsed = val;
    renderRecipeTable();
  }
}

function addIngredientToRecipe() {
  const rawId = q("#recRawId") ? q("#recRawId").value : "";
  const qty = parseFloat(q("#recQtyInput").value);
  if (!rawId || isNaN(qty) || qty <= 0) return showToast("\u064a\u0631\u062c\u0649 \u062a\u062d\u062f\u064a\u062f \u0645\u0627\u062f\u0629 \u0648\u0643\u0645\u064a\u0629 \u0635\u062d\u064a\u062d\u0629", true);

  const rawItem = cachedRawItems.find(r => r.id === rawId);
  if (!rawItem) return showToast("المادة غير موجودة", true);
  // Prevent duplicate ingredients
  var dup = currentRecipeIngredients.find(function(ing) { return ing.invItemId === rawItem.id; });
  if (dup) return showToast("هذه المادة موجودة بالفعل في المقادير — عدّل الكمية بدلاً من إضافتها مرة أخرى", true);
  currentRecipeIngredients.push({ invItemId: rawItem.id, invItemName: rawItem.name, qtyUsed: qty });

  q("#recRawSearch").value = "";
  q("#recRawId").value = "";
  q("#recRawName").value = "";
  q("#recQtyInput").value = "";
  // Close the search dropdown
  if (q("#recRawResults")) q("#recRawResults").classList.remove('open');
  recDropOpen = false;
  renderRecipeTable();
}

function removeRecipeIngredient(index) {
  currentRecipeIngredients.splice(index, 1);
  renderRecipeTable();
}

function saveRecipe() {
  var menuId = q("#recMenuId").value;
  var menuName = q("#recMenuName").innerText;
  if (!menuId) return showToast('خطأ: معرف المنتج مفقود', true);
  // Allow saving empty recipe (to clear/delete all ingredients)

  // Clean ingredients data
  var cleanIngs = currentRecipeIngredients.map(function(ing){
    return { invItemId: String(ing.invItemId||''), invItemName: String(ing.invItemName||''), qtyUsed: Number(ing.qtyUsed)||0 };
  }).filter(function(ing){ return ing.invItemId && ing.qtyUsed > 0; });

  // Empty cleanIngs = delete all ingredients (allowed)

  loader();
  api.withSuccessHandler(function(r) {
    loader(false);
    if (r && r.success) {
      showToast("تم حفظ الوصفة: " + cleanIngs.length + " مكون");
      closeModal("#modalRecipeForm");
      // Refresh inventory list so the margin/profit/cost columns reflect the new recipe
      if (typeof loadDashInv === 'function') loadDashInv();
    } else { showToast((r&&r.error)||'فشل الحفظ — النتيجة: '+JSON.stringify(r), true); }
  }).withFailureHandler(function(e){ loader(false); showToast('خطأ saveRecipe: '+e.message, true); })
  .saveRecipe(menuId, menuName, cleanIngs);
}

function deleteRecipeItem(menuId, menuName, invItemId) {
  if(!confirm('هل أنت متأكد من مسح هذه المادة الخام من وصفة المنتج؟')) return;
  loader(true);
  api.withSuccessHandler(function(recipes) {
    var cleanIngs = [];
    (recipes || []).filter(function(r) { return String(r.menuId) === String(menuId); }).forEach(function(r) {
      if (String(r.invItemId) !== String(invItemId)) {
        cleanIngs.push({ invItemId: r.invItemId, invItemName: r.invItemName, qtyUsed: r.qtyUsed });
      }
    });

    api.withSuccessHandler(function() {
      loader(false);
      showToast('تم مسح المادة من الوصفة البنجاح');
      if (typeof loadDashRecipes === 'function') loadDashRecipes();
    }).withFailureHandler(function(e) {
      loader(false);
      showToast('خطأ أثناء الحذف: ' + e.message, true);
    }).saveRecipe(menuId, menuName, cleanIngs);

  }).withFailureHandler(function(e) {
    loader(false);
    showToast('خطأ في جلب الوصفات: ' + e.message, true);
  }).getRecipes();
}
// =========================================
// 6.d. Transfers and Stocktake Stubs
// =========================================
// =========================================
// Shortage Requests + Receive Approval (طلبات النواقص + الاستلامات)
// =========================================
function loadDashShortageRequests() {
  // Also load pending receives
  api.withSuccessHandler(function(rcvList) {
    var rcvTb = q('#tbShortageRequests');
    if (rcvTb && rcvList && rcvList.length) {
      var rcvRows = rcvList.map(function(r) {
        var items = r.receivedItems || [];
        return '<tr style="background:rgba(16,163,74,0.04);">' +
          '<td><code style="font-weight:800;color:#16a34a;"><i class="fas fa-truck-loading"></i> استلام</code></td>' +
          '<td>' + (r.poNumber || r.id) + '</td>' +
          '<td style="font-weight:700;">' + (r.receivedBy||'') + '</td>' +
          '<td>' + items.length + ' مادة</td>' +
          '<td><span class="badge yellow">بانتظار الموافقة</span></td>' +
          '<td style="white-space:nowrap;">' +
            '<button class="btn btn-success btn-sm" onclick="approveReceiveReq(\'' + r.id + '\')" title="موافقة استلام"><i class="fas fa-check-double"></i> اعتماد الاستلام</button> ' +
            '<button class="btn btn-light btn-sm" onclick="viewReceiveDetail(\'' + r.id + '\')" title="تفاصيل"><i class="fas fa-eye"></i></button>' +
          '</td></tr>';
      }).join('');
      rcvTb.insertAdjacentHTML('afterbegin', rcvRows);
    }
  }).getReceiveRequests();

  api.withSuccessHandler(function(list) {
    var tb = q('#tbShortageRequests');
    if (!tb) return;
    if (!list) list = [];
    // Apply brand filter (client-side)
    var brandF = q('#shortageBrandFilter') ? q('#shortageBrandFilter').value : '';
    if (brandF) {
      list = list.filter(function(r){
        return brandF === '__none__' ? !r.brandId : r.brandId === brandF;
      });
    }
    if (!list.length) { tb.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:30px;color:#94a3b8;">لا توجد طلبات نواقص</td></tr>'; return; }
    var statusBadge = function(s) {
      if (s === 'pending') return '<span class="badge yellow">بانتظار</span>';
      if (s === 'approved') return '<span class="badge blue">معتمد</span>';
      if (s === 'converted') return '<span class="badge green">تم التحويل لأمر شراء</span>';
      if (s === 'rejected') return '<span class="badge red">مرفوض</span>';
      return '<span class="badge">' + s + '</span>';
    };
    tb.innerHTML = list.map(function(r) {
      var dt = r.requestDate ? new Date(r.requestDate).toLocaleDateString('en-GB') : '';
      var actions = '';
      if (r.status === 'pending') {
        actions = '<button class="btn btn-success btn-sm" onclick="approveShortageReq(\'' + r.id + '\')" title="اعتماد"><i class="fas fa-check"></i></button> ' +
          '<button class="btn btn-danger btn-sm" onclick="rejectShortageReq(\'' + r.id + '\')" title="رفض"><i class="fas fa-times"></i></button>';
      } else if (r.status === 'approved') {
        actions = '<button class="btn btn-primary btn-sm" onclick="convertShortageToPO(\'' + r.id + '\')" title="تحويل لأمر شراء"><i class="fas fa-shopping-cart"></i> تحويل لـ PO</button>';
      }
      actions += ' <button class="btn btn-light btn-sm" onclick="viewShortageDetail(\'' + r.id + '\')" title="تفاصيل"><i class="fas fa-eye"></i></button>';
      var isDev = state.currentUser && (state.currentUser.isDeveloper || state.role === 'admin');
      if (isDev) actions += ' <button class="btn btn-danger btn-sm" onclick="deleteShortageReq(\'' + r.id + '\',\'' + (r.requestNumber||'') + '\')" title="حذف"><i class="fas fa-trash"></i></button>';
      var brandHtml = r.brandName
        ? '<span class="badge" style="background:#ede9fe;color:#6d28d9;font-weight:700;"><i class="fas fa-store"></i> ' + r.brandName + '</span>'
        : '<span class="badge" style="background:#f1f5f9;color:#94a3b8;">—</span>';
      return '<tr>' +
        '<td><code style="font-weight:800;color:#8b5cf6;">' + (r.requestNumber||'') + '</code></td>' +
        '<td>' + dt + '</td>' +
        '<td>' + brandHtml + '</td>' +
        '<td style="font-weight:700;">' + (r.username||'') + '</td>' +
        '<td>' + (r.totalItems||0) + ' مادة</td>' +
        '<td>' + statusBadge(r.status) + '</td>' +
        '<td style="white-space:nowrap;">' + actions + '</td></tr>';
    }).join('');
  }).getShortageRequests();
}

// Stand-alone loader alias for the UI button
window.loadShortageRequests = function() {
  _populateWhBrandFilters();
  if (typeof loadDashShortageRequests === 'function') loadDashShortageRequests();
};
window.loadStocktakeList = function() {
  _populateWhBrandFilters();
  if (typeof loadDashStocktake === 'function') loadDashStocktake();
};
window.loadAdjustmentsList = function() {
  _populateWhBrandFilters();
  if (typeof loadDashAdjustments === 'function') loadDashAdjustments();
};
window.loadTransfersList = function() {
  _populateWhBrandFilters();
  if (typeof loadDashTransfers === 'function') loadDashTransfers();
};

function approveShortageReq(id) {
  if (!confirm('اعتماد طلب النقص؟')) return;
  loader(true);
  api.withSuccessHandler(function(r) {
    loader(false);
    if (r.success) { showToast('تم اعتماد الطلب'); loadDashShortageRequests(); }
    else showToast(r.error, true);
  }).approveShortage(id, { username: state.user, supplyMode: 'parent_company' });
}

function rejectShortageReq(id) {
  var reason = prompt('سبب الرفض:');
  if (reason === null) return;
  loader(true);
  api.withSuccessHandler(function(r) {
    loader(false);
    if (r.success) { showToast('تم رفض الطلب'); loadDashShortageRequests(); }
    else showToast(r.error, true);
  }).rejectShortage(id, { username: state.user, reason: reason });
}

function convertShortageToPO(id) {
  // Show supplier selection
  api.withSuccessHandler(function(suppliers) {
    var opts = (suppliers||[]).map(function(s) { return '<option value="' + s.id + '" data-name="' + (s.name||'') + '">' + (s.name||'') + '</option>'; }).join('');
    var html = '<div class="modal-content"><div class="modal-title">تحويل طلب النقص لأمر شراء<button class="modal-close" onclick="closeModal(\'#modalConvertPO\')">&times;</button></div>' +
      '<div class="form-group"><label class="form-label">المورد *</label><select id="convertSupplier" class="form-control"><option value="">— اختر المورد —</option>' + opts + '</select></div>' +
      '<div style="display:flex;gap:10px;margin-top:15px;"><button class="btn btn-primary" style="flex:1;" onclick="doConvertShortageToPO(\'' + id + '\')"><i class="fas fa-shopping-cart"></i> تحويل لأمر شراء</button><button class="btn btn-light" onclick="closeModal(\'#modalConvertPO\')">إلغاء</button></div></div>';
    if (!document.getElementById('modalConvertPO')) {
      var m = document.createElement('div'); m.id = 'modalConvertPO'; m.className = 'modal'; document.body.appendChild(m);
    }
    document.getElementById('modalConvertPO').innerHTML = html;
    openModal('#modalConvertPO');
  }).getSuppliers();
}

function doConvertShortageToPO(id) {
  var sel = q('#convertSupplier');
  if (!sel || !sel.value) return showToast('اختر المورد', true);
  var opt = sel.options[sel.selectedIndex];
  loader(true);
  api.withSuccessHandler(function(r) {
    loader(false);
    if (r.success) {
      closeModal('#modalConvertPO');
      showToast('تم إنشاء أمر شراء: ' + r.poNumber);
      loadDashShortageRequests();
    } else showToast(r.error, true);
  }).convertShortageToPO(id, { username: state.user, supplierId: sel.value, supplierName: opt.getAttribute('data-name')||'' });
}

// View shortage + approve + convert to PO from dashboard
function viewAndApproveShortage(id) {
  loader(true);
  api.withSuccessHandler(function(data) {
    loader(false);
    if (!data || data.error) return showToast(data && data.error || 'خطأ', true);
    var items = data.items || [];
    var html = '<div style="margin-bottom:14px;display:grid;grid-template-columns:repeat(3,1fr);gap:10px;">' +
      '<div style="background:#f8fafc;padding:12px;border-radius:12px;text-align:center;"><div style="font-size:11px;color:#64748b;">رقم الطلب</div><div style="font-size:16px;font-weight:900;color:#8b5cf6;">' + (data.requestNumber||'') + '</div></div>' +
      '<div style="background:#f8fafc;padding:12px;border-radius:12px;text-align:center;"><div style="font-size:11px;color:#64748b;">الكاشير</div><div style="font-weight:800;">' + (data.username||'') + '</div></div>' +
      '<div style="background:#f8fafc;padding:12px;border-radius:12px;text-align:center;"><div style="font-size:11px;color:#64748b;">عدد المواد</div><div style="font-weight:800;">' + items.length + '</div></div>' +
    '</div>';
    html += '<table class="table" style="font-size:13px;"><thead><tr><th>المادة</th><th>الوحدة</th><th>المخزون</th><th>الحد</th><th>المطلوب</th></tr></thead><tbody>';
    items.forEach(function(i) {
      html += '<tr><td style="font-weight:700;">' + (i.invItemName||'') + '</td><td>' + (i.unit||'') + '</td>' +
        '<td style="color:' + (i.currentQty <= i.minQty ? '#ef4444' : '#16a34a') + ';font-weight:700;">' + i.currentQty + '</td>' +
        '<td>' + i.minQty + '</td><td style="font-weight:800;color:#8b5cf6;">' + i.requestedQty + '</td></tr>';
    });
    html += '</tbody></table>';
    html += '<div style="display:flex;gap:8px;margin-top:14px;">';
    if (data.status === 'pending') {
      html += '<button class="btn btn-success" style="flex:1;" onclick="closeModal(\'#modalShortageView\');approveShortageReq(\'' + id + '\')"><i class="fas fa-check"></i> اعتماد</button>';
      html += '<button class="btn btn-danger" onclick="closeModal(\'#modalShortageView\');rejectShortageReq(\'' + id + '\')"><i class="fas fa-times"></i> رفض</button>';
    }
    if (data.status === 'approved') {
      html += '<button class="btn btn-primary" style="flex:1;" onclick="closeModal(\'#modalShortageView\');convertShortageToPO(\'' + id + '\')"><i class="fas fa-shopping-cart"></i> تحويل لأمر شراء</button>';
    }
    html += '</div>';
    if (!document.getElementById('modalShortageView')) {
      var m = document.createElement('div'); m.id = 'modalShortageView'; m.className = 'modal';
      m.innerHTML = '<div class="modal-content modal-large"><div class="modal-title">تفاصيل طلب النقص<button class="modal-close" onclick="closeModal(\'#modalShortageView\')">&times;</button></div><div id="shortageViewBody"></div></div>';
      document.body.appendChild(m);
    }
    document.getElementById('shortageViewBody').innerHTML = html;
    openModal('#modalShortageView');
  }).getShortageRequest(id);
}

function deleteShortageReq(id, num) {
  if (!confirm('حذف طلب النقص ' + num + ' وجميع بنوده؟\nلا يمكن التراجع.')) return;
  loader(true);
  api.withSuccessHandler(function(r) {
    loader(false);
    if (r.success) { showToast('تم حذف الطلب'); loadDashShortageRequests(); }
    else showToast(r.error, true);
  }).deleteShortageRequest(id);
}

function viewShortageDetail(id) {
  api.withSuccessHandler(function(data) {
    if (!data || data.error) return showToast(data && data.error || 'خطأ', true);
    var items = data.items || [];
    var html = '<div style="margin-bottom:14px;display:grid;grid-template-columns:repeat(3,1fr);gap:10px;">' +
      '<div style="background:#f8fafc;padding:12px;border-radius:12px;text-align:center;"><div style="font-size:11px;color:#64748b;">رقم الطلب</div><div style="font-size:16px;font-weight:900;color:#8b5cf6;">' + (data.requestNumber||'') + '</div></div>' +
      '<div style="background:#f8fafc;padding:12px;border-radius:12px;text-align:center;"><div style="font-size:11px;color:#64748b;">الكاشير</div><div style="font-weight:800;">' + (data.username||'') + '</div></div>' +
      '<div style="background:#f8fafc;padding:12px;border-radius:12px;text-align:center;"><div style="font-size:11px;color:#64748b;">الحالة</div><div style="font-weight:800;">' + (data.status||'') + '</div></div>' +
    '</div>';
    html += '<table class="table" style="font-size:13px;"><thead><tr><th>المادة</th><th>الوحدة</th><th>المخزون الحالي</th><th>الحد الأدنى</th><th>الكمية المطلوبة</th></tr></thead><tbody>';
    items.forEach(function(i) {
      html += '<tr><td style="font-weight:700;">' + (i.invItemName||'') + '</td><td>' + (i.unit||'') + '</td>' +
        '<td style="color:' + (i.currentQty <= i.minQty ? '#ef4444' : '#16a34a') + ';font-weight:700;">' + i.currentQty + '</td>' +
        '<td>' + i.minQty + '</td><td style="font-weight:800;color:#8b5cf6;">' + i.requestedQty + '</td></tr>';
    });
    html += '</tbody></table>';
    if (!document.getElementById('modalShortageDetail')) {
      var m = document.createElement('div'); m.id = 'modalShortageDetail'; m.className = 'modal';
      m.innerHTML = '<div class="modal-content modal-large"><div class="modal-title">تفاصيل طلب النقص<button class="modal-close" onclick="closeModal(\'#modalShortageDetail\')">&times;</button></div><div id="shortageDetailBody"></div></div>';
      document.body.appendChild(m);
    }
    document.getElementById('shortageDetailBody').innerHTML = html;
    openModal('#modalShortageDetail');
  }).getShortageRequest(id);
}

function approveReceiveReq(purchaseId) {
  if (!confirm('اعتماد الاستلام وترحيل المواد للمخزون ودليل الحسابات؟')) return;
  loader(true);
  api.withSuccessHandler(function(r) {
    loader(false);
    if (r.success) {
      showToast('تم اعتماد الاستلام وترحيل القيد: ' + (r.journalNumber||''));
      loadDashShortageRequests();
      loadDashInvItems();
    } else showToast(r.error, true);
  }).approveReceive(purchaseId, { username: state.user });
}

function viewReceiveDetail(purchaseId) {
  api.withSuccessHandler(function(list) {
    var rcv = (list||[]).find(function(r) { return r.id === purchaseId; });
    if (!rcv) return showToast('غير موجود', true);
    var items = rcv.receivedItems || [];
    var html = '<table class="table" style="font-size:13px;"><thead><tr><th>المادة</th><th>المطلوب</th><th>المستلم</th><th>الفرق</th><th>الوحدة</th></tr></thead><tbody>';
    items.forEach(function(it) {
      var diff = (Number(it.receivedQty)||0) - (Number(it.orderedQty)||0);
      var diffColor = diff === 0 ? '#64748b' : (diff < 0 ? '#ef4444' : '#16a34a');
      html += '<tr><td style="font-weight:700;">' + (it.invItemName||it.name||'') + '</td>' +
        '<td style="text-align:center;color:#3b82f6;font-weight:700;">' + (it.orderedQty||it.qty||0) + '</td>' +
        '<td style="text-align:center;font-weight:800;color:#16a34a;">' + (it.receivedQty||0) + '</td>' +
        '<td style="text-align:center;font-weight:800;color:' + diffColor + ';">' + (diff>0?'+':'') + diff + '</td>' +
        '<td style="text-align:center;color:#64748b;">' + (it.unit||'') + '</td></tr>';
    });
    html += '</tbody></table>';
    if (!document.getElementById('modalReceiveDetail')) {
      var m = document.createElement('div'); m.id = 'modalReceiveDetail'; m.className = 'modal';
      m.innerHTML = '<div class="modal-content modal-large"><div class="modal-title">تفاصيل الاستلام<button class="modal-close" onclick="closeModal(\'#modalReceiveDetail\')">&times;</button></div><div id="rcvDetailBody"></div></div>';
      document.body.appendChild(m);
    }
    document.getElementById('rcvDetailBody').innerHTML = html;
    openModal('#modalReceiveDetail');
  }).getReceiveRequests();
}

function loadDashTransfers() {
  // Redirect to ERP multi-warehouse transfers
  if (typeof erpNav === 'function') {
    erpNav('erpMultiWarehouses');
    // Switch to transfers tab
    setTimeout(function() { if (typeof whSwitchTab === 'function') whSwitchTab('transfers'); }, 300);
  } else {
    q("#tbTransfers").innerHTML = "<tr><td colspan='7' style='text-align:center;padding:20px;'>استخدم قسم <b>إدارة المستودعات</b> في نظام ERP للتحويلات</td></tr>";
  }
}
function openTransferModal() {
  if (typeof erpNav === 'function') {
    erpNav('erpMultiWarehouses');
    setTimeout(function() { if (typeof erpOpenTransferModal === 'function') erpOpenTransferModal(); }, 300);
  } else showToast('افتح إدارة المستودعات من نظام ERP', true);
}

// =========================================
// 6.e. Live Inventory 
// =========================================
function loadLiveInventory() {
  loader(true);
  _populateWhBrandFilters();
  var brandF = q("#liveBrandFilter") ? q("#liveBrandFilter").value : '';
  api.withFailureHandler(err => {
    loader(false);
    showToast(err.message || "فشل تحميل المخزون الفعلي", true);
  }).withSuccessHandler(res => {
    loader(false);
    let h = "";
    if (res.error) {
      showToast(res.error, true);
      h = `<tr><td colspan="8" style="text-align:center;color:red;">${res.error}</td></tr>`;
    } else if (!res || res.length === 0) {
      h = "<tr><td colspan='8' style='text-align:center;'>لا توجد مواد مخزون. الرجاء إضافة مواد خام وتحديث الأرصدة.</td></tr>";
    } else {
      // Apply client-side brand filter (getLiveInventory doesn't currently support brandId param)
      let filtered = res;
      if (brandF) {
        filtered = res.filter(function(i){
          return brandF === '__none__' ? !i.brandId : i.brandId === brandF;
        });
      }
      if (!filtered.length) {
        h = "<tr><td colspan='8' style='text-align:center;color:#94a3b8;padding:30px;'>لا توجد مواد ضمن البراند المحدد</td></tr>";
      } else {
        filtered.forEach(item => {
          let statusBadge = '';
          if (item.status === 'نفد') statusBadge = '<span class="badge red">نفد</span>';
          else if (item.status === 'منخفض') statusBadge = '<span class="badge" style="background:#fef3c7; color:#92400e;">منخفض</span>';
          else statusBadge = '<span class="badge green">جيد</span>';

          let brandHtml = item.brandName
            ? `<span class="badge" style="background:#ede9fe;color:#6d28d9;font-weight:700;"><i class="fas fa-store"></i> ${item.brandName}</span>`
            : `<span class="badge" style="background:#f1f5f9;color:#94a3b8;">بدون</span>`;

          let unitDisplay = (item.bigUnit && Number(item.convRate) > 1) ? `${item.unit} (${item.convRate} حبة بالـ ${item.bigUnit})` : (item.unit || '');
          h += `<tr>
            <td style="font-weight:700;">${item.name}</td>
            <td>${brandHtml}</td>
            <td>${item.category}</td>
            <td style="color:#64748b;">${item.initialStock} ${item.unit}</td>
            <td style="color:#16a34a; font-weight:700;">+${item.purchasedQty} ${item.unit} <br><small style="color:#94a3b8">${unitDisplay}</small></td>
            <td style="color:#e11d48; font-weight:700;">-${item.consumedQty} ${item.unit}</td>
            <td style="font-size:16px; font-weight:900; color:var(--primary);">${item.currentStock} ${item.unit}</td>
            <td>${statusBadge}</td>
          </tr>`;
        });
      }
    }
    const tb = q("#tbLiveInventory");
    if (tb) tb.innerHTML = h;
  }).getLiveInventory();
}

let cachedStItems = [];
function loadDashStocktake() {
  loader();
  api.withSuccessHandler(res => {
    loader(false);
    let h = "";
    if (!res || !res.length) {
      h = "<tr><td colspan='6' style='text-align:center; padding:30px;'>لا توجد عمليات جرد سابقة</td></tr>";
    } else {
      res.forEach(st => {
        var dateStr = st.date ? new Date(st.date).toLocaleString('ar-SA') : '';
        var varColor = st.totalVariance === 0 ? '#16a34a' : (st.totalVariance > 0 ? '#2563eb' : '#ef4444');
        h += '<tr>'+
          '<td style="font-family:monospace;color:#64748b;font-size:12px;">'+st.id+'</td>'+
          '<td>'+dateStr+'</td>'+
          '<td style="font-weight:bold;">'+st.username+'</td>'+
          '<td>'+st.itemsCount+' صنف</td>'+
          '<td style="font-weight:800;color:'+varColor+';">'+Number(st.totalVariance).toFixed(2)+'</td>'+
          '<td style="white-space:nowrap;">'+
            '<button class="btn btn-primary btn-sm" onclick="viewStocktakeDetail(\''+st.id+'\')" title="عرض التفاصيل"><i class="fas fa-eye"></i></button> '+
            '<button class="btn btn-light btn-sm" onclick="printStocktake(\''+st.id+'\')" title="طباعة المحضر"><i class="fas fa-print"></i></button> '+
            (state.isDeveloper ? '<button class="btn btn-danger btn-sm" onclick="deleteStocktake(\''+st.id+'\')" title="حذف"><i class="fas fa-trash"></i></button>' : '')+
          '</td>'+
        '</tr>';
      });
    }
    q("#tbStocktake").innerHTML = h;
  }).getAllStocktakes();
}

// View stocktake detail in a modal
function viewStocktakeDetail(stId) {
  loader();
  api.withSuccessHandler(function(st) {
    loader(false);
    if (!st || st.error) return showToast(st && st.error || 'خطأ', true);
    var dateStr = st.date ? new Date(st.date).toLocaleString('ar-SA') : '';
    var h = '<div style="margin-bottom:14px;">'+
      '<div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:10px;">'+
        '<div><strong>رقم المحضر:</strong> <code>'+st.id+'</code></div>'+
        '<div><strong>التاريخ:</strong> '+dateStr+'</div>'+
        '<div><strong>القائم بالجرد:</strong> '+st.username+'</div>'+
        '<div><strong>عدد الأصناف:</strong> '+st.itemsCount+'</div>'+
      '</div>'+
      (st.notes ? '<div style="background:#fefce8;padding:8px 12px;border-radius:8px;font-size:13px;border:1px solid #fef08a;">'+st.notes+'</div>' : '')+
    '</div>'+
    '<table class="table" style="font-size:13px;"><thead><tr>'+
      '<th>المادة</th><th>الوحدة</th><th>رصيد النظام</th><th>الفعلي</th><th>التباين (كمية)</th><th>تكلفة الوحدة</th><th>تكلفة التباين</th>'+
    '</tr></thead><tbody>';
    (st.items || []).forEach(function(i) {
      var vc = i.variance === 0 ? '#64748b' : (i.variance > 0 ? '#16a34a' : '#ef4444');
      var vs = i.variance > 0 ? '+' + i.variance.toFixed(2) : i.variance.toFixed(2);
      var vcost = Number(i.varianceCost) || 0;
      var vcostColor = vcost === 0 ? '#64748b' : (vcost > 0 ? '#16a34a' : '#ef4444');
      h += '<tr>'+
        '<td style="font-weight:700;">'+i.invItemName+'</td>'+
        '<td>'+i.unit+'</td>'+
        '<td style="text-align:center;">'+i.systemQty.toFixed(2)+'</td>'+
        '<td style="text-align:center;font-weight:800;">'+i.actualQty.toFixed(2)+'</td>'+
        '<td style="text-align:center;font-weight:900;color:'+vc+';">'+vs+'</td>'+
        '<td style="text-align:center;">'+formatVal(i.unitCost || 0)+'</td>'+
        '<td style="text-align:center;font-weight:900;color:'+vcostColor+';">'+formatVal(vcost)+'</td>'+
      '</tr>';
    });
    h += '</tbody></table>';
    var tvc = Number(st.totalVarianceCost) || 0;
    var tvcColor = tvc === 0 ? '#16a34a' : (tvc < 0 ? '#ef4444' : '#16a34a');
    h += '<div style="display:flex;justify-content:space-between;margin-top:10px;padding:12px;background:#fef2f2;border:1.5px solid #fecaca;border-radius:10px;">' +
      '<div style="font-weight:900;font-size:15px;color:'+(st.totalVariance===0?'#16a34a':'#ef4444')+';">إجمالي التباين (كمية): '+Number(st.totalVariance).toFixed(2)+'</div>' +
      '<div style="font-weight:900;font-size:15px;color:'+tvcColor+';">تكلفة التباين: '+formatVal(tvc)+' SAR</div>' +
    '</div>';
    // Use a generic modal container
    if (!q("#modalStocktakeDetail")) {
      var m = document.createElement('div');
      m.id = 'modalStocktakeDetail';
      m.className = 'modal';
      m.innerHTML = '<div class="modal-content modal-large"><div class="modal-title">محضر الجرد <button class="modal-close" onclick="closeModal(\'#modalStocktakeDetail\')">&times;</button></div><div id="stDetailBody"></div><div style="display:flex;gap:10px;margin-top:15px;"><button class="btn btn-primary" onclick="printStocktake(state._viewingStId)"><i class="fas fa-print"></i> طباعة المحضر</button><button class="btn btn-light" onclick="closeModal(\'#modalStocktakeDetail\')">إغلاق</button></div></div>';
      document.body.appendChild(m);
    }
    state._viewingStId = stId;
    q("#stDetailBody").innerHTML = h;
    openModal("#modalStocktakeDetail");
  }).getStocktakeDetail(stId);
}

// Print stocktake report
function printStocktake(stId) {
  loader();
  api.withSuccessHandler(function(st) {
    loader(false);
    if (!st || st.error) return showToast('خطأ', true);
    var company = (state.settings && state.settings.name) || 'Moroccan Taste';
    var dateStr = st.date ? new Date(st.date).toLocaleString('ar-SA') : '';
    var rows = (st.items || []).map(function(i, idx) {
      var vc = i.variance === 0 ? '#64748b' : (i.variance > 0 ? '#16a34a' : '#ef4444');
      var vs = i.variance > 0 ? '+' + i.variance.toFixed(2) : i.variance.toFixed(2);
      var vcost = Number(i.varianceCost) || 0;
      return '<tr><td>'+(idx+1)+'</td><td style="font-weight:700;">'+i.invItemName+'</td><td>'+i.unit+'</td><td>'+i.systemQty.toFixed(2)+'</td><td style="font-weight:800;">'+i.actualQty.toFixed(2)+'</td><td style="font-weight:900;color:'+vc+';">'+vs+'</td><td>'+formatVal(i.unitCost||0)+'</td><td style="font-weight:900;color:'+vc+';">'+formatVal(vcost)+'</td></tr>';
    }).join('');
    var tvc = Number(st.totalVarianceCost) || 0;
    var w = window.open('','_blank','width=900,height=700');
    w.document.write(
      '<html dir="rtl"><head><meta charset="UTF-8"><title>محضر جرد '+st.id+'</title>'+
      '<style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:Arial,sans-serif;direction:rtl;padding:30px;color:#1e293b;}'+
      'h2{text-align:center;margin-bottom:6px;}'+
      '.meta{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:14px 0;font-size:13px;}'+
      '.meta div{background:#f8fafc;padding:10px 14px;border-radius:10px;border:1px solid #e2e8f0;}'+
      '.meta .lbl{font-size:10px;color:#64748b;}.meta .val{font-weight:700;}'+
      'table{width:100%;border-collapse:collapse;margin-top:14px;font-size:13px;}'+
      'th,td{border:1px solid #ddd;padding:8px 10px;text-align:right;}th{background:#f1f5f9;font-weight:700;}'+
      '.totals{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:14px;}.tot-box{text-align:center;padding:14px;border-radius:12px;font-weight:900;font-size:16px;}'+
      '.sig{display:flex;justify-content:space-around;margin-top:40px;font-size:13px;}.sig div{text-align:center;}.sig .line{width:150px;border-bottom:1px solid #94a3b8;padding-top:40px;margin:0 auto;}.sig .cap{font-size:11px;color:#64748b;margin-top:4px;}'+
      '@media print{body{padding:10px;}.totals,.meta{-webkit-print-color-adjust:exact;print-color-adjust:exact;}}</style></head><body>'+
      '<h2>'+company+'</h2><h3 style="text-align:center;color:#64748b;margin-bottom:14px;">محضر جرد مخزون</h3>'+
      '<div class="meta"><div><div class="lbl">رقم المحضر</div><div class="val">'+st.id+'</div></div><div><div class="lbl">التاريخ</div><div class="val">'+dateStr+'</div></div><div><div class="lbl">القائم بالجرد</div><div class="val">'+st.username+'</div></div><div><div class="lbl">عدد الأصناف</div><div class="val">'+st.itemsCount+'</div></div></div>'+
      (st.notes ? '<div style="background:#fefce8;padding:10px;border-radius:8px;border:1px solid #fef08a;font-size:12px;margin-bottom:10px;">ملاحظات: '+st.notes+'</div>' : '')+
      '<table><thead><tr><th>#</th><th>المادة</th><th>الوحدة</th><th>رصيد النظام</th><th>الفعلي</th><th>التباين (كمية)</th><th>تكلفة الوحدة</th><th>تكلفة التباين</th></tr></thead><tbody>'+rows+'</tbody></table>'+
      '<div class="totals">'+
        '<div class="tot-box" style="background:#f8fafc;border:1px solid #e2e8f0;color:'+(st.totalVariance===0?'#16a34a':'#ef4444')+';">إجمالي التباين (كمية)<br>'+Number(st.totalVariance).toFixed(2)+'</div>'+
        '<div class="tot-box" style="background:'+(tvc<0?'#fef2f2':'#f0fdf4')+';border:1.5px solid '+(tvc<0?'#fecaca':'#86efac')+';color:'+(tvc<0?'#ef4444':'#16a34a')+';">تكلفة التباين<br>'+formatVal(tvc)+' SAR</div>'+
      '</div>'+
      '<div class="sig"><div><div class="line"></div><div class="cap">القائم بالجرد</div></div><div><div class="line"></div><div class="cap">مدير المستودع</div></div><div><div class="line"></div><div class="cap">المدير العام</div></div></div>'+
      '</body></html>'
    );
    w.document.close();
    setTimeout(function() { w.print(); }, 400);
  }).getStocktakeDetail(stId);
}

function deleteStocktake(stId) {
  if (!confirm('حذف محضر الجرد نهائياً؟')) return;
  loader(true);
  api.withSuccessHandler(function(r) {
    loader(false);
    if (r && r.success) { showToast('تم الحذف'); loadDashStocktake(); }
    else showToast((r && r.error) || 'خطأ', true);
  }).deleteStocktake(stId);
}

// ═══════════════════════════════════════════════════════════════════
// STOCKTAKE — Odoo-style add-item flow with localStorage draft
// ═══════════════════════════════════════════════════════════════════

// Global state: items added to current stocktake session
window._stSession = window._stSession || {
  items: [],    // [{ id, name, category, unit, sysStock, actual, diff }]
  notes: '',
  warehouseId: ''
};
var ST_DRAFT_KEY = 'mt_stocktake_draft_v2';

function _stLoadAvailableItems() {
  // Loads all inv_items + live stock into cachedStItems (Odoo-style)
  return new Promise(function(resolve) {
    api.withSuccessHandler(function(items) {
      cachedStItems = items || [];
      resolve(cachedStItems);
    }).getLiveInventory();
  });
}

function startStocktake() {
  loader();
  _stLoadAvailableItems().then(function() {
    loader(false);

    // Load warehouses
    var token = localStorage.getItem('pos_token') || '';
    fetch('/api/erp/warehouses-list', { headers: { 'Authorization': 'Bearer ' + token } })
      .then(function(r){return r.json();})
      .then(function(whs){
        var sel = q('#stWarehouse');
        if (sel) {
          sel.innerHTML = '<option value="">— المستودع الرئيسي —</option>' +
            (whs||[]).map(function(w){return '<option value="'+w.id+'">'+(w.name||'')+'</option>';}).join('');
        }
      }).catch(function(){});

    // Check for existing draft
    var draft = _stGetSavedDraft();
    if (draft && draft.items && draft.items.length) {
      var banner = q('#stRestoreBanner');
      var cnt = q('#stRestoreCount');
      if (banner) banner.style.display = '';
      if (cnt) cnt.textContent = draft.items.length;
      // Don't auto-restore — wait for user confirmation
      window._stSession = { items: [], notes: '', warehouseId: '' };
    } else {
      // Fresh session
      window._stSession = { items: [], notes: '', warehouseId: '' };
      var banner = q('#stRestoreBanner');
      if (banner) banner.style.display = 'none';
    }
    q("#stNotes").value = '';
    renderStItems();

    // Mount Odoo-style picker
    var host = q('#stPickerHost');
    if (host && window.WoItemPicker) {
      WoItemPicker.mount(host, {
        items: cachedStItems,
        placeholder: 'ابحث عن مادة بالاسم أو الكود أو التصنيف... (Enter للإضافة)',
        getExcludeIds: function() { return window._stSession.items.map(function(i){return String(i.id);}); },
        onSelect: function(item) {
          _stAddItem(item);
        }
      });
    }

    openModal("#modalStocktakeForm");
  });
}

function _stAddItem(item) {
  // Prevent duplicates
  if (window._stSession.items.some(function(i){return String(i.id)===String(item.id);})) return;
  var sysStock = Number(item.currentStock || item.stock || 0);
  window._stSession.items.push({
    id: item.id,
    name: item.name,
    category: item.category || '',
    unit: item.unit || '',
    bigUnit: item.bigUnit || '',
    convRate: Number(item.convRate) || 1,
    cost: Number(item.cost) || 0,
    sysStock: sysStock,
    actual: sysStock,  // default to sys; user will change
    diff: 0
  });
  renderStItems();
  _stSaveDraft(false);  // auto-save draft
}

function _stRemoveItem(idx) {
  window._stSession.items.splice(idx, 1);
  renderStItems();
  _stSaveDraft(false);
}

function _stUpdateActual(idx, value) {
  if (window._stSession.items[idx]) {
    var actual = Number(value) || 0;
    window._stSession.items[idx].actual = actual;
    window._stSession.items[idx].diff = actual - window._stSession.items[idx].sysStock;
    _stSaveDraft(false);
    // Update only the diff cell and summary (avoid full re-render to preserve focus)
    var row = document.querySelector('#tbStBody tr[data-st-idx="'+idx+'"]');
    if (row) {
      var diffCell = row.querySelector('.st-diff-cell');
      if (diffCell) diffCell.innerHTML = _stDiffHtml(window._stSession.items[idx].diff, window._stSession.items[idx].unit);
    }
    _stRenderSummary();
  }
}

function _stDiffHtml(diff, unit) {
  var u = unit ? ' <span style="font-size:10px;color:#94a3b8;">'+unit+'</span>' : '';
  if (Math.abs(diff) < 0.0001) return '<span style="color:#64748b;"><i class="fas fa-equals"></i> 0.00'+u+'</span>';
  if (diff > 0) return '<span style="color:#059669;background:#d1fae5;padding:2px 8px;border-radius:6px;font-weight:700;"><i class="fas fa-arrow-up"></i> +'+diff.toFixed(2)+u+'</span>';
  return '<span style="color:#dc2626;background:#fee2e2;padding:2px 8px;border-radius:6px;font-weight:700;"><i class="fas fa-arrow-down"></i> '+diff.toFixed(2)+u+'</span>';
}

function renderStItems() {
  var tb = q('#tbStBody');
  if (!tb) return;
  var items = window._stSession.items || [];
  if (!items.length) {
    tb.innerHTML = '<tr><td colspan="6"><div class="wo-empty" style="padding:40px;"><i class="fas fa-magnifying-glass"></i><div class="wo-empty-title">لم تُضف مواد بعد</div><div class="wo-empty-sub">استخدم صندوق البحث أعلاه لإضافة المواد التي تريد جردها — اضغط Enter لإضافة السريع، أو انقر من القائمة المنسدلة</div></div></td></tr>';
    _stRenderSummary();
    return;
  }
  tb.innerHTML = items.map(function(i, idx){
    return '<tr data-st-idx="'+idx+'">' +
      '<td style="color:#8b5cf6;font-weight:800;">'+(idx+1)+'</td>' +
      '<td><b>'+_escHtml(i.name)+'</b>' +
        '<div style="font-size:11px;color:#64748b;"><code style="background:#f1f5f9;padding:1px 5px;border-radius:4px;">'+_escHtml(i.id)+'</code>'+(i.category?' · '+_escHtml(i.category):'')+'</div></td>' +
      '<td class="num"><b style="color:#1e40af;">'+i.sysStock.toFixed(2)+'</b> <span style="font-size:10px;color:#94a3b8;">'+_escHtml(i.unit||'')+'</span></td>' +
      '<td class="num"><input type="number" step="0.001" value="'+i.actual+'" class="form-control" style="width:100%;text-align:center;font-weight:700;color:#059669;padding:6px;" oninput="_stUpdateActual('+idx+',this.value)" onfocus="this.select()"></td>' +
      '<td class="num st-diff-cell">'+_stDiffHtml(i.diff, i.unit)+'</td>' +
      '<td><button class="wo-icon-btn danger" onclick="_stRemoveItem('+idx+')" title="حذف من الجرد"><i class="fas fa-xmark"></i></button></td>' +
    '</tr>';
  }).join('');
  _stRenderSummary();
}

function _stRenderSummary() {
  var sum = q('#stSummary');
  if (!sum) return;
  var items = window._stSession.items || [];
  var total = items.length;
  var surplus = items.filter(function(i){return i.diff > 0.0001;});
  var shortage = items.filter(function(i){return i.diff < -0.0001;});
  var matched = total - surplus.length - shortage.length;
  var totalVariance = items.reduce(function(s,i){return s + (i.diff * (Number(i.cost)||0));}, 0);
  var chip = function(icon, color, label, val) {
    return '<div style="background:#fff;border:1px solid #e5e7eb;border-left:3px solid '+color+';border-radius:10px;padding:10px 12px;display:flex;align-items:center;gap:10px;">' +
      '<div style="width:32px;height:32px;border-radius:8px;background:'+color+'15;color:'+color+';display:flex;align-items:center;justify-content:center;"><i class="fas '+icon+'"></i></div>' +
      '<div><div style="font-size:10px;color:#64748b;font-weight:700;">'+label+'</div><div style="font-size:18px;font-weight:900;color:#0f172a;">'+val+'</div></div>' +
    '</div>';
  };
  sum.innerHTML =
    chip('fa-boxes-stacked', '#0ea5e9', 'إجمالي المواد المُضافة', total) +
    chip('fa-arrow-up', '#10b981', 'فائض', surplus.length) +
    chip('fa-arrow-down', '#ef4444', 'نقص', shortage.length) +
    chip(totalVariance>=0?'fa-plus':'fa-minus', totalVariance>=0?'#059669':'#dc2626', 'صافي تكلفة الفرق', (totalVariance>=0?'+':'')+totalVariance.toFixed(2));
}

// ─── Draft save/restore (localStorage) ───
function _stGetSavedDraft() {
  try { return JSON.parse(localStorage.getItem(ST_DRAFT_KEY) || 'null'); } catch(e) { return null; }
}
window._stSaveDraft = function(showFeedback) {
  var data = {
    items: window._stSession.items,
    notes: (q('#stNotes')||{}).value || '',
    warehouseId: (q('#stWarehouse')||{}).value || '',
    savedAt: new Date().toISOString()
  };
  try {
    localStorage.setItem(ST_DRAFT_KEY, JSON.stringify(data));
    if (showFeedback) showToast('تم حفظ مسودة الجرد محلياً — يمكنك الاستمرار لاحقاً');
  } catch(e) {
    if (showFeedback) showToast('تعذر حفظ المسودة', true);
  }
};
window._stRestoreDraft = function() {
  var d = _stGetSavedDraft();
  if (!d) return;
  window._stSession.items = d.items || [];
  q('#stNotes').value = d.notes || '';
  if (d.warehouseId && q('#stWarehouse')) q('#stWarehouse').value = d.warehouseId;
  renderStItems();
  var banner = q('#stRestoreBanner');
  if (banner) banner.style.display = 'none';
  showToast('تم استعادة المسودة (' + d.items.length + ' صنف)');
};
window._stDiscardDraft = function() {
  try { localStorage.removeItem(ST_DRAFT_KEY); } catch(e) {}
  window._stSession = { items: [], notes: '', warehouseId: '' };
  var banner = q('#stRestoreBanner');
  if (banner) banner.style.display = 'none';
  renderStItems();
};

// Escape HTML for safety
function _escHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});
}

function saveStocktakeFn() {
  var items = window._stSession.items || [];
  // Only send items with actual differences
  var itemsToAdjust = items
    .filter(function(i){ return Math.abs(i.diff) > 0.001; })
    .map(function(i){ return { id: i.id, diff: i.diff, sys: i.sysStock, actual: i.actual }; });

  if (!items.length) {
    return showToast('لم تُضف أي مواد للجرد — أضف المواد من صندوق البحث أولاً', true);
  }
  if (itemsToAdjust.length === 0) {
    return showToast('لا توجد فوارق لتسويتها — كل الأرصدة الفعلية تطابق النظام', true);
  }

  if (!confirm('سيتم اعتماد تسوية جردية لعدد (' + itemsToAdjust.length + ') صنف من أصل (' + items.length + ') تم جردها. هل أنت متأكد؟')) return;

  loader(true);
  var notes = q('#stNotes').value || '';
  var warehouseId = (q('#stWarehouse')||{}).value || '';
  api.withFailureHandler(function(err) {
    loader(false); showToast(err.message, true);
  }).withSuccessHandler(function(res) {
    loader(false);
    if (res.success) {
      closeModal('#modalStocktakeForm');
      try { localStorage.removeItem(ST_DRAFT_KEY); } catch(e) {}
      window._stSession = { items: [], notes: '', warehouseId: '' };
      showToast('تم اعتماد التسوية بنجاح — انعكس الرصيد فوراً ✓');
      loadDashStocktake();
      loadDashInvItems();
      loadLiveInventory();
    } else {
      showToast(res.error, true);
    }
  }).submitStocktake(itemsToAdjust, state.user, notes, warehouseId);
}


// Users Management
var _cachedUsers = [];
function loadDashUsers() {
  loader();
  api.withSuccessHandler(function(arr) {
    loader(false);
    arr = Array.isArray(arr) ? arr : [];
    _cachedUsers = arr;
    // Build a map for use by report renderers
    state.userDisplayMap = {};
    arr.forEach(function(u) { state.userDisplayMap[u.username] = u.displayName || u.username; });

    var roleLabel = function(r) {
      if (r === 'admin')    return '<span class="badge blue">مدير مؤسسة</span>';
      if (r === 'manager')  return '<span class="badge orange">مدير فرع</span>';
      if (r === 'custody')  return '<span class="badge" style="background:#f3e8ff;color:#7c3aed;">مسؤول عهدة</span>';
      if (r === 'employee') return '<span class="badge" style="background:#ecfdf5;color:#059669;">موظف</span>';
      return '<span class="badge green">كاشير</span>';
    };

    var h = '';
    arr.forEach(function(u) {
      var devBadge = u.isDeveloper ? ' <span class="badge" style="background:#fef3c7;color:#92400e;border:1px solid #fde68a;"><i class="fas fa-code"></i> مطور</span>' : '';
      var passDisplay = '<span style="color:#94a3b8;font-size:11px;"><i class="fas fa-lock" style="margin-left:4px;"></i> مشفرة</span>';
      var emailDisplay = u.email ? '<div style="font-size:11px;color:#64748b;"><i class="fas fa-envelope" style="margin-left:3px;color:#94a3b8;"></i>' + u.email + '</div>' : '';
      var btnS = 'width:34px;height:34px;border-radius:10px;border:1px solid #e2e8f0;background:#f8fafc;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;font-size:14px;';
      var brandDisplay = u.brandName ? '<span class="badge" style="background:#f3e8ff;color:#7c3aed;font-size:10px;">' + u.brandName + '</span>' : '';
      var branchDisplay = u.branchName ? '<span class="badge badge-blue" style="font-size:10px;">' + u.branchName + '</span>' : '';
      var posDisplay = u.positionName ? '<div style="font-size:10px;margin-top:2px;"><span style="display:inline-flex;align-items:center;gap:3px;padding:2px 8px;border-radius:6px;background:#e0f2fe;color:#0369a1;font-weight:700;"><i class="fas fa-id-badge"></i>' + u.positionName + '</span></div>' : '';
      h += '<tr>' +
        '<td><div style="font-weight:800;font-size:14px;color:#1e293b;">' + (u.displayName || '<span style="color:#94a3b8;">—</span>') + '</div><div style="font-size:11px;color:#94a3b8;font-family:monospace;">' + (u.username || '') + '</div>' + emailDisplay + posDisplay + '</td>' +
        '<td>' + roleLabel(u.role) + devBadge + '</td>' +
        '<td>' + brandDisplay + ' ' + branchDisplay + '</td>' +
        '<td>' + (u.active ? '<span class="badge green">نشط</span>' : '<span class="badge red">موقوف</span>') + '</td>' +
        '<td style="white-space:nowrap;">' +
          '<div style="display:flex;gap:4px;">' +
            '<button style="' + btnS + 'color:#3b82f6;" onclick="editUsr(\'' + u.username + '\')" title="تعديل"><i class="fas fa-edit"></i></button>' +
            '<button style="' + btnS + 'color:#f59e0b;" onclick="resetUserPassword(\'' + u.username + '\')" title="إعادة تعيين كلمة المرور"><i class="fas fa-key"></i></button>' +
            '<button style="' + btnS + 'color:#8b5cf6;" onclick="setup2FA(\'' + u.username + '\')" title="تفعيل 2FA"><i class="fas fa-shield-alt"></i></button>' +
            '<button style="' + btnS + 'color:#10b981;" onclick="toggUsr(\'' + u.username + '\')" title="تفعيل/إيقاف"><i class="fas fa-power-off"></i></button>' +
            '<button style="' + btnS + 'color:#ef4444;" onclick="delUsr(\'' + u.username + '\')" title="حذف"><i class="fas fa-trash"></i></button>' +
          '</div>' +
        '</td>' +
      '</tr>';
    });
    if (!arr.length) h = '<tr><td colspan="5" style="text-align:center;padding:20px;color:#94a3b8;">لا يوجد مستخدمين</td></tr>';
    q("#tbUsers").innerHTML = h;
  }).withFailureHandler(function(err) { loader(false); showToast(err.message || 'فشل تحميل المستخدمين', true); }).getUsers();
}

function resetUserPassword(username) {
  var newPass = prompt('أدخل كلمة المرور الجديدة لـ ' + username + ':');
  if (!newPass || newPass.length < 4) return showToast('كلمة المرور يجب أن تكون 4 أحرف على الأقل', true);
  if (!confirm('إعادة تعيين كلمة مرور "' + username + '" إلى: ' + newPass + '؟')) return;
  loader(true);
  api.withSuccessHandler(function(r) {
    loader(false);
    if (r && r.success) showToast('تم إعادة تعيين كلمة المرور بنجاح');
    else showToast((r && r.error) || 'فشل', true);
  }).resetPassword(username, newPass);
}

var _editingUsername = '';
function tglUserM() {
  _editingUsername = '';
  q("#muModalTitle").innerText = 'إضافة موظف جديد';
  q("#muDisplayName").value = '';
  q("#muName").value = '';
  q("#muName").disabled = false;
  if (q("#muNameHint")) q("#muNameHint").style.display = 'none';
  q("#muPass").value = '';
  q("#muPass").placeholder = 'حروف + أرقام + رمز (6 أحرف على الأقل)';
  q("#muRole").value = 'cashier';
  if (q("#muEmail")) q("#muEmail").value = '';
  if (q("#muIsDeveloper")) q("#muIsDeveloper").checked = false;
  if (q("#muCanChangeBranch")) q("#muCanChangeBranch").checked = false;
  if (q("#muPassHint")) q("#muPassHint").innerHTML = '';
  _loadUserDropdowns();
  openModal('#modalUserForm');
}

function _loadUserDropdowns(brandVal, branchVal, positionVal, warehouseVal) {
  // Load brands
  api.withSuccessHandler(function(brands) {
    var sel = q('#muBrand');
    if (!sel) return;
    sel.innerHTML = '<option value="">— بدون —</option>';
    (brands||[]).forEach(function(b) {
      sel.innerHTML += '<option value="' + b.id + '"' + (brandVal===b.id?' selected':'') + '>' + b.name + '</option>';
    });
  }).getBrands();
  // Load branches from ERP branches-full
  fetch('/api/erp/branches-full', { headers: { 'Authorization': 'Bearer ' + localStorage.getItem('pos_token') } })
    .then(function(r) { return r.json(); })
    .then(function(branches) {
      var sel = q('#muBranch');
      if (!sel) return;
      sel.innerHTML = '<option value="">— بدون —</option>';
      (branches||[]).forEach(function(b) {
        sel.innerHTML += '<option value="' + b.id + '"' + (branchVal===b.id?' selected':'') + '>' + b.name + '</option>';
      });
    }).catch(function() {});
  // Load warehouses for the default-warehouse dropdown
  fetch('/api/erp/warehouses-list', { headers: { 'Authorization': 'Bearer ' + localStorage.getItem('pos_token') } })
    .then(function(r) { return r.json(); })
    .then(function(rows) {
      var sel = q('#muDefaultWarehouse');
      if (!sel) return;
      sel.innerHTML = '<option value="">— تلقائي حسب الفرع —</option>';
      (rows||[]).forEach(function(w) {
        sel.innerHTML += '<option value="' + w.id + '"' + (warehouseVal===w.id?' selected':'') + '>' + (w.name || w.id) + '</option>';
      });
    }).catch(function() {});
  // Load positions
  fetch('/api/workflow/positions', { headers: { 'Authorization': 'Bearer ' + localStorage.getItem('pos_token') } })
    .then(function(r) { return r.json(); })
    .then(function(positions) {
      var sel = q('#muPosition');
      if (!sel) return;
      sel.innerHTML = '<option value="">— بدون —</option>';
      (positions||[]).forEach(function(p) {
        sel.innerHTML += '<option value="' + p.id + '"' + (positionVal===p.id?' selected':'') + '>' + p.name + ' (مستوى ' + p.level + ')</option>';
      });
    }).catch(function() {});
}

// When user picks a branch, auto-load that branch's main warehouse as the suggested default
window._onUserBranchChange = function() {
  var brId = q('#muBranch') && q('#muBranch').value;
  if (!brId) return;
  // The warehouse list endpoint returns all; we'll just leave it to the user
  // to pick — but visually highlight the recommended one (matching branch)
  // Currently no-op but kept as a hook for future enhancement.
};

function editUsr(username) {
  var u = _cachedUsers.find(function(x){ return x.username === username; });
  if (!u) return;
  _editingUsername = username;
  q("#muModalTitle").innerText = 'تعديل المستخدم — ' + (u.displayName || u.username);
  q("#muDisplayName").value = u.displayName || '';
  q("#muName").value = u.username;
  // Allow rename for every user except the protected 'admin' account.
  // The backend does the rename + cascades to all related tables
  // (hr_employees.linked_username, transactions.created_by, etc.)
  var isAdmin = (username === 'admin');
  q("#muName").disabled = isAdmin;
  var hint = q("#muNameHint");
  if (hint) hint.style.display = isAdmin ? 'none' : 'block';
  q("#muPass").value = '';
  q("#muPass").placeholder = 'اتركها فارغة لعدم التغيير';
  q("#muRole").value = u.role || 'cashier';
  if (q("#muEmail")) q("#muEmail").value = u.email || '';
  if (q("#muIsDeveloper")) q("#muIsDeveloper").checked = !!u.isDeveloper;
  if (q("#muCanChangeBranch")) q("#muCanChangeBranch").checked = !!u.canChangeBranch;
  if (q("#muPassHint")) q("#muPassHint").innerHTML = '';
  _loadUserDropdowns(u.brandId, u.branchId, u.positionId, u.defaultWarehouseId);
  openModal('#modalUserForm');
}

function _validatePassword(p) {
  var errors = [];
  if (p.length < 6) errors.push('6 أحرف على الأقل');
  if (!/[a-zA-Z]/.test(p)) errors.push('يجب أن تحتوي حروف');
  if (!/[0-9]/.test(p)) errors.push('يجب أن تحتوي أرقام');
  if (!/[!@#$%^&*()_+\-=\[\]{};':"|,.<>\/?]/.test(p)) errors.push('يجب أن تحتوي رمز خاص (!@#$)');
  return errors;
}

function checkPassStrength() {
  var p = q("#muPass").value || '';
  var hint = q("#muPassHint");
  if (!hint || !p) { if(hint) hint.innerHTML = ''; return; }
  var errors = _validatePassword(p);
  if (errors.length === 0) {
    hint.innerHTML = '<span style="color:#16a34a;font-size:11px;"><i class="fas fa-check-circle"></i> كلمة مرور قوية</span>';
  } else {
    hint.innerHTML = errors.map(function(e) { return '<span style="color:#ef4444;font-size:11px;"><i class="fas fa-times-circle"></i> ' + e + '</span>'; }).join('<br>');
  }
}

function saveUserFn() {
  var displayName = (q("#muDisplayName").value || '').trim();
  var username    = (q("#muName").value || '').trim();
  var password    = q("#muPass").value || '';
  var role        = q("#muRole").value || 'cashier';
  var isDeveloper = q("#muIsDeveloper") ? q("#muIsDeveloper").checked : false;
  var email       = q("#muEmail") ? (q("#muEmail").value || '').trim() : '';
  var brandId     = q("#muBrand") ? q("#muBrand").value : '';
  var branchId    = q("#muBranch") ? q("#muBranch").value : '';
  var positionId  = q("#muPosition") ? q("#muPosition").value : '';
  // V3 spec fields
  var defaultWarehouseId = q("#muDefaultWarehouse") ? q("#muDefaultWarehouse").value : '';
  var canChangeBranch    = q("#muCanChangeBranch") ? q("#muCanChangeBranch").checked : false;

  if (!username) return showToast('الرقم الوظيفي مطلوب', true);
  if (!_editingUsername && !password) return showToast('كلمة المرور مطلوبة عند إنشاء مستخدم', true);
  if (password) {
    var passErrors = _validatePassword(password);
    if (passErrors.length) return showToast('كلمة المرور: ' + passErrors[0], true);
  }

  loader();
  if (_editingUsername) {
    var payload = { displayName: displayName, role: role, isDeveloper: isDeveloper, email: email,
                    brandId: brandId, branchId: branchId, positionId: positionId,
                    defaultWarehouseId: defaultWarehouseId, canChangeBranch: canChangeBranch };
    if (password) payload.password = password;
    // If the login username changed (and it's not 'admin'), request a cascade rename.
    if (username && username !== _editingUsername && _editingUsername !== 'admin') {
      payload.newUsername = username;
    }
    api.withFailureHandler(function(err){loader(false); showToast(err.message, true);})
       .withSuccessHandler(function(r) {
          loader(false);
          if (r && r.success) { showToast('تم تحديث المستخدم'); closeModal('#modalUserForm'); loadDashUsers(); }
          else showToast((r && r.error) || 'فشل التحديث', true);
       }).updateUser(_editingUsername, payload);
  } else {
    var data = { username: username, password: password, role: role, displayName: displayName, isDeveloper: isDeveloper, email: email,
                 brandId: brandId, branchId: branchId, positionId: positionId,
                 defaultWarehouseId: defaultWarehouseId, canChangeBranch: canChangeBranch };
    api.withFailureHandler(function(err){loader(false); showToast(err.message, true);})
       .withSuccessHandler(function(r) {
          loader(false);
          if (r && r.success) { showToast('تم إنشاء المستخدم بنجاح'); closeModal('#modalUserForm'); loadDashUsers(); }
          else showToast((r && r.error) || 'فشل الإنشاء', true);
       }).addUser(data);
  }
}

function toggUsr(u) {
  loader();
  api.withFailureHandler(function(err){loader(false); showToast(err.message, true);})
     .withSuccessHandler(function(r) {
        loader(false);
        if (r && r.success) { showToast('تم التحديث'); loadDashUsers(); }
        else showToast((r && r.error) || 'فشل', true);
     }).toggleUserActive(u);
}

function delUsr(u) {
  if (!confirm('تأكيد الحذف النهائي للمستخدم "' + u + '"؟')) return;
  loader();
  api.withFailureHandler(function(err){loader(false); showToast(err.message, true);})
     .withSuccessHandler(function(r) {
        loader(false);
        if (r && r.success) { showToast('تم الحذف'); loadDashUsers(); }
        else showToast((r && r.error) || 'فشل الحذف', true);
     }).deleteUser(u);
}

// ─── Two-Factor Authentication (2FA) ───
function setup2FA(username) {
  if (!confirm('تفعيل التحقق الثنائي (2FA) للمستخدم "' + username + '"؟\n\nسيحتاج تطبيق Google Authenticator أو Authy.')) return;
  loader(true);
  api.withSuccessHandler(function(r) {
    loader(false);
    if (r.success) {
      var html = '<div style="text-align:center;padding:20px;">' +
        '<h3 style="margin-bottom:12px;"><i class="fas fa-shield-alt" style="color:#8b5cf6;"></i> التحقق الثنائي</h3>' +
        '<p style="margin-bottom:16px;color:#64748b;">افتح تطبيق <b>Google Authenticator</b> وأضف حساب جديد باستخدام المفتاح التالي:</p>' +
        '<div style="background:#f1f5f9;padding:16px;border-radius:12px;margin-bottom:16px;">' +
          '<code style="font-size:18px;font-weight:900;letter-spacing:3px;color:#1e293b;word-break:break-all;">' + r.secret + '</code>' +
        '</div>' +
        '<p style="font-size:12px;color:#94a3b8;">أو امسح QR Code (إذا متاح) من الرابط:<br/><code style="font-size:10px;">' + (r.uri||'') + '</code></p>' +
        '<div style="margin-top:16px;padding:12px;background:#f0fdf4;border:1px solid #dcfce7;border-radius:10px;">' +
          '<i class="fas fa-check-circle" style="color:#16a34a;"></i> تم تفعيل 2FA بنجاح للمستخدم <b>' + username + '</b>' +
        '</div></div>';
      showToast('تم تفعيل 2FA');
      // Show in modal
      if (typeof openModal === 'function') {
        q("#muModalTitle").innerText = 'التحقق الثنائي — ' + username;
        q(".modal-content", q("#modalUserForm")).querySelector('.form-group') ?
          (q("#modalUserForm .modal-content").innerHTML = '<div class="modal-title"><span>' + username + ' — 2FA</span><button class="modal-close" onclick="closeModal(\'#modalUserForm\')">&times;</button></div>' + html) :
          alert('المفتاح السري:\n\n' + r.secret + '\n\nأضفه في تطبيق Google Authenticator');
      }
    } else showToast(r.error, true);
  }).setup2FA({ username: username });
}

// ─── Developer-only DB reset ───
function openResetDbModal() {
  q("#rdbPass").value = '';
  q("#rdbConfirm").value = '';
  openModal('#modalResetDb');
}

function confirmResetDb() {
  var pass = q("#rdbPass").value;
  var conf = q("#rdbConfirm").value;
  if (!pass) return showToast('كلمة المرور مطلوبة', true);
  if (conf !== 'YES_RESET_ALL_DATA') return showToast('نص التأكيد غير صحيح', true);
  if (!confirm('⚠️ هل أنت متأكد تماماً من تصفير قاعدة البيانات؟ لا يمكن التراجع!')) return;

  loader();
  api.withFailureHandler(function(err){ loader(false); showToast(err.message, true); })
     .withSuccessHandler(function(r) {
        loader(false);
        if (r && r.success) {
          closeModal('#modalResetDb');
          showToast('تم تصفير قاعدة البيانات بنجاح. سيتم إعادة تحميل الصفحة...');
          // Clear local caches and reload
          try {
            localStorage.removeItem('pos_menu_cache');
            localStorage.removeItem('pos_branding');
            localStorage.removeItem('pos_active_shift_id');
          } catch (e) {}
          setTimeout(function(){ window.location.reload(); }, 1500);
        } else {
          showToast((r && r.error) || 'فشلت عملية التصفير', true);
        }
     }).resetDatabase({ confirm: conf, username: state.user, password: pass });
}

// Toggle the developer zone visibility based on the current user
function applyDeveloperVisibility() {
  var devZone = q("#devZone");
  if (!devZone) return;
  if (state.isDeveloper) devZone.classList.remove('hidden');
  else devZone.classList.add('hidden');
}

// Advanced Reports Engine (Dashboard View)
let advCharts = []; // keep track to destroy previous charts

function buildAdvReport() {
  ensureChartJs().then(_buildAdvReportBody).catch(function(e) { showToast(e.message || 'فشل تحميل المكتبات', true); });
}
function _buildAdvReportBody() {
  loader();
  const filters = {
    startDate: q("#repStart").value,
    endDate: q("#repEnd").value,
    username: q("#repUserOpt").value,
    paymentMethod: q("#repPayOpt").value
  };

  api.withFailureHandler(err => { loader(false); showToast(err.message, true); })
  .withSuccessHandler(d => {
    loader(false);
    if (!d.success) return showToast(d.error || "\u062e\u0637\u0623 \u0641\u064a \u0627\u0633\u062a\u062e\u0631\u0627\u062c \u0627\u0644\u062a\u0642\u0627\u0631\u064a\u0631", true);

    // Cache for export
    state.reportCache = d;

    // Clear old charts
    advCharts.forEach(c => c.destroy());
    advCharts = [];

    const fmt = v => Number(v).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
    const fmtInt = v => Number(v).toLocaleString('en-US');
    const s = d.stats;
    const p = d.payments;
    const allPay = p.cash.total + p.card.total + p.kita.total;
    const pct = v => allPay > 0 ? ((v / allPay) * 100).toFixed(1) + '%' : '0%';

    // Period label
    const fromLabel = filters.startDate || '\u0627\u0644\u0628\u062f\u0627\u064a\u0629';
    const toLabel = filters.endDate || '\u0627\u0644\u0622\u0646';
    let filterTags = '';
    if (filters.username) filterTags += '<span class="tag"><i class="fas fa-user"></i> ' + filters.username + '</span>';
    if (filters.paymentMethod) filterTags += '<span class="tag"><i class="fas fa-credit-card"></i> ' + filters.paymentMethod + '</span>';

    let h = '';

    // ── Report Header ──
    h += `<div class="report-header-bar">
      <div>
        <h3><i class="fas fa-chart-bar"></i> \u0627\u0644\u062a\u0642\u0631\u064a\u0631 \u0627\u0644\u0645\u0627\u0644\u064a \u0627\u0644\u0634\u0627\u0645\u0644</h3>
        <div class="report-period"><i class="fas fa-calendar-alt"></i> ${fromLabel} \u2192 ${toLabel}</div>
      </div>
      <div class="report-filters-tags">${filterTags}</div>
    </div>`;

    // ── KPI Cards (6) ──
    h += `<div class="report-kpi-grid">
      <div class="report-kpi-card ${s.netProfit >= 0 ? 'kpi-profit' : 'kpi-loss'}">
        <div class="kpi-label"><i class="fas fa-hand-holding-usd"></i> \u0635\u0627\u0641\u064a \u0627\u0644\u0631\u0628\u062d / \u0627\u0644\u062e\u0633\u0627\u0631\u0629</div>
        <div class="kpi-value" style="color:${s.netProfit >= 0 ? '#10b981' : '#ef4444'};">${fmt(s.netProfit)} <small style="font-size:13px;">SAR</small></div>
        <div class="kpi-sub">\u0647\u0627\u0645\u0634 \u0627\u0644\u0631\u0628\u062d: ${s.profitMargin}%</div>
      </div>
      <div class="report-kpi-card kpi-revenue">
        <div class="kpi-label"><i class="fas fa-arrow-trend-up"></i> \u0625\u062c\u0645\u0627\u0644\u064a \u0627\u0644\u0625\u064a\u0631\u0627\u062f\u0627\u062a</div>
        <div class="kpi-value" style="color:#3b82f6;">${fmt(s.totalSales)} <small style="font-size:13px;">SAR</small></div>
        <div class="kpi-sub">\u0645\u062a\u0648\u0633\u0637 \u0627\u0644\u0637\u0644\u0628: ${fmt(s.avgOrderValue)} SAR</div>
      </div>
      <div class="report-kpi-card kpi-expense">
        <div class="kpi-label"><i class="fas fa-arrow-down"></i> \u0625\u062c\u0645\u0627\u0644\u064a \u0627\u0644\u0645\u0635\u0631\u0648\u0641\u0627\u062a</div>
        <div class="kpi-value" style="color:#ef4444;">${fmt(s.totalExp)} <small style="font-size:13px;">SAR</small></div>
        <div class="kpi-sub">\u062e\u0635\u0648\u0645\u0627\u062a: ${fmt(s.totalDiscount)} SAR</div>
      </div>
      <div class="report-kpi-card kpi-purchase">
        <div class="kpi-label"><i class="fas fa-shopping-cart"></i> \u0625\u062c\u0645\u0627\u0644\u064a \u0627\u0644\u0645\u0634\u062a\u0631\u064a\u0627\u062a</div>
        <div class="kpi-value" style="color:#f59e0b;">${fmt(s.totalPur)} <small style="font-size:13px;">SAR</small></div>
        <div class="kpi-sub">\u0631\u0633\u0648\u0645 \u0643\u064a\u062a\u0627: ${fmt(s.totalKitaFees)} SAR</div>
      </div>
      <div class="report-kpi-card kpi-orders">
        <div class="kpi-label"><i class="fas fa-receipt"></i> \u0639\u062f\u062f \u0627\u0644\u0637\u0644\u0628\u0627\u062a</div>
        <div class="kpi-value" style="color:#6366f1;">${fmtInt(s.orderCount)}</div>
        <div class="kpi-sub">\u0623\u064a\u0627\u0645 \u0646\u0634\u0637\u0629: ${s.activeDays} \u064a\u0648\u0645</div>
      </div>
      <div class="report-kpi-card kpi-daily">
        <div class="kpi-label"><i class="fas fa-calendar-day"></i> \u0645\u062a\u0648\u0633\u0637 \u0627\u0644\u0625\u064a\u0631\u0627\u062f \u0627\u0644\u064a\u0648\u0645\u064a</div>
        <div class="kpi-value" style="color:#8b5cf6;">${fmt(s.avgDailyRevenue)} <small style="font-size:13px;">SAR</small></div>
        <div class="kpi-sub">\u0645\u0646 ${s.activeDays} \u064a\u0648\u0645 \u0639\u0645\u0644</div>
      </div>
    </div>`;

    // ── Payment Method Cards ──
    h += `<div class="report-pay-grid">
      <div class="report-pay-card">
        <div class="pay-icon" style="color:#16a34a;"><i class="fas fa-money-bill-wave"></i></div>
        <div class="pay-val" style="color:#16a34a;">${fmt(p.cash.total)}</div>
        <div class="pay-label">\u0643\u0627\u0634</div>
        <div class="pay-count">${fmtInt(p.cash.count)} \u0639\u0645\u0644\u064a\u0629</div>
        <div class="pay-pct" style="color:#16a34a;">${pct(p.cash.total)}</div>
      </div>
      <div class="report-pay-card">
        <div class="pay-icon" style="color:#1e40af;"><i class="fas fa-credit-card"></i></div>
        <div class="pay-val" style="color:#1e40af;">${fmt(p.card.total)}</div>
        <div class="pay-label">\u0645\u062f\u0649 / \u0634\u0628\u0643\u0629</div>
        <div class="pay-count">${fmtInt(p.card.count)} \u0639\u0645\u0644\u064a\u0629</div>
        <div class="pay-pct" style="color:#1e40af;">${pct(p.card.total)}</div>
      </div>
      <div class="report-pay-card">
        <div class="pay-icon" style="color:#854d0e;"><i class="fas fa-file-invoice-dollar"></i></div>
        <div class="pay-val" style="color:#854d0e;">${fmt(p.kita.total)}</div>
        <div class="pay-label">\u0643\u064a\u062a\u0627</div>
        <div class="pay-count">${fmtInt(p.kita.count)} \u0639\u0645\u0644\u064a\u0629</div>
        <div class="pay-pct" style="color:#854d0e;">${pct(p.kita.total)}</div>
      </div>
    </div>`;

    // ── Charts (2x2) ──
    h += `<div class="report-chart-grid">
      <div class="report-chart-box">
        <h4><i class="fas fa-chart-line"></i> \u0627\u0644\u0645\u0628\u064a\u0639\u0627\u062a \u062d\u0633\u0628 \u0627\u0644\u0623\u064a\u0627\u0645</h4>
        <canvas id="chartDays"></canvas>
      </div>
      <div class="report-chart-box">
        <h4><i class="fas fa-clock"></i> \u0630\u0631\u0648\u0629 \u0627\u0644\u0645\u0628\u064a\u0639\u0627\u062a \u062d\u0633\u0628 \u0627\u0644\u0633\u0627\u0639\u0627\u062a</h4>
        <canvas id="chartHours"></canvas>
      </div>
      <div class="report-chart-box">
        <h4><i class="fas fa-users"></i> \u0645\u0628\u064a\u0639\u0627\u062a \u0627\u0644\u0645\u0648\u0638\u0641\u064a\u0646</h4>
        <canvas id="chartCashier"></canvas>
      </div>
      <div class="report-chart-box">
        <h4><i class="fas fa-star"></i> \u0623\u0639\u0644\u0649 5 \u0645\u0646\u062a\u062c\u0627\u062a \u0645\u0628\u064a\u0639\u0627\u064b</h4>
        <canvas id="chartTopItems"></canvas>
      </div>
    </div>`;

    // ── Table: Daily Detail ──
    if (d.tables.dailyDetail && d.tables.dailyDetail.length) {
      let rows = '', totC=0, totK=0, totCd=0, totAll=0, totOrd=0, totDisc=0;
      d.tables.dailyDetail.forEach(r => {
        totC += r.cash; totCd += r.card; totK += r.kita; totAll += r.total; totOrd += r.orders; totDisc += r.discount;
        rows += `<tr><td style="font-weight:600;">${r.date}</td><td>${fmt(r.cash)}</td><td>${fmt(r.card)}</td><td>${fmt(r.kita)}</td><td style="font-weight:700;">${fmt(r.total)}</td><td>${r.orders}</td><td style="color:var(--danger);">${fmt(r.discount)}</td></tr>`;
      });
      h += `<div class="report-table-section">
        <div class="rts-header"><h4><i class="fas fa-calendar-alt"></i> \u0627\u0644\u062a\u0641\u0635\u064a\u0644 \u0627\u0644\u064a\u0648\u0645\u064a</h4></div>
        <div class="table-wrapper" style="border:none;box-shadow:none;border-radius:0;">
          <table class="table"><thead><tr><th>\u0627\u0644\u062a\u0627\u0631\u064a\u062e</th><th>\u0643\u0627\u0634</th><th>\u0634\u0628\u0643\u0629</th><th>\u0643\u064a\u062a\u0627</th><th>\u0627\u0644\u0625\u062c\u0645\u0627\u0644\u064a</th><th>\u0637\u0644\u0628\u0627\u062a</th><th>\u062e\u0635\u0648\u0645\u0627\u062a</th></tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr><td style="font-weight:800;">\u0627\u0644\u0645\u062c\u0645\u0648\u0639</td><td>${fmt(totC)}</td><td>${fmt(totCd)}</td><td>${fmt(totK)}</td><td style="font-weight:900;">${fmt(totAll)}</td><td>${totOrd}</td><td style="color:var(--danger);">${fmt(totDisc)}</td></tr></tfoot>
          </table>
        </div>
      </div>`;
    }

    // ── Table: Cashier Performance ──
    if (d.tables.cashierDetail && d.tables.cashierDetail.length) {
      let rows = '', totAll=0, totOrd=0;
      d.tables.cashierDetail.forEach(r => {
        totAll += r.total; totOrd += r.orders;
        rows += `<tr><td style="font-weight:600;">${r.name}</td><td>${fmt(r.cash)}</td><td>${fmt(r.card)}</td><td>${fmt(r.kita)}</td><td style="font-weight:700;">${fmt(r.total)}</td><td>${r.orders}</td></tr>`;
      });
      h += `<div class="report-table-section">
        <div class="rts-header"><h4><i class="fas fa-users"></i> \u0623\u062f\u0627\u0621 \u0627\u0644\u0645\u0648\u0638\u0641\u064a\u0646</h4></div>
        <div class="table-wrapper" style="border:none;box-shadow:none;border-radius:0;">
          <table class="table"><thead><tr><th>\u0627\u0644\u0645\u0648\u0638\u0641</th><th>\u0643\u0627\u0634</th><th>\u0634\u0628\u0643\u0629</th><th>\u0643\u064a\u062a\u0627</th><th>\u0627\u0644\u0625\u062c\u0645\u0627\u0644\u064a</th><th>\u0637\u0644\u0628\u0627\u062a</th></tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr><td style="font-weight:800;">\u0627\u0644\u0645\u062c\u0645\u0648\u0639</td><td></td><td></td><td></td><td style="font-weight:900;">${fmt(totAll)}</td><td>${totOrd}</td></tr></tfoot>
          </table>
        </div>
      </div>`;
    }

    // ── Table: Product Detail ──
    if (d.tables.productDetail && d.tables.productDetail.length) {
      let rows = '', totQty=0, totRev=0;
      // Calculate totals from ALL products first
      d.tables.productDetail.forEach(r => { totQty += r.qty; totRev += r.revenue; });
      // Display top 50
      d.tables.productDetail.slice(0, 50).forEach((r, i) => {
        rows += `<tr><td style="font-weight:600;">${i+1}. ${r.name}</td><td>${fmtInt(r.qty)}</td><td style="font-weight:700;">${fmt(r.revenue)}</td><td>${r.orders}</td></tr>`;
      });
      const moreCount = d.tables.productDetail.length > 50 ? d.tables.productDetail.length - 50 : 0;
      h += `<div class="report-table-section">
        <div class="rts-header"><h4><i class="fas fa-box"></i> \u062a\u0641\u0635\u064a\u0644 \u0627\u0644\u0645\u0646\u062a\u062c\u0627\u062a</h4><span style="font-size:12px; color:var(--text-light);">${d.tables.productDetail.length} \u0645\u0646\u062a\u062c${moreCount > 0 ? ' (\u064a\u0639\u0631\u0636 50)' : ''}</span></div>
        <div class="table-wrapper" style="border:none;box-shadow:none;border-radius:0;">
          <table class="table"><thead><tr><th>\u0627\u0644\u0645\u0646\u062a\u062c</th><th>\u0627\u0644\u0643\u0645\u064a\u0629</th><th>\u0627\u0644\u0625\u064a\u0631\u0627\u062f</th><th>\u0637\u0644\u0628\u0627\u062a</th></tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr><td style="font-weight:800;">\u0627\u0644\u0645\u062c\u0645\u0648\u0639</td><td>${fmtInt(totQty)}</td><td style="font-weight:900;">${fmt(totRev)}</td><td></td></tr></tfoot>
          </table>
        </div>
      </div>`;
    }

    // ── Table: Expenses by Category ──
    if (d.tables.expensesByCategory && d.tables.expensesByCategory.length) {
      let rows = '', totAmt=0;
      d.tables.expensesByCategory.forEach(r => {
        totAmt += r.total;
        rows += `<tr><td><span class="badge" style="background:#fef3c7; color:#92400e;">${r.category}</span></td><td style="font-weight:700; color:var(--danger);">${fmt(r.total)}</td><td>${r.count}</td></tr>`;
      });
      h += `<div class="report-table-section">
        <div class="rts-header"><h4><i class="fas fa-file-invoice"></i> \u0627\u0644\u0645\u0635\u0631\u0648\u0641\u0627\u062a \u062d\u0633\u0628 \u0627\u0644\u0641\u0626\u0629</h4></div>
        <div class="table-wrapper" style="border:none;box-shadow:none;border-radius:0;">
          <table class="table"><thead><tr><th>\u0627\u0644\u0641\u0626\u0629</th><th>\u0627\u0644\u0645\u0628\u0644\u063a</th><th>\u0627\u0644\u0639\u062f\u062f</th></tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr><td style="font-weight:800;">\u0627\u0644\u0645\u062c\u0645\u0648\u0639</td><td style="font-weight:900; color:var(--danger);">${fmt(totAmt)}</td><td></td></tr></tfoot>
          </table>
        </div>
      </div>`;
    }

    // ── Table: Purchases by Supplier ──
    if (d.tables.purchasesBySupplier && d.tables.purchasesBySupplier.length) {
      let rows = '', totAmt=0;
      d.tables.purchasesBySupplier.forEach(r => {
        totAmt += r.total;
        rows += `<tr><td style="font-weight:600;">${r.supplier}</td><td style="font-weight:700; color:#d97706;">${fmt(r.total)}</td><td>${r.count}</td></tr>`;
      });
      h += `<div class="report-table-section">
        <div class="rts-header"><h4><i class="fas fa-truck"></i> \u0627\u0644\u0645\u0634\u062a\u0631\u064a\u0627\u062a \u062d\u0633\u0628 \u0627\u0644\u0645\u0648\u0631\u062f</h4></div>
        <div class="table-wrapper" style="border:none;box-shadow:none;border-radius:0;">
          <table class="table"><thead><tr><th>\u0627\u0644\u0645\u0648\u0631\u062f</th><th>\u0627\u0644\u0645\u0628\u0644\u063a</th><th>\u0627\u0644\u0639\u062f\u062f</th></tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr><td style="font-weight:800;">\u0627\u0644\u0645\u062c\u0645\u0648\u0639</td><td style="font-weight:900; color:#d97706;">${fmt(totAmt)}</td><td></td></tr></tfoot>
          </table>
        </div>
      </div>`;
    }

    q("#reportContentArea").innerHTML = h;

    // Render Charts
    setTimeout(() => {
      const chartOpts = { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } };
      const fmtTooltip = { callbacks: { label: ctx => ctx.parsed.y !== undefined ? fmt(ctx.parsed.y) + ' SAR' : fmt(ctx.parsed) + ' SAR' } };

      if (d.charts.salesByDay.length) {
        advCharts.push(new Chart(document.getElementById('chartDays').getContext('2d'), {
          type: 'line',
          data: { labels: d.charts.salesByDay.map(x=>x.label), datasets: [{ label: '\u0627\u0644\u0645\u0628\u064a\u0639\u0627\u062a', data: d.charts.salesByDay.map(x=>x.value), borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.08)', fill: true, tension: 0.4, pointRadius: 4, pointBackgroundColor: '#3b82f6' }] },
          options: { ...chartOpts, plugins: { ...chartOpts.plugins, tooltip: fmtTooltip } }
        }));
      }
      if (d.charts.salesByHour.length) {
        advCharts.push(new Chart(document.getElementById('chartHours').getContext('2d'), {
          type: 'bar',
          data: { labels: d.charts.salesByHour.map(x=>x.label), datasets: [{ label: '\u062d\u062c\u0645 \u0627\u0644\u0639\u0645\u0644', data: d.charts.salesByHour.map(x=>x.value), backgroundColor: '#10b981', borderRadius: 6 }] },
          options: { ...chartOpts, plugins: { ...chartOpts.plugins, tooltip: fmtTooltip } }
        }));
      }
      if (d.charts.salesByCashier.length) {
        advCharts.push(new Chart(document.getElementById('chartCashier').getContext('2d'), {
          type: 'bar',
          data: { labels: d.charts.salesByCashier.map(x=>x.label), datasets: [{ label: '\u0627\u0644\u0645\u0628\u064a\u0639\u0627\u062a', data: d.charts.salesByCashier.map(x=>x.value), backgroundColor: ['#3b82f6','#8b5cf6','#ec4899','#f59e0b','#10b981','#06b6d4','#f43f5e'], borderRadius: 6 }] },
          options: { ...chartOpts, indexAxis: 'y', plugins: { ...chartOpts.plugins, tooltip: fmtTooltip } }
        }));
      }
      if (d.charts.topProducts.length) {
        advCharts.push(new Chart(document.getElementById('chartTopItems').getContext('2d'), {
          type: 'bar',
          data: { labels: d.charts.topProducts.map(x=>x.label), datasets: [{ label: '\u0627\u0644\u0643\u0645\u064a\u0629', data: d.charts.topProducts.map(x=>x.value), backgroundColor: '#f43f5e', borderRadius: 6 }] },
          options: { ...chartOpts, indexAxis: 'y' }
        }));
      }
    }, 150);

  }).getAdvancedFullReport(filters);
}

function exportRepExcel() {
  ensureXlsx().then(_exportRepExcelBody).catch(function(e) { showToast(e.message || 'فشل تحميل XLSX', true); });
}
function _exportRepExcelBody() {
  if (!state.reportCache || !state.reportCache.success) return showToast("\u064a\u0631\u062c\u0649 \u062a\u0648\u0644\u064a\u062f \u0627\u0644\u062a\u0642\u0631\u064a\u0631 \u0623\u0648\u0644\u0627\u064b", true);
  try {
    const d = state.reportCache;
    const fmt2 = v => Number(v || 0).toFixed(2);
    const wb = XLSX.utils.book_new();

    // Sheet 1: KPI Summary
    const kpiData = [
      {"\u0627\u0644\u0645\u0624\u0634\u0631": "\u0625\u062c\u0645\u0627\u0644\u064a \u0627\u0644\u0625\u064a\u0631\u0627\u062f\u0627\u062a", "\u0627\u0644\u0642\u064a\u0645\u0629": fmt2(d.stats.totalSales)},
      {"\u0627\u0644\u0645\u0624\u0634\u0631": "\u0625\u062c\u0645\u0627\u0644\u064a \u0627\u0644\u0645\u0635\u0631\u0648\u0641\u0627\u062a", "\u0627\u0644\u0642\u064a\u0645\u0629": fmt2(d.stats.totalExp)},
      {"\u0627\u0644\u0645\u0624\u0634\u0631": "\u0625\u062c\u0645\u0627\u0644\u064a \u0627\u0644\u0645\u0634\u062a\u0631\u064a\u0627\u062a", "\u0627\u0644\u0642\u064a\u0645\u0629": fmt2(d.stats.totalPur)},
      {"\u0627\u0644\u0645\u0624\u0634\u0631": "\u0635\u0627\u0641\u064a \u0627\u0644\u0631\u0628\u062d", "\u0627\u0644\u0642\u064a\u0645\u0629": fmt2(d.stats.netProfit)},
      {"\u0627\u0644\u0645\u0624\u0634\u0631": "\u0647\u0627\u0645\u0634 \u0627\u0644\u0631\u0628\u062d %", "\u0627\u0644\u0642\u064a\u0645\u0629": d.stats.profitMargin + "%"},
      {"\u0627\u0644\u0645\u0624\u0634\u0631": "\u0639\u062f\u062f \u0627\u0644\u0637\u0644\u0628\u0627\u062a", "\u0627\u0644\u0642\u064a\u0645\u0629": d.stats.orderCount},
      {"\u0627\u0644\u0645\u0624\u0634\u0631": "\u0645\u062a\u0648\u0633\u0637 \u0627\u0644\u0637\u0644\u0628", "\u0627\u0644\u0642\u064a\u0645\u0629": d.stats.avgOrderValue},
      {"\u0627\u0644\u0645\u0624\u0634\u0631": "\u0625\u062c\u0645\u0627\u0644\u064a \u0627\u0644\u062e\u0635\u0648\u0645\u0627\u062a", "\u0627\u0644\u0642\u064a\u0645\u0629": fmt2(d.stats.totalDiscount)},
      {"\u0627\u0644\u0645\u0624\u0634\u0631": "\u0643\u0627\u0634", "\u0627\u0644\u0642\u064a\u0645\u0629": fmt2(d.payments.cash.total)},
      {"\u0627\u0644\u0645\u0624\u0634\u0631": "\u0634\u0628\u0643\u0629", "\u0627\u0644\u0642\u064a\u0645\u0629": fmt2(d.payments.card.total)},
      {"\u0627\u0644\u0645\u0624\u0634\u0631": "\u0643\u064a\u062a\u0627", "\u0627\u0644\u0642\u064a\u0645\u0629": fmt2(d.payments.kita.total)},
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(kpiData), "\u0645\u0644\u062e\u0635");

    // Sheet 2: Daily Detail
    if (d.tables.dailyDetail && d.tables.dailyDetail.length) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(d.tables.dailyDetail.map(r => ({
        "\u0627\u0644\u062a\u0627\u0631\u064a\u062e": r.date, "\u0643\u0627\u0634": fmt2(r.cash), "\u0634\u0628\u0643\u0629": fmt2(r.card), "\u0643\u064a\u062a\u0627": fmt2(r.kita), "\u0627\u0644\u0625\u062c\u0645\u0627\u0644\u064a": fmt2(r.total), "\u0637\u0644\u0628\u0627\u062a": r.orders, "\u062e\u0635\u0648\u0645\u0627\u062a": fmt2(r.discount)
      }))), "\u0627\u0644\u062a\u0641\u0635\u064a\u0644 \u0627\u0644\u064a\u0648\u0645\u064a");
    }

    // Sheet 3: Cashier Detail
    if (d.tables.cashierDetail && d.tables.cashierDetail.length) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(d.tables.cashierDetail.map(r => ({
        "\u0627\u0644\u0645\u0648\u0638\u0641": r.name, "\u0643\u0627\u0634": fmt2(r.cash), "\u0634\u0628\u0643\u0629": fmt2(r.card), "\u0643\u064a\u062a\u0627": fmt2(r.kita), "\u0627\u0644\u0625\u062c\u0645\u0627\u0644\u064a": fmt2(r.total), "\u0637\u0644\u0628\u0627\u062a": r.orders
      }))), "\u0627\u0644\u0645\u0648\u0638\u0641\u064a\u0646");
    }

    // Sheet 4: Products
    if (d.tables.productDetail && d.tables.productDetail.length) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(d.tables.productDetail.map(r => ({
        "\u0627\u0644\u0645\u0646\u062a\u062c": r.name, "\u0627\u0644\u0643\u0645\u064a\u0629": r.qty, "\u0627\u0644\u0625\u064a\u0631\u0627\u062f": fmt2(r.revenue), "\u0637\u0644\u0628\u0627\u062a": r.orders
      }))), "\u0627\u0644\u0645\u0646\u062a\u062c\u0627\u062a");
    }

    // Sheet 5: Expenses
    if (d.tables.expensesByCategory && d.tables.expensesByCategory.length) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(d.tables.expensesByCategory.map(r => ({
        "\u0627\u0644\u0641\u0626\u0629": r.category, "\u0627\u0644\u0645\u0628\u0644\u063a": fmt2(r.total), "\u0627\u0644\u0639\u062f\u062f": r.count
      }))), "\u0627\u0644\u0645\u0635\u0631\u0648\u0641\u0627\u062a");
    }

    // Sheet 6: Purchases
    if (d.tables.purchasesBySupplier && d.tables.purchasesBySupplier.length) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(d.tables.purchasesBySupplier.map(r => ({
        "\u0627\u0644\u0645\u0648\u0631\u062f": r.supplier, "\u0627\u0644\u0645\u0628\u0644\u063a": fmt2(r.total), "\u0627\u0644\u0639\u062f\u062f": r.count
      }))), "\u0627\u0644\u0645\u0634\u062a\u0631\u064a\u0627\u062a");
    }

    // Sheet 7: Sales List
    if (d.salesList && d.salesList.length) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(d.salesList.map(s => ({
        "\u0631\u0642\u0645 \u0627\u0644\u0637\u0644\u0628": s.orderId, "\u0627\u0644\u062a\u0627\u0631\u064a\u062e": s.date, "\u0627\u0644\u0643\u0627\u0634\u064a\u0631": s.username, "\u0637\u0631\u064a\u0642\u0629 \u0627\u0644\u062f\u0641\u0639": s.paymentMethod, "\u0627\u0633\u0645 \u0627\u0644\u062e\u0635\u0645": s.discountName, "\u0645\u0628\u0644\u063a \u0627\u0644\u062e\u0635\u0645": s.discountAmount, "\u0627\u0644\u0625\u062c\u0645\u0627\u0644\u064a": s.total
      }))), "\u0627\u0644\u0639\u0645\u0644\u064a\u0627\u062a");
    }

    XLSX.writeFile(wb, "\u062a\u0642\u0631\u064a\u0631_\u0634\u0627\u0645\u0644_" + new Date().getTime() + ".xlsx");
    showToast("\u062a\u0645 \u062a\u0635\u062f\u064a\u0631 \u0627\u0644\u062a\u0642\u0631\u064a\u0631 \u0628\u0646\u062c\u0627\u062d!");
  } catch (e) { showToast("\u062d\u062f\u062b \u062e\u0637\u0623 \u0623\u062b\u0646\u0627\u0621 \u0627\u0644\u062a\u0635\u062f\u064a\u0631: " + e.message, true); }
}

function printAdvReport() {
  const content = q("#reportContentArea");
  if (!state.reportCache || !state.reportCache.success) return showToast("\u064a\u0631\u062c\u0649 \u062a\u0648\u0644\u064a\u062f \u0627\u0644\u062a\u0642\u0631\u064a\u0631 \u0623\u0648\u0644\u0627\u064b", true);
  const w = window.open('', '_blank');
  w.document.write(`<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="UTF-8"><title>\u062a\u0642\u0631\u064a\u0631 \u0645\u0627\u0644\u064a \u0634\u0627\u0645\u0644</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box;}
    body{font-family:'Segoe UI',Tahoma,sans-serif;direction:rtl;padding:20px;color:#1e293b;font-size:13px;}
    .report-header-bar{background:#1e293b;color:#fff;padding:16px 20px;border-radius:10px;margin-bottom:16px;display:flex;justify-content:space-between;align-items:center;}
    .report-header-bar h3{font-size:16px;margin:0;}
    .report-period{font-size:12px;color:#94a3b8;}
    .report-kpi-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px;}
    .report-kpi-card{padding:12px;border:1px solid #e2e8f0;border-radius:8px;}
    .kpi-label{font-size:11px;color:#64748b;margin-bottom:4px;}
    .kpi-value{font-size:18px;font-weight:800;margin-bottom:2px;}
    .kpi-sub{font-size:10px;color:#94a3b8;}
    .report-pay-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px;}
    .report-pay-card{text-align:center;padding:12px;border:1px solid #e2e8f0;border-radius:8px;}
    .pay-val{font-size:16px;font-weight:800;}
    .pay-label{font-size:12px;color:#64748b;}
    .pay-count{font-size:11px;color:#94a3b8;}
    .report-chart-grid{display:none;}
    .report-table-section{margin-bottom:14px;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;}
    .rts-header{padding:10px 14px;border-bottom:1px solid #e2e8f0;background:#f8fafc;}
    .rts-header h4{font-size:13px;font-weight:700;margin:0;}
    table{width:100%;border-collapse:collapse;font-size:12px;}
    th{background:#f1f5f9;padding:8px 10px;text-align:right;font-weight:700;border-bottom:2px solid #e2e8f0;}
    td{padding:6px 10px;text-align:right;border-bottom:1px solid #f1f5f9;}
    tfoot td{font-weight:800;background:#f8fafc;border-top:2px solid #e2e8f0;}
    .badge{padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;}
    .tag,.report-filters-tags,.pay-pct,.pay-icon{font-size:11px;}
    @media print{body{padding:10px;}}
  </style></head><body>${content.innerHTML}</body></html>`);
  w.document.close();
  setTimeout(() => { w.print(); }, 300);
}

function populateReportFilters() {
  const sel = q("#repUserOpt");
  if (!sel || sel.options.length > 1) return;
  if (state.users && state.users.length) {
    state.users.forEach(u => {
      const opt = document.createElement('option');
      opt.value = u.username;
      opt.textContent = u.username;
      sel.appendChild(opt);
    });
  }
}

// Settings Update
function saveDashSettings() {
  loader();
  var up = { name: q("#setCompany").value, taxNumber: q("#setTax").value, logo: state.settings.logo || '' };
  // Collect payment methods from settings UI
  var methods = (state.paymentMethods||[]).map(function(m, i) {
    var activeEl = document.querySelector('.pm-active[data-idx="'+i+'"]');
    var nameArEl = document.querySelector('.pm-name-ar[data-idx="'+i+'"]');
    var nameEnEl = document.querySelector('.pm-name-en[data-idx="'+i+'"]');
    var feeEl = document.querySelector('.pm-fee[data-idx="'+i+'"]');
    return {
      ID: m.ID, Icon: m.Icon, SortOrder: m.SortOrder,
      Name: nameEnEl ? nameEnEl.value : m.Name,
      NameAR: nameArEl ? nameArEl.value : m.NameAR,
      IsActive: activeEl ? activeEl.checked : m.IsActive,
      ServiceFeeRate: feeEl ? Number(feeEl.value)||0 : Number(m.ServiceFeeRate)||0
    };
  });
  api.withSuccessHandler(function(r) {
    // Save payment methods
    api.withSuccessHandler(function(r2) {
      // Re-fetch fresh payment methods so any newly inserted rows get their real auto-increment IDs
      api.withSuccessHandler(function(fresh) {
        loader(false);
        state.paymentMethods = fresh || [];
        renderPayButtons();
        loadPayMethodsSettings();
        showToast("تم تحديث جميع الإعدادات بنجاح");
        state.settings.name = up.name;
        state.settings.taxNumber = up.taxNumber;
        // Re-apply branding immediately + cache for fast paint next time
        try { localStorage.setItem('pos_branding', JSON.stringify({ name: up.name, logo: up.logo })); } catch(e) {}
        applyBrandingToUI(up.name, up.logo);
      }).withFailureHandler(function() {
        loader(false);
        state.paymentMethods = methods;
        renderPayButtons();
      }).getPaymentMethods();
    }).savePaymentMethods(methods);
  }).updateCompanySettings(up);
}

// =========================================
// 8. Expenses Management
// =========================================
function loadDashExpenses() {

  loader();
  const filters = {};
  const start = q("#fexpStart") ? q("#fexpStart").value : "";
  const end = q("#fexpEnd") ? q("#fexpEnd").value : "";
  if (start) filters.startDate = start;
  if (end) filters.endDate = end;
  
  api.withSuccessHandler(arr => {
    loader(false);
    let totalAmt = 0;
    let h = "";
    if (!arr || !arr.length) {
      h = "<tr><td colspan='8' style='text-align:center; padding:30px; color:var(--text-light);'>لا توجد مصروفات مسجلة</td></tr>";
    } else {
      arr.forEach(e => {
        totalAmt += e.amount;
        h += `<tr>
          <td>${e.date ? new Date(e.date).toLocaleString('ar-SA') : '—'}</td>
          <td><span class="badge" style="background:#fef3c7; color:#92400e;">${e.category}</span></td>
          <td style="font-weight:600;">${e.description}</td>
          <td style="font-weight:900; color:var(--danger);">${formatVal(e.amount)}</td>
          <td><span class="badge ${e.paymentMethod === 'Cash' ? 'green' : 'blue'}">${e.paymentMethod}</span></td>
          <td>${e.username}</td>
          <td style="color:var(--text-light); font-size:13px;">${e.notes || '—'}</td>
          <td><button class="btn btn-danger" style="padding:6px 12px;" onclick="delExpFn('${e.id}')"><i class="fas fa-trash"></i></button></td>
        </tr>`;
      });
    }
    q("#tbExpenses").innerHTML = h;
    q("#expTotalAmt").innerText = formatVal(totalAmt);
    q("#expTotalCount").innerText = arr ? arr.length : 0;
  }).getExpenses(Object.keys(filters).length ? filters : null);
}

function openExpModal() { 
  q("#expDesc").value = ""; q("#expAmt").value = ""; q("#expNotes").value = "";
  openModal('#modalExpForm'); 
}

function saveExpFn() {
  const data = {
    category: q("#expCat").value,
    description: q("#expDesc").value,
    amount: q("#expAmt").value,
    paymentMethod: q("#expPay").value,
    username: state.user,
    notes: q("#expNotes").value
  };
  if (!data.description || !data.amount) return showToast("يرجى تعبئة الوصف والمبلغ", true);
  loader();
  api.withSuccessHandler(r => {
    loader(false);
    if (r.success) { closeModal('#modalExpForm'); showToast("تمت إضافة المصروف بنجاح"); loadDashExpenses(); }
    else showToast(r.error || "خطأ", true);
  }).addExpense(data);
}

function delExpFn(id) {
  if (confirm("هل أنت متأكد من حذف هذا المصروف؟")) {
    loader();
    api.withSuccessHandler(r => { loader(false); showToast("تم الحذف"); loadDashExpenses(); }).deleteExpense(id);
  }
}

// =========================================
// 9. Purchases Management
// =========================================
var _purAllData = [];

function _purEsc(s){ if(s===null||s===undefined) return ''; return String(s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }

function _purPopulateFilterDropdowns() {
  // Brands via direct fetch (no API bridge dependency)
  fetch('/api/erp/brands', { headers:{ 'Authorization':'Bearer '+(localStorage.getItem('pos_token')||'') }})
    .then(function(r){return r.json();}).then(function(brs){
      var sel = q('#fpurBrand');
      if (sel) sel.innerHTML = '<option value="">كل البراندات</option>' +
        (brs||[]).map(function(b){return '<option value="'+b.id+'">'+_purEsc(b.name||'')+'</option>';}).join('');
    }).catch(function(){});
  // Suppliers via bridge
  api.withSuccessHandler(function(sups){
    state.suppliersList = sups || [];
    var sel = q('#fpurSupplier');
    if (sel) sel.innerHTML = '<option value="">كل الموردين</option>' +
      (sups||[]).map(function(s){return '<option value="'+s.id+'">'+_purEsc(s.name||'')+'</option>';}).join('');
  }).getSuppliers();
}

function loadDashPurchases() {
  // Populate filter dropdowns once per section open
  _purPopulateFilterDropdowns();
  api.withSuccessHandler(items => { state.purInvItems = items || []; }).getInvItems();
  var tb = q("#tbPurchases");
  if (tb) tb.innerHTML = "<tr><td colspan='12'><div class='wo-empty'><i class='fas fa-spinner fa-spin'></i><span>جاري التحميل...</span></div></td></tr>";

  const filters = {};
  const start = q("#fpurStart") ? q("#fpurStart").value : "";
  const end = q("#fpurEnd") ? q("#fpurEnd").value : "";
  if (start) filters.startDate = start;
  if (end) filters.endDate = end;

  api.withSuccessHandler(function(res){
    if (res && res.error) {
      showToast(res.error, true);
      if (tb) tb.innerHTML = "<tr><td colspan='12'><div class='wo-empty'><i class='fas fa-triangle-exclamation' style='color:var(--wo-danger-fg);'></i><span>"+res.error+"</span></div></td></tr>";
      return;
    }
    _purAllData = res || [];
    state.purchasesCache = _purAllData;
    purApplyFilters();
  }).getPurchases(Object.keys(filters).length ? filters : null);
}

// Apply all in-memory filters (brand/supplier/status/payment/search/chips) and render
window.purApplyFilters = function() {
  var arr = _purAllData || [];
  var bId = q('#fpurBrand')   ? q('#fpurBrand').value   : '';
  var sId = q('#fpurSupplier')? q('#fpurSupplier').value: '';
  var st  = q('#fpurStatus')  ? q('#fpurStatus').value  : '';
  var pay = q('#fpurPay')     ? q('#fpurPay').value     : '';
  var sq  = q('#fpurSearch')  ? (q('#fpurSearch').value||'').toLowerCase().trim() : '';
  var largeChip = document.querySelector('[data-pur-qf="large"].active');

  var filtered = arr.filter(function(p){
    if (bId && String(p.brandId||'') !== bId) return false;
    if (sId && String(p.supplierId||'') !== sId) return false;
    if (st  && String(p.status||'') !== st) return false;
    if (pay && String(p.paymentMethod||'') !== pay) return false;
    if (largeChip && Number(p.totalPrice||0) < 5000) return false;
    if (sq) {
      var hay = ((p.id||'') + ' ' + (p.supplierName||'') + ' ' + (p.itemName||'') + ' ' + (p.username||'')).toLowerCase();
      if (hay.indexOf(sq) < 0) return false;
    }
    return true;
  });

  // Summary counters
  var totalNet = 0, totalVAT = 0, pending = 0;
  filtered.forEach(function(p){
    var n = Number(p.totalPrice||0);
    totalNet += n;
    totalVAT += n * 0.15;
    if ((p.status||'') !== 'received') pending++;
  });
  if (q('#purTotalAmt'))    q('#purTotalAmt').innerText    = formatVal(totalNet);
  if (q('#purTotalCount'))  q('#purTotalCount').innerText  = filtered.length;
  if (q('#purPendingCount'))q('#purPendingCount').innerText= pending;
  if (q('#purTotalVAT'))    q('#purTotalVAT').innerText    = formatVal(totalVAT);
  if (q('#purResultsCount'))q('#purResultsCount').innerHTML=
    '<i class="fas fa-circle-info"></i> <b>'+filtered.length+'</b> فاتورة · صافي: <b>'+formatVal(totalNet)+'</b> · شامل الضريبة: <b>'+formatVal(totalNet*1.15)+'</b>';

  var h = "";
  if (!filtered.length) {
    h = "<tr><td colspan='12'><div class='wo-empty'><i class='fas fa-inbox'></i><span>لا توجد فواتير مطابقة للفلترة</span></div></td></tr>";
  } else {
    filtered.forEach(function(p, idx){
      var realIdx = _purAllData.indexOf(p);
      var payBadge = p.paymentMethod === 'Cash'
        ? '<span class="wo-chip success"><i class="fas fa-money-bill"></i> كاش</span>'
        : (p.paymentMethod === 'آجل'
            ? '<span class="wo-chip warning"><i class="fas fa-clock-rotate-left"></i> آجل</span>'
            : '<span class="wo-chip info"><i class="fas fa-university"></i> '+_purEsc(p.paymentMethod||'')+'</span>');
      var statusBadge = (p.status === 'received')
        ? '<span class="wo-chip success"><i class="fas fa-check"></i> تم الاستلام</span>'
        : '<span class="wo-chip warning"><i class="fas fa-hourglass-half"></i> بانتظار</span>';
      var receiveBtn = (p.status !== 'received')
        ? '<button class="wo-icon-btn success" onclick="receivePurFn(\''+p.id+'\')" title="استلام للمخزون" aria-label="استلام"><i class="fas fa-check-double"></i></button>'
        : '<button class="wo-icon-btn warning" onclick="revertReceivePurFn(\''+p.id+'\')" title="التراجع عن الاستلام" aria-label="تراجع"><i class="fas fa-undo"></i></button>';
      var hasMany = p.itemsJson && p.itemsJson.length > 5;
      var itemLabel = hasMany
        ? '<i class="fas fa-box-open" style="color:var(--wo-info-fg);margin-inline-end:4px;"></i><span>'+_purEsc(p.itemName||'')+'</span>'
        : _purEsc(p.itemName||'');
      var brandChip = p.brandName
        ? '<span class="wo-chip purple"><i class="fas fa-store"></i> '+_purEsc(p.brandName)+'</span>'
        : '<span class="wo-text-subtle wo-text-caption">عام</span>';
      var net   = Number(p.totalPrice||0);
      var vat   = Math.round(net * 0.15 * 100) / 100;
      var total = Math.round((net + vat) * 100) / 100;
      h += '<tr>'+
        '<td data-label="التاريخ"><code style="font-size:11px;">'+(p.date ? new Date(p.date).toLocaleString('ar-SA',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}) : '—')+'</code></td>'+
        '<td data-label="البراند">'+brandChip+'</td>'+
        '<td data-label="المورد"><b>'+_purEsc(p.supplierName||'')+'</b></td>'+
        '<td data-label="المادة">'+itemLabel+'</td>'+
        '<td data-label="الكمية" class="num">'+p.qty+'</td>'+
        '<td data-label="الصافي" class="num">'+formatVal(net)+'</td>'+
        '<td data-label="الضريبة" class="num" style="color:#d97706;font-weight:700;">'+formatVal(vat)+'</td>'+
        '<td data-label="الإجمالي" class="num strong">'+formatVal(total)+'</td>'+
        '<td data-label="الدفع">'+payBadge+'</td>'+
        '<td data-label="الحالة">'+statusBadge+'</td>'+
        '<td data-label="المستخدم"><span class="wo-text-subtle wo-text-caption">'+_purEsc(p.username||'')+'</span></td>'+
        '<td data-label="الإجراءات"><div class="wo-actions">'+receiveBtn+
          '<button class="wo-icon-btn info" onclick="printPurchaseCached('+realIdx+')" title="طباعة" aria-label="طباعة"><i class="fas fa-print"></i></button>'+
          '<button class="wo-icon-btn danger" onclick="delPurFn(\''+p.id+'\')" title="حذف" aria-label="حذف"><i class="fas fa-trash"></i></button>'+
        '</div></td>'+
      '</tr>';
    });
  }
  if (q('#tbPurchases')) q('#tbPurchases').innerHTML = h;
};

// Quick-filter preset chips
function _purSetQuickChip(k) {
  document.querySelectorAll('[data-pur-qf]').forEach(function(el){
    el.classList.toggle('active', el.getAttribute('data-pur-qf') === k);
  });
}
window.purQuickFilter = function(k) {
  _purSetQuickChip(k);
  var start = q('#fpurStart'), end = q('#fpurEnd');
  var st = q('#fpurStatus'), pay = q('#fpurPay');
  if (start) start.value = '';
  if (end)   end.value = '';
  if (st)    st.value = '';
  if (pay)   pay.value = '';
  var today = new Date(); var fmt = function(d){return d.toISOString().slice(0,10);};
  var needReload = false;
  if (k === 'today')    { start.value = fmt(today); end.value = fmt(today); needReload = true; }
  else if (k === 'week'){ var d = new Date(today); d.setDate(d.getDate()-7); start.value = fmt(d); end.value = fmt(today); needReload = true; }
  else if (k === 'month'){ var d = new Date(today.getFullYear(), today.getMonth(), 1); start.value = fmt(d); end.value = fmt(today); needReload = true; }
  else if (k === 'pending')  st.value = 'draft';
  else if (k === 'received') st.value = 'received';
  else if (k === 'cash')     pay.value = 'Cash';
  else if (k === 'credit')   pay.value = 'آجل';
  // 'large' handled purely in purApplyFilters via chip .active
  if (needReload) loadDashPurchases();
  else purApplyFilters();
};
window.purResetFilters = function() {
  ['fpurSearch','fpurBrand','fpurSupplier','fpurStatus','fpurPay','fpurStart','fpurEnd'].forEach(function(id){
    var e = q('#'+id); if (e) e.value = '';
  });
  _purSetQuickChip('');
  loadDashPurchases();
};

let purCart = [];

function openPurModal() {
  q("#purSupplier").value = ""; q("#purNotes").value = "";
  if (q("#purSupplierId")) q("#purSupplierId").value = "";
  q("#purItemSearch").value = ""; q("#purItem").value = ""; q("#purItemId").value = "";
  q("#purQty").value = "1"; q("#purUnitPrice").value = "";
  if (q("#purInvDate")) q("#purInvDate").value = new Date().toISOString().split('T')[0];
  if (q("#purBrand")) q("#purBrand").value = '';
  if (q("#purBranch")) q("#purBranch").value = '';
  purCart = [];
  renderPurCart();

  const results = q("#purItemResults");
  if (results) results.classList.remove('open');
  const supResults = q("#purSupplierResults");
  if (supResults) supResults.classList.remove('open');

  // Load suppliers + inventory items
  api.withSuccessHandler(sups => { state.suppliersList = sups || []; }).getSuppliers();
  api.withSuccessHandler(items => { state.purInvItems = items || []; }).getInvItems();

  // Populate brand + branch selectors
  var hdr = { 'Authorization':'Bearer '+(localStorage.getItem('pos_token')||'') };
  fetch('/api/erp/brands', { headers: hdr })
    .then(function(r){return r.json();}).then(function(brs){
      var sel = q('#purBrand');
      if (sel) sel.innerHTML = '<option value="">— عام (يُستنتج من المورد) —</option>' +
        (brs||[]).map(function(b){return '<option value="'+b.id+'">'+_purEsc(b.name||'')+'</option>';}).join('');
    }).catch(function(){});
  fetch('/api/erp/branches-full', { headers: hdr })
    .then(function(r){return r.json();}).then(function(bnrs){
      var sel = q('#purBranch');
      if (sel) sel.innerHTML = '<option value="">— الكل —</option>' +
        (bnrs||[]).map(function(b){return '<option value="'+b.id+'">'+_purEsc(b.name||'')+'</option>';}).join('');
    }).catch(function(){});

  openModal('#modalPurForm');
}

// ── Supplier search for Purchase Invoice ──
function filterPurSuppliers() {
  const search = (q("#purSupplier").value || "").toLowerCase();
  const list = state.suppliersList || [];
  const results = q("#purSupplierResults");
  let filtered = search ? list.filter(s => String(s.Name||"").toLowerCase().includes(search) || String(s.Phone||"").includes(search)) : list;
  let h = "";
  filtered.slice(0, 15).forEach(s => {
    h += `<div class="sd-result-item" onclick="selectPurSupplier('${String(s.ID).replace(/'/g,"\\'")}','${String(s.Name).replace(/'/g,"\\'")}')">
      <span class="sd-item-name">${s.Name}</span><span class="sd-item-meta">${s.Phone||''} | ${s.PaymentTerms||'Cash'}</span>
    </div>`;
  });
  if (search && !filtered.length) h = '<div class="sd-result-item" style="color:#94a3b8;text-align:center;">\u0644\u0627 \u064a\u0648\u062c\u062f \u0645\u0648\u0631\u062f \u0628\u0647\u0630\u0627 \u0627\u0644\u0627\u0633\u0645</div>';
  results.innerHTML = h; results.classList.add('open');
}
function selectPurSupplier(id, name) {
  q("#purSupplier").value = name;
  if (q("#purSupplierId")) q("#purSupplierId").value = id;
  q("#purSupplierResults").classList.remove('open');
}

// ── Supplier search for PO ──
function filterPOSuppliers() {
  const search = (q("#poSupplier").value || "").toLowerCase();
  const list = state.suppliersList || [];
  const results = q("#poSupplierResults");
  let filtered = search ? list.filter(s => String(s.Name||"").toLowerCase().includes(search) || String(s.Phone||"").includes(search)) : list;
  let h = "";
  filtered.slice(0, 15).forEach(s => {
    h += `<div class="sd-result-item" onclick="selectPOSupplier('${String(s.ID).replace(/'/g,"\\'")}','${String(s.Name).replace(/'/g,"\\'")}')">
      <span class="sd-item-name">${s.Name}</span><span class="sd-item-meta">${s.Phone||''}</span>
    </div>`;
  });
  results.innerHTML = h; results.classList.add('open');
}
function selectPOSupplier(id, name) {
  q("#poSupplier").value = name;
  if (q("#poSupplierId")) q("#poSupplierId").value = id;
  q("#poSupplierResults").classList.remove('open');
}

function addPurchaseCartItem() {
  let itemName = q("#purItem").value;
  if (!itemName) itemName = q("#purItemSearch").value;
  const qty = Number(q("#purQty").value) || 0;
  const unitPrice = Number(q("#purUnitPrice").value) || 0;
  
  if (!itemName || qty <= 0 || unitPrice <= 0) return showToast("يرجى التأكد من اسم المادة، الكمية، والسعر بشكل صحيح", true);
  
  purCart.push({
    itemName: itemName.trim(),
    itemId: (q("#purItemId") ? q("#purItemId").value : "").trim(),
    qty: qty,
    unitPrice: unitPrice,
    totalPrice: qty * unitPrice
  });
  
  // reset inputs
  q("#purItemSearch").value = ""; q("#purItem").value = ""; q("#purItemId").value = "";
  q("#purQty").value = "1"; q("#purUnitPrice").value = "";
  
  renderPurCart();
}

function removePurCartItem(idx) {
  purCart.splice(idx, 1);
  renderPurCart();
}

function renderPurCart() {
  const tb = q("#tbPurCart");
  if (!purCart.length) {
    tb.innerHTML = '<tr><td colspan="5" style="text-align:center;">الفاتورة فارغة</td></tr>';
    q("#purCartTotal").innerText = "0.00 SAR";
    return;
  }
  
  let h = "";
  let total = 0;
  purCart.forEach((item, idx) => {
    total += item.totalPrice;
    h += `<tr>
      <td style="font-weight:600;">${item.itemName}</td>
      <td>${item.qty}</td>
      <td>${formatVal(item.unitPrice)}</td>
      <td style="font-weight:bold; color:var(--primary);">${formatVal(item.totalPrice)}</td>
      <td><button class="btn btn-danger" style="padding:5px 10px;" onclick="removePurCartItem(${idx})"><i class="fas fa-trash"></i></button></td>
    </tr>`;
  });
  tb.innerHTML = h;
  q("#purCartTotal").innerText = formatVal(total) + " SAR";
}

function savePurBatchFn() {
  const supplier = q("#purSupplier").value;
  const payMethod = q("#purPay").value;
  const notes = q("#purNotes").value;
  const invDate = q("#purInvDate") ? q("#purInvDate").value : "";

  if (!supplier) return showToast("\u064a\u0631\u062c\u0649 \u0643\u062a\u0627\u0628\u0629 \u0627\u0633\u0645 \u0627\u0644\u0645\u0648\u0631\u062f", true);
  if (purCart.length === 0) return showToast("\u0627\u0644\u0641\u0627\u062a\u0648\u0631\u0629 \u0641\u0627\u0631\u063a\u0629", true);

  loader(true);
  const dataPayload = {
    supplierName: supplier,
    supplierId: q("#purSupplierId") ? q("#purSupplierId").value : "",
    paymentMethod: payMethod,
    username: state.user,
    notes: notes,
    invoiceDate: invDate,
    brandId:  q("#purBrand")  ? (q("#purBrand").value  || null) : null,
    branchId: q("#purBranch") ? (q("#purBranch").value || null) : null,
    items: purCart
  };

  api.withFailureHandler(err => {
    loader(false);
    showToast(err.message || '\u062e\u0637\u0623 \u0623\u062b\u0646\u0627\u0621 \u0627\u0644\u062d\u0641\u0638', true);
  }).withSuccessHandler(r => {
    loader(false);
    if (r.success) {
      closeModal('#modalPurForm');
      showToast("\u062a\u0645 \u062d\u0641\u0638 \u0641\u0627\u062a\u0648\u0631\u0629 \u0627\u0644\u0645\u0634\u062a\u0631\u064a\u0627\u062a \u2014 \u0627\u0636\u063a\u0637 \u0627\u0633\u062a\u0644\u0627\u0645 \u0644\u062a\u062d\u062f\u064a\u062b \u0627\u0644\u0645\u062e\u0632\u0648\u0646");
      loadDashPurchases();
    } else {
      showToast(r.error || "\u062e\u0637\u0623", true);
    }
  }).addPurchaseBatch(dataPayload);
}

let rcvInvoiceId = "";
let rcvItems = [];

function receivePurFn(invoiceId) {
  rcvInvoiceId = invoiceId;
  var all = state.purchasesCache || [];
  var invoice = all.find(function(p){ return p.id === invoiceId; });
  if (!invoice || invoice.status === 'received') return showToast('لا توجد أصناف للاستلام', true);

  // Read items from items_json. Support BOTH field shapes:
  //   { itemId, itemName, qty, unitPrice }   ← direct purchase UI
  //   { id, name, qty, unitPrice }            ← PO approve endpoint
  // (the old code read PascalCase which never matched anything,
  //  so every row showed qty=0 and received=0 in the preview.)
  rcvItems = [];
  // invoice.items is the already-parsed array coming from the purchases GET endpoint
  var parsedItems = invoice.items;
  if (!parsedItems || !parsedItems.length) {
    if (invoice.itemsJson && invoice.itemsJson.length > 5) {
      try { parsedItems = JSON.parse(invoice.itemsJson); } catch(e) { parsedItems = []; }
    }
  }
  if (parsedItems && parsedItems.length) {
    rcvItems = parsedItems.map(function(it){
      return {
        itemName: it.itemName || it.name || it.ItemName || '',
        itemId:   it.itemId   || it.id   || it.ItemID   || '',
        unit:     it.unit     || it.Unit || '',
        qty:      Number(it.qty || it.Qty) || 0,
        unitPrice:Number(it.unitPrice || it.UnitPrice) || 0,
        received: Number(it.qty || it.Qty) || 0,
        checked:  true
      };
    });
  }
  if (!rcvItems.length) {
    rcvItems = [{ itemName: invoice.itemName, itemId: invoice.itemId, unit: '', qty: invoice.qty, unitPrice: invoice.unitPrice, received: invoice.qty, checked: true }];
  }

  q("#rcvInvoiceId").innerText = invoiceId + (invoice.notes ? ' | ' + invoice.notes : '');
  q("#rcvSupplierName").innerText = invoice.supplierName || '';

  var h = '';
  rcvItems.forEach(function(item, i) {
    var unitDisplay = item.unit ? '<span style="color:#64748b;font-size:11px;">' + item.unit + '</span>' : '<span style="color:#cbd5e1;font-size:11px;">—</span>';
    var idBadge = item.itemId
      ? '<code style="font-size:10px;color:#64748b;background:#f1f5f9;padding:1px 4px;border-radius:3px;">' + item.itemId + '</code>'
      : '<span style="color:#ef4444;font-size:10px;">⚠ غير مرتبط بالمخزون</span>';
    h += '<tr>'+
      '<td><input type="checkbox" class="rcv-check" data-idx="'+i+'" checked onchange="rcvItems['+i+'].checked=this.checked"></td>'+
      '<td style="font-weight:600;">'+item.itemName+'<br>'+idBadge+'</td>'+
      '<td style="text-align:center;">'+item.qty+'</td>'+
      '<td style="text-align:center;">'+unitDisplay+'</td>'+
      '<td><input type="number" class="form-control" style="width:100px;margin:0;padding:6px;" value="'+item.qty+'" min="0" max="'+item.qty+'" onchange="rcvItems['+i+'].received=Number(this.value)"></td>'+
      '<td>'+formatVal(item.unitPrice)+'</td>'+
    '</tr>';
  });
  q("#tbReceiveItems").innerHTML = h;
  if (q("#rcvSelectAll")) q("#rcvSelectAll").checked = true;
  openModal('#modalReceiveForm');
}

function toggleRcvAll() {
  const checked = q("#rcvSelectAll").checked;
  qs(".rcv-check").forEach(cb => { cb.checked = checked; });
  rcvItems.forEach(item => { item.checked = checked; });
}

function confirmReceive() {
  var toReceive = rcvItems.filter(function(i){return i.checked && i.received > 0;});
  if (!toReceive.length) return showToast("يرجى تحديد صنف واحد على الأقل", true);
  var includesVAT = q("#rcvIncludesVAT") ? q("#rcvIncludesVAT").checked : false;

  var msg = "تأكيد استلام " + toReceive.length + " صنف وتحديث المخزون؟";
  if (includesVAT) msg += "\n\nالمبالغ شاملة ضريبة 15% — سيُرحّل المخزون بالسعر بدون ضريبة والضريبة لحساب المدخلات.";
  if (!confirm(msg)) return;

  loader(true);
  api.withFailureHandler(function(err){ loader(false); showToast(err.message, true); })
  .withSuccessHandler(function(r) {
    loader(false);

    // Open DevTools (F12) → Console to see verbose diagnostics about which
    // inventory rows were updated, by how much, and which items were skipped.
    console.log('[RECEIVE response]', r);

    if (!r || r.success === false) {
      return showToast(r && r.error ? r.error : 'فشل الاستلام', true);
    }

    // Show every successful update so the user can verify
    if (r.updated && r.updated.length) {
      console.log('  ✓ Updated', r.updated.length, 'inventory rows:');
      r.updated.forEach(function(u) {
        console.log('    •', u.invName, '(' + u.invId + ')',
          'qty +' + u.qty,
          'stock: ' + u.stockBefore + ' → ' + u.stockAfter);
      });
    }
    if (r.skippedDetails && r.skippedDetails.length) {
      console.warn('  ⚠ Skipped', r.skippedDetails.length, 'items:', r.skippedDetails);
    }

    closeModal('#modalReceiveForm');
    showToast("✅ تم استلام " + (r.count||0) + " صنف وتحديث المخزون");
    loadDashPurchases();
    if (typeof loadDashInvItems === 'function') loadDashInvItems();
  }).receivePurchaseBatch(rcvInvoiceId, state.user, includesVAT);
}

// Revert a RECEIVED purchase: roll back stock, delete movements, set back
// to draft. Backend refuses if any item's stock would go negative
// (i.e. some of the received quantity has already been consumed by sales).
function revertReceivePurFn(invoiceId) {
  if (!confirm('هل تريد التراجع عن استلام هذه الفاتورة؟\nسيتم خصم الكميات المستلمة من المخزون وإعادة الفاتورة إلى المسودات.\n\nملاحظة: إذا كانت بعض الكميات قد بيعت بالفعل، سيتم رفض العملية.')) return;
  loader(true);
  api.withFailureHandler(function(err){ loader(false); showToast(err.message || 'خطأ', true); })
  .withSuccessHandler(function(r) {
    loader(false);
    if (r.success) {
      showToast('تم التراجع عن الاستلام وإعادة المخزون');
      loadDashPurchases();
    } else {
      showToast(r.error || 'تعذّر التراجع', true);
    }
  }).revertReceivePurchase(invoiceId, state.user);
}

// delPurFn defined below — removed duplicate

// ─── Purchase Invoice Detail Modal ───
function openPurDetail(idx) {
  var p = state.purchasesCache[idx];
  if (!p) return;
  var items = [];
  try { items = JSON.parse(p.itemsJson); } catch(e) {}
  if (!items.length) return showToast('لا توجد أصناف في هذه الفاتورة','error');
  var isReceived = p.status === 'received';
  var h = '<div style="margin-bottom:12px;">'+
    '<div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:10px;">'+
    '<div><strong>المورد:</strong> '+p.supplierName+'</div>'+
    '<div><strong>المرجع:</strong> '+(p.notes||'—')+'</div>'+
    '<div><strong>المنشئ:</strong> '+p.username+'</div>'+
    '<div><strong>الحالة:</strong> <span class="badge '+(isReceived?'green':'yellow')+'">'+(isReceived?'مستلم':'بانتظار الاستلام')+'</span></div>'+
    '</div></div>'+
    '<table class="table" style="font-size:13px;"><thead><tr>'+
    '<th>الكود</th><th>الصنف</th><th>الكمية</th><th>الوحدة</th><th>سعر الوحدة</th><th>الإجمالي</th>'+
    (!isReceived?'<th>استلام</th>':'')+
    '</tr></thead><tbody>';
  items.forEach(function(it,i){
    // Support both camelCase (new) and PascalCase (legacy) field shapes
    var iid  = it.itemId || it.id || it.ItemID || '—';
    var iname= it.itemName || it.name || it.ItemName || '';
    var iqty = Number(it.qty || it.Qty) || 0;
    var iprc = Number(it.unitPrice || it.UnitPrice) || 0;
    var itot = Number(it.Total) || (iqty * iprc) || 0;
    var iunit= it.unit || it.Unit || '—';
    h += '<tr><td><code style="font-size:11px;">'+iid+'</code></td>'+
      '<td style="font-weight:600;">'+iname+'</td>'+
      '<td style="text-align:center;">'+iqty+'</td>'+
      '<td style="text-align:center;">'+iunit+'</td>'+
      '<td style="text-align:center;">'+iprc.toFixed(2)+'</td>'+
      '<td style="text-align:center;font-weight:700;">'+itot.toFixed(2)+'</td>'+
      (!isReceived?'<td style="text-align:center;"><input type="checkbox" class="pur-detail-chk" data-idx="'+i+'" checked style="width:18px;height:18px;"></td>':'')+
      '</tr>';
  });
  h += '</tbody></table>';
  h += '<div style="text-align:left;font-weight:900;font-size:16px;margin-top:8px;">الإجمالي: '+formatVal(p.totalPrice)+' SAR</div>';
  q("#purDetailBody").innerHTML = h;
  q("#purDetailId").value = p.id;
  q("#purDetailIdx").value = idx;
  var rcvBtn = q("#purDetailReceiveBtn");
  if (rcvBtn) rcvBtn.style.display = isReceived ? 'none' : '';
  openModal("#modalPurDetail");
}
function receivePurDetail() {
  var purId = q("#purDetailId").value;
  var idx = Number(q("#purDetailIdx").value);
  var p = state.purchasesCache[idx];
  if (!p) return;
  if (!confirm('هل تريد استلام الأصناف المحددة؟')) return;
  loader(true);
  api.withSuccessHandler(function(r){
    loader(false);
    if (r.success) { showToast('تم الاستلام'); closeModal("#modalPurDetail"); loadDashPurchases(); }
    else showToast(r.error||'خطأ','error');
  }).withFailureHandler(function(e){ loader(false); showToast('خطأ: '+e.message,'error'); })
  .receivePurchaseBatch(purId, state.user);
}

// PO system moved to ERP section (erp_js.html)
// Old printPurchase removed — using new version below

// =========================================
// 10. Sales Tabs & Payments & Breakdown
// =========================================
let currentSalesTab = 'log';
let breakdownChartInst = null;
let activeBreakdownType = 'byProduct';

function switchSalesTab(tabId) {
  // Legacy shim — redirects to new salesGo()
  var map = { log:'log', payments:'payments', reports:'reports' };
  salesGo(map[tabId] || 'hub');
}

/* ═════════════════════════════════════════════════════════════════════════
 * SALES V3 — Hub navigation + advanced filters + advanced reports
 * ═════════════════════════════════════════════════════════════════════════ */

window._salesPagesIds = ['salesHub','salesLog','salesPayments','salesReports','salesAdvanced'];
window._salesFilters = {}; // per-page filter state: { log: {...}, payments: {...}, reports: {...}, advanced: {...} }
window._salesProductsCache = null;
window._salesBrandsCache = null;
window._salesBranchesCache = null;
window._salesChannelsCache = null;
window._salesCashiersCache = null;
window._salesMethodsCache = null;

window.salesGo = function(page) {
  // page: hub | log | payments | reports | advanced
  var targetId = (page === 'hub') ? 'salesHub' : 'sales' + page.charAt(0).toUpperCase() + page.slice(1);
  window._salesPagesIds.forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', id !== targetId);
  });
  // Mount filter bar if not already mounted
  if (page === 'log')      _mountSalesFilter('salesLogFilter', 'log', loadDashSales);
  if (page === 'payments') _mountSalesFilter('salesPayFilter', 'payments', loadPayments);
  if (page === 'reports')  _mountSalesFilter('salesReportsFilter', 'reports', function(){ loadSalesBreakdown(activeBreakdownType); });
  if (page === 'advanced') _mountSalesFilter('salesAdvFilter', 'advanced', loadSalesAdvancedReports);
  // Load data
  if (page === 'hub')      loadSalesHubKpis();
  if (page === 'log')      loadDashSales();
  if (page === 'payments') loadPayments();
  if (page === 'reports')  loadSalesBreakdown(activeBreakdownType);
  if (page === 'advanced') loadSalesAdvancedReports();
};

// ─── Date preset helpers ─────────────────────────────────────────────────
window._datePreset = function(key) {
  var now = new Date();
  var y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
  var fmt = function(date) {
    var yy = date.getFullYear();
    var mm = String(date.getMonth()+1).padStart(2,'0');
    var dd = String(date.getDate()).padStart(2,'0');
    return yy + '-' + mm + '-' + dd;
  };
  var startOfWeek = function(date) {
    // Saturday-first week (Saudi)
    var day = date.getDay(); // 0=Sun, 6=Sat
    var diff = (day + 1) % 7; // distance back to Saturday
    var s = new Date(date); s.setDate(date.getDate() - diff); return s;
  };
  switch(key) {
    case 'today':       return [fmt(now), fmt(now)];
    case 'yesterday':   { var y2 = new Date(now); y2.setDate(d-1); return [fmt(y2), fmt(y2)]; }
    case 'thisWeek':    { var s = startOfWeek(now); return [fmt(s), fmt(now)]; }
    case 'lastWeek':    { var s = startOfWeek(now); var ls = new Date(s); ls.setDate(s.getDate()-7); var le = new Date(s); le.setDate(s.getDate()-1); return [fmt(ls), fmt(le)]; }
    case 'last7':       { var s = new Date(now); s.setDate(d-6); return [fmt(s), fmt(now)]; }
    case 'last30':      { var s = new Date(now); s.setDate(d-29); return [fmt(s), fmt(now)]; }
    case 'thisMonth':   return [fmt(new Date(y, m, 1)), fmt(now)];
    case 'lastMonth':   return [fmt(new Date(y, m-1, 1)), fmt(new Date(y, m, 0))];
    case 'thisQuarter': { var qStart = Math.floor(m/3)*3; return [fmt(new Date(y, qStart, 1)), fmt(now)]; }
    case 'lastQuarter': { var qStart = Math.floor(m/3)*3 - 3; return [fmt(new Date(y, qStart, 1)), fmt(new Date(y, qStart+3, 0))]; }
    case 'ytd':         return [fmt(new Date(y, 0, 1)), fmt(now)];
    case 'thisYear':    return [fmt(new Date(y, 0, 1)), fmt(new Date(y, 11, 31))];
    case 'lastYear':    return [fmt(new Date(y-1, 0, 1)), fmt(new Date(y-1, 11, 31))];
    case 'all':         return ['', ''];
    default:            return ['', ''];
  }
};

window._applyDatePreset = function(prefix, key) {
  var range = _datePreset(key);
  var sf = q('#sf_' + prefix + '_start');
  var ef = q('#sf_' + prefix + '_end');
  if (sf) sf.value = range[0];
  if (ef) ef.value = range[1];
  // Highlight active preset
  qs('.sf-preset[data-prefix="' + prefix + '"]').forEach(function(el) {
    el.classList.toggle('active', el.dataset.preset === key);
  });
};

// ─── Mount filter bar for a page ─────────────────────────────────────────
function _mountSalesFilter(hostId, prefix, applyFn) {
  var host = document.getElementById(hostId);
  if (!host) return;
  if (host.dataset.mounted === '1') return; // already mounted
  host.dataset.mounted = '1';

  host.innerHTML = _buildSalesFilterHTML(prefix);

  // Wire apply button
  var applyBtn = host.querySelector('.sf-btn-apply');
  if (applyBtn) applyBtn.addEventListener('click', function(){ applyFn && applyFn(); });
  var resetBtn = host.querySelector('.sf-btn-reset');
  if (resetBtn) resetBtn.addEventListener('click', function(){ _resetSalesFilter(prefix); applyFn && applyFn(); });

  // Wire preset chips
  host.querySelectorAll('.sf-preset').forEach(function(chip) {
    chip.addEventListener('click', function(){ _applyDatePreset(prefix, chip.dataset.preset); });
  });

  // Auto-apply "this month" by default
  _applyDatePreset(prefix, 'thisMonth');

  // Populate dropdowns
  _populateSalesFilterDropdowns(prefix);

  // Wire product picker
  _wireProductPicker(prefix);
}

function _buildSalesFilterHTML(prefix) {
  var presets = [
    ['today','اليوم'], ['yesterday','أمس'],
    ['thisWeek','هذا الأسبوع'], ['lastWeek','الأسبوع الماضي'],
    ['last7','آخر 7 أيام'], ['last30','آخر 30 يوم'],
    ['thisMonth','هذا الشهر'], ['lastMonth','الشهر الماضي'],
    ['thisQuarter','هذا الربع'], ['lastQuarter','الربع الماضي'],
    ['ytd','من بداية السنة'], ['thisYear','هذه السنة'], ['lastYear','السنة الماضية'],
    ['all','الكل']
  ];
  var presetsHtml = presets.map(function(p) {
    return '<button class="sf-preset" data-prefix="' + prefix + '" data-preset="' + p[0] + '">' + p[1] + '</button>';
  }).join('');

  return '<div class="sf-bar">' +
    '<div class="sf-date-presets">' + presetsHtml + '</div>' +

    '<div class="sf-row">' +
      '<div class="sf-field"><label><i class="fas fa-calendar"></i> من تاريخ</label><input type="date" id="sf_' + prefix + '_start"></div>' +
      '<div class="sf-field"><label><i class="fas fa-calendar-check"></i> إلى تاريخ</label><input type="date" id="sf_' + prefix + '_end"></div>' +
      '<div class="sf-field"><label><i class="fas fa-tags"></i> البراند</label><select id="sf_' + prefix + '_brand"><option value="">الكل</option></select></div>' +
      '<div class="sf-field"><label><i class="fas fa-code-branch"></i> الفرع</label><select id="sf_' + prefix + '_branch"><option value="">الكل</option></select></div>' +
      '<div class="sf-field"><label><i class="fas fa-store"></i> القناة</label><select id="sf_' + prefix + '_channel"><option value="">الكل</option></select></div>' +
    '</div>' +

    '<div class="sf-row">' +
      '<div class="sf-field"><label><i class="fas fa-credit-card"></i> طريقة الدفع</label><select id="sf_' + prefix + '_pay"><option value="">الكل</option></select></div>' +
      '<div class="sf-field"><label><i class="fas fa-user"></i> الكاشير</label><select id="sf_' + prefix + '_cashier"><option value="">الكل</option></select></div>' +
      '<div class="sf-field"><label><i class="fas fa-money-bill-trend-up"></i> أدنى مبلغ</label><input type="number" step="0.01" id="sf_' + prefix + '_minAmt" placeholder="0.00"></div>' +
      '<div class="sf-field"><label><i class="fas fa-money-bill-1-wave"></i> أقصى مبلغ</label><input type="number" step="0.01" id="sf_' + prefix + '_maxAmt" placeholder="∞"></div>' +
      '<div class="sf-field"><label><i class="fas fa-receipt"></i> رقم الفاتورة</label><input type="text" id="sf_' + prefix + '_invoiceNo" placeholder="بحث برقم..."></div>' +
    '</div>' +

    '<div class="sf-row" style="grid-template-columns:1fr;">' +
      '<div class="sf-field">' +
        '<label><i class="fas fa-cube"></i> المنتجات (اختر منتج أو أكثر)</label>' +
        '<div class="sf-products-host" id="sf_' + prefix + '_prodHost">' +
          '<input type="text" class="sf-prod-input" id="sf_' + prefix + '_prodInput" placeholder="اكتب اسم منتج للبحث...">' +
        '</div>' +
        '<input type="hidden" id="sf_' + prefix + '_prodIds" value="">' +
      '</div>' +
    '</div>' +

    '<div class="sf-actions">' +
      '<button class="sf-btn sf-btn-apply"><i class="fas fa-search"></i> تطبيق الفلاتر</button>' +
      '<button class="sf-btn sf-btn-reset"><i class="fas fa-undo"></i> إعادة تعيين</button>' +
      '<button class="sf-btn sf-btn-export" onclick="_exportSalesFiltered(\'' + prefix + '\')"><i class="fas fa-file-excel"></i> تصدير</button>' +
    '</div>' +
  '</div>';
}

function _populateSalesFilterDropdowns(prefix) {
  // Brands
  if (!window._salesBrandsCache) {
    api.withSuccessHandler(function(rows) {
      window._salesBrandsCache = rows || [];
      _fillSelect('sf_'+prefix+'_brand', window._salesBrandsCache, 'id', 'name');
    }).getBrands();
  } else _fillSelect('sf_'+prefix+'_brand', window._salesBrandsCache, 'id', 'name');

  // Branches
  if (!window._salesBranchesCache) {
    fetch('/api/erp/branches-full', { headers: { 'Authorization': 'Bearer ' + localStorage.getItem('pos_token') } })
      .then(function(r){return r.json();})
      .then(function(rows) {
        window._salesBranchesCache = rows || [];
        _fillSelect('sf_'+prefix+'_branch', window._salesBranchesCache, 'id', 'name');
      }).catch(function(){});
  } else _fillSelect('sf_'+prefix+'_branch', window._salesBranchesCache, 'id', 'name');

  // Channels
  if (!window._salesChannelsCache) {
    fetch('/api/sales-channels/active', { headers: { 'Authorization': 'Bearer ' + localStorage.getItem('pos_token') } })
      .then(function(r){return r.json();})
      .then(function(rows) {
        window._salesChannelsCache = rows || [];
        _fillSelect('sf_'+prefix+'_channel', window._salesChannelsCache, 'id', 'name');
      }).catch(function(){});
  } else _fillSelect('sf_'+prefix+'_channel', window._salesChannelsCache, 'id', 'name');

  // Payment methods (V3)
  if (!window._salesMethodsCache) {
    fetch('/api/settings/payment-methods-full', { headers: { 'Authorization': 'Bearer ' + localStorage.getItem('pos_token') } })
      .then(function(r){return r.json();})
      .then(function(rows) {
        window._salesMethodsCache = (rows || []).map(function(p){ return { id: (p.name||'').toLowerCase(), name: p.nameAr || p.name }; });
        _fillSelect('sf_'+prefix+'_pay', window._salesMethodsCache, 'id', 'name');
      }).catch(function(){});
  } else _fillSelect('sf_'+prefix+'_pay', window._salesMethodsCache, 'id', 'name');

  // Cashiers
  if (!window._salesCashiersCache) {
    fetch('/api/auth/users', { headers: { 'Authorization': 'Bearer ' + localStorage.getItem('pos_token') } })
      .then(function(r){return r.json();})
      .then(function(rows) {
        window._salesCashiersCache = (rows || []).filter(function(u){ return u.role === 'cashier' || u.role === 'admin' || u.role === 'manager'; })
          .map(function(u){ return { id: u.username, name: u.displayName || u.username }; });
        _fillSelect('sf_'+prefix+'_cashier', window._salesCashiersCache, 'id', 'name');
      }).catch(function(){});
  } else _fillSelect('sf_'+prefix+'_cashier', window._salesCashiersCache, 'id', 'name');

  // Cache products for picker
  if (!window._salesProductsCache) {
    fetch('/api/menu/all', { headers: { 'Authorization': 'Bearer ' + localStorage.getItem('pos_token') } })
      .then(function(r){return r.json();})
      .then(function(rows) { window._salesProductsCache = rows || []; });
  }
}

function _fillSelect(id, items, valueKey, labelKey) {
  var sel = document.getElementById(id);
  if (!sel) return;
  var current = sel.value;
  // Keep "الكل" as first option
  sel.innerHTML = '<option value="">الكل</option>' + items.map(function(it) {
    var v = it[valueKey] || '';
    var l = it[labelKey] || v;
    return '<option value="' + v + '"' + (current===v?' selected':'') + '>' + l + '</option>';
  }).join('');
}

function _wireProductPicker(prefix) {
  var host = document.getElementById('sf_' + prefix + '_prodHost');
  var input = document.getElementById('sf_' + prefix + '_prodInput');
  var hidden = document.getElementById('sf_' + prefix + '_prodIds');
  if (!host || !input || !hidden) return;

  var dropdown = null;
  function openDropdown() {
    if (dropdown) { dropdown.remove(); dropdown = null; }
    var query = (input.value || '').toLowerCase().trim();
    var items = (window._salesProductsCache || []).filter(function(p) {
      if (!query) return false;
      return (p.name || '').toLowerCase().indexOf(query) >= 0;
    }).slice(0, 30);
    if (!items.length) return;
    dropdown = document.createElement('div');
    dropdown.className = 'sf-prod-dropdown';
    dropdown.innerHTML = items.map(function(p) {
      return '<div class="sf-prod-option" data-id="' + p.id + '" data-name="' + (p.name||'') + '">' +
        '<span>' + (p.name||'') + '</span>' +
        '<span class="sf-prod-option-meta">' + (p.brandName||'') + (p.category?' · '+p.category:'') + '</span>' +
      '</div>';
    }).join('');
    host.appendChild(dropdown);
    dropdown.addEventListener('click', function(e) {
      var opt = e.target.closest('.sf-prod-option');
      if (!opt) return;
      _addProductChip(prefix, opt.dataset.id, opt.dataset.name);
      input.value = '';
      dropdown.remove(); dropdown = null;
    });
  }
  function closeDropdown() {
    if (dropdown) { dropdown.remove(); dropdown = null; }
  }

  input.addEventListener('input', openDropdown);
  document.addEventListener('click', function(e) { if (!host.contains(e.target)) closeDropdown(); });
}

function _addProductChip(prefix, id, name) {
  var hidden = document.getElementById('sf_' + prefix + '_prodIds');
  var host = document.getElementById('sf_' + prefix + '_prodHost');
  if (!hidden || !host) return;
  var ids = (hidden.value || '').split(',').filter(Boolean);
  if (ids.indexOf(id) >= 0) return;
  ids.push(id);
  hidden.value = ids.join(',');

  var chip = document.createElement('span');
  chip.className = 'sf-prod-chip';
  chip.dataset.id = id;
  chip.innerHTML = '<span>' + name + '</span><i class="fas fa-times"></i>';
  chip.querySelector('i').addEventListener('click', function() {
    chip.remove();
    var ids2 = (hidden.value || '').split(',').filter(function(x){return x && x!==id;});
    hidden.value = ids2.join(',');
  });
  host.insertBefore(chip, host.querySelector('.sf-prod-input'));
}

function _resetSalesFilter(prefix) {
  ['start','end','brand','branch','channel','pay','cashier','minAmt','maxAmt','invoiceNo','prodIds'].forEach(function(k) {
    var el = document.getElementById('sf_' + prefix + '_' + k);
    if (el) el.value = '';
  });
  var host = document.getElementById('sf_' + prefix + '_prodHost');
  if (host) host.querySelectorAll('.sf-prod-chip').forEach(function(c){c.remove();});
  qs('.sf-preset[data-prefix="' + prefix + '"]').forEach(function(el){el.classList.remove('active');});
  _applyDatePreset(prefix, 'thisMonth');
}

window.getSalesFilters = function(prefix) {
  // Reads filter values into a structured object — used by all loaders
  var v = function(k) { var el = document.getElementById('sf_' + prefix + '_' + k); return el ? el.value : ''; };
  return {
    start: v('start'),
    end: v('end'),
    brandId: v('brand'),
    branchId: v('branch'),
    channelId: v('channel'),
    paymentMethod: v('pay'),
    cashier: v('cashier'),
    minAmount: Number(v('minAmt')) || 0,
    maxAmount: Number(v('maxAmt')) || 0,
    invoiceNo: v('invoiceNo'),
    productIds: v('prodIds') ? v('prodIds').split(',').filter(Boolean) : []
  };
};

window._exportSalesFiltered = function(prefix) {
  // Use existing export logic but with filtered cache
  if (typeof exportSalesExcel === 'function') exportSalesExcel();
  else showToast('سيتم دعم التصدير قريباً');
};

// ─── Sales Hub KPIs ──────────────────────────────────────────────────────
window.loadSalesHubKpis = function() {
  var today = _datePreset('today');
  var week = _datePreset('thisWeek');
  var month = _datePreset('thisMonth');
  // Fetch via existing endpoint with date filters
  Promise.all([
    _fetchSalesSummary(today[0], today[1]),
    _fetchSalesSummary(week[0], week[1]),
    _fetchSalesSummary(month[0], month[1])
  ]).then(function(res) {
    var t = res[0] || {}, w = res[1] || {}, m = res[2] || {};
    var fmt = function(n) { return Number(n||0).toLocaleString('ar-SA',{minimumFractionDigits:2,maximumFractionDigits:2}) + ' ر.س'; };
    if (q('#shKpiToday')) q('#shKpiToday').textContent = fmt(t.total);
    if (q('#shKpiTodayCount')) q('#shKpiTodayCount').textContent = (t.count || 0).toLocaleString('ar-SA');
    if (q('#shKpiWeek')) q('#shKpiWeek').textContent = fmt(w.total);
    if (q('#shKpiMonth')) q('#shKpiMonth').textContent = fmt(m.total);
    if (q('#shKpiAvg')) q('#shKpiAvg').textContent = fmt(t.count > 0 ? (t.total / t.count) : 0);
  }).catch(function(err){ console.error('KPI load err:', err); });
};

function _fetchSalesSummary(from, to) {
  return new Promise(function(resolve) {
    var qs = [];
    if (from) qs.push('startDate=' + encodeURIComponent(from));
    if (to)   qs.push('endDate=' + encodeURIComponent(to));
    fetch('/api/sales' + (qs.length ? '?' + qs.join('&') : ''),
      { headers: { 'Authorization': 'Bearer ' + localStorage.getItem('pos_token') } })
      .then(function(r){return r.json();})
      .then(function(rows) {
        var arr = Array.isArray(rows) ? rows : [];
        var total = arr.reduce(function(s,x){return s + Number(x.totalFinal || x.total_final || 0);}, 0);
        resolve({ total: total, count: arr.length });
      })
      .catch(function(){ resolve({ total:0, count:0 }); });
  });
}

// ─── Advanced Reports loader ─────────────────────────────────────────────
window.loadSalesAdvancedReports = function() {
  var f = getSalesFilters('advanced');
  // 1) Current period summary
  _fetchSalesSummary(f.start, f.end).then(function(cur) {
    // 2) Previous-period summary (same length, immediately before)
    var prevRange = _getPreviousPeriod(f.start, f.end);
    _fetchSalesSummary(prevRange[0], prevRange[1]).then(function(prev) {
      _renderAdvancedCompare(cur, prev);
    });
  });

  // 3) Detailed sales for charts + insights
  var qs = [];
  if (f.start) qs.push('startDate=' + encodeURIComponent(f.start));
  if (f.end)   qs.push('endDate=' + encodeURIComponent(f.end));
  fetch('/api/sales' + (qs.length ? '?' + qs.join('&') : ''),
    { headers: { 'Authorization': 'Bearer ' + localStorage.getItem('pos_token') } })
    .then(function(r){return r.json();})
    .then(function(rows) {
      _renderPeakHours(rows || []);
      _renderTopProducts(rows || []);
      _renderChannelDistribution(rows || []);
      _renderPayDistribution(rows || []);
      _renderInsights(rows || [], f);
    });
};

function _getPreviousPeriod(start, end) {
  if (!start || !end) return ['',''];
  var s = new Date(start), e = new Date(end);
  var lengthMs = e - s + 86400000; // inclusive
  var prevEnd = new Date(s); prevEnd.setDate(prevEnd.getDate() - 1);
  var prevStart = new Date(prevEnd); prevStart.setTime(prevStart.getTime() - lengthMs + 86400000);
  var fmt = function(d) {
    return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
  };
  return [fmt(prevStart), fmt(prevEnd)];
}

function _renderAdvancedCompare(cur, prev) {
  var fmt = function(n) { return Number(n||0).toLocaleString('ar-SA',{minimumFractionDigits:2,maximumFractionDigits:2}) + ' ر.س'; };
  if (q('#advCurValue')) q('#advCurValue').textContent = fmt(cur.total);
  if (q('#advCurSub'))   q('#advCurSub').textContent   = (cur.count || 0).toLocaleString('ar-SA') + ' فاتورة';
  if (q('#advPrevValue')) q('#advPrevValue').textContent = fmt(prev.total);
  if (q('#advPrevSub'))   q('#advPrevSub').textContent   = (prev.count || 0).toLocaleString('ar-SA') + ' فاتورة';
  var deltaPct = prev.total > 0 ? ((cur.total - prev.total) / prev.total * 100) : (cur.total > 0 ? 100 : 0);
  var deltaEl = q('#advDelta');
  if (deltaEl) {
    deltaEl.textContent = (deltaPct >= 0 ? '+' : '') + deltaPct.toFixed(1) + '%';
    deltaEl.style.color = deltaPct > 0 ? '#16a34a' : (deltaPct < 0 ? '#dc2626' : '#64748b');
  }
  var deltaSubEl = q('#advDeltaSub');
  if (deltaSubEl) {
    var diff = cur.total - prev.total;
    deltaSubEl.textContent = (diff >= 0 ? '+' : '') + fmt(Math.abs(diff));
    deltaSubEl.style.color = diff > 0 ? '#16a34a' : (diff < 0 ? '#dc2626' : '#64748b');
  }
}

function _renderPeakHours(rows) {
  var byHour = {};
  for (var h = 0; h < 24; h++) byHour[h] = { count:0, total:0 };
  rows.forEach(function(s) {
    var d = new Date(s.orderDate || s.order_date);
    if (isNaN(d)) return;
    var h = d.getHours();
    byHour[h].count++;
    byHour[h].total += Number(s.totalFinal || s.total_final || 0);
  });
  var labels = Object.keys(byHour).map(function(h){ return h + ':00'; });
  var data = Object.keys(byHour).map(function(h){ return byHour[h].total; });
  var ctx = document.getElementById('advPeakChart');
  if (!ctx || typeof Chart === 'undefined') return;
  if (window._advPeakChart) window._advPeakChart.destroy();
  window._advPeakChart = new Chart(ctx, {
    type: 'bar',
    data: { labels: labels, datasets: [{ label: 'الإيراد', data: data, backgroundColor: '#3b82f6', borderRadius: 6 }] },
    options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
  });
  // Find peak hour
  var peakH = -1, peakV = 0;
  Object.keys(byHour).forEach(function(h) { if (byHour[h].total > peakV) { peakV = byHour[h].total; peakH = h; } });
  var sumEl = q('#advPeakSummary');
  if (sumEl && peakH >= 0) sumEl.innerHTML = '<i class="fas fa-fire" style="color:#f59e0b;"></i> ساعة الذروة: <b>' + peakH + ':00</b> بإيراد <b>' + Number(peakV).toFixed(2) + ' ر.س</b>';
}

function _renderTopProducts(rows) {
  var tally = {}; // name → { qty, revenue }
  rows.forEach(function(s) {
    var items = [];
    try { items = JSON.parse(s.itemsJson || s.items_json || '[]'); } catch(e) {}
    items.forEach(function(it) {
      var key = it.name || 'غير معروف';
      if (!tally[key]) tally[key] = { qty: 0, revenue: 0 };
      tally[key].qty += Number(it.qty) || 0;
      tally[key].revenue += (Number(it.qty) || 0) * (Number(it.price) || 0);
    });
  });
  var arr = Object.keys(tally).map(function(k){ return { name:k, qty:tally[k].qty, revenue:tally[k].revenue }; });
  arr.sort(function(a,b){ return b.revenue - a.revenue; });
  var top = arr.slice(0, 10);
  var totalRev = arr.reduce(function(s,x){return s+x.revenue;}, 0);
  var tbody = q('#advTopProducts');
  if (!tbody) return;
  if (!top.length) { tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#94a3b8;padding:14px;">لا بيانات</td></tr>'; return; }
  tbody.innerHTML = top.map(function(p, i) {
    var pct = totalRev > 0 ? (p.revenue / totalRev * 100) : 0;
    return '<tr>' +
      '<td><b>#' + (i+1) + '</b></td>' +
      '<td>' + p.name + '</td>' +
      '<td>' + p.qty + '</td>' +
      '<td><b>' + p.revenue.toFixed(2) + '</b></td>' +
      '<td style="color:#3b82f6;">' + pct.toFixed(1) + '%</td>' +
    '</tr>';
  }).join('');
}

function _renderChannelDistribution(rows) {
  var byCh = {};
  rows.forEach(function(s) {
    var ch = s.channelName || s.channel_name || 'بدون قناة';
    byCh[ch] = (byCh[ch] || 0) + Number(s.totalFinal || s.total_final || 0);
  });
  var ctx = document.getElementById('advChannelChart');
  if (!ctx || typeof Chart === 'undefined') return;
  if (window._advChannelChart) window._advChannelChart.destroy();
  var labels = Object.keys(byCh), data = labels.map(function(k){ return byCh[k]; });
  if (!labels.length) labels = ['لا بيانات'], data = [0];
  window._advChannelChart = new Chart(ctx, {
    type: 'doughnut',
    data: { labels: labels, datasets: [{ data: data, backgroundColor: ['#3b82f6','#22c55e','#f59e0b','#8b5cf6','#ef4444','#06b6d4','#94a3b8'] }] },
    options: { responsive: true, plugins: { legend: { position: 'bottom', rtl: true } } }
  });
}

function _renderPayDistribution(rows) {
  var byPay = {};
  rows.forEach(function(s) {
    var pm = (s.paymentMethod || s.payment_method || 'cash').toLowerCase();
    if (pm.indexOf('/') >= 0) {
      pm.split('/').forEach(function(part) {
        var p = part.split(':');
        var k = p[0]; var amt = Number(p[1]) || 0;
        byPay[k] = (byPay[k] || 0) + amt;
      });
    } else {
      byPay[pm] = (byPay[pm] || 0) + Number(s.totalFinal || s.total_final || 0);
    }
  });
  var ctx = document.getElementById('advPayChart');
  if (!ctx || typeof Chart === 'undefined') return;
  if (window._advPayChart) window._advPayChart.destroy();
  var labels = Object.keys(byPay), data = labels.map(function(k){ return byPay[k]; });
  if (!labels.length) labels = ['لا بيانات'], data = [0];
  window._advPayChart = new Chart(ctx, {
    type: 'pie',
    data: { labels: labels, datasets: [{ data: data, backgroundColor: ['#22c55e','#3b82f6','#f59e0b','#8b5cf6','#ef4444','#06b6d4'] }] },
    options: { responsive: true, plugins: { legend: { position: 'bottom', rtl: true } } }
  });
}

function _renderInsights(rows, filters) {
  var host = q('#advInsights');
  if (!host) return;
  if (!rows.length) { host.innerHTML = '<div class="adv-empty">لا توجد بيانات في الفترة المختارة.</div>'; return; }

  var insights = [];
  // Insight 1: avg ticket
  var total = rows.reduce(function(s,x){return s + Number(x.totalFinal || x.total_final || 0);}, 0);
  var avg = total / rows.length;
  insights.push({ icon:'fa-calculator', title:'متوسط الفاتورة', text: avg.toFixed(2) + ' ر.س عبر ' + rows.length + ' فاتورة' });

  // Insight 2: best day
  var byDay = {};
  rows.forEach(function(s) {
    var d = new Date(s.orderDate || s.order_date);
    if (isNaN(d)) return;
    var key = d.toISOString().slice(0,10);
    byDay[key] = (byDay[key] || 0) + Number(s.totalFinal || s.total_final || 0);
  });
  var bestDay = ''; var bestVal = 0;
  Object.keys(byDay).forEach(function(k){ if (byDay[k] > bestVal) { bestVal = byDay[k]; bestDay = k; } });
  if (bestDay) insights.push({ icon:'fa-trophy', title:'أفضل يوم في الفترة', text: bestDay + ' بإيراد ' + bestVal.toFixed(2) + ' ر.س' });

  // Insight 3: discount usage
  var withDisc = rows.filter(function(s){ return Number(s.discountAmount || s.discount_amount || 0) > 0; });
  if (withDisc.length) {
    var discSum = withDisc.reduce(function(s,x){return s + Number(x.discountAmount || x.discount_amount || 0);}, 0);
    insights.push({ icon:'fa-percent', title:'الخصومات المُطبَّقة', text: withDisc.length + ' فاتورة بخصم إجمالي ' + discSum.toFixed(2) + ' ر.س' });
  }

  // Insight 4: channels active
  var channels = {};
  rows.forEach(function(s){ if (s.channelName || s.channel_name) channels[s.channelName || s.channel_name] = true; });
  var chCount = Object.keys(channels).length;
  if (chCount > 0) insights.push({ icon:'fa-store', title:'عدد القنوات النشطة', text: chCount + ' قناة بيع نشطة في هذه الفترة' });

  host.innerHTML = insights.map(function(i) {
    return '<div class="adv-insight-card"><i class="fas ' + i.icon + '"></i><div><b>' + i.title + '</b><span>' + i.text + '</span></div></div>';
  }).join('');
}

function resetSalesFilter() {
  if (q("#fsStart")) q("#fsStart").value = "";
  if (q("#fsEnd")) q("#fsEnd").value = "";
  if (q("#fsCashier")) q("#fsCashier").value = "";
  if (q("#fsPay")) q("#fsPay").value = "";
  loadDashSales();
}
function exportSalesExcel() {
  ensureXlsx().then(_exportSalesExcelBody).catch(function(e) { showToast(e.message || 'فشل تحميل XLSX', true); });
}
function _exportSalesExcelBody() {
  var cache = state.salesCache || [];
  if (!cache.length) return showToast('No sales data to export', true);
  var wsData = [['Invoice #','Date','Cashier','Products','Payment','Amount']];
  cache.forEach(function(s){
    var items = '';
    if (s.items && s.items.length) items = s.items.map(function(it){return it.qty+'x '+it.name;}).join(', ');
    wsData.push([s.orderId, s.date, s.username, items, s.payment, Number(s.total)||0]);
  });
  var wb = XLSX.utils.book_new();
  var ws = XLSX.utils.aoa_to_sheet(wsData);
  ws['!cols'] = [{wch:18},{wch:20},{wch:12},{wch:40},{wch:12},{wch:12}];
  XLSX.utils.book_append_sheet(wb, ws, 'Sales');
  XLSX.writeFile(wb, 'Sales_'+new Date().toISOString().split('T')[0]+'.xlsx');
}

function loadPayments() {
  loader();
  // V3: Prefer new filter bar values
  var f = (typeof getSalesFilters === 'function' && q('#sf_payments_start')) ? getSalesFilters('payments') : null;
  var start = f ? f.start : (q("#fpayStart") ? q("#fpayStart").value : "");
  var end   = f ? f.end   : (q("#fpayEnd")   ? q("#fpayEnd").value   : "");
  if (!start && !end) {
    var today = localDateStr();
    start = today; end = today;
    if (q("#fpayStart")) q("#fpayStart").value = today;
    if (q("#fpayEnd"))   q("#fpayEnd").value   = today;
  } else if (!end) end = start;
  else if (!start) start = end;
  var cashier = f ? f.cashier : (q("#fpayCashier") ? q("#fpayCashier").value : "");
  var brandId  = f ? f.brandId  : '';
  var branchId = f ? f.branchId : '';
  var channelId = f ? f.channelId : '';
  // Widen server range ±1 day for timezone drift
  var queryStart = localDateStr(new Date(start + 'T00:00:00').getTime() - 86400000);
  var queryEnd   = localDateStr(new Date(end + 'T00:00:00').getTime() + 86400000);
  var params = { startDate: queryStart, endDate: queryEnd };
  if (cashier) params.username = cashier;

  // No dedicated /payments-summary endpoint exists — compute everything from /api/sales
  api.withFailureHandler(function(err) { loader(false); showToast(err.message || 'فشل تحميل الدفعات', true); })
    .withSuccessHandler(function(sales) {
      loader(false);
      sales = Array.isArray(sales) ? sales : [];

      // Client-side re-filter using LOCAL dates (we widened the server query)
      var startMs = new Date(start + 'T00:00:00').getTime();
      var endMs   = new Date(end + 'T23:59:59.999').getTime();
      sales = sales.filter(function(r) {
        var t = new Date(r.date).getTime();
        if (isNaN(t) || t < startMs || t > endMs) return false;
        // V3 filters
        if (brandId && r.brandId && r.brandId !== brandId) return false;
        if (branchId && r.branchId && r.branchId !== branchId) return false;
        if (channelId && r.channelId && r.channelId !== channelId) return false;
        return true;
      });

      var totals = { cash: 0, card: 0, kita: 0, all: 0 };
      var counts = { cash: 0, card: 0, kita: 0, all: 0 };
      var dayMap = {};      // key = YYYY-MM-DD (local)
      var cashierMap = {};  // key = username

      sales.forEach(function(s) {
        var amount = Number(s.total) || 0;
        var dateKey = localDateStr(s.date);
        var user = s.username || '—';

        totals.all += amount; counts.all += 1;
        // Distributes split payments correctly across cash/card/kita buckets
        distributePayment(s.payment, amount, totals, counts);

        if (!dayMap[dateKey]) dayMap[dateKey] = { date: dateKey, cash: 0, card: 0, kita: 0, other: 0, total: 0, count: 0 };
        var dRow = dayMap[dateKey];
        dRow.total += amount; dRow.count += 1;
        distributePayment(s.payment, amount, dRow);

        if (!cashierMap[user]) cashierMap[user] = { username: user, cash: 0, card: 0, kita: 0, other: 0, total: 0, count: 0 };
        var cRow = cashierMap[user];
        cRow.total += amount; cRow.count += 1;
        distributePayment(s.payment, amount, cRow);
      });

      // Summary KPI cards
      if (q("#payTotalCash")) q("#payTotalCash").innerText = formatVal(totals.cash);
      if (q("#payTotalCard")) q("#payTotalCard").innerText = formatVal(totals.card);
      if (q("#payTotalKita")) q("#payTotalKita").innerText = formatVal(totals.kita);
      if (q("#payTotalAll"))  q("#payTotalAll").innerText  = formatVal(totals.all);
      if (q("#payCntCash"))   q("#payCntCash").innerText   = counts.cash;
      if (q("#payCntCard"))   q("#payCntCard").innerText   = counts.card;
      if (q("#payCntKita"))   q("#payCntKita").innerText   = counts.kita;
      if (q("#payCntAll"))    q("#payCntAll").innerText    = counts.all;

      // Daily table (sorted newest first)
      var daily = Object.values(dayMap).sort(function(a, b) { return a.date < b.date ? 1 : -1; });
      var h = '';
      if (!daily.length) {
        h = "<tr><td colspan='6' style='text-align:center;padding:20px;'>لا توجد بيانات</td></tr>";
      } else {
        daily.forEach(function(day) {
          h += '<tr>' +
            '<td style="font-weight:700;">' + day.date + '</td>' +
            '<td style="color:#16a34a;font-weight:700;">' + formatVal(day.cash) + '</td>' +
            '<td style="color:#1e40af;font-weight:700;">' + formatVal(day.card) + '</td>' +
            '<td style="color:#854d0e;font-weight:700;">' + formatVal(day.kita) + '</td>' +
            '<td style="font-weight:900;color:var(--primary);">' + formatVal(day.total) + '</td>' +
            '<td>' + day.count + '</td>' +
          '</tr>';
        });
      }
      if (q("#tbPayments")) q("#tbPayments").innerHTML = h;

      // Cashier table (sorted by total descending)
      var byCashier = Object.values(cashierMap).sort(function(a, b) { return b.total - a.total; });
      var ch = '';
      if (!byCashier.length) {
        ch = "<tr><td colspan='6' style='text-align:center;padding:20px;'>لا توجد بيانات</td></tr>";
      } else {
        byCashier.forEach(function(c) {
          ch += '<tr>' +
            '<td style="font-weight:800;">' + userLabel(c.username) + '</td>' +
            '<td style="color:#16a34a;">' + formatVal(c.cash) + '</td>' +
            '<td style="color:#1e40af;">' + formatVal(c.card) + '</td>' +
            '<td style="color:#854d0e;">' + formatVal(c.kita) + '</td>' +
            '<td style="font-weight:900;color:var(--secondary);">' + formatVal(c.total) + '</td>' +
            '<td>' + c.count + '</td>' +
          '</tr>';
        });
      }
      if (q("#tbPayCashier")) q("#tbPayCashier").innerHTML = ch;
    }).getSalesListDetailed(params);
}

function loadSalesBreakdownActive() {
  loadSalesBreakdown(activeBreakdownType);
}

function loadSalesBreakdown(type) {
  ensureChartJs().then(function() { _loadSalesBreakdownBody(type); }).catch(function(e) { showToast(e.message || 'فشل تحميل المكتبات', true); });
}
function _loadSalesBreakdownBody(type) {
  activeBreakdownType = type;
  qs('.breakdown-btn').forEach(el => el.classList.remove('active'));
  const btn = q('#brk_' + type);
  if (btn) btn.classList.add('active');

  loader();
  // V3: Prefer new filter bar values
  var f = (typeof getSalesFilters === 'function' && q('#sf_reports_start')) ? getSalesFilters('reports') : null;
  var start = f ? f.start : (q("#fbrkStart") ? q("#fbrkStart").value : "");
  var end   = f ? f.end   : (q("#fbrkEnd")   ? q("#fbrkEnd").value   : "");
  if (!start || !end) {
    var today = new Date();
    var thirty = new Date(today); thirty.setDate(thirty.getDate() - 29);
    if (!end)   end   = localDateStr(today);
    if (!start) start = localDateStr(thirty);
    if (q("#fbrkStart") && !q("#fbrkStart").value) q("#fbrkStart").value = start;
    if (q("#fbrkEnd")   && !q("#fbrkEnd").value)   q("#fbrkEnd").value   = end;
  }
  // Widen server query ±1 day for timezone drift
  var queryStart = localDateStr(new Date(start + 'T00:00:00').getTime() - 86400000);
  var queryEnd   = localDateStr(new Date(end + 'T00:00:00').getTime() + 86400000);
  var params = { startDate: queryStart, endDate: queryEnd };

  // No /salesBreakdown endpoint exists — compute everything from /api/sales
  api.withFailureHandler(function(err) { loader(false); showToast(err.message || 'فشل تحميل التقرير', true); })
  .withSuccessHandler(function(sales) {
    loader(false);
    sales = Array.isArray(sales) ? sales : [];

    // Client-side re-filter on LOCAL dates after the ±1 day widening above
    var startMs = new Date(start + 'T00:00:00').getTime();
    var endMs   = new Date(end + 'T23:59:59.999').getTime();
    sales = sales.filter(function(r) {
      var t = new Date(r.date).getTime();
      return !isNaN(t) && t >= startMs && t <= endMs;
    });

    // Aggregate the sales into the requested breakdown shape
    var aggregated = {};
    sales.forEach(function(s) {
      var amount = Number(s.total) || 0;
      var pay = String(s.payment || '').toLowerCase();
      var dateKey = localDateStr(s.date);

      if (type === 'byProduct') {
        (s.items || []).forEach(function(it) {
          var name = it.name || 'غير معروف';
          if (!aggregated[name]) aggregated[name] = { name: name, qty: 0, orders: 0, revenue: 0 };
          aggregated[name].qty += Number(it.qty) || 0;
          aggregated[name].orders += 1;
          aggregated[name].revenue += (Number(it.price) || 0) * (Number(it.qty) || 0);
        });
      } else if (type === 'byCashier') {
        var u = s.username || '—';
        if (!aggregated[u]) aggregated[u] = { name: userLabel(u), orders: 0, cash: 0, card: 0, kita: 0, other: 0, revenue: 0 };
        aggregated[u].orders += 1;
        aggregated[u].revenue += amount;
        distributePayment(s.payment, amount, aggregated[u]);
      } else if (type === 'byMonth') {
        var monthKey = dateKey.substring(0, 7); // YYYY-MM
        if (!aggregated[monthKey]) aggregated[monthKey] = { name: monthKey, orders: 0, revenue: 0 };
        aggregated[monthKey].orders += 1;
        aggregated[monthKey].revenue += amount;
      } else if (type === 'byDay') {
        if (!aggregated[dateKey]) aggregated[dateKey] = { name: dateKey, orders: 0, revenue: 0 };
        aggregated[dateKey].orders += 1;
        aggregated[dateKey].revenue += amount;
      } else if (type === 'byChannel') {
        var ch = s.channelName || s.channel_name || 'بدون قناة';
        if (!aggregated[ch]) aggregated[ch] = { name: ch, orders: 0, revenue: 0 };
        aggregated[ch].orders += 1;
        aggregated[ch].revenue += amount;
      } else if (type === 'byHour') {
        var dt = new Date(s.date);
        var hourKey = isNaN(dt) ? '?' : (String(dt.getHours()).padStart(2,'0') + ':00');
        if (!aggregated[hourKey]) aggregated[hourKey] = { name: hourKey, orders: 0, revenue: 0 };
        aggregated[hourKey].orders += 1;
        aggregated[hourKey].revenue += amount;
      }
    });

    // Sort: revenue desc for product/cashier/channel; chronological for time-based
    var data = Object.values(aggregated);
    if (type === 'byMonth' || type === 'byDay' || type === 'byHour') {
      data.sort(function(a, b) { return a.name < b.name ? -1 : 1; });
    } else {
      data.sort(function(a, b) { return b.revenue - a.revenue; });
    }
    // Update table headers
    const headMap = {
      byProduct: '<tr><th>\u0627\u0644\u0645\u0646\u062a\u062c</th><th>\u0627\u0644\u0643\u0645\u064a\u0629</th><th>\u0639\u062f\u062f \u0627\u0644\u0637\u0644\u0628\u0627\u062a</th><th>\u0627\u0644\u0625\u064a\u0631\u0627\u062f (SAR)</th></tr>',
      byCashier: '<tr><th>\u0627\u0644\u0643\u0627\u0634\u064a\u0631</th><th>\u0627\u0644\u0637\u0644\u0628\u0627\u062a</th><th>\u0643\u0627\u0634</th><th>\u0645\u062f\u0649</th><th>\u0643\u064a\u062a\u0627</th><th>\u0627\u0644\u0625\u064a\u0631\u0627\u062f (SAR)</th></tr>',
      byMonth:   '<tr><th>\u0627\u0644\u0634\u0647\u0631</th><th>\u0639\u062f\u062f \u0627\u0644\u0637\u0644\u0628\u0627\u062a</th><th>\u0627\u0644\u0625\u064a\u0631\u0627\u062f (SAR)</th></tr>',
      byDay:     '<tr><th>\u0627\u0644\u064a\u0648\u0645</th><th>\u0639\u062f\u062f \u0627\u0644\u0637\u0644\u0628\u0627\u062a</th><th>\u0627\u0644\u0625\u064a\u0631\u0627\u062f (SAR)</th></tr>',
      byChannel: '<tr><th>\u0627\u0644\u0642\u0646\u0627\u0629</th><th>\u0639\u062f\u062f \u0627\u0644\u0637\u0644\u0628\u0627\u062a</th><th>\u0627\u0644\u0625\u064a\u0631\u0627\u062f (SAR)</th></tr>',
      byHour:    '<tr><th>\u0627\u0644\u0633\u0627\u0639\u0629</th><th>\u0639\u062f\u062f \u0627\u0644\u0637\u0644\u0628\u0627\u062a</th><th>\u0627\u0644\u0625\u064a\u0631\u0627\u062f (SAR)</th></tr>'
    };
    q("#tbBrkHead").innerHTML = headMap[type] || '';

    // Build table rows
    let h = "";
    if (!data.length) {
      const cols = type === 'byCashier' ? 6 : (type === 'byProduct' ? 4 : 3);
      h = `<tr><td colspan='${cols}' style='text-align:center;padding:20px;'>\u0644\u0627 \u062a\u0648\u062c\u062f \u0628\u064a\u0627\u0646\u0627\u062a</td></tr>`;
    } else {
      data.forEach((item, idx) => {
        if (type === 'byProduct') {
          h += `<tr><td style="font-weight:700;">${item.name}</td><td>${item.qty}</td><td>${item.orders}</td><td style="font-weight:900;color:var(--secondary);">${formatVal(item.revenue)}</td></tr>`;
        } else if (type === 'byCashier') {
          h += `<tr><td style="font-weight:700;">${item.name}</td><td>${item.orders}</td><td style="color:#16a34a;">${formatVal(item.cash)}</td><td style="color:#1e40af;">${formatVal(item.card)}</td><td style="color:#854d0e;">${formatVal(item.kita)}</td><td style="font-weight:900;color:var(--secondary);">${formatVal(item.revenue)}</td></tr>`;
        } else {
          h += `<tr><td style="font-weight:700;">${item.name}</td><td>${item.orders}</td><td style="font-weight:900;color:var(--secondary);">${formatVal(item.revenue)}</td></tr>`;
        }
      });
    }
    q("#tbBrkBody").innerHTML = h;

    // Build chart
    if (breakdownChartInst) breakdownChartInst.destroy();
    const ctx = q("#breakdownChartCtx");
    if (ctx && data.length > 0) {
      const labels = data.slice(0, 15).map(d => d.name);
      const values = data.slice(0, 15).map(d => d.revenue);
      const colors = ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899','#06b6d4','#84cc16','#f97316','#6366f1','#14b8a6','#e11d48','#0ea5e9','#a855f7','#22c55e'];
      const chartType = (type === 'byMonth' || type === 'byDay') ? 'line' : 'bar';

      breakdownChartInst = new Chart(ctx.getContext('2d'), {
        type: chartType,
        data: {
          labels: labels,
          datasets: [{
            label: '\u0627\u0644\u0625\u064a\u0631\u0627\u062f (SAR)',
            data: values,
            backgroundColor: chartType === 'bar' ? colors.slice(0, labels.length) : 'rgba(59,130,246,0.1)',
            borderColor: chartType === 'line' ? '#3b82f6' : undefined,
            borderWidth: chartType === 'line' ? 3 : 0,
            borderRadius: chartType === 'bar' ? 8 : 0,
            fill: chartType === 'line',
            tension: 0.4,
            pointBackgroundColor: '#fff',
            pointBorderColor: '#3b82f6',
            pointBorderWidth: 2,
            pointRadius: 5
          }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: { y: { beginAtZero: true, grid: { color: '#f1f5f9' } }, x: { grid: { display: false } } }
        }
      });
    }
  }).getSalesListDetailed(params);
}

// =========================================
// 11. Searchable Purchase Dropdown
// =========================================
let purDropdownOpen = false;

function filterPurItems() {
  const search = q("#purItemSearch").value.toLowerCase();
  const items = state.purInvItems || [];
  const results = q("#purItemResults");
  let filtered = items;
  if (search) {
    filtered = items.filter(i => 
      String(i.name||"").toLowerCase().includes(search) || 
      String(i.id||"").toLowerCase().includes(search) ||
      String(i.category||"").toLowerCase().includes(search)
    );
  }

  let h = "";
  filtered.forEach(item => {
    const safeId = String(item.id).replace(/'/g,"\\'");
    const safeName = String(item.name).replace(/'/g,"\\'");
    h += `<div class="sd-result-item" onclick="selectPurItem('${safeId}','${safeName}','${item.cost || 0}')">
      <div><span class="sd-item-name">${item.name}</span></div>
      <span class="sd-item-meta">${item.unit || ''} | ${formatVal(item.cost)} SAR</span>
    </div>`;
  });
  // Add "new material" option
  if (search) {
    h += `<div class="sd-result-item sd-add-new" onclick="selectPurItemNew()">
      <i class="fas fa-plus-circle"></i> \u0625\u0636\u0627\u0641\u0629 \u0645\u0627\u062f\u0629 \u062c\u062f\u064a\u062f\u0629: "${q('#purItemSearch').value}"
    </div>`;
  }
  results.innerHTML = h;
  results.classList.add('open');
  purDropdownOpen = true;
}

function selectPurItem(id, name, cost) {
  q("#purItemSearch").value = name.trim();
  q("#purItem").value = name.trim();
  q("#purItemId").value = id.trim();
  if (cost && Number(cost) > 0) q("#purUnitPrice").value = cost;
  q("#purItemResults").classList.remove('open');
  purDropdownOpen = false;
}

function selectPurItemNew() {
  const name = q("#purItemSearch").value;
  q("#purItem").value = name;
  q("#purItemId").value = "";
  q("#purItemResults").classList.remove('open');
  purDropdownOpen = false;
}

// Close dropdown when clicking outside
document.addEventListener('click', function(e) {
  if (purDropdownOpen && !e.target.closest('#purItemDropdown')) {
  q("#purItemResults").classList.remove('open');
    purDropdownOpen = false;
  }
});

// =========================================
// Purchase: delete & save & print
// =========================================
function delPurFn(id) {
  if (confirm("هل أنت متأكد من حذف هذه المشتروات؟")) {
    loader();
    api.withSuccessHandler(r => { loader(false); showToast("تم الحذف"); loadDashPurchases(); }).deletePurchase(id);
  }
}

function printPurchaseCached(idx) {
  var arr = state.purchasesCache;
  if (!arr || !arr[idx]) return showToast("لا توجد بيانات للطباعة", true);
  var p = arr[idx];
  // If invoice has ItemsJSON, print with full details
  if (p.itemsJson && p.itemsJson.length > 5) {
    try {
      var items = JSON.parse(p.itemsJson);
      printPurchaseInvoice(p, items);
      return;
    } catch(e) {}
  }
  printPurchase(p.id, p.supplierName, p.itemName, p.qty, p.unitPrice, p.totalPrice, p.paymentMethod, p.date, p.username, p.notes || "");
}
function printPurchaseInvoice(p, items) {
  var companyName = (state.settings&&state.settings.name)||'الشركة';
  var taxNumber = (state.settings&&state.settings.taxNumber)||'';
  var currency = (state.settings&&state.settings.currency)||'SAR';
  var dateF = p.date ? new Date(p.date).toLocaleString('en-US') : '';
  // المبالغ بدون ضريبة — الضريبة تُضاف عليها
  var grandNet = Number(p.totalPrice)||0;
  var grandVAT = Math.round(grandNet*0.15*100)/100;
  var grandTotal = Math.round((grandNet+grandVAT)*100)/100;
  var rows = items.map(function(it,i){
    // Support both camelCase (new pipeline) and PascalCase (legacy)
    var iname = it.itemName || it.name || it.ItemName || '';
    var iqty  = Number(it.qty || it.Qty) || 0;
    var iprc  = Number(it.unitPrice || it.UnitPrice) || 0;
    var iunit = it.unit || it.Unit || '—';
    var t = iqty * iprc;
    var iNet = t;
    var iVat = Math.round(t*0.15*100)/100;
    return '<tr><td>'+(i+1)+'</td><td style="font-weight:600;text-align:right;padding-right:12px;">'+iname+'</td><td>'+iqty+'</td><td>'+iunit+'</td><td>'+iprc.toFixed(2)+'</td><td>'+iNet.toFixed(2)+'</td><td style="color:#d97706;">'+iVat.toFixed(2)+'</td><td style="font-weight:700;">'+(iNet+iVat).toFixed(2)+'</td></tr>';
  }).join('');
  var w = window.open('','_blank','width=750,height=700');
  w.document.write('<!DOCTYPE html><html dir="rtl"><head><meta charset="UTF-8"><title>فاتورة شراء '+p.id+'</title>'+
    '<style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:Arial,sans-serif;padding:24px;color:#1e293b;font-size:13px;}'+
    '.header{background:linear-gradient(135deg,#0f172a,#1e3a8a);color:#fff;border-radius:14px;padding:20px 24px;margin-bottom:18px;display:flex;justify-content:space-between;align-items:center;}'+
    '.header h1{font-size:20px;font-weight:900;}.header .sub{font-size:11px;opacity:.7;margin-top:3px;}'+
    '.header .tag{background:rgba(255,255,255,.15);padding:6px 16px;border-radius:20px;font-weight:700;}'+
    '.info{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;}.info div{background:#f8fafc;padding:10px 14px;border-radius:10px;border:1px solid #e2e8f0;}'+
    '.info .lbl{font-size:10px;color:#64748b;}.info .val{font-weight:700;font-size:14px;}'+
    'table{width:100%;border-collapse:collapse;margin:10px 0;}th,td{border:1px solid #e2e8f0;padding:8px 10px;text-align:center;font-size:12px;}'+
    'th{background:#f1f5f9;font-weight:700;color:#475569;}'+
    '.totals{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:14px;}'+
    '.tot-card{padding:12px;border-radius:10px;text-align:center;border:1px solid #e2e8f0;}.tot-card .l{font-size:10px;color:#64748b;}.tot-card .v{font-size:18px;font-weight:900;}'+
    '.notes{margin-top:10px;background:#fefce8;padding:10px 14px;border-radius:8px;font-size:12px;border:1px solid #fef08a;}'+
    '.sig{display:flex;justify-content:space-around;margin-top:30px;}.sig div{text-align:center;}.sig .line{width:140px;border-bottom:1px solid #94a3b8;padding-top:35px;margin:0 auto;}.sig .cap{font-size:11px;color:#64748b;margin-top:4px;}'+
    '@media print{body{padding:10px;}.header,.tot-card{print-color-adjust:exact;-webkit-print-color-adjust:exact;}}</style></head><body>'+
    '<div class="header"><div><h1>'+companyName+'</h1><div class="sub">Tax: '+taxNumber+'</div></div><div><div class="tag">فاتورة شراء ضريبية</div><div style="text-align:center;font-size:11px;opacity:.7;margin-top:4px;">'+p.id+'</div></div></div>'+
    '<div class="info"><div><div class="lbl">المورد</div><div class="val">'+p.supplierName+'</div></div><div><div class="lbl">التاريخ</div><div class="val">'+dateF+'</div></div><div><div class="lbl">المنشئ</div><div class="val">'+p.username+'</div></div><div><div class="lbl">طريقة الدفع</div><div class="val">'+p.paymentMethod+'</div></div></div>'+
    '<table><thead><tr><th>#</th><th>الصنف</th><th>الكمية</th><th>الوحدة</th><th>سعر الوحدة</th><th>الصافي</th><th style="color:#d97706;">الضريبة 15%</th><th>الإجمالي</th></tr></thead><tbody>'+rows+'</tbody></table>'+
    '<div class="totals">'+
      '<div class="tot-card" style="background:#f8fafc;"><div class="l">المبلغ قبل الضريبة</div><div class="v">'+grandNet.toFixed(2)+'</div></div>'+
      '<div class="tot-card" style="background:#fefce8;"><div class="l">ضريبة القيمة المضافة 15%</div><div class="v" style="color:#d97706;">'+grandVAT.toFixed(2)+'</div></div>'+
      '<div class="tot-card" style="background:#eff6ff;border-color:#93c5fd;"><div class="l">إجمالي الفاتورة</div><div class="v" style="color:#1e40af;">'+grandTotal.toFixed(2)+' '+currency+'</div></div>'+
    '</div>'+
    (p.notes?'<div class="notes"><strong>ملاحظات:</strong> '+p.notes+'</div>':'')+
    '<div class="sig"><div><div class="line"></div><div class="cap">توقيع المستلم</div><div class="cap" style="color:#1e293b;font-weight:700;">الاسم: '+(p.username||'______________')+'</div></div><div><div class="line"></div><div class="cap">المورد</div></div><div><div class="line"></div><div class="cap">المدير</div></div></div>'+
    '</body></html>');
  w.document.close();
  setTimeout(function(){w.print();},400);
}

function printPurchase(id, supplier, itemName, qty, unitPrice, totalPrice, payMethod, date, username, notes) {
  itemName = String(itemName || "").trim();
  supplier = String(supplier || "").trim();
  username = String(username || "").trim();
  notes    = String(notes || "").trim();
  payMethod = String(payMethod || "").trim();
  const dateFormatted = date ? new Date(date).toLocaleString('ar-SA') : new Date().toLocaleString('ar-SA');
  const companyName = (state.settings && state.settings.name) ? state.settings.name : 'الشركة';
  const taxNumber   = (state.settings && state.settings.taxNumber) ? state.settings.taxNumber : '';
  const currency    = (state.settings && state.settings.currency) ? state.settings.currency : 'SAR';
  const unit  = Number(unitPrice).toFixed(2);
  const total = Number(totalPrice).toFixed(2);
  const qtyNum = Number(qty);

  const payLabel = {'Cash':'كاش 💵','Card':'مدى/شبكة 💳','آجل':'آجل 🧾','Transfer':'تحويل 🏦'};
  const payColor = {'Cash':'#dcfce7','Card':'#dbeafe','آجل':'#fef9c3','Transfer':'#f3e8ff'};
  const payText  = {'Cash':'#166534','Card':'#1e40af','آجل':'#854d0e','Transfer':'#6b21a8'};

  const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<title>أمر شراء - ${id}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Tajawal:wght@400;600;700;900&display=swap');
  *{margin:0;padding:0;box-sizing:border-box;}
  body{font-family:'Tajawal',sans-serif;background:#fff;color:#1e293b;padding:30px;}
  .wrap{max-width:700px;margin:0 auto;}
  .header{background:linear-gradient(135deg,#0f172a 0%,#1e3a8a 100%);color:#fff;border-radius:18px;padding:28px 30px;margin-bottom:24px;display:flex;align-items:center;justify-content:space-between;}
  .header-left h1{font-size:26px;font-weight:900;}
  .header-left .sub{font-size:13px;opacity:.75;margin-top:3px;}
  .header-right .doc-title{font-size:18px;font-weight:700;background:rgba(255,255,255,.15);padding:8px 20px;border-radius:25px;}
  .header-right .doc-id{font-size:12px;opacity:.7;margin-top:5px;text-align:center;}
  .info-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px;}
  .info-card{background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:14px 16px;}
  .info-card .lbl{font-size:11px;color:#64748b;font-weight:600;margin-bottom:4px;}
  .info-card .val{font-size:15px;font-weight:700;color:#0f172a;}
  .sec-title{font-weight:800;font-size:15px;color:#0f172a;margin:18px 0 8px;padding-bottom:6px;border-bottom:2px solid #e2e8f0;}
  table{width:100%;border-collapse:collapse;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;}
  th{background:#f1f5f9;padding:11px 14px;font-size:13px;color:#475569;font-weight:700;text-align:center;}
  td{padding:13px 14px;text-align:center;font-size:14px;border-bottom:1px solid #f1f5f9;}
  tr:last-child td{border-bottom:none;}
  .total-banner{margin-top:18px;background:linear-gradient(135deg,#0d47a1,#1e40af);color:#fff;border-radius:14px;padding:18px 24px;display:flex;justify-content:space-between;align-items:center;}
  .total-banner .lbl{font-size:14px;opacity:.85;}
  .total-banner .val{font-size:30px;font-weight:900;}
  .pay-badge{display:inline-block;padding:9px 20px;border-radius:25px;font-weight:800;font-size:15px;}
  .notes-box{margin-top:14px;padding:14px 16px;background:#fefce8;border:1px solid #fef08a;border-radius:12px;font-size:13px;color:#78716c;}
  .footer{margin-top:28px;text-align:center;padding-top:18px;border-top:2px dashed #e2e8f0;}
  .sig-row{display:flex;justify-content:space-around;margin-top:10px;}
  .sig-line .line{width:180px;border-bottom:1px solid #94a3b8;margin:0 auto;padding-top:45px;}
  .sig-line .caption{font-size:12px;color:#64748b;margin-top:5px;}
  .footer-note{margin-top:12px;font-size:11px;color:#94a3b8;}
  @media print{
    body{padding:10px;}
    .header,.total-banner{-webkit-print-color-adjust:exact;print-color-adjust:exact;}
    .pay-badge{-webkit-print-color-adjust:exact;print-color-adjust:exact;}
  }
</style>
</head>
<body onload="window.print()">
<div class="wrap">
  <div class="header">
    <div class="header-left">
      <h1>${companyName}</h1>
      <div class="sub">الرقم الضريبي: ${taxNumber}</div>
    </div>
    <div class="header-right">
      <div class="doc-title">📦 أمر شراء</div>
      <div class="doc-id">${id}</div>
    </div>
  </div>

  <div class="info-grid">
    <div class="info-card"><div class="lbl">🏭 المورد</div><div class="val">${supplier}</div></div>
    <div class="info-card"><div class="lbl">📅 التاريخ</div><div class="val">${dateFormatted}</div></div>
    <div class="info-card"><div class="lbl">👤 أُنجز بواسطة</div><div class="val">${username}</div></div>
    <div class="info-card">
      <div class="lbl">💳 طريقة الدفع</div>
      <div class="val">
        <span class="pay-badge" style="background:${payColor[payMethod]||'#f1f5f9'};color:${payText[payMethod]||'#374151'};">
          ${payLabel[payMethod] || payMethod}
        </span>
      </div>
    </div>
  </div>

  <div class="sec-title">📋 تفاصيل الصنف</div>
  <table>
    <thead><tr><th>الصنف / المادة</th><th>الكمية</th><th>سعر الوحدة (${currency})</th><th>الإجمالي (${currency})</th></tr></thead>
    <tbody>
      <tr style="background:#f8fafc;">
        <td style="font-weight:700;font-size:15px;text-align:right;padding-right:16px;">${itemName}</td>
        <td style="font-weight:700;">${qtyNum}</td>
        <td>${unit}</td>
        <td style="font-weight:900;color:#0d47a1;font-size:16px;">${total}</td>
      </tr>
    </tbody>
  </table>

  <div class="total-banner">
    <div class="lbl">💰 إجمالي قيمة الشراء</div>
    <div class="val">${total} ${currency}</div>
  </div>

  ${notes ? `<div class="notes-box"><strong>📝 ملاحظات:</strong> ${notes}</div>` : ''}

  <div class="footer">
    <div class="sig-row">
      <div class="sig-line">
        <div class="line"></div>
        <div class="caption">توقيع المستلم</div>
        <div class="caption" style="margin-top:5px; color:#1e293b; font-weight:700;">الاسم: ${username || '__________________'}</div>
      </div>
      <div class="sig-line"><div class="line"></div><div class="caption">توقيع المورد</div></div>
      <div class="sig-line"><div class="line"></div><div class="caption">توقيع المدير</div></div>
    </div>
    <div class="footer-note">وثيقة مُولَّدة تلقائياً من نظام ${companyName} POS | ${new Date().toLocaleString('ar-SA')}</div>
  </div>
</div>
</body></html>`;

  const w = window.open('', '_blank', 'width=820,height=750');
  if (w) { w.document.open(); w.document.write(html); w.document.close(); }
  else showToast("يرجى السماح بالنوافذ المنبثقة في المتصفح", true);
}
// =========================================
// 12. Shift Management (POS & Admin)
// =========================================
let currentShiftActuals = { cash:0, card:0, kita:0 };
let currentShiftExpected = { cash:0, card:0, kita:0 };
let shiftDiffData = { cash:0, card:0, kita:0, totalDiff:0 };
let currentShiftStartStr = "";

function shiftOpen() {
  if (state.activeShiftId) return showToast("هناك وردية مفتوحة بالفعل", true);
  if (!confirm("هل أنت متأكد من فتح وردية بيع جديدة للموظف: " + state.user + "؟")) return;

  loader(true);
  // Capture device info
  var ua = navigator.userAgent || '';
  var deviceName = '';
  if (/iPhone/.test(ua)) deviceName = 'iPhone';
  else if (/iPad/.test(ua)) deviceName = 'iPad';
  else if (/Android/.test(ua)) { var m = ua.match(/Android[\s\S]*?;\s*([^;)]+)/); deviceName = m ? m[1].trim() : 'Android'; }
  else if (/Windows/.test(ua)) deviceName = 'Windows PC';
  else if (/Mac/.test(ua)) deviceName = 'Mac';
  else deviceName = 'Desktop';
  var extraData = { deviceInfo: deviceName + ' — ' + navigator.platform };

  function _doOpen(data) {
    api.withFailureHandler(function(err) {
      loader(false); showToast(err.message, true);
    }).withSuccessHandler(function(res) {
      loader(false);
      if(res.success) {
        state.activeShiftId = res.shiftId;
        updateShiftUI();
        showToast("تم بدء الوردية بنجاح!");
      } else { showToast(res.error, true); }
    }).openShift(state.user, data);
  }

  // Capture geolocation
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(function(pos) {
      extraData.geoLat = pos.coords.latitude;
      extraData.geoLng = pos.coords.longitude;
      fetch('https://nominatim.openstreetmap.org/reverse?lat=' + pos.coords.latitude + '&lon=' + pos.coords.longitude + '&format=json&accept-language=ar')
        .then(function(r) { return r.json(); })
        .then(function(d) { extraData.geoAddress = d.display_name || ''; })
        .catch(function() {})
        .finally(function() { _doOpen(extraData); });
    }, function() { _doOpen(extraData); }, { timeout: 5000 });
  } else { _doOpen(extraData); }
}

function shiftCloseStart() {
  if (!state.activeShiftId) return showToast("ليس لديك وردية نشطة حالياً لإغلاقها", true);
  q("#scCash").value = "0"; q("#scCard").value = "0"; q("#scKita").value = "0";
  openModal("#modalShiftClose");
}

function shiftConfirmClose() {
  var cash = Number(q("#scCash").value)||0;
  var card = Number(q("#scCard").value)||0;
  var kita = Number(q("#scKita").value)||0;

  loader(true);
  api.withFailureHandler(function(err){ loader(false); showToast(err.message, true); })
  .withSuccessHandler(function(d) {
    loader(false);
    if (d.error) return showToast(d.error, true);
    var thCash=Number(d.theoreticalCash)||0, thCard=Number(d.theoreticalCard)||0, thKita=Number(d.theoreticalKita)||0;
    var totalExpected = thCash+thCard+thKita;
    var dCash=cash-thCash, dCard=card-thCard, dKita=kita-thKita;
    var totalDiff = (cash+card+kita)-totalExpected;

    // Block #1: zero amounts entered while there are sales
    if (totalExpected > 0 && cash === 0 && card === 0 && kita === 0) {
      return showVarianceBlock({
        thCash: thCash, thCard: thCard, thKita: thKita, cash: 0, card: 0, kita: 0,
        dCash: -thCash, dCard: -thCard, dKita: -thKita, totalDiff: -totalExpected,
        msg: 'لم تُدخل أي مبلغ! المبيعات المتوقعة في النظام هي ' + totalExpected.toFixed(2) + ' SAR. أدخل المبالغ الفعلية في الدرج قبل الإغلاق.'
      });
    }

    // Block #2: variance not zero — REQUIRE review of receipts first, no force-close
    if (Math.abs(totalDiff) > 0.01) {
      return showVarianceBlock({
        thCash: thCash, thCard: thCard, thKita: thKita, cash: cash, card: card, kita: kita,
        dCash: dCash, dCard: dCard, dKita: dKita, totalDiff: totalDiff,
        msg: 'يوجد فرق بين مبالغ الدرج والمبيعات المسجلة. يجب أن يكون الفرق صفراً لإغلاق الوردية. يُرجى مراجعة الفواتير وتصحيح المبالغ ثم المحاولة مجدداً.'
      });
    }

    // Variance is zero — confirm + close via glass modal
    glassConfirm('تأكيد الإغلاق', 'الفرق متطابق تماماً (0.00). متابعة لإغلاق الوردية؟', { okText: 'إغلاق الوردية', danger: true }).then(function(ok) {
      if (!ok) return;
      loader(true);
      api.withFailureHandler(function(err){ loader(false); showToast(err.message, true); })
      .withSuccessHandler(function(res) {
        loader(false);
        if(res.success) {
          var closedShiftId = state.activeShiftId;
          state.activeShiftId = "";
          localStorage.removeItem("pos_active_shift_id");
          updateShiftUI();
          closeModal("#modalShiftClose");
          showToast('تم إغلاق الوردية بنجاح!');
          // Show the glass shift report with WhatsApp share
          showShiftReportNew(closedShiftId, { thCash: thCash, thCard: thCard, thKita: thKita, cash: cash, card: card, kita: kita, orders: Number(d.orderCount) || 0 });
        } else {
          showToast(res.error, true);
        }
      }).endShiftWithActuals(state.activeShiftId, state.user, cash, card, kita);
    });
  }).getShiftDataForClosing(state.activeShiftId);
}

// Glass variance block — refuses to close until reconciled
function showVarianceBlock(d) {
  var fmt = function(v) { return Number(v).toFixed(2); };
  var sign = function(v) { return v > 0 ? '+' + fmt(v) : fmt(v); };
  var dCls = function(v) { return v === 0 ? 'diff-zero' : (v > 0 ? 'diff-pos' : 'diff-neg'); };

  var html = '<p class="glass-modal-message">' + d.msg + '</p>' +
    '<table class="variance-table">' +
      '<thead><tr><th>الوسيلة</th><th>المتوقع</th><th>الفعلي</th><th>الفرق</th></tr></thead>' +
      '<tbody>' +
        '<tr><td>كاش</td><td>' + fmt(d.thCash) + '</td><td>' + fmt(d.cash) + '</td><td class="' + dCls(d.dCash) + '">' + sign(d.dCash) + '</td></tr>' +
        '<tr><td>مدى</td><td>' + fmt(d.thCard) + '</td><td>' + fmt(d.card) + '</td><td class="' + dCls(d.dCard) + '">' + sign(d.dCard) + '</td></tr>' +
        '<tr><td>كيتا</td><td>' + fmt(d.thKita) + '</td><td>' + fmt(d.kita) + '</td><td class="' + dCls(d.dKita) + '">' + sign(d.dKita) + '</td></tr>' +
        '<tr class="total-row"><td>الإجمالي</td><td>' + fmt(d.thCash + d.thCard + d.thKita) + '</td><td>' + fmt(d.cash + d.card + d.kita) + '</td><td class="' + dCls(d.totalDiff) + '">' + sign(d.totalDiff) + '</td></tr>' +
      '</tbody>' +
    '</table>' +
    '<p style="font-size:12px;color:#7f1d1d;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:10px;margin-top:8px;">⚠️ لا يمكن إغلاق الوردية حتى يكون الفرق صفراً. اضغط رجوع وراجع الفواتير في السجل.</p>';
  q('#varianceBody').innerHTML = html;
  openGlassModal('#modalShiftVariance');
}

// Glass shift report (after a successful close) with WhatsApp share
function showShiftReportNew(shiftId, d) {
  var fmt = function(v) { return Number(v).toFixed(2); };
  var totalActual = d.cash + d.card + d.kita;
  var company = (state.settings && state.settings.name) || 'Moroccan Taste';
  var now = new Date();
  var dateStr = now.toLocaleString('en-GB');

  state._lastShiftReport = {
    shiftId: shiftId,
    cashier: state.user,
    cashierName: (state.currentUser && state.currentUser.displayName) || state.user,
    company: company,
    date: dateStr,
    orders: d.orders,
    cash: d.cash, card: d.card, kita: d.kita,
    totalActual: totalActual
  };

  var logoTag = (state.settings && state.settings.logo)
    ? '<div style="text-align:center;margin-bottom:8px;"><img src="' + state.settings.logo + '" style="max-width:70px;max-height:70px;border-radius:10px;"></div>'
    : '';

  var html = logoTag +
    '<div style="text-align:center;margin-bottom:14px;">' +
      '<div style="font-size:18px;font-weight:900;color:var(--primary);">' + company + '</div>' +
      '<div style="font-size:12px;color:var(--text-light);">تقرير إغلاق الوردية</div>' +
    '</div>' +
    '<div style="background:rgba(255,255,255,0.7);border:1px solid rgba(226,232,240,0.6);border-radius:12px;padding:12px 14px;margin-bottom:14px;font-size:13px;">' +
      '<div style="display:flex;justify-content:space-between;margin-bottom:6px;"><span style="color:var(--text-light);">رقم الوردية:</span><span style="font-weight:800;font-family:monospace;">' + shiftId + '</span></div>' +
      '<div style="display:flex;justify-content:space-between;margin-bottom:6px;"><span style="color:var(--text-light);">الكاشير:</span><span style="font-weight:800;">' + state._lastShiftReport.cashierName + '</span></div>' +
      '<div style="display:flex;justify-content:space-between;"><span style="color:var(--text-light);">تاريخ الإغلاق:</span><span style="font-weight:700;">' + dateStr + '</span></div>' +
    '</div>' +
    '<div class="shift-report-grid">' +
      '<div class="shift-stat-card"><div class="label">عدد الطلبات</div><div class="value">' + d.orders + '</div></div>' +
      '<div class="shift-stat-card total"><div class="label">إجمالي المبيعات</div><div class="value">' + fmt(totalActual) + '</div></div>' +
      '<div class="shift-stat-card cash"><div class="label">كاش</div><div class="value">' + fmt(d.cash) + '</div></div>' +
      '<div class="shift-stat-card card"><div class="label">مدى</div><div class="value">' + fmt(d.card) + '</div></div>' +
      '<div class="shift-stat-card kita" style="grid-column:1/-1;"><div class="label">كيتا</div><div class="value">' + fmt(d.kita) + '</div></div>' +
    '</div>' +
    '<div style="text-align:center;padding:14px;border-radius:12px;background:#f0fdf4;border:1.5px solid #86efac;color:#166534;font-weight:900;font-size:15px;">' +
      '<i class="fas fa-check-circle"></i> الفرق متطابق — البيانات سليمة' +
    '</div>';
  q('#shiftReportBody').innerHTML = html;
  openGlassModal('#modalShiftReport');
}

// Build a plain-text report and open WhatsApp with it pre-filled
function shareShiftReportWhatsApp() {
  var r = state._lastShiftReport;
  if (!r) return;
  var lines = [
    '🧾 *تقرير إغلاق الوردية*',
    '',
    '🏪 ' + r.company,
    '📅 ' + r.date,
    '🆔 ' + r.shiftId,
    '👤 ' + r.cashierName + ' (' + r.cashier + ')',
    '',
    '🧾 عدد الطلبات: ' + r.orders,
    '💰 إجمالي المبيعات: ' + r.totalActual.toFixed(2) + ' SAR',
    '',
    '*تفصيل الدفع:*',
    '• كاش: ' + r.cash.toFixed(2) + ' SAR',
    '• مدى: ' + r.card.toFixed(2) + ' SAR',
    '• كيتا: ' + r.kita.toFixed(2) + ' SAR',
    '',
    '✅ الفرق: 0.00 — متطابق'
  ];
  var text = encodeURIComponent(lines.join('\n'));
  window.open('https://wa.me/?text=' + text, '_blank');
}

// Print the new glass shift report in a clean window
function printShiftReportNew() {
  var r = state._lastShiftReport;
  if (!r) return;
  var w = window.open('', '_blank', 'width=420,height=720');
  if (!w) return;
  var fmt = function(v) { return Number(v).toFixed(2); };
  w.document.write('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Shift Report</title>' +
    '<style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:Arial,sans-serif;padding:18px;color:#1e293b;max-width:380px;margin:0 auto;font-size:13px;}' +
    '.h{text-align:center;border-bottom:2px solid #1e293b;padding-bottom:12px;margin-bottom:14px;}h1{font-size:18px;}h2{font-size:13px;color:#64748b;font-weight:400;}' +
    '.row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px dashed #cbd5e1;}.row:last-child{border:none;}' +
    'table{width:100%;border-collapse:collapse;margin:10px 0;}th,td{padding:8px;text-align:left;border-bottom:1px solid #e2e8f0;font-size:12px;}th{background:#f1f5f9;font-weight:700;}' +
    '.t{background:#ecfeff;font-weight:900;}@media print{body{padding:10px;}}</style></head><body>' +
    ((state.settings && state.settings.logo) ? '<div style="text-align:center;margin-bottom:8px;"><img src="' + state.settings.logo + '" style="max-width:90px;"></div>' : '') +
    '<div class="h"><h1>' + r.company + '</h1><h2>تقرير إغلاق الوردية</h2></div>' +
    '<div class="row"><span>الكاشير</span><span><b>' + r.cashierName + '</b></span></div>' +
    '<div class="row"><span>المعرف</span><span>' + r.cashier + '</span></div>' +
    '<div class="row"><span>رقم الوردية</span><span><b>' + r.shiftId + '</b></span></div>' +
    '<div class="row"><span>تاريخ الإغلاق</span><span>' + r.date + '</span></div>' +
    '<div class="row"><span>عدد الطلبات</span><span><b>' + r.orders + '</b></span></div>' +
    '<table><tr><th>الوسيلة</th><th style="text-align:right;">المبلغ (SAR)</th></tr>' +
      '<tr><td>كاش</td><td style="text-align:right;">' + fmt(r.cash) + '</td></tr>' +
      '<tr><td>مدى</td><td style="text-align:right;">' + fmt(r.card) + '</td></tr>' +
      '<tr><td>كيتا</td><td style="text-align:right;">' + fmt(r.kita) + '</td></tr>' +
      '<tr class="t"><td>الإجمالي</td><td style="text-align:right;">' + fmt(r.totalActual) + '</td></tr>' +
    '</table>' +
    '<div style="text-align:center;padding:14px;background:#f0fdf4;border:1px solid #86efac;border-radius:8px;color:#166534;font-weight:900;">✅ الفرق: 0.00 — متطابق</div>' +
    '</body></html>');
  w.document.close();
  setTimeout(function() { w.print(); }, 400);
}

function printShiftReport(res, actualCash, actualCard, actualKita) {
  var d = res.shiftData || {};
  var companyName = (state.settings && state.settings.name) || 'Moroccan Taste';
  var now = new Date();
  var cashA = Number(actualCash)||0, cardA = Number(actualCard)||0, kitaA = Number(actualKita)||0;
  var cashT = Number(d.TheoreticalCash||d.theoreticalCash)||0;
  var cardT = Number(d.TheoreticalCard||d.theoreticalCard)||0;
  var kitaT = Number(d.TheoreticalKita||d.theoreticalKita)||0;
  var totalT = cashT+cardT+kitaT, totalA = cashA+cardA+kitaA;
  var diffCash=cashA-cashT, diffCard=cardA-cardT, diffKita=kitaA-kitaT, diffTotal=totalA-totalT;
  var dc=function(v){return v>=0?'#16a34a':'#ef4444';};
  var fs=function(v){return (v>=0?'+':'')+Number(v).toFixed(2);};
  var f=function(v){return Number(v).toFixed(2);};
  var orders = Number(d.OrderCount||d.orderCount)||0;
  var user = state.user||'';
  var shiftId = d.ShiftID||d.shiftId||res.shiftId||'';

  var w = window.open('','_blank','width=420,height=700');
  if(!w) return;
  w.document.write('<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width"><title>Shift Report</title>'+
  '<style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:Arial,sans-serif;padding:20px;color:#1e293b;max-width:400px;margin:0 auto;font-size:13px;}'+
  '.header{text-align:center;border-bottom:2px solid #1e293b;padding-bottom:12px;margin-bottom:15px;}'+
  '.header h1{font-size:18px;margin-bottom:4px;}.header h2{font-size:14px;color:#64748b;font-weight:400;}'+
  '.meta{display:flex;justify-content:space-between;font-size:12px;color:#64748b;margin-bottom:15px;flex-wrap:wrap;gap:4px;}'+
  'table{width:100%;border-collapse:collapse;margin:10px 0;}th,td{padding:8px 6px;text-align:left;border-bottom:1px solid #e2e8f0;}'+
  'th{background:#f1f5f9;font-weight:700;font-size:12px;color:#475569;}'+
  '.section-title{font-size:14px;font-weight:800;margin:15px 0 8px;padding:6px 10px;background:#f8fafc;border-radius:6px;border-left:3px solid #3b82f6;}'+
  '.diff-pos{color:#16a34a;font-weight:700;}.diff-neg{color:#ef4444;font-weight:700;}.diff-zero{color:#64748b;}'+
  '.grand{font-size:15px;font-weight:900;background:#eff6ff;}.footer{text-align:center;margin-top:20px;font-size:11px;color:#94a3b8;border-top:1px dashed #cbd5e1;padding-top:10px;}'+
  '@media print{body{padding:10px;}}</style></head><body>'+

  ((state.settings && state.settings.logo) ? '<div style="text-align:center;margin-bottom:8px;"><img src="'+state.settings.logo+'" style="max-width:90px;max-height:90px;"></div>' : '')+
  '<div class="header"><h1>'+companyName+'</h1><h2>Shift Close Report / تقرير إغلاق الوردية</h2></div>'+

  '<div class="meta"><span>Cashier: <b>'+user+'</b></span><span>Shift: <b>'+shiftId+'</b></span><span>Date: <b>'+now.toLocaleDateString('en-US')+'</b></span><span>Time: <b>'+now.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'})+'</b></span></div>'+

  '<div class="section-title">Sales Summary / ملخص المبيعات</div>'+
  '<table><tr><td>Total Orders / عدد الطلبات</td><td style="text-align:right;font-weight:800;">'+orders+'</td></tr>'+
  '<tr><td>Total Sales / إجمالي المبيعات</td><td style="text-align:right;font-weight:800;">'+f(totalT)+' SAR</td></tr></table>'+

  '<div class="section-title">Payment Breakdown / تفصيل طرق الدفع</div>'+
  '<table><thead><tr><th>Method</th><th style="text-align:right;">System</th><th style="text-align:right;">Actual</th><th style="text-align:right;">Diff</th></tr></thead><tbody>'+
  '<tr><td>Cash / كاش</td><td style="text-align:right;">'+f(cashT)+'</td><td style="text-align:right;">'+f(cashA)+'</td><td style="text-align:right;color:'+dc(diffCash)+'">'+fs(diffCash)+'</td></tr>'+
  '<tr><td>Card / مدى</td><td style="text-align:right;">'+f(cardT)+'</td><td style="text-align:right;">'+f(cardA)+'</td><td style="text-align:right;color:'+dc(diffCard)+'">'+fs(diffCard)+'</td></tr>'+
  '<tr><td>Kita / كيتا</td><td style="text-align:right;">'+f(kitaT)+'</td><td style="text-align:right;">'+f(kitaA)+'</td><td style="text-align:right;color:'+dc(diffKita)+'">'+fs(diffKita)+'</td></tr>'+
  '<tr class="grand"><td><b>TOTAL</b></td><td style="text-align:right;"><b>'+f(totalT)+'</b></td><td style="text-align:right;"><b>'+f(totalA)+'</b></td><td style="text-align:right;color:'+dc(diffTotal)+'"><b>'+fs(diffTotal)+'</b></td></tr>'+
  '</tbody></table>'+

  '<div class="section-title">Variance Status / حالة الفروقات</div>'+
  '<div style="text-align:center;padding:15px;border-radius:10px;margin:10px 0;'+
  (Math.abs(diffTotal)<0.01 ? 'background:#f0fdf4;border:2px solid #86efac;color:#166534;' : (diffTotal>0 ? 'background:#fefce8;border:2px solid #fde047;color:#854d0e;' : 'background:#fef2f2;border:2px solid #fca5a5;color:#991b1b;'))+
  'font-size:16px;font-weight:900;">'+
  (Math.abs(diffTotal)<0.01 ? 'BALANCED / متطابق' : (diffTotal>0 ? 'SURPLUS +'+f(diffTotal)+' / فائض' : 'SHORTAGE '+f(diffTotal)+' / عجز'))+
  '</div>'+

  '<div class="footer">'+companyName+' POS System<br>Report generated: '+now.toLocaleString('en-US')+'<br>Signature: _________________</div>'+
  '</body></html>');
  w.document.close();
  setTimeout(function(){w.print();},500);
}

var _allShifts = [];
function loadDashShifts() {
  loader(true);
  api.withSuccessHandler(function(res) {
    loader(false);
    if (!res || res.error) return showToast((res&&res.error)||"Failed to load shifts", true);
    _allShifts = (res||[]).sort(function(a,b){ return new Date(b.startTime||0)-new Date(a.startTime||0); });
    // Populate cashier filter
    var cashiers = []; _allShifts.forEach(function(s){ if(s.username && cashiers.indexOf(s.username)<0) cashiers.push(s.username); });
    var sel = q("#shFilterCashier");
    if (sel) sel.innerHTML = '<option value="">All Cashiers</option>' + cashiers.map(function(c){return '<option value="'+c+'">'+c+'</option>';}).join('');
    filterShifts();
  }).getAllShifts();
}
function filterShifts() {
  var dateF = q("#shFilterDate")?.value||'';
  var cashierF = q("#shFilterCashier")?.value||'';
  var filtered = _allShifts.filter(function(s){
    var matchDate = !dateF || (s.startTime && s.startTime.toString().indexOf(dateF)>=0);
    var matchCashier = !cashierF || s.username===cashierF;
    return matchDate && matchCashier;
  });
  renderShiftsTable(filtered);
}
function fmtDT(v){ if(!v) return '—'; try{var d=new Date(v);return d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})+' '+d.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'});}catch(e){return String(v);} }
function renderShiftsTable(list) {
  var tb = q("#tbShifts");
  if (!list||!list.length) { tb.innerHTML='<tr><td colspan="11" style="text-align:center;padding:20px;color:#94a3b8;">No shifts found</td></tr>'; updateShiftTotals([]); return; }
  tb.innerHTML = list.map(function(s){
    var thCash=Number(s.theoreticalCash)||0, thCard=Number(s.theoreticalCard)||0, thKita=Number(s.theoreticalKita)||0;
    var aCash=Number(s.actualCash)||0, aCard=Number(s.actualCard)||0, aKita=Number(s.actualKita)||0;
    var tTheo=thCash+thCard+thKita, tAct=aCash+aCard+aKita, tDiff=tAct-tTheo;
    var dCash=aCash-thCash, dCard=aCard-thCard, dKita=aKita-thKita;
    var dc=function(v){return v===0?'#64748b':(v>0?'#16a34a':'#ef4444');};
    var fs=function(v){return (v>0?'+':'')+formatVal(v);};
    var diffBadge = tDiff===0?'<span class="badge green">متطابق</span>':(tDiff>0?'<span class="badge" style="background:#dcfce7;color:#166534;">+'+formatVal(tDiff)+'</span>':'<span class="badge red">'+formatVal(tDiff)+'</span>');
    var empName = s.displayName || (state.userDisplayMap && state.userDisplayMap[s.username]) || s.username;
    var geoHtml = s.geoAddress ? '<div style="font-size:10px;color:#64748b;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="'+s.geoAddress+'"><i class="fas fa-map-marker-alt" style="color:#ef4444;margin-left:3px;"></i>'+s.geoAddress+'</div>' : '<span style="font-size:10px;color:#cbd5e1;">—</span>';
    var devHtml = s.deviceInfo ? '<span style="font-size:10px;color:#64748b;" title="'+s.deviceInfo+'"><i class="fas fa-mobile-alt" style="color:#3b82f6;margin-left:3px;"></i>'+s.deviceInfo+'</span>' : '';
    return '<tr>'+
      '<td style="font-weight:700;">'+empName+'<div style="font-size:10px;color:#94a3b8;">'+s.username+'</div></td>'+
      '<td style="font-size:12px;">'+fmtDT(s.startTime)+'</td>'+
      '<td style="font-size:12px;">'+(s.endTime?fmtDT(s.endTime):'<span class="badge orange">مفتوحة</span>')+'</td>'+
      '<td>'+geoHtml+'</td>'+
      '<td>'+devHtml+'</td>'+
      '<td style="font-weight:700;">'+formatVal(tTheo)+'</td>'+
      '<td style="font-weight:900;color:var(--primary);">'+formatVal(tAct)+'</td>'+
      '<td>'+diffBadge+'</td>'+
      '<td style="color:'+dc(dCash)+';font-weight:600;font-size:12px;">'+fs(dCash)+'</td>'+
      '<td style="color:'+dc(dCard)+';font-weight:600;font-size:12px;">'+fs(dCard)+'</td>'+
      '<td style="color:'+dc(dKita)+';font-weight:600;font-size:12px;">'+fs(dKita)+'</td>'+
      '<td style="white-space:nowrap;">' +
        '<button class="btn btn-sm btn-primary" onclick=\'reprintShift('+JSON.stringify(s).replace(/'/g,"&#39;")+')\' title="طباعة"><i class="fas fa-print"></i></button> ' +
        '<button class="btn btn-sm btn-danger" onclick="delShiftFn(\''+s.id+'\',\''+(s.username||'').replace(/[\'"]/g,'')+'\')" title="حذف المناوبة"><i class="fas fa-trash"></i></button>' +
      '</td>'+
    '</tr>';
  }).join('');
  updateShiftTotals(list);
}

// ─── Delete a closed shift (admin) ───
window.delShiftFn = function(shiftId, cashier) {
  var proceed = function(mode) {
    // mode: 'unlink' (detach sales then delete) | 'force' (delete even with linked sales)
    var qs = mode === 'force' ? '?force=1' : (mode === 'unlink' ? '?unlinkSales=1' : '');
    var hdr = { 'Authorization':'Bearer '+(localStorage.getItem('pos_token')||'') };
    loader(true);
    fetch('/api/shifts/' + encodeURIComponent(shiftId) + qs, { method:'DELETE', headers: hdr })
      .then(function(r){ return r.json(); })
      .then(function(r){
        loader(false);
        if (r.success) {
          showToast('تم حذف المناوبة' + (r.unlinkedSales ? ' (فُصلت '+r.unlinkedSales+' فاتورة)' : ''));
          loadDashShifts();
        } else if (r.requiresConfirm) {
          // Two-step confirm: ask whether to unlink sales first
          if (window.WoModal && WoModal.confirm) {
            WoModal.confirm({
              icon: 'fa-triangle-exclamation', iconColor: 'warning',
              title: 'المناوبة مرتبطة بـ '+r.linkedSales+' فاتورة',
              message: 'سيتم فصل الفواتير عن المناوبة (لن تُحذف الفواتير) ثم حذف سجل المناوبة فقط. هل تريد المتابعة؟',
              confirmText: 'فصل الفواتير وحذف', cancelText: 'إلغاء', danger: true
            }).then(function(ok){ if (ok) proceed('unlink'); });
          } else {
            if (confirm('المناوبة مرتبطة بـ '+r.linkedSales+' فاتورة. سيتم فصل الفواتير عنها ثم حذف المناوبة. متابعة؟')) proceed('unlink');
          }
        } else {
          showToast(r.error || 'فشل الحذف', true);
        }
      })
      .catch(function(e){ loader(false); showToast((e&&e.message)||'خطأ شبكة', true); });
  };

  if (window.WoModal && WoModal.confirm) {
    WoModal.confirm({
      icon: 'fa-trash', iconColor: 'danger',
      title: 'حذف سجل المناوبة؟',
      message: 'المناوبة: <code>'+shiftId+'</code>' + (cashier ? ' · الموظف: <b>'+cashier+'</b>' : '') + '<br><br>سيتم حذف سجل المناوبة نهائياً. الفواتير المرتبطة (إن وُجدت) سيُطلب منك إجراء إضافي.',
      confirmText: 'حذف المناوبة', cancelText: 'إلغاء', danger: true
    }).then(function(ok){ if (ok) proceed(''); });
  } else {
    if (confirm('حذف سجل المناوبة '+shiftId+'؟')) proceed('');
  }
};
function updateShiftTotals(list) {
  var tExp=0,tAct=0,tDiff=0,count=0;
  list.forEach(function(s){
    var th=(Number(s.theoreticalCash)||0)+(Number(s.theoreticalCard)||0)+(Number(s.theoreticalKita)||0);
    var ta=(Number(s.actualCash)||0)+(Number(s.actualCard)||0)+(Number(s.actualKita)||0);
    tExp+=th; tAct+=ta; tDiff+=(ta-th); count++;
  });
  var el=function(id,v){var e=q('#'+id);if(e)e.textContent=v;};
  el('shTotalCount',count);
  el('shTotalExpected',formatVal(tExp));
  el('shTotalActual',formatVal(tAct));
  el('shTotalDiff',(tDiff>0?'+':'')+formatVal(tDiff));
  var diffEl=q('#shTotalDiff'); if(diffEl) diffEl.style.color=tDiff===0?'#64748b':(tDiff>0?'#16a34a':'#ef4444');
}
function exportShiftsExcel() {
  ensureXlsx().then(_exportShiftsExcelBody).catch(function(e) { showToast(e.message || 'فشل تحميل XLSX', true); });
}
function _exportShiftsExcelBody() {
  if(!_allShifts.length) return showToast('No shifts to export','error');
  var ws=[['Shift ID','Cashier','Start','End','Expected Cash','Expected Card','Expected Kita','Expected Total','Actual Cash','Actual Card','Actual Kita','Actual Total','Cash Diff','Card Diff','Kita Diff','Total Diff']];
  _allShifts.forEach(function(s){
    var thC=Number(s.theoreticalCash)||0,thR=Number(s.theoreticalCard)||0,thK=Number(s.theoreticalKita)||0;
    var aC=Number(s.actualCash)||0,aR=Number(s.actualCard)||0,aK=Number(s.actualKita)||0;
    ws.push([s.id,s.username,fmtDT(s.startTime),fmtDT(s.endTime),thC,thR,thK,thC+thR+thK,aC,aR,aK,aC+aR+aK,aC-thC,aR-thR,aK-thK,(aC+aR+aK)-(thC+thR+thK)]);
  });
  var wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(ws),'Shifts');
  XLSX.writeFile(wb,'Shifts_Report_'+new Date().toISOString().split('T')[0]+'.xlsx');
}

function reprintShift(s) {
  const actTotal = (Number(s.actualCash)||0) + (Number(s.actualCard)||0) + (Number(s.actualKita)||0);
  const theoTotal = (Number(s.theoreticalCash)||0) + (Number(s.theoreticalCard)||0) + (Number(s.theoreticalKita)||0);
  loader(true);
  api.withSuccessHandler(res => {
    loader(false);
    const soldItems = (res && res.soldItems) ? res.soldItems : [];
    printShiftPDF({
      shiftId: s.id,
      actuals: { cash: s.actualCash, card: s.actualCard, kita: s.actualKita },
      expected: { cash: s.theoreticalCash, card: s.theoreticalCard, kita: s.theoreticalKita },
      diff: { totalDiff: actTotal - theoTotal },
      startTime: s.startTime,
      endTime: s.endTime,
      user: s.username,
      soldItems: soldItems
    });
  }).withFailureHandler(err => {
    loader(false);
    printShiftPDF({
      shiftId: s.id,
      actuals: { cash: s.actualCash, card: s.actualCard, kita: s.actualKita },
      expected: { cash: s.theoreticalCash, card: s.theoreticalCard, kita: s.theoreticalKita },
      diff: { totalDiff: actTotal - theoTotal },
      startTime: s.startTime,
      endTime: s.endTime,
      user: s.username,
      soldItems: []
    });
  }).getShiftDataForClosing(s.id);
}

function printShiftPDF(data) {
  const company = (state.settings && state.settings.name) ? state.settings.name : 'Moroccan Taste';
  const taxNum = (state.settings && state.settings.taxNumber) ? state.settings.taxNumber : '';
  const usr = data.user || state.user;
  const sTime = data.startTime ? new Date(data.startTime).toLocaleString('ar-SA') : '—';
  const eTime = data.endTime ? new Date(data.endTime).toLocaleString('ar-SA') : '—';
  const printDate = new Date().toLocaleString('ar-SA');

  const expCash = Number(data.expected.cash)||0;
  const expCard = Number(data.expected.card)||0;
  const expKita = Number(data.expected.kita)||0;
  const actCash = Number(data.actuals.cash)||0;
  const actCard = Number(data.actuals.card)||0;
  const actKita = Number(data.actuals.kita)||0;
  const totalExp = expCash + expCard + expKita;
  const totalAct = actCash + actCard + actKita;
  const difT = data.diff.totalDiff;
  const expT = formatVal(totalExp);
  const actT = formatVal(totalAct);
  const difText = (difT > 0 ? '+' : '') + formatVal(difT);
  const difColorHex = difT === 0 ? '#16a34a' : (difT < 0 ? '#dc2626' : '#d97706');
  const difBg = difT === 0 ? '#dcfce7' : (difT < 0 ? '#fee2e2' : '#fef9c3');
  const difLabel = difT === 0 ? 'متوازن ✓' : (difT < 0 ? 'عجز في الصندوق' : 'زيادة في الصندوق');

  // Build items aggregation
  const aggItems = {};
  (data.soldItems || []).forEach(i => {
    const n = String(i.name || 'غير معروف');
    if (!aggItems[n]) aggItems[n] = { name: n, qty: 0, price: Number(i.price)||0, total: 0 };
    aggItems[n].qty += Number(i.qty)||0;
    aggItems[n].total += Number(i.total)||0;
  });
  const aggArr = Object.values(aggItems).sort((a,b) => b.qty - a.qty);
  const itemsGrandTotal = aggArr.reduce((s,i) => s + i.total, 0);
  const itemsGrandQty = aggArr.reduce((s,i) => s + i.qty, 0);

  const itemsRows = aggArr.length
    ? aggArr.map((it, idx) => `
        <tr class="${idx % 2 === 0 ? 'row-even' : 'row-odd'}">
          <td class="td-name">${it.name}</td>
          <td class="td-center">${it.qty}</td>
          <td class="td-center">${formatVal(it.price)}</td>
          <td class="td-amount">${formatVal(it.total)}</td>
        </tr>`).join('')
    : `<tr><td colspan="4" class="td-empty">لا توجد أصناف مسجلة لهذه الوردية</td></tr>`;

  const diffRow = (label, exp, act) => {
    const d = act - exp;
    const cls = d === 0 ? 'diff-zero' : (d < 0 ? 'diff-neg' : 'diff-pos');
    return `<tr>
      <td class="td-pay-label">${label}</td>
      <td class="td-center">${formatVal(exp)}</td>
      <td class="td-center">${formatVal(act)}</td>
      <td class="td-diff ${cls}">${d > 0 ? '+' : ''}${formatVal(d)}</td>
    </tr>`;
  };

  const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<title>تقرير إقفال وردية — ${data.shiftId}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Tajawal:wght@300;400;500;700;800;900&display=swap');
  @page { size: A4 portrait; margin: 12mm 14mm; }

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: 'Tajawal', sans-serif;
    font-size: 11pt;
    color: #1e293b;
    background: #fff;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  /* ── PAGE HEADER ─────────────────────────────── */
  .page-header {
    background: linear-gradient(135deg, #0f172a 0%, #1e3a5f 60%, #1e40af 100%);
    color: #fff;
    padding: 14mm 12mm 10mm;
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 6mm;
    border-radius: 3mm;
  }
  .ph-company { font-size: 22pt; font-weight: 900; letter-spacing: 0.5px; }
  .ph-subtitle { font-size: 10pt; color: #93c5fd; margin-top: 2mm; }
  .ph-taxnum { font-size: 9pt; color: #64748b; margin-top: 1mm; }
  .ph-right { text-align: left; }
  .ph-title {
    font-size: 13pt; font-weight: 800;
    background: rgba(255,255,255,0.15);
    padding: 2mm 5mm; border-radius: 20px;
    border: 1px solid rgba(255,255,255,0.25);
    margin-bottom: 3mm;
    display: inline-block;
  }
  .ph-id { font-size: 8.5pt; color: #94a3b8; font-family: monospace; }
  .ph-badge {
    display: inline-block; margin-top: 2mm;
    background: #16a34a; color: #fff;
    padding: 1mm 4mm; border-radius: 20px;
    font-size: 9pt; font-weight: 700;
  }

  /* ── INFO ROW ────────────────────────────────── */
  .info-row {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 3mm;
    margin-bottom: 5mm;
  }
  .info-card {
    border: 1px solid #e2e8f0;
    border-radius: 2.5mm;
    padding: 3mm 4mm;
    background: #f8fafc;
  }
  .info-card .lbl { font-size: 8pt; color: #64748b; font-weight: 700; margin-bottom: 1.5mm; }
  .info-card .val { font-size: 10pt; font-weight: 800; color: #0f172a; }

  /* ── KPI STRIP ───────────────────────────────── */
  .kpi-strip {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 3mm;
    margin-bottom: 5mm;
  }
  .kpi-box {
    border-radius: 2.5mm;
    padding: 4mm 5mm;
    text-align: center;
  }
  .kpi-box .kpi-lbl { font-size: 8.5pt; font-weight: 700; margin-bottom: 2mm; }
  .kpi-box .kpi-val { font-size: 18pt; font-weight: 900; direction: ltr; display: block; }
  .kpi-box .kpi-unit { font-size: 8pt; font-weight: 500; margin-top: 1mm; opacity: 0.75; }
  .kpi-blue  { background: #dbeafe; color: #1e40af; }
  .kpi-green { background: #dcfce7; color: #166534; }
  .kpi-diff  { background: ${difBg}; color: ${difColorHex}; }

  /* ── SECTION TITLE ───────────────────────────── */
  .sec-title {
    font-size: 11pt; font-weight: 800; color: #0f172a;
    border-right: 4px solid #2563eb;
    padding-right: 3mm;
    margin: 5mm 0 3mm;
  }

  /* ── TABLES ──────────────────────────────────── */
  table { width: 100%; border-collapse: collapse; font-size: 10pt; }
  thead th {
    background: #0f172a; color: #fff;
    padding: 3mm 4mm;
    text-align: center;
    font-weight: 700; font-size: 9.5pt;
    border: 1px solid #1e293b;
  }
  thead th:first-child { text-align: right; }
  tbody td {
    padding: 2.5mm 4mm;
    border: 1px solid #e2e8f0;
    vertical-align: middle;
  }
  tfoot td {
    background: #1e293b; color: #fff;
    padding: 3mm 4mm;
    font-weight: 900; font-size: 10.5pt;
    border: 1px solid #1e293b;
  }
  .row-even td { background: #fff; }
  .row-odd  td { background: #f8fafc; }
  .td-name   { text-align: right; font-weight: 600; }
  .td-center { text-align: center; }
  .td-amount { text-align: center; font-weight: 700; color: #1e40af; }
  .td-empty  { text-align: center; padding: 6mm; color: #94a3b8; font-style: italic; }
  .td-pay-label { text-align: right; font-weight: 600; padding-right: 5mm; }
  .td-diff   { text-align: center; font-weight: 800; direction: ltr; }
  .diff-zero { color: #166534; background: #dcfce7; }
  .diff-neg  { color: #991b1b; background: #fee2e2; }
  .diff-pos  { color: #854d0e; background: #fef9c3; }
  .total-row td { background: #f1f5f9 !important; font-weight: 900; font-size: 10.5pt; border-top: 2px solid #94a3b8; }
  .total-row .td-amount { color: #16a34a; font-size: 11pt; }

  /* ── RESULT BANNER ───────────────────────────── */
  .result-banner {
    background: ${difBg};
    border: 2px solid ${difColorHex};
    border-radius: 3mm;
    padding: 5mm 8mm;
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin: 5mm 0;
  }
  .rb-left .rb-label { font-size: 10pt; font-weight: 700; color: ${difColorHex}; }
  .rb-left .rb-note  { font-size: 8.5pt; color: #64748b; margin-top: 1.5mm; }
  .rb-amount { font-size: 26pt; font-weight: 900; color: ${difColorHex}; direction: ltr; }
  .rb-unit   { font-size: 11pt; font-weight: 500; color: ${difColorHex}; }

  /* ── SIGNATURES ──────────────────────────────── */
  .sig-row {
    display: flex;
    justify-content: space-between;
    margin-top: 8mm;
    padding-top: 5mm;
    border-top: 1.5px dashed #cbd5e1;
    gap: 5mm;
  }
  .sig-box { flex: 1; text-align: center; }
  .sig-box .sig-lbl { font-size: 9.5pt; font-weight: 700; color: #334155; margin-bottom: 12mm; }
  .sig-box .sig-line { border-top: 1px solid #94a3b8; margin: 0 10%; }
  .sig-box .sig-name-line { font-size: 8.5pt; color: #94a3b8; margin-top: 2mm; }

  /* ── FOOTER ──────────────────────────────────── */
  .page-footer {
    margin-top: 5mm;
    padding-top: 3mm;
    border-top: 1px solid #e2e8f0;
    display: flex;
    justify-content: space-between;
    font-size: 8pt;
    color: #94a3b8;
  }

  @media print {
    body { background: #fff; }
    table { page-break-inside: avoid; }
    .result-banner { page-break-inside: avoid; }
    .sig-row { page-break-inside: avoid; }
  }
</style>
</head>
<body onload="setTimeout(() => window.print(), 600)">

  <!-- PAGE HEADER -->
  <div class="page-header">
    <div class="ph-left">
      <div class="ph-company">${company}</div>
      <div class="ph-subtitle">نظام إدارة نقاط البيع والموارد</div>
      ${taxNum ? `<div class="ph-taxnum">الرقم الضريبي: ${taxNum}</div>` : ''}
    </div>
    <div class="ph-right">
      <div class="ph-title">📋 تقرير إقفال الوردية</div><br>
      <div class="ph-id">${data.shiftId}</div>
      <div class="ph-badge">✔ مغلقة وموثقة</div>
    </div>
  </div>

  <!-- INFO ROW -->
  <div class="info-row">
    <div class="info-card">
      <div class="lbl">الكاشير المسؤول</div>
      <div class="val">${usr}</div>
    </div>
    <div class="info-card">
      <div class="lbl">وقت فتح الوردية</div>
      <div class="val">${sTime}</div>
    </div>
    <div class="info-card">
      <div class="lbl">وقت إغلاق الوردية</div>
      <div class="val">${eTime}</div>
    </div>
    <div class="info-card">
      <div class="lbl">تاريخ الطباعة</div>
      <div class="val">${printDate}</div>
    </div>
  </div>

  <!-- KPI STRIP -->
  <div class="kpi-strip">
    <div class="kpi-box kpi-blue">
      <div class="kpi-lbl">إجمالي مبيعات النظام</div>
      <span class="kpi-val">${expT}</span>
      <div class="kpi-unit">ريال سعودي</div>
    </div>
    <div class="kpi-box kpi-green">
      <div class="kpi-lbl">إجمالي الجرد الفعلي</div>
      <span class="kpi-val">${actT}</span>
      <div class="kpi-unit">ريال سعودي</div>
    </div>
    <div class="kpi-box kpi-diff">
      <div class="kpi-lbl">${difLabel}</div>
      <span class="kpi-val">${difText}</span>
      <div class="kpi-unit">ريال سعودي</div>
    </div>
  </div>

  <!-- PAYMENT RECONCILIATION -->
  <div class="sec-title">مطابقة وسائل الدفع والجرد</div>
  <table>
    <thead>
      <tr>
        <th>وسيلة الدفع</th>
        <th>مبيعات النظام (SAR)</th>
        <th>الجرد الفعلي (SAR)</th>
        <th>الفرق (SAR)</th>
      </tr>
    </thead>
    <tbody>
      ${diffRow('💵 نقدي / كاش', expCash, actCash)}
      ${diffRow('💳 شبكة / مدى', expCard, actCard)}
      ${diffRow('🧾 كيتا / آجل', expKita, actKita)}
    </tbody>
    <tfoot>
      <tr>
        <td style="text-align:right;">الإجمالي الكلي</td>
        <td style="text-align:center;">${formatVal(totalExp)}</td>
        <td style="text-align:center;">${formatVal(totalAct)}</td>
        <td style="text-align:center; color:${difColorHex};">${difText}</td>
      </tr>
    </tfoot>
  </table>

  <!-- ITEMS SOLD -->
  <div class="sec-title">الأصناف المباعة خلال الوردية</div>
  <table>
    <thead>
      <tr>
        <th>المنتج / الصنف</th>
        <th>الكمية المباعة</th>
        <th>سعر الوحدة (SAR)</th>
        <th>الإجمالي (SAR)</th>
      </tr>
    </thead>
    <tbody>${itemsRows}</tbody>
    ${aggArr.length ? `<tfoot>
      <tr>
        <td style="text-align:right;">الإجمالي</td>
        <td style="text-align:center;">${itemsGrandQty}</td>
        <td style="text-align:center;">—</td>
        <td style="text-align:center;">${formatVal(itemsGrandTotal)}</td>
      </tr>
    </tfoot>` : ''}
  </table>

  <!-- RESULT BANNER -->
  <div class="result-banner">
    <div class="rb-left">
      <div class="rb-label">${difLabel} — النتيجة النهائية للصندوق</div>
      <div class="rb-note">يتم ترحيل أي فروقات لعهدة الكاشير وفق سياسة الشركة</div>
    </div>
    <div>
      <span class="rb-amount">${difText}</span>
      <span class="rb-unit"> SAR</span>
    </div>
  </div>

  <!-- SIGNATURES -->
  <div class="sig-row">
    <div class="sig-box">
      <div class="sig-lbl">توقيع مُستلم الوردية</div>
      <div class="sig-line"></div>
      <div class="sig-name-line">الاسم: _______________</div>
    </div>
    <div class="sig-box">
      <div class="sig-lbl">توقيع مُسلِّم الوردية (الكاشير)</div>
      <div class="sig-line"></div>
      <div class="sig-name-line">الاسم: ${usr}</div>
    </div>
    <div class="sig-box">
      <div class="sig-lbl">اعتماد الإدارة</div>
      <div class="sig-line"></div>
      <div class="sig-name-line">الاسم: _______________</div>
    </div>
  </div>

  <!-- FOOTER -->
  <div class="page-footer">
    <span>وثيقة رسمية موثقة آلياً — نظام ${company}</span>
    <span>${data.shiftId} | طُبع: ${printDate}</span>
  </div>

</body>
</html>`;

  const w = window.open('', '_blank', 'width=900,height=1100');
  if (w) { w.document.open(); w.document.write(html); w.document.close(); }
}

// =========================================
// 13. Dynamic Theme Customizer
// =========================================
const THEME_PRESETS = {
  blue:    { primary: '#0f172a', secondary: '#0d47a1', accent: '#3b82f6' },
  dark:    { primary: '#000000', secondary: '#111827', accent: '#10b981' },
  emerald: { primary: '#064e3b', secondary: '#047857', accent: '#10b981' },
  crimson: { primary: '#4c0519', secondary: '#9f1239', accent: '#e11d48' }
};

function toggleThemePanel() {
  const panel = document.getElementById('themePanel');
  if (panel) panel.classList.toggle('open');
}

function applyPresetTheme(presetName) {
  const t = THEME_PRESETS[presetName];
  if (!t) return;
  document.documentElement.style.setProperty('--primary', t.primary);
  document.documentElement.style.setProperty('--secondary', t.secondary);
  document.documentElement.style.setProperty('--accent', t.accent);
  
  // Highlight active card
  document.querySelectorAll('.theme-preset-card').forEach(c => c.classList.remove('active'));
  document.getElementById('preset_'+presetName)?.classList.add('active');
  
  // Update pickers
  if (document.getElementById('themePickPrimary')) document.getElementById('themePickPrimary').value = t.primary;
  if (document.getElementById('themePickSecondary')) document.getElementById('themePickSecondary').value = t.secondary;
  if (document.getElementById('themePickAccent')) document.getElementById('themePickAccent').value = t.accent;

  localStorage.setItem('mt_theme_pref', JSON.stringify(t));
}

function applyCustomTheme() {
  const p = document.getElementById('themePickPrimary').value;
  const s = document.getElementById('themePickSecondary').value;
  const a = document.getElementById('themePickAccent').value;
  const txt = document.getElementById('themePickText') ? document.getElementById('themePickText').value : '';

  document.documentElement.style.setProperty('--primary', p);
  document.documentElement.style.setProperty('--secondary', s);
  document.documentElement.style.setProperty('--accent', a);
  if (txt) document.documentElement.style.setProperty('--text-dark', txt);

  // Remove preset highlights
  document.querySelectorAll('.theme-preset-card').forEach(c => c.classList.remove('active'));

  localStorage.setItem('mt_theme_pref', JSON.stringify({ primary: p, secondary: s, accent: a, textColor: txt }));
}

function resetTheme() {
  applyPresetTheme('blue');
}

function initTheme() {
  try {
    const saved = localStorage.getItem('mt_theme_pref');
    if (saved) {
      const t = JSON.parse(saved);
      document.documentElement.style.setProperty('--primary', t.primary);
      document.documentElement.style.setProperty('--secondary', t.secondary);
      document.documentElement.style.setProperty('--accent', t.accent);
      if (t.textColor) document.documentElement.style.setProperty('--text-dark', t.textColor);

      // Attempt to highlight preset or just set value
      let matched = false;
      for (const [name, colors] of Object.entries(THEME_PRESETS)) {
        if (colors.primary === t.primary && colors.secondary === t.secondary) {
          document.getElementById('preset_'+name)?.classList.add('active');
          matched = true;
          break;
        }
      }
      
      if (document.getElementById('themePickPrimary')) {
        document.getElementById('themePickPrimary').value = t.primary;
        document.getElementById('themePickSecondary').value = t.secondary;
        document.getElementById('themePickAccent').value = t.accent;
      }
    } else {
      resetTheme();
    }
  } catch (e) { console.error('Theme Load Error', e); }
}

// Initialize theme as soon as this script is loaded / parsed
document.addEventListener('DOMContentLoaded', initTheme);
initTheme(); // Also immediately call it to prevent FOUC as much as possible

