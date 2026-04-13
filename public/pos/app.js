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
        state.categories = [...new Set(c.menu.map(function(i) { return i.category; }))].filter(function(cat) { return cat && String(cat).trim() !== ''; });
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
    state.categories = [...new Set(state.menu.map(function(i) { return i.category; }))].filter(function(c) { return c && String(c).trim() !== ''; });
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
    if(!c) return;
    var safeCat = String(c).replace(/'/g, "\\'");
    catHtml += '<div class="cat-pill ' + (state.activeCat === c ? 'active' : '') + '" onclick="setPosCat(\'' + safeCat + '\')">' + String(c).replace(/</g, "&lt;") + '</div>';
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
  // Split only between Cash and Card (مدى)
  var methods = (state.paymentMethods || []).filter(function(m) {
    var n = String(m.Name || '').toLowerCase();
    return (n === 'cash' || n === 'card') && m.IsActive !== false && m.IsActive !== 'FALSE';
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
      // Backend returns { success: true, orderId, recipesApplied, itemsWithoutRecipe }
      // on success or { success: false, error } on any DB/FK/validation failure.
      if (!res || res.success === false || !res.orderId) {
        var msg = (res && res.error) ? res.error : t('invoiceSaveErrorDefault');
        return glassAlert(t('invoiceSaveFailed'), msg, { danger: true });
      }

      // Diagnostic logging — open DevTools console (F12) to see exactly
      // which inventory rows were deducted and by how much.
      console.log('[SALE response]', res);
      if (res.recipesApplied && res.recipesApplied.length) {
        res.recipesApplied.forEach(function(r) {
          console.log('  ✓', r.menuName, '(' + r.menuId + ') deducted:', r.deductions);
        });
      }
      if (res.itemsWithoutRecipe && res.itemsWithoutRecipe.length) {
        console.warn('  ⚠ items WITHOUT recipe (no inventory deduction):', res.itemsWithoutRecipe);
        // Show a one-time toast warning the cashier
        var names = res.itemsWithoutRecipe.map(function(x) { return x.name; }).join('، ');
        glassToast('⚠ تحذير: المنتجات التالية ليس لها وصفة (لم يتم خصم أي مكوّن من المخزون): ' + names, true);
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

// =========================================
// Thermal Printer Settings
// =========================================
// Saved shape: { type: 'bluetooth'|'usb'|'network', name, id?, host?, port? }
// Persisted in localStorage under 'pos_printer'. Future print jobs can
// read this and route the job accordingly.

window.getSavedPrinter = function() {
  try {
    var raw = localStorage.getItem('pos_printer');
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return null;
};

window.savePrinter = function(printer) {
  try {
    localStorage.setItem('pos_printer', JSON.stringify(printer));
  } catch (e) {}
  refreshPrinterCurrent();
};

window.clearPrinter = function() {
  localStorage.removeItem('pos_printer');
  refreshPrinterCurrent();
  glassToast(t('printerCleared'));
};

function refreshPrinterCurrent() {
  var box = q('#printerCurrent');
  var label = q('#printerCurrent .printer-current-label');
  var detail = q('#printerCurrentDetail');
  var clearBtn = q('#printerClearBtn');
  if (!box) return;

  var p = getSavedPrinter();
  if (!p) {
    if (label) label.textContent = t('noPrinterConnected');
    if (detail) detail.textContent = '';
    if (clearBtn) clearBtn.style.display = 'none';
    box.classList.remove('connected');
    return;
  }

  box.classList.add('connected');
  var typeLabel = t('printerType_' + p.type) || p.type;
  if (label) label.textContent = typeLabel + ' — ' + (p.name || '');
  if (detail) {
    if (p.type === 'network') detail.textContent = (p.host || '') + ':' + (p.port || 9100);
    else if (p.id) detail.textContent = p.id;
    else detail.textContent = '';
  }
  if (clearBtn) clearBtn.style.display = '';
}

window.openPrinterSettings = function() {
  // Warn about unsupported environments
  var btSup = q('#bluetoothSupport');
  var usbSup = q('#usbSupport');
  if (btSup) {
    btSup.textContent = 'bluetooth' in navigator
      ? '✓ ' + t('supported')
      : '✗ ' + t('unsupportedBrowserBluetooth');
    btSup.style.color = 'bluetooth' in navigator ? '#16a34a' : '#ef4444';
  }
  if (usbSup) {
    usbSup.textContent = 'usb' in navigator
      ? '✓ ' + t('supported')
      : '✗ ' + t('unsupportedBrowserUsb');
    usbSup.style.color = 'usb' in navigator ? '#16a34a' : '#ef4444';
  }
  // Prefill saved network config
  var p = getSavedPrinter();
  if (p && p.type === 'network') {
    if (q('#printerIP')) q('#printerIP').value = p.host || '';
    if (q('#printerPort')) q('#printerPort').value = p.port || '9100';
  }
  refreshPrinterCurrent();
  openGlassModal('#modalPrinterSettings');
};

window.switchPrinterTab = function(tab) {
  ['bluetooth','usb','network'].forEach(function(t) {
    var tabEl = q('#ptab_' + t);
    var panelEl = q('#ppanel_' + t);
    if (tabEl) tabEl.classList.toggle('active', t === tab);
    if (panelEl) panelEl.classList.toggle('active', t === tab);
  });
};

// ─── Bluetooth (Web Bluetooth API) ───
// Supported on Chrome/Edge desktop + Android. Not supported on iOS Safari.
window.scanBluetoothPrinter = async function() {
  // ─── Pre-flight check 1: API available at all? ───
  if (!('bluetooth' in navigator) || !navigator.bluetooth) {
    var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    var hint = isIOS
      ? t('bluetoothIOSHint')
      : t('unsupportedBrowserBluetooth');
    return glassAlert(t('errorTitle'), hint, { danger: true });
  }

  // ─── Pre-flight check 2: Secure context (HTTPS or localhost)? ───
  // navigator.bluetooth.requestDevice silently fails on http:// pages.
  if (!window.isSecureContext) {
    return glassAlert(
      t('errorTitle'),
      t('bluetoothNotSecure') + '\n\n(' + location.protocol + '//' + location.host + ')',
      { danger: true }
    );
  }

  // ─── Pre-flight check 3: Radio turned on? ───
  // We DELIBERATELY do not call navigator.bluetooth.getAvailability() here.
  // It's unreliable: on many Android devices and Chrome versions it returns
  // false even when Bluetooth is fully enabled, because the API queries the
  // adapter without holding a permission grant. Trusting it produced false
  // "Bluetooth is off" errors. Instead, we let requestDevice() do the real
  // check — it'll throw a clear, accurate error if the radio is actually
  // off (or if any other low-level problem exists).

  // ─── Pre-flight check 4: Running inside an installed PWA on Android? ───
  // Chrome for Android has a known issue where Web Bluetooth returns
  // NotFoundError from the standalone PWA window even though it works in
  // the browser tab. Warn the user ONCE so they can open it in the tab
  // if the scan comes up empty.
  var inStandalone = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
  if (inStandalone && !localStorage.getItem('pos_bt_pwa_warned')) {
    try { localStorage.setItem('pos_bt_pwa_warned', '1'); } catch (e) {}
    await glassAlert(t('errorTitle'), t('bluetoothPwaWarning'), {});
  }

  // ─── Actual scan — open the browser's native device picker ───
  // acceptAllDevices:true forces the browser to list every nearby BLE
  // device, even ones that don't advertise a known service. This is the
  // most compatible configuration for thermal printer discovery.
  try {
    console.log('[Printer] Bluetooth scan starting…');
    var device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      // Common thermal-printer service UUIDs so we can GATT-connect later.
      // Any of these being pre-authorized doesn't affect the picker.
      optionalServices: [
        '000018f0-0000-1000-8000-00805f9b34fb', // Generic printer service (0x18F0)
        '0000ff00-0000-1000-8000-00805f9b34fb', // 0xFF00 custom
        '0000ffe0-0000-1000-8000-00805f9b34fb', // 0xFFE0 HM-10 style
        '49535343-fe7d-4ae5-8fa9-9fafd205e455', // Microchip BLE UART
        'e7810a71-73ae-499d-8c15-faa9aef0c3f2', // BlueTooth Printer (some GP/POS devices)
        '0000180a-0000-1000-8000-00805f9b34fb', // Device Information
        '00001800-0000-1000-8000-00805f9b34fb', // Generic Access
        '00001801-0000-1000-8000-00805f9b34fb'  // Generic Attribute
      ]
    });

    console.log('[Printer] Device selected:', device && device.name, device && device.id);

    if (!device) {
      return glassAlert(t('errorTitle'), t('bluetoothNoDevicePicked'), { danger: true });
    }

    savePrinter({
      type: 'bluetooth',
      name: device.name || 'Bluetooth Printer',
      id: device.id || ''
    });
    glassToast(t('printerConnected') + ': ' + (device.name || 'Bluetooth Printer'));

  } catch (err) {
    console.error('[Printer] Bluetooth scan failed:', err);

    var errName = (err && err.name) || '';
    var errMsg = (err && err.message) || String(err);

    // User cancelled the native picker — silent, not an error
    if (errName === 'NotFoundError' && errMsg.toLowerCase().indexOf('user cancel') !== -1) {
      return;
    }

    // NotFoundError without "user cancel" usually means no devices in range
    // or the adapter is off / blocked by permissions
    if (errName === 'NotFoundError') {
      return glassAlert(t('errorTitle'), t('bluetoothNoDevicesFound'), { danger: true });
    }

    // Security — not HTTPS, or blocked by permissions policy
    if (errName === 'SecurityError') {
      return glassAlert(t('errorTitle'), t('bluetoothSecurityError') + '\n\n' + errMsg, { danger: true });
    }

    // Permission denied (user clicked "Block" in Chrome)
    if (errName === 'NotAllowedError') {
      return glassAlert(t('errorTitle'), t('bluetoothPermissionDenied') + '\n\n' + errMsg, { danger: true });
    }

    // Not supported in this specific context (PWA / webview / etc.)
    if (errName === 'NotSupportedError' || errMsg.indexOf('not supported') !== -1) {
      return glassAlert(t('errorTitle'), t('bluetoothNotSupportedHere') + '\n\n' + errMsg, { danger: true });
    }

    // Anything else — show the raw error so we can diagnose
    glassAlert(t('errorTitle'), errName + ': ' + errMsg, { danger: true });
  }
};

// ─── USB (Web USB API) ───
// Supported on Chrome/Edge desktop + Android. Not iOS.
window.scanUsbPrinter = async function() {
  if (!('usb' in navigator)) {
    return glassAlert(t('errorTitle'), t('unsupportedBrowserUsb'), { danger: true });
  }
  try {
    // Most thermal printer USB class codes: 7 (printer) or use acceptAllDevices
    // We request all devices so the user sees everything plugged in.
    var device = await navigator.usb.requestDevice({ filters: [{ classCode: 7 }] });
    if (!device) return;
    var name = (device.productName || 'USB Printer') +
      (device.manufacturerName ? ' (' + device.manufacturerName + ')' : '');
    savePrinter({
      type: 'usb',
      name: name,
      id: (device.vendorId || '') + ':' + (device.productId || '')
    });
    glassToast(t('printerConnected') + ': ' + name);
  } catch (err) {
    if (err && String(err.name || '').indexOf('NotFoundError') !== -1) return;
    // If no class-7 match, retry with no filter so any device works
    try {
      var device2 = await navigator.usb.requestDevice({ filters: [] });
      if (!device2) return;
      var name2 = (device2.productName || 'USB Device') +
        (device2.manufacturerName ? ' (' + device2.manufacturerName + ')' : '');
      savePrinter({
        type: 'usb',
        name: name2,
        id: (device2.vendorId || '') + ':' + (device2.productId || '')
      });
      glassToast(t('printerConnected') + ': ' + name2);
    } catch (err2) {
      if (err2 && String(err2.name || '').indexOf('NotFoundError') !== -1) return;
      glassAlert(t('errorTitle'), (err2 && err2.message) || String(err2), { danger: true });
    }
  }
};

// ─── Network (IP-based) ───
window.saveNetworkPrinter = function() {
  var ip = (q('#printerIP') ? q('#printerIP').value : '').trim();
  var port = Number(q('#printerPort') ? q('#printerPort').value : 9100) || 9100;
  if (!ip) return glassAlert(t('errorTitle'), t('ipRequired'), { danger: true });
  // Very loose IP/hostname validation — allow IPv4 and hostnames
  if (!/^[\w\-.]+$/.test(ip)) return glassAlert(t('errorTitle'), t('invalidIp'), { danger: true });
  savePrinter({
    type: 'network',
    name: 'Network ' + ip + ':' + port,
    host: ip,
    port: port
  });
  glassToast(t('printerConnected') + ': ' + ip + ':' + port);
};

// Initialize the "current printer" display when the user first opens
// the page (the modal is empty by default).
document.addEventListener('DOMContentLoaded', function() {
  setTimeout(refreshPrinterCurrent, 100);
});

// =========================================
// Cashier Stocktake — persistent cart (survives close/reopen)
// =========================================
var _cstAllItems = [];
var _cstSelectedItem = null;

// Cart is stored in localStorage so the cashier can close the modal,
// serve a customer, and come back to find their work exactly as they left it.
function _getCstCart() {
  try { return JSON.parse(localStorage.getItem('pos_stocktake_cart') || '[]'); } catch(e) { return []; }
}
function _saveCstCart(cart) {
  try { localStorage.setItem('pos_stocktake_cart', JSON.stringify(cart)); } catch(e) {}
}

window.openCashierStocktake = function() {
  _cstSelectedItem = null;
  if (q('#cstSearch')) q('#cstSearch').value = '';
  if (q('#cstNotes')) q('#cstNotes').value = '';
  renderCstCart();
  loader(true);
  api.withSuccessHandler(function(items) {
    loader(false);
    _cstAllItems = items || [];
    openGlassModal('#modalCashierStocktake');
    // Close dropdown when clicking anywhere outside
    setTimeout(function() {
      document.addEventListener('click', _closeCstDropdown);
    }, 100);
  }).withFailureHandler(function(err) {
    loader(false);
    glassToast(err.message || t('failLoadData'), true);
  }).getInvItems();
};

function _closeCstDropdown(e) {
  var res = q('#cstSearchResults');
  var search = q('#cstSearch');
  if (!res || !search) return;
  // If click is outside the search input and dropdown, hide it
  if (!search.contains(e.target) && !res.contains(e.target)) {
    res.style.display = 'none';
  }
}

window.filterCashierStItems = function() {
  var search = (q('#cstSearch') ? q('#cstSearch').value : '').toLowerCase();
  var res = q('#cstSearchResults');
  if (!res) return;
  // Get IDs already in cart so we can hide them from the dropdown
  var cart = _getCstCart();
  var cartIds = cart.map(function(c) { return c.id; });
  // Filter: exclude items already in cart + apply search
  var available = _cstAllItems.filter(function(i) { return cartIds.indexOf(i.id) === -1; });
  var matches = search
    ? available.filter(function(i) { return (i.name||'').toLowerCase().includes(search) || (i.id||'').toLowerCase().includes(search); })
    : available;
  // Show ALL available items (no limit) so user can scroll through everything
  if (!matches.length) { res.innerHTML = '<div style="padding:10px;color:#94a3b8;text-align:center;">' + t('stNoResults') + '</div>'; res.style.display = 'block'; return; }
  res.innerHTML = matches.map(function(i) {
    var stk = Number(i.stock) || 0;
    var stkColor = stk <= (Number(i.minStock)||0) ? '#ef4444' : '#16a34a';
    return '<div style="padding:10px 14px;cursor:pointer;border-bottom:1px solid rgba(226,232,240,0.5);display:flex;justify-content:space-between;align-items:center;" onclick="selectCstItem(\'' + i.id + '\')">' +
      '<span style="font-weight:700;">' + i.name + '</span>' +
      '<span style="font-size:12px;color:' + stkColor + ';font-weight:800;">' + stk + ' ' + (i.unit||'') + '</span></div>';
  }).join('');
  res.style.display = 'block';
};

window.selectCstItem = function(itemId) {
  var item = _cstAllItems.find(function(i) { return i.id === itemId; });
  if (!item) return;
  _cstSelectedItem = item;
  if (q('#cstSearch')) q('#cstSearch').value = item.name;
  if (q('#cstSearchResults')) q('#cstSearchResults').style.display = 'none';

  // Add immediately to cart with systemQty — user fills in actual later in the table
  var cart = _getCstCart();
  var existing = cart.find(function(c) { return c.id === item.id; });
  if (!existing) {
    console.log('[STOCKTAKE] Adding item:', item.name, 'bigUnit:', item.bigUnit, 'convRate:', item.convRate, 'unit:', item.unit);
    cart.push({
      id: item.id, name: item.name,
      unit: item.unit || '',
      bigUnit: item.bigUnit || item.big_unit || '',
      convRate: Number(item.convRate || item.conv_rate) || 1,
      systemQty: Number(item.stock) || 0, actualQty: '',
      unitCost: Number(item.cost) || 0
    });
    _saveCstCart(cart);
  }
  _cstSelectedItem = null;
  if (q('#cstSearch')) q('#cstSearch').value = '';
  renderCstCart();
};

function renderCstCart() {
  var cart = _getCstCart();
  var tb = q('#cstBody');
  if (!tb) return;
  if (!cart.length) {
    tb.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#94a3b8;padding:24px;"><i class="fas fa-clipboard-list" style="font-size:28px;margin-bottom:8px;display:block;opacity:0.3;"></i>' + t('stEmptyHint') + '</td></tr>';
    return;
  }
  tb.innerHTML = cart.map(function(c, i) {
    // Always refresh unit data from _cstAllItems to ensure bigUnit/convRate are current
    if (_cstAllItems.length) {
      var fresh = _cstAllItems.find(function(x) { return x.id === c.id; });
      if (fresh) {
        c.bigUnit = fresh.bigUnit || fresh.big_unit || c.bigUnit || '';
        c.convRate = Number(fresh.convRate || fresh.conv_rate) || Number(c.convRate) || 1;
        c.unit = fresh.unit || c.unit || '';
        c.systemQty = Number(fresh.stock) || c.systemQty || 0;
      }
    }
    var cRate = Number(c.convRate) || 1;
    var hasBig = c.bigUnit && cRate > 1;
    var actualSmall = c.actualQty === '' || c.actualQty === null ? '' : Number(c.actualQty);
    var bigVal = c._bigInput !== undefined ? c._bigInput : '';
    var smallVal = c._smallInput !== undefined ? c._smallInput : (actualSmall !== '' && !hasBig ? actualSmall : '');
    var diff = actualSmall === '' ? '' : (Number(actualSmall) - c.systemQty);
    var diffHtml = diff === '' ? '<span style="color:#94a3b8;">—</span>'
      : (diff === 0 ? '<span style="color:#64748b;">0</span>'
        : (diff > 0 ? '<span style="color:#16a34a;">+' + diff.toFixed(2) + '</span>'
          : '<span style="color:#ef4444;">' + diff.toFixed(2) + '</span>'));
    // Column 1: المادة
    var nameCell = '<td style="font-weight:700;font-size:12px;">' + c.name + '</td>';
    // Column 2: الكبرى — input or dash
    var bigCell = hasBig
      ? '<td style="text-align:center;"><input type="number" min="0" step="1" class="form-control glass-input" style="width:55px;margin:0 auto;padding:5px;text-align:center;font-weight:800;" value="' + (bigVal === '' ? '' : bigVal) + '" oninput="updateCstDual(' + i + ',this.value,null)" placeholder="0"></td>'
      : '<td style="text-align:center;color:#e2e8f0;">—</td>';
    // Column 3: وحدة كبرى
    var bigUnitCell = '<td style="text-align:center;font-size:11px;color:#64748b;">' + (hasBig ? c.bigUnit : '—') + '</td>';
    // Column 4: الصغرى — always has input
    var smallCell = '<td style="text-align:center;"><input type="number" min="0" step="0.01" class="form-control glass-input" style="width:60px;margin:0 auto;padding:5px;text-align:center;font-weight:800;" value="' + (smallVal === '' ? '' : smallVal) + '" oninput="updateCstDual(' + i + ',null,this.value)" placeholder="0"></td>';
    // Column 5: وحدة صغرى
    var unitCell = '<td style="text-align:center;font-size:11px;color:#64748b;">' + (c.unit || '') + '</td>';
    // Column 5: النظام
    var sysCell = '<td style="text-align:center;font-weight:600;color:var(--primary);font-size:12px;">' + c.systemQty.toFixed(2) + '</td>';
    // Column 6: التباين
    var diffCell = '<td style="text-align:center;font-weight:900;">' + diffHtml + '</td>';
    // Column 7: حذف
    var delCell = '<td style="text-align:center;"><button class="btn-remove" onclick="removeCstItem(' + i + ')"><i class="fas fa-trash"></i></button></td>';
    return '<tr>' + nameCell + bigCell + bigUnitCell + smallCell + unitCell + sysCell + diffCell + delCell + '</tr>';
  }).join('');
}

// Update stocktake from dual inputs (big qty + small qty)
// Each input is independent: big = cartons, small = pieces
// Total = (big × convRate) + small
window.updateCstDual = function(idx, bigVal, smallVal) {
  var cart = _getCstCart();
  if (!cart[idx]) return;
  var cRate = Number(cart[idx].convRate) || 1;
  var hasBig = cart[idx].bigUnit && cRate > 1;

  // Save each input independently — never overwrite the other
  if (bigVal !== null && bigVal !== undefined) cart[idx]._bigInput = bigVal === '' ? '' : Number(bigVal);
  if (smallVal !== null && smallVal !== undefined) cart[idx]._smallInput = smallVal === '' ? '' : Number(smallVal);

  var b = Number(cart[idx]._bigInput) || 0;
  var s = Number(cart[idx]._smallInput) || 0;

  // Both empty = not counted yet
  var bigEmpty = cart[idx]._bigInput === '' || cart[idx]._bigInput === undefined;
  var smallEmpty = cart[idx]._smallInput === '' || cart[idx]._smallInput === undefined;

  if (bigEmpty && smallEmpty) {
    cart[idx].actualQty = '';
  } else {
    // Total in small units: (cartons × piecesPerCarton) + loose pieces
    cart[idx].actualQty = hasBig ? (b * cRate) + s : s;
  }
  _saveCstCart(cart);

  // Update ONLY the diff cell (column 7 = index 6) without re-rendering
  var row = q('#cstBody') && q('#cstBody').children[idx];
  if (row) {
    var diff = cart[idx].actualQty === '' ? '' : (Number(cart[idx].actualQty) - cart[idx].systemQty);
    // Column order: المادة(1) الكبرى(2) وحدة_كبرى(3) الصغرى(4) وحدة_صغرى(5) النظام(6) التباين(7) حذف(8)
    var cell = row.children[6]; // التباين = 7th column (0-indexed = 6)
    if (cell) {
      cell.innerHTML = diff === '' ? '<span style="color:#94a3b8;">—</span>'
        : (diff === 0 ? '<span style="color:#64748b;">0</span>'
          : (diff > 0 ? '<span style="color:#16a34a;">+' + diff.toFixed(2) + '</span>'
            : '<span style="color:#ef4444;">' + diff.toFixed(2) + '</span>'));
    }
  }
};

window.clearCstCart = function() {
  localStorage.removeItem('pos_stocktake_cart');
  renderCstCart();
  glassToast('تم مسح المحضر');
};

window.removeCstItem = function(idx) {
  var cart = _getCstCart();
  cart.splice(idx, 1);
  _saveCstCart(cart);
  renderCstCart();
  // Force hide dropdown after a tick (renderCstCart may trigger focus events)
  setTimeout(function() {
    var res = q('#cstSearchResults');
    if (res) res.style.display = 'none';
  }, 50);
};

window.submitCashierStocktake = function() {
  var cart = _getCstCart();
  if (!cart.length) return glassToast(t('stAddFirst'), true);
  var counted = cart.filter(function(c) { return c.actualQty !== '' && c.actualQty !== null; });
  if (!counted.length) return glassToast(t('stEnterActual'), true);

  var itemsToSend = counted.map(function(c) {
    var s = Number(c.systemQty) || 0;
    var a = Number(c.actualQty) || 0;
    return { id: c.id, name: c.name, unit: c.unit || '', systemQty: s, actualQty: a, sys: s, actual: a, diff: a - s };
  });
  var notes = (q('#cstNotes') ? q('#cstNotes').value : '') || ('جرد بواسطة ' + state.user);

  glassConfirm(t('stConfirmTitle'), t('stConfirmMsg').replace('{n}', counted.length), { okText: t('confirm') }).then(function(ok) {
    if (!ok) return;
    loader(true);
    api.withSuccessHandler(function(r) {
      loader(false);
      if (r && r.success) {
        closeGlassModal('#modalCashierStocktake');
        glassToast(t('stSaved'));
        localStorage.removeItem('pos_stocktake_cart');
        // Pass itemsToSend (which has name/sys/actual) not counted (which has systemQty/actualQty)
        _showStocktakeWhatsApp(r.stocktakeId || '', itemsToSend);
      } else {
        glassToast((r && r.error) || t('errorTitle'), true);
      }
    }).withFailureHandler(function(err) {
      loader(false);
      glassToast(err.message || t('errorTitle'), true);
    }).submitStocktake(itemsToSend, state.user, notes);
  });
};

// Lazy-load jsPDF for PDF generation
function ensureJsPDF() {
  if (window.jspdf) return Promise.resolve();
  return new Promise(function(resolve, reject) {
    var s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
    s.onload = resolve;
    s.onerror = function() { reject(new Error('Failed to load jsPDF')); };
    document.head.appendChild(s);
  });
}

// After save: generate PDF and share via WhatsApp using Web Share API
function _showStocktakeWhatsApp(stId, items) {
  var cashier = (state.currentUser && state.currentUser.displayName) || state.user;
  var dateStr = new Date().toLocaleString('en-GB');
  var company = (state.settings && state.settings.name) || 'Moroccan Taste';
  var isEn = state.lang === 'en';
  var totalVar = items.reduce(function(s, c) { return s + ((Number(c.actual || c.actualQty) || 0) - (Number(c.sys || c.systemQty) || 0)); }, 0);

  var lblTitle = isEn ? 'Inventory Stocktake Report' : 'محضر جرد مخزون';
  var lblTotal = isEn ? 'Total Variance' : 'إجمالي التباين';
  var hSys = isEn ? 'System' : 'النظام';
  var hAct = isEn ? 'Actual' : 'الفعلي';
  var hVar = isEn ? 'Variance' : 'التباين';
  var hItem = isEn ? 'Item' : 'المادة';

  loader(true);
  ensureJsPDF().then(function() {
    loader(false);
    var doc = new jspdf.jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

    // Use default font (Helvetica) — works for English; Arabic shows as boxes
    // but since user asked for English mode, this is fine
    var pageW = doc.internal.pageSize.getWidth();
    var y = 20;

    // Header
    doc.setFontSize(18);
    doc.setFont('helvetica', 'bold');
    doc.text(company, pageW / 2, y, { align: 'center' });
    y += 8;
    doc.setFontSize(12);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(100);
    doc.text(lblTitle, pageW / 2, y, { align: 'center' });
    y += 10;

    // Meta info
    doc.setFontSize(10);
    doc.setTextColor(0);
    doc.setFont('helvetica', 'bold');
    doc.text((isEn ? 'Report No: ' : 'رقم المحضر: ') + stId, 15, y);
    doc.text((isEn ? 'Date: ' : 'التاريخ: ') + dateStr, pageW - 15, y, { align: 'right' });
    y += 6;
    doc.text((isEn ? 'Counted by: ' : 'القائم بالجرد: ') + cashier, 15, y);
    doc.text((isEn ? 'Items: ' : 'عدد الأصناف: ') + items.length, pageW - 15, y, { align: 'right' });
    y += 10;

    // Table header
    doc.setFillColor(241, 245, 249);
    doc.rect(15, y, pageW - 30, 8, 'F');
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(71, 85, 105);
    doc.text('#', 18, y + 5.5);
    doc.text(hItem, 28, y + 5.5);
    doc.text(hSys, 110, y + 5.5);
    doc.text(hAct, 135, y + 5.5);
    doc.text(hVar, 160, y + 5.5);
    y += 10;

    // Table rows
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(0);
    items.forEach(function(c, idx) {
      if (y > 270) { doc.addPage(); y = 20; }
      var sysQty = Number(c.sys || c.systemQty) || 0;
      var actQty = Number(c.actual || c.actualQty) || 0;
      var diff = actQty - sysQty;
      var sign = diff > 0 ? '+' : '';

      doc.setFontSize(9);
      doc.setTextColor(0);
      doc.text(String(idx + 1), 18, y);
      doc.setFont('helvetica', 'bold');
      doc.text(String(c.name || c.id), 28, y);
      doc.setFont('helvetica', 'normal');
      doc.text(sysQty.toFixed(2), 110, y);
      doc.text(actQty.toFixed(2), 135, y);
      // Variance color
      if (diff < 0) doc.setTextColor(239, 68, 68);
      else if (diff > 0) doc.setTextColor(22, 163, 74);
      else doc.setTextColor(100);
      doc.setFont('helvetica', 'bold');
      doc.text(sign + diff.toFixed(2), 160, y);
      doc.setTextColor(0);
      doc.setFont('helvetica', 'normal');

      // Row line
      y += 2;
      doc.setDrawColor(226, 232, 240);
      doc.line(15, y, pageW - 15, y);
      y += 6;
    });

    // Total variance box
    y += 5;
    if (totalVar < 0) { doc.setFillColor(254, 242, 242); doc.setTextColor(239, 68, 68); }
    else { doc.setFillColor(240, 253, 244); doc.setTextColor(22, 163, 74); }
    doc.roundedRect(15, y, pageW - 30, 12, 3, 3, 'F');
    doc.setFontSize(12);
    doc.setFont('helvetica', 'bold');
    doc.text(lblTotal + ': ' + (totalVar >= 0 ? '+' : '') + totalVar.toFixed(2), pageW / 2, y + 8, { align: 'center' });

    // Signature lines
    y += 25;
    doc.setTextColor(0);
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    var sig1 = isEn ? 'Counted by' : 'القائم بالجرد';
    var sig2 = isEn ? 'Warehouse Mgr' : 'مدير المستودع';
    var sig3 = isEn ? 'General Mgr' : 'المدير العام';
    [sig1, sig2, sig3].forEach(function(lbl, i) {
      var x = 30 + i * 55;
      doc.line(x - 10, y, x + 30, y);
      doc.setTextColor(100);
      doc.text(lbl, x + 10, y + 5, { align: 'center' });
    });

    // Generate PDF blob
    var pdfBlob = doc.output('blob');
    var fileName = 'Stocktake-' + stId + '.pdf';
    var pdfFile = new File([pdfBlob], fileName, { type: 'application/pdf' });

    // Try Web Share API (works on mobile — shares to WhatsApp, email, etc.)
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [pdfFile] })) {
      navigator.share({
        title: lblTitle,
        text: lblTitle + ' - ' + stId,
        files: [pdfFile]
      }).catch(function() {
        // User cancelled share — just download instead
        doc.save(fileName);
      });
    } else {
      // Fallback: download the PDF
      doc.save(fileName);
      glassToast(isEn ? 'PDF downloaded — share it via WhatsApp manually' : 'تم تنزيل PDF — شاركه عبر واتساب يدوياً');
    }
  }).catch(function(err) {
    loader(false);
    glassToast(err.message || 'Failed to generate PDF', true);
  });
}

