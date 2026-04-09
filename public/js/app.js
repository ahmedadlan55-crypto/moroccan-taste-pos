// =========================================
// 0. Lazy script loader — defer Chart.js / XLSX / QRCode / erp.js until needed
// =========================================
window._loadedScripts = window._loadedScripts || {};
window.loadScript = function(url) {
  if (window._loadedScripts[url] === true) return Promise.resolve();
  if (window._loadedScripts[url] && window._loadedScripts[url].then) return window._loadedScripts[url];
  var p = new Promise(function(resolve, reject) {
    var s = document.createElement('script');
    s.src = url;
    s.async = false; // preserve order if multiple loads happen
    s.onload  = function() { window._loadedScripts[url] = true; resolve(); };
    s.onerror = function() { delete window._loadedScripts[url]; reject(new Error('فشل تحميل ' + url)); };
    document.head.appendChild(s);
  });
  window._loadedScripts[url] = p;
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
  return loadScript('/js/erp.js').then(function() { window._erpJsLoaded = true; });
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
const formatVal = v => Number(v || 0).toFixed(2);
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

  // Insert each top-level child of the container before the marker (or before the first script)
  var insertBefore = marker || document.querySelector('script[src="/js/api-bridge.js"]') || document.querySelector('script[src="/js/app.js"]');
  while (container.firstChild) {
    document.body.insertBefore(container.firstChild, insertBefore);
  }
  // Remove the marker (we keep the position by inserting before it)
  if (marker && marker.parentNode) marker.parentNode.removeChild(marker);
}

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
    categories: "التصنيفات", allItems: "الكل", outOfStock: "نفذ", inStock: "متوفر"
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
    categories: "Categories", allItems: "All", outOfStock: "Out", inStock: "In Stock"
  }
};
const t = k => dict[state.lang][k] || k;

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

    // Cashier session → redirect straight to /pos/ (no need to validate the
    // admin template — the /pos/ page has its own auth gate and will
    // redirect back to / if the token is actually invalid).
    if (savedRole && savedRole !== 'admin') {
      window.location.replace('/pos/');
      return;
    }

    // Admin session → validate the JWT by fetching the protected template.
    // If 200 → token valid → inject + initialize without showing login screen.
    // If 401 → token expired → clear and show the login screen.
    fetchAppTemplate()
      .then(function(html) {
        injectAppTemplate(html);
        try {
          var s = JSON.parse(saved);
          state.user = s.user || '';
          state.role = (s.role || '').toLowerCase();
          if (q("#lUser")) q("#lUser").value = s.user || '';
          if (q("#lPass") && s.pass) q("#lPass").value = s.pass;
          if (q("#lRemember")) q("#lRemember").checked = true;
        } catch(e) {}
        loadCoreData();
      })
      .catch(function(err) {
        // Token expired / invalid — clear and reveal the login screen
        localStorage.removeItem("pos_token");
        loader(false);
      });
    return;
  }

  loader(false);
};

