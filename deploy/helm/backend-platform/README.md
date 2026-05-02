# backend-platform Helm Chart

This chart deploys the current multi-tenant analytics platform into Kubernetes.

## Included components

- `db-migrator` job
- PostgreSQL, Redis, and Redpanda
- API gateway
- Auth, user, analytics, ingestion, processor, recommendation, fraud, and catalog services
- Dashboard app and tenant dashboard

## Example install

```bash
helm upgrade --install backend-platform ./deploy/helm/backend-platform \
  --namespace analytics-platform \
  --create-namespace
```

## Notes

- Default image repositories are placeholders like `backend-platform/api-gateway:latest`
- Override image repositories and tags in `values.yaml` or via `--set`
- The chart currently focuses on the application stack and its core data/broker dependencies
- Ingress can expose the gateway and dashboards when `ingress.enabled=true`
- Secrets can come from a plain Kubernetes `Secret`, an existing secret, or an `ExternalSecret`

## GitOps

Example ArgoCD resources live in [deploy/argocd](F:\Multi-Tenant Analytics\backend-platform\deploy\argocd).
