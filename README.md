# AI-Powered Multi-Tenant Analytics & Recommendation Platform

A production-grade SaaS backend where e-commerce sites integrate to get real-time user behavior analytics, AI-powered product recommendations, and fraud detection.

## Architecture

```
Client Apps
    │
    ▼
API Gateway (port 8000)          ← Rate limiting, circuit breakers, routing
    │
    ├── Auth Service       :8001  ← JWT, refresh tokens, gRPC token validation
    ├── User Service       :8002  ← User profiles, RBAC
    ├── Analytics Service  :8003  ← Event storage, stats, conversion funnels
    ├── Event Ingestion    :8004  ← Tenant API key auth, outbox pattern
    ├── Recommendation     :8005  ← Popular, user-based, co-view, semantic
    ├── Fraud Detection    :8006  ← Heuristic risk scoring, alerts
    ├── Event Processor    :8007  ← Outbox → Kafka/Redpanda → events table
    └── Catalog Service    :8008  ← Products, semantic search, RAG chatbot

Infrastructure
    ├── PostgreSQL  :5432   ← Multi-tenant schema, RLS-ready
    ├── Redis       :6379   ← Rate limiting, session cache
    ├── Redpanda    :9092   ← Kafka-compatible broker (3 topics)
    ├── Qdrant      :6333   ← Vector DB for semantic search
    └── Ollama      :11434  ← Local LLM for RAG chatbot

Observability
    ├── Prometheus  :9090
    ├── Grafana     :3001
    ├── Jaeger      :16686
    └── OTel Collector :4318
```

## Quick Start

```bash
cd backend-platform
docker compose up -d
```

All services start automatically. The DB migrator runs once and seeds demo data.

Default credentials:
- Tenant: `acme` | Email: `admin@acme.com` | Password: `password123`
- Tenant API key: `acme_api_key_12345`

Dashboards:
- Ops dashboard: http://localhost:3000
- Tenant dashboard: http://localhost:3002
- Grafana: http://localhost:3001 (admin/admin)
- Jaeger: http://localhost:16686
- Prometheus: http://localhost:9090

## Enable Ollama (RAG Chatbot)

```bash
# Pull a model after compose is up
docker exec platform-ollama ollama pull llama3.2

# Then set OLLAMA_ENABLED=true in docker-compose.yml for catalog-service and restart
docker compose restart catalog-service
```

## Enable Broker Mode (Kafka/Redpanda)

The event pipeline defaults to `INGESTION_MODE=outbox` (direct DB). To enable full broker-backed streaming:

```bash
# Already configured in docker-compose.yml — just ensure redpanda-init ran:
docker compose logs redpanda-init
```

Topics created automatically: `user-events`, `fraud-alerts`, `recommendation-updates`

## Services

| Service | Port | Auth | Description |
|---|---|---|---|
| api-gateway | 8000 | — | Reverse proxy, rate limiting, circuit breakers |
| auth-service | 8001 | — | Login, refresh, JWT validation |
| user-service | 8002 | JWT | User profiles |
| analytics-service | 8003 | JWT | Events, stats, conversion funnels |
| event-ingestion-service | 8004 | API Key | Tenant event ingestion (outbox/broker) |
| recommendation-service | 8005 | JWT | Popular, user-based, semantic recommendations |
| fraud-detection-service | 8006 | JWT | Risk scoring, fraud alerts |
| event-processor-service | 8007 | — | Outbox processor, Kafka consumer |
| catalog-service | 8008 | JWT | Products, semantic search, RAG chatbot |

## API Reference

See `test.http` for a complete collection of all endpoints. Use the VS Code REST Client extension to run them.

### Authentication Flow

```
POST /auth/login  →  { accessToken, refreshToken }
GET  /users/me    →  Authorization: Bearer <accessToken>
POST /auth/refresh →  { accessToken }
```

### Event Ingestion (Tenant-facing)

```
POST /ingest/events
x-tenant-api-key: acme_api_key_12345

{
  "source": "storefront",
  "events": [
    { "userId": "u1", "eventType": "product_view", "eventData": { "productId": "sku_123" } }
  ]
}
```

### Recommendations

