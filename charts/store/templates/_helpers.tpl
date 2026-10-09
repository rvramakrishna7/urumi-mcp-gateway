{{/*
Name of the Secret that holds every credential of the store.
*/}}
{{- define "store.secretName" -}}
store-credentials
{{- end -}}

{{/*
Labels shared by every resource of the chart.
*/}}
{{- define "store.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/part-of: urumi-mcp-gateway
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{/*
Selector labels for one component. Call with a dict: (dict "root" . "component" "mariadb").
*/}}
{{- define "store.selectorLabels" -}}
app.kubernetes.io/name: {{ .root.Chart.Name }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/*
Public URL of the storefront, built from values so it is never hardcoded in a template.
*/}}
{{- define "store.publicUrl" -}}
{{- printf "%s://%s" .Values.store.scheme (required "store.host is required" .Values.store.host) -}}
{{- end -}}

{{/*
PHP evaluated by wp-config.php of the official WordPress image (WORDPRESS_CONFIG_EXTRA).
Shared by the WordPress Deployment and the bootstrap Job so both see the same configuration.
*/}}
{{- define "store.wpConfigExtra" -}}
define('WP_HOME', '{{ include "store.publicUrl" . }}');
define('WP_SITEURL', '{{ include "store.publicUrl" . }}');
define('WP_MEMORY_LIMIT', '256M');
{{- end -}}

{{/*
Database connection variables shared by the WordPress Deployment and the bootstrap Job.
The password comes from the Secret; nothing is written into the manifest.
*/}}
{{- define "store.wordpressEnv" -}}
- name: WORDPRESS_DB_HOST
  value: mariadb
- name: WORDPRESS_DB_NAME
  value: {{ .Values.mariadb.database | quote }}
- name: WORDPRESS_DB_USER
  value: {{ .Values.mariadb.user | quote }}
- name: WORDPRESS_DB_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "store.secretName" . }}
      key: mariadb-password
- name: WORDPRESS_CONFIG_EXTRA
  value: |
    {{- include "store.wpConfigExtra" . | nindent 4 }}
{{- end -}}

{{/*
Base64 value for one Secret key. Call with a dict: (dict "override" <string> "old" <map> "key" <string>).
Order: explicit override from values, then the value already stored in the cluster, then a new random value.
*/}}
{{- define "store.secretValue" -}}
{{- if .override -}}
{{- .override | b64enc -}}
{{- else if and .old (hasKey .old .key) -}}
{{- index .old .key -}}
{{- else -}}
{{- randAlphaNum 32 | b64enc -}}
{{- end -}}
{{- end -}}

{{/*
Name of the Secret that holds the WooCommerce REST API key of the woo-mcp server.
It is separate from the store credentials so that the MCP server chart can copy these two values and nothing else.
*/}}
{{- define "store.wooMcpSecretName" -}}
woo-mcp-api
{{- end -}}

{{/*
Base64 value for one WooCommerce API credential: the prefix followed by 40 lowercase hex characters
(43 characters in total, the width of the consumer_secret column). The value already stored in the cluster wins.
Call with a dict: (dict "old" <map> "key" <string> "prefix" <string>).
*/}}
{{- define "store.wooMcpApiValue" -}}
{{- if and .old (hasKey .old .key) -}}
{{- index .old .key -}}
{{- else -}}
{{- printf "%s%s" .prefix (randAlphaNum 32 | sha1sum) | b64enc -}}
{{- end -}}
{{- end -}}