function applyLang() {
  document.body.className = state.lang;
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
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (dict[state.lang][key]) {
      el.textContent = dict[state.lang][key];
    }
  });
}

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

    // Always save session so auto-login works on page reload
    localStorage.setItem("pos_session", JSON.stringify({ user: u, pass: p, role: state.role }));
    localStorage.setItem("pos_last_view", state.role === 'admin' ? 'admin' : 'pos');

    // ─── Cashier (or any non-admin) → redirect straight to /pos/ ───
    // No need to fetch the admin template (127 KB) since the cashier never
    // sees the admin dashboard. The /pos/ page loads only POS assets.
    if (state.role !== 'admin') {
      window.location.replace('/pos/');
      return;
    }

    // ─── Admin → fetch the protected app template, inject it, then init ───
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

  // Cashier role → redirect to the standalone /pos/ page (POS is no longer
  // embedded in this admin template). The /pos/ page has its own auth gate
  // and loads only the POS assets.
  if (state.role !== "admin") {
    localStorage.setItem("pos_last_view", 'pos');
    window.location.replace('/pos/');
    return;
  }

  // Admin role → show the admin dashboard
  localStorage.setItem("pos_last_view", 'admin');
  show("#adminView");
  if (q("#adminUserLabel")) q("#adminUserLabel").innerText = state.user;
  // Restore last admin section or default to home
  var lastSection = localStorage.getItem("pos_last_section") || 'home';
  nav(lastSection);
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
  // Clear saved session and JWT
  localStorage.removeItem("pos_session");
  localStorage.removeItem("pos_token");
  localStorage.removeItem("pos_active_shift_id");

  // Reset app state
  state.user = ""; state.role = ""; state.shift = ""; state.cart = []; state.menu = []; state.categories = [];

  // Re-engage the auth gate so nothing else is visible
  document.body.classList.remove('authenticated');

  // Wipe the injected template DOM (all sections + modals from views/app-content.html)
  if (typeof clearInjectedTemplate === 'function') clearInjectedTemplate();

  // Show the login view (still in the document — never injected)
  show("#loginView");

  // Clear login form
  if (q("#lUser")) q("#lUser").value = "";
  if (q("#lPass")) q("#lPass").value = "";
  if (q("#lRemember")) q("#lRemember").checked = false;

  showToast(state.lang === 'ar' ? 'تم تسجيل الخروج' : 'Logged out');
}

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
  const badge = q("#shiftBadge");
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
  // Render Categories Tabs
  let catHtml = `<div class="cat-pill ${!state.activeCat ? 'active' : ''}" onclick="setPosCat('')">الكل</div>`;
  state.categories.forEach(c => catHtml += `<div class="cat-pill ${state.activeCat === c ? 'active' : ''}" onclick="setPosCat('${c}')">${c}</div>`);
  q("#posCatTabs").innerHTML = catHtml;

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
    const lowStock = i.stock <= i.minStock;
    const safeJson = JSON.stringify(i).replace(/'/g, "&#39;");
    h += `<div class="pos-item ${isSel ? 'selected' : ''}">
      <div class="pos-item-stock ${lowStock ? 'low' : ''}">${i.stock}</div>
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
  q("#posItemsGrid").innerHTML = h;
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
  const payMethod = q("#posPayMethod").value;
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

function openDiscountModal() {
  if (!state.cart.length) return showToast(t("emptyCart"), true);
  loader();
  api.withSuccessHandler(discs => {
    loader(false);
    let h = "";
    if (!discs.length) h = "<p style='text-align:center;'>لا توجد خصومات متاحة</p>";
    discs.forEach(d => {
      const valStr = d.type === "PERCENT" ? `${d.value}%` : `${d.value} ${state.settings.currency}`;
      h += `<div class="card" style="margin-bottom:15px; cursor:pointer;" onclick="applyDiscount('${d.name}', '${d.type}', ${d.value})">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <h4 style="margin:0;">${d.name}</h4><strong style="color:var(--secondary); font-size:18px;">${valStr}</strong>
        </div>
      </div>`;
    });
    q("#discModalList").innerHTML = h;
    openModal("#modalDiscount");
  }).getDiscounts();
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
    case 'sales':      if (typeof loadDashSales === 'function') loadDashSales(); break;
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

function nav(sectionId) {
  localStorage.setItem("pos_last_section", sectionId);
  qs(".nav-item").forEach(el => el.classList.remove("active"));
  var navEl = q('.nav-item[onclick="nav(\''+sectionId+'\')"]');
  if (navEl) navEl.classList.add("active");

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
  
  const titles = { home:"\u0646\u0638\u0631\u0629 \u0639\u0627\u0645\u0629", sales:"\u0633\u062c\u0644 \u0627\u0644\u0645\u0628\u064a\u0639\u0627\u062a", inventory:"\u0627\u0644\u0645\u0646\u064a\u0648 \u0648\u0627\u0644\u0648\u0635\u0641\u0627\u062a", warehouse:"\u0625\u062f\u0627\u0631\u0629 \u0627\u0644\u0645\u0633\u062a\u0648\u062f\u0639", expenses:"\u0625\u062f\u0627\u0631\u0629 \u0627\u0644\u0645\u0635\u0631\u0648\u0641\u0627\u062a", purchases:"\u0625\u062f\u0627\u0631\u0629 \u0627\u0644\u0645\u0634\u062a\u0631\u064a\u0627\u062a", users:"\u0635\u0644\u0627\u062d\u064a\u0627\u062a \u0627\u0644\u0645\u0633\u062a\u062e\u062f\u0645\u064a\u0646", shifts:"\u0633\u062c\u0644 \u0627\u0644\u0645\u0646\u0627\u0648\u0628\u0627\u062a \u0627\u0644\u0645\u063a\u0644\u0642\u0629", reports:"\u0627\u0644\u062a\u0642\u0627\u0631\u064a\u0631 \u0627\u0644\u0645\u062a\u0642\u062f\u0645\u0629", settings:"\u0627\u0644\u0625\u0639\u062f\u0627\u062f\u0627\u062a" };
  const hTitle = q('.admin-header-title');
  if (hTitle) hTitle.innerText = titles[sectionId] || "لوحة التحكم";

  // Data Loading Trigger
  if (sectionId === 'home') loadDashHome();
  if (sectionId === 'sales') loadDashSales();
  if (sectionId === 'inventory') loadDashInv();
  if (sectionId === 'warehouse') loadDashInvItems();
  if (sectionId === 'expenses') loadDashExpenses();
  if (sectionId === 'purchases') loadDashPurchases();
  if (sectionId === 'users') loadDashUsers();
  if (sectionId === 'shifts') loadDashShifts();
  if (sectionId === 'reports') populateReportFilters();
  if (sectionId === 'settings') { loadPayMethodsSettings(); applyDeveloperVisibility(); }
}

function loadDashHome() {
  loader();
  // Lazy-load Chart.js the first time the dashboard is opened
  ensureChartJs().then(_loadDashHomeBody).catch(function(e) {
    loader(false); showToast(e.message || 'فشل تحميل المكتبات', true);
  });
}
function _loadDashHomeBody() {
  // Build the date range: last 7 days through today
  var today = new Date();
  var todayStr = today.toISOString().split('T')[0];
  var sevenAgo = new Date(today); sevenAgo.setDate(sevenAgo.getDate() - 6);
  var sevenStr = sevenAgo.toISOString().split('T')[0];

  // Compute everything from /api/sales — the backend dashboard endpoint
  // returns a simplified shape that doesn't include payment / hourly / top items.
  api.withFailureHandler(function(err) { loader(false); showToast(err.message || 'فشل تحميل الداش بورد', true); })
  .withSuccessHandler(function(sales) {
    loader(false);
    sales = Array.isArray(sales) ? sales : [];

    var todaySales = sales.filter(function(s) {
      return String(s.date || '').indexOf(todayStr) === 0;
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

    // ─── Low stock from menu (use cached state.menu, refreshed elsewhere) ───
    var lowStock = (state.menu || []).filter(function(m) {
      return m.active && (Number(m.stock) || 0) <= (Number(m.minStock) || 0);
    });
    var lsHtml = '';
    if (!lowStock.length) {
      lsHtml = "<div style='text-align:center; padding:30px; color:var(--text-light);'><i class='fas fa-check-circle' style='font-size:40px; color:var(--success); margin-bottom:10px; display:block;'></i>المخزون ممتاز</div>";
    } else {
      lowStock.forEach(function(ls) {
        lsHtml += '<div style="display:flex; justify-content:space-between; align-items:center; padding:12px; background:#fff1f2; border:1px solid #ffe4e6; border-radius:12px; margin-bottom:10px;">'+
          '<span style="font-weight:600; color:#9f1239;">' + (ls.name||'') + '</span>'+
          '<span class="badge red">' + (ls.stock||0) + ' مدخل</span>'+
        '</div>';
      });
    }
    if (q("#dhLowStock")) q("#dhLowStock").innerHTML = lsHtml;

    // ─── Charts: destroy old before redraw ───
    if (state.charts) Object.values(state.charts).forEach(function(c) { if (c) c.destroy(); });
    state.charts = {};

    // 1. Daily Sales (last 7 days, line chart)
    var dailyCtx = q("#dailySalesChartCtx");
    if (dailyCtx && typeof Chart !== 'undefined') {
      var byDay = {};
      for (var i = 6; i >= 0; i--) {
        var d2 = new Date(today); d2.setDate(d2.getDate() - i);
        byDay[d2.toISOString().split('T')[0]] = 0;
      }
      sales.forEach(function(s) {
        var k = String(s.date || '').split('T')[0];
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
  }).getSalesListDetailed({ startDate: sevenStr, endDate: todayStr });
}

// Sales Table
function loadDashSales() {
  loader();
  var start = q("#fsStart").value, end = q("#fsEnd").value;
  // Default: today if no dates set
  if (!start && !end) {
    var today = new Date().toISOString().split('T')[0];
    start = today; end = today;
    if (q("#fsStart")) q("#fsStart").value = today;
    if (q("#fsEnd")) q("#fsEnd").value = today;
  }
  var cashier = q("#fsCashier") ? q("#fsCashier").value : "";
  var payMethod = q("#fsPay") ? q("#fsPay").value : "";
  var params = { startDate: start, endDate: end };
  if (cashier) params.username = cashier;
  if (payMethod) params.paymentMethod = payMethod;

  api.withFailureHandler(err => { loader(false); showToast(err.message || 'خطأ في جلب بيانات المبيعات', true); }).withSuccessHandler(arr => {
    loader(false);
    let totalSales = 0;
    let h = "";
    if (!arr || !arr.length) h = "<tr><td colspan='7' style='text-align:center; padding:30px;'>لا توجد بيانات لهذه الفترة</td></tr>";
    else {
      arr.forEach(s => {
        try {
          totalSales += s.total;
          let payType = String(s.payment || "").toLowerCase();
          // For split payments, use a neutral colour
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
          h += '<tr>'+
            '<td style="font-family:monospace;font-weight:bold;color:var(--primary);font-size:12px;">'+(s.orderId||'')+'</td>'+
            '<td style="font-size:12px;color:#64748b;">'+dateStr+'</td>'+
            '<td style="font-weight:600;">'+userLabel(s.username)+'</td>'+
            '<td>'+itemsHtml+'</td>'+
            '<td><span class="badge '+bClass+'">'+payDisplay+'</span></td>'+
            '<td style="font-weight:900;color:var(--secondary);font-size:15px;">'+formatVal(s.total)+'</td>'+
            '<td><button class="btn btn-sm btn-primary" onclick="printReceipt(\''+s.orderId+'\')"><i class="fas fa-print"></i></button></td>'+
          '</tr>';
        } catch(ex) { console.error("Error rendering row", s, ex); }
      });
    }
    q("#tbSales").innerHTML = h;
    state.salesCache = arr || [];
    if (q("#slTotalSales")) q("#slTotalSales").innerText = formatVal(totalSales);
    if (q("#slTotalCount")) q("#slTotalCount").innerText = arr ? arr.length : 0;
  }).getSalesListDetailed(params);
}

// Inventory Management
function loadDashInv() {
  loader();
  var search = (q("#invSearchQ")?q("#invSearchQ").value:'').toLowerCase();
  // Load menu + recipes + raw items together
  api.withSuccessHandler(function(m) {
    state.menu = m || [];
    api.withSuccessHandler(function(recipes) {
      api.withSuccessHandler(function(raws) {
        loader(false);
        cachedRawItems = raws || [];
        var allRecipes = recipes || [];
        var list = state.menu;
        if (search) list = list.filter(function(i){ return (i.name||'').toLowerCase().includes(search) || (i.category||'').toLowerCase().includes(search); });

        var h = '';
        if (!list.length) { h = '<tr><td colspan="8" style="text-align:center;">لا توجد بيانات</td></tr>'; }
        else {
          list.forEach(function(i) {
            try {
              var stClass = i.stock <= i.minStock ? 'red' : 'green';
              var sellPrice = Number(i.price)||0;
              var netSell = sellPrice / 1.15;

              // Get recipe ingredients for this product
              var ings = allRecipes.filter(function(r){ return String(r.menuId).trim()===String(i.id).trim(); });
              var recipeCost = 0;
              var ingNames = [];
              ings.forEach(function(ing){
                var raw = cachedRawItems.find(function(r){ return String(r.id)===String(ing.invItemId); });
                var cRate = raw ? (Number(raw.convRate)||1) : 1;
                var uCost = raw ? (cRate>1 ? Number(raw.cost)/cRate : Number(raw.cost)) : 0;
                var cost = ing.qtyUsed * uCost;
                recipeCost += cost;
                ingNames.push(ing.invItemName + ' (' + ing.qtyUsed + ')');
              });

              var profit = netSell - recipeCost;
              var margin = netSell > 0 ? (profit/netSell*100) : 0;
              var profitColor = profit >= 0 ? '#16a34a' : '#ef4444';
              var marginColor = margin >= 30 ? '#2563eb' : (margin >= 0 ? '#d97706' : '#ef4444');

              var ingDisplay = ings.length ?
                '<div style="font-size:11px;color:#475569;max-width:200px;">'+ingNames.join(', ')+'</div>'+
                '<div style="font-weight:700;color:#ef4444;font-size:13px;">Cost: '+formatVal(recipeCost)+'</div>'
                : '<span style="color:#94a3b8;font-size:11px;">لا توجد مقادير</span>';

              h += '<tr>'+
                '<td style="font-weight:800;">'+( i.name||'')+'</td>'+
                '<td><span class="badge" style="background:#e2e8f0;color:#475569;">'+(i.category||'')+'</span></td>'+
                '<td style="font-weight:700;">'+formatVal(sellPrice)+'</td>'+
                '<td>'+ingDisplay+'</td>'+
                '<td style="color:'+profitColor+';font-weight:800;">'+formatVal(profit)+'<div style="font-size:10px;color:'+marginColor+';">'+margin.toFixed(0)+'%</div></td>'+
                '<td><span class="badge '+stClass+'" style="font-size:13px;">'+i.stock+'</span></td>'+
                '<td>'+(i.active?'<i class="fas fa-check-circle" style="color:var(--success);"></i>':'<i class="fas fa-times-circle" style="color:var(--danger);"></i>')+'</td>'+
                '<td style="white-space:nowrap;">'+
                  '<button class="btn btn-success" style="padding:5px 8px;" onclick="openProductCard(\''+i.id+'\')" title="كارت"><i class="fas fa-id-card"></i></button> '+
                  '<button class="btn btn-primary" style="padding:5px 8px;" onclick="openRecipeModal(\''+i.id+'\',\''+String(i.name||'').replace(/'/g,"\\'")+'\')" title="مقادير"><i class="fas fa-blender"></i></button> '+
                  '<button class="btn btn-light" style="padding:5px 8px;" onclick="openInvM(\'edit\',\''+i.id+'\')" title="تعديل"><i class="fas fa-edit"></i></button> '+
                  '<button class="btn btn-danger" style="padding:5px 8px;" onclick="delInv(\''+i.id+'\')" title="حذف"><i class="fas fa-trash"></i></button>'+
                '</td></tr>';
            } catch(ex) { console.error(ex); }
          });
        }
        q("#tbInv").innerHTML = h;
      }).getInvItems();
    }).getRecipes();
  }).getMenuAll();
}

function openInvM(mode, id = null) {
  if (mode === 'add') {
    q("#iMdlTitle").innerText = "إضافة منتج جديد";
    q("#miId").value = ""; q("#miName").value = ""; q("#miCat").value = "عام";
    q("#miPrice").value = ""; q("#miCost").value = "0"; q("#miStock").value = "0"; q("#miMin").value = "5"; q("#miActive").checked = true;
  } else {
    q("#iMdlTitle").innerText = "تعديل المنتج";
    let d = state.menu.find(x => x.id === id);
    if (!d) return;
    q("#miId").value = d.id || ""; q("#miName").value = d.name || ""; q("#miCat").value = d.category || "";
    q("#miPrice").value = d.price || ""; q("#miCost").value = d.cost || "0"; q("#miStock").value = d.stock || "0"; q("#miMin").value = d.minStock || "5"; q("#miActive").checked = !!d.active;
  }
  openModal("#modalInvForm");
}

function saveInv() {
  const d = {
    id: q("#miId").value, name: q("#miName").value, category: q("#miCat").value,
    price: q("#miPrice").value, cost: q("#miCost").value, stock: q("#miStock").value, minStock: q("#miMin").value, active: q("#miActive").checked
  };
  if (!d.name || !d.price) return showToast("يرجى تعبئة الحقول الأساسية (الاسم والسعر)", true);
  
  loader();
  if (d.id) { api.withFailureHandler(err=>{loader(false);showToast(err.message,true);}).withSuccessHandler(r=>{loader(false); closeModal('#modalInvForm'); showToast("تم التعديل"); loadDashInv();}).updateMenuItem(d); }
  else { api.withFailureHandler(err=>{loader(false);showToast(err.message,true);}).withSuccessHandler(r=>{loader(false); closeModal('#modalInvForm'); showToast("تمت الإضافة"); loadDashInv();}).addMenuItem(d); }
}

// ─── Export Menu to Excel ───
function exportMenuExcel() {
  ensureXlsx().then(_exportMenuExcelBody).catch(function(e) { showToast(e.message || 'فشل تحميل XLSX', true); });
}
function _exportMenuExcelBody() {
  var headers = ['الاسم', 'التصنيف', 'سعر البيع', 'التكلفة', 'المخزون', 'الحد الأدنى', 'فعال'];
  var data = (state.menu || []).map(function(m) {
    return {
      'الاسم': m.name || '',
      'التصنيف': m.category || '',
      'سعر البيع': m.price || 0,
      'التكلفة': m.cost || 0,
      'المخزون': m.stock || 0,
      'الحد الأدنى': m.minStock || 0,
      'فعال': m.active ? 'نعم' : 'لا'
    };
  });
  var ws;
  if (data.length) {
    ws = XLSX.utils.json_to_sheet(data);
  } else {
    ws = XLSX.utils.aoa_to_sheet([headers]);
  }
  ws['!cols'] = [{wch:25},{wch:15},{wch:12},{wch:12},{wch:10},{wch:12},{wch:8}];
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
          stock: Number(r['المخزون'] || r['stock'] || r['Stock'] || 999),
          minStock: Number(r['الحد الأدنى'] || r['minStock'] || r['Min Stock'] || 5),
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
  if (tab === 'transfers') loadDashTransfers();
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
  var stockF = q("#rawStockFilter")?.value||'';
  return items.filter(function(i){
    var matchSearch = !search || (i.name||'').toLowerCase().includes(search) || (i.id||'').toLowerCase().includes(search) || (i.category||'').toLowerCase().includes(search);
    var matchCat = !cat || (i.category||'') === cat;
    var matchStock = !stockF || (stockF==='low' && i.stock<=i.minStock && i.stock>0) || (stockF==='out' && i.stock<=0) || (stockF==='ok' && i.stock>i.minStock);
    return matchSearch && matchCat && matchStock;
  });
}
function populateInvCatFilter() {
  var sel = q("#rawCatFilter");
  if (!sel || !cachedRawItems) return;
  var cats = []; cachedRawItems.forEach(function(i){ if(i.category && cats.indexOf(i.category)<0) cats.push(i.category); });
  sel.innerHTML = '<option value="">كل التصنيفات</option>' + cats.map(function(c){ return '<option value="'+c+'">'+c+'</option>'; }).join('');
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
    if(!list.length) h = "<tr><td colspan='9' style='text-align:center;'>\u0644\u0627 \u062a\u0648\u062c\u062f \u0645\u0648\u0627\u062f \u062e\u0627\u0645 \u0645\u0633\u062c\u0644\u0629</td></tr>";
    else {
      let grandTotal = 0;
      list.forEach(i => {
        try {
          let stClass = i.stock <= i.minStock ? 'red' : 'green';
          let cRate = Number(i.convRate) || 1;
          let hasBigUnit = !!i.bigUnit;

          let bigQty = hasBigUnit ? (i.stock / cRate).toFixed(2) : i.stock;
          let bigCost = i.cost;
          let smallQty = i.stock;
          let smallCost = hasBigUnit ? (i.cost / cRate) : i.cost;
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

          h += `<tr>
            <td style="font-family:monospace; color:var(--text-light); font-size:12px;">${i.id || ''}</td>
            <td style="font-weight:800; color:var(--text-dark);">${i.name || ''}</td>
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
      h += `<tr style="background:#f8fafc; border-top:2px solid var(--border);"><td colspan="5" style="font-weight:900; text-align:center;">\u0625\u062c\u0645\u0627\u0644\u064a \u0642\u064a\u0645\u0629 \u0627\u0644\u0645\u062e\u0632\u0648\u0646</td><td style="font-weight:900; color:#7c3aed; font-size:16px;">${formatVal(grandTotal)} SAR</td><td colspan="3"></td></tr>`;
    }
    if(q("#tbRawItems")) q("#tbRawItems").innerHTML = h;
}

