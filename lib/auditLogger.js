/**
 * Audit Logger — Enterprise Audit Trail
 * Logs all sensitive operations to audit_logs table.
 *
 * v6.2.0 Wave F.4 — adds tamper-evident hash chain to the `audit_log`
 * table (the one used by /api/auth and /api/erp middlewares). Each new
 * row's record_hash = SHA-256(prev_hash || canonical(this_row)). The
 * verify endpoint walks the chain and detects any row where the stored
 * record_hash differs from the recomputed one.
 *
 * audit_logs (with the 's') keeps its existing behaviour for back-compat;
 * the new chain only applies to writes that route through appendAuditEntry().
 */
const crypto = require('crypto');
const db = require('../db/connection');

/**
 * Log an audit event
 * @param {string} action - Action performed (CREATE, UPDATE, DELETE, APPROVE, etc.)
 * @param {string} entityType - Entity type (sale, employee, gl_journal, attendance, etc.)
 * @param {string} entityId - Entity ID
 * @param {string} username - Who performed the action
 * @param {object} details - Additional details (before/after values, reason, etc.)
 * @param {string} ipAddress - Client IP
 */
async function logAudit(action, entityType, entityId, username, details, ipAddress) {
  try {
    var id = 'AUD-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4);
    await db.query(
      'INSERT INTO audit_logs (id, action, entity_type, entity_id, username, details, ip_address, created_at) VALUES (?,?,?,?,?,?,?,NOW())',
      [id, action, entityType, entityId || '', username || 'system', JSON.stringify(details || {}), ipAddress || '']
    );
  } catch (e) {
    // Silent fail — audit should never break business operations
    // But log to stderr for monitoring
    if (process.env.NODE_ENV !== 'production') {
      process.stderr.write('[AUDIT ERROR] ' + e.message + '\n');
    }
  }
}

/**
 * Express middleware factory — auto-logs POST/PUT/DELETE operations
 * Attach to specific routes or globally
 */
function auditMiddleware(entityType) {
  return function(req, res, next) {
    // Only audit write operations
    if (req.method === 'GET' || req.method === 'OPTIONS' || req.method === 'HEAD') return next();

    // Capture original res.json to intercept response
    var originalJson = res.json.bind(res);
    res.json = function(data) {
      // Log after response is determined
      var action = req.method === 'DELETE' ? 'DELETE' : (req.method === 'PUT' ? 'UPDATE' : 'CREATE');
      var username = (req.user && req.user.username) || req.body.username || 'unknown';
      var ip = req.ip || req.headers['x-forwarded-for'] || '';
      var entityId = req.params.id || (data && data.id) || '';

      // Determine if operation was successful
      var success = data && (data.success !== false) && (res.statusCode < 400);

      if (success) {
        // Sanitize body — remove passwords and large binary data
        var safeBody = Object.assign({}, req.body);
        delete safeBody.password;
        delete safeBody.fileData;
        delete safeBody.file_data;
        delete safeBody.photo;
        delete safeBody.attachment;
        if (safeBody.entries && safeBody.entries.length > 5) {
          safeBody.entries = safeBody.entries.length + ' items';
        }

        logAudit(action, entityType || 'unknown', entityId, username, {
          method: req.method,
          // scrubUrl: credential-looking query params must never persist in audit rows
          path: require('./urlScrub').scrubUrl(req.originalUrl),
          body: safeBody
        }, ip);
      }

      return originalJson(data);
    };
    next();
  };
}

// ─── v6.2.0 Wave F.4 — Tamper-evident hash chain on audit_log ─────────

function _canonicalAuditRow(row) {
  return JSON.stringify({
    user_id: row.user_id || null,
    username: row.username || '',
    action: row.action || '',
    table_name: row.table_name || '',
    record_id: row.record_id || '',
    ip_address: row.ip_address || '',
    device_info: row.device_info || '',
    created_at: row.created_at instanceof Date
      ? row.created_at.toISOString()
      : (row.created_at || ''),
    before_json: row.before_json || null,
    after_json: row.after_json || null
  });
}

