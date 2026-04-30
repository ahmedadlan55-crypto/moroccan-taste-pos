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
      CompanyPhone: phone, CompanyEmail: email
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

window.openResetDb = function() {
  q('#rdbPass').value = '';
  q('#rdbConfirm').value = '';
  openGlassModal('#modalResetDb');
};

window.confirmResetDb = function() {
  var pass = q('#rdbPass').value;
  var conf = q('#rdbConfirm').value;
  if (!pass) return showToast('كلمة المرور مطلوبة', true);
  if (conf !== 'YES_RESET_ALL_DATA') return showToast('نص التأكيد غير صحيح', true);

  glassConfirm('تأكيد نهائي', '⚠️ هل أنت متأكد تماماً من تصفير قاعدة البيانات؟ لا يمكن التراجع!', { danger: true, okText: 'نعم، صفّر الآن' }).then(function(ok) {
    if (!ok) return;
    loader(true);
    api.withFailureHandler(function(err) { loader(false); showToast(err.message, true); })
       .withSuccessHandler(function(r) {
          loader(false);
          if (r && r.success) {
            closeGlassModal('#modalResetDb');
            showToast('تم تصفير قاعدة البيانات بنجاح. سيتم إعادة تحميل الصفحة...');
            try {
              localStorage.removeItem('pos_menu_cache');
              localStorage.removeItem('pos_branding');
              localStorage.removeItem('pos_active_shift_id');
            } catch (e) {}
            setTimeout(function() { window.location.reload(); }, 1500);
          } else {
            showToast((r && r.error) || 'فشلت عملية التصفير', true);
          }
       }).resetDatabase({ confirm: conf, username: state.user, password: pass });
  });
};
