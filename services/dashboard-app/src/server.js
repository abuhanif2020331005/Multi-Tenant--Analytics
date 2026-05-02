const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3000);
const publicDir = path.join(__dirname, '..', 'public');
const startedAt = new Date().toISOString();
const apiBaseUrl = process.env.API_BASE_URL || 'http://localhost:8000';
const processorBaseUrl = process.env.PROCESSOR_BASE_URL || 'http://localhost:8007';
const adminApiToken = process.env.ADMIN_API_TOKEN || '';
const requestTotals = {
  total: 0,
  errors: 0,
};

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, statusCode, body) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function buildServiceUrl(baseUrl, port, pathname) {
  const url = new URL(baseUrl);
  url.port = String(port);
  url.pathname = pathname;
  url.search = '';
  return url.toString();
}

const services = [
  { name: 'API Gateway', healthUrl: buildServiceUrl(apiBaseUrl, 8000, '/health'), metricsUrl: buildServiceUrl(apiBaseUrl, 8000, '/metrics') },
  { name: 'Auth Service', healthUrl: buildServiceUrl(apiBaseUrl, 8001, '/health'), metricsUrl: buildServiceUrl(apiBaseUrl, 8001, '/metrics') },
  { name: 'User Service', healthUrl: buildServiceUrl(apiBaseUrl, 8002, '/health'), metricsUrl: buildServiceUrl(apiBaseUrl, 8002, '/metrics') },
  { name: 'Analytics Service', healthUrl: buildServiceUrl(apiBaseUrl, 8003, '/health'), metricsUrl: buildServiceUrl(apiBaseUrl, 8003, '/metrics') },
  { name: 'Event Ingestion', healthUrl: buildServiceUrl(apiBaseUrl, 8004, '/health'), metricsUrl: buildServiceUrl(apiBaseUrl, 8004, '/metrics') },
  { name: 'Recommendation', healthUrl: buildServiceUrl(apiBaseUrl, 8005, '/health'), metricsUrl: buildServiceUrl(apiBaseUrl, 8005, '/metrics') },
  { name: 'Fraud Detection', healthUrl: buildServiceUrl(apiBaseUrl, 8006, '/health'), metricsUrl: buildServiceUrl(apiBaseUrl, 8006, '/metrics') },
  { name: 'Event Processor', healthUrl: processorBaseUrl + '/health', metricsUrl: processorBaseUrl + '/metrics' },
];

function recordRequest(statusCode) {
  requestTotals.total += 1;
  if (Number(statusCode) >= 400) {
    requestTotals.errors += 1;
  }
}

function adminHeaders() {
  return adminApiToken ? { 'x-admin-token': adminApiToken } : {};
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function gatherHealthSnapshot() {
  return Promise.all(
    services.map(async (service) => {
      try {
        const payload = await fetchJson(service.healthUrl);
        return {
          name: service.name,
          ok: payload.status === 'healthy',
          timestamp: payload.timestamp,
        };
      } catch (error) {
        return {
          name: service.name,
          ok: false,
          error: error.message,
        };
      }
    })
  );
}

async function gatherMetricsSnapshot() {
  return Promise.all(
    services.map(async (service) => {
      try {
        const payload = await fetchJson(service.metricsUrl);
        return {
          name: service.name,
          ok: true,
          payload,
        };
      } catch (error) {
        return {
          name: service.name,
          ok: false,
          error: error.message,
        };
      }
    })
  );
}

async function gatherProcessorSnapshot() {
  try {
    return await fetchJson(processorBaseUrl + '/processor/stats', {
      headers: adminHeaders(),
    });
  } catch (error) {
    return {
      error: error.message,
    };
  }
}

async function gatherControlRoomSnapshot() {
  const [health, metrics, processor] = await Promise.all([
    gatherHealthSnapshot(),
    gatherMetricsSnapshot(),
    gatherProcessorSnapshot(),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    health,
    metrics,
    processor,
  };
}

function sendSse(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function renderPrometheusMetrics() {
  return [
    '# HELP platform_dashboard_requests_total Total dashboard app requests',
    '# TYPE platform_dashboard_requests_total counter',
    `platform_dashboard_requests_total{service="dashboard-app"} ${requestTotals.total}`,
    '# HELP platform_dashboard_request_errors_total Total dashboard app error responses',
    '# TYPE platform_dashboard_request_errors_total counter',
    `platform_dashboard_request_errors_total{service="dashboard-app"} ${requestTotals.errors}`,
    `platform_dashboard_info{service="dashboard-app",started_at="${startedAt}"} 1`,
    '',
  ].join('\n');
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendJson(res, 500, { error: 'Failed to load dashboard asset' });
      return;
    }

    const extension = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': mimeTypes[extension] || 'application/octet-stream',
      'Content-Length': Buffer.byteLength(content),
    });
    res.end(content);
  });
}

const server = http.createServer((req, res) => {
  const requestPath = req.url.split('?')[0];

  if (requestPath === '/health') {
    recordRequest(200);
    return sendJson(res, 200, {
      status: 'healthy',
      service: 'dashboard-app',
      timestamp: new Date().toISOString(),
    });
  }

  if (requestPath === '/config') {
    recordRequest(200);
    return sendJson(res, 200, {
      apiBaseUrl,
    });
  }

  if (requestPath === '/api/processor/stats') {
    return fetchJson(processorBaseUrl + '/processor/stats', {
      headers: adminHeaders(),
    })
      .then((payload) => {
        recordRequest(200);
        sendJson(res, 200, payload);
      })
      .catch((error) => {
        recordRequest(502);
        sendJson(res, 502, { error: error.message });
      });
  }

  if (requestPath === '/stream/control-room') {
    recordRequest(200);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    let closed = false;
    let inFlight = false;

    const publishSnapshot = async () => {
      if (closed || inFlight) {
        return;
      }

      inFlight = true;
      try {
        const snapshot = await gatherControlRoomSnapshot();
        sendSse(res, 'snapshot', snapshot);
      } catch (error) {
        sendSse(res, 'stream-error', {
          generatedAt: new Date().toISOString(),
          error: error.message,
        });
      } finally {
        inFlight = false;
      }
    };

    const heartbeat = setInterval(() => {
      if (!closed) {
        res.write(`: keep-alive ${Date.now()}\n\n`);
      }
    }, 15000);

    const interval = setInterval(publishSnapshot, 5000);
    publishSnapshot();

    req.on('close', () => {
      closed = true;
      clearInterval(interval);
      clearInterval(heartbeat);
    });
    return;
  }

  if (requestPath === '/metrics') {
    recordRequest(200);
    return sendJson(res, 200, {
      service: 'dashboard-app',
      startedAt,
      totals: requestTotals,
    });
  }

  if (requestPath === '/metrics/prometheus') {
    recordRequest(200);
    return sendText(res, 200, renderPrometheusMetrics());
  }

  const normalizedPath =
    requestPath === '/' ? path.join(publicDir, 'index.html') : path.join(publicDir, requestPath);

  if (!normalizedPath.startsWith(publicDir)) {
    recordRequest(403);
    return sendJson(res, 403, { error: 'Forbidden' });
  }

  fs.stat(normalizedPath, (error, stats) => {
    if (error || !stats.isFile()) {
      recordRequest(404);
      return sendJson(res, 404, { error: 'Not found' });
    }

    return serveFile(res, normalizedPath);
  });
});

server.listen(PORT, () => {
  console.log(`Dashboard App running on port ${PORT}`);
});
