variable "kubeconfig_path" {
  description = "Path to the kubeconfig file used for Terraform operations."
  type        = string
  default     = "~/.kube/config"
}

variable "kubeconfig_context" {
  description = "Optional kubeconfig context name."
  type        = string
  default     = ""
}

variable "platform_namespace" {
  description = "Namespace for the analytics platform workloads."
  type        = string
  default     = "analytics-platform"
}

variable "argocd_namespace" {
  description = "Namespace for ArgoCD."
  type        = string
  default     = "argocd"
}

variable "enable_ingress_nginx" {
  description = "Install ingress-nginx via Helm."
  type        = bool
  default     = true
}

variable "enable_cert_manager" {
  description = "Install cert-manager via Helm."
  type        = bool
  default     = true
}

variable "enable_external_secrets" {
  description = "Install external-secrets via Helm."
  type        = bool
  default     = true
}

variable "enable_argocd" {
  description = "Install ArgoCD via Helm."
  type        = bool
  default     = true
}

variable "enable_jaeger_operator" {
  description = "Reserved toggle for future Jaeger Operator bootstrap."
  type        = bool
  default     = false
}

variable "ingress_nginx_chart_version" {
  description = "Chart version for ingress-nginx."
  type        = string
  default     = "4.11.2"
}

variable "cert_manager_chart_version" {
  description = "Chart version for cert-manager."
  type        = string
  default     = "v1.15.3"
}

variable "external_secrets_chart_version" {
  description = "Chart version for external-secrets."
  type        = string
  default     = "0.10.5"
}

variable "argocd_chart_version" {
  description = "Chart version for ArgoCD."
  type        = string
  default     = "7.4.3"
}
