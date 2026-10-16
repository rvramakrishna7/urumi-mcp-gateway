{{/*
Labels shared by every resource of the chart.
*/}}
{{- define "mcp-servers.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/part-of: urumi-mcp-gateway
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{/*
Selector labels of the woo-mcp pods.
*/}}
{{- define "mcp-servers.wooMcp.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: woo-mcp
{{- end -}}

{{/*
Secret with the WooCommerce key and secret, copied from the Secret of the store chart.
*/}}
{{- define "mcp-servers.wooMcp.storeApiSecretName" -}}
woo-mcp-store-api
{{- end -}}

{{/*
Secret with the bearer token that callers (the gateway) must send to woo-mcp.
*/}}
{{- define "mcp-servers.wooMcp.authSecretName" -}}
woo-mcp-auth
{{- end -}}

{{/*
Address of the WordPress Service inside the cluster. woo-mcp calls this address.
*/}}
{{- define "mcp-servers.wooMcp.baseUrl" -}}
{{- printf "http://%s.%s.svc.%s" .Values.wooMcp.store.serviceName .Values.wooMcp.store.namespace .Values.clusterDomain -}}
{{- end -}}

{{/*
Host names that woo-mcp accepts in the Host header: the names of its own Service, then the extra names.
*/}}
{{- define "mcp-servers.wooMcp.allowedHosts" -}}
{{- $ns := .Release.Namespace -}}
{{- $names := list "woo-mcp" (printf "woo-mcp.%s" $ns) (printf "woo-mcp.%s.svc" $ns) (printf "woo-mcp.%s.svc.%s" $ns .Values.clusterDomain) -}}
{{- join "," (concat $names .Values.wooMcp.extraAllowedHosts) -}}
{{- end -}}

{{/*
The base64 key and secret of the WooCommerce REST API key, as JSON: {"consumer-key": ..., "consumer-secret": ...}.
They are read from the Secret of the store chart with lookup, so the store Secret stays the single source of truth
and a rotation there reaches this chart on the next "helm upgrade". Only these two keys are copied.
Parse the result with fromJson.
*/}}
{{- define "mcp-servers.wooMcp.storeApi" -}}
{{- $store := .Values.wooMcp.store -}}
{{- $found := lookup "v1" "Secret" $store.namespace $store.secretName -}}
{{- if and $found $found.data (hasKey $found.data "consumer-key") (hasKey $found.data "consumer-secret") -}}
{{- dict "consumer-key" (index $found.data "consumer-key") "consumer-secret" (index $found.data "consumer-secret") | toJson -}}
{{- else if $store.requireExisting -}}
{{- fail (printf "The Secret %q with the keys consumer-key and consumer-secret was not found in the namespace %q. Install the store chart first (it creates this Secret), then install this chart. To render this chart without a cluster (helm template, helm lint) set wooMcp.store.requireExisting=false." $store.secretName $store.namespace) -}}
{{- else -}}
{{- dict "consumer-key" ("offline-render-placeholder" | b64enc) "consumer-secret" ("offline-render-placeholder" | b64enc) | toJson -}}
{{- end -}}
{{- end -}}

{{/*
Selector labels of the pods of one component. Call with: dict "root" . "component" "fx-mcp".
*/}}
{{- define "mcp-servers.selectorLabels" -}}
app.kubernetes.io/name: {{ .root.Chart.Name }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/*
Host names that fx-mcp accepts in the Host header: the names of its own Service, then the extra names.
*/}}
{{- define "mcp-servers.fxMcp.allowedHosts" -}}
{{- $ns := .Release.Namespace -}}
{{- $names := list "fx-mcp" (printf "fx-mcp.%s" $ns) (printf "fx-mcp.%s.svc" $ns) (printf "fx-mcp.%s.svc.%s" $ns .Values.clusterDomain) -}}
{{- join "," (concat $names .Values.fxMcp.extraAllowedHosts) -}}
{{- end -}}
