# NetworkPolicy (Step 17)

Design: `docs/architecture.md`, decision 7. Templates: `charts/gateway/templates/networkpolicy.yaml` and `charts/mcp-servers/templates/networkpolicy.yaml`. Both are rendered only when `networkPolicy.enabled` is true (`values-local.yaml` and `values-prod.yaml` set it; `values.yaml` has it off so a bare `helm template` renders as before).

Policies are additive. A pod that is selected by a default-deny policy can do only what the other policies that select it allow, for ingress and egress separately.

## The policies

The private ranges below are `networkPolicy.privateRanges`: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8 and 169.254.0.0/16. The pod CIDR (10.42.0.0/16) and the Service CIDR (10.43.0.0/16) are inside 10.0.0.0/8.

### Namespace `gateway` (chart `gateway`, 7 policies)

| Policy | Selects | Rule |
|---|---|---|
| default-deny | all pods | no ingress, no egress |
| allow-dns | all pods | egress to kube-dns pods in `kube-system`, UDP and TCP 53 |
| allow-from-ingress-controller | gateway, dashboard | ingress from the Traefik pod in `kube-system`, TCP 8080 (gateway.port and dashboard.port) |
| postgres-ingress | postgres | ingress from pods with component gateway or test, TCP 5432 |
| gateway-egress | gateway | egress to (1) the postgres pod, TCP 5432; (2) the namespace `mcp-servers`, TCP 8080; (3) `0.0.0.0/0` except the private ranges, TCP 443 (the chat model) |
| helm-tests | test | egress to the gateway, dashboard and postgres pods, TCP 8080 and 5432 |
| allow-from-helm-tests | gateway, dashboard | ingress from pods with component test |

The dashboard pod has no egress rule of its own: it gets the default deny plus DNS, and ingress from Traefik.

### Namespace `mcp-servers` (chart `mcp-servers`, 7 policies)

| Policy | Selects | Rule |
|---|---|---|
| default-deny | all pods | no ingress, no egress |
| allow-dns | all pods | egress to kube-dns pods in `kube-system`, UDP and TCP 53 |
| allow-from-gateway | woo-mcp, fx-mcp, fetch-mcp | ingress from the gateway pod in namespace `gateway` (labels `app.kubernetes.io/name: gateway` and `app.kubernetes.io/component: gateway`), TCP 8080 |
| woo-mcp-egress | woo-mcp | egress to the WordPress pod in namespace `store`, TCP 80 |
| public-internet-egress | fx-mcp, fetch-mcp | egress to `0.0.0.0/0` except the private ranges, TCP 80 and 443 |
| helm-tests | test | egress to woo-mcp, fx-mcp and fetch-mcp pods, TCP 8080 |
| allow-from-helm-tests | woo-mcp, fx-mcp, fetch-mcp | ingress from pods with component test |

On the cluster, `kubectl get networkpolicy -A` lists the same 14 names.

## How the drills work

- **Sources.** The existing pods (gateway, woo-mcp, fetch-mcp, dashboard) through `kubectl exec`, so the traffic leaves the pod with its real labels and the policies that apply to it. Where no existing pod fits (the `default` and `store` namespaces), one throwaway pod per namespace with the single label `drill=np`. It never carries a `component=` or `name=` label, because such a label would make a Service route real traffic to it or make a policy select it. Nothing is installed in a running pod.
- **Probe.** A `node -e` one-liner on every pod that has Node; the dashboard (no Node) uses the busybox `wget` and `nc`. The probe connects with `family: 4`, so that an IPv6 address returned first by DNS cannot change the result (IPv6 itself was not examined), and a fixed 5 s timeout. It prints the resolved address, the result and the elapsed milliseconds, and its exit code is 0 only on success. The TLS probe stops after the handshake: no request, header, key or body is sent.
- **Order for every drill:** control, negative, negative again, control. The control is a connection from the same source that must succeed, so a broken command or a broken source cannot look like a blocked connection. If a control fails, or if the target also refuses without any policy, the drill is INVALID and not a block.
- **Target liveness.** For each blocked target an allowed source connects to the same target (P1a, P1b, L1, L2), so a dead target cannot look like a block.
- **Classification.** A fast error (`ECONNREFUSED`, `EHOSTUNREACH`) is a REJECT. A result at the 5 s limit (`TIMEOUT`) is a DROP.

