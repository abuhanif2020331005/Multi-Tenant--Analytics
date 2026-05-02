const express = require('express');
const Joi = require('joi');
const crypto = require('crypto');

const router = express.Router();

const createTenantSchema = Joi.object({
  name: Joi.string().trim().min(2).max(255).required(),
  slug: Joi.string().trim().lowercase().min(2).max(100).required(),
  plan: Joi.string().valid('free', 'pro', 'enterprise').default('free'),
  settings: Joi.object().default({}),
});

const updateTenantSchema = Joi.object({
  name: Joi.string().trim().min(2).max(255).optional(),
  plan: Joi.string().valid('free', 'pro', 'enterprise').optional(),
  status: Joi.string().valid('active', 'suspended', 'inactive').optional(),
  settings: Joi.object().optional(),
});

function generateApiKey(slug) {
  const random = crypto.randomBytes(8).toString('hex');
  return `${slug}_api_key_${random}`;
}

module.exports = (pool) => {
  // List all tenants (admin only)
  router.get('/', async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT id, name, slug, plan, status, created_at, updated_at
         FROM tenants
         ORDER BY created_at DESC`
      );
      res.json({ tenants: result.rows });
    } catch (error) {
      res.status(500).json({ error: 'Failed to list tenants' });
    }
  });

  // Get single tenant
  router.get('/:id', async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT id, name, slug, api_key, plan, status, settings, created_at, updated_at
         FROM tenants
         WHERE id = $1`,
        [req.params.id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Tenant not found' });
      }

      res.json(result.rows[0]);
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch tenant' });
    }
  });

  // Create tenant (admin only)
  router.post('/', async (req, res) => {
    try {
      const { error, value } = createTenantSchema.validate(req.body);
      if (error) {
        return res.status(400).json({ error: error.details[0].message });
      }

      const apiKey = generateApiKey(value.slug);
      const result = await pool.query(
        `INSERT INTO tenants (name, slug, api_key, plan, settings)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, slug, api_key, plan, status, created_at`,
        [value.name, value.slug, apiKey, value.plan, JSON.stringify(value.settings)]
      );

      res.status(201).json(result.rows[0]);
    } catch (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'Tenant slug already exists' });
      }
      res.status(500).json({ error: 'Failed to create tenant' });
    }
  });

  // Update tenant (admin only)
  router.patch('/:id', async (req, res) => {
    try {
      const { error, value } = updateTenantSchema.validate(req.body);
      if (error) {
        return res.status(400).json({ error: error.details[0].message });
      }

      const updates = [];
      const params = [req.params.id];

      if (value.name) {
        params.push(value.name);
        updates.push(`name = $${params.length}`);
      }
      if (value.plan) {
        params.push(value.plan);
        updates.push(`plan = $${params.length}`);
      }
      if (value.status) {
        params.push(value.status);
        updates.push(`status = $${params.length}`);
      }
      if (value.settings) {
        params.push(JSON.stringify(value.settings));
        updates.push(`settings = $${params.length}`);
      }

      if (updates.length === 0) {
        return res.status(400).json({ error: 'No fields to update' });
      }

      updates.push('updated_at = NOW()');
      const result = await pool.query(
        `UPDATE tenants SET ${updates.join(', ')}
         WHERE id = $1
         RETURNING id, name, slug, plan, status, settings, updated_at`,
        params
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Tenant not found' });
      }

      res.json(result.rows[0]);
    } catch (error) {
      res.status(500).json({ error: 'Failed to update tenant' });
    }
  });

  return router;
};