// ═══════════════════════════════════════
// RECEIVE MATERIALS (استلام مواد)
// ═══════════════════════════════════════
var _rcvPurchaseId = null;
var _rcvItems = [];

window.openReceiveModal = function(shortageId) {
  loader(true);
  // Find the converted shortage to get purchase ID
  api.withSuccessHandler(function(data) {
    loader(false);
    if (!data || data.error) return glassToast(data && data.error || 'خطأ', true);
    if (data.status !== 'converted' || !data.poId) return glassToast(state.lang==='en'?'Not converted to PO yet':'هذا الطلب لم يُحوّل لأمر شراء بعد', true);

    // Get the purchase linked to this PO
    api.withSuccessHandler(function(purchases) {
      var pur = (purchases||[]).find(function(p) { return p.poId === data.poId; });
      if (!pur) return glassToast(state.lang==='en'?'Purchase not found':'لم يتم العثور على فاتورة الشراء', true);
      _rcvPurchaseId = pur.id;
      var items = pur.items || [];
      _rcvItems = items.map(function(it) {
        return { id: it.id||it.itemId, name: it.name||it.itemName, unit: it.unit||'', qty: Number(it.qty)||0, unitPrice: Number(it.unitPrice||it.price)||0, receivedQty: Number(it.qty)||0 };
      });
      _renderReceiveForm();
      openGlassModal('#modalReceive');
    }).getPurchases({});
  }).getShortageRequest(shortageId);
};

