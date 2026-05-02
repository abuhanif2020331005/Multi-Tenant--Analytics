{{- define "backend-platform.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "backend-platform.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- include "backend-platform.name" . -}}
{{- end -}}
{{- end -}}

{{- define "backend-platform.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "backend-platform.labels" -}}
helm.sh/chart: {{ include "backend-platform.chart" . }}
app.kubernetes.io/name: {{ include "backend-platform.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "backend-platform.selectorLabels" -}}
app.kubernetes.io/name: {{ include "backend-platform.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
