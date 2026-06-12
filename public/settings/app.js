/**
 * Settings page logic — branding (logo + name + tax) + payment methods + developer reset
 * Standalone — uses /shared/common.js + /shared/auth.js + /shared/api-bridge.js
 */

document.addEventListener('DOMContentLoaded', function() {
  if (!requireAuth()) return;
  document.body.classList.add('authenticated');
  restoreState();

  // Header + branding
  renderHeader('settings');
  applyLang();
  translateUI();
  if (typeof refreshBrandingFromServer === 'function') {
    refreshBrandingFromServer(function() { renderHeader('settings'); });
  }

  // Pull initial app data so settings + paymentMethods + isDeveloper get populated
  loader(true);
  api.withSuccessHandler(function(res) {
    loader(false);
    if (!res || res.error) return showToast((res && res.error) || 'فشل تحميل الإعدادات', true);

    state.settings = res.settings || state.settings;
    state.paymentMethods = res.paymentMethods || [];
    state.kitaFeeRate = Number(res.kitaFeeRate) || 0;
    state.currentUser = res.currentUser || { username: state.user, role: state.role };
    state.isDeveloper = !!(res.currentUser && res.currentUser.isDeveloper);
    saveState();

    // Populate fields
    q('#setCompany').value = state.settings.name || '';
    q('#setTax').value = state.settings.taxNumber || '';
    // V5.7.9 — phone + email (optional, used on printed receipt footer)
    if (q('#setPhone')) q('#setPhone').value = state.settings.companyPhone || '';
    if (q('#setEmail')) q('#setEmail').value = state.settings.companyEmail || '';
    // v6.20.0 — tax settings: name + rate + new-product default basis
    if (q('#setSalesTaxName')) q('#setSalesTaxName').value = state.settings.SalesTaxName || state.settings.salesTaxName || 'ضريبة القيمة المضافة 15%';
    if (q('#setVATRate')) q('#setVATRate').value = state.settings.VATRate || state.settings.vatRate || '15';
    var newProdIncl = String(state.settings.NewProductsTaxInclusive || state.settings.newProductsTaxInclusive || '0') === '1';
    if (q('#setNewProdInclusive') && q('#setNewProdExclusive')) {
      q('#setNewProdInclusive').checked = newProdIncl;
      q('#setNewProdExclusive').checked = !newProdIncl;
    }
    // Cashier permission: require manager approval to VOID an invoice (default ON).
    if (q('#setRequireVoidApproval')) {
      q('#setRequireVoidApproval').checked = String(state.settings.requireManagerApprovalForVoid) !== '0';
    }
    if (state.settings.logo) {
      q('#setLogoPreview').innerHTML = '<img src="' + state.settings.logo + '" alt="logo">';
    }
    // V5.7.11 — payment-methods UI moved to dedicated admin section.
    //           Skip its render call when its host element no longer exists.
    if (q('#payMethodsSettings')) renderPaymentMethods();
    renderHeader('settings');
    applyDeveloperVisibility();
  }).withFailureHandler(function(err) {
    loader(false);
    showToast(err.message || 'تعذر الاتصال بالخادم', true);
  }).getInitialAppData(state.user);
});

window.onLangChange = function() { renderHeader('settings'); };