function _renderReceiveForm() {
  var isEn = state.lang === 'en';
  var html = '<table class="table" style="font-size:12px;"><thead><tr><th>' + (isEn?'Item':'المادة') + '</th><th style="text-align:center;">' + (isEn?'Ordered':'المطلوب') + '</th><th style="text-align:center;">' + (isEn?'Actual Received':'المستلم فعلياً') + '</th><th style="text-align:center;">' + (isEn?'Unit':'الوحدة') + '</th><th style="text-align:center;">' + (isEn?'Diff':'الفرق') + '</th></tr></thead><tbody>';
  _rcvItems.forEach(function(it, i) {
    var diff = it.receivedQty - it.qty;
    var diffColor = diff === 0 ? '#64748b' : (diff < 0 ? '#ef4444' : '#16a34a');
    html += '<tr>' +
      '<td style="font-weight:700;">' + it.name + '</td>' +
      '<td style="text-align:center;font-weight:700;color:#3b82f6;">' + it.qty + '</td>' +
      '<td style="text-align:center;"><input type="number" min="0" step="1" value="' + it.receivedQty + '" style="width:60px;padding:5px;border:1.5px solid #e2e8f0;border-radius:8px;text-align:center;font-weight:800;" onchange="rcvUpdateQty(' + i + ',this.value)"></td>' +
      '<td style="text-align:center;font-size:11px;color:#64748b;">' + it.unit + '</td>' +
      '<td style="text-align:center;font-weight:800;color:' + diffColor + ';">' + (diff > 0 ? '+' : '') + diff + '</td>' +
    '</tr>';
  });
  html += '</tbody></table>';
  q('#rcvContent').innerHTML = html;
}