function openRawModal(id = null) {
  if (!id) {
    q("#rMdlTitle").innerText = "إضافة مادة خام جديدة للمستودع";
    q("#mrId").value = ""; q("#mrName").value = ""; q("#mrCat").value = "";
    q("#mrCost").value = "0"; q("#mrBigUnit").value = ""; q("#mrUnit").value = "حبة"; q("#mrConvRate").value = "1";
    q("#mrStock").value = "0"; q("#mrMin").value = "0";
    if(q("#mrSmallCost")) q("#mrSmallCost").value = "0";
  } else {
    q("#rMdlTitle").innerText = "تعديل مادة خام";
    let d = cachedRawItems.find(x => x.id === id);
    if (!d) return;
    q("#mrId").value = d.id; q("#mrName").value = d.name; q("#mrCat").value = d.category;
    q("#mrCost").value = d.cost; 
    q("#mrBigUnit").value = d.bigUnit || ""; q("#mrUnit").value = d.unit || "حبة"; q("#mrConvRate").value = d.convRate || 1;
    q("#mrStock").value = d.stock; q("#mrMin").value = d.minStock;
  }
  calcSmallUnitCost();
  openModal("#modalRawForm");
}

function saveRawItem() {
  const d = {
    id: q("#mrId").value, name: q("#mrName").value, category: q("#mrCat").value,
    cost: q("#mrCost").value, bigUnit: q("#mrBigUnit").value, unit: q("#mrUnit").value, convRate: q("#mrConvRate").value,
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
  if (!cachedRawItems || !cachedRawItems.length) return showToast("لا توجد بيانات للتصدير", true);
  var wsData = [["ID","اسم المادة","التصنيف","سعر الوحدة الكبرى","المخزون (صغرى)","حد التنبيه","الوحدة الصغرى","الوحدة الكبرى","معامل التحويل","نشط"]];
  cachedRawItems.forEach(function(i) {
    wsData.push([i.id||'', i.name||'', i.category||'', i.cost||0, i.stock||0, i.minStock||0, i.unit||'', i.bigUnit||'', i.convRate||1, i.active!==false?'TRUE':'FALSE']);
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
        return {
          id: r['ID'] || r['id'] || r['كود'] || '',
          name: r['اسم المادة'] || r['Name'] || r['name'] || r['الاسم'] || '',
          category: r['التصنيف'] || r['Category'] || r['category'] || '',
          cost: Number(r['سعر الوحدة الكبرى'] || r['Cost'] || r['cost'] || r['السعر']) || 0,
          stock: Number(r['المخزون (صغرى)'] || r['Stock'] || r['stock'] || r['المخزون']) || 0,
          minStock: Number(r['حد التنبيه'] || r['MinStock'] || r['minStock'] || r['الحد الأدنى']) || 0,
          unit: r['الوحدة الصغرى'] || r['Unit'] || r['unit'] || r['الوحدة'] || '',
          bigUnit: r['الوحدة الكبرى'] || r['BigUnit'] || r['bigUnit'] || '',
          convRate: Number(r['معامل التحويل'] || r['ConvRate'] || r['convRate']) || 1,
          active: String(r['نشط'] || r['Active'] || r['active'] || 'TRUE').toUpperCase() !== 'FALSE'
        };
      }).filter(function(i) { return i.name; });
      if (!mapped.length) return showToast("لم يتم العثور على بيانات صالحة", true);
      if (!confirm("سيتم استيراد " + mapped.length + " مادة. المواد الموجودة سيتم تحديثها. متابعة؟")) return;
      loader(true);
      api.withSuccessHandler(function(r) {
        loader(false);
        if (r.success) { showToast("تم الاستيراد: " + r.added + " جديد، " + r.updated + " محدّث"); loadDashInvItems(); }
        else showToast(r.error || "خطأ", true);
      }).withFailureHandler(function(err) { loader(false); showToast("خطأ: " + err.message, true); }).importInvItems(mapped);
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
          var unitCost = raw ? (cRate>1 ? Number(raw.cost)/cRate : Number(raw.cost)) : 0;
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
    const smallCost = cRate > 1 ? (item.cost / cRate) : item.cost;
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
      var cRate = raw ? (Number(raw.convRate) || 1) : 1;
      var smallCost = raw ? (cRate > 1 ? raw.cost / cRate : raw.cost) : 0;
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
  if (!rawItem) return showToast("\u0627\u0644\u0645\u0627\u062f\u0629 \u063a\u064a\u0631 \u0645\u0648\u062c\u0648\u062f\u0629", true);
  currentRecipeIngredients.push({ invItemId: rawItem.id, invItemName: rawItem.name, qtyUsed: qty });

  q("#recRawSearch").value = "";
  q("#recRawId").value = "";
  q("#recRawName").value = "";
  q("#recQtyInput").value = "";
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

// =========================================
// 6.d. Transfers and Stocktake Stubs
// =========================================
function loadDashTransfers() {
  q("#tbTransfers").innerHTML = "<tr><td colspan='7' style='text-align:center; padding:30px;'>قريباً: يتم برمجة نظام التحويلات بين الفروع...</td></tr>";
}
function openTransferModal() {
  showToast("نظام التحويلات تحت التطوير", true);
}

// =========================================
// 6.e. Live Inventory 
// =========================================
function loadLiveInventory() {
  loader(true);
  api.withFailureHandler(err => {
    loader(false);
    showToast(err.message || "فشل تحميل المخزون الفعلي", true);
  }).withSuccessHandler(res => {
    loader(false);
    let h = "";
    if (res.error) {
      showToast(res.error, true);
      h = `<tr><td colspan="7" style="text-align:center;color:red;">${res.error}</td></tr>`;
    } else if (!res || res.length === 0) {
      h = "<tr><td colspan='7' style='text-align:center;'>لا توجد مواد مخزون. الرجاء إضافة مواد خام وتحديث الأرصدة.</td></tr>";
    } else {
      res.forEach(item => {
        let statusBadge = '';
        if (item.status === 'نفد') statusBadge = '<span class="badge red">نفد</span>';
        else if (item.status === 'منخفض') statusBadge = '<span class="badge" style="background:#fef3c7; color:#92400e;">منخفض</span>';
        else statusBadge = '<span class="badge green">جيد</span>';

        let unitDisplay = (item.bigUnit && Number(item.convRate) > 1) ? `${item.unit} (${item.convRate} حبة بالـ ${item.bigUnit})` : (item.unit || '');
        h += `<tr>
          <td style="font-weight:700;">${item.name}</td>
          <td>${item.category}</td>
          <td style="color:#64748b;">${item.initialStock} ${item.unit}</td>
          <td style="color:#16a34a; font-weight:700;">+${item.purchasedQty} ${item.unit} <br><small style="color:#94a3b8">${unitDisplay}</small></td>
          <td style="color:#e11d48; font-weight:700;">-${item.consumedQty} ${item.unit}</td>
          <td style="font-size:16px; font-weight:900; color:var(--primary);">${item.currentStock} ${item.unit}</td>
          <td>${statusBadge}</td>
        </tr>`;
      });
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
        h += `<tr>
          <td style="font-family:monospace; color:#64748b;">${st.id}</td>
          <td>${st.date ? new Date(st.date).toLocaleString('ar-SA') : ''}</td>
          <td style="font-weight:bold;">${st.username}</td>
          <td>${st.notes || '—'}</td>
          <td><span class="badge green">مكتمل ومُعتمد</span></td>
          <td><button class="btn btn-light" onclick="alert('تفاصيل التسوية لاحقاً')">عرض</button></td>
        </tr>`;
      });
    }
    q("#tbStocktake").innerHTML = h;
  }).getAllStocktakes();
}

