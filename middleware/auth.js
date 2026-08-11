const { getAuth } = require('../config/firebase');

// Verify Firebase ID token from Authorization header
async function authenticateToken(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Unauthorised', message: 'No token provided.' });
  }

  try {
    const decoded = await getAuth().verifyIdToken(token);
    req.user = decoded;   // { uid, email, role (custom claim), ... }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorised', message: 'Invalid or expired token.' });
  }
}

// Check that the authenticated user has one of the required roles
function requireRole(...roles) {
  return (req, res, next) => {
    const userRole = req.user?.role || req.user?.['kerich_role'];
    if (!userRole || !roles.includes(userRole)) {
      return res.status(403).json({
        error: 'Forbidden',
        message: `This action requires one of: ${roles.join(', ')}`,
      });
    }
    next();
  };
}

module.exports = { authenticateToken, requireRole };
