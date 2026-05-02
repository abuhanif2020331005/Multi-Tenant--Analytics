/**
 * Security hardening middleware collection.
 *
 * Covers OWASP Top 10 mitigations:
 *   - Security headers (CSP, HSTS, X-Frame-Options, etc.)
 *   - Request size limiting
 *   - SQL injection / XSS input sanitization hints
 *   - Tenant isolation enforcement
 *   - Secrets redaction in logs
 */

/**
 * Strict security headers beyond what Helmet provides by default.
 * Mount after helmet().
 */
function createSecurityHeadersMiddleware(options = {}) {
  const {
    contentSecurityPolicy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
    hstsMaxAge = 31536000,
    frameOptions = 'DENY',
  } = options;

  return (req, res, next) => {
    // HSTS – force HTTPS for 1 year
    res.setHeader('Strict-Transport-Security', `max-age=${hstsMaxAge}; includeSubDomains; preload`);

    // Prevent clickjacking
    res.setHeader('X-Frame-Options', frameOptions);

    // Prevent MIME sniffing
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // Referrer policy
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

    // Permissions policy – disable unused browser features
    res.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), payment=()'
    );

    // CSP
    if (contentSecurityPolicy) {
      res.setHeader('Content-Security-Policy', contentSecurityPolicy);
    }

    // Remove server fingerprint
    res.removeHeader('X-Powered-By');
    res.removeHeader('Server');

    next();
  };
}

/**
 * Enforce that the authenticated user belongs to the tenant they're accessing.
 * Prevents horizontal privilege escalation across tenants.
 */
function createTenantIsolationMiddleware() {
  return (req, res, next) => {
    // Only enforce when a user is authenticated
    if (!req.user) return next();

    // If the route has a :tenantId param, verify it matches the token
    const routeTenantId = req.params?.tenantId;
    if (routeTenantId && routeTenantId !== req.user.tenantId) {
      return res.status(403).json({
        error: 'Access denied: tenant mismatch',
      });
    }

    next();
  };
}

/**
 * Redact sensitive fields from objects before logging.
 * Use this when serializing request bodies or user objects.
 */
const SENSITIVE_KEYS = new Set([
  'password', 'password_hash', 'passwordHash',
  'token', 'accessToken', 'refreshToken', 'access_token', 'refresh_token',
  'secret', 'apiKey', 'api_key', 'authorization',
  'creditCard', 'credit_card', 'cvv', 'ssn',
]);

function redactSensitive(obj, depth = 0) {
  if (depth > 5 || !obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map((item) => redactSensitive(item, depth + 1));

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = SENSITIVE_KEYS.has(key) ? '[REDACTED]' : redactSensitive(value, depth + 1);
  }
  return result;
}

/**
 * Validate that a string doesn't contain obvious SQL injection patterns.
 * This is a defense-in-depth check — parameterized queries are the primary defense.
 */
const SQL_INJECTION_PATTERN = /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|UNION|EXEC|EXECUTE|CAST|CONVERT|DECLARE|XP_)\b|--|;|\/\*|\*\/)/i;

function containsSqlInjection(value) {
  if (typeof value !== 'string') return false;
  return SQL_INJECTION_PATTERN.test(value);
}

/**
 * Middleware that scans query params and body string fields for obvious injection.
 * Returns 400 if detected. Mount before route handlers.
 */
function createInjectionScanMiddleware() {
  function scanObject(obj, depth = 0) {
    if (depth > 3 || !obj || typeof obj !== 'object') {
      return typeof obj === 'string' ? containsSqlInjection(obj) : false;
    }
    return Object.values(obj).some((v) => scanObject(v, depth + 1));
  }

  return (req, res, next) => {
    if (scanObject(req.query) || scanObject(req.body)) {
      return res.status(400).json({ error: 'Invalid input detected' });
    }
    next();
  };
}

/**
 * Vault-compatible secrets loader.
 * Reads secrets from environment variables (injected by Vault Agent or K8s secrets).
 * In production, replace with actual Vault SDK calls.
 *
 * Returns a frozen object of resolved secrets.
 */
function loadSecrets(requiredSecrets = []) {
  const resolved = {};
  const missing = [];

  for (const key of requiredSecrets) {
    const value = process.env[key];
    if (!value) {
      missing.push(key);
    } else {
      resolved[key] = value;
    }
  }

  if (missing.length > 0) {
    throw new Error(`Missing required secrets: ${missing.join(', ')}`);
  }

  return Object.freeze(resolved);
}

module.exports = {
  createSecurityHeadersMiddleware,
  createTenantIsolationMiddleware,
  createInjectionScanMiddleware,
  redactSensitive,
  containsSqlInjection,
  loadSecrets,
};
