/**
 * Shared header component — injects header HTML into <header id="appHeader"></header>
 * Each page calls renderHeader('pos' | 'dashboard' | 'inventory' | ...) to mark the active link.
 */

(function() {
  // Warehouse V2 flag — decides which SINGLE warehouse link the header shows:
  // the V2 section at /warehouse (same tab, same session — no second login) or
  // the legacy /inventory/ UI (kept ONLY as the rollback path when the flag is
  // off). Cached in localStorage so the first paint is correct; refreshed from
  // /api/version (public endpoint) and the header re-renders if it changed.
  // Final Rollout: show «إدارة المستودعات» → /warehouse ONLY for authorized users
  // (V2 enabled AND Warehouse Scope, per-user via the AUTHENTICATED /api/warehouse-nav).
  // While V2 is ON, the legacy /inventory/ entry is hidden for EVERYONE (rollback-
  // internal only); it returns only if V2 is turned OFF. Flags cached for a correct
  // first paint. whV2On = V2 enabled; whV2Show = enabled AND authorized.
  function whV2On() { return localStorage.getItem('wh_v2_flag') === '1'; }
  function whV2Show() { return whV2On() && localStorage.getItem('wh_v2_allowed') === '1'; }
  try {
    var _t = localStorage.getItem('pos_token');
    var _hh = { 'Cache-Control': 'no-cache' };
    if (_t) _hh['Authorization'] = 'Bearer ' + _t;
    fetch('/api/warehouse-nav', { headers: _hh }).then(function(r) { return r.ok ? r.json() : null; }).then(function(v) {
      var f = v && v.v2Enabled ? '1' : '0';
      var a = v && v.v2Allowed ? '1' : '0';
      var changed = localStorage.getItem('wh_v2_flag') !== f || localStorage.getItem('wh_v2_allowed') !== a;
      try { localStorage.setItem('wh_v2_flag', f); localStorage.setItem('wh_v2_allowed', a); } catch (e) {}
      if (changed) {
        var active = document.body.getAttribute('data-page') || '';
        if (typeof window.renderHeader === 'function') window.renderHeader(active, { showShift: !!document.body.getAttribute('data-show-shift') });
      }
    }).catch(function() {});
  } catch (e) {}

  // Pages registry — controls navigation links visibility per role
  function getPages() {
    // authorized → «إدارة المستودعات»→/warehouse ; V2-on-but-unauthorized → no entry ;
    // V2-off → legacy /inventory/ (rollback). Null entries are filtered out below.
    var warehouseEntry = whV2Show()
      ? { key: 'warehouse', href: '/warehouse',  icon: 'fa-warehouse', label: { ar: 'إدارة المستودعات', en: 'Warehouse Management' }, roles: ['admin', 'manager', 'employee', 'custody'] }
      : (whV2On() ? null
                  : { key: 'inventory', href: '/inventory/', icon: 'fa-boxes', label: { ar: 'المخزون', en: 'Inventory' }, roles: ['admin', 'manager'] });
    return [
      { key: 'pos',       href: '/pos/',       icon: 'fa-cash-register',  label: { ar: 'نقطة البيع', en: 'POS' },        roles: ['admin', 'manager', 'cashier'] },
      { key: 'dashboard', href: '/dashboard/', icon: 'fa-chart-line',     label: { ar: 'الرئيسية',   en: 'Dashboard' }, roles: ['admin', 'manager'] },
      warehouseEntry,
      { key: 'reports',   href: '/reports/',   icon: 'fa-file-alt',       label: { ar: 'التقارير',   en: 'Reports' },   roles: ['admin', 'manager'] },
      { key: 'erp',       href: '/erp/',       icon: 'fa-building',       label: { ar: 'ERP',        en: 'ERP' },       roles: ['admin'] },
      { key: 'settings',  href: '/settings/',  icon: 'fa-sliders-h',      label: { ar: 'الإعدادات',  en: 'Settings' },  roles: ['admin'] },
      { key: 'users',     href: '/users/',     icon: 'fa-users-cog',      label: { ar: 'المستخدمين', en: 'Users' },     roles: ['admin'] }
    ].filter(Boolean);
  }

  /**
   * Render the shared header.
   * @param {string} activeKey - which nav link is active
   * @param {object} opts - { showShift: bool }
   */
  window.renderHeader = function(activeKey, opts) {
    opts = opts || {};
    var host = document.getElementById('appHeader');
    if (!host) return;

    var session = (typeof getCurrentUser === 'function') ? getCurrentUser() : null;
    var role = (session && session.role || '').toLowerCase() || 'cashier';
    var lang = (state && state.lang) || 'ar';
    var visiblePages = getPages().filter(function(p) { return p.roles.indexOf(role) !== -1; });

    var navHtml = visiblePages.map(function(p) {
      var label = p.label[lang] || p.label.en;
      var active = p.key === activeKey ? ' active' : '';
      return '<a href="' + p.href + '" class="' + active.trim() + '"><i class="fas ' + p.icon + '"></i><span>' + label + '</span></a>';
    }).join('');

    var shiftBadge = opts.showShift
      ? '<div id="shiftBadge" class="shift-indicator">' + (state.activeShiftId || (lang === 'ar' ? 'لا يوجد وردية' : 'No shift')) + '</div>'
      : '';

    var brandLogo = state.settings && state.settings.logo
      ? '<img src="' + state.settings.logo + '" style="width:32px;height:32px;border-radius:8px;object-fit:cover;">'
      : '<i class="fas fa-mug-hot"></i>';

    var displayName = (session && session.user) || '';
    var logoutLabel = lang === 'ar' ? 'تسجيل خروج' : 'Logout';
    var posLabel    = lang === 'ar' ? 'واجهة البيع' : 'POS';

    host.innerHTML =
      '<div class="app-brand">' + brandLogo + '<span>' + (state.settings && state.settings.name || 'Moroccan Taste') + '</span></div>' +
      '<button class="app-menu-toggle" onclick="toggleAppNav()" aria-label="Menu"><i class="fas fa-bars"></i></button>' +
      '<nav class="app-nav" id="appNav">' + navHtml + '</nav>' +
      '<div class="app-header-actions">' +
        shiftBadge +
        '<button class="btn btn-light app-lang-btn" onclick="toggleLang()" title="AR/EN"><i class="fas fa-language"></i><span>AR/EN</span></button>' +
        '<div class="app-user-badge"><i class="fas fa-user-circle"></i><span>' + displayName + '</span></div>' +
        '<button class="btn btn-danger app-logout-btn" onclick="logout()"><i class="fas fa-sign-out-alt"></i><span>' + logoutLabel + '</span></button>' +
      '</div>';

    // Backdrop for mobile drawer
    if (!document.getElementById('appNavBackdrop')) {
      var bd = document.createElement('div');
      bd.id = 'appNavBackdrop';
      bd.className = 'app-nav-backdrop';
      bd.onclick = toggleAppNav;
      document.body.appendChild(bd);
    }
  };

  // Mobile drawer toggle
  window.toggleAppNav = function() {
    var nav = document.getElementById('appNav');
    var bd = document.getElementById('appNavBackdrop');
    if (!nav) return;
    var open = nav.classList.toggle('open');
    if (bd) bd.classList.toggle('open', open);
  };

  // Re-render header when language changes
  window.addEventListener('languagechange', function() {
    var active = document.body.getAttribute('data-page') || '';
    renderHeader(active, { showShift: !!document.body.getAttribute('data-show-shift') });
  });
})();
