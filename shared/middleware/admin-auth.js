const crypto = require('crypto');

function extractAdminToken(req) {
  const headerToken = req.headers?.['x-admin-token'];
  if (typeof headerToken === 'string' && headerToken.trim()) {
    return headerToken.trim();
  }

  const authorization = req.headers?.authorization;
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    return authorization.slice(7).trim();
  }

  return null;
}

function isAdminAuthorized(req, expectedToken = process.env.ADMIN_API_TOKEN) {
  if (!expectedToken) {
    return true;
  }

  const providedToken = extractAdminToken(req);
  if (!providedToken) {
    return false;
  }

  const expected = Buffer.from(String(expectedToken));
  const provided = Buffer.from(String(providedToken));
  return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
}

function sendAdminUnauthorized(res) {
  res.statusCode = 401;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ error: 'Missing or invalid admin token' }));
}

function requireAdminToken(req, res, next) {
  if (!isAdminAuthorized(req)) {
    return res.status(401).json({ error: 'Missing or invalid admin token' });
  }

  return next();
}

module.exports = {
  extractAdminToken,
  isAdminAuthorized,
  requireAdminToken,
  sendAdminUnauthorized,
};