window.rcvUpdateQty = function(idx, val) {
  if (_rcvItems[idx]) {
    _rcvItems[idx].receivedQty = Math.max(0, Number(val) || 0);
    _renderReceiveForm();
  }
};

window.submitReceiveRequest = function() {
  if (!_rcvPurchaseId || !_rcvItems.length) return glassToast(t('stAddFirst'), true);
  var items = _rcvItems.map(function(it) {
    return { invItemId: it.id, invItemName: it.name, unit: it.unit, orderedQty: it.qty, receivedQty: it.receivedQty, unitPrice: it.unitPrice };
  });

  glassConfirm(t('receiveMaterials'), state.lang==='en'?'Submit received quantities for approval?':'سيتم إرسال الكميات المستلمة للموافقة. متابعة؟', {}).then(function(ok) {
    if (!ok) return;
    loader(true);
    api.withSuccessHandler(function(r) {
      loader(false);
      if (r && r.success) {
        closeGlassModal('#modalReceive');
        glassToast(t('submitReceive') + ' — ' + t('success'));
      } else glassToast((r && r.error) || 'فشل', true);
    }).submitReceiveRequest({ purchaseId: _rcvPurchaseId, items: items, username: state.user });
  });
};

// ═══════════════════════════════════════
// FLOAT ACTIONS TOGGLE (إخفاء/إظهار الأزرار)
// ═══════════════════════════════════════
window.toggleFloatActions = function() {
  var el = document.getElementById('floatActions');
  if (el) el.classList.toggle('collapsed');
};
// Auto-collapse on mobile after 5 seconds
setTimeout(function() {
  if (window.innerWidth < 768) {
    var el = document.getElementById('floatActions');
    if (el) el.classList.add('collapsed');
  }
}, 5000);
// Also support swipe
(function() {
  var fa = document.getElementById('floatActions');
  if (!fa) return;
  var startX = 0;
  fa.addEventListener('touchstart', function(e) { startX = e.touches[0].clientX; }, { passive: true });
  fa.addEventListener('touchend', function(e) {
    var dx = e.changedTouches[0].clientX - startX;
    var isRTL = document.dir === 'rtl' || document.documentElement.dir === 'rtl';
    // Swipe left in RTL = show, swipe right = hide
    if (isRTL) {
      if (dx < -40) fa.classList.remove('collapsed');
      else if (dx > 40) fa.classList.add('collapsed');
    } else {
      if (dx > 40) fa.classList.remove('collapsed');
      else if (dx < -40) fa.classList.add('collapsed');
    }
  }, { passive: true });
})();