## Results (17 Oct 2026, 00:11-00:14 IST (16 Oct 18:41-18:44 UTC), local k3d cluster `urumi`)

Milliseconds are from the probe, first run / second run.

| ID | Source | Target | Expected | Observed | Control | Verdict |
|---|---|---|---|---|---|---|
| N1 | default, throwaway pod | woo-mcp:8080 | blocked | ECONNREFUSED 601 / 501 | kube-dns:53 connected | PASS |
| N2 | store, throwaway pod | woo-mcp:8080 | blocked | ECONNREFUSED 497 / 535 | wordpress.store:80 connected | PASS |
| N3 | default, throwaway pod | postgres.gateway:5432 | blocked | ECONNREFUSED 413 / 499 | kube-dns:53 connected | PASS |
| N4a | fetch-mcp | 169.254.169.254:80 | blocked | ECONNREFUSED 35 / 17 | example.com:443 TLS ok | INVALID |
| N4b | fetch-mcp | 172.18.0.3:6443 (the node) | blocked | ECONNREFUSED 18 / 18 | example.com:443 TLS ok; the throwaway pod connected to the same target | PASS |
| N5 | fetch-mcp | wordpress.store:80 | blocked | ECONNREFUSED 39 / 34 | example.com:443 TLS ok | PASS |
| N6a | fetch-mcp | postgres.gateway:5432 | blocked | ECONNREFUSED 37 / 41 | example.com:443 TLS ok | PASS |
| N6b | fetch-mcp | kubernetes.default.svc:443 | blocked | ECONNREFUSED 132 / 139 | example.com:443 TLS ok; the throwaway pod connected to the same target | PASS |
| N7a | woo-mcp | postgres.gateway:5432 | blocked | ECONNREFUSED 91 / 95 | wordpress.store:80 connected | PASS |
| N7b | woo-mcp | example.com:443 (104.20.23.154) | blocked | ECONNREFUSED 132 / 129 | wordpress.store:80 connected; fetch-mcp reached the same address | PASS |
| N8 | dashboard | woo-mcp:8080 | blocked | `wget: can't connect to remote host (10.43.240.125): Connection refused` | `nc` to kube-dns:53 succeeded; `nslookup` resolved woo-mcp | PASS |
| N9 | gateway | wordpress.store:80 | blocked | ECONNREFUSED 91 / 95 | gateway to woo-mcp:8080 connected | PASS |
| P1a | gateway | woo-mcp, fx-mcp, fetch-mcp :8080 | allowed | connected 96 / 86 / 97 | n/a | PASS |
| P1b | gateway | postgres:5432 | allowed | connected 90 | n/a | PASS |
| P1c | gateway | api.groq.com:443 | allowed | TLS handshake ok, TLSv1.3, 193 | n/a | PASS |

**N4a is INVALID.** From the throwaway pod in the `default` namespace, which no policy selects, `169.254.169.254:80` also answers `ECONNREFUSED` (208 ms). On k3d the address refuses with or without a policy, so the result does not prove the policy. N4b tests the same `except` rule against a target that is alive (the node, in 172.16.0.0/12). Repeat N4a on the VPS, where the address may be a real metadata service.

### What the results do and do not show

- **Blocked means a fast `ECONNREFUSED` (a REJECT).** No attempt hit the 5 s timeout. Whether the refusal was a TCP RST or an ICMP port-unreachable was not inspected at packet level.
- **The enforcement window on a new pod was not measured.** The first negative probe on each throwaway pod ran 29 s (default) and 49 s (store) after the pod was Ready, and it was blocked. Nothing was probed in the first 29 s.
- **Not drilled:** a gateway call to a registered upstream outside `mcp-servers`, and enforcement on the VPS (`values-prod.yaml` enables the policies, but the drills ran only on the local k3d cluster).

