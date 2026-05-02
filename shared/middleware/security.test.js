const {
  createSecurityHeadersMiddleware,
  createTenantIsolationMiddleware,
  createInjectionScanMiddleware,
  redactSensitive,
  containsSqlInjection,
} = require('./security');

// Minimal Express-like mock
function mockReqRes(overrides = {}) {
  const headers = {};
  const res = {
    setHeader: (k, v) => { headers[k] = v; },
    removeHeader: (k) => { delete headers[k]; },
    getHeaders: () => headers,
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
    ...overrides.res,
  };
  const req = {
    headers: {},
    params: {},
    query: {},
    body: {},
    user: null,
    ...overrides.req,
  };
  const next = jest.fn();
  return { req, res, next, headers };
}

describe('createSecurityHeadersMiddleware', () => {
  it('sets HSTS, X-Frame-Options, X-Content-Type-Options', () => {
    const { req, res, next, headers } = mockReqRes();
    createSecurityHeadersMiddleware()(req, res, next);
    expect(headers['Strict-Transport-Security']).toMatch(/max-age=/);
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(next).toHaveBeenCalled();
  });

  it('sets Permissions-Policy', () => {
    const { req, res, next, headers } = mockReqRes();
    createSecurityHeadersMiddleware()(req, res, next);
    expect(headers['Permissions-Policy']).toContain('camera=()');
  });
});

describe('createTenantIsolationMiddleware', () => {
  it('passes when no tenantId param', () => {
    const { req, res, next } = mockReqRes({ req: { user: { tenantId: 'abc' }, params: {} } });
    createTenantIsolationMiddleware()(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('passes when tenantId matches user', () => {
    const { req, res, next } = mockReqRes({ req: { user: { tenantId: 'abc' }, params: { tenantId: 'abc' } } });
    createTenantIsolationMiddleware()(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('blocks when tenantId mismatches', () => {
    const { req, res, next } = mockReqRes({ req: { user: { tenantId: 'abc' }, params: { tenantId: 'xyz' } } });
    createTenantIsolationMiddleware()(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('createInjectionScanMiddleware', () => {
  it('calls next for clean input', () => {
    const { req, res, next } = mockReqRes({ req: { query: { q: 'hiking jacket' }, body: {} } });
    createInjectionScanMiddleware()(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('blocks SQL injection in query params', () => {
    const { req, res, next } = mockReqRes({ req: { query: { q: "' OR 1=1 --" }, body: {} } });
    createInjectionScanMiddleware()(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('blocks SQL injection in body', () => {
    const { req, res, next } = mockReqRes({ req: { query: {}, body: { name: 'DROP TABLE users' } } });
    createInjectionScanMiddleware()(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('redactSensitive', () => {
  it('redacts password and token fields', () => {
    const result = redactSensitive({ email: 'a@b.com', password: 'secret', token: 'abc' });
    expect(result.email).toBe('a@b.com');
    expect(result.password).toBe('[REDACTED]');
    expect(result.token).toBe('[REDACTED]');
  });

  it('handles nested objects', () => {
    const result = redactSensitive({ user: { apiKey: 'key123', name: 'Alice' } });
    expect(result.user.apiKey).toBe('[REDACTED]');
    expect(result.user.name).toBe('Alice');
  });

  it('handles arrays', () => {
    const result = redactSensitive([{ password: 'x' }, { name: 'y' }]);
    expect(result[0].password).toBe('[REDACTED]');
    expect(result[1].name).toBe('y');
  });
});

describe('containsSqlInjection', () => {
  it('detects DROP TABLE', () => expect(containsSqlInjection('DROP TABLE users')).toBe(true));
  it('detects UNION SELECT', () => expect(containsSqlInjection("' UNION SELECT * FROM users--")).toBe(true));
  it('detects comment injection', () => expect(containsSqlInjection('value -- comment')).toBe(true));
  it('passes clean strings', () => expect(containsSqlInjection('waterproof hiking jacket')).toBe(false));
  it('returns false for non-strings', () => expect(containsSqlInjection(42)).toBe(false));
});
