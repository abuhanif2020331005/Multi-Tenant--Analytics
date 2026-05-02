const state = {
  apiBaseUrl: 'http://localhost:8000',
  token: null,
  user: null,
  tenantApiKey: null,
  catalogProducts: [],
};

const STORAGE_KEY = 'tenant-dashboard-session';

function $(id) {
  return document.getElementById(id);
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    if (response.status === 401) {
      clearSession();
      $('login-message').textContent = 'Session expired. Please sign in again.';
    }
    throw new Error(payload.error || `${response.status} ${response.statusText}`);
  }

  return payload;
}

function authHeaders() {
  if (!state.token) {
    throw new Error('Sign in first.');
  }

  return {
    Authorization: `Bearer ${state.token}`,
  };
}

function saveSession() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      token: state.token,
      user: state.user,
      tenantSlug: $('tenant-slug').value.trim(),
      email: $('email').value.trim(),
    })
  );
}

function clearSession() {
  state.token = null;
  state.user = null;
  localStorage.removeItem(STORAGE_KEY);
  $('session-status').textContent = 'Signed out';
}

function renderKeyMetric(id, value, suffix = '') {
  $(id).textContent = value === null || value === undefined ? '--' : `${value}${suffix}`;
}

function renderPretty(id, payload) {
  $(id).textContent = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
}

async function loadConfig() {
  const config = await fetchJson('/config');
  state.apiBaseUrl = config.apiBaseUrl;
  state.tenantApiKey = config.defaultTenantApiKey;
  $('tenant-slug').value = config.defaultTenantSlug;
  $('email').value = config.defaultEmail;
  $('password').value = config.defaultPassword;
}

function restoreSession() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return false;
  }

  try {
    const session = JSON.parse(raw);
    state.token = session.token;
    state.user = session.user;
    if (session.tenantSlug) $('tenant-slug').value = session.tenantSlug;
    if (session.email) $('email').value = session.email;
    if (state.user?.email) {
      $('session-status').textContent = `Signed in as ${state.user.email}`;
    }
    return Boolean(state.token);
  } catch (error) {
    clearSession();
    return false;
  }
}

