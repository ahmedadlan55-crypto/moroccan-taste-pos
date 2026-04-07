/**
 * POS page logic — cart, menu, checkout, shifts, receipt, glass modals
 * Standalone — uses /shared/common.js + /shared/auth.js + /shared/api-bridge.js
 */

// ─── Boot ───
document.addEventListener('DOMContentLoaded', function() {
  if (!requireAuth()) return;
  // Release the visibility gate immediately — auth confirmed
  document.body.classList.add('authenticated');
  restoreState();

  // 1. Show cached menu instantly for fast first paint
  try {
    var cached = localStorage.getItem('pos_menu_cache');
    if (cached) {
      var c = JSON.parse(cached);
      if (c.menu && c.menu.length && (Date.now() - c.ts) < 3600000) {
        state.menu = c.menu;
        state.categories = [...new Set(c.menu.map(function(i) { return i.category; }))];
      }
    }
  } catch (e) {}

  // 2. Render header + initial UI
  renderHeader('pos', { showShift: true });
  applyLang();
  translateUI();
  renderPayButtons();
  renderMenuGrid();
  updateCart();
  updateShiftUI();

  // 3. Refresh branding (logo + name) from server
  if (typeof refreshBrandingFromServer === 'function') {
    refreshBrandingFromServer(function() { renderHeader('pos', { showShift: true }); });
  }

  // 4. Pull latest data from server
  loader(true);
  api.withSuccessHandler(function(res) {
    loader(false);
    if (!res || res.error) {
      glassToast((res && res.error) || 'فشل تحميل البيانات', true);
      return;
    }
    state.settings = res.settings || state.settings;
    state.kitaFeeRate = Number(res.kitaFeeRate) || 0;
    state.paymentMethods = res.paymentMethods || [];
    state.menu = res.menu || [];
    state.categories = [...new Set(state.menu.map(function(i) { return i.category; }))];
    state.activeShiftId = res.activeShiftId || '';

    try { localStorage.setItem('pos_menu_cache', JSON.stringify({ ts: Date.now(), menu: state.menu })); } catch (e) {}
    saveState();

    renderPayButtons();
    renderMenuGrid();
    updateCart();
    updateShiftUI();
    renderHeader('pos', { showShift: true });
  }).withFailureHandler(function(err) {
    loader(false);
    glassToast(err.message || 'تعذر الاتصال بالخادم', true);
  }).getInitialAppData(state.user);
});

window.onLangChange = function() {
  renderPayButtons();
  renderMenuGrid();
  updateCart();
  updateShiftUI();
  renderHeader('pos', { showShift: true });
};

// =========================================
// Glass Modal helpers (replace native confirm/alert)
// =========================================
window.openGlassModal = function(id) {
  var m = q(id);
  if (!m) return;
  m.classList.remove('hidden');
  // Force reflow before adding 'show' so the transition runs
  void m.offsetWidth;
  m.classList.add('show');
};
window.closeGlassModal = function(id, result) {
  var m = q(id);
  if (!m) return;
  m.classList.remove('show');
  setTimeout(function() {
    m.classList.add('hidden');
    // If a confirm callback is waiting, fire it with the result
    if (id === '#modalGlassConfirm' && typeof state._gcResolve === 'function') {
      var cb = state._gcResolve;
      state._gcResolve = null;
      cb(!!result);
    }
  }, 250);
};