function _computeChainHash(prevHash, row) {
  const prev = prevHash || '0'.repeat(64);
  return crypto.createHash('sha256')
    .update(prev + '|' + _canonicalAuditRow(row), 'utf8')
    .digest('hex');
}

/**
 * Append a new audit_log entry with hash-chain linkage. Should be called
 * INSIDE a transaction; uses SELECT … FOR UPDATE on the latest row to
 * prevent concurrent appends from forking the chain.
 */
async function appendAuditEntry(conn, entry) {
  const c = conn || db;
  const id = entry.id || ('AUD-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
  const row = {
    id,
    user_id: entry.user_id || entry.userId || null,
    username: entry.username || 'system',
    action: entry.action || '',
    table_name: entry.table_name || entry.tableName || '',
    record_id: entry.record_id || entry.recordId || '',
    ip_address: entry.ip_address || entry.ipAddress || '',
    device_info: entry.device_info || entry.deviceInfo || '',
    before_json: entry.before_json || (entry.before ? JSON.stringify(entry.before) : null),
    after_json:  entry.after_json  || (entry.after  ? JSON.stringify(entry.after)  : null)
  };
  // Look up previous hash with lock
  let prevHash = null;
  try {
    const [r] = await c.query(
      'SELECT record_hash FROM audit_log ORDER BY id DESC LIMIT 1 FOR UPDATE'
    );
    if (r.length) prevHash = r[0].record_hash;
  } catch (_) {
    const [r] = await c.query(
      'SELECT record_hash FROM audit_log ORDER BY id DESC LIMIT 1'
    );
    if (r.length) prevHash = r[0].record_hash;
  }
  row.created_at = new Date();
  const myHash = _computeChainHash(prevHash, row);

  // Insert with chain fields. Tolerate older schemas without device_info/etc.
  try {
    await c.query(
      `INSERT INTO audit_log (id, user_id, username, action, table_name, record_id,
                              ip_address, device_info, prev_hash, record_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.user_id, row.username, row.action, row.table_name, row.record_id,
       row.ip_address, row.device_info, prevHash, myHash]
    );
  } catch (e) {
    // Schema may not have all columns — try a minimal insert
    try {
      await c.query(
        `INSERT INTO audit_log (id, username, action, table_name, record_id)
         VALUES (?, ?, ?, ?, ?)`,
        [row.id, row.username, row.action, row.table_name, row.record_id]
      );
    } catch (_) {}
  }
  return { id, recordHash: myHash, prevHash };
}

/**
 * Walk the full audit_log chain and report any row whose stored hash
 * doesn't match the recomputed one. Returns { verified, brokenAt, count }.
 */
async function verifyAuditChain(opts) {
  opts = opts || {};
  const limit = Math.min(Math.max(opts.limit || 1000, 1), 10000);
  const fromId = opts.fromId || 0;
  const [rows] = await db.query(
    'SELECT * FROM audit_log WHERE id > ? ORDER BY id ASC LIMIT ?',
    [fromId, limit]
  );
  let prevHash = null;
  // Backfill prev_hash for the very first row if we're starting fresh
  if (fromId && rows.length) {
    const [first] = await db.query('SELECT record_hash FROM audit_log WHERE id <= ? ORDER BY id DESC LIMIT 1', [fromId]);
    if (first.length) prevHash = first[0].record_hash;
  }
  for (const r of rows) {
    // Skip pre-v6.2.0 rows without a record_hash (chain hasn't started)
    if (!r.record_hash && !r.prev_hash) {
      prevHash = null;
      continue;
    }
    const expected = _computeChainHash(prevHash, r);
    if (r.record_hash && r.record_hash !== expected) {
      return { verified: false, brokenAt: r.id, expected, actual: r.record_hash, count: rows.length };
    }
    prevHash = r.record_hash;
  }
  return { verified: true, count: rows.length };
}

module.exports = { logAudit, auditMiddleware, appendAuditEntry, verifyAuditChain };
