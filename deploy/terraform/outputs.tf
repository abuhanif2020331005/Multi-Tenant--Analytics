output "platform_namespace" {
  description = "Namespace where backend-platform workloads should run."
  value       = kubernetes_namespace_v1.platform.metadata[0].name
}

output "argocd_namespace" {
  description = "Namespace where ArgoCD runs when enabled."
  value       = var.enable_argocd ? kubernetes_namespace_v1.argocd[0].metadata[0].name : null
}

output "installed_components" {
  description = "Terraform-managed cluster bootstrap components."
  value = {
    ingress_nginx   = var.enable_ingress_nginx
    cert_manager    = var.enable_cert_manager
    externalSecrets = var.enable_external_secrets
    argocd          = var.enable_argocd
  }
}
