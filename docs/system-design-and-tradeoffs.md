# System design and tradeoffs

This note explains how the system is put together and why. It is a summary: every claim comes from `docs/architecture.md` (the decisions are numbered), `docs/network-policy.md`, `README.md`, the chart values or the source, and the reference is given in brackets. Where something was never tested, the note says so.

## 1. The system in one picture

```text
  Browser                      External MCP client (Claude Code, Inspector)
     |                                      |
     +------------------+-------------------+
                        |
                 Traefik Ingress     (two public hosts: store.<domain>, gateway.<domain>)
                  |               |
  namespace store |               | namespace gateway
  +---------------v-+         +---v-----------------------------------+
  | wordpress (PVC) |         | dashboard (React, nginx)               |
  | mariadb   (PVC) |         | gateway (API, /mcp, chat agent)        |
  +--------^--------+         | postgres (PVC)                         |
           | WooCommerce      +---+------------------------------------+
           | REST API             | MCP over Streamable HTTP, bearer token
  namespace mcp-servers           |
  +--------+-----------------+    |
  | woo-mcp  fx-mcp  fetch-mcp |<-+     no Ingress, ClusterIP only
  +----------------------------+
```

| Component | Responsibility |
|---|---|
| wordpress, mariadb | The store: storefront, WooCommerce admin and its database, on persistent volumes. |
| woo-mcp | Our own MCP server. Five tools for products and orders, through the WooCommerce REST API (decisions 16 to 23). |
| fx-mcp | Our own MCP server for currency rates (decision 41). |
| fetch-mcp | The reference Fetch server behind supergateway, with a gate on every fetch (decision 42). |
| gateway | Users and roles, API keys, the registry of upstream servers, the one public `/mcp` endpoint, the audit log, the chat agent. |
| postgres | The gateway data: users, hashed keys, upstream records, the cached tool list, the audit table. |
| dashboard | The React screens: login, API keys, audit log, servers, users, chat. |

## 2. Architecture choices and tradeoffs

**One gateway service, with the chat agent inside it** (architecture.md, decisions 1a and 1b).
- Why: the API, `/mcp` and the agent all need the same things (who the user is, which upstreams are enabled, the audit). The agent calls the same internal functions `listTools` and `callTool` as `/mcp`, so revocation, timeouts and audit apply to chat in the same way.
- Rejected: the agent as a real MCP client of the gateway's own `/mcp`. Inside one process it adds a network hop and an internal token, with no gain. Cost of the choice: the parts cannot scale separately.

**PostgreSQL for the gateway data** (decision 2).
- Why: the data is relational (users to keys, servers to tools, filtered audit rows) and a second gateway replica stays possible later.
- Rejected: MongoDB (relations and audit queries by hand) and SQLite (one replica only).

**Stateless Streamable HTTP for MCP** (decisions 16 and 32).
- Why: no session to heal, and the API key is checked in the database on every request, so a revoked key fails on the next one. Cost: the server cannot push `tools/list_changed`, so a client that reads the list once must reconnect to see a change (decision 33).

**The store is reached through the WooCommerce REST API with OAuth 1.0a** (decisions 6 and 17).
- Why: it is the documented interface and lets woo-mcp run as its own pod with only a key. The signature goes in the `Authorization` header only. Cost: a JSON body is not covered by the signature (known limitation).
- Rejected: WP-CLI, because it needs command execution inside the WordPress pod.

**Our own Helm charts, three namespaces** (decision 1c).
- Why: `store`, `mcp-servers` and `gateway` give NetworkPolicy a clean target, and each release upgrades and rolls back on its own. Cost: three install commands. Rejected: one chart in one namespace.

**Three kinds of credential that never mix** (architecture.md, "Credential domains").
- A user API key goes between an MCP client and the gateway and is stored as a SHA-256 hash (decision 4). A dashboard session is an httpOnly cookie (decision 3). An upstream credential goes between the gateway and one upstream and is encrypted at rest with AES-256-GCM (decision 30).
- The gateway never forwards a user key upstream and never returns an upstream credential to a browser or an MCP client. Why: a browser or a client that is compromised must not yield the key to the store.

