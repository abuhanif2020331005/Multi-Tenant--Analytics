require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const corsMiddleware = require('./middleware/cors');
const authRoutes = require('./routes/auth.routes');
const { createAuthGrpcServer } = require('./grpc-server');
const { validateEnv } = require('../../../shared/config/env');
const { createRequestContextMiddleware } = require('../../../shared/middleware/request-context');
const { createSecurityHeadersMiddleware, createInjectionScanMiddleware } = require('../../../shared/middleware/security');
const { createLogger, serializeError } = require('../../../shared/observability/logger');
const {
  createMetricsStore,
  createExpressMetricsMiddleware,
  createMetricsHandler,
  createPrometheusMetricsHandler,
} = require('../../../shared/observability/http');

validateEnv('auth-service', [
  'PORT',
  'DB_HOST',
  'DB_PORT',
  'DB_USER',
  'DB_PASSWORD',
  'DB_NAME',
  'JWT_SECRET',
  'JWT_EXPIRES_IN',
  'REFRESH_TOKEN_EXPIRES_IN',
]);

const app = express();
const PORT = process.env.PORT || 8001;
const metrics = createMetricsStore('auth-service');
const logger = createLogger('auth-service');

app.use(helmet());
app.use(morgan('combined'));
app.use(corsMiddleware);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(createSecurityHeadersMiddleware());
app.use(createInjectionScanMiddleware());
app.use(createRequestContextMiddleware('auth-service', logger));
app.use(createExpressMetricsMiddleware(metrics));

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'auth-service',
    timestamp: new Date().toISOString(),
  });
});

app.get('/metrics', createMetricsHandler(metrics));
app.get('/metrics/prometheus', createPrometheusMetricsHandler(metrics));

app.use('/auth', authRoutes);

app.use((err, req, res, next) => {
  logger.error('request_failed', {
    requestId: req.context?.requestId || null,
    path: req.originalUrl,
    method: req.method,
    error: serializeError(err),
  });
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
  });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

app.listen(PORT, () => {
  logger.info('service_started', { port: Number(PORT) });
});

// Start gRPC server alongside HTTP
const grpcServer = createAuthGrpcServer(logger);
grpcServer.start().catch((err) => {
  logger.error('grpc_server_start_failed', { error: err.message });
});

process.on('SIGTERM', async () => {
  logger.info('service_stopping', { signal: 'SIGTERM' });
  await grpcServer.stop();
  process.exit(0);
});
