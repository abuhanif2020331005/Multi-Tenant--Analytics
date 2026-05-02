const crypto = require('crypto');
const { createTraceContext } = require('../observability/trace');

function generateRequestId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getIncomingRequestId(req) {
  const headerValue = req.headers['x-request-id'];

  if (typeof headerValue === 'string' && headerValue.trim()) {
    return headerValue.trim();
  }

  if (Array.isArray(headerValue) && headerValue[0]) {
    return String(headerValue[0]).trim();
  }

  return generateRequestId();
}

function getClientIp(req) {
  const forwardedFor = req.headers['x-forwarded-for'];

  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim();
  }

  return req.ip || req.socket?.remoteAddress || null;
}

function buildContext(serviceName, req) {
  const trace = createTraceContext(req.headers || {});
  return {
    service: serviceName,
    requestId: getIncomingRequestId(req),
    method: req.method || 'GET',
    path: req.originalUrl || req.url || '/',
    clientIp: getClientIp(req),
    traceId: trace.traceId,
    spanId: trace.spanId,
    parentSpanId: trace.parentSpanId,
    traceFlags: trace.traceFlags,
    traceparent: trace.traceparent,
    tracestate: trace.tracestate,
    baggage: trace.baggage,
  };
}

function attachContext(req, res, serviceName) {
  const context = buildContext(serviceName, req);
  req.context = context;
  res.setHeader('X-Request-Id', context.requestId);
  res.setHeader('traceparent', context.traceparent);
  if (context.tracestate) {
    res.setHeader('tracestate', context.tracestate);
  }
  return context;
}

function getTenantContext(req) {
  return req.tenant?.id || req.user?.tenantId || null;
}

function getUserContext(req) {
  return req.user?.userId || null;
}

function createRequestContextMiddleware(serviceName, logger) {
  return (req, res, next) => {
    const context = attachContext(req, res, serviceName);
    const startedAt = process.hrtime.bigint();

    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

      logger.info('http_request_completed', {
        requestId: context.requestId,
        traceId: context.traceId,
        spanId: context.spanId,
        method: context.method,
        path: context.path,
        statusCode: res.statusCode,
        durationMs: Number(durationMs.toFixed(2)),
        clientIp: context.clientIp,
        tenantId: getTenantContext(req),
        userId: getUserContext(req),
      });
    });

    next();
  };
}

module.exports = {
  attachContext,
  createRequestContextMiddleware,
  generateRequestId,
};
