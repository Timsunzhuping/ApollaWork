{{/*
Apolla Work chart 辅助模板：名称、标签与各组件连接地址。
*/}}

{{- define "apolla.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* 完整名称：release 名含 chart 名则直接用 release 名 */}}
{{- define "apolla.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "apolla.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* 通用标签 */}}
{{- define "apolla.labels" -}}
helm.sh/chart: {{ include "apolla.chart" . }}
app.kubernetes.io/name: {{ include "apolla.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/* 选择器标签（不含版本，避免升级时 selector 变化） */}}
{{- define "apolla.selectorLabels" -}}
app.kubernetes.io/name: {{ include "apolla.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* Secret 名称：优先用户提供的 existingSecret */}}
{{- define "apolla.secretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{- .Values.secrets.existingSecret -}}
{{- else -}}
{{- printf "%s-secrets" (include "apolla.fullname" .) -}}
{{- end -}}
{{- end -}}

{{/* PostgreSQL 连接参数（内置 or 外接） */}}
{{- define "apolla.postgresHost" -}}
{{- if .Values.postgres.enabled -}}
{{- printf "%s-postgres" (include "apolla.fullname" .) -}}
{{- else -}}
{{- required "postgres.enabled=false 时必须设置 postgres.external.host" .Values.postgres.external.host -}}
{{- end -}}
{{- end -}}

{{- define "apolla.postgresPort" -}}
{{- if .Values.postgres.enabled -}}5432{{- else -}}{{ .Values.postgres.external.port }}{{- end -}}
{{- end -}}

{{- define "apolla.postgresUser" -}}
{{- if .Values.postgres.enabled -}}{{ .Values.postgres.auth.username }}{{- else -}}{{ .Values.postgres.external.username }}{{- end -}}
{{- end -}}

{{- define "apolla.postgresDatabase" -}}
{{- if .Values.postgres.enabled -}}{{ .Values.postgres.auth.database }}{{- else -}}{{ .Values.postgres.external.database }}{{- end -}}
{{- end -}}

{{/* Redis/Valkey 连接串（内置 or 外接） */}}
{{- define "apolla.redisUrl" -}}
{{- if .Values.valkey.enabled -}}
{{- printf "redis://%s-valkey:6379" (include "apolla.fullname" .) -}}
{{- else -}}
{{- required "valkey.enabled=false 时必须设置 valkey.external.url" .Values.valkey.external.url -}}
{{- end -}}
{{- end -}}

{{/* S3 端点（内置 MinIO or 外接） */}}
{{- define "apolla.s3Endpoint" -}}
{{- if .Values.minio.enabled -}}
{{- printf "http://%s-minio:9000" (include "apolla.fullname" .) -}}
{{- else -}}
{{- required "minio.enabled=false 时必须设置 minio.external.endpoint" .Values.minio.external.endpoint -}}
{{- end -}}
{{- end -}}

{{/* 模型网关地址：显式 model.baseUrl 优先，否则指向内置 LiteLLM */}}
{{- define "apolla.modelBaseUrl" -}}
{{- if .Values.model.baseUrl -}}
{{- .Values.model.baseUrl -}}
{{- else if .Values.litellm.enabled -}}
{{- printf "http://%s-litellm:%d/v1" (include "apolla.fullname" .) (int .Values.litellm.port) -}}
{{- else -}}
{{- fail "litellm.enabled=false 时必须设置 model.baseUrl 指向外部模型网关" -}}
{{- end -}}
{{- end -}}

{{/* 各组件持久卷的 storageClassName 行（组件值 > global，均为空则省略走集群默认） */}}
{{- define "apolla.storageClass" -}}
{{- $sc := default .global .local -}}
{{- if $sc }}
storageClassName: {{ $sc | quote }}
{{- end }}
{{- end -}}
