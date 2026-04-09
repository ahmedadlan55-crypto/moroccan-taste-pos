/**
 * POS page logic — cart, menu, checkout, shifts, receipt, glass modals
 * Standalone — uses /shared/common.js + /shared/auth.js + /shared/api-bridge.js
 *
 * This page is ALSO a Progressive Web App: it can be installed on a phone's
 * home screen, it works offline (app shell is cached by /pos/sw.js), and it
 * launches in standalone mode without any browser chrome. The install prompt
 * is handled by setupPwa() below — if the browser supports PWA install, a
 * floating install-app button appears when the user can install.
 */

// ─── PWA: Service worker registration + install prompt ───
// Runs as early as possible so the SW starts installing in the background
// while the rest of the boot sequence continues. Completely safe if the
// browser doesn't support service workers — everything still works.
(function setupPwa() {
  if (!('serviceWorker' in navigator)) return;
  // Wait for the page to finish loading before registering the SW so it
  // doesn't compete with the critical rendering path on slow devices.
  window.addEventListener('load', function() {
    navigator.serviceWorker.register('/pos/sw.js', { scope: '/pos/' })
      .then(function(reg) {
        // Re-check for updates every hour while the app is open
        setInterval(function() { reg.update().catch(function() {}); }, 3600000);
      })
      .catch(function(err) {
        console.warn('[PWA] Service worker registration failed:', err && err.message);
      });
  });

  // Capture the native install prompt and defer it — we'll trigger it from
  // our own button so the user gets a clean in-app "install" experience.
  var deferredPrompt = null;

  window.addEventListener('beforeinstallprompt', function(e) {
    e.preventDefault();
    deferredPrompt = e;
    showPwaInstallButton();
  });

  // Hide the button once the app is actually installed
  window.addEventListener('appinstalled', function() {
    deferredPrompt = null;
    hidePwaInstallButton();
    try { localStorage.setItem('pos_pwa_installed', '1'); } catch (e) {}
  });

  function showPwaInstallButton() {
    // Don't re-create if one already exists
    var btn = document.getElementById('pwaInstallBtn');
    if (btn) { btn.classList.remove('hidden'); return; }

    btn = document.createElement('button');
    btn.id = 'pwaInstallBtn';
    btn.className = 'pwa-install-btn';
    btn.type = 'button';
    btn.setAttribute('data-i18n-aria-label', 'installApp');
    btn.setAttribute('aria-label', t('installApp'));
    btn.innerHTML = '<i class="fas fa-mobile-screen-button"></i><span data-i18n="installApp">' + t('installApp') + '</span>';
    btn.addEventListener('click', function() {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      deferredPrompt.userChoice.then(function(choice) {
        deferredPrompt = null;
        hidePwaInstallButton();
        // If the user accepted, appinstalled will fire next
        if (choice && choice.outcome === 'accepted' && typeof glassToast === 'function') {
          glassToast(t('installingApp'));
        }
      });
    });
    document.body.appendChild(btn);
  }

  function hidePwaInstallButton() {
    var btn = document.getElementById('pwaInstallBtn');
    if (btn) btn.classList.add('hidden');
  }

  // Expose the trigger globally in case other code wants to call it
  window.triggerPwaInstall = function() {
    if (deferredPrompt) {
      deferredPrompt.prompt();
    }
  };
})();

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
      glassToast((res && res.error) || t('failLoadData'), true);
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
    glassToast(err.message || t('failConnect'), true);
  }).getInitialAppData(state.user);
});

window.onLangChange = function() {
  // Re-render everything that depends on the language
  renderPayButtons();
  renderMenuGrid();
  updateCart();
  updateShiftUI();
  renderHeader('pos', { showShift: true });
  // Re-translate any static data-i18n elements that may have been (re)created
  translateUI();
};