// ═══════════════════════════════════════
// SHORTAGE REQUEST — Stocktake-style (طلب نواقص)
// ═══════════════════════════════════════
// Persistent cart (saved to localStorage)
var _shrCart = _getShrCart();
var _shrAllItems = [];
function _getShrCart() { try { return JSON.parse(localStorage.getItem('pos_shortage_cart')||'[]'); } catch(e) { return []; } }
function _saveShrCart() { try { localStorage.setItem('pos_shortage_cart', JSON.stringify(_shrCart)); } catch(e) {} }

// Tab switching
window.shrSwitchTab = function(tab) {
  var newPanel = q('#shrNewPanel'), histPanel = q('#shrHistoryPanel');
  var newAct = q('#shrNewActions'), histAct = q('#shrHistoryActions');
  var tabNew = q('#shrTabNew'), tabHist = q('#shrTabHistory');
  if (tab === 'history') {
    if (newPanel) newPanel.style.display = 'none';
    if (histPanel) histPanel.style.display = 'block';
    if (newAct) newAct.style.display = 'none';
    if (histAct) histAct.style.display = 'flex';
    if (tabNew) { tabNew.style.background = '#e2e8f0'; tabNew.style.color = '#475569'; }
    if (tabHist) { tabHist.style.background = '#8b5cf6'; tabHist.style.color = '#fff'; }
    _shrLoadHistory();
  } else {
    if (newPanel) newPanel.style.display = 'flex';
    if (histPanel) histPanel.style.display = 'none';
    if (newAct) newAct.style.display = 'flex';
    if (histAct) histAct.style.display = 'none';
    if (tabNew) { tabNew.style.background = '#8b5cf6'; tabNew.style.color = '#fff'; }
    if (tabHist) { tabHist.style.background = '#e2e8f0'; tabHist.style.color = '#475569'; }
  }
};

