/**
 * Auth helpers — JWT check, redirect, logout
 * Import this in every protected page (POS, dashboard, inventory, etc.)
 */

(function() {
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
    if (!confirm(state.lang === 'ar' ? 'هل أنت متأكد من تسجيل الخروج؟' : 'Are you sure you want to logout?')) return;
    localStorage.removeItem('pos_token');
    localStorage.removeItem('pos_session');
    localStorage.removeItem('pos_state');
    localStorage.removeItem('pos_active_shift_id');
    window.location.href = '/';
  };
})();
