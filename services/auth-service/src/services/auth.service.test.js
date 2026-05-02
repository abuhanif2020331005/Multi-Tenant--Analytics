/**
 * Unit tests for AuthService.
 * Uses manual mocks — no real DB or Redis needed.
 */

// Set required env vars before any module loads
process.env.JWT_SECRET = 'test-secret-for-unit-tests';
process.env.JWT_EXPIRES_IN = '1h';
process.env.REFRESH_TOKEN_EXPIRES_IN = '7d';

jest.mock('../config/database', () => ({
  query: jest.fn(),
}));

const bcrypt = require('bcryptjs');
const pool = require('../config/database');

// Load after mock is set up
const authService = require('./auth.service');

const MOCK_TENANT = { id: 'tenant-uuid', slug: 'acme', status: 'active' };
const MOCK_USER = {
  id: 'user-uuid',
  tenant_id: 'tenant-uuid',
  email: 'admin@acme.com',
  // bcrypt.hashSync('password123', 10) — generated from auth-service's bcryptjs
  password_hash: '$2a$10$O0B7z904lqaATQBbLRsrlOshxqhK.zpaqKMxVsLGQs.3gEPfy2SLu',
  first_name: 'Admin',
  last_name: 'User',
  role: 'admin',
  is_active: true,
  tenant_slug: 'acme',
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('AuthService.login', () => {
  it('returns tokens on valid credentials', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [MOCK_USER] })   // SELECT user
      .mockResolvedValueOnce({ rows: [] })             // UPDATE last_login
      .mockResolvedValueOnce({ rows: [] });            // INSERT refresh_token

    const result = await authService.login({
      email: 'admin@acme.com',
      password: 'password123',
      tenantSlug: 'acme',
    });

    expect(result.accessToken).toBeDefined();
    expect(result.refreshToken).toBeDefined();
    expect(result.user.email).toBe('admin@acme.com');
    expect(result.user.password_hash).toBeUndefined();
  });

  it('throws on wrong password', async () => {
    pool.query.mockResolvedValueOnce({ rows: [MOCK_USER] });

    await expect(
      authService.login({ email: 'admin@acme.com', password: 'wrong', tenantSlug: 'acme' })
    ).rejects.toThrow('Invalid credentials');
  });

  it('throws when user not found', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await expect(
      authService.login({ email: 'nobody@acme.com', password: 'pass', tenantSlug: 'acme' })
    ).rejects.toThrow('Invalid credentials');
  });

  it('throws when account is inactive', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ ...MOCK_USER, is_active: false }], // MOCK_USER already has valid hash
    });

    await expect(
      authService.login({ email: 'admin@acme.com', password: 'password123', tenantSlug: 'acme' })
    ).rejects.toThrow('Account is inactive');
  });
});

describe('AuthService.register', () => {
  it('creates user and returns tokens', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [MOCK_TENANT] })  // SELECT tenant
      .mockResolvedValueOnce({ rows: [] })              // SELECT existing user (none)
      .mockResolvedValueOnce({ rows: [{ id: 'new-uuid', tenant_id: 'tenant-uuid', email: 'new@acme.com', first_name: null, last_name: null, role: 'viewer', created_at: new Date() }] }) // INSERT user
      .mockResolvedValueOnce({ rows: [] });             // INSERT refresh_token

    const result = await authService.register({
      email: 'new@acme.com',
      password: 'securepass123',
      tenantSlug: 'acme',
    });

    expect(result.accessToken).toBeDefined();
    expect(result.user.email).toBe('new@acme.com');
    expect(result.user.role).toBe('viewer');
  });

  it('throws 404 when tenant not found', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await expect(
      authService.register({ email: 'x@x.com', password: 'pass12345', tenantSlug: 'unknown' })
    ).rejects.toThrow('Tenant not found');
  });

  it('throws 409 when email already registered', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [MOCK_TENANT] })
      .mockResolvedValueOnce({ rows: [{ id: 'existing' }] });

    const err = await authService.register({
      email: 'admin@acme.com',
      password: 'pass12345',
      tenantSlug: 'acme',
    }).catch((e) => e);

    expect(err.message).toMatch(/already registered/);
    expect(err.status).toBe(409);
  });
});

describe('AuthService.validateToken', () => {
  it('returns decoded claims for valid token', async () => {
    const token = authService.generateAccessToken(MOCK_USER);
    const decoded = await authService.validateToken(token);
    expect(decoded.email).toBe(MOCK_USER.email);
    expect(decoded.role).toBe(MOCK_USER.role);
  });

  it('throws for invalid token', async () => {
    await expect(authService.validateToken('bad.token.here')).rejects.toThrow('Invalid token');
  });
});

describe('AuthService.logout', () => {
  it('deletes refresh token from DB', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    await authService.logout('some-refresh-token');
    expect(pool.query).toHaveBeenCalledWith(
      'DELETE FROM refresh_tokens WHERE token = $1',
      ['some-refresh-token']
    );
  });
});