async function login() {
  $('login-message').textContent = 'Signing in...';

  try {
    const payload = await fetchJson(`${state.apiBaseUrl}/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tenantSlug: $('tenant-slug').value.trim(),
        email: $('email').value.trim(),
        password: $('password').value,
      }),
    });

    state.token = payload.accessToken;
    state.user = payload.user;
    saveSession();
    $('session-status').textContent = `Signed in as ${payload.user.email}`;
    $('login-message').textContent = 'Authenticated. Loading dashboard data...';

    await refreshAllData();
    connectLiveStream();
    $('login-message').textContent = 'Dashboard is up to date.';
  } catch (error) {
    clearSession();
    $('login-message').textContent = error.message;
  }
}

function logout() {
  clearSession();
  $('profile').textContent = 'Sign in to load profile.';
  $('recommendations').textContent = 'No recommendations loaded.';
  $('personal-recommendations').textContent = 'No personalized recommendations loaded.';
  $('catalog').textContent = 'No catalog loaded.';
  $('similar-products').textContent = 'No similar products loaded.';
  $('fraud').textContent = 'No alerts loaded.';
  $('events').textContent = 'No events loaded.';
  $('stats').textContent = 'No stats loaded.';
  $('event-mix').textContent = 'No event summary loaded.';
  $('trend-chart').textContent = 'No trend data loaded.';
  $('login-message').textContent = 'Signed out.';
  ['kpi-total-events', 'kpi-unique-users', 'kpi-cart-rate', 'kpi-conversion-rate'].forEach((id) =>
    renderKeyMetric(id, '--')
  );
}

async function loadProfile() {
  try {
    const payload = await fetchJson(`${state.apiBaseUrl}/users/me`, {
      headers: authHeaders(),
    });
    state.user = payload;
    saveSession();
    renderPretty('profile', payload);
  } catch (error) {
    renderPretty('profile', error.message);
  }
}

function renderRankedList(containerId, items, valueKey, formatter) {
  if (!items || items.length === 0) {
    $(containerId).textContent = 'No data available.';
    return;
  }

  const maxValue = Math.max(...items.map((item) => Number(item[valueKey] || 0)), 1);
  $(containerId).innerHTML = `
    <div class="mini-list">
      ${items
        .map((item) => {
          const percent = Math.max((Number(item[valueKey] || 0) / maxValue) * 100, 6);
          return `
            <div class="mini-item">
              <div class="label-stack">
                <strong>${formatter.title(item)}</strong>
                <div class="bar" style="width:${percent}%"></div>
              </div>
              <span>${formatter.value(item)}</span>
            </div>
          `;
        })
        .join('')}
    </div>
  `;
}

async function loadRecommendations() {
  try {
    const payload = await fetchJson(`${state.apiBaseUrl}/recommendations/popular?limit=5&days=30`, {
      headers: authHeaders(),
    });
    renderRankedList('recommendations', payload.recommendations, 'score', {
      title: (item) => item.name || item.productId,
      value: (item) => `${item.category || 'uncategorized'} | score ${item.score}`,
    });
  } catch (error) {
    renderPretty('recommendations', error.message);
  }
}

async function loadPersonalRecommendations() {
  try {
    const payload = await fetchJson(`${state.apiBaseUrl}/recommendations/for-user?limit=5&days=30`, {
      headers: authHeaders(),
    });
    renderRankedList('personal-recommendations', payload.recommendations, 'score', {
      title: (item) => item.name || item.productId,
      value: (item) => `${item.category || 'uncategorized'} | score ${item.score}`,
    });
  } catch (error) {
    renderPretty('personal-recommendations', error.message);
  }
}

async function loadCatalog() {
  try {
    const payload = await fetchJson(`${state.apiBaseUrl}/catalog/products?limit=6&offset=0`, {
      headers: authHeaders(),
    });
    state.catalogProducts = payload.products || [];
    renderRankedList('catalog', payload.products, 'price', {
      title: (item) => `${item.name} (${item.category || 'uncategorized'})`,
      value: (item) => `${item.currency || 'USD'} ${item.price}`,
    });
  } catch (error) {
    renderPretty('catalog', error.message);
  }
}

async function loadSimilarProducts() {
  try {
    if (!state.catalogProducts.length) {
      $('similar-products').textContent = 'Load the catalog first.';
      return;
    }

    const sourceProduct = state.catalogProducts[0];
    const payload = await fetchJson(
      `${state.apiBaseUrl}/recommendations/similar/${encodeURIComponent(sourceProduct.product_id)}?limit=5&days=60`,
      {
        headers: authHeaders(),
      }
    );

    if (!payload.recommendations.length) {
      $('similar-products').textContent = `No similar products found for ${sourceProduct.name}.`;
      return;
    }

    renderRankedList('similar-products', payload.recommendations, 'score', {
      title: (item) => item.name || item.productId,
      value: (item) => `${item.category || 'uncategorized'} | score ${item.score}`,
    });
  } catch (error) {
    renderPretty('similar-products', error.message);
  }
}

async function loadFraud() {
  try {
    const payload = await fetchJson(`${state.apiBaseUrl}/fraud/alerts?hours=24&minRiskScore=20&limit=10`, {
      headers: authHeaders(),
    });
    renderRankedList('fraud', payload.alerts, 'riskScore', {
      title: (item) => item.userId,
      value: (item) => `risk ${item.riskScore}`,
    });
  } catch (error) {
    renderPretty('fraud', error.message);
  }
}

async function loadEvents() {
  try {
    const payload = await fetchJson(`${state.apiBaseUrl}/events?limit=20&offset=0`, {
      headers: authHeaders(),
    });
    renderPretty('events', payload);
  } catch (error) {
    renderPretty('events', error.message);
  }
}

async function loadStats() {
  try {
    const payload = await fetchJson(`${state.apiBaseUrl}/events/stats`, {
      headers: authHeaders(),
    });
    renderPretty('stats', payload);
    renderTrendChart(payload.stats || []);
  } catch (error) {
    renderPretty('stats', error.message);
    $('trend-chart').textContent = error.message;
  }
}

function renderTrendChart(stats) {
  if (!stats.length) {
    $('trend-chart').textContent = 'No trend data available.';
    return;
  }

  const totalsByDay = new Map();
  stats.forEach((item) => {
    const key = new Date(item.date).toISOString().slice(0, 10);
    totalsByDay.set(key, (totalsByDay.get(key) || 0) + Number(item.count || 0));
  });

  const points = Array.from(totalsByDay.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-7);

  const max = Math.max(...points.map(([, value]) => value), 1);
  const width = 520;
  const height = 180;
  const stepX = points.length > 1 ? width / (points.length - 1) : width;
  const coordinates = points.map(([date, value], index) => {
    const x = index * stepX;
    const y = height - (value / max) * (height - 24) - 12;
    return { date, value, x, y };
  });

  const polyline = coordinates.map((point) => `${point.x},${point.y}`).join(' ');
  $('trend-chart').innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="180" aria-label="Event trend chart">
      <rect x="0" y="0" width="${width}" height="${height}" rx="18" fill="rgba(11,122,117,0.06)"></rect>
      <polyline fill="none" stroke="#ca5b2d" stroke-width="4" points="${polyline}"></polyline>
      ${coordinates
        .map(
          (point) => `
            <circle cx="${point.x}" cy="${point.y}" r="4" fill="#0b7a75"></circle>
            <text x="${point.x}" y="${height - 4}" text-anchor="middle" font-size="11" fill="#6b7278">${point.date.slice(5)}</text>
          `
        )
        .join('')}
    </svg>
  `;
}

async function loadSummary() {
  try {
    const payload = await fetchJson(`${state.apiBaseUrl}/events/summary?days=30`, {
      headers: authHeaders(),
    });
    renderKeyMetric('kpi-total-events', payload.totalEvents);
    renderKeyMetric('kpi-unique-users', payload.uniqueUsers);
    renderKeyMetric('kpi-cart-rate', payload.cartRate, '%');
    renderKeyMetric('kpi-conversion-rate', payload.conversionRate, '%');

    $('event-mix').innerHTML = `
      <div class="mini-list">
        <div class="mini-item"><strong>Product Views</strong><span>${payload.productViews}</span></div>
        <div class="mini-item"><strong>Add to Cart</strong><span>${payload.addToCart}</span></div>
        <div class="mini-item"><strong>Purchases</strong><span>${payload.purchases}</span></div>
        <div class="mini-item"><strong>Window</strong><span>${payload.windowDays} days</span></div>
      </div>
    `;
  } catch (error) {
    $('event-mix').textContent = error.message;
  }
}

async function seedDemoEvents() {
  $('login-message').textContent = 'Seeding demo storefront events...';

  try {
    const payload = await fetchJson(`${state.apiBaseUrl}/ingest/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tenant-api-key': state.tenantApiKey,
      },
      body: JSON.stringify({
        source: 'tenant-dashboard-demo',
        events: [
          {
            userId: 'shopper_101',
            eventType: 'product_view',
            eventData: { productId: 'sku_hiking_shell', category: 'outerwear' },
          },
          {
            userId: 'shopper_101',
            eventType: 'add_to_cart',
            eventData: { productId: 'sku_hiking_shell', quantity: 1 },
          },
          {
            userId: 'shopper_102',
            eventType: 'product_view',
            eventData: { productId: 'sku_trail_pack', category: 'packs' },
          },
          {
            userId: 'shopper_102',
            eventType: 'purchase',
            eventData: { productId: 'sku_trail_pack', amount: 129 },
          },
        ],
      }),
    });

    $('login-message').textContent = `Seeded ${payload.accepted} events. Refreshing dashboard...`;
    if (state.token) {
      await refreshAllData();
      $('login-message').textContent = 'Demo events added and dashboard refreshed.';
    }
  } catch (error) {
    $('login-message').textContent = error.message;
  }
}

async function saveCatalogProduct() {
  $('catalog-message').textContent = 'Saving product...';

  try {
    const productId = $('product-id').value.trim();
    const payload = {
      productId,
      name: $('product-name').value.trim(),
      category: $('product-category').value.trim(),
      description: $('product-description').value.trim(),
      price: Number($('product-price').value || 0),
      currency: 'USD',
      metadata: {},
      isActive: true,
    };

    if (!productId) {
      throw new Error('product_id is required.');
    }

    const method = state.catalogProducts.some((product) => product.product_id === productId) ? 'PUT' : 'POST';
    const url =
      method === 'PUT'
        ? `${state.apiBaseUrl}/catalog/products/${encodeURIComponent(productId)}`
        : `${state.apiBaseUrl}/catalog/products`;

    await fetchJson(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(),
      },
      body: JSON.stringify(payload),
    });

    $('catalog-message').textContent = `Product ${method === 'PUT' ? 'updated' : 'created'} successfully.`;
    await loadCatalog();
    await loadSimilarProducts();
  } catch (error) {
    $('catalog-message').textContent = error.message;
  }
}

async function sendChatMessage() {
  const input = $('chat-input');
  const message = input.value.trim();
  if (!message) return;

  const history = $('chat-history');
  $('chat-message').textContent = 'Thinking...';
  input.value = '';

  // Append user message
  history.innerHTML += `<div style="margin-bottom:0.5rem"><strong>You:</strong> ${message}</div>`;

  try {
    const payload = await fetchJson(`${state.apiBaseUrl}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ message, history: [] }),
    });

    history.innerHTML += `<div style="margin-bottom:0.5rem;color:#0b7a75"><strong>Assistant (${payload.strategy}):</strong> ${payload.answer}</div>`;
    $('chat-message').textContent = `Strategy: ${payload.strategy} | Ollama: ${payload.ollamaEnabled ? 'on' : 'off (keyword fallback)'}`;
  } catch (error) {
    history.innerHTML += `<div style="color:red"><strong>Error:</strong> ${error.message}</div>`;
    $('chat-message').textContent = error.message;
  }

  history.scrollTop = history.scrollHeight;
}