```
GET /recommendations/popular?limit=10&days=30
GET /recommendations/for-user?userId=u1&limit=10
GET /recommendations/similar/sku_123?limit=5
GET /recommendations/semantic?q=waterproof+hiking+jacket
```

### RAG Chatbot

```
POST /chat
Authorization: Bearer <token>

{ "message": "Do you have waterproof jackets?", "history": [] }
```

### Fraud Detection

```
GET /fraud/analyze?userId=u1&windowMinutes=60&velocityThreshold=3
GET /fraud/alerts?hours=24&minRiskScore=40
```

### Operational Endpoints

Set `ADMIN_API_TOKEN` to require `x-admin-token: <token>` or `Authorization: Bearer <token>` on operational endpoints.

```
GET  /ingest/backpressure
GET  /processor/stats
GET  /processor/dlq
POST /processor/dlq/replay?limit=50
POST /processor/aggregates/refresh
```

## Shared Modules

| Module | Purpose |
|---|---|
| `shared/ai/semantic.js` | Local keyword-based semantic scorer |
| `shared/ai/qdrant.js` | Qdrant vector DB client |
| `shared/ai/ollama.js` | Ollama LLM client (generate, chat, ping) |
| `shared/broker/redpanda.js` | KafkaJS-backed Redpanda producer/consumer |
| `shared/cache/redis.js` | Optional Redis client with graceful fallback |
| `shared/grpc/client.js` | gRPC client/server factory |
| `shared/grpc/platform.proto` | Proto definitions for all services |
| `shared/middleware/auth.js` | JWT authentication + RBAC middleware |
| `shared/middleware/security.js` | OWASP headers, injection scan, tenant isolation |
| `shared/observability/logger.js` | Structured JSON logger |
| `shared/observability/tracer.js` | Lightweight OTel span exporter |
| `shared/observability/http.js` | Metrics store, Prometheus renderer, tracing middleware |
| `shared/utils/circuit-breaker.js` | CLOSED/OPEN/HALF_OPEN circuit breaker |
| `shared/utils/retry.js` | Exponential backoff retry with jitter |
| `shared/utils/saga.js` | Saga orchestrator with compensation |

## Deployment

### Local Kubernetes (Minikube/Kind)

```bash
# Install chart
helm upgrade --install backend-platform deploy/helm/backend-platform \
  --namespace analytics-platform \
  --create-namespace

# Or via ArgoCD
kubectl apply -f deploy/argocd/backend-platform-application.yaml
```

### Production (GitOps)

Push to `main` → GitHub Actions CI builds and pushes images to GHCR → CD workflow triggers Helm upgrade + ArgoCD sync.

See `deploy/argocd/values-production.yaml` for production overrides (Vault secrets, network policies, HPA, OTel enabled).

### Terraform Bootstrap

```bash
cd deploy/terraform
terraform init
terraform apply
```

Provisions: namespaces, ingress-nginx, cert-manager, external-secrets, ArgoCD.

## Database Migrations

Migrations run automatically via the `db-migrator` container on `docker compose up`.

To run manually:
```bash
cd database/migrator
npm start
```

Migration files in `database/migrations/` are applied in alphabetical order. `init.sql` is skipped by the migrator (applied directly by Postgres on first boot).

## Environment Variables

Copy `.env` and adjust for your environment. Key variables:

| Variable | Default | Description |
|---|---|---|
| `JWT_SECRET` | dev value | Must be changed in production |
| `INGESTION_MODE` | `outbox` | `direct`, `outbox`, or `broker` |
| `BROKER_ENABLED` | `false` | Enable Kafka/Redpanda integration |
| `ADMIN_API_TOKEN` | unset | Optional token for processor/backpressure admin endpoints |
| `AGGREGATE_REFRESH_INTERVAL_MS` | `0` | Optional scheduled refresh interval for daily analytics materialized view |
| `QDRANT_ENABLED` | `false` | Enable vector search |
| `OLLAMA_ENABLED` | `false` | Enable LLM chatbot |
| `OTEL_ENABLED` | `false` | Enable OTel trace export |
| `GRPC_ENABLED` | `false` | Enable gRPC server on auth-service |