## Positive end-to-end checks (dashboard chat, after the policies)

On 17 Oct 2026, about 00:05-00:18 IST, after the gateway upgrade to revision 25 (23:43 IST) that applied the policies, two requests were made as the admin in the dashboard chat:

| Request | Path | Result |
|---|---|---|
| `woo__list_orders` | browser, gateway, Groq (tool loop), gateway to woo-mcp, woo-mcp to the store | OK, 987.9 ms |
| `fx__convert_amounts` ("1000 INR", answer about 10.53 USD) | browser, gateway, Groq (tool loop), gateway to fx-mcp, fx-mcp to Frankfurter | OK, 1312.8 ms |

These were run by hand from the dashboard; the times are those the chat screen showed. They show that the allowed paths still work with the policies on, including the gateway to Groq on port 443 (the model call is part of each request). Does fx-mcp cache rates? No: `FxClient.getRate` in `services/fx-mcp/src/fxClient.ts` calls the API through `get()` on every tool call, and `convert_amounts` reaches it through `resolveRate` in `services/fx-mcp/src/tools/fx.ts`. So the fx call went to Frankfurter and was not served from a cache of fx-mcp. The gateway does not cache tool results either (it caches only the tool list, `upstream_tools`). The `fetch` tool was not part of these checks.

## Known limitations

- **Groq egress allows any public IP on port 443.** A NetworkPolicy matches addresses, not hostnames, so the gateway rule cannot name `api.groq.com`. The private, loopback and link-local ranges are still excluded. An upstream that an admin registers at a public HTTPS address is therefore reachable by the network; limiting that needs an application-level guard, which is not built (`docs/architecture.md`, known limitations of the gateway).
- **IPv6 was not examined.** The policies list IPv4 ranges only, and the probes use `family: 4`.
- **The `store` namespace has no NetworkPolicy** (WordPress, MariaDB and the bootstrap Job). Traffic into WordPress from the storefront and from woo-mcp is not restricted.
- **The policies trust pod labels (analysis, not drilled).** `allow-from-gateway` lets in any pod in the `gateway` namespace that carries both `app.kubernetes.io/name: gateway` and `app.kubernetes.io/component: gateway`; `postgres-ingress` trusts `app.kubernetes.io/component` being `gateway` or `test`. A pod created with those labels is treated as the gateway. So who may create pods in the `gateway` namespace (RBAC) is part of the boundary.
- **Cluster DNS is reachable from every pod (analysis, not drilled).** `allow-dns` is needed for service names, and DNS can carry data out. This is not mitigated.

## Run the drills again

Needs `kubectl` and a shell. Set the image of the throwaway pods; it must exist on the node. For an image that is only on the node (no registry), use `Never`.

```bash
export MSYS_NO_PATHCONV=1
DRILL_IMAGE=woo-mcp:0.1.1        # any image with node; the local cluster has it
PULL_POLICY=Never                # IfNotPresent for an image from a registry
```

The probes (copy as they are):

