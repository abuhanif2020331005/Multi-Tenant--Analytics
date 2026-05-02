const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { createSseHandler } = require('./sse');

const PORT = Number(process.env.PORT || 3002);
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:8000';
const PUBLIC_API_BASE_URL = process.env.PUBLIC_API_BASE_URL || '/api';
const publicDir = path.join(__dirname, '..', 'public');

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const sseHandler = createSseHandler(API_BASE_URL);

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (error, content) => {
    if (error) {
      return sendJson(res, 500, { error: 'Failed to load dashboard asset' });
    }
    const extension = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': mimeTypes[extension] || 'application/octet-stream',
      'Content-Length': Buffer.byteLength(content),
    });
    res.end(content);
  });
}

async function proxyApiRequest(req, res, parsedUrl) {
  const upstreamPath = parsedUrl.pathname.replace(/^\/api/, '') || '/';
  const upstreamUrl = new URL(`${upstreamPath}${parsedUrl.search}`, API_BASE_URL);
  const method = req.method || 'GET';
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.connection;

  let body;
  if (!['GET', 'HEAD'].includes(method)) {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks);
    headers['content-length'] = String(body.length);
  }

  try {
    const upstreamResponse = await fetch(upstreamUrl, {
      method,
      headers,
      body,
      duplex: body ? 'half' : undefined,
    });
    const responseBody = Buffer.from(await upstreamResponse.arrayBuffer());
    const responseHeaders = {};
    upstreamResponse.headers.forEach((value, key) => {
      if (key.toLowerCase() !== 'transfer-encoding') {
        responseHeaders[key] = value;
      }
    });
    res.writeHead(upstreamResponse.status, responseHeaders);
    res.end(responseBody);
  } catch (error) {
    sendJson(res, 502, { error: 'API gateway unavailable', detail: error.message });
  }
}

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
  const requestPath = parsedUrl.pathname;

  if (requestPath === '/health') {
    return sendJson(res, 200, {
      status: 'healthy',
      service: 'tenant-dashboard',
      timestamp: new Date().toISOString(),
    });
  }

  if (requestPath === '/config') {
    return sendJson(res, 200, {
      apiBaseUrl: PUBLIC_API_BASE_URL,
      defaultTenantSlug: process.env.DEFAULT_TENANT_SLUG || 'acme',
      defaultEmail: process.env.DEFAULT_LOGIN_EMAIL || 'admin@acme.com',
      defaultPassword: process.env.DEFAULT_LOGIN_PASSWORD || 'password123',
      defaultTenantApiKey: process.env.DEFAULT_TENANT_API_KEY || 'acme_api_key_12345',
    });
  }

  if (requestPath === '/api' || requestPath.startsWith('/api/')) {
    return proxyApiRequest(req, res, parsedUrl);
  }

  // SSE live feed — requires ?token=<jwt>
  if (requestPath === '/stream/live') {
    return sseHandler(req, res);
  }

  const normalizedPath =
    requestPath === '/' ? path.join(publicDir, 'index.html') : path.join(publicDir, requestPath);

  if (!normalizedPath.startsWith(publicDir)) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }

  fs.stat(normalizedPath, (error, stats) => {
    if (error || !stats.isFile()) {
      return sendJson(res, 404, { error: 'Not found' });
    }
    return serveFile(res, normalizedPath);
  });
});

server.listen(PORT, () => {
  console.log(`Tenant Dashboard running on port ${PORT}`);
});