// Load shortage history
function _shrLoadHistory() {
  var panel = q('#shrHistoryPanel');
  if (!panel) return;
  panel.innerHTML = '<div style="text-align:center;padding:30px;color:#94a3b8;"><i class="fas fa-spinner fa-spin"></i></div>';
  api.withSuccessHandler(function(list) {
    var isEn = state.lang === 'en';
    var statusLabels = isEn
      ? {pending:'Pending',approved:'Approved',converted:'PO Created',rejected:'Rejected',partially_received:'Partial',fully_received:'Received',closed:'Closed'}
      : {pending:'بانتظار',approved:'معتمد',converted:'تم التحويل لـ PO',rejected:'مرفوض',partially_received:'استلام جزئي',fully_received:'تم الاستلام',closed:'مغلق'};
    var statusColors = {pending:'#f59e0b',approved:'#3b82f6',converted:'#8b5cf6',rejected:'#ef4444',partially_received:'#d97706',fully_received:'#16a34a',closed:'#64748b'};

    if (!list || !list.length) {
      panel.innerHTML = '<div style="text-align:center;padding:40px;color:#94a3b8;"><i class="fas fa-inbox" style="font-size:28px;display:block;margin-bottom:8px;"></i>' + (isEn?'No requests yet':'لا توجد طلبات بعد') + '</div>';
      return;
    }

    var myRequests = list.filter(function(r) { return r.username === state.user; });
    if (!myRequests.length) {
      panel.innerHTML = '<div style="text-align:center;padding:40px;color:#94a3b8;"><i class="fas fa-inbox" style="font-size:28px;display:block;margin-bottom:8px;"></i>' + (isEn?'No requests from you':'لا توجد طلبات منك') + '</div>';
      return;
    }

    var html = myRequests.map(function(r) {
      var dt = '';
      try { dt = new Date(r.requestDate).toLocaleDateString('en-GB'); } catch(e) {}
      var sColor = statusColors[r.status] || '#64748b';
      var sLabel = statusLabels[r.status] || r.status;
      var canReceive = r.status === 'converted';

      return '<div style="border:1.5px solid #e2e8f0;border-radius:12px;padding:12px;margin-bottom:8px;background:#fff;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">' +
          '<code style="font-weight:800;color:#8b5cf6;">' + (r.requestNumber||'') + '</code>' +
          '<span style="font-size:11px;font-weight:800;padding:3px 10px;border-radius:8px;background:' + sColor + '18;color:' + sColor + ';">' + sLabel + '</span>' +
        '</div>' +
        '<div style="display:flex;gap:12px;font-size:12px;color:#64748b;">' +
          '<span><i class="fas fa-calendar-day" style="margin-left:3px;"></i>' + dt + '</span>' +
          '<span><i class="fas fa-boxes" style="margin-left:3px;"></i>' + (r.totalItems||0) + ' ' + (isEn?'items':'مادة') + '</span>' +
        '</div>' +
        (r.status === 'pending' ? '<button class="btn btn-primary btn-sm" style="margin-top:8px;border-radius:8px;width:100%;" onclick="shrEditRequest(\'' + r.id + '\')"><i class="fas fa-edit"></i> ' + (isEn?'Edit Request':'تعديل الطلب') + '</button>' : '') +
        (canReceive ? '<button class="btn btn-success btn-sm" style="margin-top:8px;border-radius:8px;width:100%;" onclick="closeGlassModal(\'#modalShortage\');openReceiveModal(\'' + r.id + '\')"><i class="fas fa-box-open"></i> ' + (isEn?'Receive Materials':t('receiveMaterials')) + '</button>' : '') +
      '</div>';
    }).join('');
    panel.innerHTML = html;
  }).getShortageRequests();
}