// =========================================
// Logo upload (resize client-side ≤200×200)
// =========================================
window.handleLogoUpload = function(input) {
  var file = input.files && input.files[0];
  if (!file) return;
  if (!file.type || file.type.indexOf('image/') !== 0) return showToast('يرجى اختيار ملف صورة', true);

  var reader = new FileReader();
  reader.onload = function(e) {
    var img = new Image();
    img.onload = function() {
      var MAX = 200;
      var w = img.width, h = img.height;
      if (w > h) { if (w > MAX) { h = Math.round(h * MAX / w); w = MAX; } }
      else       { if (h > MAX) { w = Math.round(w * MAX / h); h = MAX; } }
      var canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      var dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      q('#setLogoPreview').innerHTML = '<img src="' + dataUrl + '" alt="logo">';
      state.settings.logo = dataUrl;
      showToast('تم تحميل الشعار — اضغط حفظ لاعتماده');
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
};

window.removeLogo = function() {
  glassConfirm('إزالة الشعار', 'هل تريد إزالة شعار الشركة؟', { danger: true, okText: 'نعم، أزله' }).then(function(ok) {
    if (!ok) return;
    state.settings.logo = '';
    q('#setLogoPreview').innerHTML = '<i class="fas fa-image"></i>';
    showToast('سيتم إزالة الشعار عند الحفظ');
  });
};

// =========================================
// Payment methods
// =========================================
window.renderPaymentMethods = function() {
  var container = q('#payMethodsSettings');
  if (!container) return;
  var methods = state.paymentMethods || [];
  if (!methods.length) {
    container.innerHTML = '<p style="text-align:center;color:#94a3b8;padding:14px;">لا توجد طرق دفع — أضف واحدة بالأسفل</p>';
    return;
  }
  container.innerHTML = methods.map(function(m, i) {
    var checked = (m.IsActive !== false && m.IsActive !== 'FALSE') ? 'checked' : '';
    return '<div class="pm-row">' +
      '<input type="checkbox" class="pm-active" data-idx="' + i + '" ' + checked + '>' +
      '<div class="pm-icon-col" onclick="changePaymentIcon(' + i + ')" title="تغيير الأيقونة">' +
        '<i class="fas ' + (m.Icon || 'fa-money-bill') + '"></i>' +
      '</div>' +
      '<input type="text" class="form-control pm-name-ar" data-idx="' + i + '" value="' + (m.NameAR || '') + '" placeholder="الاسم بالعربي">' +
      '<div class="pm-meta">' +
        '<label>الاسم EN</label>' +
        '<input type="text" class="form-control pm-name-en" data-idx="' + i + '" value="' + (m.Name || '') + '" placeholder="English">' +
      '</div>' +
      '<div class="pm-meta">' +
        '<label>رسوم %</label>' +
        '<input type="number" step="0.1" class="form-control pm-fee" data-idx="' + i + '" value="' + (Number(m.ServiceFeeRate) || 0) + '">' +
      '</div>' +
      '<button class="pm-del" onclick="removePaymentMethod(' + i + ')" title="حذف"><i class="fas fa-trash"></i></button>' +
    '</div>';
  }).join('');
};

window.addNewPaymentMethod = function() {
  state.paymentMethods.push({
    Name: 'NewMethod',
    NameAR: 'طريقة جديدة',
    Icon: 'fa-money-bill',
    IsActive: true,
    ServiceFeeRate: 0,
    SortOrder: state.paymentMethods.length + 1
  });
  renderPaymentMethods();
};

window.removePaymentMethod = function(idx) {
  var m = state.paymentMethods[idx];
  if (!m) return;
  glassConfirm('حذف طريقة الدفع', 'حذف "' + (m.NameAR || m.Name || '') + '"؟', { danger: true, okText: 'حذف' }).then(function(ok) {
    if (!ok) return;
    if (m.ID) {
      // Persist the delete on the server immediately so it doesn't reappear after reload
      loader(true);
      api.withFailureHandler(function(err) { loader(false); showToast('فشل الحذف: ' + err.message, true); })
         .withSuccessHandler(function(r) {
            loader(false);
            if (r && r.success) {
              state.paymentMethods.splice(idx, 1);
              renderPaymentMethods();
              showToast('تم حذف طريقة الدفع');
            } else {
              showToast((r && r.error) || 'فشل الحذف', true);
            }
         }).deletePaymentMethod(m.ID);
    } else {
      state.paymentMethods.splice(idx, 1);
      renderPaymentMethods();
      showToast('تم حذف طريقة الدفع');
    }
  });
};

window.changePaymentIcon = function(idx) {
  var m = state.paymentMethods[idx];
  if (!m) return;
  var icon = prompt('أدخل اسم أيقونة FontAwesome (مثال: fa-wallet, fa-mobile, fa-coins):', m.Icon || 'fa-money-bill');
  if (icon) { m.Icon = icon; renderPaymentMethods(); }
};

// =========================================
// Save all settings
// =========================================
window.saveAllSettings = function() {
  var name    = q('#setCompany').value || '';
  var taxNum  = q('#setTax').value || '';
  var logo    = state.settings.logo || '';
  // V5.7.9 — capture phone + email (optional)
  var phone   = (q('#setPhone') && q('#setPhone').value) || '';
  var email   = (q('#setEmail') && q('#setEmail').value) || '';
  // v6.20.0 — capture tax settings
  var salesTaxName  = (q('#setSalesTaxName') && q('#setSalesTaxName').value) || '';
  var vatRateRaw    = (q('#setVATRate') && q('#setVATRate').value) || '';
  var vatRate       = vatRateRaw === '' ? '' : String(Math.max(0, Math.min(100, Number(vatRateRaw) || 0)));
  var newProdIncl   = !!(q('#setNewProdInclusive') && q('#setNewProdInclusive').checked);
  // Cashier permission: default ON (checked) when the row is absent.
  var requireVoidApproval = q('#setRequireVoidApproval') ? !!q('#setRequireVoidApproval').checked : true;

  // Collect updated payment methods from the DOM
  var methods = (state.paymentMethods || []).map(function(m, i) {
    var activeEl = document.querySelector('.pm-active[data-idx="' + i + '"]');
    var nameArEl = document.querySelector('.pm-name-ar[data-idx="' + i + '"]');
    var nameEnEl = document.querySelector('.pm-name-en[data-idx="' + i + '"]');
    var feeEl    = document.querySelector('.pm-fee[data-idx="' + i + '"]');
    return {
      ID: m.ID,
      Icon: m.Icon,
      SortOrder: m.SortOrder,
      Name: nameEnEl ? nameEnEl.value : m.Name,
      NameAR: nameArEl ? nameArEl.value : m.NameAR,
      IsActive: activeEl ? activeEl.checked : m.IsActive,
      ServiceFeeRate: feeEl ? Number(feeEl.value) || 0 : Number(m.ServiceFeeRate) || 0
    };
  });

  // V5.7.11 — payment-methods UI moved to dedicated admin section.
  //           If the legacy DOM block is gone, just save branding + contact
  //           and skip the methods round-trip entirely.
  var hasMethodsUI = !!q('#payMethodsSettings');

  loader(true);
  // 1) Save company branding (always)
  api.withFailureHandler(function(err) { loader(false); showToast(err.message, true); })
    .withSuccessHandler(function() {
      function finishBranding() {
        loader(false);
        state.settings.name = name;
        state.settings.taxNumber = taxNum;
        state.settings.companyPhone = phone;
        state.settings.companyEmail = email;
        // v6.20.0 — mirror tax settings into local state so the next
        // product-add modal reads the fresh default without a reload.
        if (salesTaxName) state.settings.SalesTaxName = salesTaxName;
        if (vatRate) state.settings.VATRate = vatRate;
        state.settings.NewProductsTaxInclusive = newProdIncl ? '1' : '0';
        state.settings.requireManagerApprovalForVoid = requireVoidApproval ? '1' : '0';
        showToast('تم حفظ الإعدادات بنجاح');
        try { localStorage.setItem('pos_branding', JSON.stringify({ name: name, logo: logo })); } catch (e) {}
        renderHeader('settings');
      }
      if (!hasMethodsUI) { finishBranding(); return; }

      // 2) Legacy path: also save payment methods (only if the DOM section still exists)
      api.withFailureHandler(function(err) { loader(false); showToast(err.message, true); })
        .withSuccessHandler(function() {
          // 3) Re-fetch fresh methods so newly inserted rows pick up their auto-increment IDs
          api.withSuccessHandler(function(fresh) {
            state.paymentMethods = fresh || methods;
            renderPaymentMethods();
            finishBranding();
          }).withFailureHandler(function() {
            state.paymentMethods = methods;
            renderPaymentMethods();
            finishBranding();
          }).getPaymentMethods();
        }).savePaymentMethods(methods);
    }).updateCompanySettings({
      // Legacy keys (kept so older callsites still see them on /api/settings GET)
      name: name, taxNumber: taxNum, logo: logo,
      // V5.7.9 — canonical keys matching what /api/auth/initial reads
      CompanyName: name, TaxNumber: taxNum,
      CompanyPhone: phone, CompanyEmail: email,
      // v6.20.0 — tax configuration keys (persisted to settings table)
      SalesTaxName: salesTaxName,
      VATRate: vatRate,
      NewProductsTaxInclusive: newProdIncl ? '1' : '0',
      // Cashier permission: manager approval required to void an invoice.
      RequireManagerApprovalForVoid: requireVoidApproval ? '1' : '0'
    });
};

// =========================================
// Developer zone — DB reset
// =========================================
window.applyDeveloperVisibility = function() {
  var devZone = q('#devZone');
  if (!devZone) return;
  if (state.isDeveloper) devZone.classList.remove('hidden');
  else devZone.classList.add('hidden');
};

// V5.7.12 — section-icons (Font Awesome) per category for the reset-db modal
var RDB_SECTION_ICONS = {
  sales: 'fa-cash-register',
  shifts: 'fa-clock',
  inventory: 'fa-boxes-stacked',
  inv_items: 'fa-cubes',
  menu: 'fa-utensils',
  recipes: 'fa-mortar-pestle',
  purchases: 'fa-truck-loading',
  expenses: 'fa-receipt',
  custody: 'fa-wallet',
  accounting: 'fa-calculator',
  tax: 'fa-percent',
  transactions: 'fa-paper-plane',
  customers: 'fa-user-friends',
  suppliers: 'fa-truck',
  audit: 'fa-clipboard-list',
  channels: 'fa-store',
  payment_methods: 'fa-credit-card',
  discounts: 'fa-tags',
  price_lists: 'fa-tag'
};

window.openResetDb = function() {
  q('#rdbPass').value = '';
  q('#rdbConfirm').value = '';
  // Render placeholder while sections load
  q('#rdbSectionChecks').innerHTML = '<div style="grid-column:1/-1;text-align:center;color:#94a3b8;padding:12px;">جاري تحميل قائمة الأقسام...</div>';
  openGlassModal('#modalResetDb');

  // Fetch the section list from the server (so it auto-syncs when new sections are added backend-side)
  fetch('/api/auth/reset-db/sections', {
    headers: { 'Authorization': 'Bearer ' + (localStorage.getItem('pos_token') || '') }
  })
    .then(function(r){ return r.json(); })
    .then(function(data) {
      var sections = (data && data.sections) || [];
      if (!sections.length) {
        q('#rdbSectionChecks').innerHTML = '<div style="grid-column:1/-1;text-align:center;color:#dc2626;padding:12px;">تعذّر تحميل الأقسام</div>';
        return;
      }
      q('#rdbSectionChecks').innerHTML = sections.map(function(sec) {
        var icon = RDB_SECTION_ICONS[sec.key] || 'fa-folder';
        var tableHint = (sec.tables || []).slice(0, 3).join(', ') + (sec.tables && sec.tables.length > 3 ? '…' : '');
        return '<label class="rdb-section-check" style="display:flex;align-items:flex-start;gap:8px;background:#fff;border:1.5px solid #e2e8f0;border-radius:10px;padding:10px 12px;cursor:pointer;transition:all 0.15s;">' +
                 '<input type="checkbox" class="rdb-sec-cb" data-key="' + sec.key + '" style="margin-top:3px;flex-shrink:0;width:16px;height:16px;cursor:pointer;">' +
                 '<div style="flex:1;min-width:0;">' +
                   '<div style="font-weight:700;color:#0f172a;font-size:12.5px;display:flex;align-items:center;gap:6px;">' +
                     '<i class="fas ' + icon + '" style="color:#dc2626;width:14px;"></i>' +
                     '<span>' + sec.label + '</span>' +
                   '</div>' +
                   '<div style="font-size:10px;color:#94a3b8;font-family:monospace;margin-top:3px;direction:ltr;text-align:left;">' + tableHint + '</div>' +
                 '</div>' +
               '</label>';
      }).join('');
      // Hover/checked styles
      qs('.rdb-section-check').forEach(function(label) {
        var cb = label.querySelector('.rdb-sec-cb');
        cb.addEventListener('change', function() {
          if (cb.checked) {
            label.style.borderColor = '#dc2626';
            label.style.background = '#fef2f2';
          } else {
            label.style.borderColor = '#e2e8f0';
            label.style.background = '#fff';
          }
        });
      });
    })
    .catch(function() {
      q('#rdbSectionChecks').innerHTML = '<div style="grid-column:1/-1;text-align:center;color:#dc2626;padding:12px;">فشل تحميل الأقسام — تحقق من الاتصال</div>';
    });
};

// V5.7.12 — Bulk select/deselect helper
window.rdbSelectAll = function(checked) {
  qs('.rdb-sec-cb').forEach(function(cb) {
    cb.checked = !!checked;
    // Trigger the change handler so the visual highlight updates
    cb.dispatchEvent(new Event('change'));
  });
};

window.confirmResetDb = function() {
  var pass = q('#rdbPass').value;
  var conf = q('#rdbConfirm').value;
  if (!pass) return showToast('كلمة المرور مطلوبة', true);
  if (conf !== 'YES_RESET_ALL_DATA') return showToast('نص التأكيد غير صحيح', true);

  // V5.7.12 — collect the selected sections
  var selected = [];
  qs('.rdb-sec-cb').forEach(function(cb) {
    if (cb.checked) selected.push(cb.dataset.key);
  });
  if (!selected.length) return showToast('اختر قسماً واحداً على الأقل', true);

  glassConfirm(
    'تأكيد نهائي',
    '⚠️ سيتم مسح ' + selected.length + ' قسم/أقسام. لا يمكن التراجع! هل أنت متأكد؟',
    { danger: true, okText: 'نعم، نفّذ المسح' }
  ).then(function(ok) {
    if (!ok) return;
    loader(true);
    api.withFailureHandler(function(err) { loader(false); showToast(err.message, true); })
       .withSuccessHandler(function(r) {
          loader(false);
          if (r && r.success) {
            closeGlassModal('#modalResetDb');
            var msg = 'تم مسح ' + (r.wiped || []).length + ' جدول من ' + selected.length + ' قسم. ';
            if (r.failed && r.failed.length) msg += '(' + r.failed.length + ' جدول لم يكن موجوداً)';
            showToast(msg + ' — جاري إعادة التحميل...');
            try {
              localStorage.removeItem('pos_menu_cache');
              localStorage.removeItem('pos_branding');
              localStorage.removeItem('pos_active_shift_id');
            } catch (e) {}
            setTimeout(function() { window.location.reload(); }, 1800);
          } else {
            showToast((r && r.error) || 'فشلت عملية المسح', true);
          }
       }).resetDatabase({
          confirm: conf,
          doubleConfirm: 'I_UNDERSTAND_DATA_WILL_BE_LOST',
          username: state.user,
          password: pass,
          sections: selected
        });
  });
};
