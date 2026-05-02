/**
 * Server-Sent Events stream for the tenant dashboard.
 * Pushes live analytics snapshots to connected browser clients.
 *
 * The client authenticates via a short-lived token passed as a query param
 * (since EventSource doesn't support custom headers in browsers).
 */

const jwt = require('jsonwebtoken');

const STREAM_INTERVAL_MS = Number(process.env.SSE_INTERVAL_MS || 5000);
const HEARTBEAT_INTERVAL_MS = 20_000;

function verifyToken(token) {
  if (!token) return null;
  try {
    return jwt.verify(token, process.env.JWT_SECRET || 'dev-secret');
  } catch {
    return null;
  }
}

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) throw new Error(`${response.status}`);
  return response.json();
}

async function buildSnapshot(apiBaseUrl, token) {
  const authHeader = { Authorization: `Bearer ${token}` };

  const [summary, recommendations, fraud] = await Promise.allSettled([
    fetchJson(`${apiBaseUrl}/events/summary?days=1`, authHeader),
    fetchJson(`${apiBaseUrl}/recommendations/popular?limit=3&days=7`, authHeader),
    fetchJson(`${apiBaseUrl}/fraud/alerts?hours=1&minRiskScore=40&limit=5`, authHeader),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    summary: summary.status === 'fulfilled' ? summary.value : null,
    recommendations: recommendations.status === 'fulfilled' ? recommendations.value : null,
    fraud: fraud.status === 'fulfilled' ? fraud.value : null,
  };
}

function createSseHandler(apiBaseUrl) {
  return function handleSse(req, res) {
    const token = req.query?.token;
    const claims = verifyToken(token);

    if (!claims) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    let closed = false;

    function send(event, data) {
      if (closed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    async function push() {
      if (closed) return;
      try {
        const snapshot = await buildSnapshot(apiBaseUrl, token);
        send('snapshot', snapshot);
      } catch (err) {
        send('error', { message: err.message });
      }
    }

    const dataInterval = setInterval(push, STREAM_INTERVAL_MS);
    const heartbeat = setInterval(() => {
      if (!closed) res.write(`: ping ${Date.now()}\n\n`);
    }, HEARTBEAT_INTERVAL_MS);

    push(); // immediate first push

    req.on('close', () => {
      closed = true;
      clearInterval(dataInterval);
      clearInterval(heartbeat);
    });
  };
}

module.exports = { createSseHandler };
