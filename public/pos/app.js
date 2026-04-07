/**
 * POS page logic — cart, menu, checkout, shifts, receipt
 * Standalone — uses /shared/common.js + /shared/auth.js + /shared/api-bridge.js
 */

// ─── Boot ───
document.addEventListener('DOMContentLoaded', function() {
  // 1. Auth check
  if (!requireAuth()) return;

  // 2. Restore cached state
  restoreState();

  // 3. Load cached menu instantly for fast paint
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

  // 4. Render header + initial UI
  renderHeader('pos', { showShift: true });
  applyLang();
  translateUI();
  renderPayButtons();
  renderMenuGrid();
  updateCart();
  updateShiftUI();

  // 5. Refresh from server (latest menu, settings, payment methods, shift)
  loader(true);
  api.withSuccessHandler(function(res) {
    loader(false);
    if (!res || res.error) {
      showToast((res && res.error) || 'فشل تحميل البيانات', true);
      return;
    }
    state.settings = res.settings || state.settings;
    state.kitaFeeRate = Number(res.kitaFeeRate) || 0;
    state.paymentMethods = res.paymentMethods || [];
    state.menu = res.menu || [];
    state.categories = [...new Set(state.menu.map(function(i) { return i.category; }))];
    state.activeShiftId = res.activeShiftId || '';

    // Cache for next visit
    try { localStorage.setItem('pos_menu_cache', JSON.stringify({ ts: Date.now(), menu: state.menu })); } catch (e) {}
    saveState();

    renderPayButtons();
    renderMenuGrid();
    updateCart();
    updateShiftUI();
    renderHeader('pos', { showShift: true });
  }).withFailureHandler(function(err) {
    loader(false);
    showToast(err.message || 'تعذر الاتصال بالخادم', true);
  }).getInitialAppData(state.user);
});

// Re-render UI on language change
window.onLangChange = function() {
  renderPayButtons();
  renderMenuGrid();
  updateCart();
  updateShiftUI();
  renderHeader('pos', { showShift: true });
};