**Tool permissions by role and name** (decisions 43 and 45).
- A member does not list or call the names in `security.memberRestrictedTools` (default `woo__create_product` and `woo__update_order_status`). The check uses the exposed name rebuilt from the resolved route, before any credential is read. Why by name: descriptions and annotations come from the upstream and are untrusted (decision 29).
- Limit: a server registered again under a different slug exposes new names that the list does not cover.

## 3. Tool aggregation and routing

- **Cached tool list.** A poller refreshes the tools of every enabled upstream in parallel every 15 seconds, plus or minus 2 seconds of jitter (`src/upstream/poller.ts`), and also at once when an admin creates or edits a server. `tools/list` reads the database only, so a slow upstream cannot slow the list (decision 28).
- **Naming.** Every tool is exposed as `<slug>__<tool>` (decision 5), for example `woo__list_orders` and `fx__convert_amounts`. The slug is set by the admin and is unique. Why always, not only on a collision: names stay stable when servers come and go. Two servers with the same tool name, for example `list_products`, give two different exposed names, so a collision cannot happen.
- **Routing.** `callTool` splits the name on the first `__`, finds the server by slug in the cache, checks that it is enabled and that the caller may use the tool, and calls the original tool name on that server with the upstream credential. A disabled server, an unknown server, an unknown tool and a skipped tool all answer `Unknown tool`, so a member cannot tell a disabled server from a missing tool (decision 28).
- **Untrusted metadata.** Tool names must match a pattern, at most 200 tools per server are accepted, the schema size is capped and the description is cleaned (decision 29).
- **Two-phase audit.** Phase 1 inserts the audit row before the upstream is called; if that insert fails, no request is sent ("no row, no call"). Phase 2 completes the row with outcome and duration. The same code path serves `/mcp` and the chat agent, and the row carries `via` (decisions 28 and 38).

## 4. Failure handling

| Limit | Value | Source |
|---|---|---|
| Connect and initialise | 3 seconds | `src/upstream/client.ts` |
| `tools/list` in a probe | 5 seconds | `src/upstream/client.ts` |
| `tools/call` | 30 seconds by default, per server 1 to 120 seconds | `migrations/0001_init.sql` |
| Response size | 2 MB per session | `src/upstream/client.ts` |

- **Isolation.** One connection per call, a timeout on every stage, and probes in parallel. A slow or dead upstream makes only its own calls fail. The caller always gets a plain sentence with `isError: true`, never a URL, a credential or an upstream body (decision 28).
- **Status.** Disabled, Connected, Unreachable (with a reason such as timeout, refused, 401) or Unknown before the first probe. An Unreachable server contributes no tools to the list. A failing `tools/call` does not mark a healthy server unreachable: only a failure to reach or log in does, and a call timeout stays on the audit row.
- **Disabled server.** Its tools disappear from the next `tools/list` and a call to it sends no request.
- **What was measured.** With fake upstreams in tests: `listTools` returned in 22 ms while the poll waited for a slow upstream, and one slow plus one dead upstream did not stop the others (decision 28). In the local cluster with the real woo-mcp scaled to zero: the status became `unreachable` after 6 seconds, the list returned no tools, a call answered in 20 ms, and after scaling back the status was `connected` after 19 seconds (decision 28). With fetch-mcp scaled to zero, `woo` and `fx` were unaffected and the dashboard showed it unreachable (decision 42).
- **Not deployed.** The slow, oversized and colliding upstreams were exercised with fakes in tests only, not in the cluster (known limitations).

## 5. Local versus production

