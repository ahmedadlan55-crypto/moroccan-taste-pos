/**
 * Shared header component — injects header HTML into <header id="appHeader"></header>
 * Each page calls renderHeader('pos' | 'dashboard' | 'inventory' | ...) to mark the active link.
 */

(function() {
  // Pages registry — controls navigation links visibility per role
  var PAGES = [
    { key: 'pos',       href: '/pos/',       icon: 'fa-cash-register',  label: { ar: 'نقطة البيع', en: 'POS' },        roles: ['admin', 'manager', 'cashier'] },
    { key: 'dashboard', href: '/dashboard/', icon: 'fa-chart-line',     label: { ar: 'الرئيسية',   en: 'Dashboard' }, roles: ['admin', 'manager'] },
    { key: 'inventory', href: '/inventory/', icon: 'fa-boxes',          label: { ar: 'المخزون',    en: 'Inventory' }, roles: ['admin', 'manager'] },
    { key: 'reports',   href: '/reports/',   icon: 'fa-file-alt',       label: { ar: 'التقارير',   en: 'Reports' },   roles: ['admin', 'manager'] },
    { key: 'erp',       href: '/erp/',       icon: 'fa-building',       label: { ar: 'ERP',        en: 'ERP' },       roles: ['admin'] },
    { key: 'settings',  href: '/settings/',  icon: 'fa-sliders-h',      label: { ar: 'الإعدادات',  en: 'Settings' },  roles: ['admin'] },
    { key: 'users',     href: '/users/',     icon: 'fa-users-cog',      label: { ar: 'المستخدمين', en: 'Users' },     roles: ['admin'] }
  ];

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
    var visiblePages = PAGES.filter(function(p) { return p.roles.indexOf(role) !== -1; });

    var navHtml = visiblePages.map(function(p) {
      var label = p.label[lang] || p.label.en;
      var active = p.key === activeKey ? ' active' : '';
      return '<a href="' + p.href + '" class="' + active.trim() + '"><i class="fas ' + p.icon + '"></i><span>' + label + '</span></a>';
    }).join('');

    var shiftBadge = opts.showShift
      ? '<div id="shiftBadge" class="shift-indicator">' + (state.activeShiftId || (lang === 'ar' ? 'لا يوجد وردية' : 'No shift')) + '</div>'
      : '';

    host.innerHTML =
      '<div class="app-brand"><i class="fas fa-mug-hot"></i><span>' + (state.settings && state.settings.name || 'Moroccan Taste') + '</span></div>' +
      '<button class="app-menu-toggle" onclick="toggleAppNav()" aria-label="Menu"><i class="fas fa-bars"></i></button>' +
      '<nav class="app-nav" id="appNav">' + navHtml + '</nav>' +
      '<div class="app-header-actions">' +
        shiftBadge +
        '<div class="app-user-badge"><i class="fas fa-user-circle"></i><span>' + (session && session.user || '') + '</span></div>' +
        '<button class="btn btn-light" onclick="toggleLang()" title="AR/EN"><i class="fas fa-language"></i></button>' +
        '<button class="btn btn-danger" onclick="logout()" title="' + (lang === 'ar' ? 'خروج' : 'Logout') + '"><i class="fas fa-sign-out-alt"></i></button>' +
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
