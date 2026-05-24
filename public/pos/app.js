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

  // v5.15.1 — Build the cashier list from channelMenuItems DIRECTLY when
  // a non-MAIN channel is active. The channel-menu API already JOINs the
  // menu table and returns itemName, category, basePrice, effectivePrice,
  // cost, bomId — everything the grid needs. Doing it this way bypasses
  // state.menu's brand filter at /init/:username, so channels can carry
  // items from any brand and the cashier sees them regardless of which
  // brand the cashier user is bound to. Fixes the long-standing "channel
  // has items but products don't appear" bug.
  var list;
  var channelEmpty = false;
  if (state.activeChannel && !state.activeChannel.useFullMenu) {
    // v5.15.3 — Defend against orphaned channel_menu_items rows whose
    // menu_item_id was deleted from the menu table (LEFT JOIN leaks
    // NULL itemName). Backend route now filters these out too, but
    // skip empty names here as well so an old client never renders
    // blank product cards.
    var chRows = (state.channelMenuItems || []).filter(function (r) {
      return r.isAvailable !== false && r.itemName && String(r.itemName).trim();
    });
    list = chRows.map(function (r) {
      return {
        id: r.menuItemId,
        name: r.itemName,
        category: r.category || '',
        price: r.effectivePrice != null ? Number(r.effectivePrice) : Number(r.basePrice || 0),
        cost: Number(r.cost || 0),
        active: true,
        bomId: r.bomId || null,
        imageData: null,
        __fromChannel: true
      };
    });
    channelEmpty = (list.length === 0);
  } else {
    list = (state.menu || []).filter(function (i) { return i.active; });
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
    // v5.16.2 — Full diagnostic panel for the empty grid. Tells the
    // cashier (and the owner staring at "no menu") EXACTLY why the
    // grid is empty: which channel is active, how many items the
    // brand has loaded, how many items the channel has configured,
    // and a one-click action to either auto-populate the channel
    // from the brand's menu, or switch to MAIN. No more guessing.
    var ch = state.activeChannel || {};
    var chName = ch.name || ch.code || '—';
    var chId = ch.id || '';
    var chCode = String(ch.code || '').toUpperCase();
    var isMain = (chCode === 'MAIN') || (state.activeChannel && state.activeChannel.useFullMenu);
    var menuCount = (state.menu || []).length;
    var chItemsCount = (state.channelMenuItems || []).length;
    var brandId = state.brandId || '';

    // v5.10.33 — Role check up front. Cashier-role users see a clean,
    // generic message — no technical chips, no admin actions, no
    // "Copy from MAIN" buttons. The yellow banner above (rendered by
    // _posRenderChannelEmptyState) already covers the same ground for
    // admins; if we're an admin in a non-channel-empty path, fall back
    // to the legacy diagnostic UI. The technical "channel=... menu=..."
    // chip is now gated behind state.isDeveloper or
    // localStorage.pos_is_developer === '1'.
    var _isAdmin   = (typeof isAdmin === 'function') ? isAdmin() : false;
    var _isDev     = !!(state && state.isDeveloper) || (localStorage.getItem('pos_is_developer') === '1');

    if (!_isAdmin) {
      // Cashier path: just the icon + one neutral line. No buttons.
      h = '<div style="grid-column:1/-1;text-align:center;padding:40px 20px;">' +
        '<i class="fas fa-store-slash" style="font-size:64px;margin-bottom:16px;display:block;color:#cbd5e1;"></i>' +
        '<div style="font-weight:700;font-size:15px;color:#64748b;">لا توجد أصناف في هذه الشاشة حالياً. تَواصَل مَع الإدارة لِتَكوينها.</div>' +
      '</div>';
    } else {
      // Pick the right narrative based on which condition is failing.
      var reason, action;
      if (channelEmpty) {
        reason =
          'القَناة <b style="color:#1e293b;">' + chName + '</b> ليس لها أي صَنف مُعَدّ.<br>' +
          'إعدادات القَنوات تَعمَل بِشَكل صَارِم — لا fallback تِلقائي.';
        action =
          (chId
            ? '<button onclick="posQuickPopulateChannel(\'' + chId + '\')" style="padding:12px 24px;background:linear-gradient(135deg,#7c3aed,#6d28d9);color:#fff;border:0;border-radius:10px;font-weight:800;cursor:pointer;font-size:14px;box-shadow:0 4px 14px rgba(124,58,237,0.3);"><i class="fas fa-magic"></i> انسَخ أصناف المنيو الرَئيسي إلى هذه القَناة</button> '
            : '') +
          '<button onclick="posJumpToMain()" style="padding:12px 24px;background:#fff;color:#1e293b;border:2px solid #1e293b;border-radius:10px;font-weight:800;cursor:pointer;font-size:14px;margin-inline-start:8px;"><i class="fas fa-home"></i> ارجِع للقَناة الرَئيسية (MAIN)</button>';
      } else if (!menuCount) {
        reason =
          'المنيو الرَئيسي فارِغ — لا أصناف مُسَجَّلة لِبراندك.<br>' +
          '<span style="font-size:12px;">brand_id: <code>' + (brandId || '—') + '</code></span>';
        action = '<div style="font-size:13px;color:#1e293b;background:#fef3c7;padding:10px 14px;border-radius:8px;display:inline-block;line-height:1.7;">' +
          'من admin: <b>إدارة المنيو</b> → <b>البراند الخاص بك</b> → <b>أضف منتجات</b>' +
        '</div>';
      } else {
        reason = (state.activeCat
          ? 'لا أصناف في فِئة "<b>' + state.activeCat + '</b>" ضِمن نِطاق البَحث الحالي.'
          : 'لا أصناف تُطابِق البَحث.');
        action = state.activeCat
          ? '<button onclick="posBackToCategories()" style="padding:10px 20px;background:#7c3aed;color:#fff;border:0;border-radius:8px;font-weight:700;cursor:pointer;"><i class="fas fa-arrow-right"></i> ارجِع للفِئات</button>'
          : '';
      }

      // v5.10.33 — technical chip is developer-only. Hidden from admins,
      // managers, AND cashiers in normal operation. Set
      // localStorage.pos_is_developer = '1' to surface it.
      var debugChip = _isDev
        ? ('<div style="margin-top:18px;padding:8px 14px;background:#f1f5f9;border-radius:6px;font-size:11px;color:#475569;font-family:ui-monospace,SFMono-Regular,monospace;text-align:left;direction:ltr;display:inline-block;">' +
            'channel=' + (chCode || '—') + ' · useFullMenu=' + (isMain ? 'true' : 'false') +
            ' · menu=' + menuCount +
            ' · chItems=' + chItemsCount +
            ' · cat=' + (state.activeCat || '*') +
          '</div>')
        : '';

      h = '<div style="grid-column:1/-1;text-align:center;padding:40px 20px;">' +
        '<i class="fas fa-store-slash" style="font-size:64px;margin-bottom:16px;display:block;color:#7c3aed;opacity:0.5;"></i>' +
        '<div style="font-weight:900;font-size:20px;color:#0f172a;margin-bottom:8px;">المنيو غير ظاهِر</div>' +
        '<div style="font-size:14px;color:#475569;max-width:480px;line-height:1.8;margin:0 auto 18px;">' + reason + '</div>' +
        '<div>' + action + '</div>' +
        debugChip +
      '</div>';
    }
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
          // v5.11.2 — FontAwesome icons instead of literal +/− glyphs.
          // The plain "+" was rendering as a near-invisible white character
          // inside the purple circle, so cashiers couldn't see the add
          // affordance. fa-plus/fa-minus are unambiguous and sized via CSS.
          '<button class="qty-btn" ' + (qty <= 0 ? 'disabled' : '') + ' onclick="decFromCart(\'' + i.id + '\')" aria-label="' + t('decrease') + '"><i class="fas fa-minus"></i></button>' +
          '<div class="qty-display">' + qty + '</div>' +
          '<button class="qty-btn add" onclick=\'addToCart(' + safeJson + ')\' aria-label="' + t('add') + '"><i class="fas fa-plus"></i></button>' +
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

// v5.10.27 — Surface which price list is driving prices for the
// currently active channel. The cashier sees a small chip above the
// categories grid: "أسعار من قائمة: X". When no list is bound, the
// chip is hidden so the legacy menu-price flow stays visually clean.
function _posRenderPriceListBadge() {
  var host = q('#posPriceListBadge');
  if (!host) {
    var anchor = q('#posCatGrid');
    if (!anchor || !anchor.parentNode) return;
    host = document.createElement('div');
    host.id = 'posPriceListBadge';
    host.style.cssText = 'margin:8px 12px;';
    anchor.parentNode.insertBefore(host, anchor);
  }
  var ch = state.activeChannel;
  var pl = ch && ch._priceListBadge;
  if (!pl || !pl.name) { host.style.display = 'none'; host.innerHTML = ''; return; }
  host.style.display = '';
  host.innerHTML =
    '<div style="display:inline-flex;align-items:center;gap:8px;background:linear-gradient(135deg,#faf5ff,#f3e8ff);' +
                'border:1.5px solid #d8b4fe;border-radius:999px;padding:5px 14px;font-size:11.5px;font-weight:800;' +
                'color:#6d28d9;box-shadow:0 1px 3px rgba(124,58,237,0.08);">' +
      '<i class="fas fa-tag" style="font-size:10px;"></i>' +
      '<span>أسعار من قائمة:</span>' +
      '<span style="background:#fff;padding:1px 8px;border-radius:6px;color:#7c3aed;">' +
        (typeof _v3EscapeHtml === 'function' ? _v3EscapeHtml(pl.name) : (pl.name || '')) +
      '</span>' +
    '</div>';
}

// v5.10.29 — Empty-state overlay for a strict-mode channel with zero
// configured items. Replaces the silent auto-fallback to MAIN that
// caused the owner's "channels aren't independent" frustration. Shows
// explicit action buttons so the next step is one click away:
//   1. "Copy from MAIN"          → POST /channel-menus/:id/copy-from/<MAIN>
//   2. "Open admin channel page" → routes to the channel manager screen
function _posRenderChannelEmptyState(ch, errMsg) {
  var grid = q('#posCatGrid');
  if (!grid || !grid.parentNode) return;
  var host = q('#posChannelEmpty');
  if (!host) {
    host = document.createElement('div');
    host.id = 'posChannelEmpty';
    host.style.cssText = 'margin:14px;padding:0;';
    grid.parentNode.insertBefore(host, grid);
  }
  var name = (ch && ch.name) || '—';
  // v5.10.31 — Hide the admin-action banner from cashier-role users.
  // The cashier just needs to know the channel isn't ready — the
  // "Copy from main menu" / "Open channels admin" buttons leak
  // architectural detail and admin functionality. For admins/managers,
  // the original banner with action buttons stays.
  if (typeof isAdmin === 'function' && !isAdmin()) {
    host.innerHTML =
      '<div style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:12px;padding:14px 18px;text-align:center;color:#64748b;font-size:12.5px;">' +
        '<i class="fas fa-info-circle" style="color:#94a3b8;margin-inline-end:6px;"></i>' +
        'هذه القَناة غَير مُعَدَّة لِلبَيع بَعد. تَواصَل مَع الإدارة لِتَكوينها.' +
      '</div>';
    host.style.display = '';
    return;
  }
  var safeId = String((ch && ch.id) || '').replace(/'/g, "\\'");
  var safeName = String(name).replace(/'/g, "\\'");
  var errLine = errMsg
    ? ('<div style="color:#b91c1c;font-size:11.5px;margin-top:8px;"><i class="fas fa-circle-exclamation"></i> ' + String(errMsg) + '</div>')
    : '';
  host.innerHTML =
    '<div style="background:linear-gradient(135deg,#fef9c3,#fef3c7);border:1.5px solid #fcd34d;border-radius:14px;padding:18px 22px;display:flex;align-items:center;gap:16px;flex-wrap:wrap;">' +
      '<div style="width:48px;height:48px;border-radius:12px;background:#f59e0b;color:#fff;display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0;">' +
        '<i class="fas fa-store-slash"></i>' +
      '</div>' +
      '<div style="flex:1;min-width:240px;">' +
        '<div style="font-size:14px;font-weight:900;color:#7c2d12;">قَناة "' + name + '" مُستَقِلَّة ولَيس بِها أصناف بَعد</div>' +
        '<div style="font-size:12px;color:#9a3412;margin-top:4px;line-height:1.7;">' +
          'هذه القَناة في وَضع "منيو مُستَقِل" — لِكَي يَظهَر شَيء لِلكاشير، أَضِف أصناف لَها أَو انسَخها من المنيو الرَئيسي.' +
        '</div>' +
        errLine +
      '</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
        '<button onclick="_posCopyFromMain(\'' + safeId + '\',\'' + safeName + '\')" ' +
                'style="background:#3b82f6;color:#fff;border:0;padding:10px 16px;border-radius:10px;font-weight:800;font-size:12.5px;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:6px;">' +
          '<i class="fas fa-copy"></i> انسَخ من المنيو الرَئيسي' +
        '</button>' +
        '<button onclick="window.location.href=\'/?openAdmin=channels\'" ' +
                'style="background:#fff;color:#7c2d12;border:1.5px solid #fcd34d;padding:10px 16px;border-radius:10px;font-weight:800;font-size:12.5px;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:6px;">' +
          '<i class="fas fa-gear"></i> فَتح إدارة القَنوات' +
        '</button>' +
      '</div>' +
    '</div>';
  host.style.display = '';
}

function _posClearChannelEmptyState() {
  var host = q('#posChannelEmpty');
  if (host) { host.style.display = 'none'; host.innerHTML = ''; }
}

window._posCopyFromMain = function(channelId, channelName) {
  if (!confirm('انسَخ كل أصناف المنيو الرَئيسي (MAIN) إلى "' + channelName + '"؟ يُمكِنك تَعديلها بَعد ذَلِك.')) return;
  // Find MAIN channel id from state.channels
  var main = (state.channels || []).find(function(c) {
    var co = String(c.code || '').toUpperCase();
    var ct = String(c.channelType || c.channel_type || '').toLowerCase();
    return co === 'MAIN' || ct === 'main';
  });
  if (!main) { if (typeof glassToast === 'function') glassToast('لَم يَتم العُثور عَلى قَناة MAIN', true); return; }
  _posCallAPI('POST', '/channel-menus/' + encodeURIComponent(channelId) + '/copy-from/' + encodeURIComponent(main.id), {}, function(r) {
    if (r && r.copied) {
      if (typeof glassToast === 'function') glassToast('تَم نَسخ ' + r.copied + ' صَنف. يَتم تَحديث المنيو الآن...', false);
      // Re-trigger channel switch to reload the items
      _posClearChannelEmptyState();
      if (state.activeChannel) _doSetChannel(state.activeChannel);
    } else {
      if (typeof glassToast === 'function') glassToast('فَشَل النَسخ: ' + ((r && r.error) || 'خَطأ غَير مَعروف'), true);
    }
  });
};

window.renderCategoryGrid = function () {
  var grid = q('#posCatGrid');
  if (!grid) return;
  // v5.10.27 — refresh the price-list chip whenever categories re-render
  // (channel switch, prefetch return, etc.).
  try { _posRenderPriceListBadge(); } catch(_) {}
  // v5.10.29 — clear empty-state when we have items to render (the
  // post-fix race condition: empty-state was rendered before items
  // arrived; once they're here, the banner has to go).
  if (state.channelMenuItems && state.channelMenuItems.length) {
    try { _posClearChannelEmptyState(); } catch(_) {}
  }
  // v5.15.1 — Build menuActive + categories from channelMenuItems DIRECTLY
  // when a non-MAIN channel is active. This mirrors renderMenuGrid and
  // bypasses state.menu's brand filter — the channel rows already carry
  // category, so the tiles match exactly what the grid will show after
  // clicking through.
  var menuActive;
  var cats;
  if (state.activeChannel && !state.activeChannel.useFullMenu) {
    // v5.15.3 — Same orphan-row defense as renderMenuGrid.
    menuActive = (state.channelMenuItems || [])
      .filter(function (r) { return r.isAvailable !== false && r.itemName && String(r.itemName).trim(); })
      .map(function (r) { return { id: r.menuItemId, name: r.itemName, category: r.category || '', active: true }; });
    if (state._channelCustomItems && state._channelCustomItems.length) {
      menuActive = menuActive.concat(state._channelCustomItems);
    }
    var seen = {};
    cats = [];
    menuActive.forEach(function (m) {
      var c = (m.category || '').trim();
      if (c && !seen[c]) { seen[c] = 1; cats.push(c); }
    });
  } else {
    menuActive = (state.menu || []).filter(function (m) { return m.active; });
    cats = (state.categories || []).filter(function (c) { return c && String(c).trim(); });
  }
  // v5.16.4 — Show a diagnostic panel here when menuActive resolves to
  // empty. v5.10.33 — gated by role: cashier gets a clean neutral
  // message; admin gets the helpful narrative + action; only developer
  // mode reveals the technical chip (channel=… menu=… chItems=…).
  if (!cats.length || menuActive.length === 0) {
    var _dIsAdmin = (typeof isAdmin === 'function') ? isAdmin() : false;
    var _dIsDev   = !!(state && state.isDeveloper) || (localStorage.getItem('pos_is_developer') === '1');

    if (!_dIsAdmin) {
      // Cashier path: clean message, no actions, no technical detail.
      grid.innerHTML =
        '<div class="pos-empty" style="padding:40px 20px;text-align:center;">' +
          '<i class="fas fa-store-slash" style="font-size:64px;display:block;margin-bottom:16px;opacity:0.5;color:#cbd5e1;"></i>' +
          '<div style="font-weight:700;font-size:15px;color:#64748b;">لا توجد أصناف معروضة. تَواصَل مَع الإدارة لِتَكوين الشاشة.</div>' +
        '</div>';
      return;
    }

    var dch = state.activeChannel || {};
    var dchName = dch.name || dch.code || '—';
    var dchCode = String(dch.code || '').toUpperCase();
    var dIsMain = (dchCode === 'MAIN') || (state.activeChannel && state.activeChannel.useFullMenu);
    var dMenuCount = (state.menu || []).length;
    var dChItemsCount = (state.channelMenuItems || []).length;
    var dBrandId = state.brandId || '';
    var dReason, dAction;
    if (dMenuCount === 0) {
      dReason = 'المنيو الرَئيسي فارِغ — لا أصناف مُحَمَّلة لِلبراند.';
      dAction = '<button onclick="posRefreshAll()" style="padding:12px 24px;background:linear-gradient(135deg,#7c3aed,#6d28d9);color:#fff;border:0;border-radius:10px;font-weight:800;cursor:pointer;font-size:14px;"><i class="fas fa-rotate"></i> تَحديث وإعادة المُحاوَلة</button>';
    } else if (state.activeChannel && !dIsMain && dChItemsCount === 0) {
      // v5.10.33 — cleaner copy (was a half-finished sentence with "...").
      dReason = 'القَناة "<b>' + dchName + '</b>" لم تُعَدّ بِأصناف بَعد.';
      dAction = '<button onclick="posJumpToMain()" style="padding:12px 24px;background:#1e293b;color:#fff;border:0;border-radius:10px;font-weight:800;cursor:pointer;font-size:14px;"><i class="fas fa-home"></i> الرُجوع إلى MAIN</button>';
    } else {
      dReason = 'كل الفِئات فارِغة. حاوِل التَحديث.';
      dAction = '<button onclick="posRefreshAll()" style="padding:12px 24px;background:linear-gradient(135deg,#7c3aed,#6d28d9);color:#fff;border:0;border-radius:10px;font-weight:800;cursor:pointer;font-size:14px;"><i class="fas fa-rotate"></i> تَحديث</button>';
    }
    var dDebugChip = _dIsDev
      ? ('<div style="margin-top:18px;padding:8px 14px;background:#f1f5f9;border-radius:6px;font-size:11px;color:#475569;font-family:ui-monospace,SFMono-Regular,monospace;text-align:left;direction:ltr;display:inline-block;">' +
          'channel=' + (dchCode || '—') + ' · useFullMenu=' + (dIsMain ? 'true' : 'false') +
          ' · menu=' + dMenuCount +
          ' · chItems=' + dChItemsCount +
          ' · brand=' + (dBrandId || '—') +
        '</div>')
      : '';
    grid.innerHTML =
      '<div class="pos-empty" style="padding:40px 20px;text-align:center;">' +
        '<i class="fas fa-store-slash" style="font-size:64px;display:block;margin-bottom:16px;opacity:0.5;color:#7c3aed;"></i>' +
        '<div style="font-weight:900;font-size:20px;color:#0f172a;margin-bottom:8px;">المنيو غير ظاهِر</div>' +
        '<div style="font-size:14px;color:#475569;max-width:480px;line-height:1.8;margin:0 auto 18px;">' + dReason + '</div>' +
        '<div>' + dAction + '</div>' +
        dDebugChip +
      '</div>';
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

// ─── v6.4.3 — Payment tiles now respect the owner's configured methods ───
// History: v5.11.4 hardcoded 3 tiles (Cash / Mada / Other) per a one-time
// owner request. The owner has since defined custom methods in
// ERP → الإعدادات → طُرق الدفع (e.g. HungerStation, Kita, vouchers) and
// rightfully expects them to appear at the till. So we now:
//   1. Render whatever the owner configured (state.paymentMethods, loaded
//      from /api/settings/payment-methods-full at app boot).
//   2. Fall back to the FOODICS_PAY_METHODS defaults ONLY when no methods
//      have been configured yet (fresh deployment).
//   3. Always append the Split tile so cashiers can split any tender.
//   4. Keep the "Other → notes" behaviour for the literal "Other" method
//      (any future method that needs notes can be tagged on the backend).
var FOODICS_PAY_METHODS = [
  { name: 'Cash',  ar: 'كاش',  en: 'Cash',  icon: 'fa-money-bill-wave' },
  { name: 'Mada',  ar: 'مدى',  en: 'Mada',  icon: 'fa-credit-card' },
  { name: 'Other', ar: 'أخرى', en: 'Other', icon: 'fa-ellipsis-h' }
];

// Best-effort icon resolver — falls back to a generic credit-card glyph
function _foodicsPayIcon(m) {
  if (m && m.Icon)  return m.Icon;
  if (m && m.icon)  return m.icon;
  var n = String((m && (m.Name || m.name)) || '').toLowerCase();
  if (n === 'cash' || n.indexOf('كاش') >= 0 || n.indexOf('نقد') >= 0)        return 'fa-money-bill-wave';
  if (n === 'mada' || n.indexOf('مدى') >= 0 || n.indexOf('شبكة') >= 0)        return 'fa-credit-card';
  if (n.indexOf('hunger') >= 0)                                              return 'fa-burger';
  if (n === 'kita' || n.indexOf('كيتا') >= 0)                                return 'fa-utensils';
  if (n.indexOf('voucher') >= 0 || n.indexOf('قسيمة') >= 0)                  return 'fa-ticket';
  if (n.indexOf('transfer') >= 0 || n.indexOf('تحويل') >= 0)                 return 'fa-arrow-right-arrow-left';
  if (n === 'other' || n.indexOf('أخرى') >= 0 || n.indexOf('اخرى') >= 0)     return 'fa-ellipsis-h';
  return 'fa-credit-card';
}

// Returns the list of tiles to render. Uses configured methods when
// present, falls back to the 3 defaults otherwise. Output shape:
//   [{ name, ar, en, icon }, ...]
function _foodicsActiveMethods() {
  var pm = state.paymentMethods || [];
  // Filter active methods. The backend exposes IsActive (true/false) or
  // is_active (1/0); handle both. Also drop literal "Split" if a method
  // with that name slipped in — we render Split as a separate tile.
  var active = pm.filter(function (m) {
    if (!m) return false;
    var on = (m.IsActive !== false && m.IsActive !== 0 && m.IsActive !== 'FALSE' &&
              m.is_active !== false && m.is_active !== 0);
    var name = String(m.Name || m.name || '').trim();
    return on && name && name.toLowerCase() !== 'split';
  });
  if (active.length) {
    return active.map(function (m) {
      var name = String(m.Name || m.name || '').trim();
      var ar   = String(m.NameAR || m.name_ar || name).trim();
      return {
        name: name,
        ar:   ar,
        en:   name,            // The DB Name is already EN — show it next to AR
        icon: _foodicsPayIcon(m)
      };
    });
  }
  // Fresh deployment — no methods configured yet
  return FOODICS_PAY_METHODS.slice();
}

window.renderFoodicsPayTiles = function () {
  var host = q('#payTilesGrid');
  if (!host) return;
  var current = q('#posPayMethod') ? q('#posPayMethod').value : 'Cash';
  var tiles = _foodicsActiveMethods();
  var html = tiles.map(function (m) {
    var on = m.name === current ? ' is-active' : '';
    var label = (m.ar && m.en && m.ar !== m.en) ? (m.ar + ' · ' + m.en) : (m.ar || m.en);
    return '<button type="button" class="pay-tile' + on + '" onclick="setFoodicsPay(\'' + String(m.name).replace(/'/g, "\\'") + '\')">' +
             '<i class="fas ' + m.icon + '"></i>' +
             '<span>' + label + '</span>' +
           '</button>';
  }).join('');
  html += '<button type="button" class="pay-tile pay-tile-split' +
          (current === 'Split' ? ' is-active' : '') +
          '" onclick="setFoodicsPay(\'Split\')">' +
            '<i class="fas fa-divide"></i>' +
            '<span>تَجزئة · Split</span>' +
          '</button>';
  host.innerHTML = html;
};

window.setFoodicsPay = function (name) {
  // Drives the existing hidden #posPayMethod field used by doCheckout.
  if (typeof setPayMethod === 'function') setPayMethod(name);
  renderFoodicsPayTiles();
  var panel = q('#paySplitFoodics');
  if (panel) panel.classList.toggle('hidden', name !== 'Split');
  if (name === 'Split') renderFoodicsSplitFields();
  _payNotesUpdate();
};

window.renderFoodicsSplitFields = function () {
  var host = q('#paySplitFields');
  if (!host) return;
  // v6.4.3 — split inputs mirror the dynamic method list as the tiles.
  //   Inputs carry class "split-input" so legacy doCheckout extraction
  //   still works.
  // v6.5.1 — Owner spec: "ازل كيتا وهانجر ستيشن من تجزئة واجعل مكانهم
  //   OTHER فقط". Split is the partial-payment scenario (e.g. ‏SR 50
  //   cash + ‏SR 30 mada + the rest "other"). Pay-by-app channels like
  //   Kita and HungerStation deliver the FULL invoice through their
  //   own gateway — they don't make sense as a split portion. We cap
  //   the split inputs to the 3 essentials: Cash, Mada, Other.
  var SPLIT_ALLOWED_RE = /^(cash|mada|card|other)$/i;
  var tiles = _foodicsActiveMethods().filter(function (m) {
    var n = String(m.name || '').toLowerCase();
    if (SPLIT_ALLOWED_RE.test(n)) return true;
    return n.indexOf('cash') >= 0 || n.indexOf('mada') >= 0 ||
           n.indexOf('card') >= 0 || n.indexOf('other') >= 0;
  });
  // Defensive: guarantee Cash / Mada / Other are always present even
  // if the operator only configured exotic methods.
  var present = tiles.map(function (t) { return String(t.name || '').toLowerCase(); });
  ['Cash', 'Mada', 'Other'].forEach(function (n) {
    if (present.indexOf(n.toLowerCase()) === -1) {
      tiles.push({
        name: n,
        ar:  ({ Cash: 'كاش', Mada: 'مدى', Other: 'أخرى' })[n],
        en:  n,
        icon: _foodicsPayIcon({ name: n })
      });
      present.push(n.toLowerCase());
    }
  });
  host.innerHTML = tiles.map(function (m) {
    var label = (m.ar && m.en && m.ar !== m.en) ? (m.ar + ' · ' + m.en) : (m.ar || m.en);
    var safeName = String(m.name).replace(/'/g, "\\'");
    return (
      '<div class="pay-split-row">' +
        '<div class="pay-split-method"><i class="fas ' + m.icon + '"></i> ' + label + '</div>' +
        '<input type="number" data-vk="1" step="0.01" min="0" class="form-control pay-split-input split-input" ' +
               'data-method="' + safeName + '" value="" placeholder="0.00" oninput="paySplitRecalc()">' +
        '<button type="button" class="pay-split-rest" onclick="paySplitFillRest(\'' + safeName + '\')" title="املأ بالمتبقي · Fill remaining"><i class="fas fa-equals"></i></button>' +
      '</div>'
    );
  }).join('');
  paySplitRecalc();
};

// v5.11.4 — Show/hide the notes block based on either:
//   • the current method = Other (full payment), or
//   • the Other input in Split mode has a non-zero value.
// Also keeps the character counter live.
window._payNotesUpdate = function () {
  var block = q('#payNotesBlock');
  if (!block) return;
  var current = q('#posPayMethod') ? q('#posPayMethod').value : 'Cash';
  var needs = (current === 'Other');
  if (!needs && current === 'Split') {
    qs('.pay-split-input').forEach(function (el) {
      if (el.dataset.method === 'Other' && Number(el.value) > 0) needs = true;
    });
  }
  block.classList.toggle('hidden', !needs);
  var ta  = q('#payNotesInput');
  var len = q('#payNotesLen');
  if (ta && len) len.textContent = String((ta.value || '').length);
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
  // v5.11.4 — re-evaluate the notes block (Other-row value may have changed)
  if (typeof _payNotesUpdate === 'function') _payNotesUpdate();
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

// ═══════════════════════════════════════════════════════════════════
// v6.15.0 — Customer module (modal-driven, always-visible buttons)
// ═══════════════════════════════════════════════════════════════════
// Replaces the v5.11.4/v6.13.0 collapsible inline panel which the owner
// rejected: "I can't add a customer and recall an existing one — you
// keep wasting my time, nothing actually changes."
//
// The earlier panel was hidden by default (only opened on first cart-
// add), had no explicit "Add new" button (creation was implicit via the
// dropdown), and saved nothing until checkout — so the cashier never
// saw a confirmation until it was too late.
//
// New design:
//   • Two always-visible action buttons above the cart:
//       🔍 بحث عميل   → posOpenCustomerSearchModal()
//       ➕ عميل جديد  → posOpenCustomerAddModal()
//   • Each opens a self-contained DOM modal (z-index 10010) using the
//     same scaffold as _myInvConfirm in v6.14.0 — no popup-blocker
//     dependency, Esc / outside-click / Enter wired manually.
//   • Search modal: debounced GET /api/erp/customers/search, results
//     rendered as a list, click = link.
//   • Add modal: full 9-field form, POST /api/erp/customers, on success
//     auto-link to current sale.  Duplicate-phone errors surface an
//     inline "use existing" shortcut that switches to search pre-filled.
//   • state.posCustomer shape is unchanged so doCheckout() keeps working.
//
state.posCustomer = state.posCustomer || { id:null, name:'', phone:'', gender:'unknown' };

// ─── HTML escape helper (used by every modal body builder) ─────────────
function _posEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Render the status bar (called on every customer state change) ────
window._posCustomerRenderStatusBar = function () {
  var bar    = q('#posCustomerStatus');
  var iconEl = q('#posCustomerStatusIcon');
  var label  = q('#posCustomerStatusLabel');
  var unlink = q('#posCustomerUnlink');
  if (!bar || !label) return;
  var s = state.posCustomer || {};
  if (s.id && (s.name || s.phone)) {
    bar.classList.remove('is-empty');
    bar.classList.add('is-linked');
    if (iconEl) iconEl.className = 'fas fa-user-check';
    var display = _posEsc(s.name || s.phone);
    if (s.phone && s.name) display += '  ·  <span style="font-family:ui-monospace,monospace;font-weight:700;opacity:.8;">' + _posEsc(s.phone) + '</span>';
    label.innerHTML = display;
    if (unlink) unlink.hidden = false;
  } else {
    bar.classList.remove('is-linked');
    bar.classList.add('is-empty');
    if (iconEl) iconEl.className = 'fas fa-user-slash';
    label.textContent = 'لا يوجد عميل · No customer';
    if (unlink) unlink.hidden = true;
  }
};

// ─── Unified setter: writes state + repaints bar + emits toast ────────
// v6.16.0 — Also auto-fetches the customer's purchase summary so the
// totals strip + history modal are ready instantly.
window._posCustomerSelect = function (c, opts) {
  c = c || {};
  state.posCustomer = {
    id:     c.id     || null,
    name:   c.name   || '',
    phone:  c.phone  || '',
    gender: c.gender || 'unknown'
  };
  state._posCustLastError = null;
  _posCustomerRenderStatusBar();
  // v6.16.0 — Kick off the summary fetch (totals strip + history cache).
  // Non-blocking — UI is already updated.
  if (state.posCustomer.id) {
    try { _posCustomerLoadSummary(state.posCustomer.id); } catch (_) {}
  }
  if (opts && opts.silent) return;
  var msg = (opts && opts.message) || '✓ تم ربط العميل بالفاتورة · Customer linked';
  if (typeof glassToast === 'function') glassToast(msg, false);
};

// ─── Clear (used by checkout-success + the X button on the status bar) ─
// v6.16.0 — Also hides the totals strip and clears the summary cache.
window.posCustomerClear = function () {
  state.posCustomer = { id:null, name:'', phone:'', gender:'unknown' };
  state._posCustLastError = null;
  state._posCustomerSummary = null;
  _posCustomerRenderStatusBar();
  var totals = q('#posCustomerTotals');
  if (totals) totals.hidden = true;
};

// ─── Backward-compat shims (other callers in the codebase may invoke these) ─
window._posCustomerUpdateStatus    = function () { _posCustomerRenderStatusBar(); };
window._posCustomerRenderChip      = function () { _posCustomerRenderStatusBar(); };
window._posCustomerEnsurePanelOpen = function () { /* no-op in v6.15.0 — bar is always visible */ };
window.posToggleCustomerPanel      = function () { /* no-op — buttons replaced toggle */ };

// ════════════════════════════════════════════════════════════════════
// v6.16.0 — Customer summary (totals strip + history modal)
// ════════════════════════════════════════════════════════════════════
// _posCustomerLoadSummary(id) is called from _posCustomerSelect (above)
// whenever a customer is linked.  It populates two things:
//   1. The always-visible totals strip in the customer bar (a compact
//      one-liner with total spent, order count, and last-visit date).
//   2. state._posCustomerSummary cache, used by the history modal so
//      opening it is instant (no second roundtrip).
//
// posOpenCustomerHistoryModal() reads the cache and renders a large
// modal with 4 KPI cards + the last 50 invoices in a table.  Status
// badges reflect zatca_type: standard/simplified are normal, voided
// invoices get a red "ملغاة" badge with a strike-through total, and
// credit_notes get a purple "مرتجع" badge.
//
// Endpoint: GET /api/erp/customers/:id/summary
// (See routes/erp/customers.js for the SQL.)
// ════════════════════════════════════════════════════════════════════

// Format an ISO datetime as "yyyy-mm-dd HH:mm" (Saudi style, no tz noise).
function _posFormatDate(iso) {
  if (!iso) return '—';
  try {
    var d = (iso instanceof Date) ? iso : new Date(iso);
    if (isNaN(d.getTime())) return '—';
    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
           ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  } catch (_) { return '—'; }
}
function _posFormatDateOnly(iso) {
  if (!iso) return '—';
  try {
    var d = (iso instanceof Date) ? iso : new Date(iso);
    if (isNaN(d.getTime())) return '—';
    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  } catch (_) { return '—'; }
}

// Format an amount as SAR with thousand separators.
function _posFormatSAR(n) {
  var v = Number(n) || 0;
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Load summary from backend + paint the totals strip.
window._posCustomerLoadSummary = function (id) {
  var totals = q('#posCustomerTotals');
  var txt    = q('#posCustomerTotalsText');
  if (!totals) return;
  if (!id) { totals.hidden = true; return; }
  totals.hidden = false;
  if (txt) txt.innerHTML = '<i class="fas fa-spinner fa-spin"></i> جارٍ التحميل...';

  console.log('[POS customer summary] fetching for', id);
  api.withSuccessHandler(function (res) {
    console.log('[POS customer summary] response:', res);
    if (res == null) {
      if (txt) txt.innerHTML = '<i class="fas fa-triangle-exclamation"></i> getCustomerSummary غير مُسجَّل — حدّث الصفحة';
      return;
    }
    if (!res || !res.success) {
      if (txt) txt.innerHTML = '<i class="fas fa-triangle-exclamation"></i> ' + _posEsc((res && res.error) || 'فشل تحميل السجل');
      return;
    }
    state._posCustomerSummary = res;
    var kpi = res.kpi || {};
    var parts = [
      '<strong>' + _posFormatSAR(kpi.totalSpent) + '</strong> ر.س',
      '<span>' + (Number(kpi.orderCount) || 0) + ' فاتورة</span>'
    ];
    if (kpi.lastVisit) {
      parts.push('<span>آخر زيارة: ' + _posFormatDateOnly(kpi.lastVisit) + '</span>');
    }
    if (txt) txt.innerHTML = parts.join(' · ');
  }).withFailureHandler(function (err) {
    console.error('[POS customer summary] failed:', err);
    if (txt) txt.innerHTML = '<i class="fas fa-triangle-exclamation"></i> تعذّر الاتصال';
  }).getCustomerSummary(id);
};

// Helper — KPI card HTML
function _posKpiCard(label, value, unit, icon, kind) {
  return (
    '<div class="pos-cust-hist-kpi-card ' + (kind || '') + '">' +
      '<i class="fas ' + (icon || 'fa-circle') + '" style="font-size:18px;color:#7c3aed;"></i>' +
      '<div class="pos-cust-hist-kpi-value">' + _posEsc(value) + '</div>' +
      (unit ? '<div class="pos-cust-hist-kpi-unit">' + _posEsc(unit) + '</div>' : '') +
      '<div class="pos-cust-hist-kpi-label">' + _posEsc(label) + '</div>' +
    '</div>'
  );
}

// Open the history modal.  Requires state._posCustomerSummary to be
// populated (it normally is, because _posCustomerSelect kicks the
// fetch).  If the cache is empty we trigger a fresh fetch + retry.
window.posOpenCustomerHistoryModal = function () {
  var s = state._posCustomerSummary;
  if (!s || !s.customer) {
    // Not loaded yet — start fetch and retry once loaded.
    var id = state.posCustomer && state.posCustomer.id;
    if (!id) {
      if (typeof glassToast === 'function') glassToast('لا يوجد عميل مختار', true);
      return;
    }
    if (typeof glassToast === 'function') glassToast('جارٍ تحميل السجل...', false);
    return _posCustomerLoadSummary(id), setTimeout(function () {
      if (state._posCustomerSummary) posOpenCustomerHistoryModal();
    }, 400);
  }

  var kpi = s.kpi || {};
  var rows = s.recentInvoices || [];
  var cust = s.customer || {};

  // KPI strip
  var kpiHtml =
    '<div class="pos-cust-hist-kpi">' +
      _posKpiCard('إجمالي المشتريات', _posFormatSAR(kpi.totalSpent), 'ر.س', 'fa-coins', 'is-primary') +
      _posKpiCard('عدد الفواتير', (Number(kpi.orderCount) || 0), 'فاتورة', 'fa-receipt', 'is-info') +
      _posKpiCard('متوسط الفاتورة', _posFormatSAR(kpi.avgInvoice), 'ر.س', 'fa-calculator', 'is-success') +
      _posKpiCard('آخر زيارة', kpi.lastVisit ? _posFormatDateOnly(kpi.lastVisit) : '—', '', 'fa-calendar', 'is-warn') +
    '</div>';

  // Customer meta (small line under KPIs)
  var metaParts = [];
  if (cust.phone) metaParts.push('<i class="fas fa-phone"></i> ' + _posEsc(cust.phone));
  if (kpi.firstVisit) metaParts.push('<i class="fas fa-user-clock"></i> أول زيارة: ' + _posFormatDateOnly(kpi.firstVisit));
  if (cust.customerType) metaParts.push('<i class="fas fa-tag"></i> ' + _posEsc(cust.customerType));
  var metaHtml = metaParts.length
    ? '<div class="pos-cust-hist-meta">' + metaParts.join('  ·  ') + '</div>'
    : '';

  // Invoices table
  var tableHtml;
  if (!rows.length) {
    tableHtml =
      '<div class="pos-cust-modal-hint">' +
        '<i class="fas fa-receipt"></i>' +
        'لا توجد فواتير سابقة لهذا العميل — أكمل بيعاً الآن لتسجيل أول فاتورة.' +
      '</div>';
  } else {
    var tbodyRows = rows.map(function (r) {
      var rowCls = '';
      var statusBadge = '';
      if (r.zatcaType === 'cancellation') {
        rowCls = 'is-voided';
        statusBadge = '<span class="pos-cust-hist-badge red">ملغاة</span>';
      } else if (r.zatcaType === 'credit_note') {
        rowCls = 'is-refund';
        statusBadge = '<span class="pos-cust-hist-badge purple">مرتجع</span>';
      } else if (r.zatcaType === 'debit_note') {
        statusBadge = '<span class="pos-cust-hist-badge purple">تعديل</span>';
      } else if (r.hasCreditNote) {
        statusBadge = '<span class="pos-cust-hist-badge purple">مرتجع جزئياً</span>';
      } else {
        statusBadge = '<span class="pos-cust-hist-badge green">مكتملة</span>';
      }
      var invNum = r.invoiceNumber || r.id;
      var extraSerial = '';
      if (r.voidSerial)   extraSerial = '<br><small style="color:#b91c1c;font-family:ui-monospace,monospace;">' + _posEsc(r.voidSerial) + '</small>';
      if (r.returnSerial) extraSerial = '<br><small style="color:#6d28d9;font-family:ui-monospace,monospace;">' + _posEsc(r.returnSerial) + '</small>';
      var totalDisplay = (r.zatcaType === 'credit_note' ? '−' : '') + _posFormatSAR(r.total) + ' ر.س';
      return (
        '<tr class="pos-cust-hist-row ' + rowCls + '">' +
          '<td>' + _posFormatDate(r.date) + '</td>' +
          '<td style="font-family:ui-monospace,monospace;font-size:11.5px;">' + _posEsc(invNum) + extraSerial + '</td>' +
          '<td class="total-cell" style="text-align:end;font-weight:800;">' + totalDisplay + '</td>' +
          '<td>' + _posEsc(r.payment || '—') + '</td>' +
          '<td>' + statusBadge + '</td>' +
        '</tr>'
      );
    }).join('');
    tableHtml =
      '<table class="pos-cust-hist-table">' +
        '<thead><tr>' +
          '<th>التاريخ</th>' +
          '<th>رقم الفاتورة</th>' +
          '<th style="text-align:end;">الإجمالي</th>' +
          '<th>الدفع</th>' +
          '<th>الحالة</th>' +
        '</tr></thead>' +
        '<tbody>' + tbodyRows + '</tbody>' +
      '</table>';
    if (rows.length >= 50) {
      tableHtml += '<div class="pos-cust-hist-note">يُعرض آخر 50 فاتورة. للسجل الكامل راجع لوحة الأدمن.</div>';
    }
  }

  var bodyHtml = kpiHtml + metaHtml + tableHtml;
  var footHtml =
    '<button type="button" class="pos-cust-modal-btn-cancel" data-pos-cust-close="1">' +
      '<i class="fas fa-times"></i> إغلاق' +
    '</button>';

  _posBuildCustomerModal({
    id:    'posCustomerHistoryModal',
    title: 'سجل العميل · ' + (cust.name || ''),
    icon:  'fa-clock-rotate-left',
    large: true,
    bodyHtml: bodyHtml,
    footHtml: footHtml
  });
};

// ─── Generic DOM modal scaffolder for both search + add modals ────────
// Returns the wrap element with .close() attached so callers can dismiss
// programmatically (e.g. after a successful save).
function _posBuildCustomerModal(opts) {
  // opts: { id, title, icon, large, bodyHtml, footHtml, onKey }
  var prev = document.getElementById(opts.id);
  if (prev) prev.remove();

  var wrap = document.createElement('div');
  wrap.id = opts.id;
  wrap.className = 'pos-cust-modal';
  wrap.setAttribute('role', 'dialog');
  wrap.setAttribute('aria-modal', 'true');

  var cardCls = 'pos-cust-modal-card' + (opts.large ? ' pos-cust-modal-card-lg' : '');
  wrap.innerHTML =
    '<div class="' + cardCls + '" role="document">' +
      '<div class="pos-cust-modal-head">' +
        '<h3><i class="fas ' + _posEsc(opts.icon || 'fa-user') + '"></i> ' + _posEsc(opts.title || '') + '</h3>' +
        '<button type="button" class="pos-cust-modal-close" data-pos-cust-close="1" aria-label="إغلاق">&times;</button>' +
      '</div>' +
      '<div class="pos-cust-modal-body">' + (opts.bodyHtml || '') + '</div>' +
      '<div class="pos-cust-modal-foot">' + (opts.footHtml || '') + '</div>' +
    '</div>';

  function close() {
    document.removeEventListener('keydown', onKey, true);
    if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    if (opts.onKey) opts.onKey(e, close);
  }

  wrap.addEventListener('click', function (e) {
    // X button OR cancel button (both carry data-pos-cust-close)
    if (e.target && e.target.closest && e.target.closest('[data-pos-cust-close]')) {
      e.stopPropagation();
      close();
      return;
    }
    // Outside-click on the dim backdrop
    if (e.target === wrap) close();
  });

  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(wrap);
  wrap.close = close;
  return wrap;
}

// ─── Render search results inside the search modal ────────────────────
function _posRenderCustSearchResults(rows, query) {
  var host = q('#posCustSearchResults');
  if (!host) return;
  if (!rows || !rows.length) {
    host.innerHTML =
      '<div class="pos-cust-modal-hint">' +
        '<i class="fas fa-user-slash"></i>' +
        'لا توجد نتائج لـ "<strong>' + _posEsc(query) + '</strong>"' +
        '<br><br>اضغط زر "إضافة جديد" بالأسفل لإنشاء عميل جديد بهذه البيانات.' +
      '</div>';
    return;
  }
  host.innerHTML = rows.map(function (c) {
    var icon = c.gender === 'female' ? 'fa-venus' : c.gender === 'male' ? 'fa-mars' : 'fa-user';
    var typeLabel = ({ B2C:'أفراد', B2B:'شركات', B2G:'حكومي' })[c.customerType] || 'أفراد';
    return (
      '<div class="pos-cust-result" data-id="' + _posEsc(c.id || '') + '" ' +
            'data-name="' + _posEsc(c.name || '') + '" ' +
            'data-phone="' + _posEsc(c.phone || '') + '" ' +
            'data-gender="' + _posEsc(c.gender || 'unknown') + '">' +
        '<div class="pos-cust-result-icon"><i class="fas ' + icon + '"></i></div>' +
        '<div class="pos-cust-result-body">' +
          '<span class="pos-cust-result-name">' + _posEsc(c.name || '—') + '</span>' +
          (c.phone ? '<span class="pos-cust-result-phone">' + _posEsc(c.phone) + '</span>' : '') +
        '</div>' +
        '<span class="pos-cust-result-type">' + typeLabel + '</span>' +
      '</div>'
    );
  }).join('');
}

// ─── Search modal ──────────────────────────────────────────────────────
// v6.15.1 — Opens with the 20 most-recent customers already loaded so
// the cashier can see "the customer I just added" without typing.
// Backend now supports empty-query → recent-list (routes/erp/customers.js).
window.posOpenCustomerSearchModal = function (initialQuery) {
  var bodyHtml =
    '<input type="text" id="posCustSearchInput" class="pos-cust-modal-input" ' +
           'placeholder="اكتب الاسم أو الهاتف للبحث (أو اترك فارغاً لرؤية آخر العملاء)..." ' +
           'data-vk="1" autocomplete="off" inputmode="text">' +
    '<div id="posCustSearchStatus" class="pos-cust-modal-status">' +
      '<i class="fas fa-spinner fa-spin"></i> جارٍ تحميل آخر العملاء...' +
    '</div>' +
    '<div id="posCustSearchResults" class="pos-cust-modal-results"></div>';
  var footHtml =
    '<button type="button" class="pos-cust-modal-btn-cancel" data-pos-cust-close="1">' +
      '<i class="fas fa-times"></i> إغلاق' +
    '</button>' +
    '<button type="button" class="pos-cust-modal-btn-refresh" id="posCustSearchRefreshBtn" title="تحديث القائمة">' +
      '<i class="fas fa-rotate"></i>' +
    '</button>' +
    '<button type="button" class="pos-cust-modal-btn-add" id="posCustSearchAddBtn">' +
      '<i class="fas fa-user-plus"></i> إضافة جديد' +
    '</button>';

  var lastResults = [];
  var lastQuery   = '';
  var debounceT   = null;

  var wrap = _posBuildCustomerModal({
    id:    'posCustomerSearchModal',
    title: 'بحث عن عميل · Search Customer',
    icon:  'fa-magnifying-glass',
    bodyHtml: bodyHtml,
    footHtml: footHtml,
    onKey: function (e, close) {
      // Enter on the input with exactly one result → auto-select
      if (e.key === 'Enter' && document.activeElement && document.activeElement.id === 'posCustSearchInput') {
        if (lastResults.length === 1) {
          e.stopPropagation();
          var c = lastResults[0];
          close();
          _posCustomerSelect(c);
        }
      }
    }
  });

  var input    = q('#posCustSearchInput');
  var addBtn   = q('#posCustSearchAddBtn');
  var refresh  = q('#posCustSearchRefreshBtn');

  function setStatus(html) {
    var el = q('#posCustSearchStatus');
    if (el) el.innerHTML = html || '';
  }

  function doSearch(opts) {
    clearTimeout(debounceT);
    var qstr = String(input ? input.value : '').trim();
    lastQuery = qstr;
    var isImmediate = opts && opts.immediate;
    var delay = isImmediate ? 0 : 250;

    setStatus('<i class="fas fa-spinner fa-spin"></i> جارٍ البحث...');

    debounceT = setTimeout(function () {
      console.log('[POS customer search] q=', qstr || '(empty → recent)');
      api.withSuccessHandler(function (rows) {
        // v6.15.2 — Paranoid null-check.  If api-bridge ever returns
        // null for this call (e.g. a future route gets unmapped) we
        // surface it as an explicit error instead of pretending "0
        // results" — which is what masked the v6.15.0 bug for so long.
        if (rows == null) {
          console.error('[POS customer search] api returned null — searchCustomers route is missing from api-bridge');
          lastResults = [];
          setStatus('<i class="fas fa-triangle-exclamation"></i> فشل: استدعاء البحث لم يصل للخادم. حدّث الصفحة (Ctrl+Shift+R) وإن استمر أبلغ المطور.');
          _posRenderCustSearchResults([], qstr);
          return;
        }
        lastResults = rows;
        console.log('[POS customer search] returned ' + lastResults.length + ' rows', lastResults);
        if (!qstr) {
          setStatus('<i class="fas fa-clock-rotate-left"></i> آخر ' + lastResults.length + ' عميل تمت إضافتهم — اكتب للبحث في الكل');
        } else if (!lastResults.length) {
          setStatus('<i class="fas fa-circle-info"></i> لا توجد نتائج لـ "' + _posEsc(qstr) + '" — اضغط "إضافة جديد" بالأسفل');
        } else {
          setStatus('<i class="fas fa-check"></i> ' + lastResults.length + ' نتيجة');
        }
        _posRenderCustSearchResults(lastResults, qstr);
      }).withFailureHandler(function (err) {
        console.error('[POS customer search] FAILED', err);
        lastResults = [];
        var em = (err && err.message) ? err.message : 'فشل الاتصال بالخادم';
        setStatus('<i class="fas fa-triangle-exclamation"></i> ' + _posEsc(em) + ' — حاول مجدداً');
        _posRenderCustSearchResults([], qstr);
      }).searchCustomers(qstr);
    }, delay);
  }

  if (input) {
    input.addEventListener('input', function () { doSearch(); });
    setTimeout(function () { input.focus(); }, 60);
    if (initialQuery) {
      input.value = String(initialQuery);
    }
  }
  // Always fire an initial search — empty query returns recent customers.
  doSearch({ immediate: true });

  // Click delegation on result rows
  var resultsHost = q('#posCustSearchResults');
  if (resultsHost) {
    resultsHost.addEventListener('click', function (e) {
      var row = e.target && e.target.closest && e.target.closest('.pos-cust-result');
      if (!row) return;
      var c = {
        id:     row.dataset.id || null,
        name:   row.dataset.name || '',
        phone:  row.dataset.phone || '',
        gender: row.dataset.gender || 'unknown'
      };
      console.log('[POS customer search] picked', c);
      wrap.close();
      _posCustomerSelect(c);
    });
  }

  // Manual refresh button — useful if the cashier just added a customer
  // in another tab/session and wants to see them.
  if (refresh) {
    refresh.addEventListener('click', function () { doSearch({ immediate: true }); });
  }

  // "Add new" button — close this modal and open the add modal pre-filled
  if (addBtn) {
    addBtn.addEventListener('click', function () {
      var prefill = {};
      var qstr = lastQuery || (input ? String(input.value || '').trim() : '');
      if (qstr) {
        if (/^[+\d]/.test(qstr)) prefill.phone = qstr;
        else                      prefill.name  = qstr;
      }
      wrap.close();
      posOpenCustomerAddModal(prefill);
    });
  }
};

// ─── Add modal ─────────────────────────────────────────────────────────
window.posOpenCustomerAddModal = function (prefill) {
  prefill = prefill || {};
  var bodyHtml =
    '<div class="pos-cust-form-grid">' +
      '<label>الاسم *<input id="posCustAddName" data-vk="1" autocomplete="off" required maxlength="200" value="' + _posEsc(prefill.name || '') + '"></label>' +
      '<label>الاسم بالإنجليزية<input id="posCustAddNameEn" data-vk="1" autocomplete="off" maxlength="200"></label>' +
      '<label>الهاتف *<input id="posCustAddPhone" type="tel" inputmode="tel" data-vk="1" autocomplete="off" required maxlength="20" value="' + _posEsc(prefill.phone || '') + '"></label>' +
      '<label>البريد الإلكتروني<input id="posCustAddEmail" type="email" data-vk="1" autocomplete="off" maxlength="100"></label>' +
      '<label class="full">العنوان<input id="posCustAddAddress" data-vk="1" autocomplete="off" maxlength="200"></label>' +
      '<label>المدينة<input id="posCustAddCity" data-vk="1" autocomplete="off" maxlength="100"></label>' +
      '<label>نوع العميل' +
        '<select id="posCustAddType">' +
          '<option value="B2C" selected>أفراد · B2C</option>' +
          '<option value="B2B">شركات · B2B</option>' +
          '<option value="B2G">حكومي · B2G</option>' +
        '</select>' +
      '</label>' +
      '<label>الجنس' +
        '<select id="posCustAddGender">' +
          '<option value="unknown" selected>غير محدد</option>' +
          '<option value="male">ذكر · Male</option>' +
          '<option value="female">أنثى · Female</option>' +
        '</select>' +
      '</label>' +
      '<label>حد الائتمان<input id="posCustAddCredit" type="number" min="0" step="0.01" value="0"></label>' +
    '</div>' +
    '<div id="posCustAddError" class="pos-cust-form-error" hidden></div>';

  var footHtml =
    '<button type="button" class="pos-cust-modal-btn-cancel" data-pos-cust-close="1">' +
      '<i class="fas fa-times"></i> إلغاء' +
    '</button>' +
    '<button type="button" class="pos-cust-modal-btn-save" id="posCustAddSaveBtn">' +
      '<i class="fas fa-floppy-disk"></i> حفظ وربط · Save & Link' +
    '</button>';

  var wrap = _posBuildCustomerModal({
    id:    'posCustomerAddModal',
    title: 'إضافة عميل جديد · Add New Customer',
    icon:  'fa-user-plus',
    large: true,
    bodyHtml: bodyHtml,
    footHtml: footHtml
  });

  var nameEl = q('#posCustAddName');
  if (nameEl) setTimeout(function () { nameEl.focus(); }, 60);

  function showError(html, opts) {
    var box = q('#posCustAddError');
    if (!box) return;
    box.innerHTML = html;
    if (opts && opts.actions) {
      var actHtml = '<div class="pos-cust-form-error-actions">' +
        opts.actions.map(function (a) {
          return '<button type="button" data-pos-err-act="' + _posEsc(a.id) + '">' + _posEsc(a.label) + '</button>';
        }).join('') + '</div>';
      box.innerHTML += actHtml;
      opts.actions.forEach(function (a) {
        var b = box.querySelector('[data-pos-err-act="' + a.id + '"]');
        if (b) b.addEventListener('click', a.onClick);
      });
    }
    box.hidden = false;
  }
  function clearError() {
    var box = q('#posCustAddError');
    if (!box) return;
    box.hidden = true;
    box.innerHTML = '';
  }

  function doSave() {
    clearError();
    var name   = String((q('#posCustAddName')   || {}).value || '').trim();
    var nameEn = String((q('#posCustAddNameEn') || {}).value || '').trim();
    var phone  = String((q('#posCustAddPhone')  || {}).value || '').trim();
    var email  = String((q('#posCustAddEmail')  || {}).value || '').trim();
    var addr   = String((q('#posCustAddAddress')|| {}).value || '').trim();
    var city   = String((q('#posCustAddCity')   || {}).value || '').trim();
    var type   = String((q('#posCustAddType')   || {}).value || 'B2C');
    var gender = String((q('#posCustAddGender') || {}).value || 'unknown');
    var credit = Number((q('#posCustAddCredit') || {}).value || 0) || 0;

    if (!name)  { showError('<i class="fas fa-exclamation-triangle"></i> اسم العميل مطلوب · Name is required'); var n = q('#posCustAddName'); if (n) n.focus(); return; }
    if (!phone) { showError('<i class="fas fa-exclamation-triangle"></i> رقم الهاتف مطلوب · Phone is required'); var p = q('#posCustAddPhone'); if (p) p.focus(); return; }
    if (phone.length < 5) { showError('<i class="fas fa-exclamation-triangle"></i> رقم الهاتف قصير جداً (5 أرقام على الأقل)'); var p2 = q('#posCustAddPhone'); if (p2) p2.focus(); return; }

    var btn = q('#posCustAddSaveBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> جارٍ الحفظ...'; }

    var payload = {
      id: '',           // empty = INSERT
      name: name,
      nameEn: nameEn,
      vatNumber: '',
      phone: phone,
      email: email,
      address: addr,
      city: city,
      customerType: type,
      creditLimit: credit,
      gender: gender,
      username: (state.user && state.user.username) || (window.currentUser) || 'cashier'
    };

    console.log('[POS customer add] saving →', payload);
    api.withSuccessHandler(function (res) {
      console.log('[POS customer add] backend response:', res);
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-floppy-disk"></i> حفظ وربط · Save & Link'; }
      if (res && res.success) {
        var newId = res.id || ('CUST-' + Date.now());
        wrap.close();
        _posCustomerSelect({
          id: newId,
          name: name,
          phone: phone,
          gender: gender
        }, { message: '✓ تم إنشاء العميل [' + newId + '] وربطه · Saved & linked' });
        // v6.15.1 — Confirm-via-readback: immediately query the customer
        // we just saved to PROVE it's in the DB and searchable.  If it
        // doesn't come back, alert the cashier loudly instead of failing
        // silently like before.
        // v6.15.2 — Distinguish "API call never reached backend" (rows==null,
        // route was unmapped) from "API returned an empty list" (rows==[]).
        // The first means we have a bigger problem to surface; the second
        // is the "saved but not searchable" case that warrants the toast.
        setTimeout(function () {
          api.withSuccessHandler(function (rows) {
            if (rows == null) {
              console.error('[POS customer add] readback returned null — search API not mapped');
              if (typeof glassToast === 'function') {
                glassToast('⚠ تعذّر التحقق من العميل (لم يتم استدعاء البحث) — حدّث الصفحة', true);
              }
              return;
            }
            var found = rows.some(function (c) { return c.id === newId || c.phone === phone; });
            console.log('[POS customer add] readback check (phone=' + phone + '): ' + (found ? 'FOUND ✓' : 'MISSING ✗'), rows);
            if (!found && typeof glassToast === 'function') {
              glassToast('⚠ تحذير: العميل لم يظهر في البحث بعد الإضافة — استخدم زر "🔄 تحديث" في نافذة البحث', true);
            }
          }).withFailureHandler(function (err) {
            console.error('[POS customer add] readback failed', err);
          }).searchCustomers(phone);
        }, 400);
      } else {
        var err = (res && res.error) || 'فشل غير معروف';
        var isDup = /duplicate|ER_DUP_ENTRY|uq_customers_phone|already exists/i.test(String(err));
        if (isDup) {
          showError(
            '<i class="fas fa-exclamation-triangle"></i> ' +
            'رقم الهاتف <strong>' + _posEsc(phone) + '</strong> موجود مسبقاً لعميل آخر.<br>' +
            'استخدم الزر أدناه لاستدعاء العميل الموجود.',
            { actions: [
              { id: 'use-existing', label: '🔍 استدعاء العميل الموجود',
                onClick: function () { wrap.close(); posOpenCustomerSearchModal(phone); } }
            ]}
          );
        } else {
          showError('<i class="fas fa-exclamation-triangle"></i> فشل الحفظ: ' + _posEsc(err));
        }
      }
    }).withFailureHandler(function (e) {
      console.error('[POS customer add] network error:', e);
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-floppy-disk"></i> حفظ وربط · Save & Link'; }
      showError('<i class="fas fa-exclamation-triangle"></i> خطأ في الاتصال: ' + _posEsc((e && e.message) || e));
    }).saveCustomer(payload, payload.username);
  }

  var saveBtn = q('#posCustAddSaveBtn');
  if (saveBtn) saveBtn.addEventListener('click', doSave);

  // Enter inside any input (except select) → submit
  var card = wrap.querySelector('.pos-cust-modal-card');
  if (card) {
    card.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      var t = e.target && e.target.tagName;
      if (t === 'INPUT') { e.preventDefault(); doSave(); }
    });
  }
};

// ─── Initial paint when the script loads (in case state has prior data) ─
try { _posCustomerRenderStatusBar(); } catch(_) {}

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
  var wasEmpty = !state.cart || state.cart.length === 0;
  var found = state.cart.find(function(c) { return c.id === item.id; });
  if (found) {
    found.qty++;
  } else {
    state.cart.push(Object.assign({}, item, { qty: 1, basePrice: item.price }));
  }
  updateCart();
  // v6.13.0 — Auto-expand the customer panel on the first cart-add so the
  // cashier sees the input fields without having to discover the collapsed
  // header. No-op if the panel is already open or already has a customer.
  if (wasEmpty) {
    try { _posCustomerEnsurePanelOpen(); } catch(_) {}
  }
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

  // ─── v5.11.4 — Validate payment notes whenever "Other" is involved ───
  var paymentNotes = '';
  var needsNote = (payMethod === 'Other') ||
                  (payMethod === 'Split' && splitDetails && Number(splitDetails.Other || 0) > 0);
  if (needsNote) {
    var noteEl = q('#payNotesInput');
    paymentNotes = noteEl ? String(noteEl.value || '').trim() : '';
    if (paymentNotes.length < 3) {
      if (noteEl) { noteEl.focus(); }
      return glassAlert(
        'ملاحظات الدفع مطلوبة · Payment Notes Required',
        'يرجى كتابة سبب اختيار "أخرى" (٣ أحرف على الأقل) · Please describe the "Other" payment (min 3 chars).',
        { danger: true }
      );
    }
  }

  // ─── v6.15.0 — Build the customer block from state.posCustomer ───
  // The v5.11.4 inline-panel DOM fallback (q('#posCustPhone') etc.) is
  // gone: the panel was replaced by two-button + modal UX, and modals
  // write directly to state.posCustomer.  state IS the source of truth.
  // If the cashier didn't pick/create a customer, we send null and the
  // backend treats it as a walk-in sale (no customer_id).
  var customerOut = null;
  try {
    var s = state.posCustomer || {};
    if (s.id) {
      // Linked to an existing customer (picked from search OR just created
      // via the add-modal which auto-links).  Send only the id — backend
      // skips the upsert and just FK-links.
      customerOut = { id: s.id };
    } else if (s.phone) {
      // Defensive: should not happen in v6.15.0 (add-modal always returns
      // an id), but if some flow ever leaves state in {phone,name} without
      // id, fall back to letting the backend upsert by phone.
      customerOut = { phone: s.phone, name: s.name || s.phone, gender: s.gender || 'unknown' };
    }
  } catch(_) { customerOut = null; }

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
    lineDiscounts: Object.keys(state.lineDiscounts || {}).length ? state.lineDiscounts : null,
    // ─── v5.11.4: customer link + payment notes ───
    customer: customerOut,
    paymentNotes: paymentNotes || null
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
      // v6.13.0 — Surface customer-save outcome to the cashier. The
      // backend (routes/sales.js) now returns customerSaveOutcome on the
      // create response. Categories are: linked-existing / created-new /
      // skipped-no-data / skipped-no-phone / failed-insert / failed-other.
      // We only show extra UI for outcomes the user actually cares about:
      try {
        var outcome = res.customerSaveOutcome;
        if (outcome === 'created-new') {
          glassToast('✓ تم إنشاء عميل جَديد وربطه بالفاتورة', false);
          state._posCustLastError = null;
        } else if (outcome === 'linked-existing') {
          glassToast('✓ تم ربط الفاتورة بالعميل', false);
          state._posCustLastError = null;
        } else if (outcome === 'skipped-no-phone') {
          // Cashier typed a name but didn't add a phone — silently warn,
          // since the sale itself succeeded.
          glassToast('⚠ لم يُحفظ العميل — رقم الهاتف مطلوب لحفظ بياناته', true);
        } else if (outcome === 'failed-insert' || outcome === 'failed-other') {
          var err = res.customerSaveError || 'سبب غير معروف';
          glassToast('⚠ فشل حفظ بيانات العميل: ' + err, true);
          state._posCustLastError = err;
        }
      } catch(_) {}
      // v5.14.0 — close the Foodics payment modal on successful sale
      if (typeof closeGlassModal === 'function') closeGlassModal('#modalPayment');
      printReceipt(res.orderId);
      state.cart = [];
      state.currentDiscount = { name: '', amount: 0 };
      // v5.11.4 — reset Other-method notes + customer panel after a successful sale
      try {
        var noteIn = q('#payNotesInput'); if (noteIn) { noteIn.value = ''; }
        var noteLn = q('#payNotesLen');   if (noteLn) { noteLn.textContent = '0'; }
        var noteBl = q('#payNotesBlock'); if (noteBl) { noteBl.classList.add('hidden'); }
        if (typeof posCustomerClear === 'function') posCustomerClear();
      } catch(_) {}
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
    // v6.16.0 — Diagnostic log so we can verify customer linking is
    // working end-to-end (cashier links a customer → save → /invoice/:id
    // returns customerName/Phone → receipt prints the bilingual line).
    // If this logs "customer: null" after the cashier picked someone,
    // something between checkout and storage is still broken.
    console.log('[receipt] orderId=' + orderId + ' customer:',
      inv.customerId ? (inv.customerId + ' / ' + (inv.customerName || '(no name)') + ' / ' + (inv.customerPhone || '(no phone)')) : 'null (walk-in)');
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

      // ── v5.11.4 — Customer line (only when the cashier captured a customer) ──
      (inv.customerName
        ? '<div style="text-align:center;font-size:11px;color:#222;margin:6px 0;border-top:1px dashed #cbd5e1;padding-top:6px;">' +
            'Customer: <strong>' + inv.customerName + '</strong>' + (inv.customerPhone ? ' · ' + inv.customerPhone : '') +
            '<div style="font-size:10px;color:#777;direction:rtl;">العميل: ' + inv.customerName + (inv.customerPhone ? ' · ' + inv.customerPhone : '') + '</div>' +
          '</div>'
        : '') +

      // ── v5.11.4 — Payment notes (Other-method context, when supplied) ──
      (inv.paymentNotes
        ? '<div style="text-align:center;font-size:10px;color:#444;margin:4px 0;font-style:italic;">' +
            'Notes: ' + inv.paymentNotes +
          '</div>'
        : '') +

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

// v5.16.1 — Thermal-printer receipt template, completely redesigned to
// be sharper, more spacious, and beat the typical Saudi POS / Saudi
// Bank receipt aesthetic. Sized for 80mm thermal paper at standard DPI
// (~300px viewport). Highlights vs. the previous version:
//   • Larger centered logo (110px), framed by a thick top rule.
//   • Bigger order-id panel in a bordered box, mono digits.
//   • Date + time on a single labelled row.
//   • Three-column items table with thicker header rule, slight row
//     padding, and a clear @-per-unit subtitle under each item name.
//   • Items total + grand total in a single ALL-BLACK 3-column box.
//   • VAT breakdown table with full borders + bilingual labels.
//   • Payment row stamped like an audit field.
//   • ZATCA QR enlarged to 160px and labelled.
//   • Friendly thank-you footer in both languages.
window.printReceiptWindow = function() {
  var r = state._lastReceipt;
  if (!r) return;
  var qrCanvas = document.querySelector('#receiptQR canvas');
  var qrImg = qrCanvas ? qrCanvas.toDataURL() : '';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;');
  }

  function rowKV(labelEn, labelAr, value, opts) {
    opts = opts || {};
    return '<div style="display:flex;justify-content:space-between;align-items:baseline;font-size:'+(opts.fs||'12px')+';margin:'+(opts.my||4)+'px 0;padding:0 2px;">' +
      '<span style="color:#000;">' + esc(labelEn) +
        (labelAr ? ' <span style="font-size:10px;color:#000;direction:rtl;">' + esc(labelAr) + '</span>' : '') +
      '</span>' +
      '<span style="color:#000;font-weight:'+(opts.bold?'800':'700')+';font-family:ui-monospace,SFMono-Regular,monospace;">' + esc(value) + '</span>' +
    '</div>';
  }

  // Build items table rows — three columns (Qty | Item @ unit price | Total)
  var itemsHtml = '';
  (r.inv.items || []).forEach(function(i) {
    var qty = Number(i.qty) || 0;
    var unitPrice = qty > 0 ? (Number(i.total) / qty) : Number(i.price || 0);
    itemsHtml +=
      '<tr style="direction:ltr;border-bottom:1px dotted #000;">' +
        '<td style="text-align:center;font-size:14px;padding:8px 2px;font-family:ui-monospace,SFMono-Regular,monospace;font-weight:800;vertical-align:top;width:40px;color:#000;">' + qty + '×</td>' +
        '<td style="text-align:left;font-size:13px;padding:8px 8px;font-weight:700;line-height:1.35;color:#000;">' +
          esc(i.name) +
          '<div style="font-size:11px;color:#000;font-weight:600;font-family:ui-monospace,SFMono-Regular,monospace;margin-top:3px;letter-spacing:0.02em;">@ ' + formatVal(unitPrice) + '</div>' +
        '</td>' +
        '<td style="text-align:right;font-size:14px;padding:8px 2px;font-family:ui-monospace,SFMono-Regular,monospace;font-weight:800;vertical-align:top;width:66px;color:#000;">' + formatVal(i.total) + '</td>' +
      '</tr>';
  });

  var html =
    '<!DOCTYPE html><html lang="en" dir="ltr"><head><meta charset="UTF-8"><title>Receipt ' + esc(r.inv.orderId) + '</title>' +
    '<style>' +
      '*{margin:0;padding:0;box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact;font-weight:inherit;}' +
      'body{font-family:"Tahoma","Cairo","Segoe UI","Arial Black",Arial,sans-serif;padding:10px;width:300px;margin:0 auto;font-size:13px;color:#000;background:#fff;font-weight:700;-webkit-font-smoothing:none;-moz-osx-font-smoothing:never;font-smooth:never;text-rendering:geometricPrecision;}' +
      // Thermal-printer override (kept from v5.14.9). Forces every
      // element black + bold + thin stroke. Bumps tiny inline 9-10px
      // sizes to 11px so they survive on 80mm paper.
      '@media print{@page{margin:0;size:80mm auto;}' +
        'body{padding:6px 4px;width:100%;font-weight:800;}' +
        '*,*::before,*::after{color:#000 !important;font-weight:700 !important;-webkit-text-stroke:0.3px #000;text-shadow:0 0 0.4px #000;}' +
        '[style*="font-size:9px"],[style*="font-size:10px"]{font-size:11px !important;}' +
      '}' +
    '</style></head><body>' +

    // ───── HEADER: logo + brand identity ─────
    (r.logoUrl
      ? '<div style="text-align:center;padding:6px 0 8px;border-bottom:2.5px solid #000;margin-bottom:8px;">' +
          '<img src="' + esc(r.logoUrl) + '" style="max-width:110px;max-height:110px;object-fit:contain;display:block;margin:0 auto;">' +
        '</div>'
      : '<div style="border-top:2.5px solid #000;margin-bottom:8px;"></div>'
    ) +

    '<div style="text-align:center;font-size:15px;font-weight:800;direction:rtl;margin-bottom:2px;">' + esc(r.companyNameAr || 'المذاق المغربي') + '</div>' +
    '<div style="text-align:center;font-size:20px;font-weight:900;direction:ltr;margin-bottom:' + (r.branchCompanyName ? '4' : '8') + 'px;letter-spacing:0.5px;">' + esc(r.companyName) + '</div>' +
    (r.branchCompanyName
      ? '<div style="text-align:center;font-size:13px;font-weight:700;color:#000;direction:rtl;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid #000;">' + esc(r.branchCompanyName) + '</div>'
      : ''
    ) +

    '<div style="text-align:center;font-size:13px;color:#000;font-weight:700;margin-bottom:1px;">Simplified TAX Invoice</div>' +
    '<div style="text-align:center;font-size:11px;color:#000;direction:rtl;margin-bottom:8px;">فاتورة ضريبية مبسطة</div>' +

    (r.taxNumber
      ? '<div style="text-align:center;margin-bottom:6px;padding:4px 8px;border:1.5px solid #000;border-radius:2px;display:inline-block;width:100%;">' +
          '<span style="font-size:10px;color:#000;letter-spacing:0.05em;">VAT NO. <span style="direction:rtl;">| الرقم الضريبي</span></span><br>' +
          '<span style="font-size:13px;color:#000;font-family:ui-monospace,SFMono-Regular,monospace;font-weight:800;direction:ltr;">' + esc(r.taxNumber) + '</span>' +
        '</div>'
      : ''
    ) +

    (r.branchName ? '<div style="text-align:center;font-size:13px;font-weight:800;direction:ltr;margin-top:6px;letter-spacing:0.5px;">' + esc(String(r.branchName).toUpperCase()) + '</div>' : '') +
    (r.branchAddr ? '<div style="text-align:center;font-size:11px;color:#000;direction:rtl;margin-bottom:8px;line-height:1.6;">' + esc(r.branchAddr) + '</div>' : '') +

    '<div style="border-top:2px solid #000;margin:8px 0;"></div>' +

    // ───── v6.11.0 — VOIDED / RETURNED BANNER (only for reversed sales) ─────
    // Thermal printers cannot render WHITE INK — so we rely on heavy borders
    // + bold black text on a light fill rather than reversed text.
    (r.inv.zatcaType === 'cancellation'
      ? '<div style="text-align:center;margin:8px 0;padding:8px;background:#fff;border:3px double #000;border-radius:3px;">' +
          '<div style="font-size:16px;font-weight:900;letter-spacing:2px;color:#000;">VOIDED · مَلغاة</div>' +
          (r.inv.voidSerial ? '<div style="font-size:11px;font-family:ui-monospace,monospace;font-weight:800;color:#000;margin-top:3px;">' + esc(r.inv.voidSerial) + '</div>' : '') +
        '</div>'
      : (r.inv.zatcaType === 'credit_note' || r.inv.returnSerial
          ? '<div style="text-align:center;margin:8px 0;padding:8px;background:#fff;border:3px double #000;border-radius:3px;">' +
              '<div style="font-size:16px;font-weight:900;letter-spacing:2px;color:#000;">RETURNED · مُرتَجَع</div>' +
              (r.inv.returnSerial ? '<div style="font-size:11px;font-family:ui-monospace,monospace;font-weight:800;color:#000;margin-top:3px;">' + esc(r.inv.returnSerial) + '</div>' : '') +
            '</div>'
          : '')
    ) +

    // ───── INVOICE BADGE (black-on-light for thermal compatibility) ─────
    // v6.11.0 — Replaced "white text on black bg" with "bold black text on
    // light bg + heavy border". White ink is impossible on thermal printers,
    // and the global "@media print *{color:#000}" override turned the old
    // white-on-black badge into invisible black-on-black.
    '<div style="text-align:center;margin-bottom:8px;">' +
      '<div style="background:#f0f0f0;color:#000;text-align:center;padding:6px 16px;font-weight:800;font-size:13px;display:inline-block;border:2px solid #000;border-radius:3px;letter-spacing:0.5px;">' +
        'TAX INVOICE <span style="font-size:11px;direction:rtl;">| فاتورة ضريبية</span>' +
      '</div>' +
    '</div>' +

    // ───── v6.11.0 — PROMINENT INVOICE NUMBER (the standard customer-facing #) ─────
    // Falls back to the legacy long orderId when invoiceNumber is null
    // (sales recorded before migration 0002).
    '<div style="text-align:center;padding:10px 6px;border:2px solid #000;margin-bottom:8px;border-radius:3px;">' +
      '<div style="font-size:10px;color:#000;letter-spacing:0.1em;font-weight:700;margin-bottom:2px;">' +
        'INVOICE NO. <span style="direction:rtl;font-size:11px;">| رقم الفاتورة</span>' +
      '</div>' +
      '<div style="font-size:20px;font-weight:900;font-family:ui-monospace,SFMono-Regular,monospace;letter-spacing:1.5px;color:#000;">' +
        esc(r.inv.invoiceNumber || r.inv.orderId) +
      '</div>' +
    '</div>' +

    // ───── ORDER ID (technical, smaller — kept for support / ZATCA traceability) ─────
    '<div style="border:1px solid #000;border-radius:3px;padding:6px 10px;margin-bottom:8px;">' +
      (r.inv.invoiceNumber
        ? '<div style="display:flex;justify-content:space-between;align-items:baseline;font-size:9px;letter-spacing:0.05em;color:#000;margin-bottom:3px;">' +
            '<span>SYSTEM REF <span style="direction:rtl;">| المرجع</span></span>' +
            '<span style="font-family:ui-monospace,SFMono-Regular,monospace;font-weight:700;color:#000;font-size:9px;word-break:break-all;text-align:end;">' + esc(r.inv.orderId) + '</span>' +
          '</div>'
        : ''
      ) +
      '<div style="display:flex;justify-content:space-between;align-items:baseline;font-size:11px;color:#000;' + (r.inv.invoiceNumber ? 'border-top:1px dashed #000;padding-top:4px;' : '') + '">' +
        '<span>DATE <span style="direction:rtl;">| التاريخ</span></span>' +
        '<span style="font-family:ui-monospace,SFMono-Regular,monospace;font-weight:700;color:#000;">' + esc(r.dateStr) + '</span>' +
      '</div>' +
    '</div>' +

    // ───── ITEMS TABLE ─────
    // v6.11.0 — Header was "white text on black bg" → invisible after the
    // global "@media print *{color:#000 !important}" override. Switched to
    // black text on light grey with a strong border so labels actually print.
    '<table style="width:100%;border-collapse:collapse;direction:ltr;table-layout:fixed;">' +
      '<thead><tr style="border-top:2px solid #000;border-bottom:2px solid #000;background:#f0f0f0;color:#000;">' +
        '<th style="text-align:center;font-size:11px;padding:6px 2px;color:#000;font-weight:900;letter-spacing:0.05em;width:40px;">QTY</th>' +
        '<th style="text-align:left;font-size:11px;padding:6px 8px;color:#000;font-weight:900;letter-spacing:0.05em;">ITEM</th>' +
        '<th style="text-align:right;font-size:11px;padding:6px 2px;color:#000;font-weight:900;letter-spacing:0.05em;width:66px;">TOTAL ' + esc(r.currency) + '</th>' +
      '</tr></thead>' +
      '<tbody>' + itemsHtml + '</tbody>' +
    '</table>' +

    // ───── TOTAL ITEMS BANNER ─────
    '<div style="text-align:center;margin:10px 0;padding:6px 0;border-top:1px dashed #000;border-bottom:1px dashed #000;">' +
      '<span style="font-size:11px;color:#000;letter-spacing:0.05em;">TOTAL ITEMS <span style="direction:rtl;font-size:10px;">| عدد الأصناف</span> :</span> ' +
      '<span style="font-size:18px;font-weight:900;font-family:ui-monospace,SFMono-Regular,monospace;color:#000;">' + esc(r.totalItems) + '</span>' +
    '</div>' +

    // ───── VAT BREAKDOWN ─────
    // v6.11.0 — Was white-on-black headers → invisible in print.
    // Now black-on-light grey with strong borders for thermal compatibility.
    '<table style="width:100%;border-collapse:collapse;border:1.5px solid #000;margin:10px 0;">' +
      '<tr style="background:#f0f0f0;color:#000;border-bottom:1.5px solid #000;">' +
        '<td style="text-align:center;padding:6px 4px;border-right:1px solid #000;font-size:11px;font-weight:900;color:#000;">TOTAL<br>VALUE<div style="font-size:9px;color:#000;direction:rtl;margin-top:2px;">إجمالي القيمة</div></td>' +
        '<td style="text-align:center;padding:6px 4px;border-right:1px solid #000;font-size:11px;font-weight:900;color:#000;">NET<br>AMOUNT<div style="font-size:9px;color:#000;direction:rtl;margin-top:2px;">قبل الضريبة</div></td>' +
        '<td style="text-align:center;padding:6px 4px;font-size:11px;font-weight:900;color:#000;">VAT<br>15%<div style="font-size:9px;color:#000;direction:rtl;margin-top:2px;">ضريبة القيمة</div></td>' +
      '</tr>' +
      '<tr>' +
        '<td style="text-align:center;padding:10px 4px;border-right:1px solid #000;font-size:16px;font-weight:900;font-family:ui-monospace,SFMono-Regular,monospace;">' + formatVal(r.inv.totalFinal) + '</td>' +
        '<td style="text-align:center;padding:10px 4px;border-right:1px solid #000;font-size:16px;font-weight:900;font-family:ui-monospace,SFMono-Regular,monospace;">' + r.netAmount.toFixed(2) + '</td>' +
        '<td style="text-align:center;padding:10px 4px;font-size:16px;font-weight:900;font-family:ui-monospace,SFMono-Regular,monospace;">' + r.vatAmount.toFixed(2) + '</td>' +
      '</tr>' +
    '</table>' +

    // ───── PAYMENT ROW (black-on-light, double-border for emphasis) ─────
    '<div style="border:2.5px double #000;border-radius:3px;padding:8px 10px;margin:10px 0;background:#f0f0f0;color:#000;">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;font-size:13px;font-weight:900;color:#000;">' +
        '<span style="color:#000;">PAYMENT · <span style="direction:rtl;">طريقة الدفع</span>: ' + esc(r.inv.payment || 'CASH') + '</span>' +
        '<span style="color:#000;font-family:ui-monospace,SFMono-Regular,monospace;font-size:16px;">' + formatVal(r.inv.totalFinal) + ' ' + esc(r.currency) + '</span>' +
      '</div>' +
    '</div>' +

    // ───── CASHIER / SERVER ─────
    '<div style="text-align:center;font-size:12px;color:#000;margin:8px 0;padding:6px;border-top:1px dashed #000;">' +
      '<div style="font-weight:700;">SERVED BY: <strong style="font-size:13px;">' + esc(r.cashierName) + (r.cashierEmpNo && r.cashierEmpNo !== r.cashierName ? ' (' + esc(r.cashierEmpNo) + ')' : '') + '</strong></div>' +
      '<div style="font-size:11px;color:#000;direction:rtl;margin-top:2px;">قدّم لكم الخدمة: ' + esc(r.cashierName) + '</div>' +
    '</div>' +

    // ───── ZATCA QR ─────
    (qrImg
      ? '<div style="text-align:center;margin:14px 0 8px;padding:10px;border:1.5px solid #000;border-radius:3px;">' +
          '<img src="' + qrImg + '" width="160" height="160" style="display:block;margin:0 auto;">' +
          '<div style="font-size:10px;color:#000;margin-top:6px;letter-spacing:0.05em;font-weight:700;">SCAN FOR ZATCA E-INVOICE</div>' +
          '<div style="font-size:10px;color:#000;direction:rtl;margin-top:1px;">امسح للحصول على الفاتورة الإلكترونية</div>' +
        '</div>'
      : ''
    ) +

    // ───── THANK YOU ─────
    '<div style="text-align:center;margin-top:10px;padding-top:8px;border-top:2px solid #000;">' +
      '<div style="font-size:14px;font-weight:800;color:#000;letter-spacing:0.5px;">THANK YOU FOR YOUR VISIT</div>' +
      '<div style="font-size:13px;font-weight:800;color:#000;direction:rtl;margin-top:2px;">شُكرًا لِزيارَتِكم</div>' +
    '</div>' +

    '<div style="text-align:center;font-size:10px;color:#000;margin-top:6px;">All Prices Include VAT (15%)</div>' +
    '<div style="text-align:center;font-size:10px;color:#000;direction:rtl;margin-bottom:4px;">جميع الأسعار شاملة الضريبة المضافة (15%)</div>' +

    // ───── CONTACT ─────
    (r.companyPhone || r.companyEmail
      ? '<div style="text-align:center;margin-top:6px;padding-top:5px;border-top:1px dashed #000;">' +
          (r.companyPhone ? '<div style="font-size:11px;color:#000;font-family:ui-monospace,SFMono-Regular,monospace;font-weight:700;">📞 ' + esc(r.companyPhone) + '</div>' : '') +
          (r.companyEmail ? '<div style="font-size:11px;color:#000;font-family:ui-monospace,SFMono-Regular,monospace;font-weight:700;">✉ ' + esc(r.companyEmail) + '</div>' : '') +
        '</div>'
      : ''
    ) +

    // Bottom padding so the printer cut doesn't shave the last line
    '<div style="height:14px;"></div>' +

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
          msg: t('noAmountEnteredMsg') + totalExpected.toFixed(2) + ' ر.س' + t('noAmountEnteredMsgSuffix')
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
    : (variance < 0 ? '⚠ نقص: ' + fmt(Math.abs(variance)) + ' ر.س' : '⚠ زيادة: ' + fmt(variance) + ' ر.س');

  var lines = [
    '📋 تقرير إغلاق الوردية',
    '',
    '🏪 ' + (r.company || ''),
    '📅 ' + (r.date || ''),
    '🆔 ' + (r.shiftId || ''),
    '👤 ' + (r.cashierName || r.cashier || '') + (r.cashier && r.cashierName !== r.cashier ? ' (' + r.cashier + ')' : ''),
    '',
    '🧾 عدد الفواتير: ' + (r.orders || 0),
    '💰 إجمالي متوقع: ' + fmt(r.totalExpected) + ' ر.س',
    '💵 إجمالي فعلي: ' + fmt(r.totalActual) + ' ر.س',
    '📊 الفرق: ' + diffLine,
    ''
  ];
  // Dynamic payment methods (V3) — preferred over legacy cash/card/kita
  if (r.paymentTotals && Object.keys(r.paymentTotals).length) {
    lines.push('💳 توزيع طرق الدفع:');
    Object.keys(r.paymentTotals).forEach(function(k) {
      lines.push('  • ' + k + ': ' + fmt(r.paymentTotals[k]) + ' ر.س');
    });
  } else {
    // Legacy fallback
    if (r.cash) lines.push('💵 كاش: ' + fmt(r.cash) + ' ر.س');
    if (r.card) lines.push('💳 مدى/شبكة: ' + fmt(r.card) + ' ر.س');
    if (r.kita) lines.push('🧾 كيتا: ' + fmt(r.kita) + ' ر.س');
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
        return '<tr><td style="text-align:center;">' + v + ' ر.س</td><td style="text-align:center;">' + c + '</td><td style="text-align:end;">' + fmt(v * c) + '</td></tr>';
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
      '<tr><td>المتوقع</td><td style="text-align:end;">' + fmt(r.totalExpected) + ' ر.س</td></tr>' +
      '<tr><td>الفعلي</td><td style="text-align:end;">' + fmt(r.totalActual) + ' ر.س</td></tr>' +
      '<tr style="background:#fef3c7;"><td><b>الفرق (' + varianceLabel + ')</b></td><td style="text-align:end;color:' + varianceClr + ';"><b>' + (variance >= 0 ? '+' : '') + fmt(variance) + ' ر.س</b></td></tr>' +
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

// ═══════════════════════════════════════════════════════════════════
// v5.11.4 — POS "My Invoices" (current shift) + Cancel / Return actions
// ═══════════════════════════════════════════════════════════════════
// Lists every invoice the current cashier rang up during the active
// shift, with a status badge (Active / Cancelled / Returned). Active
// rows get two action buttons:
//   • إلغاء · Cancel   → POST /api/sales/:id/void  (zatca_type=cancellation)
//   • مرتجع · Return   → POST /api/sales/:id/return (zatca_type=credit_note)
// Both reuse the existing _reverseSaleEffects() transaction so inventory
// and GL stay consistent; the only difference is the ZATCA stamp + the
// audit metadata appended to payment_notes.
state._myInvCache = state._myInvCache || [];

window.posOpenMyInvoices = function () {
  if (!state.user) {
    return glassToast('يرجى تسجيل الدخول أولاً · Please sign in first', true);
  }
  openGlassModal('#modalMyInvoices');
  posLoadMyInvoices();
};

window.posLoadMyInvoices = function () {
  var host = q('#myInvoicesContent');
  if (host) {
    host.innerHTML =
      '<div style="text-align:center;padding:30px;color:#94a3b8;">' +
        '<i class="fas fa-spinner fa-spin"></i> جاري التحميل · Loading…' +
      '</div>';
  }
  var today = new Date(); var pad = function(n){return n<10?'0'+n:n;};
  var dStr = today.getFullYear() + '-' + pad(today.getMonth()+1) + '-' + pad(today.getDate());
  api.withSuccessHandler(function (arr) {
    var all = Array.isArray(arr) ? arr : [];
    // Only the current shift (cashier may have spanned midnight)
    var rows = state.activeShiftId
      ? all.filter(function (r) { return r.shiftId === state.activeShiftId; })
      : all;
    state._myInvCache = rows;
    _myInvRender(rows);
  }).withFailureHandler(function () {
    _myInvRender([]);
  }).getSalesListDetailed({
    username: state.user || '',
    startDate: dStr,
    endDate: dStr
  });
};

function _myInvStatusBadge(r) {
  var t_ = String(r.zatcaType || '').toLowerCase();
  // v6.11.0 — Append the void/return serial under the badge when present so
  // operators have a single, copy-friendly reference for the action.
  if (t_ === 'cancellation') {
    var ser = r.voidSerial ? '<div class="my-inv-serial">' + r.voidSerial + '</div>' : '';
    return '<span class="my-inv-badge red"><i class="fas fa-ban"></i> ملغاة · Cancelled</span>' + ser;
  }
  if (t_ === 'credit_note') {
    var ser2 = r.returnSerial ? '<div class="my-inv-serial">' + r.returnSerial + '</div>' : '';
    return '<span class="my-inv-badge orange"><i class="fas fa-undo"></i> مرتجع · Returned</span>' + ser2;
  }
  return '<span class="my-inv-badge green"><i class="fas fa-check"></i> سارية · Active</span>';
}

function _myInvFmtTime(s) {
  try {
    var dt = new Date(s);
    if (isNaN(dt)) return s || '';
    var pad = function(n){return n<10?'0'+n:n;};
    return pad(dt.getDate()) + '/' + pad(dt.getMonth()+1) + ' · ' +
           pad(dt.getHours()) + ':' + pad(dt.getMinutes()) + ':' + pad(dt.getSeconds());
  } catch (_) { return s || ''; }
}

function _myInvRender(rows) {
  var host = q('#myInvoicesContent');
  var stat = q('#myInvStats');
  if (stat) {
    var activeCount    = rows.filter(function(r){return !r.zatcaType || (r.zatcaType !== 'cancellation' && r.zatcaType !== 'credit_note');}).length;
    var cancelledCount = rows.filter(function(r){return r.zatcaType === 'cancellation';}).length;
    var returnedCount  = rows.filter(function(r){return r.zatcaType === 'credit_note';}).length;
    var totalAmount    = rows.reduce(function(s,r){
      if (r.zatcaType === 'cancellation' || r.zatcaType === 'credit_note') return s;
      return s + (Number(r.total) || 0);
    }, 0);
    stat.innerHTML =
      '<span class="my-inv-stat"><i class="fas fa-receipt"></i> ' + rows.length + ' · إجمالي · Total</span>' +
      '<span class="my-inv-stat green">سارية · ' + activeCount + '</span>' +
      '<span class="my-inv-stat red">ملغاة · ' + cancelledCount + '</span>' +
      '<span class="my-inv-stat orange">مرتجع · ' + returnedCount + '</span>' +
      '<span class="my-inv-stat blue">' + totalAmount.toFixed(2) + ' ر.س · SAR</span>';
  }
  if (!host) return;
  if (!rows.length) {
    host.innerHTML =
      '<div style="text-align:center;padding:50px 20px;color:#94a3b8;">' +
        '<i class="fas fa-receipt" style="font-size:48px;opacity:.4;display:block;margin-bottom:12px;"></i>' +
        '<div style="font-size:14px;">لا توجد فواتير في هذه الوردية بعد</div>' +
        '<div style="font-size:12px;color:#cbd5e1;margin-top:4px;">No invoices in the current shift yet</div>' +
      '</div>';
    return;
  }
  var html = '<table class="my-inv-table"><thead><tr>' +
    '<th>الحالة · Status</th>' +
    '<th>الوقت · Time</th>' +
    '<th>رقم الفاتورة · Invoice #</th>' +
    '<th>المنتجات · Products</th>' +
    '<th>الإجمالي · Total</th>' +
    '<th>الدفع · Payment</th>' +
    '<th>إجراءات · Actions</th>' +
  '</tr></thead><tbody>';
  rows.forEach(function (r) {
    var t_ = String(r.zatcaType || '').toLowerCase();
    var active = !(t_ === 'cancellation' || t_ === 'credit_note');
    var prods = (r.items || []).slice(0, 3).map(function (it) {
      return '<span class="my-inv-prod-chip">' + (it.qty || 1) + '× ' + (it.name || '—') + '</span>';
    }).join(' ');
    if ((r.items || []).length > 3) {
      prods += '<span class="my-inv-prod-more">+' + ((r.items || []).length - 3) + '</span>';
    }
    var safeId = String(r.orderId || '').replace(/'/g, "\\'");
    // v6.11.0 — Show the human-readable invoice number when present, with
    // the long technical orderId shown beneath as a smaller "system ref".
    var displayNumber = r.invoiceNumber || r.orderId || '';
    var sysRefHtml = r.invoiceNumber
      ? '<div class="my-inv-sysref">' + (r.orderId || '') + '</div>'
      : '';
    html +=
      // v6.14.0 — data-order-id lets _posHighlightVoidedRow find this row
      // after a successful void so we can flash + scroll it into view.
      '<tr class="my-inv-row' + (active ? '' : ' is-reversed') + '" data-order-id="' + safeId + '">' +
        '<td>' + _myInvStatusBadge(r) + '</td>' +
        '<td class="my-inv-time">' + _myInvFmtTime(r.date) + '</td>' +
        '<td class="my-inv-id">' + displayNumber + sysRefHtml + '</td>' +
        '<td class="my-inv-prods">' + (prods || '—') + '</td>' +
        '<td class="my-inv-total">' + (Number(r.total) || 0).toFixed(2) + ' ر.س</td>' +
        '<td class="my-inv-pay">' + (r.payment || '—') + (r.paymentNotes ? '<div class="my-inv-pay-notes">' + r.paymentNotes + '</div>' : '') + '</td>' +
        '<td class="my-inv-actions">' +
          (active
            ? '<button class="my-inv-btn red"    onclick="posInvoiceVoid(\''   + safeId + '\')"><i class="fas fa-ban"></i> إلغاء · Cancel</button>' +
              '<button class="my-inv-btn orange" onclick="posInvoiceReturn(\'' + safeId + '\')"><i class="fas fa-undo"></i> مرتجع · Return</button>'
            : '<span class="my-inv-btn-disabled">تم — لا إجراءات · Done</span>') +
        '</td>' +
      '</tr>';
  });
  html += '</tbody></table>';
  host.innerHTML = html;
}

// v6.14.0 — Self-contained DOM-built confirmation modal.
//   v6.11.0/v6.12.1 used glassConfirm (UNDEFINED in POS — only glassToast +
//   glassAlert exist) with a window.confirm() fallback. In kiosk browsers
//   or popup-blocked environments the native confirm either never shows
//   OR returns false immediately, so the void/return callback never ran
//   and the cashier saw absolutely nothing happen.
//
// This rewrite removes both external dependencies. It builds a fixed-
// position overlay + card directly in document.body with z-index 10010
// (above other modals), wires the two buttons to known callbacks, and
// supports Escape / outside-click to dismiss. The API stays identical:
// `_myInvConfirm(title, body, cb)` — `cb` runs only on explicit confirm.
function _myInvConfirm(title, body, cb) {
  var fired = false;
  var safeCb = function () {
    if (fired) return;
    fired = true;
    try { cb(); } catch (e) {
      if (typeof glassToast === 'function') glassToast('خطأ غير متوقع: ' + (e && e.message || e), true);
      else alert('Unexpected error: ' + (e && e.message || e));
    }
  };

  // Remove any leftover modal from a previous canceled session
  var prev = document.getElementById('posConfirmModal');
  if (prev) prev.remove();

  var wrap = document.createElement('div');
  wrap.id = 'posConfirmModal';
  wrap.className = 'pos-confirm-modal';
  wrap.setAttribute('role', 'dialog');
  wrap.setAttribute('aria-modal', 'true');
  // Body may contain newlines — convert to <br> while escaping HTML
  var safeBody = String(body || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
  var safeTitle = String(title || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  wrap.innerHTML =
    '<div class="pos-confirm-card" role="document">' +
      '<div class="pos-confirm-head">' +
        '<i class="fas fa-circle-exclamation"></i>' +
        '<h3>' + safeTitle + '</h3>' +
      '</div>' +
      '<div class="pos-confirm-body">' + safeBody + '</div>' +
      '<div class="pos-confirm-foot">' +
        '<button type="button" class="pos-confirm-cancel" data-act="cancel">' +
          '<i class="fas fa-times"></i> إلغاء · Cancel</button>' +
        '<button type="button" class="pos-confirm-ok" data-act="ok">' +
          '<i class="fas fa-check"></i> تأكيد · Confirm</button>' +
      '</div>' +
    '</div>';

  function close() {
    document.removeEventListener('keydown', onKey, true);
    if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    else if (e.key === 'Enter') {
      e.stopPropagation();
      close(); safeCb();
    }
  }

  wrap.addEventListener('click', function (e) {
    var act = e.target && e.target.closest && e.target.closest('[data-act]');
    if (act) {
      e.stopPropagation();
      var which = act.getAttribute('data-act');
      close();
      if (which === 'ok') safeCb();
      return;
    }
    // Outside-click on the dim backdrop closes without confirming
    if (e.target === wrap) close();
  });

  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(wrap);
  // Focus the confirm button so Enter immediately confirms
  setTimeout(function () {
    var ok = wrap.querySelector('.pos-confirm-ok');
    if (ok) ok.focus();
  }, 30);
}

window.posInvoiceVoid = function (orderId) {
  if (!orderId) return;
  _myInvConfirm(
    'إلغاء الفاتورة · Cancel Invoice',
    'سيتم استرجاع كامل المخزون وعكس القيود المحاسبية. لا يمكن التراجع عن هذا الإجراء.\n\n' +
    'Stock will be restored and GL entries reversed. This action cannot be undone.\n\n' +
    'Invoice #: ' + orderId,
    function () {
      loader(true);
      api.withSuccessHandler(function (res) {
        loader(false);
        if (res && res.success) {
          var msg = '✓ تم إلغاء الفاتورة · Invoice cancelled';
          if (res.voidSerial) msg += ' (' + res.voidSerial + ')';
          glassToast(msg);
          // v6.14.0 — Reload, then flash + scroll-into-view the row that
          // just got voided so the cashier has an unmistakable visual
          // confirmation that "the thing I clicked is now cancelled".
          posLoadMyInvoices();
          setTimeout(function () { _posHighlightVoidedRow(orderId); }, 250);
        } else {
          // v6.14.0 — Surface the new structured error from migration 0003
          // so an operator with an outdated DB sees the actionable hint.
          var err = (res && res.error) || '';
          var emsg;
          if (err === 'already-reversed') {
            emsg = 'هذه الفاتورة معكوسة بالفعل · This invoice was already reversed';
          } else if (/void-update-failed|enum_missing_cancellation/i.test(err)) {
            emsg = 'فشل الإلغاء: قاعدة البيانات تحتاج لتحديث (migration 0003). أعِد تشغيل الخادم.';
          } else {
            emsg = err || 'فشل الإلغاء · Cancel failed';
          }
          glassAlert('خطأ · Error', emsg, { danger: true });
        }
      }).withFailureHandler(function (err) {
        loader(false);
        glassAlert('فشل الاتصال · Network error', (err && err.message) || '', { danger: true });
      }).voidSale(orderId, state.user || 'system');
    }
  );
};

// v6.14.0 — After posLoadMyInvoices repaints, find the just-voided row
// by its data-order-id, add the .is-just-voided class (triggers the 2s
// CSS animation), and scroll it into view if it's off-screen.
function _posHighlightVoidedRow(orderId) {
  if (!orderId) return;
  var row = document.querySelector('.my-inv-row[data-order-id="' + String(orderId).replace(/"/g, '\\"') + '"]');
  if (!row) return;
  row.classList.add('is-just-voided');
  try {
    var rect = row.getBoundingClientRect();
    var inView = rect.top >= 0 && rect.bottom <= (window.innerHeight || document.documentElement.clientHeight);
    if (!inView) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (_) {}
  // Auto-remove the class after the animation so it can re-fire if the
  // operator voids another row.
  setTimeout(function () { row.classList.remove('is-just-voided'); }, 2200);
}

window.posInvoiceReturn = function (orderId) {
  if (!orderId) return;
  _myInvConfirm(
    'مرتجع الفاتورة · Return Invoice',
    'سيُسجَّل مرتجع كامل: استرجاع المخزون + إصدار إشعار دائن (Credit Note) في ZATCA + عكس القيود المحاسبية.\n\n' +
    'A full customer return will be recorded: stock restored, ZATCA credit note issued, GL entries reversed.\n\n' +
    'Invoice #: ' + orderId,
    function () {
      var reason = window.prompt('سبب الإرجاع (اختياري) · Return reason (optional)', 'customer return') || 'customer return';
      loader(true);
      api.withSuccessHandler(function (res) {
        loader(false);
        if (res && res.success) {
          glassToast('تم تسجيل المرتجع ✓ · Return recorded');
          posLoadMyInvoices();
        } else {
          var msg = (res && res.error === 'already-reversed')
            ? 'هذه الفاتورة معكوسة بالفعل · This invoice was already reversed'
            : ((res && res.error) || 'فشل تسجيل المرتجع · Return failed');
          glassAlert('خطأ · Error', msg, { danger: true });
        }
      }).withFailureHandler(function (err) {
        loader(false);
        glassAlert('فشل الاتصال · Network error', (err && err.message) || '', { danger: true });
      }).returnSale(orderId, state.user || 'system', reason);
    }
  );
};

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

// v6.12.1 — Whitelist clicks that originate inside the virtual keyboard.
// The keyboard mounts at document.body (`#vkKeyboard`) — so a key tap
// is "outside" both the search input AND the results dropdown. Without
// this guard, every keypress fired `click` on body → outside-click
// handler → dropdown hidden → next `input` event re-opened it. Result:
// visible flicker. Selector list covers id + class + data-attribute so
// future keyboard rebrands don't reintroduce the bug.
function _vkContains(target) {
  if (!target || !target.closest) return false;
  return !!(target.closest('#vkKeyboard') ||
            target.closest('.vk-keyboard') ||
            target.closest('[data-vk-root]'));
}

function _closeCstDropdown(e) {
  var res = q('#cstSearchResults');
  var search = q('#cstSearch');
  if (!res || !search) return;
  // If click is outside the search input AND dropdown AND virtual keyboard, hide it
  if (!search.contains(e.target) && !res.contains(e.target) && !_vkContains(e.target)) {
    res.style.display = 'none';
  }
}

// v6.12.0 — Normalize Arabic text for fuzzy search.
// Without this, typing "ا" on the virtual keyboard fails to match items
// stored as "أرز" / "إجازة" / "آبار" because the alif variants are
// distinct Unicode codepoints. We also normalize ta-marbuta → ha,
// alif-maqsura → ya, hamza-on-waw → waw, hamza-on-ya → ya, and strip
// tashkeel diacritics. The transformation is applied to BOTH the query
// and the candidate so any combination matches symmetrically.
function _normalizeArabic(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[ً-ْ]/g, '')   // strip tashkeel (fatha→sukun, shadda, tanwin)
    .replace(/[ٱأإآ]/g, 'ا')  // ٱ أ إ آ → ا
    .replace(/ة/g, 'ه')      // ة → ه
    .replace(/ى/g, 'ي')      // ى → ي
    .replace(/ؤ/g, 'و')      // ؤ → و
    .replace(/ئ/g, 'ي');     // ئ → ي
}

window.filterCashierStItems = function() {
  var rawSearch = (q('#cstSearch') ? q('#cstSearch').value : '');
  var search = _normalizeArabic(rawSearch);
  var res = q('#cstSearchResults');
  if (!res) return;
  // Get IDs already in cart so we can hide them from the dropdown
  var cart = _getCstCart();
  var cartIds = cart.map(function(c) { return c.id; });
  // Filter: exclude items already in cart + apply search
  var available = _cstAllItems.filter(function(i) { return cartIds.indexOf(i.id) === -1; });
  var matches = search
    ? available.filter(function(i) {
        return _normalizeArabic(i.name || '').includes(search)
            || _normalizeArabic(i.id   || '').includes(search);
      })
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
    // v5.15.1 — data-vk="1" so the virtual keyboard auto-opens here.
    var bigCell = hasBig
      ? '<td style="text-align:center;"><input type="number" data-vk="1" min="0" step="1" class="form-control glass-input" style="width:55px;margin:0 auto;padding:5px;text-align:center;font-weight:800;" value="' + (bigVal === '' ? '' : bigVal) + '" oninput="updateCstDual(' + i + ',this.value,null)" placeholder="0"></td>'
      : '<td style="text-align:center;color:#e2e8f0;">—</td>';
    // Column 3: وحدة كبرى
    var bigUnitCell = '<td style="text-align:center;font-size:11px;color:#64748b;">' + (hasBig ? c.bigUnit : '—') + '</td>';
    // Column 4: الصغرى — always has input
    var smallCell = '<td style="text-align:center;"><input type="number" data-vk="1" min="0" step="0.01" class="form-control glass-input" style="width:60px;margin:0 auto;padding:5px;text-align:center;font-weight:800;" value="' + (smallVal === '' ? '' : smallVal) + '" oninput="updateCstDual(' + i + ',null,this.value)" placeholder="0"></td>';
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
// FLOAT ACTIONS TOGGLE (POS pill + horizontal popover, v6.17.0)
// ═══════════════════════════════════════
// In v6.17.0 the old vertical sidebar was replaced by a purple POS pill
// button at the bottom-end that expands a horizontal popover next to it.
// The function name + behaviour (just toggling .collapsed) stay the same
// so existing callers (and the HTML onclick handler) keep working.
window.toggleFloatActions = function() {
  var el = document.getElementById('floatActions');
  if (!el) return;
  var handle = document.getElementById('floatHandle');
  el.classList.toggle('collapsed');
  // v6.17.0 — keep aria-expanded in sync so screen readers + assistive
  // tech announce the state change.
  if (handle) {
    handle.setAttribute('aria-expanded',
      String(!el.classList.contains('collapsed')));
  }
};

// v6.17.0 — Auto-dismiss behaviour:
//   • Escape closes the popover.
//   • Clicking any action button inside it closes after the click runs
//     (so the popover behaves like a real menu).
//   • Clicking anywhere outside #floatActions closes.
(function setupPosFloatActionsAutoDismiss(){
  function closeMenu() {
    var el = document.getElementById('floatActions');
    if (!el || el.classList.contains('collapsed')) return;
    el.classList.add('collapsed');
    var h = document.getElementById('floatHandle');
    if (h) h.setAttribute('aria-expanded', 'false');
  }
  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape') closeMenu();
  });
  // Capture phase so we run before any inner handler that might
  // stopPropagation.  But we DON'T cancel the click — we let the
  // action's onclick run first, then dismiss on the next tick.
  document.addEventListener('click', function(e){
    var el = document.getElementById('floatActions');
    if (!el || el.classList.contains('collapsed')) return;
    var t = e.target;
    if (!t) return;
    // Inside an action button → schedule dismiss after the action runs
    var insideBtn = t.closest && t.closest('#floatBtns .float-btn');
    if (insideBtn) { setTimeout(closeMenu, 0); return; }
    // Inside the pill itself → toggleFloatActions handles it
    if (t.closest && t.closest('#floatHandle')) return;
    // Anywhere else outside the container → dismiss
    if (!el.contains(t)) closeMenu();
  }, true);
})();

// Auto-collapse on mobile after 5 seconds (legacy behaviour, retained).
// v6.17.0 — the menu is now collapsed by default in the HTML so this is
// mostly a no-op, but kept in case external code expands it programmatically.
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
  // v6.12.1 — Same virtual-keyboard whitelist as _closeCstDropdown
  // (see helper _vkContains defined earlier in the file).
  if (!search.contains(e.target) && !res.contains(e.target) && !_vkContains(e.target)) {
    res.style.display = 'none';
  }
}

window.shrFilterItems = function(query) {
  var box = q('#shrSearchResults');
  // v6.12.0 — Normalize so typing "ا" matches names stored with أ / إ / آ
  // (same helper as filterCashierStItems above).
  var ql = _normalizeArabic(query || '');
  var cartIds = _shrCart.map(function(c) { return c.id; });
  var available = _shrAllItems.filter(function(i) { return cartIds.indexOf(i.id) === -1; });
  var matches = ql
    ? available.filter(function(i) {
        return _normalizeArabic(i.name     || '').indexOf(ql) >= 0
            || _normalizeArabic(i.category || '').indexOf(ql) >= 0
            || _normalizeArabic(i.id       || '').indexOf(ql) >= 0;
      })
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
    // v5.15.1 — data-vk="1" so the virtual keyboard auto-opens here.
    var bigQtyCell = hasBig
      ? '<td style="text-align:center;"><input type="number" data-vk="1" min="0" step="1" class="form-control glass-input" style="width:55px;margin:0 auto;padding:5px;text-align:center;font-weight:800;" value="' + bigVal + '" oninput="shrUpdateDual(' + i + ',this.value,null)" placeholder="0"></td>'
      : '<td style="text-align:center;color:#e2e8f0;">—</td>';
    var bigUnitCell = '<td style="text-align:center;font-size:11px;color:#64748b;">' + (hasBig ? c.bigUnit : '—') + '</td>';
    var smallQtyCell = '<td style="text-align:center;"><input type="number" data-vk="1" min="0" step="1" class="form-control glass-input" style="width:55px;margin:0 auto;padding:5px;text-align:center;font-weight:800;" value="' + smallVal + '" oninput="shrUpdateDual(' + i + ',null,this.value)" placeholder="0"></td>';
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

// v5.15.3 — Manual refresh button on the cashier. Re-fetches sales
// channels and every channel's menu items in parallel, then re-renders.
// Used when admin updates channel items and the cashier wants the change
// without reloading the page (which would lose the in-progress cart).
// v5.16.2 — Quick action from the empty-state panel. Copies every
// admin-menu item for the cashier's current brand into the active
// channel's channel_menu_items list, then refreshes. One click, no
// admin trip. Falls back to a polite toast if no brand is set.
window.posQuickPopulateChannel = function (channelId) {
  if (!channelId) channelId = state.activeChannel && state.activeChannel.id;
  if (!channelId) { glassToast('لا تَوجَد قَناة مُختارة', true); return; }
  if (!confirm('سيَتم نَسخ كل أصناف المنيو الرَئيسي إلى القَناة الحالية. مُتابعة؟')) return;

  // Find the MAIN channel id from state.channels
  var mainCh = (state.channels || []).find(function (c) {
    var code = String(c.code || '').toUpperCase();
    var ctype = String(c.channelType || c.channel_type || '').toLowerCase();
    return code === 'MAIN' || ctype === 'main';
  });
  if (!mainCh || mainCh.id === channelId) {
    glassToast('لا تَوجَد قَناة رَئيسية لِلنَسخ منها', true);
    return;
  }

  loader(true);
  _posCallAPI('POST', '/channel-menus/' + encodeURIComponent(channelId) + '/copy-from/' + encodeURIComponent(mainCh.id), {}, function (r) {
    loader(false);
    if (r && r.error) { glassToast(r.error, true); return; }
    glassToast('تَم النَسخ — يَتم التَحديث...');
    // Re-fetch the channel's items and re-render
    setTimeout(function () {
      if (typeof posRefreshAll === 'function') posRefreshAll();
    }, 300);
  });
};

// v5.16.2 — Quick jump to MAIN from any empty channel. Useful when
// the cashier just wants to start selling and discovers the active
// channel has no items yet.
window.posJumpToMain = function () {
  var mainCh = (state.channels || []).find(function (c) {
    var code = String(c.code || '').toUpperCase();
    var ctype = String(c.channelType || c.channel_type || '').toLowerCase();
    return code === 'MAIN' || ctype === 'main';
  });
  if (!mainCh) { glassToast('لا تَوجَد قَناة رَئيسية في النِظام', true); return; }
  if (typeof posSetChannel === 'function') posSetChannel(mainCh.id);
};

window.posRefreshAll = function () {
  var btn = document.querySelector('.pos-refresh-btn');
  if (btn) btn.classList.add('is-spinning');
  if (typeof glassToast === 'function') glassToast('جاري التَحديث...', false);

  // Drop in-memory channel caches so nothing is stale
  state.channelMenuCache = {};
  state._channelCustomItems = [];
  try { localStorage.removeItem('pos_channel_menu_cache'); } catch (e) {}

  // Re-fetch channels + per-channel menus (posLoadV3Data prefetches all
  // non-MAIN channels in parallel, then auto-selects from localStorage).
  if (typeof posLoadV3Data === 'function') {
    try { posLoadV3Data(); } catch (e) { console.warn('refresh: posLoadV3Data failed', e); }
  }

  // Force re-fetch the full menu too, so state.menu reflects any new items.
  state.menu = [];
  if (typeof _ensureMenuLoaded === 'function') {
    _ensureMenuLoaded(function () {
      if (typeof renderCategoryGrid === 'function') renderCategoryGrid();
      if (typeof renderMenuGrid === 'function') renderMenuGrid();
    });
  }

  setTimeout(function () {
    if (btn) btn.classList.remove('is-spinning');
    if (typeof glassToast === 'function') glassToast('تَم التَحديث', false);
  }, 1200);
};

// ─── 1. Load V3 data on init ────────────────────────────────────────────
window.posLoadV3Data = function() {
  // v5.15.3 — Hydrate channelMenuCache from localStorage so the very
  // first channel switch is instant. Then the background pre-fetch
  // below refreshes it. Without this, the first switch after a hard
  // reload always waits on the network.
  try {
    var _persistedCache = localStorage.getItem('pos_channel_menu_cache');
    if (_persistedCache) {
      state.channelMenuCache = JSON.parse(_persistedCache) || {};
    }
  } catch (e) { /* corrupt cache — ignore */ }

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
        // v5.10.27 — endpoint now returns either an array (legacy) or an
        // envelope { priceList, items }. Normalize so the cache always
        // holds the item array; the priceList badge is rendered live on
        // channel switch from state.activeChannel.priceListId.
        var arr = Array.isArray(cmRows) ? cmRows : ((cmRows && Array.isArray(cmRows.items)) ? cmRows.items : []);
        state.channelMenuCache[c.id] = arr;
        // v5.15.3 — persist after every prefetch so the next page open
        // is instant. localStorage write is cheap (~kB JSON).
        try { localStorage.setItem('pos_channel_menu_cache', JSON.stringify(state.channelMenuCache)); } catch (e) {}
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

// v5.16.4 — Layered fallback chain to guarantee state.menu is populated
// before rendering. The cashier MUST see SOMETHING. Order:
//   1. /menu                 (active items, no brand filter, no semi-finished filter as of v5.16.4)
//   2. /menu/all             (every row in the menu table — last resort)
// Tries each step once per session; if a step returns items we stop.
// Caches the result in localStorage so reloads pick it up instantly.
function _ensureMenuLoaded(cb) {
  var current = (state.menu || []).filter(function (i) { return i.active; });
  if (current.length > 0) { if (cb) cb(); return; }
  if (state._menuFallbackTried) { if (cb) cb(); return; }
  state._menuFallbackTried = true;

  var applyRows = function (rows, source) {
    if (Array.isArray(rows) && rows.length) {
      state.menu = rows;
      state.categories = Array.from(new Set(rows.map(function (i) { return i.category; })))
                              .filter(function (c) { return c && String(c).trim() !== ''; });
      try { localStorage.setItem('pos_menu_cache', JSON.stringify({ ts: Date.now(), menu: rows })); } catch (e) {}
      console.log('[pos-menu] fallback (' + source + ') fetched', rows.length, 'items');
      return true;
    }
    return false;
  };

  console.warn('[pos-menu] state.menu empty — fallback step 1: /menu');
  _posCallAPI('GET', '/menu', null, function (rows1) {
    if (applyRows(rows1, '/menu')) { if (cb) cb(); return; }
    console.warn('[pos-menu] /menu returned empty — fallback step 2: /menu/all');
    _posCallAPI('GET', '/menu/all', null, function (rows2) {
      if (!applyRows(rows2, '/menu/all')) {
        console.error('[pos-menu] all fallback layers returned empty — DB likely has 0 menu rows');
      }
      if (cb) cb();
    });
  });
}

function _doSetChannel(ch) {
  var isSwitch = state.activeChannel && state.activeChannel.id !== ch.id;
  state.activeChannel = ch;
  localStorage.setItem('pos_active_channel_id', ch.id);
  // v5.15.3 — ALWAYS render a visible price-list chip (linked or
  // default). Previously when ch.priceListId was null the top label
  // rendered as an empty string, hiding the channel↔price-list
  // relationship from the cashier.
  var _plChip = ch.priceListId
    ? '<i class="fas fa-link"></i> قائمة أسعار: <b>' + (ch.priceListName || 'مُخَصَّصة') + '</b>'
    : '<i class="fas fa-circle-info"></i> قائمة الأسعار الافتراضية';
  var _plChipCls = ch.priceListId ? 'is-linked' : 'is-default';

  var label = q('#posChannelPriceLabel');
  if (label) {
    label.className = 'pos-channel-pricelist ' + _plChipCls;
    label.innerHTML = _plChip;
  }
  var sel = q('#posChannelSel');
  if (sel) sel.value = ch.id;
  // v5.14.0 — keep the top Foodics selector in sync
  var selTop = q('#posChannelSelTop');
  if (selTop) selTop.value = ch.id;
  var topLabel = q('#posChannelPriceLabelTop');
  if (topLabel) {
    topLabel.className = 'pos-action-pricelist ' + _plChipCls;
    topLabel.innerHTML = _plChip;
  }

  // v5.10.29 — Read the EXPLICIT useFullMenu flag from the channel row.
  // Replaces the v5.12.4 implicit "MAIN/dine_in → full menu" inference.
  // The owner controls per-channel from admin → قنوات البيع → edit:
  //   • Toggle ON  → cashier shows every active menu item (the legacy
  //                 MAIN behavior, also the migration default for
  //                 existing MAIN/dine_in rows)
  //   • Toggle OFF → cashier shows ONLY items configured via
  //                 channel-menu-items; if zero, an explicit empty state
  //                 with "Copy from MAIN" / "Add items" buttons appears.
  //                 No silent fallback to MAIN anymore.
  // We still support the LEGACY implicit MAIN detection as a fallback
  // when the row doesn't carry the flag yet (e.g., old API client).
  var _code  = String(ch.code || '').toUpperCase();
  var _ctype = String(ch.channelType || ch.channel_type || '').toLowerCase();
  var _isMainLike = (_code === 'MAIN') || (_ctype === 'main');
  var useFullMenu = (ch.useFullMenu != null) ? !!ch.useFullMenu : _isMainLike;
  state.activeChannel.useFullMenu = useFullMenu;

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

  if (useFullMenu) {
    // Skip the channel-menu fetch entirely — saves a round-trip and
    // guarantees the full menu shows. This branch fires for any channel
    // where admin explicitly toggled "Use full menu" ON (MAIN/dine_in
    // by default; can also be opted into for any other channel).
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
      // v5.10.29 — NO MORE silent fallback. If the channel has zero
      // configured items, the cashier shows an explicit empty state
      // with action buttons ("Copy from MAIN" + "Open admin channel
      // editor"). The owner's "channels are not independent" complaint
      // was caused by the legacy auto-fallback making every empty
      // channel impersonate MAIN — that's why it's gone here.
      state.activeChannel._autoFellBackToMain = false;
      _ensureMenuLoaded(function () {
        _posApplyChannelPrices();
        _refreshChannelViews();
        if (available.length === 0) {
          // Show the empty-state UI (categories grid renderer surfaces
          // it via _posRenderChannelEmptyState — see below).
          if (typeof _posRenderChannelEmptyState === 'function') {
            _posRenderChannelEmptyState(state.activeChannel);
          }
        }
      });
    };
    if (cached) applyRows(cached);
    var branchQ = state.branchId ? '?branchId=' + encodeURIComponent(state.branchId) : '';
    _posCallAPI('GET', '/channel-menus/' + ch.id + branchQ, null, function (rows) {
      if (rows && rows.error) {
        // v5.10.29 — On a fetch failure, show the empty-state UI rather
        // than secretly switching to the full menu. The owner's hard
        // requirement is "channels are independent" — silently impersonating
        // MAIN on error was the root cause of the "channels feel merged"
        // complaint.
        console.error('[channel-menu] fetch error for', ch.id, ':', rows.error);
        if (!cached) {
          state.channelMenuItems = [];
          state.channelOverrideMap = {};
          state.activeChannel.useFullMenu = false;
          state.activeChannel._autoFellBackToMain = false;
          _posApplyChannelPrices();
          _refreshChannelViews();
          if (typeof _posRenderChannelEmptyState === 'function') {
            _posRenderChannelEmptyState(state.activeChannel, rows.error);
          }
        }
        return;
      }
      // v5.10.27 — envelope-aware unwrap. The endpoint may return either
      // a flat array (legacy clients) or { priceList, items } (new). The
      // priceList object lets us show "أسعار قائمة: X" badge above the
      // grid so cashiers immediately know which list is driving prices.
      if (!Array.isArray(rows) && rows && Array.isArray(rows.items)) {
        if (state.activeChannel) {
          state.activeChannel._priceListBadge = rows.priceList || null;
        }
        rows = rows.items;
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
    '<div style="font-size:12px;color:#1e3a8a;">إجمالي السطر: ' + _posFmt(lineTotal) + ' ر.س</div>' +
  '</div>';

  if (lineDiscounts.length) {
    html += '<div style="font-weight:800;margin-bottom:8px;">خصومات جاهزة:</div>';
    html += lineDiscounts.map(function(d){
      var valStr = d.type === 'percentage' ? d.value + '%' : _posFmt(d.value) + ' ر.س';
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
      '<input id="posLineDiscValue" type="number" data-vk="1" step="0.01" min="0" class="form-control glass-input" placeholder="القيمة" style="flex:1;">' +
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
  glassToast('تم تطبيق خصم: ' + d.name + ' (' + _posFmt(amt) + ' ر.س)');
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
    '<div style="font-weight:800;">إجمالي الفاتورة: ' + _posFmt(subtotal) + ' ر.س</div>' +
  '</div>';

  if (invDiscounts.length) {
    html += '<div style="font-weight:800;margin-bottom:8px;">خصومات جاهزة على الفاتورة:</div>';
    html += invDiscounts.map(function(d){
      var valStr = d.type === 'percentage' ? d.value + '%' : _posFmt(d.value) + ' ر.س';
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
      '<input id="posInvDiscValue" type="number" data-vk="1" step="0.01" min="0" class="form-control glass-input" placeholder="القيمة" style="flex:1;">' +
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
  glassToast('تم تطبيق خصم: ' + d.name + ' (' + _posFmt(amt) + ' ر.س)');
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
// v6.5.1 — Expanded to the full SAMA-circulating set so cash counts are
// halala-accurate (owner spec: "يجب أن تكون أكثر دقَّة من هذا").
// Banknotes (500 / 200 / 100 / 50 / 20 / 10 / 5 SAR) +
// Coins (2 / 1 SAR, 50 / 25 / 10 / 5 halalas).
state._v3CashDenoms = [500, 200, 100, 50, 20, 10, 5, 2, 1, 0.5, 0.25, 0.10, 0.05];

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
  _scLockClose('Finish counting first', 'fa-lock');

  // ── Cashier label ──
  var cashierName = (state.currentUser && state.currentUser.displayName) || state.user || '—';
  if (q('#scCashierLbl')) q('#scCashierLbl').textContent = cashierName;

  // ── Denomination cards ──
  // v6.5.1 — denomination cards are now English-only ("SAR" / "halalas")
  // per owner spec ("ارجو منك تحويله كامل للانجليزيه"). The full SAMA set
  // (500 → 0.05 SAR) is rendered so the count is halala-accurate.
  var grid = q('#scDenomGrid');
  if (grid) {
    grid.innerHTML = state._v3CashDenoms.map(function(d) {
      var isCoin = d < 1;
      var faceLabel = isCoin ? (Math.round(d * 100) + ' h')  : (d + ' SAR');
      var unitLabel = isCoin ? 'Halalas' : (d <= 2 ? 'Coin' : 'Note');
      return '<div class="sc-denom-card">' +
               '<div class="sc-denom-card-top"><span class="sc-denom-face">' + faceLabel + '</span><span class="sc-denom-unit">' + unitLabel + '</span></div>' +
               '<input type="number" inputmode="numeric" data-vk="1" min="0" step="1" class="sc-denom-input" data-denom="' + d + '" value="0" oninput="scV3Recalc()" onfocus="this.select()">' +
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
      glassToast((d && d.error) || 'Failed to load shift data', true);
      return;
    }

    // ── Stash expected (will only be SHOWN after reveal) ──
    _scExpectedTotal = Number(d.totalTheoretical || 0);
    var methods = d.methods || [];
    // v6.5.1 — Drop cash + unmatched as before, BUT also drop the legacy
    // "Split" pseudo-row that the payment_methods seed inserted. Split is
    // a UI feature (multi-tender checkout), not a real method — it must
    // never appear as a tile in shift close.
    _scElecMethods = methods.filter(function(m) {
      var gt   = (m.groupType || '').toLowerCase();
      var name = (m.name || '').toLowerCase();
      return gt !== 'cash' && gt !== 'unmatched' && name !== 'split';
    });

    // v6.5.1 — Owner spec: "لماذا مدي ليست موجودة هنا ضمن طرق الدفع
    // الالكترونية". If the deployment has no method that resolves to
    // Mada/Card we surface a synthetic row so every closing has a
    // dedicated card-payment input. Synthetic id is ignored by the
    // backend matcher (it has no real expectedAmount) — the cashier
    // just enters the actual counted amount and the variance shows in
    // the comparison panel.
    var hasMada = _scElecMethods.some(function(m) {
      var n = (m.name   || '').toLowerCase();
      var a = (m.nameAr || '').toLowerCase();
      return n === 'mada' || n === 'card' ||
             n.indexOf('mada') >= 0 || n.indexOf('card') >= 0 ||
             a.indexOf('مدى')  >= 0 || a.indexOf('مدي') >= 0 ||
             a.indexOf('شبكة') >= 0;
    });
    if (!hasMada) {
      _scElecMethods.unshift({
        id: '_synth_mada', name: 'Mada / Card', nameAr: 'Mada / Card',
        groupType: 'electronic', icon: 'fa-credit-card', color: '#3b82f6'
      });
    }
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
        itemsBody.innerHTML = '<tr><td colspan="4" class="sc-empty">No items sold in this shift</td></tr>';
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
    // v6.5.1 — Card heads now prefer the English `name`; Arabic falls
    // back only when EN is empty. Owner spec: shift close fully in EN.
    var elecGrid = q('#scElecGrid');
    if (elecGrid) {
      if (!_scElecMethods.length) {
        elecGrid.innerHTML = '<div class="sc-empty">No electronic payment methods</div>';
      } else {
        elecGrid.innerHTML = _scElecMethods.map(function(m) {
          var displayName = m.name || m.nameAr || '—';
          return '<div class="sc-elec-card">' +
                   '<div class="sc-elec-card-head"><i class="fas ' + (m.icon || 'fa-credit-card') + '" style="color:' + (m.color || '#3b82f6') + ';"></i> <span>' + displayName + '</span></div>' +
                   '<input type="number" inputmode="decimal" data-vk="1" min="0" step="0.01" class="sc-elec-input" data-pmid="' + m.id + '" data-pmname="' + (m.name || '').toLowerCase() + '" placeholder="0.00" oninput="scV3Recalc()" onfocus="this.select()">' +
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
    _scLockClose('Finish counting first', 'fa-lock');
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
      if (diffLbl) diffLbl.textContent = 'Balanced ✓';
    } else if (totalDiff < 0) {
      diffCard.classList.add('sc-cmp-diff-neg');
      if (diffLbl) diffLbl.textContent = 'Cash drawer SHORT';
    } else {
      diffCard.classList.add('sc-cmp-diff-pos');
      if (diffLbl) diffLbl.textContent = 'Cash drawer OVER';
    }
  }

  // Per-method breakdown (cash row + each electronic method)
  var pmd = q('#scPerMethodDiff');
  if (pmd) {
    var rows = [];
    rows.push(_scPmdRow('💵 Cash', _scExpectedCash, actualCash));
    _scElecMethods.forEach(function(m) {
      // Prefer English name; fall back to Arabic only when EN is empty.
      var nameLabel = m.name || m.nameAr || '—';
      var label = '<i class="fas ' + (m.icon || 'fa-credit-card') + '" style="color:' + (m.color || '#3b82f6') + ';margin-inline-end:4px;"></i>' + nameLabel;
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
    else _scLockClose('Explain the variance first (' + note.length + '/10)', 'fa-pen');
  }
};

function _scPmdRow(label, exp, act) {
  var diff = act - exp;
  var clr  = Math.abs(diff) < 0.01 ? '#16a34a' : (diff < 0 ? '#dc2626' : '#d97706');
  var sign = diff >= 0 ? '+' : '';
  return '<div class="sc-pmd-row">' +
           '<div class="sc-pmd-name">' + label + '</div>' +
           '<div class="sc-pmd-vals">' +
             '<span class="sc-pmd-exp">Expected: ' + _posFmt(exp) + '</span>' +
             '<span class="sc-pmd-act">Actual: ' + _posFmt(act) + '</span>' +
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
  btn.innerHTML = '<i class="fas fa-check-double"></i> Confirm shift close';
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
        : Number(x.value) + ' ر.س';
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
      '<tr><td style="padding:7px;border-bottom:1px solid #e2e8f0;">إجمالي متوقع</td><td style="padding:7px;border-bottom:1px solid #e2e8f0;text-align:left;font-weight:700;">' + _posFmt(totalExpected) + ' ر.س</td></tr>' +
      '<tr><td style="padding:7px;border-bottom:1px solid #e2e8f0;">إجمالي فعلي</td><td style="padding:7px;border-bottom:1px solid #e2e8f0;text-align:left;font-weight:700;">' + _posFmt(totalActual) + ' ر.س</td></tr>' +
      '<tr style="background:#fef3c7;"><td style="padding:9px;font-weight:900;">الفرق (' + varianceLabel + ')</td><td style="padding:9px;text-align:left;font-weight:900;color:' + varianceClr + ';">' + (variance >= 0 ? '+' : '') + _posFmt(variance) + ' ر.س</td></tr>' +
    '</table>' +
    (Object.keys(actuals).length ? (
      '<table style="width:100%;border-collapse:collapse;margin-top:14px;">' +
        '<tr style="background:#f8fafc;"><td colspan="2" style="padding:8px;font-weight:800;font-size:12px;">💳 توزيع طرق الدفع</td></tr>' +
        Object.keys(actuals).map(function(k) {
          var v = Number(actuals[k] || 0);
          return '<tr><td style="padding:6px;border-bottom:1px solid #e2e8f0;">' + k + '</td><td style="padding:6px;border-bottom:1px solid #e2e8f0;text-align:left;font-weight:700;">' + _posFmt(v) + ' ر.س</td></tr>';
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