// glassConfirm('عنوان', 'رسالة', { okText, cancelText, danger }) → Promise<boolean>
window.glassConfirm = function(title, message, opts) {
  opts = opts || {};
  var t = q('#gcTitle');
  var m = q('#gcMessage');
  var actions = q('#gcActions');
  if (t) t.innerHTML = '<i class="fas ' + (opts.danger ? 'fa-exclamation-triangle' : 'fa-question-circle') + '"></i> ' + title;
  if (m) m.textContent = message;
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

// glassAlert('عنوان', 'رسالة', { danger }) → Promise<void>
window.glassAlert = function(title, message, opts) {
  opts = opts || {};
  var t = q('#gcTitle');
  var m = q('#gcMessage');
  var actions = q('#gcActions');
  if (t) t.innerHTML = '<i class="fas ' + (opts.danger ? 'fa-exclamation-circle' : 'fa-info-circle') + '"></i> ' + title;
  if (m) m.textContent = message;
  if (actions) actions.innerHTML = '<button class="btn btn-primary" onclick="closeGlassModal(\'#modalGlassConfirm\', true)" style="flex:1;">حسناً</button>';
  return new Promise(function(resolve) {
    state._gcResolve = resolve;
    openGlassModal('#modalGlassConfirm');
  });
};

// Toast (uses common.js showToast underneath)
window.glassToast = function(msg, isError) { showToast(msg, isError); };

// =========================================
// Menu grid — explicit +/- on each product
// =========================================
window.setPosCat = function(cat) {
  state.activeCat = cat;
  renderMenuGrid();
};

window.renderMenuGrid = function() {
  var catTabs = q('#posCatTabs');
  if (!catTabs) return;

  var catHtml = '<div class="cat-pill ' + (!state.activeCat ? 'active' : '') + '" onclick="setPosCat(\'\')">' + t('allItems') + '</div>';
  state.categories.forEach(function(c) {
    catHtml += '<div class="cat-pill ' + (state.activeCat === c ? 'active' : '') + '" onclick="setPosCat(\'' + c + '\')">' + c + '</div>';
  });
  catTabs.innerHTML = catHtml;

  var searchInput = q('#posSearchInput');
  var searchTerm = searchInput ? searchInput.value.toLowerCase() : '';

  var list = (state.menu || []).filter(function(i) { return i.active; });
  if (state.activeCat) list = list.filter(function(i) { return i.category === state.activeCat; });
  if (searchTerm) list = list.filter(function(i) {
    return (i.name || '').toLowerCase().includes(searchTerm) || String(i.id || '').toLowerCase().includes(searchTerm);
  });

  var h = '';
  if (!list.length) {
    h = '<div style="grid-column:1/-1;text-align:center;padding:50px 20px;color:#94a3b8;"><i class="fas fa-box-open" style="font-size:54px;margin-bottom:14px;display:block;opacity:0.35;"></i><div style="font-weight:700;">لا توجد منتجات</div></div>';
  } else {
    list.forEach(function(i) {
      var inCart = state.cart.find(function(c) { return c.id === i.id; });
      var qty = inCart ? inCart.qty : 0;
      var isSel = !!inCart;
      var lowStock = i.stock <= i.minStock;
      var safeJson = JSON.stringify(i).replace(/'/g, '&#39;');
      h += '<div class="pos-item ' + (isSel ? 'selected' : '') + '">' +
        '<div class="pos-item-stock ' + (lowStock ? 'low' : '') + '">' + i.stock + '</div>' +
        '<div>' +
          '<div class="pos-item-name">' + (i.name || '') + '</div>' +
          '<div class="pos-item-price">' + formatVal(i.price) + '</div>' +
        '</div>' +
        '<div class="pos-item-actions">' +
          '<button class="qty-btn" ' + (qty <= 0 ? 'disabled' : '') + ' onclick="decFromCart(\'' + i.id + '\')" aria-label="تقليل">−</button>' +
          '<div class="qty-display">' + qty + '</div>' +
          '<button class="qty-btn add" onclick=\'addToCart(' + safeJson + ')\' aria-label="إضافة">+</button>' +
        '</div>' +
      '</div>';
    });
  }
  q('#posItemsGrid').innerHTML = h;
};

// =========================================
// Cart
// =========================================
window.addToCart = function(item) {
  var found = state.cart.find(function(c) { return c.id === item.id; });
  if (found) {
    found.qty++;
  } else {
    state.cart.push(Object.assign({}, item, { qty: 1, basePrice: item.price }));
  }
  updateCart();
};

window.decFromCart = function(itemId) {
  var idx = state.cart.findIndex(function(c) { return c.id === itemId; });
  if (idx === -1) return;
  state.cart[idx].qty -= 1;
  if (state.cart[idx].qty <= 0) state.cart.splice(idx, 1);
  updateCart();
};

window.modQty = function(idx, delta) {
  state.cart[idx].qty += delta;
  if (state.cart[idx].qty <= 0) state.cart.splice(idx, 1);
  updateCart();
};

window.editCartPrice = function(idx, newPrice) {
  state.cart[idx].price = Number(newPrice) || 0;
  updateCart();
};

window.removeCartItem = function(idx) {
  state.cart.splice(idx, 1);
  updateCart();
};

window.clearCart = function() {
  if (!state.cart.length) return;
  glassConfirm('تفريغ السلة', 'هل تريد إزالة جميع الأصناف من السلة؟', { danger: true, okText: 'نعم، أفرغ' }).then(function(ok) {
    if (!ok) return;
    state.cart = [];
    state.currentDiscount = { name: '', amount: 0 };
    updateCart();
  });
};

window.updateCart = function() {
  var payInput = q('#posPayMethod');
  var payMethod = payInput ? payInput.value : 'Cash';
  var subtotal = 0;

  if (payMethod !== 'Kita') {
    state.cart.forEach(function(c) { c.price = c.basePrice; });
  }

  var h = '';
  state.cart.forEach(function(c, idx) {
    subtotal += c.qty * c.price;
    var priceEditEl = payMethod === 'Kita'
      ? '<input type="number" step="0.01" value="' + c.price + '" class="price-edit-input" onchange="editCartPrice(' + idx + ', this.value)">'
      : formatVal(c.price);

    h += '<div class="cart-item-row">' +
      '<div class="cart-item-info">' +
        '<div class="cart-item-title">' + c.name + '</div>' +
        '<div class="cart-item-total">' + formatVal(c.qty * c.price) + '</div>' +
      '</div>' +
      '<div class="cart-item-actions">' +
        '<div class="qty-control">' +
          '<button class="qty-btn" onclick="modQty(' + idx + ', -1)" aria-label="تقليل">−</button>' +
          '<div class="qty-val">' + c.qty + '</div>' +
          '<button class="qty-btn" onclick="modQty(' + idx + ', 1)" aria-label="زيادة">+</button>' +
        '</div>' +
        '<div class="cart-item-side">' +
          '<span class="cart-item-price-tag">@ ' + priceEditEl + '</span>' +
          '<button class="btn-remove" onclick="removeCartItem(' + idx + ')" aria-label="حذف"><i class="fas fa-trash"></i></button>' +
        '</div>' +
      '</div>' +
    '</div>';
  });

  if (state.cart.length === 0) {
    h = '<div class="cart-empty"><i class="fas fa-shopping-basket"></i><h3>' + t('emptyCart') + '</h3><p>' + t('emptyCartDesc') + '</p></div>';
  }
  q('#cartItemsArea').innerHTML = h;

  if (state.currentDiscount.amount > subtotal) state.currentDiscount.amount = subtotal;
  var afterDiscount = subtotal - state.currentDiscount.amount;

  // Service fee
  var serviceFee = 0;
  var finalTotal = afterDiscount;
  var feeRow = q('#serviceFeeRow');
  var feeInput = q('#serviceFeeInput');
  var selectedPM = (state.paymentMethods || []).find(function(m) { return m.Name === payMethod; });
  var feeRate = selectedPM ? Number(selectedPM.ServiceFeeRate) || 0 : (payMethod === 'Kita' ? state.kitaFeeRate : 0);
  var showFee = payMethod !== 'Split' && payMethod !== 'Cash' && payMethod !== 'Card';

  if (showFee) {
    var manualFee = feeInput ? Number(feeInput.value) : 0;
    if (manualFee > 0) {
      serviceFee = manualFee;
    } else if (feeRate > 0) {
      serviceFee = afterDiscount * (feeRate / 100);
    }
    finalTotal = afterDiscount + serviceFee;
    if (feeRow) feeRow.classList.remove('hidden');
    var isEn = state.lang === 'en';
    var feeLabel = q('#serviceFeeLabel');
    if (feeLabel) feeLabel.textContent = (isEn ? 'Service Fee' : 'رسوم الخدمة') + ' (' + (selectedPM ? (isEn ? selectedPM.Name : selectedPM.NameAR) : payMethod) + '):';
    q('#serviceFeeText').innerText = formatVal(serviceFee) + (feeRate > 0 && !manualFee ? ' (' + feeRate + '%)' : '');
    if (feeInput && !manualFee && feeRate > 0) feeInput.placeholder = formatVal(serviceFee) + ' (تلقائي ' + feeRate + '%)';
  } else {
    if (feeRow) feeRow.classList.add('hidden');
    if (feeInput) { feeInput.value = ''; feeInput.placeholder = '0'; }
  }

  // Split
  var splitPanel = q('#splitPayPanel');
  if (splitPanel) splitPanel.classList.toggle('hidden', payMethod !== 'Split');
  if (payMethod === 'Split') renderSplitFields(afterDiscount);

  q('#cartSubtotalText').innerText = formatVal(subtotal);
  q('#cartDiscText').innerText = formatVal(state.currentDiscount.amount);
  q('#cartFinalTotal').innerText = formatVal(payMethod === 'Split' ? afterDiscount : finalTotal) + ' ' + state.settings.currency;

  if (q('#mobCartCount')) {
    var mobileCount = state.cart.reduce(function(s, c) { return s + c.qty; }, 0);
    q('#mobCartCount').innerText = mobileCount;
    q('#mobCartTotal').innerText = formatVal(finalTotal) + ' ' + state.settings.currency;
  }

  // Highlight active pay method
  qs('.pay-btn').forEach(function(btn) { btn.classList.remove('active'); });
  var activeBtn = q('#payBtn' + payMethod);
  if (activeBtn) activeBtn.classList.add('active');

  // Re-render the menu so + buttons reflect the new qty
  renderMenuGrid();
};

window.toggleMobileCart = function() {
  var cartPanel = q('#mobileCartPanel');
  if (cartPanel) cartPanel.classList.toggle('open');
};

window.setPayMethod = function(m) {
  q('#posPayMethod').value = m;
  var feeInput = q('#serviceFeeInput');
  if (feeInput) feeInput.value = '';
  updateCart();
};
window.applyManualServiceFee = function() { updateCart(); };

// =========================================
// Payment buttons (always include Split as a feature)
// =========================================
window.renderPayButtons = function() {
  var container = q('#payMethodsContainer');
  if (!container) return;
  var active = (state.paymentMethods || []).filter(function(m) {
    if (m.IsActive === false || m.IsActive === 'FALSE') return false;
    return String(m.Name || '').toLowerCase() !== 'split';
  });
  if (!active.length) {
    active = [
      { Name: 'Cash', NameAR: 'كاش', Icon: 'fa-money-bill-wave' },
      { Name: 'Card', NameAR: 'مدى', Icon: 'fa-credit-card' },
      { Name: 'Kita', NameAR: 'كيتا', Icon: 'fa-calculator' }
    ];
  }
  var isEn = state.lang === 'en';
  var defaultMethod = active[0].Name;
  var hiddenInput = '<input type="hidden" id="posPayMethod" value="' + defaultMethod + '">';

  var html = active.map(function(m) {
    var label = isEn ? (m.Name || m.NameAR) : (m.NameAR || m.Name);
    return '<button class="pay-btn' + (m.Name === defaultMethod ? ' active' : '') + '" id="payBtn' + m.Name + '" onclick="setPayMethod(\'' + m.Name + '\')"><i class="fas ' + (m.Icon || 'fa-money-bill') + '"></i> <span>' + label + '</span></button>';
  }).join('');

  // Always-on Split feature
  html += '<button class="pay-btn" id="payBtnSplit" onclick="setPayMethod(\'Split\')" title="' + (isEn ? 'Split payment' : 'تجزئة الدفع') + '"><i class="fas fa-divide"></i> <span>' + (isEn ? 'Split' : 'تجزئة') + '</span></button>';

  container.innerHTML = html + hiddenInput;
};

window.renderSplitFields = function(total) {
  var container = q('#splitFields');
  if (!container) return;
  var isEn = state.lang === 'en';
  var methods = (state.paymentMethods || []).filter(function(m) {
    return m.IsActive !== false && m.IsActive !== 'FALSE' && String(m.Name || '').toLowerCase() !== 'split';
  });
  container.innerHTML = methods.map(function(m) {
    var label = isEn ? (m.Name || m.NameAR) : (m.NameAR || m.Name);
    return '<div><label>' + label + '</label><input type="number" step="0.01" class="form-control split-input" data-method="' + m.Name + '" placeholder="0.00" value="" oninput="calcSplitRemaining()"></div>';
  }).join('');
  q('#splitRemaining').textContent = formatVal(total);
};

window.calcSplitRemaining = function() {
  var sub = state.cart.reduce(function(s, c) { return s + c.qty * c.price; }, 0);
  var afterDiscount = sub - state.currentDiscount.amount;
  var paid = 0;
  qs('.split-input').forEach(function(el) { paid += Number(el.value) || 0; });
  var rem = afterDiscount - paid;
  var el = q('#splitRemaining');
  if (el) {
    el.textContent = formatVal(rem);
    el.style.color = Math.abs(rem) < 0.01 ? '#16a34a' : '#ef4444';
  }
};

// =========================================
// Discount modal
// =========================================
window.openDiscountModal = function() {
  if (!state.cart.length) return glassToast(t('emptyCart'), true);
  loader();
  api.withSuccessHandler(function(discs) {
    loader(false);
    discs = discs || [];
    var h = '';
    if (!discs.length) h = '<p style="text-align:center;color:#94a3b8;padding:20px;">لا توجد خصومات متاحة</p>';
    discs.forEach(function(d) {
      var valStr = d.type === 'PERCENT' ? d.value + '%' : d.value + ' ' + state.settings.currency;
      h += '<div class="card" style="margin-bottom:12px;cursor:pointer;padding:16px;background:rgba(255,255,255,0.7);border:1px solid rgba(226,232,240,0.6);border-radius:14px;" onclick="applyDiscount(\'' + d.name + '\',\'' + d.type + '\',' + d.value + ')">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;">' +
          '<h4 style="margin:0;font-weight:800;">' + d.name + '</h4>' +
          '<strong style="color:var(--secondary);font-size:18px;">' + valStr + '</strong>' +
        '</div>' +
      '</div>';
    });
    q('#discModalList').innerHTML = h;
    openGlassModal('#modalDiscount');
  }).getDiscounts();
};

window.applyDiscount = function(name, type, val) {
  var sub = state.cart.reduce(function(s, c) { return s + c.qty * c.price; }, 0);
  var calc = type === 'PERCENT' ? sub * (val / 100) : val;
  state.currentDiscount = { name: name, amount: calc };
  updateCart();
  closeGlassModal('#modalDiscount');
  glassToast('تم تطبيق الخصم');
};

// =========================================
// Checkout
// =========================================
window.doCheckout = function() {
  if (!state.activeShiftId) return glassToast('عذراً، يجب فتح وردية لاستقبال الطلبات.', true);
  if (!state.cart.length) return glassToast(t('emptyCart'), true);

  var sub = state.cart.reduce(function(s, c) { return s + c.qty * c.price; }, 0);
  var afterDiscount = sub - state.currentDiscount.amount;
  var payMethod = q('#posPayMethod').value;

  var serviceFee = 0;
  var totalFinal = afterDiscount;
  var selectedPM = (state.paymentMethods || []).find(function(m) { return m.Name === payMethod; });
  var feeRate = selectedPM ? Number(selectedPM.ServiceFeeRate) || 0 : (payMethod === 'Kita' ? state.kitaFeeRate : 0);
  var feeInput = q('#serviceFeeInput');
  var manualFee = feeInput ? Number(feeInput.value) : 0;

  var splitDetails = null;
  if (payMethod === 'Split') {
    splitDetails = {};
    var totalPaid = 0;
    qs('.split-input').forEach(function(el) {
      var val = Number(el.value) || 0;
      if (val > 0) { splitDetails[el.dataset.method] = val; totalPaid += val; }
    });
    if (Math.abs(totalPaid - afterDiscount) > 0.01) {
      return glassAlert('فرق في التجزئة', 'مجموع التجزئة (' + formatVal(totalPaid) + ') لا يساوي الإجمالي (' + formatVal(afterDiscount) + ')', { danger: true });
    }
    totalFinal = afterDiscount;
  } else if (manualFee > 0) {
    serviceFee = manualFee;
    totalFinal = afterDiscount + serviceFee;
  } else if (feeRate > 0 && payMethod !== 'Cash' && payMethod !== 'Card') {
    serviceFee = afterDiscount * (feeRate / 100);
    totalFinal = afterDiscount + serviceFee;
  }

  var order = {
    items: state.cart,
    total: sub,
    totalFinal: totalFinal,
    paymentMethod: payMethod,
    discountName: state.currentDiscount.name,
    discountAmount: state.currentDiscount.amount,
    kitaServiceFee: serviceFee,
    splitDetails: splitDetails
  };

  var send = function() {
    loader();
    api.withSuccessHandler(function(res) {
      loader(false);
      glassToast('تم حفظ الطلب بنجاح!');
      if (res && res.orderId) printReceipt(res.orderId);
      state.cart = [];
      state.currentDiscount = { name: '', amount: 0 };
      updateCart();
      api.withSuccessHandler(function(m) { state.menu = m || []; renderMenuGrid(); }).getMenu();
    }).withFailureHandler(function(err) {
      loader(false);
      glassToast(err.message || 'فشل حفظ الطلب', true);
    }).saveOrder(order, state.user, state.activeShiftId);
  };

  if (serviceFee > 0) {
    glassConfirm('تأكيد رسوم الخدمة', 'رسوم الخدمة: ' + formatVal(serviceFee) + ' ' + state.settings.currency + '\nالإجمالي: ' + formatVal(totalFinal) + ' ' + state.settings.currency, { okText: 'متابعة' }).then(function(ok) {
      if (ok) send();
    });
  } else {
    send();
  }
};

// =========================================
// Receipt
// =========================================
window.printReceipt = function(orderId) {
  api.withSuccessHandler(function(inv) {
    if (!inv) return;
    var dt = new Date(inv.date);
    var dateStr = dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ' ' + dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    var companyName = (state.settings && state.settings.name) || 'Moroccan Taste';
    var taxNumber = (state.settings && state.settings.taxNumber) || '';
    var currency = (state.settings && state.settings.currency) || 'SAR';
    var totalItems = 0;
    var itemsHtml = '';
    (inv.items || []).forEach(function(i) {
      totalItems += Number(i.qty) || 0;
      itemsHtml += '<tr><td style="text-align:left;font-size:12px;">' + i.name + '</td><td style="text-align:center;">' + i.qty + '</td><td style="text-align:right;">' + formatVal(i.total) + '</td></tr>';
    });
    var netAmount = Number(inv.totalFinal) / 1.15;
    var vatAmount = Number(inv.totalFinal) - netAmount;

    var logoUrl = (state.settings && state.settings.logo) || '';
    var logoTag = logoUrl ? '<div style="text-align:center;margin-bottom:6px;"><img src="' + logoUrl + '" style="max-width:80px;max-height:80px;object-fit:contain;"></div>' : '';
    var h = logoTag +
      '<div style="text-align:center;font-size:18px;font-weight:900;margin-bottom:2px;">' + companyName + '</div>' +
      '<div style="text-align:center;font-size:11px;color:#666;margin-bottom:2px;">Simplified TAX Invoice</div>' +
      '<div style="text-align:center;font-size:11px;color:#666;">فاتورة ضريبية مبسطة</div>' +
      '<div style="text-align:center;font-size:11px;color:#666;margin-bottom:8px;">Tax No: ' + taxNumber + '</div>' +
      '<div style="border-top:1px dashed #999;border-bottom:1px dashed #999;padding:8px 0;margin:8px 0;">' +
        '<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:2px;"><span>ID</span><span style="font-weight:700;">' + inv.orderId + '</span></div>' +
        '<div style="display:flex;justify-content:space-between;font-size:12px;"><span>Date</span><span>' + dateStr + '</span></div>' +
      '</div>' +
      '<table style="width:100%;border-collapse:collapse;margin:8px 0;"><thead><tr style="border-bottom:1px dashed #999;"><th style="text-align:left;font-size:11px;padding:4px 0;">Item</th><th style="text-align:center;font-size:11px;">Qty</th><th style="text-align:right;font-size:11px;">' + currency + '</th></tr></thead><tbody>' + itemsHtml + '</tbody></table>' +
      '<div style="text-align:center;font-size:12px;font-weight:700;border-top:1px dashed #999;padding-top:6px;">Items: ' + totalItems + '</div>' +
      '<table style="width:100%;margin:10px 0;border-collapse:collapse;border-top:1px solid #333;border-bottom:1px solid #333;"><tr>' +
        '<td style="text-align:center;padding:8px;border-left:1px solid #333;"><div style="font-size:10px;font-weight:700;">Total<br>إجمالي</div><div style="font-size:15px;font-weight:900;">' + formatVal(inv.totalFinal) + '</div></td>' +
        '<td style="text-align:center;padding:8px;border-left:1px solid #333;"><div style="font-size:10px;font-weight:700;">Net<br>قبل الضريبة</div><div style="font-size:15px;font-weight:900;">' + netAmount.toFixed(2) + '</div></td>' +
        '<td style="text-align:center;padding:8px;"><div style="font-size:10px;font-weight:700;">VAT 15%<br>الضريبة</div><div style="font-size:15px;font-weight:900;">' + vatAmount.toFixed(2) + '</div></td>' +
      '</tr></table>' +
      '<div style="text-align:center;font-size:11px;color:#666;margin-bottom:4px;">Served by: ' + (inv.username || state.user) + '</div>' +
      '<div id="receiptQR" style="text-align:center;margin:12px auto;width:150px;height:150px;"></div>' +
      '<div style="text-align:center;font-size:10px;color:#999;margin-bottom:4px;">' + inv.orderId + '</div>' +
      '<div style="text-align:center;font-size:11px;color:#666;">شكراً لزيارتكم</div>';

    q('#receiptBox').innerHTML = h;
    state._lastReceipt = { inv: inv, html: h, companyName: companyName, taxNumber: taxNumber };
    openGlassModal('#modalReceipt');

    setTimeout(function() {
      var qrEl = document.getElementById('receiptQR');
      if (qrEl && typeof QRCode !== 'undefined') {
        qrEl.innerHTML = '';
        var tlvBase64 = generateZATCA_TLV(companyName, taxNumber, new Date(inv.date).toISOString(), formatVal(inv.totalFinal), vatAmount.toFixed(2));
        new QRCode(qrEl, { text: tlvBase64, width: 140, height: 140, colorDark: '#000', colorLight: '#fff' });
      }
    }, 200);
  }).getInvoice(orderId);
};

window.generateZATCA_TLV = function(sellerName, vatNumber, timestamp, totalAmount, vatAmount) {
  function utf8Bytes(str) {
    var bytes = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) { bytes.push(0xC0 | (c >> 6)); bytes.push(0x80 | (c & 0x3F)); }
      else if (c < 0x10000) { bytes.push(0xE0 | (c >> 12)); bytes.push(0x80 | ((c >> 6) & 0x3F)); bytes.push(0x80 | (c & 0x3F)); }
      else { bytes.push(0xF0 | (c >> 18)); bytes.push(0x80 | ((c >> 12) & 0x3F)); bytes.push(0x80 | ((c >> 6) & 0x3F)); bytes.push(0x80 | (c & 0x3F)); }
    }
    return bytes;
  }
  function makeTLV(tag, value) {
    var valBytes = utf8Bytes(String(value || ''));
    return [tag, valBytes.length].concat(valBytes);
  }
  var tlv = [];
  tlv = tlv.concat(makeTLV(1, sellerName));
  tlv = tlv.concat(makeTLV(2, vatNumber));
  tlv = tlv.concat(makeTLV(3, timestamp));
  tlv = tlv.concat(makeTLV(4, totalAmount));
  tlv = tlv.concat(makeTLV(5, vatAmount));
  var binary = '';
  for (var i = 0; i < tlv.length; i++) binary += String.fromCharCode(tlv[i]);
  return btoa(binary);
};

