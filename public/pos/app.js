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
  // v5.14.0 — Foodics-mode wires up the category grid + total bar +
  // payment modal layers. Legacy in-cart pieces (channel/discount/pay)
  // get hidden via body.foodics-mode CSS.
  document.body.classList.add('foodics-mode');
  state.posView = 'categories';
  renderCategoryGrid();
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
    // Store branch/brand/warehouse context for inventory operations
    state.brandId = res.brandId || '';
    state.branchId = res.branchId || '';
    state.warehouseId = res.warehouseId || '';

    try { localStorage.setItem('pos_menu_cache', JSON.stringify({ ts: Date.now(), menu: state.menu })); } catch (e) {}
    saveState();

    // ─── V3: load richer payment methods + active channels + discounts ───
    posLoadV3Data();

    renderPayButtons();
    // v5.14.0 — rebuild Foodics category grid with fresh menu
    if (typeof renderCategoryGrid === 'function') renderCategoryGrid();
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

  // v5.12.2 — channel filter: only items added to the active channel are
  // shown. MAIN channel with no overrides defaults to the full menu via
  // useFullMenu=true so the cashier doesn't lose Dine-In.
  var channelEmpty = false;
  if (state.activeChannel && !state.activeChannel.useFullMenu) {
    var allowedSet = new Set((state.channelMenuItems || []).map(function (r) {
      return String(r.menuItemId);
    }));
    if (allowedSet.size === 0) {
      list = [];
      channelEmpty = true;
    } else {
      list = list.filter(function (i) { return allowedSet.has(String(i.id)); });
    }
  }

  // v5.13.0 — append custom items from the active channel's price list.
  // They're virtual rows that bypass the channel filter (they belong to
  // THIS channel by definition) so they always appear when the channel
  // is selected.
  if (state._channelCustomItems && state._channelCustomItems.length) {
    list = list.concat(state._channelCustomItems);
    channelEmpty = false;
  }

  if (state.activeCat) list = list.filter(function(i) { return i.category === state.activeCat; });
  if (searchTerm) list = list.filter(function(i) {
    return (i.name || '').toLowerCase().includes(searchTerm) || String(i.id || '').toLowerCase().includes(searchTerm);
  });

  var h = '';
  if (!list.length) {
    // v5.12.6 — distinguish between (a) the channel filter eliminated
    // everything and (b) the user's brand has no menu items loaded.
    var emptyMsg;
    if (channelEmpty) {
      emptyMsg = 'لا توجد أصناف مَفعَّلة لهذه القناة';
    } else if (!(state.menu || []).length) {
      emptyMsg = 'لم يَتم تَحميل المنيو · تَحقَّق من أنه تَم ربط أصناف بحساب الفرع/البراند';
    } else {
      emptyMsg = t('noProducts');
    }
    h = '<div style="grid-column:1/-1;text-align:center;padding:50px 20px;color:#94a3b8;"><i class="fas fa-box-open" style="font-size:54px;margin-bottom:14px;display:block;opacity:0.35;"></i><div style="font-weight:700;">' + emptyMsg + '</div></div>';
  } else {
    list.forEach(function(i) {
      var inCart = state.cart.find(function(c) { return c.id === i.id; });
      var qty = inCart ? inCart.qty : 0;
      var isSel = !!inCart;
      // v5.12.7 — optional product image at the top of the card
      var img = i.imageData || i.image_data;
      var imgHtml = img
        ? '<div class="pos-item-img"><img src="' + img + '" loading="lazy" alt=""></div>'
        : '';
      // v5.13.0 — badge for standalone (custom) price-list items
      var customBadge = i.__custom
        ? '<div style="position:absolute;top:6px;inset-inline-start:6px;background:#f59e0b;color:#fff;font-size:9px;font-weight:800;padding:2px 6px;border-radius:6px;z-index:1;">مُخصَّص</div>'
        : '';
      var safeJson = JSON.stringify(i).replace(/'/g, '&#39;');
      h += '<div class="pos-item ' + (isSel ? 'selected' : '') + '" style="position:relative;">' +
        customBadge +
        imgHtml +
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
  // V5.7.16 — translate freshly-rendered menu cards (product names from DB)
  if (typeof window.translateNow === 'function') window.translateNow(q('#posItemsGrid'));
};

// ============================================
// v5.14.0 — Foodics-style category navigation
// ============================================
function _posCategoryIcon(c) {
  var n = String(c || '').toLowerCase();
  if (/قهوة|coffee|اسبر|espress|كافي/.test(n)) return 'fa-mug-hot';
  if (/شاي|tea|كرك|karak/.test(n)) return 'fa-leaf';
  if (/بارد|cold|عصير|juice|smooth|frap/.test(n)) return 'fa-glass-water';
  if (/كيك|cake|حلو|sweet|dessert|بسبوس|كنافه/.test(n)) return 'fa-cake-candles';
  if (/كومبو|combo|وجب|meal/.test(n)) return 'fa-utensils';
  if (/هدايا|gift|بوكس|box/.test(n)) return 'fa-gift';
  if (/تذكار|merch|قميص|shirt/.test(n)) return 'fa-shirt';
  if (/معجن|pastr|سندو|sandwich|كرواس|croiss/.test(n)) return 'fa-bread-slice';
  if (/ساخن|hot/.test(n)) return 'fa-fire';
  return 'fa-utensils';
}

window.renderCategoryGrid = function () {
  var grid = q('#posCatGrid');
  if (!grid) return;
  var cats = (state.categories || []).filter(function (c) { return c && String(c).trim(); });
  // Build the menu count for each category up-front
  var menuActive = (state.menu || []).filter(function (m) { return m.active; });
  // v5.14.7 — Apply the channel filter to category counts so the tile
  // numbers match what the cashier will see after clicking through.
  // Without this, a delivery channel with 3 items would still show the
  // full menu's per-category counts on the category grid.
  if (state.activeChannel && !state.activeChannel.useFullMenu) {
    var _chAllowed = new Set((state.channelMenuItems || []).map(function (r) { return String(r.menuItemId); }));
    menuActive = menuActive.filter(function (m) { return _chAllowed.has(String(m.id)); });
    // Include channel-only custom items from the price list so their
    // categories light up too.
    if (state._channelCustomItems && state._channelCustomItems.length) {
      menuActive = menuActive.concat(state._channelCustomItems);
    }
  }
  if (!cats.length) {
    grid.innerHTML = '<div class="pos-empty"><i class="fas fa-box-open" style="font-size:48px;display:block;margin-bottom:14px;opacity:.4;"></i>لا توجد فئات — تَأكَّد من تَحميل المنيو</div>';
    return;
  }
  var esc = function (s) { return String(s).replace(/[&<>"'\\]/g, function (c) { return '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4); }); };
  var html = '<div class="pos-cat-tile pos-cat-all" onclick="posShowAllProducts()">' +
              '<i class="fas fa-th-large"></i>' +
              '<span class="pos-cat-name">الكل</span>' +
              '<span class="pos-cat-count">' + menuActive.length + '</span>' +
            '</div>';
  cats.forEach(function (c) {
    var count = menuActive.filter(function (m) { return m.category === c; }).length;
    if (count === 0) return; // hide empty cats
    var icon = _posCategoryIcon(c);
    var safeName = String(c).replace(/</g, '&lt;');
    var safeAttr = String(c).replace(/'/g, '&#39;');
    html += '<div class="pos-cat-tile" onclick="posEnterCategory(\'' + safeAttr + '\')">' +
              '<i class="fas ' + icon + '"></i>' +
              '<span class="pos-cat-name">' + safeName + '</span>' +
              '<span class="pos-cat-count">' + count + '</span>' +
            '</div>';
  });
  grid.innerHTML = html;
  if (typeof window.translateNow === 'function') window.translateNow(grid);
};

window.posEnterCategory = function (cat) {
  state.activeCat = cat;
  state.posView = 'products';
  var grid = q('#posCatGrid');     if (grid) grid.style.display = 'none';
  var prods = q('#posItemsGrid');  if (prods) prods.style.display = '';
  var bc = q('#posBreadcrumb');    if (bc) bc.style.display = 'flex';
  var cur = q('#posBreadcrumbCurrent'); if (cur) cur.textContent = cat;
  renderMenuGrid();
};

window.posShowAllProducts = function () {
  state.activeCat = '';
  state.posView = 'products';
  var grid = q('#posCatGrid');     if (grid) grid.style.display = 'none';
  var prods = q('#posItemsGrid');  if (prods) prods.style.display = '';
  var bc = q('#posBreadcrumb');    if (bc) bc.style.display = 'flex';
  var cur = q('#posBreadcrumbCurrent'); if (cur) cur.textContent = t('allItems') || 'كل المنتجات';
  renderMenuGrid();
};

window.posBackToCategories = function () {
  state.activeCat = '';
  state.posView = 'categories';
  var search = q('#posSearchInput'); if (search) search.value = '';
  var grid = q('#posCatGrid');     if (grid) grid.style.display = 'grid';
  var prods = q('#posItemsGrid');  if (prods) prods.style.display = 'none';
  var bc = q('#posBreadcrumb');    if (bc) bc.style.display = 'none';
  renderCategoryGrid();
};

// Top action-bar channel selector mirrors the legacy one in cart-area.
// Onchange triggers the same posSetChannel path.
window.posOnChannelTopChange = function () {
  var sel = q('#posChannelSelTop');
  if (!sel || !sel.value) return;
  posSetChannel(sel.value);
  // sync legacy select if present
  var legacy = q('#posChannelSel');
  if (legacy) legacy.value = sel.value;
};

// v5.14.1 — Foodics payment modal driver. Renders big payment-method
// tiles + a smart split panel that pulls every active method, lets the
// cashier auto-distribute the total equally or fill the remainder per
// row. The legacy hidden #posPayMethod input still drives doCheckout.
function _foodicsCartTotal() {
  var sub = (state.cart || []).reduce(function (s, c) {
    return s + (Number(c.qty) || 0) * (Number(c.price) || 0);
  }, 0);
  var disc = (state.currentDiscount && state.currentDiscount.amount) || 0;
  return Math.max(0, sub - disc);
}

window.renderFoodicsPayTiles = function () {
  var host = q('#payTilesGrid');
  if (!host) return;
  var methods = (state.paymentMethods || []).filter(function (m) {
    return m.IsActive !== false && m.IsActive !== 'FALSE';
  });
  var current = q('#posPayMethod') ? q('#posPayMethod').value : 'Cash';
  var isEn = state.lang === 'en';
  var iconFor = function (n, m) {
    var k = String(n || '').toLowerCase();
    if (m && m.Icon) return m.Icon;
    if (k === 'cash')   return 'fa-money-bill-wave';
    if (k === 'card')   return 'fa-credit-card';
    if (k === 'kita')   return 'fa-calculator';
    if (k === 'split')  return 'fa-divide';
    if (/hunger/.test(k)) return 'fa-motorcycle';
    return 'fa-money-bill';
  };
  var labelFor = function (m) {
    var lower = String(m.Name || '').toLowerCase();
    if (lower === 'cash' || lower === 'card' || lower === 'kita') return t(lower);
    return isEn ? (m.Name || m.NameAR) : (m.NameAR || m.Name);
  };
  var html = '';
  methods.forEach(function (m) {
    var active = m.Name === current ? ' is-active' : '';
    html += '<button type="button" class="pay-tile' + active + '" onclick="setFoodicsPay(\'' + String(m.Name).replace(/'/g, "\\'") + '\')">' +
              '<i class="fas ' + iconFor(m.Name, m) + '"></i>' +
              '<span>' + labelFor(m) + '</span>' +
            '</button>';
  });
  html += '<button type="button" class="pay-tile pay-tile-split' + (current === 'Split' ? ' is-active' : '') +
          '" onclick="setFoodicsPay(\'Split\')">' +
            '<i class="fas fa-divide"></i><span>' + (t('split') || 'تَجزئة') + '</span></button>';
  host.innerHTML = html;
};

window.setFoodicsPay = function (name) {
  // Drives the existing hidden #posPayMethod field used by doCheckout.
  if (typeof setPayMethod === 'function') setPayMethod(name);
  renderFoodicsPayTiles();
  var panel = q('#paySplitFoodics');
  if (panel) panel.classList.toggle('hidden', name !== 'Split');
  if (name === 'Split') renderFoodicsSplitFields();
};

window.renderFoodicsSplitFields = function () {
  var host = q('#paySplitFields');
  if (!host) return;
  // Show EVERY active method (not just cash + card) so the cashier
  // can split however they need.
  var methods = (state.paymentMethods || []).filter(function (m) {
    var n = String(m.Name || '').toLowerCase();
    return n !== 'split' && m.IsActive !== false && m.IsActive !== 'FALSE';
  });
  var isEn = state.lang === 'en';
  var iconFor = function (n, m) {
    if (m && m.Icon) return m.Icon;
    var k = String(n || '').toLowerCase();
    if (k === 'cash') return 'fa-money-bill-wave';
    if (k === 'card') return 'fa-credit-card';
    if (k === 'kita') return 'fa-calculator';
    if (/hunger/.test(k)) return 'fa-motorcycle';
    return 'fa-money-bill';
  };
  var labelFor = function (m) {
    var lower = String(m.Name || '').toLowerCase();
    if (lower === 'cash' || lower === 'card' || lower === 'kita') return t(lower);
    return isEn ? (m.Name || m.NameAR) : (m.NameAR || m.Name);
  };
  // Note: each input ALSO carries class "split-input" so the legacy
  // doCheckout split-extraction code (which reads .split-input) still
  // sees the values.
  host.innerHTML = methods.map(function (m) {
    var safe = String(m.Name || '').replace(/'/g, "\\'");
    return (
      '<div class="pay-split-row">' +
        '<div class="pay-split-method"><i class="fas ' + iconFor(m.Name, m) + '"></i> ' + labelFor(m) + '</div>' +
        '<input type="number" step="0.01" min="0" class="form-control pay-split-input split-input" ' +
               'data-method="' + safe + '" value="" placeholder="0.00" oninput="paySplitRecalc()">' +
        '<button type="button" class="pay-split-rest" onclick="paySplitFillRest(\'' + safe + '\')" title="املأ بالمتبقي"><i class="fas fa-equals"></i></button>' +
      '</div>'
    );
  }).join('');
  paySplitRecalc();
};

window.paySplitRecalc = function () {
  var total = _foodicsCartTotal();
  var paid = 0;
  qs('.pay-split-input').forEach(function (el) { paid += Number(el.value) || 0; });
  var rem = total - paid;
  var paidEl = q('#paySplitPaid'); if (paidEl) paidEl.textContent = paid.toFixed(2);
  var remEl  = q('#paySplitRemaining');
  if (remEl) {
    remEl.textContent = rem.toFixed(2);
    remEl.style.color = Math.abs(rem) < 0.01 ? '#16a34a' : (rem > 0 ? '#ef4444' : '#f59e0b');
  }
  // Mirror to legacy element for backward compat
  var legacy = q('#splitRemaining');
  if (legacy) legacy.textContent = rem.toFixed(2);
};

window.paySplitAutoDistribute = function () {
  var inputs = Array.prototype.slice.call(qs('.pay-split-input'));
  if (!inputs.length) return;
  var total = _foodicsCartTotal();
  if (total <= 0) {
    inputs.forEach(function (el) { el.value = ''; });
    return paySplitRecalc();
  }
  var per = total / inputs.length;
  inputs.forEach(function (el, idx) {
    if (idx < inputs.length - 1) {
      el.value = per.toFixed(2);
    } else {
      var sumOthers = (inputs.length - 1) * Number(per.toFixed(2));
      el.value = Math.max(0, total - sumOthers).toFixed(2);
    }
  });
  paySplitRecalc();
};

window.paySplitClear = function () {
  qs('.pay-split-input').forEach(function (el) { el.value = ''; });
  paySplitRecalc();
};

window.paySplitFillRest = function (methodName) {
  var inputs = Array.prototype.slice.call(qs('.pay-split-input'));
  var total = _foodicsCartTotal();
  var otherSum = 0;
  inputs.forEach(function (el) {
    if (el.dataset.method !== methodName) otherSum += Number(el.value) || 0;
  });
  inputs.forEach(function (el) {
    if (el.dataset.method === methodName) {
      el.value = Math.max(0, total - otherSum).toFixed(2);
    }
  });
  paySplitRecalc();
};

window.posOpenPaymentModal = function () {
  if (!state.cart || !state.cart.length) {
    if (typeof glassToast === 'function') glassToast(t('emptyCart') || 'السلة فارغة', true);
    return;
  }
  // Sync summary text
  var sub = q('#cartSubtotalText'), disc = q('#cartDiscText'), tot = q('#cartFinalTotal');
  if (sub)  q('#payModalSubtotal').textContent = sub.textContent;
  if (disc) q('#payModalDiscount').textContent = disc.textContent;
  if (tot)  q('#payModalTotal').textContent    = tot.textContent;
  // Render tiles + reset split state
  renderFoodicsPayTiles();
  var currentMethod = q('#posPayMethod') ? q('#posPayMethod').value : 'Cash';
  var splitPanel = q('#paySplitFoodics');
  if (splitPanel) splitPanel.classList.toggle('hidden', currentMethod !== 'Split');
  if (currentMethod === 'Split') renderFoodicsSplitFields();
  openGlassModal('#modalPayment');
};

// v5.14.4 — The cart footer is a role="button" surface (no inner
// <button>), so Space/Enter must be wired manually to keep it
// keyboard-accessible.
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  var el = e.target;
  if (el && el.classList && el.classList.contains('cart-footer-foodics')) {
    e.preventDefault();
    window.posOpenPaymentModal();
  }
});

// v5.14.2 — Foodics overlay sync moved INTO updateCart itself (see
// further down in this file). The old IIFE wrapper here was wrapping
// `window.updateCart` BEFORE the real function was defined later on,
// so the real definition overwrote the wrapper and the sync never
// ran — that's why the cart-sidebar total button was stuck at 0.00.

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
  // V5.7.16 — translate cart items (product names from DB) on every render
  if (typeof window.translateNow === 'function') window.translateNow(q('#cartItemsArea'));

  if (state.currentDiscount.amount > subtotal) state.currentDiscount.amount = subtotal;
  var afterDiscount = subtotal - state.currentDiscount.amount;

  // V5.7.15 — service-fee functionality REMOVED from the cashier UI per user
  //   request ("don't want this box at all"). Fees are now uniformly zero
  //   regardless of payment method. Order totals = subtotal − discount.
  var serviceFee = 0;
  var finalTotal = afterDiscount;

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

  // v5.14.4 — Sync the single clickable total in the cart footer.
  // The old #posTotalBar sticky overlay and the .checkout-total-btn
  // wrapper were removed in v5.14.4; #ctbAmount is the only remaining
  // consumer of the total.
  try {
    var ftxt = q('#cartFinalTotal') ? q('#cartFinalTotal').innerText : '0.00';
    var fctb = q('#ctbAmount'); if (fctb) fctb.textContent = ftxt;
  } catch (e) { /* footer not mounted yet */ }

  // Re-render the menu so + buttons reflect the new qty
  renderMenuGrid();
};

window.toggleMobileCart = function() {
  var cartPanel = q('#mobileCartPanel');
  if (cartPanel) cartPanel.classList.toggle('open');
};

window.setPayMethod = function(m) {
  q('#posPayMethod').value = m;
  updateCart();
};
// V5.7.15 — kept as no-op for back-compat; the input no longer exists in the UI
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

  // V5.7.15 — service fee removed from cashier UI (user request).
  //   Order total is just subtotal − discount. Split payments still validated.
  var serviceFee = 0;
  var totalFinal = afterDiscount;
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
  }

  var order = {
    items: state.cart,
    total: sub,
    totalFinal: totalFinal,
    paymentMethod: payMethod,
    discountName: state.currentDiscount.name,
    discountAmount: state.currentDiscount.amount,
    kitaServiceFee: serviceFee,
    splitDetails: splitDetails,
    // ─── V3 metadata: channel + discount IDs (for reports + GL routing) ───
    channelId: state.activeChannel ? state.activeChannel.id : null,
    channelName: state.activeChannel ? state.activeChannel.name : null,
    discountId: state.currentDiscount.discountId || null,
    discountGlAccountId: state.currentDiscount.glAccountId || null,
    lineDiscounts: Object.keys(state.lineDiscounts || {}).length ? state.lineDiscounts : null
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
      // v5.14.0 — close the Foodics payment modal on successful sale
      if (typeof closeGlassModal === 'function') closeGlassModal('#modalPayment');
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

  // V5.7.15 — service fee removed; always send directly
  send();
};

// =========================================
// Receipt
// =========================================
// V5.7.9 — Receipt template redesigned to mirror the printed bilingual sample exactly:
//   • English labels on the LEFT, Arabic equivalent stacked beneath in smaller dim text
//   • "Welcome to {BRANCH}" header + branch address (from branch definition)
//   • "Merchant copy" / "نسخة بطاقات التاجر" badge bar
//   • 3-column Total / Net / VAT grid in a bordered box
//   • Cashier line shows registered FULL NAME + employee number
//   • Footer: "All Prices include VAT (15%)" + Tel + Email (from settings)
window.printReceipt = function(orderId) {
  api.withSuccessHandler(function(inv) {
    if (!inv) return;
    var dt = new Date(inv.date);
    // Match the printed sample's date format: "Apr 30, 2026 2:43:43 AM"
    var dateStr = dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ' ' +
                  dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });

    // Prefer per-invoice fields (returned by V5.7.9+ backend) and fall back to state
    var companyName       = inv.companyName       || (state.settings && state.settings.name) || 'Moroccan Taste';
    var companyNameAr     = 'المذاق المغربي';
    var taxNumber         = inv.taxNumber         || (state.settings && state.settings.taxNumber) || '';
    var currency          = inv.currency          || (state.settings && state.settings.currency) || 'SAR';
    var companyPhone      = inv.companyPhone      || (state.settings && state.settings.companyPhone) || '';
    var companyEmail      = inv.companyEmail      || (state.settings && state.settings.companyEmail) || '';
    var branchName        = inv.branchName        || (state.settings && state.settings.branchName) || '';
    var branchAddr        = inv.branchAddress     || (state.settings && state.settings.branchAddress) || '';
    // V5.7.14 — operating company name per branch (printed under parent brand)
    var branchCompanyName = inv.branchCompanyName || '';
    var cashierName       = inv.cashierName       || inv.username || state.user;
    var cashierEmpNo      = inv.cashierEmpNo      || inv.username || '';
    // V5.7.26 — prefer brand-specific logo (returned by /sales/invoice as
    //   receiptLogo) over the company-wide one
    var logoUrl           = inv.receiptLogo       || inv.brandLogo || inv.companyLogo || (state.settings && state.settings.logo) || '';

    // V5.7.29 — clean 3-column items layout (Qty | Item+@price | Total).
    //   Replaces the cramped 4-col table that was hard to read on 80mm
    //   thermal paper. Now: QTY (left, monospace), ITEM (flex-fill with
    //   small unit-price subtitle), TOTAL (right, monospace). All
    //   columns share the same vertical baseline → consistent alignment.
    var totalItems = 0;
    var itemsHtml = '';
    (inv.items || []).forEach(function(i) {
      var qty = Number(i.qty) || 0;
      totalItems += qty;
      var unitPrice = qty > 0 ? (Number(i.total) / qty) : Number(i.price || 0);
      itemsHtml +=
        '<tr style="direction:ltr;border-bottom:1px dotted #cbd5e1;">' +
          '<td style="text-align:center;font-size:13px;padding:7px 2px;font-family:ui-monospace,SFMono-Regular,monospace;font-weight:700;vertical-align:top;width:38px;">' + qty + '×</td>' +
          '<td style="text-align:left;font-size:12.5px;padding:7px 6px;font-weight:600;line-height:1.3;">' +
            i.name +
            '<div style="font-size:10px;color:#888;font-weight:400;font-family:ui-monospace,SFMono-Regular,monospace;margin-top:2px;">@ ' + formatVal(unitPrice) + '</div>' +
          '</td>' +
          '<td style="text-align:right;font-size:13px;padding:7px 2px;font-family:ui-monospace,SFMono-Regular,monospace;font-weight:700;vertical-align:top;width:62px;">' + formatVal(i.total) + '</td>' +
        '</tr>';
    });
    var netAmount = Number(inv.totalFinal) / 1.15;
    var vatAmount = Number(inv.totalFinal) - netAmount;

    var logoTag = logoUrl
      ? '<div style="text-align:center;margin-bottom:4px;"><img src="' + logoUrl + '" style="max-width:90px;max-height:90px;object-fit:contain;"></div>'
      : '';

    // Format helpers: bilingual line with EN on the left, AR small/dim underneath
    function biLine(en, ar, opts) {
      opts = opts || {};
      var fs = opts.fs || '12px';
      var weight = opts.bold ? '700' : '400';
      return '<div style="text-align:center;line-height:1.25;margin-bottom:'+(opts.mb||4)+'px;">' +
        '<div style="font-size:'+fs+';color:'+(opts.color||'#222')+';font-weight:'+weight+';">' + en + '</div>' +
        (ar ? '<div style="font-size:10px;color:#777;direction:rtl;">' + ar + '</div>' : '') +
      '</div>';
    }
    function rowSplit(left, right, opts) {
      opts = opts || {};
      return '<div style="display:flex;justify-content:space-between;align-items:center;font-size:'+(opts.fs||'12px')+';margin:'+(opts.my||3)+'px 0;">' +
        '<span style="color:#222;">' + left + '</span>' +
        '<span style="color:#222;font-weight:'+(opts.bold?'700':'400')+';font-family:monospace;">' + right + '</span>' +
      '</div>';
    }

    // V5.7.14 — receipt header: clean 3-line ownership hierarchy.
    //   Line 1 (largest):  المذاق المغربي / Moroccan Taste   ← parent brand
    //   Line 2 (medium):   <branch.company_name>             ← operating company
    //   Line 3 (subtitle): Simplified TAX Invoice / فاتورة ضريبية مبسطة
    //   Line 4:            Tax: <taxNumber>
    //   Line 5 (bold):     <branch.name>                     ← branch
    //   Line 6 (small):    <branch.location>                 ← branch address
    // All lines centered. Arabic-text divs explicitly carry direction:rtl
    // so mixed AR/EN content never drifts to the wrong side.
    var h = logoTag +
      // ── 1. Parent brand ──
      '<div style="text-align:center;font-size:13px;font-weight:700;direction:rtl;margin-bottom:1px;">' + companyNameAr + '</div>' +
      '<div style="text-align:center;font-size:18px;font-weight:900;direction:ltr;margin-bottom:' + (branchCompanyName ? '2' : '6') + 'px;">' + companyName + '</div>' +

      // ── 2. Operating company (the per-branch entity) ──
      (branchCompanyName
        ? '<div style="text-align:center;font-size:12px;font-weight:700;color:#0f172a;direction:rtl;margin-bottom:6px;border-bottom:1px solid #e5e7eb;padding-bottom:6px;">' + branchCompanyName + '</div>'
        : ''
      ) +

      // ── 3. Tax invoice subtitle (bilingual) ──
      biLine('Simplified TAX Invoice', 'فاتورة ضريبية مبسطة', { fs:'12px', color:'#444', mb:6 }) +

      // ── 4. Tax registration ──
      (taxNumber ? '<div style="text-align:center;font-size:11px;color:#444;margin-bottom:6px;font-family:monospace;direction:ltr;">' + taxNumber + '</div>' : '') +

      // ── 5. Branch name (welcome banner) ──
      (branchName ? '<div style="text-align:center;font-size:12px;font-weight:700;direction:ltr;margin-top:4px;">Welcome To ' + branchName.toUpperCase() + '</div>' : '') +

      // ── 6. Branch address (RTL, dim) ──
      (branchAddr ? '<div style="text-align:center;font-size:10px;color:#555;direction:rtl;margin-bottom:6px;">' + branchAddr + '</div>' : '') +

      '<div style="border-top:1px solid #000;margin:8px 0;"></div>' +

      // V5.7.20 — Merchant copy badge wrapped in a centered div so the
      //           inline-block sits dead-center (was drifting to the
      //           start side of the receipt before).
      '<div style="text-align:center;margin-bottom:8px;">' +
        '<div style="background:#000;color:#fff;text-align:center;padding:4px 12px;font-weight:700;font-size:12px;display:inline-block;border-radius:2px;">' +
          'Merchant copy <span style="font-size:10px;opacity:0.85;direction:rtl;">| نسخة بطاقات التاجر</span>' +
        '</div>' +
      '</div>' +
      '<div style="text-align:center;font-size:13px;font-weight:700;margin-bottom:8px;">Tax Invoice <span style="font-size:11px;color:#666;direction:rtl;">| فاتورة ضريبية</span></div>' +

      // ── ID + Date (bilingual rows) ──
      rowSplit('ID <small style="color:#888;">المعرف</small>', inv.orderId, { bold:true }) +
      rowSplit('Date <small style="color:#888;">التاريخ</small>', dateStr) +

      '<div style="border-top:1px dashed #000;margin:8px 0;"></div>' +

      // ── V5.7.29 — 3-column items table optimized for 80mm thermal paper ──
      //   QTY (small, centered)  |  ITEM (flex, left, w/ @unitPrice subtitle)  |  TOTAL (right, monospace)
      //   Header is uppercase + slightly tracked so it reads as a "header" row.
      '<table style="width:100%;border-collapse:collapse;direction:ltr;table-layout:fixed;">' +
        '<thead><tr style="border-bottom:1.5px solid #000;">' +
          '<th style="text-align:center;font-size:10px;padding:5px 2px;color:#444;font-weight:700;letter-spacing:0.05em;width:38px;">QTY</th>' +
          '<th style="text-align:left;font-size:10px;padding:5px 6px;color:#444;font-weight:700;letter-spacing:0.05em;">ITEM</th>' +
          '<th style="text-align:right;font-size:10px;padding:5px 2px;color:#444;font-weight:700;letter-spacing:0.05em;width:62px;">TOTAL ' + currency + '</th>' +
        '</tr></thead>' +
        '<tbody>' + itemsHtml + '</tbody>' +
      '</table>' +

      '<div style="border-top:1px dashed #000;margin:8px 0;"></div>' +

      // ── Total Items count, centered ──
      '<div style="text-align:center;margin:8px 0;">' +
        '<div style="font-size:10px;color:#777;direction:rtl;">عدد الأصناف</div>' +
        '<div style="font-size:13px;font-weight:700;">Total Items</div>' +
        '<div style="font-size:18px;font-weight:900;">' + totalItems + '</div>' +
      '</div>' +

      // ── 3-column Total / Net / VAT grid (bordered box like the sample) ──
      '<table style="width:100%;border-collapse:collapse;border:1px solid #000;margin:10px 0;">' +
        '<tr style="border-bottom:1px solid #000;">' +
          '<td style="text-align:center;padding:6px;border-right:1px solid #000;font-size:11px;font-weight:700;">' +
            'Total<br>Value<div style="font-size:9px;color:#666;direction:rtl;">إجمالي القيمة</div></td>' +
          '<td style="text-align:center;padding:6px;border-right:1px solid #000;font-size:11px;font-weight:700;">' +
            'Net Amount<div style="font-size:9px;color:#666;direction:rtl;">المبلغ قبل الضريبة</div></td>' +
          '<td style="text-align:center;padding:6px;font-size:11px;font-weight:700;">' +
            'VAT Amount<div style="font-size:9px;color:#666;direction:rtl;">ضريبة القيمة المضافة 15%</div></td>' +
        '</tr>' +
        '<tr>' +
          '<td style="text-align:center;padding:8px;border-right:1px solid #000;font-size:15px;font-weight:900;">' + formatVal(inv.totalFinal) + '</td>' +
          '<td style="text-align:center;padding:8px;border-right:1px solid #000;font-size:15px;font-weight:900;">' + netAmount.toFixed(2) + '</td>' +
          '<td style="text-align:center;padding:8px;font-size:15px;font-weight:900;">' + vatAmount.toFixed(2) + '</td>' +
        '</tr>' +
      '</table>' +

      // ── Payment method + amount ──
      rowSplit((inv.payment || 'Visa') + ' <span style="font-size:10px;color:#888;direction:rtl;">| ' + (inv.payment || 'Visa') + '</span>', formatVal(inv.totalFinal), { bold:true }) +

      '<div style="border-top:1px dashed #000;margin:6px 0;"></div>' +

      // ── Cashier line: full name + employee number ──
      '<div style="text-align:center;font-size:11px;color:#222;margin:6px 0;">' +
        'You were served by : <strong>' + cashierName + (cashierEmpNo && cashierEmpNo !== cashierName ? ', ' + cashierEmpNo : '') + '</strong>' +
        '<div style="font-size:10px;color:#777;direction:rtl;">قدّم لكم الخدمة: ' + cashierName + '</div>' +
      '</div>' +

      // ── ZATCA QR code ──
      '<div id="receiptQR" style="text-align:center;margin:12px auto;width:150px;height:150px;"></div>' +

      // ── Footer: VAT note + Tel + Email ──
      '<div style="text-align:center;font-size:10px;color:#222;margin-top:8px;">All Prices include VAT (15%)</div>' +
      '<div style="text-align:center;font-size:10px;color:#666;direction:rtl;margin-bottom:4px;">جميع الأسعار شاملة الضريبة المضافة (15%)</div>' +
      (companyPhone ? '<div style="text-align:center;font-size:11px;color:#222;margin-top:4px;font-family:monospace;">Tel: ' + companyPhone + '</div>' : '') +
      (companyEmail ? '<div style="text-align:center;font-size:11px;color:#222;font-family:monospace;">Email: ' + companyEmail + '</div>' : '');

    q('#receiptBox').innerHTML = h;
    state._lastReceipt = {
      inv: inv, html: h,
      companyName: companyName, companyNameAr: companyNameAr,
      branchCompanyName: branchCompanyName,  // V5.7.14
      taxNumber: taxNumber, currency: currency,
      companyPhone: companyPhone, companyEmail: companyEmail,
      branchName: branchName, branchAddr: branchAddr,
      cashierName: cashierName, cashierEmpNo: cashierEmpNo,
      logoUrl: logoUrl, dateStr: dateStr,
      totalItems: totalItems, netAmount: netAmount, vatAmount: vatAmount
    };
    openGlassModal('#modalReceipt');

    setTimeout(function() {
      var qrEl = document.getElementById('receiptQR');
      if (qrEl && typeof QRCode !== 'undefined') {
        qrEl.innerHTML = '';
        var tlvBase64 = generateZATCA_TLV(companyName, taxNumber, new Date(inv.date).toISOString(), formatVal(inv.totalFinal), vatAmount.toFixed(2));
        new QRCode(qrEl, { text: tlvBase64, width: 140, height: 140, colorDark: '#000', colorLight: '#fff' });
      }
    }, 200);

    // v5.12.0 — auto-print to thermal printer. Fires AFTER the QR has
    // rendered so the printed copy includes the ZATCA QR. With Chrome
    // / Edge launched using --kiosk-printing the dialog is suppressed
    // and the receipt prints silently to the OS default printer.
    setTimeout(function() {
      if (typeof window.printReceiptWindow === 'function') {
        try { window.printReceiptWindow(); } catch (e) { console.warn('auto-print failed:', e); }
      }
    }, 600);
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

// v5.12.3 — Silent print via hidden iframe instead of window.open().
// Browsers / kiosks block popups in many configurations and require
// user interaction to allow them; iframe printing always succeeds and
// goes straight to the OS default printer (silent under Chrome /
// Edge --kiosk-printing). The iframe self-cleans after 4 s.
window._silentPrint = function (html) {
  try { var prior = document.getElementById('vkPrintFrame'); if (prior) prior.remove(); } catch (e) {}
  var f = document.createElement('iframe');
  f.id = 'vkPrintFrame';
  f.setAttribute('aria-hidden', 'true');
  f.style.cssText = 'position:fixed;right:-10000px;bottom:-10000px;width:0;height:0;border:0;visibility:hidden;';
  document.body.appendChild(f);
  f.onload = function () {
    try { f.contentWindow.focus(); f.contentWindow.print(); }
    catch (e) { console.warn('iframe print failed:', e); }
    setTimeout(function () { try { f.remove(); } catch (e) {} }, 4000);
  };
  var doc = f.contentDocument || f.contentWindow.document;
  doc.open();
  doc.write(html);
  doc.close();
};

// V5.7.9 — Print window mirrors the on-screen receipt EXACTLY (same bilingual layout).
//          Sized for 80mm thermal printers (≈280px viewport at typical thermal DPI).
// v5.12.3 — switched from window.open() to hidden iframe; HTML body stays identical.
window.printReceiptWindow = function() {
  var r = state._lastReceipt;
  if (!r) return;
  var qrCanvas = document.querySelector('#receiptQR canvas');
  var qrImg = qrCanvas ? qrCanvas.toDataURL() : '';

  function rowSplit(left, right, opts) {
    opts = opts || {};
    return '<div style="display:flex;justify-content:space-between;align-items:center;font-size:'+(opts.fs||'12px')+';margin:'+(opts.my||3)+'px 0;">' +
      '<span style="color:#000;">' + left + '</span>' +
      '<span style="color:#000;font-weight:'+(opts.bold?'700':'400')+';font-family:monospace;">' + right + '</span>' +
    '</div>';
  }

  // V5.7.29 — 3-column rows (Qty | Item+@price | Total) — same layout as
  //   the on-screen modal so the printed paper matches what the cashier saw.
  var itemsHtml = '';
  (r.inv.items || []).forEach(function(i) {
    var qty = Number(i.qty) || 0;
    var unitPrice = qty > 0 ? (Number(i.total) / qty) : Number(i.price || 0);
    itemsHtml +=
      '<tr style="direction:ltr;border-bottom:1px dotted #888;">' +
        '<td style="text-align:center;font-size:13px;padding:7px 2px;font-family:ui-monospace,SFMono-Regular,monospace;font-weight:700;vertical-align:top;width:38px;">' + qty + '×</td>' +
        '<td style="text-align:left;font-size:12.5px;padding:7px 6px;font-weight:600;line-height:1.3;color:#000;">' +
          i.name +
          '<div style="font-size:10px;color:#555;font-weight:400;font-family:ui-monospace,SFMono-Regular,monospace;margin-top:2px;">@ ' + formatVal(unitPrice) + '</div>' +
        '</td>' +
        '<td style="text-align:right;font-size:13px;padding:7px 2px;font-family:ui-monospace,SFMono-Regular,monospace;font-weight:700;vertical-align:top;width:62px;color:#000;">' + formatVal(i.total) + '</td>' +
      '</tr>';
  });

  var html =
    '<!DOCTYPE html><html lang="en" dir="ltr"><head><meta charset="UTF-8"><title>Receipt ' + r.inv.orderId + '</title>' +
    '<style>' +
      // v5.12.9 — thermal-printer-tuned styles. Tahoma renders Arabic
      // crisp on ESC/POS heads; Helvetica Neue (the prior default) is
      // missing on most kiosk Windows boxes and falls back to Arial,
      // which rendered some glyphs faded. font-weight 600 body / 700
      // print stops anti-aliasing from washing thin strokes out, and
      // -webkit-font-smoothing:none + text-rendering:geometricPrecision
      // force vector-quality strokes instead of bitmap fallbacks.
      '*{margin:0;padding:0;box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact;font-weight:inherit;}' +
      'body{font-family:"Tahoma","Cairo","Segoe UI","Arial Black",Arial,sans-serif;padding:10px;width:300px;margin:0 auto;font-size:13px;color:#000;background:#fff;font-weight:600;-webkit-font-smoothing:none;-moz-osx-font-smoothing:never;font-smooth:never;text-rendering:geometricPrecision;}' +
      // v5.14.9 — Thermal printer override. Cheap thermal heads do
      // not render light strokes or grey colors. Force EVERY element
      // to pure black + bold + a thin text-stroke for darker ink. Any
      // 9–10px inline font-size gets bumped to 11px so it survives on
      // 80mm paper.
      '@media print{@page{margin:0;size:80mm auto;}' +
        'body{padding:6px 4px;width:100%;font-weight:700;}' +
        '*,*::before,*::after{color:#000 !important;font-weight:700 !important;-webkit-text-stroke:0.25px #000;text-shadow:0 0 0.4px #000;}' +
        '[style*="font-size:9px"],[style*="font-size:10px"]{font-size:11px !important;}' +
      '}' +
    '</style></head><body>' +

    (r.logoUrl ? '<div style="text-align:center;margin-bottom:4px;"><img src="' + r.logoUrl + '" style="max-width:90px;max-height:90px;object-fit:contain;"></div>' : '') +

    // V5.7.14 — same 3-line ownership hierarchy as the on-screen receipt
    '<div style="text-align:center;font-size:13px;font-weight:700;direction:rtl;margin-bottom:1px;">' + (r.companyNameAr || 'المذاق المغربي') + '</div>' +
    '<div style="text-align:center;font-size:18px;font-weight:900;direction:ltr;margin-bottom:' + (r.branchCompanyName ? '2' : '6') + 'px;">' + r.companyName + '</div>' +
    (r.branchCompanyName
      ? '<div style="text-align:center;font-size:12px;font-weight:700;color:#000;direction:rtl;margin-bottom:6px;border-bottom:1px solid #d4d4d4;padding-bottom:6px;">' + r.branchCompanyName + '</div>'
      : ''
    ) +

    '<div style="text-align:center;font-size:12px;color:#000;margin-bottom:2px;">Simplified TAX Invoice</div>' +
    '<div style="text-align:center;font-size:10px;color:#444;direction:rtl;margin-bottom:6px;">فاتورة ضريبية مبسطة</div>' +

    (r.taxNumber ? '<div style="text-align:center;font-size:11px;color:#000;margin-bottom:6px;font-family:monospace;direction:ltr;">' + r.taxNumber + '</div>' : '') +
    (r.branchName ? '<div style="text-align:center;font-size:12px;font-weight:700;direction:ltr;margin-top:4px;">Welcome To ' + r.branchName.toUpperCase() + '</div>' : '') +
    (r.branchAddr ? '<div style="text-align:center;font-size:10px;color:#444;direction:rtl;margin-bottom:6px;">' + r.branchAddr + '</div>' : '') +

    '<div style="border-top:1px solid #000;margin:8px 0;"></div>' +

    // V5.7.20 — Merchant copy badge centered (wrapped + inline-block)
    '<div style="text-align:center;margin-bottom:8px;">' +
      '<div style="background:#000;color:#fff;text-align:center;padding:4px 12px;font-weight:700;font-size:12px;display:inline-block;border-radius:2px;">' +
        'Merchant copy <span style="font-size:10px;direction:rtl;">| نسخة بطاقات التاجر</span>' +
      '</div>' +
    '</div>' +
    '<div style="text-align:center;font-size:13px;font-weight:700;margin-bottom:8px;">Tax Invoice <span style="font-size:11px;color:#444;direction:rtl;">| فاتورة ضريبية</span></div>' +

    rowSplit('ID <small style="color:#666;">المعرف</small>', r.inv.orderId, { bold:true }) +
    rowSplit('Date <small style="color:#666;">التاريخ</small>', r.dateStr) +

    '<div style="border-top:1px dashed #000;margin:8px 0;"></div>' +

    // V5.7.29 — 3-col items table for thermal print (matches modal preview)
    '<table style="width:100%;border-collapse:collapse;direction:ltr;table-layout:fixed;">' +
      '<thead><tr style="border-bottom:1.5px solid #000;">' +
        '<th style="text-align:center;font-size:10px;padding:5px 2px;color:#000;font-weight:700;letter-spacing:0.05em;width:38px;">QTY</th>' +
        '<th style="text-align:left;font-size:10px;padding:5px 6px;color:#000;font-weight:700;letter-spacing:0.05em;">ITEM</th>' +
        '<th style="text-align:right;font-size:10px;padding:5px 2px;color:#000;font-weight:700;letter-spacing:0.05em;width:62px;">TOTAL ' + r.currency + '</th>' +
      '</tr></thead>' +
      '<tbody>' + itemsHtml + '</tbody>' +
    '</table>' +

    '<div style="border-top:1px dashed #000;margin:8px 0;"></div>' +

    '<div style="text-align:center;margin:8px 0;">' +
      '<div style="font-size:10px;color:#444;direction:rtl;">عدد الأصناف</div>' +
      '<div style="font-size:13px;font-weight:700;">Total Items</div>' +
      '<div style="font-size:18px;font-weight:900;">' + r.totalItems + '</div>' +
    '</div>' +

    '<table style="width:100%;border-collapse:collapse;border:1px solid #000;margin:10px 0;">' +
      '<tr style="border-bottom:1px solid #000;">' +
        '<td style="text-align:center;padding:6px;border-right:1px solid #000;font-size:11px;font-weight:700;">Total<br>Value<div style="font-size:9px;color:#444;direction:rtl;">إجمالي القيمة</div></td>' +
        '<td style="text-align:center;padding:6px;border-right:1px solid #000;font-size:11px;font-weight:700;">Net Amount<div style="font-size:9px;color:#444;direction:rtl;">المبلغ قبل الضريبة</div></td>' +
        '<td style="text-align:center;padding:6px;font-size:11px;font-weight:700;">VAT Amount<div style="font-size:9px;color:#444;direction:rtl;">ضريبة القيمة 15%</div></td>' +
      '</tr>' +
      '<tr>' +
        '<td style="text-align:center;padding:8px;border-right:1px solid #000;font-size:15px;font-weight:900;">' + formatVal(r.inv.totalFinal) + '</td>' +
        '<td style="text-align:center;padding:8px;border-right:1px solid #000;font-size:15px;font-weight:900;">' + r.netAmount.toFixed(2) + '</td>' +
        '<td style="text-align:center;padding:8px;font-size:15px;font-weight:900;">' + r.vatAmount.toFixed(2) + '</td>' +
      '</tr>' +
    '</table>' +

    rowSplit((r.inv.payment || 'Visa') + ' <span style="font-size:10px;color:#444;direction:rtl;">| ' + (r.inv.payment || 'Visa') + '</span>', formatVal(r.inv.totalFinal), { bold:true }) +

    '<div style="border-top:1px dashed #000;margin:6px 0;"></div>' +

    '<div style="text-align:center;font-size:11px;color:#000;margin:6px 0;">' +
      'You were served by : <strong>' + r.cashierName + (r.cashierEmpNo && r.cashierEmpNo !== r.cashierName ? ', ' + r.cashierEmpNo : '') + '</strong>' +
      '<div style="font-size:10px;color:#444;direction:rtl;">قدّم لكم الخدمة: ' + r.cashierName + '</div>' +
    '</div>' +

    (qrImg ? '<div style="text-align:center;margin:12px 0;"><img src="' + qrImg + '" width="140" height="140"></div>' : '') +

    '<div style="text-align:center;font-size:10px;color:#000;margin-top:8px;">All Prices include VAT (15%)</div>' +
    '<div style="text-align:center;font-size:10px;color:#444;direction:rtl;margin-bottom:4px;">جميع الأسعار شاملة الضريبة المضافة (15%)</div>' +
    (r.companyPhone ? '<div style="text-align:center;font-size:11px;color:#000;margin-top:4px;font-family:monospace;">Tel: ' + r.companyPhone + '</div>' : '') +
    (r.companyEmail ? '<div style="text-align:center;font-size:11px;color:#000;font-family:monospace;">Email: ' + r.companyEmail + '</div>' : '') +

    '</body></html>';

  window._silentPrint(html);
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

    // v5.12.2 — use the structured device detector (UA-CH first, regex
    // fallback) so admin reports show "Samsung SM-G998B — Android 13"
    // instead of a 250-character User-Agent string. detectDevice() is
    // async because UA-CH returns a Promise on Chromium.
    var devicePromise = (typeof window.detectDevice === 'function')
      ? window.detectDevice()
      : Promise.resolve(window.detectDeviceSync ? window.detectDeviceSync() : { ua: navigator.userAgent || '' });

    devicePromise.then(function (device) {
      var extraData = {
        device: device,
        deviceInfo: window.formatDevice
          ? window.formatDevice(device.brand, device.model, device.os)
          : (device.ua || navigator.userAgent || '')
      };
      // Capture geolocation
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(function(pos) {
          extraData.geoLat = pos.coords.latitude;
          extraData.geoLng = pos.coords.longitude;
          fetch('https://nominatim.openstreetmap.org/reverse?lat=' + pos.coords.latitude + '&lon=' + pos.coords.longitude + '&format=json&accept-language=ar')
            .then(function(r) { return r.json(); })
            .then(function(data) { extraData.geoAddress = data.display_name || ''; })
            .catch(function() {})
            .finally(function() { _doOpenShift(extraData); });
        }, function() { _doOpenShift(extraData); }, { timeout: 5000 });
      } else { _doOpenShift(extraData); }
    });
  });
};

function _doOpenShift(extraData) {
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
    }).openShift(state.user, extraData);
}

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
  if (!r) {
    if (typeof glassToast === 'function') glassToast('بيانات التقرير غير متوفرة', true);
    return;
  }
  var fmt = function(v) { return Number(v||0).toFixed(2); };
  var variance = Number(r.variance || 0);
  var diffLine = Math.abs(variance) < 0.01
    ? '✓ متطابق'
    : (variance < 0 ? '⚠ نقص: ' + fmt(Math.abs(variance)) + ' SAR' : '⚠ زيادة: ' + fmt(variance) + ' SAR');

  var lines = [
    '📋 تقرير إغلاق الوردية',
    '',
    '🏪 ' + (r.company || ''),
    '📅 ' + (r.date || ''),
    '🆔 ' + (r.shiftId || ''),
    '👤 ' + (r.cashierName || r.cashier || '') + (r.cashier && r.cashierName !== r.cashier ? ' (' + r.cashier + ')' : ''),
    '',
    '🧾 عدد الفواتير: ' + (r.orders || 0),
    '💰 إجمالي متوقع: ' + fmt(r.totalExpected) + ' SAR',
    '💵 إجمالي فعلي: ' + fmt(r.totalActual) + ' SAR',
    '📊 الفرق: ' + diffLine,
    ''
  ];
  // Dynamic payment methods (V3) — preferred over legacy cash/card/kita
  if (r.paymentTotals && Object.keys(r.paymentTotals).length) {
    lines.push('💳 توزيع طرق الدفع:');
    Object.keys(r.paymentTotals).forEach(function(k) {
      lines.push('  • ' + k + ': ' + fmt(r.paymentTotals[k]) + ' SAR');
    });
  } else {
    // Legacy fallback
    if (r.cash) lines.push('💵 كاش: ' + fmt(r.cash) + ' SAR');
    if (r.card) lines.push('💳 مدى/شبكة: ' + fmt(r.card) + ' SAR');
    if (r.kita) lines.push('🧾 كيتا: ' + fmt(r.kita) + ' SAR');
  }
  var text = encodeURIComponent(lines.join('\n'));
  // Opens WhatsApp letting the user pick any contact
  var w = window.open('https://wa.me/?text=' + text, '_blank');
  if (!w) {
    // Fallback if popup is blocked: copy to clipboard
    try {
      navigator.clipboard.writeText(decodeURIComponent(text));
      if (typeof glassToast === 'function') glassToast('تم نسخ التقرير — افتح واتساب يدوياً', false);
    } catch(e) {
      if (typeof glassToast === 'function') glassToast('السماح للنوافذ المنبثقة مطلوب لفتح واتساب', true);
    }
  }
};