```bash
TCP='const [h,p]=process.argv.slice(1);const t=Date.now();let a="-";const s=require("net").connect({host:h,port:+p,family:4,timeout:5000});const d=r=>{console.log(JSON.stringify({h,p,addr:a,r,ms:Date.now()-t}));process.exit(r==="CONNECTED"?0:1)};s.on("lookup",(e,x)=>{a=x});s.on("connect",()=>d("CONNECTED"));s.on("timeout",()=>d("TIMEOUT"));s.on("error",e=>d("ERROR "+e.code+" "+e.message));'
TLS='const tls=require("tls");const [h,p]=process.argv.slice(1);const t=Date.now();let a="-";const s=tls.connect({host:h,port:+p,servername:h,family:4,timeout:5000});const d=(r,x)=>{console.log(JSON.stringify({h,p,addr:a,r,proto:x,ms:Date.now()-t}));process.exit(r==="TLS_OK"?0:1)};s.on("lookup",(e,x)=>{a=x});s.on("secureConnect",()=>d("TLS_OK",s.getProtocol()+" authorized="+s.authorized));s.on("timeout",()=>d("TIMEOUT"));s.on("error",e=>d("ERROR "+e.code+" "+e.message));'

# record one attempt: command, output, exit code, wall time
rec(){ s=$(date +%s%N); out=$("$@" 2>&1); rc=$?; ms=$(( ($(date +%s%N)-s)/1000000 )); echo "UTC:  $(date -u +%T)"; echo "CMD:  $*"; echo "OUT:  $out"; echo "EXIT: $rc   WALL_MS: $ms"; echo; }

# run a probe inside an existing pod: px <namespace> "<pod or deploy/name -c container>" "$TCP" <host> <port>
px(){ ns=$1; tgt=$2; shift 2; kubectl -n "$ns" exec $tgt -- node -e "$@"; }
```

Throwaway pods (only in `default` and `store`; one label, `drill=np`):

```bash
for ns in default store; do
n=$([ $ns = default ] && echo 1 || echo 2)
cat <<EOF | kubectl create -n $ns -f -
apiVersion: v1
kind: Pod
metadata:
  name: np-drill-$n
  labels:
    drill: np
spec:
  restartPolicy: Never
  activeDeadlineSeconds: 1800
  automountServiceAccountToken: false
  securityContext: { runAsNonRoot: true, runAsUser: 10001, seccompProfile: { type: RuntimeDefault } }
  containers:
    - name: probe
      image: ${DRILL_IMAGE}
      imagePullPolicy: ${PULL_POLICY}
      command: ["node", "-e", "setTimeout(()=>{},1800000)"]
      securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: [ALL] } }
      resources: { requests: { cpu: 10m, memory: 32Mi }, limits: { cpu: 100m, memory: 96Mi } }
EOF
done
kubectl -n default wait --for=condition=Ready pod/np-drill-1 --timeout=120s
kubectl -n store   wait --for=condition=Ready pod/np-drill-2 --timeout=120s
```

One drill, in the order control, negative, negative, control (N1 as the example; the others differ only in source, target and control):

```bash
echo "--- control";    rec px default "pod/np-drill-1" "$TCP" 10.43.0.10 53
echo "--- negative 1"; rec px default "pod/np-drill-1" "$TCP" woo-mcp.mcp-servers.svc.cluster.local 8080
echo "--- negative 2"; rec px default "pod/np-drill-1" "$TCP" woo-mcp.mcp-servers.svc.cluster.local 8080
echo "--- control";    rec px default "pod/np-drill-1" "$TCP" 10.43.0.10 53
```

Sources for the other drills (replace the first two arguments of `px`):

| Source | `px` arguments |
|---|---|
| throwaway pod in `store` | `store "pod/np-drill-2"` |
| gateway | `gateway "deploy/gateway -c gateway"` |
| woo-mcp | `mcp-servers "deploy/woo-mcp -c woo-mcp"` |
| fetch-mcp | `mcp-servers "deploy/fetch-mcp -c fetch-mcp"` |

The dashboard has no Node; use its own tools (control, then two negatives, then the control again):

```bash
rec kubectl -n gateway exec deploy/dashboard -c dashboard -- nc -w 5 10.43.0.10 53
rec kubectl -n gateway exec deploy/dashboard -c dashboard -- wget -T 5 -qO- http://woo-mcp.mcp-servers.svc.cluster.local:8080/healthz
```

Before any exec, check the memory of the target pod (`kubectl top pod -n gateway`, `kubectl top pod -n mcp-servers`). The probe is one extra Node process inside the memory limit of the pod.

Cleanup (these are deletes; each needs your own approval):

```bash
kubectl -n default delete pod np-drill-1
kubectl -n store   delete pod np-drill-2
kubectl get pods -A -l drill=np          # expected: No resources found
```