function startStocktake() {
  loader();
  api.withSuccessHandler(items => {
    loader(false);
    cachedStItems = items || [];
    renderStItems();
    q("#stSearch").value = "";
    q("#stNotes").value = "";
    openModal("#modalStocktakeForm");
  }).getLiveInventory();
}

function filterStItems() { renderStItems(); }

function renderStItems() {
  const search = q("#stSearch").value.toLowerCase();
  let list = cachedStItems;
  if(search) list = list.filter(i => String(i.name||"").toLowerCase().includes(search));
  
  let h = "";
  list.forEach(i => {
    // Current system stock
    let curStock = Number(i.currentStock).toFixed(2);
    h += `<tr data-stid="${i.id}">
      <td style="font-family:monospace; color:var(--text-light); font-size:12px;">${i.id}</td>
      <td style="font-weight:700;">${i.name} <div style="font-size:11px; color:#64748b;">${i.category}</div></td>
      <td style="background:#f8fafc; font-weight:bold; color:var(--primary);">${curStock} ${i.unit||''}</td>
      <td>
        <div style="display:flex; align-items:center; gap:5px;">
          <input type="number" class="form-control st-actual-input" style="width:100px; margin:0; padding:6px;" data-sys="${curStock}" value="${curStock}" oninput="calcStDiff(this)">
          <span style="font-size:12px; color:#64748b;">${i.unit||''}</span>
        </div>
      </td>
      <td class="st-diff-cell" style="font-weight:900; direction:ltr; text-align:left;">
        <span style="color:var(--text-light);"><i class="fas fa-equals"></i> 0.00</span>
      </td>
    </tr>`;
  });
  q("#tbStBody").innerHTML = h;
}

