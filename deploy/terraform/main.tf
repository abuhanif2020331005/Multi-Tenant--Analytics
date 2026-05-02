locals {
  default_labels = {
    "app.kubernetes.io/part-of" = "backend-platform"
    "managed-by"                = "terraform"
  }
}

resource "kubernetes_namespace_v1" "platform" {
  metadata {
    name   = var.platform_namespace
    labels = local.default_labels
  }
}

resource "kubernetes_namespace_v1" "argocd" {
  count = var.enable_argocd ? 1 : 0

  metadata {
    name   = var.argocd_namespace
    labels = local.default_labels
  }
}

resource "kubernetes_namespace_v1" "ingress_nginx" {
  count = var.enable_ingress_nginx ? 1 : 0

  metadata {
    name = "ingress-nginx"
    labels = merge(local.default_labels, {
      "app.kubernetes.io/component" = "ingress"
    })
  }
}

resource "kubernetes_namespace_v1" "cert_manager" {
  count = var.enable_cert_manager ? 1 : 0

  metadata {
    name = "cert-manager"
    labels = merge(local.default_labels, {
      "app.kubernetes.io/component" = "cert-manager"
    })
  }
}

resource "kubernetes_namespace_v1" "external_secrets" {
  count = var.enable_external_secrets ? 1 : 0

  metadata {
    name = "external-secrets"
    labels = merge(local.default_labels, {
      "app.kubernetes.io/component" = "external-secrets"
    })
  }
}

resource "helm_release" "ingress_nginx" {
  count = var.enable_ingress_nginx ? 1 : 0

  name             = "ingress-nginx"
  repository       = "https://kubernetes.github.io/ingress-nginx"
  chart            = "ingress-nginx"
  version          = var.ingress_nginx_chart_version
  namespace        = kubernetes_namespace_v1.ingress_nginx[0].metadata[0].name
  create_namespace = false
}

resource "helm_release" "cert_manager" {
  count = var.enable_cert_manager ? 1 : 0

  name             = "cert-manager"
  repository       = "https://charts.jetstack.io"
  chart            = "cert-manager"
  version          = var.cert_manager_chart_version
  namespace        = kubernetes_namespace_v1.cert_manager[0].metadata[0].name
  create_namespace = false

  set {
    name  = "crds.enabled"
    value = "true"
  }
}

resource "helm_release" "external_secrets" {
  count = var.enable_external_secrets ? 1 : 0

  name             = "external-secrets"
  repository       = "https://charts.external-secrets.io"
  chart            = "external-secrets"
  version          = var.external_secrets_chart_version
  namespace        = kubernetes_namespace_v1.external_secrets[0].metadata[0].name
  create_namespace = false
}

resource "helm_release" "argocd" {
  count = var.enable_argocd ? 1 : 0

  name             = "argocd"
  repository       = "https://argoproj.github.io/argo-helm"
  chart            = "argo-cd"
  version          = var.argocd_chart_version
  namespace        = kubernetes_namespace_v1.argocd[0].metadata[0].name
  create_namespace = false

  values = [
    yamlencode({
      configs = {
        params = {
          "server.insecure" = true
        }
      }
    })
  ]
}