async function refreshAllData() {
  await Promise.all([
    loadProfile(),
    loadRecommendations(),
    loadPersonalRecommendations(),
    loadFraud(),
    loadEvents(),
    loadStats(),
    loadSummary(),
  ]);
  await loadCatalog();
  await loadSimilarProducts();
}

async function bootstrap() {
  await loadConfig();
  restoreSession();
  $('login-button').addEventListener('click', login);
  $('logout-button').addEventListener('click', logout);
  $('refresh-recommendations').addEventListener('click', loadRecommendations);
  $('refresh-personal').addEventListener('click', loadPersonalRecommendations);
  $('refresh-catalog').addEventListener('click', loadCatalog);
  $('refresh-similar').addEventListener('click', loadSimilarProducts);
  $('refresh-fraud').addEventListener('click', loadFraud);
  $('refresh-events').addEventListener('click', loadEvents);
  $('refresh-stats').addEventListener('click', loadStats);
  $('refresh-summary').addEventListener('click', loadSummary);
  $('refresh-trends').addEventListener('click', loadStats);
  $('seed-events-button').addEventListener('click', seedDemoEvents);
  $('save-product-button').addEventListener('click', saveCatalogProduct);
  $('refresh-all-button').addEventListener('click', refreshAllData);
  $('chat-send-button').addEventListener('click', sendChatMessage);
  $('chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChatMessage();
  });

  if (state.token) {
    $('login-message').textContent = 'Restored previous session. Loading dashboard data...';
    await refreshAllData();
    connectLiveStream();
    $('login-message').textContent = 'Dashboard restored from saved session.';
  }
}

