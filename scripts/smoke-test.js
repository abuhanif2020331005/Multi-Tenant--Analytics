#!/usr/bin/env node
/**
 * Smoke test — hits every service health endpoint and reports status.
 * Run after `docker compose up -d` to verify all services are healthy.
 *
 * Usage:
 *   node scripts/smoke-test.js
 *   node scripts/smoke-test.js --base=http://my-cluster.example.com
 */

const base = process.argv.find((a) => a.startsWith('--base='))?.split('=')[1] || 'http://localhost';

const SERVICES = [
  { name: 'API Gateway',             url: `${base}:8000/health` },
  { name: 'Auth Service',            url: `${base}:8001/health` },
  { name: 'User Service',            url: `${base}:8002/health` },
  { name: 'Analytics Service',       url: `${base}:8003/health` },
  { name: 'Event Ingestion',         url: `${base}:8004/health` },
  { name: 'Recommendation Service',  url: `${base}:8005/health` },
  { name: 'Fraud Detection',         url: `${base}:8006/health` },
  { name: 'Event Processor',         url: `${base}:8007/health` },
  { name: 'Catalog Service',         url: `${base}:8008/health` },
  { name: 'Dashboard App',           url: `${base}:3000/health` },
  { name: 'Tenant Dashboard',        url: `${base}:3002/health` },
  { name: 'Prometheus',              url: `${base}:9090/-/healthy` },
  { name: 'Grafana',                 url: `${base}:3001/api/health` },
  { name: 'Jaeger',                  url: `${base}:16686` },
  { name: 'Qdrant',                  url: `${base}:6333/healthz` },
];

const TIMEOUT_MS = 5000;
const GREEN = '\x1b[32m';
const RED   = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

async function checkService({ name, url }) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const ok = response.status < 400;
    return { name, url, ok, status: response.status };
  } catch (err) {
    return { name, url, ok: false, status: null, error: err.message };
  }
}

async function main() {
  console.log(`\nSmoke test — ${new Date().toISOString()}\n`);

  const results = await Promise.all(SERVICES.map(checkService));

  let passed = 0;
  let failed = 0;

  for (const r of results) {
    const icon  = r.ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
    const label = r.ok ? `${GREEN}${r.status}${RESET}` : `${RED}${r.status ?? r.error}${RESET}`;
    const pad   = ' '.repeat(Math.max(0, 28 - r.name.length));
    console.log(`  ${icon}  ${r.name}${pad}${label}  ${YELLOW}${r.url}${RESET}`);
    r.ok ? passed++ : failed++;
  }

  console.log(`\n  ${passed}/${results.length} services healthy\n`);

  if (failed > 0) {
    console.log(`${RED}  ${failed} service(s) failed. Check docker compose logs.${RESET}\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Smoke test error:', err.message);
  process.exit(1);
});
