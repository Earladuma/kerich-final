const { getDb } = require('../config/firebase');

function errorHandler(err, req, res, next) {
  const status  = err.status || err.statusCode || 500;
  const message = err.message || 'Internal server error';

  // Log to Firestore audit trail for 5xx errors
  if (status >= 500) {
    console.error('[ERROR]', err);
    try {
      const db = getDb();
      if (db) {
        db.collection('error_logs').add({
          message,
          stack:     err.stack,
          path:      req.path,
          method:    req.method,
          userId:    req.user?.uid || null,
          timestamp: new Date().toISOString(),
        }).catch(() => {});
      }
    } catch {}
  }

  res.status(status).json({
    error:   status >= 500 ? 'Internal Server Error' : message,
    message: process.env.NODE_ENV === 'production' && status >= 500
      ? 'Something went wrong. Please try again.'
      : message,
  });
}

module.exports = { errorHandler };
