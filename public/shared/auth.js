/**
 * Auth helpers — JWT check, redirect, logout
 * Import this in every protected page (POS, dashboard, inventory, etc.)
 */

(function() {
  // ─── bfcache / back-button guard ────────────────────────────────────
  // When the browser restores a page from its back/forward cache AFTER
  // logout, the inline auth gate in the page never re-runs, so the
  // cashier sees the POS screen as if still logged in. We listen for
  // pageshow (fires on every display, including bfcache restores) and
  // force a hard navigation back to /login if the token is gone.
  window.addEventListener('pageshow', function(ev) {
    if (ev.persisted || !localStorage.getItem('pos_token') || !localStorage.getItem('pos_session')) {
      if (!localStorage.getItem('pos_token')) {
        window.location.replace('/');
      }
    }
  });
  // Also intercept browser back when no token
  window.addEventListener('popstate', function() {
    if (!localStorage.getItem('pos_token')) window.location.replace('/');
  });

  // ─── Get current authenticated user from localStorage ───
  window.getCurrentUser = function() {
    try {
      var raw = localStorage.getItem('pos_session');
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return null;
  };

  // ─── Check token presence — used in pages that need auth ───
  window.requireAuth = function(redirect) {
    var token = localStorage.getItem('pos_token');
    var session = getCurrentUser();
    if (!token || !session) {
      // Not authenticated — bounce back to login (root)
      window.location.href = '/';
      return false;
    }
    // Restore minimal state from session
    if (window.state) {
      window.state.user = session.user || '';
      window.state.role = (session.role || '').toLowerCase();
    }
    return true;
  };

  // ─── Role check ───
  window.hasRole = function(role) {
    var s = getCurrentUser();
    if (!s) return false;
    return (s.role || '').toLowerCase() === role.toLowerCase();
  };
  window.isAdmin = function() {
    return hasRole('admin') || hasRole('manager');
  };

  // ─── Logout ───
  window.logout = function() {
    var lang = (window.state && state.lang) || localStorage.getItem('pos_lang') || 'ar';
    if (!confirm(lang === 'ar' ? 'هل أنت متأكد من تسجيل الخروج؟' : 'Are you sure you want to logout?')) return;
    // Clear EVERYTHING related to the session (including any cached POS cart,
    // shift id, etc.) — don't leave residue a BF-cached page could restore.
    ['pos_token','pos_session','pos_state','pos_active_shift_id','emp_token','emp_session']
      .forEach(function(k) { try { localStorage.removeItem(k); } catch(e){} });
    try { sessionStorage.clear(); } catch(e){}
    // Replace current history entry so pressing back doesn't land back on
    // the authenticated page (browsers honor this for bfcache exclusion).
    window.location.replace('/');
  };
})();