window.printReceiptWindow = function() {
  var r = state._lastReceipt;
  if (!r) return;
  var qrCanvas = document.querySelector('#receiptQR canvas');
  var qrImg = qrCanvas ? qrCanvas.toDataURL() : '';
  var w = window.open('', '_blank', 'width=350,height=700');
  if (!w) return;
  w.document.write('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Receipt</title>' +
    '<style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:Arial,sans-serif;padding:8px;width:280px;margin:0 auto;font-size:12px;color:#000;}' +
    'table{width:100%;border-collapse:collapse;}th,td{padding:4px 2px;font-size:11px;}th{text-align:left;border-bottom:1px dashed #000;}' +
    '.center{text-align:center;}.bold{font-weight:700;}.big{font-size:14px;}.line{border-top:1px dashed #000;margin:6px 0;}' +
    '@media print{@page{margin:0;size:80mm auto;}body{padding:4px;width:100%;}}</style></head><body>' +
    ((state.settings && state.settings.logo) ? '<div class="center" style="margin-bottom:6px;"><img src="' + state.settings.logo + '" style="max-width:80px;max-height:80px;"></div>' : '') +
    '<div class="center bold" style="font-size:16px;">' + r.companyName + '</div>' +
    '<div class="center" style="font-size:10px;color:#666;margin-bottom:6px;">Tax: ' + r.taxNumber + '</div>' +
    '<div class="line"></div>' +
    '<div style="display:flex;justify-content:space-between;font-size:11px;margin:4px 0;"><span>ID:</span><span class="bold">' + r.inv.orderId + '</span></div>' +
    '<div style="display:flex;justify-content:space-between;font-size:11px;margin:4px 0;"><span>Date:</span><span>' + new Date(r.inv.date).toLocaleString('en-US') + '</span></div>' +
    '<div class="line"></div><table><tr><th>Item</th><th style="text-align:center;">Qty</th><th style="text-align:right;">SAR</th></tr>');
  (r.inv.items || []).forEach(function(it) {
    w.document.write('<tr><td>' + it.name + '</td><td style="text-align:center;">' + it.qty + '</td><td style="text-align:right;">' + formatVal(it.total) + '</td></tr>');
  });
  w.document.write('</table><div class="line"></div>');
  var net = r.inv.totalFinal / 1.15;
  var vat = r.inv.totalFinal - net;
  w.document.write('<div class="center bold" style="margin:6px 0;">Total: ' + formatVal(r.inv.totalFinal) + ' SAR</div>');
  w.document.write('<div class="center" style="font-size:10px;">Net: ' + net.toFixed(2) + ' | VAT: ' + vat.toFixed(2) + '</div>');
  if (qrImg) w.document.write('<div class="center" style="margin:10px 0;"><img src="' + qrImg + '" width="130" height="130"></div>');
  w.document.write('<div class="center" style="font-size:9px;color:#666;">' + r.inv.orderId + '</div>');
  w.document.write('<div class="center" style="font-size:10px;margin-top:6px;">شكراً لزيارتكم</div></body></html>');
  w.document.close();
  setTimeout(function() { w.print(); }, 400);
};

