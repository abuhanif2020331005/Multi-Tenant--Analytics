const state = {
  config: null,
  liveStream: null,
};

const services = [
  { name: 'API Gateway', url: 'http://localhost:8000/health', metrics: 'http://localhost:8000/metrics' },
  { name: 'Auth Service', url: 'http://localhost:8001/health', metrics: 'http://localhost:8001/metrics' },
  { name: 'User Service', url: 'http://localhost:8002/health', metrics: 'http://localhost:8002/metrics' },
  { name: 'Analytics Service', url: 'http://localhost:8003/health', metrics: 'http://localhost:8003/metrics' },
  { name: 'Event Ingestion', url: 'http://localhost:8004/health', metrics: 'http://localhost:8004/metrics' },
  { name: 'Recommendation', url: 'http://localhost:8005/health', metrics: 'http://localhost:8005/metrics' },
  { name: 'Fraud Detection', url: 'http://localhost:8006/health', metrics: 'http://localhost:8006/metrics' },
  { name: 'Event Processor', url: 'http://localhost:8007/health', metrics: 'http://localhost:8007/metrics' },
];

async function loadConfig() {
  const response = await fetch('/config');
  state.config = await response.json();
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json();
}

function renderServiceGrid(results) {
  const container = document.getElementById('service-grid');
  container.innerHTML = results
    .map((service) => {
      const ok = service.ok;
      return `
        <div class="service-card">
          <h3>${service.name}</h3>
          <div class="status-pill ${ok ? 'status-ok' : 'status-down'}">
            <span>${ok ? 'Healthy' : 'Unavailable'}</span>
          </div>
          <p>${ok ? service.timestamp : service.error}</p>
        </div>
      `;
    })
    .join('');

  const gateway = results.find((service) => service.name === 'API Gateway');
  document.getElementById('gateway-status').textContent = gateway?.ok ? 'Healthy' : 'Unavailable';
}

