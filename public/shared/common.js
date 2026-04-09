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
    login: 'تسجيل الدخول', errLogin: 'خطأ في تسجيل الدخول',
    sales: 'المبيعات', shift: 'الشيفت:', openShift: 'فتح الوردية', closeShift: 'إغلاق الوردية', noShift: 'لا يوجد وردية مفتوحة',
    dash: 'الداشبورد', home: 'الرئيسية', inventory: 'المخزون', users: 'المستخدمين', reports: 'التقارير', settings: 'الإعدادات',
    emptyCart: 'السلة فارغة!', checkout: 'إتمام الطلب', tax: 'الضريبة', total: 'الإجمالي', searchP: 'بحث عن منتج...',
    success: 'تمت العملية بنجاح!', loading: 'جاري المعالجة...',
    cartTitle: 'سلة الطلبات', goBack: 'الرجوع', viewCart: 'مشاهدة السلة',
    cash: 'كاش', card: 'مدى', kita: 'كيتا', split: 'تجزئة',
    subtotal: 'المجموع الفرعي:', discount: 'الخصم:', serviceFee: 'رسوم الخدمة:',
    totalLabel: 'الإجمالي:', checkoutBtn: 'إتمام الدفع والطلب',
    emptyCartDesc: 'اختر منتجات من القائمة لإضافتها',
    qty: 'الكمية', price: 'السعر', remove: 'حذف', addToCart: 'أضف للسلة',
    shiftClose: 'إغلاق الوردية', cashAmount: 'المبلغ النقدي (كاش)', cardAmount: 'مدى / شبكة', kitaAmount: 'كيتا / آجل',
    confirmClose: 'اعتماد الجرد وإغلاق الوردية', cancel: 'إلغاء',
    enterAmounts: 'أدخل المبالغ الفعلية في الدرج:', shiftReport: 'تقرير إغلاق الوردية',
    categories: 'التصنيفات', allItems: 'الكل', outOfStock: 'نفذ', inStock: 'متوفر',
    pos: 'نقطة البيع', dashboard: 'الرئيسية', logout: 'خروج'
  },
  en: {
    login: 'Login', errLogin: 'Login failed',
    sales: 'Sales', shift: 'Shift:', openShift: 'Open Shift', closeShift: 'Close Shift', noShift: 'No open shift',
    dash: 'Dashboard', home: 'Home', inventory: 'Inventory', users: 'Users', reports: 'Reports', settings: 'Settings',
    emptyCart: 'Cart is empty!', checkout: 'Checkout', tax: 'Tax', total: 'Total', searchP: 'Search product...',
    success: 'Operation successful!', loading: 'Processing...',
    cartTitle: 'Order Cart', goBack: 'Back', viewCart: 'View Cart',
    cash: 'Cash', card: 'Card', kita: 'Kita', split: 'Split',
    subtotal: 'Subtotal:', discount: 'Discount:', serviceFee: 'Service Fee:',
    totalLabel: 'Total:', checkoutBtn: 'Complete Payment',
    emptyCartDesc: 'Select products from the menu to add',
    qty: 'Qty', price: 'Price', remove: 'Remove', addToCart: 'Add to Cart',
    shiftClose: 'Close Shift', cashAmount: 'Cash Amount', cardAmount: 'Card / Network', kitaAmount: 'Kita / Credit',
    confirmClose: 'Confirm & Close Shift', cancel: 'Cancel',
    enterAmounts: 'Enter actual drawer amounts:', shiftReport: 'Shift Close Report',
    categories: 'Categories', allItems: 'All', outOfStock: 'Out', inStock: 'In Stock',
    pos: 'POS', dashboard: 'Dashboard', logout: 'Logout'
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
  document.querySelectorAll('[data-i18n]').forEach(function(el) {
    var key = el.getAttribute('data-i18n');
    if (dict[state.lang] && dict[state.lang][key]) el.textContent = dict[state.lang][key];
  });
};
window.toggleLang = function() {
  state.lang = state.lang === 'ar' ? 'en' : 'ar';
  localStorage.setItem('pos_lang', state.lang);
  applyLang();
  translateUI();
  if (typeof window.onLangChange === 'function') window.onLangChange();
  showToast(state.lang === 'ar' ? 'تم التحويل للعربية' : 'Switched to English');
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
      '<div class="glass-modal-title"><span id="gcTitle"><i class="fas fa-question-circle"></i> تأكيد</span></div>' +
      '<div class="glass-modal-body"><p id="gcMessage" class="glass-modal-message"></p></div>' +
      '<div class="glass-modal-actions" id="gcActions">' +
        '<button class="btn btn-light" onclick="closeGlassModal(\'#modalGlassConfirm\', false)">إلغاء</button>' +
        '<button class="btn btn-primary" onclick="closeGlassModal(\'#modalGlassConfirm\', true)">تأكيد</button>' +
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
      '<button class="btn btn-light" onclick="closeGlassModal(\'#modalGlassConfirm\', false)">' + (opts.cancelText || 'إلغاء') + '</button>' +
      '<button class="btn ' + okClass + '" onclick="closeGlassModal(\'#modalGlassConfirm\', true)">' + (opts.okText || 'تأكيد') + '</button>';
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
  if (actions) actions.innerHTML = '<button class="btn btn-primary" onclick="closeGlassModal(\'#modalGlassConfirm\', true)" style="flex:1;">حسناً</button>';
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
