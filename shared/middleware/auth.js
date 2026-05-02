function authenticateRequest(jwt) {
  return (req, res, next) => {
    try {
      const authHeader = req.headers.authorization;

      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing or invalid token' });
      }

      const token = authHeader.substring(7);
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      req.user = decoded;
      next();
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Token expired' });
      }

      return res.status(401).json({ error: 'Invalid token' });
    }
  };
}

function requireRoles(allowedRoles) {
  const normalizedRoles = new Set(
    (Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles])
      .filter(Boolean)
      .map((role) => String(role).trim().toLowerCase())
  );

  return (req, res, next) => {
    const currentRole = String(req.user?.role || '')
      .trim()
      .toLowerCase();

    if (!currentRole) {
      return res.status(403).json({ error: 'Missing user role' });
    }

    if (!normalizedRoles.has(currentRole)) {
      return res.status(403).json({
        error: 'Insufficient role permissions',
        requiredRoles: Array.from(normalizedRoles),
      });
    }

    next();
  };
}

module.exports = { authenticateRequest, requireRoles };