var _shrEditingId = null; // If editing a pending request

// Edit a pending shortage request — load its items into the cart
window.shrEditRequest = function(requestId) {
  loader(true);
  api.withSuccessHandler(function(data) {
    loader(false);
    if (!data || data.error) return glassToast(data && data.error || t('errorTitle'), true);
    if (data.status !== 'pending') return glassToast(state.lang==='en'?'Only pending requests can be edited':'فقط الطلبات المعلقة يمكن تعديلها', true);

    // Load items into cart
    _shrCart = (data.items || []).map(function(i) {
      return { id: i.invItemId, name: i.invItemName, unit: i.unit||'', stock: Number(i.currentQty)||0, minStock: Number(i.minQty)||0, cost: Number(i.unitPrice)||0, requestedQty: Number(i.requestedQty)||1 };
    });
    _saveShrCart();
    _shrEditingId = requestId;

    // Switch to "new" tab with the loaded data
    shrSwitchTab('new');
    _shrRenderCart();

    // Update submit button text
    var submitBtn = q('#shrNewPanel') && q('#shrNewPanel').closest('.glass-modal-content');
    glassToast(state.lang==='en'?'Request loaded for editing — modify and save':'تم تحميل الطلب للتعديل — عدّل واحفظ');
  }).getShortageRequest(requestId);
};

window.openShortageRequest = function() {
  _shrCart = _getShrCart(); // Restore from localStorage
  _shrEditingId = null;
  if (q('#shrSearch')) q('#shrSearch').value = '';
  if (q('#shrNotes')) q('#shrNotes').value = '';
  if (q('#shrSearchResults')) q('#shrSearchResults').style.display = 'none';
  shrSwitchTab('new');

  loader(true);
  api.withSuccessHandler(function(items) {
    loader(false);
    _shrAllItems = (items || []).map(function(i) {
      return { id: i.id, name: i.name, category: i.category||'', stock: Number(i.stock)||0, minStock: Number(i.minStock||i.min_stock)||0, cost: Number(i.cost)||0, unit: i.unit||'', bigUnit: i.bigUnit||i.big_unit||'', convRate: Number(i.convRate||i.conv_rate)||1 };
    });
    openGlassModal('#modalShortage');
    // Render cart AFTER modal is open (DOM is visible)
    setTimeout(function() { _shrRenderCart(); }, 50);
    // Close dropdown on outside click
    setTimeout(function() { document.addEventListener('click', _closeShrDropdown); }, 100);
  }).withFailureHandler(function() { loader(false); glassToast(t('errorTitle'), true); }).getInvItems();
};

