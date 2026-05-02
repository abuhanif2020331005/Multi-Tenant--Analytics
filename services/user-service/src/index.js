require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const { createPgPool } = require('../../../shared/config/database');
const { validateEnv } = require('../../../shared/config/env');
const { createRequestContextMiddleware } = require('../../../shared/middleware/request-context');
const { authenticateRequest, requireRoles } = require('../../../shared/middleware/auth');
const { createLogger, serializeError } = require('../../../shared/observability/logger');
const { createTracer } = require('../../../shared/observability/tracer');
const {
  createMetricsStore,
  createExpressMetricsMiddleware,
  createMetricsHandler,
  createPrometheusMetricsHandler,
  createTracingMiddleware,
} = require('../../../shared/observability/http');
const { createSecurityHeadersMiddleware, createInjectionScanMiddleware } = require('../../../shared/middleware/security');
const createUserRoutes = require('./routes/user.routes');
const createTenantRoutes = require('./routes/tenant.routes');

validateEnv('user-service', ['PORT', 'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'JWT_SECRET']);

const app = express();
const PORT = process.env.PORT || 8002;
const pool = createPgPool(Pool, 'user-service');
const authMiddleware = authenticateRequest(jwt);
const adminMiddleware = requireRoles(['admin']);
const adminOrAnalystMiddleware = requireRoles(['admin', 'analyst']);
const metrics = createMetricsStore('user-service');
const logger = createLogger('user-service');
const tracer = createTracer('user-service');

app.use(helmet());
app.use(morgan('combined'));
app.use(cors());
app.use(express.json());
app.use(createSecurityHeadersMiddleware());
app.use(createInjectionScanMiddleware());
app.use(createRequestContextMiddleware('user-service', logger));
app.use(createTracingMiddleware(tracer));
app.use(createExpressMetricsMiddleware(metrics));

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'user-service', timestamp: new Date().toISOString() });
});

app.get('/metrics', createMetricsHandler(metrics));
app.get('/metrics/prometheus', createPrometheusMetricsHandler(metrics));

// User routes (CRUD + password change)
app.use('/users', createUserRoutes(pool, authMiddleware, adminOrAnalystMiddleware));

// Tenant management routes (admin only)
app.use('/tenants', authMiddleware, adminMiddleware, createTenantRoutes(pool));

app.use((err, req, res, next) => {
  logger.error('request_failed', {
    requestId: req.context?.requestId || null,
    path: req.originalUrl,
    method: req.method,
    error: serializeError(err),
  });
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  logger.info('service_started', { port: Number(PORT) });
});
