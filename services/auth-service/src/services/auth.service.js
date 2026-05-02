const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const pool = require('../config/database');
const {
  durationToMs,
  durationToSeconds,
} = require('../../../../shared/utils/duration');

const ACCESS_TOKEN_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h';
const REFRESH_TOKEN_EXPIRES_IN = process.env.REFRESH_TOKEN_EXPIRES_IN || '7d';
const ACCESS_TOKEN_TTL_SECONDS = durationToSeconds(ACCESS_TOKEN_EXPIRES_IN, 3600);

class AuthService {
  async login({ email, password, tenantSlug }) {
    const result = await pool.query(
      `SELECT
         u.id,
         u.tenant_id,
         u.email,
         u.password_hash,
         u.first_name,
         u.last_name,
         u.role,
         u.is_active,
         t.slug AS tenant_slug
       FROM users u
       JOIN tenants t ON t.id = u.tenant_id
       WHERE u.email = $1
         AND ($2::text IS NULL OR t.slug = $2)`,
      [email, tenantSlug || null]
    );

    if (result.rows.length === 0) {
      throw new Error('Invalid credentials');
    }

    if (!tenantSlug && result.rows.length > 1) {
      const error = new Error('Multiple tenants found for this email. Provide tenantSlug.');
      error.status = 400;
      throw error;
    }

    const user = { ...result.rows[0] }; // shallow copy to avoid mutating mock data
    const isValidPassword = await bcrypt.compare(password, user.password_hash);

    if (!isValidPassword) {
      throw new Error('Invalid credentials');
    }

    if (!user.is_active) {
      throw new Error('Account is inactive');
    }

    const accessToken = this.generateAccessToken(user);
    const refreshToken = await this.generateRefreshToken(user);

    await pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

    delete user.password_hash;

    return {
      accessToken,
      refreshToken,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      user,
    };
  }

  generateAccessToken(user) {
    return jwt.sign(
      {
        userId: user.id,
        tenantId: user.tenant_id,
        tenantSlug: user.tenant_slug,
        email: user.email,
        role: user.role,
      },
      process.env.JWT_SECRET,
      { expiresIn: ACCESS_TOKEN_EXPIRES_IN }
    );
  }

  async generateRefreshToken(user) {
    const refreshToken = uuidv4();
    const expiresAt = new Date(
      Date.now() + durationToMs(REFRESH_TOKEN_EXPIRES_IN, 7 * 24 * 60 * 60 * 1000)
    );

    await pool.query(
      `INSERT INTO refresh_tokens (user_id, token, expires_at)
       VALUES ($1, $2, $3)`,
      [user.id, refreshToken, expiresAt]
    );

    return refreshToken;
  }

  async refreshAccessToken(refreshToken) {
    const result = await pool.query(
      `SELECT
         rt.id AS token_id,
         rt.user_id,
         u.tenant_id,
         u.email,
         u.role,
         u.is_active,
         t.slug AS tenant_slug
       FROM refresh_tokens rt
       JOIN users u ON rt.user_id = u.id
       JOIN tenants t ON t.id = u.tenant_id
       WHERE rt.token = $1 AND rt.expires_at > NOW()`,
      [refreshToken]
    );

    if (result.rows.length === 0) {
      throw new Error('Invalid refresh token');
    }

    const user = result.rows[0];

    if (!user.is_active) {
      throw new Error('Account is inactive');
    }

    // Rotate: delete old token and issue a new one
    await pool.query('DELETE FROM refresh_tokens WHERE id = $1', [user.token_id]);
    const newRefreshToken = await this.generateRefreshToken({ id: user.user_id });

    const accessToken = this.generateAccessToken({
      id: user.user_id,
      tenant_id: user.tenant_id,
      tenant_slug: user.tenant_slug,
      email: user.email,
      role: user.role,
    });

    return { accessToken, refreshToken: newRefreshToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
  }

  async logout(refreshToken) {
    await pool.query('DELETE FROM refresh_tokens WHERE token = $1', [refreshToken]);
  }

  async register({ email, password, firstName, lastName, tenantSlug }) {
    // Verify tenant exists and is active
    const tenantResult = await pool.query(
      `SELECT id, slug, status FROM tenants WHERE slug = $1`,
      [tenantSlug]
    );

    if (tenantResult.rows.length === 0) {
      const err = new Error('Tenant not found');
      err.status = 404;
      throw err;
    }

    const tenant = tenantResult.rows[0];
    if (tenant.status !== 'active') {
      const err = new Error('Tenant is not active');
      err.status = 403;
      throw err;
    }

    // Check email uniqueness within tenant
    const existing = await pool.query(
      'SELECT id FROM users WHERE email = $1 AND tenant_id = $2',
      [email, tenant.id]
    );

    if (existing.rows.length > 0) {
      const err = new Error('Email already registered in this tenant');
      err.status = 409;
      throw err;
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (tenant_id, email, password_hash, first_name, last_name, role)
       VALUES ($1, $2, $3, $4, $5, 'viewer')
       RETURNING id, tenant_id, email, first_name, last_name, role, created_at`,
      [tenant.id, email, passwordHash, firstName || null, lastName || null]
    );

    const user = result.rows[0];
    const accessToken = this.generateAccessToken({
      id: user.id,
      tenant_id: user.tenant_id,
      tenant_slug: tenantSlug,
      email: user.email,
      role: user.role,
    });
    const refreshToken = await this.generateRefreshToken({ id: user.id });

    return {
      accessToken,
      refreshToken,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      user: { ...user, tenant_slug: tenantSlug },
    };
  }

  async validateToken(token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      return decoded;
    } catch (error) {
      throw new Error('Invalid token');
    }
  }
}

module.exports = new AuthService();
