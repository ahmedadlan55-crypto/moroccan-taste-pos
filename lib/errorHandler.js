/**
 * Centralized Error Handler — Enterprise Standard
 * Consistent error responses across all endpoints
 */

/**
 * Express error handling middleware — add as LAST middleware
 */
function errorHandler(err, req, res, next) {
  // Determine status code
  var status = err.status || err.statusCode || 500;

  // Log error (structured)
  var logEntry = {
    timestamp: new Date().toISOString(),
    method: req.method,
    path: req.originalUrl,
    status: status,
    message: err.message,
    user: req.user ? req.user.username : 'anonymous',
    ip: req.ip || req.headers['x-forwarded-for'] || ''
  };

  // Only log stack trace for 500 errors
  if (status >= 500) {
    logEntry.stack = err.stack;
    process.stderr.write('[ERROR] ' + JSON.stringify(logEntry) + '\n');
  }

  // Send standardized response
  res.status(status).json({
    success: false,
    error: status >= 500 ? 'خطأ داخلي في الخادم' : err.message,
    code: err.code || 'UNKNOWN_ERROR',
    timestamp: new Date().toISOString()
  });
}

/**
 * 404 handler for unmatched API routes
 */
function notFoundHandler(req, res) {
  res.status(404).json({
    success: false,
    error: 'المسار غير موجود: ' + req.method + ' ' + req.originalUrl,
    code: 'NOT_FOUND'
  });
}

/**
 * Async route wrapper — catches unhandled promise rejections
 * Usage: router.get('/path', asyncWrap(async (req, res) => { ... }))
 */
function asyncWrap(fn) {
  return function(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { errorHandler, notFoundHandler, asyncWrap };