// Print the shift report in a new window
window.printShiftReport = function() {
  var r = state._lastShiftReport;
  if (!r) {
    if (typeof glassToast === 'function') glassToast('بيانات التقرير غير متوفرة', true);
    return;
  }
  var w = window.open('', '_blank', 'width=420,height=720');
  if (!w) {
    if (typeof glassToast === 'function') glassToast('السماح للنوافذ المنبثقة مطلوب للطباعة', true);
    return;
  }
  var fmt = function(v) { return Number(v||0).toFixed(2); };
  var isEn = state.lang === 'en';
  var dir = isEn ? 'ltr' : 'rtl';
  var variance = Number(r.variance || 0);
  var varianceClr = Math.abs(variance) < 0.01 ? '#16a34a' : (variance < 0 ? '#dc2626' : '#d97706');
  var varianceLabel = Math.abs(variance) < 0.01 ? '✓ متطابق' : (variance < 0 ? 'نقص' : 'زيادة');

  // V3: dynamic payment methods table (preferred over legacy cash/card/kita)
  var methodsRows = '';
  if (r.paymentTotals && Object.keys(r.paymentTotals).length) {
    Object.keys(r.paymentTotals).forEach(function(k) {
      methodsRows += '<tr><td>' + k + '</td><td style="text-align:end;">' + fmt(r.paymentTotals[k]) + '</td></tr>';
    });
  } else {
    if (r.cash) methodsRows += '<tr><td>' + t('cash') + '</td><td style="text-align:end;">' + fmt(r.cash) + '</td></tr>';
    if (r.card) methodsRows += '<tr><td>' + t('card') + '</td><td style="text-align:end;">' + fmt(r.card) + '</td></tr>';
    if (r.kita) methodsRows += '<tr><td>' + t('kita') + '</td><td style="text-align:end;">' + fmt(r.kita) + '</td></tr>';
  }

  // V3: cash denominations breakdown if available
  var denomsTable = '';
  if (r.denominations && r.denominations.length) {
    var rowsD = r.denominations
      .filter(function(d){ return Number(d.count) > 0; })
      .map(function(d){
        var v = Number(d.value || 0), c = Number(d.count || 0);
        return '<tr><td style="text-align:center;">' + v + ' SAR</td><td style="text-align:center;">' + c + '</td><td style="text-align:end;">' + fmt(v * c) + '</td></tr>';
      }).join('');
    if (rowsD) {
      denomsTable = '<table style="margin-top:10px;"><tr><th>الفئة</th><th style="text-align:center;">العدد</th><th style="text-align:end;">المجموع</th></tr>' + rowsD + '</table>';
    }
  }

  w.document.write('<!DOCTYPE html><html lang="' + (isEn ? 'en' : 'ar') + '" dir="' + dir + '"><head><meta charset="UTF-8"><title>تقرير إغلاق الوردية</title>' +
    '<style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:Arial,sans-serif;padding:18px;color:#1e293b;max-width:380px;margin:0 auto;font-size:13px;direction:' + dir + ';}' +
    '.h{text-align:center;border-bottom:2px solid #1e293b;padding-bottom:12px;margin-bottom:14px;}h1{font-size:18px;}h2{font-size:13px;color:#64748b;font-weight:400;}' +
    '.row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px dashed #cbd5e1;}.row:last-child{border:none;}' +
    'table{width:100%;border-collapse:collapse;margin:10px 0;}th,td{padding:8px;text-align:start;border-bottom:1px solid #e2e8f0;font-size:12px;}th{background:#f1f5f9;font-weight:700;}' +
    '.t{background:#ecfeff;font-weight:900;}@media print{body{padding:10px;}}</style></head><body>' +
    ((state.settings && state.settings.logo) ? '<div style="text-align:center;margin-bottom:8px;"><img src="' + state.settings.logo + '" style="max-width:90px;"></div>' : '') +
    '<div class="h"><h1>' + (r.company || 'Moroccan Taste') + '</h1><h2>تقرير إغلاق الوردية</h2></div>' +
    '<div class="row"><span>الكاشير</span><span><b>' + (r.cashierName || r.cashier || '') + '</b></span></div>' +
    '<div class="row"><span>الرقم</span><span>' + (r.cashier || '') + '</span></div>' +
    '<div class="row"><span>رقم الوردية</span><span><b>' + (r.shiftId || '') + '</b></span></div>' +
    '<div class="row"><span>تاريخ الإغلاق</span><span>' + (r.date || '') + '</span></div>' +
    '<div class="row"><span>عدد الفواتير</span><span><b>' + (r.orders || 0) + '</b></span></div>' +
    (methodsRows ? '<table><tr><th>الطريقة</th><th style="text-align:end;">المبلغ (SAR)</th></tr>' + methodsRows + '<tr class="t"><td>الإجمالي</td><td style="text-align:end;">' + fmt(r.totalActual) + '</td></tr></table>' : '') +
    denomsTable +
    '<table style="margin-top:14px;"><tr><th colspan="2" style="text-align:center;">📊 الفروقات</th></tr>' +
      '<tr><td>المتوقع</td><td style="text-align:end;">' + fmt(r.totalExpected) + ' SAR</td></tr>' +
      '<tr><td>الفعلي</td><td style="text-align:end;">' + fmt(r.totalActual) + ' SAR</td></tr>' +
      '<tr style="background:#fef3c7;"><td><b>الفرق (' + varianceLabel + ')</b></td><td style="text-align:end;color:' + varianceClr + ';"><b>' + (variance >= 0 ? '+' : '') + fmt(variance) + ' SAR</b></td></tr>' +
    '</table>' +
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
    // v5.12.7 — diff is computed on the server during stocktake review;
    // hidden here so the cashier counts blind (proper audit practice).
    var diffHtml = '<span style="color:#cbd5e1;">—</span>';
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
    // Column 5: النظام — v5.12.7 hidden from cashier (blind count)
    var sysCell = '<td style="text-align:center;color:#cbd5e1;font-weight:500;">—</td>';
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
    }).submitStocktake(itemsToSend, state.user, notes, state.warehouseId, state.branchId);
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
        (r.status === 'rejected' && r.notes ? '<div style="margin-top:6px;padding:8px 10px;background:#fee2e2;border-radius:8px;font-size:12px;color:#991b1b;font-weight:600;"><i class="fas fa-exclamation-triangle" style="margin-left:4px;"></i>' + (r.notes.match(/\[رفض: (.+?)\]/) ? r.notes.match(/\[رفض: (.+?)\]/)[1] : r.notes) + '</div>' : '') +
        (r.status === 'pending' ? '<div style="display:flex;gap:6px;margin-top:8px;"><button class="btn btn-primary btn-sm" style="flex:1;border-radius:8px;" onclick="shrEditRequest(\'' + r.id + '\')"><i class="fas fa-edit"></i> ' + (isEn?'Edit':'تعديل') + '</button><button class="btn btn-danger btn-sm" style="border-radius:8px;" onclick="shrDeleteRequest(\'' + r.id + '\',\'' + (r.requestNumber||'') + '\')"><i class="fas fa-trash"></i></button></div>' : '') +
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
  // Load inventory items first (for bigUnit/convRate), then load request
  api.withSuccessHandler(function(items) {
    _shrAllItems = (items || []).map(function(i) {
      return { id: i.id, name: i.name, category: i.category||'', stock: Number(i.stock)||0, minStock: Number(i.minStock||i.min_stock)||0, cost: Number(i.cost)||0, unit: i.unit||'', bigUnit: i.bigUnit||i.big_unit||'', convRate: Number(i.convRate||i.conv_rate)||1 };
    });

    api.withSuccessHandler(function(data) {
    loader(false);
    if (!data || data.error) return glassToast(data && data.error || t('errorTitle'), true);
    if (data.status !== 'pending') return glassToast(state.lang==='en'?'Only pending requests can be edited':'فقط الطلبات المعلقة يمكن تعديلها', true);

    // Load items into cart — restore dual unit values
    _shrCart = (data.items || []).map(function(i) {
      var qty = Number(i.requestedQty) || 0;
      var unit = i.unit || '';
      var orig = _shrAllItems.find(function(x) { return x.id === i.invItemId; });
      var bigUnit = orig ? (orig.bigUnit||'') : '';
      var convRate = orig ? (Number(orig.convRate)||1) : 1;
      var hasBig = bigUnit && convRate > 1;
      // Reverse-calculate big and small from total qty
      // If qty is 0, default to 1 so user sees something to edit
      if (qty <= 0) qty = 1;
      var bigVal = '', smallVal = '';
      if (hasBig && qty > 0) {
        bigVal = Math.floor(qty / convRate);
        smallVal = qty % convRate;
        if (bigVal === 0) bigVal = '';
        if (smallVal === 0 && bigVal) smallVal = '';
        else if (smallVal === 0) smallVal = qty; // show total in small if no big
      } else {
        smallVal = qty;
      }
      var totalQty = hasBig ? ((Number(bigVal)||0) * convRate) + (Number(smallVal)||0) : (Number(smallVal)||0);
      return { id: i.invItemId, name: i.invItemName, unit: unit, bigUnit: bigUnit, convRate: convRate, stock: Number(i.currentQty)||0, minStock: Number(i.minQty)||0, cost: Number(i.unitPrice)||0, requestedQty: totalQty || qty, _bigInput: bigVal, _smallInput: smallVal };
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
  }).getInvItems();
};

window.shrDeleteRequest = function(id, num) {
  var isEn = state.lang === 'en';
  glassConfirm(isEn?'Delete Request':'حذف الطلب', (isEn?'Delete shortage request ':'حذف طلب النقص ') + num + '?', {}).then(function(ok) {
    if (!ok) return;
    loader(true);
    api.withSuccessHandler(function(r) {
      loader(false);
      if (r && r.success) { glassToast(isEn?'Request deleted':'تم حذف الطلب'); _shrLoadHistory(); }
      else glassToast((r && r.error) || t('errorTitle'), true);
    }).deleteShortageRequest(id);
  });
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
  _shrCart.push({
    id: item.id, name: item.name, unit: item.unit,
    bigUnit: item.bigUnit || '', convRate: Number(item.convRate) || 1,
    stock: item.stock, minStock: item.minStock, cost: item.cost,
    _bigInput: '', _smallInput: '', requestedQty: 0
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

// Dual unit input — same pattern as stocktake
window.shrUpdateDual = function(idx, bigVal, smallVal) {
  var c = _shrCart[idx];
  if (!c) return;
  var cRate = Number(c.convRate) || 1;
  var hasBig = c.bigUnit && cRate > 1;

  if (bigVal !== null && bigVal !== undefined) c._bigInput = bigVal === '' ? '' : Number(bigVal);
  if (smallVal !== null && smallVal !== undefined) c._smallInput = smallVal === '' ? '' : Number(smallVal);

  var b = Number(c._bigInput) || 0;
  var s = Number(c._smallInput) || 0;
  var bigEmpty = c._bigInput === '' || c._bigInput === undefined;
  var smallEmpty = c._smallInput === '' || c._smallInput === undefined;

  if (bigEmpty && smallEmpty) {
    c.requestedQty = 0;
  } else {
    c.requestedQty = hasBig ? (b * cRate) + s : s;
  }
  _saveShrCart();
};

function _shrRenderCart() {
  var tb = q('#shrBody');
  if (!tb) return;
  if (!_shrCart.length) {
    tb.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:30px;color:#94a3b8;"><i class="fas fa-search" style="font-size:20px;display:block;margin-bottom:6px;"></i>' + t('searchToAdd') + '</td></tr>';
    return;
  }
  tb.innerHTML = _shrCart.map(function(c, i) {
    // Refresh from server cache
    if (_shrAllItems.length) {
      var fresh = _shrAllItems.find(function(x) { return x.id === c.id; });
      if (fresh) {
        c.bigUnit = fresh.bigUnit || c.bigUnit || '';
        c.convRate = Number(fresh.convRate) || Number(c.convRate) || 1;
        c.unit = fresh.unit || c.unit || '';
        c.stock = Number(fresh.stock) || c.stock || 0;
      }
    }
    var cRate = Number(c.convRate) || 1;
    var hasBig = c.bigUnit && cRate > 1;
    var bigVal = c._bigInput !== undefined && c._bigInput !== '' ? c._bigInput : '';
    var smallVal = c._smallInput !== undefined && c._smallInput !== '' ? c._smallInput : '';
    var low = c.stock <= c.minStock;

    var nameCell = '<td style="font-weight:700;font-size:12px;">' + c.name + '</td>';
    var bigQtyCell = hasBig
      ? '<td style="text-align:center;"><input type="number" min="0" step="1" class="form-control glass-input" style="width:55px;margin:0 auto;padding:5px;text-align:center;font-weight:800;" value="' + bigVal + '" oninput="shrUpdateDual(' + i + ',this.value,null)" placeholder="0"></td>'
      : '<td style="text-align:center;color:#e2e8f0;">—</td>';
    var bigUnitCell = '<td style="text-align:center;font-size:11px;color:#64748b;">' + (hasBig ? c.bigUnit : '—') + '</td>';
    var smallQtyCell = '<td style="text-align:center;"><input type="number" min="0" step="1" class="form-control glass-input" style="width:55px;margin:0 auto;padding:5px;text-align:center;font-weight:800;" value="' + smallVal + '" oninput="shrUpdateDual(' + i + ',null,this.value)" placeholder="0"></td>';
    var smallUnitCell = '<td style="text-align:center;font-size:11px;color:#64748b;">' + (c.unit||'') + '</td>';
    var stockCell = '<td style="text-align:center;font-weight:700;color:' + (low?'#ef4444':'#16a34a') + ';font-size:12px;">' + c.stock + '</td>';
    var delCell = '<td style="text-align:center;"><button onclick="shrRemoveItem(' + i + ')" style="border:none;background:none;color:#ef4444;cursor:pointer;font-size:14px;"><i class="fas fa-trash"></i></button></td>';

    return '<tr>' + nameCell + bigQtyCell + bigUnitCell + smallQtyCell + smallUnitCell + stockCell + delCell + '</tr>';
  }).join('');
}

window.submitShortageRequest = function() {
  if (!_shrCart.length) return glassToast(t('stAddFirst'), true);
  // Filter only items with qty > 0
  var validItems = _shrCart.filter(function(c) { return c.requestedQty > 0; });
  if (!validItems.length) return glassToast(state.lang==='en'?'Enter quantity for at least one item':'أدخل كمية لمادة واحدة على الأقل', true);
  var items = validItems.map(function(c) {
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
        .createShortageRequest({ items: items, username: state.user, notes: (q('#shrNotes')||{}).value || '', warehouseId: state.warehouseId || '', branchId: state.branchId || '' });
    }
  });
};

/* ═════════════════════════════════════════════════════════════════════════
 * POS V3 — Channels, Dynamic Payment Methods, V3 Discounts, V3 Shift Close
 * Implements قسم_إدارة_الدفع_والقنوات_والخصومات spec on the cashier side.
 * ═════════════════════════════════════════════════════════════════════════ */

state.channels = [];
state.activeChannel = null;          // currently-selected channel object
state.channelPriceMap = {};          // itemId → channelPrice (for active channel)
state.paymentMethodsV3 = [];         // V3 payment methods (with groups/fees/icons)
state.discountsV3 = [];              // V3 discounts (line+invoice+preset+manual)
state.lineDiscounts = {};            // cart-index → { name, type, value, amount }
state._v3CashDenoms = [1, 5, 10, 20, 50, 100, 200, 500];

// Generic fetch helper for V3 endpoints (re-uses pos_token)
function _posCallAPI(method, path, body, cb) {
  var opts = { method: (method||'GET').toUpperCase(), headers: { 'Content-Type': 'application/json' } };
  var token = localStorage.getItem('pos_token');
  if (token) opts.headers['Authorization'] = 'Bearer ' + token;
  if (body && opts.method !== 'GET' && opts.method !== 'DELETE') opts.body = JSON.stringify(body);
  fetch(path.charAt(0)==='/' ? '/api'+path : path, opts)
    .then(function(r){ return r.json().catch(function(){ return null; }); })
    .then(function(d){ if (cb) cb(d); })
    .catch(function(err){ console.error('[POS V3] callAPI err:', err); if (cb) cb({ success:false, error:String(err && err.message || err) }); });
}

function _posFmt(n) { return Number(n||0).toFixed(2); }

// ─── 1. Load V3 data on init ────────────────────────────────────────────
window.posLoadV3Data = function() {
  // Load 3 things in parallel: active channels, V3 payment methods, V3 discounts
  _posCallAPI('GET', '/sales-channels/active', null, function(rows) {
    state.channels = Array.isArray(rows) ? rows : [];
    _posRenderChannelSelector();
    // Auto-select first or restore from localStorage
    var savedChId = localStorage.getItem('pos_active_channel_id');
    var found = state.channels.find(function(c){ return c.id === savedChId; });
    if (found) posSetChannel(found.id);
    else if (state.channels.length) posSetChannel(state.channels[0].id);

    // v5.12.4 — Pre-fetch every non-MAIN channel's menu in parallel and
    // cache it in state.channelMenuCache. Subsequent posSetChannel
    // switches read from the cache (0 ms) and refresh the row in the
    // background. MAIN is skipped because it never uses the cache.
    state.channelMenuCache = state.channelMenuCache || {};
    var branchQ = state.branchId ? '?branchId=' + encodeURIComponent(state.branchId) : '';
    state.channels.forEach(function (c) {
      var code = String(c.code || '').toUpperCase();
      var ctype = String(c.channelType || c.channel_type || '').toLowerCase();
      if (code === 'MAIN' || ctype === 'main') return;
      _posCallAPI('GET', '/channel-menus/' + c.id + branchQ, null, function (cmRows) {
        if (cmRows && cmRows.error) {
          console.error('[channel-menu] prefetch error for', c.id, cmRows.error);
          state.channelMenuCache[c.id] = [];
          return;
        }
        state.channelMenuCache[c.id] = Array.isArray(cmRows) ? cmRows : [];
      });
    });
  });
  _posCallAPI('GET', '/settings/payment-methods-full', null, function(rows) {
    state.paymentMethodsV3 = Array.isArray(rows) ? rows : [];
    if (state.paymentMethodsV3.length) {
      // Replace state.paymentMethods so renderPayButtons uses V3 (in old format for back-compat)
      state.paymentMethods = state.paymentMethodsV3.map(function(p){
        return {
          ID: p.id, Name: p.name || p.nameAr, NameAR: p.nameAr || p.name,
          Icon: p.icon || 'fa-money-bill', IsActive: p.isActive,
          ServiceFeeRate: Number(p.serviceFeeRate || 0), SortOrder: p.sortOrder || 0,
          GroupType: p.groupType || 'cash',
          AllowManualTotal: p.allowManualTotal,
          ShowInShiftClose: p.showInShiftClose !== false,
          ShowInReports: p.showInReports !== false,
          ServiceFeeType: p.serviceFeeType || 'none',
          ServiceFeeValue: Number(p.serviceFeeValue || 0)
        };
      });
      renderPayButtons();
    }
  });
  _posCallAPI('GET', '/settings/discounts-v2-full', null, function(rows) {
    state.discountsV3 = Array.isArray(rows) ? rows : [];
  });
};

// ─── 2. Channel Selector ────────────────────────────────────────────────
function _posRenderChannelSelector() {
  // v5.14.0 — populate both the legacy in-cart selector and the new
  // Foodics top-action-bar selector so they stay in sync.
  var sel = q('#posChannelSel');
  var top = q('#posChannelSelTop');
  var html;
  if (!state.channels.length) {
    html = '<option value="">— لا توجد قنوات —</option>';
  } else {
    html = state.channels.map(function(c){
      return '<option value="' + c.id + '">' + (c.name || c.id) + '</option>';
    }).join('');
  }
  if (sel) sel.innerHTML = html;
  if (top) top.innerHTML = html;
  // V5.7.16 — force re-translate so channel names like "هنقرستيشن" → "Hungerstation"
  //           appear in English immediately when the user is in English mode.
  if (typeof window.translateNow === 'function') {
    if (sel) window.translateNow(sel);
    if (top) window.translateNow(top);
  }
}

// V5.7.11 — Switching channels NEVER clears the cart.
//   Old behavior: confirm + wipe cart (to "prevent price mixing").
//   New behavior: silently load the new price list and re-stamp each
//   cart line's unit price from the new channel. This matches how the
//   user thinks: "I changed the channel; the same items should now show
//   the new channel's prices, not vanish."
window.posSetChannel = function(channelId) {
  var ch = state.channels.find(function(c){ return c.id === channelId; });
  if (!ch) return;
  _doSetChannel(ch);
};

// v5.12.7 — guarantee state.menu is populated before rendering. /init
// filters menu by the cashier's brand_id; if the result is empty (brand
// has no items wired up), fall back to the unfiltered /menu endpoint.
// Tries once per session — flag prevents an infinite loop on persistent
// failure. Caches the result so reloads pick it up instantly.
function _ensureMenuLoaded(cb) {
  var current = (state.menu || []).filter(function (i) { return i.active; });
  if (current.length > 0) { if (cb) cb(); return; }
  if (state._menuFallbackTried) { if (cb) cb(); return; }
  state._menuFallbackTried = true;
  console.warn('[pos-menu] state.menu empty — falling back to /menu');
  _posCallAPI('GET', '/menu', null, function (rows) {
    if (Array.isArray(rows) && rows.length) {
      state.menu = rows;
      state.categories = Array.from(new Set(rows.map(function (i) { return i.category; })))
                              .filter(function (c) { return c && String(c).trim() !== ''; });
      try { localStorage.setItem('pos_menu_cache', JSON.stringify({ ts: Date.now(), menu: rows })); } catch (e) {}
      console.log('[pos-menu] fallback fetched', rows.length, 'items');
    } else {
      console.error('[pos-menu] fallback returned empty');
    }
    if (cb) cb();
  });
}

function _doSetChannel(ch) {
  var isSwitch = state.activeChannel && state.activeChannel.id !== ch.id;
  state.activeChannel = ch;
  localStorage.setItem('pos_active_channel_id', ch.id);
  var label = q('#posChannelPriceLabel');
  if (label) {
    label.innerHTML = ch.priceListId
      ? '<i class="fas fa-link" style="color:#22c55e;"></i> ' + (ch.priceListName || 'قائمة أسعار خاصة')
      : '<span style="color:#94a3b8;">قائمة أسعار افتراضية</span>';
  }
  var sel = q('#posChannelSel');
  if (sel) sel.value = ch.id;
  // v5.14.0 — keep the top Foodics selector in sync
  var selTop = q('#posChannelSelTop');
  if (selTop) selTop.value = ch.id;
  var topLabel = q('#posChannelPriceLabelTop');
  if (topLabel) {
    topLabel.innerHTML = ch.priceListId
      ? '<i class="fas fa-link"></i> ' + (ch.priceListName || 'قائمة أسعار خاصة')
      : '';
  }

  // v5.12.4 — MAIN / Dine-In ALWAYS uses the full menu, regardless of
  // any channel_menu_items rows that may exist. Other channels respect
  // their list strictly. Detection covers all three possible markers:
  //   • code === 'MAIN'  (canonical seed)
  //   • channelType === 'main'  (legacy)
  //   • channelType === 'dine_in'  (the seed pairs this with code='MAIN')
  var _code  = String(ch.code || '').toUpperCase();
  var _ctype = String(ch.channelType || ch.channel_type || '').toLowerCase();
  var isMain = (_code === 'MAIN') || (_ctype === 'main') || (_code === 'MAIN' && _ctype === 'dine_in');
  state.activeChannel.useFullMenu = isMain;

  // v5.14.9 — Helper: refresh BOTH the category tiles and the products
  // grid after a channel switch. Previously only renderMenuGrid was
  // called, so the category tiles kept stale counts from the previous
  // channel — clicking a tile then hit an empty grid because the new
  // channel had no items in that category. Also, if the cashier was
  // deep in a category that doesn't exist on the new channel, fall
  // back to the category view so they see what IS available.
  var _refreshChannelViews = function () {
    if (state.activeCat) {
      var _pool = (state.menu || []).filter(function (m) { return m.active; });
      if (state.activeChannel && !state.activeChannel.useFullMenu) {
        var _allow = new Set((state.channelMenuItems || []).map(function (r) { return String(r.menuItemId); }));
        _pool = _pool.filter(function (m) { return _allow.has(String(m.id)); });
        if (state._channelCustomItems) _pool = _pool.concat(state._channelCustomItems);
      }
      var _hasItems = _pool.some(function (m) { return m.category === state.activeCat; });
      if (!_hasItems && typeof window.posBackToCategories === 'function') {
        window.posBackToCategories();
        return;
      }
    }
    if (typeof renderCategoryGrid === 'function') renderCategoryGrid();
    if (typeof renderMenuGrid === 'function') renderMenuGrid();
  };

  if (isMain) {
    // Skip the channel-menu fetch entirely — saves a round-trip and
    // guarantees the full menu shows even if MAIN has stale rows in
    // channel_menu_items from a different brand.
    state.channelMenuItems = [];
    state.channelOverrideMap = {};
    _posApplyChannelPrices();
    _refreshChannelViews();
    _ensureMenuLoaded(function () {
      _posApplyChannelPrices();
      _refreshChannelViews();
    });
  } else {
    // Read from the prefetch cache for instant switching; refresh in
    // the background if the cache is stale or missing.
    var cached = state.channelMenuCache && state.channelMenuCache[ch.id];
    var applyRows = function (rows) {
      var available = (Array.isArray(rows) ? rows : []).filter(function (r) { return r.isAvailable !== false; });
      state.channelMenuItems = available;
      state.channelOverrideMap = {};
      available.forEach(function (r) {
        if (r.overridePrice != null && !isNaN(Number(r.overridePrice))) {
          state.channelOverrideMap[String(r.menuItemId)] = Number(r.overridePrice);
        }
      });
      // v5.14.7 — Strict per-channel menu: NO fallback. If the admin
      // has configured zero items for this channel, the cashier sees
      // an empty grid.
      _ensureMenuLoaded(function () {
        _posApplyChannelPrices();
        _refreshChannelViews();
      });
    };
    if (cached) applyRows(cached);
    var branchQ = state.branchId ? '?branchId=' + encodeURIComponent(state.branchId) : '';
    _posCallAPI('GET', '/channel-menus/' + ch.id + branchQ, null, function (rows) {
      if (rows && rows.error) {
        // v5.14.7 — Strict: never silently swap to the full menu on a
        // fetch failure. Show an empty grid + a one-line console error.
        console.error('[channel-menu] fetch error for', ch.id, ':', rows.error);
        if (!cached) {
          state.channelMenuItems = [];
          state.channelOverrideMap = {};
          _posApplyChannelPrices();
          _refreshChannelViews();
        }
        return;
      }
      if (!state.channelMenuCache) state.channelMenuCache = {};
      state.channelMenuCache[ch.id] = Array.isArray(rows) ? rows : [];
      applyRows(rows);
    });
  }

  // Load price list items for this channel (override menu prices + cart prices)
  // v5.13.0 — also harvests standalone "custom" items (item_id IS NULL) and
  // exposes them as virtual menu rows so the cashier sees only-on-this-channel
  // products that aren't part of the main menu.
  if (ch.priceListId) {
    _posCallAPI('GET', '/erp/price-lists/' + ch.priceListId + '/items', null, function(rows) {
      state.channelPriceMap = {};
      var customItems = [];
      (rows || []).forEach(function(r) {
        if (r.isCustom || (r.itemId == null && r.itemName)) {
          // Virtual menu item: id starts with PLI- so we know it's
          // recipe-free at sale time.
          customItems.push({
            id:        'PLI-' + r.id,
            name:      r.itemName,
            price:     Number(r.price) || 0,
            category:  r.categoryOrUnit || 'صنف مُخصَّص',
            cost:      0,
            active:    true,
            __custom:  true
          });
        } else if (r.itemId) {
          state.channelPriceMap[r.itemId] = Number(r.price || 0);
        }
      });
      state._channelCustomItems = customItems;
      // Make sure custom-item categories appear in the tab strip
      if (customItems.length) {
        var existingCats = new Set(state.categories || []);
        customItems.forEach(function (m) { if (m.category) existingCats.add(m.category); });
        state.categories = Array.from(existingCats);
      }
      _posApplyChannelPrices();
      if (typeof renderMenuGrid === 'function') renderMenuGrid();
      if (isSwitch && state.cart && state.cart.length && typeof glassToast === 'function') {
        glassToast('تم تحديث أسعار السلة لقناة: ' + (ch.name || ''), false);
      }
    });
  } else {
    state.channelPriceMap = {};
    state._channelCustomItems = [];
    _posApplyChannelPrices();
    if (typeof renderMenuGrid === 'function') renderMenuGrid();
    if (isSwitch && state.cart && state.cart.length && typeof glassToast === 'function') {
      glassToast('تم تحديث أسعار السلة لقناة: ' + (ch.name || ''), false);
    }
  }
}

function _posApplyChannelPrices() {
  // Apply channel prices. Priority: per-item override (channel_menu_items)
  // → channel price-list → base menu price. Snapshot _origPrice once so
  // we can revert when the channel is cleared.
  (state.menu || []).forEach(function(m) {
    if (m._origPrice == null) m._origPrice = Number(m.price || 0);
    var key = String(m.id);
    if (state.channelOverrideMap && state.channelOverrideMap[key] != null) {
      m.price = Number(state.channelOverrideMap[key]);
    } else if (state.channelPriceMap && state.channelPriceMap[m.id] != null) {
      m.price = Number(state.channelPriceMap[m.id]);
    } else {
      m.price = m._origPrice;
    }
  });
  // V5.7.11/.15 — re-stamp every existing cart-line's unit price from the new
  //   channel's price list. Match by id first (canonical), fall back to name.
  //
  //   IMPORTANT: ALSO update line.basePrice. The legacy updateCart() does
  //   `c.price = c.basePrice` whenever payment method != 'Kita' to revert any
  //   per-line edits — without this, the channel switch silently reverted the
  //   cart back to the pre-switch price on the very next render.
  (state.cart || []).forEach(function(line) {
    var newPrice = null;
    if (state.channelOverrideMap && line.id != null && state.channelOverrideMap[String(line.id)] != null) {
      newPrice = Number(state.channelOverrideMap[String(line.id)]);
    } else if (state.channelPriceMap && line.id != null && state.channelPriceMap[line.id] != null) {
      newPrice = Number(state.channelPriceMap[line.id]);
    }
    if (newPrice == null) {
      var menuItem = (state.menu || []).find(function(m) {
        return (line.id != null && m.id === line.id) || (line.name && m.name === line.name);
      });
      if (menuItem) newPrice = Number(menuItem.price || 0);
    }
    if (newPrice != null && !isNaN(newPrice)) {
      line.price     = newPrice;
      line.basePrice = newPrice;   // ← V5.7.15 fix: keep basePrice in sync
    }
  });
  if (typeof renderMenuGrid === 'function') renderMenuGrid();
  if (typeof updateCart === 'function') updateCart();
}

// Hook: get effective price for an item (channel override or default)
window.posGetItemPrice = function(item) {
  if (!item) return 0;
  // v5.12.2 — per-item override first, then channel price list, then base
  if (state.channelOverrideMap && state.channelOverrideMap[String(item.id)] != null) {
    return Number(state.channelOverrideMap[String(item.id)]);
  }
  if (state.channelPriceMap && state.channelPriceMap[item.id] != null) {
    return Number(state.channelPriceMap[item.id]);
  }
  return Number(item.price || 0);
};

window.posOnChannelChange = function() {
  var sel = q('#posChannelSel');
  if (!sel || !sel.value) return;
  posSetChannel(sel.value);
};

// ─── 3. Discounts V3 — line + invoice modals ────────────────────────────
window.posOpenLineDiscountModal = function() {
  if (!state.cart.length) return glassToast('السلة فارغة', true);
  var lineDiscounts = (state.discountsV3 || []).filter(function(d){
    return d.enabled && d.showInPos !== false && (d.discountScope === 'line' || d.discountScope === 'preset' || d.discountScope === 'manual');
  });

  // Build cart-line picker first
  var cartHtml = '<div style="font-weight:800;margin-bottom:10px;">اختر الصنف من السلة:</div>';
  cartHtml += '<div class="pos-line-disc-list">' + state.cart.map(function(c, i){
    var existing = state.lineDiscounts[i];
    var price = posGetItemPrice(c);
    return '<div class="pos-line-disc-row" onclick="posSelectLineForDiscount(' + i + ')">' +
      '<div><div style="font-weight:700;">' + c.name + '</div><div style="font-size:11px;color:#64748b;">' + c.qty + ' × ' + _posFmt(price) + '</div></div>' +
      '<div>' + (existing ? '<span style="color:#22c55e;font-weight:700;"><i class="fas fa-check"></i> -' + _posFmt(existing.amount) + '</span>' : '<i class="fas fa-arrow-left"></i>') + '</div>' +
    '</div>';
  }).join('') + '</div>';

  q('#discModalList').innerHTML = cartHtml;
  state._lineDiscountStep = 'pick-line';
  state._lineDiscountList = lineDiscounts;
  openGlassModal('#modalDiscount');
};

window.posSelectLineForDiscount = function(idx) {
  state._lineDiscountIdx = idx;
  var lineDiscounts = state._lineDiscountList || [];
  var c = state.cart[idx];
  var lineTotal = c.qty * posGetItemPrice(c);

  var html = '<div style="background:#dbeafe;padding:10px;border-radius:10px;margin-bottom:14px;">' +
    '<div style="font-weight:800;">' + c.name + '</div>' +
    '<div style="font-size:12px;color:#1e3a8a;">إجمالي السطر: ' + _posFmt(lineTotal) + ' SAR</div>' +
  '</div>';

  if (lineDiscounts.length) {
    html += '<div style="font-weight:800;margin-bottom:8px;">خصومات جاهزة:</div>';
    html += lineDiscounts.map(function(d){
      var valStr = d.type === 'percentage' ? d.value + '%' : _posFmt(d.value) + ' SAR';
      var canApply = !d.minOrder || lineTotal >= d.minOrder;
      return '<div class="pos-disc-card' + (canApply?'':' disabled') + '" onclick="' + (canApply?"posApplyLineDiscount('"+d.id+"')":'') + '">' +
        '<div><i class="fas ' + (d.icon||'fa-tag') + '" style="color:' + (d.color||'#8b5cf6') + ';"></i> <b>' + d.name + '</b></div>' +
        '<div style="color:' + (d.color||'#8b5cf6') + ';font-weight:800;">' + valStr + '</div>' +
      '</div>';
    }).join('');
  }
  html += '<div class="pos-disc-manual">' +
    '<div style="font-weight:800;margin-bottom:6px;">أو أدخل خصم يدوي:</div>' +
    '<div style="display:flex;gap:8px;align-items:center;">' +
      '<select id="posLineDiscType" class="form-control glass-input" style="flex:1;"><option value="percentage">نسبة %</option><option value="fixed">مبلغ ثابت</option></select>' +
      '<input id="posLineDiscValue" type="number" step="0.01" min="0" class="form-control glass-input" placeholder="القيمة" style="flex:1;">' +
      '<button class="btn btn-primary" onclick="posApplyManualLineDiscount()">تطبيق</button>' +
    '</div>' +
    '<div style="font-size:11px;color:#94a3b8;margin-top:6px;">قد يتطلب الخصم اليدوي صلاحية المدير.</div>' +
  '</div>';
  html += '<button class="btn btn-light" style="width:100%;margin-top:10px;" onclick="posOpenLineDiscountModal()"><i class="fas fa-arrow-right"></i> رجوع</button>';

  q('#discModalList').innerHTML = html;
};

window.posApplyLineDiscount = function(discId) {
  var d = (state._lineDiscountList || []).find(function(x){return x.id===discId;});
  if (!d) return;
  var idx = state._lineDiscountIdx;
  var c = state.cart[idx];
  var lineTotal = c.qty * posGetItemPrice(c);
  var amt = d.type === 'percentage' ? lineTotal * (d.value/100) : Number(d.value);
  if (d.maxAmount && amt > d.maxAmount) amt = d.maxAmount;
  if (amt > lineTotal) amt = lineTotal;
  state.lineDiscounts[idx] = { name: d.name, type: d.type, value: d.value, amount: amt, discountId: d.id, glAccountId: d.glAccountId };
  closeGlassModal('#modalDiscount');
  glassToast('تم تطبيق خصم: ' + d.name + ' (' + _posFmt(amt) + ' SAR)');
  updateCart();
};

window.posApplyManualLineDiscount = function() {
  var type = q('#posLineDiscType').value;
  var val = Number(q('#posLineDiscValue').value) || 0;
  if (val <= 0) return glassToast('أدخل قيمة موجبة', true);
  var idx = state._lineDiscountIdx;
  var c = state.cart[idx];
  var lineTotal = c.qty * posGetItemPrice(c);
  var amt = type === 'percentage' ? lineTotal * (val/100) : val;
  if (amt > lineTotal) amt = lineTotal;
  state.lineDiscounts[idx] = { name: 'يدوي', type: type, value: val, amount: amt, discountId: null, glAccountId: null };
  closeGlassModal('#modalDiscount');
  glassToast('تم تطبيق خصم يدوي');
  updateCart();
};

window.posOpenInvoiceDiscountModal = function() {
  if (!state.cart.length) return glassToast('السلة فارغة', true);
  var invDiscounts = (state.discountsV3 || []).filter(function(d){
    return d.enabled && d.showInPos !== false && (d.discountScope === 'invoice' || d.discountScope === 'preset' || d.discountScope === 'manual');
  });
  var subtotal = state.cart.reduce(function(s, c){ return s + (c.qty * posGetItemPrice(c)); }, 0);

  var html = '<div style="background:#fef3c7;padding:10px;border-radius:10px;margin-bottom:14px;">' +
    '<div style="font-weight:800;">إجمالي الفاتورة: ' + _posFmt(subtotal) + ' SAR</div>' +
  '</div>';

  if (invDiscounts.length) {
    html += '<div style="font-weight:800;margin-bottom:8px;">خصومات جاهزة على الفاتورة:</div>';
    html += invDiscounts.map(function(d){
      var valStr = d.type === 'percentage' ? d.value + '%' : _posFmt(d.value) + ' SAR';
      var canApply = !d.minOrder || subtotal >= d.minOrder;
      return '<div class="pos-disc-card' + (canApply?'':' disabled') + '" onclick="' + (canApply?"posApplyInvoiceDiscount('"+d.id+"')":'') + '">' +
        '<div><i class="fas ' + (d.icon||'fa-receipt') + '" style="color:' + (d.color||'#8b5cf6') + ';"></i> <b>' + d.name + '</b>' + (d.minOrder ? ' <small style="color:#94a3b8;">(حد أدنى: '+_posFmt(d.minOrder)+')</small>':'') + '</div>' +
        '<div style="color:' + (d.color||'#8b5cf6') + ';font-weight:800;">' + valStr + '</div>' +
      '</div>';
    }).join('');
  }
  html += '<div class="pos-disc-manual">' +
    '<div style="font-weight:800;margin-bottom:6px;">أو أدخل خصم يدوي:</div>' +
    '<div style="display:flex;gap:8px;align-items:center;">' +
      '<select id="posInvDiscType" class="form-control glass-input" style="flex:1;"><option value="percentage">نسبة %</option><option value="fixed">مبلغ ثابت</option></select>' +
      '<input id="posInvDiscValue" type="number" step="0.01" min="0" class="form-control glass-input" placeholder="القيمة" style="flex:1;">' +
      '<button class="btn btn-primary" onclick="posApplyManualInvoiceDiscount()">تطبيق</button>' +
    '</div>' +
  '</div>';
  if (state.currentDiscount.amount > 0) {
    html += '<button class="btn btn-light" style="width:100%;margin-top:10px;color:#b91c1c;" onclick="posClearInvoiceDiscount()"><i class="fas fa-times"></i> إلغاء الخصم الحالي (' + _posFmt(state.currentDiscount.amount) + ')</button>';
  }

  state._discListSnapshot = invDiscounts;
  q('#discModalList').innerHTML = html;
  openGlassModal('#modalDiscount');
};

window.posApplyInvoiceDiscount = function(discId) {
  var d = (state._discListSnapshot || []).find(function(x){return x.id===discId;});
  if (!d) return;
  var subtotal = state.cart.reduce(function(s, c){ return s + (c.qty * posGetItemPrice(c)); }, 0);
  var amt = d.type === 'percentage' ? subtotal * (d.value/100) : Number(d.value);
  if (d.maxAmount && amt > d.maxAmount) amt = d.maxAmount;
  if (d.maxPerInvoice && amt > d.maxPerInvoice) amt = d.maxPerInvoice;
  if (amt > subtotal) amt = subtotal;
  state.currentDiscount = { name: d.name, amount: amt, discountId: d.id, glAccountId: d.glAccountId };
  closeGlassModal('#modalDiscount');
  glassToast('تم تطبيق خصم: ' + d.name + ' (' + _posFmt(amt) + ' SAR)');
  updateCart();
};

window.posApplyManualInvoiceDiscount = function() {
  var type = q('#posInvDiscType').value;
  var val = Number(q('#posInvDiscValue').value) || 0;
  if (val <= 0) return glassToast('أدخل قيمة موجبة', true);
  var subtotal = state.cart.reduce(function(s, c){ return s + (c.qty * posGetItemPrice(c)); }, 0);
  var amt = type === 'percentage' ? subtotal * (val/100) : val;
  if (amt > subtotal) amt = subtotal;
  state.currentDiscount = { name: 'يدوي', amount: amt, discountId: null, glAccountId: null };
  closeGlassModal('#modalDiscount');
  glassToast('تم تطبيق خصم يدوي');
  updateCart();
};

window.posClearInvoiceDiscount = function() {
  state.currentDiscount = { name:'', amount: 0 };
  closeGlassModal('#modalDiscount');
  updateCart();
};

// ─── V5.7.15 Shift-Close — counter-first flow with reveal+variance gate ─────
//   The cashier:
//     1. sees items SOLD (read-only) for inventory verification
//     2. counts cash by denomination  (denom-card grid)
//     3. enters per-method electronic actuals (no 'expected' shown yet)
//     4. ticks "I'm done counting" → expected reveals, variance computes
//     5. if variance != 0, MUST type a reason ≥10 chars to unlock the close button
//   The close button is locked until the reveal happens AND (variance==0 OR
//   reason is filled).
// V5.7.15 — extended denomination set including ½ SAR coin
state._v3CashDenoms = [500, 200, 100, 50, 20, 10, 5, 1, 0.5];

// In-memory state for the modal session
var _scExpectedTotal = 0;       // total expected from system (loaded but hidden)
var _scExpectedCash  = 0;       // cash portion of expected
var _scExpectedElec  = {};      // { methodId: amount }
var _scElecMethods   = [];      // methods array from backend
var _scRevealed      = false;   // has the cashier ticked the reveal box?

window.shiftCloseStart = function() {
  if (!state.activeShiftId) return glassToast(t ? t('noActiveShift') : 'لا توجد وردية مفتوحة', true);

  // ── Reset session state ──
  _scExpectedTotal = 0;
  _scExpectedCash  = 0;
  _scExpectedElec  = {};
  _scElecMethods   = [];
  _scRevealed      = false;
  q('#scNotes').value = '';
  if (q('#scRevealCheck')) q('#scRevealCheck').checked = false;
  if (q('#scComparePanel')) q('#scComparePanel').classList.add('hidden');
  if (q('#scVarianceAlert')) q('#scVarianceAlert').classList.add('hidden');
  if (q('#scVarianceNote')) q('#scVarianceNote').value = '';
  _scLockClose('أنهِ العدّ أولاً', 'fa-lock');

  // ── Cashier label ──
  var cashierName = (state.currentUser && state.currentUser.displayName) || state.user || '—';
  if (q('#scCashierLbl')) q('#scCashierLbl').textContent = cashierName;

  // ── Denomination cards ──
  var grid = q('#scDenomGrid');
  if (grid) {
    grid.innerHTML = state._v3CashDenoms.map(function(d) {
      var label = d < 1 ? (d * 100) + ' هـ' : d + ' SAR';
      var unit  = d < 1 ? 'هللة' : (d <= 1 ? 'ريال' : 'فئة');
      return '<div class="sc-denom-card">' +
               '<div class="sc-denom-card-top"><span class="sc-denom-face">' + label + '</span><span class="sc-denom-unit">' + unit + '</span></div>' +
               '<input type="number" inputmode="numeric" min="0" step="1" class="sc-denom-input" data-denom="' + d + '" value="0" oninput="scV3Recalc()" onfocus="this.select()">' +
               '<div class="sc-denom-card-total" data-denom="' + d + '">0.00</div>' +
             '</div>';
    }).join('');
  }

  // ── Open the modal early so the user sees the loading state for items + methods ──
  openGlassModal('#modalShiftClose');
  // V5.7.16 — translate the modal's static labels immediately
  if (typeof window.translateNow === 'function') window.translateNow(q('#modalShiftClose'));

  // ── Fetch shift data (items + methods + expected) ──
  _posCallAPI('GET', '/shifts/closing-data/' + state.activeShiftId, null, function(d) {
    if (!d || d.error) {
      glassToast((d && d.error) || 'فشل تحميل بيانات الوردية', true);
      return;
    }

    // ── Stash expected (will only be SHOWN after reveal) ──
    _scExpectedTotal = Number(d.totalTheoretical || 0);
    var methods = d.methods || [];
    _scElecMethods = methods.filter(function(m) {
      var gt = (m.groupType || '').toLowerCase();
      return gt !== 'cash' && gt !== 'unmatched';
    });
    var cashSum = 0;
    methods.forEach(function(m) {
      var gt = (m.groupType || '').toLowerCase();
      if (gt === 'cash') cashSum += Number(m.expectedAmount || 0);
      else _scExpectedElec[m.id] = Number(m.expectedAmount || 0);
    });
    if (cashSum === 0) cashSum = Number(d.theoreticalCash || 0);
    _scExpectedCash = cashSum;

    // ── Header counters ──
    if (q('#scOrdersLbl')) q('#scOrdersLbl').textContent = Number(d.orderCount || 0);
    var totalItems = (d.soldItems || []).reduce(function(s, i){ return s + Number(i.qty || 0); }, 0);
    if (q('#scItemsCountLbl')) q('#scItemsCountLbl').textContent = totalItems;

    // ── Items-sold table ──
    var itemsBody = q('#scItemsBody');
    if (itemsBody) {
      var items = d.soldItems || [];
      if (!items.length) {
        itemsBody.innerHTML = '<tr><td colspan="4" class="sc-empty">لا توجد أصناف مباعة في هذه الوردية</td></tr>';
      } else {
        itemsBody.innerHTML = items.map(function(it) {
          return '<tr>' +
                   '<td>' + (it.name || '—') + '</td>' +
                   '<td><strong>' + Number(it.qty || 0) + '</strong></td>' +
                   '<td>' + _posFmt(Number(it.price || 0)) + '</td>' +
                   '<td><strong style="color:#16a34a;">' + _posFmt(Number(it.total || 0)) + '</strong></td>' +
                 '</tr>';
        }).join('');
      }
    }

    // ── Electronic methods cards (NO expected shown) ──
    var elecGrid = q('#scElecGrid');
    if (elecGrid) {
      if (!_scElecMethods.length) {
        elecGrid.innerHTML = '<div class="sc-empty">لا توجد طرق دفع إلكترونية</div>';
      } else {
        elecGrid.innerHTML = _scElecMethods.map(function(m) {
          return '<div class="sc-elec-card">' +
                   '<div class="sc-elec-card-head"><i class="fas ' + (m.icon || 'fa-credit-card') + '" style="color:' + (m.color || '#3b82f6') + ';"></i> <span>' + (m.nameAr || m.name) + '</span></div>' +
                   '<input type="number" inputmode="decimal" min="0" step="0.01" class="sc-elec-input" data-pmid="' + m.id + '" data-pmname="' + (m.name || '').toLowerCase() + '" placeholder="0.00" oninput="scV3Recalc()" onfocus="this.select()">' +
                 '</div>';
        }).join('');
      }
    }

    scV3Recalc();
    // V5.7.16 — re-translate the freshly-populated tables (item names,
    //           electronic-method labels, etc.) so they appear in English.
    if (typeof window.translateNow === 'function') window.translateNow(q('#modalShiftClose'));
  });
};

// V5.7.15 — Recalc all totals. Called on every input change.
//   • Always updates the "actual" totals (cashier sees what they entered)
//   • Only updates the "expected" + "diff" cards when revealed
window.scV3Recalc = function() {
  // Cash from denominations
  var actualCash = 0;
  document.querySelectorAll('.sc-denom-input').forEach(function(inp) {
    var denom = Number(inp.dataset.denom);
    var cnt   = Number(inp.value) || 0;
    var sum   = denom * cnt;
    var totEl = document.querySelector('.sc-denom-card-total[data-denom="' + denom + '"]');
    if (totEl) totEl.textContent = _posFmt(sum);
    actualCash += sum;
  });
  if (q('#scActualCash')) q('#scActualCash').textContent = _posFmt(actualCash) + ' SAR';

  // Electronic actual sum
  var elecActual = 0;
  var elecActualByMethod = {};
  document.querySelectorAll('.sc-elec-input').forEach(function(inp) {
    var v = Number(inp.value) || 0;
    elecActual += v;
    elecActualByMethod[inp.dataset.pmid] = v;
  });
  if (q('#scTotalElecActual')) q('#scTotalElecActual').textContent = _posFmt(elecActual) + ' SAR';

  // Comparison panel — only render when revealed
  if (!_scRevealed) {
    _scLockClose('أنهِ العدّ أولاً', 'fa-lock');
    return;
  }

  var totalActual = actualCash + elecActual;
  var totalDiff   = totalActual - _scExpectedTotal;
  var absDiff     = Math.abs(totalDiff);

  if (q('#scCmpExpected')) q('#scCmpExpected').textContent = _posFmt(_scExpectedTotal);
  if (q('#scCmpActual'))   q('#scCmpActual').textContent   = _posFmt(totalActual);
  if (q('#scCmpDiff'))     q('#scCmpDiff').textContent     = (totalDiff >= 0 ? '+' : '') + _posFmt(totalDiff);

  // Color the diff card
  var diffCard = q('#scCmpDiffCard');
  var diffLbl  = q('#scCmpDiffLbl');
  if (diffCard) {
    diffCard.classList.remove('sc-cmp-diff-zero','sc-cmp-diff-pos','sc-cmp-diff-neg');
    if (absDiff < 0.01) {
      diffCard.classList.add('sc-cmp-diff-zero');
      if (diffLbl) diffLbl.textContent = 'متطابق ✓';
    } else if (totalDiff < 0) {
      diffCard.classList.add('sc-cmp-diff-neg');
      if (diffLbl) diffLbl.textContent = 'عجز في الصندوق';
    } else {
      diffCard.classList.add('sc-cmp-diff-pos');
      if (diffLbl) diffLbl.textContent = 'زيادة في الصندوق';
    }
  }

  // Per-method breakdown (cash row + each electronic method)
  var pmd = q('#scPerMethodDiff');
  if (pmd) {
    var rows = [];
    rows.push(_scPmdRow('💵 نقدي / كاش', _scExpectedCash, actualCash));
    _scElecMethods.forEach(function(m) {
      var label = '<i class="fas ' + (m.icon || 'fa-credit-card') + '" style="color:' + (m.color || '#3b82f6') + ';margin-inline-end:4px;"></i>' + (m.nameAr || m.name);
      rows.push(_scPmdRow(label, _scExpectedElec[m.id] || 0, elecActualByMethod[m.id] || 0));
    });
    pmd.innerHTML = rows.join('');
  }

  // Variance alert + close-button gate
  if (absDiff < 0.01) {
    if (q('#scVarianceAlert')) q('#scVarianceAlert').classList.add('hidden');
    _scUnlockClose();
  } else {
    if (q('#scVarianceAlert')) q('#scVarianceAlert').classList.remove('hidden');
    var note = (q('#scVarianceNote') && q('#scVarianceNote').value || '').trim();
    if (note.length >= 10) _scUnlockClose();
    else _scLockClose('اشرح الفرق أولاً (' + note.length + '/10)', 'fa-pen');
  }
};

function _scPmdRow(label, exp, act) {
  var diff = act - exp;
  var clr  = Math.abs(diff) < 0.01 ? '#16a34a' : (diff < 0 ? '#dc2626' : '#d97706');
  var sign = diff >= 0 ? '+' : '';
  return '<div class="sc-pmd-row">' +
           '<div class="sc-pmd-name">' + label + '</div>' +
           '<div class="sc-pmd-vals">' +
             '<span class="sc-pmd-exp">المسجَّل: ' + _posFmt(exp) + '</span>' +
             '<span class="sc-pmd-act">الفعلي: ' + _posFmt(act) + '</span>' +
             '<span class="sc-pmd-diff" style="color:' + clr + ';">' + sign + _posFmt(diff) + '</span>' +
           '</div>' +
         '</div>';
}

function _scLockClose(label, icon) {
  var btn = q('#scCloseBtn');
  if (!btn) return;
  btn.disabled = true;
  btn.style.opacity = '0.55';
  btn.style.cursor = 'not-allowed';
  btn.style.background = '#94a3b8';
  btn.style.borderColor = '#94a3b8';
  btn.innerHTML = '<i class="fas ' + (icon || 'fa-lock') + '"></i> ' + label;
}
function _scUnlockClose() {
  var btn = q('#scCloseBtn');
  if (!btn) return;
  btn.disabled = false;
  btn.style.opacity = '1';
  btn.style.cursor = 'pointer';
  btn.style.background = '#16a34a';
  btn.style.borderColor = '#16a34a';
  btn.innerHTML = '<i class="fas fa-check-double"></i> تأكيد إغلاق الوردية';
}

// V5.7.15 — User ticked / unticked the "I'm done counting" checkbox
window.scToggleReveal = function(checked) {
  _scRevealed = !!checked;
  if (q('#scComparePanel')) {
    q('#scComparePanel').classList.toggle('hidden', !_scRevealed);
  }
  scV3Recalc();
  // Smooth-scroll the comparison panel into view when revealed
  if (_scRevealed && q('#scComparePanel')) {
    setTimeout(function() {
      try { q('#scComparePanel').scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch(_) {}
    }, 80);
  }
};

window.scOnNoteInput = function() {
  var note = (q('#scVarianceNote') && q('#scVarianceNote').value || '').trim();
  var counter = q('#scNoteCounter');
  if (counter) {
    counter.textContent = note.length + ' / 10';
    counter.style.color = note.length >= 10 ? '#16a34a' : '#dc2626';
  }
  scV3Recalc();
};

// V5.7.17 — World-class thermal-printer end-of-day report.
//   Single GET to /api/shifts/:id/full-report returns everything the report
//   needs in one round-trip (cashier, branch, items, methods with expected
//   vs actual, denominations, variance, opening float). The HTML below is
//   sized for 80mm thermal paper but degrades cleanly to A4 too.
window.printShiftThermalReport = function(shiftId) {
  if (!shiftId) shiftId = state.activeShiftId;
  if (!shiftId) return glassToast('لا يوجد رقم وردية', true);
  loader(true);
  _posCallAPI('GET', '/shifts/' + encodeURIComponent(shiftId) + '/full-report', null, function(d) {
    loader(false);
    if (!d || d.error) return glassToast((d && d.error) || 'فشل تحميل بيانات التقرير', true);
    _renderShiftThermalReport(d);
  });
};

function _renderShiftThermalReport(d) {
  function fmt(v)    { return Number(v || 0).toFixed(2); }
  function fmtArDate(s) { try { return new Date(s).toLocaleString('ar-SA'); } catch(e) { return s || '—'; } }
  function fmtDuration(ms) {
    if (!ms || ms < 0) return '—';
    var h = Math.floor(ms / 3600000);
    var m = Math.floor((ms % 3600000) / 60000);
    return (h > 0 ? h + 'س ' : '') + m + 'د';
  }

  var c = d.company || {};
  var br = d.branch || {};
  var ca = d.cashier || {};
  var f = d.financials || {};
  var t = d.times || {};
  var methods = d.methods || [];
  var items   = d.soldItems || [];
  var denoms  = (d.denominations || []).filter(function(x) { return Number(x.count) > 0; })
                                       .sort(function(a, b) { return Number(b.value) - Number(a.value); });

  var sumDenoms = denoms.reduce(function(s, x) { return s + (Number(x.value) * Number(x.count)); }, 0);

  // Sections
  var logoTag = c.logo
    ? '<div style="text-align:center;margin-bottom:6px;"><img src="' + c.logo + '" style="max-width:90px;max-height:90px;object-fit:contain;"></div>'
    : '';

  var headerHtml =
    logoTag +
    '<div style="text-align:center;font-size:13px;font-weight:700;direction:rtl;margin-bottom:1px;">' + (c.nameAr || 'المذاق المغربي') + '</div>' +
    '<div style="text-align:center;font-size:18px;font-weight:900;direction:ltr;margin-bottom:' + (br.companyName ? '2' : '6') + 'px;">' + (c.name || 'Moroccan Taste') + '</div>' +
    (br.companyName
      ? '<div style="text-align:center;font-size:12px;font-weight:700;color:#000;direction:rtl;margin-bottom:6px;border-bottom:1px solid #d4d4d4;padding-bottom:6px;">' + br.companyName + '</div>'
      : '') +
    '<div style="text-align:center;font-size:11px;direction:rtl;margin-bottom:2px;">تقرير إقفال الوردية</div>' +
    '<div style="text-align:center;font-size:10px;color:#444;margin-bottom:6px;">SHIFT CLOSING REPORT</div>' +
    (c.taxNumber ? '<div style="text-align:center;font-size:10px;font-family:monospace;color:#444;margin-bottom:4px;">' + c.taxNumber + '</div>' : '') +
    (br.name ? '<div style="text-align:center;font-size:11px;font-weight:700;direction:ltr;">' + br.name.toUpperCase() + '</div>' : '') +
    (br.address ? '<div style="text-align:center;font-size:9px;color:#666;direction:rtl;margin-bottom:4px;">' + br.address + '</div>' : '');

  function row(label, value, opts) {
    opts = opts || {};
    return '<div style="display:flex;justify-content:space-between;font-size:11px;padding:2px 0;' + (opts.border ? 'border-bottom:1px dashed #999;' : '') + '">' +
             '<span style="color:#000;' + (opts.bold ? 'font-weight:700;' : '') + '">' + label + '</span>' +
             '<span style="color:#000;font-family:monospace;' + (opts.bold ? 'font-weight:800;' : '') + (opts.color ? 'color:' + opts.color + ';' : '') + '">' + value + '</span>' +
           '</div>';
  }

  // Section: Shift meta
  var metaHtml =
    '<div style="border-top:1px dashed #000;border-bottom:1px dashed #000;padding:6px 0;margin:8px 0;">' +
      row('رقم الوردية', d.shiftId, { bold: true }) +
      row('الكاشير', (ca.name || ca.username) + (ca.empNo && ca.empNo !== ca.name ? ' (' + ca.empNo + ')' : ''), { bold: true }) +
      row('وقت الفتح', fmtArDate(t.start)) +
      row('وقت الإغلاق', fmtArDate(t.end)) +
      row('مدة الوردية', fmtDuration(t.durationMs)) +
      row('عدد الفواتير', String(d.orderCount || 0), { bold: true }) +
      row('عدد الأصناف', String(d.itemsCount || 0), { bold: true }) +
    '</div>';

  // Section: Items sold
  var itemsHtml = '<div style="text-align:center;font-weight:800;font-size:11px;background:#000;color:#fff;padding:3px 6px;margin:8px 0 4px;">الأصناف المباعة | ITEMS SOLD</div>';
  if (!items.length) {
    itemsHtml += '<div style="text-align:center;font-size:10px;color:#999;padding:6px;">— لا توجد أصناف —</div>';
  } else {
    itemsHtml += '<table style="width:100%;border-collapse:collapse;font-size:10.5px;">' +
                   '<thead><tr style="border-bottom:1px solid #000;">' +
                     '<th style="text-align:right;padding:3px 0;font-size:10px;">الصنف</th>' +
                     '<th style="text-align:center;padding:3px 0;font-size:10px;">الكمية</th>' +
                     '<th style="text-align:center;padding:3px 0;font-size:10px;">السعر</th>' +
                     '<th style="text-align:left;padding:3px 0;font-size:10px;">الإجمالي</th>' +
                   '</tr></thead><tbody>';
    items.forEach(function(it) {
      itemsHtml += '<tr>' +
                     '<td style="padding:2px 0;">' + (it.name || '—') + '</td>' +
                     '<td style="text-align:center;padding:2px 0;">' + (Number(it.qty) || 0) + '</td>' +
                     '<td style="text-align:center;padding:2px 0;font-family:monospace;">' + fmt(it.price) + '</td>' +
                     '<td style="text-align:left;padding:2px 0;font-family:monospace;font-weight:700;">' + fmt(it.total) + '</td>' +
                   '</tr>';
    });
    itemsHtml += '</tbody></table>';
  }

  // Section: Cash denominations
  var denomsHtml = '<div style="text-align:center;font-weight:800;font-size:11px;background:#000;color:#fff;padding:3px 6px;margin:8px 0 4px;">فئات النقد في الصندوق | CASH BREAKDOWN</div>';
  if (!denoms.length) {
    denomsHtml += '<div style="text-align:center;font-size:10px;color:#999;padding:6px;">— لم يُسجَّل نقد —</div>';
  } else {
    denomsHtml += '<table style="width:100%;border-collapse:collapse;font-size:10.5px;">';
    denoms.forEach(function(x) {
      var subtotal = Number(x.value) * Number(x.count);
      var faceLabel = Number(x.value) < 1
        ? (Number(x.value) * 100) + ' هـ'
        : Number(x.value) + ' SAR';
      denomsHtml += '<tr>' +
                      '<td style="padding:2px 0;font-weight:700;">' + faceLabel + '</td>' +
                      '<td style="text-align:center;padding:2px 0;">×</td>' +
                      '<td style="text-align:center;padding:2px 0;font-weight:700;">' + Number(x.count) + '</td>' +
                      '<td style="text-align:center;padding:2px 0;">=</td>' +
                      '<td style="text-align:left;padding:2px 0;font-family:monospace;font-weight:800;">' + fmt(subtotal) + '</td>' +
                    '</tr>';
    });
    denomsHtml += '</table>';
    denomsHtml += '<div style="border-top:1px dashed #000;margin-top:4px;padding-top:4px;font-size:11px;font-weight:800;display:flex;justify-content:space-between;">' +
                    '<span>إجمالي النقد المعدود:</span>' +
                    '<span style="font-family:monospace;">' + fmt(sumDenoms) + ' ' + (c.currency || 'SAR') + '</span>' +
                  '</div>';
  }

  // Section: Payment methods reconciliation
  var methodsHtml = '<div style="text-align:center;font-weight:800;font-size:11px;background:#000;color:#fff;padding:3px 6px;margin:8px 0 4px;">تسوية طرق الدفع | PAYMENT RECONCILIATION</div>';
  methodsHtml += '<table style="width:100%;border-collapse:collapse;font-size:10.5px;">' +
                   '<thead><tr style="border-bottom:1px solid #000;">' +
                     '<th style="text-align:right;padding:3px 0;font-size:9.5px;">الطريقة</th>' +
                     '<th style="text-align:center;padding:3px 0;font-size:9.5px;">المتوقع</th>' +
                     '<th style="text-align:center;padding:3px 0;font-size:9.5px;">الفعلي</th>' +
                     '<th style="text-align:left;padding:3px 0;font-size:9.5px;">الفرق</th>' +
                   '</tr></thead><tbody>';
  methods.forEach(function(m) {
    var diff = m.variance;
    var diffColor = Math.abs(diff) < 0.01 ? '#000' : (diff < 0 ? '#000' : '#000');
    var diffPrefix = diff > 0 ? '+' : '';
    methodsHtml += '<tr>' +
                     '<td style="padding:2px 0;font-weight:700;">' + (m.nameAr || m.name) + '</td>' +
                     '<td style="text-align:center;padding:2px 0;font-family:monospace;">' + fmt(m.expected) + '</td>' +
                     '<td style="text-align:center;padding:2px 0;font-family:monospace;font-weight:700;">' + fmt(m.actual) + '</td>' +
                     '<td style="text-align:left;padding:2px 0;font-family:monospace;font-weight:800;color:' + diffColor + ';">' + diffPrefix + fmt(diff) + '</td>' +
                   '</tr>';
  });
  methodsHtml += '<tr style="border-top:1px solid #000;font-weight:900;">' +
                   '<td style="padding:3px 0;">الإجمالي</td>' +
                   '<td style="text-align:center;padding:3px 0;font-family:monospace;">' + fmt(f.expectedTotal) + '</td>' +
                   '<td style="text-align:center;padding:3px 0;font-family:monospace;">' + fmt(f.actualTotal) + '</td>' +
                   '<td style="text-align:left;padding:3px 0;font-family:monospace;">' + (f.variance > 0 ? '+' : '') + fmt(f.variance) + '</td>' +
                 '</tr>';
  methodsHtml += '</tbody></table>';
  if (f.unmatched > 0) {
    methodsHtml += '<div style="margin-top:4px;padding:4px;border:1px dashed #000;font-size:9.5px;text-align:center;">' +
                     '⚠ مبلغ غير مصنّف: ' + fmt(f.unmatched) +
                   '</div>';
  }
  // V5.7.21 — per user direction: when net = 0, the report says "balanced"
  //   regardless of per-method offsetting diffs. The offsetting warning
  //   was removed; per-method numbers remain visible in the table above.

  // Section: Variance summary box
  var varianceLabel = Math.abs(f.variance) < 0.01 ? 'متطابق' : (f.variance < 0 ? 'عجز' : 'زيادة');
  var varianceHtml =
    '<div style="text-align:center;font-weight:800;font-size:11px;background:#000;color:#fff;padding:3px 6px;margin:8px 0 4px;">ملخص الإغلاق | SUMMARY</div>' +
    '<div style="border:1.5px solid #000;padding:6px 8px;margin:4px 0;">' +
      row('الرصيد الافتتاحي', fmt(f.openingFloat) + ' ' + (c.currency || 'SAR')) +
      row('إجمالي المبيعات (متوقع)', fmt(f.expectedTotal) + ' ' + (c.currency || 'SAR'), { bold: true }) +
      row('إجمالي الجرد الفعلي', fmt(f.actualTotal) + ' ' + (c.currency || 'SAR'), { bold: true }) +
      row('الفرق (' + varianceLabel + ')', (f.variance > 0 ? '+' : '') + fmt(f.variance) + ' ' + (c.currency || 'SAR'), { bold: true }) +
    '</div>';

  // Notes
  var notesHtml = '';
  if (d.notes) {
    notesHtml = '<div style="margin-top:8px;padding:6px;border:1px dashed #999;font-size:10px;direction:rtl;">' +
                  '<div style="font-weight:700;margin-bottom:3px;">📝 ملاحظات:</div>' +
                  '<div style="white-space:pre-wrap;">' + d.notes + '</div>' +
                '</div>';
  }

  // Signatures
  var sigHtml =
    '<div style="margin-top:12px;display:flex;gap:6px;justify-content:space-between;">' +
      '<div style="flex:1;text-align:center;">' +
        '<div style="border-top:1px solid #000;margin-top:24px;padding-top:3px;font-size:9.5px;font-weight:700;">المستلم</div>' +
      '</div>' +
      '<div style="flex:1;text-align:center;">' +
        '<div style="border-top:1px solid #000;margin-top:24px;padding-top:3px;font-size:9.5px;font-weight:700;">' + (ca.name || ca.username) + '</div>' +
      '</div>' +
      '<div style="flex:1;text-align:center;">' +
        '<div style="border-top:1px solid #000;margin-top:24px;padding-top:3px;font-size:9.5px;font-weight:700;">الإدارة</div>' +
      '</div>' +
    '</div>';

  // Footer
  var footerHtml =
    '<div style="text-align:center;margin-top:8px;font-size:9px;color:#444;border-top:1px dashed #000;padding-top:4px;">' +
      'وثيقة موثّقة آلياً — Moroccan Taste POS<br>' +
      'طُبع: ' + fmtArDate(new Date()) +
      (c.phone ? '<br>Tel: ' + c.phone : '') +
      (c.email ? '<br>Email: ' + c.email : '') +
    '</div>';

  // V5.7.21 — read user language from localStorage so the print window
  //   matches the cashier's selection. Embed the translator script so
  //   English mode can flip every Arabic label before window.print().
  var userLang = 'ar';
  try {
    userLang = localStorage.getItem('pos_lang') || localStorage.getItem('emp_lang') || 'ar';
  } catch (e) {}
  var dirAttr = userLang === 'en' ? 'ltr' : 'rtl';

  // Combine + open print window
  var w = window.open('', '_blank', 'width=380,height=900');
  if (!w) return glassToast('السماح للنوافذ المنبثقة مطلوب', true);
  w.document.write(
    '<!DOCTYPE html><html lang="' + userLang + '" dir="' + dirAttr + '"><head><meta charset="UTF-8">' +
    '<title>Shift Report — ' + d.shiftId + '</title>' +
    '<style>' +
      '*{margin:0;padding:0;box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact;}' +
      'body{font-family:"Helvetica Neue",Arial,"Segoe UI",sans-serif;padding:10px;width:300px;margin:0 auto;font-size:12px;color:#000;background:#fff;}' +
      'table{border-collapse:collapse;}' +
      '@media print{@page{margin:0;size:80mm auto;}body{padding:4px;width:100%;}}' +
    '</style>' +
    // V5.7.21 — embed the translator so the new window can flip Arabic
    //   labels to English before printing (same /api/i18n/translate
    //   proxy backed by Google Translate, with localStorage cache).
    '<script src="/shared/dynamic-i18n.js?v=2"></script>' +
    '</head><body>' +
    headerHtml + metaHtml + itemsHtml + denomsHtml + methodsHtml + varianceHtml + notesHtml + sigHtml + footerHtml +
    '<script>(function(){' +
      'try {' +
        'var lang = ' + JSON.stringify(userLang) + ';' +
        'if (lang === "en" && window.DynamicI18N) {' +
          'window.DynamicI18N.translatePage("en").then(function(){' +
            'setTimeout(function(){ window.print(); }, 300);' +
          '}).catch(function(){ setTimeout(function(){ window.print(); }, 500); });' +
        '} else {' +
          'setTimeout(function(){ window.print(); }, 400);' +
        '}' +
      '} catch(e) { setTimeout(function(){ window.print(); }, 400); }' +
    '})();<\/script>' +
    '</body></html>'
  );
  w.document.close();
}

window.scV3ConfirmClose = function() {
  if (!state.activeShiftId) return;
  if (!_scRevealed) return glassToast('فعِّل "أنهيت العدّ" أولاً', true);

  // Build payload
  var denoms = [];
  document.querySelectorAll('.sc-denom-input').forEach(function(inp) {
    denoms.push({ value: Number(inp.dataset.denom), count: Number(inp.value) || 0, kind: Number(inp.dataset.denom) <= 1 ? 'coin' : 'note' });
  });
  // V5.7.17 — send paymentTotals keyed by method.id (CANONICAL).
  //   Backend tries id-match first, then name fallback. Canonical IDs are
  //   stable across name changes — fixes the bug where "هانجر ستيشن"
  //   amounts didn't show in the report (the old by-name key didn't
  //   roundtrip through the broken matcher).
  var paymentTotals = {};
  document.querySelectorAll('.sc-elec-input').forEach(function(inp) {
    var v = Number(inp.value) || 0;
    if (inp.dataset.pmid) paymentTotals[String(inp.dataset.pmid)] = v;
    // Also include by-name as a redundant key (defensive — if backend
    // somehow can't find the id, name still resolves)
    if (inp.dataset.pmname) paymentTotals[inp.dataset.pmname] = v;
  });
  var generalNotes  = (q('#scNotes') && q('#scNotes').value || '').trim();
  var varianceNote  = (q('#scVarianceNote') && q('#scVarianceNote').value || '').trim();
  var combinedNotes = generalNotes + (varianceNote ? (generalNotes ? '\n\n[سبب الفرق]: ' : '[سبب الفرق]: ') + varianceNote : '');

  var payload = {
    shiftId: state.activeShiftId,
    openingFloat: 0,
    denominations: denoms,
    paymentTotals: paymentTotals,
    notes: combinedNotes
  };

  glassConfirm('تأكيد إغلاق الوردية', 'سيتم تسجيل بيانات الإغلاق وإقفال الجلسة. هل تتابع؟', { okText: 'إغلاق الوردية', danger: true }).then(function(ok) {
    if (!ok) return;
    loader(true);
    _posCallAPI('POST', '/shifts/close-v3', payload, function(r) {
      loader(false);
      if (r && r.success) {
        var closedShiftId = state.activeShiftId;
        state.activeShiftId = '';
        saveState();
        localStorage.removeItem('pos_active_shift_id');
        updateShiftUI();
        renderHeader('pos', { showShift: true });
        closeGlassModal('#modalShiftClose');
        glassToast('تم إغلاق الوردية بنجاح — جاري إنشاء التقرير الحراري');
        // V5.7.17 — auto-print the world-class thermal report on close
        setTimeout(function() {
          try { window.printShiftThermalReport(closedShiftId); } catch (e) {
            console.warn('thermal report failed:', e);
            scV3ShowReport(closedShiftId, r);
          }
        }, 350);
      } else {
        glassToast((r && r.error) || 'فشل إغلاق الوردية', true);
      }
    });
  });
};

window.scV3Print = function() {
  var w = window.open('', '_blank');
  if (!w) return glassToast('تعذّر فتح نافذة الطباعة', true);
  var title = 'تقرير إغلاق الوردية - ' + (state.activeShiftId || '');
  var html = '<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="UTF-8"><title>' + title + '</title>' +
    '<style>body{font-family:Arial,sans-serif;padding:20px;}h2{color:#1e3a8a;border-bottom:2px solid #1e3a8a;padding-bottom:6px;}table{width:100%;border-collapse:collapse;margin:10px 0;}th,td{border:1px solid #cbd5e1;padding:6px 10px;text-align:right;}th{background:#dbeafe;}</style>' +
    '</head><body>' +
    '<h2>تقرير إغلاق الوردية</h2>' +
    '<p>الكاشير: ' + (state.user || '—') + ' | التاريخ: ' + new Date().toLocaleString('ar-SA') + '</p>' +
    document.querySelector('.sc-v3-modal').innerHTML.replace(/<button[^>]*>.*?<\/button>/g,'') +
    '</body></html>';
  w.document.write(html);
  w.document.close();
  setTimeout(function(){ w.print(); }, 500);
};

function scV3ShowReport(shiftId, r) {
  // V3 FIX: populate state._lastShiftReport so Print + WhatsApp buttons work.
  // The legacy printShiftReport/shareShiftReportWhatsApp handlers read from this
  // field and silently return null if it's empty (which broke the V3 close flow).
  var company = (state.settings && state.settings.name) || 'Moroccan Taste';
  var now = new Date();
  var actuals = (r && r.actuals) || {};
  var cashAmt = Number(actuals.cash || 0);
  var cardAmt = Number(actuals.card || actuals['mada'] || actuals['شبكة/مدى'] || 0);
  var kitaAmt = Number(actuals.kita || 0);
  // Sum any other electronic methods (excluding cash/card/kita already counted)
  var otherAmt = 0;
  Object.keys(actuals).forEach(function(k) {
    var lk = k.toLowerCase();
    if (lk === 'cash' || lk === 'card' || lk === 'mada' || lk === 'kita') return;
    if (lk.indexOf('شبكة') >= 0 || lk.indexOf('مدى') >= 0) return;
    otherAmt += Number(actuals[k] || 0);
  });
  var totalActual = Number(r.actualTotal || (cashAmt + cardAmt + kitaAmt + otherAmt));
  var totalExpected = Number(r.expectedTotal || 0);
  var variance = Number(r.variance != null ? r.variance : (totalActual - totalExpected));
  var orders = Number(r.orderCount || 0);

  state._lastShiftReport = {
    company: company,
    date: now.toLocaleString('en-GB'),
    shiftId: shiftId,
    cashier: state.user || '',
    cashierName: (state.userMeta && state.userMeta[state.user] && state.userMeta[state.user].name) || state.user || '',
    cash: cashAmt,
    card: cardAmt,
    kita: kitaAmt,
    other: otherAmt,
    totalActual: totalActual,
    totalExpected: totalExpected,
    variance: variance,
    orders: orders,
    paymentTotals: actuals,
    denominations: r.denominations || []
  };

  // Build a richer report HTML — uses ALL the data we just stored
  var varianceClr = Math.abs(variance) < 0.01 ? '#16a34a' : (variance < 0 ? '#dc2626' : '#d97706');
  var varianceLabel = Math.abs(variance) < 0.01 ? 'متطابق ✓' : (variance < 0 ? 'نقص' : 'زيادة');
  var html = '<div style="padding:14px;">' +
    '<div style="text-align:center;padding:14px;background:linear-gradient(135deg,#dcfce7,#f0fdf4);border:1.5px solid #86efac;border-radius:12px;margin-bottom:14px;">' +
      '<i class="fas fa-check-circle" style="font-size:28px;color:#16a34a;"></i>' +
      '<h3 style="color:#15803d;margin-top:6px;font-size:16px;">تم إغلاق الوردية بنجاح</h3>' +
      '<div style="font-size:11px;color:#166534;margin-top:4px;">' + state._lastShiftReport.cashierName + ' · ' + state._lastShiftReport.date + '</div>' +
    '</div>' +
    '<div style="font-size:11px;color:#64748b;margin-bottom:6px;">رقم الوردية: <code style="background:#f1f5f9;padding:2px 6px;border-radius:4px;">' + shiftId + '</code></div>' +
    '<table style="width:100%;border-collapse:collapse;margin-top:8px;">' +
      '<tr style="background:#f8fafc;"><td colspan="2" style="padding:8px;font-weight:800;font-size:12px;">📊 الملخص</td></tr>' +
      '<tr><td style="padding:7px;border-bottom:1px solid #e2e8f0;">عدد الفواتير</td><td style="padding:7px;border-bottom:1px solid #e2e8f0;text-align:left;font-weight:700;">' + orders + '</td></tr>' +
      '<tr><td style="padding:7px;border-bottom:1px solid #e2e8f0;">إجمالي متوقع</td><td style="padding:7px;border-bottom:1px solid #e2e8f0;text-align:left;font-weight:700;">' + _posFmt(totalExpected) + ' SAR</td></tr>' +
      '<tr><td style="padding:7px;border-bottom:1px solid #e2e8f0;">إجمالي فعلي</td><td style="padding:7px;border-bottom:1px solid #e2e8f0;text-align:left;font-weight:700;">' + _posFmt(totalActual) + ' SAR</td></tr>' +
      '<tr style="background:#fef3c7;"><td style="padding:9px;font-weight:900;">الفرق (' + varianceLabel + ')</td><td style="padding:9px;text-align:left;font-weight:900;color:' + varianceClr + ';">' + (variance >= 0 ? '+' : '') + _posFmt(variance) + ' SAR</td></tr>' +
    '</table>' +
    (Object.keys(actuals).length ? (
      '<table style="width:100%;border-collapse:collapse;margin-top:14px;">' +
        '<tr style="background:#f8fafc;"><td colspan="2" style="padding:8px;font-weight:800;font-size:12px;">💳 توزيع طرق الدفع</td></tr>' +
        Object.keys(actuals).map(function(k) {
          var v = Number(actuals[k] || 0);
          return '<tr><td style="padding:6px;border-bottom:1px solid #e2e8f0;">' + k + '</td><td style="padding:6px;border-bottom:1px solid #e2e8f0;text-align:left;font-weight:700;">' + _posFmt(v) + ' SAR</td></tr>';
        }).join('') +
      '</table>'
    ) : '') +
  '</div>';

  q('#shiftReportBody').innerHTML = html;
  openGlassModal('#modalShiftReport');

  // v5.12.0 — auto-print the shift end-of-day report. Mirrors the
  // printReceiptWindow() pattern: opens a 80mm-sized window, writes
  // the same HTML the modal shows (with thermal @page rules), and
  // calls w.print() — silent under Chrome / Edge --kiosk-printing.
  setTimeout(function () {
    try { _openShiftPrintWindow(html); } catch (e) { console.warn('shift auto-print failed:', e); }
  }, 600);
}

function _openShiftPrintWindow(reportHtml) {
  // v5.12.3 — uses the same hidden-iframe silent printer as the
  // receipt path. No popup, no blocker, no leftover window.
  // v5.12.9 — same thermal-tuned font stack + crisp-stroke settings
  // as the sales receipt so Arabic glyphs aren't faded on ESC/POS.
  var html =
    '<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><title>Shift Report</title>' +
    '<style>' +
      '*{margin:0;padding:0;box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact;font-weight:inherit;}' +
      'body{font-family:"Tahoma","Cairo","Segoe UI","Arial Black",Arial,sans-serif;padding:8px;width:300px;margin:0 auto;font-size:13px;color:#000;background:#fff;font-weight:600;-webkit-font-smoothing:none;-moz-osx-font-smoothing:never;font-smooth:never;text-rendering:geometricPrecision;}' +
      'table{width:100%;border-collapse:collapse;}' +
      // v5.14.9 — Same thermal-printer override as printReceiptWindow:
      // force every element to pure black + bold + a thin text-stroke
      // so light strokes and grey labels don't disappear on cheap
      // thermal heads. Tiny 9–10px text bumped to 11px.
      '@media print{@page{margin:0;size:80mm auto;}' +
        'body{padding:4px;width:100%;font-weight:700;}' +
        '*,*::before,*::after{color:#000 !important;font-weight:700 !important;-webkit-text-stroke:0.25px #000;text-shadow:0 0 0.4px #000;}' +
        '[style*="font-size:9px"],[style*="font-size:10px"]{font-size:11px !important;}' +
      '}' +
    '</style></head><body>' +
    reportHtml +
    '</body></html>';
  if (typeof window._silentPrint === 'function') {
    window._silentPrint(html);
  }
}

