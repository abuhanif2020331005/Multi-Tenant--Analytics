const http = require('http');
const { URL } = require('url');
const { createOptionalRedisClient } = require('../../../shared/cache/redis');
const { createCircuitBreakerRegistry } = require('../../../shared/utils/circuit-breaker');
const { validateEnv } = require('../../../shared/config/env');
const { attachContext } = require('../../../shared/middleware/request-context');
const { createLogger, serializeError } = require('../../../shared/observability/logger');
const {
  createMetricsStore,
  renderPrometheusMetrics,
  trackNodeRequest,
} = require('../../../shared/observability/http');

validateEnv('api-gateway', [
  'PORT',
  'AUTH_SERVICE_URL',
  'USER_SERVICE_URL',
  'ANALYTICS_SERVICE_URL',
  'EVENT_INGESTION_SERVICE_URL',
  'RECOMMENDATION_SERVICE_URL',
  'FRAUD_DETECTION_SERVICE_URL',
  'CATALOG_SERVICE_URL',
]);

const PORT = Number(process.env.PORT || 8000);
const metrics = createMetricsStore('api-gateway');
const logger = createLogger('api-gateway');
const rateLimitWindowMs = Number(process.env.RATE_LIMIT_WINDOW_MS || 60000);
const rateLimitMaxRequests = Number(process.env.RATE_LIMIT_MAX_REQUESTS || 120);
const useRedisRateLimit = String(process.env.REDIS_RATE_LIMIT_ENABLED || 'true').toLowerCase() === 'true';
const rateLimitStore = new Map();
const redisCache = createOptionalRedisClient({ logger });

// Circuit breaker registry – one breaker per upstream service
const breakers = createCircuitBreakerRegistry({
  failureThreshold: 5,
  successThreshold: 2,
  timeout: 30_000,
  callTimeout: 15_000,
  logger,
});

const routes = [
  {
    prefix: '/auth',
    target: process.env.AUTH_SERVICE_URL || 'http://auth-service:8001',
  },
  {
    prefix: '/users',
    target: process.env.USER_SERVICE_URL || 'http://user-service:8002',
  },
  {
    prefix: '/tenants',
    target: process.env.USER_SERVICE_URL || 'http://user-service:8002',
  },
  {
    prefix: '/events',
    target: process.env.ANALYTICS_SERVICE_URL || 'http://analytics-service:8003',
  },
  {
    prefix: '/ingest',
    target: process.env.EVENT_INGESTION_SERVICE_URL || 'http://event-ingestion-service:8004',
  },
  {
    prefix: '/recommendations',
    target: process.env.RECOMMENDATION_SERVICE_URL || 'http://recommendation-service:8005',
  },
  {
    prefix: '/fraud',
    target: process.env.FRAUD_DETECTION_SERVICE_URL || 'http://fraud-detection-service:8006',
  },
  {
    prefix: '/catalog',
    target: process.env.CATALOG_SERVICE_URL || 'http://catalog-service:8008',
  },
  {
    prefix: '/chat',
    target: process.env.CATALOG_SERVICE_URL || 'http://catalog-service:8008',
    rewrite: (path) => path.replace(/^\/chat/, '/catalog/chat'),
  },
];

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function cleanupRateLimitStore(now) {
  for (const [key, value] of rateLimitStore.entries()) {
    if (value.resetAt <= now) {
      rateLimitStore.delete(key);
    }
  }
}

function getClientIp(req) {
  const forwardedFor = req.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim();
  }

  return req.socket?.remoteAddress || 'unknown';
}

// Per-tenant rate limit overrides (loaded from env: TENANT_RATE_LIMITS=acme_api_key:500,free_key:60)
const tenantRateLimits = new Map();
(process.env.TENANT_RATE_LIMITS || '').split(',').forEach((entry) => {
  const [key, limit] = entry.trim().split(':');
  if (key && limit) tenantRateLimits.set(key.trim(), Number(limit));
});

function getEffectiveRateLimit(req) {
  const tenantApiKey = req.headers['x-tenant-api-key'];
  if (typeof tenantApiKey === 'string' && tenantApiKey.trim()) {
    return tenantRateLimits.get(tenantApiKey.trim()) || rateLimitMaxRequests;
  }
  return rateLimitMaxRequests;
}

