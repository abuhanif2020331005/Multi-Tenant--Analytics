function createMetricsStore(serviceName) {
  const startedAt = new Date().toISOString();
  const routeStats = new Map();

  function getRouteKey(method, path) {
    return `${method.toUpperCase()} ${path}`;
  }

  function getRouteStat(method, path) {
    const key = getRouteKey(method, path);
    if (!routeStats.has(key)) {
      routeStats.set(key, {
        method: method.toUpperCase(),
        path,
        requests: 0,
        errors: 0,
        statusCodes: {},
        totalDurationMs: 0,
        maxDurationMs: 0,
      });
    }

    return routeStats.get(key);
  }

  function record(method, path, statusCode, durationMs) {
    const stat = getRouteStat(method, path);
    stat.requests += 1;
    stat.totalDurationMs += durationMs;
    stat.maxDurationMs = Math.max(stat.maxDurationMs, durationMs);
    stat.statusCodes[statusCode] = (stat.statusCodes[statusCode] || 0) + 1;

    if (Number(statusCode) >= 400) {
      stat.errors += 1;
    }
  }

  function snapshot() {
    const routes = Array.from(routeStats.values()).map((stat) => ({
      method: stat.method,
      path: stat.path,
      requests: stat.requests,
      errors: stat.errors,
      statusCodes: stat.statusCodes,
      avgDurationMs: stat.requests > 0 ? Number((stat.totalDurationMs / stat.requests).toFixed(2)) : 0,
      maxDurationMs: Number(stat.maxDurationMs.toFixed(2)),
    }));

    const totals = routes.reduce(
      (acc, route) => {
        acc.requests += route.requests;
        acc.errors += route.errors;
        return acc;
      },
      { requests: 0, errors: 0 }
    );

    return {
      service: serviceName,
      startedAt,
      totals,
      routes,
    };
  }

  return {
    record,
    snapshot,
  };
}

function createExpressMetricsMiddleware(store) {
  return (req, res, next) => {
    const startedAt = process.hrtime.bigint();

    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const path = req.route?.path || req.baseUrl || req.path || req.originalUrl || 'unknown';
      store.record(req.method, path, res.statusCode, durationMs);
    });

    next();
  };
}

function createMetricsHandler(store) {
  return (req, res) => {
    res.json(store.snapshot());
  };
}

function sanitizeLabelValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function renderPrometheusMetrics(snapshot) {
  const lines = [
    '# HELP platform_requests_total Total HTTP requests handled by the service',
    '# TYPE platform_requests_total counter',
    '# HELP platform_request_errors_total Total HTTP requests resulting in client/server errors',
    '# TYPE platform_request_errors_total counter',
    '# HELP platform_request_duration_avg_ms Average request duration in milliseconds by route',
    '# TYPE platform_request_duration_avg_ms gauge',
    '# HELP platform_request_duration_max_ms Maximum request duration in milliseconds by route',
    '# TYPE platform_request_duration_max_ms gauge',
    '# HELP platform_route_status_total HTTP responses by route and status code',
    '# TYPE platform_route_status_total counter',
    '',
    `platform_service_info{service="${sanitizeLabelValue(snapshot.service)}",started_at="${sanitizeLabelValue(snapshot.startedAt)}"} 1`,
    `platform_requests_total{service="${sanitizeLabelValue(snapshot.service)}"} ${snapshot.totals.requests}`,
    `platform_request_errors_total{service="${sanitizeLabelValue(snapshot.service)}"} ${snapshot.totals.errors}`,
  ];

  for (const route of snapshot.routes) {
    const labels = `service="${sanitizeLabelValue(snapshot.service)}",method="${sanitizeLabelValue(
      route.method
    )}",path="${sanitizeLabelValue(route.path)}"`;

    lines.push(`platform_requests_total{${labels}} ${route.requests}`);
    lines.push(`platform_request_errors_total{${labels}} ${route.errors}`);
    lines.push(`platform_request_duration_avg_ms{${labels}} ${route.avgDurationMs}`);
    lines.push(`platform_request_duration_max_ms{${labels}} ${route.maxDurationMs}`);

    for (const [statusCode, count] of Object.entries(route.statusCodes)) {
      lines.push(
        `platform_route_status_total{${labels},status_code="${sanitizeLabelValue(statusCode)}"} ${count}`
      );
    }
  }

  lines.push('');
  return lines.join('\n');
}

function createPrometheusMetricsHandler(store) {
  return (req, res) => {
    const body = renderPrometheusMetrics(store.snapshot());
    const contentType = 'text/plain; version=0.0.4; charset=utf-8';
    // Works with both Express (res.send) and Node HTTP (res.end)
    if (typeof res.set === 'function') {
      res.set('Content-Type', contentType).send(body);
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(body);
    }
  };
}

function trackNodeRequest(store, req, res, path) {
  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    store.record(req.method || 'GET', path, res.statusCode, durationMs);
  });
}

/**
 * Express middleware that emits an OTel span per request.
 * Requires a tracer created with createTracer().
 */
function createTracingMiddleware(tracer) {
  return (req, res, next) => {
    if (!tracer?.enabled) return next();

    const traceCtx = tracer.extractContext(req.headers);
    const span = tracer.startSpan(`${req.method} ${req.path}`, {
      traceId: traceCtx.traceId,
      parentSpanId: traceCtx.parentSpanId,
      kind: 2, // SERVER
      attributes: {
        'http.method': req.method,
        'http.route': req.path,
        'http.url': req.originalUrl,
        'net.peer.ip': req.ip,
      },
    });

    req.span = span;

    res.on('finish', () => {
      span.setAttribute('http.status_code', res.statusCode);
      if (res.statusCode >= 500) {
        span.setError(new Error(`HTTP ${res.statusCode}`));
      }
      span.end().catch(() => {});
    });

    next();
  };
}

module.exports = {
  createMetricsStore,
  createExpressMetricsMiddleware,
  createMetricsHandler,
  createPrometheusMetricsHandler,
  renderPrometheusMetrics,
  trackNodeRequest,
  createTracingMiddleware,
};
