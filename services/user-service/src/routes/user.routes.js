const express = require('express');
const Joi = require('joi');
const bcrypt = require('bcryptjs');

const router = express.Router();

const createUserSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(8).required(),
  firstName: Joi.string().trim().max(100).optional(),
  lastName: Joi.string().trim().max(100).optional(),
  role: Joi.string().valid('admin', 'analyst', 'viewer').default('viewer'),
});

const updateUserSchema = Joi.object({
  firstName: Joi.string().trim().max(100).optional(),
  lastName: Joi.string().trim().max(100).optional(),
  role: Joi.string().valid('admin', 'analyst', 'viewer').optional(),
  isActive: Joi.boolean().optional(),
});

const changePasswordSchema = Joi.object({
  currentPassword: Joi.string().required(),
  newPassword: Joi.string().min(8).required(),
});

module.exports = (pool, authMiddleware, adminMiddleware) => {
  // GET /users/me
  router.get('/me', authMiddleware, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT id, tenant_id, email, first_name, last_name, role, is_active, last_login, created_at
         FROM users WHERE id = $1 AND tenant_id = $2`,
        [req.user.userId, req.user.tenantId]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
      res.json(result.rows[0]);
    } catch {
      res.status(500).json({ error: 'Failed to fetch user' });
    }
  });

  // GET /users — list all users in tenant (admin/analyst)
  router.get('/', authMiddleware, adminMiddleware, async (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit || 100), 200);
      const offset = Number(req.query.offset || 0);

      const [result, countResult] = await Promise.all([
        pool.query(
          `SELECT id, tenant_id, email, first_name, last_name, role, is_active, last_login, created_at
           FROM users WHERE tenant_id = $1
           ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
          [req.user.tenantId, limit, offset]
        ),
        pool.query('SELECT COUNT(*) FROM users WHERE tenant_id = $1', [req.user.tenantId]),
      ]);

      res.json({ users: result.rows, total: Number(countResult.rows[0].count), limit, offset });
    } catch {
      res.status(500).json({ error: 'Failed to list users' });
    }
  });

  // GET /users/:id
  router.get('/:id', authMiddleware, adminMiddleware, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT id, tenant_id, email, first_name, last_name, role, is_active, last_login, created_at
         FROM users WHERE id = $1 AND tenant_id = $2`,
        [req.params.id, req.user.tenantId]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
      res.json(result.rows[0]);
    } catch {
      res.status(500).json({ error: 'Failed to fetch user' });
    }
  });

  // POST /users — create user in tenant (admin only)
  router.post('/', authMiddleware, adminMiddleware, async (req, res) => {
    try {
      const { error, value } = createUserSchema.validate(req.body);
      if (error) return res.status(400).json({ error: error.details[0].message });

      const passwordHash = await bcrypt.hash(value.password, 10);
      const result = await pool.query(
        `INSERT INTO users (tenant_id, email, password_hash, first_name, last_name, role)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, tenant_id, email, first_name, last_name, role, is_active, created_at`,
        [req.user.tenantId, value.email, passwordHash, value.firstName || null, value.lastName || null, value.role]
      );

      res.status(201).json(result.rows[0]);
    } catch (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'Email already exists in this tenant' });
      res.status(500).json({ error: 'Failed to create user' });
    }
  });

  // PATCH /users/:id — update role/status (admin only)
  router.patch('/:id', authMiddleware, adminMiddleware, async (req, res) => {
    try {
      const { error, value } = updateUserSchema.validate(req.body);
      if (error) return res.status(400).json({ error: error.details[0].message });

      const updates = [];
      const params = [req.params.id, req.user.tenantId];

      if (value.firstName !== undefined) { params.push(value.firstName); updates.push(`first_name = $${params.length}`); }
      if (value.lastName !== undefined) { params.push(value.lastName); updates.push(`last_name = $${params.length}`); }
      if (value.role !== undefined) { params.push(value.role); updates.push(`role = $${params.length}`); }
      if (value.isActive !== undefined) { params.push(value.isActive); updates.push(`is_active = $${params.length}`); }

      if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
      updates.push('updated_at = NOW()');

      const result = await pool.query(
        `UPDATE users SET ${updates.join(', ')}
         WHERE id = $1 AND tenant_id = $2
         RETURNING id, email, first_name, last_name, role, is_active, updated_at`,
        params
      );

      if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
      res.json(result.rows[0]);
    } catch {
      res.status(500).json({ error: 'Failed to update user' });
    }
  });

  // POST /users/me/change-password
  router.post('/me/change-password', authMiddleware, async (req, res) => {
    try {
      const { error, value } = changePasswordSchema.validate(req.body);
      if (error) return res.status(400).json({ error: error.details[0].message });

      const result = await pool.query(
        'SELECT password_hash FROM users WHERE id = $1 AND tenant_id = $2',
        [req.user.userId, req.user.tenantId]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });

      const valid = await bcrypt.compare(value.currentPassword, result.rows[0].password_hash);
      if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

      const newHash = await bcrypt.hash(value.newPassword, 10);
      await pool.query(
        'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
        [newHash, req.user.userId]
      );

      res.json({ message: 'Password changed successfully' });
    } catch {
      res.status(500).json({ error: 'Failed to change password' });
    }
  });

  return router;
};