function getRateLimitKey(req) {
  const clientIp = getClientIp(req);
  const tenantApiKey = req.headers['x-tenant-api-key'];
  const authorization = req.headers.authorization;

  if (typeof tenantApiKey === 'string' && tenantApiKey.trim()) {
    return `tenant:${tenantApiKey.trim()}`;
  }

  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    return `token:${authorization.slice(7, 31)}`;
  }

  return `ip:${clientIp}`;
}

function applyRateLimitHeaders(res, remaining, resetAtMs) {
  res.setHeader('X-RateLimit-Limit', String(rateLimitMaxRequests));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(remaining, 0)));
  res.setHeader('X-RateLimit-Reset', String(Math.ceil(resetAtMs / 1000)));
}

function rejectRateLimitedRequest(res, resetAtMs) {
  const retryAfterSeconds = Math.max(Math.ceil((resetAtMs - Date.now()) / 1000), 1);
  res.setHeader('Retry-After', String(retryAfterSeconds));
  applyRateLimitHeaders(res, 0, resetAtMs);
  sendJson(res, 429, {
    error: 'Rate limit exceeded',
    retryAfterSeconds,
    windowMs: rateLimitWindowMs,
    maxRequests: rateLimitMaxRequests,
  });
  return false;
}

function enforceInMemoryRateLimit(req, res) {
  const now = Date.now();
  cleanupRateLimitStore(now);

  const key = getRateLimitKey(req);
  const maxRequests = getEffectiveRateLimit(req);
  const entry = rateLimitStore.get(key);

  if (!entry || entry.resetAt <= now) {
    rateLimitStore.set(key, { count: 1, resetAt: now + rateLimitWindowMs });
    applyRateLimitHeaders(res, maxRequests - 1, now + rateLimitWindowMs);
    return true;
  }

  if (entry.count >= maxRequests) {
    return rejectRateLimitedRequest(res, entry.resetAt);
  }

  entry.count += 1;
  applyRateLimitHeaders(res, maxRequests - entry.count, entry.resetAt);
  return true;
}

async function enforceRedisRateLimit(req, res) {
  const redis = redisCache.client;
  if (!redisCache.enabled || !redisCache.connected || !redis) {
    return enforceInMemoryRateLimit(req, res);
  }

  const key = `rate-limit:${getRateLimitKey(req)}`;
  const now = Date.now();
  const resetAt = now + rateLimitWindowMs;
  const currentCount = await redis.incr(key);

  if (currentCount === 1) {
    await redis.pExpire(key, rateLimitWindowMs);
  }

  const ttlMs = await redis.pTTL(key);
  const effectiveResetAt = ttlMs > 0 ? now + ttlMs : resetAt;

  if (currentCount > rateLimitMaxRequests) {
    return rejectRateLimitedRequest(res, effectiveResetAt);
  }

  applyRateLimitHeaders(res, rateLimitMaxRequests - currentCount, effectiveResetAt);
  return true;
}

async function enforceRateLimit(req, res) {
  if (useRedisRateLimit) {
    try {
      return await enforceRedisRateLimit(req, res);
    } catch (error) {
      logger.warn('redis_rate_limit_fallback', {
        requestId: req.context?.requestId || null,
        error: {
          message: error.message,
        },
      });
    }
  }

  return enforceInMemoryRateLimit(req, res);
}

function getRoute(pathname) {
  return routes.find((route) => pathname === route.prefix || pathname.startsWith(`${route.prefix}/`));
}

function copyHeaders(headers) {
  const forwarded = { ...headers };
  delete forwarded.host;
  return forwarded;
}