let liveStream = null;

function connectLiveStream() {
  if (!state.token) return;
  if (liveStream) { liveStream.close(); liveStream = null; }

  const url = `/stream/live?token=${encodeURIComponent(state.token)}`;
  liveStream = new EventSource(url);

  liveStream.addEventListener('snapshot', (e) => {
    try {
      const snap = JSON.parse(e.data);
      if (snap.summary) {
        renderKeyMetric('kpi-total-events', snap.summary.totalEvents);
        renderKeyMetric('kpi-unique-users', snap.summary.uniqueUsers);
        renderKeyMetric('kpi-cart-rate', snap.summary.cartRate, '%');
        renderKeyMetric('kpi-conversion-rate', snap.summary.conversionRate, '%');
      }
      if (snap.recommendations) {
        renderRankedList('recommendations', snap.recommendations.recommendations || [], 'score', {
          title: (item) => item.name || item.productId,
          value: (item) => `score ${item.score}`,
        });
      }
      if (snap.fraud) {
        renderRankedList('fraud', snap.fraud.alerts || [], 'riskScore', {
          title: (item) => item.userId,
          value: (item) => `risk ${item.riskScore}`,
        });
      }
    } catch {}
  });

  liveStream.onerror = () => {
    // Reconnect silently — EventSource handles this automatically
  };
}

bootstrap().catch((error) => {
  $('login-message').textContent = error.message;
});