// =========================================
// Menu grid
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
  if (searchTerm) list = list.filter(function(i) { return (i.name || '').toLowerCase().includes(searchTerm); });

  var h = '';
  if (!list.length) {
    h = '<div style="grid-column:1/-1;text-align:center;padding:40px 20px;color:#94a3b8;"><i class="fas fa-box-open" style="font-size:48px;margin-bottom:10px;display:block;opacity:0.3;"></i>لا توجد منتجات</div>';
  } else {
    list.forEach(function(i) {
      var isSel = state.cart.some(function(c) { return c.id === i.id; });
      var lowStock = i.stock <= i.minStock;
      h += '<div class="pos-item ' + (isSel ? 'selected' : '') + '" onclick=\'addToCart(' + JSON.stringify(i).replace(/'/g, '&#39;') + ')\'>' +
        '<div class="pos-item-stock ' + (lowStock ? 'low' : '') + '">' + i.stock + '</div>' +
        '<div class="pos-item-name">' + i.name + '</div>' +
        '<div class="pos-item-price">' + formatVal(i.price) + '</div>' +
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
  state.cart = [];
  state.currentDiscount = { name: '', amount: 0 };
  updateCart();
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
          '<button class="qty-btn" onclick="modQty(' + idx + ', 1)">+</button>' +
          '<div class="qty-val">' + c.qty + '</div>' +
          '<button class="qty-btn" onclick="modQty(' + idx + ', -1)">-</button>' +
        '</div>' +
        '<div>' +
          '<span style="font-size:12px;font-weight:bold;color:var(--text-light);margin-inline-end:10px;">@ ' + priceEditEl + '</span>' +
          '<button class="btn btn-danger" style="padding:6px 12px;border-radius:10px;" onclick="removeCartItem(' + idx + ')"><i class="fas fa-trash"></i></button>' +
        '</div>' +
      '</div>' +
    '</div>';
  });

  if (state.cart.length === 0) {
    h = '<div class="cart-empty"><i class="fas fa-shopping-basket"></i><h3>' + t('emptyCart') + '</h3><p style="font-size:14px;margin-top:5px;">' + t('emptyCartDesc') + '</p></div>';
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

  // Mobile cart counter
  if (q('#mobCartCount')) {
    var mobileCount = state.cart.reduce(function(s, c) { return s + c.qty; }, 0);
    q('#mobCartCount').innerText = mobileCount;
    q('#mobCartTotal').innerText = formatVal(finalTotal) + ' ' + state.settings.currency;
  }

  // Active pay method
  qs('.pay-btn').forEach(function(btn) { btn.classList.remove('active'); });
  var activeBtn = q('#payBtn' + payMethod);
  if (activeBtn) activeBtn.classList.add('active');

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
// Payment buttons
// =========================================
window.renderPayButtons = function() {
  var container = q('#payMethodsContainer');
  if (!container) return;
  var active = (state.paymentMethods || []).filter(function(m) { return m.IsActive !== false && m.IsActive !== 'FALSE'; });
  if (!active.length) {
    // Fallback: hardcoded methods
    active = [
      { Name: 'Cash', NameAR: 'كاش', Icon: 'fa-money-bill-wave' },
      { Name: 'Card', NameAR: 'مدى', Icon: 'fa-credit-card' },
      { Name: 'Kita', NameAR: 'كيتا', Icon: 'fa-calculator' }
    ];
  }
  var isEn = state.lang === 'en';
  var hiddenInput = '<input type="hidden" id="posPayMethod" value="' + active[0].Name + '">';
  container.innerHTML = active.map(function(m) {
    var label = isEn ? (m.Name || m.NameAR) : (m.NameAR || m.Name);
    return '<button class="pay-btn' + (m.Name === active[0].Name ? ' active' : '') + '" id="payBtn' + m.Name + '" onclick="setPayMethod(\'' + m.Name + '\')"><i class="fas ' + (m.Icon || 'fa-money-bill') + '"></i> <span>' + label + '</span></button>';
  }).join('') + hiddenInput;
};

window.renderSplitFields = function(total) {
  var container = q('#splitFields');
  if (!container) return;
  var isEn = state.lang === 'en';
  var methods = (state.paymentMethods || []).filter(function(m) { return m.IsActive !== false && m.IsActive !== 'FALSE' && m.Name !== 'Split'; });
  container.innerHTML = methods.map(function(m) {
    var label = isEn ? (m.Name || m.NameAR) : (m.NameAR || m.Name);
    return '<div style="margin-bottom:4px;"><label style="font-size:12px;font-weight:600;">' + label + '</label><input type="number" step="0.01" class="form-control split-input" data-method="' + m.Name + '" placeholder="0.00" value="" oninput="calcSplitRemaining()" style="padding:8px;font-size:14px;"></div>';
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
  if (!state.cart.length) return showToast(t('emptyCart'), true);
  loader();
  api.withSuccessHandler(function(discs) {
    loader(false);
    discs = discs || [];
    var h = '';
    if (!discs.length) h = '<p style="text-align:center;">لا توجد خصومات متاحة</p>';
    discs.forEach(function(d) {
      var valStr = d.type === 'PERCENT' ? d.value + '%' : d.value + ' ' + state.settings.currency;
      h += '<div class="card" style="margin-bottom:15px;cursor:pointer;" onclick="applyDiscount(\'' + d.name + '\',\'' + d.type + '\',' + d.value + ')">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;">' +
          '<h4 style="margin:0;">' + d.name + '</h4>' +
          '<strong style="color:var(--secondary);font-size:18px;">' + valStr + '</strong>' +
        '</div>' +
      '</div>';
    });
    q('#discModalList').innerHTML = h;
    openModal('#modalDiscount');
  }).getDiscounts();
};

window.applyDiscount = function(name, type, val) {
  var sub = state.cart.reduce(function(s, c) { return s + c.qty * c.price; }, 0);
  var calc = type === 'PERCENT' ? sub * (val / 100) : val;
  state.currentDiscount = { name: name, amount: calc };
  updateCart();
  closeModal('#modalDiscount');
  showToast('تم تطبيق الخصم');
};

// =========================================
// Checkout
// =========================================
window.doCheckout = function() {
  if (!state.activeShiftId) return showToast('عذراً، يجب فتح وردية لاستقبال الطلبات.', true);
  if (!state.cart.length) return showToast(t('emptyCart'), true);

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
      return showToast('مجموع التجزئة (' + formatVal(totalPaid) + ') لا يساوي الإجمالي (' + formatVal(afterDiscount) + ')', true);
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

  if (serviceFee > 0) {
    if (!confirm('رسوم الخدمة: ' + formatVal(serviceFee) + ' ' + state.settings.currency + '\nالإجمالي: ' + formatVal(totalFinal) + ' ' + state.settings.currency + '\n\nمتابعة؟')) return;
  }

  loader();
  api.withSuccessHandler(function(res) {
    loader(false);
    showToast('تم حفظ الطلب بنجاح!');
    if (res && res.orderId) printReceipt(res.orderId);
    clearCart();
    api.withSuccessHandler(function(m) { state.menu = m || []; renderMenuGrid(); }).getMenu();
  }).withFailureHandler(function(err) {
    loader(false);
    showToast(err.message || 'فشل حفظ الطلب', true);
  }).saveOrder(order, state.user, state.activeShiftId);
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
      itemsHtml += '<tr><td style="text-align:left;font-size:12px;">' + i.name + '</td><td style="text-align:center;">' + i.qty + '@</td><td style="text-align:right;">' + formatVal(i.total) + '</td></tr>';
    });
    var netAmount = Number(inv.totalFinal) / 1.15;
    var vatAmount = Number(inv.totalFinal) - netAmount;
    var payLabel = { 'Cash': 'Cash | كاش', 'Card': 'Mada | مدى', 'Kita': 'Kita | كيتا' };

    var h = '<div style="text-align:center;font-size:18px;font-weight:900;margin-bottom:2px;">' + companyName + '</div>' +
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
      '<div style="text-align:center;font-size:13px;margin:8px 0;"><span style="font-weight:700;">' + (payLabel[inv.payment] || inv.payment) + '</span> <span style="font-weight:900;font-size:15px;">' + formatVal(inv.totalFinal) + '</span></div>' +
      '<div style="text-align:center;font-size:11px;color:#666;margin-bottom:4px;">Served by: ' + (inv.username || state.user) + '</div>' +
      (inv.discountAmount > 0 ? '<div style="text-align:center;font-size:12px;color:#ef4444;">Discount: -' + formatVal(inv.discountAmount) + '</div>' : '') +
      '<div id="receiptQR" style="text-align:center;margin:12px auto;width:150px;height:150px;"></div>' +
      '<div style="text-align:center;font-size:10px;color:#999;margin-bottom:4px;">' + inv.orderId + '</div>' +
      '<div style="text-align:center;font-size:11px;color:#666;">شكراً لزيارتكم</div>';

    q('#receiptBox').innerHTML = h;
    state._lastReceipt = { inv: inv, html: h, companyName: companyName, taxNumber: taxNumber };
    openModal('#modalReceipt');

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
  if (state.activeShiftId) return showToast('هناك وردية مفتوحة بالفعل', true);
  if (!confirm('هل أنت متأكد من فتح وردية بيع جديدة للموظف: ' + state.user + '؟')) return;

  loader(true);
  api.withFailureHandler(function(err) { loader(false); showToast(err.message, true); })
    .withSuccessHandler(function(res) {
      loader(false);
      if (res.success) {
        state.activeShiftId = res.shiftId;
        saveState();
        updateShiftUI();
        showToast('تم بدء الوردية بنجاح!');
      } else {
        showToast(res.error, true);
      }
    }).openShift(state.user);
};

window.shiftCloseStart = function() {
  if (!state.activeShiftId) return showToast('ليس لديك وردية نشطة حالياً لإغلاقها', true);
  q('#scCash').value = '0'; q('#scCard').value = '0'; q('#scKita').value = '0';
  openModal('#modalShiftClose');
};

window.shiftConfirmClose = function() {
  var cash = Number(q('#scCash').value) || 0;
  var card = Number(q('#scCard').value) || 0;
  var kita = Number(q('#scKita').value) || 0;

  loader(true);
  api.withFailureHandler(function(err) { loader(false); showToast(err.message, true); })
    .withSuccessHandler(function(d) {
      loader(false);
      if (d.error) return showToast(d.error, true);

      var thCash = Number(d.theoreticalCash) || 0;
      var thCard = Number(d.theoreticalCard) || 0;
      var thKita = Number(d.theoreticalKita) || 0;
      var totalExpected = thCash + thCard + thKita;
      var dCash = cash - thCash, dCard = card - thCard, dKita = kita - thKita;
      var totalDiff = (cash + card + kita) - totalExpected;

      if (totalExpected > 0 && cash === 0 && card === 0 && kita === 0) {
        alert('⚠️ لم تُدخل أي مبالغ!\n\nالمبيعات المتوقعة: ' + totalExpected.toFixed(2) + ' SAR\n\nأدخل المبالغ الفعلية في الدرج قبل الإغلاق.');
        return;
      }

      if (Math.abs(totalDiff) > 0.01) {
        var msg = '⚠️ يوجد فرق!\n\n' +
          'كاش: متوقع ' + thCash.toFixed(2) + ' | فعلي ' + cash.toFixed(2) + ' | فرق: ' + (dCash > 0 ? '+' : '') + dCash.toFixed(2) + '\n' +
          'مدى: متوقع ' + thCard.toFixed(2) + ' | فعلي ' + card.toFixed(2) + ' | فرق: ' + (dCard > 0 ? '+' : '') + dCard.toFixed(2) + '\n' +
          'كيتا: متوقع ' + thKita.toFixed(2) + ' | فعلي ' + kita.toFixed(2) + ' | فرق: ' + (dKita > 0 ? '+' : '') + dKita.toFixed(2) + '\n\n' +
          'إجمالي الفرق: ' + (totalDiff > 0 ? '+' : '') + totalDiff.toFixed(2) + ' SAR\n\n' +
          'يجب أن يكون الفرق صفراً لإغلاق الوردية.';
        alert(msg);
        return;
      }

      if (!confirm('الفرق متطابق (0.00). متابعة لإغلاق الوردية؟')) return;

      loader(true);
      api.withFailureHandler(function(err) { loader(false); showToast(err.message, true); })
        .withSuccessHandler(function(res) {
          loader(false);
          if (res.success) {
            state.activeShiftId = '';
            saveState();
            localStorage.removeItem('pos_active_shift_id');
            updateShiftUI();
            closeModal('#modalShiftClose');
            showToast('تم إغلاق الوردية بنجاح!');
          } else {
            showToast(res.error, true);
          }
        }).endShiftWithActuals(state.activeShiftId, state.user, cash, card, kita);
    }).getShiftDataForClosing(state.activeShiftId);
};