// =========================================
// Shifts
// =========================================
window.updateShiftUI = function() {
  var badge = q('#shiftBadge');
  if (!badge) return;
  if (state.activeShiftId) {
    badge.innerText = state.activeShiftId;
    badge.className = 'shift-indicator active';
  } else {
    badge.innerText = t('noShift');
    badge.className = 'shift-indicator';
  }
};

window.shiftOpen = function() {
  if (state.activeShiftId) return glassToast('هناك وردية مفتوحة بالفعل', true);
  glassConfirm('فتح وردية', 'هل تريد فتح وردية بيع جديدة للموظف: ' + state.user + '؟', { okText: 'فتح الوردية' }).then(function(ok) {
    if (!ok) return;
    loader(true);
    api.withFailureHandler(function(err) { loader(false); glassToast(err.message, true); })
      .withSuccessHandler(function(res) {
        loader(false);
        if (res.success) {
          state.activeShiftId = res.shiftId;
          saveState();
          updateShiftUI();
          renderHeader('pos', { showShift: true });
          glassToast('تم بدء الوردية بنجاح!');
        } else {
          glassToast(res.error, true);
        }
      }).openShift(state.user);
  });
};

window.shiftCloseStart = function() {
  if (!state.activeShiftId) return glassToast('ليس لديك وردية نشطة حالياً لإغلاقها', true);
  q('#scCash').value = '0';
  q('#scCard').value = '0';
  q('#scKita').value = '0';
  openGlassModal('#modalShiftClose');
};

