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

{{/*
Name of the Secret that holds the master key for the encryption of upstream credentials.
*/}}
{{- define "gateway.masterKeySecretName" -}}
gateway-master-key
{{- end -}}

{{/*
Name of the Secret that holds the credentials of the seeded upstream servers, and of the ConfigMap with the seed list.
*/}}
{{- define "gateway.seedSecretName" -}}
gateway-seed-credentials
{{- end -}}

{{- define "gateway.seedConfigName" -}}
gateway-seed
{{- end -}}

{{/*
The seed list as JSON, without secrets: a credential names a file (the mounted Secret), not a value. The file name
is the slug of the server. Used for the ConfigMap and for the checksum of the pod.
*/}}
{{- define "gateway.seedJson" -}}
{{- $servers := list -}}
{{- range .Values.seed.servers -}}
{{- $entry := dict "slug" .slug "name" .name "url" .url "callTimeoutMs" (default 30000 .callTimeoutMs) -}}
{{- if .credential -}}
{{- $cred := dict "kind" .credential.kind "file" (printf "/secrets/seed/%s" .slug) -}}
{{- if .credential.header -}}{{- $_ := set $cred "header" .credential.header -}}{{- end -}}
{{- $_ := set $entry "credential" $cred -}}
{{- end -}}
{{- $servers = append $servers $entry -}}
{{- end -}}
{{- dict "servers" $servers | toJson -}}
{{- end -}}

{{/*
The credential value of one seed entry, base64 encoded, read with lookup from the Secret that the entry names. The
install stops with a clear message when that Secret is missing (install the store and mcp-servers charts first).
Pass a dict with "root" and "entry".
*/}}
{{- define "gateway.seedCredentialValue" -}}
{{- $source := .entry.credential.source -}}
{{- $found := lookup "v1" "Secret" $source.namespace $source.secret -}}
{{- if and $found $found.data (hasKey $found.data $source.key) -}}
{{- index $found.data $source.key -}}
{{- else if .root.Values.seed.requireExisting -}}
{{- fail (printf "The Secret %q with the key %q was not found in the namespace %q. Install the mcp-servers chart first (it creates this Secret), then install this chart. To render this chart without a cluster (helm template, helm lint) set seed.requireExisting=false." $source.secret $source.key $source.namespace) -}}
{{- else -}}
{{- "offline-render-placeholder" | b64enc -}}
{{- end -}}
{{- end -}}

{{/*
Name of the Secret that holds the invite token of the first admin (decision 36).
*/}}
{{- define "gateway.bootstrapSecretName" -}}
gateway-bootstrap
{{- end -}}
