# Terraform Bootstrap

This folder bootstraps the Kubernetes-side platform dependencies used by the deployment stack.

## What it installs

- `ingress-nginx`
- `cert-manager`
- `external-secrets`
- `ArgoCD`
- the target application namespace

Tracing backends are currently deployed through the Helm chart itself:

- Jaeger
- OpenTelemetry Collector
- Qdrant

## Usage

```bash
cd deploy/terraform
terraform init
terraform plan -var-file=terraform.tfvars
terraform apply -var-file=terraform.tfvars
```

Start from the example file:

```bash
cp terraform.tfvars.example terraform.tfvars
```

## Notes

- This is cluster bootstrap Terraform, not full cloud-account provisioning
- Update `kubeconfig_path` and `kubeconfig_context` to target the right cluster
- After ArgoCD is installed, apply the app manifest from `deploy/argocd`
