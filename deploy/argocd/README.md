# ArgoCD Setup

This folder contains GitOps resources for deploying the platform with ArgoCD.

## Files

- `backend-platform-application.yaml`: ArgoCD `Application` that points to the Helm chart
- `values-production.yaml`: example production-style values overrides

## Before applying

Update these placeholders first:

- `repoURL` in `backend-platform-application.yaml`
- `path` if this project lives at a different repository subpath
- image repositories in `values-production.yaml`
- secrets and default credentials in `values-production.yaml`

## Apply

```bash
kubectl apply -f deploy/argocd/backend-platform-application.yaml -n argocd
```

## Notes

- The ArgoCD app is configured for automated sync, prune, and self-heal
- Namespace creation is enabled through the sync options
- `values-production.yaml` includes ingress and a pattern for using an existing Kubernetes secret
- Cluster bootstrap Terraform for ArgoCD, ingress, cert-manager, and external-secrets lives in [deploy/terraform](F:\Multi-Tenant Analytics\backend-platform\deploy\terraform)