| Topic | Local (k3d) | VPS (k3s) | Why it differs |
|---|---|---|---|
| DNS | `*.urumi.test` in the hosts file (decision 8) | DuckDNS A records to the Elastic IP | `.test` never collides with a real domain; the VPS needs real names |
| Ingress | Traefik, host ports 80 and 443 mapped by k3d | Traefik of k3s | The same controller keeps the Ingress objects identical |
| TLS | none, plain http | cert-manager and Let's Encrypt (HTTP-01) | A key must not cross the internet in clear text |
| http and https | http only | https only, plain http answers 404 by design | Set by an Ingress annotation in `values-prod.yaml` |
| Storage class | `local-path` | `local-path` | The same default class on both |
| Secrets | generated in the cluster | generated in the cluster, k3s secrets encryption on | `--secrets-encryption` is a k3s flag of the VPS |
| Images | built locally, `k3d image import` | built on the VPS, `k3s ctr images import`, `pullPolicy: Never` | No registry in either case |
| How the difference is set | `values-local.yaml` | `values-prod.yaml` | The templates do not change; no `--set` |

**Beyond this VPS (not done).** These are recommendations for a real production system. None of them is implemented here.
- Storage: a storage class with replication or volume snapshots, plus scheduled database backups. `local-path` on one node loses the data with the disk.
- Images: a registry and image digests, instead of building on the node and importing the images.
- Secrets: an external secret store, instead of only Secrets generated in the cluster.
- Gateway: more than one replica (the data is already in PostgreSQL).
- Ingress: an HTTP to HTTPS redirect, instead of the 404 on plain HTTP.

## 6. Upgrades and rollback

- **Upgrade.** `helm upgrade` with the values file of the environment. A new image tag must be built and imported into the node first, because `pullPolicy: Never` makes the kubelet use only imported images. A change of a list such as `security.memberRestrictedTools` or `chat.confirmTools` restarts the pod, because it is read once at start.
- **Migrations.** They are forward-only files applied by the gateway's own runner (decision 24). Migrations 0002 to 0005 add a table, an index or a nullable column and change no existing column. The rule in decision 24 is that `helm rollback` is safe only if the migrations since then were additive, which these are; running an older image on the newer schema was not tried.
- **Drain.** The gateway has one replica with `RollingUpdate`, and a `preStop` sleep (`gateway.preStopSleepSeconds`, default 5) lets Traefik drop the old endpoint before the pod stops (decision 46).
- **What was exercised.** Many `helm upgrade` runs on the local cluster, and a rollback to an earlier revision during the measurements of decision 46. The preStop hook gave no failed request in 2 of 2 rollouts, against 1 to 3 in 5 of 5 without it; the sample is small and decision 46 says so.
- **What was not.** A rollback across a migration is not recorded as tested, and no rollback on the VPS is recorded. The sleep hook needs Kubernetes 1.30 or newer (decision 46).

## 7. Known limitations

The full list is in `docs/architecture.md`, "Known limitations". The ones that matter most for a reader:

- Gateway: the login throttle does not bound the number of guesses exactly under a burst of parallel requests, and it is per email only (decisions 35 and 37).
- Gateway: there is no rate limit on `/mcp`, on the admin API or on failed API-key attempts on `/mcp` (the dashboard login has its own throttle).
- Store: the `store` namespace has no NetworkPolicy (`docs/network-policy.md`, known limitations; the default deny exists only in `gateway` and `mcp-servers`), so the WordPress pod is not network-isolated.
- Gateway: the result of an upstream tool call is passed through as untrusted data, and the gateway cannot stop instructions inside it. The controls are the confirmation cards, the role check and the audit.
- Chat: the Groq token-per-minute limit can be hit by rapid tool turns, and the answer is "The model service is busy" (decision 40).
- SSRF guard: the allowlist is checked at registration and seed time, not at every connection, and there is no DNS pinning (decision 44).
- Gateway database: the application user is a superuser. The gateway Deployment has `replicas: 1` (`charts/gateway/templates/gateway-deployment.yaml`), so there is no second pod to take over if the one pod fails.
- Disabling a user does not revoke their API keys; the keys stop only while the user is disabled.
- fetch-mcp: two builds of the same source gave different image IDs, so the tested and the deployed image are not provably the same bytes.
