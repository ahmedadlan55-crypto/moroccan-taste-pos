/**
 * Audit Logger — Enterprise Audit Trail
 * Logs all sensitive operations to audit_logs table
 */
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
          path: req.originalUrl,
          body: safeBody
        }, ip);
      }

      return originalJson(data);
    };
    next();
  };
}

module.exports = { logAudit, auditMiddleware };