async function proxyRequest(req, res, route) {
  const requestUrl = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);
  const rewrittenPath = route.rewrite
    ? route.rewrite(requestUrl.pathname) + requestUrl.search
    : requestUrl.pathname + requestUrl.search;
  const targetUrl = new URL(rewrittenPath, route.target);
  const method = req.method || 'GET';
  const headers = copyHeaders(req.headers);
  headers['x-request-id'] = req.context?.requestId || headers['x-request-id'];
  headers.traceparent = req.context?.traceparent || headers.traceparent;
  if (req.context?.tracestate) {
    headers.tracestate = req.context.tracestate;
  }
  if (req.context?.baggage) {
    headers.baggage = req.context.baggage;
  }
  const bodyAllowed = !['GET', 'HEAD'].includes(method);

  let body;
  if (bodyAllowed) {
    body = [];
    for await (const chunk of req) {
      body.push(chunk);
    }
    body = Buffer.concat(body);
  }

  const breaker = breakers.get(route.prefix);

  try {
    const upstreamResponse = await breaker.call(() =>
      fetch(targetUrl, {
        method,
        headers,
        body: bodyAllowed ? body : undefined,
        duplex: bodyAllowed ? 'half' : undefined,
      })
    );

    const upstreamBody = Buffer.from(await upstreamResponse.arrayBuffer());
    const responseHeaders = {};

    upstreamResponse.headers.forEach((value, key) => {
      if (key.toLowerCase() !== 'transfer-encoding') {
        responseHeaders[key] = value;
      }
    });

    res.writeHead(upstreamResponse.status, responseHeaders);
    res.end(upstreamBody);
  } catch (error) {
    if (error.circuitOpen) {
      logger.warn('circuit_breaker_rejected', {
        requestId: req.context?.requestId || null,
        routePrefix: route.prefix,
        breakerState: breaker.state,
      });
      return sendJson(res, 503, {
        error: 'Service temporarily unavailable (circuit open)',
        service: route.prefix,
        retryAfterMs: 30000,
      });
    }

    logger.error('upstream_request_failed', {
      requestId: req.context?.requestId || null,
      method,
      target: targetUrl.toString(),
      routePrefix: route.prefix,
      error: serializeError(error),
    });
    sendJson(res, 502, {
      error: 'Upstream service unavailable',
      target: route.target,
    });
  }
}

const server = http.createServer(async (req, res) => {
  const context = attachContext(req, res, 'api-gateway');
  const startedAt = process.hrtime.bigint();
  const requestUrl = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    logger.info('http_request_completed', {
      requestId: context.requestId,
      traceId: context.traceId,
      spanId: context.spanId,
      method: req.method || 'GET',
      path: requestUrl.pathname,
      statusCode: res.statusCode,
      durationMs: Number(durationMs.toFixed(2)),
      clientIp: req.socket?.remoteAddress || null,
    });
  });

  if (requestUrl.pathname === '/health') {
    trackNodeRequest(metrics, req, res, '/health');
    return sendJson(res, 200, {
      status: 'healthy',
      service: 'api-gateway',
      timestamp: new Date().toISOString(),
      routes: routes.map((route) => route.prefix),
      circuitBreakers: breakers.snapshot(),
    });
  }

  if (requestUrl.pathname === '/metrics') {
    trackNodeRequest(metrics, req, res, '/metrics');
    return sendJson(res, 200, metrics.snapshot());
  }

  if (requestUrl.pathname === '/metrics/prometheus') {
    trackNodeRequest(metrics, req, res, '/metrics/prometheus');
    const body = renderPrometheusMetrics(metrics.snapshot());
    res.writeHead(200, {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
    return;
  }

  if (!(await enforceRateLimit(req, res))) {
    metrics.record(req.method || 'GET', 'rate-limited', 429, 0);
    return;
  }

  const route = getRoute(requestUrl.pathname);
  if (!route) {
    trackNodeRequest(metrics, req, res, 'unmatched');
    return sendJson(res, 404, { error: 'Route not found' });
  }

  trackNodeRequest(metrics, req, res, route.prefix);
  return proxyRequest(req, res, route);
});

server.listen(PORT, () => {
  logger.info('service_started', {
    port: PORT,
    redisRateLimitEnabled: useRedisRateLimit,
    redisConnected: redisCache.connected,
  });
});

redisCache.connect().catch((error) => {
  logger.warn('redis_unavailable_starting_with_fallback', {
    error: {
      message: error.message,
    },
  });
});

process.on('SIGTERM', async () => {
  logger.info('service_stopping', { signal: 'SIGTERM' });
  server.close();
  await redisCache.quit();
  process.exit(0);
});