function _closeShrDropdown(e) {
  var res = q('#shrSearchResults'), search = q('#shrSearch');
  if (!res || !search) return;
  if (!search.contains(e.target) && !res.contains(e.target)) res.style.display = 'none';
}

window.shrFilterItems = function(query) {
  var box = q('#shrSearchResults');
  var ql = (query||'').toLowerCase();
  var cartIds = _shrCart.map(function(c) { return c.id; });
  var available = _shrAllItems.filter(function(i) { return cartIds.indexOf(i.id) === -1; });
  var matches = ql
    ? available.filter(function(i) { return (i.name||'').toLowerCase().indexOf(ql) >= 0 || (i.category||'').toLowerCase().indexOf(ql) >= 0 || (i.id||'').toLowerCase().indexOf(ql) >= 0; })
    : available;

  if (!matches.length) { box.innerHTML = '<div style="padding:12px;color:#94a3b8;text-align:center;">' + t('stNoResults') + '</div>'; box.style.display = 'block'; return; }

  box.innerHTML = matches.map(function(i) {
    var low = i.stock <= i.minStock;
    return '<div onclick="shrAddItem(\'' + i.id + '\')" style="padding:10px 14px;cursor:pointer;border-bottom:1px solid rgba(226,232,240,0.5);display:flex;justify-content:space-between;align-items:center;" onmouseover="this.style.background=\'#f8fafc\'" onmouseout="this.style.background=\'\'">' +
      '<div><span style="font-weight:700;">' + i.name + '</span><div style="font-size:11px;color:#94a3b8;">' + i.category + '</div></div>' +
      '<span style="font-size:12px;color:' + (low?'#ef4444':'#16a34a') + ';font-weight:800;">' + i.stock + ' ' + i.unit + (low?' ⚠':'') + '</span></div>';
  }).join('');
  box.style.display = 'block';
};

window.shrAddItem = function(id) {
  var item = _shrAllItems.find(function(i) { return i.id === id; });
  if (!item || _shrCart.some(function(c) { return c.id === id; })) return;
  var deficit = Math.max(0, item.minStock - item.stock);
  _shrCart.push({
    id: item.id, name: item.name, unit: item.unit, bigUnit: item.bigUnit, convRate: item.convRate,
    stock: item.stock, minStock: item.minStock, cost: item.cost,
    requestedQty: deficit > 0 ? deficit : 1
  });
  _saveShrCart();
  q('#shrSearch').value = '';
  q('#shrSearchResults').style.display = 'none';
  _shrRenderCart();
};

window.shrRemoveItem = function(idx) {
  _shrCart.splice(idx, 1);
  _saveShrCart();
  _shrRenderCart();
};

window.shrUpdateQty = function(idx, val) {
  if (_shrCart[idx]) { _shrCart[idx].requestedQty = Math.max(1, Number(val) || 1); _saveShrCart(); }
};

function _shrRenderCart() {
  var tb = q('#shrBody');
  if (!tb) return;
  if (!_shrCart.length) {
    tb.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:30px;color:#94a3b8;"><i class="fas fa-search" style="font-size:20px;display:block;margin-bottom:6px;"></i>' + t('searchToAdd') + '</td></tr>';
    return;
  }
  tb.innerHTML = _shrCart.map(function(c, i) {
    var low = c.stock <= c.minStock;
    var deficit = c.minStock - c.stock;
    var deficitHtml = deficit > 0 ? '<span style="color:#ef4444;font-weight:800;">-' + deficit.toFixed(0) + '</span>' : '<span style="color:#16a34a;">0</span>';
    return '<tr>' +
      '<td style="font-weight:700;font-size:12px;">' + c.name + '</td>' +
      '<td style="text-align:center;font-weight:700;color:' + (low?'#ef4444':'#16a34a') + ';">' + c.stock + '</td>' +
      '<td style="text-align:center;color:#64748b;">' + c.minStock + '</td>' +
      '<td style="text-align:center;"><input type="number" min="1" step="1" value="' + c.requestedQty + '" style="width:55px;padding:5px;border:1.5px solid #e2e8f0;border-radius:8px;text-align:center;font-weight:800;font-size:13px;" onchange="shrUpdateQty(' + i + ',this.value)"></td>' +
      '<td style="text-align:center;font-size:11px;color:#64748b;">' + c.unit + '</td>' +
      '<td style="text-align:center;">' + deficitHtml + '</td>' +
      '<td style="text-align:center;"><button onclick="shrRemoveItem(' + i + ')" style="border:none;background:none;color:#ef4444;cursor:pointer;font-size:14px;"><i class="fas fa-trash"></i></button></td>' +
    '</tr>';
  }).join('');
}

window.submitShortageRequest = function() {
  if (!_shrCart.length) return glassToast(t('stAddFirst'), true);
  var items = _shrCart.map(function(c) {
    return { invItemId: c.id, invItemName: c.name, unit: c.unit, currentQty: c.stock, minQty: c.minStock, requestedQty: c.requestedQty, unitPrice: c.cost };
  });
  var isEdit = !!_shrEditingId;
  var confirmMsg = isEdit
    ? (state.lang==='en' ? 'Save changes to the request?' : 'حفظ التعديلات على الطلب؟')
    : t('stConfirmMsg').replace('{n}', items.length);

  glassConfirm(t('shortageRequest'), confirmMsg, {}).then(function(ok) {
    if (!ok) return;
    loader(true);

    if (isEdit) {
      // UPDATE existing pending request
      api.withSuccessHandler(function(r) {
        loader(false);
        if (r && r.success) {
          closeGlassModal('#modalShortage');
          glassToast(state.lang==='en' ? 'Request updated' : 'تم تحديث الطلب');
          _shrCart = []; localStorage.removeItem('pos_shortage_cart');
          _shrEditingId = null;
        } else glassToast((r && r.error) || t('errorTitle'), true);
      }).withFailureHandler(function() { loader(false); glassToast(t('errorTitle'), true); })
        .updateShortageRequest(_shrEditingId, { items: items, notes: (q('#shrNotes')||{}).value || '' });
    } else {
      // CREATE new request
      api.withSuccessHandler(function(r) {
        loader(false);
        if (r && r.success) {
          closeGlassModal('#modalShortage');
          glassToast(t('shortageRequest') + ': ' + r.requestNumber);
          _shrCart = []; localStorage.removeItem('pos_shortage_cart');
        } else glassToast((r && r.error) || t('errorTitle'), true);
      }).withFailureHandler(function() { loader(false); glassToast(t('errorTitle'), true); })
        .createShortageRequest({ items: items, username: state.user, notes: (q('#shrNotes')||{}).value || '' });
    }
  });
};