// Toast alias — shared/common.js already provides openGlassModal,
// closeGlassModal, glassConfirm and glassAlert (fully translated via t()).
// We only need a thin glassToast alias here.
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
    h = '<div style="grid-column:1/-1;text-align:center;padding:50px 20px;color:#94a3b8;"><i class="fas fa-box-open" style="font-size:54px;margin-bottom:14px;display:block;opacity:0.35;"></i><div style="font-weight:700;">' + t('noProducts') + '</div></div>';
  } else {
    list.forEach(function(i) {
      var inCart = state.cart.find(function(c) { return c.id === i.id; });
      var qty = inCart ? inCart.qty : 0;
      var isSel = !!inCart;
      // Menu items no longer have their own stock — no stock badge.
      var safeJson = JSON.stringify(i).replace(/'/g, '&#39;');
      h += '<div class="pos-item ' + (isSel ? 'selected' : '') + '">' +
        '<div>' +
          '<div class="pos-item-name">' + (i.name || '') + '</div>' +
          '<div class="pos-item-price">' + formatVal(i.price) + '</div>' +
        '</div>' +
        '<div class="pos-item-actions">' +
          '<button class="qty-btn" ' + (qty <= 0 ? 'disabled' : '') + ' onclick="decFromCart(\'' + i.id + '\')" aria-label="' + t('decrease') + '">−</button>' +
          '<div class="qty-display">' + qty + '</div>' +
          '<button class="qty-btn add" onclick=\'addToCart(' + safeJson + ')\' aria-label="' + t('add') + '">+</button>' +
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
  glassConfirm(t('clearCartTitle'), t('clearCartMsg'), { danger: true, okText: t('yesClear') }).then(function(ok) {
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
          '<button class="qty-btn" onclick="modQty(' + idx + ', -1)" aria-label="' + t('decrease') + '">−</button>' +
          '<div class="qty-val">' + c.qty + '</div>' +
          '<button class="qty-btn" onclick="modQty(' + idx + ', 1)" aria-label="' + t('increase') + '">+</button>' +
        '</div>' +
        '<div class="cart-item-side">' +
          '<span class="cart-item-price-tag">@ ' + priceEditEl + '</span>' +
          '<button class="btn-remove" onclick="removeCartItem(' + idx + ')" aria-label="' + t('deleteLabel') + '"><i class="fas fa-trash"></i></button>' +
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
    // Service Fee label: translated base + translated method name in parentheses
    var methodLabel = selectedPM ? (isEn ? (selectedPM.Name || selectedPM.NameAR) : (selectedPM.NameAR || selectedPM.Name)) : t(String(payMethod).toLowerCase());
    if (feeLabel) feeLabel.textContent = t('serviceFee').replace(':', '') + ' (' + methodLabel + '):';
    q('#serviceFeeText').innerText = formatVal(serviceFee) + (feeRate > 0 && !manualFee ? ' (' + feeRate + '%)' : '');
    if (feeInput && !manualFee && feeRate > 0) feeInput.placeholder = formatVal(serviceFee) + ' (' + t('serviceFeeAuto') + ' ' + feeRate + '%)';
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
    // Fallback: labels come from t() so they follow the language
    active = [
      { Name: 'Cash', NameAR: t('cash'), Icon: 'fa-money-bill-wave' },
      { Name: 'Card', NameAR: t('card'), Icon: 'fa-credit-card' },
      { Name: 'Kita', NameAR: t('kita'), Icon: 'fa-calculator' }
    ];
  }
  var isEn = state.lang === 'en';
  var defaultMethod = active[0].Name;
  var hiddenInput = '<input type="hidden" id="posPayMethod" value="' + defaultMethod + '">';

  var html = active.map(function(m) {
    // If the saved payment method is one of the core three (Cash/Card/Kita),
    // use the translated dict label so EN mode never shows Arabic words.
    var lowerName = String(m.Name || '').toLowerCase();
    var label;
    if (lowerName === 'cash' || lowerName === 'card' || lowerName === 'kita') {
      label = t(lowerName);
    } else {
      label = isEn ? (m.Name || m.NameAR) : (m.NameAR || m.Name);
    }
    return '<button class="pay-btn' + (m.Name === defaultMethod ? ' active' : '') + '" id="payBtn' + m.Name + '" onclick="setPayMethod(\'' + m.Name + '\')"><i class="fas ' + (m.Icon || 'fa-money-bill') + '"></i> <span>' + label + '</span></button>';
  }).join('');

  // Always-on Split feature
  html += '<button class="pay-btn" id="payBtnSplit" onclick="setPayMethod(\'Split\')" title="' + t('splitPayment') + '"><i class="fas fa-divide"></i> <span>' + t('split') + '</span></button>';

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
    // Prefer dict translation for core three methods (Cash/Card/Kita)
    var lowerName = String(m.Name || '').toLowerCase();
    var label;
    if (lowerName === 'cash' || lowerName === 'card' || lowerName === 'kita') {
      label = t(lowerName);
    } else {
      label = isEn ? (m.Name || m.NameAR) : (m.NameAR || m.Name);
    }
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
    if (!discs.length) h = '<p style="text-align:center;color:#94a3b8;padding:20px;">' + t('noDiscounts') + '</p>';
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
  glassToast(t('discountApplied'));
};

// =========================================
// Checkout
// =========================================
window.doCheckout = function() {
  if (!state.activeShiftId) return glassToast(t('shiftRequired'), true);
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
      return glassAlert(
        t('splitMismatchTitle'),
        t('splitMismatchPre') + formatVal(totalPaid) + t('splitMismatchMid') + formatVal(afterDiscount) + t('splitMismatchSuf'),
        { danger: true }
      );
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
    // Hard sanity check — the backend requires a valid shift_id FK. If the
    // cashier's localStorage got desynced from the DB, bail here with a
    // clear message instead of failing silently in the backend.
    if (!state.user) {
      return glassAlert(t('errorTitle'), t('userNotRecognized'), { danger: true });
    }
    if (!state.activeShiftId) {
      return glassAlert(t('noShiftTitle'), t('noShiftBodyMsg'), { danger: true });
    }

    loader();
    api.withSuccessHandler(function(res) {
      loader(false);
      // Backend returns { success: true, orderId } on success or
      // { success: false, error } on any DB/FK/validation failure.
      if (!res || res.success === false || !res.orderId) {
        var msg = (res && res.error) ? res.error : t('invoiceSaveErrorDefault');
        return glassAlert(t('invoiceSaveFailed'), msg, { danger: true });
      }
      glassToast(t('orderSaved'));
      printReceipt(res.orderId);
      state.cart = [];
      state.currentDiscount = { name: '', amount: 0 };
      updateCart();
      api.withSuccessHandler(function(m) { state.menu = m || []; renderMenuGrid(); }).getMenu();
    }).withFailureHandler(function(err) {
      loader(false);
      glassAlert(t('connectionFailed'), (err && err.message) || t('connectionFailedMsg'), { danger: true });
    }).saveOrder(order, state.user, state.activeShiftId);
  };

  if (serviceFee > 0) {
    glassConfirm(
      t('confirmServiceFeeTitle'),
      t('serviceFeeLine') + formatVal(serviceFee) + ' ' + state.settings.currency + '\n' + t('totalLine') + formatVal(totalFinal) + ' ' + state.settings.currency,
      { okText: t('continue') }
    ).then(function(ok) {
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
    var isEn = state.lang === 'en';
    // Labels on the receipt: static English words are kept (Item/Qty/Date/Tax No)
    // since they're universal; the rest follow the selected language so EN users
    // never see Arabic on their copy.
    var lblItem = isEn ? 'Item' : 'الصنف';
    var lblQty  = isEn ? 'Qty'  : 'الكمية';
    var lblDate = isEn ? 'Date' : 'التاريخ';
    var lblID   = isEn ? 'ID'   : 'المعرف';
    var lblItems= isEn ? 'Items' : 'عدد الأصناف';
    var lblServedBy = isEn ? 'Served by' : 'المسؤول';
    var lblTaxNo = isEn ? 'Tax No' : 'الرقم الضريبي';
    var h = logoTag +
      '<div style="text-align:center;font-size:18px;font-weight:900;margin-bottom:2px;">' + companyName + '</div>' +
      '<div style="text-align:center;font-size:11px;color:#666;margin-bottom:8px;">' + t('simplifiedTaxInvoice') + '</div>' +
      '<div style="text-align:center;font-size:11px;color:#666;margin-bottom:8px;">' + lblTaxNo + ': ' + taxNumber + '</div>' +
      '<div style="border-top:1px dashed #999;border-bottom:1px dashed #999;padding:8px 0;margin:8px 0;">' +
        '<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:2px;"><span>' + lblID + '</span><span style="font-weight:700;">' + inv.orderId + '</span></div>' +
        '<div style="display:flex;justify-content:space-between;font-size:12px;"><span>' + lblDate + '</span><span>' + dateStr + '</span></div>' +
      '</div>' +
      '<table style="width:100%;border-collapse:collapse;margin:8px 0;"><thead><tr style="border-bottom:1px dashed #999;"><th style="text-align:left;font-size:11px;padding:4px 0;">' + lblItem + '</th><th style="text-align:center;font-size:11px;">' + lblQty + '</th><th style="text-align:right;font-size:11px;">' + currency + '</th></tr></thead><tbody>' + itemsHtml + '</tbody></table>' +
      '<div style="text-align:center;font-size:12px;font-weight:700;border-top:1px dashed #999;padding-top:6px;">' + lblItems + ': ' + totalItems + '</div>' +
      '<table style="width:100%;margin:10px 0;border-collapse:collapse;border-top:1px solid #333;border-bottom:1px solid #333;"><tr>' +
        '<td style="text-align:center;padding:8px;border-left:1px solid #333;"><div style="font-size:10px;font-weight:700;">' + t('receiptTotalLabel') + '</div><div style="font-size:15px;font-weight:900;">' + formatVal(inv.totalFinal) + '</div></td>' +
        '<td style="text-align:center;padding:8px;border-left:1px solid #333;"><div style="font-size:10px;font-weight:700;">' + t('receiptNetLabel') + '</div><div style="font-size:15px;font-weight:900;">' + netAmount.toFixed(2) + '</div></td>' +
        '<td style="text-align:center;padding:8px;"><div style="font-size:10px;font-weight:700;">' + t('receiptVatLabel') + ' 15%</div><div style="font-size:15px;font-weight:900;">' + vatAmount.toFixed(2) + '</div></td>' +
      '</tr></table>' +
      '<div style="text-align:center;font-size:11px;color:#666;margin-bottom:4px;">' + lblServedBy + ': ' + (inv.username || state.user) + '</div>' +
      '<div id="receiptQR" style="text-align:center;margin:12px auto;width:150px;height:150px;"></div>' +
      '<div style="text-align:center;font-size:10px;color:#999;margin-bottom:4px;">' + inv.orderId + '</div>' +
      '<div style="text-align:center;font-size:11px;color:#666;">' + t('thankYou') + '</div>';

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
  var isEn = state.lang === 'en';
  var dir = isEn ? 'ltr' : 'rtl';
  var lblItem = isEn ? 'Item' : 'الصنف';
  var lblQty  = isEn ? 'Qty'  : 'الكمية';
  var lblDate = isEn ? 'Date' : 'التاريخ';
  var lblID   = isEn ? 'ID'   : 'المعرف';
  var lblTax  = isEn ? 'Tax'  : 'الرقم الضريبي';
  var lblTotal = isEn ? 'Total' : 'الإجمالي';
  var lblNet  = isEn ? 'Net'  : 'قبل الضريبة';
  var lblVat  = isEn ? 'VAT'  : 'الضريبة';
  w.document.write('<!DOCTYPE html><html lang="' + (isEn ? 'en' : 'ar') + '" dir="' + dir + '"><head><meta charset="UTF-8"><title>Receipt</title>' +
    '<style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:Arial,sans-serif;padding:8px;width:280px;margin:0 auto;font-size:12px;color:#000;direction:' + dir + ';}' +
    'table{width:100%;border-collapse:collapse;}th,td{padding:4px 2px;font-size:11px;}th{text-align:start;border-bottom:1px dashed #000;}' +
    '.center{text-align:center;}.bold{font-weight:700;}.big{font-size:14px;}.line{border-top:1px dashed #000;margin:6px 0;}' +
    '@media print{@page{margin:0;size:80mm auto;}body{padding:4px;width:100%;}}</style></head><body>' +
    ((state.settings && state.settings.logo) ? '<div class="center" style="margin-bottom:6px;"><img src="' + state.settings.logo + '" style="max-width:80px;max-height:80px;"></div>' : '') +
    '<div class="center bold" style="font-size:16px;">' + r.companyName + '</div>' +
    '<div class="center" style="font-size:10px;color:#666;margin-bottom:2px;">' + t('simplifiedTaxInvoice') + '</div>' +
    '<div class="center" style="font-size:10px;color:#666;margin-bottom:6px;">' + lblTax + ': ' + r.taxNumber + '</div>' +
    '<div class="line"></div>' +
    '<div style="display:flex;justify-content:space-between;font-size:11px;margin:4px 0;"><span>' + lblID + ':</span><span class="bold">' + r.inv.orderId + '</span></div>' +
    '<div style="display:flex;justify-content:space-between;font-size:11px;margin:4px 0;"><span>' + lblDate + ':</span><span>' + new Date(r.inv.date).toLocaleString('en-US') + '</span></div>' +
    '<div class="line"></div><table><tr><th>' + lblItem + '</th><th style="text-align:center;">' + lblQty + '</th><th style="text-align:end;">SAR</th></tr>');
  (r.inv.items || []).forEach(function(it) {
    w.document.write('<tr><td>' + it.name + '</td><td style="text-align:center;">' + it.qty + '</td><td style="text-align:end;">' + formatVal(it.total) + '</td></tr>');
  });
  w.document.write('</table><div class="line"></div>');
  var net = r.inv.totalFinal / 1.15;
  var vat = r.inv.totalFinal - net;
  w.document.write('<div class="center bold" style="margin:6px 0;">' + lblTotal + ': ' + formatVal(r.inv.totalFinal) + ' SAR</div>');
  w.document.write('<div class="center" style="font-size:10px;">' + lblNet + ': ' + net.toFixed(2) + ' | ' + lblVat + ': ' + vat.toFixed(2) + '</div>');
  if (qrImg) w.document.write('<div class="center" style="margin:10px 0;"><img src="' + qrImg + '" width="130" height="130"></div>');
  w.document.write('<div class="center" style="font-size:9px;color:#666;">' + r.inv.orderId + '</div>');
  w.document.write('<div class="center" style="font-size:10px;margin-top:6px;">' + t('thankYou') + '</div></body></html>');
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
  if (state.activeShiftId) return glassToast(t('shiftAlreadyOpen'), true);
  glassConfirm(t('openShiftTitle'), t('openShiftMsg') + state.user + '?', { okText: t('openShiftBtn') }).then(function(ok) {
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
          glassToast(t('shiftStarted'));
        } else {
          glassToast(res.error, true);
        }
      }).openShift(state.user);
  });
};

window.shiftCloseStart = function() {
  if (!state.activeShiftId) return glassToast(t('noActiveShift'), true);
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
          msg: t('noAmountEnteredMsg') + totalExpected.toFixed(2) + ' SAR' + t('noAmountEnteredMsgSuffix')
        });
      }

      // Block #2: variance not zero — REQUIRE review of invoices first
      if (Math.abs(totalDiff) > 0.01) {
        return showVarianceBlock({ thCash: thCash, thCard: thCard, thKita: thKita, cash: cash, card: card, kita: kita,
          dCash: dCash, dCard: dCard, dKita: dKita, totalDiff: totalDiff,
          msg: t('unbalancedMsg')
        });
      }

      // All good — final confirm + close
      glassConfirm(t('confirmCloseTitle'), t('diffExactMsg'), { okText: t('closeShift'), danger: true }).then(function(ok) {
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
              glassToast(t('shiftClosed'));
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
      '<thead><tr><th>' + t('method') + '</th><th>' + t('expected') + '</th><th>' + t('actual') + '</th><th>' + t('difference') + '</th></tr></thead>' +
      '<tbody>' +
        '<tr><td>' + t('cash') + '</td><td>' + fmt(d.thCash) + '</td><td>' + fmt(d.cash) + '</td><td class="' + dCls(d.dCash) + '">' + sign(d.dCash) + '</td></tr>' +
        '<tr><td>' + t('card') + '</td><td>' + fmt(d.thCard) + '</td><td>' + fmt(d.card) + '</td><td class="' + dCls(d.dCard) + '">' + sign(d.dCard) + '</td></tr>' +
        '<tr><td>' + t('kita') + '</td><td>' + fmt(d.thKita) + '</td><td>' + fmt(d.kita) + '</td><td class="' + dCls(d.dKita) + '">' + sign(d.dKita) + '</td></tr>' +
        '<tr class="total-row"><td>' + t('total') + '</td><td>' + fmt(d.thCash + d.thCard + d.thKita) + '</td><td>' + fmt(d.cash + d.card + d.kita) + '</td><td class="' + dCls(d.totalDiff) + '">' + sign(d.totalDiff) + '</td></tr>' +
      '</tbody>' +
    '</table>' +
    '<p style="font-size:12px;color:#7f1d1d;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:10px;margin-top:8px;">' + t('varianceBlockNote') + '</p>';
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
      '<div style="font-size:12px;color:var(--text-light);">' + t('shiftCloseReport') + '</div>' +
    '</div>' +
    '<div style="background:rgba(255,255,255,0.7);border:1px solid rgba(226,232,240,0.6);border-radius:12px;padding:12px 14px;margin-bottom:14px;font-size:13px;">' +
      '<div style="display:flex;justify-content:space-between;margin-bottom:6px;"><span style="color:var(--text-light);">' + t('shiftNumber') + ':</span><span style="font-weight:800;font-family:monospace;">' + shiftId + '</span></div>' +
      '<div style="display:flex;justify-content:space-between;margin-bottom:6px;"><span style="color:var(--text-light);">' + t('cashierLabel') + ':</span><span style="font-weight:800;">' + state._lastShiftReport.cashierName + '</span></div>' +
      '<div style="display:flex;justify-content:space-between;"><span style="color:var(--text-light);">' + t('closeDate') + ':</span><span style="font-weight:700;">' + dateStr + '</span></div>' +
    '</div>' +
    '<div class="shift-report-grid">' +
      '<div class="shift-stat-card"><div class="label">' + t('ordersCount') + '</div><div class="value">' + d.orders + '</div></div>' +
      '<div class="shift-stat-card total"><div class="label">' + t('totalSales') + '</div><div class="value">' + fmt(totalActual) + '</div></div>' +
      '<div class="shift-stat-card cash"><div class="label">' + t('cash') + '</div><div class="value">' + fmt(d.cash) + '</div></div>' +
      '<div class="shift-stat-card card"><div class="label">' + t('card') + '</div><div class="value">' + fmt(d.card) + '</div></div>' +
      '<div class="shift-stat-card kita" style="grid-column:1/-1;"><div class="label">' + t('kita') + '</div><div class="value">' + fmt(d.kita) + '</div></div>' +
    '</div>' +
    '<div style="text-align:center;padding:14px;border-radius:12px;background:#f0fdf4;border:1.5px solid #86efac;color:#166534;font-weight:900;font-size:15px;">' +
      '<i class="fas fa-check-circle"></i> ' + t('diffExactConfirm') +
    '</div>';
  q('#shiftReportBody').innerHTML = html;
  openGlassModal('#modalShiftReport');
}

// Build a plain-text version of the report and open WhatsApp
window.shareShiftReportWhatsApp = function() {
  var r = state._lastShiftReport;
  if (!r) return;
  var lines = [
    t('wappTitle'),
    '',
    '🏪 ' + r.company,
    '📅 ' + r.date,
    '🆔 ' + r.shiftId,
    '👤 ' + r.cashierName + ' (' + r.cashier + ')',
    '',
    t('wappOrders') + r.orders,
    t('wappTotalSales') + r.totalActual.toFixed(2) + ' SAR',
    '',
    t('wappPaymentBreakdown'),
    t('wappCash') + r.cash.toFixed(2) + ' SAR',
    t('wappCard') + r.card.toFixed(2) + ' SAR',
    t('wappKita') + r.kita.toFixed(2) + ' SAR',
    '',
    t('wappDiffExact')
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
  var isEn = state.lang === 'en';
  var dir = isEn ? 'ltr' : 'rtl';
  w.document.write('<!DOCTYPE html><html lang="' + (isEn ? 'en' : 'ar') + '" dir="' + dir + '"><head><meta charset="UTF-8"><title>' + t('shiftCloseReport') + '</title>' +
    '<style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:Arial,sans-serif;padding:18px;color:#1e293b;max-width:380px;margin:0 auto;font-size:13px;direction:' + dir + ';}' +
    '.h{text-align:center;border-bottom:2px solid #1e293b;padding-bottom:12px;margin-bottom:14px;}h1{font-size:18px;}h2{font-size:13px;color:#64748b;font-weight:400;}' +
    '.row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px dashed #cbd5e1;}.row:last-child{border:none;}' +
    'table{width:100%;border-collapse:collapse;margin:10px 0;}th,td{padding:8px;text-align:start;border-bottom:1px solid #e2e8f0;font-size:12px;}th{background:#f1f5f9;font-weight:700;}' +
    '.t{background:#ecfeff;font-weight:900;}@media print{body{padding:10px;}}</style></head><body>' +
    ((state.settings && state.settings.logo) ? '<div style="text-align:center;margin-bottom:8px;"><img src="' + state.settings.logo + '" style="max-width:90px;"></div>' : '') +
    '<div class="h"><h1>' + r.company + '</h1><h2>' + t('shiftCloseReport') + '</h2></div>' +
    '<div class="row"><span>' + t('cashierLabel') + '</span><span><b>' + r.cashierName + '</b></span></div>' +
    '<div class="row"><span>' + t('identifier') + '</span><span>' + r.cashier + '</span></div>' +
    '<div class="row"><span>' + t('shiftNumber') + '</span><span><b>' + r.shiftId + '</b></span></div>' +
    '<div class="row"><span>' + t('closeDate') + '</span><span>' + r.date + '</span></div>' +
    '<div class="row"><span>' + t('ordersCount') + '</span><span><b>' + r.orders + '</b></span></div>' +
    '<table><tr><th>' + t('method') + '</th><th style="text-align:end;">' + t('amountSar') + '</th></tr>' +
      '<tr><td>' + t('cash') + '</td><td style="text-align:end;">' + fmt(r.cash) + '</td></tr>' +
      '<tr><td>' + t('card') + '</td><td style="text-align:end;">' + fmt(r.card) + '</td></tr>' +
      '<tr><td>' + t('kita') + '</td><td style="text-align:end;">' + fmt(r.kita) + '</td></tr>' +
      '<tr class="t"><td>' + t('total') + '</td><td style="text-align:end;">' + fmt(r.totalActual) + '</td></tr>' +
    '</table>' +
    '<div style="text-align:center;padding:14px;background:#f0fdf4;border:1px solid #86efac;border-radius:8px;color:#166534;font-weight:900;">' + t('diffZeroValid') + '</div>' +
    '</body></html>');
  w.document.close();
  setTimeout(function() { w.print(); }, 400);
};
