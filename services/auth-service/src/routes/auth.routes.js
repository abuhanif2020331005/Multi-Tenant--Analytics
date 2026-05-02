const express = require('express');
const Joi = require('joi');
const authService = require('../services/auth.service');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

const loginSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(6).required(),
  tenantSlug: Joi.string().trim().lowercase().optional(),
});

const registerSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(8).required(),
  firstName: Joi.string().trim().max(100).optional(),
  lastName: Joi.string().trim().max(100).optional(),
  tenantSlug: Joi.string().trim().lowercase().required(),
  inviteToken: Joi.string().optional(), // reserved for future invite flow
});

const refreshSchema = Joi.object({
  refreshToken: Joi.string().required(),
});

router.post('/register', async (req, res) => {
  try {
    const { error, value } = registerSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    const result = await authService.register(value);
    res.status(201).json(result);
  } catch (error) {
    const status = error.status || (error.message.includes('already') ? 409 : 400);
    res.status(status).json({ error: error.message });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { error, value } = loginSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    const result = await authService.login(value);
    res.json(result);
  } catch (error) {
    console.error('Login error:', error);
    res.status(error.status || 401).json({ error: error.message });
  }
});

router.post('/refresh', async (req, res) => {
  try {
    const { error, value } = refreshSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    const result = await authService.refreshAccessToken(value.refreshToken);
    res.json(result);
  } catch (error) {
    console.error('Refresh error:', error);
    res.status(401).json({ error: error.message });
  }
});

router.post('/logout', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ error: 'Refresh token required' });
    }

    await authService.logout(refreshToken);
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Logout failed' });
  }
});

router.get('/validate', authMiddleware, async (req, res) => {
  res.json({ valid: true, user: req.user });
});

router.get('/openapi', (req, res) => {
  res.json({
    openapi: '3.0.0',
    info: {
      title: 'Auth Service API',
      version: '1.0.0',
      description: 'Authentication and authorization service',
    },
    paths: {
      '/auth/login': {
        post: {
          summary: 'User login',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['email', 'password'],
                  properties: {
                    email: { type: 'string', format: 'email' },
                    password: { type: 'string', minLength: 6 },
                    tenantSlug: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Successful login',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      accessToken: { type: 'string' },
                      refreshToken: { type: 'string' },
                      expiresIn: { type: 'integer' },
                      user: { type: 'object' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
});

module.exports = router;