async function refreshHealth() {
  const results = await Promise.all(
    services.map(async (service) => {
      try {
        const payload = await fetchJson(service.url);
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

  renderServiceGrid(results);
}

function renderProcessorStats(payload) {
  const stats = document.getElementById('processor-stats');
  const queue = payload.queue || {};
  const runtime = payload.runtime || {};

  stats.innerHTML = [
    ['Pending', queue.pendingCount ?? '--'],
    ['Processed', queue.processedCount ?? '--'],
    ['Failed', queue.failedCount ?? '--'],
    ['Batches', runtime.processedBatches ?? '--'],
    ['Processed Events', runtime.processedEvents ?? '--'],
    ['Failed Events', runtime.failedEvents ?? '--'],
  ]
    .map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`)
    .join('');

  document.getElementById('processor-pending').textContent = queue.pendingCount ?? '--';
  document.getElementById('processor-failed').textContent = queue.failedCount ?? '--';
}

async function refreshProcessor() {
  try {
    const payload = await fetchJson('/api/processor/stats');
    renderProcessorStats(payload);
  } catch (error) {
    document.getElementById('processor-stats').innerHTML =
      `<div><dt>Status</dt><dd>${error.message}</dd></div>`;
  }
}

function setLiveStatus(status, detail) {
  document.getElementById('live-status').textContent = status;
  document.getElementById('live-updated').textContent = detail;
}

function renderMetricsGrid(results) {
  const container = document.getElementById('metrics-grid');
  container.innerHTML = results
    .map((entry) => {
      if (!entry.ok) {
        return `
          <div class="metric-card">
            <h3>${entry.name}</h3>
            <p>${entry.error}</p>
          </div>
        `;
      }

      return `
        <div class="metric-card">
          <h3>${entry.name}</h3>
          <p>Requests: ${entry.payload.totals.requests}</p>
          <p>Errors: ${entry.payload.totals.errors}</p>
          <p>Routes tracked: ${entry.payload.routes.length}</p>
        </div>
      `;
    })
    .join('');
}

async function refreshMetrics() {
  const results = await Promise.all(
    services.map(async (service) => {
      try {
        const payload = await fetchJson(service.metrics);
        return { name: service.name, ok: true, payload };
      } catch (error) {
        return { name: service.name, ok: false, error: error.message };
      }
    })
  );

  renderMetricsGrid(results);
}

function applyLiveSnapshot(snapshot) {
  if (Array.isArray(snapshot.health)) {
    renderServiceGrid(snapshot.health);
  }

  if (snapshot.processor) {
    renderProcessorStats(snapshot.processor);
  }

  if (Array.isArray(snapshot.metrics)) {
    renderMetricsGrid(snapshot.metrics);
  }

  setLiveStatus('Streaming', `Updated ${new Date(snapshot.generatedAt).toLocaleTimeString()}`);
}

function connectLiveStream() {
  if (state.liveStream) {
    state.liveStream.close();
  }

  const stream = new EventSource('/stream/control-room');
  state.liveStream = stream;
  setLiveStatus('Connecting', 'Opening live control-room stream');

  stream.addEventListener('snapshot', (event) => {
    try {
      const snapshot = JSON.parse(event.data);
      applyLiveSnapshot(snapshot);
    } catch (error) {
      setLiveStatus('Degraded', 'Received an unreadable live update');
    }
  });

  stream.addEventListener('stream-error', (event) => {
    try {
      const payload = JSON.parse(event.data);
      setLiveStatus('Degraded', payload.error || 'Live stream reported an error');
    } catch (error) {
      setLiveStatus('Degraded', 'Live stream reported an error');
    }
  });

  stream.onerror = () => {
    setLiveStatus('Reconnecting', 'Waiting for the next server-sent event connection');
  };
}

async function loadRecommendations() {
  const token = document.getElementById('token-input').value.trim();
  const output = document.getElementById('recommendations-output');
  if (!token) {
    output.textContent = 'Paste a bearer token first.';
    return;
  }

  try {
    const payload = await fetchJson(state.config.apiBaseUrl + '/recommendations/popular?limit=5&days=30', {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    output.textContent = JSON.stringify(payload, null, 2);
  } catch (error) {
    output.textContent = error.message;
  }
}

async function loadFraud() {
  const token = document.getElementById('token-input').value.trim();
  const output = document.getElementById('fraud-output');
  if (!token) {
    output.textContent = 'Paste a bearer token first.';
    return;
  }

  try {
    const payload = await fetchJson(state.config.apiBaseUrl + '/fraud/alerts?hours=24&minRiskScore=20&limit=10', {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    output.textContent = JSON.stringify(payload, null, 2);
  } catch (error) {
    output.textContent = error.message;
  }
}

async function loadTopProducts() {
  const token = document.getElementById('token-input').value.trim();
  const output = document.getElementById('top-products-output');
  if (!token) { output.textContent = 'Paste a bearer token first.'; return; }
  try {
    const payload = await fetchJson(state.config.apiBaseUrl + '/events/top-products?limit=10&days=30', {
      headers: { Authorization: `Bearer ${token}` },
    });
    output.textContent = JSON.stringify(payload, null, 2);
  } catch (error) {
    output.textContent = error.message;
  }
}

async function loadFunnel() {
  const token = document.getElementById('token-input').value.trim();
  const output = document.getElementById('funnel-output');
  if (!token) { output.textContent = 'Paste a bearer token first.'; return; }
  try {
    const payload = await fetchJson(state.config.apiBaseUrl + '/events/funnel?days=30', {
      headers: { Authorization: `Bearer ${token}` },
    });
    output.textContent = JSON.stringify(payload, null, 2);
  } catch (error) {
    output.textContent = error.message;
  }
}

async function bootstrap() {
  await loadConfig();

  document.getElementById('refresh-health').addEventListener('click', refreshHealth);
  document.getElementById('refresh-processor').addEventListener('click', refreshProcessor);
  document.getElementById('refresh-metrics').addEventListener('click', refreshMetrics);
  document.getElementById('load-recommendations').addEventListener('click', loadRecommendations);
  document.getElementById('load-fraud').addEventListener('click', loadFraud);
  document.getElementById('load-top-products').addEventListener('click', loadTopProducts);
  document.getElementById('load-funnel').addEventListener('click', loadFunnel);

  await Promise.all([refreshHealth(), refreshProcessor(), refreshMetrics()]);
  connectLiveStream();
}

bootstrap().catch((error) => {
  console.error('Dashboard bootstrap failed:', error);
});