function calcStDiff(inputNode) {
  let sys = Number(inputNode.getAttribute('data-sys')) || 0;
  let act = Number(inputNode.value) || 0;
  let diff = act - sys;
  let cell = inputNode.closest('tr').querySelector('.st-diff-cell');
  
  if (diff === 0) {
    cell.innerHTML = '<span style="color:var(--text-light);"><i class="fas fa-equals"></i> 0.00</span>';
  } else if (diff > 0) {
    cell.innerHTML = `<span style="color:var(--success); background:#f0fdf4; padding:2px 6px; border-radius:4px;"><i class="fas fa-arrow-up"></i> +${diff.toFixed(2)}</span>`;
  } else {
    cell.innerHTML = `<span style="color:var(--danger); background:#fef2f2; padding:2px 6px; border-radius:4px;"><i class="fas fa-arrow-down"></i> ${diff.toFixed(2)}</span>`;
  }
}

function saveStocktakeFn() {
  const rows = q("#tbStBody").querySelectorAll('tr');
  const itemsToAdjust = [];
  
  rows.forEach(r => {
    let id = r.getAttribute('data-stid');
    let inputNode = r.querySelector('.st-actual-input');
    if(inputNode) {
      let sys = Number(inputNode.getAttribute('data-sys')) || 0;
      let act = Number(inputNode.value) || 0;
      let diff = act - sys;
      if (Math.abs(diff) > 0.001) { // Only send items with actual differences
        itemsToAdjust.push({ id: id, diff: diff, sys: sys, actual: act });
      }
    }
  });

  if(itemsToAdjust.length === 0) {
    return showToast("لا توجد فوارق لتسويتها. الرصيد الفعلي يطابق النظام.", true);
  }

  if (!confirm(`سيتم إجراء تسوية جردية لعدد (${itemsToAdjust.length}) أصناف.. هل أنت متأكد؟`)) return;

  loader(true);
  const notes = q("#stNotes").value;
  api.withFailureHandler(err => {
    loader(false); showToast(err.message, true);
  }).withSuccessHandler(res => {
    loader(false);
    if(res.success) {
      closeModal("#modalStocktakeForm");
      showToast("تم اعتماد التسويـة بنجاح وانعكس الرصيد فوراً ✓");
      loadDashStocktake();
      loadDashInvItems();
      loadLiveInventory();
    } else {
      showToast(res.error, true);
    }
  }).submitStocktake(itemsToAdjust, state.user, notes);
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
      if (r === 'admin')   return '<span class="badge blue">مدير مؤسسة</span>';
      if (r === 'manager') return '<span class="badge orange">مدير فرع</span>';
      return '<span class="badge green">كاشير</span>';
    };

    var h = '';
    arr.forEach(function(u) {
      var devBadge = u.isDeveloper ? ' <span class="badge" style="background:#fef3c7;color:#92400e;border:1px solid #fde68a;"><i class="fas fa-code"></i> مطور</span>' : '';
      h += '<tr>' +
        '<td style="font-weight:bold; font-size:15px;">' + (u.displayName || '<span style="color:#94a3b8;">— لم يُحدد —</span>') + '</td>' +
        '<td style="font-family:monospace; font-weight:600; color:var(--secondary);">' + (u.username || '') + '</td>' +
        '<td>' + roleLabel(u.role) + devBadge + '</td>' +
        '<td>' + (u.active ? '<span class="badge green">نشط</span>' : '<span class="badge red">موقوف</span>') + '</td>' +
        '<td>' + (u.createdAt ? new Date(u.createdAt).toLocaleDateString('en-GB') : '—') + '</td>' +
        '<td>' +
          '<button class="btn btn-light" style="padding:6px 10px;" onclick="editUsr(\'' + u.username + '\')" title="تعديل"><i class="fas fa-edit"></i></button> ' +
          '<button class="btn btn-light" style="padding:6px 10px;" onclick="toggUsr(\'' + u.username + '\')" title="تفعيل/إيقاف"><i class="fas fa-power-off"></i></button> ' +
          '<button class="btn btn-danger" style="padding:6px 10px;" onclick="delUsr(\'' + u.username + '\')" title="حذف"><i class="fas fa-trash"></i></button>' +
        '</td>' +
      '</tr>';
    });
    if (!arr.length) h = '<tr><td colspan="6" style="text-align:center;padding:20px;color:#94a3b8;">لا يوجد مستخدمين</td></tr>';
    q("#tbUsers").innerHTML = h;
  }).withFailureHandler(function(err) { loader(false); showToast(err.message || 'فشل تحميل المستخدمين', true); }).getUsers();
}

var _editingUsername = '';
function tglUserM() {
  _editingUsername = '';
  q("#muModalTitle").innerText = 'إضافة موظف جديد';
  q("#muDisplayName").value = '';
  q("#muName").value = '';
  q("#muName").disabled = false;
  q("#muPass").value = '';
  q("#muPass").placeholder = '******';
  q("#muRole").value = 'cashier';
  if (q("#muIsDeveloper")) q("#muIsDeveloper").checked = false;
  openModal('#modalUserForm');
}

