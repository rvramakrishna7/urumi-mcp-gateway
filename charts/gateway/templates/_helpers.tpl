{{/*
Name of the Secret that holds the password of the application database user.
*/}}
{{- define "gateway.dbSecretName" -}}
gateway-db
{{- end -}}

{{/*
Labels shared by every resource of the chart.
*/}}
{{- define "gateway.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/part-of: urumi-mcp-gateway
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{/*
Selector labels for one component. Call with a dict: (dict "root" . "component" "postgres").
*/}}
{{- define "gateway.selectorLabels" -}}
app.kubernetes.io/name: {{ .root.Chart.Name }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/*
The image pull secrets, if any.
*/}}
{{- define "gateway.imagePullSecrets" -}}
{{- with .Values.gateway.imagePullSecrets }}
imagePullSecrets:
  {{- range . }}
  - name: {{ . | quote }}
  {{- end }}
{{- end }}
{{- end -}}

{{/*
The database settings that the gateway server, the migration runner and the test Pod share. The password is not here:
it is read from the mounted file.
*/}}
{{- define "gateway.dbEnv" -}}
- name: DB_HOST
  value: postgres
- name: DB_PORT
  value: "5432"
- name: DB_NAME
  value: {{ .Values.postgres.database | quote }}
- name: DB_USER
  value: {{ .Values.postgres.user | quote }}
- name: DB_PASSWORD_FILE
  value: /secrets/db/password
{{- end -}}

{{/*
The volume with the database password, for every Pod that connects to PostgreSQL. Mode 0440 and an fsGroup let the
group of the process read it, and nobody else.
*/}}
{{- define "gateway.dbSecretVolume" -}}
- name: db-password
  secret:
    secretName: {{ include "gateway.dbSecretName" . }}
    defaultMode: 0440
    items:
      - key: password
        path: password
{{- end -}}