window.shiftConfirmClose = function() {
  var cash = Number(q('#scCash').value) || 0;
  var card = Number(q('#scCard').value) || 0;
  var kita = Number(q('#scKita').value) || 0;

  loader(true);
  api.withFailureHandler(function(err) { loader(false); glassToast(err.message, true); })
    .withSuccessHandler(function(d) {
      loader(false);
      if (d.error) return glassToast(d.error, true);

      var thCash = Number(d.theoreticalCash) || 0;
      var thCard = Number(d.theoreticalCard) || 0;
      var thKita = Number(d.theoreticalKita) || 0;
      var totalExpected = thCash + thCard + thKita;
      var dCash = cash - thCash, dCard = card - thCard, dKita = kita - thKita;
      var totalDiff = (cash + card + kita) - totalExpected;

      // Block #1: zero amounts entered
      if (totalExpected > 0 && cash === 0 && card === 0 && kita === 0) {
        return showVarianceBlock({ thCash: thCash, thCard: thCard, thKita: thKita, cash: cash, card: card, kita: kita,
          dCash: -thCash, dCard: -thCard, dKita: -thKita, totalDiff: -totalExpected,
          msg: 'لم تُدخل أي مبلغ! المبيعات المتوقعة في النظام هي ' + totalExpected.toFixed(2) + ' SAR. أدخل المبالغ الفعلية في الدرج قبل الإغلاق.'
        });
      }

      // Block #2: variance not zero — REQUIRE review of invoices first
      if (Math.abs(totalDiff) > 0.01) {
        return showVarianceBlock({ thCash: thCash, thCard: thCard, thKita: thKita, cash: cash, card: card, kita: kita,
          dCash: dCash, dCard: dCard, dKita: dKita, totalDiff: totalDiff,
          msg: 'يوجد فرق بين مبالغ الدرج والمبيعات المسجلة. يجب أن يكون الفرق صفراً لإغلاق الوردية. يُرجى مراجعة الفواتير وتصحيح المبالغ ثم المحاولة مجدداً.'
        });
      }

      // All good — final confirm + close
      glassConfirm('تأكيد الإغلاق', 'الفرق متطابق تماماً (0.00). متابعة لإغلاق الوردية؟', { okText: 'إغلاق الوردية', danger: true }).then(function(ok) {
        if (!ok) return;
        loader(true);
        api.withFailureHandler(function(err) { loader(false); glassToast(err.message, true); })
          .withSuccessHandler(function(res) {
            loader(false);
            if (res.success) {
              var closedShiftId = state.activeShiftId;
              state.activeShiftId = '';
              saveState();
              localStorage.removeItem('pos_active_shift_id');
              updateShiftUI();
              renderHeader('pos', { showShift: true });
              closeGlassModal('#modalShiftClose');
              glassToast('تم إغلاق الوردية بنجاح!');
              // Show the report with WhatsApp share
              showShiftReport(closedShiftId, { thCash: thCash, thCard: thCard, thKita: thKita, cash: cash, card: card, kita: kita, orders: Number(d.orderCount) || 0 });
            } else {
              glassToast(res.error, true);
            }
          }).endShiftWithActuals(state.activeShiftId, state.user, cash, card, kita);
      });
    }).getShiftDataForClosing(state.activeShiftId);
};

// Variance block — shows the breakdown and refuses to close
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

// Shift report with WhatsApp share
function showShiftReport(shiftId, d) {
  var fmt = function(v) { return Number(v).toFixed(2); };
  var totalExpected = d.thCash + d.thCard + d.thKita;
  var totalActual   = d.cash + d.card + d.kita;
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
    thCash: d.thCash, thCard: d.thCard, thKita: d.thKita,
    cash: d.cash, card: d.card, kita: d.kita,
    totalExpected: totalExpected, totalActual: totalActual
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

// Build a plain-text version of the report and open WhatsApp
window.shareShiftReportWhatsApp = function() {
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
  // Opens WhatsApp letting the user pick any contact
  window.open('https://wa.me/?text=' + text, '_blank');
};

// Print the shift report in a new window
window.printShiftReport = function() {
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
};