function editUsr(username) {
  var u = _cachedUsers.find(function(x){ return x.username === username; });
  if (!u) return;
  _editingUsername = username;
  q("#muModalTitle").innerText = 'تعديل المستخدم — ' + (u.displayName || u.username);
  q("#muDisplayName").value = u.displayName || '';
  q("#muName").value = u.username;
  q("#muName").disabled = true; // username (employee number) cannot change
  q("#muPass").value = '';
  q("#muPass").placeholder = 'اتركها فارغة لعدم التغيير';
  q("#muRole").value = u.role || 'cashier';
  if (q("#muIsDeveloper")) q("#muIsDeveloper").checked = !!u.isDeveloper;
  openModal('#modalUserForm');
}

function saveUserFn() {
  var displayName = (q("#muDisplayName").value || '').trim();
  var username    = (q("#muName").value || '').trim();
  var password    = q("#muPass").value || '';
  var role        = q("#muRole").value || 'cashier';
  var isDeveloper = q("#muIsDeveloper") ? q("#muIsDeveloper").checked : false;

  if (!username) return showToast('الرقم الوظيفي مطلوب', true);
  if (!_editingUsername && !password) return showToast('كلمة المرور مطلوبة عند إنشاء مستخدم', true);

  loader();
  if (_editingUsername) {
    var payload = { displayName: displayName, role: role, isDeveloper: isDeveloper };
    if (password) payload.password = password;
    api.withFailureHandler(function(err){loader(false); showToast(err.message, true);})
       .withSuccessHandler(function(r) {
          loader(false);
          if (r && r.success) { showToast('تم تحديث المستخدم'); closeModal('#modalUserForm'); loadDashUsers(); }
          else showToast((r && r.error) || 'فشل التحديث', true);
       }).updateUser(_editingUsername, payload);
  } else {
    var data = { username: username, password: password, role: role, displayName: displayName, isDeveloper: isDeveloper };
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
function loadDashPurchases() {
  // Pre-load suppliers & items so dropdowns are ready when modal opens
  api.withSuccessHandler(sups => { state.suppliersList = sups || []; }).getSuppliers();
  api.withSuccessHandler(items => { state.purInvItems = items || []; }).getInvItems();
  loader();
  const filters = {};
  const start = q("#fpurStart") ? q("#fpurStart").value : "";
  const end = q("#fpurEnd") ? q("#fpurEnd").value : "";
  if (start) filters.startDate = start;
  if (end) filters.endDate = end;
  
  api.withSuccessHandler(res => {
    loader(false);
    if (res && res.error) {
      showToast(res.error, true);
      q("#tbPurchases").innerHTML = `<tr><td colspan='9' style='text-align:center; padding:30px; color:var(--danger);'>${res.error}</td></tr>`;
      return;
    }
    const arr = res || [];
    let totalAmt = 0;
    let h = "";
    if (!arr.length) {
      h = "<tr><td colspan='9' style='text-align:center; padding:30px; color:var(--text-light);'>لا توجد مشتريات مسجلة</td></tr>";
    } else {
      state.purchasesCache = arr;
      arr.forEach((p, idx) => {
        totalAmt += p.totalPrice;
        const payBadge = p.paymentMethod === 'Cash'
          ? '<span class="badge green">كاش</span>'
          : (p.paymentMethod === 'آجل'
            ? '<span class="badge yellow">آجل</span>'
            : `<span class="badge blue">${p.paymentMethod}</span>`);
        const statusBadge = (p.status === 'received')
          ? '<span class="badge green">\u062a\u0645 \u0627\u0644\u0627\u0633\u062a\u0644\u0627\u0645</span>'
          : '<span class="badge" style="background:#fef3c7;color:#92400e;">\u0628\u0627\u0646\u062a\u0638\u0627\u0631 \u0627\u0644\u0627\u0633\u062a\u0644\u0627\u0645</span>';
        const receiveBtn = (p.status !== 'received')
          ? `<button class="btn btn-success" style="padding:6px 12px;" onclick="receivePurFn('${p.id}')" title="\u0627\u0633\u062a\u0644\u0627\u0645 \u0644\u0644\u0645\u062e\u0632\u0648\u0646"><i class="fas fa-check-double"></i></button>`
          : '';
        var hasItems = p.itemsJson && p.itemsJson.length > 5;
        var itemLabel = hasItems ? '<i class="fas fa-box-open" style="color:var(--accent);margin-left:4px;"></i> '+p.itemName : p.itemName;
        // المبلغ المُدخل بدون ضريبة — الضريبة تُضاف عليه
        var purNet = p.totalPrice;
        var purVAT = Math.round(purNet*0.15*100)/100;
        var purTotal = Math.round((purNet + purVAT)*100)/100;
        h += '<tr>'+
          '<td>'+(p.date ? new Date(p.date).toLocaleString('ar-SA') : '—')+'</td>'+
          '<td style="font-weight:600;">'+p.supplierName+'</td>'+
          '<td>'+itemLabel+'</td>'+
          '<td style="text-align:center;">'+p.qty+'</td>'+
          '<td>'+formatVal(purNet)+'</td>'+
          '<td style="color:#d97706;font-weight:600;">'+formatVal(purVAT)+'</td>'+
          '<td style="font-weight:900; color:var(--secondary);">'+formatVal(purTotal)+'</td>'+
          '<td>'+payBadge+'</td>'+
          '<td>'+statusBadge+'</td>'+
          '<td>'+p.username+'</td>'+
          '<td style="white-space:nowrap;">'+receiveBtn+
            '<button class="btn btn-primary" style="padding:6px 12px;" onclick="printPurchaseCached('+idx+')" title="طباعة"><i class="fas fa-print"></i></button> '+
            '<button class="btn btn-danger" style="padding:6px 12px;" onclick="delPurFn(\''+p.id+'\')"><i class="fas fa-trash"></i></button>'+
          '</td></tr>';
      });
    }
    q("#tbPurchases").innerHTML = h;
    q("#purTotalAmt").innerText = formatVal(totalAmt);
    q("#purTotalCount").innerText = arr.length;
  }).getPurchases(Object.keys(filters).length ? filters : null);
}

let purCart = [];

function openPurModal() {
  q("#purSupplier").value = ""; q("#purNotes").value = "";
  if (q("#purSupplierId")) q("#purSupplierId").value = "";
  q("#purItemSearch").value = ""; q("#purItem").value = ""; q("#purItemId").value = "";
  q("#purQty").value = "1"; q("#purUnitPrice").value = "";
  if (q("#purInvDate")) q("#purInvDate").value = new Date().toISOString().split('T')[0];
  purCart = [];
  renderPurCart();

  const results = q("#purItemResults");
  if (results) results.classList.remove('open');
  const supResults = q("#purSupplierResults");
  if (supResults) supResults.classList.remove('open');

  // Load suppliers + inventory items
  api.withSuccessHandler(sups => { state.suppliersList = sups || []; }).getSuppliers();
  api.withSuccessHandler(items => { state.purInvItems = items || []; }).getInvItems();
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

  // Read items from ItemsJSON if available, otherwise single item
  rcvItems = [];
  if (invoice.itemsJson && invoice.itemsJson.length > 5) {
    try {
      var parsed = JSON.parse(invoice.itemsJson);
      rcvItems = parsed.map(function(it){ return { itemName: it.ItemName||'', itemId: it.ItemID||'', qty: Number(it.Qty)||0, unitPrice: Number(it.UnitPrice)||0, received: Number(it.Qty)||0, checked: true }; });
    } catch(e) {}
  }
  if (!rcvItems.length) {
    rcvItems = [{ itemName: invoice.itemName, qty: invoice.qty, unitPrice: invoice.unitPrice, received: invoice.qty, checked: true }];
  }

  q("#rcvInvoiceId").innerText = invoiceId + (invoice.notes ? ' | ' + invoice.notes : '');
  q("#rcvSupplierName").innerText = invoice.supplierName || '';

  var h = '';
  rcvItems.forEach(function(item, i) {
    h += '<tr>'+
      '<td><input type="checkbox" class="rcv-check" data-idx="'+i+'" checked onchange="rcvItems['+i+'].checked=this.checked"></td>'+
      '<td style="font-weight:600;">'+item.itemName+'</td>'+
      '<td style="text-align:center;">'+item.qty+'</td>'+
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
    if (r.success) {
      closeModal('#modalReceiveForm');
      var toast = "تم استلام " + (r.count||0) + " صنف وتحديث المخزون";
      if (r.vatAmount) toast += " | ضريبة مدخلات: " + r.vatAmount.toFixed(2);
      showToast(toast);
      loadDashPurchases();
    } else showToast(r.error, true);
  }).receivePurchaseBatch(rcvInvoiceId, state.user, includesVAT);
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
    '<th>الكود</th><th>الصنف</th><th>الكمية</th><th>سعر الوحدة</th><th>الإجمالي</th>'+
    (!isReceived?'<th>استلام</th>':'')+
    '</tr></thead><tbody>';
  items.forEach(function(it,i){
    h += '<tr><td><code style="font-size:11px;">'+( it.ItemID||'—')+'</code></td>'+
      '<td style="font-weight:600;">'+( it.ItemName||'')+'</td>'+
      '<td style="text-align:center;">'+( it.Qty||0)+'</td>'+
      '<td style="text-align:center;">'+(Number(it.UnitPrice)||0).toFixed(2)+'</td>'+
      '<td style="text-align:center;font-weight:700;">'+(Number(it.Total)||(Number(it.Qty)*Number(it.UnitPrice))||0).toFixed(2)+'</td>'+
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
  currentSalesTab = tabId;
  // Update tab buttons
  qs('.sales-tab').forEach(el => el.classList.remove('active'));
  const tabBtn = q('#stab_' + tabId);
  if (tabBtn) tabBtn.classList.add('active');
  // Update tab contents
  qs('.sales-tab-content').forEach(el => el.classList.remove('active'));
  const tabContent = q('#stc_' + tabId);
  if (tabContent) tabContent.classList.add('active');
  // Load data
  if (tabId === 'log') loadDashSales();
  if (tabId === 'payments') loadPayments();
  if (tabId === 'reports') loadSalesBreakdown(activeBreakdownType);
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
  // Default to today if no date range was set
  var start = q("#fpayStart") ? q("#fpayStart").value : "";
  var end   = q("#fpayEnd")   ? q("#fpayEnd").value   : "";
  if (!start && !end) {
    var today = new Date().toISOString().split('T')[0];
    start = today; end = today;
    if (q("#fpayStart")) q("#fpayStart").value = today;
    if (q("#fpayEnd"))   q("#fpayEnd").value   = today;
  } else if (!end) {
    end = start;
  } else if (!start) {
    start = end;
  }
  var cashier = q("#fpayCashier") ? q("#fpayCashier").value : "";
  var params = { startDate: start, endDate: end };
  if (cashier) params.username = cashier;

  // No dedicated /payments-summary endpoint exists — compute everything from /api/sales
  api.withFailureHandler(function(err) { loader(false); showToast(err.message || 'فشل تحميل الدفعات', true); })
    .withSuccessHandler(function(sales) {
      loader(false);
      sales = Array.isArray(sales) ? sales : [];

      var totals = { cash: 0, card: 0, kita: 0, all: 0 };
      var counts = { cash: 0, card: 0, kita: 0, all: 0 };
      var dayMap = {};      // key = YYYY-MM-DD
      var cashierMap = {};  // key = username

      sales.forEach(function(s) {
        var amount = Number(s.total) || 0;
        var dateKey = String(s.date || '').split('T')[0];
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
  // Update buttons
  qs('.breakdown-btn').forEach(el => el.classList.remove('active'));
  const btn = q('#brk_' + type);
  if (btn) btn.classList.add('active');

  loader();
  // Default to last 30 days if no date range was set
  var start = q("#fbrkStart") ? q("#fbrkStart").value : "";
  var end   = q("#fbrkEnd")   ? q("#fbrkEnd").value   : "";
  if (!start || !end) {
    var today = new Date();
    var thirty = new Date(today); thirty.setDate(thirty.getDate() - 29);
    var fmt = function(d){ return d.toISOString().split('T')[0]; };
    if (!end)   end   = fmt(today);
    if (!start) start = fmt(thirty);
    if (q("#fbrkStart") && !q("#fbrkStart").value) q("#fbrkStart").value = start;
    if (q("#fbrkEnd")   && !q("#fbrkEnd").value)   q("#fbrkEnd").value   = end;
  }
  var params = { startDate: start, endDate: end };

  // No /salesBreakdown endpoint exists — compute everything from /api/sales
  api.withFailureHandler(function(err) { loader(false); showToast(err.message || 'فشل تحميل التقرير', true); })
  .withSuccessHandler(function(sales) {
    loader(false);
    sales = Array.isArray(sales) ? sales : [];

    // Aggregate the sales into the requested breakdown shape
    var aggregated = {};
    sales.forEach(function(s) {
      var amount = Number(s.total) || 0;
      var pay = String(s.payment || '').toLowerCase();
      var dateKey = String(s.date || '').split('T')[0];

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
      }
    });

    // Sort: revenue desc for product/cashier; chronological for month/day
    var data = Object.values(aggregated);
    if (type === 'byMonth' || type === 'byDay') {
      data.sort(function(a, b) { return a.name < b.name ? -1 : 1; });
    } else {
      data.sort(function(a, b) { return b.revenue - a.revenue; });
    }
    // Update table headers
    const headMap = {
      byProduct: '<tr><th>\u0627\u0644\u0645\u0646\u062a\u062c</th><th>\u0627\u0644\u0643\u0645\u064a\u0629</th><th>\u0639\u062f\u062f \u0627\u0644\u0637\u0644\u0628\u0627\u062a</th><th>\u0627\u0644\u0625\u064a\u0631\u0627\u062f (SAR)</th></tr>',
      byCashier: '<tr><th>\u0627\u0644\u0643\u0627\u0634\u064a\u0631</th><th>\u0627\u0644\u0637\u0644\u0628\u0627\u062a</th><th>\u0643\u0627\u0634</th><th>\u0645\u062f\u0649</th><th>\u0643\u064a\u062a\u0627</th><th>\u0627\u0644\u0625\u064a\u0631\u0627\u062f (SAR)</th></tr>',
      byMonth: '<tr><th>\u0627\u0644\u0634\u0647\u0631</th><th>\u0639\u062f\u062f \u0627\u0644\u0637\u0644\u0628\u0627\u062a</th><th>\u0627\u0644\u0625\u064a\u0631\u0627\u062f (SAR)</th></tr>',
      byDay: '<tr><th>\u0627\u0644\u064a\u0648\u0645</th><th>\u0639\u062f\u062f \u0627\u0644\u0637\u0644\u0628\u0627\u062a</th><th>\u0627\u0644\u0625\u064a\u0631\u0627\u062f (SAR)</th></tr>'
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
    var t = (Number(it.Qty)||0)*(Number(it.UnitPrice)||0);
    var iNet = t;
    var iVat = Math.round(t*0.15*100)/100;
    return '<tr><td>'+(i+1)+'</td><td style="font-weight:600;text-align:right;padding-right:12px;">'+(it.ItemName||'')+'</td><td>'+(it.Qty||0)+'</td><td>'+(Number(it.UnitPrice)||0).toFixed(2)+'</td><td>'+iNet.toFixed(2)+'</td><td style="color:#d97706;">'+iVat.toFixed(2)+'</td><td style="font-weight:700;">'+(iNet+iVat).toFixed(2)+'</td></tr>';
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
    '<table><thead><tr><th>#</th><th>الصنف</th><th>الكمية</th><th>سعر الوحدة</th><th>الصافي</th><th style="color:#d97706;">الضريبة 15%</th><th>الإجمالي</th></tr></thead><tbody>'+rows+'</tbody></table>'+
    '<div class="totals">'+
      '<div class="tot-card" style="background:#f8fafc;"><div class="l">المبلغ قبل الضريبة</div><div class="v">'+grandNet.toFixed(2)+'</div></div>'+
      '<div class="tot-card" style="background:#fefce8;"><div class="l">ضريبة القيمة المضافة 15%</div><div class="v" style="color:#d97706;">'+grandVAT.toFixed(2)+'</div></div>'+
      '<div class="tot-card" style="background:#eff6ff;border-color:#93c5fd;"><div class="l">إجمالي الفاتورة</div><div class="v" style="color:#1e40af;">'+grandTotal.toFixed(2)+' '+currency+'</div></div>'+
    '</div>'+
    (p.notes?'<div class="notes"><strong>ملاحظات:</strong> '+p.notes+'</div>':'')+
    '<div class="sig"><div><div class="line"></div><div class="cap">المستلم</div></div><div><div class="line"></div><div class="cap">المورد</div></div><div><div class="line"></div><div class="cap">المدير</div></div></div>'+
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
      <div class="sig-line"><div class="line"></div><div class="caption">توقيع المستلم</div></div>
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
  api.withFailureHandler(err => {
    loader(false); showToast(err.message, true);
  }).withSuccessHandler(res => {
    loader(false);
    if(res.success) {
      state.activeShiftId = res.shiftId;
      updateShiftUI();
      showToast("تم بدء الوردية بنجاح!");
      // POS is no longer embedded in the admin view — stay on the current page
    } else { showToast(res.error, true); }
  }).openShift(state.user);
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
    _allShifts = (res||[]).sort(function(a,b){ return new Date(b.StartTime||0)-new Date(a.StartTime||0); });
    // Populate cashier filter
    var cashiers = []; _allShifts.forEach(function(s){ if(s.Username && cashiers.indexOf(s.Username)<0) cashiers.push(s.Username); });
    var sel = q("#shFilterCashier");
    if (sel) sel.innerHTML = '<option value="">All Cashiers</option>' + cashiers.map(function(c){return '<option value="'+c+'">'+c+'</option>';}).join('');
    filterShifts();
  }).getAllShifts();
}
function filterShifts() {
  var dateF = q("#shFilterDate")?.value||'';
  var cashierF = q("#shFilterCashier")?.value||'';
  var filtered = _allShifts.filter(function(s){
    var matchDate = !dateF || (s.StartTime && s.StartTime.toString().indexOf(dateF)>=0);
    var matchCashier = !cashierF || s.Username===cashierF;
    return matchDate && matchCashier;
  });
  renderShiftsTable(filtered);
}
function fmtDT(v){ if(!v) return '—'; try{var d=new Date(v);return d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})+' '+d.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'});}catch(e){return String(v);} }
function renderShiftsTable(list) {
  var tb = q("#tbShifts");
  if (!list||!list.length) { tb.innerHTML='<tr><td colspan="11" style="text-align:center;padding:20px;color:#94a3b8;">No shifts found</td></tr>'; updateShiftTotals([]); return; }
  tb.innerHTML = list.map(function(s){
    var thCash=Number(s.TheoreticalCash)||0, thCard=Number(s.TheoreticalCard)||0, thKita=Number(s.TheoreticalKita)||0;
    var aCash=Number(s.ActualCash)||0, aCard=Number(s.ActualCard)||0, aKita=Number(s.ActualKita)||0;
    var tTheo=thCash+thCard+thKita, tAct=aCash+aCard+aKita, tDiff=tAct-tTheo;
    var dCash=aCash-thCash, dCard=aCard-thCard, dKita=aKita-thKita;
    var dc=function(v){return v===0?'#64748b':(v>0?'#16a34a':'#ef4444');};
    var fs=function(v){return (v>0?'+':'')+formatVal(v);};
    var diffBadge = tDiff===0?'<span class="badge green">Balanced</span>':(tDiff>0?'<span class="badge" style="background:#dcfce7;color:#166534;">+'+formatVal(tDiff)+'</span>':'<span class="badge red">'+formatVal(tDiff)+'</span>');
    return '<tr>'+
      '<td style="font-family:monospace;font-size:11px;color:#64748b;">'+s.ShiftID+'</td>'+
      '<td style="font-weight:700;">'+s.Username+'</td>'+
      '<td style="font-size:12px;">'+fmtDT(s.StartTime)+'</td>'+
      '<td style="font-size:12px;">'+(s.EndTime?fmtDT(s.EndTime):'<span class="badge orange">Open</span>')+'</td>'+
      '<td style="font-weight:700;">'+formatVal(tTheo)+'</td>'+
      '<td style="font-weight:900;color:var(--primary);">'+formatVal(tAct)+'</td>'+
      '<td>'+diffBadge+'</td>'+
      '<td style="color:'+dc(dCash)+';font-weight:600;font-size:12px;">'+fs(dCash)+'</td>'+
      '<td style="color:'+dc(dCard)+';font-weight:600;font-size:12px;">'+fs(dCard)+'</td>'+
      '<td style="color:'+dc(dKita)+';font-weight:600;font-size:12px;">'+fs(dKita)+'</td>'+
      '<td><button class="btn btn-sm btn-primary" onclick=\'reprintShift('+JSON.stringify(s).replace(/'/g,"&#39;")+')\' title="Print"><i class="fas fa-print"></i></button></td>'+
    '</tr>';
  }).join('');
  updateShiftTotals(list);
}
function updateShiftTotals(list) {
  var tExp=0,tAct=0,tDiff=0,count=0;
  list.forEach(function(s){
    var th=(Number(s.TheoreticalCash)||0)+(Number(s.TheoreticalCard)||0)+(Number(s.TheoreticalKita)||0);
    var ta=(Number(s.ActualCash)||0)+(Number(s.ActualCard)||0)+(Number(s.ActualKita)||0);
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
    var thC=Number(s.TheoreticalCash)||0,thR=Number(s.TheoreticalCard)||0,thK=Number(s.TheoreticalKita)||0;
    var aC=Number(s.ActualCash)||0,aR=Number(s.ActualCard)||0,aK=Number(s.ActualKita)||0;
    ws.push([s.ShiftID,s.Username,fmtDT(s.StartTime),fmtDT(s.EndTime),thC,thR,thK,thC+thR+thK,aC,aR,aK,aC+aR+aK,aC-thC,aR-thR,aK-thK,(aC+aR+aK)-(thC+thR+thK)]);
  });
  var wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(ws),'Shifts');
  XLSX.writeFile(wb,'Shifts_Report_'+new Date().toISOString().split('T')[0]+'.xlsx');
}

function reprintShift(s) {
  const actTotal = (Number(s.ActualCash)||0) + (Number(s.ActualCard)||0) + (Number(s.ActualKita)||0);
  const theoTotal = Number(s.TotalTheoretical) || 0;
  loader(true);
  api.withSuccessHandler(res => {
    loader(false);
    const soldItems = (res && res.soldItems) ? res.soldItems : [];
    printShiftPDF({
      shiftId: s.ShiftID,
      actuals: { cash: s.ActualCash, card: s.ActualCard, kita: s.ActualKita },
      expected: { cash: s.TheoreticalCash, card: s.TheoreticalCard, kita: s.TheoreticalKita },
      diff: { totalDiff: actTotal - theoTotal },
      startTime: s.StartTime,
      endTime: s.EndTime,
      user: s.Username,
      soldItems: soldItems
    });
  }).withFailureHandler(err => {
    loader(false);
    // Print without items on error
    printShiftPDF({
      shiftId: s.ShiftID,
      actuals: { cash: s.ActualCash, card: s.ActualCard, kita: s.ActualKita },
      expected: { cash: s.TheoreticalCash, card: s.TheoreticalCard, kita: s.TheoreticalKita },
      diff: { totalDiff: actTotal - theoTotal },
      startTime: s.StartTime,
      endTime: s.EndTime,
      user: s.Username,
      soldItems: []
    });
  }).getShiftDataForClosing(s.ShiftID);
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
