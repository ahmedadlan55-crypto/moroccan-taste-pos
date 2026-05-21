// ═══════════════════════════════════════════════════════════════════
// v5.11.0 → v5.11.6 — Attendance helper: clock-in / clock-out into
// hr_attendance. As of v5.11.6 the helpers also persist the device
// brand / model / OS / UA so the owner can verify which phone or
// tablet was actually used to punch in or out.
//
// Both functions are IDEMPOTENT per (employee_id, date):
//   - clockIn  refuses to overwrite an existing clock_in for the day
//   - clockOut refuses to overwrite an existing clock_out for the day
// (Owner expects: one full attendance row per employee per day.)
// ═══════════════════════════════════════════════════════════════════

// Generate a short attendance row id — same scheme used by /my-clock.
function _genAttendanceId() {
  return 'ATT-' + Date.now().toString(36) + '-' +
         Math.random().toString(36).slice(2, 6);
}

// Today in YYYY-MM-DD (server local time — matches /my-clock convention).
function _todayDateStr() {
  return new Date().toISOString().slice(0, 10);
}

// v5.11.6 — Normalise device payload. Accepts either an object
// { brand, model, os, ua } or a free-form string (legacy "deviceName").
function _normalizeDevice(deviceLike) {
  if (!deviceLike) return { brand: '', model: '', os: '', ua: '', label: '' };
  if (typeof deviceLike === 'string') {
    return { brand: '', model: deviceLike.slice(0, 120), os: '', ua: '', label: deviceLike.slice(0, 200) };
  }
  if (typeof deviceLike === 'object') {
    const brand = String(deviceLike.brand || '').slice(0, 80);
    const model = String(deviceLike.model || '').slice(0, 120);
    const os    = String(deviceLike.os    || '').slice(0, 80);
    const ua    = String(deviceLike.ua    || '').slice(0, 500);
    // Build a human-readable label fallback for the legacy device_name column.
    const label = [brand, model, os].filter(Boolean).join(' · ').slice(0, 200);
    return { brand, model, os, ua, label };
  }
  return { brand: '', model: '', os: '', ua: '', label: '' };
}

async function clockIn(db, employeeId, opts) {
  if (!employeeId) return { skipped: true, reason: 'no_employee_id' };
  const o = opts || {};
  const lat = (o.lat != null) ? Number(o.lat) : null;
  const lng = (o.lng != null) ? Number(o.lng) : null;
  const address = String(o.address || '').slice(0, 500);
  const dev = _normalizeDevice(o.device);
  const deviceName = dev.label || String((o.deviceName || '')).slice(0, 200);
  const today = _todayDateStr();
  const now = new Date();
  try {
    const [existing] = await db.query(
      'SELECT id, clock_in FROM hr_attendance WHERE employee_id = ? AND attendance_date = ? LIMIT 1',
      [employeeId, today]
    );
    if (existing.length && existing[0].clock_in) {
      return { skipped: true, reason: 'already_clocked_in', recordId: existing[0].id };
    }
    // v5.11.6 — write device columns, tolerating older deploys that
    // don't have them yet (try/catch around a follow-up UPDATE).
    if (existing.length) {
      await db.query(
        'UPDATE hr_attendance SET clock_in = ?, geo_lat = ?, geo_lng = ?, ' +
        'geo_address_in = ?, device_name = ?, source = ?, status = ? WHERE id = ?',
        [now, lat, lng, address, deviceName, 'app', 'present', existing[0].id]
      );
      try {
        await db.query(
          'UPDATE hr_attendance SET device_brand = ?, device_model = ?, device_os = ?, device_ua = ? WHERE id = ?',
          [dev.brand || null, dev.model || null, dev.os || null, dev.ua || null, existing[0].id]
        );
      } catch (_) { /* columns missing — older schema */ }
      return { ok: true, action: 'updated', recordId: existing[0].id, device: dev };
    }
    const id = _genAttendanceId();
    await db.query(
      'INSERT INTO hr_attendance (id, employee_id, attendance_date, clock_in, ' +
      'geo_lat, geo_lng, geo_address_in, device_name, source, status) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, employeeId, today, now, lat, lng, address, deviceName, 'app', 'present']
    );
    try {
      await db.query(
        'UPDATE hr_attendance SET device_brand = ?, device_model = ?, device_os = ?, device_ua = ? WHERE id = ?',
        [dev.brand || null, dev.model || null, dev.os || null, dev.ua || null, id]
      );
    } catch (_) { /* columns missing — older schema */ }
    return { ok: true, action: 'inserted', recordId: id, device: dev };
  } catch (e) {
    console.warn('[attendance] clockIn failed:', e.message);
    return { ok: false, reason: 'db_error', error: e.message };
  }
}

async function clockOut(db, employeeId, opts) {
  if (!employeeId) return { skipped: true, reason: 'no_employee_id' };
  const o = opts || {};
  const lat = (o.lat != null) ? Number(o.lat) : null;
  const lng = (o.lng != null) ? Number(o.lng) : null;
  const address = String(o.address || '').slice(0, 500);
  const dev = _normalizeDevice(o.device);
  const today = _todayDateStr();
  const now = new Date();
  try {
    const [existing] = await db.query(
      'SELECT id, clock_in, clock_out FROM hr_attendance ' +
      'WHERE employee_id = ? AND attendance_date = ? LIMIT 1',
      [employeeId, today]
    );
    if (!existing.length) {
      // No clock-in for today — record one synthetic row so the day
      // isn't lost from the report. status remains 'present'.
      const id = _genAttendanceId();
      await db.query(
        'INSERT INTO hr_attendance (id, employee_id, attendance_date, clock_out, ' +
        'geo_lat_out, geo_lng_out, geo_address_out, source, status) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, employeeId, today, now, lat, lng, address, 'app', 'present']
      );
      try {
        await db.query(
          'UPDATE hr_attendance SET device_brand_out = ?, device_model_out = ?, device_os_out = ?, device_ua_out = ? WHERE id = ?',
          [dev.brand || null, dev.model || null, dev.os || null, dev.ua || null, id]
        );
      } catch (_) {}
      return { ok: true, action: 'inserted_clockout_only', recordId: id, device: dev };
    }
    const row = existing[0];
    if (row.clock_out) {
      return { skipped: true, reason: 'already_clocked_out', recordId: row.id };
    }
    let totalHours = null;
    if (row.clock_in) {
      const diffMs = now.getTime() - new Date(row.clock_in).getTime();
      totalHours = Math.max(0, Math.round((diffMs / 3600000) * 100) / 100);
    }
    await db.query(
      'UPDATE hr_attendance SET clock_out = ?, geo_lat_out = ?, geo_lng_out = ?, ' +
      'geo_address_out = ?, total_hours = ? WHERE id = ?',
      [now, lat, lng, address, totalHours, row.id]
    );
    try {
      await db.query(
        'UPDATE hr_attendance SET device_brand_out = ?, device_model_out = ?, device_os_out = ?, device_ua_out = ? WHERE id = ?',
        [dev.brand || null, dev.model || null, dev.os || null, dev.ua || null, row.id]
      );
    } catch (_) {}
    return { ok: true, action: 'updated', recordId: row.id, totalHours, device: dev };
  } catch (e) {
    console.warn('[attendance] clockOut failed:', e.message);
    return { ok: false, reason: 'db_error', error: e.message };
  }
}

module.exports = { clockIn, clockOut };
