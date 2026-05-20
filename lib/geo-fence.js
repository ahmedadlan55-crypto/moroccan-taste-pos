// ═══════════════════════════════════════════════════════════════════
// v5.11.0 — Geo-fence helper for branch-bound authentication.
// Used by routes/auth.js (login + logout) and routes/hr.js (clock-in/out)
// to verify the user is physically within their branch's configured
// circular fence (geo_lat, geo_lng, geo_radius from the branches table).
// ═══════════════════════════════════════════════════════════════════

// Roles that MUST be inside the geo-fence to login/logout. Admin,
// manager, and developer accounts are intentionally exempt — they
// often manage remotely and locking them out of the system would
// break operations.
const GEOFENCE_ROLES = new Set(['cashier', 'employee', 'custody']);

function isRoleSubjectToGeofence(role, isDeveloper) {
  if (isDeveloper) return false;
  return GEOFENCE_ROLES.has(String(role || '').toLowerCase());
}

// Haversine formula: distance between two lat/lng points, in metres.
// R = 6,371,000 m (mean Earth radius).
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Check whether the user's reported (lat, lng) is inside the branch's
// configured fence. Returns:
//   { ok: true,  reason: 'no_branch' | 'branch_no_geo' | 'inside', distance?, radius? }
//   { ok: false, reason: 'no_location' | 'outside_radius', distance?, radius?, message }
//
// Behaviour matrix (matches v5.11.0 plan):
//   - No branchId on user            → ok (no fence to apply)
//   - Branch exists but no geo_lat   → ok (administrator hasn't configured fence yet)
//   - User omitted lat/lng           → BLOCKED (must grant location permission)
//   - User is outside the radius     → BLOCKED (clear Arabic distance message)
//   - User is inside the radius      → ok
async function checkBranchGeofence(db, branchId, userLat, userLng) {
  if (!branchId) return { ok: true, reason: 'no_branch' };
  let branch;
  try {
    const [rows] = await db.query(
      'SELECT geo_lat, geo_lng, geo_radius FROM branches WHERE id = ? LIMIT 1',
      [branchId]
    );
    branch = rows && rows[0];
  } catch (e) {
    // If the branches table or columns are missing on a legacy install,
    // don't lock everyone out — degrade to "allow".
    console.warn('[geo-fence] branch lookup failed:', e.message);
    return { ok: true, reason: 'branch_lookup_failed' };
  }
  if (!branch || branch.geo_lat == null || branch.geo_lng == null) {
    return { ok: true, reason: 'branch_no_geo' };
  }
  const latNum = Number(userLat), lngNum = Number(userLng);
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
    return {
      ok: false, reason: 'no_location',
      message: 'يَجب السماح بتحديد الموقع لتسجيل الدخول'
    };
  }
  const dist = haversineMeters(
    Number(branch.geo_lat), Number(branch.geo_lng),
    latNum, lngNum
  );
  const radius = Math.max(10, Number(branch.geo_radius) || 100);
  if (dist > radius) {
    return {
      ok: false, reason: 'outside_radius',
      distance: Math.round(dist), radius,
      message: 'أنت خارج نطاق الفرع — على بُعد ' + Math.round(dist) +
               ' متر من المسموح ' + radius + ' متر'
    };
  }
  return { ok: true, reason: 'inside', distance: Math.round(dist), radius };
}

module.exports = {
  haversineMeters,
  checkBranchGeofence,
  isRoleSubjectToGeofence,
  GEOFENCE_ROLES
};
